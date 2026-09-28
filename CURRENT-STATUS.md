# 当前进度与接续入口

> 更新：2026-09-27

> 仓库边界更新：2026-09-13。本项目已从 Portfolio 拆分为独立 Git 仓库，保留 26 个项目相关历史提交；独立构建生成首页、Coach Mode 和过往赛季三个页面。仓库拆分本身不等同于 Cloudflare 迁移或新的生产功能验收；后续状态按下方各日期记录及“当前基线”判断。

> Cloudflare 迁移现状：2026-09-27。C0、C1、C2.2 和 C2.3 阶段门槛已通过。专用 `c2test` 运行 C2.4 成员及赛季名单版本导出切片（独立 Apps Script v10、Worker `0.12.0-c2-season-export`、schema v9）；**10 名隔离测试队员和名单版本 11 已真实写入 Google 并核验，但 C2.4 整体未通过**。本轮另核验真实 Google 两行部分批次恢复。原 staging 仍为 C2.2／schema v8。生产仍由 Apps Script／Sheets 写入，Pages 未切换；生产与原 staging 没有启用 Google 写回。证据见[最近代码审查与验收](tests/C2-RECENT-CODE-REVIEW-2026-09-27.md)、[先前赛季版本验收](tests/C2-SEASON-PATCH-LOCAL.md)、[C2.3](tests/C2-SHEET-DIFF-ACCEPTANCE.md)和[C2.2](tests/C2-FORM-IMPORT-ACCEPTANCE.md)。

> 2026-09-27 系统级复核快照：当时正式三页、只读 API、Coach 真实登录／受保护读取／退出通过；正式三场测试训练均已结束，故未重新执行正式报名写入。**该快照记录了后续 C2.4 接续前**隔离赛季的 `BASELINE_INCOMPLETE` 和七个待处理 outbox；接续后的状态见下方及赛季版本验收。该系统复核不等于 Cloudflare 端到端或生产切换通过。验收开始时线上 HTML 与本地构建不一致。详见[系统级验收快照](tests/SYSTEM-LEVEL-ACCEPTANCE-2026-09-27.md)。

本文件记录当前交付状态、验证边界和下一步。第一次接手项目先读[项目总览](PROJECT-OVERVIEW.md)；产品规则以[项目说明](README.md)为准，职责和阶段边界见[Epic 总览](epics/README.md)；详细证据保留在各阶段验收报告，不在其他规格文件重复维护进度摘要。

## 已确认的下一阶段

采用 **Cloudflare Workers + Durable Objects（SQLite）** 保存在线业务主数据，GitHub Pages 保留现有网页，Apps Script 收敛为 Google Form／Sheets 桥接。支持偶尔直接修改 Sheet，通过基线对比、业务校验和 Coach Mode 冲突处理导入；有变化时默认十分钟批量导出，网页保存不等待 Google。

目标架构、C0–C4 顺序、三个 Epic 的新增工作包、真实 Google 边界及切换／回退门槛已整理到[Cloudflare 数据服务与迁移计划](cloudflare-migration-plan.md)。**当前在 C2.4：成员及赛季名单版本切片已隔离验收；报名、排座及排期事件的固定源快照，以及排期三表的受限 Google 桥接仅本地完成。下一步是模板／周次同步基线、Worker 排期目标投影和关联批次，再接报名／座位。周期调度与失败退避归 C2.5。** 下方仍是实际运行中的 Apps Script 生产基线，不代表新架构已经上线。

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
- C2.3 Sheet 差异：独立测试 Apps Script Web App 已从 v6 更新到 v7，只保留正式签名只读入口；`c2test` Worker `0.10.0-c2-sheet-inspection`／schema v9。Coach 会话下检查赛季、成员、报名、训练和草稿座位表，按登记 Tab、稳定 ID 与依赖组比较 B/C/G；结构异常及业务冲突写入 `sync_conflicts`，重复检查不重复建，完整检查后已消失的诊断转为 `SUPERSEDED`。真实隔离 Sheet 的改名／恢复通过，临时写入夹具入口已删除；名单与 outbox 未改变。后续审查修正了非法 ID、坏结构下的旧诊断保留、读量上限及诊断截断时的冲突优先级，并在独立测试环境复验五类只读检查。无 Google 写回、无自动业务导入、无 Coach 冲突处理页面。原 staging 与生产未部署本切片。详见[C2.3 验收及审查](tests/C2-SHEET-DIFF-ACCEPTANCE.md)。
- C2.4 成员／赛季版本导出（隔离切片）：远端 `c2test` 已将九个旧成员事件逐个确认；经精确 Google 行核对后只补缺失赛季 B，未猜测旧事件的中间名单版本。独立 Apps Script v10、Worker `0.12.0-c2-season-export` 部署后，真实 Form 新增第十名成员，成员行写入、人工赛季名称冲突阻断、原名恢复、同请求重试及赛季名单版本 0→10 均通过；最终十个事件及 11 个批次确认，五类 Sheet 诊断为零。Cloudflare `season_version=2`、Google `season_version=1` 仍有差异；该切片仅承诺名单版本写回。原 staging／生产未启用。见[成员隔离验收](tests/C2-MEMBER-EXPORT-ACCEPTANCE.md)与[赛季版本验收](tests/C2-SEASON-PATCH-LOCAL.md)。
- C2.4 报名／排座事件快照（仅本地）：新报名 outbox 在同一事务内捕获版本和所有变化的报名行，包括递补；若影响排座，还固定角色／版本状态、变化后的完整草稿船位及新正式 revision 的船位和姓名。手动草稿保存与正式发布事件使用同一持久结果快照逻辑。连续报名／换侧／取消／重新报名、草稿与正式版单侧或双侧变化及后续手动改稿均有回归。**尚无 Google 目标投影、报名或排座写回及远端部署**。见[事件快照记录](tests/C2-SIGNUP-EVENT-SNAPSHOT-LOCAL.md)。
- C2.4 排期事件快照（仅本地）：七条 C1 排期写入路径在事务内固定本次变化的完整模板、周次和训练行，覆盖一次生成／开放多场、定时开放、单场新增／发布／改期／取消及模板替换。连续变化不会重写旧事件；**尚无 Google 三张排期表写回或远端部署**。见[排期事件快照记录](tests/C2-SCHEDULE-EVENT-SNAPSHOT-LOCAL.md)。
- C2.4 排期 Sheet 桥接（仅本地）：签名只读新增模板与周次表，三张排期表可各自执行最多四行的受限补丁并返回可重试的逐表核验回执；沿用已有的绑定、表头、前值、部分进度和缺表拒绝规则。**尚无 Worker 排期导出器、模板／周次 B/C/G 基线、跨表事件确认或真实 Google 验收**。见[桥接本地记录](tests/C2-SCHEDULE-BRIDGE-LOCAL.md)。
- C2 最近代码复审与技术债清理：修复成员导出跨 `binding_version` 误认已确认队员，抽取成员／赛季批次状态和摘要核验骨架及三类补丁通用回执校验；旧请求不得重发 `SUPERSEDED` 批次或已停止待处理的 outbox。两条受控导入路径在未完成导出批次存在时拒绝提升绑定版本。补测旧绑定部分批次、排期表人工修改／删除／重复 ID 及错误回执等拒绝路径。全套本地回归与构建通过；独立 `c2test` Worker `e7f9a360-173b-4c09-97b5-56fa11a4213e` 真实核验名单版本 11、Google 两行 `PARTIAL` 同批恢复与回执重放，最终 `Seasons` 1 行／`Members` 10 行零差异、零积压。**Worker 与 Google 之间真实响应丢失尚未故障注入**。后续 schema 扩展、既有旧绑定残留批次核验清障及多行 payload 拆批见[整体审查记录](tests/C2-RECENT-CODE-REVIEW-2026-09-27.md)。
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
| C2.3 Sheet 读取与差异 | 五类登记 Sheet 的真实只读读取、B/C/G 人工改名与恢复、持久诊断幂等和过时状态通过；异常结构、删行、改 ID、重复 ID、报名与排座依赖组由本地测试覆盖。`c2test` schema v9，原 staging／生产未升级；没有 Google 写回或自动导入。见[C2.3 验收](tests/C2-SHEET-DIFF-ACCEPTANCE.md) |
| C2.4 成员导出及赛季名单版本关联 | 独立 `c2test`／Google 文件已真实核验 10 名成员、名单版本 11、人工冲突阻断与恢复、请求重放；Google 两行批次的 `PARTIAL` 冲突与同批恢复通过，最终零差异。报名、排座和排期事务快照及排期三表受限桥接仅本地完成；报名／训练／排座跨 Tab 导出、真实 Worker→Google 响应丢失仍未验收，故 C2.4 整体未通过；原 staging／生产未启用。见[最新审查与验收](tests/C2-RECENT-CODE-REVIEW-2026-09-27.md)、[赛季版本验收](tests/C2-SEASON-PATCH-LOCAL.md)、[报名／排座快照](tests/C2-SIGNUP-EVENT-SNAPSHOT-LOCAL.md)、[排期快照](tests/C2-SCHEDULE-EVENT-SNAPSHOT-LOCAL.md)及[排期桥接](tests/C2-SCHEDULE-BRIDGE-LOCAL.md) |

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

1. **继续 C2.4 新实体导出，同时保留恢复门槛**：成员与赛季名单版本的隔离写回和 Google 桥接两行部分批次同批恢复已验收；报名、手动／系统排座及排期 outbox 已有固定源快照，排期三张 Google 表的受限桥接仅本地通过。重复的批次状态和回执核验骨架已整理，`c2test` 当前无旧绑定残留；若未来出现已存在的旧绑定未完成批次，仍须经 Google 核验后清障，不能直接删除。真实 Worker→Google 响应丢失、极窄人工并发与配额耗尽继续作为后续隔离验收门槛。下一步给模板／周次增加正式同步实体和基线，复用共享骨架实现 Worker 目标投影、按模板→周次→训练顺序的可恢复批次及整事件确认；核验报名训练行及成员前置关系后再接报名／座位。桥接多行 payload 须按实际字符长度拆批；旧无快照事件不得从当前行推测。`season_version` 的非名单变化仍需单独设计导出或明确由 Google 管理。只有 Google 核验后才能推进对应基线和 outbox。十分钟周期调度、失败退避及暂停／恢复属于 C2.5。不得连接生产 Pages／Google 文件或改变 Apps Script 写入归属。计划及审查门槛见[Cloudflare 迁移计划](cloudflare-migration-plan.md#c2-可执行工作清单)和[整体审查记录](tests/C2-RECENT-CODE-REVIEW-2026-09-27.md)。
2. **P5 延续到迁移验收**：非空历史分页、超过一页的 Coach 审计、两秒连续排座、跨轮归档和真实延迟／配额指标纳入 C1–C4；已有证据保留，未测项不因规划完成而标记通过，不再把旧后端的长期负载优化作为 C0 前置。
3. **P4 延后实证边界**：等首个真实已结束的隔离赛季自然到期后，补验自动创建年度 Spreadsheet、单场 Tab、整季 Tab、荣誉墙详情和冻结后说明。不得为制造证据而缩短正式赛季或改写真实训练时间；在实际承接该赛季的后端版本上记录证据。
4. **设备和交接**：Safari、实体手机及 Cloudflare／Google 两个平台的管理员交接仍待执行。当前真实浏览器记录包括 Edge 和 Codex 内置浏览器；390×844 视口不等于实体手机验收。本地故障注入不代表全部写入均完成真实中断测试。正式赛季上线前需核对真实 Form 的匿名发布及回答接收权限，测试 Form 的绑定检查不替代这一配置验收。

重新开始时先检查 Git 分支和未提交改动，再运行 `npm test`、`npm run cf:test`、`npm run cf:check`、`npm run build`、`npm run build:backend`、`npm run build:bridge-probe` 和 `npm run cf:dry-run`；修改 Wrangler 变量或绑定时另运行 `npm run cf:types`。C1 远端只读复验使用 `npm run cf:accept:c1-staging -- --verify-only`，需要本地忽略的 `cloudflare/.dev.vars`，不得输出其内容。受限环境设置 `ASTRO_TELEMETRY_DISABLED=1`。当前仓库命令可使用 `git -c safe.directory=D:/agents/dev-master/dragon-boat-training -C D:/agents/dev-master/dragon-boat-training ...`。
