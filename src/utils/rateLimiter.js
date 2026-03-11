const logger = require('./logger');

class RateLimiter {
  constructor() {
    // { name: { maxRequests, windowMs, timestamps: [] } }
    this.limits = new Map();
  }

  register(name, maxRequests, windowMs) {
    this.limits.set(name, { maxRequests, windowMs, timestamps: [] });
  }

  async waitForSlot(name) {
    const limit = this.limits.get(name);
    if (!limit) return; // нет лимита — пропускаем

    const now = Date.now();
    // Убираем устаревшие таймстампы
    limit.timestamps = limit.timestamps.filter(t => now - t < limit.windowMs);

    if (limit.timestamps.length >= limit.maxRequests) {
      const oldestTs = limit.timestamps[0];
      const waitMs = limit.windowMs - (now - oldestTs) + 100;
      logger.debug(`Rate limit "${name}": ждём ${Math.ceil(waitMs / 1000)}с`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      // Повторная очистка после ожидания
      const afterWait = Date.now();
      limit.timestamps = limit.timestamps.filter(t => afterWait - t < limit.windowMs);
    }

    limit.timestamps.push(Date.now());
  }
}

// Singleton с предустановленными лимитами
const rateLimiter = new RateLimiter();
rateLimiter.register('gemini', 10, 60_000);       // 10 RPM
rateLimiter.register('coingecko', 30, 60_000);     // 30 RPM
rateLimiter.register('defillama', 60, 60_000);     // щедрый
rateLimiter.register('birdeye', 10, 60_000);       // 10 RPM
rateLimiter.register('dexscreener', 30, 60_000);   // 30 RPM
rateLimiter.register('telegram_scrape', 20, 60_000);

module.exports = rateLimiter;
