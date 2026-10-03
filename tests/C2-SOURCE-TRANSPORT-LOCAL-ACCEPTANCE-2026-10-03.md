# C2.6 内部 HTTP 与私有 runtime 本地验收

日期：2026-10-03。承接[服务器来源 pin 本地验收](C2-SOURCE-AUTHORITY-LOCAL-ACCEPTANCE-2026-10-03.md)，继续实施受保护的来源上下文传输、固定私有目标登记及完整 runtime 组合。本轮没有访问真实 Google、读取 OAuth 文件、写入原私有验收目录或部署远端；所有 Google 请求均由虚构 REST 模型响应。

本文保留接线切片的474／275测试基线和当时下一步。随后已认证候选读取及持久审核CAS的最新本地证据见[私有审核验收](C2-PRIVATE-SOURCE-REVIEW-LOCAL-ACCEPTANCE-2026-10-03.md)，后续状态以[当前进度](../CURRENT-STATUS.md)为准。

## 已实现的接线

[`/internal/c2/pin-source-authority`](../shared/c2-actions.ts) 新增到可执行路由与 [API manifest](../contracts/api-cloudflare-c2.json)。路由沿既有 C2 transport gate，并由 `C2SourceAuthority` 检查当前 C1 Coach 会话；生产继续返回404。它只接受原 request／season／session，返回固定 pin，拒绝 actor、census、目标或 proof 等额外字段。pin 表仍只有来源 ID 与权威元数据，未新增 schema 或扩大51表备份中的正文范围。

路由固定或重放服务器权威，不调用 Google、不消费 outbox、不触发业务任务修复。既有 C2 contract version 保持兼容，只追加动作；service version 仍沿各环境现有配置，并不表示新路由已经部署。manifest 同步新增错误码，同时修正独立训练通道及 outbox retry 仍被描述为“仅本地”的过时信息，依据原隔离实际报告，未做新的远端复验。

[`SourceServerAuthorityClient`](../backend/source-journal/server-authority-client.ts) 是私有 Node 客户端。私有配置固定 HTTPS origin、team、backend instance／generation／epoch；每次调用从独立凭据端口取得当前 C2 transport key 和 Coach session。origin 不允许凭据、路径、query、fragment 或非标准端口；session 不进入 URL、文件或错误正文。客户端禁止重定向，设置三十秒超时、no-store，并检查 HTTP 状态、JSON 类型、完整 envelope、request／contract 与后端身份、pin 语义和摘要。未知响应不自动换 request 或重试。

完整响应含 envelope 最多2 MB，按实际 stream 字节计量，严格 UTF8、decoded duplicate keys、深度和有限数值扫描先于 JSON 使用。失败响应的 body 取消而不读取或记录；错误统一为固定私有错误。该 envelope 上限可能拒绝接近2 MB的合法 pin，不能据此截断 census、换请求或弱化预算。

[`PrivateSourceTargetRegistry`](../backend/source-journal/target-registry.ts) 在独立 hash key 域内保存不可替换的服务器 pin、attempt、API owner、私有 journal Spreadsheet／Tab。目标来自私有管理登记，不从浏览器请求取得，也不创建新 Google 文件。记录使用既有私有 CAS 端口，首次 revision1 保存后不能修改；同一身份重放恢复原目标。读取复核完整身份、pin 摘要、登记摘要和目标约束。确认丢失后恢复原记录，不另选目标；不同 attempt、owner 或目标整份拒绝。

[`createPrivateSourceRuntime`](../backend/source-journal/private-runtime.ts) 将认证端口、登记、私有存储、独立 Google OAuth 端口、完整 REST reader、checkpoint 和 journal 组合为可调用的私有操作组件。完整来源读取强制使用 `PrivateSourceReadAttempt`，不能省略逐请求持久进度。每个实际 Google 请求前后都复验当前服务器 pin 与原登记；请求后失去权限时取消 body，并保留原未确认 marker。原固定候选、未知 journal 写入及原 receipt 仍沿旧 operation 恢复，不重新采集或重复写入。

## 私有 host 的调用顺序

该顺序说明 TypeScript 组件的组装方式，不是已经部署的服务或 CLI。配置、凭据、目标及目录均由私有 host 管理；不得把示例端口改为直接接收浏览器参数。

```ts
const client = new SourceServerAuthorityClient(privateServerConfig, currentCoachCredentials, sha256);
const registry = new PrivateSourceTargetRegistry(privateServerConfig.team_id, privateStore, sha256);
const authorize = () => client.pin(originalRequestId, originalSeasonId);

// 仅首次私有管理登记执行；重复登记必须与原记录完全相同。
await registry.register(await authorize(), registeredPrivateTarget);

const operation = await createPrivateSourceRuntime({
  authorize,
  registeredTarget: id => registry.get(id),
  store: privateStore,
  hash: sha256,
  oauthToken: currentGoogleToken,
});
await operation.capture();
// 有明确的私有 journal 写入授权后才能 stage；未知结果仅 resume 原目标。
```

`privateStore` 须位于仓库外受保护目录，复用 `createPrivateFileOperationStore` 可提供本机 CAS、文件刷新与原子 rename。登记、operation 和 transcript 使用不同 key 域；不会保存 C2 key、Coach session 或 OAuth token。原正文和私有定位仍不得进入 Worker／DO、公开视图、日志或 Git。

## 验收结果

新增[13项 Node 测试](c2-source-server-transport.test.mjs)，[Workers 来源测试](../cloudflare/test/c2-source-authority.test.ts)新增3项，原13项保持。新测试涵盖以下场景。

| 场景 | 实际结果 |
|---|---|
| 当前凭据与固定 HTTPS 请求 | request 不变，凭据只在 header／受保护 body，每次重新取得 |
| 错 request／contract／backend／team／season／digest | 拒绝，不返回可信 pin |
| 不安全 origin、额外字段、非法凭据 | 发出请求前拒绝 |
| 重定向、403／500、非 JSON、非法 UTF8、duplicate keys、超预算 | 固定错误，不读取错误正文或返回部分 census |
| 响应 body 清理异常、伪造登记错误和 code getter | 固定错误，不透传外来正文或执行诊断 getter |
| 真实本地 Worker HTTP 鉴权 | 缺 C2 key、伪造／撤销会话、GET、production、浏览器 authority 字段均拒绝 |
| HTTP pin 重放与任务保护 | 原 pin 相同，scheduled_jobs 行保持，零 Google 调用 |
| 并发登记、不同 attempt／owner／目标／pin | 相同登记归并一个记录，替换拒绝 |
| 登记保存成功后确认丢失、内容篡改 | 原登记恢复或安全拒绝 |
| 独立 Node 进程与实际私有文件 CAS | register、新进程 get、再新进程 register 恢复同一目标，替换拒绝 |
| HTTPS 客户端、登记、私有 controller | 采集一次、journal 写一次、原目标恢复 |
| 完整 runtime 两遍 REST 来源与强制 checkpoint | 持久保存原全部返回、结束时间和零 pending；固定候选不重采集 |
| 来源请求后撤销权限 | 不发后续来源请求，不发布完整 candidate，保留原 pending |
| range 返回已保存但确认丢失 | 重建 runtime 复用原页／range，只读未开始部分 |
| journal 已写、回复丢失且读回暂时失败 | 重建 runtime resume 原目标，总写请求仍一次 |
| 真实本地 HTTP＋登记＋完整 checkpoint runtime | 成功链贯通；实际会话撤销后的第一个来源页停止，raw/token 不进入 DO |

最后一项使用真实本地 Worker 与 SQLite 会话，通过直接 Request 端口接私有客户端；Google 仍为 REST 模型。workerd 的 Request 不支持私有 Node 客户端所用的 redirect=error，测试端口只转换本地 Request 支持的参数、不发网络请求；Node transport 测试另核 redirect=error。没有把该直接调用写成公网 TLS 或远端部署实测。

完整 Node **474／474**，零失败或跳过；完整 Workers **24文件／275测试**通过。最后错误清理补强后完整 Node 与类型再次通过，受影响的16项 Workers 来源／HTTP／runtime 测试再次通过。`npm run source:check`、`npm run cf:check`、Astro **143文件零错误／警告／hint**及三页构建通过；backend、C0 probe 构建和 Worker dry-run 通过。API manifest 的11项一致性测试在修正说明后再次通过，文档链接与 diff 检查通过。

新增范围无真实账号或文件写入；独立进程测试只使用临时虚构私有目录。没有提交、推送或部署，既有未提交改动保留。最新远端基线引用原验收，仍为 c2test 0.17／schema14／47表，未在本轮实时复读。

## 继续实施的边界

内部路由、客户端和 runtime 组件已本地接通，私有 host 配置、运行入口、长期服务部署及公网接线验收尚未完成；已有本机文件 CAS 不等于多机高可用或断电恢复保证。不得因本地路由存在就把 Pages 接到未验收的新后端。

每次鉴权检查与 Google IO 仍不是同一分布式事务，不能承诺在远端撤销的瞬间已开始请求必然取消。已知 census 不证明完整历史，来源 Tab 仍只有服务器绑定声明；两遍读取不证明跨源原子性。只追加审核、持久 CAS、可信原生 Tab 关联及年度业务 receipt 仍按[技术设计](C2-ANNUAL-SOURCE-CAPTURE-DESIGN.md)实施。

来源仍为 **SOURCE_NOT_VERIFIED**，全部 Sheet 原行保持 **PRIVATE_PENDING**，年度导出 **false**。下一步补已认证私有候选读取与持久审核，再准备长期服务和实际服务器来源验收；接续以[当前进度](../CURRENT-STATUS.md)为准。
