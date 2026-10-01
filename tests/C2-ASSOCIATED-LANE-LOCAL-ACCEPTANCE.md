# C2.5 不同训练关联事件独立推进：本地验收

日期：2026-09-30（America/New_York）。状态：本地 schema v14 实现及回归通过，尚未部署或进行新训练通道的真实 Google 验收。设计入口：[C2-ASSOCIATED-LANE-DESIGN.md](C2-ASSOCIATED-LANE-DESIGN.md)。远端专项门槛：[C2-ASSOCIATED-LANE-REMOTE-PLAN.md](C2-ASSOCIATED-LANE-REMOTE-PLAN.md)。

当前隔离 c2test 仍是 0.16.2／schema v13／writer epoch 0。本文的源码和模拟 SheetBridge 证据不能替代远端升级、真实 Google 冲突验收或私有备份恢复演练。未修改 Wrangler 版本、绑定、功能开关；验收执行时未部署或远端写入。默认 staging 配置仍为 0.16.0-c2-associated-export，导出与自动轮询开关均关闭。

## 实现范围

同季不同训练的完整 `SIGNUPS_CHANGED`／`SEATING_CHANGED` 可以分别推进。成员、排期、赛季、归档、未知处理器、无效／旧形状事件仍为全季顺序屏障。同训练最早 pending 无论未到期、局部阻塞或退避，都封住该训练后序事件。不同训练引用相同成员仍分别前检 B/G；成员冲突不能因训练不同而绕过。

schema v14 新增四个备份表：事件索引、局部阻塞、导出请求选择、outer poll 计划。旧 outbox 一次按迁移时 rowid 捕获固定顺序；以后按持久 event_sequence，不因恢复时 rowid 变化重排。业务 enqueue 与索引在同一事务写入；测试的直接 outbox 夹具必须显式构造索引，运行时不自动补建。

索引保存原 payload／topic exact text 及 `[outbox_id,sequence,season,kind,practice]` classification anchor；SQL json_array 精确验证未物化元数据。异步 SHA 使用现有实现，事务再次核对文本、绑定和选择。关联、成员、排期 direct API 首次 Google 前都持久锁定原请求目标，未知结果沿原事件／批次恢复。outer poll 先固定最多四季计划，completed 结果不可变重放；原目标不可运行而无旧完成结果时返回 `ORIGINAL_EVENT_UNAVAILABLE`，保留原错误状态，不改选新事件或写入全季 halt。

无未完成批次时，SQL 先证明全部 pending 的归属、文本和分类锚，以及当前绑定局部 block 的文本／practice。随后先取各 practice 的 MIN sequence，再筛 due／block／backoff，只选择最早全季 barrier 之前的首个合法 head。250 个同训练后继或 250 个独立阻塞 head 均不会遮住合法训练 B。只物化一个候选；原 payload 的单事件 UTF-8 上限为 2,000,000 bytes。全 pending SQL 扫描成本仍随总积压字符／行数增长，不是总 CPU 固定上限。

任意 `PREPARED`／`SENT`／`PARTIAL`／`FAILED` 批次优先沿固定源对账，核对其完整文本、固定序号及分类锚；其他尚未准备事件的归属损坏不会挡住原批次恢复。全季 `ACTION_REQUIRED` 与有效 backoff 先于 drain，需按现有 Coach clear／自然到期恢复；runtime pause 允许固定批次 drain，禁止准备新批次。

明确且可信的目标／引用漂移、合法物理 B 与 Google 的变化可局部阻塞。物理 B 缺失／损坏、归属未知、索引损坏、结构／平台错误仍全季停止或退避。局部 retry 只 rearm 指定 unchanged pending outbox；旧未传 outbox 的 global retry 不清除局部阻塞。成功只清本事件 block，全季 retry 仅在本次实际发送／最终核验成功且完整旧行指纹 CAS 相同时清理；其他请求期间新增失败及只读重放不被清除。

## 有效回归证据

| 门槛 | 已通过的本地场景 |
|---|---|
| 独立训练、同训练顺序 | A 明确冲突／零 Google 写入，B 完整确认，A 后继仍停止；相同 member 引用的 A/B 分别前检失败；Coach 精确 rearm A 后恢复原事件 |
| 共享版本与批次屏障 | member／schedule／unknown barrier；全季 halt 先于原 FAILED batch；runtime pause 只恢复原 operation；不同 handler 不接收另一个 handler 的批次 |
| Google 物理与最终核验 | audit-only 合法草稿漂移局部阻塞；损坏 physical B 全季拒绝；最终额外船位局部阻塞；B 成功不删 A block；原正式 revision cells 持续保存 |
| 请求未知、竞争与重放 | 同关联请求并发无裸 PK 异常；preflight 无批次也持久 pin；成员／排期第一次 Google 读失败、别人确认 A 后原 ID 零新写，新 ID 才可 B；跨季重用拒绝 |
| outer poll 恢复 | A 局部阻塞同 poll ID 不改选 B；outer 完成落库间隙后原计划恢复；原目标由另一请求完成、下一 handler 改变仍只读结束；有效全季 backoff 不升级为 halt |
| 成功清理与并发失败 | expired retry 自然 direct／poll 成功后归零；发送期间另起的 SERVICE_BUSY 全季失败保留；原已确认事件只读结束不清当前其他事件失败 |
| 完整候选发现 | 205 条／超过累计 2 MB 的积压中连续确认前三事件，仍剩 202 条 pending；250 A 后继＋B、250 独立 blocked heads＋B 均实际导出 B；future A head 不允许 due A 后继绕过；早／晚 barrier 保持顺序 |
| 损坏与预算 | 后部缺 index、未知 ownership、文本漂移、C0 sentinel 误用、kind／sequence／practice 单字段损坏、block 锚漂移均全局拒绝；ASCII／null／最大安全序号 JSON 编码一致；ASCII／中文 UTF-8 单事件超限拒绝；drain 源分类漂移拒绝 |
| 迁移、备份与诊断 | v13→v14 一次回填、真实 rowid 颠倒仍按固定 sequence；四表非空备份含 block／pin／poll plan／unfinished batch；概览不因坏 JSON 抛 SQL 异常；局部阻塞分页与 scoped retry |

主要入口：[c2-associated-export.test.ts](../cloudflare/test/c2-associated-export.test.ts)、[c2-member-export.test.ts](../cloudflare/test/c2-member-export.test.ts)、[c2-schedule-export.test.ts](../cloudflare/test/c2-schedule-export.test.ts)、[c2-export-operations.test.ts](../cloudflare/test/c2-export-operations.test.ts)。

## 最终检查

| 检查 | 结果 |
|---|---|
| `npm run cf:test` | 最后完整运行 21 files／225 tests，225 pass、0 fail，exit 0 |
| `npm test` | 210／210 pass、0 skipped、exit 0 |
| `npm run cf:check` | TypeScript 通过 |
| `npm run build`，`ASTRO_TELEMETRY_DISABLED=1` | 前端构建通过；0 errors／0 warnings；已有 fault overlay 未使用变量的 1 hint 不影响构建 |
| `npm run cf:dry-run` | 最终本地 Worker 打包通过，676.59 KiB，exit 0；没有部署 |
| `git diff --check` | 通过 |

两名独立 reviewer 已分别审查 selector／迁移／事务／备份，以及 Google／请求恢复／overview，关闭审查中提出的 P2。独立受控组 82／82 与四相关组 90／90、独立完整 CF 223／223 通过；其后仅新增 UTF-8 单事件预算及 drain 源锚两个边界测试，最终开发侧完整 CF 为 225／225。最终文档和新增两例由 reviewer 再次只读核对。

环境限制：Wrangler 试图写 AppData 日志产生 EPERM，检查仍 exit 0。完整 CF 在故障夹具运行期间记录五条内部错误日志，所有有效断言通过。此证据只支持上述本地实现，未增加任何生产或真实 Google 安全结论。
