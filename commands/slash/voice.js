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
        .addSubcommand((s) => s.setName('leave').setDescription('Leave the voice channel'))
        .addSubcommand((s) => s.setName('listen').setDescription('(admin) Listen now — no wake word, stays open until /voice leave')),
      cooldown: 5,
      // A cold-cache /voice join can trigger a slow ONNX wake-word model load
      // (see services/voice/wakeword.js) that saturates the bot's CPU limit
      // and blows Discord's 3s interaction-ack window ("The application did
      // not respond"). Auto-defer so SlashCommandHandler acks within 3s
      // regardless of how long join()/leave() takes.
      deferReply: true,
      ephemeral: true,
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
        const wake = this.voiceService.wakeWord();
        await this.sendReply(interaction, { content: `Joined <#${channel.id}>. Say "${wake}" to get my attention.`, ephemeral: true });
      } catch (e) {
        await this.sendError(interaction, `Couldn't join: ${e.message}`);
      }
      return;
    }
    if (sub === 'listen') {
      const isAdmin = context?.config ? this.isAdmin(interaction.user.id, context.config) : false;
      if (!isAdmin) {
        await this.sendReply(interaction, { content: 'The `/voice listen` override is admin-only.', ephemeral: true });
        return;
      }
      const channel = interaction.member?.voice?.channel;
      if (!channel) {
        await this.sendReply(interaction, { content: 'Join a voice channel first, then run `/voice listen`.', ephemeral: true });
        return;
      }
      try {
        await this.voiceService.listen({ channel, guildId: interaction.guildId, userId: interaction.user.id });
        await this.sendReply(interaction, { content: `Listening in <#${channel.id}> — no wake word needed. I'll keep listening until \`/voice leave\`.`, ephemeral: true });
      } catch (e) {
        await this.sendError(interaction, `Couldn't start listening: ${e.message}`);
      }
      return;
    }
    // leave
    await this.voiceService.leave(interaction.guildId);
    await this.sendReply(interaction, { content: 'Left the voice channel.', ephemeral: true });
  }
}

module.exports = VoiceSlashCommand;
