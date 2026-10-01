# C2 整体代码与文档审核 - 2026-10-01

状态：本轮整体本地复核、源码修补及文档审计完成，最终全量回归通过。没有远端操作、部署或重新验证历史 Google 现场；不据此宣布 C2.4／C2.5／C2.6 整体通过。

## 范围、方法和证据层次

起始范围是 git ls-files '*.md' 的全部 **79 份 tracked Markdown**，含产品／当前状态／规格、backend／Cloudflare／contracts、三个 Epic、历史验收、技术设计及执行前运维计划。新增本文后审核文档集合为80份。本轮文档作者只修改 Markdown；团队另行修改源码／测试，各自证据分开记录。

所有79份均纳入完整文本状态词／版本／下一步／权限及条件词扫描、相对文件链接和标题锚点核对。权威入口、现行技术设计及命中矛盾的段落与源码／契约／配置逐项对照；日期验收报告检查时间、环境、结果范围和后续备注，保留原历史事实和测试计数。清单的“已检查”表示上述审计范围，不表示逐份重做其历史测试或证明每条历史源码结论在今天仍成立。既有 documentation-consistency 测试验证文件链接及 npm 命令；补充只读扫描核对标题 fragment，首轮无缺失文件或标题锚点。

当前部署与本轮源码须分开：远端专用 c2test 仍为0.17.0-c2-associated-lanes／schema14／47表，pollfalse、crons=[]；本地年度持久计划为schema15／50表。生产仍使用 Apps Script，原 staging／Pages／双 Google clean 不因本地审核变化。最后实际隔离现场以[独立训练验收](C2-ASSOCIATED-LANE-ISOLATED-ACCEPTANCE-2026-09-30.md)为准，未执行 restore。

## 文档发现及修订

| 发现 | 实际对照及修订 |
|---|---|
| contracts 与后端索引仍称候补／关联故障／同季冲突未验收 | 依据候补受控故障和独立训练实际报告改为已完成的隔离范围；保留随机故障、真实配额、自动cron、restore及远端并发SENT等未测项。C2.4／C2.5整体未完成 |
| Cloudflare索引把早期0.16.1／schema13写成当前，且混淆两／三环境及C0回执 | 旧数字标2026-09-30历史快照，新增当前隔离／本地年度边界；区分默认staging保留的cron、c2test与production无cron，以及独立探针和完整BridgeExportReceipts |
| 已执行的候补／fault／pause计划仍称待执行，lane设计仍称未部署 | 增加历史范围及实际报告链接；保留当时执行前门槛与固定版本，不赋予重跑旧脚本的新授权 |
| 来源设计／政策段仍笼统称人工审核尚未实现 | 明确本地pure与plan-only模型已实现，真实Coach认证、来源读取、固定私有capture及持久审核CAS没有接线；当前所有原Sheet行仍PRIVATE_PENDING，整体SOURCE_NOT_VERIFIED |
| SOURCE_GAP被与来源状态并列，可能把覆盖限制当删除事实 | 区分来源状态、拒绝码和条件分类；GAP_LEDGER包含SOURCE_GAP／UNSUPPORTED／PROOF_REQUIRED／COVERAGE_LIMIT，条件总数不是已发生缺失总数 |
| JSON安全整数规则被写为所有Cloudflare数字 | 限定业务版本／计数等整数DTO；来源模型支持有限IEEE-754数值，canonical不是原HTTP字节或历史精度恢复 |
| Epic写“带队角色互斥”可能禁止真实C1的同人双角色 | 明确Coach与Steerer可同人兼任，互斥的是角色与划桨座位；未新增业务规则 |
| Cloudflare报名topic写SIGNUP_CHANGED | 核实际C1写入topic为SIGNUPS_CHANGED并修正索引 |
| 年度第一切片／preview旧下一步与后续存储实现混读，引用易漂移行号 | 添加历史范围，后续schema15持久计划链接；改为实际章节引用。旧259／262／237等计数不更新为新全量 |
| 物理诊断未来巡检硬指schema14，当前schema14已用于lanes | 移除未来schema编号假设，要求另审巡检状态表和迁移；保留该诊断当时schema13的实测证据 |
| 产品与总览未明确业务档案／完整来源档案的实现边界 | 补已接受current值／固定cutoff语义及本地模型非真实认证／来源verified边界；生产架构与单独c2test分开 |

原请求、完整core、raw／schema、chunk集合、来源条件、cutoff与追加ledger语义以现行共享模块和各切片报告为准。此次没有把LOCAL_INPUT／RETAINED_PLAN_ONLY升级为真实来源权限或receipt，没有改变已批准产品政策，也没有选择私有存储许可。

## 本轮源码发现与验证状态

以下是团队本轮真实发现，不是本报告文档作者实施的源码改动。本轮问题已按下表闭环；最终冻结版回归与独审结果见执行记录，不沿用前一提交计数。

| 项目 | 复现／修复门槛 | 当前记录 |
|---|---|---|
| 年度业务输入的toJSON／getter与sparse arrays | descriptor检查先于复制／序列化；拒绝执行访问器或toJSON绕过预算，错误固定且不含私有异常；dense数组canonical合法JSON | 已关闭：完整Node361通过；conflict独立pure119／native archive28及类型通过，含该输入门槛 |
| 来源pinned context的Proxy／getter及字符串前置预算 | sourcePinnedContext固定primitive descriptor副本，Proxy trap异常固定化；sourceText先按UTF16长度保守拒明显超额，再扫Unicode／UTF8，不执行caller getter或toJSON | 已关闭：源码及负例经最终Node361和独立pure审查覆盖；不将本地context声明视为真实Auth |
| 导出晚到failure／success与Coach rearm竞争 | 每次真实导出基于观察到的完整retry行做CAS，旧回复不能覆盖后来halt、清除新failure或Coach rearm | 已关闭：新增4个failure及1个success真实并发回归，受影响Workers90与末real-work观察点delta6通过；完整259通过 |
| scheduled-vs-opened测试依赖wallclock睡眠 | 原测试首轮254中253通过、1失败；采用可控DO到期／alarm边界，证明到期前不发布、到期后一次发布，不以更长sleep掩盖 | 已关闭：统一可控Date构造／now及exact-due alarm，冻结版完整259通过；不声称固定sleep已消除时序风险 |
| 两个Astro未使用测试符号提示 | root移除未用assertLaneProgress import；callback第二参数改名为明确忽略的 _message，保持arity及第三retryable参数语义，检查最终构建 | 修后 supervisor 实际 build 三页通过，0error／0warning／0hints |
| 重复内存archive store | 实际持久request由schema15 service承担；仅测试调用的InMemoryArchivePlans及memory_requests／memory_bytes已删除，两项store自证test移除；保留真实record／chunk预算并新增有效负例 | 已核当前源无旧class及预算字段；历史报告标superseded，保留当时数字 |

年度业务 input／plan仍限2MB、record5000、chunk64KB／100 records；descriptor-first固定JSON副本只接受完整受支持JSON，年度输入depth40。generic archiveCanonical的16.1MB上界仅供内部完整SQL row文本比较，不是年度输入或原始来源预算。来源raw输入depth32、生成wrapper40规则不变。

## 未关闭技术门槛与可执行下一步

这些是实施／证据缺口，不重问已接受的来源语义或人工信任政策。

1. 私有staging／原payload保存：先选定并审核可靠私有存储、ACL与scope；原operation和完整payload在外部调用前可靠固定。源码候选Drive固定ID或已有Sheet atomic batch并非已实现许可。原内容丢失或权限不明即停止，不新建目标、不重读活来源替换旧档。
2. 真实完整读取／capture：核实际Forms REST与Sheets grid权限，完整page／range覆盖、类型、census、cutoff首次时间，记录observed interval并检测漂移。双pass不证明跨源原子瞬间，未知历史内容不可恢复；未知／不支持类型完整pending或whole-input拒绝，不静默删字段。
3. 真实Coach与映射：在私有读取前及所有await后验证实际Coach权限和当前binding／generation／epoch，固定双方fullraw/schema hash与追加证据。纯context port只是本地权威声明，内部export不是公开授权入口。人工声明不能消其他gap、改raw或自动整体verified。
4. 持久审核／未知恢复：完整原corehash与原ledger权威锚、原ID参数、prefix和首time固定；落库CAS、重启、并发和未知回复须真实验证。pure“append_required”／返回原子性不是SQLite提交或Googlereceipt。
5. 年度输出／公开接合：业务LOCAL_DIGEST_READY、来源NOT_VERIFIED、Google业务receipt及永久来源receipt分别核验；私有文件未知创建、formula-like值只作文字、完整回读和公开白名单另验。数据库backup不等于年度archive或restore。
6. C2.5剩余远端门槛：真实配额／随机网络、SENT并发暂停窗口、自动cron、restore和更广实体仍缺独立实证。当前pollfalse／crons=[]与生产AppsScript写入权保持原边界。

## 无引用脚本／export审查与实际清理

只读扫描git tracked代码／Markdown中的文件名及符号引用；npm测试仅自动发现tests/*.test.mjs。零引用只是审查起点，不证明无用。团队随后逐一核固定版本、用途和替代验收，按 supervisor 授权删除下列六个 obsolete 手动工具，保留一个仍有未来作用的工具；本报告不授权运行。扫描依据是审计开始时 tracked 正文，不把新报告中的候选名当作既有调用。

| 候选 | 证据与处置边界 |
|---|---|
| live-c2-c25-backup.mjs、live-c2-member-export-acceptance.mjs、live-c2-schedule-acceptance.mjs、live-c2-sheet-acceptance.mjs | 已删除。分别钉0.16.1/schema13、0.11、0.14/schema11、0.12/schema9；没有tracked调用，当前lane／waitlist已覆盖相应来源和完整backup验证，不能用于新基线 |
| live-c2-waitlist-member.mjs | 已删除。钉0.16.2/schema13及Lambda名册10→11一次准备，已完成且无后续tracked调用；旧journal不可用于新来源 |
| prepare-c2-associated-script.mjs | 已删除。只支持clean v12和历史duplicate Code.gs升级，当前双clean恢复协议不使用该入口 |
| prepare-c25-poll-config.mjs | 保留。没有旧version pin，仅生成ignored隔离配置；保持staging／production关闭、c2test无cron。未来poll独立验收尚未被当前禁poll通道验收替代，文件存在不授权启用轮询 |
| legacyJson、apiMeta | 已收窄为crypto.ts／http.ts内函数，原实际调用保留；连同下列三个shared函数共五项仅取消export可见性，没有删业务校验 |
| sourceCellUnsupported、addSourceRecord、planDigest | 已收窄为模块内部函数；原实际调用及业务校验保留，没有删除功能 |
| astro.config.mjs | 无文件名引用但由Astro约定自动加载，明确排除dead候选 |

脚本入口清理须先检查固定版本、journal、真实运维用途及替代证据；历史报告引用的模块变化只能标superseded，不能篡改当时实测。

## 本轮实际执行记录

supervisor提供的首轮本地记录：Node357/357、types通过；Astro三页build通过（0error／0warning／2unused hints）；backend及bridge-probe构建通过。Workers首轮为253/254，scheduled-vs-opened竞态1失败；已修复并在最终259项中通过。restricted缓存写EPERM后，获自动批准的escalated本地命令完成；没有远端操作。这些是本轮首轮检查，不是最终修补源码的全部通过证据。

修补后 supervisor 唯一完整 Node **361/361，exit0**（357＋6个有效新增－2个旧store自证test），Astro三页面构建 **0errors／0warnings／0hints**。最终类型、Workers23files **259/259，exit0**（既有254＋5真实并发回归）、backend／bridge-probe构建均通过；git diffcheck通过。

文档作者documentation-consistency为2/2、tracked Markdown diffcheck通过（仅LF／CRLF提示），补充80份文档564条本地文件及标题fragment无断链；新增报告已由docs测试覆盖。两名独立源码审查无未解P1/P2；conflict独立shared pure119／native SQL archive28／类型通过，受影响runtime三组90通过。baseline独立runtime90通过，随后仅real-work观察点最终小改再测6/6（余84跳过），不称重新运行末版90；最终完整259由supervisor执行。baseline与conflict最终文档只读签核均PASS；baseline另独立docs2/2通过，80份／564链接扫描归文档作者，不冒称两人各自重做全扫描，不将定向结果称独立全量。前一adapter提交的357、其定向93／12、历史storage264／254等证据保留在各自报告，不冒充本轮最终结果。

## 已检查文档清单

以下79项来自本轮开始时tracked清单；正文扫描、状态分类、链接及标题检查均已覆盖。新增本文是第80项，最后纳入相同文档检查。

- [x] [CURRENT-STATUS.md](../CURRENT-STATUS.md)
- [x] [PROJECT-OVERVIEW.md](../PROJECT-OVERVIEW.md)
- [x] [README.md](../README.md)
- [x] [backend/README.md](../backend/README.md)
- [x] [cloudflare-migration-plan.md](../cloudflare-migration-plan.md)
- [x] [cloudflare/README.md](../cloudflare/README.md)
- [x] [contracts/README.md](../contracts/README.md)
- [x] [epics/README.md](../epics/README.md)
- [x] [epics/admin.md](../epics/admin.md)
- [x] [epics/backend.md](../epics/backend.md)
- [x] [epics/frontend.md](../epics/frontend.md)
- [x] [frontend-spec.md](../frontend-spec.md)
- [x] [google-sheets-backend-spec.md](../google-sheets-backend-spec.md)
- [x] [tests/C0-CLOUDFLARE-ACCEPTANCE.md](C0-CLOUDFLARE-ACCEPTANCE.md)
- [x] [tests/C1-CORE-ACCEPTANCE.md](C1-CORE-ACCEPTANCE.md)
- [x] [tests/C1-HISTORY-ACCEPTANCE.md](C1-HISTORY-ACCEPTANCE.md)
- [x] [tests/C1-SCHEDULE-ACCEPTANCE.md](C1-SCHEDULE-ACCEPTANCE.md)
- [x] [tests/C1-SEATING-ACCEPTANCE.md](C1-SEATING-ACCEPTANCE.md)
- [x] [tests/C1-SIGNUP-ACCEPTANCE.md](C1-SIGNUP-ACCEPTANCE.md)
- [x] [tests/C1-STAGING-ACCEPTANCE.md](C1-STAGING-ACCEPTANCE.md)
- [x] [tests/C2-ACTION-REQUIRED-ISOLATED-ACCEPTANCE-2026-09-30.md](C2-ACTION-REQUIRED-ISOLATED-ACCEPTANCE-2026-09-30.md)
- [x] [tests/C2-ACTION-REQUIRED-REMOTE-PLAN.md](C2-ACTION-REQUIRED-REMOTE-PLAN.md)
- [x] [tests/C2-ANNUAL-ARCHIVE-DESIGN.md](C2-ANNUAL-ARCHIVE-DESIGN.md)
- [x] [tests/C2-ANNUAL-ARCHIVE-LOCAL-ACCEPTANCE.md](C2-ANNUAL-ARCHIVE-LOCAL-ACCEPTANCE.md)
- [x] [tests/C2-ANNUAL-CAPTURE-LOCAL-ACCEPTANCE.md](C2-ANNUAL-CAPTURE-LOCAL-ACCEPTANCE.md)
- [x] [tests/C2-ANNUAL-CAPTURE-STORAGE-DESIGN.md](C2-ANNUAL-CAPTURE-STORAGE-DESIGN.md)
- [x] [tests/C2-ANNUAL-SOURCE-CAPTURE-DESIGN.md](C2-ANNUAL-SOURCE-CAPTURE-DESIGN.md)
- [x] [tests/C2-ANNUAL-STORAGE-LOCAL-ACCEPTANCE.md](C2-ANNUAL-STORAGE-LOCAL-ACCEPTANCE.md)
- [x] [tests/C2-ASSOCIATED-EXPORT-LOCAL-2026-09-30.md](C2-ASSOCIATED-EXPORT-LOCAL-2026-09-30.md)
- [x] [tests/C2-ASSOCIATED-FAULT-REMOTE-PLAN.md](C2-ASSOCIATED-FAULT-REMOTE-PLAN.md)
- [x] [tests/C2-ASSOCIATED-ISOLATED-ACCEPTANCE-2026-09-30.md](C2-ASSOCIATED-ISOLATED-ACCEPTANCE-2026-09-30.md)
- [x] [tests/C2-ASSOCIATED-LANE-DESIGN.md](C2-ASSOCIATED-LANE-DESIGN.md)
- [x] [tests/C2-ASSOCIATED-LANE-ISOLATED-ACCEPTANCE-2026-09-30.md](C2-ASSOCIATED-LANE-ISOLATED-ACCEPTANCE-2026-09-30.md)
- [x] [tests/C2-ASSOCIATED-LANE-LOCAL-ACCEPTANCE.md](C2-ASSOCIATED-LANE-LOCAL-ACCEPTANCE.md)
- [x] [tests/C2-ASSOCIATED-LANE-REMOTE-PLAN.md](C2-ASSOCIATED-LANE-REMOTE-PLAN.md)
- [x] [tests/C2-ASSOCIATED-PAUSE-DRAIN-REMOTE-PLAN.md](C2-ASSOCIATED-PAUSE-DRAIN-REMOTE-PLAN.md)
- [x] [tests/C2-EXPORT-ACTION-REQUIRED-LOCAL-2026-09-30.md](C2-EXPORT-ACTION-REQUIRED-LOCAL-2026-09-30.md)
- [x] [tests/C2-EXPORT-CONTROLS-ISOLATED-2026-09-30.md](C2-EXPORT-CONTROLS-ISOLATED-2026-09-30.md)
- [x] [tests/C2-EXPORT-OPERATIONS-LOCAL-2026-09-29.md](C2-EXPORT-OPERATIONS-LOCAL-2026-09-29.md)
- [x] [tests/C2-FORM-IMPORT-ACCEPTANCE.md](C2-FORM-IMPORT-ACCEPTANCE.md)
- [x] [tests/C2-LOSS-AND-SCHEDULE-SCHEMA-2026-09-28.md](C2-LOSS-AND-SCHEDULE-SCHEMA-2026-09-28.md)
- [x] [tests/C2-MEMBER-EXPORT-ACCEPTANCE.md](C2-MEMBER-EXPORT-ACCEPTANCE.md)
- [x] [tests/C2-PHYSICAL-DIAGNOSTICS-DESIGN.md](C2-PHYSICAL-DIAGNOSTICS-DESIGN.md)
- [x] [tests/C2-PHYSICAL-DIAGNOSTICS-ISOLATED-ACCEPTANCE-2026-09-30.md](C2-PHYSICAL-DIAGNOSTICS-ISOLATED-ACCEPTANCE-2026-09-30.md)
- [x] [tests/C2-PHYSICAL-DIAGNOSTICS-ISOLATED-PLAN.md](C2-PHYSICAL-DIAGNOSTICS-ISOLATED-PLAN.md)
- [x] [tests/C2-PHYSICAL-DRIFT-ISOLATED-ACCEPTANCE-2026-09-30.md](C2-PHYSICAL-DRIFT-ISOLATED-ACCEPTANCE-2026-09-30.md)
- [x] [tests/C2-POST-EXPORT-CODE-DOC-REVIEW-2026-09-28.md](C2-POST-EXPORT-CODE-DOC-REVIEW-2026-09-28.md)
- [x] [tests/C2-RECENT-CODE-REVIEW-2026-09-27.md](C2-RECENT-CODE-REVIEW-2026-09-27.md)
- [x] [tests/C2-SCHEDULE-BRIDGE-LOCAL.md](C2-SCHEDULE-BRIDGE-LOCAL.md)
- [x] [tests/C2-SCHEDULE-CONFLICT-ISOLATED-2026-09-30.md](C2-SCHEDULE-CONFLICT-ISOLATED-2026-09-30.md)
- [x] [tests/C2-SCHEDULE-EVENT-SNAPSHOT-LOCAL.md](C2-SCHEDULE-EVENT-SNAPSHOT-LOCAL.md)
- [x] [tests/C2-SCHEDULE-EXPORT-LOCAL-2026-09-28.md](C2-SCHEDULE-EXPORT-LOCAL-2026-09-28.md)
- [x] [tests/C2-SCHEDULE-FAULT-ISOLATED-2026-09-30.md](C2-SCHEDULE-FAULT-ISOLATED-2026-09-30.md)
- [x] [tests/C2-SCHEDULE-ISOLATED-ACCEPTANCE-2026-09-29.md](C2-SCHEDULE-ISOLATED-ACCEPTANCE-2026-09-29.md)
- [x] [tests/C2-SCHEDULE-PROJECTION-LOCAL-2026-09-28.md](C2-SCHEDULE-PROJECTION-LOCAL-2026-09-28.md)
- [x] [tests/C2-SEASON-PATCH-LOCAL.md](C2-SEASON-PATCH-LOCAL.md)
- [x] [tests/C2-SENT-PAUSE-LOCAL-ACCEPTANCE.md](C2-SENT-PAUSE-LOCAL-ACCEPTANCE.md)
- [x] [tests/C2-SHEET-DIFF-ACCEPTANCE.md](C2-SHEET-DIFF-ACCEPTANCE.md)
- [x] [tests/C2-SIGNUP-EVENT-SNAPSHOT-LOCAL.md](C2-SIGNUP-EVENT-SNAPSHOT-LOCAL.md)
- [x] [tests/C2-SOURCE-CAPTURE-PURE-LOCAL-ACCEPTANCE.md](C2-SOURCE-CAPTURE-PURE-LOCAL-ACCEPTANCE.md)
- [x] [tests/C2-SOURCE-MAPPING-REVIEW-DESIGN.md](C2-SOURCE-MAPPING-REVIEW-DESIGN.md)
- [x] [tests/C2-SOURCE-MAPPING-REVIEW-LOCAL-ACCEPTANCE.md](C2-SOURCE-MAPPING-REVIEW-LOCAL-ACCEPTANCE.md)
- [x] [tests/C2-SOURCE-PLAN-REVIEW-ADAPTER-DESIGN.md](C2-SOURCE-PLAN-REVIEW-ADAPTER-DESIGN.md)
- [x] [tests/C2-SOURCE-PLAN-REVIEW-ADAPTER-LOCAL-ACCEPTANCE.md](C2-SOURCE-PLAN-REVIEW-ADAPTER-LOCAL-ACCEPTANCE.md)
- [x] [tests/C2-SOURCE-PLAN-VALIDATION-DESIGN.md](C2-SOURCE-PLAN-VALIDATION-DESIGN.md)
- [x] [tests/C2-SOURCE-PLAN-VALIDATION-LOCAL-ACCEPTANCE.md](C2-SOURCE-PLAN-VALIDATION-LOCAL-ACCEPTANCE.md)
- [x] [tests/C2-SYNC-FOUNDATION-ACCEPTANCE.md](C2-SYNC-FOUNDATION-ACCEPTANCE.md)
- [x] [tests/C2-WAITLIST-FAULT-PAUSE-ISOLATED-ACCEPTANCE-2026-09-30.md](C2-WAITLIST-FAULT-PAUSE-ISOLATED-ACCEPTANCE-2026-09-30.md)
- [x] [tests/C2-WAITLIST-REMOTE-PLAN.md](C2-WAITLIST-REMOTE-PLAN.md)
- [x] [tests/P1-MANAGEMENT-ACCEPTANCE.md](P1-MANAGEMENT-ACCEPTANCE.md)
- [x] [tests/P2.1-ACCEPTANCE.md](P2.1-ACCEPTANCE.md)
- [x] [tests/P3-ACCEPTANCE.md](P3-ACCEPTANCE.md)
- [x] [tests/P4-ACCEPTANCE.md](P4-ACCEPTANCE.md)
- [x] [tests/P5-PERFORMANCE-ACCEPTANCE.md](P5-PERFORMANCE-ACCEPTANCE.md)
- [x] [tests/POST-C1.2-CODE-REVIEW.md](POST-C1.2-CODE-REVIEW.md)
- [x] [tests/POST-C1.4-CODE-REVIEW.md](POST-C1.4-CODE-REVIEW.md)
- [x] [tests/POST-C2.1-CODE-REVIEW.md](POST-C2.1-CODE-REVIEW.md)
- [x] [tests/PRE-C1-CODE-REVIEW.md](PRE-C1-CODE-REVIEW.md)
- [x] [tests/SYSTEM-LEVEL-ACCEPTANCE-2026-09-27.md](SYSTEM-LEVEL-ACCEPTANCE-2026-09-27.md)

- [x] [本轮新增审核报告](C2-ROUND-REVIEW-2026-10-01.md)
