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
  'пантеон легенд',
  'символ упущенных возможностей',
  'машина для печатания денег',
  'золотой билет',
  'guaranteed',
  'to the moon',
];

const BANNED_STARTS = ['Друзья', 'Итак', 'Добрый день'];

const POST_TYPE_LIMITS = {
  post: { max: 1100 },
  alert: { max: 700 },
  weekly: { max: 1400 },
};

const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{2B50}\u{23CF}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}-\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}]/gu;

const AI_PATTERN_RULES = [
  {
    pattern: /\b(является свидетельством|знаменует собой|подчеркивает важность|подчёркивает важность)\b/i,
    issue: 'Есть пафосная AI-формулировка, которая раздувает значимость факта',
  },
  {
    pattern: /\b(играет ключевую роль|поворотный момент|более широкие тенденции)\b/i,
    issue: 'Есть шаблонный вывод вместо конкретного наблюдения',
  },
  {
    pattern: /\b(широко освещал(?:ся|ась|ось)|получил признание экспертов|независимые источники подтверждают)\b/i,
    issue: 'Есть размытая апелляция к известности или авторитетам без конкретики',
  },
  {
    pattern: /\b(уникальн(?:ый|ая|ое|ые)|революционн(?:ый|ая|ое|ые)|инновационн(?:ый|ая|ое|ые)|не имеющ(?:ий|ая|ее|ие) аналогов)\b/i,
    issue: 'Есть рекламный промо-язык, который делает текст искусственным',
  },
  {
    pattern: /\b(эксперты считают|по мнению специалистов|исследователи отмечают|наблюдатели полагают)\b/i,
    issue: 'Есть размытая атрибуция без указания конкретного источника',
  },
  {
    pattern: /\b(несмотря на успехи|сталкивается с рядом вызовов|будущее выглядит многообещающим|перспективы развития)\b/i,
    issue: 'Есть шаблонный блок про вызовы или перспективы без фактуры',
  },
  {
    pattern: /\b(осуществляет деятельность|на основании|в соответствии с|в рамках|представляет собой)\b/i,
    issue: 'Есть канцелярит, который убивает живой тон',
  },
  {
    pattern: /\b(в контексте|кроме того|более того|таким образом)\b/i,
    issue: 'Есть типичная связка AI-текста вместо прямой подачи мысли',
  },
  {
    pattern: /\b(не только .*?, но и|это не просто .*?, а)\b/i,
    issue: 'Есть риторическая конструкция, которая звучит шаблонно',
  },
  {
    pattern: /\b(пантеон легенд|символ упущенных возможностей|удар для коллекционеров|полная зачистка|получить уже невозможно)\b/i,
    issue: 'Есть избыточная драматизация или ложная финальность для обычного события',
  },
];

const DEFAULT_RULES_PATH = path.join(config.paths.rules, 'POST_RULES.md');
const DEFAULT_TEMPLATES_PATH = path.join(config.paths.rules, 'TEMPLATES.md');
const DEFAULT_HUMANIZER_PATH = path.join(__dirname, 'HUMANIZER_RULES.md');
const fileCache = new Map();
const watchedFiles = new Set();

function watchFile(filePath) {
  if (!filePath || watchedFiles.has(filePath)) return;

  try {
    fs.watchFile(filePath, { interval: 5000 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        fileCache.delete(filePath);
        logger.info(`styleEngine: file changed ${path.basename(filePath)}, cache dropped`);
      }
    });
    watchedFiles.add(filePath);
  } catch (err) {
    logger.debug(`styleEngine: watcher skipped for ${filePath}: ${err.message}`);
  }
}

function loadFile(filePath, label) {
  if (!filePath) return '';
  if (fileCache.has(filePath)) {
    return fileCache.get(filePath);
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    fileCache.set(filePath, content);
    watchFile(filePath);
    logger.debug(`styleEngine: loaded ${label} from ${path.basename(filePath)}`);
    return content;
  } catch (err) {
    logger.warn(`styleEngine: failed to load ${label} from ${filePath}: ${err.message}`);
    fileCache.set(filePath, '');
    return '';
  }
}

function loadRules(profile = null) {
  return loadFile(profile?.rulesPath || DEFAULT_RULES_PATH, 'POST_RULES');
}

function loadTemplates(profile = null) {
  return loadFile(profile?.templatesPath || DEFAULT_TEMPLATES_PATH, 'TEMPLATES');
}

function loadHumanizerRules(profile = null) {
  return loadFile(profile?.humanizerPath || DEFAULT_HUMANIZER_PATH, 'HUMANIZER_RULES');
}

function findAiPatternIssues(text) {
  const issues = [];

  for (const rule of AI_PATTERN_RULES) {
    if (rule.pattern.test(text)) {
      issues.push(rule.issue);
    }
  }

  return issues;
}

function findFormattingIssues(text) {
  const issues = [];
  const pairedValueBlocks = text.match(/(?:^|\n)(?:<b>)?(?:Офферы|Факт сделки|Потеря|Итог|Продажа|Сделка)(?::(?:<\/b>)?)?\s*\n(?:[~\d][^\n]{0,40}\n){2,}/gim) || [];

  if (pairedValueBlocks.length > 0) {
    issues.push('Числовой блок оформлен слишком сухо: связанные значения лучше держать в одной строке, например `100 000 ⭐️ (~1 400 TON)`');
  }

  const nakedNumberLines = text.match(/(?:^|\n)[~]?\$?\d[\d\s.,]*\s*(?:⭐️|⭐|TON|\$|USD)?\s*\n[~]?\$?\d[\d\s.,]*\s*(?:⭐️|⭐|TON|\$|USD)/gim) || [];
  if (nakedNumberLines.length > 0) {
    issues.push('Есть две подряд строки с голыми числами без нормальной склейки или подводки');
  }

  return issues;
}

function validatePost(text, postType) {
  const issues = [];

  if (!text || typeof text !== 'string') {
    return { valid: false, issues: ['Пост пустой или не является строкой'] };
  }

  const limits = POST_TYPE_LIMITS[postType];
  if (limits) {
    if (Number.isFinite(limits.min) && limits.min > 0 && text.length < limits.min) {
      issues.push(`Длина поста (${text.length}) меньше минимума (${limits.min}) для типа "${postType}"`);
    }
    if (Number.isFinite(limits.max) && text.length > limits.max) {
      issues.push(`Длина поста (${text.length}) превышает максимум (${limits.max}) для типа "${postType}"`);
    }
  }

  const lowerText = text.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lowerText.includes(phrase.toLowerCase())) {
      issues.push(`Содержит запрещённую фразу: "${phrase}"`);
    }
  }

  const trimmedText = text.trimStart();
  for (const start of BANNED_STARTS) {
    if (trimmedText.startsWith(start)) {
      issues.push(`Пост начинается с запрещённого слова: "${start}"`);
    }
  }

  const emojiCount = (text.match(EMOJI_REGEX) || []).length;
  if (emojiCount < 1) {
    issues.push(`Слишком мало эмодзи: ${emojiCount} (нужен минимум 1)`);
  }
  if (emojiCount > 2) {
    issues.push(`Слишком много эмодзи: ${emojiCount} (максимум 2)`);
  }

  issues.push(...findAiPatternIssues(text));
  issues.push(...findFormattingIssues(text));

  const uniqueIssues = [...new Set(issues)];
  return { valid: uniqueIssues.length === 0, issues: uniqueIssues };
}

module.exports = {
  loadRules,
  loadTemplates,
  loadHumanizerRules,
  validatePost,
  POST_TYPE_LIMITS,
};
