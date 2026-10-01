const { createApp, reactive, ref, computed, onMounted, watch, h } = Vue;

const API = '';
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData) && !opts.raw) {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  if (store.token) headers['x-auth-token'] = store.token;
  const r = await fetch(API + path, { ...opts, headers });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) throw Object.assign(new Error(data.error || ('HTTP ' + r.status)), { data, status: r.status });
  return data;
}

const store = reactive({
  token: localStorage.getItem('token') || '',
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  route: location.hash || '#/login',
});
function navigate(r) { store.route = r; location.hash = r; }
addEventListener('hashchange', () => { store.route = location.hash; });

const STATUS_CN = { draft: '草稿', in_review: '评审中', published: '已发布', withdrawn: '已撤回', superseded: '已被取代', approved: '已批准', submitted: '待评审', rejected: '已驳回' };

/* ================= 登录 ================= */
const Login = {
  setup() {
    const username = ref('editor1');
    const err = ref('');
    const login = async () => {
      err.value = '';
      try {
        const r = await api('/api/auth/login', { method: 'POST', body: { username: username.value } });
        store.token = r.token; store.user = r.user;
        localStorage.setItem('token', r.token); localStorage.setItem('user', JSON.stringify(r.user));
        navigate('#/notices');
      } catch (e) { err.value = e.message; }
    };
    return () => h('div', { class: 'card login-box' }, [
      h('h2', { style: 'margin-top:0' }, '建设公告编辑系统'),
      h('p', { class: 'muted' }, '演示账号：editor1（编辑） / reviewer1（评审） / admin1（管理员）。无需密码。'),
      h('label', null, '用户名'),
      h('input', { value: username.value, onInput: (e) => username.value = e.target.value, onKeydown: (e) => e.key === 'Enter' && login() }),
      err.value ? h('div', { class: 'err', style: 'margin-top:.6rem' }, err.value) : null,
      h('button', { class: 'primary', style: 'margin-top:.8rem;width:100%', onClick: login }, '登录'),
    ]);
  },
};

/* ================= 公告列表 ================= */
const NoticeList = {
  setup() {
    const list = ref([]);
    const rules = ref([]);
    const load = async () => { list.value = await api('/api/notices'); rules.value = await api('/api/rules'); };
    onMounted(load);
    const create = async () => {
      const title = prompt('项目名称（可稍后修改）：', '市政道路改造工程施工');
      if (!title) return;
      const project_code = prompt('项目编号：', 'JS-2026-001') || '';
      const n = await api('/api/notices', { method: 'POST', body: { title, project_code, project_name: title } });
      navigate('#/notices/' + n.id);
    };
    return () => h('div', null, [
      h('div', { class: 'card' }, [
        h('div', { class: 'row' }, [
          h('h2', { style: 'margin:0;flex:1' }, '公告列表'),
          store.user.role !== 'reviewer' ? h('button', { class: 'primary', onClick: create }, '＋ 新建公告') : null,
          h('button', { onClick: () => navigate('#/rules') }, '公告规则配置'),
        ]),
        h('p', { class: 'muted', style: 'margin-bottom:0' }, '日期依赖来自公告规则（区分截止日 date 与带时区时刻 instant）；本系统不替代法律审查。'),
      ]),
      h('div', { class: 'card' }, [
        h('table', null, [
          h('thead', null, h('tr', null, ['编号', '标题', '类型', '状态', '版本', '规则版', '创建人', '操作'].map((t) => h('th', null, t)))),
          h('tbody', null, list.value.map((n) => h('tr', null, [
            h('td', { class: 'mono' }, n.project_code),
            h('td', null, n.title),
            h('td', null, h('span', { class: 'tag ' + n.kind }, n.kind === 'original' ? '原公告' : '更正')),
            h('td', null, h('span', { class: 'tag ' + n.status }, STATUS_CN[n.status])),
            h('td', null, 'v' + n.current_version),
            h('td', null, '#' + n.rule_set_id + 'v' + n.rule_set_version),
            h('td', null, n.created_by),
            h('td', null, h('button', { onClick: () => navigate('#/notices/' + n.id) }, '打开')),
          ]))),
        ]),
      ]),
    ]);
  },
};

/* ================= 公告编辑器 ================= */
const Editor = {
  props: ['id'],
  setup(props) {
    const tab = ref('content');
    const data = ref(null);
    const rules = ref([]);
    const preview = ref(null);
    const msg = reactive({ err: '', ok: '' });
    const busy = ref(false);
    const reviewComment = ref('');
    const uploads = reactive({}); // slot:filename -> {progress, status}

    const load = async () => {
      data.value = await api('/api/notices/' + props.id);
      rules.value = await api('/api/rules');
      await runPreview();
    };
    const rule = computed(() => {
      if (!data.value) return null;
      return rules.value.find((r) => r.id === data.value.rule_set_id && r.version === data.value.rule_set_version) || null;
    });
    const ruleConfig = computed(() => rule.value ? JSON.parse(rule.value.config) : { slots: [], pairs: [] });
    const dateSlots = computed(() => ruleConfig.value.slots || []);

    function flash(kind, text) { msg[kind] = text; setTimeout(() => msg[kind] = '', 6000); }

    const saveField = async (patch) => {
      await api('/api/notices/' + props.id, { method: 'PATCH', body: patch });
      await load();
      flash('ok', '已保存');
    };
    const runPreview = async (mode = 'strict') => {
      try { preview.value = await api(`/api/notices/${props.id}/preview?mode=${mode}`); }
      catch (e) { preview.value = { errors: [{ msg: e.message }], warnings: [] }; }
    };

    const saveVersion = async () => {
      try {
        const r = await api(`/api/notices/${props.id}/versions`, { method: 'POST', body: {} });
        flash('ok', `已保存不可变版本 v${r.ver}（指纹 ${r.fingerprint.slice(0, 12)}…）`);
        await load(); tab.value = 'versions';
      } catch (e) { flash('err', e.message); }
    };
    const submit = async (vid) => {
      try { await api(`/api/notices/${props.id}/versions/${vid}/submit`, { method: 'POST', body: {} }); flash('ok', '已提交评审'); await load(); }
      catch (e) { flash('err', e.message + (e.data && e.data.conflicts ? '：' + e.data.conflicts.map((c) => c.msg).join('；') : '')); }
    };
    const decide = async (vid, decision) => {
      try { const r = await api(`/api/notices/${props.id}/versions/${vid}/${decision}`, { method: 'POST', body: { comment: reviewComment.value } });
        flash('ok', `${decision === 'approve' ? '批准' : decision === 'reject' ? '驳回' : '意见'}已提交（${r.approvals}/${r.required} 批准）`); reviewComment.value = ''; await load();
      } catch (e) { flash('err', '评审冲突：' + e.message); }
    };
    const withdrawReview = async () => {
      try { await api(`/api/notices/${props.id}/withdraw-review`, { method: 'POST' }); flash('ok', '已撤回评审'); await load(); }
      catch (e) { flash('err', e.message); }
    };
    const publish = async () => {
      busy.value = true;
      try { const r = await api(`/api/notices/${props.id}/publish`, { method: 'POST', body: {} });
        flash('ok', '发布成功（' + (r.mode === 'in-place-replace' ? '原地替换' : r.mode === 'amendment-chain' ? '更正公告入链' : '首次发布') + '）');
        await load(); tab.value = 'public'; window.open('/p/' + r.public_uuid, '_blank');
      } catch (e) {
        let extra = '';
        if (e.data) extra = ' ' + JSON.stringify(e.data.errors || e.data.open || '');
        flash('err', '发布被拒绝：' + e.message + extra);
      } finally { busy.value = false; }
    };
    const withdrawPublish = async () => {
      const reason = prompt('撤回原因：');
      if (reason === null) return;
      try { await api(`/api/notices/${props.id}/withdraw-publish`, { method: 'POST', body: { reason } }); flash('ok', '公告已撤回，公开页缓存已失效'); await load(); }
      catch (e) { flash('err', e.message); }
    };
    const amendment = async () => {
      try { const r = await api(`/api/notices/${props.id}/amendment`, { method: 'POST' }); flash('ok', '已创建更正公告草稿（继承内容，独立版本与审批）'); navigate('#/notices/' + r.amendment_id); }
      catch (e) { flash('err', e.message); }
    };
    const rebuild = async () => {
      try { const r = await api(`/api/notices/${props.id}/rebuild`, { method: 'POST' });
        flash(r.ok ? 'ok' : 'err', r.ok ? `重建成功，渲染哈希一致（${r.rebuilt_sha256.slice(0,12)}…）` : '重建结果与原件不一致');
        window.console.log('rebuild', r);
      } catch (e) { flash('err', e.message); }
    };
    const switchRule = async (rid) => {
      if (!rid) return;
      try { await saveField({ rule_set_id: Number(rid) }); flash('ok', '已切换规则版本，需重新保存/评审'); }
      catch (e) { flash('err', e.message); }
    };

    // —— 附件上传（分片 + 断点续传）——
    const startUpload = async (slot, file) => {
      const key = slot + '/' + file.name;
      const calcHash = await sha256file(file);
      const r = await api(`/api/notices/${props.id}/attachments/upload-start`, { method: 'POST', body: { slot, filename: file.name, media_type: file.type, size: file.size, sha256: calcHash } });
      const upid = r.upload_id;
      uploads[key] = reactive({ progress: 0, status: 'uploading', upid });
      const CH = 512 * 1024;
      let offset = 0;
      try {
        while (offset < file.size) {
          const slice = file.slice(offset, Math.min(offset + CH, file.size));
          const buf = await slice.arrayBuffer();
          const cr = await api(`/api/uploads/${upid}/chunk`, { method: 'PUT', raw: true, body: buf, headers: { 'x-offset': String(offset) } });
          offset = cr.received;
          uploads[key].progress = Math.round(offset / file.size * 100);
        }
        const done = await api(`/api/uploads/${upid}/complete`, { method: 'POST', body: {} });
        uploads[key].status = done.replaced && done.replaced.length ? 'replaced' : 'done';
        flash('ok', (done.replaced && done.replaced.length ? '同名附件已替换——' : '附件已固化——') + '已关联批准自动失效，需重新评审');
        delete uploads[key];
        await load();
      } catch (e) {
        uploads[key].status = 'error'; uploads[key].error = e.message;
        flash('err', '上传中断（可续传）：' + e.message);
      }
    };
    const resumeUpload = async (key) => {
      // 简化：重新选择文件后续传（offset 由对象服务把关）
      alert('请重新选择同名文件，系统将从已接收偏移续传。');
    };
    const abortUpload = async (upid) => { await api(`/api/uploads/${upid}/abort`, { method: 'POST' }); await load(); };

    onMounted(load);

    return () => {
      if (!data.value) return h('div', { class: 'card' }, '加载中…');
      const n = data.value;
      const isEditor = store.user.role === 'editor' || store.user.role === 'admin';
      const isReviewer = store.user.role === 'reviewer' || store.user.role === 'admin';
      const frozen = n.status === 'in_review';
      const latestDraft = [...n.versions].reverse().find((v) => v.status === 'draft');
      const submitted = n.versions.find((v) => v.status === 'submitted');
      const approved = [...n.versions].reverse().find((v) => v.status === 'approved');

      const tabs = [
        ['content', '项目/范围/资格'],
        ['dates', '关键日期'],
        ['attachments', '附件'],
        ['preview', '冲突预览'],
        ['versions', '版本与并行评审'],
        ['publish', '发布与替代链'],
        ['public', '公开页'],
      ];

      return h('div', null, [
        h('div', { class: 'card' }, [
          h('div', { class: 'row' }, [
            h('button', { onClick: () => navigate('#/notices') }, '← 返回'),
            h('h2', { style: 'margin:0;flex:1' }, [
              n.title || '(未命名公告)',
              h('span', { class: 'tag ' + n.status, style: 'margin-left:.6rem' }, STATUS_CN[n.status]),
              h('span', { class: 'tag ' + n.kind, style: 'margin-left:.3rem' }, n.kind === 'original' ? '原公告' : '更正公告'),
            ]),
          ]),
          h('p', { class: 'mono muted', style: 'margin:.3rem 0 0' }, `id=${n.id}　规则 #${n.rule_set_id}v${n.rule_set_version}　chain=${n.chain_id}`),
        ]),
        msg.err ? h('div', { class: 'err' }, msg.err) : null,
        msg.ok ? h('div', { class: 'ok' }, msg.ok) : null,
        h('div', { class: 'tabs' }, tabs.map(([k, label]) => h('button', { class: tab.value === k ? 'on' : '', onClick: () => { tab.value = k; if (k === 'preview') runPreview('strict'); } }, label))),

        tab.value === 'content' && h('div', { class: 'card' }, [
          h('div', { class: 'grid2' }, [
            field('项目编号', n.project_code, (v) => saveField({ project_code: v }), frozen),
            field('项目名称', n.project_name, (v) => saveField({ project_name: v }), frozen),
          ]),
          field('公告标题', n.title, (v) => saveField({ title: v }), frozen),
          h('label', null, '采购范围（改采购范围会改变版本指纹，关联批准需复核）'),
          h('textarea', { rows: 4, disabled: frozen, value: n.procurement_scope, onChange: (e) => saveField({ procurement_scope: e.target.value }) }, n.procurement_scope),
          h('label', null, '投标人资格'),
          h('textarea', { rows: 3, disabled: frozen, value: n.qualifications, onChange: (e) => saveField({ qualifications: e.target.value }) }, n.qualifications),
          h('label', null, '公告正文（支持简单 Markdown；发布时校验非空）'),
          h('textarea', { rows: 8, disabled: frozen, value: n.body_text, onChange: (e) => saveField({ body_text: e.target.value }) }, n.body_text),
          h('label', null, '计划发布日（影响相对日期推导）'),
          h('input', { type: 'date', disabled: frozen, value: (n.planned_publish_at || '').slice(0, 10), onChange: (e) => saveField({ planned_publish_at: e.target.value ? e.target.value + 'T09:00:00+08:00' : '' }) }),
          h('label', null, '引用公告规则（切换到新版需重新走审批）'),
          h('select', { disabled: frozen, onChange: (e) => switchRule(e.target.value) }, [
            h('option', { value: '', selected: !rule.value }, '请选择'),
            ...rules.value.map((r) => h('option', { value: r.id, selected: r.id === n.rule_set_id && r.version === n.rule_set_version }, `${r.name} #${r.id}v${r.version} [${r.status}]`)),
          ]),
        ]),

        tab.value === 'dates' && h('div', { class: 'card' }, [
          h('p', { class: 'muted' }, `规则时区 ${ruleConfig.value.timezone}。截止日(date)仅 YYYY-MM-DD；带时区时刻(instant)需 RFC3339，如 2026-11-20T09:30:00+08:00。`),
          h('table', null, [
            h('thead', null, h('tr', null, ['槽位', '类型', '模式', '必需', '录入值', '推导值'].map((t) => h('th', null, t)))),
            h('tbody', null, dateSlots.value.map((s) => {
              const dv = (n.date_values || {})[s.key] || '';
              const comp = preview.value && preview.value.computedDates ? preview.value.computedDates[s.key] : '';
              return h('tr', null, [
                h('td', null, s.label + ' (' + s.key + ')'),
                h('td', null, h('span', { class: 'pill' }, s.type === 'date' ? '截止日 date' : '时刻 instant')),
                h('td', null, s.mode === 'relative' ? `相对(锚点${s.offsetDays >= 0 ? '+' : ''}${s.offsetDays}d)` : '手工'),
                h('td', null, s.required ? '是' : '否'),
                h('td', null, h('input', {
                  type: 'text', disabled: frozen, placeholder: s.type === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:mm:ss+08:00', value: dv,
                  onChange: (e) => saveField({ date_values: { ...(n.date_values || {}), [s.key]: e.target.value } }),
                })),
                h('td', { class: 'mono' }, comp || '—'),
              ]);
            })),
          ]),
          h('p', { class: 'muted' }, '顺序约束：' + (ruleConfig.value.pairs || []).map((pr) => {
            const a = (ruleConfig.value.slots.find((x) => x.key === pr.after) || {}).label || pr.after;
            const b = (ruleConfig.value.slots.find((x) => x.key === pr.before) || {}).label || pr.before;
            return `${a} 不早于 ${b}`;
          }).join('；')),
        ]),

        tab.value === 'attachments' && h('div', { class: 'card' }, [
          h('h3', { style: 'margin-top:0' }, '固定附件（上传后 sha256 固化，不可变）'),
          h('table', null, [
            h('thead', null, h('tr', null, ['槽位', '文件名', '大小', 'SHA256', '状态', ''].map((t) => h('th', null, t)))),
            h('tbody', null, [
              ...n.attachments.map((a) => h('tr', null, [
                h('td', null, a.slot), h('td', null, a.filename), h('td', null, a.size),
                h('td', { class: 'mono' }, a.sha256.slice(0, 20) + '…'),
                h('td', null, h('span', { class: 'tag ' + (a.state === 'ready' ? 'approved' : 'rejected') }, a.state)),
                h('td', null, h('a', { href: `${''}/api/...`, style: 'display:none' })),
              ])),
              ...Object.entries(uploads).map(([k, up]) => h('tr', null, [
                h('td', { colSpan: 3 }, k),
                h('td', null, h('div', { class: 'progress' }, h('i', { style: `width:${up.progress}%` }))),
                h('td', null, up.status + ' ' + (up.error || '')),
                h('td', null, h('button', { class: 'danger', onClick: () => abortUpload(up.upid) }, '中止')),
              ])),
            ]),
          ]),
          frozen ? h('div', { class: 'warn' }, '评审中，附件冻结。') : [
            h('h4', null, '上传到槽位'),
            h('div', { class: 'row' }, (JSON.parse(n.required_slots || '[]').filter((s) => !s.startsWith('date:'))).map((slot) => h('div', { style: 'border:1px dashed #bbb;padding:.5rem;border-radius:6px' }, [
              h('div', null, h('strong', null, slot)),
              h('input', { type: 'file', onChange: (e) => e.target.files[0] && startUpload(slot, e.target.files[0]) }),
            ]))),
            h('p', { class: 'muted' }, '同名文件再次上传即"替换"：旧附件标记 replaced_by，版本指纹变化，必须重新评审。上传未完成不能发布（不能发半套附件）。'),
          ],
          n.openUploads && n.openUploads.length ? h('div', null, [
            h('h4', null, '未完成上传（服务重启后仍可续传/中止）'),
            h('table', null, h('tbody', null, n.openUploads.map((o) => h('tr', null, [
              h('td', null, `${o.slot}/${o.filename}`), h('td', null, `${o.received}/${o.declared_size ?? '?'} 字节`),
              h('td', null, h('button', { class: 'danger', onClick: () => abortUpload(o.id) }, '中止此上传')),
            ])))),
          ]) : null,
        ]),

        tab.value === 'preview' && h('div', { class: 'card' }, [
          h('div', { class: 'row' }, [h('h3', { style: 'margin:0;flex:1' }, '跨字段冲突预览（严格模式）'), h('button', { onClick: () => runPreview('strict') }, '重新检查')]),
          (preview.value?.errors || []).length ? h('div', null, preview.value.errors.map((e) => h('div', { class: 'err' }, `[${e.code}] ${e.msg}`))) : h('div', { class: 'ok' }, '无阻断性错误（日期倒置/类型错误等）'),
          (preview.value?.warnings || []).map((w) => h('div', { class: 'warn' }, `[${w.code}] ${w.msg}`)),
          preview.value?.legalNote ? h('div', { class: 'legal', style: 'margin-top:1rem' }, preview.value.legalNote) : null,
        ]),

        tab.value === 'versions' && h('div', { class: 'card' }, [
          h('div', { class: 'row' }, [
            h('h3', { style: 'margin:0;flex:1' }, '版本（评审意见绑定具体版本）'),
            isEditor && !frozen ? h('button', { class: 'primary', onClick: saveVersion }, '保存新版本快照') : null,
            isEditor && submitted ? h('button', { class: 'danger', onClick: withdrawReview }, '撤回评审') : null,
            frozen ? h('span', { class: 'warn' }, '评审中，编辑冻结；撤回后可改') : null,
          ]),
          h('table', null, [
            h('thead', null, h('tr', null, ['版本', '状态', '指纹', '提交时间', '评审时间', '操作/并行意见'].map((t) => h('th', null, t)))),
            h('tbody', null, [...n.versions].reverse().map((v) => h('tr', null, [
              h('td', null, 'v' + v.ver),
              h('td', null, h('span', { class: 'tag ' + v.status }, STATUS_CN[v.status])),
              h('td', { class: 'mono' }, v.fingerprint.slice(0, 14) + '…' + (v.approval_fingerprint === v.fingerprint ? ' ✓批准匹配' : v.approval_fingerprint ? ' ✗指纹已变' : '')),
              h('td', null, v.submitted_at ? new Date(v.submitted_at).toLocaleString() : '—'),
              h('td', null, v.reviewed_at ? new Date(v.reviewed_at).toLocaleString() : '—'),
              h('td', null, [
                isEditor && v.status === 'draft' ? h('button', { onClick: () => submit(v.id) }, '提交评审') : null,
                isReviewer && v.status === 'submitted' ? h('span', { class: 'row' }, [
                  h('input', { placeholder: '评审意见（可多人并行）', value: reviewComment.value, onInput: (e) => reviewComment.value = e.target.value, style: 'width:200px' }),
                  h('button', { class: 'success', onClick: () => decide(v.id, 'approve') }, '批准'),
                  h('button', { onClick: () => decide(v.id, 'comment') }, '仅意见'),
                  h('button', { class: 'danger', onClick: () => decide(v.id, 'reject') }, '驳回'),
                ]) : null,
                h('ul', { style: 'margin:.3rem 0 0;padding-left:1.1rem' }, n.reviews.filter((r) => r.version_id === v.id).map((r) =>
                  h('li', null, [h('strong', null, r.reviewer + '：'), h('span', { class: 'tag ' + (r.decision === 'approve' ? 'approved' : r.decision === 'reject' ? 'rejected' : 'draft') }, r.decision), ' ' + r.comment]))),
              ]),
            ]))),
          ]),
        ]),

        tab.value === 'publish' && h('div', { class: 'card' }, [
          h('h3', { style: 'margin-top:0' }, '发布'),
          h('ul', null, [
            '校验正文非空且完整', '附件摘要：每个必需槽位齐备、固定对象哈希可验证、无进行中上传（不发布半套附件）',
            '规则版一致：批准所依据规则必须仍是当前激活规则', '批准指纹匹配：采购范围/附件改动后需重新评审',
            '严格日期/跨字段校验通过',
          ].map((t) => h('li', null, t))),
          h('div', { class: 'row' }, [
            isEditor ? h('button', { class: 'success', disabled: busy.value || !approved, onClick: publish }, busy.value ? '发布中…' : (n.status === 'published' ? '原地再版发布（替换公开页）' : '发布')) : null,
            n.status === 'published' && isEditor ? h('button', { onClick: amendment }, '追加更正公告（形成替代链）') : null,
            n.status === 'published' && isEditor ? h('button', { class: 'danger', onClick: withdrawPublish }, '撤回已发布公告') : null,
            store.user.role === 'admin' ? h('button', { onClick: rebuild }, '按发布清单重建正式文件') : null,
          ]),
          !approved ? h('div', { class: 'warn' }, '没有已批准版本，暂不能发布。') : null,
          h('h4', null, '两种发布后修改方式的比较'),
          h('table', null, [
            h('thead', null, h('tr', null, ['', '原地编辑后再版', '追加更正公告'].map((t) => h('th', null, t)))),
            h('tbody', null, [
              ['公告身份', '同一 id、同一公开链接，公开页内容被新版本替换', '新建更正公告 id；原链接保留并标记"已被取代"，新链接入同一 chain'],
              ['审批', '新版本须重新保存+评审+批准', '独立草稿，独立评审与批准'],
              ['缓存', '发布即令该链缓存失效（ETag/epoch 变化）', '原公告与更正公告缓存同时失效（链 epoch）'],
              ['可追溯', '版本表保留全部历史版本', '替代链 supersedes 串联，逐环可导航'],
            ].map((r) => h('tr', null, [h('td', null, h('strong', null, r[0])), h('td', null, r[1]), h('td', null, r[2])]))),
          ]),
          h('h4', null, '替代链'),
          h('pre', { style: 'background:#f6f7f9;padding:.6rem;border-radius:6px;font-size:.8rem;max-height:220px;overflow:auto' }, JSON.stringify(n.versions.map((v) => ({ ver: v.ver, status: v.status })), null, 2)),
          n.publications.length ? h('div', null, [
            h('h4', null, '发布记录'),
            h('table', null, h('tbody', null, n.publications.map((p) => h('tr', null, [
              h('td', null, 'v' + p.ver + ' @ ' + new Date(p.published_at).toLocaleString()),
              h('td', { class: 'mono' }, p.manifest_key),
              h('td', null, 'epoch=' + p.cache_epoch),
            ])))),
          ]) : null,
        ]),

        tab.value === 'public' && h('div', { class: 'card' }, [
          n.public_uuid ? h(null, [
            h('h3', { style: 'margin-top:0' }, '公开页：' + STATUS_CN[n.status]),
            h('p', null, [h('a', { href: '/p/' + n.public_uuid, target: '_blank' }, '/p/' + n.public_uuid)]),
            h('iframe', { class: 'pub-frame', src: '/p/' + n.public_uuid }),
          ]) : h('div', { class: 'warn' }, '尚未发布，无公开页。'),
        ]),
      ]);
    };

    function field(label, val, onInput, disabled) {
      return h('div', null, [h('label', null, label), h('input', { value: val, disabled, onChange: (e) => onInput(e.target.value) })]);
    }
  },
};
async function sha256File(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ================= 规则配置 ================= */
const Rules = {
  setup() {
    const list = ref([]);
    const draft = reactive({
      name: '工程采购标准规则', timezone: '+08:00',
      slots: [{ key: 'bid_deadline', label: '投标截止日', type: 'date', mode: 'manual', required: true }],
      pairs: [], requiredAttachmentSlots: ['tender_doc'],
    });
    const load = async () => { list.value = await api('/api/rules'); };
    onMounted(load);
    const save = async (activate) => {
      try {
        await api('/api/rules', { method: 'POST', body: { name: draft.name, activate, config: { timezone: draft.timezone, slots: draft.slots, pairs: draft.pairs, requiredAttachmentSlots: draft.requiredAttachmentSlots } } });
        alert(activate ? '已保存并激活新版本，旧版本自动退役' : '已保存草稿');
        await load();
      } catch (e) { alert('规则校验失败：' + (e.data?.errors?.join('；') || e.message)); }
    };
    const activate = async (id) => { await api(`/api/rules/${id}/activate`, { method: 'POST' }); await load(); };
    return () => h('div', null, [
      h('div', { class: 'card' }, [
        h('div', { class: 'row' }, [h('button', { onClick: () => navigate('#/notices') }, '← 返回'), h('h2', { style: 'margin:0;flex:1' }, '公告规则（用户配置日期依赖）')]),
      ]),
      h('div', { class: 'card' }, [
        h('h3', null, '历史版本'),
        h('table', null, h('tbody', null, list.value.map((r) => h('tr', null, [
          h('td', null, r.name), h('td', null, 'v' + r.version), h('td', null, h('span', { class: 'tag ' + (r.status === 'active' ? 'approved' : 'draft') }, r.status)),
          h('td', null, r.created_by + ' ' + new Date(r.created_at).toLocaleString()),
          h('td', null, r.status !== 'active' ? h('button', { onClick: () => activate(r.id) }, '激活') : '—'),
        ])))),
      ]),
      store.user.role === 'admin' ? h('div', { class: 'card' }, [
        h('h3', null, '新建规则版本'),
        h('label', null, '规则名称'), h('input', { value: draft.name, onInput: (e) => draft.name = e.target.value }),
        h('label', null, '时区（Z 或 ±HH:MM）'), h('input', { value: draft.timezone, onInput: (e) => draft.timezone = e.target.value }),
        h('h4', null, '日期槽位'),
        h('table', null, [
          h('thead', null, h('tr', null, ['key', '显示名', '类型(date/instant)', '模式(manual/relative)', 'offsetDays', '必需'].map((t) => h('th', null, t)))),
          h('tbody', null, draft.slots.map((s, i) => h('tr', null, ['key', 'label', 'type', 'mode', 'offsetDays', 'required'].map((k) => h('td', null,
            k === 'required' ? h('input', { type: 'checkbox', checked: s[k], onChange: (e) => s[k] = e.target.checked })
              : h('input', { value: s[k] ?? '', type: k === 'offsetDays' ? 'number' : 'text', onInput: (e) => s[k] = k === 'offsetDays' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value })
          ))))),
        ]),
        h('button', { onClick: () => draft.slots.push({ key: '', label: '', type: 'date', mode: 'manual', required: false }) }, '＋槽位'),
        h('h4', null, '顺序约束（倒置检测）'),
        h('table', null, h('tbody', null, draft.pairs.map((p, i) => h('tr', null, [
          h('td', null, h('input', { value: p.before, onInput: (e) => p.before = e.target.value, placeholder: '更早槽位 key' })),
          h('td', null, ' 早于 '),
          h('td', null, h('input', { value: p.after, onInput: (e) => p.after = e.target.value, placeholder: '更晚槽位 key' })),
          h('td', null, h('button', { class: 'danger', onClick: () => draft.pairs.splice(i, 1) }, '删')),
        ])))),
        h('button', { onClick: () => draft.pairs.push({ before: '', after: '' }) }, '＋约束'),
        h('h4', null, '必需附件槽位（逗号分隔，发布时必须齐备）'),
        h('input', { value: draft.requiredAttachmentSlots.join(','), onInput: (e) => draft.requiredAttachmentSlots = e.target.value.split(',').map((x) => x.trim()).filter(Boolean) }),
        h('div', { class: 'row', style: 'margin-top:1rem' }, [
          h('button', { class: 'primary', onClick: () => save(false) }, '保存草稿'),
          h('button', { class: 'success', onClick: () => save(true) }, '保存并激活'),
        ]),
      ]) : null,
    ]);
  },
};

/* ================= 公开页（只读） ================= */
const Public = {
  props: ['uuid'],
  setup(props) {
    const p = ref(null); const err = ref('');
    const load = async () => { try { p.value = await api('/api/public/notices/' + props.uuid); } catch (e) { err.value = e.message; } };
    onMounted(load);
    return () => err.value ? h('div', { class: 'card err' }, err.value)
      : !p.value ? h('div', { class: 'card' }, '加载中…')
      : h('div', null, [
        h('div', { class: 'card' }, [
          h('div', { class: 'row' }, [
            h('h2', { style: 'margin:0;flex:1' }, p.value.title),
            h('span', { class: 'tag ' + p.value.status }, p.value.status_text),
            h('span', { class: 'tag ' + (p.value.kind || 'original') }, p.value.kind === 'amendment' ? '更正公告' : '原公告'),
          ]),
          h('p', { class: 'muted' }, `发布于 ${p.value.published_at ? new Date(p.value.published_at).toLocaleString() : '—'}　当前版本 v${p.value.current_version}`),
        ]),
        h('div', { class: 'card' }, h('div', { innerHTML: p.value.html })),
        h('div', { class: 'card legal' }, '旧公告链接持续有效，其当前状态（现行/被取代/撤回）始终显著标示；本页面不构成法律意见。'),
      ]);
  },
};

/* ================= 根 ================= */
const App = {
  setup() {
    return () => {
      const r = store.route.replace(/^#/, '');
      if (!store.token && !r.startsWith('/p/')) return h(Login);
      let view;
      const m = /^\/notices\/([^/]+)$/.exec(r);
      const pm = /^\/p\/(.+)$/.exec(r);
      if (r === '/login' || !r) view = h(Login);
      else if (r === '/notices') view = h(NoticeList);
      else if (m) view = h(Editor, { id: m[1] });
      else if (r === '/rules') view = h(Rules);
      else if (pm) view = h(Public, { uuid: pm[1] });
      else view = h(NoticeList);
      return h('div', null, [
        store.token ? h('header', null, [
          h('h1', null, '建设公告编辑系统'),
          h('span', { class: 'muted', style: 'color:#cdd8e6' }, (store.user?.display_name || '') + '（' + store.user?.role + '）'),
          h('span', { class: 'sp' }),
          h('button', { onClick: () => navigate('#/notices') }, '公告'),
          h('button', { onClick: () => { localStorage.clear(); store.token = ''; store.user = null; navigate('#/login'); } }, '退出'),
        ]) : (pm ? h('header', null, [h('h1', null, '公告公开页')]) : null),
        h('div', { class: 'wrap' }, view),
      ]);
    };
  },
};
createApp(App).mount('#app');
