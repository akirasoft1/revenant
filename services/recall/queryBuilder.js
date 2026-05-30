// services/recall/queryBuilder.js
async function buildQuery(recentMessages, opts = {}) {
  const msgs = (recentMessages || []).filter((m) => typeof m === 'string' && m.trim());
  if (msgs.length === 0) return '';

  const strategy = opts.strategy || 'recent-window';
  const last = msgs[msgs.length - 1];

  if (strategy === 'last-message') return last;

  if (strategy === 'recent-window') {
    const n = opts.windowSize || 3;
    return msgs.slice(-n).join('\n');
  }

  if (strategy === 'llm-condense') {
    if (typeof opts.condenser !== 'function') return last;
    try {
      const window = msgs.slice(-(opts.windowSize || 5)).join('\n');
      const condensed = await opts.condenser(window);
      return (condensed && condensed.trim()) ? condensed.trim() : last;
    } catch (e) {
      return last;
    }
  }

  return last;
}

module.exports = { buildQuery };
