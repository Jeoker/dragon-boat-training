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
  "expected_credential_version": 2,
  "request_id": "<FRESH_UNUSED_REQUEST_ID>",
  "credentials_file": "D:\\private-rotation\\credentials.json",
  "new_code_file": "D:\\private-rotation\\new-code.json",
  "protection_file": "D:\\private-backup\\output\\protected-backup.json",
  "protection_digest": "<INDEPENDENTLY_RETAINED_sha256_v1_DIGEST>",
  "store_directory": "D:\\private-rotation\\checkpoint",
  "output_credentials_file": "D:\\private-rotation\\output\\new-credentials.json"
}
```

示例version2来自最近隔离核验；实际值必须与当前受保护读取和新保护包一致，不能从模板采纳。credentials输入文件是现行授权的`{transport_key,session_token}`；output位于另一个私有目录，绝不覆盖原文件。checkpoint首次必须存在且为空。先准备，再按明确的真实轮换决定执行：

```powershell
npm run backup:business:build
npm run coach:rotate -- prepare 'D:\private-rotation\config.json'
npm run coach:rotate -- rotate 'D:\private-rotation\config.json' --rotate-own-coach-code
npm run coach:rotate -- resume 'D:\private-rotation\config.json'
```

`prepare`完整离线核验保护包及独立digest，再受保护读取当前Coach、schema和服务身份，调用只读prepare并再次核对原会话及本次新Code。输出`COACH_CODE_ROTATION_PREPARED`、`rotation_submitted=false`、预期版本、服务指纹、保护包时点及队列观测；不调用rotate／login，不写attempt header、receipt或新凭据，不撤销会话。锁仅在本次预检期间存在；已存在的attempt、非空checkpoint或output都拒绝，不能用prepare重解释未知轮换。

准备结果只证明该次保护包与当前Coach检查通过，`verification=PROTECTION_AND_CURRENT_COACH_ONLY`。队列是独立时点的观测，不是冻结、待执行许可或全量业务对账；非零计数不能被解释成可直接执行。prepare不预留请求或固定未来授权，实际rotate会重新核全部前置，不能跳过prepare之外的业务与运维门槛。

CLI固定唯一c2test目标；逐响应核验generation／epoch／service version／request等元数据，30秒deadline、100,000字节响应预算，拒绝redirect，无自动retry。独立核验保护包后，核当前actor／version／schema，prepare原payload，持久写一次header.json，之后最多提交一次rotate。header固定原config、actor、version、服务指纹、service version与派生login请求，不含Code／token或可离线猜解的裸CodeSHA；Code每次重读并在本次调用内保持一致。保护包完整性不证明来源或当前最新业务状态，实际运行前仍需业务冻结与差异核对。

新attempt使用v2 header，额外保存原会话token的SHA256摘要，不保存token正文；resume在任何HTTP前核对输入会话仍是该原会话。必须保留原credentials文件，不能用新凭据或其他会话覆盖它。该摘要只用于绑定高熵会话，不对Code做裸SHA。

v2确认须new_code固定login请求→新session→受保护原receipt→当前actor／version／schema复核，再用原会话调用只读bootstrap。只接受同一服务／generation／epoch／contract／request的401 SESSION_INVALID或SESSION_REVOKED、retryable=false；当前服务先比较credential version，因此轮换后的旧会话通常返回SESSION_INVALID。过期、transport拒绝、错误身份、非预期错误结构、超额响应或网络故障均保持未确认。随后再次确认新会话有效，才保存receipt.json和私有new-credentials.json。

stdout仅COACH_CODE_ROTATION_CONFIRMED与actor／请求／version／时间及`old_session_verification=DENIED`，错误固定COACH_CODE_ROTATION_UNCONFIRMED，不输出Code、token或原HTTP正文。此结果证明原发起会话被拒绝；全体旧会话仍需真实轮换后新保护包逐行核对，原包会话行不能缺失，原Coach全部旧version会话均须有revoked_at，不能用单个token回查代替完整census。

header存在即表示原mutation可能执行，resume仅确认，不再次rotate；即使第一次请求未到服务，也保持UNKNOWN。读取header时按原actor／request／服务payload指纹重新计算派生login编号，不匹配在HTTP前拒绝且不自动修复。若new_code登录失败、固定login的session已过期／撤销、输入改变或后续又发生轮换，停止并由管理员核对；不能换编号、编辑header或自动回旧Code重新轮换。丢login或旧会话回查回复可沿原header恢复，使用同一login请求，不补发rotate；confirmed receipt与输出原字节只核对不覆盖。receipt三层字段精确校验，额外Code／token字段拒绝写入checkpoint。既存v1 header仍按原receipt恢复，不改写header，结果为`old_session_verification=NOT_RECORDED`；它未绑定原token，不能追溯声称完成旧会话回查。锁／临时文件故障处理遵循保护备份指南，不抢锁或强行覆盖。

## 真实执行顺序

实际路由、远端schema与待执行顺序统一见[当前进度](../../CURRENT-STATUS.md)和[隔离发布指南](../../cloudflare/ISOLATED-RECOVERY.md#隔离发布顺序)。本工具要求新业务路由及匹配当前schema／Coach version的保护包；不部署或代替原包恢复演练。Cloudflare真实轮换、生产Apps Script凭据和Git历史分别处理。
