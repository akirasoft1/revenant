// services/recall/adapters.js
const { contentHash, normalizeSimilarity } = require('./ranking');

function mem0Candidate(item, source, type, tag) {
  const text = item.memory || '';
  const hash = contentHash(text);
  return {
    key: item.id ? `${source}:${item.id}` : `hash:${hash}`,
    source,
    type,
    text,
    similarity: normalizeSimilarity(item.score),
    timestamp: null,
    contentHash: hash,
    provenance: { tag },
  };
}

async function mem0PersonalAdapter(mem0Service, { query, userId, personalityId, limit }) {
  if (!mem0Service || !mem0Service.isEnabled || !mem0Service.isEnabled()) return [];
  try {
    const res = await mem0Service.searchMemories(query, userId, { personalityId, limit });
    return (res.results || []).map((it) => mem0Candidate(it, 'mem0:personal', 'fact', 'fact'));
  } catch (e) { return []; }
}

async function mem0ExplicitAdapter(mem0Service, { query, userId, limit }) {
  if (!mem0Service || !mem0Service.isEnabled || !mem0Service.isEnabled()) return [];
  try {
    const res = await mem0Service.searchMemories(query, userId, { personalityId: 'explicit_memory', limit });
    return (res.results || []).map((it) => mem0Candidate(it, 'mem0:explicit', 'fact', 'explicit'));
  } catch (e) { return []; }
}

async function mem0SharedAdapter(mem0Service, { query, channelId, limit }) {
  if (!mem0Service || !mem0Service.isEnabled || !mem0Service.isEnabled()) return [];
  if (!channelId || !mem0Service.searchSharedChannelMemories) return [];
  try {
    const res = await mem0Service.searchSharedChannelMemories(query, channelId, { limit });
    return (res.results || []).map((it) => mem0Candidate(it, 'mem0:shared', 'fact', 'shared · channel'));
  } catch (e) { return []; }
}

async function channelSemanticAdapter(channelContextService, { query, channelId, limit }) {
  if (!channelContextService || !channelContextService.isChannelTracked || !channelContextService.isChannelTracked(channelId)) return [];
  try {
    const hits = await channelContextService.searchRelevantHistory(query, channelId, { limit });
    return (hits || []).map((h) => {
      const text = h.content || '';
      const hash = contentHash(text);
      return {
        key: `hash:${hash}`,
        source: 'channel:semantic',
        type: 'message',
        text,
        similarity: normalizeSimilarity(h.score),
        timestamp: h.timestamp || null,
        contentHash: hash,
        provenance: {
          tag: 'history',
          when: h.timestamp ? String(h.timestamp).slice(0, 10) : undefined,
          who: h.authorName ? `@${h.authorName}` : undefined,
        },
      };
    });
  } catch (e) { return []; }
}

async function channelFactsAdapter(channelContextService, { channelId }) {
  if (!channelContextService || !channelContextService.getChannelFactsRaw) return [];
  try {
    const facts = await channelContextService.getChannelFactsRaw(channelId);
    return (facts || []).map((it) => mem0Candidate(it, 'channel:facts', 'channel-fact', 'channel'));
  } catch (e) { return []; }
}

module.exports = {
  mem0Candidate,
  mem0PersonalAdapter,
  mem0ExplicitAdapter,
  mem0SharedAdapter,
  channelSemanticAdapter,
  channelFactsAdapter,
};
