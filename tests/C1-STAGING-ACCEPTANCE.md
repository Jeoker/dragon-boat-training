# C1.6 隔离 staging 验收

> 状态：2026-09-21 完成。C1.1–C1.5 的完整业务链路已部署到 Cloudflare 隔离 staging 并通过真实远端验收；生产 Pages、Apps Script 写入归属及 Google 业务同步均未改变。

## 验收环境与边界

- staging Worker：`dragon-boat-training-api-staging`，服务版本 `0.7.0-c1-acceptance`，后端代次 `cf-c1-staging-2`，`writer_epoch=0`，SQLite schema v6。
- 公网地址为 `https://dragon-boat-training-api-staging.dragon-boat-training.workers.dev`。全部 `/internal/c1/*` 入口仍要求独立 `C1_TEST_KEY`；错误 key 返回 `C1_ACCESS_DENIED`。production 环境仍隐藏这些入口。
- `C0_TEST_KEY`、`C1_TEST_KEY`、`COACH_CODE_SECRET` 和 `SESSION_SECRET` 使用本轮随机值写入 Cloudflare secret；本地只保存在 Git 忽略的 `cloudflare/.dev.vars`。验收 Coach Code 仅在该本地文件中，secret 值没有输出、写入文档或提交。
- 只导入虚构数据：一个 2035 开放赛季、一个 2020 已归档赛季、两场训练和 125 名成员。没有读取或迁入真实成员、真实 Coach Code、Form 或 Spreadsheet。
- Google bridge 没有接入 C1 业务 outbox。C1 写入后 `outbox_pending` 保持至少两条，证明网页业务提交不依赖 Google；这不是 Google 同步成功证据。
- GitHub Pages 继续调用现有 Apps Script。未部署 production Worker，未修改页面 API URL，也未启用 C1 自动历史维护。

## 可复现入口

显式远端验收脚本为 `tests/live-c1-staging-acceptance.mjs`，不会随 `npm test` 自动运行。首次完整运行：

```text
npm run cf:accept:c1-staging
```

重新部署后的持久化复验：

```text
npm run cf:accept:c1-staging -- --verify-only
```

脚本不打印凭据。下载的备份保存到 Git 忽略的 `cloudflare/.acceptance-artifacts/`，其中包含虚构验收数据；实际业务备份仍必须放在仓库外的私有存储。

## 真实远端结果

首次部署的 Worker version ID 为 `0ded4e61-c4a3-4232-a4db-588e9a7a81ba`。完整运行共发出 66 个请求并通过以下场景：

- schema v1 原地升级至 v6，依次导入核心、排期、报名、排座和历史快照；公开名单为 123 名开放赛季成员，历史快照另含 2 名成员。
- 两个报名请求使用相同 `signup_version` 竞争最后一个 LEFT 名额，只有一个成功，另一个返回 `VERSION_CONFLICT`；失败者刷新版本后进入候补，容量没有超额。
- Coach 会话建立成功；私有草稿设置 Coach／Steerer、排入获胜队员并发布 revision 1。公开训练只返回正式 revision，不暴露草稿。
- 2020 赛季荣誉墙、已冻结训练和姓名快照可公开读取，响应不含成员内部 ID；管理历史可读取，审计使用 `limit=2` 返回下一页 cursor。
- 备份包含 191 条记录、29 个分块；`members` 表超过单个一百行分块。API 自校验通过，脚本下载全部分块并在本地按规范 JSON 重新计算每块 SHA-256。
- 使用既有 C0 隔离故障夹具验证共享持久任务底座：任务连续模拟失败 7 次后在第 8 次完成，超过平台默认重试次数仍未丢失。
- `writer_epoch=0` 下没有出现 `history_freeze:`、`history_complete:` 或 `history_archive:` 自动任务，影子数据没有误取得写入权。

首次运行的端到端延迟样本为 p50 **42.2 ms**、p95 **89.1 ms**、最大 **116.4 ms**。这些是单次隔离 staging、小团队虚构数据和本轮网络条件下的观测值，不是生产 SLA 或容量承诺。

随后把同一代码再次部署为 Worker version `18b0e059-2f76-4627-9528-d75bab44e465`。只读模式发出 43 个请求，重新登录后读到同一份 schema v6 业务数据、历史、报名／排座状态和同一个 29 分块备份，并再次完成 API 与本地摘要校验。该轮 p50 **35.4 ms**、p95 **66.9 ms**、最大 **98.9 ms**，证明数据和不可变备份回执跨 Worker deployment 保持。

## 本地回归

- 项目 Node 测试 **184／184**。
- Cloudflare Workers／Durable Object 测试 **65／65**。
- Cloudflare TypeScript 检查、Wrangler 类型生成及 dry-run 通过。
- Astro 检查与三个静态页面构建通过。
- Apps Script 业务构建及独立 bridge probe 构建通过。
- `node --check tests/live-c1-staging-acceptance.mjs` 与 Git whitespace 检查通过。

Wrangler 在受限本地环境中不能写用户级 debug log，显示了 `EPERM` 提示；类型生成和 Vitest 命令本身均以状态 0 完成。dry-run 使用仓库内忽略目录保存日志后无此提示，不把日志目录权限问题记为产品失败。

## 验收中修正

远端首次运行在导入前停止：脚本预期不存在的公开赛季返回内部错误 `SEASON_NOT_FOUND`，实际公开 API 有意把“不存在”和“未公开”统一为 `SEASON_NOT_PUBLIC`。业务服务行为与契约一致，没有远端数据被写入；验收脚本改为核对公开错误后重跑通过。

备份规模断言也改为直接检查 `members` 表至少包含两个分块，不再用“总分块数大于表数”这一不可靠的间接条件。故障请求使用固定到期值，使相同请求编号和负载可以安全重放。

## 结论与下一步

C1.6 门槛已完成：核心、排期、报名候补、排座、冻结历史、审计、备份和持久任务在隔离远端形成了完整证据，Google 断开时业务链路仍可用，数据跨部署保持。C1 staging 仍是受测试 key 保护的工程接口，不是生产后端。

下一阶段进入 C2：实现正式 Google Form／Sheets 桥接、三方比较、双向同步、冲突隔离、批量导出和年度文件。C2 先在隔离 staging 验证，不连接生产 Pages；只有 C4 的最终迁移、对账、写入归属切换和回退演练全部通过后，Cloudflare 才能成为生产权威。
