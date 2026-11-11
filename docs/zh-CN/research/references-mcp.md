# 参考：MCP 与相关系统的接口设计

> 2026-11-09 调研（3 个子任务分别读了官方文档与源码，链接锚定到读过的版本）。服务于 saveslot 的 MCP / API 接口设计；
> saveslot 自己的设计见 [`data-model.md`](../spec/03-data-model/README.md)。标"未核实"的需上线前实测。

## 结论

- **只有"工具调用 + `isError` 文本结果"能假设所有客户端都支持**；elicitation、structuredContent、resources、prompts、
  annotations 都只能当可选增强。印证 saveslot 的"MCP 按最差宿主设计"。
- **没有一个现成系统覆盖 saveslot 的需求**（含 Teable）：用户自定义 schema 的表、规则生成的派生表、带前后值的写日志、读日志、
  纠错与变更的区分、写前待确认、数据来源——各家只做到其中一两样。
- **最值得借鉴的三处**：Graphiti 的"原始片段 + 事实带来源列表 + 只作废不删除"；Supabase 的"确认凭证绑定内容哈希并签名"；
  Notion Remote 的"两段式确认 + 按时刻查看 + 改动者区分人 / AI / MCP 客户端"。
- **只读 SQL 不能只靠只读事务**：参考版 Postgres MCP 曾被 `COMMIT;` 注入绕过；要 AST 白名单 + 单语句 + 只读角色 + 超时 + 行数上限一起上。

## 一、MCP 规范（最新正式版 2026-07-28）

- **破坏性升级**：协议改为无状态（去掉 `initialize` 握手与 `Mcp-Session-Id`，新增 `server/discover`）；
  服务端发起的请求（elicitation 等）改为 MRTR：工具结果返回 `resultType: "input_required"`，客户端带答复重发原请求；
  Sampling、Roots、Logging 弃用；Tasks 移出核心改为扩展。
  [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- **客户端版本不一致**：Claude Code 已支持 2026-07-28；claude.ai / Desktop 的授权文档只到 2025-11-25；其他多未写明。
  → saveslot 要同时兼容新旧握手，或只依赖 tools。官方 SDK 处理版本协商。
- **工具定义**：`name`（1–128 字符，`A-Za-z0-9_-.`）、`title`、`description`、`inputSchema`（JSON Schema 2020-12）、
  可选 `outputSchema`（提供则必须返回符合的 `structuredContent`，且 SHOULD 同时在文本里放一份序列化 JSON）。
  工具列表不随连接变化，可随授权 scope 变化；SHOULD 按确定性顺序返回。
  [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- **annotations（只是提示，不可信）**：

  | 字段 | 含义 | 默认 |
  |---|---|---|
  | `readOnlyHint` | 不修改环境 | false |
  | `destructiveHint` | 可能破坏性更新 | true |
  | `idempotentHint` | 同参数重复调用无额外效果 | false |
  | `openWorldHint` | 与外部开放世界交互 | true |

  客户端用法：Claude 只读工具免逐次确认、破坏性工具必弹确认；Claude Code 依据只读 / 幂等决定断线后重试一次、只读工具并行；
  VS Code 只读跳过确认；Codex 非只读弹确认；ChatGPT 所有写操作都要确认。**注解不能代替服务端的授权、校验与确认。**
- **elicitation**（2025-06-18 引入）：form 模式只能扁平对象 + 原始类型，**禁止索要密码 / API key / token**（须走 URL 模式）；
  只能发给声明过该能力的客户端；必须处理 decline / cancel / 不支持；`requestState` 要做完整性保护（HMAC）并绑定主体、TTL、请求摘要。
  [elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)
- **错误**：请求结构问题用 JSON-RPC 错误；**输入校验、业务逻辑错误用 `isError: true`**，客户端会转给模型自我纠正。
- **分页**：规范的 cursor 只覆盖 list 类方法，**工具结果的分页要自己在参数里设计**。
- **取消与重发**：Streamable HTTP 下关闭流即取消；去掉了断点续传，断流后客户端用新 id 重发 → **写操作必须服务端幂等**。
- **有状态工具**：协议无会话；跨调用状态用工具返回的不透明 handle（每次校验授权、描述里写明有效期、过期返回 `isError`）。
- **远程授权**：OAuth 2.1，RFC 9728 Protected Resource Metadata、PKCE、RFC 8707 audience 校验、禁止透传 token；
  客户端注册 CIMD（推荐）/ DCR（弃用但保留）；权限不足返回 403 `insufficient_scope` 做 step-up。
  [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

### 客户端支持（官方核心功能矩阵已于 2026-05-27 下线，以下按各家文档）

| 客户端 | Resources | Prompts | Elicitation | 远程 OAuth | 结果大小 |
|---|---|---|---|---|---|
| Claude Code | 支持 | 支持 | 支持（仅交互终端） | 支持 | 默认 25k tokens，10k 警告 |
| claude.ai / Desktop | 支持 | 支持 | 未写明 | 支持（DCR） | 约 15 万字符，单次 240 秒 |
| ChatGPT | 未写明 | 未写明 | 支持 | CIMD、DCR | — |
| Cursor | 支持 | 支持 | 支持 | 支持 | — |
| VS Code / Copilot | 支持 | 支持 | 支持 | 支持 | — |
| Codex CLI | 未写明 | 未写明 | 未写明 | CIMD、DCR | — |

来源：[Claude Code](https://code.claude.com/docs/en/mcp)、[Claude 连接器](https://claude.com/docs/connectors/building)、
[ChatGPT](https://developers.openai.com/plugins/build/mcp-server)、[Cursor](https://cursor.com/docs/context/mcp)、
[VS Code](https://code.visualstudio.com/api/extension-guides/ai/mcp)、[Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

## 二、工具设计原则

来源：[Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)、
[mcp-server-dev skill](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/mcp-server-dev)、
[Claude 连接器目录审核要求](https://claude.com/docs/connectors/building/review-criteria)。

- **工具少而高层**：1–15 个最好，15–30 个要审查合并，30 个以上改"搜索 + 执行"模式；合并多步工作流，不 1:1 包 API。
- **统一前缀命名**（如 `saveslot_`），名字 ≤ 64 字符。
- **读写分开成不同工具**（目录审核硬要求），写操作最好再按创建 / 更新 / 删除拆；删除单独成工具并标破坏性。
- **返回高信号内容**：少给 UUID，用可读标识；提供 `concise / detailed` 两档；写操作返回后续要用的 ID，不只回"ok"。
- **省 token**：分页、过滤、截断、合理默认值；截断时告诉模型怎么缩小范围（"显示 10 / 847 条，请缩小查询"）。
- **报错可执行**：说清错在哪、下一步调用什么、附正确示例；不返回笼统的 "Internal Server Error"。
- **描述写清做什么、返回什么、不做什么**，相近工具互相指明何时改用对方；
  **描述不能指挥模型**（如"必须先调用 X"会被当作提示注入），依赖关系用中性写法或放进报错提示。
- **用真实多步任务做 eval**，按调用次数、参数错误、token 迭代。

## 三、记忆类系统

| 维度 | 官方 memory server | Mem0 | Letta | Zep / Graphiti |
|---|---|---|---|---|
| 存储单位 | 实体 + 观察字符串 + 关系 | 一句事实 | 文本块 / Markdown 文件 | 原始片段 + 实体 + 事实边 |
| 原始数据单独保留 | 否 | 仅最近 10 条，滚动淘汰 | 是，但不链接 | **是** |
| 事实到来源的链接 | 无 | 无 | 无 | **有（`episodes[]`）** |
| 历史 / 版本 | 无 | history 表（旧值 / 新值 / 操作者） | 块级快照 + undo/redo；git | 作废标记 |
| 纠错与变更区分 | 无 | 无 | 无 | 无 |
| 冲突 | 无 | 平台版 supersede，默认返回并打标记 | Agent 自己改写 | 模型判定 + 按时间作废 |
| 时间 | 无 | 创建 / 更新、过期 | 创建时间 | **双时间轴** |
| 删除 | 硬删 | 硬删 + history 留痕 | 改写 | 硬删；按来源级联 |
| 确认 | 无 | 只在描述文字里 | 按工具配置需审批 | 无 |
| 抽取方 | 调用方，无需模型 | 服务端模型 | Agent 自己 | 服务端模型 + embedding |

- **官方 memory server**（[源码](https://github.com/modelcontextprotocol/servers/blob/36380287ed/src/memory/index.ts)）：
  零模型、调用方抽取的极简基线。工具契约写得规范：每个工具有 `outputSchema`、注解准确、描述里写明何时改用兄弟工具、
  `observationLimit: 0` 先看概览再展开、部分跳过时回传 `skipped`。
- **Mem0**（[源码](https://github.com/mem0ai/mem0/blob/f1791daa86/mem0/memory/main.py)）：v2.0.0（2026-04）起抽取只做新增，
  不再自动更新 / 删除；自托管 MCP 已归档，改推托管版；写入异步，返回 `event_id` 查进度；`user / agent / app / run` 四维范围。
- **Letta**：主仓已归档，现役 [letta-code](https://github.com/letta-ai/letta-code/tree/42d6d46f93) 把记忆存为 git 管理的 Markdown 文件树，
  原始消息不可改；有"调用前须人工批准"的工具规则。
- **Zep / Graphiti**（[MCP 源码](https://github.com/getzep/graphiti/blob/024b83679e/mcp_server/src/graphiti_mcp_server.py)）：
  最接近 saveslot。原始片段存原文；每条事实带来源片段列表，`get_episode_entities` 可反查某片段产生了什么；
  删除片段时只级联删"只由它支撑"的事实；双时间轴（事实何时为真 / 记录何时作废），矛盾的旧事实只作废不删；
  `add_triplet` 是绕开模型的确定性写入口。缺口：作废判断靠模型、不可复现；没有写日志、读日志；`add_memory` 异步且不回传结果 id。

**趋势**：Mem0 转向只新增、Letta 转向 git 版本化、Graphiti 只作废不删——业界在往"只追加 + 版本化"走，与 saveslot 一致。

## 四、数据库与业务数据类

| 维度 | Supabase | Neon | Postgres 参考版 | crystaldba | Airtable | Notion Remote |
|---|---|---|---|---|---|---|
| 结构发现 | 紧凑 / 详细两档，含外键、注释、行数估计 | 表清单、单表描述、分支对比 | 仅列名与类型 | 列、约束、索引 | 社区版三档粒度；官方可取部分字段 | 取 schema；查工具权限 |
| 只读 SQL | 只读数据库用户 | 只读事务；去掉多语句事务工具 | 只读事务（可被绕过） | **AST 白名单** + 只读事务 + 30 秒超时 | 无 SQL | 只读 SQLite 跨表查询，`?` 参数绑定 |
| 写确认 | **elicitation + 签名凭证绑定 SQL 哈希** | 只靠提示词 | 无 | 无 | 无（有撤销） | **`user_confirmed` 两段式**；建议编辑 |
| 迁移 | 按名应用；分支合并 | **临时分支预演 → 完成或丢弃** | 无 | 无 | 不能改字段类型 | 选项全量替换 |
| 体积控制 | 字段裁剪；无行数上限 | `max_rows` 默认 100，截断说明 | 无 | 无 | 社区版自动翻完所有页 | `limit` 50 / 100；`truncated` |
| 版本 / 来源 | 迁移列表 | 分支快照 | 无 | 无 | `revert_action`；靠 skill 建审计表 | **按时刻查看；改动者区分人 / AI / MCP；恢复版本** |

- **Supabase**（[源码](https://github.com/supabase-community/supabase-mcp/blob/6b2fca9/packages/mcp-server-supabase/src/tools/database-operation-tools.ts)）：
  词法检测破坏性语句后要求确认，确认凭证由服务端签名、绑定 `{工具, 项目, SQL 哈希, 签发时间}` 并会过期，
  客户端无法把已确认的请求换成别的 SQL；不支持 elicitation 时退回"取费用 → 确认 → 拿确认 ID"的显式流程。
  查询结果用 `<untrusted-data-…>` 边界包裹防提示注入。只读模式下写工具隐藏。
- **Neon**（[源码](https://github.com/neondatabase/mcp-server-neon/blob/0aebcbd/mcp/tools/tools.ts)）：
  `prepare_database_migration` 在临时分支上执行迁移，`complete_database_migration` 在父分支**重跑**并删临时分支（丢弃也必须调用）。
  缺陷：服务端无状态，SQL 由模型回传、**不绑定哈希**，complete 时可被换掉。截断说明会提醒"SQL 已执行，重跑会重复写入"。
- **Postgres 参考版**：只读事务包一条原始 SQL，被 `COMMIT; DROP SCHEMA …` 绕过
  （[Datadog 分析](https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-the-postgresql-mcp-server/)）；
  修复方式是 prepared statement 拒绝多语句、连接用后销毁。
- **crystaldba/postgres-mcp**（[源码](https://github.com/crystaldba/postgres-mcp/blob/main/src/postgres_mcp/sql/safe_sql.py)）：
  pglast 解析成 AST，按语句类型、节点、函数、扩展白名单校验，禁锁子句，外加只读事务与 30 秒超时；但没有行数上限。
- **Airtable**：官方有 `revert_action` 按动作撤销；审计靠 skill 引导用户自建"Agent 活动日志"表——数据来源在应用层靠约定。
  社区版 `detailLevel` 参数描述里直接教模型"先用最小粒度，再按需展开"。
- **Notion Remote**（[文档](https://developers.notion.com/guides/mcp/tools-faqs.md)）：删除与恢复版本要两段式确认——
  不带 `user_confirmed` 时什么都不做，只返回将影响的对象与行数；`notion-view-version` 按时刻查看；
  `notion-get-version-changes` 列出改动并区分来自人、Notion AI、Custom Agent 还是 MCP 客户端；
  "建议编辑"先挂起、返回前后 diff、再接受或拒绝；服务端自动修正了输入时写入仍成功，但返回结构化 `warnings`。

## 五、Teable（最接近 saveslot"有模型的数据"这一层）

> 源码 [teableio/teable@f8be01f](https://github.com/teableio/teable/tree/f8be01fadb86790d3d3a878bedd10cf949f9a8f8)、
> [官方文档](https://help.teable.ai/llms.txt)。仓库同时有 v1 与 v2（DDD + outbox）两套后端；MCP server、AI Chat、自动化、
> 字段 / 记录级权限、审计日志写入端都不在社区源码里。

**结论**：Teable 是"一张用户表一张物理表"的 Airtable 式系统，计算字段持久化为物理列，靠字段级依赖表驱动重算。
值得借鉴的是只读 SQL 沙箱、计算依赖的分层规划、改字段前的影响预览、MCP 的 OAuth 接入；
根本不同是没有只追加的源数据、没有 schema 版本与原子切换、写日志不完整、没有读日志、没有独立的 Agent 身份。

| 维度 | Teable | saveslot |
|---|---|---|
| 源数据 | 无；直接改当前状态 | 只追加的源数据日志 |
| 建模表 | 每个 base 一个 PG schema，每张用户表一张物理表，字段对应列，多值用 JSON | 同样是 PG 物理表，schema 由 Agent 起草 |
| 派生 | 公式 / lookup / rollup 存为物理列；依赖记在 `reference` 表（字段级边）；v1 同事务重算，v2 同步前几层、其余进 outbox 异步（最终一致） | 受限 SQL 规则，同事务刷新 |
| 写日志 | 单元格级前后值 + 用户；v1 提交后异步写；v2 同事务但单次超过 200 行**静默丢弃**；计算字段、导入不记；可整体关闭 | 行级前后值 + 来源，必须完整 |
| 读日志 | 无（只有性能观测） | 一等能力 |
| schema 变更 | 无版本；改字段类型在一个大事务里读全表、经字符串转换、逐行写回；有影响预览 `plan` 接口（依赖图、受影响格子数、估计耗时） | 版本化 + 预览 → 确认 → 原子切换 |
| 只读 SQL | 每个 base 一个 NOLOGIN 只读角色 + READ ONLY 事务 + `SET LOCAL ROLE` + 超时 + AST 表白名单（为空即拒绝）+ 函数白名单 + 拦截 `SET ROLE`；SQL 里用物理名 | 受限只读 SQL |
| 撤销 | 会话级缓存栈（200 条、24 小时），补偿写 | 基于版本 |
| 身份 | MCP、PAT、AI Chat 都以用户本人身份操作；`via=ai` 来自客户端自报的请求头 | 连接实例独立凭证 |
| 权限 | 角色 + `资源|动作`；PAT 的 scope 与资源范围取交集；字段 / 记录级权限付费闭源 | 后续版本 |

关键来源：物理映射 [`postgres.provider.ts`](https://github.com/teableio/teable/blob/f8be01fadb86790d3d3a878bedd10cf949f9a8f8/apps/nestjs-backend/src/db-provider/postgres.provider.ts)、
计算字段 [`computed/ARCHITECTURE.md`](https://github.com/teableio/teable/blob/f8be01fadb86790d3d3a878bedd10cf949f9a8f8/apps/nestjs-backend/src/features/record/computed/ARCHITECTURE.md)、
写日志 [`v2-record-history.service.ts`](https://github.com/teableio/teable/blob/f8be01fadb86790d3d3a878bedd10cf949f9a8f8/apps/nestjs-backend/src/features/v2/v2-record-history.service.ts)、
影响预览 [`graph.service.ts`](https://github.com/teableio/teable/blob/f8be01fadb86790d3d3a878bedd10cf949f9a8f8/apps/nestjs-backend/src/features/graph/graph.service.ts)、
只读 SQL [`base-sql-executor.service.ts`](https://github.com/teableio/teable/blob/f8be01fadb86790d3d3a878bedd10cf949f9a8f8/apps/nestjs-backend/src/features/base-sql-executor/base-sql-executor.service.ts)、
schema 规则 [`schema/rules/ARCHITECTURE.md`](https://github.com/teableio/teable/blob/f8be01fadb86790d3d3a878bedd10cf949f9a8f8/packages/v2/adapter-table-repository-postgres/src/schema/rules/ARCHITECTURE.md)、
MCP [Teable Skill 文档](https://help.teable.ai/en/basic/ai/teable-skill.md)。

**值得借鉴**：

1. **只读 SQL 多层沙箱**（见上表），并补上它自己留的 TODO：用独立的只读连接；报错里提示字段名与物理名的映射，方便 Agent 自己改 SQL。
2. **计算依赖的分层规划**：按层排列的重算计划、源值没变就不再往下传、复杂度估算。saveslot 坚持同事务刷新，
   可以把它的阈值（`syncMaxDirtyPerTable` 等）改造成**写入准入阈值**：超出就拒绝或要求拆批，而不是转异步。
3. **声明式的物理结构规则**：每种字段对应一组规则，各有 `up` / `down` / `isValid`，按依赖排序生成 DDL，
   还能对照真实库结构检查漂移并修复——可作 saveslot 预览（生成 DDL 差异）和切换后自检的骨架。
4. **影响预览**：受影响的依赖图、格子数、估计耗时，可直接放进 saveslot 的 schema 变更预览。
5. **MCP 接入**：HTTP + OAuth 动态注册；MCP 可用的 scope 有上限（剔除账号级权限）；按 token scope 裁剪工具列表并逐次校验；
   "结构化查询失败时不得静默退回原生 SQL"。

**未核实**：MCP 工具名与参数；SQL 查询接口的控制器源码；审计日志、自动化、MCP server 的套餐归属；v2 的异步 schema 操作是否覆盖改字段类型。

## 六、对 saveslot 接口设计的启示

1. **只以工具为必需能力**；resources（数据目录浏览）、prompts、elicitation、structuredContent 都做成可选增强，缺了流程照样走通。
2. **读写分成不同工具，全部 `saveslot_` 前缀，总数控制在 15 个以内**；删除单独成工具并标破坏性。注解只是提示，权限与确认在服务端强制。
3. **协议元数据由服务端补全**（连接实例、幂等键、来源级别默认值），模型填意图、表、行、值、证据，并**原样带回读取时拿到的版本标记与 schema 版本**（2026-11-09 定：MCP 无状态，服务端补预期版本会让乐观并发失效；未带时按 read_log 兜底）。
   写操作**服务端幂等**（应对断流重发）。
4. **结果双轨**：structuredContent + 内容等价的紧凑文本；冲突、待确认、截断、下一页等标记**必须出现在文本里**（有的客户端只给模型看文本）。
   查询结果用不可信数据边界包裹（借鉴 Supabase）。
5. **工具结果分页自己做**：`limit`（默认值 + 上限）+ `cursor`；按 Claude Code 约 25k tokens、claude.ai 约 15 万字符设预算；
   截断时说明怎么缩小查询；提供 `concise / detailed`。
6. **报错一律 `isError` + 可执行文本**：schema 版本过期、预期版本冲突、权限不足、handle 过期、超限，都写明下一步调用什么、传什么。
7. **确认以"待确认 handle + 确认工具"为主路径**：凭证由服务端签名、绑定内容哈希、带过期时间（借鉴 Supabase，避开 Neon 的回传缺陷）；
   第一次调用只返回影响说明（借鉴 Notion 两段式）；elicitation 仅在客户端声明支持时作增强。
8. **schema 变更沿用同一套 handle**：起草返回 `draft_id` + 预览 diff，确认时校验哈希后执行原子切换，放弃也显式调用（借鉴 Neon，但切换是原子的而非重跑）。
9. **只读 SQL 纵深防御**：AST 白名单（语句、节点、函数）、单语句 / prepared statement、只读事务、专用只读角色、超时、`max_rows` 截断并返回总数，
   与派生规则共用同一校验器。
10. **数据目录分级展开**：默认只给表名与摘要，按需展开到字段、关系、概况（借鉴 Supabase、Airtable）。
11. **把各家没做好的做成一等能力**：每次写入的来源与写入者（区分人 / 哪个 Agent / 哪个 MCP 客户端，借鉴 Notion）、按时刻读、纠错作为独立的写入意图、
    写入后对自动修正返回结构化 `warnings`。
12. **不用 sampling、roots**（已弃用）；saveslot 需要模型时直接调模型 API（用户自带 Key）。
13. **远程模式按 OAuth 2.1**：读、写、高影响写分 scope，用 `insufficient_scope` 做 step-up；授权服务器同时支持 CIMD 与 DCR。
14. **用多步真实任务做 eval**（发现表 → 查询 → 纠正一条记录 → 处理冲突 → 确认），据此调整工具合并方式与描述。
15. **写入准入阈值**（借鉴 Teable）：同事务刷新派生缓存的前提是单次写入的影响可控；超出阈值就拒绝并要求拆批，不转异步。
16. **schema 变更的预览内容**：DDL 差异、受影响的依赖图、受影响行数、估计耗时（借鉴 Teable `plan` 与 schema 规则）。

## 未核实

- claude.ai / Desktop 是否支持 elicitation；各客户端交给模型的是 structuredContent 还是文本；除 Claude Code 外谁已支持 2026-07-28。
- Codex CLI 对 resources、prompts、elicitation 的支持。
- Mem0 托管 MCP 的参数；Graphiti 搜索是否默认排除已作废的事实；Letta 是否有第一方 MCP server。
- Airtable 官方工具的参数与 `revert_action` 细节；Supabase 默认对哪些工具开启确认；Neon 是否设置语句超时。
