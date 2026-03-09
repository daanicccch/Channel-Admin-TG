const { Telegraf } = require('telegraf');
const { config } = require('../config');
const { runSql } = require('../utils/dbHelpers');
const logger = require('../utils/logger');

class TelegramPublisher {
  constructor() {
    this.bot = new Telegraf(config.telegram.botToken);
    logger.info('TelegramPublisher инициализирован');
  }

  /**
   * Публикует пост в канал
   * @param {object} post — { text, media?: { type, path }, keyboard? }
   * @param {string} channelId — ID канала (напр. "@my_channel" или числовой)
   * @returns {number} messageId отправленного сообщения
   */
  async publish(post, channelId) {
    try {
      // Случайный шанс 1/5 — отправить стикер перед постом (заглушка для MVP)
      if (Math.random() < 0.2) {
        logger.debug('Стикер пропущен (MVP заглушка)');
      }

      // Случайная задержка 1-3 секунды для натуральности
      const delay = Math.random() * 2000 + 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));

      // keyboard должен быть объектом { inline_keyboard: [...] } или undefined
      const replyMarkup = (post.keyboard && post.keyboard.inline_keyboard)
        ? post.keyboard
        : undefined;

      let result;

      if (post.media && post.media.type === 'photo') {
        if (post.text.length <= 1024) {
          // Текст помещается в caption
          result = await this.bot.telegram.sendPhoto(
            channelId,
            { source: post.media.path },
            {
              caption: post.text,
              parse_mode: 'HTML',
              reply_markup: replyMarkup,
            },
          );
        } else {
          // Текст слишком длинный для caption — отправляем фото + текст отдельно
          await this.bot.telegram.sendPhoto(channelId, { source: post.media.path });
          result = await this.bot.telegram.sendMessage(channelId, post.text, {
            parse_mode: 'HTML',
            reply_markup: replyMarkup,
          });
        }
      } else {
        result = await this.bot.telegram.sendMessage(channelId, post.text, {
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
        });
      }

      const messageId = result.message_id;

      // Сохраняем telegram_message_id в БД
      try {
        runSql(
          "UPDATE posts SET telegram_message_id = ?, published_at = datetime('now') WHERE id = (SELECT MAX(id) FROM posts)",
          [messageId]
        );
      } catch (dbErr) {
        logger.error('Ошибка записи message_id в БД:', dbErr.message);
      }

      logger.info(`Пост опубликован в ${channelId}, message_id=${messageId}`);
      return messageId;
    } catch (err) {
      logger.error(`Ошибка публикации в ${channelId}: ${err.message}`);

      // Одна повторная попытка при сетевых ошибках
      if (
        err.code === 'ETIMEDOUT' ||
        err.code === 'ECONNRESET' ||
        err.code === 'ENOTFOUND' ||
        err.message.includes('network')
      ) {
        logger.info('Повторная попытка публикации...');
        try {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          let result;
          if (post.media && post.media.type === 'photo') {
            if (post.text.length <= 1024) {
              result = await this.bot.telegram.sendPhoto(
                channelId,
                { source: post.media.path },
                {
                  caption: post.text,
                  parse_mode: 'HTML',
                  reply_markup: replyMarkup,
                },
              );
            } else {
              await this.bot.telegram.sendPhoto(channelId, { source: post.media.path });
              result = await this.bot.telegram.sendMessage(channelId, post.text, {
                parse_mode: 'HTML',
                reply_markup: replyMarkup,
              });
            }
          } else {
            result = await this.bot.telegram.sendMessage(
              channelId,
              post.text,
              {
                parse_mode: 'HTML',
                reply_markup: replyMarkup,
              },
            );
          }
          logger.info(`Пост опубликован после повторной попытки, message_id=${result.message_id}`);
          return result.message_id;
        } catch (retryErr) {
          logger.error(`Повторная попытка не удалась: ${retryErr.message}`);
          throw retryErr;
        }
      }

      throw err;
    }
  }

  /**
   * Отправляет пост админу на ревью с кнопками Approve/Reject
   * @param {object} post — { text }
   * @param {number|string} postId — ID поста в очереди
   */
  async sendToAdmin(post, postId) {
    const adminChatId = config.telegram.adminChatId;
    if (!adminChatId) {
      logger.warn('TELEGRAM_ADMIN_CHAT_ID не задан, пропускаем отправку на ревью');
      return;
    }

    try {
      const previewText = post.text.length > 3500
        ? post.text.slice(0, 3500) + '...'
        : post.text;

      await this.bot.telegram.sendMessage(
        adminChatId,
        `📝 <b>Пост на ревью</b> (ID: ${postId})\n\n${previewText}`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Approve ✅', callback_data: `approve_${postId}` },
                { text: 'Reject ❌', callback_data: `reject_${postId}` },
              ],
            ],
          },
        },
      );

      logger.info(`Пост ${postId} отправлен на ревью админу`);
    } catch (err) {
      logger.error(`Ошибка отправки на ревью: ${err.message}`);
      throw err;
    }
  }

  /**
   * Возвращает экземпляр Telegraf бота (для регистрации callback-обработчиков)
   */
  getBot() {
    return this.bot;
  }
}

module.exports = { TelegramPublisher };
