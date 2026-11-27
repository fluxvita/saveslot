# 接入指南

[English](../../integration/README.md) · 简体中文

saveslot 有两种接入方式，按你要接的东西选：

| 你要接的是 | 用哪种 | 看哪一节 |
|---|---|---|
| 一个 Agent（Claude Code、Codex 这类支持 MCP 的宿主） | MCP | [一、MCP 接入](#一mcp-接入) |
| 一个脚本、程序或连接器（定时把外部系统的数据搬进来的程序） | HTTP | [二、程序和连接器接入](#二程序和连接器接入) |

两种方式连的是同一个 saveslot 服务、同一份数据。两种都要用到的内容在后三节：[凭证与权限](#三凭证与权限)、[结果与错误](#四结果与错误)、[数据与升级](#五数据与升级)。

## 0.1.0 有什么、还没有什么

0.1.0 是第一个对外发布的版本，本机模式和服务器模式都有。完整清单见[规格 `07-scope-v1.md` 第 7 节](../spec/07-scope-v1.md#7-010-提供哪些)。

**有的**：

- 本机模式：安装、启动、停止；本机上的 MCP（九个 `saveslot_` 工具）和 HTTP。
- 服务器模式：账户与登录、OAuth 授权、远程 MCP、经网络的 HTTP、自部署。
- 凭证：每个 Agent、每个程序一个，按权限和 slot 范围签发，可以吊销。
- 写入、读取、历史、待处理事项的查看与解决、导出（可以加口令）。

**还没有的**：

- **隐私删除**：没有删除的命令，MCP 上没有删除的工具，HTTP 上删除的端点报 `not_in_this_version`。`saveslot.delete` 权限可以签发，但没有用得上它的操作。数据写错了可以**撤销**（一次普通写入，保留历史，可以撤回）；要让内容彻底消失，0.1.0 做不到。
- **在写入过的表上改结构**（加字段、删字段、收紧约束、改精度、换单位）：这类改动报 `not_in_this_version`。从未写入过的表照常可以改。
- **从备份恢复之后的恢复流程**（见[数据与升级](#五数据与升级)）。

调用了这个版本还没有的操作或参数，都返回 `not_in_this_version`（状态码 501）。

已知的限制：

- 本机模式支持 macOS 和 Linux，需要 Node 24.22.1 及以上（26 系列 26.12.1 及以上）。
- 本机模式的数据只有本机能访问；本机与服务器模式之间不同步。
- 没有图形界面；人的操作经命令行。
- 其余见[讲解第 11 章第 7 节](../guide/11-deployment.md#7-第一版不做什么)。

## 一、MCP 接入


### 1. 安装

```sh
npm install -g @fluxvita/saveslot
```

### 2. 一条命令接入

```sh
saveslot setup
```

按提示选一个模板建第一个 slot，选要接入的宿主，确认一次。完成后宿主的工具列表里会出现一组 `saveslot_` 开头的工具。

### 3. 或者分步接入

```sh
saveslot init
saveslot start
saveslot slot create ledger --template spending --timezone Asia/Shanghai
saveslot connect claude-code --name "MacBook · Claude Code"
```

`saveslot slot create` 用自带的模板建一个 slot 和它的表；这里的 `spending` 模板建出 `ledger.expenses`（每笔支出一行）。`saveslot connect` 会打印一条宿主自己的添加命令，把它贴进终端执行；或者加 `--apply`，由 saveslot 代为执行。

再接一个 Agent，就换个名字再执行一次：

```sh
saveslot connect codex --name "MacBook · Codex"
```

没有添加命令的宿主（Cursor、Claude 桌面端），`saveslot connect cursor` 会打印配置片段，手动粘贴到宿主的配置里。

### 4. 写一笔，读回来

在 Agent 里说：

```
今天午饭花了 45 元
```

Agent 调用 `saveslot_write`。回执是英文文本：第一行说明其中标出的部分是存储的数据、不是给 Agent 的指令，下一行以 `Saved · ` 开头，表示已保存。再问：

```
这个月花了多少？
```

Agent 调用 `saveslot_query` 或 `saveslot_sql`，答出 45 元。

### 5. 验证

```sh
saveslot reads --connection "MacBook · Claude Code" --since 10m
```

成功的判据：列表里有一条自检之外的读取记录。接不上时运行 `saveslot doctor`。

### 6. 停止与清理

```sh
saveslot connections revoke "MacBook · Claude Code"
saveslot stop
```

再用宿主自己的移除命令去掉 saveslot 的条目（如 `claude mcp remove saveslot --scope user`）。不移除的话，宿主下次启动会重新拉起 saveslot 服务。

### 7. 连服务器模式


```sh
saveslot login
saveslot connect claude-code --profile cloud --apply
```

宿主会打开授权页：名字已经预填，权限预选读和写（可以另加 `saveslot.schema`），点一次"授权"。授权页不选 slot 范围，这样得到的凭证能访问全部 slot，包括以后新建的；要一个只碰某几个 slot 的凭证，用 `saveslot connect http --profile cloud --slots …` 签发（见[凭证与权限](#三凭证与权限)）。只有网页界面的宿主，在它的界面里手动填地址 `https://<域名>/mcp`。

出处：[讲解第 11 章第 2、5 节](../guide/11-deployment.md#2-agent-怎么连)；[规格 `06-cli.md` 第 3 节](../spec/06-cli.md#3-上手流程本地从零到第一个-agent-能用)；[规格 `05-surfaces.md` §1](../spec/05-surfaces.md#1-工具与操作的对应)。

## 二、程序和连接器接入


### 1. 取得令牌

先完成上面的安装、`saveslot init`、`saveslot start` 和建 slot，然后：

```sh
saveslot connect http --name "账单同步脚本" --slots ledger
```

命令打印令牌和套接字路径。令牌只显示这一次，存进环境变量：

```sh
export SAVESLOT_TOKEN=<令牌>
```

### 2. 调用

本机模式经套接字调用，路径以 `/v1` 开头：

```sh
curl --unix-socket ~/.saveslot/run/saveslot.sock \
  -H "Authorization: Bearer $SAVESLOT_TOKEN" \
  http://localhost/v1/slots
```

成功的判据：状态码 200，结果里有 `ledger`。

服务器模式用 `saveslot connect http --profile cloud` 取得令牌，地址换成 `https://<域名>/v1`，不需要 `--unix-socket`。

### 3. 写入

```sh
curl --unix-socket ~/.saveslot/run/saveslot.sock \
  -H "Authorization: Bearer $SAVESLOT_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: lunch-2026-11-10" \
  -d @write.json \
  http://localhost/v1/writes
```

`write.json`：

```json
{
  "sv": 1,
  "evidence": [{ "kind": "user_message", "text": "今天午饭花了 45 元" }],
  "ops": [{
    "intent": "insert",
    "table": "expenses",
    "set": { "date": "2026-11-10", "category": "餐饮", "amount": { "value": "45", "unit": "CNY" } }
  }]
}
```

### 4. 检查回执

下面是节选，真实的回执还有 `derived`、`pending` 等字段：

```json
{
  "status": "saved",
  "sv": 1,
  "seq": 21,
  "ops": [{
    "target": { "table": "ledger.expenses", "row": "r_01JC8Z…" },
    "intent": "insert",
    "ver": "v21.0"
  }]
}
```

成功的判据：`status` 是 `saved`。状态码 200 不够：`pending` 也是 200（见[结果与错误](#四结果与错误)）。

### 5. 读取

```sh
curl --unix-socket ~/.saveslot/run/saveslot.sock \
  -H "Authorization: Bearer $SAVESLOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "table": "expenses", "where": [{ "field": "date", "op": "=", "value": "2026-11-10" }] }' \
  http://localhost/v1/query
```

成功的判据：`rows` 里有刚写的那一行，带 `ver`。改这一行时把 `ver` 原样带回。

### 6. 停止与清理

```sh
saveslot connections revoke "账单同步脚本"
saveslot stop
```

吊销立即生效，已写入的数据保留。

出处：[讲解第 11 章第 2 节](../guide/11-deployment.md#没有-agent-的程序http)；[规格 `05-surfaces.md` §13–§14](../spec/05-surfaces.md#13-基本约定)；请求与回执的类型见[规格 `04-contract-types.md`](../spec/04-contract-types.md)。

## 三、凭证与权限


每个 Agent、每个程序各用一个凭证（连接实例），这样"谁读的、谁写的"才分得开。

**权限**在签发时选定，之后不能改：

| 权限 | 允许 | `setup`、`connect` 签发时默认 | 授权页上默认 |
|---|---|---|---|
| `saveslot.read` | 全部读操作 | 必须有 | 必须有 |
| `saveslot.write` | 写入、处理与写入有关的事项 | 给 | 预选 |
| `saveslot.schema` | 新建 slot、改表结构 | 给 | 不预选，可以另加 |
| `saveslot.delete` | 删除（0.1.0 还没有删除，这个权限暂时用不上） | 不给 | 不给 |

用 `--scope` 在默认上增减：

```sh
saveslot connect http --name "只读报表" --scope -write,-schema
saveslot connect claude-code --name "MacBook · Claude Code" --scope -schema
```

第一条是只读：只去掉 `write` 不够，剩下的 `schema` 还能新建 slot。第二条让 Agent 能读写、不能新建 slot。

**slot 范围**用 `--slots` 限定，之后也不能改。范围外的 slot 对这个凭证和不存在一样。要改权限或范围，吊销后重新签发。

**保管令牌**：

- 令牌只显示一次，saveslot 只存它的哈希。丢了就吊销重签。
- 贴进终端的命令会进 shell 历史；宿主的添加命令执行期间，令牌在进程参数里；最后它存在宿主的配置文件里。`saveslot setup` 不在终端上显示令牌。
- 不要把令牌写进代码、提交记录或日志。本页的例子只用占位符 `<令牌>`。

**吊销**：

```sh
saveslot connections list
saveslot connections revoke "账单同步脚本"
```

吊销立即生效。它只让这个凭证之后的请求被拒，不删除任何数据。

**日志里留下什么**：saveslot 记录每个凭证读过哪些行的哪个版本，不记读到的值；用 `saveslot reads` 查看，只有人的会话能看。

规则：[规格 `04-contract.md` §12](../spec/04-contract.md#12-调用方凭证与-scope)；[讲解第 11 章第 4 节](../guide/11-deployment.md#4-凭证连接实例与权限)。

## 四、结果与错误


**请求被接受不等于已生效。** 每次写入都要看回执的 `status`：

| `status` | 含义 | 怎么办 |
|---|---|---|
| `saved` | 已生效 | 继续 |
| `pending` | 已记下，没有生效：成了冲突候选，或在等确认 | 看回执的 `pending`，由人（`saveslot pending`）、Agent（`saveslot_resolve`）或程序（`POST /v1/pending/{id}/resolution`）处理 |

**`ver`**：读取返回每一行的 `ver`，改这一行时原样带回。带回的 `ver` 过期、而且别人改过同一个字段时，这次写入不报错，它成为候选，`status` 是 `pending`。

**被拒的写入**返回 `{error}` 和状态码，整个请求不生效：

| 状态码 | 常见的 `code` | 怎么办 |
|---|---|---|
| 400 | `invalid_argument` | 按 `reason` 和 `param` 改请求 |
| 401 | `unauthenticated` | 令牌缺失、无效或已吊销 |
| 403 | `insufficient_scope` | 这个凭证没有所需权限，重新签发 |
| 404 | `unknown_table`、`not_found` | 名字或 ID 不存在，或不在这个凭证的范围内 |
| 409 | `read_first` | 先读一次再写 |
| 422 | `validation_failed` | 按 `details` 逐条改 |
| 429、503 | `rate_limited`、`unavailable` | 按 `Retry-After` 等待后重试 |
| 501 | `not_in_this_version` | 这个版本还没有这项操作或参数（如删除），见[0.1.0 有什么、还没有什么](#010-有什么还没有什么) |

**重试**：带 `Idempotency-Key` 请求头的写入可以放心重发：24 小时内同一个键只执行一次，重发返回原结果并带 `replayed: true`。不带键时，服务端按请求内容算请求键，只在 10 分钟内有效：10 分钟内原样重发不会写两遍，过了 10 分钟再发就是一次新的写入。同一个键配不同的内容会报 `invalid_argument`。被拒的请求不去重，改对后可以用同一个键重发。

**分页**：`limit` 默认 20、上限 200；结果里有 `next_cursor` 时，把它作为 `cursor` 取下一页。`cursor` 一小时内有效。

规则：回执见[规格 `04-contract.md` 5.4](../spec/04-contract.md#54-判定与回执)；`ver` 见 [§2](../spec/04-contract.md#2-版本令牌versvitem_ver)；冲突与事项见 [§6](../spec/04-contract.md#6-待处理事项类型--处理方式--是否生效--scope)；错误见 [§11](../spec/04-contract.md#11-领域错误)、[§16](../spec/04-contract.md#16-外层错误)；幂等见 [§14](../spec/04-contract.md#14-幂等)；分页见 [§13](../spec/04-contract.md#13-任务分页与附带信息)。

## 五、数据与升级


**数据在哪**：本机模式的数据都在 `~/.saveslot/` 下。`saveslot init --data-dir <路径>` 可以把数据目录另放。不要放在 iCloud Drive、Dropbox 这类同步盘里。

**导出**：导出的是整条日志，每行一个 JSON 对象，不依赖 saveslot 也能读。

```sh
saveslot export -o saveslot-export.ndjson
saveslot export --encrypt -o saveslot-export.ndjson.age
```

只有人的会话能导出；连接实例的令牌不能。HTTP 的端点是 `GET /v1/export`。

**备份与恢复**：本机模式下 saveslot 自己不做备份，数据目录由系统级备份带上。规格里设计了从备份恢复之后的恢复流程（按删除登记把删过的内容再删一遍），0.1.0 还没有提供；0.1.0 也还没有删除，所以恢复备份不会让删掉的内容重新出现。恢复流程的设计见[讲解第 11 章第 6 节](../guide/11-deployment.md#6-导出备份与恢复)。

**升级**：新版本能读旧版本的数据。用新版本写过之后换回旧版本，旧版本会拒绝打开。0.1.0 之前开发期的数据不在这个承诺之内，需要重新初始化。

出处：[讲解第 11 章第 6 节](../guide/11-deployment.md#6-导出备份与恢复)；[规格 `06-cli.md` §4](../spec/06-cli.md#4-命令清单)。saveslot 保证什么、不保证什么，见[讲解第 10 章](../guide/10-guarantees.md)。

## 人怎么操作

处理待处理事项、看历史这些由人做的事，经命令行，是另一条路径（删除在 0.1.0 里还没有）：[讲解第 11 章第 3 节](../guide/11-deployment.md#3-人怎么用命令行)。
