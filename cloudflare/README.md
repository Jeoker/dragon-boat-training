# Cloudflare 数据服务

本目录包含业务 Worker／TeamState 与[独立私有来源 Worker／DO](PRIVATE-SOURCE-HOST-DESIGN.md)。Cloudflare 是现行目标后台，生产仍运行 Apps Script；实际部署与验收门槛集中于[当前进度](../CURRENT-STATUS.md)。

## 环境边界

- 默认配置名为 `dragon-boat-training-api-staging`，供本地和隔离 staging 使用。
- `--env c2test` 是专用 C2 隔离环境，独立于默认 staging。production 必须显式使用 `--env production`；三个环境分别拥有自己的 Worker、Durable Object 命名空间、数据和 secret。
- `.dev.vars`、Wrangler 本地状态、干运行产物和覆盖率目录均被忽略。仓库只保留 `.dev.vars.example`。
- `source-private/wrangler.jsonc` 定义独立私有来源 namespace，关闭 routes、workers.dev、预览和 cron；当前只有本地验证，不属于现行业务部署。
- `recovery.wrangler.jsonc`定义独立RecoveryState封存namespace，同样关闭公网和cron；默认无target／digest允许配置，业务无恢复binding，恢复拒绝。配置与发布顺序见[隔离恢复指南](ISOLATED-RECOVERY.md)。
- C0 内部测试入口仅在非 production 且请求提供 `C0_TEST_KEY` 时可用。C1 隔离业务入口另用 `C1_TEST_KEY`，并在内部继续验证 Coach Code 或新后端 session；C2 使用独立 `C2_TEST_KEY`，受保护读取还要求 C1 Coach session。三类入口在 production 均固定返回 `NOT_FOUND`。

## 本地命令

```text
npm run cf:types
npm run cf:check
npm run cf:test
npm run cf:dry-run
npm run cf:bootstrap:prepare
npm run cf:bootstrap:dry-run
npm run cf:private:check
npm run cf:private:test
npm run cf:private:dry-run
npm run cf:recovery:test
npm run cf:recovery:dry-run
npm run cf:dev
npm run cf:accept:c1-staging
```

修改 `cloudflare/wrangler.jsonc` 的变量或绑定后必须重新运行 `npm run cf:types` 并提交生成的 `worker-configuration.d.ts`。契约测试会核对 staging 服务版本、接口清单和生成类型，避免配置与说明静默漂移。

`npm run cf:deploy:staging` 创建或更新隔离 staging。`npm run cf:accept:c1-staging` 使用 Git 忽略的 `.dev.vars` 执行显式远端验收；跨部署只读复验增加 `-- --verify-only`。该脚本不会随普通测试运行。`npm run cf:deploy:production` 只保留为明确的后续命令；C4 前不得用它接管生产业务。Cloudflare 和 Google secret 分别通过平台配置，不写入代码、Wrangler vars 或日志。

账户首次部署还需要在 Cloudflare Dashboard 启用一个 `workers.dev` 子域；Worker 上传成功不代表该公网地址已经可用。已启用环境所需的 `C0_TEST_KEY`、`C1_TEST_KEY`、`COACH_CODE_SECRET`、`SESSION_SECRET` 及测试桥接配置必须用 Wrangler secret 或平台 secret 配置，不能加入 `wrangler.jsonc`。`C2_TEST_KEY` 仅配置在专用 `c2test`；原 staging 目前故意缺少它，C2 入口因此被拒绝。远端验收使用的 `C1_ACCEPTANCE_COACH_CODE` 只放在本地 `.dev.vars`，不上传为 Worker secret，不能当作c2test的隔离Code。Code secret用于迁入／自轮换的凭据HMAC及轮换payload指纹，新后端session使用独立secret。`wrangler dev --remote` 可以验证 Worker 本身，但当前 Wrangler 不支持以该模式访问 Durable Objects SQLite，因此远端 DO 验收必须走已部署的 staging 地址。

## 组件边界

| 组件 | 当前职责 |
|---|---|
| index／TeamState | 固定团队路由、格式／权限、SQLite 初始化及持久调度 |
| C1 服务与 shared DTO | 赛季、排期、报名、排座、冻结历史、审计、保护备份和 Coach 自轮换 |
| C2 同步与 bridge | Form 导入、B/C/G、物理诊断、固定事件导出、暂停／退避及训练通道 |
| 年度 capture／storage | 同事务固定私有业务计划，原 request／text／digest CAS；尚未接年度 Google 输出 |
| source-private | 独立原文／checkpoint／审核 CAS、OAuth、capture-native 及私有 backup |
| RecoveryRuntime／RecoveryState | 业务或私有保护包恢复到独立新空 namespace 并封存，不提供在线激活 |

公开读取不返回草稿／私人来源。所有 C2 入口在 production 拒绝；影子 epoch0 不自动取得生产写入权。API 方法、动作及失败码由[清单](../contracts/README.md)和契约测试与实现对照。

当前源码 schema、远端版本、特性开关和有效证据只看[当前进度](../CURRENT-STATUS.md)及[验证索引](../tests/CURRENT-VERIFICATION.md)，不从源码配置推断已经部署。默认 staging 保留十分钟 cron 配置且 polling 关闭；c2test 与 production 无 cron。显式导出开关不等于自动轮询。

首次 schema16 发布使用[bootstrap 工具](tools/c2-bootstrap.mjs)生成的单环境配置，具体评审与发布前后检查见[首次发布准备](ISOLATED-RECOVERY.md#首次-schema16-发布准备)。工具只提供本地准备和 dry-run，不提供部署动作。

业务事务、同步节奏及切换见[迁移计划](../cloudflare-migration-plan.md)，完整原始来源协议见[来源设计](../tests/C2-ANNUAL-SOURCE-CAPTURE-DESIGN.md)。

## 私有来源运行入口

业务`POST /internal/c2/private-source-run`仅供C2隔离环境，使用现有`C2_TEST_KEY` Bearer传输门，非POST返回405；正文为严格解析的`action`、`request_id`、`season_id`、`session_token`。动作是`pin`、`register`、`capture`、`capture-native`、`stage`、`resume`、`review-view`、`review-append`、`backup`；`register`另带固定`target`，`stage`须显式`confirm_private_journal=true`，`review-append`另带严格审核`command_text`，`backup`須`confirm_private_backup=true`并在导出前后复核当前权限。请求不接受客户端proof、actor、cutoff、binding、generation或epoch；当前Coach会话与服务器原pin决定这些值。

完整接线时，标准c2test配置的`PRIVATE_SOURCE_RUNTIME`指向`dragon-boat-training-source-private-test`的命名入口`SourceRuntime.run`，再进入按team／source operation命名的DO；首次bootstrap配置省略该binding。私有Worker的`BUSINESS_SOURCE_AUTHORITY`反向绑定到`dragon-boat-training-api-c2-test`的`SourceAuthority.pin`，每次权威与依赖访问复核真实TeamState会话和原pin。私有vars为`SOURCE_TEAM_ID`、`SOURCE_BACKEND_GENERATION`、`SOURCE_WRITER_EPOCH`，必须与业务身份相同；绑定只配置在c2test，production入口拒绝。实际接线状态见当前进度。

命名入口、DO命令与内部SQLite store的边界见[私有服务设计](PRIVATE-SOURCE-HOST-DESIGN.md#当前存储实现)；实际运行须沿当前Coach／pin鉴权的命令链。

私有Worker平台secret为`SOURCE_GOOGLE_OAUTH_CLIENT_ID`、`SOURCE_GOOGLE_OAUTH_CLIENT_SECRET`、`SOURCE_GOOGLE_OAUTH_REFRESH_TOKEN`，通过Wrangler secret或Dashboard输入，禁止把secret值写入vars、SQL、普通备份、文档或日志。私有HTTP入口固定404，公网routes、workers.dev、preview、cron和observability关闭；实际部署后另验证不可访问。

capture每次最多启动32个新来源请求；capture-native首次原生请求也计入并在STARTED前预留两个external槽。已确认checkpoint回放不计新请求预算，未决请求拒绝重取。每命令Google API、OAuth及native预留合计最多40次，固定错误为`SOURCE_PRIVATE_RUNTIME_UNCONFIRMED`；权限改变或失败不返回原依赖正文。审核命令第一次完整journal成功后可复用本命令的Google ACL／内容观测，当前Coach／pin／目标／候选／receipt／CAS仍复核，新命令及驱逐重新读Google。原候选及审核全文只由当前Coach受保护读取，不能进入普通业务备份或公开DTO。capture-native原proof／v2候选、旧候选不提升、受控单跳和私有receipt恢复说明见[当前指南](ISOLATED-RECOVERY.md#新capture消费原生证明)，资源门槛见[私有来源设计](PRIVATE-SOURCE-HOST-DESIGN.md)。

## 隔离恢复与原生证明入口

`POST /internal/c2/restore-isolated-backup` 经 C2 传输门及当前 Coach 调用独立 RecoveryRuntime，严格固定 target／digest／来源对象；默认未配置时拒绝。封存恢复不执行业务、Google、cron／alarm，不恢复旧 sessions，也不激活为在线对象。

`POST /internal/c2/native-tab-proof` 通过业务 SourceAuthority 和完整 Apps Script 原生动作核验当前 Tab／Form 关系；独立观察不修改已有候选。新 `capture-native` 才保存首 checkpoint 和 v2 候选，普通 capture 与旧候选不追溯提升。

接口、包及流式预算、原生证明恢复边界与有序隔离发布统一见[当前操作指南](ISOLATED-RECOVERY.md)。运行层已有本地 SQLite／workerd 证据，真实 Google、部署、云端 restore、Free 资源和年度资格分别验收。
