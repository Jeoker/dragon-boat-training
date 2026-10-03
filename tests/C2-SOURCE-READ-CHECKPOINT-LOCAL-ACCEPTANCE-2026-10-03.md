# C2.6 来源逐请求持久进度本地验收

日期：2026-10-03。按用户继续开发的要求，承接[此前真实私有 journal 与持久操作验收](C2-SOURCE-JOURNAL-ISOLATED-ACCEPTANCE-2026-10-03.md)，补完整 candidate 落地前的来源读取恢复。本报告仅记录新增本地证据，旧报告的真实 Google 结果保留原日期和范围。

> 本报告记录首次本地验收及当时的具体授权阻碍。随后用户明确授权隔离读取与私有目录保存，真实跨进程复验已通过，见[后续实际验收](C2-SOURCE-READ-CHECKPOINT-ISOLATED-ACCEPTANCE-2026-10-03.md)。

## 实现与恢复规则

[PrivateSourceReadAttempt](../backend/source-journal/read-attempt.ts)为[GoogleSourceReader](../backend/source-journal/source-reader.ts)提供可选的私有 checkpoint 端口。部署调用方须将它与原 PrivateSourceOperation 使用同一权威上下文和私有持久存储；本轮测试已验证该组合，默认无端口的独立 reader 仍只在内存中读取。

1. 按 team／source operation 固定读取记录，保存完整 actor、attempt、来源 binding／generation／epoch、census、映射声明、API owner 和 journal 目标。更改 attempt、actor 或目标不能绕过原记录。操作上下文校验与原 operation 共用一个函数。
2. 每个请求先通过 CAS 保存完整 URL、GET／POST、body 和开始时间，再调用 Google transport。返回内容经过既有原始 JSON 扫描后，以 typed canonical JSON、结束时间和位置摘要追加持久保存。来源请求只在赢得 read-start CAS 后执行。
3. 重启从完整读取算法的开头重放已保存的请求结果，逐个核对原请求身份、顺序、内容摘要和观测时间。只有从未开始的下一请求可以继续访问来源；页序和 range 坐标仍由原 reader 校验。
4. 请求已开始但返回内容没有可靠保存时，保留 pending 并返回 `SOURCE_CHECKPOINT_REQUEST_UNRESOLVED`。不重新读取该页，不换 attempt 或来源目标。即使是只读请求，重新读取也可能取得变化后的内容，不能用来补原证据。
5. 两遍完整来源一致后，CAS 固定原结束时间。完整读取记录可以在候选最终保存失败后重建同一 plan；后来来源变化或重新启动时间不修改原观测。恢复仍以新 OAuth token 实时检查 API 用户，再读取私有缓存内容。

原观测窗口最多十五分钟，未完成 attempt 重启不能延长该窗口。已完成记录使用原开始／结束时间重建，允许之后只读恢复。逐块返回内容和请求定位均为私有数据；不保存 Authorization header 或 token，不进入公开 DTO、Worker／DO 或业务备份。

每个返回仍受原始输入的 2 MB／深度预算约束；整个 transcript 最多 384 个请求、6 MB 返回正文，持久记录最多 14 MB，同时核对 canonical 和实际 JSON 序列化字节。当前采用一个有界 CAS 文件保存追加序列，每次确认重写完整记录，复用既有私有文件存储的锁、fsync 和原子 rename。它不提供多机高可用、断电保证或长期服务部署。

## 本地验证

新增[18 项恢复测试](c2-source-read-attempt.test.mjs)，使用虚构来源、两页 Form 回答及两块 Sheet range，覆盖以下窗口：

| 场景 | 已验证结果 |
|---|---|
| pin／read-start 保存失败 | 受保护的来源请求未发出 |
| read-start 已保存但确认丢失 | 保持 unresolved，不首次发出或重取该请求 |
| range 完整保存后调用方中断 | 重建 reader 后复用原页和 range，继续下一块 |
| 返回已取得但持久保存失败／API 页面失败 | 保留 pending，重启拒绝重取活来源 |
| 全部读取后 finalization 失败 | 在原窗口内零来源内容读取完成固定 |
| 完整固定后新内容／较晚重启 | 原 plan 和观测完全一致，仅重新检查 API 用户 |
| 新 API 用户、actor／binding／generation／epoch／目标变化 | 拒绝读取或继续原 checkpoint |
| 内容、时间、revision 或集合篡改 | 在新的来源内容读取前拒绝 |
| 并发 reader | 同一来源请求只有一个 CAS winner 可以发出 |
| 总字节／请求数越界、时间倒退、超时 | 不发布完整 transcript，安全错误不泄漏来源 |
| operation candidate CAS 失败 | 复用已固定 transcript 重建候选，journal 仅写一次 |
| 私有文件 store 和 reader 重建 | 完整原页保留，两个 range 不重复读取 |

文件重建测试在同一 Node 测试进程内创建新实例；本轮没有把它写成已执行的真实跨进程或机器故障验收。原 reader 的十五项测试继续通过，测试来源模拟器提取为共用文件，没有删除原场景。

完整 Node **453／453**，无失败或跳过；完整 Workers **23 文件／259 测试**通过。来源及 Cloudflare 严格类型检查通过。Astro **136 文件、零错误／警告／hint**，三个页面构建通过；backend、C0 probe 构建及 Worker dry-run 通过。文档链接、脚本语法及 diff 检查通过。

Workers 首次因项目内 `.vite-temp` 的 sandbox EPERM 无法启动，获准执行本地缓存写入后通过。提取测试辅助文件时 shell 写入被 EPERM 拒绝，改由正常补丁工具完成。未提交、推送或部署，未修改生产 Pages、Apps Script 或远端 Worker。

## 真实复验入口与当时阻碍

[隔离验收脚本](live-c2-source-journal-acceptance.mjs)新增 `checkpoint-stage`／`checkpoint-resume`。只允许读取原隔离 Form、runtime Spreadsheet 和 Drive API 用户；不调用 Google 写接口。前者在第一个完整 range 已保存后受控中断，后者在新进程按原记录继续；再次 resume 应为零来源内容读取。脚本使用原验收目录的新文件名，不覆盖原 candidate、操作或 journal 回执。

首次本地验收结束时，该具体命令尚未执行。自动审批拒绝使用现有 OAuth 读取私有来源，并在 `D:\agents\env\dragon-boat\source-journal-acceptance-2026-10-03` 保存新 checkpoint；理由是当前可信消息没有明确授权该组数据及保存位置。没有通过其他工具或间接执行绕过拒绝，也没有新增仓库外文件。随后用户明确授权并完成 stage、新进程 resume 和重复 resume；结果以上方后续实际验收为准。

本轮不发布 `SOURCE_CAPTURE_FIXED` 或 `SOURCE_VERIFIED`，仍为 `SOURCE_NOT_VERIFIED`，全部 Sheet 原行保持 pending，年度导出 false。真实 checkpoint 中断／跨进程续读、业务 Coach 鉴权、权威完整 census、可信 native Tab 关联、长期私有存储及只追加审核 CAS 仍需各自验收；新模块不替代这些门槛。
