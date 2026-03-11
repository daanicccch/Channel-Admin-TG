const { config } = require('../config');
const GeminiClient = require('./geminiClient');
const logger = require('../utils/logger');

class AIProvider {
  constructor() {
    const hasGemini = Array.isArray(config.ai.geminiKeys)
      ? config.ai.geminiKeys.length > 0
      : Boolean(config.ai.geminiKey);

    this.gemini = hasGemini ? new GeminiClient() : null;
    this.primary = this.gemini;
    this.primaryName = this.gemini ? 'gemini' : null;
    this.currentProvider = this.primaryName;

    if (!this.primary) {
      throw new Error('AIProvider: no Gemini API keys configured');
    }

    logger.info(`AIProvider: primary=${this.primaryName}, fallback=none`);
  }

  async generate(prompt, options) {
    return this._callPrimary('generate', prompt, options);
  }

  async generateJSON(prompt, options) {
    return this._callPrimary('generateJSON', prompt, options);
  }

  async _callPrimary(method, prompt, options) {
    this.currentProvider = this.primaryName;
    logger.debug(`AIProvider: calling ${method} via ${this.primaryName}`);
    return this.primary[method](prompt, options);
  }
}

module.exports = new AIProvider();
