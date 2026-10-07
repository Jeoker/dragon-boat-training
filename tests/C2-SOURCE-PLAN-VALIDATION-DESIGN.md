# C2.6 原 source plan 完整验证 adapter - 设计

本文维护完整 retained plan validator 的现行协议；实现证据见[本地验收](CURRENT-VERIFICATION.md#来源采集与审核)。v1 canonical 字节保持兼容；实际存储和权威接线由外层私有 runtime 承担。

目标是验证完整原 `c2-source-plan-v1` canonical core 及其中全部 chunks，而不需要原 `c2-source-input-v1` 文本。迟到 Form 完整正文已从 plan 排除，不能为了重建长期保存它、制造空答案或重新读活来源。人工审核支持原 input＋plan 工具及 retained plan 适配器；私有运行服务只从已认证的原 candidate／receipt 提供完整 retained core。

依据：[source contract](../shared/c2-source-capture-contract.ts)、[projection](../shared/c2-source-capture-projection.ts)、[source 技术设计](C2-ANNUAL-SOURCE-CAPTURE-DESIGN.md)、[人工审核设计](C2-SOURCE-MAPPING-REVIEW-DESIGN.md)。采用 current capture、固定 cutoff、不追加迟到回答及 HUMAN_ATTESTED 政策。

## 1. 三个独立门槛

| 门槛 | 本 adapter 能验证什么 | 不能据此推出什么 |
|---|---|---|
| 结构与保留内容语义 | 完整 v1 core、所有 namespace／chunk／record、typed raw／schema、身份与 cutoff、计数／定位／bytes、条件 ledger 与保留证据一致 | 不能恢复原 input、排除正文、HTTP 字节、历史答案、实际读取过程或完整历史 census |
| 原内容完整性 | 原 canonical core 的真实 SHA-256 等于独立 server-owned 原摘要；scope／operation／binding／generation／epoch 固定，异步后再次核权威 | 自洽 hash 不是 Google provenance；输入方重算新摘要不能替换原锚，原锚也不证明客观映射或真实鉴权 |
| 真实来源真实性 | 本切片不实现 | 仍需完整私有读取／页与 range／观测证据、原 manifest 与 receipt、原 operation 恢复、ACL 与真实 Coach 权限及来源范围核验 |

返回恒 `LOCAL_PLAN_VALIDATION_ONLY`／`SOURCE_NOT_VERIFIED`，不产生 `SOURCE_CAPTURE_FIXED`、authenticated、verified receipt 或年度导出许可。即使前两门槛通过，未知历史覆盖与其他原条件继续保留。

## 2. 输入、权威与输出

纯接口为 `validateLocalSourcePlanCore(originalCoreText, contextPort, hashPort)`，定义于[validator](../shared/c2-source-plan-validation-projection.ts)，DTO见[contract](../shared/c2-source-plan-validation-contract.ts)。

- 唯一正文输入是完整原 canonical core text。当前 v1 的 `chunks[].payload_text` 已内嵌全部 chunk 原文本；不能只送选中的两块、已解析片段或“摘要相同”的裁剪版本。没有原 input 参数，也不接受附加 full late responses。
- 独立 context port 给定原 pinned source（team／season／sourceop／Form／Spreadsheet／Tab／binding／generation／epoch／season_ends_at）、固定格式与预期原 plan digest。调用者正文或 command 不能指定／替换这个 expected digest 或扩大 cutoff。端口目前只表示本地权威声明，不能自己认证会话。
- local 模型继续使用现审核的 `c2-source-review-source-v1\n`＋原 core text 的 UTF8 SHA-256／base64url 规则，便于未来校验同一 LOCAL_INPUT 锚。真实 capture 的文件／manifest 格式和摘要域若不同，另审适配，不能拿 local digest 冒充真实 source receipt。
- 正文先经预算／重复 key／深度校验并固定为内部不可变值，再 await；摘要后再取当前 context，比对完整身份／scope／原摘要及 binding／generation／epoch。端口、getter／Proxy 与 hash 依赖异常只返回固定受控错误，不暴露原消息／值／URL。
- 输出受预算约束的**私有内部** validated retained records／schema 与定位，供受保护 review view 使用；小控制结果只含格式、状态、身份、digest、counts 和验证限制。完整 core／raw 不进入控制元数据、业务 TeamState、普通日志或 public DTO。validator 本身不承担存储、CAS 或鉴权；这些由 Cloudflare 私有 runtime 承担。

将来私有来源采用外部 chunk 文件时，读取层必须按原 manifest 取得完整集合、逐块身份／digest／bytes 及原 core 的固定字节。若不存在本格式完整原 core，需独立版本 adapter；不能临时拼一个新 v1 core 或以当前读到的块替换原摘要。

## 3. 完整 core／metadata／chunks

按下列顺序验证，任一失败整步拒绝，不补字段、不重排、不修正原对象。

1. **文本与 envelope**：UTF8≤2,000,000 bytes，先词法检查坏 Unicode、decoded duplicate keys 和有界深度。core 仅允许现有 `format/state/source_status/metadata_text/namespace_counts/record_count/chunks` 字段，格式固定 v1、原状态 `LOCAL_SOURCE_PLAN_ONLY`／`SOURCE_NOT_VERIFIED`；不包含返回对象的 `canonical_text` 自副本。独立 canonical 序列化必须逐字等于原 core text。
2. **metadata**：完整字段白名单、固定枚举和原 canonical text；pinned_context 与权威一致，`submission_cutoff_at` 等于原 `season_ends_at`，按原纳秒 parser 验时间与 offset。声明 observed_start≤observed_end 且 end≥cutoff，不称真实 wallclock／读取证明。numeric／historical coverage／observation／mapping 字面值沿现 v1，`sheet_archive_eligible_rows=0`；完整 known_sources 数组保留顺序并严格校验。
3. **chunk 集合**：五 namespace 按原固定顺序，零数量 namespace 无 chunk；每个 namespace 的 chunk_index 从0连续、row_offset 从0累加、无缺／增／重复／重叠／跨 scope。外层与 payload 的 format／sourceop／namespace／index／offset 相等；payload 仅原字段，原 canonical text 不变。row_count等于 records.length，1..100；utf8_bytes等于实际 payload UTF8且≤64,000，records完整包含，不能核 descriptor 后跳过正文。
4. **计数与定位**：所有 namespace_counts逐组精确对应完整 records，record_count等于总量且≤5000；每个完整包装 record 及 retained raw 的实际 UTF8分别≤64,000。固定 index/offset产生唯一 locator，不接受 caller 自填或 name/time 定位。metadata 的条件分类计数随后与完整条件集合精确相等。
5. **确定性分块**：将经过验证的原 namespace 记录序列交给共享 v1 chunk assembler，按当前 greedy≤64,000 bytes／100records 重建 descriptors与payload texts，要求与原全集合逐字相同。它验证分块规则，不更改原块；不能把任意另切分但逻辑相同的内容当同一原 plan。
6. **原 hash**：真实 SHA-256 校验整个原 core，包括 metadata、全部 payload text及 descriptor；expected digest只来自独立原锚。只核 selected raw／schema hash或自行更新 expected值均不满足原内容完整性。

`metadata.input_bytes` 只能验证为有界正整数（≤2,000,000）并由原 core digest／将来原 manifest 绑定。它记录原 producer 声明，不能从保留 records 重算；不要求虚构 raw input 得到这个值，也不声称验证原 HTTP bytes、数值词法、原 key顺序或已丢失 IEEE754精度。不得因为缺原 input 而删掉它、改成当前 core大小或“0”。

## 4. retained-only typed 内容与 namespace 规则

| namespace／record | 完整验证与原边界 |
|---|---|
| FORM_CURRENT／FORM_SCHEMA | 全 plan唯一一份 Form schema（或在 pending中）；raw身份与linkedSheetId存在时严格绑定。复用现 schema validators收集 question IDs、判支持范围。只有 supported schema可在此；wrapper仅原字段，原 raw不补默认值 |
| FORM_CURRENT／FORM_RESPONSE | 必须有完整原 raw、唯一responseId、可选formId若存在严格匹配；createTime≤lastSubmittedTime≤声明observed_end，createTime严格<固定cutoff。schema／response／question关联／附件条件均无 pending理由才可在此，不依据Sheet时间或人工声明升级 |
| PRIVATE_PENDING／FORM_SCHEMA、FORM_RESPONSE | 保留完整原 unknown字段与原理由／身份。用同一验证规则重算unsupported／unknown question／attachment／schema理由，要求wrapper及理由序列完全一致；不能把pending换成裁剪supported raw或“已人工确认”字段 |
| PRIVATE_PENDING／SHEET_SCHEMA | 全 plan唯一一份完整Sheet schema，身份、locale/timeZone、矩阵尺寸／headers／空字段沿原规则；必须保留SHEET_SCOPE_UNPROVEN及实际schema unsupported理由。schema不因人工映射变trusted |
| PRIVATE_PENDING／SHEET_ROW | 全部原行和完整cells仅此namespace，row_index 1..rowCount−1连续且严格按原坐标顺序，每行cells.length=columnCount；headerRowIndex=0，headers.length=columnCount，rowCount×columnCount≤50,000。空／公式／error／IEEE754数值／未知原字段按现cell validator处理，raw完整留存。重算原row unsupported理由、声明映射与candidate cutoff分类，不自动执行公式或把日期serial转UTC |
| EXCLUDED_IDENTITIES | 只允许原FORM_RESPONSE_EXCLUDED wrapper／固定reason及完整identity（form_id／response_id／createTime）；唯一ID与其他Form namespace互斥，createTime≥cutoff且≤声明observed_end。只核身份和资格，不制造lastSubmittedTime／answers／完整hash或“已看全文”证据 |
| GAP_LEDGER | 只允许原SOURCE_EVIDENCE_CONDITION格式；完整code／classification／identity和顺序须与§5共享分类结果一致。不是可任意增删的自由说明，也不将COVERAGE_LIMIT／PROOF_REQUIRED计成已经发生删除 |
| SHEET_CURRENT | 本v1必须恒空，metadata合规Sheet count恒0。HUMAN_ATTESTED属于独立review ledger／derived版本，不能写回原sourceplan或借trusted flag使原Sheet进入此namespace |

完整 Form responses（current＋pending）与 excluded身份共用唯一ID集合；known census的FORM_RESPONSE身份可与该集合对照，但同kind/ID的census不能重复，IMPORTED／REVIEW_REQUIRED、LEGACY_ROW、UNMAPPED_MEMBER均沿原类型与scope白名单。

每个namespace还须核现v1的固定record-type布局，不能仅把任意提供顺序交给greedy assembler复切：FORM_CURRENT是唯一supported FORM_SCHEMA在前、再是current FORM_RESPONSE；若schema unsupported则该namespace为空。PRIVATE_PENDING是可选unsupported FORM_SCHEMA → 唯一SHEET_SCHEMA → pending FORM_RESPONSE序列 → 完整SHEET_ROW序列，各阶段可没有行但不能后退／交错。EXCLUDED_IDENTITIES仅排除身份，GAP_LEDGER仅条件，SHEET_CURRENT为空。schema后置、Sheet行先于schema、pending Form与Sheet交错即使wrapper／chunk计数自洽也拒绝。原各阶段内的record相对顺序保留，不能猜回原跨namespace输入交错。

declared_mappings没有独立metadata数组：其完整原对象保存在每个Sheet row的declared_mapping（或显式null）。逐行恢复有界声明集合，严格要求DECLARED_ONLY、row_index匹配此原行、完整response/evidence身份、row和response不能重复；关联到完整Form或excluded身份时重算BEFORE_CUTOFF／AT_OR_AFTER_CUTOFF，仅显示candidate，缺观察到的response则UNKNOWN＋原missing condition。其原输入数组顺序不再可恢复，不作这项证明。

可复算的记录总量是完整Form＋excluded身份＋Sheet原行＋known census＋非null mapping＋两schema，检查≤5000；再独立检查含所有条件的输出总量≤5000。它不是恢复原 JSON 或被排除正文的byte／depth／支持状态证明。

## 5. 条件 ledger 不删除或漂白

共享分类器从完整保留的schema、current/pending Form raw、excluded身份、Sheet schema/rows、声明映射与metadata known_sources复算下列条件，要求原分类、identity、code、顺序和重复数量一致：

- 固定 READ_COMPLETENESS_AND_OBSERVATION_UNPROVEN（PROOF_REQUIRED）及 HISTORIC_UNOBSERVED_RESPONSES_NOT_RECOVERABLE（COVERAGE_LIMIT），不凭通过validator删掉它们。
- Form／Sheet schema unsupported，按原schema阶段位置；pending Form理由按现固定顺序生成逐response条件。pending Form序列保留了产生这些条件的原相对顺序，不能跨namespace猜回原全回答交错顺序。
- 固定 SHEET_MAPPING_VERIFICATION_NOT_IMPLEMENTED（PROOF_REQUIRED）；逐Sheet原行unsupported／mapping response未观察条件；保留每条原理由。
- 按metadata完整known_sources顺序，当前＋excluded集合仍未见的Form ID产生KNOWN_RESPONSE_NOT_OBSERVED；LEGACY_ROW和UNMAPPED_MEMBER保留原unmatchable条件，不猜已删除或借member姓名补来源。

条件的具体发出次序完全以现 `buildLocalSourcePlan` 为准：初始两条件 → Form schema条件（若有）→ mapping条件及Sheet schema条件（若有）→ pending Form逐行条件 → Sheet逐行条件 → census条件。分类总量按SOURCE_GAP／UNSUPPORTED／PROOF_REQUIRED／COVERAGE_LIMIT精确复算；不能加一个“validator passed”条件、去重后改变数量、删known missing，或改classification使统计变好。

若原census与对应条件被一起裁掉，结构可能自洽，但原权威digest门槛必须拒绝。完整census是否包含DO知晓的全部身份及未知历史覆盖，是外部capture真实性门槛；纯validator不能只凭metadata内部一致就宣称已证明。

## 6. 最小共享实现，避免 synthetic input 或第二套业务规则

原 builder 与 retained validator 共用 typed 验证、分类和分块规则；各入口继续独立检查完整输入及权威锚。

1. 从现contract／projection抽取schema、pinned身份、response、Sheet/cell、known census、声明mapping的有界 typed验证与分类 helper。支持范围、omitted defaults、unknown union整拒／unknown完整pending、finite IEEE754／纳秒规则保持不变；原builder的19专项作为兼容oracle。
2. 共享record wrapper／理由／条件构造和v1 chunk assembler，保留输出原字节。adapter 验证原record序列并比较共享期望wrapper／条件／chunks，不复制整套buildlogic，也不调用buildLocalSourcePlan构造伪input。[独立兼容夹具](fixtures/c2-source-plan-v1/goldens.json)保留前版 `8fed6a9` 的 core／metadata／全部chunk原文本及摘要；测试核验这些固定字节，不依赖旧Git对象或运行新旧路径的同helper自比。
3. 对excluded使用**仅identity**的专门validator；不让通用response validator要求不存在的lastSubmittedTime，不填空答案或重新读活Form。不为绕过原UNSUPPORTED_LATE_RESPONSE规则制造“supported=true”。
4. adapter 输出 private retained集合／定位及条件摘要，已由[retained plan 审核入口](C2-SOURCE-PLAN-REVIEW-ADAPTER-DESIGN.md)消费；当前权限、Google journal 与持久CAS由外层私有服务承担。纯validator不提供权限／I/O，也不修改旧sourceplan格式或将本地校验原地升级为来源资格。

深度兼容采用固定策略：`parseSourceJson` 的原raw文本scanner上限32，`sourceCanonical`及`parseGeneratedSourceJson`的生成包装上限40。每份retained raw另按**原input字段固定路径**检查深度32，例如`{"form_schema":raw}`、`{"form_responses":[raw]}`、`{"sheet_rows":[raw]}`，Sheet schema／known census／mapping同理；不能因包装层增加而误拒原builder合法输出。这些临时路径只作词法／深度校验，不是完整source input，不交给parseSourceCaptureInput／build，不包含虚构late body或input_bytes。检查保留固定父层，调用者不能扩大深度；duplicate-key／Unicode／UTF8门槛不放宽。原路径32通过而33拒绝的边界由兼容夹具与负例核验，仍不能证明已排除正文的深度／内容。

## 7. 资源、失败与授权边界

原core≤2MB；完整chunk及包装record／raw各≤64KB，≤100record/chunk、≤5000输出record、≤50k cells。metadata及payload字符串分别先受原core／chunk预算约束，再解析；namespace／index／offset／counts都是safe nonnegative integers，不允许数值TEXT／NaN／无限值。完整集合扫描与验证，不跳到选中的块或以分页漏掉旧条件。

private validated输出实际canonical另限≤2MB；若未来review再展开view，仍沿其独立≤2MB／每候选≤64KB门槛，不能以输入小为理由豁免输出。小控制context/result≤8KB，不复制raw／原core文本。超限整体失败，无部分validated结果或截断；不修改原input/core/chunks。

这些只是正文／输出预算，不是固定heap、CPU、stream或SQL证明。原text、parsed core、chunk原文、raw、共享期望序列及输出可能共存；完整重算成本随记录量增长。无真实存储写、原request journal、跨重启恢复、authenticated Coach、manifest receipt、Google或公开传播。

## 8. 验收约束

| 验收 | 必须真实证明 |
|---|---|
| 原builder兼容 | supported／empty defaults／unknown完整pending／附件／unknown question／missing census／late身份组合由现builder产生后，不给原input也能通过完整adapter；开发从前版独立生成并提交golden core／metadata／chunks文本与digests，测试不依赖旧Git对象，加原19专项；不以新旧路径同helper自比充兼容证据 |
| 完整集合 | 改未selected chunk、缺／增／换namespace、重排／duplicate index、错误offset/count/UTF8、另切分、core自副本、额外trusted字段全部拒；schema后置／record-type阶段交错即使greedy分块自洽仍拒；任何未读正文不能靠descriptor通过 |
| typedraw／schema | 裁完整raw／未知字段、错来源身份或omitted字段补默认在原摘要下拒；重复questionId／responseId、Sheet空格覆盖／cells缺列、invalid union语义拒；合法小数／emoji／empty ExtendedValue原样保留 |
| cutoff | 纳秒−1/=/+1与offset同instant；晚编辑的早提交current保留；late只identity，缺fullbody不造schema／content hash或人工审核资格；Sheet Timestamp不升级scope |
| 原条件与census | 删／增／改分类／漂白known missing／unsupported／mapping gap／coverage条件拒；census与条件一起修改即使自洽也在旧expected digest下拒；不称已证明外部census完整 |
| hash与authority | 独立Node SHA字节oracle核domain／UTF8／全原core；更改input_bytes或observed声明重算自供hash不能授权；真实await barrier中gen/epoch／scope／原锚变化拒；端口抛私有异常固定redaction |
| raw与生成深度 | decoded重复key（含转义同名）、坏Unicode及生成wrapper深度预算拒；前版builder真实生成的深层pending兼容通过；retained raw在原input固定父路径32通过、33拒，raw32不被全局升到40，也不虚构excluded正文 |
| 预算与隐私 | 合法输入导致private输出越界整失败；控制与错误无raw／URL／expectedactual；original bytes未改变，source status恒NOT_VERIFIED，不产生receipt或公开年度chunks |
| 未实施事实 | 不提供原input、late完整body仍成功验证retained plan；明确input_bytes只是原声明，三门槛分开；不得把通过纯测试标为SOURCE_FIXED／实际读取／持久CAS／Google通过 |

共享抽取、plan-core-only纯validator及独立Node对抗测试已完成；完整retained plan已接入私有审核。纯validator只证明core内部一致性。显式capture-native的原生观察属于外层v2 candidate／receipt，原core／plan摘要和LOCAL provenance不变；Google core单独不能恢复此proof，依赖私有DO／完整backup。真实Google、云端部署、整体来源及年度资格仍须独立验收，当前协议见[指南](../cloudflare/ISOLATED-RECOVERY.md#新capture消费原生证明)。
