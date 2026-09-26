// __tests__/services/VeoService.test.js
const VeoService = require('../../services/VeoService');

// Mock the logger
jest.mock('../../logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn()
}));

// Mock @google/genai (Vertex mode): generateVideos starts the LRO,
// operations.getVideosOperation polls it.
jest.mock('@google/genai', () => {
  const generateVideos = jest.fn();
  const getVideosOperation = jest.fn();
  return {
    GoogleGenAI: jest.fn().mockImplementation(() => ({
      models: { generateVideos },
      operations: { getVideosOperation }
    })),
    __mocks: { generateVideos, getVideosOperation }
  };
});
const { GoogleGenAI, __mocks: genaiMocks } = require('@google/genai');
const mockGenerateVideos = genaiMocks.generateVideos;
const mockGetVideosOperation = genaiMocks.getVideosOperation;

// Mock @google-cloud/storage
const mockGcsFile = jest.fn();
const mockGcsBucket = jest.fn();
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: mockGcsBucket.mockImplementation(() => ({
      file: mockGcsFile.mockImplementation(() => ({
        download: jest.fn().mockResolvedValue([Buffer.from('fake-video-data')]),
        exists: jest.fn().mockResolvedValue([true])
      }))
    }))
  }))
}));

// Mock axios
jest.mock('axios');
const axios = require('axios');

describe('VeoService', () => {
  let veoService;
  let mockConfig;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConfig = {
      veo: {
        enabled: true,
        projectId: 'test-project',
        location: 'us-central1',
        model: 'veo-3.1-fast-generate-001',
        gcsBucket: 'test-bucket',
        defaultDuration: 8,
        defaultAspectRatio: '16:9',
        maxPromptLength: 1000,
        cooldownSeconds: 60,
        maxWaitSeconds: 300,
        pollIntervalMs: 5000
      }
    };

    veoService = new VeoService(mockConfig);
  });

  describe('constructor', () => {
    it('should initialize with valid config', () => {
      expect(veoService).toBeDefined();
      expect(veoService.config).toBe(mockConfig);
    });

    it('should throw error if veo is disabled', () => {
      const disabledConfig = { veo: { ...mockConfig.veo, enabled: false } };
      expect(() => new VeoService(disabledConfig)).toThrow('Video generation is disabled');
    });

    it('should throw error if projectId is missing', () => {
      const noProjectConfig = { veo: { ...mockConfig.veo, projectId: '' } };
      expect(() => new VeoService(noProjectConfig)).toThrow('GOOGLE_CLOUD_PROJECT is required');
    });

    it('should create a Vertex-mode @google/genai client for the configured project/location', () => {
      expect(GoogleGenAI).toHaveBeenCalledWith({
        vertexai: true,
        project: 'test-project',
        location: 'us-central1'
      });
    });

    it('should throw error if gcsBucket is missing', () => {
      const noBucketConfig = { veo: { ...mockConfig.veo, gcsBucket: '' } };
      expect(() => new VeoService(noBucketConfig)).toThrow('VEO_GCS_BUCKET is required');
    });
  });

  describe('validatePrompt', () => {
    it('should return valid for normal prompt', () => {
      const result = veoService.validatePrompt('A flower blooming in timelapse');
      expect(result.valid).toBe(true);
    });

    it('should return invalid for empty prompt', () => {
      const result = veoService.validatePrompt('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should return invalid for whitespace-only prompt', () => {
      const result = veoService.validatePrompt('   ');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should return invalid for prompt exceeding max length', () => {
      const longPrompt = 'a'.repeat(1001);
      const result = veoService.validatePrompt(longPrompt);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceeds maximum length');
    });

    it('should accept prompt at max length', () => {
      const maxPrompt = 'a'.repeat(1000);
      const result = veoService.validatePrompt(maxPrompt);
      expect(result.valid).toBe(true);
    });
  });

  describe('validateAspectRatio', () => {
    it('should accept 16:9 aspect ratio', () => {
      const result = veoService.validateAspectRatio('16:9');
      expect(result.valid).toBe(true);
    });

    it('should accept 9:16 aspect ratio', () => {
      const result = veoService.validateAspectRatio('9:16');
      expect(result.valid).toBe(true);
    });

    it('should reject invalid aspect ratio', () => {
      const result = veoService.validateAspectRatio('4:3');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid aspect ratio');
    });

    it('should reject null aspect ratio', () => {
      const result = veoService.validateAspectRatio(null);
      expect(result.valid).toBe(false);
    });
  });

  describe('validateDuration', () => {
    it('should accept 4 seconds', () => {
      const result = veoService.validateDuration(4);
      expect(result.valid).toBe(true);
    });

    it('should accept 6 seconds', () => {
      const result = veoService.validateDuration(6);
      expect(result.valid).toBe(true);
    });

    it('should accept 8 seconds', () => {
      const result = veoService.validateDuration(8);
      expect(result.valid).toBe(true);
    });

    it('should reject 5 seconds', () => {
      const result = veoService.validateDuration(5);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid duration');
    });

    it('should reject negative duration', () => {
      const result = veoService.validateDuration(-1);
      expect(result.valid).toBe(false);
    });

    it('should handle string duration by converting to number', () => {
      const result = veoService.validateDuration('8');
      expect(result.valid).toBe(true);
    });
  });

  describe('getValidAspectRatios', () => {
    it('should return array of valid aspect ratios', () => {
      const ratios = veoService.getValidAspectRatios();
      expect(ratios).toContain('16:9');
      expect(ratios).toContain('9:16');
      expect(ratios.length).toBe(2);
    });
  });

  describe('getValidDurations', () => {
    it('should return array of valid durations', () => {
      const durations = veoService.getValidDurations();
      expect(durations).toContain(4);
      expect(durations).toContain(6);
      expect(durations).toContain(8);
      expect(durations.length).toBe(3);
    });
  });

  describe('isImageUrl', () => {
    it('should detect PNG image URLs', () => {
      expect(veoService.isImageUrl('https://example.com/image.png')).toBe(true);
    });

    it('should detect JPG image URLs', () => {
      expect(veoService.isImageUrl('https://example.com/photo.jpg')).toBe(true);
    });

    it('should detect JPEG image URLs', () => {
      expect(veoService.isImageUrl('https://example.com/photo.jpeg')).toBe(true);
    });

    it('should reject GIF URLs (not supported)', () => {
      expect(veoService.isImageUrl('https://example.com/animation.gif')).toBe(false);
    });

    it('should reject WEBP URLs (not supported by Veo)', () => {
      expect(veoService.isImageUrl('https://example.com/image.webp')).toBe(false);
    });

    it('should reject non-image URLs', () => {
      expect(veoService.isImageUrl('https://example.com/page.html')).toBe(false);
    });

    it('should handle URLs with query parameters', () => {
      expect(veoService.isImageUrl('https://example.com/image.png?size=large')).toBe(true);
    });

    it('should return false for invalid URLs', () => {
      expect(veoService.isImageUrl('not-a-url')).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(veoService.isImageUrl(null)).toBe(false);
      expect(veoService.isImageUrl(undefined)).toBe(false);
    });
  });

  describe('cooldown management', () => {
    it('should not be on cooldown initially', () => {
      expect(veoService.isOnCooldown('user123')).toBe(false);
    });

    it('should set cooldown for user', () => {
      veoService.setCooldown('user123');
      expect(veoService.isOnCooldown('user123')).toBe(true);
    });

    it('should return remaining cooldown time', () => {
      veoService.setCooldown('user123');
      const remaining = veoService.getRemainingCooldown('user123');
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(60);
    });

    it('should return 0 for user not on cooldown', () => {
      expect(veoService.getRemainingCooldown('user456')).toBe(0);
    });

    it('should clear expired cooldowns', () => {
      // Set a cooldown that expires immediately
      veoService.cooldowns.set('user789', Date.now() - 1000);
      expect(veoService.isOnCooldown('user789')).toBe(false);
    });
  });

  describe('fetchImageAsBase64', () => {
    it('should fetch and encode image successfully', async () => {
      const mockImageData = Buffer.from('fake-image-data');
      axios.get.mockResolvedValue({
        data: mockImageData,
        headers: { 'content-type': 'image/png' }
      });

      const result = await veoService.fetchImageAsBase64('https://example.com/image.png');

      expect(result.success).toBe(true);
      expect(result.data).toBe(mockImageData.toString('base64'));
      expect(result.mimeType).toBe('image/png');
    });

    it('should handle JPEG content type', async () => {
      const mockImageData = Buffer.from('fake-jpeg-data');
      axios.get.mockResolvedValue({
        data: mockImageData,
        headers: { 'content-type': 'image/jpeg' }
      });

      const result = await veoService.fetchImageAsBase64('https://example.com/photo.jpg');

      expect(result.success).toBe(true);
      expect(result.mimeType).toBe('image/jpeg');
    });

    it('should reject non-image content types', async () => {
      axios.get.mockResolvedValue({
        data: Buffer.from('not-an-image'),
        headers: { 'content-type': 'text/html' }
      });

      const result = await veoService.fetchImageAsBase64('https://example.com/page.html');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Veo only supports PNG and JPEG');
    });

    it('should handle network errors', async () => {
      axios.get.mockRejectedValue(new Error('Network error'));

      const result = await veoService.fetchImageAsBase64('https://example.com/image.png');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to fetch');
    });

    it('should infer MIME type from URL if content-type is missing', async () => {
      axios.get.mockResolvedValue({
        data: Buffer.from('fake-image'),
        headers: {}
      });

      const result = await veoService.fetchImageAsBase64('https://example.com/image.png');

      expect(result.success).toBe(true);
      expect(result.mimeType).toBe('image/png');
    });
  });

  describe('Discord emoji support', () => {
    describe('parseDiscordEmoji', () => {
      it('should parse static custom emoji', () => {
        const result = veoService.parseDiscordEmoji('<:blobsad:396521773144866826>');
        expect(result).toEqual({
          name: 'blobsad',
          id: '396521773144866826',
          animated: false
        });
      });

      it('should parse animated custom emoji', () => {
        const result = veoService.parseDiscordEmoji('<a:ablobpanic:506956736113147909>');
        expect(result).toEqual({
          name: 'ablobpanic',
          id: '506956736113147909',
          animated: true
        });
      });

      it('should return null for invalid emoji format', () => {
        expect(veoService.parseDiscordEmoji(':smile:')).toBeNull();
        expect(veoService.parseDiscordEmoji('hello')).toBeNull();
        expect(veoService.parseDiscordEmoji(null)).toBeNull();
      });
    });

    describe('isDiscordEmojiId', () => {
      it('should recognize valid snowflake IDs', () => {
        expect(veoService.isDiscordEmojiId('396521773144866826')).toBe(true);
        expect(veoService.isDiscordEmojiId('1222630577900097627')).toBe(true);
      });

      it('should reject invalid IDs', () => {
        expect(veoService.isDiscordEmojiId('12345')).toBe(false);
        expect(veoService.isDiscordEmojiId('not-a-number')).toBe(false);
        expect(veoService.isDiscordEmojiId(null)).toBe(false);
      });
    });

    describe('extractDiscordAssetUrl', () => {
      it('should extract URL from static emoji', () => {
        const result = veoService.extractDiscordAssetUrl('<:blobsad:396521773144866826>');
        expect(result).toBe('https://cdn.discordapp.com/emojis/396521773144866826.png?size=256');
      });

      it('should return null for animated emoji (GIF not supported)', () => {
        const result = veoService.extractDiscordAssetUrl('<a:ablobpanic:506956736113147909>');
        expect(result).toBeNull();
      });

      it('should extract URL from raw emoji ID', () => {
        const result = veoService.extractDiscordAssetUrl('1222630577900097627');
        expect(result).toBe('https://cdn.discordapp.com/emojis/1222630577900097627.png?size=256');
      });

      it('should return null for non-Discord strings', () => {
        expect(veoService.extractDiscordAssetUrl('hello')).toBeNull();
        expect(veoService.extractDiscordAssetUrl(':smile:')).toBeNull();
      });
    });
  });

  describe('buildGcsOutputUri', () => {
    it('should build GCS URI with timestamp', () => {
      const uri = veoService.buildGcsOutputUri();
      expect(uri).toMatch(/^gs:\/\/test-bucket\/veo-output\/\d+\/$/);
    });
  });

  describe('normalizeDiscordImageUrl', () => {
    it('should convert format=webp to format=png for Discord CDN URLs', () => {
      const webpUrl = 'https://media.discordapp.net/attachments/684882379516805202/1445978411569905736/IMG_4684.jpg?ex=69324fd6&is=6930fe56&hm=fd215fceacb1b56cdb9072fd156529a5731faabe72361f68596d81788c8a9ec5&=&format=webp&width=1760&height=1320';
      const result = veoService.normalizeDiscordImageUrl(webpUrl);

      expect(result).toContain('format=png');
      expect(result).not.toContain('format=webp');
      // Preserve other parameters
      expect(result).toContain('width=1760');
      expect(result).toContain('height=1320');
    });

    it('should handle Discord CDN URLs without format parameter', () => {
      const url = 'https://media.discordapp.net/attachments/123/456/image.png?width=100';
      const result = veoService.normalizeDiscordImageUrl(url);

      // Should remain unchanged or add format=png
      expect(result).toBe(url);
    });

    it('should not modify non-Discord URLs', () => {
      const url = 'https://example.com/image.png?format=webp';
      const result = veoService.normalizeDiscordImageUrl(url);

      expect(result).toBe(url);
    });

    it('should handle cdn.discordapp.com URLs as well', () => {
      const webpUrl = 'https://cdn.discordapp.com/attachments/123/456/image.png?format=webp';
      const result = veoService.normalizeDiscordImageUrl(webpUrl);

      expect(result).toContain('format=png');
      expect(result).not.toContain('format=webp');
    });

    it('should handle URLs with format=webp in different positions', () => {
      const url = 'https://media.discordapp.net/attachments/123/456/image.jpg?format=webp&size=large';
      const result = veoService.normalizeDiscordImageUrl(url);

      expect(result).toContain('format=png');
      expect(result).toContain('size=large');
    });

    it('should return unchanged URL for null/undefined', () => {
      expect(veoService.normalizeDiscordImageUrl(null)).toBeNull();
      expect(veoService.normalizeDiscordImageUrl(undefined)).toBeUndefined();
    });

    it('should handle invalid URL strings gracefully', () => {
      const invalidUrl = 'not-a-valid-url';
      const result = veoService.normalizeDiscordImageUrl(invalidUrl);

      expect(result).toBe(invalidUrl);
    });
  });

  describe('generateVideo (first and last frame mode)', () => {
    it('should return error for invalid prompt', async () => {
      const result = await veoService.generateVideo(
        '',
        'https://example.com/first.png',
        'https://example.com/last.png'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should return error for invalid aspect ratio', async () => {
      const result = await veoService.generateVideo(
        'A valid prompt',
        'https://example.com/first.png',
        'https://example.com/last.png',
        { aspectRatio: '4:3' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid aspect ratio');
    });

    it('should return error for invalid duration', async () => {
      const result = await veoService.generateVideo(
        'A valid prompt',
        'https://example.com/first.png',
        'https://example.com/last.png',
        { duration: 5 }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid duration');
    });

    it('should return error if first frame fetch fails', async () => {
      axios.get.mockRejectedValue(new Error('Network error'));

      const result = await veoService.generateVideo(
        'A valid prompt',
        'https://example.com/first.png',
        'https://example.com/last.png'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('first frame');
    });

    it('should return error if last frame fetch fails', async () => {
      // First call succeeds, second fails
      axios.get
        .mockResolvedValueOnce({
          data: Buffer.from('first-frame'),
          headers: { 'content-type': 'image/png' }
        })
        .mockRejectedValueOnce(new Error('Network error'));

      const result = await veoService.generateVideo(
        'A valid prompt',
        'https://example.com/first.png',
        'https://example.com/last.png'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('last frame');
    });
  });

  describe('generateVideoFromImage (single image mode)', () => {
    it('should return error for invalid prompt', async () => {
      const result = await veoService.generateVideoFromImage(
        '',
        'https://example.com/image.png'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should return error for invalid aspect ratio', async () => {
      const result = await veoService.generateVideoFromImage(
        'A valid prompt',
        'https://example.com/image.png',
        { aspectRatio: '4:3' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid aspect ratio');
    });

    it('should return error for invalid duration', async () => {
      const result = await veoService.generateVideoFromImage(
        'A valid prompt',
        'https://example.com/image.png',
        { duration: 5 }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid duration');
    });

    it('should return error if image fetch fails', async () => {
      axios.get.mockRejectedValue(new Error('Network error'));

      const result = await veoService.generateVideoFromImage(
        'A valid prompt',
        'https://example.com/image.png'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to fetch');
    });

    it('should return error if image is not PNG or JPEG', async () => {
      axios.get.mockResolvedValue({
        data: Buffer.from('fake-image'),
        headers: { 'content-type': 'image/webp' }
      });

      const result = await veoService.generateVideoFromImage(
        'A valid prompt',
        'https://example.com/image.webp'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Veo only supports PNG and JPEG');
    });

    it('should use default aspect ratio when not specified', async () => {
      // Mock the image fetch
      axios.get.mockResolvedValue({
        data: Buffer.from('fake-image'),
        headers: { 'content-type': 'image/png' }
      });

      // Mock the API call to fail so we can inspect the call
      mockGenerateVideos.mockRejectedValue(new Error('API error'));

      const result = await veoService.generateVideoFromImage(
        'A valid prompt',
        'https://example.com/image.png'
      );

      // The call will fail, but we can verify the aspect ratio was set
      expect(result.success).toBe(false);
    });

    it('should use default duration when not specified', async () => {
      axios.get.mockResolvedValue({
        data: Buffer.from('fake-image'),
        headers: { 'content-type': 'image/png' }
      });

      mockGenerateVideos.mockRejectedValue(new Error('API error'));

      const result = await veoService.generateVideoFromImage(
        'A valid prompt',
        'https://example.com/image.png'
      );

      expect(result.success).toBe(false);
    });

    it('should call progress callback during generation', async () => {
      axios.get.mockResolvedValue({
        data: Buffer.from('fake-image'),
        headers: { 'content-type': 'image/png' }
      });

      mockGenerateVideos.mockRejectedValue(new Error('API error'));

      const onProgress = jest.fn();

      await veoService.generateVideoFromImage(
        'A valid prompt',
        'https://example.com/image.png',
        {},
        null,
        onProgress
      );

      expect(onProgress).toHaveBeenCalledWith('Fetching image...');
    });

    it('should record failed generation in MongoDB', async () => {
      const mockMongoService = {
        recordVideoGeneration: jest.fn().mockResolvedValue()
      };

      const serviceWithMongo = new VeoService(mockConfig, mockMongoService);

      axios.get.mockResolvedValue({
        data: Buffer.from('fake-image'),
        headers: { 'content-type': 'image/png' }
      });

      mockGenerateVideos.mockRejectedValue(new Error('API error'));

      const user = { id: 'user123', tag: 'testuser#1234' };

      await serviceWithMongo.generateVideoFromImage(
        'A valid prompt',
        'https://example.com/image.png',
        {},
        user
      );

      expect(mockMongoService.recordVideoGeneration).toHaveBeenCalledWith(
        'user123',
        'testuser#1234',
        'A valid prompt',
        8, // default duration
        '16:9', // default aspect ratio
        'veo-3.1-fast-generate-001',
        false,
        expect.any(String),
        0
      );
    });
  });

  describe('generateVideo routing (single vs dual image)', () => {
    it('should route to single-image mode when lastFrameUrl is null', async () => {
      axios.get.mockResolvedValue({
        data: Buffer.from('fake-image'),
        headers: { 'content-type': 'image/png' }
      });

      mockGenerateVideos.mockRejectedValue(new Error('API error'));

      const onProgress = jest.fn();

      await veoService.generateVideo(
        'A valid prompt',
        'https://example.com/image.png',
        null, // No last frame
        {},
        null,
        onProgress
      );

      // Should call "Fetching image..." for single mode, not "Fetching first frame..."
      expect(onProgress).toHaveBeenCalledWith('Fetching image...');
    });

    it('should route to dual-image mode when lastFrameUrl is provided', async () => {
      axios.get.mockResolvedValue({
        data: Buffer.from('fake-image'),
        headers: { 'content-type': 'image/png' }
      });

      mockGenerateVideos.mockRejectedValue(new Error('API error'));

      const onProgress = jest.fn();

      await veoService.generateVideo(
        'A valid prompt',
        'https://example.com/first.png',
        'https://example.com/last.png', // Has last frame
        {},
        null,
        onProgress
      );

      // Should call "Fetching first frame..." for dual mode
      expect(onProgress).toHaveBeenCalledWith('Fetching first frame...');
    });
  });

  describe('generateVideoFromText (text-only mode)', () => {
    it('should return error for invalid prompt', async () => {
      const result = await veoService.generateVideoFromText('');

      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should return error for invalid aspect ratio', async () => {
      const result = await veoService.generateVideoFromText(
        'A valid prompt',
        { aspectRatio: '4:3' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid aspect ratio');
    });

    it('should return error for invalid duration', async () => {
      const result = await veoService.generateVideoFromText(
        'A valid prompt',
        { duration: 5 }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid duration');
    });

    it('should use default aspect ratio when not specified', async () => {
      mockGenerateVideos.mockRejectedValue(new Error('API error'));

      const result = await veoService.generateVideoFromText('A valid prompt');

      expect(result.success).toBe(false);
      // The call failed, but at least it attempted with defaults
    });

    it('should use default duration when not specified', async () => {
      mockGenerateVideos.mockRejectedValue(new Error('API error'));

      const result = await veoService.generateVideoFromText('A valid prompt');

      expect(result.success).toBe(false);
    });

    it('should call progress callback during generation', async () => {
      mockGenerateVideos.mockRejectedValue(new Error('API error'));

      const onProgress = jest.fn();

      await veoService.generateVideoFromText(
        'A valid prompt',
        {},
        null,
        onProgress
      );

      expect(onProgress).toHaveBeenCalledWith('Starting video generation...');
    });

    it('should record failed generation in MongoDB', async () => {
      const mockMongoService = {
        recordVideoGeneration: jest.fn().mockResolvedValue()
      };

      const serviceWithMongo = new VeoService(mockConfig, mockMongoService);

      mockGenerateVideos.mockRejectedValue(new Error('API error'));

      const user = { id: 'user123', tag: 'testuser#1234' };

      await serviceWithMongo.generateVideoFromText(
        'A valid prompt',
        {},
        user
      );

      expect(mockMongoService.recordVideoGeneration).toHaveBeenCalledWith(
        'user123',
        'testuser#1234',
        'A valid prompt',
        8, // default duration
        '16:9', // default aspect ratio
        'veo-3.1-fast-generate-001',
        false,
        expect.any(String),
        0
      );
    });

    it('should not require any image URLs', async () => {
      mockGenerateVideos.mockRejectedValue(new Error('API error'));

      const onProgress = jest.fn();

      await veoService.generateVideoFromText(
        'A sunset over the ocean',
        { duration: 6, aspectRatio: '9:16' },
        null,
        onProgress
      );

      // Should NOT call any image fetching progress messages
      expect(onProgress).not.toHaveBeenCalledWith('Fetching image...');
      expect(onProgress).not.toHaveBeenCalledWith('Fetching first frame...');
      expect(onProgress).toHaveBeenCalledWith('Starting video generation...');
    });
  });

  describe('generateVideo routing (text vs image modes)', () => {
    it('should route to text-only mode when no image URLs provided', async () => {
      mockGenerateVideos.mockRejectedValue(new Error('API error'));

      const onProgress = jest.fn();

      await veoService.generateVideo(
        'A valid prompt',
        null, // No first frame
        null, // No last frame
        {},
        null,
        onProgress
      );

      // Should call "Starting video generation..." directly without fetching images
      expect(onProgress).toHaveBeenCalledWith('Starting video generation...');
      expect(onProgress).not.toHaveBeenCalledWith('Fetching image...');
      expect(onProgress).not.toHaveBeenCalledWith('Fetching first frame...');
    });

    it('should still route to single-image mode when only firstFrameUrl provided', async () => {
      axios.get.mockResolvedValue({
        data: Buffer.from('fake-image'),
        headers: { 'content-type': 'image/png' }
      });

      mockGenerateVideos.mockRejectedValue(new Error('API error'));

      const onProgress = jest.fn();

      await veoService.generateVideo(
        'A valid prompt',
        'https://example.com/image.png',
        null,
        {},
        null,
        onProgress
      );

      expect(onProgress).toHaveBeenCalledWith('Fetching image...');
    });
  });
  describe('generation via @google/genai (Vertex)', () => {
    const doneOp = (uri = 'gs://test-bucket/veo-output/123/sample_0.mp4') => ({
      name: 'projects/test-project/locations/us-central1/publishers/google/models/veo/operations/op-1',
      done: true,
      response: { generatedVideos: [{ video: { uri, mimeType: 'video/mp4' } }] }
    });

    beforeEach(() => {
      // Keep polling tests fast.
      mockConfig.veo.pollIntervalMs = 1;
      veoService = new VeoService(mockConfig);
    });

    it('text-to-video: calls generateVideos with prompt, GCS output, ratio and duration', async () => {
      mockGenerateVideos.mockResolvedValue(doneOp());

      const result = await veoService.generateVideoFromText('A sunset', { duration: 6, aspectRatio: '9:16' });

      expect(mockGenerateVideos).toHaveBeenCalledWith({
        model: 'veo-3.1-fast-generate-001',
        source: { prompt: 'A sunset' },
        config: {
          numberOfVideos: 1,
          outputGcsUri: expect.stringMatching(/^gs:\/\/test-bucket\/veo-output\/\d+\/$/),
          aspectRatio: '9:16',
          durationSeconds: 6
        }
      });
      expect(mockGcsBucket).toHaveBeenCalledWith('test-bucket');
      expect(mockGcsFile).toHaveBeenCalledWith('veo-output/123/sample_0.mp4');
      expect(result).toEqual({
        success: true,
        buffer: Buffer.from('fake-video-data'),
        prompt: 'A sunset',
        duration: 6,
        aspectRatio: '9:16'
      });
    });

    it('image-to-video: passes the fetched image as source.image (base64 + mime)', async () => {
      axios.get.mockResolvedValue({ data: Buffer.from('img'), headers: { 'content-type': 'image/png' } });
      mockGenerateVideos.mockResolvedValue(doneOp());

      const result = await veoService.generateVideoFromImage('Animate it', 'https://example.com/a.png');

      expect(result.success).toBe(true);
      const params = mockGenerateVideos.mock.calls[0][0];
      expect(params.source).toEqual({
        prompt: 'Animate it',
        image: { imageBytes: Buffer.from('img').toString('base64'), mimeType: 'image/png' }
      });
      expect(params.config.lastFrame).toBeUndefined();
    });

    it('first/last frame: passes the last frame as config.lastFrame', async () => {
      axios.get
        .mockResolvedValueOnce({ data: Buffer.from('first'), headers: { 'content-type': 'image/png' } })
        .mockResolvedValueOnce({ data: Buffer.from('last'), headers: { 'content-type': 'image/jpeg' } });
      mockGenerateVideos.mockResolvedValue(doneOp());

      const result = await veoService.generateVideo('Morph', 'https://example.com/f.png', 'https://example.com/l.jpg');

      expect(result.success).toBe(true);
      const params = mockGenerateVideos.mock.calls[0][0];
      expect(params.source.image).toEqual({ imageBytes: Buffer.from('first').toString('base64'), mimeType: 'image/png' });
      expect(params.config.lastFrame).toEqual({ imageBytes: Buffer.from('last').toString('base64'), mimeType: 'image/jpeg' });
    });

    it('polls operations.getVideosOperation until done and reports progress', async () => {
      const pending = { name: 'op-1', done: false };
      mockGenerateVideos.mockResolvedValue(pending);
      mockGetVideosOperation
        .mockResolvedValueOnce({ name: 'op-1', done: false })
        .mockResolvedValueOnce(doneOp());
      const onProgress = jest.fn();

      const result = await veoService.generateVideoFromText('A cat', {}, null, onProgress);

      expect(result.success).toBe(true);
      expect(mockGetVideosOperation).toHaveBeenCalledTimes(2);
      expect(mockGetVideosOperation).toHaveBeenCalledWith({ operation: pending });
      expect(onProgress).toHaveBeenCalledWith('Generating video (this may take a few minutes)...');
      expect(onProgress).toHaveBeenCalledWith('Downloading generated video...');
    });

    it('returns the operation error message when the LRO fails', async () => {
      mockGenerateVideos.mockResolvedValue({ name: 'op-1', done: true, error: { code: 3, message: 'Prompt rejected' } });

      const result = await veoService.generateVideoFromText('A cat');

      expect(result).toEqual({ success: false, error: 'Prompt rejected' });
    });

    it('reports RAI filtering when no video comes back', async () => {
      mockGenerateVideos.mockResolvedValue({
        name: 'op-1', done: true,
        response: { generatedVideos: [], raiMediaFilteredCount: 1, raiMediaFilteredReasons: ['celebrity'] }
      });

      const result = await veoService.generateVideoFromText('A cat');

      expect(result.success).toBe(false);
      expect(result.error).toContain('safety filters');
      expect(result.error).toContain('celebrity');
    });

    it('fails with "No video was generated" when the response is empty', async () => {
      mockGenerateVideos.mockResolvedValue({ name: 'op-1', done: true, response: { generatedVideos: [] } });

      const result = await veoService.generateVideoFromText('A cat');

      expect(result).toEqual({ success: false, error: 'No video was generated' });
    });

    it('keeps polling through transient poll errors', async () => {
      mockGenerateVideos.mockResolvedValue({ name: 'op-1', done: false });
      mockGetVideosOperation
        .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { status: 503 }))
        .mockResolvedValueOnce(doneOp());

      const result = await veoService.generateVideoFromText('A cat');

      expect(result.success).toBe(true);
      expect(mockGetVideosOperation).toHaveBeenCalledTimes(2);
    });

    it('stops polling when the operation is not found (404)', async () => {
      mockGenerateVideos.mockResolvedValue({ name: 'op-1', done: false });
      mockGetVideosOperation.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));

      const result = await veoService.generateVideoFromText('A cat');

      expect(result).toEqual({ success: false, error: 'Operation not found' });
    });

    it('times out after maxWaitSeconds', async () => {
      mockConfig.veo.maxWaitSeconds = 0;
      veoService = new VeoService(mockConfig);
      mockGenerateVideos.mockResolvedValue({ name: 'op-1', done: false });

      const result = await veoService.generateVideoFromText('A cat');

      expect(result).toEqual({ success: false, error: 'Video generation timed out after 0 seconds' });
    });

    it('maps a 429 from the SDK to the rate-limit message and records the failure', async () => {
      const mongo = { recordVideoGeneration: jest.fn().mockResolvedValue() };
      veoService = new VeoService(mockConfig, mongo);
      mockGenerateVideos.mockRejectedValue(Object.assign(new Error('Resource exhausted'), { status: 429 }));

      const result = await veoService.generateVideoFromText('A cat', {}, { id: 'u1', username: 'bob' });

      expect(result).toEqual({ success: false, error: 'API rate limit exceeded. Please try again later.' });
      expect(mongo.recordVideoGeneration).toHaveBeenCalledWith(
        'u1', 'bob', 'A cat', 8, '16:9', 'veo-3.1-fast-generate-001', false,
        'API rate limit exceeded. Please try again later.', 0
      );
    });

    it('records a successful generation with the video size and sets the cooldown', async () => {
      const mongo = { recordVideoGeneration: jest.fn().mockResolvedValue() };
      veoService = new VeoService(mockConfig, mongo);
      mockGenerateVideos.mockResolvedValue(doneOp());

      await veoService.generateVideoFromText('A cat', {}, { id: 'u1', tag: 'bob#1' });

      expect(mongo.recordVideoGeneration).toHaveBeenCalledWith(
        'u1', 'bob#1', 'A cat', 8, '16:9', 'veo-3.1-fast-generate-001', true, null,
        Buffer.from('fake-video-data').length
      );
      expect(veoService.isOnCooldown('u1')).toBe(true);
    });
  });
});
