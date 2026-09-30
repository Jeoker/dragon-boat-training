# C2.4 排期部分写入与丢回执：独立 Google 验收

日期：2026-09-30。只操作固定的 `c2test` Worker、独立 Apps Script Web App、虚构赛季及独立 Google 测试文件。原 staging、正式 Pages／Apps Script／Google 文件均未改动；自动导出仍关闭。所有业务写入均由显式测试阶段触发，测试训练仍为私有草稿。

## 执行与结果

1. 写入前核对 Worker `0.14.0-c2-operations`、schema v11、绑定有效、零未完成批次／outbox、10 名虚构成员和三张排期表结构；创建、校验并私有下载 29 分块备份。先对 2026-10-12 测试周的一场既有训练修改 `location` 与 `address`，产生一个有十分钟到期时间的排期事件。Google 原训练行的这两个字段仍为旧值。
2. 从隔离 Apps Script **已部署 v12** 拉取源码，核对其与独立项目的 HEAD 和私有快照 SHA-256 一致。临时 v13 只对本次赛季、训练 ID、签名批次 ID 与请求 ID 注入故障，并提供限于这两个批次的签名只读回执探针。注入只存在于 Git 忽略目录生成稿；正式源码没有测试开关。部署前 sub-agent 独立审核了注入范围和收尾恢复条件。
3. 周次行先正常写回。训练行在 `location` 单元格写入并 flush 后主动中断：Worker 返回测试错误并保留 `FAILED` 批次与 `PENDING` outbox；签名只读检查确认 Google 行的 `location` 已是新值，`address` 与 `practice_version` 仍为旧值，Google 回执为 `PREPARED`。新请求使用**原 batch ID**补齐训练行并完成 B/C/G 检查。
4. 赛季批次随后在 Google 完成写入及 `VERIFIED` 回执后，临时测试脚本只对本次请求返回空响应。Worker 将其识别为 `BRIDGE_UNAVAILABLE`，保留失败批次；签名只读检查在重试前确认 Google `VERIFIED` 回执和目标赛季行。新请求沿原 batch ID 确认整个事件，未创建替代批次。
5. **先恢复**同一个隔离 Web App 部署到干净 v12，再把 Apps Script HEAD 恢复为相同源码。重新读取部署列表和 HEAD SHA-256 均通过。最终 `SEASON`、`SCHEDULE_TEMPLATE`、`TRAINING_WEEK`、`PRACTICE` 四类 B/C/G 零差异，`SEASON`／`MEMBER` 零差异；97 组基线、10 名成员、零开放冲突、零未完成批次／outbox。三张排期表为 1／2／2 行，公开训练仍为 0。再次创建、校验并私有下载 29 分块备份；每阶段 Coach 测试会话均已退出。

可复现的受控阶段见 [`live-c2-schedule-fault.mjs`](live-c2-schedule-fault.mjs)；临时生成器见 [`build-c2-schedule-fault-overlay.mjs`](build-c2-schedule-fault-overlay.mjs)。两者固定隔离主机／赛季，要求显式参数和仓库外私有凭据；脚本／部署 ID 放在忽略目录中的 `isolated-identities.json`，与私有 `.clasp.json`、桥接 URL 及 v12 SHA-256 交叉核对，不提交到 Git。生成器本身不部署。`npm test` 193／193、`npm run cf:test` 136／136 通过；Wrangler 写沙盒外日志的 `EPERM` 文本未改变退出码。

## 证据边界与后续

这是**受控故障注入**的真实 Worker ↔ Apps Script ↔ Google Sheet 验收，不等于实际网络随机断包或耗尽 Google 配额。Google 对人工编辑没有数据库级条件写入，极窄同时编辑窗口仍须在运维说明保留限制。多行 Worker 合并、报名／排座目标写回、C2.5 真实暂停恢复和同季独立冲突进展仍未完成；因此 C2.4、C2.5 完整阶段门槛和生产切换均未通过。
