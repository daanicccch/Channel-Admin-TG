const { config } = require('../config');
const { queryOne, queryAll } = require('../utils/dbHelpers');
const logger = require('../utils/logger');

const VALID_TYPES = ['digest', 'analysis', 'alert', 'weekly'];

// Хранилище постов, ожидающих решения админа (id → { post, type })
const pendingPosts = new Map();
let _idCounter = 0;

/**
 * Middleware: пропускает только админа (TELEGRAM_ADMIN_CHAT_ID)
 */
function adminOnly(ctx, next) {
  const adminId = config.telegram.adminChatId;
  if (!adminId) {
    return ctx.reply('TELEGRAM_ADMIN_CHAT_ID не задан в .env');
  }
  if (String(ctx.from.id) !== String(adminId)) {
    return ctx.reply('⛔ Нет доступа');
  }
  return next();
}

/**
 * Формирует inline-клавиатуру для preview поста
 */
function previewKeyboard(id, postType) {
  return {
    inline_keyboard: [
      [
        { text: 'Опубликовать ✅', callback_data: `cmd_approve_${id}` },
        { text: 'Перегенерировать 🔄', callback_data: `cmd_regen_${id}_${postType}` },
      ],
      [
        { text: 'Отмена ❌', callback_data: `cmd_cancel_${id}` },
      ],
    ],
  };
}

/**
 * Отправляет preview поста админу
 */
async function sendPreview(ctx, post, id, postType) {
  const previewText = post.text.length > 3500
    ? post.text.slice(0, 3500) + '...'
    : post.text;

  const header = `📋 <b>Preview</b> (ID: ${id}, тип: ${postType})\n\n`;

  await ctx.reply(header + previewText, {
    parse_mode: 'HTML',
    reply_markup: previewKeyboard(id, postType),
  });
}

/**
 * Запускает async-функцию в фоне, логируя ошибки если промис упадёт.
 */
function runInBackground(fn) {
  fn().catch((err) => logger.error(`Фоновая задача упала: ${err.message}`));
}

/**
 * Регистрирует команды и callback-обработчики на боте.
 *
 * @param {import('telegraf').Telegraf} bot
 * @param {{ generateOnly: function, publisher: import('../publisher/telegramPublisher').TelegramPublisher }} deps
 */
function setupCommands(bot, { generateOnly, publisher }) {
  // ─── /post <type> ───

  bot.command('post', adminOnly, async (ctx) => {
    const parts = ctx.message.text.split(/\s+/);
    const postType = parts[1] || 'digest';

    if (!VALID_TYPES.includes(postType)) {
      return ctx.reply(
        `❌ Неизвестный тип: <code>${postType}</code>\n\nДоступные: ${VALID_TYPES.join(', ')}`,
        { parse_mode: 'HTML' },
      );
    }

    const chatId = ctx.chat.id;

    await ctx.reply(`⏳ Генерация поста (<b>${postType}</b>)...\nЭто может занять 1-2 минуты.`, {
      parse_mode: 'HTML',
    });

    // Генерация в фоне — не блокируем middleware Telegraf
    runInBackground(async () => {
      try {
        const post = await generateOnly(postType);

        _idCounter += 1;
        const id = _idCounter;
        pendingPosts.set(id, { post, type: postType });

        const previewText = post.text.length > 3500
          ? post.text.slice(0, 3500) + '...'
          : post.text;

        const header = `📋 <b>Preview</b> (ID: ${id}, тип: ${postType})\n\n`;

        await bot.telegram.sendMessage(chatId, header + previewText, {
          parse_mode: 'HTML',
          reply_markup: previewKeyboard(id, postType),
        });

        logger.info(`Команда /post ${postType}: preview отправлен, id=${id}`);
      } catch (err) {
        logger.error(`Ошибка команды /post: ${err.message}`);
        await bot.telegram.sendMessage(chatId, `❌ Ошибка генерации: ${err.message}`);
      }
    });
  });

  // ─── /status ───

  bot.command('status', adminOnly, async (ctx) => {
    try {
      const todayRow = queryOne(
        "SELECT COUNT(*) as cnt FROM posts WHERE published_at >= date('now')"
      );
      const totalRow = queryOne(
        'SELECT COUNT(*) as cnt FROM posts WHERE published_at IS NOT NULL'
      );

      const todayCount = todayRow ? todayRow.cnt : 0;
      const totalCount = totalRow ? totalRow.cnt : 0;
      const pendingCount = pendingPosts.size;

      const aiProvider = config.ai.geminiKey ? 'Gemini 2.5 Flash' : 'Qwen';

      const text = [
        '📊 <b>Статус бота</b>',
        '',
        `📝 Постов сегодня: <b>${todayCount}</b>`,
        `📚 Постов всего: <b>${totalCount}</b>`,
        `🤖 AI: <b>${aiProvider}</b>`,
        `⏰ Режим: <b>auto</b>`,
        `📬 Ожидают решения: <b>${pendingCount}</b>`,
      ].join('\n');

      await ctx.reply(text, { parse_mode: 'HTML' });
    } catch (err) {
      logger.error(`Ошибка команды /status: ${err.message}`);
      await ctx.reply(`❌ Ошибка: ${err.message}`);
    }
  });

  // ─── Callback: Опубликовать ───

  bot.action(/^cmd_approve_(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    const entry = pendingPosts.get(id);

    if (!entry) {
      return ctx.answerCbQuery('Пост не найден (возможно, уже обработан)');
    }

    try {
      const channelId = config.telegram.channelId;
      if (!channelId) {
        return ctx.answerCbQuery('TELEGRAM_CHANNEL_ID не задан');
      }

      await publisher.publish(entry.post, channelId);
      pendingPosts.delete(id);

      await ctx.answerCbQuery('Опубликовано ✅');
      await ctx.editMessageReplyMarkup(undefined);
      logger.info(`Пост ${id} опубликован через команду`);
    } catch (err) {
      logger.error(`Ошибка публикации поста ${id}: ${err.message}`);
      await ctx.answerCbQuery('Ошибка публикации');
    }
  });

  // ─── Callback: Перегенерировать ───

  bot.action(/^cmd_regen_(\d+)_(\w+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    const postType = ctx.match[2];

    if (!pendingPosts.has(id)) {
      return ctx.answerCbQuery('Пост не найден');
    }

    const chatId = ctx.chat.id;

    await ctx.answerCbQuery('🔄 Перегенерация...');
    await ctx.editMessageReplyMarkup(undefined);

    await bot.telegram.sendMessage(chatId, `🔄 Перегенерация (<b>${postType}</b>)...\nЭто может занять 1-2 минуты.`, {
      parse_mode: 'HTML',
    });

    // Генерация в фоне
    runInBackground(async () => {
      try {
        const newPost = await generateOnly(postType);
        pendingPosts.set(id, { post: newPost, type: postType });

        const previewText = newPost.text.length > 3500
          ? newPost.text.slice(0, 3500) + '...'
          : newPost.text;

        const header = `📋 <b>Preview (перегенерирован)</b> (ID: ${id}, тип: ${postType})\n\n`;

        await bot.telegram.sendMessage(chatId, header + previewText, {
          parse_mode: 'HTML',
          reply_markup: previewKeyboard(id, postType),
        });

        logger.info(`Пост ${id} перегенерирован (${postType})`);
      } catch (err) {
        logger.error(`Ошибка перегенерации поста ${id}: ${err.message}`);
        await bot.telegram.sendMessage(chatId, `❌ Ошибка перегенерации: ${err.message}`);
      }
    });
  });

  // ─── Callback: Отмена ───

  bot.action(/^cmd_cancel_(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    pendingPosts.delete(id);

    await ctx.answerCbQuery('Отменено ❌');
    await ctx.editMessageReplyMarkup(undefined);
    logger.info(`Пост ${id} отменён через команду`);
  });

  logger.info('Команды бота зарегистрированы: /post, /status');
}

module.exports = { setupCommands };
