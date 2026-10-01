'use strict';
const crypto = require('crypto');
const fs = require('fs');
const obj = require('./object-client');
const D = require('./dates');
const R = require('./render');

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const REQUIRED_APPROVALS = Number(process.env.REQUIRED_APPROVALS || 1);

// ---------------- 公开页内存缓存（显式失效） ----------------
const publicCache = new Map(); // publicUuid -> {etag, epoch, payload}
function invalidateNotice(notice) {
  if (notice.public_uuid) publicCache.delete(notice.public_uuid);
}
function bumpChain(db, txRunner, notice) {
  // 同一替代链上的所有公告缓存一并失效
  const members = db.all('SELECT id, public_uuid FROM notices WHERE chain_id = ?', [notice.chain_id]);
  for (const m of members) if (m.public_uuid) publicCache.delete(m.public_uuid);
  db.run('UPDATE notices SET chain_epoch = chain_epoch + 1 WHERE chain_id = ?', [notice.chain_id]);
}

// ---------------- 辅助 ----------------
function json(res, code, o, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(o));
}
function fail(res, code, error, extra = {}) { json(res, code, { error, ...extra }); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString()); } catch { const e = new Error('invalid json'); e.status = 400; throw e; }
}

function activeRule(db) {
  return db.get(`SELECT r.* FROM rule_sets r JOIN (SELECT name, MAX(version) mv FROM rule_sets
    WHERE status='active' GROUP BY name) x ON r.name=x.name AND r.version=x.mv LIMIT 1`);
}
function loadRule(db, id, version) {
  return db.get('SELECT * FROM rule_sets WHERE id=? AND version=?', [id, version]);
}
function noticeSnapshot(notice) {
  return {
    title: notice.title, project_code: notice.project_code, project_name: notice.project_name,
    procurement_scope: notice.procurement_scope, qualifications: notice.qualifications,
    body_text: notice.body_text,
    rule_set_id: notice.rule_set_id, rule_set_version: notice.rule_set_version,
    date_values: JSON.parse(notice.date_values || '{}'),
    required_slots: JSON.parse(notice.required_slots || '[]'),
  };
}
function fingerprintOf(snapshot, attachments) {
  const s = JSON.parse(JSON.stringify(snapshot));
  s.attachments = (attachments || []).map((a) => ({
    slot: a.slot, filename: a.filename, sha256: a.sha256, size: a.size,
  })).sort((a, b) => (a.slot + a.filename).localeCompare(b.slot + b.filename));
  return crypto.createHash('sha256').update(R.canonical(s)).digest('hex');
}
function currentAttachments(db, noticeId) {
  return db.all(`SELECT * FROM attachments WHERE notice_id=? AND replaced_by IS NULL ORDER BY slot, filename`, [noticeId]);
}
function logTransition(db, { notice_id, version_id, action, actor, from, to, detail }) {
  db.run(`INSERT INTO transitions (id,notice_id,version_id,action,actor,from_status,to_status,detail,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`,
    [uuid(), notice_id || null, version_id || null, action, actor, from || null, to || null, detail || '', now()]);
}
function validateRuleConfig(cfg, mode) {
  const errs = [];
  if (!cfg || typeof cfg !== 'object') return ['规则配置必须是对象'];
  if (!/^[+-]\d{2}:\d{2}$|^Z$/.test(cfg.timezone || '')) errs.push('timezone 必须为 Z 或 ±HH:MM');
  const keys = new Set();
  for (const s of cfg.slots || []) {
    if (!s.key) errs.push('槽位缺少 key');
    if (keys.has(s.key)) errs.push(`槽位 key 重复: ${s.key}`);
    keys.add(s.key);
    if (!D.VALID_SLOT_TYPES.includes(s.type)) errs.push(`槽位 ${s.key} 类型必须是 date/instant`);
    if (s.mode === 'relative' && !Number.isInteger(s.offsetDays)) errs.push(`相对槽位 ${s.key} 缺少 offsetDays`);
  }
  for (const p of cfg.pairs || []) {
    if (!keys.has(p.after) || !keys.has(p.before)) errs.push(`顺序约束引用了不存在的槽位: ${p.after}/${p.before}`);
  }
  if (mode === 'strict' && !(cfg.slots || []).some((s) => s.type === 'date')) errs.push('严格模式至少需要一个截止日槽位');
  return errs;
}

// ---------------- 处理器 ----------------
function createHandler(db) {
  const auth = (req) => {
    const t = req.headers['x-auth-token'];
    if (!t) return null;
    return db.get('SELECT u.* FROM sessions s JOIN users u ON u.username=s.username WHERE s.token=?', [t]);
  };
  const requireRole = (user, ...roles) => user && (roles.includes(user.role) || user.role === 'admin');

  return async function handler(req, res) {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    try {
      // ---------- 认证 ----------
      if (req.method === 'POST' && p === '/api/auth/login') {
        const body = await readJson(req);
        const user = db.get('SELECT * FROM users WHERE username=? AND active=1', [body.username]);
        if (!user) return fail(res, 401, '用户名不存在或已停用');
        const token = crypto.randomBytes(24).toString('hex');
        db.run('INSERT INTO sessions (token,username,created_at) VALUES (?,?,?)', [token, user.username, now()]);
        db.persist();
        return json(res, 200, { token, user: { username: user.username, display_name: user.display_name, role: user.role } });
      }
      if (p === '/api/public/health') return json(res, 200, { ok: true });

      const user = await auth(req);
      // 公开页不需要登录
      const pubMatch = /^\/api\/public\/notices\/([^/]+)$/.exec(p);
      if (req.method === 'GET' && pubMatch) return publicNotice(req, res, db, pubMatch[1]);

      if (!user) return fail(res, 401, '未登录或会话已失效');

      if (p === '/api/auth/me') return json(res, 200, { username: user.username, display_name: user.display_name, role: user.role });

      // ---------- 规则 ----------
      if (p === '/api/rules' && req.method === 'GET') {
        return json(res, 200, db.all('SELECT id,name,version,status,config,created_by,created_at FROM rule_sets ORDER BY id DESC'));
      }
      if (p === '/api/rules' && req.method === 'POST') {
        if (!requireRole(user, 'admin')) return fail(res, 403, '仅管理员可配置公告规则');
        const body = await readJson(req);
        const errs = validateRuleConfig(body.config, body.mode || 'strict');
        if (errs.length) return fail(res, 422, '规则校验失败', { errors: errs });
        const prev = db.get('SELECT MAX(version) mv FROM rule_sets WHERE name=?', [body.name]);
        const version = (prev.mv || 0) + 1;
        const id = (db.get('SELECT MAX(id) mid FROM rule_sets').mid || 0) + 1;
        db.run(`INSERT INTO rule_sets (id,name,version,status,config,created_by,created_at) VALUES (?,?,?,?,?,?,?)`,
          [id, body.name, version, body.activate ? 'active' : 'draft', JSON.stringify(body.config), user.username, now()]);
        if (body.activate) db.run(`UPDATE rule_sets SET status='retired' WHERE name=? AND id<>?`, [body.name, id]);
        db.persist();
        return json(res, 201, { id, name: body.name, version });
      }
      if (/^\/api\/rules\/\d+\/activate$/.test(p) && req.method === 'POST') {
        if (!requireRole(user, 'admin')) return fail(res, 403, '仅管理员可激活规则');
        const id = Number(p.split('/')[3]);
        const rule = db.get('SELECT * FROM rule_sets WHERE id=?', [id]);
        if (!rule) return fail(res, 404, '规则不存在');
        db.run('UPDATE rule_sets SET status=? WHERE 1=1', ['retired']);
        db.run('UPDATE rule_sets SET status=? WHERE id=?', ['active', id]);
        db.persist();
        return json(res, 200, { ok: true });
      }

      // ---------- 公告列表 / 创建 ----------
      if (p === '/api/notices' && req.method === 'GET') {
        const rows = db.all('SELECT * FROM notices ORDER BY created_at DESC');
        return json(res, 200, rows.map((n) => ({ ...n, date_values: JSON.parse(n.date_values || '{}') })));
      }
      if (p === '/api/notices' && req.method === 'POST') {
        if (!requireRole(user, 'editor')) return fail(res, 403, '编辑/管理员可创建公告');
        const body = await readJson(req);
        const rule = activeRule(db);
        if (!rule) return fail(res, 422, '尚无已激活公告规则，请管理员先配置');
        const cfg = JSON.parse(rule.config);
        const id = 'N' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
        const slug = (body.project_code || id).toString().replace(/[^\w一-龥-]/g, '_').slice(0, 40) + '-' + id.slice(-4);
        const required = [...new Set([
          ...((cfg.requiredAttachmentSlots) || []),
          ...(cfg.slots || []).filter((s) => s.required).map((s) => 'date:' + s.key),
        ])];
        db.run(`INSERT INTO notices (id,slug,title,project_code,project_name,procurement_scope,qualifications,body_text,date_values,
            rule_set_id,rule_set_version,required_slots,planned_publish_at,status,kind,chain_id,supersedes_id,current_version,chain_epoch,
            created_by,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?, 'draft','original',?,NULL,0,0, ?,?,?)`,
          [id, slug, body.title || '', body.project_code || '', body.project_name || '', '', '', '', '{}',
           rule.id, rule.version, JSON.stringify(required), null, id,
           user.username, now(), now()]);
        logTransition(db, { notice_id: id, action: 'create', actor: user.username, from: null, to: 'draft' });
        db.persist();
        return json(res, 201, db.get('SELECT * FROM notices WHERE id=?', [id]));
      }

      const noticeMatch = /^\/api\/notices\/([^/]+)(\/.*)?$/.exec(p);
      if (noticeMatch) return await noticeRoutes(req, res, db, user, noticeMatch[1], noticeMatch[2] || '', u);

      // ---------- 上传分片（按会话 id） ----------
      const upMatch = /^\/api\/uploads\/([^/]+)(\/.*)?$/.exec(p);
      if (upMatch) return await uploadRoutes(req, res, db, user, upMatch[1], upMatch[2] || '');

      // ---------- 按发布清单重建（管理员） ----------
      if (p === '/api/admin/rebuild' && req.method === 'POST') {
        if (!requireRole(user, 'admin')) return fail(res, 403, '仅管理员可重建正式文件');
        const body = await readJson(req);
        return await rebuildFromManifest(res, db, body.manifest_key);
      }

      return fail(res, 404, '未知接口: ' + p);
    } catch (e) {
      console.error('[api error]', p, e.stack || e);
      return fail(res, e.status || 500, e.message);
    }
  };
}

// ---------------- 公告子路由 ----------------
async function noticeRoutes(req, res, db, user, id, sub, u) {
  const notice = db.get('SELECT * FROM notices WHERE id=? OR slug=?', [id, id]);
  if (!notice) return fail(res, 404, '公告不存在');
  const seg = sub.split('/').filter(Boolean);
  const isEditor = (n) => n && (n.role === 'editor' || n.role === 'admin');
  const isReviewer = (n) => n && (n.role === 'reviewer' || n.role === 'admin');

  if (!seg.length && req.method === 'GET') {
    const versions = db.all('SELECT * FROM notice_versions WHERE notice_id=? ORDER BY ver', [notice.id]);
    const attachments = currentAttachments(db, notice.id);
    const openUploads = db.all("SELECT id,filename,slot,state,received,declared_size,last_error FROM upload_sessions WHERE notice_id=? AND state='open'", [notice.id]);
    return json(res, 200, {
      ...notice, date_values: JSON.parse(notice.date_values || '{}'),
      versions: versions.map((v) => ({ ...v, snapshot: JSON.parse(v.snapshot) })),
      attachments, openUploads,
      reviews: db.all('SELECT * FROM reviews WHERE version_id IN (SELECT id FROM notice_versions WHERE notice_id=?) ORDER BY created_at', [notice.id]),
      transitions: db.all('SELECT * FROM transitions WHERE notice_id=? ORDER BY created_at', [notice.id]),
      publications: db.all('SELECT id,ver,rendered_key,manifest_key,fingerprint,cache_epoch,published_at,published_by FROM publications WHERE notice_id=? ORDER BY published_at', [notice.id]),
    });
  }

  // 编辑公告字段（draft 或已发布原地编辑；in_review 期间冻结）
  if (!seg.length && req.method === 'PATCH') {
    if (!isEditor(user)) return fail(res, 403, '需要编辑权限');
    if (notice.status === 'in_review') return fail(res, 409, '评审中不可编辑：请先撤回评审');
    const body = await readJson(req);
    const fields = ['title', 'project_code', 'project_name', 'procurement_scope', 'qualifications', 'body_text', 'planned_publish_at'];
    const sets = [], vals = [];
    for (const f of fields) if (body[f] !== undefined) { sets.push(`${f}=?`); vals.push(body[f]); }
    if (body.date_values) { sets.push('date_values=?'); vals.push(JSON.stringify(body.date_values)); }
    if (body.rule_set_id) {
      const rule = db.get('SELECT * FROM rule_sets WHERE id=?', [body.rule_set_id]);
      if (!rule) return fail(res, 404, '规则不存在');
      sets.push('rule_set_id=?', 'rule_set_version=?'); vals.push(rule.id, rule.version);
    }
    if (!sets.length) return fail(res, 400, '无可更新字段');
    sets.push('updated_at=?'); vals.push(now()); vals.push(notice.id);
    db.run(`UPDATE notices SET ${sets.join(',')} WHERE id=?`, vals);
    db.persist();
    return json(res, 200, { ok: true, notice: db.get('SELECT * FROM notices WHERE id=?', [notice.id]) });
  }

  // 预览（跨字段冲突；mode=draft 仅提示 / strict 错误）
  if (seg[0] === 'preview' && req.method === 'GET') {
    const mode = u.searchParams.get('mode') || 'draft';
    const fresh = db.get('SELECT * FROM notices WHERE id=?', [notice.id]);
    const rule = loadRule(db, fresh.rule_set_id, fresh.rule_set_version);
    const cfg = rule ? JSON.parse(rule.config) : { slots: [], pairs: [] };
    const anchor = (fresh.planned_publish_at || now()).slice(0, 10);
    const computed = D.computeDates(cfg, JSON.parse(fresh.date_values || '{}'), anchor);
    const result = D.previewConflicts(fresh, cfg);
    const uploadsOpen = db.all("SELECT id,filename,slot,received,declared_size FROM upload_sessions WHERE notice_id=? AND state='open'", [notice.id]);
    const atts = currentAttachments(db, fresh.id);
    const covered = new Set(atts.map((a) => a.slot));
    const requiredAttSlots = JSON.parse(fresh.required_slots || '[]').filter((s) => !s.startsWith('date:'));
    const missing = requiredAttSlots.filter((s) => !covered.has(s));
    if (uploadsOpen.length) result.warnings.push({ field: 'attachments', code: 'UPLOAD_OPEN', msg: `有 ${uploadsOpen.length} 个附件尚未上传完成`, uploads: uploadsOpen });
    if (missing.length) {
      (mode === 'strict' ? result.errors : result.warnings).push({ field: 'attachments', code: 'ATTACHMENT_SLOT_MISSING', msg: `附件槽位未齐：${missing.join('、')}（不能发布半套附件）`, missing });
    }
    return json(res, 200, { mode, ...result, computedDates: computed, legalNote: legalNote() });
  }

  // 版本保存 / 提交 / 审批 / 撤回
  if (seg[0] === 'versions') {
    // 保存新版本（不可变快照）
    if (seg.length === 1 && req.method === 'POST') {
      if (!isEditor(user)) return fail(res, 403, '需要编辑权限');
      const body = await readJson(req);
      if (notice.status === 'in_review') return fail(res, 409, '评审中：当前版本已定稿，请撤回后再改');
      return await db.tx(() => {
        const fresh = db.get('SELECT * FROM notices WHERE id=?', [notice.id]);
        const rule = loadRule(db, fresh.rule_set_id, fresh.rule_set_version);
        const cfg = rule ? JSON.parse(rule.config) : { slots: [], pairs: [] };
        const snap = noticeSnapshot(fresh);
        const atts = currentAttachments(db, fresh.id);
        // 保存即做 draft 模式校验（只返回，不阻断）
        const conflicts = D.previewConflicts(fresh, cfg);
        const fp = fingerprintOf(snap, atts);
        const ver = (db.get('SELECT MAX(ver) m FROM notice_versions WHERE notice_id=?', [fresh.id]).m || 0) + 1;
        const vid = uuid();
        db.run(`INSERT INTO notice_versions (id,notice_id,ver,snapshot,fingerprint,status,created_by,created_at)
          VALUES (?,?,?,?,?, 'draft',?,?)`,
          [vid, fresh.id, ver, JSON.stringify({ ...snap, attachments: atts.map((a) => ({ id: a.id, slot: a.slot, filename: a.filename, media_type: a.media_type, sha256: a.sha256, size: a.size, object_key: a.object_key })) }), fp, user.username, now()]);
        db.run("UPDATE notice_versions SET status='superseded' WHERE notice_id=? AND status='draft' AND id<>?", [fresh.id, vid]);
        db.run('UPDATE attachments SET version_id=? WHERE notice_id=? AND replaced_by IS NULL', [vid, fresh.id]);
        logTransition(db, { notice_id: fresh.id, version_id: vid, action: 'save_version', actor: user.username, from: null, to: 'draft', detail: `v${ver}` });
        return json(res, 201, { version_id: vid, ver, fingerprint: fp, conflicts, legalNote: legalNote() });
      });
    }
    const verRow = seg.length >= 2 ? db.get('SELECT * FROM notice_versions WHERE id=? OR (notice_id=? AND ver=?)', [seg[1], notice.id, Number(seg[1])]) : null;
    if (seg.length >= 2 && !verRow) return fail(res, 404, '版本不存在');

    // 提交评审
    if (seg.length === 3 && seg[2] === 'submit' && req.method === 'POST') {
      if (!isEditor(user)) return fail(res, 403, '需要编辑权限');
      return await db.tx(() => {
        const v = db.get('SELECT * FROM notice_versions WHERE id=?', [verRow.id]);
        if (v.status !== 'draft') return fail(res, 409, `版本状态为 ${v.status}，仅草稿可提交`);
        const fresh = db.get('SELECT * FROM notices WHERE id=?', [notice.id]);
        const rule = loadRule(db, fresh.rule_set_id, fresh.rule_set_version);
        if (!rule || rule.status !== 'active') return fail(res, 422, '引用的公告规则未激活，无法提交');
        if (fresh.rule_set_id !== vSnapshot(v).rule_set_id) return fail(res, 409, '规则版本已变化，请基于最新规则重新保存版本');
        const cfg = JSON.parse(rule.config);
        const conflicts = D.previewConflicts(fresh, cfg);
        if (conflicts.errors.length) return fail(res, 422, '严格校验未通过（日期/字段冲突），请先修正', { conflicts: conflicts.errors });
        const open = db.all("SELECT COUNT(*) c FROM upload_sessions WHERE notice_id=? AND state='open'", [fresh.id]);
        if (open[0].c) return fail(res, 409, '存在未完成上传，请先完成或中止');
        const requiredAtt = JSON.parse(fresh.required_slots || '[]').filter((s) => !s.startsWith('date:'));
        const atts = currentAttachments(db, fresh.id);
        const covered = new Set(atts.map((a) => a.slot));
        const missing = requiredAtt.filter((s) => !covered.has(s));
        if (missing.length) return fail(res, 422, `附件槽位未齐，不能提交半套：${missing.join('、')}`);
        db.run("UPDATE notice_versions SET status='submitted', submitted_at=? WHERE id=?", [now(), v.id]);
        db.run("UPDATE notices SET status='in_review' WHERE id=?", [fresh.id]);
        logTransition(db, { notice_id: fresh.id, version_id: v.id, action: 'submit', actor: user.username, from: 'draft', to: 'submitted' });
        return json(res, 200, { ok: true, version: { ...v, status: 'submitted' } });
      });
    }

    // 并行评审：approve / reject / comment —— 全部绑定具体版本
    if (seg.length === 3 && ['approve', 'reject', 'comment'].includes(seg[2]) && req.method === 'POST') {
      if (!isReviewer(user)) return fail(res, 403, '需要评审权限');
      const body = await readJson(req).catch(() => ({}));
      return await db.tx(() => {
        const v = db.get('SELECT * FROM notice_versions WHERE id=?', [verRow.id]);
        if (v.status !== 'submitted') {
          // 审批/撤回竞争：状态已被撤回或他方决定
          const n = db.get('SELECT status FROM notices WHERE id=?', [notice.id]);
          return fail(res, 409, `评审失败：该版本当前为 ${v.status}（公告状态 ${n.status}），可能已被撤回或他人先行处理`, { version_status: v.status, notice_status: n.status });
        }
        const dup = db.get('SELECT id FROM reviews WHERE version_id=? AND reviewer=? AND decision<>?', [v.id, user.username, 'comment']);
        if (dup && seg[2] !== 'comment') return fail(res, 409, '你已对该版本作出过决定');
        db.run(`INSERT INTO reviews (id,version_id,reviewer,decision,comment,fingerprint,created_at) VALUES (?,?,?,?,?,?,?)`,
          [uuid(), v.id, user.username, seg[2], body.comment || '', v.fingerprint, now()]);
        let newStatus = v.status;
        if (seg[2] === 'reject') {
          newStatus = 'rejected';
          db.run("UPDATE notice_versions SET status='rejected', reviewed_by=?, reviewed_at=?, decision='rejected', review_comment=? WHERE id=?",
            [user.username, now(), body.comment || '', v.id]);
          db.run("UPDATE notices SET status='draft' WHERE id=?", [notice.id]);
        } else if (seg[2] === 'approve') {
          const approvals = db.get("SELECT COUNT(*) c FROM reviews WHERE version_id=? AND decision='approve'", [v.id]).c + 1;
          const rejects = db.get("SELECT COUNT(*) c FROM reviews WHERE version_id=? AND decision='reject'", [v.id]).c;
          if (rejects === 0 && approvals >= REQUIRED_APPROVALS) {
            newStatus = 'approved';
            db.run("UPDATE notice_versions SET status='approved', reviewed_by=?, reviewed_at=?, decision='approved', review_comment=?, approval_fingerprint=? WHERE id=?",
              [user.username, now(), body.comment || '', v.fingerprint, v.id]);
            db.run("UPDATE notices SET status='draft' WHERE id=?", [notice.id]); // 回到待发布
          }
        }
        logTransition(db, { notice_id: notice.id, version_id: v.id, action: seg[2], actor: user.username, from: 'submitted', to: newStatus, detail: body.comment || '' });
        const reviews = db.all('SELECT reviewer,decision,comment,created_at FROM reviews WHERE version_id=? ORDER BY created_at', [v.id]);
        return json(res, 200, { ok: true, version_status: newStatus, approvals: reviews.filter((r) => r.decision === 'approve').length, required: REQUIRED_APPROVALS, reviews });
      });
    }

    if (seg.length >= 2 && req.method === 'GET') {
      const reviews = db.all('SELECT * FROM reviews WHERE version_id=? ORDER BY created_at', [verRow.id]);
      return json(res, 200, { version: { ...verRow, snapshot: JSON.parse(verRow.snapshot) }, reviews });
    }
  }

  // 撤回评审（与审批竞争）
  if (seg[0] === 'withdraw-review' && req.method === 'POST') {
    if (!isEditor(user)) return fail(res, 403, '需要编辑权限');
    return await db.tx(() => {
      const fresh = db.get('SELECT * FROM notices WHERE id=?', [notice.id]);
      if (fresh.status !== 'in_review') return fail(res, 409, `公告状态为 ${fresh.status}，评审中才能撤回`, { notice_status: fresh.status });
      const v = db.get("SELECT * FROM notice_versions WHERE notice_id=? AND status='submitted'", [fresh.id]);
      if (!v) return fail(res, 409, '没有进行中的提交版本（可能评审已先完成）');
      db.run("UPDATE notice_versions SET status='draft' WHERE id=?", [v.id]);
      db.run("UPDATE notices SET status='draft' WHERE id=?", [fresh.id]);
      logTransition(db, { notice_id: fresh.id, version_id: v.id, action: 'withdraw_review', actor: user.username, from: 'submitted', to: 'draft' });
      return json(res, 200, { ok: true, version_status: 'draft' });
    });
  }

  // 撤回已发布公告
  if (seg[0] === 'withdraw-publish' && req.method === 'POST') {
    if (!isEditor(user)) return fail(res, 403, '需要编辑权限');
    const body = await readJson(req).catch(() => ({}));
    return await db.tx(() => {
      const fresh = db.get('SELECT * FROM notices WHERE id=?', [notice.id]);
      if (fresh.status !== 'published') return fail(res, 409, `仅已发布公告可撤回，当前 ${fresh.status}`);
      db.run("UPDATE notices SET status='withdrawn', withdrawn_at=?, withdraw_reason=? WHERE id=?", [now(), body.reason || '', fresh.id]);
      bumpChain(db, db, fresh);
      logTransition(db, { notice_id: fresh.id, action: 'withdraw_publish', actor: user.username, from: 'published', to: 'withdrawn', detail: body.reason || '' });
      return json(res, 200, { ok: true });
    });
  }

  // 发布（原地发布 / 原地编辑后再版）
  if (seg[0] === 'publish' && req.method === 'POST') {
    if (!isEditor(user)) return fail(res, 403, '需要编辑权限');
    return await publishNotice(req, res, db, user, notice);
  }

  // 追加更正公告（创建替代链下一环）
  if (seg[0] === 'amendment' && req.method === 'POST') {
    if (!isEditor(user)) return fail(res, 403, '需要编辑权限');
    return await db.tx(() => {
      const origin = db.get('SELECT * FROM notices WHERE id=?', [notice.id]);
      if (origin.status !== 'published') return fail(res, 409, '仅已发布公告可追加更正公告');
      const rule = activeRule(db);
      const rcfg = JSON.parse(rule.config);
      const required = JSON.stringify([...new Set([
        ...((rcfg.requiredAttachmentSlots) || []),
        ...(rcfg.slots || []).filter((s) => s.required).map((s) => 'date:' + s.key),
      ])]);
      const aid = 'N' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
      db.run(`INSERT INTO notices (id,slug,title,project_code,project_name,procurement_scope,qualifications,body_text,
          date_values,rule_set_id,rule_set_version,required_slots,status,kind,chain_id,supersedes_id,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,'draft','amendment',?,?,?,?,?)`,
        [aid, origin.slug + '-corr-' + Date.now().toString(36), (origin.title || '') + '（更正公告）',
         origin.project_code, origin.project_name, origin.procurement_scope, origin.qualifications,
         origin.body_text, origin.date_values, rule.id, rule.version, required,
         origin.chain_id, origin.id, user.username, now(), now()]);
      logTransition(db, { notice_id: aid, action: 'create_amendment', actor: user.username, from: null, to: 'draft', detail: `supersedes ${origin.id}` });
      return json(res, 201, { amendment_id: aid, chain_id: origin.chain_id, supersedes_id: origin.id });
    });
  }

  // 替代链
  if (seg[0] === 'chain' && req.method === 'GET') {
    const members = db.all('SELECT id,title,status,kind,supersedes_id,public_uuid,published_at,current_version FROM notices WHERE chain_id=? ORDER BY created_at', [notice.chain_id]);
    return json(res, 200, { chain_id: notice.chain_id, members });
  }

  // 重建本公告最新正式文件
  if (seg[0] === 'rebuild' && req.method === 'POST') {
    if (user.role !== 'admin') return fail(res, 403, '仅管理员可重建正式文件');
    const pub = db.get('SELECT * FROM publications WHERE notice_id=? ORDER BY published_at DESC LIMIT 1', [notice.id]);
    if (!pub) return fail(res, 404, '该公告尚无发布记录');
    return await rebuildFromManifest(res, db, pub.manifest_key);
  }

  // 附件
  if (seg[0] === 'attachments') return await attachmentRoutes(req, res, db, user, notice, seg.slice(1));

  return fail(res, 404, '未知子路径: ' + sub);
}

function vSnapshot(v) { return JSON.parse(v.snapshot); }
function legalNote() {
  return '本系统为公告编制与流转工具，不构成、也不替代法律审查；正式对外文本须经具备资质的人员/法务复核。';
}

// ---------------- 附件 / 上传 ----------------
async function attachmentRoutes(req, res, db, user, notice, seg) {
  if (!seg.length && req.method === 'GET') {
    return json(res, 200, {
      ready: currentAttachments(db, notice.id),
      all: db.all('SELECT id,slot,filename,media_type,size,sha256,state,replaced_by,created_at FROM attachments WHERE notice_id=? ORDER BY created_at', [notice.id]),
      open_uploads: db.all("SELECT * FROM upload_sessions WHERE notice_id=? AND state='open'", [notice.id]),
    });
  }
  if (seg[0] === 'upload-start' && req.method === 'POST') {
    if (notice.status === 'in_review') return fail(res, 409, '评审中不可增改附件');
    const body = await readJson(req);
    if (!body.filename || !body.slot) return fail(res, 400, 'filename 与 slot 必填');
    const upId = uuid();
    await obj.createUpload(upId);
    db.run(`INSERT INTO upload_sessions (id,notice_id,filename,slot,media_type,declared_sha256,declared_size,state,temp_path,created_by,created_at)
      VALUES (?,?,?,?,?,?,?, 'open', ?,?,?)`,
      [upId, notice.id, body.filename, body.slot, body.media_type || 'application/octet-stream',
       body.sha256 || null, body.size ?? null, `tmp/${upId}.part`, user.username, now()]);
    db.persist();
    return json(res, 201, { upload_id: upId, received: 0 });
  }
  return fail(res, 404, '附件路径不存在');
}

async function uploadRoutes(req, res, db, user, upId, sub) {
  const session = db.get('SELECT * FROM upload_sessions WHERE id=?', [upId]);
  if (!session) return fail(res, 404, '上传会话不存在');
  const seg = sub.split('/').filter(Boolean);

  if (seg[0] === 'status' && req.method === 'GET') {
    let received = session.received;
    try { const r = await obj.request?.('GET', '/'); } catch {}
    return json(res, 200, { id: upId, state: session.state, received, declared_size: session.declared_size });
  }
  if (seg[0] === 'chunk' && req.method === 'PUT') {
    if (session.state !== 'open') return fail(res, 409, '会话已结束');
    const buf = await readBody(req);
    const offset = Number(req.headers['x-offset'] ?? session.received);
    try {
      const r = await obj.appendChunk(upId, buf, offset);
      db.run('UPDATE upload_sessions SET received=? WHERE id=?', [r.body.received, upId]);
      db.persist();
      return json(res, 200, { received: r.body.received });
    } catch (e) {
      db.run('UPDATE upload_sessions SET last_error=? WHERE id=?', [e.message, upId]); db.persist();
      return fail(res, e.status || 500, e.message, e.body || {});
    }
  }
  if (seg[0] === 'complete' && req.method === 'POST') {
    if (session.state !== 'open') return fail(res, 409, '会话已结束');
    try {
      const fin = await obj.finalizeUpload(upId, { declared_size: session.declared_size, declared_sha256: session.declared_sha256 });
      const { sha256, size, objectKey } = fin.body;
      return await db.tx(() => {
        // 同名附件替换：同槽位同文件名的现有附件标记被替换（触发复核）
        const same = db.all("SELECT id FROM attachments WHERE notice_id=? AND slot=? AND filename=? AND replaced_by IS NULL",
          [session.notice_id, session.slot, session.filename]);
        const attId = uuid();
        db.run(`INSERT INTO attachments (id,notice_id,slot,filename,media_type,size,sha256,object_key,created_by,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [attId, session.notice_id, session.slot, session.filename, session.media_type, size, sha256, objectKey, user.username, now()]);
        for (const s of same) db.run('UPDATE attachments SET replaced_by=? WHERE id=?', [attId, s.id]);
        db.run("UPDATE upload_sessions SET state='completed', attachment_id=?, received=?, completed_at=? WHERE id=?",
          [attId, size, now(), upId]);
        logTransition(db, { notice_id: session.notice_id, action: same.length ? 'replace_attachment' : 'add_attachment', actor: user.username, from: null, to: null, detail: `${session.slot}/${session.filename}${same.length ? '（同名替换）' : ''}` });
        return json(res, 201, { attachment_id: attId, sha256, size, replaced: same.map((s) => s.id), object_key: objectKey });
      });
    } catch (e) {
      return fail(res, e.status || 500, '定稿失败：' + e.message, e.body || {});
    }
  }
  if (seg[0] === 'abort' && req.method === 'POST') {
    await obj.abortUpload(upId).catch(() => {});
    db.run("UPDATE upload_sessions SET state='aborted' WHERE id=?", [upId]); db.persist();
    return json(res, 200, { ok: true });
  }
  return fail(res, 404, '上传子路径不存在');
}

// ---------------- 发布 ----------------
async function publishNotice(req, res, db, user, notice) {
  const body = await readJson(req).catch(() => ({}));
  return await db.tx(async () => {
    const fresh = db.get('SELECT * FROM notices WHERE id=?', [notice.id]);
    if (fresh.status === 'withdrawn') return fail(res, 409, '已撤回公告不可直接发布，请复制为新公告/更正公告');

    // 1) 选择版本：指定 version，或取最新 approved
    let version;
    if (body.version_id) version = db.get('SELECT * FROM notice_versions WHERE id=? AND notice_id=?', [body.version_id, fresh.id]);
    else version = db.get("SELECT * FROM notice_versions WHERE notice_id=? AND status='approved' ORDER BY ver DESC LIMIT 1", [fresh.id]);
    if (!version) return fail(res, 409, '没有已批准版本，不能发布');

    const snap = vSnapshot(version);
    const errors0 = [];
    // 2) 正文完整性
    if (!snap.body_text || snap.body_text.trim().length < 10) errors0.push('正文缺失或过短');
    if (!snap.title || !snap.project_name) errors0.push('标题/项目名称缺失');

    // 3) 规则版一致：版本引用规则 == 当前激活规则
    const active = activeRule(db);
    if (!active) return fail(res, 422, '无激活规则');
    if (snap.rule_set_id !== active.id || snap.rule_set_version !== active.version) {
      return fail(res, 409, `规则版本不一致：批准基于规则 #${snap.rule_set_id}v${snap.rule_set_version}，当前生效 #${active.id}v${active.version}，须按新规则修改后重新评审`);
    }
    const cfg = JSON.parse(active.config);

    // 4) 日期严格校验（在版本快照上）
    const dateConflicts = D.previewConflicts({ ...fresh, date_values: JSON.stringify(snap.date_values) }, cfg);
    if (dateConflicts.errors.length) return fail(res, 422, '日期/跨字段冲突未解决，不能发布', { errors: dateConflicts.errors });

    // 5) 附件摘要：槽位齐 + 对象存在且哈希一致 + 无未完成上传
    const open = db.all("SELECT * FROM upload_sessions WHERE notice_id=? AND state='open'", [fresh.id]);
    if (open.length) return fail(res, 409, `有 ${open.length} 个附件上传未完成，不能发布半套附件`, { open: open.map((o) => ({ id: o.id, slot: o.slot, filename: o.filename, received: o.received, declared_size: o.declared_size })) });
    const requiredSlots = (snap.required_slots || []).filter((s) => !s.startsWith('date:'));
    const attRefs = snap.attachments || [];
    const bySlot = {};
    for (const a of attRefs) (bySlot[a.slot] = bySlot[a.slot] || []).push(a);
    const missing = requiredSlots.filter((s) => !bySlot[s] || !bySlot[s].length);
    if (missing.length) return fail(res, 422, `附件不齐，缺少槽位：${missing.join('、')}`);
    for (const a of attRefs) {
      try {
        const head = await obj.headObject(a.object_key);
        if (head.headers['x-object-sha256'] !== a.sha256) return fail(res, 422, `附件 ${a.filename} 对象哈希与清单不符（对象可能被损坏）`);
        if (Number(head.headers['content-length']) !== a.size) return fail(res, 422, `附件 ${a.filename} 大小不符`);
      } catch (e) {
        return fail(res, 422, `附件 ${a.filename} 的固定对象缺失，无法发布：${e.message}`);
      }
      // 版本固化之后被同名替换的附件不得再随旧批准发布——必须保存新版本并重新评审
      const live = db.get('SELECT replaced_by FROM attachments WHERE id=?', [a.id]);
      if (!live) return fail(res, 409, `附件 ${a.filename} 已从公告移除，请保存新版本并重新评审`);
      if (live.replaced_by) return fail(res, 409, `附件 ${a.slot}/${a.filename} 在批准后被同名替换，该批准须复核（请发布新版本）`);
    }

    // 6) 批准指纹一致：采购范围/附件改动会改变指纹，版本不可变 => 必须有与本指纹匹配的批准
    if (version.approval_fingerprint && version.approval_fingerprint !== version.fingerprint) {
      return fail(res, 409, '批准与版本指纹不一致，需重新评审');
    }
    if (errors0.length) return fail(res, 422, '发布校验失败', { errors: errors0 });

    // 7) 渲染 + 固化
    const anchor = (fresh.planned_publish_at || now()).slice(0, 10);
    const datesSnapshot = D.computeDates(cfg, snap.date_values, anchor);
    const publishedAt = now();
    const statusLine = '';
    const ruleForRender = { ...active, name: active.name };
    const html = R.renderVersion({
      notice: { ...fresh, rule_set_name: active.name },
      version: { ...version, snapshot: snap },
      attachments: attRefs, datesSnapshot, ruleConfig: cfg, publishedAt, statusLine,
    });
    const htmlBuf = Buffer.from(html, 'utf8');
    const renderedKey = `outputs/${fresh.id}/v${version.ver}/${crypto.createHash('sha256').update(htmlBuf).digest('hex')}.html`;
    await obj.putObject(renderedKey, htmlBuf);
    const snapBuf = Buffer.from(JSON.stringify(version.snapshot), 'utf8');
    // 内容寻址：同一版本若快照不同（理论上不可变版本不会变），也不会覆盖既有固定对象
    const snapKey = `snapshots/${fresh.id}/v${version.ver}-${obj.sha256(snapBuf).slice(0, 16)}.json`;
    await obj.putObject(snapKey, snapBuf);
    const manifest = R.buildManifest({
      notice: { ...fresh, rule_set_name: active.name }, version: { ...version, published_at: publishedAt },
      attachments: attRefs, datesSnapshot, renderedKey, ruleSet: active,
    });
    manifest.snapshot_key = snapKey;
    manifest.legal_note = legalNote();
    manifest.manifest_sha256 = R.signManifest(manifest);
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    // 内容寻址：同版本再次发布（原地编辑后再版）渲染结果/清单必然不同，绝不覆盖旧固定对象
    const manifestKey = `manifests/${fresh.id}/v${version.ver}-${obj.sha256(manifestBuf).slice(0, 16)}.json`;
    await obj.putObject(manifestKey, manifestBuf);

    const pubUuid = fresh.public_uuid || uuid();
    const isFirst = !fresh.public_uuid;
    db.run(`INSERT INTO publications (id,notice_id,version_id,ver,rendered_key,manifest_key,attachment_summary,fingerprint,rule_set_id,rule_set_version,cache_epoch,published_at,published_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuid(), fresh.id, version.id, version.ver, renderedKey, manifestKey,
       JSON.stringify(manifest.attachment_summary), version.fingerprint, active.id, active.version,
       (fresh.chain_epoch || 0) + 1, publishedAt, user.username]);
    db.run(`UPDATE notices SET status='published', public_uuid=?, published_at=?, published_by=?, current_version=?, updated_at=? WHERE id=?`,
      [pubUuid, publishedAt, user.username, version.ver, now(), fresh.id]);
    db.run("UPDATE notice_versions SET public_uuid=?, published_at=? WHERE id=?", [pubUuid, publishedAt, version.id]);

    // 更正公告发布 => 原公告标记 superseded
    if (fresh.kind === 'amendment' && fresh.supersedes_id) {
      const origin = db.get('SELECT * FROM notices WHERE id=?', [fresh.supersedes_id]);
      if (origin && origin.status === 'published') {
        db.run("UPDATE notices SET status='superseded' WHERE id=?", [origin.id]);
      }
    }
    const after = db.get('SELECT * FROM notices WHERE id=?', [fresh.id]);
    bumpChain(db, db, after);
    invalidateNotice(after);
    logTransition(db, { notice_id: fresh.id, version_id: version.id, action: 'publish', actor: user.username, from: fresh.status, to: 'published', detail: `v${version.ver} mode=${isFirst ? 'initial' : (fresh.kind === 'amendment' ? 'amendment' : 'in-place')}` });
    return json(res, 200, {
      ok: true, public_url: `/p/${pubUuid}`, public_uuid: pubUuid, rendered_key: renderedKey,
      manifest_key: manifestKey, mode: isFirst ? 'initial' : (fresh.kind === 'amendment' ? 'amendment-chain' : 'in-place-replace'),
      legalNote: legalNote(),
    });
  });
}

// ---------------- 公开页（缓存 + 链状态 + 旧链接有效状态） ----------------
async function publicNotice(req, res, db, pubUuid) {
  const inm = req.headers['if-none-match'];
  const cached = publicCache.get(pubUuid);
  const live = db.get('SELECT * FROM notices WHERE public_uuid=?', [pubUuid]);
  if (!live) return fail(res, 404, '公告不存在或尚未公开');
  const epoch = live.chain_epoch;
  if (cached && cached.epoch === epoch) {
    if (inm === cached.etag) { res.writeHead(304, { etag: cached.etag }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', etag: cached.etag, 'x-cache': 'HIT' });
    return res.end(JSON.stringify(cached.payload));
  }
  const pub = db.get('SELECT * FROM publications WHERE notice_id=? ORDER BY published_at DESC LIMIT 1', [live.id]);
  const chain = db.all('SELECT id,title,status,kind,supersedes_id,public_uuid,published_at,current_version FROM notices WHERE chain_id=? ORDER BY published_at, created_at', [live.chain_id]);
  let html = null;
  try { const r = await obj.getObjectRaw(pub.rendered_key); html = r.body.toString('utf8'); } catch { html = '<p>渲染文件缺失，请联系管理员按发布清单重建。</p>'; }
  const statusMap = { published: '现行有效', superseded: '已被更正公告取代', withdrawn: '已撤回' };
  const banner = `<div class="banner ${live.status}"><strong>有效状态：${statusMap[live.status] || live.status}</strong>` +
    (live.status === 'withdrawn' ? `（撤回原因：${live.withdraw_reason || '—'}）` : '') + '</div>';
  html = html.replace(/<body>/, '<body>\n' + banner + chainNav(chain, live));
  const payload = {
    uuid: pubUuid, status: live.status, status_text: statusMap[live.status] || live.status,
    title: live.title, current_version: live.current_version, kind: live.kind,
    published_at: pub && pub.published_at, withdrawn_at: live.withdrawn_at,
    withdraw_reason: live.withdraw_reason, rendered_key: pub && pub.rendered_key,
    manifest_key: pub && pub.manifest_key, chain: chain, html,
  };
  const etag = '"' + crypto.createHash('sha256').update(JSON.stringify({ ...payload, html: '' }) + epoch).digest('hex').slice(0, 16) + '"';
  publicCache.set(pubUuid, { etag, epoch, payload });
  if (inm === etag) { res.writeHead(304, { etag }); return res.end(); }
  return json(res, 200, payload, { etag, 'x-cache': 'MISS' });
}
function chainNav(chain, current) {
  const links = chain.map((m) => {
    const tag = { published: '现行', superseded: '被取代', withdrawn: '已撤回' }[m.status] || m.status;
    const name = (m.kind === 'amendment' ? '更正公告：' : '原公告：') + (m.title || m.id) + `（${tag} v${m.current_version}）`;
    if (m.id === current.id) return `<li><strong>▶ ${name}</strong></li>`;
    if (m.public_uuid) return `<li><a href="/p/${m.public_uuid}">${name}</a></li>`;
    return `<li>${name}（未公开）</li>`;
  }).join('');
  return `<nav class="meta"><strong>替代链导航：</strong><ul>${links}</ul><p>旧公告链接持续可访问，并清楚标示其当前有效状态。</p></nav>`;
}

// ---------------- 按发布清单重建 ----------------
async function rebuildFromManifest(res, db, manifestKey) {
  if (!manifestKey) return fail(res, 400, 'manifest_key 必填');
  const mResp = await obj.getObjectRaw(manifestKey);
  const manifest = JSON.parse(mResp.body.toString('utf8'));
  const sResp = await obj.getObjectRaw(manifest.snapshot_key);
  const snapshot = JSON.parse(sResp.body.toString('utf8'));
  const notice = db.get('SELECT * FROM notices WHERE id=?', [manifest.notice_id]);
  const rule = db.get('SELECT * FROM rule_sets WHERE id=? AND version=?', [manifest.rule_set.id, manifest.rule_set.version]);
  const cfg = JSON.parse(rule.config);
  const html = R.renderVersion({
    notice: { ...notice, rule_set_name: manifest.rule_set.name },
    version: { ver: manifest.ver, snapshot }, attachments: manifest.attachment_summary,
    datesSnapshot: manifest.dates_snapshot, ruleConfig: cfg, publishedAt: manifest.published_at, statusLine: '',
  });
  const rebuiltBuf = Buffer.from(html, 'utf8');
  const rebuiltKey = `rebuilt/${manifest.notice_id}/v${manifest.ver}/${crypto.createHash('sha256').update(rebuiltBuf).digest('hex')}.html`;
  await obj.putObject(rebuiltKey, rebuiltBuf);
  const origResp = await obj.getObjectRaw(manifest.rendered_key);
  const origHash = obj.sha256(origResp.body);
  const rebuiltHash = obj.sha256(rebuiltBuf);
  // 附件固定对象复核
  const attChecks = [];
  for (const a of manifest.attachment_summary) {
    const h = await obj.headObject(a.object_key);
    attChecks.push({ slot: a.slot, filename: a.filename, expected: a.sha256, actual: h.headers['x-object-sha256'], match: h.headers['x-object-sha256'] === a.sha256 });
  }
  const manifestHashOk = R.signManifest(manifest) === manifest.manifest_sha256;
  return json(res, 200, {
    ok: origHash === rebuiltHash, rebuilt_key: rebuiltKey,
    rendered_match: origHash === rebuiltHash,
    original_sha256: origHash, rebuilt_sha256: rebuiltHash,
    manifest_sha_match: manifestHashOk,
    attachments_verified: attChecks,
    note: '重建仅依据发布清单+固定对象，不依赖可变数据库正文；',
  });
}

module.exports = { createHandler, publicCache };
