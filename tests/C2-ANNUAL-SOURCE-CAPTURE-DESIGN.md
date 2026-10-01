# C2.6 完整原始来源捕获 - 技术设计提案

日期：2026-10-01。只依据现有源码与 Google 官方 API 文档研究；没有读取真实 Form／Sheet、安装 API、改动 bridge 或执行远端试验。用户已批准的产品语义见[年度设计 §6](C2-ANNUAL-ARCHIVE-DESIGN.md#6-后续-bridge-与技术核验门槛)及[后端归档规格](../google-sheets-backend-spec.md)。本文提出技术协议与未解门槛，不宣布来源捕获、持久恢复或 source verified 已实现。

## 1. 已固定的语义与本轮范围

首次成功固定的不可变 source capture 保存归档捕获时完整当前来源，提交 cutoff 固定后不变；不是首次提交时原答案，也不是某个历史截止瞬间的完整值。`submission_cutoff_at` 与业务归档的 `cutoff_at`、实际 `observed_start_at`／`observed_end_at`／`captured_at` 分开。建议提交范围沿用现有 C2 导入的 `submitted < season_ends_at` 边界，并由已固定赛季／绑定参数派生，不允许调用者自行扩大；源实现前由 supervisor 核定此技术字段与比较规则。

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

可信mapping的建立协议目前未解决：现有LEGACY_ROW或Coach关联member只是业务身份核查；任何新mapping都必须说明证据、固定版本、完整覆盖和更改规则，并单独审阅。不能以人为写一个ID就自动成为可信来源，也不能为了让验收通过降低该门槛。

## 5. 观测区间与不可变捕获候选

拟先固定原source operation、command exact text／digest、team／season／binding／generation／epoch、submission cutoff、Form／Spreadsheet／Tab身份和**同事务取得的DO known-ID census**。census涵盖IMPORTED及REVIEW_REQUIRED；LEGACY_ROW和无Form映射成员单独计数，不从名单完整推断源完整。绑定变化或新请求同scope不得自动替换原捕获。后来导入的新ID不追加旧census／artifact。

每一capture attempt在有界资源下读取完整Form schema／response页和Sheet范围，将候选raw块逐块持久保存到私有staging，保留页／range请求和实际开始、结束观测时间；再独立完整读取核对。两pass须核每namespace身份、schema、完整ID集合／row覆盖、数量、typed content摘要及gap分类，不只总行数。Form分页token失效、重复ID、missing页、越预算、binding变化、任何内容漂移都停止该attempt。

两次读取相同是有限观测期间“未检出漂移”的证据，**不是Form+Sheet跨源原子快照，也不证明期间从未发生改回原值的编辑**。Form revision仅证明schema。协议记录observed interval、读序和这个一致性模型；若需要更强瞬间一致性，现有API证据不足，须另外研究且不得暗改产品语义或假称script lock阻止外部编辑。

成功固定必须将完整选定manifest、chunks与原sourceop身份一次不可变关联：所有块已有、index/offset/count/byte/digest完整、两pass证明和gap ledger固定，再发布SOURCE_CAPTURE_FIXED。即使有gap也可固定当前已捕获内容为SOURCE_NOT_VERIFIED，不能让重试重新取源修补旧manifest。后来核查只能追加独立说明，不改原块或把未保存值装作历史恢复；是否存在后续归档修订协议另审。

尚未固定而读取中断的attempt不能跨请求接着读取活页并当同一快照。原attempt状态先核清，保留已有partial证据，确认失败后才能在同outer sourceop下显式开始另一个有独立attempt身份的读取；绝不覆盖旧candidate，未知发布结果期间禁止新attempt。第一次成功固定者唯一，失败记录保留。这一状态机是提案，尚无持久实现证明。

## 6. 私有目标、未知回复与原内容恢复

只允许经登记且核验私有权限的捕获／staging目标，不开放任意Spreadsheet或范围。raw块使用版本化typed JSON文本；源公式、姓名、header都在JSON字段内存字面值，不能成为目标formulaValue。不得复用业务archiveCanonical的safe-integer规则丢弃合法Sheet小数，应另审finite number和完整API类型canonical协议。

[RAW写入选项](https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueInputOption)保存值而不按UI解析；若选结构化UpdateCells，则明确写stringValue而非formulaValue。这是候选安全写法，不表示旧setNumberFormat+setValues已经完成全部边界验收。读取／回执／日志也不能含raw答案、edit-response URL、credentials或公开文件定位。

未知外部回复沿原sourceop／attempt／target恢复：先读固定ledger及原manifest、完整原块集合，核exact content与持久receipt；读到target不等于原receipt已verified。缺块只允许补原staged payload，不重新Form／Sheet读取；第三种内容、重复身份或权限变化停止。nonce可更新，业务operation及payload不变。既有bridge短期nonce／receipt缓存不能充当永久source journal。

已有私有Spreadsheet内的候选技术是预先保存sheetId与operation identity，再把建Tab、identity marker与控制ledger放同一次[Sheets batchUpdate](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate)；API声明请求更新一起原子应用，且[AddSheetRequest](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request#AddSheetRequest)允许指定尚未存在的sheetId。但这只是候选：必须独测ID碰撞、并发、未知响应、marker被编辑及完整块发布。该能力不提供读前值CAS，不能单凭atomic batchUpdate实现全协议，也不解决新年度Spreadsheet创建的未知窗口。

另一私有staging候选是普通非Workspace的JSON／binary文件：[Drive创建文件说明](https://developers.google.com/workspace/drive/api/guides/create-file)允许先用generateIds取得固定ID，再以该ID创建普通文件，并明确成功后同ID重试返回409且不会创建重复文件；此能力不适用于原生Spreadsheet，也不替代年度Spreadsheet自动创建需求。候选协议须在create前可靠持久保存原payload与operation／attempt／namespace／目标ID关联，使用无转换的明确MIME；成功、未知回复或409后，按原ID用[files.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get)核身份／元信息、alt=media原bytes与摘要，并核私有ACL。409不代表内容正确；[404可能表示不存在或无读取权限](https://developers.google.com/workspace/drive/api/guides/handle-errors)，404及搜索空均不构成可换ID或重新读取活来源的依据。原payload未可靠保存且原文件读不到时必须停止，不能假称一次create已解决cold restart的原内容恢复。固定ID／appProperties不强制文件不可变，也不提供多文件原子固定；原payload持久保存、完整权限与继承ACL、[OAuth scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)、真实丢回复／并发／重启故障恢复均尚未闭环或实测。该候选只来自本轮只读官方研究，没有新增Drive接线、授权或远端写入。

## 7. source verified与验收门槛

SOURCE_CAPTURE_FIXED只证明原内容与operation已固定；SOURCE_NOT_VERIFIED／SOURCE_SCOPE_UNPROVEN／SOURCE_GAP保留原因。升级source verified至少要求完整当前可访问Form／Sheet证据、固定cutoff资格与可信映射覆盖、known-ID census无未解释缺口、原manifest/chunk全摘要与数量回读、原operation的不可变receipt及私有权限核验。业务Google verified不能替代source verified；有pending原行或known missing ID不能按“best effort”公开整季。

| 后续测试 | 必须证明 |
|---|---|
| 身份与census | 同名／同时间回答、legacy row、REVIEW_REQUIRED、已知删除／失去权限分别处理；未知读取不当作空，ID集合与完整页覆盖可复算 |
| cutoff | createTime早期但lastSubmittedTime晚期保留当前回答；真正首次迟到排除；精度边界、Sheet timestamp人工改动、无mapping均不猜资格 |
| 完整类型 | 多选／grid、遗漏回答、重复题目标题、删题后未知questionId、Unicode／小数／日期／bool／空白／公式／错误值不静默丢失；不支持题型或文件上传二进制范围未定时停在gap，不声称仅file引用已归档附件 |
| 读取竞争 | 两pass间任一namespace新增／修改／删除、schema变化或页token失效停止；记录interval，不把通过mock或单次读称原子性 |
| 固定与恢复 | 捕获发布前后中断、回复丢失、重启、并发同scope／同ID不同参数沿原ledger；成功固定后新答案不追加，已fixed但gap保留未verified |
| 存储与隐私 | 每页／chunk／census／总input前置资源预算、完整count/UTF8证明，partial未知不换target；formula-like答案只作文字；DO与公开结果／日志无raw；年度目标与pending evidence不混合 |

## 8. 实施前仍需关闭的具体问题

1. **Sheet资格与可信mapping**：现有代码没有证据。原Timestamp是否随native编辑改变未获官方保证；即使将来实测保持，也不能防人工更改或替代稳定ID。没有可信mapping，普通既有Sheet只能捕获pending材料，不能source verified。
2. **历史census覆盖**：REST createTime可判现存回答，不能恢复已删除已知ID或从未观测ID。known missing必须gap；不能宣称枚举了全部曾经提交。迟到与UNKNOWN Sheet行如何留pending而不入年度archive，需按§4独立实现。
3. **读取一致性与资源**：Forms分页和Sheet range没有已证明的共同snapshot token。需定版观测一致性保证、预算和失败attempt恢复；官方文档不能代替真实隔离试验。
4. **私有不可变存储与未知创建**：staging位置、原控制ledger／完整块一次固定、权限、单cell／payload大小和永久receipt尚未实现。已存在目标内fixed sheetId只是候选；年度file创建仍沿[原年度设计](C2-ANNUAL-ARCHIVE-DESIGN.md)独立门槛。
5. **API与类型覆盖**：Forms REST／Sheets grid能力和OAuth部署范围需独立检查；不改变既有bridge以偷带新权限。完整source类型schema、文件上传引用与附件范围须明确，遇实际不支持内容停止，不只存可读姓名冒充完整。

这些问题是具体技术与验收缺口，不重新询问用户已批准的原始来源产品语义。2026-10-01，已获授权的纯typed-record／cutoff／gap分类切片完成本地实现和双审：五namespace、pinned season_ends_at纳秒边界、decoded duplicate key拒绝、未知完整pending或整input拒绝；DECLARED_ONLY不使任何Sheet行进入年度合规chunks，结果永远LOCAL_SOURCE_PLAN_ONLY／SOURCE_NOT_VERIFIED。详见[纯来源模型本地验收](C2-SOURCE-CAPTURE-PURE-LOCAL-ACCEPTANCE.md)。这不实现本文观测／存储／未知回复状态机；Google协议、API接线、raw存储和远端验收仍需supervisor另行授权及交叉审核。
