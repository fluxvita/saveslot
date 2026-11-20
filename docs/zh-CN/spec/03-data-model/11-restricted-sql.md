# saveslot · 数据层机制 · 11 受限 SQL

> 数据层机制的一部分，目录见 [`README.md`](README.md)。文中「…」引用的节可能在同目录的其他文件里，按目录查。

## 受限 SQL

受限 SQL 是 saveslot 里唯一让调用方写 SQL 的地方。三种场合共用一个解析器、一份白名单、一套改写：只读查询 `sql`、派生规则（L1）、schema 变更的转换表达式（`migrate` 与表达式形式的 `backfill`）。

**白名单的实现是"不认识的一律拒绝"。** 语法树里的每个节点、每个运算符、每个函数、每个类型转换，都要在本文的表里找到、并且在当前场合允许，否则整条拒绝。没有"列出要拒绝的"那种写法；本文的"不收"各表只用来说明理由，不是实现的依凭。

**为什么只靠语法树**：安全与确定性在同一处保证（内核不变量 K9）。PGlite 上角色可被 `SET ROLE` 逃逸、`statement_timeout` 不生效，语法树白名单是那里唯一的防线；PostgreSQL 上另有只读角色、只读事务与 `statement_timeout` 作第二道（「查得出」）。派生规则与转换表达式要在重放时、在两个后端上得出同样的结果，这也只能在白名单里管住。

外部基线：PGlite 当前内置 PostgreSQL 18；解析用 libpg_query 对应 PostgreSQL 18 的分支，本文的节点名照它的写法。

### 三种场合

| | `sql` | 派生规则 | 转换表达式 |
|---|---|---|---|
| 写的是什么 | 一条 `SELECT` | 一条 `SELECT`，最外层是分组聚合或不分组的整体聚合（「刷新范围与写入准入」） | 一个标量表达式，不是语句 |
| 何时校验 | 每次调用 | schema 编译时，存为按 ID 绑定的文本（事件格式的 `rule.sql`） | schema 编译时，存为按 ID 绑定的文本（`migrate.sql`、`backfill.sql`） |
| 何时求值 | 调用时 | 派生刷新（与基础写入同一事务）、读时计算、重放、编译时试跑 | 编译时试跑、schema 切换、重放 |
| 能引用什么 | 可见范围内任何 slot 的表 | 本 slot 的基础表与派生表 | 只有本字段在 `base_version` 里的名字与常量 |
| 结果进不进重放 | 不进 | 进：重放时按规则重算 | 进：重放时按定义重算 |
| 参数 `$n` | 可以 | 不可以 | 不可以 |
| `saveslot_now()`、`saveslot_today()` | 可以 | 可以，规则因此归入依赖"今天"一类，读时计算 | 不可以 |
| 拒绝时报什么 | `sql_rejected`（细分见「拒绝时报什么」） | `validation_failed`（`schema`），明细码 `rule_sql_rejected` / `nondeterministic_function` / `unit_inference_failed` / `cross_slot_ref` | `validation_failed`（`schema`），明细码 `rule_sql_rejected` / `nondeterministic_function` / `migrate_failed` |

- **白名单只有一份**，下面每张表都标出各项在哪些场合允许。`sql` 的结果不重放，但同样只收结果确定的项：读取记录与影响查询按"读到了哪些版本"对账，同一条查询在两个后端上应当读到同样的东西；白名单也只维护一份。
- **只在 `sql` 里允许的**，是结果取决于行的先后次序的写法（`ORDER BY` 之后的 `LIMIT` / `OFFSET`、`DISTINCT ON`、`row_number()`、`lag()`、`ROWS` 帧……）。同一份数据，它们可能给出不同的结果，当一次调用的回答可以，当派生缓存不行。
- **转换表达式最窄**：逐项求值，输入只有这一项的旧值（「schema 文档格式」「确定性转换怎么重放」）。不收表、子查询、聚合、窗口、参数与时刻。它独有的是从 `text` 转成数与布尔，会因值而失败：编译时的试跑、确认时对试跑之后新写入的重新求值、迁移中带旧 `sv` 的写入，三处都可能报 `migrate_failed`（见「拒绝时报什么」）。

### 处理步骤

1. **长度检查**：文本超过上限直接拒绝（「代价」）。
2. **词法扫描**：用 libpg_query 的扫描器取出词元，识别 saveslot 自己的时间写法 `FOR VALID_TIME …`，把它从文本里摘出，记下它跟在哪个表引用后面；遇到 `FOR SYSTEM_TIME` 直接拒绝。PostgreSQL 的语法里没有这两种写法，不先摘出来，解析器会报语法错。扫描在注释与字符串字面量之外进行。所用的 JS 绑定要提供扫描、解析与反解析三个接口，实现时核实。
3. **解析**：解析成语法树。必须恰好一条语句，且是 `SelectStmt`。转换表达式包成 `SELECT <表达式>` 解析，要求恰好一个输出项、没有任何子句。
4. **白名单校验**：遍历整棵树，核对节点种类与形式、运算符符号、函数名、类型转换的目标类型、各项的上限。只看语法树，不看数据、不连数据库：同一条文本，放行与否在任何数据上都一样，所以可以离线做模糊测试。
5. **名字解析**：表名、字段名、系统列解析成表 ID、字段 ID（「名字」）。派生规则与转换表达式在编译时做完这一步并存下绑定后的文本，之后表或字段改名不影响它们。`sql` 在这一步之后得到一棵绑定后的树，其中每个 FROM 项、每个列引用、每个输出列的名字都是这一步生成的（「执行的文本里没有留给数据库解析的名字」）。
6. **类型与单位**：推出每个表达式的类型与单位；按参数类型核对函数与运算符的签名（同一个函数名，有的签名收、有的不收，见「白名单」）；推出输出列的类型与单位（派生字段由此回填）。
7. **改写**，只在内核里做，作用在第 5 步绑定后的树上：
   - 调用方写的别名、列别名列表、`USING`、按输出列名写的 `ORDER BY` / `GROUP BY` / `DISTINCT ON` 在这棵树里已经换成生成的别名、显式的 `AS`、等值的 `ON` 与位置序号；调用方写的表别名与 CTE 名不出现在后面的任何文本里，输出列名与窗口名用折叠后的写法，由打印器加引号；
   - 表 ID、字段 ID 换成该 slot 当前版本指针所指的物理表与物理列；每个表引用换成一个只含未撤销行、带时间条件的子查询（逻辑表 = 当前版本里未撤销的行）；
   - 只留可见范围内的表；引用读时计算的派生表时，把它的规则作为子查询展开：求值时刻是本次调用的 `at`，`saveslot_today()` 取这张派生表所属 slot 的时区，值按字段精度舍入（与落表的派生行相同），不分组的整体聚合没有输入时没有行；展开计入表引用上限。读取记录记规则所读的基础表（表级），不记这张派生表；规则读状态类表时，记下它读的那一点；
   - `saveslot_now()`、`saveslot_today()` 换成本次调用的参数，`saveslot_date(f)` 换成内部列（「时间」；**这一版没有做**：用到 `saveslot_date(f)` 报 `internal`（`not_implemented`））；
   - `/`、`%`、`mod()` 的除数换成 `NULLIF(除数, 0)`；派生规则里 `/` 的被除数与 `avg` 的参数转换成 `numeric(1000, 45)`（「类型」里的「派生字段的值」）；`*` 展开成可见字段。这一步加上的转换在白名单检查之后，改写后的文本不再过白名单。
8. **执行**：由第 7 步的树打印成文本（只打印树里有的东西，不抄调用方的原文），在只读事务里执行。打印出的文本里每个标识符都加双引号，每个列引用是 `"生成的别名"."列名"`。会话固定 `standard_conforming_strings = on`（与 architecture §8 的其他固定会话设置一起）：打印出的字符串字面量里反斜杠不转义，它的含义依赖这项设置；`search_path` 也固定为只含 `pg_catalog`（函数不带 schema 打印，表带各自的 schema）。这些用 `SET LOCAL` 设在只读事务里，事务结束即还原；在强制超时的 PostgreSQL 上另有 `SET LOCAL statement_timeout`，整个调用共用一个期限（见「代价」）。读取记录要在同一事务里读内核自己的表，那些语句不带 schema，所以调用方的语句执行完之后、读取记录的语句之前，把 `search_path` 在事务中途还原成原值（`set_config('search_path', 原值, true)`）。
9. **读取记录**：`sql` 的结构指纹从第 5 步之后的语法树得出（「读取记录里记什么形状」）。

- 报错只出现逻辑名、节点名与函数名，不出现物理名；`line` 是调用方原文里的行号。
- 第 4 步通过、后面的步骤失败，同样整条拒绝；拒绝不产生事件。

### 语句形状

| 写法 | `sql` | 派生规则 | 说明 |
|---|---|---|---|
| 单条 `SELECT`，可带一个结尾分号 | 收 | 收 | |
| 不带 `FROM` 的 `SELECT`（如 `SELECT saveslot_today()`） | 收 | 不收 | 派生规则要有输入表 |
| `WITH`（非递归） | 收 | 收 | 不收 `MATERIALIZED` / `NOT MATERIALIZED`、`SEARCH`、`CYCLE` |
| `WITH RECURSIVE` | 不收 | 不收 | 行数没有上界 |
| `UNION [ALL]`、`INTERSECT [ALL]`、`EXCEPT [ALL]` | 收 | 收（在最外层聚合之内） | |
| 子查询：`FROM` 里的、标量子查询、`EXISTS`、`IN (SELECT …)` | 收 | 收 | 可以关联外层；`LATERAL` 不收 |
| `JOIN`：`INNER`、`LEFT`、`RIGHT`、`FULL`、`CROSS`，`ON` 或 `USING` | 收 | 收 | `NATURAL` 不收：关联条件随字段改名而变 |
| `WHERE`、`HAVING`、`GROUP BY`（表达式或输出列序号） | 收 | 收 | `GROUPING SETS`、`ROLLUP`、`CUBE`、`GROUP BY DISTINCT` 不收 |
| `DISTINCT` | 收 | 收 | |
| `DISTINCT ON (…)` | 收 | 不收 | 留下哪一行取决于次序 |
| `ORDER BY`（`ASC` / `DESC`、`NULLS FIRST` / `LAST`） | 收 | 不收（窗口里的除外） | `USING <运算符>` 不收；派生表没有行序 |
| `LIMIT` / `OFFSET`（常量或 `$n`） | 收 | 不收 | `FETCH … WITH TIES` 不收。分页另有 `max_rows` 与 `cursor` |
| `WINDOW` 命名窗口 | 收 | 收 | |
| `SELECT *`、`t.*` | 收，展开成可见字段 | 不收 | 派生规则的每个输出列要对应一个声明了的派生字段；`count(*)` 不受影响。`sql` 里 `*` 或 `t.*` 展开的那张表（含子查询的输出）有两列同名时不收（展开后分不出谁是谁），报 `node`，提示用 `AS` 起名；不经 `*`、直接按名字引用重名列，是名字有歧义，报 `unknown_name`（「名字」） |

**整条报 `not_select` 的**：不是单条 `SELECT` 的一切——`INSERT`、`UPDATE`、`DELETE`、`MERGE`（含写在 `WITH` 里的）；任何 DDL；事务控制；`SET`、`RESET`、`SHOW`；`COPY`；`DO`、`CALL` 与函数、过程的定义；`PREPARE`、`EXECUTE`、`DEALLOCATE`；`LISTEN`、`NOTIFY`；`LOCK`；`EXPLAIN`；`VACUUM`、`ANALYZE`；多条语句；空语句。

**`SELECT` 之内报 `node` 的**：`INTO`；`FOR UPDATE` / `FOR SHARE` 一类锁定子句；`VALUES` 列表；`FROM` 里的函数（`generate_series`、`unnest` 等）；`TABLESAMPLE`；`XMLTABLE`、`JSON_TABLE`；`LATERAL`；`COLLATE`；数组、下标、行构造器；`CURRENT_DATE`、`CURRENT_TIMESTAMP`、`CURRENT_USER`、`USER` 一类特殊值；`GROUPING SETS` 一族。

### 名字

名字只对 saveslot 的逻辑名解析，不经数据库的 `search_path`。

**表**：写 `表名` 或限定名 `slot名.表名`，可带别名。

- **`sql`**：在可见范围内解析。不带 slot 的表名在可见范围内只有一张时直接用；有几张时报 `invalid_argument`（`ambiguous_table`），附候选（与契约「引用、序号与值的编码」一致）。**一条 `sql` 可以引用可见范围内多个 slot 的表**：它是只读的，不涉及版本归属与原子性；结果的 `sv` 按 slot 给出各自读到的版本。每个 slot 都读当前版本；最近 10 个 schema 版本内用过的旧名照常解析，`warnings` 给 `renamed`（「schema 文档格式」）。
- **派生规则**：只在规则所在的 slot 内解析。限定名指向别的 slot 报 `cross_slot_ref`：派生规则与 `ref` 字段都不跨 slot，派生刷新与基础写入同一事务，而一次写入只涉及一个 slot。可以引用本 slot 的派生表（按依赖的拓扑序刷新），依赖成环报 `rule_sql_rejected`。
- **转换表达式**：不引用表。

**字段**：写 `字段名`、`表名.字段名`、`别名.字段名` 或 `slot名.表名.字段名`。不带表名的字段在 `FROM` 里的几张表上都有时，按名字解析不出唯一目标处理（报 `unknown_name`，提示加表名）。转换表达式里唯一能出现的列名是本字段在 `base_version` 里的名字，出现别的字段报 `not_in_this_version`（「schema 文档格式」）。

**系统列**：每张基础表在 SQL 里另有下面几列，不用声明。

| 列 | 哪些表有 | SQL 类型 | 说明 |
|---|---|---|---|
| `row_id` | 事件类表、无时间表 | `text` | 对外的行 ID（`r_…`） |
| `entity_id` | 状态类表 | `text` | 对外的实体 ID（`e_…`） |
| `valid_from`、`valid_to` | 状态类表 | 按 `granularity`：`date` 或 `timestamptz` | 这一段的生效区间 `[valid_from, valid_to)`；一直延续时 `valid_to` 为空 |

- `row_id`、`entity_id` 与 `valid`、`valid_from`、`valid_to` 同是保留的字段名，不能用作字段名（「字段类型与取值范围」的名字规则）。
- 派生表没有系统列：分组键就是它的字段，`partition_id` 不出现在 SQL 里。
- 已撤销标记、版本、来源与物理分段这些内部列都不出现。`sql` 的结果不自动带行 ID，要的话自己选 `row_id` / `entity_id`。

**大小写与引号**：slot 名、表名、字段名在各自作用域内不分 ASCII 大小写唯一（「字段类型与取值范围」），所以 SQL 里的名字解析也不分 ASCII 大小写，加不加双引号都一样：`avgHR`、`avghr`、`"AvgHR"` 指同一个字段。调用方自己起的名字（CTE 名、表别名、子查询与 CTE 的输出列名、窗口名）同样不分 ASCII 大小写，执行的文本里一律用折叠成小写的写法，定义处与每个引用处相同：数据库对带引号的名字逐字比较，两边不同写法就会指到不同的东西。这样 PostgreSQL 的解析器把不加引号的标识符折成小写也不会引出歧义。引号只用于名字恰好是 SQL 关键字（`order`、`group`、`user`……）的时候；`user` 不加引号会被解析成 PostgreSQL 的 `USER`（当前角色），按 `SQLValueFunction` 节点拒绝，报错提示加引号。

**子查询与 CTE 的输出列**：只有写了 `AS` 的输出列、或原样是一个列的输出列有名字，外层可以按名字引用它；其余输出列（函数、`CASE`、子查询、运算等）没有外层能用的名字，按名字引用报 `unknown_name`，不论 PostgreSQL 会给它起什么默认名。`*` 与 `t.*` 仍然展开它们，展开后由内核给名字。`FROM` 子查询与 CTE 的列别名列表（`AS t (a, b)`）给的名字同样可以引用。

**有没有名字的输出列的作用域，找不到的名字不再向外找**：一个作用域的 `FROM` 里有这样的子查询或 CTE（有输出列没有名字）时，在这个作用域里找不到的不带限定名的名字报 `unknown_name`，提示给内层的输出列起个 `AS` 名字，不会继续去外层找：PostgreSQL 会把它绑到内层那一列，分析器没有它的名字，不能悄悄换成外层的同名列。`FROM` 项的输出列都有名字的作用域照常向外层找（相关子查询）。

**`ORDER BY`、`DISTINCT ON`、`GROUP BY` 里的裸名字**：`ORDER BY` 与 `DISTINCT ON` 里不带限定名的名字先认本层的输出列名（有两列同名则报 `unknown_name`），不是输出列才当作输入列的表达式，所以 `SELECT DISTINCT ON (z) laps AS z FROM runs` 可以，`SELECT DISTINCT ON (laps) feeling AS laps, laps AS feeling FROM runs` 按输出列 `laps`（即 `feeling`）去重。`GROUP BY` 里的裸名字先认本层的输入列，再认本层的输出列名，两处都没有就报 `unknown_name`，不向外层找。

**`JOIN … ON` 的作用域**只含这次连接的两侧，加上外层；同一个 `FROM` 里写在它前面的逗号项看不见（它的名字若外层有，指外层的）。

**三段名 `slot.table.column`** 只在 `FROM` 里写了 slot 时才认：`FROM health.runs` 之后可以写 `health.runs.laps`，`FROM runs` 之后不行，报 `unknown_name`。

**限定名只在最内层找**：写 `q.c` 时，只看最内层有 `q` 这个限定名的作用域；那里没有列 `c` 就报 `unknown_name`，不再向外层找（PostgreSQL 在最内层定下 `q` 之后不会往外找，没有这一列时会把 `q.c` 当作对整行的函数调用 `c(q)`，两边必须一致）。不带限定名的列照常由内向外找最近的一层。

**CTE 名**：同一个 `WITH` 里两个 CTE 的名字折叠后相同，报 `unknown_name`（名字不分 ASCII 大小写唯一）。

**参数**：`$1 … $n` 只在 `sql` 里用，从 `$1` 起连续编号，个数与 `params` 相同，否则报 `invalid_argument`（`malformed`，`param: "params"`）。参数的类型由使用处推出（与哪个字段比较、出现在 `FOR VALID_TIME` 里……）；推不出（如单独的 `SELECT $1`）报 `sql_rejected`（`type`）。值由 saveslot 按推出的类型校验与转换，不交给数据库按会话设置解析：日期写 `YYYY-MM-DD`，时刻写带偏移的 RFC 3339，带单位的量写该列声明单位下的十进制字符串（契约 `SqlParams`）。

**解析不出的名字**：表、字段、slot 不存在、不可见、或有歧义，一律报 `sql_rejected`（`unknown_name`），不区分不存在与不可见（不泄露"有这张表"）。物理名（`t_…_v…`、`d_…`）、内核自身的表、`pg_catalog` 与一切以 `pg_` 开头的系统对象、`information_schema` 都不是逻辑名，在第 5 步找不到，同样报 `unknown_name`。用户恰好把一张表叫作 `pg_class`，它解析到的是用户自己的逻辑表。

**可见范围**：第 7 步只引用可见的表。派生表可见，当且仅当它依赖的全部表与字段都可见（「可见范围」）。派生规则在编译时也按调用的可见范围解析（第一版恒为全部）。

### 执行的文本里没有留给数据库解析的名字

分析先按本文的规则把调用方写的名字都绑定好；如果执行的文本再带着调用方的名字，数据库会按它自己的规则再解析一遍，两套规则只要有一处不同就是漏洞：带引号的名字数据库逐字比较，列不存在时 `q.f` 会变成函数调用 `f(q)`，没有 `AS` 的输出列有数据库自己的默认名，等等。所以第 7 步之后执行的文本里，名字**全部由分析生成并限定**（输出列名与窗口名是调用方起的、折叠后的写法，由打印器加引号；表别名与 CTE 名则一律不进文本），调用方的拼写只用于分析时的查找：

- 每个 FROM 项的别名由分析生成，整条查询里唯一（`t1`、`t2`……；CTE 是 `c1`……）；
- 每个列引用写成 `"生成的别名"."列名"`，别名是它绑定到的那个 FROM 项的，列名是那一列在文本里真有的名字；不带限定名的引用、按输出列名写的 `ORDER BY` / `GROUP BY` / `DISTINCT ON` 都换成绑定后的写法或位置序号；
- 每个 `SELECT` 的每个输出列都有显式的 `AS`：调用方起了名的用折叠后的名字，没起的由分析生成；`*` 展开成显式的列；顶层结果的列名仍是调用方看到的那一套，由结果的列描述给出，不依赖这些内部名字；
- `JOIN … USING` 写成它所代表的等值 `ON`，被合并的列写成它所来自的那一侧（`FULL` 时是 `COALESCE`）；
- 表按 slot 与表自己的名字写（schema 里的名字，不是调用方写的拼写或旧名）。

绑定不到任何东西的列引用不会被打印：那是分析的错，不是调用方的。

### 时间

**业务时间**：`FOR VALID_TIME AS OF <时刻>` 与 `FOR VALID_TIME FROM <起> TO <止>`，紧跟在状态类表的表名之后、别名之前：

```sql
SELECT b.category, b.amount
FROM budgets FOR VALID_TIME AS OF saveslot_today() AS b
```

- **操作数**只能是：`$n`；字符串字面量（日期 `YYYY-MM-DD`，或带偏移的时刻）；`saveslot_today()`；`saveslot_now()`。按日的表上还可以写成其中之一加减一个整数常量（天数），如 `saveslot_today() - 30`。操作数在一次调用里必须是一个定值，所以不收别的表达式。
- **含义**与契约的时间参数相同：`AS OF t` 是每个实体包含 t 的那一段（`valid_at`）；`FROM a TO b` 是与 `[a, b)` 相交的每一段（`valid_during`），端点不截到区间内，需要时自己用 `GREATEST` / `LEAST` 截。
- **粒度**：按日的表收到时刻，按 slot 时区取所在日，`warnings` 给 `time_truncated`；按时刻的表收到日期，报 `invalid_argument`（`granularity`）。与契约「时间参数」一致。
- 用在事件类表、无时间表或派生表上报 `sql_rejected`（`node`），提示事件类表改用 `WHERE` 按发生时间字段筛选。
- **不带时间限定读状态类表** = 每个实体包含求值时刻的那一段。求值时刻是 `at`，没带时是入口时刻，即 `saveslot_now()`；"今天"取的也是它。当前没有值的实体不出现。派生规则这样读，归入依赖"今天"一类，第一版读时计算（「时间依赖」）。
- **SQL 看到的段**：同一实体相邻、且全部字段都同值的段先合并成一段再给出，`valid_from` / `valid_to` 是合并后的端点。物理上怎么分段不影响任何 SQL 的结果，这与"所有机械判定不看物理段的边界"是同一个要求（「状态类表的状态」）。

**记录时间不在 SQL 里开放**：出现 `FOR SYSTEM_TIME` 报 `sql_rejected`（`system_time`），附 `use: "history"`；派生规则里出现报 `rule_sql_rejected`。

**saveslot 的三个函数**：

| 函数 | 结果 | 含义 | `sql` | 派生规则 | 转换表达式 |
|---|---|---|---|---|---|
| `saveslot_now()` | `timestamptz` | 入口时刻；`sql` 带了 `at` 时是 `at` | 收 | 收，规则归入依赖"今天" | 不收 |
| `saveslot_today()` | `date` | `saveslot_now()` 在 slot 时区下的日期 | 收；查询引用的各 slot 时区不全相同时不收（不知道按哪个时区取日），报 `function`，提示用 `$n` 传日期或拆成两条 | 收，规则归入依赖"今天" | 不收 |
| `saveslot_date(f)` | `date` | 基础表上 `zoned_datetime` 字段 f 的时刻，在该表所属 slot 时区下的日期 | 收 | 收；不算依赖"今天" | 不收 |

- 三个函数都不读时钟，也不在数据库里做时区换算。`saveslot_now()`、`saveslot_today()` 由 saveslot 改写成这次调用的参数，同一次调用里各只有一个值。
- `saveslot_date(f)` 的参数只能是一个 `zoned_datetime` 字段的列引用，不能是表达式。这个日期由 `apply` 落账时在应用层按 slot 时区算好，存在业务表的一个内部列里，改写时换成这一列。所以它与"今天"一样只依赖 saveslot 自己的时区换算，不依赖数据库会话时区，也不依赖两个后端各自带的时区库版本；saveslot 用的时区库版本随 saveslot 版本钉死。这一列是由日志与时区库算出的物化状态，**以重放方的时区库为准**：`meta` 记下建出现有这一列所用的时区库版本，打开租户时发现与当前版本不同，就在本地重建这一列与受影响的派生分区。这是确定性的本地重建，不写日志（architecture §8）。跨版本对拍（导出后重放或导入、双后端对拍）时，两边时区库版本不同，这一列与依赖它的派生值单独归为"时区库版本不同"，不算差异；版本相同时照常要求零差异。改 slot 时区的事件在同一事务里重算这一列，依赖它的派生表随之重建（「改动分类与迁移手段」里改 slot 时区一条）。
- 不选 `f AT TIME ZONE '<时区>'`：时区换算会落在两个后端各自的时区数据上，版本不同就可能在夏令时边界上差一天。

### 类型

| 字段类型 | SQL 里的类型 | 说明 |
|---|---|---|
| `text` | `text` | 按 `C` 排序规则比较与排序；已做 NFC 规范化 |
| `enum` | `text` | |
| `integer` | `bigint` | |
| `decimal` | `numeric` | |
| `quantity` | `numeric` | 字段声明单位下的数；单位由类型检查另行跟踪（见下） |
| `boolean` | `boolean` | |
| `date` | `date` | |
| `zoned_datetime` | `timestamptz` | 只有时刻；时区部分不出现。取日用 `saveslot_date(f)` |
| `ref` | `text` | 目标的 `r_…` / `e_…`。关联目标表：`JOIN meals m ON m.row_id = d.meal` |

- 另外两种类型只能作为中间值：`timestamp`（只来自 `date::timestamp`，给 `date_trunc` 用）与 `interval`（只作为窗口帧偏移的字面量）。
- 不收的类型：`real`、`double precision` 等浮点，`integer` / `smallint`（只用 `bigint`），`money`、`json` / `jsonb`、数组、区间类型、`uuid`、`bytea`、`xml` 等。
- **字面量**：字符串、整数、小数（`1.5` 是 `numeric`）、`TRUE` / `FALSE`、`NULL`。带类型前缀的只收 `DATE '…'` 与 `INTERVAL '…'`（后者只在窗口帧里）。与 `date`、`timestamptz` 比较的字符串字面量，由 saveslot 按契约的格式校验（日期 `YYYY-MM-DD`，时刻必须带偏移），不按数据库的日期风格解析。
- **整数一律是 64 位**：数据库会定成 32 位的值（整数常量、`length`、`strpos`、`date - date`）与整数的 `sum`（数据库给 `numeric`），按 `bigint` 理解，执行的文本里包一层 `CAST(… AS bigint)`；超出 64 位按「确定性」第 6 条报溢出。数据库只收 32 位整数的位置（`substr` 的位置与长度、`left` / `right` 的长度、`split_part` 的序号、`round` / `trunc` 的位数、`date` 加减的天数），第一版只收 32 位以内的整数常量，原样执行。
- **没定型的 `NULL`**：`NULL` 只能出现在另一侧或别的分支能给它定类型的地方（`x + NULL`、`x = NULL`、`COALESCE(x, NULL)`、`CASE … ELSE NULL`、`IN` 列表里）；两侧都没有类型（`NULL + NULL`、`-NULL`、`NULL = NULL`）、作函数或聚合的参数（`abs(NULL)`、`sum(NULL)`）、作类型转换的对象（`NULL::numeric`）不收，报 `type`。布尔的位置（`WHERE NULL`、`NOT NULL`）与 `NULL IS NULL` 收。`NULLIF` 两边都是字符串字面量时结果是 `text`。
- **结果列的类型**：`sql` 的列定义按推出的类型给 `FieldType`；`timestamptz` 列给 `"unknown"`，单元格是 UTC 的 RFC 3339 时刻；推不出的给 `"unknown"`。

**单位**：

- 加减、比较、`sum` / `avg` / `min` / `max`、`COALESCE` / `CASE` / `GREATEST` / `LEAST` 的各分支：带单位的操作数必须是同一个单位代码。同量纲而单位不同（`km` 与 `mi`）也不收：第一版 SQL 里没有单位换算函数。`sql` 报 `sql_rejected`（`type`），派生规则报 `unit_inference_failed`。
- 与字面量或参数比较、加减：字面量与参数按这一侧的单位理解（契约 `SqlParams`）。`COALESCE` / `CASE` / `GREATEST` / `LEAST` 的分支里的字面量同样按带单位的那一支理解，如 `COALESCE(SUM(amount), 0)` 的 `0` 是 `amount` 的单位下的 0；各分支都是字面量时没有单位。与没有单位的字段（`integer`、`decimal`）加减或比较不收。
- 乘除：带单位的量乘或除以没有单位的数，单位不变；同一单位的两个量相除得无量纲 `1`；其余两个带单位的量相乘、相除，派生规则要求把该输出字段声明为 `decimal` 或写明 `unit`（否则 `unit_inference_failed`），`sql` 的结果列是 `decimal`、不带单位（「单位词表」）。
- `count` 的结果是 `integer`。派生字段的精度推断见「精度与舍入」。
- **派生字段的值**：规则在数据库里的结果，按字段的精度（`scale`、`rounding`，见「精度与舍入」）舍入一次。规则里的除法与 `avg` 在至少 45 位小数上求值（数据库的舍入：恰在一半时远离零），其余运算精确。45 的由来：被除数至多 12 位小数、除数 q 有 d 位小数时，精确的商若不恰在一个至多 13 位小数的舍入边界上，离它至少 10^-13 / Q（Q = |q|·10^d，是整数）；数据库的商与精确值相差至多 0.5·10^-45，所以 Q < 2·10^32 时，先这样求值再按字段精度舍入，等于把精确的商直接舍入，恰在一半的值也认得出。表中的值都在此内（至多 18 位整数、12 位小数），行数也是。被除数的小数位超过 13（如两个值先相乘再除）或除法套除法时，值仍按"每次除法在至少 45 位小数上、恰在一半时远离零"定义：确定，但不保证等于精确值的舍入。规则作者自己写的 `round`、`trunc` 等按数据库的定义。45 这个数属于白名单这一版的行为，改它等于改派生结果，按「白名单的版本与变更」里"改变已有项的行为"出新版本。
- **小数分组键**：`decimal` / `quantity` 分组键只在它的值的小数位上界不超过推断出的精度时才收，否则建 slot 时报 `not_in_this_version`。原因是数据库按算出的原始值分组，而派生行按字段精度舍入后的键登记，两者会对不上。上界逐层算：字段取声明的 `scale`，`integer` 与整数字面量、`NULL` 取 0，小数字面量取它写出的小数位数（不截到 12）；加、减、取模取两边的较大者，乘法取两边之和（数据库的乘法是精确的），除法与 `avg` 没有上界；`round(x, n)` / `trunc(x, n)`（`n` 是整数常量）取 `n`（小于 0 取 0），只给 `x` 取 0，`floor`、`ceil`、`sign`、`EXTRACT` 取 0，转换成 `numeric(p, s)` 取 `s`，`abs` 与一元负号沿用参数；`CASE` / `COALESCE` / `GREATEST` / `LEAST` / `NULLIF` 取各结果分支的最大者（`WHEN` 的条件不算）；其余没有上界。

**类型转换**（`x::t` 与 `CAST(x AS t)` 同一个节点）：

| 转换 | `sql` | 派生规则 | 转换表达式 | 说明 |
|---|---|---|---|---|
| `bigint` → `numeric`、`numeric(p, s)` | 收 | 收 | 收 | `s` 至多 12（「精度与舍入」） |
| `numeric` → `bigint` | 收 | 收 | 收 | 四舍五入，恰在一半时远离零 |
| `numeric` → `numeric(p, s)` | 收 | 收 | 收 | 舍入方式同上；`s` 至多 12 |
| `date` → `timestamp` | 收 | 收 | 收 | 给 `date_trunc` 用 |
| `timestamp` → `date` | 收 | 收 | 收 | |
| `text` → `numeric`、`bigint`、`boolean` | 不收 | 不收 | 收 | 会因值而失败，报 `migrate_failed`（三处时机见「拒绝时报什么」） |
| `date` 与 `timestamptz` 互转、`timestamptz` → `timestamp` | 不收 | 不收 | 不收 | 随会话时区而变；取日用 `saveslot_date` |
| 转成 `text` | 不收 | 不收 | 不收 | 输出格式随会话设置 |
| 其余 | 不收 | 不收 | 不收 | |

隐式转换同样受这张表约束：比如 `date` 列与 `timestamptz` 值比较，会隐式把 `date` 转成 `timestamptz`，按上表不收。

### 白名单

下列各表就是白名单。场合一栏：S = `sql`，D = 派生规则，M = 转换表达式。

#### 语法树节点

节点名照 libpg_query（PostgreSQL 18 分支）的写法；"形式"一栏是该节点被放行的条件，不满足的按节点不收处理。

| 节点 | 放行的形式 | 场合 |
|---|---|---|
| `RawStmt` | 恰好一个 | S D M |
| `SelectStmt` | `op` 为 `SETOP_NONE` / `SETOP_UNION` / `SETOP_INTERSECT` / `SETOP_EXCEPT`；`into_clause`、`locking_clause`、`values_lists` 为空；`group_distinct` 为假；`limit_option` 不是 `LIMIT_OPTION_WITH_TIES`。D 另要求 `sort_clause`、`limit_count`、`limit_offset` 为空，`distinct_clause` 不是 `DISTINCT ON`；M 只有一个输出项、没有其他子句 | S D M |
| `ResTarget` | 输出项与别名 | S D M |
| `ColumnRef` | 1–3 段名字；末段是 `A_Star` 的只在 S 的输出项里 | S D M |
| `A_Star` | 见上 | S |
| `A_Const` | 整数、小数、字符串、布尔、`NULL`；位串不收 | S D M |
| `ParamRef` | `$1 … $n` | S |
| `TypeCast`、`TypeName` | 目标类型与源类型按「类型转换」；不带数组维度 | S D M |
| `A_Expr` | `kind` 为 `AEXPR_OP`（运算符见下表）、`AEXPR_DISTINCT`、`AEXPR_NOT_DISTINCT`、`AEXPR_NULLIF`、`AEXPR_IN`、`AEXPR_LIKE`、`AEXPR_BETWEEN`、`AEXPR_NOT_BETWEEN`；运算符名不带 schema 限定 | S D M |
| `BoolExpr` | `AND_EXPR`、`OR_EXPR`、`NOT_EXPR` | S D M |
| `NullTest` | `IS_NULL`、`IS_NOT_NULL`，作用于标量 | S D M |
| `BooleanTest` | `IS_TRUE`、`IS_NOT_TRUE`、`IS_FALSE`、`IS_NOT_FALSE`、`IS_UNKNOWN`、`IS_NOT_UNKNOWN` | S D M |
| `CaseExpr`、`CaseWhen` | 简单与搜索两种 `CASE` | S D M |
| `CoalesceExpr` | | S D M |
| `MinMaxExpr` | `IS_GREATEST`、`IS_LEAST` | S D M |
| `FuncCall` | 函数名在「函数」「聚合函数」「窗口函数」表里、不带 schema 限定；`func_variadic` 为假；`agg_within_group` 为假；`agg_order` 为空；`agg_distinct` 只用于 `count`；`agg_filter`（`FILTER (WHERE …)`）只用于聚合；`over` 按「窗口函数」 | S D M（M 只收「函数」表里标了 M 的） |
| `SubLink` | `EXISTS_SUBLINK`、`EXPR_SUBLINK`（标量子查询）、`ANY_SUBLINK` 中的 `IN (SELECT …)` 形式 | S D |
| `RangeVar` | 逻辑表名，可带 slot 名（落在 `schemaname`）；`catalogname` 为空；不带 `ONLY` | S D |
| `Alias` | 表别名，可带列名列表 | S D |
| `JoinExpr` | `JOIN_INNER`、`JOIN_LEFT`、`JOIN_RIGHT`、`JOIN_FULL`；`is_natural` 为假；`ON` 或 `USING` | S D |
| `RangeSubselect` | `lateral` 为假 | S D |
| `WithClause` | `recursive` 为假 | S D |
| `CommonTableExpr` | `ctematerialized` 为 `CTEMaterializeDefault`；没有 `SEARCH` / `CYCLE` | S D |
| `SortBy` | `SORTBY_DEFAULT` / `SORTBY_ASC` / `SORTBY_DESC`，`NULLS` 任意；不收 `SORTBY_USING` | S；D 只在窗口的 `ORDER BY` 里 |
| `WindowDef` | 按「窗口函数」 | S D |
| `String`、`Integer`、`Float`、`Boolean`、`List` | 作为上面各节点的组成部分 | S D M |

共 32 种节点。其余一律不收，常见的有：除 `SelectStmt` 以外的全部 `…Stmt`，`IntoClause`、`LockingClause`、`RangeFunction`、`RangeTableSample`、`RangeTableFunc`、`JsonTable`、`CollateClause`、`A_Indirection`、`A_ArrayExpr`、`RowExpr`、`GroupingSet`、`NamedArgExpr`、`SQLValueFunction`、`XmlExpr` 与各种 `Json…` 节点。

#### 运算符

| 运算符 | 操作数 | 结果 | 场合 | 说明 |
|---|---|---|---|---|
| `=`、`<>`（`!=` 同义）、`<`、`<=`、`>`、`>=` | 两边同类：整数与 `numeric` 互比；`text`；`date`；`timestamptz`；`boolean` | `boolean` | S D M | `text` 按 `C` 排序规则逐字节比；`date` 与 `timestamptz` 不能互比（见「类型转换」） |
| `IS [NOT] DISTINCT FROM` | 同上 | `boolean` | S D M | |
| `[NOT] BETWEEN … AND …` | 同上 | `boolean` | S D M | `SYMMETRIC` 不收 |
| `[NOT] IN (列表)`、`IN (SELECT …)` | 同上 | `boolean` | S D M（M 只有列表形式） | |
| `+`、`-`（二元与一元） | 整数、`numeric` | 同类 | S D M | |
| `*` | 整数、`numeric` | 同类 | S D M | |
| `/` | 至少一边是 `numeric` | `numeric` | S D M | 除数为 0 得空；两边都是整数不收（会悄悄截断），提示写 `::numeric` |
| `%` | 整数、`numeric` | 同类 | S D M | 除数为 0 得空 |
| `date + 整数`、`整数 + date`、`date - 整数` | | `date` | S D M | 加减天数；第一版整数只收 32 位以内的常量（「类型」） |
| `date - date` | | 整数 | S D M | 相差的天数 |
| `\|\|` | 两边都是 `text` | `text` | S D M | 与其他类型拼接不收（那一种随会话设置） |
| `LIKE`、`NOT LIKE`，可带 `ESCAPE` | `text` | `boolean` | S D M | 区分大小写，按字节匹配。第一版模式只收字符串常量（或 `NULL`），且不以转义字符结尾（数据库会因此出错）；转义字符不写时是 `\`，`ESCAPE` 只收长度为 0 或 1 的字符串常量 |
| `AND`、`OR`、`NOT`；`IS [NOT] NULL`；`IS [NOT] TRUE / FALSE / UNKNOWN` | | `boolean` | S D M | |

共 13 行（同义写法不另算）。

**`LIKE` 收、`ILIKE` 与正则不收**：`LIKE` 在 `C` 排序规则下只比字节，结果确定，常用于前缀与子串匹配；`ILIKE`、`~`、`SIMILAR TO` 要做大小写折叠或字符分类，结果取决于区域设置与后端的实现，第一版不收。

#### 函数

| 函数 | 参数 | 结果 | 场合 | 说明 |
|---|---|---|---|---|
| `abs` | 整数、`numeric` | 同类 | S D M | |
| `round` | `numeric`；`numeric, 整数常量` | `numeric` | S D M | 恰在一半时远离零，与 `half_up` 相同（「精度与舍入」）。参数是整数不收（数据库走浮点的版本），提示写 `::numeric`；`trunc`、`floor`、`ceil`、`sign` 同样 |
| `trunc` | `numeric`；`numeric, 整数常量` | `numeric` | S D M | 向零截断 |
| `floor`、`ceil`（`ceiling` 同义） | `numeric` | `numeric` | S D M | |
| `sign` | `numeric` | `numeric` | S D M | |
| `mod` | 两个整数；两个 `numeric` | 同类 | S D M | 除数为 0 得空 |
| `date_trunc` | `text` 常量, `timestamp` | `timestamp` | S D M | 第一个参数只收（小写的）`'day'`、`'week'`、`'month'`、`'quarter'`、`'year'`；`week` 以周一为始。写法：`date_trunc('week', d::timestamp)::date`。参数是 `timestamptz`（含 `date` 不加 `::timestamp` 时被隐式转成的）不收，按"不确定"拒绝并给出这个改法 |
| `EXTRACT(<字段> FROM <date>)` | `date` | `numeric` | S D M | 字段只收 `year`、`quarter`、`month`、`day`、`dow`、`isodow`、`doy`、`week`、`isoyear`。参数只能是 `date`；`date_part()` 不收（返回浮点） |
| `make_date` | 三个整数 | `date` | S M | 非法日期会出错，派生规则不收 |
| `length`（`char_length` 同义） | `text` | 整数 | S D M | 按字符数 |
| `substr`、`substring(… FROM … FOR …)` | `text, 整数常量[, 整数常量]` | `text` | S D M | 按字符位置；长度不为负 |
| `left`、`right` | `text, 整数常量` | `text` | S D M | |
| `strpos`、`position(… IN …)` | `text, text` | 整数 | S D M | |
| `starts_with` | `text, text` | `boolean` | S D M | |
| `btrim`、`ltrim`、`rtrim`、`trim(…)` | `text[, text]` | `text` | S D M | |
| `replace` | `text, text, text` | `text` | S D M | |
| `split_part` | `text, text, 整数常量` | `text` | S D M | 序号不为 0 |
| `saveslot_now()`、`saveslot_today()`、`saveslot_date(f)` | 见「时间」 | | 见「时间」 | |

共 24 个函数（同义名与 SQL 标准的特殊写法不另算）：数值 7、日期 3、文本 11、saveslot 3。表里的"整数常量"是数据库只收 32 位整数的位置，第一版只收 32 位以内的常量（「类型」）。`COALESCE`、`NULLIF`、`GREATEST`、`LEAST`、`CASE` 是语法节点，见上。

#### 聚合函数

| 聚合 | 参数 | 场合 | 说明 |
|---|---|---|---|
| `count(*)`、`count(x)`、`count(DISTINCT x)` | 任意白名单类型 | S D | `count(DISTINCT meal)` 这类对 `ref` 字段去重计数可以 |
| `sum`、`avg` | 整数、`numeric` | S D | 带单位的量单位不变 |
| `min`、`max` | 整数、`numeric`、`text`、`date`、`timestamptz` | S D | `text` 按 `C` 排序规则 |
| `bool_and`、`bool_or` | `boolean` | S D | |

- 共 9 项。都可以带 `FILTER (WHERE …)`。`DISTINCT` 只用于 `count`，聚合内的 `ORDER BY` 不收。
- 不收：`string_agg`、`array_agg`、`json_agg`（结果取决于次序，类型也不在白名单里）；`percentile_cont`、`percentile_disc`、`mode`（`WITHIN GROUP`）；`stddev`、`variance` 一族与 `regr_…` 一族（第一版用不到，精度规则另要定）。
- 数都是 `numeric` 或 `bigint`，没有浮点，所以求和与平均与累加顺序无关。

#### 窗口函数

| 函数 | `sql` | 派生规则 |
|---|---|---|
| `count`、`sum`、`avg`、`min`、`max` 加 `OVER (…)` | 收 | 收；帧只能是 `RANGE` 或 `GROUPS`（含不写帧时的默认帧） |
| `rank()`、`dense_rank()` | 收 | 收 |
| `row_number()`、`lag(x[, n[, 缺省值]])`、`lead(x[, n[, 缺省值]])`、`first_value(x)`、`last_value(x)` | 收 | 不收：排序键有并列值时，结果取决于并列行的先后 |

- 共 12 项（5 个聚合用作窗口、7 个窗口专用函数）。
- `OVER` 里可以有 `PARTITION BY`、`ORDER BY`、帧，或引用命名窗口。帧的界只收 `UNBOUNDED PRECEDING`、`UNBOUNDED FOLLOWING`、`CURRENT ROW`、`n PRECEDING`、`n FOLLOWING`：`ROWS` / `GROUPS` 的 n 是非负整数常量；`RANGE` 按 `date` 排序时 n 是以天或周为单位的 `INTERVAL` 字面量（`INTERVAL '6 days'`），按数排序时 n 是数值常量。`EXCLUDE` 子句不收。
- 派生规则里的 `ROWS` 帧不收，理由同上；`RANGE` 与 `GROUPS` 按值或按并列组划帧，与并列行的先后无关。
- 派生规则里窗口函数只能出现在最外层的分组聚合之内（「刷新范围与写入准入」）；带窗口函数的规则第一版每次重算全部分区。
- 不收：`ntile`、`percent_rank`、`cume_dist`（后两个返回浮点）、`nth_value`。

### 确定性

派生规则与转换表达式的结果进重放，必须在重放时、在 PGlite 与 PostgreSQL 上都得出同样的值。白名单按下面几条挑：

1. **每一项背后的 PostgreSQL 函数都是 `IMMUTABLE`**（`pg_proc.provolatile = 'i'`），在两个后端上都是，测试逐项断言（「怎么测」）。`now()` 一族、`random()`、`clock_timestamp()`、`current_setting()`、`set_config()`、`to_char()`、`concat()`、`date_trunc` 用在 `timestamptz` 上、`date` 与 `timestamptz` 互转都不是，不收。`CURRENT_DATE` 一类是 `SQLValueFunction` 节点，按节点不收。白名单各项的 `IMMUTABLE` 属性按 PostgreSQL 18 的系统目录实现时逐项核实，核实下来不是的项移出白名单。
2. **不依赖会话设置**。固定的会话设置见 architecture §8：时区 `UTC`、文本用 `C` 排序规则、十进制数用 `numeric`、日期输出 ISO。白名单在此之外再避开它们：时区换算一律不在数据库里做（`saveslot_today()`、`saveslot_date()` 在应用层算好）；日期与时刻的字面量、参数由 saveslot 解析；不收任何转成文本的转换。
3. **文本只按字节比较**。文本列用 `C` 排序规则，写入时已做 NFC 规范化，相等即逐码点相同。依赖字符分类或大小写折叠的不收：`lower`、`upper`、`initcap`、`ILIKE`、正则、`SIMILAR TO`、`COLLATE`。`length`、`substr` 这类按字符计的函数依赖数据库编码，两个后端的数据库编码都固定为 UTF-8（PGlite 的默认编码实现时核实）。
4. **没有浮点**。数一律是 `numeric` 或 `bigint`；不收浮点类型与返回浮点的函数（`date_part`、`sqrt`、`power`、`exp`、`ln`、`random`……）。
5. **结果不取决于行的先后**。派生规则不收 `ORDER BY` 后的 `LIMIT` / `OFFSET`、`DISTINCT ON`、依赖并列次序的窗口函数、`ROWS` 帧、有序聚合（见上各表）。
6. **求值不因数据出错**。`/`、`%`、`mod()` 的除数为 0 时得空（改写成 `NULLIF(除数, 0)`）；整数除以整数不收；派生规则里不收会因值而失败的转换与函数（`text` 转数、`make_date`）。剩下的只有因数据而起的几种：64 位整数溢出、转换成 `numeric(p, s)` 时超出精度、`date` 加减常量天数后超出日期范围，以及派生字段的结果超出字段类型的取值范围（日期不在 0001-01-01 至 9999-12-31 之内，小数的整数部分超过 18 位；数据库照常算出，saveslot 的值表示不了）。`sql` 的结果同样：`date` 结果不在 0001-01-01 至 9999-12-31 之内（数据库会给出 `0044-03-15 BC`、五位年份，契约没有这种形式）报 `runtime`；整数的 `sum`（聚合与窗口两种用法）在 PostgreSQL 里是 `numeric`，执行文本里包一层 `CAST(sum(…) AS bigint)`，超出 64 位按溢出报 `runtime`，结果仍是 `integer`，不会出现一个超出 64 位的整数。`sql` 报 `sql_rejected`（`runtime`）；派生规则在编译试跑时报 `rule_sql_rejected`，之后在某次基础写入的刷新里发生时，整个写入被拒，报 `validation_failed`（`write`），明细码 `rule_eval_failed`，不产生事件。
   **数据库的原文不外传**：执行阶段数据库对一条已通过检查的语句的任何拒绝（上面的数据错误、标量子查询返回多行 `21000`，以及检查没有想到的其他情形），`sql` 一律报 `sql_rejected`（`runtime`），文字是内核自己的，数据库的原文（它会带出生成的别名与内部名）只进本机日志，不进错误的任何字段；超时另报 `sql_timeout`。检查能判出来的不留给数据库：聚合函数里套窗口函数、聚合查询里的子查询用了外层没有分组的列，在分析阶段按 `node` 拒。
7. **两个后端上逐项比过**。每一项都有双后端用例（「怎么测」）；出现差异的项，要么从白名单移除，要么由内核钉死行为（显式排序规则、显式舍入、强制排序），然后出新的白名单版本。

### 代价

**主防线在执行之前**（architecture §7：PGlite 上超时只能终止整个 DB Worker）：

- 白名单不收会放大行数的写法：返回多行的函数（`generate_series`、`unnest`、`regexp_split_to_table` 等，`FROM` 里的与输出项里的都不收）、`WITH RECURSIVE`、`LATERAL`。
- 下表的上限在第 1、4 步检查。数值是初值，由实验 2、实验 4 调整：

| 项 | 上限 |
|---|---|
| SQL 文本 | 16 KB（UTF-8 字节） |
| 语法树节点数 | 2,000 |
| 表达式嵌套深度 | 32 |
| 子查询嵌套层数（`FROM` 子查询、标量子查询、`EXISTS` / `IN` 子查询、CTE 各算一层） | 4 |
| 表引用数（同一张表引用两次算两个；CTE 的引用与展开的读时派生表也算） | 8 |
| CTE 个数 | 8 |
| 集合运算的分支数 | 8 |
| `IN` 列表的项数 | 1,000 |
| 一个 `CASE` 的分支数 | 256（够把 200 个枚举值逐一映射） |
| 参数个数 | 100 |
| 窗口定义个数 | 4 |

- 超出上限：`sql` 报 `sql_rejected`（`limit`），派生规则与转换表达式报 `rule_sql_rejected`。
- 派生规则另过写入准入估算：受影响的分区数、估算扫描行数、依赖深度、预估耗时任一超限就拒绝该次写入（「刷新范围与写入准入」）。

**执行中**：

- `sql` 每页 `max_rows` 行（默认 100、上限 1,000），`cursor` 翻页。
- **读取记录不放大调用方已经限住的查询**：读取记录逐行记的语句取该查询层自己的 FROM 与 WHERE（WHERE 里的子查询也带着），不看调用方的 `LIMIT`。所以**按行记只在这一层只有一个表引用、且这一层的 WHERE 里没有子查询时做**；一层里有两个及以上表引用（连接、逗号），或 WHERE 里有子查询，都不为它再跑语句，这一层的表直接记表级记录。一张表只要有一处引用不能按行记，它的各处引用一律不跑语句，先判断、再执行，不会先跑了几条再发现最后还是表级。规则的另一半见 04-write-and-read「记多少条」。
- **超时报 `sql_timeout`**，附 `elapsed_ms`。PostgreSQL 上用 `statement_timeout`；**整个调用一个期限**：执行调用方的语句、读取记录的每一条语句，各自拿到的是期限里还剩下的时间，不是各自一个完整的限额；剩余不足 1 毫秒时不再发下一条，直接报 `sql_timeout`。PGlite 上 `statement_timeout` 不生效，超时只能终止整个 DB Worker，等于数据库崩溃一次；是否启用由实验 2 决定，不启用时 PGlite 上不会出现 `sql_timeout`，只靠上面的事前限制，一条慢查询会挡住该租户的写入直到它结束。超时的数值是临时值 10 秒（内核常量，测试可注入，不是 `config.toml` 的键；[`../08-open-questions.md`](../08-open-questions.md)），等实验 2、4。

### 拒绝时报什么

| 情形 | `sql` | 派生规则 | 转换表达式 |
|---|---|---|---|
| 语法错误；文本不是良构的 Unicode | `sql_rejected`（`syntax`） | `rule_sql_rejected` | `rule_sql_rejected` |
| 不是单条 `SELECT` | `sql_rejected`（`not_select`） | `rule_sql_rejected` | `rule_sql_rejected` |
| 节点或节点的形式不在白名单 | `sql_rejected`（`node`） | `rule_sql_rejected` | `rule_sql_rejected` |
| 函数、运算符、类型转换不在白名单（含签名不对） | `sql_rejected`（`function`） | `rule_sql_rejected` | `rule_sql_rejected` |
| 只因结果不确定而不收（`now()`、`random()`、`timestamptz` 上的 `date_trunc`、派生规则里依赖次序的写法） | `sql_rejected`（`function` 或 `node`） | `nondeterministic_function` | `nondeterministic_function` |
| `FOR SYSTEM_TIME` | `sql_rejected`（`system_time`），`use: "history"` | `rule_sql_rejected` | `rule_sql_rejected` |
| 名字不存在、不可见、有歧义；物理名、系统对象 | `sql_rejected`（`unknown_name`）；不带 slot 的表名在几个 slot 里都有：`invalid_argument`（`ambiguous_table`） | `rule_sql_rejected`；别的 slot 的表：`cross_slot_ref` | 本字段以外的字段：`not_in_this_version`；其余 `rule_sql_rejected` |
| 类型或单位不合 | `sql_rejected`（`type`） | 单位：`unit_inference_failed`；类型：`rule_sql_rejected` | `rule_sql_rejected` |
| 超出上限 | `sql_rejected`（`limit`） | `rule_sql_rejected` | `rule_sql_rejected` |
| 求值出错 | `sql_rejected`（`runtime`） | 试跑时 `rule_sql_rejected`；之后的写入里 `validation_failed`（`write`），明细码 `rule_eval_failed` | 编译试跑时 `validation_failed`（`schema`），明细码 `migrate_failed`；确认（`resolve`）时对试跑之后的新写入重新求值，失败报 `draft_outdated`（`migrate_failed`），事项保持未决；迁移中带旧 `sv` 的写入在写入的事务里对新版求值，失败报 `validation_failed`（`migrate_failed`，`path` 指到字段），提示按新版本重读再写 |
| 最外层不是聚合 | — | `not_in_this_version` | — |
| 参数个数不对 | `invalid_argument`（`malformed`） | — | — |
| 时间粒度不合 | `invalid_argument`（`granularity`） | `rule_sql_rejected` | — |

- `sql_rejected` 附 `line`（原文行号）与 `node`（节点名、函数名或调用方写的逻辑名，不含物理名）；外化面据此指出"第几行哪个节点 / 函数"（surfaces「文本的渲染」）。
- 派生规则与转换表达式的明细附 `path`（`tables/<i>/rule/sql`、`tables/<i>/fields/<j>/migrate`……）、`line`，能给出改法时附 `suggestion`（如替换后的 SQL 片段）；细分原因写在 `sql_reason`，取值与 `sql_rejected` 的原因码同一套。
- 派生规则里的分析结果（是否用了 `saveslot_now()` / `saveslot_today()`、是否不带时间限定读状态类表、分组键是不是一个 `date` 字段、`saveslot_date(f)` 或 `date_trunc(单位, …)` 套在这两者上；只是读到日期字段的分组键不算分桶）与它声明的 `time_dependency` 不一致时，报 `rule_sql_rejected`，`suggestion` 给出应声明的值。

### 白名单的版本与变更

白名单有版本号，写成 `rsql@1`（与单位词表 `units@1`、核对器 `literal@1` 同一种写法）。版本按规则各记：编译结果（`schema.compiled`）里每条派生规则带自己的 `rule.rsql`；顶层的 `rsql` 只管这一版的 `migrate` 与 `backfill` 表达式。派生规则与转换表达式按各自记下的版本求值，重放也是；`sql` 总用当前版本。同一个 slot 里的规则因此可以记着不同的版本。

| 变更 | 怎么做 | 对已有数据的影响 |
|---|---|---|
| 加一项（新函数、新签名、节点的新形式、放宽某项的场合） | 出新版本；同时加实验 2 的拒绝与放行用例、实验 5 的双后端用例，覆盖检查不过就不能合入 | 已有规则没有用到它，结果不变 |
| 收紧或移除一项 | 出新版本；新编译的规则不再收它 | 已编译的规则仍按记下的版本求值 |
| 改变已有项的行为（改舍入、改写方式，或 PostgreSQL 升级后某个函数的结果变了） | 不能就地改。新行为只进新版本；实现一直保留旧版本的行为，重放要用它 | 改变行为等于改变派生结果与转换结果，从而改变重放结果，所以必须带版本 |

- **规则不单独换用新版本**。一条规则只在它因别的原因重新编译时——它自己被改，或它依赖的定义变了——才换用当前的白名单版本，换用就并在这次改动里，不另生成改动、不进待确认；没有被改到的规则一直按记下的版本求值。所以内核升级不会让无关的草稿进待确认，改动分类表里也没有"换用白名单版本"这一行。换用之后规则的行为有变化（用到了行为变了的项）的，规则版本加 1，按新规则重建派生缓存。
- **转换表达式的版本永久有效**：它们在每次从头重放时都要按原样求值，所以已发布版本里的项，行为一旦定下就不能删。
- PostgreSQL 升级改变了某项的结果，由实验 5 的跨大版本对拍发现；处理是由内核钉死旧行为，或把该项移出新版本。

### 怎么测

白名单在代码里是一份数据（每项：名字、参数类型、允许的场合、所属版本），本文的表与它一致；下面的覆盖检查读这份数据，由脚本机械判定。

| 测试 | 对应本文 | 通过标准 |
|---|---|---|
| 实验 2 模糊测试（[`../07-scope-v1.md`](../07-scope-v1.md) 的技术验证实验） | 人工清单覆盖「语句形状」里每一种整条拒绝与 `SELECT` 之内拒绝的写法、「确定性」第 1–4 条点名的函数与写法、系统对象与物理名、`FOR SYSTEM_TIME`；对每条做变形（大小写、引号、注释、放进子查询、`CASE`、CTE）；另由生成器按 PostgreSQL 语法随机生成。正向用例是规格与讲解里的全部合法查询、派生规则与转换表达式 | 被放行的语句里改变了数据库状态、会话状态或调用了白名单之外函数的，数量为 0；正向用例全部放行；实现是"不认识的一律拒绝"，由代码审查确认 |
| 实验 5 双后端一致性 | 白名单里的每个节点、运算符、函数、类型转换、聚合与窗口函数，在它允许的每个场合至少一条用例；另断言每项背后的函数在两个后端上都是 `IMMUTABLE`；对抗用例覆盖除法与舍入、按周按月截断、闰日、时区边界、含中文与表情符号的排序与分组、空值 | 覆盖率 100%；两个后端结果逐字节相同，差异数为 0；打算支持的每个 PostgreSQL 大版本都满足 |
| 改写与可见范围 | 「处理步骤」第 5–7 步：用 `scoped` 到表一级的可见范围跑查询，没列出的表与不存在的表报同一个错误；派生表可见当且仅当依赖都可见；状态类表任意拆段后 SQL 结果不变 | 全部通过 |

### 第一版不收、以后可以加的

按需要加，每加一项走「白名单的版本与变更」：

- 大小写折叠与模式匹配：`lower` / `upper`、`ILIKE`、正则——要先定下与区域设置无关的折叠规则，并在两个后端上比过。
- 单位换算函数（SQL 里把 `mi` 换成 `km`），以及 `zoned_datetime` 的时区部分。
- 时刻的加减（`timestamptz ± interval`）：要先在应用层定下"加一天"在夏令时边界上的含义。
- 有序聚合（`string_agg … ORDER BY`）、分位数、标准差。
- `LATERAL`、递归 CTE、返回多行的函数：要有能事前估算代价的办法。
- 派生规则里依赖次序的窗口函数：要求排序键能证明没有并列（如以 `row_id` 收尾）之后可以放开。
- 只收 32 位整数的位置（`substr`、`left` / `right`、`split_part`、`round` / `trunc` 的位数、`date` 加减的天数）用非常量的整数：要先定下超出 32 位时的行为。
- 取自数据的 `LIKE` 模式：要先定下模式以转义字符结尾时的结果（数据库会出错，求值就因数据而出错）。
