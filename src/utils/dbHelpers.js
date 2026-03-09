const { getDb, saveDb } = require('../config');

function queryAll(sql, params = []) {
  const db = getDb();
  const results = db.exec(sql, params);
  if (!results.length) return [];
  const { columns, values } = results[0];
  return values.map(row => Object.fromEntries(columns.map((col, i) => [col, row[i]])));
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

function runSql(sql, params = []) {
  const db = getDb();
  db.run(sql, params);
  saveDb();
}

module.exports = { queryAll, queryOne, runSql };
