# C2 关联故障现场的暂停及原批次排空验收

> 历史范围说明：下文“当前／待执行／未部署”指该切片形成时的状态。后续实际执行已完成，见[隔离实际验收](C2-WAITLIST-FAULT-PAUSE-ISOLATED-ACCEPTANCE-2026-09-30.md)；今天的部署状态见[CURRENT-STATUS](../CURRENT-STATUS.md)。本文不授权重新运行旧脚本，不替代实际验收报告。

> 2026-09-30。仅用于受审 fault-plan 指定的隔离取消事件首个 SIGNUP 批次。此文是执行计划，当前未执行远端暂停／排空验收。主 runner、fault inspector 的职责与 `RUNNING` 门槛保持不变。

## 1. 执行前提

先完成 [关联故障计划](C2-ASSOCIATED-FAULT-REMOTE-PLAN.md) 的 overlay 生成、独立字节审核、临时隔离部署、签名 probe 和首行故障。先用原 inspector 保存 `partial` 证据：两个 SIGNUP 第一行 target／第二行 expected、Google receipt `PARTIAL`、Worker 同批次 `FAILED`；原取消 outbox `PENDING`，全部事件级 B 及 11／1／1 游标不动，revision 1 全行不变。

仅 supervisor 操作远端。执行期间禁止主 runner、轮询、业务请求、其他导出及人工 Google 编辑。自动 polling 必须仍关闭且无 cron。缺失实际 `fault-plan.json` 时停止，不能按测试 fixture 或猜测 ID 执行。

helper 从 `cloudflare/.acceptance-artifacts/c2-waitlist-journal.json` 读取原 `journal.cancel.inflight`。runner 使用的第 10 个事件是 `[...journal.events, journal.cancel][10]`，不是持久 `journal.events[10]`。前十个报名事件均应已确认，取消 `export_calls` 必须为零，原 inflight 必须精确为 fault-plan 的首批 request／season，未发生后续座位／revision 写入。helper 校验 worker／service／team／season／binding／epoch／runtime Sheet／deployment 身份及取消 snapshot 摘要。

## 2. 两份私有 journal 与未知结果恢复

新 `c2-pause-drain-journal.json` 绑定完整 fault-plan 摘要及原 runner journal 摘要，首次受控调用前持久保存所有阶段的固定请求 ID。`drain` 唯一允许的导出 ID 是原 `<run_id>_export_10_0`；下一阶段拒绝探针使用独立固定 ID，不占用主 runner 的 `<run_id>_export_10_1`。

每次执行一个显式阶段，最多一个受控暂停／导出／拒绝探针调用。前后额外调用仅限 Coach 会话、overview、显式私有备份创建／验证／下载、签名双 receipt 及关联四表读取。helper 不开启轮询，不改 source pause，不创建新报名或取消，不修复 Google，不部署，也不恢复备份。

网络、JSON、身份或后续证据读取失败时立即停止，不在 `finally` 自动 resume。未知调用保留 attempted 阶段及原请求 ID；再次执行同一阶段，先核对现场，再重放同一 ID。pause／resume 回复未知允许分别核对已生效的 PAUSING／RUNNING；不因此跳到下一阶段。drain 回复未知而桥接已 VERIFIED 时，允许读取原批次已 CONFIRMED 的现场，但不能凭此给原 runner 填一个猜测结果；仍调用原 ID取已知 `BATCH_CONFIRMED`。

已知 drain 回复先保存在 pause journal，再原子更新主 runner 的 `cancel.export_calls` 恰一条并清其 inflight。更新前校验原文件未被他人改变；两文件间用预存目标摘要恢复 rename 前后中断，避免重复追加。其他业务字段和前十个事件必须保持原样。已知可重试错误不标阶段完成，保留同 ID；意外成功、业务／身份／证据不符一律停止并交 supervisor 检查。

## 3. 五个显式阶段

每个阶段均需显式 `--write-test-data --capture-private-backup`。下列命令中的阶段一次只选一个：

```powershell
node --env-file="D:\agents\dev-master\.c2-form-test\acceptance.env" tests/live-c2-associated-pause-drain.mjs --phase=pause --write-test-data --capture-private-backup
```

| 阶段 | 执行与验收 |
|---|---|
| `pause` | 先确认原 RUNNING／FAILED／PARTIAL 现场；固定 ID 调用 set-export-pause(true)，返回 PAUSING，overview 精确指向原未完成批次；没有新 batch／Google 写入／B 或 cursor 推进 |
| `early-resume` | 在 PAUSING 中用固定 ID请求 resume；必须 HTTP 409 `SYNC_EXPORT_DRAINING`；pause flag、原 batch／receipt 和所有旧基线不变 |
| `drain` | 仅发送主 journal 的原 inflight。必须原 batch `BATCH_CONFIRMED`；receipt VERIFIED、两行 SIGNUP target、无新 batch，仍一个原 PENDING outbox，B／11／1／1 cursor 不变；overview PAUSED；已知结果原子写回主 journal |
| `next-stage` | 在已排空且 PAUSED 中用独立固定请求尝试准备后续关联批次；必须 HTTP 409 `SYNC_EXPORT_PAUSED`；不产生新 batch、Google 操作、座位、revision 或 B／cursor 变化；探针不占用主 runner 下一编号 |
| `resume` | 必须之前四阶段均已独立确认、同批 CONFIRMED 且 PAUSED；固定 ID resume，返回 RUNNING；仍无新批次、原 B／cursor／outbox不变。未知 resume 保留阶段，重放同 ID核验，禁止盲目清 flag |

中间不能运行原 runner 或 inspector，因为它们正确要求 RUNNING。helper 保存每次 overview、完整私有备份、两 receipt 及四表证据；复用既有 fault evidence 校验未知 batch、首行进度、全部逻辑／物理 B、连续 cursor 与 revision 1。虚拟 recovered 视图只供读取验证原批次已确认，不用于更新原 journal。

当前已部署 overlay 在未来 revision receipt `MISSING` 时不返回 `once_consumed`。helper 接受这个已审核的真实形状，只证明未来 receipt 尚未出现，不把缺字段解释成 once marker 为 false；如显式返回 true 则拒绝。原 SIGNUP 故障／恢复 receipt 仍必须有 `once_consumed=true`。

## 4. 回到原故障验收

只有 `resume` 已确认后，运行原 inspector `--phase=recovered --capture-private-backup`，再继续原 runner 的 single-call 座位批次及 revision 故障流程。原 runner 此时 `cancel.export_calls.length=1`、`inflight=null`，下一正常 call 为原编号 1，未替换请求序列。原 revision 1 仍完全相同，revision 2 尚未写出。

然后按关联故障计划分别恢复原部署的完整 clean v14 和原 HEAD 的完整 clean 文件，核验两套各自 hash／deployment 身份并继续最终诊断。两套 clean 文件如 fixture 不同，不能声称全源相同，不能只恢复 Code.js。保留 once marker、receipt 和全部私有证据。

## 5. 本地与证据边界

`tests/c2-associated-pause-drain.test.mjs` 使用注入 I/O 的状态机，并运行真实的私有证据断言；覆盖五阶段、未知 pause／drain／resume、同 ID重放、已知 drain 结果的原子 journal 写入中断两侧、可重试错误、禁止阶段跳跃、意外 runner 改动、B／cursor／revision／未知 batch 拒绝。它不调用远端或替代真实 Google 验收。

本次只验证运行时暂停允许恢复一个既存 SIGNUP 批次，并禁止准备后续阶段；不证明 source pause、随机配额故障、自动 polling、schema v14 lane 独立推进或备份恢复。未取得全部实际证据前不能记为远端完成。
