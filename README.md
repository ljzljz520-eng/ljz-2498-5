# 公告编辑系统

Vue 界面录入项目、范围、资格、日期及附件；API 验证模式与评审权限；SQL 维护公告版本与审批；
对象服务保存固定附件及渲染结果。

> **声明**：本系统为公告流程辅助工具，其校验与渲染结果**不构成法律审查意见，不能替代专业法律审查**。
> 该声明同时展示于管理界面与每份公开文件页脚。

## 运行

```bash
npm install
npm start          # http://localhost:3000 （DATA_DIR/PORT 可覆盖）
npm test           # 16 项验收测试
```

演示鉴权：请求头 `x-user` / `x-roles`（界面右上角可切换角色：编辑/法务/业务/发布员/管理员）。

## 架构

```
public/index.html     Vue 3 单页（本地 vendor，无外部依赖）
server/app.js         API：验证模式、评审权限、状态机、发布校验、公开页缓存
server/db.js          SQLite：公告/版本/附件/评审/发布清单/上传会话/缓存/事件
server/store.js       对象服务：内容寻址(SHA-256)，保存固定附件与渲染结果
server/rules.js       跨字段冲突、评审定额、版本有效状态
server/render.js      正式文件渲染（确定性，可按清单重建）与公开页渲染
server/tz.js          墙钟×时区 → 瞬间换算（含 DST 二次校正）
data/                 app.db + objects/ + tmp/（重启后完整恢复）
```

## 日期语义：截止日 ≠ 带时区时刻

- **截止日**（`submit_deadline`）：纯日期 + 截止时刻 + **解释时区**，时区默认来自用户配置的
  公告规则（`deadline_timezone`）。存储保留民事分量，需要比较时才换算为瞬间——规则改时区
  不产生历史数据歧义。
- **带时区时刻**（公告开始、开标）：墙钟分量 + 时区，保存时换算为 UTC 瞬间同时保留原时区。
- 日期依赖全部来自规则：`min_notice_days`、`deadline_must_be_workday`(+`holidays`)、
  `bid_open_after_deadline_minutes`、`required_attachments`、`review_quorum` 等均为用户配置，
  规则版本化，每个公告版本记录其评审所依据的规则版。

## 状态机与竞争

`draft → in_review → approved → published`，任何非终态可 `withdrawn`（终态）。
所有迁移用**条件更新**（`UPDATE ... WHERE status=?`），在单事务内完成：

- **审批与撤回竞争**：批准达定额与撤回并发时，恰一方成功，另一方 409，终态与获胜方一致；
- **发布与撤回竞争**：发布事务末尾条件更新，撤回先提交则发布 409；
- 服务单进程内 better-sqlite3 同步执行，请求间天然串行；跨进程由 SQLite 事务保证。

## 评审绑定版本，变更触发复核

- 评审意见（`reviews`）绑定**具体版本**，按规则 `review_quorum` 计定额；
- 改**采购范围**或**替换/增删附件**（附件集摘要变化）→ 该版本全部有效批准置 `stale`（需复核）；
- 新建版本时若范围与附件集均未变，批准**平移**（记录来源），否则原批准失效；
- 同名附件替换写入 `attachment_revisions` 留痕（旧/新 SHA-256）。

## 发布校验（事务内）

1. 状态须为 `approved` 且发布的是当前版本；
2. **正文摘要** `expected_body_hash` 与当前版本一致（防评审后改动）；
3. **附件摘要** `expected_attachment_digest` 与当前附件集一致；
4. **规则版一致**：规则活动版 ≠ 评审依据版 → 409 `RULE_VERSION_MISMATCH`；
5. **不能发布半套附件**：存在未固定（上传未完成）或对象缺失的附件 → 409；
6. 跨字段冲突复检 + 评审定额复检；
7. 渲染正式文件（确定性 HTML）入对象库，写**发布清单**（正文摘要、附件摘要、规则版、
   附件哈希表、渲染对象键），替代链 `supersedes_version_id` 串联旧版，公开页缓存失效。

## 发布后原地编辑 vs 追加更正公告

| | 原地编辑（新版本替代） | 追加更正公告 |
|---|---|---|
| 适用 | 内容整体修订，旧版不应再被依赖 | 局部勘误，需保留原公告并显式标注 |
| 链条 | `supersedes_version_id` 替代链，旧版公开页标注「已被 vN 替代」并链接当前版 | 新公告 `corrects_announcement_id` 指向原公告，原页顶部提示「存在更正公告」 |
| 原公告有效性 | 旧版失效（superseded），仅最新发布版「当前有效」 | 原公告保持「已发布」，与更正公告并存 |
| 缓存 | 公告页与全部版本页缓存删除重建 | 原公告与更正公告双方缓存失效 |
| 流程 | 新版本重新走评审（范围/附件变更时批准需复核） | 更正公告同样走完整评审发布流程 |

旧公告链接**永久有效**并清楚显示有效状态：当前有效 / 已被 vN 替代（含跳转）/ 已撤回 / 未发布。

## 正式文件重建

`POST /api/announcements/:id/rebuild` 按发布清单：核对正文摘要 → 逐一校验附件对象
SHA-256 → 用同一确定性渲染器重渲染并比对渲染对象键，输出逐项校验报告。
渲染不含任何时钟依赖（发布时间取自清单），故重建结果与原件逐字节一致。

## 上传与服务重启

- 分片上传：`POST /api/uploads` → `PUT /:id/chunk?offset=`（偏移不符返回服务端断点）→
  `POST /:id/finalize`（校验大小+SHA-256，幂等）；
- 会话与已收字节持久化于 SQL，临时文件落盘，**服务重启后可查询断点续传**；
- 未完成的会话不能关联附件；附件未固定不能提交/发布。

## 验收场景 → 测试对照（`test/acceptance.test.js`，16 项全过）

| 场景 | 测试 |
|---|---|
| 日期倒置 | 预览报 `DATE_INVERTED`，提交 409 |
| 跨字段冲突预览 | 公告期不足 `NOTICE_TOO_SHORT`、开标早于截止 `BID_OPEN_BEFORE_DEADLINE` 等 |
| 截止日/时刻语义 | 同一截止日不同时区 → 不同截止瞬间，存储保留纯日期 |
| 同名附件替换 | 留痕、批准需复核、旧摘要发布 409 `ATTACHMENT_DIGEST_MISMATCH` |
| 改采购范围 | 批准不平移、原批准标记需复核 |
| 审批与撤回竞争 | 6 轮并发，恰一方 409，终态一致 |
| 上传未完成 | 不能关联、不能定稿、缺附件不能提交（不能发布半套附件） |
| 服务重启 | 状态恢复、上传断点续传、偏移纠错 |
| 旧公告链接 | 替代/撤回后旧链接有效且标注状态，缓存失效重建 |
| 按清单重建 | 正文/附件/渲染逐项一致 |
| 规则版一致 | 规则升级后发布 409 `RULE_VERSION_MISMATCH` |
| 评审权限 | 无角色 403；发布员角色校验 |
| 更正公告 | 独立流程、原公告页提示更正关系、原公告保持有效 |
| 审计 | 事件流覆盖创建/附件/提交/评审/批准/发布 |

## API 摘要

```
POST /api/rules                         规则新版本(admin)        GET /api/rules/:name/active
POST /api/announcements                 建公告+首版本(editor)    GET /api/announcements[/:id]
POST /api/announcements/:id/versions    新版本(替代链)           PUT /api/versions/:vid
GET  /api/versions/:vid/preview         预览：跨字段冲突/归一化日程/定额
POST /api/announcements/:id/submit      提交评审(冲突阻断)
POST /api/announcements/:id/reviews     评审(按角色权限,绑定版本)
POST /api/announcements/:id/withdraw    撤回(条件更新)
POST /api/announcements/:id/publish     发布(摘要/规则版/半套附件校验)
POST /api/announcements/:id/corrections 追加更正公告
GET  /api/announcements/:id/manifest    发布清单
POST /api/announcements/:id/rebuild     按清单重建正式文件
POST /api/uploads                       开上传会话               PUT /api/uploads/:id/chunk?offset=
POST /api/uploads/:id/finalize          定稿(幂等)               GET /api/uploads/:id (断点)
POST /api/versions/:vid/attachments     关联/同名替换附件        DELETE /api/attachments/:aid
GET  /public/announcements/:id          公开页(X-Cache: HIT/MISS)
GET  /public/announcements/:id/versions/:no  版本公开页(有效状态横幅)
```
