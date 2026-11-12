# 11 · 与 saveslot 相关的社区 Benchmark

> 2026-11-12 调研。对应 [`../spec/10-evals.md`](../spec/10-evals.md)、[`../spec/02-architecture.md`](../spec/02-architecture.md)「测试矩阵」与 [`../spec/01-positioning.md`](../spec/01-positioning.md)。本文是背景研究与选型建议，不修改规格或通过线。
>
> **核实范围**：阅读官方仓库、论文的相关章节与部分评测代码；没有安装、运行这些 benchmark，也没有测出 saveslot 的成绩。「可用」指公开资料中提供了相应资产，不等于已验证当前环境能跑通。官方项目的事实与对 saveslot 的适配判断分开写；后者都是本报告的判断。

## 0. 结论先行

**社区不只有 Memory QA benchmark。** 对 saveslot 最相关的几条路线是「真实工具环境中的数据修改」「跨会话依赖任务」「更新 / 记忆到行动诊断」，而不是只在 LoCoMo 与 LongMemEval 二选一。

| 定位 | 优先看 | 选择它的主要理由 | 复用前最重要的边界 |
|---|---|---|---|
| L1 内核 | Jepsen / Porcupine，辅以 Elle、sqllogictest | 并发历史、故障与独立模型 / 差分判定 | 是工具和方法，不是现成的 saveslot 题库或排行榜 |
| L2 接入 | **MCPMark Verified** | schema 探索、真实结构化 CRUD、程序检查终态 | 改成 saveslot 工具后只能报 derived suite；不是跨会话维护 |
| L2 接入 | **ToolSandbox** | 有状态前提、错误恢复、无关数据不变、里程碑 / 禁区 | 不是只判最终 DB；多轮不等于多会话或并发 |
| L3 长期任务 | **MemoryArena** | 多会话依赖前序选择与状态，确有后续行动 | 各领域判定不同，默认自动添加 trace 不等于主动选择写入 |
| L2 / L3 桥接 | **Mem2ActBench** | 用历史信息补当前工具参数，而非仅回忆事实 | 主要是生成 / 参数匹配，没有执行后状态判定 |
| 更新诊断 | **MemoryAgentBench 子集** | 分 chunk 增量注入、FactConsolidation 单 / 多跳 | 新序号优先不等于并发冲突或隐私删除 |
| 产品任务方法 | AppWorld、τ 系列、Microsoft STATE-Bench | 可执行业务工具、实际任务状态与流程约束 | 多为 task-local DB，不是同一用户的跨任务数据历史 |
| 社区交叉回归 | LongMemEval cleaned / V2、LoCoMo、BFCL 相关赛道 | 更新、时间、拒答、跨会话 memory 或工具能力有可复用资产 | QA / 参数分数不证明来源、冲突、删除与重放正确 |

**建议先精读 / 小规模试验三项：MCPMark、ToolSandbox、MemoryArena。** 用 Mem2ActBench 与 LongMemEval cleaned 补诊断和社区交叉对照。不要因为其他项目名称有 state / agentic / conflict，就认定其已经验证持续状态维护。

本次未发现一套现成统一协议覆盖 saveslot 的全部承诺。合理方向是**借社区任务与判定器，复用已有 eval 和测试矩阵的语义断言，另列社区适配赛道；原分数与附加检查分开**。第 6 节逐项说明与现有定义的关系。以下适配度和优先级都是研究判断，不是已经跑出的结果。

## 1. 如何判断相关，而不是只判断名字像不像 Memory

saveslot 的核心不调用模型。选择记录什么、理解用户的话、生成写入与查询由 Agent 负责；saveslot 维护有 schema 的数据、来源、版本、时间与冲突等确定性规则。因此必须分开三层：

| 层 | 被测对象 | 核心问题 | 不应拿来替代它的分数 |
|---|---|---|---|
| L1 内核正确性 | saveslot 的操作契约、内核与存储实现 | 同样输入是否得到定义中的状态；并发、故障、删除、重放是否符合保证 | Agent 的答题正确率 |
| L2 Agent 接入 | 模型 / 宿主 + 工具描述 / 回执 + saveslot | 能否发现 schema、正确读写、处理报错、在该读写的时候调用工具 | 仅仅输出合法 JSON 的比例 |
| L3 长期任务 | Agent + 数据层 + 跨会话任务环境 | 多次交互、数据变化以后，任务是否做成，用户的数据是否正确 | 只问一句历史问题的 QA 总分 |

本次对每个候选检查六件事：

1. **实际评测单位**：一个问题、一次工具调用、一场交互任务，还是多个互相依赖的会话。
2. **输入与持久性**：给离线全部历史，还是逐步观察；会话之间保留哪些状态。
3. **判定依据**：答案文本、函数名 / 参数匹配、环境状态、执行轨迹，还是独立参考模型。
4. **状态变化语义**：仅追加事实，还是更新、纠错、删除；是否区分业务时间与记录时间。
5. **公开资产**：数据、环境、运行器、判定器是否公开；是否依赖在线服务或模拟用户。
6. **比较边界**：原样运行、只接入新的 memory backend，还是重写工具与环境。

### 复用方式的三个不同含义

- **原协议接入**：保留原任务、工具、环境、信息可见性与判定，只更换允许插拔的组件。即使如此，模型、提示、预算、版本不同也不能随意横比。
- **数据 / 环境适配**：把任务迁移为 saveslot 的 slot、schema、操作。可以测接入和任务质量，但必须标明 adapted；不是原榜单成绩。
- **方法借鉴**：借用最终状态判定、里程碑、故障注入、反例生成等设计，不声称跑过原 benchmark。

**Memory benchmark 不要求系统原样存下全部历史。** 它们通常要求回答范围内的问题；系统可以选择、压缩、结构化存储。saveslot 与它们的主要错位是覆盖承诺和组件边界，而不是「用了 schema 就必定低分」。

## 2. L1：更成熟的是正确性工具，不是 Agent 排行榜

### 2.1 Jepsen + Porcupine：并发历史与故障下的契约正确性

**官方事实**：

- [Jepsen](https://github.com/jepsen-io/jepsen) 是测试框架：生成并发操作、记录调用历史、注入故障，再用 checker 判断历史是否合理。它不是一个固定题库或统一分数。
- [Porcupine](https://github.com/anishathalye/porcupine) 接收可执行的顺序规范和并发调用 / 返回历史，检查是否存在符合实时先后关系的合法串行执行，并能可视化反例。

**对 saveslot 的价值（判断）**：

- 用独立模型描述 `read → write(ver)`、同字段竞争、冲突候选、确认等操作；检查多个客户端观察到的结果能否由契约解释。
- 借鉴 Jepsen 的故障与历史记录方法，测试崩溃、重启、请求超时、重试后的持久性和幂等行为。
- 第一版是单节点，不需要为了采用 Jepsen 而搭一个多节点复制系统；优先借生成器、记录方式与判定思路。

**边界**：必须先确定被检查操作的原子性、超时语义与实际承诺的一致性模型；不能因为用了 checker 就自动宣称整套 API 线性一致。Porcupine 本身也不注入故障、不检查来源血缘或隐私删除。复用方式是**方法 / checker 适配**，不是原榜单参赛。

### 2.2 Elle：事务异常检测，有价值但不是优先接入项

**官方事实**：[Elle](https://github.com/jepsen-io/elle/blob/main/README.markdown) 根据黑盒客户端观察到的事务历史，推断依赖关系、检测事务隔离异常；可与 Jepsen 一起使用，也可独立调用。现成模型主要是读写寄存器与 list-append；官方明确说明它不完备，并建议人工复核报告的异常。

**对 saveslot 的价值（判断）**：适合检查能清楚映射为事务读写的底层路径，尤其是异常历史的最小反例与可视化。

**边界**：saveslot 的「写入已接收但成为候选、当前值未变化」不等于普通数据库的已提交覆盖写。必须先建模；不能直接把业务日志当 Elle 事务输入。来源、双时间、删除与派生一致性仍要由自己的参考求值器负责。

### 2.3 sqllogictest：受限 SQL 与后端对拍的局部资产

**官方事实**：[DuckDB 的 sqllogictest 文档](https://duckdb.org/docs/2.0/dev/sqllogictest/intro.html) 展示了自包含脚本：执行 SQL，断言成功、报错或具体结果；其 query verification 还比较优化与非优化执行结果。该格式源自 SQLite，并非 Agent benchmark。

**对 saveslot 的价值（判断）**：借用输入 / 期望结果夹具和差分验证方法，覆盖受限 SQL、聚合、排序、空值、单位相关表达式及后端一致性。

**边界**：不能把全部 SQL 测试直接交给 saveslot——受限 SQL 的允许集合、时间语义与普通数据库不同。它也不覆盖操作契约、来源链或删除重放。适合**方法与兼容子集的测试数据复用**，不值得为了采用这个格式而替换既有 Vitest / fast-check 测试框架。

### 2.4 L1 的结论

本次核查中，**没有找到一套现成、统一覆盖 saveslot 的双时间 + 字段来源 + 持久冲突 + 派生 + 隐私删除 + 重放语义的社区 benchmark**。这不是对全部文献不存在性的证明。

现有 [`../spec/02-architecture.md`](../spec/02-architecture.md) 已规定独立参考求值器、性质测试、双后端和重放对拍；这些仍应是 L1 的主体。社区工具可以增强并发历史、故障与差分检查，不替代该定义。

## 3. L2 与任务型 Agent：不止 Memory，已有真实状态基准

### 3.1 MCPMark Verified：最贴近 schema 发现与结构化 CRUD

**官方事实**：[README](https://github.com/eval-sys/mcpmark)、[任务格式](https://github.com/eval-sys/mcpmark/blob/main/docs/datasets/task.md) 与[论文](https://arxiv.org/html/2509.24002)定义一个任务为自然语言说明、初始环境和 `verify.py`。Agent 经 MCP 取得工具 schema，操作文件、Notion、GitHub、Postgres、网页等环境；判定器检查实际最终状态，不要求复现一条指定调用轨迹。standard 与 easy 是不同赛道，不能混计。

具体例子：

- Postgres 的 [employee_project_tracking 指令](https://github.com/eval-sys/mcpmark/blob/main/tasks/postgres/standard/employees/employee_project_tracking/description.md)要求建表、约束 / 索引、插入、更新和改列；[判定器](https://github.com/eval-sys/mcpmark/blob/main/tasks/postgres/standard/employees/employee_project_tracking/verify.py)查询实际 schema、索引和行，而不是只判断生成 SQL 的文本。
- Notion 的 [swap_tasks](https://github.com/eval-sys/mcpmark/blob/main/tasks/notion/standard/team_projects/swap_tasks/description.md)要求找出任务最多与最少的人并交换任务；[判定器](https://github.com/eval-sys/mcpmark/blob/main/tasks/notion/standard/team_projects/swap_tasks/verify.py)检查真实分配属性。

**可用性与版本**：任务、判定代码和运行器公开；Notion / GitHub 需要专用测试资源，Postgres 需要初始化数据。当前默认是 **MCPMark Verified**；官方将此前任务版本的成绩标为过时，必须固定任务版本和 MCP server 版本。Verified 表示经过维护者审核，不表示每个判定器都完整：固定 ID、只查数量等断言仍应做反例审计。

**saveslot 适配判断**：优先抽联系人、任务、项目等结构化 CRUD，保留任务意图，映射成 slot、schema、目录发现与读写，再写独立状态判定器。**SQL DDL、索引调优不是 saveslot 的能力，不应硬迁移**，更不能让 Agent 直接改 saveslot 内部数据库绕过契约。

**边界**：原任务按次初始化 / reset，不是跨独立会话的长期维护或多个 Agent 并发。改为 saveslot 工具后属于 **MCPMark-derived suite**，不是原榜单成绩。若原样跑 Postgres MCP，证明的只是该 Agent 会用 Postgres MCP，并未测到 saveslot 后端。

### 3.2 ToolSandbox：接入理解、状态前提与错误恢复

**官方事实**：[README](https://github.com/apple-aiml-research/ToolSandbox)与[论文](https://arxiv.org/html/2408.04682v2)中，一个 scenario 包含初始状态、消息、可见工具、milestones 与 minefields。工具由 Python 类型提示和 docstring 生成描述；设置、联系人、消息、提醒等状态可实际增改删，每轮存快照。判定结合里程碑 DAG、状态变化、必要调用 / 回复，以及「无关数据不应变化」等 guardrail；触发 minefield 会使任务失败。不是只比最终 DB hash，也不是逐步匹配整条 gold 轨迹。

与 saveslot 特别相关的内容：

- 工具 / 参数改名、干扰工具、说明缺失等变体，能检验 Agent 是否真的读懂接口。
- 异常返回 Agent 后继续执行，例如发送失败、修复所需设置、再试。
- 信息或工具不足时，不应编造参数或随意执行。
- 联系人 / 提醒的新增、修改、删除与无关状态保持不变。

**可用性**：scenario、执行环境和判定公开；联系人 / 提醒等本地子集较容易复现，部分搜索依赖 RapidAPI，模拟用户和 Agent 需要模型。项目采用[自定义 LICENSE](https://github.com/apple-aiml-research/ToolSandbox/blob/main/LICENSE)，复制 / 发布派生资产前需单独检查，不应按 MIT / Apache 默认处理。

**saveslot 适配判断**：L2 高优先级。先借 **milestone / minefield + 错误恢复 + 不相关数据不变** 的方法，再迁移小规模 CRUD 场景。

**边界**：不是运行时 schema registry 发现 benchmark；状态快照是评测记录，不等于验证事件重放。episode 内 stateful、多轮与 DAG 的无先后约束，都不等于跨会话或并发事务。

### 3.3 AppWorld：完整任务成功与 collateral damage

**官方事实**：[README](https://github.com/StonyBrookNLP/appworld)和[论文](https://arxiv.org/html/2407.18901)描述多个日常 app 的本地可执行 API 环境。每题有独立数据库与时钟；Agent 可按需查询 API 文档，实际读取或改变应用状态。判定由程序测试检查初末 DB 的变化：既要完成目标，也不能破坏不相关数据；部分 QA 任务还检查最终答案。TGC 是任务全测试通过，SGC 是同一 scenario 的多个变体通过，不是跨会话成功率。

**可用性**：有环境、API、任务数据和判定器，当前 README 还提供 MCP 接入。需要安装 / 下载数据；部分题目资产受防污染的加密 bundle 和额外再分发条件约束，不能假设能把派生题库明文公开。

**saveslot 适配判断**：适合借鉴 **初末 DB diff + 防止 collateral damage**，或选「读取消息 / 邮件 → 维护结构化清单 / 联系人 → 更新 / 删除」的小任务。也可保留原环境，把 saveslot 用作 Agent 的辅助数据层，评估组合系统任务收益。

**边界**：每题重置，不是原生长期多会话 benchmark；多个 app 中有多个人物，不等于多个 Agent 并发。整体替换所有 app 后端成本很高，没有必要为了跑榜重建一组产品。改变工具 / 后端后只能报适配结果；公开发布派生资产前需检查其许可。

### 3.4 BFCL：挑 Multi-Turn 与 Memory，不采用 Overall 作为数据底座分数

**官方事实**：[榜主页](https://gorilla.cs.berkeley.edu/leaderboard.html)、[赛道清单](https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/TEST_CATEGORIES.md)、[V3 Multi-Turn 定义](https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html)和[V4 Memory 定义](https://gorilla.cs.berkeley.edu/blogs/16_bfcl_v4_memory.html)区分了两类相关测试：

| 赛道 | 实际测什么 | 判定和边界 |
|---|---|---|
| Multi-Turn 的 base / miss_func / miss_param / long_context | 在有状态模拟 API 中，多轮探索、取得缺失信息、调用工具 | [实际 checker](https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/multi_turn_eval/multi_turn_checker.py)检查每轮后端状态与必要执行结果；不只是 JSON / 参数 AST。多轮不等于跨会话 |
| V4 Memory | 多会话中主动维护 memory，再从快照恢复、无原聊天历史地答题 | 支持 KV / vector / recursive summary；最终主要检查答案。memory 删除是否正确只可能间接影响问答，不验证来源级联或物理删除 |

**版本**：本次读到正式榜为 V4，主页标注 `Last Updated: 2026-04-12`，并给出复现 commit `f7cf7359b7ac615a0b294831c5ba2bc95ee4a000` / `bfcl-eval==2025.12.17`。不能用仓库 main 或数据文件名推断同一榜单版本。

**saveslot 适配判断**：适合作为较小、可诊断的补充题集；尤其是缺信息 / 缺函数和 memory 跨会话恢复。数据、模拟后端与 scorer 公开，但 BFCL 原本评模型及固定 scaffold；换成 saveslot 的工具、搜索或容量语义后应独立报告，子集准确率不能冒充 Overall。

### 3.5 τ 系列：任务数据库、业务策略与工具发现

**官方事实**：旧 [τ-bench 仓库](https://github.com/sierra-research/tau-bench)已提示任务过时；当前维护在 [tau2-bench](https://github.com/sierra-research/tau2-bench)。一次评测是任务、模拟用户、Agent 与工具环境的一场交互；状态在任务内持续改变。[评测定义](https://github.com/sierra-research/tau2-bench/blob/main/docs/evaluation.md)按 `reward_basis` 组合 DB、沟通等判据；airline / retail / telecom 的 DB 判定不要求复现唯一调用轨迹。

- τ² 的 telecom 支持用户和 Agent 双方通过工具改变共享环境；这不等于多个工作 Agent 并发维护同一 slot。
- [τ-Knowledge / banking](https://arxiv.org/html/2603.04370)尤其值得看：部分工具隐藏在文档中，需要检索发现后调用，也有真实业务状态修改和中途澄清 / 更正。
- 不能把整个评测称为纯确定性：当前版本的沟通判定等可能使用 LLM judge，即使 DB 工具与状态比较是确定性的。

**版本注意**：本次读取[官方 releases](https://api.github.com/repos/sierra-research/tau2-bench/releases?per_page=5)时，最新正式 release 是 **v2.0.0**；τ³ 对应更早的 v1.0.0，1.x 比较应固定 v1.0.1。2.0 改变了任务 / 提示 / 用户与判定等，官方说明与 1.x 不直接可比。[提交规则](https://github.com/sierra-research/tau2-bench/blob/main/docs/leaderboard-submission.md)还明确区分标准 scaffold 与 custom 改动；当时 2.0 text-v1 包可验证，但尚无对应 text leaderboard tab，不能从 README 的概述推断已有该榜单。

**saveslot 适配判断**：适合借策略遵循、发现操作约束、应写 / 不应写与任务最终状态；需要模拟用户等额外成本。若改业务工具为 saveslot generic tools，是 derived suite；若保留环境而增加 saveslot memory，也属于需要披露的系统 / scaffold 改动。

**边界**：每任务 / trial 从初态开始，不原生测试长期多会话、来源链、双时间或冲突重放。取消订单、冻结卡、销户也不是源数据隐私删除。

### 3.6 其他候选的筛选结果

- **[AgentBench DB](https://github.com/THUDM/AgentBench)**：并非只有 SELECT；[任务实现](https://github.com/THUDM/AgentBench/blob/main/src/server/tasks/dbbench/task.py)中 INSERT / UPDATE / DELETE 可检查指定表状态。适合借 SQL CRUD 判定，但偏 SQL 操作而非选择性记录与长期维护，优先级低于上述候选。
- **[AgentBoard](https://github.com/hkust-nlp/AgentBoard)**：Tool-Operation 含真实 Todoist / Sheets 操作，但[Todo 环境](https://github.com/hkust-nlp/AgentBoard/blob/main/agentboard/environment/todo_env.py)与[Sheet 环境](https://github.com/hkust-nlp/AgentBoard/blob/main/agentboard/environment/sheet_env.py)的 progress / reward 不等于严格最终状态全量相等。适合借进度诊断方法，不优先作为终态主指标；真实账号环境必须隔离。
- **[CRMArena-Pro](https://arxiv.org/html/2505.18878)**：虽有 Workflow / Rectification 名称，论文 §3.5 所述接口主要是 SOQL / SOSL 读取，不能据名称把它归为 CRUD 终态维护 benchmark。

## 4. L3：长期记忆不只有聊天 QA，但要看是否真的执行任务

### 4.1 MemoryArena：最接近跨会话任务成功的主锚

**官方事实**：[仓库](https://github.com/ZexueHe/MemoryArena)、[论文 v2](https://arxiv.org/html/2602.16313v2)和[数据卡](https://huggingface.co/datasets/ZexueHe/memoryarena/raw/main/README.md)提供购物、旅行、渐进搜索、数学和物理等多会话任务。评测单位是有依赖关系的子任务 / 会话组：前面的选择、计划或结论会约束后续任务。Agent 逐步行动、获得反馈，不是预先把未来完整轨迹都交给模型。

但各领域的实际执行与判定不同：

- [购物](https://github.com/ZexueHe/MemoryArena/blob/main/setup_web_shopping.md)真实执行 search / click，再评商品选择；部分属性判定默认用 LLM judge，也提供字符串匹配选项。
- [旅行](https://github.com/ZexueHe/MemoryArena/blob/main/setup_travel.md)生成结构化计划，与目标按人 / 时段 / 组比较；不是实际下单或提交业务 DB。
- 搜索 / 推导仍有答案型判定。因此不能把全套称为统一的确定性数据库终态 benchmark。

**主动写入边界**：[旅行运行代码](https://github.com/ZexueHe/MemoryArena/blob/main/run_travel.py)与 memory 接口显示，默认路径会由 harness 在会话后自动添加 trace，memory client 主要提供 `wrap_user_prompt` 与 `add`。可以研究选择性抽取策略，但这不自动等于评测 Agent 自己决定「何时、什么该写」。

**可用性**：代码与数据公开，README 称 preview；运行需准备对应任务环境和数据，不能把公开等同即刻跑通。

**saveslot 适配判断**：第三层最高优先级，先选旅行或购物一个领域，把约束、已作决定、当前计划等映射为 schema，测组合系统的跨会话任务收益。仍需另补纠错 / 撤销、缺信息拒答、共享多 Agent、崩溃与删除重放；不能拿原任务分数证明这些保证。

### 4.2 Mem2ActBench：记忆到工具参数的桥接，不是执行成功

**官方事实**：[仓库](https://github.com/Cantaloupe-M/Mem2ActBench)、[ACL 论文页](https://aclanthology.org/2026.acl-long.370/)与[论文正文](https://arxiv.org/html/2601.19935v1)提供 400 个工具调用生成任务。当前请求省略部分参数，需要从多会话历史中恢复；公开[小版数据说明](https://github.com/Cantaloupe-M/Mem2ActBench/blob/main/Mem2ACTBench_small/README.md)和 JSONL。

**实际判定**：论文定义为条件生成工具调用；主实验直接提供 gold tool，主要衡量参数 grounding，以 F1 / BLEU / Tool Accuracy 等评分。**并未执行工具再验证业务状态**。

**saveslot 适配判断**：很适合第二层与第三层之间的诊断——查询到的 schema 数据能否补全当前操作参数；比直接问「用户以前说了什么」更贴实际使用。若要升为 L3，需增加 executor 和状态后置条件，分开报告新增结果。

**注意**：`source_conversation_ids` / `grounding_info` 等只能用于判定；README 按证据 ID 取历史是 oracle 便利路径，不能泄漏给正式 E2E。规范化脚本的某些 conflict 标签由「同属性有多个来源」推得，不能等同严格的纠错、值冲突或来源可信度 oracle。

### 4.3 MemoryAgentBench：增量更新与旧事实干扰诊断

**官方事实**：[仓库](https://github.com/HUST-AI-HYZ/MemoryAgentBench)、[论文](https://arxiv.org/html/2507.05257)和[数据卡](https://huggingface.co/datasets/ai-hyz/MemoryAgentBench/raw/main/README.md)将长 context 分 chunk 注入系统，再做 QA、分类、推荐、摘要等。系统最终经历该 context，但不要求一次全塞进模型上下文；数据与代码公开。

最相关的是 FactConsolidation 单跳 / 多跳子集：[模板](https://github.com/HUST-AI-HYZ/MemoryAgentBench/blob/main/utils/templates.py)明确以**序号较大的新事实优先**。论文的 Selective Forgetting 与当前材料的 Conflict Resolution 都不能理解为物理删除，也不是 saveslot 的并发冲突处理。

**saveslot 适配判断**：适合更新后旧事实不应继续主导回答的辅助回归。无需把电影推荐、全书理解等全部当主指标。实际仍主要判答案；固定触发摄入不等于监督主动写入，也不检查底层当前状态、来源或删除。

### 4.4 MemTrack：跨平台主动查证，完整 harness 可用性未核实

**官方事实**：[论文](https://arxiv.org/html/2510.01353)与[官方介绍](https://www.patronus.ai/blog/memtrack)使用 Slack、Linear、Git / 代码等事件时间线，在同一环境中顺序提出相关问题。Agent 不直接收到整条时间线，需要经工具检索、对照噪声、矛盾与更正。某些 baseline 暴露 `search_memory` / `store_memory` / `get_memories`，确实能观察主动记忆工具选择。

**实际判定**：简短答案正确性、效率和重复调用；不是修改 ticket 或提交代码后的业务状态检查。

**可用性边界**：论文提供的[数据 ZIP](https://drive.google.com/file/d/1ymMXmOIhCUcwC1WKOW8kioZgeYyrt-qe/view?usp=sharing)可访问；本次读取时博客的 GitHub / Hugging Face 按钮是占位链接，**未核实完整可运行 harness 已开源**。

**saveslot 适配判断**：来源、变化追踪和主动查证场景很有价值；先作为场景研究，不立刻承诺整套可复现运行。

### 4.5 LongMemEval cleaned 与 LoCoMo：保留为社区交叉对照

| 候选 | 官方协议 / 代码中实际测到的 | 对 saveslot 的价值与限制 |
|---|---|---|
| [LongMemEval cleaned](https://github.com/xiaowu0162/LongMemEval) | 每题一个带时间戳的多会话 haystack；抽取、跨会话、更新、时间与拒答。可用完整、RAG 或 oracle 历史；判 QA / 证据召回 | 更新、时间、拒答的现成辅助集；不检查当前结构化状态、版本或主动读写 |
| [LoCoMo](https://github.com/snap-research/locomo) | 常用发布是长对话 QA，含多跳、时序、adversarial；原设计还有事件总结和多模态生成 | 事件抽取与熟悉的社区对照；没有受控纠错 / 删除操作或 after-state 判定，不宜作 L3 主锚 |

两个值得单独保留的核实结果：

- [LongMemEval 判题源码](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py)的更新题允许同时提及旧信息，只要包含所需的新答案。因此**答对更新题不证明旧值已经被正确淘汰、纠错已传播**。`has_answer` / `answer_session_ids` 是标签，不可作为摄入输入。
- [LoCoMo README](https://github.com/snap-research/locomo/blob/main/README.MD)当前主发布是 10 段对话，不应混用早期论文版本的规模；其非 QA 评测仍标 Coming soon。不能因为论文设计有三个任务，就假定三套可执行评测都已发布。

使用 LongMemEval 应固定 cleaned 数据版本，并与 oracle 结果区分。saveslot 的新状态断言只能作为额外报告，不能改写原 QA 分数的含义。

### 4.6 LongMemEval-V2：Agent 轨迹不等于 Agent 任务执行

**官方事实**：[仓库](https://github.com/xiaowu0162/LongMemEval-V2)、[论文](https://arxiv.org/html/2605.12493)与[数据 schema](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/raw/main/SCHEMA.md)使用真实 agent 轨迹，含截图、AX tree、动作和结果。memory backend 通过 `insert` 摄入所选 haystack 的完整轨迹，`query` 返回紧凑证据，固定 reader 作答。

**实际评测单位仍是问题**：答案准确率、查询延迟；不是让 Agent 重新执行浏览器任务，也不验证新的业务状态。dynamic state tracking 在这里是理解状态—动作变化，而不是底座 mutation 正确性。[判题代码](https://github.com/xiaowu0162/LongMemEval-V2/blob/main/evaluation/qa_eval_metrics.py)的 premise awareness 要求指出错误前提，泛泛 `UNKNOWN` 并不合格，不能直接和 V1 的 abstention 混为一类。

**saveslot 适配判断**：可接 `insert/query` adapter，研究复杂轨迹里哪些证据应按 schema 保存，以及如何查询；数据代码和截图公开，但规模和摄入成本高于一个小型 CRUD suite。没有规范化的业务 / 记录双时间、并发或删除语义。

[AgentRunbook-C V2](https://xiaowu0162.github.io/longmemeval-v2/agentrunbook-c-v2/)等是同一 benchmark 上的方法扩展，查询后整合检索策略也仍在 QA 协议内；不要把它们数成多个独立社区 benchmark。

### 4.7 Microsoft STATE-Bench：真实任务状态，但 learning track 是离线经验检索

**官方事实**：[仓库](https://github.com/microsoft/STATE-Bench)含 travel / support / shopping 等任务，各自有 task-local DB、业务工具、模拟用户；判最终数据库状态和必要会话流程。这比纯 QA 更接近任务成功。

但 [Agent Learning Track](https://github.com/microsoft/STATE-Bench/blob/main/docs/AGENT_LEARNING_TRACK.md) 是训练轨迹 → 离线生成 learnings → held-out 任务中只读检索；[自定义 memory hook](https://github.com/microsoft/STATE-Bench/blob/main/docs/memory/custom-hook.md)不代表在线修改用户业务状态。任务数据库不跨任务持续共享。

**saveslot 适配判断**：可研究任务判定器、更新 / 取消与流程约束；若仅把 saveslot 接作 learnings 检索，测的是程序经验迁移，不是持续业务记录维护。公开代码 / 数据可研究，但跨会话的选择性写入需要新增协议。

### 4.8 观察项：接近维护语义，但不能先许诺可跑

- **[TARL-Mem](https://arxiv.org/html/2608.03699v3)**：statement + 当前 ledger → append / noop / revise / reject / defer，再执行确定性 ledger 操作、比较 gold next-state 与序列 rollout。比仅预测 Use / Ignore 等策略标签更贴近维护正确性；本次未定位官方可下载代码 / 数据，不作为立即可跑的推荐。
- **[VitaBench: Memory Lifecycles Beyond Retrieval](https://arxiv.org/html/2610.14731)**：研究 keep / compress / consolidate / delete 的长期效用与成本，用相同后续流比较记忆策略。值得借鉴选择性记录方法，但不是完整业务 Agent 环境，公开运行资产本次未核实；不要与其他同名 VitaBench 混淆。
- **[Parslee StateBench](https://github.com/parslee-ai/statebench)**：与上面的 Microsoft STATE-Bench 不是一个项目。场景涉及 supersession、repair、scope、deletion，但作者披露旧评分与生成缺陷，旧榜与当前代码不兼容。可借场景，不用其历史排名作为稳定背书。
- **[MemoryPolicy-Bench 相关审计](https://arxiv.org/html/2608.17247v1)**：明确只评 Use / Ignore / Update / Ask 分类，不执行回复、工具或 memory mutation。方法上提醒要审计数据捷径与反事实一致性，不能作为维护任务成功率。
- **[MemoryBank](https://github.com/zhongwanjun/MemoryBank-SiliconFriend)**：是记忆机制 / 伴侣系统，含历史、代码与 probing questions；不等于 MemoryAgentBench，也不是受控删除与纠错的独立任务标准。

## 5. 复用时必须保留的比较纪律

### 5.1 原榜单、适配任务与自定义语义分开报

以下三种结果不能混成同一个「benchmark 得分」：

1. 原环境中，只接入 saveslot 支持的 memory / storage adapter。
2. 把原任务改写为 saveslot schema、MCP 工具与确认流程。
3. 原任务上新增来源、删除、冲突或重放等断言。

第 2 种是 adapted suite，第 3 种是新增测试赛道；都应独立命名并公开改动。尤其不能把「能直接改 Postgres」和「必须读版本、提供源数据、处理确认」当成完全相同的工具环境。

### 5.2 防止题目与证据泄漏

- 在测试问题不可见时定义 schema 和记录策略；如果允许动态 schema 演进，单列赛道并记录代价。
- 按时间让 Agent 观察历史；不要在入库时使用测试问题、答案、答案所在会话或证据标签。
- 将数据集自带的 oracle / answer-session 信息只用于判定和诊断，不作为在线摄入提示。
- 对限定领域的适配，同时报告预先定义的覆盖率与范围内成绩。原全量协议下的失败不能事后删除或重新解释为原榜单的高分。

### 5.3 除了「最后答对」，还要知道哪里错

在同样模型、任务和可用输入下，至少区分：

- **范围外**：产品事先不承诺记录的信息。
- **没写 / 写错**：范围内信息没有进入正确状态。
- **没读 / 用错**：状态正确，但 Agent 未读或使用了旧值。
- **底座违约**：操作合法，但结果与契约或独立参考模型不符。

同时报告成功率、安全违反、未作答、写入与读取调用、token、摄入成本、查询成本和延迟；不能只报回答阶段成本而省略模型抽取与建索引成本。

### 5.4 安全补充：AgentDojo

[AgentDojo](https://github.com/ethz-spylab/agentdojo) 提供任务环境和 prompt injection 攻防评测，适合补充 L2 的不可信工具结果边界。其 [banking 用户任务代码](https://github.com/ethz-spylab/agentdojo/blob/main/src/agentdojo/default_suites/v1/banking/user_tasks.py) 中既有检查最终交易 / 定时支付状态的任务，也有断言信息不足时环境不变的任务；[攻击任务代码](https://github.com/ethz-spylab/agentdojo/blob/main/src/agentdojo/default_suites/v1/banking/injection_tasks.py) 则检查攻击目标是否实现。

对 saveslot 可借鉴的场景：把恶意指令放进读出的源数据或备注，检查 Agent 是否仍按用户任务行事，是否进行了未经要求的写入、删除或泄露。需要把「正常任务完成」和「攻击成功」分别判定；一律拒绝工具不能算既安全又有用。

但**有程序 verifier 不等于 verifier 足够强**：上述 `banking/user_tasks.py` 的 `UserTask8.utility` 明确只是让 Agent 查看交易记录，直接返回 `True`，没有判摘要是否正确。不能把这种通过当作数据正确性证据。移植任何社区任务前，都应逐条回答：这个断言在什么错误输出或错误状态下会失败？

## 6. 选型建议与真正的缺口

### 与现有 eval 和测试矩阵的关系

**社区任务补充既有验收，不重新定义它。** [`10-evals.md` 第 1 节](../spec/10-evals.md#1-eval-是什么测什么)已区分 Agent 是否发出对的调用与内核是否正确；后者由 [`02-architecture.md` §11「测试矩阵」](../spec/02-architecture.md#测试矩阵)的独立参考求值器、性质测试、双后端和重放对拍负责。下表中的「已有」指规格已定义，不表示本报告验证了其实现。

| 社区候选 | 对应已有 eval / 测试 | 可以增加什么，不替代什么 |
|---|---|---|
| MCPMark | [eval 1：发现数据](../spec/10-evals.md#4-eval-1--发现数据)、[eval 2：纠错](../spec/10-evals.md#5-eval-2--纠正一条记录)、[eval 6：删除](../spec/10-evals.md#9-eval-6--删除)的发现、改值与删除交互 | 外部领域的 CRUD 任务来源和实际状态判定器。迁移后仍需补既有的意图、版本、源数据与确认断言；原 CRUD 不等于 saveslot 的纠错或隐私删除 |
| ToolSandbox | [eval 9：报错后恢复](../spec/10-evals.md#12-eval-9--报错后恢复)、[2c：指代不明](../spec/10-evals.md#2c-指代不明) | 更多状态前提、工具 / 参数扰动、milestone / minefield 及无关数据不变的检查；保留既有恢复与安全断言 |
| MemoryArena | [eval 10：写入的前提](../spec/10-evals.md#13-eval-10--写入的前提)、[eval 11：记录质量](../spec/10-evals.md#14-eval-11--记录质量)，尤其 11b 跨会话、11c 旧值干扰 | 在既有捕获、误写、主动读取和过期状态使用指标之外，增加依赖前序选择的多会话行动任务、环境反馈与整组成功率。默认自动添加 trace 不替代主动写入诊断 |
| Mem2ActBench | eval 10a 基于读取结果写入，及 eval 11 的数据取用诊断 | 用外部样本检查省略参数能否由历史补全；原参数匹配分数不替代工具执行与状态后置条件 |
| MemoryAgentBench、MemTrack | eval 11a 的捕获 / 误写与 11b、11c 的变化信息取用 | 增量上下文、旧事实干扰、跨来源查证的外部样本；不是新的删除或并发冲突判据。MemTrack 的完整运行资产仍未核实 |
| LongMemEval / V2、LoCoMo | eval 11 的记录与取用诊断；[eval 4](../spec/10-evals.md#7-eval-4--状态类写入)相关的时间信息理解 | 规模、措辞、时间 / 更新 / 拒答的社区对照。QA 结果不能替代结构化状态断言、双时间性质测试或证明纠错传播 |
| BFCL Multi-Turn / Memory | eval 9 的缺信息与恢复，以及 eval 11 的跨会话取用 | 固定 scaffold 下的工具变体、memory 快照恢复等诊断；保留原赛道评分边界，不替代内核测试 |
| AppWorld、τ 系列、Microsoft STATE-Bench | eval 1、2、6 的读写 / 删除交互及 eval 10 的依赖工作流 | 外部业务任务、初末业务数据变化、流程与不相关数据保护的判定方法；任务内状态不等于跨会话历史，不替代 saveslot 的来源与时间语义 |
| AgentDojo | [eval 7：提示注入](../spec/10-evals.md#10-eval-7--提示注入)，尤其 7a 源数据与 7c 字段值；误删恢复已有 7b | 正常任务与攻击目标配对的外部攻击场景、攻防比较方法；不重新规定安全线或撤回语义，弱判定器需先审计 |
| Jepsen / Porcupine / Elle | 测试矩阵中的内核一致性、冲突 / 时间性质、故障恢复 | 并发历史生成、独立顺序模型、故障调度及反例可视化；不替代来源删除的参考求值器或已有重放对拍 |
| sqllogictest | 测试矩阵中的双后端对拍 | 受限 SQL 兼容子集的外部输入 / 期望结果、差分验证方法；不替换既有测试框架或扩大允许的 SQL 集合 |

本文 §5.3 的失败定位也不另起一套验收：没写 / 写错复用 eval 11 的捕获、漏写、记错与误写指标，没读 / 用错复用主动读取率、过期状态使用率及未作答数；「范围外」按事先声明的范围单列，「底座违约」由内核测试确认。它与现有 eval 的「描述 / 回执 / 规则」归因角度不同，可以交叉记录，不能互相替代。社区任务有额外分数时，与既有指标并列报告，不擅自改通过线；eval 11 仍按规格只出数字、不设通过线。

### 6.1 先验证什么，而不是先追一个总分

建议把下列内容作为小规模复用试验，而非立即更改现有验收；「第一批 / 第二批 / 第三批」仅表示本次调研与试验的建议顺序，**不是开发阶段、排期或验收门槛**：

| 建议顺序 | 试验 | 要回答的问题 | 不承诺什么 |
|---|---|---|---|
| 第一批 | MCPMark / ToolSandbox 各挑少量可映射任务，保留原始任务和独立判定的来源 | schema 发现、读写与回执是否让 Agent 做成任务；错误后能否恢复 | 迁移后的成绩与原榜单可直接比 |
| 第一批 | MemoryArena 选一个领域，以合法 memory 接口接入组合系统 | 跨会话依赖能否转化为实际任务收益 | 底座自身会选择记录；全部领域都有真实 DB 最终状态判定 |
| 第二批 | Mem2ActBench 的隐式参数 grounding | 已存信息能否正确支持当前工具调用 | 参数生成正确就等于执行成功 |
| 第二批 | MemoryAgentBench 的 FactConsolidation 更新子集；MemTrack 先研究场景 | 新旧事实与相关性选择是否正确 | 语义遗忘就等于物理删除及来源级联；MemTrack 全套已可复现 |
| 第二批 | LongMemEval / V2，分别报告原协议结果和事先定义的领域适配 | 与熟悉的 Memory 研究有一个可解释的交叉对照 | 该成绩充分体现 saveslot 的主要价值 |
| 第二批 | 并发操作历史 + 独立模型，借鉴 Porcupine / Jepsen | 多客户端和故障下的观察是否符合契约 | 引入框架即可覆盖所有不变量 |
| 第三批 | AppWorld / τ 系列，以及其他工具调用基准 | 产品任务、策略遵循和复杂 API 工作流的补充价值 | 模拟用户的多轮任务就等于多会话持久记忆 |

顺序是**本报告对 saveslot 调研 / 试验收益的判断**，不是对论文质量、社区影响力或模型能力的排名。第一批也仍需适配或外层 Agent；没有找到「只填 saveslot 地址就能测全项目」的现成套件。

### 6.2 复用已定义的语义场景，另列社区适配赛道

本次候选中，没有哪一个现成协议同时覆盖下列组合；但这些**不是 saveslot 规格尚未定义的新检查**。在社区任务上能做的是复用已有定义，添加附加断言、另列适配赛道：

| 场景组合 | 已有定义与分层 | 社区适配时补什么 |
|---|---|---|
| A 纠错后，B 不再使用旧值，并能查出旧读取的影响 | [eval 2a、2b](../spec/10-evals.md#5-eval-2--纠正一条记录)已有纠错、`affected_reads` 与 `possibly_affected`；eval 11b、11c 检查旧值使用，影响标记的正确性由测试矩阵负责 | 把既有工具 / 状态断言与取用指标放入外部任务，不重复发明纠错传播指标 |
| 多个 Agent 按不同版本改同一冲突单元，冲突保持可查询 | [eval 3a、3d](../spec/10-evals.md#6-eval-3--冲突)已有候选、事项及争议回执；测试矩阵已有冲突判定对称、不丢写入与争议标记等性质 | 外部任务中沿用候选与事项断言；业务上多种说法并存不直接算并发冲突 |
| 区分业务时间与记录时间，以及情况变化与纠错 | [eval 4a、4c](../spec/10-evals.md#7-eval-4--状态类写入)已有区间写入与纠错；[`history.as_of`](../spec/04-contract.md#history)契约与测试矩阵的时间片一致等性质已定义双时间查询 | 为外部问题补业务 / 记录时间映射及 Agent 的查询断言，不重定义双时间语义 |
| 基础数据纠错后，派生结果刷新且来源可解释 | eval 2a 的[完整夹具与断言](../spec/10-evals.md#25-文件格式)已有派生变化；[eval 8](../spec/10-evals.md#11-eval-8--证据映射)检查字段级证据映射；内核结果由测试矩阵保证 | 复用基础值、派生值、证据断言，独立报告外部任务成功，不把 QA 答对当派生刷新正确 |
| 隐私删除后状态与来源按定义处理，导出重放仍一致 | [eval 6](../spec/10-evals.md#9-eval-6--删除)检查预览、确认与影响转述，7b 检查撤回交互；删除求值、物理清理、导出与墓碑后重放由测试矩阵负责 | Agent 任务只扩交互与任务后果；参考求值器、性质测试和重放对拍继续留在 L1，不移进 Agent eval |

可研究的额外覆盖是**任务来源、组合方式与规模**，而非上述语义的重新定义：

- **更长的行动依赖链与外部基线**：eval 11 已有记录质量和隔天再问；MemoryArena 可增加依赖多次选择、连续环境反馈的行动任务，以及无持久层 / 不同数据层的整组成功率比较。
- **Agent 选择双时间查询的任务**：eval 4 主要检查写入；可以研究成对提问「现在知道的过去」与「当时知道的过去」，检查 Agent 是否选择了正确的 `as_of` / `valid_at`。底层语义与判定仍复用现有契约和时间性质测试。
- **多个真实 Agent 的并发工作负载**：eval 3 的另一方修改主要由脚本步骤制造，内核已有并发性质测试。可研究多个独立 Agent、不同调度与延迟下的任务行为，但不据此替代确定性冲突测试，也不误称社区原协议已有该能力。

以上是后续适配研究建议，**本报告不新增 eval、不修改规格、阶段或通过线**，也不能声称这些附加断言已经由原 benchmark 验证。

### 6.3 对比系统怎么选

- 固定模型、任务、可观察输入、会话重置方式和明确的预算。
- 至少有无持久数据层、文件 / 普通数据库、Memory 方案、saveslot 等基线；给各方案完成任务所需的同等输入，不故意限制某类方案的正常用法。
- 若基线也实现版本、来源或删除传播，就如实记录其额外实现和运行成本；不能预设普通数据库或 Memory 不可能具有这些能力。
- 自然语言输入端到端、正确结构化操作输入的内核测试、只读问答诊断分开报告，避免把抽取能力算成内核能力。
- 同时比较成功率、不可接受行为、状态断言和全流程成本，不用一个加权总分掩盖安全或正确性失败。

## 7. 未核实与不应过度解读的方向

- 搜索检索到关于 temporal belief reconstruction、bitemporal agent memory 的较新 Zenodo 材料，但原始页面访问受限，本次未核实完整评测协议和可执行资产；不将其作为推荐依据，也不把它们当作「社区已有共识」。
- 时态数据库的查询 / 性能 benchmark 即使支持 time travel，也不自动验证纠错、来源删除或 Agent 主动读写。
- 模型参数遗忘 / machine unlearning 的 benchmark 不等于源数据、历史版本与派生结果的删除正确性测试。
- 名称含 multi-agent、multi-turn、agentic、dynamic 或 conflict，不代表实际测试了并发写、跨会话持久状态、可执行修改或 saveslot 的冲突语义。必须读判定代码。
