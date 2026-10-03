# C2.6 独立来源 OAuth 配置与验收入口

更新：2026-10-03。此入口仅供本机隔离来源验收，不进入 Apps Script／Worker 构建，不替换 clasp 默认账号，也不授权年度导出或生产切换。

## 当前证据

用户提供测试Cloud项目 `dragon-boat-source-test`、仓库外客户端JSON，并完成浏览器授权。程序已核对desktop类型、project_id、Google endpoint和实际token audience／四项scope，refresh token已保存；未打印客户端ID、secret或令牌。

新客户端实测Forms／Sheets固定不存在ID返回404、Drive身份读取200；随后既有隔离Form／Spreadsheet／数字response Tab真实读取和新私有journal验收通过。原 `SERVICE_DISABLED` 属于旧clasp客户端。完整证据和未核验边界见[2026-10-03真实验收](C2-SOURCE-JOURNAL-ISOLATED-ACCEPTANCE-2026-10-03.md)。

## 本地命令

先在 Google Auth Platform 配置测试用户和所需 scopes；创建 Desktop app 客户端，下载 JSON。客户端和token必须使用仓库外的不同绝对路径。Windows环境应将环境目录设置为仅本机用户可访问；POSIX临时token文件以0600创建。客户端JSON与token均不得提交Git或粘贴到日志／聊天。

```powershell
npm run source:oauth -- login "<客户端JSON绝对路径>" "<独立tokenJSON绝对路径>" dragon-boat-source-test
```

打开输出的 `http://127.0.0.1:<随机端口>/authorize`，由系统浏览器进行Google登录。监听仅绑定127.0.0.1，使用随机state、PKCE S256和15分钟等待上限；回调不显示authorization code或token。拒绝、state不符、重复code、grant audience或scope缺失不能生成已授权结果。认证成功后，在外部目标目录以临时文件原子替换独立token文件，不写入客户端secret。

四个固定 scopes：`forms.body.readonly`、`forms.responses.readonly`、`spreadsheets`、`drive.metadata.readonly`，共同前缀为 `https://www.googleapis.com/auth/`。Sheets需写私有journal；Drive仅读取元数据／权限，不请求 broad Drive 内容读写。Scopes不等于只授权某一个Spreadsheet，真正文件范围须由隔离调用方固定。测试应用refresh token可能七天后失效，届时重新执行login；参见[Google本地OAuth协议](https://developers.google.com/identity/protocols/oauth2/native-app)及[令牌失效条件](https://developers.google.com/identity/protocols/oauth2#expiration)。

```powershell
npm run source:oauth -- probe "<客户端JSON绝对路径>" "<独立tokenJSON绝对路径>" dragon-boat-source-test
```

probe先检查token所属client和完整scope，再对Forms／Sheets固定不存在ID发只读GET，Drive只读取API用户permissionId并丢弃正文。输出仅含API名称、HTTP状态和白名单原因码；404可以作为非真实文件的可用性证据，403需核清原因，不能把所有403解释为未启用。任何结果均不证明实际来源文件可读或源内容已捕获。

## 本地验证与下一步

OAuth专项5/5：项目／endpoint fence、完整grant、state／重复code拒绝、仓库内／相同文件目标拒绝、无真实ID／错误正文泄漏的能力探测。10-02当时完整Node414/414；10-03后的最终项目计数见最新真实验收。直接声明已存在且锁定的 `google-auth-library` 10.5.0，没有更换其锁定版本。真实Google授权回调、令牌保存和后续新进程API调用已确认通过。

上述API能力、隔离来源读取、私有journal和本机原operation／candidate／receipt恢复已有实际验收。随后业务会话／服务器binding／census、内部HTTP与私有runtime、认证原候选读取和持久审核CAS已有[本地验收](C2-PRIVATE-SOURCE-REVIEW-LOCAL-ACCEPTANCE-2026-10-03.md)，长期host、实际服务器capture和可信native Tab仍需独立验收。提交前review另补实际parent／junction与路径别名检查，OAuth专项现为6项；历史5／5及414计数保留，最新项目基线见[最终review](C2-COMMIT-REVIEW-2026-10-03.md)。该OAuth工具只配置API用户授权，不替代Coach身份或业务source receipt；来源状态继续 `SOURCE_NOT_VERIFIED`，年度导出false。
