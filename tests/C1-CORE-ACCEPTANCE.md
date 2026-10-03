# C1.1 核心身份与数据验收

> 状态：2026-09-20，本地实现与验证完成；未部署 staging，未连接 Pages 或 Google 业务同步，C1 整体尚未完成。

## 实现边界

- SQLite schema v2 原地增加 Coach、会话、设置、赛季、成员和影子快照表；v1 请求结果、审计、outbox、任务和计数器保留。
- `shared/c1-contract.ts` 定义七个隔离动作的 TypeScript DTO、运行时解析和方法／权限注册；[C1 接口清单](../contracts/api-cloudflare-c1.json)记录输入输出。
- 全量核心影子快照迁入稳定 ID、版本、来源键及旧 Coach Code 摘要。相同快照内容可换请求编号重放；同一来源快照 ID 换内容、同版本换内容、版本回退、悬空引用或来源键换人均拒绝。省略记录不视为删除。
- 新后端复用旧 Code 摘要算法验证个人 Code，但签发自己的 generation／writer epoch 会话；明文 Code 和 token 不进入 SQLite。所有管理者仍共用一套权限。
- 新建赛季和修改成员把业务值、不可变回执、审计与 `CORE_CHANGED` outbox 放在同一事务。C2 前不执行这些 outbox，也不把 C0 假任务当成 Google 回执。
- 隔离公开名单按 `season_id` 返回有效成员的最小投影；来源键、原姓名覆盖字段、停用成员和其他赛季成员不泄露。

## 本地证据

Cloudflare Workers／Durable Object 使用官方本地测试运行时和 SQLite：

- schema v1 → v2 保留 C0 行并可重复执行；损坏或未来 schema 不被改标。
- 美国纽约时区跨夏令时的赛季结束边界按当地下一日 00:00 计算。
- C1 测试 key、production 隐藏、方法白名单、严格 number／boolean／enum 校验和 C1 envelope 通过。
- 核心快照幂等、内容漂移、版本倒退、来源键冲突和跨表引用通过。
- Code 登录、token 篡改、登出重放、撤销后拒绝及统一管理视图通过。
- 两个赛季公开名单隔离，停用成员和私有源字段过滤通过。
- 新建赛季、成员版本冲突、跨季错误目标、不可变结果及两条待同步 outbox 通过。

验收时 Cloudflare 测试 **26／26**、项目 Node 测试 **180／180**；Cloudflare 类型检查和 dry-run、Astro 检查与三个页面构建、Apps Script 业务及独立桥接构建均通过。

## 尚未完成

C1.2 排期至 C1.5 冻结历史随后完成独立切片及对应的[排期验收](C1-SCHEDULE-ACCEPTANCE.md)、[报名验收](C1-SIGNUP-ACCEPTANCE.md)、[排座验收](C1-SEATING-ACCEPTANCE.md)和[历史验收](C1-HISTORY-ACCEPTANCE.md)；C1.6 完整迁移回归和远端 staging 验收也已完成，见 [C1.6 验收](C1-STAGING-ACCEPTANCE.md)。`update-member` 与核心影子导入已阻止停用仍有未来有效报名、草稿角色／船位或最新正式角色／船位的成员。默认赛季修改、赛季激活及 Google 绑定属于后续动作。

本轮没有迁入真实成员或 Code，没有配置 staging 的新 secrets，没有部署 Worker。现有生产 Apps Script、Pages API 和 Google 文件均未改变。
