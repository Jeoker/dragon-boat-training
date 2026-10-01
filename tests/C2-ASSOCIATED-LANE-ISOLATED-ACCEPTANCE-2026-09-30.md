# C2 独立训练通道 - 隔离验收

开始：2026-09-30；完成：2026-10-01，均按 America/New_York。**专用 `c2test` 已返回 `FINAL_CONFIRMED`，25个 journal 阶段全部完成。** 本文不是生产切换或 C2.5 全部完成的声明。

目标为 Worker `0.17.0-c2-associated-lanes`、schema14、writer epoch0。自动 polling 保持关闭，`crons=[]`；本轮只按明确阶段调用 exporter。生产、原 staging、旧训练和原 Form 来源不在新增业务写入范围。

## 已完成的真实阶段

| 阶段 | 已取得的证据 |
|---|---|
| 旧验收收尾与源恢复 | 旧候补 final 已完成。先前临时故障 overlay 已撤除；部署 clean 与原 HEAD clean 分别保留完整三文件、分别核验原摘要，私有当前源与原 HEAD 相等。同一原部署的恢复 metadata 已核验，未先将两套不同 clean 对齐。 |
| schema13→14 升级 | fresh 完整 v13 包与旧候补 final 包均保留并绑定摘要。旧业务、历史和已有 jobs 保留；fresh 前像记录一项正常 usage 指标刷新，迁移 capture 未再出现指标变化。指标是小时采样，不称为实时统计。 |
| 迁移完整性 | v14 capture 完整下载并核验 47 表；43 张旧表均在清单中，四张新表存在。42 张非 usage 表旧行保留，唯一升级元数据变化为 schema13→14；usage 的 before/after、键、时间和采样语义另行核验。33 个原 outbox 的 migration sequence 按原包 rowid 顺序固定，分类锚和原 payload 对齐。 |
| 新训练准入 | 使用未占用的新训练周；真实 `prepare` 按唯一 active 模板生成 A，再显式创建 B，最后开放该周。两训练均验证季内未来时间、赛季时区、容量10/10及截止时间；没有向旧周追加训练。 |
| 排期全季屏障 | `prepare`、`create-b`、`open` 三个真实排期事件按原顺序、自然 due 到期后导出。分别有3、3、4个批次，共10个，全部 `CONFIRMED`，三个事件均 `EVENT_CONFIRMED`；此时 pending outbox/batch 均为0。 |
| 两通道原始报名 | A1、B1 使用同一虚构成员，分别取得 signup version1 的固定事件及排队证据。未生成正式排座或修改旧 revision。 |
| A1 引用漂移 | 仅通过原签名 bridge 的 full-row CAS 改动 A 的 PRACTICE 单行，Google 回读和 receipt 核验。A1 自然到期后返回 `SYNC_REFERENCE_NEEDS_REVIEW`，持久局部 block；没有新 batch、cursor、逻辑或物理 B 变更，也没有执行 Google exporter patch。 |
| A2 顺序保护 | 业务继续产生 A2 version2，保留原 queue time/sequence。A2 原 due 自然到期、A1 原 block 仍有效时，明确请求 A2 返回 `SYNC_OUTBOX_BLOCKED`；没有创建新 selection/batch，A2 原 snapshot 仍 pending，Google 与 B/cursor 保持当时状态。 |
| B1 独立推进 | 在 A1 blocked、A2 pending 的同时，B1 已 `EVENT_CONFIRMED`。B cursor 为1/0/0，完整 batch receipt、独立事件投影和现场 Google 对账通过；A 的两个事件仍 pending，局部 block 可分页查询并与数据库证据对齐。 |
| A 原引用恢复 | full-row 反向 CAS 将 A 的 PRACTICE 原行精确恢复，原 receipt 和 Google 全表对账通过。恢复不自行消费 A1/A2；此阶段仍有两个 pending 事件。 |
| A1 Coach retry | 已对原 A1 事件执行 Coach retry，保留原 event、snapshot 与 preflight request；未用新业务请求重新报名，也未把 retry 当作已确认导出。 |
| A1 原事件确认 | 沿原 A1 固定事件恢复，完整 SIGNUP batch receipt、独立 snapshot 投影和现场 Google 对账通过，再取得 `EVENT_CONFIRMED`；A2 仍按原 snapshot 等待。 |
| B2 新业务 | B 的报名从 LEFT 改为 RIGHT，产生 signup version2 的固定事件，保留原 queue time/sequence；两训练当前业务均为 version2。 |
| 共享 MEMBER 引用漂移 | 仅以签名 full-row CAS 改动两训练共用的虚构 MEMBER 单行。A2、B2 各自原 due 自然到期后均返回 `SYNC_REFERENCE_NEEDS_REVIEW`，分别持久局部 block；两个事件仍 pending，批次数维持此前12个，无新 exporter patch 或 cursor 消费。 |
| 共享引用恢复与 retry | 反向 full-row CAS 精确恢复 MEMBER 原行并核验 receipt；分别对原 A2、B2 执行 Coach retry，不创建替代报名事件，不改原 snapshot、sequence 或 due。 |
| A2/B2 原事件确认 | 两事件分别沿原请求完成 SIGNUP batch 及事件确认，完整 receipt、snapshot 投影与现场 Google 全表对账通过；两 cursor 均为2/0/0。 |
| 最终核验 | `FINAL_CONFIRMED`：完整备份、旧行保护、七事件锚、管理 overview、分页 block、全部声明 scope 的语义及物理差异检查均通过；命令成功输出 `private_evidence_verified=true`、`coach_logged_out=true`。 |

排期屏障的10个批次包括返回 `EVENT_CONFIRMED` 的最后批次，不把这三次事件确认另外计作三个 Google 批次。

## 旧数据保护

基线为11名虚构成员；旧候补训练 cursor12/2/2，Google 关联行数分别为 SIGNUP11、DRAFT1、CURRENT20、REVISION2。旧正式 revision1/2、旧训练、成员、历史、请求结果、原 outbox/index、逻辑 B 与物理 B 均属于每个完成阶段的保护范围。

各阶段保留完整私有备份清单和块，核对已捕获旧行子集不变。逻辑 B 仅允许同步时间字段更新，原业务值、摘要、版本与映射仍须一致。Google 现场比较覆盖全部已声明 scope，新增行与人工漂移仅允许本次新训练和精确 CAS 目标；没有用只看新目标行的比较代替旧全表保护。

## 证据与独立复核边界

真实写入、签名 bridge 调用、Google 回读、receipt、管理 overview 和分页 block 检查由 supervisor 执行已审核的 [分阶段 runner](live-c2-associated-lane-acceptance.mjs)，沿 [执行计划](C2-ASSOCIATED-LANE-REMOTE-PLAN.md) 留下私有 journal。每个完成阶段均在完整事后证据通过后才标记完成；未知响应保留原请求，已知结果待审 checkpoint 未清除前不能发送下一步。

本次独立 reviewer **仅离线读取**已保存的私有材料：重新核验 manifest 总摘要、chunk 摘要/顺序/表名/offset/行数和完整覆盖；旧行、事件/index 锚、fresh 升级引用及指标记录；已确认 batch 的完整 receipt 与独立 snapshot 投影；三次局部 block、两类漂移及恢复 CAS receipt、自然 due 后的 probe 和 block 备份时间；两套 clean 文件及恢复部署 metadata。最终复核覆盖37份阶段证据下载及独立 final checkpoint，最终阶段包为47表、55块；未执行备份 restore。

离线核验不能重新证明复核时的 Google 现场状态，也没有另外调用网络或部署。现场 Google 一致性来自 runner 当次读取与完成阶段的证据；本文不将离线重算称为新的远端验收。私有身份、原行、摘要值及证据包名称不写入本报告。

## 最终聚合与范围

| 项目 | 最终结果 |
|---|---|
| 固定新增事件 | 7个，migration sequence34–40；3个 SCHEDULE_CHANGED、4个 SIGNUPS_CHANGED，全部 CONFIRMED，原 payload、分类锚和自然 due 保持 |
| 导出批次与调用 | 14个新增 batch 全部 CONFIRMED：排期10个、四个报名事件各1个。18次已记录 exporter 调用；四个报名事件各含一次 batch 确认及一次事件完成调用，不能把18次调用称作18个 Google batch |
| 新训练 cursor | A、B 各2/0/0；当前业务 version2 与 Google 最新报名一致，无新正式排座 |
| 旧训练保护 | 原 cursor12/2/2、正式 revision1/2、旧 history 和完整旧 Google 行保持；原请求、batch/index及基线保护通过 |
| Google 关联行 | SIGNUP13、DRAFT1、CURRENT20、REVISION2；其余 scope 为 COACH1、SEASON1、MEMBER11、SCHEDULE_TEMPLATE1、TRAINING_WEEK3、PRACTICE4 |
| 物理 B | 36行，较基线只增加两新训练报名行；原34行精确保留 |
| 最终待处理项 | pending outbox0、unfinished batch0、retry row0、local block0、OPEN conflict0；三条历史 SUPERSEDED conflict 保留 |
| 源与自动执行 | 原 clean 恢复证据有效；polling=false、crons=[]、epoch0，未开启自动轮询或更改生产／原 staging |

最终现场检查包含7类语义 scope 及4类关联物理 scope，均 `OK`、findings0、非 truncated；物理 coverage 为 complete。后续独立离线重算得到相同事件、receipt、投影和聚合数量，没有再次读取 Google。

本轮证明固定排期屏障、独立训练局部引用冲突、同训练后序保护、共享成员对两通道的阻断和原事件恢复在真实隔离 Google 链路成立。并发 SENT 暂停窗口属于另行本地真实调用链验收，不能混称本轮已做远端并发故障。年度归档仍在独立开发中；本轮不宣布 C2.5 全部完成、启用 polling/cron 或切换生产。
