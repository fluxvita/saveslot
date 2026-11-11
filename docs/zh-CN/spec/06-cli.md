# saveslot · 外化面：CLI 与上手流程

> 本文写第一版 CLI：谁用、怎么连 saveslot、从零到第一个 Agent 能用的上手流程、命令清单、人工确认的交互、输出约定与安全。
> CLI 与 [`05-surfaces.md`](05-surfaces.md) 里的 MCP、HTTP 并列，是契约的又一个外化面：操作形状以 [`04-contract.md`](04-contract.md) 为准，内核规则以 [`03-data-model/`](03-data-model/README.md) 为准；数值类的待定见 [`08-open-questions.md`](08-open-questions.md)。

## 1. 结论

- **CLI 是第一版里人的入口**：第一版不做 App，签发 / 吊销连接实例、处理待处理事项、删除与撤回、导出、校验、建 slot 都由人经 CLI 做，或由人交代调用方 Agent 经 MCP 做（确认已委托给调用方，见 [`02-architecture.md`](02-architecture.md) §3）。
- **CLI 不自定规则**：除了管本地进程的几条命令，每条命令都映射到契约里的一个操作（或操作序列），经 `client` 走 HTTP；它自己只决定交互、渲染与退出码。
- **本地连接方式：saveslot 服务只在 unix domain socket 上监听**（第一版本地只支持 macOS 与 Linux；Windows 后续，届时用 named pipe），套接字文件只对当前系统用户可读写；CLI、`saveslot mcp`（给 MCP 宿主用的 stdio 桥）都经它调 HTTP / MCP。回环 TCP 默认关闭，按需打开。
- **用户会话凭证**：本地由 `saveslot init` 生成，存在 saveslot 配置目录（权限 0600）；云服务经 `saveslot login`（浏览器 + PKCE，无浏览器时用 OAuth 设备码）取得。
- **上手一条线**：`saveslot init` → `saveslot start` → `saveslot slot create health --template running` → `saveslot connect claude-code` → 把打印出的那条命令贴进终端 → 在宿主里问一句 → `saveslot reads` 看到自检之外的那次读取。
- **确认显式绑定内容**：CLI 处理事项时总是带上它刚展示给人的那份 `item_ver`，删除总是带上展示过的那份预览的 `dc_`；非交互式（`--yes`）允许，但必须显式给出这个绑定令牌，否则拒绝执行。契约规定不按 `item_ver` 绑定的两种处理除外（撤回删除不核对；`migration_diff` 的 `accept_all` 绑定 `diff_upto`），见第 5 节。

## 2. 定位与边界

### 谁用、做什么

| 使用者 | 用 CLI 做什么 |
|---|---|
| 用户本人 | 装好并启动本地 saveslot 服务；建 slot；给每个 Agent 签发连接实例并接进宿主；处理待处理事项；删除与撤回；看谁读过什么；导出；校验 |
| 有 shell 的 Agent、脚本 | 查询与 `--json` 输出。**应当凭自己的连接实例令牌运行**（环境变量 `SAVESLOT_TOKEN`）：受 scope 限制，读写记在该连接实例名下。直接用用户会话时什么都能做，而且全记在用户名下（第 8 节写明这一边界） |
| MCP 宿主 | 只用 `saveslot mcp`：宿主按 stdio 启动它，它把 MCP 消息转发给本地 saveslot 服务 |

### 不做什么

- **不做业务写入**：第一版没有 `saveslot write`。写入要把用户的话变成意图、行、值与证据，这是 Agent 的事（positioning「数据层」）；人要改数据，对 Agent 说，证据就是这句原话。没有 Agent 的脚本走 HTTP `POST /v1/writes`。
- **不直接打开数据目录**：除 `saveslot init` 外不碰 PGlite，所有读写都经 saveslot 服务，单写者锁与审计不被绕过。
- **不判断内核规则**：冲突、高影响、删除结果都由内核算出，CLI 只渲染契约返回的结构化字段。
- **不改宿主的配置文件**：只打印宿主自带的添加命令或配置片段，`--apply` 时代为执行宿主自己的命令，不直接编辑 `~/.claude.json`、`~/.codex/config.toml` 之类文件。

### 与 HTTP、MCP 的关系

| | MCP | HTTP | CLI |
|---|---|---|---|
| 主要调用方 | Agent | 脚本、程序 | 人 |
| 凭证 | 连接实例 | 连接实例或用户会话 | 用户会话（默认）；设了 `SAVESLOT_TOKEN` 时用该连接实例令牌 |
| 管理类操作（[`04-contract.md`](04-contract.md)「管理类操作」） | 不提供 | 提供 | 提供，经 HTTP 管理类端点 |
| op 级 `acknowledge` | 不开放 | 开放 | 不涉及（不做业务写入） |
| 文本渲染 | MCP 渲染器（[`05-surfaces.md`](05-surfaces.md)「标记与提示的措辞」） | 无，只有 JSON | CLI 渲染器：标记的写法同 MCP，下一步写成 CLI 命令 |

**代码位置**（[`02-architecture.md`](02-architecture.md) §11）：`cli` 包只依赖 `client`；服务组命令（`init`、`start`、`stop`、`status`、`service`、`doctor`、`config`、`mcp`、`server …`）由 `daemon` 包提供；`saveslot` 可执行文件是一个只做分发的入口包，依赖 `cli` 与 `daemon`。

### CLI 怎么连 saveslot

| 部署 | 传输 | 凭证 |
|---|---|---|
| 本地（默认） | HTTP over unix socket：`~/.saveslot/run/saveslot.sock` | 用户会话令牌，`Authorization: Bearer` |
| 本地 · 回环 TCP（可选） | `http://127.0.0.1:<port>`，`saveslot config set http.loopback on` 打开 | 同上 |
| 服务器模式（我们的云服务或自部署） | HTTPS，`https://<域名>/v1` | `saveslot login` 取得的用户会话 |

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
| 云服务 | `saveslot login`：默认打开浏览器走授权码 + PKCE（本机回环接收回调）；`--device` 用 OAuth 设备码（RFC 8628），适合 SSH 里没有浏览器的情形 | `~/.saveslot/credentials/<profile>.json`（访问令牌 + 刷新令牌），0600 | `saveslot logout` 吊销刷新令牌并删文件 |

- CLI 发现凭证文件的权限比 0600 宽时拒绝使用并提示修正，与 ssh 处理私钥的做法一致。第一版凭证放文件；放进系统钥匙串（可要求人在场才取出）随桌面打包一起做。
- **profile** 区分连接目标：`local`（默认）、`cloud`（我们的云服务），以及 `saveslot login --server <URL> --profile <名字>` 时为自部署的服务器新建的 profile；`--profile` 或 `saveslot profile use` 切换。各目标互不相通（第一版没有同步）。
- **凭连接实例令牌运行**：设了环境变量 `SAVESLOT_TOKEN` 时，CLI 用它代替用户会话——能做的事按该连接实例的 scope，管理类命令报 `insufficient_scope`，读写与确认都记在该连接实例名下。给有 shell 的 Agent 与脚本用（第 8.3 节）。

## 3. 上手流程（本地，从零到第一个 Agent 能用）

```
$ npm install -g @fluxvita/saveslot    # 一个包装好 CLI 与 saveslot 服务；需要 Node 24 及以上
$ saveslot init
已创建 ~/.saveslot（0700）
  data/          PGlite 数据目录（一个租户；已写入租户创世，登记用户主体与 system）
  control/       控制面（文件）：凭证哈希、租户目录、锚点（删除登记、seq 高水位、恢复次数）、句柄签名密钥
  credentials/   用户会话令牌（0600）
  config.toml    监听方式、数值策略
$ saveslot start
saveslot 服务已在后台启动 · pid 4211 · 监听 ~/.saveslot/run/saveslot.sock · 数据 ~/.saveslot/data
$ saveslot schema templates
running   跑步记录：runs（事件类）+ weekly_mileage（派生，每周跑量）
budget    预算：budgets（状态类，按 category）
spending  日常支出：expenses（事件类，CNY）+ monthly_total（派生）
$ saveslot slot create health --template running --timezone Asia/Shanghai
已建 slot health · schema v1 · 2 张表（runs、weekly_mileage）
$ saveslot connect claude-code --name "MacBook · Claude Code"
已签发连接实例 MacBook · Claude Code（ci_01JF…）· scope saveslot.read saveslot.write
自检通过：用新令牌读到 1 个 slot
令牌只显示这一次。把下面这条命令贴进终端（或重跑本命令并加 --apply）：
  claude mcp add saveslot -e SAVESLOT_TOKEN=<连接实例令牌> -- /usr/local/bin/saveslot mcp
```

在 Claude Code 里问"saveslot 里有哪些 slot"，然后：

```
$ saveslot reads --connection "MacBook · Claude Code" --since 10m
11-10 21:03  MacBook · Claude Code  catalog list  slot health（sv 1）  自检（saveslot connect）
11-10 21:04  MacBook · Claude Code  catalog list  slot health（sv 1）
```

第一条是 `saveslot connect` 自己做的自检，不算数；看到自检之外的读取记录，才说明宿主确实经这个连接实例连上了 saveslot。再接 Codex 时重复 `saveslot connect codex --name "MacBook · Codex"`，两个 Agent 共用同一份数据、各自留痕。

各步的要点：

1. **安装**：第一版发一个 npm 包，含 CLI 与 saveslot 服务；独立可执行文件与桌面安装包等实验 6（桌面打包）的结论（[`07-scope-v1.md`](07-scope-v1.md)「实现顺序」）。
2. **初始化**：`saveslot init` 是唯一直接打开存储的命令，saveslot 服务在运行时拒绝执行。数据目录可用 `--data-dir` 另放，落在 iCloud Drive、Dropbox 一类同步盘里时给出警告（[`02-architecture.md`](02-architecture.md) §7）。`control/` 下是几个文件：`credentials.json`（令牌的哈希、用户会话）、`tenant.json`（租户目录）、`anchor.json`（锚点存储：删除登记、`seq` 高水位、恢复次数、"恢复进行中"标记）、`keys/`（句柄签名密钥）；每次写入都是"写临时文件 → 落盘 → 改名覆盖"，只有 saveslot 服务进程写（[`02-architecture.md`](02-architecture.md) §5、§8）。锚点不在数据目录里；但默认布局下两者同在 `~/.saveslot/`，系统级备份通常一起恢复，这时 saveslot 补不了也发现不了。只有用 `--data-dir` 把数据目录另放、且只恢复了数据目录时，才能按登记补删：用 `saveslot start --restored` 启动，服务先走恢复流程再对外服务；恢复流程中途被打断时，下次启动不管带没带 `--restored` 都会接着做完再对外服务（[`02-architecture.md`](02-architecture.md) §8；[`03-data-model/03-deletion.md`](03-data-model/03-deletion.md)「删除之后」）。
3. **启动 / 停止 / 自启**：`saveslot start` 后台启动（`--foreground` 前台，看日志用）；`saveslot stop` 先把 read_log 缓冲落盘、排空写队列再退出。开机自启 `saveslot service install`（macOS launchd 用户级代理，Linux systemd 用户服务）。宿主启动 `saveslot mcp` 时若 saveslot 服务没在运行，`saveslot mcp` 先把它拉起来——两个宿主同时拉起时，后到的发现套接字已在就直接连上，单写者锁兜底保证不会有两个进程写数据；这样装好自启之前，宿主照样能用。自动拉起默认打开，配置 `mcp.autostart = false` 可关；`saveslot stop` 时提示"MCP 宿主重新连接时会再次启动，彻底停用请关掉自动拉起或移除宿主里的 saveslot"。`saveslot mcp` 固定连本地 saveslot 服务，不随 `--profile` / `saveslot profile use` 变（云服务不经它，宿主直接走远程 MCP）。
4. **建第一个 slot**：`saveslot slot create` 就是 `schema_draft`（`base_version: null`），新建 slot 编译通过即生效、返回 `sv: 1`（[`04-contract.md`](04-contract.md)「`schema_draft`」）；建 slot 同时由内核写一条默认 slot 策略事件。
5. **起步 schema 从哪来**：见第 3.1 节。
6. **签发并接入宿主**：见第 3.2 节。
7. **验证连通**：`saveslot connect` 用新令牌做一次 `catalog`（带固定的 `task: "saveslot-connect-selfcheck"`，`saveslot reads` 里标"自检"；`task` 是自报的，这个标记只为区分，不是保证），证明令牌、scope 与 saveslot 服务都通；宿主那一侧是否真的用上了，以 `saveslot reads` 里出现该连接实例**自检之外**的读取为准。`saveslot doctor` 逐项检查：saveslot 服务在运行、套接字权限、凭证文件权限、数据目录不在同步盘、单写者锁持有者、版本一致、有没有逾期未物理删除的删除、系统时钟是否比日志末端的记录时刻早 5 分钟以上。

### 3.1 起步 schema：随 CLI 打包的模板

- **第一版的做法**：CLI 包里带几份写好的 schema 文档（上面列出的三份），就是普通的用户 schema，格式完全按 [`03-data-model/07-schema-evolution.md`](03-data-model/07-schema-evolution.md)「schema 文档格式」，不用 `extends` / `compatibility`。`saveslot slot create --template` 把模板里的 slot 名、时区换成命令行给的值，作为草稿提交。
- **建完就归用户**：slot 与模板之后没有任何联系，CLI 升级换了模板也不影响已建的 slot；要改结构走 schema 变更（P4）。
- **为什么随包带、不从网上取**：离线可用、内容随 CLI 版本固定、不引入"远程 schema 来源"这个提示注入面（open-questions「社区 Schema + SKILL 的安全」）。
- **不用模板时**：`saveslot slot create <名字> --file schema.json`，文件可以是让 Agent 起草后保存的；也可以给某个 Agent 勾选 `saveslot.schema`，让它经 `saveslot_schema_draft` 直接建 slot。
- 官方 schema 的结构定下来以后，模板改为官方 schema 的 `extends` 形式；已用旧模板建的 slot 不受影响。

**三份模板的内容。** 单位取自单位词表，精度不写、用默认值（货币按 ISO 4217 的最小单位位数，其余 6 位，舍入 `half_up`，见 data-model「字段类型、同值与单位」）。`slot` 与 `timezone` 由命令行的值替换。评测的夹具（[`10-evals.md`](10-evals.md) 第 3 节）用的就是这三份。

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
      "name": "weekly_mileage", "kind": "derived", "description": "每周跑量，周一起算",
      "rule": {
        "sql": "SELECT date_trunc('week', date::timestamp)::date AS week_start, sum(distance) AS total_distance, count(*) AS run_count FROM runs GROUP BY 1",
        "time_dependency": "bucketed"
      },
      "fields": [
        { "name": "week_start", "description": "该周周一" },
        { "name": "total_distance", "description": "该周总距离（km）" },
        { "name": "run_count", "description": "该周跑步次数" }
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
      "name": "monthly_total", "kind": "derived", "description": "每月支出合计",
      "rule": {
        "sql": "SELECT date_trunc('month', date::timestamp)::date AS month, sum(amount) AS total FROM expenses GROUP BY 1",
        "time_dependency": "bucketed"
      },
      "fields": [
        { "name": "month", "description": "该月第一天" },
        { "name": "total", "description": "该月支出合计（CNY）" }
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

### 3.2 签发连接实例、接入宿主

`saveslot connect <宿主> --name <名字> [--scope …]` = `connections.issue`，再按宿主生成接入方式：

| 宿主 | 生成什么 |
|---|---|
| `claude-code` | `claude mcp add saveslot -e SAVESLOT_TOKEN=<令牌> -- <saveslot 的绝对路径> mcp` |
| `codex` | `codex mcp add saveslot --env SAVESLOT_TOKEN=<令牌> -- <saveslot 的绝对路径> mcp`，或 `config.toml` 的 `[mcp_servers.saveslot]` 片段 |
| `generic` | 通用 JSON：`{"command": "<saveslot 的绝对路径>", "args": ["mcp"], "env": {"SAVESLOT_TOKEN": "<令牌>"}}` |
| `http` | 不生成宿主配置，只打印令牌与套接字路径（给脚本用；`curl --unix-socket` 可直接调） |

- **令牌只显示一次**：控制面只存哈希；丢了就吊销重签。`--apply` 时由 CLI 执行上表里宿主自己的添加命令，令牌不落进 CLI 的任何文件——**但会落在别处**：贴进终端的命令进了 shell 历史；`--apply` 执行宿主命令时令牌在进程参数里，执行期间本机其他用户能用 `ps` 看到；最后它住在宿主的配置文件里。只用 unix socket 时这些暴露对别的系统用户无害（他们连不上套接字），打开回环 TCP 后就不是了（第 8.1 节）。各宿主命令的确切写法由 CLI 的宿主适配表维护，实现时逐个实测。
- **命令写绝对路径**：宿主启动 `saveslot mcp` 时的 PATH 未必包含 npm 全局目录（图形界面启动的宿主、用版本管理器切换 Node 的环境），所以生成的命令一律用 `saveslot` 可执行文件的绝对路径；`saveslot doctor` 检查各宿主配置里的路径是否还在。
- **`--scope` 的写法**：不给时是 `saveslot.read saveslot.write`。两种写法，不能混用：
  - 增减式：`--scope +schema`、`--scope +delete`（在默认上加）、`--scope -write`（从默认里去掉；只读就是 `--scope -write`）；可重复或用逗号连写（`--scope +schema,+delete`）。
  - 完整式：`--scope read,write,schema`，列出的就是全部。
  - 名字可以省略 `saveslot.` 前缀。**每个连接实例都必须有 `saveslot.read`**：`-read`、或完整式里不含 `read`，是用法错误（退出码 2），不发请求。
  - 第一版 scope 签发后不能改，要改就吊销后重签（[`04-contract.md`](04-contract.md)「调用方：凭证与 scope」）。
- **签发之后的失败**：
  - 自检失败（用新令牌调 `catalog` 不通）：CLI 立即吊销刚签发的连接实例，不显示令牌，退出码 1，并写明自检报的错误。
  - `--apply` 执行宿主命令失败：连接实例保留，照常打印那条命令让人自己执行，退出码 1；标准错误写明宿主命令的退出状态。
- **名字建议写"设备 · 宿主"**，它会出现在历史、事项发起者与读取审计里。
- **服务器模式（云服务或自部署）**：宿主走远程 MCP 自己做 OAuth 授权，`saveslot connect claude-code --profile cloud`（自部署换成它的 profile）只打印 `claude mcp add --transport http saveslot https://<域名>/mcp`；授权页上由用户命名、选 scope。授权完成后用 `saveslot connections list` 能看到它，改名、吊销照常。没有 Agent 的脚本走不了 OAuth：`saveslot connect http --profile cloud` 由用户会话签发一个静态令牌，与本地一样按 scope、可吊销。

## 4. 命令清单

全局参数：`--profile <名字>`、`--json`（输出契约的结构化结果，见第 6 节）、`--yes`（非交互式确认，见第 5 节）、`--limit` / `--cursor`（分页，同契约）。"出现于"列对应第 7 节的实现步骤。

### 4.1 服务（只在本地；管进程，不是契约操作）

| 命令 | 用途 | 关键参数 | 输出要点 | 出现于 |
|---|---|---|---|---|
| `saveslot init` | 建目录、写租户创世、生成用户会话令牌 | `--data-dir`、`--rotate-session` | 各目录与权限；同步盘警告 | P1 |
| `saveslot start` / `saveslot stop` | 启动 / 停止 saveslot 服务 | `--foreground`、`--restored`（数据目录刚从备份恢复：先走恢复流程；P3） | pid、监听地址；走了恢复流程时写明补删了几项；`stop` 时有宽限期内的删除就提醒"到期时若 saveslot 没在运行，物理删除在下次启动时执行" | P1（`--restored` P3） |
| `saveslot status` | 进程状态 + 概况 | — | 版本、数据目录、监听、单写者锁、启动时补跑了哪些到期任务；待处理事项数（经 `pending`）；逾期未物理删除的删除；系统时钟比日志末端的记录时刻早 5 分钟以上时的警告 | P1（删除相关 P3） |
| `saveslot mcp` | 给 MCP 宿主的 stdio 桥 | 令牌取环境变量 `SAVESLOT_TOKEN` | 不给人看；固定连本地；saveslot 服务未运行时先拉起 | P1 |
| `saveslot service install` / `uninstall` | 开机自启 | — | 写入的系统服务位置 | P6 |
| `saveslot doctor` | 逐项自检 | — | 每项通过 / 不通过与修法 | P6 |

**服务器自部署的运维命令**（P5；在服务器上跑，由 `daemon` 提供，不是契约操作；我们的云服务用的是同一组）：

| 命令 | 用途 |
|---|---|
| `saveslot server init` | 建控制面库、生成句柄签名密钥（写进环境配置，由部署方保管）、创建第一个用户；要求给出 PostgreSQL 连接与对外地址 |
| `saveslot server start` | 以服务器模式启动（前台，交给 systemd 或容器管理） |
| `saveslot server user add` / `list` / `disable` | 管理内置的本地账户；不开放注册 |
| `saveslot server restore <租户>` | 恢复备份之后走恢复流程：追加"恢复"事件、按删除登记补删、补跑已到期的删除，再对外服务；中途被打断可以重跑（[`02-architecture.md`](02-architecture.md) §8）。没走这条命令就换了库、被打开时发现的，服务拒绝对外服务并提示运行它 |

### 4.2 登录与配置

| 命令 | 用途 | 关键参数 | 输出要点 | 出现于 |
|---|---|---|---|---|
| `saveslot login` / `saveslot logout` | 服务器模式的用户会话 | `--server <URL>`（自部署的地址，默认我们的云服务）、`--device` | 登录的账户、令牌存放位置 | P5 |
| `saveslot profile list` / `use` | 切换连接目标 | — | 当前 profile 与地址 | P5 |
| `saveslot config get` / `set` | 本地 saveslot 服务的配置（监听方式、端口、数值策略）。数值策略的键：`read_log.retention_days`（读取记录保留期，默认 180，不能低于 30）、`read_log.flush_seconds`（落盘间隔，默认 5）、`read_log.coarse_threshold`（改记表级记录的阈值，默认 1000）、`high_water.events` 与 `high_water.seconds`（高水位推进间隔，默认 1000 条事件或 60 秒）。低于内核下限的值被拒绝。自部署的服务器模式用同名的配置项 | 键、值 | 改后是否需要重启 | P1（只读），P6（可写） |

### 4.3 slot 与 schema

| 命令 | 契约操作 | 关键参数 | 输出要点 | 出现于 |
|---|---|---|---|---|
| `saveslot slot list` | `catalog`（`level: list`） | — | slot → 表名、一句话说明、派生表标"只读" | P1 |
| `saveslot slot show <slot> [表…]` | `catalog`（`level: table`） | `--tables` | 字段、类型、单位、说明、规则原文、数据概况（同 MCP `saveslot_catalog` 的文本） | P1 |
| `saveslot schema templates` | 无（列 CLI 自带的模板） | — | 模板名、包含的表 | P1 |
| `saveslot slot create <名字>` | `schema_draft`（`base_version: null`） | `--template` / `--file`、`--timezone` | 编译结果、回填的表 / 字段 ID、`sv: 1`；编译失败逐条列出位置 | P1 |
| `saveslot schema get <slot>` | `catalog`（`level: schema`） | `-o <文件>` | 完整 schema 文档（已填 `base_version`），可直接改了提交 | P4 |
| `saveslot schema draft <文件>` | `schema_draft` | — | `changes[]` 逐项类别与兼容性、影响预览；`outcome: applied` 写新 `sv`，`pending` 写事项 ID 并提示用 `saveslot pending show` 确认 | P4 |
| `saveslot policy show <slot>` | `policy.get` | — | 哪些改动自动生效、额外的高影响表 / 字段 | P6 |

### 4.4 连接实例与凭证

| 命令 | 契约操作 | 关键参数 | 输出要点 | 出现于 |
|---|---|---|---|---|
| `saveslot connect <宿主>` | `connections.issue` + 一次 `catalog` 自检 | `--name`、`--scope`、`--apply` | 连接实例 ID、scope、令牌（只此一次）、宿主命令 | P1 |
| `saveslot connections list` | `connections.list` | — | 名字、ID、scope、签发时间、是否已吊销 | P1 |
| `saveslot connections rename <名字或 ID> <新名字>` | `connections.update` | — | 新旧名字；历史里的 actor 不变，只是显示名变 | P6 |
| `saveslot connections revoke <名字或 ID>` | `connections.revoke` | `--yes` | 吊销时刻；之后该令牌的请求一律拒绝 | P1 |

### 4.5 待处理事项

| 命令 | 契约操作 | 关键参数 | 输出要点 | 出现于 |
|---|---|---|---|---|
| `saveslot pending [list]` | `pending`（列出） | `--slot`、`--type`、`--status` | 按挂起时长排序：ID、类型、目标、一句原因、已挂多久 | P1 |
| `saveslot pending show <pi_…>` | `pending`（详情） | — | 见第 5 节；含 `item_ver` 与当前凭证可用的处理方式 | P1 |
| `saveslot pending resolve <pi_…> <处理方式>` | 先 `pending`（详情）再 `resolve` | `--candidate <下标>`（冲突事项有多个候选时）、`--item-ver`、`--note`、`--evidence-json <文件>`（证据段，形状同契约；处理会触发写入时作这次写入的源数据）、`--diff-upto`（随 P4b）、`--yes` | 见第 5 节；触发的写入、派生变化、被取代的事项 | P1（`awaiting_confirmation`、`conflict`），P2（`flagged`，随 `duplicate_keys`），P3（`deletion` 的 `cancel`），P4（`schema_change`） |

### 4.6 删除

| 命令 | 契约操作 | 关键参数 | 输出要点 | 出现于 |
|---|---|---|---|---|
| `saveslot delete --source <s_…>…` | `deletion_preview`（`kind: privacy`）→ 人确认 → `delete` | 可重复 `--source` | 预览全文、确认提示、删除回执（撤回期限与方法） | P3 |
| `saveslot delete preview --source <s_…>…` | `deletion_preview` | `--json` | 预览全文与 `dc_…`（10 分钟内有效） | P3 |
| `saveslot delete apply <dc_…>` | `deletion_preview`（`{confirm}`：按这个 `dc_` 重出预览）→ 人确认 → `delete` | `--yes`（跳过展示与提问） | 预览全文、确认提示、删除回执 | P3 |
| `saveslot delete cancel <pi_…>` | `resolve`（`deletion` · `cancel`） | `--yes` | 撤回结果：退回原状态的写入、恢复的事项、新 `ver`；被重新判定的候选及各自的结果（`rejudged`：不再是改动 / 已记为佐证 / 已另开事项） | P3 |
| `saveslot delete status <pi_…>` | `pending`（详情，`deletion`） | — | 宽限期到期时刻、每处的状态（逻辑删除 → 物理删除 → 备份失效日期）；到期后仍可查 | P3 |

撤销一行不是删除，是一次业务写入，由 Agent 用 `revoke` 做。

### 4.7 查询与历史（给人看的）

| 命令 | 契约操作 | 关键参数 | 输出要点 | 出现于 |
|---|---|---|---|---|
| `saveslot query <表>` | `query` | `--where 'distance>5km'`（可重复）、`--order`、`--fields`、`--valid-at` / `--valid-during`、`--include-revoked`、`--detail` | 同 MCP `saveslot_query` 的行文本：`ver`、值、全部标记 | P1 |
| `saveslot sql '<SELECT …>'` | `sql` | `--param`、`--max-rows`、`--at` | 紧凑表格；头部汇总标记 | P2 |
| `saveslot history <表> <行或实体>` | `history`（`timeline` / `as_of`） | `--as-of <操作号/时刻>`、`--as-of-read <rd_…>`（按那次读取还原）、`--valid-at`（状态类表）、`--key <字段>=<值>`（状态类表按 `entity_key` 定位，代替实体 ID，可重复）、`--sources`（展开原文） | 每个版本：`#seq`、时间、写入者、意图、前后值、来源；读过它的读取 | P1 |
| `saveslot history changes <表>` | `history`（`changes`） | `--since`、`--until` | 一段记录时间内的变化 | P2 |
| `saveslot sources [list / search <词> / get <s_…>]` | `sources` | `--slot`、`--kind`、`--from` / `--to` | 源数据列表或原文；已删除的只给墓碑信息 | P2 |

`--where` 的简写只是把 `字段 运算符 值` 拆成契约的 `{field, op, value}`；带单位的量把单位写在数值后面（`'distance>5km'`），没写单位报用法错误；其余不支持的写法同样报用法错误；复杂条件用 `--where-json`。CLI 的读取与 Agent 的一样记入 read_log，actor 是用户；设了 `SAVESLOT_TOKEN` 时是该连接实例。

### 4.8 审计、导出、校验

| 命令 | 契约操作 | 关键参数 | 输出要点 | 出现于 |
|---|---|---|---|---|
| `saveslot reads` | `reads.list` | `--connection`、`--since` | 时刻、连接实例、`task`、操作、读到的表 / 行与版本（`saveslot connect` 的自检标"自检"）；只给版本，不给值 | P1 |
| `saveslot export` | `export` | `-o <文件>`（默认标准输出）、`--after-seq`、`--include-pending-deletion` | NDJSON；结束时在标准错误写事件数、末尾 `seq`、是否含待删除内容 | P3 |
| `saveslot verify` | `log.verify` | — | 事件总数；事件头链完整与否（或自第 k 条起断裂）；校验和不符的位置；已按删除移除的位置；恢复留下的 `seq` 空档 | P1 |
| `saveslot verify --replay` | `log.reconcile` | — | 比较到的 `seq`；从空存储重放日志与线上的 (b) 类逻辑表逐表比较的结果；不一致时列出表与行（只给 ID）。执行时显示进度（重放、追平、比较），进入比较阶段时提示"写入暂时排队"；输出末尾写明它查不出 `delete` 自己算错的结果 | P2 |

`--include-pending-deletion` 在交互式下要再确认一次："导出里将包含宽限期内待删除的内容，撤回期过后它们仍留在导出文件里。"非交互式下必须同时给 `--yes`，否则不执行，退出码 8。

### 4.9 后续（第一版不提供）

| 命令 | 为什么不在第一版 |
|---|---|
| `saveslot policy set` | `policy.set` 与 slot 策略的高影响 ③ 后续（[`07-scope-v1.md`](07-scope-v1.md) 3.3） |
| `saveslot jobs`、抽取作业相关 | 大写入作业与抽取作业后续；`migration_diff` 的处理随 P4b 加进 `saveslot pending resolve` |
| `saveslot history composition` | 派生值构成后续 |
| `saveslot delete --evidence`、按行隐私删除 | 删除证据、按行删除后续 |
| `saveslot import`、`saveslot migrate`、从导出文件初始化 | 第一版只有导出。"导出能重放"由测试验证（[`02-architecture.md`](02-architecture.md) §11「导出重放」），不提供把导出装回去的命令：那要处理凭证与主体的对应，属于导入 |
| `saveslot write` | 见第 2 节"不做什么"：人手写 op 与证据容易出错，证据也会退化成 `api_call`；真有"人想不经 Agent 改一个值"的需求时再加，纯增量 |
| `saveslot verify --replay` 的离线形式 | saveslot 服务起不来时停机直接打开数据目录比较；第一版只有经服务的对拍 |
| Windows 上的本地服务 | 第一版本地只支持 macOS 与 Linux |

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

### 5.2 处理：怎么绑定内容

`saveslot pending resolve <pi_…> <处理方式>` 在一次调用里做三步：

1. 取详情（`pending`），拿到 `item_ver`，按 5.1 渲染给人看；
2. 交互式时提问：`确认对 pi_9B… 执行 confirm？上面列出的 1 段将被覆盖 [y/N]`；
3. 用**第 1 步拿到的那个 `item_ver`** 调 `resolve`。

- **CLI 从不依赖兜底**：契约允许不带 `item_ver` 时取本连接实例最近读到的版本（[`04-contract.md`](04-contract.md)「版本令牌」），但兜底取的是这个凭证最近一次读到的版本：另一个终端、另一个用同一凭证的程序刚读过的更新版本会被取到，而眼前这个人看的是旧的；CLI 总是显式带上本次展示的那一份，"确认的就是人刚看到的"。
- **调用方给了 `--item-ver`**：原样发它，不换成 CLI 刚取到的版本。交互式下取到的版本与它不同，直接说明"自那个版本以后内容已变"，展示当前内容并重新提问；带 `--yes` 时**不取详情**、不展示，直接调 `resolve`，对不上由服务端报 `confirmation_mismatch`。
- **第 1 步取详情时事项已经关闭**：不提问，说明已按什么处理、或被什么取代，退出码 3（与 `resolve` 返回 `item_closed` 时相同）。
- **冲突事项有多个候选而没给 `--candidate`**：交互式下列出候选（下标、值、写入者）让人选；非交互式是用法错误，退出码 2，输出里列出候选的下标。
- **契约规定不按 `item_ver` 绑定的处理照契约走**：`deletion` 的 `cancel` 不核对（5.3）；`migration_diff` 的 `accept_all` 带展示时的 `diff_upto`（`--yes` 时必须给 `--diff-upto`，随 P4b）。
- **内容变了**（`confirmation_mismatch`）：交互式时渲染错误里附带的当前内容，说明"自你查看以后内容已变"，重新提问；非交互式时不自动重试，退出码 3，输出新的 `item_ver`。
- **已关闭**（`item_closed`）：说明已按什么处理、或被哪次写入取代，退出码 3；同一处理方式重发得到重放结果时，写"该事项已于 … 按 confirm 解决，本次没有新的改动"，退出码 0。
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
- 撤回 `saveslot delete cancel` 不核对事项版本（[`04-contract.md`](04-contract.md)「待处理事项」），换一个终端也能直接撤回；仍要一次 `y/N` 确认，因为撤回会让宽限期内基于删除后状态的写入重新计算。撤回后有候选被重新判定时（原事项在宽限期内已被解决），输出单列一段；其中另开了事项的，末尾提示 `saveslot pending` 去处理。

### 5.4 交互式与非交互式的边界

| 情形 | 行为 |
|---|---|
| 标准输入是终端，没给 `--yes` | 展示内容后提问 |
| 标准输入不是终端，没给 `--yes` | 不提问、不执行，退出码 8，提示先用 `saveslot pending show --json` / `saveslot delete preview --json` 取内容与绑定令牌、再带 `--yes` 执行（提示里不打印令牌） |
| 给了 `--yes` | 不提问；但改变数据的确认类命令必须同时给出绑定令牌：`saveslot pending resolve` 要 `--item-ver`，删除只能用 `saveslot delete apply <dc_…>`（`saveslot delete --source … --yes` 拒绝）；`saveslot delete cancel`、`saveslot connections revoke` 只要 `--yes` |

**非交互式确认允许，理由**：saveslot 不区分确认出自人还是 Agent（[`02-architecture.md`](02-architecture.md) §3），交互式提问也挡不住能操作终端的程序，加一个"我真的确定"之类的额外标志不提供任何保证，只增加步骤。真正的保证是内容绑定：脚本必须先 `saveslot pending show --json` / `saveslot delete preview --json` 拿到令牌，执行的就是交付给它的那一份。CLI 保证不了脚本看了内容，只保证执行的版本与交付的一致、内容变了就不执行。

## 6. 输出约定

### 6.1 人读文本与 `--json`

- **人读文本**（默认）：由 CLI 渲染器按契约字段生成。标记写法同 MCP（[`05-surfaces.md`](05-surfaces.md)「标记与提示的措辞」），渲染器测试同样检查每个契约标记都出现在文本里；`notices[]` 写在末尾；`warnings[]` 全部渲染（含 `multi_segment_unmapped`，人可以据此回头补证据映射）。`saveslot pending show` 对 `flagged` 事项列出命中的行与命中的那一组键；读结果里 `dangling_ref` 标记照 MCP 的写法渲染。提示里的下一步写成 CLI 命令，不写 `saveslot_` 工具名。
- **`--json`**：标准输出只有一个 JSON 值——契约的结构化结果，与 HTTP 回执同一形状，CLI 不改名、不删字段；`export` 例外，是 NDJSON 流。报错时输出契约的 `{"error": {...}}`。组合命令输出最后一个契约操作的结果（`pending resolve` 是 `resolve` 的，`delete --source` 是 `delete` 的）；`connect` 输出 `connections.issue` 的结果，另加 `selfcheck` 字段。脚本必须看 `status` 等字段，不能只看退出码（同 HTTP 的规定）。
- 交互式提示、进度、"令牌只显示一次"这类话写标准错误，`--json` 时标准输出保持可解析。

### 6.2 退出码

| 退出码 | 含义 | 对应 |
|---|---|---|
| 0 | 完成（含重放、`outcome: pending` 这类"已记下但未生效"——看输出） | — |
| 1 | CLI 或 saveslot 服务内部错误 | `internal`；`saveslot connect` 的自检或 `--apply` 失败 |
| 2 | 命令用法错误（CLI 自己发现的） | — |
| 3 | 要先重读 / 内容已变 | `read_first`、`confirmation_mismatch`、`item_closed`、`preview_outdated`、`handle_expired`、`draft_outdated`、`schema_incompatible` |
| 4 | 找不到 | `not_found`、`unknown_table`、`unknown_field` |
| 5 | 请求被拒 | `invalid_argument`、`validation_failed`、`field_unmatched`、`sql_rejected`、`sql_timeout`、`too_large`、`derived_readonly`、`revoked`、`not_in_this_version`、`rate_limited`（`quota`）、`referenced`（后续）、`lease_expired`（后续） |
| 6 | 凭证或权限 | 未登录、凭证文件权限过宽、`unauthenticated`（令牌无效、已吊销、会话过期）、`insufficient_scope` |
| 7 | 连不上或暂时不可用（稍后重试） | saveslot 服务未运行、套接字不可达、`unavailable`（忙、恢复中、对拍中、启动中）、`rate_limited`（`busy`） |
| 8 | 未执行 | 人在提示中拒绝；非交互式缺 `--yes` 或绑定令牌 |
| 9 | 校验发现问题 | `saveslot verify` 报断裂 / 不符，`saveslot verify --replay` 报不一致，`saveslot doctor` 有不通过项 |

退出码只分大类，权威信息是 `--json` 里的 `error.code`；契约以后新增的错误码归入 1 以外最接近的一类，未知的按 5 处理。

### 6.3 错误的展示

文本由 `code` 与附带字段渲染（同 [`05-surfaces.md`](05-surfaces.md)「报错的文本」的内容），写到标准错误，第一行是 `错误 <code>：<一句话>`，之后是可执行的下一步：

```
错误 confirmation_mismatch：pi_9B… 自你查看以后内容已变
  现在的提议：11-02 起改为 3500 CNY（一直延续）
  重新查看：saveslot pending show pi_9B…
```

### 6.4 不可信文本在终端里

契约里的 `UntrustedText`（[`04-contract.md`](04-contract.md)「不可信文本」）在终端里有两类风险：一是原文里的控制字符改写终端（ANSI 转义、清屏、Unicode 双向覆盖字符把一段文字显示成另一段），二是有 shell 的 Agent 读 CLI 的输出时被原文里的指令注入。

- **一律转义控制字符**：C0 / C1 控制字符、ESC、双向覆盖与隔离字符显示成可见的转义写法（如 `\x1b`、`<U+202E>`）；`--json` 由 JSON 编码自然转义。
- **人读文本里用书名号把不可信值括起来**（`「腿有点酸，很累」`），终端支持颜色时以弱化色显示，与 saveslot 自己的说明区分开。
- **标准输出不是终端时**（被管道或 Agent 读取），不可信值改为包在带编号的边界标签里（`<untrusted-data-编号>…</untrusted-data-编号>`，开闭同号，每次输出一个新编号），形式与规则同 MCP（[`05-surfaces.md`](05-surfaces.md)「不可信边界」）；人用管道处理时用 `--json`，或 `--untrusted-tags never` 关掉（`always` 强制打开）。
- schema 里调用方撰写的说明同时标出写入者与版本，同 MCP。

## 7. 和实现顺序的对应

按 [`07-scope-v1.md`](07-scope-v1.md)「实现顺序」：

| 步 | CLI 加什么 | 为什么在这一步 |
|---|---|---|
| P0 | 无（只建 `cli` 包骨架，接上由契约生成的 `client`） | 契约初版类型此时才有 |
| P1 | `init`、`start` / `stop` / `status`、`mcp`、`config get`；`slot list` / `show` / `create`、`schema templates`；`connect`、`connections list` / `revoke`；`pending list` / `show` / `resolve`（`awaiting_confirmation`、`conflict`）；`query`、`history`（`timeline` / `as_of`）；`verify`、`reads` | eval 1–4 要两个连接实例、用 CLI 喂 schema 建 slot，eval 4 的确认也要能由人处理 |
| P2 | `sql`、`sources`、`history changes`、`verify --replay`、`pending resolve` 的 `flagged` | 与 `saveslot_sql`、`saveslot_sources`、影响查询、双后端对拍同步出现 |
| P3 | `delete`（交互式、`preview`、`apply`、`cancel`、`status`）、`export`、`start --restored` | 隐私删除、导出与恢复流程在这一步实现 |
| P4 | `schema get` / `draft`、`pending resolve` 的 `schema_change` | schema 变更（不含抽取）在这一步 |
| P5 | `login` / `logout`、`profile`、`connect --profile cloud`；`server init` / `start` / `user` / `restore` | 服务器模式（云服务与自部署）与 OAuth 在这一步 |
| P6 | `service install` / `uninstall`、`doctor`、`connections rename`、`policy show`、`config set`；按 eval 结果调文本 | 收尾：本地 daemon 的安装与自启、管理命令补齐 |
| P4b（不属于第一版） | `pending resolve` 的 `migration_diff` 四种处理方式、`jobs` | 随抽取作业 |

P1 结束时 CLI 已能完成第 3 节的整条上手流程（自启与 `saveslot doctor` 除外；P6 之前要改配置就直接编辑 `config.toml`）；它在 P1 依赖的本地 HTTP 适配器、管理类操作与 `saveslot mcp` 转发都排在 [`07-scope-v1.md`](07-scope-v1.md) 的 P1 里。

## 8. 安全

### 8.1 本地服务只供本机访问

| 做法 | 防什么 |
|---|---|
| 只在 unix socket 上监听，目录 0700、套接字 0600 | 别的系统用户、网络上的任何人 |
| 回环 TCP 默认关；打开时只绑回环地址，校验 `Host` / `Origin` | 局域网访问；网页经 DNS 重绑定访问。**打开后本机其他系统用户也能连上**，对他们只剩令牌一道防线 |
| 每个请求都要令牌（连接实例或用户会话），套接字权限不代替认证 | 区分主体、限定 scope：每个 Agent 只能做它的连接实例被授予的事，读写各自留痕。它不是对同权限程序的防护——够得着套接字的程序一般也读得到凭证文件（8.3） |
| 本地模式不提供绑定到非回环地址的配置 | 误配置把个人数据暴露到网络；跨设备用服务器模式（我们的云服务，或自部署——那是另一套带 OAuth 的启动方式，不是给本机模式开一个端口） |

CLI 与 `saveslot mcp` 只认配置里的套接字路径，不接受从环境变量改成任意 URL 的本地连接，少一种被误配置引到别处的可能；这不是防护——同权限的程序照样能改 `config.toml`。

### 8.2 凭证文件

- `~/.saveslot/` 0700；`credentials/` 下每个文件 0600，权限过宽时 CLI 拒绝使用。
- 控制面只存令牌的哈希；连接实例令牌只在签发时显示一次，CLI 不保存。
- 连接实例令牌住在宿主的 MCP 配置里（[`03-data-model/02-integrity-and-records.md`](03-data-model/02-integrity-and-records.md)「连接实例身份」），它的保护由宿主负责；令牌外泄时 `saveslot connections revoke` 即时生效。
- 句柄签名密钥在 `control/keys/`，与数据目录分开。
- **连接实例令牌会经过的地方**：shell 历史（把接入命令贴进终端时）、进程参数（`--apply` 执行宿主命令期间，本机其他用户可见）、宿主的配置文件。回环 TCP 关着时别的系统用户拿到它也连不上；打开回环 TCP 之前先确认这些地方没有外泄，有疑问就吊销重签。

### 8.3 只有用户会话能做的操作

| 操作 | CLI 命令 | 为什么不给连接实例 |
|---|---|---|
| `connections.issue` / `update` / `revoke` | `connect`、`connections …` | 能签发凭证的 Agent 就能给自己任意 scope，scope 失去意义；吊销是人收回权限的唯一手段 |
| `policy.set`（后续） | — | 策略决定哪些改动不经确认就生效，相当于改确认规则 |
| `reads.list` | `reads` | 审计的对象正是各个连接实例；被审计方不该能读全部审计 |
| `log.verify`、对拍 | `verify` | 面向运维，读日志全量；对 Agent 没有用处 |
| `export` | `export` | 一次拿走全部数据与源数据原文，绕开"按需读、逐次留痕"；带走数据是用户的权利，不是 Agent 的 |

其余操作（读、`resolve` 各类型、`delete`、`schema_draft`）连接实例按 scope 也能做，用户会话全都能做。

**边界如实写明**：本地的用户会话凭证是本机文件，与当前系统用户同权限的程序——包括有 shell 的 Agent——能读到它，也能直接运行 `saveslot`；saveslot 防不住这一类程序，与它们能直接读写数据目录是同一个边界（[`02-architecture.md`](02-architecture.md) §10）。上表的限制挡住的是只经 MCP / HTTP 接入的 Agent。要让某个 Agent 碰不到这些操作，就不给它访问 `~/.saveslot/` 的 shell 权限。

**留痕也是同一个边界**：凭用户会话运行的 CLI，读取、确认、删除都记在用户名下；有 shell 的 Agent 这样做时与真人操作分不开，"谁读过、谁确认的"在这条路上不成立。给这类 Agent 一个连接实例令牌、让它设 `SAVESLOT_TOKEN` 运行 CLI（或直接调 HTTP），留痕才归到它名下。

## 9. 待定

本文没有单列的待定项。依赖实验的两处：安装形态（第一版 npm 包；独立可执行文件与安装包等实验 6）、本地后端若因实验 1 换成打包的原生 PostgreSQL，安装与启动要重看。
