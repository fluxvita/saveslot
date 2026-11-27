# saveslot · 外化面：CLI 与上手流程

[English](../../spec/06-cli.md) · 简体中文

> 本文写第一版 CLI：谁用、怎么连 saveslot、从零到第一个 Agent 能用的上手流程、命令清单、人工确认的交互、输出约定与安全。
> CLI 与 [`05-surfaces.md`](05-surfaces.md) 里的 MCP、HTTP 并列，是契约的又一个外化面：操作形状以 [`04-contract.md`](04-contract.md) 为准，内核规则以 [`03-data-model/`](03-data-model/README.md) 为准；数值类的待定见 [`08-open-questions.md`](08-open-questions.md)。

## 1. 结论

- **CLI 是第一版里人的入口**：第一版不做 App，签发 / 吊销连接实例、处理待处理事项、删除与撤回、导出与导入、校验、建 slot 都由人经 CLI 做，或由人交代调用方 Agent 经 MCP 做（确认已委托给调用方，见 [`02-architecture.md`](02-architecture.md) §3）。
- **CLI 不自定规则**：除了管本地进程的几条命令，每条命令都映射到契约里的一个操作（或操作序列），经 `client` 走 HTTP；它自己只决定交互、渲染与退出码。
- **本地连接方式：saveslot 服务只在 unix domain socket 上监听**（第一版本地只支持 macOS 与 Linux；Windows 后续，届时用 named pipe），套接字文件只对当前系统用户可读写；CLI、`saveslot mcp`（给 MCP 宿主用的 stdio 桥）都经它调 HTTP / MCP。回环 TCP 默认关闭，按需打开。
- **用户会话凭证**：本地由 `saveslot init` 生成，存在 saveslot 配置目录（权限 0600）；云服务经 `saveslot login`（浏览器 + PKCE，无浏览器时用 OAuth 设备码）取得。
- **接入的设计要求**：**不论哪种部署方式，接入一个宿主的流程里，用户最多做选择和一次同意，其余步骤由 saveslot 完成。以后新增的接入方式都按这条检查。**
  - 选择：用哪个模板、接哪些宿主、给什么 scope、能看到哪些 slot、slot 叫什么。每个选择都有默认值，全部取默认也能走完。
  - 一次同意：对"saveslot 将在宿主那一侧做的事"整体同意一次。本机是"执行以下命令"的一次回答；服务器模式是授权页上的一次"授权"。
  - 不计入的：安装 saveslot 本身；人第一次登录自己的账户（服务器模式的 `saveslot login`，一次之后不再出现）；宿主自己要求的重启。可选增强（3.4 的自定义指令）也不在此列：接入不依赖它们。
  - 做不到时如实列出：某个宿主没有添加命令、只能手动粘贴配置的，是这条要求的已知例外（3.2）。
  - 理由：接入的每一步手动操作都会筛掉一部分人，而这些步骤里没有一步需要人的判断——人要判断的只有"接不接、给多大权限"。把人的参与收敛到选择与同意，同时也是安全上的改进：同意的对象是一份完整的、写明了的清单。
- **上手一条线**：`npm install -g @fluxvita/saveslot` → `saveslot setup` → 在宿主里问一句（Claude Code 里也可以输入 `/mcp__saveslot__overview`）。`setup` 只编排现有命令（3.3）；分步做是 `saveslot init` → `saveslot start` → `saveslot slot create health --template running` → `saveslot connect claude-code` → 把打印出的那条命令贴进终端 → 在宿主里问一句 → `saveslot reads` 看到自检之外的那次读取。
- **确认显式绑定内容**：CLI 处理事项时总是带上它刚展示给人的那份 `item_ver`，删除总是带上展示过的那份预览的 `dc_`；非交互式（`--yes`）允许，但必须显式给出这个绑定令牌，否则拒绝执行。契约规定不按 `item_ver` 绑定的两种处理除外（撤回删除不核对；`migration_diff` 的 `accept_all` 绑定 `diff_upto`），见第 5 节。

## 2. 定位与边界

### 谁用、做什么

| 使用者 | 用 CLI 做什么 |
|---|---|
| 用户本人 | 装好并启动本地 saveslot 服务（`saveslot setup` 一条命令，或分步）；建 slot；给每个 Agent 签发连接实例并接进宿主；处理待处理事项；删除与撤回；看谁读过什么；导出与导入；校验 |
| 有 shell 的 Agent、脚本 | 查询与 `--json` 输出。**应当凭自己的连接实例令牌运行**（环境变量 `SAVESLOT_TOKEN`）：受 scope 限制，读写记在该连接实例名下。直接用用户会话时什么都能做，而且全记在用户名下（第 8 节写明这一边界） |
| MCP 宿主 | 只用 `saveslot mcp`：宿主按 stdio 启动它，它把 MCP 消息转发给本地 saveslot 服务 |

### 不做什么

- **不做业务写入**：第一版没有 `saveslot write`。写入要把用户的话变成意图、行、值与证据，这是 Agent 的事（positioning「数据层」）；人要改数据，对 Agent 说，证据就是这句原话。没有 Agent 的脚本走 HTTP `POST /v1/writes`。
- **不直接打开数据目录**：除 `saveslot init` 外不碰 PGlite，所有读写都经 saveslot 服务，单写者锁与审计不被绕过。
- **不判断内核规则**：冲突、高影响、删除结果都由内核算出，CLI 只渲染契约返回的结构化字段。
- **不改宿主的配置文件，也不改宿主的指令文件**：只打印宿主自带的添加命令或配置片段，`--apply` 与 `saveslot setup` 时代为执行宿主自己的命令，不直接编辑 `~/.claude.json`、`~/.codex/config.toml` 之类文件；建议贴进宿主自定义指令的文案（3.4）由用户自己放，saveslot 不写 `CLAUDE.md`、`AGENTS.md` 之类文件。理由：
  1. **格式与位置归宿主所有，而且在变。** 同一个宿主有几处配置（按作用域分几处；有的宿主有两套 MCP 配置、其中一套将被移除），格式各异（JSON、带注释的 JSON、TOML）。宿主自己的命令跟着宿主走；saveslot 自己写文件，就得追着每个宿主的每次改动。
  2. **那些文件里不只有 saveslot。** 里面是用户别的 MCP 服务、别的密钥与设置。saveslot 的写入一旦出错（宿主正在运行时并发改写、丢掉注释与格式、写了一半），坏掉的是与 saveslot 无关的东西，而且用户很难知道是谁干的。指令文件更敏感：它是用户亲手写的、直接决定模型怎么做事的文字。
  3. **同意的对象可以逐字展示。** 展示给用户的就是将要执行的那条命令，它是宿主文档里写着的、用户自己也能敲的命令；"saveslot 将修改某某文件的某一段"做不到同样的确定。悄悄改别的程序的配置是不受欢迎的软件的行为方式，宿主与安全软件将来也可能拦截。
  4. **撤销是对称的**：用宿主的移除命令就能完整撤掉，不留 saveslot 自己的痕迹。

  代价是没有添加命令的宿主只能手动粘贴配置——这是第 1 节设计要求的已知例外，接受它，不为此破例去改文件。

### 与 HTTP、MCP 的关系

| | MCP | HTTP | CLI |
|---|---|---|---|
| 主要调用方 | Agent | 脚本、程序 | 人 |
| 凭证 | 连接实例 | 连接实例或用户会话 | 用户会话（默认）；设了 `SAVESLOT_TOKEN` 时用该连接实例令牌 |
| 管理类操作（[`04-contract.md`](04-contract.md)「管理类操作」） | 不提供 | 提供 | 提供，经 HTTP 管理类端点 |
| op 级 `acknowledge` | 不开放 | 开放 | 不涉及（不做业务写入） |
| 文本渲染 | MCP 渲染器（[`05-surfaces.md`](05-surfaces.md) 4.2「标记」、4.3「提醒与提示」） | 无，只有 JSON | CLI 渲染器：标记的写法同 MCP，下一步写成 CLI 命令 |

**代码位置**（[`02-architecture.md`](02-architecture.md) §11）：`cli` 包只依赖 `client`；服务组命令（`init`、`start`、`stop`、`status`、`service`、`doctor`、`config`、`mcp`、`server …`）由 `daemon` 包提供；`saveslot` 可执行文件是一个只做分发的入口包，依赖 `cli` 与 `daemon`。`saveslot setup` 跨两组命令（初始化、启动属于服务组，签发与接入属于 `cli`），由入口包编排，每一步调用的仍是原命令的同一段实现。`cli` 包另依赖 age 的官方 JS 实现 `age-encryption`（锁定版本），只用于导出加密与导入前的解密（4.8）；内核、服务层、`daemon` 都不依赖它。

### CLI 怎么连 saveslot

| 部署 | 传输 | 凭证 |
|---|---|---|
| 本地（默认） | HTTP over unix socket：`~/.saveslot/run/saveslot.sock` | 用户会话令牌，`Authorization: Bearer` |
| 本地 · 回环 TCP（可选） | `http://127.0.0.1:<port>`，`saveslot config set http.loopback on` 打开 | 同上 |
| 服务器模式（我们的云服务或自部署） | HTTPS，`https://<域名>/v1` | `saveslot login` 取得的用户会话 |

服务器模式的地址只能是一个来源（`https://<域名>[:端口]`，不带路径、查询与用户信息）；`http:` 只收回环地址（`127.0.0.1`、`::1`、`localhost`），供测试与本机隧道用，令牌不以明文出本机。CLI 不跟随重定向：3xx 不是契约的回应，令牌不会被带到另一个地址。

**本地选 unix socket，理由：**

1. **只供本机访问由操作系统保证**：套接字所在目录 0700、文件 0600，别的系统用户连不上；不占端口，没有"绑错到 0.0.0.0"的配置可能。
2. **浏览器打不到它**：回环 TCP 端口能被网页经 DNS 重绑定访问，unix socket 不能。
3. **单写者已经要求有常驻进程**：PGlite 住在 saveslot 服务进程的 DB Worker 里（[`02-architecture.md`](02-architecture.md) §7），同一台机器上的多个 Agent 只能经这一个进程共享，CLI 不另开存储。
4. **MCP 宿主不用支持 socket**：宿主启动 `saveslot mcp`（stdio），由它转发到套接字上的 `/mcp`；MCP 适配器只有 Streamable HTTP 一份实现。

回环 TCP 只为必须填 URL 的宿主或工具打开；打开后只绑 `127.0.0.1` / `::1`，校验 `Host` 与 `Origin`（拒绝非本机来源），每个请求仍要带令牌。

### 用户会话凭证

| 部署 | 怎么来 | 存在哪 | 失效 |
|---|---|---|---|
| 本地 | `saveslot init` 生成一个随机令牌；控制面只存它的哈希 | `~/.saveslot/credentials/session`，0600 | `saveslot init --rotate-session` 换新，旧令牌立即失效。要先 `saveslot stop`：它只换控制面里的哈希、不碰数据目录，saveslot 服务下次启动时读到新哈希；服务在运行时照样拒绝执行 |
| 云服务 | `saveslot login`：默认打开浏览器走授权码 + PKCE（本机回环接收回调，只收带这次登录的 `state` 的那一个，别的回 400、接着等）；`--device` 用 OAuth 设备码（RFC 8628），适合 SSH 里没有浏览器的情形，轮询间隔最长按 60 秒、设备码最多等一小时，服务器给得更长也一样；用户码是 8 个字母，取自 20 个辅音 `BCDFGHJKLMNPQRSTVWXZ`，响应里写成 `XXXX-XXXX`，输入时不分大小写、横线与空白忽略；CLI 只核形状 `[A-Z]{4}-[A-Z]{4}`、不核字母表，自部署的服务器也能用 | `~/.saveslot/credentials/<profile>.json`（访问令牌 + 刷新令牌，键见下），0600 | `saveslot logout` 吊销刷新令牌并删文件 |

- CLI 发现凭证文件的权限比 0600 宽时拒绝使用并提示修正，与 ssh 处理私钥的做法一致。第一版凭证放文件；放进系统钥匙串（可要求人在场才取出）随桌面打包一起做。
- **profile** 区分连接目标：`local`（默认）、`cloud`（我们的云服务，地址 `https://api.saveslot.ai`），以及 `saveslot login --server <URL> --profile <名字>` 时为自部署的服务器新建的 profile；`--profile` 或 `saveslot profile use` 切换。各目标互不相通（第一版没有同步）。
  - profile 的名字：1–32 个字符，`a-z`、`0-9` 与 `-`，不以 `-` 开头；`local`、`cloud` 是内置的，不能登记。
  - **`~/.saveslot/profiles.json`** 是 CLI 自己的文件（不是 saveslot 服务的配置）：`{"format": 1, "current": "<名字>", "servers": {"<名字>": "<地址>"}}`，`current` 是当前使用的 profile，`servers` 是登记的自部署服务器（地址写成来源，规则见上文「CLI 怎么连 saveslot」）。没有这个文件时当前 profile 是 `local`、没有登记的服务器。键不多不少，解析从严，不认识的写法拒绝使用。
  - **`credentials/<profile>.json`**（服务器 profile 的用户会话）：`{"format": 1, "server", "access_token", "access_expires_at", "refresh_token"}`，键不多不少。`server` 是令牌签发给的那台服务器，与这个 profile 的地址逐字相同才用，否则一个令牌都不发、提示重新登录。访问令牌离到期 60 秒以内（或刚被拒为 `unauthenticated`）时先用刷新令牌换新；刷新令牌只能用一次，所以换新要先取得这个 profile 的锁（`credentials/<profile>.json.lock`，独占创建；超过 30 秒算遗留，最多等 10 秒；持锁时发出的请求最长 20 秒，余下的 10 秒留给重读与写文件，锁不会在请求还没结束时被当成遗留拿走），取得后再读一遍文件，别的命令已经换过就用它换来的。换来的一对先写进文件再用；写不进去时这次登录就结束了（旧的刷新令牌已经用掉），提示重新登录，不拿内存里的新令牌接着用。刷新被拒（`invalid_grant`）时文件保留，提示重新登录；只有 `saveslot logout` 删文件。`saveslot login` 写进新的一对之后，尽力吊销被它替换的那次登录的刷新令牌：只在旧文件的 `server` 与这个 profile 的地址逐字相同时发，吊销失败只提示一次，不改变退出码。
  - 两个文件都按上面凭证文件的规则：所在目录 0700、文件 0600、属于当前用户、不能是符号链接，每次读写前都查；写入先写同目录的临时文件，同步后改名，再同步目录。
  - `saveslot login` 在向服务器发任何请求之前（也就在打开浏览器或取设备码之前）先按这条规则查一遍 home、`credentials/` 与这个 profile 已有的凭证文件，只查已经存在的：不符就什么都不发，退出码 6。否则一次登录要到写凭证时才被拒，人在浏览器里做完的授权白白丢掉。因这条规则拒绝时（`login` 与别的命令都一样），提示另起一行写明被拒的是哪一个目录或文件。
- **凭连接实例令牌运行**：设了环境变量 `SAVESLOT_TOKEN` 时，CLI 用它代替用户会话——能做的事按该连接实例的 scope，管理类命令报 `insufficient_scope`，读写与确认都记在该连接实例名下。给有 shell 的 Agent 与脚本用（第 8.3 节）。令牌发往所选 profile 的目标：`local` 是本机的 saveslot 服务，服务器 profile 是它的服务器（服务器模式用 `saveslot connect http --profile …` 签发的静态令牌就这样用）。`SAVESLOT_TOKEN` 设了但为空、或不是连接实例令牌的形式时，CLI 拒绝执行（退出码 6），不回落到用户会话：用户会话什么都能做，只有没设这个变量时才用它。

## 3. 上手流程（本地，从零到第一个 Agent 能用）

一条命令（细则见 3.3）：

```
$ npm install -g @fluxvita/saveslot    # 一个包装好 CLI 与 saveslot 服务；需要 Node 24.22.1 及以上（26 系列 26.12.1 及以上）
$ saveslot setup
[1/5] 已创建 ~/.saveslot（0700）
[2/5] saveslot 服务已在后台启动 · pid 4211
[3/5] 用哪个模板建第一个 slot？
        1 [x] running   跑步记录 → slot health
        2 [ ] spending  日常支出 → slot ledger
        3 [ ] budget    预算 → slot plan
      输入编号切换选中与否，直接回车确认：
      已建 slot health · schema v1 · 2 张表（runs、weekly_mileage）
[4/5] 接入哪些宿主？
        1 [x] Claude Code（claude 2.x）
        2 [x] Codex（codex 0.x）
        3 [ ] Cursor（没有添加命令，需要手动粘贴配置：saveslot connect cursor）
      输入编号切换选中与否，直接回车确认：
[5/5] 将为每个宿主签发一个连接实例（scope saveslot.read saveslot.write saveslot.schema），并执行：
        /usr/local/bin/claude mcp add saveslot --scope user -e SAVESLOT_TOKEN=<令牌> -- /usr/local/bin/saveslot mcp
        /opt/homebrew/bin/codex mcp add saveslot --env SAVESLOT_TOKEN=<令牌> -- /usr/local/bin/saveslot mcp
      执行以上 2 条命令？[Y/n]
Claude Code：已接入 · MacBook · Claude Code（ci_01JF…）
Codex：已接入 · MacBook · Codex（ci_01JG…）
完成。在 Claude Code 里输入 /mcp__saveslot__overview（斜杠菜单里显示为 /saveslot:overview）；在任何宿主里也可以问一句"saveslot 里有什么"。
可选：saveslot snippet claude-code（建议放进宿主自定义指令的一段文字）
```

**安装的前提**：`npm install -g` 要求 npm 的全局目录可写。Linux 上 Node 装在 `/usr/local` 时普通用户没有写权限，安装报 `EACCES`；说明文字给出 npm 的做法：设用户级的 prefix（`npm config set prefix ~/.npm-global`，并把 `~/.npm-global/bin` 加进 `PATH`），不建议用 `sudo`（装出来的文件属于 root，宿主登记的入口路径也随之落在系统目录里）。

宿主命令的确切写法由 CLI 的宿主适配表维护（3.2），**实现时逐个实测**。选择用编号切换的文本提示（输入编号切换某一项，直接回车确认），不进终端的原始模式、不加依赖；用方向键与空格勾选的样子留到桌面打包时再做。执行的宿主命令写的是在 `PATH` 里找到的绝对路径（3.2）。

**分步做**（`setup` 调用的就是这几条命令；评测与脚本继续用它们）：

```
$ saveslot init
已创建 ~/.saveslot（0700）
  data/          PGlite 数据目录（一个租户；已写入租户创世，登记用户主体与 system）
  control/       控制面（文件）：凭证哈希、租户目录、锚点（删除登记、seq 高水位、恢复次数）、句柄签名密钥
  credentials/   用户会话令牌（0600）
  run/           saveslot 服务运行时（0700）：saveslot.lock（服务进程一级的锁）、saveslot.pid、saveslot.sock、last-failure.json（上一次启动失败的原因码与时刻，存储格式升级失败时另带失败的那一步；就绪后删掉）、saveslot.log（后台运行时服务的日志，0600，追加写；只记事件名与原因码，不含路径、令牌与用户数据。服务自己写这个文件，写完一行发现超过 10 MiB 就轮转：最旧的一份删掉，`saveslot.log.1` 改名为 `.2`，当前文件改名为 `.1`，再新开一个，最多留两份旧的；Node 崩溃时写到标准错误的内容进的是 `saveslot start` 交给进程的那个文件，轮转之后就是最新的那份旧文件）
$ saveslot start
saveslot 服务已在后台启动 · pid 4211 · 监听 ~/.saveslot/run/saveslot.sock · 数据 ~/.saveslot/data
$ saveslot schema templates
running   跑步记录：runs（事件类）+ weekly_mileage（派生，每周跑量）
budget    预算：budgets（状态类，按 category）
spending  日常支出：expenses（事件类，CNY）+ monthly_total（派生）
$ saveslot slot create health --template running --timezone Asia/Shanghai
已建 slot health · schema v1 · 2 张表（runs、weekly_mileage）
$ saveslot connect claude-code --name "MacBook · Claude Code"
已签发连接实例 MacBook · Claude Code（ci_01JF…）· scope saveslot.read saveslot.write saveslot.schema
自检通过：用新令牌读到 1 个 slot
令牌只显示这一次。把下面这条命令贴进终端：
  claude mcp add saveslot --scope user -e SAVESLOT_TOKEN=<连接实例令牌> -- /usr/local/bin/saveslot mcp
可选：saveslot snippet claude-code（建议放进宿主自定义指令的一段文字）
```

`init` 之后 home 里还会出现 `tmp/`（0700）：`tmp/reconcile/<租户 ID>` 是对拍（`saveslot verify --replay`）的临时存储，每个租户一份，由服务在对拍开始时建出；对拍结束时不论成败都删掉，服务打开租户时清掉崩溃留下的（[`02-architecture.md`](02-architecture.md) §3）。

在 Claude Code 里问"saveslot 里有哪些 slot"，然后：

```
$ saveslot reads --connection "MacBook · Claude Code" --since 10m
11-10 21:03  MacBook · Claude Code  catalog list  slot health（sv 1）  自检（saveslot connect）
11-10 21:04  MacBook · Claude Code  catalog list  slot health（sv 1）
```

第一条是 `saveslot connect` 自己做的自检，不算数；看到自检之外的读取记录，才说明宿主确实经这个连接实例连上了 saveslot。再接 Codex 时重复 `saveslot connect codex --name "MacBook · Codex"`，两个 Agent 共用同一份数据、各自留痕。

各步的要点：

1. **安装**：第一版发一个 npm 包，含 CLI 与 saveslot 服务；独立可执行文件与桌面安装包等实验 6（桌面打包）的结论（[`07-scope-v1.md`](07-scope-v1.md)「实现顺序」）。
2. **初始化**：`saveslot init` 是唯一直接打开存储的命令，saveslot 服务在运行时拒绝执行。数据目录可用 `--data-dir` 另放（相对路径按当前目录解析，记下的是规范化后的绝对路径；不能与 `--rotate-session` 同用），落在 iCloud Drive、Dropbox 一类同步盘里时给出警告（[`02-architecture.md`](02-architecture.md) §7）；另放的位置记在 `control/tenant.json` 里，saveslot 服务启动时只按记下的位置打开数据目录，那里不存在或没有租户创世就拒绝启动，绝不在那里或别处新建一个空库（数据目录被挪走、没挂上的盘，都不该悄悄换成一份空数据）。数据目录不论默认还是另放，都由 `init` 以 0700 建出（已存在的收紧到 0700）。已存在且非空的数据目录 `init` 不用：在建 home 里的任何东西、打开任何存储之前就拒绝，退出码 5，什么都不改——它可能是另一个 home 的数据目录，打开它会把旧格式的存储原地升级。文案指出两条路：接着用它所属的 home；或在那个 home 里 `saveslot export`，用空的数据目录建新 home，再在新 home 里 `saveslot import`。判"空"与建出目录是同一步：目录不在就新建，在就必须是空的。另放的数据目录不在 home 的 0700 之内，存储建出的文件又是别人可读写的，所以 saveslot 服务启动时按 home 那条规则核它——属主是当前用户、不对组与其他人开放、不是符号链接——不符就拒绝启动（原因码 `data_dir_permissions`，提示写明是数据目录与修法）；默认位置 `<home>/data` 在 0700 的 home 之内，别人够不着，不另核，服务也不去改它的权限。`control/` 下是几个文件：`credentials.json`（令牌的哈希、用户会话）、`tenant.json`（租户目录）、`anchor.json`（锚点存储：删除登记、`seq` 高水位、恢复次数、"恢复进行中"与"导入进行中"标记）、`keys/`（句柄签名密钥）；每次写入都是"写临时文件 → 落盘 → 改名覆盖"，只有 saveslot 服务进程写（[`02-architecture.md`](02-architecture.md) §5、§8）。锚点不在数据目录里；但默认布局下两者同在 `~/.saveslot/`，系统级备份通常一起恢复，这时 saveslot 补不了也发现不了。只有用 `--data-dir` 把数据目录另放、且只恢复了数据目录时，才能按登记补删：用 `saveslot start --restored` 启动，服务先走恢复流程再对外服务；恢复流程中途被打断时，下次启动不管带没带 `--restored` 都会接着做完再对外服务（[`02-architecture.md`](02-architecture.md) §8；[`03-data-model/03-deletion.md`](03-data-model/03-deletion.md)「删除之后」）。
3. **启动 / 停止 / 自启**：`saveslot start` 后台启动（`--foreground` 前台，看日志用）；`saveslot stop` 先把 read_log 缓冲落盘、排空写队列再退出；它只对核对过的进程发信号：`GET /health` 应答、且报的 pid 与 `run/saveslot.pid` 一致时，对这个进程发 SIGTERM，等它退出；`/health` 不应答时才看 `run/saveslot.lock`——没被占着就是没在运行，残留的 pid 文件不算数，被占着（启动中或卡住）就不发信号（[`02-architecture.md`](02-architecture.md) §7）。探锁要短暂取一下锁，正在启动的服务恰在这一刻取锁会失败，所以 `stop` 与 `status` 都先问 `/health`，有应答就不探锁。`saveslot start` 等 60 秒仍没就绪时不停掉那个进程（它可能在走恢复流程），报错里写明它的 pid 仍在运行、稍后用 `saveslot status` 查看。服务在升级存储格式时（`/health` 报 `starting` 并带 `upgrade`，[`02-architecture.md`](02-architecture.md) §8「升级机制」），`saveslot start` 不计这 60 秒，一直等下去，每到新的一步在标准错误写一行正在做哪一步；升级做完，再从头等 60 秒。升级失败时退出码 5，写明失败的那一步与下一步该做什么（服务日志里有数据库的错误码；磁盘满就先腾出空间，再启动时从那一步接着升级）。升级之前先备份（[`02-architecture.md`](02-architecture.md) §8「升级前的备份」），这也算升级的一步，写成 `backup`；备份没做成（空间不够、复制失败、home 旁边已有一份与当前数据不同的备份）同样是 `upgrade_failed`，什么都没升级，服务日志的 `backup=` 写明是哪一种（`no_space`、`copy_failed`、`link`、`backup_differs`；`backup_differs` 另带 `differs=` 不同的是哪几样，`copy_failed` 另带 `code=` 文件系统的错误码），`saveslot start` 的文案写明每一种怎么办（`link`：把链接换回实体的文件或目录，或跳过备份）。**跳过备份**有两种写法：`config.toml` 的 `upgrade.backup = false` 管以后每次启动（含 `saveslot mcp` 的自动拉起），`saveslot start --no-upgrade-backup`（`--foreground` 同样）只管这一次；两者任一说跳过就跳过，参数不能把配置里关掉的备份打开。跳过时服务日志记 `upgrade_backup_skipped`；由 `saveslot start` 拉起的，看到升级开始时在标准错误提示一次（升级很快时 `start` 可能来不及看到升级中，这句就没有；服务日志里的 `upgrade_backup_skipped` 一定有）：`warning: the store is upgraded without a backup (upgrade.backup = false, or --no-upgrade-backup). Once upgraded, older versions of saveslot cannot open it, and there is no copy to go back to.``saveslot mcp` 不等升级：它拉起服务时看到升级中就不再等，升级期间对每个工具调用答 `unavailable`，文案写明正在升级存储格式与哪一步。开机自启 `saveslot service install`（macOS launchd 用户级代理，Linux systemd 用户服务；要求 home 已初始化，再装一次就按当前的 Node 与 saveslot 路径重写）：装好的作业在登录时拉起服务，服务在对外服务之后失败退出时再拉起它（[`02-architecture.md`](02-architecture.md) §7），开始对外服务之前就失败的、被 `saveslot stop` 停下的都不再拉起；`saveslot service uninstall` 移除作业，同时停掉它拉起的服务。宿主启动 `saveslot mcp` 时若 saveslot 服务没在运行，`saveslot mcp` 先把它拉起来——两个宿主同时拉起时，后到的发现套接字已在就直接连上，单写者锁兜底保证不会有两个进程写数据；这样装好自启之前，宿主照样能用。自动拉起默认打开，配置 `mcp.autostart = false` 可关；`saveslot stop` 时提示"MCP 宿主重新连接时会再次启动，彻底停用请关掉自动拉起或移除宿主里的 saveslot"。`saveslot mcp` 固定连本地 saveslot 服务，不随 `--profile` / `saveslot profile use` 变（云服务不经它，宿主直接走远程 MCP）。
   **测试时钟**（只用于评测，[`02-architecture.md`](02-architecture.md) §11「评测对实现的要求」）：`saveslot start --eval-clock <时刻>`（RFC 3339，带时差；`--foreground` 同样）让服务从这个时刻开始按真实速度往前走，服务进程里取"当前时刻"的地方都用它（请求、读取记录落盘、关闭、MCP 文本里的"挂了多久"），日志行仍用系统时间。运行中用户会话可以 `POST /v1/eval/clock`（`{"advance": "PT2H"}`，ISO 8601 的天、时、分、秒，只能向前）把它拨快；不带 `--eval-clock` 启动时没有这条路由（404）。它不读环境变量、不进 `config.toml`，`saveslot mcp` 的自动拉起从不带它。一次评测运行就是一个服务进程：第一次带 `--eval-clock` 启动时在 `control/eval.json` 留下评测标记（不进日志）；带标记的 home 不带 `--eval-clock` 一律拒绝启动（含自动拉起），带也拒绝再启动——服务中途退出，这次运行作废（原因码都是 `eval_dir_refused`）。没有标记的 home，只在日志里只有租户创世（刚 `init` 完）、且创世的记录时刻不晚于测试时钟的起点时才接受 `--eval-clock`，否则拒绝（`eval_clock_refused`）：前一条让它开不到用户的真实数据上；后一条是因为时钟落后于日志末端时，之后的事件都记成末端的时刻（[`02-architecture.md`](02-architecture.md) §8），测试时钟在日志里就看不出来了。评测运行器以夹具的时钟写租户创世，`saveslot init` 用的是系统时间，不接这个参数。saveslot 服务没有闲置自动退出，测试时钟不用另关什么。
4. **建第一个 slot**：`saveslot slot create` 就是 `schema_draft`（`base_version: null`），新建 slot 编译通过即生效、返回 `sv: 1`（[`04-contract.md`](04-contract.md)「`schema_draft`」）；建 slot 同时由内核写一条默认 slot 策略事件。带 `saveslot.schema`、范围为全部的连接实例也可以让 Agent 经 MCP 的 `saveslot_schema_draft` 建 slot，走的是同一个操作（[`05-surfaces.md`](05-surfaces.md) 第 9 节）。
5. **起步 schema 从哪来**：见第 3.1 节。
6. **签发并接入宿主**：见第 3.2 节。
7. **验证连通**：`saveslot connect` 用新令牌做一次 `catalog`（带固定的 `task: "saveslot-connect-selfcheck"`，`saveslot reads` 里标"自检"；`task` 是自报的，这个标记只为区分，不是保证），证明令牌、scope 与 saveslot 服务都通；宿主那一侧是否真的用上了，以 `saveslot reads` 里出现该连接实例**自检之外**的读取为准。签发的连接实例没有 `saveslot.schema` 时（显式去掉了它），输出另写一句"Agent 经这个连接实例能读写已有的表（只读的实例写"能读"），但不能新建 slot；要让它建，重新接时让 scope 里有 schema（不带 `--scope -schema`，或在 `--scope` 的完整列表里写上 schema）"；`setup` 的汇总里，本次接上了宿主而发出的连接实例没有 `saveslot.schema` 时，末尾写同一句；没有接上任何宿主、什么都没签发时不写。`saveslot doctor` 逐项检查：saveslot 服务在运行、套接字权限、凭证文件权限、数据目录不在同步盘、单写者锁持有者、版本一致、有没有逾期未物理删除的删除、各宿主里的 saveslot 条目指向的可执行文件路径是否还在（经宿主自己的查看命令，如 `claude mcp get saveslot`；没有查看命令的宿主不查、写明"未检查"，不读它的配置文件）；另有三项结果是"提醒"：系统时钟比日志末端的记录时刻早 5 分钟以上，以及**数据规模**——行数超过舒适线或实测线的表（表名、行数、级别），与租户一级的事件总数、数据目录大小、最近一次冷启动耗时（对照 architecture「容量边界与实测数值」的实测范围）；以及**宿主还没有经连接实例读过**——对每个查到 saveslot 条目的宿主，看 `saveslot connections list` 里未吊销、名字属于这个宿主的连接实例（3.3 第 7 条的两档合看：名字等于宿主显示名，或以" · <宿主显示名>"结尾，可带序号）；有这样的实例、而读取记录里它们都没有自检之外的读取时，给一条提醒，写明"这个宿主里的 Agent 还没有经 saveslot 读过任何东西；如果已经让它记过而没有记上，多半是宿主没有允许它使用 saveslot 的工具"，后面是这个宿主的放行办法：Claude Code 写"第一次调用时它会问一次，选允许；没有终端可问时（`claude -p`）加 `--allowedTools "mcp__saveslot"`"，别的宿主写"在宿主里确认它可以使用 saveslot 的工具"。这一条是从 saveslot 自己的读取记录推出的，不是查到的：宿主拒绝的工具调用到不了 saveslot，Claude Code 没有查看放行规则的命令，它的设置文件同样不读；所以刚接上还没用过的宿主、超过读取记录保留期没用过的宿主也会得到这一条，宿主经它读过一次就不再出现。没有这样的连接实例（名字是用户自己起的）时这一条不写。每项结果是"通过 / 不通过 / 提醒"之一；提醒不算不通过，不影响退出码。

### 3.1 起步 schema：随 CLI 打包的模板

- **第一版的做法**：CLI 包里带几份写好的 schema 文档（上面列出的三份），就是普通的用户 schema，格式完全按 [`03-data-model/07-schema-evolution.md`](03-data-model/07-schema-evolution.md)「schema 文档格式」，不用 `extends` / `compatibility`。`saveslot slot create --template` 把模板里的 slot 名、时区换成命令行给的值，作为草稿提交；没给 `--timezone` 时取本机时区（运行时给出的时区名），并在输出里写明是这样取的。用 `--file` 时 slot 名同样取命令行给的名字，时区保留文件里的值，给了 `--timezone` 则以它为准。
- **建完就归用户**：slot 与模板之后没有任何联系，CLI 升级换了模板也不影响已建的 slot；要改结构走 schema 变更（P4）。
- **为什么随包带、不从网上取**：离线可用、内容随 CLI 版本固定、不引入"远程 schema 来源"这个提示注入面（open-questions「社区 Schema + SKILL 的安全」）。
- **不用模板时**：`saveslot slot create <名字> --file schema.json`，文件可以是让 Agent 起草后保存的；也可以给某个 Agent 勾选 `saveslot.schema`，让它经 `saveslot_schema_draft` 直接建 slot。
- 官方 schema 第一版只在编译后的定义里留位、不实现（data-model「官方 schema 与用户 schema」；细则见 open-questions「官方 schema 的细则」）；实现之后，模板改为官方 schema 的 `extends` 形式，已用旧模板建的 slot 不受影响。除这三份之外的新模板（健康、营养等）在结构定下之后再写。

**三份模板的内容。** 单位取自单位词表，精度不写、用默认值（货币按 ISO 4217 的最小单位位数，其余 6 位，舍入 `half_up`，见 data-model「字段类型、同值与单位」）。`slot` 与 `timezone` 由命令行的值替换。评测的夹具（[`10-evals.md`](10-evals.md)「公共夹具」）用的就是这三份。

`running`（跑步记录）：

```json
{
  "slot": "health", "base_version": null, "timezone": "Asia/Shanghai",
  "tables": [
    {
      "name": "runs", "kind": "base", "description": "每次跑步一行",
      "time": { "type": "event", "field": "date" },
      "fields": [
        { "name": "date", "type": "date", "required": true, "description": "跑步当天（slot 时区的自然日）" },
        { "name": "distance", "type": "quantity", "unit": "km", "required": true, "min": 0, "description": "距离" },
        { "name": "duration", "type": "quantity", "unit": "min", "min": 0, "description": "用时" },
        { "name": "feeling", "type": "text", "description": "跑后感受，用户原话" }
      ],
      "duplicate_keys": [["date", "distance"]]
    },
    {
      "name": "weekly_mileage", "kind": "derived", "description": "每周跑量与记录覆盖，周一起算。某一周没有行表示那一周没有任何跑步记录",
      "rule": {
        "sql": "SELECT date_trunc('week', date::timestamp)::date AS week_start, sum(distance) AS total_distance, count(*) AS run_count, count(DISTINCT date) AS days_recorded, min(date) AS first_date, max(date) AS last_date FROM runs GROUP BY 1",
        "time_dependency": "bucketed"
      },
      "fields": [
        { "name": "week_start", "description": "该周周一" },
        { "name": "total_distance", "description": "该周总距离（km）；只含已记录的跑步" },
        { "name": "run_count", "description": "该周跑步次数" },
        { "name": "days_recorded", "description": "该周有跑步记录的天数（一周 7 天；不是每天都该跑，少于 7 不代表漏记）" },
        { "name": "first_date", "description": "该周第一条记录的日期" },
        { "name": "last_date", "description": "该周最后一条记录的日期" }
      ]
    }
  ]
}
```

`spending`（日常支出）：

```json
{
  "slot": "ledger", "base_version": null, "timezone": "Asia/Shanghai",
  "tables": [
    {
      "name": "expenses", "kind": "base", "description": "每笔支出一行",
      "time": { "type": "event", "field": "date" },
      "fields": [
        { "name": "date", "type": "date", "required": true, "description": "支出当天（slot 时区的自然日）" },
        { "name": "category", "type": "text", "required": true, "description": "类别，如餐饮、交通" },
        { "name": "amount", "type": "quantity", "unit": "CNY", "required": true, "min": 0, "description": "金额" },
        { "name": "note", "type": "text", "description": "备注" }
      ],
      "duplicate_keys": [["date", "category", "amount"]]
    },
    {
      "name": "monthly_total", "kind": "derived", "description": "每月支出合计与记录覆盖。某个月没有行表示那个月没有任何支出记录",
      "rule": {
        "sql": "SELECT date_trunc('month', date::timestamp)::date AS month, sum(amount) AS total, count(DISTINCT date) AS days_recorded, min(date) AS first_date, max(date) AS last_date FROM expenses GROUP BY 1",
        "time_dependency": "bucketed"
      },
      "fields": [
        { "name": "month", "description": "该月第一天" },
        { "name": "total", "description": "该月支出合计（CNY）；只含已记录的支出" },
        { "name": "days_recorded", "description": "该月有支出记录的天数（不是每天都有支出，少于当月天数不代表漏记）" },
        { "name": "first_date", "description": "该月第一条记录的日期" },
        { "name": "last_date", "description": "该月最后一条记录的日期" }
      ]
    }
  ]
}
```

`budget`（预算）：

```json
{
  "slot": "plan", "base_version": null, "timezone": "Asia/Shanghai",
  "tables": [
    {
      "name": "budgets", "kind": "base", "description": "各类别的月度预算",
      "time": { "type": "state", "granularity": "date" },
      "entity_key": ["category"],
      "fields": [
        { "name": "category", "type": "text", "required": true, "description": "预算类别" },
        { "name": "amount", "type": "quantity", "unit": "CNY", "required": true, "min": 0, "description": "月度预算金额" }
      ]
    }
  ]
}
```

- 货币模板写的是 CNY。要用别的货币，把模板存成文件、改掉 `amount` 的单位后用 `--file` 建 slot；建完之后换货币是"换量纲"，要走 schema 变更并给出换算（[`03-data-model/07-schema-evolution.md`](03-data-model/07-schema-evolution.md)「改动分类与迁移手段」）。
- `spending` 的疑似重复按"同一天、同一类别、同一金额"判；`running` 按"同一天、同一距离"判。命中只生成一个已标记事项，不拒绝写入。
- **覆盖列**：按时间分桶的派生表带三列——`days_recorded`（桶里有记录的天数）、`first_date`、`last_date`（桶里最早、最晚一条记录的日期）。"这周跑了 21 公里"是完整的一周还是只记了四天，由读的一方按这三列判断：`days_recorded` 等于这个桶应有的天数是完整（应有几天是领域知识，写在字段说明里）；小于是部分，首末日期说明缺在头、尾还是中间，当前这个桶还没过完时，`last_date` 与今天的差距说明是"还没到"还是"没记"；没有这个桶的行是这段时间一条记录都没有（分组聚合对没有输入的桶不产生行）。规则里不引用"今天"，否则会变成读时计算、不能缓存。`budget` 没有派生表。所用的 `count(DISTINCT …)`、对 `date` 取 `min` / `max` 须在受限 SQL 的白名单里（data-model [「受限 SQL」](03-data-model/11-restricted-sql.md)）；"每天一行"的表直接用 `count(*)`。

**之后的官方模板要遵守的设计约定**（健康、营养这类模板等官方 schema 实现之后再写）：

1. **两种粒度，不设第三种**：每次活动一行（事件类表：一次跑步、一次睡眠、一餐）；每天一行（事件类表，按 `date`：当天的步数、静息心率、平均血糖、睡眠总时长）。
2. **不建逐点读数的表。** 心率曲线、血糖曲线、GPS 轨迹留在产生它们的设备或服务里；saveslot 为每一行保留全部版本与来源，这些保证的代价随行数增长（positioning「场景判据」的适用范围）。
3. **用证据指过去**：汇总行的证据用 `file_ref`（文件名、类型、大小、内容哈希、来源位置）或 `tool_result`（来源服务返回的汇总文本），`origin` 写原始序列在来源处的位置。saveslot 不保管文件本身。
4. **汇总值就是这一行的字段**（`avg_hr`、`max_hr`、`min_glucose` 这类），由来源一侧或调用方 Agent 算好写入；派生规则在汇总行之上再汇总（周、月），不在原始读数上算。
5. 表的说明里写明粒度（"每天一行；不要逐条写入读数"）。
6. 按时间分桶的派生表带覆盖列。
7. 营养类模板里按标签抄数的体积字段用 `mL`，字段说明里写明：美国食品标签把 1 液量盎司按 30 毫升计，那是标签的取整约定，词表里的 `floz` 取的是定义值。

### 3.2 签发连接实例、接入宿主

`saveslot connect <宿主> --name <名字> [--scope …] [--slots <名字>,<名字>]` = `connections.issue`，再按宿主生成接入方式。下表是 CLI 的**宿主适配表**：每个宿主另记可执行文件名与取版本的参数（`saveslot setup` 用它发现本机装了哪些宿主，3.3）；命令的确切写法**实现时逐个实测**。

| 宿主 | 生成什么 | `setup` 能自动接 |
|---|---|---|
| `claude-code` | `claude mcp add saveslot --scope user -e SAVESLOT_TOKEN=<令牌> -- <saveslot 的绝对路径> mcp`（另有 `claude mcp get` / `list` / `remove`；2.1.323 实测，写进 `~/.claude.json`） | 是 |
| `codex` | `codex mcp add saveslot --env SAVESLOT_TOKEN=<令牌> -- <saveslot 的绝对路径> mcp`，或 `config.toml` 的 `[mcp_servers.saveslot]` 片段（另有 `codex mcp get` / `list` / `remove`，`get` 的行为见 3.3 第 7 条；0.171.0 实测，添加命令写进用户级的 `~/.codex/config.toml`；选择作用域的参数未核实） | 是 |
| `cursor` | 没有添加命令：打印配置片段，由人粘贴，并写明放进 `~/.cursor/mcp.json`（对所有项目生效；只对某个项目时放进项目的 `.cursor/mcp.json`）的 `mcpServers` 里（3.31.15 实测：启动时读到并连上，Agent 能调用） | 否 |
| `claude-desktop` | 没有添加命令：打印配置片段，由人粘贴，并写明放进 `claude_desktop_config.json`（设置 → Developer → Edit Config 打开的那个文件；macOS 在 `~/Library/Application Support/Claude/`，Linux 在 `~/.config/Claude/`）的 `mcpServers` 里，改完完全退出再打开（6.28899.6 实测：接上后出现在输入框 ＋ → 连接器 的列表里，与远程连接器在一处） | 否 |
| `vscode` | `code --add-mcp '{"name": "saveslot", "command": "<saveslot 的绝对路径>", "args": ["mcp"], "env": {"SAVESLOT_TOKEN": "<令牌>"}}'`，**只打印、不执行**（`--apply` 是用法错误），下面写明三件事：在 GitHub Copilot Chat 的 Agent 模式里用；同名条目会被直接覆盖；写完把那个 `mcp.json` 改成 0600（`chmod 600`，见表下"宿主命令的写法"）。1.147.0 实测：写进用户级的 `mcp.json`（macOS 在 `~/Library/Application Support/Code/User/`；Linux 在 `~/.config/Code/User/`，未核实）的 `servers` 里 | 否 |
| `generic` | 通用 JSON：`{"command": "<saveslot 的绝对路径>", "args": ["mcp"], "env": {"SAVESLOT_TOKEN": "<令牌>"}}` | 否 |
| `http` | 不生成宿主配置，只打印令牌与套接字路径（给脚本与连接器用；`curl --unix-socket` 可直接调） | 否 |

宿主怎么呈现 saveslot 的 prompts（[`05-surfaces.md`](05-surfaces.md) 10.1）：Claude Code（2.1.327 实测）的斜杠菜单显示为 `/saveslot:overview`，直接输入 `/saveslot:overview` 与 `/mcp__saveslot__overview` 都可以；但冒号写法后面带参数时报"Unknown command"，带参数只能写 `/mcp__saveslot__pending health`。参数按空白切开、按位置对应，多出来的词不进 prompt；含空格的值加引号。Cursor 的文档写着支持 prompts，没有写调用的写法（未核实）；Codex（0.167.2 实测）不支持 prompts：`/mcp verbose` 不列 prompts，两种写法都报"Unrecognized command"。`setup` 结尾的提示按这次的结果写：Claude Code 在接上的宿主里（这次接入或已有条目）时，写它的斜杠命令写法，再写"在任何宿主里也可以问一句"；不在时只写"在任何宿主里可以问一句"，不提 Claude Code。

- **宿主命令的写法**：服务名在前，`-e` / `--env` 在后，再接 `--` 与可执行文件。添加命令一律写**用户级**：saveslot 的数据按人不按项目，接入应当对这个用户的所有项目生效；Claude Code 的添加命令默认写"当前项目"这一档，所以显式带 `--scope user`，别的宿主有同类选项的同样处理。`vscode` 有添加命令，但 `--apply` 与 `setup` 都不执行它，只打印给用户自己执行：VS Code 的 MCP 宿主是 GitHub Copilot Chat 的 Agent 模式（Ask、Edit 模式不调用 MCP 工具），它的添加命令 `code --add-mcp '<JSON>'`（1.147.0 实测）写进用户级的 `mcp.json`（结构是 `{"servers": {"saveslot": {…}}, "inputs": []}`），同名时直接覆盖原条目、退出码 0、不提示，新建的文件权限是 0644，令牌落在本机其他用户可读的文件里；`code` 也没有查看单个条目的命令，3.3 第 7 条"先用宿主的查看命令判断已有条目"做不到。代为执行就等于悄悄覆盖用户已有的条目；收紧文件权限等于改宿主的配置文件，这两件 saveslot 都不做。所以 `connect vscode` 在命令下面写明：同名条目会被覆盖；令牌写进的 `mcp.json` 别的用户能读，写完自己 `chmod 600` 那个文件（macOS 与 Linux 各给出路径）。
- **没有添加命令的宿主**（`cursor`、`claude-desktop`）只能手动粘贴，是第 1 节设计要求的已知例外。
- **令牌只显示一次**：控制面只存哈希；丢了就吊销重签。`--apply` 时由 CLI 执行上表里宿主自己的添加命令，令牌不落进 CLI 的任何文件——**但会落在别处**：贴进终端的命令进了 shell 历史；`--apply` 执行宿主命令时令牌在进程参数里，执行期间本机其他用户能用 `ps` 看到；最后它住在宿主的配置文件里。`--apply` 执行成功时不再显示令牌：打印"已添加到 <宿主>"与执行的那条命令，令牌的位置写成 `<令牌>`（连接实例的 ID、名字与 scope 在签发那一行）；`--json` 的输出不变，仍是签发结果（含令牌）。"令牌只显示这一次"这句提示写到标准错误（`--json` 时也是），标准输出里只有要粘贴的东西。只用 unix socket 时这些暴露对别的系统用户无害（他们连不上套接字），打开回环 TCP 后就不是了（第 8.1 节）。各宿主命令的确切写法由 CLI 的宿主适配表维护，实现时逐个实测。
- **命令写绝对路径**：宿主启动 `saveslot mcp` 时的 PATH 未必包含 npm 全局目录（图形界面启动的宿主、用版本管理器切换 Node 的环境），所以生成的命令一律用 `saveslot` 可执行文件的绝对路径；`saveslot doctor` 经宿主自己的查看命令检查条目里的路径是否还在。
- **入口文件可以直接执行**：宿主拿到的是入口文件的路径，由它直接执行，所以入口文件首行是 `#!/usr/bin/env node`，并带执行位；构建在编译之后给它设执行位，入口不以这一行开头时构建失败。从源码检出运行：`pnpm install && pnpm build` 之后入口是 `packages/saveslot/dist/bin.js`，直接执行它（`packages/saveslot/dist/bin.js setup`），或用 `node packages/saveslot/dist/bin.js setup`；两种写法登记给宿主的都是这个文件的绝对路径。
- **`--scope` 的写法**：不给时是 `saveslot.read saveslot.write saveslot.schema`（读写，并能让 Agent 经 `saveslot_schema_draft` 新建 slot；不能删除，MCP 上也没有删 slot 的入口）。scope 在签发时定下，之后不变：之前签发的、没有 `saveslot.schema` 的连接实例要获得建 slot 的能力，重新 `connect`。两种写法，不能混用：
  - 增减式：`--scope +delete`（在默认上加）、`--scope -schema`、`--scope -write`（从默认里去掉；不让 Agent 建 slot 就是 `--scope -schema`，只读就是 `--scope -write,-schema`）；可重复或用逗号连写（`--scope +delete,-schema`）。`+schema` 已在默认里，仍是合法写法。
  - 完整式：`--scope read,write,schema`，列出的就是全部。
  - 名字可以省略 `saveslot.` 前缀。**每个连接实例都必须有 `saveslot.read`**：`-read`、或完整式里不含 `read`，是用法错误（退出码 2），不发请求。
  - 第一版 scope 签发后不能改，要改就吊销后重签（[`04-contract.md`](04-contract.md)「调用方：凭证与 scope」）。
- **签发之前先查的**（任一不行就不签发，退出码 1）：
  - 入口路径（上一条）存在、可执行，并且能原样显示。
  - 将要输出的每一种形式都能原样显示、不落进不可信边界：宿主的命令行、配置片段的每一行（JSON 编码之后，例如路径里的 `"` 会变成带转义的 `\"`）、`http` 的套接字路径。落进边界的输出贴出来不能用，令牌却已经显示了。
  - `--apply`：宿主的可执行文件由 CLI 自己在 `PATH` 里找（只看绝对路径的条目，取第一个可执行文件），找不到就不签发；执行的、显示的都是找到的那个绝对路径，成功与失败都写出来。
- **签发之后的失败**：
  - 服务给的令牌形状不对（或没有）：按自检失败处理。
  - 自检失败（用新令牌调 `catalog` 不通）：CLI 立即吊销刚签发的连接实例，不显示令牌，退出码 1，并写明自检报的错误；被吊销的名字仍然占用，提示换一个名字再 connect。
  - 标准输出写不出去（被关闭）：令牌只在这份输出里，CLI 尽力吊销刚签发的连接实例，退出码 1；`--apply` 已经成功时不吊销（令牌在宿主那里）。
  - `--apply` 执行宿主命令失败（非零退出、被信号终止、系统执行不了这个文件、60 秒内没结束）：连接实例保留，打印完整的那条命令（含令牌）让人自己执行，退出码 1；标准错误写明是哪一种。超时时宿主连同它启动的进程一起停掉（它在自己的进程组里）。宿主不经 shell 执行，它自己的输出读出后丢弃，不转给用户（它可能回显收到的参数）。
- **`--slots` 的写法**：slot 名的逗号列表，不给 = 全部（含以后新建的）。给了的每个都必须存在（否则 `not_found`（`slot`）），不能为空。限定了范围的连接实例只看得到这几个 slot，不能新建 slot，之后别人新建的 slot 也不纳入；范围签发后不能改，要改就吊销后重签（[`04-contract.md`](04-contract.md)「调用方：凭证与 scope」）。自检的那次 `catalog` 照常做，它只会看到范围内的 slot。
- **名字建议写"设备 · 宿主"**，它会出现在历史、事项发起者与读取审计里。
- **连接器取得凭证**：连接器（定时把外部系统的数据搬进 saveslot 的程序，不是 saveslot 的一部分）用 `saveslot connect http --name "手环 · 连接器" --slots health` 取得一个只碰它负责的 slot 的静态令牌，经 HTTP 写入（[`05-surfaces.md`](05-surfaces.md) 第 13 节）。
- **完成时的提示**：`connect` 与 `setup` 结束时在末尾提示一行"可选：saveslot snippet <宿主>"（3.4）。
- **服务器模式（云服务或自部署）**：宿主走远程 MCP 自己做 OAuth 授权，`saveslot connect claude-code --profile cloud`（自部署换成它的 profile）打印远程形式的添加命令 `claude mcp add saveslot --scope user --transport http https://<域名>/mcp`（写法同样实测）；这条命令里**没有令牌**，所以 `--apply` 与 `saveslot setup --profile` 会代为执行它。授权页上由用户命名、选 scope，两项都有默认值；经授权得到的连接实例 slot 范围是全部，用户不改就只点一次"授权"（[`05-surfaces.md`](05-surfaces.md) 第 15 节）。授权完成后用 `saveslot connections list` 能看到它，改名、吊销照常。这时 CLI 不签发任何东西，`--name`、`--scope`、`--slots` 是用法错误（它们在授权页上定；要静态令牌用 `connect http`）；没有添加命令的宿主拿到的是要粘贴的条目（`cursor`：按公开资料它的远程授权要动态客户端注册，0.1.0 不提供，所以 0.1.0 里 Cursor 接服务器用 `connect http` 的静态令牌。输出不说"宿主自己授权"，而是写明这一点和签发的命令 `saveslot connect http --profile <profile> --name <名字>`，再给出 `mcpServers` 里的一项 `{"url": "https://<域名>/mcp", "headers": {"Authorization": "Bearer TOKEN"}}`，由用户把 `TOKEN` 换成签发的令牌，填进它的 `mcp.json`；`--json` 照样是 `{host, server, url}`。动态注册在 0.1.0 之后，见 [`08-open-questions.md`](08-open-questions.md)；`generic`：`{"url": …}`）、只打印的添加命令（`vscode`：`code --add-mcp '{"name": "saveslot", "type": "http", "url": "https://<域名>/mcp"}'`，1.147.0 实测写进 `mcp.json` 的是 `{"type": "http", "url": …}`，它能不能凭这一项自己走完授权还没有实测；同名照样覆盖，条目里没有令牌，所以不提文件权限）或要在宿主界面里填的地址（`claude-desktop`：自定义连接器）。只有网页界面的宿主（Claude 网页端、ChatGPT）没有命令可执行，`saveslot connect <宿主> --profile cloud` 给出要在宿主界面里填的地址，这是设计要求的已知例外。没有 Agent 的脚本与连接器走不了 OAuth：`saveslot connect http --profile cloud [--slots …]` 由用户会话签发一个静态令牌，与本地一样按 scope 与 slot 范围、可吊销。

### 3.3 `saveslot setup`：一条命令完成上手

`saveslot setup` 只编排，每一步调用的就是现有命令的同一段实现；不引入任何它们没有的能力。命名：`init` 已有确定的含义（建目录、写租户创世，是唯一直接打开存储的命令，服务在运行时拒绝执行），给它加上"启动服务、签发凭证、动宿主"会让一个词有两种含义。不做成安装后自动运行：安装后脚本在用户没有表态的情况下执行，并且常被包管理器禁用。

| 步 | 做什么 | 等同于 | 已经做过时 |
|---|---|---|---|
| 1 | 初始化 | `saveslot init` | `~/.saveslot/` 已初始化：跳过 |
| 2 | 启动服务 | `saveslot start` | 已在运行：先比较服务与 CLI 的版本，一致则跳过；不一致时停下，提示先 `saveslot stop` 再重跑（不自动重启：可能有宿主正连着），退出码 1 |
| 3 | 建 slot（选择） | `saveslot slot create <名字> --template <模板>` | 已有任何 slot：不提问，跳过 |
| 4 | 发现并选择宿主（选择） | — | — |
| 5 | 展示将要执行的宿主命令，问一次（同意） | — | — |
| 6 | 逐个宿主：签发连接实例、自检、执行宿主的添加命令 | `saveslot connect <宿主> --apply` | 宿主里已有名为 `saveslot` 的条目：跳过，不重新签发；同时核对有没有对应的有效连接实例（第 7 条） |
| 7 | 核对并汇总 | 宿主的查看命令；`saveslot status` | — |

**各项细则**：

0. **在哪里能跑**：只在 macOS 与 Linux 上（第一版本地只支持这两个）；在 Windows 上说明不支持，什么都不做，退出码 2。设了 `SAVESLOT_TOKEN` 时也什么都不做，退出码 6：签发连接实例要用户会话。
1. **怎么发现本机装了哪些宿主**：在 `PATH` 里找到适配表（3.2）记的可执行文件、并成功运行它的版本命令（5 秒超时）。只运行宿主的可执行文件，不读宿主的配置文件。没有添加命令的宿主（只有应用、没有命令行的）按"配置目录是否存在"判断，只看路径存在与否，不读内容：Cursor 看 `~/.cursor`；Claude 桌面端在 macOS 看 `~/Library/Application Support/Claude`，在 Linux 看 `~/.config/Claude`。发现不了的宿主不出现在列表里，用户仍可用 `saveslot connect <宿主>` 单独接。
2. **多个宿主时怎么选**：交互式下是一个编号列表，输入编号切换选中与否，直接回车确认。有添加命令且已发现的宿主默认勾选；没有添加命令的宿主列出但不给编号（选不上），写明 `setup` 不接它、要用 `saveslot connect <宿主>` 手动配置。**每个宿主一个连接实例**，名字默认"<主机名> · <宿主显示名>"：主机名取第一段（`MacBook-Pro.local` 取 `MacBook-Pro`），最多 64 个码点（按码点截，不切开代理对）；主机名为空时名字只用宿主显示名；不让多个宿主共用一个连接实例，否则"谁读过、谁写的"分不开。
3. **同意只问一次、默认执行**：第 5 步把全部宿主命令一起展示，令牌的位置写成 `<令牌>`，回答一次；直接回车是"执行"。**先同意、后签发**：用户拒绝时不签发任何连接实例、不动任何宿主，退出码 8，并提示"之后可用 saveslot connect <宿主> 单独接入"。
4. **scope 与 slot 范围**：scope 默认 `saveslot.read saveslot.write saveslot.schema`，同意屏上如实列出这三项，`--scope` 可改，写法同 `saveslot connect`，对本次接入的所有宿主生效；要给各宿主不同的 scope，用 `saveslot connect` 分别接。`setup` 只签发 slot 范围为全部的连接实例，没有 `--slots`：它面向第一次上手，限定范围是有意的选择，用 `saveslot connect --slots` 单独做。
5. **宿主的添加命令写用户级**，写法照 3.2（服务名在前，`-e` / `--env` 在后，再接 `--` 与可执行文件）；确切写法由适配表维护，实现时逐个实测。
6. **非交互环境**（标准输入不是终端，或提问所写的标准错误不是终端——`saveslot setup 2>log` 时人看不到问题，回车不能算同意）：
   - 没给 `--yes`：什么都不执行，把将要做的步骤写到标准错误，退出码 8（与 5.4 一致）。这时还没有签发任何连接实例，写出的宿主命令里令牌的位置同样写成 `<令牌>`。
   - 给了 `--yes`：选择全部来自参数——`--template <模板>`（可重复；slot 名取模板的默认名）、`--timezone`、`--host <宿主>`（可重复）、`--scope`。**没给的选择按"不做"处理**：没给 `--template` 就不建 slot，没给 `--host` 就不接任何宿主；不猜，也不取"全部已发现的宿主"。没有人看着的时候，少做比多做安全。
   - `--host` 指向没有添加命令的宿主：用法错误，退出码 2。那条路要把令牌显示出来，不该发生在没有人看的地方。
   - 这些参数在交互式下也可以给，给了的那一项不再提问。
   - `--host` 与 `--template` 里重复的值只算一次（保持首次出现的次序），不报错；`--timezone` 只用于 `--template` 建的 slot，单独给是用法错误，退出码 2。
   - 建 slot 与 `saveslot slot create --template` 同一段：时区不合法时报同样的错误与提示，退出码按那个错误。
7. **重复运行是安全的**：每一步先看状态再决定做不做（上表最右一列）。"宿主里已有 saveslot 条目"用宿主自己的查看命令判断（Claude Code 的 `claude mcp get saveslot`；Codex 的 `codex mcp get saveslot`）。所以第二次运行只会补上没做完的步骤、接上新装的宿主，不会重复签发，也不会撞上"同名已存在"的报错。要换掉一个已有的接入：先用宿主的移除命令去掉条目、`saveslot connections revoke` 吊销旧的连接实例，再运行一次。
   - **宿主里有条目，不等于接入有效**：令牌不保存，`setup` 无法从条目反查它用的是哪个连接实例。按"已有条目"跳过时，先看条目里有没有这个 saveslot 的绝对路径：查看命令的标准输出与标准错误都看，先去掉终端转义序列（CSI、OSC 与单个 ESC），每条流最多读 1 MiB；路径两侧紧挨着的字符都不是路径字符（字母、数字、`.`、`_`、`-`、`/`、`~`、`+`、`@`），或者路径就在开头或结尾，才算"有"（`…/saveslot-old`、`…/saveslot+x`、`…/saveslot@2`、`…/saveslot~`、`/opt/usr/local/bin/saveslot`、`~/usr/local/bin/saveslot` 都不算；路径前后是括号、逗号、颜色码都算）。宿主换一种写法写路径（解析过的符号链接、`~`、加引号或转义）时看不出来；实测 Claude Code 2.1.327 与 Codex 0.167.2 都按添加时的原样写路径（不解析符号链接、不写 `~`，带空格也不加引号），所以按上面的规则能看到。实测的另两点：没有条目时两者都以退出码 1 结束、标准输出为空；`claude mcp get` 会启动服务器显示状态，启动失败时退出码仍是 0，所以查看命令成功只说明条目在，不说明它能用。看不到路径：记为"未确认"（`path_not_seen`），写明"没能确认它指向这个 saveslot；宿主里用着正常就不用管，否则移除后重跑"，并给出宿主的移除命令。看到路径：再看 `saveslot connections list` 里这个宿主的、未吊销的连接实例，分两档。第一档是名字正好等于 `setup` 在当前主机名下会起的名字（"<主机名> · <宿主显示名>"，可带序号）的：恰好一个，汇总记为"已有"并给出它；不止一个，仍记为"已有"，但**不指认**其中哪一个（令牌不保存，也不为了判断去读查看输出里的令牌），列出全部这些实例（ID、名字、最后一次自检之外的读取，没有就写明），由用户吊销不用的。没有第一档、只有第二档的——名字等于宿主显示名、或以" · <宿主显示名>"结尾（可带序号），也就是在别的主机名下签的（主机名会变：macOS 按网络给机器改名），或用户自己这样起的：不指认，记为"未确认"（`instance_unsure`），列出这些实例，写明"宿主里用着正常就不用管，否则移除后重跑"，给出宿主的移除命令，不新签发。两档都没有：记为"未确认"（`no_instance`），写明"宿主里有 saveslot 条目，但没有找到对应的有效连接实例"，给出宿主的移除命令。"未确认"不改变退出码。
   - **添加之后不靠路径定成败**：添加之前查过没有条目、添加命令成功、之后查到有条目，就是接上了，记为"本次完成"（`done`）；条目里看不到路径只多写一行说明（宿主各有各的写法）。"添加成功、条目却指向别的路径"只可能发生在添加之前就有条目时，而那时根本不会去添加。之后查不到条目是失败（第 8 条）。
   - **同时只能有一个 `setup` 在运行**：`setup` 开始时（初始化之前；`~/.saveslot/` 与 `run/` 不存在就先以 0700 建出来）在 `~/.saveslot/run/setup/` 下取一把独占锁，与 saveslot 服务的锁分开，到结束才放；拿不到时什么都不做，退出码 7，提示"另一个 saveslot setup 正在运行"。否则两个终端会同时看到"没有 slot""没有条目"，各自去建、去签发，再各自报失败。
8. **失败在中途时的状态与恢复**：

   | 失败在哪 | 留下什么 | 怎么恢复 |
   |---|---|---|
   | 初始化 | 可能有不完整的 `~/.saveslot/` | 停下，退出码 1；按 `saveslot init` 的报错处理后重跑 |
   | 启动服务 | 已初始化，服务没起来 | 停下，退出码 7；`saveslot doctor`，修好后重跑 |
   | 建 slot | 已初始化、服务在运行、没有 slot | 停下，退出码按 `slot create` 的错误；重跑会再问一次模板 |
   | 签发 | 该宿主没有连接实例 | 这个宿主记为失败，继续下一个宿主 |
   | 自检 | 无：刚签发的连接实例立即吊销（同 `connect`） | 同上 |
   | 宿主的添加命令失败 | **无：刚签发的连接实例立即吊销** | 标准错误写明宿主命令的退出状态；继续下一个宿主；重跑会重试这个宿主 |
   | 宿主命令成功，之后查看命令查不到条目（或查看没有结束） | 连接实例保留（宿主可能已经在用它） | 汇总写明"宿主命令执行了，但查看命令里没有名为 saveslot 的条目"，并给出撤回的两条命令：宿主的移除命令与 `saveslot connections revoke <ID>`；这个宿主记为失败（`no_entry`；查看没有结束时是 `lookup_failed`） |
   | 宿主的查看命令没有结束（5 秒） | 该宿主没有连接实例 | 这个宿主记为失败（`lookup_failed`），继续下一个宿主 |
   | 收到 SIGINT / SIGTERM / SIGHUP（终端关了）/ SIGQUIT | 正在执行的宿主命令（添加、`--version`、查看）连同它的进程组被杀，等服务就绪的那段也不再等；刚签发而宿主命令没有成功的连接实例尽力吊销，这个宿主照常记进结果（`interrupted`，带它的实例与吊销后的状态）；发现宿主时（`--version`）被打断，没探测完的宿主不记进结果，也不说它没找到 | 标准错误写一行"被要求停止"与已经做到哪一步，不写结尾的"完成"；按信号的惯例退出（129 / 130 / 131 / 143，即 128 加信号编号）。收到信号之后出的别的错误照它自己的原因报，退出码也按它 |
   | 某一问处输入结束 | 那一问之前做完的步骤 | 标准错误写明已经做了什么（已初始化、服务在运行、建了哪个 slot、接上了哪些宿主），退出码 8 |
   | 初始化：home 无法照原样使用——已存在且权限不是 0700（例如用户自己 `mkdir ~/.saveslot`）、是符号链接、是文件、属于别的用户，或还不存在而上面最近的已有目录当前用户写不了；home 里已有的 `control/`、`credentials/`、`run/` 是符号链接、是文件、属于别的用户或权限不是 0700 | 不变：在 home 里建任何东西（含 `setup` 的锁所在的 `run/`）之前就先查 | 写明路径、原因与对应的修法：权限不对给 `chmod 700 <路径>`，并写明目录里是空的还是已有几项（已有东西时也可以用 `--home` 换个位置）；符号链接要用 `--home` 给出它指向的目录；文件挡路要移开（写明挡路的是哪一个，如 `run`）；上级写不了要自己建好 home（0700）或换个位置；`control/` 一类子目录权限不对给 `chmod 700 <它的路径>`。退出码 1，`--json` 是 `{"initialized": "failed"}`；单独的 `saveslot init` 同样如此 |
   | 进程在"签发之后、宿主命令之前"被杀 | 一个没人持有令牌的连接实例 | 重跑时不自动吊销（同名的连接实例也可能是用户自己签发、正在别处使用的）；新签发的名字后加序号（吊销或停用的连接实例名仍然占用，同名不能再签发），并在汇总里列出这个宿主的旧连接实例（同第 7 条，不看主机名那一段）："旧连接实例 ci_…，签发后没有自检之外的读取，可用 saveslot connections revoke 吊销" |

   任何宿主失败时，最后的退出码是 1；汇总逐步写明"已有 / 本次完成 / 失败"。宿主命令失败时，它的退出状态（或被信号终止、执行不了、超时）写到标准错误，文本与 `--json` 两种输出都写。从 npx 的缓存启动时与 `connect` 一样提醒路径可能失效。宿主命令失败时吊销而不是保留，与 `saveslot connect --apply` 不同：`connect` 会把命令（含令牌）打印出来让人自己执行，`setup` 不显示令牌，留着一个没人拿到令牌的连接实例没有用处。
9. **令牌经过的地方**：只在 CLI 进程的内存、宿主命令执行期间的进程参数、宿主的配置文件里；不显示在终端上，不进 shell 历史（对照表见 8.2）。`--json` 的输出里没有令牌；非交互式下没给 `--yes` 时写到标准错误的步骤里也没有（那时还没有签发）。
10. **不代放 3.4 的文案**，只在末尾提示一行"可选：saveslot snippet <宿主>"。
11. **与现有命令的关系**：`init`、`start`、`slot create`、`connect`、`connections …` 全部保留、行为不变；`connect` 的默认仍是打印，`--apply` 才执行。评测与脚本继续用单条命令。`setup` 不安装开机自启（`saveslot mcp` 的自动拉起已经保证宿主能用）；汇总里提示 `saveslot service install` 随该命令（P6）一起加。
12. **`--json`**：见 6.1。
13. **服务器模式**：`saveslot setup --profile <名字>`（名字是 `cloud` 或已登记的服务器 profile；`local` 或不给就是本机这一支，与当前使用的 profile 无关）的步骤换成——没有登录就先走 `saveslot login`；没有 slot 时按模板建；对选中的宿主执行远程形式的添加命令（3.2）。这条路上**没有令牌**：凭证由宿主自己走 OAuth 取得，授权页上的"授权"就是那一次同意。
    - 不做初始化、不启动本机服务；第 7 条的锁照旧取在本机 `~/.saveslot/run/setup/` 下（home 不存在时先以 0700 建出来）。第 0 条照旧：设了 `SAVESLOT_TOKEN` 时退出码 6。
    - **登录**：这个 profile 的登录态能用（文件在、服务器对得上、需要时刷新成功）就跳过；否则交互式下走一次 `saveslot login`（给了 `--device` 时用设备码，`--device` 只用于服务器这一支，单独给是用法错误，退出码 2），登录失败按它的退出码停下，人在授权页上拒绝时退出码 8；非交互式（或给了 `--yes`）不登录，什么都不做，提示先 `saveslot login --profile <名字>`，退出码 8。刷新时与服务器之间出的错（连不上、回答读不懂、被拒）按服务器的错误报，不说成本机服务，退出码同 6.2。非交互式下没给 `--yes` 时写到标准错误的步骤里同样有"登录"这一步。
    - **宿主**：发现照第 1 条；能自动接的只有有远程添加命令的宿主（`claude-code`、`codex`），其余列出但不给编号，写明用 `saveslot connect <宿主> --profile <名字>`。`--host` 指向没有远程添加命令的宿主是用法错误，退出码 2。`--scope` 是用法错误，退出码 2：scope 在授权页上定。
    - **同意**：第 5 步展示远程添加命令（其中没有令牌），并写明宿主第一次用时会打开授权页；回答一次。
    - **宿主里已有名为 `saveslot` 的条目**：条目里看得到这个服务器的 `<地址>/mcp`（判定同第 7 条看路径）就是"已有"；看不到（本机的那条、别的服务器的）不覆盖，记为"未确认"（`other_entry`），给出宿主的移除命令。添加之后照第 7 条再查一次：查到是"本次完成"，条目里看不到地址只多写一行说明；查不到是失败（`no_entry`）。
    - **失败**：这一支没有签发，所以没有"吊销"一列——登录失败：停下，退出码按登录；人在授权页上拒绝：停下，退出码 8；宿主的添加命令失败：这个宿主记为失败，退出状态写到标准错误，继续下一个宿主；之后查不到条目：记为失败（`no_entry`），给出宿主的移除命令。
    - 不切换当前使用的 profile；汇总末尾提示宿主第一次用时要在授权页上授权，以及 `saveslot profile use <名字>`。`--json` 里没有 `initialized` 与 `service`，换成 `signed_in`，见 6.1；home 无法照原样使用时 `--json` 是 `{}`。

### 3.4 可选：宿主的自定义指令

saveslot 提供一段建议贴进宿主自定义指令的文案。宿主自己的指令文件通常权重更高，也是用户看得见、改得了的地方；有的宿主是否把服务器的 `instructions` 交给模型没有核实。**它是可选增强，不是接入的必经步骤**：不放这段文案，接入照样完成，评测的主配置也按没有它来算通过线（[`10-evals.md`](10-evals.md)「Agent 一侧」把它作为一个附加变体单独报告）。

**文案**（英文是默认，另有中文；以用户的口吻写，因为它放在用户自己的指令文件里）：

```
## saveslot
My long-term records (things that change over time: spending, workouts, budgets, progress) live in saveslot and are shared by all my agents.
- When I ask about my own records, numbers or history, check saveslot first (`saveslot_catalog`, then `saveslot_query` or `saveslot_sql`) rather than answering from memory.
- When I state a new fact that belongs in one of its tables, or correct an earlier one, save it with `saveslot_write` and include my exact words as evidence.
- If a receipt says something is pending confirmation, or a deletion is involved, show me the details and wait for my go-ahead.
```

```
## saveslot
我的长期记录（会随时间变化的事情：支出、运动、预算、进度）都在 saveslot 里，我用的各个 Agent 共用同一份。
- 我问到自己的记录、数字或过去的情况时，先查 saveslot（`saveslot_catalog`，再 `saveslot_query` 或 `saveslot_sql`），不要凭记忆回答。
- 我说出一件属于其中某张表的新事实、或更正之前说过的，用 `saveslot_write` 记下，并把我的原话作为证据带上。
- 回执说有内容待确认、或涉及删除时，先把详情给我看，等我同意再继续。
```

文案里没有任何用户数据，也不列 slot 名（那由 `instructions` 给，会随数据变）。

**`saveslot snippet [<宿主>] [--lang en|zh-CN]`**：打印文案与该宿主的放置位置；不给宿主时打印文案与下表。它不是契约操作，不连 saveslot 服务。不叫 `instructions`：这个词已经指 MCP 的服务级说明。

```
$ saveslot snippet claude-code
把下面这段加到 ~/.claude/CLAUDE.md（对所有项目生效），或某个项目的 CLAUDE.md：

## saveslot
My long-term records (things that change over time: spending, workouts, budgets, progress) live in saveslot …
```

**各宿主放在哪里**（建议放用户级：saveslot 是按人的，不是按项目的）：

| 宿主 | 用户级 | 项目级 |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | `./CLAUDE.md` 或 `./.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md`（设了 `CODEX_HOME` 时是其中的 `AGENTS.md`） | 项目根到当前目录各层的 `AGENTS.md` |
| VS Code（Copilot） | `~/.copilot/copilot-instructions.md` | `.github/copilot-instructions.md` 或 `AGENTS.md` |
| Cursor | 只能在界面里设（User Rules） | `AGENTS.md`，或 `.cursor/rules/` 下带头部的 `.mdc` 文件 |
| Gemini CLI | `~/.gemini/GEMINI.md` | 工作区及上层目录的 `GEMINI.md` |
| Antigravity CLI | `~/.gemini/AGENTS.md` 或 `~/.gemini/GEMINI.md` | 从启动目录往上到仓库根的 `AGENTS.md`、`GEMINI.md` 或 `.agents/rules/*.md` |
| Claude 桌面端与网页端 | 设置 → Your Claude → Instructions（只能在界面里改，对所有对话生效） | 项目说明 |
| ChatGPT | 设置 → 个性化里的自定义指令 | 项目说明 |

这张表随宿主的文档变，由适配表一起维护；发布前逐个核实。Gemini CLI 与 Antigravity CLI 并存：Antigravity CLI 面向所有用户，Gemini CLI 仍可经企业许可与付费 API 密钥使用；两者都读 `~/.gemini/GEMINI.md`，放在那里两边都生效。

**由谁放：用户。** saveslot 不写宿主的指令文件，`setup` 也不在同意后代放（理由见第 2 节"不做什么"）。没有一个宿主提供"往指令文件追加内容"的命令，代放只能直接编辑文件；而指令文件是用户亲手写的、直接决定模型怎么做事的文字，往里写字的工具必须让用户逐字看过。它确实是一步手动操作，所以算作可选增强，不在第 1 节设计要求的计数里。

## 4. 命令清单

全局参数：`--profile <名字>`、`--json`（输出契约的结构化结果，见第 6 节）、`--yes`（非交互式确认，见第 5 节）、`--limit` / `--cursor`（分页，同契约）。`saveslot --version`（单独使用）打印这个 saveslot 的版本并退出 0：与服务在 `/health` 报的、`saveslot start` 比较的、`saveslot status` 写作"这个 saveslot"的是同一个版本；不连服务。`saveslot --help` 打印用法。"出现于"列对应第 7 节的实现步骤。

### 4.1 服务（只在本地；管进程，不是契约操作）

| 命令 | 用途 | 关键参数 | 输出要点 | 出现于 |
|---|---|---|---|---|
| `saveslot setup` | 一条命令完成上手：编排初始化、启动、建 slot、接入宿主（3.3） | `--template`（可重复）、`--timezone`、`--host`（可重复）、`--scope`、`--yes`、`--profile`（服务器模式） | 每一步"已有 / 本次完成 / 失败"；每个宿主的连接实例与是否已接入；末尾提示 `saveslot snippet` | P1（`--profile` P5） |
| `saveslot init` | 建目录、写租户创世、生成用户会话令牌 | `--data-dir`、`--rotate-session` | 各目录与权限；同步盘警告 | P1 |
| `saveslot start` / `saveslot stop` | 启动 / 停止 saveslot 服务 | `--foreground`、`--restored`（数据目录刚从备份恢复：先走恢复流程；P3）、`--eval-clock`（测试时钟，只用于评测，第 3 节第 3 步）、`--no-upgrade-backup`（这次启动要升级存储格式时不先备份，第 3 节第 3 步） | pid、监听地址；走了恢复流程时写明补删了几项；`stop` 时有宽限期内的删除就提醒"到期时若 saveslot 没在运行，物理删除在下次启动时执行" | P1（`--restored` P3） |
| `saveslot status` | 进程状态 + 概况 | — | 版本、数据目录、监听、单写者锁（经 `/health` 的 `writer_lock`）、启动时补跑了哪些到期任务；待处理事项数（经 `pending`）；逾期未物理删除的删除；提醒：系统时钟比日志末端的记录时刻早 5 分钟以上（日志末端经 `log.end`，与待处理数一样带用户会话；取不到时这一条不出，也不报错）、行数超过舒适线或实测线的表；服务没在运行而上一次启动失败了时，加一行写出失败的原因码与时刻（`run/last-failure.json`，服务就绪后删掉；只有原因码与时刻，存储格式升级失败时另有失败的那一步）；服务在升级存储格式或升级失败时，加一行写出从哪个格式到哪个格式、正在做或失败在哪一步；以测试时钟运行时，第一行写明测试时钟的当前时刻，时钟落后的提醒也按它算 | P1（删除相关 P3；规模提醒随 P2 的目录概况） |
| `saveslot mcp` | 给 MCP 宿主的 stdio 桥 | 令牌取环境变量 `SAVESLOT_TOKEN`；`--record <文件>`（调用记录，只用于评测，[`05-surfaces.md`](05-surfaces.md) §11） | 不给人看；固定连本地；saveslot 服务未运行时先拉起（细节见 [`05-surfaces.md`](05-surfaces.md) §11「本机的 stdio 桥」） | P1 |
| `saveslot service install` / `uninstall` | 开机自启 | — | 写入的系统服务位置。作业里记的 Node 写成升级后仍在的路径：包管理器把每个版本放在带版本号的目录里（如 Homebrew 的 `Cellar/node/<版本>/bin/node`，升级后就没了），而固定的几处（`/opt/homebrew/bin`、`/usr/local/bin`、`/home/linuxbrew/.linuxbrew/bin`、`/usr/bin`、`/bin`；不读 PATH，那里可能有只在当前 shell 存活的链接目录）的 `node` 实际指向的正是这个 Node 时，写那个链接；找不到就写当前进程的路径。`saveslot doctor` 检查作业记的 Node 与 saveslot 入口还在不在、Node 版本够不够，不满足时给出重新 install 的命令 | P6 |
| `saveslot doctor` | 逐项自检（第 3 节第 7 步） | — | 每项通过 / 不通过 / 提醒，不通过的附修法；提醒（时钟落后、数据规模、宿主还没有经连接实例读过）不算不通过 | P6 |

**服务器自部署的运维命令**（P5；在服务器上跑，由 `daemon` 提供，不是契约操作；我们的云服务用的是同一组）：

| 命令 | 用途 |
|---|---|
| `saveslot server init` | 建控制面库的表（控制面的，远程授权的，与所选身份提供者的：设了 `SAVESLOT_IDENTITY_*` 时是外部登录的，没设时是内置本地账户的）、生成句柄签名密钥、创建第一个用户；连接与对外地址取下面「服务器模式的配置」。可重复执行：控制面库已初始化时只核对它的格式版本，密钥文件已存在时不动它，已有用户时不再创建第一个用户（也不问口令），只有一种例外：上次 `init --user` 建了同名账户却没建完它的租户，这次补完；格式版本不是这个 saveslot 认识的，什么都不做并报错。第一个用户的名字由 `--user <名字>` 给出，口令的读法同 `user add`；不给 `--user` 就不建用户。只用于内置本地账户：设了外部登录（`SAVESLOT_IDENTITY_*`）时给 `--user` 什么都不做，退出码 5 |
| `saveslot server start` | 以服务器模式启动（前台，交给 systemd 或容器管理）。某个租户的存储被别的版本升级到比这个版本新的格式之后，这个进程的 `GET /ready` 回 503（`/health` 照常回 200，带 `reason: "storage_format_newer"`），让负载均衡器把调用送到新版本的进程（architecture §7「锁与格式核对」）。收到 SIGTERM 或 SIGINT 后分三步下线，每一步有时限：① `/health` 的状态变为 `stopping`、`GET /ready` 回 503，其余请求照常处理，持续 `SAVESLOT_SHUTDOWN_DRAIN` 秒，让负载均衡器发现并停止转发；② 不再接受新连接，还开着的连接上新来的请求回 `unavailable`（`stopping`；`/v1` 以外的路径回 503），中止还在上传请求体的导入，等进行中的请求做完，至多 `SAVESLOT_SHUTDOWN_TIMEOUT` 秒，到时仍未结束的连接被关闭；③ 关掉租户（至多 10 秒）、放锁、关控制面库，退出码 0。到时还没关掉的租户不再等：卡在它上面的使用（例如在等这个租户的写锁）握着的数据库连接随进程退出断开，它的事务随之回滚，它的客户端在 ② 已被断开；进程照样在放锁之后退出，退出码不变，日志里记一条警告。下线期间再收到 SIGTERM 或 SIGINT，跳过 ①、② 余下的等待直接进 ③，仍然放锁。容器的终止宽限期不得短于这三段之和。`GET /ready` 与 `/health` 一样不需要令牌，给负载均衡器的健康检查与容器的就绪探针用：状态为 `ready` 时回 200，其余（`starting`、`stopping`、`failed`）回 503，响应体与 `/health` 相同；`/health` 在任何状态下都回 200，状态只在响应体里。启动时先取同一个控制面库上的"服务器在运行"锁，取到才往下做，运行期间一直持有：另一个 `server start` 取不到，退出码 7，什么都不做；`server restore` 这期间也取不到。锁在控制面库的连接上：运行中这条连接断了（数据库重启、主备切换、中间设备掐断空闲连接），锁也随之没了，这时立刻停止服务（`/health` 报 `failed`，原因 `control_database_lost`；其余请求回 503），关掉租户后退出，退出码 7，由进程管理器重新启动、重新取锁。控制面库里的表只核对、不建：控制面的表、远程授权的表与所选身份提供者的表（下面「服务器模式的配置」的 `SAVESLOT_IDENTITY_*`）都由 `server init` 建，不在或格式不认识时退出码 5，提示先运行 `server init`；换了身份提供者，也要先用新的设置重跑一次 `server init` |
| `saveslot server user add <名字>` / `list` / `disable <名字>` / `enable <名字>` | 管理内置的本地账户；不开放注册。只用于内置本地账户：设了外部登录时这几条命令在打开控制面库之前就拒绝，退出码 5（账户由外部平台管）。不取"服务器在运行"锁，服务器运行期间也可以执行。`add` 同时为这个用户建租户。`list` 按名字每个账户一行：名字、状态（`active` / `disabled`）、租户 ID（`server restore --tenant` 用的就是它）。`disable` 停用账户：停用期间，这个用户的租户的全部凭证（用户会话与连接实例，含经 OAuth 授权得来的）在认证时一律被拒，`unauthenticated`，`reason` 为 `account_disabled`（[`04-contract.md`](04-contract.md) 第 16 节）；不吊销任何凭证，不往租户日志里写任何事件，租户与数据不动。`enable` 重新启用：这些凭证原样恢复，停用期间到期的照常过期。要彻底停掉某个连接实例，用 `connections.revoke` 吊销它 |
| `saveslot server user passwd <名字>` | 改一个本地账户的口令，并作废这个用户现有的登录与用户会话（改之前签发的会话也续不了期）；连接实例不受影响，日志里不写任何事件。账户不在时退出码 4 |
| `saveslot server restore --tenant <租户>` / `--user <名字>` | 一个租户库从备份放回之后、再对外服务之前，在它上面走恢复流程：追加"恢复"事件、按删除登记补删、补跑已到期的删除；中途被打断可以重跑，接着做完（[`02-architecture.md`](02-architecture.md) §8）。租户用 ID 指定（`--tenant`），或用内置本地账户的名字指定（`--user`：恢复这个账户的租户）；两个恰好给一个、给一次，否则用法错误（退出码 2）。`--user` 按名字找账户，与 `server user disable` 一样：没有这个名字的账户（含不合账户名规则的名字）退出码 4；账户在而它的租户还没建完（`server user add` 中途停下，用同一个名字再运行一次 `add` 补完）退出码 5；已停用的账户照常恢复（停用只管认证）。`--user` 只用于内置本地账户：设了外部登录时在打开控制面库之前就拒绝，退出码 5，租户用 `--tenant` 指定。按名字找账户也在下面那把锁里做。控制面库不放回：恢复流程按它里面的删除登记与 `seq` 高水位做。只在同一个控制面库上没有服务器运行时执行：先取 `server start` 运行期间持有的同一把锁，取不到就什么都不做，退出码 7，提示先停服务器；执行期间一直持有，这期间 `server start` 起不来。没走这条命令就换了库、被打开时发现的，服务拒绝对外服务并提示运行它 |

`server init`、`user add` 与 `user passwd` 的口令只从终端或口令文件（`--password-file <路径>`）读，不接受命令行参数里的口令：参数会进 shell 历史与进程列表。没有终端又没给 `--password-file` 时什么都不做，退出码 8（同 `export --encrypt`）。终端上不回显，输两遍，两遍不同就重输，三次都不同什么都不做；口令文件按 `SAVESLOT_HANDLE_KEY_FILE` 那样核对（跟随符号链接之后是普通文件，本进程读得到，"其他人"没有任何权限位，组可读也可以；管道不收），取第一行（去掉行尾，以及开头的 UTF-8 BOM）。文件不在、不是普通文件、读不到、对其他人开放、第一行为空，各报一种原因，什么都不做，退出码 2；口令本身的规则（8 到 1024 个字符）不合时退出码 5。`server init --user` 给了口令文件时，这些都在建任何东西之前核对；从终端读时，要等表建好、确定要建这个账户时才问，这时三次两遍不同（2）、口令不合规（5）或按 Ctrl-C（130）都只是这个账户没建：密钥文件与表已就位，提示如实说明，重跑 `server init --user` 即可。

**服务器模式的配置**：只取环境变量，不读 `config.toml`（那是本机服务的配置，4.2）。`saveslot server …` 的各条命令读同一组变量；我们的云服务也用这一组。

| 变量 | 内容 | 缺省 |
|---|---|---|
| `SAVESLOT_CONTROL_DATABASE_URL` | 控制面库的 PostgreSQL 连接（[`02-architecture.md`](02-architecture.md) §5「控制面存储」） | 必填 |
| `SAVESLOT_CELL_DATABASE_URL` | 唯一的 cell 所在实例的连接，库名部分是建租户库时连的维护库；租户库建在同一个实例上，用同一个角色 | 必填 |
| `SAVESLOT_PUBLIC_URL` | 对外地址：远程 MCP 与 HTTP 的基地址，OAuth 的签发方与资源标识（RFC 8707），401 的 `resource_metadata` 由它拼出（[`05-surfaces.md`](05-surfaces.md) §14）。一个部署只有这一个对外地址，`/mcp`、`/v1`、`/oauth/*` 都拼在它后面，所以只写协议、主机与可选的端口：不带路径，不带末尾的 `/`。必须是 `https://`；只有主机是回环地址（`127.0.0.0/8`、`::1`、`localhost`）时才收 `http://`，供本机试跑。写法不合的按写法不对处理 | 必填 |
| `SAVESLOT_HANDLE_KEY_FILE` | 句柄签名密钥的文件。`server init` 在这里生成（0600；目录要已存在）；文件已在时只核对，不动它。`server start` 只读它、不写，可以按只读挂载；核对的是：跟随符号链接之后是普通文件，本进程读得到，"其他人"（other）没有任何权限位；不核对属主，组可读也可以。服务器模式不自动轮换密钥：部署方要换，就换掉这个文件再重启，换之前签发的句柄随之失效。文件不在、不是普通文件、本进程读不到、对其他人开放、不是它的格式，各报一种原因，退出码都是 5；报错里不写文件的内容 | 必填 |
| `SAVESLOT_LISTEN` | 监听的地址与端口。进程只说明文 HTTP，所以缺省只听回环地址，由同一台机器上的反向代理连进来；要听别的网卡（例如容器里听 `0.0.0.0`），由部署方显式写出 | `127.0.0.1:8080` |
| `SAVESLOT_TRUSTED_PROXIES` | 受信的反向代理，逗号分隔，每一项是单个地址或 CIDR 网段（如 `192.0.2.10`、`192.0.2.0/24`、`2001:db8::/32`）。连接来自落在其中某一项里的地址时，请求的来源地址取 `X-Forwarded-For` 里从右往左第一个不受信的地址；否则来源地址就是连接的地址（[`02-architecture.md`](02-architecture.md) §5）。登录失败的计数按这个地址算。前缀之后的位不为零、前缀长度越界或写法不严、盖住全部地址（`0.0.0.0/0`、`::/0` 一类）、带端口或 zone 的项按写法不对处理（[`02-architecture.md`](02-architecture.md) §5） | 空 |
| `SAVESLOT_ALLOWED_ORIGINS` | 可以在浏览器里跨源调用 `/v1/*`、`/oauth/token`、`/oauth/revoke` 的来源，逗号分隔（[`05-surfaces.md`](05-surfaces.md) §13）。每项写成浏览器在 `Origin` 里发的样子：协议、主机与可选的端口，小写，不写缺省端口，不带路径、不带末尾的 `/`；与请求的 `Origin` 原样比较，不支持通配。必须是 `https://`；只有主机是回环地址时才收 `http://`。有一项写法不合，整个变量按写法不对处理，报错写明是哪一项 | 空：不允许浏览器跨源调用 |
| `SAVESLOT_RATE_LIMIT` | 按租户限流：每个租户每分钟最多的请求数，正整数；设为 0 与不设都是关 | 不设：关（自部署默认关，[`02-architecture.md`](02-architecture.md) §9） |
| `SAVESLOT_RATE_BURST` | 限流的突发容量：一个租户一次最多连着发多少个请求，正整数；限流关着时不起作用 | 等于 `SAVESLOT_RATE_LIMIT` |
| `SAVESLOT_IDENTITY_ISSUER` | 外部登录：签发身份声明的平台，声明的 `iss` 须与它相同（声明的 `aud` 须是 `SAVESLOT_PUBLIC_URL`）。三个 `SAVESLOT_IDENTITY_*` 要么全设、要么全不设（只有空白的值算没设）：全设时身份提供者是外部登录，全不设时是内置本地账户（[`02-architecture.md`](02-architecture.md) §12「身份提供者」）；只设了一部分按写法不对处理，报错写明缺了哪几个。自部署不用设 | 不设：内置本地账户 |
| `SAVESLOT_IDENTITY_LOGIN_URL` | 外部登录：平台的登录地址，浏览器登录时被送到这里，只带 `state`。必须是 `https://`；只有主机是回环地址时才收 `http://` | 不设 |
| `SAVESLOT_IDENTITY_KEYS_FILE` | 外部登录：平台的公钥文件，JWK Set（`{"keys": [...]}`），每把是带 `kid` 的 Ed25519 公钥。与 `SAVESLOT_HANDLE_KEY_FILE` 一样核对：跟随符号链接之后是普通文件，本进程读得到，"其他人"（other）没有任何权限位，不核对属主，组可读也可以；不是这样就拒绝启动；文件里有私钥（`d`）时也拒绝启动，报错写明原因：平台的签名私钥只该在平台上。要换公钥，就换掉这个文件再重启 | 不设 |
| `SAVESLOT_SHUTDOWN_DRAIN` | 下线的摘除等待：收到终止信号之后照常处理请求的秒数（这期间 `/ready` 已回 503，见上面 `server start`），0 到 3600 的整数；0 表示不等 | `10` |
| `SAVESLOT_SHUTDOWN_TIMEOUT` | 下线的在途上限：摘除等待之后，等进行中的请求做完至多多少秒，0 到 3600 的整数；到时仍未结束的连接被关闭；0 表示不等、直接关闭 | `30` |
| `SAVESLOT_TENANT_CONNECTIONS` | 一个进程同时打开的租户数上限，也就是租户连接数的上限（每个打开的租户一条连接，[`02-architecture.md`](02-architecture.md) §7「连接」），1 到 10000 的整数。到上限时先关闲置最久的租户；没有闲置的，请求排队，5 秒内等不到回 `unavailable`（`busy`）。缺省 50：按下面的连接预算，一个进程在 PostgreSQL 默认的 `max_connections`（100）里用得下，还留出控制面库、导入与运维的余量；多于一个进程时，调低这一项或调高 `max_connections`；大的部署在连接预算之内调高 | `50` |
| `SAVESLOT_TENANT_IDLE` | 一个租户最后一次使用之后，空闲多少秒关掉它、放回它的连接，1 到 86400 的整数 | `300` |
| `SAVESLOT_CALL_RECORDS` | `on` 时，每次调用结束在标准输出上写一行调用记录（JSON，带 `"record": "call"`；字段见 [`02-architecture.md`](02-architecture.md) §9「调用记录」），由部署方的日志收集取走；`off` 时不写，标准输出与没有这一项时相同。应答头 `Saveslot-Call` 不随它变 | `off` |

**连接预算**：一个部署用到的 PostgreSQL 连接要满足 `SAVESLOT_TENANT_CONNECTIONS` × 进程数 + 4 × 进程数 + 同时进行的导入数 × 2 ≤ 实例可用的连接数。每个进程的 4 条是不计入上限的固定连接：控制面库一条；建库用的维护库一条，正在建的租户的库一条——建库与建租户在一个进程里各一次一个，排在后面的至多等 5 秒，等不到就回暂时忙（外部登录的首次登录回 503，带 `Retry-After`；`server user`、`server init` 退出码 7）；删库用的维护库一条——删库在一个进程里一次一个，没有人等它的应答，所以不设等待上限（删库要等一次检查点，忙的时候很慢，不与建库共用，免得把首次登录挡在后面）；导入一次直接打开两个库；可用的连接数是 `max_connections` 减去 `superuser_reserved_connections`、`reserved_connections` 与运维自己要用的。

必填的变量缺了，或值写法不对，命令什么都不做，写明是哪个变量，退出码 5（与 `config.toml` 被拒的退出码相同，6.2）；报错里不写变量的值（连接串里可能有口令），只有 `SAVESLOT_TRUSTED_PROXIES` 与 `SAVESLOT_ALLOWED_ORIGINS` 写明不合的那一项（地址与来源里没有需要保密的内容）。

### 4.2 登录与配置

| 命令 | 用途 | 关键参数 | 输出要点 | 出现于 |
|---|---|---|---|---|
| `saveslot login` / `saveslot logout` | 服务器模式的用户会话 | `--profile <名字>`（不给时用当前 profile，当前是 `local` 时用 `cloud`；显式给 `local` 是用法错误，退出码 2：本机模式不用登录）、`--server <URL>`（自部署的地址，与 `--profile` 一起给，登录成功后登记这个 profile）、`--device` | profile、服务器、令牌存放位置 | P5 |
| `saveslot profile list` / `use` | 切换连接目标 | — | 当前 profile 与地址 | P5 |
| `saveslot config get` / `set` | 本地 saveslot 服务的配置，文件是 home 下的 `config.toml`（可选：`saveslot init` 不生成它，没有这个文件时每个键取默认值）。数值策略的键都是正整数：`read_log.retention_days`（读取记录保留期，默认 180，不能低于 30）、`read_log.flush_seconds`（落盘间隔，默认 5，不能低于 1、不能超过 2147483）、`read_log.coarse_threshold`（改记表级记录的阈值，默认 1000，不能低于 1）、`high_water.events` 与 `high_water.seconds`（高水位推进间隔，默认 1000 条事件或 60 秒，都不能低于 1）。另有 `http.loopback`（回环 TCP，默认 `false`）、`mcp.autostart`（`saveslot mcp` 自动拉起服务，默认 `true`）与 `upgrade.backup`（升级存储格式之前先备份，默认 `true`；第 3 节第 3 步），都是布尔值。文件不是 UTF-8 或合法的 TOML、有不认识的键、有这一版还没有用到的键、值的类型不对或超出范围时，saveslot 服务拒绝启动，指出是哪个键、为什么（不认识 / 这一版不支持 / 值的类型与范围），不回落到默认值；文案只含键名、行号与范围，不含文件里的值。`config get` 列出每个键的生效值与来源（默认 / `config.toml`），这一版还没有用到的键也列出，标明"这一版未启用"。`config set <键> <值>` 只收这一版用到的键（`read_log.flush_seconds`、`mcp.autostart`、`upgrade.backup`）：别的键，包括上面列出、这一版还没有用到的，报"这一版不支持"、不写文件（写进去服务反而起不来）；值按键的类型与范围检查（布尔值写 `true` / `false`，也收 `on` / `off`），不合的报用法错误（退出码 2）；文件本身已不合法时不写（退出码 5）。写入时按它认得的键整份重写这个文件（0600），原有的注释不保留，有注释时写明。写完说明何时生效：`mcp.autostart` 在宿主下一次运行 `saveslot mcp` 时，其余在服务下次启动时（服务正在运行就提示先 `stop` 再 `start`）。自部署的服务器模式用同名的配置项 | 键、值 | 改后是否需要重启 | P1（只读），P6（可写） |

### 4.3 slot 与 schema

| 命令 | 契约操作 | 关键参数 | 输出要点 | 出现于 |
|---|---|---|---|---|
| `saveslot slot list` | `catalog`（`level: list`） | — | slot → 表名、一句话说明、派生表标"只读" | P1 |
| `saveslot slot show <slot> [表…]` | `catalog`（`level: table`） | `--tables` | 字段、类型、单位、说明、规则原文、数据概况（同 MCP `saveslot_catalog` 的文本） | P1 |
| `saveslot slot remove <slot 名或 sl_…>` | `slots.remove` | `--yes` | 移除的 slot 名与 ID；名字之后可以重用。先在全部 slot 里按 ID 精确匹配，没有才按名字；把名字解析成 `slot_id` 后在确认屏上显示，再按 `slot_id` 发（名字可以重用，按名字发的重试可能删掉同名新建的 slot）。没有终端可问、又没给 `--yes` 时不执行。有记录的 slot 拒绝（`slot_not_empty`） | P1 |
| `saveslot schema templates` | 无（列 CLI 自带的模板） | — | 模板名、包含的表 | P1 |
| `saveslot slot create <名字>` | `schema_draft`（`base_version: null`） | `--template` / `--file`、`--timezone` | 编译结果、回填的表 / 字段 ID、`sv: 1`；编译失败逐条列出位置 | P1 |
| `saveslot schema get <slot>` | `catalog`（`level: schema`） | `-o <文件>` | 完整 schema 文档（已填 `base_version`），可直接改了提交 | P4 |
| `saveslot schema draft <文件>` | `schema_draft` | — | `changes[]` 逐项类别与兼容性、影响预览；`outcome: applied` 写新 `sv`，`pending` 写事项 ID 并提示用 `saveslot pending show` 确认 | P4 |
| `saveslot policy show <slot>` | `policy.get` | — | 哪些改动自动生效、额外的高影响表 / 字段 | P6 |

### 4.4 连接实例与凭证

| 命令 | 契约操作 | 关键参数 | 输出要点 | 出现于 |
|---|---|---|---|---|
| `saveslot connect <宿主>` | `connections.issue` + 一次 `catalog` 自检 | `--name`、`--scope`、`--slots`、`--apply` | 连接实例 ID、scope、slot 范围、令牌（只此一次；`--apply` 成功时不显示）、宿主命令；末尾提示 `saveslot snippet` | P1（`--slots` P5） |
| `saveslot connections list` | `connections.list` | — | 名字、ID、scope、slot 范围（"全部"、slot 名列表，或范围里的 slot 都已移除时写明"没有 slot"——不是"全部"）、签发时间、是否已吊销或已停用 | P1（范围一列 P5） |
| `saveslot connections rename <名字或 ID> <新名字>` | `connections.update` | — | 新旧名字；历史里的 actor 不变，只是显示名变 | P6 |
| `saveslot connections revoke <名字或 ID>` | `connections.revoke` | `--yes` | 吊销时刻；之后该令牌的请求一律拒绝。先在全部连接实例里按 ID 精确匹配，没有才按名字；按名字匹配到不止一个时拒绝（退出码 2）并列出它们的 ID | P1 |
| `saveslot snippet [<宿主>]` | 无（打印 CLI 自带的文案，不连 saveslot 服务） | `--lang en\|zh-CN` | 建议贴进宿主自定义指令的文案与该宿主的放置位置（3.4） | P1（文案初稿；按评测结果在 P6 定稿） |

### 4.5 待处理事项

| 命令 | 契约操作 | 关键参数 | 输出要点 | 出现于 |
|---|---|---|---|---|
| `saveslot pending [list]` | `pending`（列出） | `--slot`、`--type`、`--status` | 按挂起时长排序：ID、类型、目标、一句原因、已挂多久 | P1 |
| `saveslot pending show <pi_…>` | `pending`（详情） | — | 见第 5 节；含 `item_ver` 与当前凭证可用的处理方式 | P1 |
| `saveslot pending resolve <pi_…> <处理方式>` | 先 `pending`（详情）再 `resolve` | `--candidate <下标>`（冲突事项有多个候选时）、`--item-ver`、`--note`、`--evidence-json <文件>`（证据段，形状同契约；处理会触发写入时作这次写入的源数据）、`--diff-upto`（随 P4b）、`--yes` | 见第 5 节；触发的写入、派生变化、被取代的事项 | P1（`awaiting_confirmation`、`conflict`、`flagged` 的 `keep` / `revoke`），P3（`deletion` 的 `cancel`），P4（`schema_change`） |

### 4.6 删除

| 命令 | 契约操作 | 关键参数 | 输出要点 | 出现于 |
|---|---|---|---|---|
| `saveslot delete --source <s_…>…` | `deletion_preview`（`kind: privacy`）→ 人确认 → `delete` | 可重复 `--source` | 预览全文、确认提示、删除回执（撤回期限与方法） | P3 |
| `saveslot delete preview --source <s_…>…` | `deletion_preview` | `--json` | 预览全文与 `dc_…`（10 分钟内有效） | P3 |
| `saveslot delete apply <dc_…>` | `deletion_preview`（`{confirm}`：按这个 `dc_` 重出预览）→ 人确认 → `delete` | `--yes`（跳过展示与提问） | 预览全文、确认提示、删除回执 | P3 |
| `saveslot delete cancel <pi_…>` | `resolve`（`deletion` · `cancel`） | `--yes` | 撤回结果：退回原状态的写入、恢复的事项、新 `ver`；（后续：被重新判定的候选及各自的结果，`rejudged`） | P3 |
| `saveslot delete status <pi_…>` | `pending`（详情，`deletion`） | — | 宽限期到期时刻、每处的状态（逻辑删除 → 物理删除 → 备份失效日期）；到期后仍可查 | P3 |

撤销一行不是删除，是一次业务写入，由 Agent 用 `revoke` 做。

### 4.7 查询与历史（给人看的）

| 命令 | 契约操作 | 关键参数 | 输出要点 | 出现于 |
|---|---|---|---|---|
| `saveslot query <表>` | `query` | `--where 'distance>5km'`（可重复）、`--order`、`--fields`、`--valid-at` / `--valid-during`、`--include-revoked`、`--detail` | 同 MCP `saveslot_query` 的行文本：`ver`、值、全部标记（含"前提已变"）；`--detail detailed` 在每行下面另起缩进行：最近一次改动的操作号与时刻、各字段的字面命中与来源级别（`ref` 字段附被引用行的摘要）、当前生效的全部前提声明（措辞同 MCP 文本，05 §4.1、§4.2） | P1（`--detail detailed` P2；派生表上服务回 `not_in_this_version`，CLI 按通用错误输出并补一句提示） |
| `saveslot sql '<SELECT …>'` | `sql` | `--param`、`--max-rows`、`--at` | 紧凑表格；头部汇总标记 | P2 |
| `saveslot history <表> <行或实体>` | `history`（`timeline` / `as_of`） | `--as-of <操作号/时刻>`、`--as-of-read <rd_…>`（按那次读取还原）、`--valid-at`（状态类表）、`--key <字段>=<值>`（状态类表按 `entity_key` 定位，代替实体 ID，可重复）、`--sources`（展开原文）、`--detail detailed`（只配 `--as-of` / `--as-of-read`：每行另列字段的来源级别与字面命中、最近一次改动；不列前提声明） | 每个版本：`#seq`、时间、写入者、意图、前后值、来源、声明的前提（重申与清除各一条）；读过它的读取 | P1（`--detail detailed` P2，同 `query`） |
| `saveslot history changes <表> [<行或实体>]` | `history`（`changes`） | `--since <操作号/时刻/my_last_read>`（必填）、`--until <操作号/时刻>`、`--key <字段>=<值>`（同 `history`；不给行、实体与 `--key` 就是整张表） | 一段记录时间内的变化，文本同 MCP `saveslot_history` 的 `changes`，翻页用 `--cursor`；`my_last_read` 指这个用户（或 `SAVESLOT_TOKEN` 的连接实例）上次读过的位置 | P2 |
| `saveslot sources [list / search <词> / get <s_…>]` | `sources` | `--slot`、`--kind`、`--from` / `--to` | 源数据列表或原文；已删除的只给墓碑信息 | P2 |

`history changes` 是子命令：`history` 后面的第一个词是 `changes` 时就按子命令读，后面的词是表名。所以一张表恰好叫 `changes` 时，它的时间线要写限定名：`saveslot history <slot>.changes <行或实体>`（第一个词不是 `changes`，按时间线处理）；这张表的变化写 `saveslot history changes changes --since 0` 或 `saveslot history changes <slot>.changes --since 0`。写成 `saveslot history changes <行>` 不会取到那张表的时间线：`<行>` 被当成表名，没带 `--since` 时报用法错误（退出码 2），带了报 `unknown_table`（退出码 4）。

`--where` 的简写只是把 `字段 运算符 值` 拆成契约的 `{field, op, value}`；带单位的量把单位写在数值后面（`'distance>5km'`），没写单位报用法错误；其余不支持的写法同样报用法错误；复杂条件用 `--where-json`（一个条件对象或条件数组，可与 `--where` 同给，合并成一个列表）。值按字段类型给：整数与小数照写（按十进制文本发送，不限位数），布尔写 `true` / `false`，其余照原样作字符串；字段类型取自这张表的 `catalog`（只在带 `--where` 时多读这一次）。含 `<`、`>` 的条件要加引号，否则会被 shell 当成重定向。`--valid-during` 写成 `<起>,<止>`，止留空表示开放；`history --as-of` 给操作号或时刻，`--as-of-read` 给读取 ID。`saveslot sql` 的语句是一个参数（整条加引号）；`--param` 可重复，按出现顺序对应 `$1`、`$2`…，一律作字符串发送，服务按 `$n` 在语句里的用法定类型（日期、数、文本都这样给）；布尔值与 `NULL` 直接写在语句里。每页行数用 `--max-rows`（默认 100，上限 1,000），不收 `--limit`；翻页用 `--cursor`；`--at` 是求值时刻。CLI 的读取与 Agent 的一样记入 read_log，actor 是用户；设了 `SAVESLOT_TOKEN` 时是该连接实例。

### 4.8 审计、导出、导入、校验

| 命令 | 契约操作 | 关键参数 | 输出要点 | 出现于 |
|---|---|---|---|---|
| `saveslot reads` | `reads.list` | `--connection`、`--since` | 时刻、连接实例、`task`、操作、读到的表 / 行与版本（`saveslot connect` 的自检标"自检"）；只给版本，不给值 | P1 |
| `saveslot export` | `export` | `-o <文件> [--force]`（默认标准输出）、`--after-seq`、`--include-pending-deletion`、`--encrypt`、`--passphrase-file <路径>` | NDJSON；加了 `--encrypt` 时是 age v1 的二进制文件（建议以 `.ndjson.age` 结尾）。结束时在标准错误写事件数、末尾 `seq`、是否含待删除内容；加密时另写"下次续传用 --after-seq <upto>"与解密命令 | P3 |
| `saveslot import <文件>…` | `import` | `--passphrase-file <路径>`（文件是 age 加密的导出时）、`--yes`、`--profile` | 执行前：原租户 ID、事件数、导出时刻、是否含待删除内容，以及"这份导出之后在原处做的删除不在其中"；结束时：停用了多少主体、补了多少墓碑、带不过来的东西（读取记录、凭证、外部文件），并提示用 `saveslot connect` 重新签发 | P5 |
| `saveslot verify` | `log.verify` | — | 事件总数；事件头链完整与否（或自第 k 条起断裂）；校验和不符的位置；索引列与事件头不符的位置；已按删除移除的位置；恢复留下的 `seq` 空档 | P1 |
| `saveslot verify --replay` | `log.reconcile` | — | 比较到的 `seq`；从空存储重放日志与线上的 (b) 类逻辑表逐表比较的结果；不一致时列出表与行（只给 ID）。执行时显示进度（重放、追平、比较），进入比较阶段时提示"写入暂时排队"；输出末尾写明它查不出 `delete` 自己算错的结果 | P2 |

**输出去哪**：`-o <文件>` 用独占创建（`O_CREAT|O_EXCL`，一步完成，不先查再写）、权限 0600；文件已经在时拒绝、不写任何字节，退出码 2；这一查在向服务发请求、读口令之前先做一次，最后的独占创建照旧保留。要覆盖带 `--force`：写到同一目录下新建的临时文件（独占创建、0600），整条流成功结束后再改名覆盖；中途失败删掉临时文件，原来的文件原样不动，并如实说明。`-o` 是符号链接时，`--force` 替换的是链接本身，链接指向的文件不动；不带 `--force` 时链接与文件一样算「已经在」。不带 `--force` 写到一半失败（断流、磁盘满）时，留下的文件是残缺的，提示里写明。理由：导出文件常常就是备份，被一次手误覆盖的代价比多打一个参数大。文件在拿到服务的第一批字节时才创建，所以被服务拒绝的导出不留空文件。`--encrypt` 且标准输出是终端、又没有 `-o` 时拒绝，退出码 2，说明加密的输出是二进制、请用 `-o <文件>` 或重定向；不加密时 NDJSON 照常可以写到终端。

`--include-pending-deletion` 在交互式下要再确认一次："导出里将包含宽限期内待删除的内容，撤回期过后它们仍留在导出文件里。"非交互式下必须同时给 `--yes`，否则不执行，退出码 8。

**导出的口令加密**（`--encrypt`）。导出格式不变；加密是 CLI 的可选项，用公开的 age v1 格式、口令接收方（scrypt），加密的是整条导出流（含第一行的清单）。不做私有格式：项目是开源的，自造一个容器什么也藏不住，只多出一个别人不认识的格式。不选 OpenPGP（各实现在新的认证加密模式上不互通，许可证比项目严）、`openssl enc`（没有认证，密文被改动发现不了）、JWE（整段一次加密，不适合大文件的流）、加密 ZIP（密钥派生太弱，文件头不加密）。

- **口令从哪来**：默认直接打开控制终端读，不回显，输入两遍、不一致就重来——读的是控制终端而不是标准输入，所以 `saveslot export --encrypt > 文件` 照常能提示。`--passphrase-file <路径>` 读那个路径的第一行（不含行尾 `\r\n` / `\n`），给脚本与密码管理器用；密码管理器的输出用 shell 的进程替换交给它：`saveslot export --encrypt --passphrase-file <(pass show saveslot) -o backup.ndjson.age`。路径按给出的样子打开（跟随符号链接：Linux 上进程替换给的 `/dev/fd/63` 本身就是链接），检查的是打开后拿到的对象：普通文件要归当前用户、权限不宽于 0600，与凭证文件同一条规则，否则拒绝并说明怎么改；管道（进程替换、命名管道）要归当前用户，权限位各平台不同、不看；字符设备（终端上的 `/dev/stdin`）照收；目录、套接字、块设备拒绝。从管道读时最多等 30 秒，写方一直不写就拒绝，不挂死；读完即关。给了 `--passphrase-file` 而没给 `--encrypt` 是用法错误（退出码 2），不悄悄当成加密。没有终端、也没给口令文件：不执行，退出码 8。
- **口令不出现在命令行参数与环境变量里**：没有 `--passphrase <口令>`（命令行参数会进 shell 历史，执行期间本机其他用户用 `ps` 看得到）；第一版也不读环境变量（一些系统上能被别的进程读到，而且会被子进程继承）。
- **Windows 上只支持 `--passphrase-file`**：那里没有对应的控制终端设备文件。Windows 上给了 `--encrypt` 而没给 `--passphrase-file` 是用法错误（退出码 2）。本机服务本来只支持 macOS 与 Linux，这条只影响用服务器 profile 在 Windows 上跑的 CLI。
- **口令的要求**：不能为空；短于 12 个字符时警告一次，不拒绝。口令按给出的字节原样使用，不做 Unicode 规范化（与 age 一致）；为让同一个口令从文件、管道、终端得到同样的字节，任何来源里含控制字符（含 Tab）或以字节序标记（BOM）开头的一律拒绝并说明，不悄悄去掉。终端上输入空口令或含控制字符的口令时与「两遍不一致」一样重问，三次为限。saveslot 不保存口令，也没有找回的办法，交互式下在读口令之前写明这一点。
- **工作因子**用格式的默认值（scrypt 的 log₂N = 18），不提供调节参数：官方 JS 实现在解密时拒绝大于 20 的值，调高了会出现"加密得了、同一个库解不了"的文件。标准输出是终端时拒绝输出密文（用法错误）；第一版不做文本包装。
- **续传**：每次导出（含带 `--after-seq` 的续传）是一个独立的 age 文件，有自己的文件头与盐，可以用不同的口令。密文不能拼接（age 文件后面带着多余数据会被拒绝）：要把几段合起来，先各自解密，再按导出格式的续传规则把明文按顺序接起来。中途被打断的加密导出是一个被截断的 age 文件，解密到末尾会报错，不能往后续写，用同一个 `--after-seq` 重新导出这一段。加密后清单行不解密就看不到，所以结束时写明下次续传用的 `upto`。
- **解密**：用任何 age 实现，不需要 saveslot（`age -d -o export.ndjson export.ndjson.age`，或 `rage -d`）；第一版不提供 saveslot 自己的解密命令。`saveslot import` 遇到 age 文件时在 CLI 里解密、再上传明文，口令的来源与规则同导出；服务端不接受 age 文件，那样就得把口令交给服务端。
- **它防什么、不防什么**：防导出文件离开这台机器之后被别人拿到（网盘、移动硬盘、备份、转发）。不防导出那一刻本机上与用户同权限的程序（它们本来就读得到数据目录）、口令太弱、忘了口令。它不是存储加密：存储第一版不做应用层加密（positioning「技术选型」）。
- **实现**：`cli` 包依赖官方的 `age-encryption`（锁定版本）。CI 里做互通测试：`saveslot export --encrypt` 的文件用 `age` 命令行解开，与明文导出逐字节相同；口令经 `age-plugin-batchpass` 非交互地提供（`AGE_PASSPHRASE_FD`），CI 里没有终端也能跑。

```
$ saveslot export --encrypt -o saveslot-2026-11.ndjson.age
口令不会被保存，忘了就无法解开这份导出。
输入口令：
再输入一遍：
已导出 1284 条事件，末尾 seq 1311，不含待删除内容；已用口令加密（age v1）
下次续传用 --after-seq 1311；解密：age -d -o export.ndjson saveslot-2026-11.ndjson.age
```

**导入**（`saveslot import`）把一份导出装进一个**空租户**（日志里只有创世事件、锚点里没有登记与进行中的标记）；本机模式下目标就是 `saveslot init` 之后的那个租户，服务器模式加 `--profile`。几段续传文件按顺序给出，CLI 接在同一个请求体里上传。执行前读清单并要求确认，非交互式下必须给 `--yes`（否则退出码 8）。导入前登记的、仍有效的主体（原来的用户与连接实例）一律停用（已吊销的保持吊销），历史里的写入者照旧显示、标"已停用"；所有接入要在目标处重新签发。迁移的做法是：源头停止写入 → 导出 → 导入 → 在目标处重新签发 → 停用源头。规则见 [`04-contract.md`](04-contract.md)「管理类操作」。

### 4.9 后续（第一版不提供）

| 命令 | 为什么不在第一版 |
|---|---|
| `saveslot policy set` | `policy.set` 与 slot 策略的高影响 ③ 后续（[`07-scope-v1.md`](07-scope-v1.md) 3.3） |
| `saveslot jobs`、抽取作业相关 | 大写入作业与抽取作业后续；`migration_diff` 的处理随 P4b 加进 `saveslot pending resolve` |
| `saveslot history composition` | 派生值构成后续 |
| `saveslot delete --evidence`、按行隐私删除 | 删除证据、按行删除后续 |
| 合并导入（导入到已有数据的租户）、`saveslot migrate` | 第一版只做导入到空租户（4.8）：合并要回答两条日志的 `seq` 怎么交错、同名 slot 怎么办、两边的删除登记怎么并，那是多节点的问题 |
| `saveslot write` | 见第 2 节"不做什么"：人手写 op 与证据容易出错，证据也会退化成 `api_call`；真有"人想不经 Agent 改一个值"的需求时再加，纯增量 |
| `saveslot verify --replay` 的离线形式 | saveslot 服务起不来时停机直接打开数据目录比较；第一版只有经服务的对拍 |
| Windows 上的本地服务 | 第一版本地只支持 macOS 与 Linux |
| `--passphrase-fd <n>`（从文件描述符读口令） | Node 不提供分辨一个描述符是用户的 shell 打开的、还是运行时自己的（close-on-exec 位）的办法；编号写错时会读到运行时管道里的字节当口令，加密出来的文件再也解不开。第一版用 `--passphrase-file` 加进程替换 `<(…)` 代替 |

## 5. 人工确认的交互

### 5.1 列出与详情

`saveslot pending` 按挂起时长排序，最早的在前；事项不过期，CLI 不提供"清理旧事项"的捷径。`saveslot pending show` 的渲染：

```
pi_9B… 待确认 · marketing.budgets 推广 · 已挂 3 小时 · 版本 iv_7e…
  发起：MacBook · Codex，11-10 18:02 · 原因：抹掉已记录的变化点
  提议：11-02 起改为 3000 CNY（一直延续）
  会被覆盖的段：
    11-10 起 4000 CNY（#103，MacBook · Codex 记录）→ 将改为 3000
  当前值不变，直到确认。
  可选：confirm / reject
```

- **会被覆盖的段、会被回掉的写入、仍引用该行的行**（事项详情的 `impact`）逐条列出：写入 `#seq`、写入者、原值 → 新值、区间（含端点的人话）。
- 冲突列出当前生效值与每个候选（同 [`05-surfaces.md`](05-surfaces.md)「各工具的文本要点」的 `saveslot_pending`）；schema 变更按事项详情里的草稿部分列出 `changes[]` 与影响预览，并写明影响预览是草稿提交时的估计。
- 只列当前凭证可用的处理方式；用户会话全都可用。
- 目标受一项仍待执行的删除影响的事项（契约的 `blocked`）：`saveslot pending` 在这一行标明此刻不能处理；`saveslot pending show` 不列处理方式，写明是哪几项删除、最晚何时到期，以及等它们执行之后再处理；〔P3 起〕另写撤回（逐项写出 `saveslot delete cancel pi_…`，撤回会把删掉的东西放回来）。这类报错的说法相同。

### 5.2 处理：怎么绑定内容

`saveslot pending resolve <pi_…> <处理方式>` 在一次调用里做三步：

1. 取详情（`pending`），拿到 `item_ver`，按 5.1 渲染给人看；
2. 交互式时提问：`确认对 pi_9B… 执行 confirm？上面列出的 1 段将被覆盖 [y/N]`；
3. 用**第 1 步拿到的那个 `item_ver`** 调 `resolve`。

- **CLI 从不依赖兜底**：契约允许不带 `item_ver` 时取本连接实例最近读到的版本（[`04-contract.md`](04-contract.md)「版本令牌」），但兜底取的是这个凭证最近一次读到的版本：另一个终端、另一个用同一凭证的程序刚读过的更新版本会被取到，而眼前这个人看的是旧的；CLI 总是显式带上本次展示的那一份，"确认的就是人刚看到的"。
- **调用方给了 `--item-ver`**：原样发它，不换成 CLI 刚取到的版本。交互式下取到的版本与它不同，直接说明"自那个版本以后内容已变"，展示当前内容并重新提问；带 `--yes` 时**不取详情**、不展示，直接调 `resolve`，对不上由服务端报 `confirmation_mismatch`。
- **第 1 步取到的详情带 `blocked`**（目标受一项仍待执行的删除影响）：照 5.1 展示，不提问、不调 `resolve`，退出码 5（与 `resolve` 报 `pending_deletion_target` 时相同）。
- **第 1 步取详情时事项已经关闭**：不提问，说明已按什么处理、或被什么取代，退出码 3（与 `resolve` 返回 `item_closed` 时相同）。
- **冲突事项有多个候选而没给 `--candidate`**：交互式下列出候选（下标、值、写入者）让人选；非交互式是用法错误，退出码 2，输出里列出候选的下标。
- **契约规定不按 `item_ver` 绑定的处理照契约走**：`deletion` 的 `cancel` 不核对（5.3）；`migration_diff` 的 `accept_all` 带展示时的 `diff_upto`（`--yes` 时必须给 `--diff-upto`，随 P4b）。
- **内容变了**（`confirmation_mismatch`）：交互式时渲染错误里附带的当前内容，说明"自你查看以后内容已变"，重新提问；非交互式时不自动重试，退出码 3，输出新的 `item_ver`。
- **已关闭**（`item_closed`）：说明已按什么处理、或被哪次写入取代，退出码 3（写法同事项详情：谁、哪种处理方式、`take_candidate` 取的是第几个候选、解决时带的备注；备注是调用者写的文本，放在不可信边界内）；同一处理方式重发得到重放结果时，写"该事项已于 … 按 confirm 解决，本次没有新的改动"，退出码 0。
- `--note` 记进日志（`UntrustedText`，可随删除清除）；人写的理由放这里。

### 5.3 删除：预览 → 确认 → 撤回

```
$ saveslot delete --source s_R1
将删除 1 条源数据、影响 1 行，重算 1 个派生值
runs r_01JC… 整行删除：date 只来自这句话
以下原本未生效的写入将会生效：
  （无）
不会删除：schema 中的枚举值与说明；删除后保留的元数据（某时有过一行、被谁写过几次）
本地服务：到期时 saveslot 若没在运行，物理删除在下次启动时执行；Time Machine 等系统级备份里的旧副本不由 saveslot 管理
确认删除请输入 delete：delete
已删除，24 小时内（至 11-11 21:05）可撤回：saveslot delete cancel pi_4K…
```

- 预览的各段按 [`03-data-model/03-deletion.md`](03-data-model/03-deletion.md)「预览与回执要写明的内容」渲染；"原本未生效、将会生效的写入"单列，没有也写"（无）"，让人知道看过这一项。
- **确认要输入 `delete`，不接受单键 `y`**：删除是唯一在宽限期后不可逆的操作。
- 确认时用的就是刚展示的那份预览的 `dc_`。`preview_outdated` 时契约给出新预览：交互式重新展示、重新提问；非交互式退出码 3，输出新的 `dc_`。`handle_expired`（超过 10 分钟）同理，提示重新预览。
- **`saveslot delete apply <dc_…>`**：先用这个 `dc_` 向契约重取预览（`deletion_preview` 的 `{confirm}`），照上面的样子展示，再要求输入 `delete`——拿到的 `dc_` 可能是别的调用方生成的，人要看到它删什么才确认。带 `--yes` 时不展示、不提问，这条路上的保证是"执行的就是生成这个 `dc_` 时算出的范围"。
- **预览很长时**：第一屏先写总量，逐行结果分页展示；确认提示里重复总量（"将删除 3 条源数据、影响 1,024 行"）。没翻完也能确认，但人至少看到了规模。"将会生效的写入"或"将转为待确认的写入"不为空时，确认提示里同样重复它们的条数。
- 撤回 `saveslot delete cancel` 不核对事项版本（[`04-contract.md`](04-contract.md)「待处理事项」），换一个终端也能直接撤回；仍要一次 `y/N` 确认，因为撤回会让宽限期内基于删除后状态的写入重新计算。宽限期内受这项删除影响的行上不能处理事项、不能撤回写入：这类命令报错时写明是哪一项删除、何时到期，并给出两条路（等到期，或先撤回这项删除）。

### 5.4 交互式与非交互式的边界

| 情形 | 行为 |
|---|---|
| 标准输入是终端，没给 `--yes` | 展示内容后提问 |
| 标准输入不是终端，没给 `--yes` | 不提问、不执行，退出码 8，提示先用 `saveslot pending show --json` / `saveslot delete preview --json` 取内容与绑定令牌、再带 `--yes` 执行（提示里不打印令牌） |
| 给了 `--yes` | 不提问；但改变数据的确认类命令必须同时给出绑定令牌：`saveslot pending resolve` 要 `--item-ver`，删除只能用 `saveslot delete apply <dc_…>`（`saveslot delete --source … --yes` 拒绝）；`saveslot delete cancel`、`saveslot connections revoke` 只要 `--yes` |

**非交互式确认允许，理由**：saveslot 不区分确认出自人还是 Agent（[`02-architecture.md`](02-architecture.md) §3），交互式提问也挡不住能操作终端的程序，加一个"我真的确定"之类的额外标志不提供任何保证，只增加步骤。真正的保证是内容绑定：脚本必须先 `saveslot pending show --json` / `saveslot delete preview --json` 拿到令牌，执行的就是交付给它的那一份。CLI 保证不了脚本看了内容，只保证执行的版本与交付的一致、内容变了就不执行。

## 6. 输出约定

### 6.1 人读文本与 `--json`

- **人读文本**（默认）：由 CLI 渲染器按契约字段生成。标记写法同 MCP（[`05-surfaces.md`](05-surfaces.md) 4.2「标记」、4.3「提醒与提示」），渲染器测试同样检查每个契约标记都出现在文本里；`notices[]` 写在末尾；`warnings[]` 全部渲染（含 `multi_segment_unmapped`，人可以据此回头补证据映射）。`saveslot pending show` 对 `flagged` 事项列出命中的行与命中的那一组键；读结果里 `dangling_ref` 标记照 MCP 的写法渲染。提示里的下一步写成 CLI 命令，不写 `saveslot_` 工具名。
- **`--json`**：标准输出只有一个 JSON 值——契约的结构化结果，与 HTTP 回执同一形状，CLI 不改名、不删字段；`export` 例外，是 NDJSON 流。报错时输出契约的 `{"error": {...}}`；CLI 自己发现的错误（如 `connections revoke` 的名字对应不止一个连接实例时的 `ambiguous_name`）也用同一个外形，那时的 `code` 是 CLI 自己的，不在契约的错误码里。组合命令输出最后一个契约操作的结果（`pending resolve` 是 `resolve` 的，`delete --source` 是 `delete` 的）；`connect` 输出 `connections.issue` 的结果，另加 `selfcheck` 字段；服务器 profile 上宿主自己登录的 `connect`（§3.2「服务器模式」，什么都不签发）输出 `{host, server, url, command?, applied?}`：`server` 是 profile 的服务器地址，`url` 是远程 MCP 地址，`command` 是宿主的添加命令（参数数组，不含令牌；没有添加命令的宿主没有这一项），给了 `--apply` 时另带 `applied`（`true` / `false`，按宿主命令的结果）；`connect http --profile` 与本机一样，输出 `connections.issue` 的结果加 `selfcheck`；`profile list` 输出 `{current, profiles}`，`profiles` 是 `[{name, at}]`（`at` 是 `local` 的套接字路径或服务器地址；内置的 `local`、`cloud` 在前，登记的按名字排），`profile use` 输出 `{current}`；`setup` 输出一个对象，不含令牌：`initialized`（`existing` / `done` / `failed`；初始化失败时对象只有这一项）、`service`（`ready` / `failed`；启动失败时对象到此为止，退出码按 `start`）、`slots`（`[{template, slot}]`）、`slot_failed`（建 slot 失败时才有，是那个模板的名字；这时 `hosts` 是空数组，退出码按建 slot 的错误）、`hosts`（按参数或列表的次序，每项 `{host, state, reason?, connection?, connections?}`）。`state` 六个值：`existing`、`done`、`unconfirmed`、`failed`、`manual`（列出了但没有添加命令）、`not_found`（`--host` 给了但没找到）。`failed` 与 `unconfirmed` 带 `reason`，是稳定的码：`failed` 的是 `command_failed`、`command_signal`、`command_timeout`、`cannot_run`、`interrupted`、`no_entry`、`self_check_failed`、`issue_failed`、`lookup_failed`、`unshowable`；`unconfirmed` 的是 `path_not_seen`、`instance_unsure`、`no_instance`（§3.3 第 7 条）、`other_entry`（服务器这一支，§3.3 第 13 条）。别的状态不带 `reason`（`not_found` 本身就是原因）。`connection` 是 `{id, name, state}`，`state` 为 `live` 或 `revoked`；宿主已有条目而第一档的有效实例不止一个时（`existing`），或只有第二档的实例时（`unconfirmed` / `instance_unsure`），不给 `connection`，给 `connections`（`[{id, name, last_read}]`，`last_read` 是最后一次自检之外的读取时刻或 null）。中途停下时另带 `stopped`（`declined`、`input_ended`、`interrupted`），只表示人或输入让 `setup` 停下。服务器这一支（§3.3 第 13 条）没有 `initialized` 与 `service`，对象最前是 `signed_in`：`existing`（已登录：令牌可用或刷新成功）、`done`（这次登录成功）、`failed`（登录失败：签发方不对、被服务器拒、刷新与重新登录都不成；对象到此为止，退出码按 `login`）、`needed`（没登录、又没有终端可登录，什么都没做；对象到此为止，退出码 8，提示先 `saveslot login --profile <名字>`）；人在授权页上拒绝是 `signed_in: "failed"` 加 `stopped: "declined"`，退出码 8；之后是 `slots`、`slot_failed`、`hosts`，同本机这一支（`hosts` 的项没有 `connection` / `connections`：这一支不签发）。脚本必须看 `status` 等字段，不能只看退出码（同 HTTP 的规定）。
- 交互式提示、进度、"令牌只显示一次"这类话写标准错误，`--json` 时标准输出保持可解析。

### 6.2 退出码

| 退出码 | 含义 | 对应 |
|---|---|---|
| 0 | 完成（含重放、`outcome: pending` 这类"已记下但未生效"——看输出） | — |
| 1 | CLI 或 saveslot 服务内部错误；接入没有完成 | `internal`；`saveslot connect` 的自检失败（已吊销刚签发的连接实例）或 `--apply` 执行宿主命令失败（**保留**连接实例，命令已打印给人自己执行）；`saveslot setup` 有宿主失败（宿主命令失败时**吊销**刚签发的连接实例，因为令牌没有显示给任何人）、初始化失败、服务与 CLI 版本不一致 |
| 2 | 命令用法错误（CLI 自己发现的） | 例如只取一个值的选项给了两次（不按"最后一个算数"）；`connections revoke` 的名字对应不止一个连接实例；`export` 的口令文件用不了（普通文件权限宽于 0600、不归当前用户、不是文件或管道、读不到、管道 30 秒没写来、为空、含控制字符，各自说明原因与改法；这是发请求之前的用法错误，不是 6，6 留给凭证）、`-o` 的文件已经在；`server init --user`、`server user add`、`server user passwd` 的口令文件用不了，或终端上三次输得两遍不同；`server restore` 的 `--tenant` 与 `--user` 都给了或都没给 |
| 3 | 要先重读 / 内容已变 | `read_first`、`confirmation_mismatch`、`item_closed`、`preview_outdated`、`handle_expired`、`draft_outdated`、`schema_incompatible` |
| 4 | 找不到 | `not_found`、`unknown_table`、`unknown_field`；`server restore` 指定的租户不在，或 `--user` 指定的账户不在；`server user disable`、`enable`、`passwd` 指定的账户不在 |
| 5 | 请求被拒 | `saveslot init` 遇到已初始化的目录、非空的数据目录或正在运行的服务（什么都不改）、`saveslot start` 遇到未初始化的目录，或服务起来之后发现存储格式过旧或过新、存储格式升级失败（`upgrade_failed`；都要先处理存储，照原样重试没用）；`config.toml` 不合法（`saveslot start` 在派生进程之前、前台启动与 `saveslot config get` 都这样拒绝，见 4.2）；服务器模式的环境变量缺了或写法不对（4.1「服务器模式的配置」）；`invalid_argument`、`validation_failed`、`field_unmatched`、`sql_rejected`、`sql_timeout`、`too_large`、`derived_readonly`、`revoked`、`not_in_this_version`、`import_rejected`、`rate_limited`（`quota`）、`referenced`（后续）、`lease_expired`（后续）；`server restore` 遇到没有表或格式不认识的控制面库（`--user` 时含本地账户的表）、还没建完的租户（`--user` 时含账户在而租户没有登记）、设了外部登录时的 `--user`、没有日志的租户库（备份还没放回）、导入进行中的租户、删除登记里有条目的租户（这一版还不能补删，什么都不改）；`server restore`、`server user`、`server init` 打开租户时存储格式升级失败（`upgrade_failed`：只写失败的那一步与 SQLSTATE，不写数据库的报错原文，[`02-architecture.md`](02-architecture.md) §8）；`server start` 遇到 `server init` 还没建的表或格式不认识的表；`server user` 遇到这样的表、已被占用或不合规的名字、不合规的口令，或设了外部登录（`server init --user` 同样） |
| 6 | 凭证或权限 | 未登录、凭证文件权限过宽、`unauthenticated`（令牌无效、已吊销、会话过期）、`insufficient_scope`；`saveslot mcp` 的 `SAVESLOT_TOKEN` 没设、为空或不是连接实例令牌（含用户会话令牌）；`saveslot login` 时服务器的签发方不是这台服务器、授权被服务器拒绝 |
| 7 | 连不上或暂时不可用（稍后重试） | saveslot 服务未运行（`saveslot stop` 例外：没在运行时退出码 0）；`saveslot stop` 时 `/health` 报的 pid 与 `run/saveslot.pid` 不一致，或 `/health` 不应答而 `run/saveslot.lock` 被占着（都不发信号）；`saveslot start` 等不到就绪（进程仍在运行；升级存储格式期间一直等，不算等不到）、服务起来之后自己失败（数据目录不在、内部错误等，原因见 `saveslot status` 与服务日志；格式过旧或过新、升级失败除外，见 5）、套接字不可达、`unavailable`（忙、恢复中、导入中、对拍中、启动中，含升级存储格式中）、`rate_limited`（`busy`）；`saveslot start` 或 `saveslot setup` 启动服务失败，或另一个 `setup` 正在运行；profile 的锁等满 10 秒仍拿不到（`login`、`logout`、换新令牌时都一样；与 `setup` 的锁一致）；`server restore` 时同一个控制面库上有服务器在运行（什么都没做）；`server start` 时同一个控制面库上已有服务器在运行（什么都没做），或运行中控制面库的连接断了（锁随之失去，服务器停下） |
| 8 | 未执行 | 人在提示中拒绝（含 `saveslot setup` 第 5 步的拒绝：什么都没签发；`saveslot login` 在授权页上被拒绝，即 `access_denied`）；`saveslot login` 的设备码过期、等待超时（都什么都没写）；非交互式缺 `--yes` 或绑定令牌；`export --encrypt` 没有终端、也没给口令文件；`server init`、`server user add`、`server user passwd` 没有终端、也没给口令文件 |
| 9 | 校验发现问题 | `saveslot verify` 报断裂 / 不符，`saveslot verify --replay` 报不一致，`saveslot doctor` 有不通过项（只有提醒时不给 9） |
| 129 / 130 / 131 / 143 | 被信号停下（128 加信号编号：SIGHUP / SIGINT / SIGQUIT / SIGTERM） | `saveslot setup` 收到这四个信号之一时收尾后按此退出（§3.3 第 8 条）；`server user add`、`server user passwd` 在口令提示处按 Ctrl-C（130，什么都没做）；`server init --user` 在口令提示处按 Ctrl-C（130：密钥文件与表已就位，账户没建，重跑即可）；`saveslot login` 等待浏览器或设备码时收到它们（换取令牌的请求在途中时收到的也算），关掉本机回环监听、什么都不写，按此退出 |

退出码只分大类，权威信息是 `--json` 里的 `error.code`；契约以后新增的错误码归入 1 以外最接近的一类，未知的按 5 处理。

### 6.3 错误的展示

文本由 `code` 与附带字段渲染（同 [`05-surfaces.md`](05-surfaces.md)「报错的文本」的内容），写到标准错误，第一行是 `错误 <code>：<一句话>`，之后是可执行的下一步：

```
错误 confirmation_mismatch：pi_9B… 自你查看以后内容已变
  现在的提议：11-02 起改为 3500 CNY（一直延续）
  重新查看：saveslot pending show pi_9B…
```

校验类错误的 `details` 逐条一行：明细的 `code`（带 `max` / `min` 的在码后写"至多 N""至少 N"，与 MCP 的文本一致），再写它在哪里——`op`、`path`、`table`、`field`、`line` 中给了的那些（键是 CLI 自己的字样，值放在不可信边界内），带 `valid` 的（判定时发现的 `required_in_gap`）再写那一段区间，写法同读结果里的区间（起点开口、整段时间都照那里写）。slot 数已到上限（`path` 为 `slot` 的 `out_of_bounds`）时另起一行，指向移除空 slot 的命令（`saveslot slot remove`）。例如：

```
error validation_failed (「write」): 「the write falls where the entity has no value」
  required_in_gap  at op 0, table 「plan.budgets」, field 「amount」, valid 「2026-11-05」 to 「2026-11-06」 (inclusive)
```

### 6.4 不可信文本在终端里

契约里的 `UntrustedText`（[`04-contract.md`](04-contract.md)「不可信文本」）在终端里有两类风险：一是原文里的控制字符改写终端（ANSI 转义、清屏、Unicode 双向覆盖字符把一段文字显示成另一段），二是有 shell 的 Agent 读 CLI 的输出时被原文里的指令注入。

- **一律转义控制字符**：C0 / C1 控制字符、ESC、双向覆盖与隔离字符显示成可见的转义写法（如 `\x1b`、`<U+202E>`）；转义的范围与 MCP 相同（[`05-surfaces.md`](05-surfaces.md) 第 5 节「不可信边界」），另加：书名号「」及兼容规范化后成为「」的字符；U+0020 以外的空格类字符；连续的 U+0020 从第三个起（写成 `\x20`，免得一屏空格借终端折行伪造出"下一行"）；会被读成转义写法或边界标签的 `<`，以及值末尾的 `<`。反斜杠写成 `\\`，使转义后的文本只能还原成一种原文；截断只截原值、再转义，截断的标记写在不可信区域之外。`--json` 把同一个转义集（规则同上，不含连续空格那一条）写成 `\uXXXX`，与 MCP 写 JSON 原文的做法相同，值不变，仍是合法的 JSON。
- **人读文本里用书名号把不可信值括起来**（`「腿有点酸，很累」`），终端支持颜色时以弱化色显示，与 saveslot 自己的说明区分开。
- **标准输出不是终端时**（被管道或 Agent 读取），不可信值改为包在带编号的边界标签里（`<untrusted-data-编号>…</untrusted-data-编号>`，开闭同号，每次输出一个新编号），形式与规则同 MCP（[`05-surfaces.md`](05-surfaces.md)「不可信边界」）；人用管道处理时用 `--json`，或 `--untrusted-tags never` 关掉（`always` 强制打开）。
- schema 里调用方撰写的说明同时标出写入者与版本，同 MCP。

## 7. 和实现顺序的对应

按 [`07-scope-v1.md`](07-scope-v1.md)「实现顺序」：

| 步 | CLI 加什么 | 为什么在这一步 |
|---|---|---|
| P0 | 无（只建 `cli` 包骨架，接上由契约生成的 `client`） | 契约初版类型此时才有 |
| P1 | `setup`、`init`、`start` / `stop` / `status`、`mcp`、`config get`；`slot list` / `show` / `create`、`schema templates`；`connect`、`connections list` / `revoke`、`snippet`（文案初稿）；`pending list` / `show` / `resolve`（`awaiting_confirmation`、`conflict`）；`query`、`history`（`timeline` / `as_of`）；`verify`、`reads` | eval 1–4 要两个连接实例、用 CLI 喂 schema 建 slot，eval 4 的确认也要能由人处理；`setup` 只依赖本步已有的命令 |
| P2 | `sql`、`sources`、`history changes`、`verify --replay` | 与 `saveslot_sql`、`saveslot_sources`、影响查询、双后端对拍同步出现 |
| P3 | `delete`（交互式、`preview`、`apply`、`cancel`、`status`）、`export`（含 `--encrypt`）、`start --restored` | 隐私删除、导出与恢复流程在这一步实现 |
| P4 | `schema get` / `draft`、`pending resolve` 的 `schema_change` | schema 变更（不含抽取）在这一步 |
| P5 | `login` / `logout`、`profile`、`connect --profile cloud`、`setup --profile`；`connect --slots` 与 `connections list` 的范围一列；`import`（含客户端一侧解密）；`server init` / `start` / `user` / `restore` | 服务器模式（云服务与自部署）、OAuth、凭证限定到 slot 与导入到空租户在这一步 |
| P6 | `service install` / `uninstall`、`doctor`（含数据规模的提醒）、`connections rename`、`policy show`、`config set`；`snippet` 的文案定稿；按 eval 结果调文本 | 收尾：本地 daemon 的安装与自启、管理命令补齐 |
| P4b（不属于第一版） | `pending resolve` 的 `migration_diff` 四种处理方式、`jobs` | 随抽取作业 |

P1 结束时 CLI 已能完成第 3 节的整条上手流程，含 `saveslot setup`（自启与 `saveslot doctor` 除外；P6 之前要改配置就直接编辑 `config.toml`）；它在 P1 依赖的本地 HTTP 适配器、管理类操作与 `saveslot mcp` 转发都排在 [`07-scope-v1.md`](07-scope-v1.md) 的 P1 里。

## 8. 安全

### 8.1 本地服务只供本机访问

| 做法 | 防什么 |
|---|---|
| 只在 unix socket 上监听，目录 0700、套接字 0600 | 别的系统用户、网络上的任何人 |
| 回环 TCP 默认关；打开时只绑回环地址，校验 `Host` / `Origin` | 局域网访问；网页经 DNS 重绑定访问。**打开后本机其他系统用户也能连上**，对他们只剩令牌一道防线 |
| 每个请求都要令牌（连接实例或用户会话），套接字权限不代替认证。唯一的例外是 `GET /health`：不涉及任何主体与数据，`saveslot start` 比较版本、`saveslot mcp` 判断服务是否已起来都要用它；响应只有 `state`（`starting` / `ready` / `stopping` / `failed`）、`version`、`pid`、`since`，`failed` 时另带一个不含路径与用户数据的原因码；本地服务另带 `writer_lock: "held"`：应答的进程在监听之前已取得 home 的单写者锁（`saveslot status` 据此写单写者锁一行），只此一个值，不带路径或别的；以测试时钟运行时另带 `eval_clock`（`now`、`started_at`，第 3 节第 3 步），平时没有这个字段；升级存储格式期间（`starting`）与升级失败时（`failed`，`upgrade_failed`）另带 `upgrade`（`from`、`to` 两个格式号，`step` 是正在做或失败的那一步：格式的一步写成 `5->6`，升级前的备份写成 `backup`），平时没有这个字段。日志末端的记录时刻属于数据的活动信息，不放进 `/health`，`saveslot status` 经带用户会话的请求取得（与待处理数同一处）。其余路径没带令牌回 401（`unauthenticated`，同 [`05-surfaces.md`](05-surfaces.md) 第 14 节） | 区分主体、限定 scope：每个 Agent 只能做它的连接实例被授予的事，读写各自留痕。它不是对同权限程序的防护——够得着套接字的程序一般也读得到凭证文件（8.3） |
| 数据目录由 `init` 以 0700 建出；用 `--data-dir` 另放到 home 之外的，服务启动时核属主与权限，不符拒绝启动（第 3 节第 2 步） | 同机别的系统用户读写租户库：存储建出的文件是别人可读写的，只靠目录挡住 |
| 本地模式不提供绑定到非回环地址的配置 | 误配置把个人数据暴露到网络；跨设备用服务器模式（我们的云服务，或自部署——那是另一套带 OAuth 的启动方式，不是给本机模式开一个端口） |

CLI 与 `saveslot mcp` 只用 home 下固定的套接字路径（`run/saveslot.sock`），不接受从环境变量或参数改成别的地址，少一种被误配置引到别处的可能；这不是防护——同权限的程序照样能改 home 下的文件。

### 8.2 凭证文件

- `~/.saveslot/` 0700；`credentials/` 下每个文件 0600，权限过宽时 CLI 拒绝使用。
- 控制面只存令牌的哈希；连接实例令牌只在签发时显示一次，CLI 不保存。
- 连接实例令牌住在宿主的 MCP 配置里（[`03-data-model/02-integrity-and-records.md`](03-data-model/02-integrity-and-records.md)「连接实例身份」），它的保护由宿主负责；令牌外泄时 `saveslot connections revoke` 即时生效。
- 句柄签名密钥在 `control/keys/`，与数据目录分开。
- **连接实例令牌会经过的地方**，按接入方式：

  | 地方 | `connect` 后粘贴 | `connect --apply` | `setup` |
  |---|---|---|---|
  | 终端上的显示（回滚缓冲） | 是 | 仅在失败时 | **否** |
  | shell 历史 | 是 | 否 | **否** |
  | 宿主添加命令的进程参数（执行期间本机其他用户可见） | 是 | 是 | 是 |
  | 宿主的配置文件 | 是 | 是 | 是 |
  | CLI 自己的任何文件 | 否 | 否 | 否 |

  回环 TCP 关着时别的系统用户拿到它也连不上（他们连不上套接字）；打开回环 TCP 之前先确认这些地方没有外泄，有疑问就吊销重签。服务器模式下宿主走 OAuth，这条路上没有静态令牌。

  `--apply` 执行宿主命令时，宿主继承 CLI 的整个环境：宿主是用户自己的工具，需要它的环境（`PATH`、`HOME` 等）。`SAVESLOT_TOKEN` 不会被带过去：设了它，`connect` 本身就被拒（签发只能用用户会话）。

### 8.3 只有用户会话能做的操作

| 操作 | CLI 命令 | 为什么不给连接实例 |
|---|---|---|
| `connections.issue` / `update` / `revoke` | `connect`、`connections …` | 能签发凭证的 Agent 就能给自己任意 scope，scope 失去意义；吊销是人收回权限的唯一手段 |
| `slots.remove` | `slot remove` | 移除一个 slot 决定这个租户里有哪些 slot、名额给谁；Agent 建错的空 slot 由用户收拾 |
| `policy.set`（后续） | — | 策略决定哪些改动不经确认就生效，相当于改确认规则 |
| `reads.list` | `reads` | 审计的对象正是各个连接实例；被审计方不该能读全部审计 |
| `log.verify`、对拍 | `verify` | 面向运维，读日志全量；对 Agent 没有用处 |
| `log.end` | `status`（时钟提醒） | 面向运维；最后一次写入的时刻属于数据的活动信息，不给连接实例 |
| `export` | `export` | 一次拿走全部数据与源数据原文，绕开"按需读、逐次留痕"；带走数据是用户的权利，不是 Agent 的 |
| `import` | `import` | 用一份导出整个替换一个空租户的内容，并停用导入前登记的、仍有效的主体（已吊销的保持吊销）；它决定这个租户里有什么、谁的凭证还有效 |

其余操作（读、`resolve` 各类型、`delete`、`schema_draft`）连接实例按 scope 也能做，用户会话全都能做。

**边界如实写明**：本地的用户会话凭证是本机文件，与当前系统用户同权限的程序——包括有 shell 的 Agent——能读到它，也能直接运行 `saveslot`；saveslot 防不住这一类程序，与它们能直接读写数据目录是同一个边界（[`02-architecture.md`](02-architecture.md) §10）。上表的限制挡住的是只经 MCP / HTTP 接入的 Agent。要让某个 Agent 碰不到这些操作，就不给它访问 `~/.saveslot/` 的 shell 权限。

**留痕也是同一个边界**：凭用户会话运行的 CLI，读取、确认、删除都记在用户名下；有 shell 的 Agent 这样做时与真人操作分不开，"谁读过、谁确认的"在这条路上不成立。给这类 Agent 一个连接实例令牌、让它设 `SAVESLOT_TOKEN` 运行 CLI（或直接调 HTTP），留痕才归到它名下。

## 9. 待定

本文没有单列的待定项。依赖实验的两处：安装形态（第一版 npm 包；独立可执行文件与安装包等实验 6）、本地后端若因实验 1 换成打包的原生 PostgreSQL，安装与启动要重看。
