# C2.4 排期字段与目标投影：本地切片

后续 Worker 批次接入与本地集成结果见[排期导出记录](C2-SCHEDULE-EXPORT-LOCAL-2026-09-28.md)；本页“尚未接入”仅描述当时这一纯投影切片。

日期：2026-09-28。只更改本地源代码和测试；没有部署 Worker、Apps Script 或 Pages，也没有向 Google 排期表写入数据。独立 `c2test` 仍运行上一切片的 schema v9／成员导出，正式生产仍由 Apps Script 写入。

`Practices` 真正保存的是 `cancelled_at`、`cancelled_by`、`schedule_published_at`、`schedule_published_by` 等原始列，没有 `signup_version`。旧 B/C/G 映射中的派生 `cancelled` 和 `signup_version` 已移除；模板、周次及训练的全部 Google 表头列现均有明确的同步字段定义。受保护只读比较直接使用训练 SQLite 原始行。旧字段格式、缺依赖组的 B 产生复核诊断；纯目标投影则拒绝继续，不能将旧 B 当成已确认的新格式。

新增纯函数 `projectSchedulePatch` 将事务内捕获的单条模板、周次或训练快照转为 Google 显示值：布尔值使用 `TRUE`／`FALSE`，可空时间和版本使用空单元格，时间归一为 ISO，稳定身份及版本必须有效。已有 Google 行需要同一绑定下完整、字段格式一致且版本不超前的 B；按依赖组比较 B/C/G，人工编辑、冲突、缺行或公式风险均在准备批次前拒绝。新行仅在 Google 不存在且没有 B 时可新增。测试覆盖三表全部字段、可空值、人工修改、旧 B、行被删除、身份伪造及公式输入。

本切片**尚未把纯函数接入导出入口**，也没有实现按模板→周次→训练的持久批次或跨表事件确认。下一切片需核验赛季、周次、模板和教练引用，按实际 JSON 字符长度限制每个 Google 请求，保存前值／目标／摘要并复用原批次恢复；最后补丁该事件捕获的 `Seasons.season_version`，仅在所有逐表回执及赛季版本得到核验后确认 outbox。旧排期事件若无完整源快照不得根据当前 SQLite 行猜测；已存在的旧格式 B 需另行核验重建，不能自动迁移。

验证：Cloudflare Workers／DO 测试 128／128、TypeScript 检查通过。Wrangler 本机日志目录 EPERM 和已有故障注入 alarm 文本仍会打印，但测试命令退出码为 0。
