# C2.6 私有来源读取与存储 - 本地适配器验收

> 历史本地验收。下文的 API 阻碍及未实现项描述截至 2026-10-02；后续独立 OAuth、真实隔离来源读取和本机持久操作恢复见[2026-10-03 实际验收](C2-SOURCE-JOURNAL-ISOLATED-ACCEPTANCE-2026-10-03.md)，当前接续以[当前进度](../CURRENT-STATUS.md)为准。

日期：2026-10-01开始，2026-10-02收尾。按用户“持续按计划开发，无法解决时汇报”的指令，接续[来源捕获技术设计](C2-ANNUAL-SOURCE-CAPTURE-DESIGN.md)。本切片实现隔离的服务端 TypeScript 适配器和本地 REST 模型测试；没有将原始回答传入 DO、部署新桥接或修改生产配置。

## 已实现的读取和存储

[完整读取器](../backend/source-journal/source-reader.ts)读取当前 Form 完整 schema、全部回答页和绑定 response Tab 的完整 CellData。分页不按 pageSize 判断结束，不使用时间窗口遗漏回答；固定 ID 集合排序后比较。登记的 Spreadsheet／数字 Tab ID／标题、Form linkedSheetId、API 用户与服务器提供的 context 都必须相符。真实 response Tab 与 Form 的关联仍只有上游绑定声明，本适配器没有调用 Apps Script 重新证明该关联。

每次读取只取得一个 OAuth token，两次完整遍历使用同一 API 用户；每一遍在回答／Sheet 读取前后核对完整 Form schema 和 revision，并复核用户身份。最终比较完整 schema、全部回答内容和 Sheet 矩阵，不仅比较行数。迟到回答的正文也参与瞬时读取漂移检查，但沿既有纯模型从最终保留的 plan 中排除，不持久保存迟到正文。

Sheet 按每段最多100行请求有界 gridRange；所有返回 CellData 字段原样进入原始记录，不只保留显示姓名。中间空白和 API 省略的尾部空 rowData／values按固定坐标补 `{}`；缺失 Tab、异常 range、额外列或未知读取不当作空来源。保留小数、日期 serial、公式原文、错误类型和显示／有效／输入值；不推测历史值或 Form ↔ Sheet 对应关系。

[私有 journal service](../backend/source-journal/service.ts)存储已经完整验证的 retained core。必须先由未来的服务器调用方持久固定 source operation、attempt、actor、原 plan 摘要、专用 staging Spreadsheet／Tab ID及 owner身份，再调用服务。当前接口没有创建这些权威持久 pin，不能自行承担 source operation 状态机。

[Google 存储适配器](../backend/source-journal/google-store.ts)在已经存在、预先登记的私有 Spreadsheet 中，用一次 `AddSheet`＋`UpdateCells` 写入控制头及全部正文。Google [batchUpdate](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate)承诺同请求更新一起原子应用；[AddSheetRequest](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request#AddSheetRequest)允许指定未使用的 sheetId，已有 ID 时拒绝。实现没有覆盖已有 Tab 的分支，不承担新 Spreadsheet 创建及年度文件创建的未知窗口。

控制头固定完整 context、总 UTF8 字节数及分段数量；正文按 Unicode code point 分成≤16KB的字面字符串单元格，原来源 namespace／chunk／record 定位不改变。完整回读先核 control exact、全部传输分段及布局，再调用既有完整 plan validator 和原 SHA 域；之后再次完整回读并核私有权限。`resume()`只需要原 context 和保存的原正文，不重新获取活来源。

初次写入抛错或丢回复后，只读同一目标；不换 ID、不再发第二次 create。若没有找到原目标或读不到原内容，保持 `JOURNAL_WRITE_UNCONFIRMED`／`JOURNAL_NOT_FOUND`／`JOURNAL_READ_UNCONFIRMED`，停止该调用。没有可靠原 payload 时，未来调用方不能重新读取活源并冒充恢复；必须保留未决 attempt并先核清状态。首个存储请求尚未落地的 payload 仍可能只在内存，这个窗口没有被宣称为可自动恢复。

## 权限、资源和失败边界

Drive 核验实际 API user permissionId、目标 owner、非 Shared Drive／非回收站，以及目标和所有可见父目录的完整 ACL。父链最多8层，每个权限集合最多8页；额外用户、group、domain、anyone、published view、重复 permission、循环或读不到均拒绝。查询使用 [includePermissionsForView=published](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/list)，不把缺权限证据当作“私有”。ACL多次读取只证明相应观测时未发现共享，不能保证随后用户永远不改变权限。

[私有 HTTP transport](../backend/source-journal/google-client.ts)只向固定 Google API host 发送 bearer token，拒绝跳转。未知 HTTP／token／依赖错误只返回固定错误码和固定消息，不输出 Google error body、令牌或源记录。完整来源 HTTP JSON 在 `JSON.parse`之前使用既有重复 decoded key、深度、Unicode和有限数值扫描。普通 journal 的大响应包含转义正文，只解析为字面单元格，最终再以原 core validator／digest核验。

原 input／core仍≤2MB、5000 records、50k cells、每个原 record／chunk≤64KB；读取每页／range响应≤2MB、最多128回答页、观察区间最多15分钟。journal控制≤8KB、正文每段≤16KB、最多127段；grid元信息先证明目标尺寸，再取正文。转义的 journal HTTP请求／响应另外受14MB传输上限保护，并在流式读取中检查累计字节。每次 HTTP有30秒超时，不自动重试。

这些限额不等于固定 heap、CPU或全部 Google配额保证。两次完整源对象与 canonical text可能共存；任一预算或内容漂移失败均不返回部分 plan。未固定 candidate的逐块持久进度、原操作持久状态机、绑定权威事务、审核 CAS和永久 receipt仍未实现。

## 验证和真实阻碍

2026-10-02后续配置：用户提供独立项目 `dragon-boat-source-test` 及桌面客户端，当时等待授权；2026-10-03已完成实际grant／API检查、真实隔离读取和私有持久operation恢复，见[最新真实验收](C2-SOURCE-JOURNAL-ISOLATED-ACCEPTANCE-2026-10-03.md)及[来源OAuth配置](C2-SOURCE-OAUTH-SETUP.md)。下方旧clasp失败及本轮“无真实来源读写”结论保留为10-02历史证据，不能作为最新状态。

作者本地专项由[存储规则](c2-source-journal.test.mjs)、[Google REST模型](c2-source-journal-google.test.mjs)、[完整来源读取](c2-source-reader.test.mjs)组成。覆盖原六个固定 goldens、同 ID并发、create丢回复、原内容丢失、实例重建、原 command变化、正文／控制篡改、读间漂移、ACL与 inherited／published分享、公式字面存储、完整分页、迟到正文漂移、空白坐标、纳秒 cutoff、资源和固定错误。实例重建及 REST模型通过不等于真实 Google持久化或真实进程重启验收；本轮没有委派独立审查，不能沿用历史双审结论。

首次专项18/19后，修复共享 validator清洗 hash异常时掩盖 journal actor／target fence的问题，提交 catch路径再次复核完整 ownership。之后加入完整源读取；一项循环 pageToken测试的预期码写错，修正为实现实际的 `SOURCE_READ_PAGE_TOKEN_INVALID`。最终计数及全量检查见下方，不把较早失败当作最终通过。

真实能力核查只使用现有 clasp OAuth授权，不打印或保存凭据。已有授权包含 `drive.file`，没有 broad Drive；这不能保证应用能够访问所有既有 Form／Sheet。使用不存在的资源 ID探测 API可用性，避免读取真实回答，实际得到：

| API | 本次实测 |
|---|---|
| Forms REST | HTTP403，`SERVICE_DISABLED` |
| Sheets REST | HTTP403，`SERVICE_DISABLED` |
| Drive about／API身份读取 | 请求成功，不输出身份 |

本地未配置专用来源 journal目标或独立 source OAuth。当前 clasp指向 C0 probe构建，不能把该配置直接用于部署新收集器。[Google配置要求](https://developers.google.com/identity/protocols/oauth2/web-server#prerequisites)要求在实际 OAuth客户端所属 Cloud项目启用 API。下一项需要项目管理权限：提供可管理的测试 Cloud项目／OAuth客户端，启用 Forms和Sheets API，并确认对应来源文件访问授权；随后预置私有独立 journal，固定 server operation／attempt，并进行真实两遍读取、ACL、丢回复和原内容恢复验收。无需把凭据贴进聊天或提交 Git。

在此阻碍解决前，本轮结果保持 `LOCAL_SOURCE_PLAN_ONLY`／`SOURCE_NOT_VERIFIED`；journal结果为 `PRIVATE_JOURNAL_READBACK_ONLY`，不是 `SOURCE_CAPTURE_FIXED`或 source verified。observer返回 `TWO_READS_MATCHED_NOT_ATOMIC`，其观测摘要尚未作为永久 receipt持久保存，也不消除原 gap ledger。全 Sheet仍是 PRIVATE_PENDING，年度导出始终false。

源码没有进入 Apps Script完整构建／C0 probe，也没有 Worker／frontend导入、HTTP／Coach接口、SQLite／backup迁移、alarm／cron或生产部署。真实 Coach身份、固定capture私有查看、持久审核及年度Google输出仍在后续门槛中。

## 最终本地结果

最终完整 `npm test` **409/409**，无失败或跳过，包含本轮新增32项；专项为存储12、Google REST模型8、读取12。完整 Workers **23files／259tests**通过；`npm run cf:check`通过。Astro检查127files、零错误／警告／hint，三页构建通过；backend、C0 probe及Worker dry-run通过，全部exit0。文档最终链接检查及diff检查在说明更新后再次执行。

没有远端部署、Form／Sheet业务读取或写入，没有stage实际Google文件，也没有提交／推送。真实能力探测只取得OAuth授权范围、Drive API身份可用性和不存在资源ID的失败状态；不能把这些请求当作真实来源捕获验收。
