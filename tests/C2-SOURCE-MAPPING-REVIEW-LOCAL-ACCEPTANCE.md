# C2.6 Coach 人工来源审核纯模型 - 本地验收

> 历史范围说明：本文保留人工映射模型切片的验收数字。其后 plan-only 私有人审入口已完成本地实现，见 C2-SOURCE-PLAN-REVIEW-ADAPTER-LOCAL-ACCEPTANCE.md；仍无真实认证或持久审核。 最新状态见[CURRENT-STATUS](../CURRENT-STATUS.md)。

日期：2026-10-01。用户已接受 HUMAN_ATTESTED 人工关联政策，supervisor在[已审设计](C2-SOURCE-MAPPING-REVIEW-DESIGN.md)后授权此本地纯模型切片。已有 source pure 为 `8fed6a9`，业务持久计划为 `13e8fc0`；本切片不改变其格式或行为。本地仍schema15／backup50表，远端已验收基线仍0.17／schema14／47表，没有部署或远端操作。

## 实际实现范围

- [contract](../shared/c2-source-mapping-review-contract.ts) 定义固定 command、server context声明、LOCAL_INPUT锚、append-only ledger、reason enum、预算及安全依赖端口。
- [projection](../shared/c2-source-mapping-review-projection.ts) 提供 `prepareLocalMappingReview` 私有完整view及 `planLocalMappingReview` ledger／evidence／独立derived控制计划。
- [作者专项](c2-source-mapping-review.test.mjs) 使用真实现有SHA-256 helper并用独立Node SHA向量核对；[独立对抗专项](c2-source-mapping-review-adversarial.test.mjs)由另一agent独立构造fictional输入和期望，不导入作者测试状态。

结果恒 LOCAL_REVIEW_PLAN_ONLY／SOURCE_NOT_VERIFIED。没有实际Coach认证、session、权限receipt、source fixed、Google来源读取／文件创建／写入、HTTP／public／Worker／alarm入口、SQL表或持久review服务。shared模块只依赖现有纯source模块，SHA能力由内部端口注入，不 import Worker运行时。不能把调用者context中的permission_scope字面值当已认证证据，也不能把通过本地模型称整体source verified。

## 完整内容和本地来源锚

原source input和plan core分别在解析前核UTF8／depth／解码后duplicate keys；用原pinned context重建整个 source plan，要求全部core canonical text逐字相同。未选中chunk、原gap、counts、offset、namespace、schema和任一原record均在锚内，不只核选中两行。

再以真实SHA-256核独立server context给定的source plan摘要和LOCAL_INPUT snapshot。此context目前是内部本地声明，没有认证或Googleprovenance。完整raw／schema的摘要使用独立domain、固定身份／locator和typed canonical UTF8，保留finite IEEE754、小数／Unicode及未知完整内容，不声称原HTTP数字词法或字节重现。

私有view中完整Form／Sheet schema各仅top-level一份，每候选引用schema digest，保留自己的完整raw及chunk／offset定位。view实际canonical≤2,000,000 UTF8 bytes，单候选包装≤64,000 bytes；超额整个view失败，不先返回部分候选。输入／plan预算不替代view输出预算。unsupported Sheet schema传播到其所有候选，人工关联后派生仍标 UNSUPPORTED_CONTENT_REMAINS。

只允许选择原plan中确有完整raw的Form response及完整Sheet row。EXCLUDED_IDENTITIES仅有迟到身份，返回 FULL_RESPONSE_NOT_AVAILABLE_FOR_REVIEW 条件，不能造完整Form hash、空答案或“已查看”证明。不存在原response／row亦不能生成审核证据。现有原sourceplan继续所有Sheet仅PRIVATE_PENDING、SHEET_CURRENT恒空。

原input和plan均未通过此切片实际持久保存或Google固定capture。未来真实artifact可能没有原整input，必须另审plan-core-only完整验证／私有读取adapter；不能为重建长期保留已经排除的迟到完整答案，也不能重新读取活来源冒充旧snapshot。完整私有view目前只在本地内存存在，无raw传入DO或公共输出路径。

## 审核、幂等和派生边界

command只含明确row↔responseID、双方expected完整hash、request、snapshot、CONFIRM_LINK及有限reason。actor、范围、binding／generation／epoch、cutoff和首次reviewed_at来自独立context；客户端伪造actor／cutoff／why／verified字段拒绝。理由只记录依据类别，不能证明人工声明客观正确；名字／时间／位置不自动配对。

原ledger先核独立权威version／digest，再完整核字段、scope、连续sequence、每条command digest、前缀ledger链、定位、双方原内容hash及row／response的一对一规则。新决定仅append，原evidence canonical bytes不变。新ID重复或矛盾关联拒绝，不做覆盖、alias追加、撤销或supersession。

原请求exact重放返回原evidence、actor、reviewed_at和原sequence截至的derived prefix，后来追加的审核不进入旧请求结果；当前ledger仍原样返回且append_required=false。同ID改变参数拒绝。旧ledger时间只核合法timestamp，可信原ledger锚固定时间；本请求首reviewed_at不是后来旧记录的时间上界，本模型不证明wallclock真实性或合理性。未来认证／持久审核服务须负责server clock与审计权威。

derived独立引用source／ledger／双方完整hash和定位，用原Form createTime与pinned season_ends_at作精确纳秒比较，当前修改可晚于cutoff，Sheet Timestamp不替代首次时间。mapping_status可为HUMAN_ATTESTED，但source仍NOT_VERIFIED、annual_export_authorized=false。原raw manifest／chunks／gap不修改，不追加迟到回答，不让unsupported、附件、known missing或历史不可恢复条件消失。

`source_evidence_condition_count/digest` 覆盖整个原GAP_LEDGER，包含SOURCE_GAP、UNSUPPORTED、PROOF_REQUIRED、COVERAGE_LIMIT；不是“已发生缺失”的总数。原分类保持。派生对象只表达映射候选与其他核验待办，不自动生成年度合规chunks、公开数据或永久receipt。

## 异步权威和资源证据

有限字段context复制拒extra/accessor，每份≤8KB；bundle也拒null／getter／Proxy异常和extra字段，不canonical整份2MB＋2MB bundle为小控制输入。getter及hash port抛出的任意private body统一固定code/message。命令、ledger、source错误同样不含raw答案／私有expectedactual。

原字符串先固定再await，候选对象来自全plan重建。源摘要／候选计算后和最终derived／next-ledger摘要完成后均重新取当前context，检查actor／范围、绑定代次及source／ledger锚；真实可控await barrier覆盖最初和最后的漂移窗口。

prior／new ledger各≤512,000 UTF8 bytes、evidence≤1000，单证据≤8KB；derived≤512,000 bytes，原source沿5000 records／50,000 cells限制。完整链与集合核验不分页略过旧决定。局部对象预算并不等于整体heap或CPU：raw、plan、view、ledger、derived及canonical可共存，链复核／前缀摘要成本随evidence数量增长，不能称stream、固定总内存或持久storage证明。

并发两个本地调用可都生成相同base的不同proposal；输出expected_ledger_version/digest仅为未来真实事务CAS前置，不宣称已选出一个持久赢家。输入／预算／权威／内容任一失败不返回部分append或derived成功。没有实际数据库回滚、跨重启恢复或真实Google故障试验；这些不属于pure测试证据。

## 验证状态

冻结源码最终作者验证：专项16项及独立对抗14项在完整 `npm test` 中全部通过，完整Node **313/313，exit0**（既有283＋本切片16＋独立14）；`npm run cf:check` exit0，两test node --check、docs2及diffcheck通过。runtime／bridge／contracts中的mapping-review模块引用搜索无命中；没有为此重新运行完整Workers，历史254属于`13e8fc0`切片，不能当本轮新测试证据。

`waitlist_acceptance` 已独立运行其14项对抗和作者16项，两组共30/30，同冻结源码均exit0；类型、nodecheck、diffcheck通过。其首轮曾出现原T1重放失败和一个fixture数组选取错误，已分别修实现与独立fixture，之后才得到冻结组通过。`conflict_design_review` 也独立运行冻结两组30/30、类型及diffcheck，均exit0；两位最终源码／DESIGN／报告独审PASS，无未解P1／P2。完整313是作者全量，不称两人独立全量、真实Google验收或持久认证证据。

两项真实构造的输出预算负例：合法source input及core均≤2MB、records≤5000，但展开完整private view后>2MB，整个prepare失败；独立真SHA构造合法canonical旧ledger并先实际重放通过，再append超过512KB，整个结果失败。不是仅向入口传一个超长字符串。schema200个候选仍只保存一次、跨多个Sheet chunks的未选中内容完整锚核验也实际通过。

初审具体发现已修：bundle异常泄露风险、Sheet schema unsupported未向候选传播、旧A时间作为后来B ledger上界阻断原request重放。旧请求A(T1)→B(T2)后以原A context time重放仍保原prefix的有效回归已加入；修补前未把失败称最终通过。

后续实际fixed source capture／API／私有ACL／完整读取／receipt、Coach UI和认证、持久append/CAS／原请求恢复、年度Spreadsheet创建与公开verified仍分别待授权和验收，不因本地模型通过而接线。
