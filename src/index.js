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
const { getChannelProfile, getChannelProfiles, logChannelProfilesStartup } = require('./channelProfiles');
const { insertGeneratedPost } = require('./utils/postStore');
const { getCheckedPostIds, getMaxCheckedPostId, markChannelPostChecked } = require('./utils/checkStore');

function parseArgs() {
  const args = { mode: 'manual', type: 'post' };
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
let queueManager = null;
let channelChecksInFlight = false;

function getCollectionOptions(postType) {
  if (postType === 'weekly') {
    return {
      lookbackHours: 24 * 7,
      limitOverride: 150,
    };
  }

  if (postType === 'post') {
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

function getOrCreateQueueManager() {
  if (!publisher) {
    publisher = new TelegramPublisher();
  }

  if (!queueManager) {
    queueManager = new QueueManager(publisher, generateFromAnalysis);
  }

  return queueManager;
}

function getProfilesForChecks(profileId = null) {
  const profiles = profileId ? [resolveProfile(profileId)] : getChannelProfiles();
  return profiles.filter((profile) =>
    Array.isArray(profile.sourceChannels) &&
    profile.sourceChannels.some((channel) => channel && typeof channel === 'object' && channel.is_check === true)
  );
}

function buildImmediateAnalysisData(profile, sourcePost, channelEntry = {}) {
  const sourceTitle = sourcePost.channelTitle || channelEntry.name || sourcePost.channel || 'unknown';
  const normalizedText = String(sourcePost.text || '').trim();
  const summary = normalizedText
    ? normalizedText.replace(/\s+/g, ' ').slice(0, 280)
    : `Новый пост из ${sourceTitle}`;
  const keyFacts = normalizedText
    ? normalizedText
      .split(/(?<=[.!?])\s+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 2)
      .map((item) => item.slice(0, 140))
    : [`Пост из ${sourceTitle}`];

  return {
    clusters: [
      {
        topic: summary.slice(0, 90) || `Новый пост из ${sourceTitle}`,
        summary,
        keyFacts: keyFacts.length > 0 ? keyFacts : [`Пост из ${sourceTitle}`],
        sources: [sourceTitle],
        sourceKeys: [`${String(sourcePost.channel || '').toLowerCase()}:${Number(sourcePost.id) || 0}`].filter(Boolean),
        engagementScore: Number(sourcePost.views) || 0,
        postIds: [sourcePost.id],
        postCount: 1,
        viewsTotal: Number(sourcePost.views) || 0,
        immediate: true,
      },
    ],
    trends: [],
    sentiment: {},
    webData: {},
    profileId: profile.id,
    lookbackHours: 1,
  };
}

function buildLeadMediaOverride(sourcePost) {
  const paths = Array.isArray(sourcePost.mediaPaths)
    ? sourcePost.mediaPaths.filter(Boolean).slice(0, 10)
    : [sourcePost.mediaPath].filter(Boolean);

  if (paths.length === 0) {
    return null;
  }

  return {
    path: paths[0],
    paths,
    text: sourcePost.text || '',
    entities: sourcePost.entities || null,
    channel: sourcePost.channel,
    views: Number(sourcePost.views) || 0,
    telegramPostId: Number(sourcePost.id) || 0,
    sourceKey: `${String(sourcePost.channel || '').toLowerCase()}:${Number(sourcePost.id) || 0}`,
    origin: 'check',
    totalScore: Number(sourcePost.views) || 0,
    keywordHits: 0,
  };
}

function interleavePostsByChannel(posts = []) {
  const buckets = new Map();
  const channelOrder = [];

  for (const post of (posts || [])) {
    const channelKey = String(post?.channel || '').trim() || 'unknown';
    if (!buckets.has(channelKey)) {
      buckets.set(channelKey, []);
      channelOrder.push(channelKey);
    }
    buckets.get(channelKey).push(post);
  }

  const interleaved = [];
  let added = true;

  while (added) {
    added = false;
    for (const channelKey of channelOrder) {
      const bucket = buckets.get(channelKey) || [];
      if (bucket.length === 0) {
        continue;
      }
      interleaved.push(bucket.shift());
      added = true;
    }
  }

  return interleaved;
}

async function generateFromAnalysis(postType = 'post', analysisData = {}, options = {}) {
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
      stage: options.sourceUsageStage || (options.leadMediaOverride ? 'regenerated' : 'generated'),
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
    eventFingerprint: post._eventFingerprint || null,
  });

  logger.info(`Post generated for profile=${profile.id}`);
  return post;
}

async function generateOnly(postType = 'post', options = {}) {
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
  const diversifiedPosts = interleavePostsByChannel(posts);

  logger.info(`Collected ${posts.length} source posts for profile=${profile.id}`);
  logger.info(`Diversified source stream for profile=${profile.id}: channels=${new Set(diversifiedPosts.map((post) => post.channel)).size}`);

  try {
    await scraper.disconnect();
  } catch (err) {
    logger.warn(`Telegram scraper disconnect warning: ${err.message}`);
  } finally {
    telegramScraper = null;
  }

  logger.info(`Stage: analyze [${profile.id}]`);
  const contentAnalyzer = new ContentAnalyzer();
  const clusters = await contentAnalyzer.analyze(diversifiedPosts, webData);

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

async function runPipeline(postType = 'post', options = {}) {
  const profile = resolveProfile(options.profileId);

  logger.info(`=== Pipeline start: ${postType} [${profile.id}] ===`);
  const post = await generateOnly(postType, { profileId: profile.id });

  logger.info(`Stage: publish [${profile.id}]`);
  const activeQueueManager = getOrCreateQueueManager();
  activeQueueManager.addToQueue(post);
  await activeQueueManager.processQueue();

  const status = activeQueueManager.getQueueStatus();
  logger.info(`Queue: pending=${status.pending}, published=${status.published}, rejected=${status.rejected}`);
  logger.info(`=== Pipeline done: ${postType} [${profile.id}] ===`);
}

async function runImmediateChecks(options = {}) {
  if (channelChecksInFlight) {
    logger.info('Immediate channel checks skipped: previous run still in progress');
    return;
  }

  const profiles = getProfilesForChecks(options.profileId || null);
  if (profiles.length === 0) {
    logger.debug('Immediate channel checks skipped: no channels with is_check=true');
    return;
  }

  channelChecksInFlight = true;
  const scraper = new TelegramScraper();
  telegramScraper = scraper;

  try {
    await scraper.connect();

    for (const profile of profiles) {
      const watchedChannels = (profile.sourceChannels || [])
        .filter((channel) => channel && typeof channel === 'object' && channel.is_check === true);

      for (const channelEntry of watchedChannels) {
        const username = String(channelEntry.username || '').trim();
        if (!username) {
          continue;
        }

        try {
          logger.info(`Immediate check: ${profile.id}/${username}`);
          const result = await scraper.scrapeChannel(username, {
            limit: 10,
            lookbackHours: 48,
          });
          scraper.persistChannelPosts(result, { profileId: profile.id });

          const posts = Array.isArray(result.posts) ? [...result.posts] : [];
          if (posts.length === 0) {
            continue;
          }

          const maxCheckedPostId = getMaxCheckedPostId(profile.id, username);
          const sortedAsc = posts
            .filter((post) => Number(post.id))
            .sort((left, right) => Number(left.id) - Number(right.id));

          if (!maxCheckedPostId) {
            const latestPost = sortedAsc[sortedAsc.length - 1];
            markChannelPostChecked({
              profileId: profile.id,
              channel: username,
              telegramPostId: latestPost.id,
              sourceDate: latestPost.date instanceof Date ? latestPost.date.toISOString() : null,
              status: 'seeded',
            });
            logger.info(`Immediate check: seeded baseline for ${profile.id}/${username} at post ${latestPost.id}`);
            continue;
          }

          const candidatePosts = sortedAsc.filter((post) => Number(post.id) > maxCheckedPostId);
          if (candidatePosts.length === 0) {
            continue;
          }

          const alreadyCheckedIds = getCheckedPostIds(profile.id, username, candidatePosts.map((post) => post.id));
          const uncheckedPosts = candidatePosts.filter((post) => !alreadyCheckedIds.has(Number(post.id)));

          for (const sourcePost of uncheckedPosts) {
            logger.info(`Immediate check: new post detected ${profile.id}/${username}/${sourcePost.id}`);
            const analysisData = buildImmediateAnalysisData(profile, sourcePost, channelEntry);
            const leadMediaOverride = buildLeadMediaOverride(sourcePost);
            const post = await generateFromAnalysis('alert', analysisData, {
              profileId: profile.id,
              leadMediaOverride,
              sourceUsageStage: 'checked',
            });

            const activeQueueManager = getOrCreateQueueManager();
            const queueItem = activeQueueManager.addToQueue(post, {
              forceImmediatePublish: true,
            });
            await activeQueueManager.processQueue();

            markChannelPostChecked({
              profileId: profile.id,
              channel: username,
              telegramPostId: sourcePost.id,
              sourceDate: sourcePost.date instanceof Date ? sourcePost.date.toISOString() : null,
              generatedPostId: post._dbPostId || null,
              status: queueItem.status === 'published' ? 'published' : 'queued',
            });
          }
        } catch (err) {
          logger.error(`Immediate check failed for ${profile.id}/${username}: ${err.message}`);
        }
      }
    }
  } finally {
    try {
      await scraper.disconnect();
    } catch (err) {
      logger.warn(`Telegram scraper disconnect warning: ${err.message}`);
    } finally {
      if (telegramScraper === scraper) {
        telegramScraper = null;
      }
    }
    channelChecksInFlight = false;
  }
}

async function main() {
  const args = parseArgs();
  const mode = args.mode;
  const postType = args.type || 'post';
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
      scheduler = new Scheduler(
        (type, options = {}) => runPipeline(type, { profileId: options.profileId || profileId }),
        (options = {}) => runImmediateChecks({ profileId: options.profileId || profileId }),
      );
      scheduler.start();

      publisher = new TelegramPublisher();
      queueManager = new QueueManager(publisher, generateFromAnalysis);
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
