const { GoogleGenerativeAI } = require('@google/generative-ai');
const { config } = require('../config');
const rateLimiter = require('../utils/rateLimiter');
const logger = require('../utils/logger');

class GeminiClient {
  constructor() {
    this.apiKey = config.ai.geminiKey;
    this.modelName = config.ai.geminiModel;
    this.genAI = new GoogleGenerativeAI(this.apiKey);
    this.model = this.genAI.getGenerativeModel({ model: this.modelName });
    logger.info(`GeminiClient инициализирован (модель: ${this.modelName})`);
  }

  async generate(prompt, { temperature = 0.8, maxTokens = 8192 } = {}) {
    await rateLimiter.waitForSlot('gemini');

    try {
      const result = await this.model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
        },
      });

      const response = result.response;
      return response.text();
    } catch (err) {
      console.error('[GEMINI ERROR]', err.status || err.code || '', err.message || err);
      if (err.status === 429 || err.code === 'RESOURCE_EXHAUSTED') {
        logger.warn('Gemini rate limit достигнут');
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
      throw new Error(`Gemini: не удалось извлечь JSON из ответа. Текст: ${text.substring(0, 200)}`);
    }
  }
}

module.exports = GeminiClient;
