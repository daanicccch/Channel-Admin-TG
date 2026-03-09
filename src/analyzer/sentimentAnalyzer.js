const aiProvider = require('../ai/aiProvider');
const { queryOne, runSql } = require('../utils/dbHelpers');
const logger = require('../utils/logger');

const VALID_SENTIMENTS = ['extreme_fear', 'fear', 'neutral', 'greed', 'extreme_greed'];

class SentimentAnalyzer {
  /**
   * Analyze market sentiment based on clusters and web data.
   * @param {Array} clusters - topic clusters from ContentAnalyzer
   * @param {object} webData - supplementary web/API data (prices, fear/greed index, etc.)
   * @returns {{ overall: string, score: number, reasoning: string }}
   */
  async analyzeSentiment(clusters, webData = {}) {
    if (!clusters || clusters.length === 0) {
      logger.warn('SentimentAnalyzer: нет данных для анализа настроений');
      return { overall: 'neutral', score: 50, reasoning: 'Недостаточно данных для анализа' };
    }

    const clustersText = JSON.stringify(clusters, null, 2);
    const webText = Object.keys(webData).length > 0
      ? `\n\nДанные из веб-источников (цены, индексы, TVL):\n${JSON.stringify(webData, null, 2)}`
      : '';

    const lastSentiment = this._getLastSentiment();
    const previousContext = lastSentiment
      ? `\n\nПредыдущий анализ настроений (${lastSentiment.captured_at}): ${lastSentiment.data}`
      : '';

    const prompt = `Ты — аналитик крипторынка. Оцени текущее настроение рынка на основе данных ниже.

Определи:
- overall: одно из значений: "extreme_fear", "fear", "neutral", "greed", "extreme_greed"
- score: число от 0 (максимальный страх) до 100 (максимальная жадность)
- reasoning: краткое обоснование на русском языке (2-3 предложения)

Учитывай:
- Тон и содержание новостей в кластерах
- Данные о ценах и рыночных метриках
- Общее настроение сообщества
${previousContext ? '- Сравни с предыдущим анализом и отметь изменения' : ''}

Кластеры новостей:
${clustersText}
${webText}
${previousContext}

Верни ТОЛЬКО JSON объект с полями: overall, score, reasoning.`;

    try {
      const result = await aiProvider.generateJSON(prompt);

      const sentiment = {
        overall: VALID_SENTIMENTS.includes(result.overall) ? result.overall : 'neutral',
        score: Math.max(0, Math.min(100, Number(result.score) || 50)),
        reasoning: result.reasoning || '',
      };

      // Store snapshot in DB
      this._storeSentiment(sentiment);

      logger.info(`SentimentAnalyzer: настроение=${sentiment.overall}, score=${sentiment.score}`);
      return sentiment;
    } catch (err) {
      logger.error(`SentimentAnalyzer: ошибка анализа настроений — ${err.message}`);
      return { overall: 'neutral', score: 50, reasoning: 'Ошибка при анализе настроений' };
    }
  }

  /**
   * Get the last stored sentiment from analytics_snapshots.
   * @returns {object|null} last snapshot row or null
   */
  _getLastSentiment() {
    try {
      return queryOne(
        `SELECT data, captured_at
         FROM analytics_snapshots
         WHERE source = 'sentiment'
         ORDER BY captured_at DESC
         LIMIT 1`
      );
    } catch (err) {
      logger.error(`SentimentAnalyzer: ошибка чтения предыдущего настроения — ${err.message}`);
      return null;
    }
  }

  /**
   * Store a sentiment snapshot in analytics_snapshots.
   * @param {{ overall: string, score: number, reasoning: string }} sentiment
   */
  _storeSentiment(sentiment) {
    try {
      runSql(
        `INSERT INTO analytics_snapshots (source, data, captured_at)
         VALUES ('sentiment', ?, datetime('now'))`,
        [JSON.stringify(sentiment)]
      );
      logger.debug('SentimentAnalyzer: снимок настроения сохранён');
    } catch (err) {
      logger.error(`SentimentAnalyzer: ошибка сохранения настроения — ${err.message}`);
    }
  }
}

module.exports = SentimentAnalyzer;
