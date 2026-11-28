# 12 · 开源 Agent 框架给扩展留的接入面

> 2026-11-28 调研，对应 issue #158，服务于讨论 #115 的情形 2（开发者在开源框架上自建 Agent，saveslot 以该框架自己的扩展形式接入）。相关：#74（宿主 hook 接入面）、#52（harness 会话来源）、[`../spec/05-surfaces.md`](../spec/05-surfaces.md) §10「增强」、[`../spec/06-cli.md`](../spec/06-cli.md) §3.4。本文是背景研究与建议，不修改规格，也不做任何扩展。
>
> **核实范围**：读各框架最新发布版本的官方文档与源码（链接锚定到读过的标签或提交），没有安装、运行这些框架，也没有写出 saveslot 适配。各框架的事实与对 saveslot 的判断分开写，后者标「判断」。没有版本号的文档页面（code.claude.com、developers.openai.com）是阅读当天线上的内容。第 6 节的来源均于 2026-11-28 阅读。

## 0. 结论先行

**1. 所有框架都能在进程内注册工具，并在工具执行时读到会话上下文。** 所以「适配层替模型填 `task`（以及将来 #52 的会话来源）」在每一家都做得到，只是落点不同：Pi 的 `prepareArguments` / `tool_call`，DSH 的 `exec.agent`，Claude Agent SDK 的 `PreToolUse` 返回 `updatedInput`，OpenAI Agents SDK 的 `tool_meta_resolver`，Vercel AI SDK 的 `toolsContext`，等等。

**2. MCP 服务器的 `instructions` 大多到不了模型，适配核心要自己取、自己放。**

| 处理方式 | 框架 |
|---|---|
| 原文进系统提示 | DSH（上限 32,768 字节，超出拒绝连接）、OpenCode、Claude Code 与 Claude Agent SDK（截到 4,096 字符） |
| 可选或只放一行 | Mastra（默认关，打开后每个服务器截到 512 字符）、Pi（每个服务器一行、250 字符；工具全为 `direct` 的服务器一行也没有） |
| 读得到但不放 | Vercel AI SDK（`client.instructions`）、OpenAI Agents SDK Python（存在 `server_initialize_result`，没有任何代码读它） |
| 丢弃 | OpenAI Agents SDK JS、LangChain 两个 MCP 适配包、Google ADK Python |

这印证了 #115 里定下的「情形 2 的扩展走 `/mcp`，会话开始时取工具和 `instructions`」：取到之后由扩展用各框架自己的系统提示接口放进去，不能指望框架转交。

**3. 生命周期分三档，「会话开始 / 压缩前 / 会话结束」三个点不是每家都有。**

- 有会话和压缩事件的完整 harness：Pi、OpenCode、Claude Agent SDK（TypeScript）、Claude Code、Codex。三个点都有对应事件，压缩前还能阻止或改写摘要。
- 有会话、缺压缩前事件的：DSH（压缩只有事后可观察的日志事件，会话结束只能观察）。
- 没有会话概念的 SDK：Vercel AI SDK Core、OpenAI Agents SDK、LangChain、Google ADK、Mastra。会话开始和结束要由开发者在自己的会话边界显式调用；压缩前只能挂在各自的压缩或裁剪机制上（OpenAI 的压缩 session 包装、LangChain 的 `SummarizationMiddleware`、ADK 的自定义 summarizer、Vercel 的 `prepareStep`），有的根本没有。

**4. #74 里成品宿主的 `mcp_tool` hook 在两头靠不住。** Claude Code 启动时（含 `--continue`、`--resume`）的 `SessionStart` 早于 MCP 连接，`mcp_tool` hook 被直接跳过，只有 `/clear` 和压缩之后的 `SessionStart` 才会调用；Codex 的 `SessionEnd` 不支持 `mcp_tool`，默认 1 秒、最多 3 秒；Claude Code 的 `SessionEnd` 默认共享 1.5 秒。判断：启动时的索引需要 #74 写的后备入口 `saveslot hook <event>`（command hook），会话结束只能做极快的入队，不能做网络往返。

**5. 没有一家为第三方扩展准备了「按终端用户解析凭据」的钩子。** SDK 一类能借请求级上下文做到（Mastra 的 `RequestContext` 与 MCP 客户端的 `fetch`、ADK 的 `header_provider`、LangChain 的运行时 `context`、OpenAI 的 `auth` / `tool_meta_resolver`、Vercel 的自定义 `fetch`）；harness 一类（Pi、DSH、OpenCode、Claude Agent SDK）凭据跟着进程或 profile 走，按用户隔离就是一个用户一个会话或一个进程。判断：适配核心应接受一个凭据解析函数，默认取本机 profile 或环境变量，#115 情形 3 时再换成按用户解析，工具注册和 hook 绑定都不用变。

**6. 对 #158 的三个问题的回答（判断）：**

- **共用适配核心的形状**：核心只做与框架无关的部分——连 `/mcp`、会话开始时取工具与 `instructions`、调用 `hook_*` 工具、按会话上下文填 `task`、凭据解析、预算与超时、边界标记原样保留；每个框架一个「写入器」，只负责把这些挂到该框架的工具注册、系统提示和事件上（第 5 节）。
- **先做哪几个**：Pi 先做（接入面最全，又恰好缺 `instructions` 转交，能把核心的每一块都用上）；其后 Claude Agent SDK（TypeScript 版几乎就是 Claude Code 的事件集，验证与 #74 共用一套 hook 契约）；再从无会话的 SDK 里挑一家（Vercel AI SDK 或 OpenAI Agents SDK），验证「开发者显式调用会话边界」这一形态。DSH 接入面足够，但仍是开发预览版、声明会有破坏性改动，且缺压缩前事件，适合放在 Pi 之后。
- **「一份清单生成各家适配」能否覆盖**：清单能覆盖静态部分（工具名前缀、事件到 `hook_*` 的映射、各事件的预算与超时、`instructions` 放在哪），覆盖不了代码：每家的扩展形态是一段要手写的模板（TypeScript 或 Python），清单只能填它的参数。覆盖不到的格子要在清单里显式写「无」：DSH 和 Vercel `HarnessAgent` 没有压缩前事件，无会话 SDK 没有会话开始与结束事件，Claude Agent SDK Python 没有 `SessionStart` / `SessionEnd` 回调。

## 1. 比较的是什么

saveslot 在 #115 情形 2 里需要框架提供的东西，按 #158 列的七问：

1. 扩展单元：开发者装或加载的是什么（包、插件、配置项），用什么语言；在框架之上自建 Agent（把框架当库用）时能否在代码里加载。
2. 工具：怎么注册；能否桥接 MCP 服务器的工具；MCP `instructions` 到不到模型；工具里能否读到会话上下文（替模型填 `task`）。
3. 系统提示：扩展能否追加，何时生效。
4. 生命周期事件：会话开始、恢复、分叉、压缩、停止、会话结束；处理器能否加上下文、多大；能否后台运行。
5. 会话与任务标识：框架能告诉扩展哪些关于当前会话、运行、任务的信息（#52 的输入）。
6. 凭据：扩展怎么拿到令牌，有没有按终端用户解析的入口（#115 情形 3 的输入）。
7. 用户要做的信任与安装步骤。

框架：先 Pi、DSH；再是 #115 点名的没有压缩运行时的 SDK（Vercel AI SDK、Claude Agent SDK、OpenAI Agents SDK）。比较中补了四个值得一行的：Mastra、LangChain / LangGraph、Google ADK、OpenCode。Claude Code 与 Codex 在 #74 里，这里只列一行对照并补了两处新发现（结论 4）。

调研中有一处与 #115 的分类不同：OpenAI Agents SDK 现在有压缩（`OpenAIResponsesCompactionSession`，只能调用 OpenAI Responses 的 compact 接口），不再是完全没有压缩运行时；Claude Agent SDK 运行的就是 Claude Code 的引擎，压缩和会话事件都有，应归到完整 harness 一档。

## 2. 总表

| 框架（读的版本） | 扩展单元 | MCP 客户端 / `instructions` | 追加系统提示 | 会话开始 | 压缩前 | 会话结束 | 按用户凭据 |
|---|---|---|---|---|---|---|---|
| Pi 1.7.0 | TS 模块（默认导出工厂），`pi install`；SDK 可传 `extensionFactories` | 内置；只放一行 | `before_agent_start`，每次运行 | `session_start`（含 resume、fork） | `session_before_compact`，可取消或给摘要 | `session_shutdown`，会等待 | 无 |
| DSH 0.2.3-alpha.2 | TS 插件 + npm bundle + profile，`dsh plugin add` | 内置；原文进系统提示 | `ctx.systemPrompt.section` | `agent/created`，会等待 | 无（只有事后日志事件） | `agent/disposed`，只能观察 | 无（凭据跟 profile） |
| Vercel AI SDK 7.0.184 | npm 辅助函数、中间件、Agent 设置 | `@ai-sdk/mcp`；读得到不放 | `instructions`、`prepareCall`、`prepareStep` | 无 | 无（`prepareStep` 里自己裁剪） | 无 | 自定义 `fetch`、每用户一个客户端 |
| Claude Agent SDK TS 0.3.332 / Py 0.2.189 | `query()` 选项：`mcpServers`、`hooks`、`plugins` | 内置；进系统提示，截到 4,096 字符 | `systemPrompt` 预设加 `append` | `SessionStart`（仅 TS 回调） | `PreCompact`，可阻止 | `SessionEnd`（仅 TS 回调），1.5 秒 | 每次 `query()` 自带配置 |
| OpenAI Agents SDK Py 0.26.0 / JS 0.22.0 | 辅助包：工具、`RunHooks`、session 包装 | 内置；Py 存而不用，JS 丢弃 | `instructions` 可为函数；`call_model_input_filter` | 无 | 压缩 session 的 `run_compaction` | 无 | `auth` / `httpx_client_factory`、`tool_meta_resolver` |
| Mastra 1.86.0 | npm 包、processor | 内置；可选转交，截到 512 字符 | processor 每步改 `systemMessages` | 无 | 无公开钩子 | 无 | `RequestContext` + MCP `fetch` |
| LangChain 1.5.2 / JS 1.6.8 | middleware | 适配包；丢弃 | `wrap_model_call` | 无（`before_agent` 每次调用都触发） | `SummarizationMiddleware` 的 summarizer | 无 | 运行时 `context` |
| Google ADK Py 2.15.1 | `BasePlugin`、回调 | 内置；丢弃 | `before_model_callback` | 无（`before_run` 每次运行） | 只能换 summarizer | 无 | `header_provider` |
| OpenCode 2.4.2 | npm 包或目录，`Plugin.define` | 内置；原文进系统提示 | `context` hook，每次请求 | `created` 事件 | `compaction` hook，可改写或代写摘要 | `deleted` 事件；无单独的结束 | 无（本机单用户） |
| Claude Code 2.1.332 | 插件、settings 里的 hooks | 进系统提示，截到 4,096 字符 | — | `SessionStart`（启动时跳过 `mcp_tool`） | `PreCompact` | `SessionEnd`，1.5 秒 | — |
| Codex rust-v0.172.0 | `hooks.json`、`config.toml` 的 `[hooks]` | — | — | `SessionStart`（可能早于 MCP 就绪） | `PreCompact` | `SessionEnd`（不支持 `mcp_tool`），1–3 秒 | — |

「无」指读过的文档和源码里没有找到。工具注册和「工具里读会话上下文」每一家都有，不单列；见各节。

## 3. 五个主要框架

### 3.1 Pi

earendil-works/pi 的 `packages/coding-agent`（原 badlogic/pi-mono，旧地址 301 跳转；npm 包 `@earendil-works/pi-coding-agent`，旧名 `@mariozechner/*` 仍映射到同一模块），读的是 1.7.0（2026-11-27，MIT）。

1. **扩展单元**：默认导出工厂函数 `export default function (pi: ExtensionAPI)` 的 TS / JS 模块，可以是 async，Pi 在 `session_start` 之前等它完成；用 jiti 加载，不用编译。发现位置：`~/.pi/agent/extensions/`、项目 `.pi/extensions/`（项目受信任后才加载）、`settings.json` 的 `extensions` 与 `packages`（`npm:`、`git:`）、单次运行 `pi -e`。分发用 `pi install npm:<包>`。把 Pi 当库用时，`createAgentSession({ resourceLoader })` 的 `DefaultResourceLoader` 接受 `extensionFactories`；SDK 会话不自动加载内置的 MCP 扩展，宿主要自己加 `createMcpExtension()` 并调用 `session.bindExtensions()`。
2. **工具**：`pi.registerTool({ name, description, parameters, execute(toolCallId, params, signal, onUpdate, ctx), prepareArguments?, promptSnippet?, promptGuidelines?, ... })`，参数是 JSON Schema（常用 TypeBox）。`registerTool` 在 `session_start` 里调用也生效，不用重载，适合异步取到 `/mcp` 的工具列表后再注册。内置 MCP 客户端支持 stdio 与 streamable HTTP（不支持 SSE），配置在 `~/.pi/agent/mcp.json` 和项目 `.pi/mcp.json`，扩展也可调用 `pi.registerMcpServer` 按会话注册；工具名 `mcp__<server>__<tool>`，默认以 `codemode` 暴露（模型不直接看到工具），另有 `deferred`、`direct`、`hidden`。**`instructions`**：文档原话「Server instructions are not part of any tool description」；`codemode` 或 `deferred` 的服务器在系统提示的 `mcp_servers` 段里只占一行，取配置的 `description`，没有时取 `instructions` 的第一行，每个服务器 250 字符、整段 4,096 字符；工具全是 `direct` 的服务器不列出；全文只有 codemode 脚本能用 `describeNamespace()` 读到。工具的 `execute` 拿得到 `ctx.sessionManager`（`getSessionId()`、`getBranch()` 等）、`ctx.cwd`、`ctx.model`；`prepareArguments` 在校验前改参数，`tool_call` 事件可以改输入。扩展工具的结果要自己截到 50 KB / 2,000 行；MCP 文本结果超过 20 KB 从中间截断、全文写临时文件。
3. **系统提示**：`before_agent_start` 每次运行（每条用户输入）触发一次，可以整体替换 `systemPrompt`，也可以改 `systemPromptOptions.sections`（推荐：Pi 计算差异后追加一条系统消息，保持缓存）。静态的还有工具的 `promptSnippet` / `promptGuidelines`、`--append-system-prompt`、`.pi/APPEND_SYSTEM.md`。没有找到扩展追加内容的大小上限。
4. **生命周期**：处理器按顺序 `await`，没有找到超时；抛错只记日志、不中断。
   - 会话开始：`session_start`，`reason` 为 `startup`、`reload`、`new`、`resume`、`fork`；没有返回值，加上下文要调用 `pi.sendMessage(..., { deliverAs: "nextTurn" })` 或在 `before_agent_start` 里放。
   - 分叉：`session_before_fork` 可取消，之后是 `session_shutdown` 与 `session_start{reason:"fork"}`；会话内分支有 `session_before_tree` / `session_tree`。
   - 压缩：`session_before_compact`（`reason` 为 `manual`、`threshold`、`overflow`）可取消，或返回自定义摘要；之后 `session_compact` / `session_compact_failed` 只是通知。
   - 停止：`turn_end` 可追加消息并要求继续；`agent_settled` 是最终通知。
   - 会话结束：`session_shutdown`（`quit`、`reload`、`new`、`resume`、`fork`），会等待，覆盖 Ctrl+C、Ctrl+D、SIGHUP、SIGTERM，第二次信号才强退。
   - 后台：Pi 只等处理器返回的 promise，处理器可以自己起后台任务（判断）。没有找到注入消息的大小上限。
5. **标识**：`getSessionId()`、`getSessionFile()`、`getHeader()`（`id`、`cwd`，分叉而来的会话有 `parentSession`，是父会话文件路径）；`getLeafId()`、`getBranch()`；`turn_start` / `turn_end` 的 `turnIndex`；`ctx.mode`（`tui`、`rpc`、`json`、`print`）；`ctx.model`。没有找到运行 ID。
6. **凭据**：扩展是普通 Node 进程，能读环境变量和自己的配置；MCP 配置的 `env`、`headers` 支持 `${ENV}` 与 `!command`，有 `--bearer-token-env-var`，内置 OAuth（CIMD / DCR），令牌存在 `~/.pi/agent/mcp-auth.json`。没有按终端用户解析的钩子；把 Pi 嵌进多用户服务时只能一个用户一个会话，各自 `registerMcpServer`（判断）。
7. **信任与安装**：`pi install` 写 `~/.pi/agent/settings.json`（`-l` 写项目）。项目级扩展、MCP 服务器和包要用户信任项目（交互提示、`/trust`、`--approve` 或 `defaultProjectTrust`）；print、JSON、RPC 模式下除非设为 `always`，跳过项目资源。没有沙箱，文档原话「Extensions run with your full system permissions」。

对 saveslot（判断）：Pi 适配不能只写一条 MCP 配置。要一个扩展：把 saveslot 服务器以 `direct` 注册（或直接注册原生工具）、在 `before_agent_start` 的 sections 里放 `instructions`、`session_start` → `hook_session_start`、`session_before_compact` → `hook_pre_compact`、`session_shutdown` → `hook_session_end`，`task` 在 `prepareArguments` 里填。

### 3.2 DSH（DeepSeek Harness）

官方仓库 deepseek-ai/deepseek-harness（MIT，TypeScript，2026-08-13 建库），读的是标签 `dsh-v0.2.3-alpha.2`（提交 `4b399c3`，2026-11-22，npm dist-tag `alpha`；`latest` 仍是 0.2.2-rc.5，2026-11-18）。项目自称开发预览版，声明会有破坏性改动。社区的 TUI、桌面端是另外的仓库，不在范围内。

1. **扩展单元**：插件是导出 `name`、可选 `inject` 列表和 `apply(ctx)` 的 JS / TS 模块，也可以是继承 `Service` 的类，建在 Cordis 框架上；经 `ctx` 注册的监听、工具、定时器在插件卸载时自动清理。分发单位是 bundle：`package.json` 里 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，补丁文件插入插件行，`engines.dsh` 写支持的版本。profile 是 `$DSH_HOME/profiles/<名字>` 目录，按序列出 bundle；配置按 bundle 补丁 → profile 补丁 → `$DSH_HOME/cordis.patch.yml` → 每个 `--patch` 叠加，补丁整行替换 `config`、不合并键。安装用 `dsh plugin --profile <p> add <包 | 目录 | github:x/y#sha | .tgz>`（交给 pnpm）。没有进程内 SDK：Python SDK 和 TS SDK 客户端都是起 `dsh --profile …` 子进程，经 stdio 走 JSON-RPC；把 DSH 嵌进自建 Agent 时，扩展经 profile 或每次启动传的补丁加载。
2. **工具**：`inject = ['tools']` 后 `ctx.tools.register(defineTool({ name, description, parameters, execute(args, exec) }))`，也接受原始 JSON Schema 定义。工具可以随时注册和移除，包括在 `agent/created` 里按 agent 注册；`ctx.tools.restrict()` 控制可见范围。`exec` 带 `callId`、`agent`（`agent.id` 即 SessionId、`agent.session`、`agent.model`），原生工具可以自己填 `task`。参数在策略执行前就冻结，不能改写：Claude Code hook 桥接里的 `updatedInput`「logged + warned but not honored」，所以给 MCP 工具注入参数做不到，只能注册自己的代理工具（判断）。内置 MCP 客户端每个服务器一行配置（`transport: stdio | streamable-http`、`headers`、`toolCallTimeoutMs`、`toolLoading: eager | on-demand`、`oauth.credentialKey`、`maxInstructionBytes`），工具名 `mcp__<server>__<tool>`。**`instructions` 进模型**：原文按服务器标注后放进系统提示；`maxInstructionBytes` 默认 32,768 字节（含标注），超出则整个连接以 `MCP_INSTRUCTIONS_TOO_LARGE` 被拒；`instructions` 变化或撤回时向会话追加一条说明。不支持 MCP prompt 模板。
3. **系统提示**：`ctx.systemPrompt.section({ name, order, text | () => text, ... })`，`text` 回调在每次组装提示时调用，变化以追加的系统消息送出；section 可以是全局或按 agent，近的同名 section 遮住远的；`complete: true` 整体替换，不推荐。`ctx.systemPrompt.context()` 放会变的运行信息，以用户角色快照送出。没有找到 section 的大小上限。默认开启的 `dsh-agent-instructions` 读 `$DSH_HOME/AGENTS.md`、`~/.agents/AGENTS.md` 和项目根到工作目录的 `AGENTS.md` / `CLAUDE.md`，每条链默认 65,536 字节。
4. **生命周期**：原生 hook 是进程内的 Cordis 监听，模式有 `emit`、`serial`、`bail`、`waterfall`。
   - 会话开始与恢复：`agent/created`（serial，第一条输入执行前等待完成），`source` 为 `startup`、`resume`、`clear`、`compact`，但 `clear` 与 `compact`「reserved with no emitter yet」；可以 `agent.inject(UserMessage)` 或注册 section。
   - 分叉：分叉关系记在创建元数据里（`parentSource`、`inheritedEventCount`），没有单独的分叉 hook。
   - 每一步之前：`agent/pre-step`（waterfall），可以拒绝或替换消息。
   - 压缩：**没有压缩前或压缩后的 hook**。`compaction/start`、`summary`、`end` 是只能经 `session/event` 观察的日志事件；唯一能拦截的是 `compaction/summary-error`；可以整个替换 `ctx.compaction` 服务。
   - 停止：`agent/turn-stopping`（serial），`agent.steer()` 可以强制再走一步。
   - 会话结束：`agent/disposed`、`session/disposed`（emit），只能观察。
   - 超时与后台：进程内监听没有文档写明的超时；后台工作用 `agent.runMaintenance()`、`ctx.jobs`。
   - 另有实验性的 `dsh-hooks-claude-code`（及 `dsh-hooks-codex`），按 Claude Code 的 `hooks.json` 执行 command hook，默认超时 600 秒；支持 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`、`SubagentStart` / `SubagentStop`，**不支持 `PreCompact`、`PostCompact`、`SessionEnd`，跳过 `http` 与 `mcp_tool` 处理器**；`SessionStart` 脱离执行，上下文「can miss the first request」。
5. **标识**：`agent.id`（SessionId），`agent/pre-step` 与 `agent/turn-stopping` 载荷里的轮次和步数，`exec.callId`，`modelSelection`；会话头有 `id`、`cwd`、`parentSession`、`origin`（子 agent）、`delegationDepth`、`agentPreset`。没有找到运行 ID。
6. **凭据**：`ctx.credentials` 服务（`resolve(credentialRef('KEY'))`、`describe`、`set`、`unset`）；MCP 行可用 `${credential:REF}`（`expandTemplates: true`）、YAML 里的 `!!js process.env.X` 或 `oauth.credentialKey`。存储属于 profile 或进程，没有按终端用户解析的钩子。
7. **信任与安装**：没有插件沙箱，SAFETY.md 写明插件有完整的主机权限、项目「has not undergone a security audit」。从 Git 安装需要 pnpm 的 `allowBuilds` 条目，文档要求固定到提交；发到 npm 或给 tarball 可以免掉这一步。插件索引的发现页是实验功能、默认关，安装要确认，只校验索引格式、不审插件内容。

对 saveslot（判断）：要一个原生 TS 插件 bundle，「一条 MCP 配置加 hooks.json」不够（桥接没有压缩前和会话结束）。映射：`agent/created` → `hook_session_start`（结果用 `agent.inject()` 或 section 放进去）；`hook_pre_compact` 没有落点，只能事后观察 `compaction/start` 或包装 `ctx.compaction`；`agent/disposed` → `hook_session_end`（只能观察）。`instructions` 在 32 KiB 内会原样到模型，扩展不用自己放。

### 3.3 Vercel AI SDK

npm `ai` 7.0.184（2026-11-27，Apache-2.0），`@ai-sdk/mcp` 2.0.106，源码锚定到 `ai@7.0.184` 标签，文档读同一标签的 `content/docs`。只有 TypeScript / JavaScript。

1. **扩展单元**：没有插件系统。辅助包能提供的是 `tools` 对象、`wrapLanguageModel` 中间件（`transformParams`、`wrapGenerate`、`wrapStream`）、`ToolLoopAgent` 的设置（`instructions`、`prepareStep`、`prepareCall`、`runtimeContext`、`toolsContext`、各 `on*` 回调），或自己实现 `Agent` 接口。实验性的 `HarnessAgent` 另有一组 harness 适配（包裹 Claude Code、Codex、Pi、OpenCode 等现成运行时），不是给用户代码用的插件。
2. **工具**：`tool()` 有 `inputSchema`、`outputSchema`、v7 新增的 `contextSchema` 等；`execute(input, { toolCallId, messages, abortSignal, context })`，`context` 来自调用或 Agent 的 `toolsContext[工具名]`，按 `contextSchema` 校验——包装后的工具可以从这里填 `task`。MCP 客户端 `createMCPClient`（`experimental_createMCPClient` 是已弃用的别名），传输有 `http`、`sse`、stdio 与自定义；`client.tools()` 生成的 `execute` 只把 `args` 和 `abortSignal` 传给 `callTool`，不传 `context`、不加 `_meta`，要填 `task` 就得包一层或直接 `client.callTool`（判断）。**`instructions`**：源码在新旧两条握手路径上都存下 `result.instructions`，经 `client.instructions` 和 `client.initializeResult.instructions` 读出，JSDoc 建议由应用自己放进系统提示；SDK 不自动放，文档也没有提到 `client.instructions`。
3. **系统提示**：`instructions`（字符串或系统消息）按调用或按 Agent；`prepareCall` 每次调用可以重建 `instructions`；`prepareStep` 每一步可以返回新的 `instructions`；中间件 `transformParams` 每次模型调用都执行。
4. **生命周期**：回调有 `onStart`、`onStepStart`、`onLanguageModelCallStart` / `End`、`onToolExecutionStart` / `End`、`onStepEnd`、`onEnd`、`onError`、`onAbort`（`onStepFinish` / `onFinish` 已弃用），另有 `prepareStep`、`stopWhen`。Core 没有会话：`onStart` / `onEnd` 是一次调用的开始与结束，不是会话。没有压缩，只有按规则过滤、不做摘要的 `pruneMessages`。AI SDK UI 的 `useChat` 有聊天 `id`，持久化由应用自己写（`loadChat`、`saveChat`）。`HarnessAgent` 有 `createSession()`、`session.destroy()` 等，但压缩只在流里事后出现一个 `compaction` 工具部件，没有压缩前回调。
5. **标识**：每个生命周期事件带 `callId`，另有 `stepNumber`、`toolCallId`、响应 ID、`ToolLoopAgent.id`；会话或用户标识由应用放进 `runtimeContext`（如 `{ conversationId, userId }`）；UI 有 `useChat` 的 `id`；`HarnessAgent` 有 `sessionId`。
6. **凭据**：MCP 传输可以给静态 `headers`、`authProvider`（OAuth），也可以给自定义 `fetch` 按请求加令牌。文档称客户端轻量、建议每次请求后关闭（`onEnd` 里 `client.close()`），每个请求或每个用户一个客户端是自然做法（判断）。凭据也可以经 `toolsContext` 交给工具，不进提示。
7. **信任与安装**：`npm install ai @ai-sdk/mcp`，开发者自己写代码接入，没有宿主同意、清单或市场。

对 saveslot（判断）：共用核心能直接用——工具定义带 `contextSchema` 承载 `task`、用户与会话，`instructions` 由核心取到后交给 `instructions` 或 `prepareCall`；会话开始和结束要给开发者两个显式调用，挂在 `useChat` 持久化或自己的会话边界上；压缩前没有生成得出的落点，只能提供一个包装 `prepareStep` 的辅助，在应用裁剪 `messages` 之前调用 `hook_pre_compact`。

### 3.4 Claude Agent SDK

TypeScript `@anthropic-ai/claude-agent-sdk` 0.3.332 与 Python `claude-agent-sdk` 0.2.189（都在 2026-11-25 发布），内置引擎与 Claude Code 2.1.332 对应（按版本后缀推断）。许可：TS 包的 `LICENSE.md` 写「© Anthropic PBC. All rights reserved」，使用受 Anthropic 法律协议约束，不是开源许可；Python 仓库在 `v0.2.189` 标签下是 MIT，但它打包的 CLI 受 Anthropic 条款约束（判断）。没有事先批准，第三方产品不得提供 claude.ai 登录或其额度。

1. **扩展单元**：都在 `query({ prompt, options })` 的选项里：`mcpServers`、`hooks`、`plugins`（只支持 `{ type: 'local', path }`）、`agents`、`settingSources`、`skills`、`systemPrompt`、`env`、`cwd`、`resume`、`continue`、`forkSession`、`sessionId`。进程内 MCP 服务器用 `createSdkMcpServer({ name, instructions?, tools? })` 加 `tool(name, description, zodShape, handler)`；Python 的 `create_sdk_mcp_server` 没有 `instructions` 参数。只有 TypeScript 与 Python。
2. **工具**：外部 MCP 服务器支持 stdio、`http`、`sse`，可带 `headers` / `env`。**`instructions` 进模型**：开着工具搜索（默认）时「only tool names and server instructions load at session start」；`instructions` 与预先加载的工具描述截到 4,096 字符，经工具搜索加载的工具描述是 16,384 字符，`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` 可以调。替模型填 `task`：`PreToolUse` 回调返回 `hookSpecificOutput.updatedInput`，省略 `permissionDecision` 时改过的输入照常走权限判断；matcher 可写 `mcp__saveslot__.*`；`updatedInput` 是整体替换，要自己合并原输入（判断）。
3. **系统提示**：`systemPrompt` 可以是字符串、`{ type: 'custom', prompt }` 或 `{ type: 'preset', preset: 'claude_code', append? }`；不设时用的是精简的工具调用提示，不是 `claude_code` 预设。CLAUDE.md 注入对话而不是系统提示，由 `settingSources` 控制，省略时全部加载、传 `[]` 关闭。
4. **生命周期**：TS 的 `HOOK_EVENTS` 有 34 个，含 `SessionStart`、`SessionEnd`、`PreCompact`、`PostCompact`、`Stop`、`SubagentStart` / `SubagentStop`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse` 等。**Python 只有 10 个，`SessionStart`、`SessionEnd`、`PostCompact` 只在 TS 里能写成回调**；Python 要用这几个，只能经 `setting_sources` 加载 settings 文件里的 shell hook。回调可返回 `additionalContext`（`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop` 等）；文档说 SDK 回调与 shell hook「use the same JSON output format」，shell hook 每个字段上限 10,000 字符、超出写文件并给 2,000 字符预览，回调的上限按此推断。`{ async: true }` 后台运行，但「can't block, modify, or inject context」。超时：多数事件 600 秒，`UserPromptSubmit` 30 秒，**`SessionEnd` 共享 1.5 秒**（shell hook 最多可调到 60 秒）。`PreCompact` 的输入有 `trigger`（`manual` / `auto`），可以 `decision: 'block'`；shell hook 的标准输出会成为压缩摘要的指示，回调能否返回摘要指示没有找到。`SessionStart` 的 `source` 有 `startup`、`resume`、`clear`、`compact`、`fork`。
5. **标识**：每个 hook 输入都有 `session_id`、`transcript_path`、`cwd`，可选 `prompt_id`、`permission_mode`，子 agent 里另有 `agent_id`、`agent_type`；消息带 `session_id`；选项 `sessionId` 可以自己指定会话 ID。没有找到宿主层面的任务 ID。
6. **凭据**：SDK 自身用 `ANTHROPIC_API_KEY`（或 Bedrock、Vertex、Foundry）。MCP 服务器的令牌放 `headers` 或 `env`，按每次 `query()` 设置；每次 `query()` 起自己的子进程，带自己的 `mcpServers`、`env`、`cwd`，托管文档示例就是每个租户一套配置和工作目录。TS 的 `env` 会替换子进程环境。托管文档建议工具凭据不进 Agent 环境，由代理注入。
7. **信任与安装**：不用另装 Claude Code，平台相关的可选依赖带了原生二进制，`pathToClaudeCodeExecutable` 可覆盖；Node ≥ 18.14。权限模式有 `default`、`acceptEdits`、`plan`、`dontAsk`、`auto` 等，另有 `canUseTool`、`allowedTools` / `disallowedTools`。SDK 和 `-p` 会话不弹工作区信任对话框，视为已信任，仓库 `.claude/settings.json` 里的 hook 会执行。

对 saveslot（判断）：TS 可以在进程内放下整个适配——`createSdkMcpServer`（带 `instructions`）或外部 saveslot 服务器；`SessionStart` 回调调 `hook_session_start` 并返回 `additionalContext`；`PreCompact` 回调调 `hook_pre_compact`；`SessionEnd` 回调调 `hook_session_end`，要在 1.5 秒内完成或改为后台；`PreToolUse` 用 `updatedInput` 填 `task`。Python 要分两路：会话开始与结束只能走 settings 里的 shell hook，`instructions` 只能来自外部服务器。这一家的事件集与 Claude Code 相同，适合验证情形 1 与情形 2 共用一套 hook 契约。

### 3.5 OpenAI Agents SDK

Python `openai-agents` 0.26.0（2026-11-24）与 JS `@openai/agents` 0.22.0（2026-11-12），都是 MIT；另有 Python `v1.0.0-alpha.2` 与 JS `0.22.0-alpha.3` 预发布，没有读。

1. **扩展单元**：没有通用的插件机制。辅助包提供 `tools`、`mcp_servers` / `mcpServers`、`RunHooks` / `AgentHooks`、`instructions` 函数、`Session` 实现或包装、`RunConfig` 里的过滤器。最接近插件的是 Python 沙箱 agent 的 `Capability`（`tools()`、`instructions(manifest)`、`process_context`），只对沙箱 agent 有效。只有 Python 与 TypeScript。
2. **工具**：Python `@function_tool`，第一个参数可以是 `RunContextWrapper` 或 `ToolContext`，不进给模型的 schema；`ToolContext` 有 `context`、`tool_name`、`tool_call_id`、`agent`、`run_config` 等。JS `tool({ parameters, execute(input, runContext?, details?) })`。所以辅助包可以从 `context` 取 `task`，不在参数里声明它。MCP：Python `MCPServerStdio`、`MCPServerSse`、`MCPServerStreamableHttp`、`MCPServerManager`；JS 对应的类与 `connectMcpServers()`。**`instructions`**：Python 把握手结果存进 `server_initialize_result`，`src/agents` 里没有别处读它，不进模型——辅助包可以在 `connect()` 后读出来放进 agent 的 `instructions`；JS 自己的 `InitializeResult` 类型只有 `protocolVersion`、`capabilities`、`serverInfo`，`instructions` 被丢掉，要取得子类化后调用 MCP SDK 的 `Client.getInstructions()`（判断，未试）。`tool_filter` / `toolFilter` 可以按上下文过滤工具。**`tool_meta_resolver` / `toolMetaResolver` 在每次 `call_tool` 前调用，拿得到 `run_context`、服务器名、工具名和参数**——这是不经模型、给每次 saveslot 调用带上用户、会话、任务标识最干净的入口。托管 MCP（`HostedMCPTool` / `hostedMcpTool`）由模型直接调用，不经辅助包的代码。
3. **系统提示**：`instructions` 可以是字符串，或接收上下文和 agent 的函数（可 async）。没有内置的追加方式：辅助包包住用户原来的 `instructions`、用 `agent.clone(instructions=...)`，或在 `call_model_input_filter` 里每次模型调用前改 `instructions`。
4. **生命周期**：Python `RunHooks` 有 `on_agent_start` / `end`、`on_handoff`、`on_tool_start` / `end`、`on_llm_start` / `end`；JS 是事件发射器，只有 `agent_start`、`agent_end`、`agent_handoff`、`agent_tool_start`、`agent_tool_end`，没有 LLM 开始与结束。hook 只能观察，不能把内容交给模型；要注入用 `call_model_input_filter` / `callModelInputFilter` 或 `session_input_callback`。Session 协议有 `session_id`（JS `getSessionId()`）、`get_items`、`add_items`、`pop_item`、`clear_session`，Python 有 SQLite、SQLAlchemy、Redis 等实现。压缩：`OpenAIResponsesCompactionSession` 包住另一个 session，runner 写入 session 后调用 `run_compaction`，默认候选项达到 10 个时压缩，要求 OpenAI 模型；**`run_compaction` 协议是放 `hook_pre_compact` 的地方**：一个实现 `run_compaction` 的 saveslot session 包装先调 hook（判断）。没有会话开始与结束事件，只能对应到一次运行的第一个 `on_agent_start`（或 session 第一次 `get_items`）与 `Runner.run` 结束（判断）。恢复靠传同一个 `session`、序列化的 `RunState` 或 `conversation_id` / `previous_response_id`。
5. **标识**：`session_id`；`RunConfig` 的 `workflow_name`、`trace_id`、`group_id`、`trace_metadata`；`conversation_id`、`previous_response_id`；应用自定义的 `context` 对象在每个 hook、工具、过滤器和 meta 解析器里都看得到，是放 saveslot 用户与任务的地方。
6. **凭据**：Python streamable HTTP 有静态 `headers`、`auth`（httpx 认证）、`httpx_client_factory`；JS 有 `requestInit`、`authProvider`。没有按上下文取请求头的回调，按用户隔离可以每用户或每次运行建一个服务器对象、用查令牌的自定义 `auth`，或经 `tool_meta_resolver` 把身份放进 `_meta`（判断）。
7. **信任与安装**：`pip install openai-agents` / `npm i @openai/agents`，没有签名、清单或市场。本地 MCP 工具可设 `require_approval`；未批准的调用以中断暂停运行，经 `RunState` 恢复。

对 saveslot（判断）：清单能描述工具、`instructions` 文本、经 `_meta` / `context` 传的标识字段和三个 hook 名，但这一家要按语言各写一份代码模板：转交 `instructions` 的包装、`RunHooks` 子类（Python）或事件监听（JS）、把 `run_compaction` 变成 `hook_pre_compact` 的 session 包装、提供会话开始与结束的运行包装。

## 4. 补充的四个框架与两个成品宿主

**Mastra**（`@mastra/core` 1.86.0，2026-11-25，Apache-2.0，`ee/` 目录另有许可）：npm 包，行为经 processor（`processInput`、`processInputStep`、`processLLMRequest`、`processToolResult` 等）修改。`@mastra/mcp` 的 `MCPClient` 用 `getInstructions()` 取到 `instructions`，只有 `forwardInstructions: true` 时才进系统提示（默认 `false`），每个服务器默认截到 512 字符（`instructionsMaxLength`）。工具 `execute` 拿得到 `requestContext`、`runId`、`threadId`、`resourceId`。没有找到会话开始、结束、恢复的 hook，只有每次调用的 `onStepFinish`、`onFinish`、`onError`、`onAbort`；分叉用 `memory.cloneThread`；压缩是 Observational Memory，没有找到公开的钩子。每个请求一个 `RequestContext` 流到工具，MCP 客户端的 `fetch(url, init, requestContext)` 能按用户设请求头。

**LangChain v1 `createAgent` / LangGraph**（Python `langchain` 1.5.2、JS `langchain` 1.6.8、`langgraph` 1.2.24，MIT；MCP 适配包 JS `@langchain/mcp-adapters` 2.0.3、Python `langchain-mcp-adapters` 0.3.2）：扩展单元是 middleware，hook 有 `before_agent`、`before_model`、`wrap_model_call`、`after_model`、`after_agent`、`wrap_tool_call`。MCP 在单独的适配包里，**`instructions` 被丢弃**：JS 适配源码里没有引用 `instructions`，Python 只能经 `client.get_server_info()`（每次重新握手）取到，`get_tools()` 不放。工具的 `runtime: ToolRuntime` 参数对模型不可见，带 `state`、`context`、`store`、`tool_call_id`、`execution_info`（线程 ID、运行 ID，需要 `langgraph>=1.1.5`）。`wrap_model_call` 每次模型调用可改 `request.system_message`。`before_agent` / `after_agent` 每次调用都触发，不是线程创建；恢复是用同一个 `thread_id` 调用；分叉是在旧检查点上 `update_state` 后调用。压缩是 `SummarizationMiddleware`（`trigger`、`keep`、`summary_prompt`、可换的 `summarizer`）。没有会话结束或停止 hook。凭据经每次调用传入的运行时 `context`（`context_schema`）。

**Google ADK**（Python 2.15.1，2026-11-25；Java 1.15.0；TS `adk-v2.5.0`；Apache-2.0）：`BasePlugin` 注册在 Runner 或 App 上，另有每个 agent 的回调。`McpToolset` 内置，**Python 的 `instructions` 被丢弃**：客户端调用 `session.initialize()` 后不用结果（Java 与 TS 只核对了版本和许可）。`ToolContext` 有会话、状态、`user_id`、`invocation_id`、`function_call_id`。`before_model_callback` 可以改发出的请求，自带的 `GlobalInstructionPlugin` 在前面加指令。插件回调有 `on_user_message`、`before_run` / `after_run`、`on_event`、各类 before / after / error、`close`；没有会话创建与删除回调（那是 `SessionService` 的调用）。压缩由 `EventsCompactionConfig` 控制，压缩事件在运行后直接追加、不经插件回调，只能换 `summarizer`。凭据有 `ToolContext.request_credential` 与 `McpToolset(header_provider=fn(ReadonlyContext))`，后者能按用户给请求头。

**OpenCode**（anomalyco/opencode，sst/opencode 跳转至此，2.4.2，2026-11-26，MIT）：2.x 重写了插件接口，1.x 插件不移植不能用。扩展单元是 npm 包或本地目录，服务端部分是 `Plugin.define({ id, setup(ctx) })`。MCP 内置，插件可以经 `ctx.mcp.transform` 增删改服务器；**`instructions` 进模型**，每个服务器的文本放进 `<mcp_instructions>` 块，变化与移除在会话中途发通知。工具 `execute(input, context)` 有 `sessionID`、`agent`、`messageID`、调用 ID。`ctx.session.hook("context", ...)` 在每次模型请求前可以往 `system` 里加内容。事件流有 `created`、`forked`、`compaction.started` / `ended` / `failed`、`idle`、`error`、`deleted` 等；`compaction` hook 可以改要摘要的内容或直接给出摘要。没有找到单独的恢复事件。本机单用户，没有按终端用户的概念。`.opencode/plugins/` 下的插件自动加载；没有找到服务端插件的审批步骤。

**Claude Code 与 Codex**（#74 的两家，这里只补对照和两处新发现）：

| | Claude Code 2.1.332 | Codex rust-v0.172.0（2026-11-24） |
|---|---|---|
| hook 事件 | 与 Claude Agent SDK 的 `HOOK_EVENTS` 相同 | `SessionStart`、`SessionEnd`、`PreCompact`（可 `continue:false` 停止）、`PostCompact`、`Stop`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PreModelRequest` / `PostModelRequest`、`Interrupt` 等 |
| 处理器 | `command`、`http`、`mcp_tool`、`prompt`、`agent`；**启动时（含 `--continue` / `--resume`）的 `SessionStart` 跳过 `mcp_tool`**，`/clear` 与压缩后的才会调用；文档建议启动时用 `command` | `command`、`mcp_tool`（`prompt`、`agent` 解析但跳过）；`mcp_tool` 复用已有连接、不启动服务器；**`SessionStart` 可能早于 MCP 就绪；`SessionEnd` 不支持 `mcp_tool`** |
| 上下文上限 | `additionalContext` 等字段 10,000 字符，超出写文件、给 2,000 字符预览，不能调 | 每条约 2,500 token（`additionalContextLimit` 可调），超出写盘、给首尾预览 |
| 会话结束的时间 | `SessionEnd` 共享 1.5 秒，按 hook 的 `timeout` 最多调到 60 秒 | `SessionEnd` 默认 1 秒，最多 3 秒 |
| 信任 | 交互会话在接受工作区信任前不执行 settings 里的 hook；`-p` 与 SDK 视为已信任；有 `allowManagedHooksOnly` | 非托管 hook 要在 `/hooks` 里按内容哈希审过才执行，改了要重审；托管 hook 按策略信任 |

对 #74（判断）：#74 把 `mcp_tool` 定为首选入口、`saveslot hook <event>` 为后备。照上表，Claude Code 启动时的索引和 Codex 的会话结束都只能走后备的 command 入口；`SessionEnd` 在两家都只有一到几秒，只够把检查点写进本机队列，不够一次远端往返。

## 5. 对共用适配核心的含义（判断）

**各家都一样、放进核心的：**

- 连 `/mcp`（本机 stdio / unix socket 或远端 streamable HTTP），会话开始时取 `tools/list` 与 `instructions`；工具、描述、`instructions` 随凭据的 scope 和 slot 变化，按 #115 的约定在运行时取，不写死在生成的文件里。
- 调用 `hook_session_start`、`hook_pre_compact`、`hook_session_end` 的同一套逻辑，带同一组预算和超时（#74 提议的 600 / 120 token、处理器 3 秒），会话结束只做本机入队。
- 从框架给的会话上下文里取 `task` 和 #52 的会话来源，填进每次调用。
- 凭据解析函数：输入是会话上下文，输出是端点和令牌；默认取本机 profile 或环境变量，#115 情形 3 再换。
- 文本原样转交，不改写 [`../spec/05-surfaces.md`](../spec/05-surfaces.md) §5 的边界标记。

**每个框架一个写入器、各家不同的：**

| 写入器要回答的 | 各家的落点 |
|---|---|
| 工具怎么挂 | 原生注册（Pi、DSH、OpenCode、Mastra、ADK、OpenAI 函数工具）或接框架自带的 MCP 客户端（Claude Agent SDK、Vercel、OpenAI MCP 类） |
| `task` 在哪里填 | 改参数（Pi `prepareArguments`、Claude `updatedInput`）、工具上下文（DSH `exec`、Vercel `toolsContext`、LangChain `runtime`、ADK `ToolContext`、Mastra `requestContext`）、调用元数据（OpenAI `tool_meta_resolver`） |
| `instructions` 放哪里 | 框架已转交的（DSH、OpenCode、Claude）不重复放；其余放进各自的系统提示接口（Pi sections、Vercel `instructions`、OpenAI `instructions` 函数、LangChain `wrap_model_call`、ADK `before_model_callback`、Mastra 打开 `forwardInstructions` 或 processor） |
| 三个 hook 挂在哪 | 见第 2 节总表；缺的格子写明，由开发者显式调用或不提供 |
| 语言与形态 | TypeScript：Pi、DSH、OpenCode、Vercel、Mastra、Claude Agent SDK TS、OpenAI JS、LangChain JS；Python：Claude Agent SDK Py、OpenAI Py、LangChain Py、ADK Py |

所以核心至少要有 TypeScript 与 Python 两份实现（或一份核心加另一种语言的薄绑定），写入器是代码模板，清单填模板的参数。「每家一个写入器，一个测试比对生成物与清单」这条线仍然成立，只是写入器不能只是配置文件。

## 6. 来源（均于 2026-11-28 阅读）

**Pi**（标签 `v1.7.0`）
- https://github.com/earendil-works/pi/blob/v1.7.0/packages/coding-agent/docs/extensions.md
- https://github.com/earendil-works/pi/blob/v1.7.0/packages/coding-agent/docs/mcp.md
- https://github.com/earendil-works/pi/blob/v1.7.0/packages/coding-agent/src/extensions/mcp/index.ts#L159-L190
- https://github.com/earendil-works/pi/blob/v1.7.0/packages/coding-agent/src/core/extensions/runner.ts#L1108-L1115
- https://github.com/earendil-works/pi/blob/v1.7.0/packages/coding-agent/docs/sdk.md
- https://github.com/earendil-works/pi/blob/v1.7.0/packages/coding-agent/docs/packages.md
- https://github.com/earendil-works/pi/blob/v1.7.0/packages/coding-agent/docs/security.md
- https://github.com/earendil-works/pi/blob/v1.7.0/packages/coding-agent/docs/session-format.md
- https://github.com/earendil-works/pi/blob/v1.7.0/packages/coding-agent/docs/compaction.md

**DSH**（提交 `4b399c39a6d1479cd84ca591b4d7c88e24d38a96`，标签 `dsh-v0.2.3-alpha.2`；下列路径前缀为 `https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/`）
- `docs/user/develop/basic/index.md`、`publish.md`、`config.md`、`tool.md`
- `docs/user/guide/python-sdk.md`、`docs/user/guide/plugin-market.md`、`packages/sdk/README.md`
- `docs/cookbook/adding-a-tool.md`、`extension-cookbook.md`、`contributing-system-messages.md`
- `docs/subsystems/core.md`、`compaction.md`、`session.md`；`docs/user/develop/framework/events.md`
- `packages/mcp/mcp-client/README.md`、`packages/experimental/hooks-claude-code/README.md`
- `packages/context/agent-instructions/README.md`、`packages/credentials/credentials/README.md`
- `packages/core/agent/README.md`、`packages/core/agent/src/runtime-types.ts`、`packages/session/session-format-v3-to-v4/README.md`
- `SAFETY.md`

**Vercel AI SDK**（标签 `ai@7.0.184`；前缀 `https://github.com/vercel/ai/blob/ai@7.0.184/`）
- `packages/mcp/src/tool/mcp-client.ts`、`mcp-transport.ts`、`mcp-http-headers.ts`；`packages/mcp/src/index.ts`
- `packages/provider-utils/src/types/tool.ts`、`tool-execute-function.ts`
- `packages/ai/src/agent/tool-loop-agent-settings.ts`、`agent.ts`；`packages/ai/src/generate-text/prepare-step.ts`、`prune-messages.ts`；`packages/ai/src/prompt/prompt.ts`
- `packages/harness/src/agent/harness-agent-settings.ts`
- `content/docs/03-ai-sdk-core/`（`16-mcp-tools`、`17-runtime-and-tool-context`、`40-middleware`、`60-telemetry`、`65-lifecycle-callbacks`）、`content/docs/03-agents/`（`05-configuring-call-options`、`06-memory`）、`content/docs/03-ai-sdk-harnesses/`、`content/docs/04-ai-sdk-ui/03-chatbot-message-persistence.mdx`

**Claude Agent SDK、Claude Code**
- https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.332/sdk.d.ts （及同版本的 `package.json`、`LICENSE.md`、`README.md`）
- https://github.com/anthropics/claude-agent-sdk-python/tree/v0.2.189 （`LICENSE`、`src/claude_agent_sdk/types.py`、`_internal/transport/subprocess_cli.py`）
- https://code.claude.com/docs/en/agent-sdk/overview 、`/agent-sdk/hooks`、`/agent-sdk/mcp`、`/agent-sdk/modifying-system-prompts`、`/agent-sdk/sessions`、`/agent-sdk/hosting`、`/agent-sdk/typescript`
- https://code.claude.com/docs/en/hooks （启动时跳过 `mcp_tool`、10,000 字符上限、`SessionEnd` 1.5 秒）
- https://code.claude.com/docs/en/mcp （`instructions` 4,096 字符）

**Codex**
- https://developers.openai.com/codex/hooks （处理器、`SessionEnd` 超时与不支持 `mcp_tool`、约 2,500 token 上限、信任）
- https://github.com/openai/codex/releases/tag/rust-v0.172.0

**OpenAI Agents SDK**（Python 前缀 `https://github.com/openai/openai-agents-python/blob/v0.26.0/`，JS 前缀 `https://github.com/openai/openai-agents-js/blob/%40openai/agents%400.22.0/`）
- Python：`src/agents/mcp/server.py`、`mcp/util.py`、`mcp/manager.py`、`lifecycle.py`、`agent.py`、`tool.py`、`tool_context.py`、`run.py`、`run_config.py`、`memory/session.py`、`memory/openai_responses_compaction_session.py`、`run_internal/session_persistence.py`、`sandbox/capabilities/capability.py`、`docs/tools.md`、`docs/sessions/index.md`
- JS：`packages/agents-core/src/mcp.ts`、`mcpServers.ts`、`shims/mcp-server/node.ts`、`lifecycle.ts`、`agent.ts`、`tool.ts`、`run.ts`、`memory/session.ts`、`runner/sessionPersistence.ts`；`packages/agents-openai/src/memory/openaiResponsesCompactionSession.ts`

**Mastra**（标签 `@mastra/core@1.86.0`；前缀 `https://github.com/mastra-ai/mastra/blob/%40mastra/core%401.86.0/`）
- `LICENSE.md`、`packages/core/src/processors/index.ts`、`packages/core/src/agent/mcp-guidance.ts`、`packages/mcp/src/client/types.ts`、`packages/core/src/tools/types.ts`、`docs/src/content/en/reference/memory/observational-memory.mdx`

**LangChain / LangGraph**
- https://github.com/langchain-ai/langchain/blob/langchain-core%3D%3D1.8.5/libs/langchain_v1/langchain/agents/middleware/types.py （该标签含 langchain_v1 1.5.2）、同目录 `summarization.py`
- https://github.com/langchain-ai/langchainjs/tree/langchain%401.6.8/libs/langchain-mcp-adapters/src 、`libs/langchain/src/agents/middleware`
- https://github.com/langchain-ai/langchain-mcp-adapters/blob/langchain-mcp-adapters%3D%3D0.3.2/langchain_mcp_adapters/client.py
- https://docs.langchain.com/oss/python/langchain/tools 、https://docs.langchain.com/oss/python/langgraph/use-time-travel

**Google ADK**（标签 `v2.15.1`；前缀 `https://github.com/google/adk-python/blob/v2.15.1/src/google/adk/`）
- `plugins/base_plugin.py`、`plugins/global_instruction_plugin.py`、`tools/mcp_tool/session_context.py`、`tools/mcp_tool/mcp_toolset.py`、`agents/context.py`、`agents/readonly_context.py`、`runners.py`、`apps/_configs.py`

**OpenCode**（标签 `v2.4.2`；前缀 `https://github.com/anomalyco/opencode/blob/v2.4.2/`）
- `services/site/src/docs/content/build/plugins/index.mdx`、`server.mdx`、`migrate-v1.mdx`
- `packages/core/src/mcp/instructions.ts`、`packages/schema/src/tool.ts`、`packages/plugin/src/promise/tool.ts`
- `packages/cli-rs/parity/deviations/F16-project-plugin-approval.md`
