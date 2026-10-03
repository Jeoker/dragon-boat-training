# C2.4 排期写回：独立环境验收

日期：2026-09-29。仅使用 `dragon-boat-training-api-c2-test`、独立 Apps Script Web App 和虚构赛季 `season_c2_isolated_2026`。没有连接正式 Pages、原 staging 或生产 Google 文件。此记录区分已完成的远端步骤与仍待测试的故障边界。

## 升级前门槛

- `live-c2-readiness.mjs --read-isolated-state` 确认旧 Worker `0.12.0-c2-season-export`／schema v9：10 名测试成员、65 组基线、零冲突、零未完成批次、零待导出事件，Google `Seasons`／`Members` 差异为零。
- 新的 [`live-c2-schedule-preflight.mjs`](live-c2-schedule-preflight.mjs) 只读检查独立 Google 桥接：`ScheduleTemplates`、`TrainingWeeks`、`Practices` 三张表均存在，表头及赛季范围正确，起初均为空。它要求固定测试主机、显式参数和私有测试凭据，输出不含文件 ID 或密钥。
- 在升级前用同一脚本的 `--capture-isolated-backup` 创建、服务端验证并下载 schema v9 的 23 个备份分块到 Git 忽略的 `cloudflare/.acceptance-artifacts`。分块摘要逐一重算通过；快照仅供私有恢复，不提交仓库。
- 使用隔离项目的 `clasp pull --versionNumber 12` 只读核对已部署 Google Web App 源码，确认三种排期补丁处理器存在。拉取结果保存在 Git 忽略目录，未修改 Google 脚本。

## 已完成的远端步骤

1. 将本地 `0.14.0-c2-operations` 部署到专用 `c2test`，完成 schema v9→v11 原地升级。升级后再次检查仍有 10 名成员、65 组基线和零冲突／零积压；Google `Seasons`／`Members` 保持零差异，三张排期表仍为空。
2. 仅在 `c2test` 启用**显式调用**的排期导出入口；该环境无 cron，`C2_EXPORT_POLL_ENABLED=false`，原 staging 与生产的排期和自动导出开关继续关闭。重新生成 Worker 类型，Node 193／193、Workers／DO 135／135 和 Cloudflare 类型检查通过。
3. 在独立 DO 建立一条虚构周三模板，产生十分钟后到期的 `SCHEDULE_CHANGED` 事件。到期后按原事件先核验 Google 模板行，再核验系统 `Seasons.season_version=3`；每一步复用同一请求 ID 重放均返回原结果。事件确认后待处理 outbox／批次为零，`SEASON` 与 `SCHEDULE_TEMPLATE` B/C/G 均无差异，十名成员的公开名单摘要不变，测试 Coach 会话已退出。
4. 为 2026-10-05 测试周生成一条私有周草稿和一场虚构训练。事件到期后按 `TrainingWeeks`→`Practices`→系统 `Seasons` 的次序取得三份独立回执；每步同编号重放结果一致，最后待处理 outbox／批次均为零。`SEASON`、`SCHEDULE_TEMPLATE`、`TRAINING_WEEK`、`PRACTICE` B/C/G 全部零差异；三张 Google 排期表各有一条本季行，测试周仍未公开，十名成员名单摘要不变，Coach 会话已退出。
5. 写回后再保存并校验 schema v11 私有快照，共 27 个分块，逐块摘要通过并下载到 Git 忽略目录。原 staging、生产 Pages、正式 Google 文件和原 Apps Script 写入归属均未更改。

## 尚不能据此宣布完成的范围

本轮证明了一个模板事件及一个周次／训练事件的真实跨表顺序、确认回执、同请求重放和完成后的 B/C/G 一致性。排期故障注入下的部分写入、Google 已写后丢回执、人工同时修改、配额耗尽和多行 payload 合并尚未做远端验收。模板与周次的新记录也不等于报名／排座导出完成；C2.4 整体门槛和 C2.5 的暂停、恢复、同季独立冲突继续保持未通过。
