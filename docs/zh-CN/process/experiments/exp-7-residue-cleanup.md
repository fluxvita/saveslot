# 实验 7：物理删除后的明文残留 · 结果（macOS）

> 实验的定义、做法与通过标准见 [`../decisions/pre-dev-w0-experiments.md`](../decisions/pre-dev-w0-experiments.md)「实验 7」。本文只报告结果，不改标准。
> 运行日期：2026-11-20 至 2026-11-21。只在 macOS 上跑过；**Linux 没有跑**，本文不给出任何 Linux 结论。

## 结论

- **两个后端都有满足标准 1–5 的候选，而且是同一种：原地清理**——候选 C（重写受影响的表、处理预写日志），再加两步定义里没有的：`ANALYZE` 之后再重写一次统计信息表 `pg_statistic`；PostgreSQL 上在那一步之前先等本库别的会话放开快照。采用的次序：
  1. `VACUUM FULL` 受影响的每张表；
  2. `ANALYZE`；
  3. （PostgreSQL）等到本库没有别的会话持有快照或事务号（最多 60 秒）；
  4. `VACUUM FULL pg_statistic`；
  5. `CHECKPOINT`，`pg_switch_wal()`，再两次 `CHECKPOINT`；
  6. 实例以 `wal_recycle = off` 运行（不复用旧日志段）。
- **成功判据**：做完之后 `VACUUM (VERBOSE) pg_statistic` 的报告里 "dead but not yet removable" 为 0，这次清理才算成功。不为 0 说明有快照挡着、旧的统计行还在，这次清理不算数。
- **每一步都有去掉它就命中的对照组**：重写表、日志处理、`ANALYZE` 之后重写 `pg_statistic`、等快照。日志处理（切段、检查点、`wal_recycle = off`）是作为一组去掉的，组内各项没有分别去掉；"去掉两次 `CHECKPOINT`"也没有单独测（见「没做的」）。
- 候选 D（重建数据目录）两个后端也都零命中，但 10 万行时 PostgreSQL 上要 7.7–8.3 s、期间租户不可写；它留作托管实例拿不到权限时的退路。
- 采用组的零命中在 Node 24.22.3 上重跑过（PostgreSQL 崩溃加等快照、PGlite 崩溃，各 20 轮）；耗时也按最终次序在 24.22.3 上重量了。

## 环境

| 项 | 取值 |
|---|---|
| 机器 | Apple M4 Pro，14 核，24 GB；内置 SSD，APFS；笔记本 |
| 系统 | macOS 26.7.1 |
| Node | 24.22.3（最终确认与耗时）；早先的组有的在 24.14.0 上跑，下表逐组注明 |
| PGlite | `@electric-sql/pglite` 0.5.16，启动参数与 `store-pglite` 相同（`durability.ts`） |
| PostgreSQL | 18.7（Homebrew），每轮一个一次性实例，只开 unix socket |
| 测试目录 | 系统临时目录（内置 SSD） |

## 标记串放在哪

每轮生成新的标记串（固定前缀加 32 个十六进制随机字符），写进下面七类位置（`experiments/exp7/lib.ts` 的 `insertSql`）。

| 类 | 位置 |
|---|---|
| `short` | 内容表的短文本值 |
| `long` | 内容表的长文本值（约 9.6 KB 的随机串后接标记串，会被移到行外存储） |
| `plain_col` | 业务表的普通列 |
| `indexed_col` | 业务表带索引的列 |
| `high_freq` | 一张表里 300 行的同一个值（进入统计信息的高频值） |
| `group_key` | 派生表的分组键 |
| `rolled_back` | 一个回滚了的事务里写入的值（只在预写日志里） |

定义里还列了"全文索引或子串索引"：内核不建这类索引（`pg_trgm`、`tsvector`、GIN、GiST 在 `packages/` 里都没有），这一类第一版不适用。

**阳性对照**：每一组的每一轮，删除之前关掉数据库按字节搜整个数据目录，七类都至少命中一次（全部组都成立）。所以"删除后搜不到"有意义；没有遇到压缩导致搜不见的情况。

## 做了什么

全部命令在仓库根目录执行，原始结果在 `experiments/out/exp7/`（不入库）。

| 测试 | 命令 | 规模 |
|---|---|---|
| 残留（各候选、各步骤组合） | `node --conditions=source experiments/exp7/run.ts --backend pglite\|postgres --candidate A\|B\|C\|D [--steps …] [--crash] --rounds N` | 每轮：写标记串 → 阳性对照 → 删除含标记串的行（`--crash` 时删除一提交就杀掉数据库）→ 重开 → 清理 → 关闭 → 搜全部文件（本轮与之前各轮的标记串都要零命中）。同一个数据目录连续使用，每张表另有 2,000 行随机数据 |
| 耗时 | `node --conditions=source experiments/exp7/timing.ts --backend … --rows 10000\|100000 --recycle on\|off --candidate C\|D` | 每个组合三次；清理逐步计时，清理期间每 20 ms 发一条写入，记最长等待 |

- 崩溃：PostgreSQL 用 `pg_ctl stop -m immediate`（不做关闭检查点）；PGlite 在子进程里删除，删除提交后父进程 `SIGKILL` 它。
- `--steps` 的含义：`statafter` 在 `ANALYZE` 之后 `VACUUM FULL pg_statistic`；`stat` 把这一步放在 `ANALYZE` 之前（早先的错误次序，保留作对照）；`waitxmin` 在那一步之前等快照；`wal` 给 A、B 加上 C 的日志处理；`verify` 清理后读 `VACUUM (VERBOSE) pg_statistic` 的报告；`blocker` 让另一个会话在清理期间一直持有快照。

## 原始数字

### 采用的做法

| 组 | 后端 | 崩溃 | 轮数 | Node | 七类命中 | 判据（not removable） |
|---|---|---|---|---|---|---|
| C + statafter + waitxmin + verify | PostgreSQL | 是 | 20 | 24.22.3 | 全部 0 | 每轮 0 |
| C + statafter | PGlite | 是 | 20 | 24.22.3 | 全部 0 | — |
| C + statafter + waitxmin | PostgreSQL | 是 | 40 | 24.14.0 | 全部 0 | — |
| C + statafter | PostgreSQL | 是 | 40 | 24.14.0 | 全部 0 | — |
| C + statafter + waitxmin + verify | PostgreSQL | 是 | 20 | 24.14.0 | 全部 0 | 每轮 0 |
| C + statafter | PostgreSQL | 否 | 20 | 24.14.0 | 全部 0 | — |
| C + statafter | PGlite | 否 | 20 | 24.14.0 | 全部 0 | — |
| C + statafter | PGlite | 是 | 20 | 24.14.0 | 全部 0 | — |

### 去掉一步

| 去掉的 | 组 | 后端 | 轮数 | Node | 结果 |
|---|---|---|---|---|---|
| 重写表（普通 `VACUUM`） | A + wal + statafter + waitxmin | PostgreSQL | 20 | 24.14.0 | 有命中 |
| 同上 | A + wal + statafter | PGlite | 20 | 24.22.3 | 有命中 |
| 日志处理 | B + statafter + waitxmin | PostgreSQL | 20 | 24.22.3 | 有命中 |
| 同上 | B + statafter | PGlite | 20 | 24.22.3 | 有命中 |
| `ANALYZE` 之后重写 `pg_statistic` | C + waitxmin | PostgreSQL | 20 | 24.14.0 | 有命中 |
| 同上 | C | PGlite | 20 | 24.22.3 | 有命中 |
| 次序：重写 `pg_statistic` 放在 `ANALYZE` 之前 | C + stat，崩溃 | PostgreSQL | 40 | 24.14.0 | 有命中 |
| 等快照（另一会话一直持有快照） | C + statafter + verify + blocker | PostgreSQL | 10 | 24.14.0 | 每轮都命中（`high_freq`，在表文件与日志里），判据每轮报 431，不为 0 |

- `ANALYZE` 会把旧的统计行（含高频值，即标记串本身）留成死行；在它之前重写 `pg_statistic` 清的是更早的死行，`ANALYZE` 随后又留下一批。这是早先崩溃组命中的原因，不是 PostgreSQL 的问题。
- 次序为 `stat` 的不崩溃组（PostgreSQL、PGlite 各 20 轮）与 PGlite 崩溃组是零命中的：那几组里旧统计行在 `ANALYZE` 之前就已经死了。只有采用 `statafter` 的次序在每种情形下都成立。
- 等快照那组同时说明两件事：有快照挡着时原地清理清不干净；判据能抓住这种情况。

### 候选 D（重建）

| 后端 | 轮数 | Node | 七类命中 |
|---|---|---|---|
| PostgreSQL | 20 | 24.14.0 | 全部 0 |
| PGlite | 2 | 24.14.0 | 全部 0 |

### 耗时（最终次序，Node 24.22.3，每格三次）

| 后端 | 行数 | 做法 | 清理总耗时 | 清理期间一条写入最长等 | 平时写入 p99 |
|---|---|---|---|---|---|
| PostgreSQL | 10,000 | C，`wal_recycle = off` | 182–184 ms | 7–9 ms | 0.03–0.05 ms |
| PostgreSQL | 10,000 | C，`wal_recycle = on` | 167–180 ms | 7–8 ms | 0.03–0.05 ms |
| PostgreSQL | 10,000 | D | 1.33–1.39 s | 不可写 | 0.04 ms |
| PostgreSQL | 100,000 | C，`wal_recycle = off` | 331–346 ms | 8 ms | 0.03–0.04 ms |
| PostgreSQL | 100,000 | C，`wal_recycle = on` | 301–318 ms | 8–9 ms | 0.04 ms |
| PostgreSQL | 100,000 | D | 7.74–8.32 s | 不可写 | 0.04–0.05 ms |
| PGlite | 10,000 | C，`wal_recycle = off` | 450–853 ms | 26–29 ms | 5.2–6.1 ms |
| PGlite | 10,000 | C，`wal_recycle = on` | 518–755 ms | 33–85 ms | 6.2–8.9 ms |
| PGlite | 10,000 | D | 1.02–1.11 s | 不可写 | 5.3–9.6 ms |
| PGlite | 100,000 | C，`wal_recycle = off` | 488–504 ms | 40–44 ms | 5.3–5.9 ms |
| PGlite | 100,000 | C，`wal_recycle = on` | 500–529 ms | 46–47 ms | 5.1–6.1 ms |
| PGlite | 100,000 | D | 1.05–1.06 s | 不可写 | 5.3–6.2 ms |

- 等快照一步在没有别的会话时约 10 ms。
- `wal_recycle` 开或关，平时的写入延迟看不出差别。
- 标准 4（10 万行：原地 ≤ 5 s，重建 ≤ 60 s）两个后端都满足。
- PGlite 的写入与清理在同一个队列里，最长等待约是清理中最长的一条语句；PostgreSQL 上写入是另一个连接，只在锁上等。

## PostgreSQL 上的权限

在一次性的 PostgreSQL 18.7 实例上，用一个非超级用户的角色逐项核过（2026-11-21）：

| 步骤 | 默认谁能做 | 给非超级用户的授权 | 核对结果 |
|---|---|---|---|
| `VACUUM FULL pg_statistic` | 超级用户 | `GRANT pg_maintain TO <角色>`（PostgreSQL 17 起） | 授权后执行成功 |
| `CHECKPOINT` | 超级用户 | `GRANT pg_checkpoint TO <角色>` | 授权后执行成功 |
| `pg_switch_wal()` | 超级用户（没有授给 `PUBLIC`） | `GRANT EXECUTE ON FUNCTION pg_switch_wal() TO <角色>` | 授权前 `has_function_privilege` 为假；授权后执行成功 |
| `wal_recycle = off` | 级别是 `superuser`（不是只能启动时设） | 日志段的复用在检查点进程里做，会话里 `SET` 管不到它，必须写进实例配置（`ALTER SYSTEM` 或 `postgresql.conf`，重载生效）；非超级用户要 `GRANT ALTER SYSTEM ON PARAMETER wal_recycle` | 未授权时 `SET` 被拒；`GRANT SET ON PARAMETER` 之后会话里能设，但那不够 |
| 等快照（读 `pg_stat_activity`） | 所有角色 | 不需要 | 见下 |

**等快照不需要额外授权**（实测，原先推测要 `pg_read_all_stats`，不对）：PostgreSQL 18 对没有权限的角色隐藏别的会话的 `backend_type`、`state`、`query` 等列，但 **`backend_xmin` 与 `backend_xid` 照样给出**。非超级用户、未授 `pg_read_all_stats` 的角色，在超级用户或另一个普通角色持有快照时，都看得到对方的 `backend_xmin`，等快照会一直等到超时。要注意的只是不要用被隐藏的列（如 `backend_type`）做过滤条件，否则会把持有快照的会话过滤掉、误判为没人持有。

**另一个库的快照不挡**：同一实例里，另一个 database 的会话持有快照时，本库 `VACUUM (VERBOSE) pg_statistic` 报 0 条 not removable（本库的会话持有时报 1、2 条）。所以等快照只看本库，加上不属于任何库的进程（`coalesce(datname, current_database()) = current_database()`）；不这样过滤时，实测会一直等别的库的长事务到超时。服务器模式下每租户一个库，这一点决定一个租户的清理会不会被别的租户挡住。

**实例级的影响**：切日志段、检查点、`wal_recycle` 都是整个实例的事。服务器模式下一个租户的清理会让整个实例切一次日志段、做一次检查点；部署要求见 architecture「残留清理在 PostgreSQL 上需要的权限」。

## 与定义的出入

- 定义里的候选 C 提到 `wal_init_zero` 一类参数：没有用到，`wal_recycle = off` 加切段与检查点已经零命中。
- 定义没有"`ANALYZE` 之后重写 `pg_statistic`"和"等快照"两步，是实验中发现必须加的；判据（`VACUUM (VERBOSE)` 的报告）也是新加的。
- "PGlite 能否执行 `VACUUM`、`VACUUM FULL`、`CHECKPOINT`"：都能，`pg_switch_wal()` 也能；`wal_recycle` 在 PGlite 上作为启动参数被接受。日志处理整体的必要性有对照（去掉的命中、加上的零命中），`wal_recycle = off` 这一项没有单独去掉测过。
- 定义的崩溃变体是"墓碑事务已提交、清理未完成时强杀"：实验里在删除一提交就杀，重开后做完整清理，相当于清理一步都没做时崩溃。

## 没做的

- **Linux**：没跑。
- **单独去掉两次 `CHECKPOINT`**：harness 的步骤组合不能只去掉它们，没有对照组；这两步留在采用的做法里，没有实测证明它们必要。日志处理里的 `wal_recycle = off` 与 `pg_switch_wal()` 也没有分别去掉测过。
- **`wal_recycle = off` 与 `store-pglite` 的预写日志大小上限（按 64 MiB 触发检查点）的配合**：那项改动还没进 `main`，进去之后补一组。
- 定义的"不在范围内"照旧：文件删除后留在文件系统空闲块或固态硬盘上的旧数据不处理，删除回执如实说明。
