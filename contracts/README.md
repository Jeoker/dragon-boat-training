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

C1.1–C1.6 已按业务域建立独立请求／响应 DTO、运行时解析、集中动作注册和契约测试；C2 继续沿用这一结构。C2.1 的 `shared/c2-sync-contract.ts` 校验 Google 文件 ID、数字 Sheet tab ID、字段映射、依赖组基线及稳定来源键；同步概览用 `binding_current` 区分旧绑定和当前赛季版本。C2.2 增加 Form 签名读取、分页导入、核查列表、显式关联和默认关闭的轮询。C2.3 的 `check-sheet-differences` 要求当前绑定与 Coach 会话，按登记 Tab 比较 B/C/G；它只写诊断元数据，不修改业务行或 Google。成员、排期、报名排座导出及暂停／重试接口的隔离验收和剩余运维门槛见[当前进度](../CURRENT-STATUS.md)。冲突业务解决／导入和浏览器同步管理页面仍未实现。

C2.6 当前源码为schema16，业务备份覆盖51表，排除coach_sessions及备份自身两表；年度业务捕获与持久计划、来源权威元数据已有本地实现。`/internal/c2/pin-source-authority`已列入[C2接口清单](api-cloudflare-c2.json)，须同时通过C2 transport gate与当前Coach会话，只返回服务器固定的权威元数据，不调用Google或返回原始回答。该接口与私有HTTPS客户端、固定目标登记及强制checkpoint的运行组合已有[本地验收](../tests/CURRENT-VERIFICATION.md#来源采集与审核)。已认证原候选读取和只追加审核CAS已在私有Node组件中[本地验收](../tests/CURRENT-VERIFICATION.md#来源采集与审核)，并接入下述私有命令入口；浏览器审核页面与年度导出动作未接入。当前远端版本、实际服务器来源采集和未完成门槛统一见[当前进度](../CURRENT-STATUS.md)。接口存在不代表远端部署、Pages接入或来源核验；生产仍拒绝C2路由。

新接口统一写入回执与可选视图；异步维护返回任务标识及任务状态。旧动作和历史日志由兼容适配器承接，不破坏重试摘要。接口清单中的服务版本、动作、方法、权限和直接业务错误必须由测试与实现对照；修改 `wrangler.jsonc` 后必须重新生成 Worker 类型。前端接入前验证完整业务响应形状、缓存代次、结果查询权限和浏览器 CORS。C0 探针的成功只证明持久化与桥接机制，不能替代这些业务契约验收。

`/internal/c2/private-source-run`是隔离私有命令入口，传输门和当前Coach会话共同保护；内部经双向命名Service Binding复核原pin，非POST返回405。严格命令、secret配置和原操作恢复说明见[运行入口](../cloudflare/README.md#私有来源运行入口)。它支持固定目标、capture／显式capture-native、journal、原候选审核及显式confirm_private_backup的独立backup。capture-native不接收客户端proof，固定可信业务回调的首个原生观察及原checkpoint；v2 candidate绑定观察摘要，原pin／plan hash不变，旧候选不回填。summary显式返回原response_tab_link_evidence；未知请求不重取、已确认回放不刷新proof。Google journal core不含原生receipt，恢复依赖私有DO／完整私有backup。Google为传输模型，不提升来源或年度资格；尚无真实云验收或浏览器审核页面。

`/internal/c2/restore-isolated-backup`仅在配置命名RecoveryRuntime、固定可信target／digest及当前Coach复核后恢复BUSINESS／PRIVATE包到新空封存namespace；默认无接线／允许配置即拒绝。schema14原47表只升级app_meta到16、新4表空，schema16保留51表，旧session不恢复。私有包上限16,000,000原字节／128条及23,000,000 encoded字节，整对象超额拒绝，不等于256,000,000运行时范围全部可备份。它没有在线激活语义。

C1业务保护包用[备份CLI](../backend/backup/README.md)从固定c2test下载，显式create产生系统快照／请求／审计／finalize记录，不改训练业务。原actor／request／schema决定snapshot，未知创建回复不换ID；首次可信server_time下界持久固定，旧请求较早快照拒绝，resume保留原下界及captured_at。客户端独立核验原schema14／47或16／51完整表／列／ordinal／字节摘要，verify离线需要独立保管的预期digest；不因远端verified或包自报digest而采纳新信任。输出保留原包，不执行SQL或升级14，真实FK／CHECK／索引及事务恢复仍由RecoveryState验收；来源／年度授权不变。

C1专用[Coach自轮换](../backend/coach/README.md)在当前session下prepare／rotate，不能传其他actor；服务HMAC指纹固定payload，交易重验全凭据census并CAS原version＋1、撤销自身全部旧sessions、保存无Code／token的原receipt／audit。确认原操作必须new Code登录后的当前session与同payload，读receipt不再次轮换；CLI UNKNOWN绝不自动重提交。只处理Cloudflare，不清理Apps Script或Git历史，不提升来源／年度资格。

`/internal/c2/native-tab-proof`只接受request_id／season_id／session_token；官方Google原生关系通过独立签名域、servernonce／方向／action／时间和当前binding／pin核验。前后当前Coach复核，已固定pin不改写，独立观察接口不改变候选。新capture-native沿可信同名RPC消费首个观察，当前pin限原actor／request；其他Coach委派未实现。严格恢复包／资源门槛、受控单跳边界及配置见[当前使用指南](../cloudflare/ISOLATED-RECOVERY.md)。仍保持SOURCE_NOT_VERIFIED和annual_export_authorized=false。
