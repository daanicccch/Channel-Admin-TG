const aiProvider = require('../ai/aiProvider');
const logger = require('../utils/logger');
const styleEngine = require('./styleEngine');
const formatBuilder = require('./formatBuilder');
const mediaHandler = require('./mediaHandler');

const MAX_RETRIES = 2;

class PostGenerator {
  /**
   * Generate a complete post ready for publishing.
   * @param {string} type - post type: digest, analysis, alert, weekly
   * @param {object} analysisData - { clusters, webData, sentiment, trends }
   * @returns {{ text: string, media: { type: string, path: string|null }, keyboard: Array, hashtags: string, postType: string }}
   */
  async generatePost(type, analysisData) {
    const { clusters = [], webData = {}, sentiment = {}, trends = [] } = analysisData || {};

    // 1. Load rules and templates
    const rulesContent = styleEngine.loadRules();
    const templatesContent = styleEngine.loadTemplates();

    // 2. Build the mega-prompt
    const prompt = this._buildPrompt(type, rulesContent, templatesContent, clusters, webData, sentiment, trends);

    // 3. Call AI with retries on validation failure
    let result = null;
    let validationResult = null;
    let attempts = 0;

    while (attempts <= MAX_RETRIES) {
      try {
        if (attempts === 0) {
          result = await aiProvider.generateJSON(prompt);
        } else {
          // Re-prompt with validation issues
          const fixPrompt = this._buildFixPrompt(result, validationResult.issues, type, rulesContent);
          result = await aiProvider.generateJSON(fixPrompt);
        }
      } catch (err) {
        logger.error(`PostGenerator: ошибка AI генерации (попытка ${attempts + 1}) — ${err.message}`);
        attempts++;
        continue;
      }

      const postText = result.text || '';

      // 5. Validate
      validationResult = styleEngine.validatePost(postText, type);

      if (validationResult.valid) {
        logger.info(`PostGenerator: пост типа "${type}" прошёл валидацию (попытка ${attempts + 1})`);
        break;
      }

      logger.warn(`PostGenerator: валидация не пройдена (попытка ${attempts + 1}): ${validationResult.issues.join('; ')}`);
      attempts++;
    }

    if (!result || !result.text) {
      logger.error('PostGenerator: не удалось сгенерировать пост после всех попыток');
      return {
        text: '',
        media: { type: 'none', path: null },
        keyboard: [],
        hashtags: '',
        postType: type,
      };
    }

    // 7. Format for Telegram HTML
    const formattedText = formatBuilder.buildTelegramHTML(result.text);

    // 8. Select media
    const media = await mediaHandler.selectMedia(clusters);

    // 9. Build keyboard if links are available
    const keyboard = [];
    if (result.hashtags) {
      // Could add source links as buttons here
    }

    return {
      text: formattedText,
      media,
      keyboard,
      hashtags: result.hashtags || '',
      postType: result.post_type || type,
    };
  }

  /**
   * Build the main generation prompt.
   */
  _buildPrompt(type, rulesContent, templatesContent, clusters, webData, sentiment, trends) {
    const typeNames = {
      digest: 'Дайджест (утро/вечер)',
      analysis: 'Аналитика',
      alert: 'Алерт',
      weekly: 'Недельный дайджест',
    };

    const typeName = typeNames[type] || type;

    return `Ты — автор крипто-канала, специализирующегося на Solana и DeFi. Пишешь на русском языке.

═══════════════════════════════
ПРАВИЛА НАПИСАНИЯ ПОСТОВ:
═══════════════════════════════
${rulesContent || 'Правила не загружены. Пиши в стиле информативного крипто-канала.'}

═══════════════════════════════
ШАБЛОНЫ ПОСТОВ:
═══════════════════════════════
${templatesContent || 'Шаблоны не загружены.'}

═══════════════════════════════
ЗАДАНИЕ:
═══════════════════════════════
Напиши пост типа: **${typeName}**

Используй шаблон для этого типа поста из раздела "ШАБЛОНЫ ПОСТОВ" выше.

═══════════════════════════════
ДАННЫЕ ДЛЯ ПОСТА:
═══════════════════════════════

📊 Кластеры новостей (отсортированы по важности):
${JSON.stringify(clusters, null, 2)}

🌐 Данные из веб-источников:
${JSON.stringify(webData, null, 2)}

📈 Настроение рынка:
${JSON.stringify(sentiment, null, 2)}

🔥 Актуальные тренды:
${JSON.stringify(trends, null, 2)}

═══════════════════════════════
ТРЕБОВАНИЯ К ОТВЕТУ:
═══════════════════════════════
Верни JSON объект со следующими полями:
{
  "text": "полный текст поста с HTML-разметкой для Telegram (теги: <b>, <i>, <code>, <a href='...'>)",
  "media_suggestion": "описание подходящего изображения для поста или null",
  "hashtags": "хештеги через пробел",
  "post_type": "${type}"
}

Важно:
- Пиши ТОЛЬКО на русском языке
- Используй 3-7 эмодзи
- НЕ начинай пост с "Друзья", "Итак", "Добрый день"
- НЕ используй фразы: "в данной статье", "следует отметить", "как мы все знаем", "безусловно", "резюмируя", "guaranteed", "to the moon"
- Соблюдай лимиты длины для типа "${type}"
- Верни ТОЛЬКО JSON, без дополнительного текста`;
  }

  /**
   * Build a fix prompt when validation fails.
   */
  _buildFixPrompt(previousResult, issues, type, rulesContent) {
    return `Предыдущая версия поста не прошла валидацию. Исправь следующие проблемы:

Проблемы:
${issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}

Предыдущий текст поста:
${previousResult.text || ''}

Правила:
${rulesContent || ''}

Тип поста: ${type}

Исправь текст и верни JSON объект с полями:
{
  "text": "исправленный текст поста",
  "media_suggestion": "${previousResult.media_suggestion || 'null'}",
  "hashtags": "${previousResult.hashtags || ''}",
  "post_type": "${type}"
}

Верни ТОЛЬКО JSON, без дополнительного текста.`;
  }
}

module.exports = PostGenerator;
