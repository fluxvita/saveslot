# 13 · 自部署

这一章给要在自己的服务器上跑 saveslot 服务器模式的人：要准备什么、怎么起来、怎么建账户、Agent 怎么连、备份恢复要注意什么。自部署和我们的云服务是同一套代码、同一组配置项，差别见第 11 章第 1 节。

规格：[`../spec/02-architecture.md`](../spec/02-architecture.md) §9「租户与托管」（含「自部署的前提」）；命令与配置在 [`../spec/06-cli.md`](../spec/06-cli.md) §4.1「服务器自部署的运维命令」「服务器模式的配置」。

## 1. 要准备什么

| 要什么 | 说明 |
|---|---|
| PostgreSQL 18 | 每个用户一个 database，另有一个控制面库（存账户、凭证、租户目录与删除登记）。两者可以在同一个实例上 |
| 一个数据库角色 | 见下 |
| 对外地址 | Agent 和命令行连进来的 HTTPS 地址，例如 `https://saveslot.example.com`。TLS 由你前面的反向代理负责，saveslot 进程本身监听明文 HTTP |
| 一处存密钥的地方 | 句柄签名密钥是一个文件，由你保管；放在只有运行 saveslot 的用户能读的位置，或用容器的 secret 挂进去 |
| 备份 | 控制面库与全部租户库要一起备份（第 5 节） |

### 数据库角色要哪些权限

saveslot 不需要超级用户。它用的角色要：

- 是控制面库的属主：`saveslot server init` 在里面建表。
- 有 `CREATEDB`，并能连上维护库（默认是 `postgres`）：每建一个用户，saveslot 就在实例上建一个 database，这个 database 归它所有。

```sql
CREATE ROLE saveslot LOGIN CREATEDB PASSWORD '…';
CREATE DATABASE saveslot_control OWNER saveslot;
```

所以有的托管 PostgreSQL（云厂商的数据库服务）用不了：只给一个库、不给 `CREATEDB` 的，第一版不支持。

**删除之后的明文残留，还要四项授权。** 隐私删除到期后，saveslot 要让数据库的文件里（包括预写日志）也搜不到被删的明文。最快的做法是原地清理，它要这个角色多几项授权，实例还要关掉预写日志段的复用：

```sql
GRANT pg_maintain TO saveslot;
GRANT pg_checkpoint TO saveslot;
GRANT EXECUTE ON FUNCTION pg_switch_wal() TO saveslot;
-- 由超级用户执行（或直接写进 postgresql.conf），再重载配置：
ALTER SYSTEM SET wal_recycle = off;
SELECT pg_reload_conf();
```

缺任何一项，saveslot 照样能删干净，只是改用重建：把这个用户的日志重放进一个新的 database，再换掉旧的。重建慢得多，而且进行期间这个用户的数据不可写。saveslot 启动时核对这几项，用的是哪一种、缺的是哪一项，`saveslot doctor` 会写明。托管的 PostgreSQL（云厂商的数据库服务）多半给不了这些授权，那就是重建。这几步作用于整个实例：切换日志段、检查点会影响同一实例上的别的数据库。

## 2. 配置

服务器模式只读环境变量，不读本机模式的 `config.toml`。

| 变量 | 内容 | 例子 |
|---|---|---|
| `SAVESLOT_CONTROL_DATABASE_URL` | 控制面库 | `postgres://saveslot@db:5432/saveslot_control` |
| `SAVESLOT_CELL_DATABASE_URL` | 租户库所在的实例；库名写维护库 | `postgres://saveslot@db:5432/postgres` |
| `SAVESLOT_PUBLIC_URL` | 对外地址：`https://`，不带路径、不带末尾的 `/`（只在本机试跑、主机是回环地址时可以写 `http://`） | `https://saveslot.example.com` |
| `SAVESLOT_HANDLE_KEY_FILE` | 句柄签名密钥的文件：`server init` 生成它，之后 saveslot 只读不写 | `/run/secrets/saveslot-handle-key` |
| `SAVESLOT_LISTEN` | 监听地址，缺省 `127.0.0.1:8080` | `0.0.0.0:8080`（容器里） |
| `SAVESLOT_TRUSTED_PROXIES` | 你的反向代理的地址，逗号分隔 | `127.0.0.1` |

**saveslot 缺省只听本机的回环地址。** 它只说明文 HTTP：要是缺省就听全部网卡，照着文档起一个没加防火墙的实例，网络上的人就能在明文里截到令牌。反向代理和 saveslot 在同一台机器上时，回环地址正好够用。在容器里跑时，反向代理在容器外面，要把 `SAVESLOT_LISTEN` 显式写成 `0.0.0.0:8080`，再只把这个端口交给反向代理（例如只映射到宿主机的 `127.0.0.1`）。

**反向代理要配上 `SAVESLOT_TRUSTED_PROXIES`。** saveslot 只看得到反向代理连过来，请求真正从哪来，要靠代理写进 `X-Forwarded-For` 的地址；只有连接来自这里列出的代理时，saveslot 才信这个头。不配的话，所有人的请求在 saveslot 看来都来自代理这一个地址：一个人输错几次口令，按来源计数的登录失败限制就会挡住所有人。

限流在自部署上默认关。要按用户限流，设 `SAVESLOT_RATE_LIMIT`（每个用户每分钟的请求数），可另设 `SAVESLOT_RATE_BURST`（一次最多连着发多少个请求，缺省等于前者）。

**对外开放时，在反向代理上给 `/oauth/` 下的端点和登录页加按来源的限流。** `SAVESLOT_RATE_LIMIT` 按租户计，只管得到带令牌的请求；这些地址不用令牌就能访问，它管不到。

连接串里的口令最好经 PostgreSQL 的口令文件（`.pgpass`）或容器的 secret 提供，不写进变量本身。

**句柄签名密钥**由 `server init` 写到 `SAVESLOT_HANDLE_KEY_FILE` 指的位置（那个目录要已经存在），之后 saveslot 只读它，所以可以按只读挂载。saveslot 不会自己轮换它；要换，就换掉文件再重启，换之前发出去的翻页句柄、删除确认这类句柄随之失效，调用方重新取一次即可。

挂载时注意权限：saveslot 拒绝对"其他人"开放的密钥文件。Kubernetes 的 secret 卷默认是 0644，会被拒绝，要把 `defaultMode` 设成 0440（容器里的用户读不到时再配 `fsGroup`）；Docker 的 secret 照宿主机上那个文件的权限，在宿主机上把它设成 0600 或 0640。

## 3. 初始化与账户

```
$ saveslot server init --user alice
```

建控制面库的表、生成句柄签名密钥、建第一个账户和它的数据。口令从终端读；没有终端时用 `--password-file <路径>`。命令行参数里不接受口令：参数会进 shell 历史与进程列表。重复执行是安全的：已经做过的步骤不再做。

账户由你用命令管理，saveslot 不开放注册：

| 做什么 | 命令 |
|---|---|
| 加一个账户（同时为它建一份独立的数据） | `saveslot server user add <名字>` |
| 列出账户 | `saveslot server user list` |
| 停用一个账户：停用期间，它的登录和它给 Agent 签发的全部连接都用不了；数据不动，什么也不吊销 | `saveslot server user disable <名字>` |
| 重新启用：登录和连接原样恢复 | `saveslot server user enable <名字>` |
| 改口令：它现有的登录与用户会话立即作废；它给 Agent 签发的连接不受影响 | `saveslot server user passwd <名字>` |

## 4. 接 Agent 与命令行

人在自己的电脑上用 `saveslot login --server <对外地址>` 登录，之后的命令和本机模式一样，加 `--profile` 指向这台服务器（第 11 章第 3 节）。Agent 的宿主走远程 MCP，地址是 `<对外地址>/mcp`，授权走 OAuth（第 11 章第 2 节「服务器模式怎么接」）。

## 5. 备份与恢复

- **要一起备份的**：控制面库，以及全部租户库。控制面库里有删除登记与高水位：恢复一份旧的租户库时，恢复流程要按它们把备份之后删掉的内容再删一遍（第 11 章第 6 节「恢复之后为什么要走恢复流程」）。这一版还做不到这一步：删除登记里有某个租户的条目时，`server restore` 拒绝恢复这个租户，什么都不改（退出码 5）。
- **恢复一个租户**：先停服务器；只把这个租户的库从备份放回，**控制面库不放回**；运行 `saveslot server restore --tenant <租户>`；再启动服务器。服务器在运行时这条命令什么都不做。没走这条命令就换了库的，saveslot 打开它时会发现，拒绝对外服务并提示运行这条命令。
- **控制面库也丢了**：只能连它一起从备份放回，这是灾难恢复：备份之后的删除登记、账户与凭证的变化都随之丢失，恢复流程补不回来。所以控制面库要比租户库备份得更勤、存得更稳。

