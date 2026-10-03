# C2.3 物理行单格漂移／恢复：隔离远端验收

日期：2026-09-30。目标仅为 c2test Worker `0.16.2-c2-physical-diagnostics`、schema v13、独立 Google 文件与虚构赛季 `season_c2_isolated_2026`。执行器 [`live-c2-physical-drift.mjs`](live-c2-physical-drift.mjs) 经独立审查和语法检查后逐阶段运行；原 staging、production、Pages 与真实队员数据未触碰。

1. `prepare` 对当前隔离 DO 重新验证私有备份身份和内容 digest，从备份锁定 23 条关联物理 B、唯一虚构 Alpha `SignupsCurrent` 整行及其 B digest；四个 scope 物理状态均为 `OK`，outbox／batch／开放冲突零。仅在 Git 忽略目录保存完整原行、唯一目标列、固定注入／恢复 batch ID 与阶段状态。独立 `inspect-state` 确认 Google 原行 `ORIGINAL`。两步均退出 Coach。
2. 显式 `--write-test-data` 的 `inject` 经签名 Apps Script `cloudflarePatchSignupSheet` 的 LockService 内完整行 CAS，仅改该行 `last_request_id` 一格；固定 operation ID 与 batch ID 相同。回执明确 verified，签名 Google 读回 `MARKER`，另一个 `inspect-state` 再确认，Coach 均退出。没有改动报名状态、位置、名字、座位、其他行或 Worker 业务数据。
3. `inspect-drift --allow-semantic-inspection-write`：新物理 API 对 `SIGNUP` 返回 `DRIFT`，唯一 `CELL_CHANGED` 且 `changed_columns=["last_request_id"]`，B/G digest 与保存的原行／标记行精确匹配；旧 `check-sheet-differences` 仍是语义 `OK`、零 finding，仅新增 `physical_integrity=DRIFT`。旧接口按原契约维护 `sync_conflicts`，但开放冲突仍为零。Coach 已退出。
4. 显式 `--write-test-data` 的 `restore` 先再次证实同一唯一物理漂移与 B digest，再用另一固定 batch 的签名完整行 CAS 把标记行恢复原行；回执 verified、签名读回 `ORIGINAL`，独立 `inspect-state` 再确认，Coach 已退出。本次没有遇到丢回执；脚本的未知回执恢复分支未经远端故障注入验收。
5. `final` 核对四 scope 全 `OK`、旧 SIGNUP 语义及附带物理状态均 `OK`、outbox／batch／开放冲突零；生成且校验私有 v13 审计快照 44 分块，**23／23 条关联物理 B 整行内容与注入前完全一致**。最终独立无 flag `diagnose` 再证四表仍为 1／1／20／1，`rows_read=baselines_checked` 为 1／21／20／1，所有 finding 零、Coach 已退出；手动 poll 仍返回 HTTP 409／`EXPORT_POLL_DISABLED`，c2test 无 cron。

剩余可审计副作用：隔离系统 Google Sheet 新增注入和恢复两条幂等桥接回执；隔离 DO 新增私有备份快照元数据／分块，旧语义诊断可能更新其冲突记录；Git 忽略目录保留快照与恢复状态。Google 业务表最终与原整行一致，物理 B 未变。overview 隐藏先前的 idle retry 行不代表数据库历史行被删除。

此验收证明诊断能发现一个**语义忽略但物理已变**的审计列，并能在隔离环境精确恢复。它不覆盖其他列／并发人工修改、真正的丢回执或部分写入故障，也不意味着 C2.4／C2.5 全面完成、自动轮询开启或生产切换。
