const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const updates = require('telegram/client/updates');
const { getPeerId } = require('telegram/Utils');
const { config } = require('../config');
const logger = require('../utils/logger');
const { getTelegramEntityLength } = require('../generator/formatBuilder');

// Publishing does not need GramJS update polling.
updates._updateLoop = async function () {};

class TelegramUserPublisher {
  constructor() {
    this.apiId = config.telegram.apiId;
    this.apiHash = config.telegram.apiHash;
    this.sessionString = config.telegram.sessionString;
    this.client = null;
  }

  async _getClient() {
    if (this.client) {
      return this.client;
    }

    if (!this.sessionString) {
      throw new Error('TELEGRAM_SESSION_STRING is required for MTProto publishing');
    }

    const session = new StringSession(this.sessionString);
    this.client = new TelegramClient(session, this.apiId, this.apiHash, {
      connectionRetries: 3,
    });
    await this.client.connect();
    this.client.setParseMode('html');
    logger.info('TelegramUserPublisher: connected via MTProto');
    return this.client;
  }

  _normalizeHtmlForMtproto(text) {
    return String(text || '')
      .replace(/<tg-spoiler>/g, '<spoiler>')
      .replace(/<\/tg-spoiler>/g, '</spoiler>');
  }

  _getMediaPaths(post) {
    return Array.isArray(post.media?.paths)
      ? post.media.paths.filter(Boolean)
      : (post.media?.path ? [post.media.path] : []);
  }

  async _resolveTargetEntity(client, channelId) {
    const raw = String(channelId || '').trim();

    try {
      if (/^-?\d+$/.test(raw)) {
        return await client.getInputEntity(Number(raw));
      }
      return await client.getInputEntity(raw);
    } catch (err) {
      logger.warn(`TelegramUserPublisher: direct entity resolve failed for ${raw}: ${err.message}`);
    }

    const dialogs = await client.getDialogs({ limit: 200, ignoreMigrated: true });
    const match = dialogs.find((dialog) => String(dialog.id) === raw);
    if (match?.inputEntity) {
      logger.info(`TelegramUserPublisher: resolved ${raw} via dialogs cache (${match.title || 'untitled'})`);
      return match.inputEntity;
    }

    const altMatch = dialogs.find((dialog) => {
      try {
        return String(getPeerId(dialog.entity)) === raw;
      } catch {
        return false;
      }
    });
    if (altMatch?.inputEntity) {
      logger.info(`TelegramUserPublisher: resolved ${raw} via dialog entity (${altMatch.title || 'untitled'})`);
      return altMatch.inputEntity;
    }

    throw new Error(`MTProto user cannot resolve target channel ${raw}. Open the channel once from this account and make sure it is an admin there.`);
  }

  async publish(post, channelId) {
    const client = await this._getClient();
    const entity = await this._resolveTargetEntity(client, channelId);
    const text = this._normalizeHtmlForMtproto(post.text);
    const textLength = getTelegramEntityLength(text);
    const mediaPaths = this._getMediaPaths(post).slice(0, 10);

    if (mediaPaths.length > 0) {
      if (mediaPaths.length > 1) {
        const caption = text && textLength <= 1024
          ? [text, ...new Array(Math.max(0, mediaPaths.length - 1)).fill('')]
          : '';
        const albumResult = await client.sendFile(entity, {
          file: mediaPaths,
          caption,
          parseMode: 'html',
          forceDocument: false,
        });

        if (text && textLength > 1024) {
          const textMessage = await client.sendMessage(entity, {
            message: text,
            parseMode: 'html',
            linkPreview: false,
          });
          return {
            message_id: Array.isArray(albumResult) ? albumResult[0]?.id : albumResult?.id,
            text_message_id: textMessage.id,
          };
        }

        return { message_id: Array.isArray(albumResult) ? albumResult[0]?.id : albumResult?.id };
      }

      const filePath = mediaPaths[0];

      if (text && textLength <= 1024) {
        const message = await client.sendFile(entity, {
          file: filePath,
          caption: text,
          parseMode: 'html',
          forceDocument: false,
        });
        return { message_id: message.id };
      }

      const mediaMessage = await client.sendFile(entity, {
        file: filePath,
        forceDocument: false,
      });

      if (text) {
        const textMessage = await client.sendMessage(entity, {
          message: text,
          parseMode: 'html',
          linkPreview: false,
        });
        return { message_id: textMessage.id, media_message_id: mediaMessage.id };
      }

      return { message_id: mediaMessage.id };
    }

    const message = await client.sendMessage(entity, {
      message: text,
      parseMode: 'html',
      linkPreview: false,
    });
    return { message_id: message.id };
  }

  async close() {
    if (!this.client) {
      return;
    }

    try {
      await this.client.disconnect();
    } catch (err) {
      logger.debug(`TelegramUserPublisher disconnect skipped: ${err.message}`);
    }
    this.client = null;
  }
}

module.exports = { TelegramUserPublisher };
