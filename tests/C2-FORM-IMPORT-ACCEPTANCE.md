# C2.2 Form 稳定来源导入：本地实现与隔离连接验收

日期：2026-09-25 至 26。状态：**独立 Google→Cloudflare 手动拉取与真实 Form 提交触发验收通过；十分钟调度、失败恢复和完整 C2.2 验收仍未完成。** 已部署的原 staging 仍为 C1.6；生产 Apps Script／Sheets、Pages API 地址与写入归属均未改变。

## 隔离连接与范围（2026-09-25）

- 使用项目所有者的个人 Google 账号创建了全新的 `Dragon Boat C2 Form Import Isolated Test` Apps Script 项目；与既有 C0 无 Form 探针分离。完整后端构建及仅用于此项目的幂等 fixture 辅助函数已推送。测试源码、本地 `.clasp.json` 和全部私有配置位于仓库外 `D:\agents\dev-master\.c2-form-test`；`rootDir=source` 已核对只推送三个源码文件，不上传私有配置。
- 项目所有者亲自完成 Google 首次授权，并明确批准匿名测试 Web App 和独立 `workers.dev` 测试 Worker 的部署。测试脚本创建私有 Form、系统 Sheet 和响应 Sheet；先提交两条虚构姓名回答，桥接连通后再提交第三条。浏览器执行日志分别确认回答数 2 和 3。`clasp run` 的默认 GCP Execution API `NOT_FOUND` 仍不可作为函数执行证据。
- 独立 Apps Script Web App 已部署为版本 1，匿名健康 GET 返回 JSON 200。`cloudflareReadFormResponses` 必须通过项目所有者亲自配置的签名密钥验证；其他公开路由也只能接触此项目的测试文件。私有文件 ID、密钥和 Code 不写入仓库。Web App 仍是可匿名调用的测试入口，阶段结束时应决定保留或撤下。
- Cloudflare `c2test` Worker／SQLite DO 已单独部署，提交通知版 Worker 版本 `62d1fc36-8cf3-4cf9-94e8-4d81e7cb61ba`，`writer_epoch=0`、无 cron、`C2_FORM_POLL_ENABLED=false`。六项私有 Worker 配置（含桥接 URL 与随机密钥）在首次部署时通过仓库外文件上传；健康接口返回 200，缺少 C2 Key 的内部请求返回 403。既有 C1.6 staging 部署版本仍为 `18b0e059-2f76-4627-9528-d75bab44e465`；生产和 Pages 均未切换。

## 真实 Google→Cloudflare 验收

- [验收脚本](live-c2-form-acceptance.mjs)硬性限制测试 Worker 主机并要求 `--write-test-data`；绑定信息和密钥由仓库外 `acceptance.env` 提供。初始两条真实 Form 回答按 `limit=1` 分两页导入，各创建一名成员；同一请求编号重放结果不变，24 小时重叠补扫返回两条未变来源。受保护的公开名单读取恰好是 Alpha、Beta 两名虚构成员，稳定成员 ID 不重复。
- 在已经完成首次扫描后，测试脚本从 Form 再提交 Gamma；以 `--verify-incremental` 运行新增请求，仅创建一名成员，后续重叠补扫把三条均识别为未变。原请求与新增请求再次重放，名单仍恰好三人。这个真实链路同时验证了 Web App 权限、Form 目的地、姓名题目映射和回答稳定 ID；**没有**验证相同毫秒提交时间、网络中断、真实触发器或定时器。

## 已实现的边界

- 正式 Apps Script 源码新增受签名保护的只读 `cloudflareReadFormResponses`。脚本核对团队、代次、赛季绑定版本、Form ID、响应 Spreadsheet 目的地及姓名题目映射；以 `FormResponse.getId()`、提交时间和 `(时间, ID)` 游标返回最多 100 条。C0 独立探针构建不包含此路由。
- Cloudflare C2 导入动作读取当前赛季绑定；严格核对桥接响应范围、顺序和游标。在一个 SQLite 事务中提交成员、稳定来源映射、来源观察／核查、游标和不可变导入回执。批次失败或绑定／游标在读取期间变化时不提交。成功但结果丢失时，同一请求编号重放不可变结果。
- 新 Form 回答可生成本季成员，现有 Form 来源更新来源姓名而保留管理员覆盖姓名；`MEMBERS_IMPORTED` 每个变化批次只产生一个待同步事件，**不确认或消费 Google outbox**。重名旧成员、缺名、截止后回答，以及首次历史补扫中存在未关联旧成员的回答进入人工核查。Coach 显式确认时保留旧 `member_id`，不能仅凭姓名合并。
- staging 配置包含十分钟轮询入口，但 `C2_FORM_POLL_ENABLED=false`，production 也固定关闭；每轮最多处理四个绑定赛季。启用前必须完成下述隔离验收。
- 新增 Google Forms 可安装触发器处理函数和独立安装函数。通知含 Form 回答稳定 ID、赛季与绑定版本、时间戳和随机数，用既有 Google 桥接密钥签名；Worker 在进入 DO 前验证签名、团队、代次和时间窗，DO 再核对当前绑定并按既有事务拉取回答。production C2 路由仍返回 404，正式旧 Spreadsheet 触发器不变；只在独立测试 Form 安装了一个新触发器。

## 真实提交通知验收（2026-09-26）

- 新通知代码已推送到独立 Apps Script 项目，`c2test` Worker 已部署。未签名的远端通知返回 HTTP 403／`FORM_NOTIFICATION_INVALID`；[验收脚本](live-c2-form-trigger-acceptance.mjs)在真实表单 UI 提交前确认 DO 名单仍为 Alpha、Beta、Gamma 三人，十分钟补扫关闭。
- 项目所有者自行完成 Google 新权限授权后，在编辑器运行 `installC2IsolatedFormSubmitTrigger`；执行日志显示安装成功，Triggers 页确认**只有一个** `From form - On form submit → handleCloudflareFormSubmit`。`clasp run` 的 Execution API `NOT_FOUND` 不作为安装证据。
- 从 Form 的**正式 responder link** 而非无法提交的预览页，手动填写并提交虚构的 Delta；页面显示“您的回复已记录”，Form 回答数从三变四。Apps Script Executions 页记录 `handleCloudflareFormSubmit` 的 `Trigger` 执行 `Completed`，其 Cloud logs 明确记录 `form_notification: acknowledged`、`pages: 1`；同一时段还有 `doPost` Web App 读取完成。
- 提交后、任何手动拉取前，受保护的 Worker 名单读取已由三人变四人，四个稳定成员 ID 不重复；由于 `c2test` 没有 cron，且该期间没有手动拉取，这一新增来自真实触发通知。之后显式执行一次 24 小时重叠补扫，`created=0`、`unchanged=4`，相同请求编号重放结果一致。第一次只读验收因脚本误按提交顺序断言姓名而报错；接口实际按姓名排序，改为集合比较后通过，未为此重新提交表单。

## 本地证据

`npm test`：189／189；`npm run cf:test`：79／79；`npm run cf:check`、`npm run build:backend`、`npm run build:bridge-probe`、`npm run build`、`npm run cf:dry-run` 均通过。模拟桥接测试覆盖签名分页、同一时间多回答、重叠补扫、失败批次游标不推进、旧行不同名时核查、Coach 手动关联、重复请求、v7→v8 原地升级；新增测试验证提交通知签名、范围、时效和无签名拒绝。dry-run 只构建本地包；真实部署仅限上述独立 `c2test`。

## 仍需完成的 C2.2 验收

1. 已验证独立测试 Form 的正常分页和增量读取；仍需专门核对**相同提交时间边界**、Google 请求失败或超时后的游标不推进、真实 DO 跨部署保留，以及远端旧成员歧义的管理员核查。不得指向生产文件或在文档／仓库写入私有 ID、secret 或 Code。
2. 在专用 `c2test` 明确启用轮询后，验证**实际十分钟调度**、通知或网络失败后补扫，以及与触发器接近同时重复到达；随后才评估原 staging。当前真实触发后手动补扫通过，不等于定时器竞态通过。期间保持 `writer_epoch=0`、Pages 不切换、Google outbox 不消费。

后续 C2.3 才开始 Sheet 人工修改差异；本切片不能声称双向 Google 同步已经工作。
