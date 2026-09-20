# C0 Cloudflare 基础验收记录

> 记录日期：2026-09-19
> 结论：**C0 全部门槛已通过，可以进入 C1 业务迁移；生产写入归属仍未切换。**

本文只记录 Cloudflare 迁移 C0 的实现证据和剩余边界。生产 GitHub Pages、Apps Script、Google Sheets 及业务写入归属均未切换。

## 已实现范围

1. `cloudflare/wrangler.jsonc` 明确隔离 staging 与 production Worker、Durable Object 绑定、实例标识、代次和 `writer_epoch`。production 只能通过显式脚本选择。
2. SQLite schema v1 包含 schema 版本、C0 占位状态、不可变请求结果、审计事件、outbox 和持久任务。初始化可重复执行，并拒绝未知的更高 schema 版本。
3. 最小提交在同一 SQLite 事务中保存状态、请求结果、审计、outbox 和任务。幂等范围包含团队、调用者、动作与请求编号，并核对负载摘要。
4. alarm 从持久任务表恢复最早时间；任务以租约和尝试编号领取，外部等待在事务外进行，迟到结果不能完成新的尝试。失败由应用层退避续排，不依赖平台只重试固定次数。
5. 兼容测试冻结了现行 Apps Script 的 UTF-8 HMAC-SHA256、无填充 base64url 和历史 `JSON.stringify` 字段顺序。新契约明确 `backend_instance`、`backend_generation` 和 `writer_epoch`；旧会话不迁移。
6. Worker 与 Apps Script 已实现 `2026-09-19.bridge.v1` 签名探针。签名覆盖方向、团队、绑定版本、归属代次、时间戳、nonce、操作编号和负载摘要；Apps Script 区分传输重放与业务幂等。
7. 根 TypeScript 配置排除 Workers 全局声明，Worker 使用独立 `cloudflare/tsconfig.json`，防止运行时类型污染 Astro 的浏览器 DOM 检查。

## 自动化与本地运行证据

| 检查 | 结果 |
|---|---|
| `npm test` | 162／162 通过；其中 3 项为 Apps Script 桥接签名、篡改／过期／错归属和重放边界 |
| `npm run cf:test` | 11／11 通过；覆盖健康元数据、访问边界、旧摘要向量、并发去重、参数冲突、事务回滚、alarm 恢复、八次应用级失败续排和桥接签名输入 |
| `npm run cf:check` | 通过 |
| `npm run cf:dry-run` | 通过；构建识别 `TeamState` Durable Object 和 staging vars |
| `npm run build` | 通过；Astro 0 errors，生成首页、Coach Mode 和过往赛季页面 |
| `npm run build:backend` | 通过，生成 `backend/.build/Code.gs` |

真实本地 Wrangler 进程使用独立持久目录运行：首次提交后计数为 7、请求 1、待执行任务 1；关闭进程并使用同一目录重启后，三项仍存在。同一请求及负载再次提交返回原结果，最终计数仍为 7、请求仍为 1。这是磁盘上的 SQLite／请求结果／任务恢复证据，不是 JavaScript 内存模拟。

Cloudflare 测试插件在当前 Windows 环境中执行 `evictDurableObject` 时仍会因对象引用等待超时，不能写成驱逐辅助函数已通过。排查过程发现并修正了未消费的 SQLite 写游标；构造恢复路径由专项测试覆盖，真实进程重启另行通过。后续升级测试插件后可重新验证显式驱逐。

## 隔离 staging 证据

- `npm run cf:deploy:staging` 已成功上传 `dragon-boat-training-api-staging`，Cloudflare 完成 `TeamState` Durable Object 导出 reconciliation。
- `https://dragon-boat-training-api-staging.dragon-boat-training.workers.dev/health` 已返回 HTTP 200，内容包含契约 `2026-09-19.c0`、服务 `0.1.0-c0`、staging 实例、代次 `cf-c0-staging-1` 和 `writer_epoch=0`。首次部署后的短暂 TLS 失败属于子域证书／DNS 传播，稍后重试通过，账户无需改名。
- staging 已通过平台 secret 配置随机 `C0_TEST_KEY`，值未输出或写入仓库。远端提交 `request_staging_20260919_001` 后计数为 9，请求、审计、outbox 和任务各 1；同号同负载重放返回同一结果。
- 重新部署同一 Worker 后，计数仍为 9，请求、审计、outbox 和任务仍各 1，alarm 仍指向保存的到期时间。加入真实负向桥接场景并再次部署后，schema 仍为 v1、上述数量不变，SQLite `databaseSize` 为 73,728 bytes。这证明 staging Durable Object SQLite、不可变请求结果和任务跨 Worker deployment 保留。
- 当前 Wrangler 明确拒绝用 `wrangler dev --remote` 访问 Durable Objects SQLite；该失败未作为 DO 证据，最终结论使用上述已部署公网端点。
- 没有部署 production Worker，没有把新 URL写入 GitHub Pages，也没有给 staging 配置生产 Google 文件或业务 secret。
- C0 源码与文档提交为 `4a55bb0`。GitHub Pages run `35486989400` 的 build／deploy 均成功；随后队员页、Coach Mode、过往赛季页和 staging health 均返回 HTTP 200。Pages 仍使用现行生产 Apps Script，本次发布没有切换 API。

## 真实 Google 桥接证据

1. 官方 `clasp` OAuth 已完成；生成的桥接探针已推到独立测试 Apps Script 项目，并部署为允许匿名调用、以部署者身份执行的 Web App。该项目未绑定 Form 或 Spreadsheet，Script ID、部署 ID、OAuth 凭据和 secret 均未写入仓库。
2. Google 首次运行授权已完成。默认 GCP 项目仍不允许 `clasp run` 调用 Execution API，因此 C0 实际通过 Apps Script Project Settings 写入四项 Script Properties；这不影响匿名 Web App。`configureC0BridgeProbe` 继续只作为标准 GCP 项目可用时的非生产辅助函数，不是当前验收前提。
3. 两端使用同一枚随机共享 secret，并分别核对团队 `pentasus`、binding `c0` 和 `writer_epoch=0`。真实 Worker 请求经过 `script.google.com` 重定向到 `script.googleusercontent.com` 后返回 `verified`。
4. 同一请求连续发送两次，第二次返回相同 operation ID、payload digest 与首次 `acknowledged_at`，证明 Google 端复用了不可变回执，没有重复执行。
5. staging 专用测试场景通过同一真实网络链路验证：过期时间戳返回 `BRIDGE_TIMESTAMP_INVALID`，改变签名后的负载返回 `BRIDGE_PAYLOAD_INVALID`，错误团队、binding 和 writer epoch 返回 `BRIDGE_OWNERSHIP_INVALID`。错误团队首次遇到十秒外部调用超时并返回可重试的 `BRIDGE_UNAVAILABLE`，单独重试后得到预期拒绝；该超时保留为 Google 延迟证据，不改写成规则失败。
6. C0 测试入口在 production 环境固定返回 `NOT_FOUND`，且仍要求独立 `C0_TEST_KEY`。桥接 secret 未出现在请求正文、命令输出、仓库或本报告中。

## 实际计划与用量快照

- Cloudflare Dashboard 显示当前 Workers 计划为 **Free**。页面当时列出的主要额度为：Workers 每日 100,000 次请求、每次最多 10 ms CPU；Durable Objects 每日 100,000 次请求、13,000 GB-sec、5,000,000 行读取、100,000 行写入，以及 5 GB SQL 存储。
- Worker 最近 24 小时页面显示 16 次请求；CPU P50 约 1.26 ms、P90 约 1.72 ms，wall time／request duration P50 约 618 ms、P90 约 3 秒，内存 P50 约 1.59 MB。Google 子请求显示 7 次重定向和 6 次 2xx；页面同时记录 1 次 uncaught exception，与本轮一次十秒桥接超时处于同一测试窗口，后续单独重试成功。
- Durable Objects 当日页面显示 4 次请求、0 个错误、0.015 GB-sec、33 行读取、17 行写入和 0 B 计费存储。0 B 受计量粒度或延迟影响，不能解释为 SQLite 没有持久数据；同一时段的受保护状态读取返回 `databaseSize=73,728` bytes，跨部署读取也已经单独证明数据存在。
- 这是 C0 小样和当时 Dashboard 快照，只证明入口、指标和数量级均可观察。C1–C4 仍须持续记录真实业务负载；不承诺长期免费，也不自动升级付费计划。

## C0 门槛结论

C0.1–C0.6 的实现、隔离 staging、真实桥接、错误范围和用量入口均已验收。可以开始 C1 的赛季、成员与权限、排期、报名候补、排座和冻结历史迁移。C1 只能继续使用隔离测试端点；生产 Worker、GitHub Pages API 和 Apps Script 业务写入归属均保持不变，直到 C4 门槛全部通过。
