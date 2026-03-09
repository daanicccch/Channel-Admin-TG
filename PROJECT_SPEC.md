# 🚀 Crypto Digest Bot — Полная спецификация проекта

## Суть проекта

Автоматизированная система на **Node.js**, которая:
1. Парсит посты из списка Telegram-каналов (крипто-тематика, упор на Solana)
2. Анализирует контент с помощью AI (**Gemini 2.5 Flash** — основная модель, **Qwen 3.5** — fallback)
3. Генерирует уникальные, «живые» посты-дайджесты
4. Публикует их в свой Telegram-канал через Bot API

**AI-стек (бесплатный):**
- **Основная модель:** Google Gemini 2.5 Flash (free tier: 10 RPM, 250 RPD, 250K TPM) — через Google AI Studio API
- **Fallback модель:** Alibaba Qwen 3.5 Plus (через DashScope API, OpenAI-совместимый) — подхватывает при лимитах Gemini
- Оба API совместимы с OpenAI SDK форматом, что упрощает переключение

**Ключевой принцип:** посты должны быть неотличимы от написанных человеком — живой язык, эмодзи, стикеры, картинки, форматирование как у топовых крипто-каналов.

---

## Архитектура

### Структура проекта

```
crypto-digest-bot/
├── src/
│   ├── index.js                 # Точка входа, оркестратор
│   ├── config.js                # Загрузка конфигов и .env
│   ├── scraper/
│   │   ├── telegramScraper.js   # Парсинг TG-каналов (через MTProto или gramjs)
│   │   ├── webScraper.js        # Парсинг веб-источников (CoinGecko, DeFiLlama, etc.)
│   │   └── mediaSaver.js        # Скачивание и кеширование медиа
│   ├── analyzer/
│   │   ├── contentAnalyzer.js   # Кластеризация и ранжирование постов
│   │   ├── trendDetector.js     # Выявление трендов и горячих тем
│   │   └── sentimentAnalyzer.js # Анализ настроений рынка
│   ├── ai/
│   │   ├── aiProvider.js        # Абстракция: Gemini (основной) + Qwen (fallback)
│   │   ├── geminiClient.js      # Google Gemini 2.5 Flash через AI Studio API
│   │   └── qwenClient.js        # Qwen 3.5 через DashScope (OpenAI-совместимый)
│   ├── generator/
│   │   ├── postGenerator.js     # Генерация текста поста через AI Provider
│   │   ├── mediaHandler.js      # Подбор/генерация картинок
│   │   ├── formatBuilder.js     # Telegram-форматирование (HTML/Markdown)
│   │   └── styleEngine.js       # Применение правил стиля из POST_RULES.md
│   ├── publisher/
│   │   ├── telegramPublisher.js # Отправка постов через Bot API
│   │   ├── scheduler.js         # Расписание публикаций
│   │   └── queueManager.js      # Очередь постов с ревью
│   └── utils/
│       ├── logger.js            # Логирование
│       ├── rateLimiter.js       # Rate limiting для API
│       └── cache.js             # Кеширование данных
├── data/
│   ├── channels.json            # Список TG-каналов для мониторинга
│   ├── web_sources.json         # Веб-источники аналитики
│   └── media_cache/             # Кеш скачанных медиа
├── rules/
│   ├── POST_RULES.md            # Правила написания постов (редактируемый)
│   └── TEMPLATES.md             # Шаблоны типов постов
├── .env                         # API ключи и секреты
├── package.json
└── README.md
```

---

## Детальное описание модулей

### 1. Scraper — Сбор данных

#### 1.1 Telegram Scraper (`telegramScraper.js`)

**Библиотека:** `telegram` (GramJS) — работает через MTProto, не через Bot API (бот API не может читать чужие каналы).

**Функции:**
- Подключение к Telegram через user account (API ID + API Hash с my.telegram.org)
- Чтение последних N постов из каждого канала
- Извлечение: текст, медиа (фото/видео/документы), реакции, просмотры, форварды
- Скачивание медиафайлов для переиспользования
- Поддержка фильтрации по времени (последние X часов)

**Формат данных на выходе:**
```json
{
  "channel": "@channel_name",
  "channelTitle": "Название канала",
  "posts": [
    {
      "id": 12345,
      "date": "2026-03-07T10:30:00Z",
      "text": "Текст поста...",
      "entities": [...],
      "media": {
        "type": "photo",
        "localPath": "/data/media_cache/abc123.jpg",
        "caption": "..."
      },
      "views": 15000,
      "reactions": { "🔥": 120, "👍": 85 },
      "forwards": 42
    }
  ]
}
```

#### 1.2 Web Scraper (`webScraper.js`)

**Веб-источники для аналитики Solana:**
- **CoinGecko API** — цены, объемы, маркеткап SOL и токенов экосистемы
- **DeFiLlama API** — TVL протоколов на Solana, изменения
- **Dune Analytics** — on-chain метрики (через API или скрейпинг дашбордов)
- **Jupiter Aggregator API** — объемы свопов, топ-токены
- **Birdeye API** — аналитика токенов на Solana
- **Solscan/Solana FM API** — активность сети, TPS, стейкинг
- **DexScreener API** — новые пары, объемы DEX
- **Twitter/X API** — крипто-инфлюенсеры о Solana (опционально)
- **CoinMarketCap API** — дополнительная ценовая аналитика

**Формат данных:**
```json
{
  "source": "defillama",
  "timestamp": "2026-03-07T12:00:00Z",
  "data": {
    "solana_tvl": 12500000000,
    "tvl_change_24h": 3.5,
    "top_protocols": [
      { "name": "Marinade", "tvl": 1200000000, "change": 5.2 },
      { "name": "Raydium", "tvl": 980000000, "change": -1.3 }
    ]
  }
}
```

#### 1.3 Media Saver (`mediaSaver.js`)

- Скачивает фото/видео из постов в `data/media_cache/`
- Хранит маппинг `originalUrl -> localPath`
- Автоматическая очистка кеша старше N дней
- Поддержка ресайза и оптимизации изображений

---

### 2. Analyzer — Анализ контента

#### 2.1 Content Analyzer (`contentAnalyzer.js`)

**Задачи:**
- Кластеризация постов по темам (один и тот же новостной повод)
- Ранжирование по важности: views × reactions × forwards
- Определение уникального контента vs повторяющиеся новости
- Выделение ключевых фактов и цифр

**Алгоритм:**
1. Собрать все посты за период
2. Через AI Provider (Gemini/Qwen): кластеризовать по темам, вернуть JSON
3. Для каждого кластера: определить главный факт, цифры, мнения
4. Ранжировать кластеры по engagement-метрикам
5. Выбрать топ-N тем для поста

#### 2.2 Trend Detector (`trendDetector.js`)

- Отслеживание повторяющихся упоминаний токенов/протоколов
- Резкие изменения в ценах/TVL/объемах
- Новые проекты, о которых начали писать несколько каналов
- Сигналы: листинги, аирдропы, хаки, governance votes

#### 2.3 Sentiment Analyzer (`sentimentAnalyzer.js`)

- Оценка общего настроения рынка по постам
- Шкала: extreme fear → fear → neutral → greed → extreme greed
- Сравнение sentiment текущий vs предыдущий период
- Используется для тональности генерируемых постов

---

### 3. AI Provider — Абстракция над моделями

#### 3.0 AI Provider (`ai/aiProvider.js`)

**Паттерн: основная модель + fallback с автоматическим переключением.**

```javascript
// Единый интерфейс для всех AI-моделей
class AIProvider {
  constructor() {
    this.primary = new GeminiClient();   // Gemini 2.5 Flash
    this.fallback = new QwenClient();    // Qwen 3.5 Plus
    this.currentProvider = 'gemini';
  }

  async generate(prompt, options = {}) {
    try {
      const result = await this.primary.generate(prompt, options);
      this.currentProvider = 'gemini';
      return result;
    } catch (err) {
      if (err.status === 429 || err.code === 'RESOURCE_EXHAUSTED') {
        console.log('⚠️ Gemini rate limit, switching to Qwen...');
        this.currentProvider = 'qwen';
        return await this.fallback.generate(prompt, options);
      }
      throw err;
    }
  }
}
```

#### 3.0.1 Gemini Client (`ai/geminiClient.js`)

**API:** Google AI Studio (Gemini Developer API)
**Модель:** `gemini-2.5-flash` (free tier)
**Лимиты free tier:** 10 RPM, 250 RPD, 250K TPM
**Endpoint:** `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`

```javascript
const { GoogleGenerativeAI } = require('@google/generative-ai');

class GeminiClient {
  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  }

  async generate(prompt, { temperature = 0.8, maxTokens = 4096 } = {}) {
    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: maxTokens }
    });
    return result.response.text();
  }
}
```

#### 3.0.2 Qwen Client (`ai/qwenClient.js`)

**API:** DashScope (OpenAI-совместимый endpoint)
**Модель:** `qwen-plus` или `qwen-turbo` (есть бесплатные кредиты при регистрации)
**Endpoint:** `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`

```javascript
const OpenAI = require('openai');

class QwenClient {
  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.DASHSCOPE_API_KEY,
      baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
    });
  }

  async generate(prompt, { temperature = 0.8, maxTokens = 4096 } = {}) {
    const response = await this.client.chat.completions.create({
      model: 'qwen-plus',
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens
    });
    return response.choices[0].message.content;
  }
}
```

**Почему Qwen через OpenAI SDK:** DashScope полностью совместим с OpenAI Chat Completions API — меняется только `baseURL` и `apiKey`. Никаких кастомных клиентов не нужно.

---

### 3. Generator — Создание постов

#### 3.1 Post Generator (`postGenerator.js`)

**Промт для AI (Gemini / Qwen):**

```
Ты — автор крипто Telegram-канала с фокусом на экосистему Solana.
Твоя задача — написать пост на основе собранных данных.

ПРАВИЛА (загружаются из POST_RULES.md — см. ниже):
{rules_content}

ДАННЫЕ ДЛЯ ПОСТА:
- Тип поста: {post_type}
- Кластеры тем: {topics_json}
- On-chain данные: {onchain_data}
- Настроение рынка: {sentiment}
- Доступные медиа: {media_list}

ТРЕБОВАНИЯ К ВЫХОДУ:
1. Текст поста в формате Telegram HTML
2. Рекомендации по медиа (какую картинку использовать/найти)
3. Предложения по стикерам/эмодзи
4. Хэштеги

Формат ответа — строго JSON:
{
  "text": "<b>Заголовок</b>\n\nТекст поста...",
  "media_suggestion": "описание нужной картинки",
  "reuse_media_id": "id медиа из входных данных или null",
  "stickers": ["стикер_id_1"],
  "hashtags": ["#Solana", "#SOL"],
  "post_type": "digest|alert|analysis|meme"
}
```

#### 3.2 Media Handler (`mediaHandler.js`)

**Стратегия подбора медиа (приоритет):**

1. **Переиспользование из источников** — если пост основан на конкретном посте с хорошей картинкой, берем её. Это нормально для аналитического канала-дайджеста.
2. **Поиск в интернете** — через Bing Image Search API или Google Custom Search API находим релевантное изображение по описанию.
3. **Генерация** — через API генерации изображений (DALL-E, Stability AI) для уникальных обложек и инфографики. Использовать для:
   - Обложки еженедельных дайджестов
   - Уникальные арты к важным событиям
   - Мемы (аккуратно, стиль крипто-комьюнити)
4. **Шаблонные картинки** — набор заготовленных шаблонов (графики, таблицы) которые заполняются данными через Canvas/Sharp.

**Инфографика программная (через sharp/canvas):**
- Графики цен SOL и топ-токенов
- Таблицы TVL-изменений
- Карточки «токен дня» с логотипом, ценой, изменением

#### 3.3 Format Builder (`formatBuilder.js`)

**Telegram HTML-форматирование:**
```html
<b>Жирный</b>
<i>Курсив</i>
<code>Моноширинный</code>
<a href="url">Ссылка</a>
<tg-spoiler>Спойлер</tg-spoiler>
```

**Элементы «живости»:**
- Эмодзи в начале заголовков (🔥 🚀 ⚡ 💰 📊 🎯 👀 ⚠️)
- Разделители между блоками (━━━━━━━, ▫️▫️▫️, и т.п.)
- Случайные вариации формулировок
- Иногда — опрос (poll) через Bot API
- Кнопки (inline keyboard) со ссылками на источники

#### 3.4 Style Engine (`styleEngine.js`)

- Загружает правила из `rules/POST_RULES.md`
- Валидирует сгенерированный пост на соответствие правилам
- Если пост не проходит валидацию — перегенерация с указанием ошибок
- Hot-reload: при изменении POST_RULES.md правила обновляются без перезапуска

---

### 4. Publisher — Публикация

#### 4.1 Telegram Publisher (`telegramPublisher.js`)

**Библиотека:** `node-telegram-bot-api` или `telegraf`

**Поддерживаемые типы сообщений:**
- `sendMessage` — текст с HTML-разметкой
- `sendPhoto` — фото с подписью
- `sendMediaGroup` — группа медиа (альбом)
- `sendSticker` — стикер до/после поста
- `sendPoll` — опросы
- `editMessageText` — обновление постов (напр. обновление цен)
- Inline Keyboard — кнопки со ссылками

**Алгоритм публикации:**
1. (опционально) Отправить стикер-тизер
2. Пауза 1-3 секунды (имитация живого автора)
3. Отправить основной пост (фото + текст ИЛИ текст)
4. Если есть дополнительные медиа — альбом
5. Если есть опрос — пауза 5-10 секунд, отправить poll
6. Логировать message_id для возможного обновления

#### 4.2 Scheduler (`scheduler.js`)

**Библиотека:** `node-cron`

**Типы публикаций и расписание:**

| Тип | Расписание | Описание |
|-----|-----------|----------|
| 🌅 Утренний дайджест | 09:00 MSK | Что произошло за ночь, ключевые движения |
| 📊 Дневная аналитика | 14:00 MSK | Глубокий разбор одной темы/протокола |
| 🌙 Вечерний обзор | 20:00 MSK | Итоги дня, что смотреть завтра |
| ⚡ Срочные алерты | Real-time | Резкие движения цен (>10%), хаки, крупные анонсы |
| 📅 Недельный дайджест | Воскресенье 12:00 | Итоги недели, топ-события |

**Вариативность времени:** ±15 минут рандомный сдвиг (чтобы не выглядело как бот)

#### 4.3 Queue Manager (`queueManager.js`)

- Очередь постов перед публикацией
- **Режим ревью** (опционально): пост отправляется в приватный чат/группу админу
  - Админ нажимает ✅ → публикация
  - Админ нажимает ✏️ → редактирование и перепубликация
  - Админ нажимает ❌ → отклонение
- Автоматический режим: публикация без ревью
- Антиспам: минимум 30 минут между постами

---

## Конфигурационные файлы

### `data/channels.json`

```json
{
  "channels": [
    {
      "username": "solana_daily",
      "name": "Solana Daily",
      "priority": "high",
      "language": "en",
      "category": "news",
      "scrape_interval_minutes": 30
    },
    {
      "username": "sol_ecosystem",
      "name": "Solana Ecosystem",
      "priority": "high",
      "language": "ru",
      "category": "analytics",
      "scrape_interval_minutes": 60
    },
    {
      "username": "crypto_insider_ru",
      "name": "Крипто Инсайдер",
      "priority": "medium",
      "language": "ru",
      "category": "general_crypto",
      "scrape_interval_minutes": 60
    }
  ],
  "settings": {
    "max_posts_per_channel": 50,
    "lookback_hours": 24,
    "min_views_threshold": 1000
  }
}
```

### `data/web_sources.json`

```json
{
  "apis": [
    {
      "name": "coingecko",
      "base_url": "https://api.coingecko.com/api/v3",
      "endpoints": {
        "sol_price": "/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true",
        "sol_ecosystem": "/coins/markets?vs_currency=usd&category=solana-ecosystem&order=market_cap_desc"
      },
      "rate_limit_ms": 1500,
      "auth": null
    },
    {
      "name": "defillama",
      "base_url": "https://api.llama.fi",
      "endpoints": {
        "solana_tvl": "/v2/historicalChainTvl/Solana",
        "protocols": "/protocols"
      },
      "rate_limit_ms": 500,
      "auth": null
    },
    {
      "name": "birdeye",
      "base_url": "https://public-api.birdeye.so",
      "endpoints": {
        "token_overview": "/defi/token_overview",
        "trending": "/defi/token_trending"
      },
      "rate_limit_ms": 1000,
      "auth": "API_KEY"
    },
    {
      "name": "dexscreener",
      "base_url": "https://api.dexscreener.com/latest",
      "endpoints": {
        "solana_pairs": "/dex/search?q=solana"
      },
      "rate_limit_ms": 1000,
      "auth": null
    }
  ]
}
```

### `.env`

```env
# Telegram Bot
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHANNEL_ID=@your_channel
TELEGRAM_ADMIN_CHAT_ID=123456789

# Telegram MTProto (для чтения каналов)
TELEGRAM_API_ID=12345
TELEGRAM_API_HASH=abcdef1234567890
TELEGRAM_SESSION_STRING=...

# AI — Основная модель (Gemini)
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash

# AI — Fallback модель (Qwen через DashScope)
DASHSCOPE_API_KEY=sk-your_dashscope_key
QWEN_MODEL=qwen-plus
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1

# Опционально: генерация картинок (Gemini умеет генерить картинки бесплатно!)
# Или можно использовать бесплатные API: Pollinations.ai, Stability AI free tier

# Аналитика
BIRDEYE_API_KEY=...
DUNE_API_KEY=...

# Режим
AUTO_PUBLISH=false
REVIEW_MODE=true
LOG_LEVEL=info
AI_PROVIDER=gemini
AI_FALLBACK=qwen
```

---

## Правила написания постов

### `rules/POST_RULES.md`

```markdown
# Правила написания постов для крипто-канала

## Общий стиль
- Пиши как живой человек, а не как ИИ или новостное агентство
- Используй разговорный, но экспертный тон
- Допускается легкий сленг крипто-комьюнити: HODL, ape in, DYOR, NFA, LFG, WAGMI
- НЕ используй: "в данной статье", "следует отметить", "необходимо подчеркнуть"
- НЕ начинай посты со слов: "Друзья", "Итак", "Добрый день"
- Можно начать с эмодзи + цепляющий заголовок или с горячего факта

## Язык
- Основной язык: русский
- Технические термины можно оставлять на английском: TVL, APY, DEX, staking
- Названия протоколов/токенов — на английском

## Форматирование
- Заголовок: жирный, с эмодзи
- Абзацы: короткие, 2-3 предложения максимум
- Между блоками: пустая строка или разделитель
- Разделители: "━━━━━━━━━━", "▫️▫️▫️▫️▫️", "—", или просто пустая строка
- Ключевые цифры выделять жирным или кодом: <code>$145.20</code>
- Ссылки: [текст](url) или в конце поста блоком "Источники"

## Эмодзи
- Использовать умеренно, 3-7 на пост
- Заголовок: 1-2 эмодзи
- В тексте: для акцентов, не в каждом предложении
- Подходящие: 🔥 🚀 💰 📊 📈 📉 ⚡ 🎯 👀 ⚠️ 🔑 💎 🐂 🐻 🌊 ✅ ❌
- НЕ использовать: 😂 🤣 😍 🥰 (слишком неформально для аналитики)

## Типы постов

### 1. Дайджест (утро/вечер)
- Формат: 3-5 коротких блоков, каждый про отдельную тему
- Каждый блок: эмодзи + тема в 1 строку + 1-2 предложения деталей
- В конце: вывод или вопрос к подписчикам
- Длина: 800-1500 символов

### 2. Аналитика (глубокий разбор)
- Формат: одна тема, подробный разбор
- Структура: проблема → данные → анализ → вывод
- Обязательно: цифры, графики, сравнения
- Длина: 1500-3000 символов
- Обязательно картинка или инфографика

### 3. Алерт (срочное)
- Формат: ⚡ ALERT + суть в 1 строку
- Минимум текста, максимум конкретики
- Цена, % изменения, что это значит
- Длина: 300-800 символов

### 4. Мем/развлечение
- Формат: картинка/мем + короткий комментарий
- Использовать редко: 1-2 раза в неделю
- Должно быть релевантно текущей ситуации на рынке

## Что НЕЛЬЗЯ
- Давать финансовые советы ("покупайте", "продавайте")
- Гарантировать рост/падение
- Копировать текст дословно из источников
- Публиковать непроверенные слухи как факты
- Спамить однотипными постами

## Что НУЖНО
- Добавлять "NFA" / "DYOR" при упоминании конкретных токенов
- Указывать источники данных
- Давать контекст цифрам (сравнения с прошлым периодом)
- Иногда задавать вопросы подписчикам (engagement)
- Использовать опросы (1-2 раза в неделю)

## Вариативность
- Не начинать каждый пост одинаково
- Чередовать типы постов
- Разная длина постов
- Иногда — только картинка с коротким комментарием
- Иногда — длинный лонгрид
```

---

## Технологический стек

| Компонент | Технология | Почему |
|-----------|-----------|--------|
| Runtime | Node.js 20+ | Async I/O, большая экосистема |
| TG чтение | GramJS (`telegram`) | MTProto, чтение каналов |
| TG публикация | `telegraf` | Удобный Bot API wrapper |
| AI основной | Gemini 2.5 Flash (`@google/generative-ai`) | Бесплатно, 250 RPD, отличное качество |
| AI fallback | Qwen 3.5 Plus (`openai` SDK) | Бесплатные кредиты, OpenAI-совместимый |
| Картинки | `sharp` + Canvas API | Инфографика, ресайз |
| Расписание | `node-cron` | Планирование постов |
| HTTP | `axios` | API-запросы |
| Логирование | `winston` | Структурированные логи |
| Хранение | SQLite (`better-sqlite3`) | Локальная БД для истории |
| Конфиг | `dotenv` | Переменные окружения |

---

## Пайплайн обработки (flow)

```
[Cron Trigger / Alert Trigger]
        │
        ▼
┌─────────────────┐
│  1. SCRAPE       │ ← Telegram channels + Web APIs
│  telegramScraper │
│  webScraper      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  2. ANALYZE      │ ← Кластеризация, тренды, sentiment
│  contentAnalyzer │
│  trendDetector   │
│  sentimentAnalyzer│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  3. GENERATE     │ ← Gemini 2.5 Flash (→ Qwen fallback) + POST_RULES.md
│  aiProvider      │
│  postGenerator   │
│  mediaHandler    │
│  formatBuilder   │
│  styleEngine     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  4. REVIEW       │ ← Опционально: отправка админу
│  queueManager    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  5. PUBLISH      │ ← Bot API: текст + медиа + кнопки
│  telegramPublisher│
│  scheduler       │
└─────────────────┘
```

---

## Фичи для «живости» постов

1. **Рандомные задержки** между элементами поста (стикер → пауза → текст)
2. **Вариативность формулировок** — Claude получает инструкцию не повторяться
3. **Разные форматы** — чередование: текст, фото+текст, альбом, опрос
4. **Inline-кнопки** — "Подробнее", "Источник", "Обсудить"
5. **Реакции** — бот может ставить реакции на свои посты (через MTProto)
6. **Закрепы** — важные посты автоматически закрепляются
7. **Иногда ошибки** — намеренно оставлять мелкие опечатки (1 из 10 постов) для натуральности
8. **Контекст времени** — "доброе утро", "на ночь глядя" и т.п.
9. **Отсылки к предыдущим постам** — "как мы писали вчера..."
10. **Нерегулярность** — не строго по расписанию, ±5-20 минут

---

## База данных (SQLite)

```sql
-- История постов
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  type TEXT,              -- digest, analysis, alert, meme
  text TEXT,
  media_path TEXT,
  telegram_message_id INTEGER,
  published_at DATETIME,
  sources TEXT,           -- JSON массив source_post_ids
  engagement JSON         -- views, reactions после публикации
);

-- Источники (спарсенные посты)
CREATE TABLE source_posts (
  id INTEGER PRIMARY KEY,
  channel TEXT,
  telegram_post_id INTEGER,
  text TEXT,
  media_paths TEXT,       -- JSON
  views INTEGER,
  reactions TEXT,          -- JSON
  scraped_at DATETIME,
  used_in_posts TEXT      -- JSON массив post_ids
);

-- Аналитические данные
CREATE TABLE analytics_snapshots (
  id INTEGER PRIMARY KEY,
  source TEXT,
  data JSON,
  captured_at DATETIME
);

-- Тренды
CREATE TABLE trends (
  id INTEGER PRIMARY KEY,
  keyword TEXT,
  mentions INTEGER,
  first_seen DATETIME,
  last_seen DATETIME,
  sentiment REAL
);
```

---

## С чего начать (порядок реализации)

### Фаза 1 — MVP (неделя 1-2)
1. ✅ Настроить проект, установить зависимости
2. ✅ Telegram scraper — чтение постов из каналов
3. ✅ Простой Claude API промт — генерация дайджеста из постов
4. ✅ Telegram publisher — публикация текста + фото
5. ✅ POST_RULES.md — первая версия правил
6. ✅ Ручной запуск через CLI

### Фаза 2 — Автоматизация (неделя 3-4)
7. Cron-расписание
8. Web scraper (CoinGecko, DeFiLlama)
9. Режим ревью (отправка админу)
10. Медиа-хэндлер (переиспользование картинок)
11. SQLite для истории

### Фаза 3 — Продвинутые фичи (неделя 5+)
12. Trend detection
13. Sentiment analysis
14. Генерация инфографики (sharp/canvas)
15. Алерты в реальном времени
16. AI-генерация картинок
17. Аналитика эффективности постов

---

## Запуск

```bash
# Установка
npm install

# Первый запуск: авторизация в Telegram (нужен номер телефона)
node src/setup.js

# Ручная генерация и публикация
node src/index.js --mode=manual --type=digest

# Запуск по расписанию
node src/index.js --mode=auto

# Только скрейпинг (без публикации)
node src/index.js --mode=scrape-only
```

---

## Примечания

- **POST_RULES.md** — это ключевой файл, который ты будешь постоянно редактировать. Бот перечитывает его перед каждой генерацией.
- Все API ключи хранятся в `.env`, никогда не коммитятся в git.
- Для чтения TG каналов нужен реальный аккаунт (не бот), поэтому MTProto + GramJS.
- Бот должен уметь работать в двух режимах: полный автомат и ручное одобрение.
- **AI бесплатно:** Gemini 2.5 Flash — 250 запросов/день (хватит на ~50 полных циклов генерации). Qwen через DashScope — бесплатные кредиты при регистрации + дешёвые тарифы после.
- **Получение API ключей:**
  - Gemini: https://aistudio.google.com → Get API Key (без карты)
  - Qwen/DashScope: https://dashscope.aliyuncs.com → регистрация → API Keys
- **Fallback стратегия:** если Gemini вернул 429 (rate limit), автоматически переключаемся на Qwen. Если и Qwen недоступен — ставим пост в очередь и пробуем через 5 минут.
