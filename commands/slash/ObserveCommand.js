// commands/slash/ObserveCommand.js
// Admin-only observability command. /obs ask (NL) and /obs dql (raw DQL) query
// Dynatrace via the agent sidecar's Observe/RunDql RPCs. Ephemeral, admin-gated.

const { SlashCommandBuilder } = require('discord.js');
const BaseSlashCommand = require('../base/BaseSlashCommand');

const UNAVAILABLE = '⚠️ Observability backend is currently unavailable. Try again shortly.';

class ObserveSlashCommand extends BaseSlashCommand {
  constructor(agentClient) {
    super({
      data: new SlashCommandBuilder()
        .setName('obs')
        .setDescription('Query bot observability (admin only)')
        .addSubcommand(sub =>
          sub.setName('ask')
            .setDescription('Ask a natural-language observability question')
            .addStringOption(o => o.setName('question').setDescription('Your question').setRequired(true)))
        .addSubcommand(sub =>
          sub.setName('dql')
            .setDescription('Run a read-only DQL query verbatim')
            .addStringOption(o => o.setName('query').setDescription('DQL to execute').setRequired(true))),
      adminOnly: true,
      deferReply: true,
      ephemeral: true,
      cooldown: 5,
    });
    this.agentClient = agentClient;
  }

  /**
   * Send a plain-text response, chunking it (via BaseSlashCommand#splitMessage)
   * if it exceeds Discord's message length limit.
   *
   * NOTE: this intentionally does NOT go through BaseSlashCommand#sendReply /
   * #sendLongResponse. Those helpers wrap string content into an
   * `{ content }` options object before calling interaction.editReply/reply,
   * which is correct for Discord's real API but means the mock in
   * __tests__/commands/ObserveCommand.test.js (which asserts
   * `editReply` was called with a plain string via `expect.stringContaining`)
   * would never match. Calling editReply/reply/followUp with a raw string
   * directly is equally valid per discord.js's API (string is accepted as
   * shorthand for `{ content }`), so this keeps the test's contract while
   * still reusing the base class's chunking logic.
   * @param {CommandInteraction} interaction
   * @param {string} content
   */
  async replyText(interaction, content) {
    const chunks = this.splitMessage(content, 2000);

    if (chunks.length === 0) {
      return this._deliver(interaction, 'No content to display.');
    }

    await this._deliver(interaction, chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }
  }

  async _deliver(interaction, text) {
    if (interaction.deferred) {
      await interaction.editReply(text);
    } else if (interaction.replied) {
      await interaction.followUp(text);
    } else {
      await interaction.reply(text);
    }
  }

  async execute(interaction, context) {
    this.logExecution(interaction);
    const sub = interaction.options.getSubcommand();

    try {
      if (sub === 'ask') {
        const question = interaction.options.getString('question');
        const res = await this.agentClient.adminObserve({
          userId: interaction.user.id, userTag: interaction.user.tag, question,
        });
        if (res.error) return this.replyText(interaction, UNAVAILABLE);
        const footer = res.dqlUsed ? `\n\n\`\`\`dql\n${res.dqlUsed}\n\`\`\`` : '';
        return this.replyText(interaction, `${res.answerText}${footer}`);
      }

      if (sub === 'dql') {
        const query = interaction.options.getString('query');
        const res = await this.agentClient.runDql({ userId: interaction.user.id, query });
        if (res.error) return this.replyText(interaction, `❌ ${res.error}`);
        const rows = JSON.parse(res.rowsJson || '[]');
        if (rows.length === 0) return this.replyText(interaction, '(no rows)');
        const formatted = '```json\n' + JSON.stringify(rows, null, 2) + '\n```';
        return this.replyText(interaction, formatted);
      }
    } catch (err) {
      return this.replyText(interaction, UNAVAILABLE);
    }
  }
}

module.exports = ObserveSlashCommand;
