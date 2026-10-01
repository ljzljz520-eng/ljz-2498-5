'use strict';
// 渲染器：把公告版本渲染为正式 HTML（确定性输出，用于发布与重建对比）。
const crypto = require('crypto');

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
// 极简 Markdown：标题 / 列表 / 粗体 / 段落
function mdToHtml(md) {
  const lines = String(md ?? '').split(/\r?\n/);
  const html = [];
  let inList = false;
  const inline = (t) => escapeHtml(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  for (const raw of lines) {
    const line = raw;
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (h) {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    } else if (li) {
      if (!inList) { html.push('<ul>'); inList = true; }
      html.push(`<li>${inline(li[1])}</li>`);
    } else if (line.trim() === '') {
      if (inList) { html.push('</ul>'); inList = false; }
    } else {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inList) html.push('</ul>');
  return html.join('\n');
}

function renderVersion({ notice, version, attachments, datesSnapshot, ruleConfig, publishedAt, statusLine }) {
  const v = typeof version.snapshot === 'string' ? JSON.parse(version.snapshot) : version.snapshot;
  const atts = attachments || [];
  const rows = atts.map((a) =>
    `<tr><td>${escapeHtml(a.slot)}</td><td>${escapeHtml(a.filename)}</td><td>${a.size}</td><td><code>${escapeHtml(a.sha256.slice(0, 16))}…</code></td></tr>`
  ).join('');
  const dateRows = Object.entries(datesSnapshot || {})
    .filter(([, val]) => val)
    .map(([k, val]) => {
      const slot = (ruleConfig.slots || []).find((s) => s.key === k);
      return `<tr><td>${escapeHtml(slot ? slot.label : k)}</td><td>${escapeHtml(String(val))}</td><td>${slot ? slot.type : ''}</td></tr>`;
    }).join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${escapeHtml(v.title || notice.title)}</title>
<style>body{font-family:system-ui,"Noto Sans CJK SC",sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;line-height:1.7}
.banner{padding:.6rem 1rem;border-radius:6px;margin:1rem 0}
.banner.valid{background:#e6f4ea;color:#1e6b34}.banner.superseded{background:#fdecea;color:#a02622}
.banner.withdrawn{background:#f1f3f4;color:#5f6368}
table{border-collapse:collapse;width:100%;margin:1rem 0}td,th{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}
code{font-size:.85em}.meta{color:#666;font-size:.9rem}</style></head>
<body>
${statusLine || ''}
<h1>${escapeHtml(v.title || notice.title)}</h1>
<p class="meta">项目编号：${escapeHtml(v.project_code || '')}　公告ID：${escapeHtml(notice.id)}　规则版本：${notice.rule_set_name || ''}#${notice.rule_set_version}　渲染时间：${escapeHtml(publishedAt || '')}</p>
<h2>项目名称</h2><p>${escapeHtml(v.project_name || '')}</p>
<h2>采购范围</h2><div>${mdToHtml(v.procurement_scope || '')}</div>
<h2>投标人资格</h2><div>${mdToHtml(v.qualifications || '')}</div>
<h2>关键日期</h2><table><tr><th>事项</th><th>值</th><th>类型</th></tr>${dateRows}</table>
<h2>公告正文</h2><div>${mdToHtml(v.body_text || '')}</div>
<h2>附件清单</h2><table><tr><th>槽位</th><th>文件名</th><th>字节</th><th>SHA256</th></tr>${rows}</table>
<p class="meta">本页面为系统按发布清单渲染的正式文件，可据发布清单重建。</p>
</body></html>`;
}

// 发布清单：重建正式文件所需的全部固定引用
function buildManifest({ notice, version, attachments, datesSnapshot, renderedKey, ruleSet }) {
  const manifest = {
    format: 'announcement-publication-manifest/v1',
    notice_id: notice.id,
    version_id: version.id,
    ver: version.ver,
    fingerprint: version.fingerprint,
    rule_set: { id: ruleSet.id, name: ruleSet.name, version: ruleSet.version },
    rendered_key: renderedKey,
    attachment_summary: attachments.map((a) => ({
      slot: a.slot, filename: a.filename, media_type: a.media_type,
      size: a.size, sha256: a.sha256, object_key: a.object_key,
    })),
    required_slots: JSON.parse(notice.required_slots || '[]'),
    dates_snapshot: datesSnapshot,
    published_at: version.published_at,
  };
  return manifest;
}
// 对最终清单（含 snapshot_key/legal_note）签名；校验时先剔除该字段再重算
function signManifest(manifest) {
  return crypto.createHash('sha256').update(canonical(stripSig(manifest))).digest('hex');
}
function stripSig(m) {
  const c = { ...m }; delete c.manifest_sha256; return c;
}
// 稳定序列化（跳过 undefined 字段，保证“签名时”与“从磁盘读回重算”一致）
function canonical(obj) {
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  if (obj && typeof obj === 'object') {
    return '{' + Object.keys(obj).sort().filter((k) => obj[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
  }
  return JSON.stringify(obj);
}
module.exports = { renderVersion, buildManifest, signManifest, stripSig, canonical, mdToHtml, escapeHtml };
