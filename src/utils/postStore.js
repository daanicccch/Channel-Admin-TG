const { queryAll, queryOne, runSql } = require('./dbHelpers');
const { getTelegramVisibleText } = require('../generator/formatBuilder');
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

function summarizePost(row, profileId = 'default') {
  const plainText = toVisibleText(row.text || '');
  return {
    id: row.id,
    type: row.type || 'digest',
    publishedAt: row.published_at || null,
    text: plainText,
    title: getTitle(row.text || ''),
    opening: buildOpening(plainText),
    tokenSet: uniqueTokens(plainText, profileId),
  };
}

function getRecentPosts(profileId = 'default', limit = 10) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 30));
  const rows = queryAll(
    `
      SELECT id, type, text, published_at
      FROM posts
      WHERE profile_id = ?
      ORDER BY id DESC
      LIMIT ${safeLimit}
    `,
    [profileId],
  );

  return rows.map((row) => summarizePost(row, profileId));
}

function buildMemoryPrompt(profileId = 'default', postType = 'digest', anchorKeywords = []) {
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

function findSimilarPost(text, profileId = 'default', currentPostType = 'digest', options = {}) {
  const recentPosts = Array.isArray(options.recentPosts) && options.recentPosts.length > 0
    ? options.recentPosts
    : getRecentPosts(profileId, 12);

  const currentText = toVisibleText(text);
  const currentTokens = uniqueTokens(currentText, profileId);
  const currentTitleTokens = uniqueTokens(getTitle(currentText), profileId);
  const currentOpening = buildOpening(currentText, 14).toLowerCase();

  let bestMatch = null;

  for (const post of recentPosts) {
    const titleSimilarity = jaccardFromArrays(currentTitleTokens, uniqueTokens(post.title, profileId));
    const bodySimilarity = jaccardFromArrays(currentTokens, post.tokenSet);
    const sameOpening = currentOpening && post.opening
      ? currentOpening === String(post.opening).toLowerCase()
      : false;
    const score = Math.max(bodySimilarity, titleSimilarity + (sameOpening ? 0.2 : 0));
    const threshold = post.type === currentPostType ? 0.5 : 0.72;

    if (score >= threshold && (!bestMatch || score > bestMatch.score)) {
      bestMatch = {
        id: post.id,
        type: post.type,
        title: post.title || post.opening || '(без заголовка)',
        publishedAt: post.publishedAt,
        score,
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
      post.postType || options.postType || 'digest',
      post.text || '',
      post.media?.path || null,
      JSON.stringify(options.sources || []),
      JSON.stringify(options.engagement || {}),
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
  buildMemoryPrompt,
  findSimilarPost,
  getRecentPosts,
  insertGeneratedPost,
  markPostPublished,
  toVisibleText,
};
