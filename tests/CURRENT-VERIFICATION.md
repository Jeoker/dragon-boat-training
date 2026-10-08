# 当前有效验证记录

更新：2026-10-07。本页只汇总仍有效的证据及其范围，不记录实现演变。部署和接续位置见[当前进度](../CURRENT-STATUS.md)，复核命令和工具限制见[测试入口](README.md)。首次schema16隔离发布与保护包对账的证据保留原时点；CLI准备及原会话拒绝回查只刷新本地运行证据，未轮换真实Code、调用Google、重验业务云端或执行部署。

## 生产与浏览器

最近记录的 2026-10-03 [Pages 工作流](https://github.com/Jeoker/dragon-boat-training/actions/runs/37155677951)部署提交为 0711c677bdba546a5c7dba03735f30dab83683c6。[正式站点](https://jeoker.github.io/dragon-boat-training/)首页、历史页、用户登录后的 Coach 受保护赛季／成员／报名／排座读取和当前会话退出通过；DOM 中的 API 仍为 Apps Script。

当时页面展示22名虚构成员和三场已结束训练，历史目录为空；第一场2名确认、0候补、draft19、冻结 Revision3。它们是读取快照，不能作为后续写入前提。没有生产业务写入、Cloudflare 切换、非空历史、Safari／实体手机或全部旧会话撤销的证明。

## 业务规则

生产 Apps Script 业务基线及 Cloudflare 业务规则已有对应模型／运行时证据：赛季和名单隔离、周确认与预约开放、加场独立发布、最后名额并发、换侧与原队列、角色互斥、草稿／正式版分离、系统 revision、精确24小时边界、冻结姓名、取消过滤、分页、未知结果和中断恢复。可执行场景保留于本目录测试与 [Worker 测试](../cloudflare/test/c1-core.test.ts)。

C1 隔离远端完整链路还验证 Google 断开后的业务提交、跨部署持久化、分页审计、多块备份及持久任务第8次恢复成功。影子 epoch0 未自动取得归档写入权。上述隔离结果不表示当前生产使用 Cloudflare，也不证明更大规模容量、所有 P1 写入故障或真实年度 Google 输出。

Apps Script／网页排座已有真实双窗口版本冲突恢复、登录未知结果恢复和用户确认的桌面鼠标拖动证据；精确24小时边界由可控时钟模型验证。排期管理已有真实改期、默认值恢复及取消记录保留证据。设备、全部写入中断和非空荣誉墙的欠项不由这些场景替代。

## Google 同步

以下均为独立 c2test／Google 测试文件和虚构数据的已执行结果，不是本次远端状态读取。

| 范围 | 有效结论 | 未覆盖 |
|---|---|---|
| Form 导入 | 稳定回答 ID、重叠窗口去重、触发器／补扫、隔离临时 cron、失败游标及来源核查有本地和隔离证据；临时 cron 已关闭 | 实际截止赛季最终补扫、严格同时触发／手动读取及全部题型；不证明导出自动 cron |
| 语义／物理诊断 | B/C/G 比较、四个关联 scope 完整物理检查、单格审计列漂移与精确恢复通过；语义零差异不等于整行完整 | 定期巡检、finding 入库和自动修复 |
| 成员／赛季导出 | 原业务行及回执写入后空响应形成 FAILED，原批次恢复；两行 PARTIAL 前值恢复及同批完成、赛季回执重放通过 | 所有网络时序、真实人工并发及配额耗尽 |
| 排期与关联导出 | 模板→周→训练及报名／完整草稿／不可变 revision／状态写回和回读通过；原事件快照与逐场顺序保持 | 更广实体／字段隔离和全部 C2.4 门槛 |
| 暂停与 ACTION_REQUIRED | 既存 FAILED 部分批次排空、回执提交后丢回复、人工标记阻断、精确恢复和显式 retry 通过 | 远端并发 SENT 暂停、随机断网、自动 cron 及云端 restore |
| 独立训练通道 | 2026-10-01 完成25个 journal 阶段，7个固定新事件及14个批次确认；训练 A 局部冲突不挡 B，同训练后序及全季屏障保持，旧数据保护通过 | 不宣布 C2.5 全部完成或启用自动执行 |

独立训练通道最终所测聚合为 pending／unfinished batch／retry／block／OPEN conflict 均0；7类语义 scope 和4类物理 scope 正常、完整且无截断。原 clean 源恢复，polling=false、crons=[]、epoch0。后续保护包下载只刷新身份／schema及包证据，不自动刷新这些同步结论。

复核代码包括[关联 runner](live-c2-associated-lane-acceptance.mjs)、[原批次恢复](live-c2-lost-reply.mjs)、[桥接重放](live-c2-bridge-replay.mjs)及[故障模型](c2-associated-fault-overlay.test.mjs)。这些工具保留固定目标和版本检查，适用性须先按测试入口核对。

## 来源采集与审核

| 层次 | 已取得证据 | 资格边界 |
|---|---|---|
| 真实隔离读取／journal | 2026-10-03 两遍完整读取：11份 Form 回答、112×8 Sheet、92,684 UTF8 字节；私有 journal 正常／丢回复及本地 receipt CAS 中断后跨进程恢复，重放零写入、零来源重读 | 使用测试 actor／cutoff／空 census，非业务服务器 capture；真实多页、全部题型及未知 Spreadsheet 创建恢复未验 |
| 逐请求 checkpoint | 独立 stage 中断后新进程 resume 完成候选，再次 resume 零来源内容请求；原 range 不重取，固定观测区间20.980秒 | 本次另固定 context，候选92,664字节，不与 journal 候选混用；返回未保存窗口保持未知 |
| 年度业务投影与持久计划 | [业务 capture](../cloudflare/test/c2-archive-capture.test.ts)及[storage](../cloudflare/test/c2-archive-storage.test.ts)验证同事务范围、原请求／文本／digest CAS、权限和非空备份 | preview 不承担持久重放；LOCAL_DIGEST_READY 不等于 Google 年度 receipt 或 public eligible |
| 鉴权与人工审核 | HTTP／真实 TeamState SQLite当前会话、固定pin／目标、完整 retained plan、journal ACL／原文复核和只追加 CAS；独立 Node 进程恢复原结果 | HUMAN_ATTESTED 是责任声明，其他 Coach 委派及审核 UI 未验 |
| 私有云运行层 | 6文件84项：存储／runtime16、OAuth18、双命名Worker／真实TeamState／DO9、private backup25、native消费16；实际DO驱逐、未知请求拒绝重取、权限撤销及原revision／digest保持 | Google 为模型，未部署；真实云授权和 Free 资源未验 |
| 原生 Tab | [GS 模型14项](c2-native-tab-bridge.test.mjs)、[业务入口26项](../cloudflare/test/c2-native-tab-proof.test.ts)、[新capture消费16项](../cloudflare/source-private/test/native-capture-entrypoint.test.ts) | 仅单点关联观察，不代表整个读取区间原子性；旧候选不回填，Google core 单独不能恢复原生 receipt |
| 本地 host | [CLI 组合9项](c2-private-host.test.mjs)：独立进程、当前凭据、固定目标、锁、动态ACL及私有输出不覆盖 | 服务／Google为模型，没有用该CLI执行真实业务 capture／stage／审核 |

两遍一致保持 TWO_READS_MATCHED_NOT_ATOMIC；journal 回读仅证明原固定内容及目标。LOCAL_* provenance、SOURCE_NOT_VERIFIED、原 Sheet PRIVATE_PENDING 和 annual_export_authorized=false 保留。已知 census 不证明完整历史；人工声明、原生关系或摘要一致不能自动消除缺口。

## 备份与恢复

2026-10-07首次隔离发布版本为`cdf87b8b-2dc0-4fba-ac68-44da516a091f`，业务与SourceAuthority使用专用bootstrap配置；service version仍为0.17.0-c2-associated-lanes。受保护schema从14升到16，generation cf-c2-isolated-1／epoch0保持。发布前后Cloudflare实际账号核验相同，TeamState namespace `6a3c5d70313a4c56bc977d261b61b365`保持；C1／C2／Coach／bridge／session六项secret名称齐全，现用C1／C2 transport与原会话验证通过。实际crons=[]、两个polling=false、无私有／恢复service binding；未更新云端secret，API仅核对名称，本机现用值只用于鉴权、不回显。

发布前完整bootstrap赛季列表含一个赛季；发布前后全局pending outbox／jobs为0，当前绑定有效，pending batch／outbox／OPEN conflict／source review／unknown pending event均0，lane coverage完整。沿发布前同一会话核验升级后当前Coach，credential_version=2与原保护包一致，prepare轮换只读路由200；private-source-run与restore-isolated-backup因未接线分别409，native-tab-proof的GET为405。未调用真实native证明／pin／capture、Google或云端restore；这些读取不重验全部同步场景或完整来源资格。退出后同一会话bootstrap为401 SESSION_REVOKED。

本次正式发布保护包原时点分别为`2026-10-07T21:00:30.171Z`和`2026-10-07T21:05:15.295Z`：发布前schema14／47表55块2461行，发布后schema16／51表55块2464行。两个包均按下载时独立保管的可信摘要离线verify通过；严格对账原47表2461行完整保留，仅schema标记14→16，以及原快照自身一个COMPLETED请求、一个关联审计和一个finalize job追加。新4表为空，SOURCE_NOT_VERIFIED及annual_export_authorized=false保持。包、receipt、上下文及原包演练在仓库外私有目录`D:\agents\private-backup\release-20261007-r2`保管；发布和脱敏云核验输出在Git忽略的 `.build/`及 `cloudflare/.acceptance-artifacts/bootstrap-*-20261007-r2.json`。快照时点先于最终退出；包不表示之后无其他系统记录或并发写入已经冻结。

| 范围 | 有效证据 | 未覆盖 |
|---|---|---|
| 真实保护包 | 本次发布前14／47表与发布后16／51表、55块，独立可信digest零HTTP离线verify通过；原包和sidecar仓库外私有保管 | 不证明下载结束时仍是最新业务状态，不刷新全部同步状态 |
| 原包本地 SQLite 演练 | [harness](original-backup-local-drill.mjs)调用当前 restoreBusinessBackup；真实发布前2461行保持，仅app_meta schema14→16，新4表为空；DDL／FK／index、CHECK／PK／FK拒绝、FK0、封存及重复拒绝通过 | 无云端restore或在线handoff；外发请求0、无alarm |
| 业务恢复 | [真实SQLite20项](../cloudflare/test/c2-backup-recovery.test.ts)：51表、14／47兼容、原行／键／FK／index、损坏／非空／并发拒绝及全事务回滚 | 旧sessions及备份自身两表不恢复 |
| 私有备份 | [25项](../cloudflare/source-private/test/backup.test.ts)：原revision／digest／UTF8／pending／审核保存与恢复，整对象超额拒绝 | 大于16,000,000原字节／128条的分页工具未实现，native v2实际restore未验 |
| 独立恢复入口 | [12项](../cloudflare/source-private/test/recovery-entry.test.ts)：命名RecoveryRuntime、当前权威回调、独立SQLite及DO驱逐封存 | 本地workerd，不代表云鉴权／namespace或在线激活 |
| 业务CLI | [18项](c2-business-backup-cli.test.mjs)：固定身份、原schema／actor／request、丢回复恢复、独立表列摘要与时间下界、ACL／链接拒绝、真实SQLite对账 | HTTP／Google为模型，不读取真实凭据；离线verify不执行SQL |
| 首次配置 | [PowerShell模型1项](backup-setup-guide.test.mjs)：独占创建、masked输入、ACL及身份检查，固定错误诊断不泄漏依赖正文 | 不证明当前云secret或真实登录 |
| Coach自轮换 | [服务16项](../cloudflare/test/c1-coach-rotation.test.ts)及[CLI28项](c1-coach-rotation-cli.test.mjs)：self-only／census／CAS／旧sessions撤销／receipt／UNKNOWN不重提交，重复prepare保持表不变；v2原token摘要绑定、严格401回查、丢回复恢复、新会话并发撤销拒绝与v1原回执兼容 | CLI使用本地真实SQLite／HTTP模型；单token拒绝不替代全体旧sessions的真实新包census，未执行远端CLI预检或真实轮换；生产Apps Script和Git历史独立处理 |
| 首次发布配置 | [Node19项](c2-bootstrap-config.test.mjs)：固定身份／既有namespace、无继承cron／runtime、配置漂移／secret拒绝及固定dry-run；真实Wrangler打包并完成上述固定c2test发布与配置核验 | 打包摘要不证明真实Google、私有来源／恢复接线或Free容量 |
| 增量schema升级 | [真实SQLite3项](../cloudflare/test/c2-bootstrap-migration.test.ts)：14→16原47表及sessions保持、新4表为空、幂等、schema约束及不兼容DDL事务回滚 | 测试直接调用applySchema，不证明TeamState重启任务冻结；升级不撤销旧session，不执行云鉴权或Google |
| 发布前后对账 | [Node14项](c2-bootstrap-reconcile.test.mjs)及本次两份真实保护包：完整原行重复计数、原请求／payload／审计身份、完整manifest、固定任务与时间范围；额外业务／审计／pin、损坏或上下文变化拒绝 | 严格固定首次发布协议；无并发冻结、DDL或session恢复证明 |

## 本地检查

2026-10-07当前代码审核及Coach CLI本地复核：

- 本轮CLI整组27／27通过后，新增与调整的两项选择复核2／2通过，其中一项重叠，合计覆盖当前28项；没有把重复场景累加或称为完整Node重跑。新增覆盖原会话拒绝错误形态、身份／请求漂移、超额响应、丢回复、原token替换、并发撤销及旧v1恢复；私有目录ACL／子进程／实际SQLite仍由完整CLI组验证。Node语法与文档链接／命令检查通过。
- 最近一次完整 `npm test` 为只读prepare切片后的590／590，零skip，耗时239,668毫秒，包含当时CLI23项、Windows ACL、子进程、本地HTTP、bootstrap／对账及文档／API契约；本轮没有重跑完整Node。业务Workers28文件342项、私有Workers6文件84项、恢复Worker1文件12项沿用本日审核基线，本轮没有修改或重跑Worker代码。原生证明14项与文档2项的组合复核16／16属于该基线，与完整Node组重叠，不重复累加。
- 来源／业务／私有三项严格类型及正式backend／bridge-probe、私有host和backup工具四项构建沿用本日代码审核基线。最近Astro检查170文件、0错误／0警告／0提示及三页构建来自只读prepare切片；本轮只改Node CLI、对应测试与文档，没有重跑网页构建。
- 本日代码审核的私有Worker dry-run通过，bundle182.06KiB／gzip40.43KiB，反向业务binding和隔离身份保持；仅本地打包，没有部署。CLI准备入口切片没有重跑Worker打包，其实际发布／未部署状态仍按上文原时点证据解释。
- 静态引用检查覆盖283个源码／测试／配置文件，并核对5个typed运行入口与7个Astro入口的依赖图；JS未用导入为0。三个单引用GS函数属于手动安装或探针入口，保留其操作协议。年度归档的四个模块及本地原始包审核入口当前由测试调用，属于尚未接运行路由的阶段组件，不据此宣布上线。
- 私有DO只保留鉴权命令入口，原始存储读写由内部store承担；真实SQLite存储测试通过专用`runInDurableObject`夹具执行，并检查DO不提供原始存储RPC。两处并发回执测试使用Boolean release gate控制旧回执释放，以明确事件顺序核验新基线和并发失败保留，不用固定等待推测竞争顺序。
- Coach CLI `prepare`复用受审查的私有路径／保护包／服务校验，stdout只报告版本、服务指纹、包时点及队列观测。重复调用不改变真实SQLite全部表或session，不产生header／receipt／新凭据；实际rotate重新核验。准备不冻结队列或授予未来执行许可，CLI验证不代表已在远端执行预检。
- 新attempt使用v2 header绑定原会话摘要；只有同服务身份／版本及原request的401 SESSION_INVALID／SESSION_REVOKED、retryable=false才接受原会话拒绝，随后重验新会话再发布确认。故障恢复只读原receipt和回查，不重复rotate或换login请求；输入会话替换在HTTP前拒绝，已确认输出不覆盖。旧v1保留原恢复语义，明确NOT_RECORDED，不追溯补证明；全体旧会话撤销仍需真实新包census。
- 本日Document Agent审核全部30份项目Markdown，必要更新14份；文档维护当前组件分工、恢复支持范围与运维模板，去除重复状态、过时规划措辞、源码行号及易漂移的步骤编号。CLI准备入口的Coach指南、隔离执行顺序和状态／验证索引另已同步，最终文档命令／本地链接与标题检查2／2通过，`git diff --check`通过。静态检查、依赖图及本地回归不能证明不存在任何潜在逻辑错误，也不替代真实Google、云端恢复或设备验收。

bootstrap配置／manifest／bundle／日志、脱敏远端核验及临时脚本被Git忽略；源码、测试和现行文档正常追踪，生成配置、保护包及可信receipt不提交。Git凭据历史债继续按当前进度处理，本轮本地审核不证明已清理历史。
