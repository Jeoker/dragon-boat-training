# C2 关联事件按训练继续同步的设计与实施门槛

> 本文维护当前训练通道协议；本地与真实隔离证据分别见[本地验收](CURRENT-VERIFICATION.md#google-同步)及[隔离验收](CURRENT-VERIFICATION.md#google-同步)。部署与剩余门槛只维护于[当前进度](../CURRENT-STATUS.md)。

> 已实现不同训练的关联事件独立推进；成员、排期及同实体独立字段的更广隔离仍未完成，不能宣布 C2.5 整体通过。

## 1. 关联事件前检

前检与持久训练通道共同工作，不能仅跳过最早 outbox 绕开事件顺序。

轮询先核全局事件归属、未完成批次和全季屏障，再选择可运行训练 head；局部阻塞必须有可信目标与错误上下文。

`c2-associated-export.ts` 在创建 PREPARED 前执行适用引用／草稿前检，发送前再次复验。首次冲突不留下未发送批次；准备后漂移停止发送并保留原批次恢复。

事件尚无确认阶段时检查训练、成员及 Coach 引用，首个排座阶段核先前草稿。已发送批次沿原身份恢复，不把部分写入当外部漂移。

首次前检增加有界 Google 读取，发送前复验保留。Google 与 Cloudflare 没有跨服务原子事务，复验后的极窄人工编辑窗口仍存在。

本地回归使用现有模拟 Google 夹具，检查训练及成员引用冲突时批次、outbox、逻辑／物理 B 和逐场游标均不变，Google 零写入；恢复引用后同一 outbox 完成。另检查无基线的草稿船位，以及早期前检通过后、发送前引用漂移仍阻止写入并保留零次发送的 `PREPARED` 批次。此证据不替代真实 Google 的独立冲突验收。

## 2. 第一版完整训练通道的范围

只允许同季不同训练的 `SIGNUPS_CHANGED`／`SEATING_CHANGED` 独立推进。成员、排期、赛季、归档、无处理器、旧形状／无法验证的事件全部作为全季顺序屏障。不同训练引用相同成员时仍分别检查该成员的已确认 B/G，不能凭不同 `practice_id` 推断引用无冲突。

以下规则必须保留：

- 同一训练的报名、草稿与正式 revision 依次完成，沿现有 `sync_associated_cursors` 校验连续版本；不能跳过同训练的待处理事件。
- 成员事件最终写 `Season.roster_version`，排期事件最终写 `Season.season_version`。两类事件保持全季排序，避免后序事件先完成导致旧事件的共享版本倒退。
- 任意 `PREPARED`、`SENT`、`PARTIAL`、`FAILED` 未完成批次继续作为全季屏障，先沿原批次核验／恢复。第一版不引入并行未完成批次，也不自动取消零次发送的旧批次。
- Google 读写仍带绑定版本、归属代次、签名、固定 batch／operation 编号、写前比较和完整物理 B。事件只有在全部目标再核验后才一起推进逻辑 B、物理 B、逐场游标与 outbox。
- 明确的局部冲突不删除事件、不推进版本、不改变排队时间；结构损坏、凭据错误、未知错误和已发送结果未知保持全季停止／退避。

## 3. 持久结构方案

当前业务源码包含以下四表，不改变 `sync_outbox` 的既有状态集合。这四表纳入完整业务保护备份：

| 表 | 必需字段及约束 | 用途 |
|---|---|---|
| `sync_export_event_index` | `outbox_id` 主键／外键；`event_sequence` 唯一正整数；`season_id`；`payload_anchor`／`topic_anchor` 保存原文本；`handler_kind` 为 `ASSOCIATED` 或 `BARRIER`；可空 `practice_id`；`classification_anchor` 保存 `[outbox_id,event_sequence,season_id,handler_kind,practice_id]` 的不可变 JSON 文本；`created_at` | 保存不可变全季事件顺序及可信分类，避免恢复后依赖重新分配的 SQLite rowid |
| `sync_export_event_blocks` | 主键 `(season_id,binding_version,outbox_id)`；外键 `outbox_id`；`practice_id`；`payload_anchor`／`payload_digest`；`error_code`；`failure_count`；`next_attempt_at_ms`；`action_required`；`blocked_scope`／`blocked_entity_id`；`created_at`／`updated_at` | 保存局部阻塞、退避及管理员重试证据，允许其他训练继续 |
| `sync_export_request_selections` | `request_key` 主键；`season_id`／`binding_version`；`outbox_id` 外键；`event_anchor`、`event_digest`、`request_digest`、`created_at` | 首次选择即绑定请求；前检失败且未创建批次也不能改选。旧已完成请求先按原摘要重放 |
| `sync_export_poll_plans` | `request_key` 主键；`request_digest`、`plan_json`、`plan_digest`、`created_at` | 第一次 Google 前固定最多四季的绑定／事件／处理器／原文本锚／事件摘要；结果未知时沿原计划，不因新候选或新季改变目标 |

事务内使用原 payload_json 与 topic exact text 作为不可变锚，不引入同步 SHA 实现。摘要使用现有 sha256Base64Url 在事务外生成；进入事务重新检查文本、绑定及候选后持久选择。相同请求并发 INSERT OR IGNORE 后必须完整核验已存记录。poll 先在同步事务复选并保存 outer plan（原请求并发先读已有 plan），完成结果保存到 system_requests。未知结果只恢复原计划和原 inner IDs；每一个 inner 调用前再次检查 selector。只有既有 completed result／CONFIRMED batch 可只读重放，原 event 已 CONFIRMED 时只读结束。原目标暂不可运行且没有原已完成结果时返回 ORIGINAL_EVENT_UNAVAILABLE，保留原退避／暂停／全季 halt，不改选或升级错误。新 poll ID 才建立新计划。

归属证明使用 SQL 检查全 DO 的所有 pending。SQL 的扫描及 JSON／精确文本比较成本仍随总积压行数和字符量增长；此方案限制物化及 Google 调用，不承诺无限积压下固定 CPU 延迟。检查项目：缺索引、JSON、season 归属、原 payload／topic 文本、序号／分类锚均必须通过，当前绑定的全部局部阻塞也核对 practice 与文本锚。随后 SQL 先取每个 practice 的最早 pending，再过滤 due／局部阻塞／退避，选择最早全季 BARRIER 之前的首个可运行 head；BARRIER 本身仅在没有更早 pending 时可运行。先取 head 后过滤，使未来到期或被阻塞的 head 始终封住本训练后续事件，250 条同训练后继或 250 个独立阻塞 head 均不会遮住其他合法训练。只物化一个候选；读取前 UTF-8 原 payload 限制为 2,000,000 bytes，单个候选超限则 fail closed／incomplete。未完成批次仍优先对账，只核该批次源事件的完整文本、序号／分类锚，不让其他尚未准备事件的损坏挡住固定已写批次恢复。poller 最多覆盖 100 个当前绑定、每轮 4 季、每个关联事件 8 次拆批调用；超绑定或单事件预算 fail closed，并报告 incomplete，不能自动重建索引。唯一证明非赛季业务是固定 C0_MOCK_SYNC topic 且五字段完整吻合已验证计数测试合同，索引 season_id 标记 @NON_SEASON_C0；新 C0 也同业务事务捕获索引。其他无法归属、损坏 JSON、缺索引、锚／分类漂移保持全局 incomplete；可信 season 下无效／未知事件是该季 BARRIER。SQL 中的 JSON 提取全部由 CASE json_valid 保护，无法证明的事件不能被筛掉。class anchor 用 JS JSON.stringify 捕获，SQL json_array 精确比较，同步事务不引入自研 hash。成员／排期 direct API 也在第一次 Google 读取前持久锁定原 selection；读失败且其他请求已确认原事件后，同 ID 明确不可用或只读原确认结果，绝不能转向后序事件。

现行索引覆盖 `(season_id,event_sequence)`、`(season_id,practice_id,event_sequence)` 和 `(season_id,binding_version,action_required,next_attempt_at_ms)`。旧 outbox 在同一迁移事务内按当前 rowid 捕获固定 `event_sequence`；新 outbox 必须在原业务事务内分配序号并写索引。历史 payload 保持原样；验证失败的关联事件分类为 `BARRIER`，不能悄悄忽略。绑定版本只属于阻塞记录及导出确认域，事件本身的固定顺序不能在换绑定时重新排序。

允许局部阻塞必须有可信关联事件、明确错误上下文、且没有任何未完成批次。禁止仅按 `ApiError.retryable=false` 决定局部范围；例如表结构变化不能局限到一个训练。可重试的平台／网络错误先继续使用全季退避。第一版可只支持关联前检中有明确目标或引用 ID 的业务／物理漂移；其余错误继续全季停止。

局部阻塞写入前再次在事务内验证事件仍 `PENDING`、payload digest／绑定版本未变且无未完成批次，防止并发发送后错误地释放全季屏障。失败上下文只保存稳定 ID 与错误码，不能保存凭据或复制不必要的私人 Google 内容。

## 4. 共享选择器与调度

共享选择器同时供 poller、关联／成员／排期 exporter、概览及事务内复核使用，返回选中事件 ID、固定序号、payload digest、绑定版本和选择原因。仅改其中一个入口不成立。

1. 当前绑定不可用、影子暂停或全季 `ACTION_REQUIRED` 时停止；运行时暂停仅允许恢复现存未完成批次。
2. 任意未完成批次优先，禁止生成其他目标。批次处理器按其源事件决定，不能让另一 exporter 收下它。
3. 按固定序号读取待处理事件，找到最早 `BARRIER`；屏障之后的事件全部不可选。屏障之前只在各训练的最早待处理事件中选已到期且没有局部停用／退避的候选。
4. 同训练最早事件未到期或被阻塞时，该训练后序事件也不可选。其他训练可以继续；最早屏障只有在所有更早事件完成后才能执行。
5. 按候选固定序号选择，仅物化首个合法候选，单事件 UTF-8 2,000,000 bytes／每轮季数与批次数有界。全 pending SQL 证明不能被截断；未知归属或任意后部分类锚损坏仍停止并报告 incomplete。
6. Google 前检返回后、插入批次的事务内重新运行同一选择校验并核对 payload／绑定。新增较早屏障、局部状态变化、并发准备或暂停时返回可重试 stale，禁止发送旧选择。

关联 exporter 内部接口可以接收选中 `outbox_id`，但必须自身验证选择有效性；外部调用不能任意指定绕序。请求身份摘要应包含选中事件 ID，使重复请求始终对应同一事件。每轮关联有界拆批仍沿当前事件推进，事件完成后下一事件获得全新的前检。

## 5. 概览、重试与成功清理

`sync_export_retries` 继续保存全季错误与调度。独立事件完成只清理其局部 block，不能删除另一个训练的阻塞。真正发送或最终核验前捕获全季 retry 完整指纹（绑定、failure count、nextAt、error、action、updatedAt 等），成功事务仅 CAS 清掉该已观察的旧重试；Google await 期间另起的新 failure 保留。原 batch CONFIRMED／已完成请求的只读重放与 ORIGINAL_EVENT_UNAVAILABLE 不清其他失败。shared send 的临时观察证据丢失时保守保留 retry，下次沿固定 batch 重发可重新捕获，不改变持久业务状态。

概览应保留总积压与真实最早事件时间，同时独立返回全季停止状态、局部阻塞数量、可运行事件的下一到期时间及阻塞分页。不能把“最早事件被阻塞”显示成整个赛季空闲，也不能因为训练 B 成功就隐藏训练 A 的错误。运行时暂停状态仍按未完成批次显示 `PAUSING`／`PAUSED`。

Coach 重试接受可选 `outbox_id`：指定 ID 只重新启用该局部阻塞；省略 ID 保留现有全季 retry 的含义，不能静默重新启用全部局部冲突。旧请求必须幂等，重试动作核验当前绑定、固定事件摘要和 `PENDING` 状态，记录审计。重试只解除停用并要求重新比较，不直接生成 Google 补丁。

## 6. 升级、备份与恢复

业务保护备份清单位于 `shared/c2-business-backup-tables.ts`。新增索引／阻塞／请求选择／poll 计划四表必须一并捕获、计数、摘要校验；本地测试验证有局部阻塞和部分确认事件的备份内容完整。schema 升级前后保存私有快照，确认旧业务、游标、物理 B、batch 和请求结果保留。应用 schema 采用 additive 升级；旧代码可能拒绝更高 schema。回滚必须验证存储兼容，不能仅切换旧 Worker；按正式恢复流程保留升级前后保护包。

当前封存恢复只接受 schema14／47表或16／51表包，原固定索引、block、请求选择和poll计划均原样保留，不重建、不自动解锁或执行导出。更早缺少这些表的包不在现行恢复支持范围；若另行迁移，须受控建立固定索引并检查顺序、重复 ID 和分类，存在缺口时禁止导出。在线启用仍须两端暂停、前进归属代次并对账已生效批次，不能因 Google 副作用不在恢复点内而重放旧批次。封存与在线交接门槛见[恢复指南](../cloudflare/ISOLATED-RECOVERY.md)。

## 7. 完整训练通道的交付门槛

| 场景 | 必须证明 |
|---|---|
| A 局部冲突，B 独立训练 | A 不写、不推进 B／游标；B 可以完整确认；A 的后续事件继续停 |
| A 引用某成员冲突，B 也引用该成员 | B 重新前检并停止，无猜测合并或覆盖 |
| 更早成员／排期／未知事件 | 所有后序关联事件被屏障阻止；共享版本不倒退 |
| 部分关联阶段已确认，无未完成批次 | 可以局部停住 A，B 继续；A 最终再核验全部阶段 |
| PREPARED／SENT／PARTIAL／FAILED | 全季先恢复原批次；丢回执不新增 operation，不越过 |
| Google 在前检后变化／并发准备／暂停 | 发送前与事务内检查拒绝，保留准确恢复状态 |
| B 成功及 Coach retry A | 不清掉 A 阻塞；修复后原事件从原版本继续，无重复递补或 revision |
| schema、备份和有界扫描 | 固定顺序与局部阻塞可验证保留；覆盖不足时不给安全结论 |

本地门槛通过后再进行隔离 Google 验收。完整第一版只可称为“不同训练的关联事件独立推进”，成员之间、排期之间及同实体独立字段的同步仍属于后续范围。只有对应验收实际通过后才更新当前状态；不得因本文或前检补丁而宣布 C2.5 整体完成。
