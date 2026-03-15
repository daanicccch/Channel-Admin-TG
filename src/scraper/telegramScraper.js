const { TelegramClient, Api } = require('telegram');
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
const { getMessageMediaType } = require('../utils/mediaUtils');

// Patch GramJS update loop: for scraping we do not need updates/ping loop.
updates._updateLoop = async function () {};

const ENTITY_TIMEOUT_MS = parseInt(process.env.TG_ENTITY_TIMEOUT_MS || '15000', 10);
const MESSAGES_TIMEOUT_MS = parseInt(process.env.TG_MESSAGES_TIMEOUT_MS || '30000', 10);
const MEDIA_TIMEOUT_MS = parseInt(process.env.TG_MEDIA_TIMEOUT_MS || '12000', 10);
const VIDEO_MEDIA_TIMEOUT_MS = parseInt(process.env.TG_VIDEO_TIMEOUT_MS || '90000', 10);
const MAX_MEDIA_PER_CHANNEL = parseInt(process.env.TG_MAX_MEDIA_PER_CHANNEL || '8', 10);

function stripTelegramDecorators(value) {
  return String(value || '').trim().replace(/^@/, '');
}

function extractInviteHash(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const directMatch = raw.match(/^\+([A-Za-z0-9_-]+)$/);
  if (directMatch) return directMatch[1];

  const normalized = raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/^telegram\.me\//i, 't.me/');
  const inviteMatch = normalized.match(/^t\.me\/\+([A-Za-z0-9_-]+)$/i)
    || normalized.match(/^t\.me\/joinchat\/([A-Za-z0-9_-]+)$/i);

  return inviteMatch ? inviteMatch[1] : '';
}

function extractUsernameFromUrl(value) {
  const normalized = String(value || '').trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/^telegram\.me\//i, 't.me/');
  const match = normalized.match(/^t\.me\/([A-Za-z0-9_]{5,})$/i);
  if (!match) return '';
  if (match[1].startsWith('+')) return '';
  if (match[1].toLowerCase() === 'joinchat') return '';
  return match[1];
}

function sanitizeChannelKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

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
    this.pendingMediaDownloads = new Set();
  }

  _trackPendingMediaDownload(promise) {
    this.pendingMediaDownloads.add(promise);
    promise.finally(() => {
      this.pendingMediaDownloads.delete(promise);
    });
    return promise;
  }

  async _waitForPendingMediaDownloads() {
    if (this.pendingMediaDownloads.size === 0) {
      return;
    }

    const pending = Array.from(this.pendingMediaDownloads);
    logger.info(`TelegramScraper: waiting for ${pending.length} pending media download(s) before disconnect`);
    await Promise.allSettled(pending);
  }

  async connect() {
    const session = new StringSession(this.sessionString);
    this.client = new TelegramClient(session, this.apiId, this.apiHash, {
      connectionRetries: 3,
    });
    await this.client.connect();
    logger.info('TelegramScraper: подключен к Telegram');
  }

  normalizeChannelEntry(channelEntry) {
    if (typeof channelEntry === 'string') {
      const trimmed = channelEntry.trim();
      const inviteHash = extractInviteHash(trimmed);
      if (inviteHash) {
        return {
          input: trimmed,
          key: `invite_${sanitizeChannelKey(inviteHash)}`,
          label: trimmed,
          type: 'invite',
        };
      }

      const username = stripTelegramDecorators(extractUsernameFromUrl(trimmed) || trimmed);
      return username
        ? {
            input: username,
            key: sanitizeChannelKey(username),
            label: username,
            type: 'username',
          }
        : null;
    }

    if (!channelEntry || typeof channelEntry !== 'object') {
      return null;
    }

    const inviteLink = String(channelEntry.invite_link || '').trim();
    const usernameRaw = String(channelEntry.username || '').trim();
    const inviteHash = extractInviteHash(inviteLink || usernameRaw);

    if (inviteHash) {
      const username = stripTelegramDecorators(extractUsernameFromUrl(usernameRaw) || usernameRaw);
      return {
        input: inviteLink || usernameRaw,
        key: username && !extractInviteHash(username) ? sanitizeChannelKey(username) : `invite_${sanitizeChannelKey(inviteHash)}`,
        label: username && !extractInviteHash(username) ? username : (inviteLink || usernameRaw),
        type: 'invite',
      };
    }

    const username = stripTelegramDecorators(extractUsernameFromUrl(usernameRaw) || usernameRaw);
    if (!username) {
      return null;
    }

    return {
      input: username,
      key: sanitizeChannelKey(username),
      label: username,
      type: 'username',
    };
  }

  async _resolveChannelEntity(channelRef) {
    if (!channelRef?.input) {
      throw new Error('Channel reference is empty or invalid');
    }

    const inviteHash = extractInviteHash(channelRef.input);
    if (inviteHash) {
      const invite = await withTimeout(
        this.client.invoke(new Api.messages.CheckChatInvite({ hash: inviteHash })),
        ENTITY_TIMEOUT_MS,
        `checkChatInvite:${channelRef.key}`
      );

      if (invite?.className === 'ChatInviteAlready' && invite.chat) {
        return invite.chat;
      }

      throw new Error(`Invite link is not readable for this session: ${channelRef.input}`);
    }

    return withTimeout(
      this.client.getEntity(channelRef.input),
      ENTITY_TIMEOUT_MS,
      `getEntity:${channelRef.input}`
    );
  }

  /**
   * Scrape messages from a single channel.
   * @param {string|object} channelInput - channel username or invite_link reference
   * @param {object} options
   * @param {number} options.limit - max messages to fetch (default 50)
   * @returns {object} - { channel, channelTitle, posts: [...] }
   */
  async scrapeChannel(channelInput, options = {}) {
    const channelRef = typeof channelInput === 'object' && channelInput?.input
      ? channelInput
      : this.normalizeChannelEntry(channelInput);
    if (!channelRef) {
      throw new Error('Channel reference is empty or invalid');
    }

    const limit = options.limit || 50;
    const lookbackHours = options.lookbackHours || config.limits.lookbackHours || 24;
    const cutoffMs = Date.now() - (lookbackHours * 60 * 60 * 1000);
    const entity = await this._resolveChannelEntity(channelRef);
    const channelKey = channelRef.key || sanitizeChannelKey(entity?.username || channelRef.label);
    const channelTitle = entity.title || channelRef.label || channelKey;

    const messages = await withTimeout(
      this.client.getMessages(entity, { limit }),
      MESSAGES_TIMEOUT_MS,
      `getMessages:${channelKey}`
    );

    const posts = await this._buildPostsFromMessages(messages, channelKey, channelTitle, cutoffMs);

    logger.info(`TelegramScraper: ${channelRef.label || channelKey} - получено ${posts.length} постов`);
    return { channel: channelKey, channelTitle, posts };
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
        post.reactions = msg.reactions.results.map((r) => ({
          emoji: r.reaction.emoticon || r.reaction.documentId || '?',
          count: r.count,
        }));
      }

      const mediaType = getMessageMediaType(msg);
      const hasVisualMedia = mediaType === 'photo' || mediaType === 'video';
      if (hasVisualMedia && post.mediaPaths.length < MAX_MEDIA_PER_CHANNEL) {
        try {
          const mediaDownload = this._trackPendingMediaDownload(
            mediaSaver.downloadMedia(this.client, msg, username)
          );
          const mediaPath = await withTimeout(
            mediaDownload,
            mediaType === 'video' ? VIDEO_MEDIA_TIMEOUT_MS : MEDIA_TIMEOUT_MS,
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
      const channelRef = this.normalizeChannelEntry(channelEntry);
      if (!channelRef) {
        logger.warn('TelegramScraper: пропущен канал без username/invite_link');
        continue;
      }

      try {
        logger.info(`TelegramScraper: start ${channelRef.label}`);
        await rateLimiter.waitForSlot('telegram_scrape');
        const limit = limitOverride || ((typeof channelEntry === 'object' && channelEntry.max_posts) || 50);
        const startedAt = Date.now();

        const result = await this.scrapeChannel(channelRef, {
          limit,
          lookbackHours,
        });
        allResults.push(result);
        this.persistChannelPosts(result, { profileId });

        const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
        logger.info(`TelegramScraper: ${channelRef.label} - сохранено в БД (${durationSec}s)`);
      } catch (err) {
        logger.error(`TelegramScraper: ошибка при скрапинге ${channelRef.label}: ${err.message}`);
      }
    }

    return allResults;
  }

  async disconnect() {
    if (this.client) {
      try {
        await this._waitForPendingMediaDownloads();
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
