const { GoogleGenerativeAI } = require('@google/generative-ai');
const { config } = require('../config');
const rateLimiter = require('../utils/rateLimiter');
const logger = require('../utils/logger');
const { removeGeminiKey } = require('./geminiKeyStore');

function extractJsonLoose(text) {
  if (!text) throw new Error('empty response');

  let cleaned = String(text).trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  const attempts = [
    cleaned,
    String(text),
    cleaned.replace(/^json\s*/i, '').trim(),
  ];

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }

  const src = cleaned;
  const starts = [src.indexOf('{'), src.indexOf('[')].filter((i) => i >= 0);
  if (starts.length === 0) {
    throw new Error('no JSON start token found');
  }
  const firstBrace = Math.min(...starts);

  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = firstBrace; i < src.length; i++) {
    const ch = src[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{' || ch === '[') stack.push(ch);
    if (ch === '}' || ch === ']') {
      const open = stack.pop();
      if ((open === '{' && ch !== '}') || (open === '[' && ch !== ']')) {
        continue;
      }
      if (stack.length === 0) {
        let candidate = src.slice(firstBrace, i + 1);
        candidate = candidate.replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(candidate);
      }
    }
  }

  throw new Error('unable to extract balanced JSON');
}

class GeminiClient {
  constructor() {
    this.apiKeys = Array.isArray(config.ai.geminiKeys) && config.ai.geminiKeys.length > 0
      ? config.ai.geminiKeys
      : (config.ai.geminiKey ? [config.ai.geminiKey] : []);
    this.modelName = config.ai.geminiModel;

    this.models = this.apiKeys.map((apiKey) => {
      const client = new GoogleGenerativeAI(apiKey);
      return client.getGenerativeModel({ model: this.modelName });
    });
    this.keyOrder = this.apiKeys.map((_, index) => index);
    this.keyStates = this.apiKeys.map(() => ({
      disabled: false,
      blockedUntil: 0,
      lastReason: null,
    }));
    this.activeKeyIndex = 0;

    if (this.models.length === 0) {
      throw new Error('GeminiClient: no API keys configured');
    }

    logger.info(`GeminiClient initialized (model: ${this.modelName}, keys: ${this.models.length})`);
  }

  async generate(prompt, { temperature = 0.8, maxTokens = 8192, jsonMode = false } = {}) {
    await rateLimiter.waitForSlot('gemini');

    const maxAttemptsPerKey = 3;
    const temporaryBlocks = [];
    let lastError = null;
    const orderedKeyIndices = [...this.keyOrder];

    for (const keyIndex of orderedKeyIndices) {
      const keyState = this.keyStates[keyIndex];
      const now = Date.now();

      if (keyState.disabled) {
        continue;
      }

      if (keyState.blockedUntil > now) {
        temporaryBlocks.push(keyState.blockedUntil);
        continue;
      }

      const model = this.models[keyIndex];

      for (let attempt = 1; attempt <= maxAttemptsPerKey; attempt++) {
        try {
          const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              temperature,
              maxOutputTokens: maxTokens,
              ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
            },
          });

          this.activeKeyIndex = keyIndex;
          this.keyStates[keyIndex].lastReason = null;
          this.keyStates[keyIndex].blockedUntil = 0;
          return result.response.text();
        } catch (err) {
          lastError = err;
          console.error('[GEMINI ERROR]', err.status || err.code || '', err.message || err);

          const classification = this._classifyError(err);

          if (classification.type === 'disabled') {
            this.keyStates[keyIndex].disabled = true;
            this.keyStates[keyIndex].lastReason = classification.reason;
            const removed = removeGeminiKey(config.paths.geminiKeys, this.apiKeys[keyIndex]);
            if (removed) {
              logger.warn(`Gemini removed dead key ${keyIndex + 1}/${this.models.length} from registry: ${classification.reason}`);
            }
            logger.warn(`Gemini disabled key ${keyIndex + 1}/${this.models.length}: ${classification.reason}`);
            break;
          }

          if (classification.type === 'rate_limit') {
            const blockedUntil = now + classification.retryMs;
            this.keyStates[keyIndex].blockedUntil = blockedUntil;
            this.keyStates[keyIndex].lastReason = classification.reason;
            this._moveKeyToEnd(keyIndex);
            temporaryBlocks.push(blockedUntil);
            logger.warn(`Gemini rate limit on key ${keyIndex + 1}/${this.models.length}, trying next key`);
            break;
          }

          if (classification.type === 'transient') {
            if (attempt === maxAttemptsPerKey) {
              const blockedUntil = now + classification.retryMs;
              this.keyStates[keyIndex].blockedUntil = blockedUntil;
              this.keyStates[keyIndex].lastReason = classification.reason;
              temporaryBlocks.push(blockedUntil);
              logger.warn(`Gemini transient error exhausted retries on key ${keyIndex + 1}/${this.models.length}, trying next key`);
              break;
            }

            const backoffMs = 1500 * attempt;
            logger.warn(`Gemini transient error, retry in ${backoffMs}ms (attempt ${attempt}/${maxAttemptsPerKey})`);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }

          throw err;
        }
      }
    }

    if (temporaryBlocks.length > 0) {
      const retryAt = Math.min(...temporaryBlocks);
      const retryMs = Math.max(0, retryAt - Date.now());
      const error = lastError || new Error('Gemini: all keys are temporarily rate-limited');
      error.isRateLimit = true;
      error.retryMs = retryMs;
      throw error;
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error('Gemini: all configured keys failed');
  }

  async generateJSON(prompt, options = {}) {
    const text = await this.generate(prompt, { ...options, jsonMode: true });

    try {
      return extractJsonLoose(text);
    } catch (parseErr) {
      logger.warn(`Gemini: первичный JSON parse не прошёл, пробуем repair (${parseErr.message})`);

      try {
        const repairedText = await this._repairJson(text, options);
        return extractJsonLoose(repairedText);
      } catch (_repairErr) {
        throw new Error(`Gemini: не удалось извлечь JSON из ответа. Текст: ${String(text).substring(0, 200)}`);
      }
    }
  }

  async _repairJson(text, options = {}) {
    const repairPrompt = `Ниже ответ модели, который должен быть валидным JSON, но сейчас сломан или оборван.

Преобразуй его в валидный JSON.
Если часть ответа оборвалась, сохрани только ту часть, которую можно восстановить без выдумывания новых фактов.
Верни только JSON.

Ответ модели:
${String(text).substring(0, 12000)}`;

    return this.generate(repairPrompt, {
      temperature: 0,
      maxTokens: Math.min(options.maxTokens || 4096, 4096),
      jsonMode: true,
    });
  }

  _classifyError(err) {
    const message = String(err?.message || '');
    const status = err?.status;

    const leakedKey =
      status === 403 &&
      /reported as leaked|use another api key/i.test(message);
    if (leakedKey) {
      return { type: 'disabled', reason: 'reported as leaked' };
    }

    const invalidKey =
      (status === 400 || status === 403) &&
      /API_KEY_INVALID|API key not valid|invalid api key/i.test(message);
    if (invalidKey) {
      return { type: 'disabled', reason: 'invalid api key' };
    }

    const rateLimited = status === 429 || err?.code === 'RESOURCE_EXHAUSTED';
    if (rateLimited) {
      return {
        type: 'rate_limit',
        reason: this._isDailyQuotaExceeded(message) ? 'daily quota exceeded' : 'rate limit exceeded',
        retryMs: this._extractRetryMs(message, this._isDailyQuotaExceeded(message) ? 60 * 60 * 1000 : 60 * 1000),
      };
    }

    const transient =
      status === 503 ||
      status === 500 ||
      /Service Unavailable|high demand/i.test(message);
    if (transient) {
      return {
        type: 'transient',
        reason: 'transient upstream error',
        retryMs: this._extractRetryMs(message, 60 * 1000),
      };
    }

    return { type: 'fatal', reason: message || 'unknown error' };
  }

  _extractRetryMs(message, fallbackMs) {
    const text = String(message || '');
    const matchSeconds = text.match(/retry in\s+([\d.]+)s/i);
    if (matchSeconds) {
      return Math.max(1000, Math.ceil(Number(matchSeconds[1]) * 1000));
    }

    const matchDelay = text.match(/"retryDelay":"(\d+)s"/i);
    if (matchDelay) {
      return Math.max(1000, Number(matchDelay[1]) * 1000);
    }

    return fallbackMs;
  }

  _isDailyQuotaExceeded(message) {
    return /GenerateRequestsPerDay|perday|free_tier_requests, limit: 20/i.test(String(message || ''));
  }

  _moveKeyToEnd(keyIndex) {
    const orderIndex = this.keyOrder.indexOf(keyIndex);
    if (orderIndex === -1 || orderIndex === this.keyOrder.length - 1) {
      return;
    }

    this.keyOrder.splice(orderIndex, 1);
    this.keyOrder.push(keyIndex);
  }
}

module.exports = GeminiClient;
