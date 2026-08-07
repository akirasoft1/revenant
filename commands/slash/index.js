// commands/slash/index.js
// Export all slash commands

module.exports = {
  // Chat commands
  ChatSlashCommand: require('./ChatCommand'),
  ChatThreadSlashCommand: require('./ChatThreadCommand'),
  ChatResetSlashCommand: require('./ChatResetCommand'),
  ChatResumeSlashCommand: require('./ChatResumeCommand'),
  ChatListSlashCommand: require('./ChatListCommand'),

  // Summarization commands
  SummarizeSlashCommand: require('./SummarizeCommand'),
  ResummarizeSlashCommand: require('./ResummarizeCommand'),

  // Media generation commands
  ImagineSlashCommand: require('./ImagineCommand'),
  VideogenSlashCommand: require('./VideogenCommand'),
  MusicgenSlashCommand: require('./MusicgenCommand'),
  ElevenmusicSlashCommand: require('./ElevenmusicCommand'),

  // Memory commands
  MemoriesSlashCommand: require('./MemoriesCommand'),
  RememberSlashCommand: require('./RememberCommand'),
  ForgetSlashCommand: require('./ForgetCommand'),

  // IRC history commands
  RecallSlashCommand: require('./RecallCommand'),
  HistorySlashCommand: require('./HistoryCommand'),
  ThrowbackSlashCommand: require('./ThrowbackCommand'),

  // Activity commands
  CatchMeUpSlashCommand: require('./CatchMeUpCommand'),
  StatsSlashCommand: require('./StatsCommand'),

  // Utility commands
  HelpSlashCommand: require('./HelpCommand'),
  ContextSlashCommand: require('./ContextCommand'),
  ChannelTrackSlashCommand: require('./ChannelTrackCommand'),
  ObserveSlashCommand: require('./ObserveCommand'),

  // Voice commands
  VoiceSlashCommand: require('./voice')
};
