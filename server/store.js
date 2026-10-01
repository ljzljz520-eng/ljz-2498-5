'use strict';
// 对象服务：内容寻址存储，保存固定附件与渲染结果
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha256hex = (x) => crypto.createHash('sha256').update(x).digest('hex');

class ObjectStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }
  _path(key) {
    return path.join(this.dir, key.slice(0, 2), key.slice(2, 4), key);
  }
  // 写入缓冲区，返回 { key, sha256, size }；相同内容幂等
  put(buf) {
    const hash = sha256hex(buf);
    const p = this._path(hash);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = p + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, p);
    }
    return { key: hash, sha256: hash, size: buf.length };
  }
  // 将已落盘的临时文件移入对象库（上传定稿用），调用前已校验哈希
  putFile(tmpPath, expectedSha256) {
    const p = this._path(expectedSha256);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.renameSync(tmpPath, p);
    } else {
      fs.unlinkSync(tmpPath);
    }
    const size = fs.statSync(p).size;
    return { key: expectedSha256, sha256: expectedSha256, size };
  }
  get(key) {
    const p = this._path(key);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  exists(key) {
    return !!key && fs.existsSync(this._path(key));
  }
  verify(key, expectedSha256) {
    const buf = this.get(key);
    if (!buf) return { ok: false, reason: '对象缺失' };
    const actual = sha256hex(buf);
    return actual === expectedSha256
      ? { ok: true, size: buf.length }
      : { ok: false, reason: `哈希不符: 期望 ${expectedSha256} 实际 ${actual}` };
  }
}

module.exports = { ObjectStore, sha256hex };
