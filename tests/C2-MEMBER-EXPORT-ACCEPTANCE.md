# C2.4 成员导出首个切片：隔离验收

日期：2026-09-26。**成员导出切片已在专用 `c2test` Worker 和独立 Google 测试文件完成真实写入验收；C2.4 整体尚未通过。** 原 staging、生产 Apps Script、Pages 及其正式文件没有切换或启用这条写入路径。当前隔离 Worker 服务为 `0.11.0-c2-member-export`／schema v9，最后部署版本为 `7a06fe9d-dde0-4edd-9755-7d9bc416ed7e`；独立 Google Web App 为 v9。这些版本只描述隔离环境，不是生产版本。

## 已实现边界

- 仅在非生产且 `C2_MEMBER_EXPORT_ENABLED=true` 时提供内部 `export-next-member`。它只选已到十分钟期限的 `MEMBERS_IMPORTED` 与 `updateMember` outbox，每次处理一个成员；同赛季更早的其他未处理事件会阻止越序写入。多人事件按成员目标留存确认进度；全部目标确认后才将原事件置为 `CONFIRMED`。尚无自动调用该入口的调度器。
- Worker 每个新目标重新读取整个登记 `Members` Tab，核对列头、唯一稳定 ID、当前绑定、Cloudflare 版本及该成员所有 B 依赖组。已有 Google 行须完整 B 且没有待导入／需核查的 Google 改动；无 B 且无 Google 行才允许新增。不使用 C2.3 截断的诊断响应作为写入计划。一个 Google 行内的独立人工改动目前保守地停止整行导出，待后续 Google 修改导入或人工解决接续。
- 发送前 SQLite 保存固定 `batch_id`、源 outbox、捕获的成员版本、完整前值、目标值和摘要。Apps Script 再核绑定、Tab 身份、列头及每格前值；私有 `BridgeExportReceipts` 先记 `PREPARED`，每个目标写后 `flush` 并重读、记 `PARTIAL`，全部核验后保存 `VERIFIED` 回执。写入只改变需要更新的单元格；目标中以 `=` 开头的内容被拒绝，新增行使用文本格式。丢失回执时同批次重试，不按最新网页状态重新规划。
- 回执重放通过 [Apps Script `TextFinder`](https://developers.google.com/apps-script/reference/spreadsheet/text-finder) 在批次 ID 列进行区分大小写的整格检索，只取命中的回执行。Worker 严格核对回执后才推进该批捕获版本的 B；后续网页变更仍由后续 outbox 承担。同一 `request_id` 的完成结果持久保存；重复请求返回原结果，不能顺手导出下一名。`IDLE` 结果也按相同规则重放。

## 本地与真实隔离证据

Node 后端测试覆盖新增、精确单元格更新、同批重放、不同负载复用批次拒绝、手改冲突，以及两成员批次部分写入后的同批恢复。Workers／DO 测试覆盖多人事件逐目标确认、Google 已写但响应丢失、相同请求重放、已有成员 B/C/G 检查、人工改动拒绝、越序阻止、迟到回执不倒退较新基线、捕获版本基线和生产环境拒绝。`npm test` **191／191**、`npm run cf:test` **97／97**、`npm run cf:check`、前端／后端／C0 探针构建和 Worker dry run 均通过；最终复验以本次提交的命令结果为准。Wrangler 模拟器在部分旧 alarm 故障注入用例打印内部异常，但测试套件退出码为 0。

真实隔离测试明确传入 `--write-test-data`，只指向专用 `c2test` 主机。两次各导出一名测试队员，独立 Google `Members` 从 0 行增至 2 行；第二次用同一 `request_id` 重放，返回同一批次，行数仍为 2，未导出下一名。两次均核对 Cloudflare 名单摘要未变、该成员 B/C/G 已清，并确认测试 Coach 退出。部署最终重试修复后，五类只读复验再次通过：`SEASON` 1 行、`MEMBER` 2 行、其他三类 0 行；成员诊断仍有 7 项、该类别开放冲突为 0。这不等于 7 个队员已被写回，也不代表所有待同步 outbox 已处理。

首次部署独立 Google 项目时，误用仓库通用 `appsscript.json` 覆盖了该测试 Web App 原有的 `webapp` 设置，v8 的签名读取返回 404。随即从独立测试项目备份恢复原 `webapp.executeAs=USER_DEPLOYING`／`access=ANYONE_ANONYMOUS` manifest，重新推送并将**同一独立 Web App**部署为 v9；之后签名读取和写入均通过。原生产脚本未操作。五类只读检查曾有一次瞬时 `BRIDGE_UNAVAILABLE`，直连签名读取随后稳定，重试全套检查通过；尚不能据此证明长期负载或配额稳定性。

## 未通过的阶段门槛

真实人工编辑冲突、真实部分写入和真实响应丢失尚未故障注入；目前只有本地模拟覆盖。当前仅成员行，尚无赛季、报名递补、训练和座位的关联／跨 Tab 批次，因此 C2.4 不能通过。十分钟自动调度与失败退避、暂停／恢复和 Coach 页面冲突处理属于后续 C2.5 运维切片；Google 人工修改导入也未实现。年度归档导出属于 C2.6。Google 人工编辑不受脚本锁保护，写前检查和写后核验不能保证捕获极窄并发窗口；C2 完整验收和生产切换仍在后续阶段。
