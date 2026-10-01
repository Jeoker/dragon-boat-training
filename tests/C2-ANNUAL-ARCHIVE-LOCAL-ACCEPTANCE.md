# C2.6 年度归档第一切片 - 本地验收

> 历史切片说明：下文内存 exact-plan store、32 requests／8MB及当时测试数量保留为第一切片证据。2026-10-01 整体审核中，重复的 InMemoryArchivePlans 和其专用预算字段已删除，实际持久恢复由 schema15 service 承担；当前源码只保留年度输入／record／chunk／plan的有效资源测试。见[本轮审核](C2-ROUND-REVIEW-2026-10-01.md)及[存储验收](C2-ANNUAL-STORAGE-LOCAL-ACCEPTANCE.md)。

日期：2026-09-30。范围由 [设计](C2-ANNUAL-ARCHIVE-DESIGN.md) 和 supervisor 本轮授权限定。

## 已实现的范围

- [内部 DTO](../shared/c2-archive-contract.ts)：显式数组、固定 snapshot／captured_at／cutoff、原 binding／generation／epoch、赛季时区；复用实际 C1 parsers 和 season end 规则。业务字段显式白名单；审计按真实 `recordRequest` action 及有限 nested seating／schedule／Form shape 校验，未知 action／字段停止。
- [纯投影和内存重放](../shared/c2-archive-projection.ts)：稳定业务键排序、版本化 canonical exact text、确定性 UTF8 分块、原 request 和 snapshot 内容不可变、返回副本。当前状态恒为 `LOCAL_PLAN_ONLY`，来源恒为 `SOURCE_NOT_YET_VERIFIED`。
- [Node 场景](c2-archive-plan.test.mjs)：直接加载真实 TypeScript；测试范围内调用原 C1 `buildFrozenSnapshot`、`seatingExportSnapshot`、`practiceProjection`、`validateSnapshot` 和 `seatingMode`，不修改这些源文件。SQL stub 仅向这些函数提供虚构输入，不声称已捕获实际 DO 数据。

不增加 SQL 表、Worker import、HTTP endpoint、alarm、bridge action、manifest／部署版本或 Google 写入。不实现真实或模拟 receipt，不调整现有 C1 `ARCHIVED`／public 行为。验收执行时没有部署或远端写入。

## 有效证据

| 类别 | 覆盖 |
|---|---|
| 冻结／名字 | 与实际 C1 冻结函数结果一致；后来成员改名不改 frozen names；正式旧 revision 完整；缺名字／版本／引用拒绝 |
| 到期／取消 | 精确 end+24h、whole-season 本地真结束时间；取消训练及相关内容排除；有效训练取消报名及 cancelSignup 审计保留；未发布结果不复制草稿为正式历史 |
| C1 出席语义 | 同成员 Coach／Steerer 合法，角色与座位交集非法；实际 `FINAL_CORRECTION` 可发布已取消报名成员的最终出席，`UPCOMING` 则拒绝。归档保留实际正式结果，不根据最终 signup 状态猜出席 |
| 完整图 | 全左右 draft slots、slot 上限／唯一成员、连续 revision、revision 不超过 state、signup 唯一序号／时间／confirmed 左右及总容量、连续 correction、同季引用、审计内层身份／时间／原 revision 对齐 |
| 历史资格 | 不按当前 member ACTIVE 重跑历史候补或递补。C1 运行时跳过 inactive，`updateMember` 不重算 signup；空位 WAITLISTED 正例不会被迁移时 eligibility 规则误拒 |
| 年度／时间 | practice 年按显式 season timezone 派生，practice.timezone 分别保留；跨年／DST／不可信 archive_year、无效时区、错误 season_ends_at；有效 1500+ 字符 map URL 对齐 C1 2048 上限 |
| 审计／隐私 | 实际 finite nested seating、before／after、prepare created boolean、confirm open_at、Form counts／has_more；跨季／未来时间／漏槽／非法标量／凭据 nested 字段停止。非业务凭据扩展不进入白名单输出 |
| 确定性／资源 | 输入对象及 set 数组顺序改变仍 exact text 一致；Unicode UTF8 计数和 lone surrogate 拒绝；块 offset／数量连续；单记录超块、总输入／记录／内存请求数及累计 text 预算超额全部失败，失败不污染已存在计划重放 |

固定资源上限：原输入 JSON 2,000,000 UTF8 bytes，5000 输出 records，单块 64,000 UTF8 bytes／100 records，整份 canonical plan 2,000,000 UTF8 bytes，内存 32 requests／8,000,000 累计存储键及 exact texts UTF8 bytes。累计 text 预算不是 JavaScript heap 实测上限，也不是未来 DO capture 事务资源证明。没有部分计划返回，超额需后续捕获方案独立解决。

## 本地命令与结果

- `node --test tests/c2-archive-plan.test.mjs`：22/22 通过。
- `npm run cf:check`：共享 TypeScript 检查通过。
- `npm test`：最终完整 Node 259/259 通过。
- `ASTRO_TELEMETRY_DISABLED=1 npm run build`：通过，0 errors／0 warnings；两项现有测试未使用变量 hints，不属于新增年度模块。

`node --check tests/c2-archive-plan.test.mjs` 与 `git diff --check` 通过；未跟踪新增文件另以 `git diff --no-index --check NUL <file>` 核验，没有空白错误，仅 Windows LF／CRLF 提示。

两名独立 reviewer 源码终审通过，无未解 P1／P2。`conflict_design_review` 独立复跑最终专项 22/22、类型及 diff 检查；`waitlist_acceptance` 独立复核最后 raw presence 修补并跑 nested 审计／缺项 graph 定向 2/2、类型／nodecheck／diff 检查。过程发现的双角色、审计有限 shape、created boolean、完整 draft／queue、容量与显式缺字段门槛均已修复并有负例。没有以共享 C1 migration parser 的兼容默认补空代替年度捕获数据。

## 尚未实现的门槛

一致 DO 捕获事务及资源测量、真实 SQL 持久／跨重启恢复、现有 crypto digest／事务锚、完整原始回答 source manifest、年度创建 unknown-reply 协议、不可变完整 receipt／Google 回读、C1 public 兼容接合、非空计划备份以及隔离远端故障验收均待后续独立授权。仅传入显式 frozen 私有输入不证明调用方确实捕获了完整一致范围；缺私有输入直接停止，不能猜测或补洞。
