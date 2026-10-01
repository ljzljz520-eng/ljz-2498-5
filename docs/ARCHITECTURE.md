# 架构说明

## 进程与端口

| 组件 | 进程 | 端口 | 存储 |
|---|---|---|---|
| API + Web | `server/index.js` | 3000 | SQL 数据文件 `data/app.db`（WASM SQLite，原子 tmp+rename 落盘） |
| 对象服务 | `server/object-service.js` | 3010（独立鉴权 token） | `data/objects/objects`（不可变对象）、`.../tmp`（分片会话） |

API 启动时若对象服务健康检查失败，会作为子进程拉起它；两者也可分别启动以模拟独立部署。

## SQL 表（核心）

- `rule_sets`：公告规则版本（draft/active/retired），激活新版本自动退役同名旧版本。
- `notices`：公告头。`kind` original/amendment，`chain_id` 串联替代链，`supersedes_id` 指向被替代者，`chain_epoch` 用于公开缓存失效。
- `notice_versions`：不可变版本快照 `snapshot`、内容 `fingerprint`、状态机 draft/submitted/approved/rejected/superseded、`approval_fingerprint`、发布回写。
- `reviews`：评审决定（approve/reject/comment）**外键到 version_id**，全部历史保留。
- `transitions`：所有状态流转审计日志。
- `attachments` / `upload_sessions`：固定附件（`replaced_by` 记录同名替换）与可恢复上传会话。
- `publications`：每次发布的渲染键、清单键、附件摘要、指纹、规则版与当时 `cache_epoch`。

## 一致性与并发

1. 所有写操作经 `db.tx()`：单连接上的全局 Promise 串行队列 + `BEGIN IMMEDIATE/COMMIT`，提交后落盘。审批与撤回并发时，先提交者改变版本状态，后到者在事务内读到非 `submitted` 状态并返回 409（携带 `version_status/notice_status`）。
2. 版本不可变：采购范围/附件变更 → 新指纹 → 新版本；旧批准永远无法发布被改过的内容。
3. 发布器在对象层做存在性 + SHA256/大小复核；附件行若 `replaced_by` 非空则旧版本拒绝发布。
4. 对象键全部内容/版本寻址：`att/<sha>`、`outputs/<notice>/v<ver>/<sha>.html`、`snapshots/.../<sha16>.json`、`manifests/.../<sha16>.json`；PUT 遇同键不同内容返回 409，物理上不可覆盖。

## 日期语义

- `date`：日历日，`YYYY-MM-DD`；`instant`：RFC3339 含偏移。比较 instant 与 date 时，用规则时区把 instant 换算成本地日；同日 instant 对比较绝对时刻。
- 跨字段预览同时覆盖日期倒置、必填缺失、类型/形态混淆，以及正文—范围—资格之间的语义提醒（warning 不阻断、error 阻断提交/发布）。

## 公开页与缓存

`GET /api/public/notices/:uuid` 免登录：
- 以 `chain_epoch` 判定缓存新鲜度；新鲜时支持 `If-None-Match` → 304。
- 发布、撤回、替代都会 bump 整条链的 epoch 并删除内存缓存，达到显式失效。
- 页面在渲染 HTML 上注入“有效状态”横幅与替代链导航；旧公告链接永不静默消失。

## 重建（仅依赖固定对象）

发布清单包含：版本快照键、渲染键、附件 `{slot,filename,media_type,size,sha256,object_key}`、日期快照、规则引用、规范化 `manifest_sha256`。
重建 = 读清单+快照 → 用同一确定性渲染器重渲染 → 比对渲染哈希 → 逐个 HEAD 附件对象比对哈希 → 重算清单签名。任何固定对象损坏/缺失都会显式报告。

## 安全边界（本系统不做的事）

- 不做身份认证强度（演示用免密码登录）；生产应接入 SSO/密码与对象服务内网隔离。
- 不宣称替代法律审查：所有预览响应、发布返回与正式文件页脚均含免责声明。
