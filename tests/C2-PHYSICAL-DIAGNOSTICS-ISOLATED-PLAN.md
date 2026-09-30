# C2.5／C2.3 物理行诊断：专用 c2test 部署门槛

仅针对 `dragon-boat-training-api-c2-test`、隔离 Google deployment／runtime Sheet、虚构赛季 `season_c2_isolated_2026`。**0.16.2 正常态和单格漂移／恢复均已验收，证据见 [正常态报告](C2-PHYSICAL-DIAGNOSTICS-ISOLATED-ACCEPTANCE-2026-09-30.md)与[漂移报告](C2-PHYSICAL-DRIFT-ISOLATED-ACCEPTANCE-2026-09-30.md)。**原 staging、production、Pages 及其 Google 文件均不在目标内。

## 已完成的只读前置

- [`live-c2-physical-diagnostics.mjs`](live-c2-physical-diagnostics.mjs) 的 `--phase=preflight` 已通过：真实 c2test `0.16.1-c2-associated-export`／schema v13，10 名虚构队员，四个关联 Google tab 为 `SIGNUP=1`、`SEAT_PLAN_DRAFT=1`、`SEAT_PLAN_CURRENT=20`、`SEAT_PLAN_REVISION=1`；outbox／batch／开放冲突均零，Coach 已退出。脚本核对 Worker 主机和 backend instance、隔离季、TEAM_ID、两份 Spreadsheet ID、Google deployment ID、tab 名／表头、固定练习与每张表的行数。
- c2test `C2_EXPORT_POLL_ENABLED=false` 且 `crons=[]`；原 staging／production 导出开关保持关闭。c2test 目前 overview 可见一条已知的 `failure_count=0`、`action_required=false`、空错误的历史 idle retry 行；它是 C2.5 受控演练遗留，队列已清空。部署新代码后 overview 预期隐藏此 idle 行，**并不意味着 SQLite 中的旧行已删除**。手动 poll 仍应返回 `409 EXPORT_POLL_DISABLED`。
- 较早的私有 v13 备份为 41／41 chunks，时间 20:51:52 UTC，早于后续 C2.5 成员版本变动。已追加当前零积压状态的 v13 私有备份：44／44 chunks、完整 manifest digest、每个 chunk digest 与 manifest descriptor 都通过；独立私有 reference 锁定本轮 snapshot ID／content digest／创建时间以及 Worker、backend、TEAM_ID、赛季、两份 Spreadsheet 与 Google deployment 身份。当前隔离 DO 的 `verify-backup-snapshot` 用该明确 ID／digest 再验成功；diagnose 阶段会再次远端验同一快照。只在 Git 忽略目录保存 ID 和内容，不向日志输出。备份 API 会写 DO 快照元数据／分块，但不改业务行或 Google；备份不是恢复演练。

## 已执行的部署与正常态验收步骤

1. 对比 `cloudflare/wrangler.jsonc`：**只改** `env.c2test.vars.SERVICE_VERSION` 为 `0.16.2-c2-physical-diagnostics`；c2test Worker 名、backend instance、TEAM_ID、writer epoch、四个 C2 feature 开关、`poll=false`、`crons=[]` 不变；原 staging 与 production 配置字节级不变。新接口只读、无新 schema migration；schema 应仍为 v13。
2. `npm run cf:types`、`npm run cf:check`、`npm run cf:test`、`npm test` 通过。只对 c2test 做 Wrangler dry run，复核绑定／目标名称，然后 `npm run cf:deploy:c2test`。记录 Worker version ID；不部署 Google Apps Script、Pages、原 staging 或 production。若部署身份与预期不符立即停止。
3. 部署后先核 health `0.16.2-c2-physical-diagnostics`／backend instance、overview schema v13／binding 1／outbox0／batch0／冲突0、Google 四表 1／1／20／1，并执行独立 `poll-due-exports` 禁用断言 `409 EXPORT_POLL_DISABLED`。若旧 idle retry 在 overview 中消失，只能报告**展示过滤**，不能宣称数据库行已清理。
4. 在真实 Coach 会话运行 `node --env-file=D:\agents\dev-master\.c2-form-test\acceptance.env tests/live-c2-physical-diagnostics.mjs --phase=diagnose`。新 `check-associated-physical-differences` 分别检查四个 scope：期望 `OK`、`coverage=complete`、`findings_count=0`，`rows_read`／`baselines_checked` 依次为 1、21、20、1。`SEAT_PLAN_DRAFT` 包含状态一行及船位 20 行；若 Google 与物理 B 都是空表，正确结果应为 `INCOMPLETE`，不可误称 `OK`。脚本 `finally` 退出 Coach。
5. 可选地显式加 `--include-semantic-check` 检查旧 `check-sheet-differences` 的 `SIGNUP` 与 `SEAT_PLAN_DRAFT`：旧语义 `status=OK`、findings=0、rows_read=1／21 不变；仅新增的 `physical_integrity.status=OK`。**旧接口契约为 `writes:true`，可能维护 `sync_conflicts`；此选项不是纯只读调用。**调用前后核对开放冲突数仍为零，并退出 Coach。不加该 flag 的默认验收只调用新只读接口。

任何身份、版本、排队、Google 表头／行数或 Coach 会话检查失败都先停，读取当前状态而不盲目重复部署、覆盖 Google 或修正 SQL 时间。生产切换和自动轮询另需独立批准。

## 已执行的单格漂移实测：与正常态步骤分离

受限执行器为 [`live-c2-physical-drift.mjs`](live-c2-physical-drift.mjs)。每次调用仅一个 `--phase`，按 `prepare` → `inject --write-test-data` → `inspect-drift --allow-semantic-inspection-write` → `restore --write-test-data` → `final --allow-semantic-inspection-write --capture-private-backup` 前进；每一阶段独立 Coach 登录／退出并保存 Git 忽略私有状态。若桥接写入回执不确定，先 `inspect-state` 只读判明 Google 当前是原整行还是标记整行；只有固定 batch 的显式 `retry-inject`／`retry-restore --write-test-data` 可在冷却后继续。final 会生成一份私有审计快照并比较**整张**关联物理 B 表的行内容，故它会写 DO 备份元数据但不会写业务或 Google。

只选隔离 `SignupsCurrent` 的唯一虚构 Alpha 行 `last_request_id`；不触碰名字、报名状态、位置、队列字段或不可变 revision。先确认四 scope 物理 `OK`、旧 SIGNUP 语义 `OK`、outbox／batch／开放冲突均零、poll 禁用、binding／runtime Sheet／tab 身份稳定，锁定唯一 row ID、Google 当前整行与物理 B 的单行 digest，并把原整行及 B 摘要保存至 Git 忽略恢复文件。受限签名桥接 `cloudflarePatchSignupSheet` 使用新且固定的 operation/batch ID、完整 `expected=原整行`、`target=仅 last_request_id 单格标记变化`，绑定隔离 runtime Sheet ID、tab ID、season／binding／writer epoch；内部 LockService 执行逐格 CAS，成功后签名读回须只见该一格变化。禁止通过 Sheets UI 或 values.update 冒充 CAS。

随后新物理 API 应返回 `DRIFT`，唯一 `CELL_CHANGED` 的 `changed_columns=["last_request_id"]`；旧 SIGNUP 语义仍应 `OK`、零 findings，而它附带的 `physical_integrity` 应为 `DRIFT`。再用**另一固定**签名 CAS 批次、`expected=带标记整行`、`target=原整行` 恢复，并签名读回原值。最终四 scope 物理 `OK`，旧语义 `OK`，outbox／batch／开放冲突未变；私有前后备份核对物理 B 表摘要不变，Coach 退出。桥接会写隔离系统 Sheet 的幂等 receipt；这属于可审计的测试副作用。

执行器分阶段持久化原行、标记行、两个固定批次 ID 与进度到 Git 忽略恢复文件；即使进程崩溃，也先签名读 Google：若已回原行则视为恢复完成；若仍为标记行则以完整 `expected=标记行` CAS 恢复；其他值一律停下。注入 CAS 丢回执时同样先读，绝不盲重试或改写；只有 Google 行被证实仍是原行才允许同一固定批次的安全重放。恢复后四 scope 重新 `OK`。本轮远端回执均明确成功，未知回执分支尚未做故障注入验收。
