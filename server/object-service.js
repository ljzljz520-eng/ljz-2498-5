'use strict';
// 对象服务（独立进程，默认 3010）：
//  - objects/  不可变固定对象：附件 sha256 寻址 + 渲染结果/发布清单
//  - tmp/      上传会话临时区（断点续传）
// 服务重启后已落盘对象仍在；未完成会话可继续或中止。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.OBJECT_ROOT || path.join(__dirname, '..', 'data', 'objects');
const OBJ_DIR = path.join(ROOT, 'objects');
const TMP_DIR = path.join(ROOT, 'tmp');
const PORT = Number(process.env.OBJECT_PORT || 3010);
const TOKEN = process.env.OBJECT_TOKEN || 'object-service-local-token';

fs.mkdirSync(OBJ_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function send(res, code, obj, headers = {}) {
  const body = obj instanceof Buffer ? obj : Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function auth(req) {
  return req.headers['x-object-token'] === TOKEN;
}
function safeKey(k) {
  // 仅允许对象键落在 OBJ_DIR 下
  const full = path.normalize(path.join(OBJ_DIR, k));
  return full.startsWith(OBJ_DIR + path.sep) ? full : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/health') {
      return send(res, 200, { ok: true, service: 'object', port: PORT });
    }
    if (!auth(req)) return send(res, 401, { error: 'unauthorized object service' });

    // —— 上传会话：创建 ——
    if (req.method === 'POST' && p === '/uploads') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const id = body.id || crypto.randomUUID();
      const temp = path.join(TMP_DIR, id + '.part');
      if (!fs.existsSync(temp)) fs.writeFileSync(temp, Buffer.alloc(0));
      return send(res, 200, { id, tempPath: temp, received: 0 });
    }

    // —— 上传会话：追加分片（offset 必须连续，支持断点续传）——
    if (req.method === 'PATCH' && p.startsWith('/uploads/')) {
      const id = p.split('/')[2];
      const temp = path.join(TMP_DIR, id + '.part');
      if (!fs.existsSync(temp)) return send(res, 404, { error: 'upload session not found' });
      const buf = await readBody(req);
      const offset = Number(req.headers['x-offset'] || '0');
      const stat = fs.statSync(temp);
      if (offset !== stat.size) {
        return send(res, 409, { error: 'offset gap', expected: stat.size, got: offset });
      }
      fs.appendFileSync(temp, buf);
      return send(res, 200, { id, received: fs.statSync(temp).size });
    }

    // —— 上传会话：定稿（校验大小与 sha256，固化为不可变对象）——
    if (req.method === 'POST' && /^\/uploads\/[^/]+\/finalize$/.test(p)) {
      const id = p.split('/')[2];
      const temp = path.join(TMP_DIR, id + '.part');
      if (!fs.existsSync(temp)) return send(res, 404, { error: 'upload session not found' });
      const q = JSON.parse((await readBody(req)).toString() || '{}');
      const buf = fs.readFileSync(temp);
      if (q.declared_size != null && buf.length !== Number(q.declared_size)) {
        return send(res, 422, { error: 'size mismatch', expected: Number(q.declared_size), actual: buf.length });
      }
      const digest = sha(buf);
      if (q.declared_sha256 && digest !== q.declared_sha256) {
        return send(res, 422, { error: 'checksum mismatch', expected: q.declared_sha256, actual: digest });
      }
      const key = `att/${digest}`;
      const full = safeKey(key);
      if (!fs.existsSync(full)) { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, buf); }
      fs.unlinkSync(temp);
      return send(res, 200, { objectKey: key, sha256: digest, size: buf.length });
    }

    // —— 上传会话：中止 ——
    if (req.method === 'DELETE' && p.startsWith('/uploads/')) {
      const id = p.split('/')[2];
      const temp = path.join(TMP_DIR, id + '.part');
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
      return send(res, 200, { ok: true });
    }

    // —— 固定对象：写入（仅当不存在；已存在则幂等返回，禁止覆盖）——
    if (req.method === 'PUT' && p.startsWith('/objects/')) {
      const key = decodeURIComponent(p.slice('/objects/'.length));
      const full = safeKey(key);
      if (!full) return send(res, 400, { error: 'bad key' });
      const buf = await readBody(req);
      if (fs.existsSync(full)) {
        const old = fs.readFileSync(full);
        if (sha(old) !== sha(buf)) return send(res, 409, { error: 'object exists with different content (immutable)' });
        return send(res, 200, { key, sha256: sha(buf), size: buf.length, existed: true });
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buf);
      return send(res, 201, { key, sha256: sha(buf), size: buf.length });
    }

    // —— 对象读取 ——
    if (req.method === 'GET' && p.startsWith('/objects/')) {
      const key = decodeURIComponent(p.slice('/objects/'.length));
      const full = safeKey(key);
      if (!full || !fs.existsSync(full)) return send(res, 404, { error: 'object not found' });
      const stat = fs.statSync(full);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': stat.size,
        'x-object-sha256': sha(fs.readFileSync(full)),
      });
      return fs.createReadStream(full).pipe(res);
    }

    // —— 校验对象哈希（重建时调用）——
    if (req.method === 'HEAD' && p.startsWith('/objects/')) {
      const key = decodeURIComponent(p.slice('/objects/'.length));
      const full = safeKey(key);
      if (!full || !fs.existsSync(full)) return send(res, 404);
      const buf = fs.readFileSync(full);
      res.writeHead(200, { 'x-object-sha256': sha(buf), 'content-length': buf.length });
      return res.end();
    }

    return send(res, 404, { error: 'not found', path: p });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`[object-service] listening on ${PORT}, root=${ROOT}`));
module.exports = server;
