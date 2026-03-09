const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');
const logger = require('../utils/logger');

const mediaCacheDir = config.paths.mediaCache;

// Ensure media cache directory exists
if (!fs.existsSync(mediaCacheDir)) {
  fs.mkdirSync(mediaCacheDir, { recursive: true });
}

/**
 * Download media from a GramJS message, resize and save as JPEG.
 * @param {TelegramClient} client — GramJS client
 * @param {Api.Message} message — GramJS message object
 * @param {string} channel — channel username (for filename)
 * @returns {string|null} — local file path or null on failure
 */
async function downloadMedia(client, message, channel) {
  try {
    const buffer = await client.downloadMedia(message);
    if (!buffer || buffer.length === 0) {
      logger.warn(`mediaSaver: пустой медиа-буфер для ${channel}/${message.id}`);
      return null;
    }

    const hash = crypto.createHash('md5').update(buffer).digest('hex').substring(0, 8);
    const filename = `${channel}_${message.id}_${hash}.jpg`;
    const filePath = path.join(mediaCacheDir, filename);

    // Resize to max 1280px width, convert to JPEG 85%
    await sharp(buffer)
      .resize({ width: 1280, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toFile(filePath);

    logger.debug(`mediaSaver: сохранено ${filename}`);
    return filePath;
  } catch (err) {
    logger.error(`mediaSaver: ошибка скачивания медиа ${channel}/${message.id}: ${err.message}`);
    return null;
  }
}

/**
 * Remove cached media files older than maxAgeDays.
 * @param {number} maxAgeDays
 */
function cleanOldMedia(maxAgeDays = config.limits.mediaCacheDays) {
  try {
    const files = fs.readdirSync(mediaCacheDir);
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const file of files) {
      const filePath = path.join(mediaCacheDir, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        removed++;
      }
    }

    if (removed > 0) {
      logger.info(`mediaSaver: удалено ${removed} старых медиа-файлов`);
    }
  } catch (err) {
    logger.error(`mediaSaver: ошибка очистки кэша: ${err.message}`);
  }
}

/**
 * Get local cached path for a channel+messageId if it exists.
 * @param {string} channel
 * @param {number} messageId
 * @returns {string|null}
 */
function getLocalPath(channel, messageId) {
  try {
    const files = fs.readdirSync(mediaCacheDir);
    const prefix = `${channel}_${messageId}_`;
    const match = files.find(f => f.startsWith(prefix));
    return match ? path.join(mediaCacheDir, match) : null;
  } catch (_err) {
    return null;
  }
}

module.exports = { downloadMedia, cleanOldMedia, getLocalPath };
