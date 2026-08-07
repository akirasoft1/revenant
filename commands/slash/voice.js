// commands/slash/voice.js
// Slash command to join/leave the bot's live voice channel presence
'use strict';
const { SlashCommandBuilder } = require('discord.js');
const BaseSlashCommand = require('../base/BaseSlashCommand');

class VoiceSlashCommand extends BaseSlashCommand {
  constructor(voiceService) {
    super({
      data: new SlashCommandBuilder()
        .setName('voice')
        .setDescription('Talk to me in a voice channel')
        .addSubcommand((s) => s.setName('join').setDescription('Join your current voice channel'))
        .addSubcommand((s) => s.setName('leave').setDescription('Leave the voice channel')),
      cooldown: 5,
    });
    this.voiceService = voiceService;
  }

  async execute(interaction, context) {
    this.logExecution(interaction);
    if (!this.voiceService || !this.voiceService.isEnabled()) {
      await this.sendReply(interaction, { content: 'Voice is not enabled on this bot.', ephemeral: true });
      return;
    }
    const sub = interaction.options.getSubcommand();
    if (sub === 'join') {
      const channel = interaction.member?.voice?.channel;
      if (!channel) {
        await this.sendReply(interaction, { content: 'Join a voice channel first, then run `/voice join`.', ephemeral: true });
        return;
      }
      try {
        await this.voiceService.join({ channel, guildId: interaction.guildId });
        await this.sendReply(interaction, { content: `Joined <#${channel.id}>. Say "computer" to get my attention.`, ephemeral: true });
      } catch (e) {
        await this.sendError(interaction, `Couldn't join: ${e.message}`);
      }
      return;
    }
    // leave
    await this.voiceService.leave(interaction.guildId);
    await this.sendReply(interaction, { content: 'Left the voice channel.', ephemeral: true });
  }
}

module.exports = VoiceSlashCommand;
