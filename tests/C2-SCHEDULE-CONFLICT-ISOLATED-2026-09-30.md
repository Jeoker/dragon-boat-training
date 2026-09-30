# C2.4 排期冲突：独立 Google 验收

后续同日的[排期故障隔离验收](C2-SCHEDULE-FAULT-ISOLATED-2026-09-30.md)已补足本记录当时未覆盖的受控远端部分写入与丢回执；以下保留本次冲突实验的阶段性证据。

日期：2026-09-30。仅使用 `dragon-boat-training-api-c2-test`、独立 Apps Script Web App、独立 Google 测试文件及虚构赛季 `season_c2_isolated_2026`；没有改动原 staging、正式 Pages 或正式 Google 文件。自动导出仍关闭，本轮每步均为显式调用。

## 执行和证据

1. 写入前只读核对 Worker `0.14.0-c2-operations`／schema v11：10 名虚构成员、84 组基线、零开放冲突、零未完成批次／outbox，Google `SEASON`／`MEMBER` 零差异。三张排期表分别有 1／1／1 行。创建、服务端校验并私有下载了 29 分块备份；备份文件在 Git 忽略目录中。
2. 经两轮独立只读安全审查后，使用新增的 [`live-c2-schedule-conflict.mjs`](live-c2-schedule-conflict.mjs) 建立 2026-10-12 的一周私有草稿与一场虚构训练。十分钟 outbox 到期后，先将 `TRAINING_WEEK` 行写到独立 Google 文件；确认该周 B/C/G 零差异。
3. 脚本以独立测试密钥对 Google 桥接签名，直接把已确认模板的 `location` 临时改为测试标记。脚本要求预期的测试 Worker 主机、测试 Spreadsheet ID、从 Worker 读取的模板 ID、原单元格值及准确 Tab／表头。**这是绕过 Worker 的 out-of-band 测试修改，不是由人在 Google UI 中编辑。**
4. 下一次训练行导出返回 `SYNC_REFERENCE_NEEDS_REVIEW`，没有准备新批次，原 outbox 仍待确认；Sheet 差异检查检测到模板变化。使用新的签名操作恢复原值后，差异归零，开放冲突清零。最后按原事件导出 `PRACTICE` 和 `SEASON` 回执，`SEASON`、`SCHEDULE_TEMPLATE`、`TRAINING_WEEK`、`PRACTICE` 四个范围 B/C/G 均为零，未完成批次和 outbox 均为零。
5. 收尾只读复核显示 97 组基线、10 名测试成员、Google 三张排期表分别 1／2／2 行、公开训练数为 0。再次创建、校验并私有下载 schema v11 的 29 分块备份。每阶段 Coach 测试会话均已退出。

本地补充测试：Apps Script fixture 注入“单行写到第一个单元格后抛错”，重试原 batch 完成整行且回执从 `PREPARED` 到 `VERIFIED`；Workers／DO mock 在首个 Google patch 前返回可重试 `SERVICE_BUSY`，确认 batch `FAILED`、outbox 待处理、无提前基线，再用同一请求和 batch 完成跨表事件。`npm test` 193／193，`npm run cf:test` 136／136，`npm run cf:check`、`npm run build`、两个后端构建及 `npm run cf:dry-run` 通过。Wrangler 日志目录出现 EPERM 文本，但相关命令退出码为 0。两组本地故障测试经独立 sub-agent 审查，未发现阻断问题。

## 本次实验尚未覆盖

远端排期单元格部分写入、Google 已写但回执丢失、真实 Google 配额耗尽，以及 Worker 多行合并均**未**验收；`SERVICE_BUSY` 只是本地模拟的配额类响应。Out-of-band 桥接修改虽验证了同一 Sheet 差异和阻断路径，不等于管理员手动编辑 UI 的完整流程。报名／排座关联写回、C2.5 远端暂停恢复和同季独立冲突进展均未完成。C2.4 阶段门槛、C2.5 阶段门槛及生产切换仍未通过。
