const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const updates = require('telegram/client/updates');
const { config } = require('../config');
const { runSql } = require('../utils/dbHelpers');
const rateLimiter = require('../utils/rateLimiter');
const { queryOne } = require('../utils/dbHelpers');
const logger = require('../utils/logger');
const mediaSaver = require('./mediaSaver');
const fs = require('fs');
const path = require('path');

// Patch GramJS update loop: for scraping we do not need updates/ping loop.
updates._updateLoop = async function () {};

const ENTITY_TIMEOUT_MS = parseInt(process.env.TG_ENTITY_TIMEOUT_MS || '15000', 10);
const MESSAGES_TIMEOUT_MS = parseInt(process.env.TG_MESSAGES_TIMEOUT_MS || '30000', 10);
const MEDIA_TIMEOUT_MS = parseInt(process.env.TG_MEDIA_TIMEOUT_MS || '12000', 10);
const MAX_MEDIA_PER_CHANNEL = parseInt(process.env.TG_MAX_MEDIA_PER_CHANNEL || '8', 10);

function normalizeTelegramDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') {
    const timestampMs = value < 1e12 ? value * 1000 : value;
    return new Date(timestampMs);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    const timestampMs = parsed < 1e12 ? parsed * 1000 : parsed;
    return new Date(timestampMs);
  }
  return new Date(value);
}

function serializeEntities(entities = []) {
  if (!Array.isArray(entities) || entities.length === 0) {
    return null;
  }

  const normalized = entities.map((entity) => ({
    type: entity.className || entity.constructor?.name || '',
    offset: Number(entity.offset) || 0,
    length: Number(entity.length) || 0,
    documentId: entity.documentId ? String(entity.documentId) : null,
    url: entity.url || null,
  }));

  return JSON.stringify(normalized);
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`timeout: ${label} (${timeoutMs}ms)`)), timeoutMs);
    }),
  ]);
}

class TelegramScraper {
  constructor() {
    this.apiId = config.telegram.apiId;
    this.apiHash = config.telegram.apiHash;
    this.sessionString = config.telegram.sessionString;
    this.client = null;
  }

  async connect() {
    const session = new StringSession(this.sessionString);
    this.client = new TelegramClient(session, this.apiId, this.apiHash, {
      connectionRetries: 3,
    });
    await this.client.connect();
    logger.info('TelegramScraper: подключен к Telegram');
  }

  /**
   * Scrape messages from a single channel.
   * @param {string} username - channel username (without @)
   * @param {object} options
   * @param {number} options.limit - max messages to fetch (default 50)
   * @returns {object} - { channel, channelTitle, posts: [...] }
   */
  async scrapeChannel(username, options = {}) {
    const limit = options.limit || 50;
    const lookbackHours = options.lookbackHours || config.limits.lookbackHours || 24;
    const cutoffMs = Date.now() - (lookbackHours * 60 * 60 * 1000);
    const entity = await withTimeout(
      this.client.getEntity(username),
      ENTITY_TIMEOUT_MS,
      `getEntity:${username}`
    );
    const channelTitle = entity.title || username;

    const messages = await withTimeout(
      this.client.getMessages(entity, { limit }),
      MESSAGES_TIMEOUT_MS,
      `getMessages:${username}`
    );

    const posts = await this._buildPostsFromMessages(messages, username, channelTitle, cutoffMs);

    logger.info(`TelegramScraper: ${username} - получено ${posts.length} постов`);
    return { channel: username, channelTitle, posts };
  }

  async _buildPostsFromMessages(messages, username, channelTitle, cutoffMs) {
    const postsMap = new Map();
    const orderedKeys = [];

    for (const msg of messages) {
      const messageDate = normalizeTelegramDate(msg.date);
      if (Number.isFinite(messageDate.getTime()) && messageDate.getTime() < cutoffMs) {
        continue;
      }

      const groupedId = msg.groupedId ? String(msg.groupedId) : null;
      const postKey = groupedId ? `group:${groupedId}` : `msg:${msg.id}`;

      if (!postsMap.has(postKey)) {
        postsMap.set(postKey, {
          id: msg.id,
          date: messageDate,
          text: msg.message || '',
          entities: serializeEntities(msg.entities || []),
          views: msg.views || 0,
          forwards: msg.forwards || 0,
          reactions: null,
          mediaPaths: [],
          channel: username,
          channelTitle,
        });
        orderedKeys.push(postKey);
      }

      const post = postsMap.get(postKey);

      if (!post.text && msg.message) {
        post.text = msg.message;
        post.entities = serializeEntities(msg.entities || []);
      }

      if (messageDate > post.date) {
        post.date = messageDate;
        post.id = msg.id;
      }

      post.views = Math.max(Number(post.views) || 0, Number(msg.views) || 0);
      post.forwards = Math.max(Number(post.forwards) || 0, Number(msg.forwards) || 0);

      if (msg.reactions && msg.reactions.results) {
        post.reactions = msg.reactions.results.map(r => ({
          emoji: r.reaction.emoticon || r.reaction.documentId || '?',
          count: r.count,
        }));
      }

      const hasVisualMedia = Boolean(msg.photo);
      if (hasVisualMedia && post.mediaPaths.length < MAX_MEDIA_PER_CHANNEL) {
        try {
          const mediaPath = await withTimeout(
            mediaSaver.downloadMedia(this.client, msg, username),
            MEDIA_TIMEOUT_MS,
            `downloadMedia:${username}/${msg.id}`
          );
          if (mediaPath && !post.mediaPaths.includes(mediaPath)) {
            post.mediaPaths.push(mediaPath);
          }
        } catch (err) {
          logger.warn(`TelegramScraper: media skip ${username}/${msg.id} - ${err.message}`);
        }
      }
    }

    return orderedKeys
      .map((key) => {
        const post = postsMap.get(key);
        return {
          ...post,
          mediaPath: post.mediaPaths[0] || null,
        };
      })
      .sort((left, right) => {
        const leftTime = left.date instanceof Date ? left.date.getTime() : 0;
        const rightTime = right.date instanceof Date ? right.date.getTime() : 0;
        return rightTime - leftTime;
      });
  }

  persistChannelPosts(result, options = {}) {
    const profileId = options.profileId || 'default';
    const username = result?.channel;
    if (!username || !Array.isArray(result?.posts)) {
      return;
    }

    for (const post of result.posts) {
      const sourceDate = post.date instanceof Date && Number.isFinite(post.date.getTime())
        ? post.date.toISOString().slice(0, 19).replace('T', ' ')
        : null;
      const storedMediaPaths = Array.isArray(post.mediaPaths) && post.mediaPaths.length > 0
        ? JSON.stringify(post.mediaPaths)
        : (post.mediaPath || null);
      const existing = queryOne(
        `SELECT id FROM source_posts WHERE profile_id = ? AND channel = ? AND telegram_post_id = ? ORDER BY id DESC LIMIT 1`,
        [profileId, username, post.id],
      );

      if (existing && existing.id) {
        runSql(
          `UPDATE source_posts
           SET text = ?, entities = ?, media_paths = ?, views = ?, reactions = ?, source_date = ?, scraped_at = datetime('now')
           WHERE id = ?`,
          [
            post.text,
            post.entities,
            storedMediaPaths,
            post.views,
            post.reactions ? JSON.stringify(post.reactions) : null,
            sourceDate,
            existing.id,
          ],
        );
      } else {
        runSql(
          `INSERT INTO source_posts (profile_id, channel, telegram_post_id, source_date, text, entities, media_paths, views, reactions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            profileId,
            username,
            post.id,
            sourceDate,
            post.text,
            post.entities,
            storedMediaPaths,
            post.views,
            post.reactions ? JSON.stringify(post.reactions) : null,
          ],
        );
      }
    }
  }

  /**
   * Scrape multiple channels. Saves results to source_posts table.
   * @param {string[]} [channelsList] - list of channel usernames. If not provided, reads from data/channels.json
   */
  async scrapeAll(channelsList, options = {}) {
    const profileId = options.profileId || 'default';
    const lookbackHours = options.lookbackHours || config.limits.lookbackHours;
    const limitOverride = Number.isFinite(Number(options.limitOverride)) ? Number(options.limitOverride) : null;
    let channels = channelsList;

    if (!channels) {
      const channelsFile = path.join(config.paths.data, 'channels.json');
      try {
        const raw = fs.readFileSync(channelsFile, 'utf-8');
        const parsed = JSON.parse(raw);
        channels = parsed.channels || parsed;
      } catch (err) {
        logger.error(`TelegramScraper: не удалось прочитать channels.json: ${err.message}`);
        return [];
      }
    }

    const allResults = [];

    for (const channelEntry of channels) {
      const username = typeof channelEntry === 'string' ? channelEntry : channelEntry.username;
      if (!username) {
        logger.warn('TelegramScraper: пропущен канал без username');
        continue;
      }

      try {
        logger.info(`TelegramScraper: start ${username}`);
        await rateLimiter.waitForSlot('telegram_scrape');
        const limit = limitOverride || ((typeof channelEntry === 'object' && channelEntry.max_posts) || 50);
        const startedAt = Date.now();

        const result = await this.scrapeChannel(username, {
          limit,
          lookbackHours,
        });
        allResults.push(result);
        this.persistChannelPosts(result, { profileId });

        const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
        logger.info(`TelegramScraper: ${username} - сохранено в БД (${durationSec}s)`);
      } catch (err) {
        logger.error(`TelegramScraper: ошибка при скрапинге ${username}: ${err.message}`);
      }
    }

    return allResults;
  }

  async disconnect() {
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch (err) {
        logger.debug(`TelegramScraper disconnect: ${err.message}`);
      }
      this.client = null;
      logger.info('TelegramScraper: отключен от Telegram');
    }
  }
}

module.exports = TelegramScraper;
