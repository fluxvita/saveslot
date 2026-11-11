# 04 · 在线 schema 变更与迁移工具

> 调研日期 2026-11-09。服务于 [`../data-model.md`](../spec/03-data-model/README.md)「schema 版本演进」里的「迁移中 → 切换」两步。
> GitHub 链接尽量钉到调研时的 commit：
> pgroll `448b29b`、Reshape `1c52737`、gh-ost `dd44453`、pg-osc `042c6ee`、pg_repack `c38de8e`、postgres `553262a`。
> 标「本地实测」的结论来自在 PGlite 0.5.15（内核 PostgreSQL 18.6）上跑的小脚本；标「未核实」的是推断或二手说法。

## 结论先行

1. **现成工具解决的问题和 saveslot 的问题不一样。** pgroll / Reshape 解决的是「应用分批发布期间，新旧两版 schema 都要能读写」；
   gh-ost / pg-osc / pg_repack 解决的是「一张大表的物理改造不能锁表」。saveslot 的约束是「对外只有最新版、旧版写入直接拒绝」
   「每个用户数据量小」「所有写入都经过 saveslot 自己的 API 并已记入应用层日志」。所以 saveslot **不需要**双版本并行读写（pgroll 最贵的
   那部分：触发器双写、版本化视图），也**不需要**追 binlog/WAL（saveslot 自己的 change_log 就是那条日志）。
2. **都不能直接拿来用，只能借思路。** pgroll（Apache-2.0，活跃）是唯一值得认真考虑的，但它面向「人写的迁移文件 + 应用设 search_path」，
   依赖 Go 二进制、事件触发器、表级 DDL，迁移类型里也没有「从日志重建」和「模型重新抽取」；saveslot 用它等于把核心状态机交给一个外部工具，
   而且在 PGlite 上能否跑通未核实。gh-ost 是 MySQL 专用；pg-osc 维护停滞（最后提交 2024-11）；pg_repack 是 C 扩展且只做去膨胀。
3. **saveslot 的切换不应该靠 DDL 改名，而应该靠「当前版本指针」的一行数据更新。** 物理表按版本命名、永不改名；切换 = 在一个事务里
   追完最后一段日志 + 更新指针行。这样切换只锁 saveslot 自己的一行（或一个事务级 advisory lock），不需要表级 `ACCESS EXCLUSIVE`，
   读完全不受影响，写只在这一行锁上排队几毫秒。gh-ost 的「哨兵 + 原子 rename」、pg-osc 的「`ACCESS EXCLUSIVE` 下 rename」
   都是在没有应用层指针的前提下不得不做的事。
4. **托管多租户最大的风险是 catalog 规模，不是迁移本身。** 「每用户 × 每表 × 每版本 × 派生表 × 索引」若都落成独立的物理表，
   一万用户就是百万级 relation；有一手材料显示 20 万张表时每个后端的 catalog 缓存可达数 GB 到十几 GB。托管形态的物理布局
   要单独定（共享表 + user_id，或每用户一个独立库/PGlite 实例），迁移机制要和物理布局解耦。

---

## 1. pgroll（Xata）

### 实现

- **expand/contract 两阶段。** `start` 只做加法（建表、加列、建索引），不兼容的改动先造一个新列/新约束让新版成立；
  `complete` 再做减法（删旧列、删旧 schema、把临时列改成正式名）。
  [docs/concepts.md](https://github.com/xataio/pgroll/blob/448b29ba2215da4619d2eb8ee543957c6acfa95a/docs/concepts.md)
- **多版本 = 每次迁移一个 PostgreSQL schema，里面是指向物理表的视图。** 改列名只需要新 schema 里视图用新名字；
  加 `NOT NULL` 这类改动则复制出一列 `_pgroll_new_<col>`，回填 + 触发器双向同步，新视图暴露新列、旧视图暴露旧列。
  [docs/concepts.md](https://github.com/xataio/pgroll/blob/448b29ba2215da4619d2eb8ee543957c6acfa95a/docs/concepts.md)、
  [README「How pgroll works」](https://github.com/xataio/pgroll/blob/448b29ba2215da4619d2eb8ee543957c6acfa95a/README.md#how-pgroll-works)
- **客户端靠 `search_path` 选版本。** 应用连上后 `SET search_path = public_02_add_assignee_column`。
  [docs/guides/clientapps.mdx](https://github.com/xataio/pgroll/blob/448b29ba2215da4619d2eb8ee543957c6acfa95a/docs/guides/clientapps.mdx)
- **触发器按调用方的 `search_path` 判断方向**：`search_path` 不等于最新版 schema 时执行 `up` 表达式写新列，等于时执行 `down` 写旧列。
  [pkg/backfill/templates/function.go L5-L30](https://github.com/xataio/pgroll/blob/448b29ba2215da4619d2eb8ee543957c6acfa95a/pkg/backfill/templates/function.go#L5-L30)
- **回填分批**，每批默认 1 万行；用内部列 `_pgroll_needs_backfill` 标记哪些行还没回填，避免回填覆盖期间的新写入。
  [README「Benchmarks」](https://github.com/xataio/pgroll/blob/448b29ba2215da4619d2eb8ee543957c6acfa95a/README.md#benchmarks)、
  [docs/tutorial.md L187-L189](https://github.com/xataio/pgroll/blob/448b29ba2215da4619d2eb8ee543957c6acfa95a/docs/tutorial.md?plain=1#L187-L189)
- **锁：** 所有 DDL 前 `SET lock_timeout`（默认 500ms），超时自动重试（带抖动）。
  [cmd/root.go L87-L89](https://github.com/xataio/pgroll/blob/448b29ba2215da4619d2eb8ee543957c6acfa95a/cmd/root.go#L87-L89)、
  [pkg/roll/roll.go L110](https://github.com/xataio/pgroll/blob/448b29ba2215da4619d2eb8ee543957c6acfa95a/pkg/roll/roll.go#L110)、
  [pkg/db/db.go](https://github.com/xataio/pgroll/blob/448b29ba2215da4619d2eb8ee543957c6acfa95a/pkg/db/db.go)
- **状态** 存在 `pgroll` schema 的 `migrations` 表里；还装了两个**事件触发器**（`ddl_command_end`、`sql_drop`）把绕过 pgroll 的 DDL 记成「inferred」迁移。
  [pkg/state/init.sql L122-L129](https://github.com/xataio/pgroll/blob/448b29ba2215da4619d2eb8ee543957c6acfa95a/pkg/state/init.sql#L122-L129)
- **同一 schema 同时只有一个进行中的迁移**（由约束保证唯一）。
  [pkg/roll/execute.go L62-L71](https://github.com/xataio/pgroll/blob/448b29ba2215da4619d2eb8ee543957c6acfa95a/pkg/roll/execute.go#L62-L71)
- **回滚：** `complete` 之前任何时候都能 `rollback`，删掉新 schema 和临时结构，旧版原样保留；`complete` 之后不支持回滚
  （raw SQL 的 `onComplete` 与 `down` 互斥即因此）。
  [README「Rolling back」](https://github.com/xataio/pgroll/blob/448b29ba2215da4619d2eb8ee543957c6acfa95a/README.md#rolling-back-a-migration)、
  [docs/operations/raw_sql.mdx](https://github.com/xataio/pgroll/blob/448b29ba2215da4619d2eb8ee543957c6acfa95a/docs/operations/raw_sql.mdx)
- **逃生口** `sql` 操作：pgroll 明说无法保证安全。同上链接。

### 边界

- 迁移文件是一组声明式操作（add_column / alter_column / rename_table …），**跨表的重构（拆表、合表）、按任意函数重算、
  从外部来源重新生成数据都不在模型里**，只能落到 raw SQL。
  [docs/operations/](https://github.com/xataio/pgroll/tree/448b29ba2215da4619d2eb8ee543957c6acfa95a/docs/operations)
- 迁移期间每次写入多跑一个触发器（官方有 WriteAmplification 基准，数值见其 benchmark 页，本文未摘录）。
  [README「Benchmarks」](https://github.com/xataio/pgroll/blob/448b29ba2215da4619d2eb8ee543957c6acfa95a/README.md#benchmarks)
- 应用要自己管理 `search_path`；用 PgBouncer 事务池时 `SET` 不被支持（见第 6 节），需要用启动参数或 `SET LOCAL`。

### 许可与维护

- Apache-2.0。[LICENSE](https://github.com/xataio/pgroll/blob/448b29ba2215da4619d2eb8ee543957c6acfa95a/LICENSE)
- 活跃：最新 v0.16.3（2026-09-08），最近推送 2026-11-02，约 6.6k star，105 个 open issue（`gh api`/`gh release list` 读回，2026-11-09）。
  [Releases](https://github.com/xataio/pgroll/releases)

### saveslot 能否直接用

**不建议直接用，借三个点。**

- 不合适：saveslot 要的是「后台构建新版 → 原子切到新版 → 旧版只读保留」，pgroll 的核心价值是「两版并行读写一段时间」，
  saveslot 恰恰规定按旧版写入要拒绝；pgroll 的迁移类型覆盖不了「从日志重建」「重新抽取」；状态放在外部工具里会和 saveslot 自己的
  schema 版本表、change_log 形成两套真相。
- PGlite：pgroll 用 `lib/pq` 走线协议连接，PGlite 只能通过 pglite-socket 暴露线协议，而 PGlite 本质是单连接、
  socket 层的多路复用是变通（[pglite-socket](https://pglite.dev/docs/pglite-socket)、[PGlite docs](https://pglite.dev/docs/)）。
  PL/pgSQL 和事件触发器在 PGlite 上能建（本地实测），**pgroll 整体能否跑通未核实**。
- 借鉴：(a) 用 `lock_timeout` + 带抖动重试包住所有 DDL；(b) 「每个版本一个命名空间，里面是视图」作为对外 SQL 的稳定名字层；
  (c) 「同一 schema 同时只有一个进行中的迁移」用数据库约束保证，而不是靠应用逻辑。

## 2. Reshape（pgroll 的前身/灵感）

### 实现

- 与 pgroll 同构：每次迁移一个 schema，里面是视图；触发器在新旧表示之间翻译写入；三步 `start` → 发布应用 → `complete`，
  失败 `abort` 无损回退。
  [README「How it works」](https://github.com/fabianlindfors/reshape/blob/1c52737b3213bede6997815d4b1f59c6b9174eba/README.md#how-it-works)
- 判断「这次写入来自新版还是旧版」：辅助函数 `reshape.is_new_schema()` 比较 `current_setting('search_path')`，
  或读自定义 GUC `reshape.is_new_schema`。
  [src/helpers.rs L8-L14](https://github.com/fabianlindfors/reshape/blob/1c52737b3213bede6997815d4b1f59c6b9174eba/src/helpers.rs#L8-L14)
- **比 pgroll 多一点：跨表迁移。** `up`/`down` 可以引用另一张表（例：把 `users.email` 挪到 `profiles`、1:N 改 N:M），
  触发器在两张表之间同步。
  [README「Complex changes across tables」](https://github.com/fabianlindfors/reshape/blob/1c52737b3213bede6997815d4b1f59c6b9174eba/README.md#complex-changes-across-tables)
- 作者 2022-01 的介绍文章自称「experimental / proof-of-concept」，当时多表改动尚未实现。
  [blog](https://fabianlindfors.se/blog/schema-migrations-in-postgres-using-reshape/)

### 许可与维护

- MIT。[LICENSE.md](https://github.com/fabianlindfors/reshape/blob/1c52737b3213bede6997815d4b1f59c6b9174eba/LICENSE.md)
- 2026 年重新活跃：v0.11.0–0.11.2 于 2026-09-09 发布，README 增加了「Using with coding agents」并推广作者的 Specific 平台；
  约 1.9k star。[Releases](https://github.com/fabianlindfors/reshape/releases)、
  [README](https://github.com/fabianlindfors/reshape/blob/1c52737b3213bede6997815d4b1f59c6b9174eba/README.md)

### saveslot 能否直接用

不能（同 pgroll 的理由，且是 Rust CLI、需要应用设 `search_path`）。值得借的是：**跨表迁移用「目标表 + 取值表达式 + 关联条件」
三元组声明**——这正好是 saveslot「确定性转换」迁移函数可以采用的受限形状，比任意代码好审、好试跑。

## 3. 影子表 + 追日志 + 切换：gh-ost、pg-osc、pg_repack

### gh-ost（GitHub，MySQL）

- **无触发器**：伪装成 MySQL 副本读 row-based binlog，过滤出原表的行事件，和分块拷贝一起顺序应用到 ghost 表上；
  异步，所以切换时 binlog 里还可能有没应用完的事件。
  [doc/triggerless-design.md](https://github.com/github/gh-ost/blob/dd44453f489bdeb8bee5b93194a0a481e001e598/doc/triggerless-design.md)
- **切换**：先锁原表写入，再追完 binlog 积压，然后交换表名。MySQL 不允许持锁的连接自己 rename，所以 gh-ost 用
  「一个连接持锁 + 另一个连接发原子 `RENAME`，并用一张哨兵表挡住 `RENAME` 直到确认追平」；要么原子成功，要么超时/连接断开
  自然退回切换前状态，可再试。
  [doc/cut-over.md](https://github.com/github/gh-ost/blob/dd44453f489bdeb8bee5b93194a0a481e001e598/doc/cut-over.md)、
  [issue #82](https://github.com/github/gh-ost/issues/82)
- 切换持锁上限 `--cut-over-lock-timeout-seconds` 默认 3 秒，可指数退避重试；`--postpone-cut-over-flag-file` 让「追平但不切」
  无限期等人放行；切换前检查 `performance_schema.metadata_locks` 确认 rename 会话确实拿到排他元数据锁，否则有小概率丢数据。
  [doc/command-line-flags.md](https://github.com/github/gh-ost/blob/dd44453f489bdeb8bee5b93194a0a481e001e598/doc/command-line-flags.md)
- 支持 checkpoint 续跑，以及**切换后回退**：从 checkpoint 表记下的切换点继续读 binlog，把旧表追上来再切一次；文档明确提示
  反向迁移可能不可行（例如新版里插入了旧版放不下的值）。
  [doc/resume.md](https://github.com/github/gh-ost/blob/dd44453f489bdeb8bee5b93194a0a481e001e598/doc/resume.md)、
  [doc/revert.md](https://github.com/github/gh-ost/blob/dd44453f489bdeb8bee5b93194a0a481e001e598/doc/revert.md)
- MIT，活跃（v1.1.11，2026-08-17）。[LICENSE](https://github.com/github/gh-ost/blob/dd44453f489bdeb8bee5b93194a0a481e001e598/LICENSE)、[Releases](https://github.com/github/gh-ost/releases)

### pg-osc（PostgreSQL）

- 流程：建 audit 表 → 短暂 `ACCESS EXCLUSIVE` 加触发器（写入同步记进 audit 表）→ 建影子表并在上面执行 `ALTER` → 拷贝全部行 →
  建索引 → 回放 audit 表（边放边删）→ 剩余约 20 行时在一个事务里拿 `ACCESS EXCLUSIVE`、交换表名、对引用表以 `NOT VALID`
  重建外键 → `ANALYZE` → `VALIDATE` 外键。
  [README「How does it work」](https://github.com/shayonj/pg-osc/blob/042c6eefd7e5eb59044fd99cf1c42d26ddf022cf/README.md#how-does-it-work)
- 切换事务里 `statement_timeout` 设 5s，表名交换就是两条 `ALTER TABLE … RENAME`。
  [lib/pg_online_schema_change/orchestrate.rb L7、L263-L290](https://github.com/shayonj/pg-osc/blob/042c6eefd7e5eb59044fd99cf1c42d26ddf022cf/lib/pg_online_schema_change/orchestrate.rb#L263-L290)
- 已知限制：必须有主键；不支持分区表；对父表拿两次 `ACCESS EXCLUSIVE`；可选 `--kill-backends` 杀掉抢锁的会话；索引/约束名会变。
  [README「Few things to keep in mind」](https://github.com/shayonj/pg-osc/blob/042c6eefd7e5eb59044fd99cf1c42d26ddf022cf/README.md#few-things-to-keep-in-mind)
- MIT；最后一次提交 2024-11-03，维护基本停滞。

### pg_repack（PostgreSQL 扩展）

- 目的是在线去膨胀/重排，不是改 schema。流程与 pg-osc 相同（log 表 + 触发器 + 新表 + 回放），但**交换是直接改系统 catalog**
  （连同索引与 TOAST 表），只在开头和结尾短暂持 `ACCESS EXCLUSIVE`，中间持 `SHARE UPDATE EXCLUSIVE`（期间不能对该表做 DDL）。
  [doc/pg_repack.rst「Full Table Repacks」](https://github.com/reorg/pg_repack/blob/c38de8e4a6ce0e5c0f1192f535d1bf765c009b25/doc/pg_repack.rst)
- 需要超级用户或表 owner（`--no-superuser-check`）；表须有主键或非空唯一索引。同上链接。
- BSD 类许可（NTT / Reorg 团队版权）；活跃（最新 tag `ver_1.5.3`，最近推送 2026-10-27）。
  [COPYRIGHT](https://github.com/reorg/pg_repack/blob/c38de8e4a6ce0e5c0f1192f535d1bf765c009b25/COPYRIGHT)
- PGlite：是 C 扩展，PGlite 的扩展需要专门编译进 WASM，扩展列表里未见 pg_repack（[pglite.dev/extensions](https://pglite.dev/extensions/)；以列表为准，未逐项核实）。

### 对 saveslot 的意义

- 三者的共同结构 = **初始拷贝 + 变更日志 + 追平 + 短暂排他 + 切换**，正是 data-model.md 里「迁移中 → 切换」的形状；
  saveslot 的区别是变更日志已经存在（change_log，与业务写入同事务），**不需要触发器也不需要 binlog/WAL 解码**。
- gh-ost 的两条经验直接可用：(a) 「追平但不切换」可以无限期停住等人放行——对应 saveslot 重新抽取迁移的「待人确认差异」；
  (b) 切换失败要**自然退回切换前**而不是半途状态。
- pg-osc 的反面教材：rename 物理表会让依赖它的东西（外键、视图、名字）都要跟着修，且必须拿 `ACCESS EXCLUSIVE`。
  saveslot 若物理表名不变、只换指针，这一整类问题不存在。

## 4. 声明式迁移与安全分析：Atlas、Prisma Migrate、Alembic

- **Atlas**：声明式（给目标状态，引擎规划动作）与版本化（`atlas migrate diff` 计算「迁移历史终态 ↔ 新 schema」的差生成文件）两种工作流。
  [declarative-vs-versioned](https://atlasgo.io/concepts/declarative-vs-versioned)
  - **dev database**：一个临时、隔离、与生产同引擎同版本的空库，用来把期望 schema 规范化成数据库的「规范形式」再比对
    （避免写法不同导致的假差异），并在规划阶段就把迁移真跑一遍，错误在 plan 时暴露。
    [dev-database](https://atlasgo.io/concepts/dev-database)
  - **lint 分析器**：破坏性（DS101–103，删 schema/表/列）、依赖数据（MF101–104，如加唯一索引/`NOT NULL` 可能因现有数据失败）、
    向后不兼容（BC101–104，改名/删表删列会弄坏旧客户端）是免费的；阻塞（PG301–320，改写/锁表）、并发索引（PG1xx）、
    「限制性变更」（会拒绝旧版客户端读写）等是 Pro。[lint/analyzers](https://atlasgo.io/lint/analyzers)
  - 许可：社区版 Apache-2.0，但**不含 `migrate lint`、声明式工作流、drift 检测**；默认二进制按 Atlas MSA 发布，lint 要 `atlas login` 解锁 Pro。
    [community-edition](https://atlasgo.io/community-edition)、[ariga/atlas](https://github.com/ariga/atlas)
  - 多租户：每个租户的 schema 或库是 target group 里的一个 target，schema-per-tenant 与 database-per-tenant 同样处理，
    部署时长随租户数增长、需调 rollout 并发。[database-per-tenant intro](https://atlasgo.io/guides/database-per-tenant/intro)
- **Prisma Migrate**（Apache-2.0）：`migrate dev` 在 shadow database 上重放迁移历史并内省，得到「历史终态」，与当前 Prisma schema 比较生成 SQL，
  并评估数据丢失给出警告；同一机制用于检测 drift。生产命令 `migrate deploy` 不用 shadow DB。
  [shadow-database](https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/shadow-database)、
  [prisma/prisma](https://github.com/prisma/prisma)
- **Alembic**（MIT）：autogenerate 能识别增删表/列、可空性、索引/唯一约束/外键的基本变化；**识别不了改名**（表现为删 + 加，会丢数据），
  官方明说「不打算完美」，每个生成的迁移都要人工审。
  [autogenerate](https://alembic.sqlalchemy.org/en/latest/autogenerate.html)、[sqlalchemy/alembic](https://github.com/sqlalchemy/alembic)

### 对 saveslot 的意义

- **改名歧义是所有基于名字 diff 的工具的通病**（Alembic 明说，Atlas/Prisma 也是按名字比对）。saveslot 的稳定字段 ID 正好消掉这个问题；
  只有「整份新 schema 提交」路径才需要猜，data-model.md 已规定猜不准就退回给 Agent 澄清——与这些工具的做法一致且更严格。
- **dev database / shadow database = saveslot「已编译 → 已预览」的实现方式**：在隔离环境里真跑一遍迁移（saveslot 可以直接在影子表上跑，
  因为影子表本身就是隔离的），规划阶段暴露错误，而不是切换时。
- **lint 分类可以直接作为 saveslot 风险分级的骨架**：破坏性（删字段）/依赖数据（新约束现有数据不满足）/向后不兼容（影响消费方）/
  阻塞（对 saveslot 不适用，因为 saveslot 不在线改表）。saveslot 多一类：「需要模型重新抽取」。
- 这些工具都不能直接嵌入 saveslot：saveslot 的 schema 是运行时由 Agent 提交的数据，不是仓库里的迁移文件；Atlas 的 lint 还不在开源版里。

## 5. PostgreSQL DDL 锁的现实

### 事实

- `ALTER TABLE` **默认拿 `ACCESS EXCLUSIVE`**，除非文档单独注明；多个子命令取最严的那个。注明较弱锁的只有：`ADD FOREIGN KEY`
  （`SHARE ROW EXCLUSIVE`）、`VALIDATE CONSTRAINT` / `SET STATISTICS` / 存储参数等（`SHARE UPDATE EXCLUSIVE`）、启停触发器
  （`SHARE ROW EXCLUSIVE`）等。`RENAME` 没有被单列，因此是 `ACCESS EXCLUSIVE`。
  [sql-altertable（PG 18）](https://www.postgresql.org/docs/current/sql-altertable.html)
- 「快」不等于「不锁」：加带非易失默认值的列只改元数据、不重写表，但仍是 `ACCESS EXCLUSIVE`；加易失默认值、改列类型（非二进制兼容）
  会重写整表和索引，且重写类 `ALTER TABLE` 不是 MVCC 安全的（旧快照会看到空表）；`SET NOT NULL`/`CHECK` 要全表扫描，
  用 `NOT VALID` + 后续 `VALIDATE`（`SHARE UPDATE EXCLUSIVE`）拆开。同上链接。
- `ACCESS EXCLUSIVE` 与所有锁冲突，是唯一会挡住 `SELECT` 的锁；`DROP TABLE`、`TRUNCATE`、非并发 `REINDEX`、`VACUUM FULL`、
  非并发 `REFRESH MATERIALIZED VIEW` 都拿它。锁一般持有到事务结束。
  [explicit-locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- **锁排队**：新请求若与**已持有或正在等待**的请求冲突就要排队，且冲突请求按到达顺序授予——所以一个排队中的 `ACCESS EXCLUSIVE`
  会挡住它后面所有普通读写，哪怕它自己还没拿到锁。这就是「DDL 等一个长事务 → 整张表停摆」的根源。
  [src/backend/storage/lmgr/README（Lock acquisition rules）](https://github.com/postgres/postgres/blob/553262aff40d34711e04e989e91d1da430589822/src/backend/storage/lmgr/README)
- **`lock_timeout`** 只在等锁时计时、每次获取单独计；与 `statement_timeout` 同值或更大则没有意义；不建议在 `postgresql.conf` 全局设置。
  当前版本还有 `transaction_timeout`（引入版本未核实）。标准用法是 DDL 会话 `SET lock_timeout = '…ms'` + 失败重试（pgroll 即如此）。
  [runtime-config-client](https://www.postgresql.org/docs/current/runtime-config-client.html)
- **事务性 DDL**：PostgreSQL 的 DDL 可回滚，例外是建/删数据库与表空间
  （[wiki，2012 年旧文](https://wiki.postgresql.org/wiki/Transactional_DDL_in_PostgreSQL:_A_Competitive_Analysis)）；
  另外 `CREATE INDEX CONCURRENTLY` 不能在事务块里执行（[sql-createindex](https://www.postgresql.org/docs/current/sql-createindex.html)）。
  所以「多张表一起改名 + 换视图」可以放进一个事务原子提交，但并发建索引必须放在事务外、切换之前做完。
- **视图按 OID 绑定，不按名字。** 把表 A 改名为 A_old、表 B 改名为 A 之后，原来 `SELECT * FROM A` 的视图仍指向 A_old
  （`pg_get_viewdef` 显示 `FROM t_old`）。**本地实测**（PGlite 0.5.15 / PG 18.6）。因此「交换表名」不会让视图跟过去，视图必须重建。
- **`CREATE OR REPLACE VIEW` 只能保持原列（同名、同序、同类型）并在末尾追加**；列改名/删列要 `DROP VIEW` + `CREATE VIEW`，
  这两步可以在一个事务里完成（本地实测）。单表简单视图自动可更新，`INSERT` 经视图写进底表（本地实测，文档：
  [sql-createview](https://www.postgresql.org/docs/current/sql-createview.html)）。视图 DDL 的具体锁级别文档未写明，按
  「多数 ALTER/替换拿 `ACCESS EXCLUSIVE`」推断，**未核实**。
- **预备语句与缓存计划**：被引用对象发生 DDL 时会强制重新分析/规划；`search_path` 变了会按新路径重新解析（9.3 起）；但
  「在 `search_path` 更前面新建同名表」不会触发重新解析。
  [sql-prepare](https://www.postgresql.org/docs/current/sql-prepare.html)
- **一个事务锁很多对象**受 `max_locks_per_transaction`（默认 64，按平均值共享整张锁表，改了要重启）约束。
  [runtime-config-locks](https://www.postgresql.org/docs/current/runtime-config-locks.html)

### 对「构建新版后原子交换」的含义

1. 只要切换依赖 DDL（rename 表、重建视图），就要拿 `ACCESS EXCLUSIVE`；拿锁前必须有 `lock_timeout` + 重试，否则一个长读事务
   就能借锁队列让该用户整张表停摆。
2. rename 物理表对视图无效（OID 绑定），所以「影子表改名上位」的方案还得同时重建所有引用它的视图、外键（pg-osc 就是这么做的）。
3. 更好的做法是**切换时不做 DDL**：物理表从建出来起就叫版本名，切换只更新一行「当前版本指针」。指针由 saveslot 的查询编译器解析，
   或者（若对外提供真实 PG 视图）在同一事务里重建这一用户的「当前」视图层——此时锁只落在视图上，没有底表的长事务干扰。

## 6. schema-per-user 的规模

- **catalog 缓存是按后端的。** pgsql-hackers 上 2018 年的讨论描述过一个约 20 万张表的应用，估计每个后端的 `CacheMemoryContext`
  可达数 GB 到十几 GB；2023 年有提议把 relcache/catcache 拆成独立内存上下文以便观测，Andres Freund 指出 catcache 很容易被撑大；
  2026 年仍有人在做「缩小 `RelationData`」，测试 schema 为 38,966 张表 + 148,468 个索引。截至调研未见已合入的 relcache/catcache
  上限或淘汰机制（**未核实**是否已有补丁合入）。
  [2018 Horiguchi](https://www.postgresql.org/message-id/20180309.174001.202113825.horiguchi.kyotaro%40lab.ntt.co.jp)、
  [2023 Freund](https://www.postgresql.org/message-id/20231012170105.zhybmddizcm4kmii%40awork3.anarazel.de)、
  [2026 Geier](https://www.postgresql.org/message-id/f97de758-b816-47db-96e0-0e6e2c2d3eef%40gmail.com)
- **运维实例**（厂商案例，偏轶事）：单库 17,000–19,000 个同构租户 schema（PG 11），autovacuum 跟不上、XID 年龄涨到约 2.92 亿才报警、
  一个跨几千 schema 的单事务批处理让锁管理器条目暴涨，备份涨到 12 TB；补救之一是把单事务 DO 块改成逐对象释放锁的存储过程。
  [Command Prompt 案例](https://www.commandprompt.com/about/success-stories-case-studies/from-unrecoverable-to-under-control-taming-multi-tenant-postgresql-at-17000-schemas/)
- **连接池与 `search_path`**：PgBouncer 事务池模式下 `SET`/`RESET`、SQL 级 `PREPARE`、会话级 advisory lock 都不支持；
  协议级预备语句需设 `max_prepared_statements`；其他启动参数要靠 `track_extra_parameters`。
  [pgbouncer features](https://www.pgbouncer.org/features.html)。
  含义：靠 `search_path` 选用户/选版本（pgroll、Reshape 的方式）在事务池下要改成每事务 `SET LOCAL` 或全限定名；事务级
  advisory lock（`pg_advisory_xact_lock*`）不受影响。
- **迁移工具如何应对上千租户**：Atlas 把每个租户 schema 当作一个 target 批量 rollout，耗时随租户数线性增长
  （[Atlas](https://atlasgo.io/guides/database-per-tenant/intro)）；pgroll 一次只针对一个 `--schema`
  （[cmd/root.go L87](https://github.com/xataio/pgroll/blob/448b29ba2215da4619d2eb8ee543957c6acfa95a/cmd/root.go#L87)），
  多租户要外部循环。上述案例说明：**跨租户批量操作必须一个租户一个事务**，否则撞锁表上限。
- **saveslot 的特殊点**：saveslot 的 schema 是「每个用户各不相同、且会频繁演进」的，不是 SaaS 常见的「同构租户 schema、统一升级」。
  因此 saveslot 托管时没有「一次迁移所有租户」的问题（每个用户的迁移各自独立、各自很小），但有**对象总数**问题：
  每用户 N 张基础表 + 派生表 + 索引，迁移中还要 ×2。一万用户 × 30 个 relation × 2 ≈ 60 万 relation（粗算，非实测），
  已在上面 20 万表的量级之上。

---

## 7. 对 saveslot 的建议

### 7.1 方案选择：日志重建进新的物理表 + 指针切换

| 方案 | 读路径 | 切换 | 适合 saveslot 吗 |
|---|---|---|---|
| 版本化视图 + 同表双写（pgroll/Reshape） | 两版并行 | `complete` 时删旧列、改名，DDL | 否：saveslot 不要两版并行写；跨表/重新抽取表达不了；同表加列改列都是 DDL |
| 影子表 + 触发器/日志 + rename（pg-osc/gh-ost） | 单版 | `ACCESS EXCLUSIVE` 下 rename，视图/外键要重建 | 部分：结构对，但 rename 不必要 |
| **从 change_log 重建进按版本命名的新表 + 切指针** | 单版（经 saveslot 解析） | 一个事务：追完日志 + 改指针行 | **是** |

推荐第三种，具体机制如下。

**物理布局**

- 每个 schema 版本的每张基础表、派生表都是独立物理表，名字含稳定的表 ID 与版本号（如 `t_<table_id>_v<n>`），**建出来就不再改名**。
- saveslot 的目录里有一行「当前版本指针」：`schema_head(schema_set_id, current_version, migrating_version, state)`。
- 所有读写都经过 saveslot 的 API / 受限 SQL 编译器，把逻辑表名解析到「指针指向的那一版」的物理表。受限 SQL 本来就要编译（白名单、权限），
  加一步名字重写成本很低。
- 若将来要给高级用户开放直连 SQL，再为每个用户提供一个「current」schema 的视图层；切换时在同一事务里 `DROP VIEW` + `CREATE VIEW`
  （视图按 OID 绑定，必须重建；本地实测可行）。

**迁移中（后台构建）**

1. 建新版物理表（含派生表），建索引——此时没有任何人读写它们，普通 `CREATE INDEX` 即可，不需要 `CONCURRENTLY`。
2. 记下起点 `log_pos₀`，把起点时的旧版状态按迁移函数（或重新抽取）灌进新表。小数据量下可以直接「从 change_log 全量重放」，
   这也顺带验证了「日志可重建状态」这条不变量。
3. 循环追平：读 `log_pos > 上次位置` 的 change_log，按迁移函数应用到新表。分小批、每批一个短事务，避免在 PGlite 单连接上长时间挡住前台写入。
4. **派生表在影子侧同步维护**：每批基础变更应用后，按**新版规则**刷新新版派生表（与前台「基础写入与派生刷新同事务」同一套引擎）。
   规则版本随 schema 版本一起 +1。数据量小时，最后一步也可以直接对新版派生表全量重算一次，更简单。
5. 重新抽取类迁移：新表里的值是「提议」，与已确认值不同的进待确认；这一步可以停留很久（gh-ost 的 postpone-cut-over 思路），
   期间第 3 步持续追平；用户在旧版上做的纠错是源数据，追平时一并按新版重新抽取，不会丢。

**切换（一个事务）**

```
BEGIN;
  SET LOCAL lock_timeout = '200ms';                 -- 拿不到就放弃、稍后重试，旧版照常
  SELECT … FROM schema_head WHERE schema_set_id=$1 FOR UPDATE;   -- 或 pg_advisory_xact_lock(key)
  -- 追完 log_pos > 上次位置 的最后一段，应用到新版基础表与派生表
  -- 校验：新版行数/哈希与预期一致；派生表重算结果与增量结果一致（可选）
  UPDATE schema_head SET current_version = v2, migrating_version = NULL, state = 'current' …;
  INSERT INTO change_log (… 'schema_cutover' 事件, v1 → v2, 截止 log_pos …);
COMMIT;
```

- **写入如何「暂停极短时间」**：每次写事务开头对同一行拿 `FOR SHARE`（或 `pg_advisory_xact_lock_shared(key)`），并在同一事务里
  读出 `current_version` 与请求带的 schema 版本比对。切换持 `FOR UPDATE`/排他 advisory lock 时，写入在这一行上排队；切换提交后
  写入拿到锁，读到的已是 v2——**带 v1 的写入在这里被拒**（「schema 已更新到 v2，请重新读取」），与「写入带预期版本」同一机制。
  锁只落在 saveslot 自己的一行上，不涉及任何表级 `ACCESS EXCLUSIVE`，所以不会借锁队列连累读。
  事务级 advisory lock 在 PgBouncer 事务池下可用（[pgbouncer features](https://www.pgbouncer.org/features.html)）。
- **读永不停**：读不拿这把锁。切换提交前的读看到 v1 指针和 v1 表，提交后看到 v2；v1 表在切换后保留（已退役、只读），所以一个
  恰好跨在切换点上的读也不会读到不存在的表。多语句读用 `REPEATABLE READ`，保证指针与数据来自同一快照；读取结果带上实际使用的版本号。
- **哈希链顺带保证日志顺序**：change_log 是哈希链，同一条链的追加必须串行，因此追平时按位置读不会漏掉「编号小、提交晚」的事务。
  如果以后改成多条链并行追加，追平要改用快照水位（如 `pg_current_snapshot()` 的 xmin）而不是单纯的序号（**未核实**具体实现，需在实现时验证）。

**切换前回滚**

- 失败或被否决：把 `migrating_version` 置空、状态记为失败，删掉新版物理表（`DROP TABLE` 只锁这些没人用的表）。旧版自始至终是当前版本，
  什么都没变——data-model.md「失败是安全的」直接成立。
- 删表可以异步做；先改状态再删，确保崩溃后重启能识别出孤儿表并清理（pgroll 的「状态表 + 唯一进行中迁移约束」值得照抄）。

**切换后**

- 不提供「回滚」，只提供「再做一次前向迁移」：反向迁移可能不可行（gh-ost 文档的例子：新版里写入了旧版容纳不了的值，
  [doc/revert.md](https://github.com/github/gh-ost/blob/dd44453f489bdeb8bee5b93194a0a481e001e598/doc/revert.md)）。
  若要在短窗口内允许撤销，可以继续在后台用反向函数把 v1 表追平（gh-ost revert 的思路），但只对可逆的确定性迁移开放。
- 退役版本的物理表保留多久、按时刻读是查退役表还是从日志重放，留到存储设计时定（见「开放风险」）。

### 7.2 只改元数据的改动

改名、加可选字段这类改动不建新表：字段 ID 不变、物理列名用字段 ID（如 `f_<field_id>`）而不是显示名，改名只改目录；加可选字段要
`ADD COLUMN`（无默认值或非易失默认值，不重写表，但仍是 `ACCESS EXCLUSIVE`，[sql-altertable](https://www.postgresql.org/docs/current/sql-altertable.html)），
放在拿到指针锁的同一个短事务里、带 `lock_timeout` 执行即可。数据量小，这一步是毫秒级；或者干脆也走「建新版表 + 切指针」，统一成一条路径。

### 7.3 托管多租户的物理布局（必须单独决定）

迁移机制本身与物理布局无关，但物理布局决定 catalog 规模：

| 选项 | catalog 规模 | 迁移 | 备注 |
|---|---|---|---|
| 每用户一组物理表（同一库） | relation 数 ∝ 用户数 × 表数 × 2 | 最直接 | 万级用户即进入有报告问题的量级；需要监控 relcache、autovacuum、XID 年龄 |
| 共享物理表 + `user_id`，值按字段 ID 存（如 jsonb 或 EAV 变体） | 与用户数无关 | 新版 = 同表里新 `schema_version` 的行，切换仍是改指针 | 受限 SQL 编译器负责投影成类型化的列；类型化索引、统计信息变差 |
| 每用户一个独立库（或一个 PGlite 实例/文件） | 每库很小 | 最直接，且与本地部署完全同构 | 连接/实例管理成本高；PGlite 单连接 |

建议：迁移层只依赖「按 (schema_set, version) 解析到物理存储」这一抽象，托管布局做一次专门的压测再定。本地单用户部署
（含 PGlite）用「每用户一组物理表」没有问题。

### 7.4 开放风险

1. **指针解析的覆盖面**：任何绕过 saveslot 编译器直接访问物理表的路径（运维脚本、将来的直连 SQL、BI 工具）都看不到切换；必须要么只给视图层，要么不开放。
2. **重新抽取迁移期间旧版持续被写**：追平要把这些写入按新版重新抽取，抽取需要模型、慢、可能失败；需要定义「追平不收敛」时怎么办
   （限流旧版写入？允许带着待确认项切换？）。
3. **切换事务的长度**：最后一段日志若很长（例如重新抽取的人工审核拖了几天，期间积压大量写入），切换事务会变长、写入暂停变长。
   应在切换前反复追平，直到剩余量低于阈值再进入切换（pg-osc 的 delta-count、gh-ost 的「追平后才切」）。
4. **跨 schema_set 的派生规则**：若派生表依赖多个 schema_set（如健康 + 记账），一次切换只锁一个指针不够；要么规定派生表只依赖同一 schema_set，
   要么切换时按固定顺序锁多个指针（防死锁）。
5. **退役版本的存储成本**：切换后旧表保留会让 relation 数翻倍；何时可以丢弃并改为从日志重放来回答按时刻读，需要和「按时刻读」设计一起定。
6. **PGlite 单连接**：后台构建与前台读写共用一条连接，必须切成小批短事务交替执行；切换事务期间前台完全等待（数据小，可接受，但需实测）。
7. **托管 catalog 规模**：见 7.3；20 万表级别已有每后端数 GB 缓存的报告，需要在选定布局后压测。
8. 本文对 PostgreSQL 视图 DDL 的具体锁级别、pgroll 在 PGlite 上的可用性、catcache/relcache 是否已有上限机制，均**未核实**。
