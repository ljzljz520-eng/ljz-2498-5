'use strict';
// SQL 层：公告版本、审批、评审、发布清单、上传会话、公开页缓存
const Database = require('better-sqlite3');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  config TEXT NOT NULL,          -- JSON: min_notice_days / deadline_timezone / deadline_must_be_workday / holidays / bid_open_after_deadline_minutes / require_qualification_text / required_attachments / review_quorum
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(name, version)
);

CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'original',      -- original | correction(更正公告)
  corrects_announcement_id TEXT,              -- 更正对象
  correction_reason TEXT,
  status TEXT NOT NULL DEFAULT 'draft',       -- draft | in_review | approved | published | withdrawn
  current_version_id INTEGER,
  published_version_id INTEGER,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  project_name TEXT NOT NULL,
  project_code TEXT,
  scope TEXT NOT NULL,                 -- 采购范围
  qualifications TEXT,                 -- 资格要求
  notice_start_date TEXT NOT NULL,     -- 公告开始(带时区时刻的墙钟分量)
  notice_start_time TEXT NOT NULL,
  notice_start_tz TEXT NOT NULL,
  notice_start_at TEXT NOT NULL,       -- 换算后的 UTC 瞬间
  submit_deadline_date TEXT NOT NULL,  -- 投标截止日：纯日期
  submit_deadline_time TEXT NOT NULL,  -- 截止日默认时刻(规则可给默认)
  deadline_tz TEXT NOT NULL,           -- 截止日解释时区
  bid_open_date TEXT,                  -- 开标时刻(可空)
  bid_open_time TEXT,
  bid_open_tz TEXT,
  bid_open_at TEXT,
  rule_id INTEGER NOT NULL,
  rule_version INTEGER NOT NULL,       -- 评审所依据的规则版
  body_hash TEXT NOT NULL,             -- 正文摘要
  attachment_digest TEXT NOT NULL,     -- 附件集摘要
  supersedes_version_id INTEGER,       -- 替代链
  change_reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(announcement_id, version_no)
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  object_key TEXT,
  size INTEGER,
  sha256 TEXT,
  state TEXT NOT NULL DEFAULT 'pending',   -- pending(上传未完成) | sealed(已固定)
  upload_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(version_id, name)
);

CREATE TABLE IF NOT EXISTS attachment_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attachment_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  old_sha256 TEXT,
  new_sha256 TEXT,
  replaced_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256_expected TEXT NOT NULL,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'open',      -- open | finalized | aborted
  object_key TEXT,
  tmp_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id TEXT NOT NULL,
  version_id INTEGER NOT NULL,         -- 评审意见绑定具体版本
  reviewer TEXT NOT NULL,
  role TEXT NOT NULL,                  -- legal | business | finance ...
  decision TEXT NOT NULL,              -- approve | reject | comment
  comment TEXT,
  stale INTEGER NOT NULL DEFAULT 0,    -- 1 = 关联批准需复核(范围/附件已变)
  carried_from_review_id INTEGER,      -- 从上一版本平移而来的批准
  created_at TEXT NOT NULL,
  UNIQUE(version_id, reviewer, role)
);

CREATE TABLE IF NOT EXISTS publish_manifests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id TEXT NOT NULL,
  version_id INTEGER NOT NULL,
  body_hash TEXT NOT NULL,
  attachment_digest TEXT NOT NULL,     -- 附件集摘要(发布时固定)
  rule_id INTEGER NOT NULL,
  rule_version INTEGER NOT NULL,
  attachments TEXT NOT NULL,           -- JSON [{name, sha256, size, object_key}]
  render_object_key TEXT NOT NULL,     -- 渲染结果(正式文件)对象键
  publisher TEXT,
  published_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public_pages (    -- 公开页缓存
  cache_key TEXT PRIMARY KEY,          -- ann:{id} | ann:{id}:v{no}
  html TEXT NOT NULL,
  generated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id TEXT,
  type TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL
);
`;

function openDb(file) {
  const db = new Database(file);
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
