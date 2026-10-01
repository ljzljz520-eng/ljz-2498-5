'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { init: dbInit } = require('./db');
const { createHandler } = require('./api');
const obj = require('./object-client');

const PORT = Number(process.env.PORT || 3000);
const WEB = path.join(__dirname, '..', 'web');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

async function ensureObjectService() {
  try { await obj.health(); return null; } catch {}
  const child = spawn(process.execPath, [path.join(__dirname, 'object-service.js')], { stdio: 'inherit', env: process.env });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { await obj.health(); return child; } catch {}
  }
  throw new Error('对象服务启动失败');
}

(async () => {
  const db = await dbInit();
  await ensureObjectService();
  const api = createHandler(db);

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    if (p.startsWith('/api/')) return api(req, res);

    // 公开页前端路由
    if (p.startsWith('/p/')) {
      req.url = '/index.html';
      return serveStatic(req, res);
    }
    if (p === '/') { res.writeHead(302, { location: '/index.html' }); return res.end(); }
    return serveStatic(req, res);
  });

  function serveStatic(req, res) {
    let pathname = new URL(req.url, 'http://x').pathname;
    if (pathname === '/') pathname = '/index.html';
    const full = path.normalize(path.join(WEB, pathname));
    if (!full.startsWith(WEB)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, data) => {
      if (err) {
        // SPA 回退
        return fs.readFile(path.join(WEB, 'index.html'), (e2, idx) => {
          if (e2) { res.writeHead(404); return res.end('not found'); }
          res.writeHead(200, { 'content-type': 'text/html' }); res.end(idx);
        });
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  server.listen(PORT, () => console.log(`[api] http://localhost:${PORT}  (object service on ${process.env.OBJECT_PORT || 3010})`));
})().catch((e) => { console.error(e); process.exit(1); });
