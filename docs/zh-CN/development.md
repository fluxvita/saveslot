# 开发上手

[English](../development.md) · 简体中文

这一页带你从一份新克隆的仓库走到一个验证过的改动：搭环境、跑检查、找到改动该落在哪、演练一次小修复、调试一次失败。它写给要改这个仓库的人。只想让 Agent 用上 saveslot 的，从 README 的[上手](../../README.zh-CN.md#上手)开始。

提交改动的规矩（分支、拉取请求、签名、借助 AI 完成的改动）在 [`CONTRIBUTING.zh-CN.md`](../../CONTRIBUTING.zh-CN.md)，这里不重复。

> **支持的开发环境**：macOS 与 Linux，Node 版本见[搭环境](#搭环境)。搭环境、各项检查、[只跑一个测试](#只跑一个测试)里的命令和演练，是在 macOS（arm64）、Node 26.13.1、pnpm 12.14.0 上跑的，[常见失败](#常见失败)里的各项也是。Linux 上，项目的 CI 在 `node:24` 与 `node:latest` 镜像里跑同一条 `pnpm check`。Windows 没有试过。

## 现在能运行什么

目前的版本 0.2 已经实现：本机模式与服务器模式的服务、它的 HTTP 与 MCP 接口、`saveslot` 命令。0.2 还没做的，列在 README 的[状态](../../README.zh-CN.md#状态)一节。

除了构建、测试和仓库检查，还能运行自己构建出来的服务：`pnpm build` 之后，`node packages/saveslot/dist/bin.js setup` 会把它装好并启动，和 README [上手](../../README.zh-CN.md#上手)里的 `saveslot setup` 一样。

| 包 | 里面有什么 |
|---|---|
| `contract-core` | 内核与契约共用的数据形状：值的编码、证据、标记、意图、领域错误、事件格式的类型 |
| `kernel` | 日志、apply、判定、写入、读取、删除与操作层；存储接口 |
| `store-pglite` | PGlite 存储后端，本机模式用 |
| `store-postgres` | PostgreSQL 存储后端，服务器模式用 |
| `contract` | 操作契约：有哪些操作、只有外化面才有的字段、错误 |
| `service` | 服务层：身份、权限、幂等、句柄、限流、控制面存储 |
| `server` | HTTP 与 MCP 的适配 |
| `daemon` | 服务进程：选后端、读配置、后台任务调度 |
| `client` | 契约的 HTTP 客户端 |
| `cli` | `saveslot` 命令 |
| `saveslot` | 用户安装的包，提供 `saveslot` 命令 |
| `connector-ts` | 写连接器用的 TypeScript SDK，不发布 |
| `reference` | 参考求值器，测试用的对照实现。只有测试文件可以引用它 |
| `test-backend` | 测试打开存储时用的后端：PGlite，运行要求时换成 PostgreSQL。只给测试用 |

`experiments/` 放的是开发前实验的脚本，不在 `pnpm check` 里；做法与结果见 [`process/experiments/`](process/experiments/)。

每个包管什么、谁可以依赖谁：[讲解第 12 章第 1 节](guide/12-contributing.md#1-代码怎么分包)与[规格 `02-architecture.md` §11](spec/02-architecture.md#11-代码组织)。

## 搭环境

需要：

- **Git。**
- **Node 24.22.1 及以上（24 系列），或 26.12.1 及以上**，即 [`package.json`](../../package.json) 的 `engines` 字段。[`.nvmrc`](../../.nvmrc) 写的是 CI 用的版本。检查脚本是 TypeScript 文件，由 Node 直接运行，旧版本做不到。
- **pnpm 12.14.0**，即 [`package.json`](../../package.json) 里 `packageManager` 字段写的版本。按 CI 的装法装：`npm install --global pnpm@12.14.0`。

跑 `pnpm check` 不需要数据库、容器、网络服务、账号，也不需要任何环境变量。存储的测试在测试进程里运行 PGlite，只写临时目录。在 PostgreSQL 服务器上跑同样的测试是另一条命令 `pnpm test:postgres`，要有服务器和 `SAVESLOT_TEST_POSTGRES_URL`；CI 在合并之后跑它。

也不需要 C 编译器。`store-pglite` 有一个依赖 `fs-native-extensions` 是原生模块，它的包里自带 macOS、Linux、Windows 在 x64 与 arm64 上的预编译文件。在其他平台上它没有可加载的文件，`store-pglite` 的测试跑不了。

```sh
git clone <repository-url> saveslot
cd saveslot
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

`pnpm install --frozen-lockfile` 严格按 [`pnpm-lock.yaml`](../../pnpm-lock.yaml) 的记录安装，lockfile 与某个 manifest 对不上就失败。`pnpm build`（`tsc -b`，再跑 `scripts/mark-bins.ts`）成功时自己不输出任何内容。

`pnpm check` 是整个环境的成功判据。在上面那台机器上它用了大约一刻钟，大部分花在单元测试上。单元测试以同样格式的汇总结尾，数量是几千个；性质测试和其余各步的结尾是这样的：

```text
skipped: the tests against PostgreSQL (SAVESLOT_TEST_POSTGRES_URL names no server to run them on)
...
 Test Files  45 passed | 1 skipped (46)
      Tests  246 passed | 8 skipped (254)
...
✔ no dependency violations found (891 modules, 4239 dependencies cruised)
...
Doc links OK: 179 Markdown files checked.
JSON examples OK: 232 blocks parsed.
...
Translations OK: 38 English documents, each naming its Chinese source; not required yet: ...
...
Claims OK: 28 rows, 34 test references (4 to cases that run only under a condition).
```

这些数字会随代码增长；要看的是每一步都通过，命令以 0 退出。

## 各项检查

`pnpm check` 依次跑十一步，遇到第一个失败就停。每一步也是一条单独的脚本：

| 命令 | 验证什么 |
|---|---|
| `pnpm typecheck` | 各包和测试文件在 TypeScript 严格模式下能编译 |
| `pnpm lint` | Biome 的格式与代码检查规则。`pnpm format` 会改掉它能自动改的 |
| `pnpm test:unit` | 除性质测试外的全部 `*.test.ts` |
| `pnpm test:prop` | 性质测试（`*.prop.test.ts`，fast-check） |
| `pnpm deps` | 规格 `02-architecture.md` §4 与 §11 的包依赖规则和内核模块依赖规则 |
| `pnpm docs:links` | Markdown 文件里每个相对链接都指向存在的文件，每个 `#片段` 都指向存在的标题 |
| `pnpm docs:json` | Markdown 文件里每个 `json` 代码块都能解析 |
| `pnpm docs:translations` | 讲解与规格的每份文档都有英文版，英文版写明它的中文来源；英文文档链到的页面有英文版时，链英文版。英文版比中文来源旧的只报告，不算失败 |
| `pnpm docs:claims` | 断言索引（`docs/zh-CN/spec/11-claims.md`）的每一行都链回规格，写到的每个测试都存在、没有被跳过 |
| `pnpm docs:spec-refs` | 代码注释里对规格的每一处引用（文件加 `«»` 里的标题，见 [`CONTRIBUTING.zh-CN.md`](../../CONTRIBUTING.zh-CN.md)）写到的文件和标题都存在 |
| `pnpm conflict-markers` | 受版本管理的文本文件里没有合并冲突留下的行（以 `<<<<<<< ` 或 `>>>>>>> ` 开头） |

它们都不需要数据库，也不需要网络。

CI 跑 `pnpm check`，拆成三个作业（`check:static`、`test:unit`、`test:prop`）；在拉取请求上还多跑三项，本地也能跑：

| 命令 | 验证什么 |
|---|---|
| `pnpm dco` | `origin/main..HEAD` 里每个提交都有作者本人的签名 |
| `pnpm mr-title "<标题>"` | 拉取请求的标题符合 conventional commits |
| `pnpm terms` | 代码与规格引用的是规格章节，不是内部的裁定编号。项目的词表不在仓库里，本地运行会打印一条警告并跳过那一部分 |

CI 还用 gitleaks 扫描提交里有没有密钥。合并之后，CI 另外跑 `pnpm test:postgres`，并在 Node 26 上再跑一遍 `pnpm check`。

## 只跑一个测试

测试从仓库根目录运行。Vitest 把工作区里的包解析到它们的 TypeScript 源码，所以不用先构建。

```sh
# 一个文件
pnpm vitest run packages/contract-core/src/event/values.test.ts

# 一个目录下的全部测试（这里是一个包）
pnpm vitest run packages/kernel

# 全名匹配某个模式的测试
pnpm vitest run packages/contract-core -t "raw but not canonical"

# 监视模式：保存后自动重跑
pnpm vitest packages/contract-core/src/event/values.test.ts
```

这些参数是**路径过滤**：Vitest 运行路径里含这段文字的测试文件。它们不是 pnpm 的包选择器。各包没有自己的 `test` 脚本，所以 `pnpm --filter @fluxvita/saveslot-kernel test` 什么都不打印、什么都不运行，并以 0 退出。不要把它当成通过。

成功的运行以一行汇总结尾，例如 `Tests  41 passed (41)`。用了 `-t` 时，没匹配上的测试记为 skipped。

大致耗时，供你边改边选跑什么：`contract-core` 的一个测试文件远不到一秒。打开存储的测试要启动真实的 PGlite 实例，每个都要几秒；`store-pglite` 与 `daemon` 的测试大多如此，`kernel` 与 `service` 也有一部分。这样的整个包要跑几分钟，所以改的时候只跑你改的那个文件，其余的交给 `pnpm check`。

## 改动该落在哪

1. 在[讲解第 12 章「想改某样东西，去哪个包」](guide/12-contributing.md#想改某样东西去哪个包)里找到包，它管什么见[现在能运行什么](#现在能运行什么)那张表。
2. 改之前先读定义这个行为的规格章节。规格是权威，讲解是对它的解释。

| 你要改的 | 先读 |
|---|---|
| 值的写法、标识、事件类型或块 | [`09-event-format.md`](spec/09-event-format.md)；涉及调用方交来的值时，再读 [`04-contract.md`](spec/04-contract.md) 第 1 节 |
| 日志：追加、哈希链、清空块、校验 | [`02-architecture.md`](spec/02-architecture.md) §3 与 §8 |
| 存储后端或存储接口 | [`02-architecture.md`](spec/02-architecture.md) §7 与 §8 |
| 参考求值器里的重放、删除或撤销 | [`03-data-model/03-deletion.md`](spec/03-data-model/03-deletion.md) |
| 一个操作：参数、结果、错误 | [`04-contract.md`](spec/04-contract.md) |
| 一条 HTTP 路由、一个 MCP 工具或一条 `saveslot` 命令 | [`05-surfaces.md`](spec/05-surfaces.md)；命令再读 [`06-cli.md`](spec/06-cli.md) |
| 包之间或内核模块之间的一条引用 | [`02-architecture.md`](spec/02-architecture.md) §4 与 §11，然后跑 `pnpm deps` |

3. 确定哪些文档要随代码一起改：[讲解第 12 章「改设计时要同步什么」](guide/12-contributing.md#改设计时要同步什么)。改变行为的改动在同一个拉取请求里改规格。改了规格或讲解的文档，`docs/` 下它的英文版在同一个拉取请求里一起改。事件格式、内核不变量、操作契约的不兼容改动，要先有一份评审通过的决定稿。

测试和它测的代码放在一起：`values.ts` 的测试是同一目录下的 `values.test.ts` 和 `values.prop.test.ts`。

## 演练一次小修复

这一节在一个用完即弃的分支上重演一次真实的修复：提交 `226bdf0`（`fix(contract-core): restrict raw decimals to the JSON number grammar`）。这个修复已经合入，所以第 2 步先把缺陷放回去。这里的任何改动都不用提交。

**报告。** `isRawDecimal("007")` 返回 `true`，也就是调用方交来的带前导零的十进制会被接受。

**1. 找到规则和代码。** 调用方交来的十进制属于值的写法，上表指向 `04-contract.md` 第 1 节。其中「值的编码」一条写明：调用方的十进制遵循 JSON 数字的语法，前导零（`01`）不接受。所以这份报告是缺陷，不是缺功能。判定函数在 `packages/contract-core/src/event/values.ts`：

```ts
const RAW_DECIMAL_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;
```

**2. 把缺陷放回去。** 建一个分支，把那一行换成修复之前的写法：

```sh
git switch -c practice/raw-decimal
```

```ts
const RAW_DECIMAL_RE = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;
```

**3. 写出能复现报告的测试。** 在 `packages/contract-core/src/event/values.test.ts` 末尾加上：

```ts
describe("practice: raw decimals", () => {
  it("rejects leading zeros", () => {
    expect(isRawDecimal("007")).toBe(false);
  });
});
```

只跑这一个测试，看它失败：

```sh
pnpm vitest run packages/contract-core/src/event/values.test.ts -t "practice"
```

```text
 FAIL  packages/contract-core/src/event/values.test.ts > practice: raw decimals > rejects leading zeros
AssertionError: expected true to be false // Object.is equality
...
      Tests  1 failed | 41 skipped (42)
```

修复还不存在时，测试因为报告里说的那个原因失败，才说明这个测试查的就是这个缺陷。因为这个修复已经合入，去掉 `-t` 过滤的话，当时随修复一起加的测试也会失败；换成一个新缺陷，失败的就只有你写的这一个。

**4. 修复。** 恢复原来的那一行：

```sh
git restore packages/contract-core/src/event/values.ts
```

再跑同一条命令，结尾变成 `Tests  1 passed | 41 skipped (42)`。

**5. 扩大验证范围。** 先跑这个包，再跑全部：

```sh
pnpm vitest run packages/contract-core
pnpm check
```

**6. 确定哪些文档要改。** 代码现在做的就是规格原本写的，所以规格和讲解都不用动。假如修复改变了规格的说法（比如接受一种规格拒绝的写法），规格要在同一个拉取请求里改；又因为原始值会记进事件，这样的改动要先有决定稿。

**7. 丢掉分支。**

```sh
git restore .
git switch main
git branch -D practice/raw-decimal
```

真正的改动到这一步则是提交、签名、提拉取请求，做法见 [`CONTRIBUTING.zh-CN.md`](../../CONTRIBUTING.zh-CN.md)。

改文档走同一个循环，只是检查不同：改完页面，跑 `pnpm docs:links`、`pnpm docs:json` 和 `pnpm docs:translations`；改了断言索引的，再跑 `pnpm docs:claims`。页面在 `docs/zh-CN/spec/` 或 `docs/zh-CN/guide/` 下时，再跑 `pnpm terms`。

## 调试

**单步调试一个测试。** 让它启动后暂停，再接上调试器（Chrome 的 `chrome://inspect`，或编辑器的"附加到 Node 进程"）：

```sh
pnpm vitest run --inspect-brk --no-file-parallelism packages/contract-core/src/event/values.test.ts
```

运行会打印 `Debugger listening on ws://127.0.0.1:9229/...`，然后等调试器接入。

**复现一次性质测试的失败。** fast-check 会打印失败样本的 seed 和 path，以及它找到的最小反例：

```text
Error: Property failed after 4944 tests
{ seed: 1092691537, path: "4943:3", endOnFailure: true }
Counterexample: ["00"]
```

很多性质测试文件从 `PROP_SEED` 读 seed，其中一部分还从 `PROP_PATH` 读 path，读不读看文件开头。这样的文件不用改测试，直接重放那个样本：

```sh
PROP_SEED=<seed> PROP_PATH="<path>" pnpm vitest run <the failing *.prop.test.ts>
```

不读这两个变量的文件要改测试：把这个对象作为选项传给失败的那条性质的 `fc.assert(...)`（和已有的 `numRuns` 写在一起），运行就会直接走到那个样本。提交之前把它去掉。报告这次失败时，把 seed、path 和反例写进 Issue 或拉取请求。

**多跑一些样本。** 性质测试把 `PROP_RUNS` 当作样本数：

```sh
PROP_RUNS=20000 pnpm vitest run packages/reference/src/log.prop.test.ts
```

用它把样本数调高。其中很多性质还要求一个最低比例的样本走到它要查的情形，所以样本数太小时会单因这一条而失败。

**日志。** `saveslot setup` 启动的服务把日志写在 `~/.saveslot/run/saveslot.log`。测试里能观察到的，是测试运行和检查脚本的输出。

### 常见失败

| 现象 | 原因与处理 |
|---|---|
| 某个 `scripts/*.ts` 文件报 `ERR_UNKNOWN_FILE_EXTENSION` | Node 太旧，不能直接运行 TypeScript 文件。换成[搭环境](#搭环境)里写的版本（`node -v`） |
| `pnpm install --frozen-lockfile` 失败，列出差异（例如 `1 dependency was added: ...`）并建议重新生成 lockfile | 某个 `package.json` 改了，lockfile 没跟上。如果你是有意改依赖，跑 `pnpm install` 并提交 `pnpm-lock.yaml`；否则把 manifest 改回去 |
| `pnpm lint` 打印 `Formatter would have printed the following content` | 跑 `pnpm format`，再看一遍 diff |
| `pnpm deps` 以 `x 1 dependency violations` 结尾 | 它上面那一行写的就是那条引用。它跨过了规格不允许的包边界或内核模块边界；引用了一个本包没有声明的工作区包时，显示为 `no-unresolvable`。挪代码，或者先改设计；不要为了通过去改规则 |
| `pnpm docs:links` 打印 `<文件>:<行>: <目标> (file does not exist)` 或 `(no heading with this anchor)` | 目标文件或标题不存在。标题片段按 GitHub 的锚点写法 |
| `pnpm --filter <包> test` 以 0 退出且没有输出 | 没有任何测试运行。改用路径过滤（见[只跑一个测试](#只跑一个测试)） |
| 测试和规格里的例子对不上 | 先弄清哪一边是对的，再动其中一边。不要为了通过而放宽断言或改例子 |

### 贴输出之前

这个仓库的测试数据都是虚构的，测试输出通常可以直接分享。把日志贴进 Issue 或拉取请求之前，去掉：

- 含你的用户名或机器名的绝对路径；
- 令牌、凭证和环境变量的值；
- 内部的主机名和地址；
- 真实的个人数据（如果你拿自己的数据跑过代码）。

疑似安全问题按 [`SECURITY.zh-CN.md`](../../SECURITY.zh-CN.md) 私下报告，不要公开提 Issue。

## 提交改动

流程只写在 [`CONTRIBUTING.zh-CN.md`](../../CONTRIBUTING.zh-CN.md) 一处：拉分支或 fork、拉取请求的标题与模板、合并的条件、每个提交由人加的签名、借助 AI 完成的贡献、哪些东西不能提交。提拉取请求之前跑 `pnpm check`；提交做好之后再跑 `pnpm dco`。
