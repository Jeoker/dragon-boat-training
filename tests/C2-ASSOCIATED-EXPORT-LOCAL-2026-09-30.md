# C2.4 报名与排座关联导出：本地实现及隔离预检

日期：2026-09-30。此记录区分源码实现、专用 `c2test` 部署／只读预检和待完成的真实写入验收。生产 Apps Script／Sheets、原 staging 和 GitHub Pages 均未切换。

## 实现边界

`SIGNUPS_CHANGED` schema 2 和 `SEATING_CHANGED` schema 1 的不可变 outbox 快照是导出唯一业务目标来源。导出器按每场训练的报名、排座和正式 revision 版本游标处理，先检查训练／成员引用，再将目标投影到 `SignupsCurrent`、`SeatPlanCurrent`、`SeatPlanRevisions` 与 `SeatPlanState`。同一 Tab 最多四行；Worker 还按签名 payload 实际长度拆批。桥接保存 `PREPARED`／`PARTIAL`／`VERIFIED` 回执；失败或响应丢失后用原 batch ID、原前值和原目标继续，不以新的 Cloudflare 当前行重算。

每个已有 Google 行要与已确认的完整物理行 B 一致，报名 `updated_at`／`last_request_id`、排座 `updated_by`／`updated_at` 等非逻辑 B 列也参与核对。已有行缺整行 B、缺训练或成员引用、意外额外船位、版本断层和旧无完整快照事件都不能发新补丁。最后重读全部目标及完整草稿船位，才在一笔 SQLite 事务内推进逻辑 B、物理行 B、逐场游标和 outbox。Google 多 Tab 写入期间并非原子，事件必须保持待处理。

本地回归文件为 `cloudflare/test/c2-associated-export.test.ts`、`cloudflare/test/c2-associated-projection.test.ts`、`cloudflare/test/c2-associated-bridge.test.ts` 和 `tests/c2-associated-patch-bridge.test.mjs`。它们覆盖连续报名版本、人工改动审计列、不可变 revision、首个船位批次部分写入后丢回执、额外船位拒绝、四行拆批、旧快照／版本缺口及最终确认顺序。早先独立执行前三个 Workers 文件 **20／20** 和桥接 Node 文件 **1／1** 通过；后续热修前 Cloudflare 全套 **163／163** 与类型检查通过。代码审查发现过事件解析拒绝同一人兼任 Coach 与 Steerer 的问题，已修复并补本地回归；角色可兼任，但不能同时占桨位。旧草稿事件缺顶层 `published_revision` 的专门兼容亦有回归，不放宽其他旧事件。Wrangler 曾打印沙箱日志目录 `EPERM`，相关测试进程退出码仍为 0。测试与本轮隔离连贯写回均不等于真实配额或关联部分写入远端故障验收。

## 隔离部署与未完成验收

专用 `c2test` 初次部署 Worker `0.16.0-c2-associated-export`／schema v13，隔离 Apps Script version 14。**开放测试周之前**检查 10 名虚构成员、97 组既有基线、零开放冲突及待处理批次／outbox／作业、五类旧 scope B/C/G 零差异；关联四表起初均为空。私有 v13 备份 30 分块已校验下载。`2026-10-05` 测试周的缺失 Coach 引用经隔离 HEAD fixture 受控补齐、签名核对，排期事件依序确认。虚构 Alpha 左侧报名自然到期后一个 `SIGNUP` 批次和事件均确认。20 格草稿首次导出因旧 `saveSeatPlanDraft` 事件缺顶层 `published_revision` 而在写前被拒，队列与 Google 未变；源码随后让新事件写入此字段，并严格兼容已排队旧草稿的完整捕获状态。热修前 37 分块 v13 备份经校验下载，专用 Worker 升至 `0.16.1-c2-associated-export` 后队列与 Google 仍不变。原草稿事件用新请求 ID 恢复：五个 `SEAT_PLAN_CURRENT` 批次写入 20 格，一个 `SEAT_PLAN_DRAFT` 批次写入状态，随后 `EVENT_CONFIRMED`。正式 revision 1 在自然到期后也经 revision、状态两个批次及最终事件确认。最终独立只读复查四表 1／1／20／1，七个受支持 scope B/C/G 零差异，outbox／batch／retry／冲突均零，Coach 已退出。**C2.4 核心四表隔离连贯验收通过**；证据细节见[隔离验收记录](C2-ASSOCIATED-ISOLATED-ACCEPTANCE-2026-09-30.md)。

下一道远端门槛是候补递补、关联部分写入／丢回执故障、Google 人工改动、同季独立冲突与 C2.5 运维。任何人工改动或故障都要按批次检查 B/C/G 与 outbox，不能只凭 HTTP 成功宣布通过。`C2_EXPORT_POLL_ENABLED=false` 且 `c2test` 无 cron，正式环境也没有开启自动轮询。已有 Google 行若缺整行物理 B，只能经受控 bootstrap 核对，不能自动把当前 G 设成旧 B。C2.4／C2.5 整体阶段门槛尚未通过。

审查另留两项诊断债务：只改 Google 关联行审计列时，C2.3 语义差异页可能仍显示零，虽然 C2.4 物理整行 B 会阻止下次不安全导出；历史 `SeatPlanRevisions` 物理 B 尚未持续巡检。两者都不是本轮隔离 Alpha 报名写回的失败，后续需分别完善可见诊断与历史巡检，不能宣称已修复。
