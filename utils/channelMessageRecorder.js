// utils/channelMessageRecorder.js
// Shared writers for the `channel_messages` MongoDB collection.
//
// `ChatService.buildTurnContext` sources the agent's conversation history ONLY
// from `channel_messages` (isBot rows -> assistant turns). Every chat entry
// point must therefore record both sides of its exchange here, with the same
// doc shape: the messageCreate recorder + @mention/reply path in bot.js, and
// the /chat slash command (a slash interaction is not a channel message, so
// messageCreate never sees it — it records itself through these helpers).

const logger = require('../logger');

/**
 * Resolve the preferred display name for a Discord user
 * (services/SpeakerNames.js), falling back to the raw username. Never throws:
 * a resolver failure only loses the preferred name.
 * @param {{resolve: Function}|null} speakerNames
 * @param {{id: string, username: string}} user
 * @param {Object|null} member - Guild member (nickname layer), if available
 * @returns {string}
 */
function resolveAuthorName(speakerNames, user, member) {
  let authorName = user.username;
  try {
    const resolved = speakerNames && speakerNames.resolve(user, member);
    if (resolved) authorName = resolved;
  } catch (e) {
    logger.warn(`Speaker-name resolution failed for ${user.id}: ${e.message}`);
  }
  return authorName;
}

/**
 * Build a user (non-bot) `channel_messages` doc. `authorId` stays the Discord
 * id — identity keys never change; only `authorName` is the preferred name.
 */
function buildUserMessageDoc({ speakerNames, messageId, channelId, guildId, user, member, content }) {
  return {
    messageId,
    channelId,
    guildId,
    authorId: user.id,
    authorName: resolveAuthorName(speakerNames, user, member),
    content,
    timestamp: new Date(),
  };
}

/**
 * Record a user turn. Gated exactly like bot.js's messageCreate recorder:
 * guild messages only, and only when Mongo is configured. Never throws.
 * @returns {Promise<boolean>} whether a write was attempted and succeeded
 */
async function recordUserMessage({ mongoService, speakerNames, messageId, channelId, guildId, user, member, content }) {
  if (!mongoService || !guildId) return false;
  try {
    await mongoService.recordChannelMessage(
      buildUserMessageDoc({ speakerNames, messageId, channelId, guildId, user, member, content })
    );
    return true;
  } catch (e) {
    logger.warn(`Failed to record channel message ${messageId} in channel ${channelId}: ${e.message}`, { stack: e.stack });
    return false;
  }
}

/**
 * Persist a bot reply as an assistant turn (`isBot: true`), carrying any
 * sandbox `executionIds` so a later 🔍/📜/🐛 reaction on the reply can resolve
 * them. Store the RAW model output as `content`, not the Discord payload
 * (fallback banner, `<url>` wrapping, /chat's "**Prompt:**" header are
 * display-only and would be replayed to the model as its own words).
 *
 * Never throws — a persistence failure must not break a reply that has
 * already been sent to Discord.
 * @param {Object} params
 * @param {Object|null} params.mongoService
 * @param {{id: string, username: string}|null} params.botUser - client.user
 * @param {{id: string}|null} params.reply - The Discord message the bot sent
 * @param {string} params.content
 * @param {string|null} params.channelId
 * @param {string|null} params.guildId
 * @param {string[]} [params.executionIds]
 */
async function recordBotReply({ mongoService, botUser, reply, content, channelId, guildId, executionIds = [] }) {
  if (!reply || !reply.id) return;
  if (!mongoService) return;
  try {
    const doc = {
      messageId: reply.id,
      channelId: channelId || null,
      guildId: guildId || null,
      authorId: botUser?.id || null,
      authorName: botUser?.username || 'bot',
      content,
      isBot: true,
      timestamp: new Date(),
    };
    if (executionIds && executionIds.length > 0) {
      doc.executionIds = executionIds;
    }
    await mongoService.recordChannelMessage(doc);
  } catch (e) {
    logger.warn(`Failed to record bot reply ${reply.id}: ${e.message}`, { stack: e.stack });
  }
}

module.exports = {
  resolveAuthorName,
  buildUserMessageDoc,
  recordUserMessage,
  recordBotReply,
};
