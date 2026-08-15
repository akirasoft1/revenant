// commands/slash/voice.js
// Slash command to join/leave the bot's live voice channel presence
'use strict';
const { SlashCommandBuilder } = require('discord.js');
const BaseSlashCommand = require('../base/BaseSlashCommand');

// Render a session cap in seconds as something a human reads correctly.
// `Math.round(s / 60)` called a 90s cap "2-minute" -- overstating, by 33%, the
// one number in this reply whose entire purpose is to stop the bot promising
// more time than it has. Whole minutes stay minutes; anything else keeps its
// remainder, and sub-minute caps stay in seconds.
function formatCap(seconds) {
  if (seconds < 60) return `${seconds}-second`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}-minute` : `${m}-minute ${s}-second`;
}

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
        // join() reports what actually happened. It used to return undefined
        // whether it connected, no-op'd because we were already in this
        // channel, or no-op'd because we are sitting in a DIFFERENT one --
        // and this reply said "Joined <#your channel>" for all three, naming
        // the invoker's channel rather than the one the bot is actually in.
        const result = await this.voiceService.join({ channel, guildId: interaction.guildId });
        const wake = this.voiceService.wakeWord();
        if (result && result.joined === false && result.channelId && result.channelId !== channel.id) {
          await this.sendError(interaction, `Couldn't join: I'm already in <#${result.channelId}> — run \`/voice leave\` there first.`);
          return;
        }
        const already = result && result.joined === false;
        await this.sendReply(interaction, {
          content: `${already ? 'Already in' : 'Joined'} <#${channel.id}>. Say "${wake}" to get my attention.`,
          ephemeral: true });
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
        // listen() reports what actually happened. It used to return a bare
        // `true` even when it had refused (a session was already active) or
        // failed (unhealthy sidecar -> no session opened at all), and this
        // reply announced continuous listening regardless.
        const result = await this.voiceService.listen({ channel, guildId: interaction.guildId, userId: interaction.user.id });
        if (!result || !result.listening) {
          const reason = result && result.reason;
          if (reason === 'already-active') {
            await this.sendError(interaction, "Couldn't start listening: there's already a live session in this server. Wait for it to end, or run `/voice leave` first.");
          } else if (reason === 'other-channel') {
            await this.sendError(interaction, `Couldn't start listening: I'm already in <#${result.channelId}> — run \`/voice leave\` there first.`);
          } else {
            // If this call had to join first, the bot IS in the channel now --
            // the session is what failed. Reporting flat failure while sitting
            // in the user's voice channel is the same false-reporting defect
            // as the one this whole block fixes, just inverted.
            const joinedAnyway = result && result.joined
              ? ` I did join <#${channel.id}> though, so the wake word still works — or run \`/voice leave\`.`
              : '';
            await this.sendError(interaction, `Couldn't start listening: no session opened (the voice sidecar is unavailable or the open failed — check the bot logs).${joinedAnyway}`);
          }
          return;
        }
        // Tell the truth about how long this lasts. VOICE_MAX_SESSION_SECONDS
        // force-ends the session regardless of listen mode (600s by default,
        // and the deployed overlay does not override it), so "until
        // /voice leave" alone is a promise the bot breaks ~10 minutes in.
        const capSeconds = typeof this.voiceService.maxSessionSeconds === 'function'
          ? this.voiceService.maxSessionSeconds() : 0;
        const cap = capSeconds > 0
          ? ` or the ${formatCap(capSeconds)} session cap, whichever comes first`
          : '';
        await this.sendReply(interaction, { content: `Listening in <#${channel.id}> — no wake word needed. I'll keep listening until \`/voice leave\`${cap}.`, ephemeral: true });
      } catch (e) {
        await this.sendError(interaction, `Couldn't start listening: ${e.message}`);
      }
      return;
    }
    // leave
    // A throwing teardown still deletes the guild entry (VoiceService.leave's
    // finally), so voice is usable again — but it did not necessarily leave the
    // channel, and saying "Left the voice channel" when the connection destroy
    // threw is the same false-success this command had for join/listen.
    try {
      await this.voiceService.leave(interaction.guildId);
    } catch (e) {
      await this.sendError(interaction, `Couldn't cleanly leave: ${e.message}`);
      return;
    }
    await this.sendReply(interaction, { content: 'Left the voice channel.', ephemeral: true });
  }
}

module.exports = VoiceSlashCommand;
