# C2.6 原 plan core 完整验证 - 本地验收

日期：2026-10-01。本切片依照[已审设计](C2-SOURCE-PLAN-VALIDATION-DESIGN.md)实施。原 source pure 为 `8fed6a9`，人工审核纯模型为 `705cc9d`；其 canonical 格式、namespace、条件及现有 `LOCAL_INPUT` 审核入口不变。本地仍 schema15／backup50表，实际远端仍0.17／schema14／47表；本切片没有部署或远端操作。

## 实现和边界

[验证 contract](../shared/c2-source-plan-validation-contract.ts)及[验证 projection](../shared/c2-source-plan-validation-projection.ts)提供 `validateLocalSourcePlanCore(originalCoreText, contextPort, hashPort)`。它读取完整原 canonical core，重新验证 retained 内容及全部 chunks，不接收、重建或调用原 source input builder。结果恒 `LOCAL_PLAN_VALIDATION_ONLY`／`SOURCE_NOT_VERIFIED`，`annual_export_authorized=false`。

结构语义、原摘要完整性、实际来源真实性分别处理：typed 内容和条件重算不能替代独立原摘要；注入 SHA-256 与 context 指定原摘要相同，只证明所给原文本完整性。当前 context 仍是内部本地声明，不能证明来源已经 fixed、调用者已认证、Google 内容真实或权限正确。没有 HTTP、认证、来源读取、bridge、文件创建、SQL、storage、alarm、public 或 Worker 接线，也没有 receipt、持久 CAS、跨重启恢复或并发持久赢家。

现有人工审核函数继续依原 input＋plan 完整重建，不在本轮偷偷切换入口。未来私有人审 plan-only adapter 需另审，不能把本模块成功当作已实现原 artifact 读取或审核入口适配。

## 全内容验证

完整 canonical core、metadata 和每个 payload 先核 UTF8、解码后 duplicate keys、有限数值及深度，再核 format、固定 namespace 顺序、chunk index／offset／count／bytes、完整 records 和 greedy 切块。metadata 可以合法超过64KB，受整个 core 的2,000,000-byte预算约束；单 chunk 仍≤64,000 bytes／100 records。

固定 record 布局按旧 producer 验证：`FORM_CURRENT` 为 supported Form schema 后接其 current responses；`PRIVATE_PENDING` 为可选 unsupported Form schema、唯一 Sheet schema、pending Form responses、完整 Sheet rows；`EXCLUDED_IDENTITIES` 仅身份，`GAP_LEDGER` 仅原条件，`SHEET_CURRENT` 恒空。不能用自洽重算 counts、切块和新 SHA 绕过 schema 后置、类型交错、理由改变或条件漂白。

[共享 typed 校验](../shared/c2-source-capture-contract.ts)及[共享记录 emitter](../shared/c2-source-capture-records.ts)从完整 raw 复算 supported／unsupported、完整 wrapper、已知 census、declared mapping 和条件原顺序。current／pending Form response 的原输入交错不再重建，但各 namespace 原相对顺序和 pending 条件顺序可验证；late identity 顺序、census 原序及 Sheet 行上的 declared mapping 都保留。缺少、重复或 scope 不符的响应身份拒绝。

cutoff 始终来自 pinned `season_ends_at`，按原 RFC3339 文本比较纳秒及 offset：retained Form createTime 必须严格早于 cutoff，excluded createTime 必须等于或晚于 cutoff。晚于 cutoff 的 current 修改不等于迟到首次提交。EXCLUDED 不补 answers、lastSubmittedTime 或 raw body，也不伪造一次旧 input 来重算。

`metadata.input_bytes` 只能是原 producer 的有限声明，完整原 SHA 锁定该声明；没有原 input 时不能重现其字节数、被排除正文、HTTP 数字词法、历史瞬间值或已删除而未保存的答案。canonical 数值仍为已解析 IEEE754，原历史精度损失不能恢复。

原 raw scanner 保持深度32；内部生成 wrapper 仅固定深度40。retained raw 放回其固定原父路径进行深度核验，例如 `form_responses:[raw]`，不能只给 raw 本体一个较宽上限。已排除且未保存的 raw 深度不再证明。

条件完整集合保留 SOURCE_GAP、UNSUPPORTED、PROOF_REQUIRED、COVERAGE_LIMIT。条件总数不能称已发生删除或缺失的数量；mapping 声明及历史覆盖限制不因完整校验通过而消失。所有 Sheet 原行继续 PRIVATE_PENDING，没有年度合格 Sheet chunks 或自动 HUMAN_ATTESTED。

## 原锚、私有输出和错误

有限 context 严格复制 source／format／原摘要，拒额外字段、accessor、null 及 getter／Proxy 私有异常。SHA 端口核完整原 core 的既有 domain 文本；最后一次 await 后再次获取 context，原绑定代次、epoch、source、format 或摘要变化拒绝。依赖任意抛错统一固定 code／message，不输出私有 expected／actual、原答案或依赖错误正文。

可序列化结果仅有有界 control 及 private collection；完整 metadata／known census 和每条完整原 wrapper 连同定位只在 private collection 中。schema 按原 collection 各一份，不同时再输出整个 core_text 或整份 raw 集合副本。control≤8,000 UTF8 bytes，完整结果≤2,000,000 bytes；失败整次拒绝，不裁行或返回部分成功。private 输出预算在 SHA 调用之前验证。

预算不是 streaming、heap、CPU 或 SQL 上界。解析、旧／新 canonical 字符串、原记录与定位对象仍可共存；本地全部集合核验成本随内容增长，没有数据库加载或持久资源证据。

## 独立旧 oracle 和实际测试

[开发用 golden 生成器](generate-c2-source-plan-goldens.mjs)先从 `8fed6a9` 独立旧 Git tree 加载原两模块，生成[固定 fixture](fixtures/c2-source-plan-v1/goldens.json)中的六组完整 canonical text、metadata／各 chunk SHA 与旧源文件 SHA。fixture 均为虚构 TEST_ORACLE；不是实际来源 artifact，不为生产归档保存迟到正文。测试运行只读固定 fixture，不依赖浅克隆中存在旧 Git object，也不使用当前 helper 自比。

六组覆盖纳秒／offset／late／census／mapping、完整未知字段与附件、原 current／pending 交错、多个 Sheet chunks、REST 默认省略、原父路径32边界。当前 producer 与旧 oracle 的 core、metadata、每个 chunk 逐字一致。另一agent还在开发阶段独立加载旧 tree 复核全部六组，并用 `705cc9d` 旧人工审核完整依赖生成六组固定 prepare-view 摘要，证明本轮共享抽取没有改变旧审核 view。

[作者专项](c2-source-plan-validation.test.mjs)9项覆盖旧 oracle、全部 retained 定位、excluded 不造正文、input_bytes 声明界限、合法>64KB metadata、raw-parent32／33与 generated40／41、重锚后布局和条件拒绝、真实 SHA await 漂移以及固定错误。最后 census guard 先检查5000条上限再处理元素，5001个 null 的负例证明先报告数量超限。

[独立对抗专项](c2-source-plan-validation-adversarial.test.mjs)由 `baseline_checks` 独立编写15项，不依赖作者 fixture 构造 helper。覆盖自洽 forged core 的完整类型／schema／理由／条件／layout／counts、原独立 SHA、late 身份、父路径深度、fresh context 和隐私。其输出负例使用合法 source input 与 core 均≤2MB的4900个 excluded identities，完整定位展开后真实结果>2MB，整次报 `PLAN_PRIVATE_OUTPUT_EXCEEDED` 且 SHA 调用数0；不是向入口传超长垃圾字符串。

## 验证状态

冻结源码作者专项9/9 exit0。`baseline_checks` 已独立运行其冻结15/15、类型、nodecheck及diffcheck并完成源码审，最后 census guard 顺序微调也已只读复核PASS。`conflict_design_review` 独立运行新作者9＋对抗15＋旧source19＋旧human30，共73/73，类型及diffcheck通过，并从旧 Git tree 独立核六组 source 完整字节／源 SHA 和六组 human view SHA。两位源码终审PASS，无未解 P1／P2；73项是其定向组，不称完整Node全量。

冻结源码作者完整 `npm test` **337/337，exit0**（既有313＋作者9＋独立15），`npm run cf:check` exit0。两专项及开发生成器的 node --check、最终docs2和diffcheck通过；新增文件另外检查无行尾空白。完整337是作者本轮全量，不称两位reviewer独立全量。报告最终措辞另交两位只读签核。

本轮没有重跑 Workers 全量；历史254属于既有 schema15 持久计划切片，不能当本模块的新验收证据。runtime引用搜索无新增validator／records引用；已修改的shared source producer仍保留原既有纯模型用途，没有增加运行时入口。
