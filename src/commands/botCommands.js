const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { config } = require('../config');
const { queryOne } = require('../utils/dbHelpers');
const logger = require('../utils/logger');
const mediaHandler = require('../generator/mediaHandler');
const { getTelegramEntityLength, escapeHTML } = require('../generator/formatBuilder');
const { getChannelProfiles, getChannelProfile } = require('../channelProfiles');
const { inferMediaTypeFromPath } = require('../utils/mediaUtils');

const VALID_TYPES = ['post', 'alert', 'weekly'];
const pendingPosts = new Map();
const pendingImportedPosts = new Map();
let idCounter = 0;
const MAX_MEDIA_COUNT = Math.max(0, Math.min(parseInt(process.env.TG_MAX_MEDIA_PER_POST || '3', 10), 10));
const DEFAULT_MEDIA_COUNT = MAX_MEDIA_COUNT;

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

function getImportSessionKey(ctx) {
  return `${ctx.chat?.id || 'chat'}:${ctx.from?.id || 'user'}`;
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

function importProfileSelectionKeyboard(postType = 'post', mediaCount = DEFAULT_MEDIA_COUNT) {
  const profiles = getChannelProfiles();
  return {
    inline_keyboard: [
      ...profiles.map((profile) => ([
        {
          text: `${profile.title} (${profile.id})`,
          callback_data: `cmd_pick_import_profile|${profile.id}|${postType}|${mediaCount}`,
        },
      ])),
      [
        { text: 'Cancel', callback_data: 'cmd_cancel_import' },
      ],
    ],
  };
}

function importAwaitKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'Cancel', callback_data: 'cmd_cancel_import' },
      ],
    ],
  };
}

function previewKeyboard(id, postType, mediaCount = DEFAULT_MEDIA_COUNT) {
  const countLabel = `Media: ${mediaCount}`;
  const mediaCountButtons = [];

  for (let count = 0; count <= MAX_MEDIA_COUNT; count += 1) {
    mediaCountButtons.push({
      text: String(count),
      callback_data: `cmd_media_count_${id}_${count}`,
    });
  }
  const mediaCountRows = [];
  for (let index = 0; index < mediaCountButtons.length; index += 5) {
    mediaCountRows.push(mediaCountButtons.slice(index, index + 5));
  }

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
      ...mediaCountRows,
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
  post.media = { type: inferMediaTypeFromPath(next[0]), path: next[0], paths: next };
}

function applyMediaCount(entry, requestedCount) {
  const count = Math.max(0, Math.min(Number(requestedCount) || 0, MAX_MEDIA_COUNT));
  entry.mediaCount = count;

  if (count === 0) {
    setMediaPaths(entry.post, []);
    return;
  }

  const current = getMediaPaths(entry.post);
  setMediaPaths(entry.post, current.slice(0, count));
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
    regenerateMode: rejectionState.regenerateMode || 'default',
    regeneratePayload: rejectionState.regeneratePayload || null,
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

  if (mediaPaths.length > 1) {
    const mediaGroup = mediaPaths.slice(0, 10).map((mediaPath, index) => {
      const item = {
        type: inferMediaTypeFromPath(mediaPath) === 'video' ? 'video' : 'photo',
        media: { source: mediaPath },
      };
      if (index === 0) {
        const caption = header.length <= 1024 ? header : header.slice(0, 1024);
        item.caption = caption;
        item.parse_mode = 'HTML';
      }
      return item;
    });

    await bot.telegram.sendMediaGroup(chatId, mediaGroup);
    const message = await bot.telegram.sendMessage(chatId, `${header}\n\n${previewText}`, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    return [{ chatId, messageId: message.message_id }];
  }

  if (mediaPaths.length === 1) {
    const caption = `${header}\n\n${previewText}`;
    if (getTelegramEntityLength(caption) <= 1024) {
      const mediaType = entry.post.media?.type || inferMediaTypeFromPath(mediaPaths[0]);
      const message = mediaType === 'video'
        ? await bot.telegram.sendVideo(chatId, { source: mediaPaths[0] }, {
          caption,
          parse_mode: 'HTML',
          reply_markup: keyboard,
        })
        : await bot.telegram.sendPhoto(chatId, { source: mediaPaths[0] }, {
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

function parseImportCommandArgs(parts) {
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

function getForwardedSourceLabel(message = {}) {
  const origin = message.forward_origin || null;
  const fallbackTitle = message.forward_from_chat?.title || message.forward_from_chat?.username || '';

  if (origin?.type === 'channel') {
    return origin.chat?.title || origin.chat?.username || fallbackTitle || 'forwarded-channel';
  }

  if (origin?.type === 'chat') {
    return origin.sender_chat?.title || fallbackTitle || 'forwarded-chat';
  }

  if (origin?.type === 'user') {
    const fullName = [origin.sender_user?.first_name, origin.sender_user?.last_name].filter(Boolean).join(' ').trim();
    return fullName || origin.sender_user?.username || 'forwarded-user';
  }

  if (origin?.type === 'hidden_user') {
    return origin.sender_user_name || 'forwarded-user';
  }

  return fallbackTitle || 'manual';
}

function sanitizeKeyPart(value, fallback = 'manual') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || fallback;
}

function getIncomingMessageText(message = {}) {
  return String(message.caption || message.text || '').trim();
}

function getIncomingMessageEntities(message = {}) {
  if (message.caption && Array.isArray(message.caption_entities)) {
    return message.caption_entities;
  }

  if (message.text && Array.isArray(message.entities)) {
    return message.entities;
  }

  return [];
}

function getPrimarySourceSection(rawText = '') {
  const sections = String(rawText || '')
    .split(/\n\s*\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  return sections[0] || String(rawText || '').trim();
}

function normalizeLinkLabel(label = '', fallback = 'link') {
  const cleaned = String(label || '')
    .replace(/[—,:;]+$/g, '')
    .replace(/^[—,:;()\s]+|[—,:;()\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s—–\-•|,:;()[\]]+|[\s—–\-•|,:;()[\]]+$/g, '')
    .replace(/^[^\p{L}\p{N}%$#@]+|[^\p{L}\p{N}%$#@]+$/gu, '')
    .trim();

  return cleaned || fallback;
}

function extractMeaningfulLinksFromText(rawText = '') {
  const sourceText = String(rawText || '').trim();
  const results = [];
  const seen = new Set();
  const pushLink = (label, url) => {
    const safeUrl = String(url || '').trim();
    if (!/^https?:\/\/t\.me\//i.test(safeUrl)) return;

    const safeLabel = normalizeLinkLabel(label, 'link');
    const key = `${safeLabel.toLowerCase()}|${safeUrl.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ label: safeLabel, url: safeUrl });
  };

  const beforeParenRegex = /([A-Za-zА-Яа-я0-9][^()\n]{0,60}?)\s*\((https?:\/\/t\.me\/[^)\s]+)\)/gi;
  let match = null;
  while ((match = beforeParenRegex.exec(sourceText)) !== null) {
    pushLink(match[1], match[2]);
  }

  const afterParenRegex = /\((https?:\/\/t\.me\/[^)\s]+)\)\s*([A-Za-zА-Яа-я0-9%][^()\n,]{0,60})/gi;
  while ((match = afterParenRegex.exec(sourceText)) !== null) {
    pushLink(match[2], match[1]);
  }

  return results.slice(0, 8);
}

function normalizeImportedLinkUrl(url = '') {
  let normalized = String(url || '').trim();
  if (!normalized) return '';

  normalized = normalized
    .replace(/^https?:\/\/telegram\.me\//i, 'https://t.me/')
    .replace(/^telegram\.me\//i, 'https://t.me/')
    .replace(/^http:\/\/t\.me\//i, 'https://t.me/')
    .replace(/^t\.me\//i, 'https://t.me/');

  return /^https?:\/\//i.test(normalized) ? normalized : '';
}

function scoreImportedLinkLabel(label = '', url = '') {
  const safeLabel = normalizeLinkLabel(label, 'link');
  const normalized = safeLabel.toLowerCase();
  let score = safeLabel === 'link' ? 0 : safeLabel.length;

  if (/\b(emoji|stickers?|models?|collection|nft|traits?)\b/i.test(normalized)) score += 20;
  if (/%/.test(safeLabel)) score += 10;
  if (new RegExp(escapeRegExp(url), 'i').test(normalized)) score -= 10;

  return score;
}

function pushImportedLink(results = [], seen = new Map(), label = '', url = '') {
  const safeUrl = normalizeImportedLinkUrl(url);
  if (!safeUrl) return;

  const safeLabel = normalizeLinkLabel(label, 'link');
  const key = safeUrl.toLowerCase();
  if (seen.has(key)) {
    const existingIndex = seen.get(key);
    const existing = results[existingIndex];
    if (!existing) return;

    if (scoreImportedLinkLabel(safeLabel, safeUrl) > scoreImportedLinkLabel(existing.label, existing.url)) {
      results[existingIndex] = { label: safeLabel, url: safeUrl };
    }
    return;
  }

  seen.set(key, results.length);
  results.push({ label: safeLabel, url: safeUrl });
}

function isPromoOrReferralLink(item = {}) {
  const url = normalizeImportedLinkUrl(item.url);
  if (!url) return true;

  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  const label = normalizeLinkLabel(item.label, 'link');
  const lowerLabel = label.toLowerCase();
  const lowerUrl = url.toLowerCase();
  const pathSegments = parsed.pathname.split('/').filter(Boolean);
  const search = parsed.search.toLowerCase();
  const compactText = `${lowerLabel} ${lowerUrl}`;

  if (/(^|[?&])(startapp|startattach|start)=/i.test(search)) return true;
  if (/(^|[?&])ref(=|_|%5f)|referral/i.test(search)) return true;
  if (/(buy\/?sell|gift news|floorprice|portals|market|promo|advert|ad\b|sponsor)/i.test(compactText)) return true;
  if (/\/portals\/market\b/i.test(lowerUrl)) return true;
  if (/\/tonnel_[^/?]+_bot\b/i.test(lowerUrl)) return true;

  if (pathSegments.length <= 1) {
    return true;
  }

  return false;
}

function filterImportedLinks(links = []) {
  return (Array.isArray(links) ? links : [])
    .filter((item) => item?.url)
    .filter((item) => !isPromoOrReferralLink(item))
    .slice(0, 4);
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMeaningfulLinksFromEntities(rawText = '', entities = []) {
  const text = String(rawText || '');
  const results = [];
  const seen = new Map();

  if (!text || !Array.isArray(entities) || entities.length === 0) {
    return results;
  }

  for (const entity of entities) {
    if (!entity) continue;

    const type = String(entity.type || '').trim().toLowerCase();
    const offset = Math.max(0, Number(entity.offset) || 0);
    const length = Math.max(0, Number(entity.length) || 0);
    const label = text.slice(offset, offset + length).trim();

    if (type === 'text_link') {
      pushImportedLink(results, seen, label, entity.url);
      continue;
    }

    if (type === 'url') {
      pushImportedLink(results, seen, label, label);
      continue;
    }

    if (type === 'mention') {
      const mention = label.replace(/^@/, '').trim();
      if (mention) {
        pushImportedLink(results, seen, label, `https://t.me/${mention}`);
      }
    }
  }

  return results;
}

function extractTrailingLinkLabel(rawText = '') {
  const tail = String(rawText || '').slice(-80);
  if (!tail.trim()) return '';

  const candidate = tail
    .split(/\n/)
    .pop()
    .split(/[)—–|]/)
    .pop()
    .trim()
    .replace(/[,:;()\s]+$/g, '')
    .trim();

  if (!candidate) return '';

  const words = candidate.split(/\s+/).filter(Boolean);
  return words.slice(-5).join(' ').trim();
}

function extractLeadingLinkLabel(rawText = '') {
  const head = String(rawText || '').slice(0, 80);
  if (!head.trim()) return '';

  const candidate = head
    .replace(/^[\s,.;:()\]-]+/g, '')
    .split(/\n/)[0]
    .split(/[—–|]/)[0]
    .split(/[,:;]/)[0]
    .trim();

  if (!candidate) return '';

  const words = candidate.split(/\s+/).filter(Boolean);
  return words.slice(0, 5).join(' ').trim();
}

function extractMeaningfulLinksFromStructuredText(rawText = '') {
  const sourceText = String(rawText || '').trim();
  const results = [];
  const seen = new Map();
  const urlRegex = /\((https?:\/\/(?:t\.me|telegram\.me)\/[^)\s]+)\)/gi;
  let match = null;

  while ((match = urlRegex.exec(sourceText)) !== null) {
    const before = sourceText.slice(Math.max(0, match.index - 80), match.index);
    const after = sourceText.slice(urlRegex.lastIndex, urlRegex.lastIndex + 80);
    const label = extractTrailingLinkLabel(before) || extractLeadingLinkLabel(after) || 'link';
    pushImportedLink(results, seen, label, match[1]);
  }

  return results;
}

function extractMeaningfulLinks(rawText = '', entities = []) {
  const results = [];
  const seen = new Map();

  for (const item of extractMeaningfulLinksFromEntities(rawText, entities)) {
    pushImportedLink(results, seen, item.label, item.url);
  }

  const textLinks = extractMeaningfulLinksFromStructuredText(rawText);
  const fallbackTextLinks = textLinks.length > 0 ? textLinks : extractMeaningfulLinksFromText(rawText);

  for (const item of fallbackTextLinks) {
    pushImportedLink(results, seen, item.label, item.url);
  }

  return filterImportedLinks(results).slice(0, 8);
}

function mergeImportedLinksIntoPostText(postText = '', links = []) {
  const safeLinks = filterImportedLinks(links);
  if (safeLinks.length === 0) {
    return postText;
  }

  const currentText = String(postText || '');
  const missingLinks = safeLinks.filter((item) => !currentText.includes(item.url));
  if (missingLinks.length === 0) {
    return currentText;
  }

  const inlineLinks = missingLinks
    .map((item) => `<a href="${item.url}">${escapeHTML(item.label)}</a>`)
    .join(' • ');
  const appendix = `\n\n<b>Полезное:</b> ${inlineLinks}`;
  return `${currentText.trim()}${appendix}`;
}

function getIncomingMediaInfo(message = {}) {
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const bestPhoto = message.photo[message.photo.length - 1];
    return {
      fileId: bestPhoto.file_id,
      mediaType: 'photo',
      extension: '.jpg',
    };
  }

  if (message.video?.file_id) {
    const mimeType = String(message.video.mime_type || '').toLowerCase();
    return {
      fileId: message.video.file_id,
      mediaType: 'video',
      extension: mimeType === 'video/webm' ? '.webm' : (mimeType === 'video/quicktime' ? '.mov' : '.mp4'),
    };
  }

  if (message.document?.file_id) {
    const mimeType = String(message.document.mime_type || '').toLowerCase();
    if (mimeType.startsWith('image/')) {
      const ext = path.extname(String(message.document.file_name || '')).toLowerCase() || '.jpg';
      return {
        fileId: message.document.file_id,
        mediaType: 'photo',
        extension: ext,
      };
    }

    if (mimeType.startsWith('video/')) {
      const ext = path.extname(String(message.document.file_name || '')).toLowerCase()
        || (mimeType === 'video/webm' ? '.webm' : '.mp4');
      return {
        fileId: message.document.file_id,
        mediaType: 'video',
        extension: ext,
      };
    }
  }

  return null;
}

async function downloadIncomingMedia(bot, message, sourceLabel) {
  const mediaInfo = getIncomingMediaInfo(message);
  if (!mediaInfo?.fileId) {
    return [];
  }

  const fileLink = await bot.telegram.getFileLink(mediaInfo.fileId);
  const response = await axios.get(fileLink.toString(), { responseType: 'arraybuffer' });
  const buffer = Buffer.from(response.data);
  const hash = crypto.createHash('md5').update(buffer).digest('hex').slice(0, 8);
  const filename = `${sanitizeKeyPart(sourceLabel)}_${message.message_id}_${hash}${mediaInfo.extension}`;
  const filePath = path.join(config.paths.mediaCache, filename);

  fs.mkdirSync(config.paths.mediaCache, { recursive: true });
  fs.writeFileSync(filePath, buffer);

  return [filePath];
}

function buildImportedAnalysisData(profile, sourcePost) {
  const sourceTitle = sourcePost.channelTitle || sourcePost.channel || 'manual';
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
        sourceKeys: [sourcePost.sourceKey].filter(Boolean),
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

function buildImportedLeadMediaOverride(sourcePost) {
  const paths = Array.isArray(sourcePost.mediaPaths)
    ? sourcePost.mediaPaths.filter(Boolean).slice(0, 10)
    : [];

  if (paths.length === 0) {
    return null;
  }

  return {
    path: paths[0],
    paths,
    mediaType: inferMediaTypeFromPath(paths[0]),
    text: sourcePost.text || '',
    entities: null,
    channel: sourcePost.channel,
    views: Number(sourcePost.views) || 0,
    telegramPostId: Number(sourcePost.id) || 0,
    sourceKey: sourcePost.sourceKey,
    origin: 'manual',
    totalScore: Number(sourcePost.views) || 0,
    keywordHits: 0,
  };
}

async function buildImportedSourcePost(bot, message) {
  const text = getIncomingMessageText(message);
  const entities = getIncomingMessageEntities(message);
  const sourceLabel = getForwardedSourceLabel(message);
  const mediaPaths = await downloadIncomingMedia(bot, message, sourceLabel);
  const syntheticId = Date.now();
  const sourceLinks = extractMeaningfulLinks(text, entities);

  if (!text && mediaPaths.length === 0) {
    throw new Error('Send a forwarded post, text, photo, or video with caption');
  }

  return {
    id: syntheticId,
    channel: sanitizeKeyPart(sourceLabel),
    channelTitle: sourceLabel,
    text,
    mediaPaths,
    views: 0,
    sourceKey: `manual:${syntheticId}:${sanitizeKeyPart(sourceLabel)}`,
    sourceLinks,
  };
}

async function startGenerationFromImportedPost(bot, chatId, profile, postType, initialMediaCount, generateFromAnalysis, message) {
  await bot.telegram.sendMessage(chatId, `Processing source message for <b>${profile.title}</b> (<code>${profile.id}</code>), type <b>${postType}</b>...\nThis may take 1-2 minutes.`, {
    parse_mode: 'HTML',
  });

  runInBackground(async () => {
    try {
      const sourcePost = await buildImportedSourcePost(bot, message);
      const analysisData = buildImportedAnalysisData(profile, sourcePost);
      const leadMediaOverride = buildImportedLeadMediaOverride(sourcePost);
      const post = await generateFromAnalysis(postType, analysisData, {
        profileId: profile.id,
        leadMediaOverride,
      });
      post.text = mergeImportedLinksIntoPostText(post.text, sourcePost.sourceLinks || []);

      idCounter += 1;
      const id = idCounter;
      const entry = makePendingEntry(post, postType, initialMediaCount, [], [], {
        regenerateMode: 'source',
        regeneratePayload: {
          analysisData,
          leadMediaOverride,
          sourceLinks: sourcePost.sourceLinks || [],
        },
      });
      applyMediaCount(entry, initialMediaCount);
      pendingPosts.set(id, entry);
      rememberPreviewSource(entry);

      await sendPreviewToAdmins(bot, entry, id, '<b>Preview (imported source)</b>');
      logger.info(`Command /post_from ${postType}: preview sent for profile=${profile.id}, id=${id}`);
    } catch (err) {
      logger.error(`Error in /post_from command: ${err.message}`);
      await bot.telegram.sendMessage(chatId, `Import error: ${err.message}`);
    }
  });
}

async function startImportSession(ctx, profile, postType, mediaCount) {
  pendingImportedPosts.set(getImportSessionKey(ctx), {
    profileId: profile.id,
    postType,
    mediaCount,
  });

  await ctx.reply(
    `Send or forward the source message for <b>${profile.title}</b> (<code>${profile.id}</code>).\nYou can send plain text, a photo with caption, or a video with caption.`,
    {
      parse_mode: 'HTML',
      reply_markup: importAwaitKeyboard(),
    },
  );
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
      '<code>/post_from profile_id</code>',
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

    const initialMediaCount = Math.max(0, Math.min(Number(parsed.mediaCount) || DEFAULT_MEDIA_COUNT, MAX_MEDIA_COUNT));
    await startGeneration(bot, ctx.chat.id, parsed.profile, parsed.postType, initialMediaCount, generateOnly);
  }

  bot.command('post', adminOnly, handlePostCommand);
  bot.command('post_alert', adminOnly, handlePostCommand);
  bot.command('post_weekly', adminOnly, handlePostCommand);
  bot.command('post_from', adminOnly, async (ctx) => {
    const parts = ctx.message.text.split(/\s+/).filter(Boolean);
    const parsed = parseImportCommandArgs(parts);
    const profiles = getChannelProfiles();

    if (parsed.profile === undefined) {
      return ctx.reply('Unknown profile.\n\nUse /channels to list profiles.\nUsage: /post_from profile_id');
    }

    if (!parsed.profile && profiles.length > 1) {
      return ctx.reply('Choose a channel profile for import.', {
        parse_mode: 'HTML',
        reply_markup: importProfileSelectionKeyboard(parsed.postType || 'post', parsed.mediaCount || DEFAULT_MEDIA_COUNT),
      });
    }

    if (!parsed.profile) {
      return ctx.reply('No channel profiles configured');
    }

    if (!VALID_TYPES.includes(parsed.postType)) {
      return ctx.reply(`Unknown type: <code>${parsed.postType}</code>\n\nAvailable: ${VALID_TYPES.join(', ')}`, {
        parse_mode: 'HTML',
      });
    }

    const initialMediaCount = Math.max(0, Math.min(Number(parsed.mediaCount) || DEFAULT_MEDIA_COUNT, MAX_MEDIA_COUNT));
    const replyMessage = ctx.message.reply_to_message;

    if (replyMessage) {
      return startGenerationFromImportedPost(
        bot,
        ctx.chat.id,
        parsed.profile,
        parsed.postType,
        initialMediaCount,
        generateFromAnalysis,
        replyMessage,
      );
    }

    await startImportSession(ctx, parsed.profile, parsed.postType, initialMediaCount);
    return undefined;
  });

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

  bot.action(/^cmd_pick_import_profile\|([^|]+)\|(\w+)\|(\d+)$/, async (ctx) => {
    if (!(await ensureAdminCallbackAccess(ctx))) return;

    const profile = getChannelProfile(ctx.match[1]);
    const postType = ctx.match[2];
    const mediaCount = parseInt(ctx.match[3], 10);

    if (!profile) return ctx.answerCbQuery('Unknown profile');
    if (!VALID_TYPES.includes(postType)) return ctx.answerCbQuery('Unknown type');

    await ctx.answerCbQuery(`Selected ${profile.title}`);
    await startImportSession(ctx, profile, postType, mediaCount);
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
        const newPost = entry.regenerateMode === 'source' && entry.regeneratePayload?.analysisData
          ? await generateFromAnalysis(postType, entry.regeneratePayload.analysisData, {
            profileId: entry.profileId,
            leadMediaOverride: entry.regeneratePayload.leadMediaOverride || null,
          })
          : await generateOnly(postType, { profileId: entry.profileId });
        if (entry.regenerateMode === 'source') {
          newPost.text = mergeImportedLinksIntoPostText(newPost.text, entry.regeneratePayload?.sourceLinks || []);
        }
        const nextEntry = makePendingEntry(newPost, postType, entry.mediaCount ?? DEFAULT_MEDIA_COUNT);
        nextEntry.regenerateMode = entry.regenerateMode || 'default';
        nextEntry.regeneratePayload = entry.regeneratePayload || null;
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
    await ctx.answerCbQuery(`Media: ${entry.mediaCount}`);
    await clearPreviewKeyboards(bot, entry.previewRefs);
    rememberPreviewSource(entry);
    await sendPreviewToAdmins(bot, entry, id, '<b>Preview (updated)</b>');
  });

  bot.action(/^noop_\d+$/, async (ctx) => {
    if (!(await ensureAdminCallbackAccess(ctx))) return;
    await ctx.answerCbQuery('Select media count below');
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

  bot.action('cmd_cancel_import', async (ctx) => {
    if (!(await ensureAdminCallbackAccess(ctx))) return;

    pendingImportedPosts.delete(getImportSessionKey(ctx));

    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch (err) {
      logger.debug(`Import cancel keyboard cleanup skipped: ${err.message}`);
    }

    await ctx.answerCbQuery('Cancelled');
  });

  bot.on('message', async (ctx, next) => {
    if (!hasAdminAccess(ctx.from?.id)) {
      return next();
    }

    if (ctx.message?.text && ctx.message.text.startsWith('/')) {
      return next();
    }

    const session = pendingImportedPosts.get(getImportSessionKey(ctx));
    if (!session) {
      return next();
    }

    pendingImportedPosts.delete(getImportSessionKey(ctx));

    const profile = getChannelProfile(session.profileId);
    if (!profile) {
      return ctx.reply('Saved import session points to an unknown profile. Start again with /post_from profile_id');
    }

    await startGenerationFromImportedPost(
      bot,
      ctx.chat.id,
      profile,
      session.postType || 'post',
      session.mediaCount ?? DEFAULT_MEDIA_COUNT,
      generateFromAnalysis,
      ctx.message,
    );
    return undefined;
  });

  logger.info('Bot commands registered: /post, /post_from, /channels, /status');
}

module.exports = { setupCommands };
