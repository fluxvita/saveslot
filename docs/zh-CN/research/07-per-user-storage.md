# 07 · 托管：每个用户独立存储

> 调研日期 2026-11-09。要回答的问题：DRAFT「待定」里的「托管：每个用户独立存储」站不站得住，用什么方式实现，单集群能放多少用户，超了怎么办。
> 前置：[05-storage-tenancy.md](05-storage-tenancy.md)（引擎选型与租户模型）、[04-online-ddl.md](04-online-ddl.md) §6–7.3（catalog 规模风险）。
>
> 写法约定：每条事实附出处；GitHub 链接尽量钉到 commit。标「**实测**」的是本次在本机跑的实验（环境见 §9），
> 标「**未核实**」的是推断或没找到一手来源。引用的数字和实测的数字分开写，不混用。

## 0. 结论先行

1. **「每用户独立存储」成立，但要说清是哪一种。** 推荐的实现是：**托管与多用户自托管都用「同一 PostgreSQL 集群里每用户一个 database」，按集群分 cell，每个 cell 设用户库上限**；
   本地仍是「一个 PGlite 数据目录 = 一个用户」。三处共用同一个抽象：`openUserStore(userId)` 拿到一个连接，连接里看到的是**只属于这个用户的一整套 saveslot 表，表名不带用户前缀**。
2. **连接问题是真问题，但对 saveslot 不致命。** 连接确实不能跨库复用（PgBouncer、Supavisor 都按库建池，见 §2.3），所以「每个同时活跃的用户至少占一个后端进程」。
   但 saveslot 每个用户的写本来就串行（一把锁），一个用户一条连接就够；需要的后端数 ≈ **同时活跃的用户数**，不是总用户数。
   实测（1,000 与 5,000 库两档结果相近）：连一个没碰过的用户库 p50 **7–8 ms**，在冷连接上跑完一次典型请求（读目录 + 10 次查询 + 一个写事务）p50 **17–20 ms**，热连接 **1–5 ms**；每个后端私有内存恒定约 **2.5 MB**，与集群里有多少库无关（§2.2）。
   saveslot 自己做一个按用户的连接管理器（LRU + 全局上限 + 用户粘到固定的 saveslot 节点）即可，不需要 PgBouncer。
3. **真正的上限来自集群级的「每库固定开销」，不是连接：**
   - autovacuum launcher 要轮询每个库：最短每 100 ms 拉起一个 worker，N 个库每个库最快 N/10 秒被看一次；邮件列表里 2,000 库时 Tom Lane 已建议改 schema，15,000 库时 launcher 吃满一个 CPU（§2.1）。
   - 每个库一套系统目录：空库 **7.7 MB**、带上 saveslot 的 50 张表 **13 MB**（实测），1 万用户 ≈ 130 GB 纯开销。
   - PITR 只能整集群；`pg_internal.init` 每次重启后每个库都要重建。
   - **文件数拖慢启动**（实测，macOS）：5,000 库 = 300 万个文件，干净启动 7.4 s，**kill -9 后崩溃恢复 212 s**（逐文件 fsync 占 184 s，redo 只有 3 s）；Linux 的 `syncfs` 选项可能大幅缩短，未实测。
   - 闲置 CPU（实测）：5,000 库全部有统计信息时约 0.2 核，这是 launcher 跑满 10 次 / 秒后的「固定税」，再加库主要是拉长每个库的 vacuum 间隔。
   **建议每个 cell 起步上限 2,000 个用户库，压测后可放宽到 5,000**；超了就开新 cell（加集群），而不是把一个集群撑大。扇出升级 saveslot 系统表实测 5,000 库 / 8 并发 27 s，不是瓶颈。实测数据见 §2.2。
4. **闲置用户的成本靠「分层」解决，不靠数据库本身。** 长期不活跃的用户库可以整库导出（saveslot 日志 + 快照）后从集群里删掉，下次访问再恢复——这样 cell 里只放「近期活跃」的用户，
   上限按活跃用户算。这条依赖 saveslot 的「导出 = 日志 + schema」原则（05 §5.2），已有基础。
5. **不推荐托管侧跑服务端 PGlite（每用户一个数据目录按需加载）。** 实测一个 Node 进程开第一个实例 RSS 涨 **~785 MB**，之后每个约 **47 MB**（第 10–40 个的平均），打开 60–100 ms；
   再加上 fsync 默认关、没有数据目录锁、单连接、`statement_timeout` 不生效、WASM 跑在 JS 线程上一条慢查询堵住整个进程（05 §1），作为托管存储不合格（§3）。
6. **schema-per-user（05 的原推荐）降为备选，不作默认。** 它的唯一优势是连接可共享；代价是一个库里几十万个 relation（实测 1,000 用户 = 22.7 万行 `pg_class`）、共享连接的缓存随服务过的用户数线性增长且不释放（实测一条连接服务 1,000 个用户后私有内存 177 MB，见 §4）、单用户导出 / 删除 / 迁移不再是「整份操作」、与本地布局不同构。
   如果压测发现 database-per-user 每 cell 撑不到 1,000，再退回 schema-per-user。
7. **托管服务商作为 cell 的备选实现，不作默认**：Neon 官方推荐 project-per-tenant，但 Scale 档默认 1,000 project（软上限）、同时活跃 compute 默认 20 个，且没有官方自托管（§5.1）；
   Nile 是共享表 + `tenant_id`，不支持每用户自定义表（§5.2）；Supabase 每个 project 是独占实例，每租户每月至少约 $10（§5.6）。

---

## 1. 问题重述与判据

saveslot 的托管负载有几个和普通 SaaS 不同的特点（来自 [DRAFT.md](../spec/01-positioning.md)、[data-model.md](../spec/03-data-model/README.md)）：

- **每个用户的表结构都不一样**，而且会演进：每个用户 = saveslot 系统表（日志、change_log、目录、待处理事项……）+ 用户自定义基础表 + 版本表 + 派生缓存，几十到上百个 relation；迁移中还要 ×2。
- **每个用户的数据很小**（几千到几百万行）；**每个用户一条日志、一套序号、一把串行写锁**。
- **Agent 从不直连数据库**：所有访问经 saveslot 服务端，逻辑表名由 saveslot 解析到物理表。所以「连接」是 saveslot 内部资源，不暴露给外部。
- **自托管要跑同一套核心**，不能有只在托管版才有的核心能力。

所以判据是：**隔离、连接模型、单集群上限、闲置成本、冷启动、全量运维（升级 saveslot 系统表）、单用户备份 / 恢复、自托管同构、许可 / 供应商风险、成熟度**。

## 2. 方案 A：同一集群里每用户一个 database

### 2.1 引用的事实

**硬上限与集群级行为**

- 单集群 database 数上限 4,294,950,911，单库 relation 上限 1,431,650,303；文档原话「practical limits, such as performance… may apply before absolute hard limits are reached」。[PG limits](https://www.postgresql.org/docs/current/limits.html)
- **autovacuum 按库轮询**：「attempting to start one worker within each database every autovacuum_naptime seconds. (Therefore, if the installation has N databases, a new worker will be launched every autovacuum_naptime/N seconds.)」[routine-vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- 源码里 launcher 的最短睡眠是 `MIN_AUTOVAC_SLEEPTIME 100.0` 毫秒，所以每秒最多拉起约 10 个 worker；有库面临 XID wraparound 时优先挑 `datfrozenxid` 最老的库；不在 pgstats 里的库只在 wraparound 时才会被挑中。
  [autovacuum.c @ REL_18_0 3d6a828](https://github.com/postgres/postgres/blob/3d6a828938a5fa0444275d3d2f67b64ec3199eb7/src/backend/postmaster/autovacuum.c)
  → 推算（非实测）：N 个库时每个库最快每 N/10 秒被检查一次——2,000 库约 3.3 分钟，5,000 库约 8.3 分钟，1 万库约 17 分钟。saveslot 每库数据小，这个频率本身够用；问题在于 launcher / worker 的 CPU 一直不停。
- 防 wraparound 的 vacuum 即使关掉 autovacuum 也会强制执行——每个库，包括闲置的库，都要 freeze。[routine-vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- 一手报告：
  - 2009，约 2,000 个库：Tom Lane「autovac is going to be spending quite a lot of time just finding out whether it needs to do anything」，建议「one database… and 2000 schemas」，否则调大 naptime。[pgsql 邮件](https://www.postgresql.org/message-id/6357.1243277706%40sss.pgh.pa.us)
  - 2018，约 15,000 个库：launcher 吃满 CPU，naptime 调到 50 分钟也没用；Tom Lane「even at 50min, the launcher will have to launch one worker every 0.2 seconds」「you're expending ~100GB just on redundant copies of the system catalogs」。[pgsql 邮件](https://www.postgresql.org/message-id/24641.1528472473%40sss.pgh.pa.us)；
    同线程 Jeff Janes「if you want to have 15,000 databases, you should just resign yourself to having one CPU dedicated to this task」。[pgsql 邮件](https://www.postgresql.org/message-id/CAMkU%3D1z3swfd7V%2BBTjDgLkxEhQ3TTf-puQMm8MVE1%3Dah3u9M6w%40mail.gmail.com)
- **CREATE DATABASE**：PG15+ 默认 `STRATEGY WAL_LOG`（逐块写 WAL，模板小时最高效）；`FILE_COPY` 写 WAL 少但「forces the system to perform a checkpoint both before and after」；复制期间模板库不能有其他连接。[sql-createdatabase](https://www.postgresql.org/docs/current/sql-createdatabase.html)
- **PITR 只能整集群**：「can only support restoration of an entire database cluster, not a subset」。单库恢复只能靠 `pg_dump` 逻辑备份。[continuous-archiving](https://www.postgresql.org/docs/current/continuous-archiving.html)
- **`pg_internal.init`**：每个库目录各一份 relcache 初始化文件；postmaster 启动时删掉全部，注释「expect the first backend launch to rebuild them. Of course, this has to happen in each database of the cluster.」——重启 / 崩溃恢复后每个库的第一个连接都更慢。
  [relcache.c @ REL_18_0](https://github.com/postgres/postgres/blob/3d6a828938a5fa0444275d3d2f67b64ec3199eb7/src/backend/utils/cache/relcache.c)
- **统计信息**：累积统计在共享内存里按对象一行；非干净关机、base backup 或 PITR 启动后「all statistics counters are reset」——结合上面的 launcher 逻辑，统计清零后库要重新出现在 pgstats 里才会被常规 autovacuum 看到。[monitoring-stats](https://www.postgresql.org/docs/current/monitoring-stats.html)
- `max_files_per_process` 默认 1000，每个后端进程限制，只能启动时设。[runtime-config-resource](https://www.postgresql.org/docs/current/runtime-config-resource.html)

**连接**

- 一个连接只属于一个 database（libpq 连接串的 `dbname` 语义；所有 pooler 都按库分池可以佐证，下见）。文档原句**未核实**。
- 连接内存：Andres Freund 实测 `ps` 看到的 RSS 有误导性（约 16.9 MB）；按 Pss_Anon + 页表算，`huge_pages=off` 约 7.6 MiB/连接，`huge_pages=on` 约 1.3 MiB，结论「less than 2MiB」。
  [anarazel 2020-10-07](https://blog.anarazel.de/2020/10/07/measuring-the-memory-overhead-of-a-postgres-connection/)
- 闲置连接拖慢活跃连接（瓶颈 `GetSnapshotData()`，PG14 已改进）：单活跃连接 0 闲置 33,457 TPS → 1 万闲置 14,496 TPS。
  [Microsoft TechCommunity 2020-10-08](https://techcommunity.microsoft.com/blog/adforpostgresql/analyzing-the-limits-of-connection-scalability-in-postgres/1757266)
  → 对 saveslot：LRU 要主动关闭闲置连接，不要囤几千条。
- PG18 新增 `log_connections = setup_durations`，可分别记录 fork、认证、总耗时。[runtime-config-logging (18)](https://www.postgresql.org/docs/18/runtime-config-logging.html)

### 2.2 实测

见 §9 的环境说明。模板库 = saveslot 的 50 张表（10 张系统表 + 20 张基础表 + 20 张派生表，PK + 二级索引 + TOAST，共 227 个用户 relation；每库 `pg_class` 642 行），基础表每张 200 行、日志几千行。
每个用户库 = `CREATE DATABASE u_i TEMPLATE xtpl`。

**建库与磁盘**

| 项目 | 1,000 库 | 5,000 库 |
|---|---|---|
| `CREATE DATABASE … STRATEGY wal_log` 单库耗时 | p50 96 ms（前 40 个 p50 65 ms） | 第 1,001–5,000 个：p50 89 ms、p90 110 ms，4,000 个共 364 s |
| `STRATEGY file_copy`（对照，20 个） | p50 44 ms，但有一次 1.8 s（前后各一次 checkpoint） | — |
| 每库磁盘 | 空模板 `template1` 7.7 MB；带 saveslot 表的库 13 MB | 集群共 64 GB，`base/` 下 3,076,814 个文件（约 615 个 / 库） |

**连接与请求延迟**（每次随机挑 300 个从未连过的库，依次连接并保持；数据都在 OS 页缓存里）

| 项目 | 1,000 库 | 5,000 库（刚重启） | 5,000 库（kill -9 崩溃恢复后） |
|---|---|---|---|
| 新建连接（含认证，Unix socket） | p50 8.4 / p99 18.5 ms | p50 7.1 / p99 10.3 ms | p50 7.5 / p99 10.5 ms |
| 冷连接上的第一次典型请求 | p50 20.0 / p99 48.3 ms | p50 16.7 / p99 24.1 ms | p50 17.3 / p99 24.5 ms |
| 热连接上的典型请求 | p50 5.1 ms | p50 1.1 / p90 4.5 ms | — |
| 重连已访问过的库 + 一次请求 | p50 11.7 ms | p50 11.0 ms | — |

- 冷请求比热请求多出的 ~12–15 ms 主要是该库的 catalog 缓存预热（首次打开 50 张表的 relcache / catcache）；**库的总数从 1,000 到 5,000 对单次连接延迟没有可见影响。**
- 写事务含 `fsync=on` 的提交；macOS 上 fsync 很便宜（F_FULLFSYNC 未启用），Linux 云盘上热请求的提交延迟会更高（**未核实**具体值）。

**内存**（保持 300 条连接、每条跑过一次典型请求后）

| 项目 | 1,000 库 | 5,000 库 |
|---|---|---|
| 每后端私有内存（`pg_backend_memory_contexts` 合计） | 2.55 MB | 2.53 MB |
| 其中 CacheMemoryContext 子树 | 1.27 MB | 1.27 MB |
| 每后端 `ps` RSS（含碰过的 shared_buffers 页，偏高） | p50 18.1 MB | p50 17.4 MB |

- 每个后端只缓存自己那个库的 catalog，所以私有内存与集群里有多少个库无关，也不会随时间累积——这是和方案 C（§4）最关键的差别。

**集群级开销**

| 项目 | 1,000 库 | 5,000 库 |
|---|---|---|
| 干净关机 | 1.3 s | 1.0 s |
| 干净启动（`pg_ctl start -w`） | 0.37 s | **7.4 s** |
| kill -9 后启动（崩溃恢复） | 未测 | **212 s**：遍历 300 万个文件做 pre-fsync 约 97 s + fsync 约 87 s，真正 redo 只有 2.8 s（212 MB WAL），end-of-recovery checkpoint 6 s |
| 闲置时 postgres 进程 CPU（所有库都有统计信息后） | 未测（见注） | 180 s 内存活进程累计 35 s CPU，约 0.2 核；launcher 自身 `ps` 显示 12.6% 一个核 |

- 注：1,000 库那次测的 0.7 s CPU / 60 s 不可比——当时大多数库从没被连过、不在 pgstats 里，launcher 会跳过它们（§2.1 源码）。5,000 库这次是在扇出升级（下表）碰过每个库之后测的。
  短命的 autovacuum worker 退出后其 CPU 不再计入 `ps`，所以 0.2 核是下界。
- 推算（非实测）：N 超过 `autovacuum_naptime`/100 ms = 600 后，launcher 已经按 10 次 / 秒的最高频率拉 worker，CPU 基本不再随 N 增长，增长的是「每个库多久被看一次」（5,000 库 ≈ 8 分钟）。
  所以 autovacuum 的 CPU 是一个「cell 固定税」（约 0.2 核量级），真正随 N 恶化的是覆盖间隔和 wraparound 风险。
- **崩溃恢复的 212 s 是本次最值得注意的数字**：PG 在崩溃恢复前默认逐个 fsync 整个数据目录（`recovery_init_sync_method = fsync`），耗时与文件数成正比；
  Linux 上可设 `syncfs` 改为按文件系统整体同步（PG14+，[runtime-config-error-handling](https://www.postgresql.org/docs/current/runtime-config-error-handling.html)），macOS 不支持，故本次没法测（Linux 上的实际耗时**未核实**）。
  干净启动的 7.4 s 也随文件数增长（启动时要遍历每个库目录清理临时文件与 `pg_internal.init`）。

**全量运维：扇出升级 saveslot 系统表**（每库：连接 → 一个事务里 `CREATE TABLE IF NOT EXISTS saveslot_meta` + `ALTER TABLE change_log ADD COLUMN` + `CREATE INDEX` + 写版本号 → 断开）

| 项目 | 结果 |
|---|---|
| 5,000 库，8 并发 | 总 27.3 s；单库 p50 41.6 / p99 70.4 ms |
| 1,000 库，串行，已是新版（只做幂等检查） | 总 16.5 s；单库 p50 12.4 ms |

→ 一次 saveslot 系统表升级扇出到 5,000 个用户库是**半分钟级**操作；1 万库、几十个 cell 并行也只是分钟级。扇出本身不是瓶颈，难点是「N 与 N−1 版本共存」的代码纪律（§7.3）。


### 2.3 连接池：现成 pooler 都按库分池

- **PgBouncer**：`default_pool_size` 默认 20，「per user/database pair」；`max_db_connections` 按库、`max_user_connections` 按用户，默认不限；不同库之间不复用 server 连接；
  文件描述符上限估算「max_client_conn + (max pool_size * total databases * total users)」；`*` 回退库按需建池，闲置超过 `autodb_idle_timeout`（默认 3600 s）释放；`server_idle_timeout` 默认 600 s。没有限制库数量的参数。
  [pgbouncer config](https://www.pgbouncer.org/config.html)
  事务池模式下 `SET`、SQL 级 `PREPARE`、会话级 advisory lock 不可用，事务级 `pg_advisory_xact_lock` 可用。[pgbouncer features](https://www.pgbouncer.org/features.html)
- **Supavisor**（Supabase，Elixir）：池 ID 是 `(type, tenant, user, mode, db, search_path, upstream_tls)`，每个组合一个池，用 `syn` 做集群内注册；**每个 tenant 最多 50 个池**（`@max_pools … 50`，超出报 `MaxPoolsReachedError`）。
  [supavisor.ex @ db20378](https://github.com/supabase/supavisor/blob/db203781ccb48d517c184a2904de1b828147c9d4/lib/supavisor.ex)、[mix.exs @ db20378](https://github.com/supabase/supavisor/blob/db203781ccb48d517c184a2904de1b828147c9d4/mix.exs)
  基准：2 台 64 核扛 1,003,200 客户端连接、背后 400 条数据库连接；压的是**客户端连接数**，不是库的数量。[Supabase blog 2023-08-11](https://supabase.com/blog/supavisor-1-million)
  → 对 saveslot：Supavisor 解决的是「海量客户端连少量库」，saveslot 的问题正相反（一个客户端——saveslot 服务端——连海量库），它帮不上忙；一个实例上几千个用户库要么各配一个 tenant，要么撞 50 池上限。
- **PgDog**：「物理多租户」= 每租户一个库，本质是分片路由，库要逐个在配置里声明；list 映射号称「supports millions of tenants」，池结构与库数上限文档没写。
  [PgDog multi-tenancy](https://docs.pgdog.dev/features/multi-tenancy/)、[PgDog blog 2025-05-14](https://pgdog.dev/blog/multi-tenant-pg-can-be-easy)
- **结论**：外部 pooler 对 saveslot 没有额外价值——saveslot 服务端是唯一客户端，它自己知道哪个用户活跃、写锁在哪，应用层连接管理器（§7.2）就是一个「懂业务的 pooler」。

**先例**

- Heroku Essential（原 Hobby）档：「many databases reside on the same Postgres cluster」，用户能看到彼此的库名和会话；每台机器多少库没有公开（**未核实**）。
  [Heroku help](https://help.heroku.com/NYMRTXEG/why-am-i-seeing-information-about-other-postgresql-processes-or-databases-that-aren-t-related-to-my-heroku-postgres-essential-database)
- Neon 单个 branch（即一个 compute）最多 500 个 database，2024-10-04 起强制执行——可以看作一家专门做 PG 托管的公司给「一个实例里放多少库」划的线。
  [Neon changelog 2024-10-04](https://neon.com/docs/changelog/2024-10-04)、[Neon manage databases](https://neon.com/docs/manage/databases)

## 3. 方案 B：服务端 PGlite，每用户一个数据目录按需加载

### 3.1 有没有人这么做

- PGlite 官方是单连接（单用户模式编译）；同一连接串接第二个客户端会报「too many clients」。[Supabase database.build live share](https://supabase.com/blog/database-build-live-share)
- `pglite-socket` 把 PGlite 包成 PG wire 服务器，靠多路复用排队，默认最大连接 1，不支持 SSL。[pglite-socket](https://github.com/electric-sql/pglite/tree/main/packages/pglite-socket)（未钉 commit）；已知并发问题见 05 §1.4。
- PGlite v0.4 发布文把「Multi-instance — true multi-connection support」列为路线图，尚未交付（截至调研未见发布说明，**未核实**）。[Electric blog 2026-03-25](https://electric-sql.com/blog/2026/03/25/announcing-pglite-v04)
- 社区项目 `@namastexlabs/pglite-embedded-server`（pgserve）：单端口、每用户一个目录，README 称「100+ databases are practical」，无独立基准。[pgserve](https://github.com/namastexlabs/pgserve)（**未核实**生产可用性）
- 没找到 ElectricSQL 或任何托管商在生产中「服务端每租户一个 PGlite」的一手说明（**未核实** = 没找到）。Supabase 的 database.build 是浏览器内 PGlite，不是服务端。[Supabase blog](https://supabase.com/blog/postgres-new)

### 3.2 实测

同一个数据目录：saveslot 的 50 张表（同方案 A 的 DDL），基础表每张 5,000 行（共 10 万行）+ `change_log` 10 万行 + `source_log` 2 万行；`pg_database_size` 49 MB，目录总大小 146 MB（含 WAL），1,288 个文件。
首次 `PGlite.create`（含 initdb）685 ms，建表加灌数 1.3 s。

| 项目 | 结果 |
|---|---|
| 新进程里打开已有目录（5 次） | 97–99 ms |
| 打开后第一次典型请求 | 20–21 ms |
| 热请求 | 2.9–3.2 ms |
| `close()` | 3.6–4.1 ms |
| 新进程打开第一个实例后 RSS 增量 | **约 785 MB**（WASM 模块编译 + 实例内存；PGlite 默认 `initialMemory` 为 2048 页 × 64 KB = 128 MB，上限 2 GB，见包内 `dist/index.js`） |
| 同一进程依次打开 40 个实例（各跑一次请求） | RSS：1 个 838 MB → 10 个 1,915 MB → 40 个 3,324 MB；第 10–40 个平均每个 **约 47 MB**，前 10 个平均约 120 MB；后续实例打开 60–86 ms |
| 关闭全部 40 个后 | RSS 仍 2,924 MB（内存没有立即还给系统） |
| 单实例反复 open → 请求 → close 200 次（每 25 次强制 GC） | RSS 762 → 860 MB，前 175 次每次约 +0.5 MB，之后持平；未见明显泄漏 |

推算（非实测）：24 GB 的机器单进程大约能同时开 300–400 个这样的实例；托管要按「同时活跃用户」开实例，比原生 PG 每后端 ~2.5 MB 私有内存高一个数量级以上。
持久性、单连接、`statement_timeout`、角色逃逸的问题见 05 §1.3–1.6，这里不重复。

### 3.3 和方案 A 对比

| | 原生 PG，每用户一个 database | 服务端 PGlite，每用户一个目录 |
|---|---|---|
| 打开一个用户 | 连接 7–8 ms + 首个请求 17–20 ms（实测） | 打开 60–100 ms + 首个请求 20 ms（实测） |
| 每个活跃用户内存 | 后端私有 ~2.5 MB（实测）；引用值 <2 MiB（huge pages） | ~47 MB / 实例，进程底座 ~785 MB（实测） |
| 持久性 | fsync、WAL、崩溃恢复 | fsync 默认关、NodeFS 无真实 fsync（05 §1.3） |
| 并发 | 每用户可多连接，多核并行 | 单连接；WASM 在 JS 线程上，一个慢查询堵整个进程，除非一实例一 Worker |
| 超时 / 沙箱 | `statement_timeout`、只读角色 | `statement_timeout` 不生效，只能杀 Worker（05 §1.6） |
| 备份 | WAL 归档 / PITR（整集群）+ 单库 dump | 文件级快照；`dumpDataDir` 只能导回 PGlite |
| 集群级固定开销 | autovacuum 轮询、目录副本 | 无（关掉就是一堆文件，闲置成本 = 磁盘） |

PGlite 唯一的结构性优势是「闲置 = 只有文件」，这正是 Turso / Durable Objects 的模型（§5.3–5.4）。但 saveslot 用方案 A + 冷用户分层（§7.4）可以拿到同样的效果，而不用承担 PGlite 的持久性和并发问题。

## 4. 方案 C：schema-per-user（同一 database，按 cell 分片）

**实测**：同一个 PG 18.6 集群里另建一个 `cell` 库，放 1,000 个 schema，每个 schema 是同一套 50 张表（与方案 A 相同 DDL，数据略少）。

| 项目 | 结果 |
|---|---|
| 建 1,000 个 schema（一 schema 一事务） | 54.6 s |
| 该库 `pg_class` 行数 | **227,415**（方案 A 每库 642） |
| 库大小 | 2,571 MB（其中大部分是 catalog） |
| 一条共享连接依次服务 N 个不同用户（每用户一次典型请求，触达 13 张表）后的后端私有内存 | 1 个用户 2.5 MB → 10 个 4.2 MB → 100 个 25.6 MB → 500 个 90.2 MB → **1,000 个 177 MB**（CacheMemoryContext 子树 146 MB） |
| 首次触达某用户的请求 p50 | 6.5 ms（OS 页缓存热时 3.1 ms） |

- **关键结论**：schema-per-user 的「连接可共享」是有代价的——每条共享连接都会把它服务过的每个用户的 relcache / catcache 留在自己内存里，PG 没有上限或淘汰机制（04 §6 的引用）。
  本次每用户只触达 13 张表就是 ~0.17 MB / 用户；触达全部 50 张表时按比例约 0.6 MB / 用户（推算）。100 条池化连接各自服务过 1,000 个用户 ≈ 18 GB。
  缓解办法是让连接定期退役（如每服务 200 个用户就重连），但那等于把「冷连接」成本又找了回来——和方案 A 的差距就只剩「少建几次连接」。
- 方案 A 里每条连接只装一个用户，私有内存恒定 2.5 MB（§2.2）。
- schema-per-user 剩下的优点：没有「每库一份系统目录」（但用户自己的 relation 照样都在 catalog 里，体量差不多）；autovacuum 只轮询一个库（但一个库里要扫 22 万个 relation）。
- 缺点照旧（05 §5.1、04 §6）：17,000 schema 的事故案例、`pg_dump` 在超大 catalog 下变慢、单用户导出 / 删除 / 迁移是 schema 粒度而非整库、与本地 PGlite 的布局多了一层前缀。

## 5. 托管产品参考

### 5.1 Neon

- **官方推荐每用户一个 project**（而非每用户一个 branch，一般也不推荐 schema-per-user）：API 开通、计算按 project 独立伸缩、闲置缩到零、按用户 PITR、按用户选区域；有客户管理「数十万个 project」。页面更新于 2026-08-27。
  [Neon multitenancy](https://neon.com/docs/guides/multitenancy)
- **套餐上限**（2026-11-04）：Free / Launch 100 个 project；Scale 1,000（软上限，可申请提高）；每 project 的 branch 10 / 10 / 25。[Neon plans](https://neon.com/docs/introduction/plans)
- **同时活跃的 compute 默认上限 20 个**。[Neon glossary](https://neon.com/docs/reference/glossary)
- **价格**：Launch $0.106 / CU-h，Scale $0.222 / CU-h，存储 $0.35 / GB-月；没有月最低消费，也不按 project 收费。[Neon pricing](https://neon.com/pricing)
- **缩到零**：闲置 5 分钟；付费档可调（Scale 1 分钟到常开）；恢复「几百毫秒内」，没有更精确的官方数字。[scale-to-zero](https://neon.com/docs/introduction/scale-to-zero)
- **连接**：内置 PgBouncer（事务模式），客户端连接上限 1 万，池按「用户 + 数据库」各一个；max_connections 0.25 CU 是 104、1 CU 是 419，9 CU 以上封顶 4,000。[connection-pooling](https://neon.com/docs/connect/connection-pooling)
- **单个 branch 最多 500 个 database**。[Neon changelog 2024-10-04](https://neon.com/docs/changelog/2024-10-04)
- **开源与自托管**：仓库 Apache-2.0；README 描述 compute（无状态 PG）、pageserver、safekeeper，并只说可在本机跑来做实验 / 测试，**没有生产自托管的官方支持**。
  [neondatabase/neon](https://github.com/neondatabase/neon)（未钉 commit）、[讨论 #1828](https://github.com/neondatabase/neon/discussions/1828)；社区集成如 [Pigsty](https://pigsty.io/docs/kernel/neon)，非官方。
- 2025-05-14 Databricks 宣布收购 Neon（约 $10 亿），称 Neon 上超过 80% 的库由 agent 创建。[Databricks 新闻稿](https://databricks.com/company/newsroom/press-releases/databricks-agrees-acquire-neon-help-developers-deliver-ai-systems)
- **对 saveslot**：适合做「托管侧某些 cell 的实现」（大户、合规、要独立 PITR 的用户），不能做默认——自托管无法同构，同时活跃 compute 与 project 数都要和 Neon 谈；
  每个活跃用户至少 0.25 CU，按 Scale 价约 $0.056/小时活跃时间（推算）。

### 5.2 Nile（thenile.dev）

- **不是每租户一个库，而是共享表结构**：租户表带 `tenant_id`，主键形如 `(tenant_id, id)`；另有跨租户共享表。[tenant-isolation](https://www.thenile.dev/docs/tenant-virtualization/tenant-isolation)
- 隔离做在存储页上：「租户表的每个页只属于一个租户」；存算分离，页和日志归档到 S3；迁移租户 = 把它的 leader 换到另一个 compute，不搬页。[architecture](https://www.thenile.dev/docs/getting-started/architecture)
- DDL 由中央 schema store 用分布式事务推到所有租户——**每租户自定义表不在它的模型里**（文档未提及，这是推断）。同上。
- 开源：`niledatabase/niledatabase`（Apache-2.0）主要是文档 / 示例，SDK 为 MIT；改过的 PG 引擎是否开源、能否自托管**未核实**（看起来闭源）。[GitHub niledatabase](https://github.com/niledatabase)
- **对 saveslot**：「每页只属于一个租户 + 换 leader 即迁移」是好思路，但它解决的是「同构 schema 的大量租户」，与 saveslot「每个用户表结构都不同」正好相反，不可用。

### 5.3 Turso / libSQL

- 为「每用户 / 每 agent / 每租户一个库」设计，称能撑数百万轻量库，闲置库只收存储费；Free 100 库，Developer $4.99/月起库数不限。[turso.tech](https://turso.tech/)、[pricing](https://turso.tech/pricing)
- 便宜的原因：数据落 S3（近期写入先进 S3 Express），本地盘只是缓存；文件切成 128 kB 段懒加载，冷数据逐出；每租户本地缓存可设上限。[Turso blog 2025-05-20](https://turso.tech/blog/how-does-the-turso-cloud-keep-your-data-durable-and-safe)
- Multi-DB Schemas 对新用户已弃用。[docs](https://docs.turso.tech/features/multi-db-schemas)
- 2026-10-02 Supabase 宣布收购 Turso，称 Turso 单台服务器管数百万库、用到时加载、闲置时挂起。[Supabase blog](https://supabase.com/blog/supabase-is-acquiring-turso)
- **对 saveslot（SQLite 已否决，只取架构）**：「库 = 对象存储上的文件 + 本地缓存」让闲置成本趋近存储费；saveslot 对应的做法是 §7.4 的冷用户分层。

### 5.4 Cloudflare D1 / Durable Objects SQLite

- D1：付费账户每账户 100 万库（前 10 万含在套餐内，之后 $0.10/库/月），单库 10 GB 不可提高；官方推荐每用户 / 每租户一个库；**每个库同一时间只执行一条查询**，底层由一个 DO 承载。[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- DO SQLite：每个名字恰好一个对象（天然单写者），SQLite 与应用代码同线程；写入不阻塞执行，靠「output gate」扣住响应直到落盘确认；Storage Relay Service 把 WAL 同步给 5 个其他机房的 follower、3 个确认算提交，批量上传对象存储，PITR 30 天。
  [Cloudflare blog 2024-09-26](https://blog.cloudflare.com/sqlite-in-durable-objects/)
- 闲置约 10 秒休眠，约 70–140 秒被逐出，下次访问冷启动。[DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- **对 saveslot**：「每租户一个 actor、单写者、计算贴着数据、闲置逐出」与 saveslot「每用户一把写锁」完全同形——saveslot 的连接管理器应当把「一个用户的所有写」路由到同一个 saveslot 节点（§7.2），这就是 DO 的「每名字一个对象」。

### 5.5 Xata

- 新平台 2025-05 私测，核心 2026 年以 Apache-2.0 开源：K8s + CloudNativePG + OpenEBS/Mayastor，写时复制做在存储卷层，PG 不改；SQL gateway 负责唤醒，CNPG 插件做缩到零。
  [Xata 开源公告](https://xata.io/blog/xata-is-now-open-source)、[CoW branching](https://xata.io/blog/open-source-postgres-branching-copy-on-write)
- 多 cell / 多区域部署代码与自研存储 Xatastor 不开源；**官方明确不建议用 OSS 版对外提供 PG 即服务**（对抗性多租户的安全特性不全）。同上。
- **对 saveslot**：它是「每租户一个 PG 实例」路线，需要 K8s 与存储卷 CoW，比 saveslot 需要的重得多；不作候选。

### 5.6 Supabase

- 每个 project 是独占 Postgres 实例；计算按 project 收：Micro 约 $10/月、Small 约 $15/月；Micro 推荐 60 个直连、池化客户端 200。[compute-and-disk](https://supabase.com/docs/guides/platform/compute-and-disk)
- Pro $25/月含 $10 计算额度，只够一个 Micro；Free 只有 2 个活跃 project、闲置 1 周暂停。[pricing](https://supabase.com/pricing)
- → project-per-tenant 每租户每月至少约 $10、做不到缩到零（按价格推算）。官方是否明确反对 project-per-tenant **未核实**。

### 5.7 其他

- **Prisma Postgres**：自租裸金属 + Unikraft unikernel + microVM，「一台机器跑数千个实例」，有状态缩到零、「个位数毫秒内恢复」，PG 镜像 280 MB 压到 61 MB。
  [Prisma blog 2024-10-29](https://www.prisma.io/blog/announcing-prisma-postgres-early-access)、[Prisma blog 2025-02-05](https://www.prisma.io/blog/cloudflare-unikernels-and-bare-metal-life-of-a-prisma-postgres-query)；
  Unikraft 案例称单台超过 10 万库（厂商口径，**未核实**）。[Unikraft](https://unikraft.com/customer-stories/prisma-postgres)
  → 这是「每租户一个完整 PG 实例 + 内存快照缩到零」的极致做法，不开源，saveslot 自己做不了，但说明「每用户独立 PG」在商业上是主流方向。
- **PlanetScale Postgres**：单节点 $5/月起，按集群计费，不适合每用户一个。[PlanetScale blog](https://planetscale.com/blog/5-dollar-planetscale)
- Aurora DSQL、Tembo 本次未查（**未核实**）。

## 6. 比较矩阵

✓ 好 / △ 有条件 / ✗ 差。数字带「实测」的见 §2.2–§4，其余见引用。

| 维度 | A. 同集群每用户一个 database（推荐） | B. 服务端 PGlite 每用户一个目录 | C. schema-per-user（cell 内共享库） | D. Neon project-per-user | E. 共享表 + tenant_id（含 Nile） |
|---|---|---|---|---|---|
| 隔离 | ✓ 目录、统计、relcache 按库隔离；CPU/IO 共享 | ✓ 进程内隔离；CPU 共享且同线程 | △ 同库，目录与锁表共享 | ✓ 独立 compute | ✗ 同表 |
| 每用户自定义表 | ✓ | ✓ | ✓ | ✓ | ✗（Nile DDL 全局下发） |
| 连接模型 | △ 每活跃用户 ≥1 后端，不跨库复用；saveslot 自管 LRU；每后端恒定 2.5 MB（实测） | △ 每活跃用户 1 实例，单连接 | △ 连接可共享，但每条连接的缓存随服务过的用户数线性增长（1,000 用户 177 MB，实测） | △ 每 project 自带 PgBouncer；连接不跨 project | ✓ |
| 单集群上限 | △ 建议 2k 起步、5k 待压测；15k 有 CPU 被吃满的报告 | △ 每进程几十到上百个活跃实例（内存） | △ 几千 schema；17k 有事故报告（05） | △ Scale 1k project 软上限，活跃 compute 20 | ✓ |
| 闲置成本 | △ 每库 13 MB 磁盘 + autovacuum 轮询；分层后趋零 | ✓ 只占文件 | △ 同 A 的目录体量，但没有按库轮询 | ✓ 缩到零，只收存储 | ✓ |
| 冷启动 | ✓ 首连 7–8 ms + 首请求 17–20 ms（实测）；△ 集群崩溃恢复随文件数增长（5k 库 212 s，macOS） | △ 打开 60–100 ms（实测） | ✓ 首次触达用户表需加载 relcache（实测） | △ 唤醒「几百毫秒」 | ✓ |
| 全量运维（升级 saveslot 系统表） | △ 扇出到每库，一库一事务；5k 库 27 s（实测） | △ 按需打开时迁移 | △ 一 schema 一事务，同样扇出 | △ 经 API 扇出 | ✓ 一次 DDL |
| 单用户备份 / 恢复 | ✓ `pg_dump -d` / `DROP DATABASE` / saveslot 日志；△ PITR 只能整集群 | ✓ 拷目录 | △ `pg_dump -n`；大目录下 dump 慢（05） | ✓ 每 project PITR | ✗ |
| 自托管同构 | ✓ 同一份代码；本地 PGlite 同布局 | △ 与本地一致，但自托管多用户不宜 | △ 与本地布局不同（多一层 schema） | ✗ 无官方自托管 | — |
| 许可 / 供应商风险 | ✓ PostgreSQL License | ✓ Apache-2.0 / PG；△ 0.x | ✓ | △ Apache-2.0 但只能用托管；被 Databricks 收购 | Nile 引擎闭源（未核实） |
| 成熟度 | ✓ 原生 PG；多库场景有经验报告与已知坑 | ✗ 无生产先例（未找到） | ✓ 常见 SaaS 模式 | ✓ 商用 | ✓ |

## 7. 推荐设计

### 7.1 一个抽象，三种宿主

```
UserStore = 一个用户的全部 saveslot 表（系统表 + 用户表 + 版本表 + 派生缓存），表名不带用户前缀
  本地         → 一个 PGlite 数据目录（saveslot 进程独占）
  自托管单用户  → 用户自己 PG 里的一个 database
  自托管多用户  → 同上，每用户一个 database（和托管同一份代码，cell 数 = 1）
  托管         → cell（一个 PG 集群）里每用户一个 database；cell 由控制面分配
```

- saveslot 内核只依赖 `openUserStore(userId) → Connection`。表名解析（逻辑 → `t_<table_id>_v<n>`）、受限 SQL 编译、写锁都在这个连接内完成，与宿主无关。
  04 §7.3 里「迁移层只依赖按 (schema_set, version) 解析到物理存储」的抽象直接成立，且不用在物理名里带用户前缀。
- **控制面库**（每个托管区域一个，独立于 cell）：用户 → cell 映射、cell 状态、鉴权与计费元数据、saveslot 系统 schema 版本登记。不存任何用户数据。
- 好处：本地 ↔ 托管迁移、cell 间迁移、导出都是「一个 UserStore 整份搬」；删除用户 = `DROP DATABASE`（加上备份保留期的法律口径，DRAFT 待定）。

### 7.2 saveslot 的连接管理器

**前提**：saveslot 服务端是数据库唯一的客户端；每个用户的写串行。于是把「连接」当成「用户会话的一部分」来管：

1. **用户粘到 saveslot 节点**：入口按 `userId` 一致性哈希路由到某个 saveslot 进程（同 Durable Objects 的「每名字一个对象」）。一个用户的连接只存在于一个进程，写锁在进程内就是一个 mutex；
   `pg_advisory_xact_lock` 仍保留作兜底（节点切换时防并发）。
2. **每进程一张 `userId → {conn, lastUsed, inflight}` 表**：
   - 每个活跃用户默认 1 条连接（写与读共用，排队执行）；可选第 2 条只读连接给慢的受限 SQL 读（带 `statement_timeout`、只读角色），避免读堵住写。
   - 闲置超过 `idleTtl`（建议 30–60 s）就关闭；进程级上限 `maxConns`（如 200），满了按 LRU 关最久未用的闲置连接，没有可关的就让新请求排队（按用户公平）。
   - cell 级上限：`max_connections` ≥ Σ(各 saveslot 进程 maxConns) + 运维余量。按实测每后端私有内存 ~2.5 MB、引用值 <2–7.6 MiB 估，500 条连接约 1–4 GB。
3. **冷路径成本**：首连 + 首请求比热请求多约 15 ms（实测冷 17–20 ms vs 热 1–5 ms）；对 MCP 调用（模型往返是秒级）可以忽略。重启后每个库首连还要重建 `pg_internal.init`（§2.1）；实测重启 / 崩溃恢复后的首连与平时无明显差别（§2.2）。
4. **打开时检查 saveslot 系统 schema 版本**（见 7.3）：连接建立后读 `saveslot_meta.sys_version`，落后就先在这条连接上升级再服务请求。
5. **不用 PgBouncer / Supavisor**：它们按库分池，对 saveslot 只多一跳；只有当 saveslot 进程很多、无法粘用户时，才考虑在每个 cell 前放 PgBouncer（`*` 自动库 + `autodb_idle_timeout`）。

### 7.3 全量运维：升级 saveslot 自己的系统表

- 每个 UserStore 里有 `saveslot_meta(sys_version)`。saveslot 的系统 schema 迁移是一组带版本号的幂等脚本，**一库一事务**（04 §6 的教训：跨几千租户的单事务会撑爆锁表）。
- 两条路径同时走：**懒升级**（7.2 第 4 条，打开时升级）+ **后台扫库**（控制面按 cell 逐库推进，限并发，带 `lock_timeout`，失败记下来重试）。
  代码必须同时兼容 N 与 N−1 两个系统版本，直到扫库完成——这和本地 PGlite 升级 saveslot 版本时走的是同一段代码。
- 实测：5,000 库、8 并发、每库「连接 + 一个 ALTER/CREATE INDEX 事务 + 断开」共 27 s，单库 p50 42 ms（§2.2）。
- 用户自己的 schema 迁移本来就是每用户独立的（04 §6），不存在全量问题。

### 7.4 cell 容量与降级路线

- **cell = 一个 PG 主库（+ 流复制备库 + WAL 归档）**。起步上限 **2,000 个用户库 / cell**（约 26 GB 纯目录开销、约 120 万个文件）；用 §8 的压测把上限定到 3,000–5,000。
  主库故障优先切到备库，而不是原地崩溃恢复（原地恢复在 5,000 库时实测要 3.5 分钟，见 §2.2）；Linux 上设 `recovery_init_sync_method = syncfs`。
- **建议参数**（推断，需压测确认）：`autovacuum_naptime` 调大到 5–10 分钟（每库数据小）；`autovacuum_max_workers` 适度增加；监控 `age(datfrozenxid)` 最老的库、launcher CPU、`pg_stat_activity` 中 autovacuum worker 数。
- **冷用户分层**：N 天未活跃的用户 → 导出（`pg_dump -Fc` 快照 + saveslot 日志尾部）到对象存储 → `DROP DATABASE`；下次访问时恢复（建库 + `pg_restore`，或从日志重放）。
  这样 cell 里的库数 ≈ 近 N 天活跃用户数，总用户数不再受 cell 上限约束。恢复延迟（秒级，**未核实**）对「隔了很久才回来的用户」可以接受，首次请求可返回「正在加载」。
- **超限时的顺序**：① 加 cell（水平扩，最简单）；② 收紧分层的 N；③ 若单 cell 压测连 1,000 都撑不住，改为 cell 内 schema-per-user（方案 C）——UserStore 抽象不变，只是 `openUserStore` 改成「共享连接 + `SET LOCAL search_path`」，
  所以这个选择可以推迟、可以按 cell 混用。④ 个别大户或合规用户：单独一个集群或一个 Neon project。
- **备份**：cell 级 PITR（WAL 归档）负责灾难恢复；单用户恢复靠每日 `pg_dump -d`（或 saveslot 日志重放），不承诺单用户 PITR。这一点要写进对外说明。
- **噪声邻居**：每用户 1–2 条连接本身就是并发配额；再加 `statement_timeout`、只读角色、每用户 QPS 限流；重度用户迁到独立 cell。

## 8. 不确定项与最小实验

| # | 不确定项 | 为什么重要 | 最小实验 |
|---|---|---|---|
| 1 | **Linux 云盘上的崩溃恢复时间**（本次 macOS 上 5,000 库 = 212 s，大头是逐文件 fsync） | 决定 cell 上限与可用性 SLA；主库崩溃后整个 cell 停摆这么久 | 在目标云（如 EBS gp3 / 本地 NVMe）上建 2,000 / 5,000 库，`recovery_init_sync_method=syncfs` 与 `fsync` 各 kill -9 一次计时；同时测有流复制备库时的故障切换时间（切换不走崩溃恢复） |
| 2 | **autovacuum 在 cell 满载时的覆盖与 wraparound 余量** | 闲置库也要 freeze；launcher 每库访问间隔 ≈ N/10 s | 5,000 库 + 模拟负载（每秒几百个写事务分散到活跃用户）跑 24 h，记录 `max(age(datfrozenxid))`、各库 `last_autovacuum` 分布、launcher 与 worker 的 CPU；对比 `autovacuum_naptime` 1 / 10 / 60 min |
| 3 | **冷用户分层的恢复延迟** | 决定分层阈值与「隔很久回来」的体验 | 对一个 13 MB 的用户库测 `pg_dump -Fc` 大小与耗时、`CREATE DATABASE` + `pg_restore` 耗时；对比「从 saveslot 日志重放重建」（依赖内核实现，可后做） |
| 4 | **用户真实 relation 数** | 本次按 227 个 relation / 用户；迁移中 ×2、退役版本保留会更多 | 等 schema 设计稳定后用真实 schema 重跑 §2.2 的建库 / 磁盘 / 启动测量 |
| 5 | **并发负载下的吞吐与尾延迟** | 本次是单客户端串行测量 | 300–500 个活跃用户各 1 条连接、并发跑典型请求，测 p99 与 TPS；对比同样负载下方案 C 的 100 条池化连接 |
| 6 | 托管 PG 服务能否用 | 若 cell 跑在 RDS / Cloud SQL 上，参数（`recovery_init_sync_method`、autovacuum）与库数可能受限（**未核实**） | 查目标云厂商文档的 database 数上限与可调参数；若不可调就自管 PG（如 CloudNativePG） |
| 7 | PGlite 服务端路线的上限 | 本次不推荐，但若将来要「每用户一个文件、闲置零成本」，可能回头看 | 等 PGlite 多连接（PR #1054）与 fsync 修复（issue #1107）合入后重测 §3.2 |

**做决定前必须先做的只有 1 和 2**（各约半天到一天）：它们决定「每 cell 2,000 还是 5,000」，不决定「要不要每用户一个 database」——
即使结果很差（例如每 cell 只能 1,000），方案 A 仍然成立，只是 cell 数多一些；只有当单 cell 撑不到约 1,000 时才需要启用 §7.4 的方案 C 降级。

## 9. 实测环境与方法

- 机器：Apple M4 Pro，14 核，24 GB 内存，APFS SSD；macOS（Darwin 25.6.0）；Node 24.14.0。
- 原生 PostgreSQL：18.6，来自 npm 包 `@embedded-postgres/darwin-arm64@18.6.0-beta.19` 的二进制（装在 `/tmp` 临时目录，未做系统级安装）；`initdb --locale=C -E UTF8`；
  `shared_buffers=512MB`、`max_connections=600`、`fsync=on`、autovacuum 默认（`autovacuum_naptime=1min`、`autovacuum_max_workers=3`）；Unix socket 连接，客户端 `pg@8`。
- PGlite：`@electric-sql/pglite@0.5.15`，NodeFS。
- 「典型请求」= 读 `tables_cat` + 10 次带条件的 `count(*)` + 一个写事务（`pg_advisory_xact_lock` + 3 条 INSERT），各方案相同。
- macOS 上 `ps` 的 RSS 会把进程碰过的共享内存页（shared_buffers）也算进去，因此后端「私有内存」以 `pg_backend_memory_contexts` 的合计为准，RSS 只作上界参考。
- 局限：单机、数据都在 OS 页缓存里（建库后立即测），真正冷盘的首连会更慢；没有测并发负载下的吞吐；没有测崩溃恢复后的 autovacuum 追赶。
- 全部实验目录、数据库进程已在结束时清理。
