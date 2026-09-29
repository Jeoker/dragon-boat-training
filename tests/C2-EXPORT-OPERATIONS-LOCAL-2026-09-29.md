# C2.5 导出运维本地切片

日期：2026-09-29。此记录只覆盖当前源码的本地 Worker／Durable Object 行为。没有部署 schema v11、没有启用远端十分钟导出，也没有执行新的真实 Google 写入。远端 `c2test` 仍为 Worker `0.12.0-c2-season-export`／schema v9；原 staging 和生产写入归属未变。C2.4 排期写回尚未独立 Google 验收。

## 已实现

- schema v11 增加 `sync_export_controls` 与 `sync_export_retries`，与影子导入的 `sync_bindings.export_paused` 分开。Coach 使用同一会话保护的 `set-export-pause` 对单季请求暂停／恢复；请求有不可变回执和审计。导出器选择未完成批次后才检查运行时暂停，因此 `PREPARED`、`SENT`、`PARTIAL`、`FAILED` 仍可按原批次恢复；创建新批次的事务内再检查一次暂停，覆盖 Google 读取期间的状态变化。概览只在没有未完成批次时显示 `PAUSED`，否则为 `PAUSING`；导入的源暂停阻断旧批次时显示 `BLOCKED`。恢复拒绝尚未核验的批次。恢复本身不把旧目标放行；成员／排期导出器在每个新目标生成前仍重读 Google、检查布局、基线、云端版本和前值。
- Coach 可以按稳定 ID 分页读取当前绑定版本的冲突摘要，并按 ID 请求完整 B/C/G 证据；不会把诊断当成自动合并。概览增加最早待同步事件、下次到期时间、重试次数／下次尝试和注意提示。它们是提示，不能证明所有 Google 数据完整一致。
- 单独受开关保护的 `poll-due-exports` 可由十分钟 cron 驱动。每轮最多四季、每季一个批次；按最早待处理事件选择成员或排期处理器。每季失败计数及下一次尝试时间保存在 SQLite，指数退避最长六小时，成功回执清除旧失败；没有平台次数上限，也不删除未核验的 outbox。一个赛季出错不妨碍本轮尝试其他赛季。所有部署配置的 `C2_EXPORT_POLL_ENABLED` 和 `C2_SCHEDULE_EXPORT_ENABLED` 仍是 `false`。

## 本地验证

`npm test`：193／193；`npm run cf:test`：135／135；`npm run cf:check`、`npm run cf:types`、`npm run build`、`npm run build:backend`、`npm run build:bridge-probe` 和 Worker dry-run bundle 通过。新增专项测试验证暂停阻止新批次、未完成批次让状态保持 `PAUSING` 并阻断恢复、确认后恢复、同请求重放、冲突分页和受保护详情、失败计数从 7 增至 8 后 outbox 仍为 `PENDING`、冷却期不重复尝试、绑定版本更新后旧退避不延误新绑定，以及带既有绑定的 v10→v11 升级。Wrangler 尝试向沙盒外的用户日志路径写文件时打印 `EPERM`，但命令退出和测试结果均为成功；本报告不把该日志写入当成业务故障。

## 尚未通过的门槛

- 同一赛季的导出仍严格按 outbox 事件顺序；一个成员或排期实体发生冲突时，后续独立记录可能被堵住。跨赛季轮询隔离不等于同季实体隔离。需要设计可安全跳过冲突实体、但不能提前确认关联的名单／赛季版本和训练引用的策略，再补测试。
- 暂停、恢复、退避与 Google 配额耗尽、人工并发、跨部署重启的远端组合尚未实测。`poll-due-exports` 只调度已有成员与排期导出器，报名／座位及其他事件主题尚无写回处理器；这些事件会保留积压并显示阻断。完整 C2.5 验收和生产开启都不能据本地结果宣布完成。
