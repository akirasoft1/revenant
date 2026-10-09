// commands/slash/WhoisCommand.js
// /whois: view and manage the member identity registry (address name + aliases).
// Anyone edits their own entry; editing another member requires a bot admin.
'use strict';
const { SlashCommandBuilder } = require('discord.js');
const BaseSlashCommand = require('../base/BaseSlashCommand');
const logger = require('../../logger');

const UNAVAILABLE = 'Identity storage is unavailable right now.';

class WhoisSlashCommand extends BaseSlashCommand {
  constructor(memberIdentity, speakerNames) {
    const member = (o) => o.setName('member').setDescription('Another member (admin only to edit; default: you)').setRequired(false);
    super({
      data: new SlashCommandBuilder()
        .setName('whois')
        .setDescription('See or set the names I know people by')
        .addSubcommand((s) => s.setName('show').setDescription('Show the name and aliases I use')
          .addUserOption(member))
        .addSubcommand((s) => s.setName('address').setDescription('Set the name I call someone')
          .addStringOption((o) => o.setName('name').setDescription('The name to use').setRequired(true))
          .addUserOption(member))
        .addSubcommand((s) => s.setName('alias-add').setDescription('Add another name someone goes by')
          .addStringOption((o) => o.setName('alias').setDescription('The alias').setRequired(true))
          .addUserOption(member))
        .addSubcommand((s) => s.setName('alias-remove').setDescription('Remove an alias')
          .addStringOption((o) => o.setName('alias').setDescription('The alias').setRequired(true))
          .addUserOption(member)),
      cooldown: 2,
      ephemeral: true,
    });
    this.memberIdentity = memberIdentity;
    this.speakerNames = speakerNames;
  }

  _say(interaction, content) {
    return this.sendReply(interaction, { content, ephemeral: true });
  }

  async execute(interaction, context) {
    this.logExecution(interaction);
    const sub = interaction.options.getSubcommand();
    const actorId = interaction.user.id;
    const targetUser = interaction.options.getUser('member');
    const targetId = targetUser ? targetUser.id : actorId;
    const self = targetId === actorId;
    const mention = self ? 'you' : `<@${targetId}>`;

    if (!this.memberIdentity) {
      await this._say(interaction, UNAVAILABLE);
      return;
    }

    if (sub === 'show') {
      await this._show(interaction, targetId, targetUser, self);
      return;
    }

    if (!self) {
      const isAdmin = context?.config ? this.isAdmin(actorId, context.config) : false;
      if (!isAdmin) {
        await this._say(interaction, "Only a bot admin can change someone else's names.");
        return;
      }
    }

    const posessive = self ? 'your' : `<@${targetId}>'s`;
    let result;
    let input;
    try {
      if (sub === 'address') {
        input = interaction.options.getString('name');
        result = await this.memberIdentity.setAddressName(targetId, input, actorId);
      } else if (sub === 'alias-add') {
        input = interaction.options.getString('alias');
        result = await this.memberIdentity.addAlias(targetId, input, actorId);
      } else if (sub === 'alias-remove') {
        input = interaction.options.getString('alias');
        result = await this.memberIdentity.removeAlias(targetId, input, actorId);
      } else {
        await this._say(interaction, `Unknown subcommand: ${sub}`);
        return;
      }
    } catch (e) {
      logger.error(`/whois ${sub} failed for target ${targetId}: ${e && e.stack ? e.stack : e}`);
      await this._say(interaction, UNAVAILABLE);
      return;
    }

    if (!result || !result.ok) {
      await this._say(interaction, this._failure(result, input, mention, sub));
      return;
    }
    const rec = result.record || {};
    // Show the STORED (sanitised/truncated) name, never the raw input.
    const stored = sub === 'address'
      ? (rec.addressName || result.name || input)
      : ((rec.aliases || []).find((a) => a.toLowerCase() === String(result.name || '').toLowerCase())
        || result.name || input);
    if (sub === 'address') {
      await this._say(interaction, `${result.unchanged ? 'Already calling' : 'Okay, I will call'} ${mention} ${stored}.`);
    } else if (sub === 'alias-add') {
      await this._say(interaction, result.unchanged
        ? `‘${stored}’ is already one of ${posessive} aliases (or ${self ? 'your' : 'their'} address name).`
        : `Added ‘${stored}’ as an alias for ${mention}.`);
    } else {
      await this._say(interaction, `Removed ‘${input}’ from ${posessive} aliases.`);
    }
  }

  _failure(result, input, mention, sub) {
    switch (result && result.reason) {
      case 'taken':
        return `‘${input}’ is already used by <@${result.holderId}>.`;
      case 'invalid':
        return `‘${input}’ isn't a usable name: it needs at least one letter and 2 or more characters (longer names are shortened to 24), and can't be a long run of digits.`;
      case 'too_many':
        return 'That member already has the maximum of 10 aliases. Remove one first.';
      case 'not_found':
        return sub === 'alias-remove'
          ? `‘${input}’ isn't one of ${mention === 'you' ? 'your' : `${mention}'s`} aliases.`
          : 'No identity found.';
      default:
        return UNAVAILABLE;
    }
  }

  async _show(interaction, targetId, targetUser, self) {
    const who = self ? 'you' : `<@${targetId}>`;
    const rec = this.memberIdentity.get(targetId);
    if (!rec) {
      if (!this.memberIdentity.isLoaded()) {
        await this._say(interaction, UNAVAILABLE);
        return;
      }
      let current = null;
      try {
        const user = targetUser || interaction.user;
        const member = (self ? interaction.member : interaction.options.getMember('member')) || null;
        current = this.speakerNames ? this.speakerNames.resolve(user, member) : null;
      } catch (_) { /* fall through */ }
      await this._say(interaction, `No identity set for ${who}.${current ? ` I currently use the name ‘${current}’.` : ''}`);
      return;
    }
    const aliases = rec.aliases && rec.aliases.length ? rec.aliases.map((a) => `‘${a}’`).join(', ') : 'none';
    await this._say(interaction, `${self ? 'You' : `<@${targetId}>`}: I call ${self ? 'you' : 'them'} ‘${rec.addressName || '(not set)'}’. Aliases: ${aliases}.`);
  }
}

module.exports = WhoisSlashCommand;
