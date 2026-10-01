# C2.6 年度私有归档设计 - 第一切片

状态：2026-09-30，设计经 supervisor 与独立审核通过，已授权并完成纯 DTO／确定性投影／内存 exact-plan 第一切片，见 [本地验收](C2-ANNUAL-ARCHIVE-LOCAL-ACCEPTANCE.md)。没有 SQL 持久 adapter、schema 迁移、receipt 验证或年度远端验收结果。当前独立训练通道验收使用的 v14 源码、C1 行为、Worker 配置和 Google 文件均不由本切片改动。

## 1. 权威要求与当前缺口

以下要求已经在项目文档决定，不重新向用户询问：

- [迁移计划](../cloudflare-migration-plan.md)第 44 行和 C2.6 表项（第 186 行）：冻结以 DO 状态和服务器时间为准，不等待 Google；整季私有归档回执未核验时保持待完成；公开历史只读已核验的安全投影。年度业务档案必须可从冻结 DO 快照复算，原始回答另有来源清单、数量和摘要。
- [后端规格](../google-sheets-backend-spec.md)第 217–228 行：训练年度按训练开始日期在赛季时区的日历年确定；整季年度按赛季结束日期年份确定。年度文件由部署账号自动创建并复用、保持私有。文件和 Tab 使用稳定身份，名称仅供识别；未知创建结果不得按名称另建。
- 同一规格第 220、224、228 行及 [项目总览](../PROJECT-OVERVIEW.md)第 17、63 行：取消训练不进入档案或公开历史；未发布草稿只进私有档案，不阻塞有效训练完成；24 小时最终更正边界不因任务延迟改变；迟到回答不改变已经固定的档案。私有失败维持 `COMPLETED`；公开发布可以单独恢复。
- [迁移计划](../cloudflare-migration-plan.md)第 188、235–237 行：本地通过先于独立 Google 验收，C2.6 前不能宣布 C2 完成；年度档案不等于数据库备份或恢复。本切片不扩大到生产、cron 或 restore。

现有实现可以支持本地冻结，但不是 C2.6 完整年度导出：

| 现有位置 | 已实现 | 尚缺 |
|---|---|---|
| [c1-history-service.ts](../cloudflare/src/c1-history-service.ts)，`freezePractice` 第 323 行、`buildFrozenSnapshot` 第 372 行 | 到期冻结最后正式 revision、当时姓名与安全公开投影；取消过滤；原请求去重 | 完整私有业务快照（包括稳定业务 ID、最终报名、私有草稿和相关事件）的固定内容及归档摘要 |
| 同文件 `archiveSeason` 第 433 行 | 全部有效已发布训练冻结后写 `season_history`、将季状态设为 `ARCHIVED`、产生 `HISTORY_CHANGED` | Google 私有业务文件及原始回答核验门槛 |
| 同文件 `publicHistorySeasons` 第 157 行、`publicSeasonHistory` 第 181 行、`historyManagement` 第 623 行 | 按本地 `season_history` 提供公开目录及归档状态 | 区分本地冻结就绪和 Google 私有核验完成；此行为本切片保持不变 |
| 同文件 `captureBackup` 第 731 行、`finalizeBackup` 第 770 行 | 同事务固定表内容、块及清单；事务外算摘要后持久结果；可受保护下载核验 | 年度专用白名单投影。不能直接导出全库 backup，其包含凭据、请求等不属于年度档案的内容；现有全量物化方式也不是大季有界处理的证明 |
| [ArchiveActions.gs](../backend/src/ArchiveActions.gs)，第 200、270、303、370 行 | 原 Apps Script 年度映射、四列 JSON 行、写后回读、单场与整季内容；本地 P4/P5 测试 | 从 DO 固定快照接收内容的签名桥接、源回答独立清单、完整不可变 receipt 和未知创建窗口的可靠恢复 |
| [FormBridge.gs](../backend/src/FormBridge.gs)、[c2-form-bridge.ts](../cloudflare/src/c2-form-bridge.ts) | 稳定回答 ID、提交时间、姓名、分页导入 | 完整原始回答与响应 Sheet 内容。现有精简导入 DTO 不能充当原始回答档案 |
| [bridge.ts](../cloudflare/src/bridge.ts)、[Code.gs](../backend/src/Code.gs)第 76–108 行 | 签名身份、绑定、代次、摘要；已注册读表和运行表有限补丁 | 年度归档 bridge action；不能把运行表 patch 当作文件创建协议 |

`CURRENT-STATUS.md` 中的历史版本描述不得覆盖 supervisor 本轮新部署及进行中验收证据。本文仅调查源码和既定要求，不读取私有验收数据、不宣称远端状态已由本文验证。项目及上级目录本次未发现适用的 `AGENTS.md`。

## 2. 四个必须分开的状态

这些是拟议归档计划的内部状态，不是本切片对现有 C1 HTTP、`seasons.status` 或公开 API 的修改。

1. **frozen-ready**：训练已经自然到精确冻结边界且固定最后正式结果；整季已结束，全部未取消、已发布训练已冻结，完整私有业务 payload 已捕获并固定。不存在正式版本时保存明确 `UNPUBLISHED`，不以草稿替代。未发布训练草稿可纳入整季私有部分。
2. **business Google verified**：目标年度文件、Tab、分块与整份业务 manifest 已回读，身份、数量、每块摘要和总摘要都匹配 DO 固定内容；原 operation 的不可变 receipt 已验证。
3. **source archive verified**：绑定的原始入队来源已按固定截止范围形成完整 source manifest，并核验归档数量、身份和摘要。DO 不必保存完整原始答案，但必须保留可核验的来源证据和 receipt。空来源也须完整证据，不能以读取失败视为空。
4. **public eligible**：整季 frozen-ready，所有应归档单场业务均 verified，整季 business verified 与 source verified 同时成立；公开白名单投影与原固定业务 snapshot 的 ID、版本和摘要关联一致。只有此时才可在后续切片进入私有完成／`ARCHIVED`／公开发布流程。

单场业务可以先核验，不能因此宣布整季完成。任一 UNKNOWN、PARTIAL、FAILED、缺块或未核验回执都不满足整季门槛。Google 核验失败不延长更正时间、不重新开放训练或赛季。

上述关系是迁移计划的实现约束。当前 C1 的 `ARCHIVED` 和公开行为由后续审阅通过的接合切片调整，本切片绝不把旧公开数据突然隐藏，也不把既有 `ARCHIVED` 无条件冒充新的 Google verified 证据。已导入历史的兼容及外部档案证据迁移须独立定义。

## 3. 第一切片的精确范围

以下模型保留完整后续设计；本次实际授权实现范围仅纯 DTO、确定性投影和内存 exact-plan：

- 版本化归档 DTO、运行时校验及固定排序规则。
- 输入为显式冻结快照的确定性业务投影；不读当前 Google，不执行报名、递补、排座或冻结算法。
- 持久计划、固定内容块、摘要描述及 receipt 引用的数据模型；本地存储适配和 additive migration 必须另经 supervisor 授权，不能修改正在验收的 v14 schema。
- 纯构造 Node 测试及共享 TypeScript 检查；若后续授权落存储模型，验证原计划重放、摘要提交间隙、原数据保留与备份覆盖。

不新增公开或管理 HTTP endpoints，不改变共享 C1/C2 HTTP contract version，不接 alarm，不消费旧 `HISTORY_CHANGED` outbox，不调用 bridge，不生成真实年度文件，不修改 C1 冻结／状态／公开读取。本地模型不得存进已有公开 `snapshot_json` 或借用正在运行的 `sync_batches` 作为年度计划。

本次实现位置：`shared/c2-archive-contract.ts`（内部 DTO）、`shared/c2-archive-projection.ts`（纯投影及内存重放）、`tests/c2-archive-plan.test.mjs`。本地归档 SQL adapter 和对应 Workers/DO 持久测试待后续授权；本文没有预先占用 schema 版本号。

## 4. DTO 与确定性投影

业务 snapshot 分为 PRACTICE 和 SEASON，显式字段如下：

| 部分 | 必要字段／内容 |
|---|---|
| 身份 | format/projection version、team、season、可选 practice、原 binding、backend generation、writer epoch、snapshot ID、固定 captured_at、自然截止时间、显式 season_timezone及派生 archive year；practice.timezone分别保存，年度按season_timezone复算，不信任调用者提交的archive_year |
| 单场私有内容 | 固定日程与容量／时区／位置、冻结状态和 revision 指针、完整正式 revision及当时姓名／角色／座位、最终报名、必要私有草稿、单场相关业务事件 |
| 整季私有内容 | 固定季元数据、名单、模板、周次；未取消训练、报名／排座及相关配置；正式修订、冻结结果、相关事件；未发布草稿明确标识；已取消训练及其相关内容／cancelPractice事件不复制到年度档案 |
| 来源声明 | 原始来源另行归档的必需标识及 `SOURCE_NOT_YET_VERIFIED`，不能以业务 DTO 中的姓名或 source_imports 代替完整回答 |
| 完整性 | 稳定 record key、显式排序、记录／块数量、各块 exact payload JSON、各块摘要和 manifest 总摘要；空类别也在 manifest列出 |

公开投影复用现有白名单字段，不能从私有 payload 自动展开，也不得公开成员 ID、原始回答、凭据、私有草稿或内部 Google 定位。现有完整正式 revision 与冻结公开快照需交叉核验，缺名字或 revision 停止，不能用最新成员姓名补洞。

“取消排除”仅指取消训练，不指有效训练内的取消报名。有效训练中状态为 `CANCELLED` 的报名和 `cancelSignup` 等相关业务审计仍按最终报名明细／事件范围归档，不能误删。

排序使用各类已验证稳定业务键的明确比较规则，不使用可变 `rowid`、当前 Sheet 行号或运行时 locale。摘要只覆盖版本化固定规范内容；`captured_at` 在计划建立时固定，重试不重新取时钟。不自行实现新的哈希，复用 [crypto.ts](../cloudflare/src/crypto.ts) 的 SHA-256 和明确版本化的 canonical JSON，不能改旧请求摘要规则。

冻结一致性是门槛：一个年度 snapshot 的私有行必须来自同一个可证明一致的 DO 捕获范围。外部算摘要期间原文本须有事务锚；不能将多次分页读取的可变成员／配置拼成同一 snapshot。超出捕获资源预算时明确停止，不保存或称为 READY 的半份清单。是否采用 SQL 固定行副本或其他有界捕获方式，须由本地 adapter 设计及测量证明；不得直接照搬全库 backup 的无界物化。

## 5. 持久计划模型与重放

以下为待实施的逻辑模型，不是已创建的 SQL 表：

| 模型 | 持久信息 | 约束 |
|---|---|---|
| archive plan | 原请求身份及摘要、业务 snapshot 身份、binding／generation／epoch、固定截止范围和 captured_at、预期 manifest、状态、错误／退避、外部 operation 引用 | 同请求先重放原计划；相同身份不同参数拒绝；首次外部调用前已固定全部身份和内容；不根据新的活数据重算旧计划 |
| archive chunks | plan ID、类别、稳定 chunk index、offset／count、exact payload text、摘要 | 序号／覆盖完整且不重复；payload 固定后不可覆盖；摘要阶段事务复验原 text |
| source manifest | 来源类型、form／response-sheet稳定 ID、tab／schema 标识、固定 cutoff、source snapshot ID、记录数、完整来源摘要及分块描述 | 原始回答不混入业务摘要；来源不足或变更需明确失败；未知结果沿原来源操作恢复 |
| receipt / destination | 原 operation、team／season／binding／epoch、snapshot／chunk／manifest digest、年度文件和Tab稳定 ID、进度、核验状态和时间 | 完整身份匹配才接受；读到 target 不等于原 receipt verified；年映射、Tab映射及日志必须去重 |

可复用 `system_requests` 的原请求幂等、`scheduled_jobs` 的持久 lease／失败／退避思想，以及 backup 的块、清单和事务外摘要提交机制。但第一切片不安排任何自动 job。未来年度外部任务不会借用报名事务、运行表 B/C/G 基线或 lane 局部冲突清理。

后续若增加实际表，必须纳入受保护 backup 清单、迁移保留测试及非空计划／块／receipt 备份测试。未获授权前不添加表、迁移或调度器。

## 6. 后续 bridge 与技术核验门槛

这些是第一切片之外的待办，不能从本地投影测试推断已经解决：

- 签名 envelope、binding、writer epoch、原 operation 和 digest 复用 [bridge.ts](../cloudflare/src/bridge.ts)、[BridgeSecurity.gs](../backend/src/BridgeSecurity.gs)。年度命令必须在实际 `Code.gs` registry 和 action allowlist 注册，限定私有目标、正确年度和固定 snapshot；不能复用运行表 CAS 来悄悄创建文件。
- 旧 `ensureAnnualArchiveFile_` 在 `SpreadsheetApp.create` 与保存映射之间可能中断；当前源码没有证明该窗口能找到原创建结果。不得猜测 Drive 创建 API 支持幂等或按文件名称找到唯一结果。必须单独查官方能力、选择可证明的持久身份协议并故障测试，再实现。不能通过每次另建文件规避未知结果，也不能把用户手动建文件当作自动创建需求已完成。
- 旧 `writeAndVerifyArchiveTab_` 可以借鉴文本格式、manifest 和回读，但已有同名 Tab不证明身份正确；旧函数会覆盖内容，不能直接充当不可变归档写协议。分块重试必须保留原目标、验证已有内容、拒绝第三种内容，不能擦掉人工变化。
- 原始来源目前涉及完整绑定 response Sheet 与 Form 稳定回答 ID。源 manifest 必须明确完整 schema、header、原始值／类型规范、截止时间、删除或修改响应的处理和 source count；稳定 ID无法对应的记录不能按名字猜配。截止范围在第一次计划固定，迟到回答不追加旧档案。第一切片只表达必需 source evidence，不选择未经审查的 Google 分页／冻结协议。
- 私有权限必须验证，不能以“创建默认应私有”替代证据；独立测试年度文件与生产年映射隔离，未经授权不改生产 Apps Script。
- `HISTORY_CHANGED` 当前由 [c2-export-lanes.ts](../cloudflare/src/c2-export-lanes.ts)归为全季 BARRIER，而现有 [c2-export-poller.ts](../cloudflare/src/c2-export-poller.ts)无年度 handler。后续接合需明确处理该屏障、已发送原批 drain／暂停和年度任务关系；不得跳过未知事件或让年度任务确认 unrelated outbox。

### 官方创建能力的只读核验

2026-09-30 本轮只读取官方文档，没有调用 Google 创建、搜索或更新 API，没有证明任何远端创建恢复协议。

- [Drive Create and manage files - Generate IDs](https://developers.google.com/workspace/drive/api/guides/create-file#generate_ids_to_use_with_your_files)（页面更新 2026-09-04）：预生成 ID可供支持的 create/copy 使用，成功后重试同 ID可避免重复；但 Google Workspace 文件创建不支持预生成 ID，例外仅 `application/vnd.google-apps.folder` 和 `application/vnd.google-apps.drive-sdk`。年度 Google Spreadsheet 不在例外内，不能套用 generateIds 的去重保证。
- [Sheets spreadsheets.create](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create) 的方法定义只有 Spreadsheet 请求体与新建 Spreadsheet 响应，没有提供 `requestId` 或专门的 idempotency 参数。因此现阶段没有官方依据把重发 create 描述为安全恢复；这一结论只针对所核验的公开方法定义，不声称所有其他方案都不可行。
- [Drive custom file properties](https://developers.google.com/workspace/drive/api/guides/properties) 支持 app 限定的 `appProperties` 与搜索表达式。可作为后续方案候选：先持久原 operation ID，再在创建 metadata 中携带该 ID、team／year／snapshot 标记；结果未知进入年度计划的 `ACTION_REQUIRED`，只查询原标记或由管理员核验既有文件及权限。当前文档没有证明创建与标记的完整原子路径、搜索即时可见性或“list 为空即从未创建”；不得以 list 空结果自动重发创建。

上述候选仍需独立审阅／本地故障模拟和真实隔离核验。多匹配、无匹配、无权限或标记不一致都保留未知状态，不猜 ID、不按名称另建、不抹去原计划。第一次普通创建保持已批准的自动创建需求；未知结果暂停核查是一项安全恢复候选，不等于已经完成自动去重。该年度计划的 ACTION_REQUIRED 不借用或改写当前 v14 运行表导出 retry 状态。

## 7. 本地验收矩阵

| 场景 | 第一切片证据 |
|---|---|
| 到期／取消／草稿 | 未到24h拒绝；已取消训练及相关内容排除；有效训练的取消报名／cancelSignup审计保留；未发布明确结果；私有草稿不冒充正式结果 |
| 固定姓名和版本 | 改最新成员名不改变原正式／冻结名字；旧 revision 保留；缺引用、重复稳定键拒绝 |
| 年度路由 | 跨年季、训练 UTC 与赛季本地年不同、DST日期；practice年与season年分别正确 |
| 确定性 | 输入顺序变化不改规范内容／digest；captured_at固定；Unicode和空类别；同稳定键不同内容停止 |
| 原请求恢复 | 同ID原计划重放；不同参数冲突；摘要前后中断保留原text；未知外部状态不能 READY／verified |
| 业务与来源门槛 | business verified/source pending不能public eligible；空来源也需完整manifest；缺块、错ID、错digest拒绝 |
| 私有／公开边界 | 敏感字段不进入公开 DTO；成员凭据、session和完整backup不进入年度业务投影 |
| 存储授权后的测试 | additive迁移保留原C1/v14数据；计划／块／receipt非空backup覆盖；capture资源不足不产生伪完整快照；无网络、无alarm、无旧outbox消费 |

文件创建、Tab部分写入、已写后丢回执、重启／跨部署、Google故障、真实权限和来源完整性属于后续独立 Google 验收，不列为本切片可完成的证据。

本次第一切片只证明 deterministic plan 与内存 exact-plan 重放，不实现构造／模拟 receipt 验证。后续即使增加模拟 receipt，也不能称为真实 verified；没有实际 adapter 就不能称为已持久计划，没有 Google 回读及 receipt 核验就不能称为真实 verified。

## 8. 审阅和需要决定的部分

目前没有需要重新询问用户的产品选择。年度私有文件、内容范围、取消过滤和公开门槛已有文档授权；本文不改变它们。

supervisor 在开发前需要审定内部 DTO 与计划模型；在后续接合前需要审定：一致捕获的资源边界、原始来源固定／修改检测协议、Google未知创建结果的真实技术能力，以及旧 C1／导入历史兼容与 verified evidence 迁移。若可靠实现必须改变既定产品语义（例如取消自动建文件、减少完整原始回答范围或提前公开），再提交具体证据给用户确认，不由工具静默降级。

下一步：两名独立 reviewer 交叉审核本地第一切片的代码和证据；通过后由 supervisor 审定后续一致捕获／持久 adapter 的范围。本文自身不授权 schema／runtime 接合或远端执行。
