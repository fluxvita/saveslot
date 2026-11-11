# 调研 01 · 时间数据（两条时间轴）

> 2026-11-09。范围：XTDB v2、SQL:2011 时态特性及各数据库实现（重点 PostgreSQL 17/18/19 现状）、
> Datomic（对照 Datalevin / XTDB v1）、Dolt、PostgreSQL 上的双时态实践与坑。最后是给 saveslot 的建议。
> 每条事实带出处；凡没找到一手来源的标「未核实」。

## 0. 结论先行

1. **PostgreSQL 目前只有“约束”，没有“写法”。** PG 18 已发布 `WITHOUT OVERLAPS` 主键 / 唯一约束和
   `PERIOD` 外键（仅 NO ACTION）；`UPDATE/DELETE ... FOR PORTION OF` 曾于 2026-04-01 提交进 PG 19，
   但在 **19 Beta 4 被撤回**，PG 19（计划 2026-11-19 GA）不含它；`PERIOD` 语法、系统版本表都还没有。
   所以“回溯改一段时间”的拆行逻辑 saveslot 必须自己写。
2. **saveslot 已有的 change_log + 版本表就是“系统时间轴”**，不需要外部组件；记录时间应以 change_log 序号
   为准、墙钟时间只做换算，避免 `now()` 取事务开始时间带来的乱序。
3. **业务时间按表种类分开建模**：event 表的时间是普通列（发生时刻），state 表是“生效区间”分段行
   （`tstzrange`/`daterange` + `WITHOUT OVERLAPS`），none 表只有记录时间。回溯改动 = 在一个事务里
   对若干分段行做 update/insert/delete，每段一条 change_log，再用一条“逻辑写入”把它们串起来。
4. **XTDB v2 是最贴近的参照**（每表双时态、SQL:2011 语法、`ERASE`），但它是 JVM、无 schema、
   无外键 / 唯一约束、面向对象存储的大规模引擎，MPL-2.0。**只借思路，不当组件。**
   Datomic 只有事务时间，且二进制 Apache-2.0 但不开源；Dolt 是提交级版本，粒度和隐私删除都不合适。
5. **派生规则必须声明时间依赖**：按业务时间分桶的（可缓存，按受影响桶重算）与依赖“今天”的
   （不可直接缓存，须显式传入评估时刻）要分开；回溯改动的受影响桶 = 改前和改后两个业务区间的并集。

---

## 1. XTDB v2

### 1.1 模型

- **每张表都是双时态的**，每行带 `_valid_from/_valid_to`（业务时间）和 `_system_from/_system_to`
  （系统时间），系统时间“至今”用 null 表示。不写时间子句时，查询默认“系统时间取最新、业务时间取现在”，
  官方说绝大多数查询用默认值即可。
  （https://docs.xtdb.com/about/time-in-xtdb.html）
- 查询语法是 SQL:2011 风格：`FOR VALID_TIME AS OF ...`、`FOR SYSTEM_TIME AS OF ...`。业务时间用来看“带纠错的整理后历史”，
  系统时间用来看“某时刻当时知道什么”（审计）。（同上）
- **写入**：每行必须有 `_id`；INSERT 可显式给 `_valid_from/_valid_to`，默认“现在 → 时间尽头”；
  同 `_id` 再 INSERT 等于 upsert，**覆盖指定业务区间（默认 now→∞）**。
  `UPDATE/DELETE ... FOR PORTION OF VALID_TIME FROM a TO b`（或 `FOR ALL VALID_TIME`）改一段；
  不写子句时默认 now→∞，文档承认这是对 SQL:2011 的偏离；`SET` 里不能改时间列。
  （https://docs.xtdb.com/reference/main/sql/txs.html）
- **系统时间不能回填到过去**：显式指定 `SYSTEM_TIME`（用于初次导入）必须严格晚于最近一个已完成事务，否则事务中止并记入 `xt.txs`。（同上）
- **`ERASE FROM t WHERE ...`**：对所有业务时间、所有系统时间不可逆地抹除，之后连按旧系统时间查也查不到，面向 GDPR。（同上）
- **schemaless、无外键、唯一性只靠 `_id`、单写者**：“does not require ... upfront schema definitions”，
  “no native concept of Foreign Keys”，“no concept of uniqueness beyond the ID”，
  “single-writer architecture”。（https://docs.xtdb.com/concepts/key-concepts.html）

### 1.2 存储与求值

- 列式引擎建在 Apache Arrow 上，面向对象存储；分布式时以日志为协调中心。走 Postgres wire protocol。
  （https://github.com/xtdb/xtdb/tree/d742ccba9c1fee67c52c94b5cace0237828cbb4d）
- 官方博客描述：日志/索引只记 `system_from` 与 `valid_from/valid_to`，**不存 `system_to`**；
  读时对每个实体按系统时间倒序重放事件，维护一条“天花板”（每段业务区间上尚未被覆盖的最晚系统时间），
  每个事件只输出它露出来的矩形；“当前”查询碰到第一个覆盖目标业务时刻的事件即可停。写入只是追加一行。
  （https://xtdb.com/blog/building-a-bitemp-index-2-resolution）
- 主索引是按表的、哈希分布的 LSM trie（Arrow 文件），文件不可变；新事件先在内存 HAMT，再上传；
  完整历史在对象存储，日志不必无限保留。（https://xtdb.com/blog/building-a-bitemp-index-3-storage ；
  此条经搜索摘要转述，未逐字核实）
- **性能边界**：同一实体版本极多（如每实体数万条 IoT 读数，每条业务区间很短）时，“天花板”长度是 O(n)，
  整体解析退化为 O(n²)；修复后回到 O(n)。博客同时说回溯纠错通常很少，天花板常态很小；没有给出基准数字。
  （https://xtdb.com/blog/taking-out-the-o-n-squared）

### 1.3 能否当组件

- 许可 **MPL-2.0**（GitHub API 读回 `license.spdx_id = MPL-2.0`）；最新正式版 **v2.2.0，2026-10-21**
  （https://github.com/xtdb/xtdb/releases/tag/v2.2.0）。
- 可在 JVM 进程内嵌（`xtdb-core`，要求 JDK 21+ 并加 `--add-opens`），否则作为服务经 pgwire/HTTP 访问。
  （https://docs.xtdb.com/drivers/clojure/getting-started ，https://docs.xtdb.com/drivers/java/getting-started）
- **判断：只借思路。** 理由：saveslot 已定 PostgreSQL；XTDB 无 schema、无外键/唯一约束，与 saveslot 的动态 schema +
  强校验相反；本地单用户版要拖一个 JVM；saveslot 的 change_sources / 哈希链 / 加密粉碎都要在它外面另做。
  **值得借的**：每表双时态 + 默认值约定（不写子句 = 当前知识、现在生效）；SQL:2011 语法作为对外查询形态；
  `ERASE` 置于时间线之外；“只追加写、读时解析”的思路（对应 saveslot 的 change_log + 版本表）。
  **要避开的**：upsert 默认覆盖到 ∞ 会把已登记的未来变化一并抹掉（见 §6 风险）。

---

## 2. SQL:2011 时态特性与各库实现

### 2.1 标准本身

（Kulkarni & Michels, “Temporal features in SQL:2011”, SIGMOD Record 41(3), 2012：
https://sigmodrecord.org/publications/sigmodRecord/1209/pdfs/07.industry.kulkarni.pdf）

- `PERIOD FOR p (start_col, end_col)` 定义周期，**闭开区间** `[start, end)`。
- **应用时间周期表**：用户自己赋值；`PRIMARY KEY (k, p WITHOUT OVERLAPS)` 禁止同键区间重叠；
  `UPDATE/DELETE ... FOR PORTION OF p FROM a TO b` 只改一段，**被切掉的剩余部分自动插回为新行**。
- **系统版本表**：`PERIOD FOR SYSTEM_TIME` + `WITH SYSTEM VERSIONING`，起止列 `GENERATED ALWAYS`，
  用户不能赋值或修改；INSERT 把起点设为“事务时间戳”，标准**交给实现决定这个值取什么**，只要求事务内固定；
  `FOR PORTION OF SYSTEM_TIME` 不允许。
- **双时态表** = 两者兼有；用 `FOR PORTION OF app-period` 修改。

### 2.2 实现对照

| 数据库 | 系统版本 | 应用时间（PERIOD / FOR PORTION OF / WITHOUT OVERLAPS） | 出处 |
|---|---|---|---|
| SQL Server 2016+ / Azure SQL | 有：当前表 + 历史表，`FOR SYSTEM_TIME AS OF / FROM..TO / BETWEEN / CONTAINED IN / ALL`；时间取**事务开始时间**（UTC）；同事务多次改同一行会产生零长度版本，查询时被过滤 | 无（官方文档只讲 system-versioned） | https://learn.microsoft.com/en-us/sql/relational-databases/tables/temporal-tables |
| MariaDB | 有，含按事务 ID 精确的版本（`AS OF TRANSACTION`、`mysql.transaction_registry`）、`PARTITION BY SYSTEM_TIME`；限制：版本表禁 `TRUNCATE`，`ALTER` 需开 `system_versioning_alter_history=KEEP` 且历史可能与新结构不一致 | 有：`PERIOD FOR`、`UPDATE/DELETE FOR PORTION OF`（落在中间会**拆成两行**）、`WITHOUT OVERLAPS`；可组合为双时态表（系统时间不能用于 FOR PORTION） | https://mariadb.com/docs/server/reference/sql-structure/temporal-tables/system-versioned-tables ，https://mariadb.com/kb/en/application-time-periods/ ，https://mariadb.com/kb/en/bitemporal-tables/ 。引入版本号（常见说法 10.3.4 / 10.4.3 / 10.5.3）**未核实** |
| Db2 (z/OS, LUW) | 有：`ADD VERSIONING USE HISTORY TABLE`，一个工作单元内多次更新只留一个历史版本 | 有：`BUSINESS_TIME`，起点含、终点默认不含；双时态表 | https://www.ibm.com/docs/en/SSEPEK_12.0.0/admin/src/tpc/db2z_temporaltables.html 。`FOR PORTION OF BUSINESS_TIME` 与 `BUSINESS_TIME WITHOUT OVERLAPS` 的 Db2 官方语法页**未直接读到**（Db2 是 SQL:2011 提案方之一，见上文 IBM 作者论文） |
| Oracle 12c+ | Flashback Data Archive / Flashback Query（本次未细读） | 部分：Temporal Validity，`PERIOD FOR` + `AS OF PERIOD FOR`、`DBMS_FLASHBACK_ARCHIVE.ENABLE_AT_VALID_TIME`；文档**未提** FOR PORTION OF 与 WITHOUT OVERLAPS | https://docs.oracle.com/en/database/oracle/oracle-database/18/vldbg/control-validity-visibility-data.html ，https://docs.oracle.com/en/database/oracle/oracle-database/26/arpls/DBMS_FLASHBACK_ARCHIVE.html |

### 2.3 PostgreSQL 现状（精确）

- **PG 17**：无。主键/唯一的 `WITHOUT OVERLAPS` 曾进入 v17 开发分支，但因未禁止空区间被撤回。
  （https://wiki.postgresql.org/wiki/ApplicationTimeProgress）
- **PG 18（已发布）**：
  - “Allow the specification of non-overlapping PRIMARY KEY, UNIQUE, and foreign key constraints (Paul A. Jungwirth)”，
    提交 `fc0438b4e`（https://postgr.es/c/fc0438b4e）、`89f908a6d`（https://postgr.es/c/89f908a6d）。
    （https://www.postgresql.org/docs/18/release-18.html）
  - `WITHOUT OVERLAPS` 列必须是 range 或 multirange，**不允许空区间**；`UNIQUE (id, valid_at WITHOUT OVERLAPS)`
    等价于 `EXCLUDE USING GIST (id WITH =, valid_at WITH &&)`，用 GiST 索引；标量列需 `btree_gist`
    （文档称“which is the expected way to use this feature”）。
  - `FOREIGN KEY (..., PERIOD col) REFERENCES t (..., PERIOD col)`：被引用方合起来**完全覆盖**引用方区间才算满足；
    被引用表须有 `WITHOUT OVERLAPS` 键；`RESTRICT/CASCADE/SET NULL/SET DEFAULT` 均“not supported”，只剩 NO ACTION。
    （https://www.postgresql.org/docs/18/sql-createtable.html）
- **PG 19（RC 阶段，计划 2026-11-19 GA）**：
  - `UPDATE/DELETE FOR PORTION OF` 于 2026-04-01 由 Peter Eisentraut 提交
    （https://www.postgresql.org/message-id/E1w7z1F-002UHl-1i@gemulon.postgresql.org），
  - **但 19 Beta 4 的变更里写明 “Revert support for temporal updates/deletes provided by the FOR PORTION OF clause”**
    （https://postgresql.org/about/news/postgresql-19-beta-4-released-3386）；RC1 公告没有恢复它，GA 定 11-19
    （https://www.postgresql.org/about/news/postgresql-19-rc-1-released-3409/）；GA 新闻稿草稿的特性列表也没有时态内容
    （https://www.postgresql.org/message-id/attachment/207950/release.en.md）。
  - 结论：**PG 19 不含 FOR PORTION OF**；最早 PG 20（2027 年秋，按年度节奏推测，未核实）。
- **仍在进行**（wiki）：`FOR PORTION OF`、外键 CASCADE/SET NULL/SET DEFAULT、`PERIOD` 语法（CREATE/ALTER、用于键与外键）
  均标“in development, see commitfest”；用户自定义类型“not yet”；外键 RESTRICT 因语义分歧推迟。
  **系统版本表（SYSTEM_TIME）wiki 未覆盖，PG 核心无此功能。**（https://wiki.postgresql.org/wiki/ApplicationTimeProgress）

### 2.4 PostgreSQL 扩展

| 扩展 | 做什么 | 维护状态 | 判断 |
|---|---|---|---|
| `periods`（xocolatl） | 用函数/视图/触发器模拟 SQL:2016 周期与系统版本：`add_period`、`add_unique_key`（唯一约束 + GiST 排斥约束）、`add_foreign_key`、`SYSTEM_TIME`（起点取 `transaction_timestamp()`）、历史表、`t__as_of()` 等内联函数；FOR PORTION OF **只模拟 UPDATE**（视图 + INSTEAD OF 触发器），README：“We see no way to simulate deleting portions of periods”。README 写兼容 PG 9.5–15。 | 最后正式 release v1.2.2 = 2022-10；最近提交 2025-10-08 “Upload for PostgreSQL 18”（看起来是 Debian 打包提交） | 思路可借，不依赖。https://github.com/xocolatl/periods/blob/b7bc4eac98d583afe474aade534da9478f94d13b/README.md |
| `temporal_tables`（arkhipov，C） | 只做系统版本：`sys_period tstzrange` + `versioning()` BEFORE 触发器 + 历史表；时间取 `CURRENT_TIMESTAMP`（事务内首条改动语句时间）；并发更新同一行可能 SQLSTATE 22000，可开 `adjust` 把起点挪到前值 +1µs；**不支持应用时间**。 | release v1.2.2 = 2023-09；最近提交 2026-01-12（PG17 Windows CI 修复） | 不需要：saveslot 的版本表由 change_log 维护。https://github.com/arkhipov/temporal_tables/blob/37e409e38059daf8574fc688a00ffac309da61c0/README.md |
| `temporal_tables`（nearform，PL/pgSQL 版） | 上者的纯 PL/pgSQL 移植（细节未核实） | release v1.2.1 = 2025-09 | 同上。https://github.com/nearform/temporal_tables/tree/1824073a3e4d062a70999952f4081d81206676c1 |
| `pg_bitemporal`（scalegenius） | 双时态函数库 | 最近提交 2021-07，事实上停更 | 不用。https://github.com/scalegenius/pg_bitemporal/tree/640db7ae9078c29a16818019e347fa135fb275b9 |

（维护状态均由 `gh api repos/<repo>` 与 `.../releases` 于 2026-11-09 读回。）

---

## 3. Datomic（对照 Datalevin、XTDB v1）

### 3.1 Datomic

- **只有事务时间。** `as-of` 返回“某时刻的数据库，忽略之后的事务”，时刻可以是 t、tx id 或 `Date`；
  `since` 只含之后添加的 datom；`history` 含现在与未过滤的过去（包括撤回）。过滤器作用在索引上，**不是免费的**，
  当前库无过滤成本。文档没有业务时间概念。（https://docs.datomic.com/reference/filters.html）
- **存储**：datom（E、A、V、Tx）四种排序的覆盖索引 EAVT/AEVT/AVET/VAET，T 降序。
  （https://docs.datomic.com/indexes/indexes.html）日志只增不删，撤回也是新事实；索引是“shallow trees of segments”，
  每段数千 datom；内存索引合并近期变化，后台索引任务偶尔生成新树。
  （https://docs.datomic.com/operation/architecture.html）
- **规模**：无硬上限，官方在约 100 亿 datom 处建议沟通。（https://ask.datomic.com/index.php/403/what-is-the-size-limit-of-a-datomic-cloud-database）
- **隐私删除 = excision**：在“Datomic 历史时间线之外”，从索引和日志里移除匹配 datom，在下一次索引任务时生效，
  每次 excision 留永久记录；官方明确“纠错用普通撤回，excision 不是纠错工具”。
  （https://docs.datomic.com/operation/excision.html）
- **许可**：2023-04 起各版免授权费，二进制 Apache-2.0；2023-08 发布可嵌入的 Datomic Local。
  （https://blog.datomic.com/2023/04/datomic-is-free.html ，https://blog.datomic.com/2023/08/datomic-local-is-released.html）
  官方 FAQ 称它“不是开源”，只是目标码授权（经搜索摘要转述，未逐字核实，https://www.datomic.com/cloud-faq.html）。
- 社区有一篇广为引用的文章指出不该拿 Datomic 的事务时间历史充当业务历史（观点概述，未逐字核实：
  https://vvvvalvalval.github.io/posts/2017-07-08-Datomic-this-is-not-the-history-youre-looking-for.html）。
  这正是 saveslot 要两条轴的原因：事务时间回答“当时知道什么”，回答不了“实际在 11-02 变了”。

### 3.2 对照

- **XTDB v1**：业务时间 + 事务时间；`put` 可带业务时间实现回溯/前瞻；事务时间不能是过去；delete 只改可见性，
  另有 `evict` 彻底删除；文档自称索引“partially persistent and fully retroactive”。
  （https://v1-docs.xtdb.com/concepts/bitemporality/）
- **Datalevin**：EPL-2.0，活跃（1.2.10，2026-10-28，`gh api` 读回）；维护者 2022 年说它“not an immutable DB, it's a regular DB”，
  即**不保留 as-of 历史**（聊天记录，非官方声明：https://clojurians-log.clojureverse.org/datalevin/2022-08-09）。
- **Datahike**：as-of / history 需开启时间索引，`:keep-history? false` 可关。
  （https://cljdoc.org/d/io.replikativ/datahike/0.6.1549/doc/time-variance）

### 3.3 能否当组件

不能：JVM + Datalog + EAV 模型与 saveslot 的 PostgreSQL 关系表不兼容；只有一条时间轴。
**可借**：“当前库零成本、历史视图按需过滤”的分工（对应 saveslot 的当前表 + 版本表）；excision 在时间线之外、留永久记录（对应 saveslot 的墓碑）。

---

## 4. Dolt / Doltgres

- **模型**：表数据存于 Prolly Tree，树根与元数据进提交图；内容寻址，相同子树只存一份（平均 4KB 块）。
  （https://docs.dolthub.com/architecture/storage-engine）行存，若一次给全表加/填一列，整棵树都变，跨提交共享失效。
  （https://dolthub.com/blog/2024-04-12-study-in-structural-sharing）
- **历史查询**：`SELECT ... AS OF 'branch' | TIMESTAMP(...)`，`dolt_history_<t>`（每行每个修订一行）、
  `dolt_diff_<t>` / `dolt_commit_diff_<t>`；**快照单位是 Dolt commit，SQL 事务提交默认不产生 commit**。
  （https://www.dolthub.com/docs/sql-reference/version-control/querying-history）
  可设 `@@dolt_transaction_commit=1` 让每个 SQL 事务都成为 Dolt commit。
  （https://docs.dolthub.com/reference/sql/dolt-sysvars）
- **删除历史中的敏感数据**：`dolt filter-branch` 重写历史 + `dolt gc`，与 git 一样会改变之后所有提交的哈希。
  （https://www.dolthub.com/blog/2020-11-30-dolt-filter-branch/）
- **Doltgres**：2026-08-06 发布 1.0，自称“99% Postgres compatible”、约慢 2.7 倍；扩展（如 PostGIS）、行级安全等仍在路线图。
  （https://dolthub.com/blog/2026-08-06-doltgres-1-0/）早期 beta 升级到 1.0 有不可恢复数据丢失事故。
  （https://dolthub.com/blog/2026-09-04-postgres-data-loss-post-mortem）
- 许可 Apache-2.0；dolt v2.7.2（2026-11-05）、doltgresql v1.5.0（2026-11-05）（`gh api` 读回）。

**是否适合 saveslot：不适合当底座。**
- 只有一条“提交时间”轴，没有业务时间；
- 版本粒度是提交，若每次写入一个提交，等于自己再造 change_log，却拿不到 change_sources 与源数据链接；
- 隐私删除要重写 Merkle 历史，与 saveslot 的“哈希链 + 墓碑 + 加密粉碎”冲突（saveslot 要的是删内容、留链）；
- Doltgres 不是真 PostgreSQL，扩展（`btree_gist` 是否可用未核实）、行级安全缺失，saveslot 的行级隔离依赖这些。
**可借**：`dolt_diff_<t>` 式“两个时刻之间按行 diff”的对外接口形态——saveslot 用版本表即可提供同样的 diff。

---

## 5. PostgreSQL 上的双时态实践与坑

### 5.1 常用部件

- **区间列**：`tstzrange` / `daterange`，闭开 `[)`；离散类型（`daterange`）自动规范成 `[)`；无界端等价 ±∞；
  `[4,4)` 规范为 `empty`。（https://www.postgresql.org/docs/18/rangetypes.html）
- **非重叠**：PG 18 起 `PRIMARY KEY (k, valid WITHOUT OVERLAPS)`；更早或多维时用
  `EXCLUDE USING GIST (k WITH =, valid WITH &&)` + `btree_gist`。（同上；https://www.postgresql.org/docs/18/sql-createtable.html）
- **系统时间**：当前表 + 历史表 + 触发器（SQL Server、temporal_tables、periods 的共同形态）。
- **时态外键**：PG 18 `PERIOD` 外键（只 NO ACTION）。

### 5.2 已知的坑

1. **回溯拆行（sequenced modification）**：改 `[a,b)` 一段，要把与之相交的每个旧段裁短、在中间插新段、
   必要时在两边补“剩余段”。PG 18/19 没有 `FOR PORTION OF`，只能自己写；`periods` 也只能模拟 UPDATE。
   Snodgrass 专门区分 current / sequenced / nonsequenced 三类查询和修改，并给出纯 SQL 写法。
   （Snodgrass, *Developing Time-Oriented Database Applications in SQL*, 第 6、7、10 章：https://www2.cs.arizona.edu/~rts/tdbbook.pdf）
2. **重叠与空区间**：`WITHOUT OVERLAPS` 禁空区间（v17 就是因此撤回的）；拆行时容易产生 `[t,t)`，要在写入层先剔除。
3. **合并（coalescing）**：相邻、值相同的段应否合并？Snodgrass 把它当成与去重同类的操作（同书第 6 章 “Coalescing”）。
   合并会丢掉“哪段来自哪个来源”，对 saveslot 的来源链不利。
4. **“事务时间戳”不等于提交顺序**：SQL:2011 交给实现决定，只要求事务内固定（Kulkarni 论文）；SQL Server 取事务开始时间
   （微软文档）；temporal_tables 取首条改动语句时间，并发更新会冲突，需要 `adjust` 挪 1µs（其 README）。
   用墙钟当系统时间轴会出现“后提交的版本起点更早”。
5. **按时间聚合**：每周跑量、某月预算这类聚合，在 state 表上需要区间与分桶求交（按天数加权或取某时点值），
   语义要显式定；对 event 表则是按发生时刻落桶。回溯改动会把记录从一个桶挪到另一个桶，两边都要重算。
6. **派生数据依赖业务时间**：Fowler 的工资例子——回溯加薪不会自动修正已据旧值做出的动作（已发的工资、跨阈值的月份），
   需要“应当如何”的并行模型来算补偿。“Retroactive changes are a problem when actions are based on a past state that's
   retroactively changed.”（https://martinfowler.com/articles/bitemporal-history.html）
7. **两条轴的默认值**：XTDB 默认“系统最新 + 业务现在”；upsert / 无子句 UPDATE 默认覆盖 now→∞
   （https://docs.xtdb.com/reference/main/sql/txs.html）。“从 11-02 起变成 3000”若已存在 11-20 的变化，
   覆盖到 ∞ 会抹掉它——必须定义是“到下一个已知变化为止”还是“到 ∞”。
8. **时区与粒度**：“11-02”是用户所在时区的日期，不是 UTC 瞬间。Snodgrass 第 3 章专讲瞬间、粒度（granule）。

---

## 6. 给 saveslot 的建议

### 6.1 两条轴的定义

| 轴 | saveslot 里叫 | 物理表示 | 谁赋值 |
|---|---|---|---|
| 记录时间（system / transaction time） | `rec` | **change_log 序号 `seq`（每用户单调 bigint）**；另存 `recorded_at timestamptz`，写入时取 `greatest(上一条 recorded_at, clock_timestamp())` 保证单调 | saveslot，永远不可由调用方指定 |
| 业务时间（valid / business time） | `valid` | event 表：发生时刻列；state 表：`tstzrange` 或 `daterange` 区间列 | 写入方（Agent / 用户），可回溯、可前瞻 |

理由：每用户只有一个权威节点（DRAFT 已定），对该用户的写入加每用户 advisory lock 串行化，`seq` 就等于提交顺序，
避开 §5.2-4 的乱序问题；日志复制时 `seq` 原样带走，副本重建版本表结果一致。
“按时刻读 2026-11-05 10:00”先换算成 `max(seq) where recorded_at <= T`，再按 seq 查。

### 6.2 三种表的存储布局

所有基础表都有：当前表 `t`（Agent 查询、约束都在这）+ 版本表 `t__ver`（data-model 里已定的“change_log 的索引”）。

```sql
-- 公共列（每张基础表）
row_id     uuid      -- saveslot 的行身份，change_log 按它记“哪一行”
rec_from   bigint    -- 当前版本由哪条 change_log 写入

-- 版本表：当前表列 + 区间；关闭的版本搬进来（或当前版本也在其中，rec_to 为 NULL）
CREATE TABLE t__ver (LIKE t, rec_to bigint NULL, -- NULL = 仍为当前
                     PRIMARY KEY (row_id, rec_from));
-- 按时刻读 seq=S：WHERE rec_from <= S AND (rec_to IS NULL OR rec_to > S)
```

**(a) `none` 表**（偏好、项目元信息）：只有上面这些。只有“as of”。

**(b) `event` 表**（跑步、支出、一次会议）：

```sql
occurred_at   timestamptz NOT NULL,   -- 发生时刻（schema 可声明为 date 粒度：occurred_on date）
occurred_tz   text        NOT NULL,   -- 发生地/用户时区，保证“哪一天”可复算
occurred_end  timestamptz NULL        -- 有持续时间的事件可选；事件之间允许重叠
INDEX (occurred_at)
```

- 业务时间就是**普通数据列**，不是“生效区间”：“一次跑步发生在 t”这条事实本身不过期。
- 回溯改动（“那次跑步其实是 11-02”）= 对该行一次普通 update，change_log 的前后整行自带新旧 `occurred_at`。
- “valid at / 时间窗”查询 = `WHERE occurred_at` 落在窗口内。

**(c) `state` 表**（预算、体重目标、项目状态）：一行 = 一个实体在一段生效区间里的值（分段行）。

```sql
entity_id  uuid       NOT NULL,       -- 被跟踪的事物（这本账的月预算）
valid      tstzrange  NOT NULL CHECK (NOT isempty(valid)),  -- 或 daterange，schema 声明粒度
...业务列...
PRIMARY KEY (entity_id, valid WITHOUT OVERLAPS)   -- PG 18+，需 btree_gist
-- 同一实体在“当前知识”下区间不重叠；允许有空档（表示那段时间没有值）
```

- 版本表上**不能**加同样的约束（不同记录版本之间区间本来就会重叠）；可加一条双时态一致性约束做自检：
  `EXCLUDE USING gist (entity_id WITH =, valid WITH &&, int8range(rec_from, rec_to) WITH &&)`——
  同一实体任意两个版本不能在两条轴上同时重叠。
- 若目标环境须兼容 PG 17 及以下，用等价的 `EXCLUDE USING GIST (entity_id WITH =, valid WITH &&)`。
- **不在存储层自动合并**相邻同值段（保住各段来源）；查询层提供可选的 coalesce。

### 6.3 查询

| 想问什么 | 写法（saveslot 的受限 SQL / 简单查询参数） | 实现 |
|---|---|---|
| 现在知道的、现在生效的（默认） | 不写参数 | state：`valid @> now_param`；event、none：直接查当前表 |
| 业务时间 T 时是什么（valid at） | `valid_at: T` | state：`valid @> T`；event：不适用，改用窗口 `occurred_at in [a,b)` |
| 业务时间区间内的历史（sequenced） | `valid_during: [a,b)` | state：`valid && [a,b)`，返回时可 `valid * [a,b)` 截取 |
| 当时知道什么（as of） | `as_of: seq 或时刻` | 改读 `t__ver`，`rec_from <= S < coalesce(rec_to, ∞)` |
| 两轴都给 | `as_of: S, valid_at: T` | 在 as-of 版本集合上再按业务时间过滤（复现“那次任务当时看到的 11-05 预算”） |
| 两个记录时刻之间改了什么 | `diff: S1..S2` | 版本表 / change_log 按行 diff（借 Dolt 的接口形态） |

- `now_param` 由 saveslot 在请求入口取一次并**写入 read_log**，受限 SQL 内仍禁 `NOW()`（data-model 已定）。
- 对外语法可以直接采用 SQL:2011 / XTDB 风格的 `FOR SYSTEM_TIME AS OF`、`FOR VALID_TIME AS OF`，由 saveslot 改写成上面的谓词——
  不依赖 PG 原生支持，将来 PG 有了也可平滑替换。

### 6.4 回溯改动怎么写进 change_log

以“预算 [10-01, ∞) = 5000，11-09 得知其实 11-02 起是 3000”为例：

1. 写入请求带**逻辑操作**：`{op: "set_state", entity, valid: "[2026-11-02, next)", values: {amount: 3000}, change_kind: "retroactive", evidence…}`。
2. saveslot 在一个事务里计算拆行（相当于自己实现 `UPDATE ... FOR PORTION OF`）：
   - 段 A `[10-01, ∞) 5000` → update 为 `[10-01, 11-02) 5000`；
   - 插入段 B `[11-02, ∞) 3000`（若 `next` 解析为已存在的 11-20 变化，则为 `[11-02, 11-20)`）。
3. change_log 每个受影响的段各记一条基础写入（前后整行，含 `valid`）；另记一条**逻辑写入头**
   `write_id`，带原始逻辑操作、`change_kind`、源数据链接；各段条目引用这个 `write_id`。
   重放用记下的后像，不重新跑拆行算法（避开算法版本变化带来的不确定）。
4. 版本表：段 A 旧版本 `rec_to = 本次 seq`，新版本与段 B `rec_from = 本次 seq`。
5. **区分三种变更**（data-model 里“纠错 vs 正常变更”要扩成三种）：

| change_kind | 含义 | 业务区间 | 之前读取是否受影响 |
|---|---|---|---|
| `prospective` | 从现在或将来起变 | `valid` 起点 ≥ 写入时的 now | 否 |
| `retroactive` | 事实在过去已变，saveslot 晚知道了 | 起点 < now | 是，但**只限读取时所问业务时刻落在被改区间内的那些** |
| `correction` | 原记录本来就错 | 任意 | 是，同上 |

   因此 **read_log 除了“读到的行版本”，还要记业务时间选择器**（`valid_at` / `valid_during` / 窗口），
   否则 10-15 那次“查 10 月预算”的读取会被误判为受影响。这一点 data-model 现稿没有，建议补。

6. event 表的回溯（改 `occurred_at`）就是单行 update，`change_kind` 同样适用。

### 6.5 派生规则怎么表达时间依赖

规则在 schema 里声明 `time_dependence`：

| 类别 | 例子 | 能否缓存 | 刷新范围 |
|---|---|---|---|
| `none` | 项目任务数 | 能 | 按普通依赖 |
| `valid_bucketed` | 每周跑量、每月支出 | 能，派生行带桶键（周、月） | 规则声明桶函数，如 `bucket = date_trunc('week', occurred_at AT TIME ZONE occurred_tz)`；受影响桶 = 改前行与改后行业务时间所落桶的**并集**（从 change_log 前后整行算出），state 表用区间与桶求交 |
| `clock` | 本月剩余预算、近 7 天平均 | **不能按“今天”缓存** | 改写为显式参数 `:at`；要么读时计算，要么按桶缓存（“11 月剩余预算 = 预算(11 月) − 支出(11 月)”变成 `valid_bucketed`），读时选当前桶 |

- 受限 SQL 提供时间函数白名单：`valid_at(t, :at)`、`overlap_days(valid, bucket)`、`bucket(ts, 'week', tz)`；禁 `NOW()`。
- 派生缓存只保存“当前知识”下的结果（data-model 已定不存历史）；按时刻读派生值时，用 `seq=S` 的版本表输入
  + **S 时生效的规则版本**重算，规则版本须随 schema 版本可回查。
- 派生写入的 change_sources 由引擎按“实际读到的分段行版本”记录，回溯改动能沿它找到受影响的派生桶与下游。
- 已据旧值采取的外部动作（Fowler 的补发工资）不在 saveslot 的派生范围：saveslot 负责通过“纠错影响查询 + 变化告知”把它暴露给产品层。

### 6.6 隐私删除与两条轴

- 删除按血缘级联时，当前表与版本表里的对应版本都要销毁内容、留墓碑（与 XTDB `ERASE`、Datomic excision 一样处于时间线之外，
  但 saveslot 保留哈希链与墓碑）；as-of 查询碰到墓碑返回“已删除”标记，不报错。
- state 表删一段后会留下空档；`PERIOD` 外键若引用该实体，会因不再完全覆盖而拦住删除——要么不对 state 表用 PG 时态外键，
  要么删除级联里先处理引用方。

---

## 7. 开放风险

1. **PG 时态 DML 落地时间不确定**：`FOR PORTION OF` 已在 19 被撤，saveslot 自写的拆行逻辑要长期维护；将来切到原生实现时，
   语义（剩余段的触发器、默认 now→∞ 与否）需对齐。
2. **“到下一个变化”还是“到 ∞”**：`set_state` 的默认右端点是产品语义，Agent 说“从 11-02 起变成 3000”时很难分辨；
   建议默认“到下一个已知变化”，把会覆盖的后续段在写入回执里列出来让 Agent 确认。未经用户场景验证。
3. **`WITHOUT OVERLAPS` 依赖 PG 18 + `btree_gist`**：托管 PG 与本地嵌入 PG 的版本、扩展可用性要统一；动态 schema
   下每张 state 表都会建 GiST 索引，迁移（原子切换）时重建成本未测。
4. **read_log 记业务时间选择器**会增加记录量和匹配复杂度；对任意受限 SQL，从语句里提取“问的是哪段业务时间”并不总是可行，
   兜底只能按行版本多报。
5. **粒度与时区**：date 粒度与 instant 粒度混用（预算按天、跑步按秒）时的区间运算、用户换时区后的“哪一天”需要明确规则。
6. **按时刻重算派生值的成本**：派生不存历史，as-of 派生值要重放；单用户量小（千到百万行）一般可接受，但规则版本、
   schema 版本、迁移函数都要可回查，否则无法复现。
7. **版本表膨胀**：高频小改的 state 实体会产生大量段与版本；XTDB 在“每实体数万版本”时曾遇到 O(n²)
   （https://xtdb.com/blog/taking-out-the-o-n-squared）。saveslot 走 btree/GiST 索引不会有同样的算法问题，但需要压测。
8. **未核实项**：MariaDB 各特性引入版本号；Db2 `FOR PORTION OF BUSINESS_TIME` 官方语法页；Oracle 是否支持 FOR PORTION OF；
   Doltgres 是否支持 `btree_gist` / 排斥约束；XTDB 存储细节以博客为准，可能已变化；PG 20 时间线。
