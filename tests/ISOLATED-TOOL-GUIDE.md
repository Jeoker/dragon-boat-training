# 隔离 Google 验收工具指南

本页维护现有工具的固定场景、兼容限制和原操作恢复规则。当前部署看[当前进度](../CURRENT-STATUS.md)，实际验证结果看[验证索引](CURRENT-VERIFICATION.md#google-同步)。工具已执行过的阶段不能视为可重新写入的空夹具；当前远端或源码不满足预检时，先适配工具并验证。

## 共同运行条件

- 只使用脚本固定的 c2test、虚构赛季、Google 测试项目、binding 和 epoch。部分脚本仍固定 schema13／0.16.x；旧 Apps Script deployment 编号、源摘要及 fixture 差异是兼容检查，不能当作当前版本或主动对齐两个基线。
- 从仓库根运行，凭据来自 Git 忽略的 `.c2-form-test/acceptance.env`；不用 Worker `.dev.vars` 代替。日志和 journal 位于 `cloudflare/.acceptance-artifacts/`，不打印凭据、私有 ID、整行或 assert expected／actual。
- 重读身份、当前队列、Google 完整行、版本和保护包；非预期 outbox、绑定变化、表结构异常或旧现场已推进时停止。自然等待原 due／next_attempt_at，不改时间、容量、SQL、原 revision 或审计来制造门槛。
- 每次明确指定一个 phase／step。写入按脚本要求带 `--write-test-data`，保护包阶段带 `--capture-private-backup`；故障取消导出带 `--max-calls=1`。不循环推进、不并发运行同季 runner。
- 请求前持久保存原 request／payload／snapshot／目标；未知回复保留原 inflight，用同一编号恢复。已知结果但证据未保存时先只读复核，成功后另一次显式运行才推进。
- Sheet 语义诊断可能保存诊断元数据；登录／退出也有会话写入，因此“没有业务或 Google 写入”不等于零存储写入。语义零差异不能代替四 scope 物理完整性。
- `BATCH_CONFIRMED` 只确认一批；最终事件核验才推进完整 B／cursor／outbox。恢复后分别检查完整投影、旧 revision、原数据保护、开关及会话退出。

运行格式：

```powershell
node --env-file=".c2-form-test/acceptance.env" tests/live-c2-associated-lane-acceptance.mjs --phase=preflight
```

该命令只是调用格式，不保证当前夹具可复用。准确参数、允许阶段、版本和错误条件由链接的脚本校验。

## 工具与场景

| 工具 | 固定场景和恢复规则 |
|---|---|
| [ACTION_REQUIRED](live-c2-action-required.mjs) | preflight → enqueue → mark-google → verify-halt → restore-google → retry → drain → final。受控同偏好成员修改仅推进一次版本；整行 CAS 加标记及恢复，未知 enqueue 用 recover-enqueue；完整恢复及差异核验后才 retry |
| [候补／递补](live-c2-waitlist-acceptance.mjs) | preflight／backup，enqueue step01–10，audit-queued，逐事件 export，cancel，audit-queued，取消 export，final。原十一名虚构成员及左右10／10容量；第十一人 LEFT 候补，取消 Alpha 后 Lambda 按原队列递补 |
| [关联故障生成器](build-c2-associated-fault-overlay.mjs) | 仅生成完整 overlay、两套 clean 和 fault-plan，不联网、不部署。源／fixture hash、完整文件集、取消 snapshot、精确请求／批次／items 全部匹配才生成，拒绝覆盖 |
| [关联故障 inspector](live-c2-associated-fault-inspect.mjs) | probe／partial／lost-reply／recovered，创建并读取显式保护包，检查两 receipt、四表、B／cursor／旧 revision；不推进导出、不修复行、不 retry |
| [原批暂停排空](live-c2-associated-pause-drain.mjs) | pause → early-resume → drain → next-stage → resume。只承接原候补取消事件的 SIGNUP 首批 FAILED／PARTIAL 现场；不作为远端 SENT 并发暂停工具 |
| [独立训练通道](live-c2-associated-lane-acceptance.mjs) | 两个新未来训练 A／B；A 行漂移形成局部 block，B 独立完成；恢复 A 后同序继续，再验证共享 MEMBER 漂移分别阻塞 A／B |
| [物理诊断](live-c2-physical-diagnostics.mjs)、[单格漂移](live-c2-physical-drift.mjs) | 四关联 scope 完整正常态，精确单格审计列 CAS 改动及原值恢复；语义可不变而物理 DRIFT，原整行 B 不推进 |
| [排期冲突](live-c2-schedule-conflict.mjs)、[故障](live-c2-schedule-fault.mjs) | 原排期事件、整行预值、固定批次和回执恢复；完整 source 及部署恢复后才最终对账 |
| [丢回复](live-c2-lost-reply.mjs)、[回执重放](live-c2-bridge-replay.mjs) | 已写入原目标的原批次恢复与 receipt 回读；不换 ID 或由当前业务值重算旧目标 |

候补工具不会自动创建 Lambda、提交 Form 或排空成员事件。缺第十一人时只能沿真实隔离 Form 来源导入并确认 MEMBER 后重新预检；不影子导入报名、复用身份或降低容量。已结束的原训练不能改日期恢复为可写场景。

ACTION_REQUIRED 工具的临时轮询开关只有在兼容预检、空队列和保护包成立后才显式启用；保持无 cron，结束后恢复关闭并核验。Google 原行恢复失败时保留现场，不 retry／导出。drain 遵守真实冷却期，`polled=0` 不意味着失败。

## 故障 overlay 与双 clean 恢复

1. 保存原 deployment 和原 HEAD 的完整源、manifest、身份及逐文件摘要。两者可能有已核验的 fixture 追加差异；分别保存，不能只备份 Code 或把 HEAD 覆盖成 deployment。生成器内固定 hash 必须实际匹配。
2. 生成器使用真实原取消 snapshot，按 scope 最多四行及9,500字符预算推导阶段／批次。固定形状为两行 SIGNUP、20格船位五批、revision、状态和事件确认；任何额外目标或不同调用序号都停止。
3. 逐字节检查实际 overlay、fault-plan、限定 hook 和只读 probe，再更新唯一隔离 deployment；保留原 clean version。工具本身不授权生产部署或增加公共权限。
4. SIGNUP 首行写入、PARTIAL flush 后只故障一次：第一行为 target、第二行为 expected，Google PARTIAL／Worker FAILED，事件 PENDING，B及11／1／1 cursor不动。
5. 原 single-call 恢复 SIGNUP 同批后逐座位批继续；revision VERIFIED flush 后只丢回复一次，Worker 同批 FAILED，revision2唯一、revision1全行不变。用原请求恢复，不能造 revision3。
6. 两处故障及恢复分别取证后，恢复原 HEAD 全部文件和原 deployment clean version。重新独立拉取，两侧各自对照原完整摘要；不清 once marker、不删除 receipt、不用旧备份覆盖新业务。
7. 临时 receipt action 应不再可用；保留已有证据，再继续状态批次和事件确认。最终核七个语义 scope、四个物理 scope、旧 revision、完整目标、B／cursor、队列、retry和会话退出。

这些故障证明受控注入窗口的恢复，不证明随机断网、Google 配额耗尽、全部人工竞态或自动 cron。

## 暂停与 journal 接续

pause helper 将原 fault-plan 和主 `c2-waitlist-journal.json` 固定到独立 `c2-pause-drain-journal.json`。它只发送主 journal 的原取消 inflight；拒绝探针用另一个固定 ID，不占用主 runner 下一序号。

原 FAILED／PARTIAL 批次存在时 pause 返回 PAUSING，提前 resume 必须拒绝；drain 恢复同批得到 BATCH_CONFIRMED 后才 PAUSED，事件级 B／cursor仍旧。PAUSED 中不能准备后续批次；五阶段完成且 resume 已确认后，原 inspector 和主 runner 才继续。

已知 drain 先保存 pause journal，再原子更新主 journal 恰一条 export_call并清 inflight；两文件间中断靠预存目标摘要恢复，不猜结果或重复追加。未知 pause／drain／resume 保留原 ID，失败不在 finally 自动 resume。

## 训练通道与完整最终证据

新周必须当前未占用，现有模板恰能生成预期 A，显式新建 B 后才确认；保留模板和旧周，不能假设空周、禁用模板或沿用过期候选日期。原排期事件全季屏障全部确认后才报名；A／B各自在新训练使用既有虚构 Alpha，LEFT→RIGHT生成第二事件，不碰旧报名／取消／revision。

A 的 PRACTICE location 单行 CAS 漂移只阻 A1；A2不能越过A1，B1可独立确认。原整行恢复及指定 outbox retry 后 A1完成；共同 MEMBER status 漂移应分别阻 A2／B2，恢复后各自按原请求推进。未知／已发送批次仍是全季 drain屏障。

每阶段核完整保护包、原 snapshot及sequence、两类 B、cursor、block分页及overview；数量不是完整列表。成功阶段保存 evidence_pending后证据读取失败，下次只复核该checkpoint，不发送新批。

最终保留全部旧业务／历史行、原cursor／revision和采样用量证据。小时usage快照按其captured_at解释，不称为实时值；新审计／请求追加与schema升级分开核验。确认本轮事件／批次、局部block／retry及OPEN conflict清空，七语义／四物理scope完整，polling=false、crons=[]、epoch0，会话退出成功后才记完成。

远端并发 SENT、source pause、全部实体独立推进、云端恢复和生产交接仍由[当前状态](../CURRENT-STATUS.md#现存技术债与未完成范围)维护，现有脚本不会替代这些门槛。
