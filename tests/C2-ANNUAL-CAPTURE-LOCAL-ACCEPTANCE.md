# C2.6 一致捕获 adapter／proof - delivery 1 本地验收

> 历史范围说明：本文是 Delivery 1 历史验收；末尾“下一步”按当时范围解释。后续本地持久计划已完成，见 C2-ANNUAL-STORAGE-LOCAL-ACCEPTANCE.md。 最新状态见[CURRENT-STATUS](../CURRENT-STATUS.md)。

日期：2026-10-01。依据 [捕获存储设计](C2-ANNUAL-CAPTURE-STORAGE-DESIGN.md)及 supervisor 明确的 delivery 1 授权，只实现只读适配与证明，不提前实现后续三表／持久 service。

## 实现及边界

- [SQL adapter](../cloudflare/src/c2-archive-capture.ts)：`previewArchiveCapture` 在一次 `transactionSync` 内读取真实业务 SQL，先完成 audit 所有权／action分类、子行归属／初始状态／revision 子行限制和 COUNT／UTF8 聚合证明，再读取显式投影。调用既有 `parseArchiveInput`、`createArchivePlan` 校验完整 graph，返回 input、纯 plan、capture proof。
- [Workers 场景](../cloudflare/test/c2-archive-capture.test.ts)：真实 Worker C1导入和登录生成 SQLite；原 C1HistoryService 自然到期方法生成实际冻结和季完成。另在 **本地测试** 控制 Date，直接调用原 C1Signup／Seating／HistoryService，验证报名→草稿→发布→取消→最终更正→发布→冻结／完成／旧C1归档→追加说明的实际持久结果。测试结束恢复 Date，不触及远端时间或资料。
- [纯 proof 场景](c2-archive-capture-proof.test.mjs)：直接加载实际 TypeScript预算helper，核六倍UTF8转义界、metadata／行包装、nested rows、safeinteger／溢出及有限业务／运维audit分类。

没有新增或修改 SQL 表、schema／backup清单、既有 runtime import、HTTP action、manifest／部署版本、alarm、scheduled jobs或bridge。adapter只发SELECT，不落业务audit/outbox，也不补跑freeze。测试原C1写入仅用于本地fixtures；私有backup不是年度捕获来源。验收执行时未部署或远端写入。

当前结果是 `LOCAL_PLAN_ONLY` 和 `SOURCE_NOT_YET_VERIFIED`。这是即时预览：相同request再次调用可捕获后来私有值，专项明确验证了这一点；它不是原请求持久重放、跨重启恢复、digest CAS或Google verified。stage2未授权的状态不因本报告改变。

## 已验证场景

| 门槛 | 实际证据 |
|---|---|
| 初始真实SQL | C1新训练的两个版本0、没有seatstate／子行，适配明确 `IMPLICIT_INITIAL_STATE` 与 `practice.created_at`；逐practice proof标明虚拟来源，没有伪造Coach动作或真实state行。任一dirty draft／缺versions在正文加载前停止 |
| 正式和空位 | 实际C1 seating import形成完整draft、SQL NULL空座位、revision names／seats；adapter只对存在列的SQL NULL转明确空串，不补缺行。成员后来改名仍使用原正式／冻结姓名 |
| 原生业务审计 | 原C1 signup/cancel实际生成 finite nested seating snapshot、system revision；三个完整revision、取消报名、最终更正实际出席与冻结后说明均进入完整图。历史资格不重跑递补 |
| audit完整范围 | 105条适用业务audit全部读取，无management分页截断；login/import等明确运维项排除并计数。坏JSON、未知action、season错归属、practice缺归属在大正文加载前拒绝 |
| 范围和排除 | PRACTICE只读取目标训练子图；SEASON完整选未取消训练。另一场缺版本／未冻结使SEASON失败但不影响目标PRACTICE；取消训练和相关audit按已证明归属排除，proof分别计数 |
| 完整子行 | SEASON核目标季全部practice子表，PRACTICE核目标pid的anti-join。实际SQLite deferred-FK本地事务中临时构造孤儿practice_versions：读取前失败，随后删除以满足提交FK；不把孤儿当取消项静默丢弃 |
| 资源前置 | 超5000逻辑DTO行或带emoji／控制字符的预算超额，spy记录 **0次正文materialize**。两类state计2，nested names/seats单独计数和有界上限。聚合SQL本身仍扫描真实存储，没有把它称为JS假DB |
| 自然截止和安全失败 | 尚未到期、缺practice_history、坏history JSON均失败，不写SQL、不更改已有audit数量。截取过程中不返回partial input或partial plan |
| 仅预览 | 每次固定captured_at及derived自然cutoff；后续私有改变产生另一次预览，旧返回值不变。数据库不存在 `annual_archive_%` 表，无持久恢复冒充 |

## 预算与剩余限制

capture逻辑行上限5000，比已有纯模型5000输出records更保守；嵌套revision seats／names各<=100／102。所有显式SQL row JSON（包括nested、state0虚拟行、原audit/history文本包装）先聚合UTF8 BLOB bytes，按6倍最坏JSON转义再加metadata、4096固定包装及行分隔预算，得到必须<=2,000,000的input上界。加载后再核实际input不超过此界；既有纯模型继续执行chunk64KB／100rows和总plan2MB限制。超额明确失败，不剪页或增加预算。

六倍界可能保守拒绝原本可被pure DTO接受的大样本；这属于已审捕获资源门槛，未测量前不优化掉前置证明。预算是文本物化的上界，**不是JS heap测量，也不是SQL CPU常数保证**。全audit归属检查成本随团队历史规模与原JSON长度增长。当前有限action registry对未知C0／其他旧action保守停止；没有据此自动删除、忽略历史或更改C0。

初始虚拟state来源独立于actor文字：SQL明确标记seatstate行是否存在，真实state即使actor恰好等于该literal也不被当作派生状态。capture proof仅计数及固定来源信息，不复制凭据或raw完整backup。

## 验证结果

- Workers专项：11/11通过；Node proof专项：3/3通过；共享TypeScript `npm run cf:check`通过。
- 完整 `npm test`：262/262通过。
- 完整 `npm run cf:test`：22files／237tests通过，exit0。
- `node --check` 与 `git diff --check`通过；既有runtime入口／schema／history service无新增adapter import。

Wrangler日志目录仍有Windows EPERM旁路；完整Workers运行另有平台internal-exception日志输出，237项测试断言均通过，未将日志输出当作年度远端故障证据。未因这些旁路问题请求提升权限或触及远端。

源码及报告双独立审核通过：`conflict_design_review`最新11/11 Workers＋3/3 Node＋types／diff通过；`waitlist_acceptance`独立11/11 Workers＋3/3 Node＋types及docs2/2通过。两位reviewer均确认无未解决P1／P2，结论仅覆盖本地delivery 1，不扩展为持久计划或Google验收。

下一步只可在supervisor另授权后接持久plan／chunks／request pins、外部digest／完整textCAS、非空backup与跨重启测试；schema阶段须等待独立live v14验收完成，不由delivery1自动授权。
