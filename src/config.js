const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const logger = require('./utils/logger');

// Валидация обязательных переменных
const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`[CONFIG] Отсутствует обязательная переменная: ${key}`);
    console.error('Скопируйте .env.example в .env и заполните значения');
    process.exit(1);
  }
}

// Хотя бы один AI ключ обязателен
if (!process.env.GEMINI_API_KEY && !process.env.DASHSCOPE_API_KEY) {
  console.error('[CONFIG] Нужен хотя бы один AI ключ: GEMINI_API_KEY или DASHSCOPE_API_KEY');
  process.exit(1);
}

const config = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    channelId: process.env.TELEGRAM_CHANNEL_ID || '',
    adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || '',
    apiId: parseInt(process.env.TELEGRAM_API_ID, 10),
    apiHash: process.env.TELEGRAM_API_HASH,
    sessionString: process.env.TELEGRAM_SESSION_STRING || '',
  },
  ai: {
    geminiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    dashscopeKey: process.env.DASHSCOPE_API_KEY || '',
    qwenModel: process.env.QWEN_MODEL || 'qwen-plus',
    qwenBaseUrl: process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  },
  schedule: {
    morningHour: parseInt(process.env.MORNING_DIGEST_HOUR, 10) || 9,
    dayHour: parseInt(process.env.DAY_ANALYSIS_HOUR, 10) || 14,
    eveningHour: parseInt(process.env.EVENING_REVIEW_HOUR, 10) || 20,
    timezone: process.env.TIMEZONE || 'Europe/Moscow',
  },
  modes: {
    autoPublish: process.env.AUTO_PUBLISH === 'true',
    reviewMode: process.env.REVIEW_MODE !== 'false',
  },
  limits: {
    minPostInterval: parseInt(process.env.MIN_POST_INTERVAL_MINUTES, 10) || 30,
    mediaCacheDays: parseInt(process.env.MEDIA_CACHE_DAYS, 10) || 7,
    lookbackHours: parseInt(process.env.LOOKBACK_HOURS, 10) || 24,
  },
  paths: {
    root: path.resolve(__dirname, '..'),
    data: path.resolve(__dirname, '..', 'data'),
    mediaCache: path.resolve(__dirname, '..', 'data', 'media_cache'),
    rules: path.resolve(__dirname, '..', 'rules'),
    logs: path.resolve(__dirname, '..', 'logs'),
    db: path.resolve(__dirname, '..', 'data', 'bot.db'),
  },
};

// sql.js wrapper — синхронный API поверх sql.js для совместимости
let _db = null;
let _dbReady = null;

/**
 * Инициализирует БД (вызывать один раз при старте).
 * Возвращает promise.
 */
async function initDb() {
  if (_db) return _db;

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  // Загрузить существующую БД или создать новую
  let db;
  if (fs.existsSync(config.paths.db)) {
    const buffer = fs.readFileSync(config.paths.db);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      media_path TEXT,
      telegram_message_id INTEGER,
      published_at DATETIME,
      sources TEXT,
      engagement TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS source_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      telegram_post_id INTEGER,
      text TEXT,
      media_paths TEXT,
      views INTEGER DEFAULT 0,
      reactions TEXT,
      scraped_at DATETIME DEFAULT (datetime('now')),
      used_in_posts TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS analytics_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      data TEXT NOT NULL,
      captured_at DATETIME DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS trends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      mentions INTEGER DEFAULT 1,
      first_seen DATETIME DEFAULT (datetime('now')),
      last_seen DATETIME DEFAULT (datetime('now')),
      sentiment REAL DEFAULT 0
    )
  `);

  logger.info('SQLite база данных инициализирована');
  _db = db;
  return db;
}

/**
 * Получить инициализированную БД (синхронно, если уже готова).
 * Для первого вызова используйте initDb().
 */
function getDb() {
  if (!_db) {
    throw new Error('БД не инициализирована. Вызовите await initDb() при старте.');
  }
  return _db;
}

/** Сохранить БД на диск */
function saveDb() {
  if (!_db) return;
  const data = _db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(config.paths.db, buffer);
}

/** Закрыть и сохранить БД */
function closeDb() {
  if (!_db) return;
  saveDb();
  _db.close();
  _db = null;
}

module.exports = { config, initDb, getDb, saveDb, closeDb };
