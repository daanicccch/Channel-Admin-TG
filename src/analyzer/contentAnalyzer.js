const aiProvider = require('../ai/aiProvider');
const logger = require('../utils/logger');

const MAX_PROMPT_CHARS = 30000;
const MAX_OUTPUT_CLUSTERS = 12;
const MAX_FALLBACK_CLUSTERS = 6;

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
    let clusters = [];

    if (postsText.length > MAX_PROMPT_CHARS) {
      logger.info(`ContentAnalyzer: текст слишком длинный (${postsText.length}), разделяем на 2 батча`);
      clusters = await this._analyzeInBatches(scrapedPosts, webData);
    } else {
      clusters = await this._analyzeChunk(scrapedPosts, postsText, webData);
    }

    if (clusters.length === 0) {
      const fallbackClusters = this.buildFallbackClusters(scrapedPosts);
      logger.warn(`ContentAnalyzer: AI-анализ пустой, используем fallback-кластеры (${fallbackClusters.length})`);
      return fallbackClusters;
    }

    return clusters;
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
      this._analyzeChunk(batch1, text1, webData),
      this._analyzeChunk(batch2, text2, webData),
    ]);

    return this._mergeClusters([...clusters1, ...clusters2]);
  }

  /**
   * Analyze a single chunk of serialized posts.
   */
  async _analyzeChunk(sourcePosts, postsText, webData) {
    const webContext = Object.keys(webData).length > 0
      ? `\n\nДополнительные данные из веб-источников:\n${JSON.stringify(webData, null, 2)}`
      : '';

    const prompt = `Ты — редактор-аналитик, который готовит дайджест по реальным источникам.

Задача:
1. Кластеризуй посты по темам. Посты об одном и том же событии должны оказаться в одном кластере.
2. Извлеки ключевые факты и числа для каждого кластера.
3. Оцени важность каждого кластера: engagementScore = суммарные просмотры * коэффициент реакций.
4. Слей очень близкие инфоповоды, чтобы не плодить дубль-темы.
5. Верни не больше ${MAX_OUTPUT_CLUSTERS} кластеров.

Важно:
- Опирайся только на сами посты, источники и веб-данные.
- Приоритет у тем, которые реально доминируют по просмотрам, реакциям и числу источников.

Формат каждого кластера:
{
  "topic": "краткое название темы",
  "summary": "краткое резюме события/темы в 1-3 предложениях",
  "keyFacts": ["факт 1", "факт 2"],
  "sources": ["название канала 1", "название канала 2"],
  "engagementScore": число,
  "sourceKeys": ["channel_a:101", "channel_b:555"],
  "postIds": [id1, id2]
}

ПОСТЫ:
${postsText}
${webContext}

Верни ТОЛЬКО JSON-массив, без дополнительного текста.`;

    try {
      const result = await aiProvider.generateJSON(prompt, { temperature: 0.15, maxTokens: 4096 });
      const clusters = Array.isArray(result) ? result : (result.clusters || []);
      clusters.sort((a, b) => (b.engagementScore || 0) - (a.engagementScore || 0));
      logger.info(`ContentAnalyzer: получено ${clusters.length} кластеров`);
      return clusters;
    } catch (err) {
      logger.error(`ContentAnalyzer: ошибка анализа — ${err.message}`);
      return [];
    }
  }

  buildFallbackClusters(scrapedPosts) {
    const rankedPosts = [...(scrapedPosts || [])]
      .filter(post => String(post.text || '').trim().length >= 40)
      .map(post => ({
        ...post,
        _score: this._estimateEngagementScore(post),
      }))
      .sort((a, b) => b._score - a._score);

    const selected = [];
    const perChannelCount = new Map();

    for (const post of rankedPosts) {
      const channelKey = post.channel || post.channelTitle || 'unknown';
      const channelCount = perChannelCount.get(channelKey) || 0;
      if (channelCount >= 2) {
        continue;
      }

      selected.push(post);
      perChannelCount.set(channelKey, channelCount + 1);

      if (selected.length >= MAX_FALLBACK_CLUSTERS) {
        break;
      }
    }

    return selected.map(post => ({
      topic: this._extractTopic(post.text, post.channelTitle, post.channel),
      summary: this._extractSummary(post.text),
      keyFacts: this._extractKeyFacts(post.text),
      sources: [post.channelTitle || post.channel || 'unknown'],
      sourceKeys: [this._buildSourceKey(post.channel, post.id || post.telegram_post_id || 0)].filter(Boolean),
      engagementScore: post._score,
      postIds: [post.id || post.telegram_post_id || 0],
      fallback: true,
    }));
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
        existing.keyFacts = [...new Set([...(existing.keyFacts || []), ...(cluster.keyFacts || [])])];
        existing.sources = [...new Set([...(existing.sources || []), ...(cluster.sources || [])])];
        existing.sourceKeys = [...new Set([...(existing.sourceKeys || []), ...(cluster.sourceKeys || [])])];
        existing.postIds = [...new Set([...(existing.postIds || []), ...(cluster.postIds || [])])];
        existing.engagementScore = (existing.engagementScore || 0) + (cluster.engagementScore || 0);
        if ((cluster.summary || '').length > (existing.summary || '').length) {
          existing.summary = cluster.summary;
        }
      } else {
        merged.set(key, {
          keyFacts: [],
          sources: [],
          sourceKeys: [],
          postIds: [],
          ...cluster,
        });
      }
    }

    const result = Array.from(merged.values());
    result.sort((a, b) => (b.engagementScore || 0) - (a.engagementScore || 0));
    return result.slice(0, MAX_OUTPUT_CLUSTERS);
  }

  /**
   * Serialize posts array into a text block for the prompt, truncating if needed.
   */
  _serializePosts(posts) {
    const lines = posts.map((p, i) => {
      const id = p.id || p.telegram_post_id || i;
      const channel = p.channelTitle || p.channel || 'unknown';
      const sourceKey = this._buildSourceKey(p.channel, id);
      const views = p.views || 0;
      const reactions = typeof p.reactions === 'string' ? p.reactions : JSON.stringify(p.reactions || '');
      const text = (p.text || '').substring(0, 1600);
      return `[ID:${id}][SOURCE:${sourceKey || 'unknown'}][${channel}][views:${views}][reactions:${reactions}]\n${text}`;
    });

    let result = lines.join('\n---\n');

    if (result.length > MAX_PROMPT_CHARS) {
      result = result.substring(0, MAX_PROMPT_CHARS) + '\n... (текст обрезан)';
    }

    return result;
  }

  _estimateEngagementScore(post) {
    const views = Number(post.views) || 0;
    const reactionsText = typeof post.reactions === 'string'
      ? post.reactions
      : JSON.stringify(post.reactions || '');
    const reactionCount = (reactionsText.match(/\d+/g) || [])
      .map(Number)
      .reduce((sum, value) => sum + value, 0);
    const textWeight = Math.min(String(post.text || '').length, 600);

    return views + (reactionCount * 25) + textWeight;
  }

  _extractTopic(text, channelTitle, channel) {
    const normalized = String(text || '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const firstLine = normalized
      .split(/[.!?\n]/)
      .map(line => line.trim())
      .find(Boolean);

    const topic = firstLine || channelTitle || channel || 'Главная тема дня';
    return topic.substring(0, 90);
  }

  _extractSummary(text) {
    const normalized = String(text || '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) {
      return 'Краткое содержание недоступно';
    }

    return normalized.substring(0, 280);
  }

  _extractKeyFacts(text) {
    const normalized = String(text || '')
      .replace(/\s+/g, ' ')
      .trim();

    const sentences = normalized
      .split(/(?<=[.!?])\s+/)
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 2)
      .map(item => item.substring(0, 140));

    return sentences.length > 0 ? sentences : [normalized.substring(0, 140)];
  }

  _buildSourceKey(channel, postId) {
    const normalizedChannel = String(channel || '').trim().toLowerCase();
    const normalizedPostId = Number(postId) || 0;
    return normalizedChannel && normalizedPostId ? `${normalizedChannel}:${normalizedPostId}` : '';
  }
}

module.exports = ContentAnalyzer;
