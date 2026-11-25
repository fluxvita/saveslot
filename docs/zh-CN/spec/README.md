# saveslot · 规格

> 每份规格都有英文版（[`docs/spec/`](../../spec/README.md)），两个版本不一致时以中文版为准。

> 每条规则的完整定义，给实现内核、写接入方、审查设计的人按需查。第一次接触 saveslot 的人先读讲解（[`../guide/`](../guide/README.md)）；项目的一页总览在仓库根的 [`README.zh-CN.md`](../../../README.zh-CN.md)。讲解与规格不一致时以规格为准。

阅读顺序就是文件名的编号顺序：**01 → 02 → 03 → … → 10**；07 第一版范围、08 待定清单与 11 断言索引可以随时查。

| 文件 | 读什么 |
|---|---|
| [`01-positioning.md`](01-positioning.md) | 定位、服务对象、产品形态、场景判据、分层与接入面、管什么不管什么、部署形态、技术选型、后续规划 |
| [`02-architecture.md`](02-architecture.md) | 工程架构：内核不变量 K1–K14、服务层策略、模块与依赖、运行时、存储抽象与存储格式、信任边界、代码组织与测试 |
| [`03-data-model/`](03-data-model/README.md) | 数据机制与内核规则的权威定义，按主题分 11 份（含受限 SQL 的白名单），目录里有每份的一句话说明 |
| [`04-contract.md`](04-contract.md) | 操作契约的规则：各操作什么时候返回什么、为什么 |
| [`04-contract-types.md`](04-contract-types.md) | 操作契约的类型定义：每个操作的参数、结果、错误与全部枚举，字段名与结构以它为准 |
| [`05-surfaces.md`](05-surfaces.md) | 外化面：MCP 与 HTTP 各自的规则 |
| [`06-cli.md`](06-cli.md) | 外化面：CLI 与上手流程（命令清单、人工确认的交互、输出约定、安全） |
| [`07-scope-v1.md`](07-scope-v1.md) | 第一版范围 |
| [`08-open-questions.md`](08-open-questions.md) | 唯一的待定清单，按"什么时候必须定"分三组 |
| [`09-event-format.md`](09-event-format.md) | 事件格式：每种事件的事件头字段、内容块与编码；也是导出文件的格式说明 |
| [`10-evals.md`](10-evals.md) | eval 规格：让真实的 Agent 经 MCP 完成任务的评测，每个阶段的验收用它 |
| [`11-claims.md`](11-claims.md) | 断言索引：规格里的全称断言各由哪条测试守着，哪些已知不成立、哪些还没有测试 |

规格只写方案本身。某条规则为什么这样定、经过了哪些审查，在 [`../process/`](../process/README.md)（决定稿、场景推演）；调研来源在 [`../research/`](../research/)。
