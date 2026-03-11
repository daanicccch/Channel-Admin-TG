const ALLOWED_TAGS = ['b', 'i', 'code', 'pre', 'a', 'tg-spoiler', 'tg-emoji'];

const DIVIDERS = [
  '━━━━━━━━━━',
  '▪️▪️▪️▪️▪️',
  '─────',
  '\u2800',
];

function escapeHTML(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeMarkdownToHTML(text) {
  if (!text) return '';

  let normalized = String(text).replace(/\r\n/g, '\n');

  normalized = normalized.replace(/(^|\n)\*\s+/g, '$1• ');
  normalized = normalized.replace(/```([\s\S]*?)```/g, (_, code) => `<pre>${escapeHTML(code.trim())}</pre>`);
  normalized = normalized.replace(/`([^`\n]+)`/g, (_, code) => `<code>${escapeHTML(code)}</code>`);
  normalized = normalized.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  normalized = normalized.replace(/\*\*([^*\n][\s\S]*?)\*\*/g, '<b>$1</b>');
  normalized = normalized.replace(/(^|[^\w*])\*([^*\n][\s\S]*?)\*(?=[^\w*]|$)/g, '$1<i>$2</i>');
  normalized = normalized.replace(/__([^_\n][\s\S]*?)__/g, '<i>$1</i>');
  normalized = normalized.replace(/~~([^~\n][\s\S]*?)~~/g, '<tg-spoiler>$1</tg-spoiler>');
  normalized = normalized.replace(/(^|\s)\*(?=\s|$)/g, '$1');

  return normalized;
}

function buildTelegramHTML(text) {
  if (!text) return '';

  const normalized = normalizeMarkdownToHTML(text);
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*)?)\s*\/?>/g;

  return normalized.replace(tagRegex, (match, tagName) => {
    const lowerTag = tagName.toLowerCase();
    if (ALLOWED_TAGS.includes(lowerTag)) {
      return match;
    }
    return '';
  });
}

function getTelegramVisibleText(text) {
  if (!text) return '';

  return String(text)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .trim();
}

function getTelegramEntityLength(text) {
  return getTelegramVisibleText(text).length;
}

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

function getRandomDivider() {
  const index = Math.floor(Math.random() * DIVIDERS.length);
  return DIVIDERS[index];
}

function truncateToLimit(text, maxLen) {
  if (!text || text.length <= maxLen) return text || '';

  let cutPoint = maxLen - 3;
  const lastOpenBracket = text.lastIndexOf('<', cutPoint);
  const lastCloseBracket = text.lastIndexOf('>', cutPoint);

  if (lastOpenBracket > lastCloseBracket) {
    cutPoint = lastOpenBracket;
  }

  let truncated = text.substring(0, cutPoint);
  const openTags = [];
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g;
  let tagMatch;

  while ((tagMatch = tagRegex.exec(truncated)) !== null) {
    const fullMatch = tagMatch[0];
    const tagName = tagMatch[1].toLowerCase();
    if (fullMatch.startsWith('</')) {
      const idx = openTags.lastIndexOf(tagName);
      if (idx !== -1) openTags.splice(idx, 1);
    } else if (!fullMatch.endsWith('/>')) {
      openTags.push(tagName);
    }
  }

  truncated += '...';

  for (let i = openTags.length - 1; i >= 0; i--) {
    truncated += `</${openTags[i]}>`;
  }

  return truncated;
}

module.exports = {
  escapeHTML,
  buildTelegramHTML,
  getTelegramVisibleText,
  getTelegramEntityLength,
  addInlineKeyboard,
  getRandomDivider,
  truncateToLimit,
};
