# C2.4 候补递补：隔离 Google 执行前计划

日期：2026-09-30。此文件是可复核的执行计划，不是远端验收报告。入口为 [`live-c2-waitlist-acceptance.mjs`](live-c2-waitlist-acceptance.mjs)。新增脚本当前仅经过本地语法和代码核查；远端结果由实际执行后的独立验收记录证明。

## 场景与数据条件

沿用专用 `c2test` 的 `2026-10-05` 虚构测试周及其唯一训练。保持左右各十个名额，保持已有 Alpha 左侧报名、完整二十格草稿和 Alpha LEFT1 正式 revision 1。通过九名其他虚构成员的 LEFT 报名占满左侧容量，第十一名 `C2 Test Member Lambda` 的 LEFT 报名成为候补。右侧仍有空余，所以这证明侧向容量候补与兼容递补，不声称全船二十人已满。

现有名册只有十人时无法产生第十一个独立候补，不能通过降低容量、影子导入报名、复用身份或改写旧 revision 制造场景。`preflight` 在所有已有数据清洁时返回 `DATA_PRECONDITION_REQUIRED` 和人数汇总。

必须先由 supervisor 在唯一隔离 Form 提交一次虚构 Lambda 回答，再通过现有真实 Form 导入路径读取；提交结果未知时先核对 Form 与 roster，不能再次提交。可能已有触发器完成导入，后续 pull 的 created 为零或一都须与实际来源对账。旧 `live-c2-form-acceptance`、review 和 overlap 脚本使用旧版本／旧人数并可能执行影子导入，不适合作为新增成员入口。新增前后的原十个稳定 ID 必须保持；新成员唯一、ACTIVE、无待人工核查来源，且 MEMBER 的 Google 写回已确认、outbox 已归零。此脚本不自动提交 Form、导入成员或排空非关联事件。

脚本随后要求名册精确十一人，全部姓名具有虚构前缀，其中 Alpha 与 Lambda 均唯一。仅通过当前正常报名／取消 API 推进状态；不改变训练日期、截止、容量、赛季或写入归属。

## 执行边界

- Worker 固定为 `dragon-boat-training-api-c2-test`，服务版本精确 `0.16.2-c2-physical-diagnostics`，schema v13、binding 1、writer epoch 0。
- 本地私有 fixture 的 season、runtime／system Sheet、Form、response Sheet 和 Apps Script deployment 身份必须与实际响应吻合。没有生产或原 staging 回退路径。
- 本地配置检查隔离关联导出开启、自动导出关闭、隔离 cron 为空；生产与原 staging 的关联导出和轮询保持关闭。脚本不修改配置或部署。
- 初始 Google 四表精确为报名一行、状态一行、船位二十行、revision 一行，revision 1 仅 Alpha LEFT1。七个语义 scope 零差异，四个物理 scope 完整覆盖且零 finding，无待处理批次、冲突或来源核查。
- 每次执行使用短暂测试 Coach 会话并在 `finally` 中退出。预检仍会创建／退出会话，语义差异 API 仍有其既有诊断持久化副作用，因此不描述成绝对零写入。
- `backup`、`audit-queued` 和 `final` 都须显式 `--capture-private-backup`，只创建并校验 DO 私有快照与本地文件，不表示执行过恢复。业务及导出阶段另外要求 `--write-test-data`。
- 输出仅提供版本、人数、批次状态、行数和确认结果；所有 assertion／网络失败都统一输出受控错误分类，避免 Node assertion 自动打印私有 ID、Google 整行或请求内容。

## 分阶段执行

先安全载入已有忽略的验收环境变量，禁止打印其内容。下面从独立仓库根目录执行。

```powershell
node tests/live-c2-waitlist-acceptance.mjs --phase=preflight
# 若不足十一人，先独立完成 Lambda Form 来源导入与 MEMBER 确认，再重新预检。
node tests/live-c2-waitlist-acceptance.mjs --phase=backup --capture-private-backup
node tests/live-c2-waitlist-acceptance.mjs --phase=enqueue --step=01 --write-test-data
# 依序运行 step=02 至 step=09，各自只产生一个已确认 LEFT 报名。
node tests/live-c2-waitlist-acceptance.mjs --phase=enqueue --step=10 --write-test-data
node tests/live-c2-waitlist-acceptance.mjs --phase=audit-queued --capture-private-backup
node tests/live-c2-waitlist-acceptance.mjs --phase=export --step=01 --write-test-data
# 依序运行 export step=02 至 step=10；每一步必须取得 EVENT_CONFIRMED 才继续。
node tests/live-c2-waitlist-acceptance.mjs --phase=cancel --write-test-data
node tests/live-c2-waitlist-acceptance.mjs --phase=audit-queued --capture-private-backup
node tests/live-c2-waitlist-acceptance.mjs --phase=export --step=cancel --write-test-data
node tests/live-c2-waitlist-acceptance.mjs --phase=final --capture-private-backup
```

1. `backup` 在原始业务状态上校验并下载私有快照，创建忽略的 `cloudflare/.acceptance-artifacts/c2-waitlist-journal.json`。其中保存原四表完整单元格、revision 1、十一人稳定身份、选定的九名填充成员与 run ID。已存在 journal 时拒绝覆盖。
2. `enqueue` 每次只发一个确定请求。步骤 01 至 09 将 signup version 从 1 推进到 10，确认十名 LEFT；步骤 10 将版本推进到 11，Lambda 唯一候补。每步先保存原 request ID 与完整 payload，再调用 API、保存不可变结果和检查当前版本、人数、名单、Alpha LEFT1。九笔填充报名和一笔候补可以接连排队，无须每次等待十分钟。Google 此时仍须保持原四表原样。
3. `audit-queued` 下载并验证新的私有快照，按 SQLite rowid 顺序读取十个 pending outbox，证明 signup version 为 2 至 11、请求归属与结果吻合、每个 snapshot 仅包含该次改变的报名行、没有额外排座 revision。将实际完整 outbox snapshot、固定 outbox ID 和自然 due_at 保存到 journal；逐场 cursor 必须仍是 signup 1／revision 1。
4. `export` 每次只排空指定事件。自然到期前返回 `WAITING_FOR_DUE` 与空 calls，不睡眠、不改 SQL、不提前写 Google。到期后每个请求持久保存原编号，最多十二次调用取得 `EVENT_CONFIRMED`。每个事件后重新读取 Google 四表，与截至该事件的不可变 snapshot 逐单元格对账，验证报名时间、队列号、审计列、状态和旧 revision 全行不变。不能用当前 signup version 11 的行替代 version 2 等旧目标。
5. 十个事件全部确认、Google 与 C 一致之后，`cancel` 用固定原请求取消 Alpha。服务器必须在同一事务产生 signup version 12、Lambda 递补、草稿 version 2、系统 revision 2，保留其他九名确认报名。取消后 Google 必须仍处于已确认的 version 11 状态，revision 1 不变。
6. 第二次 `audit-queued` 捕获唯一取消事件，证明包含 Alpha CANCELLED 与 Lambda CONFIRMED，Lambda 的原 queue_at／queue_sequence 保持不变；系统 revision 的 source 为 `SYSTEM_CANCELSIGNUP`，仅 Lambda LEFT1，完整二十格新草稿及状态已事务固定。Google 仍未提前变化。
7. 取消事件自然到期后 `export --step=cancel` 按关联批次写回报名、船位、revision 和状态，最后取得事件确认。Google revision 1 的所有列必须与最初捕获完全一致，新增 revision 2 必须等于取消事件 snapshot。
8. `final` 再核对七个语义 scope、四个物理 scope、Google 全量目标、outbox／batch／retry／冲突归零；最终私有快照须证明逐场 cursor 为 signup 12／seat plan 2／revision 2，每个本轮 outbox 为 CONFIRMED 且原 snapshot 不变，三十四行完整物理 B 与 Google 单元格精确一致。预期关联四表行数为 11／1／20／2，公开现状为十名确认、零候补、Lambda LEFT1。

## 中断与收尾

关联故障验收可以在 `export` 阶段增加 `--max-calls=1`，允许上限为一至十二，默认仍为十二。取得一个 `BATCH_CONFIRMED` 后保存 call 与 journal，返回 `BATCH_PROGRESS`、`event_confirmed=false`，核对 outbox 未提前确认、未完成批次已清零及旧 revision 1 不变；此时不对尚未完成事件的全部 Google 最终目标作错误断言。重复相同 step 会沿下一批继续；故障或丢响应时仍保留 inflight 原请求号用于恢复。该单步模式仅为另行审查的隔离部分写入／丢回执 fixture 配套，不负责部署或注入故障，不表示故障远端验收已通过。带故障的实际证据应单独记录，不能描述为无故障候补流程。

必须由单一 runner 串行执行这些阶段。不得并发运行本脚本与其他会修改同一赛季的脚本，不得删除 journal、修改其请求／snapshot 或创建新 run ID 来绕过拒绝。业务响应未知时重跑相同阶段和 step，沿原 payload 与 request ID 核实。导出响应未知时保留 inflight 请求，并沿原编号恢复同一批次；服务器持久 batch／operation 仍负责 Google 部分写入恢复。保存了最终确认之后、Google 核对尚未完成时，只重跑最新已确认 step 复查，不再发送下一事件。

已经执行后续阶段时，旧 `enqueue` 或旧 `export` step 的重跑会因现场状态超出当时目标而安全拒绝。遇到 `FAILED_STOP`、冲突、版本漂移、来源核查、关联行漂移或未知非本轮 outbox，应先停止并核对私有 journal／快照与服务器。脚本不会重建目标、自动重试永久失败、修复 Google 或改变 due_at。失败退出仅确认最终输出明确标记的结果；没有 `coach_logged_out=true` 不能声称本次会话已退出。

不自动恢复 Alpha 报名、不删除候补／取消历史、不改写 revision 1 或审计、不清空 Google 表。成功后保留虚构验收状态，并以独立报告记录实际版本、确认顺序、Google 对账、不可变旧 revision、游标与私有备份边界。真实配额／随机断网、部分写入故障注入、自动轮询、备份恢复、同季独立冲突和生产切换仍须各自的验收，不因本场景通过而提升 C2 整体状态。
