# C2.5 v12 隔离升级与可逆运维验收

日期：2026-09-30。仅操作专用 `c2test` Worker／Durable Object、独立 Google 测试文件和虚构赛季；原 staging、正式 Pages／Apps Script／Google 文件未切换。测试没有开启自动导出、创建报名或向 Google 写业务行。

## 升级与结果

1. 升级前核对登录的是预期 Cloudflare 账号，目标配置为独立 `dragon-boat-training-api-c2-test`、`pentasus-c2-test`、无 cron，`C2_EXPORT_POLL_ENABLED=false`。远端原为 Worker `0.14.0-c2-operations`／schema v11。97 组基线、10 名虚构队员、零待处理作业／outbox／批次／开放冲突；运行时导出状态 `RUNNING`、无重试记录。三张排期表各为 1／2／2 行且训练仍为私有草稿。创建、服务端验证并私有下载 29 分块 v11 备份。**v11 备份不含运行时暂停与重试表**，但本次升级前两者均为空／默认状态；不能将旧备份视为任意 v11 运维状态的完整回滚点。
2. 精确执行 `npm run cf:deploy:c2test`，部署输出核对目标 Worker、团队、导出开关仍为 false 及专用 URL。远端变为 `0.15.0-c2-export-action-required`／schema v12。v11→v12 迁移只为 `sync_export_retries` 增加默认 0 的停止位；旧 Worker 不支持新 schema，不能直接以旧版本回滚。
3. 升级后再次核对 97 组基线、10 名队员、零积压／冲突、1／2／2 排期表和公开训练 0。创建、验证并私有下载 29 分块 v12 备份；脚本断言备份 manifest 包含 `sync_export_controls` 与 `sync_export_retries`。无须恢复这份备份，因此**备份恢复尚未实测**。
4. 真实 Coach 会话对同一隔离赛季暂停导出，概览显示 `PAUSED`；相同请求 ID 重放返回相同结果。无效会话被拒绝；没有停止故障时调用 `retry-export` 被 409 `SYNC_EXPORT_ACTION_NOT_REQUIRED` 拒绝。恢复后状态为 `RUNNING`、无重试记录，测试会话退出。可复现脚本见 [`live-c2-export-controls.mjs`](live-c2-export-controls.mjs)；它在异常时分别尝试恢复和退出，不接触 Google 写入。
5. 最终重读五类 `SEASON`、`MEMBER`、`SCHEDULE_TEMPLATE`、`TRAINING_WEEK`、`PRACTICE`，各自 B/C/G 差异为零；零开放冲突、批次、outbox 与待处理作业。第一次加做五类检查时，一个请求超过原 20 秒超时，脚本中止且没有计作通过；提高到每请求 45 秒并输出检查阶段后重跑，五类均通过。排期预检脚本见 [`live-c2-schedule-preflight.mjs`](live-c2-schedule-preflight.mjs)。

部署与可逆验收脚本在执行前均由独立 sub-agent 只读审查；清理路径的一处异常分支问题先修复后才进行远端操作。本地 Node 193／193、Workers／DO 141／141、类型检查、构建及 dry-run 已通过；Wrangler 在受限沙箱中打印的日志目录 `EPERM` 不影响测试退出码。

## 尚未通过的门槛

本报告只验证了当时无故障的暂停／恢复和不必要重试拒绝。后续已在 Worker `0.16.1`／schema v13 的专用环境真实验收受控 Google 行冲突造成的 `ACTION_REQUIRED`、停轮询、整行 CAS 恢复和 Coach 显式重试，见[后续故障验收](C2-ACTION-REQUIRED-ISOLATED-ACCEPTANCE-2026-09-30.md)。暂停期间已发送批次排空、真实配额耗尽／随机断网、自动 cron、备份恢复和同季独立实体绕开冲突仍未远端验收。生产切换及 C2.5 整体阶段门槛未通过。
