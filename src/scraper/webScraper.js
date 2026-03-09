const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { runSql } = require('../utils/dbHelpers');
const rateLimiter = require('../utils/rateLimiter');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

class WebScraper {
  constructor() {
    this.sources = {};
    const sourcesFile = path.join(config.paths.data, 'web_sources.json');
    try {
      const raw = fs.readFileSync(sourcesFile, 'utf-8');
      this.sources = JSON.parse(raw);
    } catch (_err) {
      logger.warn('WebScraper: web_sources.json не найден, используются defaults');
    }

    this.birdeyeKey = process.env.BIRDEYE_API_KEY || '';
  }

  /**
   * Fetch data from all web sources.
   * @returns {object} — aggregated results from all sources
   */
  async fetchAll() {
    const results = {};

    const fetchers = [
      { name: 'coingecko', fn: () => this.fetchCoinGecko() },
      { name: 'defillama', fn: () => this.fetchDeFiLlama() },
      { name: 'dexscreener', fn: () => this.fetchDexScreener() },
      { name: 'birdeye', fn: () => this.fetchBirdeye() },
    ];

    for (const { name, fn } of fetchers) {
      try {
        const data = await fn();
        if (data) {
          results[name] = data;
        }
      } catch (err) {
        logger.error(`WebScraper: ошибка ${name}: ${err.message}`);
        results[name] = null;
      }
    }

    return results;
  }

  /**
   * Fetch Solana price and ecosystem token data from CoinGecko.
   */
  async fetchCoinGecko() {
    const cacheKey = 'web:coingecko';
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    await rateLimiter.waitForSlot('coingecko');

    const baseUrl = this.sources.coingecko?.baseUrl || 'https://api.coingecko.com/api/v3';

    try {
      // Fetch SOL price
      const priceRes = await axios.get(`${baseUrl}/simple/price`, {
        params: {
          ids: 'solana',
          vs_currencies: 'usd',
          include_24hr_change: 'true',
        },
        timeout: 10000,
      });

      const solData = priceRes.data.solana || {};

      // Fetch ecosystem tokens
      await rateLimiter.waitForSlot('coingecko');
      const marketsRes = await axios.get(`${baseUrl}/coins/markets`, {
        params: {
          vs_currency: 'usd',
          category: 'solana-ecosystem',
          order: 'market_cap_desc',
          per_page: 20,
          page: 1,
          sparkline: false,
        },
        timeout: 10000,
      });

      const result = {
        source: 'coingecko',
        data: {
          solPrice: solData.usd || 0,
          solChange24h: solData.usd_24h_change || 0,
          ecosystemTokens: (marketsRes.data || []).map(t => ({
            id: t.id,
            symbol: t.symbol,
            name: t.name,
            price: t.current_price,
            change24h: t.price_change_percentage_24h,
            marketCap: t.market_cap,
            volume24h: t.total_volume,
          })),
        },
      };

      this._saveSnapshot('coingecko', result.data);
      cache.set(cacheKey, result);
      return result;
    } catch (err) {
      logger.error(`WebScraper: CoinGecko ошибка: ${err.message}`);
      return null;
    }
  }

  /**
   * Fetch Solana TVL data from DeFi Llama.
   */
  async fetchDeFiLlama() {
    const cacheKey = 'web:defillama';
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    await rateLimiter.waitForSlot('defillama');

    const baseUrl = this.sources.defillama?.baseUrl || 'https://api.llama.fi';

    try {
      // Historical chain TVL
      const tvlRes = await axios.get(`${baseUrl}/v2/historicalChainTvl/Solana`, {
        timeout: 10000,
      });

      // Protocols filtered for Solana
      await rateLimiter.waitForSlot('defillama');
      const protocolsRes = await axios.get(`${baseUrl}/protocols`, {
        timeout: 15000,
      });

      const solanaProtocols = (protocolsRes.data || [])
        .filter(p => p.chains && p.chains.includes('Solana'))
        .sort((a, b) => (b.tvl || 0) - (a.tvl || 0))
        .slice(0, 20)
        .map(p => ({
          name: p.name,
          slug: p.slug,
          tvl: p.tvl,
          change1d: p.change_1d,
          change7d: p.change_7d,
          category: p.category,
        }));

      const tvlHistory = tvlRes.data || [];
      const currentTvl = tvlHistory.length > 0 ? tvlHistory[tvlHistory.length - 1] : null;

      const result = {
        source: 'defillama',
        data: {
          currentTvl: currentTvl ? currentTvl.tvl : 0,
          tvlDate: currentTvl ? currentTvl.date : null,
          tvlHistory: tvlHistory.slice(-7), // last 7 data points
          topProtocols: solanaProtocols,
        },
      };

      this._saveSnapshot('defillama', result.data);
      cache.set(cacheKey, result);
      return result;
    } catch (err) {
      logger.error(`WebScraper: DeFi Llama ошибка: ${err.message}`);
      return null;
    }
  }

  /**
   * Fetch trending Solana pairs from DexScreener.
   */
  async fetchDexScreener() {
    const cacheKey = 'web:dexscreener';
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    await rateLimiter.waitForSlot('dexscreener');

    const baseUrl = this.sources.dexscreener?.baseUrl || 'https://api.dexscreener.com';

    try {
      const res = await axios.get(`${baseUrl}/latest/dex/search`, {
        params: { q: 'solana' },
        timeout: 10000,
      });

      const pairs = (res.data.pairs || []).slice(0, 20).map(p => ({
        dexId: p.dexId,
        pairAddress: p.pairAddress,
        baseToken: p.baseToken,
        quoteToken: p.quoteToken,
        priceUsd: p.priceUsd,
        volume24h: p.volume?.h24,
        priceChange24h: p.priceChange?.h24,
        liquidity: p.liquidity?.usd,
        url: p.url,
      }));

      const result = {
        source: 'dexscreener',
        data: { pairs },
      };

      this._saveSnapshot('dexscreener', result.data);
      cache.set(cacheKey, result);
      return result;
    } catch (err) {
      logger.error(`WebScraper: DexScreener ошибка: ${err.message}`);
      return null;
    }
  }

  /**
   * Fetch trending tokens from Birdeye (only if API key is configured).
   */
  async fetchBirdeye() {
    if (!this.birdeyeKey) {
      logger.debug('WebScraper: BIRDEYE_API_KEY не задан, пропускаем');
      return null;
    }

    const cacheKey = 'web:birdeye';
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    await rateLimiter.waitForSlot('birdeye');

    const baseUrl = this.sources.birdeye?.baseUrl || 'https://public-api.birdeye.so';

    try {
      const res = await axios.get(`${baseUrl}/defi/token_trending`, {
        params: { sort_by: 'rank', sort_type: 'asc', offset: 0, limit: 20 },
        headers: {
          'X-API-KEY': this.birdeyeKey,
          accept: 'application/json',
        },
        timeout: 10000,
      });

      const tokens = res.data?.data?.tokens || res.data?.data?.items || [];

      const result = {
        source: 'birdeye',
        data: { trendingTokens: tokens },
      };

      this._saveSnapshot('birdeye', result.data);
      cache.set(cacheKey, result);
      return result;
    } catch (err) {
      logger.error(`WebScraper: Birdeye ошибка: ${err.message}`);
      return null;
    }
  }

  /**
   * Save a data snapshot to the analytics_snapshots table.
   */
  _saveSnapshot(source, data) {
    try {
      runSql(
        'INSERT INTO analytics_snapshots (source, data) VALUES (?, ?)',
        [source, JSON.stringify(data)]
      );
    } catch (err) {
      logger.error(`WebScraper: ошибка сохранения snapshot ${source}: ${err.message}`);
    }
  }
}

module.exports = WebScraper;
