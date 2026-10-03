# C2.6 完整来源纯模型 - 本地验收

日期：2026-10-01。按 supervisor 批准的 [来源技术设计](C2-ANNUAL-SOURCE-CAPTURE-DESIGN.md) 实现，仅新增两份 shared 模块、Node 测试和本报告。已提交业务持久计划 stage 2 为 `13e8fc0`，本地 schema15／50表；远端实际仍为 Worker `0.17.0-c2-associated-lanes`、schema14／47表。本切片不改上述实现、schema、运行配置或实际验收报告。

## 实现范围及输入约束

[contract](../shared/c2-source-capture-contract.ts) 接受原始 JSON 文本及调用者提供的 pinned context；[projection](../shared/c2-source-capture-projection.ts) 生成 `LOCAL_SOURCE_PLAN_ONLY`／`SOURCE_NOT_VERIFIED`。两者不 import Worker、存储、bridge 或 API。没有来源读取、权限验证、持久请求去重、SHA／receipt、Google文件创建、job／alarm 或 public 输出。

原 JSON 在解析前检查 UTF8 与结构深度，并扫描全部对象的解码后 key；重复 key（包括 `a` 与 `\u0061`）拒绝，不能使用 JSON.parse 的后值覆盖前值。字面字符串及转义后的字符串都拒绝孤立 surrogate；只有有限 JSON 数字、布尔、null、完整 Unicode 字符串、dense数组和普通对象。canonical helper另拒绝 sparse／额外属性数组、cycle、Symbol及accessor。不截断字段，不用业务 safe-integer canonical拒绝合法小数。

已被 JSON 解析的数字使用有限 IEEE754 语义，包括大于安全整数范围的有限值；不声称恢复 JSON 解析前或源系统早已丢失的精度。canonical明确将 `-0` 写为 `0`、排序object keys，metadata记录这个模型；这是typed JSON内容保留，不是原HTTP字节、空白、key顺序、数字词法或转义写法的重现。输入保留 current response完整原字段与答案数组顺序，未知字段不会在投影时被过滤。

提交 cutoff 只取 pinned context 的 `season_ends_at`；raw envelope 不允许携带自行扩大的 cutoff、verified 或 receipt参数。Form first `createTime < cutoff` 才合范围，`lastSubmittedTime` 晚于cutoff仍保留当前答案。观测时间与cutoff分开，当前纯模型只核声明区间有序、结束不早于cutoff及lastSubmittedTime不晚于声明观测结束，不能证明实际读取发生过。

RFC3339秒／纳秒和时区offset按精确整数纳秒比较，原时间文本保留；不先截到毫秒。支持四位公历年份0001..9999、显式 `T`／`Z` 或数值offset、1..9位小数，核真实闰年／日期及归一化UTC范围。闰秒、未知offset `-00:00`、超9位小数、其它未支持文本形式明确拒绝。Sheet日期serial仅保留原number、格式与Spreadsheet timeZone，不转换成UTC或当作首次提交时间。

## 五个 namespace 与来源范围

| namespace | 当前纯模型行为 |
|---|---|
| FORM_CURRENT | 完整已支持Form schema；first createTime合范围且schema／回答shape受支持的当前response，保留全部原JSON字段及顺序 |
| SHEET_CURRENT | 始终为空；本切片没有可信row↔response验证协议 |
| EXCLUDED_IDENTITIES | first createTime晚于／等于固定cutoff的已支持response，仅原身份／首次时间与排除原因；不含完整迟到答案 |
| PRIVATE_PENDING | 完整Sheet schema及**所有**原Sheet行；未知／不支持的Form schema或早期response、仅文件引用的回答亦完整保存在此。不是合规年度source chunks，未来只能流向另审的私有证据目标 |
| GAP_LEDGER | 分别记录SOURCE_GAP、UNSUPPORTED、PROOF_REQUIRED及COVERAGE_LIMIT，不能把证明缺口或历史覆盖限制统计成已发生的删除 |

mapping只接受 `DECLARED_ONLY`、有界row／response／evidence身份且不能重复；通过形状及唯一性校验只说明输入声明成立。Sheet row可以显示基于声明的 `BEFORE_CUTOFF`／`AT_OR_AFTER_CUTOFF` candidate或UNKNOWN，但仍是 `DECLARED_EXTERNAL_EVIDENCE_REQUIRED`，全部留在PRIVATE_PENDING；不进入SHEET_CURRENT、年度合规行计数或verified。即使其关联的Form回答合范围也不升级。缺失关联回答保留独立缺口。pending不是默许把整Sheet dump当合规年度artifact。

known census包括IMPORTED／REVIEW_REQUIRED Form IDs、LEGACY_ROW和无Form映射成员。固定已知ID没有出现在声明的current responses时记录 `KNOWN_RESPONSE_NOT_OBSERVED`，不能解释为已证实删除，也不能把权限／读取失败当空。legacy及unmapped另有gap。无条件的历史不可恢复记录是COVERAGE_LIMIT；无实际page／range读取及可信mapping是PROOF_REQUIRED。此模型没有声称枚举全部曾经提交过的回答。

## 支持与 unsupported 边界

- Form基本schema保留form身份、info、settings、发布状态、items及原可选字段；text／choice／scale／date／time／row问题采用有限字段模型，question／item ID不能重复。已知email／choice／goToAction enum以有限清单核对；新enum整schema转pending。省略的空items／answers、scale.low默认值及空TextAnswer原样保留，不能补原raw字段。
- response保留当前email、totalScore、按questionId的全部textAnswers、多值数组及grade有限score／correct；答案key与questionId不符拒绝，schema没有相应questionId则完整response pending。未知字段、feedback及尚未支持的复杂schema构造完整pending。image／video／grading／rating／file schema、完整grid构造尚未支持，不声称全Forms REST schema覆盖。
- 文件上传保存API原fileId／fileName／mimeType引用，但没有复制文件二进制，记录 `ATTACHMENT_CONTENT_NOT_CAPTURED`，原response pending；不能称附件完整。未知字段出现在迟到response时whole-input拒绝，避免把未知完整字段丢成身份摘要，也不把完整迟到答案混进年度chunks。
- Sheet要求声明完整dense grid：header在row0，headers覆盖全部列，原行1..rowCount−1顺序完整且每行全列；显式空cell `{}`保留。缺行、重排行、重复坐标或缺cell拒绝，不能凭API尾部省略自行补空。未来reader须另证明实际coverage／空值省略协议，本模型声明不能替代读取证据。
- 普通cell保留userEnteredValue／effectiveValue／formattedValue、numberFormat、note和hyperlink；number/string/bool/formula/error各分支明确。[官方ExtendedValue](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/other#ExtendedValue)允许空union代表无data，原 `{}`完整保留；多个value分支拒绝，unknown-only分支或新ErrorType enum标unsupported。unknown style／chip／pivot等构造完整row pending，保留全部raw；公式和公式样式字符串只在JSON文字中，没有执行或Google写入。不声称已证明未来写入的RAW／stringValue安全协议。

畸形必需字段或无法安全分类的结构可whole-input拒绝：只有新unknown union branch而没有一个已识别item／question／answer branch时亦拒绝；已知branch旁新增字段则完整pending。两个已知union分支同时出现不能放过。错误只有固定code与固定message，不含key、答案、expected／actual、私有身份或URL。source_status永远未verified，即便没有SOURCE_GAP，也不能以覆盖限制／证明未完偷换成功语义。

## 有界资源及局限

| 门槛 | 固定值及核验点 |
|---|---|
| 原输入 | ≤2,000,000 UTF8 bytes，解析前；raw nesting≤32（canonical另允许生成control wrappers的有限40层） |
| 输入记录 | Form responses＋Sheet rows＋known census＋mapping声明＋两schema合计≤5000，在逐record处理前；输出五namespace记录总量也独立≤5000 |
| Sheet cells | 声明rowCount×columnCount≤50,000，含header；header必须row0，不支持随意裁剪范围 |
| 单record／字符串 | 原record及包装后的record各≤64,000 bytes，普通字符串上限64,000 bytes、身份字段≤512 bytes；实际整体包装可能更早超限，明确拒绝 |
| chunks | 每namespace从index0／offset0连续拆块；≤100 records／64,000 UTF8 bytes；放不下一个完整record就停止，不能分割字段／截断答案 |
| 总canonical | 不含canonical_text自身的plan core≤2,000,000 UTF8 bytes；没有摘要或持久存储承诺 |

以上是有限原文与生成格式上限，不是stream、heap峰值、总CPU或SQL预算证明。raw JSON、parsed对象、chunks及canonical_text可同时在内存，序列化returned对象还会重复canonical内容；不能将2MB表述为总内存或最终持久存储大小。

## 本地验证

[专项Node测试](c2-source-capture-plan.test.mjs) 当前19项通过，类型检查通过。覆盖独立期望的纳秒−1／=／+1和offset同瞬间、初次早期但当前修改迟到、decoded duplicate keys、真实Unicode／finite小数／raw -0、未知完整保留、文件引用不足、已知缺失与覆盖限制分类、DECLARED_ONLY Sheet不升级、dense row/cell缺口、资源停止及206个Form response的各namespace精确chunk还原。测试直接调用两个真实shared模块；没有运行Google或伪造source receipt。

作者冻结源码最终：专项19/19、docs2/2、完整 `npm test` 283/283、`npm run cf:check`、node --check及diff检查均通过exit0。完整Node是本轮19项加既有264项；既有stage 2全Workers254仍属于其已提交切片证据。完整Cloudflare没有重复运行，因为本切片不导入其runtime；类型检查包含全部shared。

`baseline_checks` 独立专项19＋docs2＝21/21及类型／diff检查通过；`conflict_design_review` 独立专项19/19及类型／diff检查通过。两位均只读审查源码及报告，无未解决P1／P2。初审发现合法空ExtendedValue误拒，修复并加入真实API形状负／正例后才得到最终19项通过；不拿修复前结果充最终证据。两位的专项独审与作者完整Node分别记录，不声称独立完整回归或真实Google试验。

下一步仍是技术前置：可靠Sheet身份及首次时间证据、API／权限核验、完整分页／range和观测一致性、私有不可变staging／原operation恢复、真实source receipt／文件创建。不会仅因本地pure通过而开放来源读取或部署。
