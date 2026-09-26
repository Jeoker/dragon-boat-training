# C2.2 Form 稳定来源导入验收

日期：2026-09-25 至 26。**C2.2 在隔离 Google Form、独立 `c2test` Worker 和原 staging 的阶段门槛已通过；生产仍由 Apps Script／Sheets 写入，Pages 未切换。** C2.3 的 Sheet 差异读取与双向同步尚未实现。本记录只含虚构测试数据，不含私有文件 ID、密钥或 Coach Code。

## 环境与边界

- 专用 Apps Script 测试项目、Form、响应 Sheet 和系统 Sheet 位于仓库外；项目所有者完成 OAuth 授权。测试 Web App 版本 1 可匿名访问，但 Form 回答读取必须通过签名、团队、绑定与写入代次校验。测试 Form 安装了一个 `From form - On form submit` 触发器；正式旧 Spreadsheet 触发器和生产文件未改。
- 专用 `c2test` 使用独立 Worker／SQLite DO、私有配置、`writer_epoch=0`。十分钟 cron 仅为验收暂时启用，验收后配置已恢复为无 cron 且 `C2_FORM_POLL_ENABLED=false`。测试桥接 URL 在故障注入后已恢复。最终 `c2test` Worker 版本为 `11a0e92d-9c41-493f-b63b-91f3625abe6e`。
- 原 staging 从 C1.6 Worker `0.7.0-c1-acceptance`／schema v6 原地升级到 `0.9.0-c2-form-import`／schema v8，最终部署版本 `ef7cfe37-5e77-4b0a-9622-62973b2b1d19`，仍为隔离代次 `cf-c2-staging-4`、`writer_epoch=0`。其十分钟 cron 配置保留，但 `C2_FORM_POLL_ENABLED=false`；未配置 C2 测试密钥或 Google Form 绑定。生产 Worker 没有 C2 路由。

## 真实链路证据

| 情况 | 结果及证据边界 |
|---|---|
| 初次分页、增量与通知 | 真实 Form 回答 Alpha、Beta 按 `limit=1` 各建一人，Gamma 增量建一人。Delta 经正式 responder 页面提交后，Apps Script 触发执行 `Completed`，Cloud logs 记录通知已确认；在无 cron、无手动拉取的条件下名单从三人变四人。之后重叠补扫 `created=0`。见 [手动导入脚本](live-c2-form-acceptance.mjs)与[触发验收脚本](live-c2-form-trigger-acceptance.mjs)。 |
| 实际十分钟调度 | 暂时启用 `c2test` 的 `*/10` cron；先把**仅测试项目**的通知地址指向无效路径，再提交 Zeta。触发执行失败。`wrangler tail` 观察到真实 scheduled event（计划时间 `2026-09-26T04:50:35Z`，实际事件约 `04:50:45Z`）及 `/internal/c2/poll-active-forms` 200；Zeta 进入六人名单，未重复。恢复通知地址，关闭 cron。Epsilon 的程序提交实际触发了 Form 触发器，不能当作 cron 独占证据；因此改用 Zeta 隔离两条路径。见[调度名单脚本](live-c2-form-cron-acceptance.mjs)。 |
| Google 桥接故障与恢复 | 暂时把**仅 c2test** 桥接 URL 改成无效测试路径，提交 Eta，通知失败。显式拉取返回 503／`BRIDGE_UNAVAILABLE`，名单保持六人。恢复原测试桥接后用同一请求 ID 重试，`created=1`，名单七人；重放的不可变 `data` 相同。响应 `meta.server_time` 是动态字段，不参与回执等价比较。见[故障脚本](live-c2-form-failure-acceptance.mjs)。 |
| 旧成员歧义与人工关联 | 在独立 DO 中导入一名虚构旧成员 Theta，真实 Form 新回答被列为 `LEGACY_NAME_MATCH` 待核查。Coach 使用独立测试 Code 登录，经新增的只读 `list-form-reviews` 查看来源 ID、版本与原因，再显式关联原成员；核查清单归零，人数仍为八且 `member_id` 保留，最后退出。见[核查脚本](live-c2-form-review-acceptance.mjs)。 |
| 通知与拉取重叠 | Iota 提交后立即手动拉取，名单从八到九；之后重叠拉取 `created=0`、`unchanged=9`，ID 唯一。远端触发和手动读取并未在同一毫秒发生，**不将此视为严格并发证明**。本地 Workers／DO 测试强制两个读取并发：只创建一名成员，过期批次返回 `FORM_IMPORT_STALE`，原请求 ID 可重新尝试且不重复建人。见[重叠脚本](live-c2-form-overlap-acceptance.mjs)和 `cloudflare/test/c2-sync-foundation.test.ts`。 |
| 跨部署持久化 | `c2test` 在多次 Worker 部署、停用 cron 和临时桥接故障后仍保留九人名单及唯一 ID。原 staging 升级前后 123 名公开成员的 ID／姓名／版本摘要及赛季版本相同，待同步 outbox 仍为 `PENDING`；缺少 C2 Key 被拒绝，旧测试 Coach 登录、bootstrap、退出均通过。收尾补扫修复再次部署后两端又分别只读复验。见[staging 升级脚本](live-c2-staging-upgrade-acceptance.mjs)。 |

## 设计复核与本地验证

- Form 来源身份始终由 `season_id + form_id + FormResponse.getId()` 确定；时间和回答 ID 共同排序，24 小时重叠补扫在事务内提交成员、来源观察、游标和不可变回执。读取期间绑定或游标改变则拒绝提交；同时间回答、失败不推进游标、旧行歧义及 v7→v8 原地升级有专项测试。
- 审查发现原轮询会持续读取已完成赛季；简单跳过截止后的赛季又可能漏掉最后一次失败通知。现只选当前绑定的开放／已完成赛季：截止前照常补扫，截止后直到**一次成功且所有分页完成**的最终补扫，再停止自动读取；失败保留重试资格。管理员可在 `get-sync-overview` 看待核查数量，通过 `list-form-reviews` 分页定位具体来源，再以版本校验的 `resolve-form-source` 明确处理；没有按姓名自动合并。此收尾规则经本地测试和两端重新部署后的只读持久化复验，尚未用真实截止赛季做端到端 Google 验收。
- 当前本地回归：`npm test` 189／189、`npm run cf:test` 81／81；`npm run cf:check`、`npm run build:backend`、`npm run build` 均通过。`npm run cf:test` 在受限 Windows 环境会有 Wrangler 日志写入 `EPERM` 警告，但测试进程成功退出。部署与真实数据均限隔离环境；没有消费 Google outbox，也没有切换生产流量。

## 后续边界

C2.2 已满足当前阶段验收，但实际触发与手动拉取的严格同时执行只由确定性的本地并发测试覆盖；真实 Google 超时与配额耗尽也未逐项制造。当前每轮最多选四个符合条件的赛季，适合本团队现阶段规模；扩展到更多并行赛季前，应补公平调度及失败赛季的退避／指标。下一步 C2.3 处理 Sheet 直接修改、三方差异与冲突；在 C2.4 有限补丁和回执完成前，`PENDING` outbox 不能标为 Google 已确认。
