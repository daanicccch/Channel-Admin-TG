const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { config } = require('../config');
const { runSql } = require('../utils/dbHelpers');
const rateLimiter = require('../utils/rateLimiter');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

const DEFAULT_BROWSER_PATHS = [
  process.env.HEADLESS_BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

class WebScraper {
  constructor(options = {}) {
    this.sources = {};
    const sourcesFile = options.sourcesPath || path.join(config.paths.data, 'web_sources.json');
    try {
      const raw = fs.readFileSync(sourcesFile, 'utf-8');
      this.sources = this._normalizeSourcesConfig(JSON.parse(raw));
    } catch (_err) {
      logger.warn('WebScraper: web_sources.json не найден, используются defaults');
    }

    this.birdeyeKey = process.env.BIRDEYE_API_KEY || '';
    this.browserPath = this._detectBrowserPath();
  }

  /**
   * Fetch data from all web sources.
   * @returns {object} aggregated results from all sources
   */
  async fetchAll(options = {}) {
    const results = {};
    const enabledSources = Array.isArray(options.enabledSources)
      ? new Set(options.enabledSources.map((item) => String(item).trim().toLowerCase()).filter(Boolean))
      : null;

    const fetchers = [
      { name: 'cryptopanic', fn: () => this.fetchCryptoPanic() },
      { name: 'coingecko', fn: () => this.fetchCoinGecko() },
      { name: 'defillama', fn: () => this.fetchDeFiLlama() },
      { name: 'dexscreener', fn: () => this.fetchDexScreener() },
      { name: 'birdeye', fn: () => this.fetchBirdeye() },
      { name: 'giftstat', fn: () => this.fetchGiftStat() },
      { name: 'giftcharts', fn: () => this.fetchGiftCharts() },
      { name: 'peek', fn: () => this.fetchPeek() },
    ];

    for (const { name, fn } of fetchers) {
      if (enabledSources && enabledSources.size > 0 && !enabledSources.has(name)) {
        continue;
      }
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
   * Fetch top recent news from CryptoPanic by rendering the public news page.
   */
  async fetchCryptoPanic() {
    const cacheKey = 'web:cryptopanic';
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    if (!this.browserPath) {
      logger.warn('WebScraper: headless browser not found, CryptoPanic skipped');
      return null;
    }

    try {
      const html = await this._renderPage(this.sources.cryptopanic?.newsUrl || 'https://cryptopanic.com/news/');
      const maxAgeHours = parseInt(process.env.CRYPTOPANIC_MAX_AGE_HOURS || '18', 10);
      const parsedItems = this._parseCryptoPanicNews(html);
      const freshItems = parsedItems.filter((item) => this._isFreshTimestamp(item.publishedAt, maxAgeHours));

      const result = {
        source: 'cryptopanic',
        data: {
          priority: 'max',
          fetchedAt: new Date().toISOString(),
          freshnessHours: maxAgeHours,
          totalParsed: parsedItems.length,
          recentNews: freshItems.slice(0, 20),
        },
      };

      this._saveSnapshot('cryptopanic', result.data);
      cache.set(cacheKey, result);
      return result;
    } catch (err) {
      logger.error(`WebScraper: CryptoPanic ошибка: ${err.message}`);
      return null;
    }
  }

  /**
   * Fetch general crypto market data from CoinGecko.
   */
  async fetchCoinGecko() {
    const cacheKey = 'web:coingecko';
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    await rateLimiter.waitForSlot('coingecko');

    const baseUrl = this.sources.coingecko?.baseUrl || 'https://api.coingecko.com/api/v3';

    try {
      const globalRes = await axios.get(`${baseUrl}/global`, { timeout: 10000 });

      await rateLimiter.waitForSlot('coingecko');
      const trendingRes = await axios.get(`${baseUrl}/search/trending`, { timeout: 10000 });

      await rateLimiter.waitForSlot('coingecko');
      const marketsRes = await axios.get(`${baseUrl}/coins/markets`, {
        params: {
          vs_currency: 'usd',
          order: 'volume_desc',
          per_page: 20,
          page: 1,
          sparkline: false,
          price_change_percentage: '24h',
        },
        timeout: 10000,
      });

      const global = globalRes.data?.data || {};
      const result = {
        source: 'coingecko',
        data: {
          fetchedAt: new Date().toISOString(),
          global: {
            marketCapUsd: global.total_market_cap?.usd || 0,
            volume24hUsd: global.total_volume?.usd || 0,
            marketCapChange24h: global.market_cap_change_percentage_24h_usd || 0,
            btcDominance: global.market_cap_percentage?.btc || 0,
            ethDominance: global.market_cap_percentage?.eth || 0,
            activeCryptocurrencies: global.active_cryptocurrencies || 0,
            markets: global.markets || 0,
          },
          trendingCoins: (trendingRes.data?.coins || []).slice(0, 10).map((entry) => {
            const coin = entry.item || {};
            return {
              id: coin.id,
              coinId: coin.coin_id,
              name: coin.name,
              symbol: coin.symbol,
              marketCapRank: coin.market_cap_rank,
              priceBtc: coin.price_btc,
              score: coin.score,
            };
          }),
          marketLeaders: (marketsRes.data || []).slice(0, 15).map((coin) => ({
            id: coin.id,
            symbol: coin.symbol,
            name: coin.name,
            price: coin.current_price,
            change24h: coin.price_change_percentage_24h,
            marketCap: coin.market_cap,
            volume24h: coin.total_volume,
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
   * Fetch general DeFi data from DeFi Llama.
   */
  async fetchDeFiLlama() {
    const cacheKey = 'web:defillama';
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    await rateLimiter.waitForSlot('defillama');

    const baseUrl = this.sources.defillama?.baseUrl || 'https://api.llama.fi';

    try {
      const chainsRes = await axios.get(`${baseUrl}/chains`, {
        timeout: 10000,
      });

      await rateLimiter.waitForSlot('defillama');
      const protocolsRes = await axios.get(`${baseUrl}/protocols`, {
        timeout: 15000,
      });

      const chains = Array.isArray(chainsRes.data) ? chainsRes.data : [];
      const protocols = Array.isArray(protocolsRes.data) ? protocolsRes.data : [];

      const topChains = chains
        .sort((a, b) => (b.tvl || 0) - (a.tvl || 0))
        .slice(0, 15)
        .map((chain) => ({
          name: chain.name,
          tokenSymbol: chain.tokenSymbol,
          tvl: chain.tvl,
          change1d: chain.change_1d,
          change7d: chain.change_7d,
          mcap: chain.mcap,
        }));

      const topProtocols = protocols
        .sort((a, b) => (b.tvl || 0) - (a.tvl || 0))
        .slice(0, 20)
        .map((protocol) => ({
          name: protocol.name,
          slug: protocol.slug,
          tvl: protocol.tvl,
          change1d: protocol.change_1d,
          change7d: protocol.change_7d,
          category: protocol.category,
          chains: Array.isArray(protocol.chains) ? protocol.chains.slice(0, 5) : [],
        }));

      const totalTvl = chains.reduce((sum, chain) => sum + (Number(chain.tvl) || 0), 0);

      const result = {
        source: 'defillama',
        data: {
          fetchedAt: new Date().toISOString(),
          totalTvl,
          chainsTracked: chains.length,
          topChains,
          topProtocols,
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
   * Fetch broad trending token data from DexScreener.
   */
  async fetchDexScreener() {
    const cacheKey = 'web:dexscreener';
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    await rateLimiter.waitForSlot('dexscreener');

    const baseUrl = this.sources.dexscreener?.baseUrl || 'https://api.dexscreener.com';

    try {
      const profilesRes = await axios.get(`${baseUrl}/token-profiles/latest/v1`, {
        timeout: 10000,
      });

      await rateLimiter.waitForSlot('dexscreener');
      const boostsRes = await axios.get(`${baseUrl}/token-boosts/latest/v1`, {
        timeout: 10000,
      });

      const profiles = Array.isArray(profilesRes.data) ? profilesRes.data : [];
      const boosts = Array.isArray(boostsRes.data) ? boostsRes.data : [];

      const result = {
        source: 'dexscreener',
        data: {
          fetchedAt: new Date().toISOString(),
          tokenProfiles: profiles.slice(0, 15).map((item) => ({
            chainId: item.chainId,
            tokenAddress: item.tokenAddress,
            url: item.url,
            description: item.description,
            icon: item.icon,
          })),
          latestBoosts: boosts.slice(0, 15).map((item) => ({
            chainId: item.chainId,
            tokenAddress: item.tokenAddress,
            amount: item.amount,
            totalAmount: item.totalAmount,
            url: item.url,
          })),
        },
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
        data: {
          fetchedAt: new Date().toISOString(),
          trendingTokens: tokens.slice(0, 20),
        },
      };

      this._saveSnapshot('birdeye', result.data);
      cache.set(cacheKey, result);
      return result;
    } catch (err) {
      logger.error(`WebScraper: Birdeye ошибка: ${err.message}`);
      return null;
    }
  }

  async fetchGiftStat() {
    const cacheKey = 'web:giftstat';
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    if (!this.browserPath) {
      logger.warn('WebScraper: headless browser not found, GiftStat skipped');
      return null;
    }

    try {
      const baseUrl = this.sources.giftstat?.baseUrl || this.sources.giftstat?.base_url || 'https://giftstat.com';
      const indexesUrl = this.sources.giftstat?.indexesUrl || this.sources.giftstat?.indexes_url || `${baseUrl.replace(/\/$/, '')}/giftindexes`;
      const [mainHtml, indexesHtml] = await Promise.all([
        this._renderPage(baseUrl),
        this._renderPage(indexesUrl),
      ]);

      const result = {
        source: 'giftstat',
        data: {
          fetchedAt: new Date().toISOString(),
          baseUrl,
          indexesUrl,
          siteSignals: this._extractGiftStatSignals(mainHtml, indexesHtml),
        },
      };

      this._saveSnapshot('giftstat', result.data);
      cache.set(cacheKey, result);
      return result;
    } catch (err) {
      logger.error(`WebScraper: GiftStat error: ${err.message}`);
      return null;
    }
  }

  async fetchGiftCharts() {
    const cacheKey = 'web:giftcharts';
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    if (!this.browserPath) {
      logger.warn('WebScraper: headless browser not found, GiftCharts skipped');
      return null;
    }

    try {
      const homeUrl = this.sources.giftcharts?.homeUrl || this.sources.giftcharts?.home_url || 'https://giftcharts.com/ru';
      const html = await this._renderPage(homeUrl);
      const text = this._cleanHtmlText(html);

      const result = {
        source: 'giftcharts',
        data: {
          fetchedAt: new Date().toISOString(),
          homeUrl,
          leaderboard: this._parseGiftChartsLeaderboard(text),
        },
      };

      this._saveSnapshot('giftcharts', result.data);
      cache.set(cacheKey, result);
      return result;
    } catch (err) {
      logger.error(`WebScraper: GiftCharts error: ${err.message}`);
      return null;
    }
  }

  async fetchPeek() {
    const cacheKey = 'web:peek';
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    if (!this.browserPath) {
      logger.warn('WebScraper: headless browser not found, peek.tg skipped');
      return null;
    }

    try {
      const statsUrl = this.sources.peek?.statsUrl || this.sources.peek?.stats_url || 'https://peek.tg/stats';
      const transfersUrl = this.sources.peek?.transfersUrl || this.sources.peek?.transfers_url || 'https://peek.tg/transfers';
      const [statsHtml, transfersHtml] = await Promise.all([
        this._renderPage(statsUrl),
        this._renderPage(transfersUrl),
      ]);

      const statsText = this._cleanHtmlText(statsHtml);
      const transfersText = this._cleanHtmlText(transfersHtml);

      const result = {
        source: 'peek',
        data: {
          fetchedAt: new Date().toISOString(),
          statsUrl,
          transfersUrl,
          topMovers: this._parsePeekStats(statsText),
          transferFeedStatus: this._extractPeekTransferStatus(transfersText),
        },
      };

      this._saveSnapshot('peek', result.data);
      cache.set(cacheKey, result);
      return result;
    } catch (err) {
      logger.error(`WebScraper: peek.tg error: ${err.message}`);
      return null;
    }
  }

  _detectBrowserPath() {
    return DEFAULT_BROWSER_PATHS.find((candidate) => candidate && fs.existsSync(candidate)) || null;
  }

  _normalizeSourcesConfig(rawConfig) {
    if (!rawConfig || typeof rawConfig !== 'object') {
      return {};
    }

    if (Array.isArray(rawConfig.apis)) {
      return rawConfig.apis.reduce((acc, item) => {
        const name = String(item?.name || '').trim().toLowerCase();
        if (!name) return acc;
        acc[name] = {
          ...item,
          baseUrl: item.baseUrl || item.base_url || '',
        };
        return acc;
      }, {});
    }

    return Object.fromEntries(
      Object.entries(rawConfig).map(([key, value]) => [
        String(key).trim().toLowerCase(),
        {
          ...value,
          baseUrl: value?.baseUrl || value?.base_url || '',
        },
      ]),
    );
  }

  _renderPage(url) {
    return new Promise((resolve, reject) => {
      execFile(
        this.browserPath,
        [
          '--headless=new',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--virtual-time-budget=12000',
          '--dump-dom',
          url,
        ],
        {
          windowsHide: true,
          timeout: 45000,
          maxBuffer: 8 * 1024 * 1024,
        },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(stdout || '');
        },
      );
    });
  }

  _parseCryptoPanicNews(html) {
    const chunks = String(html || '').split('<div class="news-row news-row-link">').slice(1);
    const items = [];
    const seen = new Set();

    for (const chunk of chunks) {
      const timeMatch = chunk.match(/<time[^>]*datetime="([^"]+)"[^>]*>([\s\S]*?)<\/time>/i);
      const titleMatch = chunk.match(/class="news-cell nc-title"[\s\S]*?<span class="title-text"><span>([\s\S]*?)<\/span>\s*<span class="si-source-name/i);
      const linkMatch = chunk.match(/href="(\/news\/[^"]+)"/i);
      const sourceMatch = chunk.match(/class="si-source-domain">([\s\S]*?)<\/span>/i);
      const currencyMatch = chunk.match(/class="news-cell nc-currency">[\s\S]*?<a[^>]*class="colored-link">([\s\S]*?)<\/a>/i);

      const title = this._cleanHtmlText(titleMatch?.[1] || '');
      if (!title) {
        continue;
      }

      const url = this._toAbsoluteUrl(linkMatch?.[1] || '');
      const dedupeKey = url || title;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      const currency = this._cleanHtmlText(currencyMatch?.[1] || '');

      items.push({
        title,
        url,
        sourceDomain: this._cleanHtmlText(sourceMatch?.[1] || ''),
        currency: /^[A-Z0-9_-]{3,15}$/.test(currency) ? currency : '',
        publishedAt: this._normalizeTimestamp(timeMatch?.[1] || ''),
        ageLabel: this._cleanHtmlText(timeMatch?.[2] || ''),
      });

      if (items.length >= 30) {
        break;
      }
    }

    return items;
  }

  _normalizeTimestamp(value) {
    const iso = String(value || '').trim();
    const timestamp = Date.parse(iso);
    if (Number.isNaN(timestamp)) {
      return null;
    }
    return new Date(timestamp).toISOString();
  }

  _isFreshTimestamp(isoString, maxAgeHours) {
    if (!isoString) {
      return false;
    }

    const publishedAt = Date.parse(isoString);
    if (Number.isNaN(publishedAt)) {
      return false;
    }

    const ageMs = Date.now() - publishedAt;
    return ageMs >= 0 && ageMs <= (maxAgeHours * 60 * 60 * 1000);
  }

  _toAbsoluteUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return '';
    }
    if (/^https?:\/\//i.test(raw)) {
      return raw;
    }
    return `https://cryptopanic.com${raw.startsWith('/') ? raw : `/${raw}`}`;
  }

  _cleanHtmlText(value) {
    const decoded = this._decodeHtmlEntities(String(value || ''));
    return decoded
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[^\p{L}\p{N}$#@]+/u, '')
      .trim();
  }

  _decodeHtmlEntities(value) {
    return String(value || '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, '\'')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ');
  }

  _extractGiftStatSignals(mainHtml, indexesHtml) {
    const mainText = this._cleanHtmlText(mainHtml).slice(0, 1400);
    const indexesText = this._cleanHtmlText(indexesHtml).slice(0, 1400);
    const relatedLinks = [...new Set([
      ...this._extractAbsoluteLinks(mainHtml, 'https://giftstat.com'),
      ...this._extractAbsoluteLinks(indexesHtml, 'https://giftstat.com'),
    ])]
      .filter((link) => /giftstat\.com|t\.me\//i.test(link))
      .slice(0, 12);

    return {
      summary: indexesText || mainText,
      relatedLinks,
    };
  }

  _parseGiftChartsLeaderboard(text) {
    const rows = [];
    const pattern = /([A-Za-z][A-Za-z' -]{1,40}?)\s+\d+(?:[.,]\d+)?\S*\s*\/\s*\d+(?:[.,]\d+)?\S*\s+(\d+(?:[.,]\d+)?)\s+([+-]?\d+(?:[.,]\d+)?)%/g;

    for (const match of String(text || '').matchAll(pattern)) {
      const name = String(match[1] || '').trim();
      if (!name || rows.some((row) => row.name === name)) {
        continue;
      }

      rows.push({
        name,
        currentPrice: Number(String(match[2]).replace(',', '.')),
        change24hPct: Number(String(match[3]).replace(',', '.')),
      });

      if (rows.length >= 15) {
        break;
      }
    }

    return rows;
  }

  _parsePeekStats(text) {
    const movers = [];
    const pattern = /([A-Za-z][A-Za-z' -]{1,40}?) Current Price (\d+(?:[.,]\d+)?) ([+-]?\d+(?:[.,]\d+)?)%/g;

    for (const match of String(text || '').matchAll(pattern)) {
      const name = String(match[1] || '').trim();
      if (!name || movers.some((item) => item.name === name)) {
        continue;
      }

      movers.push({
        name,
        currentPrice: Number(String(match[2]).replace(',', '.')),
        changePct: Number(String(match[3]).replace(',', '.')),
      });

      if (movers.length >= 20) {
        break;
      }
    }

    return movers;
  }

  _extractPeekTransferStatus(text) {
    const clean = String(text || '');
    return {
      isRealtimeMentioned: /реальном времени/i.test(clean),
      isFeedDisabled: /отключено/i.test(clean),
      sourceBot: (clean.match(/@[\w_]+/) || [null])[0],
    };
  }

  _extractAbsoluteLinks(html, origin) {
    return [...String(html || '').matchAll(/href="([^"]+)"/g)]
      .map((match) => match[1])
      .filter(Boolean)
      .map((value) => {
        if (/^https?:\/\//i.test(value)) {
          return value;
        }
        if (value.startsWith('/')) {
          return `${origin.replace(/\/$/, '')}${value}`;
        }
        return value;
      });
  }

  /**
   * Save a data snapshot to the analytics_snapshots table.
   */
  _saveSnapshot(source, data) {
    try {
      runSql(
        'INSERT INTO analytics_snapshots (source, data) VALUES (?, ?)',
        [source, JSON.stringify(data)],
      );
    } catch (err) {
      logger.error(`WebScraper: ошибка сохранения snapshot ${source}: ${err.message}`);
    }
  }
}

module.exports = WebScraper;
