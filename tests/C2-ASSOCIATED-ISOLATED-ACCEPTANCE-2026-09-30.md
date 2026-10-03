# C2.4 报名／排座关联写回：隔离环境验收

日期：2026-09-30。测试目标仅为 `dragon-boat-training-api-c2-test`、独立 Apps Script Web App、独立 system／runtime Google Sheet 和虚构赛季 `season_c2_isolated_2026`。正式 Pages、原 staging 与生产 Google 文件不在测试范围。测试入口为 [`live-c2-associated-acceptance.mjs`](live-c2-associated-acceptance.mjs)，业务写入必须显式传 `--write-test-data` 和单一 `--phase`；每阶段使用测试 Coach 登录并在 `finally` 中退出。

## 隔离与升级门槛

- 升级前只读确认 10 个虚构成员、97 组原有 B、零待处理 outbox／job／batch／冲突；`SEASON`、`MEMBER`、`SCHEDULE_TEMPLATE`、`TRAINING_WEEK`、`PRACTICE` 的 B/C/G 均零差异。用旧 Worker 创建并逐块验证下载私有备份，共 30 个分块；不提交快照。
- c2test 升级后 Worker 为 `0.16.0-c2-associated-export`、schema v13、binding 1、writer epoch 0。四个新关联 Google tab 的表头、tab ID、隔离 runtime Sheet ID 与 Apps Script deployment ID 都通过只读预检，起初均为 0 行。c2test 无 cron，自动导出保持关闭。
- 追加测试前再次创建并验证下载 schema v13 私有快照，30 个分块；Google 业务表未写入。私有备份下载不能视为已做恢复演练。

## 已核实的远端步骤

1. 14:48 UTC 在隔离赛季开放 2026-10-05 虚构测试周，仅公开一场左右容量各 10 的训练。唯一 `SCHEDULE_CHANGED` 于 14:58:25 UTC 自然到期；未提前改动 SQL 时间。最初排期写回在 Google 写入前因缺少测试 Coach 引用返回 `SYNC_REFERENCE_MISSING`，确认无 pending batch、Google 四张关联表仍为空。
2. 专用 Apps Script fixture 的 system Spreadsheet 与私有隔离身份记录逐一吻合。仅向**隔离项目 HEAD** 推送受限一次性 fixture 函数，未更新 Web App deployment；在已登录编辑器运行后，签名 bridge 确认唯一隔离 season 与唯一 `coach_c2_isolated_2026` 引用行。该行 inactive，空 code salt/digest，credential version 0；只用于跨表引用，不提供可用登录凭据。
3. 原排期事件到期后依序确认 `TRAINING_WEEK`、`PRACTICE` 与系统 `SEASON`，outbox／batch 均归零。隔离 Google 中 `TrainingWeeks`、`Practices` 各为 2 行（含先前测试周），本场各有一行；`SEASON`／`SCHEDULE_TEMPLATE`／`TRAINING_WEEK`／`PRACTICE` B/C/G 都为零差异，测试 Coach 已退出。
4. 20:02 UTC 左侧报名仅虚构 `C2 Test Member Alpha`，Worker signup version 1、状态 `CONFIRMED`，产生唯一 `SIGNUPS_CHANGED`，自然到期时间为 20:12:02 UTC。到期前脚本返回 `WAITING_FOR_DUE`、`calls=[]`，没有提前写 Google。
5. 到期后 1 个 `SIGNUP` 批次确认，随后事件确认；Google `SignupsCurrent` 唯一一行是 Alpha／LEFT／CONFIRMED，`SIGNUP` B/C/G 零差异。再次只读检查四张关联表行数依次为 1／0／0／0，outbox／未完成 batch／retry 都为零，排期确认人 Google 引用有效，Coach 已退出。
6. 20:14 UTC 保存完整 20 格船位草稿，版本 1，只有 Alpha 占 LEFT1，Coach／Steerer 角色为空。唯一 `SEATING_CHANGED` 自然到期时间为 20:24:10 UTC；保存后只读检查 Google 四表仍为 1／0／0／0，说明草稿尚未提前写 Google，Coach 已退出。
7. 20:24 UTC 首次执行 `export-draft` 在 Google 写入前返回 `SYNC_OUTBOX_INVALID`。随即只读确认 outbox 仍为 1、未完成 batch 为 0、无 retry，Google 四表仍 1／0／0／0。已验证私有 v13 审计快照证明根因：`saveSeatPlanDraft` 事件的 `entity` 未包含 `published_revision`，但内含完整 `seating_snapshot.state.published_revision=0`；解析器误把缺失的顶层字段当成必填。草稿本身有 20 格，首格 LEFT1 占用、末格 RIGHT10 为空。该时点**没有**确认座位事件；修复与恢复见第 8、9 步。
8. 修复事件生产端、通过 Cloudflare 163／163 测试和类型检查后，仅将 c2test Worker 热修为 `0.16.1-c2-associated-export`（Worker version ID `0c2fffa3-85d9-4864-b555-0e67fb003702`）；原 staging／生产和 Google Web App 未部署。部署前创建、校验并下载 schema v13 私有快照 37 个分块；部署后旧 `SEATING_CHANGED`、outbox 1／batch 0 和 Google 1／0／0／0 均保持原样。
9. 用**新的**固定请求 ID 恢复原不可变草稿事件：五个 `SEAT_PLAN_CURRENT` 批次写入 20 格、一个 `SEAT_PLAN_DRAFT` 批次写入状态，随后取得最终 `EVENT_CONFIRMED`。Google 本场精确 20 格（仅 Alpha LEFT1）和一条状态行；`SEAT_PLAN_DRAFT` B/C/G 读到 21 行，零差异。独立只读复查四表为 1／1／20／0，outbox／batch／retry 都为零，Coach 已退出。
10. 20:36 UTC 在隔离 Worker 发布正式座位 revision 1（仅 Alpha LEFT1，角色为空），产生唯一 `SEATING_CHANGED`，自然到期时间为 20:46:55 UTC。发布后只读复查 Google 四表仍 1／1／20／0，revision 表尚未提前写入；outbox 1、batch 0、retry 为空，Coach 已退出。
11. 20:46:59 UTC 确认自然到期后，原 revision 事件依序确认 `SEAT_PLAN_REVISION`、`SEAT_PLAN_DRAFT` 批次，再取得 `EVENT_CONFIRMED`。Google revision 唯一一行的 `seats_json` 仅含 Alpha LEFT1，草稿状态 `published_revision=1`；`SEAT_PLAN_DRAFT` 21 行 B/C/G 零差异，outbox 归零，Coach 已退出。独立只读复查 Worker `0.16.1-c2-associated-export`／schema v13、Google 四表 1／1／20／1、outbox／batch／retry 全空。最终只读验收进一步核对 `SEASON` 1、`MEMBER` 10、`SCHEDULE_TEMPLATE` 1、`TRAINING_WEEK` 2、`PRACTICE` 2、`SIGNUP` 1、`SEAT_PLAN_DRAFT` 21 行，所有 B/C/G 零差异；公开训练显示座位已发布，只有 Alpha 占座，Google revision 一行，冲突 0，Coach 再次退出。

## 验收边界

- 本报告已验收隔离 c2test 的排期、报名、草稿、正式 revision 关联写回和最终一致性；不能据此认定生产切换、自动轮询或原 staging 已完成。
- C2.5 的人工 Google 冲突、暂停／恢复、持久重试与恢复演练不在本报告已通过范围内。
