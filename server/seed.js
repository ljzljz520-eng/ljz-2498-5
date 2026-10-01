'use strict';
const { init: dbInit } = require('./db');
const nowIso = () => new Date().toISOString();

(async () => {
  const db = await dbInit();
  const users = [
    ['editor1', '张编辑', 'editor'],
    ['reviewer1', '李评审', 'reviewer'],
    ['admin1', '王管理员', 'admin'],
  ];
  for (const [username, display_name, role] of users) {
    const ex = db.get('SELECT id FROM users WHERE username=?', [username]);
    if (!ex) db.run('INSERT INTO users (username,display_name,role,active) VALUES (?,?,?,1)', [username, display_name, role]);
  }
  const existing = db.get('SELECT id FROM rule_sets WHERE status=?', ['active']);
  if (!existing) {
    const id = (db.get('SELECT MAX(id) m FROM rule_sets').m || 0) + 1;
    const config = {
      timezone: '+08:00',
      slots: [
        { key: 'bid_deadline', label: '投标截止日', type: 'date', mode: 'manual', required: true },
        { key: 'bid_open_time', label: '开标时刻', type: 'instant', mode: 'manual', required: true },
        { key: 'clarify_deadline', label: '答疑截止日', type: 'date', mode: 'relative', offsetDays: -7, required: false },
        { key: 'doc_sale_deadline', label: '文件发售截止日', type: 'date', mode: 'manual', required: false },
      ],
      pairs: [
        { after: 'bid_deadline', before: 'clarify_deadline' },
        { after: 'bid_open_time', before: 'bid_deadline' },
        { after: 'bid_deadline', before: 'doc_sale_deadline' },
      ],
      requiredAttachmentSlots: ['tender_doc', 'technical_spec'],
    };
    db.run(`INSERT INTO rule_sets (id,name,version,status,config,created_by,created_at)
      VALUES (?,?,1,'active',?, 'admin1',?)`,
      [id, '工程采购标准规则', JSON.stringify(config), nowIso()]);
    console.log('seeded active rule id=', id);
  }
  db.persist();
  console.log('seed done: users =', users.map((u) => u[0]).join(', '));
  process.exit(0);
})();
