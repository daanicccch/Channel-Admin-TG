# Crypto Digest Bot

Telegram-бот для автоматического создания крипто-дайджестов. Собирает посты из Telegram-каналов и данные с веб-API (CoinGecko, DefiLlama, Birdeye, DexScreener), анализирует тренды и настроения, генерирует готовые посты с помощью AI (Gemini / Qwen) и публикует их в ваш канал.

## Быстрый старт

```bash
# 1. Установить зависимости
npm install

# 2. Скопировать конфигурацию
cp .env.example .env

# 3. Заполнить .env (см. раздел "Получение API ключей" ниже)

# 4. Авторизовать Telegram MTProto (для чтения каналов)
node src/setup.js

# 5. Запустить бота (разовый дайджест)
node src/index.js --mode=manual --type=digest
```

## Получение API ключей

### Telegram Bot Token

1. Откройте [@BotFather](https://t.me/BotFather) в Telegram
2. Отправьте `/newbot`
3. Придумайте имя и username для бота
4. Скопируйте токен в `TELEGRAM_BOT_TOKEN`
5. Добавьте бота администратором в ваш канал

### Telegram MTProto (API ID и Hash)

1. Перейдите на [my.telegram.org](https://my.telegram.org)
2. Войдите с номером телефона
3. Откройте **API development tools**
4. Создайте приложение (название и описание любые)
5. Скопируйте `App api_id` в `TELEGRAM_API_ID`
6. Скопируйте `App api_hash` в `TELEGRAM_API_HASH`

### Gemini API Key

1. Перейдите на [aistudio.google.com](https://aistudio.google.com)
2. Нажмите **Get API Key**
3. Создайте ключ (бесплатно, без привязки карты)
4. Скопируйте в `GEMINI_API_KEY`

### DashScope / Qwen API Key

1. Перейдите на [dashscope.aliyuncs.com](https://dashscope.aliyuncs.com) (международная версия: dashscope-intl.aliyuncs.com)
2. Зарегистрируйтесь / войдите
3. Перейдите в раздел **API Keys**
4. Создайте ключ и скопируйте в `DASHSCOPE_API_KEY`

### Birdeye (опционально)

1. Перейдите на [birdeye.so](https://birdeye.so)
2. Зарегистрируйтесь и получите API-ключ
3. Скопируйте в `BIRDEYE_API_KEY`
4. Без этого ключа бот будет работать, но без данных Birdeye

## Режимы запуска

| Режим | Команда | Описание |
|-------|---------|----------|
| `manual` | `node src/index.js --mode=manual --type=digest` | Разовый запуск пайплайна. Типы: `digest`, `analysis`, `alert`, `weekly` |
| `auto` | `node src/index.js --mode=auto` | Работает постоянно по расписанию (утро/день/вечер). Принимает посты через admin-ревью |
| `scrape-only` | `node src/index.js --mode=scrape-only` | Только сбор данных без генерации и публикации. Полезно для отладки |

## Настройка каналов

Файл `data/channels.json` содержит список Telegram-каналов для мониторинга. Для каждого канала указывается:

- `username` -- username канала без @
- `priority` -- приоритет (`high`, `medium`, `low`)
- `language` -- язык (`en`, `ru`)
- `category` -- категория (`news`, `analytics`, `general_crypto`)
- `scrape_interval_minutes` -- интервал сбора данных

## Настройка стиля

Файл `rules/POST_RULES.md` содержит правила написания постов: тон, форматирование, допустимые эмодзи, типы постов и запрещённые фразы. AI-модели используют эти правила при генерации текстов.

## Структура проекта

```
ChannelBot/
├── src/
│   ├── index.js              # Точка входа, оркестратор
│   ├── config.js             # Конфигурация и подключение к БД
│   ├── setup.js              # Скрипт авторизации MTProto
│   ├── ai/                   # Модули работы с AI (Gemini, Qwen)
│   ├── analyzer/             # Анализ контента, тренды, сентимент
│   ├── generator/            # Генерация постов
│   ├── publisher/            # Публикация, очередь, планировщик
│   ├── scraper/              # Сбор данных из Telegram и веб-API
│   └── utils/                # Логгер и вспомогательные утилиты
├── data/
│   ├── channels.json         # Список каналов для мониторинга
│   ├── web_sources.json      # Список веб-API источников
│   ├── media_cache/          # Кэш медиафайлов
│   └── bot.db                # SQLite база данных (создаётся автоматически)
├── rules/
│   └── POST_RULES.md         # Правила стиля постов
├── logs/                     # Логи приложения
├── .env                      # Переменные окружения (не в git)
└── .env.example              # Шаблон переменных окружения
```
