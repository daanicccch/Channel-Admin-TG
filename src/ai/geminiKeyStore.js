const fs = require('fs');
const path = require('path');

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizeKeys(rawKeys) {
  return [...new Set(
    (Array.isArray(rawKeys) ? rawKeys : [])
      .map((key) => String(key || '').trim())
      .filter(Boolean)
  )];
}

function readGeminiKeyRegistry(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const keys = Array.isArray(parsed) ? parsed : parsed?.keys;
  return normalizeKeys(keys);
}

function writeGeminiKeyRegistry(filePath, keys) {
  ensureParentDir(filePath);
  const normalized = normalizeKeys(keys);
  fs.writeFileSync(filePath, `${JSON.stringify({ keys: normalized }, null, 2)}\n`, 'utf8');
  return normalized;
}

function loadGeminiKeys(filePath, fallbackKeys = []) {
  const keys = readGeminiKeyRegistry(filePath);
  if (keys.length > 0) {
    return keys;
  }

  const normalizedFallback = normalizeKeys(fallbackKeys);
  if (normalizedFallback.length > 0) {
    writeGeminiKeyRegistry(filePath, normalizedFallback);
  }

  return normalizedFallback;
}

function removeGeminiKey(filePath, apiKey) {
  const key = String(apiKey || '').trim();
  if (!key || !filePath || !fs.existsSync(filePath)) {
    return false;
  }

  const currentKeys = readGeminiKeyRegistry(filePath);
  const nextKeys = currentKeys.filter((item) => item !== key);
  if (nextKeys.length === currentKeys.length) {
    return false;
  }

  writeGeminiKeyRegistry(filePath, nextKeys);
  return true;
}

module.exports = {
  loadGeminiKeys,
  readGeminiKeyRegistry,
  removeGeminiKey,
  writeGeminiKeyRegistry,
};
