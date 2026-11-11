# 05 · 存储引擎选型 + 多租户

> 调研日期 2026-11-09。范围：saveslot 的存储引擎（本地桌面 / 自托管 / 托管多租户三种部署共用一套引擎）与托管侧租户模型。
> 每条事实都附出处；GitHub 链接尽量钉到 commit。标「未核实」的是推断或没找到一手来源。
> 标「实测」的是本次在 macOS arm64 / Node 24.14.0 上对 `@electric-sql/pglite@0.5.15` 跑的小实验（脚本已随临时目录删除，结果见 §1.6）。

## 0. 结论先行

1. **PGlite 已能当「本地版 PostgreSQL」用，但现在还不能直接当安全边界、也不能当强持久化存储。**
   它是 PostgreSQL 18.6，窗口函数、递归 CTE、range 类型 + exclusion constraint、RLS、只读事务都能用（实测）；
   但默认 **fsync 关闭**，`statement_timeout` **不生效**（实测），以低权限 `username` 打开时 `session_user` 仍是超级用户，
   **`SET ROLE postgres` 一句就能把权限提回来**（实测）。同一数据目录被两个进程同时打开会把库写坏，官方没有锁。
2. **SQLite / DuckDB 能跑 saveslot 的大部分查询，但缺 saveslot 数据模型里的几样关键件**：range 类型与 exclusion constraint
   （业务时间、状态区间要用）、角色 / RLS、完整的 ALTER TABLE；只读沙箱要靠 authorizer 回调自己写。
   走「托管用 PG、本地用 SQLite」的双引擎，等于受限 SQL 要维护两套语义，Ghost、Synapse 这类项目最后都收敛回了一种生产引擎。
3. **推荐：三种部署都用 PostgreSQL 方言，只换宿主**——本地默认 PGlite（嵌在 saveslot 进程里），把内置原生 PG 二进制留作降级路线；
   自托管和托管都用原生 PostgreSQL。受限 SQL 的安全性**不能靠数据库角色**，主防线是 saveslot 自己的 AST 白名单（libpg_query 解析），
   角色 / 只读事务 / 超时只是原生 PG 上的第二道防线。
4. **托管租户模型：每个用户一个 PostgreSQL schema（或 database），按「单元」（cell）分片，不用共享表 + tenant_id + RLS。**
   原因是 saveslot 的 schema 由用户 / Agent 自定义——每个用户的表结构本来就不同，共享表只能退化成 JSONB/EAV。
   要控制的是单个集群里的 catalog 规模，所以要给每个 cell 设用户数上限。用户的导出 / 迁移不靠物理备份，
   靠 saveslot 自己的应用层日志（哈希链）重放，这样本地 ↔ 托管迁移和引擎宿主无关。
5. **必须先做的 spike**：PGlite 持久性（断电 / kill -9 后能否恢复）、PGlite 上的查询超时与沙箱逃逸面、
   每用户一套 schema 在一个集群里能撑多少用户、派生表同事务刷新的写入延迟。

---

## 1. PGlite（ElectricSQL，PostgreSQL 编译成 WASM）

### 1.1 它是什么、怎么工作

- 基于 PostgreSQL 的 **single-user mode**（原本用于命令行 bootstrap 和恢复），PGlite 在它之上加了一条输入输出通道，让 JS 直接和编译成 WASM 的 Postgres 交互；README 写明「PGlite is single user/connection」。
  出处：[README @ bac163e](https://github.com/electric-sql/pglite/blob/bac163ecc92e968adda68864b74b7e3d65a68e97/README.md)
- 默认启动参数（源码）：`--single`、`-F`（**turn fsync off**）、`-O`（允许改系统表结构）、`max_worker_processes=0`、`max_parallel_workers=0`、`io_method=sync` 等。
  出处：[`packages/pglite/src/pglite.ts` L150-171 @ bac163e](https://github.com/electric-sql/pglite/blob/bac163ecc92e968adda68864b74b7e3d65a68e97/packages/pglite/src/pglite.ts#L150-L171)
- 运行环境：浏览器、Node.js、Bun；Electron 主进程 / utility 进程走 Node 文件系统路径（0.5.4 修复）。
  出处：[about](https://pglite.dev/docs/about)、[CHANGELOG 0.5.4 @ bac163e](https://github.com/electric-sql/pglite/blob/bac163ecc92e968adda68864b74b7e3d65a68e97/packages/pglite/CHANGELOG.md)
- **PostgreSQL 版本：18.6**（0.5.9 升级；0.5.0 起为 18.x）。实测 `select version()` 返回 `PostgreSQL 18.6 (PGlite 0.5.15) on wasm32-unknown-emscripten`。
  出处：[CHANGELOG @ bac163e](https://github.com/electric-sql/pglite/blob/bac163ecc92e968adda68864b74b7e3d65a68e97/packages/pglite/CHANGELOG.md)
- 许可：Apache 2.0 与 PostgreSQL License 双许可，任选。出处：[about](https://pglite.dev/docs/about)、[README](https://github.com/electric-sql/pglite/blob/bac163ecc92e968adda68864b74b7e3d65a68e97/README.md)
- 成熟度：npm 最新 `0.5.15`（2026-11-03），10 月以来几乎每周一个补丁版；仍是 0.x，changelog 里近几个版本还在修 `close()` 竞态、协议解析状态、文件时间戳这类基础问题；GitHub 约 16.3k star。
  出处：[npm registry](https://registry.npmjs.org/@electric-sql/pglite)、[CHANGELOG @ bac163e](https://github.com/electric-sql/pglite/blob/bac163ecc92e968adda68864b74b7e3d65a68e97/packages/pglite/CHANGELOG.md)、[repo](https://github.com/electric-sql/pglite)
- 包体：npm 宣称 gzip 后约 3.7MB；本地安装目录 26MB（实测 `du`）。出处：`npm search` 输出的包描述

### 1.2 扩展

- 主包内置：`btree_gist`、`btree_gin`、`pgcrypto`、`pg_trgm`、`hstore`、`ltree`、`citext`、`uuid-ossp`、`pg_stat_statements`、`auto_explain`、`amcheck` 等 contrib。
- 独立 npm 包：`pgvector`、Apache AGE、`pg_ivm`、`pg_hashids`、`pg_textsearch`、`pg_uuidv7`、`pgmq`、`pgtap`、PostGIS。
  出处：[extensions](https://pglite.dev/extensions/)；npm 上 `@electric-sql/pglite-pg_ivm@0.0.16`、`@electric-sql/pglite-pgvector@0.0.16` 均已发布（`npm search` 实测）。
- **自定义扩展**：可以编，流程是把扩展作为 submodule 放进 `postgres-pglite/pglite/other_extensions` 再加前端包；限制是「整条依赖链都要编成 WASM」、符号导出问题「有时运行时才暴露」、复杂构建的文档「仍在编写中」、**扩展 API 尚不稳定**。
  出处：[extensions/development](https://pglite.dev/extensions/development)
- `periods`（SQL:2011 时间段扩展）不在列表里。它是纯 C + PL/pgSQL、无外部依赖，按「happy path」应可编译——**未核实**。

### 1.3 持久化与多进程

- 文件系统后端：MemoryFS（默认，不持久）、NodeFS（Node/Bun，`file://` 或无前缀路径）、IdbFs（浏览器，启动时把全部文件读进内存，每条查询后整文件 flush）、OPFS AHP（Web Worker；Safari 限 252 个 sync access handle，而一套 Postgres 有 300+ 文件）。
  出处：[filesystems](https://pglite.dev/docs/filesystems)、[api](https://pglite.dev/docs/api)
- `relaxedDurability`：不等 flush 完成就返回结果，主要给 IndexedDB 用。出处：[api](https://pglite.dev/docs/api)
- **fsync 实际上是关的**：默认参数带 `-F`（见 1.1 源码）。社区 issue #1107 进一步指出 NodeFS 的 `syncToFs()` 为空、emscripten 的 `fd_sync` 在 NODEFS 上直接返回成功、没有真正的 host fsync——**也就是说 PGlite 在 Node 上没有「提交即落盘」的保证**；该 issue 仍 open，作者也说明自己没有复现过真实断电损坏。
  出处：[issue #1107](https://github.com/electric-sql/pglite/issues/1107)
- **没有数据目录锁**：两个进程同时打开同一 `dataDir` 都会成功、都能写，目录随即损坏，下次打开报 `RuntimeError: Aborted()`；维护者回复「做好不容易」，建议应用自己加 pid 锁。相关 PR #892 仍 open。
  出处：[issue #1106](https://github.com/electric-sql/pglite/issues/1106)、[PR #892](https://github.com/electric-sql/pglite/pull/892)
- `dumpDataDir()` 导出的 tarball「可能与其他 Postgres 版本不兼容，只为导回 PGlite 设计」——**不能把它当作跨部署的导出格式**。出处：[api](https://pglite.dev/docs/api)

### 1.4 单连接限制与多连接方案

- 「PGlite only has a single exclusive connection」；浏览器多标签用 multi-tab worker 共享一个实例。出处：[docs](https://pglite.dev/docs/)
- `pglite-socket`：用 Node `net` 把 PGlite 包成 PG wire 协议服务器，内部用多路复用器把多个客户端排进一个连接；文档自己承认「与标准 Postgres 行为不同，不保证所有用例可用」，不支持 SSL。
  出处：[pglite-socket](https://pglite.dev/docs/pglite-socket)
  已知问题：并发 extended-protocol 批次在连接间交错、一次内部异常会让队列永久死锁（[#1046](https://github.com/electric-sql/pglite/issues/1046)）；客户端事务中途断开导致死锁（[#985](https://github.com/electric-sql/pglite/issues/985)）。
- 真正的多会话：PR #1054 用 Node Worker 模拟 postmaster + 多个真实 backend（`PGlitePostmaster.create()`），**仍 open、未合并**。出处：[PR #1054](https://github.com/electric-sql/pglite/pull/1054)
- 对 saveslot 的含义：saveslot 本地版是**一个 saveslot 进程独占 PGlite**，所有 MCP / HTTP 请求在 saveslot 内部排队——这本来就是单用户桌面的形状，单连接不是障碍；障碍是「一条慢查询会堵住所有请求」（见 1.6 超时）。

### 1.5 角色、RLS、只读事务（SQL 沙箱需要的）

- `username` 选项：「Permissions will be applied in the context of this user」。出处：[api](https://pglite.dev/docs/api)
- RLS 早期版本不生效，0.2.9 起可用。出处：[issue #138](https://github.com/electric-sql/pglite/issues/138)、[issue #274](https://github.com/electric-sql/pglite/issues/274)
- PostgreSQL 规则：超级用户和 `BYPASSRLS` 角色总是绕过 RLS，表 owner 默认也绕过（除非 `FORCE ROW LEVEL SECURITY`）。出处：[PG 文档 5.9](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- **`SET ROLE`：若 session user 是超级用户，可切到任何角色。** 出处：[PG 文档 SET ROLE](https://www.postgresql.org/docs/current/sql-set-role.html)
  → 实测 PGlite 用 `username: 'reader'` 打开后 `current_user=reader`、但 **`session_user=postgres`**，所以 `SET ROLE postgres` 成功、随后读到了未授权的表。**PGlite 里的角色不是安全边界**。

### 1.6 实测（PGlite 0.5.15，NodeFS，M 系列 Mac）

| 项目 | 结果 |
|---|---|
| 首次 `create`（含 initdb） | 651 ms；再次打开 44 ms |
| 单事务插入 10 万行 | 160 ms |
| 1000 条逐条自动提交插入 | 48 ms（注意：fsync 关闭，数字偏乐观） |
| 10.1 万行上按 uid 分区、7 天 `RANGE` 窗口滑动平均 | 8.7 ms |
| 递归 CTE 1 万层 | 4 ms |
| `btree_gist` + `tstzrange` exclusion constraint | 正确拒绝重叠区间 |
| `BEGIN READ ONLY` 内 INSERT | 正确报错 `cannot execute INSERT in a read-only transaction` |
| `statement_timeout='200ms'` + 3 亿行 `generate_series` | **未中断，跑满 37.6 s** |
| `statement_timeout='200ms'` + `pg_sleep(2)` | **未中断，2.0 s** |
| `username: reader` + RLS 策略 `uid = 1` | 过滤正确；无授权 INSERT 被拒 |
| reader 执行 `SET ROLE postgres` 后读未授权表 | **成功（逃逸）** |
| 在 Worker 里跑 PGlite，查询中 500ms 后 `worker.terminate()`，再打开同一目录 | 只读重查询、大批写入各试 1 次，都能重新打开且数据一致（未提交的批量写被丢弃）；**样本只有 1 次，不能当作保证** |

结论：小数据量下性能绰绰有余；超时只能靠「放进 Worker、超时就杀掉 Worker 重开」，这是可行但需要验证的路线。

### 1.7 官方基准

- 内存模式下 PGlite 与 SQLite 往返延迟同一量级（插入小行 0.058 vs 0.083 ms，查询 0.088 vs 0.042 ms）；IndexedDB 默认模式下 PGlite 慢得多（插入 21 ms vs 2.9 ms），开 relaxed durability 后降到 0.085 ms。页面没有 NodeFS 的数据。
  出处：[benchmarks](https://pglite.dev/benchmarks)

### 1.8 saveslot 能否直接用

- 许可没问题（Apache-2.0 / PostgreSQL）。功能面最贴 saveslot（同一方言、同一套 range/RLS/窗口函数）。
- 不能直接用作「安全边界」和「强持久化」：需要 saveslot 自己补数据目录锁、查询超时（Worker 隔离）、持久性策略（见 §7 spike），沙箱完全靠 AST 白名单。

---

## 2. 内置原生 PostgreSQL（桌面打包二进制）

### 2.1 怎么做

- **embedded-postgres（Node）**：用代码拉起一个 PG 集群，二进制来自 zonky 的 embedded-postgres-binaries；支持 Darwin x64/arm64、Windows x64、Linux 多架构，PG 14–18（18.6.0）；包代码 MIT、二进制 Apache 2.0；需要 postinstall 建软链；**PG 不能以 root 运行**。
  出处：[README @ 54b2f9a](https://github.com/leinelissen/embedded-postgres/blob/54b2f9a183e1c68b041f87a1ed1e64bcbc7799c8/README.md)
  体积：`@embedded-postgres/darwin-arm64@18.6.0-beta.19` unpacked **约 337MB**，`windows-x64` 约 109MB（`npm view dist.unpackedSize` 实测）；PGlite 安装目录 26MB。
- **postgresql_embedded（Rust，theseus-rs）**：默认运行时下载二进制，`bundled` feature 在编译期把安装包嵌进二进制；仍是**独立进程**（「embedded-like」）；Apache-2.0/MIT。
  出处：[repo](https://github.com/theseus-rs/postgresql-embedded)
- Postgres.app 式：把完整 PG 装进 .app，由应用管理 `pg_ctl` 生命周期——同样是独立进程，原理同上（未单独核实 Postgres.app 的实现细节）。

### 2.2 利弊

| 利 | 弊 |
|---|---|
| 真 PostgreSQL：fsync、`statement_timeout`、真实角色 / 只读角色、多连接全部可用，和托管版行为完全一致 | 安装包大（上百 MB），每个平台一份二进制，签名 / 公证（macOS）、杀软误报（Windows）都要处理（未核实具体案例） |
| 扩展可用原生编译（`pg_ivm`、`periods` 都是普通 PGXS 扩展） | 要管理子进程：端口 / unix socket 冲突、崩溃后 `postmaster.pid` 残留、升级大版本需 `pg_upgrade` 或导出重导 |
| 多个 saveslot 进程 / CLI 可同时连 | 用户机器上多了一个常驻服务进程，资源占用和「无服务器」的承诺有落差 |

**saveslot 能否直接用**：能（许可宽松、PG 本身最成熟）。适合作为 PGlite 不达标时的降级路线，或给「重度本地用户」的可选模式。

---

## 3. SQLite（含 libSQL/Turso）与 DuckDB

### 3.1 SQL 能力对照 saveslot 的需求

| 需求 | PostgreSQL / PGlite | SQLite | DuckDB |
|---|---|---|---|
| 窗口函数 | 完整 | 3.25 起支持；`RANGE n PRECEDING` 3.28 起，**`RANGE` 只能有一个 ORDER BY 项，偏移必须是非负数值常量**（没有 `interval '7 days'`，时间要存成数值）[sqlite windowfunctions](https://www.sqlite.org/windowfunctions.html) | 完整（未单独核实） |
| 递归 CTE | 有 | 有（未单独核实版本） | 有 |
| JSON | `jsonb` + 索引 | JSON 函数（JSON 文本 / JSONB blob） | 有 |
| range 类型 / exclusion constraint | 有（实测 PGlite 可用） | **无** | **无**（未核实） |
| 角色 / GRANT / RLS | 有 | **无**，靠 authorizer 回调 | **无** |
| 事务内 DDL | 有 | DDL 可在事务里（官方 12 步改表流程就包在一个事务里）[lang_altertable](https://sqlite.org/lang_altertable.html) | 有（未核实） |
| ALTER TABLE | 完整 | **有限**：改列类型 / 约束要走「建新表 → 拷数据 → 删旧表 → 改名」12 步；ALTER COLUMN 仅能设 / 去 NOT NULL（3.53.0 起）[lang_altertable](https://sqlite.org/lang_altertable.html) | 较完整（未核实） |
| 并发写 | MVCC，多连接 | 单写者 | 单进程读写；多进程只能只读；乐观并发冲突需重试 [duckdb concurrency](https://duckdb.org/docs/2.0/connect/concurrency.html) |
| 精确数值 | `numeric` | 无原生 decimal（未单独核实；SQLite 只有 INTEGER/REAL/TEXT/BLOB 存储类） | `DECIMAL` |

对 saveslot 的影响：DRAFT 里的「业务时间 / 状态类生效区间」「schema 迁移」「`numeric` 精确换算」三处都正好落在 SQLite 的缺口上。DuckDB 是分析型引擎，单进程写、为批量设计，不适合作为 saveslot 的 OLTP 主存储（可当离线分析 / 导出目标）。

### 3.2 SQLite 上的只读沙箱怎么做

SQLite 官方给的不可信 SQL 防线（[security](https://www.sqlite.org/security.html)、[set_authorizer](https://www.sqlite.org/c3ref/set_authorizer.html)）：

- `sqlite3_set_authorizer()`：**在编译期**对每个动作回调，可 `SQLITE_DENY` 整句拒绝，或对某列 `SQLITE_IGNORE`（读成 NULL，实现列级隐藏）；官方示例就是「除 SELECT 外一律拒绝」。注意：只在 prepare 时检查；schema 变更后 `step()` 时可能重新 prepare，要保持 authorizer 在位；每连接只有一个。
- `SQLITE_DBCONFIG_DEFENSIVE`；`sqlite3_limit()` 收紧 SQL 长度、表达式深度、`ATTACH=0` 等；`sqlite3_progress_handler()` / `sqlite3_interrupt()` 限时；`sqlite3_hard_heap_limit64()` 限内存；`trusted_schema=OFF`。
- 再叠加只读连接（`SQLITE_OPEN_READONLY`，未单独核实文档链接）。

**这套机制本身比 PGlite 的现状更适合做沙箱**：限时、限内存、每列授权都是引擎内建的。但「行级隔离」仍要 saveslot 在 SQL 层改写或用视图实现。

### 3.3 libSQL / Turso

- libSQL：Turso 维护的 SQLite fork，MIT；加了 `ALTER TABLE` 改列类型 / 约束、WASM UDF、虚拟 WAL、embedded replicas、libSQL server；README 写「仍积极维护，但新功能在 Turso 里开发」。
- Turso Database：Rust 从零重写的 SQLite 兼容引擎，**beta**，宣称并发写、双向同步离线。
  出处：[libsql README @ a1d031c](https://github.com/tursodatabase/libsql/blob/a1d031cb602fedefbcf55c568e98e998a2274400/README.md)、[docs.turso.tech](https://docs.turso.tech/)
- Turso Cloud：Free 100 个库，付费档「Unlimited」；「库像文件一样轻，创建几乎零成本」「闲置库只收存储费」。**Multi-DB Schemas（父库 schema 自动传播到子库）已对新用户弃用**，迁移期间所有库锁写。
  出处：[pricing](https://turso.tech/pricing)、[multi-db-schemas](https://docs.turso.tech/features/multi-db-schemas)
- 可借鉴：「每用户一个文件库」天然满足导出 / 删除 / 每用户密钥；但 saveslot 若选 SQLite 方言，就和 PG 能力缺口绑定在一起。

---

## 4. 双引擎（托管 PG + 本地 SQLite/PGlite，一套方言）

### 4.1 常见做法

- **限定公共子集**：ORM / 查询构建器（Prisma、Drizzle、Knex 一类）按方言生成 SQL；应用层避开不可移植特性。代价是放弃 range/exclusion、RLS 等 PG 特性（通识，未逐一核实）。
- **转译**：sqlglot 支持 30+ 方言（Postgres、SQLite、DuckDB 为官方支持），MIT；但它自称「是转译器不是校验器」、解析宽松、「部分方言对可能缺支持」、遇到无法翻译的会**警告后尽力翻译**。
  出处：[sqlglot README @ b99f5d5](https://github.com/tobymao/sqlglot/blob/b99f5d58b1773276544b513e072273789cf2549a/README.md)
- **服务端 PG + 客户端 SQLite 的同步系统**（PowerSync）：客户端把同步来的行以 JSON 存在 `ps_data__<table>` 里，再用视图 `CAST(data ->> '$.col' AS TEXT)` 暴露——它**不翻译 SQL**，客户端就是另一套 schema。
  出处：[PowerSync client architecture](https://docs.powersync.com/architecture/client-architecture)

### 4.2 真实项目的结局

- **Ghost**：生产环境「MySQL 8 is the only supported database」，理由是小团队要「收窄官方支持的环境以保持可维护」；SQLite 只出现在「旧安装迁走」的语境里。出处：[Ghost docs](https://docs.ghost.org/faq/supported-databases/)
- **Synapse（Matrix）**：提供 `synapse_port_db` 把 SQLite 实例迁到 PostgreSQL，迁移后磁盘可能多占 25%–100%。出处：[Synapse postgres docs](https://element-hq.github.io/synapse/latest/postgres.html)

### 4.3 对 saveslot 的特殊坑

- saveslot 的受限 SQL **是对外接口**（Agent 写派生规则、只读查询），不是内部实现。双引擎意味着同一条 Agent 写的 SQL 在本地和托管可能结果不同（`numeric` vs 浮点、时区、排序规则、空值排序、整数除法），而 saveslot 的派生表要求「重放结果确定」——**双引擎直接破坏可重放这条不变量**。
- 用 PGlite 做本地版就是「单方言、双宿主」：方言一致，差异只剩宿主行为（超时、持久性、角色），这些都在 saveslot 内核可控范围里。

---

## 5. 托管多租户

### 5.1 三种模式

| 模式 | 适配 saveslot 的点 | 风险 / 上限 |
|---|---|---|
| **共享表 + `tenant_id` + RLS** | 连接池友好、catalog 小、运维最简单；PG 的 RLS 默认拒绝、owner/超级用户绕过需 `FORCE` [PG RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) | **与 saveslot 的「用户自定义 schema」冲突**：每个用户表结构不同，共享表只能存成 JSONB/EAV，失去类型、约束、range/exclusion、派生 SQL 的直接性；单用户导出 / 删除要在大表里按 tenant 扫 |
| **schema-per-user**（同一 database 内每用户一个 schema） | 每用户真表；`pg_dump -n` / `DROP SCHEMA` 做单用户导出删除；连接池可共享（`search_path` 或全限定名） | catalog 膨胀：实践经验通常认为几百到几千个 schema 尚可；17,000 schema 的案例中 autovacuum、备份、catalog 锁、升级都失常；早年 20,000+ schema 时 `pg_dump` 有二次方行为。出处（均为经验报告，非官方基准）：[Command Prompt 案例](https://www.commandprompt.com/about/success-stories-case-studies/from-unrecoverable-to-under-control-taming-multi-tenant-postgresql-at-17000-schemas/)、[pgsql-performance 邮件](https://www.postgrespro.com/list/id/CAFwQ8rdZ3LjiwdDuzNR3vN=OryQ6fzDb08hzeKzNbOzrQXNPbA@mail.gmail.com)。每个 backend 缓存所访问表的 relcache，内存随「连接数 × 表数」增长——**量级未核实** |
| **database-per-user**（同集群多 database，或 Neon 每用户一个 project） | 隔离最强；Neon 每 project 独立 compute、独立 PITR；「有用户一个工程师管几十万 project」；Free/Launch 100 project，Scale 1000（软上限可提）；闲置 5 分钟缩到零，唤醒「几百毫秒」 | 同集群多 database：每个连接只能连一个 database，连接池按 database 分裂（通识，未核实具体数字）；Neon：供应商绑定、冷启动延迟、跨用户运维（迁移 schema 版本）要扇出到每个 project。出处：[Neon multitenancy](https://neon.com/docs/guides/multitenancy)、[plans](https://neon.com/docs/introduction/plans)、[scale-to-zero](https://neon.com/docs/introduction/scale-to-zero) |

### 5.2 saveslot 的特殊约束

- **表数量是「用户数 × 每用户 schema 数 × 每张表的附属关系」**：每张基础表还有版本表、派生缓存、索引、TOAST——一个活跃用户可能是几十到上百个 relation。
  所以 catalog 的天花板比「schema 数」更早到来；必须分 cell（每个 PG 集群 / database 只放有限用户），上限由 spike 测出。
- **每用户加密密钥**：核心 PG 没有 TDE 或每库密钥，只有 pgcrypto（密钥会短暂出现在服务器上）、磁盘加密、客户端加密。
  出处：[PG encryption options](https://www.postgresql.org/docs/current/encryption-options.html)
  → saveslot 的「按条 / 按 thread 加密 + 销毁密钥即删除」本就该在应用层做（信封加密，用户密钥存 KMS），与租户模型正交。
- **导出 / 本地 ↔ 托管迁移**：物理格式（PGlite `dumpDataDir`、`pg_dump`）都绑定版本 / 宿主；saveslot 的应用层日志（源数据 + change_log 哈希链）可重放重建有模型数据——**导出格式应是 saveslot 日志 + schema 定义，物理快照只做加速**。这样租户模型怎么选都不影响「可退出」。
- **噪声邻居**：受限 SQL 是不可信负载，必须 `statement_timeout` + 只读角色 + 资源上限；schema/db-per-user 不解决 CPU 争用，只能靠超时、并发配额，或把重度用户迁到独立 cell。

### 5.3 推荐的托管租户模型

**schema-per-user + cell 分片**（每个 cell 是一个 PG database，放 N 个用户，N 由 spike 定），理由：

1. 每用户真表，与本地版的表结构完全相同（本地 PGlite 就是「只有一个用户的 cell」），一套 DDL 生成代码；
2. 单用户导出 / 删除 / 迁到别的 cell 都是 schema 粒度操作；
3. 连接池可在 cell 内共享（Neon project-per-user 做不到这点）；
4. 保留升级路径：大客户或合规需求单独给一个 database / 一个 Neon project，因为单元边界本来就是「一个用户的全部 schema」。

不选共享表 + RLS：与用户自定义 schema 冲突（见 5.1）。暂不选 Neon project-per-user 为默认：自托管版无法复用（saveslot 要求核心能力不能只在托管版有），但可作为托管侧的「cell 实现之一」再评估。

---

## 6. 决策矩阵

评分：✓ 满足 / △ 需补工 / ✗ 不满足。

| 维度 | PGlite（本地）+ 原生 PG（托管/自托管） | 内置原生 PG（三处都用） | SQLite/libSQL（本地）+ PG（托管） | SQLite/libSQL（三处都用，托管每用户一库） | DuckDB |
|---|---|---|---|---|---|
| 同一方言 / 同一引擎 | ✓ | ✓ | ✗（两套语义） | ✓ | ✓ |
| saveslot 数据模型（range、exclusion、numeric、窗口） | ✓ | ✓ | △ | ✗ | △ |
| 本地「无需安装 DB 服务」 | ✓ | △（打包子进程，上百 MB） | ✓ | ✓ | ✓ |
| 本地持久性 | △（fsync 关、无锁，需 spike） | ✓ | ✓ | ✓ | ✓ |
| 只读沙箱：超时 | △（只能杀 Worker） | ✓ | ✓/✓ | ✓ | △ |
| 只读沙箱：权限 | △（角色可逃逸，全靠 AST） | ✓（角色 + AST） | △ | △（authorizer） | ✗ |
| 托管多租户成熟度 | ✓（PG 生态） | ✓ | ✓ | △（Turso 托管 / 自建） | ✗ |
| 每用户导出 / 删除 | ✓（schema 粒度 + 日志重放） | ✓ | △ | ✓（文件粒度） | — |
| 许可 / 成熟度 | ✓ 许可；△ 0.x | ✓ | ✓ | ✓/△（Turso Rust 为 beta） | ✓ |

## 7. 推荐策略

| 部署 | 引擎 | 说明 |
|---|---|---|
| 本地桌面 | **PGlite（NodeFS）嵌在 saveslot 进程里**；降级路线：embedded-postgres 子进程 | saveslot 进程独占数据目录（自加 pid 锁）；所有请求在 saveslot 内排队；受限 SQL 在独立 Worker 中执行，超时杀 Worker；写入路径定期做 checkpoint / 快照（具体策略看 spike 1） |
| 自托管 | **原生 PostgreSQL（Docker 镜像 / 用户自有 PG）** | 与托管同一套代码；默认单 cell |
| 托管 | **原生 PostgreSQL，schema-per-user，按 cell 分片** | 应用层信封加密；大户可独立 cell；Neon 作为 cell 的备选实现 |

跨部署共同规则：

- **受限 SQL 的主防线是 AST 白名单**：用 libpg_query（PG 自己的解析器抽出的库，[pganalyze/libpg_query](https://github.com/pganalyze/libpg_query)）解析，只放 `SELECT`/CTE/窗口函数和白名单函数，显式禁掉 `SET`/`RESET`/`set_config()`/`pg_read_file` 一类与所有 DDL/DML；表名重写成全限定名指向该用户 schema。原生 PG 上再叠只读角色（非超级用户的 session user）+ `default_transaction_read_only` + `statement_timeout`（[PG 文档](https://www.postgresql.org/docs/current/runtime-config-client.html)）。
- **导出格式 = saveslot 日志 + schema 定义**；物理快照只做加速，不做跨宿主承诺。
- **派生表同事务刷新由 saveslot 内核做**（解析出依赖、在写事务里增量 / 全量重算），`pg_ivm` 只作为可选加速——它在 PGlite 有包，在托管 PG 上需自行安装扩展（很多托管 PG 服务不允许任意扩展，未逐一核实）。

## 8. 必做 spike

1. **PGlite 持久性**：在 NodeFS 上循环写入，`kill -9` / 虚拟机断电后能否打开、已确认的提交丢多少；对照 issue #1107。若不达标，评估：自定义带 fsync 的 VFS、定期 `CHECKPOINT` + 文件级快照、或切换到 embedded-postgres。
2. **PGlite 沙箱**：Worker 隔离 + 超时终止的 p50/p99 开销、反复终止后的数据目录完整性（≥1000 次）；用 fuzz SQL 测 AST 白名单能否挡住 `SET ROLE`、`set_config`、`COPY`、`DO`、`LISTEN` 等。
3. **schema-per-user 容量**：单个 PG 18 database 里放 1k / 5k / 20k 个用户 schema（每用户约 50–150 个 relation），测 catalog 大小、backend RSS、DDL 延迟、`pg_dump -n` 耗时、autovacuum 行为，定出 cell 上限。
4. **派生表同事务刷新**：典型 schema（10 张基础表 + 20 条派生规则、10 万行）下单次写入延迟，PGlite 与原生 PG 对比；有无 `pg_ivm` 对比。
5. **本地 ↔ 托管迁移**：用 saveslot 日志在 PGlite 与原生 PG 之间双向重放，校验派生结果逐行一致（数值、时区、排序规则）。
6. **打包体积与平台**：Electron/Tauri 中 PGlite 的冷启动、内存占用；embedded-postgres 在 macOS 公证、Windows 上的可行性。

## 9. 未决风险

- PGlite 仍是 0.x，单人桌面以外的用法（多进程、多连接）都在开发中；ElectricSQL 的投入方向变化会直接影响 saveslot 本地版。
- PGlite 的 WASM 运行在 JS 线程上：saveslot 若用 Go/Rust 写内核，嵌入 PGlite 需要 JS 运行时（Node/Bun/Deno 或 wasmtime 跑 emscripten 产物——后者**未核实可行**）。这可能反过来约束 saveslot 内核的语言选择。
- 托管侧 schema-per-user 的上限只有经验报告，没有官方基准；saveslot 的「每张表带版本表 + 派生缓存」让 relation 数比一般 SaaS 高一个量级。
- 自定义扩展（`periods`、自研函数）要在 PGlite 和托管 PG 两边都能装，托管服务商的扩展白名单会成为约束；稳妥做法是核心逻辑不依赖扩展。
- `numeric` 与浮点、时区、collation 在不同 PG 构建（PGlite 有 ICU 选项、原生 PG 的 libc collation）之间可能有排序差异，影响派生结果可重放——需在 spike 5 中覆盖。
