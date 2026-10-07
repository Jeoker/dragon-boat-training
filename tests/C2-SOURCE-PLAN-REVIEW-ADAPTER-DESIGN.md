# C2.6 完整原 plan 接入私有人审 - 纯 adapter 设计

本文维护 retained plan 人工审核适配器的当前协议；实现证据见[验收记录](CURRENT-VERIFICATION.md#来源采集与审核)。适配器只负责纯验证与投影，权限、Google、私有存储与 CAS 由外层 runtime 承担。

依据：[原 plan validator 设计](C2-SOURCE-PLAN-VALIDATION-DESIGN.md)、[完整 validator](../shared/c2-source-plan-validation-projection.ts)、[validator context](../shared/c2-source-plan-validation-contract.ts)、[人工审核设计](C2-SOURCE-MAPPING-REVIEW-DESIGN.md)、[既有人审 projection](../shared/c2-source-mapping-review-projection.ts)及[人审 contract](../shared/c2-source-mapping-review-contract.ts)。完整 validator 已实现；有效证据范围见[本地验收](CURRENT-VERIFICATION.md#来源采集与审核)。这是本地纯校验，不是实际来源已核验。

## 1. 目标和边界

新增两个纯入口，使用完整原 `c2-source-plan-v1` core text，内部完整验证其 canonical bytes、typed retained 内容、五 namespace、全部 chunks、条件集合、原 SHA 和权威身份，再生成现行私有 view／审核计划。调用方不需要原 `c2-source-input-v1` 文本，也不能补晚提交的完整正文。

新入口恒 `LOCAL_REVIEW_PLAN_ONLY`／`SOURCE_NOT_VERIFIED`，外层显式标记 `validation_mode=RETAINED_PLAN_ONLY`。它证明本地声明锚下的保留内容与人审计划一致，不证明 Google 来源真实性、完整读取、实际 Coach 鉴权、fixed capture、immutable 存储或 receipt，也不授予年度导出许可。

现有 `prepareLocalMappingReview(bundle, contextPort, hashPort)` 与 `planLocalMappingReview(bundle, ledgerText, commandText, contextPort, hashPort)` 保留原参数、LOCAL_INPUT 重建门槛、返回字段与字节。不以新路径替换旧 API，不改变用户批准的 HUMAN_ATTESTED 政策、原 raw manifest、gap 或 Sheet 全 pending 状态。

## 2. 最小新接口与 mode

现行独立适配器为 `shared/c2-source-plan-review-adapter.ts`，提供：

```ts
prepareLocalMappingReviewFromPlan(coreText, reviewContextPort, hashPort)
// -> { validation_mode: "RETAINED_PLAN_ONLY", result: LocalMappingReviewView }

planLocalMappingReviewFromPlan(coreText, priorLedgerText, commandText,
                               reviewContextPort, hashPort)
// -> { validation_mode: "RETAINED_PLAN_ONLY", result: ExistingReviewPlanResult }
```

mode 只在新 API 外 wrapper，不写入 `ReviewAnchor`、command、record/schema hash preimage、ledger、evidence 或 derived text。旧两个 API 不加 mode 字段。新 wrapper 也不包含原 input/core 副本、validated object、自供原摘要或认证布尔。

两个新入口的第一正文参数必须是完整原 canonical core text，不是 `{validated:true}`、选中 records、私有 view 或已经解析的 `ValidatedLocalSourcePlan`。每次调用都内部调用完整 validator；没有跳过验证的 public overload、caller proof 标志或只核两个选中 hash 的捷径。

输出是私有本地对象，不是 HTTP/public DTO。view 仅在私有返回体出现；计划结果的 ledger/evidence/derived 仍只含现有有界 metadata、定位、摘要、固定 reason code、actor 和时间，没有 raw 答案、schema 内容或 URLs。

## 3. 完整审核权威 context 与异步 fence

新入口接收现有完整 `ReviewContextPort`，复用 `readReviewContext` 的 descriptor／Proxy 错误遮蔽、字段白名单、8KB 校验、actor/scope 与 `LOCAL_INPUT_<原digest>` 规则。context 仍是本地调用方声明，不负责认证。

首先捕获并内部复制一次完整审核 context。validator 要求的 `{source, source_format, source_plan_digest}` 从这份已校验 context 派生，但**端口不能只闭包返回这三个旧值**：每次 validator 取 context 时，adapter 必须先重新读取原完整 ReviewContextPort，并复验既有 `contextIdentity`，再派生 validator 所需字段。这样在原 core SHA await 中发生的 actor、permission、snapshot 或 ledger 权威变化也会拒绝，而不仅是 source 变化。

跨 await 必须固定的 identity 是现有 `contextIdentity` 覆盖的全部字段：actor_id、permission_scope、完整 source（team/season/sourceop/Form/Spreadsheet/Tab/cutoff/binding/generation/epoch）、source_plan_digest、local_snapshot_id、ledger_version、ledger_digest。不能把审核端口降为只 source context 后丢弃 actor/ledger 核验。

`reviewed_at` 沿旧语义：第一次读取的本次时间保存在内部；fresh getter 可以给出更晚合法 clock，identity fence 不要求两次时间相等，也不以更晚时间覆盖本次已捕获值。旧请求重放直接取 ledger 内原 evidence 时间；A(T1) 后 B(T2) 已追加，使用当前权威 ledger 与 A 的 T1 context 重放仍返回 A 原 prefix，不把 T1 当整条 ledger 的上界。纯接口不证明真实 wallclock，持久服务另核首次 server time。

完整审核 fence 至少发生于：validator 所有 context 读取、完整 validator 返回后、view 全部 schema/record/gap SHA await 后，以及 plan 的 ledger chain／command／derived／最终 next-ledger SHA await 后。最后一次 await 之后、返回之前再次读完整审核端口；不可只在入口检查一次。若后续新增 await，最终 fence 必须随之移到末尾。

端口／hash 的任意 Error、getter 或 Proxy 异常只走固定受控 code/message，不透传原错误正文、expected/actual、答案、URL 或凭据。内部 validator/helper 的错误转换若需要，采用有限固定规则，不把依赖提供的字符串当错误码。

## 4. 共用内部 helper，旧字节不变

适配器复用 `shared/c2-source-mapping-review-internal.ts` 的两段内部工作：

1. **retained records → PreparedBundle**：从证明过的完整记录及 locator 生成私有 view，复用原 `reviewAnchor`、schema/record/gap hash、unsupported 传播、完整 Form/Sheet raw 与 unreviewable identities。
2. **PreparedBundle → 审核计划**：复用 `selectedRecords`、完整 ledger parse/原 digest/chain、command hash、one-to-one、append/replay、derived prefix 与最后 fence。

旧入口仍先用原 input 重建 plan exact，取得同一内部记录集合后进入 helper；新入口只用完整 validator 返回的 `private_collection` 进入 helper。helper 不实现 session/auth/receipt；内部已验证对象只是函数间数据，不能作为外部 trusted port。新 public 入口不接受它为参数。

当前 locator 的 `record_offset` 是 namespace 的 `chunk.row_offset + index`，不是重新按 selected Form/Sheet 数组编号。新 validator 的 locator 缺 `record_type`，adapter 应依据已完整验证的 wrapper 类型补现有 locator 的该字段，保持 namespace/chunk_index/record_offset 原值。必须保留全部记录与原相对顺序，不能筛掉 unselected chunk 再为选中对象重编号。

Schema 在 view 中各出现一次，每个候选只引用 schema_digest；完整 raw 与 schema hash 的 preimage 沿原 `REVIEW_DOMAINS`。Form schema unsupported 和 Sheet schema unsupported 必须传播到对应候选，不能因 scope 候选 BEFORE_CUTOFF 或 HUMAN_ATTESTED 而变成 supported。

原 `ReviewAnchor.provenance=LOCAL_INPUT_DECLARATIONS_ONLY`、`local_snapshot_id=LOCAL_INPUT_<digest>` 保留其兼容字节。在新入口这些是既有本地声明锚格式，**不表示本次重新读到了原 input 或获得实际 snapshot**；`RETAINED_PLAN_ONLY` wrapper 明示此差异。未来真实 capture 的 provenance/receipt 格式必须另行版本化审定，不能把当前锚解释成真实 fixed 来源。

## 5. 原 ledger 跨入口兼容与资格限制

对于同一完整原 core、相同完整 ReviewContext 和 hash 端口：新入口内层 view 与旧入口 view 必须 byte exact；同 command／ledger 的 evidence_text、derived_text、ledger_text、ledger_digest、append_required 以及 expected ledger 基线必须逐字段／逐字相同。新 wrapper 的 mode 不能影响任何 hash 或 idempotency key。

原 LOCAL_INPUT 路径创建的 ledger 可在新路径继续验证或重放，新路径创建的 ledger 也可由提供确切原 input 的旧路径使用。无需迁移或回写 ledger；原 source digest 相同才可复用。不同原 core、binding/generation/epoch、sourceop、scope 或 actor/request 内容仍按原规则拒绝。

原请求在后来追加的 ledger 上重放：返回原 evidence 与原 prefix derived/version；返回的完整 current ledger 原样保持，append_required=false，不追加同 request，也不把原 prefix 改成当前总版本。两路径共同验证 row↔response one-to-one、原 command digest、全部 prior chain 及当前 server-owned ledger 锚。

只有完整保留的 Form raw 可进入人工选择并计算原 content/schema hash；EXCLUDED_IDENTITIES 仅有身份，继续返回 FULL_RESPONSE_NOT_AVAILABLE_FOR_REVIEW，没有伪空 answers、full Form digest 或“已看全文”。createTime 纳秒 cutoff 沿 Form，Sheet 时间与姓名不推断身份。

HUMAN_ATTESTED 只记录关联声明。新 mode 不删除原 GAP_LEDGER、missing/unknown/attachment/history 条件或 coverage limit；原 Sheet namespace 恒 pending。derived 始终 SOURCE_NOT_VERIFIED、annual_export_authorized=false，unsupported 内容继续明确标注。这里不实现最终 Source verified 或 annual public eligibility。

## 6. 有界输入、输出与失败原子性

| 对象 | 必须保留的预算和行为 |
|---|---|
| 原 core／validator | UTF8≤2,000,000，全部 raw/record/chunk≤64KB、5000 records、50k cells、generated40/raw固定父路径32；validator 完整 canonical/SHA/语义校验及其独立输出预算不跳过 |
| context／小控制／每条 evidence | UTF8≤8,000，拒额外字段/accessors，无 raw/core/input；mode 字段与其 wrapper 控制部分也纳入界限 |
| 私有 view | schema 各一次；单候选完整包装≤64KB；最终**整个新 view wrapper** canonical UTF8≤2,000,000，不能只核旧内层后忽略新增包装 bytes |
| ledger／derived | 每项各≤512,000，≤1000 evidence；新 plan wrapper 整体另≤2,000,000，不误把包含完整有界 ledger 的结果要求成8KB小控制 |
| command／时间／定位 | 沿原 exact parser/finite enum/纳秒和有界ID，不接受自行 trusted 或 reason 自由文本 |

超限或任何 hash/context/语义失败整体不返回结果，不部分 view、不截断 ledger、不推进状态；这是纯返回原子性，不是持久事务。检查与 helper 必须先证明输入预算再展开，输出按实际 canonical UTF8验证。完整 parsed core、validator private集合、view 和预期重算对象可能共存，不声称固定 heap、CPU 或 streaming 上限；成本随完整 records/evidence 增长。

## 7. 实现边界与验收

纯适配器承担完整验证、私有 view 与只追加计划；实际权限、Google journal 和持久 CAS 由外层私有 runtime 承担。Cloudflare 运行入口和审核 UI 的部署状态见[当前进度](../CURRENT-STATUS.md)。

| 验收 | 必须实际证明 |
|---|---|
| 全 validator 必调 | 不提供原 input 或 late full body仍成功；未selected chunk篡改、缺正文、自供 validated 对象、局部view、schema/reason/条件漂白、alternate greedy切块均拒；独立旧原SHA不能被 caller 新摘要替换 |
| 跨入口 byte compatibility | 提交固定 pre-refactor review core/view/plan oracle，不仅新旧调用同新helper自比；原 six source golden + 既有人审16与独立14保持；完整 Form/Sheet schema/body/locators/hash 值一致 |
| 原 ledger 双向 | 旧入口append→新入口append/重放及新→旧 exact；A(T1)→B(T2)后原A以T1／当前ledger重放，原evidence/prefixderived bytes不变、不再append；改变原request内容或权威source/ledger拒 |
| 完整审核 fence | 原core SHA await中仅actor/permission/ledgerdigest/version/snapshot变化也拒；schema/record/gap及最终nextledger hash barrier中变化拒；generation/epoch/source变化拒；合法fresh reviewed_at推进不拒、不改首次证据时间 |
| 完整保留与政策 | 两Schema各一次、unknown fullraw和字段缺省/IEEE754值保留、跨chunk原offset；unsupported传播；lateidentity不可review；one-to-one、纳秒cutoff、allSheetpending、原gap/coverage不消除 |
| 预算和隐私 | 原合法core导致私有view新wrapper>2M整失败、合法ledger追加>512K整失败、依赖异常固定；mode只wrapper，控制/ledger/error无raw、答案或URL；oldAPI返回不加mode |
| 范围 | 始终LOCAL_REVIEW_PLAN_ONLY/NOT_VERIFIED/falseexport，无持久request/noauth/noGoogle/noactualcapture，不以通过adapter当authenticated receipt |

完整读取、原候选鉴权与持久审核已有组件验收。真实业务 capture、可信原生 Tab、其他 Coach 委派、审核 UI 与年度 source verification 仍须独立验收。
