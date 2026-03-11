const cron = require('node-cron');
const { config } = require('../config');
const logger = require('../utils/logger');

class Scheduler {
  constructor(runPipeline, runChannelChecks = null) {
    this.runPipeline = runPipeline;
    this.runChannelChecks = runChannelChecks;
    this.tasks = [];
  }

  start() {
    const tz = config.schedule.timezone;
    const { morningHour, dayHour, eveningHour, checkIntervalMinutes } = config.schedule;

    const morningMin = Math.floor(Math.random() * 16);
    const dayMin = Math.floor(Math.random() * 16);
    const eveningMin = Math.floor(Math.random() * 16);
    const weeklyMin = Math.floor(Math.random() * 16);

    const morningCron = `${morningMin} ${morningHour} * * *`;
    const morningTask = cron.schedule(
      morningCron,
      async () => {
        logger.info('Запуск утреннего дайджеста');
        try {
          await this.runPipeline('digest');
        } catch (err) {
          logger.error(`Ошибка утреннего дайджеста: ${err.message}`);
        }
      },
      { timezone: tz },
    );
    this.tasks.push(morningTask);
    logger.info(`Утренний дайджест: ${morningCron} (${tz})`);

    const dayCron = `${dayMin} ${dayHour} * * *`;
    const dayTask = cron.schedule(
      dayCron,
      async () => {
        logger.info('Запуск дневной аналитики');
        try {
          await this.runPipeline('analysis');
        } catch (err) {
          logger.error(`Ошибка дневной аналитики: ${err.message}`);
        }
      },
      { timezone: tz },
    );
    this.tasks.push(dayTask);
    logger.info(`Дневная аналитика: ${dayCron} (${tz})`);

    const eveningCron = `${eveningMin} ${eveningHour} * * *`;
    const eveningTask = cron.schedule(
      eveningCron,
      async () => {
        logger.info('Запуск вечернего обзора');
        try {
          await this.runPipeline('digest');
        } catch (err) {
          logger.error(`Ошибка вечернего обзора: ${err.message}`);
        }
      },
      { timezone: tz },
    );
    this.tasks.push(eveningTask);
    logger.info(`Вечерний обзор: ${eveningCron} (${tz})`);

    const weeklyCron = `${weeklyMin} 12 * * 0`;
    const weeklyTask = cron.schedule(
      weeklyCron,
      async () => {
        logger.info('Запуск еженедельного дайджеста');
        try {
          await this.runPipeline('weekly');
        } catch (err) {
          logger.error(`Ошибка еженедельного дайджеста: ${err.message}`);
        }
      },
      { timezone: tz },
    );
    this.tasks.push(weeklyTask);
    logger.info(`Еженедельный дайджест: ${weeklyCron} (${tz})`);

    if (typeof this.runChannelChecks === 'function') {
      const safeInterval = Math.max(1, Number(checkIntervalMinutes) || 10);
      const checksCron = `*/${safeInterval} * * * *`;
      const checksTask = cron.schedule(
        checksCron,
        async () => {
          logger.info('Запуск быстрой проверки is_check-каналов');
          try {
            await this.runChannelChecks();
          } catch (err) {
            logger.error(`Ошибка быстрой проверки каналов: ${err.message}`);
          }
        },
        { timezone: tz },
      );
      this.tasks.push(checksTask);
      logger.info(`Быстрая проверка is_check-каналов: ${checksCron} (${tz})`);
    }

    logger.info(`Планировщик запущен: ${this.tasks.length} задач`);
  }

  stop() {
    for (const task of this.tasks) {
      task.stop();
    }
    this.tasks = [];
    logger.info('Планировщик остановлен');
  }
}

module.exports = { Scheduler };
