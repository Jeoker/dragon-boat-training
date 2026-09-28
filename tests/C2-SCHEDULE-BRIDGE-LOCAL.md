# C2.4 排期 Sheet 桥接：本地传输切片

日期：2026-09-27。此切片只在本地增加签名桥接的排期表读写能力；未部署 Apps Script、Worker 或 Pages，未改真实 Google 文件。远端独立 `c2test` 仍停留在成员／赛季名单版本导出。

Google 桥接现在可只读检查登记赛季的 `ScheduleTemplates`、`TrainingWeeks` 和 `Practices`，缺表不会自动创建。三张表各有独立的受限补丁动作，复用成员／赛季已有的 `BridgeExportReceipts` 协议：每批同一张表最多四行，校验签名、赛季绑定、Spreadsheet 与 Tab ID、精确表头、稳定行 ID 和无公式单元格；单表扫描限制为 5,001 行／100,000 单元格／2,000,000 字符。已有行只写前值与目标值不同的单元格，新增行保留固定行 ID。每行写后重读验证并记录部分进度，整批成功才返回包含作用域及核验 ID 的 `VERIFIED` 回执。相同批次可在响应丢失或部分成功后重试；相同批次不同 payload、人工改动、错绑定或错 Tab 都会停止。补丁不触发业务管理接口，也不会修复缺失的表。

原有 C2.3 比较仍只覆盖 `SEASON`、`MEMBER`、`SIGNUP`、`PRACTICE` 和 `SEAT_PLAN_DRAFT`；新模板／周次读取作用域只是传输能力，不被假称已经拥有 B/C/G 语义比较、基线或 Google 修改导入。`c2-sheet-bridge` 明确区分完整传输作用域与已实现的语义比较作用域，避免新增读取类型意外进入 C2.3 判定。

本地测试覆盖三张表的读取、新增、最小更新、同批重放、错前值冲突、模板批次部分成功后恢复，以及错作用域、跨赛季目标、错 Tab 和缺表拒绝。验证：`npm test` 193／193、`npm run cf:test` 104／104、`npm run cf:check`、`npm run build:backend` 通过。Wrangler 在此 Windows 沙箱仍有日志目录 EPERM 与故障注入 alarm 文本，但测试退出码为 0。

下一步必须给模板和周次增加正式的同步实体、版本基线与迁移，再由 Worker 对前一切片固定的 `SCHEDULE_CHANGED` 源快照做 Google 目标投影、逐依赖顺序准备批次并调用本桥接。桥接的逐表 `VERIFIED` 不等于整条排期事件完成；只有模板、周次、训练的所有相关目标均核验并在 Cloudflare 同一事务推进基线和 outbox 后，才能确认事件。旧无快照事件不能据当前行补写。之后再进行独立 Google 文件的真实部分写入／回执丢失验收；生产写入归属保持 Apps Script／Sheets，切换属于 C4。
