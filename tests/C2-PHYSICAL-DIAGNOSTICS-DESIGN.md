# C2 关联 Sheet 物理行诊断设计（未实现）

## 现状与决定

C2.3 的 `check-sheet-differences` 比较业务字段的 B/C/G；它不会完整覆盖 `SignupsCurrent`、`SeatPlanState`、`SeatPlanCurrent` 的审计列。C2.4 已为这些表和不可变的 `SeatPlanRevisions` 保存 `sync_associated_physical_baselines` 整行 B，并在下一次关联导出前核验，但没有事件时不会巡检历史 revision。因此，语义检查为零差异不能代表物理行完整。

保持现有语义比较、返回字段和冲突处理不变。增加**独立的只读物理诊断**：复用当前 Coach 会话、赛季绑定和签名 Sheet 读取；按 `(season_id, binding_version, scope, row_id)` 对 Google 的完整显示值数组与已确认整行 B 比较。人工修改只生成诊断，不推断新的 B、不自动导入或修复，也不让诊断结果绕过 C2.4 写前核验。

## API 形状

- 对现有 `check-sheet-differences` 的 `SIGNUP` 和 `SEAT_PLAN_DRAFT` 响应，**只新增** `physical_integrity` 对象，分别覆盖 `SignupsCurrent`，以及 `SeatPlanState` + `SeatPlanCurrent`。共用这次已读取的 Sheet 页；旧的 `status`、`findings`、`findings_count` 和 `conflict_records` 仍只表达语义检查，避免改变旧客户端和 `sync_conflicts` 的含义。UI 必须同时展示物理状态，不能仅凭旧 `status=OK` 或语义零差异称为「完全正常」。其他语义实体不增加虚假的物理检查结论。
- 增加 Coach 会话保护的 `check-associated-physical-differences` 只读入口，输入为 `request_id`、`session_token`、`season_id`、`scope`（四个关联 scope 之一）。它特别用于 `SEAT_PLAN_REVISION` 历史巡检，也可按需重查其他三个 scope。输出含 `scope`、`status`（`OK`、`DRIFT`、`INCOMPLETE` 或 `STRUCTURE_INVALID`）、`read_at`、`rows_read`、`baselines_checked`、`coverage`、`findings_count`、`truncated` 和最多 100 条 `findings`。每条 finding 含 `row_id`、Google 行号、类型、变化列名及 B/G 摘要；列表默认不返回完整审计内容或姓名快照。`OK` 仅在完整读完、结构和行 ID 有效、每个 Google 行及 B 都核对且无变化时成立。
- `coverage` 明示 `complete`、`bounded_limit` 或 `failed`。缺 B、多余行、缺行、重复／改 ID、跨季行或列结构异常均为需要人工处理的结果；扫描受限或无法证明覆盖时返回 `INCOMPLETE`，不得返回 `OK`。绑定或物理 B 在读取至提交响应之间变化时返回现有风格的 `SHEET_INSPECTION_STALE`，不发布过时的「正常」结果。

首个切片保持诊断无状态：不向 `sync_conflicts` 写入物理 finding，尤其不把 `SEAT_PLAN_REVISION` 错记成 `SEAT_PLAN_DRAFT`。现有 `sync_conflicts` 的实体类型 CHECK 不接受 revision；强行复用需要重建表，会给本次只读补强引入不必要的迁移风险。受控修复／确认整行 B 另行设计，绝不将当前 G 静默设为 B。

## 巡检、边界与门槛

先用隔离环境完成手动全量 revision 扫描及故障验收，再考虑定期巡检。定期版需要显式开关和独立的 schema v14 小表，按赛季、绑定、scope 保存最近一次**完整**扫描时间、覆盖、状态和摘要；默认关闭，不改变当前 c2test／production 的自动轮询状态。定时器不能把局部扫描、上一次的 `OK` 或未覆盖的新 revision 伪装成当前全量正常。

当前 Google 桥接单次整表读取上限为每表 5,000 行、总计 100,000 单元格／2,000,000 字符；`SEAT_PLAN_DRAFT` 同时读取两表。大表、Apps Script 执行时间及 Google 配额是主要成本。达到限制时应明确 `INCOMPLETE`／扫描限制；若将来需要分块，必须设计跨页的一致性或保守重扫，不能单靠可变物理行号翻页后报告全量 `OK`。只读扫描不应加入导出热路径的每次批次写入，也不能默认高频运行。

测试门槛：仅改单个审计列时语义仍可 `NO_CHANGE`，但物理诊断为 `DRIFT`；历史 revision 的改值、删除、额外行、重复／改 ID 和缺物理 B 都可见；所有四个 scope 的正确行仍为 `OK`；绑定或 B 并发变化报 stale；坏表头、超限与部分覆盖绝不报 `OK`；重复检查稳定、不会写 Google、业务表、基线或冲突表。隔离真实 Google 验收应分别记录扫描耗时、行数和配额迹象。

**状态：仅设计。** 本文件不表示 API、定期任务、v14 迁移或远端验收已完成。
