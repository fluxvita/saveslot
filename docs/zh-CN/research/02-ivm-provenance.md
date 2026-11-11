# 02 · 增量视图维护（IVM）与来源 / 血缘

> 2026-11-09 调研。对应 [`data-model.md`](../spec/03-data-model/README.md)「派生规则与派生缓存」「写日志」「纠错影响查询」「删除」，
> 以及 [`references-mcp.md`](references-mcp.md) 第五节的 Teable 对照。
> 源码均为浅克隆后读取，链接钉到具体 commit；本地基准测试在 PGlite 0.5.15（PostgreSQL 18.6 编译为 WASM，跑在 Node 24 上，macOS）中进行，
> 脚本和数据都是临时的，测完已删除。没能读到原文、靠推断得出的结论标「未核实」。

## 结论先行

1. **首版派生刷新用「重算受影响的分组 / 分区」，不用 IVM 引擎。** 实测在 100 万行的单用户表上，只重算受影响的那一周约 1.7 ms，
   重算整个用户的派生表约 290 ms，pg_ivm 增量维护约 0.3 ms。三种都能放进同一个事务；差距只在「整用户重算」这一档才显著，
   而「按分组重算」已经和 IVM 同一个量级，表达能力却不受限（窗口函数、HAVING、分区表都能用），saveslot 还能自己记派生写入的
   change_log 和来源。
2. **pg_ivm 是唯一能放进同一事务的现成 IVM，但不适合当核心组件**：不支持窗口函数、HAVING、UNION、分区表、STABLE 函数
   （实测 `date_trunc('week', date)` 被拒），多表视图在并发写时对整张 IMMV 加 `ExclusiveLock`；它也不对外暴露「这次改了哪些派生行、
   由哪些基础行引起」，saveslot 的派生写日志还得自己再算一遍。可留作个别热点规则的加速器。
3. **Feldera/DBSP、Materialize 都是独立的流式引擎，不能放进 PostgreSQL 事务。** Materialize 的 BSL 许可证明确禁止
   「第三方自定义视图的商业数据库服务」，这正是 saveslot 托管版的形态；Feldera 开源版是 MIT，但每套视图要编译成 Rust 程序（分钟级），
   不适合每个用户各有一套动态规则。只借鉴思路。
4. **血缘分三层，按需要的精度存：** 静态的列级依赖图（定义规则时解析 SQL 得出）；每次派生写入记**分区级读集**
   （规则版本 + 基础表 + 分区键 / 谓词 + 日志位置），每次 O(1) 条；行级来源**不预先存**，需要时按「日志位置 + 版本表」重放规则得出
   （GProM「重演」reenactment 的思路）。实测预先存行级边会让单次写入慢 4–7 倍，且每次刷新都写入与分组大小成正比的来源行。
   对 saveslot 的两个用途——删除级联和纠错影响查询——分区级读集已经足够精确。
5. **写入准入阈值在执行前按「受影响分区的行数之和」估算**：用规则的分区键把被改的基础行（改前、改后两个值）映射到受影响的分区，
   查每个分区的行数（同事务维护的计数表），沿派生 DAG 往下累加；超阈值就拒绝并要求拆批，执行期再用 `SET LOCAL statement_timeout`
   兜底。

---

## 1. pg_ivm

### 怎么实现

- 定位：PostgreSQL 扩展，提供「immediate」（同事务）维护：在基础表的 AFTER 触发器里算增量、应用到视图上
  ([README](https://github.com/sraoss/pg_ivm/blob/678c37861080aa221b859cefaca98725646dbf7c/README.md#description))。
  视图叫 IMMV，用 `pgivm.create_immv(name, query)` 创建，而不是 `CREATE MATERIALIZED VIEW`（同上）。
- 每张基础表建 INSERT / DELETE / UPDATE / TRUNCATE 四个 AFTER 触发器
  ([createas.c#L761-L764](https://github.com/sraoss/pg_ivm/blob/678c37861080aa221b859cefaca98725646dbf7c/createas.c#L761-L764))，
  触发器带 transition table（这条语句改前、改后的行集合）
  ([createas.c#L843-L861](https://github.com/sraoss/pg_ivm/blob/678c37861080aa221b859cefaca98725646dbf7c/createas.c#L843-L861))；
  维护时先 `calc_delta` 用视图定义在旧 / 新行集合上算出视图的增量，再 `apply_delta` 合并进 IMMV
  ([matview.c#L2894](https://github.com/sraoss/pg_ivm/blob/678c37861080aa221b859cefaca98725646dbf7c/matview.c#L2894)、
  [#L2995](https://github.com/sraoss/pg_ivm/blob/678c37861080aa221b859cefaca98725646dbf7c/matview.c#L2995))。
- 聚合靠隐藏列：`__ivm_count__` 记每组行数，`avg` 另存 `__ivm_count_avg__`、`__ivm_sum_avg__`；`min`/`max` 在删掉当前极值时要回基础表
  重算该组，可能很慢；`sum`/`avg` 用于 float 会累积误差，要求用 `numeric`
  ([README#aggregates](https://github.com/sraoss/pg_ivm/blob/678c37861080aa221b859cefaca98725646dbf7c/README.md#aggregates))。

### 支持的 SQL（README「Supported View Definitions and Restriction」）

- 支持：内连接（含自连接）、外连接（只限单个等值条件）、DISTINCT、`count/sum/avg/min/max`、FROM 中的简单子查询、WHERE 中的 EXISTS、简单 CTE。
- 不支持：其他聚合、带聚合或 DISTINCT 的子查询、**窗口函数**、**HAVING**、ORDER BY、LIMIT/OFFSET、UNION/INTERSECT/EXCEPT、DISTINCT ON、
  VALUES、递归 CTE；基础表不能是视图、物化视图、**分区表或分区**、外部表；目标列类型必须有 btree 默认操作符类（`json` 不行）；
  外连接不能带聚合、不能用 `CASE` 等非严格函数
  （[README#supported-view-definitions-and-restriction](https://github.com/sraoss/pg_ivm/blob/678c37861080aa221b859cefaca98725646dbf7c/README.md#supported-view-definitions-and-restriction)）。
- 只接受 IMMUTABLE 函数：报错原文 `mutable function is not supported on incrementally maintainable materialized view`
  ([createas.c#L353](https://github.com/sraoss/pg_ivm/blob/678c37861080aa221b859cefaca98725646dbf7c/createas.c#L353))。
  实测 `date_trunc('week', day)::date`（`date` 隐式转 `timestamptz`，是 STABLE）被拒，要写成 `date_trunc('week', day::timestamp)` 才行
  （本地 PGlite 实测）。saveslot 规则里按自然日、按周的计算很常见，这条限制会直接撞上。

### 并发与锁

- READ COMMITTED 下，修改基础表后立即对 IMMV 加 `ExclusiveLock`，让后提交的事务在先提交者完成后再维护；REPEATABLE READ / SERIALIZABLE 下拿不到锁就直接报错。
  例外：单基础表、无 DISTINCT / GROUP BY、只有 INSERT 时只加 `RowExclusiveLock`
  ([README#concurrent-transactions](https://github.com/sraoss/pg_ivm/blob/678c37861080aa221b859cefaca98725646dbf7c/README.md#concurrent-transactions))。
- **对 saveslot 的含义**：如果多用户共用物理表、一张 IMMV 覆盖所有用户（`GROUP BY user_id`），不同用户的写入会在这把锁上串行；
  如果每个用户各自一套 IMMV，共享的基础表上会堆起「用户数 × 规则数」个触发器（推断，未核实实际开销）。

### 性能

- README 自带的 pgbench 例子：1000 万行账户表上的分组聚合 IMMV，全量刷新约 5.8 s，单行 UPDATE 后增量维护约 16.6 ms；
  删掉 IMMV 的唯一索引后单行更新变成约 3.2 s
  ([README#creating-an-immv](https://github.com/sraoss/pg_ivm/blob/678c37861080aa221b859cefaca98725646dbf7c/README.md#creating-an-immv))。
- README 自己说明：基础表频繁修改、或一次改动占表的大部分时，IVM 不划算，代价可能超过从头刷新；建议大批量改动前先用 `refresh_immv(..., false)`
  关掉维护、改完再全量刷新
  ([README#how-to-disable-or-enable-immediate-maintenance](https://github.com/sraoss/pg_ivm/blob/678c37861080aa221b859cefaca98725646dbf7c/README.md#how-to-disable-or-enable-immediate-maintenance))。
- 本地基准见第 7 节。

### 维护状态、许可、可嵌入性

- 活跃：v1.14（2026-03）、v1.15（2026-06）、v1.16（2026-09）、v1.17（2026-10-18），支持 PostgreSQL 13–19
  （[releases](https://github.com/sraoss/pg_ivm/releases)、[README](https://github.com/sraoss/pg_ivm/blob/678c37861080aa221b859cefaca98725646dbf7c/README.md)）。
  GitHub 约 1.5k star、43 个未关闭 issue（2026-11-09 用 `gh api` 读取）。
- 许可：PostgreSQL License
  ([LICENSE](https://github.com/sraoss/pg_ivm/blob/678c37861080aa221b859cefaca98725646dbf7c/LICENSE))，商用、托管都没有障碍。
- 内核版 IVM 补丁从 2019 年提交至今仍未合入 PostgreSQL（[PG wiki](https://wiki.postgresql.org/wiki/Incremental_View_Maintenance)，该页最后编辑于 2023-06；
  当前 commitfest 状态未核实）。
- **PGlite 可用**：官方外部扩展包 `@electric-sql/pglite-pg_ivm`
  ([pglite extensions.data.ts#L539-L558](https://github.com/electric-sql/pglite/blob/bac163ecc92e968adda68864b74b7e3d65a68e97/docs/extensions/extensions.data.ts#L539-L558))，
  本地已实测可用（0.0.16）。**SQLite 不可用**：它是 PostgreSQL 扩展。
- 托管云 PostgreSQL 是否允许装 pg_ivm 要逐家确认（未核实）；saveslot 自建托管就没这个问题。

### 对 saveslot：只借鉴 + 备用

能直接用，但只能覆盖 saveslot 规则的一部分（无窗口函数，「近 7 天平均」这类规则就写不了）；还要求把它加进 `shared_preload_libraries` 或 `session_preload_libraries`
（[README#configuration](https://github.com/sraoss/pg_ivm/blob/678c37861080aa221b859cefaca98725646dbf7c/README.md#configuration)）。
最大问题是它和 saveslot 的写日志脱节：saveslot 要为每次派生写入记规则版本、日志位置、结果哈希和来源，pg_ivm 在 C 触发器里直接改 IMMV，
saveslot 拿不到「改了哪些派生行」（能否在 IMMV 上再挂触发器拿到，未核实）。

---

## 2. Feldera / DBSP 与 Materialize / Differential Dataflow

### DBSP（Feldera 的内核）

- 论文：Budiu、McSherry、Ryzhyk、Tannen，《DBSP: Automatic Incremental View Maintenance for Rich Query Languages》
  （[arXiv:2203.16684](https://arxiv.org/abs/2203.16684)；VLDB 2023 版 PDF 见 [docs.feldera.com/vldb23.pdf](https://docs.feldera.com/vldb23.pdf)，
  由 [dbsp README](https://github.com/feldera/feldera/blob/fa660041300d6f8f9ea8ca5e787ac6ae1a84b11a/crates/dbsp/README.md) 引用）。
  把查询表达为流上的电路，给出对任意 DBSP 程序自动求增量版本的算法，覆盖完整关系代数、分组聚合、单调与非单调递归、流式聚合（arXiv 摘要）。
  核心思路：把表的变化看成带正负权重的集合（Z-set），算子都改写成「输入的变化 → 输出的变化」；线性算子直接作用于变化，
  join 这类双线性算子需要保留两侧的累积状态（论文正文，此处为概括；具体代价界未在摘要里写明）。
- Feldera 的用法：SQL 经 SQL-to-DBSP 编译器（基于 Calcite）**编译成 Rust**，启动后假定表初始为空，输入变化、输出视图的变化；
  文档明说「DBSP 不是数据库」「不提供并发控制或事务」
  ([intro.mdx](https://github.com/feldera/feldera/blob/fa660041300d6f8f9ea8ca5e787ac6ae1a84b11a/docs.feldera.com/docs/sql/intro.mdx))。
  一致性：continuous 模式下每批输入处理完、所有视图都更新后再处理下一批；transaction 模式让用户自己划定一批输入原子处理
  ([pipelines/transactions.md](https://github.com/feldera/feldera/blob/fa660041300d6f8f9ea8ca5e787ac6ae1a84b11a/docs.feldera.com/docs/pipelines/transactions.md))。
- SQL 覆盖面大，包括窗口函数和递归，但有列出的限制（如带帧的窗口聚合 `ORDER BY` 只能一列、不支持 `EXCLUDE`）
  ([unsupported-operations.md](https://github.com/feldera/feldera/blob/fa660041300d6f8f9ea8ca5e787ac6ae1a84b11a/docs.feldera.com/docs/sql/unsupported-operations.md))。
- 编译成本：官方博客标题即「把 Rust 编译时间从 30 分钟降到 2 分钟」
  ([blog 列表](https://github.com/feldera/feldera/blob/fa660041300d6f8f9ea8ca5e787ac6ae1a84b11a/docs.feldera.com/docs/literature/blog.md))；
  企业版编译服务冷启动另加 1–3 分钟
  ([parallel-compilation.md](https://github.com/feldera/feldera/blob/fa660041300d6f8f9ea8ca5e787ac6ae1a84b11a/docs.feldera.com/docs/get-started/enterprise/parallel-compilation.md))。
- 许可：开源版 MIT，企业功能（`feldera-enterprise` feature flag）另有条款
  ([LICENSE](https://github.com/feldera/feldera/blob/fa660041300d6f8f9ea8ca5e787ac6ae1a84b11a/LICENSE))。`dbsp` crate 可作为 Rust 库直接用
  （[crates/dbsp](https://github.com/feldera/feldera/tree/fa660041300d6f8f9ea8ca5e787ac6ae1a84b11a/crates/dbsp)），但那是手写电路，没有 SQL 前端。

### Materialize（Timely / Differential Dataflow）

- 定位：把 SQL 重写成 dataflow，随数据变化增量更新；从 PostgreSQL / MySQL 复制流、Kafka、webhook 接入数据，对外说 PostgreSQL 协议；
  托管版多副本、可水平扩展，也可自建
  ([README](https://github.com/MaterializeInc/materialize/blob/98072e989cd4da5583aec5ba6da1d945b0677b83/README.md))。
- 一致性：默认 Strict Serializable；在此级别下后一次读物化视图一定看到前一次读看到的全部行；Serializable 下读物化视图可能不满足线性一致
  ([isolation-level 文档](https://materialize.com/docs/get-started/isolation-level/))。注意：这是 Materialize 自己内部的一致性，
  它通过复制流跟在上游 PostgreSQL 后面，**不可能和上游的写入在同一事务里**（由接入方式推断）。
- 许可：BSL 1.1，单个安装总内存 < 24 GiB、磁盘 < 48 GiB 内免费；**禁止用于「数据库服务」——让第三方通过自己定义视图来使用其功能的商业服务**；
  2030-11-09 转 Apache 2.0
  ([LICENSE](https://github.com/MaterializeInc/materialize/blob/98072e989cd4da5583aec5ba6da1d945b0677b83/LICENSE))。
  saveslot 托管版里用户 / Agent 自己定义派生规则，正落在这条禁止范围里。
- 底层 Differential Dataflow 是 MIT 的独立 Rust 库
  （[TimelyDataflow/differential-dataflow](https://github.com/TimelyDataflow/differential-dataflow/tree/e7c24703f4b1935cd6c99779ed0c140b0fea8ac6)，许可经 `gh api` 读取为 MIT），
  同样没有 SQL 前端。

### 对 saveslot：只借鉴

两者都要求「先装好查询、再喂变化」的常驻流程序，内存里保留算子状态，和「每次写入在 PostgreSQL 事务里同步刷新」的模型不兼容；
每用户一套动态规则意味着每用户一个 pipeline、每次改规则重新编译，成本远超 saveslot 的数据量所需。PGlite / SQLite 下都不可用。
值得借的是两个概念：**变化是带权重的行集合（+1/−1）**，以及**「只对受影响的键重算」与「增量算子」在小数据上差别不大**——
这正是第 7 节的测试结论。

---

## 3. 纯 PostgreSQL 方案

### 物化视图 + REFRESH

- `REFRESH MATERIALIZED VIEW` 整体替换内容，没有部分刷新
  ([PG 18 文档](https://www.postgresql.org/docs/current/sql-refreshmaterializedview.html))。
- 锁：不带 `CONCURRENTLY` 取 `ACCESS EXCLUSIVE`（期间连读都挡）；带 `CONCURRENTLY` 取 `EXCLUSIVE`（允许并发 SELECT）
  ([explicit-locking](https://www.postgresql.org/docs/current/explicit-locking.html))。
- `CONCURRENTLY` 要求至少一个只含列名、无 WHERE 的唯一索引，且视图已填充；同一视图同时只能有一个 REFRESH（同上 REFRESH 文档）。
- **对 saveslot**：物化视图是全局对象，多用户共享时一次刷新会重算所有用户，没法「只刷这个用户」；即使每用户一个物化视图，`ACCESS EXCLUSIVE`
  也会在写事务里挡住读。saveslot 需要的是「按分区删 + 插」，所以派生缓存应当是**普通表**，由 saveslot 自己维护。

### 触发器维护的汇总表

- 就是 pg_ivm 的手写版。可控、能记日志，但每条规则都要手写增量逻辑，`min/max`、窗口、外连接要特殊处理——saveslot 的规则是用户 / Agent 写的，
  不可能为每条规则手写增量代码。可行的变体是**由 saveslot 生成「删除受影响分组 + 用原规则 SQL 加分组谓词重新插入」**，
  这只需要知道规则的分组键，不需要理解聚合语义——这就是本报告推荐的方案。

### 全量重算什么时候够用

saveslot 的单用户数据量是几千到几百万行。第 7 节实测（PGlite，WASM，单线程）：

| 单用户基础表行数 | 整用户重算 + 1 行写入，同一事务 | 只重算受影响的那一周 | pg_ivm 增量（1 行插入） |
|---:|---:|---:|---:|
| 1 万 | 4.0 ms | 0.26 ms | 0.27 ms |
| 20 万 | 58.8 ms | 0.52 ms | 0.27 ms |
| 100 万 | 292.5 ms | 1.65 ms | 0.27 ms |

结论：**几万行以内整用户重算也行；再往上必须按分组 / 分区重算**，它和 IVM 的差距在毫秒以内。原生 PostgreSQL（非 WASM）预计更快，未实测。

---

## 4. 行级来源：ProvSQL 与 provenance semiring

### 理论

- **why / where / how**：why-provenance 回答「哪些输入行的组合使这一行出现」，where-provenance 回答「这个值是从哪个单元格拷来的」，
  how-provenance 回答「输入行是怎样组合的」（Cheney、Chiticariu、Tan 综述，
  [FnT Databases 2009, DOI 10.1561/1900000006](https://nowpublishers.com/article/Details/DBS-006)）。
- **Provenance semiring**（Green、Karvounarakis、Tannen，[PODS 2007, DOI 10.1145/1265530.1265535](https://www.cs.ucdavis.edu/~green/papers/pods07.pdf)）：
  给每个基础行一个标注，join 对应乘、并 / 投影去重对应加，结果行的标注是一个多项式；bag 语义、why-provenance、概率库都是它的特例。
  多项式里出现的变量集合，就是「哪些基础行贡献了这一行」。
- **聚合不能只靠行标注**：Amsterdamer、Deutch、Tannen 指出元组级标注说明不了聚合值是怎么算出来的，需要给值本身加标注
  （[arXiv:1101.1110](https://arxiv.org/abs/1101.1110)）。对 saveslot 来说，粗粒度答案很简单：**一个聚合结果行的贡献者 = 该分组内通过 WHERE 的所有行**；
  细粒度（例如 `max` 只依赖最大那一行）理论上可行，但删除级联和纠错影响都不需要这么细。

### ProvSQL

- 实现：planner hook 改写查询，在结果上附加一列 UUID，指向一个「来源电路」（gate 组成的 DAG）里的门；必须放进 `shared_preload_libraries`
  ([querying.rst](https://github.com/PierreSenellart/provsql/blob/23935cc8018f1593edee9eb115272aef5019e15d/doc/source/user/querying.rst))。
- 覆盖面：内外连接、LATERAL、各种子查询、`WITH RECURSIVE`（PG 15+）、GROUP BY / ROLLUP、常见聚合与 HAVING、部分窗口函数（按值定帧的聚合、rank 类）、
  DISTINCT、ORDER BY…LIMIT、集合运算、`CREATE TABLE AS`；不支持 / 不追踪的包括 `EXCEPT ALL`、`lag`/`lead`/`first_value`/带偏移的 `ROWS` 帧
  （带警告执行、窗口值不追踪）、数据修改 CTE 等（同上）。where-provenance 是实验特性，聚合值没有位置
  ([where-provenance.rst#L80-L92](https://github.com/PierreSenellart/provsql/blob/23935cc8018f1593edee9eb115272aef5019e15d/doc/source/user/where-provenance.rst#L80))。
  更新追踪仍是实验性的，功能和性能都是
  ([data-modification.rst#L114](https://github.com/PierreSenellart/provsql/blob/23935cc8018f1593edee9eb115272aef5019e15d/doc/source/user/data-modification.rst#L114))。
- **和 saveslot 冲突的关键点**（[persistence.rst](https://github.com/PierreSenellart/provsql/blob/23935cc8018f1593edee9eb115272aef5019e15d/doc/source/user/persistence.rst)）：
  - 电路存在数据库目录下的四个内存映射文件里，**不进 WAL、不随事务回滚、不被 `pg_dump` 和逻辑复制带走**；机器崩溃可能丢掉刚提交事务的门。
  - 「门一旦创建就不删不改」，回滚事务留下的门要靠 `circuit_cleanup` 回收；每次带来源的查询（包括只读查询）都会写电路。
  - saveslot 要求来源记录与业务写入同事务、可哈希链校验、删除时能销毁——这三条 ProvSQL 都不满足。
- 规模：官网没有给出改写开销数据（[provsql.org](https://provsql.org/)）；未核实。
- 许可 MIT，约 75 star，维护活跃（v1.13.1，2026-11-01），2026 起大量代码由 Claude 辅助编写
  ([README](https://github.com/PierreSenellart/provsql/blob/23935cc8018f1593edee9eb115272aef5019e15d/README.md))。
  有 PGlite 的 WASM 构建（单进程内存电路存储）
  ([wasm/README.md](https://github.com/PierreSenellart/provsql/blob/23935cc8018f1593edee9eb115272aef5019e15d/wasm/README.md))，但不在 PGlite 官方扩展列表里。

### GProM：按需计算来源（与 saveslot 最契合的思路）

GProM 不预先存来源，而是靠数据库的审计日志 + 时间旅行，在被问到时用查询改写「重演」当时的查询或事务，算出来源
（[TaPP'14](https://www.eecis.udel.edu/~haoguo/tapp14_paper.pdf)、[Reenactment for RC-SI, arXiv:1608.08258](https://arxiv.org/pdf/1608.08258)、
[项目页](https://www.cs.uic.edu/~bglavic/dbgroup/projects/updateprov.html)）。saveslot 本来就有 change_log、带有效区间的版本表、确定性规则——
具备「重演」的全部前提。

### saveslot 能否对受限 SQL 自动得出行级来源？

能，而且不需要 ProvSQL：saveslot 自己生成规则 SQL 的「来源版」——对分组聚合，把 `SELECT key, agg(...) ... GROUP BY key` 改成
`SELECT key, base.id, base.version ... WHERE <原 WHERE>`（即 why-provenance 的 lineage）；对 join 同时输出两侧的 id；
对窗口函数输出帧内行（有界帧）或整个 PARTITION（无界帧）。代价（第 7 节）：如果每次刷新都**预先**写行级边，100 万行时单次写入从 1.7 ms 变成 11.3 ms，
且每次刷新写入约 3,500 条来源行（等于分组大小）；**按需计算**则平时零成本。

---

## 5. 从 SQL 文本提取列 / 表级依赖

| 工具 | 实现 | 许可 | 用在 saveslot |
|---|---|---|---|
| libpg_query | 把 PostgreSQL 自己的解析器抽成 C 库，输出解析树 | BSD-3（[libpg_query@73d842c](https://github.com/pganalyze/libpg_query/tree/73d842ce5362f83d7a999cb72b8a84667da48fae)） | **首选**：解析结果与 PostgreSQL 完全一致；有 Rust（[pg_query.rs](https://github.com/pganalyze/pg_query.rs)，MIT）、Go（BSD-3）、Node（[libpg-query-node@662d972](https://github.com/constructive-io/libpg-query-node/tree/662d9721bfef1f60385759d00a5e43817cb5e074)，MIT；是否为 WASM 构建未核实）绑定 |
| pglast | libpg_query 的 Python 绑定 + 反解析 | **GPL-3.0-or-later**（[pyproject.toml#L15](https://github.com/lelit/pglast/blob/575b005614f2cc0e66f2d0b4ebc727357c3432dd/pyproject.toml#L15)） | 若 saveslot 不是 GPL 兼容许可，不要打包进去 |
| sqlglot | 纯 Python 重新实现的多方言解析器，`qualify` 补全列归属后 `lineage()` 逐列追溯 | MIT | 适合原型；方言是重写的，与 PostgreSQL 可能有偏差 |
| OpenLineage SQL parser | Rust，基于 `sqlparser` 0.63 | Apache-2.0 | 主要借它的词汇：列级血缘分 DIRECT / INDIRECT |

- **sqlglot 的 `lineage()` 只追溯输出列的值从哪来**
  （[lineage.py#L93-L150](https://github.com/tobymao/sqlglot/blob/b99f5d58b1773276544b513e072273789cf2549a/sqlglot/lineage.py#L93-L150)，需要传入表结构）。
  本地实测一条带 join、WHERE、窗口函数的规则：`km → r.distance`、`ma4 → r.day, r.distance, r.user_id`，但 WHERE 里的 `r.deleted`、
  join 条件里的 `w.user_id`、`w.wk` 都**不在**任何输出列的血缘里；改用「qualify 后收集所有 Column 节点」才拿全。
- OpenLineage 的列级血缘规范正好区分这两类：INDIRECT 指「影响整个数据集的列，包括过滤、排序、分组、join、窗口函数」
  ([ColumnLineageDatasetFacet.json#L41](https://github.com/OpenLineage/OpenLineage/blob/6e9fd64478313b77884dd578cae94a1d9d32bc9a/spec/facets/ColumnLineageDatasetFacet.json#L41))。
- **对 saveslot**：依赖必须取 DIRECT ∪ INDIRECT（所有被引用的列），否则「改了 `deleted` 字段不触发刷新」。做法：libpg_query 解析 → 对**受限语法白名单**
  做自己的语义分析（解析表 / 列归属、分组键、窗口 PARTITION BY、join 键）→ 看不懂的节点一律拒绝。受限 SQL 本来就要白名单，
  依赖提取与之共用一棵树，可靠性来自「只接受能分析的写法」，而不是靠通用工具猜。

---

## 6. Teable 对照（摘自 references-mcp.md 第五节）

Teable 把依赖记成字段级边（`reference` 表），重算按层规划，源值没变就不再往下传；v1 同事务重算，v2 只同步前几层、其余进 outbox 异步，
并有 `syncMaxDirtyPerTable` 等阈值。saveslot 借三点：**字段级依赖边**（对应第 5 节的静态列级依赖）、**按层的重算计划 + 值不变就停**、
**把阈值改造成写入准入**（超了拒绝或拆批，不转异步）。

---

## 7. 本地实测（PGlite 0.5.15 / PostgreSQL 18.6 WASM，Node 24，单用户）

数据：`runs(id, user_id, day, distance numeric)`，在 `(user_id, day)` 上建索引，2000 个自然日均匀分布 → 约 286 个周分组。
派生表 `weekly(user_id, wk, km, n)`。每项取多次平均。

| 场景 | 1 万行 | 20 万行 | 100 万行 |
|---|---:|---:|---:|
| A 整用户重算（DELETE + INSERT…SELECT）+ 1 行写入，同事务 | 3.98 ms | 58.8 ms | 292.5 ms |
| B 只重算受影响的那一周 + 1 行写入，同事务 | 0.26 | 0.52 | 1.65 |
| B + 分区级来源（每次 1 行：表、用户、周区间） | 0.36 | 0.59 | 1.70 |
| B + 行级来源（每次重写该周全部贡献行的 id + 版本） | 0.82 | 2.75 | 11.29 |
| C pg_ivm，1 行 INSERT | 0.27 | 0.27 | 0.27 |
| C pg_ivm，1 行 UPDATE | 0.55 | 0.49 | 0.49 |
| C pg_ivm，一条语句插入 5000 行 | 14.5 | 12.8 | 14.4 |
| 不维护派生表，1 行 INSERT（基线） | 0.04 | 0.04 | 0.04 |

观察：B 的代价随分组大小增长（100 万行时每组约 3,500 行），C 与总量无关；但 B 在 saveslot 的数据量上限处也只有 1–2 ms。
分区级来源几乎零成本；行级来源的写放大与分组大小成正比。

---

## 8. 给 saveslot 的建议

### 8.1 同事务派生刷新：按「重算范围」分类，生成删除 + 重插

定义规则时由 saveslot 的分析器给每条 L1 规则算出**重算范围**，并要求派生表主键 = 该范围的键：

| 规则形态 | 重算范围 | 受影响的键怎么得出 |
|---|---|---|
| 分组聚合，分组键是基础列的确定性函数（如 `user_id, date_trunc('week', day::timestamp)`） | 分组 | 对被改行的**改前值与改后值**分别求分组键 |
| 窗口函数，有界帧（`ROWS 3 PRECEDING`） | 该 PARTITION 内受影响的帧 | 分组键 + 帧偏移（向后 N 个） |
| 窗口函数，无界帧 / 累计值 | 整个 PARTITION（通常是整用户） | PARTITION BY 键 |
| join 维度表（如支出 ↔ 预算类别） | 按 join 键反查事实表的分组 | 执行一次反查：受影响的维度键 → 引用它的分组键 |
| 分析不出 | 整用户 | — |

刷新 = 对每个受影响的键：`DELETE FROM derived WHERE <键>` + `INSERT INTO derived <原规则 SQL> AND <键谓词>`；
比较新旧结果的哈希，没变就不往下游传（Teable 的「值不变就停」）。按派生 DAG 的拓扑序逐层执行。
同一用户的写入用 `pg_advisory_xact_lock(user_id)` 串行，避免两个事务重算同一分组时冲突（单用户写入频率低，代价可忽略）。
这套只用普通 SQL，在 PostgreSQL、PGlite 上都能跑，将来要换 SQLite 也可以（SQLite 未实测）。

IVM（pg_ivm）**作为可选加速器**保留：只在某条规则的重算范围实测超出预算、且写法落在 pg_ivm 支持子集时启用，且 saveslot 仍需自己补记派生写日志。

### 8.2 血缘粒度：静态列级 + 动态分区级 + 按需行级

| 层 | 存什么 | 何时写 | 用途 |
|---|---|---|---|
| 静态列级依赖 | 规则版本 → 引用的（表，列），标 DIRECT / INDIRECT | 规则编译时 | 判断一次写入是否触发某规则（改的列不在依赖里就跳过）、schema 变更影响预览、派生表权限继承 |
| 分区级读集 | 派生写入 → （规则版本，基础表，分区键 / 谓词，日志位置） | 每次派生刷新，每个受影响分区 1 行 | 即 change_sources 里「上游写入」这一种来源的具体形式 |
| 行级来源 | 不存 | 需要时：在版本表上按「日志位置」重演规则的来源版 SQL | 审计展示「W45 的 22 由哪几条跑步构成」 |

这对应 data-model.md 里「来源由规则引擎按实际读到的输入自动记录」——建议把「实际读到的输入」落成**谓词 + 日志位置**，
而不是逐行列举；因为版本表有有效区间，谓词 + 位置能唯一还原出当时读到的行版本，信息不丢。

两个用途都够用：

- **删除级联**：派生缓存不存历史，删除基础行（及其历史版本内容）后，对受影响的分区按 8.1 重算即可。分组只剩被删的行 → 分组消失；
  还有其他行 → 结果自然不再依赖被删数据。「只来自被删数据就删、有其他来源就重算」在派生层自动成立，不需要行级边。
  行级来源真正需要的地方是**基础写入 ← 源数据**，那本来就是写入方随写入提交的少量显式边。
- **纠错影响查询**：read_log 记派生行的版本（change_id）→ 查它的分区级读集 → 判断被纠正的基础版本 C1 是否落在该分区谓词内、
  且 C1 的有效区间覆盖读集的日志位置。精确到分区；对带 WHERE 过滤的规则会略微多算（分区内被 WHERE 排除的行），
  可以再把 C1 的旧值代入 WHERE 复核消掉。

### 8.3 写入准入阈值

执行前算一个上界，执行中再兜底：

1. 由写入请求里的行（改前 + 改后值）和静态依赖，找出被触发的规则；按 8.1 求每条规则受影响的键。
2. **估算代价 = Σ 受影响分区的行数**。分区行数用一张同事务维护的计数表（键 → 行数）精确拿到，或退而用索引统计估算。
   下游规则：上游受影响的键映射成下游的键；映射不出就按整用户计。
3. 阈值分三项：受影响分区数、估算扫描行数、DAG 深度。超任一项 → 拒绝，返回「影响约 N 行 / M 个派生值，请拆成每批 ≤ K 行」。
   初始值可按第 7 节标定：例如估算扫描 ≤ 20 万行（PGlite 实测约 60 ms 量级），之后用线上数据调整。
4. 执行期：`SET LOCAL statement_timeout` 作硬上限，超时回滚并按同样的「请拆批」报错。
5. 天然无法拆的大改动（改了维度表的一行、牵动全部历史；改了派生规则本身）不走写入路径，复用 schema 迁移的「后台构建 + 原子切换」状态机。
   这样「永不转异步、派生值永不落后」仍然成立。

### 8.4 开放风险

1. **结果哈希 / 读取哈希可被暴力反推**：派生值（如「W45 = 22」）和很多基础值取值空间很小，普通哈希可被枚举反推，
   删除后墓碑和 read_log 里的哈希会泄露被删内容。建议用按用户（或按 thread）密钥的 HMAC，删除时连密钥一起销毁。
   这与 data-model.md「删除 = 销毁密钥」一致，但目前只写了源数据加密，没覆盖哈希。
2. **确定性边界**：`timestamptz` 相关函数依赖会话时区（STABLE），浮点聚合有误差，排序依赖 collation，PostgreSQL / ICU 升级可能改变结果，
   都会让「重算结果哈希」对不上。要固定会话参数（TimeZone、collation），白名单只放 IMMUTABLE 函数，数值统一 `numeric`；
   pg_ivm 的 IMMUTABLE 限制（实测）正好可作白名单参考。
3. **扇出大的规则**：无界窗口（累计值）、补录很早的历史数据、维度表变更，都会让一次写入牵动整用户的全部分组；
   准入阈值会频繁拦住它们，需要 8.3 第 5 条的旁路。
4. **静态分析的正确性**：依赖漏掉一列就会出现「派生值悄悄过期」，而且同事务刷新的设计会让人误以为它一定是新的。
   缓解：只接受白名单内的写法；后台定期抽样「全量重算 vs 缓存」对账（与 data-model.md 的日志重放对账合并）。
5. **L2 纯函数是黑盒**：只能按「读了声明的全部输入」算依赖，重算范围往往退化为整用户。
6. **多租户共享物理表时的锁**：如果将来启用 pg_ivm，共享 IMMV 的 `ExclusiveLock` 会把不同用户的写入串行。
7. 未实测：原生 PostgreSQL（非 WASM）下的数字、多规则 DAG 级联、并发写入下的 advisory lock 开销、SQLite 版本。
