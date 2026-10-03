# C2.6 来源 OAuth、真实私有 journal 与持久恢复验收

日期：2026-10-03。用户完成独立 OAuth 后，按既定计划继续隔离来源验收和持久操作开发。本报告替代“新客户端等待授权”的接续状态；[此前本地验收](C2-SOURCE-JOURNAL-LOCAL-ACCEPTANCE.md)继续作为历史证据。

## 授权和隔离身份

独立 desktop 客户端所属项目为 `dragon-boat-source-test`。实际 token audience与client匹配，四项scope完整，refresh token已保存到用户指定的仓库外环境目录。Forms／Sheets对固定不存在ID均返回404，Drive about返回200；不是旧clasp的 `SERVICE_DISABLED`。

后续只读登记在既有C2 fixture配置中的Form／runtime Spreadsheet／数字response Tab。实际Form linkedSheetId、Spreadsheet ID、response Tab ID／标题一致，Spreadsheet标题仍为隔离Response Test。Form的info实际只返回documentTitle，未返回title；不能用空title误判绑定失败，更不能用documentTitle替换原schema里的缺失字段。

凭据、API身份、来源ID、core原文和私有journal定位不进入报告／普通日志／Git。测试完整pin、候选原文、目标定位和回执保存在 `D:\agents\env\dragon-boat\source-journal-acceptance-2026-10-03`；该路径不属于项目仓库。原clasp默认账号及Apps Script项目配置未改变。

## 真实读取与写入

既有测试赛季截止于2027年，尚未结束；本轮明确使用 `TEST_ONLY_NOT_REGISTERED_SEASON_END` 的独立验收cutoff和 `ISOLATED_ACCEPTANCE_RUNNER_ONLY` 权威声明。known census为空测试声明，不是业务服务器的完整历史集合。结果不能用于该赛季的真实年度归档或source verified。

完整两遍读取通过，实际11份回答；完整response Tab为112行×8列，包括空白坐标、表头和所有返回CellData。两pass原schema、全部现存回答、完整矩阵、Form revision及API user均匹配。共92,684 UTF8字节，Form当前namespace为12条（schema＋11回答），Sheet当前为0，排除identity为0，PRIVATE_PENDING为112条（Sheet schema＋111物理行），GAP_LEDGER为15条证据条件。证据条件数量不代表实际丢失回答数量。

单页已覆盖本轮11份回答，Sheet按100行range分块；非空多页和复杂类型仍以此前本地模型为证据，本轮没有声称真实覆盖所有题型／附件。两pass一致只是 `TWO_READS_MATCHED_NOT_ATOMIC`，没有共同原子snapshot token。

新建一个独立Google Spreadsheet作为私有journal，真实核对API用户、唯一owner、全部权限页／published view和可见父目录ACL。原Form、回答表、业务四表和生产文件没有被修改。

| 隔离步骤 | 真实结果 |
|---|---|
| normal stage | 单次AddSheet＋UpdateCells，6段字面正文及控制头，完整原文回读一致；Google写入1次 |
| 新进程normal resume | 原目标／原core一致，写入0，活来源读取0 |
| 同命令normal重放 | 写入0，来源读取0，原回执不变 |
| lost stage | 真实写入成功后消费并丢弃回复，按同一Tab回读；写入1次，受控丢回复已发生 |
| 新进程lost resume | 原目标／原core一致，写入0，活来源读取0 |
| operation stage | 导入此前已固定的同一候选，持久记录write-start后真实写入1次，再受控中断本地receipt CAS；保留JOURNAL_WRITE_STARTED和完整原候选 |
| 新进程operation resume | 从原持久记录及Google Tab恢复到revision4／JOURNAL_READBACK_CONFIRMED；Google写入0，来源读取0，候选重新导入0 |
| 再次operation resume | 永久回执摘要和原结果不变，三个计数继续为0 |

Google测试副作用：一个新私有Spreadsheet、一个2行控制Tab、三个各7行×1列的私有journal Tab；保留为恢复证据，没有覆盖原Tab。受控丢回复和本地回执中断是明确故障注入，不是随机网络断包／真实配额耗尽。Spreadsheet create有独立先行marker；未知创建时停在原marker，不自动换目标或重建，本轮创建请求成功，不证明该未知窗口已自动恢复。

## 持久操作模块

[PrivateSourceOperation](../backend/source-journal/operation.ts)在私有存储中维护整个source operation的不可变scope fence和单attempt状态：PINNED→CANDIDATE_DURABLE→JOURNAL_WRITE_STARTED→JOURNAL_READBACK_CONFIRMED。整个operation pin包含actor、attempt、原source／cutoff／census、API owner及固定journal目标；改变attempt也不能绕过原operation，改target／actor／generation／epoch同样拒绝。

完整core与观测区间先经原plan validator、原source摘要及candidate摘要验证，再CAS持久保存；保存失败不得开始Google写入。write-start先CAS落地，随后只有赢得这次CAS的调用方可以stage；其他调用方只能resume原目标。若原目标不存在，保持未确认；不重新读取活源、不再次create、不换ID。并发观察方可能在首写尚未完成时暂时得到NOT_FOUND，后续只读恢复即可；不承诺所有并发调用都同时成功。

原journal控制头摘要可独立重算，结果必须与完整core、owner、actor、目标和原candidate相符，才持久保存receipt。每次load重新验证整个候选、原观测区间、状态／revision及receipt；每个异步边界复核当前context。成功后capture不重新采集，stage／resume重新核私有journal原内容。

[私有文件CAS适配器](../backend/source-journal/private-file-store.mjs)实现本机绝对路径／真实路径的仓库外限制、固定hash文件名、14MB文件预算、原子独占锁、写前revision比较、临时文件fsync及原子rename。文件包含原始来源，只能作为私有存储；禁止连接Worker／DO、公有artifact目录或公有备份。POSIX创建权限为目录0700／文件0600，Windows使用环境目录NTFS权限。本轮token ACL检查未发现Everyone规则，但这不是完整账号／系统安全审计。

真实operation测试导入的是此前已经完成两pass的原候选，未再次采集；证明私有持久状态、原payload和Google journal的恢复链，不声称已经用业务服务器的真实Coach、binding或known census发起完整capture。文件fsync／进程重建不等于断电、机器丢失或磁盘灾难恢复；崩溃遗留锁需要核对原进程和状态后处理，不自动删除活锁。

## 真实暴露的问题与修复

1. Forms REST可省略空白info.title。原纯schema校验错误地要求每个响应都含该字段；现改为存在时检查string类型，并原样保存absence。Google文档说明空title时UI可能使用documentTitle；本实现保存API原结构，不推测或填入UI替代值。见[Forms Info](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms#Info)。
2. 完整读取失败原来只给通用unsupported，难以定位。新增少量已知模型错误码白名单，保留统一安全消息；任意dependency code和code getter不能泄漏内容。
3. 独立操作状态关闭“原Google写入已成功，但本地receipt未落地”的恢复窗口；新进程只能回读原journal，并固定同一receipt。本模块不承担未知Spreadsheet创建的自动恢复。

## 当前边界与下一步

本轮是本机私有operation、真实Google adapter和隔离故障验收；未新增DO schema／backup表、Worker dispatch、Coach接口、Apps Script collector部署或生产部署。原source operation完整业务鉴权／权威绑定／逻辑scope接线、可信native Form↔response Tab关联、candidate逐块持久进度、长期服务存储部署与认证审核CAS仍待实现。尚无独立代理审查，本轮没有沿用历史双审结论。

source状态仍为 `SOURCE_NOT_VERIFIED`，原模型为 `LOCAL_SOURCE_PLAN_ONLY`，journal为 `PRIVATE_JOURNAL_READBACK_ONLY`，年度导出false；没有SOURCE_CAPTURE_FIXED／SOURCE_VERIFIED／业务年度receipt或公开年度文件。Google用户授权不是Coach身份，空测试census不是业务census，原Sheet行全部pending，原gap保留。

接续顺序：将该私有操作模型接到已认证、受绑定／generation／epoch保护的服务器上下文与可靠私有存储，补真实Tab关联及完整known census；关闭尚未逐块持久固定的capture恢复窗口，再接原已接受的人工映射审核CAS与派生资格文件。未核验源内容不得进入年度业务输出。

最终完整Node **431／431**，无失败／跳过；其中来源读取15、持久操作14、OAuth5，既有journal服务12及Google模型8继续通过。完整Workers **23文件／259测试**通过。独立私有TypeScript严格类型检查、Cloudflare类型检查通过；Astro **133文件、0错误／0警告／0hint**及三页构建通过，backend／C0 probe构建及Worker dry-run通过。

首次Workers和backend构建因运行器临时文件／既有构建目录的sandbox EPERM失败；按本地构建权限重新运行后全部exit0。一次私有TypeScript命令因TS6要求显式ignoreConfig而失败，修正后严格检查通过。初次真实读取的title兼容性失败已经修复；早期operation测试的共享fixture引用和并发调用成功假设已改为独立fixture与单writer／可重试观察方的正确断言。较早430计数是加最后一项反例之前的历史快照，最终以431为准。

文档链接／npm脚本、JavaScript语法及git diffcheck在文档同步后通过。构建产物仅本地，未部署／提交／推送。
