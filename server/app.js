'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { openDb } = require('./db');
const { ObjectStore, sha256hex } = require('./store');
const { wallToInstant } = require('./tz');
const { validityOf, computeConflicts, quorumStatus } = require('./rules');
const { renderOfficialHtml, renderPublicAnnouncementPage, renderPublicVersionPage } = require('./render');

const nowIso = () => new Date().toISOString();

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}
const err = (s, c, m, d) => new HttpError(s, c, m, d);

// ---------- 通用辅助 ----------
function userOf(req) {
  return {
    name: req.get('x-user') || 'anonymous',
    roles: (req.get('x-roles') || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}
function requireRole(...roles) {
  return (req, _res, next) => {
    const u = userOf(req);
    if (!roles.some((r) => u.roles.includes(r) || u.roles.includes('admin'))) {
      return next(err(403, 'FORBIDDEN', `需要角色 ${roles.join('/')}（当前用户 ${u.name}，角色：${u.roles.join(',') || '无'}）`));
    }
    req.user = u;
    next();
  };
}

// 正文摘要：字段固定顺序，含规则版（规则版变化则摘要变化）
function canonBody(v) {
  return {
    project_name: v.project_name, project_code: v.project_code || '',
    scope: v.scope, qualifications: v.qualifications || '',
    notice_start: { date: v.notice_start_date, time: v.notice_start_time, tz: v.notice_start_tz },
    submit_deadline: { date: v.submit_deadline_date, time: v.submit_deadline_time, tz: v.deadline_tz },
    bid_open: v.bid_open_date ? { date: v.bid_open_date, time: v.bid_open_time, tz: v.bid_open_tz } : null,
    rule_id: v.rule_id, rule_version: v.rule_version,
  };
}
const bodyHashOf = (v) => sha256hex(JSON.stringify(canonBody(v)));

function attachmentDigestOf(db, versionId) {
  const rows = db.prepare('SELECT name, sha256, state FROM attachments WHERE version_id=? ORDER BY name').all(versionId);
  const s = rows.map((r) => `${r.name}:${r.state === 'sealed' ? r.sha256 : 'INCOMPLETE'}`).join('\n');
  return sha256hex(s);
}

function logEvent(db, annId, type, payload) {
  db.prepare('INSERT INTO events(announcement_id,type,payload,created_at) VALUES(?,?,?,?)')
    .run(annId, type, JSON.stringify(payload || {}), nowIso());
}

function getAnn(db, id) {
  const a = db.prepare(`
    SELECT a.*, pv.version_no AS published_version_no, cv.version_no AS current_version_no
    FROM announcements a
    LEFT JOIN versions pv ON pv.id = a.published_version_id
    LEFT JOIN versions cv ON cv.id = a.current_version_id
    WHERE a.id = ?`).get(id);
  if (!a) throw err(404, 'NOT_FOUND', `公告 ${id} 不存在`);
  return a;
}
function getVersion(db, id) {
  return db.prepare(`
    SELECT v.*, r.name AS rule_name FROM versions v JOIN rules r ON r.id=v.rule_id WHERE v.id=?`).get(id);
}
function getVersionByNo(db, annId, no) {
  return db.prepare(`
    SELECT v.*, r.name AS rule_name FROM versions v JOIN rules r ON r.id=v.rule_id
    WHERE v.announcement_id=? AND v.version_no=?`).get(annId, no);
}
function getAtts(db, versionId) {
  return db.prepare('SELECT * FROM attachments WHERE version_id=? ORDER BY name').all(versionId);
}
function activeRuleByName(db, name) {
  return db.prepare('SELECT * FROM rules WHERE name=? ORDER BY version DESC LIMIT 1').get(name);
}

// 版本是否可编辑（正文/附件）：当前版本 且 未发布过该版 且 公告处于可编辑状态
function assertVersionEditable(ann, ver) {
  if (ver.id !== ann.current_version_id) throw err(409, 'NOT_CURRENT_VERSION', '只能编辑当前版本，请先基于它创建新版本');
  if (ver.id === ann.published_version_id) throw err(409, 'VERSION_LOCKED', '该版本已发布，内容已固定；请创建新版本再修改');
  if (!['draft', 'published'].includes(ann.status)) {
    throw err(409, 'STATE_NOT_EDITABLE', `公告状态 ${ann.status} 下不可编辑（评审中请先撤回）`);
  }
}

// 范围或附件变化 → 关联批准需复核
function staleApprovals(db, versionId, reason) {
  const n = db.prepare(`UPDATE reviews SET stale=1 WHERE version_id=? AND decision='approve' AND stale=0`).run(versionId).changes;
  if (n > 0) logEvent(db, null, 'approvals_staled', { version_id: versionId, count: n, reason });
  return n;
}

function invalidatePublic(db, annId) {
  db.prepare(`DELETE FROM public_pages WHERE cache_key=? OR cache_key LIKE ?`).run(`ann:${annId}`, `ann:${annId}:%`);
  // 更正公告影响原公告页面
  const orig = db.prepare('SELECT corrects_announcement_id FROM announcements WHERE id=?').get(annId);
  if (orig && orig.corrects_announcement_id) {
    db.prepare(`DELETE FROM public_pages WHERE cache_key=? OR cache_key LIKE ?`)
      .run(`ann:${orig.corrects_announcement_id}`, `ann:${orig.corrects_announcement_id}:%`);
  }
  // 原公告被更正时，也失效原公告缓存
  const corr = db.prepare('SELECT id FROM announcements WHERE corrects_announcement_id=?').all(annId);
  for (const c of corr) {
    db.prepare(`DELETE FROM public_pages WHERE cache_key=? OR cache_key LIKE ?`).run(`ann:${c.id}`, `ann:${c.id}:%`);
  }
}

// ---------- 版本行构建 ----------
function buildVersionRow(db, ann, input, user, prev) {
  const pick = (key, prevVal) => (input[key] !== undefined ? input[key] : prevVal);
  const m = {
    project_name: pick('project_name', prev && prev.project_name),
    project_code: pick('project_code', prev && prev.project_code),
    scope: pick('scope', prev && prev.scope),
    qualifications: pick('qualifications', prev && prev.qualifications),
    notice_start: pick('notice_start', prev && { date: prev.notice_start_date, time: prev.notice_start_time, tz: prev.notice_start_tz }),
    submit_deadline: pick('submit_deadline', prev && { date: prev.submit_deadline_date, time: prev.submit_deadline_time, tz: prev.deadline_tz }),
    bid_open: pick('bid_open', prev && prev.bid_open_date ? { date: prev.bid_open_date, time: prev.bid_open_time, tz: prev.bid_open_tz } : null),
    rule_name: pick('rule_name', prev && prev.rule_name),
  };
  for (const k of ['project_name', 'scope']) {
    if (!m[k] || !String(m[k]).trim()) throw err(400, 'MISSING_FIELD', `缺少必填字段 ${k}`);
  }
  if (!m.notice_start || !m.submit_deadline) throw err(400, 'MISSING_FIELD', '缺少公告开始或投标截止');
  const rule = activeRuleByName(db, m.rule_name || 'default');
  if (!rule) throw err(400, 'RULE_NOT_FOUND', `公告规则「${m.rule_name || 'default'}」不存在，请先在规则配置中创建`);

  let nsAt, boAt = null;
  try { nsAt = wallToInstant(m.notice_start.date, m.notice_start.time, m.notice_start.tz); }
  catch (e) { throw err(400, 'BAD_DATE', `公告开始时间无效：${e.message}`); }
  try { wallToInstant(m.submit_deadline.date, m.submit_deadline.time, m.submit_deadline.tz); }
  catch (e) { throw err(400, 'BAD_DATE', `投标截止无效：${e.message}`); }
  if (m.bid_open) {
    try { boAt = wallToInstant(m.bid_open.date, m.bid_open.time, m.bid_open.tz); }
    catch (e) { throw err(400, 'BAD_DATE', `开标时间无效：${e.message}`); }
  }

  const row = {
    project_name: m.project_name, project_code: m.project_code || null,
    scope: m.scope, qualifications: m.qualifications || null,
    notice_start_date: m.notice_start.date, notice_start_time: m.notice_start.time, notice_start_tz: m.notice_start.tz,
    notice_start_at: nsAt.toISOString(),
    submit_deadline_date: m.submit_deadline.date, submit_deadline_time: m.submit_deadline.time, deadline_tz: m.submit_deadline.tz,
    bid_open_date: m.bid_open ? m.bid_open.date : null,
    bid_open_time: m.bid_open ? m.bid_open.time : null,
    bid_open_tz: m.bid_open ? m.bid_open.tz : null,
    bid_open_at: boAt ? boAt.toISOString() : null,
    rule_id: rule.id, rule_version: rule.version,
    change_reason: input.change_reason || null,
    created_by: user.name,
  };
  row.body_hash = bodyHashOf(row);
  return row;
}

// ---------- 应用工厂 ----------
function createApp({ dataDir }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openDb(path.join(dataDir, 'app.db'));
  const store = new ObjectStore(path.join(dataDir, 'objects'));
  const tmpDir = path.join(dataDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ===== 规则配置（用户配置的公告规则）=====
  app.post('/api/rules', requireRole('admin'), (req, res) => {
    const { name, config } = req.body || {};
    if (!name || !config || typeof config !== 'object') throw err(400, 'BAD_RULE', '需要 name 与 config 对象');
    const prev = activeRuleByName(db, name);
    const version = prev ? prev.version + 1 : 1;
    const info = db.prepare('INSERT INTO rules(name,version,config,created_by,created_at) VALUES(?,?,?,?,?)')
      .run(name, version, JSON.stringify({ name, ...config }), req.user.name, nowIso());
    res.status(201).json({ id: info.lastInsertRowid, name, version, config });
  });
  app.get('/api/rules', (_req, res) => {
    res.json(db.prepare('SELECT * FROM rules ORDER BY name, version').all()
      .map((r) => ({ ...r, config: JSON.parse(r.config) })));
  });
  app.get('/api/rules/:name/active', (req, res) => {
    const r = activeRuleByName(db, req.params.name);
    if (!r) throw err(404, 'RULE_NOT_FOUND', '规则不存在');
    res.json({ ...r, config: JSON.parse(r.config) });
  });

  // ===== 公告 =====
  app.post('/api/announcements', requireRole('editor'), (req, res) => {
    const { title, version } = req.body || {};
    if (!title || !version) throw err(400, 'BAD_REQUEST', '需要 title 与 version');
    const result = db.transaction(() => {
      const year = new Date().getFullYear();
      const key = `ann:${year}`;
      db.prepare('INSERT INTO counters(key,value) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET value=value+1').run(key);
      const seq = db.prepare('SELECT value FROM counters WHERE key=?').get(key).value;
      const id = `ANN-${year}-${String(seq).padStart(4, '0')}`;
      const now = nowIso();
      db.prepare(`INSERT INTO announcements(id,title,kind,status,created_by,created_at,updated_at)
                  VALUES(?,?, 'original','draft',?,?,?)`).run(id, title, req.user.name, now, now);
      const ann = { id };
      const row = buildVersionRow(db, ann, version, req.user, null);
      const info = db.prepare(`INSERT INTO versions(announcement_id,version_no,project_name,project_code,scope,qualifications,
        notice_start_date,notice_start_time,notice_start_tz,notice_start_at,
        submit_deadline_date,submit_deadline_time,deadline_tz,
        bid_open_date,bid_open_time,bid_open_tz,bid_open_at,
        rule_id,rule_version,body_hash,attachment_digest,supersedes_version_id,change_reason,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, 1, row.project_name, row.project_code, row.scope, row.qualifications,
          row.notice_start_date, row.notice_start_time, row.notice_start_tz, row.notice_start_at,
          row.submit_deadline_date, row.submit_deadline_time, row.deadline_tz,
          row.bid_open_date, row.bid_open_time, row.bid_open_tz, row.bid_open_at,
          row.rule_id, row.rule_version, row.body_hash, attachmentDigestOf(db, -1), null,
          row.change_reason, row.created_by, now);
      db.prepare('UPDATE announcements SET current_version_id=? WHERE id=?').run(info.lastInsertRowid, id);
      logEvent(db, id, 'created', { title });
      return { id, version_id: info.lastInsertRowid };
    })();
    res.status(201).json(result);
  });

  app.get('/api/announcements', (_req, res) => {
    const rows = db.prepare(`
      SELECT a.*, pv.version_no AS published_version_no, cv.version_no AS current_version_no
      FROM announcements a
      LEFT JOIN versions pv ON pv.id=a.published_version_id
      LEFT JOIN versions cv ON cv.id=a.current_version_id
      ORDER BY a.created_at DESC`).all();
    res.json(rows.map((a) => ({ ...a, validity: validityOf(a, a.published_version_no) })));
  });

  app.get('/api/announcements/:id', (req, res) => {
    const ann = getAnn(db, req.params.id);
    const versions = db.prepare(`SELECT v.*, r.name AS rule_name FROM versions v JOIN rules r ON r.id=v.rule_id
      WHERE v.announcement_id=? ORDER BY v.version_no`).all(ann.id)
      .map((v) => ({
        ...v,
        validity: validityOf(ann, v.version_no),
        attachments: getAtts(db, v.id),
        reviews: db.prepare('SELECT * FROM reviews WHERE version_id=? ORDER BY created_at').all(v.id),
      }));
    const corrections = db.prepare('SELECT id,title,status,correction_reason FROM announcements WHERE corrects_announcement_id=?').all(ann.id);
    const correctedBy = ann.corrects_announcement_id
      ? db.prepare('SELECT id,title,status FROM announcements WHERE id=?').get(ann.corrects_announcement_id) : null;
    const manifest = ann.published_version_id
      ? db.prepare('SELECT * FROM publish_manifests WHERE version_id=? ORDER BY id DESC LIMIT 1').get(ann.published_version_id) : null;
    const events = db.prepare('SELECT * FROM events WHERE announcement_id=? ORDER BY id').all(ann.id);
    res.json({ announcement: ann, versions, corrections, corrected_by: correctedBy, manifest, events });
  });

  // 新版本（改采购范围/替换附件 → 关联批准需复核）
  app.post('/api/announcements/:id/versions', requireRole('editor'), (req, res) => {
    const ann = getAnn(db, req.params.id);
    if (ann.status === 'withdrawn') {
      throw err(409, 'STATE_NOT_EDITABLE', '已撤回公告不能新建版本');
    }
    const result = db.transaction(() => {
      const prev = getVersion(db, ann.current_version_id);
      const row = buildVersionRow(db, ann, req.body || {}, req.user, prev);
      const now = nowIso();
      const info = db.prepare(`INSERT INTO versions(announcement_id,version_no,project_name,project_code,scope,qualifications,
        notice_start_date,notice_start_time,notice_start_tz,notice_start_at,
        submit_deadline_date,submit_deadline_time,deadline_tz,
        bid_open_date,bid_open_time,bid_open_tz,bid_open_at,
        rule_id,rule_version,body_hash,attachment_digest,supersedes_version_id,change_reason,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(ann.id, prev.version_no + 1, row.project_name, row.project_code, row.scope, row.qualifications,
          row.notice_start_date, row.notice_start_time, row.notice_start_tz, row.notice_start_at,
          row.submit_deadline_date, row.submit_deadline_time, row.deadline_tz,
          row.bid_open_date, row.bid_open_time, row.bid_open_tz, row.bid_open_at,
          row.rule_id, row.rule_version, row.body_hash, prev.attachment_digest, prev.id,
          row.change_reason, row.created_by, now);
      const newVid = info.lastInsertRowid;
      // 复制附件（固定对象引用，同名替换发生在新版本上）
      db.prepare(`INSERT INTO attachments(version_id,name,object_key,size,sha256,state,upload_session_id,created_at,updated_at)
                  SELECT ?,name,object_key,size,sha256,state,upload_session_id,?,? FROM attachments WHERE version_id=?`)
        .run(newVid, now, now, prev.id);
      const digest = attachmentDigestOf(db, newVid);
      db.prepare('UPDATE versions SET attachment_digest=? WHERE id=?').run(digest, newVid);
      // 批准平移或失效
      const scopeChanged = row.scope !== prev.scope;
      const digestChanged = digest !== prev.attachment_digest;
      let carried = 0, staled = 0;
      if (!scopeChanged && !digestChanged) {
        const approvals = db.prepare(`SELECT * FROM reviews WHERE version_id=? AND decision='approve' AND stale=0`).all(prev.id);
        for (const r of approvals) {
          db.prepare(`INSERT INTO reviews(announcement_id,version_id,reviewer,role,decision,comment,stale,carried_from_review_id,created_at)
                      VALUES(?,?,?,?,?,?,0,?,?)`)
            .run(ann.id, newVid, r.reviewer, r.role, 'approve', r.comment, r.id, now);
          carried++;
        }
      } else {
        staled = staleApprovals(db, prev.id, scopeChanged ? '采购范围变更' : '附件集变更');
      }
      // 评审中/已批准状态下建版本 → 状态回退（评审意见绑定旧版本，不会误用于新版本）
      const bounce = ['in_review', 'approved'].includes(ann.status)
        ? (ann.published_version_id ? 'published' : 'draft') : ann.status;
      db.prepare('UPDATE announcements SET current_version_id=?, status=?, updated_at=? WHERE id=?')
        .run(newVid, bounce, now, ann.id);
      logEvent(db, ann.id, 'version_created', {
        version_no: prev.version_no + 1, supersedes: prev.version_no,
        scope_changed: scopeChanged, digest_changed: digestChanged, approvals_carried: carried, approvals_staled: staled,
      });
      return { version_id: newVid, version_no: prev.version_no + 1, approvals_carried: carried, approvals_staled: staled };
    })();
    res.status(201).json(result);
  });

  // 编辑当前草稿版本（就地更新，重算摘要；范围变化→批准需复核）
  app.put('/api/versions/:vid', requireRole('editor'), (req, res) => {
    const ver = getVersion(db, Number(req.params.vid));
    if (!ver) throw err(404, 'NOT_FOUND', '版本不存在');
    const ann = getAnn(db, ver.announcement_id);
    assertVersionEditable(ann, ver);
    const result = db.transaction(() => {
      const row = buildVersionRow(db, ann, req.body || {}, req.user, ver);
      const scopeChanged = row.scope !== ver.scope;
      db.prepare(`UPDATE versions SET project_name=?,project_code=?,scope=?,qualifications=?,
        notice_start_date=?,notice_start_time=?,notice_start_tz=?,notice_start_at=?,
        submit_deadline_date=?,submit_deadline_time=?,deadline_tz=?,
        bid_open_date=?,bid_open_time=?,bid_open_tz=?,bid_open_at=?,
        rule_id=?,rule_version=?,body_hash=?,change_reason=?,created_by=? WHERE id=?`)
        .run(row.project_name, row.project_code, row.scope, row.qualifications,
          row.notice_start_date, row.notice_start_time, row.notice_start_tz, row.notice_start_at,
          row.submit_deadline_date, row.submit_deadline_time, row.deadline_tz,
          row.bid_open_date, row.bid_open_time, row.bid_open_tz, row.bid_open_at,
          row.rule_id, row.rule_version, row.body_hash, row.change_reason, row.created_by, ver.id);
      let staled = 0;
      if (scopeChanged) staled = staleApprovals(db, ver.id, '采购范围变更');
      logEvent(db, ann.id, 'version_edited', { version_no: ver.version_no, scope_changed: scopeChanged, approvals_staled: staled });
      return { version_id: ver.id, body_hash: row.body_hash, approvals_staled: staled };
    })();
    res.json(result);
  });

  // 预览：跨字段冲突 + 归一化日程 + 评审状态
  app.get('/api/versions/:vid/preview', (req, res) => {
    const ver = getVersion(db, Number(req.params.vid));
    if (!ver) throw err(404, 'NOT_FOUND', '版本不存在');
    const ann = getAnn(db, ver.announcement_id);
    const rule = db.prepare('SELECT * FROM rules WHERE id=?').get(ver.rule_id);
    const cfg = JSON.parse(rule.config);
    const atts = getAtts(db, ver.id);
    const conflicts = computeConflicts(ver, cfg, atts);
    const active = activeRuleByName(db, rule.name);
    if (active.version !== ver.rule_version) {
      conflicts.push({ code: 'RULE_VERSION_STALE', severity: 'warning', fields: ['rule'],
        message: `规则「${rule.name}」已更新到 v${active.version}，本版本依据 v${ver.rule_version} 评审` });
    }
    const reviews = db.prepare('SELECT * FROM reviews WHERE version_id=?').all(ver.id);
    const quorum = quorumStatus(cfg, reviews);
    const deadlineAt = wallToInstant(ver.submit_deadline_date, ver.submit_deadline_time, ver.deadline_tz);
    res.json({
      version_id: ver.id, version_no: ver.version_no,
      conflicts,
      normalized: {
        notice_start_at: ver.notice_start_at,
        submit_deadline_instant: deadlineAt.toISOString(),
        bid_open_at: ver.bid_open_at,
        notice_days: (deadlineAt - new Date(ver.notice_start_at)) / 86400000,
      },
      attachments: atts.map((a) => ({ name: a.name, state: a.state, size: a.size, sha256: a.sha256 })),
      quorum,
      publish_ready: conflicts.every((c) => c.severity !== 'error') && quorum.met
        && atts.every((a) => a.state === 'sealed'),
    });
  });

  // ===== 附件 =====
  app.post('/api/versions/:vid/attachments', requireRole('editor'), (req, res) => {
    const ver = getVersion(db, Number(req.params.vid));
    if (!ver) throw err(404, 'NOT_FOUND', '版本不存在');
    const ann = getAnn(db, ver.announcement_id);
    assertVersionEditable(ann, ver);
    const { name, upload_session_id } = req.body || {};
    if (!name || !upload_session_id) throw err(400, 'BAD_REQUEST', '需要 name 与 upload_session_id');
    const sess = db.prepare('SELECT * FROM upload_sessions WHERE id=?').get(upload_session_id);
    if (!sess) throw err(404, 'UPLOAD_NOT_FOUND', '上传会话不存在');
    if (sess.state !== 'finalized') {
      throw err(409, 'UPLOAD_INCOMPLETE', `附件「${name}」上传未完成（${sess.received_bytes}/${sess.size} 字节），不能关联`);
    }
    const result = db.transaction(() => {
      const now = nowIso();
      const existing = db.prepare('SELECT * FROM attachments WHERE version_id=? AND name=?').get(ver.id, name);
      let replaced = null;
      if (existing) {
        // 同名附件替换：记录替换历史
        db.prepare(`INSERT INTO attachment_revisions(attachment_id,version_id,name,old_sha256,new_sha256,replaced_by,created_at)
                    VALUES(?,?,?,?,?,?,?)`)
          .run(existing.id, ver.id, name, existing.sha256, sess.sha256_expected, req.user.name, now);
        db.prepare(`UPDATE attachments SET object_key=?,size=?,sha256=?,state='sealed',upload_session_id=?,updated_at=? WHERE id=?`)
          .run(sess.object_key, sess.size, sess.sha256_expected, sess.id, now, existing.id);
        replaced = { old_sha256: existing.sha256, new_sha256: sess.sha256_expected };
        logEvent(db, ann.id, 'attachment_replaced', { version_no: ver.version_no, name, ...replaced });
      } else {
        db.prepare(`INSERT INTO attachments(version_id,name,object_key,size,sha256,state,upload_session_id,created_at,updated_at)
                    VALUES(?,?,?,?,?,'sealed',?,?,?)`)
          .run(ver.id, name, sess.object_key, sess.size, sess.sha256_expected, sess.id, now, now);
        logEvent(db, ann.id, 'attachment_added', { version_no: ver.version_no, name, sha256: sess.sha256_expected });
      }
      const digest = attachmentDigestOf(db, ver.id);
      db.prepare('UPDATE versions SET attachment_digest=? WHERE id=?').run(digest, ver.id);
      // 附件集变化 → 关联批准需复核
      let staled = 0;
      if (digest !== ver.attachment_digest) staled = staleApprovals(db, ver.id, replaced ? `同名附件「${name}」被替换` : `附件集变更（新增 ${name}）`);
      return { name, sha256: sess.sha256_expected, replaced, attachment_digest: digest, approvals_staled: staled };
    })();
    res.status(result.replaced ? 200 : 201).json(result);
  });

  app.delete('/api/attachments/:aid', requireRole('editor'), (req, res) => {
    const att = db.prepare('SELECT * FROM attachments WHERE id=?').get(Number(req.params.aid));
    if (!att) throw err(404, 'NOT_FOUND', '附件不存在');
    const ver = getVersion(db, att.version_id);
    const ann = getAnn(db, ver.announcement_id);
    assertVersionEditable(ann, ver);
    const result = db.transaction(() => {
      db.prepare('DELETE FROM attachments WHERE id=?').run(att.id);
      const digest = attachmentDigestOf(db, ver.id);
      db.prepare('UPDATE versions SET attachment_digest=? WHERE id=?').run(digest, ver.id);
      const staled = staleApprovals(db, ver.id, `附件「${att.name}」被移除`);
      logEvent(db, ann.id, 'attachment_removed', { version_no: ver.version_no, name: att.name });
      return { removed: att.name, attachment_digest: digest, approvals_staled: staled };
    })();
    res.json(result);
  });

  // ===== 分片上传（可断点续传，服务重启后可恢复）=====
  app.post('/api/uploads', requireRole('editor'), (req, res) => {
    const { filename, size, sha256 } = req.body || {};
    if (!filename || !Number.isInteger(size) || !/^[0-9a-f]{64}$/.test(sha256 || '')) {
      throw err(400, 'BAD_UPLOAD', '需要 filename、整数 size、64位十六进制 sha256');
    }
    const id = crypto.randomUUID();
    const tmpPath = path.join(tmpDir, id + '.part');
    fs.writeFileSync(tmpPath, Buffer.alloc(0));
    const now = nowIso();
    db.prepare(`INSERT INTO upload_sessions(id,filename,size,sha256_expected,received_bytes,state,tmp_path,created_at,updated_at)
                VALUES(?,?,?,?,0,'open',?,?,?)`).run(id, filename, size, sha256, tmpPath, now, now);
    res.status(201).json({ id, received_bytes: 0, state: 'open' });
  });

  app.get('/api/uploads/:id', (req, res) => {
    const s = db.prepare('SELECT * FROM upload_sessions WHERE id=?').get(req.params.id);
    if (!s) throw err(404, 'UPLOAD_NOT_FOUND', '上传会话不存在');
    res.json({ id: s.id, filename: s.filename, size: s.size, received_bytes: s.received_bytes, state: s.state, object_key: s.object_key });
  });

  app.put('/api/uploads/:id/chunk', express.raw({ type: () => true, limit: '64mb' }), (req, res) => {
    const s = db.prepare('SELECT * FROM upload_sessions WHERE id=?').get(req.params.id);
    if (!s) throw err(404, 'UPLOAD_NOT_FOUND', '上传会话不存在');
    if (s.state !== 'open') throw err(409, 'UPLOAD_CLOSED', `会话状态 ${s.state}，不能继续写入`);
    const offset = Number(req.query.offset);
    if (offset !== s.received_bytes) {
      throw err(409, 'OFFSET_MISMATCH', `续传偏移不符：服务端已收 ${s.received_bytes} 字节，请从该偏移继续`, { received_bytes: s.received_bytes });
    }
    const buf = req.body || Buffer.alloc(0);
    if (s.received_bytes + buf.length > s.size) throw err(400, 'SIZE_EXCEEDED', '超出声明的文件大小');
    const fd = fs.openSync(s.tmp_path, 'a');
    fs.writeSync(fd, buf);
    fs.closeSync(fd);
    db.prepare('UPDATE upload_sessions SET received_bytes=received_bytes+?, updated_at=? WHERE id=?')
      .run(buf.length, nowIso(), s.id);
    res.json({ received_bytes: s.received_bytes + buf.length });
  });

  app.post('/api/uploads/:id/finalize', requireRole('editor'), (req, res) => {
    const s = db.prepare('SELECT * FROM upload_sessions WHERE id=?').get(req.params.id);
    if (!s) throw err(404, 'UPLOAD_NOT_FOUND', '会话不存在');
    if (s.state === 'finalized') return res.json({ id: s.id, state: 'finalized', object_key: s.object_key }); // 幂等
    if (s.state !== 'open') throw err(409, 'UPLOAD_CLOSED', `会话状态 ${s.state}`);
    if (s.received_bytes !== s.size) {
      throw err(409, 'UPLOAD_INCOMPLETE', `上传未完成：${s.received_bytes}/${s.size} 字节`);
    }
    const actual = sha256hex(fs.readFileSync(s.tmp_path));
    if (actual !== s.sha256_expected) {
      throw err(400, 'HASH_MISMATCH', `内容哈希不符：期望 ${s.sha256_expected}，实际 ${actual}`);
    }
    const obj = store.putFile(s.tmp_path, actual);
    db.prepare(`UPDATE upload_sessions SET state='finalized', object_key=?, updated_at=? WHERE id=?`).run(obj.key, nowIso(), s.id);
    res.json({ id: s.id, state: 'finalized', object_key: obj.key, sha256: actual });
  });

  // ===== 状态机：提交评审 / 评审 / 撤回 / 发布 =====
  app.post('/api/announcements/:id/submit', requireRole('editor'), (req, res) => {
    const ann = getAnn(db, req.params.id);
    const { version_no } = req.body || {};
    const ver = getVersionByNo(db, ann.id, version_no ?? ann.current_version_no);
    if (!ver || ver.id !== ann.current_version_id) throw err(409, 'NOT_CURRENT_VERSION', '只能提交当前版本');
    const rule = db.prepare('SELECT * FROM rules WHERE id=?').get(ver.rule_id);
    const conflicts = computeConflicts(ver, JSON.parse(rule.config), getAtts(db, ver.id));
    const errors = conflicts.filter((c) => c.severity === 'error');
    if (errors.length) throw err(409, 'CONFLICTS', '存在跨字段冲突，不能提交评审', { conflicts });
    const r = db.prepare(`UPDATE announcements SET status='in_review', updated_at=? WHERE id=? AND status IN ('draft','published')`)
      .run(nowIso(), ann.id);
    if (r.changes === 0) throw err(409, 'STATE_RACE', `提交失败：公告状态已变为 ${getAnn(db, ann.id).status}`);
    logEvent(db, ann.id, 'submitted', { version_no: ver.version_no });
    res.json({ status: 'in_review', version_no: ver.version_no });
  });

  app.post('/api/announcements/:id/reviews', (req, res, next) => {
    const { role } = req.body || {};
    if (!role) return next(err(400, 'BAD_REQUEST', '需要 role'));
    requireRole(role)(req, res, next);
  }, (req, res) => {
    const ann = getAnn(db, req.params.id);
    const { version_no, role, decision, comment } = req.body || {};
    if (!['approve', 'reject', 'comment'].includes(decision)) throw err(400, 'BAD_DECISION', 'decision 须为 approve/reject/comment');
    const ver = getVersionByNo(db, ann.id, version_no ?? ann.current_version_no);
    if (!ver || ver.id !== ann.current_version_id) throw err(409, 'NOT_CURRENT_VERSION', '评审意见必须绑定当前版本');
    if (ann.status !== 'in_review') throw err(409, 'NOT_IN_REVIEW', `状态 ${ann.status} 下不能评审`);
    const result = db.transaction(() => {
      const now = nowIso();
      db.prepare(`INSERT INTO reviews(announcement_id,version_id,reviewer,role,decision,comment,stale,created_at)
                  VALUES(?,?,?,?,?,?,0,?)
                  ON CONFLICT(version_id,reviewer,role) DO UPDATE SET decision=excluded.decision, comment=excluded.comment, stale=0, created_at=excluded.created_at`)
        .run(ann.id, ver.id, req.user.name, role, decision, comment || null, now);
      logEvent(db, ann.id, 'review', { version_no: ver.version_no, role, decision, reviewer: req.user.name });
      if (decision === 'reject') {
        const back = ann.published_version_id ? 'published' : 'draft';
        db.prepare('UPDATE announcements SET status=?, updated_at=? WHERE id=?').run(back, now, ann.id);
        logEvent(db, ann.id, 'rejected', { version_no: ver.version_no, by: req.user.name });
        return { status: back, quorum: null };
      }
      const rule = db.prepare('SELECT * FROM rules WHERE id=?').get(ver.rule_id);
      const reviews = db.prepare('SELECT * FROM reviews WHERE version_id=?').all(ver.id);
      const quorum = quorumStatus(JSON.parse(rule.config), reviews);
      if (quorum.met) {
        const r = db.prepare(`UPDATE announcements SET status='approved', updated_at=? WHERE id=? AND status='in_review'`)
          .run(now, ann.id);
        if (r.changes === 1) logEvent(db, ann.id, 'approved', { version_no: ver.version_no });
      }
      return { status: getAnn(db, ann.id).status, quorum };
    })();
    res.json(result);
  });

  // 撤回：与审批竞争时只有一方成功（条件更新保证）
  app.post('/api/announcements/:id/withdraw', requireRole('editor', 'publisher'), (req, res) => {
    const ann = getAnn(db, req.params.id);
    const result = db.transaction(() => {
      const r = db.prepare(`UPDATE announcements SET status='withdrawn', updated_at=?
                            WHERE id=? AND status IN ('draft','in_review','approved','published')`)
        .run(nowIso(), ann.id);
      if (r.changes === 0) {
        throw err(409, 'WITHDRAW_RACE_LOST', `撤回失败：公告当前状态 ${getAnn(db, ann.id).status} 不可撤回（可能已被并发变更）`);
      }
      invalidatePublic(db, ann.id);
      logEvent(db, ann.id, 'withdrawn', { by: req.user.name, from: ann.status });
      return { status: 'withdrawn', from: ann.status };
    })();
    res.json(result);
  });

  // 发布：校验正文摘要、附件摘要、规则版一致；不能发布半套附件
  app.post('/api/announcements/:id/publish', requireRole('publisher'), (req, res) => {
    const ann = getAnn(db, req.params.id);
    const { version_no, expected_body_hash, expected_attachment_digest } = req.body || {};
    const manifest = db.transaction(() => {
      const cur = getAnn(db, ann.id);
      if (cur.status !== 'approved') throw err(409, 'NOT_APPROVED', `状态 ${cur.status} 不能发布（须先完成评审批准）`);
      const ver = getVersionByNo(db, cur.id, version_no ?? cur.current_version_no);
      if (!ver || ver.id !== cur.current_version_id) throw err(409, 'NOT_CURRENT_VERSION', '只能发布当前版本');
      // 正文摘要一致
      if (expected_body_hash && expected_body_hash !== ver.body_hash) {
        throw err(409, 'BODY_HASH_MISMATCH', '正文摘要不一致：评审后正文已被修改，需重新评审');
      }
      // 附件摘要一致
      const digest = attachmentDigestOf(db, ver.id);
      if (expected_attachment_digest && expected_attachment_digest !== digest) {
        throw err(409, 'ATTACHMENT_DIGEST_MISMATCH', '附件摘要不一致：评审后附件集已变化，关联批准需复核');
      }
      // 规则版一致
      const rule = db.prepare('SELECT * FROM rules WHERE id=?').get(ver.rule_id);
      const active = activeRuleByName(db, rule.name);
      if (active.version !== ver.rule_version) {
        throw err(409, 'RULE_VERSION_MISMATCH', `规则「${rule.name}」已更新到 v${active.version}，本版本依据 v${ver.rule_version} 评审，发布被阻止`);
      }
      // 半套附件检查
      const atts = getAtts(db, ver.id);
      const bad = atts.filter((a) => a.state !== 'sealed' || !store.exists(a.object_key));
      if (bad.length) throw err(409, 'INCOMPLETE_ATTACHMENTS', `不能发布半套附件：${bad.map((a) => a.name).join('、')} 未固定`);
      // 冲突复检
      const cfg = JSON.parse(rule.config);
      const errors = computeConflicts(ver, cfg, atts).filter((c) => c.severity === 'error');
      if (errors.length) throw err(409, 'CONFLICTS', '存在跨字段冲突，不能发布', { conflicts: errors });
      // 评审定额复检
      const reviews = db.prepare('SELECT * FROM reviews WHERE version_id=?').all(ver.id);
      const quorum = quorumStatus(cfg, reviews);
      if (!quorum.met) throw err(409, 'QUORUM_NOT_MET', '评审批准不足或有关联批准需复核', { quorum });
      // 渲染正式文件（确定性）
      const publishedAt = nowIso();
      const mDraft = {
        announcement_id: cur.id, version_id: ver.id, body_hash: ver.body_hash,
        rule_id: ver.rule_id, rule_version: ver.rule_version,
        attachment_digest: digest, published_at: publishedAt,
      };
      const html = renderOfficialHtml({ ann: cur, ver, ruleName: rule.name, atts, manifest: mDraft });
      const renderObj = store.put(Buffer.from(html, 'utf8'));
      const attList = atts.map((a) => ({ name: a.name, sha256: a.sha256, size: a.size, object_key: a.object_key }));
      const info = db.prepare(`INSERT INTO publish_manifests(announcement_id,version_id,body_hash,attachment_digest,rule_id,rule_version,attachments,render_object_key,publisher,published_at)
                               VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(cur.id, ver.id, ver.body_hash, digest, ver.rule_id, ver.rule_version, JSON.stringify(attList), renderObj.key, req.user.name, publishedAt);
      // 条件更新：与撤回竞争
      const r = db.prepare(`UPDATE announcements SET status='published', published_version_id=?, updated_at=? WHERE id=? AND status='approved'`)
        .run(ver.id, publishedAt, cur.id);
      if (r.changes === 0) throw err(409, 'PUBLISH_RACE_LOST', '发布失败：公告状态已被并发变更（可能已撤回）');
      invalidatePublic(db, cur.id);
      logEvent(db, cur.id, 'published', { version_no: ver.version_no, manifest_id: info.lastInsertRowid, supersedes: cur.published_version_no || null });
      return db.prepare('SELECT * FROM publish_manifests WHERE id=?').get(info.lastInsertRowid);
    })();
    res.status(201).json({ manifest: { ...manifest, attachments: JSON.parse(manifest.attachments) } });
  });

  // 更正公告（追加，而非原地编辑）
  app.post('/api/announcements/:id/corrections', requireRole('editor'), (req, res) => {
    const ann = getAnn(db, req.params.id);
    if (ann.status !== 'published') throw err(409, 'NOT_PUBLISHED', '只有已发布公告才能追加更正公告');
    const { reason } = req.body || {};
    const result = db.transaction(() => {
      const year = new Date().getFullYear();
      const key = `ann:${year}`;
      db.prepare('INSERT INTO counters(key,value) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET value=value+1').run(key);
      const seq = db.prepare('SELECT value FROM counters WHERE key=?').get(key).value;
      const id = `ANN-${year}-${String(seq).padStart(4, '0')}`;
      const now = nowIso();
      const title = `更正公告：${ann.title}`;
      db.prepare(`INSERT INTO announcements(id,title,kind,corrects_announcement_id,correction_reason,status,created_by,created_at,updated_at)
                  VALUES(?,?, 'correction',?,?, 'draft',?,?,?)`)
        .run(id, title, ann.id, reason || null, req.user.name, now, now);
      // 以已发布版本为起点复制内容
      const pub = getVersion(db, ann.published_version_id);
      const row = buildVersionRow(db, { id }, { change_reason: `更正：${reason || ''}` }, req.user, pub);
      const info = db.prepare(`INSERT INTO versions(announcement_id,version_no,project_name,project_code,scope,qualifications,
        notice_start_date,notice_start_time,notice_start_tz,notice_start_at,
        submit_deadline_date,submit_deadline_time,deadline_tz,
        bid_open_date,bid_open_time,bid_open_tz,bid_open_at,
        rule_id,rule_version,body_hash,attachment_digest,supersedes_version_id,change_reason,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, 1, row.project_name, row.project_code, row.scope, row.qualifications,
          row.notice_start_date, row.notice_start_time, row.notice_start_tz, row.notice_start_at,
          row.submit_deadline_date, row.submit_deadline_time, row.deadline_tz,
          row.bid_open_date, row.bid_open_time, row.bid_open_tz, row.bid_open_at,
          row.rule_id, row.rule_version, row.body_hash, pub.attachment_digest, null,
          row.change_reason, row.created_by, now);
      db.prepare(`INSERT INTO attachments(version_id,name,object_key,size,sha256,state,upload_session_id,created_at,updated_at)
                  SELECT ?,name,object_key,size,sha256,state,upload_session_id,?,? FROM attachments WHERE version_id=?`)
        .run(info.lastInsertRowid, now, now, pub.id);
      db.prepare('UPDATE announcements SET current_version_id=? WHERE id=?').run(info.lastInsertRowid, id);
      invalidatePublic(db, ann.id);
      logEvent(db, id, 'correction_created', { corrects: ann.id, reason });
      logEvent(db, ann.id, 'corrected_by', { correction: id, reason });
      return { id, title };
    })();
    res.status(201).json(result);
  });

  // 发布清单
  app.get('/api/announcements/:id/manifest', (req, res) => {
    const ann = getAnn(db, req.params.id);
    const versionNo = req.query.version_no ? Number(req.query.version_no) : ann.published_version_no;
    if (versionNo == null) throw err(404, 'NO_MANIFEST', '该公告尚无发布清单');
    const ver = getVersionByNo(db, ann.id, versionNo);
    const m = db.prepare('SELECT * FROM publish_manifests WHERE version_id=? ORDER BY id DESC LIMIT 1').get(ver && ver.id);
    if (!m) throw err(404, 'NO_MANIFEST', `版本 v${versionNo} 没有发布清单`);
    res.json({ ...m, attachments: JSON.parse(m.attachments) });
  });

  // 按发布清单重建正式文件
  app.post('/api/announcements/:id/rebuild', requireRole('publisher', 'admin'), (req, res) => {
    const ann = getAnn(db, req.params.id);
    const versionNo = req.body && req.body.version_no ? Number(req.body.version_no) : ann.published_version_no;
    const ver = getVersionByNo(db, ann.id, versionNo);
    if (!ver) throw err(404, 'NOT_FOUND', '版本不存在');
    const m = db.prepare('SELECT * FROM publish_manifests WHERE version_id=? ORDER BY id DESC LIMIT 1').get(ver.id);
    if (!m) throw err(404, 'NO_MANIFEST', '该版本没有发布清单，无法重建');
    const checks = [];
    let ok = true;
    // 1. 正文摘要
    const bodyOk = ver.body_hash === m.body_hash;
    checks.push({ item: 'body_hash', ok: bodyOk, expected: m.body_hash, actual: ver.body_hash });
    ok = ok && bodyOk;
    // 2. 附件逐一核对对象库
    const attList = JSON.parse(m.attachments);
    for (const a of attList) {
      const v = store.verify(a.object_key, a.sha256);
      checks.push({ item: `attachment:${a.name}`, ok: v.ok, reason: v.reason || null });
      ok = ok && v.ok;
    }
    // 3. 重新渲染并与清单中的渲染结果比对
    const rule = db.prepare('SELECT * FROM rules WHERE id=?').get(m.rule_id);
    const atts = attList.map((a) => ({ ...a, state: 'sealed' }));
    const html = renderOfficialHtml({ ann, ver, ruleName: rule.name, atts, manifest: m });
    const reRendered = store.put(Buffer.from(html, 'utf8'));
    const renderOk = reRendered.key === m.render_object_key;
    checks.push({ item: 'render', ok: renderOk, expected: m.render_object_key, actual: reRendered.key });
    ok = ok && renderOk;
    logEvent(db, ann.id, 'rebuilt', { version_no: ver.version_no, ok });
    res.json({ ok, version_no: ver.version_no, manifest_id: m.id, render_object_key: m.render_object_key, checks });
  });

  // ===== 公开页（带缓存与失效）=====
  function publicAnnHtml(id) {
    const ann = getAnn(db, id);
    const versions = db.prepare('SELECT * FROM versions WHERE announcement_id=? ORDER BY version_no').all(id)
      .map((v) => ({ ...v, validity: validityOf(ann, v.version_no) }));
    let officialHtml = null;
    if (ann.published_version_id) {
      const m = db.prepare('SELECT * FROM publish_manifests WHERE version_id=? ORDER BY id DESC LIMIT 1').get(ann.published_version_id);
      if (m) officialHtml = (store.get(m.render_object_key) || Buffer.from('')).toString('utf8');
    }
    const corrections = db.prepare(`SELECT id,title,status,correction_reason FROM announcements WHERE corrects_announcement_id=?`).all(id);
    const corrects = ann.corrects_announcement_id
      ? db.prepare('SELECT id,title,status FROM announcements WHERE id=?').get(ann.corrects_announcement_id) : null;
    return renderPublicAnnouncementPage({
      ann, validity: validityOf(ann, ann.published_version_no), officialHtml, versions,
      corrections, corrects,
    });
  }
  function publicVersionHtml(id, no) {
    const ann = getAnn(db, id);
    const ver = getVersionByNo(db, id, no);
    if (!ver) throw err(404, 'NOT_FOUND', '版本不存在');
    const m = db.prepare('SELECT * FROM publish_manifests WHERE version_id=? ORDER BY id DESC LIMIT 1').get(ver.id);
    const officialHtml = m ? (store.get(m.render_object_key) || Buffer.from('')).toString('utf8') : null;
    const prev = db.prepare('SELECT version_no FROM versions WHERE announcement_id=? AND version_no<? ORDER BY version_no DESC LIMIT 1').get(id, no);
    const next = db.prepare('SELECT version_no FROM versions WHERE announcement_id=? AND version_no>? ORDER BY version_no LIMIT 1').get(id, no);
    return renderPublicVersionPage({
      ann, ver, validity: validityOf(ann, no), officialHtml,
      prevNo: prev ? prev.version_no : null, nextNo: next ? next.version_no : null,
      currentPublishedNo: ann.published_version_no,
    });
  }
  function cachedPage(cacheKey, build) {
    let row = db.prepare('SELECT * FROM public_pages WHERE cache_key=?').get(cacheKey);
    if (row) return { html: row.html, hit: true };
    const html = build();
    db.prepare('INSERT OR REPLACE INTO public_pages(cache_key,html,generated_at) VALUES(?,?,?)')
      .run(cacheKey, html, nowIso());
    return { html, hit: false };
  }
  app.get('/public/announcements/:id', (req, res) => {
    const { html, hit } = cachedPage(`ann:${req.params.id}`, () => publicAnnHtml(req.params.id));
    res.set('X-Cache', hit ? 'HIT' : 'MISS').type('html').send(html);
  });
  app.get('/public/announcements/:id/versions/:no', (req, res) => {
    const { html, hit } = cachedPage(`ann:${req.params.id}:v${req.params.no}`,
      () => publicVersionHtml(req.params.id, Number(req.params.no)));
    res.set('X-Cache', hit ? 'HIT' : 'MISS').type('html').send(html);
  });

  // 事件流（审计）
  app.get('/api/announcements/:id/events', (req, res) => {
    getAnn(db, req.params.id);
    res.json(db.prepare('SELECT * FROM events WHERE announcement_id=? ORDER BY id').all(req.params.id));
  });

  // 错误处理
  app.use((e, _req, res, _next) => {
    if (e instanceof HttpError) {
      return res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details || null } });
    }
    if (e && e.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'BAD_JSON', message: '请求体不是有效 JSON' } });
    }
    console.error(e);
    res.status(500).json({ error: { code: 'INTERNAL', message: String(e && e.message || e) } });
  });

  return { app, db, store, close: () => db.close() };
}

module.exports = { createApp };
