// bot.js - Cleaned up version
// IMPORTANT: Tracing must be initialized FIRST before any other modules
// to ensure all HTTP calls and operations are properly instrumented
require('./tracing');

const http = require('http');
const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
const OpenAI = require('openai');
const fs = require('fs').promises;
const config = require('./config/config');
const logger = require('./logger');
const { shutdownTracing, withRootSpan } = require('./tracing');
const SummarizationService = require('./services/SummarizationService');
const ReactionHandler = require('./handlers/ReactionHandler');
const ReplyHandler = require('./handlers/ReplyHandler');
const RssService = require('./services/RssService');
const FollowUpService = require('./services/FollowUpService');
const MessageService = require('./services/MessageService');
const LinkwardenService = require('./services/LinkwardenService');
const LinkwardenPollingService = require('./services/LinkwardenPollingService');
const ChatService = require('./services/ChatService');
const AgentClient = require('./services/AgentClient');
const SandboxTraceService = require('./services/SandboxTraceService');
const ImagenService = require('./services/ImagenService');
const VeoService = require('./services/VeoService');
const LyriaService = require('./services/LyriaService');
const ElevenLabsMusicService = require('./services/ElevenLabsMusicService');
const CostService = require('./services/CostService');
const Mem0Service = require('./services/Mem0Service');
const QdrantService = require('./services/QdrantService');
const NickMappingService = require('./services/NickMappingService');
const ChannelContextService = require('./services/ChannelContextService');
const { createSpeakerNames } = require('./services/SpeakerNames');
const ImagePromptAnalyzerService = require('./services/ImagePromptAnalyzerService');
const CatchMeUpService = require('./services/CatchMeUpService');
const VoiceSearchService = require('./services/VoiceSearchService');
const MongoService = require('./services/MongoService');
const RecallService = require('./services/RecallService');
const ImageRetryHandler = require('./handlers/ImageRetryHandler');
const TextUtils = require('./utils/textUtils');
const localLlmService = require('./services/LocalLlmService');
const personalityManager = require('./personalities');

const { version } = require('./package.json');

// Import slash command infrastructure
const SlashCommandHandler = require('./handlers/SlashCommandHandler');
const {
  ChatSlashCommand,
  ChatThreadSlashCommand,
  ChatResetSlashCommand,
  ChatResumeSlashCommand,
  ChatListSlashCommand,
  SummarizeSlashCommand,
  ResummarizeSlashCommand,
  ImagineSlashCommand,
  VideogenSlashCommand,
  MusicgenSlashCommand,
  ElevenmusicSlashCommand,
  MemoriesSlashCommand,
  RememberSlashCommand,
  ForgetSlashCommand,
  RecallSlashCommand,
  HistorySlashCommand,
  ThrowbackSlashCommand,
  CatchMeUpSlashCommand,
  StatsSlashCommand,
  HelpSlashCommand,
  ContextSlashCommand,
  ChannelTrackSlashCommand,
  ObserveSlashCommand
} = require('./commands/slash');

class DiscordBot {
  constructor() {
    logger.info(`Creating DiscordBot v${version} instance`);
    logger.info(`OpenAI API Key: ${config.openai.apiKey ? 'Loaded' : 'Not Loaded'}`);

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
      ],
      partials: [
        Partials.Message,
        Partials.Reaction,
        Partials.User
      ]
    });

    this.openaiClient = new OpenAI({
      apiKey: config.openai.apiKey,
      baseURL: config.openai.baseURL,
    });

    // Core services - MongoService is a top-level dependency
    this.mongoService = new MongoService(config.mongo.uri);
    this.messageService = new MessageService(this.openaiClient);
    this.summarizationService = new SummarizationService(this.openaiClient, config, this.client, this.messageService, this.mongoService);
    // SandboxTraceService is initialized lazily after Mongo connects (this.mongoService.db
    // is null until then). The first reaction reveal will fetch traces directly from Mongo.
    this.sandboxTraceService = null;
    this.reactionHandler = new ReactionHandler(
      this.summarizationService,
      this.mongoService,
      null, // wired after Mongo connects, see _ensureSandboxTraceService
    );
    this.rssService = new RssService(this.mongoService, this.summarizationService, this.client);
    this.followUpService = new FollowUpService(this.mongoService, this.summarizationService, this.client);

    // Initialize Mem0 (AI memory) service if enabled
    this.mem0Service = null;
    if (config.mem0?.enabled) {
      try {
        this.mem0Service = new Mem0Service(config);
        logger.info('Mem0 (AI memory) service initialized');
      } catch (error) {
        logger.warn(`Failed to initialize Mem0 service: ${error.message}`);
      }
    } else {
      logger.info('Mem0 (AI memory) is disabled');
    }

    // Initialize IRC history services (Qdrant + nick mapping)
    this.qdrantService = null;
    this.nickMappingService = null;
    if (config.qdrant?.enabled) {
      try {
        this.qdrantService = new QdrantService(this.openaiClient, config);
        this.nickMappingService = new NickMappingService();
        logger.info('IRC history services initialized (Qdrant + NickMapping)');
      } catch (error) {
        logger.warn(`Failed to initialize IRC history services: ${error.message}`);
      }
    } else {
      logger.info('IRC history search is disabled');
    }

    // Shared preferred-name resolver (services/SpeakerNames.js) — pure JS, no
    // native deps, so it's safe to build unconditionally (unlike voice's
    // native-dependent bits, which stay lazily required behind VOICE_ENABLED
    // below). One instance is reused by ChannelContextService (chat/recall)
    // and by VoiceService (voice) so both paths resolve the same names.
    this.speakerNames = createSpeakerNames({ overrides: config.voice.speakerNames });

    // Initialize Channel Context service for passive conversation awareness
    this.channelContextService = null;
    if (config.channelContext?.enabled) {
      try {
        this.channelContextService = new ChannelContextService(
          config,
          this.openaiClient,
          this.mongoService,
          this.mem0Service,
          config.discord?.clientId,
          this.speakerNames
        );
        logger.info('Channel context service initialized (pending start)');
      } catch (error) {
        logger.warn(`Failed to initialize Channel context service: ${error.message}`);
      }
    } else {
      logger.info('Channel context tracking is disabled');
    }

    // Initialize Voice Profile service for dynamic style learning
    this.voiceProfileService = null;
    if (config.voiceProfile?.enabled && this.qdrantService && this.channelContextService) {
      try {
        const VoiceProfileService = require('./services/VoiceProfileService');
        this.voiceProfileService = new VoiceProfileService(
          this.openaiClient,
          config,
          this.mongoService,
          this.qdrantService,
          this.channelContextService
        );
        logger.info('Voice profile service initialized');
      } catch (error) {
        logger.warn(`Failed to initialize Voice profile service: ${error.message}`);
      }
    } else if (config.voiceProfile?.enabled) {
      logger.warn('Voice profile requires both Qdrant and Channel Context services enabled');
    }

    // AgentClient - gRPC stub for the Python agent sidecar. When the sidecar
    // is unreachable or AGENT_ENABLED=false, ChatService falls through to the
    // existing direct-OpenAI path so the bot keeps working.
    this.agentClient = null;
    if (config.agent && config.agent.enabled) {
      try {
        this.agentClient = new AgentClient({
          address: config.agent.address,
          protoPath: require('path').join(__dirname, 'proto', 'agent.proto'),
          healthIntervalMs: config.agent.healthIntervalMs,
          unhealthyThresholdMs: config.agent.unhealthyThresholdMs,
        });
        logger.info(`AgentClient initialized -> ${config.agent.address}`);
      } catch (e) {
        logger.warn(`AgentClient init failed (continuing without sidecar): ${e.message}`);
        this.agentClient = null;
      }
    }

    // RecallService - centralized ranked recall (v2 memory path)
    this.recallService = new RecallService({
      mem0Service: this.mem0Service,
      channelContextService: this.channelContextService,
      mongoService: this.mongoService,
      config,
      condenser: null, // llm-condense disabled by default
    });

    // ChatService - all dependencies injected via constructor. Constructed
    // here (before VoiceService) so VoiceService can be given a
    // `contextBuilder` bound to `chatService.buildTurnContext`, giving voice
    // sessions the same dynamic channel-voice prompt + memory + history as
    // text chat.
    this.chatService = new ChatService(
      this.openaiClient, config, this.mongoService, this.mem0Service,
      this.channelContextService, this.voiceProfileService, this.qdrantService,
      this.agentClient, this.recallService
    );

    // VoiceClient/VoiceService - live Discord voice channel presence via the
    // Python voice sidecar. Native deps (opus/sodium/onnxruntime-node)
    // are lazily required here so the rest of the bot works even if they
    // aren't installed (e.g. VOICE_ENABLED=false, as in tests/CI).
    this.voiceClient = null;
    this.voiceService = null;
    if (config.voice.enabled) {
      try {
        // Voice sessions should sound like the same bot as channel-voice text
        // chat. Only fill in systemPrompt from the personality if it wasn't
        // already set explicitly via VOICE_SYSTEM_PROMPT.
        if (!config.voice.systemPrompt) {
          const channelVoicePersonality = personalityManager.get('channel-voice');
          if (channelVoicePersonality && channelVoicePersonality.systemPrompt) {
            // channel-voice's systemPrompt contains a {VOICE_INSTRUCTIONS}
            // placeholder that ChatService._buildGroupSystemPrompt normally
            // substitutes with a dynamic per-channel voice profile (or, when
            // none is available, the same static fallback used here). The
            // voice sidecar has no equivalent substitution step, so without
            // this the Live model would receive the literal, unsubstituted
            // "{VOICE_INSTRUCTIONS}" token. Use the identical static fallback
            // string as services/ChatService.js so the two paths don't drift.
            // Dynamic per-channel voice-profile injection for Live sessions
            // remains a documented follow-up.
            config.voice.systemPrompt = channelVoicePersonality.systemPrompt.replace(
              '{VOICE_INSTRUCTIONS}',
              'Be casual, direct, and conversational. Match the energy of the group.'
            );
            logger.info('Voice systemPrompt sourced from channel-voice personality');
          }
        }
        const VoiceClient = require('./services/VoiceClient');
        const VoiceService = require('./services/VoiceService');
        const dv = require('@discordjs/voice');
        // Per-packet Opus decoder (@discordjs/opus) rather than prism-media's
        // stream Transform: VoiceService decodes each received frame in a
        // try/catch so an undecodable frame is dropped instead of throwing an
        // unhandled stream 'error' that crashes the whole bot process.
        const { OpusEncoder } = require('@discordjs/opus');
        const { createOpenWakeWordEngine, WakeWordGate, preloadOpenWakeWord } = require('./services/voice/wakeword');
        const { createSileroVadEngine, VoiceActivityGate, preloadSileroVad } = require('./services/voice/SileroVad');
        // Warn (don't fail) if the wake-phrase label doesn't match the wake model
        // filename, e.g. VOICE_WAKE_WORD="alexa" but VOICE_WAKE_MODEL points at
        // hey_jarvis -> /voice would announce the wrong phrase.
        const wakeLabelSlug = String(config.voice.wakeWord || '').trim().toLowerCase().replace(/\s+/g, '_');
        const wakeModelBase = require('path').basename(String(config.voice.wakeModel || '')).toLowerCase();
        if (wakeLabelSlug && wakeModelBase && !wakeModelBase.includes(wakeLabelSlug)) {
          logger.warn(`voice wake-word label "${config.voice.wakeWord}" does not match wake model file "${wakeModelBase}" — the /voice reply may name the wrong phrase. Set VOICE_WAKE_WORD to match VOICE_WAKE_MODEL.`);
        }
        this.voiceClient = new VoiceClient({
          address: config.voice.address,
          protoPath: require('path').join(__dirname, 'proto', 'voice.proto'),
        });
        this.voiceService = new VoiceService({
          voiceClient: this.voiceClient,
          mongoService: this.mongoService,
          config,
          contextBuilder: (args) => this.chatService.buildTurnContext(args),
          speakerNames: this.speakerNames,
          deps: {
            joinVoiceChannel: dv.joinVoiceChannel,
            createAudioPlayer: dv.createAudioPlayer,
            createAudioResource: dv.createAudioResource,
            StreamType: dv.StreamType,
            EndBehaviorType: dv.EndBehaviorType,
            VoiceConnectionStatus: dv.VoiceConnectionStatus,
            opusDecoderFactory: () => new OpusEncoder(48000, 2),
            makeWakeGate: () => new WakeWordGate(createOpenWakeWordEngine({
              wakeModelPath: config.voice.wakeModel,
              melModelPath: config.voice.melModel,
              embeddingModelPath: config.voice.embeddingModel,
              threshold: config.voice.wakeThreshold,
            })),
            makeVadGate: () => new VoiceActivityGate(
              createSileroVadEngine({ modelPath: config.voice.vad.modelPath }),
              {
                threshold: config.voice.vad.threshold,
                minSpeechFrames: config.voice.vad.minSpeechFrames,
                minSilenceFrames: config.voice.vad.minSilenceFrames,
              },
            ),
            now: () => Date.now(), setInterval, clearInterval,
            getVoiceConnection: dv.getVoiceConnection,
            // Cached-only lookup (no privileged-intent fetch); a cache miss
            // degrades to the override table via { id: userId } in
            // SpeakerNames.resolve.
            lookupUser: (userId) => {
              const u = this.client.users.cache.get(userId);
              return u ? { id: u.id, username: u.username, globalName: u.globalName } : { id: userId };
            },
          },
        });
        logger.info(`VoiceService initialized -> ${config.voice.address}`);

        // Warm the openWakeWord ONNX sessions at boot, off the request path.
        // Root cause of the ~97s /voice join stall: sessions were previously
        // (re)loaded per-join, saturating the bot's 0.5-CPU limit and stalling
        // the event loop long enough to blow Discord's 3s interaction-ack
        // window. createOpenWakeWordEngine's module-level session cache (see
        // services/voice/wakeword.js) means this one-time load is reused by
        // every subsequent `makeWakeGate()` call above. Fire-and-forget --
        // must not block bot startup.
        preloadOpenWakeWord({
          wakeModelPath: config.voice.wakeModel,
          melModelPath: config.voice.melModel,
          embeddingModelPath: config.voice.embeddingModel,
        }).then(() => logger.info('voice: wake-word models preloaded'))
          .catch((e) => logger.warn(`voice: wake-word model preload failed (will load lazily on first join): ${e.message}`));
        preloadSileroVad({ modelPath: config.voice.vad.modelPath }).catch((e) =>
          logger.warn(`voice: Silero VAD preload failed: ${e.message}`));
      } catch (e) {
        logger.error(`voice init failed: ${e.message}`);
        this.voiceClient = null;
        this.voiceService = null;
      }
    } else {
      logger.info('Voice (live voice channel) is disabled');
    }

    // Initialize Imagen (image generation) service
    this.imagenService = null;
    this.imageRetryHandler = null;
    if (config.imagen.enabled && config.imagen.apiKey) {
      try {
        this.imagenService = new ImagenService(config, this.mongoService);
        logger.info('Imagen (image generation) service initialized');

        this.imagePromptAnalyzerService = new ImagePromptAnalyzerService(
          this.openaiClient, config, this.mongoService
        );
        this.imageRetryHandler = new ImageRetryHandler(
          this.imagenService, this.imagePromptAnalyzerService, config
        );
        logger.info('Image prompt analyzer and retry handler initialized');
      } catch (error) {
        logger.warn(`Failed to initialize Imagen service: ${error.message}`);
      }
    } else {
      logger.info('Imagen (image generation) is disabled or API key not configured');
    }

    // ReplyHandler - all dependencies injected via constructor
    this.replyHandler = new ReplyHandler(
      this.chatService, this.summarizationService, this.openaiClient, config, this.imagenService
    );

    // Initialize Linkwarden services for self-hosted article archiving
    this.linkwardenService = null;
    this.linkwardenPollingService = null;
    if (config.linkwarden.enabled) {
      logger.info('Linkwarden integration is enabled');
      this.linkwardenService = new LinkwardenService(config);
      this.linkwardenPollingService = new LinkwardenPollingService(
        this.linkwardenService, this.summarizationService, this.client, config
      );
    }

    // Initialize Veo (video generation) service
    this.veoService = null;
    if (config.veo.enabled && config.veo.projectId && config.veo.gcsBucket) {
      try {
        this.veoService = new VeoService(config, this.mongoService);
        logger.info('Veo (video generation) service initialized');
      } catch (error) {
        logger.warn(`Failed to initialize Veo service: ${error.message}`);
      }
    } else {
      logger.info('Veo (video generation) is disabled or not fully configured');
    }

    // Initialize Lyria (music generation) service
    this.lyriaService = null;
    try {
      if (config.lyria && config.lyria.enabled) {
        this.lyriaService = new LyriaService(config, new CostService());
      }
    } catch (err) {
      logger.error(`Failed to initialize LyriaService: ${err.message}`);
    }

    this.elevenLabsMusicService = null;
    try {
      if (config.elevenlabs && config.elevenlabs.enabled) {
        this.elevenLabsMusicService = new ElevenLabsMusicService(config, new CostService());
      }
    } catch (err) {
      logger.error(`Failed to initialize ElevenLabsMusicService: ${err.message}`);
    }

    // Initialize Local LLM service for uncensored chat mode
    personalityManager.setLocalLlmService(localLlmService);

    if (config.localLlm?.enabled) {
      localLlmService.initialize()
        .then(success => {
          if (success) {
            logger.info('Local LLM service ready for uncensored mode');
            const localLlmPersonalities = personalityManager.list().filter(p => p.useLocalLlm);
            if (localLlmPersonalities.length > 0) {
              logger.info(`Local LLM personalities available: ${localLlmPersonalities.map(p => p.id).join(', ')}`);
            }
          } else {
            logger.warn('Local LLM service failed to initialize - uncensored mode unavailable');
          }
        })
        .catch(error => {
          logger.warn(`Local LLM service initialization error: ${error.message}`);
        });
    } else {
      logger.info('Local LLM (uncensored mode) is disabled');
    }

    // Initialize catch-me-up service
    // Initialize voice-informed search (requires Qdrant + voice profile)
    this.voiceSearchService = null;
    if (this.qdrantService && this.voiceProfileService) {
      this.voiceSearchService = new VoiceSearchService(
        this.qdrantService, this.voiceProfileService, this.openaiClient, config
      );
      logger.info('Voice search service initialized');
    }

    this.catchMeUpService = new CatchMeUpService(
      this.mongoService, this.voiceProfileService, this.openaiClient, config
    );

    // Initialize slash command handler
    this.slashCommandHandler = new SlashCommandHandler(config);
    this.registerSlashCommands();

    // Health server for Kubernetes probes
    this.healthServer = null;

    this.setupEventHandlers();
  }

  async start() {
    try {
      // Start health check server first (so K8s knows we're starting)
      this.startHealthServer();

      logger.info(`Attempting to login with token: ${config.discord.token.substring(0, 10)}...`);
      await this.client.login(config.discord.token);
      logger.info('Bot login successful');
    } catch (error) {
      logger.error('Failed to start bot:', error);
      process.exit(1);
    }
  }

  startHealthServer() {
    if (!config.health.enabled) {
      logger.info('Health server is disabled');
      return;
    }

    const port = config.health.port;

    this.healthServer = http.createServer((req, res) => {
      const isReady = this.client && this.client.isReady();

      if (req.url === '/healthz' || req.url === '/health') {
        // Liveness probe - returns 200 if the process is alive and can handle requests
        // Returns 200 even during startup since the process is healthy, just not ready
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          discordConnected: isReady,
          uptime: process.uptime()
        }));
      } else if (req.url === '/readyz' || req.url === '/ready') {
        // Readiness probe - returns 200 only if Discord client is connected
        if (isReady) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ready',
            discordConnected: true,
            uptime: process.uptime()
          }));
        } else {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'not ready',
            discordConnected: false,
            uptime: process.uptime()
          }));
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    this.healthServer.listen(port, () => {
      logger.info(`Health check server listening on port ${port}`);
    });

    this.healthServer.on('error', (error) => {
      logger.error(`Health server error: ${error.message}`);
    });
  }

  registerSlashCommands() {
    // Register chat/personality slash commands
    this.slashCommandHandler.register(new ChatSlashCommand(this.chatService));
    this.chatThreadCommand = new ChatThreadSlashCommand(this.chatService);
    this.slashCommandHandler.register(this.chatThreadCommand);
    this.slashCommandHandler.register(new ChatResetSlashCommand(this.chatService));
    this.slashCommandHandler.register(new ChatResumeSlashCommand(this.chatService));
    this.slashCommandHandler.register(new ChatListSlashCommand(this.chatService));

    // Register summarization slash commands
    this.slashCommandHandler.register(new SummarizeSlashCommand(this.summarizationService));
    this.slashCommandHandler.register(new ResummarizeSlashCommand(this.summarizationService));

    // Register utility slash commands
    this.slashCommandHandler.register(new HelpSlashCommand());
    this.slashCommandHandler.register(new ContextSlashCommand(this.channelContextService));
    this.slashCommandHandler.register(new ChannelTrackSlashCommand(
      this.channelContextService,
      this.mongoService
    ));

    // Register memory slash commands (if Mem0 is enabled)
    if (this.mem0Service) {
      this.slashCommandHandler.register(new MemoriesSlashCommand(this.mem0Service));
      this.slashCommandHandler.register(new RememberSlashCommand(this.mem0Service));
      this.forgetCommand = new ForgetSlashCommand(this.mem0Service);
      this.slashCommandHandler.register(this.forgetCommand);
      logger.info('Memory slash commands registered');
    }

    // Register image generation slash commands
    if (this.imagenService) {
      this.slashCommandHandler.register(new ImagineSlashCommand(this.imagenService, this.imageRetryHandler));
      logger.info('Imagen slash command registered');
    }

    // Register video generation slash commands
    if (this.veoService) {
      this.slashCommandHandler.register(new VideogenSlashCommand(this.veoService));
      logger.info('Veo slash command registered');
    }

    // Register music generation slash commands
    if (this.lyriaService && this.lyriaService.isEnabled()) {
      this.slashCommandHandler.register(new MusicgenSlashCommand(this.lyriaService));
      logger.info('Lyria slash command registered');
    }

    if (this.elevenLabsMusicService && this.elevenLabsMusicService.isEnabled()) {
      this.slashCommandHandler.register(new ElevenmusicSlashCommand(this.elevenLabsMusicService));
    }

    // Register IRC history slash commands
    if (this.qdrantService) {
      this.slashCommandHandler.register(new RecallSlashCommand(this.qdrantService, this.nickMappingService, this.voiceSearchService));
      this.slashCommandHandler.register(new HistorySlashCommand(this.qdrantService, this.nickMappingService));
      this.slashCommandHandler.register(new ThrowbackSlashCommand(this.qdrantService));
      logger.info('IRC history slash commands registered');
    }

    // Register catch-me-up command
    this.slashCommandHandler.register(new CatchMeUpSlashCommand(this.catchMeUpService));
    this.slashCommandHandler.register(new StatsSlashCommand(this.mongoService));

    // Register admin observability command (degrades gracefully if the agent
    // sidecar is disabled — this.agentClient is null in that case).
    this.slashCommandHandler.register(new ObserveSlashCommand(this.agentClient));

    // Register voice slash command (only if voice is enabled and initialized)
    if (config.voice.enabled && this.voiceService) {
      const VoiceSlashCommand = require('./commands/slash/voice');
      this.slashCommandHandler.register(new VoiceSlashCommand(this.voiceService));
      logger.info('Voice slash command registered');
    }

    logger.info(`Registered ${this.slashCommandHandler.size} slash commands`);
  }

  setupEventHandlers() {
    this.client.once('ready', async () => {
      logger.info('Discord client ready event fired');

      try {
        const systemPrompt = await fs.readFile(config.bot.systemPromptFile, 'utf-8');
        this.summarizationService.setSystemPrompt(systemPrompt);
        logger.info('System prompt loaded successfully');
      } catch (error) {
        logger.error('Failed to load system prompt:', error);
        process.exit(1);
      }
      
      logger.info(`Bot is online! Logged in as ${this.client.user.tag}`);

      // Start RSS feed monitoring if enabled
      if (config.bot.rssFeeds.enabled) {
        this.startRssFeedMonitoring();
      }

      // Start Linkwarden polling service if enabled
      if (config.linkwarden.enabled && this.linkwardenPollingService) {
        logger.info('Starting Linkwarden polling service...');
        const started = await this.linkwardenPollingService.start();
        if (started) {
          logger.info('Linkwarden polling service started successfully');
        } else {
          logger.error('Failed to start Linkwarden polling service - check configuration');
        }
      }

      // Start Channel Context service if enabled
      if (this.channelContextService) {
        logger.info('Starting Channel Context service...');
        await this.channelContextService.start();
      }

      // Start Voice Profile service if enabled
      if (this.voiceProfileService) {
        logger.info('Starting Voice Profile service...');
        await this.voiceProfileService.start();
      }

      // Periodically prune expired recall_ledger rows (best-effort, non-blocking)
      this.mongoService.pruneRecallLedger().catch(() => {});
      const recallPruneTimer = setInterval(() => {
        this.mongoService.pruneRecallLedger().catch(() => {});
      }, 24 * 60 * 60 * 1000);
      if (recallPruneTimer.unref) recallPruneTimer.unref();
    });

    this.client.on('messageReactionAdd', async (reaction, user) => {
      if (user.bot) return;

      try {
        if (reaction.partial) {
          await reaction.fetch();
        }
        if (reaction.message.partial) {
          await reaction.message.fetch();
        }

        // Wrap reaction handling in a trace
        await withRootSpan('discord.reaction', {
          'discord.reaction.emoji': reaction.emoji.name,
          'discord.channel.id': reaction.message.channel.id,
          'discord.user.id': user.id,
          'discord.user.tag': user.tag,
          'discord.message.id': reaction.message.id,
        }, async () => {
          await this.reactionHandler.handleNewsReaction(reaction, user);
          this._ensureSandboxTraceService();
          await this.reactionHandler.handleSandboxRevealReaction(reaction, user);

          // Handle follow-up reaction
          if (reaction.emoji.name === '📚') {
            const messageContent = reaction.message.content;
            const urlMatch = messageContent.match(/(https?:\/\/[^\s]+)/);
            if (urlMatch) {
              const url = urlMatch[0];
              const success = await this.followUpService.markForFollowUp(url, user.id);
              if (success) {
                await reaction.message.channel.send(`${user.username}, I'll keep an eye on this story for you!`);
              }
            }
          }

          // Handle image retry reactions
          if (this.imageRetryHandler) {
            logger.debug(`Checking image retry for message ${reaction.message.id}, emoji: ${reaction.emoji.name}`);
            if (this.imageRetryHandler.isPendingRetry(reaction.message.id)) {
              logger.info(`Processing image retry reaction for message ${reaction.message.id}`);
              await this.imageRetryHandler.handleRetryReaction(reaction, user);
            }
          }
        });

      } catch (error) {
        logger.error('Error handling reaction:', error);
      }
    });

    this.client.on('messageCreate', async message => {
      if (message.author.bot) return;

      // Track user activity and persist message for catch-me-up (non-blocking)
      if (message.guild && this.mongoService) {
        this.mongoService.recordUserActivity(
          message.author.id, message.guild.id, message.channel.id
        ).catch(err => logger.debug(`User activity tracking failed: ${err.message}`));

        // Prefer the resolved preferred name (services/SpeakerNames.js); fall
        // back to the raw Discord username when unresolved. `authorId` stays
        // the Discord id — identity keys never change.
        const authorName = (this.speakerNames && this.speakerNames.resolve(message.author, message.member))
          || message.author.username;

        this.mongoService.recordChannelMessage({
          messageId: message.id,
          channelId: message.channel.id,
          guildId: message.guild.id,
          authorId: message.author.id,
          authorName,
          content: message.content,
          timestamp: new Date()
        }).catch(err => logger.debug(`Channel message recording failed: ${err.message}`));
      }

      // Passive channel context recording for semantic search (non-blocking, writes to Qdrant)
      if (this.channelContextService?.isChannelTracked(message.channel.id)) {
        this.channelContextService.recordMessage(message).catch(err =>
          logger.debug(`Channel context record failed: ${err.message}`)
        );
      }

      // Handle messages in active chat threads
      if (message.channel.isThread() && this.chatThreadCommand) {
        const handled = await this.chatThreadCommand.handleThreadMessage(message);
        if (handled) return;
      }

      // Check if this is a reply to a bot message
      if (message.reference && message.reference.messageId) {
        try {
          const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
          if (referencedMessage && referencedMessage.author.id === this.client.user.id) {
            // Wrap reply handling in a trace
            const handled = await withRootSpan('discord.reply', {
              'discord.channel.id': message.channel.id,
              'discord.user.id': message.author.id,
              'discord.user.tag': message.author.tag,
              'discord.message.id': message.id,
            }, async () => {
              return await this.replyHandler.handleReply(message, referencedMessage);
            });

            if (handled) {
              return;
            }
            // ReplyHandler didn't claim this (not summarization, not imagegen).
            // Fall through to mention-chat so the bot continues the conversation.
            await this._handleMentionChat(message);
            return;
          }
        } catch (error) {
          logger.error(`Error fetching referenced message: ${error.message}`);
        }
      }

      // Handle @mentions of the bot - seamless entry into conversation
      if (message.mentions.has(this.client.user)) {
        await this._handleMentionChat(message);
        return;
      }
    });

    this.client.on('interactionCreate', async interaction => {
      // Handle slash commands
      if (interaction.isChatInputCommand()) {
        const context = {
          bot: this,
          config: config
        };

        // Wrap slash command execution in a trace
        await withRootSpan('discord.slash_command', {
          'discord.command.name': interaction.commandName,
          'discord.channel.id': interaction.channel?.id,
          'discord.user.id': interaction.user.id,
          'discord.user.tag': interaction.user.tag,
          'discord.guild.id': interaction.guild?.id
        }, async () => {
          await this.slashCommandHandler.execute(interaction, context);
        });
        return;
      }

      // Handle autocomplete
      if (interaction.isAutocomplete()) {
        const context = { bot: this, config: config };
        await this.slashCommandHandler.handleAutocomplete(interaction, context);
        return;
      }

      // Handle button interactions
      if (interaction.isButton()) {
        // Handle forget confirmation buttons
        if (interaction.customId.startsWith('forget_')) {
          if (this.forgetCommand) {
            await this.forgetCommand.handleButton(interaction);
          }
          return;
        }

        // Handle poll buttons (legacy)
        if (interaction.customId === 'poll_yes' || interaction.customId === 'poll_no') {
          await interaction.reply({
            content: `You voted ${interaction.customId === 'poll_yes' ? 'Yes' : 'No'}!`,
            ephemeral: true
          });
        }
      }
    });

    // Error handlers
    this.client.on('shardError', error => logger.error('WebSocket error:', error));
    this.client.on('error', error => logger.error('Client error:', error));
    this.client.on('warn', warning => logger.warn(warning));
    this.client.on('shardDisconnect', (event, shardId) => 
      logger.error(`Shard ${shardId} disconnected: ${event.code} - ${event.reason}`)
    );
    this.client.on('shardReconnecting', (shardId) => logger.info(`Shard ${shardId} reconnecting...`));
    
    if (process.env.DEBUG === 'true') {
      this.client.on('debug', info => logger.debug(info));
    }
  }

  /**
   * Handle @mention of the bot in a channel
   * Uses the 'friendly' personality for conversational interaction
   * @param {Message} message - The Discord message mentioning the bot
   */
  async _handleMentionChat(message) {
    const DEFAULT_PERSONALITY = personalityManager.get('channel-voice')
      ? 'channel-voice' : 'friendly';

    // Strip the mention from the message content to get the actual message
    const mentionPattern = new RegExp(`<@!?${this.client.user.id}>`, 'g');
    const userMessage = message.content.replace(mentionPattern, '').trim();

    // If the user only mentioned the bot with no message, respond with a friendly greeting
    if (!userMessage) {
      await message.reply({
        content: `😊 **Friendly Assistant**\n\nHey! You can ask me anything - just include your question after the @mention.`,
        allowedMentions: { repliedUser: false }
      });
      return;
    }

    await withRootSpan('discord.mention_chat', {
      'discord.channel.id': message.channel.id,
      'discord.user.id': message.author.id,
      'discord.user.tag': message.author.tag || message.author.username,
      'discord.message.id': message.id,
      'chat.personality.id': DEFAULT_PERSONALITY,
      'chat.trigger': 'mention',
    }, async () => {
      // Show typing indicator
      await message.channel.sendTyping();

      const channelId = message.channel.id;
      const guildId = message.guild?.id || null;

      // Call ChatService with the friendly personality
      const result = await this.chatService.chat(
        DEFAULT_PERSONALITY,
        userMessage,
        message.author,
        channelId,
        guildId
      );

      if (!result.success) {
        if (result.availablePersonalities) {
          return message.reply({
            content: `Something went wrong. Please try again.`,
            allowedMentions: { repliedUser: false }
          });
        }
        return message.reply({
          content: result.error,
          allowedMentions: { repliedUser: false }
        });
      }

      // Format response and wrap URLs (no personality header \u2014 channel-voice is the only personality)
      const fallbackNotice = result.fallback?.occurred
        ? `> *\u26A0\uFE0F Local LLM unavailable \u2014 responded with cloud fallback instead*\n\n`
        : '';
      const response = TextUtils.wrapUrls(`${fallbackNotice}${result.message}`);

      // Convert any generated images to Discord attachments
      const imageAttachments = this._createImageAttachments(result.images);

      // Split if too long for Discord (2000 char limit). Capture the last sent
      // message so we can persist it as an assistant turn (and, when this turn
      // ran sandbox code, attach executionIds for reaction-reveal lookups).
      const executionIds = result.executionSummary?.executionIds || [];
      let lastReply = null;
      if (response.length > 2000) {
        const chunks = this._splitMessage(response, 2000);
        for (let i = 0; i < chunks.length; i++) {
          lastReply = await message.channel.send(chunks[i]);
        }
        if (imageAttachments.length > 0) {
          await message.channel.send({ files: imageAttachments });
        }
      } else {
        lastReply = await message.reply({
          content: response,
          allowedMentions: { repliedUser: false }
        });
        if (imageAttachments.length > 0) {
          await message.channel.send({ files: imageAttachments });
        }
      }

      // Persist this channel-voice reply as an assistant turn in channel_messages
      // (ChatService.buildTurnContext maps isBot -> assistant), carrying any
      // sandbox executionIds so a later 🔍/📜/🐛 reaction can resolve them.
      await this._recordBotReply(lastReply, response, channelId, guildId, executionIds);
    });
  }

  /**
   * Lazy-init the SandboxTraceService once Mongo has connected. The Mongo
   * client connects asynchronously after construction, so this.mongoService.db
   * is null at bot-construction time but available by the time reactions fire.
   * @private
   */
  _ensureSandboxTraceService() {
    if (this.sandboxTraceService || !this.mongoService || !this.mongoService.db) return;
    try {
      const collection = this.mongoService.db.collection('sandbox_executions');
      this.sandboxTraceService = new SandboxTraceService({ collection });
      this.reactionHandler.sandboxTraceService = this.sandboxTraceService;
      logger.info('SandboxTraceService initialized (sandbox_executions collection)');
    } catch (e) {
      logger.warn(`Failed to init SandboxTraceService: ${e.message}`);
    }
  }

  /**
   * Persist a channel-voice bot reply to `channel_messages` as an assistant
   * turn (`isBot: true`), so `ChatService.buildTurnContext` can forward the
   * bot's own prior replies as history on the next turn. Also carries any
   * sandbox `executionIds` produced by this turn so a later 🔍/📜/🐛 reaction
   * on the reply can resolve them.
   *
   * This unifies what used to be a separate `_recordBotReplyExecutions`
   * helper, which only recorded a reply when it had sandbox executionIds
   * attached and never set `isBot` (so those turns mis-mapped to `user` in
   * history). There is now exactly one record call per successful
   * channel-voice reply, made unconditionally from `_handleMentionChat`.
   *
   * Never throws - a persistence failure must not break a reply that has
   * already been sent to Discord.
   * @param {import('discord.js').Message} reply - The Discord message the bot just sent
   * @param {string} content - The reply text
   * @param {string} channelId
   * @param {string|null} guildId
   * @param {string[]} [executionIds] - Sandbox execution ids produced by this turn
   * @private
   */
  async _recordBotReply(reply, content, channelId, guildId, executionIds = []) {
    if (!reply || !reply.id) return;
    if (!this.mongoService) return;
    try {
      const doc = {
        messageId: reply.id,
        channelId: channelId || null,
        guildId: guildId || null,
        authorId: this.client.user?.id || null,
        authorName: this.client.user?.username || 'bot',
        content,
        isBot: true,
        timestamp: new Date(),
      };
      if (executionIds && executionIds.length > 0) {
        doc.executionIds = executionIds;
      }
      await this.mongoService.recordChannelMessage(doc);
    } catch (e) {
      logger.warn(`Failed to record bot reply ${reply.id}: ${e.message}`);
    }
  }

  /**
   * Create Discord attachments from base64 images
   * @param {Array<{id: string, base64: string}>} images - Generated images
   * @returns {Array<AttachmentBuilder>} Discord attachment builders
   * @private
   */
  _createImageAttachments(images) {
    const attachments = [];
    if (!images || images.length === 0) {
      return attachments;
    }

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      try {
        const buffer = Buffer.from(img.base64, 'base64');
        const attachment = new AttachmentBuilder(buffer, {
          name: `generated_image_${i + 1}.png`
        });
        attachments.push(attachment);
        logger.info(`Prepared image attachment: generated_image_${i + 1}.png`);
      } catch (error) {
        logger.error(`Failed to create image attachment: ${error.message}`);
      }
    }

    return attachments;
  }

  /**
   * Split a message into chunks at natural break points
   * @param {string} text - Text to split
   * @param {number} maxLength - Maximum length per chunk
   * @returns {Array<string>} Array of chunks
   * @private
   */
  _splitMessage(text, maxLength) {
    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Find a good break point (newline, then space)
      let breakPoint = remaining.lastIndexOf('\n', maxLength);
      if (breakPoint === -1 || breakPoint < maxLength / 2) {
        breakPoint = remaining.lastIndexOf(' ', maxLength);
      }
      if (breakPoint === -1 || breakPoint < maxLength / 2) {
        breakPoint = maxLength;
      }

      chunks.push(remaining.substring(0, breakPoint).trim());
      remaining = remaining.substring(breakPoint).trim();
    }

    return chunks;
  }

  startRssFeedMonitoring() {
    const { rssFeeds } = config.bot;
    if (!rssFeeds.enabled || rssFeeds.feeds.length === 0) {
      logger.info('RSS feed monitoring is disabled or no feeds configured.');
      return;
    }

    logger.info(`Starting RSS feed monitoring for ${rssFeeds.feeds.length} feeds every ${rssFeeds.intervalMinutes} minutes.`);

    const checkFeeds = async () => {
      for (const feedConfig of rssFeeds.feeds) {
        try {
          const newArticles = await this.rssService.getNewArticles(feedConfig.url);
          if (newArticles.length > 0) {
            logger.info(`Found ${newArticles.length} new articles from ${feedConfig.url}`);
            const targetChannel = await this.client.channels.fetch(feedConfig.channelId);
            if (targetChannel && targetChannel.isTextBased()) {
              for (const article of newArticles) {
                // Summarize and post the article
                await this.summarizationService.processUrl(article.link, { channel: targetChannel }, this.client.user);
              }
            } else {
              logger.error(`Target channel ${feedConfig.channelId} not found or is not a text channel.`);
            }
          }
        } catch (error) {
          logger.error(`Error processing RSS feed ${feedConfig.url}: ${error.message}`);
        }
      }
    };

    // Run immediately and then set interval
    checkFeeds();
    setInterval(checkFeeds, rssFeeds.intervalMinutes * 60 * 1000);

    // Start follow-up monitoring
    if (config.bot.followUpTracker.enabled) {
      logger.info(`Starting follow-up monitoring every ${config.bot.followUpTracker.intervalMinutes} minutes.`);
      setInterval(() => this.followUpService.checkFollowUps(), config.bot.followUpTracker.intervalMinutes * 60 * 1000);
    }
  }
}

if (require.main === module) {
  logger.info('Starting bot from main module');
  const bot = new DiscordBot();

  // Graceful shutdown handler
  const gracefulShutdown = async (signal) => {
    logger.info(`Received ${signal}, initiating graceful shutdown...`);
    try {
      // Stop Channel Context service (flushes pending batch)
      if (bot.channelContextService) {
        await bot.channelContextService.stop();
        logger.info('Channel context service stopped');
      }
      // Stop Voice Profile service
      if (bot.voiceProfileService) {
        bot.voiceProfileService.stop();
        logger.info('Voice profile service stopped');
      }
      // Stop Linkwarden polling if active
      if (bot.linkwardenPollingService) {
        bot.linkwardenPollingService.stop();
      }
      // Stop health server if running
      if (bot.healthServer) {
        bot.healthServer.close();
        logger.info('Health server stopped');
      }
      // Destroy Discord client
      bot.client.destroy();
      // Shutdown tracing to flush any pending spans
      await shutdownTracing();
      logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error('Error during graceful shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  bot.start().catch(error => {
    logger.error('Unhandled error during bot startup:', error);
    process.exit(1);
  });
}

module.exports = DiscordBot;