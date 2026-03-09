const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const updates = require('telegram/client/updates');
const { config } = require('../config');
const { runSql } = require('../utils/dbHelpers');
const rateLimiter = require('../utils/rateLimiter');
const logger = require('../utils/logger');
const mediaSaver = require('./mediaSaver');
const fs = require('fs');
const path = require('path');

// Патч: GramJS вызывает _updateLoop(client) как standalone функцию из модуля updates.
// Для скрейпинга ping/update loop не нужен — он только кидает TIMEOUT ошибки.
updates._updateLoop = async function () {};

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
   * @param {string} username — channel username (without @)
   * @param {object} options
   * @param {number} options.limit — max messages to fetch (default 50)
   * @returns {object} — { channel, channelTitle, posts: [...] }
   */
  async scrapeChannel(username, options = {}) {
    const limit = options.limit || 50;
    const entity = await this.client.getEntity(username);
    const channelTitle = entity.title || username;

    const messages = await this.client.getMessages(entity, { limit });

    const posts = [];
    for (const msg of messages) {
      const post = {
        id: msg.id,
        date: msg.date,
        text: msg.message || '',
        views: msg.views || 0,
        forwards: msg.forwards || 0,
        reactions: null,
      };

      // Extract reactions if available
      if (msg.reactions && msg.reactions.results) {
        post.reactions = msg.reactions.results.map(r => ({
          emoji: r.reaction.emoticon || r.reaction.documentId || '?',
          count: r.count,
        }));
      }

      // Download photo if present
      if (msg.photo) {
        const mediaPath = await mediaSaver.downloadMedia(this.client, msg, username);
        if (mediaPath) {
          post.mediaPath = mediaPath;
        }
      }

      posts.push(post);
    }

    logger.info(`TelegramScraper: ${username} — получено ${posts.length} постов`);
    return { channel: username, channelTitle, posts };
  }

  /**
   * Scrape multiple channels. Saves results to source_posts table.
   * @param {string[]} [channelsList] — list of channel usernames. If not provided, reads from data/channels.json
   */
  async scrapeAll(channelsList) {
    let channels = channelsList;

    if (!channels) {
      const channelsFile = path.join(config.paths.data, 'channels.json');
      try {
        const raw = fs.readFileSync(channelsFile, 'utf-8');
        const parsed = JSON.parse(raw);
        // channels.json имеет формат { channels: [...], settings: {...} }
        channels = parsed.channels || parsed;
      } catch (err) {
        logger.error(`TelegramScraper: не удалось прочитать channels.json: ${err.message}`);
        return [];
      }
    }

    const allResults = [];

    for (const channelEntry of channels) {
      // channelEntry может быть строкой ("username") или объектом ({ username, ... })
      const username = typeof channelEntry === 'string' ? channelEntry : channelEntry.username;
      if (!username) {
        logger.warn('TelegramScraper: пропущен канал без username');
        continue;
      }

      try {
        await rateLimiter.waitForSlot('telegram_scrape');
        const limit = (typeof channelEntry === 'object' && channelEntry.max_posts) || 50;
        const result = await this.scrapeChannel(username, { limit });
        allResults.push(result);

        // Save each post to database
        for (const post of result.posts) {
          runSql(
            `INSERT INTO source_posts (channel, telegram_post_id, text, media_paths, views, reactions)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              username,
              post.id,
              post.text,
              post.mediaPath || null,
              post.views,
              post.reactions ? JSON.stringify(post.reactions) : null,
            ]
          );
        }

        logger.info(`TelegramScraper: ${username} — сохранено в БД`);
      } catch (err) {
        logger.error(`TelegramScraper: ошибка при скрапинге ${username}: ${err.message}`);
        // Continue to next channel
      }
    }

    return allResults;
  }

  async disconnect() {
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch (err) {
        // Игнорируем ошибки при отключении (TIMEOUT от update loop)
        logger.debug(`TelegramScraper disconnect: ${err.message}`);
      }
      this.client = null;
      logger.info('TelegramScraper: отключен от Telegram');
    }
  }
}

module.exports = TelegramScraper;
