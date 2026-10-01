'use strict';
const path = require('path');
const { createApp } = require('./app');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const port = Number(process.env.PORT || 3000);
const { app } = createApp({ dataDir });
app.listen(port, () => {
  console.log(`公告编辑系统已启动: http://localhost:${port}  (数据目录: ${dataDir})`);
});
