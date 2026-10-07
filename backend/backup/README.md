# 隔离业务保护备份

此Node CLI用于当前c2test的受保护业务快照下载、原请求恢复和独立离线完整性核验，不部署、不登录、不恢复SQL或切换生产。它支持原schema14／47表及16／51表，保留原schema／manifest／chunks／payload摘要，不升级或裁剪源包。实际保护包、演练及云端恢复状态见[当前进度](../../CURRENT-STATUS.md)和[验证索引](../../tests/CURRENT-VERIFICATION.md#备份与恢复)。

## 私有配置

配置、凭据、checkpoint目录及保护包必须在仓库外，目录先由操作员设为仅当前用户、SYSTEM及Administrators可访问。工具只检查权限，不自动修正。Windows不可信ACE如可读写、删除／替换、修改权限或取得所有权均拒绝；所有父路径的symlink／junction及文件hardlink也拒绝。checkpoint目录必须预先存在且首次为空；输出位于另一个私有目录，不能覆盖已有文件。

首次只需两个JSON文件及两个空目录：

```text
D:\private-backup-20261004\
  credentials.json       # 私下填写当前C1 key与隔离session
  config.json            # 固定身份、schema、全新request与路径
  checkpoint\            # 首次为空；header／manifest／chunks由CLI生成
  output\                # 首次为空；protected-backup.json由CLI生成
```

`credentials.json`精确内容为以下两字段，值必须私下替换，不能将占位符当凭据执行：

```json
{
  "transport_key": "<PRIVATE_CURRENT_C1_TEST_KEY>",
  "session_token": "<PRIVATE_CURRENT_ISOLATED_COACH_SESSION_TOKEN>"
}
```

`config.json`完整模板见下文“仓库外配置精确字段”；若采用此目录，所有`D:\\private-backup`路径改为`D:\\private-backup-20261004`。模板展示schema16；工具也支持原schema14，但实际schema必须由当前受保护读取确认，不能因模板默认采纳；request_id每次新下载换全新随机值。不要自行创建header、manifest、chunk或保护包。下面安全准备脚本会生成两个JSON及空目录，避免手填session；它与手工准备模板二选一，不能在已经存在的目录再次运行。

### 首次准备（由操作员自行运行）

先向隔离环境管理员取得现有`C1_TEST_KEY`和隔离Coach Code，通过私密渠道保管。不要使用`C2_TEST_KEY`，也不要使用生产Pages登录的session；Cloudflare已保存的secret不能直接读回。没有这两项时只能准备目录，无法创建隔离session。下面脚本仅登录、受保护读取及创建私有配置；它不创建备份、不轮换Code或部署。请在本机普通PowerShell中运行，关闭transcript／调试或额外HTTP日志，不在聊天粘贴输入值。示例目录必须不存在；不要对已有目录直接重设权限。

本机专用c2test transport key来源是项目内 Git 忽略目录中的`D:\agents\dev-master\dragon-boat-training\.c2-form-test\worker-secrets.json`的`C1_TEST_KEY`字段；既有隔离验收使用同目录`acceptance.env`的`C1_TEST_KEY`，准备源为`private-test-config.json`的`c1Key`。隔离Coach Code来自同目录`review-private.json`的`coach_code`字段。只在本机私下取对应值供masked prompt，不复制文件内容到聊天。仓库`cloudflare/.dev.vars`属于原staging配置，不能替代专用c2test来源，其中的`C1_ACCEPTANCE_COACH_CODE`也不是c2test Coach Code；生产网页token不适用。本地保存的专用来源不证明当前云secret仍一致，必须由脚本固定目标的实际登录及受保护读取确认；若拒绝，联系隔离管理员核对当前配置，不能改目标或降低身份核验。

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File backend/backup/setup-private-config.ps1
# Optional fresh private directory:
powershell -NoProfile -ExecutionPolicy RemoteSigned -File backend/backup/setup-private-config.ps1 -PrivateDirectory 'D:\private-backup-fresh'
```

[准备脚本](setup-private-config.ps1)的`-PrivateDirectory`只接受规范的绝对仓库外新路径，拒绝.git祖先、reparse和已有目录，均在输入secret前检查。`RemoteSigned`只作用于这次PowerShell进程，不修改全局策略。固定的origin／team／instance／generation／epoch来自仓库隔离配置，必须先由管理员独立确认仍适用；失败不能直接把回包字段改成“允许值”。`get-operations`读取当前schema后仅允许14或16，最近10-01的14基线不是今天的状态证明。脚本有意创建新请求ID，登录也产生系统session／request记录；身份不符或响应丢失时不自动重试、不输出原HTTP错误。成功只返回`PRIVATE_BACKUP_CONFIG_READY`，默认配置位于`D:\private-backup-20261004\config.json`。如中途失败，可能留下私有文件；核对后用新的私有目录重新准备，不覆盖旧目录。CLI会在真正下载前再次核验私有路径、ACL、当前权限及固定身份。

随后从仓库根运行下文build与download命令；把目录路径替换为上述实际目录。若需要协助，只告诉助手`config.json`绝对路径，不能发送文件内容、Code或key。该路径不是让助手自动部署或轮换凭据的授权。

失败诊断只包含固定`phase`／`reason`，可选HTTP数字`status`及固定字段名`field`，不包含原HTTP正文、异常消息或字段值。`phase=PATH reason=EXISTING_DIRECTORY`表示目录已存在，在输入与网络请求前拒绝；使用未创建的新目录，保留旧目录与文件。`phase=LOGIN reason=HTTP_FAILURE status=403`表示登录的HTTP访问被拒绝，401表示认证拒绝，均需私下核对当前隔离key／Code。`IDENTITY_MISMATCH`仅报告不符的字段名，不能据此改变固定目标。需要协助时只反馈这条脱敏诊断；不要发送完整HTTP错误、凭据或截图中的输入。脚本与手工模板是两种准备方式，使用脚本时不先手工创建它的目标目录。

仓库外配置精确字段为：

```json
{
  "format": "c2-isolated-business-backup-v1",
  "server": {
    "origin": "https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev",
    "team_id": "pentasus-c2-test",
    "backend_instance": "dragon-boat-training-c2-test",
    "backend_generation": "cf-c2-isolated-1",
    "writer_epoch": 0
  },
  "schema_version": 16,
  "request_id": "backup_protection_20261004_0001",
  "credentials_file": "D:\\private-backup\\credentials.json",
  "store_directory": "D:\\private-backup\\checkpoint",
  "output_file": "D:\\private-backup\\output\\protected-backup.json"
}
```

示例generation／epoch／schema须由当前已核对的隔离身份填写，不能从待下载响应自动采纳；支持schema14或16。新下载使用未使用过的`request_id`，恢复保留原编号，复用旧编号可能取得服务器已有的旧快照。正式工具只允许此固定c2test origin、team与instance，拒绝生产、localhost及其他目标。凭据文件精确包含`transport_key`、`session_token`，由操作者私下填入当前授权值；不要在聊天、shell参数、仓库或日志中发送值。工具逐次重新读凭据，同一次受保护调用的前后Coach检查及调用本身使用同一份凭据，防止中间换成其他Coach。可刷新同actor的session；原actor／request／服务器身份与schema不能改变。

## 下载、恢复和离线核验

```powershell
npm run backup:business:build
npm run backup:business -- download 'D:\private-backup\config.json' --create-protected-snapshot
npm run backup:business -- resume 'D:\private-backup\config.json'
npm run backup:business -- verify 'D:\private-backup\output\protected-backup.json' '<independently retained sha256_v1:digest>'
```

`download`显式创建受保护系统快照，产生backup、原请求、审计及finalize job记录；不修改训练等业务实体。先当前Coach bootstrap及schema核验，再按现有team／actor／action／request规则计算原snapshot ID，持久保存`header.json`，之后才调用create。首次可信bootstrap的`meta.server_time`固定为`capture_not_before`，manifest原`created_at`须不早于此下界、不晚于已核验服务回包时间；日期必须是有效UTC毫秒ISO时间，缺失或不规范即拒绝，绝不以本机时间替代。旧请求回放出的较早快照不能作为本次新保护包成功发布。创建回复丢失时`resume`沿原时间下界及原actor／request／schema，不换编号、刷新下界或另建快照；旧header缺少时间下界、schema／generation／epoch／service version／actor变化均停止。系统请求与Google写入无关，不能把创建快照描述成完全无副作用的只读操作。

`manifest.json`、按ordinal保存的`chunk-000000.json`等原checkpoint文件只写一次，恢复核对原manifest、snapshot ID、序号／表／offset、行数、列与payload摘要。旧快照被时间下界拒绝时可留下原header，但不会保存manifest／chunks或发布保护包；不能编辑header或补时间强行恢复，真正新下载使用新的请求与空checkpoint目录。串行HTTPS请求禁止redirect和自动retry，每次30秒deadline覆盖stream读取，回包最多2,000,000字节；包最多30,000,000序列化字节、payload合计29,000,000字节、chunk最多10,000。合法包超过工具预算会整包拒绝，不能截断。身份或权限拒绝不输出原依赖正文或凭据。

工具独立复算完整manifest／全部chunk摘要，核验完整47／51表顺序、列白名单、计数及app_meta原schema，再复核远端摘要、当前权限及schema。全部通过后才原子发布新保护包；使用临时文件和原子no-replace链接，不能覆盖目标。异常中断可能留下私有临时文件、lock或未确认链接，须核对活动进程／原路径后处理，工具不抢锁或自动删记录强行恢复。已经发布且丢失本地成功输出时，`resume`只核对原包，不覆盖。

stdout仅输出阶段、snapshot、原快照时点`captured_at`、schema／表／行／块计数及content digest；错误固定`BUSINESS_BACKUP_UNCONFIRMED`。`captured_at`是该包的原始时点，不证明下载完成时仍是服务器最新状态，离线verify也不判断当前新鲜度；恢复与handoff仍需后续写入隔离及差异核对。业务包保留迁移必要的Coach salt／digest及业务／审计／请求事实，不包含coach_sessions、backup自身两表、明文Code／session／OAuth secret或独立私有来源原文。

`verify`完全离线，要求显式提供从可信流程独立保管的预期content digest；不会把包自报摘要或远端`verified=true`当成真实性证明。它校验词法JSON、decoded重复key、Unicode／深度／预算、完整表清单／ordinal／数量及摘要，每个已有行必须满足该schema的完整列白名单；空表包没有DDL，不据此证明源端表定义。摘要相符只证明这些字节的完整性，不能证明远端身份、Google来源、SQL FK／CHECK可恢复或年度资格。保护包必须在后续独立隔离SQLite恢复中接受真实FK／CHECK／索引与逐行回读；配置RecoveryRuntime固定可信digest的步骤见[恢复指南](../../cloudflare/ISOLATED-RECOVERY.md)。

## 真实原包的本地SQLite演练

当前真实原14／47表包已使用[独立演练harness](../../tests/original-backup-local-drill.mjs)调用当前生产`restoreBusinessBackup`，在本地Miniflare SQLite恢复并逐行核对；证据见[验证索引](../../tests/CURRENT-VERIFICATION.md)。原包保持14及原摘要，恢复目标仅`app_meta.schema_version`升至16，新年度3表及pin为空，旧sessions与备份两表也为空。当前受审DDL的列／FK／index oracle、实际CHECK／PK／FK拒绝及原seal／重复恢复拒绝通过。该演练不执行云端Coach鉴权、Service Binding或在线激活，不证明远端DDL／冻结、来源资格或Free资源。

复用时，独立固定预期digest及原私有`trusted-backup-receipt.json`，由操作员在已核验的私有父目录下预先创建一个全新空目标；不能重用已有成功演练目录。receipt的`expected_content_digest`和snapshot／时点／schema／计数须与已核验原包完全一致，不能从待验包自动生成“可信”预期值。随后从仓库根执行：

```powershell
node tests/original-backup-local-drill.mjs 'D:\private-backup\output\protected-backup.json' '<independently retained sha256_v1:digest>' 'D:\private-backup\output\trusted-backup-receipt.json' 'D:\private-backup\recovery-drill-fresh'
```

harness拒绝非私有或非空目标，只在目标中保存SQLite／cache和no-overwrite的`redacted-summary.json`；网络外发被拦截且成功要求计数为0，不打印业务行或凭据。失败不清空旧目标，重新演练必须另外准备全新私有目标，不能覆盖原包、receipt或成功结果。已确认的原演练结果继续私有保存，不覆盖重跑。

## 首次升级的离线对账

[对账工具](reconcile.mjs)仅用于固定 c2test 的首次14→16发布。两份保护包各自先下载、独立保存可信摘要并离线核验；发布前登录，同一会话贯穿两次快照，发布后快照完成才退出。两次快照间不能登录、退出、轮换、调用Google或编辑业务。两次时点须相隔小于等于一小时，队列先排空；该流程不是并发写入冻结协议，其他写入或usage／既有任务变化会使对账拒绝，须保留现场调查。

在仓库外私有文件保存精确上下文：`actor_id`为发布前受保护核验的当前Coach，`backup_request_id`为发布前快照的原请求，`generation="cf-c2-isolated-1"`、`writer_epoch=0`。上下文、原包及独立摘要不能从待验包自动采纳。

```powershell
npm run backup:business:build
npm run backup:reconcile:bootstrap -- 'D:\private-release\before\protected-backup.json' '<independently retained before digest>' 'D:\private-release\after\protected-backup.json' '<independently retained after digest>' 'D:\private-release\reconciliation-context.json'
```

工具核验原47表全部行的重复计数，仅允许`app_meta.schema_version`从14变为16；新4表必须为空。新增记录严格限制为发布前快照自身的一个COMPLETED请求、一个关联审计、一个已完成finalize job，核对原actor／request／snapshot、原manifest、任务payload和时间范围，其他业务或系统变化拒绝。stdout只输出计数、摘要和资格边界，不输出原行；固定失败码为`BOOTSTRAP_RECONCILIATION_UNCONFIRMED`。它完全离线，不核验云端namespace、sessions、secret或DDL，不代替发布前原包SQLite演练与发布后受保护路由／配置检查。
