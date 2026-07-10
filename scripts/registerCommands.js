#!/usr/bin/env node
// scripts/registerCommands.js
// Register Discord slash commands with the API

const { REST, Routes } = require('discord.js');
const config = require('../config/config');
const logger = require('../logger');

// Import all slash command classes
const {
  ChatSlashCommand,
  ChatThreadSlashCommand,
  ChatResetSlashCommand,
  ChatResumeSlashCommand,
  ChatListSlashCommand,
  CatchMeUpSlashCommand,
  StatsSlashCommand,
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
  HelpSlashCommand,
  ContextSlashCommand,
  ChannelTrackSlashCommand,
  ObserveSlashCommand
} = require('../commands/slash');

async function registerCommands() {
  // Validate required config
  if (!config.discord.token) {
    console.error('ERROR: DISCORD_TOKEN is required');
    process.exit(1);
  }

  if (!config.discord.clientId) {
    console.error('ERROR: DISCORD_CLIENT_ID is required for slash command registration');
    console.error('Set DISCORD_CLIENT_ID in your environment or config');
    process.exit(1);
  }

  // Build command list (instantiate with null services - we just need the data)
  const commands = [];

  // Always include these commands
  commands.push(new ChatSlashCommand(null));
  commands.push(new ChatThreadSlashCommand(null));
  commands.push(new ChatResetSlashCommand(null));
  commands.push(new ChatResumeSlashCommand(null));
  commands.push(new ChatListSlashCommand(null));
  commands.push(new CatchMeUpSlashCommand(null));
  commands.push(new StatsSlashCommand(null));
  commands.push(new SummarizeSlashCommand(null));
  commands.push(new ResummarizeSlashCommand(null));
  commands.push(new HelpSlashCommand());
  commands.push(new ContextSlashCommand(null));
  commands.push(new ChannelTrackSlashCommand(null, null));
  commands.push(new ObserveSlashCommand(null));

  // Conditionally include feature-gated commands
  if (config.imagen?.enabled) {
    commands.push(new ImagineSlashCommand(null));
    console.log('Including /imagine command (imagen enabled)');
  }

  if (config.veo?.enabled) {
    commands.push(new VideogenSlashCommand(null));
    console.log('Including /videogen command (veo enabled)');
  }

  if (config.lyria?.enabled) {
    commands.push(new MusicgenSlashCommand(null));
    console.log('Including /musicgen command (lyria enabled)');
  }

  if (config.elevenlabs?.enabled) {
    commands.push(new ElevenmusicSlashCommand(null));
    console.log('Including /elevenmusic command (elevenlabs enabled)');
  }

  if (config.mem0?.enabled) {
    commands.push(new MemoriesSlashCommand(null));
    commands.push(new RememberSlashCommand(null));
    commands.push(new ForgetSlashCommand(null));
    console.log('Including memory commands (mem0 enabled)');
  }

  if (config.qdrant?.enabled) {
    commands.push(new RecallSlashCommand(null, null, null));
    commands.push(new HistorySlashCommand(null, null));
    commands.push(new ThrowbackSlashCommand(null));
    console.log('Including IRC history commands (qdrant enabled)');
  }

  // Get command JSON for API
  const commandData = commands.map(cmd => cmd.data.toJSON());

  console.log(`\nRegistering ${commandData.length} slash commands...`);
  console.log('Commands:', commandData.map(c => `/${c.name}`).join(', '));

  // Create REST client
  const rest = new REST({ version: '10' }).setToken(config.discord.token);

  try {
    // Always register globally so commands appear in every guild the bot is in.
    // Global commands can take up to 1 hour to propagate to Discord clients.
    console.log('\nRegistering globally (may take up to 1 hour to propagate to all guilds)...');

    await rest.put(
      Routes.applicationCommands(config.discord.clientId),
      { body: commandData }
    );

    console.log(`Successfully registered ${commandData.length} global commands`);

    // If a test guild is configured, ALSO register there for instant feedback
    // during development. Guild commands shadow global ones in that guild, so
    // there's no duplication or conflict.
    const testGuildId = config.discord.testGuildId;
    if (testGuildId) {
      console.log(`\nAlso registering to test guild ${testGuildId} (instant)...`);

      await rest.put(
        Routes.applicationGuildCommands(config.discord.clientId, testGuildId),
        { body: commandData }
      );

      console.log(`Successfully registered ${commandData.length} commands to test guild ${testGuildId}`);
      console.log('Note: Guild commands update instantly and override the global definitions in that guild.');
    }

    console.log('\nDone!');

  } catch (error) {
    console.error('Error registering commands:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  registerCommands();
}

module.exports = { registerCommands };
