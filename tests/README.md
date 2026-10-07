# 组件协议与验证入口

当前部署、技术债和下一步见[当前进度](../CURRENT-STATUS.md)，已取得的有效证据只维护在[验证索引](CURRENT-VERIFICATION.md)。本目录的设计文件维护各组件协议；测试代码维护可执行场景，不保留逐轮验收报告或旧开发计划。

## 组件设计

| 范围 | 主要协议 |
|---|---|
| 年度业务计划、状态与输出门槛 | [年度归档](C2-ANNUAL-ARCHIVE-DESIGN.md)、[一致捕获与持久计划](C2-ANNUAL-CAPTURE-STORAGE-DESIGN.md) |
| 完整原始来源、范围及不可变捕获 | [来源捕获](C2-ANNUAL-SOURCE-CAPTURE-DESIGN.md) |
| retained core 与完整来源块校验 | [计划验证](C2-SOURCE-PLAN-VALIDATION-DESIGN.md) |
| HUMAN_ATTESTED、只追加证据及派生结果 | [人工映射](C2-SOURCE-MAPPING-REVIEW-DESIGN.md)、[retained plan 审核适配](C2-SOURCE-PLAN-REVIEW-ADAPTER-DESIGN.md) |
| 同训练顺序、跨训练隔离及全季屏障 | [关联通道](C2-ASSOCIATED-LANE-DESIGN.md) |
| 整行 B／G、覆盖和漂移诊断 | [物理诊断](C2-PHYSICAL-DIAGNOSTICS-DESIGN.md) |
| 本地 API 授权 | [OAuth 配置](C2-SOURCE-OAUTH-SETUP.md) |
| 云托管、独立存储及资源 | [私有服务](../cloudflare/PRIVATE-SOURCE-HOST-DESIGN.md) |
| 隔离发布、封存恢复及原生证明 | [操作指南](../cloudflare/ISOLATED-RECOVERY.md) |

## 本地检查

| 变更范围 | 命令 |
|---|---|
| 文档 | `node --test tests/documentation-consistency.test.mjs`、`git diff --check` |
| 业务／共享 Node 模型与 CLI | `npm test` |
| 业务 Worker／SQLite | `npm run cf:test`、`npm run cf:check` |
| 来源共享组件 | `npm run source:check` |
| 私有 Worker／SQLite | `npm run cf:private:test`、`npm run cf:private:check` |
| 独立恢复 | `npm run cf:recovery:test` |
| 页面／Apps Script | `npm run build`、`npm run build:backend`、`npm run build:bridge-probe` |
| 配置打包 | `npm run cf:dry-run`、`npm run cf:private:dry-run`、`npm run cf:recovery:dry-run` |
| 首次schema16隔离发布准备 | `npm run cf:bootstrap:prepare`、`npm run cf:bootstrap:dry-run`；配置防护见 `node --test tests/c2-bootstrap-config.test.mjs`，真实SQLite增量升级见 `npm run cf:test -- cloudflare/test/c2-bootstrap-migration.test.ts` |
| 发布前后保护包对账 | [固定离线协议](../backend/backup/README.md#首次升级的离线对账)、`node --test tests/c2-bootstrap-reconcile.test.mjs`；实际包摘要独立保管，不能用fixture替代 |

类型检查、模型、真实 SQLite 运行时、真实 Google／Cloudflare 和浏览器各有独立边界。dry-run 只打包；本地 Google 模型不证明授权或平台资源。结果记录实际日期、版本、所测范围和缺项，组合补跑不称一次完整测试进程成功。

## 隔离工具的当前使用边界

`live-*.mjs` 和 fault overlay 工具不会随 `npm test` 执行。它们固定主机、赛季、虚构夹具、版本、源摘要或原 journal；现有工具的这些约束是运行兼容条件，不代表当前部署状态。部分工具仍只适用于 schema13／14、0.16.x 或已经结束的测试场次，不能直接用于当前 schema16。不要为了通过预检而降低检查或删除夹具、原批次和审计。

运行前核对脚本实际校验、当前远端身份／schema、原 Google deployment／HEAD、绑定、队列、保护备份和恢复材料；不满足时停止，先适配并验证工具。生产写入与迁移不由这些脚本授权。

固定场景、phase顺序、故障overlay及原journal接续见[隔离工具指南](ISOLATED-TOOL-GUIDE.md)。

- c2test 环境变量、快照及状态位于项目内 Git 忽略的 `.c2-form-test/`；Worker 输出位于 `cloudflare/.acceptance-artifacts/`。
- 业务写入使用脚本要求的显式参数，例如 `--write-test-data`；备份、恢复、轮换和 journal 使用各自的明确确认参数。
- 未知结果保留同一 request／batch／target／journal，不重新生成业务。清理只恢复本次可证明归属的测试改动，不清空整表或旧状态。
- 临时 Google overlay 须保留完整原 deployment 和 HEAD 的各自 clean 源、manifest 与摘要；恢复两侧后分别核对，不把两个不同基线强行对齐。
- Sheet 语义 B/C/G、整行物理诊断、不可变 revision 和 Google 回执分别核对；部分写入先恢复原批次，禁止后续目标越过。
- 自动 polling 与 cron 按当前部署配置核对，测试结束验证原开关／源恢复及会话退出；失败保留现场，不靠循环请求推进。

当前可执行运维说明见[业务备份](../backend/backup/README.md)、[Coach 自轮换](../backend/coach/README.md)、[私有本地 host](../backend/PRIVATE-SOURCE-HOST.md)及[隔离恢复指南](../cloudflare/ISOLATED-RECOVERY.md)。
