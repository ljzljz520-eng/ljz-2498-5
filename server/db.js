'use strict';
// SQL 层：sql.js（WASM SQLite）。所有写操作经串行队列，提交后落盘，
// 从而在单进程内提供 SERIALIZABLE 语义并保证服务重启后数据可恢复。
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
const WASM_PATH = path.join(__dirname, 'sql-wasm.wasm');

let db = null;
let chain = Promise.resolve();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('editor','reviewer','admin')),
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rule_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','retired')),
  config TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(name, version)
);
CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  project_code TEXT NOT NULL DEFAULT '',
  project_name TEXT NOT NULL DEFAULT '',
  procurement_scope TEXT NOT NULL DEFAULT '',
  qualifications TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  date_values TEXT NOT NULL DEFAULT '{}',
  rule_set_id INTEGER,
  rule_set_version INTEGER,
  required_slots TEXT NOT NULL DEFAULT '[]',
  planned_publish_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','in_review','published','withdrawn','superseded')),
  kind TEXT NOT NULL DEFAULT 'original' CHECK(kind IN ('original','amendment')),
  chain_id TEXT,
  supersedes_id TEXT,
  current_version INTEGER NOT NULL DEFAULT 0,
  chain_epoch INTEGER NOT NULL DEFAULT 0,
  public_uuid TEXT,
  published_at TEXT,
  published_by TEXT,
  withdrawn_at TEXT,
  withdraw_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notice_versions (
  id TEXT PRIMARY KEY,
  notice_id TEXT NOT NULL REFERENCES notices(id),
  ver INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK(status IN ('draft','submitted','approved','rejected','superseded')),
  submitted_at TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  decision TEXT,
  review_comment TEXT,
  approval_fingerprint TEXT,
  public_uuid TEXT,
  published_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(notice_id, ver)
);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES notice_versions(id),
  reviewer TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approve','reject','comment')),
  comment TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transitions (
  id TEXT PRIMARY KEY,
  notice_id TEXT,
  version_id TEXT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  notice_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  slot TEXT NOT NULL,
  media_type TEXT NOT NULL,
  declared_sha256 TEXT,
  declared_size INTEGER,
  state TEXT NOT NULL CHECK(state IN ('open','completed','aborted')),
  temp_path TEXT NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  attachment_id TEXT,
  last_error TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  notice_id TEXT NOT NULL,
  version_id TEXT,
  slot TEXT NOT NULL,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  object_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','quarantined')),
  replaced_by TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS publications (
  id TEXT PRIMARY KEY,
  notice_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  ver INTEGER NOT NULL,
  rendered_key TEXT NOT NULL,
  manifest_key TEXT NOT NULL,
  attachment_summary TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  rule_set_id INTEGER NOT NULL,
  rule_set_version INTEGER NOT NULL,
  cache_epoch INTEGER NOT NULL,
  published_at TEXT NOT NULL,
  published_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_notice ON notice_versions(notice_id);
CREATE INDEX IF NOT EXISTS idx_reviews_version ON reviews(version_id);
CREATE INDEX IF NOT EXISTS idx_attach_notice ON attachments(notice_id);
CREATE INDEX IF NOT EXISTS idx_sessions_notice ON upload_sessions(notice_id);
CREATE INDEX IF NOT EXISTS idx_pub_notice ON publications(notice_id);
`;

async function init() {
  const SQL = await initSqlJs({ locateFile: () => WASM_PATH });
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new SQL.Database();
  }
  db.run(SCHEMA);
  persist();
  return api();
}

function persist() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, DB_PATH);
}

// 行映射辅助
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function get(sql, params = []) {
  return all(sql, params)[0] || null;
}
function run(sql, params = []) {
  db.run(sql, params);
}

// 串行化写事务：fn 内抛错则回滚本批（sql.js 单连接，BEGIN/COMMIT 包裹）。
function tx(fn) {
  const result = chain.then(async () => {
    db.run('BEGIN IMMEDIATE');
    try {
      const out = await fn();
      db.run('COMMIT');
      persist();
      return out;
    } catch (e) {
      try { db.run('ROLLBACK'); } catch (_) {}
      throw e;
    }
  });
  chain = result.catch(() => {});
  return result;
}

function api() {
  return { all, get, run, tx, persist, raw: () => db };
}

module.exports = { init };
