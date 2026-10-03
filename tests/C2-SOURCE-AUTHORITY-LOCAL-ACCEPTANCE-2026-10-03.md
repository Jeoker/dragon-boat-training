# C2.6 服务器来源上下文本地验收

日期：2026-10-03。承接[来源 checkpoint 真实隔离恢复](C2-SOURCE-READ-CHECKPOINT-ISOLATED-ACCEPTANCE-2026-10-03.md)，本轮补服务器权威来源上下文及私有操作组合。仅执行本地测试与构建，没有调用 Google、读取现有 OAuth、部署 Worker 或修改生产。

> 本报告保留本次来源 pin 切片的历史边界。同日后续已加入内部 HTTP、私有 HTTPS 客户端、持久目标登记及强制 checkpoint 的 runtime 组合，见[后续本地验收](C2-SOURCE-TRANSPORT-LOCAL-ACCEPTANCE-2026-10-03.md)；后续仍未部署远端或长期私有服务。

## 实现范围

[`C2SourceAuthority`](../cloudflare/src/c2-source-authority.ts) 复用 C1 的真实签名会话鉴权与事务内会话复验。命令仅接受 request ID、session token 和 season ID；actor、source operation ID、cutoff、来源绑定、generation／epoch 与已知 census 均由服务器派生，不接受浏览器提供的名单、来源目标或证明。

1. 赛季必须 COMPLETED 或 ARCHIVED 且精确截止已到，赛季与同步绑定版本一致。固定当前 Form／Spreadsheet／数值 Tab ID 及响应 Tab 标题声明，拒绝无效目标或未知绑定。
2. 同事务读取全部数据库已知来源，不筛掉旧 binding、REVIEW_REQUIRED 或停用成员。FORM_RESPONSE 必须证明当前 Form 的稳定身份，LEGACY_ROW 保留原外部 key，缺少 IMPORTED 关联的成员成为 UNMAPPED_MEMBER。导入关联必须指向该赛季已有成员；无法对应的旧 Form ID 整份拒绝。
3. 来源数量和字节聚合在 ID 集合物化前检查，最多5000个已知项／成员，完整 pin 上限2 MB；保存的 pin 先核字节预算，再加载并验证 canonical 内容与摘要。原回答、姓名、source observation 和会话 token 不进入此表。
4. 同一赛季只固定一个原 actor／request scope。并发同请求归并原 pin；不同请求不得替换，同请求跨赛季拒绝。DO 驱逐后恢复原 pin；后来新增 ID 不追加原 census。恢复继续检查当前会话与绑定、cutoff、标题、generation／epoch。

[`shared/c2-source-authority-contract.ts`](../shared/c2-source-authority-contract.ts) 定义严格固定格式与摘要域 `c2-source-authority-pin-v1`。新 [`source_authority_pins`](../cloudflare/src/schema.ts) 表使本地 schema 升为16；[`C1HistoryService`](../cloudflare/src/c1-history-service.ts) 的完整备份扩为51表。迁移保持增量事务，错误回滚，遇到不兼容的已有表拒绝升级并保留其内容。

[`createAuthorizedSourceOperation`](../backend/source-journal/authority-context.ts) 组合可信已认证服务器 pin 与私有目标登记，派生现有私有操作上下文。登记固定 source operation、attempt、API owner、journal Spreadsheet／Tab；初始化前快照登记，digest 验证不赋予任意对象身份可信度。初次 capture 的人工映射声明为空，后续审核仍须走独立只追加协议。

[`PrivateSourceOperation`](../backend/source-journal/operation.ts) 在读取前、候选保存前、journal 调用前及回执保存前调用权威复验端口。新 factory 强制配置此端口；现有隔离测试仍可直接构造没有认证端口的 operation，该构造方式不作为已认证服务入口。已保存候选不重新采集；权限丢失或私有登记变化停止。若 write-start 已保存后检查失败，原 marker 保留且不调用 Google；之后只能 resume 原目标，NOT_FOUND 不转为重新 stage。该保守状态可能需要未来显式人工恢复协议，本轮不自动清理或放开重复写入。

## 验证结果

新增[13项 Workers 测试](../cloudflare/test/c2-source-authority.test.ts)及[8项私有组合测试](c2-source-authority-context.test.mjs)，全部使用虚构身份与本地模拟来源。

| 场景 | 结果 |
|---|---|
| 真实 C1 登录、服务器派生完整 census | 包含旧绑定、review、legacy、停用及未关联成员；无姓名或 token |
| 新 ID 到达、并发同请求、DO 驱逐 | 恢复原 pin、原时间与原 census |
| 伪造／撤销会话、请求 scope 冲突 | 拒绝，不创建替代 pin |
| 未结束赛季、未来截止、绑定不符、非规范 Tab ID | 拒绝且没有持久 pin |
| 当前来源／截止／标题／generation／epoch 变化 | 恢复拒绝 |
| SHA 等待期间 census 变化或退出 | 原事务不发布 pin |
| 超5000项、错误稳定身份、保存的 pin 篡改 | 拒绝，不提供部分有效结果 |
| 实际 SQLite 会话与私有 controller 组合 | 撤销会话阻止 candidate 发布或 journal 调用；固定候选只读一次 |
| 登记对象异步变化、登记目标改变、依赖错误 | 使用原快照或安全拒绝，不泄漏错误正文 |
| write-start 后失去权限 | 不调用 Google，保留原 marker，恢复不重新 stage |
| schema15→16、post-DDL 故障、不兼容旧表 | 正常升级或全事务回滚；原成员和不兼容旧内容保留 |
| 非空 authority pin 的完整备份 | 51表 manifest 包含原元数据，没有来源正文 |

完整 Node **461／461**，零失败或跳过；完整 Workers **24文件／272测试**通过。`npm run source:check`、`npm run cf:check` 均通过。Astro **139文件，零错误／警告／hint**，三个页面构建通过；backend、C0 probe 构建及 Worker dry-run 通过。收尾时单独复跑的2项文档脚本／链接检查及 diff 检查均通过。

Workers／构建使用获准的本地缓存写权限。没有提交、推送或部署；最新远端证据仍为 c2test 0.17／schema14／47表，并非本轮实时远端读取结果。

## 接续边界

服务器模块尚未加入 HTTP 路由，私有 controller 使用 callback 组合，未实现已认证跨服务 transport、长期私有服务存储或固定目标登记的部署。测试内存 CAS 只验证组合控制流程，已有私有文件存储的跨进程证据仍按原报告引用，不扩称多机高可用。

数据库已知 census 不证明完整历史，绑定与 Tab 标题不证明 Google 原生响应关联，digest 不认证外来对象，两遍相同读取不证明跨源原子性。会话复验与外部 IO 不在同一分布式事务中；未来 transport 和私有 runtime 必须继续执行权限／目标核验。

来源仍为 **SOURCE_NOT_VERIFIED**，全 Sheet 资格仍为 **PRIVATE_PENDING**，年度导出 **false**；未发布 SOURCE_CAPTURE_FIXED 或 SOURCE_VERIFIED。本地端口完成不代表 C2.6 整体完成。下一步按[当前进度](../CURRENT-STATUS.md)实施可信 transport、长期私有存储、可信 Tab 关联、已认证私有审核与只追加持久 CAS，再验收年度业务 receipt 和公开发布。
