# Dragon Boat Training 项目总览

小型龙舟队的赛季制入队、训练报名、候补、排座和公开荣誉墙系统。产品规则由 [README](README.md) 维护，部署、验证边界和下一步由 [CURRENT-STATUS](CURRENT-STATUS.md) 维护。

## 使用者与权限

普通队员从本季名单选名，不登录，也不验证是否本人；团队接受代报名与误改风险。Coach、Steerer 和其他管理员共用 Coach Mode，各自使用个人 Coach Code，拥有相同管理能力。Google 文件权限、Cloudflare 部署权限和网站管理会话分别维护。

## 已确定的原则

- 赛季隔离成员资格、Form／Sheet 绑定、训练、报名、版本和档案；旧链接不回退到新季。
- 每周检查确认后才公开；开放周的新场次先存草稿，再独立发布。
- 服务器在当前状态上校验资格、截止、容量和版本；候补按原队列，换侧保留时间。
- 报名名额与船位分离；草稿仅管理员可见，正式 revision 才公开。
- 业务写入保留原请求、确定结果和审计；未知结果恢复原操作，不重复创建。
- 训练结束 24 小时后冻结最后正式版本；任务延迟不延长更正期，取消训练不归档。
- 迁移完成后 Cloudflare 提交决定业务成功，Google 运营副本异步同步；人工 Sheet 修改经过三方比较与业务校验。
- 完整来源、checkpoint 和审核全文保存在独立私有存储；人工关联不自动授予来源核验或年度导出权限。
- 免费优先，按需运行；部署前实测账户共享用量和单次限制，超额不自动升级套餐。

## 当前架构选择与生产边界

| 层次 | 当前生产 | 已确定的目标 |
|---|---|---|
| 网页 | GitHub Pages／Astro | 保留现有网站、组件和唯一客户端 |
| 业务 API／主数据 | Apps Script／Sheets | Worker → 团队 TeamState DO／SQLite |
| 入队及 Google 文件 | Form／运营表／私有档案 | 保留 Form，Apps Script 作为签名桥接，Sheets 为运营副本和归档 |
| 完整来源与审核 | 未接入生产 | 独立私有 Worker／SQLite DO，经双向 Service Binding 复核当前 Coach |
| 运维 | 人工配置及本地工具 | 独立保护备份、封存恢复、Coach 自轮换和一次性 Node CLI |

目标架构已经确定，但生产写入权尚未交接。业务 SQLite、私有来源存储和封存恢复 namespace 分离；本地工具只用于验收与运维。实现存在、模型测试通过和隔离远端通过，分别记录，不互相替代。

## 工作归属

| Epic | 职责 |
|---|---|
| [BE](epics/backend.md) | 业务规则、契约、权限、存储、Google 桥接、同步、迁移和恢复 |
| [FE](epics/frontend.md) | 公开页面、共享组件、唯一客户端、构建和 Pages 发布 |
| [ADM](epics/admin.md) | 同一网站中的 Coach Mode、管理会话、确认、冲突及来源审核交互 |

当前交付范围不增加管理权限分级、多船、签到统计或自动通知。正式品牌素材／页面语言、长期队员身份与跨季历史分别由 README 的 D5／D6 维护。

## 文档分工

| 内容 | 维护位置 |
|---|---|
| 产品规则与待定项 | [README](README.md) |
| 部署、已验证状态、现存技术债和下一步 | [当前进度](CURRENT-STATUS.md) |
| 现行有效证据、范围和复核入口 | [验证索引](tests/CURRENT-VERIFICATION.md) |
| Cloudflare 架构、同步及切换协议 | [迁移计划](cloudflare-migration-plan.md) |
| 页面与客户端 | [前端规格](frontend-spec.md) |
| 生产 Apps Script 存储、锁及恢复 | [现行后端规格](google-sheets-backend-spec.md) |
| API 输入输出与兼容 | [契约](contracts/README.md)及动作清单 |
| 构建、配置及操作 | [后端](backend/README.md)、[Worker](cloudflare/README.md)、[隔离恢复指南](cloudflare/ISOLATED-RECOVERY.md) |
| 组件协议与测试入口 | [测试目录](tests/README.md) |
| 职责与验收分工 | [Epic 总览](epics/README.md) |

文档直接维护最新结论，不保存设计演变、废弃候选或逐轮开发记录。协议、状态和验证各有一个主要位置；其他文档引用对应入口。仍约束现存数据或工具的兼容限制与技术债保留，并说明消除门槛。

## 开始工作

1. 读取当前进度及任务对应规格，检查实际工作目录、分支和未提交改动。
2. 修改规则时更新 README；修改协议时更新对应规格和契约；取得实际证据后才更新状态及验证索引。
3. 保留稳定 ID、队列时间、版本、请求结果、revision、冻结快照和审计。远端写入前重读身份、配置及当前数据，不假定验收夹具仍可重用。
4. 源码、测试和文档正常追踪；凭据、私有回答及生成产物不提交。本地目录和缓存遵守 README 的归属规则。
5. 文档变更运行文档一致性测试及 `git diff --check`；实现变更按 [测试入口](tests/README.md) 选择类型、运行时、构建及隔离验证。
