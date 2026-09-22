# C2.1 同步基础与三方比较验收

> 状态：2026-09-21，本地实现、代码审查与验证完成；未部署本轮 staging，未连接 Google、Pages 或生产写入路径。

## 实现边界

- SQLite schema v7 在 v6 之上增加 `sync_bindings`、`sync_baselines`、`source_imports`、`sync_conflicts`、`sync_batches`、`sync_batch_items` 和 `sync_migration_snapshots`；v1–v6 数据原地保留，受保护备份包含新增同步表。
- `shared/c2-sync-rules.ts` 定义赛季、成员、报名、训练、排座草稿和冻结历史的稳定字段、业务依赖组、值规范化及 Google 改动策略。三方比较使用上次确认基线 `B`、Cloudflare 当前值 `C` 和 Google 值 `G`，不会以更新时间或最后写入者决定覆盖。
- 独立字段可分别导入或导出；同一依赖组两侧不同变化进入冲突。报名偏好由正常报名规则校验，报名状态变化需要影响确认；身份、队列、容量结果、版本和冻结快照的 Google 改动直接拒绝。
- 删除 Google 行、无基线新行、任一侧出现未映射字段、无效日期／时间或损坏值都保留为待核查，不猜测取消、建人或覆盖。
- `import-sync-foundation` 使用独立 `C2_TEST_KEY` 接收受控影子元数据。它不调用 Google、不创建 outbox、不确认既有 outbox，也不启动同步批次。
- `get-sync-overview` 复用 C1 Coach session，返回该季私有绑定和基线、来源、冲突、批次及待同步数量；C2 路由在 production 固定隐藏。
- 当前源码服务为 `0.8.0-c2-sync-foundation`，后端代次为 `cf-c2-staging-3`，schema 为 v7。以上版本只存在于本地源码和 dry-run；已部署 staging 仍是 C1.6 的 `0.7.0-c1-acceptance`／`cf-c1-staging-2`。

## API 与身份约束

- 每季 Google Form 和运行 Spreadsheet 都必须唯一，已经初始化的赛季不能通过更高版本静默替换 Form、Spreadsheet、响应 Tab 或创建身份。
- Form／Spreadsheet 使用 Google 文件 ID；响应 Tab 使用 `Sheet.getSheetId()` 的非负数字字符串，避免用名称承担身份。显示名称允许改名，但稳定数字 ID 不变。
- 字段映射必须含 `display_name_header`，键使用规范名称，表头非空且不能一列多用。
- Form 来源稳定键严格为 `FORM_RESPONSE:season_id:form_id:response_id`；旧来源严格为 `LEGACY_ROW:season_id:source_external_id`。相同外部来源不能拥有两个稳定键，已导入来源不能回到核查或换人。
- 依赖组基线必须恰好包含该组字段，值在保存前规范化；身份组还必须与所引用的赛季、成员、报名或训练实体一致。省略记录不表示删除。
- 同一请求编号和负载重放不可变结果；同一快照编号换内容、同版本换数据、版本倒退、旧绑定继续导入和来源重新指派均返回明确冲突。

## 代码审查修正

1. 初版把真实 Sheet tab ID 当作至少八位的通用字符串，短数字 `getSheetId()` 会被拒绝；现改为独立数字 Tab ID 解析，并允许旧来源外部键很短。
2. 初版对报名偏好和报名状态使用同一组的最严格策略，导致合法换侧也要求人工确认；现仅按 Google 实际改动字段选择策略，同时仍以整个报名状态组判断两侧冲突。
3. 初版只检查 Google 侧的未知字段；现比较基线、Cloudflare 和 Google 的字段并集，任一侧 schema 漂移都会进入核查。
4. 初版日期和 instant 依赖宽松 `Date.parse`，可能接受滚动后的无效日期或无时区值；现要求真实 ISO 日期及带时区 instant，并统一规范为 UTC。
5. 初版旧来源只校验字符串前缀，无法证明稳定键与外部键相同；现要求完整确定性等式，并阻止跨季复用 Form／Spreadsheet。
6. 初版已保存的旧绑定仍可能被后续基线或来源导入引用；现要求同步绑定版本同时等于赛季当前 `binding_version`。
7. 新表增加 JSON 完整性、实体类型、来源状态和跨季文件唯一约束；测试健康检查改为读取 Wrangler 环境代次，避免阶段升级后保留写死的 C1 值。一个依赖 Miniflare 即时时钟的 alarm 用例改为直接调用同一 alarm 处理器，消除与业务无关的偶发失败。

## 本地证据

- C2.1 专项 6／6：三方独立变化、同组冲突、自动／校验／确认／拒绝策略、删行、未知字段、无效日期、稳定来源和生产隐藏均通过。
- schema v6 → v7 原地升级保留 C1 成员；全部七张 C2 表建立，JSON 与来源状态约束生效。
- 绑定、基线和来源导入支持同请求及新请求重放；同快照漂移、旧绑定、文件替换、跨季文件复用、错误基线、错误来源和来源换人被拒绝。
- 导入后的概览显示一条基线、一条已导入来源、一条待核查来源，冲突／批次／outbox 均为零，证明本切片没有假装完成 Google 同步。
- Cloudflare Workers／Durable Object 回归 **71／71**，项目 Node 回归 **187／187**；TypeScript 检查、Wrangler 类型生成和 dry-run、Astro 检查与静态构建、Apps Script 主构建及 bridge probe 构建均通过。
- dry-run 显示服务 `0.8.0-c2-sync-foundation`、代次 `cf-c2-staging-3`、`writer_epoch=0`，未执行远端部署。

## 下一步

C2.2 实现 Form 稳定来源导入：Apps Script 以 Form response ID 返回带重叠窗口的有界回答批次，Cloudflare 保存只在完整提交后推进的游标、旧来源映射和导入回执。必须覆盖触发器与补扫重复、相同提交时间、失败批次、重名和无法唯一对应的旧行；在本地通过后才连接独立测试 Form。

C2.3 才读取业务 Sheet 并产生实际 `B/C/G` 差异，C2.4 才生成和确认有限 Google 补丁。C2.1 不构成 Google 同步成功、staging 部署或生产切换证据。
