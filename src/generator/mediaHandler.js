const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { queryAll } = require('../utils/dbHelpers');
const logger = require('../utils/logger');

const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

/**
 * Select media for a post based on clusters.
 * Scans data/media_cache/ for images related to top cluster posts.
 * @param {Array} clusters - topic clusters
 * @param {string} [mediaCache] - path to media cache directory
 * @returns {{ type: 'photo'|'none', path: string|null }}
 */
async function selectMedia(clusters, mediaCache) {
  const cacheDir = mediaCache || config.paths.mediaCache;

  if (!clusters || clusters.length === 0) {
    return { type: 'none', path: null };
  }

  // Collect all post IDs from clusters (prioritize top clusters)
  const postIds = [];
  for (const cluster of clusters) {
    if (cluster.postIds && Array.isArray(cluster.postIds)) {
      postIds.push(...cluster.postIds);
    }
  }

  // First, check DB for cached media paths from source posts
  const dbMedia = getMediaForPost(postIds);
  if (dbMedia) {
    return { type: 'photo', path: dbMedia };
  }

  // Нет релевантного медиа — не прикрепляем случайные картинки из кеша
  return { type: 'none', path: null };
}

/**
 * Check if any source post has cached media via the source_posts table.
 * @param {Array<number|string>} sourcePostIds - post IDs to check
 * @returns {string|null} first found media path or null
 */
function getMediaForPost(sourcePostIds) {
  if (!sourcePostIds || sourcePostIds.length === 0) return null;

  try {
    const placeholders = sourcePostIds.map(() => '?').join(',');
    const rows = queryAll(
      `SELECT media_paths FROM source_posts
       WHERE id IN (${placeholders}) AND media_paths IS NOT NULL AND media_paths != ''`,
      sourcePostIds
    );

    for (const row of rows) {
      // media_paths can be a JSON array or a single path
      let paths;
      try {
        paths = JSON.parse(row.media_paths);
      } catch {
        paths = [row.media_paths];
      }

      if (Array.isArray(paths)) {
        for (const p of paths) {
          if (p && fs.existsSync(p)) {
            return p;
          }
        }
      }
    }
  } catch (err) {
    logger.error(`mediaHandler: ошибка чтения медиа из БД — ${err.message}`);
  }

  return null;
}

module.exports = {
  selectMedia,
  getMediaForPost,
};
