# 隔离恢复与原生Tab证明

本指南维护当前接口与隔离发布门槛。实际生产／远端版本及原包核验状态只看[当前进度](../CURRENT-STATUS.md)，所测范围看[验证索引](../tests/CURRENT-VERIFICATION.md#备份与恢复)。本地实现不表示已部署或执行真实云端恢复。

## 备份范围与恢复结果

业务包为`{manifest,chunks}`，来自当前受保护的C1 `create-backup-snapshot`／`verify-backup-snapshot`／`get-backup-chunk`。schema16清单含51表；不包含`coach_sessions`、`backup_snapshots`、`backup_snapshot_chunks`。凭据salt／digest、原业务／审计／请求／同步记录属于受保护迁移数据，不能公开；明文Code、session token、OAuth secret和私有来源原文不进入此包。

原schema14／47及16／51保护包通过[业务备份CLI](../backend/backup/README.md)下载到仓库外私有路径；显式download创建系统快照，resume绑定原actor／request／身份／schema和首次可信server_time下界，旧请求较早快照拒绝发布；stdout的captured_at保留原时点，不证明下载完成时仍是最新状态。离线verify需要独立保管的预期digest。客户端本地复算全部表／列／块序／数量及摘要，不信远端verified自证；源schema14不升级。离线完整性不证明SQL FK／CHECK或恢复成功，后述真实SQLite封存验证仍须单独执行。

恢复接受exact schema14／47表或16／51表。14包仅把`app_meta.schema_version`改为16，原47表其他行和摘要不变；新年度3表与`source_authority_pins`为空。16包保留51表全部原行。按受审查的固定DDL创建表、FK和索引，不执行包内SQL或未知表／列。目标必须没有用户SQLite对象；摘要、schema／列、chunk数量／次序／offset及全部行核验通过后，同一事务写入、逐行读回、检查FK并写`recovery_seal`。错误、并发或非空目标拒绝，不删除或覆盖原目标。

私有`backup`返回`c2-private-backup-v1`的manifest及base64 chunks，单独保存原key／revision／digest／UTF8 BLOB、未知pending、checkpoint、原候选、journal和审核证据。总原始字节最多16,000,000、record最多128，encoded bundle最多23,000,000字节；超额整个对象拒绝，不能截断。运行时对象256,000,000字节预算不变；更大对象的分页备份／恢复尚未实现。业务包最多30,000,000序列化字节，原payload合计最多29,000,000；恢复HTTP正文及RPC命令均最多30,000,000，为RPC元数据留余量，并在部署时核对平台限制、实际Free CPU及内存。

业务／私有恢复分别返回`ISOLATED_RESTORED`／`ISOLATED_PRIVATE_RESTORED`，均为`execution_enabled=false`、`SOURCE_NOT_VERIFIED`及`annual_export_authorized=false`。RecoveryState是独立封存namespace，没有业务／来源runtime／Google／cron／alarm入口；旧session为空。原generation／writer epoch／source pin及未决请求事实保留，不因此获得当前授权或自动续跑。真实云端恢复、在线激活与写入handoff另须验收。

## 独立Recovery接线

[recovery.wrangler.jsonc](recovery.wrangler.jsonc)定义`dragon-boat-training-recovery-test`、独立SQLite `RECOVERY_STATE`及`BUSINESS_SOURCE_AUTHORITY`→业务`SourceAuthority`。HTTP固定404，routes／workers.dev／preview／cron／observability关闭。现默认没有target／digest允许配置，业务也没有`ISOLATED_RECOVERY_RUNTIME` binding；因此恢复默认拒绝。

准备专用隔离配置时保留独立namespace，并核对：

| 配置 | 含义 |
|---|---|
| `SOURCE_TEAM_ID`、`SOURCE_BACKEND_GENERATION`、`SOURCE_WRITER_EPOCH` | 与业务当前身份完全一致 |
| `RECOVERY_TARGET_NAME` | 独立新对象名，格式`recovery-quarantine-[a-z0-9_-]{8,100}`；对象实际名称也必须匹配 |
| `RECOVERY_BUSINESS_DIGEST` | 独立核验后固定的业务manifest `content_digest` |
| `RECOVERY_PRIVATE_DIGEST` | 独立核验后固定的私有manifest `content_digest` |
| `RECOVERY_SOURCE_OBJECT_NAME` | 私有恢复额外要求原`c2-private-source-v1:<team_id>:<source_operation_id>`，同时匹配当前pin与包 |
| 业务`ISOLATED_RECOVERY_RUNTIME` | Service Binding到`dragon-boat-training-recovery-test`的命名入口`RecoveryRuntime` |

只配置本次恢复类型所需digest；未配类型拒绝。独立可信digest不能从待恢复请求自动采纳。当前Coach及pin在验证前、全部异步摘要后和事务前再次核验；Service Binding本身不替代权限。

`POST /internal/c2/restore-isolated-backup`使用C2_TEST_KEY Bearer传输门，严格正文为：

```json
{"request_id":"recovery_request_0001","season_id":"isolated_season_id","session_token":"<current Coach session>","kind":"BUSINESS","target_name":"recovery-quarantine-example-copy-0001","bundle":{"manifest":{},"chunks":[]}}
```

例中bundle是结构占位，须替换为完整已核验包；`PRIVATE`使用独立私有包。客户端不提供SQL、actor、binding或新generation／epoch。成功返回常规C2 envelope的`data.result`；不能确认时固定`RECOVERY_UNCONFIRMED`。恢复后的同一目标再次恢复拒绝，包括实际驱逐之后。不存在通用激活或自动bootstrap命令。

## 原生响应Tab观察

完整Apps Script后端包含[NativeTabBridge.gs](../backend/src/NativeTabBridge.gs)的`cloudflareReadNativeTabProof`，`build:bridge-probe`产物不含该动作。它通过Form destination、Spreadsheet身份、唯一numeric Tab ID，以及`Sheet.getFormUrl()`→`FormApp.openByUrl(...).getId()`确认当前原生关系；空Tab／同名假Tab／未关联或错Form均拒绝。

业务`POST /internal/c2/native-tab-proof`只接受`request_id`、`season_id`、`session_token`，同样要求C2 transport gate和当前Coach。SourceAuthority在Google前后复核原pin／绑定及当前权限；服务器生成nonce并核验独立HMAC响应域、请求、方向、action、身份与观测时间。请求体最多20,000字节，Google回包流式最多16,000字节；超额取消stream，旧签名不能用于新nonce。

输出是独立的当前关系观察，包含`GOOGLE_NATIVE_TAB_LINK_OBSERVED`及绑定元数据，不包含原回答。沿服务器权威协议取得或首次固定pin，不改写已固定pin。独立观察接口不修改任何已有候选；真实Google调用仍须隔离验收。

## 新capture消费原生证明

业务`POST /internal/c2/private-source-run`显式使用`action=capture-native`，其余字段仍只有`request_id`、`season_id`、`session_token`；客户端不能提供proof、actor、binding或摘要。先登记固定私有target，并沿原pin的actor和request_id调用；刷新会话不改变原操作身份，其他Coach委派尚未实现。

```json
{"action":"capture-native","request_id":"<original pin request>","season_id":"<isolated season>","session_token":"<current Coach session>"}
```

原生观察是逐请求checkpoint的第一条专用请求，固定operation／attempt／authority digest。保存STARTED后才调用可信SourceAuthority，由业务服务器验证Google响应HMAC、nonce、当前绑定／pin和时间，并在前后核验当前Coach。确认返回作为原response持久保存；未知返回拒绝重取。已确认回放在后续REST之前验证原身份、context与观察区间，不生成新nonce、不刷新观察时间。完整两遍REST读取仍沿同一checkpoint执行，不能把首次原生单点观察解释为整个读取区间关联恒定或原子快照。

新候选使用`c2-source-observation-v2`，`response_tab_link_evidence=GOOGLE_NATIVE_TAB_LINK_OBSERVED`；`native_tab_evidence`固定原proof、actor、attempt、authority digest及context／evidence摘要，candidate摘要绑定完整观察。原pin、plan core与source plan摘要不变，避免把proof加入自身所绑定的pin。候选回读核验原观测区间，允许声明的5秒时钟偏差；当前鉴权仍实时复核。普通`capture`及Node CLI保持v1／`SERVER_BINDING_DECLARATION_ONLY`。旧已开始checkpoint不能换模式；已有候选只返回原summary，显式显示原证据等级，不能追溯补证明。

每次最多启动32个新source请求，首次native也计一条。STARTED之前为native预留两个external请求槽；Google API、OAuth及该预留合计每命令最多40。原生桥使用同一20秒deadline，仅接受302／303至`https://script.googleusercontent.com/macros/echo`的一次GET跳转，取消跳转body并拒绝第二跳或其他host／path；这些是当前受控实现边界，不是对Google所有跳转行为的保证。OAuth与直接REST仍拒绝跳转。

Google journal仅保存原core。原生观察及receipt的恢复权威在私有DO原candidate／checkpoint及完整私有backup，Google core单独不足以恢复或重建原生证明。来源记录仍为`SOURCE_NOT_VERIFIED`，原Sheet仍为`PRIVATE_PENDING`，`annual_export_authorized=false`；内层LOCAL内容／映射provenance不因原生关系观察而升级。真实Google、云端恢复、Free资源及整体来源资格各有独立门槛。

## 隔离发布顺序

1. 用[业务备份CLI](../backend/backup/README.md)取得与当前远端schema／身份匹配的保护包，完整核验并独立保管可信摘要；既有原包的实际证据见验证索引。下载不刷新全部同步状态或证明云端恢复，本地fixture不能替代真实原包演练。
2. 原包离线核验及本地SQLite演练通过后，按[首次发布准备](#首次-schema16-发布准备)生成并评审业务schema16配置。首次提供SourceAuthority时，专用配置省略`PRIVATE_SOURCE_RUNTIME`与`ISOLATED_RECOVERY_RUNTIME`两个尚未发布服务的binding，保持所有polling和自动导出关闭。演练不覆盖云端鉴权／namespace接线；实际云端恢复在第4步，不能要求用未发布入口提前轮换。
3. 新业务路由可用后，刷新匹配当前schema16／Coach version的51表保护包并独立核验，按[自轮换指南](../backend/coach/README.md)先执行CLI `prepare`检查保护包、当前Coach、schema及服务身份；准备不提交轮换、撤销会话或预留未来授权，也不代替业务冻结与差异核对。前置通过后显式轮换Cloudflare当前Coach，确认新Code登录和原会话拒绝，再下载新保护包核对原包会话行没有缺失、该Coach全部旧version会话均已撤销；单个会话回查不能代替全量census。Code只在私有配置输入，unknown恢复原receipt及v2原会话回查，不重复轮换；保留原credentials文件，既存v1恢复不追溯补原会话证明。生产Apps Script Code及Git历史独立处理，是否实际执行只看当前进度。
4. 使用独立恢复配置固定target／可信digest／身份和已存在SourceAuthority回调；先`npm run cf:recovery:dry-run`，再对专用配置执行`npx wrangler deploy --config <isolated recovery config>`。随后给业务c2test配置增加上述命名恢复binding，dry-run后发布。只在隔离服务执行保护包恢复与封存／逐表对账、公网拒绝验收。
5. Google账号管理者核对项目、Forms／Sheets／Drive API、consent／audience／scopes和owner权限，私下注入`SOURCE_GOOGLE_OAUTH_CLIENT_ID`、`SOURCE_GOOGLE_OAUTH_CLIENT_SECRET`、`SOURCE_GOOGLE_OAUTH_REFRESH_TOKEN`。登录／probe／refresh适配通过不等于真实云授权通过；测试consent token的7日过期和长期授权策略须由管理者核实。
6. 私有来源Worker先回绑已存在SourceAuthority、部署独立namespace，再由业务启用`PRIVATE_SOURCE_RUNTIME`→`SourceRuntime`。每份实际配置先dry-run；当前仓库c2test配置已声明来源binding，首次发布不能直接忽略服务不存在的依赖。完整backend构建的原生动作须单独发布到隔离Google项目，保留其Web App manifest及secret；probe不能替代。
7. 验证当前授权、公网404、真实原生观察／新capture消费、capture／journal／审核及故障恢复、独立私有云restore。记录Free账户共享存储、CPU／内存、SQL计量、连接和最大真实包。通过后再做在线激活handoff、审核页面、来源资格及年度导出；本地测试不开放这些门槛。

本地复核命令：`npm run cf:recovery:test`、`npm run cf:recovery:dry-run`；其他Worker和完整后端命令见[Cloudflare说明](README.md#本地命令)及[后端说明](../backend/README.md)。实际完成状态由当前进度维护；运行前重读远端身份、版本、当前队列和保护包。

## 首次 schema16 发布准备

[bootstrap 工具](tools/c2-bootstrap.mjs)从当前 `wrangler.jsonc` 只提取 c2test，生成 `cloudflare/.bootstrap-c2test/wrangler.json`，保留既有 Worker 名、TeamState SQLite namespace、team／generation／epoch和人工导出开关。它移除两个尚未接通的 runtime bindings，显式设定 `crons=[]`、两个 polling 开关为 false，关闭预览、额外路由和日志采集。默认 staging 的 cron 和 production 环境不进入生成配置。人工导出仍需显式操作，不在本步骤执行。

工具拒绝未知配置键、变更身份／namespace、namespace迁移、未知或重复服务绑定、自动轮询、cron和vars中的secret。后续配置变化须先调整并评审工具，不能删除检查以通过生成。原配置不修改，私有文件不读取；产物和Wrangler日志全部被Git忽略。

```powershell
npm run cf:bootstrap:prepare
npm run cf:bootstrap:dry-run
```

prepare生成配置及原配置／生成配置摘要。dry-run每次重新生成配置，固定调用本地Wrangler的 `--dry-run --env=`，核验bundle导出 `SourceAuthority` 与 `TeamState`，再记录bundle摘要和字节数。manifest只表示当前配置和本地打包结果，不固定后续变更的源码，也不证明远端可发布或已部署。源码／配置变化后重新dry-run并评审生成配置、manifest和bundle；保持当前service version不变，发布后必须受保护读取schema并核验新路由，不能用health的版本字样证明升级。

| 阶段 | 必须满足的检查 |
|---|---|
| 发布前 | 当前受保护身份、完整赛季列表与同步队列重新读取；保管本次新保护包及独立可信摘要，完成原包SQLite演练；核对Cloudflare账号、现有namespace、secret和部署目标 |
| 配置评审 | 固定c2test身份、既有TeamState、无runtime服务、无cron／polling；原环境人工导出开关保持；产物摘要与这次dry-run一致 |
| 实际隔离发布 | 上述检查通过后，显式使用 `npx wrangler deploy --config cloudflare/.bootstrap-c2test/wrangler.json --env=`；该命令更新既有c2test，工具自身不执行它 |
| 发布后 | 沿发布前同一会话受保护读取schema16／当前Coach；获取51表新保护包并按[离线对账协议](../backend/backup/README.md#首次升级的离线对账)核对原47表，仅schema标记与原快照自身请求／审计／任务追加；新4表为空；验证新路由与未接通runtime拒绝，核对原namespace／secret、cron／polling，最后退出会话 |

本地schema升级只证明 `applySchema` 的增量DDL、旧行／session保持、幂等及失败回滚；TeamState构造器仍会维护已有任务和alarm，实际发布不是业务冻结或“零写入”。旧session在schema升级中保留，到自轮换步骤才撤销。新路由的实际云鉴权、绑定、恢复和Google调用不能由本地测试代替。部署失败或返回未知时先检查现有部署和受保护schema，不重复创建namespace或改generation；schema已升级时不得直接回退到仅支持14的代码。

配置继承和namespace生命周期按[Wrangler官方配置](https://developers.cloudflare.com/workers/wrangler/configuration/)核对；本工具生成单环境配置，避免依赖非继承bindings／vars或意外使用默认staging。
