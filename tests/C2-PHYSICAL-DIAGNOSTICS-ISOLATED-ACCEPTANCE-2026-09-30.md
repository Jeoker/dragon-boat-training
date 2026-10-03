# C2.3 物理行诊断：c2test 0.16.2 正常态远端验收

日期：2026-09-30。范围仅为 `dragon-boat-training-api-c2-test`、独立 Google deployment／runtime Sheet、虚构赛季 `season_c2_isolated_2026`。原 staging、production、Pages 与真实 Google 业务文件未部署或写入。

- 部署前 [`live-c2-physical-diagnostics.mjs`](live-c2-physical-diagnostics.mjs) 的只读 preflight 证实 Worker `0.16.1-c2-associated-export`／schema v13、10 名虚构成员、四张关联 Google 表 1／1／20／1、outbox／batch／开放冲突零。C2.5 遗留 idle retry 行 `failure_count=0`／无待处理事件，按既定结论不是导出任务。新建私有 v13 备份，完整 manifest digest、44／44 chunks 与 descriptors 均校验；私有 reference 绑定本轮快照和隔离身份，当前 DO 再验相同 ID／digest。备份 API 写快照元数据／分块，不写业务行或 Google；未做恢复演练。
- 跟踪的 Wrangler 配置仅将 c2test `SERVICE_VERSION` 改为 `0.16.2-c2-physical-diagnostics`；原 staging／production 配置、c2test `C2_EXPORT_POLL_ENABLED=false` 和 `crons=[]` 保持。`cf:types`、`cf:check`、Cloudflare 21 文件／174 测试、Node 196 测试均 exit 0；Wrangler 对用户日志目录的 EPERM 是非阻断日志噪声。c2test dry-run 核对了目标 Worker 的 DO binding、backend instance、TEAM_ID、writer epoch 和全部开关。
- 仅执行 `npm run cf:deploy:c2test`，部署 URL `https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev/`，Worker version ID `89347442-be41-497d-b3e0-fe5c960d00b9`。health 回报 `0.16.2-c2-physical-diagnostics` 和正确后台实例；手动 `poll-due-exports` 实测 HTTP 409／`EXPORT_POLL_DISABLED`，无自动 cron。
- 真实 Coach 会话、**不带旧语义检查 flag** 的 `--phase=diagnose` 已通过。新 `check-associated-physical-differences` 对 `SIGNUP`、`SEAT_PLAN_DRAFT`、`SEAT_PLAN_CURRENT`、`SEAT_PLAN_REVISION` 全部返回 `OK`、完整覆盖、零 finding；`rows_read=baselines_checked` 依次为 1、21、20、1。四张 Google 表仍为 1／1／20／1，outbox／batch／开放冲突均零。相同私有备份在部署后的**当前隔离 DO** 再次 verify 通过。Coach 已退出。
- 部署后 overview 隐藏旧 idle retry 行；此只证明新读接口的过滤行为，**不表示 SQLite 中的历史行被自动删除**。本报告只记录最初不带 flag 的正常态验收；其后旧语义与单格 Google 漂移／CAS 恢复已经另行验收，见[漂移报告](C2-PHYSICAL-DRIFT-ISOLATED-ACCEPTANCE-2026-09-30.md)。生产切换、自动轮询和更广泛 C2.5 验收不由本报告证明。
