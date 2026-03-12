const path = require('path');
const fs = require('fs');
const readline = require('readline');

// Загружаем .env до всего остального (но без валидации из config.js)
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const ENV_PATH = path.resolve(__dirname, '..', '.env');

/**
 * Запрашивает ввод пользователя через readline
 */
function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log('=== Авторизация Telegram MTProto ===\n');

  const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
  const apiHash = process.env.TELEGRAM_API_HASH;

  if (!apiId || !apiHash) {
    console.error('Ошибка: TELEGRAM_API_ID и TELEGRAM_API_HASH должны быть заданы в .env');
    console.error('Получите их на https://my.telegram.org → API development tools');
    process.exit(1);
  }

  console.log(`API ID: ${apiId}`);
  console.log(`API Hash: ${apiHash.slice(0, 4)}...${apiHash.slice(-4)}\n`);

  const client = new TelegramClient(
    new StringSession(''),
    apiId,
    apiHash,
    {
      connectionRetries: 5,
    },
  );

  await client.start({
    phoneNumber: async () => await prompt('Введите номер телефона (с кодом страны, напр. +7...): '),
    password: async () => await prompt('Введите пароль 2FA (если включён): '),
    phoneCode: async () => await prompt('Введите код из Telegram: '),
    onError: (err) => {
      console.error('Ошибка авторизации:', err.message);
    },
  });

  console.log('\n✅ Авторизация успешна!\n');

  const sessionString = client.session.save();

  console.log('Добавьте в .env:');
  console.log(`TELEGRAM_SESSION_STRING=${sessionString}\n`);

  // Пробуем автоматически записать в .env
  try {
    let envContent = '';
    if (fs.existsSync(ENV_PATH)) {
      envContent = fs.readFileSync(ENV_PATH, 'utf-8');
    }

    const sessionLine = `TELEGRAM_SESSION_STRING=${sessionString}`;

    if (envContent.includes('TELEGRAM_SESSION_STRING=')) {
      // Заменяем существующую строку
      envContent = envContent.replace(
        /^TELEGRAM_SESSION_STRING=.*$/m,
        sessionLine,
      );
    } else {
      // Добавляем в конец
      envContent = envContent.trimEnd() + '\n' + sessionLine + '\n';
    }

    fs.writeFileSync(ENV_PATH, envContent, 'utf-8');
    console.log('✅ Session string автоматически записан в .env\n');
  } catch (err) {
    console.warn('Не удалось автоматически записать в .env:', err.message);
    console.warn('Добавьте строку вручную.\n');
  }

  // Тестовое чтение — 1 сообщение из канала @telegram
  console.log('Тестируем подключение: читаем 1 сообщение из @telegram...');
  try {
    const { Api } = require('telegram');
    const result = await client.invoke(
      new Api.messages.GetHistory({
        peer: '@telegram',
        limit: 1,
      }),
    );

    if (result.messages && result.messages.length > 0) {
      const msg = result.messages[0];
      const preview = (msg.message || '(медиа)').slice(0, 100);
      console.log(`✅ Тест пройден. Последнее сообщение: "${preview}..."\n`);
    } else {
      console.log('✅ Подключение работает (сообщений не получено)\n');
    }
  } catch (testErr) {
    console.warn('Тест чтения не прошёл (это нормально):', testErr.message);
  }

  await client.disconnect();
  console.log('Готово! Можете запускать бота: node src/index.js --mode=manual --type=post');
  process.exit(0);
}

main().catch((err) => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});
