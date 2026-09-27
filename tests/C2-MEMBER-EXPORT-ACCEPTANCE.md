# C2.4 成员导出首个切片：本地验证

日期：2026-09-26。此记录是**本地代码与模拟 Google 桥接验收**，不是 C2.4 阶段通过，也不是远端 Google 写入证据。专用 `c2test` 仍运行 C2.3 只读版本；原 staging、生产 Apps Script、Pages 和真实文件均未切换或修改。

## 已实现边界

- 仅在非生产且 `C2_MEMBER_EXPORT_ENABLED=true` 时提供内部 `export-next-member`。它只选已到十分钟期限的 `MEMBERS_IMPORTED` 与 `updateMember` outbox，每次处理一个成员；同赛季更早的其他未处理事件会阻止越序写入。多人事件按成员目标留存确认进度；全部目标确认后才将原事件置为 `CONFIRMED`。尚无自动调用该入口的调度器。
- Worker 每个新目标重新读取整个登记 `Members` Tab，核对列头、唯一稳定 ID、当前绑定、Cloudflare 版本及该成员所有 B 依赖组。已有 Google 行须完整 B 且没有待导入／需核查的 Google 改动；无 B 且无 Google 行才允许新增。不使用 C2.3 截断的诊断响应作为写入计划。一个 Google 行内的独立人工改动目前保守地停止整行导出，待 C2.5 业务导入或人工解决后续接。
- 发送前 SQLite 保存固定 `batch_id`、源 outbox、捕获的成员版本、完整前值、目标值和摘要。Apps Script 再核绑定、Tab 身份、列头及每格前值；私有 `BridgeExportReceipts` 先记 `PREPARED`，每个目标写后 `flush` 并重读、记 `PARTIAL`，全部核验后保存 `VERIFIED` 回执。写入只改变需要更新的单元格；目标中以 `=` 开头的内容被拒绝，新增行使用文本格式，不让用户输入成为表格公式。丢失回执时同批次重试，不按最新网页状态重新规划。
- 回执重放通过 [Apps Script `TextFinder`](https://developers.google.com/apps-script/reference/spreadsheet/text-finder) 在批次 ID 列进行区分大小写的整格检索，只取命中的回执行，不把持续增长的九列回执表全部传到脚本内存；表仍须保留以供未知结果恢复。
- Worker 独立核对回执的团队、赛季、绑定、writer epoch、批次、摘要、文件／Tab 和已核成员集合；只有匹配才推进该批捕获版本的 B。后续网页变更仍由后续 outbox 承担。正式 Apps Script 和原 staging 配置没有启用此写入。

## 本地证据

Node 后端测试覆盖新增、精确单元格更新、同批重放、不同负载复用批次拒绝、手改冲突，以及两成员批次第一条已写而第二条失败后的同批恢复。Workers／DO 测试覆盖多人事件逐目标确认、Google 已写但响应丢失、已有成员 B/C/G 检查、人工改动拒绝、较早的其他事件阻止越序、并发重试的迟到回执不倒退较新基线、捕获版本基线和生产环境拒绝。`npm test` **191／191**、`npm run cf:test` **97／97**、`npm run cf:check`、前端／后端／C0 探针构建、Worker dry run 及 `git diff --check` 均通过；后端完整构建包含 `MemberPatchBridge.gs`，独立 C0 探针不包含它。Wrangler 模拟器在部分旧 alarm 故障注入用例打印内部异常，但测试套件退出码为 0。

## 未通过的阶段门槛

仍须在**明确识别的专用测试 Apps Script 项目和 `c2test` Worker**验收真实新增、重复批次、部分写入恢复、人工编辑冲突及退出前后的公开名单；本轮没有部署。当前仅成员行，尚无报名递补、训练、座位和归档的跨记录／跨 Tab 批次，没有十分钟自动调度与退避，没有 Coach 页面冲突处理或 Google 人工修改导入。Google 人工编辑不受脚本锁保护，写前检查和写后核验不能保证捕获极窄并发窗口；C2 完整验收和生产切换仍在后续阶段。
