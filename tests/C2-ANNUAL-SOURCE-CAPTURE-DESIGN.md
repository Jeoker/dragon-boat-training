# C2.6 完整原始来源捕获 - 技术设计提案

> 第 1 至 9 节保留原技术协议及纯模块阶段的门槛；其中“没有真实读取／存储”属于当时的实现范围。后续独立私有读取、journal 及本机持久操作见第 10 节和[2026-10-03 实际验收](C2-SOURCE-JOURNAL-ISOLATED-ACCEPTANCE-2026-10-03.md)，服务器权威上下文见第 11 节，内部 HTTP 与私有 runtime 接续见第 12 节；业务接续以[当前进度](../CURRENT-STATUS.md)为准。

日期：2026-10-01。只依据现有源码与 Google 官方 API 文档研究；没有读取真实 Form／Sheet、安装 API、改动 bridge 或执行远端试验。用户已批准的产品语义见[年度设计 §6](C2-ANNUAL-ARCHIVE-DESIGN.md#6-后续-bridge-与技术核验门槛)及[后端归档规格](../google-sheets-backend-spec.md)。本文提出技术协议与未解门槛，不宣布来源捕获、持久恢复或 source verified 已实现。

## 1. 已固定的语义与本轮范围

首次成功固定的不可变 source capture 保存归档捕获时完整当前来源，提交 cutoff 固定后不变；不是首次提交时原答案，也不是某个历史截止瞬间的完整值。`submission_cutoff_at` 与业务归档的 `cutoff_at`、实际 `observed_start_at`／`observed_end_at`／`captured_at` 分开。已批准的本地模型按 Form `createTime < pinned season_ends_at` 的纳秒边界判提交资格，由固定赛季／绑定参数派生 cutoff，不允许调用者扩大；真实来源读取仍须证明对应首次时间与绑定。

Form 回答和 response Sheet 使用两个独立 record namespace，各自保存完整身份、schema、值与类型、数量和摘要。它们不能被拼成推测的单张“原始答案表”。来源 raw payload 留在受保护的 Google 私有捕获／证据存储；DO 只保留固定 command、已知 ID census、摘要／计数、gap 状态与经核验 receipt，不加入现有业务 DTO、公开视图或普通诊断日志。

成功固定后，原请求／source operation 恢复原 manifest 和 chunks，不重新获取当前来源替换内容；之后新发现或迟到的回答不追加旧档。已知删除、缺失或无法对应的内容明确保持未 verified。未知历史删除且系统从未保存其 ID 或完整值，无法凭本方案发现或恢复；manifest 必须声明这个覆盖边界。

本提案不修改已批准语义，不涉及年度文件自动创建、业务归档 receipt／公开发布接合或当前 schema15 本地持久业务计划切片的实现。

## 2. 现有代码能提供什么

| 来源 | 当前证据及限制 |
|---|---|
| [FormBridge.gs](../backend/src/FormBridge.gs) | `cloudflareReadFormResponses_` 使用 FormApp稳定response ID、`getTimestamp()`、当前姓名。虽先调用getResponses再切页，却只返回精简字段；不是完整回答捕获或有界全来源存储协议 |
| [SeasonActions.gs](../backend/src/SeasonActions.gs) | 绑定保存Form／Spreadsheet／response Tab ID，核Tab关联Form；schema fingerprint只覆盖当前header。field_mapping仅显示姓名header，旧member source_key为Tab ID:原行号；没有可信Formresponse ID↔Sheet row关系，也没有已固定的首次提交时间列协议 |
| [c2-form-service.ts](../cloudflare/src/c2-form-service.ts)及[schema.ts](../cloudflare/src/schema.ts) | source_imports保存FORM_RESPONSE／LEGACY_ROW身份与精简digest；form_source_observations保存当前提交时间／姓名并原位更新。可构成已知回答ID census，不能恢复未保存的完整答案；member链接不等于响应表行链接 |
| [ArchiveActions.gs](../backend/src/ArchiveActions.gs) | `seasonArchiveRows_`以getValues读取当前Sheet全矩阵并JSON编码，未按回答提交时间筛选；ERROR重试会重新取源。旧写法不能直接充当本文不可变协议，也不能证明Form全schema／全部类型或历史完整性 |

现有绑定没有规定唯一时间header，也没有证明native Sheet Timestamp等于首次提交时间。[FormResponse文档](https://developers.google.com/apps-script/reference/forms/form-response#getTimestamp())仅称getTimestamp为一次回答提交的时间；没有为本项目提供“编辑后始终保持首次时间”的保证。Sheet中的时间单元格又属于可编辑值，不能将当前显示值当作不可变资格证据。对native重新提交如何更新该列，本轮官方文档核查未找到足以固定协议的保证，尚未实测；不采用社区回答作为本设计依据。

## 3. 官方能力、读取方式与时间边界

[Forms REST FormResponse](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses)明确区分首次提交`createTime`和最近提交`lastSubmittedTime`，回答按questionId保存。这使**仍可访问回答**的首次提交范围可判定；不会恢复其过去内容、已删除回答或已丢失的题目schema。回答数组、文件引用和quiz字段按原API类型保存，不按网页需要只保留姓名。RFC3339可能有纳秒部分，cutoff比较不得先用Date毫秒截断而放过边界；保留原时间文本并以明确精度比较。

[forms.responses.list](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses/list)支持分页，pageToken后续调用须沿同form/filter；返回不足pageSize不代表结束，必须检查nextPageToken。该API只列出当前返回的回答，没有在此文档中承诺历史墓碑或跨页固定快照。因此建议不使用当前导入的重叠时间窗充当完整census，也不以筛选后的页数证明已删除ID不存在：完整有界遍历后按createTime本地分类，另核固定已知ID集合。若来源总量超过预算，明确停止，不偷偷缩短窗口。

[Forms资源](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms)提供完整当前items/schema、linkedSheetId及opaque revisionId；仅在同Form、同API user、官方24小时保证窗口内，相同revisionId可用于证明两次Form内容未变。该内容保证不含sharing和publishSettings，不能作为权限、发布状态、回答集或Sheet版本的证据；权限和发布状态须分别直接核验。不能将revisionId跨user或用于长期恢复保证。完整捕获须校验绑定Spreadsheet与Tab对应关系，并将schema与answer questionId核对。list返回没有formId字段时，记录经过验证的请求form身份及该API形状，不伪称原response中含该字段。

[Apps Script Form](https://developers.google.com/apps-script/reference/forms/form#deleteResponse(String))明确指出删除Form回答不会删除外部响应目标的副本。因此两个namespace即使计数不同也不能互相填洞或静默当作相同来源。已知ID未出现在完整遍历中，应记录`KNOWN_RESPONSE_NOT_OBSERVED`；单次404不能独立解释为已删除，权限／绑定／读取错误不能当作空来源。可以对固定缺失ID受控get以辅助核查，仍不能取回缺失完整值。DO的已知ID集合不是全部历史回答集合。

REST Forms和Sheets grid读取相较现有FormApp桥接可能需要额外API启用／OAuth scope；本提案没有安装或授权这些能力。API可读字段及分页的文档证据不等于本项目部署账号已能调用。

## 4. Sheet完整值、cutoff与无法对应的行

[Sheets CellData](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/cells)分别表示userEnteredValue、effectiveValue和formattedValue，日期时间以数值serial表达。候选捕获应保存固定Tab ID、Spreadsheet locale/timeZone、完整header与列顺序、观测时矩阵坐标／尺寸，以及cell原输入、有效值、显示值、number format等必要类型证据；仅getDisplayValues会丢类型，仅getValues会丢公式输入。完整source record的字段范围和不支持的cell构造须在实现前定版，不能只“已知姓名列”或忽略未知列。

[spreadsheets.get](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get)支持指定grid range和field mask。范围分块必须证明完整覆盖、没有gap／重叠、保留空白和坐标；尾部省略的空cell按固定API规则表达，不能被当作删除。矩阵中间空行、重复header、重复值仍保存。日期serial不能按固定UTC偏移换算，原数值／类型与Spreadsheet时区都保留。

Sheet原行号只作为这次观测的物理坐标，不成为永久response ID。当前没有可信映射时，不按名字、timestamp、顺序或“恰好唯一的相同内容”自动配对，也不向源表追加推测ID。拟分为：

| 行类别 | 处理 |
|---|---|
| 有可信、已审核的稳定回答映射及createTime资格 | 保留当前完整cell record，按固定提交边界纳入或排除，保存mapping provenance；不强制当前Sheet值与当前Form值相同，实际差异原样留存 |
| 能明确证明首次提交晚于／等于cutoff | 不进入年度source artifact；只保存不含完整答案的排除计数／身份摘要，不能将其混进合规档案 |
| 无映射／首次提交时间证据不足／来源仍矛盾 | 原值可放**另行受保护、受预算约束的pending evidence**，标记资格UNKNOWN和原因；不是年度archive chunk，不进入source verified总量，不按当前Timestamp猜作早期或迟到 |
| 已知ID缺失／legacy成员只剩row key／题目schema无法对应 | 固定gap ledger；保留已有证据与缺失类型，不用另一namespace、成员姓名或当前题目标题补原值；source status保持未verified |

无映射的完整Sheet dump最多是pending调查材料，绝不默认符合cutoff或年度artifact。pending证据与合规archive使用不同scope／manifest／目的，不公开，不进入业务DTO；存储位置、权限、资源及保留策略须另审。若连pending evidence的安全存储尚未确定，则只返回受控`SOURCE_SCOPE_UNPROVEN`并停止，不临时把raw返回给DO或日志。

人工映射信任政策已接受，本地人工审核与 plan-only 模型也已实现，见§9；真实 Coach 鉴权、同一固定 capture 的私有读取及持久审核协议尚未接线。现有 LEGACY_ROW 或 Coach 关联 member 只属业务身份核查，不能代替响应行映射；实际接线仍须证明证据、固定版本、完整覆盖和追加更改规则。不能以人为写一个ID就自动成为可信来源，也不能为了让验收通过降低该门槛。

## 5. 观测区间与不可变捕获候选

拟先固定原source operation、command exact text／digest、team／season／binding／generation／epoch、submission cutoff、Form／Spreadsheet／Tab身份和**同事务取得的DO known-ID census**。census涵盖IMPORTED及REVIEW_REQUIRED；LEGACY_ROW和无Form映射成员单独计数，不从名单完整推断源完整。绑定变化或新请求同scope不得自动替换原捕获。后来导入的新ID不追加旧census／artifact。

每一capture attempt在有界资源下读取完整Form schema／response页和Sheet范围，将候选raw块逐块持久保存到私有staging，保留页／range请求和实际开始、结束观测时间；再独立完整读取核对。两pass须核每namespace身份、schema、完整ID集合／row覆盖、数量、typed content摘要及gap分类，不只总行数。Form分页token失效、重复ID、missing页、越预算、binding变化、任何内容漂移都停止该attempt。

两次读取相同是有限观测期间“未检出漂移”的证据，**不是Form+Sheet跨源原子快照，也不证明期间从未发生改回原值的编辑**。Form revision仅证明schema。协议记录observed interval、读序和这个一致性模型；若需要更强瞬间一致性，现有API证据不足，须另外研究且不得暗改产品语义或假称script lock阻止外部编辑。

成功固定必须将完整选定manifest、chunks与原sourceop身份一次不可变关联：所有块已有、index/offset/count/byte/digest完整、两pass证明和gap ledger固定，再发布SOURCE_CAPTURE_FIXED。即使有gap也可固定当前已捕获内容为SOURCE_NOT_VERIFIED，不能让重试重新取源修补旧manifest。后来核查只能追加独立说明，不改原块或把未保存值装作历史恢复；是否存在后续归档修订协议另审。

尚未固定而读取中断的attempt不能跨请求接着读取活页并当同一快照。原attempt状态先核清，保留已有partial证据，确认失败后才能在同outer sourceop下显式开始另一个有独立attempt身份的读取；绝不覆盖旧candidate，未知发布结果期间禁止新attempt。第一次成功固定者唯一，失败记录保留。这一状态机是提案，尚无持久实现证明。

## 6. 私有目标、未知回复与原内容恢复

只允许经登记且核验私有权限的捕获／staging目标，不开放任意Spreadsheet或范围。raw块使用版本化typed JSON文本；源公式、姓名、header都在JSON字段内存字面值，不能成为目标formulaValue。不复用业务 archiveCanonical 的 safe-integer 规则丢弃合法 Sheet 小数；现行来源纯模型保留有限 IEEE-754 数值、完整受支持字段，并将未知内容完整保留为 pending 或拒绝整份输入。canonical typed JSON 不是原 HTTP 字节或数字词法的复现，不能恢复 JSON 解析前已损失的数字精度。

[RAW写入选项](https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueInputOption)保存值而不按UI解析；若选结构化UpdateCells，则明确写stringValue而非formulaValue。这是候选安全写法，不表示旧setNumberFormat+setValues已经完成全部边界验收。读取／回执／日志也不能含raw答案、edit-response URL、credentials或公开文件定位。

未知外部回复沿原sourceop／attempt／target恢复：先读固定ledger及原manifest、完整原块集合，核exact content与持久receipt；读到target不等于原receipt已verified。缺块只允许补原staged payload，不重新Form／Sheet读取；第三种内容、重复身份或权限变化停止。nonce可更新，业务operation及payload不变。既有bridge短期nonce／receipt缓存不能充当永久source journal。

已有私有Spreadsheet内的候选技术是预先保存sheetId与operation identity，再把建Tab、identity marker与控制ledger放同一次[Sheets batchUpdate](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate)；API声明请求更新一起原子应用，且[AddSheetRequest](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request#AddSheetRequest)允许指定尚未存在的sheetId。但这只是候选：必须独测ID碰撞、并发、未知响应、marker被编辑及完整块发布。该能力不提供读前值CAS，不能单凭atomic batchUpdate实现全协议，也不解决新年度Spreadsheet创建的未知窗口。

另一私有staging候选是普通非Workspace的JSON／binary文件：[Drive创建文件说明](https://developers.google.com/workspace/drive/api/guides/create-file)允许先用generateIds取得固定ID，再以该ID创建普通文件，并明确成功后同ID重试返回409且不会创建重复文件；此能力不适用于原生Spreadsheet，也不替代年度Spreadsheet自动创建需求。候选协议须在create前可靠持久保存原payload与operation／attempt／namespace／目标ID关联，使用无转换的明确MIME；成功、未知回复或409后，按原ID用[files.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get)核身份／元信息、alt=media原bytes与摘要，并核私有ACL。409不代表内容正确；[404可能表示不存在或无读取权限](https://developers.google.com/workspace/drive/api/guides/handle-errors)，404及搜索空均不构成可换ID或重新读取活来源的依据。原payload未可靠保存且原文件读不到时必须停止，不能假称一次create已解决cold restart的原内容恢复。固定ID／appProperties不强制文件不可变，也不提供多文件原子固定；原payload持久保存、完整权限与继承ACL、[OAuth scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)、真实丢回复／并发／重启故障恢复均尚未闭环或实测。该候选只来自本轮只读官方研究，没有新增Drive接线、授权或远端写入。

## 7. source verified与验收门槛

SOURCE_CAPTURE_FIXED 是拟议的持久捕获阶段，只证明原内容与 operation 已固定；现行纯模型恒为 SOURCE_NOT_VERIFIED。SOURCE_SCOPE_UNPROVEN 是受控拒绝码，SOURCE_GAP 是证据条件分类，不能混成来源状态。GAP_LEDGER 还含 COVERAGE_LIMIT、PROOF_REQUIRED 和 UNSUPPORTED；其中覆盖限制／待证事项不等于已经发生的删除缺口，不能将条件总量称为实际丢失回答数。升级source verified至少要求完整当前可访问Form／Sheet证据、固定cutoff资格与可信映射覆盖、known-ID census无未解释缺口、原manifest/chunk全摘要与数量回读、原operation的不可变receipt及私有权限核验。业务Google verified不能替代source verified；有pending原行或known missing ID不能按“best effort”公开整季。

| 后续测试 | 必须证明 |
|---|---|
| 身份与census | 同名／同时间回答、legacy row、REVIEW_REQUIRED、已知删除／失去权限分别处理；未知读取不当作空，ID集合与完整页覆盖可复算 |
| cutoff | createTime早期但lastSubmittedTime晚期保留当前回答；真正首次迟到排除；精度边界、Sheet timestamp人工改动、无mapping均不猜资格 |
| 完整类型 | 多选／grid、遗漏回答、重复题目标题、删题后未知questionId、Unicode／小数／日期／bool／空白／公式／错误值不静默丢失；不支持题型或文件上传二进制范围未定时停在gap，不声称仅file引用已归档附件 |
| 读取竞争 | 两pass间任一namespace新增／修改／删除、schema变化或页token失效停止；记录interval，不把通过mock或单次读称原子性 |
| 固定与恢复 | 捕获发布前后中断、回复丢失、重启、并发同scope／同ID不同参数沿原ledger；成功固定后新答案不追加，已fixed但gap保留未verified |
| 存储与隐私 | 每页／chunk／census／总input前置资源预算、完整count/UTF8证明，partial未知不换target；formula-like答案只作文字；DO与公开结果／日志无raw；年度目标与pending evidence不混合 |

## 8. 实施前仍需关闭的具体问题

1. **Sheet资格与可信mapping**：本地人工审核只有声明及摘要链，尚无真实认证和固定来源证据。原Timestamp是否随native编辑改变未获官方保证；即使将来实测保持，也不能防人工更改或替代稳定ID。没有可信mapping，普通既有Sheet只能捕获pending材料，不能source verified。
2. **历史census覆盖**：REST createTime可判现存回答，不能恢复已删除已知ID或从未观测ID。known missing必须gap；不能宣称枚举了全部曾经提交。迟到与UNKNOWN Sheet行如何留pending而不入年度archive，需按§4独立实现。
3. **读取一致性与资源**：Forms分页和Sheet range没有已证明的共同snapshot token。需定版观测一致性保证、预算和失败attempt恢复；官方文档不能代替真实隔离试验。
4. **私有不可变存储与未知创建**：本机私有scope fence、原candidate／receipt CAS、独立journal的原子固定、真实ACL及单cell／payload预算已在[2026-10-03隔离验收](C2-SOURCE-JOURNAL-ISOLATED-ACCEPTANCE-2026-10-03.md)验证；仍需实际业务服务器的权威operation、长期私有存储部署、全部逐块故障恢复证据。完整 candidate 落地前的逐请求 checkpoint 已[本地实现与验收](C2-SOURCE-READ-CHECKPOINT-LOCAL-ACCEPTANCE-2026-10-03.md)，已保存块仅按原请求重放，未知返回保持 unresolved；当时复验命令被自动审批拒绝，后经用户明确授权，完整 range 保存后的跨进程续读和零来源重放已[实际验证](C2-SOURCE-READ-CHECKPOINT-ISOLATED-ACCEPTANCE-2026-10-03.md)。Spreadsheet未知创建仍停在原marker，不自动重建；年度file创建沿[原年度设计](C2-ANNUAL-ARCHIVE-DESIGN.md)独立门槛。
5. **API与类型覆盖**：Forms REST／Sheets grid能力和OAuth部署范围需独立检查；不改变既有bridge以偷带新权限。完整source类型schema、文件上传引用与附件范围须明确，遇实际不支持内容停止，不只存可读姓名冒充完整。

这些问题是具体技术与验收缺口，不重新询问用户已批准的原始来源产品语义。2026-10-01，已获授权的纯typed-record／cutoff／gap分类切片完成本地实现和双审：五namespace、pinned season_ends_at纳秒边界、decoded duplicate key拒绝、未知完整pending或整input拒绝；DECLARED_ONLY不使任何Sheet行进入年度合规chunks，结果永远LOCAL_SOURCE_PLAN_ONLY／SOURCE_NOT_VERIFIED。详见[纯来源模型本地验收](C2-SOURCE-CAPTURE-PURE-LOCAL-ACCEPTANCE.md)。这不实现本文观测／存储／未知回复状态机；Google协议、API接线、raw存储和远端验收仍需supervisor另行授权及交叉审核。

## 9. 已接受：人工映射的信任政策

状态：2026-10-01 用户已接受已认证 Coach 人工确认作为映射可信依据；本地纯审核协议已实现，真实鉴权、来源读取和持久审核未接线。已批准的捕获时完整源快照语义不变。现有响应表缺少可信的Form回答ID；现行纯模型仍为DECLARED_ONLY，将所有Sheet行保留为PRIVATE_PENDING，SHEET_CURRENT恒空，结果恒LOCAL_SOURCE_PLAN_ONLY／SOURCE_NOT_VERIFIED。接受政策不使原来源计划自动升级，也不降低来源核验门槛。

已接受的依据是已认证的Coach查看同一次固定capture内双方完整内容，逐条明确确认对应关系。审核证据须绑定原source operation／snapshot、binding／generation／epoch、双方稳定定位与完整内容hash、审核者、理由及审核时间，标记HUMAN_ATTESTED。系统不按姓名、时间或顺序自动决定映射；对应Form的createTime仍是固定提交cutoff资格依据，Sheet当前Timestamp不替代它。

人工确认是责任人的身份关联声明，不能保证该关联客观无误，也不能恢复首次提交原值、删除答案、未保存附件或从未观测的历史。重复、歧义、known missing及其他未解释缺口继续待核；不能用一个人工写入的ID消掉这些条件。

审核证据只追加。任何派生资格文件都须独立版本化并引用原固定内容hash，不修改旧raw manifest／chunks或追加新发现及迟到回答。重试仍恢复原manifest／chunks／source operation，不重新获取当前源替换原内容。完整来源读取、固定capture、权限、摘要回读、审核幂等和派生文件协议仍须实施与验收，人工确认本身不自动使整体source verified。

此信任政策不再是待用户选择项。最小本地审核模型、无需原input的完整plan验证及RETAINED_PLAN_ONLY私有人审纯入口现已完成本地实施和双审，该 adapter 切片的完整 Node357 项通过，见[私有人审adapter验收](C2-SOURCE-PLAN-REVIEW-ADAPTER-LOCAL-ACCEPTANCE.md)。它们只处理本地声明，不构成已认证Coach、真实固定capture、持久审核或source verified；原范围与缺口不变。下一步关闭私有staging原payload可靠保存、完整读取与固定capture、权限／ACL及原operation未知回复恢复门槛，再接真实审核；认证、版本、防重、资源与后续接线由团队按既定工程门槛处理。本文保留技术协议与已接受政策，不授权缩减既定完整来源范围。

## 10. 接续实施：私有读取与 journal适配器

2026-10-01，用户授权按现有计划持续推进。隔离 TypeScript适配器已实现完整 REST两遍读取、固定 Tab ID的一次原子控制头／正文写入、完整 retained plan核验、私有ACL检查和未知写回复后的原目标回读，见[本轮本地验收](C2-SOURCE-JOURNAL-LOCAL-ACCEPTANCE.md)。原 §§5／6是协议提案，不应全部升级为已实现：此次没有 source operation持久 pin、candidate逐块持久进度、观察证据永久receipt、真实Tab关联证明、Coach鉴权／审核CAS或年度文件创建。

原clasp客户端的Forms／Sheets `403 SERVICE_DISABLED` 是历史阻碍。2026-10-03独立项目 `dragon-boat-source-test` 实际grant和三项API检查通过，既有隔离Form／Sheet完整两pass、新私有journal、受控丢回复和跨进程原receipt恢复已验收。新增本机私有scope fence／完整candidate／write-start／receipt CAS，代码与真实边界见[最新真实验收](C2-SOURCE-JOURNAL-ISOLATED-ACCEPTANCE-2026-10-03.md)及[来源OAuth配置](C2-SOURCE-OAUTH-SETUP.md)。该切片使用测试cutoff、空测试census和本机actor声明；不是业务服务器source capture、已认证Coach、真实native Tab关联或source verified，原gap及全Sheet pending不变。同日后续已实现逐请求私有 checkpoint，并验证完整 candidate CAS 失败后的原内容重建；checkpoint 首个完整 range 保存后的真实跨进程恢复随后经授权通过，完整重放不再读取来源，见[实际恢复验收](C2-SOURCE-READ-CHECKPOINT-ISOLATED-ACCEPTANCE-2026-10-03.md)。实际服务器上下文本地实现见下节；长期私有存储部署及审核 CAS 继续按原门槛实施。

## 11. 接续实施：服务器权威上下文与私有 controller

2026-10-03 新增 [`C2SourceAuthority`](../cloudflare/src/c2-source-authority.ts)：通过真实 C1 签名会话，从同一 SQLite 事务读取赛季、同步绑定、全部 `source_imports` 和成员 ID，固定 actor、已结束赛季截止、binding／generation／epoch、Form／Spreadsheet／数值 Tab ID、Tab 标题声明及数据库已知 census。census 包含旧绑定的 IMPORTED／REVIEW_REQUIRED、LEGACY_ROW、停用及尚无导入关联的成员；旧 Form 身份无法证明属于当前 Form 时整份拒绝，不静默省略。原 census 跨新请求、并发及 DO 驱逐保持固定；新导入 ID 不追加旧 pin。schema16 只新增权威元数据表，完整备份扩为51表，原业务表和来源正文范围不变。

[`createAuthorizedSourceOperation`](../backend/source-journal/authority-context.ts) 组合可信已认证服务器端口与私有目标登记，初次采集不声明人工映射。读取前、候选保存前、journal 调用前和回执保存前重新确认原 pin、当前会话与私有目标。digest 证明完整性，不认证任意输入对象。会话或绑定变化停止；write-start 后拒绝仍保持原未知 marker，只能回读原目标，不能换请求／目标重新 stage。真实 SQLite 鉴权、私有候选组合、并发、重启和迁移回滚证据见[本地验收](C2-SOURCE-AUTHORITY-LOCAL-ACCEPTANCE-2026-10-03.md)。

该 pin 切片当时没有 HTTP 路由、已认证跨服务 transport 或长期私有服务部署；后续本地 HTTP／runtime 组合见下节。数据库已知 census 不是完整历史，Tab 标题与绑定声明不证明原生关联，两次来源读取不提供跨源原子性；分布式鉴权检查与外部写入也不是同一事务。只追加审核及持久 CAS、可信 Tab 证据、全部捕获故障和业务 receipt 继续独立验收，来源状态仍为 SOURCE_NOT_VERIFIED，年度导出未授权。

## 12. 接续实施：内部 HTTP 与私有 runtime

2026-10-03 后续新增 `/internal/c2/pin-source-authority`，沿既有 C2 transport gate 和 C1 Coach 会话认证，返回固定来源权威元数据。路由在生产环境仍拒绝，没有 source raw／OAuth／journal 目标输入或输出，也不调用 Google、消费 outbox 或推进业务任务。既有契约保持兼容，manifest 同步新增动作与错误码。

私有 Node 端 [`SourceServerAuthorityClient`](../backend/source-journal/server-authority-client.ts) 使用私有配置固定 HTTPS origin 和后端身份，每次取得当前 transport key／session token；不跟随重定向、不把凭据写入 URL／文件／错误。完整响应含 envelope 最多2 MB，核 request／contract／instance／generation／epoch／team／season 与 pin 摘要后才返回。该 envelope 上限可能拒绝接近2 MB的合法 pin，不返回部分 census 或弱化预算。

[`PrivateSourceTargetRegistry`](../backend/source-journal/target-registry.ts) 在私有 CAS 保存一次性 pin 与 attempt／API owner／journal 目标；新请求不能替换，同身份重放恢复原登记。独立 Node 进程恢复、确认丢失、并发与内容篡改已测。[`createPrivateSourceRuntime`](../backend/source-journal/private-runtime.ts) 组合服务器端口、原登记、reader、强制持久 checkpoint 和 journal；实际 Google 请求前后复核当前权威，撤销会话后不发后续请求或保存完整候选，未知请求和 journal 写入保持原恢复规则。

该切片均为本地实现和本地 Worker HTTP／模拟 REST 验收，没有公网 TLS／远端 HTTP 接线验收、长期私有 host、实际服务器来源 capture 或新 Google 操作；见[接线本地验收](C2-SOURCE-TRANSPORT-LOCAL-ACCEPTANCE-2026-10-03.md)。当时已认证候选读取与只追加审核CAS待实现，后续进展见下节；原未核验状态、pending 内容和年度授权限制不变。

## 13. 接续实施：已认证原候选读取与私有审核 CAS

2026-10-03，`PrivateSourceOperation.readForReview()` 强制已认证权威和原 `JOURNAL_READBACK_CONFIRMED`，仅从原candidate／receipt取得固定完整core。入口、审核保存前和返回前复核服务器权威、原上下文／内容及原journal当前私有权限；没有审核触发的source重读、stage或新目标。

[`PrivateSourceReview`](../backend/source-journal/private-review.ts) 复用现行retained plan／完整审核链，独立私有CAS保存HUMAN_ATTESTED。key按team／原operation固定，identity绑定原context／candidate／plan／receipt；actor是原已认证capture actor，时间来自host并不得早于capture或前一审核。全部输出预算在新证据CAS前检查，不同命令竞争失败不自动重排，相同请求或确认丢失恢复原证据；后续追加后旧请求恢复原派生prefix和时间。

内层LOCAL_* provenance不改，外层只声明PRIVATE_REVIEW_LEDGER_DURABLE_ONLY／RETAINED_PLAN_ONLY。原source、journal、pending和gap不修改，来源仍SOURCE_NOT_VERIFIED、年度导出false。真实本地HTTP／SQLite会话及两个独立Node进程恢复已有[验收](C2-PRIVATE-SOURCE-REVIEW-LOCAL-ACCEPTANCE-2026-10-03.md)，Google仍为虚构模型。没有审核HTTP／UI、其他Coach委派或长期host部署；分布式鉴权／Google／CAS不具原子性。长期服务、公网及实际服务器capture、可信Tab、全部故障及年度receipt继续独立验收。
