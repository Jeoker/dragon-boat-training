# API 边界与维护约定

这里维护接口设计，业务规则仍以项目 README 为准，部署状态只看 CURRENT-STATUS。

- [api-v1.json](api-v1.json)：现行 Apps Script 动作、权限、输入和输出清单。
- [api-cloudflare-c0.json](api-cloudflare-c0.json)：Cloudflare C0 隔离测试接口，不是生产报名 API。
- [api-cloudflare-c1.json](api-cloudflare-c1.json)：C1 核心、权限、排期、报名候补、排座、冻结历史与运维切片的隔离接口。
- [api-cloudflare-c2.json](api-cloudflare-c2.json)：C2 绑定、Form 导入、Sheet 差异、成员／排期及报名排座关联导出和运维的隔离接口。已完成范围与未验收门槛见下文及[当前进度](../CURRENT-STATUS.md)，均未接入生产。

这些 JSON 文件是接口清单，不是可交给 JSON Schema 验证器执行的 schema。C1 的动作注册在 `shared/c1-actions.ts`，核心、排期、报名、排座及历史 DTO／运行时解析分别在 `shared/c1-contract.ts`、`shared/c1-schedule-contract.ts`、`shared/c1-signup-contract.ts`、`shared/c1-seating-contract.ts` 和 `shared/c1-history-contract.ts`；服务端业务校验及客户端响应校验继续独立承担相应边界。测试核对代码与清单中的动作、方法和权限声明一致。不能把字段清单当成完整的类型或权限校验。C1 影子导入的 `transport_only` 表示本地／staging 隔离入口只使用统一的 `C1_TEST_KEY` 传输门；当前没有第二个未实现的 migration key，production 入口仍固定隐藏。

## 请求边界

1. 接口表达业务动作，不提供通用读写 Spreadsheet、表名、范围或 SQL 的接口。明确传入实体 ID，后端查归属；不能靠首页默认赛季为无效 ID 兜底。
2. 公开读取用 GET。Apps Script 管理读取和写入用 POST JSON 请求体，浏览器以 `text/plain;charset=UTF-8` 发送并跟随重定向。Code 和 session token 不进入 URL。
3. 所有 POST 必须带客户端生成的 `request_id`，8–128 位 ASCII 字母、数字、下划线或连字符。缺失或非法编号在业务动作前拒绝；GET 缺省时服务端可生成编号。正常客户端始终传入编号并验证响应关联。
4. Apps Script 版本字段接受非负安全整数，保留规范十进制字符串兼容；不把 `null`、布尔值、数组、空串或小数转换成版本。明确的布尔选项只接受 JSON boolean。`known_roster_version=-1` 是旧页面的“未知”提示，不是业务版本。缺省 `bootstrap.season_id` 或旧客户端空串表示首页默认入口。
5. Cloudflare 业务 DTO 的版本、计数等整数字段只接受 number 安全整数，布尔字段只接受 boolean。不能以 TypeScript 类型断言代替运行时校验。迁移旧客户端时由适配器明确处理兼容，不静默转换原请求摘要。内部来源纯模型另保留有限 IEEE-754 小数，不把业务整数约束套到原 Sheet 数值上。
6. `limit` 必须为正整数；缺省值、上限和超过上限时的拒绝或截断规则见动作清单。cursor 是不透明续页标识，客户端不构造、不解释。实体关联、必填字段、枚举和时间边界继续在业务层检查。

## 响应边界

成功与失败互斥：

```json
{"ok":true,"data":{},"meta":{"contract_version":"…","request_id":"…","server_time":"…"}}
{"ok":false,"error":{"code":"…","message":"…","retryable":false},"meta":{"contract_version":"…","request_id":"…","server_time":"…"}}
```

`data` 是该动作的对象；不能直接返回数据库整行。公开响应与管理响应分别投影，禁止公开草稿、联系方式、文件位置或会话信息。错误消息不得包含堆栈和 secret。

Apps Script 业务失败可能仍是 HTTP 200，必须检查 envelope。客户端同时检查契约版本、请求编号、服务器时间和成功／失败结构；无法读取、响应串号、HTTP 与成功状态矛盾均不能证明写入失败。Cloudflare 的成功和错误统一带 `backend_instance`、`backend_generation`、`writer_epoch`、环境及服务版本；入口尚未解析有效编号的拒绝可返回 `request_id:null`，不能假装已经识别业务请求。

## 操作结果与页面视图

| 接口类别 | 响应含义 | 正确后续动作 |
|---|---|---|
| 普通读取、受保护工作区读取 | 当前投影，不保证重复读取字节一致 | 可重新读取，用实体及版本防止迟到结果覆盖新页面 |
| 报名、成员修改、排期等带日志的业务写入 | 日志里的操作结果不可变；可附新构建的 `current_view` | 结果已确认而视图缺失时只补读，不再次创建业务动作 |
| `saveSeatPlanDraft`、`publishSeatPlan` | 现行兼容接口直接返回最新排座工作区；内部日志仍存不可变操作结果 | 重放不重复写入，但工作区可能比原操作更新，不把整份响应当成历史回执 |
| `retrySeasonSync`、`retrySeasonArchive` | 驱动可恢复维护并返回当前进度；多次调用可能推进新批次 | 按状态重新检查，不宣称一次成功就完成整季工作 |
| 登录／退出 | 当前会话状态；撤销或过期的登录结果不能复活会话 | 旧登录编号对应会话已失效时，显式重新登录 |

现行 P1 排期视图失败使用 `reload_required`，P2 使用 `refresh_required`。为兼容旧客户端保留这些字段；两者都不等于业务写入失败。管理成员及训练补读统一使用 `getMemberWorkspace`，避免名单、报名、排座来自不同串行读取时刻。

## 并发与重试

- 幂等范围包括操作人、赛季／团队、动作和请求编号。相同编号、相同参数重放原计划；编号相同但参数不同返回 `IDEMPOTENCY_CONFLICT`。
- Apps Script 先在同一锁内持久保存计划，再更新业务／审计／完成状态。Cloudflare 业务数据、不可变结果、审计与 outbox 在同一 SQLite 事务提交，外部网络不进入事务。
- 版本格式错误返回 `INVALID_REQUEST`，有效但过期的版本返回 `VERSION_CONFLICT`。版本冲突先刷新并核对，不自动覆盖。
- 网络失败、超时、取消等待、无效响应或可重试后端故障意味着结果可能未知。保留原动作、参数、编号，通过原请求恢复；不能换编号重发。客户端不做隐式自动重试。
- 历史摘要的 JSON 字段顺序、规范化和请求范围是兼容数据，不能为了统一风格改写。新增摘要算法必须带版本并保留旧向量测试。
- 审计分页在每个日志内保持倒序追加顺序，只比较两个日志的队首时间来合并。同时间记录和迟到恢复记录不会漏项；这不是全局按业务发生时间排序的承诺。分页期间审计表不可被人工排序或删行。

## C1／C2 接口设计约束

C1.1–C1.6 已按业务域建立独立请求／响应 DTO、运行时解析、集中动作注册和契约测试；C2 继续沿用这一结构。C2.1 的 `shared/c2-sync-contract.ts` 校验 Google 文件 ID、数字 Sheet tab ID、字段映射、依赖组基线及稳定来源键；同步概览用 `binding_current` 区分旧绑定和当前赛季版本。C2.2 增加 Form 签名读取、分页导入、核查列表、显式关联和默认关闭的轮询。C2.3 的 `check-sheet-differences` 要求当前绑定与 Coach 会话，按登记 Tab 比较 B/C/G；它只写诊断元数据，不修改业务行或 Google。2026-10-01 当前隔离基线：专用 c2test 已部署 Worker 0.17.0-c2-associated-lanes／schema14，轮询关闭、crons=[]。候补递补、关联受控部分写入／丢回复、既存 FAILED 批次暂停排空及独立训练阻塞／恢复已按各自范围验收；并发 SENT 暂停仅有本地真实调用链证据。真实配额耗尽、随机网络故障、自动 cron、restore 和更广实体仍未验收，C2.4／C2.5 整体未完成。见[最新实际报告](../tests/C2-ASSOCIATED-LANE-ISOLATED-ACCEPTANCE-2026-09-30.md)与[当前进度](../CURRENT-STATUS.md)。 冲突业务解决／导入和浏览器同步管理页面仍未实现。年度业务捕获与持久计划已在本地 schema15／50表实现；完整来源、人工映射和 plan-only 审核为内部纯模块，没有年度／来源 HTTP 动作或真实 Coach 认证接线。接口清单不代替运行时类型、授权或来源真实性证明。

新接口统一写入回执与可选视图；异步维护返回任务标识及任务状态。旧动作和历史日志由兼容适配器承接，不破坏重试摘要。接口清单中的服务版本、动作、方法、权限和直接业务错误必须由测试与实现对照；修改 `wrangler.jsonc` 后必须重新生成 Worker 类型。前端接入前验证完整业务响应形状、缓存代次、结果查询权限和浏览器 CORS。C0 探针的成功只证明持久化与桥接机制，不能替代这些业务契约验收。
