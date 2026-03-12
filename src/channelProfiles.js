const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const logger = require('./utils/logger');

const PROFILES_ROOT = path.join(config.paths.root, 'profiles');
const LEGACY_PROFILES_FILE = path.join(config.paths.data, 'channel_profiles.json');
const DEFAULT_WEB_SOURCES = ['cryptopanic', 'coingecko', 'defillama', 'dexscreener', 'birdeye'];
const DEFAULT_WEEKLY_INTERVAL = { start: '12:00', end: '12:15' };
let startupProfilesLogged = false;

function formatHourMinute(hour, minute = 0) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function createLegacyScheduleFallback() {
  return {
    timezone: config.schedule.timezone,
    postIntervals: [
      {
        start: formatHourMinute(config.schedule.morningHour),
        end: formatHourMinute(config.schedule.morningHour, 15),
        label: 'morning',
      },
      {
        start: formatHourMinute(config.schedule.dayHour),
        end: formatHourMinute(config.schedule.dayHour, 15),
        label: 'day',
      },
      {
        start: formatHourMinute(config.schedule.eveningHour),
        end: formatHourMinute(config.schedule.eveningHour, 15),
        label: 'evening',
      },
    ],
    weeklyDigest: {
      enabled: true,
      dayOfWeek: 0,
      interval: { ...DEFAULT_WEEKLY_INTERVAL },
    },
    channelChecksIntervalMinutes: config.schedule.checkIntervalMinutes,
  };
}

function parseTimeToMinutes(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function normalizeTimeValue(value, fallback) {
  const minutes = parseTimeToMinutes(value);
  if (minutes === null) return fallback;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return formatHourMinute(hour, minute);
}

function normalizeSchedule(rawSchedule = {}, fallbackSchedule = createLegacyScheduleFallback()) {
  const schedule = rawSchedule && typeof rawSchedule === 'object' ? rawSchedule : {};
  const fallbackIntervals = Array.isArray(fallbackSchedule.postIntervals) ? fallbackSchedule.postIntervals : [];
  const rawIntervals = Array.isArray(schedule.postIntervals) ? schedule.postIntervals : fallbackIntervals;

  const postIntervals = rawIntervals
    .map((interval, index) => {
      if (!interval || typeof interval !== 'object') {
        return null;
      }

      const start = normalizeTimeValue(interval.start, null);
      const end = normalizeTimeValue(interval.end, null);
      if (!start || !end) {
        return null;
      }

      const startMinutes = parseTimeToMinutes(start);
      const endMinutes = parseTimeToMinutes(end);
      if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
        return null;
      }

      return {
        start,
        end,
        startMinutes,
        endMinutes,
        label: String(interval.label || `slot_${index + 1}`).trim(),
      };
    })
    .filter(Boolean);

  const rawWeeklyDigest = schedule.weeklyDigest;
  const fallbackWeeklyDigest = fallbackSchedule.weeklyDigest || {};
  const weeklyIntervalRaw = rawWeeklyDigest?.interval || fallbackWeeklyDigest.interval || DEFAULT_WEEKLY_INTERVAL;
  const weeklyIntervalStart = normalizeTimeValue(weeklyIntervalRaw.start, DEFAULT_WEEKLY_INTERVAL.start);
  const weeklyIntervalEnd = normalizeTimeValue(weeklyIntervalRaw.end, DEFAULT_WEEKLY_INTERVAL.end);
  const weeklyIntervalStartMinutes = parseTimeToMinutes(weeklyIntervalStart);
  const weeklyIntervalEndMinutes = parseTimeToMinutes(weeklyIntervalEnd);
  const weeklyInterval = weeklyIntervalStartMinutes !== null &&
    weeklyIntervalEndMinutes !== null &&
    weeklyIntervalEndMinutes > weeklyIntervalStartMinutes
    ? {
        start: weeklyIntervalStart,
        end: weeklyIntervalEnd,
        startMinutes: weeklyIntervalStartMinutes,
        endMinutes: weeklyIntervalEndMinutes,
      }
    : {
        start: DEFAULT_WEEKLY_INTERVAL.start,
        end: DEFAULT_WEEKLY_INTERVAL.end,
        startMinutes: parseTimeToMinutes(DEFAULT_WEEKLY_INTERVAL.start),
        endMinutes: parseTimeToMinutes(DEFAULT_WEEKLY_INTERVAL.end),
      };

  const weeklyDigest = {
    enabled: rawWeeklyDigest?.enabled === undefined
      ? Boolean(fallbackWeeklyDigest.enabled)
      : rawWeeklyDigest.enabled !== false,
    dayOfWeek: Number.isInteger(rawWeeklyDigest?.dayOfWeek)
      ? rawWeeklyDigest.dayOfWeek
      : (Number.isInteger(fallbackWeeklyDigest.dayOfWeek) ? fallbackWeeklyDigest.dayOfWeek : 0),
    interval: weeklyInterval,
  };

  const rawCheckInterval = Number(schedule.channelChecksIntervalMinutes);
  const fallbackCheckInterval = Number(fallbackSchedule.channelChecksIntervalMinutes) || config.schedule.checkIntervalMinutes;

  return {
    timezone: String(schedule.timezone || fallbackSchedule.timezone || config.schedule.timezone || 'Europe/Moscow').trim(),
    postIntervals: postIntervals.length > 0 ? postIntervals : fallbackIntervals.map((interval, index) => ({
      start: normalizeTimeValue(interval.start, '09:00'),
      end: normalizeTimeValue(interval.end, '09:15'),
      startMinutes: parseTimeToMinutes(normalizeTimeValue(interval.start, '09:00')),
      endMinutes: parseTimeToMinutes(normalizeTimeValue(interval.end, '09:15')),
      label: String(interval.label || `slot_${index + 1}`).trim(),
    })),
    weeklyDigest: {
      ...weeklyDigest,
      dayOfWeek: Math.min(6, Math.max(0, Number(weeklyDigest.dayOfWeek) || 0)),
    },
    channelChecksIntervalMinutes: Math.max(
      1,
      Number.isFinite(rawCheckInterval) && rawCheckInterval > 0 ? rawCheckInterval : fallbackCheckInterval,
    ),
  };
}

function resolvePathMaybe(filePath, baseDir = config.paths.root) {
  if (!filePath) return '';
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(baseDir, filePath);
}

function readJsonFileSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    logger.warn(`channelProfiles: failed to read ${filePath}: ${err.message}`);
    return null;
  }
}

function fileExists(filePath) {
  try {
    return Boolean(filePath) && fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function listProfileEntries(rootDir, diagnostics = []) {
  if (!fileExists(rootDir)) {
    diagnostics.push(`profiles root not found: ${rootDir}`);
    return [];
  }

  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    diagnostics.push(`failed to read profiles root ${rootDir}: ${err.message}`);
    return [];
  }

  const result = [];

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    const isDirectory = entry.isDirectory();
    const isSymlink = entry.isSymbolicLink();

    if (isDirectory) {
      diagnostics.push(`profiles entry "${entry.name}": directory`);
      result.push({ name: entry.name, path: entryPath, kind: 'directory' });
      continue;
    }

    if (isSymlink) {
      try {
        const stat = fs.statSync(entryPath);
        if (stat.isDirectory()) {
          diagnostics.push(`profiles entry "${entry.name}": symlink-directory`);
          result.push({ name: entry.name, path: entryPath, kind: 'symlink-directory' });
          continue;
        }
        diagnostics.push(`profiles entry "${entry.name}": symlink-non-directory skipped`);
      } catch (err) {
        diagnostics.push(`profiles entry "${entry.name}": broken symlink skipped (${err.message})`);
      }
      continue;
    }

    diagnostics.push(`profiles entry "${entry.name}": non-directory skipped`);
  }

  return result;
}

function loadSourceChannelsFromPath(filePath, baseDir = config.paths.root) {
  if (!filePath) return [];
  const resolvedPath = resolvePathMaybe(filePath, baseDir);
  const parsed = readJsonFileSafe(resolvedPath);
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.channels)) return parsed.channels;
  return [];
}

function loadWebSourcesConfig(filePath, baseDir = config.paths.root) {
  if (!filePath) return { path: '', names: [...DEFAULT_WEB_SOURCES] };
  const resolvedPath = resolvePathMaybe(filePath, baseDir);
  const parsed = readJsonFileSafe(resolvedPath);
  if (!parsed) {
    return { path: resolvedPath, names: [...DEFAULT_WEB_SOURCES] };
  }

  if (Array.isArray(parsed)) {
    return {
      path: resolvedPath,
      names: parsed.map((item) => String(item).trim()).filter(Boolean),
    };
  }

  if (Array.isArray(parsed.apis)) {
    return {
      path: resolvedPath,
      names: parsed.apis
        .map((api) => String(api?.name || '').trim())
        .filter(Boolean),
    };
  }

  if (Array.isArray(parsed.sources)) {
    return {
      path: resolvedPath,
      names: parsed.sources.map((item) => String(item).trim()).filter(Boolean),
    };
  }

  return { path: resolvedPath, names: [...DEFAULT_WEB_SOURCES] };
}

function createDefaultProfile() {
  const defaultDir = path.join(PROFILES_ROOT, 'default');
  const hasDefaultDir = fileExists(defaultDir);
  const defaultWebConfig = hasDefaultDir
    ? loadWebSourcesConfig(path.join(defaultDir, 'web_sources.json'))
    : { path: path.join(config.paths.data, 'web_sources.json'), names: [...DEFAULT_WEB_SOURCES] };

  return {
    id: 'default',
    title: 'Default channel',
    telegramChannelId: config.telegram.channelId || '',
    rulesPath: hasDefaultDir ? path.join(defaultDir, 'POST_RULES.md') : path.join(config.paths.rules, 'POST_RULES.md'),
    templatesPath: hasDefaultDir ? path.join(defaultDir, 'TEMPLATES.md') : path.join(config.paths.rules, 'TEMPLATES.md'),
    humanizerPath: hasDefaultDir ? path.join(defaultDir, 'HUMANIZER_RULES.md') : path.join(config.paths.root, 'src', 'generator', 'HUMANIZER_RULES.md'),
    sourceChannelsPath: hasDefaultDir ? path.join(defaultDir, 'channels.json') : path.join(config.paths.data, 'channels.json'),
    sourceChannels: hasDefaultDir
      ? loadSourceChannelsFromPath(path.join(defaultDir, 'channels.json'))
      : loadSourceChannelsFromPath(path.join(config.paths.data, 'channels.json')),
    webSourcesPath: defaultWebConfig.path,
    webSources: defaultWebConfig.names.length > 0 ? defaultWebConfig.names : [...DEFAULT_WEB_SOURCES],
    baseDir: hasDefaultDir ? defaultDir : config.paths.root,
    schedule: createLegacyScheduleFallback(),
  };
}

function normalizeProfile(rawProfile, baseDir = config.paths.root) {
  if (!rawProfile || typeof rawProfile !== 'object') return null;

  const profileDir = resolvePathMaybe(rawProfile.base_dir || '.', baseDir);
  const profileId = String(rawProfile.id || '').trim();
  if (!profileId) return null;

  const rulesPath = resolvePathMaybe(
    rawProfile.rules_path || (fileExists(path.join(profileDir, 'POST_RULES.md')) ? 'POST_RULES.md' : ''),
    profileDir,
  );
  const templatesPath = resolvePathMaybe(
    rawProfile.templates_path || (fileExists(path.join(profileDir, 'TEMPLATES.md')) ? 'TEMPLATES.md' : ''),
    profileDir,
  );
  const humanizerPath = resolvePathMaybe(
    rawProfile.humanizer_path || (fileExists(path.join(profileDir, 'HUMANIZER_RULES.md')) ? 'HUMANIZER_RULES.md' : ''),
    profileDir,
  );
  const sourceChannelsPath = resolvePathMaybe(
    rawProfile.source_channels_path || (fileExists(path.join(profileDir, 'channels.json')) ? 'channels.json' : ''),
    profileDir,
  );
  const webSourcesPath = resolvePathMaybe(
    rawProfile.web_sources_path || (fileExists(path.join(profileDir, 'web_sources.json')) ? 'web_sources.json' : ''),
    profileDir,
  );

  const sourceChannels = Array.isArray(rawProfile.source_channels)
    ? rawProfile.source_channels
    : loadSourceChannelsFromPath(sourceChannelsPath, profileDir);

  const webConfig = Array.isArray(rawProfile.web_sources) && rawProfile.web_sources.length > 0
    ? {
        path: webSourcesPath,
        names: rawProfile.web_sources.map((item) => String(item).trim()).filter(Boolean),
      }
    : loadWebSourcesConfig(webSourcesPath, profileDir);

  const profile = {
    id: profileId,
    title: String(rawProfile.title || profileId).trim(),
    telegramChannelId: String(rawProfile.telegram_channel_id || '').trim(),
    rulesPath,
    templatesPath,
    humanizerPath,
    sourceChannelsPath,
    sourceChannels,
    webSourcesPath: webConfig.path,
    webSources: webConfig.names.length > 0 ? webConfig.names : [...DEFAULT_WEB_SOURCES],
    baseDir: profileDir,
    schedule: normalizeSchedule(rawProfile.schedule, createLegacyScheduleFallback()),
  };

  if (!profile.telegramChannelId && profile.id === 'default') {
    profile.telegramChannelId = config.telegram.channelId || '';
  }

  return profile;
}

function loadProfilesFromDirectories(diagnostics = []) {
  return listProfileEntries(PROFILES_ROOT, diagnostics)
    .map((entry) => {
      const profileDir = entry.path;
      const profileFile = path.join(profileDir, 'profile.json');
      if (!fileExists(profileFile)) {
        diagnostics.push(`skipped "${entry.name}": missing profile.json at ${profileFile}`);
        return null;
      }
      const rawProfile = readJsonFileSafe(profileFile);
      if (!rawProfile) {
        diagnostics.push(`skipped "${entry.name}": failed to read ${profileFile}`);
        return null;
      }
      const normalized = normalizeProfile(rawProfile, profileDir);
      if (!normalized) {
        diagnostics.push(`skipped "${entry.name}": invalid profile.json contents`);
        return null;
      }
      diagnostics.push(`loaded profile "${normalized.id}" from ${profileDir}`);
      return normalized;
    })
    .filter(Boolean);
}

function loadProfilesFromLegacyFile(diagnostics = []) {
  if (!fileExists(LEGACY_PROFILES_FILE)) {
    diagnostics.push(`legacy profiles file not found: ${LEGACY_PROFILES_FILE}`);
    return [];
  }

  const parsed = readJsonFileSafe(LEGACY_PROFILES_FILE);
  if (!parsed) {
    diagnostics.push(`failed to read legacy profiles file: ${LEGACY_PROFILES_FILE}`);
    return [];
  }

  const rawProfiles = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(parsed.profiles) ? parsed.profiles : []);

  return rawProfiles
    .map((profile, index) => {
      const normalized = normalizeProfile(profile, config.paths.root);
      if (!normalized) {
        diagnostics.push(`skipped legacy profile at index ${index}: invalid data`);
        return null;
      }
      diagnostics.push(`loaded legacy profile "${normalized.id}" from ${LEGACY_PROFILES_FILE}`);
      return normalized;
    })
    .filter(Boolean);
}

function getChannelProfiles() {
  const defaultProfile = createDefaultProfile();
  const directoryProfiles = loadProfilesFromDirectories();
  const legacyProfiles = directoryProfiles.length > 0 ? [] : loadProfilesFromLegacyFile();
  const profiles = new Map();

  if (directoryProfiles.length === 0 && legacyProfiles.length === 0) {
    profiles.set(defaultProfile.id, defaultProfile);
  }

  for (const profile of [...directoryProfiles, ...legacyProfiles]) {
    profiles.set(profile.id, {
      ...defaultProfile,
      ...profile,
      sourceChannels: Array.isArray(profile.sourceChannels) && profile.sourceChannels.length > 0
        ? profile.sourceChannels
        : defaultProfile.sourceChannels,
      webSources: Array.isArray(profile.webSources) && profile.webSources.length > 0
        ? profile.webSources
        : defaultProfile.webSources,
      webSourcesPath: profile.webSourcesPath || defaultProfile.webSourcesPath,
      sourceChannelsPath: profile.sourceChannelsPath || defaultProfile.sourceChannelsPath,
    });
  }

  return Array.from(profiles.values());
}

function logChannelProfilesStartup(force = false) {
  if (startupProfilesLogged && !force) {
    return;
  }

  startupProfilesLogged = true;
  const diagnostics = [];
  const profilesRootExists = fileExists(PROFILES_ROOT);
  const directoryProfiles = loadProfilesFromDirectories(diagnostics);
  const legacyProfiles = directoryProfiles.length > 0 ? [] : loadProfilesFromLegacyFile(diagnostics);
  const profiles = getChannelProfiles();

  logger.info(`channelProfiles: root=${PROFILES_ROOT} exists=${profilesRootExists}`);

  for (const line of diagnostics) {
    logger.info(`channelProfiles: ${line}`);
  }

  if (profiles.length === 0) {
    logger.warn('channelProfiles: no profiles available after loading');
    return;
  }

  logger.info(`channelProfiles: active profiles (${profiles.length})`);
  for (const profile of profiles) {
      logger.info(
      `channelProfiles: ${profile.id} title="${profile.title}" target=${profile.telegramChannelId || 'not set'} source=${profile.baseDir || 'unknown'} intervals=${profile.schedule?.postIntervals?.length || 0} tz=${profile.schedule?.timezone || 'n/a'}`
    );
  }

  if (directoryProfiles.length === 0 && legacyProfiles.length === 0) {
    logger.warn('channelProfiles: no custom profiles found, using default fallback profile');
  }
}

function getChannelProfile(profileId) {
  const profiles = getChannelProfiles();
  if (!profileId) return profiles[0] || null;
  return profiles.find((profile) => profile.id === profileId) || null;
}

module.exports = {
  getChannelProfiles,
  getChannelProfile,
  logChannelProfilesStartup,
  createLegacyScheduleFallback,
};
