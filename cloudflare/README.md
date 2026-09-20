# Cloudflare 数据服务

这里是 C0 起建立的 Worker、`TeamState` Durable Object、SQLite schema 和持久调度代码。生产仍使用 Apps Script；本目录的存在不代表已经切换写入归属。

## 环境边界

- 默认配置名为 `dragon-boat-training-api-staging`，供本地和隔离 staging 使用。
- production 必须显式执行带 `--env production` 的脚本。两个环境拥有不同的 Worker 名称、Durable Object 命名空间、数据和 secret。
- `.dev.vars`、Wrangler 本地状态、干运行产物和覆盖率目录均被忽略。仓库只保留 `.dev.vars.example`。
- C0 内部测试入口仅在非 production 且请求提供 `C0_TEST_KEY` 时可用。它只验证事务和任务机制，不是训练报名接口。

## 本地命令

```text
npm run cf:types
npm run cf:check
npm run cf:test
npm run cf:dry-run
npm run cf:dev
```

`npm run cf:deploy:staging` 创建或更新隔离 staging。`npm run cf:deploy:production` 只保留为明确的后续命令；C4 前不得用它接管生产业务。Cloudflare 和 Google secret 分别通过平台配置，不写入代码、Wrangler vars 或日志。

账户首次部署还需要在 Cloudflare Dashboard 启用一个 `workers.dev` 子域；Worker 上传成功不代表该公网地址已经可用。staging 的 `C0_TEST_KEY`、`GOOGLE_BRIDGE_URL` 和 `GOOGLE_BRIDGE_SECRET` 必须用 Wrangler secret 或平台 secret 配置，不能加入 `wrangler.jsonc`。`wrangler dev --remote` 可以验证 Worker 本身，但当前 Wrangler 不支持以该模式访问 Durable Objects SQLite，因此远端 DO 验收必须走已部署的 staging 地址。

## C0 已验证边界

SQLite schema v1 包含不可变请求结果、审计、outbox、持久任务和用于验收的原子计数器。alarm 每次领取有界任务，使用租约和尝试次数识别迟到结果；失败会在应用层继续排期。C1 将在相同事务结构中加入真实业务表和规则，C2 才接入完整 Google 同步。

C0 桥接小样使用 `2026-09-19.bridge.v1` 信封；签名绑定方向、团队、绑定版本、`writer_epoch`、时间戳、nonce、操作编号及负载摘要。传输 nonce 与操作幂等编号分离。staging 的受保护探针允许选择有效、过期、篡改负载、错团队、错 binding 和错代次场景，以验证真实 Google 拒绝路径；production 固定关闭这些入口。当前 Apps Script 端只保存少量 C0 回执用于证明协议，C2 必须改用正式持久表和分段业务回执。
