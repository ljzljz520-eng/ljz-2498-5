'use strict';
// 日期模型：严格区分两类
//   date    —— 截止日：日历日期 "YYYY-MM-DD"（无时分秒、无时区，如投标截止日）
//   instant —— 带时区时刻：RFC3339 "YYYY-MM-DDTHH:mm:ss±HH:MM"（如开标时刻）
// 日期依赖来自"用户配置的公告规则"（rule_sets.config.slots）。
const VALID_SLOT_TYPES = ['date', 'instant'];

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function isValidInstant(s) {
  if (typeof s !== 'string') return false;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)([+-]\d{2}:\d{2}|Z)$/);
  if (!m) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}
// 把 instant 归一到某个时区的日历日（用于"截止日 vs 开标时刻"比较）
function instantDateInZone(instant, offsetMinutes) {
  const ms = new Date(instant).getTime() + offsetMinutes * 60000;
  return new Date(ms).toISOString().slice(0, 10);
}
function zoneOffsetMinutes(tz) {
  // tz 形如 +08:00 / -05:30；按公告规则里配置的偏移解释
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(tz || '+08:00');
  if (!m) return 480;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}
function validateSlotValue(slot, value) {
  if (value == null || value === '') return true; // 允许留空，由 required 校验
  return slot.type === 'date' ? isValidDate(value) : isValidInstant(value);
}

// 根据规则配置与录入值计算日期快照。anchor = 发布日(date)，用于 relative 槽位。
function computeDates(ruleConfig, values, anchorDate) {
  const out = {};
  for (const slot of ruleConfig.slots || []) {
    const v = values[slot.key];
    if (v == null || v === '') { out[slot.key] = null; continue; }
    if (slot.mode === 'manual' || !anchorDate) { out[slot.key] = v; continue; }
    // relative: anchor + offsetDays（仅 date 槽位支持相对推导；instant 保留录入）
    if (slot.type === 'date' && Number.isInteger(slot.offsetDays)) {
      const base = new Date(anchorDate + 'T00:00:00Z');
      base.setUTCDate(base.getUTCDate() + slot.offsetDays);
      out[slot.key] = base.toISOString().slice(0, 10);
    } else {
      out[slot.key] = v;
    }
  }
  return out;
}

/*
 * 跨字段冲突检测（预览）。返回 { errors:[], warnings:[] }
 * errors   —— 阻止发布：类型错误、日期倒置等
 * warnings —— 提醒：跨字段语义可疑、类型与预期不符
 */
function previewConflicts(notice, ruleConfig) {
  const errors = [];
  const warnings = [];
  const vals = notice.date_values ? JSON.parse(notice.date_values) : {};
  const slots = (ruleConfig.slots || []);
  const byKey = Object.fromEntries(slots.map((s) => [s.key, s]));

  // 1) 类型/格式校验 + 必需项
  for (const slot of slots) {
    const v = vals[slot.key];
    if ((v == null || v === '')) {
      if (slot.required) errors.push({ field: `dates.${slot.key}`, code: 'MISSING_REQUIRED', msg: `缺少必需日期：${slot.label}` });
      continue;
    }
    if (!validateSlotValue(slot, v)) {
      errors.push({ field: `dates.${slot.key}`, code: 'TYPE_MISMATCH', msg: `${slot.label} 不是合法${slot.type === 'date' ? '截止日(YYYY-MM-DD)' : '带时区时刻(RFC3339)'}` });
      continue;
    }
    // 录入形态与规则声明不符（如把截止日填成了时刻）
    if (slot.type === 'date' && v.includes('T')) {
      errors.push({ field: `dates.${slot.key}`, code: 'DATE_INSTANT_CONFUSION', msg: `${slot.label} 应为截止日（不含时分/时区），却录入了时刻` });
    }
    if (slot.type === 'instant' && !v.includes('T')) {
      errors.push({ field: `dates.${slot.key}`, code: 'INSTANT_DATE_CONFUSION', msg: `${slot.label} 应为带时区时刻，却只录入了日期` });
    }
  }

  // 2) 规则中声明的顺序约束 pairs: {after, before} —— 日期倒置检测
  for (const pair of ruleConfig.pairs || []) {
    const a = vals[pair.after];   // 应更晚
    const b = vals[pair.before];  // 应更早
    if (!a || !b) continue;
    const sa = byKey[pair.after];
    const sb = byKey[pair.before];
    let aDay = a, bDay = b;
    if (sa && sa.type === 'instant') aDay = instantDateInZone(a, zoneOffsetMinutes(ruleConfig.timezone));
    if (sb && sb.type === 'instant') bDay = instantDateInZone(b, zoneOffsetMinutes(ruleConfig.timezone));
    if (!isValidDate(aDay) || !isValidDate(bDay)) continue;
    if (aDay < bDay) {
      errors.push({ field: `dates.${pair.after}`, code: 'DATE_INVERSION', msg: `${sa ? sa.label : pair.after} 早于 ${sb ? sb.label : pair.before}（日期倒置）` });
    } else if (aDay === bDay) {
      // 同一天：若两个都是 instant，则比较具体时刻；否则仅警告
      if (sa && sb && sa.type === 'instant' && sb.type === 'instant'
          && isValidInstant(a) && isValidInstant(b)
          && new Date(a).getTime() <= new Date(b).getTime()) {
        errors.push({ field: `dates.${pair.after}`, code: 'INSTANT_INVERSION', msg: `${sa.label} 不晚于 ${sb.label}（时刻倒置）` });
      } else {
        warnings.push({ field: `dates.${pair.after}`, code: 'SAME_DAY', msg: `${sa ? sa.label : pair.after} 与 ${sb ? sb.label : pair.before} 在同一天，请确认时刻先后` });
      }
    }
  }

  // 3) 跨字段（非日期）：范围/资格/正文一致性
  if (notice.procurement_scope && notice.body_text) {
    const amountMention = notice.body_text.includes('金额') || /预算|最高限价/.test(notice.body_text);
    if (amountMention && !(/预算|金额|限价/.test(notice.procurement_scope))) {
      warnings.push({ field: 'body_text', code: 'SCOPE_BODY_DRIFT', msg: '正文提及预算/限价，但采购范围未体现，请核对跨字段一致性' });
    }
  }
  if (notice.qualifications && notice.body_text) {
    const certs = (notice.qualifications.match(/资质|许可|认证/g) || []).length;
    if (certs > 0 && !/资格|资质|投标人资格/.test(notice.body_text)) {
      warnings.push({ field: 'qualifications', code: 'QUAL_NOT_IN_BODY', msg: '资格要求未在正文中引用，请确认评审口径一致' });
    }
  }
  return { errors, warnings };
}

module.exports = {
  VALID_SLOT_TYPES, isValidDate, isValidInstant, validateSlotValue,
  computeDates, previewConflicts, zoneOffsetMinutes, instantDateInZone,
};
