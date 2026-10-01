'use strict';
// 渲染：正式文件(确定性，可重建) + 公开页(含有效状态横幅)
const { esc, fmtInstant, DISCLAIMER } = require('./render_util');

// 正式文件：仅依赖版本数据 + 发布清单，确定性输出，可按清单重建
function renderOfficialHtml({ ann, ver, ruleName, atts, manifest }) {
  const attRows = atts.map((a) =>
    `<tr><td>${esc(a.name)}</td><td>${a.size}</td><td><code>${a.sha256}</code></td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(ann.title)}</title>
<style>body{font-family:system-ui,"Noto Sans CJK SC",sans-serif;max-width:880px;margin:0 auto;padding:24px;color:#222}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 10px;text-align:left}
h1{font-size:22px}h2{font-size:17px;border-bottom:2px solid #2456a6;padding-bottom:4px}
.meta{color:#555;font-size:13px}.disc{background:#fff8e1;border:1px solid #e0c060;padding:8px 12px;font-size:13px;margin-top:24px}
code{font-size:12px;word-break:break-all}</style></head><body>
<h1>${esc(ann.title)}</h1>
<p class="meta">公告编号 ${esc(ann.id)} ｜ 版本 v${ver.version_no} ｜ 依据规则 ${esc(ruleName)} v${ver.rule_version} ｜ 发布于 ${esc(manifest.published_at)}</p>
<h2>项目</h2><p>${esc(ver.project_name)}（${esc(ver.project_code || '无编号')}）</p>
<h2>采购范围</h2><p>${esc(ver.scope).replace(/\n/g, '<br>')}</p>
<h2>资格要求</h2><p>${esc(ver.qualifications || '（未填写）').replace(/\n/g, '<br>')}</p>
<h2>日程</h2><table>
<tr><th>事项</th><th>时间</th><th>说明</th></tr>
<tr><td>公告开始</td><td>${esc(fmtInstant(ver.notice_start_at, ver.notice_start_tz))}</td><td>带时区时刻</td></tr>
<tr><td>投标截止</td><td>${esc(ver.submit_deadline_date)} ${esc(ver.submit_deadline_time)}（${esc(ver.deadline_tz)}）</td><td>截止日：纯日期 + 规则时区解释</td></tr>
${ver.bid_open_at ? `<tr><td>开标</td><td>${esc(fmtInstant(ver.bid_open_at, ver.bid_open_tz))}</td><td>带时区时刻</td></tr>` : ''}
</table>
<h2>附件（发布时固定）</h2>
<table><tr><th>名称</th><th>大小(字节)</th><th>SHA-256</th></tr>${attRows || '<tr><td colspan="3">无附件</td></tr>'}</table>
<p class="meta">正文摘要 <code>${manifest.body_hash}</code> ｜ 附件集摘要 <code>${manifest.attachment_digest}</code></p>
<div class="disc">${esc(DISCLAIMER)}</div>
</body></html>`;
}

function bannerHtml(validity, extra) {
  const colors = { current: '#1a7f37', superseded: '#9a6700', withdrawn: '#b3261e', unpublished: '#666', pending: '#666' };
  return `<div style="background:${colors[validity.code] || '#666'};color:#fff;padding:10px 16px;font-weight:600">
本版本状态：${esc(validity.label)}${extra || ''}</div>`;
}

// 公告公开页（当前视图）
function renderPublicAnnouncementPage({ ann, validity, officialHtml, versions, corrections, corrects }) {
  const hist = versions.map((v) =>
    `<li><a href="/public/announcements/${ann.id}/versions/${v.version_no}">v${v.version_no}</a> — ${esc(v.validity.label)}（${esc(v.created_at)}）</li>`).join('');
  const corr = corrections.map((c) =>
    `<li><a href="/public/announcements/${c.id}">${esc(c.title)}</a>（状态：${esc(c.status)}）</li>`).join('');
  const corrBanner = corrections.length
    ? `<div style="background:#fde7e9;border:1px solid #b3261e;padding:8px 12px;margin:8px 0">本公告存在 ${corrections.length} 份更正公告，请以更正内容为准。</div>` : '';
  const correctsBanner = corrects
    ? `<div style="background:#e8f0fe;border:1px solid #2456a6;padding:8px 12px;margin:8px 0">本公告为更正公告，更正对象：<a href="/public/announcements/${corrects.id}">${esc(corrects.title)}</a>（${esc(ann.correction_reason || '')}）</div>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(ann.title)} - 公开页</title></head><body style="margin:0;font-family:system-ui,sans-serif">
${bannerHtml(validity)}
<div style="max-width:920px;margin:0 auto;padding:16px">
${corrBanner}${correctsBanner}
${corrections.length ? `<h3>关联更正公告</h3><ul>${corr}</ul>` : ''}
${officialHtml ? `<h3>当前发布内容</h3>${officialHtml}` : '<p>本公告尚无已发布内容。</p>'}
<h3>版本历史（旧链接保持有效，并标注状态）</h3><ul>${hist || '<li>无</li>'}</ul>
<p style="color:#777;font-size:12px">${esc(DISCLAIMER)}</p>
</div></body></html>`;
}

// 指定版本公开页（旧公告链接）
function renderPublicVersionPage({ ann, ver, validity, officialHtml, prevNo, nextNo, currentPublishedNo }) {
  const links = [];
  if (prevNo != null) links.push(`<a href="/public/announcements/${ann.id}/versions/${prevNo}">← v${prevNo}</a>`);
  links.push(`<a href="/public/announcements/${ann.id}">公告主页</a>`);
  if (nextNo != null) links.push(`<a href="/public/announcements/${ann.id}/versions/${nextNo}">v${nextNo} →</a>`);
  if (currentPublishedNo != null && currentPublishedNo !== ver.version_no) {
    links.push(`<a href="/public/announcements/${ann.id}/versions/${currentPublishedNo}">当前有效版本 v${currentPublishedNo}</a>`);
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(ann.title)} v${ver.version_no}</title></head><body style="margin:0;font-family:system-ui,sans-serif">
${bannerHtml(validity)}
<div style="max-width:920px;margin:0 auto;padding:16px">
<p>${links.join(' ｜ ')}</p>
${officialHtml || '<p>该版本未曾公开发布。</p>'}
</div></body></html>`;
}

module.exports = { renderOfficialHtml, renderPublicAnnouncementPage, renderPublicVersionPage };
