# 当前进度与接续入口

> 更新：2026-10-01

> 仓库边界更新：2026-09-13。本项目已从 Portfolio 拆分为独立 Git 仓库，保留 26 个项目相关历史提交；独立构建生成首页、Coach Mode 和过往赛季三个页面。仓库拆分本身不等同于 Cloudflare 迁移或新的生产功能验收；后续状态按下方各日期记录及“当前基线”判断。

> Cloudflare 迁移现状：2026-10-01。专用 `c2test` 已部署 Worker `0.17.0-c2-associated-lanes`／schema v14，polling=false、`crons=[]`、writer epoch0。独立训练真实 Google 验收已 `FINAL_CONFIRMED`：25阶段、7个新固定事件、14个新确认批次／18次 exporter 调用；A/B cursor各2/0/0、旧训练12/2/2，Google关联四表13/1/20/2、物理B36，pending outbox／未完成batch／retry／局部block／OPEN conflict均0，三条历史SUPERSEDED保留。最终完整备份47表55块已校验，未restore。生产、原staging、Pages及Google部署clean v14／原HEAD clean均保持原状态。年度持久计划已完成本地实现和双审：本地schema15／备份50表、原request/scope固定内容、digest与完整集合CAS及重启恢复通过；仍无年度Google/source verified、HTTP入口或远端部署。C2.4／C2.5整体仍未完成。见[最新实际验收](tests/C2-ASSOCIATED-LANE-ISOLATED-ACCEPTANCE-2026-09-30.md)及[年度持久计划本地验收](tests/C2-ANNUAL-STORAGE-LOCAL-ACCEPTANCE.md)。

> 2026-09-30 候补切片历史快照：当时专用 c2test 为 Worker 0.16.2-c2-physical-diagnostics／schema v13。候补真实写回、关联首行 PARTIAL 中断／原批恢复、VERIFIED 后受控空回复／原批恢复，以及既存 FAILED 批次的 PAUSING→PAUSED→RUNNING 均通过隔离验收。当时 Google 四表11/1/20/2、cursor12/2/2、物理B34、零待处理；两套Google clean各自完整恢复。此时独立训练v14尚未部署，后续状态以上方2026-10-01快照为准，旧证据仍见[候补实际验收](tests/C2-WAITLIST-FAULT-PAUSE-ISOLATED-ACCEPTANCE-2026-09-30.md)。

> 2026-09-27 系统级复核快照：当时正式三页、只读 API、Coach 真实登录／受保护读取／退出通过；正式三场测试训练均已结束，故未重新执行正式报名写入。**该快照记录了后续 C2.4 接续前**隔离赛季的 `BASELINE_INCOMPLETE` 和七个待处理 outbox；接续后的状态见下方及赛季版本验收。该系统复核不等于 Cloudflare 端到端或生产切换通过。验收开始时线上 HTML 与本地构建不一致。详见[系统级验收快照](tests/SYSTEM-LEVEL-ACCEPTANCE-2026-09-27.md)。

本文件记录当前交付状态、验证边界和下一步。第一次接手项目先读[项目总览](PROJECT-OVERVIEW.md)；产品规则以[项目说明](README.md)为准，职责和阶段边界见[Epic 总览](epics/README.md)；详细证据保留在各阶段验收报告，不在其他规格文件重复维护进度摘要。

## 已确认的下一阶段

采用 **Cloudflare Workers + Durable Objects（SQLite）** 保存在线业务主数据，GitHub Pages 保留现有网页，Apps Script 收敛为 Google Form／Sheets 桥接。支持偶尔直接修改 Sheet，通过基线对比、业务校验和 Coach Mode 冲突处理导入；有变化时默认十分钟批量导出，网页保存不等待 Google。

目标架构、C0–C4 顺序、三个 Epic 的新增工作包、真实 Google 边界及切换／回退门槛见[Cloudflare 数据服务与迁移计划](cloudflare-migration-plan.md)。C2.4 核心四表、侧向候补递补和关联受控故障真实写回已通过；C2.5 已通过受控冲突／重试、物理诊断／单格漂移恢复、既存 FAILED 批次暂停排空和同季独立训练／共享引用冲突恢复。并发 SENT 暂停有本地真实调用链证据，仍缺远端证据；真实配额／随机断网、自动 cron、备份恢复和更广独立实体仍待完成。c2test 自动导出关闭且无 cron；下方 Apps Script 生产基线仍实际运行，新架构未切换生产。

2026-09-19 已按 [C0 可执行工作清单](cloudflare-migration-plan.md#c0-可执行工作清单)建立 Worker、SQLite schema v1、不可变请求结果、事务审计／outbox／任务、alarm 租约与应用级重试、旧摘要兼容向量和签名桥接协议。真实本地 Wrangler 进程重启后数据、请求去重结果和待执行任务仍在；并发、回滚、闹钟修复及超过六次失败后的继续续排已有专项测试。独立 Apps Script Web App 的真实往返、重放及过期／篡改／错团队／错 binding／错代次拒绝均通过；实际 Free 计划和 Worker／DO 用量入口已核对。详细证据和观察边界见 [C0 验收记录](tests/C0-CLOUDFLARE-ACCEPTANCE.md)。

## 当前基线

- **P1 管理补齐验收通过**：赛季日期／默认值、当周单场预览编辑与取消、开放前后加场、预约开放及精确完成状态已完成。真实 Google 触发器、页面内确认、双季公开结果与最终退出已验证；时间边界使用可控时钟。细节、验收中的修正和工具限制见[P1 管理补齐验收](tests/P1-MANAGEMENT-ACCEPTANCE.md)。P1 不再保留开发欠项。

- P0、P1、P2“报名与维护”及 P2.1 等待体验优化已完成对应验收。**P3 阶段验收通过**：核心真实 API、页面流程及双窗口版本冲突恢复通过，用户已在正式 Coach Mode 人工确认鼠标拖动成功。**P4 阶段实现与当前可执行线上验收通过**：归档状态、取消过滤、公开历史空状态、受保护读取和退出已验证；尚未到期的测试赛季不能证明真实年度文件创建，留待首个隔离结束赛季补验。**P5 第一批性能与稳定性改进已部署并通过基础生产冒烟测试**；长期 Google 负载、非空分页、Safari、实体手机和管理员交接仍未验收，三个 Epic 的整体交付尚未结束。
- [队员页面](https://jeoker.github.io/dragon-boat-training/)、[过往赛季](https://jeoker.github.io/dragon-boat-training/history/)和 [Coach Mode](https://jeoker.github.io/dragon-boat-training/coach/) 使用同一个 Apps Script 后端。旧 Portfolio 子路径只保留跳转兼容。GitHub Pages 只提供静态网页，Google Sheets 仍是唯一业务数据源，没有十分钟延迟写回或独立实时数据库。
- 线上 Apps Script 沿用原 Web App URL，当前为 **Version 14、服务 `0.9.0-p5-performance`**，契约保持 `2026-09-02.p2.1`。生产 `setupDragonBoatP4` 已幂等执行完成，`PublicHistorySeasons` 紧凑索引及维护触发器已建立或迁移。
- P5 功能提交 **`38c9361`** 的 [Pages run 33999868687](https://github.com/Jeoker/hey-yang-liu.github.io/actions/runs/33999868687) 成功；三个正式页面均返回 HTTP 200，线上 HTML 与本地 P5 构建 SHA-256 一致。正式 health 返回 Version 14 的 `0.9.0-p5-performance`；公开历史空目录返回成功及分页字段。P4 的 [Pages run 33989665856](https://github.com/Jeoker/hey-yang-liu.github.io/actions/runs/33989665856) 继续作为上一阶段历史证据。
- C0 源码与文档提交 **`4a55bb0`** 的 [Pages run 35486989400](https://github.com/Jeoker/dragon-boat-training/actions/runs/35486989400) 成功；队员页、Coach Mode、过往赛季页和 Cloudflare staging health 均返回 HTTP 200。该发布只保存 C0 代码与文档，没有改变三个页面的生产 API。
- C1.4 本地验收通过：应用、桥接与文档／契约一致性 **184／184**，当时的 Cloudflare Workers／DO **59／59**；私有草稿、角色、人工／系统 revision、报名和船位原子联动、最终更正窗口及精确冻结拒绝已进入隔离新后端。该阶段留下的不可变最终快照、公开历史、分页运维与备份范围现已由 C1.5 完成；这些证据不更新以上生产部署结论。
- C1.4 完成后的代码健康复核已收紧排座影子导入：相同版本的状态元数据不可漂移，最新正式版重新核对当前角色／报名／完整排座，姓名快照只保存实际参与者；导入分组索引消除按场次重复扫描，共用报名投影与队列排序不再维护两份。发布重放、同编号换参数和旧版本写入已有直接回归。详见 [C1.4 后代码审查](tests/POST-C1.4-CODE-REVIEW.md)。
- C1.5 本地验收通过：schema v6、最终显示姓名／角色／船位快照、`UNPUBLISHED` 历史、取消过滤、赛季荣誉墙、追加式历史说明、稳定分页审计、分块备份与交叉摘要校验、任务自愈及应用用量已进入隔离新后端；Cloudflare Workers／DO **65／65**，项目 Node **184／184**。自动历史维护在 `writer_epoch=0` 的影子阶段默认关闭，本地专项测试显式开启内部设置；备份不含短期会话、公开限流或备份自身表。详见 [C1.5 验收](tests/C1-HISTORY-ACCEPTANCE.md)。
- C1.6 隔离 staging 验收通过：服务 `0.7.0-c1-acceptance`、schema v6、`writer_epoch=0`。125 名虚构成员和两个赛季完成全域迁移；最后名额并发、私有排座／公开 revision、历史与审计分页、191 条记录／29 分块备份、本地摘要复算及连续七次失败后的第八次任务恢复均通过。再次部署为 Worker version `18b0e059-2f76-4627-9528-d75bab44e465` 后，同一业务数据及备份仍可读取。C1 outbox 保持待同步、自动历史任务保持关闭；未连接 Pages 或 Google。详见 [C1.6 验收](tests/C1-STAGING-ACCEPTANCE.md)。
- C2.1 同步基础：schema v7 的绑定、基线、稳定来源、冲突和批次模型及三方比较已通过本地测试；后续审查补齐跨绑定版本身份延续和元数据边界。该切片本身不调用 Google；代码现已随 C2.2 部署到隔离 staging，仍未确认任何 outbox。详见 [C2.1 验收](tests/C2-SYNC-FOUNDATION-ACCEPTANCE.md)和[后续审查](tests/POST-C2.1-CODE-REVIEW.md)。
- C2.2 Form 来源导入：签名只读桥接、稳定回答 ID、事务游标／回执、触发通知和十分钟补扫在独立 Form／Worker 上通过；故障后同一请求可恢复，旧成员同名必须经 Coach 查看核查清单并显式关联。审查后轮询在赛季截止后完成一次成功的收尾分页才停止，不会永久读取旧赛季；此边界由本地测试覆盖。原 staging 升级到 schema v8 后 123 名公开成员及待同步 outbox 保留，C2 入口仍缺测试 Key 且被拒绝。正式生产不变。详见[C2.2 验收记录](tests/C2-FORM-IMPORT-ACCEPTANCE.md)。
- C2.3 Sheet 差异的历史验收：当时独立 Apps Script v7／`c2test` Worker `0.10.0-c2-sheet-inspection`／schema v9 已按登记 Tab 和稳定 ID 比较五类 B/C/G；结构异常、重复诊断、消失后标记 `SUPERSEDED`、真实改名／恢复和读量边界得到验证。该切片当时只读 Google、只写诊断元数据；其能力现已包含在隔离 v11，仍不自动导入 Google 修改或提供 Coach 冲突解决页面。见[C2.3 验收及审查](tests/C2-SHEET-DIFF-ACCEPTANCE.md)。
- C2.4 成员／赛季版本导出（历史隔离切片）：先前 `c2test` 逐个确认九个旧成员事件，并只按精确 Google 行核对补缺失的赛季 B；真实 Form 新增第十名成员后，成员写入、人工赛季名称冲突阻断与恢复、同请求重试及名单版本 0→10 均通过。当时 Cloudflare `season_version=2`、Google `season_version=1` 的差异不属于名单切片；本轮排期导出已将该测试赛季 Google 版本推进到 3。原 staging／生产未启用。见[成员隔离验收](tests/C2-MEMBER-EXPORT-ACCEPTANCE.md)、[赛季版本验收](tests/C2-SEASON-PATCH-LOCAL.md)及[本轮排期验收](tests/C2-SCHEDULE-ISOLATED-ACCEPTANCE-2026-09-29.md)。
- C2.4 报名／排座关联导出（2026-09-30候补切片历史快照）：C1 事务固定版本、变化报名行、递补、全船位及正式 revision；四表按不可变 snapshot 有界拆批，训练／成员引用与完整物理 B 写前复验，最终逻辑 B／物理 B／游标／outbox 同事务确认。真实侧向候补、取消递补、首行 PARTIAL 和 receipt VERIFIED 后丢回复已通过，旧 revision 1 保留，最终四表 11／1／20／2。跨 Google Tab 不具备原子写入，C2.4 整体仍有未验边界。见[本轮验收](tests/C2-WAITLIST-FAULT-PAUSE-ISOLATED-ACCEPTANCE-2026-09-30.md)及[原核心链路验收](tests/C2-ASSOCIATED-ISOLATED-ACCEPTANCE-2026-09-30.md)。
- C2.4 排期事件快照：七条 C1 排期写入路径在事务内固定本次变化的完整模板、周次和训练行，覆盖一次生成／开放多场、定时开放、单场新增／发布／改期／取消及模板替换。连续变化不会重写旧事件；本地验证见[快照记录](tests/C2-SCHEDULE-EVENT-SNAPSHOT-LOCAL.md)，隔离写回进度见[本轮验收](tests/C2-SCHEDULE-ISOLATED-ACCEPTANCE-2026-09-29.md)。
- C2.4 排期 Sheet 桥接：签名只读新增模板与周次表，三张排期表各支持最多四行的受限补丁与可重试回执，沿用绑定、表头、前值、部分进度和缺表拒绝规则。[桥接本地记录](tests/C2-SCHEDULE-BRIDGE-LOCAL.md)只证明开发当时的本地状态；独立 Google Web App v12 已含三类处理器，模板写回见[本轮验收](tests/C2-SCHEDULE-ISOLATED-ACCEPTANCE-2026-09-29.md)。
- C2 最近代码复审与技术债清理：修复成员导出跨 `binding_version` 误认已确认队员，抽取成员／赛季批次状态和摘要核验骨架及通用回执校验；旧请求不得重发 `SUPERSEDED` 批次或已停止待处理的 outbox，受控导入路径不再带着未完成批次提升绑定版本。独立 `c2test` 已核验名单版本 11、Google 两行 `PARTIAL` 同批恢复与回执重放，见[整体审查](tests/C2-RECENT-CODE-REVIEW-2026-09-27.md)。
- C2.4 成员回执丢失与排期同步基础：独立 Google 的“已写后空响应”故障注入已使 Worker 沿原批次恢复；Web App 随后恢复 v12 清洁构建，名单版本 12、`Seasons`／`Members` 曾零差异。模板／周次同步实体和迁移最初仅在本地 schema v10 验证，现已随 v11 升级到专用 `c2test`。见[当时验收](tests/C2-LOSS-AND-SCHEDULE-SCHEMA-2026-09-28.md)和[本轮升级记录](tests/C2-SCHEDULE-ISOLATED-ACCEPTANCE-2026-09-29.md)。
- C2.4 排期 Worker 导出：`PRACTICE` B/C/G 使用 Google 原始列，旧格式或缺组 B 阻断目标投影。`export-next-schedule` 按模板→周次→训练逐行确认，最后核验赛季行捕获的 `season_version` 并同事务确认 B 与 outbox；写前核对绑定、基线、前值和引用。专用 `c2test` 的基本跨表写回及 out-of-band Google 模板改动阻断／恢复已[远端核验](tests/C2-SCHEDULE-CONFLICT-ISOLATED-2026-09-30.md)；训练行单元格中断及赛季回执丢失沿原批次恢复也已[隔离验收](tests/C2-SCHEDULE-FAULT-ISOLATED-2026-09-30.md)。本地另有写前 `SERVICE_BUSY` 测试；这不等于真实配额耗尽、随机网络断包或极窄人工竞态。多行 Worker 合并未验收；原 staging／生产及自动导出仍关闭。
- C2.5 导出运维（2026-09-30候补切片历史快照）：每季暂停／恢复、既存批次排空、冲突分页与 B/C/G 详情、积压概览、持久退避及 ACTION_REQUIRED 显式重试均已进入专用 c2test。本轮真实验证既存 FAILED 关联批次暂停排空、禁止提前恢复和暂停中新目标；最终完整备份确认 retry 实表为零、开放冲突零，三条历史 SUPERSEDED 保留。自动导出 false、无 cron，备份未恢复。并发 SENT 暂停窗口、真实配额／随机断网、自动 cron、备份恢复及同季独立训练仍待验收。见[本轮实际验收](tests/C2-WAITLIST-FAULT-PAUSE-ISOLATED-ACCEPTANCE-2026-09-30.md)与[原故障验收](tests/C2-ACTION-REQUIRED-ISOLATED-ACCEPTANCE-2026-09-30.md)。
- C2.3 关联表物理行诊断补强（2026-09-30历史切片）：独立 Coach 会话保护的只读 `check-associated-physical-differences` 覆盖报名、草稿（状态加 20 个船位）、当前船位和全部历史正式 revision；旧 `check-sheet-differences` 的报名／草稿响应另带独立 `physical_integrity`，旧语义 B/C/G 状态与冲突写入含义不变。整行显示值和 v13 物理 B 逐行核对，结构／ID 异常、缺 B、缺行与审计列变化分别诊断；最多显示 100 finding，超过 Sheet 或 B 扫描预算即返回 `INCOMPLETE`，Google 与 B 都空也不宣称已确认。诊断不写 Google、业务或物理 finding 冲突表，不自动修复；目前按需调用，无定期巡检、无 schema v14。四 scope 的**正常态**在 0.16.2 远端均为 `OK`／完整覆盖／零 finding，行数／基线数为 1、21、20、1。随后隔离 Google Alpha 报名审计列 `last_request_id` 单格标记真实触发唯一 `CELL_CHANGED` 和物理 `DRIFT`，旧语义检查仍 `OK`／零 finding 且附带物理 `DRIFT`；另一个固定批次的整行 CAS 恢复原行，最终四 scope 物理及旧语义均 `OK`，关联物理 B 23／23 未变。两个隔离桥接回执和备份元数据为可审计测试副作用；无持续巡检或自动修复。见[设计与边界](tests/C2-PHYSICAL-DIAGNOSTICS-DESIGN.md)、[隔离正常态验收](tests/C2-PHYSICAL-DIAGNOSTICS-ISOLATED-ACCEPTANCE-2026-09-30.md)及[单格漂移／恢复验收](tests/C2-PHYSICAL-DRIFT-ISOLATED-ACCEPTANCE-2026-09-30.md)。
- C2.4／C2.5 本地回归继续保留：候补取消与系统 revision 2、成员丢回执及原批次暂停排空都有 Workers／DO 加模拟 Google 测试。本轮新增真实候补及关联故障、既存 FAILED 批次暂停证据见[实际报告](tests/C2-WAITLIST-FAULT-PAUSE-ISOLATED-ACCEPTANCE-2026-09-30.md)；本地 SENT 场景不替代并发 SENT 的远端证据。
- C2.5 独立训练通道（2026-09-30部署前本地验收快照）：schema v14 新增事件索引、局部阻塞、原请求选择和固定 poll 计划四表。共享选择器保留同训练顺序、成员／排期全季屏障及既存批次优先；明确训练／共享引用漂移局部阻塞，结构或未知问题仍全季停止。250 条同训练后继及 250 个独立阻塞 head 不遮住训练 B；全 pending SQL 证明成本随积压增长，只物化一个候选。成功按完整 retry 指纹 CAS 清理，不删除并发新失败。225 项 Cloudflare、210 项 Node 测试及类型／构建／打包通过，两名独立审核无未解决 P1/P2。c2test 仍 0.16.2／v13，新通道未真实 Google 验收；v14 升级后旧 v13 Worker 不能直接无损回滚。见[本地验收](tests/C2-ASSOCIATED-LANE-LOCAL-ACCEPTANCE.md)和[设计](tests/C2-ASSOCIATED-LANE-DESIGN.md)。
- **C2.5 独立训练通道当前实际基线（2026-10-01）**：专用c2test已为0.17.0／schema14，25阶段完整通过。排期全季屏障先确认；A引用漂移仅阻断A，同训练自然到期后序不能越过，B仍可确认；共享MEMBER漂移分别阻断A2/B2，精确恢复并Coach retry原事件后全部确认。7个固定新事件sequence34–40、14个新batch与18次exporter调用；A/B各cursor2/0/0，旧cursor12/2/2，Google四表13/1/20/2、物理B36。完整47表55块备份及旧行／历史保护通过，待处理、局部block、retry和OPEN conflict归零，保留三条历史SUPERSEDED。pollfalse、无cron；生产／staging／Pages和两套Google clean不变，未restore。见[独立训练实际验收](tests/C2-ASSOCIATED-LANE-ISOLATED-ACCEPTANCE-2026-09-30.md)。
- **C2.5 并发SENT暂停本地补测**：实际export调用链由可控await barrier持有Google回复，真实SENT后pause→PAUSING、提前resume拒绝、原batch确认→PAUSED、拒绝新目标→resume；暂停期间新业务version2与两个时点的公开结果保持，Google只完成原version1。相关69项本地测试与双审通过；不称为远端SENT故障验收。提交`da0dace`，见[本地记录](tests/C2-SENT-PAUSE-LOCAL-ACCEPTANCE.md)。
- **C2.6 已提交的预览历史切片**：pure计划`dcc13df`与SQL一致性预览`2e2fc80`已双审，该切片完整Node262／Workers237及类型检查通过。private完整DTO／冻结姓名／更正范围、前置COUNT/UTF8与显式初始state provenance已验证；preview结果仍LOCAL_PLAN_ONLY／SOURCE_NOT_YET_VERIFIED，同request再次预览可读取后来状态，该切片未实现持久计划或Google年度文件。见[年度pure](tests/C2-ANNUAL-ARCHIVE-LOCAL-ACCEPTANCE.md)及[预览验收](tests/C2-ANNUAL-CAPTURE-LOCAL-ACCEPTANCE.md)。
- **C2.6 已提交持久计划本地切片**：`13e8fc0`完成schema15三表／backup50表与内部storage service并经双审；固定原request及scope artifact、全text/chunk CAS、实际DO驱逐恢复、写后故障完整回滚、非空v14旧47表保护和CAPTURED／READY完整备份通过。该切片完整Node264／Workers254、Workers专项28及Node预算2、类型检查通过。持久状态为CAPTURED→LOCAL_DIGEST_READY，source仍SOURCE_NOT_YET_VERIFIED；无runtime service入口、HTTP／alarm／Google接线或远端部署。见[持久计划验收](tests/C2-ANNUAL-STORAGE-LOCAL-ACCEPTANCE.md)及[捕获存储设计](tests/C2-ANNUAL-CAPTURE-STORAGE-DESIGN.md)。
- **C2.6 当前完整来源纯模型**：按`c4138d5`已固定的归档时完整源快照语义完成内部typed-record／固定cutoff／gap分类，19项专项与类型检查通过，完整Node283/283，两位独审无未解P1／P2。原JSON先UTF8／深度／解码后重复key检查；Form保留完整受支持当前记录，未知完整pending或整input拒绝，IEEE754／canonical不能声称HTTP原字节重现。Form、Sheet、迟到身份、私有pending及gap五namespace独立，pinned season_ends_at按纳秒严格比较；DECLARED_ONLY所有Sheet原行仅PRIVATE_PENDING、不进年度合规chunks，已知缺失与历史覆盖限制分别记录。结果恒LOCAL_SOURCE_PLAN_ONLY／SOURCE_NOT_VERIFIED；没有读取、持久source operation、receipt、权限、Google文件或runtime／public接线，remote仍schema14／47表。见[纯模型本地验收](tests/C2-SOURCE-CAPTURE-PURE-LOCAL-ACCEPTANCE.md)及[source技术设计](tests/C2-ANNUAL-SOURCE-CAPTURE-DESIGN.md)。
- 当前跟踪文件不包含 Script ID、私有 Spreadsheet ID、Coach Code、会话令牌或服务端 secret。早期测试夹具曾复用实际 Coach Code，普通提交不会清除 Git 历史，因此下一次管理后端部署前必须轮换该 Code。

## 运行中 Apps Script 的写入与恢复约束

1. 服务端持同一把脚本锁，先保存确定计划和不可变结果，再写业务、审计及完成标记；持锁刷新后释放。请求内复用表格句柄及已读记录，写后失效，不跨请求缓存权威业务状态。
2. 未完成的排期、报名、排座和历史更正按原计划恢复，不重新生成排队时间、递补或 revision；已完成请求重放不重复写入。报名、取消、换侧与船位共用 BE-05 的唯一分配逻辑，不建立第二套排队算法，系统 revision 不夹带未发布草稿。
3. P1 周生成按保存的模板实例补齐缺失行，保留之后的调整与取消。缺少确定计划的旧未完成请求返回 `RECOVERY_REQUIRED`，不猜测重建。
4. 单次页面请求上限三十秒，多次串行请求总耗时可能更长。正常保存复用同次响应的当前视图；结果未知时锁定原动作、参数及编号，明确保存后补读失败只重读。版本冲突保留输入，刷新核对后再显式采用服务器版本。
5. 登录结果未知时，原页面内重新输入相同 Code，复用原登录编号。仅在内存保存摘要和编号，不持久保存 Code 或摘要；页面重载不恢复待确认登录。登录成功而赛季入口读取失败保留会话，只重试读取。详见[前端规格](frontend-spec.md#coach-mode-工作区)。
6. 训练结束后关闭报名，保留二十四小时最终更正；到精确截止时间即拒绝编辑，不依赖归档扫描是否已经运行。该时间边界按 Epic 使用本地可控时钟验证，不以等待真实一天作为阶段门槛。
7. 连续排座在停止操作两秒后合并保存；保存进行中仍可继续编辑，当前请求确认后只再提交一次最新草稿。公开历史采用独立短期缓存和 `PublicHistorySeasons` 紧凑索引，权威报名、容量、排座草稿及版本状态不进入跨请求缓存。
8. 后台冻结与归档每轮默认最多处理八个工作单元，并受 210 秒时间预算约束；游标保存在 Script Properties，下一轮从检查点继续。到期冻结、单场归档、整季私有快照和公开投影仍各自保持幂等，批处理不改变 24 小时截止规则。

## 验收证据

| 范围 | 已确认结果与边界 |
|---|---|
| P0 | 实际 Pages 公开读取、个人 Code 登录、受保护写入、幂等重放及退出通过 |
| P1 核心链路 | 测试 Form／Sheet 绑定、初始化激活、回答导入、十分钟绝对到期缓存与版本失效通过；周草稿私有、整周开放、加场单独发布通过 |
| P1 管理补齐 | 日期保存及重读、默认切换与恢复、独立旧链接、单场预览／移除、开放前后加场、预约修改后重新确认、真实触发发布及退出通过；Version 12 当时公开取消状态的历史证据已由 P4 的统一过滤规则替代，截止与结束状态为本地可控时钟证据，见[P1 报告](tests/P1-MANAGEMENT-ACCEPTANCE.md) |
| P2 | 最后一个名额真实竞争不超额；兼容候补按原队列递补，直接换侧保留时间且不挤掉已确认成员；真实 Pages 双端报名、改偏好、取消、改名和启停通过 |
| P2.1 | 正常写入复用当前视图，管理按需加载及局部刷新通过；API 小样本普通操作从两次请求降至一次，均值从 15.04 秒降至 11.47 秒，不能保证固定耗时。详见[报告](tests/P2.1-ACCEPTANCE.md) |
| P3 API | 草稿隔离、同人 Coach／Steerer、错侧确认、人工及系统 revision、取消／换侧与船位联动通过，脚本归属受控清理及退出通过 |
| P3 页面 | 登录和按需工作区、正式十排、私有草稿、发布、390×844 点选、自动保存后控件解锁、从正式版恢复角色与船位通过；最新报名取消后草稿自动清空、公开版未被私有修改影响通过 |
| 本轮连接与登录修复 | 草稿保存超时后按原请求确认至 v9。登录期间出现超时、不可读响应和缺少会话数据，发现并修复登录重试未复用原编号、登录后读取失败丢弃会话的问题；最终部署后两个窗口均真实登录成功。异常恢复各分支由新增本地测试覆盖，Google 连接异常原因尚未定位，不承诺已消除服务延迟 |
| P3 真实双窗口冲突 | 两端从草稿 v10 开始；A 保存 Coach Alpha 至 v11，B 用旧版本设置 Steerer Beta 被拒绝，保留 Beta 并锁住发布。刷新至 v11 仍保留本地 Beta；明确采用服务器草稿后才恢复 Alpha／空 Steerer 并解锁。临时 Alpha 清除后两端读回 v12，公开 revision 3 始终不变 |
| P3 人工拖动验收 | 2026-09-04，用户明确反馈“鼠标拖动成功了”，并反馈 Member 13 代报名、移回待排座池操作正常。此为真实页面人工验收证据；自动化 drag 未触发的结果不改写成自动化通过，不据此声称已覆盖其他设备或浏览器 |
| P4 后端与恢复 | 精确结束后 24 小时冻结、单场及整季私有归档、年度文件复用、公开字段隔离、更正说明、取消排除和两个中断恢复路径由可控时间与故障注入验证；Apps Script Version 13 的 health 和空历史目录真实读取通过 |
| P4 正式页面 | Pages run 33989665856 成功；过往赛季空状态、Coach 归档控制台、当前开放赛季三场“尚未到期”状态、100 条受保护操作记录、退出和已取消测试赛季的公开空列表通过。未到期环境不等同于真实年度文件创建通过，见[P4 报告](tests/P4-ACCEPTANCE.md) |
| P5 性能与部署 | 159／159 回归及双构建通过；连续排座两秒合并、开放赛季按时冻结、审计与历史分页、公开历史缓存、紧凑索引、批量写入、归档工作量上限和断点续跑均有专项测试。Apps Script Version 14、生产初始化、health、公开历史空状态和 Pages 三页产物已验证；非空分页、长期 Google 延迟／配额及 Safari／实体手机仍待验收，见[P5 性能报告](tests/P5-PERFORMANCE-ACCEPTANCE.md) |
| C0 Cloudflare 基础 | 阶段通过。本地 Worker／DO 事务、请求去重、回滚、持久任务、alarm 修复、应用级重试和桥接拒绝路径通过；真实本地进程重启与远端重新部署均保持状态。隔离 staging 公网 health、原子提交、跨部署保持、真实 Apps Script 签名往返／重放／负向范围和 Free 计划用量入口均已验证，见[C0 验收记录](tests/C0-CLOUDFLARE-ACCEPTANCE.md) |
| C1.1–C1.6 Cloudflare 业务迁移 | schema v1→v6 原地升级、核心／排期／报名／排座／历史影子导入、个人 Code 新会话、私有周与排座草稿、容量候补、最终更正、冻结历史、公开荣誉墙、分页审计、分块备份及远端故障恢复通过；隔离 staging 跨 deployment 保持数据，仍未连接 Pages 或 Google，见[C1.1](tests/C1-CORE-ACCEPTANCE.md)、[C1.2](tests/C1-SCHEDULE-ACCEPTANCE.md)、[C1.3](tests/C1-SIGNUP-ACCEPTANCE.md)、[C1.4](tests/C1-SEATING-ACCEPTANCE.md)、[C1.5](tests/C1-HISTORY-ACCEPTANCE.md)及[C1.6](tests/C1-STAGING-ACCEPTANCE.md)验收记录 |
| C2.1 同步基础 | schema v7 的受控绑定／基线／来源影子导入、三方比较、严格 Google ID 和稳定来源约束、C2 独立传输门及 Coach 概览通过；该逻辑随 C2.2 已部署隔离 staging，但仍不自行访问 Google 或消费 outbox。见[C2.1 验收](tests/C2-SYNC-FOUNDATION-ACCEPTANCE.md) |
| C2.2 Form 来源导入 | 隔离 Form 的分页、通知、十分钟补扫、桥接故障恢复、人工核查与跨部署持久化通过；并发提交由本地强制竞态测试覆盖。原 staging v6→v8 保留 C1 数据与待同步 outbox；生产未切换。见[C2.2 验收记录](tests/C2-FORM-IMPORT-ACCEPTANCE.md) |
| C2.3 Sheet 读取与差异 | 原五类登记 Sheet 的真实只读读取、B/C/G 人工改名与恢复、持久语义诊断幂等通过。新增四个关联 scope 的整行物理 B 诊断已在 `c2test` 0.16.2／schema v13 完成正常态只读远端验收；旧语义 `OK` 与物理 `DRIFT` 并存、整行 CAS 恢复后的四 scope `OK` 已隔离真实验证；物理 finding 仍不写入冲突表。仍没有 Google 人工修改的自动业务导入。见[原 C2.3 验收](tests/C2-SHEET-DIFF-ACCEPTANCE.md)、[物理诊断正常态验收](tests/C2-PHYSICAL-DIAGNOSTICS-ISOLATED-ACCEPTANCE-2026-09-30.md)与[单格漂移／恢复验收](tests/C2-PHYSICAL-DRIFT-ISOLATED-ACCEPTANCE-2026-09-30.md) |
| C2.4 成员、排期与关联导出（09/30历史切片） | 成员及排期、原 Alpha→20 格草稿→revision 1 已真实确认；本轮新增真实候补递补、PARTIAL／丢回复恢复，最终四表 11／1／20／2、游标 12／2／2、物理 B 34、旧 revision 1 不变，队列和差异归零。专用 Worker 0.16.2／schema v13、Apps Script 已恢复 v14。阶段仍未整体完成，生产未启用。见[最新实际验收](tests/C2-WAITLIST-FAULT-PAUSE-ISOLATED-ACCEPTANCE-2026-09-30.md) |
| C2.5 运维与独立训练 | FAILED原批暂停／PARTIAL／受控丢回复是09/30真实证据；10/01独立训练局部冲突、成熟后序阻断、共享引用及原请求恢复全部final通过，47表55块完整备份。零outbox／未完成batch／retry／block／OPEN conflict，保留三条SUPERSEDED。并发SENT仅本地补测通过；真实配额／随机断网、远端SENT、cron、restore及更广实体仍缺，整体未通过。见[最新实际报告](tests/C2-ASSOCIATED-LANE-ISOLATED-ACCEPTANCE-2026-09-30.md) |

完整 P3 场景、版本和验证层次见[P3 验收报告](tests/P3-ACCEPTANCE.md)。[P2](tests/live-p2-acceptance.mjs)和[P3](tests/live-p3-acceptance.mjs)真实脚本均为显式手动运行，不随 `npm test` 执行，不修改真实训练时间。运行限制见[后端说明](backend/README.md#验证边界)。

## 当前测试数据与安全收尾

仅使用隔离测试 Form、响应 Spreadsheet、虚构姓名及测试地点；原生 Google 文件保持私有。环境保留 `P1 Acceptance 2026` 测试赛季、二十二名虚构队员，以及 2026-09-09 18:00–20:00、09-11 07:00–09:00、09-12 10:00–12:00 三场公开训练，时区 `America/New_York`，地点 `P1 Test Dock`。正式运营必须另建独立正式赛季和 Form／Spreadsheet。

助手验收开始时第一场已有 `P2 Test Member 12` 的 Left 报名，因此没有按旧记录清空场次。助手只新增 `P2 Test Member 01` 的 Ambient 报名并做私有排座，随后取消该报名。以下是助手验收结束时的双端快照，已被后续用户人工测试改变，不能作为当前服务器状态：

- 第一场 **1／20、零候补**，仅保留本轮开始前已有的虚构队员 12；本轮队员 01 已取消，没有改动其他报名。
- 草稿 **v12**，二十个空位，Coach／Steerer 均未设置；公开正式版仍为 **Revision 3**，空角色与空座位，没有新增正式发布。v10 至 v12 仅用于受控角色冲突验收，临时角色已清除。
- 本轮取得有效会话的页面均已确认退出；最终两个窗口都显示“已退出 Coach Mode”，重载后只显示登录入口、无管理工作区。早先未收到 token 的登录请求可能已在服务器生成会话，只能按既有 TTL 失效，不能声称已经逐个撤销。
- 未删除历史报名、revision 或审计。其余两场本轮未写入，不能用以前的零报名快照代替现在的实时读取。

继续任何写入前均须重读服务器状态；上述记录不是持续不变的测试授权或清理条件。

随后用户新增了 `P2 Test Member 13` 的报名，并完成拖动和移回待排座池的人工验收。本轮 P1 未修改该赛季的成员、训练、报名、排座或用户会话；只临时切换全局首页指向并已恢复。当前人数和草稿版本不能继续假定为 1／20 或 v12。

P1 本轮另建 `P1 Management Acceptance 2026`（2026-09-01 至 09-30，纽约时区）及独立 Form／Sheet，仅 Alice、Bob 两名虚构成员。两周共五场已发布测试训练全部取消，两条私有移除标记保持不公开；9 月 28 日改期记录保留两人报名及 Revision 1 的 Alice 左侧第一排。测试日期已恢复，首页已恢复原 `P1 Acceptance 2026`。Google 临时准备文件已移除，本地预览进程已停止；API 测试会话及最终网页会话已确认退出。两个早先被原生弹窗卡住的助手测试标签页已关闭，无法逐个证明服务端撤销，只能依原八小时 TTL 失效；用户原页面和会话未关闭。详情见 P1 报告。

## 未完成范围与下一步

1. **C2.6 来源技术前置门槛**：业务持久捕获schema15／backup50表与完整来源纯模型已本地实现并双审，尚未部署。下一步先审可靠Sheet身份与首次提交证据、API能力／权限、分页／range及观测一致性、私有不可变目标与原operation未知回复恢复；纯模型不代替这些技术协议，DECLARED mapping仍不能升级Sheet年度范围。有缺口则保持pending／未verified，后续来源读取、存储、文件创建及接线须独立授权。当前remote保持0.17／schema14／47表。见[source技术设计](tests/C2-ANNUAL-SOURCE-CAPTURE-DESIGN.md)及[纯模型验收](tests/C2-SOURCE-CAPTURE-PURE-LOCAL-ACCEPTANCE.md)。
2. **继续 C2.5 剩余运维验收**：独立训练真实Googlefinal已完成；真实配额／随机断网、并发SENT远端窗口、自动cron、备份restore及更广独立实体仍需各自证据，不人为耗尽Google配额。自动导出保持关闭，不连接生产Pages／Google，不改变Apps Script写入归属。见[最新实际验收](tests/C2-ASSOCIATED-LANE-ISOLATED-ACCEPTANCE-2026-09-30.md)及[Cloudflare迁移计划](cloudflare-migration-plan.md#c2-可执行工作清单)。
3. **P5 延续到迁移验收**：非空历史分页、超过一页的 Coach 审计、两秒连续排座、跨轮归档和真实延迟／配额指标纳入 C1–C4；已有证据保留，未测项不因规划完成而标记通过，不再把旧后端的长期负载优化作为 C0 前置。
4. **P4 延后实证边界**：等首个真实已结束的隔离赛季自然到期后，补验自动创建年度 Spreadsheet、单场 Tab、整季 Tab、荣誉墙详情和冻结后说明。不得为制造证据而缩短正式赛季或改写真实训练时间；在实际承接该赛季的后端版本上记录证据。
5. **设备和交接**：Safari、实体手机及 Cloudflare／Google 两个平台的管理员交接仍待执行。当前真实浏览器记录包括 Edge 和 Codex 内置浏览器；390×844 视口不等于实体手机验收。本地故障注入不代表全部写入均完成真实中断测试。正式赛季上线前需核对真实 Form 的匿名发布及回答接收权限，测试 Form 的绑定检查不替代这一配置验收。

重新开始时先检查 Git 分支和未提交改动，再运行 `npm test`、`npm run cf:test`、`npm run cf:check`、`npm run build`、`npm run build:backend`、`npm run build:bridge-probe` 和 `npm run cf:dry-run`；修改 Wrangler 变量或绑定时另运行 `npm run cf:types`。C1 远端只读复验使用 `npm run cf:accept:c1-staging -- --verify-only`，需要本地忽略的 `cloudflare/.dev.vars`，不得输出其内容。受限环境设置 `ASTRO_TELEMETRY_DISABLED=1`。当前仓库命令可使用 `git -c safe.directory=D:/agents/dev-master/dragon-boat-training -C D:/agents/dev-master/dragon-boat-training ...`。
