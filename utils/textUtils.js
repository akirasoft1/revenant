// ===== utils/textUtils.js =====
const logger = require('../logger');

// URL regex patterns
// Pattern for markdown links: [text](url) - captures the URL part
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\((<?)([^)>]+)(>?)\)/g;

// Pattern for standalone URLs with http/https - excludes trailing punctuation
const FULL_URL_PATTERN = /(https?:\/\/[^\s<>]*[^\s<>.,;:!?)\]}"'])/g;

class TextUtils {
  /**
   * Wraps URLs in angle brackets to prevent Discord auto-expansion.
   * Already-wrapped URLs (in <> or []) are left unchanged.
   * @param {string} text - The text containing URLs.
   * @returns {string} - Text with URLs wrapped in <>.
   */
  static wrapUrls(text) {
    if (!text || typeof text !== 'string') {
      return text;
    }

    // Step 1: Wrap URLs inside markdown links [text](url) -> [text](<url>)
    let result = text.replace(MARKDOWN_LINK_PATTERN, (match, linkText, openBracket, url, closeBracket) => {
      // If already wrapped in <>, return as-is
      if (openBracket === '<' && closeBracket === '>') {
        return match;
      }
      // Wrap the URL in angle brackets
      return `[${linkText}](<${url}>)`;
    });

    // Step 2: Wrap standalone URLs (not inside markdown links)
    result = result.replace(FULL_URL_PATTERN, (match, url, offset, fullString) => {
      // Check if already wrapped in angle brackets
      const charBefore = offset > 0 ? fullString[offset - 1] : '';
      const charAfter = fullString[offset + match.length] || '';

      if (charBefore === '<' && charAfter === '>') {
        return match; // Already wrapped
      }

      // Check if inside a markdown link (already processed, but double-check)
      const before = fullString.substring(Math.max(0, offset - 3), offset);
      if (before.endsWith('](') || before.endsWith('](<')) {
        return match; // Part of markdown link
      }

      // Wrap the URL
      return `<${url}>`;
    });

    return result;
  }

  /**
   * Estimates the reading time for a given text.
   * @param {string} text - The text to be evaluated.
   * @param {number} wpm - Words per minute, defaults to 200.
   * @returns {string} - A string representing the estimated reading time (e.g., "~3 min read").
   */
  static calculateReadingTime(text, wpm = 200) {
    if (!text || typeof text !== 'string') {
      return '';
    }

    const words = text.trim().split(/\s+/).length;
    const time = Math.ceil(words / wpm);
    
    if (time < 1) {
      return '~<1 min read';
    }
    
    return `~${time} min read`;
  }

  /**
   * Renders the user-visible "this reply is degraded" banner from a chat
   * result's `fallback` field, ready to prefix the reply body.
   *
   * Shared by every surface that shows a chat reply (mention chat, /chat,
   * /chatthread) so a degraded answer is announced identically wherever it
   * lands. It used to exist only in bot.js, which meant a `/chat` user was
   * silently handed a substitute model with no notice at all.
   *
   * @param {Object|undefined} fallback - `result.fallback` from ChatService.
   * @returns {string} The banner (with trailing blank line), or '' when the
   *   reply was not degraded.
   */
  static fallbackNotice(fallback) {
    if (!fallback || !fallback.occurred) {
      return '';
    }
    const text = fallback.notice || fallback.reason || 'Responded in a degraded mode';
    return `> *⚠️ ${text}*\n\n`;
  }
}

module.exports = TextUtils;
