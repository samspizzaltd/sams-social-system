const fs = require('fs');
const path = require('path');

// mysql2 is optional at runtime: if it is missing or the database is
// unreachable, the API must still serve requests with in-memory state.
let mysql = null;
try {
  mysql = require('mysql2/promise');
} catch (err) {
  console.warn('[db] mysql2 not installed - running without persistence');
}

const state = {
  pool: null,
  available: false,
  migrated: false,
  lastError: null
};

function parseUrl(url) {
  // mysql://user:pass@host:port/database
  const m = /^mysql:\/\/([^:]+):(.*)@([^:/]+)(?::(\d+))?\/(.+)$/.exec(url || '');
  if (!m) return null;
  return {
    user: decodeURIComponent(m[1]),
    password: decodeURIComponent(m[2]),
    host: m[3],
    port: m[4] ? Number(m[4]) : 3306,
    database: m[5]
  };
}

async function init() {
  if (!mysql) {
    state.lastError = 'mysql2 module not installed';
    return false;
  }

  const cfg = parseUrl(process.env.DATABASE_URL);
  if (!cfg) {
    state.lastError = 'DATABASE_URL missing or not a mysql:// URL';
    console.warn('[db] ' + state.lastError + ' - running without persistence');
    return false;
  }

  try {
    state.pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: 5000
    });

    const conn = await state.pool.getConnection();
    await conn.ping();
    conn.release();

    state.available = true;
    console.log('[db] connected to ' + cfg.database + '@' + cfg.host);

    await migrate();
    return true;
  } catch (err) {
    state.available = false;
    state.lastError = err.message;
    console.warn('[db] unavailable (' + err.message + ') - running without persistence');
    return false;
  }
}

async function migrate() {
  if (!state.available) return false;

  const schemaPath = path.join(__dirname, '..', '..', '..', 'database', 'schema.mysql.sql');
  if (!fs.existsSync(schemaPath)) {
    console.warn('[db] schema file not found at ' + schemaPath);
    return false;
  }

  const sql = fs.readFileSync(schemaPath, 'utf8');
  // Split on semicolons that end a statement; comments are stripped first.
  const statements = sql
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);

  for (const stmt of statements) {
    try {
      await state.pool.query(stmt);
    } catch (err) {
      console.warn('[db] migration statement failed: ' + err.message);
    }
  }

  state.migrated = true;
  console.log('[db] schema applied (' + statements.length + ' statements)');
  return true;
}

async function query(sql, params) {
  if (!state.available) return null;
  try {
    const [rows] = await state.pool.query(sql, params || []);
    return rows;
  } catch (err) {
    state.lastError = err.message;
    console.warn('[db] query failed: ' + err.message);
    return null;
  }
}

function status() {
  return {
    driver: mysql ? 'mysql2' : 'not installed',
    available: state.available,
    migrated: state.migrated,
    lastError: state.lastError
  };
}

module.exports = { init, migrate, query, status, state };
