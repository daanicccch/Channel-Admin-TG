const fs = require('fs');
const crypto = require('crypto');
const { queryAll, queryOne, runSql } = require('./dbHelpers');
const { getTelegramVisibleText } = require('../generator/formatBuilder');
const mediaHashCache = new Map();
const MEMORY_STOP_WORDS = new Set([
  'это', 'как', 'что', 'для', 'или', 'при', 'после', 'сегодня', 'вчера', 'завтра',
  'когда', 'который', 'которая', 'которые', 'такой', 'такая', 'такие', 'просто',
  'очень', 'снова', 'теперь', 'только', 'между', 'пока', 'если', 'есть',
  'about', 'after', 'before', 'with', 'from', 'this', 'that', 'have', 'will', 'into',
  'telegram', 'gifts', 'gift', 'channel', 'post', 'news',
]);

function toVisibleText(text) {
  return getTelegramVisibleText(String(text || ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text, profileId = 'default') {
  return toVisibleText(text)
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !MEMORY_STOP_WORDS.has(word));
}

function uniqueTokens(text, profileId = 'default') {
  return [...new Set(tokenize(text, profileId))];
}

function jaccardFromArrays(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 0;

  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1;
  }

  return intersection / union.size;
}

function getTitle(text) {
  return toVisibleText(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)[0] || '';
}

function buildOpening(text, maxWords = 12) {
  return toVisibleText(text)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join(' ');
}

function normalizeKeywordList(items = []) {
  const expanded = [];

  for (const rawItem of (Array.isArray(items) ? items : [])) {
    const item = String(rawItem || '').toLowerCase().trim().replace(/^[$#]+/, '');
    if (item.length < 3 || MEMORY_STOP_WORDS.has(item)) {
      continue;
    }

    expanded.push(item);

    // Many meme channels alternate between $BIAO and gBIAO-style tickers.
    if (/^g[a-z0-9]{3,10}$/i.test(item)) {
      expanded.push(item.slice(1));
    }
  }

  return [...new Set(expanded)];
}

function extractEntityHintsFromText(text) {
  const rawText = String(text || '');
  const cashtags = [...rawText.matchAll(/[$#]([A-Za-z][A-Za-z0-9]{2,11})/g)].map((match) => match[1]);
  const normalized = toVisibleText(rawText).toLowerCase();
  const hints = [...cashtags];

  if (/\beuipo\b/i.test(normalized)) hints.push('euipo');
  if (/\btrademark\b|\bтоварн(ый|ого)\s+знак/i.test(normalized)) hints.push('trademark');
  if (/\bip\b|\bip rights\b|ip-прав|интеллектуальн/i.test(normalized)) hints.push('ip_rights');

  return hints;
}

function detectEventType(text) {
  const normalized = toVisibleText(text).toLowerCase();
  const patterns = [
    { type: 'ip_rights', regex: /\b(euipo|trademark|товарн(ый|ого)\s+знак|ip rights|ip-права|интеллектуальн)\b/i },
    { type: 'concepts_closed', regex: /\b(закрыли темы|закрыли концепты|сбор идей закрыт|прием концептов закрыт|темы закрыты|concepts closed|topics closed)\b/i },
    { type: 'upgrade_signal', regex: /\b(апгрейд|апгрейды|улучшени[яй]|обновлени[яй]|редизайн|анимации|эффекты)\b/i },
    { type: 'trade', regex: /\b(обмен|обменяли|сделка|трейд|trade)\b/i },
    { type: 'offer', regex: /\b(оффер|offer|предложени[ея]|floor|флор)\b/i },
  ];

  const matched = patterns.find((pattern) => pattern.regex.test(normalized));
  return matched?.type || null;
}

function buildEventFingerprint(input = {}, profileId = 'default') {
  const text = [
    input.text,
    input.topic,
    input.summary,
    ...(Array.isArray(input.keyFacts) ? input.keyFacts : []),
  ].filter(Boolean).join(' ');

  return {
    eventType: input.eventType || detectEventType(text),
    entities: normalizeKeywordList(
      [
        ...((input.entities && input.entities.length > 0)
          ? input.entities
          : tokenize(text, profileId).slice(0, 12)),
        ...extractEntityHintsFromText(text),
      ]
    ),
    topic: String(input.topic || '').trim(),
  };
}

function eventFingerprintsMatch(currentFingerprint, previousFingerprint) {
  if (!currentFingerprint?.eventType || !previousFingerprint?.eventType) {
    return null;
  }
  if (currentFingerprint.eventType !== previousFingerprint.eventType) {
    return null;
  }

  const currentEntities = new Set(currentFingerprint.entities || []);
  const previousEntities = new Set(previousFingerprint.entities || []);
  const intersection = [...currentEntities].filter((item) => previousEntities.has(item));
  const union = new Set([...currentEntities, ...previousEntities]);
  const overlap = union.size > 0 ? intersection.length / union.size : 0;

  if (currentEntities.size === 0 || previousEntities.size === 0) {
    return { score: 0.82, overlap: 0 };
  }

  if (intersection.length >= 2 || overlap >= 0.34) {
    return { score: 0.85 + Math.min(overlap, 0.1), overlap };
  }

  if (
    currentFingerprint.eventType === 'ip_rights' &&
    intersection.length >= 1
  ) {
    return { score: 0.85 + Math.min(overlap, 0.1), overlap };
  }

  return null;
}

function getFileHash(filePath) {
  const normalizedPath = String(filePath || '').trim();
  if (!normalizedPath) return '';

  const cached = mediaHashCache.get(normalizedPath);
  if (cached) return cached;

  try {
    const buffer = fs.readFileSync(normalizedPath);
    const hash = crypto.createHash('sha1').update(buffer).digest('hex');
    mediaHashCache.set(normalizedPath, hash);
    return hash;
  } catch {
    return '';
  }
}

function summarizePost(row, profileId = 'default') {
  const plainText = toVisibleText(row.text || '');
  let engagement = {};
  try {
    engagement = row.engagement ? JSON.parse(row.engagement) : {};
  } catch {
    engagement = {};
  }
  return {
    id: row.id,
    type: row.type || 'post',
    publishedAt: row.published_at || null,
    mediaPath: row.media_path || null,
    mediaHash: getFileHash(row.media_path || ''),
    text: plainText,
    title: getTitle(row.text || ''),
    opening: buildOpening(plainText),
    tokenSet: uniqueTokens(plainText, profileId),
    eventFingerprint: engagement.eventFingerprint || null,
  };
}

function getRecentPosts(profileId = 'default', limit = 10, options = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 30));
  const whereParts = ['profile_id = ?'];
  const params = [profileId];

  if (options.publishedOnly) {
    whereParts.push('published_at IS NOT NULL');
  }

  if (Number.isFinite(options.withinHours) && options.withinHours > 0) {
    whereParts.push(`published_at >= datetime('now', ?)`);
    params.push(`-${Math.floor(options.withinHours)} hours`);
  }

  const rows = queryAll(
    `
      SELECT id, type, text, published_at, engagement, media_path
      FROM posts
      WHERE ${whereParts.join('\n        AND ')}
      ORDER BY published_at DESC, id DESC
      LIMIT ${safeLimit}
    `,
    params,
  );

  return rows.map((row) => summarizePost(row, profileId));
}

function buildMemoryPrompt(profileId = 'default', postType = 'post', anchorKeywords = []) {
  const anchors = [...new Set(
    (anchorKeywords || [])
      .map((item) => String(item || '').toLowerCase().trim())
      .filter((item) => item.length >= 4),
  )];

  const posts = getRecentPosts(profileId, 18)
    .map((post) => {
      const anchorHits = anchors.filter((anchor) => post.tokenSet.includes(anchor)).length;
      return {
        ...post,
        memoryScore: (post.type === postType ? 3 : 0) + anchorHits,
      };
    })
    .sort((left, right) => right.memoryScore - left.memoryScore || right.id - left.id)
    .slice(0, 6);

  if (posts.length === 0) {
    return 'Недавних постов в памяти пока нет.';
  }

  return posts.map((post, index) => {
    const status = post.publishedAt ? `published ${post.publishedAt}` : 'draft';
    const title = post.title || post.opening || '(без заголовка)';
    return `${index + 1}. [${post.type}] ${status} | ${title}`;
  }).join('\n');
}

function findSimilarPost(text, profileId = 'default', currentPostType = 'post', options = {}) {
  const recentPosts = Array.isArray(options.recentPosts) && options.recentPosts.length > 0
    ? options.recentPosts
    : getRecentPosts(profileId, 12, {
      publishedOnly: options.publishedOnly === true,
      withinHours: options.withinHours,
    });

  const currentText = toVisibleText(text);
  const currentTokens = uniqueTokens(currentText, profileId);
  const currentTitleTokens = uniqueTokens(getTitle(currentText), profileId);
  const currentOpening = buildOpening(currentText, 14).toLowerCase();
  const currentEventFingerprint = options.currentEventFingerprint || null;
  const currentMediaPaths = [...new Set(
    (Array.isArray(options.currentMediaPaths) ? options.currentMediaPaths : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  )];
  const currentMediaHashes = new Set(
    currentMediaPaths
      .map((mediaPath) => getFileHash(mediaPath))
      .filter(Boolean),
  );

  let bestMatch = null;

  for (const post of recentPosts) {
    const eventMatch = currentEventFingerprint && post.eventFingerprint
      ? eventFingerprintsMatch(currentEventFingerprint, post.eventFingerprint)
      : null;
    const titleSimilarity = jaccardFromArrays(currentTitleTokens, uniqueTokens(post.title, profileId));
    const bodySimilarity = jaccardFromArrays(currentTokens, post.tokenSet);
    const sameOpening = currentOpening && post.opening
      ? currentOpening === String(post.opening).toLowerCase()
      : false;
    const sameMediaPath = Boolean(post.mediaPath) && currentMediaPaths.includes(String(post.mediaPath).trim());
    const sameMediaHash = Boolean(post.mediaHash) && currentMediaHashes.has(post.mediaHash);
    const hasSameMedia = sameMediaPath || sameMediaHash;
    const score = Math.max(
      bodySimilarity,
      titleSimilarity + (sameOpening ? 0.2 : 0),
      eventMatch?.score || 0,
    );
    const threshold = post.type === currentPostType ? 0.5 : 0.72;
    const mediaBackedDuplicate = hasSameMedia && (
      score >= 0.34 ||
      sameOpening ||
      titleSimilarity >= 0.28 ||
      Boolean(eventMatch)
    );

    if ((mediaBackedDuplicate || score >= threshold) && (!bestMatch || score > bestMatch.score || (hasSameMedia && !bestMatch.sameMedia))) {
      bestMatch = {
        id: post.id,
        type: post.type,
        title: post.title || post.opening || '(?????? ??????????????????)',
        publishedAt: post.publishedAt,
        score,
        eventType: post.eventFingerprint?.eventType || null,
        sameMedia: hasSameMedia,
        sameMediaPath,
        sameMediaHash,
      };
    }
  }

  return bestMatch;
}

function insertGeneratedPost(post, options = {}) {
  runSql(
    `
      INSERT INTO posts (profile_id, type, text, media_path, sources, engagement)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [
      options.profileId || post._profileId || 'default',
      post.postType || options.postType || 'post',
      post.text || '',
      post.media?.path || null,
      JSON.stringify(options.sources || []),
      JSON.stringify({
        ...(options.engagement || {}),
        eventFingerprint: options.eventFingerprint || null,
      }),
    ],
  );

  const row = queryOne('SELECT last_insert_rowid() AS id');
  return row?.id || null;
}

function markPostPublished(postId, messageId) {
  if (!postId) return;
  runSql(
    "UPDATE posts SET telegram_message_id = ?, published_at = datetime('now') WHERE id = ?",
    [messageId, postId],
  );
}

module.exports = {
  buildEventFingerprint,
  buildMemoryPrompt,
  findSimilarPost,
  getRecentPosts,
  insertGeneratedPost,
  markPostPublished,
  toVisibleText,
};
