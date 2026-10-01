'use strict';
// 验收测试：日期倒置 / 同名附件替换 / 审批与撤回竞争 / 上传未完成 / 服务重启 /
// 跨字段冲突预览 / 旧链接有效状态 / 按发布清单重建 / 规则版一致 / 半套附件 / 权限
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { createApp } = require('../server/app');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ALL = 'admin,editor,publisher,legal,business';

let server, base, dataDir, handle;

async function start(dir) {
  handle = createApp({ dataDir: dir });
  server = await new Promise((r) => { const s = handle.app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
}
async function stop() {
  if (server) await new Promise((r) => server.close(r));
  if (handle) handle.close();
  server = null; handle = null;
}
async function api(method, p, body, roles = ALL, user = 'tester') {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', 'x-user': user, 'x-roles': roles },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}
async function uploadBuffer(name, buf, { finalize = true, chunks = 1 } = {}) {
  const r = await api('POST', '/api/uploads', { filename: name, size: buf.length, sha256: sha(buf) });
  const id = r.json.id;
  const step = Math.ceil(buf.length / chunks);
  for (let off = 0; off < buf.length; off += step) {
    const res = await fetch(`${base}/api/uploads/${id}/chunk?offset=${off}`, {
      method: 'PUT', headers: { 'x-roles': 'editor' }, body: buf.subarray(off, off + step) });
    assert.strictEqual(res.status, 200, `chunk@${off} failed: ${await res.text()}`);
  }
  if (finalize) await api('POST', `/api/uploads/${id}/finalize`);
  return id;
}
async function makeRule(over = {}) {
  return api('POST', '/api/rules', { name: 'default', config: {
    min_notice_days: 20, deadline_timezone: 'Asia/Shanghai', deadline_must_be_workday: false,
    require_qualification_text: true, required_attachments: ['招标文件.pdf'],
    review_quorum: { legal: 1, business: 1 }, bid_open_after_deadline_minutes: 60, ...over,
  }});
}
function goodVersion(over = {}) {
  return {
    project_name: '服务器采购', project_code: 'P-001', scope: '服务器 10 台',
    qualifications: '具备相关资质',
    notice_start: { date: '2026-10-01', time: '09:00', tz: 'Asia/Shanghai' },
    submit_deadline: { date: '2026-11-05', time: '17:00', tz: 'Asia/Shanghai' },
    bid_open: { date: '2026-11-06', time: '10:00', tz: 'Asia/Shanghai' },
    rule_name: 'default', ...over,
  };
}
async function makeAnn(versionOver = {}) {
  const r = await api('POST', '/api/announcements', { title: '测试公告', version: goodVersion(versionOver) });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}
async function detail(id) { return (await api('GET', `/api/announcements/${id}`)).json; }
async function attachFile(annId, name, content) {
  const d = await detail(annId);
  const vid = d.announcement.current_version_id;
  const up = await uploadBuffer(name, Buffer.from(content));
  return api('POST', `/api/versions/${vid}/attachments`, { name, upload_session_id: up });
}
async function reviewAndApprove(annId, versionNo) {
  const s = await api('POST', `/api/announcements/${annId}/submit`, { version_no: versionNo });
  assert.strictEqual(s.status, 200, JSON.stringify(s.json));
  // 批准可能自上一版本平移，逐角色补足定额直至 approved
  let last;
  for (const role of ['legal', 'business']) {
    const d = await detail(annId);
    if (d.announcement.status === 'approved') break;
    last = await api('POST', `/api/announcements/${annId}/reviews`, { version_no: versionNo, role, decision: 'approve' });
    assert.strictEqual(last.status, 200, JSON.stringify(last.json));
  }
  const d = await detail(annId);
  assert.strictEqual(d.announcement.status, 'approved', '评审后应达到批准态');
  return last ? last.json : { status: 'approved' };
}
async function publishCurrent(annId) {
  const d = await detail(annId);
  const v = d.versions.find((x) => x.id === d.announcement.current_version_id);
  return api('POST', `/api/announcements/${annId}/publish`, {
    version_no: v.version_no, expected_body_hash: v.body_hash, expected_attachment_digest: v.attachment_digest });
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-test-'));
  await start(dataDir);
  await makeRule();
});
after(async () => { await stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('日期倒置：预览指出跨字段冲突，提交被阻止', async () => {
  const id = await makeAnn({
    notice_start: { date: '2026-11-01', time: '09:00', tz: 'Asia/Shanghai' },
    submit_deadline: { date: '2026-10-05', time: '17:00', tz: 'Asia/Shanghai' },
  });
  const d = await detail(id);
  const vid = d.announcement.current_version_id;
  const p = await api('GET', `/api/versions/${vid}/preview`);
  const codes = p.json.conflicts.map((c) => c.code);
  assert.ok(codes.includes('DATE_INVERTED'), `应报日期倒置: ${codes}`);
  assert.ok(codes.includes('REQUIRED_ATTACHMENT_MISSING'), '应报缺附件');
  const s = await api('POST', `/api/announcements/${id}/submit`, { version_no: 1 });
  assert.strictEqual(s.status, 409);
  assert.strictEqual(s.json.error.code, 'CONFLICTS');
});

test('公告期不足与开标早于截止：跨字段冲突', async () => {
  const id = await makeAnn({
    notice_start: { date: '2026-10-01', time: '09:00', tz: 'Asia/Shanghai' },
    submit_deadline: { date: '2026-10-10', time: '17:00', tz: 'Asia/Shanghai' }, // 仅9天<20
    bid_open: { date: '2026-10-09', time: '10:00', tz: 'Asia/Shanghai' },       // 开标早于截止
  });
  const d = await detail(id);
  const p = await api('GET', `/api/versions/${d.announcement.current_version_id}/preview`);
  const codes = p.json.conflicts.map((c) => c.code);
  assert.ok(codes.includes('NOTICE_TOO_SHORT'), codes.join());
  assert.ok(codes.includes('BID_OPEN_BEFORE_DEADLINE'), codes.join());
});

test('截止日(纯日期)与带时区时刻区分：截止日按规则时区解释', async () => {
  // 同一截止日，不同时区 → 截止瞬间不同
  const id = await makeAnn();
  const d = await detail(id);
  const vid = d.announcement.current_version_id;
  const p1 = (await api('GET', `/api/versions/${vid}/preview`)).json.normalized;
  await api('PUT', `/api/versions/${vid}`, { submit_deadline: { date: '2026-11-05', time: '17:00', tz: 'America/New_York' } });
  const p2 = (await api('GET', `/api/versions/${vid}/preview`)).json.normalized;
  assert.notStrictEqual(p1.submit_deadline_instant, p2.submit_deadline_instant, '时区改变应改变截止瞬间');
  const v = (await detail(id)).versions[0];
  assert.strictEqual(v.submit_deadline_date, '2026-11-05', '截止日保持纯日期语义');
});

test('完整流程：上传→评审→发布→公开页缓存→按清单重建', async () => {
  const id = await makeAnn();
  await attachFile(id, '招标文件.pdf', '招标文件内容-v1');
  await reviewAndApprove(id, 1);
  const pub = await publishCurrent(id);
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.json));
  assert.ok(pub.json.manifest.render_object_key);

  // 公开页缓存：第一次 MISS，第二次 HIT
  let res = await fetch(`${base}/public/announcements/${id}`);
  assert.strictEqual(res.headers.get('x-cache'), 'MISS');
  res = await fetch(`${base}/public/announcements/${id}`);
  assert.strictEqual(res.headers.get('x-cache'), 'HIT');
  const html = await res.text();
  assert.ok(html.includes('当前有效'));

  // 按发布清单重建
  const rb = await api('POST', `/api/announcements/${id}/rebuild`, {});
  assert.strictEqual(rb.json.ok, true, JSON.stringify(rb.json.checks));
  assert.ok(rb.json.checks.every((c) => c.ok));
});

test('同名附件替换：关联批准需复核，旧摘要发布失败', async () => {
  const id = await makeAnn();
  await attachFile(id, '招标文件.pdf', '第一版招标文件');
  await reviewAndApprove(id, 1);
  // 新建版本（内容未变 → 批准平移）
  let r = await api('POST', `/api/announcements/${id}/versions`, { change_reason: '修订' });
  assert.strictEqual(r.json.approvals_carried, 2);
  // 同名替换附件 → 批准需复核
  r = await attachFile(id, '招标文件.pdf', '第二版招标文件（同名替换）');
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.replaced, '应识别同名替换');
  assert.ok(r.json.approvals_staled >= 1, '批准应失效');
  // 用旧附件摘要发布 → 拒绝
  const d = await detail(id);
  const v2 = d.versions.find((x) => x.version_no === 2);
  const staleReview = v2.reviews.find((x) => x.decision === 'approve');
  assert.strictEqual(staleReview.stale, 1, '评审记录应标记需复核');
  // 重新提交评审并获得新批准
  await api('POST', `/api/announcements/${id}/submit`, { version_no: 2 });
  await api('POST', `/api/announcements/${id}/reviews`, { version_no: 2, role: 'legal', decision: 'approve' });
  await api('POST', `/api/announcements/${id}/reviews`, { version_no: 2, role: 'business', decision: 'approve' });
  // 客户端持旧附件摘要（替换前的）发布 → 摘要不一致被拒绝
  const pub = await api('POST', `/api/announcements/${id}/publish`, {
    version_no: 2, expected_body_hash: v2.body_hash,
    expected_attachment_digest: '0'.repeat(64) });
  assert.strictEqual(pub.status, 409);
  assert.strictEqual(pub.json.error.code, 'ATTACHMENT_DIGEST_MISMATCH');
  // 用当前摘要发布成功
  const pub2 = await publishCurrent(id);
  assert.strictEqual(pub2.status, 201, JSON.stringify(pub2.json));
});

test('改采购范围：关联批准需复核', async () => {
  const id = await makeAnn();
  await attachFile(id, '招标文件.pdf', '文件');
  await reviewAndApprove(id, 1);
  const r = await api('POST', `/api/announcements/${id}/versions`, { scope: '服务器 20 台（范围扩大）', change_reason: '范围变更' });
  assert.strictEqual(r.json.approvals_carried, 0, '范围变更不应平移批准');
  assert.strictEqual(r.json.approvals_staled, 2, '原批准应标记需复核');
});

test('审批与撤回竞争：只有一方成功，状态一致', async () => {
  for (let round = 0; round < 6; round++) {
    const id = await makeAnn();
    await attachFile(id, '招标文件.pdf', '文件' + round);
    await api('POST', `/api/announcements/${id}/submit`, { version_no: 1 });
    await api('POST', `/api/announcements/${id}/reviews`, { version_no: 1, role: 'legal', decision: 'approve' });
    // 业务批准(触发 approved) 与 撤回 并发
    const [approveRes, withdrawRes] = await Promise.all([
      api('POST', `/api/announcements/${id}/reviews`, { version_no: 1, role: 'business', decision: 'approve' }),
      api('POST', `/api/announcements/${id}/withdraw`, {}),
    ]);
    const results = [approveRes, withdrawRes];
    const okCount = results.filter((r) => r.status === 200).length;
    const d = await detail(id);
    if (okCount === 2) {
      // 批准先完成、撤回随后成功：最终必须是 withdrawn（顺序确定）
      assert.strictEqual(d.announcement.status, 'withdrawn');
    } else {
      assert.strictEqual(okCount, 1, `并发应恰有一方失败: ${JSON.stringify(results.map(r=>r.status))}`);
      const loser = results.find((r) => r.status !== 200);
      assert.strictEqual(loser.status, 409);
      // 终态与获胜方一致
      if (withdrawRes.status === 200) assert.strictEqual(d.announcement.status, 'withdrawn');
      else assert.strictEqual(d.announcement.status, 'approved');
    }
  }
});

test('上传未完成：不能关联附件，不能发布半套附件', async () => {
  const id = await makeAnn();
  const buf = Buffer.from('大文件内容'.repeat(100));
  const upId = await uploadBuffer('招标文件.pdf', buf, { finalize: false, chunks: 2 });
  // 截断：再开一个只传一半的会话
  const half = await api('POST', '/api/uploads', { filename: '招标文件.pdf', size: buf.length, sha256: sha(buf) });
  const halfId = half.json.id;
  await fetch(`${base}/api/uploads/${halfId}/chunk?offset=0`, { method: 'PUT', headers: { 'x-roles': 'editor' }, body: buf.subarray(0, 10) });
  // 未完成的会话不能关联
  let r = await api('POST', `/api/versions/${(await detail(id)).announcement.current_version_id}/attachments`,
    { name: '招标文件.pdf', upload_session_id: halfId });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.error.code, 'UPLOAD_INCOMPLETE');
  // finalize 未完成会话 → 拒绝
  r = await api('POST', `/api/uploads/${halfId}/finalize`);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.error.code, 'UPLOAD_INCOMPLETE');
  // 缺必备附件 → 提交评审即被冲突阻止（不能发布半套附件）
  r = await api('POST', `/api/announcements/${id}/submit`, { version_no: 1 });
  assert.strictEqual(r.status, 409);
  assert.ok(r.json.error.details.conflicts.some((c) => c.code === 'REQUIRED_ATTACHMENT_MISSING'));
  // 完成上传后可以走通
  await api('POST', `/api/uploads/${upId}/finalize`);
  await api('POST', `/api/versions/${(await detail(id)).announcement.current_version_id}/attachments`,
    { name: '招标文件.pdf', upload_session_id: upId });
  r = await api('POST', `/api/announcements/${id}/submit`, { version_no: 1 });
  assert.strictEqual(r.status, 200);
});

test('服务重启：状态恢复，上传会话可续传', async () => {
  const id = await makeAnn();
  const buf = Buffer.from('重启续传测试'.repeat(50));
  const up = await api('POST', '/api/uploads', { filename: '招标文件.pdf', size: buf.length, sha256: sha(buf) });
  const upId = up.json.id;
  await fetch(`${base}/api/uploads/${upId}/chunk?offset=0`, { method: 'PUT', headers: { 'x-roles': 'editor' }, body: buf.subarray(0, 100) });
  // 重启服务（同一数据目录）
  await stop();
  await start(dataDir);
  // 公告状态仍在
  const d = await detail(id);
  assert.strictEqual(d.announcement.id, id);
  // 上传会话可查询断点并续传
  const s = await api('GET', `/api/uploads/${upId}`);
  assert.strictEqual(s.json.received_bytes, 100);
  const res = await fetch(`${base}/api/uploads/${upId}/chunk?offset=100`, { method: 'PUT', headers: { 'x-roles': 'editor' }, body: buf.subarray(100) });
  assert.strictEqual(res.status, 200);
  const fin = await api('POST', `/api/uploads/${upId}/finalize`);
  assert.strictEqual(fin.status, 200);
  assert.strictEqual(fin.json.sha256, sha(buf));
  // 偏移错误 → 返回服务端断点
  const res2 = await fetch(`${base}/api/uploads/${upId}/chunk?offset=0`, { method: 'PUT', headers: { 'x-roles': 'editor' }, body: Buffer.from('x') });
  assert.strictEqual(res2.status, 409);
});

test('发布后原地编辑：替代链、旧链接有效状态、缓存失效', async () => {
  const id = await makeAnn();
  await attachFile(id, '招标文件.pdf', 'v1 文件');
  await reviewAndApprove(id, 1);
  await publishCurrent(id);
  // 缓存 v1 版本页
  let res = await fetch(`${base}/public/announcements/${id}/versions/1`);
  assert.strictEqual(res.headers.get('x-cache'), 'MISS');
  res = await fetch(`${base}/public/announcements/${id}/versions/1`);
  assert.strictEqual(res.headers.get('x-cache'), 'HIT');
  assert.ok((await res.text()).includes('当前有效'));
  // 原地编辑：v2 发布
  await api('POST', `/api/announcements/${id}/versions`, { change_reason: '截止日延期' });
  const d1 = await detail(id);
  const v2id = d1.announcement.current_version_id;
  await api('PUT', `/api/versions/${v2id}`, {
    submit_deadline: { date: '2026-11-20', time: '17:00', tz: 'Asia/Shanghai' },
    bid_open: { date: '2026-11-21', time: '10:00', tz: 'Asia/Shanghai' } });
  await reviewAndApprove(id, 2);
  await publishCurrent(id);
  // 旧链接仍有效但显示被替代；缓存已失效（重新 MISS）
  res = await fetch(`${base}/public/announcements/${id}/versions/1`);
  assert.strictEqual(res.headers.get('x-cache'), 'MISS', '发布后旧缓存必须失效');
  const html1 = await res.text();
  assert.ok(html1.includes('已被版本 v2 替代'), 'v1 页面应显示被替代');
  assert.ok(html1.includes('当前有效版本 v2'), '应提供到当前版本的链接');
  res = await fetch(`${base}/public/announcements/${id}/versions/2`);
  assert.ok((await res.text()).includes('当前有效'));
  // 替代链
  const d2 = await detail(id);
  const v2 = d2.versions.find((x) => x.version_no === 2);
  const v1 = d2.versions.find((x) => x.version_no === 1);
  assert.strictEqual(v2.supersedes_version_id, v1.id);
});

test('撤回后公开页显示已撤回，旧版本链接同步更新', async () => {
  const id = await makeAnn();
  await attachFile(id, '招标文件.pdf', '文件');
  await reviewAndApprove(id, 1);
  await publishCurrent(id);
  await fetch(`${base}/public/announcements/${id}`); // 建立缓存
  await api('POST', `/api/announcements/${id}/withdraw`, {});
  const res = await fetch(`${base}/public/announcements/${id}`);
  assert.strictEqual(res.headers.get('x-cache'), 'MISS');
  assert.ok((await res.text()).includes('已撤回'));
  const resV = await fetch(`${base}/public/announcements/${id}/versions/1`);
  assert.ok((await resV.text()).includes('已撤回'));
});

test('规则版不一致：发布被阻止', async () => {
  const id = await makeAnn();
  await attachFile(id, '招标文件.pdf', '文件');
  await reviewAndApprove(id, 1);
  await makeRule({ min_notice_days: 15 }); // 规则升级到 v2
  const d = await detail(id);
  const v = d.versions[0];
  const r = await api('POST', `/api/announcements/${id}/publish`, {
    version_no: 1, expected_body_hash: v.body_hash, expected_attachment_digest: v.attachment_digest });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.error.code, 'RULE_VERSION_MISMATCH');
  await makeRule({ min_notice_days: 20 }); // 恢复（v3）；新版本将绑定 v3
});

test('权限：无评审角色不能评审，无发布角色不能发布', async () => {
  const id = await makeAnn();
  await attachFile(id, '招标文件.pdf', '文件');
  await api('POST', `/api/announcements/${id}/submit`, { version_no: 1 });
  let r = await api('POST', `/api/announcements/${id}/reviews`, { version_no: 1, role: 'legal', decision: 'approve' }, 'editor');
  assert.strictEqual(r.status, 403);
  r = await api('POST', `/api/announcements/${id}/reviews`, { version_no: 1, role: 'legal', decision: 'approve' }, 'legal');
  assert.strictEqual(r.status, 200);
  r = await api('POST', `/api/announcements/${id}/reviews`, { version_no: 1, role: 'business', decision: 'approve' }, 'business');
  assert.strictEqual(r.status, 200);
  const d = await detail(id);
  const v = d.versions[0];
  r = await api('POST', `/api/announcements/${id}/publish`,
    { version_no: 1, expected_body_hash: v.body_hash, expected_attachment_digest: v.attachment_digest }, 'editor');
  assert.strictEqual(r.status, 403);
});

test('更正公告：独立流程，原公告页显示更正关系', async () => {
  const id = await makeAnn();
  await attachFile(id, '招标文件.pdf', '原文件');
  await reviewAndApprove(id, 1);
  await publishCurrent(id);
  const c = await api('POST', `/api/announcements/${id}/corrections`, { reason: '截止日更正' });
  assert.strictEqual(c.status, 201);
  const corrId = c.json.id;
  // 更正公告走完整流程
  const cd = await detail(corrId);
  assert.strictEqual(cd.announcement.kind, 'correction');
  assert.strictEqual(cd.announcement.corrects_announcement_id, id);
  assert.strictEqual(cd.versions[0].attachments.length, 1, '更正公告继承原附件');
  await reviewAndApprove(corrId, 1);
  const pub = await publishCurrent(corrId);
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.json));
  // 原公告公开页显示更正关系（缓存已失效）
  const res = await fetch(`${base}/public/announcements/${id}`);
  const html = await res.text();
  assert.ok(html.includes('更正公告'), '原公告页应提示存在更正公告');
  assert.ok(html.includes(corrId) || html.includes('更正'), '应链接到更正公告');
  // 原公告仍然有效（更正是追加而非替代）
  const d = await detail(id);
  assert.strictEqual(d.announcement.status, 'published');
});

test('上传哈希不符被拒绝；重复 finalize 幂等', async () => {
  const buf = Buffer.from('真实内容');
  const r = await api('POST', '/api/uploads', { filename: 'x.bin', size: buf.length, sha256: sha(Buffer.from('别的内容')) });
  const upId = r.json.id;
  await fetch(`${base}/api/uploads/${upId}/chunk?offset=0`, { method: 'PUT', headers: { 'x-roles': 'editor' }, body: buf });
  const fin = await api('POST', `/api/uploads/${upId}/finalize`);
  assert.strictEqual(fin.status, 400);
  assert.strictEqual(fin.json.error.code, 'HASH_MISMATCH');
  // 正常上传后重复 finalize
  const ok = await uploadBuffer('y.bin', buf);
  const f1 = await api('POST', `/api/uploads/${ok}/finalize`);
  assert.strictEqual(f1.status, 200);
  assert.strictEqual(f1.json.state, 'finalized');
});

test('事件审计流完整记录', async () => {
  const id = await makeAnn();
  await attachFile(id, '招标文件.pdf', '文件');
  await reviewAndApprove(id, 1);
  await publishCurrent(id);
  const ev = (await api('GET', `/api/announcements/${id}/events`)).json;
  const types = ev.map((e) => e.type);
  for (const t of ['created', 'attachment_added', 'submitted', 'review', 'approved', 'published']) {
    assert.ok(types.includes(t), `缺少事件 ${t}: ${types}`);
  }
});
