// __tests__/services/ImagenService.test.js
const ImagenService = require('../../services/ImagenService');

// Mock the logger
jest.mock('../../logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn()
}));

// Mock the unified Google GenAI SDK (@google/genai).
// The new SDK exposes a single client whose `models.generateContent` returns
// the GenerateContentResponse DIRECTLY (no `.response` wrapper). Model selection
// is per-call via the `model` argument — there is no pre-bound model object.
jest.mock('@google/genai', () => {
  return {
    GoogleGenAI: jest.fn().mockImplementation(() => ({
      models: {
        generateContent: jest.fn()
      }
    }))
  };
});

// Mock axios for image fetching
jest.mock('axios', () => ({
  get: jest.fn()
}));

// Helper: build a GenerateContentResponse (new-SDK shape, no `.response` wrapper).
const genResponse = (body) => ({ ...body });

describe('ImagenService', () => {
  let imagenService;
  let mockConfig;
  let mockGenerateContent;
  let mockMongoService;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConfig = {
      imagen: {
        enabled: true,
        apiKey: 'test-api-key',
        model: 'gemini-3-pro-image-preview',
        defaultAspectRatio: '1:1',
        maxPromptLength: 1000,
        cooldownSeconds: 30
      }
    };

    mockMongoService = {
      recordImageGeneration: jest.fn().mockResolvedValue(true)
    };

    imagenService = new ImagenService(mockConfig, mockMongoService);

    // Grab the generateContent mock from the client the service constructed.
    const { GoogleGenAI } = require('@google/genai');
    const clientInstance = GoogleGenAI.mock.results[0].value;
    mockGenerateContent = clientInstance.models.generateContent;
  });

  describe('constructor', () => {
    it('should initialize with config', () => {
      expect(imagenService).toBeDefined();
      expect(imagenService.config).toBe(mockConfig);
    });

    it('should construct a single GoogleGenAI client with the API key', () => {
      const { GoogleGenAI } = require('@google/genai');
      expect(GoogleGenAI).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'test-api-key' })
      );
    });

    it('should throw error if imagen is disabled', () => {
      const disabledConfig = {
        imagen: { ...mockConfig.imagen, enabled: false }
      };

      expect(() => new ImagenService(disabledConfig)).toThrow('Image generation is disabled');
    });

    it('should throw error if API key is missing', () => {
      const noKeyConfig = {
        imagen: { ...mockConfig.imagen, apiKey: '' }
      };

      expect(() => new ImagenService(noKeyConfig)).toThrow('GEMINI_API_KEY is required');
    });

    it('should record admin model name when adminModel is configured', () => {
      const adminConfig = {
        imagen: {
          ...mockConfig.imagen,
          adminModel: 'gemini-3-pro-image-preview'
        }
      };

      const service = new ImagenService(adminConfig, mockMongoService);

      expect(service.adminModelName).toBe('gemini-3-pro-image-preview');
    });

    it('should not set an admin model name when adminModel is empty', () => {
      const noAdminConfig = {
        imagen: {
          ...mockConfig.imagen,
          adminModel: ''
        }
      };

      const service = new ImagenService(noAdminConfig, mockMongoService);

      expect(service.adminModelName).toBeNull();
    });
  });

  describe('validatePrompt', () => {
    it('should return valid for a normal prompt', () => {
      const result = imagenService.validatePrompt('A beautiful sunset over mountains');

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return invalid for empty prompt', () => {
      const result = imagenService.validatePrompt('');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should return invalid for whitespace-only prompt', () => {
      const result = imagenService.validatePrompt('   ');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should return invalid for prompt exceeding max length', () => {
      const longPrompt = 'a'.repeat(1001);
      const result = imagenService.validatePrompt(longPrompt);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('1000 characters');
    });

    it('should return valid for prompt at max length', () => {
      const maxPrompt = 'a'.repeat(1000);
      const result = imagenService.validatePrompt(maxPrompt);

      expect(result.valid).toBe(true);
    });
  });

  describe('validateAspectRatio', () => {
    const validRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

    validRatios.forEach(ratio => {
      it(`should accept valid aspect ratio: ${ratio}`, () => {
        const result = imagenService.validateAspectRatio(ratio);
        expect(result.valid).toBe(true);
      });
    });

    it('should reject invalid aspect ratio', () => {
      const result = imagenService.validateAspectRatio('5:3');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid aspect ratio');
    });

    it('should reject malformed aspect ratio', () => {
      const result = imagenService.validateAspectRatio('16x9');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid aspect ratio');
    });
  });

  describe('getModelForRequest', () => {
    it('should return admin model name when isAdmin is true and admin model is configured', () => {
      const adminConfig = {
        imagen: { ...mockConfig.imagen, adminModel: 'premium-model' }
      };
      const service = new ImagenService(adminConfig, mockMongoService);

      const result = service.getModelForRequest(true);
      expect(result.modelName).toBe('premium-model');
    });

    it('should return standard model name when isAdmin is false', () => {
      const adminConfig = {
        imagen: { ...mockConfig.imagen, adminModel: 'premium-model' }
      };
      const service = new ImagenService(adminConfig, mockMongoService);

      const result = service.getModelForRequest(false);
      expect(result.modelName).toBe(mockConfig.imagen.model);
    });

    it('should return standard model name when isAdmin is true but no admin model configured', () => {
      const result = imagenService.getModelForRequest(true);
      expect(result.modelName).toBe(mockConfig.imagen.model);
    });
  });

  describe('generateImage', () => {
    const mockUser = {
      id: 'user123',
      username: 'TestUser',
      tag: 'TestUser#1234'
    };

    it('should generate image successfully', async () => {
      const mockImageData = Buffer.from('fake-image-data').toString('base64');

      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          content: {
            parts: [{
              inlineData: {
                mimeType: 'image/png',
                data: mockImageData
              }
            }]
          }
        }]
      }));

      const result = await imagenService.generateImage('A beautiful sunset', {}, mockUser);

      expect(result.success).toBe(true);
      expect(result.buffer).toBeDefined();
      expect(result.mimeType).toBe('image/png');
      expect(Buffer.isBuffer(result.buffer)).toBe(true);
    });

    it('should call the client with the selected model and IMAGE response modality', async () => {
      const mockImageData = Buffer.from('fake-image-data').toString('base64');

      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          content: { parts: [{ inlineData: { mimeType: 'image/png', data: mockImageData } }] }
        }]
      }));

      await imagenService.generateImage('A beautiful sunset', {}, mockUser);

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gemini-3-pro-image-preview',
          contents: expect.any(Array),
          config: expect.objectContaining({
            responseModalities: ['IMAGE']
          })
        })
      );
    });

    it('should prefix prompt with image generation instruction', async () => {
      const mockImageData = Buffer.from('fake-image-data').toString('base64');

      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          content: { parts: [{ inlineData: { mimeType: 'image/png', data: mockImageData } }] }
        }]
      }));

      await imagenService.generateImage('A beautiful sunset', {}, mockUser);

      const callArgs = mockGenerateContent.mock.calls[0][0];
      const promptText = callArgs.contents[0].parts[0].text;
      expect(promptText).toMatch(/^Generate an image/i);
      expect(promptText).toContain('A beautiful sunset');
    });

    it('should return error for invalid prompt', async () => {
      const result = await imagenService.generateImage('', {}, mockUser);

      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should return error for invalid aspect ratio option', async () => {
      const result = await imagenService.generateImage('A sunset', { aspectRatio: '5:3' }, mockUser);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid aspect ratio');
    });

    it('should use default aspect ratio when not specified', async () => {
      const mockImageData = Buffer.from('fake-image-data').toString('base64');

      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          content: { parts: [{ inlineData: { mimeType: 'image/png', data: mockImageData } }] }
        }]
      }));

      await imagenService.generateImage('A sunset', {}, mockUser);

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: expect.any(Array)
        })
      );
    });

    it('should handle API errors gracefully', async () => {
      mockGenerateContent.mockRejectedValue(new Error('API rate limit exceeded'));

      const result = await imagenService.generateImage('A sunset', {}, mockUser);

      expect(result.success).toBe(false);
      expect(result.error).toContain('rate limit');
    });

    it('should handle safety filter rejections', async () => {
      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          finishReason: 'SAFETY',
          safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH' }]
        }]
      }));

      const result = await imagenService.generateImage('Something inappropriate', {}, mockUser);

      expect(result.success).toBe(false);
      expect(result.error).toContain('safety');
    });

    it('should handle empty response', async () => {
      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: []
      }));

      const result = await imagenService.generateImage('A sunset', {}, mockUser);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No image');
    });

    it('should handle empty response with SAFETY block reason in promptFeedback', async () => {
      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [],
        promptFeedback: {
          blockReason: 'SAFETY',
          safetyRatings: [
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH', blocked: true }
          ]
        }
      }));

      const result = await imagenService.generateImage('Something inappropriate', {}, mockUser);

      expect(result.success).toBe(false);
      expect(result.error).toContain('safety filters');
    });

    it('should handle empty response with PROHIBITED_CONTENT block reason', async () => {
      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [],
        promptFeedback: {
          blockReason: 'PROHIBITED_CONTENT'
        }
      }));

      const result = await imagenService.generateImage('Some prompt', {}, mockUser);

      expect(result.success).toBe(false);
      expect(result.error).toContain('prohibited content');
    });

    it('should handle empty response with unknown block reason', async () => {
      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [],
        promptFeedback: {
          blockReason: 'SOME_NEW_REASON'
        }
      }));

      const result = await imagenService.generateImage('Some prompt', {}, mockUser);

      expect(result.success).toBe(false);
      expect(result.error).toContain('SOME_NEW_REASON');
    });

    it('should handle response without image data', async () => {
      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          content: {
            parts: [{
              text: 'I cannot generate that image'
            }]
          }
        }]
      }));

      const result = await imagenService.generateImage('A sunset', {}, mockUser);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No image');
    });

    it('should record successful generation in MongoDB', async () => {
      const mockImageData = Buffer.from('fake-image-data').toString('base64');

      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          content: { parts: [{ inlineData: { mimeType: 'image/png', data: mockImageData } }] }
        }]
      }));

      await imagenService.generateImage('A beautiful sunset', {}, mockUser);

      expect(mockMongoService.recordImageGeneration).toHaveBeenCalledWith(
        'user123',
        'TestUser#1234',
        'A beautiful sunset',
        '1:1',
        'gemini-3-pro-image-preview',
        true,
        null,
        expect.any(Number)
      );
    });

    it('should use admin model when isAdmin option is true', async () => {
      const adminConfig = {
        imagen: { ...mockConfig.imagen, adminModel: 'premium-model' }
      };
      const service = new ImagenService(adminConfig, mockMongoService);

      const { GoogleGenAI } = require('@google/genai');
      const adminClient = GoogleGenAI.mock.results[GoogleGenAI.mock.results.length - 1].value;
      const adminGenerateContent = adminClient.models.generateContent;

      const mockImageData = Buffer.from('fake-image-data').toString('base64');
      adminGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          content: { parts: [{ inlineData: { mimeType: 'image/png', data: mockImageData } }] }
        }]
      }));

      const result = await service.generateImage('A sunset', { isAdmin: true }, mockUser);

      expect(result.success).toBe(true);
      expect(adminGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'premium-model' })
      );
    });

    it('should record admin model name in MongoDB when admin generates image', async () => {
      const adminConfig = {
        imagen: { ...mockConfig.imagen, adminModel: 'premium-model' }
      };
      const service = new ImagenService(adminConfig, mockMongoService);

      const { GoogleGenAI } = require('@google/genai');
      const adminClient = GoogleGenAI.mock.results[GoogleGenAI.mock.results.length - 1].value;
      const adminGenerateContent = adminClient.models.generateContent;

      const mockImageData = Buffer.from('fake-image-data').toString('base64');
      adminGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          content: { parts: [{ inlineData: { mimeType: 'image/png', data: mockImageData } }] }
        }]
      }));

      await service.generateImage('A sunset', { isAdmin: true }, mockUser);

      expect(mockMongoService.recordImageGeneration).toHaveBeenCalledWith(
        'user123',
        'TestUser#1234',
        'A sunset',
        '1:1',
        'premium-model',
        true,
        null,
        expect.any(Number)
      );
    });

    it('should fall back to standard model when isAdmin is true but no admin model configured', async () => {
      const mockImageData = Buffer.from('fake-image-data').toString('base64');

      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          content: { parts: [{ inlineData: { mimeType: 'image/png', data: mockImageData } }] }
        }]
      }));

      const result = await imagenService.generateImage('A sunset', { isAdmin: true }, mockUser);

      expect(result.success).toBe(true);
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gemini-3-pro-image-preview' })
      );
    });

    it('should record failed generation in MongoDB', async () => {
      mockGenerateContent.mockRejectedValue(new Error('API rate limit exceeded'));

      await imagenService.generateImage('A sunset', {}, mockUser);

      expect(mockMongoService.recordImageGeneration).toHaveBeenCalledWith(
        'user123',
        'TestUser#1234',
        'A sunset',
        '1:1',
        'gemini-3-pro-image-preview',
        false,
        expect.stringContaining('rate limit'),
        0
      );
    });
  });

  describe('cooldown management', () => {
    const mockUser = { id: 'user123', username: 'TestUser' };

    it('should track cooldowns per user', () => {
      imagenService.setCooldown(mockUser.id);

      expect(imagenService.isOnCooldown(mockUser.id)).toBe(true);
    });

    it('should return remaining cooldown time', () => {
      imagenService.setCooldown(mockUser.id);

      const remaining = imagenService.getRemainingCooldown(mockUser.id);

      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(30);
    });

    it('should not be on cooldown for new users', () => {
      expect(imagenService.isOnCooldown('newuser456')).toBe(false);
    });

    it('should return 0 remaining for users not on cooldown', () => {
      expect(imagenService.getRemainingCooldown('newuser456')).toBe(0);
    });
  });

  describe('Discord emoji and sticker support', () => {
    describe('parseDiscordEmoji', () => {
      it('should parse standard custom emoji format', () => {
        const result = imagenService.parseDiscordEmoji('<:blobsad:396521773144866826>');

        expect(result).toEqual({
          name: 'blobsad',
          id: '396521773144866826',
          animated: false
        });
      });

      it('should parse animated emoji format', () => {
        const result = imagenService.parseDiscordEmoji('<a:ablobpanic:506956736113147909>');

        expect(result).toEqual({
          name: 'ablobpanic',
          id: '506956736113147909',
          animated: true
        });
      });

      it('should return null for non-emoji strings', () => {
        expect(imagenService.parseDiscordEmoji('hello')).toBeNull();
        expect(imagenService.parseDiscordEmoji(':smile:')).toBeNull();
        expect(imagenService.parseDiscordEmoji('1222630577900097627')).toBeNull();
      });

      it('should return null for empty or invalid input', () => {
        expect(imagenService.parseDiscordEmoji('')).toBeNull();
        expect(imagenService.parseDiscordEmoji(null)).toBeNull();
        expect(imagenService.parseDiscordEmoji(undefined)).toBeNull();
      });
    });

    describe('isDiscordEmojiId', () => {
      it('should detect valid emoji IDs (snowflake format)', () => {
        expect(imagenService.isDiscordEmojiId('1222630577900097627')).toBe(true);
        expect(imagenService.isDiscordEmojiId('396521773144866826')).toBe(true);
      });

      it('should reject invalid IDs', () => {
        expect(imagenService.isDiscordEmojiId('123')).toBe(false);
        expect(imagenService.isDiscordEmojiId('abc123')).toBe(false);
        expect(imagenService.isDiscordEmojiId('')).toBe(false);
        expect(imagenService.isDiscordEmojiId('hello')).toBe(false);
      });
    });

    describe('getDiscordEmojiUrl', () => {
      it('should generate PNG URL for static emoji', () => {
        const url = imagenService.getDiscordEmojiUrl('1222630577900097627', false);

        expect(url).toBe('https://cdn.discordapp.com/emojis/1222630577900097627.png?size=256');
      });

      it('should generate GIF URL for animated emoji', () => {
        const url = imagenService.getDiscordEmojiUrl('506956736113147909', true);

        expect(url).toBe('https://cdn.discordapp.com/emojis/506956736113147909.gif?size=256');
      });
    });

    describe('getDiscordStickerUrl', () => {
      it('should generate PNG URL for sticker', () => {
        const url = imagenService.getDiscordStickerUrl('1234567890123456789');

        expect(url).toBe('https://cdn.discordapp.com/stickers/1234567890123456789.png?size=320');
      });
    });

    describe('extractDiscordAssetUrl', () => {
      it('should extract URL from custom emoji format', () => {
        const result = imagenService.extractDiscordAssetUrl('<:blobsad:396521773144866826>');

        expect(result).toBe('https://cdn.discordapp.com/emojis/396521773144866826.png?size=256');
      });

      it('should return null for animated emoji format (GIF not supported)', () => {
        const result = imagenService.extractDiscordAssetUrl('<a:ablobpanic:506956736113147909>');

        expect(result).toBeNull();
      });

      it('should extract URL from raw emoji ID', () => {
        const result = imagenService.extractDiscordAssetUrl('1222630577900097627');

        expect(result).toBe('https://cdn.discordapp.com/emojis/1222630577900097627.png?size=256');
      });

      it('should return null for non-Discord assets', () => {
        expect(imagenService.extractDiscordAssetUrl('hello')).toBeNull();
        expect(imagenService.extractDiscordAssetUrl(':smile:')).toBeNull();
      });
    });
  });

  describe('reference image support', () => {
    const mockUser = {
      id: 'user123',
      username: 'TestUser',
      tag: 'TestUser#1234'
    };
    const axios = require('axios');

    beforeEach(() => {
      axios.get.mockReset();
    });

    describe('isImageUrl', () => {
      it('should detect PNG image URLs', () => {
        expect(imagenService.isImageUrl('https://example.com/image.png')).toBe(true);
      });

      it('should detect JPG image URLs', () => {
        expect(imagenService.isImageUrl('https://example.com/photo.jpg')).toBe(true);
      });

      it('should detect JPEG image URLs', () => {
        expect(imagenService.isImageUrl('https://example.com/photo.jpeg')).toBe(true);
      });

      it('should reject GIF image URLs (not supported)', () => {
        expect(imagenService.isImageUrl('https://example.com/animation.gif')).toBe(false);
      });

      it('should detect WEBP image URLs', () => {
        expect(imagenService.isImageUrl('https://example.com/image.webp')).toBe(true);
      });

      it('should handle URLs with query parameters', () => {
        expect(imagenService.isImageUrl('https://example.com/image.png?size=large')).toBe(true);
      });

      it('should be case insensitive', () => {
        expect(imagenService.isImageUrl('https://example.com/image.PNG')).toBe(true);
        expect(imagenService.isImageUrl('https://example.com/image.JPG')).toBe(true);
      });

      it('should return false for non-image URLs', () => {
        expect(imagenService.isImageUrl('https://example.com/page.html')).toBe(false);
        expect(imagenService.isImageUrl('https://example.com/video.mp4')).toBe(false);
      });

      it('should return false for non-URLs', () => {
        expect(imagenService.isImageUrl('not a url')).toBe(false);
        expect(imagenService.isImageUrl('')).toBe(false);
      });
    });

    describe('fetchImageAsBase64', () => {
      it('should fetch and encode image as base64', async () => {
        const fakeImageBuffer = Buffer.from('fake-image-data');
        axios.get.mockResolvedValue({
          data: fakeImageBuffer,
          headers: { 'content-type': 'image/png' }
        });

        const result = await imagenService.fetchImageAsBase64('https://example.com/image.png');

        expect(result.success).toBe(true);
        expect(result.data).toBe(fakeImageBuffer.toString('base64'));
        expect(result.mimeType).toBe('image/png');
      });

      it('should infer mime type from URL if not in headers', async () => {
        const fakeImageBuffer = Buffer.from('fake-image-data');
        axios.get.mockResolvedValue({
          data: fakeImageBuffer,
          headers: {}
        });

        const result = await imagenService.fetchImageAsBase64('https://example.com/photo.jpg');

        expect(result.success).toBe(true);
        expect(result.mimeType).toBe('image/jpeg');
      });

      it('should handle fetch errors', async () => {
        axios.get.mockRejectedValue(new Error('Network error'));

        const result = await imagenService.fetchImageAsBase64('https://example.com/image.png');

        expect(result.success).toBe(false);
        expect(result.error).toContain('fetch');
      });

      it('should reject non-image content types for non-image URLs', async () => {
        axios.get.mockResolvedValue({
          data: Buffer.from('not an image'),
          headers: { 'content-type': 'text/html' }
        });

        // URL without image extension, so it relies on content-type header
        const result = await imagenService.fetchImageAsBase64('https://example.com/image');

        expect(result.success).toBe(false);
        expect(result.error).toContain('does not point to a valid image');
      });
    });

    describe('generateImage with reference image', () => {
      it('should include reference image in API call', async () => {
        const fakeImageBuffer = Buffer.from('reference-image-data');
        const mockOutputImage = Buffer.from('generated-image').toString('base64');

        axios.get.mockResolvedValue({
          data: fakeImageBuffer,
          headers: { 'content-type': 'image/png' }
        });

        mockGenerateContent.mockResolvedValue(genResponse({
          candidates: [{
            content: { parts: [{ inlineData: { mimeType: 'image/png', data: mockOutputImage } }] }
          }]
        }));

        const result = await imagenService.generateImage(
          'Make this image look like a painting',
          { referenceImageUrl: 'https://example.com/photo.png' },
          mockUser
        );

        expect(result.success).toBe(true);
        expect(axios.get).toHaveBeenCalledWith(
          'https://example.com/photo.png',
          expect.objectContaining({ responseType: 'arraybuffer' })
        );

        // Verify the API was called with both text and image parts
        const callArgs = mockGenerateContent.mock.calls[0][0];
        expect(callArgs.contents[0].parts).toHaveLength(2);
        expect(callArgs.contents[0].parts[0]).toHaveProperty('text');
        expect(callArgs.contents[0].parts[1]).toHaveProperty('inlineData');
      });

      it('should return error if reference image fetch fails', async () => {
        axios.get.mockRejectedValue(new Error('Image not found'));

        const result = await imagenService.generateImage(
          'Make this image look like a painting',
          { referenceImageUrl: 'https://example.com/missing.png' },
          mockUser
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('fetch');
      });
    });
  });

  // ========== EXTENDED FAILURE CONTEXT TESTS ==========
  describe('failureContext in error responses', () => {
    const mockUser = {
      id: 'user123',
      username: 'TestUser',
      tag: 'TestUser#1234'
    };

    it('should include failureContext for safety filter rejections', async () => {
      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          finishReason: 'SAFETY',
          safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH' }]
        }]
      }));

      const result = await imagenService.generateImage('Inappropriate content', {}, mockUser);

      expect(result.success).toBe(false);
      expect(result.failureContext).toBeDefined();
      expect(result.failureContext.type).toBe('safety');
      expect(result.failureContext.details).toBeDefined();
    });

    it('should include failureContext for promptFeedback block', async () => {
      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [],
        promptFeedback: {
          blockReason: 'SAFETY',
          safetyRatings: [{ category: 'HARM', probability: 'HIGH', blocked: true }]
        }
      }));

      const result = await imagenService.generateImage('Blocked content', {}, mockUser);

      expect(result.success).toBe(false);
      expect(result.failureContext).toBeDefined();
      expect(result.failureContext.type).toBe('safety');
      expect(result.failureContext.promptFeedback).toBeDefined();
      expect(result.failureContext.promptFeedback.blockReason).toBe('SAFETY');
    });

    it('should include failureContext for empty candidates', async () => {
      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: []
      }));

      const result = await imagenService.generateImage('A sunset', {}, mockUser);

      expect(result.success).toBe(false);
      expect(result.failureContext).toBeDefined();
      expect(result.failureContext.type).toBe('no_candidates');
    });

    it('should include textResponse in failureContext when model returns text instead of image', async () => {
      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          content: {
            parts: [{ text: 'I cannot generate images of real people.' }]
          },
          finishReason: 'STOP'
        }]
      }));

      const result = await imagenService.generateImage('A photo of a celebrity', {}, mockUser);

      expect(result.success).toBe(false);
      expect(result.failureContext).toBeDefined();
      expect(result.failureContext.type).toBe('text_response');
      expect(result.failureContext.textResponse).toContain('cannot generate');
    });

    it('should include failureContext for rate limit errors', async () => {
      mockGenerateContent.mockRejectedValue(new Error('API rate limit exceeded'));

      const result = await imagenService.generateImage('A sunset', {}, mockUser);

      expect(result.success).toBe(false);
      expect(result.failureContext).toBeDefined();
      expect(result.failureContext.type).toBe('rate_limit');
    });

    it('should include failureContext for generic API errors', async () => {
      mockGenerateContent.mockRejectedValue(new Error('Unknown API error'));

      const result = await imagenService.generateImage('A sunset', {}, mockUser);

      expect(result.success).toBe(false);
      expect(result.failureContext).toBeDefined();
      expect(result.failureContext.type).toBe('unknown');
    });

    it('should include original prompt in failureContext', async () => {
      mockGenerateContent.mockRejectedValue(new Error('Some error'));

      const result = await imagenService.generateImage('My unique prompt', {}, mockUser);

      expect(result.failureContext.originalPrompt).toBe('My unique prompt');
    });

    it('should handle IMAGE_SAFETY finishReason as safety rejection', async () => {
      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          finishReason: 'IMAGE_SAFETY',
          safetyRatings: [{ category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', probability: 'HIGH', blocked: true }]
        }]
      }));

      const result = await imagenService.generateImage('Some prompt', {}, mockUser);

      expect(result.success).toBe(false);
      expect(result.error).toContain('safety');
      expect(result.failureContext.type).toBe('safety');
      expect(result.failureContext.details.finishReason).toBe('IMAGE_SAFETY');
      expect(result.failureContext.details.safetyRatings).toBeDefined();
    });

    it('should handle IMAGE_PROHIBITED_CONTENT finishReason as safety rejection', async () => {
      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          finishReason: 'IMAGE_PROHIBITED_CONTENT',
          safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH', blocked: true }]
        }]
      }));

      const result = await imagenService.generateImage('Some prompt', {}, mockUser);

      expect(result.success).toBe(false);
      expect(result.error).toContain('prohibited content');
      expect(result.failureContext.type).toBe('safety');
      expect(result.failureContext.details.finishReason).toBe('IMAGE_PROHIBITED_CONTENT');
    });

    it('should include finishReason in text_response failureContext details', async () => {
      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          content: {
            parts: [{ text: 'I cannot generate that image due to policy.' }]
          },
          finishReason: 'STOP'
        }]
      }));

      const result = await imagenService.generateImage('A photo of something', {}, mockUser);

      expect(result.failureContext.type).toBe('text_response');
      expect(result.failureContext.details.finishReason).toBe('STOP');
    });

    it('should log blockReasonMessage from promptFeedback when present', async () => {
      const logger = require('../../logger');

      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [],
        promptFeedback: {
          blockReason: 'SAFETY',
          blockReasonMessage: 'The prompt was blocked because it contained unsafe content.',
          safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH', blocked: true }]
        }
      }));

      const result = await imagenService.generateImage('Blocked content', {}, mockUser);

      expect(result.success).toBe(false);
      // Verify blockReasonMessage was logged
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('blockReasonMessage')
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('The prompt was blocked because it contained unsafe content.')
      );
    });

    it('should include finishReason in failureContext when candidate has no content parts', async () => {
      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          finishReason: 'IMAGE_SAFETY',
          content: null
        }]
      }));

      const result = await imagenService.generateImage('Some prompt', {}, mockUser);

      expect(result.success).toBe(false);
      expect(result.failureContext.type).toBe('safety');
      expect(result.failureContext.details.finishReason).toBe('IMAGE_SAFETY');
    });

    it('should debug log full candidate structure on safety rejection', async () => {
      const logger = require('../../logger');

      const candidate = {
        finishReason: 'IMAGE_SAFETY',
        safetyRatings: [
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', probability: 'HIGH', blocked: true },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'NEGLIGIBLE', blocked: false }
        ]
      };

      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [candidate]
      }));

      await imagenService.generateImage('Some prompt', {}, mockUser);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('IMAGE_SAFETY')
      );
    });

    it('should handle NO_IMAGE finishReason as a distinct failure type', async () => {
      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          finishReason: 'NO_IMAGE',
          content: { parts: [] }
        }]
      }));

      const result = await imagenService.generateImage('A complex prompt', {}, mockUser);

      expect(result.success).toBe(false);
      expect(result.error).toContain('unable to generate an image');
      expect(result.failureContext).toBeDefined();
      expect(result.failureContext.type).toBe('no_image');
      expect(result.failureContext.details.finishReason).toBe('NO_IMAGE');
    });

    it('should handle NO_IMAGE finishReason with null content', async () => {
      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          finishReason: 'NO_IMAGE',
          content: null
        }]
      }));

      const result = await imagenService.generateImage('A complex prompt', {}, mockUser);

      expect(result.success).toBe(false);
      expect(result.failureContext.type).toBe('no_image');
    });

    it('should log finishReason and safetyRatings on text_response path', async () => {
      const logger = require('../../logger');

      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          content: {
            parts: [{ text: 'I cannot generate that.' }]
          },
          finishReason: 'STOP',
          safetyRatings: [
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'NEGLIGIBLE', blocked: false }
          ]
        }]
      }));

      await imagenService.generateImage('Some prompt', {}, mockUser);

      // Should log finishReason in the text_response warn
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('finishReason: STOP')
      );
      // Should log safetyRatings in the text_response warn
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('HARM_CATEGORY_DANGEROUS_CONTENT')
      );
      // Should debug log full candidate structure
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Full candidate structure on text response')
      );
    });

    it('should not truncate prompts in log messages', async () => {
      const logger = require('../../logger');
      const longPrompt = 'A '.repeat(200) + 'beautiful sunset over the mountains';

      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [{
          content: {
            parts: [{ text: 'Cannot generate this image.' }]
          },
          finishReason: 'STOP'
        }]
      }));

      await imagenService.generateImage(longPrompt, {}, mockUser);

      // Verify the full prompt appears in warn logs (not truncated)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('beautiful sunset over the mountains')
      );
    });

    it('should include promptFeedback blockReasonMessage in failureContext details', async () => {
      mockGenerateContent.mockResolvedValue(genResponse({
        candidates: [],
        promptFeedback: {
          blockReason: 'PROHIBITED_CONTENT',
          blockReasonMessage: 'Content violates usage policies.',
          safetyRatings: []
        }
      }));

      const result = await imagenService.generateImage('Some prompt', {}, mockUser);

      expect(result.failureContext.details.blockReasonMessage).toBe('Content violates usage policies.');
    });
  });
});
