# C2.6 完整原 plan 私有人审 adapter - 本地验收

日期：2026-10-01。本切片按[已审设计](C2-SOURCE-PLAN-REVIEW-ADAPTER-DESIGN.md)实施。原完整 plan validator 的337项本地验收见[前一切片](C2-SOURCE-PLAN-VALIDATION-LOCAL-ACCEPTANCE.md)。本轮没有部署、远端或业务写入；本地 schema15／backup50与实际0.17／schema14／47表的边界保持。

## 实现和权限边界

[新 adapter](../shared/c2-source-plan-review-adapter.ts)提供 `prepareLocalMappingReviewFromPlan` 与 `planLocalMappingReviewFromPlan`。正文只有完整原 core text；内部每次调用完整 validator，不接受 caller 的 validated object、proof flag、selected chunks 或私有 view。它不要求原 input，不补晚提交的 answers 或 lastSubmittedTime。

新结果只有外 wrapper `validation_mode=RETAINED_PLAN_ONLY` 与 `result`。内层沿原格式 LOCAL_REVIEW_PLAN_ONLY／SOURCE_NOT_VERIFIED，没有 authenticated、fixed capture、receipt 或年度导出许可。原锚的 LOCAL_INPUT 名称仍是兼容的本地声明格式，不表示本次重读原 input 或取得真实 snapshot。原 gap、coverage、unsupported／附件条件和 Sheet 全 pending 保留，HUMAN_ATTESTED 不等于客观身份恢复。

没有 Worker／HTTP／公开入口、auth、UI、bridge、Google、IO、schema、SQL或storage接线；纯端口只接收内部调用方声明，不能验证实际 Coach 身份或来源真实。没有持久 request、CAS、跨重启恢复或并发持久赢家。

## 完整 context 与固定时间

进入新 API 首先复制完整 ReviewContext。每次 validator 读取其 source context 之前，adapter 重新读取并复验完整审核 identity，再投影 source／format／原摘要。actor、permission、source scope、sourceop、binding/generation/epoch、source digest／snapshot、ledger version／digest的变化都拒绝；不能只有三个 source 字段相等就忽略审核权威变化。

validator 的原 core SHA await 后、全部 view schema/record/gap SHA await 后、plan最终 next-ledger SHA await 后以及新 wrapper返回前均执行完整审核 fence。依赖 getter／Proxy／任意 hash error保留固定受控 code/message，不返回错误正文、raw或expected/actual。

时间复用原 contextIdentity：fresh合法clock可推进，但不改变首次捕获的本次 reviewed_at；旧请求重放取原 evidence 时间与原 prefix。A(T1)之后B(T2)追加，A以T1和当前权威ledger重放仍不追加，返回A原证据和原derived版本。纯接口不证明真实wallclock；未来真实权限／持久服务另核server时间。

## 内部抽取与旧字节

[旧 projection](../shared/c2-source-mapping-review-projection.ts)保留两个原 LOCAL_INPUT API 的参数和返回格式，仍用原 input重建complete plan exact及原摘要。共同view/ledger逻辑移到[内部 helper](../shared/c2-source-mapping-review-internal.ts)，仅供已完整验证的内部记录使用，不是接受客户端证明的服务接口。

Schema在view各保留一次，候选只引用schema_digest；完整raw、unknown字段、缺省、有限IEEE754、纳秒文本与unsupported传播不裁剪。locator保留namespace／原chunk_index／namespace内原row_offset+index，并从已验证wrapper补现有record_type。未选中chunks不能被过滤后重新编号。

mode不进入anchor、content/schema/command/ledger/gap SHA域或证据／derived文本；相同原core与权威上下文，两条入口的内层view／plan bytes相同。原ledger可双向使用，没有迁移、替换或新mapping资格版本。late identity没有fullFormhash或人工审核资格。

## 独立旧 oracle

实施第一步先运行[开发生成器](generate-c2-source-plan-review-goldens.mjs)，直接从提交 `705cc9d` 加载旧review projection、contract与全部source依赖，记录完整commit及各source SHA。生成[固定虚构fixture](fixtures/c2-source-plan-review-v1/goldens.json)的六个完整view text和十五个完整plan result text，以及各view／result／evidence／derived摘要。

十五个plan覆盖首次append、第二次append及后来ledger上的原A(T1)重放。测试直接比较固定完整text及真实SHA，不仅比较同一新helper的两条入口；CI运行不依赖旧Git对象。fixture均为虚构TEST_ORACLE，原input中的late正文只用于兼容测试，不是实际来源存储策略。

## 预算与失败

原core及完整validator private输出保持前一切片的2MB预算和完整raw父路径／chunk／record门槛。view每schema一次、候选≤64KB，整个新wrapper实际canonical UTF8≤2,000,000；只核旧inner大小不足。plan的ledger和derived各≤512,000、单evidence/context≤8,000、≤1000证据，整个新planwrapper另外≤2,000,000。

失败整体拒绝，不返回partial view／ledger或推进状态；这是纯返回原子性，不是持久事务。预算不证明固定heap、CPU或streaming；validator完整对象、view、预期集合与canonical text可能共存，成本随完整records及ledger增长。

## 验证状态

[作者专项](c2-source-plan-review-adapter.test.mjs)已8/8通过，包含旧完整oracle、两新入口内层exact、callerproof拒绝、core SHA中的完整context、freshclock首time、append与replay最终hash fence、late／unsupported／gap、固定错误。首次抽取的unused type检查失败已修正；作者final-hash测试首跑误把replay的第三次同ledger摘要计为第二次，修正fixture计数后8/8，未改变源码语义。

冻结源码作者唯一完整 `npm test` **357/357，exit0**（既有337＋作者8＋独立12）。它包含既有source19、人审30、validator24的回归，不将当前两入口同helper自比当旧字节证据。作者最终 `npm run cf:check`、docs2、两专项及开发生成器的nodecheck、diffcheck均通过；runtime搜索确认新adapter/internal未引入cloudflare/src、backend、frontend或src。

[独立对抗](c2-source-plan-review-adapter-adversarial.test.mjs)由waitlist唯一编写，实际12/12、types/nodecheck/diff通过；另直接加载705cc9d旧Git tree的全部四个依赖，独立核source SHA及六view／十五plan完整canonical exact。其合法wrapper负例原input/core和validator均通过，旧inner view实际1,999,999 bytes，新wrapper>2MB后整拒，4004次真实SHA（原core、两schema、4000record及gap）全部完成，证明不是validator或旧inner提前挡。另以合法权威ledger真实重放后下一append超512KB，整体拒绝，不返回部分新证据。

waitlist源码／DESIGN／LOCAL最终签核PASS，无未解P1/P2。conflict独立运行新作者8＋独立12＋旧human30／validator24／source19，共**93/93**，types/docs2/nodechecks/diff均exit0；另直接从705cc9d完整四个旧依赖核source SHA及六view／十五plan／evidence／derived完整text与摘要。其源码／DESIGN／LOCAL终审PASS，无未解P1/P2；93是其定向回归，不称独立完整357。

本轮没有重跑Workers全集；历史254属于既有schema15持久计划切片，不是新adapter验收。新helper／adapter不增加runtime入口，纯模块通过不等于真实capture或Source verified。
