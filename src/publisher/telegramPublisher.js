const { Telegraf } = require('telegraf');
const { config } = require('../config');
const { runSql } = require('../utils/dbHelpers');
const logger = require('../utils/logger');
const { getTelegramEntityLength } = require('../generator/formatBuilder');
const { TelegramUserPublisher } = require('./telegramUserPublisher');

class TelegramPublisher {
  constructor() {
    this.bot = new Telegraf(config.telegram.botToken);
    this.userPublisher = config.telegram.sessionString ? new TelegramUserPublisher() : null;
    logger.info('TelegramPublisher initialized');
  }

  _getAdminChatIds() {
    const ids = Array.isArray(config.telegram.adminChatIds)
      ? config.telegram.adminChatIds.filter(Boolean)
      : [];
    if (ids.length > 0) return ids;
    return config.telegram.adminChatId ? [config.telegram.adminChatId] : [];
  }

  async publish(post, channelId) {
    try {
      if (Math.random() < 0.2) {
        logger.debug('Sticker skipped (MVP placeholder)');
      }

      const delay = Math.random() * 2000 + 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));

      const replyMarkup = (post.keyboard && post.keyboard.inline_keyboard)
        ? post.keyboard
        : undefined;
      const mediaPaths = Array.isArray(post.media?.paths)
        ? post.media.paths.filter(Boolean)
        : (post.media?.path ? [post.media.path] : []);

      const result = this.userPublisher
        ? await this.userPublisher.publish(post, channelId)
        : await this._sendPost(channelId, post, replyMarkup, mediaPaths);
      const messageId = result.message_id;

      try {
        runSql(
          "UPDATE posts SET telegram_message_id = ?, published_at = datetime('now') WHERE id = (SELECT MAX(id) FROM posts)",
          [messageId]
        );
      } catch (dbErr) {
        logger.error(`Error saving message_id to DB: ${dbErr.message}`);
      }

      logger.info(`Post published to ${channelId}, message_id=${messageId}`);
      return messageId;
    } catch (err) {
      logger.error(`Publish error in ${channelId}: ${err.message}`);

      if (
        err.code === 'ETIMEDOUT' ||
        err.code === 'ECONNRESET' ||
        err.code === 'ENOTFOUND' ||
        err.message.includes('network')
      ) {
        logger.info('Retrying publish...');
        try {
          await new Promise((resolve) => setTimeout(resolve, 3000));

          const replyMarkup = (post.keyboard && post.keyboard.inline_keyboard)
            ? post.keyboard
            : undefined;
          const mediaPaths = Array.isArray(post.media?.paths)
            ? post.media.paths.filter(Boolean)
            : (post.media?.path ? [post.media.path] : []);

          const retryResult = this.userPublisher
            ? await this.userPublisher.publish(post, channelId)
            : await this._sendPost(channelId, post, replyMarkup, mediaPaths);
          logger.info(`Post published after retry, message_id=${retryResult.message_id}`);
          return retryResult.message_id;
        } catch (retryErr) {
          logger.error(`Retry failed: ${retryErr.message}`);
          throw retryErr;
        }
      }

      throw err;
    }
  }

  async _sendPost(channelId, post, replyMarkup, mediaPaths) {
    const textLength = getTelegramEntityLength(post.text);

    if (post.media && post.media.type === 'photo' && mediaPaths.length > 0) {
      if (mediaPaths.length > 1) {
        const mediaGroup = mediaPaths.slice(0, 10).map((mediaPath, index) => {
          const item = { type: 'photo', media: { source: mediaPath } };
          if (index === 0 && textLength <= 1024) {
            item.caption = post.text;
            item.parse_mode = 'HTML';
          }
          return item;
        });

        const groupResult = await this.bot.telegram.sendMediaGroup(channelId, mediaGroup);

        if (textLength > 1024) {
          return this.bot.telegram.sendMessage(channelId, post.text, {
            parse_mode: 'HTML',
            reply_markup: replyMarkup,
          });
        }

        if (replyMarkup) {
          await this.bot.telegram.sendMessage(channelId, '\u200B', {
            reply_markup: replyMarkup,
          });
        }

        return groupResult[0];
      }

      if (textLength <= 1024) {
        return this.bot.telegram.sendPhoto(
          channelId,
          { source: mediaPaths[0] },
          {
            caption: post.text,
            parse_mode: 'HTML',
            reply_markup: replyMarkup,
          },
        );
      }

      await this.bot.telegram.sendPhoto(channelId, { source: mediaPaths[0] });
      return this.bot.telegram.sendMessage(channelId, post.text, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
    }

    return this.bot.telegram.sendMessage(channelId, post.text, {
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });
  }

  _buildAdminKeyboard(postId) {
    return {
      inline_keyboard: [
        [
          { text: 'Approve ✅', callback_data: `approve_${postId}` },
          { text: 'Reject ❌', callback_data: `reject_${postId}` },
        ],
        [
          { text: 'Replace Source 🖼', callback_data: `replace_source_${postId}` },
        ],
      ],
    };
  }

  async clearAdminReplyMarkups(refs = []) {
    for (const ref of refs) {
      if (!ref?.chatId || !ref?.messageId) continue;
      try {
        await this.bot.telegram.editMessageReplyMarkup(ref.chatId, ref.messageId, undefined, undefined);
      } catch (err) {
        logger.debug(`Admin keyboard cleanup skipped for ${ref.chatId}/${ref.messageId}: ${err.message}`);
      }
    }
  }

  async _sendReviewToChat(adminChatId, post, postId, header, keyboard) {
    const previewText = post.text.length > 3500
      ? post.text.slice(0, 3500) + '...'
      : post.text;
    const previewCaptionLength = getTelegramEntityLength(`${header} (ID: ${postId})\n\n${previewText}`);
    const mediaPaths = Array.isArray(post.media?.paths)
      ? post.media.paths.filter(Boolean)
      : (post.media?.path ? [post.media.path] : []);

    if (mediaPaths.length > 1) {
      const mediaGroup = mediaPaths.slice(0, 10).map((mediaPath, index) => {
        const item = { type: 'photo', media: { source: mediaPath } };
        if (index === 0) {
          const cap = `${header} (ID: ${postId})`;
          item.caption = cap.length <= 1024 ? cap : cap.slice(0, 1024);
        }
        return item;
      });
      await this.bot.telegram.sendMediaGroup(adminChatId, mediaGroup);

      const message = await this.bot.telegram.sendMessage(
        adminChatId,
        `${header} (ID: ${postId})\n\n${previewText}`,
        {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        },
      );
      return [{ chatId: adminChatId, messageId: message.message_id }];
    }

    if (mediaPaths.length === 1) {
      const caption = `${header} (ID: ${postId})\n\n${previewText}`;
      if (previewCaptionLength <= 1024) {
        const message = await this.bot.telegram.sendPhoto(
          adminChatId,
          { source: mediaPaths[0] },
          {
            caption,
            parse_mode: 'HTML',
            reply_markup: keyboard,
          },
        );
        return [{ chatId: adminChatId, messageId: message.message_id }];
      }

      await this.bot.telegram.sendPhoto(adminChatId, { source: mediaPaths[0] });
      const message = await this.bot.telegram.sendMessage(
        adminChatId,
        `${header} (ID: ${postId})\n\n${previewText}`,
        {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        },
      );
      return [{ chatId: adminChatId, messageId: message.message_id }];
    }

    const message = await this.bot.telegram.sendMessage(
      adminChatId,
      `${header} (ID: ${postId})\n\n${previewText}`,
      {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      },
    );
    return [{ chatId: adminChatId, messageId: message.message_id }];
  }

  async sendToAdmin(post, postId, options = {}) {
    const adminChatIds = this._getAdminChatIds();
    if (adminChatIds.length === 0) {
      logger.warn('TELEGRAM_ADMIN_CHAT_ID not set, skipping review send');
      return [];
    }

    try {
      const header = options.header || '📝 Post for review';
      const keyboard = this._buildAdminKeyboard(postId);
      const refs = [];
      let lastError = null;

      for (const adminChatId of adminChatIds) {
        try {
          const sentRefs = await this._sendReviewToChat(adminChatId, post, postId, header, keyboard);
          refs.push(...sentRefs);
        } catch (err) {
          lastError = err;
          logger.error(`Error sending review to admin ${adminChatId}: ${err.message}`);
        }
      }

      if (refs.length === 0 && lastError) {
        throw lastError;
      }

      logger.info(`Post ${postId} sent for admin review (${refs.length} messages)`);
      return refs;
    } catch (err) {
      logger.error(`Error sending for review: ${err.message}`);
      throw err;
    }
  }

  getBot() {
    return this.bot;
  }

  async close() {
    if (this.userPublisher) {
      await this.userPublisher.close();
    }
  }
}

module.exports = { TelegramPublisher };
