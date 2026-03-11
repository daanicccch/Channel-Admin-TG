const { config, initDb, closeDb } = require('./config');
const logger = require('./utils/logger');
const TelegramScraper = require('./scraper/telegramScraper');
const WebScraper = require('./scraper/webScraper');
const ContentAnalyzer = require('./analyzer/contentAnalyzer');
const TrendDetector = require('./analyzer/trendDetector');
const SentimentAnalyzer = require('./analyzer/sentimentAnalyzer');
const PostGenerator = require('./generator/postGenerator');
const mediaHandler = require('./generator/mediaHandler');
const { TelegramPublisher } = require('./publisher/telegramPublisher');
const { QueueManager } = require('./publisher/queueManager');
const { Scheduler } = require('./publisher/scheduler');
const { setupCommands } = require('./commands/botCommands');
const { getChannelProfile, logChannelProfilesStartup } = require('./channelProfiles');
const { insertGeneratedPost } = require('./utils/postStore');

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

let telegramScraper = null;
let scheduler = null;
let publisher = null;

function getCollectionOptions(postType) {
  if (postType === 'weekly') {
    return {
      lookbackHours: 24 * 7,
      limitOverride: 150,
    };
  }

  if (postType === 'analysis') {
    return {
      lookbackHours: 48,
      limitOverride: 80,
    };
  }

  return {
    lookbackHours: config.limits.lookbackHours,
    limitOverride: null,
  };
}

function resolveProfile(profileId) {
  const profile = getChannelProfile(profileId);
  if (!profile) {
    throw new Error(`Unknown channel profile: ${profileId}`);
  }
  if (!profile.telegramChannelId) {
    throw new Error(`telegram_channel_id is not configured for profile "${profile.id}"`);
  }
  return profile;
}

async function generateFromAnalysis(postType = 'digest', analysisData = {}, options = {}) {
  const profile = resolveProfile(options.profileId || analysisData.profileId);

  logger.info(`Stage: generation [${profile.id}]`);
  const postGenerator = new PostGenerator();
  const post = await postGenerator.generatePost(postType, {
    ...analysisData,
    profileId: profile.id,
    leadMediaOverride: options.leadMediaOverride || null,
  }, profile);

  if (post._leadMediaCandidate) {
    mediaHandler.markSourcePostUsed(post._leadMediaCandidate, {
      profileId: profile.id,
      postType,
      stage: options.leadMediaOverride ? 'regenerated' : 'generated',
      targetChannelId: profile.telegramChannelId || null,
    });
  }

  post._analysisData = {
    ...analysisData,
    profileId: profile.id,
  };
  post._dbPostId = insertGeneratedPost(post, {
    profileId: profile.id,
    postType,
    sources: (analysisData.clusters || [])
      .flatMap((cluster) => Array.isArray(cluster.sources) ? cluster.sources : [])
      .filter(Boolean)
      .slice(0, 20),
    engagement: {
      trends: Array.isArray(analysisData.trends) ? analysisData.trends.slice(0, 10) : [],
      sentiment: analysisData.sentiment || {},
    },
  });

  logger.info(`Post generated for profile=${profile.id}`);
  return post;
}

async function generateOnly(postType = 'digest', options = {}) {
  const profile = resolveProfile(options.profileId);
  const collectionOptions = getCollectionOptions(postType);

  logger.info(`=== Generate: ${postType} [${profile.id}] ===`);
  logger.info(`Stage: collect data [${profile.id}]`);

  const scraper = new TelegramScraper();
  const webScraper = new WebScraper({ sourcesPath: profile.webSourcesPath });
  telegramScraper = scraper;

  await scraper.connect();

  const [postsByChannel, webData] = await Promise.all([
    scraper.scrapeAll(profile.sourceChannels, {
      profileId: profile.id,
      lookbackHours: collectionOptions.lookbackHours,
      limitOverride: collectionOptions.limitOverride,
    }),
    webScraper.fetchAll({ enabledSources: profile.webSources }),
  ]);

  const posts = (postsByChannel || []).flatMap((channelResult) =>
    (channelResult.posts || []).map((post) => ({
      ...post,
      channel: channelResult.channel,
      channelTitle: channelResult.channelTitle,
    }))
  );

  logger.info(`Collected ${posts.length} source posts for profile=${profile.id}`);

  try {
    await scraper.disconnect();
  } catch (err) {
    logger.warn(`Telegram scraper disconnect warning: ${err.message}`);
  } finally {
    telegramScraper = null;
  }

  logger.info(`Stage: analyze [${profile.id}]`);
  const contentAnalyzer = new ContentAnalyzer();
  const clusters = await contentAnalyzer.analyze(posts, webData);

  const trendDetector = new TrendDetector();
  const trends = await trendDetector.detectTrends(clusters, webData);

  const sentimentAnalyzer = new SentimentAnalyzer();
  const sentiment = await sentimentAnalyzer.analyzeSentiment(clusters, webData);

  logger.info(`Analysis complete for ${profile.id}: ${clusters.length || 0} clusters, ${trends.length || 0} trends`);

  const analysisData = {
    clusters,
    trends,
    sentiment,
    webData,
    profileId: profile.id,
    lookbackHours: collectionOptions.lookbackHours,
  };

  return generateFromAnalysis(postType, analysisData, { profileId: profile.id });
}

async function runPipeline(postType = 'digest', options = {}) {
  const profile = resolveProfile(options.profileId);

  logger.info(`=== Pipeline start: ${postType} [${profile.id}] ===`);
  const post = await generateOnly(postType, { profileId: profile.id });

  logger.info(`Stage: publish [${profile.id}]`);
  if (!publisher) {
    publisher = new TelegramPublisher();
  }

  const queueManager = new QueueManager(publisher, generateFromAnalysis);
  queueManager.addToQueue(post);
  await queueManager.processQueue();

  const status = queueManager.getQueueStatus();
  logger.info(`Queue: pending=${status.pending}, published=${status.published}, rejected=${status.rejected}`);
  logger.info(`=== Pipeline done: ${postType} [${profile.id}] ===`);
}

async function main() {
  const args = parseArgs();
  const mode = args.mode;
  const postType = args.type || 'digest';
  const profileId = args.profile;

  await initDb();
  logChannelProfilesStartup();
  logger.info(`Bot starting mode=${mode} type=${postType} profile=${profileId || 'default'}`);

  switch (mode) {
    case 'manual': {
      await runPipeline(postType, { profileId });
      process.exit(0);
      break;
    }

    case 'auto': {
      scheduler = new Scheduler((type) => runPipeline(type, { profileId }));
      scheduler.start();

      publisher = new TelegramPublisher();
      const queueManager = new QueueManager(publisher, generateFromAnalysis);
      const bot = publisher.getBot();
      queueManager.setupAdminCallbacks(bot);

      setupCommands(bot, { generateOnly, generateFromAnalysis, publisher });

      bot.launch();
      logger.info('Telegraf bot started (long polling)');
      break;
    }

    case 'scrape-only': {
      const profile = resolveProfile(profileId);

      logger.info(`Scrape-only mode for profile=${profile.id}`);
      const scraper = new TelegramScraper();
      const webScraper = new WebScraper({ sourcesPath: profile.webSourcesPath });
      telegramScraper = scraper;

      await scraper.connect();
      const [posts, webData] = await Promise.all([
        scraper.scrapeAll(profile.sourceChannels, { profileId: profile.id }),
        webScraper.fetchAll({ enabledSources: profile.webSources }),
      ]);

      logger.info(`Collected ${posts.length} channel batches`);
      logger.info(`Web sources: ${JSON.stringify(Object.keys(webData || {}))}`);

      await scraper.disconnect();
      telegramScraper = null;
      process.exit(0);
      break;
    }

    default:
      logger.error(`Unknown mode: ${mode}. Use manual, auto, scrape-only`);
      process.exit(1);
  }
}

async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);

  if (scheduler) {
    scheduler.stop();
  }

  if (telegramScraper) {
    try {
      await telegramScraper.disconnect();
    } catch (err) {
      logger.warn(`Telegram scraper disconnect warning: ${err.message}`);
    }
  }

  if (publisher) {
    try {
      await publisher.close();
    } catch (err) {
      logger.warn(`Publisher close warning: ${err.message}`);
    }

    try {
      publisher.getBot().stop(signal);
    } catch (err) {
      logger.warn(`Bot stop warning: ${err.message}`);
    }
  }

  try {
    closeDb();
  } catch (_) {
    // DB may already be closed.
  }

  logger.info('Bot stopped');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});
