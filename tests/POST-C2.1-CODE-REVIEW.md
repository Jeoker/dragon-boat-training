# C2.1 后代码审查与修正

> 2026-09-25；本地源码和回归验证。未部署 Cloudflare staging、未连接 Google，也未切换 GitHub Pages 或生产写入归属。

## 审查范围与修正

- 检查 Apps Script 的赛季绑定、训练报名与归档约束，Cloudflare C1/C2 服务和 SQLite 写入，前端三页配置，共享契约、回归测试及项目文档。未改变 C1 业务规则、请求去重或事务边界。
- Apps Script 过去只阻止两个赛季共用运营 Spreadsheet，可能让它们共用同一个 Google Form。绑定检查现同时拒绝跨赛季复用 Form；测试覆盖预览与初始化，失败不写入第二季绑定。
- C2 的来源键原本包含绑定版本的存储字段，提升版本后无法继续使用同一个 Form 回答或旧行来源。现在稳定来源身份和业务内容保持不变时允许绑定版本前进，并更新该映射的版本；来源版本、绑定版本倒退仍拒绝。概览中的来源数量按整季统计，未搬到新版本的旧来源不会消失；依赖组基线仍按当前绑定版本统计。
- C2 同版绑定原本把响应 Tab 显示名、暂停状态和同步时间都当成不可变映射。现在允许这些运行元数据更新，但要求新的 `updated_at` 且同步时间不倒退；同版改 Form、Spreadsheet、稳定 Tab、字段映射或指纹仍拒绝。更换映射只能通过更高绑定版本的受控影子导入。概览的 `binding_current` 会显示保存的绑定是否还匹配赛季版本，旧版基线不会伪装成当前数据。
- 同步整数的字符串路径现同样要求 JavaScript 安全整数；JSON 字符串解析后必须是对象或数组；赛季、成员及报名状态按各自枚举检查。格式无效的 Form response ID 返回 `SOURCE_IDENTITY_INVALID`，不会误报服务器内部错误。
- 三个 Astro 页面共用一个静态路径和 API 地址配置；Cloudflare C1 的 POST 路由分发已从多层条件表达式整理成直线分支，并移除服务未使用的导入和成员，启用 TypeScript 未使用符号检查。公开 URL、生产 API 回退值及动作归属保持原样。

## 验证与边界

- Node 回归 **188／188**；Cloudflare Workers／Durable Object 回归 **73／73**；`npm run cf:check`、Astro 检查与静态构建通过。新增回归覆盖 Form 复用、绑定元数据、跨版本来源、异常状态及值校验。
- Apps Script 主构建、桥接探针构建和 Wrangler dry-run 均通过；dry-run 显示服务 `0.8.0-c2-sync-foundation`、`writer_epoch=0`，没有远端发布。原 [C2.1 验收](C2-SYNC-FOUNDATION-ACCEPTANCE.md)中的 187／71 是 2026-09-21 的历史快照，不应误作本轮计数。
- 本轮没有真实 Google 读写、远端 staging 部署、Pages 发布、outbox 消费或生产切换。C2.2 仍需实现 Form 回答的稳定来源导入及游标；上述修正只为该阶段提供一致的数据边界。
