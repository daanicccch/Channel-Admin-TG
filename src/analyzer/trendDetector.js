const aiProvider = require('../ai/aiProvider');
const { getDb, saveDb } = require('../config');
const { queryAll, queryOne, runSql } = require('../utils/dbHelpers');
const logger = require('../utils/logger');

class TrendDetector {
  /**
   * Detect trends from clustered analysis data and web data.
   * @param {Array} clusters - topic clusters from ContentAnalyzer
   * @param {object} webData - supplementary web/API data
   * @returns {Array} trends sorted by significance descending
   */
  async detectTrends(clusters, webData = {}) {
    if (!clusters || clusters.length === 0) {
      logger.warn('TrendDetector: нет кластеров для анализа трендов');
      return [];
    }

    const clustersText = JSON.stringify(clusters, null, 2);
    const webText = Object.keys(webData).length > 0
      ? `\n\nДанные из веб-источников:\n${JSON.stringify(webData, null, 2)}`
      : '';

    const prompt = `Ты — крипто-аналитик. На основе кластеров новостей и веб-данных определи тренды.

Найди:
1. Токены и протоколы, упоминаемые в нескольких кластерах
2. Значительные изменения цен или TVL
3. Новые проекты, появляющиеся в нескольких источниках

Для каждого тренда верни:
{
  "keyword": "название токена/протокола/события",
  "type": "token" | "protocol" | "event",
  "significance": число от 1 до 10,
  "description": "краткое описание тренда"
}

Кластеры:
${clustersText}
${webText}

Верни ТОЛЬКО JSON-массив трендов, отсортированный по significance (от большего к меньшему).`;

    try {
      const result = await aiProvider.generateJSON(prompt, { temperature: 0.15, maxTokens: 2048 });
      const trends = Array.isArray(result) ? result : (result.trends || []);
      trends.sort((a, b) => (b.significance || 0) - (a.significance || 0));

      // Store trends in DB
      this._storeTrends(trends);

      logger.info(`TrendDetector: обнаружено ${trends.length} трендов`);
      return trends;
    } catch (err) {
      logger.error(`TrendDetector: ошибка определения трендов — ${err.message}`);
      return [];
    }
  }

  /**
   * Store detected trends in the SQLite trends table.
   */
  _storeTrends(trends) {
    try {
      const db = getDb();

      for (const trend of trends) {
        const existing = queryOne('SELECT id, mentions FROM trends WHERE keyword = ?', [trend.keyword]);
        if (existing) {
          db.run(
            "UPDATE trends SET mentions = ?, last_seen = datetime('now'), sentiment = ? WHERE id = ?",
            [existing.mentions + 1, trend.significance || 0, existing.id]
          );
        } else {
          db.run(
            "INSERT INTO trends (keyword, mentions, first_seen, last_seen, sentiment) VALUES (?, 1, datetime('now'), datetime('now'), ?)",
            [trend.keyword, trend.significance || 0]
          );
        }
      }

      saveDb();
      logger.debug(`TrendDetector: сохранено ${trends.length} трендов в БД`);
    } catch (err) {
      logger.error(`TrendDetector: ошибка записи трендов в БД — ${err.message}`);
    }
  }

  /**
   * Get recent trends from the database within the last N hours.
   * @param {number} hours - lookback window
   * @returns {Array} trend rows from DB
   */
  async getRecentTrends(hours = 24) {
    try {
      const rows = queryAll(
        `SELECT keyword, mentions, first_seen, last_seen, sentiment
         FROM trends
         WHERE last_seen >= datetime('now', ? || ' hours')
         ORDER BY mentions DESC, sentiment DESC`,
        [`-${hours}`]
      );

      logger.debug(`TrendDetector: найдено ${rows.length} трендов за последние ${hours}ч`);
      return rows;
    } catch (err) {
      logger.error(`TrendDetector: ошибка чтения трендов из БД — ${err.message}`);
      return [];
    }
  }
}

module.exports = TrendDetector;
