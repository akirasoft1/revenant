// config/config.js
const dotenv = require('dotenv');
// quiet: true suppresses dotenv's default logging in v17+
// We use Winston for logging instead
dotenv.config({ quiet: true });


// Validate required environment variables
const requiredEnvVars = ['DISCORD_TOKEN', 'OPENAI_API_KEY', 'MONGO_URI'];
const missing = requiredEnvVars.filter(v => !process.env[v]);

if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('Please check your .env file');
  process.exit(1);
}

// Optional environment variables with defaults
const optionalEnvVars = {
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
  OPENAI_METHOD: 'completion',
  OPENAI_MODEL: 'gpt-4.1-mini',
  DEBUG: 'false'
};

// Log warnings for optional vars if needed
Object.entries(optionalEnvVars).forEach(([key, defaultValue]) => {
  if (!process.env[key]) {
    console.warn(`Optional env var ${key} not set, using default: ${defaultValue}`);
  }
});

const mongoUri = process.env.MONGO_URI.replace('${MONGO_PASSWORD}', process.env.MONGO_PASSWORD);

module.exports = {
  agent: {
    enabled: process.env.AGENT_ENABLED !== 'false',
    address: process.env.AGENT_GRPC_ADDR || 'discord-article-bot-agent.discord-article-bot.svc.cluster.local:50051',
    healthIntervalMs: parseInt(process.env.AGENT_HEALTH_INTERVAL_MS || '5000', 10),
    unhealthyThresholdMs: parseInt(process.env.AGENT_UNHEALTHY_THRESHOLD_MS || '30000', 10),
  },
  voice: {
    enabled: process.env.VOICE_ENABLED === 'true',
    address: process.env.VOICE_GRPC_ADDR || 'discord-article-bot-voice.discord-article-bot.svc.cluster.local:50051',
    wakeWord: process.env.VOICE_WAKE_WORD || 'hey jarvis',
    liveVoice: process.env.VOICE_LIVE_VOICE || 'Puck',
    // openWakeWord ONNX models (keyless, offline). Vendored under models/openwakeword/.
    wakeModel: process.env.VOICE_WAKE_MODEL || require('path').join(__dirname, '..', 'models', 'openwakeword', 'hey_jarvis_v0.1.onnx'),
    melModel: process.env.VOICE_MEL_MODEL || require('path').join(__dirname, '..', 'models', 'openwakeword', 'melspectrogram.onnx'),
    embeddingModel: process.env.VOICE_EMBEDDING_MODEL || require('path').join(__dirname, '..', 'models', 'openwakeword', 'embedding_model.onnx'),
    wakeThreshold: parseFloat(process.env.VOICE_WAKE_THRESHOLD || '0.5'),
    followupWindowMs: parseInt(process.env.VOICE_FOLLOWUP_WINDOW_MS || '15000', 10),
    idleTimeoutMs: parseInt(process.env.VOICE_IDLE_TIMEOUT_MS || '120000', 10),
    maxSessions: parseInt(process.env.VOICE_MAX_SESSIONS || '2', 10),
    maxSessionSeconds: parseInt(process.env.VOICE_MAX_SESSION_SECONDS || '600', 10),
    // How long (ms) after the user's last real-speech frame to signal
    // audio_stream_end so the Live model finalizes the turn. Lower = snappier
    // replies but risks cutting off long thinking pauses; higher = more
    // forgiving. NOTE: once a turn opens, frames now stream continuously
    // (Silero VAD gate; no energy-gate dropping) so Gemini's server VAD always
    // sees real silence too. The PRIMARY early endpointer is Silero's
    // `justEnded` firing audio_stream_end as soon as neural speech-end is
    // detected (see VoiceService._handleUserPcm); this timer is the BACKSTOP
    // that fires if that early path didn't (e.g. no session yet).
    speechEndSilenceMs: parseInt(process.env.VOICE_SPEECH_END_SILENCE_MS || '800', 10),
    // Silero VAD (per-stream neural speech detection; replaces the fixed energy
    // gate). Frames <threshold are non-speech. min*Frames are 32ms windows.
    vad: {
      threshold: parseFloat(process.env.VOICE_VAD_THRESHOLD || '0.5'),
      minSpeechFrames: parseInt(process.env.VOICE_VAD_MIN_SPEECH_FRAMES || '2', 10),   // ~64ms
      minSilenceFrames: parseInt(process.env.VOICE_VAD_MIN_SILENCE_FRAMES || '24', 10), // ~768ms
      modelPath: process.env.VOICE_VAD_MODEL || require('path').join(__dirname, '..', 'models', 'silero', 'silero_vad.onnx'),
    },
    // Allow barge-in (interrupting the bot mid-reply). Default false = half-duplex
    // (mic muted while the bot talks). true = full-duplex: real speech interrupts
    // the reply; the Silero VAD gate still blocks ambient from false-triggering it.
    // Safe for most users — Discord's client runs WebRTC AEC + Krisp on by
    // default, so the bot's own voice is cancelled from a user's mic before it
    // reaches us. Residual risk is narrow: users who disabled Discord's echo
    // cancellation, or a separate speaker path Discord can't see. Headphones are
    // belt-and-suspenders, not a requirement.
    allowBargeIn: process.env.VOICE_ALLOW_BARGE_IN === 'true',
    // Client-side endpointing (Gemini "Hybrid VAD"): send an explicit
    // audio_stream_end when our Silero VAD declares end-of-speech, instead of
    // waiting on Gemini's server-side silence detection.
    //
    // DEFAULT OFF: endpointing is handled ENTIRELY by Gemini's automatic VAD,
    // which matches Google's own Live API examples -- they stream audio with
    // send_realtime_input and NEVER send audio_stream_end, tuning the server
    // VAD instead. Set VOICE_CLIENT_ENDPOINTING=true to re-enable ours. Since
    // Phase 1 we stream trailing silence continuously, so the server VAD can
    // now finalize on its own -- and doing BOTH makes it finalize the same
    // utterance twice, which surfaces as the model transcribing and answering
    // one question two or three times (observed live: 31.9s of reply audio for
    // a ~10s answer, and in_tx_chars counting the phrase twice).
    clientEndpointing: process.env.VOICE_CLIENT_ENDPOINTING === 'true',

    systemPrompt: process.env.VOICE_SYSTEM_PROMPT || '',

    // userId -> spoken name overrides, e.g. {"1616...":"Mike"}. Authoritative:
    // Discord's own name layers are unreliable here (see spec 5.4.1). Malformed
    // JSON must never take the bot down -- fall back to an empty table.
    speakerNames: (() => {
      try { return JSON.parse(process.env.VOICE_SPEAKER_NAMES || '{}'); }
      catch (e) {
        // Fail-closed (empty table), but SAY SO -- a typo'd JSON blob must not
        // silently present as "my overrides just don't work". The logger
        // isn't guaranteed to be initialized yet at config-load time, so use
        // console.warn here.
        console.warn(`VOICE_SPEAKER_NAMES is not valid JSON; ignoring it and using no overrides: ${e.message}`);
        return {};
      }
    })(),

    // Phase 4 deferral: acknowledge a speaker who interjected while someone
    // else held the floor. Default OFF -- the qualification threshold below is
    // meant to be set from the measurement logging before this is flipped on.
    deferralEnabled: process.env.VOICE_DEFERRAL_ENABLED === 'true',
    // How much VAD-detected speech a withheld speaker must produce before they
    // are worth announcing. Filters coughs, one-word backchannels and any echo
    // that survives Discord's client-side AEC.
    deferralMinSpeechMs: parseInt(process.env.VOICE_DEFERRAL_MIN_SPEECH_MS || '700', 10),
  },
  discord: {
    token: process.env.DISCORD_TOKEN,
    // Application/Client ID for slash command registration
    clientId: process.env.DISCORD_CLIENT_ID || '',
    // Optional: Guild ID for development (instant command updates)
    testGuildId: process.env.DISCORD_TEST_GUILD_ID || '',
    intents: ['Guilds', 'GuildMessages', 'GuildMessageReactions', 'MessageContent'],
    // Bot admin user IDs (comma-separated) - these users can run admin commands
    adminUserIds: process.env.BOT_ADMIN_USER_IDS ? process.env.BOT_ADMIN_USER_IDS.split(',').map(id => id.trim()) : []
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || optionalEnvVars.OPENAI_BASE_URL,
    method: process.env.OPENAI_METHOD || optionalEnvVars.OPENAI_METHOD,
    model: process.env.OPENAI_MODEL || optionalEnvVars.OPENAI_MODEL
  },
  bot: {
    maxSummaryLength: 1500,
    systemPromptFile: 'prompt.txt',
    factChecker: {
      enabled: process.env.FACT_CHECKER_ENABLED === 'true' || true,
      questionableSources: process.env.QUESTIONABLE_SOURCES ? process.env.QUESTIONABLE_SOURCES.split(',') : []
    },
    sourceCredibility: {
      enabled: process.env.SOURCE_CREDIBILITY_ENABLED === 'true' || true,
      trustedSources: process.env.TRUSTED_SOURCES ? JSON.parse(process.env.TRUSTED_SOURCES) : {}
    },
    rssFeeds: {
      enabled: process.env.RSS_FEEDS_ENABLED === 'true' || false,
      intervalMinutes: parseInt(process.env.RSS_INTERVAL_MINUTES || '60', 10),
      feeds: process.env.RSS_FEEDS ? JSON.parse(process.env.RSS_FEEDS) : []
    },
    followUpTracker: {
      enabled: process.env.FOLLOW_UP_TRACKER_ENABLED === 'true' || false,
      intervalMinutes: parseInt(process.env.FOLLOW_UP_INTERVAL_MINUTES || '1440', 10) // Default to 24 hours
    },
    summaryStyles: {
      enabled: process.env.SUMMARY_STYLES_ENABLED === 'true' || true,
      styles: {
        pirate: "Summarize this article in the style of a pirate.",
        shakespeare: "Summarize this article in the style of William Shakespeare.",
        genz: "Summarize this article using Gen Z slang and internet culture references.",
        academic: "Summarize this article in a formal, academic tone, suitable for a research paper."
      }
    },
    moodBasedSummaries: {
      enabled: process.env.MOOD_BASED_SUMMARIES_ENABLED === 'true' || true,
      moods: {
        monday: "Summarize this article in a serious and formal tone.",
        friday: "Summarize this article in a cheerful and lighthearted tone.",
        neutral: "Summarize this article in a neutral and objective tone."
      },
      defaultMood: "neutral"
    },
    celebrityNarrators: {
      enabled: process.env.CELEBRITY_NARRATORS_ENABLED === 'true' || true,
      narrators: {
        gordon_ramsay: "Summarize this article as if Gordon Ramsay is narrating, with his characteristic intensity and expletives (bleeped, of course).",
        shakespeare: "Summarize this article as if William Shakespeare is narrating, using Elizabethan language and dramatic flair.",
        morgan_freeman: "Summarize this article as if Morgan Freeman is narrating, with his calm, authoritative, and deep voice."
      }
    },
    historicalPerspectives: {
      enabled: process.env.HISTORICAL_PERSPECTIVES_ENABLED === 'true' || true,
      perspectives: {
        '1950s': "Summarize this article as if it were being reported in the 1950s, using language and cultural references from that era.",
        'victorian': "Summarize this article as if it were being reported in the Victorian era, with formal language and a focus on societal norms.",
        'ancient_rome': "Summarize this article as if it were being discussed in Ancient Rome, focusing on aspects relevant to Roman citizens and using appropriate terminology."
      }
    },
    biasDetection: {
      enabled: process.env.BIAS_DETECTION_ENABLED === 'true' || false,
      threshold: parseFloat(process.env.BIAS_THRESHOLD || '0.7'), // Example threshold
      types: process.env.BIAS_TYPES ? process.env.BIAS_TYPES.split(',') : ['political', 'gender', 'racial', 'corporate']
    },
    alternativePerspectives: {
      enabled: process.env.ALTERNATIVE_PERSPECTIVES_ENABLED === 'true' || false,
      perspectives: {
        liberal: "Summarize this article from a liberal viewpoint.",
        conservative: "Summarize this article from a conservative viewpoint.",
        environmentalist: "Summarize this article from an environmentalist viewpoint.",
        economic: "Summarize this article from an economic viewpoint."
      }
    },
    contextProvider: {
      enabled: process.env.CONTEXT_PROVIDER_ENABLED === 'true' || false,
      minKeywords: parseInt(process.env.CONTEXT_MIN_KEYWORDS || '3', 10),
      prompt: "Provide a brief historical or background context for the following topic/keywords: "
    },
    autoTranslation: {
      enabled: process.env.AUTO_TRANSLATION_ENABLED === 'true' || true,
      targetLanguage: process.env.AUTO_TRANSLATION_TARGET_LANGUAGE || 'English',
      supportedLanguages: process.env.AUTO_TRANSLATION_SUPPORTED_LANGUAGES ? process.env.AUTO_TRANSLATION_SUPPORTED_LANGUAGES.split(',') : ['English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese']
    },
    languageLearning: {
      enabled: process.env.LANGUAGE_LEARNING_ENABLED === 'true' || true,
      targetLanguages: process.env.LANGUAGE_LEARNING_TARGET_LANGUAGES ? process.env.LANGUAGE_LEARNING_TARGET_LANGUAGES.split(',') : ['Spanish', 'French'],
      presentationStyle: process.env.LANGUAGE_LEARNING_PRESENTATION_STYLE || 'side-by-side' // 'side-by-side', 'alternating'
    },
    culturalContext: {
      enabled: process.env.CULTURAL_CONTEXT_ENABLED === 'true' || true,
      contexts: {
        japanese: "Summarize this article with a focus on Japanese cultural nuances and perspectives.",
        indian: "Summarize this article with a focus on Indian cultural nuances and perspectives.",
        western: "Summarize this article with a focus on Western cultural nuances and perspectives."
      }
    }
  },
  debug: process.env.DEBUG === 'true',
  mongo: {
    uri: mongoUri
  },
  // Linkwarden integration for self-hosted article archiving
  // Replaces the non-functional archive.today integration
  linkwarden: {
    // Enable/disable Linkwarden integration
    enabled: process.env.LINKWARDEN_ENABLED === 'true',
    // Base URL of your Linkwarden instance (e.g., https://links.example.com)
    baseUrl: process.env.LINKWARDEN_URL || 'http://localhost:3000',
    // External URL for user-facing links (e.g., https://linkwarden.aklabs.io)
    externalUrl: process.env.LINKWARDEN_EXTERNAL_URL || process.env.LINKWARDEN_URL || 'http://localhost:3000',
    // API token from Linkwarden (Settings -> Access Tokens)
    apiToken: process.env.LINKWARDEN_API_TOKEN || '',
    // Collection ID to monitor for new links (the "Discord Share" collection)
    sourceCollectionId: parseInt(process.env.LINKWARDEN_SOURCE_COLLECTION_ID || '0', 10),
    // Tag name to mark links as posted (will be created if it doesn't exist)
    postedTagName: process.env.LINKWARDEN_POSTED_TAG_NAME || 'posted',
    // Discord channel ID where archived articles will be posted
    discordChannelId: process.env.LINKWARDEN_DISCORD_CHANNEL_ID || '',
    // How often to poll Linkwarden for new links (in milliseconds)
    pollIntervalMs: parseInt(process.env.LINKWARDEN_POLL_INTERVAL_MS || '60000', 10)
  },
  // Imagen (Nano Banana) - Google Gemini image generation
  imagen: {
    // Enable/disable image generation
    enabled: process.env.IMAGEGEN_ENABLED === 'true',
    // Gemini API key for image generation
    apiKey: process.env.GEMINI_API_KEY || '',
    // Model to use for image generation
    // Options: 'gemini-3-pro-image-preview' (preferred), 'gemini-2.5-flash-image' (fallback)
    model: process.env.IMAGEGEN_MODEL || 'gemini-2.5-flash-image',
    // Premium model for admin users (BOT_ADMIN_USER_IDS) - falls back to standard model if not set
    adminModel: process.env.IMAGEGEN_ADMIN_MODEL || '',
    // Default aspect ratio for generated images
    // Options: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9
    defaultAspectRatio: process.env.IMAGEGEN_DEFAULT_ASPECT_RATIO || '1:1',
    // Maximum prompt length in characters
    maxPromptLength: parseInt(process.env.IMAGEGEN_MAX_PROMPT_LENGTH || '1000', 10),
    // Cooldown between image generations per user (in seconds)
    cooldownSeconds: parseInt(process.env.IMAGEGEN_COOLDOWN_SECONDS || '30', 10),
    // Auto-retry with simplified prompt on failure (skips safety blocks)
    autoRetry: process.env.IMAGEGEN_AUTO_RETRY !== 'false' // default true
  },
  // Veo - Google Vertex AI video generation (first & last frame)
  veo: {
    // Enable/disable video generation
    enabled: process.env.VEO_ENABLED === 'true',
    // Google Cloud project ID for Vertex AI
    projectId: process.env.GOOGLE_CLOUD_PROJECT || '',
    // Google Cloud location for Vertex AI
    location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
    // Model to use for video generation
    // Options: 'veo-3.1-fast-generate-001' (fast), 'veo-3.1-generate-001' (quality)
    model: process.env.VEO_MODEL || 'veo-3.1-fast-generate-001',
    // GCS bucket for storing generated videos (must be in same region as Vertex AI)
    gcsBucket: process.env.VEO_GCS_BUCKET || '',
    // Default video duration in seconds (4, 6, or 8)
    defaultDuration: parseInt(process.env.VEO_DEFAULT_DURATION || '8', 10),
    // Default aspect ratio for generated videos (16:9 or 9:16)
    defaultAspectRatio: process.env.VEO_DEFAULT_ASPECT_RATIO || '16:9',
    // Maximum prompt length in characters
    maxPromptLength: parseInt(process.env.VEO_MAX_PROMPT_LENGTH || '1000', 10),
    // Cooldown between video generations per user (in seconds)
    cooldownSeconds: parseInt(process.env.VEO_COOLDOWN_SECONDS || '60', 10),
    // Maximum time to wait for video generation (in seconds)
    maxWaitSeconds: parseInt(process.env.VEO_MAX_WAIT_SECONDS || '300', 10),
    // Polling interval for checking operation status (in milliseconds)
    pollIntervalMs: parseInt(process.env.VEO_POLL_INTERVAL_MS || '5000', 10)
  },
  // Lyria 3 - Google Gemini music generation
  lyria: {
    // Enable/disable music generation
    enabled: process.env.MUSICGEN_ENABLED === 'true',
    // Gemini API key (falls back to GEMINI_API_KEY since they are the same credential)
    apiKey: process.env.LYRIA_API_KEY || process.env.GEMINI_API_KEY || '',
    // Model to use. Pro is the only supported option today.
    model: process.env.LYRIA_MODEL || 'lyria-3-pro-preview',
    // Max reference images per request (Discord slash command exposes 3 slots)
    maxImagesPerRequest: 3,
    // Max prompt / lyrics / negative-prompt lengths
    maxPromptLength: parseInt(process.env.LYRIA_MAX_PROMPT_LENGTH || '1000', 10),
    maxLyricsLength: parseInt(process.env.LYRIA_MAX_LYRICS_LENGTH || '2000', 10),
    maxNegativePromptLength: parseInt(process.env.LYRIA_MAX_NEGATIVE_PROMPT_LENGTH || '500', 10),
    // Cooldown between music generations per user (in seconds)
    cooldownSeconds: parseInt(process.env.LYRIA_COOLDOWN_SECONDS || '60', 10),
    // Per-call flat cost (USD) used to seed CostService.mediaPricing override at runtime
    perCallCostUsd: parseFloat(process.env.LYRIA_PER_CALL_COST_USD || '0.06')
  },
  // ElevenLabs - music generation via @elevenlabs/elevenlabs-js
  elevenlabs: {
    enabled: process.env.ELEVENMUSIC_ENABLED === 'true',
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    model: process.env.ELEVENLABS_MUSIC_MODEL || 'music_v1',
    defaultDurationSeconds: parseInt(process.env.ELEVENLABS_DEFAULT_DURATION_SECONDS || '90', 10),
    cooldownSeconds: parseInt(process.env.ELEVENLABS_COOLDOWN_SECONDS || '60', 10),
    perCallCostUsd: parseFloat(process.env.ELEVENLABS_PER_CALL_COST_USD || '0.10'),
  },
  // Mem0 - Persistent AI conversation memory
  mem0: {
    // Enable/disable Mem0 memory service
    enabled: process.env.MEM0_ENABLED === 'true',
    // Qdrant host for vector storage
    qdrantHost: process.env.MEM0_QDRANT_HOST || 'qdrant.discord-article-bot.svc.cluster.local',
    // Qdrant port
    qdrantPort: parseInt(process.env.MEM0_QDRANT_PORT || '6333', 10),
    // Collection name for memories
    collectionName: process.env.MEM0_COLLECTION_NAME || 'discord_memories',
    // OpenAI API key (uses the main one if not specified)
    openaiApiKey: process.env.MEM0_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
    // LLM model for memory extraction (use cheap model)
    llmModel: process.env.MEM0_LLM_MODEL || 'gpt-4o-mini',
    // Embedding model
    embeddingModel: process.env.MEM0_EMBEDDING_MODEL || 'text-embedding-3-small'
  },
  // Qdrant - IRC history vector search
  qdrant: {
    // Enable/disable IRC history search
    enabled: process.env.QDRANT_IRC_ENABLED === 'true',
    // Qdrant host
    host: process.env.QDRANT_HOST || 'qdrant.discord-article-bot.svc.cluster.local',
    // Qdrant port
    port: parseInt(process.env.QDRANT_PORT || '6333', 10),
    // Collection name for IRC history
    collection: process.env.QDRANT_IRC_COLLECTION || 'irc_history'
  },
  // Channel Context - Passive conversation awareness for opt-in channels
  channelContext: {
    // Enable/disable channel context tracking
    enabled: process.env.CHANNEL_CONTEXT_ENABLED === 'true',
    // Pre-configured channel IDs to track (comma-separated, loaded on startup)
    preConfiguredChannels: process.env.CHANNEL_CONTEXT_CHANNELS
      ? process.env.CHANNEL_CONTEXT_CHANNELS.split(',').map(id => id.trim()).filter(Boolean)
      : [],
    // Number of recent messages to keep in memory per channel (Tier 1: hot)
    recentMessageCount: parseInt(process.env.CHANNEL_CONTEXT_RECENT_COUNT || '20', 10),
    // Number of buffered messages to inject into the chat prompt's "recent
    // channel conversation" tier. Must be ≤ recentMessageCount (the buffer
    // cap). Defaults to 10 to preserve previous behavior.
    promptRecentCount: parseInt(process.env.CHANNEL_CONTEXT_PROMPT_RECENT_COUNT || '10', 10),
    // Batch indexing interval in minutes (Tier 2: warm)
    batchIndexIntervalMinutes: parseInt(process.env.CHANNEL_CONTEXT_BATCH_INTERVAL || '60', 10),
    // Retention period in days for indexed messages
    retentionDays: parseInt(process.env.CHANNEL_CONTEXT_RETENTION_DAYS || '30', 10),
    // Qdrant collection name for channel messages
    qdrantCollection: process.env.CHANNEL_CONTEXT_QDRANT_COLLECTION || 'channel_conversations',
    // Score threshold for semantic search (0.0-1.0)
    searchScoreThreshold: parseFloat(process.env.CHANNEL_CONTEXT_SEARCH_THRESHOLD || '0.4'),
    // Maximum messages to retrieve via semantic search
    semanticSearchLimit: parseInt(process.env.CHANNEL_CONTEXT_SEARCH_LIMIT || '5', 10),
    // Enable channel-level Mem0 memory extraction (Tier 3: cold)
    extractChannelMemories: process.env.CHANNEL_CONTEXT_EXTRACT_MEMORIES === 'true',
    // Interval for memory extraction (number of messages between extractions)
    memoryExtractionInterval: parseInt(process.env.CHANNEL_CONTEXT_MEMORY_INTERVAL || '50', 10)
  },
  // Recall - centralized, ranked memory retrieval (spec 2026-05-30)
  recall: {
    enabled: process.env.RECALL_V2_ENABLED === 'true',
    shadowEnabled: process.env.RECALL_SHADOW_ENABLED === 'true',
    shadowInject: process.env.RECALL_SHADOW_INJECT || 'old', // 'old' | 'new'
    perSourceLimit: parseInt(process.env.RECALL_PER_SOURCE_LIMIT || '10', 10),
    maxItems: parseInt(process.env.RECALL_MAX_ITEMS || '8', 10),
    tokenBudget: parseInt(process.env.RECALL_TOKEN_BUDGET || '600', 10),
    promptMaxTokens: parseInt(process.env.RECALL_PROMPT_MAX_TOKENS || '4000', 10),
    halfLifeDays: parseFloat(process.env.RECALL_HALF_LIFE_DAYS || '14'),
    accessBoostAlpha: parseFloat(process.env.RECALL_ACCESS_BOOST_ALPHA || '0.1'),
    importanceSeed: parseFloat(process.env.RECALL_IMPORTANCE_SEED || '0.5'),
    importanceSeedExplicit: parseFloat(process.env.RECALL_IMPORTANCE_SEED_EXPLICIT || '0.7'),
    importanceNudge: parseFloat(process.env.RECALL_IMPORTANCE_NUDGE || '0.02'),
    importanceMax: parseFloat(process.env.RECALL_IMPORTANCE_MAX || '1.0'),
    queryStrategy: process.env.RECALL_QUERY_STRATEGY || 'recent-window', // last-message | recent-window | llm-condense
    queryWindow: parseInt(process.env.RECALL_QUERY_WINDOW || '3', 10),
    sourceWeights: {
      'mem0:explicit': parseFloat(process.env.RECALL_W_EXPLICIT || '1.3'),
      'mem0:shared': parseFloat(process.env.RECALL_W_SHARED || '1.1'),
      'channel:facts': parseFloat(process.env.RECALL_W_CHANNEL_FACTS || '1.0'),
      'mem0:personal': parseFloat(process.env.RECALL_W_PERSONAL || '1.0'),
      'channel:semantic': parseFloat(process.env.RECALL_W_CHANNEL_SEMANTIC || '0.8'),
    },
  },
  // Voice Profile - dynamic style learning from channel history
  voiceProfile: {
    enabled: process.env.VOICE_PROFILE_ENABLED === 'true',
    regenIntervalHours: parseInt(process.env.VOICE_PROFILE_REGEN_HOURS || '24', 10),
    samplesPerDecade: parseInt(process.env.VOICE_PROFILE_SAMPLES_PER_DECADE || '50', 10),
    discordSampleSize: parseInt(process.env.VOICE_PROFILE_DISCORD_SAMPLES || '100', 10),
    analysisModel: process.env.VOICE_PROFILE_ANALYSIS_MODEL || 'gpt-4.1-mini',
    abLogging: process.env.VOICE_PROFILE_AB_LOGGING === 'true',
  },
  // Local LLM - Ollama integration for uncensored chat mode
  localLlm: {
    // Enable/disable local LLM service
    enabled: process.env.LOCAL_LLM_ENABLED === 'true',
    // Ollama API endpoint (OpenAI-compatible)
    baseUrl: process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434/v1',
    // Model to use for local inference
    model: process.env.LOCAL_LLM_MODEL || 'dolphin-llama3:8b-v2.9-fp16',
    // API key (Ollama doesn't require a real key, but OpenAI client needs one)
    apiKey: process.env.LOCAL_LLM_API_KEY || 'ollama',
    // Model parameters
    temperature: parseFloat(process.env.LOCAL_LLM_TEMPERATURE || '0.8'),
    topP: parseFloat(process.env.LOCAL_LLM_TOP_P || '0.95'),
    maxTokens: parseInt(process.env.LOCAL_LLM_MAX_TOKENS || '2048', 10),
    // Max response length in characters (0 = no limit). Truncates overly verbose responses.
    maxResponseLength: parseInt(process.env.LOCAL_LLM_MAX_RESPONSE_LENGTH || '500', 10),
    // Uncensored mode settings
    uncensored: {
      // Enable/disable uncensored mode globally
      enabled: process.env.UNCENSORED_MODE_ENABLED === 'true',
      // Allowed channel IDs (empty = all channels allowed)
      allowedChannels: process.env.UNCENSORED_ALLOWED_CHANNELS
        ? process.env.UNCENSORED_ALLOWED_CHANNELS.split(',').map(id => id.trim()).filter(Boolean)
        : [],
      // Blocked channel IDs (takes precedence over allowed)
      blockedChannels: process.env.UNCENSORED_BLOCKED_CHANNELS
        ? process.env.UNCENSORED_BLOCKED_CHANNELS.split(',').map(id => id.trim()).filter(Boolean)
        : [],
      // Allowed user IDs (empty = all users allowed)
      allowedUsers: process.env.UNCENSORED_ALLOWED_USERS
        ? process.env.UNCENSORED_ALLOWED_USERS.split(',').map(id => id.trim()).filter(Boolean)
        : [],
      // Require Discord NSFW channel flag
      requireNsfw: process.env.UNCENSORED_REQUIRE_NSFW === 'true'
    }
  },
  // Health check server configuration for Kubernetes probes
  health: {
    // Enable/disable health check server
    enabled: process.env.HEALTH_SERVER_ENABLED !== 'false', // Enabled by default
    // Port for health check server
    port: parseInt(process.env.HEALTH_SERVER_PORT || '8080', 10)
  }
};