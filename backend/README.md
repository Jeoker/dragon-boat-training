# Apps Script 后端

本文记录代码结构、配置与部署方法。实际交付范围、部署版本、测试数量及验收边界统一见[当前进度](../CURRENT-STATUS.md)；阶段职责见[Epic 总览](../epics/README.md)。

## 代码与数据

本目录是切换前运行中的 Apps Script 实现。已确认的下一阶段使用 Cloudflare 主数据及 Google 桥接，按[迁移计划](../cloudflare-migration-plan.md)推进；下列锁、触发器、Code 维护和部署步骤仍仅用于当前 Apps Script 环境。C4 切换后按归属代次关闭旧业务写入和到期业务任务，不将旧部署说明直接用于恢复生产写入。

- `src/Code.gs`：Web App 入口、动作路由和统一响应格式。
- `src/CoachActions.gs`：登录、会话读取、测试写入和退出。
- `src/Security.gs`：HMAC 摘要、签名令牌、限流和脚本锁。
- `src/SystemStore.gs`：系统 Spreadsheet 表结构、请求去重、恢复记录和审计日志。
- `src/SeasonStore.gs`：赛季与每季 Spreadsheet 的受控记录访问、版本检查及已有赛季排座 Tab 的按需建立。
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
- `src/NativeTabBridge.gs`：`cloudflareReadNativeTabProof`核对Form destination、Spreadsheet、唯一numeric Tab及Sheet.getFormUrl对应真实Form，返回独立HMAC当前关系观察。纳入完整backend构建，不进入bridge-probe；Cloudflare显式capture-native已消费原观察，真实Google及云端流程仍待验收。
- `src/BoundRowPatchBridge.gs`：C2.4 有界行补丁，覆盖成员、赛季名单版本、模板／周次／训练、报名、排座草稿／当前船位及不可变正式 revision。共用签名、绑定／前值检查、最多四行／payload 预算、私有 `BridgeExportReceipts` 及重放后目标行复核；赛季补丁不能新建赛季行或改写 Google 的 Form／Spreadsheet 绑定列。只进入完整后端构建，不进入 C0 探针；实际隔离验收与生产部署边界见[验证索引](../tests/CURRENT-VERIFICATION.md#google-同步)。
- `src/FormNotify.gs`：C2.2 可安装的 Google Forms 提交触发器及签名 Cloudflare 通知。只在 Cloudflare 拥有写入权的赛季显式安装；切换前生产赛季继续使用旧 Spreadsheet 提交触发器，不能并装或把独立 `c2test` 通知地址写入生产项目。实际触发与补扫证据见验证索引。
- `src/appsscript.json`：V8 运行时配置。
- `.clasp.json.example`：测试项目配置示例；真实 Script ID 不提交仓库。
- `build.mjs`：按固定顺序生成可直接粘贴到网页编辑器的单文件构建结果；从仓库根目录运行 `npm run build:backend`。
- `../contracts/api-v1.json`：当前请求和响应契约。

`ensureCloudflareFormSubmitTrigger_` 是受控部署时显式调用的安装工具，当前业务路由没有自动调用它。保留其重复触发器及旧 Spreadsheet 写入归属检查，C4 交接前不能接入生产自动安装流程。

长期系统 Spreadsheet 包含 `Coaches`、`CoachSessions`、`SystemRequests`、`SystemAuditLog`、`Seasons`、`SystemSettings`，以及归档使用的 `AnnualArchiveFiles`、`PracticeArchives`、`SeasonArchives`、`PublicHistoryIndex`、`PublicHistorySeasons`、`HistoryCorrections`。`PublicHistorySeasons` 保存每季紧凑目录、训练摘要、公开更正投影和详情行定位，日常历史读取无需扫描持续增长的训练索引；已有归档数据由 `setupDragonBoatP4` 幂等补建。每季响应 Spreadsheet 包含名单、排期、训练及报名表，并使用 `SeatPlanCurrent` 保存当前草稿座位、`SeatPlanState` 保存角色和版本指针、`SeatPlanRevisions` 保存不可变正式版本、`PracticeFinalSnapshots` 保存到期冻结快照；既有赛季在首次使用排座能力时按需建立新增 Tab。Code 使用随机 salt 和服务端 secret 生成摘要；短期会话令牌带服务端签名，Sheet 只保存令牌摘要。重置 Code 会推进 `credential_version`，停用凭据或版本变化会让旧会话立即失效。

既有五分钟 `publishDueTrainingWeeks` 触发器同时扫描到期冻结和归档，不另建第二个周期任务。每轮冻结与归档默认最多处理八个工作单元并分别保留游标，同时受默认 210 秒预算约束；后续触发从检查点继续。系统按训练年份自动创建并复用一个私有 `Dragon Boat Training Archive YYYY` Spreadsheet；取消训练不写入单场 Tab、整季快照或公开目录。整季私有快照核验后才把赛季标为 `ARCHIVED` 并批量写入荣誉墙投影。冻结后只允许通过受保护接口追加版本化更正说明，原座位快照不改写。

公开历史目录默认每页 30 条、最多 100 条；目录缓存五分钟，单季摘要缓存十五分钟，单场详情缓存一小时。缓存缺失时读取 `PublicHistorySeasons` 或按已保存行号读取单条快照，缓存失败则直接返回权威结果。管理审计默认每页 50 条、最多 100 条，并以游标倒序读取有限范围；不再为一次页面打开全量读取整个审计表。所有这些优化只影响只读投影，报名、容量、候补、排座草稿和版本校验仍读取权威表格。

报名与排座沿用同一 `Settings` 报名版本、服务器入队顺序和 `SystemRequests` 恢复协议。取消、换侧和自动递补在一次持锁事务中同步报名、草稿及必要的系统正式 revision；未发布草稿不会混入公开版本。提交顺序和恢复约束见[后端规格](../google-sheets-backend-spec.md#会话与写入一致性)。

正式座位角色使用固定的公开与管理投影入口。公开 `practice` 只返回 Coach／Steerer 的显示姓名；经 Coach session 保护的 seating workspace 才附带角色 `member_id`，供“从正式版重置草稿”恢复内部选择。普通 revision 与冻结快照遵守同一隔离规则。

来源归档的 capture-time 完整内容、固定 cutoff 和人工映射政策是 C2.6 目标；当前 `ArchiveActions.gs` 不因此具备来源完整性、可信映射或跨源一致性保证。年度业务冻结／历史归档与完整 Form／responseSheet 来源归档是不同范围。

## 私有来源与运维工具

完整来源、checkpoint、journal 和只追加审核由[独立来源组件](../tests/C2-ANNUAL-SOURCE-CAPTURE-DESIGN.md)负责；长期托管使用[独立私有 Worker／DO](../cloudflare/PRIVATE-SOURCE-HOST-DESIGN.md)。原文不进入业务 TeamState、普通业务备份或 Apps Script 构建。

| 工具 | 编译／运行 | 使用说明 |
|---|---|---|
| 本地来源 host | npm run source:host:build、npm run source:host | [私有配置、原操作恢复及审核](PRIVATE-SOURCE-HOST.md) |
| 业务保护备份 | npm run backup:business:build、npm run backup:business | [固定身份下载、离线核验与原包演练](backup/README.md) |
| Cloudflare Coach 自轮换 | npm run coach:rotate | [self-only、原receipt及UNKNOWN恢复](coach/README.md) |

本地工具继续使用仓库外私有配置和权限校验。实际实现／部署见[当前进度](../CURRENT-STATUS.md)，有效 Google／SQLite 证据见[验证索引](../tests/CURRENT-VERIFICATION.md)。

## 第一次测试部署

C2.4 隔离补丁在私有系统 Spreadsheet 使用 `BridgeExportReceipts`，它由初始化建立，已有隔离测试文件首次收到批次时也可按固定列头补建。它不属于队员公开页面或 Form 回答区域；生产尚未部署这些写入动作。丢回执时必须复用原 batch ID、目标及前值，由桥接恢复逐行进度并让 Worker 重读确认，不能从当前报名重新生成旧批次。

向**既有** Apps Script Web App 推送构建结果时，必须保留该项目原有 `appsscript.json` 的 `webapp.executeAs` 与 `webapp.access` 设置；本仓库通用的 `src/appsscript.json` 不含这些部署设置，不能直接覆盖既有 Web App manifest。完整backend构建含NativeTabBridge，probe构建不含该动作；本地构建成功不代表隔离或生产Google项目已更新。

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
3. 将 `src/` 推送到测试 Apps Script 项目，运行 `setupDragonBoatP4` 并完成 Spreadsheet、Forms 和触发器授权。该函数包含系统与赛季初始化，幂等建立预约开放触发器和归档 Tab；临时明文初始 Code 会自动删除。已有管理员且未提供新 Code 时可以安全重跑，不会轮换凭据或重复记录凭据事件。
4. 将 Web App 设为以部署账号执行，并允许队员无需 Google 登录访问。前端保存当前公开 `/exec` 地址作为默认值，也可以用构建变量 `PUBLIC_DRAGON_BOAT_API_URL` 覆盖。
5. 从实际 GitHub Pages 测试入口验证健康检查、Code 登录、受保护写入、重复请求、退出和过期会话。

### C0 Cloudflare 桥接小样

`cloudflareBridgeProbe` 是迁移期间的服务间签名读回入口，不是公开报名接口。独立测试 Apps Script 需在 Script Properties 配置 `DRAGON_BOAT_BRIDGE_SECRET`、`DRAGON_BOAT_BRIDGE_TEAM_ID`、`DRAGON_BOAT_BRIDGE_BINDING_VERSION` 和 `DRAGON_BOAT_BRIDGE_WRITER_EPOCH`；四项必须分别与 staging Worker 的 secret／vars 一致，C0 的 binding version 为 `c0`。`DRAGON_BOAT_BRIDGE_REPLAY_STATE` 由脚本私下维护，不应人工填写或复制到仓库。

运行 `npm run build:bridge-probe` 会生成 `backend/.build/bridge-probe/Code.gs` 和测试 Web App manifest，只组合正式源码中的配置、安全、桥接和 Web App 路由，便于用官方 `clasp` 创建独立 C0 deployment。它没有复制第二份签名算法；生成文件与本地 `.clasp.json` 均被忽略，修改必须落在 `src/`。探针项目只配置上述四个属性，不运行 `setupDragonBoatP4`，也不连接任何 Form／Spreadsheet。

探针 manifest 额外声明仅限项目所有者的 Execution API，并提供 `configureC0BridgeProbe` 和不返回 secret 的配置检查函数；匿名 Web App 仍只能依赖签名信封进入 `cloudflareBridgeProbe`。Execution API 的可用性由 GCP 项目配置决定；可在 Apps Script Project Settings 手动设置同一属性。配置函数不进入正式后端构建，不返回或记录 secret。

共享 secret 不出现在请求正文、源码、`wrangler.jsonc`、日志或验收报告中。C0 只验证签名、时间窗、nonce、操作幂等、归属和 Content Service 重定向；Form／Sheet 分段读写、正式回执表及同步恢复属于 C2。生产 Apps Script 在 C4 写入交接前仍是唯一业务后端，不能因为桥接探针存在就关闭旧逻辑。

C2.2 的完整后端源码注册 `cloudflareReadFormResponses`：读取当前赛季绑定 Form 的稳定回答 ID、时间和已映射姓名，核对 Form 目的地，并返回有界分页。`cloudflareReadSheetRecords` 允许赛季、成员、报名、训练、模板、周次、排座草稿、当前船位、正式 revision 和 Coach ID 等固定范围；最后一种只返回 ID，不返回凭据摘要。其余范围返回显示单元格供 Worker 检验结构与 B/C/G。主附表合计最多 100,000 个单元格、2,000,000 个字符，单格最多 10,000 字符；超限拒绝整次检查。这些固定范围和补丁只供隔离服务；当前远端及有效验收由当前进度和验证索引维护。

本地使用 clasp 时，把 `.clasp.json.example` 复制为 `.clasp.json` 并替换测试 Script ID；`rootDir` 已指向 `src`。真实 `.clasp.json`、Code、会话令牌和 Spreadsheet ID 不提交仓库。

## 新增或重置个人 Code

在 Script Properties 临时设置 `DRAGON_BOAT_PROVISION_COACH_ID`、`DRAGON_BOAT_PROVISION_COACH_NAME` 和 `DRAGON_BOAT_PROVISION_COACH_CODE`，运行一次 `provisionDragonBoatCoachFromProperties`。相同 `coach_id` 会重置凭据并使旧会话失效；新的 `coach_id` 会建立独立凭据。临时明文 Code 在成功后自动删除。

需要停用管理人员时，将 `Coaches.active` 改为 `FALSE`；后续所有管理请求都会拒绝该凭据及其旧会话。交接时应先为继任者建立独立 ID，再停用离任者。

## 验证边界

根目录 `npm test` 覆盖业务规则、锁与恢复、公开隔离、归档及分页／缓存。准确命令见[测试入口](../tests/README.md)，有效结果见[验证索引](../tests/CURRENT-VERIFICATION.md)。周生成已有中断恢复回归；其他管理写入不能据此视为全部故障路径已验收。

[报名工具](../tests/live-p2-acceptance.mjs)、[排座工具](../tests/live-p3-acceptance.mjs)及[排期管理工具](../tests/live-p1-management-acceptance.mjs)仅供显式隔离验证；运行前核对脚本固定夹具和当前数据，业务写入需 `--write-test-data`。排期工具仅识别原 `P1 Management Acceptance 2026`；当前取消训练不公开，旧 `--verify-retained-history` 不适用于当前部署。默认值按归属／版本恢复，保留全部报名、revision和审计；旧批次拒绝后不能清空记录重跑。

[live-p21-timing.mjs](../tests/live-p21-timing.mjs) 对同一测试赛季首场及固定虚构队员执行两轮报名、换侧、取消，再改名并恢复、退出。仅通过运行时环境设置 `DBT_API_URL`、`DBT_COACH_CODE`，显式传入 `--write-test-data`；`--optimized` 使用当前视图及合并读取，默认模式模拟原请求链。可用 `DBT_TIMING_REPORT` 将去除身份信息的报告写入被忽略的 `.build/`。报告测量 API 请求链耗时、次数和响应字节数，不等同于浏览器渲染耗时或锁占用时间。失败会记录清理未完成，必须核对原请求与测试队员状态，不能直接重新整轮运行或清空表格。

[live-p3-acceptance.mjs](../tests/live-p3-acceptance.mjs) 只允许文档约定的隔离测试赛季、22 名虚构成员、三场已发布训练及初始空报名、空角色、空正式座位和空草稿状态。运行同时要求 `DBT_API_URL`、`DBT_COACH_CODE` 及 `--write-test-data`，验证草稿隔离、角色与桨位互斥、错侧确认、手动／系统 revision、取消递补和换侧清位。每次重试复用原 `request_id` 和完整参数；若无法确认写入结果或测试数据归属发生变化，立即停止自动清理并要求人工核对。
