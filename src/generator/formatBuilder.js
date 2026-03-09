const ALLOWED_TAGS = ['b', 'i', 'code', 'pre', 'a', 'tg-spoiler'];

const DIVIDERS = [
  '━━━━━━━━━━',
  '▫️▫️▫️▫️▫️',
  '—————',
  '\u2800', // invisible separator (braille blank)
];

/**
 * Escape special HTML characters for Telegram HTML mode.
 * @param {string} text
 * @returns {string}
 */
function escapeHTML(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Validate and sanitize Telegram HTML: keep only allowed tags, strip all others.
 * @param {string} text
 * @returns {string}
 */
function buildTelegramHTML(text) {
  if (!text) return '';

  // Build regex to match HTML tags
  // Match opening, closing, and self-closing tags
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*)?)\s*\/?>/g;

  return text.replace(tagRegex, (match, tagName) => {
    const lowerTag = tagName.toLowerCase();
    if (ALLOWED_TAGS.includes(lowerTag)) {
      return match; // keep allowed tags as-is
    }
    return ''; // strip disallowed tags
  });
}

/**
 * Create a Telegraf-compatible inline keyboard reply_markup object.
 * @param {Array<{ text: string, url: string }>} buttons
 * @returns {object} reply_markup with inline_keyboard
 */
function addInlineKeyboard(buttons) {
  if (!buttons || !Array.isArray(buttons) || buttons.length === 0) {
    return { inline_keyboard: [] };
  }

  const keyboard = buttons.map((btn) => ({
    text: btn.text || '',
    url: btn.url || '',
  }));

  return {
    inline_keyboard: [keyboard],
  };
}

/**
 * Return a random divider string.
 * @returns {string}
 */
function getRandomDivider() {
  const index = Math.floor(Math.random() * DIVIDERS.length);
  return DIVIDERS[index];
}

/**
 * Truncate text to maxLen without breaking HTML tags. Appends "..." if truncated.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function truncateToLimit(text, maxLen) {
  if (!text || text.length <= maxLen) return text || '';

  // Find a safe truncation point that doesn't break an HTML tag
  let cutPoint = maxLen - 3; // reserve space for "..."

  // If we're in the middle of a tag, backtrack to before it
  const lastOpenBracket = text.lastIndexOf('<', cutPoint);
  const lastCloseBracket = text.lastIndexOf('>', cutPoint);

  if (lastOpenBracket > lastCloseBracket) {
    // We're inside an unclosed tag — cut before it
    cutPoint = lastOpenBracket;
  }

  let truncated = text.substring(0, cutPoint);

  // Close any unclosed tags
  const openTags = [];
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g;
  let tagMatch;

  while ((tagMatch = tagRegex.exec(truncated)) !== null) {
    const fullMatch = tagMatch[0];
    const tagName = tagMatch[1].toLowerCase();
    if (fullMatch.startsWith('</')) {
      // Closing tag — remove last matching open tag
      const idx = openTags.lastIndexOf(tagName);
      if (idx !== -1) openTags.splice(idx, 1);
    } else if (!fullMatch.endsWith('/>')) {
      // Opening tag
      openTags.push(tagName);
    }
  }

  truncated += '...';

  // Close remaining open tags in reverse order
  for (let i = openTags.length - 1; i >= 0; i--) {
    truncated += `</${openTags[i]}>`;
  }

  return truncated;
}

module.exports = {
  escapeHTML,
  buildTelegramHTML,
  addInlineKeyboard,
  getRandomDivider,
  truncateToLimit,
};
