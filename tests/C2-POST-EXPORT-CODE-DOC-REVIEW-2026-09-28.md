# C2.4 排期导出后代码与文档复核

日期：2026-09-28。范围是本地 C2.4 排期导出及其直接依赖的成员批次、Google 桥接、动作注册、接口契约和当前状态文档。**本轮没有连接或写入真实 Google Sheet，没有部署 Worker／Apps Script／Pages。**

## 修正

- 排期导出器原有三处重复的 Sheet 表头、赛季归属、稳定 ID 和重复行检查；现在统一由 `readScheduleRows` 执行，准备目标、核对模板／周次引用和整事件收尾使用同一规则。移除未使用的 outbox `sequence` 查询与类型字段。C2 动作注册移除无状态的复制别名，只保留 `C2_SYNC_ACTIONS`；运行时和契约测试均引用同一个对象。
- 项目总览删除已经过时的 C2.2 待验收快照，改为链接唯一进度入口。后端说明和接口契约区分“源码支持八种签名只读范围／本地排期写回”与“独立 Google 文件只验收过五类原有 Sheet 范围和成员／名单版本写回”。迁移计划移除过时的“排期 Worker 写回仍不存在”；当前进度澄清排期事件之外的赛季版本变化仍待设计。

## 代码与声明核对

| 声明 | 源码与测试证据 | 当前边界 |
|---|---|---|
| 排期行按模板→周次→训练导出 | `c2-schedule-export.ts` 的事件排序、单行批次和 DO 集成测试 | 仅本地模拟桥接；尚未真实跨表写回 |
| 同批次重试、最后确认赛季版本 | 持久 `sync_batches`／`sync_batch_items`、签名回执校验、`SYSTEM_VERSION` B 与 outbox 同一 SQLite 事务 | Google 多 Tab 仍非原子事务；真实排期丢回执待验收 |
| 人工 Sheet 修改不被无声覆盖 | 投影与引用 B/C/G 校验、前值补丁、事件结束前再读已确认行 | 极窄并发编辑窗口及 Google 配额耗尽尚无实证 |
| Coach 只读桥接不传凭据摘要 | `SheetBridge.gs` 先核完整 `Coaches` 表头，再只返回 `coach_id`；后端测试校验响应只有一列 | 该新增范围尚未部署和真实验收 |
| 生产未切换 | `wrangler.jsonc` 的排期导出开关在 staging、c2test、production 均为 false，生产 C2 路由隐藏测试通过 | 不能把当前本地源码版本当作远端运行版本 |

当前未将成员与排期的赛季版本收尾强行抽成一个通用流程：两者捕获的版本、前置目标及允许确认条件不同，共用批次状态和回执骨架即可。下一阶段仍先在独立 `c2test` 验收 schema v10、Coach ID 只读和跨表排期写回，再评估同表多行合并与报名／排座导出。

本轮验证：`npm test` 193／193、`npm run cf:test` 131／131、`npm run cf:check`、`npm run build`、`npm run build:backend`、`npm run build:bridge-probe`、`npm run cf:dry-run` 与 `git diff --check` 均通过。Wrangler 的外部日志目录权限提示及既有 alarm 故障注入文本不改变上述进程退出码；这些本地结果不算远端验收。
