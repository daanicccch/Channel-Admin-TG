const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const logger = require('./utils/logger');
const { loadGeminiKeys } = require('./ai/geminiKeyStore');

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`[CONFIG] Missing required env var: ${key}`);
    console.error('Copy .env.example to .env and fill required values');
    process.exit(1);
  }
}

const paths = {
  root: path.resolve(__dirname, '..'),
  data: path.resolve(__dirname, '..', 'data'),
  mediaCache: path.resolve(__dirname, '..', 'data', 'media_cache'),
  rules: path.resolve(__dirname, '..', 'rules'),
  logs: path.resolve(__dirname, '..', 'logs'),
  db: path.resolve(__dirname, '..', 'data', 'bot.db'),
  geminiKeys: path.resolve(__dirname, '..', 'data', 'gemini_keys.json'),
};

const geminiKeysFromArray = parseList(process.env.GEMINI_API_KEYS);
const geminiEnvFallback = geminiKeysFromArray.length > 0
  ? geminiKeysFromArray
  : (process.env.GEMINI_API_KEY ? [process.env.GEMINI_API_KEY.trim()] : []);
const geminiKeys = loadGeminiKeys(paths.geminiKeys, geminiEnvFallback);
const adminChatIds = parseList(process.env.TELEGRAM_ADMIN_CHAT_ID);

if (geminiKeys.length === 0) {
  console.error('[CONFIG] At least one Gemini AI key is required: data/gemini_keys.json or GEMINI_API_KEY(S)');
  process.exit(1);
}

const config = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    channelId: process.env.TELEGRAM_CHANNEL_ID || '',
    adminChatIds,
    adminChatId: adminChatIds[0] || '',
    apiId: parseInt(process.env.TELEGRAM_API_ID, 10),
    apiHash: process.env.TELEGRAM_API_HASH,
    sessionString: process.env.TELEGRAM_SESSION_STRING || '',
  },
  ai: {
    geminiKeys,
    geminiKey: geminiKeys[0] || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
  schedule: {
    morningHour: parseInt(process.env.MORNING_DIGEST_HOUR, 10) || 9,
    dayHour: parseInt(process.env.DAY_ANALYSIS_HOUR, 10) || 14,
    eveningHour: parseInt(process.env.EVENING_REVIEW_HOUR, 10) || 20,
    checkIntervalMinutes: parseInt(process.env.CHANNEL_CHECK_INTERVAL_MINUTES, 10) || 10,
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
    ...paths,
  },
};

let _db = null;

async function initDb() {
  if (_db) return _db;

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

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
      profile_id TEXT,
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
      profile_id TEXT,
      channel TEXT NOT NULL,
      telegram_post_id INTEGER,
      source_date DATETIME,
      text TEXT,
      entities TEXT,
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

  db.run(`
    CREATE TABLE IF NOT EXISTS channel_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      telegram_post_id INTEGER NOT NULL,
      source_date DATETIME,
      generated_post_id INTEGER,
      status TEXT DEFAULT 'processed',
      created_at DATETIME DEFAULT (datetime('now'))
    )
  `);

  const sourcePostsColumns = db.exec(`PRAGMA table_info(source_posts)`);
  const sourcePostsColumnNames = sourcePostsColumns.length > 0
    ? sourcePostsColumns[0].values.map((row) => row[1])
    : [];

  const postsColumns = db.exec(`PRAGMA table_info(posts)`);
  const postsColumnNames = postsColumns.length > 0
    ? postsColumns[0].values.map((row) => row[1])
    : [];

  const channelChecksColumns = db.exec(`PRAGMA table_info(channel_checks)`);
  const channelChecksColumnNames = channelChecksColumns.length > 0
    ? channelChecksColumns[0].values.map((row) => row[1])
    : [];

  if (!postsColumnNames.includes('profile_id')) {
    db.run(`ALTER TABLE posts ADD COLUMN profile_id TEXT`);
  }

  if (!sourcePostsColumnNames.includes('profile_id')) {
    db.run(`ALTER TABLE source_posts ADD COLUMN profile_id TEXT`);
  }

  if (!sourcePostsColumnNames.includes('source_date')) {
    db.run(`ALTER TABLE source_posts ADD COLUMN source_date DATETIME`);
  }

  if (!sourcePostsColumnNames.includes('entities')) {
    db.run(`ALTER TABLE source_posts ADD COLUMN entities TEXT`);
  }

  if (!channelChecksColumnNames.includes('source_date')) {
    db.run(`ALTER TABLE channel_checks ADD COLUMN source_date DATETIME`);
  }

  if (!channelChecksColumnNames.includes('generated_post_id')) {
    db.run(`ALTER TABLE channel_checks ADD COLUMN generated_post_id INTEGER`);
  }

  if (!channelChecksColumnNames.includes('status')) {
    db.run(`ALTER TABLE channel_checks ADD COLUMN status TEXT DEFAULT 'processed'`);
  }

  if (!channelChecksColumnNames.includes('created_at')) {
    db.run(`ALTER TABLE channel_checks ADD COLUMN created_at DATETIME DEFAULT (datetime('now'))`);
  }

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_source_posts_channel_post
    ON source_posts(profile_id, channel, telegram_post_id)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_source_posts_source_date
    ON source_posts(profile_id, source_date)
  `);

  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_checks_unique
    ON channel_checks(profile_id, channel, telegram_post_id)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_channel_checks_lookup
    ON channel_checks(profile_id, channel, telegram_post_id)
  `);

  logger.info('SQLite database initialized');
  _db = db;
  return db;
}

function getDb() {
  if (!_db) {
    throw new Error('Database is not initialized. Call await initDb() on startup.');
  }
  return _db;
}

function saveDb() {
  if (!_db) return;
  const data = _db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(config.paths.db, buffer);
}

function closeDb() {
  if (!_db) return;
  saveDb();
  _db.close();
  _db = null;
}

module.exports = { config, initDb, getDb, saveDb, closeDb };
