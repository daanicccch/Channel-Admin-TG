const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { queryAll, runSql } = require('../utils/dbHelpers');
const logger = require('../utils/logger');

const MAX_MEDIA_PER_POST = parseInt(process.env.TG_MAX_MEDIA_PER_POST || '1', 10);
const FALLBACK_MEDIA_LOOKBACK_HOURS = parseInt(process.env.TG_FALLBACK_MEDIA_LOOKBACK_HOURS || '24', 10);
const USED_MEDIA_FILE = path.join(config.paths.data, 'used_media.json');
const MIN_MEDIA_FILE_SIZE_BYTES = parseInt(process.env.TG_MIN_MEDIA_FILE_SIZE_BYTES || '20000', 10);
const MAX_RECENT_MEDIA_SCAN = parseInt(process.env.TG_MAX_RECENT_MEDIA_SCAN || '700', 10);

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

function scoreCandidate(candidate, context) {
  const normalizedText = normalizeText(candidate.text);
  const normalizedChannel = normalizeText(candidate.channel);
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

  const totalScore =
    (isExactSource ? 120 : 0) +
    (isExactPost ? 80 : 0) +
    (channelMatch ? 12 : 0) +
    (keywordHits * 14) +
    clusterBoost +
    originBoost +
    sizeScore +
    viewsScore;

  return {
    ...candidate,
    keywordHits,
    totalScore,
  };
}

function chooseRankedMedia(scoredCandidates, limit, excluded = []) {
  const desired = Math.max(1, Math.min(limit || MAX_MEDIA_PER_POST, 10));
  const excludeSet = new Set((excluded || []).filter(Boolean));
  const used = readUsedMediaSet();
  const ranked = scoredCandidates.filter(item => !excludeSet.has(item.path));

  const fresh = ranked.filter(item => !used.has(item.path)).slice(0, desired);
  if (fresh.length > 0) {
    fresh.forEach(item => used.add(item.path));
    writeUsedMediaSet(used);
    return fresh;
  }

  if (ranked.length > 0) {
    logger.info('mediaHandler: relevant fresh media exhausted, reusing top-ranked candidates');
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
    `SELECT channel, telegram_post_id, text, entities, media_paths, views, used_in_posts
     FROM source_posts
     WHERE ${whereParts.join('\n       AND ')}
     ORDER BY views DESC, scraped_at DESC
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
    `SELECT channel, telegram_post_id, text, entities, media_paths, views, used_in_posts
     FROM source_posts
     WHERE ${whereParts.join('\n       AND ')}
     ORDER BY views DESC, COALESCE(source_date, scraped_at) DESC
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

  return dedupeCandidates(candidates.map(candidate => scoreCandidate(candidate, context)))
    .sort((a, b) => (b.totalScore - a.totalScore) || (b.views - a.views) || (b.fileSize - a.fileSize));
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

async function selectMedia(clusters, postText = '', desiredCount = MAX_MEDIA_PER_POST, options = {}) {
  const count = Math.max(0, Math.min(desiredCount || MAX_MEDIA_PER_POST, 10));
  if (count === 0) {
    return { type: 'none', path: null, paths: [] };
  }
  const scored = getRankedCandidates(clusters, postText, options);

  const selected = chooseRankedMedia(scored, count);
  if (selected.length > 0) {
    logger.info(`mediaHandler: ranked media selected (${selected.length}) topScore=${selected[0].totalScore} origin=${selected[0].origin}`);
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
  const { unused, available } = rankUnusedFirst(scored, options.excludedSourceKeys || []);
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
  const excludeSet = new Set((excludedSources || []).filter(Boolean));
  const { unused, available } = rankUnusedFirst(scored, excludedSources);
  const best =
    unused.find((candidate) => !excludeSet.has(candidate.sourceKey)) ||
    (options.allowUsedSources ? available.find((candidate) => !excludeSet.has(candidate.sourceKey)) : null);

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
    .sort((a, b) => (b.views - a.views) || (b.fileSize - a.fileSize))
    .slice(0, limit)
    .map(item => item.path);
}

function getRecentMedia(limit = 1, lookbackHours = 24, options = {}) {
  return rowsToCandidates(getRecentMediaRows(lookbackHours, Math.max(limit * 10, 100), options.profileId || null), 'recent')
    .sort((a, b) => (b.views - a.views) || (b.fileSize - a.fileSize))
    .slice(0, limit)
    .map(item => item.path);
}

function getMediaByPostText(postText, limit = 1, lookbackHours = 24, options = {}) {
  const context = buildSelectionContext([], postText);
  const recentRows = getRecentMediaRows(lookbackHours, MAX_RECENT_MEDIA_SCAN, options.profileId || null);
  const scored = dedupeCandidates(rowsToCandidates(recentRows, 'text').map(candidate => scoreCandidate(candidate, context)))
    .filter(item => item.keywordHits > 0)
    .sort((a, b) => (b.totalScore - a.totalScore) || (b.views - a.views) || (b.fileSize - a.fileSize));

  return scored.slice(0, limit).map(item => item.path);
}

function selectAlternativeMedia(currentPaths = [], limit = MAX_MEDIA_PER_POST, lookbackHours = FALLBACK_MEDIA_LOOKBACK_HOURS, postText = '', options = {}) {
  const context = buildSelectionContext([], postText);
  const recentRows = getRecentMediaRows(lookbackHours, MAX_RECENT_MEDIA_SCAN, options.profileId || null);
  const scored = dedupeCandidates(rowsToCandidates(recentRows, 'recent').map(candidate => scoreCandidate(candidate, context)))
    .sort((a, b) => (b.totalScore - a.totalScore) || (b.views - a.views) || (b.fileSize - a.fileSize));

  return chooseRankedMedia(scored, limit, currentPaths).map(item => item.path);
}

function resetUsedMedia() {
  writeUsedMediaSet(new Set());
}

module.exports = {
  selectMedia,
  selectLeadMediaPost,
  selectAlternativeLeadMediaPost,
  markSourcePostUsed,
  getMediaForPost,
  getRecentMedia,
  getMediaByPostText,
  selectAlternativeMedia,
  resetUsedMedia,
};
