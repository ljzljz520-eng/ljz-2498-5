'use strict';
// 规则引擎：跨字段冲突校验、评审定额、版本有效状态
const { wallToInstant, isWorkday } = require('./tz');

// 版本有效状态（旧公告链接据此显示）
function validityOf(ann, versionNo) {
  if (ann.status === 'withdrawn') return { code: 'withdrawn', label: '已撤回' };
  const pub = ann.published_version_no;
  if (pub == null) return { code: 'unpublished', label: '未发布' };
  if (pub === versionNo) return { code: 'current', label: '当前有效' };
  if (versionNo < pub) return { code: 'superseded', label: `已被版本 v${pub} 替代` };
  return { code: 'pending', label: '待发布' };
}

// 跨字段冲突：返回 [{code, severity, fields, message}]
// severity=error 阻断提交/发布；warning 仅提示
function computeConflicts(v, cfg, attachments) {
  const out = [];
  const err = (code, fields, message) => out.push({ code, severity: 'error', fields, message });
  const warn = (code, fields, message) => out.push({ code, severity: 'warning', fields, message });

  const startAt = new Date(v.notice_start_at);
  const deadlineAt = wallToInstant(v.submit_deadline_date, v.submit_deadline_time, v.deadline_tz);
  const bidOpenAt = v.bid_open_at ? new Date(v.bid_open_at) : null;

  // 日期倒置
  if (deadlineAt <= startAt) {
    err('DATE_INVERTED', ['submit_deadline', 'notice_start'],
      `投标截止时刻（${v.submit_deadline_date} ${v.submit_deadline_time} ${v.deadline_tz}）早于或等于公告开始时刻，日期倒置`);
  }
  // 公告期不足
  const days = (deadlineAt - startAt) / 86400000;
  if (cfg.min_notice_days != null && days < cfg.min_notice_days && deadlineAt > startAt) {
    err('NOTICE_TOO_SHORT', ['submit_deadline', 'notice_start'],
      `公告期 ${days.toFixed(2)} 天，少于规则「${cfg.name || ''}」要求的 ${cfg.min_notice_days} 天`);
  }
  // 开标早于截止
  if (bidOpenAt && bidOpenAt <= deadlineAt) {
    err('BID_OPEN_BEFORE_DEADLINE', ['bid_open', 'submit_deadline'], '开标时刻不晚于投标截止时刻');
  }
  // 开标间隔
  if (bidOpenAt && cfg.bid_open_after_deadline_minutes != null) {
    const gapMin = (bidOpenAt - deadlineAt) / 60000;
    if (gapMin > 0 && gapMin < cfg.bid_open_after_deadline_minutes) {
      warn('BID_OPEN_TOO_SOON', ['bid_open'],
        `开标距截止仅 ${Math.round(gapMin)} 分钟，规则建议至少 ${cfg.bid_open_after_deadline_minutes} 分钟`);
    }
  }
  // 截止日须为工作日
  if (cfg.deadline_must_be_workday && !isWorkday(v.submit_deadline_date, v.deadline_tz, cfg.holidays)) {
    err('DEADLINE_NOT_WORKDAY', ['submit_deadline'],
      `截止日 ${v.submit_deadline_date} 不是 ${v.deadline_tz} 的工作日`);
  }
  // 截止时区与规则不一致
  if (cfg.deadline_timezone && v.deadline_tz !== cfg.deadline_timezone) {
    warn('TZ_MISMATCH', ['submit_deadline'],
      `截止时区 ${v.deadline_tz} 与规则默认 ${cfg.deadline_timezone} 不一致`);
  }
  // 资格要求必填
  if (cfg.require_qualification_text && !(v.qualifications || '').trim()) {
    err('QUALIFICATIONS_REQUIRED', ['qualifications'], '规则要求填写资格要求，当前为空');
  }
  // 必备附件
  const names = new Set((attachments || []).map((a) => a.name));
  for (const req of cfg.required_attachments || []) {
    if (!names.has(req)) err('REQUIRED_ATTACHMENT_MISSING', ['attachments'], `缺少规则要求的附件「${req}」`);
  }
  // 上传未完成 → 不能发布半套附件
  for (const a of attachments || []) {
    if (a.state !== 'sealed') {
      err('ATTACHMENT_INCOMPLETE', ['attachments'], `附件「${a.name}」上传未完成（状态 ${a.state}），不能发布半套附件`);
    }
  }
  return out;
}

// 评审定额：config.review_quorum = { legal: 1, business: 1 }
function quorumStatus(cfg, reviews) {
  const required = cfg.review_quorum || {};
  const approved = {};
  for (const r of reviews) {
    if (r.decision === 'approve' && !r.stale) approved[r.role] = (approved[r.role] || 0) + 1;
  }
  const missing = {};
  for (const [role, n] of Object.entries(required)) {
    const lack = n - (approved[role] || 0);
    if (lack > 0) missing[role] = lack;
  }
  return { required, approved, missing, met: Object.keys(missing).length === 0 };
}

module.exports = { validityOf, computeConflicts, quorumStatus };
