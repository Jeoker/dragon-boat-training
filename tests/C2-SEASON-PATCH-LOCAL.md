# C2.4 赛季名单版本补丁：本地与隔离验收

日期：2026-09-27。赛季桥接及其 Cloudflare 关联导出调用方已在本地和独立 `c2test`／Google 文件通过名单版本写回验收。独立 Web App 为 v10，Worker 为 `0.12.0-c2-season-export`（部署 version `ee5f0057-23ee-4970-8528-152028b67dfc`），schema v9、`writer_epoch=0`。原 staging、生产 Apps Script／Google 文件及 Pages 未部署此切片；C2.4 整体仍未通过。

`cloudflarePatchSeasonSheet` 与既有成员补丁共用 `BoundRowPatchBridge.gs` 的签名、锁、私有 `BridgeExportReceipts`、前值核查、逐格补丁和写后复核。赛季补丁只作用于**已存在**的系统 `Seasons` 行；它保留 Form、运行 Spreadsheet、回答 Tab、字段映射、触发器、归档等 Google 绑定／运营列，只允许更新名称、日期、时区、赛季状态、业务版本和更新时间。绑定版本、运行文件和 Tab ID 必须与当前登记身份吻合；无匹配行、重复行、手工改动或不同负载复用批次均停止。已记录 `VERIFIED` 的批次在重放时仍重读目标行，防止 Google 在回执生成后被人工改动却让 Cloudflare 误推进基线；相同保护也应用于成员补丁。

Cloudflare 调用方在每个新名单事件中保存当时的 `roster_version`。成员行可以逐个核验，但事件保持 `PENDING`；随后读取系统 `Seasons` 行和完整 B，只补丁该事件的名单版本，严格回执通过后才在同一 SQLite 事务确认赛季 B 与原事件。下一事件即使已经入队，也不会让前一事件擅自写入较新的名单版本。缺少捕获版本的旧事件仅在后面没有待处理名单事件时使用当前版本；否则写 Google 前拒绝，留待隔离迁移核对。该内部入口仍叫 `export-next-member`，目前每次调用只推进一个成员或最后一个赛季目标，不是跨 Tab 原子 Google 事务。

本地测试覆盖合法赛季字段补丁、绑定列保持、重复批次、伪造绑定改写、人工改动冲突，以及旧 `VERIFIED` 回执后目标行再被修改时拒绝重放。Worker 测试进一步覆盖多人事件的赛季确认、赛季行被人工改动、写入后回执丢失、连续两个入队事件的版本 1→2、无法重建版本的旧事件提前拒绝，以及空成员目标拒绝。完整 Node 套件 192／192、Cloudflare 套件 100／100；前端、后端、桥接探针构建和 Worker dry run 均通过。

隔离接续先以受保护备份和签名 Google 读取核对九个旧成员事件：两条已确认、七条待处理，均没有捕获的名单版本；Google 系统赛季行名单版本为 0，只存在 `SEASON_IDENTITY` B。先沿旧导出器逐个完成七条事件，Google `Members` 增至九行，九个事件和对应批次全部确认，重放不多写。随后以精确的 Google 行内容、成员数、事件状态和待办数为门槛，只向隔离 DO 导入该行缺失的四组赛季 B；不改 Google 业务行，也不猜测九条旧事件的中间名单版本。导入后赛季差异为零，旧 `BASELINE_INCOMPLETE` 诊断消除。该一次性脚本为 [隔离状态核查](live-c2-export-state-audit.mjs) 的显式模式，当前状态已不满足再次导入门槛。

升级同一个独立 Web App 和 `c2test` Worker 后，真实 Google Form 提交虚构的第十名队员；Cloudflare 事件捕获 `roster_version=10`，十分钟后进入导出。在独立 Google `Seasons!B2` 人工改名的情况下，[真实验收脚本](live-c2-season-export-acceptance.mjs)先确认成员行写入并经重复请求保持十行，再确认赛季阶段返回 `409 SYNC_SEASON_NEEDS_REVIEW`，不覆盖人工名称。恢复原名后，以**同一个被拒绝的请求 ID**重试，赛季名单版本从 0 写到 10；重复请求不新增目标。最终 Cloudflare 名单未变、测试 Coach 已退出，受保护备份显示十个事件、十一批次均确认，五类 Sheet 检查为 `OK`／零差异，Google `Members` 十行。验收命令分别使用 `--phase=conflict`、`--phase=recover`，仅允许固定 `c2test` 主机及显式 `--write-test-data`。

Google `season_version=1` 而 Cloudflare `season_version=2`：当前切片只同步成员变化捕获的 `roster_version`，不是赛季整行双向同步。报名、训练和座位的关联批次仍未实现，因此 C2.4 未通过。`createSeason` 事件在绑定前创建，Google 赛季行由既有管理流程建立；这些边界须在后续切片中单独处理。

本记录上述版本和计数是该次验收快照；后续代码审查及隔离验收已把名单版本推进到 11，并在独立 Google 桥接实测两行 `PARTIAL` 同批恢复和回执重放。真实 Worker 请求在 Google 写后、Cloudflare 回执落库前丢失响应仍只有本地故障注入证据。以[最近代码审查与验收](C2-RECENT-CODE-REVIEW-2026-09-27.md)和[当前状态](../CURRENT-STATUS.md)判断现状。
