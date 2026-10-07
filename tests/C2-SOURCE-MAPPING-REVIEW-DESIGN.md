# C2.6 Coach 人工来源映射审核 - 最小本地模型设计

HUMAN_ATTESTED 是当前人工关联政策。纯审核模型、retained plan 适配器与持久审核 service 分别承担投影、完整验证和当前授权／CAS；有效证据见[验证索引](CURRENT-VERIFICATION.md)，本文维护现行审核协议。

## 1. 已接受的政策与实现边界

沿用[来源设计 §9](C2-ANNUAL-SOURCE-CAPTURE-DESIGN.md#9-已接受人工映射的信任政策)的人工声明模型：HUMAN_ATTESTED 是责任人明确确认对应关系，不保证关联客观无误，不恢复首次答案、删除记录、缺失附件或从未观测的历史。这项声明可作为映射依据；完整来源读取、固定内容、权限与其他核验条件继续满足。

[source纯contract](../shared/c2-source-capture-contract.ts)与[projection](../shared/c2-source-capture-projection.ts)本身只有LOCAL_SOURCE_PLAN_ONLY／SOURCE_NOT_VERIFIED；纯审核结果恒LOCAL_REVIEW_PLAN_ONLY／SOURCE_NOT_VERIFIED，不能自己认证Coach或制造fixed capture、Google receipt及来源资格。外层运行服务已接入当前Coach鉴权、独立私有存储和只追加审核CAS，不改变内层纯格式及DECLARED_ONLY行为；当前实现／部署边界见本页末段及[验证索引](CURRENT-VERIFICATION.md)。

## 2. 受保护调用者与来源锚

真实服务只允许已认证且有本季审核权限的 Coach 调用；纯模型上下文来自独立 server-context port，测试明确标记为本地声明，不返回 authenticated=true。客户端命令不能指定 actor、审核时间、cutoff、binding、generation、epoch 或 verified。

server context 必须包含 team／season／actor及其允许审核的范围、当前 binding_version／backend_generation／writer_epoch、原 source_operation_id、来源格式、Form／Spreadsheet／Tab 身份、固定 season_ends_at，以及 server-owned reviewed_at。plan接口另要求调用者权威上下文给出预期 source plan digest／local snapshot与原ledger version／digest，不能只信command自己填hash或输入ledger内部自洽；本地fixture提供这些声明锚不等于认证。运行服务须在读取私有内容前验证权限、每次恢复复验当前权限和归属，并在异步摘要后再次取得权威上下文；不能只用构造实例时的旧复制。首次调用的reviewed_at固定供证据使用，重放取原值，fresh权限检查不以新clock改旧时间。当前权威会话与业务归属由服务器提供，Google 权限由私有 journal 复核；纯接口不承担认证。可参考[业务存储设计 §7](C2-ANNUAL-CAPTURE-STORAGE-DESIGN.md#7-digestcas重启与请求恢复)的当前权威 getter 和原文本锚思想，但不能把业务 capture receipt 当 source receipt。

来源锚包括完整原 plan core text 的 SHA-256、所有 pinned 身份及 cutoff。纯模型入口只能生成明确带 LOCAL_INPUT 前缀的 `local_snapshot_id` 和 `provenance=LOCAL_INPUT_DECLARATIONS_ONLY`，并记录原 source_operation_id；这个本地内容定位不能充当真实 source snapshot ID。后续适配真实固定 capture 时，必须另验证真实 manifest／所有 chunks／receipt／ACL，并使用它们的不可变 snapshot ID，不能把 local ID 原地升级为已认证 capture。

## 3. 纯模型入口输入和完整原 plan 校验

纯模型接口接受三个独立受预算约束的文本输入及当前 server context：原 `c2-source-input-v1` JSON、原 `c2-source-plan-v1` **core canonical text**、此前本地 review ledger。core text 使用 `LocalSourcePlan.canonical_text`；不把包含其自身副本的整个返回对象序列化后当2MB输入。

先用现有 `parseSourceJson` 的 UTF8／depth／解码后 duplicate-key 检查，再以原 pinned context 调用 `buildLocalSourcePlan`。重建的整个 core canonical text 必须与提供的原 text **逐字一致**，并核固定格式、state、source_status、metadata、五namespace、全chunks的顺序／index／offset／count／bytecount和全部原records；不能只核选中两个记录或总行数。调用 context 必须与重建 metadata 的 team／season／binding／generation／epoch／sourceop／来源身份／cutoff一致。任何多块、少块、重排、跨namespace、剪字段、换schema、改gap或额外 verified 字段都拒绝，不修补原 plan。

原input＋plan双文本入口用于纯模型验证，不证明Google来源真实性；真实服务使用同一次已固定capture的retained plan，不要求重建完整原input，也不长期保存范围排除的迟到正文。原候选、checkpoint与审核证据保存在独立Cloudflare私有DO，不能进入业务TeamState或普通备份。完整plan-core-only validator和review adapter已有[本地验收](CURRENT-VERIFICATION.md#来源采集与审核)；运行层分别验证当前Coach权限、来源锚与Google journal。

原输入的词法、空白及 finite IEEE754 规范与 source pure一致，摘要针对版本化 typed canonical 内容，不声称复现原 HTTP 字节、指数文本、原key顺序或此前已丢失精度。原输入重建所需的 `input_bytes` 也保持 exact；不能拿后来不同输入替代同一次本地 source 锚。

## 4. 私有审核视图与显式命令

纯审核模型提供 prepareLocalMappingReview／planLocalMappingReview 两个入口；真实私有服务通过 retained plan 适配器复用其验证与投影：

| 接口 | 输入／输出和限制 |
|---|---|
| prepareLocalMappingReview | 完整 source bundle＋server context；内部验证后异步算 source plan、Form schema、Sheet schema及完整records摘要，生成 bounded 私有 view。纯函数不提供传输；外层受保护 review-view 返回该视图 |
| planLocalMappingReview | 同一完整 validated bundle＋此前ledger＋显式 command＋fresh context port；核双方定位／摘要，生成一个 append evidence及独立 derived资格版本。结果仅本地计划，带原ledger version/hash作为后续CAS前置，不执行持久写入 |

视图中的 Form 候选仅从 FORM_CURRENT 或 PRIVATE_PENDING 中确有完整 `raw` 的 FORM_RESPONSE取出；Sheet 候选仅从 PRIVATE_PENDING 的完整 SHEET_ROW取出。每方视图保留完整raw、原namespace／record_type／chunk_index／row_offset定位以及相应完整schema，不只显示姓名或已知列。跨chunk选择必须先完成全plan核验，再按经过验证的定位取完整记录；不允许调用者上传一段裁剪答案当原record。raw对象和截图／可编辑网页不是权威摘要来源。

EXCLUDED_IDENTITIES只有迟到身份／createTime，没有完整原response，不能把其身份摘要冒充 full-response hash，纯模型入口对此不能生成双方完整内容的审核证据。允许记录明确 `FULL_RESPONSE_NOT_AVAILABLE_FOR_REVIEW` 的未决条件，不重新读活Form补原plan；以后是否有另行合规私有证据可供核查依真实 source capture 协议审定。该限制不丢掉原排除身份，也不将迟到内容加入旧年度档案。

command只允许固定 request_id、local_snapshot_id、sheet row定位、Form response_id、双方expected完整内容hash、固定reason code，以及明确 `decision=CONFIRM_LINK`。不接受姓名／时间匹配建议、自由文本why、raw答案、凭据、目标URL或人工填cutoff。reason采用有限清单，例如 `REVIEWED_FIXED_RECORDS`、`DIRECT_KNOWLEDGE_OF_SUBMISSION`；它记录责任人选择的依据类别，系统不能将reason当独立客观证明。额外私有材料不属于现行command协议，不得塞入业务TeamState审计。

## 5. 摘要、不可变输入与请求重放

SHA-256使用现有异步能力（[crypto.ts](../cloudflare/src/crypto.ts)中的 `sha256Base64Url` 语义），通过注入的 async hash port供给；shared纯模块不 import Worker/runtime，不自创哈希。Node测试必须以真实 WebCrypto SHA-256 和独立expected bytes／known vector验证，不能仅靠返回“看起来43字”的fake hash。每种摘要使用独立固定domain prefix，明确覆盖版本、sourceop／local snapshot、namespace／record_type、双方稳定定位、schema摘要及**完整raw canonical text**，UTF8编码和base64url规则固定。Sheet只hash姓名cell或 Form只hash答案map均不够。expected hash与重算值及权威context原source／ledger锚逐一相等；hash相等仍不能证明来源 provenance或人工关联正确，客户端自供bool或hash不授予可信来源资格。

所有正文先规范解析为不可变canonical text再await，禁止把可变输入对象引用当snapshot；异步后复验fresh context。本地私有验证／view内部保留 source plan和原ledger的exact text锚；返回的有界ledger／derived／CAS控制只携带其digest与身份／版本及不含raw的固定命令text/digest，不能携带完整原source文本，业务TeamState控制记录不得保存这些raw text。纯projection自身不执行外部CAS；返回 `expected_ledger_version`／`expected_ledger_digest` 是持久append事务的必要前置，不宣称已执行并发原子更新。持久审核服务须复核原artifact text／完整集合和当前权限／归属。

request身份固定为 actor scope＋request_id；命令digest包含所有被确认的身份／定位／expectedhash／reason／decision及固定source锚，不含每次重跑的新server时间。原ID同参数且此前ledger已有完整证据时返回原证据、原reviewed_at和原派生版本；即使当前ledger后来追加，原derived必须按原证据sequence截至的exact prefix确定性复构，不换成当前版本或纳入后来的关联，重放不append。同ID不同参数拒绝。重放仍核当前权限／归属及原bundle完整性，不重新读取活源。不同请求不能覆盖同row或同response的既有决定；完全相同关联的新增请求也明确返回已有决定或冲突，不静默写重复证据。纯模型不能保证两个进程同时拿旧ledger时只提交一个，持久阶段必须用base version/hash CAS关闭此窗口。

## 6. Append-only evidence 与独立派生资格

ledger采用有界、固定版本、连续sequence／version的 evidence集合，完整保留此前canonical evidence bytes；新决定只能 append。每条记录含 request identity／command digest、HUMAN_ATTESTED、来源锚、双方定位／完整hash、actor、reason code、首个reviewed_at及前一ledger摘要。验证全ledger归属、连续性、唯一request、row和response的一对一约束；跨capture／跨季／跨binding evidence不能借aliases混入。

重复或矛盾决定、选中不存在response／row、双方hash变化、无法完整读取原record、schema或来源身份漂移均停止，不猜映射或替换旧决定。当前不支持修改、撤销、替换原关联或“管理员强制通过”；后续纠错只能另审append式supersession协议，不delete原证据。

派生资格对象独立版本化，引用 source plan hash、review ledger version/hash、选中完整record定位/hash。提交边界只用原 Form `createTime < pinned season_ends_at`，复用 `sourceInstant` 精确纳秒比较；最近修改时间可晚于cutoff，Sheet Timestamp不决定首次提交时间。没有双方完整raw则只能未决，不能制造qualified record。

审核成功只表示该映射获得用户接受的人工声明依据。派生对象可标 `mapping_status=HUMAN_ATTESTED` 和 `submission_scope=BEFORE_CUTOFF`，但必须同时保持 `state=LOCAL_REVIEW_PLAN_ONLY`／`source_status=SOURCE_NOT_VERIFIED`／`annual_export_authorized=false`。不把这种候选资格直接写进原 SHEET_CURRENT或年度Googlechunks；现有sourceplan继续全Sheet pending。未知schema／字段、附件、未解释known missing、重复／歧义、未完成读取／权限／receipt仍保持原原因，人工声明不能覆盖unsupported类型检查。

原GAP_LEDGER完整保留，不能减计数或删 `SHEET_MAPPING_VERIFICATION_NOT_IMPLEMENTED`、历史覆盖条件等以冒充整个source verified。派生版本分别列本次哪些row有人工证据、哪些仍未决；未来真实 protocol才可在独立派生核验状态中说明某项映射证据已具备，原capture manifest仍原样保留。历史无法恢复的gap永远不能被人工确认变成“已找回”。

业务TeamState及普通审计只保存有界身份、hash、reason code、actor、时间、版本和受控状态；完整raw view／source、checkpoint及私有审核记录保存在独立Cloudflare私有DO。姓名、答案、可编辑回答链接和自由说明不进入普通日志或公开结果。纯projection自身没有传输职责，真实私有读取由当前服务端权限控制。

## 7. 有界输入与失败规则

| 对象 | 当前上限及前置检查 |
|---|---|
| 原source input和原plan core | 各≤2,000,000 UTF8 bytes；各自解析前检查byte／depth／decoded duplicate key，再完整复构exactplan。不宣称两者合计仅2MB |
| 原source完整records／cells | 沿现SOURCE_LIMITS：输入／输出各≤5000records、cells≤50,000、单record／chunk≤64,000 bytes、每chunk≤100records；没有只读选中块而省略其他chunks的捷径 |
| private review view | 每个schema仅top-level保存一次，候选引用schema digest；完整view实际canonical UTF8≤2,000,000 bytes，单候选包装≤64,000 bytes，超额不返回部分view；输入／plan预算不替代view输出核验 |
| command／server context | 每份≤8,000 bytes，固定字段／有限enum、ID≤512 UTF8 bytes，摘要规范化base64url长度43；context对象若使用getter则先复制有限字段为canonical值，拒accessor／extra数据体 |
| prior review ledger | ≤512,000 UTF8 bytes、≤1000 evidence；解析前byte／depth／decoded duplicate key，之后全量scope／chain／唯一性验证，不分页漏过去的决定 |
| 新evidence／derived | 单条≤8,000 bytes；新ledger和derived control各≤512,000 bytes、derived references≤5000；raw不复制进这些control对象。预算不足整个操作失败，不截断reason／旧ledger或悄悄漏row |

这些是正文／输出格式预算，不是总heap、CPU或持久storage预算。原source input、plan、parsedraw、私有view及canonical可能共存；不同输入组合和包装会增长，最终每个输出独立再核实际UTF8。资源失败不得返回部分append或部分derived成功。所有异常只固定code/message，不含私有ID、原raw、expected／actualhash或URL。

## 8. 组件验证与未完成门槛

共享审核contract、完整bundle／retained core校验、私有view、单决定＋完整ledger＋独立derived输出已实现；外层私有service负责当前权限、原候选回读与持久CAS。Cloudflare命名运行接线及受保护审核命令已有本地真实Worker／SQLite测试，Google为模型；真实云部署、其他Coach委派及私有UI尚未验收。显式capture-native的v2原生观察参与原candidate／receipt摘要，审核沿普通stage／resume核验私有原候选，不刷新或重取原proof。Google journal core单独不能恢复原生receipt；完整私有backup保持原证据。原生单点关系不提升LOCAL内容／映射provenance、旧候选或年度资格，见[当前指南](../cloudflare/ISOLATED-RECOVERY.md)。

| 本地测试 | 必须证明 |
|---|---|
| 原plan完整性 | 缺／增／换／重排chunk、计数／offset／namespace／byte变更、只剪selected raw、其他未选中chunk漂移及gap删改均拒绝；原source重建exact比较完整core |
| raw与摘要 | Unicode／float／unknown完整字段和schema参与typed hash；两边剪字段、换record、换schema、跨capture／来源身份均拒；不是HTTP字节证明 |
| cutoff与资格 | 纳秒−1／=／+1、offset同瞬间及晚期编辑；不使用Sheet时间／姓名猜；EXCLUDED缺fullraw仍未决，附件／unsupported虽可记录人工关联也不能变verified |
| ledger与幂等 | 原IDexact replay保原actor／reviewed_at／version，后来ledger已append仍按原prefix复构同一derived且零新append；同ID变参数拒；重复row／response、矛盾关联、未知ID、非连续chain、改旧evidence均拒；并发旧base只返回需要CAS的计划 |
| 权威与await | command伪actor／cutoff拒；摘要await期间server binding／generation／epoch／actor范围变化拒；本地context测试不冒称真实authenticated会话 |
| privacy与资源 | decoded重复key、坏Unicode、超depth／bytes／records／ledger／derived全失败；无raw在control／error，所有完整Sheet raw仍私有pending，纯projection无业务TeamState／公开入口 |
| 不可变边界 | 原sourceplan／chunks／gap不变、不追加迟到回答；append前后旧ledger bytes不改，derived独立版本；任何测试均恒LOCAL_REVIEW_PLAN_ONLY／NOT_VERIFIED |

审核前须验证同次固定 capture、完整 retained core、原 operation receipt 与当前 journal ACL；这些已有本地组合证据，真实业务 capture 仍待验收。实际审核append需要当前鉴权、binding/gen/epoch权威、同事务CAS／持久原request恢复、私有view完整取回和XSS／formula字面显示防护。年度Spreadsheet自动创建、公开发布和整体source verified仍沿原设计独立门槛，不因本地人工模型通过而自动开放。
