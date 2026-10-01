'use strict';
// 时区工具：区分「截止日(纯日期)」与「带时区时刻」
// 截止日 = 日期 + 时间 + 时区 → 需要时才换算为时刻；时刻字段直接存 UTC 瞬间

function tzOffsetMs(timeZone, utcMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUtc - utcMs;
}

// 把「某时区的墙钟时间」换算为 UTC 瞬间（含 DST 二次校正）
function wallToInstant(date, time, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error(`无效日期: ${date}`);
  if (!/^\d{2}:\d{2}$/.test(time || '')) throw new Error(`无效时间: ${time}`);
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  const off1 = tzOffsetMs(timeZone, guess);
  let instant = guess - off1;
  const off2 = tzOffsetMs(timeZone, instant);
  if (off2 !== off1) instant = guess - off2;
  return new Date(instant);
}

function weekdayInTz(date, timeZone) {
  const noon = wallToInstant(date, '12:00', timeZone);
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(noon);
}

function isWorkday(date, timeZone, holidays) {
  const wd = weekdayInTz(date, timeZone);
  if (wd === 'Sat' || wd === 'Sun') return false;
  if ((holidays || []).includes(date)) return false;
  return true;
}

const WEEKDAY_ZH = { Mon: '一', Tue: '二', Wed: '三', Thu: '四', Fri: '五', Sat: '六', Sun: '日' };

module.exports = { wallToInstant, weekdayInTz, isWorkday, WEEKDAY_ZH };
