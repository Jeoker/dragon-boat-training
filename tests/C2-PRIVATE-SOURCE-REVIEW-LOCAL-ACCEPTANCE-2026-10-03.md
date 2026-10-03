# C2.6 已认证私有来源审核与持久 CAS 本地验收

日期：2026-10-03。承接[内部 HTTP 与私有 runtime 验收](C2-SOURCE-TRANSPORT-LOCAL-ACCEPTANCE-2026-10-03.md)，将原已确认候选读取和人工映射审核接入私有持久存储。本轮没有读取 OAuth 文件、访问真实 Google、写入原私有验收目录或部署远端。测试使用虚构来源、模拟 Google journal、真实本地 Worker HTTP／SQLite 会话及临时文件 CAS。

## 已实现

[`PrivateSourceOperation.readForReview`](../backend/source-journal/operation.ts) 强制要求已配置认证权威检查和原 `JOURNAL_READBACK_CONFIRMED` 候选。读取原 candidate／receipt，回读原 journal，核对当前私有权限、完整内容、原摘要和当前服务器权威；不能由审核触发重新采集、stage 或替换目标。没有鉴权端口的独立测试 operation 不允许提供审核来源。

[`PrivateSourceReview`](../backend/source-journal/private-review.ts) 复用现行完整 retained plan 验证与审核链，不建立另一套来源验证规则。`view()` 返回原完整 raw／schema 候选及双方内容摘要；`append(commandText)` 在独立私有 CAS ledger 保存人工责任声明。actor 来自原已认证来源上下文，时间来自私有 host；浏览器不能提交 actor、已核验证明或年度授权。

ledger key 按 team 和原 source operation 固定，身份摘要绑定完整私有上下文、原 candidate、source plan 和 receipt。首次空 ledger 为 revision1，证据数为 revision减一；已有 ledger 必须核验完整结构、原锚、摘要、全链、原记录定位和一对一约束，篡改后不重写或自动修复。原 source operation、candidate 和 journal 内容不因审核改变。

每次入口、保存前和返回前检查当前权威及原 journal 权限／内容。完整输出的2 MB预算在证据 CAS 前验证；ledger仍受512 KB及1000条证据上限约束。新证据时间不得早于原捕获结束或前一条审核。不同新请求的 CAS 失败不自动重排；相同请求并发或确认丢失恢复已保存的原时间／证据。后来追加审核后，旧请求仍返回原派生 prefix，同时外层 ledger version 表示当前完整 ledger。

所有异常为固定 `SOURCE_PRIVATE_REVIEW_UNCONFIRMED`，不暴露依赖错误正文。保存后失去权限可能已留下合法证据，但不能返回私有结果；恢复权限后以同一请求重放。外部权限、Google IO 与本机 CAS 不是同一分布式事务，最后检查后发生的新变化不能获得原子性保证。

## 私有 host 用法

此组件只供可信私有 host 调用，没有新增公开／管理 HTTP 审核路由或浏览器页面。沿上一报告完成 origin、当前 Coach 凭据、原目标登记、独立 OAuth 和仓库外私有 store 配置后：

```ts
const operation = await createPrivateSourceRuntime(ports);
// 原候选已 capture、stage 或 resume 至 JOURNAL_READBACK_CONFIRMED。
const review = new PrivateSourceReview(operation, ports.store, text => ports.hash(text));
const view = await review.view();
// 私有审核者检查双方完整内容；command 只含现行允许字段。
const result = await review.append(commandText);
```

原 capture actor 是本阶段的审核 actor；尚未实现其他 Coach 的审核委派。host 需要保持这些端口的真实认证和私有目录权限，不能用测试中的声明 callback 代替认证。原实际隔离 journal 使用测试 actor／cutoff／census，不能原地升级为真实业务服务器 capture。

内层保留兼容的 `LOCAL_REVIEW_PLAN_ONLY` 和 `LOCAL_INPUT_DECLARATIONS_ONLY` provenance；外层明确 `PRIVATE_REVIEW_LEDGER_DURABLE_ONLY`／`RETAINED_PLAN_ONLY`。人工证据为 `HUMAN_ATTESTED`，不自动证明关联客观正确或消除来源缺口。来源始终 **SOURCE_NOT_VERIFIED**，原 Sheet 行保持 **PRIVATE_PENDING**，年度导出 **false**。

## 验证证据

[`c2-private-source-review.test.mjs`](c2-private-source-review.test.mjs) 的14项测试覆盖：

- 必须鉴权且原 journal 已确认；原内容不改写、不重读来源。
- 持久审核、服务重建、旧请求后续追加后的原 prefix／时间及一对一约束。
- CAS失败、保存后丢确认、相同请求并发收敛与不同请求竞争不覆盖。
- hash期间及保存后的权限撤销、journal权限／内容变化；固定错误不带私有依赖正文。
- 原 ledger 身份、revision、结构、预算、摘要和自洽重算后的链篡改拒绝。
- 无效／早于捕获的时钟拒绝；本地文件服务重建及两个独立 Node 进程零来源重读、零 journal 写入地恢复原证据／派生摘要。

[`c2-source-authority.test.ts`](../cloudflare/test/c2-source-authority.test.ts) 新增1项真实本地 HTTP＋SQLite组合测试：C2 gate和实际签名 Coach 会话驱动原 candidate／journal及人工审核；actor取服务器，原请求重放不追加；SQL撤销实际会话后view／append均拒绝，原ledger不变。Google来源和journal仍为虚构模型。

完整 Node **488／488**，Workers **24文件276／276**，独立严格source／Worker类型检查通过。Astro145文件、三页构建、Apps Script和probe构建、Worker dry-run通过；测试夹具一处await提示已修正并复查。文档链接与diff检查通过。

## 接续边界

本地已认证读取和持久审核 CAS 完成。长期私有 host运行入口／部署、公网 TLS与实际服务器来源 capture、可信原生响应 Tab 关联、全部逐块故障及年度业务receipt仍各自需要验收；本机文件CAS不等于多机高可用或断电保证。没有提交、推送、生产切换或远端部署，既有未提交改动保留。远端基线引用此前报告，仍为c2test0.17／schema14／47表，未在本轮复读。

后续实施以[当前进度](../CURRENT-STATUS.md)及[来源技术设计](C2-ANNUAL-SOURCE-CAPTURE-DESIGN.md)为准。
