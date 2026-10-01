# C2 SENT 并发暂停本地验收

日期：2026-09-30（America/New_York）。状态：新增本地真实 Worker／Durable Object 调用链回归通过，独立 reviewer 和 supervisor 交叉审核通过；独立复跑相关两个文件 69/69、exit0，无未解决 P1/P2。没有远端执行、部署、schema 或业务实现修改，也没有改现有真实验收 runner。

入口：[c2-associated-export.test.ts](../cloudflare/test/c2-associated-export.test.ts)，用例名 `pauses during a real SENT await, drains only the original batch and preserves a later business event`。

## 原缺口与证据范围

既有 [候补故障暂停真实报告](C2-WAITLIST-FAULT-PAUSE-ISOLATED-ACCEPTANCE-2026-09-30.md) 证明 FAILED 部分写批次的暂停排空，明确没有证明正在发送的 SENT 请求与暂停同时发生。原 operations 用例手工插入 SENT 并手工改 CONFIRMED，支持控制状态规则，不能替代真实发送调用链并发证据。

本次只在测试夹具中设置最初的虚构训练、成员、旧报名 snapshot 及索引。批次 PREPARED→SENT→CONFIRMED、items receipt、暂停控制、请求结果、后续真实业务 outbox 和事件最终确认均由正常 API／exporter 实现产生；不手工插入 SENT，不手工确认 batch，不改 outbox due。

## 可控窗口与验收结果

使用现有 SheetMirror 的 `afterPatch` 挂点，模拟 Google target 和 verified receipt 已提交、回复尚未交还 Worker 的窗口。原 exporter 已持久写入 SENT，并在真实 patch await 上等待。两个上下文分别等待，只共享 entered／released 布尔值；1ms timer 仅检查条件，不能因时间届满自行放行。所有 Durable Object 操作都由测试控制器从 callback 外发送。测试在所有暂停、业务写和现场断言完成后显式 release；finally 只为失败时清理本地悬挂请求。此方式避免共享 Promise 恢复到错误 DO I/O context。

| 步骤 | 实际本地证据 |
|---|---|
| 原请求进入发送窗口 | 恰一批 SENT，operation ID 与 receipt 相同；Worker item 仍 PENDING／无 receipt，原 export 请求结果尚未保存；旧 outbox、B、physical B、cursor 不变 |
| 并发 pause(true) | 正常 Coach API 返回 PAUSING，指向该原 SENT 批次；overview 同时显示 pause_requested=true 和 SENT |
| 提前 resume(false) | HTTP409／SYNC_EXPORT_DRAINING；没有解除暂停或推进 Google、batch、B、cursor |
| 暂停期间正常业务写 | C1 update-signup 实际将偏好 LEFT→RIGHT，版本1→2；生成新的真实 immutable outbox，原 due 自然在未来；原 v1 outbox／batch不变，Google仍仅v1 target，B和cursor未推进；真实public-practice GET仍读到v2／RIGHT，无正式船位或草稿泄漏且零新增Google调用 |
| 显式放行原 patch | 原同批 BATCH_CONFIRMED，attempt_count不增、身份和digest保持；item VERIFIED／完整 mock receipt保存，原请求结果和pin固定；overview进入PAUSED；两事件仍pending，B／cursor不变 |
| PAUSED 中拒绝新目标 | 指定新 outbox 与普通新阶段请求都HTTP409／SYNC_OUTBOX_BLOCKED；v14 selector在准备前把暂停lane视为不可运行；零新Google读写、batch、pin或export结果，不能套用旧v13拒绝码作oracle |
| 原请求重放 | 返回已保存的原 BATCH_CONFIRMED data，原operation恰一次；不会选择新事件，响应server_time不要求相同 |
| 显式 resume | Coach API返回RUNNING；原事件正常最终确认，cursor仅signup1，Google和logical/physical B仍为原LEFT snapshot；当前业务C保持RIGHT／版本2，新事件全部字节和pending状态不变；再次真实public-practice GET依然v2／RIGHT、UNPUBLISHED／空船位，零新增Google调用 |

最终同时核原 batch、request、pin、原 snapshot／due、完整 logical/physical B、cursor、Google target 与后来事件未消费；没有新增 retry或localblock。两次旧请求重放分别在PAUSED与原事件完成后进行，均保持原结果。

## 本地检查

```powershell
npm run cf:test -- cloudflare/test/c2-associated-export.test.ts -t "pauses during a real SENT await"
npm run cf:test -- cloudflare/test/c2-associated-export.test.ts cloudflare/test/c2-export-operations.test.ts
```

新增单例通过；相关两个文件 **69/69** 通过、exit0。Wrangler尝试写AppData日志出现已有EPERM，测试仍正常exit0。本轮不重新声明旧225项全量证据，也不把本地结果记为真实Google并发暂停通过。

## 仍不能证明与后续最小边界

本地调用链证明真实DO await期间的运行时pause规则、原批次确认以及新业务事件隔离。SheetMirror不等同Apps Script、LockService或真实Google网络；本次不证明真实SENT窗口、timeout／进程重启、source pause、自动poll、配额、备份恢复或生产切换。也没有为新业务事件等待十分钟并导出版本2，本例只证明其未被错误消费。

如后续要求真实Google证据，应先完成当前独立训练验收；另选一个新隔离事件并自然等待due，不复用已确认的旧候补批次，不改当前runner journal或Google历史。现有fault overlay的partial/lostreply只针对旧两个固定批次，不能原样拿来制造SENT窗口。

可选最小远端方案是另行审查仅匹配一个固定batch／原payload／binding／epoch的短回复延迟overlay：正常patch与receipt先完成并flush，释放bridge lock后才延迟回复；supervisor并发读取SENT并发pause。delay必须低于Worker桥接 **20秒** timeout，不能依据CLI 45秒 timeout设计长sleep；错过窗口只记验收不成立并停止，不修改due或换ID补做。capture当时SENT的完整备份可以先创建immutable snapshot，再在窗口结束后下载。原活跃请求结束前不并行重发drain；未知回复在其结束后才按原ID恢复。

远端方案还需固定三文件源码摘要、同deployment及HEAD两套clean恢复证据、一次marker、签名限定probe、私有journal和未知回复恢复独审；不新增公共测试权限或长期生产hook。无需新框架或更改业务规则，目前没有新的产品设计需要用户决定，但这项远端overlay与执行不在本次授权实现范围内，必须由supervisor另行审核和调度。本文未实现或执行该方案。
