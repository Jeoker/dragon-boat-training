# C2.6 完整原始来源捕获设计

长期运行采用独立Cloudflare私有Worker／DO；业务TeamState只保存身份和权威元数据，Node工具仅用于本地验收和运维。本文维护当前来源协议，实现与部署状态见[当前进度](../CURRENT-STATUS.md)。

当前来源范围、固定cutoff与HUMAN_ATTESTED政策见[年度设计](C2-ANNUAL-ARCHIVE-DESIGN.md)和[后端归档规格](../google-sheets-backend-spec.md)。长期存储与运行方式见[Cloudflare私有服务](../cloudflare/PRIVATE-SOURCE-HOST-DESIGN.md)。

## 1. 捕获语义与范围

首次成功固定的不可变 source capture 保存归档捕获时完整当前来源，提交 cutoff 固定后不变；不是首次提交时原答案，也不是某个历史截止瞬间的完整值。`submission_cutoff_at` 与业务归档的 `cutoff_at`、实际 `observed_start_at`／`observed_end_at`／`captured_at` 分开。当前本地模型按 Form `createTime < pinned season_ends_at` 的纳秒边界判提交资格，由固定赛季／绑定参数派生 cutoff，不允许调用者扩大；真实来源读取仍须证明对应首次时间与绑定。

Form回答与response Sheet采用两个独立record namespace，分别保存完整身份、schema、值与类型、数量和摘要，不拼成推测的原始答案表。原回答、候选、checkpoint和审核全文保存在独立Cloudflare私有Worker／DO；业务TeamState只保留command、已知census、摘要／计数、gap与业务receipt。原文不进入业务DTO、公开页面、普通备份或日志。

成功固定后，原请求／source operation 恢复原 manifest 和 chunks，不重新获取当前来源替换内容；之后新发现或迟到的回答不追加旧档。已知删除、缺失或无法对应的内容明确保持未 verified。未知历史删除且系统从未保存其 ID 或完整值，无法凭本方案发现或恢复；manifest 必须声明这个覆盖边界。

本文规定来源协议；年度文件创建、业务 receipt 与公开发布沿[年度设计](C2-ANNUAL-ARCHIVE-DESIGN.md)实施，当前状态集中于[当前进度](../CURRENT-STATUS.md)。

## 2. 现有代码能提供什么

| 来源 | 当前证据及限制 |
|---|---|
| [FormBridge.gs](../backend/src/FormBridge.gs) | `cloudflareReadFormResponses_` 使用 FormApp稳定response ID、`getTimestamp()`、当前姓名。虽先调用getResponses再切页，却只返回精简字段；不是完整回答捕获或有界全来源存储协议 |
| [SeasonActions.gs](../backend/src/SeasonActions.gs) | 绑定保存Form／Spreadsheet／response Tab ID，核Tab关联Form；schema fingerprint只覆盖当前header。field_mapping仅显示姓名header，旧member source_key为Tab ID:原行号；没有可信Formresponse ID↔Sheet row关系，也没有已固定的首次提交时间列协议 |
| [c2-form-service.ts](../cloudflare/src/c2-form-service.ts)及[schema.ts](../cloudflare/src/schema.ts) | source_imports保存FORM_RESPONSE／LEGACY_ROW身份与精简digest；form_source_observations保存当前提交时间／姓名并原位更新。可构成已知回答ID census，不能恢复未保存的完整答案；member链接不等于响应表行链接 |
| [ArchiveActions.gs](../backend/src/ArchiveActions.gs) | `seasonArchiveRows_`以getValues读取当前Sheet全矩阵并JSON编码，未按回答提交时间筛选；ERROR重试会重新取源。旧写法不能直接充当本文不可变协议，也不能证明Form全schema／全部类型或历史完整性 |

现有绑定没有规定唯一时间header，也没有证明native Sheet Timestamp等于首次提交时间。[FormResponse文档](https://developers.google.com/apps-script/reference/forms/form-response#getTimestamp())仅称getTimestamp为一次回答提交的时间；没有为本项目提供“编辑后始终保持首次时间”的保证。Sheet中的时间单元格又属于可编辑值，不能将当前显示值当作不可变资格证据。native重新提交如何更新该列尚未实测，当前协议不以可编辑的Sheet Timestamp决定首次提交资格。

## 3. 官方能力、读取方式与时间边界

[Forms REST FormResponse](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses)明确区分首次提交`createTime`和最近提交`lastSubmittedTime`，回答按questionId保存。这使**仍可访问回答**的首次提交范围可判定；不会恢复其过去内容、已删除回答或已丢失的题目schema。回答数组、文件引用和quiz字段按原API类型保存，不按网页需要只保留姓名。RFC3339可能有纳秒部分，cutoff比较不得先用Date毫秒截断而放过边界；保留原时间文本并以明确精度比较。

[forms.responses.list](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses/list)支持分页，pageToken后续调用须沿同form/filter；返回不足pageSize不代表结束，必须检查nextPageToken。该API只列出当前返回的回答，没有在此文档中承诺历史墓碑或跨页固定快照。不使用当前导入的重叠时间窗充当完整census，也不以筛选后的页数证明已删除ID不存在：完整有界遍历后按createTime本地分类，另核固定已知ID集合。若来源总量超过预算，明确停止，不偷偷缩短窗口。

[Forms资源](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms)提供完整当前items/schema、linkedSheetId及opaque revisionId；仅在同Form、同API user、官方24小时保证窗口内，相同revisionId可用于证明两次Form内容未变。该内容保证不含sharing和publishSettings，不能作为权限、发布状态、回答集或Sheet版本的证据；权限和发布状态须分别直接核验。不能将revisionId跨user或用于长期恢复保证。完整捕获须校验绑定Spreadsheet与Tab对应关系，并将schema与answer questionId核对。list返回没有formId字段时，记录经过验证的请求form身份及该API形状，不伪称原response中含该字段。

[Apps Script Form](https://developers.google.com/apps-script/reference/forms/form#deleteResponse(String))明确指出删除Form回答不会删除外部响应目标的副本。因此两个namespace即使计数不同也不能互相填洞或静默当作相同来源。已知ID未出现在完整遍历中，应记录`KNOWN_RESPONSE_NOT_OBSERVED`；单次404不能独立解释为已删除，权限／绑定／读取错误不能当作空来源。可以对固定缺失ID受控get以辅助核查，仍不能取回缺失完整值。DO的已知ID集合不是全部历史回答集合。

独立Forms／Sheets／Drive OAuth和真实隔离读取已有验证。云端凭据通过private Worker secrets注入；实际业务服务器的当前权限、绑定与来源读取须逐次核对，API可用不证明来源完整或年度资格。

## 4. Sheet完整值、cutoff与无法对应的行

[Sheets CellData](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/cells)分别表示userEnteredValue、effectiveValue和formattedValue，日期时间以数值serial表达。候选捕获应保存固定Tab ID、Spreadsheet locale/timeZone、完整header与列顺序、观测时矩阵坐标／尺寸，以及cell原输入、有效值、显示值、number format等必要类型证据；仅getDisplayValues会丢类型，仅getValues会丢公式输入。完整source record的字段范围和不支持的cell构造须在实现前定版，不能只“已知姓名列”或忽略未知列。

[spreadsheets.get](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get)支持指定grid range和field mask。范围分块必须证明完整覆盖、没有gap／重叠、保留空白和坐标；尾部省略的空cell按固定API规则表达，不能被当作删除。矩阵中间空行、重复header、重复值仍保存。日期serial不能按固定UTC偏移换算，原数值／类型与Spreadsheet时区都保留。

Sheet原行号只作为这次观测的物理坐标，不成为永久response ID。当前没有可信映射时，不按名字、timestamp、顺序或“恰好唯一的相同内容”自动配对，也不向源表追加推测ID。按以下五类保存：

| 行类别 | 处理 |
|---|---|
| 有可信、已审核的稳定回答映射及createTime资格 | 保留当前完整cell record，按固定提交边界纳入或排除，保存mapping provenance；不强制当前Sheet值与当前Form值相同，实际差异原样留存 |
| 能明确证明首次提交晚于／等于cutoff | 不进入年度source artifact；只保存不含完整答案的排除计数／身份摘要，不能将其混进合规档案 |
| 无映射／首次提交时间证据不足／来源仍矛盾 | 原值可放**另行受保护、受预算约束的pending evidence**，标记资格UNKNOWN和原因；不是年度archive chunk，不进入source verified总量，不按当前Timestamp猜作早期或迟到 |
| 已知ID缺失／legacy成员只剩row key／题目schema无法对应 | 固定gap ledger；保留已有证据与缺失类型，不用另一namespace、成员姓名或当前题目标题补原值；source status保持未verified |

无映射的完整Sheet dump只作私有pending调查材料，不默认符合cutoff或年度artifact。pending与合规archive使用不同scope／manifest／目的，在独立私有DO遵守预算与当前权限，不公开、不进入业务DTO。存储或权限未确认时返回SOURCE_SCOPE_UNPROVEN并停止，不临时把raw发到业务TeamState或日志。

人工映射采用HUMAN_ATTESTED政策；当前Coach鉴权、原确认候选读取、journal复核及持久只追加CAS已有本地实现，云端运行入口、其他Coach委派和网页另验收。LEGACY_ROW或member关联不能代替响应行映射；实际接线须证明固定内容、覆盖、权限与追加更改，不能人为填ID就提升来源状态。

## 5. 观测区间与不可变捕获候选

先固定原source operation、command exact text／digest、team／season／binding／generation／epoch、submission cutoff、Form／Spreadsheet／Tab身份和**同事务取得的DO known-ID census**。census涵盖IMPORTED及REVIEW_REQUIRED；LEGACY_ROW和无Form映射成员单独计数，不从名单完整推断源完整。绑定变化或新请求同scope不得自动替换原捕获。后来导入的新ID不追加旧census／artifact。

每一capture attempt在有界资源下读取完整Form schema／response页和Sheet范围，将候选raw块逐块持久保存到私有staging，保留页／range请求和实际开始、结束观测时间；再独立完整读取核对。两pass须核每namespace身份、schema、完整ID集合／row覆盖、数量、typed content摘要及gap分类，不只总行数。Form分页token失效、重复ID、missing页、越预算、binding变化、任何内容漂移都停止该attempt。

两次读取相同是有限观测期间“未检出漂移”的证据，**不是Form+Sheet跨源原子快照，也不证明期间从未发生改回原值的编辑**。Form revision仅证明schema。协议记录observed interval、读序和这个一致性模型；若需要更强瞬间一致性，现有API证据不足，须另外研究且不得暗改产品语义或假称script lock阻止外部编辑。

成功固定必须将完整选定manifest、chunks与原sourceop身份一次不可变关联：所有块已有、index/offset/count/byte/digest完整、两pass证明和gap ledger固定，再发布SOURCE_CAPTURE_FIXED。即使有gap也可固定当前已捕获内容为SOURCE_NOT_VERIFIED，不能让重试重新取源修补旧manifest。后来核查只能追加独立说明，不改原块或把未保存值装作历史恢复；是否存在后续归档修订协议另审。

读取中断后只重放原 checkpoint 中已保存的请求结果；未决返回停止，不重新获取该页替换原内容。operation、candidate 与 write-start 已有持久 CAS；显式放弃或另起 attempt 必须先核清原未决状态，不能覆盖旧 candidate。

## 6. 私有目标、未知回复与原内容恢复

只允许经登记且核验私有权限的捕获／staging目标，不开放任意Spreadsheet或范围。raw块使用版本化typed JSON文本；源公式、姓名、header都在JSON字段内存字面值，不能成为目标formulaValue。不复用业务 archiveCanonical 的 safe-integer 规则丢弃合法 Sheet 小数；现行来源纯模型保留有限 IEEE-754 数值、完整受支持字段，并将未知内容完整保留为 pending 或拒绝整份输入。canonical typed JSON 不是原 HTTP 字节或数字词法的复现，不能恢复 JSON 解析前已损失的数字精度。

[RAW写入选项](https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueInputOption)保存值而不按UI解析；若选结构化UpdateCells，则明确写stringValue而非formulaValue。私有 journal 已采用结构化 stringValue；年度输出须复用明确的纯文本安全协议并独立验收，不从旧 setValues 推断通过。读取／回执／日志也不能含raw答案、edit-response URL、credentials或公开文件定位。

未知外部回复沿原sourceop／attempt／target恢复：先读固定ledger及原manifest、完整原块集合，核exact content与持久receipt；读到target不等于原receipt已verified。缺块只允许补原staged payload，不重新Form／Sheet读取；第三种内容、重复身份或权限变化停止。nonce可更新，业务operation及payload不变。既有bridge短期nonce／receipt缓存不能充当永久source journal。

Google 私有 journal 使用预先登记的 Spreadsheet、数字 sheetId 与 operation identity，将建 Tab、identity marker、控制头和正文放在同一次 [Sheets batchUpdate](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate)；当前读取与未知回复恢复证据见[真实验收](CURRENT-VERIFICATION.md#来源采集与审核)。它不提供读前值 CAS，也不解决年度 Spreadsheet 创建的未知窗口。

operation、checkpoint、原 candidate 与私有审核 ledger 的长期存储采用[独立 Cloudflare 私有 DO](../cloudflare/PRIVATE-SOURCE-HOST-DESIGN.md)。完整记录使用分块、摘要和 revision CAS；业务 TeamState 及公开接口只接收有界权威／资格元数据。云端运行、备份恢复和免费资源预算仍须实测。

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

1. **Sheet资格与可信mapping**：已认证原候选读取与只追加审核 CAS 有本地证据，可信原生 Tab 关联和受保护网页仍待验收。原 Timestamp 无不可变保证；普通既有 Sheet 只捕获 pending 材料，不能凭时间、姓名或位置 source verified。
2. **历史census覆盖**：REST createTime可判现存回答，不能恢复已删除已知ID或从未观测ID。known missing必须gap；不能宣称枚举了全部曾经提交。迟到与UNKNOWN Sheet行如何留pending而不入年度archive，需按§4独立实现。
3. **读取一致性与资源**：采用完整两遍读取与逐请求 checkpoint，结果为 TWO_READS_MATCHED_NOT_ATOMIC。没有共同 snapshot token；真实云端资源预算及全部未决窗口须单独验收。
4. **私有不可变存储与未知创建**：原candidate／write-start／receipt CAS、Google journal原子写入／回读及真实ACL已有[实际证据](CURRENT-VERIFICATION.md#来源采集与审核)；逐请求checkpoint见[恢复证据](CURRENT-VERIFICATION.md#来源采集与审核)。Cloudflare运行接线和有界独立SQLite封存备份恢复已本地验证，真实云部署／restore及全部故障仍待验收；Spreadsheet未知创建停在原marker，不换目标。
5. **API与类型覆盖**：Forms REST／Sheets grid能力和OAuth部署范围需独立检查；不改变既有bridge以偷带新权限。完整source类型schema、文件上传引用与附件范围须明确，遇实际不支持内容停止，不只存可读姓名冒充完整。

当前纯模型包含五namespace、固定season_ends_at纳秒边界、decoded duplicate key拒绝与未知完整pending或整input拒绝；DECLARED_ONLY不使任何Sheet行进入年度合规chunks，结果保持LOCAL_SOURCE_PLAN_ONLY／SOURCE_NOT_VERIFIED。纯模型证据见[本地验收](CURRENT-VERIFICATION.md#来源采集与审核)。真实运行、checkpoint、未知回复和私有存储由下述外层组件承担，云端及业务来源验收仍需完成。

## 9. 已接受：人工映射的信任政策

人工映射基于已认证Coach查看同一次固定capture双方完整内容后逐条确认，标记HUMAN_ATTESTED。当前鉴权、来源读取和持久审核已有组件实现；云端与真实业务接线仍需验收。原计划保持DECLARED_ONLY，所有Sheet行仍为PRIVATE_PENDING，SHEET_CURRENT恒空，LOCAL_SOURCE_PLAN_ONLY／SOURCE_NOT_VERIFIED不因人工声明自动升级。

已接受的依据是已认证的Coach查看同一次固定capture内双方完整内容，逐条明确确认对应关系。审核证据须绑定原source operation／snapshot、binding／generation／epoch、双方稳定定位与完整内容hash、审核者、理由及审核时间，标记HUMAN_ATTESTED。系统不按姓名、时间或顺序自动决定映射；对应Form的createTime仍是固定提交cutoff资格依据，Sheet当前Timestamp不替代它。

人工确认是责任人的身份关联声明，不能保证该关联客观无误，也不能恢复首次提交原值、删除答案、未保存附件或从未观测的历史。重复、歧义、known missing及其他未解释缺口继续待核；不能用一个人工写入的ID消掉这些条件。

审核证据只追加。任何派生资格文件都须独立版本化并引用原固定内容hash，不修改旧raw manifest／chunks或追加新发现及迟到回答。重试仍恢复原manifest／chunks／source operation，不重新获取当前源替换原内容。真实业务完整采集、资格派生和年度文件协议仍须接线与验收，人工确认本身不自动使整体source verified。

人工关联政策已确认。纯模型、retained plan validator／adapter、认证原候选读取与持久审核 CAS 已有[本地证据](CURRENT-VERIFICATION.md)。模型 provenance 不升级为真实 source receipt；原缺口继续保留。Cloudflare 运行接线、实际业务 capture、可信 Tab、审核 UI 与年度 receipt 仍须独立验收。

## 10. 私有读取与 journal适配器

完整 REST 两遍读取、固定 Tab ID 的一次原子控制头／正文写入、retained plan 核验、私有 ACL 和未知写回复回读由[reader／journal 组件](CURRENT-VERIFICATION.md#来源采集与审核)实现。现有 runtime 同时组合服务器权威、逐请求 checkpoint、持久目标登记与 operation CAS。

真实隔离两遍读取、journal与checkpoint证据统一见[验证索引](CURRENT-VERIFICATION.md#来源采集与审核)。该Google读取使用测试context，不能与业务服务器模型结果合并宣称真实业务 capture。

## 11. 服务器权威上下文与私有 controller

[`C2SourceAuthority`](../cloudflare/src/c2-source-authority.ts)通过真实 C1 签名会话，从同一 SQLite 事务读取赛季、同步绑定、全部 `source_imports` 和成员 ID，固定 actor、已结束赛季截止、binding／generation／epoch、Form／Spreadsheet／数值 Tab ID、Tab 标题声明及数据库已知 census。census包含旧绑定的IMPORTED／REVIEW_REQUIRED、LEGACY_ROW、停用及尚无导入关联的成员；旧Form身份无法证明属于当前Form时整份拒绝，不静默省略。原census跨恢复、并发及DO驱逐保持固定，新导入ID不追加旧pin；原pin限原actor与原request。当前schema16／51表备份含权威元数据，来源正文单独私有保存。

[`createAuthorizedSourceOperation`](../backend/source-journal/authority-context.ts) 组合可信已认证服务器端口与私有目标登记，初次采集不声明人工映射。读取前、候选保存前、journal 调用前和回执保存前重新确认原 pin、当前会话与私有目标。digest 证明完整性，不认证任意输入对象。会话或绑定变化停止；write-start 后拒绝仍保持原未知 marker，只能回读原目标，不能换请求／目标重新 stage。真实 SQLite 鉴权、私有候选组合、并发、重启和迁移回滚证据见[本地验收](CURRENT-VERIFICATION.md#来源采集与审核)。

数据库已知census不是完整历史，Tab标题与绑定声明不证明原生关联，两遍读取不是跨源原子快照。显式[新capture-native](../cloudflare/ISOLATED-RECOVERY.md#新capture消费原生证明)消费可信原生HMAC单点观察，固定首checkpoint及v2 candidate原proof／actor／attempt／pin与context摘要；原pin／core／plan hash不变，旧候选不回填。普通capture及Node CLI仍为SERVER_BINDING_DECLARATION_ONLY。原生receipt恢复依赖私有DO／完整backup，Google journal core单独不足；原pin限原actor／request，其他Coach委派未实现。真实Google、全部故障与业务receipt须独立验收，来源SOURCE_NOT_VERIFIED，年度未授权。

## 12. 内部 HTTP 与私有 runtime

现有 `/internal/c2/pin-source-authority`，沿既有 C2 transport gate 和 C1 Coach 会话认证，返回固定来源权威元数据。路由在生产环境仍拒绝，没有 source raw／OAuth／journal 目标输入或输出，也不调用 Google、消费 outbox 或推进业务任务。既有契约保持兼容，manifest 同步新增动作与错误码。

私有 Node 端 [`SourceServerAuthorityClient`](../backend/source-journal/server-authority-client.ts) 使用私有配置固定 HTTPS origin 和后端身份，每次取得当前 transport key／session token；不跟随重定向、不把凭据写入 URL／文件／错误。完整响应含 envelope 最多2 MB，核 request／contract／instance／generation／epoch／team／season 与 pin 摘要后才返回。该 envelope 上限可能拒绝接近2 MB的合法 pin，不返回部分 census 或弱化预算。

[`PrivateSourceTargetRegistry`](../backend/source-journal/target-registry.ts) 在私有 CAS 保存一次性 pin 与 attempt／API owner／journal 目标；新请求不能替换，同身份重放恢复原登记。独立 Node 进程恢复、确认丢失、并发与内容篡改已测。[`createPrivateSourceRuntime`](../backend/source-journal/private-runtime.ts) 组合服务器端口、原登记、reader、强制持久 checkpoint 和 journal；实际 Google 请求前后复核当前权威，撤销会话后不发后续请求或保存完整候选，未知请求和 journal 写入保持原恢复规则。

路由、客户端与runtime已通过本地Worker HTTP／模拟REST验收，见[接线记录](CURRENT-VERIFICATION.md#来源采集与审核)。Cloudflare私有入口／命名Worker／当前TeamState会话组合已本地验证，真实云部署、公网拒绝与实际服务器capture尚未验收；认证候选读取与审核CAS的当前协议见下节。

## 13. 已认证原候选读取与私有审核 CAS

`PrivateSourceOperation.readForReview()` 强制已认证权威和原 `JOURNAL_READBACK_CONFIRMED`，仅从原candidate／receipt取得固定完整core。入口、审核保存前和返回前复核服务器权威、原上下文／内容及原journal当前私有权限；没有审核触发的source重读、stage或新目标。

[`PrivateSourceReview`](../backend/source-journal/private-review.ts) 复用现行retained plan／完整审核链，独立私有CAS保存HUMAN_ATTESTED。key按team／原operation固定，identity绑定原context／candidate／plan／receipt；actor是原已认证capture actor，时间来自host并不得早于capture或前一审核。全部输出预算在新证据CAS前检查，不同命令竞争失败不自动重排，相同请求或确认丢失恢复原证据；后续追加后旧请求恢复原派生prefix和时间。

内层LOCAL_* provenance不改，外层只声明PRIVATE_REVIEW_LEDGER_DURABLE_ONLY／RETAINED_PLAN_ONLY。原source／journal／pending／gap不修改，来源SOURCE_NOT_VERIFIED、年度false。本地HTTP／SQLite会话与跨进程恢复已有[证据](CURRENT-VERIFICATION.md#来源采集与审核)，当前私有云端命令入口已支持受保护review-view／review-append，Google仍为模型。浏览器审核UI、其他Coach委派、真实部署／Google及年度receipt未验；分布式鉴权／Google／CAS不具原子性。封存恢复上限及独立Tab观察边界见[当前指南](../cloudflare/ISOLATED-RECOVERY.md)。
