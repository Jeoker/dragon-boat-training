# C2 最近代码整体审查与补测

本文件记录 2026-09-27 的审查快照；回执丢失补验和本地 schema v10 接续见[2026-09-28 验收](C2-LOSS-AND-SCHEDULE-SCHEMA-2026-09-28.md)，当前阶段以[当前状态](../CURRENT-STATUS.md)为准。

日期：2026-09-27。审查范围是最近的成员／赛季名单版本导出、报名／排座／排期 outbox 快照、三张排期表的受限 Google 桥接，以及 C2.3 比较边界。检查了数据和版本归属、事件顺序、事务原子性、Google 人工编辑、重试与部分写入、作用域隔离、批次大小、接口契约、文档和构建。代码修复已部署到**独立 `c2test` Worker**，完成真实成员／赛季补丁及 Google 部分批次恢复验收；正式 staging、Pages 和生产未部署。

**已修复的实际问题：**成员导出原先按 outbox ID 查找已确认队员行时没有限定 `binding_version`。绑定版本前进后，旧版本的回执可能被误用来跳过当前版本的成员写入。现有事件进度查询和最终“全部队员已核验”检查均限定当前绑定；回归构造旧绑定下两名队员已核验、当前绑定仍有待处理事件，确认导出会重新检查当前绑定的成员行，而不会直接进入赛季行。旧绑定的 `PARTIAL` 批次仍然阻断导出且不自动丢弃，新增回归确认了这个安全边界。

**补充验证：**排期桥接测试加入 Google 行被人工改动或删除、重复稳定 ID、错误绑定、错误 Tab、跨赛季目标、公式单元格、缺表和过大训练表的拒绝路径。Worker 桥接包装层新增三种排期作用域的动作／payload 路由测试，并验证即便响应自称 `verified`，作用域、核验 ID、Tab 或 payload 摘要不匹配也不会被接受。原有连续操作快照、成员回执丢失、部分写入恢复、赛季人工冲突和 C2.3 分类回归保持通过。

**进入下一阶段前须保留的设计门槛：**

1. `SCHEDULE_TEMPLATE` 和 `TRAINING_WEEK` 目前只是签名桥接作用域，不在同步实体、SQLite 基线／批次约束和 B/C/G 规则中。应先做有迁移测试的 schema 扩展，再实现 Worker 排期事件导出；不能把桥接 `VERIFIED` 当成整条跨表事件完成。
2. 两条受控导入路径现在都拒绝在 `PREPARED`／`SENT`／`PARTIAL`／`FAILED` 导出批次未完成时提升赛季绑定版本，避免新制造旧绑定残留；批次确认后可继续提升。**已经存在**的旧绑定残留仍须建立经 Google 核验的迁移／清障操作。不得直接删除旧批次或推断 Google 未写入；新绑定也不能沿用旧绑定的确认回执。直接修改 SQLite、恢复旧快照或远端极窄竞态不由导入路径的停止条件覆盖。
3. Apps Script 单次签名 payload 上限为 10,000 字符，桥接每表最多四行只是另一项上限。现有成员、赛季和排期补丁共用 9,500 字符的本地发送前检查；未来多行 Worker 导出仍须按实际 JSON 长度拆批。模板布尔值、空值、版本及时间需明确投影为 Google `getDisplayValues()` 可稳定比较的字符串。
4. Google Sheets 人工编辑不会被 Apps Script 的 Script Lock 锁住。B/C/G 写前检查、桥接逐格前值保护和写后核验能发现许多冲突，但不是数据库级 CAS。独立 Google 文件已验收两行批次的 `PARTIAL` 冲突和同批次恢复，以及 `VERIFIED` 回执重放；Worker 与 Google 之间响应确实丢失、极窄人工同时改行及配额耗尽仍未实证，继续作为 C2.4／C2.5 上线门槛。
5. **已清理共享传输债务**：成员与赛季行原先各自实现的批次摘要核验、状态领取、失败／部分写入记录和回执确认已抽到 `c2-export-batch.ts`；三类排期、成员和赛季的补丁回执及发送前 payload 预算使用同一套检查。成员／赛季仍各自负责身份、业务基线和目标行投影。`SUPERSEDED` 批次与不再待处理的 outbox 不会因旧请求重试而再次发送；Google 返回后若事件状态改变，批次停在 `PARTIAL`，不推进基线。新增排期导出应复用这一骨架，不能重新复制发送状态机。

本地验证：`npm test` 193／193，`npm run cf:test` 119／119，`npm run cf:check`、`npm run build`（Astro 71 文件零诊断）、`npm run build:backend`、`npm run build:bridge-probe`、`npm run cf:dry-run` 和 `git diff --check` 均通过。Wrangler 的日志目录 EPERM 与故障注入 alarm 文本仍会打印，但相关命令退出码为 0；这些本地结果不证明远端并发、Google 配额或生产行为。Cloudflare Vitest 不允许在同一 isolate 内跨 Durable Object I/O 上下文模拟一条真实请求的中途外部变更，因此回执期间状态变化仍须在隔离远端故障验收中补测；本地测试覆盖了发送前状态已改变的拒绝路径。

隔离远端验收：`c2test` 部署版本 `e7f9a360-173b-4c09-97b5-56fa11a4213e`，schema v9、绑定版本 1 有效。虚构队员对原偏好作同值更新，产生名单版本 11；既定十分钟后，Worker 依次返回 `BATCH_CONFIRMED`、`EVENT_CONFIRMED`。独立 Google `Members` 10 行与 `Seasons` 1 行签名 B/C/G 检查均为 `OK`、差异 0，开放冲突、未完成批次和待同步 outbox 均为 0。`tests/live-c2-debt-export.mjs` 使用显式写入旗标和固定 c2test 主机；`tests/live-c2-readiness.mjs` 再核对无待办时返回 `IDLE`。

独立 Google 桥接另以 `tests/live-c2-bridge-replay.mjs` 验证赛季行无业务变更的同批回执重放，以及两条已有成员行中第一条核验后第二条测试注入的行冲突形成的 `PARTIAL`、恢复前值后同批完成。冲突由签名测试补丁制造，等价于写前值已变化的状态，并非实际人工同时编辑。脚本在 `finally` 还原测试单元格；最终全行核对及后续 B/C/G 检查均无差异。此测试只覆盖 Google 桥接层；真实 Worker 请求恰在 Google 写后、Cloudflare 回执落库前中断的恢复，仍只有本地故障注入证据。
