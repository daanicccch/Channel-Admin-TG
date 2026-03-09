const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const logger = require('../utils/logger');

const BANNED_PHRASES = [
  'в данной статье',
  'следует отметить',
  'как мы все знаем',
  'безусловно',
  'резюмируя',
  'guaranteed',
  'to the moon',
];

const BANNED_STARTS = ['Друзья', 'Итак', 'Добрый день'];

const POST_TYPE_LIMITS = {
  digest: { min: 800, max: 1500 },
  analysis: { min: 1500, max: 3000 },
  alert: { min: 300, max: 800 },
  weekly: { min: 2000, max: 4000 },
};

// Regex to match emoji characters (covers most common ranges)
const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{2B50}\u{23CF}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}-\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}]/gu;

let _rulesCache = null;
let _templatesCache = null;

const rulesPath = path.join(config.paths.rules, 'POST_RULES.md');
const templatesPath = path.join(config.paths.rules, 'TEMPLATES.md');

// Set up file watchers for hot-reload
function _setupWatcher(filePath, clearFn) {
  try {
    fs.watchFile(filePath, { interval: 5000 }, (curr, prev) => {
      if (curr.mtime !== prev.mtime) {
        logger.info(`styleEngine: файл ${path.basename(filePath)} изменён, сбрасываем кеш`);
        clearFn();
      }
    });
  } catch (err) {
    logger.debug(`styleEngine: не удалось установить watcher для ${filePath}: ${err.message}`);
  }
}

_setupWatcher(rulesPath, () => { _rulesCache = null; });
_setupWatcher(templatesPath, () => { _templatesCache = null; });

/**
 * Load POST_RULES.md content, with caching and hot-reload.
 * @returns {string} rules content or empty string if file not found
 */
function loadRules() {
  if (_rulesCache !== null) return _rulesCache;
  try {
    _rulesCache = fs.readFileSync(rulesPath, 'utf-8');
    logger.debug('styleEngine: POST_RULES.md загружен');
    return _rulesCache;
  } catch (err) {
    logger.warn(`styleEngine: не удалось загрузить POST_RULES.md — ${err.message}`);
    _rulesCache = '';
    return _rulesCache;
  }
}

/**
 * Load TEMPLATES.md content, with caching and hot-reload.
 * @returns {string} templates content or empty string if file not found
 */
function loadTemplates() {
  if (_templatesCache !== null) return _templatesCache;
  try {
    _templatesCache = fs.readFileSync(templatesPath, 'utf-8');
    logger.debug('styleEngine: TEMPLATES.md загружен');
    return _templatesCache;
  } catch (err) {
    logger.warn(`styleEngine: не удалось загрузить TEMPLATES.md — ${err.message}`);
    _templatesCache = '';
    return _templatesCache;
  }
}

/**
 * Validate a post's text against style rules.
 * @param {string} text - post text
 * @param {string} postType - one of: digest, analysis, alert, weekly
 * @returns {{ valid: boolean, issues: string[] }}
 */
function validatePost(text, postType) {
  const issues = [];

  if (!text || typeof text !== 'string') {
    return { valid: false, issues: ['Пост пустой или не является строкой'] };
  }

  // Check length limits
  const limits = POST_TYPE_LIMITS[postType];
  if (limits) {
    if (text.length < limits.min) {
      issues.push(`Длина поста (${text.length}) меньше минимума (${limits.min}) для типа "${postType}"`);
    }
    if (text.length > limits.max) {
      issues.push(`Длина поста (${text.length}) превышает максимум (${limits.max}) для типа "${postType}"`);
    }
  }

  // Check banned phrases
  const lowerText = text.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lowerText.includes(phrase.toLowerCase())) {
      issues.push(`Содержит запрещённую фразу: "${phrase}"`);
    }
  }

  // Check banned start phrases
  const trimmedText = text.trimStart();
  for (const start of BANNED_STARTS) {
    if (trimmedText.startsWith(start)) {
      issues.push(`Пост начинается с запрещённого слова: "${start}"`);
    }
  }

  // Check emoji count — лимиты зависят от типа поста
  const emojiMatches = text.match(EMOJI_REGEX) || [];
  const emojiCount = emojiMatches.length;
  const emojiMax = (postType === 'digest' || postType === 'weekly') ? 15 : 10;
  if (emojiCount < 2) {
    issues.push(`Слишком мало эмодзи: ${emojiCount} (нужно минимум 2)`);
  }
  if (emojiCount > emojiMax) {
    issues.push(`Слишком много эмодзи: ${emojiCount} (максимум ${emojiMax})`);
  }

  return { valid: issues.length === 0, issues };
}

module.exports = {
  loadRules,
  loadTemplates,
  validatePost,
  POST_TYPE_LIMITS,
};
