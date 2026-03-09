const aiProvider = require('../ai/aiProvider');
const logger = require('../utils/logger');

const MAX_PROMPT_CHARS = 50000;

class ContentAnalyzer {
  /**
   * Analyze scraped posts: cluster by topic, extract facts, rank by importance.
   * @param {Array} scrapedPosts - array of source post objects
   * @param {object} webData - supplementary web/API data
   * @returns {Array} clusters sorted by engagementScore descending
   */
  async analyze(scrapedPosts, webData = {}) {
    if (!scrapedPosts || scrapedPosts.length === 0) {
      logger.warn('ContentAnalyzer: нет постов для анализа');
      return [];
    }

    const postsText = this._serializePosts(scrapedPosts);

    // If text is too long, split into two batches and merge results
    if (postsText.length > MAX_PROMPT_CHARS) {
      logger.info(`ContentAnalyzer: текст слишком длинный (${postsText.length}), разделяем на 2 батча`);
      return this._analyzeInBatches(scrapedPosts, webData);
    }

    return this._analyzeChunk(postsText, webData);
  }

  /**
   * Get top N clusters by engagement score.
   * @param {Array} scrapedPosts
   * @param {object} webData
   * @param {number} count
   * @returns {Array} top clusters
   */
  async getTopClusters(scrapedPosts, webData = {}, count = 5) {
    const clusters = await this.analyze(scrapedPosts, webData);
    return clusters.slice(0, count);
  }

  /**
   * Split posts into 2 batches, analyze each, then merge clusters.
   */
  async _analyzeInBatches(scrapedPosts, webData) {
    const mid = Math.ceil(scrapedPosts.length / 2);
    const batch1 = scrapedPosts.slice(0, mid);
    const batch2 = scrapedPosts.slice(mid);

    const text1 = this._serializePosts(batch1);
    const text2 = this._serializePosts(batch2);

    const [clusters1, clusters2] = await Promise.all([
      this._analyzeChunk(text1, webData),
      this._analyzeChunk(text2, webData),
    ]);

    return this._mergeClusters([...clusters1, ...clusters2]);
  }

  /**
   * Analyze a single chunk of serialized posts.
   */
  async _analyzeChunk(postsText, webData) {
    const webContext = Object.keys(webData).length > 0
      ? `\n\nДополнительные данные из веб-источников:\n${JSON.stringify(webData, null, 2)}`
      : '';

    const prompt = `Ты — аналитик крипто-каналов. Проанализируй посты ниже и выполни следующее:

1. Кластеризуй посты по темам. Посты об одном и том же событии/новости должны быть в одном кластере.
2. Извлеки ключевые факты и числа для каждого кластера.
3. Оцени важность каждого кластера: engagementScore = суммарные просмотры * коэффициент реакций (больше реакций = выше score).
4. Верни JSON-массив кластеров, отсортированный по engagementScore (от большего к меньшему).

Формат каждого кластера:
{
  "topic": "краткое название темы",
  "summary": "краткое резюме события/темы в 1-3 предложениях",
  "keyFacts": ["факт 1", "факт 2"],
  "sources": ["название канала 1", "название канала 2"],
  "engagementScore": число,
  "postIds": [id1, id2]
}

ПОСТЫ:
${postsText}
${webContext}

Верни ТОЛЬКО JSON-массив, без дополнительного текста.`;

    try {
      const result = await aiProvider.generateJSON(prompt);
      const clusters = Array.isArray(result) ? result : (result.clusters || []);
      clusters.sort((a, b) => (b.engagementScore || 0) - (a.engagementScore || 0));
      logger.info(`ContentAnalyzer: получено ${clusters.length} кластеров`);
      return clusters;
    } catch (err) {
      logger.error(`ContentAnalyzer: ошибка анализа — ${err.message}`);
      return [];
    }
  }

  /**
   * Merge clusters from multiple batches by combining those with the same topic.
   */
  _mergeClusters(clusters) {
    const merged = new Map();

    for (const cluster of clusters) {
      const key = (cluster.topic || '').toLowerCase().trim();
      if (merged.has(key)) {
        const existing = merged.get(key);
        existing.keyFacts = [...new Set([...existing.keyFacts, ...cluster.keyFacts])];
        existing.sources = [...new Set([...existing.sources, ...cluster.sources])];
        existing.postIds = [...new Set([...existing.postIds, ...cluster.postIds])];
        existing.engagementScore = (existing.engagementScore || 0) + (cluster.engagementScore || 0);
        // Keep the longer summary
        if ((cluster.summary || '').length > (existing.summary || '').length) {
          existing.summary = cluster.summary;
        }
      } else {
        merged.set(key, { ...cluster });
      }
    }

    const result = Array.from(merged.values());
    result.sort((a, b) => (b.engagementScore || 0) - (a.engagementScore || 0));
    return result;
  }

  /**
   * Serialize posts array into a text block for the prompt, truncating if needed.
   */
  _serializePosts(posts) {
    const lines = posts.map((p, i) => {
      const id = p.id || p.telegram_post_id || i;
      const channel = p.channel || 'unknown';
      const views = p.views || 0;
      const reactions = p.reactions || '';
      const text = (p.text || '').substring(0, 2000);
      return `[ID:${id}][${channel}][views:${views}][reactions:${reactions}]\n${text}`;
    });

    let result = lines.join('\n---\n');

    if (result.length > MAX_PROMPT_CHARS) {
      result = result.substring(0, MAX_PROMPT_CHARS) + '\n... (текст обрезан)';
    }

    return result;
  }
}

module.exports = ContentAnalyzer;
