const { config } = require('../config');
const { queryOne } = require('../utils/dbHelpers');
const logger = require('../utils/logger');

class QueueManager {
  constructor(telegramPublisher) {
    this.publisher = telegramPublisher;
    this.queue = [];
    this._idCounter = 0;
  }

  /**
   * Добавляет пост в очередь
   * @param {object} post — { text, media?, keyboard? }
   * @returns {number} id элемента в очереди
   */
  addToQueue(post) {
    this._idCounter += 1;
    const item = {
      id: this._idCounter,
      post,
      status: 'pending',
      createdAt: new Date(),
    };
    this.queue.push(item);
    logger.info(`Пост добавлен в очередь, id=${item.id}`);
    return item.id;
  }

  /**
   * Обрабатывает очередь: публикует или отправляет на ревью
   */
  async processQueue() {
    const pending = this.queue.filter((item) => item.status === 'pending');
    if (pending.length === 0) {
      logger.debug('Очередь пуста, нечего обрабатывать');
      return;
    }

    // Проверяем минимальный интервал между постами
    const minIntervalMs = config.limits.minPostInterval * 60 * 1000;
    try {
      const lastPost = queryOne(
        'SELECT published_at FROM posts WHERE published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1'
      );

      if (lastPost && lastPost.published_at) {
        const lastTime = new Date(lastPost.published_at + 'Z').getTime();
        const elapsed = Date.now() - lastTime;
        if (elapsed < minIntervalMs) {
          const waitMin = Math.ceil((minIntervalMs - elapsed) / 60000);
          logger.info(`Слишком рано для публикации, подождите ещё ~${waitMin} мин.`);
          return;
        }
      }
    } catch (err) {
      logger.warn(`Не удалось проверить интервал публикации: ${err.message}`);
    }

    for (const item of pending) {
      try {
        if (config.modes.autoPublish && !config.modes.reviewMode) {
          // Публикуем напрямую
          const channelId = config.telegram.channelId;
          if (!channelId) {
            logger.error('TELEGRAM_CHANNEL_ID не задан, невозможно опубликовать');
            return;
          }
          await this.publisher.publish(item.post, channelId);
          item.status = 'published';
          logger.info(`Пост ${item.id} опубликован автоматически`);
        } else if (config.modes.reviewMode) {
          // Отправляем на ревью админу
          await this.publisher.sendToAdmin(item.post, item.id);
          item.status = 'pending'; // остаётся pending до решения админа
          logger.info(`Пост ${item.id} отправлен на ревью`);
        } else {
          logger.info(`Пост ${item.id} в очереди, autoPublish=false, reviewMode=false`);
        }
      } catch (err) {
        logger.error(`Ошибка обработки поста ${item.id}: ${err.message}`);
      }
    }
  }

  /**
   * Регистрирует callback-обработчики для кнопок Approve/Reject
   * @param {import('telegraf').Telegraf} bot — экземпляр Telegraf
   */
  setupAdminCallbacks(bot) {
    bot.action(/^approve_(\d+)/, async (ctx) => {
      const postId = parseInt(ctx.match[1], 10);
      const item = this.queue.find((q) => q.id === postId);

      if (!item) {
        await ctx.answerCbQuery('Пост не найден в очереди');
        return;
      }

      try {
        const channelId = config.telegram.channelId;
        if (!channelId) {
          await ctx.answerCbQuery('CHANNEL_ID не задан');
          return;
        }

        await this.publisher.publish(item.post, channelId);
        item.status = 'published';
        await ctx.answerCbQuery('Опубликовано ✅');
        await ctx.editMessageReplyMarkup(undefined);
        logger.info(`Пост ${postId} одобрен и опубликован админом`);
      } catch (err) {
        logger.error(`Ошибка публикации одобренного поста ${postId}: ${err.message}`);
        await ctx.answerCbQuery('Ошибка публикации');
      }
    });

    bot.action(/^reject_(\d+)/, async (ctx) => {
      const postId = parseInt(ctx.match[1], 10);
      const item = this.queue.find((q) => q.id === postId);

      if (item) {
        item.status = 'rejected';
        logger.info(`Пост ${postId} отклонён админом`);
      }

      await ctx.answerCbQuery('Отклонено');
      await ctx.editMessageReplyMarkup(undefined);
    });

    logger.info('Admin callback-обработчики зарегистрированы');
  }

  /**
   * Возвращает статистику очереди
   */
  getQueueStatus() {
    const counts = { pending: 0, approved: 0, published: 0, rejected: 0 };
    for (const item of this.queue) {
      if (counts[item.status] !== undefined) {
        counts[item.status] += 1;
      }
    }
    return counts;
  }
}

module.exports = { QueueManager };
