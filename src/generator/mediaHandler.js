const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');
const { queryAll, runSql } = require('../utils/dbHelpers');
const logger = require('../utils/logger');

const MAX_MEDIA_PER_POST = parseInt(process.env.TG_MAX_MEDIA_PER_POST || '1', 10);
const FALLBACK_MEDIA_LOOKBACK_HOURS = parseInt(process.env.TG_FALLBACK_MEDIA_LOOKBACK_HOURS || '24', 10);
const USED_MEDIA_FILE = path.join(config.paths.data, 'used_media.json');
const REJECTED_SOURCE_FILE = path.join(config.paths.data, 'rejected_sources.json');
const MIN_MEDIA_FILE_SIZE_BYTES = parseInt(process.env.TG_MIN_MEDIA_FILE_SIZE_BYTES || '20000', 10);
const MAX_RECENT_MEDIA_SCAN = parseInt(process.env.TG_MAX_RECENT_MEDIA_SCAN || '700', 10);
const RECENT_PUBLISHED_MEDIA_LIMIT = parseInt(process.env.TG_RECENT_PUBLISHED_MEDIA_LIMIT || '300', 10);
const mediaHashCache = new Map();

function readUsedMediaSet() {
  try {
    if (!fs.existsSync(USED_MEDIA_FILE)) return new Set();
    const raw = fs.readFileSync(USED_MEDIA_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (err) {
    logger.warn(`mediaHandler: failed to read used media file - ${err.message}`);
    return new Set();
  }
}

function writeUsedMediaSet(set) {
  try {
    fs.writeFileSync(USED_MEDIA_FILE, JSON.stringify([...set], null, 2));
  } catch (err) {
    logger.warn(`mediaHandler: failed to write used media file - ${err.message}`);
  }
}

function readRejectedSourceRegistry() {
  try {
    if (!fs.existsSync(REJECTED_SOURCE_FILE)) return {};
    const raw = fs.readFileSync(REJECTED_SOURCE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    logger.warn(`mediaHandler: failed to read rejected sources file - ${err.message}`);
    return {};
  }
}

function writeRejectedSourceRegistry(registry) {
  try {
    fs.writeFileSync(REJECTED_SOURCE_FILE, JSON.stringify(registry, null, 2));
  } catch (err) {
    logger.warn(`mediaHandler: failed to write rejected sources file - ${err.message}`);
  }
}

function getRejectedSourceMemory(profileId = 'default') {
  const registry = readRejectedSourceRegistry();
  const profileKey = String(profileId || 'default');
  const entry = registry[profileKey] || {};
  return {
    sourceKeys: new Set(Array.isArray(entry.sourceKeys) ? entry.sourceKeys.filter(Boolean) : []),
    mediaPaths: new Set(Array.isArray(entry.mediaPaths) ? entry.mediaPaths.filter(Boolean) : []),
    mediaHashes: new Set(Array.isArray(entry.mediaHashes) ? entry.mediaHashes.filter(Boolean) : []),
  };
}

function buildSelectionContext(clusters = [], postText = '') {
  const postIds = [];
  const sourceKeys = [];
  const sourceNames = [];
  const clusterTextChunks = [String(postText || '')];

  for (const cluster of clusters || []) {
    if (Array.isArray(cluster.postIds)) {
      postIds.push(...cluster.postIds.filter(Boolean));
    }
    if (Array.isArray(cluster.sourceKeys)) {
      sourceKeys.push(...cluster.sourceKeys.filter(Boolean));
    }
    if (Array.isArray(cluster.sources)) {
      sourceNames.push(...cluster.sources.filter(Boolean));
    }
    if (cluster.topic) clusterTextChunks.push(cluster.topic);
    if (cluster.summary) clusterTextChunks.push(cluster.summary);
    if (Array.isArray(cluster.keyFacts)) clusterTextChunks.push(...cluster.keyFacts);
  }

  const normalizedSources = [...new Set(sourceNames.map(normalizeText).filter(Boolean))];
  const keywords = extractKeywords(clusterTextChunks.join(' '));

  return {
    postText: String(postText || ''),
    postIds: [...new Set(postIds)],
    sourceKeys: [...new Set(sourceKeys.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))],
    sources: normalizedSources,
    keywords,
  };
}

function extractKeywords(text) {
  const stopWords = new Set([
    'это', 'как', 'что', 'или', 'для', 'with', 'from', 'that', 'this', 'have', 'will',
    'post', 'news', 'today', 'обзор', 'дайджест', 'рынок', 'рынка', 'канала', 'канале',
    'поста', 'текст', 'утренний', 'вечерний', 'weekly', 'daily', 'alert', 'analysis',
    'очень', 'если', 'после', 'между', 'почему', 'когда', 'where', 'what', 'about', 'your',
  ]);

  return [...new Set(
    normalizeText(text)
      .split(/\s+/)
      .map(word => word.trim())
      .filter(word => word.length >= 3 && !stopWords.has(word))
  )].slice(0, 32);
}

function normalizeText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isValidMediaPath(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size >= MIN_MEDIA_FILE_SIZE_BYTES;
  } catch {
    return false;
  }
}

function parsePaths(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch {
    return value ? [value] : [];
  }
}

function buildSourceKey(channel, telegramPostId) {
  const normalizedChannel = String(channel || '').trim().toLowerCase();
  const normalizedPostId = Number(telegramPostId) || 0;
  return normalizedChannel && normalizedPostId ? `${normalizedChannel}:${normalizedPostId}` : '';
}

function parseUsedInPosts(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseTimestampMs(value) {
  if (!value) return 0;
  const normalized = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(String(value))
    ? `${value}Z`
    : String(value);
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

function getPublishedMediaPathSet(profileId = null) {
  const whereParts = [
    'published_at IS NOT NULL',
    'media_path IS NOT NULL',
    "media_path != ''",
  ];
  const params = [];

  if (profileId) {
    whereParts.unshift('profile_id = ?');
    params.unshift(profileId);
  }

  const rows = queryAll(
    `SELECT media_path
     FROM posts
     WHERE ${whereParts.join('\n       AND ')}
     ORDER BY published_at DESC, id DESC
     LIMIT ${RECENT_PUBLISHED_MEDIA_LIMIT}`,
    params,
  );

  return new Set(
    rows
      .map((row) => String(row.media_path || '').trim())
      .filter(Boolean),
  );
}

function getFileHash(filePath) {
  const normalizedPath = String(filePath || '').trim();
  if (!normalizedPath) return '';

  const cached = mediaHashCache.get(normalizedPath);
  if (cached) {
    return cached;
  }

  try {
    const buffer = fs.readFileSync(normalizedPath);
    const hash = crypto.createHash('sha1').update(buffer).digest('hex');
    mediaHashCache.set(normalizedPath, hash);
    return hash;
  } catch (err) {
    logger.debug(`mediaHandler: failed to hash ${normalizedPath}: ${err.message}`);
    return '';
  }
}

function getPublishedMediaHashSet(profileId = null) {
  const publishedPaths = getPublishedMediaPathSet(profileId);
  const hashes = new Set();

  for (const mediaPath of publishedPaths) {
    const hash = getFileHash(mediaPath);
    if (hash) {
      hashes.add(hash);
    }
  }

  return hashes;
}

function rememberRejectedSource(candidate, context = {}) {
  if (!candidate) return false;

  const profileKey = String(context.profileId || 'default');
  const registry = readRejectedSourceRegistry();
  const entry = registry[profileKey] && typeof registry[profileKey] === 'object'
    ? registry[profileKey]
    : { sourceKeys: [], mediaPaths: [], mediaHashes: [] };

  const sourceKeys = new Set(Array.isArray(entry.sourceKeys) ? entry.sourceKeys.filter(Boolean) : []);
  const mediaPaths = new Set(Array.isArray(entry.mediaPaths) ? entry.mediaPaths.filter(Boolean) : []);
  const mediaHashes = new Set(Array.isArray(entry.mediaHashes) ? entry.mediaHashes.filter(Boolean) : []);

  if (candidate.sourceKey) {
    sourceKeys.add(candidate.sourceKey);
  }
  for (const mediaPath of (Array.isArray(candidate.paths) ? candidate.paths : [candidate.path]).filter(Boolean)) {
    mediaPaths.add(mediaPath);
    const hash = getFileHash(mediaPath);
    if (hash) {
      mediaHashes.add(hash);
    }
  }

  registry[profileKey] = {
    sourceKeys: [...sourceKeys].slice(-1000),
    mediaPaths: [...mediaPaths].slice(-1000),
    mediaHashes: [...mediaHashes].slice(-1000),
  };
  writeRejectedSourceRegistry(registry);
  return true;
}

function scoreCandidate(candidate, context) {
  const normalizedText = normalizeText(candidate.text);
  const normalizedChannel = normalizeText(candidate.channel);
  const ageHours = candidate.activityAtMs > 0
    ? Math.max(0, (Date.now() - candidate.activityAtMs) / (1000 * 60 * 60))
    : Number.POSITIVE_INFINITY;
  const keywordHits = context.keywords.reduce((score, keyword) => {
    if (!keyword) return score;
    return normalizedText.includes(keyword) ? score + 1 : score;
  }, 0);

  const hasExactSourceKeys = Array.isArray(context.sourceKeys) && context.sourceKeys.length > 0;
  const isExactSource = hasExactSourceKeys && context.sourceKeys.includes(candidate.sourceKey);
  const isExactPost = !hasExactSourceKeys && context.postIds.includes(candidate.telegramPostId);
  const channelMatch = context.sources.some(source => source && normalizedChannel.includes(source));
  const sizeScore = Math.min(Math.round((candidate.fileSize || 0) / 15000), 12);
  const viewsScore = Math.min(Math.round((candidate.views || 0) / 500), 20);
  const clusterBoost = candidate.clusterIndex >= 0 ? Math.max(0, 18 - (candidate.clusterIndex * 6)) : 0;
  const originBoost = candidate.origin === 'cluster' ? 25 : (candidate.origin === 'text' ? 8 : 0);
  const freshnessScore =
    ageHours <= 3 ? 48 :
    ageHours <= 6 ? 40 :
    ageHours <= 12 ? 32 :
    ageHours <= 24 ? 24 :
    ageHours <= 48 ? 14 :
    ageHours <= 72 ? 8 :
    ageHours <= 120 ? 3 : 0;

  const totalScore =
    (isExactSource ? 120 : 0) +
    (isExactPost ? 80 : 0) +
    (channelMatch ? 12 : 0) +
    (keywordHits * 14) +
    clusterBoost +
    originBoost +
    freshnessScore +
    sizeScore +
    viewsScore;

  return {
    ...candidate,
    ageHours,
    keywordHits,
    freshnessScore,
    totalScore,
  };
}

function chooseRankedMedia(scoredCandidates, limit, excluded = [], options = {}) {
  const desired = Math.max(1, Math.min(limit || MAX_MEDIA_PER_POST, 10));
  const excludeSet = new Set((excluded || []).filter(Boolean));
  const used = readUsedMediaSet();
  const publishedSet = options.publishedMediaPathSet || new Set();
  const publishedHashSet = options.publishedMediaHashSet || new Set();
  const ranked = scoredCandidates.filter((item) => !excludeSet.has(item.path));
  const unpublished = ranked.filter((item) =>
    !publishedSet.has(item.path) &&
    (!item.fileHash || !publishedHashSet.has(item.fileHash))
  );

  const fresh = unpublished.filter((item) => !used.has(item.path)).slice(0, desired);
  if (fresh.length > 0) {
    fresh.forEach((item) => used.add(item.path));
    writeUsedMediaSet(used);
    return fresh;
  }

  const unpublishedReuse = unpublished.slice(0, desired);
  if (unpublishedReuse.length > 0) {
    logger.info('mediaHandler: fresh unpublished media exhausted, reusing top-ranked unpublished candidates');
    return unpublishedReuse;
  }

  if (options.allowPublishedReuse && ranked.length > 0) {
    logger.info('mediaHandler: unpublished media exhausted, reusing already published candidates');
    return ranked.slice(0, desired);
  }

  return [];
}

function rowsToCandidates(rows, origin, clusterIndex = -1) {
  const candidates = [];

  for (const row of rows) {
    const rawPaths = parsePaths(row.media_paths);
    const validPaths = rawPaths.filter((mediaPath) => isValidMediaPath(mediaPath));
    if (validPaths.length === 0) {
      continue;
    }

    for (const mediaPath of validPaths) {
      const stat = fs.statSync(mediaPath);
      candidates.push({
        path: mediaPath,
        paths: validPaths,
        text: row.text || '',
        entities: row.entities || null,
        channel: row.channel || '',
        views: Number(row.views) || 0,
        telegramPostId: Number(row.telegram_post_id) || 0,
        sourceKey: buildSourceKey(row.channel, row.telegram_post_id),
        usedInPosts: parseUsedInPosts(row.used_in_posts),
        fileSize: stat.size,
        fileHash: getFileHash(mediaPath),
        activityAt: row.activity_at || null,
        activityAtMs: parseTimestampMs(row.activity_at),
        origin,
        clusterIndex,
      });
    }
  }

  return candidates;
}

function dedupeCandidates(candidates) {
  const unique = new Map();
  for (const candidate of candidates) {
    if (!candidate.path) continue;
    const existing = unique.get(candidate.path);
    if (!existing || candidate.totalScore > existing.totalScore) {
      unique.set(candidate.path, candidate);
    }
  }
  return Array.from(unique.values());
}

function shuffleArray(items = []) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function diversifyCandidatesByChannel(candidates = []) {
  const buckets = new Map();

  for (const candidate of candidates) {
    const channelKey = String(candidate.channel || '').trim().toLowerCase() || 'unknown';
    if (!buckets.has(channelKey)) {
      buckets.set(channelKey, []);
    }
    buckets.get(channelKey).push(candidate);
  }

  const channelOrder = shuffleArray([...buckets.keys()]);
  const diversified = [];
  let added = true;

  while (added) {
    added = false;
    for (const channelKey of channelOrder) {
      const bucket = buckets.get(channelKey) || [];
      if (bucket.length === 0) continue;
      diversified.push(bucket.shift());
      added = true;
    }
  }

  return diversified;
}

function filterRejectedCandidates(candidates = [], profileId = null) {
  const rejected = getRejectedSourceMemory(profileId || 'default');
  return candidates.filter((candidate) =>
    !rejected.sourceKeys.has(candidate.sourceKey) &&
    !rejected.mediaPaths.has(candidate.path) &&
    (!candidate.fileHash || !rejected.mediaHashes.has(candidate.fileHash))
  );
}

function parseSourceKey(sourceKey) {
  const normalized = String(sourceKey || '').trim().toLowerCase();
  if (!normalized.includes(':')) return null;

  const separatorIndex = normalized.lastIndexOf(':');
  const channel = normalized.slice(0, separatorIndex).trim();
  const telegramPostId = Number(normalized.slice(separatorIndex + 1)) || 0;

  if (!channel || !telegramPostId) return null;
  return { channel, telegramPostId };
}

function getRowsForClusterReferences(cluster = {}, limitPerCluster = 40, profileId = null) {
  const sourceRefs = [...new Set((cluster.sourceKeys || []).filter(Boolean))]
    .map(parseSourceKey)
    .filter(Boolean);
  const uniqueIds = [...new Set((cluster.postIds || []).filter(Boolean))];
  if (sourceRefs.length === 0 && uniqueIds.length === 0) return [];

  const whereParts = [
    `media_paths IS NOT NULL`,
    `media_paths != ''`,
  ];
  const params = [];

  if (sourceRefs.length > 0) {
    whereParts.unshift(`(${sourceRefs.map(() => '(LOWER(channel) = ? AND telegram_post_id = ?)').join(' OR ')})`);
    for (const ref of sourceRefs) {
      params.push(ref.channel, ref.telegramPostId);
    }
  } else {
    const placeholders = uniqueIds.map(() => '?').join(',');
    whereParts.unshift(`telegram_post_id IN (${placeholders})`);
    params.push(...uniqueIds);
  }

  if (profileId) {
    whereParts.unshift('profile_id = ?');
    params.unshift(profileId);
  }

  return queryAll(
    `SELECT channel, telegram_post_id, text, entities, media_paths, views, used_in_posts,
            COALESCE(source_date, scraped_at) AS activity_at
     FROM source_posts
     WHERE ${whereParts.join('\n       AND ')}
     ORDER BY COALESCE(source_date, scraped_at) DESC, views DESC
     LIMIT ${Math.max(limitPerCluster, Math.max(sourceRefs.length, uniqueIds.length) * 4)}`,
    params,
  );
}

function getRecentMediaRows(lookbackHours = 24, limit = MAX_RECENT_MEDIA_SCAN, profileId = null) {
  const whereParts = [
    `media_paths IS NOT NULL`,
    `media_paths != ''`,
    `COALESCE(source_date, scraped_at) >= datetime('now', ?)`,
  ];
  const params = [`-${lookbackHours} hours`];

  if (profileId) {
    whereParts.unshift('profile_id = ?');
    params.unshift(profileId);
  }

  return queryAll(
    `SELECT channel, telegram_post_id, text, entities, media_paths, views, used_in_posts,
            COALESCE(source_date, scraped_at) AS activity_at
     FROM source_posts
     WHERE ${whereParts.join('\n       AND ')}
     ORDER BY COALESCE(source_date, scraped_at) DESC, views DESC
     LIMIT ${limit}`,
    params,
  );
}

function getRankedCandidates(clusters, postText = '', options = {}) {
  const profileId = options.profileId || null;
  const context = buildSelectionContext(clusters, postText);
  const candidates = [];

  if (Array.isArray(clusters) && clusters.length > 0) {
    clusters.slice(0, 4).forEach((cluster, clusterIndex) => {
      const rows = getRowsForClusterReferences(cluster, 40, profileId);
      candidates.push(...rowsToCandidates(rows, 'cluster', clusterIndex));
    });
  }

  const recentRows = getRecentMediaRows(FALLBACK_MEDIA_LOOKBACK_HOURS, MAX_RECENT_MEDIA_SCAN, profileId);
  candidates.push(...rowsToCandidates(recentRows, 'text'));

  const ranked = dedupeCandidates(candidates.map(candidate => scoreCandidate(candidate, context)))
    .sort((a, b) =>
      (b.totalScore - a.totalScore) ||
      (b.activityAtMs - a.activityAtMs) ||
      (b.views - a.views) ||
      (b.fileSize - a.fileSize)
    );

  const filtered = filterRejectedCandidates(ranked, profileId);
  return diversifyCandidatesByChannel(filtered);
}

function rankUnusedFirst(candidates, excludedSourceKeys = []) {
  const excluded = new Set((excludedSourceKeys || []).filter(Boolean));
  const available = candidates.filter((candidate) => !excluded.has(candidate.sourceKey));
  const unused = available.filter((candidate) => !candidate.usedInPosts || candidate.usedInPosts.length === 0);
  return {
    unused,
    available,
  };
}

function pickPreferredAlternative(candidates, currentChannel = '') {
  const normalizedCurrentChannel = String(currentChannel || '').trim().toLowerCase();
  if (!normalizedCurrentChannel) {
    return candidates[0] || null;
  }

  return candidates.find((candidate) => String(candidate.channel || '').trim().toLowerCase() !== normalizedCurrentChannel)
    || candidates[0]
    || null;
}

async function selectMedia(clusters, postText = '', desiredCount = MAX_MEDIA_PER_POST, options = {}) {
  const count = Math.max(0, Math.min(desiredCount || MAX_MEDIA_PER_POST, 10));
  if (count === 0) {
    return { type: 'none', path: null, paths: [] };
  }
  const scored = getRankedCandidates(clusters, postText, options);
  const publishedMediaPathSet = getPublishedMediaPathSet(options.profileId || null);
  const publishedMediaHashSet = getPublishedMediaHashSet(options.profileId || null);

  const selected = chooseRankedMedia(scored, count, [], {
    publishedMediaPathSet,
    publishedMediaHashSet,
    allowPublishedReuse: options.allowPublishedReuse === true,
  });
  if (selected.length > 0) {
    logger.info(
      `mediaHandler: ranked media selected (${selected.length}) topScore=${selected[0].totalScore} fresh=${selected[0].freshnessScore} ageHours=${selected[0].ageHours?.toFixed?.(1) || 'n/a'} origin=${selected[0].origin}`,
    );
    return {
      type: 'photo',
      path: selected[0].path,
      paths: selected.map(item => item.path),
    };
  }

  logger.info('mediaHandler: media pool exhausted');
  return { type: 'none', path: null, paths: [] };
}

function selectLeadMediaPost(clusters, postText = '', options = {}) {
  const scored = getRankedCandidates(clusters, postText, options);
  const publishedSet = getPublishedMediaPathSet(options.profileId || null);
  const publishedHashSet = getPublishedMediaHashSet(options.profileId || null);
  const unpublished = scored.filter((candidate) =>
    !publishedSet.has(candidate.path) &&
    (!candidate.fileHash || !publishedHashSet.has(candidate.fileHash))
  );
  const { unused, available } = rankUnusedFirst(unpublished, options.excludedSourceKeys || []);
  const best = options.allowUsedSources ? (unused[0] || available[0] || null) : (unused[0] || null);
  if (!best) {
    return null;
  }

  return {
    path: best.path,
    paths: Array.isArray(best.paths) ? best.paths : [best.path].filter(Boolean),
    text: best.text,
    entities: best.entities,
    channel: best.channel,
    views: best.views,
    telegramPostId: best.telegramPostId,
    sourceKey: best.sourceKey,
    origin: best.origin,
    totalScore: best.totalScore,
    keywordHits: best.keywordHits,
  };
}

function selectAlternativeLeadMediaPost(clusters, excludedSources = [], postText = '', options = {}) {
  const scored = getRankedCandidates(clusters, postText, options);
  const publishedSet = getPublishedMediaPathSet(options.profileId || null);
  const publishedHashSet = getPublishedMediaHashSet(options.profileId || null);
  const unpublished = scored.filter((candidate) =>
    !publishedSet.has(candidate.path) &&
    (!candidate.fileHash || !publishedHashSet.has(candidate.fileHash))
  );
  const excludeSet = new Set((excludedSources || []).filter(Boolean));
  const { unused, available } = rankUnusedFirst(unpublished, excludedSources);
  const availableUnused = unused.filter((candidate) => !excludeSet.has(candidate.sourceKey));
  const availableAll = available.filter((candidate) => !excludeSet.has(candidate.sourceKey));
  const best = pickPreferredAlternative(
    availableUnused.length > 0 ? availableUnused : (options.allowUsedSources ? availableAll : []),
    options.currentChannel || '',
  );

  if (!best) {
    return null;
  }

  return {
    path: best.path,
    paths: Array.isArray(best.paths) ? best.paths : [best.path].filter(Boolean),
    text: best.text,
    entities: best.entities,
    channel: best.channel,
    views: best.views,
    telegramPostId: best.telegramPostId,
    sourceKey: best.sourceKey,
    origin: best.origin,
    totalScore: best.totalScore,
    keywordHits: best.keywordHits,
  };
}

function markSourcePostUsed(candidate, context = {}) {
  if (!candidate?.channel || !candidate?.telegramPostId) {
    return false;
  }

  const currentRow = queryAll(
    `SELECT used_in_posts
     FROM source_posts
     WHERE profile_id = ?
       AND channel = ?
       AND telegram_post_id = ?
     LIMIT 1`,
    [context.profileId || null, candidate.channel, Number(candidate.telegramPostId) || 0],
  )[0];

  const usedEntries = parseUsedInPosts(currentRow?.used_in_posts);
  const entry = {
    at: new Date().toISOString(),
    profileId: context.profileId || null,
    postType: context.postType || null,
    stage: context.stage || 'generated',
    targetChannelId: context.targetChannelId || null,
  };

  const alreadyExists = usedEntries.some((item) =>
    item &&
    item.profileId === entry.profileId &&
    item.postType === entry.postType &&
    item.stage === entry.stage
  );

  if (alreadyExists) {
    return false;
  }

  usedEntries.push(entry);
  runSql(
    `UPDATE source_posts
     SET used_in_posts = ?
     WHERE profile_id = ?
       AND channel = ?
       AND telegram_post_id = ?`,
    [
      JSON.stringify(usedEntries),
      context.profileId || null,
      candidate.channel,
      Number(candidate.telegramPostId) || 0,
    ],
  );
  return true;
}

function getMediaForPost(sourcePostIds, limit = 1, options = {}) {
  const rows = getRowsForClusterReferences(
    { postIds: sourcePostIds },
    Math.max(limit * 4, 20),
    options.profileId || null,
  );
  return rowsToCandidates(rows, 'cluster')
    .sort((a, b) => (b.activityAtMs - a.activityAtMs) || (b.views - a.views) || (b.fileSize - a.fileSize))
    .slice(0, limit)
    .map(item => item.path);
}

function getRecentMedia(limit = 1, lookbackHours = 24, options = {}) {
  return rowsToCandidates(getRecentMediaRows(lookbackHours, Math.max(limit * 10, 100), options.profileId || null), 'recent')
    .sort((a, b) => (b.activityAtMs - a.activityAtMs) || (b.views - a.views) || (b.fileSize - a.fileSize))
    .slice(0, limit)
    .map(item => item.path);
}

function getMediaByPostText(postText, limit = 1, lookbackHours = 24, options = {}) {
  const context = buildSelectionContext([], postText);
  const recentRows = getRecentMediaRows(lookbackHours, MAX_RECENT_MEDIA_SCAN, options.profileId || null);
  const scored = dedupeCandidates(rowsToCandidates(recentRows, 'text').map(candidate => scoreCandidate(candidate, context)))
    .filter(item => item.keywordHits > 0)
    .sort((a, b) => (b.totalScore - a.totalScore) || (b.activityAtMs - a.activityAtMs) || (b.views - a.views) || (b.fileSize - a.fileSize));

  return scored.slice(0, limit).map(item => item.path);
}

function selectAlternativeMedia(currentPaths = [], limit = MAX_MEDIA_PER_POST, lookbackHours = FALLBACK_MEDIA_LOOKBACK_HOURS, postText = '', options = {}) {
  const context = buildSelectionContext([], postText);
  const recentRows = getRecentMediaRows(lookbackHours, MAX_RECENT_MEDIA_SCAN, options.profileId || null);
  const publishedMediaPathSet = getPublishedMediaPathSet(options.profileId || null);
  const publishedMediaHashSet = getPublishedMediaHashSet(options.profileId || null);
  const scored = dedupeCandidates(rowsToCandidates(recentRows, 'recent').map(candidate => scoreCandidate(candidate, context)))
    .sort((a, b) => (b.totalScore - a.totalScore) || (b.activityAtMs - a.activityAtMs) || (b.views - a.views) || (b.fileSize - a.fileSize));

  return chooseRankedMedia(scored, limit, currentPaths, {
    publishedMediaPathSet,
    publishedMediaHashSet,
    allowPublishedReuse: options.allowPublishedReuse === true,
  }).map(item => item.path);
}

function resetUsedMedia() {
  writeUsedMediaSet(new Set());
}

module.exports = {
  selectMedia,
  selectLeadMediaPost,
  selectAlternativeLeadMediaPost,
  rememberRejectedSource,
  markSourcePostUsed,
  getMediaForPost,
  getRecentMedia,
  getMediaByPostText,
  selectAlternativeMedia,
  resetUsedMedia,
};
