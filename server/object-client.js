'use strict';
// 对象服务客户端：API 进程通过它把"固定附件"和"渲染结果"落到对象服务。
const http = require('http');
const crypto = require('crypto');
const BASE = process.env.OBJECT_URL || 'http://127.0.0.1:3010';
const TOKEN = process.env.OBJECT_TOKEN || 'object-service-local-token';

function request(method, pathname, body, headers = {}, raw = false) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + pathname);
    const data = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        'x-object-token': TOKEN,
        ...(data ? { 'content-length': data.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (raw) {
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ status: res.statusCode, body: buf, headers: res.headers });
          const err = new Error(`object service ${res.statusCode}`); err.status = res.statusCode; return reject(err);
        }
        let parsed; try { parsed = JSON.parse(buf.toString()); } catch { parsed = buf; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        const err = new Error((parsed && parsed.error) || `object service ${res.statusCode}`);
        err.status = res.statusCode; err.body = parsed;
        reject(err);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

module.exports = {
  sha256,
  health: () => request('GET', '/health'),
  createUpload: (id) => request('POST', '/uploads', { id }),
  appendChunk: (id, buf, offset) => request('PATCH', `/uploads/${id}`, buf, { 'x-offset': String(offset), 'content-type': 'application/octet-stream' }),
  finalizeUpload: (id, declared) => request('POST', `/uploads/${id}/finalize`, declared),
  abortUpload: (id) => request('DELETE', `/uploads/${id}`),
  putObject: (key, buf) => request('PUT', `/objects/${encodeURIComponent(key)}`, buf, { 'content-type': 'application/octet-stream' }),
  getObject: (key) => request('GET', `/objects/${encodeURIComponent(key)}`),
  getObjectRaw: (key) => request('GET', `/objects/${encodeURIComponent(key)}`, null, {}, true),
  headObject: (key) => new Promise((resolve, reject) => {
    const u = new URL(BASE + `/objects/${encodeURIComponent(key)}`);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'HEAD', headers: { 'x-object-token': TOKEN } }, (res) => {
      if (res.statusCode === 200) return resolve({ headers: res.headers });
      const err = new Error(`head ${res.statusCode}`); err.status = res.statusCode; reject(err);
    });
    req.on('error', reject); req.end();
  }),
};
