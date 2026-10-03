# C2.5 ACTION_REQUIRED：隔离环境验收

日期：2026-09-30。测试目标仅为专用 `c2test` Worker、独立 Apps Script Web App、独立 Google 测试表和虚构赛季。正式 Pages、原 staging、生产 Worker 与生产 Google 文件均未参与。此报告记录真实远端执行结果；测试脚本为 [`live-c2-action-required.mjs`](live-c2-action-required.mjs)，分阶段运行，业务写入阶段需显式传 `--write-test-data`。每阶段使用隔离 Coach 登录，并在 `finally` 中退出。

## 前提与保护

- C2.4 已独立只读确认完成：Worker `0.16.1-c2-associated-export`、schema v13、关联 Google 四表行数 1／1／20／1，七个受支持的 B/C/G scope 零差异，outbox／batch／retry／conflict 均为空。
- C2.5 写入前重新创建并逐块校验、下载一份私有 schema v13 备份，共 41 块。备份未提交到仓库，也未做恢复演练。
- 原 [`wrangler.jsonc`](../cloudflare/wrangler.jsonc) 的 c2test、原 staging 和 production 导出轮询开关均为 `false`；c2test 与 production 的 cron 均为空。仅用 Git 忽略的临时 c2test 配置副本做 dry-run，再部署 `C2_EXPORT_POLL_ENABLED=true` 到 c2test。临时状态下仍**没有自动 cron**，只允许测试脚本手动轮询。没有修改跟踪的部署配置或其他环境。
- 所有请求锁定 c2test 域名、隔离 Worker 身份、writer epoch 0 和隔离 Google Web App 身份。Google 标记与恢复都是保存原整行后的精确整行 CAS；任何不一致均停止覆盖。

## 已核实的远端步骤

1. `preflight` 核对隔离身份、schema v13、七个 B/C/G scope 零差异、无积压、无 cron、Coach 已退出。临时开关部署后，空队列手动 poll 证实开关生效。
2. `enqueue` 对一名虚构成员执行一次**偏好不变**的 `update-member`。成员与名单版本推进，产生唯一待写回 outbox；偏好值不变，未改变训练报名、排座或排期。Google 原行被保存到 Git 忽略的私有状态文件。随后仅对该隔离成员 Google 行做精确 CAS 测试标记，复读确认整行与标记一致。此时 outbox 1、batch 0、conflict 0，Coach 已退出；自然到期时间为 `2026-09-30T21:04:24.403Z`。
3. 到期后 `verify-halt` 第一次手动 poll 返回 `ACTION_REQUIRED`／`SYNC_MEMBER_NEEDS_REVIEW`。overview 显示 `action_required=true`、`next_attempt_at=null`、outbox 1、batch 0；第二次 poll 返回 `polled=0`，证明该赛季停止继续尝试。复读 Google 测试标记未被写回覆盖，Coach 已退出。
4. `restore-google` 从精确标记行 CAS 恢复到原行，回执 verified，复读原行一致，`MEMBER` B/C/G 零差异。没有修改其他 Google 行。随后 `retry` 由隔离 Coach 调用 `retry-export`，返回 `rearmed=true`、前次错误 `SYNC_MEMBER_NEEDS_REVIEW`、`next_batch_requires_fresh_comparison=true`；Coach 再次退出。
5. 第一次 `drain` 返回 `BATCH_CONFIRMED`，outbox 仍为 1、batch 0、`action_required=false`，给出至少 60 秒后的下一尝试时间。到时再运行第二次 `drain`，返回 `EVENT_CONFIRMED`；确认步骤为 `[BATCH_CONFIRMED, EVENT_CONFIRMED]`。最终 outbox／batch 为 0，`MEMBER`／`SEASON` B/C/G 零差异，Coach 已退出。
6. `final` 验证七个受支持 scope（`SEASON`、`MEMBER`、`SCHEDULE_TEMPLATE`、`TRAINING_WEEK`、`PRACTICE`、`SIGNUP`、`SEAT_PLAN_DRAFT`）B/C/G 全部为 0。最终 Google 成员行与 Worker 新版本一致，除预期版本和更新时间外原有字段未被测试标记污染；成员版本恰好推进一次。outbox／batch／conflict 全空，Coach 已退出。最终只读复查发现 `sync_export_retries` 仍有一条成功轮询留下的调度记录：`failure_count=0`、`action_required=false`、`last_error=""`，`next_attempt_at` 保留历史时间；`next_due_at=null` 且无 outbox／batch，因而不会被调度。这是现有成功分支的持久状态语义，不能写成“retry 行全空”。
7. 立即用原跟踪配置**仅重部署 c2test**：`C2_EXPORT_POLL_ENABLED=false`，仍无 cron。独立脚本 [`live-c2-poll-disabled.mjs`](live-c2-poll-disabled.mjs) 远端核验 health 身份和版本，并确认手动 poll 返回 HTTP 409／`EXPORT_POLL_DISABLED`。最终 c2test Worker 仍为 `0.16.1-c2-associated-export`；原 staging、production 与 Pages 没有部署。

## 结论与边界

本次已在隔离环境真实验收：自然到期后的 Google 人工冲突使导出进入 `ACTION_REQUIRED`，重复轮询不会重试；精确恢复 Google 后，Coach 可显式重启并经新比较完成持久 outbox；最后导出轮询开关已恢复关闭。私有测试脚本的恢复路径另有本地测试 [`c2-action-required-recovery.test.mjs`](c2-action-required-recovery.test.mjs)，但本次远端没有人为制造响应丢失。备份已校验下载，尚未执行恢复演练。本报告不证明生产切换、原 staging、自动 cron、真实成员数据或长期 Google 配额表现。
