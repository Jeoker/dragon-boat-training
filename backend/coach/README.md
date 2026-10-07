# Cloudflare Coach自轮换

服务与私有CLI仅处理当前Cloudflare Coach自身凭据，不能轮换其他Coach、生产Apps Script Code、transport key或服务secret。实际发布、真实轮换及Git凭据历史处理状态见[当前进度](../../CURRENT-STATUS.md)。

## 服务协议

三个C1 POST入口都要求C1 transport gate及当前有效Coach session。`prepare-coach-code-rotation`接受request_id、session_token、expected_credential_version、new_code，仅校验并返回coach_id／原version／payload_digest，不写系统表。`rotate-coach-code`另要求prepare的expected_payload_digest；没有客户端coach_id字段，只能轮换当前actor。`get-coach-rotation-receipt`接受当前session、独立读取request_id、rotation_request_id、原expected_credential_version、同new_code和expected_payload_digest，只读取原receipt。

new_code要求16至128个无空白的ASCII可打印字符，应由私有密码管理器生成强随机值。服务生成随机salt，使用既有COACH_CODE_SECRET HMAC凭据摘要；同原Code及其他Coach现Code均拒绝（包括inactive Coach保守拒绝）。prepare的稳定payload_digest包含服务HMAC指纹，不是裸Code摘要。交易重验当前session、原version及全部Coach凭据census，CAS递增version一次，原子撤销自身全部旧sessions（包括发起session），再写原请求／receipt／audit。仅Coach salt／digest／version／updated_at、sessions、请求与audit变化；认证专用login／logout／rotate均不触发业务job／usage修补，已有alarm正常管理。其他Coach、业务实体、pin／原actor不变，不触发Google写入。轮换audit属于年度capture的operational排除动作。

原Code及原session立即无效。未知轮换回复不能用旧session重试或无鉴权读取receipt；须同new_code重新登录，再以当前新session、原request和同payload读取原receipt。当前version不再是原version＋1、session撤销或过期、payload变化均拒绝。login持久metadata不含session token，确认读取不写audit。

业务job／usage不由认证请求修补的保证针对对象初始化后的请求handler；对象构造及已有alarm继续正常维护，其他业务写入仍正常修补。运维冻结与并发alarm／写入控制须在实际运行门槛中另行完成。

## 私有CLI

先按[保护备份指南](../backup/README.md)取得当前受保护包并独立核验，保管可信digest。保护包必须包含该Coach原version且与配置schema一致，不能用一个自报摘要文件代替可信保护。所有路径均仓库外私有，目录权限由操作者设置；CLI复用严格ACL、ancestor link／hardlink拒绝及无覆盖发布，不自动修正权限。新Code文件精确为`{"new_code":"<PRIVATE_RANDOM_NEW_CODE>"}`，占位符必须私下替换，不能把真实Code发到聊天、shell参数、仓库或日志。

轮换配置完整字段如下；身份、actor、version、schema及digest均须独立核对，不从错误回包自动采纳：

```json
{
  "format": "c1-self-coach-rotation-v1",
  "server": {
    "origin": "https://dragon-boat-training-api-c2-test.dragon-boat-training.workers.dev",
    "team_id": "pentasus-c2-test",
    "backend_instance": "dragon-boat-training-c2-test",
    "backend_generation": "cf-c2-isolated-1",
    "writer_epoch": 0
  },
  "schema_version": 16,
  "coach_id": "<CURRENT_COACH_ID>",
  "expected_credential_version": 1,
  "request_id": "<FRESH_UNUSED_REQUEST_ID>",
  "credentials_file": "D:\\private-rotation\\credentials.json",
  "new_code_file": "D:\\private-rotation\\new-code.json",
  "protection_file": "D:\\private-backup\\output\\protected-backup.json",
  "protection_digest": "<INDEPENDENTLY_RETAINED_sha256_v1_DIGEST>",
  "store_directory": "D:\\private-rotation\\checkpoint",
  "output_credentials_file": "D:\\private-rotation\\output\\new-credentials.json"
}
```

credentials输入文件是现行授权的`{transport_key,session_token}`；output位于另一个私有目录，绝不覆盖原文件。checkpoint首次必须存在且为空。运行：

```powershell
npm run backup:business:build
npm run coach:rotate -- rotate 'D:\private-rotation\config.json' --rotate-own-coach-code
npm run coach:rotate -- resume 'D:\private-rotation\config.json'
```

CLI固定唯一c2test目标；逐响应核验generation／epoch／service version／request等元数据，30秒deadline、100,000字节响应预算，拒绝redirect，无自动retry。独立核验保护包后，核当前actor／version／schema，prepare原payload，持久写一次header.json，之后最多提交一次rotate。header固定原config、actor、version、服务指纹、service version与派生login请求，不含Code／token或可离线猜解的裸CodeSHA；Code每次重读并在本次调用内保持一致。保护包完整性不证明来源或当前最新业务状态，实际运行前仍需业务冻结与差异核对。

成功也须new_code固定login请求→新session→受保护原receipt→当前actor／version／schema复核。receipt.json保存原结果，另私有new-credentials.json保存新session。stdout仅COACH_CODE_ROTATION_CONFIRMED与actor／请求／version／时间，错误固定COACH_CODE_ROTATION_UNCONFIRMED，不输出Code、token或原HTTP正文。

header存在即表示原mutation可能执行，resume仅确认，不再次rotate；即使第一次请求未到服务，也保持UNKNOWN。读取header时按原actor／request／服务payload指纹重新计算派生login编号，不匹配在HTTP前拒绝且不自动修复。若new_code登录失败、固定login的session已过期／撤销、输入改变或后续又发生轮换，停止并由管理员核对；不能换编号、编辑header或自动回旧Code重新轮换。丢login回复可重放原login请求，confirmed receipt与输出原字节只核对不覆盖；receipt三层字段精确校验，额外Code／token字段拒绝写入checkpoint。锁／临时文件故障处理遵循保护备份指南，不抢锁或强行覆盖。

## 真实执行顺序

实际路由、远端schema与待执行顺序统一见[当前进度](../../CURRENT-STATUS.md)和[隔离发布指南](../../cloudflare/ISOLATED-RECOVERY.md#隔离发布顺序)。本工具要求新业务路由及匹配当前schema／Coach version的保护包；不部署或代替原包恢复演练。Cloudflare真实轮换、生产Apps Script凭据和Git历史分别处理。
