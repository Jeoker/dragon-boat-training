# 当前进度与接续入口

更新：2026-10-07。本轮完成隔离c2test首次schema16发布、发布前后保护与对账、代码审核及本地回归。生产与Google状态仍以各自注明的最近核验日期为准。

## 当前设计

生产仍运行 GitHub Pages＋Apps Script／Sheets。目标采用 Cloudflare 业务 Worker／TeamState SQLite，独立私有 Worker／DO 保存完整来源、checkpoint 和只追加审核；Google Form 为入队入口，Sheets 为异步运营副本与私有归档。Node CLI 仅用于本地验收和运维。架构和同步规则见[迁移计划](cloudflare-migration-plan.md)，来源托管见[私有服务设计](cloudflare/PRIVATE-SOURCE-HOST-DESIGN.md)。

## 当前基线

| 范围 | 当前结果 | 验证边界 |
|---|---|---|
| 生产网页 | 最近记录的 10-03 Pages 三页、登录后受保护读取与退出通过；当时发布提交为 0711c677bdba546a5c7dba03735f30dab83683c6 | 本次未刷新远端 main／Pages 状态，未执行生产写入或 Cloudflare 切换 |
| 业务源码 | schema16，保护备份51表；赛季、排期、报名、排座、冻结历史、同步、年度持久计划及来源权威 pin 已实现 | 本轮完整本地回归通过；私有和恢复源码不表示对应服务已部署 |
| 隔离 c2test | 10-07首次发布完成，0.17.0-c2-associated-lanes／schema16，generation cf-c2-isolated-1、writer epoch0；队列核验通过 | 生产未切换，未调用Google、执行云端restore或轮换Code |
| 发布保护与对账 | 发布前47表2461行原包离线核验及真实SQLite演练通过；发布后51表2464行，原行保持、新4表为空，仅原快照自身3条运行记录追加 | 原namespace与六项secret名称保留，cron／polling关闭，原会话跨升级有效且最终退出／401回查通过；不是并发业务冻结协议 |
| 私有来源 | 两遍完整读取、候选、checkpoint、journal 恢复、当前 Coach／pin 鉴权及只追加审核已实现 | 10-03 真实 Google 隔离读取使用测试 actor／cutoff／census，不能当作业务服务器 capture |
| 私有云运行层 | 独立 SQLite CAS、双向命名 Service Binding、OAuth、capture／capture-native、journal、审核及独立 backup 已本地验收 | Google 为模型；未部署，真实云授权、Free 资源和审核页面未验收 |
| 备份与封存恢复 | 原47／当前51表包、独立私有快照及 RecoveryRuntime／RecoveryState 已本地验证 | 不复活旧 sessions，不提供在线激活；云端恢复待验收 |
| 原生 Tab 证明 | 签名原生观察及新 capture-native 的首 checkpoint／v2 候选已实现 | 真实 Google 观察和业务 capture 待验；普通 capture 及已有候选不追溯提升 |
| Coach 自轮换 | self-only、HMAC 指纹、凭据 census／version CAS、撤销全部旧 sessions、receipt 及私有 CLI 已实现；远端只读prepare通过，当前credential_version=2保持 | 本轮未执行真实自轮换；生产 Apps Script 凭据另处理 |
| 来源与年度资格 | SOURCE_NOT_VERIFIED、原 Sheet 行 PRIVATE_PENDING、annual_export_authorized=false | 原生单点关系、两遍一致、journal 回读及 HUMAN_ATTESTED 均不自动消除来源缺口 |

完整证据、所测日期和具体未验证范围只在[验证索引](tests/CURRENT-VERIFICATION.md)维护。文档直接更新当前结论；运行数据、缓存及凭据遵守项目忽略与私有路径规则。

## 下一轮执行顺序

| 顺序 | 下一项 | 完成门槛 |
|---|---|---|
| 1 | 重新核验当前Coach并刷新51表保护包，再实际 Cloudflare Coach 自轮换 | 包匹配当前 schema／Coach version，独立可信摘要，新 Code 登录及全部旧 sessions 拒绝 |
| 2 | 独立 Recovery Worker 接线与云端封存恢复 | 固定 target／digest／身份和当前权威回调，新空 namespace，事务回读、逐表对账及公网拒绝 |
| 3 | Google 管理配置及私有 Worker／SourceRuntime 隔离发布 | 真实 OAuth／owner 权限、原生观察与业务 capture、journal／checkpoint／审核故障恢复、Free 资源 |
| 4 | 审核页面、来源资格与年度输出 | 其他 Coach 委派独立鉴权；完整性／资格逐项满足，年度文件、未知创建、receipt 及回读有独立证据 |
| 5 | C3 双端联调与 C4 唯一写入权交接 | 影子导入、完整对账、旧端点拒绝误写及保留新数据的回退；设备、管理员交接和观察期通过 |

实际配置和依赖顺序只维护于[隔离恢复指南](cloudflare/ISOLATED-RECOVERY.md#隔离发布顺序)。

## 现存技术债与未完成范围

- 生产 Apps Script 的归档读取／重试不等于不可变完整来源协议；C4 必须保留数据、凭据、请求恢复和审计后关闭旧写入。
- 生产年度文件创建后、映射保存前若被平台硬终止，仍可能留下孤立私有文件；现行实现只认核验通过的映射。Cloudflare 的未知创建恢复协议尚未完成，不能沿用这项残余风险作为验收通过。
- 未完成导出批次阻止绑定提升；旧绑定清障仍缺经 Google 核验的操作。不能删除批次、猜测 Google 未写入或用当前值重算旧目标。
- 私有备份受完整对象大小／条数限制，大对象分页备份缺失；封存恢复没有在线激活 handoff。范围和资源预算见[恢复指南](cloudflare/ISOLATED-RECOVERY.md)。
- 凭据历史债未解决。Cloudflare 自轮换、生产 Apps Script Code、服务 secrets 和 Git 历史须分别处理；普通提交不能证明凭据已经清理。
- 真实业务 census、Google 授权／原生观察、逐块恢复、其他 Coach 委派、审核 UI、来源资格及年度 receipt 尚未全部验收。已知清单不证明完整历史，两遍一致不是原子快照，人工映射不修复未知缺失。
- C2.5 仍缺远端 SENT 并发暂停、受控网络／配额、cron、云端 restore 及更广实体隔离；物理诊断无定期巡检或自动修复。
- Free 账户共享用量、最大真实数据及单次 CPU／连接／存储仍须实测。OAuth 长期授权与撤销由 Google 管理者核实，不自动购买套餐。
- 非空历史、多页 Coach 审计、连续排座实际操作、首个自然结束赛季年度文件、Safari／实体手机及两平台交接仍需实证。

## 数据与操作边界

最近 10-03 的生产只读记录展示 P1 Acceptance2026 的22名虚构成员和三场已结束训练。写入前重新读取当前状态；正式运营另建真实赛季与 Form／Spreadsheet，不删除审计或改变时间来制造通过结果。

完整私有来源与凭据不进入公开页面、普通业务备份或日志。c2test 夹具存于项目内 Git 忽略的 `.c2-form-test/`；OAuth、私有 host 和保护备份文件继续使用工具要求的仓库外私有路径，均不散落到 dev-master 根目录。
