const { config } = require('../config');
const GeminiClient = require('./geminiClient');
const QwenClient = require('./qwenClient');
const logger = require('../utils/logger');

class AIProvider {
  constructor() {
    this.gemini = null;
    this.qwen = null;
    this.currentProvider = null;

    if (config.ai.geminiKey) {
      this.gemini = new GeminiClient();
    }
    if (config.ai.dashscopeKey) {
      this.qwen = new QwenClient();
    }

    // Primary is Gemini if available, otherwise Qwen
    if (this.gemini) {
      this.primary = this.gemini;
      this.primaryName = 'gemini';
      this.fallback = this.qwen;
      this.fallbackName = 'qwen';
    } else {
      this.primary = this.qwen;
      this.primaryName = 'qwen';
      this.fallback = null;
      this.fallbackName = null;
    }

    this.currentProvider = this.primaryName;
    logger.info(`AIProvider: primary=${this.primaryName}, fallback=${this.fallbackName || 'none'}`);
  }

  async generate(prompt, options) {
    return this._callWithFailover('generate', prompt, options);
  }

  async generateJSON(prompt, options) {
    return this._callWithFailover('generateJSON', prompt, options);
  }

  async _callWithFailover(method, prompt, options) {
    // Try primary
    try {
      this.currentProvider = this.primaryName;
      logger.debug(`AIProvider: вызов ${method} через ${this.primaryName}`);
      return await this.primary[method](prompt, options);
    } catch (err) {
      if (err.isRateLimit && this.fallback) {
        logger.warn(`AIProvider: ${this.primaryName} rate limit, переключение на ${this.fallbackName}`);
      } else if (!this.fallback) {
        // No fallback — wait and retry once
        logger.error(`AIProvider: ${this.primaryName} ошибка: ${err.message}`);
        logger.warn(`AIProvider: нет fallback. Ждём 60с и повторяем`);
        await new Promise(resolve => setTimeout(resolve, 10_000));
        this.currentProvider = this.primaryName;
        return await this.primary[method](prompt, options);
      } else {
        // Non-rate-limit error with fallback available — still try fallback
        logger.warn(`AIProvider: ${this.primaryName} ошибка (${err.message}), пробуем ${this.fallbackName}`);
      }
    }

    // Try fallback
    try {
      this.currentProvider = this.fallbackName;
      logger.debug(`AIProvider: вызов ${method} через ${this.fallbackName}`);
      return await this.fallback[method](prompt, options);
    } catch (err2) {
      logger.warn(`AIProvider: ${this.fallbackName} тоже не сработал (${err2.message}). Ждём 60с и повторяем primary`);
      // Both failed — wait 60s and retry primary once
      await new Promise(resolve => setTimeout(resolve, 10_000));
      this.currentProvider = this.primaryName;
      return await this.primary[method](prompt, options);
    }
  }
}

module.exports = new AIProvider();
