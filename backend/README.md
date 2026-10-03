# Apps Script 后端

本文记录代码结构、配置与部署方法。实际交付范围、部署版本、测试数量及验收边界统一见[当前进度](../CURRENT-STATUS.md)；阶段职责见[Epic 总览](../epics/README.md)。

## 代码与数据

本目录是切换前运行中的 Apps Script 实现。已确认的下一阶段使用 Cloudflare 主数据及 Google 桥接，按[迁移计划](../cloudflare-migration-plan.md)推进；下列锁、触发器、Code 维护和部署步骤仍仅用于当前 Apps Script 环境。C4 切换后按归属代次关闭旧业务写入和到期业务任务，不将旧部署说明直接用于恢复生产写入。

- `src/Code.gs`：Web App 入口、动作路由和统一响应格式。
- `src/CoachActions.gs`：登录、会话读取、测试写入和退出。
- `src/Security.gs`：HMAC 摘要、签名令牌、限流和脚本锁。
- `src/SystemStore.gs`：系统 Spreadsheet 表结构、请求去重、恢复记录和审计日志。
- `src/SeasonStore.gs`：赛季与每季 Spreadsheet 的受控记录访问、版本检查及旧赛季 P3 Tab 的按需建立。
- `src/SeasonActions.gs`：建季、绑定检查、初始化、成员导入和 Form 提交同步。
- `src/ScheduleActions.gs`：默认模板、周草稿、整周发布、预约发布、加场分层发布及到期冻结扫描。
- `src/ScheduleManagement.gs`：赛季日期与默认值、单场变更预览、排期确定计划、恢复与精确赛季完成；既有预约触发器继续使用，不重复安装。
- `src/PublicActions.gs`：公开赛季、已发布训练、管理详情和十分钟名单投影。
- `src/SignupActions.gs`：报名、候补、训练详情，以及报名变化与草稿／正式系统 revision 的同次可恢复写入。
- `src/MemberActions.gs`：受保护名册、资料修正、默认偏好、启停、角色和船位关联检查，以及完成赛季最终更正所需读取。
- `src/SeatingActions.gs`：排座工作区、完整草稿快照、角色、手动／系统 revision、最终更正及精确冻结快照。
- `src/ArchiveActions.gs`：到期冻结、分批归档检查点、单场及整季私有快照、年度归档文件、公开荣誉墙索引与缓存、更正说明、归档健康及分页操作记录。
- `src/TimeUtils.gs`：赛季时区、日历边界及本地训练时间解析。
- `src/Setup.gs`：一次性初始化及新增／重置个人 Coach Code。
- `src/FormBridge.gs`：C2.2 只读 Form 回答分页桥接，仅纳入完整后端构建；不进入独立 C0 探针。
- `src/SheetBridge.gs`：C2.3 签名只读 Sheet 桥接，按当前赛季绑定读取登记 Tab 的显示值、稳定行号和数字 Tab ID；本地源码还覆盖排期模板／周次及仅返回 ID 的 Coach 引用读取。缺少或超出界限的 Tab 返回错误，不修复、不写入。只纳入完整后端构建，不进入独立 C0 探针。
- `src/BoundRowPatchBridge.gs`：C2.4 有界行补丁。成员、赛季名单版本及排期三表已在独立 Google 文件验收；报名、排座草稿、当前船位和不可变正式 revision 四个 scope 已部署至隔离 Apps Script version 14。Alpha 单行报名、20 格草稿五批船位与一批状态、正式 revision 1 及其状态回执已真实确认；最终七个受支持 scope B/C/G 零差异。所有补丁共用签名、绑定／前值检查、最多四行／payload 预算、私有 `BridgeExportReceipts` 及重放后目标行复核。赛季补丁不能新建赛季行或改写 Google 的 Form／Spreadsheet 绑定列。上述 Alpha 结果是核心四表历史切片；后续候补、关联受控故障及独立训练已分别隔离验收，最新范围见[当前进度](../CURRENT-STATUS.md)；只进入完整后端构建，不进入 C0 探针，生产未部署。
- `src/FormNotify.gs`：C2.2 可安装的 Google Forms 提交触发器及签名 Cloudflare 通知。只在 Cloudflare 拥有写入权的赛季显式安装；现有生产赛季继续使用旧 Spreadsheet 提交触发器，不能并装或把独立 `c2test` 通知地址写入生产项目。当前仅在独立 C2 测试项目安装一个 Form 触发器，并已通过真实 responder 页面提交验收。
- `src/appsscript.json`：V8 运行时配置。
- `.clasp.json.example`：测试项目配置示例；真实 Script ID 不提交仓库。
- `build.mjs`：按固定顺序生成可直接粘贴到网页编辑器的单文件构建结果；从仓库根目录运行 `npm run build:backend`。
- `../contracts/api-v1.json`：当前请求和响应契约。

`ensureCloudflareFormSubmitTrigger_` 是受控部署时显式调用的安装工具，当前业务路由没有自动调用它。保留其重复触发器及旧 Spreadsheet 写入归属检查，C4 交接前不能接入生产自动安装流程。

长期系统 Spreadsheet 包含 `Coaches`、`CoachSessions`、`SystemRequests`、`SystemAuditLog`、`Seasons`、`SystemSettings`，以及归档使用的 `AnnualArchiveFiles`、`PracticeArchives`、`SeasonArchives`、`PublicHistoryIndex`、`PublicHistorySeasons`、`HistoryCorrections`。`PublicHistorySeasons` 保存每季紧凑目录、训练摘要、公开更正投影和详情行定位，日常历史读取无需扫描持续增长的训练索引；已有 P4 数据由 `setupDragonBoatP4` 幂等补建。每季响应 Spreadsheet 包含名单、排期、训练及报名表，并使用 `SeatPlanCurrent` 保存当前草稿座位、`SeatPlanState` 保存角色和版本指针、`SeatPlanRevisions` 保存不可变正式版本、`PracticeFinalSnapshots` 保存到期冻结快照；既有赛季在首次使用 P3 能力时按需建立新增 Tab。Code 使用随机 salt 和服务端 secret 生成摘要；短期会话令牌带服务端签名，Sheet 只保存令牌摘要。重置 Code 会推进 `credential_version`，停用凭据或版本变化会让旧会话立即失效。

既有五分钟 `publishDueTrainingWeeks` 触发器同时扫描到期冻结和归档，不另建第二个周期任务。每轮冻结与归档默认最多处理八个工作单元并分别保留游标，同时受默认 210 秒预算约束；后续触发从检查点继续。系统按训练年份自动创建并复用一个私有 `Dragon Boat Training Archive YYYY` Spreadsheet；取消训练不写入单场 Tab、整季快照或公开目录。整季私有快照核验后才把赛季标为 `ARCHIVED` 并批量写入荣誉墙投影。冻结后只允许通过受保护接口追加版本化更正说明，原座位快照不改写。

公开历史目录默认每页 30 条、最多 100 条；目录缓存五分钟，单季摘要缓存十五分钟，单场详情缓存一小时。缓存缺失时读取 `PublicHistorySeasons` 或按已保存行号读取单条快照，缓存失败则直接返回权威结果。管理审计默认每页 50 条、最多 100 条，并以游标倒序读取有限范围；不再为一次页面打开全量读取整个审计表。所有这些优化只影响只读投影，报名、容量、候补、排座草稿和版本校验仍读取权威表格。

报名与排座沿用同一 `Settings` 报名版本、服务器入队顺序和 `SystemRequests` 恢复协议。取消、换侧和自动递补在一次持锁事务中同步报名、草稿及必要的系统正式 revision；未发布草稿不会混入公开版本。提交顺序和恢复约束见[后端规格](../google-sheets-backend-spec.md#会话与写入一致性)。

正式座位角色使用固定的公开与管理投影入口。公开 `practice` 只返回 Coach／Steerer 的显示姓名；经 Coach session 保护的 seating workspace 才附带角色 `member_id`，供“从正式版重置草稿”恢复内部选择。普通 revision 与冻结快照遵守同一隔离规则。

来源归档的 capture-time 完整内容、固定 cutoff 和人工映射政策是 C2.6 目标；当前 `ArchiveActions.gs` 不因此具备来源完整性、可信映射或跨源一致性保证。年度业务冻结／历史归档与完整 Form／responseSheet 来源归档是不同范围。

`source-journal/` 是 C2.6 的隔离服务端适配器：完整 REST 来源两遍读取、私有单次原子 journal 及原内容回读，并有本机私有持久 operation／candidate／receipt CAS 和文件存储端口。独立 OAuth、真实读取、丢回复和跨进程回执恢复已在 2026-10-03 通过。候选须匹配原观测、known census、映射声明和响应 Tab 标题；持久候选不因重试重新采集，未知 journal 写入仅回读原目标。可选 `PrivateSourceReadAttempt` 逐请求保存原 URL／body、返回内容、位置摘要及观测时间；未知返回停止重取，完整 transcript 可重建同一 candidate。完整 range 保存后的跨进程续读及零来源重放见[checkpoint 实际验收](../tests/C2-SOURCE-READ-CHECKPOINT-ISOLATED-ACCEPTANCE-2026-10-03.md)。

新增 [`createAuthorizedSourceOperation`](source-journal/authority-context.ts) 从可信已认证服务器端口取得原来源 pin，并从私有登记端口取得固定 attempt、API owner 及 journal 目标。初次 capture 使用空人工映射声明；在读取前、候选保存前、journal 调用前及回执保存前重新确认服务器 pin 与私有登记。它已与真实本地 SQLite 会话组合测试；digest 只验证完整性，不能认证浏览器提供的 pin。若 write-start 已保存后权限丢失，保持原 marker，恢复只能回读原目标；NOT_FOUND 不能触发重新 stage。独立测试仍可直接构造不带鉴权端口的 `PrivateSourceOperation`，该入口不适合作为已认证服务入口。

[`SourceServerAuthorityClient`](source-journal/server-authority-client.ts) 通过固定 HTTPS origin 调用受 C2 transport key 和当前 Coach 会话双重保护的 `/internal/c2/pin-source-authority`。私有配置固定 backend instance／generation／epoch／team；拒绝重定向、错误 request／contract、异常 JSON、摘要不符和超预算响应，不保存凭据或透传错误正文。[`PrivateSourceTargetRegistry`](source-journal/target-registry.ts) 在私有 CAS 存储不可替换的 pin／attempt／owner／目标登记，已验证独立进程恢复。[`createPrivateSourceRuntime`](source-journal/private-runtime.ts) 组合这些端口、完整 REST reader 和 Google journal；来源读取强制持久 checkpoint，实际 Google 请求前后均重新核验当前服务器 pin 与原登记。Google OAuth token 端口仍与 Coach 凭据分开。使用端口与验收边界见[接线本地报告](../tests/C2-SOURCE-TRANSPORT-LOCAL-ACCEPTANCE-2026-10-03.md)。

[`PrivateSourceReview`](source-journal/private-review.ts) 通过 `PrivateSourceOperation.readForReview()` 取得原已确认候选，要求当前鉴权和原 journal 私有权限／内容复核。复用完整 retained plan 验证，将人工映射责任声明保存到独立私有 CAS ledger；actor取原来源上下文，时间取私有host。相同请求并发及丢确认恢复原证据，后续追加不改变旧请求的派生prefix；保存前和返回前复核权限及journal。实际本地HTTP／SQLite会话和两个独立Node进程恢复已[验收](../tests/C2-PRIVATE-SOURCE-REVIEW-LOCAL-ACCEPTANCE-2026-10-03.md)。内层LOCAL_* provenance保持兼容，外层仅声明私有ledger已持久，不授予来源核验或年度资格；其他Coach审核委派、审核页面和长期host尚未接入。

原回答、候选及文件操作状态只能保存在仓库外私有存储，禁止进入 Worker／DO 或公开备份。服务器表只保存来源身份与权威元数据；已知 census 不证明完整历史。内部 pin、私有 runtime 和持久审核组件已本地实现，尚未部署长期服务或新增前端入口；可信原生 Tab 关联、全部逐块恢复和实际服务器采集继续作为门槛。私有模块不在 `build.mjs`／C0 probe 构建中，来源仍未核验且年度导出未授权。通过 `npm run source:check` 执行[独立严格类型及未使用声明检查](source-journal/tsconfig.json)，再用 `npm test` 验证恢复与拒绝路径。见[来源权威历史本地验收](../tests/C2-SOURCE-AUTHORITY-LOCAL-ACCEPTANCE-2026-10-03.md)、[真实隔离验收](../tests/C2-SOURCE-JOURNAL-ISOLATED-ACCEPTANCE-2026-10-03.md)及[来源 OAuth 配置](../tests/C2-SOURCE-OAUTH-SETUP.md)。

## 第一次测试部署

C2.4 隔离补丁在私有系统 Spreadsheet 使用 `BridgeExportReceipts`，它由初始化建立，已有隔离测试文件首次收到批次时也可按固定列头补建。它不属于队员公开页面或 Form 回答区域；生产尚未部署这些写入动作。丢回执时必须复用原 batch ID、目标及前值，由桥接恢复逐行进度并让 Worker 重读确认，不能从当前报名重新生成旧批次。

后续 C2.5 在同一隔离 Google 文件对一条虚构成员行作整行 CAS 测试标记，Worker 因前值不符停止；桥接再用精确标记行作前值恢复原行，复读一致，Coach 显式重试后完成成员和赛季版本回执。此项[隔离故障验收](../tests/C2-ACTION-REQUIRED-ISOLATED-ACCEPTANCE-2026-09-30.md)不代表真实配额耗尽或随机断网已测，也没有将新版桥接部署到正式项目；`c2test` 的临时轮询开关已恢复关闭且无 cron。

向**既有** Apps Script Web App 推送构建结果时，必须保留该项目原有 `appsscript.json` 的 `webapp.executeAs` 与 `webapp.access` 设置；本仓库通用的 `src/appsscript.json` 不含这些部署设置，不能直接覆盖既有 Web App manifest。独立 C2 测试项目曾因此在 v8 返回 404；恢复其原 manifest 并重部署同一 Web App 为 v9 后，签名读取和成员写入均通过。生产项目未受影响。

1. 使用项目所有者长期控制且已授权的 Google 账号创建独立 Apps Script 测试项目；当前可用个人账号，不要求团队邮箱。可以预先创建测试 Spreadsheet，也可以让初始化函数自动建立默认名为 `Dragon Boat Training - P0 Test System` 的私有文件。
2. 在 Apps Script 的 Script Properties 中设置：
   - 可选 `DRAGON_BOAT_SYSTEM_SPREADSHEET_ID`；留空时自动创建
   - 可选 `DRAGON_BOAT_SYSTEM_SPREADSHEET_NAME`；仅在自动创建时使用
   - `DRAGON_BOAT_INITIAL_COACH_ID`，例如 `coach_yang`
   - `DRAGON_BOAT_INITIAL_COACH_NAME`
   - `DRAGON_BOAT_INITIAL_COACH_CODE`，长度 6 至 128 字符
   - 可选 `DRAGON_BOAT_SESSION_TTL_SECONDS`，允许 900 至 86400，默认 28800
   - 可选 `DRAGON_BOAT_ARCHIVE_BATCH_LIMIT`，允许 1 至 50，默认 8
   - 可选 `DRAGON_BOAT_ARCHIVE_TIME_BUDGET_MS`，允许 30000 至 270000，默认 210000
3. 将 `src/` 推送到测试 Apps Script 项目，运行 `setupDragonBoatP4` 并完成 Spreadsheet、Forms 和触发器授权。该函数包含 P0／P1 初始化，幂等建立预约开放触发器和 P4 系统 Tab；临时明文初始 Code 会自动删除。已有管理员且未提供新 Code 时可以安全重跑，不会轮换凭据或重复记录凭据事件。
4. 将 Web App 设为以部署账号执行，并允许队员无需 Google 登录访问。前端保存当前公开 `/exec` 地址作为默认值，也可以用构建变量 `PUBLIC_DRAGON_BOAT_API_URL` 覆盖。
5. 从实际 GitHub Pages 测试入口验证健康检查、Code 登录、受保护写入、重复请求、退出和过期会话。

### C0 Cloudflare 桥接小样

`cloudflareBridgeProbe` 是迁移期间的服务间签名读回入口，不是公开报名接口。独立测试 Apps Script 需在 Script Properties 配置 `DRAGON_BOAT_BRIDGE_SECRET`、`DRAGON_BOAT_BRIDGE_TEAM_ID`、`DRAGON_BOAT_BRIDGE_BINDING_VERSION` 和 `DRAGON_BOAT_BRIDGE_WRITER_EPOCH`；四项必须分别与 staging Worker 的 secret／vars 一致，C0 的 binding version 为 `c0`。`DRAGON_BOAT_BRIDGE_REPLAY_STATE` 由脚本私下维护，不应人工填写或复制到仓库。

运行 `npm run build:bridge-probe` 会生成 `backend/.build/bridge-probe/Code.gs` 和测试 Web App manifest，只组合正式源码中的配置、安全、桥接和 Web App 路由，便于用官方 `clasp` 创建独立 C0 deployment。它没有复制第二份签名算法；生成文件与本地 `.clasp.json` 均被忽略，修改必须落在 `src/`。探针项目只配置上述四个属性，不运行 `setupDragonBoatP4`，也不连接任何 Form／Spreadsheet。

探针 manifest 额外声明仅限项目所有者的 Execution API，并提供 `configureC0BridgeProbe` 和不返回 secret 的配置检查函数；匿名 Web App 仍只能依赖签名信封进入 `cloudflareBridgeProbe`。默认 GCP 项目在 C0 实测中不允许 `clasp run`，因此实际初始值通过 Apps Script Project Settings 写入；若未来改用标准 GCP 项目，才可使用该辅助函数。配置函数不进入正式后端构建，不返回或记录 secret。

共享 secret 不出现在请求正文、源码、`wrangler.jsonc`、日志或验收报告中。C0 只验证签名、时间窗、nonce、操作幂等、归属和 Content Service 重定向；Form／Sheet 分段读写、正式回执表及同步恢复属于 C2。生产 Apps Script 在 C4 写入交接前仍是唯一业务后端，不能因为桥接探针存在就关闭旧逻辑。

C2.2 的完整后端源码注册 `cloudflareReadFormResponses`：读取当前赛季绑定 Form 的稳定回答 ID、时间和已映射姓名，核对 Form 目的地，并返回有界分页。`cloudflareReadSheetRecords` 允许赛季、成员、报名、训练、模板、周次、排座草稿、当前船位、正式 revision 和 Coach ID 等固定范围；最后一种只返回 ID，不返回凭据摘要。其余范围返回显示单元格供 Worker 检验结构与 B/C/G。主附表合计最多 100,000 个单元格、2,000,000 个字符，单格最多 10,000 字符；超限拒绝整次检查。2026-09-30 核心关联链路历史验收时，独立 C2 测试 Web App 为 version 14，关联四表最初均为空；当时 Alpha 唯一报名、20 个当前船位、一条状态及一条正式 revision 已依序写入，四表行数 1／1／20／1，七个受支持 B/C/G scope 零差异。隔离 system `Coaches` 一条虚构、inactive、无 Code 的引用只由一次性 fixture 在测试项目 HEAD 补入，不是可用登录账户。正式生产 Apps Script 和 Google 文件未连接新后端；后续候补及关联受控故障已隔离验收，最新范围见[当前进度](../CURRENT-STATUS.md)。

本地使用 clasp 时，把 `.clasp.json.example` 复制为 `.clasp.json` 并替换测试 Script ID；`rootDir` 已指向 `src`。真实 `.clasp.json`、Code、会话令牌和 Spreadsheet ID 不提交仓库。

## 新增或重置个人 Code

在 Script Properties 临时设置 `DRAGON_BOAT_PROVISION_COACH_ID`、`DRAGON_BOAT_PROVISION_COACH_NAME` 和 `DRAGON_BOAT_PROVISION_COACH_CODE`，运行一次 `provisionDragonBoatCoachFromProperties`。相同 `coach_id` 会重置凭据并使旧会话失效；新的 `coach_id` 会建立独立凭据。临时明文 Code 在成功后自动删除。

需要停用管理人员时，将 `Coaches.active` 改为 `FALSE`；后续所有管理请求都会拒绝该凭据及其旧会话。交接时应先为继任者建立独立 ID，再停用离任者。

## 验证边界

根目录 `npm test` 覆盖 P0／P1 基线、P2 业务边界、未知结果重试、写后故障恢复、持锁 `flush` 顺序、请求内缓存隔离，P3 草稿隔离、角色与桨位互斥、手动与系统 revision、报名联动、版本冲突、最终更正及精确冻结边界，P4 的取消过滤、单场／整季快照、年度文件复用、公开字段隔离、更正说明和归档中断恢复，以及 P5 的两秒合并保存、审计与历史分页、有界读取、公开缓存、紧凑索引、批量写入及分批归档续跑。周生成的计划恢复已有专项回归，其他 P1 写入路径不能据此视为已通过全部中断测试。

最新真实 Google／Pages 验收和测试数据收尾记录见[当前进度](../CURRENT-STATUS.md)、[P1 管理补齐验收](../tests/P1-MANAGEMENT-ACCEPTANCE.md)及[P3 验收报告](../tests/P3-ACCEPTANCE.md)。继续写入前必须重新核对当前服务器状态，不把历史清理记录当作持续不变的状态。

[live-p1-management-acceptance.mjs](../tests/live-p1-management-acceptance.mjs) 是显式手动运行的 P1 历史验收脚本，只识别独立的 `P1 Management Acceptance 2026` 两名虚构成员。运行要求进程环境中的 `DBT_API_URL`、`DBT_COACH_CODE` 和 `--write-test-data`；默认模式拒绝复用已有的 9 月 21 日批次，不能清空记录以强行重跑。P4 起取消训练不再公开，因此旧 `--verify-retained-history` 模式只对应 Version 12 及以前的历史证据，不可用于当前部署验收。临时切换默认值后按归属和版本检查恢复，只取消自己创建的场次，保留报名、座位版本和审计。首次测试中的断言修正及实际通过范围见验收报告；不要把退出前的通过计数当作整轮成功。

[live-p2-acceptance.mjs](../tests/live-p2-acceptance.mjs) 是显式手动集成脚本，不随 `npm test` 执行。设置运行时环境变量 `DBT_API_URL` 后，从仓库根目录运行 `node tests/live-p2-acceptance.mjs --write-test-data`；仅在隔离测试赛季、约定的虚构队员及初始空报名场次通过检查后写入。清理只取消本次运行创建、且 `queue_at` 与 `queue_sequence` 仍匹配的报名；不清空其他报名、不删除成员或审计，归属变化时停止并人工核对。脚本、文档及测试结果不得包含真实私有文件 ID 或凭据。

[live-p21-timing.mjs](../tests/live-p21-timing.mjs) 对同一测试赛季首场及固定虚构队员执行两轮报名、换侧、取消，再改名并恢复、退出。仅通过运行时环境设置 `DBT_API_URL`、`DBT_COACH_CODE`，显式传入 `--write-test-data`；`--optimized` 使用当前视图及合并读取，默认模式模拟原请求链。可用 `DBT_TIMING_REPORT` 将去除身份信息的报告写入被忽略的 `.build/`。报告测量 API 请求链耗时、次数和响应字节数，不等同于浏览器渲染耗时或锁占用时间。失败会记录清理未完成，必须核对原请求与测试队员状态，不能直接重新整轮运行或清空表格。

[live-p3-acceptance.mjs](../tests/live-p3-acceptance.mjs) 只允许文档约定的隔离测试赛季、22 名虚构成员、三场已发布训练及初始空报名、空角色、空正式座位和空草稿状态。运行同时要求 `DBT_API_URL`、`DBT_COACH_CODE` 及 `--write-test-data`，验证草稿隔离、角色与桨位互斥、错侧确认、手动／系统 revision、取消递补和换侧清位。每次重试复用原 `request_id` 和完整参数；若无法确认写入结果或测试数据归属发生变化，立即停止自动清理并要求人工核对。2026-09-04 的 Version 10 真实运行以退出码 0 完成，最终返回 `ok=true`；本轮有效报名全部取消，空角色和空座位正式版已发布，会话已撤销，完整边界见 [P3 验收报告](../tests/P3-ACCEPTANCE.md)。
