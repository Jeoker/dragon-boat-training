# C2 独立训练通道真实 Google 验收计划

> 2026-09-30制定的执行前规则，2026-10-01对应隔离验收已完成；实际结果见[独立训练真实验收报告](C2-ASSOCIATED-LANE-ISOLATED-ACCEPTANCE-2026-09-30.md)。本文保留执行门槛与恢复规则，不是实际报告，也不构成重复创建业务数据的授权；不能据此宣布C2.5完成或启用生产同步。

## 1. 执行边界与入口门槛

本计划执行时的目标为 Worker `0.17.0-c2-associated-lanes`、schema14；supervisor已完成专用c2test部署及本轮验收。以下仍保留当时执行前门槛。保持 `C2_EXPORT_POLL_ENABLED=false`、`crons=[]`。仅调用显式、逐事件 exporter；不运行 poll endpoint。生产、原 staging、原训练记录及原表单来源均不在验收范围。

在任何业务写入前，必须证明：

- 新通道的源码、四张新增表、完整备份、同请求恢复及有界扫描已独立审核通过；大于200条正常积压仍可推进的门槛已关闭。
- 本次候补验收 final 真正通过；临时故障 overlay 已撤除，部署恢复完整 clean v14、HEAD 恢复原完整 HEAD，并分别验证其原三文件摘要。不得将两套不同的 clean 互相替代。
- 当前绑定、系统、签名 bridge、Form/response source 均为既有固定隔离来源，writer epoch0；schema14、目标 Worker 版本、pollfalse 与无 cron 均实读一致。无待审核来源、open conflict、global action required、退避、未完成 batch、未确认旧 outbox 或运行时暂停。
- 基线 roster为11名虚构成员；旧候补训练 cursor为12/2/2，Google关联行11/1/20/2；这些仅为执行门槛，不能从本文当作当前远端已确认事实。roster行数不等于 `roster_version`，后者实读并保存。
- 完整备份 manifest 和逐页 chunk/digest 均核验；全部原业务行、旧训练 cursor、逻辑/物理 B、immutable revision1/2、请求结果及 Google 全表行保存至忽略目录的私有 journal。

升级证据同时保留候补 final 的完整 v13 包及其摘要。若 supervisor 已保存 `cloudflare/.acceptance-artifacts/c2-lane-upgrade-reference.json`，capture 必须核验该引用绑定的 fresh 完整 v13 包、旧 final 摘要、fresh 摘要和每项明确指标变化，再用 fresh 包证明 v13→v14 迁移。引用缺失时只允许以旧 final 为锚，私有证据明确 `fresh_reference=null`；仍须通过完整旧业务保护，不声称已取得 fresh 升级锚。

43 张旧表和四张新表均完整下载并核验 manifest、全部 chunk 顺序、逐表索引/offset/行数及摘要。42 张旧业务/历史/元数据表原行 exact retained，唯一升级元数据例外是 `app_meta.schema_version` 13→14；新审计/请求行可以追加。`usage_snapshots` 是小时采样，允许已审核字段随运营刷新，保存完整 before/after、键、单调 captured_at、非负安全整数及 sampling age。请求/审计计数不超过备份总量，历史计数与不变业务相符；jobs 依 created/completed 时间重建采样时状态，outbox 仅采样晚于最后业务及导出确认后才与当前 pending 比较。不得把历史采样称为当前实时值，也不得忽略任务原行变化。fresh 引用的指标 age 由 reference.created_at 精确推导，不在复核时用当前时钟重算。

任何前提不足仅输出受控 `DATA_PRECONDITION_REQUIRED` 与条件代码，不打印私有 ID、原行、凭据或 assert expected/actual。不得自动改绑定、清 retry、修改 due_at、补索引或提交表单以满足门槛。

## 2. 数据设计

选择季内一个尚无训练周且日期在未来的周一，创建专用训练周。`prepare-training-week` 会根据已有 active template 自动生成训练，因此预检必须证明恰有一个可用于 A 的模板，并验证生成 A 的日期、时区、容量10/10与未来截止时间；不能假设创建空周，也不能禁用或修改已有模板。显式新建 B 后才确认该周。所有操作使用实际返回的 season/week/practice version；任何额外自动训练、旧周占用或日期越界都停止。

新周的自动训练为 A，显式创建另一未来日期的训练为 B。周、A/B 的全部私有 ID、日期与 Google 整行基线捕获在 journal。确认开放仅作用于该新周，使用真实 API；如实际生成多个排期事件，逐一保存完整 immutable snapshot 和固定 index 顺序，再等待原 due_at 自然到期串行确认所有 schedule 全季屏障。不得把 schedule snapshot 的全季字段当成仅包含 A/B，也不得让关联事件越过旧屏障。

A/B 各使用既有虚构 `C2 Test Member Alpha` 报名一次，初始偏好 LEFT。该成员在旧候补训练的历史报名、取消、排座及 revision 全部保留。新训练不设置 Coach/Steerer，不发布排座；更新偏好到 RIGHT 用于生成各自第二个真实报名事件。固定容量不改。每次 mutation 的 snapshot/state 实读为准；若出现额外 seating/revision transition，执行停止并重新审核，不猜测投影。

## 3. Google 漂移与恢复方式

现有完整 clean bridge 已提供签名 `cloudflarePatchPracticeSheet` 和 `cloudflarePatchMemberSheet`。使用它们的 full-row expected/target CAS；不新增 C2Fixture、公共测试 endpoint、权限、marker或 Apps Script 源码。

只允许两种已限定人为漂移：

1. A 的 PRACTICE 行 `location` 增加唯一隔离标记；其它 cell 完全不变，B及所有旧训练行不变。
2. Alpha 的 MEMBER 行 `status` 从已捕获的 ACTIVE 改为合法 INACTIVE；其它 cell 完全不变，Cloudflare业务成员仍 ACTIVE。此步骤必须在全部成员/排期屏障已确认后执行，不能同时产生真实 member mutation。

每次 apply 和 restore 均有不同但预先固定的 batch/operation ID。调用前原 expected、target、完整 binding/runtime、payload digest及原 ID 必须原子持久化。未知回复先读 exact expected/target；恢复原调用和原 ID，不因读到 target 就推断 receipt 已 verified，不换 ID、不重算 expected、不放宽整行条件。第三种内容、重复行、binding变化或错误 tab/header立即停止。

restore 是 target整行到原expected整行的 CAS，必须从 journal 取原字节序列，不能从当前 Google 行合成“原值”。得到 verified receipt 后再次全行读取，并证明所有不在单行目标内的 Google 行与操作前一致。人为漂移期间不声称差异为零；恢复与真正 exporter 确认以后才做完整对账。

## 4. 显式阶段与必要证据

| 阶段 | 动作 | 验收条件 |
|---|---|---|
| preflight / capture | 只读门槛、完整私有 backup及Google基线 | 无业务写；原数据证据完整 |
| prepare / create-b / open | 创建专用新周、A/B并开放 | 原周/模板/训练不变；每次请求和 snapshot 在 journal固定 |
| export-schedule | 原 due_at 到期后逐事件、逐批次确认排期 | 所有全季屏障先完成；A/B的PRACTICE物理 B/G齐全且一致 |
| signup-a1 / signup-b1 | Alpha在A/B真实报名LEFT | 两事件原 snapshot及sequence固定；每场 signup_version1；未改旧训练 |
| drift-practice | 对A单行 location 做签名 CAS | 精确单行变化，B引用仍干净 |
| block-a1 | 固定原 A1 export request 前检 | `LocalExportConflict`；A1局部block；零batch、零Google业务写、零cursor/B推进；全季不halt |
| signup-a2 / probe-successor | A真实偏好改RIGHT，尝试指定A2的新受控probe | 原 A2 due 自然到期且原 A1 有效 block 后才执行；A2为原A1之后的真实snapshot；不得绕过A1；probe不占用B1的执行请求、不创建batch、不改原selection |
| export-b1 | 原B1逐批次及event确认 | B1完整EVENT_CONFIRMED；B cursor1；A1/A2保持pending，A1 block仍在，A cursor0；overview/page/backup保留block |
| restore-practice / retry-a1 / export-a1 | 原PRACTICE整行恢复；Coach retry仅A1；原A1请求恢复确认 | retry不创建Google patch，不更换事件/请求；A1 EVENT_CONFIRMED、A cursor1；A2仍原snapshot pending |
| signup-b2 / drift-member | B偏好改RIGHT；Alpha MEMBER单行CAS为INACTIVE | A2/B2都引用同一已确认member基线；未产生真实member屏障 |
| block-a2 / block-b2 | 各自固定原请求前检 | 各自原 due 自然到期后，两场分别localblock；均零batch/业务写；A/B cursor仍1；全季无halt，后序不越过 |
| restore-member / retry-a2 / retry-b2 | 原MEMBER整行恢复；两个受控Coach重试 | 精确解除各自block；retry omitted outbox_id不能作为替代；不修改snapshot/queue/sequence |
| export-a2 / export-b2 | 沿各自原请求和原event依顺序确认 | 每场cursor signup2，其它版本按真实snapshot；确认后仅各自block清理 |
| final | 完整backup、Google全部目标及原基线核对 | 两场无待处理事件/block/batch；所有旧业务历史与旧cursor/revision保持；无globalhalt；pollfalse/crons[] |

事件实际确认期间可拆成显式单call步骤，保存每个返回值。BATCH_CONFIRMED 不等于 EVENT_CONFIRMED；只在最终 event 再核验成功后断言完整 projection/cursor。上一个已确认步骤重跑只读复核当前已确认进度，不要求 Google 回到旧 snapshot。已发送/结果未知的批次仍是全季 drain 屏障，禁止让另一个训练越过。

runner 每次 export 最多发送一个调用。已知 BATCH_CONFIRMED 或 EVENT_CONFIRMED 保存原结果和 `evidence_pending` 后，完整核验当前 backup、immutable snapshot 投影、完整 Google receipt、旧行/B、cursor、block page 与 overview；全部通过才清除 checkpoint。若回复已知而证据失败，下次同 phase 仅只读复核该 checkpoint，成功后本次返回，仍不发送下一批或下一事件。后一次显式执行才允许推进。回复未知则保留原 inflight ID 和 payload，与已知待核验状态分别处理。

对于 local conflict，要同时核对四张新增表：固定 index anchor/sequence、独立 block字段、原request selection、无新增或改变的poll plan。使用受保护的 paginated block API 从头读到尾并对照完整备份，不把 overview 的数量当作完整列表，也不能因B成功隐藏A的错误。block的原identity与error context保存，retry核对原绑定、payload digest和 PENDING 状态。

## 5. 恢复与报告门槛

runner必须为每个阶段持久化 intended request/payload，再调用 API；未知业务回复先核对实际backup/原请求结果，随后只重放原request。所有Google CAS均沿原batch/operation。journal仅写忽略目录，不覆盖其它验收journal、不在失败后自动进入下一阶段、不自动发布/暂停/恢复/部署。CLI错误仅返回受控phase/condition，私有详细证据保留本地。

最终报告区分已实现、本地通过、隔离真实Google通过与尚未验收。此次仅证明同季不同训练的关联事件可独立推进、共同成员引用仍会分别阻塞，以及同训练顺序和全季屏障仍成立。没有验证自动poll、生产迁移、恢复演练、同实体字段合并或成员/排期事件独立推进，不能由本文扩大结论。

如果执行中门槛失败，保留两个系统现状和原journal，给出具体受控条件及必要恢复步骤。人为漂移恢复后也必须等事件核验、block/page/backup及旧记录保护全部通过，才由supervisor更新当前状态。

## 6. 本地工具检查与 supervisor 命令

入口为 [live-c2-associated-lane-acceptance.mjs](live-c2-associated-lane-acceptance.mjs)，本地纯构造/恢复测试为 [c2-associated-lane-acceptance.test.mjs](c2-associated-lane-acceptance.test.mjs)。导入模块不读凭据、不调用网络。检查命令：

```powershell
node --check tests/live-c2-associated-lane-acceptance.mjs
node --test tests/c2-associated-lane-acceptance.test.mjs
```

以下仅供 supervisor 在代码/工具独审、真实候补 final、双 clean 恢复、完整升级前参考、隔离 Worker 升级全部完成后执行。若本地仍为旧版本配置，runner 会在网络前返回 `WORKER_UPGRADE_NOT_CONFIGURED`；远端版本/schema不匹配也停止。

在项目根目录执行，凭据始终使用既有私有 acceptance.env：

```powershell
node --env-file="D:\agents\dev-master\.c2-form-test\acceptance.env" tests/live-c2-associated-lane-acceptance.mjs --phase=preflight
node --env-file="D:\agents\dev-master\.c2-form-test\acceptance.env" tests/live-c2-associated-lane-acceptance.mjs --phase=capture --week-date=2026-10-19 --capture-private-backup
node --env-file="D:\agents\dev-master\.c2-form-test\acceptance.env" tests/live-c2-associated-lane-acceptance.mjs --phase=prepare --capture-private-backup --write-test-data
```

Oct5 和 Oct12 已有旧周，候选为 Oct19；capture 必须重新实读证明未占用，确认真实模板 day/time、A/B完整季内日期与未来 cutoff。不得因日期冲突自动选择其它周或附加旧 DRAFT。

之后用同一命令，将 `--phase=prepare` 逐次替换为表内准确的小写 phase，严格按表顺序执行。所有非 preflight 命令保留 `--capture-private-backup`；除 capture/final 外保留 `--write-test-data`。最终：

```powershell
node --env-file="D:\agents\dev-master\.c2-form-test\acceptance.env" tests/live-c2-associated-lane-acceptance.mjs --phase=final --capture-private-backup
```

export phase 返回 BATCH_PROGRESS 时，下次仍执行同一 phase。不得用循环自动进下一 phase；必须先看受控结果和私有证据。NATURAL_DUE_NOT_REACHED 保留原 due 并自然等待。成功输出在 Coach logout 成功后才发出，带 `coach_logged_out=true`。私有 journal 固定为 `cloudflare/.acceptance-artifacts/c2-associated-lane-journal.json`，不删除/换名来重跑未知请求，不覆盖其它验收 journal。本文没有远端执行结果。

HTTP 回复按实际 API 分类严格匹配合同：C1 为 `2026-09-21.c1.5`，C2 为 `2026-09-30.c2.5-associated-export`；同时核对隔离版本、instance、generation、epoch及实际发送的 request_id。失败仅在 ignored `cloudflare/.acceptance-artifacts/c2-associated-lane-failure.json` 保存 phase、condition、错误类型与调用栈位置；不保存 assert message/expected/actual，不将私有详情打印至终端。

HTTP非成功回复停止 phase，condition 为 `HTTP_<status>_<固定允许code>`，未列出的 code 归为 UNCLASSIFIED_ERROR。私有诊断只补受控 status、error_code、retryable、固定 endpoint 与 scope；不保存响应 message、payload、行或 ID，不自动重试。clean 的 Sheet差异检查可能持久化诊断 findings 元数据，不能称为零 storage 写；它不写 Google 或业务记录。暂时拒绝需由 supervisor 判断并自然等待，不能据此跳过干净门槛。
