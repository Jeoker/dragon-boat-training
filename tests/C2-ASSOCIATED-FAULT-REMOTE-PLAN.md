# C2 关联四表受控故障隔离验收计划

> 历史范围说明：下文“当前／待执行／未部署”指该切片形成时的状态。后续实际执行已完成，见[隔离实际验收](C2-WAITLIST-FAULT-PAUSE-ISOLATED-ACCEPTANCE-2026-09-30.md)；今天的部署状态见[CURRENT-STATUS](../CURRENT-STATUS.md)。本文不授权重新运行旧脚本，不替代实际验收报告。

> 2026-09-30。本文描述待执行步骤，不是通过记录。生成器和 inspector 不部署、不导出、不修复业务行；故障 hook 仅存在被 Git 忽略的隔离 overlay。真实验收须由 supervisor 逐步执行并独立审核。

## 1. 固定范围与工具

只使用专用 `c2test`、赛季 `season_c2_isolated_2026`、绑定版本 1、归属代次 0，当前 Worker `0.16.2-c2-physical-diagnostics`／schema v13。生产、原 staging、Pages 不变；自动轮询关闭且无 cron。

复用候补验收 journal 中的原取消事件：Alpha 取消、Lambda 由候补递补，报名版本 12、草稿版本 2、正式 revision 2。业务取消只执行一次；既有 revision 1 保留。

- [`build-c2-associated-fault-overlay.mjs`](build-c2-associated-fault-overlay.mjs) 只生成忽略目录中的完整 Apps Script overlay、clean-source 和私有 fault-plan，不进行网络请求。
- [`live-c2-associated-fault-inspect.mjs`](live-c2-associated-fault-inspect.mjs) 只读 Google／Worker 业务状态，建立与验证显式请求的私有证据备份，不推进导出或修复业务。故障／恢复阶段必须带 `--capture-private-backup`。
- [`live-c2-waitlist-acceptance.mjs`](live-c2-waitlist-acceptance.mjs) 承担原业务和导出，取消导出始终指定 `--max-calls=1`，失败保留同一个 journal `inflight`。一次命令最多推进一个批次，不开启自动循环。

私有 fixture、Script／deployment／Sheet ID、journal、完整行及凭据不得进入 Git 或公开输出。生成器只公开 source hash、scope 和生成状态；inspector 只公开结果、计数与版本保留结论。

## 2. 生成前门槛

1. 十个报名事件已确认，原取消已提交并完成 `audit-queued`；取消 snapshot／outbox ID／due time 由私有 DO 备份核验。取消还未执行任何 export call，也没有 inflight 或未完成批次。
2. 云端 Google 与 DO 尚处取消前的同步状态：关联游标 11／1／1，Google 报名 11 行，完整船位 20 格、状态一行、revision 1 一行。DO 业务已变为取消／递补结果，与 Google 延迟状态明确区分。
3. supervisor 只读拉取隔离 deployment version 14 与 HEAD 到仓库外私有目录 `associated-fault-clean-v14/source/` 和 `associated-fault-clean-head/source/`，分别保存 deployment 元数据和拉取日志，核对 `.clasp.json` 的同一 script 身份。
4. 两套快照和当前私有 `source/` 均必须完整包含三个逻辑文件：`Code`、`C2Fixture`、`appsscript.json`。clasp 的 `.js` 与本地 `.gs` 仅正规化逻辑扩展名；重复逻辑名、额外文件、缺失或符号链接均停止。当前私有 source 必须与原 HEAD 逐逻辑文件字节一致。
5. 部署 v14 与原 HEAD 的 Code／manifest 必须逐字节一致。唯一允许差异为已经独立审核的 fixture 追加：v14 fixture SHA-256 为 `00BE58B00537F0057BCF7F177C3176EE3C63C18CC7F34641B184BAC42CFBE373`，HEAD fixture 为 `6AEE9C8074C747FA24BDE9B6F81A8205A04D3D846798D221CB2249F56F470DED`，HEAD 以全部 v14 fixture 字节为前缀并仅追加 1,613 字节。追加仅声明隔离编辑器 helper `ensureC2IsolatedCoachReference`，不注册 dispatcher／trigger；任何其他 hash 或差异停止。不能先改变部署／HEAD 来对齐基线。
6. `Code.js` 与本地 `backend/.build/Code.gs` 的 SHA-256 均为 `2004DF4D80B0FA2B24AB3674A28D899B8E2F0892EC067B01707C9346C1C349F0`。v12 旧 overlay 不参与本次生成。
7. `private-test-config`、固定 Worker 主机、Worker 配置、bridge `/macros/s/<同一 deployment>/exec`、私有 `.clasp.json`、journal 和两套 source 快照交叉核对。同一 Script 的部署归属由 operator 的远端元数据和精确 URL 核验；Google 请求本身不新增生产测试配置。

仅在这些门槛实际通过后运行。验收环境变量固定来自仓库外私有文件 `D:\agents\dev-master\.c2-form-test\acceptance.env`，不要使用 Worker 本地开发文件 `cloudflare/.dev.vars` 代替，也不要打印其中内容。

```powershell
node --env-file="D:\agents\dev-master\.c2-form-test\acceptance.env" tests/build-c2-associated-fault-overlay.mjs --build-isolated-overlay
```

输出位于 `cloudflare/.acceptance-artifacts/associated-fault-overlay/`。overlay 基于完整部署 v14；`clean-source/` 保存部署 v14 完整三文件，`head-clean-source/` 分别保存原 HEAD 完整三文件，两侧保留各自实际文件名。仅 overlay 的 Code 被修改。`fault-plan.json` 分别记录两套 clean 的逻辑名、实际名、hash、相对目录、部署恢复版本 14，以及 overlay hash、取消 snapshot 摘要、审计备份和精确请求／批次／目标行。生成器拒绝覆盖已有 overlay；重试期间不得重新生成 run、批次或清除 once 标记。

## 3. 精确目标和一次故障

请求从真实 journal 的 `run_id`、取消事件序号 10 及 batch call index 派生：`<run_id>_export_10_<callIndex>`。批次为 `batch_` 加 `sha256base64url(team + "\nC2:EXPORT\nexportNextAssociated\n" + request_id)`，与 Worker 请求身份算法一致。

生成器重建取消 snapshot 的实际阶段顺序及目标，按同 scope 最多四行拆批，用允许的最长数字 tab ID 验证每组 JSON 不超过 Worker 的 9,500 UTF-16 字符预算。不符合预算时停止，不能猜另一个 call index。当前受验形状必须为：两行 SIGNUP 一批、20 格船位五批、revision 2 一批、状态一批，最后一个独立请求确认整个事件。

| 故障 | 注入位置 | 预期远端证据 |
|---|---|---|
| SIGNUP 首行完整写入后中断 | 精确 SIGNUP 批次、精确请求、第一条 snapshot row；整行已核验，`PARTIAL` receipt 已更新并 flush；在原桥接锁内写一次标记，然后抛可重试 `TEST_ASSOCIATED_PARTIAL` | 第一行等于目标，第二行仍等于 expected；Google receipt `PARTIAL`；Worker 同批次 `FAILED`，原 outbox `PENDING`，B／游标仍 11／1／1 |
| revision 2 回执提交后空回复 | 精确 revision 请求及批次已返回 `verified`；重新取得桥接锁，flush `VERIFIED` receipt，原子写一次标记后返回空正文 | revision 2 恰一行，Google receipt `VERIFIED`；Worker 因 JSON 回复未知而同批次 `FAILED`；不重复 revision，不提前确认 outbox／B／游标 |

每个 hook 校验 Script ID、签名后的 team／season／binding／epoch、runtime Sheet、scope、operation／batch、request ID 和整份 exact expected／target items。非匹配请求不触发。一次标记使用私有 ScriptProperties 的精确 batch 键，首次写入后同请求重试不会再次触发；标记保留为验收证据，不重置。

签名只读 `c2TestReadAssociatedFaultReceipt` 仅存在 overlay，除上述签名／Script 身份外核验私有 runtime Sheet 和 deployment ID，仅允许两个固定 batch。已有其他 receipt 时，目标尚未出现返回 `MISSING`；重复目标 receipt 则停止。该 probe 不写业务表或 receipt。

## 4. 独立审核与临时隔离部署

先由另一 agent 审核 generator、实际生成文件 diff、故障计划及 inspector。本地测试必须覆盖实际 v14 bridge 的第一行故障与第二行不变、同请求恢复、revision receipt 先确认而回复只丢一次、旧 receipt 非空时目标 MISSING、错误 team／batch／items 拒绝、实际 logical entity_type 与 physical scope，以及原 revision 保留。

审核通过后 supervisor 核对私有完整 source hash 与 remote version／HEAD，再使用 overlay 项目的同一 `.clasp.json` 推送完整三文件，创建临时 version，并只更新记录中的原隔离 deployment ID。具体 version 编号从 CLI 结果取得，不能预填；原 clean version 14 保留。

clasp 的受支持步骤由项目路径和实际结果决定：`list-deployments`、`push`、`create-version`、`deploy --versionNumber <新版本> --deploymentId <原隔离ID>`。部署前后保存私有 JSON 元数据，核对只有原隔离 deployment 更新；不得创建生产测试开关、变更 bridge URL 或更新 Worker。

部署后首先执行 `--phase=probe`，要求两个固定批次的签名 receipt 读取均 `MISSING`、取消 outbox 1、未完成批次 0。不能用探针可读推断业务故障已验证。

## 5. 逐批注入、观察和恢复

所有取消导出命令均使用：

```powershell
node --env-file="D:\agents\dev-master\.c2-form-test\acceptance.env" tests/live-c2-waitlist-acceptance.mjs --phase=export --step=cancel --max-calls=1 --write-test-data
```

1. 等原 outbox 自然到期，不手动修改时间。执行一次取消导出，期待可重试失败；journal inflight 保留原请求，export_calls 仍为零。失败后不运行另一个业务操作。
2. 执行 inspector `--phase=partial --capture-private-backup`。核验同 batch `FAILED`／同 outbox `PENDING`、第一 SIGNUP target／第二 expected、receipt `PARTIAL`、原 B 和 11／1／1 游标不动、revision 1 全行不变。保存完整私有备份及四表／receipt 证据。
3. 重新执行完全相同的 single-call 命令，使用 journal 原 inflight 恢复同 batch。期待 `BATCH_CONFIRMED`，然后 inspector `--phase=recovered --capture-private-backup` 核验两个 SIGNUP target、receipt `VERIFIED`、该 batch `CONFIRMED`、仍无事件级 B／游标推进。
4. 后续每次手动执行一个座位批次，逐次核对 journal call prefix 与 fault-plan；五批确认后停在 revision call。批次号、scope 或行 ID 与计划不同即停止，不换一个新 ID 绕过。
5. 执行一次 revision single-call，期待 `BRIDGE_UNAVAILABLE`，原因是空正文不能解析为 JSON；这属于受控丢响应，不能称为真实随机断网。journal 保留原 inflight。
6. inspector `--phase=lost-reply --capture-private-backup` 必须证明：revision 2 恰一行、原 revision 1 全行不变，receipt `VERIFIED` 而 Worker 同 batch `FAILED`；当前船位已是取消 snapshot，状态仍旧；全部逻辑／物理 B 和 11／1／1 游标仍旧。
7. 再次执行原 single-call 恢复同 revision batch，期待 `BATCH_CONFIRMED`；inspector `--phase=recovered --capture-private-backup` 证明同批确认且 revision 2 仍唯一，不出现 revision 3。

inspector 始终只观察；它不调用导出、retry、暂停、行 CAS 或业务修复。故障时用完整备份核验 `sync_batches`、`sync_batch_items`、原 outbox、逐场 cursor、全部逻辑 B 及关联物理 B；不能用旧主 runner 的“无未完成批次”前置条件跳过这份故障证据。

## 6. 恢复 clean 与最终核验

两处故障及同请求恢复已分别取证后，先恢复 clean 代码，再完成剩余状态批次和事件确认。

1. 从私有 `head-clean-source/` 恢复原 HEAD 全部三个文件，按 `head_clean_source_files` 逐逻辑文件核对保存的 hash，推回同 Script HEAD。不要用 v14 fixture 覆盖原 HEAD helper，不清一次标记、不删除 receipt，不恢复旧 DO 备份。
2. 将同一个隔离 deployment ID 恢复为保留的 clean version 14，部署源须与 `clean-source/`／`clean_source_files` 完整一致。HEAD 与部署分别回到各自原始基线，不新建 clean version 来把两者对齐。保存实际编号和部署元数据。
3. 独立拉取恢复后的 HEAD 与当前 deployment version 到新的忽略目录，分别检查完整逻辑文件集合、实际名及逐文件 hash：HEAD 对照原 HEAD clean，部署对照 v14 clean，Code 两侧均恢复固定 `2004DF...`。只有同一 Script／deployment 两侧各自恢复才算清理完成。
4. 恢复后临时 receipt action 应不可用。不能再用 overlay inspector 取最终 receipt；之前 fault/recovered 私有证据已保留。
5. 继续剩余 single-call：状态批次确认，然后完整事件确认。最终主 runner `--phase=final --capture-private-backup` 校验取消／递补、signup 12／seat 2／revision 2、四表精确目标、revision 1 全行不变、七类语义 B/C/G 零差异、四类物理诊断完整覆盖且零差异、outbox／batch／retry 零及最终私有备份完整。自动导出仍关闭且无 cron。

未知结果始终复用原 journal 请求；丢失 journal、绑定／代次变化、未计划事件、表结构变化或私有证据不足时停止并与 supervisor 沟通。停止后优先恢复 clean deployment／HEAD，保留 Google 与 DO 的原批次现场，不能直接覆盖行或重新执行业务取消。

## 7. 证据边界

本计划通过后可证明隔离关联批次的受控首行写入后中断及 receipt 已确认后丢响应恢复。它不证明真实配额耗尽、随机网络断包、极窄人工编辑竞态、自动 cron、备份恢复、独立训练通道或 C2.4／C2.5 整体完成。当前文档不能替代实际部署版本、故障前后截图／私有备份和最终恢复记录。
