# C2.5 隔离远端故障验收方案（执行前版本）

本文保留执行前的安全方案；实际执行结果以[隔离远端验收报告](C2-ACTION-REQUIRED-ISOLATED-ACCEPTANCE-2026-09-30.md)为准。仅使用专用 `c2test` Worker、独立 Google Apps Script／Sheet 和虚构成员；生产与原 staging 保持不变。脚本为 [`live-c2-action-required.mjs`](live-c2-action-required.mjs)。

前提：C2.4 的报名／排座关联验收已完成，专用环境为 Worker `0.16.1-c2-associated-export`／schema v13、Google 桥接已升级，绑定仍为隔离赛季和独立文件，待处理 outbox、未完成批次、开放冲突均为零。先取得并验证私有备份。运行 `preflight` 检查七个受差异 API 支持的范围；`SEAT_PLAN_CURRENT` 和 `SEAT_PLAN_REVISION` 不属于该 API 的实体类型，须沿 C2.4 验收的直接 Google 行核验检查，不可误称九类 B/C/G 均由该 API 检查。

只有上述检查通过后，临时在 **c2test 环境**开启 `C2_EXPORT_POLL_ENABLED=true` 并部署；`triggers.crons=[]` 保持不变，生产和原 staging 的轮询标志始终为 `false`。随后按顺序运行以下阶段，每一阶段结束后确认 JSON 结果和隔离身份。除 `preflight` 外均需 `--write-test-data`：

1. `preflight`：不改业务行；检查隔离身份、空队列、零差异和静态无 cron 配置。
2. `enqueue`：先以 `poll-due-exports` 空队列试探确认临时开关生效，再为一名虚构队员提交一次**偏好不变**的 `update-member`。这会推进该队员和名单版本并产生一条约十分钟后到期的导出事件；不会改变偏好、报名、座位或训练计划。脚本先把原 Google 行及恢复目标保存在忽略的私有状态文件中。若响应在写入后丢失，仅用 `recover-enqueue` 根据原请求 ID 和队员版本恢复；不得重新造一条不同请求。
3. `mark-google`：通过签名桥接及整行 CAS，仅把独立 Google Members 中该队员的 `display_name_override` 改成带运行 ID 的临时标记。状态在调用前写为 `MARK_PENDING`，即使回执丢失也可用只读行检查和固定操作 ID 续做或恢复。
4. 等待单条 outbox 确实到期后运行 `verify-halt`：手动轮询必须返回 `SYNC_MEMBER_NEEDS_REVIEW`／`ACTION_REQUIRED`，重试状态 `action_required=true`、`next_attempt_at=null`，第二次轮询为零，outbox 仍在、未生成目标批次、Google 标记未被覆盖。
5. `restore-google`：以保存的完整原行作目标、当前标记行作前值，进行整行 CAS 恢复并复读核验。若 Google 行不是预期标记或 CAS 失败，**立即停止，不调用 `retry-export` 或任何导出**；保留本地状态和停轮询记录，关闭临时轮询开关，人工审查该行与备份。不得使用无条件覆盖。
6. `retry`：仅在 Google 原行已完全恢复、成员差异为零且仍为 `ACTION_REQUIRED` 时，用真实 Coach 会话调用 `retry-export`，检查结果要求重新读取比较。
7. `drain`：每次手动轮询最多推进一阶段；成功批次后轮询器会设置约 60 秒下次尝试时间。按返回的 `next_attempt_at` 在下一次独立调用继续，直至 `EVENT_CONFIRMED`，不得把冷却期 `polled=0` 当作失败或强行绕过退避。若远端已 `EVENT_CONFIRMED` 但本地阶段文件在记录前中断，可重新运行同一阶段：只有确认零待处理事件／批次／冲突、整行 Google 成员数据与预期版本、Cloudflare 名单版本及 MEMBER／SEASON 零差异后，才把本地状态恢复到 `DRAINED`，不再发送新的轮询。
8. `final`：确认零 outbox／未完成批次／开放冲突、Google 队员其余列不变、版本恰好增加一次、七个受支持范围零差异，Coach 会话已退出。随后将 **c2test** 轮询开关恢复 `false` 并部署核验；无 cron 的配置保持不变。

运行格式（每次仅一个阶段；先由操作者确认 C2.4 已清空）：

```powershell
node --env-file=D:\agents\dev-master\.c2-form-test\acceptance.env tests/live-c2-action-required.mjs --phase=preflight
node --env-file=D:\agents\dev-master\.c2-form-test\acceptance.env tests/live-c2-action-required.mjs --phase=enqueue --write-test-data
```

此测试证明的是受控的 Google 行冲突造成的永久错误停止及恢复，不证明真实配额耗尽、随机断网、自动 cron、备份恢复、暂停中旧批次排空或同季独立实体绕开冲突。任何阶段出现未预期身份、版本、队列、Google 行或错误码，停止后保存证据；不要靠重复请求推进。
