'use strict';
const DISCLAIMER = '本系统为公告流程辅助工具，其校验与渲染结果不构成法律审查意见，不能替代专业法律审查。';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 把 UTC 瞬间格式化为指定时区的墙钟显示
function fmtInstant(iso, tz) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
    }).format(new Date(iso)) + `（${tz}）`;
  } catch {
    return `${iso}（${tz}）`;
  }
}

module.exports = { esc, fmtInstant, DISCLAIMER };
