const { config, initDb, closeDb } = require('./config');
const logger = require('./utils/logger');
const TelegramScraper = require('./scraper/telegramScraper');
const WebScraper = require('./scraper/webScraper');
const ContentAnalyzer = require('./analyzer/contentAnalyzer');
const TrendDetector = require('./analyzer/trendDetector');
const SentimentAnalyzer = require('./analyzer/sentimentAnalyzer');
const PostGenerator = require('./generator/postGenerator');
const { TelegramPublisher } = require('./publisher/telegramPublisher');
const { QueueManager } = require('./publisher/queueManager');
const { Scheduler } = require('./publisher/scheduler');
const { setupCommands } = require('./commands/botCommands');

// ────────── CLI args ──────────

function parseArgs() {
  const args = { mode: 'manual', type: 'digest' };
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (match) {
      args[match[1]] = match[2];
    }
  }
  return args;
}

// ────────── Глобальные ссылки для graceful shutdown ──────────

let telegramScraper = null;
let scheduler = null;
let publisher = null;

// ────────── Генерация поста (без публикации) ──────────

async function generateOnly(postType = 'digest') {
  logger.info(`=== Генерация: ${postType} ===`);

  // 1. SCRAPE
  logger.info('Этап: сбор данных');
  const scraper = new TelegramScraper();
  const webScraper = new WebScraper();

  await scraper.connect();

  const [posts, webData] = await Promise.all([
    scraper.scrapeAll(),
    webScraper.fetchAll(),
  ]);

  logger.info(`Собрано: ${posts.length} постов из каналов, веб-данные получены`);

  // Отключаем скрапер сразу после сбора
  try {
    await scraper.disconnect();
  } catch (err) {
    logger.warn(`Ошибка отключения скрапера: ${err.message}`);
  }

  // 2. ANALYZE
  logger.info('Этап: анализ');
  const contentAnalyzer = new ContentAnalyzer();
  const clusters = await contentAnalyzer.analyze(posts, webData);

  const trendDetector = new TrendDetector();
  const trends = await trendDetector.detectTrends(clusters, webData);

  const sentimentAnalyzer = new SentimentAnalyzer();
  const sentiment = await sentimentAnalyzer.analyzeSentiment(clusters, webData);

  logger.info(`Анализ завершён: ${clusters.length || 0} кластеров, ${trends.length || 0} трендов`);

  // 3. GENERATE
  logger.info('Этап: генерация поста');
  const postGenerator = new PostGenerator();
  const post = await postGenerator.generatePost(postType, {
    clusters,
    trends,
    sentiment,
    webData,
  });

  logger.info('Пост сгенерирован');
  return post;
}

// ────────── Основной пайплайн (генерация + публикация) ──────────

async function runPipeline(postType = 'digest') {
  logger.info(`=== Запуск пайплайна: ${postType} ===`);

  const post = await generateOnly(postType);

  // 4. PUBLISH
  logger.info('Этап: публикация');
  if (!publisher) {
    publisher = new TelegramPublisher();
  }
  const queueManager = new QueueManager(publisher);
  const queueId = queueManager.addToQueue(post);
  await queueManager.processQueue();

  const status = queueManager.getQueueStatus();
  logger.info(`Очередь: pending=${status.pending}, published=${status.published}, rejected=${status.rejected}`);

  logger.info(`=== Пайплайн ${postType} завершён ===`);
}

// ────────── Режимы запуска ──────────

async function main() {
  const args = parseArgs();
  const mode = args.mode;
  const postType = args.type || 'digest';

  // Инициализация БД перед началом работы
  await initDb();

  logger.info(`Запуск бота в режиме: ${mode}, тип: ${postType}`);

  switch (mode) {
    case 'manual': {
      await runPipeline(postType);
      process.exit(0);
      break;
    }

    case 'auto': {
      // Планировщик
      scheduler = new Scheduler(runPipeline);
      scheduler.start();

      // Telegraf бот для admin callbacks
      publisher = new TelegramPublisher();
      const queueManager = new QueueManager(publisher);
      const bot = publisher.getBot();
      queueManager.setupAdminCallbacks(bot);

      // Команды: /post, /status
      setupCommands(bot, { generateOnly, publisher });

      // Запускаем бота (long polling)
      bot.launch();
      logger.info('Telegraf бот запущен (long polling)');

      // Процесс остаётся живым
      break;
    }

    case 'scrape-only': {
      logger.info('Режим scrape-only: только сбор данных');
      const scraper = new TelegramScraper();
      const webScraper = new WebScraper();

      await scraper.connect();
      const [posts, webData] = await Promise.all([
        scraper.scrapeAll(),
        webScraper.fetchAll(),
      ]);

      logger.info(`Собрано ${posts.length} постов из каналов`);
      logger.info(`Веб-данные: ${JSON.stringify(Object.keys(webData || {}))}`);

      await scraper.disconnect();
      process.exit(0);
      break;
    }

    default:
      logger.error(`Неизвестный режим: ${mode}. Используйте: manual, auto, scrape-only`);
      process.exit(1);
  }
}

// ────────── Graceful shutdown ──────────

async function shutdown(signal) {
  logger.info(`Получен ${signal}, завершаем работу...`);

  if (scheduler) {
    scheduler.stop();
  }

  if (telegramScraper) {
    try {
      await telegramScraper.disconnect();
    } catch (err) {
      logger.warn(`Ошибка отключения скрапера: ${err.message}`);
    }
  }

  if (publisher) {
    try {
      publisher.getBot().stop(signal);
    } catch (err) {
      logger.warn(`Ошибка остановки бота: ${err.message}`);
    }
  }

  try {
    closeDb();
  } catch (_) {
    // БД могла быть не открыта
  }

  logger.info('Бот остановлен');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Запуск
main().catch((err) => {
  logger.error(`Критическая ошибка: ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});
