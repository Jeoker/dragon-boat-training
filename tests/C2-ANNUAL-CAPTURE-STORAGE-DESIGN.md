# C2.6 一致捕获与持久计划设计

状态：2026-10-01。纯模型 `dcc13df`、delivery 1 只读 adapter／proof `2e2fc80` 已提交。supervisor 已明确授权本文 stage 2 的本地三表、持久 service／CAS／backup及测试；本地源为 application schema15／50张备份表，已完成实现及双审，见[本地存储验收](C2-ANNUAL-STORAGE-LOCAL-ACCEPTANCE.md)。远端 c2test 训练通道的实际证据仍为 schema14／47张表，本文不改变其报告，不修改 manifest／服务版本，不部署或远端写入。

## 1. 权威范围与最小交付

沿用 [年度设计](C2-ANNUAL-ARCHIVE-DESIGN.md) 及 [第一切片验收](C2-ANNUAL-ARCHIVE-LOCAL-ACCEPTANCE.md)。[迁移计划](../cloudflare-migration-plan.md)的“Google 双向同步协议”、C2.6 及“备份、保留与恢复”章节分别要求独立于 Google 的冻结、可从 DO 快照复算的年度业务文件、完整来源另行核验；数据库 backup 不代替年度档案。

第一实施阶段仅真实 SQL row adapter、资源／范围 proof helpers 及 Node／Workers 测试，已完成且没有增加 schema 或 runtime 入口。经后续独立授权的 stage 2 实现没有公开路由的 DO capture／storage service、additive 本地 SQL 迁移及备份测试；测试入口直接调用 service，绝不接 public HTTP、alarm、cron、桥接或 `HISTORY_CHANGED` 消费。内部阶段为 `CAPTURED` → `LOCAL_DIGEST_READY`；后者仅表示固定本地内容及摘要已完成，不表示 Google／source verified、ARCHIVED 或 public eligible。

本文门槛先经双审再获上述本地授权。真实文件创建、原始回答抓取、receipt、权限及旧 C1 public 兼容仍按前设计独立处理。

## 2. 可复用处及不能直接照搬的部分

| 位置 | 复用 | 额外门槛 |
|---|---|---|
| [c2-archive-contract.ts](../shared/c2-archive-contract.ts)、[c2-archive-projection.ts](../shared/c2-archive-projection.ts) | 内部版本化 DTO、完整图、真实 audit 白名单、canonical exact text、确定性 UTF8 chunks | SQL 行适配必须输出显式完整字段；不能把缺失行当默认空数组 |
| [c1-history-service.ts](../cloudflare/src/c1-history-service.ts):323、372 | 既存 practice_history、最后正式 revision 和冻结名字的对照 | capture 只消费已存在冻结，不调用 freezePractice 或补建 history |
| 同文件 :731、770 | 同步事务固定块、事务外 SHA-256、恢复原 snapshot | 现有 backup 全表 `toArray()` 没有先证明年度资源预算；finalize 的 status 复核也不能代替本文要求的所有 exact text CAS |
| [c1-service.ts](../cloudflare/src/c1-service.ts):140、147、155 | 既有请求身份、completed replay、不可变结果思想 | live 数据不进入 command digest；未完成原请求还需独立持久 pin，不能只依赖 completed system_requests |
| [crypto.ts](../cloudflare/src/crypto.ts):22 | `sha256Base64Url` 与 `sha256_v1:` 前缀 | 在事务外算；年度 canonical 使用纯模型的新版本，不改旧 C1 canonicalJson／身份摘要 |
| [schema.ts](../cloudflare/src/schema.ts):619 | 同事务 additive 迁移、拒绝未来 schema | 具体 schema 编号由后续 supervisor 决定；旧 Worker 不支持较新 schema，升级后不承诺直接切旧代码回滚 |
| [c1-history-service.ts](../cloudflare/src/c1-history-service.ts):19 | `BACKUP_TABLES` 的保护清单 | 新表必须全纳入，包括未摘要完成的非空计划和 request pins；不是仅测空表存在 |

## 3. 时间、冻结与捕获的准确含义

`captured_at` 是首次成功 capture 的服务器时间，在同步 SQL 事务内部取一次并固定；命令不能传入它来伪造历史。`cutoff_at` 是自然业务资格边界：PRACTICE 为该训练 end+24h；SEASON 为季自然结束与所有应冻结训练 end+24h 的最大值。事务内校验当前服务器时间至少达到边界，并要求应归档的 `practice_history` 已存在；SEASON 还要求现有 C1 季状态为 COMPLETED／ARCHIVED。到期却尚未运行冻结／季完成任务时明确 NOT_READY，capture 不补跑或改写 C1。

“冻结快照”有两个层次，不能混称同一历史时间：正式姓名／座位／训练投影来自不可变 `practice_history.snapshot_json` 和其所指 revision；名单、模板、周次、私有草稿及成员覆盖值则是 **captured_at 的一致私有业务状态**，不能声称已经在 end+24h 保存了这些完整私有行。第一计划固定后，后来 Form 导入、成员改名／停用、配置和更正都不改变原计划；冻结姓名仍按原 revision names 解释，不用当前名字补洞。

`appendHistoryCorrection`（[c1-history-service.ts](../cloudflare/src/c1-history-service.ts):650–689）只追加说明并提高 history_version，不修改原 snapshot。capture 包含事务时点存在的全部连续 correction，记录每个冻结对象的 history_version；摘要期间出现的新 correction 不使原计划失效，也不追加旧 chunks。原请求 replay 固定返回旧更正范围。后续更正专用归档修订／附录协议尚未设计，本轮不允许另一个 capture request 偷换同一业务档案来覆盖旧目标。

命令 digest 只覆盖明确的 team／actor／kind／season／practice／format 和首次绑定参数。captured_at、当前成员和查询结果不进入 command digest；因此旧请求重放不会因时间或活数据变化冲突。snapshot ID 从原 request identity 派生，不能重新随机生成。binding、generation、epoch 在 capture 同事务保存；resume 时对照原身份及当前运行归属，代次或绑定改变需明确 OWNERSHIP_CHANGED，不把旧内容投向新绑定。

## 4. SQL 捕获范围与真实字段适配

PRACTICE 读取目标训练及其完整子图，同时读取全季成员、模板和周次，保持现有纯模型的配置／名单范围；不需要为了捕获一场训练加载别场 signup／revision。SEASON 读取所有未取消训练，包括未发布私有草稿；已取消训练在 SQL 范围证明中计数但不复制其内容。已发布未取消训练必须全已冻结。未发布训练不得伪造 practice_history。

| DTO 类别 | SQL 来源及要求 |
|---|---|
| season／member／template／week／practice | seasons、members、schedule_templates、training_weeks、practices 的显式列；布尔由实际 0／1 转 bool，时间由实际 nullable 字段适配，不调用公开 projection 丢字段 |
| signup_state／signup | practice_versions.signup_version／signup_sequence，以及 signups 全明细，包含 CANCELLED；不根据当前 ACTIVE 重跑递补 |
| seating_state／draft_seat | practice_versions 两版本 LEFT JOIN seat_plan_states；仅两版本全0且无seatstate／roles／draft／revision时允许带明确provenance的虚拟初始视图，见下文；version>0 缺 state／缺任一 draft 槽停止 |
| revision | seat_plan_revisions + 全量 seat_plan_revision_seats／names，保持连续全部正式版本与原 request_id；不通过 normalizeSeats 静默补缺槽，也不按最新 signup 删历史座位 |
| frozen_practice／correction | practice_history 原 snapshot_json 严格 parse，history_corrections 连续全量；不从最新数据重造 frozen 公共投影 |
| audit | audit_events 原 details_json，完整 action-specific shape及全部适用事件，见下文；不只读取分页运维 API 的首屏 |

SQL NULL seat/member roles 是现有存储表示（[schema.ts](../cloudflare/src/schema.ts):185–240）；只有列存在且值确为 SQL NULL 才适配明确 `""`，不是缺列／缺行／undefined 容错。draft 空座位亦如此。

真实 [C1 stateRow](../cloudflare/src/c1-seating-service.ts):157–169 在未初始化时返回空 roles、`updated_by=""`／`state_updated_at=""`；这些空元数据不能直接通过当前 pure DTO 的 actor／ISO 校验。supervisor 审定的显式适配是：practice_versions行确实存在，seat_plan_version与published_revision均为0，seat_plan_states不存在，且所有draft／revision／revision seats／names均为空，才能生成虚拟 seating state。固定 `updated_by="IMPLICIT_INITIAL_STATE"`、`updated_at=practice.created_at`，roles明确空串；这不是实际Coach操作或实际seatstate行。`capture_proof`逐practice记录 `provenance="IMPLICIT_INITIAL_STATE"`、`source_table="practices"`、`source_created_at`、`seat_state_present=false`及已核两版本／子行零计数。不得将该actor解释成Coach或真实审计事件。若版本、子行、role来源存在或created_at不合法，则停止；已有真实seatstate则完整使用其真实元数据，不能套sentinel补洞。第一阶段必须用真实C1新训练SQL正例与缺行／有子行负例验证，不改变pure DTO格式或C1 parser。

audit 的业务 action 采用已提交纯模型的有限 C1 + Form 清单。运维类 login/logout、backup、sync import、export/poll、pause/retry 等按源码 registry 明确排除，不把其 raw result／credential 混入业务档案；排除类别及计数保存在 capture proof。未知 action、坏 JSON、未知 season 归属或 season_id 列与 details.season_id 不一致必须停止，不能只 `WHERE season_id=?` 后忽略潜在遗漏。

先以安全 CASE／json_valid 做全 audit 所有权检查：已知业务 action 必须具有合法 season ID、匹配 denormalized season_id 与已存在 season；未知但带目标季归属的 action 拒绝；无法归属的未知／损坏记录保守拒绝 capture。可证明的非业务记录按明确 action 分类排除。随后在同事务按作用范围读取全部业务事件，验证 outer／nested season、practice、week、时间、完整 draft、原 revision identity 与 finite details，不只筛已经认识的 action 来假称完整。cancelPractice 及取消训练相关事件只在证明排除后跳过；合法训练 cancelSignup 保留。

## 5. 事务前置资源证明与失败原子性

不采用跨请求可变分页拼接，也不先全 `toArray()` 再检查 2MB。一次 `transactionSync` 内依次执行完整性／预算聚合、有限行加载、纯模型校验及所有计划／块写入；无 await、crypto、Google 或其他 I/O。同一事务保证 proof 与读取之间没有业务插入／更正竞争。

1. 对适用类别先 SQL COUNT：逻辑 DTO 行的保守总数（season、members、templates、weeks、practices、states、signups、draft、revisions、history、audits、corrections）不得超过 5000；practice_versions一物理行产生signup_state与seating_state两行，必须计2，虚拟初始state亦计入。未选取消项和明确运维项单独 count。revision 的 names／seats 是 bounded nested 子行，另核每 revision <=102 names／100 seats及全部子行 COUNT，无无界组装。该捕获入口可比纯模型的“5000 输出 records”更保守，超额明确 CAPTURE_RESOURCE_LIMIT，不静默裁剪；此技术上限须 supervisor 审定。
2. 每个 SQL 投影使用固定字段 `json_object`，只返回 `COUNT` 和 `SUM(LENGTH(CAST(row_json AS BLOB)))` 等聚合元数据，不返回大 payload。主行和 nested 子行以可复核的保守 JSON 包装开销相加（含数组逗号、键、metadata）；原 audit.details_json／history.snapshot_json 使用原文本 UTF8 长度。聚合未知、safe-integer 溢出、超限或形状无法估界立即停止。
3. 为在 **加载前** 证明 DTO JSON <=2,000,000 UTF8 bytes，预算包含 fixed wrappers 和 JSON 嵌入的最坏转义增长：原 JSON text 可按每 UTF8 byte 最多6倍的保守界计算，不能只 raw LENGTH 就声称 parse+重新编码不会扩大。若预算过于保守挡住合法样本，报告具体类别，后续精确 SQL JSON 投影／资源测量另审；不取消前置门槛。
4. 证明通过才加载 explicit projections；仍用每类别/子行已证明 count 的迭代读取，复验实际条数，禁止 LIMIT 截断充当完整。实际组装后的 `parseArchiveInput` 再检查2MB，`createArchivePlan`再检查5000输出 records、每块64KB／100行、整份 canonical plan2MB。所有实际字节 count 都用 TextEncoder UTF8，与 SQL BLOB 单位一致；Unicode、控制字符／转义负例必测。
5. 所有验证与投影完成后才 INSERT CAPTURED plan + 全chunks + 原 request pin。即便 INSERT 后故障也抛出以回滚整个同步事务。新请求失败时不留半 plan／半 pin／completed result，不写业务 audit/outbox，不冻结或完成季。不能因后续 digest await失败回滚已成功固定的完整 CAPTURED 内容。

SQL COUNT／长度聚合及所有权 proof 仍随目标数据量和原文本大小增长；2MB限制是 JS 物化范围证明，不是总 SQL CPU／读取量常数保证。Workers 实际 transaction latency、rowsRead/rowsWritten 与内存须本地测量，有限样本不能证明平台所有资源限制。过大季的有界 SQL 捕获副本／分段协议另做切片；本轮明确失败，不扩大到自动分页调度器。

## 6. 最小持久模型（三张 additive 表）

stage 2 本地 schema15实现下列三表；没有复制 source raw answers 或年度 receipt 表。历史版本清单位于 canonical plan 的完整 history／correction records，plans创建时间即captured_at，完成时间另存completed_at。

| 表 | 必要字段／约束 |
|---|---|
| annual_archive_plans | snapshot_id PK；logical_scope UNIQUE（team/kind/season/practice，SEASON的practice_id明确null）；first_request_key／first_request_id／command_text／command_digest／actor_scope；team_id、binding_version、backend_generation、writer_epoch；captured_at、cutoff_at、archive_year，history版本位于canonical records；format；CAPTURED/LOCAL_DIGEST_READY；metadata_text、canonical_plan_text（纯模型exacttext锚）、capture_proof_text；record_count／chunk_count／input_bytes；manifest_text／content_digest nullable；完成时间completed_at，创建时点即captured_at |
| annual_archive_chunks | (snapshot_id,chunk_index) PK+FK；row_offset/count、payload_text、utf8_bytes；payload_digest nullable；全部 exact text不可更新，仅 digest从null到确认值；完整序号和offset校验 |
| annual_archive_requests | request_key PK+(actor_scope,request_id) UNIQUE；command_digest／command_text、snapshot_id FK；saved_result_text nullable；created_at；专用年度表不另设action列，原请求在CAPTURED就绑定，不等completed才能锁事件 |

`canonical_plan_text` 与 chunks 会重复存文本，目的为已有纯模型exact返回和分块存取各保留完整锚；不冒称总storage仅2MB。实现须记录实际写入文本 bytes并在测试证明按有限plan产生的有限写入；若改为不重复存而可靠复构exacttext，须单独证明与firstslice canonical逐字相同。capture_proof只存数量、选择边界、固定格式和检查结果，不复制 raw credentials／全system_requests。

logical_scope 防止两个不同请求在可变成员／新更正之后重新捕获同一档案。新 request 对已经存在scope只能绑定原 snapshot 并返回原 artifact，不能重新读活数据／改captured_at；绑定别名时必须完整核format、binding、generation、epoch与业务scope相同，actor／request可不同但权限必须仍有效。command层不同request回执可以不同，artifact的first_request_id／captured_at／chunks保持原值。format 是身份字段而不是唯一scope的一部分；格式、绑定或代次改变不能自动创建同目标新版覆盖档案，返回明确冲突／需审阅迁移。更正附录不借此scope重建。

## 7. digest、CAS、重启与请求恢复

capture方法先计算命令identity（事务外、只命令），验证调用者范围；**在任何live读取前** 查原 request pin／completed result。相同request不同command拒绝，已有CAPTURED的capture返回固定artifact，不隐式推进；显式resume／finalize只使用保存内容计算摘要；已READY的capture／resume／finalize复算固定内容并exact核manifest／原结果后重放。权限/当前归属必须仍有效，但不重新读取members/practices来决定旧请求结果。跨实例或同ID并发在capture事务内再查pin/scope，先存在者获胜，其他复验摘要后复用，不能裸PK异常后重建。

finalize只读已存plan和完整chunks；每个同步事务另核当前season及可选sync_binding的binding_version标量，不重新读取成员／训练／历史正文。server-owned context可由固定Env对象或同步getter提供；跨await提交重新核当前team／actor／generation／epoch。调用者未来必须在权限验证后供给当前Env权威，不把app_meta.schema_version当writer代次，未接线的内部service本身不实现公开Coach鉴权。resume/replay/finalize加载saved大文本前均先SQL COUNT／UTF8长度聚合，证明metadata／canonical／proof／request savedresult与所有chunk完整集合预算；新增超大chunk、损坏超大plan或异常集合立即停止，不因capture曾bounded就先无界物化。本地实现将plan四份大文本各限2MB及其它字段8KB；全部chunk payload累计2MB、每块64KB、小字段累计按最多5000×256 bytes保守计；本次pin总字段8KB。所有数值列必须在SQL预查证明INTEGER／非负安全整数，避免SQLite affinity下巨量TEXT先物化；实际加载再次核计数／字节。先证明format、snapshot/binding/generation/epoch、canonical_plan与metadata/chunks/count逐字一致，chunk序号覆盖完整、长度预算和offset连续。异步SHA-256使用原payload_text，保存每块描述；manifest包括身份、范围、capture proof摘要、metadata摘要、固定块描述和计数，content_digest覆盖版本化canonical manifest core（不把其自己的digest放入自身）。created/finalized时间不参与业务内容digest的动态重算。

await期间业务可继续发生；提交事务只比较保存的原内容，不要求live行仍相等。CAS必须复验原 plan identity、CAPTURED状态、command text/digest、metadata_text、canonical_plan_text、capture_proof_text以及 **完整chunk集合的index/offset/count/text/bytecount**，而非只status或总hash。任一删除、增加、漂移、版本不支持或归属变化都停止，不落READY／假成功。原文本是不可变事务锚，不自研同步hash。

提交同事务写全部chunk digest、manifest/content_digest、LOCAL_DIGEST_READY及本次固定request pin结果。alias结果仅按本次原pin有界落库或在首次READY读取时按保存artifact派生，不扫描/更新无界所有alias；新增alias不进入业务manifest/content_digest。若其他finalize已ready，仅在本次 computed manifest及所有身份 exact一致时只读返回已有结果，时间用先成功者；不同结果冲突。随后重启从CAPTURED重新算同digest，已ready原结果重放；finalize部分UPDATE故障全部回滚。`system_requests`若被复用只能在这个最终事务落completed，并采用新内部action/有限details，不挤入旧C1action范围；未完成绑定仍靠上述request表，不能独立先落completed。

不创建scheduled_jobs、不接alarm。测试直接调用resume/finalize并模拟重新实例化／DO重启；这证明持久恢复能力，不能称为自动后台任务已完成。

## 8. 迁移与备份门槛

后续授权实现只在现有applySchema链末添加下一additive迁移，三表及必要唯一／FK索引同事务创建，旧所有表内容不变，不给既有season_history自动制造verified plan。既有v14已排队／SENT／FAILED batch、lane block/pin/poll计划继续由原代码处理，年度service不触碰它们。

三表须全部进入BACKUP_TABLES，CAPTURED（digests为空但exactblocks完整）和LOCAL_DIGEST_READY均可原样备份；verify检查manifest/table/count/digest及完整非空pins/chunks保存。原backup算法自身的资源行为仍是旧能力，不因新年度预算而宣称全库backup有界。旧备份／旧schema入口向前升级测试保护原业务数据；新schema备份不能被旧代码当无损回滚输入。升级前后备份保留，修复用经审forward版本或正式恢复流程；本轮不执行restore。

## 9. 本地验收与实施顺序

1. 先新增明确SQL row adapter与capture proof纯helper测试：真实初始C1 state／SQL NULL、完整真实audit shape、业务／运维分类、缺行及错归属、UTF8转义界；不改纯模型格式。
2. 另经授权新增上述三表／backup清单及内部capture service，capture一次同步事务，先proof后fetch，失败全回滚。现有Worker入口不import／dispatch新service，由Workers测试直接调用。
3. 实现事务外digest与完整text CAS，original request/scope replay，跨实例恢复；此步仍无HTTP/alarm/Google。

| 场景 | 必须观察到的结果 |
|---|---|
| 尚未到期／已到期但history缺失 | 零新plan/chunks/pin；不补freeze或改变C1状态 |
| 真实C1完整图、取消／未发布 | capture通过，冻结names保持；取消报名和final correction实际出席保留；取消训练排除，私有draft不当正式 |
| 预算证明 | 超5000逻辑行、rawJSON转义／emoji >2MB、单块>64KB停止；spy证明预算失败前没有大payload materialize；从首次写到最后写每点故障全回滚 |
| 审计完整性 | 超运维分页数量仍全部适用audit归档；坏JSON／unknownaction／null或错误ownership拒；nested state/revision/draft字段与实际shape一致 |
| 摘要竞争 | await期间改members或appendcorrection，原plan不变；修改metadata／chunk／proof／归属则CAS拒；并发sameID结果唯一 |
| 原请求恢复 | capturecommit丢回复、digest前重启、digest算完提交前重启、readycommit丢回复都沿原snapshot；旧request不读取活业务；不同参数冲突；另一request同scope不能重捕获 |
| 迁移／backup | v14非空业务与lane表精确保留；新三表CAPTURED/READY各非空备份保持全部text/pins/nullable digest；未来schema旧代码明确拒绝 |
| 接线边界 | 无旧C1/public改变、HTTP action/manifest版本改变、scheduledjob/alarm/outbox消费或bridge调用；全部本地测试无remote |

## 10. 需要审定的选择

没有新的用户产品决策：完整私有年度内容、自然冻结、不等待Google、取消过滤、原始来源独立核验及公开verified门槛均已批准。

以下是设计阶段的历史审定门槛，现已按本文顶部授权及本地验收关闭：三表／scope唯一及别request别名语义；5000逻辑输入行的保守capture限额及转义预估方法；历史更正只固定本次范围、后续附录另审；后续内部service测试入口而非公开route。version0虚拟state的sentinel／sourcecreated_at／逐practiceprovenance方案已由supervisor明确，第一阶段实际SQL证据已通过并提交；后续schema15／内部service已获单独本地授权，未扩成远端部署或公开协议。若测量证明必须减少档案内容、修改更正权利／已批准公开语义或放弃自动创建，应带具体证据再交用户决定，不能以资源预算静默降级。

stage 2 已获明确本地授权，实际实现／验证范围见 [持久计划本地验收](C2-ANNUAL-STORAGE-LOCAL-ACCEPTANCE.md)。远端仍为schema14；没有年度Google verified、来源完整验证、HTTP接线或生产切换声明。后续公开／远端协议须另行审定。
