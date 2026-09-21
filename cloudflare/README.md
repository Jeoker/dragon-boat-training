# Cloudflare 数据服务

这里是 C0 起建立的 Worker、`TeamState` Durable Object、SQLite schema 和持久调度代码。C1.1–C1.2 已在本地加入核心身份、赛季／成员和排期切片；生产仍使用 Apps Script，本目录的实现不代表已经切换写入归属。

## 环境边界

- 默认配置名为 `dragon-boat-training-api-staging`，供本地和隔离 staging 使用。
- production 必须显式执行带 `--env production` 的脚本。两个环境拥有不同的 Worker 名称、Durable Object 命名空间、数据和 secret。
- `.dev.vars`、Wrangler 本地状态、干运行产物和覆盖率目录均被忽略。仓库只保留 `.dev.vars.example`。
- C0 内部测试入口仅在非 production 且请求提供 `C0_TEST_KEY` 时可用。C1 隔离业务入口另用 `C1_TEST_KEY`，并在内部继续验证 Coach Code 或新后端 session；两类入口在 production 均固定返回 `NOT_FOUND`。

## 本地命令

```text
npm run cf:types
npm run cf:check
npm run cf:test
npm run cf:dry-run
npm run cf:dev
```

`npm run cf:deploy:staging` 创建或更新隔离 staging。`npm run cf:deploy:production` 只保留为明确的后续命令；C4 前不得用它接管生产业务。Cloudflare 和 Google secret 分别通过平台配置，不写入代码、Wrangler vars 或日志。

账户首次部署还需要在 Cloudflare Dashboard 启用一个 `workers.dev` 子域；Worker 上传成功不代表该公网地址已经可用。staging 的 `C0_TEST_KEY`、`C1_TEST_KEY`、`COACH_CODE_SECRET`、`SESSION_SECRET`、`GOOGLE_BRIDGE_URL` 和 `GOOGLE_BRIDGE_SECRET` 必须用 Wrangler secret 或平台 secret 配置，不能加入 `wrangler.jsonc`。Code secret 只核对迁入的旧摘要；新后端 session 使用独立 secret。`wrangler dev --remote` 可以验证 Worker 本身，但当前 Wrangler 不支持以该模式访问 Durable Objects SQLite，因此远端 DO 验收必须走已部署的 staging 地址。

## C0 已验证边界

SQLite schema v1 包含不可变请求结果、审计、outbox、持久任务和用于验收的原子计数器。alarm 每次领取有界任务，使用租约和尝试次数识别迟到结果；失败会在应用层继续排期。C1.1–C1.2 已在相同事务结构中加入核心及排期业务表和规则；后续 C1 继续补齐报名、排座与历史，C2 才接入完整 Google 同步。

## C1 核心切片

schema v2 在 v1 表之上增加 `coaches`、`coach_sessions`、`settings`、`seasons`、`members` 和 `migration_snapshots`，不重建或清空 C0 表。动作、DTO 和运行时解析统一在 `shared/c1-contract.ts`；完整输入输出见 [C1 接口清单](../contracts/api-cloudflare-c1.json)。

`import-core` 是受 `C1_TEST_KEY` 保护的完整核心影子快照导入：保留稳定 ID、旧 Code salt／digest、实体版本和来源键；同版本不同内容、版本倒退、跨季悬空引用和来源键换人均停止。快照省略的实体不解释为删除，且影子导入不创建 Google outbox。它目前不是浏览器接口。

迁入 Code 经旧 HMAC 规则核对；登录后只签发包含 `backend_generation` 和 `writer_epoch` 的新会话，数据库不保存明文 Code、session token 或 Code secret。所有启用的 Coach、Steerer 和其他管理员仍使用同一权限。新建赛季和成员修改在业务行、不可变请求结果、审计和 `CORE_CHANGED` outbox 同一 SQLite 事务提交；C2 前 outbox 只积累，不安排假 Google 成功。

当前公开名单仅为隔离测试投影，外层仍要求 C1 测试 key。它按明确 `season_id` 读取，只返回有效成员的 ID、最终显示姓名、默认偏好和版本。

## C1.2 排期切片

schema v3 原地增加模板、训练周、训练场次、报名／排座版本占位和排期影子快照表。动作注册集中在 `shared/c1-actions.ts`，核心与排期 DTO／运行时解析分别在 `shared/c1-contract.ts` 和 `shared/c1-schedule-contract.ts`。服务实现拆分为核心身份与排期两个模块，共用严格契约错误转换、SQL 单行读取、操作回执、会话、请求身份、不可变回执、审计和 outbox。

周草稿从有效模板一次性生成并保持私有；立即开放在一个 SQLite 事务中公开整周有效训练。预约开放把确认版本和 `OPEN_TRAINING_WEEK` 任务一起提交，alarm 到期后重新核对 generation、writer epoch、赛季状态、周版本及确认版本；修改过的预约任务只完成为无操作，不会发布旧计划。到期发布保留管理员当时确认的版本、人员、时间和预约时间，只新增实际发布时间。开放周新增场次仍保持私有，必须单独发布。

修改与取消先返回绑定赛季、周、训练及报名版本的预览 token。改期保留原 publication week；取消只保留管理及恢复所需墓碑，公开排期不返回取消场次，全部场次取消后也不留下空周。业务行、回执、审计及 `SCHEDULE_CHANGED` outbox 同事务提交；可选 `current_view` 不进入不可变回执。

`import-schedule` 保留稳定 ID 和版本，验证跨表引用、周一边界、时区、发布／取消配对、报名截止及来源身份。影子导入不创建 outbox，也不为导入的 `SCHEDULED` 周启动任务，避免未取得写入归属时执行生产到期动作。

写入的请求摘要只由客户端提交字段产生，不把赛季当前时区等可变服务端状态写入摘要；已经完成的同编号重放先返回不可变结果，再处理当前业务校验。持久任务逐条解析并隔离失败，单条损坏 JSON 不会阻断同批其他任务；失败至少一秒后重试，outbox 会同步记录尝试次数和错误。

公开排期和管理工作区仍是 C1 隔离投影，外层要求测试 key。报名、排座、冻结历史、默认赛季修改、Google 执行、浏览器 CORS 和 Pages 路由尚未进入本切片。

C0 桥接小样使用 `2026-09-19.bridge.v1` 信封；签名绑定方向、团队、绑定版本、`writer_epoch`、时间戳、nonce、操作编号及负载摘要。传输 nonce 与操作幂等编号分离。staging 的受保护探针允许选择有效、过期、篡改负载、错团队、错 binding 和错代次场景，以验证真实 Google 拒绝路径；production 固定关闭这些入口。当前 Apps Script 端只保存少量 C0 回执用于证明协议，C2 必须改用正式持久表和分段业务回执。
