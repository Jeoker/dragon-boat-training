# C2 候补、关联故障及暂停排空隔离验收

日期：2026-09-30（America/New_York；远端记录跨至 2026-10-01 UTC）。本报告记录实际执行结果。只使用专用 `c2test`、独立私有 Form／Sheets 和虚构成员；生产、原 staging 及 Pages 未变更。

## 运行基线与执行入口

- Worker 始终为 `0.16.2-c2-physical-diagnostics`、schema v13、binding 1、writer epoch 0。
- 隔离 Apps Script 原 deployment 为 version 14；受控故障期间同一 deployment 临时使用 version 15，随后恢复 version 14。
- 自动导出始终关闭、cron 为空；所有业务与导出由 supervisor 串行执行。
- 原 HEAD 比部署 v14 多一个仅供编辑器显式运行的隔离辅助函数。两套完整源分别保存、分别恢复，不能描述为全源相同。

执行工具及门槛见[候补计划](C2-WAITLIST-REMOTE-PLAN.md)、[关联故障计划](C2-ASSOCIATED-FAULT-REMOTE-PLAN.md)及[暂停排空计划](C2-ASSOCIATED-PAUSE-DRAIN-REMOTE-PLAN.md)。生成器、实际 overlay 和暂停工具均由另一 agent 独立审核；相关本地工具测试 16／16 通过。

## 真实来源、侧向候补及不可变事件

1. 在唯一隔离 Form 提交一次虚构 `C2 Test Member Lambda`，页面确认记录已提交；截图保留在忽略目录。通过真实 Form 导入得到唯一新成员，原十名成员的稳定身份和原 Google 行保持不变。
2. 按原 member／season 导出路径确认十一人名册，队列归零后开始报名验收。
3. 保留 Alpha 的原 LEFT1 正式 revision 1。九名其他成员报名 LEFT 后左侧十人确认，Lambda 作为第十一人进入 LEFT 候补。右侧仍有空位，此场景证明侧向容量候补，不能称为全船二十人已满。
4. 十个报名事件的 snapshot 在导出前由私有 DO 备份捕获，版本严格为 2 至 11；等待各自十分钟自然到期后逐事件确认，Google 每次均与该事件的不可变目标逐单元格一致。未修改到期时间，未以最新状态替换旧事件。
5. 用唯一持久请求取消 Alpha：业务版本变为 signup 12／seat plan 2／published revision 2，Lambda 递补且原 `queue_at`／`queue_sequence` 保留。公开结果十人确认、零候补，系统 revision 2 仅将 Lambda 放入 LEFT1。原 revision 1 的完整行始终不变。

## 首行中断及暂停恢复

首个取消 SIGNUP 批次仅在精确 team／season／binding／epoch／Script／runtime Sheet／request／batch／items 匹配时注入故障。第一条完整行写入并核验、`PARTIAL` receipt flush 后触发一次可重试中断。

独立 inspector 实际证明：首行等于 target、第二行仍等于 expected；Google receipt 为 `PARTIAL`，Worker 原批次为 `FAILED`，原 outbox 为 `PENDING`；全部事件级逻辑／物理 B、11／1／1 游标及旧 revision 1 保持原样。

随后五个显式阶段均通过，每次最多一个受控调用：

| 阶段 | 实际结果 |
|---|---|
| pause | `PAUSING`，仍指向原 FAILED 批次，无新 Google 写入 |
| early-resume | HTTP 409／`SYNC_EXPORT_DRAINING`，暂停和原现场不变 |
| drain | 仅原请求恢复同批；receipt `VERIFIED`、batch `CONFIRMED`，随后 `PAUSED` |
| next-stage | HTTP 409／`SYNC_EXPORT_PAUSED`，未准备下一批 |
| resume | 显式回到 `RUNNING`，原事件仍待处理，旧 B／游标不变 |

drain 的已知回复持久写入两份私有 journal，原 runner 恰增加一条 batch 确认。恢复 RUNNING 后，原只读 inspector 再次独立确认同批 `CONFIRMED`／receipt `VERIFIED`、零未完成批次及旧基线保留。

本次证明既存 FAILED 部分写入批次的暂停排空；未验证暂停与一个正在发送的 `SENT` 请求同时发生的极窄并发窗口。

## 回执已提交后丢回复

五个船位批次依序确认，实际批次前缀与事前从取消 snapshot 推导的八批计划一致。revision 2 批次已创建唯一 Google 行、提交并 flush `VERIFIED` receipt 后，精确故障路径只返回一次空正文。

独立证据证明 Google revision 2 恰一行、receipt `VERIFIED`，而 Worker 同批为 `FAILED`；状态行仍旧，原事件／全部 B／11／1／1 游标未提前确认。使用 journal 原 inflight 恢复后，同批 `CONFIRMED`，revision 2 仍唯一，不出现 revision 3。旧 revision 1 的所有列保持不变。

这是受控空回复，不能称为真实随机断网、配额耗尽或未受控平台故障。

## 完整清理与最终对账

故障及恢复分别取证后，完整原 HEAD 三文件推回同 Script，原 deployment 恢复 v14。另行重新拉取 HEAD 和部署 v14 的全部文件，逐逻辑文件核对各自保存的 SHA-256；两侧 Code 均恢复 `2004DF4D80B0FA2B24AB3674A28D899B8E2F0892EC067B01707C9346C1C349F0` 的原始业务构建。其他 deployment 版本未变。一次标记和历史 receipt 保留，未恢复旧 DO 快照。

在 clean v14 上确认剩余状态批次及整个事件。最终 `FINAL_CONFIRMED`：

- Google 关联四表行数为 **11／1／20／2**；报名版本 12、草稿版本 2、正式 revision 2，十人确认、零候补，Lambda LEFT1。
- 七个语义 scope 零差异；四个物理 scope 完整覆盖且零差异。
- 原 revision 1 全行不变，本轮十一条 outbox 全部确认且原 snapshot 不变；逐场游标为 **12／2／2**。
- 关联物理 B **34** 行与 Google 单元格精确一致；待处理 outbox、未完成 batch、retry、开放冲突均为零。历史三条 `SUPERSEDED` 冲突保留，不描述为冲突表为空。
- 最终私有备份下载并校验通过，会话退出成功；**只验证备份，没有执行恢复**。

原始 Form 证据、私有 journal、完整 Google 行、各阶段 DO 备份、签名 receipt、deployment 元数据及两套完整源码均保留在忽略目录，不进入 Git。

此切片通过候补真实写回、受控部分写入／丢回复和 FAILED 批次暂停排空。它不替代真实配额／随机断网、自动 cron、备份恢复、同季独立训练远端验收、C2.6 年度导出或生产切换；C2.4／C2.5 的整体状态仍按权威迁移计划逐项判断。
