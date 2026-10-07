# C2.6 独立来源 OAuth 配置与验收入口

更新：2026-10-03。此入口仅供本机隔离来源验收，不进入 Apps Script／Worker 构建，不替换 clasp 默认账号，也不授权年度导出或生产切换。

有效授权／隔离读取证据见[验证索引](CURRENT-VERIFICATION.md#来源采集与审核)。已有授权不证明 token 当前仍有效，执行前核对实际身份与权限。

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

OAuth专项6项覆盖项目／endpoint fence、完整grant、state／重复code拒绝、仓库内／相同文件及实际parent／junction与路径别名拒绝、无真实ID／错误正文泄漏的能力探测。当前项目验证见[验证索引](CURRENT-VERIFICATION.md)。直接声明已存在且锁定的 `google-auth-library` 10.5.0，没有更换其锁定版本。真实Google授权回调、令牌保存和后续新进程API调用已确认通过。

上述API能力、隔离读取、私有journal及本机原operation／candidate／receipt恢复已有实际验收。业务会话／binding／census、私有runtime／审核和Cloudflare双向运行入口／OAuth refresh已有本地验证，Google为受控模型；真实云授权、实际服务器capture、原生Tab实际观察及新capture消费仍需独立验收。云端secret与管理员门槛见[当前指南](../cloudflare/ISOLATED-RECOVERY.md#隔离发布顺序)。OAuth工具只配置API用户授权，不替代Coach身份或业务source receipt；来源`SOURCE_NOT_VERIFIED`，年度false。
