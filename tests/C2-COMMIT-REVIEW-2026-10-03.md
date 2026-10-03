# C1／C2 开发积累与私有来源审核提交前 review

日期：2026-10-03。用户授权先review、分批commit并提交GitHub。公开仓库的远端main经fetch确认仍为`94959581028b1b08c49bcab04adb6546dbda7fff`；原本地HEAD为`ec71d2e`，已有76个未推送提交。工作区另有36个已修改文件、40个未跟踪文件，随后新增本文。采用开发分支`codex/c1-c2-private-source-review-2026-10-03`，保留原76个提交，不重写或丢弃历史。

## 审查范围与结论

本轮由当前agent进行最终review，没有新增独立agent审查。检查原76个提交的模块／依赖顺序、相对远端的变更范围及验收档案；对当前改动和高风险接线做定向源码审查，并运行最终全量回归。原报告的双审及真实隔离证据属于各自切片，本轮未重新操作真实Google或业务部署。

| 范围 | 检查重点 |
|---|---|
| C1业务、C2导出和运维积累 | 路由gate、生产拒绝、当前签名会话、不可变事件和原请求恢复、暂停与持久重试。原staging与c2test配置分开，生产和c2test自动同步关闭；全部SQLite／Workers回归覆盖既有模块 |
| 前端及管理入口 | 旧会话回复、名册读取序号、重新登录／退出竞态；名单版本、有效期和服务器时间限制新提交，结果未知恢复原操作。日历日期共用UTC展示，删除未引用字体／变量 |
| 来源与私有CAS | 固定上下文、两pass、完整分页／range、未知read-start、候选／receipt摘要、原目标恢复及文件CAS。未知请求不得重取或换attempt绕过；已有真实读取和checkpoint报告保留原范围 |
| 来源权威及审核 | 服务器actor／cutoff／binding／census、撤销会话、不可替换目标、实际Google调用前后权威检查、原journal ACL／内容、审核链、CAS竞争和旧请求原prefix；人工确认不升级来源或年度资格 |
| 发布及文档 | Pages只在push main或手动触发时部署。schema16／backup51仅本地，远端schema14证据保持分开；审核正文和OAuth不进入Git、公开Worker或备份 |

发现并修复两项隐私问题：

1. 私有模块直接转抛依赖提供的`SourceJournalError`，可带篡改message、额外raw或code getter。新增固定诊断白名单与descriptor检查，重建固定错误；未知code和敌意Proxy使用固定fallback。覆盖Google token／fetch、候选store、checkpoint、reader和journal。新增[3项反例回归](c2-source-diagnostics.test.mjs)，既有诊断与恢复继续通过。
2. OAuth路径只检查词法仓库外范围，未解析Windows junction／别名。读取／授权前核实际parent与现有文件，并验证client／token真实路径不冲突；保存前再次检查。新增[实际junction反例](c2-source-oauth.test.mjs)，拒绝仓库目标且零文件写入、零网络调用，正常私有目录仍可保存虚构grant。该检查不承诺对恶意并发替换私有目录提供操作系统级原子性。

本轮审查与回归未发现其他需要阻断开发分支提交的问题。长期host、审核UI／其他Coach委派、可信Tab、实际服务器capture、全部逐块故障及年度receipt仍按[当前进度](../CURRENT-STATUS.md)独立验收，本次提交不代表C2全部完成。

## GitHub候选内容检查

扫描913个未推送历史文本blob和当前Git候选文本文件，检查OAuth／GitHub token／私钥模式，并与现有环境两项私有值精确比较，未发现匹配。扫描只输出文件／blob定位和种类，未输出私有值。OAuth、私有回答和恢复进度仍在仓库外；`.dev.vars`、clasp配置、构建、缓存和私有验收目录不加入提交。

早期夹具复用实际Coach Code的已知历史限制仍保留。本次未推送历史的backend默认Code与已公开main均为同一虚构值，本轮没有新增该字面值的公开范围；下次管理后端部署前的原Code轮换要求不变，普通提交不代表历史清理完成。

## 最终验证

- 完整Node **492／492**，无失败／跳过，包含新增错误清洗3项和OAuth路径1项。
- Workers **24文件276／276**，覆盖C1／C2、迁移、恢复、实际本地HTTP及SQLite会话撤销。
- `npm run source:check`与`npm run cf:check`通过。
- Astro **146文件，0 error／0 warning／0 hint**；首页、Coach Mode、过往赛季三页构建通过。
- backend、bridge probe和Worker dry-run通过，均为本地打包。
- 文档npm命令／本地链接、最终diff与拟提交路径检查通过。

## 分批提交方式

1. 前端会话／名册竞态、缓存有效期、日历日期、样式清理及对应测试／规格。
2. 私有来源读取／checkpoint／journal／CAS、OAuth、服务器权威／HTTP／目标登记／runtime、人工审核和上述隐私修复，包含全部代码依赖及测试，保持该批代码／测试可运行。
3. 项目入口、状态、迁移计划与文档，以及本地和既有真实验收记录。

开发分支推送并以GitHub PR交付，不直接push或合并main，不执行Pages、Cloudflare或Google部署。GitHub代码交付与服务上线分别验证。
