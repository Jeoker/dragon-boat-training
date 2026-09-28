# C2.4 回执丢失验收与排期同步基础

日期：2026-09-28。两个工作边界不同：回执丢失在独立 `c2test` Worker／Google 文件真实执行；排期同步实体和 schema v10 只在本地完成，**没有部署到任何远端 Worker**。原 staging、Pages 和生产 Apps Script／Sheets 均未改动，生产写入权未切换。

## 隔离环境：Google 已写、Worker 未收回执

测试先对第一名虚构队员作同偏好更新，等待原有十分钟 outbox 到期。独立 Google Web App 的临时 v11 构建只在已验证签名的 `cloudflarePatchMemberSheet` 完成业务行、私有 `BridgeExportReceipts` 写入后，对以 `c2_reply_drop_` 开头的这一次请求返回空响应。故障注入仅存在于被忽略的生成文件；正式源码没有测试开关。Worker 将空响应报为 `BRIDGE_UNAVAILABLE`，批次为 `FAILED`、尝试次数 1，原 outbox 仍为 `PENDING`；独立签名读取已能看到 Google 成员版本提前写入。

使用新请求 ID 重试后，Worker 从**原 batch ID**取得 Google 的持久回执并确认成员批次，再确认赛季名单版本。`Members` 仍为 10 行，没有重复插入；最终 `Members` 和 `Seasons` B/C/G 均为 `OK`、零差异，未完成批次、待同步 outbox 和开放冲突均为 0。验收脚本是 [live-c2-lost-reply.mjs](live-c2-lost-reply.mjs)，要求固定 c2test 主机、私有测试凭据、显式 `--recover-isolated-batch`，并在恢复前读取受保护备份核对原批次身份。准备同值事件使用 [live-c2-debt-export.mjs](live-c2-debt-export.mjs) 的 `enqueue` 阶段。

测试后将独立 Web App v12 更新为与当前 `backend/.build/Code.gs` SHA-256 相同的**无注入构建**。再次运行 [live-c2-readiness.mjs](live-c2-readiness.mjs) 得到 schema v9、绑定版本 1 有效、`Members` 10 行／`Seasons` 1 行零差异、零积压及 `IDLE`。这证明的是“Google 持久写入后，Worker 无法解析该次响应”的恢复边界；它不证明极窄人工同时编辑、Google 配额耗尽，或真实网络断包的每一种时序。

## 本地：模板／周次同步基础

schema v10 在同一 Durable Object 事务中重建三个含 `entity_type` CHECK 的同步表：`sync_baselines`、`sync_conflicts`、`sync_batch_items`，只扩展 `SCHEDULE_TEMPLATE` 和 `TRAINING_WEEK`，显式列复制旧数据并重建索引。测试从带成员基线、开放冲突和已核验批次项的 v9 状态升级，核对所有行、外键与索引保留；旧 v7、v8 升级路径也继续通过。

模板和周次已有受约束的字段映射、可空时间／版本归一化、外键与身份基线校验，以及各自 Google Tab 的 B/C/G 只读分类。排期字段的 Google 人工修改需要复核，版本列受到保护；直接编辑 Google 不会自动改写 Cloudflare 业务行。接口级测试覆盖合法基线导入、错误周身份拒绝、无变化读取及排期修改诊断，未产生导出批次。**这还不是排期写回**：模板／周次目标投影、有序批次、整事件确认、多行 payload 拆批和远端 Google 验收仍是 C2.4 后续工作。

下一切片的明确设计门槛：现有 `PRACTICE` B/C/G 映射使用派生 `cancelled` 和独立 `signup_version`，而 Google `Practices` Tab 保存的是 `cancelled_at` 等原始列，没有 `signup_version`。实现训练行目标投影前须先统一字段语义，并处理任何既有训练基线；不能把当前模板／周次映射直接套到训练行。跨三表事件还须核对模板和周次引用，再决定整事件确认。

本地验证：Node 193／193、Cloudflare 123／123、TypeScript 检查、Astro 三页构建（75 文件零诊断）、后端及桥接探针构建、Worker dry run、`git diff --check` 均通过。Wrangler 日志目录的 EPERM 和故障注入 alarm 文本仍会输出，但相应测试退出码为 0。
