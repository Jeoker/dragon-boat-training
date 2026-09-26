# Cloudflare 数据服务

这里是 C0 起建立的 Worker、`TeamState` Durable Object、SQLite schema 和持久调度代码。C1.1–C1.6 已加入并在隔离 staging 验收核心身份、赛季／成员、排期、报名候补、排座、冻结历史和运维；生产仍使用 Apps Script，本目录的实现不代表已经切换写入归属。

## 环境边界

- 默认配置名为 `dragon-boat-training-api-staging`，供本地和隔离 staging 使用。
- production 必须显式执行带 `--env production` 的脚本。两个环境拥有不同的 Worker 名称、Durable Object 命名空间、数据和 secret。
- `.dev.vars`、Wrangler 本地状态、干运行产物和覆盖率目录均被忽略。仓库只保留 `.dev.vars.example`。
- C0 内部测试入口仅在非 production 且请求提供 `C0_TEST_KEY` 时可用。C1 隔离业务入口另用 `C1_TEST_KEY`，并在内部继续验证 Coach Code 或新后端 session；C2 使用独立 `C2_TEST_KEY`，受保护读取还要求 C1 Coach session。三类入口在 production 均固定返回 `NOT_FOUND`。

## 本地命令

```text
npm run cf:types
npm run cf:check
npm run cf:test
npm run cf:dry-run
npm run cf:dev
npm run cf:accept:c1-staging
```

修改 `cloudflare/wrangler.jsonc` 的变量或绑定后必须重新运行 `npm run cf:types` 并提交生成的 `worker-configuration.d.ts`。契约测试会核对 staging 服务版本、接口清单和生成类型，避免配置与说明静默漂移。

`npm run cf:deploy:staging` 创建或更新隔离 staging。`npm run cf:accept:c1-staging` 使用 Git 忽略的 `.dev.vars` 执行显式远端验收；跨部署只读复验增加 `-- --verify-only`。该脚本不会随普通测试运行。`npm run cf:deploy:production` 只保留为明确的后续命令；C4 前不得用它接管生产业务。Cloudflare 和 Google secret 分别通过平台配置，不写入代码、Wrangler vars 或日志。

账户首次部署还需要在 Cloudflare Dashboard 启用一个 `workers.dev` 子域；Worker 上传成功不代表该公网地址已经可用。staging 的 `C0_TEST_KEY`、`C1_TEST_KEY`、`C2_TEST_KEY`、`COACH_CODE_SECRET`、`SESSION_SECRET`、`GOOGLE_BRIDGE_URL` 和 `GOOGLE_BRIDGE_SECRET` 必须用 Wrangler secret 或平台 secret 配置，不能加入 `wrangler.jsonc`。远端验收使用的 `C1_ACCEPTANCE_COACH_CODE` 只放在本地 `.dev.vars`，不上传为 Worker secret。Code secret 只核对迁入的旧摘要；新后端 session 使用独立 secret。`wrangler dev --remote` 可以验证 Worker 本身，但当前 Wrangler 不支持以该模式访问 Durable Objects SQLite，因此远端 DO 验收必须走已部署的 staging 地址。

## C0 已验证边界

SQLite schema v1 包含不可变请求结果、审计、outbox、持久任务和用于验收的原子计数器。alarm 每次领取有界任务，使用租约和尝试次数识别迟到结果；失败会在应用层继续排期。C1.1–C1.5 已在相同事务结构中加入核心、排期、报名候补、排座、冻结历史和运维规则；C1.6 已完成隔离 staging 全链路、跨 deployment 持久化、故障恢复和备份验收，C2 才接入完整 Google 同步。证据见 [C1.6 验收](../tests/C1-STAGING-ACCEPTANCE.md)。

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

公开排期和管理工作区仍是 C1 隔离投影，外层要求测试 key；报名、排座和冻结历史已分别由 C1.3–C1.5 接入。默认赛季修改、Google 执行、浏览器 CORS 和 Pages 路由仍未进入当前 C1 实现。

## C1.3 报名候补切片

schema v4 在训练版本状态中加入单调递增的队列序号，并增加报名、公开限流及报名影子快照表。报名 DTO 与严格解析在 `shared/c1-signup-contract.ts`，业务实现在 `cloudflare/src/c1-signup-service.ts`；公开和 Coach 的报名、换侧、取消动作仍统一经过 `shared/c1-actions.ts` 注册。

服务端按已发布且未结束的训练、赛季状态、成员资格、训练与报名版本执行写入。普通队员受报名截止约束，Coach 可在训练结束前代操作。容量分配和候补递补在单个 SQLite 事务中完成，固定侧和 Ambient 共用按 `(queue_at, queue_sequence)` 排序的唯一队列。没有草稿或正式版时按左右容量判断；已有排座后由真实空位和角色约束决定可行性。换侧保留原队列身份，但不保留已经主动放弃的船位；取消后重新报名取得新的时间和序号。

业务行、不可变回执、审计和 `SIGNUP_CHANGED` outbox 同事务提交；同编号同参数重放不重复写入。公开入口对每个成员按分钟做有界限流，已完成请求重放不重复计数。成员停用和核心影子导入都不能绕过未来有效报名关联；排期修改预览读取真实确认／候补人数并绑定当前报名版本。

`import-signups` 是受测试 key 保护的版本化影子导入，验证来源身份、引用、容量、队列顺序、递补完整性、时间边界和版本漂移；省略行不表示删除，导入不创建 Google outbox。`public-practice` 返回公开训练、报名及最新正式排座投影；私有排座草稿不会进入公开响应。全部 C1.3／C1.4 入口仍是隔离接口，没有连接 Pages 或 Google。

## C1.4 排座切片

schema v5 增加排座状态、完整私有草稿、不可变正式 revision、每版船位／姓名快照及排座影子快照表。严格 DTO 在 `shared/c1-seating-contract.ts`，服务实现位于 `cloudflare/src/c1-seating-service.ts`；影子导入、工作区读取、保存草稿和发布正式版统一由动作注册与契约清单约束。

Coach／Steerer 可由同一队员兼任，但角色成员不能同时拥有有效报名或桨位。训练前只有已确认报名可进入桨位，发布时必须为全部已确认报名排座；固定侧与实际船位不一致需要显式确认。草稿只在管理工作区可见，公开页始终读取最新不可变正式 revision。取消、换侧及候补递补与相关船位、系统 revision、版本、回执、审计和 outbox 在同一 SQLite 事务完成；Coach 已私下调整而偏离正式版的草稿不会被系统 revision 覆盖。

训练结束后至 `end_at + 24h` 可进行最终更正，可使用本季成员而不改报名。到精确截止时服务端立即返回 `SEAT_PLAN_FROZEN`，不等待后台扫描。C1.4 的 `FROZEN` 只表示写入边界和当前正式投影已锁定；C1.5 另从最终正式 revision 生成永久姓名／座位快照，当前投影本身仍不能当成年度历史。

`import-seating` 验证完整草稿、连续 revision、稳定编号、版本单调、成员引用、角色／报名冲突及不可变内容。相同状态版本必须连更新时间和操作者元数据也完全一致；最新正式 revision 会按当前成员、报名和完整排座规则重新验证，每版姓名快照只能包含该版角色及实际入座成员。省略记录不表示删除，导入不产生 Google outbox。成员停用同时检查未来有效报名、草稿角色／船位及最新正式角色／船位，不能绕过关联保护。

## C1.5 冻结历史与运维切片

schema v6 增加不可变训练历史、历史说明、赛季荣誉墙索引、历史影子快照、按赛季审计索引、应用用量快照及分块备份表。严格 DTO 位于 `shared/c1-history-contract.ts`，服务实现位于 `cloudflare/src/c1-history-service.ts`；C1 当前共四十二个集中注册动作。

已发布且未取消的训练在 `end_at + 24h` 后冻结。正式排座保存最终 revision 的显示姓名、角色和船位；没有正式排座的已发布训练明确保存为 `UNPUBLISHED`。冻结结果不再读取成员当前姓名，历史修正只追加单行说明并递增 `history_version`，不重写原快照。取消训练不会进入单场或整季历史。赛季截止时自动完成，全部有效训练冻结后创建赛季索引并把赛季置为 `ARCHIVED`；公开赛季目录、赛季内训练和管理审计均使用稳定 keyset cursor。

历史自动任务在影子阶段默认关闭：`writer_epoch=0` 且内部 `history_maintenance_enabled` 未开启时，只允许历史影子导入和读取，不会把导入数据当成当前写入权。C4 切换时才允许正式启用；C1.5 的本地专项测试显式开启该内部设置以验证冻结、重试与归档。修复扫描只检查未取消且尚未冻结的已发布训练，待执行任务的到期时间会随训练时间调整；应用用量统计每小时最多刷新一次，避免每次写入重复全库计数。

受保护备份在单个 SQLite 事务中截取业务、不可变请求、审计、outbox、任务和迁移状态，按一百行分块并生成 SHA-256 分块摘要和 manifest 摘要；读取和校验都要求有效 Coach 会话。短期 `coach_sessions`、公开限流状态、备份自身表不进入导出。C1.6 已在 125 名成员样本上下载并复算 191 条记录、29 个分块，且跨 Worker deployment 保持同一备份。这个结果只覆盖当前小团队规模，不代表无界数据量。备份内容仍含私人业务数据，必须由后续运维流程下载到仓库外的私有位置；Google 年度文件和外部存储导出属于 C2。

C0 桥接小样使用 `2026-09-19.bridge.v1` 信封；签名绑定方向、团队、绑定版本、`writer_epoch`、时间戳、nonce、操作编号及负载摘要。传输 nonce 与操作幂等编号分离。staging 的受保护探针允许选择有效、过期、篡改负载、错团队、错 binding 和错代次场景，以验证真实 Google 拒绝路径；production 固定关闭这些入口。当前 Apps Script 端只保存少量 C0 回执用于证明协议，C2 必须改用正式持久表和分段业务回执。

## C2.1 同步基础

概览响应中的 `binding_current` 明确标识所存绑定是否匹配赛季当前版本；旧绑定仍可诊断，但其旧版基线不计入当前基线数。

schema v7 在 C1 表之上增加赛季 Google 绑定、字段依赖组基线、稳定 Form／旧来源映射、冲突、同步批次和迁移快照。v6 原地升级保留全部 C1 数据，C1 备份范围也包含这些新表。`shared/c2-sync-rules.ts` 是唯一三方比较规则：以确认基线 `B`、Cloudflare 当前值 `C` 和 Google 值 `G` 按依赖组判断导出、自动导入、业务校验、人工确认、拒绝或冲突；删行和未映射字段不会被猜测成有效操作。

`import-sync-foundation` 只接收受控影子元数据，不访问 Google、不创建或确认 outbox。它保留稳定绑定和来源身份，拒绝版本倒退、同版本身份或映射漂移、跨赛季复用 Form／Spreadsheet、非法 Sheet tab ID、错误实体身份及来源重新指派。同一绑定版本可更新响应 Tab 名称、暂停标志和同步时间，但必须推进 `updated_at`，同步时间不可倒退；更换字段映射须提升绑定版本，不能更换文件或 Tab 身份。Form 和旧行来源的稳定键跨绑定版本保留，同一来源内容未变时无需提高来源版本。`get-sync-overview` 需要有效 Coach session；基线计数只看当前绑定版本，来源计数覆盖整个赛季。实现和本地证据见 [C2.1 验收](../tests/C2-SYNC-FOUNDATION-ACCEPTANCE.md)。

## C2.2 Form 来源导入

当前本地源码服务版本 `0.9.0-c2-form-import`、schema v8、隔离代次 `cf-c2-staging-4`；已部署 staging 仍为 C1.6。`pull-form-responses` 经签名 Apps Script 桥接读取当前绑定 Form；Cloudflare 校验页范围并在同一事务里提交成员、来源、核查、游标和回执。按回答 ID 保持稳定身份，以时间加回答 ID 排序，24 小时重叠补扫；同一请求 ID 重放结果。旧行不能用姓名推断关联，需 Coach 在 `resolve-form-source` 显式确认。业务 outbox 仍只是待同步，未写 Google。

十分钟 staging 定时器已写入配置，但 `C2_FORM_POLL_ENABLED=false`；production 无该定时器和 C2 路由。独立 Google 文件与真实 Web App 的手动拉取已验证。可安装 Google Forms 触发器的签名通知入口已部署到专用 `c2test`，真实 responder 页面提交及后续重叠补扫均通过；实际十分钟调度、近同时重复到达和失败恢复仍待验收。具体证据与待验收项见 [C2.2 验收记录](../tests/C2-FORM-IMPORT-ACCEPTANCE.md)。

`wrangler --env c2test` 是 C2.2 真实验收专用的**另一条** Worker／DO 命名空间，不是现有 C1.6 staging 或 production；无 cron，`writer_epoch=0`，独立服务端 secret。该环境已部署，并与独立 Google 测试 Web App 完成三条虚构 Form 回答的手动拉取及 Delta 的真实触发导入；原 staging 仍是 C1.6。`tests/live-c2-form-acceptance.mjs` 只接受该专用 Worker 地址和显式 `--write-test-data`，在第三条测试回答已提交的环境下另传 `--verify-incremental`；[触发器验收脚本](../tests/live-c2-form-trigger-acceptance.mjs)在 `before`／`after` 阶段只读名单，`overlap --write-test-data` 才显式手动拉取并验证去重。敏感绑定通过仓库外本地环境提供。不要将 `.dev.vars` 的旧 staging secret 上传给新环境。十分钟调度及完整 C2.2 验收仍待完成。
