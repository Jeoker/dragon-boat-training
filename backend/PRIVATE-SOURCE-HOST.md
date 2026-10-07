# 私有来源本地运行入口

日期：2026-10-04。此入口是可信操作员使用的一次性 Node CLI，没有 HTTP 监听、后台轮询或自动调度。长期运行采用已确定的 [Cloudflare 私有组件](../cloudflare/PRIVATE-SOURCE-HOST-DESIGN.md)，本地工具不要求购买服务器或保持电脑长期在线。

## 配置与权限

先在仓库外准备私有目录。配置、当前服务器凭据、原 Google OAuth client／token 和 operation store 均不能放在仓库内；四个输入文件必须互不相同。POSIX 文件／目录只允许当前用户访问；Windows拥有者须为当前进程用户、SYSTEM或Administrators。不可信主体的可读写、删除替换、写属性、修改DACL或取得所有权权限均拒绝，包括仅ChangePermissions／TakeOwnership而尚无ReadData的ACE。工具检查现有权限，不自行调整；运行账号改变时需由管理员重新核对。

不接受仓库路径、符号链接／junction 或通过别名解析到仓库的路径。权限在实际读取与 CAS 时重查，不缓存以前的允许结果。这些检查用于可信本机环境，不能宣称防御同机管理员或所有并发路径替换。

配置文件精确包含以下字段，示例只有占位值：

```json
{
  "format": "c2-private-host-v1",
  "server": {
    "origin": "https://isolated-worker.example.com",
    "team_id": "TEAM_FROM_ISOLATED_CONFIG",
    "backend_instance": "INSTANCE_FROM_ISOLATED_CONFIG",
    "backend_generation": "GENERATION_FROM_ISOLATED_CONFIG",
    "writer_epoch": 0
  },
  "request_id": "ONE_FIXED_REQUEST_ID",
  "season_id": "ISOLATED_SEASON_ID",
  "credentials_file": "D:\\private-source\\credentials.json",
  "store_directory": "D:\\private-source\\records",
  "oauth": {
    "project_id": "your-google-project",
    "client_file": "D:\\private-source\\oauth-client.json",
    "token_file": "D:\\private-source\\oauth-token.json"
  }
}
```

服务器凭据文件只含 `transport_key` 和 `session_token`，由管理员私下注入，不放在命令行或聊天。每次服务器权威检查重读文件；Coach 会话失效后拒绝后续访问。服务器 origin 必须是精确 HTTPS origin，禁止跳转；当前客户端只接受隔离 staging 环境及匹配的服务器身份，不用于现行生产 Apps Script。

OAuth 继续使用 [独立本地授权工具](source-journal/oauth-local.mjs) 的项目与 client／token 校验。授权和 API 启用需要 Google 账号管理者操作；配置校验成功不能替代 Google 权限、原生响应 Tab 关联或来源完整性验证。

## 执行顺序

在仓库根目录先运行 `npm run source:host:build`，以正式 TypeScript 编译器生成被 Git 忽略的 `backend/.private-host/`。修改来源组件后重新构建；不要把测试 transpiler 当作生产运行入口。下列 PowerShell 变量只指向仓库外文件路径：

```powershell
$taskSourceConfig = 'D:\private-source\config.json'
npm run source:host -- validate $taskSourceConfig
npm run source:host -- pin-export $taskSourceConfig 'D:\private-source\pin.json'
```

`validate` 只确认私有配置和当前服务器权威，返回 `PRIVATE_HOST_CONFIG_AND_AUTHORITY_READY`，不读取 Google。管理员从私有 pin 文件取得原 `source_operation_id`，准备目标 JSON，精确包含 `source_operation_id`、`attempt_id`、`api_user_permission_id`、`owner_permission_id`、`journal_spreadsheet_id`、`journal_sheet_id`。目标必须来自已核对的隔离权限和 journal，不可猜测；首次登记后不可替换。

```powershell
npm run source:host -- register $taskSourceConfig 'D:\private-source\target.json'
npm run source:host -- capture $taskSourceConfig
npm run source:host -- stage $taskSourceConfig --write-private-journal
npm run source:host -- resume $taskSourceConfig
npm run source:host -- review-export $taskSourceConfig 'D:\private-source\review.json'
npm run source:host -- review-append $taskSourceConfig 'D:\private-source\command.json' --append-private-review
```

`capture` 读取来源并持久化原候选。`stage` 是对原固定私有 Google journal 的写入，显式确认参数不可省略。`resume` 恢复原 operation 的 journal 状态，不自动新建目标或替换未知操作。`review-export` 只提供已确认 journal 的原候选；`review-append` 只追加 [现行审核协议](../tests/C2-SOURCE-MAPPING-REVIEW-DESIGN.md) 允许的 command，不接受浏览器指定 actor 或年度授权。登记、采集、审核均继续使用同一份固定 request 配置。

本Node CLI没有`capture-native`命令，`capture`保持`SERVER_BINDING_DECLARATION_ONLY`；原生证明由Cloudflare显式命令从可信业务SourceAuthority消费，不能把独立观察JSON手动填入本地候选来升级。新原生候选恢复须保留完整私有DO／backup的原观察与receipt，Google journal core单独不足以恢复证明。协议见[新capture消费说明](../cloudflare/ISOLATED-RECOVERY.md#新capture消费原生证明)。

stdout 只输出阶段／版本和状态元数据，错误统一 `PRIVATE_HOST_UNCONFIRMED`。pin／审核全文仅写入新的仓库外私有文件，不覆盖现有文件；输出失败可能留下未完成的新文件，须人工检查，不能作为确认结果。原回答、凭据和私有文件 ID 不进入 stdout。

## 中断、恢复与停止

一次命令结束即停止，不安装常驻服务。每次操作使用 `store_directory/host.lock` 排他运行，正常退出删除本次锁；异常终止可能留下锁，下一次运行停止，不自动抢锁。操作员须核对锁中 PID 和该目录是否仍被任何进程使用，确认无活动操作后才移除这一个锁。不要删除整个 store 或已持久化 JSON 来强行恢复。

恢复时使用同一 config、原 request、原 target 和原 store 重启命令。已保存来源块和候选复用；未知请求保持未确认，不自动重新采集。当前权限撤销或服务器身份／绑定变化会停止访问。文件 CAS 与 Google 访问不是同一事务，不能承诺断电原子性、多机高可用或全部恢复故障已经实际验收。

## 当前验证范围

完整本地 CLI 组合使用虚构 Google／服务器响应；真实独立 Node 进程恢复原候选且零 Google／OAuth 重读、当前凭据拒绝、固定目标不变、锁冲突、动态 ACL 变更、配置拒绝和私有输出不覆盖已验证。当前没有用此 CLI 执行真实服务器 capture、journal stage 或审核追加；这些仍属第 3 至第 4 步的隔离验收。已有 [私有审核组件验收](../tests/CURRENT-VERIFICATION.md#来源采集与审核) 保留原范围，不由本入口自动提升。

全部结果继续保持 `SOURCE_NOT_VERIFIED` 和 `annual_export_authorized=false`。本地入口不构成远端部署、Coach 审核 UI 或生产迁移完成。
