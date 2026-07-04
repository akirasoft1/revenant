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

  async execute(interaction, context) {
    this.logExecution(interaction);
    const sub = interaction.options.getSubcommand();

    try {
      if (sub === 'ask') {
        const question = interaction.options.getString('question');
        const res = await this.agentClient.adminObserve({
          userId: interaction.user.id, userTag: interaction.user.tag, question,
        });
        if (res.error) return this.sendLongResponse(interaction, UNAVAILABLE);
        const footer = res.dqlUsed ? `\n\n\`\`\`dql\n${res.dqlUsed}\n\`\`\`` : '';
        return this.sendLongResponse(interaction, `${res.answerText}${footer}`);
      }

      if (sub === 'dql') {
        const query = interaction.options.getString('query');
        const res = await this.agentClient.runDql({ userId: interaction.user.id, query });
        if (res.error) return this.sendLongResponse(interaction, `❌ ${res.error}`);
        const rows = JSON.parse(res.rowsJson || '[]');
        if (rows.length === 0) return this.sendLongResponse(interaction, '(no rows)');
        const formatted = '```json\n' + JSON.stringify(rows, null, 2) + '\n```';
        return this.sendLongResponse(interaction, formatted);
      }
    } catch (err) {
      return this.sendLongResponse(interaction, UNAVAILABLE);
    }
  }
}

module.exports = ObserveSlashCommand;
