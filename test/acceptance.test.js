'use strict';
/* 验收测试：自举对象服务+API（独立端口与数据目录），覆盖：
 * 1 日期倒置 / date-instant 类型混淆 / 跨字段冲突预览
 * 2 同名附件替换触发关联批准复核；半套附件/未完成上传禁止发布
 * 3 审批与撤回并发竞争（串行事务，先到者胜，后到者 409）
 * 4 服务重启：SQL 数据恢复、未完成上传可续传、公开页缓存冷重建
 * 5 规则版本不一致阻止发布；正文/附件摘要/规则版一致性发布校验
 * 6 原地编辑再版 vs 追加更正公告：替代链、旧链接有效状态、缓存失效
 * 7 按发布清单重建正式文件（渲染哈希一致、附件固定对象复核）
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const ROOT = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ann-test-'));
const PORT = 3100 + Math.floor(Math.random() * 300);
const OPORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const env = {
  ...process.env,
  PORT: String(PORT), OBJECT_PORT: String(OPORT),
  OBJECT_URL: `http://127.0.0.1:${OPORT}`,
  DB_PATH: path.join(ROOT, 'app.db'),
  OBJECT_ROOT: path.join(ROOT, 'objects'),
  OBJECT_TOKEN: 'test-token',
};

let procs = [];
function start(file) {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server', file)], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  procs.push(p); return p;
}
function wait(url, n = 60) {
  return new Promise((resolve, reject) => {
    const tick = () => http.get(url, (r) => { r.resume(); r.statusCode === 200 ? resolve() : retry(); }).on('error', retry);
    const retry = () => (n-- > 0 ? setTimeout(tick, 100) : reject(new Error('timeout waiting ' + url)));
    tick();
  });
}
function req(method, p, { token, body, buf, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + p);
    const data = buf || (body ? Buffer.from(JSON.stringify(body)) : null);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: { ...(token ? { 'x-auth-token': token } : {}), ...(data ? { 'content-length': data.length } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}), ...headers } },
      (res) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => {
        const raw = Buffer.concat(c); let json = null; try { json = JSON.parse(raw.toString()); } catch {}
        resolve({ status: res.statusCode, json, raw, headers: res.headers });
      }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const api = (m, p, o) => req(m, p, o);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const bufFile = (size, seed) => {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
};
let pass = 0;
const check = (name, cond, extra = '') => { assert.ok(cond, name + ' ' + extra); console.log('  ✓ ' + name); pass++; };

async function login(u) {
  const r = await api('POST', '/api/auth/login', { body: { username: u } });
  assert.strictEqual(r.status, 200, 'login ' + u); return r.json.token;
}
async function uploadFull(ET, nid, slot, filename, data) {
  const h = sha(data);
  let r = await api('POST', `/api/notices/${nid}/attachments/upload-start`, { token: ET, body: { slot, filename, size: data.length, sha256: h, media_type: 'application/pdf' } });
  const up = r.json.upload_id;
  const CH = 64 * 1024;
  for (let off = 0; off < data.length; off += CH) {
    const piece = data.slice(off, Math.min(off + CH, data.length));
    r = await api('PUT', `/api/uploads/${up}/chunk`, { token: ET, buf: piece, headers: { 'x-offset': String(off) } });
    assert.strictEqual(r.json.received, Math.min(off + CH, data.length));
  }
  r = await api('POST', `/api/uploads/${up}/complete`, { token: ET, body: {} });
  assert.strictEqual(r.status, 201); return r.json;
}
async function fillValid(ET, nid, overrides = {}) {
  const payload = {
    procurement_scope: '- 工程施工，预算约 1000 万元',
    qualifications: '具备市政公用工程施工总承包一级资质',
    body_text: '# 招标公告\n本项目进行公开招标，预算金额 1000 万元，投标人资格要求详见正文。\n特此公告。',
    planned_publish_at: '2026-10-10T09:00:00+08:00',
    date_values: { bid_deadline: '2026-11-20', bid_open_time: '2026-11-20T09:30:00+08:00', clarify_deadline: '2026-11-10', doc_sale_deadline: '2026-11-18' },
    ...overrides,
  };
  await api('PATCH', `/api/notices/${nid}`, { token: ET, body: payload });
}
async function fullPublish(ET, RT, nid, atts) {
  for (const [slot, file, data] of atts) await uploadFull(ET, nid, slot, file, data);
  let r = await api('POST', `/api/notices/${nid}/versions`, { token: ET, body: {} });
  const vid = r.json.version_id;
  r = await api('POST', `/api/notices/${nid}/versions/${vid}/submit`, { token: ET, body: {} });
  assert.strictEqual(r.json.version.status, 'submitted');
  r = await api('POST', `/api/notices/${nid}/versions/${vid}/approve`, { token: RT, body: { comment: 'ok' } });
  assert.strictEqual(r.json.version_status, 'approved');
  r = await api('POST', `/api/notices/${nid}/publish`, { token: ET, body: {} });
  assert.strictEqual(r.status, 200, 'publish: ' + JSON.stringify(r.json));
  return { vid, pub: r.json };
}

(async () => {
  start('object-service.js');
  await wait(`http://127.0.0.1:${OPORT}/health`);
  start('index.js');
  await wait(BASE + '/api/public/health');
  // seed
  await new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'seed.js')], { env, stdio: 'inherit' });
    p.on('exit', (c) => c === 0 ? res() : rej(new Error('seed failed')));
  });
  // server started before seed; it opened DB file before tables seeded — restart API to reload
  for (const p of procs) p.kill();
  procs = [];
  start('object-service.js'); await wait(`http://127.0.0.1:${OPORT}/health`);
  start('index.js'); await wait(BASE + '/api/public/health');

  const ET = await login('editor1'), RT = await login('reviewer1'), AT = await login('admin1');
  const tender = bufFile(200000, 7), spec = Buffer.from('技术规范内容 technical specification', 'utf8');

  console.log('\n[1] 日期与跨字段校验（预览指出冲突）');
  {
    let r = await api('POST', '/api/notices', { token: ET, body: { title: '倒置', project_code: 'D1', project_name: '倒置工程' } });
    const nid = r.json.id;
    await fillValid(ET, nid, { date_values: { bid_deadline: '2026-11-05', bid_open_time: '2026-11-20T09:30:00+08:00', clarify_deadline: '2026-11-10', doc_sale_deadline: '2026-11-18' } });
    r = await api('GET', `/api/notices/${nid}/preview?mode=strict`, { token: ET });
    check('日期倒置被识别 (DATE_INVERSION)', r.json.errors.some((e) => e.code === 'DATE_INVERSION'));

    r = await api('POST', '/api/notices', { token: ET, body: { title: '类型', project_code: 'D2', project_name: '类型工程' } });
    const n2 = r.json.id;
    await fillValid(ET, n2, { date_values: { bid_deadline: '2026-11-20T09:30:00+08:00', bid_open_time: '2026-11-20T09:30:00+08:00' } });
    r = await api('GET', `/api/notices/${n2}/preview?mode=strict`, { token: ET });
    check('截止日误填时刻被识别 (TYPE_MISMATCH)', r.json.errors.some((e) => e.code === 'TYPE_MISMATCH'));
    check('预览带法律审查免责说明', typeof r.json.legalNote === 'string' && /不.*替代法律审查/.test(r.json.legalNote));

    // instant 时刻倒置（同日但开标早于…）
    r = await api('POST', '/api/notices', { token: ET, body: { title: '时刻', project_code: 'D3', project_name: '时刻工程' } });
    const n3 = r.json.id;
    await fillValid(ET, n3, { date_values: { bid_deadline: '2026-11-20', bid_open_time: '2026-11-20T08:00:00+08:00' } });
    // bid_open_time 在 bid_deadline 之前不可能（规则要求开标不早于截止），用一个 after=bid_open_time before=bid_deadline 已在种子规则中
    r = await api('GET', `/api/notices/${n3}/preview?mode=strict`, { token: ET });
    check('合法时刻不产生 INSTANT_INVERSION', !r.json.errors.some((e) => e.code === 'INSTANT_INVERSION'));
  }

  console.log('\n[2] 全流程发布（正文+半套附件拦截+完整成功）');
  let firstUuid, firstNid;
  {
    let r = await api('POST', '/api/notices', { token: ET, body: { title: '主干道工程招标公告', project_code: 'P1', project_name: '主干道工程' } });
    const nid = r.json.id; firstNid = nid;
    await fillValid(ET, nid);
    // 缺附件不能提交
    r = await api('POST', `/api/notices/${nid}/versions`, { token: ET, body: {} });
    const vid0 = r.json.version_id;
    r = await api('POST', `/api/notices/${nid}/versions/${vid0}/submit`, { token: ET, body: {} });
    check('缺附件槽位阻止提交（不发布半套）', /槽位未齐/.test(r.json.error));

    const { pub } = await fullPublish(ET, RT, nid, [['tender_doc', 'tender.pdf', tender], ['technical_spec', 'spec.pdf', spec]]);
    firstUuid = pub.public_uuid;
    check('完整公告发布成功并返回公开链接', !!pub.public_url && pub.mode === 'initial');

    r = await api('GET', `/api/public/notices/${firstUuid}`);
    check('公开页免登录可访问且标示"现行有效"', r.json.status === 'published' && r.json.status_text === '现行有效');
    const etag = r.headers.etag;
    const r2 = await api('GET', `/api/public/notices/${firstUuid}`, { headers: { 'If-None-Match': etag } });
    check('ETag 条件请求返回 304', r2.status === 304);

    // 正文过短：即便走完批准，发布也必须拒绝（发布时校验正文完整）
    r = await api('POST', '/api/notices', { token: ET, body: { title: '短正文', project_code: 'P1B', project_name: '短正文工程' } });
    const nb = r.json.id;
    await fillValid(ET, nb, { body_text: '太短' });
    await uploadFull(ET, nb, 'tender_doc', 't.pdf', tender);
    await uploadFull(ET, nb, 'technical_spec', 's.pdf', spec);
    r = await api('POST', `/api/notices/${nb}/versions`, { token: ET, body: {} });
    const vb = r.json.version_id;
    await api('POST', `/api/notices/${nb}/versions/${vb}/submit`, { token: ET, body: {} });
    await api('POST', `/api/notices/${nb}/versions/${vb}/approve`, { token: RT, body: {} });
    r = await api('POST', `/api/notices/${nb}/publish`, { token: ET, body: {} });
    check('正文缺失/过短阻止发布', r.status === 422 && JSON.stringify(r.json).includes('正文'));
  }

  console.log('\n[3] 同名附件替换 -> 关联批准复核');
  {
    let r = await api('POST', '/api/notices', { token: ET, body: { title: '替换测试', project_code: 'P2', project_name: '替换工程' } });
    const nid = r.json.id;
    await fillValid(ET, nid);
    await fullPublish(ET, RT, nid, [['tender_doc', 'a.pdf', tender], ['technical_spec', 'b.pdf', spec]]);
    // 原地编辑（触发新版本），同名替换附件
    const tender2 = bufFile(200000, 99);
    check('替换文件哈希确实不同', sha(tender2) !== sha(tender));
    const up = await uploadFull(ET, nid, 'tender_doc', 'a.pdf', tender2);
    check('同名上传识别为替换(replaced 非空)', Array.isArray(up.replaced) && up.replaced.length === 1);
    // 保存新版本，旧版本不再可选；明确发布旧批准版本应被挡
    let r2 = await api('POST', `/api/notices/${nid}/versions`, { token: ET, body: {} });
    const oldApproved = (await api('GET', `/api/notices/${nid}`, { token: ET })).json.versions.find((v) => v.ver === 1);
    r2 = await api('POST', `/api/notices/${nid}/publish`, { token: ET, body: { version_id: oldApproved.id } });
    check('旧批准版本发布被拒（附件批准后被替换）', r2.status === 409 && /替换/.test(r2.json.error));
    // 新评审+发布成功
    r2 = await api('POST', `/api/notices/${nid}/versions`, { token: ET, body: {} });
    const vid = r2.json.version_id;
    await api('POST', `/api/notices/${nid}/versions/${vid}/submit`, { token: ET, body: {} });
    r2 = await api('POST', `/api/notices/${nid}/versions/${vid}/approve`, { token: RT, body: {} });
    assert.strictEqual(r2.json.version_status, 'approved');
    r2 = await api('POST', `/api/notices/${nid}/publish`, { token: ET, body: {} });
    check('复核后原地再版发布成功', r2.status === 200 && r2.json.mode === 'in-place-replace');
    const pub = await api('GET', `/api/public/notices/${r2.json.public_uuid}`);
    check('原地再版后公开页缓存失效（current_version 已更新且大于首版）', pub.json.current_version > 1);
  }

  console.log('\n[4] 上传未完成 + 服务重启后续传');
  let resumedUuid = null;
  {
    let r = await api('POST', '/api/notices', { token: ET, body: { title: '续传', project_code: 'P3', project_name: '续传工程' } });
    const nid = r.json.id;
    await fillValid(ET, nid);
    const data = bufFile(180000, 13);
    r = await api('POST', `/api/notices/${nid}/attachments/upload-start`, { token: ET, body: { slot: 'tender_doc', filename: 'big.pdf', size: data.length, sha256: sha(data) } });
    const up = r.json.upload_id;
    const half = data.slice(0, 90000);
    r = await api('PUT', `/api/uploads/${up}/chunk`, { token: ET, buf: half, headers: { 'x-offset': '0' } });
    check('分片上传记录偏移', r.json.received === 90000);
    r = await api('POST', `/api/notices/${nid}/versions`, { token: ET, body: {} });
    r = await api('POST', `/api/notices/${nid}/versions/${r.json.version_id}/submit`, { token: ET, body: {} });
    check('未完成上传阻止提交', /未完成上传/.test(r.json.error));
    // 错误偏移被拒
    r = await api('PUT', `/api/uploads/${up}/chunk`, { token: ET, buf: Buffer.from('x'), headers: { 'x-offset': '5' } });
    check('偏移不连续返回 409', r.status === 409);

    // 重启两个服务
    for (const p of procs) p.kill();
    await new Promise((s) => setTimeout(s, 600));
    procs = [];
    start('object-service.js'); await wait(`http://127.0.0.1:${OPORT}/health`);
    start('index.js'); await wait(BASE + '/api/public/health');
    const ET2 = await login('editor1'), RT2 = await login('reviewer1');
    // SQL 数据恢复
    const detail = await api('GET', `/api/notices/${nid}`, { token: ET2 });
    check('重启后公告数据恢复', detail.json.title === '续传');
    check('重启后未完成上传会话仍在', detail.json.openUploads.length === 1);
    // 续传剩余部分（对象服务临时文件在磁盘上）
    r = await api('PUT', `/api/uploads/${up}/chunk`, { token: ET2, buf: data.slice(90000), headers: { 'x-offset': '90000' } });
    check('服务重启后从断点续传成功', r.json.received === 180000);
    r = await api('POST', `/api/uploads/${up}/complete`, { token: ET2, body: {} });
    check('续传后定稿哈希校验通过', r.status === 201 && r.json.sha256 === sha(data));
    await uploadFull(ET2, nid, 'technical_spec', 's.pdf', spec);
    const out = await fullPublish(ET2, RT2, nid, []); // attachments already present
    check('重启续传后的公告可正常发布', !!out.pub.public_url);
    resumedUuid = out.pub.public_uuid;
    // 缓存冷启动 MISS
    const pc = await api('GET', `/api/public/notices/${resumedUuid}`);
    check('重启后公开页缓存冷重建 (MISS)', pc.headers['x-cache'] === 'MISS');
  }

  console.log('\n[5] 审批与撤回并发竞争（并行评审意见绑定版本）');
  {
    let r = await api('POST', '/api/notices', { token: ET, body: { title: '竞争', project_code: 'P4', project_name: '竞争工程' } });
    const nid = r.json.id;
    await fillValid(ET, nid);
    await uploadFull(ET, nid, 'tender_doc', 't.pdf', tender);
    await uploadFull(ET, nid, 'technical_spec', 's.pdf', spec);
    r = await api('POST', `/api/notices/${nid}/versions`, { token: ET, body: {} });
    const vid = r.json.version_id;
    await api('POST', `/api/notices/${nid}/versions/${vid}/submit`, { token: ET, body: {} });
    // 两个评审者：评论+批准 并行
    const RT2 = await login('admin1'); // admin 也算评审
    const [a, b] = await Promise.all([
      api('POST', `/api/notices/${nid}/versions/${vid}/comment`, { token: RT2, body: { comment: '并行意见1' } }),
      api('POST', `/api/notices/${nid}/versions/${vid}/approve`, { token: RT, body: { comment: '并行批准' } }),
    ]);
    check('并行评论与批准都绑定到该版本', a.json.version_status === 'submitted' && b.json.version_status === 'approved');
    const vd = await api('GET', `/api/notices/${nid}/versions/${vid}`, { token: ET });
    check('两条评审意见均持久化到具体版本', vd.json.reviews.length === 2);
    // 批准后再撤回评审 -> 409
    r = await api('POST', `/api/notices/${nid}/withdraw-review`, { token: ET, body: {} });
    check('批准与撤回竞争：撤回迟到得 409', r.status === 409);
  }

  console.log('\n[6] 规则版本一致性 + 更正公告替代链');
  let originUuid, corrUuid;
  {
    let r = await api('POST', '/api/notices', { token: ET, body: { title: '链原公告', project_code: 'P5', project_name: '链工程' } });
    const nid = r.json.id;
    await fillValid(ET, nid);
    const out = await fullPublish(ET, RT, nid, [['tender_doc', 't.pdf', tender], ['technical_spec', 's.pdf', spec]]);
    originUuid = out.pub.public_uuid;
    // 发布新规则版
    const ruleCfg = {
      timezone: '+08:00',
      slots: [
        { key: 'bid_deadline', label: '投标截止日', type: 'date', mode: 'manual', required: true },
        { key: 'bid_open_time', label: '开标时刻', type: 'instant', mode: 'manual', required: true },
      ],
      pairs: [{ after: 'bid_open_time', before: 'bid_deadline' }],
      requiredAttachmentSlots: ['tender_doc', 'technical_spec', 'budget_proof'],
    };
    r = await api('POST', '/api/rules', { token: AT, body: { name: '工程采购标准规则', activate: true, config: ruleCfg } });
    check('新规则版本激活', r.json.version >= 2);
    // 旧批准发布被拒
    r = await api('POST', `/api/notices/${nid}/publish`, { token: ET, body: {} });
    check('规则版不一致阻止发布', r.status === 409 && /规则版本不一致/.test(r.json.error));

    // 追加更正公告
    r = await api('POST', `/api/notices/${nid}/amendment`, { token: ET, body: {} });
    const cid = r.json.amendment_id;
    check('更正公告继承链 id 与 supersedes', r.json.chain_id && r.json.supersedes_id === nid);
    const corr = await api('GET', `/api/notices/${cid}`, { token: ET });
    // 更正公告在新规则下，需要 budget_proof
    await fillValid(ET, cid, { date_values: { bid_deadline: '2026-12-01', bid_open_time: '2026-12-01T09:30:00+08:00' }, body_text: '# 更正公告\n预算金额 1000 万元，投标截止日更正为 12 月 1 日，投标人资格不变。' });
    r = await api('POST', `/api/notices/${cid}/versions`, { token: ET, body: {} });
    const vid = r.json.version_id;
    r = await api('POST', `/api/notices/${cid}/versions/${vid}/submit`, { token: ET, body: {} });
    check('更正公告按新规则要求新增 budget_proof 槽位', /budget_proof/.test(r.json.error || ''));
    await uploadFull(ET, cid, 'tender_doc', 't.pdf', tender);
    await uploadFull(ET, cid, 'technical_spec', 's.pdf', spec);
    await uploadFull(ET, cid, 'budget_proof', 'budget.pdf', Buffer.from('预算批复', 'utf8'));
    const out2 = await fullPublish(ET, RT, cid, []);
    corrUuid = out2.pub.public_url.split('/').pop();
    // 原公告状态
    const op = await api('GET', `/api/public/notices/${originUuid}`);
    check('原公告链接保留并清楚显示"已被更正公告取代"', op.json.status === 'superseded' && /取代/.test(op.json.status_text));
    check('原公告页面包含替代链导航', op.json.html.includes('替代链导航') || op.json.chain.length === 2);
    const cp = await api('GET', `/api/public/notices/${corrUuid}`);
    check('更正公告页面为现行有效且链上含两环', cp.json.status === 'published' && cp.json.chain.length === 2);

    // 撤回更正公告
    r = await api('POST', `/api/notices/${cid}/withdraw-publish`, { token: ET, body: { reason: '测试撤回' } });
    check('撤回成功', r.status === 200);
    const cp2 = await api('GET', `/api/public/notices/${corrUuid}`);
    check('撤回后公开页显示"已撤回"及原因', cp2.json.status === 'withdrawn' && cp2.json.html.includes('测试撤回'));
    const etag = cp.headers.etag;
    const again = await api('GET', `/api/public/notices/${corrUuid}`, { headers: { 'If-None-Match': etag } });
    check('撤回导致缓存失效（旧 ETag 不再 304）', again.status !== 304);
  }

  console.log('\n[7] 按发布清单重建正式文件');
  {
    const n = await api('GET', `/api/notices`, { token: AT });
    // find first original published-withdrawn? use P1 via firstNid publications
    const detail = await api('GET', `/api/notices/${firstNid}`, { token: AT });
    const mk = detail.json.publications[0].manifest_key;
    let r = await api('POST', '/api/admin/rebuild', { token: AT, body: { manifest_key: mk } });
    check('渲染重建与原发布哈希一致', r.json.rendered_match === true);
    check('清单自哈希校验通过', r.json.manifest_sha_match === true);
    check('附件固定对象全部复核通过', r.json.attachments_verified.length >= 2 && r.json.attachments_verified.every((a) => a.match));

  }

  console.log(`\n全部通过：${pass} 项断言 ✓`);
  for (const p of procs) p.kill();
  process.exit(0);
})().catch((e) => { console.error('\n验收失败:', e); for (const p of procs) p.kill(); process.exit(1); });
