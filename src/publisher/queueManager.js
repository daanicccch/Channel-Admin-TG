const { config } = require('../config');
const { queryOne } = require('../utils/dbHelpers');
const logger = require('../utils/logger');
const mediaHandler = require('../generator/mediaHandler');

class QueueManager {
  constructor(telegramPublisher, generateFromAnalysis = null) {
    this.publisher = telegramPublisher;
    this.generateFromAnalysis = generateFromAnalysis;
    this.queue = [];
    this.idCounter = 0;
  }

  getAdminChatIds() {
    const ids = Array.isArray(config.telegram.adminChatIds)
      ? config.telegram.adminChatIds.filter(Boolean)
      : [];
    if (ids.length > 0) return ids;
    return config.telegram.adminChatId ? [config.telegram.adminChatId] : [];
  }

  hasAdminAccess(userId) {
    return this.getAdminChatIds().map(String).includes(String(userId));
  }

  addToQueue(post, options = {}) {
    this.idCounter += 1;
    const item = {
      id: this.idCounter,
      post,
      type: post.postType || 'digest',
      status: 'pending',
      createdAt: new Date(),
      reviewRefs: [],
      sourceHistory: post._leadMediaCandidate?.sourceKey ? [post._leadMediaCandidate.sourceKey] : [],
      profileId: post._profileId || 'default',
      profileTitle: post._profileTitle || 'Default channel',
      targetChannelId: post._targetChannelId || config.telegram.channelId,
      forceImmediatePublish: options.forceImmediatePublish === true,
    };
    this.queue.push(item);
    logger.info(`Post added to queue, id=${item.id}, profile=${item.profileId}`);
    return item;
  }

  async processQueue() {
    const pending = this.queue.filter((item) => item.status === 'pending');
    if (pending.length === 0) {
      logger.debug('Queue is empty, nothing to process');
      return;
    }

    for (const item of pending) {
      try {
        if (!item.forceImmediatePublish) {
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
                logger.info(`Too early to publish, wait about ${waitMin} more min`);
                continue;
              }
            }
          } catch (err) {
            logger.warn(`Failed to check publish interval: ${err.message}`);
          }
        }

        if (config.modes.autoPublish && !config.modes.reviewMode) {
          if (!item.targetChannelId) {
            logger.error(`No target channel configured for profile=${item.profileId}`);
            return;
          }
          await this.publisher.publish(item.post, item.targetChannelId);
          item.status = 'published';
          logger.info(`Post ${item.id} published automatically to ${item.targetChannelId}`);
        } else if (config.modes.reviewMode) {
          item.reviewRefs = await this.publisher.sendToAdmin(item.post, item.id, {
            header: `📝 Post for review • ${item.profileTitle}`,
          });
          item.status = 'pending';
          logger.info(`Post ${item.id} sent for review`);
        } else {
          logger.info(`Post ${item.id} remains in queue, autoPublish=false, reviewMode=false`);
        }
      } catch (err) {
        logger.error(`Queue processing failed for post ${item.id}: ${err.message}`);
      }
    }
  }

  setupAdminCallbacks(bot) {
    bot.action(/^approve_(\d+)/, async (ctx) => {
      if (!this.hasAdminAccess(ctx.from.id)) {
        await ctx.answerCbQuery('No access');
        return;
      }

      const postId = parseInt(ctx.match[1], 10);
      const item = this.queue.find((q) => q.id === postId);

      if (!item) {
        await ctx.answerCbQuery('Post not found');
        return;
      }
      if (item.status !== 'pending') {
        await ctx.answerCbQuery('Already processed');
        return;
      }

      try {
        if (!item.targetChannelId) {
          await ctx.answerCbQuery('No target channel configured');
          return;
        }

        await this.publisher.publish(item.post, item.targetChannelId);
        item.status = 'published';
        await this.publisher.clearAdminReplyMarkups(item.reviewRefs);
        await ctx.answerCbQuery('Published');
        logger.info(`Post ${postId} approved and published by admin`);
      } catch (err) {
        logger.error(`Approve publish error for post ${postId}: ${err.message}`);
        await ctx.answerCbQuery('Publish error');
      }
    });

    bot.action(/^reject_(\d+)/, async (ctx) => {
      if (!this.hasAdminAccess(ctx.from.id)) {
        await ctx.answerCbQuery('No access');
        return;
      }

      const postId = parseInt(ctx.match[1], 10);
      const item = this.queue.find((q) => q.id === postId);

      if (!item) {
        await ctx.answerCbQuery('Post not found');
        return;
      }
      if (item.status !== 'pending') {
        await ctx.answerCbQuery('Already processed');
        return;
      }

      item.status = 'rejected';
      await this.publisher.clearAdminReplyMarkups(item.reviewRefs);
      logger.info(`Post ${postId} rejected by admin`);
      await ctx.answerCbQuery('Rejected');
    });

    bot.action(/^replace_source_(\d+)/, async (ctx) => {
      if (!this.hasAdminAccess(ctx.from.id)) {
        await ctx.answerCbQuery('No access');
        return;
      }

      const postId = parseInt(ctx.match[1], 10);
      const item = this.queue.find((q) => q.id === postId);

      if (!item) {
        await ctx.answerCbQuery('Post not found');
        return;
      }
      if (item.status !== 'pending') {
        await ctx.answerCbQuery('Already processed');
        return;
      }
      if (!this.generateFromAnalysis) {
        await ctx.answerCbQuery('Source replace unavailable');
        return;
      }

      const analysisData = item.post?._analysisData;
      if (!analysisData?.clusters) {
        await ctx.answerCbQuery('No source context');
        return;
      }

      const sourceOverride = mediaHandler.selectAlternativeLeadMediaPost(
        analysisData.clusters,
        item.sourceHistory || [],
        item.post.text || '',
        { profileId: item.profileId },
      );

      if (!sourceOverride) {
        await ctx.answerCbQuery('No alternative source posts');
        return;
      }

      await ctx.answerCbQuery('Replacing source');
      await this.publisher.clearAdminReplyMarkups(item.reviewRefs);

      try {
        const newPost = await this.generateFromAnalysis(item.type, analysisData, {
          leadMediaOverride: sourceOverride,
          profileId: item.profileId,
        });
        item.post = newPost;
        item.sourceHistory = newPost._leadMediaCandidate?.sourceKey
          ? [...new Set([...(item.sourceHistory || []), sourceOverride.sourceKey, newPost._leadMediaCandidate.sourceKey])]
          : [...new Set([...(item.sourceHistory || []), sourceOverride.sourceKey])];
        item.reviewRefs = await this.publisher.sendToAdmin(item.post, item.id, {
          header: `🖼 Updated preview • ${item.profileTitle}`,
        });
        logger.info(`Post ${postId}: source replaced with ${sourceOverride.channel}/${sourceOverride.telegramPostId}`);
      } catch (err) {
        logger.error(`Replace source error for queued post ${postId}: ${err.message}`);
      }
    });

    logger.info('Admin callbacks registered');
  }

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
