# C2.4 排期 Worker 导出：本地集成切片

日期：2026-09-28。本切片未部署 Worker、Apps Script 或 Pages；`c2test` 仍为上一版 Worker／schema v9、Google 独立 Web App v12。新排期入口在原 staging、`c2test` 与生产的部署配置均关闭，不能将本地模拟当成真实 Google 验收。

已将[排期字段与目标投影](C2-SCHEDULE-PROJECTION-LOCAL-2026-09-28.md)接入独立的 `export-next-schedule`。入口只选同赛季最早且已到期的 `SCHEDULE_CHANGED` outbox，拒绝没有完整事务快照的旧事件，其他 topic 或未完成批次不能越序。每次调用只准备并发送一行，依模板→周次→训练排序；批次的绑定、前值、目标、摘要和 writer epoch 先持久化，再调用现有签名桥接。Google 私有回执对同一批次的重试可识别已写目标，严格核验后才推进该行 B；直到所有行的回执均确认，原 outbox 一直保持待处理。各表引用需已有完整确认 B，相关 Coach ID 同时存在于本地与 Google；Coach 只读桥接仅返回 ID，不传凭据摘要。

逐行确认后，Worker 再次读取三张 Google 排期表，核对本事件每一行仍等于已确认目标，并要求 Cloudflare 没有未同步的赛季业务字段变化。最后对系统 `Seasons` 的既有行单独补丁该事件捕获的 `season_version`；只有赛季回执、赛季 `SYSTEM_VERSION` B 和 outbox 在同一 SQLite 事务一起确认。Google 的跨表写入**并非原子事务**：失败时保留已确认行和待处理事件，按原批次继续，不重新由当前业务行生成旧事件的目标。

Durable Object 集成测试覆盖三张排期表加赛季行、首次 Google 写入后丢回执并用原批次恢复、引用模板被人工修改、已确认训练行在整事件收尾前被修改、Cloudflare 有另一个未同步赛季名称，以及旧无快照事件在接触 Google 前拒绝。后端测试验证受签名保护的 Coach ID 投影及排期表桥接。接口清单、错误码、Wrangler 版本与生成类型同步更新。

本地验证：项目测试 `npm test` 193／193、Worker／DO 测试 `npm run cf:test` 131／131；`npm run cf:check`、`npm run build`、`npm run build:backend`、`npm run build:bridge-probe` 和 `npm run cf:dry-run` 均通过。上述结果只证明本地规则和模拟桥接，不证明远端部署或真实 Sheet 行写入。

当前每批仅一行，受 9,500 字符 payload 预算约束，符合桥接最多四行限制，但对多场训练不是最省 Google 往返的最终优化。下一步先将 schema v10、只读 Coach ID 桥接和入口部署到**独立**测试环境，在虚构赛季真实核验跨表写入、部分进度、丢回执、人工修改与恢复，再根据实际延迟决定同表多行合并。生产 Apps Script／Sheets 写入归属和 Pages API 均未改变；C2.4 整体仍未通过。
