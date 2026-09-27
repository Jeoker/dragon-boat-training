# C2.4 赛季行补丁：本地桥接切片

日期：2026-09-27。此切片**仅在本地 Apps Script 模拟运行时通过**；尚无 Cloudflare 导出调用方，也没有部署到独立 Google Web App、原 staging 或生产。当前远端 `c2test` 仍只具备上次已验收的成员导出版本；不得把本文件视为赛季同步通过。

`cloudflarePatchSeasonSheet` 与既有成员补丁共用 `BoundRowPatchBridge.gs` 的签名、锁、私有 `BridgeExportReceipts`、前值核查、逐格补丁和写后复核。赛季补丁只作用于**已存在**的系统 `Seasons` 行；它保留 Form、运行 Spreadsheet、回答 Tab、字段映射、触发器、归档等 Google 绑定／运营列，只允许更新名称、日期、时区、赛季状态、业务版本和更新时间。绑定版本、运行文件和 Tab ID 必须与当前登记身份吻合；无匹配行、重复行、手工改动或不同负载复用批次均停止。已记录 `VERIFIED` 的批次在重放时仍重读目标行，防止 Google 在回执生成后被人工改动却让 Cloudflare 误推进基线；相同保护也应用于成员补丁。

本地测试覆盖合法业务字段补丁、绑定列保持、重复批次、伪造绑定改写、人工改动冲突，以及旧 `VERIFIED` 回执后目标行再被修改时拒绝重放。既有成员补丁测试继续通过。完整 Node 套件 192／192、Cloudflare 套件 97／97；本轮没有任何真实 Google 写入。

下一步必须先解决导出事件与依赖目标的闭环：`createSeason` 事件在绑定前创建，Google 赛季行由既有管理流程建立；成员导入或修改还会推进赛季 `roster_version`，不能只确认成员行就声称整个事件同步。需要在 Cloudflare 批次中同时规划并核验相应赛季版本；已存在 Google 行但缺少完整 B 的情况也不能静默采纳。之后再做独立 Google 文件验收。报名、训练和座位的关联批次仍未实现，C2.4 未通过。
