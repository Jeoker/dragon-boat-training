# C2.2 Form 稳定来源导入：本地实现记录

日期：2026-09-25。状态：**本地实现与模拟桥接回归通过；C2.2 隔离 Google／远端验收未完成。** 已部署 staging 仍为 C1.6；生产 Apps Script／Sheets、Pages API 地址与写入归属均未改变。

## 已实现的边界

- 正式 Apps Script 源码新增受签名保护的只读 `cloudflareReadFormResponses`。脚本核对团队、代次、赛季绑定版本、Form ID、响应 Spreadsheet 目的地及姓名题目映射；以 `FormResponse.getId()`、提交时间和 `(时间, ID)` 游标返回最多 100 条。C0 独立探针构建不包含此路由。
- Cloudflare C2 导入动作读取当前赛季绑定；严格核对桥接响应范围、顺序和游标。在一个 SQLite 事务中提交成员、稳定来源映射、来源观察／核查、游标和不可变导入回执。批次失败或绑定／游标在读取期间变化时不提交。成功但结果丢失时，同一请求编号重放不可变结果。
- 新 Form 回答可生成本季成员，现有 Form 来源更新来源姓名而保留管理员覆盖姓名；`MEMBERS_IMPORTED` 每个变化批次只产生一个待同步事件，**不确认或消费 Google outbox**。重名旧成员、缺名、截止后回答，以及首次历史补扫中存在未关联旧成员的回答进入人工核查。Coach 显式确认时保留旧 `member_id`，不能仅凭姓名合并。
- staging 配置包含十分钟轮询入口，但 `C2_FORM_POLL_ENABLED=false`，production 也固定关闭；每轮最多处理四个绑定赛季。启用前必须完成下述隔离验收。

## 本地证据

`npm test`：189／189；`npm run cf:test`：77／77；`npm run cf:check`、`npm run build:backend`、`npm run build:bridge-probe`、`npm run build`、`npm run cf:dry-run` 均通过。模拟桥接测试覆盖签名分页、同一时间多回答、重叠补扫、失败批次游标不推进、旧行不同名时核查、Coach 手动关联、重复请求、v7→v8 原地升级。dry-run 只构建本地包，没有远端部署。

## 仍需完成的 C2.2 验收

1. 用**独立测试** Apps Script／Google Form／响应 Sheet 核对真实 `FormApp.getResponses(Date)` 边界、`FormResponse.getId()`、题目映射、Form 目的地及 Web App 权限；不得指向生产文件。配置、测试数据、预期结果和清理归属先核对，不在文档或仓库写入私有 ID、secret 或 Code。
2. 建立并验证真实 `onFormSubmit` 通知路径。当前本地实现只有有界周期补扫，没有事件触发通知；模拟重复读取只能证明导入幂等，**不能**替代触发器与补扫同时到达的真实验收。触发器需按赛季绑定路由，失败由补扫恢复。
3. 在隔离 staging 明确启用轮询后，验证实际十分钟调度、远端 DO 持久化、网络失败后补扫、重复回答、同时间分页及管理员核查。期间保持 `writer_epoch=0`、Pages 不切换、Google outbox 不消费；通过后才更新本报告与当前进度。

后续 C2.3 才开始 Sheet 人工修改差异；本切片不能声称双向 Google 同步已经工作。
