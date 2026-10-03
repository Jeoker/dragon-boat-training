# C2.6 来源 checkpoint 真实隔离恢复验收

日期：2026-10-03。用户明确授权使用现有 OAuth，只读既有 C2 隔离 Form／响应表，并把恢复进度保存到原私有验收目录。此前[本地实现报告](C2-SOURCE-READ-CHECKPOINT-LOCAL-ACCEPTANCE-2026-10-03.md)中的具体读取／保存授权阻碍已解除；本报告记录随后实际执行的结果。

## 固定范围

使用既有独立项目 `dragon-boat-source-test` 的 OAuth，以及隔离配置中登记的 Form、runtime Spreadsheet、数字 response Tab 和原 Tab 标题。脚本只放行该 Form 的 schema／responses GET、该 Spreadsheet 的 metadata GET／`getByDataFilter` 只读 POST，以及 Drive API 用户 GET。没有调用 Google 写接口、创建文件或修改原来源。

新 context、checkpoint 和 candidate 保存在 `D:\agents\env\dragon-boat\source-journal-acceptance-2026-10-03` 内的新文件名及 `checkpoint-reads` 子目录。原候选、journal、operation 和 receipt 未覆盖；凭据、来源 ID、API permission ID 和 raw 内容不进入仓库或普通输出。

仍使用 `ISOLATED_ACCEPTANCE_RUNNER_ONLY`、`TEST_ONLY_NOT_REGISTERED_SEASON_END` 和 `EMPTY_TEST_DECLARATION_NOT_AUTHORITATIVE_HISTORY` 的测试声明。新 context 固定独立 source operation、attempt 和测试 cutoff；空 census／空 mapping 不是业务历史全集或真实 Coach 鉴权。journal 目标只作为原 context 的固定定位声明，没有向该目标写入或创建新 Tab。

## 三个独立进程

逐次执行[隔离脚本](live-c2-source-journal-acceptance.mjs)的 `checkpoint-stage`、`checkpoint-resume`、再次 `checkpoint-resume`，三个 shell 命令均 exit0。

| 进程 | 来源内容请求 | 实时身份请求 | 结果 |
|---|---:|---:|---|
| stage | 4 | 2 | 第一个完整 Sheet range 持久保存后受控中断，原返回已可靠保存 |
| 新进程 resume | 8 | 4 | 原请求序列从头重放已保存块，只读取尚未开始的后续请求，完成两遍读取和固定 candidate |
| 再次新进程 resume | 0 | 1 | 仅重新核对 API 用户，完整 core／观测与此前 candidate 精确一致 |

实际来源有 11 份 Form 回答和 112×8 的 response Tab。每遍 Form 回答只占一个 API 页面；真实多页仍由本地模型覆盖。两遍 Sheet range 均为 `[0,100)×[0,8)` 和 `[100,112)×[0,8)`。stage 与首次 resume 共 12 次来源内容请求，正好是两遍完整读取，第一块没有因重启重新采集。

私有持久记录核对结果：16 个完整返回、revision34、pending=null，原开始／结束时间与 candidate observation 完全一致。16 项包括 4 次持久身份观测、4 次 Form schema、2 页回答、2 次 Sheet metadata、4 个 range。stage 与首次 resume 另有两次实时 token 身份检查，最后重放还有一次；这些检查不作为来源 raw 块追加。

UTC 观测时间为 `2026-10-03T15:10:49.854Z` 至 `2026-10-03T15:11:10.834Z`，持续 20.980 秒，位于固定十五分钟预算内。此次独立 candidate 为 92,664 UTF8 字节；由于 source operation／测试 cutoff 等身份重新固定，不拿它与此前独立 journal 验收的 92,684 字节候选比较。

namespace 数量为 Form 当前12、Sheet 当前0、排除身份0、私有 pending112、gap ledger15。Form 当前含 schema＋11 回答；私有 pending 含 Sheet schema＋111 物理行。gap 数量代表证据条件，不是实测删除回答数量。

## 验证边界与接续

本轮受控中断发生在完整 range 已持久保存之后，实际跨进程恢复和完整 candidate 零来源重放通过。没有执行“返回已收到但尚未保存”窗口的真实故障；该窗口继续由本地测试证明会停在 unresolved，不能重新读取原页。没有声称随机网络故障、断电、机器丢失、并发远端读取或多机长期存储验收。

两遍读取结果一致仍为 `TWO_READS_MATCHED_NOT_ATOMIC`。来源保持 `SOURCE_NOT_VERIFIED`，所有原 Sheet 行保持 pending，年度导出 false；本轮没有业务 source receipt、审核确认或 `SOURCE_CAPTURE_FIXED`／`SOURCE_VERIFIED` 发布。

代码沿用本地验收的 Node453／453、Workers259／259、严格类型及各构建通过基线；这三次实际运行后只更新文档，没有新增运行时代码。更新后的文档链接／npm脚本检查与 diff 检查通过。无生产 Pages／Apps Script／Worker 部署，无提交或推送。

下一步继续接权威业务 actor／binding／generation／epoch、完整 known census 和可信 native Tab 关联，再落实长期私有服务存储及已认证 Coach 的只追加审核 CAS。此次 OAuth 私有读取授权不替代这些业务条件。
