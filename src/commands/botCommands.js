const { config } = require('../config');
const { queryOne } = require('../utils/dbHelpers');
const logger = require('../utils/logger');
const mediaHandler = require('../generator/mediaHandler');
const { getTelegramEntityLength } = require('../generator/formatBuilder');
const { getChannelProfiles, getChannelProfile } = require('../channelProfiles');

const VALID_TYPES = ['post', 'alert', 'weekly'];
const pendingPosts = new Map();
let idCounter = 0;
const DEFAULT_MEDIA_COUNT = Math.max(0, Math.min(parseInt(process.env.TG_MAX_MEDIA_PER_POST || '1', 10), 1));

function getAdminChatIds() {
  const ids = Array.isArray(config.telegram.adminChatIds)
    ? config.telegram.adminChatIds.filter(Boolean)
    : [];
  if (ids.length > 0) return ids;
  return config.telegram.adminChatId ? [config.telegram.adminChatId] : [];
}

function hasAdminAccess(userId) {
  return getAdminChatIds().map(String).includes(String(userId));
}

function adminOnly(ctx, next) {
  const adminIds = getAdminChatIds();
  if (adminIds.length === 0) return ctx.reply('TELEGRAM_ADMIN_CHAT_ID is not set in .env');
  if (!hasAdminAccess(ctx.from.id)) return ctx.reply('No access');
  return next();
}

async function ensureAdminCallbackAccess(ctx) {
  const adminIds = getAdminChatIds();
  if (adminIds.length === 0) {
    await ctx.answerCbQuery('TELEGRAM_ADMIN_CHAT_ID is not set');
    return false;
  }
  if (!hasAdminAccess(ctx.from.id)) {
    await ctx.answerCbQuery('No access');
    return false;
  }
  return true;
}

function getDefaultProfile() {
  return getChannelProfiles()[0] || null;
}

function profileSelectionKeyboard(postType = 'post', mediaCount = DEFAULT_MEDIA_COUNT) {
  const profiles = getChannelProfiles();
  return {
    inline_keyboard: profiles.map((profile) => ([
      {
        text: `${profile.title} (${profile.id})`,
        callback_data: `cmd_pick_profile|${profile.id}|${postType}|${mediaCount}`,
      },
    ])),
  };
}

function previewKeyboard(id, postType, mediaCount = DEFAULT_MEDIA_COUNT) {
  const countLabel = `Images: ${mediaCount}`;
  return {
    inline_keyboard: [
      [
        { text: 'Publish', callback_data: `cmd_approve_${id}` },
        { text: 'Regenerate', callback_data: `cmd_regen_${id}_${postType}` },
      ],
      [
        { text: 'Replace source', callback_data: `cmd_replace_source_${id}` },
      ],
      [
        { text: countLabel, callback_data: `noop_${id}` },
      ],
      [
        { text: '0', callback_data: `cmd_media_count_${id}_0` },
        { text: '1', callback_data: `cmd_media_count_${id}_1` },
      ],
      [
        { text: 'Cancel', callback_data: `cmd_cancel_${id}` },
      ],
    ],
  };
}

function getMediaPaths(post) {
  return Array.isArray(post.media?.paths)
    ? post.media.paths.filter(Boolean)
    : (post.media?.path ? [post.media.path] : []);
}

function setMediaPaths(post, paths) {
  const next = (paths || []).filter(Boolean);
  if (next.length === 0) {
    post.media = { type: 'none', path: null, paths: [] };
    return;
  }
  post.media = { type: 'photo', path: next[0], paths: next };
}

function applyMediaCount(entry, requestedCount) {
  const count = Math.max(0, Math.min(Number(requestedCount) || 0, 1));
  entry.mediaCount = count;

  if (count === 0) {
    setMediaPaths(entry.post, []);
    return;
  }

  const current = getMediaPaths(entry.post);
  setMediaPaths(entry.post, current.slice(0, 1));
}

function makePendingEntry(post, type, mediaCount = DEFAULT_MEDIA_COUNT, sourceHistory = [], channelHistory = [], rejectionState = {}) {
  return {
    post,
    type,
    mediaCount,
    previewRefs: [],
    sourceHistory: [...new Set([
      ...sourceHistory,
      ...(post._leadMediaCandidate?.sourceKey ? [post._leadMediaCandidate.sourceKey] : []),
    ])],
    channelHistory: [...new Set([
      ...channelHistory,
      ...(post._leadMediaCandidate?.channel ? [String(post._leadMediaCandidate.channel).trim().toLowerCase()] : []),
    ])],
    profileId: post._profileId || 'default',
    profileTitle: post._profileTitle || 'Default channel',
    targetChannelId: post._targetChannelId || '',
    rejectedSourcePosts: Array.isArray(rejectionState.rejectedSourcePosts) ? [...rejectionState.rejectedSourcePosts] : [],
    rejectedMediaPaths: Array.isArray(rejectionState.rejectedMediaPaths) ? [...rejectionState.rejectedMediaPaths] : [],
    rejectedMediaHashes: Array.isArray(rejectionState.rejectedMediaHashes) ? [...rejectionState.rejectedMediaHashes] : [],
  };
}

function rememberPreviewSource(entry) {
  mediaHandler.rememberShownSource(entry?.post?._leadMediaCandidate, {
    profileId: entry?.profileId,
  });
}

function pushUnique(items = [], values = [], normalize = (item) => item, limit = 1000) {
  const seen = new Set();
  const merged = [];

  for (const item of [...items, ...values]) {
    const normalized = normalize(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push(item);
  }

  return merged.slice(-limit);
}

function rememberRejectedPreviewCandidate(entry, candidate) {
  if (!entry || !candidate) return;

  const identity = mediaHandler.buildCandidateIdentity(candidate);
  entry.sourceHistory = pushUnique(
    entry.sourceHistory || [],
    identity.sourceKey ? [identity.sourceKey] : [],
    (item) => String(item || '').trim().toLowerCase(),
  );
  entry.rejectedSourcePosts = pushUnique(
    entry.rejectedSourcePosts || [],
    identity.sourcePost ? [identity.sourcePost] : [],
    (item) => String(item || '').trim(),
  );
  entry.rejectedMediaPaths = pushUnique(
    entry.rejectedMediaPaths || [],
    identity.mediaPaths,
    (item) => String(item || '').trim(),
  );
  entry.rejectedMediaHashes = pushUnique(
    entry.rejectedMediaHashes || [],
    identity.mediaHashes,
    (item) => String(item || '').trim().toLowerCase(),
  );
}

function formatSourceLine(post) {
  const candidate = post?._leadMediaCandidate || null;
  if (!candidate) {
    return 'Source: n/a';
  }

  const channel = String(candidate.channel || 'unknown');
  const telegramPostId = Number(candidate.telegramPostId) || 0;
  const origin = String(candidate.origin || 'unknown');
  const score = Number.isFinite(Number(candidate.totalScore)) ? Number(candidate.totalScore) : null;

  return `Source: <code>${channel}/${telegramPostId}</code> (${origin}${score !== null ? `, score=${score}` : ''})`;
}

async function sendPreview(bot, chatId, entry, id, title = '<b>Preview</b>') {
  const previewText = entry.post.text.length > 3500 ? `${entry.post.text.slice(0, 3500)}...` : entry.post.text;
  const header = `${title} (${entry.profileTitle}, ID: ${id}, type: ${entry.type})\n${formatSourceLine(entry.post)}`;
  const keyboard = previewKeyboard(id, entry.type, entry.mediaCount);
  const mediaPaths = getMediaPaths(entry.post);

  if (mediaPaths.length === 1) {
    const caption = `${header}\n\n${previewText}`;
    if (getTelegramEntityLength(caption) <= 1024) {
      const message = await bot.telegram.sendPhoto(chatId, { source: mediaPaths[0] }, {
        caption,
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      return [{ chatId, messageId: message.message_id }];
    }
  }

  const message = await bot.telegram.sendMessage(chatId, `${header}\n\n${previewText}`, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
  return [{ chatId, messageId: message.message_id }];
}

async function clearPreviewKeyboards(bot, refs = []) {
  for (const ref of refs) {
    if (!ref?.chatId || !ref?.messageId) continue;
    try {
      await bot.telegram.editMessageReplyMarkup(ref.chatId, ref.messageId, undefined, undefined);
    } catch (err) {
      logger.debug(`Preview keyboard cleanup skipped for ${ref.chatId}/${ref.messageId}: ${err.message}`);
    }
  }
}

async function sendPreviewToAdmins(bot, entry, id, title = '<b>Preview</b>') {
  const adminIds = getAdminChatIds();
  if (adminIds.length === 0) {
    throw new Error('TELEGRAM_ADMIN_CHAT_ID is not set in .env');
  }

  const refs = [];
  let lastError = null;

  for (const adminChatId of adminIds) {
    try {
      const sentRefs = await sendPreview(bot, adminChatId, entry, id, title);
      refs.push(...sentRefs);
    } catch (err) {
      lastError = err;
      logger.error(`Failed to send preview to admin ${adminChatId}: ${err.message}`);
    }
  }

  if (refs.length === 0 && lastError) {
    throw lastError;
  }

  entry.previewRefs = refs;
  return refs;
}

function runInBackground(fn) {
  fn().catch((err) => logger.error(`Background task failed: ${err.message}`));
}

function parsePostCommandArgs(parts) {
  const defaultProfile = getDefaultProfile();
  const arg1 = parts[1];
  const arg2 = parts[2];
  const arg3 = parts[3];

  if (!arg1) {
    return { profile: null, postType: 'post', mediaCount: DEFAULT_MEDIA_COUNT };
  }

  const profileFromArg1 = getChannelProfile(arg1);
  if (profileFromArg1) {
    const postType = VALID_TYPES.includes(arg2) ? arg2 : 'post';
    const mediaCount = Number.isFinite(Number(arg3)) ? Number(arg3) : DEFAULT_MEDIA_COUNT;
    return { profile: profileFromArg1, postType, mediaCount };
  }

  if (VALID_TYPES.includes(arg1)) {
    const mediaCount = Number.isFinite(Number(arg2)) ? Number(arg2) : DEFAULT_MEDIA_COUNT;
    return { profile: defaultProfile, postType: arg1, mediaCount };
  }

  return { profile: undefined, postType: null, mediaCount: DEFAULT_MEDIA_COUNT };
}

function getTypeByCommand(commandName = '') {
  const normalized = String(commandName || '').replace(/^\//, '').trim().toLowerCase();
  if (normalized === 'post_alert') return 'alert';
  if (normalized === 'post_weekly') return 'weekly';
  return 'post';
}

async function startGeneration(bot, chatId, profile, postType, initialMediaCount, generateOnly) {
  await bot.telegram.sendMessage(chatId, `Generating post for <b>${profile.title}</b> (<code>${profile.id}</code>), type <b>${postType}</b>...\nThis may take 1-2 minutes.`, {
    parse_mode: 'HTML',
  });

  runInBackground(async () => {
    try {
      const post = await generateOnly(postType, { profileId: profile.id });

      idCounter += 1;
      const id = idCounter;
      const entry = makePendingEntry(post, postType, initialMediaCount);
      applyMediaCount(entry, initialMediaCount);
      pendingPosts.set(id, entry);
      rememberPreviewSource(entry);

      await sendPreviewToAdmins(bot, entry, id);
      logger.info(`Command /post ${postType}: preview sent for profile=${profile.id}, id=${id}`);
    } catch (err) {
      logger.error(`Error in /post command: ${err.message}`);
      await bot.telegram.sendMessage(chatId, `Generation error: ${err.message}`);
    }
  });
}

function setupCommands(bot, { generateOnly, generateFromAnalysis, publisher }) {
  bot.command('channels', adminOnly, async (ctx) => {
    const profiles = getChannelProfiles();
    const lines = [
      '<b>Available channels</b>',
      '',
      ...profiles.map((profile) => `• <b>${profile.title}</b> — <code>${profile.id}</code> → <code>${profile.telegramChannelId || 'not set'}</code>`),
      '',
      'Usage:',
      '<code>/post profile_id</code>',
      '<code>/post_alert profile_id</code>',
      '<code>/post_weekly profile_id</code>',
    ];
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  async function handlePostCommand(ctx) {
    const parts = ctx.message.text.split(/\s+/).filter(Boolean);
    const profiles = getChannelProfiles();
    const commandType = getTypeByCommand(parts[0]);
    const parsed = parsePostCommandArgs(parts);

    parsed.postType = commandType;

    if (parsed.profile === undefined) {
      return ctx.reply('Unknown profile.\n\nUse /channels to list profiles.');
    }

    if (!parsed.profile) {
      if (profiles.length > 1) {
        return ctx.reply('Choose a channel profile for generation. Available: <code>/post</code>, <code>/post_alert</code>, <code>/post_weekly</code>.', {
          parse_mode: 'HTML',
          reply_markup: profileSelectionKeyboard(commandType),
        });
      }

      if (!profiles[0]) {
        return ctx.reply('No channel profiles configured');
      }

      parsed.profile = profiles[0];
    }

    if (!VALID_TYPES.includes(parsed.postType)) {
      return ctx.reply(`Unknown type: <code>${parsed.postType}</code>\n\nAvailable: ${VALID_TYPES.join(', ')}`, {
        parse_mode: 'HTML',
      });
    }

    const initialMediaCount = Math.max(0, Math.min(Number(parsed.mediaCount) || DEFAULT_MEDIA_COUNT, 1));
    await startGeneration(bot, ctx.chat.id, parsed.profile, parsed.postType, initialMediaCount, generateOnly);
  }

  bot.command('post', adminOnly, handlePostCommand);
  bot.command('post_alert', adminOnly, handlePostCommand);
  bot.command('post_weekly', adminOnly, handlePostCommand);

  bot.command('status', adminOnly, async (ctx) => {
    try {
      const todayRow = queryOne("SELECT COUNT(*) as cnt FROM posts WHERE published_at >= date('now')");
      const totalRow = queryOne('SELECT COUNT(*) as cnt FROM posts WHERE published_at IS NOT NULL');
      const todayCount = todayRow ? todayRow.cnt : 0;
      const totalCount = totalRow ? totalRow.cnt : 0;
      const pendingCount = pendingPosts.size;
      const hasGemini = Array.isArray(config.ai.geminiKeys) ? config.ai.geminiKeys.length > 0 : Boolean(config.ai.geminiKey);
      const aiProvider = hasGemini ? 'Gemini 2.5 Flash' : 'Not configured';

      const text = [
        '<b>Bot status</b>',
        '',
        `Posts today: <b>${todayCount}</b>`,
        `Posts total: <b>${totalCount}</b>`,
        `AI: <b>${aiProvider}</b>`,
        `Pending decisions: <b>${pendingCount}</b>`,
        `Profiles: <b>${getChannelProfiles().length}</b>`,
      ].join('\n');

      await ctx.reply(text, { parse_mode: 'HTML' });
    } catch (err) {
      logger.error(`Error in /status command: ${err.message}`);
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  bot.action(/^cmd_pick_profile\|([^|]+)\|(\w+)\|(\d+)$/, async (ctx) => {
    if (!(await ensureAdminCallbackAccess(ctx))) return;

    const profile = getChannelProfile(ctx.match[1]);
    const postType = ctx.match[2];
    const mediaCount = parseInt(ctx.match[3], 10);

    if (!profile) return ctx.answerCbQuery('Unknown profile');
    if (!VALID_TYPES.includes(postType)) return ctx.answerCbQuery('Unknown type');

    await ctx.answerCbQuery(`Selected ${profile.title}`);
    await startGeneration(bot, ctx.chat.id, profile, postType, mediaCount, generateOnly);
  });

  bot.action(/^cmd_approve_(\d+)$/, async (ctx) => {
    if (!(await ensureAdminCallbackAccess(ctx))) return;

    const id = parseInt(ctx.match[1], 10);
    const entry = pendingPosts.get(id);
    if (!entry) return ctx.answerCbQuery('Post not found (already processed?)');

    try {
      const channelId = entry.targetChannelId || config.telegram.channelId;
      if (!channelId) return ctx.answerCbQuery('No target channel configured');

      await publisher.publish(entry.post, channelId);
      await clearPreviewKeyboards(bot, entry.previewRefs);
      pendingPosts.delete(id);

      await ctx.answerCbQuery('Published');
      logger.info(`Post ${id} published via command to ${channelId}`);
    } catch (err) {
      logger.error(`Publish error for post ${id}: ${err.message}`);
      await ctx.answerCbQuery('Publish error');
    }
  });

  bot.action(/^cmd_regen_(\d+)_(\w+)$/, async (ctx) => {
    if (!(await ensureAdminCallbackAccess(ctx))) return;

    const id = parseInt(ctx.match[1], 10);
    const postType = ctx.match[2];
    const entry = pendingPosts.get(id);
    if (!entry) return ctx.answerCbQuery('Post not found');

    await ctx.answerCbQuery('Regenerating...');
    await clearPreviewKeyboards(bot, entry.previewRefs);

    await bot.telegram.sendMessage(ctx.chat.id, `Regenerating for <b>${entry.profileTitle}</b>...\nThis may take 1-2 minutes.`, {
      parse_mode: 'HTML',
    });

    runInBackground(async () => {
      try {
        const newPost = await generateOnly(postType, { profileId: entry.profileId });
        const nextEntry = makePendingEntry(newPost, postType, entry.mediaCount ?? DEFAULT_MEDIA_COUNT);
        applyMediaCount(nextEntry, nextEntry.mediaCount);
        pendingPosts.set(id, nextEntry);
        rememberPreviewSource(nextEntry);
        await sendPreviewToAdmins(bot, nextEntry, id, '<b>Preview (regenerated)</b>');
        logger.info(`Post ${id} regenerated (${postType}) for profile=${entry.profileId}`);
      } catch (err) {
        logger.error(`Regeneration error for post ${id}: ${err.message}`);
        await bot.telegram.sendMessage(ctx.chat.id, `Regeneration error: ${err.message}`);
      }
    });
  });

  bot.action(/^cmd_replace_source_(\d+)$/, async (ctx) => {
    if (!(await ensureAdminCallbackAccess(ctx))) return;

    const id = parseInt(ctx.match[1], 10);
    const entry = pendingPosts.get(id);
    if (!entry) return ctx.answerCbQuery('Post not found');

    const analysisData = entry.post?._analysisData;
    if (!analysisData?.clusters) return ctx.answerCbQuery('No source context');
    rememberRejectedPreviewCandidate(entry, entry.post?._leadMediaCandidate);
    mediaHandler.rememberRejectedSource(entry.post?._leadMediaCandidate, {
      profileId: entry.profileId,
    });

    const sourceOverride = mediaHandler.selectAlternativeLeadMediaPost(
      analysisData.clusters,
      entry.sourceHistory || [],
      entry.post.text || '',
      {
        profileId: entry.profileId,
        currentSourceKey: entry.post?._leadMediaCandidate?.sourceKey || '',
        currentMediaPaths: entry.post?._leadMediaCandidate?.paths || [],
        currentChannel: entry.post?._leadMediaCandidate?.channel || '',
        seenChannels: entry.channelHistory || [],
        excludedSourcePosts: entry.rejectedSourcePosts || [],
        excludedMediaPaths: entry.rejectedMediaPaths || [],
        excludedMediaHashes: entry.rejectedMediaHashes || [],
      },
    );
    if (!sourceOverride) return ctx.answerCbQuery('No alternative source posts');

    await ctx.answerCbQuery('Replacing source...');
    await clearPreviewKeyboards(bot, entry.previewRefs);

    await bot.telegram.sendMessage(ctx.chat.id, `Replacing source for <b>${entry.profileTitle}</b>...\nThis may take 1-2 minutes.`, {
      parse_mode: 'HTML',
    });

    runInBackground(async () => {
      try {
        const newPost = await generateFromAnalysis(entry.type, analysisData, {
          leadMediaOverride: sourceOverride,
          profileId: entry.profileId,
          sourceExclusions: {
            excludedSourceKeys: entry.sourceHistory || [],
            excludedSourcePosts: entry.rejectedSourcePosts || [],
            excludedMediaPaths: entry.rejectedMediaPaths || [],
            excludedMediaHashes: entry.rejectedMediaHashes || [],
          },
        });
        const nextEntry = makePendingEntry(
          newPost,
          entry.type,
          entry.mediaCount ?? DEFAULT_MEDIA_COUNT,
          [...(entry.sourceHistory || []), sourceOverride.sourceKey],
          [...(entry.channelHistory || []), sourceOverride.channel],
          {
            rejectedSourcePosts: entry.rejectedSourcePosts || [],
            rejectedMediaPaths: entry.rejectedMediaPaths || [],
            rejectedMediaHashes: entry.rejectedMediaHashes || [],
          },
        );
        applyMediaCount(nextEntry, nextEntry.mediaCount);
        pendingPosts.set(id, nextEntry);
        rememberPreviewSource(nextEntry);
        await sendPreviewToAdmins(bot, nextEntry, id, '<b>Preview (updated source)</b>');
        logger.info(`Post ${id}: source replaced with ${sourceOverride.channel}/${sourceOverride.telegramPostId}`);
      } catch (err) {
        logger.error(`Replace source error for post ${id}: ${err.message}`);
        await bot.telegram.sendMessage(ctx.chat.id, `Replace source error: ${err.message}`);
      }
    });
  });

  bot.action(/^cmd_media_count_(\d+)_(\d+)$/, async (ctx) => {
    if (!(await ensureAdminCallbackAccess(ctx))) return;

    const id = parseInt(ctx.match[1], 10);
    const count = parseInt(ctx.match[2], 10);
    const entry = pendingPosts.get(id);
    if (!entry) return ctx.answerCbQuery('Post not found');

    if (count === 0) {
      rememberRejectedPreviewCandidate(entry, entry.post?._leadMediaCandidate);
      mediaHandler.rememberRejectedSource(entry.post?._leadMediaCandidate, {
        profileId: entry.profileId,
      });
    }

    applyMediaCount(entry, count);
    await ctx.answerCbQuery(`Images: ${entry.mediaCount}`);
    await clearPreviewKeyboards(bot, entry.previewRefs);
    rememberPreviewSource(entry);
    await sendPreviewToAdmins(bot, entry, id, '<b>Preview (updated)</b>');
  });

  bot.action(/^noop_\d+$/, async (ctx) => {
    if (!(await ensureAdminCallbackAccess(ctx))) return;
    await ctx.answerCbQuery('Select image count below');
  });

  bot.action(/^cmd_cancel_(\d+)$/, async (ctx) => {
    if (!(await ensureAdminCallbackAccess(ctx))) return;

    const id = parseInt(ctx.match[1], 10);
    const entry = pendingPosts.get(id);
    await clearPreviewKeyboards(bot, entry?.previewRefs);
    pendingPosts.delete(id);
    await ctx.answerCbQuery('Cancelled');
    logger.info(`Post ${id} cancelled via command`);
  });

  logger.info('Bot commands registered: /post, /channels, /status');
}

module.exports = { setupCommands };
