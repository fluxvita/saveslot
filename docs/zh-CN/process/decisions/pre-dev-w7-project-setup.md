# 开发前决定 W7：项目名、仓库、包名、许可证、协作流程、工具链

> 这是决定稿，记决定与理由。结论已落进 `docs/zh-CN/guide/12-contributing.md`、`docs/zh-CN/spec/02-architecture.md` §11、`docs/zh-CN/spec/07-scope-v1.md`、`docs/zh-CN/spec/06-cli.md`、根 `README.zh-CN.md`、`LICENSE`、`CONTRIBUTING.zh-CN.md`。

## 1. 名字

| 项 | 决定 |
|---|---|
| 项目名 | `saveslot` |
| GitHub | 组织与仓库都用全小写：`fluxvita/saveslot` |
| npm | 组织 `@fluxvita`。对外安装的包是 `@fluxvita/saveslot`（含 CLI 与服务）；monorepo 里其余的包按 `docs/zh-CN/spec/02-architecture.md` §11 的分包命名为 `@fluxvita/saveslot-<包名>` |
| 网站 | `saveslot.ai`，只作站点地址 |

- 理由：GitHub、npm、域名三处用同一个名字，找得到、不撞名；设计阶段用的内部名与 `slot` 在 npm 上都已被占用，`saveslot` 在 npm 与域名上都可用。
- **全部文档已统一用新名字。** 文档正文、CLI 命令 `saveslot`、数据目录 `~/.saveslot/`、MCP 工具前缀 `saveslot_`、权限范围 `saveslot.*`、派生规则函数 `saveslot_today()` / `saveslot_now()` 都随项目名改了；设计阶段用过的内部名不再出现。
- **核心概念"空间"改叫 slot。** 一个 slot 是租户内一组相关的表加上它们的源数据（账本、健康记录各一个 slot），有自己的 schema、策略与时区。理由：一个 slot 装着一份完整、可以接着用的状态，像一个存档位，与项目名 saveslot 对得上；"空间"太泛，容易和命名空间、存储空间混在一起。契约、事件格式、CLI 里的英文标识一并改为 `slot`（`slot_id`、`SlotName`、`create_slot`、`slot.policy_set`……），slot ID 的前缀是 `sl_`。

## 2. 许可证

- **Apache-2.0**，代码与文档（`docs/zh-CN/guide/`、`docs/zh-CN/spec/`）同一许可证。版权方 FluxVita。
- 理由：采用面优先。与 MIT 同为宽松许可，多出明确的专利授权与专利报复条款，并要求标明改动，对有公司背景的基础设施项目更稳妥。
- 贡献用 **DCO**：每个提交带 `Signed-off-by`，表示贡献者有权按本许可证提交这段内容。不设 CLA：CLA 提高第一次贡献的门槛，而宽松许可下不需要它来保留再许可的权利。

## 3. 仓库与两个远端

- **一个独立的主仓库 `saveslot`**，放要公开的内容：根目录的 `README.md`、`LICENSE`、`NOTICE`、`CONTRIBUTING.md`、`AGENTS.md`（及中文版 `README.zh-CN.md`、`CONTRIBUTING.zh-CN.md`），`docs/zh-CN/` 下的 `guide/`、`spec/`、`research/`、`process/decisions/`、`process/walkthroughs/`、`process/README.md`，以及之后的代码。
- **内部材料放另一个不公开的内部仓库**：设计阶段的审查报告、各轮修订记录、早期例子、交接说明等。不用"同一仓库的内部分支"来放内部内容：分支迟早会被误推，历史也会带出去。
- **公开时机**：做到可用再公开，门槛是 P2 结束（写入、读取、删除、冲突走通，评测能跑）。公开前主仓库在公司内部的代码托管上协作；公开那一刻把完整历史推到 GitHub 的 `fluxvita/saveslot` 并把主仓库切到 GitHub，之后内部仓库改成自动拉取的只读镜像。**任何时刻只有一个主仓库**，不向两个远端推不同的内容。
- 因为历史会整体公开：
  - 从第一次提交起按公开标准写提交信息；不提交密钥、内部地址、内部人名。
  - 公开前跑一次密钥与内部信息扫描。
  - 公开内容里不链接留在内部的文件。决定稿里引用审查报告条目号的地方保留文字、不带链接（说明见 `docs/zh-CN/process/README.md`）。
- 早期例子与各轮修订记录也留在内部仓库：规格里原先指向早期例子的链接改指讲解里的例子（`docs/zh-CN/guide/02-walkthrough.md`），根 `README.zh-CN.md` 与 `docs/zh-CN/process/README.md` 不再提修订记录。

## 4. 讨论与提交流程

- **讨论渠道**。公开前：公司内部仓库的 Issue 与合并请求。公开后：GitHub Issues 报缺陷与任务，GitHub Discussions 提问与讨论设计；安全问题走 GitHub 的私密漏洞报告，不公开提 Issue。
- **提交流程**：从主分支拉分支 → 合并请求 → CI 全绿加一人评审 → squash 合并。提交信息用 conventional commits，带 `Signed-off-by`。
- **规格先行**：改变行为的改动必须在同一个合并请求里改 `docs/zh-CN/spec/`，影响读者理解的同步改 `docs/zh-CN/guide/`。改事件格式、内核不变量、契约的不兼容改动，先在 `docs/zh-CN/process/decisions/` 提一份决定稿并通过评审，再改规格与代码。理由：这三样定下后难改，先把"为什么"评审清楚，比在代码评审里争论便宜。
- **语言**：提交信息、代码注释、标识符、日志与报错文案一律用英文。文档目前以中文版（`docs/zh-CN/`）为准，公开前补齐英文版，英文版放在 `docs/` 下不带语言标记的位置。理由：项目面向国际开源社区，历史与代码从第一个提交起就会公开，事后改写的代价远大于一开始就用英文；文档先用中文是为了让团队内部对齐设计更快，英文版在公开前一次整理。中文版放在 `docs/zh-CN/`、根目录的中文文件带 `.zh-CN` 后缀，是开源项目多语言文档的常见放法：默认语言占不带标记的位置，加英文版时中文一侧的路径不用再动。
- **版本**：Changesets 管理版本与变更记录；1.0 之前用 0.x；事件格式版本独立于包版本。

## 5. 工具链

| 项 | 决定 | 理由 |
|---|---|---|
| Node | 最低 24（当前的长期支持版本），`engines` 写明；CI 跑 24 与当前最新版 | 新项目没有历史包袱，取长期支持版本的最新一档 |
| 语言 | TypeScript 严格模式，只发 ESM | 规格已定内核用 TypeScript；只发 ESM 省掉双格式的维护 |
| 包管理 | pnpm workspace | 规格已定 |
| 测试 | Vitest；性质测试用 fast-check | 对拍、整库检索等性质测试按 `docs/zh-CN/spec/02-architecture.md` §11 |
| 格式与检查 | Biome | 格式化与 lint 一个工具，配置少、速度快 |
| 依赖规则 | dependency-cruiser | 规格已定：包级与模块级的依赖方向在 CI 里强制 |
| 构建 | 各包用 `tsc` 出类型与 JS（项目引用）；CLI 用 tsup 打包 | 库包不需要打包器；CLI 要单文件入口 |
| CI | 检查项写成 `package.json` 里的脚本，CI 配置只调脚本。公开前跑在内部的 CI 上，公开时加 GitHub Actions | 两份 CI 配置都很薄，切换主仓库时不用重写检查逻辑 |

- CI 脚本覆盖：类型检查、lint、单测、性质测试、依赖规则、文档链接检查、JSON 例子可解析。
- 具体版本号在搭脚手架时取当时的稳定版并锁定，不写进规格。

## 6. 需要人去做的事

- 在 GitHub 的 `fluxvita` 组织下建（或确认）`saveslot` 仓库，公开前保持私有或不建。
- 确认 `@fluxvita` npm 组织的发布权限。
- 法务结论（`docs/zh-CN/spec/09-event-format.md` 第 9 节）在服务器模式上线前取得。
