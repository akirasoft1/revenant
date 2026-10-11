// commands/slash/HangarCommand.js
// /hangar: view and seed members' Star Citizen ships in hangar-service.
// Bulk editing (fitting, spviewer import) lives in the web editor; /hangar list
// links to it when HANGAR_EDITOR_URL is set.
//
// Omitted `member` = the invoker. Writes for another member need a bot admin;
// the bot refuses first and hangar-service re-enforces via X-Acting-Member.
// Reads (list) are open: the chat agent can already read any member's
// hangar, so gating /hangar list would protect nothing.
'use strict';
const { SlashCommandBuilder, escapeMarkdown } = require('discord.js');
const BaseSlashCommand = require('../base/BaseSlashCommand');
const logger = require('../../logger');

const UNAVAILABLE = 'Hangar service is unavailable right now.';
const NOT_ADMIN = "Only a bot admin can change someone else's hangar.";
const MAX_REPLY = 2000;
const MAX_CHOICES = 25;
const MAX_CHOICE_LEN = 100;
// Discord drops an autocomplete response after 3s; leave room for the respond() round trip.
const AUTOCOMPLETE_TIMEOUT_MS = 2200;
const MAX_FITTED_INLINE = 120;
const NICKNAME_MAX = 64;
// hangar-service's vehicle limit; also keeps echoed input well inside Discord's 2000-char reply.
const SHIP_MAX = 200;

const clamp = (s, n = MAX_CHOICE_LEN) => {
  const str = String(s == null ? '' : s);
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
};

const MEDALS = ['🥇', '🥈', '🥉'];

function formatMoney(amount, currency) {
  const n = Number(amount) || 0;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
  } catch (_) {
    return `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  }
}

// {USD: 1234.5, EUR: 5} -> "$1,234.50 + €5.00" (USD first, then alphabetical)
function formatTotals(totals) {
  const keys = Object.keys(totals || {}).sort((a, b) => (a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b)));
  return keys.length ? keys.map((c) => formatMoney(totals[c], c)).join(' + ') : '$0.00';
}

function shipLabel(s) {
  return s.nickname ? `${s.nickname} (${s.vehicleName})` : String(s.vehicleName || s.shipId);
}

class HangarSlashCommand extends BaseSlashCommand {
  constructor(hangarClient, { editorUrl = '', memberIdentity = null, speakerNames = null } = {}) {
    const member = (o) => o.setName('member').setDescription('Another member (admin only for changes; default: you)').setRequired(false);
    super({
      data: new SlashCommandBuilder()
        .setName('hangar')
        .setDescription("See or change the Star Citizen ships in someone's hangar")
        .addSubcommand((s) => s.setName('list').setDescription('List the ships in a hangar')
          .addUserOption(member))
        .addSubcommand((s) => s.setName('add').setDescription('Add a ship to a hangar')
          .addStringOption((o) => o.setName('ship').setDescription('Ship model').setRequired(true).setAutocomplete(true).setMaxLength(SHIP_MAX))
          .addStringOption((o) => o.setName('nickname').setDescription('Optional nickname').setRequired(false).setMaxLength(NICKNAME_MAX))
          .addUserOption(member))
        .addSubcommand((s) => s.setName('rename').setDescription("Change a ship's nickname")
          .addStringOption((o) => o.setName('ship').setDescription('Ship in the hangar').setRequired(true).setAutocomplete(true).setMaxLength(SHIP_MAX))
          .addStringOption((o) => o.setName('nickname').setDescription('New nickname').setRequired(true).setMaxLength(NICKNAME_MAX))
          .addUserOption(member))
        .addSubcommand((s) => s.setName('remove').setDescription('Remove a ship from a hangar')
          .addStringOption((o) => o.setName('ship').setDescription('Ship in the hangar').setRequired(true).setAutocomplete(true).setMaxLength(SHIP_MAX))
          .addUserOption(member))
        .addSubcommand((s) => s.setName('leaderboard').setDescription('Who has pledged the most on ships (from RSI imports)')),
      cooldown: 2,
      ephemeral: true,
    });
    this.hangarClient = hangarClient;
    this.editorUrl = String(editorUrl || '').trim();
    this.memberIdentity = memberIdentity;
    this.speakerNames = speakerNames;
  }

  // Leaderboard display name: registry addressName -> SpeakerNames (override
  // table; Discord names are not available from an id alone) -> the service's
  // displayName -> a mention. Rendered text is markdown-escaped.
  _displayName(e) {
    let name = '';
    try {
      const rec = this.memberIdentity && typeof this.memberIdentity.get === 'function' ? this.memberIdentity.get(e.member) : null;
      name = (rec && rec.addressName) || '';
      if (!name && this.speakerNames && typeof this.speakerNames.resolve === 'function') {
        name = this.speakerNames.resolve({ id: String(e.member) }, null) || '';
      }
    } catch (err) {
      logger.warn(`/hangar leaderboard: name resolution failed for ${e.member}: ${err && err.stack ? err.stack : err}`);
    }
    name = name || e.displayName;
    return name ? escapeMarkdown(String(name)) : `<@${e.member}>`;
  }

  // "\nEdit in the browser: <url>" for /hangar list replies, or '' when unset.
  _footer() {
    return this.editorUrl ? `\nEdit in the browser: ${this.editorUrl}` : '';
  }

  _available() {
    return Boolean(this.hangarClient && (typeof this.hangarClient.isEnabled !== 'function' || this.hangarClient.isEnabled()));
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
    const who = { self, targetId, mention: self ? 'you' : `<@${targetId}>`, possessive: self ? 'your' : `<@${targetId}>'s` };

    if (!this._available()) {
      await this._say(interaction, UNAVAILABLE);
      return;
    }

    if (sub !== 'list' && !self) {
      const isAdmin = context?.config ? this.isAdmin(actorId, context.config) : false;
      if (!isAdmin) {
        await this._say(interaction, NOT_ADMIN);
        return;
      }
    }

    try {
      if (sub === 'leaderboard') {
        // The one public reply: skip deferIfNeeded, which forces ephemeral for this command.
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: false });
        return await this._leaderboard(interaction);
      }
      await this.deferIfNeeded(interaction, true);
      if (sub === 'list') return await this._list(interaction, who);
      if (sub === 'add') return await this._add(interaction, who, actorId);
      if (sub === 'rename') return await this._rename(interaction, who, actorId);
      if (sub === 'remove') return await this._remove(interaction, who, actorId);
      await this._say(interaction, `Unknown subcommand: ${sub}`);
    } catch (e) {
      logger.error(`/hangar ${sub} failed for target ${targetId} (actor ${actorId}): ${e && e.stack ? e.stack : e}`);
      try { await this._say(interaction, UNAVAILABLE); } catch (_) { /* interaction gone */ }
    }
  }

  // Map a non-ok client result to user text.
  _failure(res, who, input) {
    switch (res && res.error) {
      case 'ambiguous': {
        const labels = (res.candidates || []).map((c) => c.label || c.name).filter(Boolean);
        return `‘${input}’ matches several ships: ${labels.join(', ')}. Pick one from the list or type the full name.`;
      }
      case 'not_found':
        return `No ship matches ‘${input}’.`;
      case 'forbidden':
        return `You're not allowed to change ${who.possessive} hangar. ${NOT_ADMIN}`;
      case 'invalid_request':
        return `The hangar service rejected that: ${res.message}`;
      default:
        return UNAVAILABLE;
    }
  }

  async _leaderboard(interaction) {
    const res = await this.hangarClient.getPledgeLeaderboard();
    if (!res.ok) {
      await this.sendReply(interaction, { content: UNAVAILABLE, allowedMentions: { parse: [] } });
      return;
    }
    const entries = (res.data && res.data.entries) || [];
    if (!entries.length) {
      const where = this.editorUrl ? ` — see Import on ${this.editorUrl}` : '.';
      await this.sendReply(interaction, `No one has imported an RSI hangar yet${where}`);
      return;
    }
    const caveat = res.data && res.data.caveat ? `\n_${res.data.caveat}_` : '';
    const lines = entries.map((e, n) => {
      const name = this._displayName(e);
      const parts = [`${e.ships} ship${e.ships === 1 ? '' : 's'}`];
      if (e.lti) parts.push(`${e.lti} LTI`);
      if (e.topPledge) parts.push(`top: ${e.topPledge.name} (${formatMoney(e.topPledge.amount, e.topPledge.currency)})`);
      return `${n < 3 ? MEDALS[n] : `${n + 1}.`} **${name}** — ${formatTotals(e.totals)} · ${parts.join(' · ')}`;
    });
    const out = this._fit('**Pledge leaderboard**', lines, MAX_REPLY - caveat.length);
    await this.sendReply(interaction, { content: out + caveat, allowedMentions: { parse: [] } });
  }

  // header + as many lines as fit in `budget`, ending "…and N more." when cut.
  _fit(header, lines, budget) {
    let out = header;
    for (let n = 0; n < lines.length; n++) {
      const more = `\n…and ${lines.length - n} more.`;
      const candidate = `${out}\n${lines[n]}`;
      if (candidate.length > budget - (n === lines.length - 1 ? 0 : more.length + 2)) {
        return out + more;
      }
      out = candidate;
    }
    return out;
  }

  async _list(interaction, who) {
    const res = await this.hangarClient.getHangar(who.targetId);
    if (!res.ok) {
      await this._say(interaction, res.error === 'invalid_request' ? this._failure(res, who) : UNAVAILABLE);
      return;
    }
    const ships = (res.data && res.data.ships) || [];
    if (!ships.length) {
      await this._say(interaction, `No ships in ${who.possessive} hangar yet. Add one with \`/hangar add\`.${this._footer()}`);
      return;
    }
    const header = `**${who.self ? 'Your' : `<@${who.targetId}>'s`} hangar** (${ships.length} ship${ships.length === 1 ? '' : 's'})`;
    const lines = ships.map((s) => this._shipLine(s));
    const ps = res.data && res.data.pledgeSummary;
    const total = ps && ps.totals && Object.keys(ps.totals).length
      ? `\n💰 ${formatTotals(ps.totals)} pledged on ships across ${ps.pledges} pledge${ps.pledges === 1 ? '' : 's'}`
      : '';
    const footer = total + this._footer();
    const out = this._fit(header, lines, MAX_REPLY - footer.length);
    await this._say(interaction, out + footer);
  }

  _shipLine(s) {
    const name = s.nickname ? `**${s.nickname}** — ${s.vehicleName}` : `**${s.vehicleName}**`;
    const items = Object.values(s.fitted || {}).map((f) => f && (f.itemName || f.itemUuid)).filter(Boolean);
    let loadout;
    if (!items.length) {
      loadout = 'stock loadout';
    } else {
      const inline = `fitted: ${items.join(', ')}`;
      loadout = inline.length <= MAX_FITTED_INLINE ? inline : `${items.length} changes from stock`;
    }
    const err = s.loadoutError ? ` · loadout ${s.loadoutError === 'not_found' ? 'not in catalog' : 'unavailable'}` : '';
    return `• ${name} · ${loadout}${err}`;
  }

  async _add(interaction, who, actorId) {
    const vehicle = interaction.options.getString('ship');
    const nickname = interaction.options.getString('nickname') || null;
    const res = await this.hangarClient.addShip(who.targetId, { vehicle, nickname }, actorId);
    if (!res.ok) {
      await this._say(interaction, this._failure(res, who, vehicle));
      return;
    }
    const s = (res.data && res.data.ship) || {};
    const nick = s.nickname ? ` (“${s.nickname}”)` : '';
    await this._say(interaction, `Added **${s.vehicleName || vehicle}**${nick} to ${who.possessive} hangar.`);
  }

  // Resolve the `ship` option (a shipId from autocomplete, or free text) in the target's hangar.
  async _resolveShip(interaction, who, ref) {
    const res = await this.hangarClient.getHangar(who.targetId);
    if (!res.ok) {
      await this._say(interaction, UNAVAILABLE);
      return null;
    }
    const ships = (res.data && res.data.ships) || [];
    const byId = ships.find((s) => s.shipId === ref);
    if (byId) return byId;
    const q = String(ref || '').trim().toLowerCase();
    let hits = ships.filter((s) => (s.nickname || '').toLowerCase() === q);
    if (!hits.length) hits = ships.filter((s) => (s.vehicleName || '').toLowerCase() === q);
    if (!hits.length) hits = ships.filter((s) => shipLabel(s).toLowerCase().includes(q) && q);
    if (hits.length === 1) return hits[0];
    if (!hits.length) {
      await this._say(interaction, `No ship ‘${ref}’ in ${who.possessive} hangar. Pick one from the list.`);
    } else {
      await this._say(interaction, `‘${ref}’ matches several ships in ${who.possessive} hangar: ${hits.map(shipLabel).join(', ')}. Pick one from the list.`);
    }
    return null;
  }

  _writeFailure(res, who) {
    if (res.error === 'not_found') return `That ship is no longer in ${who.possessive} hangar.`;
    return this._failure(res, who);
  }

  async _rename(interaction, who, actorId) {
    const ref = interaction.options.getString('ship');
    const nickname = interaction.options.getString('nickname');
    const target = await this._resolveShip(interaction, who, ref);
    if (!target) return;
    const res = await this.hangarClient.renameShip(who.targetId, target.shipId, nickname, actorId);
    if (!res.ok) {
      await this._say(interaction, this._writeFailure(res, who));
      return;
    }
    const s = (res.data && res.data.ship) || {};
    const model = s.vehicleName || target.vehicleName;
    await this._say(interaction, s.nickname
      ? `Renamed **${model}** in ${who.possessive} hangar to “${s.nickname}”.`
      : `Cleared the nickname of **${model}** in ${who.possessive} hangar.`);
  }

  async _remove(interaction, who, actorId) {
    const ref = interaction.options.getString('ship');
    const target = await this._resolveShip(interaction, who, ref);
    if (!target) return;
    const res = await this.hangarClient.removeShip(who.targetId, target.shipId, actorId);
    if (!res.ok) {
      await this._say(interaction, this._writeFailure(res, who));
      return;
    }
    await this._say(interaction, `Removed **${shipLabel(target)}** from ${who.possessive} hangar.`);
  }

  async autocomplete(interaction) {
    let choices = [];
    try {
      const focused = interaction.options.getFocused(true);
      if (this._available() && focused && focused.name === 'ship') {
        const sub = interaction.options.getSubcommand();
        const value = String(focused.value || '');
        if (sub === 'add') {
          choices = await this._vehicleChoices(value);
        } else if (sub === 'rename' || sub === 'remove') {
          const member = interaction.options.get('member');
          const targetId = (member && member.value) ? String(member.value) : interaction.user.id;
          choices = await this._shipChoices(targetId, value);
        }
      }
    } catch (e) {
      logger.warn(`/hangar autocomplete failed: ${e && e.stack ? e.stack : e}`);
      choices = [];
    }
    try {
      await interaction.respond(choices);
    } catch (e) {
      logger.warn(`/hangar autocomplete respond failed: ${e && e.stack ? e.stack : e}`);
    }
  }

  async _vehicleChoices(q) {
    const res = await this.hangarClient.searchVehicles(q, { limit: MAX_CHOICES, timeoutMs: AUTOCOMPLETE_TIMEOUT_MS });
    if (!res.ok) return [];
    return ((res.data && res.data.vehicles) || []).slice(0, MAX_CHOICES)
      .filter((v) => v && v.uuid)
      .map((v) => ({
        name: clamp(v.manufacturer ? `${v.name} (${v.manufacturer})` : (v.name || v.uuid)),
        value: clamp(v.uuid),
      }));
  }

  async _shipChoices(targetId, q) {
    const res = await this.hangarClient.getHangar(targetId, { timeoutMs: AUTOCOMPLETE_TIMEOUT_MS });
    if (!res.ok) return [];
    const needle = q.trim().toLowerCase();
    return ((res.data && res.data.ships) || [])
      .filter((s) => s && s.shipId && (!needle || shipLabel(s).toLowerCase().includes(needle)))
      .slice(0, MAX_CHOICES)
      .map((s) => ({ name: clamp(shipLabel(s)), value: clamp(s.shipId) }));
  }
}

module.exports = HangarSlashCommand;
