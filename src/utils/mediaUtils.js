const path = require('path');

function inferMediaTypeFromPath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (['.mp4', '.mov', '.m4v', '.webm'].includes(ext)) {
    return 'video';
  }
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
    return 'photo';
  }
  return 'unknown';
}

function getDocumentAttributes(message) {
  return Array.isArray(message?.document?.attributes)
    ? message.document.attributes
    : [];
}

function getMessageMediaType(message) {
  if (message?.photo) {
    return 'photo';
  }

  if (message?.video) {
    return 'video';
  }

  const mimeType = String(message?.document?.mimeType || '').toLowerCase();
  if (mimeType.startsWith('video/')) {
    return 'video';
  }

  const hasVideoAttribute = getDocumentAttributes(message).some((attribute) => {
    const className = String(attribute?.className || attribute?.constructor?.name || '');
    return className === 'DocumentAttributeVideo';
  });

  return hasVideoAttribute ? 'video' : 'unknown';
}

function getMessageFileExtension(message, mediaType = 'unknown') {
  const mimeType = String(message?.document?.mimeType || '').toLowerCase();
  if (mediaType === 'photo') return '.jpg';
  if (mimeType === 'video/mp4') return '.mp4';
  if (mimeType === 'video/quicktime') return '.mov';
  if (mimeType === 'video/webm') return '.webm';
  if (mediaType === 'video') return '.mp4';
  return '';
}

module.exports = {
  getMessageFileExtension,
  getMessageMediaType,
  inferMediaTypeFromPath,
};
