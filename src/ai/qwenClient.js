const OpenAI = require('openai');
const { config } = require('../config');
const rateLimiter = require('../utils/rateLimiter');
const logger = require('../utils/logger');

class QwenClient {
  constructor() {
    this.modelName = config.ai.qwenModel;
    this.client = new OpenAI({
      apiKey: config.ai.dashscopeKey,
      baseURL: config.ai.qwenBaseUrl,
    });
    logger.info(`QwenClient инициализирован (модель: ${this.modelName})`);
  }

  async generate(prompt, { temperature = 0.8, maxTokens = 8192 } = {}) {
    await rateLimiter.waitForSlot('qwen');

    try {
      const completion = await this.client.chat.completions.create({
        model: this.modelName,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens,
      });

      return completion.choices[0].message.content;
    } catch (err) {
      if (err.status === 429) {
        logger.warn('Qwen rate limit достигнут');
        err.isRateLimit = true;
      }
      throw err;
    }
  }

  async generateJSON(prompt, options) {
    const text = await this.generate(prompt, options);

    // Strip markdown code fences if present
    let cleaned = text;
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }

    try {
      return JSON.parse(cleaned);
    } catch (_parseErr) {
      // Try regex extraction of JSON object or array
      const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[1]);
        } catch (_innerErr) {
          // fall through
        }
      }
      throw new Error(`Qwen: не удалось извлечь JSON из ответа. Текст: ${text.substring(0, 200)}`);
    }
  }
}

module.exports = QwenClient;
