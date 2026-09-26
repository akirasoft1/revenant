// services/VoiceProfileService.js
// Analyzes channel conversation history to build a dynamic voice profile

const logger = require('../logger');
const { DEFAULT_OPENAI_MODEL, reasoningParams } = require('../utils/openaiModels');

const DECADES = ['1990s', '2000s', '2010s', '2020s'];
const BATCH_SIZE = 20; // Conversation chunks per LLM analysis call

const ANALYSIS_PROMPT = `Analyze the communication style in these conversation excerpts. These are real messages from a group of friends spanning years of conversation. Extract:

1. VOCABULARY: Distinctive words, phrases, slang, recurring expressions, inside jokes
2. TONE: Overall emotional register (sarcastic, earnest, combative, supportive, etc.)
3. SENTENCE STRUCTURE: Average length, complexity, use of fragments vs. full sentences
4. HUMOR PATTERNS: Types of humor used (deadpan, absurdist, self-deprecating, dark, puns, etc.)
5. INTERACTION PATTERNS: How they greet, argue, agree, change topics, use nicknames
6. CULTURAL REFERENCES: Common reference points (games, tech, movies, music, etc.)
7. PROFANITY & INTENSITY: Level and style of profanity use, intensity of expression
8. DISTINCTIVE QUIRKS: Any unusual patterns, spelling habits, emoji usage, formatting

Provide your analysis as a structured JSON object with keys: vocabulary, tone, sentence_structure, humor_patterns, interaction_patterns, cultural_references, profanity, quirks. Be specific -- quote actual examples from the text.`;

const SYNTHESIS_PROMPT = `You are creating a unified "voice profile" from multiple analyses of a group's communication style across decades. Merge these analyses into one coherent style guide that a chatbot should follow to sound like a natural member of this group.

The profile should be written as INSTRUCTIONS TO AN AI, not a description. Use imperative mood.
Example: "Use 'nah' instead of 'no'. Drop sentence-ending periods. Respond with single-word acknowledgments like 'word' or 'yep'."

IMPORTANT: Be realistic about FREQUENCY. If the group uses "lol" in 30% of messages, say "use lol occasionally" not "pepper every response with lol". Avoid instructions that would make EVERY response sound identical. Vary the style naturally -- not every message needs slang, interjections, or profanity.

Output a JSON object with these fields:
- voice_instructions: A paragraph of direct style instructions (max 500 words)
- vocabulary: Array of distinctive words/phrases to use
- avoid: Array of things that would sound unnatural for this group
- tone_keywords: Array of 3-5 adjective keywords describing the tone
- example_responses: Array of 5 short example responses showing the style in action
- humor_style: One sentence describing how to be funny in this group's way
- intensity_level: "low", "medium", or "high" -- how blunt/intense the group is`;

class VoiceProfileService {
  constructor(openaiClient, config, mongoService, qdrantService, channelContextService) {
    this.openai = openaiClient;
    this.config = config.voiceProfile || {};
    this.mongoService = mongoService;
    this.qdrantService = qdrantService;
    this.channelContextService = channelContextService;
    this._cachedProfile = null;
    this._regenInterval = null;

    logger.info('VoiceProfileService initialized');
  }

  /**
   * Start the service - load or generate profile, schedule regeneration
   */
  async start() {
    try {
      // Try to load existing profile from MongoDB
      const existing = await this._loadProfile();
      if (existing) {
        this._cachedProfile = existing;
        logger.info(`Loaded existing voice profile v${existing.version} from ${existing.generatedAt}`);
      } else {
        logger.info('No existing voice profile found, generating initial profile...');
        await this.regenerateProfile();
      }

      // Schedule periodic regeneration
      const intervalMs = (this.config.regenIntervalHours || 24) * 60 * 60 * 1000;
      this._regenInterval = setInterval(() => {
        this.regenerateProfile().catch(err =>
          logger.error(`Scheduled voice profile regeneration failed: ${err.message}`)
        );
      }, intervalMs);

      logger.info(`Voice profile regeneration scheduled every ${this.config.regenIntervalHours || 24} hours`);
    } catch (error) {
      logger.error(`Failed to start VoiceProfileService: ${error.message}`);
    }
  }

  /**
   * Stop the service
   */
  stop() {
    if (this._regenInterval) {
      clearInterval(this._regenInterval);
      this._regenInterval = null;
    }
    logger.info('VoiceProfileService stopped');
  }

  /**
   * Get the current voice profile (cached or from MongoDB)
   * @returns {Promise<Object|null>}
   */
  async getProfile() {
    if (this._cachedProfile) {
      return this._cachedProfile;
    }

    try {
      const profile = await this._loadProfile();
      if (profile) {
        this._cachedProfile = profile;
      }
      return profile;
    } catch (error) {
      logger.error(`Error loading voice profile: ${error.message}`);
      return null;
    }
  }

  /**
   * Full regeneration pipeline: sample -> analyze -> synthesize -> store
   */
  async regenerateProfile() {
    try {
      logger.info('Starting voice profile regeneration...');

      // Sample from both data sources
      const [ircSamples, discordSamples] = await Promise.all([
        this._sampleIrcHistory().catch(err => {
          logger.error(`IRC sampling failed: ${err.message}`);
          return [];
        }),
        this._sampleDiscordMessages().catch(err => {
          logger.error(`Discord sampling failed: ${err.message}`);
          return [];
        })
      ]);

      const allSamples = [...ircSamples, ...discordSamples];
      if (allSamples.length === 0) {
        logger.warn('No samples collected for voice profile generation');
        return;
      }

      logger.info(`Collected ${ircSamples.length} IRC + ${discordSamples.length} Discord samples`);

      // Batch analyze
      const batchResults = [];
      for (let i = 0; i < allSamples.length; i += BATCH_SIZE) {
        const batch = allSamples.slice(i, i + BATCH_SIZE);
        const result = await this._analyzeStyleBatch(batch);
        if (result) {
          batchResults.push(result);
        }
      }

      if (batchResults.length === 0) {
        logger.warn('No analysis results produced');
        return;
      }

      logger.info(`Produced ${batchResults.length} batch analyses, synthesizing...`);

      // Synthesize into unified profile
      const profile = await this._synthesizeProfile(batchResults);
      if (!profile) {
        logger.error('Profile synthesis failed');
        return;
      }

      // Store with metadata
      const currentVersion = this._cachedProfile?.version || 0;
      profile.version = currentVersion + 1;
      profile.generatedAt = new Date();
      profile.metadata = {
        ircSamplesUsed: ircSamples.length,
        discordSamplesUsed: discordSamples.length,
        analysisModel: this.config.analysisModel || DEFAULT_OPENAI_MODEL,
        batchCount: batchResults.length
      };

      await this._storeProfile(profile);
      logger.info(`Voice profile v${profile.version} generated and stored`);

    } catch (error) {
      logger.error(`Voice profile regeneration failed: ${error.message}`);
    }
  }

  /**
   * Sample IRC history from Qdrant, stratified by decade
   * @returns {Promise<Array>}
   */
  async _sampleIrcHistory() {
    const samplesPerDecade = this.config.samplesPerDecade || 50;
    const allSamples = [];

    for (const decade of DECADES) {
      const response = await this.qdrantService.client.scroll('irc_history', {
        filter: { must: [{ key: 'decade', match: { value: decade } }] },
        limit: samplesPerDecade * 3,
        with_payload: true
      });

      const shuffled = this._shuffleArray(response.points || []);
      allSamples.push(...shuffled.slice(0, samplesPerDecade));
    }

    return allSamples;
  }

  /**
   * Sample Discord messages from channel_conversations
   * @returns {Promise<Array>}
   */
  async _sampleDiscordMessages() {
    const sampleSize = this.config.discordSampleSize || 100;

    const response = await this.channelContextService.qdrantClient.scroll('channel_conversations', {
      limit: sampleSize * 3,
      with_payload: true
    });

    const shuffled = this._shuffleArray(response.points || []);
    return shuffled.slice(0, sampleSize);
  }

  /**
   * Send a batch of conversation chunks to LLM for style analysis
   * @param {Array} chunks - Array of Qdrant points with payloads
   * @returns {Promise<Object>}
   */
  async _analyzeStyleBatch(chunks) {
    const batchText = chunks.map(c => {
      const payload = c.payload;
      // IRC format: text field contains full conversation
      if (payload.text) return payload.text;
      // Discord format: individual messages
      if (payload.content && payload.authorName) return `${payload.authorName}: ${payload.content}`;
      return '';
    }).filter(Boolean).join('\n---\n');

    if (!batchText.trim()) return null;

    try {
      const model = this.config.analysisModel || DEFAULT_OPENAI_MODEL;
      const response = await this.openai.responses.create({
        model,
        instructions: ANALYSIS_PROMPT,
        input: `CONVERSATIONS:\n${batchText}`,
        ...reasoningParams(model, 'medium')
      });

      try {
        return JSON.parse(response.output_text);
      } catch {
        // LLM didn't return valid JSON, wrap as raw text
        return { rawText: response.output_text };
      }
    } catch (error) {
      logger.error(`Style batch analysis failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Synthesize batch analyses into a unified voice profile
   * @param {Array} batchResults - Array of analysis objects
   * @returns {Promise<Object|null>}
   */
  async _synthesizeProfile(batchResults) {
    try {
      const model = this.config.analysisModel || DEFAULT_OPENAI_MODEL;
      const response = await this.openai.responses.create({
        model,
        instructions: SYNTHESIS_PROMPT,
        input: `INDIVIDUAL ANALYSES:\n${JSON.stringify(batchResults, null, 2)}`,
        ...reasoningParams(model, 'medium')
      });

      const parsed = JSON.parse(response.output_text);

      return {
        profileId: 'channel_voice_v1',
        voiceInstructions: parsed.voice_instructions || '',
        vocabulary: parsed.vocabulary || [],
        avoid: parsed.avoid || [],
        toneKeywords: parsed.tone_keywords || [],
        humorStyle: parsed.humor_style || '',
        intensityLevel: parsed.intensity_level || 'medium',
        exampleResponses: parsed.example_responses || []
      };
    } catch (error) {
      logger.error(`Profile synthesis failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Store profile in MongoDB
   * @param {Object} profile
   */
  async _storeProfile(profile) {
    const collection = this.mongoService.db.collection('voice_profiles');

    // Keep previous version for history
    const previousVersion = this._cachedProfile
      ? { version: this._cachedProfile.version, voiceInstructions: this._cachedProfile.voiceInstructions, generatedAt: this._cachedProfile.generatedAt }
      : null;

    await collection.updateOne(
      { profileId: profile.profileId },
      {
        $set: {
          ...profile,
          previousVersion,
          updatedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );

    this._cachedProfile = profile;
  }

  /**
   * Load latest profile from MongoDB
   * @returns {Promise<Object|null>}
   */
  async _loadProfile() {
    const collection = this.mongoService.db.collection('voice_profiles');
    return collection.findOne(
      { profileId: 'channel_voice_v1' },
      { sort: { version: -1 } }
    );
  }

  /**
   * Fisher-Yates shuffle
   * @param {Array} array
   * @returns {Array}
   */
  _shuffleArray(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

module.exports = VoiceProfileService;
