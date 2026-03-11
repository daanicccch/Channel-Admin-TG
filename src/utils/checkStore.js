const { queryAll, queryOne, runSql } = require('./dbHelpers');

function getMaxCheckedPostId(profileId, channel) {
  const row = queryOne(
    `
      SELECT MAX(telegram_post_id) AS maxPostId
      FROM channel_checks
      WHERE profile_id = ?
        AND channel = ?
    `,
    [profileId, channel],
  );

  return Number(row?.maxPostId) || null;
}

function getCheckedPostIds(profileId, channel, postIds = []) {
  const normalizedIds = [...new Set((postIds || []).map((id) => Number(id)).filter(Boolean))];
  if (normalizedIds.length === 0) {
    return new Set();
  }

  const placeholders = normalizedIds.map(() => '?').join(',');
  const rows = queryAll(
    `
      SELECT telegram_post_id
      FROM channel_checks
      WHERE profile_id = ?
        AND channel = ?
        AND telegram_post_id IN (${placeholders})
    `,
    [profileId, channel, ...normalizedIds],
  );

  return new Set(rows.map((row) => Number(row.telegram_post_id)).filter(Boolean));
}

function markChannelPostChecked({
  profileId,
  channel,
  telegramPostId,
  sourceDate = null,
  generatedPostId = null,
  status = 'processed',
}) {
  if (!profileId || !channel || !telegramPostId) {
    return false;
  }

  runSql(
    `
      INSERT OR REPLACE INTO channel_checks (
        id,
        profile_id,
        channel,
        telegram_post_id,
        source_date,
        generated_post_id,
        status,
        created_at
      )
      VALUES (
        COALESCE(
          (
            SELECT id
            FROM channel_checks
            WHERE profile_id = ?
              AND channel = ?
              AND telegram_post_id = ?
            LIMIT 1
          ),
          NULL
        ),
        ?, ?, ?, ?, ?, ?, datetime('now')
      )
    `,
    [
      profileId,
      channel,
      Number(telegramPostId),
      profileId,
      channel,
      Number(telegramPostId),
      sourceDate,
      generatedPostId,
      status,
    ],
  );

  return true;
}

module.exports = {
  getCheckedPostIds,
  getMaxCheckedPostId,
  markChannelPostChecked,
};
