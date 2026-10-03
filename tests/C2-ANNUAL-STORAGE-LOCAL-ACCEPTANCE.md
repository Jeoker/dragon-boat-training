# C2.6 持久年度计划 - stage 2 本地验收

日期：2026-10-01。依据 [capture／storage设计](C2-ANNUAL-CAPTURE-STORAGE-DESIGN.md)及 supervisor 明确 stage 2 授权。本地 application schema15，protected backup清单50表；远端 c2test 实际验收仍为 schema14／47表。已完成的 [v14隔离通道报告](C2-ASSOCIATED-LANE-ISOLATED-ACCEPTANCE-2026-09-30.md)及私有最终包不因本切片改变，也不能作为schema15真实升级证据。

## 实现及范围

- [内部storage service](../cloudflare/src/c2-archive-storage.ts)：只由本地测试直接调用 `capture`、`finalize`、`resume`。原请求／业务scope先查保存的artifact，再决定是否调用既有真实SQL adapter；原ID不重读成员／训练／历史正文，相同scope新请求仅加自己的alias pin，保留first request、captured_at及全部原chunks。
- [schema](../cloudflare/src/schema.ts)：additive 15同事务创建 `annual_archive_plans`、`annual_archive_chunks`、`annual_archive_requests` 及必要唯一／FK索引。现存对象仅在sqlite_master定义与已审结构exact一致时复用；不drop／重建／回填业务。既有旧迁移fixtures保留新空表时亦能安全重复应用，错形对象拒绝并回滚。
- [backup清单](../cloudflare/src/c1-history-service.ts)：47表追加三表为50；保留既有算法／格式。CAPTURED的完整text／nullable digest及READY的完整manifest／pin均可备份。没有新增backup调度或restore流程。
- [Workers场景](../cloudflare/test/c2-archive-storage.test.ts)、[Node预算场景](c2-archive-storage-proof.test.mjs)：真实Workers SQLite、原C1导入／冻结／完成／更正及原backup创建／下载／verify。`c2-archive-capture.test.ts`仅将旧“年度表不存在”的oracle改为新schema下“preview不写年度表”；既有关联backup测试仅将硬编码schema14改成APPLICATION_SCHEMA_VERSION。

没有新增Worker service import／dispatch、HTTP contract、public行为、alarm／cron／scheduled job、桥接／Google调用、manifest或service版本变更。schema15只在本地构造／测试数据库应用；验收执行时未部署或远端写入。

## 固定内容、权限及事务

命令摘要包含server context／actor／明确业务scope／format／绑定；不包含当前活业务或captured_at。首次capture在一个同步事务内完成proof、有限读取、完整graph投影、plan＋全部chunks＋original request pin的CAPTURED提交。复用delivery 1的内部嵌套同步读取块，外层事务覆盖所有新写入，任何phase故障全回滚。

每个同步事务只额外读取当前season binding及可选sync_binding的数字scalar；INTEGER类型以SQL CASE保护，不将畸形大文字返回JS。generation／epoch来自 **authenticated server-owned context**，支持固定Env对象或同步getter，每次事务／SHA提交重新核。app_meta.schema_version只是应用结构版本，不是writer权威。未来调用者负责在有效权限验证后供给当前Env身份；此未接线service不能称已经实现公开Coach鉴权。实例替换提供不同身份及await期间getter变化均拒绝；固定Env实例不能宣称感知外部未反映到它的配置变化。

摘要调用既有 `sha256Base64Url`，前缀 `sha256_v1:`，全部在事务外计算。manifest覆盖固定metadata／canonical plan／capture proof摘要、每块摘要及计数；不把动态完成时间放入业务内容digest。提交事务复核原plan所有不可变字段、metadata／proof／canonical exact text、完整有序chunks及本次pin。CAPTURED被另一合法调用完成时只接受computed manifest／全部摘要exact一致；原输入已经READY时，整个plan（含completed_at）、chunks及pin都必须在await窗口原样保留。READY、全部digests／manifest和本次请求结果同事务落库。

持久state为 `CAPTURED` → `LOCAL_DIGEST_READY`；内部纯plan仍为 `LOCAL_PLAN_ONLY`，source仍为 `SOURCE_NOT_YET_VERIFIED`。local digest验证只证明保存内容的固定与完整，不代表Google业务文件、原始Form回答、public eligible或年度全功能完成。

## 已验证场景

| 门槛 | 实际本地证据 |
|---|---|
| 原请求未知回复／恢复 | capture提交后丢弃回复，再由新service读原pin；实际 `evictDurableObject` 后恢复CAPTURED、再次驱逐后重放READY；后来成员改名不进入原artifact |
| 相同scope及权限身份 | 另一actor／request alias返回首artifact；75个真实alias持久pin后原请求仍仅预算／读取本次pin。参数冲突、当前绑定变化、context team／generation／epoch变化拒绝，零新计划 |
| 并发 | 同ID同时capture只生成一plan／pin；两次finalize允许同一CAPTURED→READY正常竞态，返回同一完成结果，不裸PK异常后重捕获 |
| 外部摘要期间活数据 | 原C1归档后，摘要期间真实追加history correction且成员改名；旧plan／capture proof不改变，无活数据重抓 |
| 所有写入phase | SQL proxy在实际sql.exec执行之后抛错：plan INSERT、chunk INSERT、pin INSERT、chunk digest UPDATE、READY UPDATE、request result UPDATE全回滚。105条实际业务audit形成两块，第二／最后块已写后故障亦回滚整个集合 |
| 文本及集合CAS | 摘要窗口修改metadata／proof／ownership／pin，或删除、增加、修改chunk均拒绝；不能只核status／总行数。原READY实际SHA await gate内修改completed_at及对应结果，即使两者互相一致仍拒绝且不覆盖 |
| 保存数据预预算 | 巨大canonical／chunk／pin正文，以及SQLite INTEGER affinity列中实际保存的巨量非数字TEXT，均在加载大正文前拒绝；spy允许小pin点读，但plan／chunks正文为0次 |
| v14→15本地迁移 | 原47表逐表原行exact保留（app_meta.schema_version 14→15单独例外），包含PENDING outbox、PREPARED／SENT／FAILED batch、block、request selection及poll plan；DDL后故障全回滚仍14，错形现存年度表拒绝。现applySchema真实拒绝future16 |
| 完整非空backup | 一份CAPTURED与另一scope的READY均在50表backup保留全部原text／pins／nullable／完成摘要；原C1下载每chunk后独立重算每块及整个manifest摘要，原verify亦通过 |
| 接线／既有行为 | 原preview专项仍通过、无存储写入；新storage没有HTTP/public/alarm/Google入口，不影响远端v14固定协议 |

旧v14代码拒绝较新schema是既有版本防护及设计限制；本轮没有执行真实旧Worker或实际降级实验，不能将手写版本条件当作该实验，更不能把切回旧Worker称为无损回滚。未来若部署schema15，须另行捕获最新完整v14升级前包、保护47表原业务／任务（采样指标变化逐项解释）、核新50表升级后完整包，并保留两端备份；修复走经审forward版本或正式恢复流程。本轮未执行restore。

## 保存加载预算与限制

任何resume／replay／finalize在正文取回前，独立SQL COUNT／UTF8 BLOB长度证明：plan四份大text各<=2,000,000 bytes，其它字段合计<=8192；全部chunk payload累计<=2,000,000、每块<=64,000，块数1..5000、小字段保守按5000×256 bytes计；只核当前pin总字段<=8192，不扫描所有alias。所有plan六列／chunk四列数值先证明SQLite INTEGER／非负安全整数，避免affinity允许的大TEXT先被SELECT *物化。正文加载后复核canonical text、身份、count、连续index／offset、每块字节及完整集合。

canonical plan与chunks重复保存，proof及manifest另存；不能声称总storage只有2MB。预算保护有限文本加载，不是heap峰值、固定SQL CPU或全库backup有界证明。首次capture仍继承有限action registry（未知C0／其它action保守停止）及全域audit扫描成本；复用原artifact时不重新扫描活audit。原backup仍按其既有全表读取实现，本切片不把年度预算套成其性能保证。

## 验证结果及独立审核

作者冻结源码最后一轮：Workers storage17/17＋原preview11/11＝28/28；Node savedbudget2/2；cf:check、node --check、git diff --check通过。完整 `npm run cf:test` 为23files／254tests，exit0；完整 `npm test` 为264/264，exit0；docs2/2通过。完整Workers初跑发现既有迁移fixtures保留年度表而退回schema值的错误，修成IFNOTEXISTS＋exact结构证明后才获得最后全量PASS；一轮Node曾在新增报告尚未创建时看到文档链接，文件齐全后完整重跑264/264。较早失败或旧snapshot未冒充最终证据。

`conflict_design_review` 与 `waitlist_acceptance` 均独立复跑同一冻结源码的Workers28/28＋Nodeproof2/2并完成源码审核，无未解决P1／P2；两位均确认报告边界准确，最后计数及字段文字delta独立签核后交supervisor。作者全量结果与reviewer专项结果分别记录，不声称独立全量复跑。Wrangler日志目录EPERM及全CF中的平台internal-exception输出单独记录，254项断言通过exit0，不能将日志作为年度远端故障证据。

下一阶段真实文件创建、来源抓取／receipt、权限接线、公开兼容及Google验收须独立审定。当前仅本地持久计划能力；不自动推进到年度Google/source verified。
