# C2.3 Sheet 读取与差异验收

日期：2026-09-26。**C2.3 在独立 Google 测试文件及专用 `c2test` Worker 上通过；正式 Pages、生产 Apps Script 和原 staging 未切换。** 此阶段只读 Google Sheet、比较 B/C/G 并保存需处理的诊断。没有自动导入 Google 修改、写回 Sheet、消费业务 outbox 或处理冲突的页面。本记录不包含私有文件 ID、凭据或 Coach Code。

## 环境与真实验收

- 初次验收的独立 Apps Script 测试 Web App 为 v6，注册 `cloudflareReadSheetRecords`，按当前赛季绑定只读五种固定范围。专用 `c2test` Worker 为 `0.10.0-c2-sheet-inspection`、schema v9、`writer_epoch=0`、无 cron；初次验收 Worker version 为 `9397c7b2-06c9-4000-9e50-c4fa85e2003b`。原 staging 仍为 C2.2／schema v8，未获取本轮 C2.3 代码；生产仍由 Apps Script／Sheets 持有写入权。
- Coach 真实登录后经签名桥接读到系统 `Seasons` 一行，以及独立响应文件的 `Members`、`SignupsCurrent`、`Practices`、`SeatPlanState` 和附属 `SeatPlanCurrent`。当前测试环境后四种业务范围为空；Cloudflare 里此前导入的九名 Form 成员尚未导出到 Google `Members`，因此成员检查返回九个 `EXPORT` 候选，**不能当作九次 Google 人工编辑或已经完成同步**。五类检查的 Cloudflare 名单摘要前后相同，最后退出。
- 在隔离 `Seasons` 为赛季名称建立一条确认 B 基线，使用一次性、仅用于该独立测试项目的签名夹具把 Google 名称改为测试值。检查返回 `REVIEW_REQUIRED`，同时给出 B、C、G；Cloudflare 名称保持原值。恢复 Google 名称后再次检查，该名称差异消失。临时修改路径不是正式 API，验收后从 Apps Script 测试 Web App 删除；再次调用返回 `UNSUPPORTED_ACTION`，正式五类只读检查仍通过。
- 最终 schema v9 部署后，五类真实读取及每类重复检查再次通过；相同现场 `conflict_records.created=0`、`superseded=0`，Coach 概览报告 schema v9。测试环境有一条由不完整 B 基线引起的开放诊断；九名待导出成员不会变成冲突。受控测试时误加到隔离系统文件的示例 `Sheet1` 已在严格核对内容后移除；赛季名称已恢复。

## 代码与本地证据

- Apps Script 桥接只取登记 Tab 的原始显示单元格、行号和数字 Tab ID；不调用会补建缺失 Tab 的读写助手。初次验收版本每个 Tab 上限 5000 数据行、50 列；超界或缺 Tab 返回错误。Worker 再验证团队、赛季、绑定版本、Spreadsheet 身份、签名请求回声、列头和行结构，绑定在网络读取期间变化则拒绝入库。
- 比较器按稳定 ID 对齐，不依赖行顺序。删行、重复／改 ID、跨季行、未知／变序列头和坏座位结构保留现场并停止不安全的比较；报名状态和左右偏好在同一依赖组，Coach／Steerer／船位在同一草稿依赖组。源字段和版本单元格的人工改动被拒绝；缺少 B 基线不会猜测导入。
- schema v9 扩展 `sync_conflicts`，保存分类、原因、行号、B/C/G、Cloudflare 版本和内容指纹。提交前在同一事务重核绑定、基线和业务快照，期间有变更则拒绝过时检查。`CONFLICT`、`REVIEW_REQUIRED`、`REJECTED` 幂等入库；完整复查后不再存在的诊断标为 `SUPERSEDED`，旧绑定诊断也在绑定升级时过时。返回最多 100 条诊断并报告总数；截断或结构损坏不会清除未能复核的其他记录。没有变化且没有待过时诊断时，不作诊断写入。诊断动作不驱动其他业务维护任务。
- 本轮 `npm test` **190／190**、`npm run cf:test` **90／90**、`npm run cf:check`、`npm run build:backend` 通过。专项测试涵盖独立字段变更、关联冲突、排序、缺／改／重复 ID、未知列、源与版本保护、座位结构、Coach 权限、诊断幂等和清除，以及有旧冲突行的 schema v8→v9 原地升级。Wrangler 在受限 Windows 环境报告写 AppData 日志的 `EPERM`，但测试进程退出码为 0。

## 尚未覆盖与下一步

真实 Google 测试只对赛季名称做过受控修改；报名和排座冲突、排序／删行／坏列、schema v8→v9 的旧数据保留由本地 Workers／DO 测试覆盖，尚不能宣称有真实非空 Google 端到端证据。桥接当前读取显示值；Google 日期格式或区域设置若与约定 ISO 值不一致，会作为需要核查的映射值，而不是自动导入。每次检查一次读取完整登记 Tab，适合当前小团队规模；大表分页和配额压力未实证。

C2.4 应先依据当前 B/C/G 和开放诊断决定哪些字段可安全导出，建立有界写入批次、写前重读、部分成功恢复、写后核验及不可变回执；只有 Google 确认后才能推进对应基线和 `PENDING` outbox。C2.5 再提供冲突分页、Coach 决策和暂停／恢复。C2.6 才验收年度文件及整个 Google 同步链，C4 前不得把任何隔离结果当成生产切换许可。

## 后续代码审查与本地修正（2026-09-26）

审查 C2.3 的桥接、身份对齐和诊断生命周期后，修正了三个可复现边界。Google 行的报名复合 ID 改为逐项验证 `practice_id`／`member_id`，座位行也验证场次和非空队员 ID，规则与 C1 的 8–128 位业务 ID 一致；含额外冒号或句点的 ID 现在触发结构核查，不会被当作新业务行。结构损坏时不再把任何旧诊断置为 `SUPERSEDED`，仅在完整且未截断的复查后清理；使用集合查重，避免诊断数增加时逐条线性搜索。

只读桥接现在除每 Tab 的 5000 数据行／50 列上限外，对一次检查的主附两表合计限制为 100,000 个单元格、2,000,000 个字符，单格不得超过 10,000 字符；Apps Script 在返回前检查，Worker 再独立验证。此限制是保守的当前规模保护，超过时返回错误，不做不完整的业务比较。回归覆盖非法复合 ID、非法座位队员 ID、结构损坏期间保留原冲突，以及单格和总负载超限。

修正后 `npm test` **190／190**、`npm run cf:test` **91／91**、`npm run cf:check`、前端及 Apps Script 构建、桥接探针构建、Worker dry run 和 `git diff --check` 通过。Wrangler 的本机日志 `EPERM` 未影响测试退出码。

已把同一构建推送到**独立** Apps Script 测试 Web App v7，并更新专用 `c2test` Worker version `631907b5-32b3-4313-bf0e-ff631d40cfc2`，服务版本与 schema 仍分别为 `0.10.0-c2-sheet-inspection` 和 v9。真实 Coach 登录后，五类登记 Sheet 均成功只读检查并逐一重复检查；重复时新增／过时诊断均为 0。赛季表读到 1 行、成员表当前 0 行，其他三类业务范围也是空表；Cloudflare 已导入的九名成员仍仅为待导出候选。最后成功退出，前后公开名单摘要一致。**实际测试数据未触发超限或非法 ID；这些拒绝路径由本地测试证明，不能称为真实 Google 异常验收。** 原 staging、正式 Pages、生产 Apps Script 和 Google 文件均未更新。
