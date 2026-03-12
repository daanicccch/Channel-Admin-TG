const cron = require('node-cron');
const logger = require('../utils/logger');
const { getChannelProfiles } = require('../channelProfiles');

function getRandomMinuteInRange(startMinutes, endMinutes) {
  const safeStart = Number(startMinutes);
  const safeEnd = Number(endMinutes);

  if (!Number.isFinite(safeStart) || !Number.isFinite(safeEnd) || safeEnd <= safeStart) {
    return 9 * 60;
  }

  const offset = Math.floor(Math.random() * (safeEnd - safeStart));
  return safeStart + offset;
}

function buildCronFromMinuteOfDay(totalMinutes) {
  const minute = totalMinutes % 60;
  const hour = Math.floor(totalMinutes / 60) % 24;
  return `${minute} ${hour} * * *`;
}

function buildIntervalLabel(interval, index) {
  return interval.label || `slot_${index + 1}`;
}

class Scheduler {
  constructor(runPipeline, runChannelChecks = null) {
    this.runPipeline = runPipeline;
    this.runChannelChecks = runChannelChecks;
    this.tasks = [];
  }

  scheduleTask(cronExpr, timezone, taskTitle, callback) {
    const task = cron.schedule(
      cronExpr,
      async () => {
        logger.info(`${taskTitle}: started`);
        try {
          await callback();
        } catch (err) {
          logger.error(`${taskTitle}: ${err.message}`);
        }
      },
      { timezone },
    );

    this.tasks.push(task);
    logger.info(`${taskTitle}: ${cronExpr} (${timezone})`);
  }

  start() {
    const profiles = getChannelProfiles();

    for (const profile of profiles) {
      const schedule = profile.schedule || {};
      const timezone = schedule.timezone || 'Europe/Moscow';
      const postIntervals = Array.isArray(schedule.postIntervals) ? schedule.postIntervals : [];

      postIntervals.forEach((interval, index) => {
        const randomMinuteOfDay = getRandomMinuteInRange(interval.startMinutes, interval.endMinutes);
        const cronExpr = buildCronFromMinuteOfDay(randomMinuteOfDay);
        const slotLabel = buildIntervalLabel(interval, index);

        this.scheduleTask(
          cronExpr,
          timezone,
          `Autopost [${profile.id}] ${slotLabel} ${interval.start}-${interval.end}`,
          () => this.runPipeline('post', { profileId: profile.id, scheduleSlot: slotLabel }),
        );
      });

      if (schedule.weeklyDigest?.enabled !== false && schedule.weeklyDigest?.interval) {
        const weeklyInterval = schedule.weeklyDigest.interval;
        const randomMinuteOfDay = getRandomMinuteInRange(
          weeklyInterval.startMinutes,
          weeklyInterval.endMinutes,
        );
        const minute = randomMinuteOfDay % 60;
        const hour = Math.floor(randomMinuteOfDay / 60) % 24;
        const dayOfWeek = Math.min(6, Math.max(0, Number(schedule.weeklyDigest.dayOfWeek) || 0));
        const weeklyCron = `${minute} ${hour} * * ${dayOfWeek}`;

        this.scheduleTask(
          weeklyCron,
          timezone,
          `Weekly digest [${profile.id}] ${weeklyInterval.start}-${weeklyInterval.end}`,
          () => this.runPipeline('weekly', { profileId: profile.id, scheduleSlot: 'weekly' }),
        );
      }

      if (typeof this.runChannelChecks === 'function') {
        const checkIntervalMinutes = Math.max(1, Number(schedule.channelChecksIntervalMinutes) || 10);
        const checksCron = `*/${checkIntervalMinutes} * * * *`;

        this.scheduleTask(
          checksCron,
          timezone,
          `Channel checks [${profile.id}]`,
          () => this.runChannelChecks({ profileId: profile.id }),
        );
      }
    }

    logger.info(`Scheduler started: ${this.tasks.length} task(s) across ${profiles.length} profile(s)`);
  }

  stop() {
    for (const task of this.tasks) {
      task.stop();
    }
    this.tasks = [];
    logger.info('Scheduler stopped');
  }
}

module.exports = { Scheduler };
