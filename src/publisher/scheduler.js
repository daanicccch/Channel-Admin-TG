const cron = require('node-cron');
const { config } = require('../config');
const logger = require('../utils/logger');

class Scheduler {
  /**
   * @param {function(string): Promise<void>} runPipeline — колбэк, вызываемый по расписанию с типом поста
   */
  constructor(runPipeline) {
    this.runPipeline = runPipeline;
    this.tasks = [];
  }

  /**
   * Запускает все cron-задачи
   */
  start() {
    const tz = config.schedule.timezone;
    const { morningHour, dayHour, eveningHour } = config.schedule;

    // Случайный сдвиг 0-15 минут для каждого задания
    const morningMin = Math.floor(Math.random() * 16);
    const dayMin = Math.floor(Math.random() * 16);
    const eveningMin = Math.floor(Math.random() * 16);
    const weeklyMin = Math.floor(Math.random() * 16);

    // Утренний дайджест
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

    // Дневная аналитика
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

    // Вечерний обзор
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

    // Еженедельный дайджест (воскресенье 12:xx)
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

    logger.info(`Планировщик запущен: ${this.tasks.length} задач`);
  }

  /**
   * Останавливает и уничтожает все cron-задачи
   */
  stop() {
    for (const task of this.tasks) {
      task.stop();
    }
    this.tasks = [];
    logger.info('Планировщик остановлен');
  }
}

module.exports = { Scheduler };
