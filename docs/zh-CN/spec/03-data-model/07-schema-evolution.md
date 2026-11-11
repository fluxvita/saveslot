# saveslot · 数据层机制 · 07 schema 版本演进（上）

> 数据层机制的一部分，目录见 [`README.md`](README.md)。文中「…」引用的节可能在同目录的其他文件里，按目录查。

## schema 版本演进

**没有现成的整体方案，但每一块都有成熟做法；saveslot 真正新的只有"靠模型重新抽取"的迁移。**

### 借鉴的成熟做法

| 做法 | 出处 | 用在 saveslot |
|---|---|---|
| 版本化迁移 / 声明式 diff | Flyway、Liquibase、Alembic；Atlas、Prisma 按目标 schema 生成迁移计划 | schema 每版不可变，迁移是一条日志事件 |
| 稳定字段 ID | Protobuf 字段编号、Apache Iceberg 列 ID | 字段用 ID 标识，名字只是标签；删掉的 ID 不复用 |
| 兼容性等级 | Confluent Schema Registry（BACKWARD / FORWARD / FULL） | 官方 schema 声明兼容性；用户 schema 由 saveslot 自动检查 |
| 后台构建、原子切换 | 零停机迁移的常用模式；在线变更工具 gh-ost（MySQL，建影子表 + 追 binlog + 切换）、pgroll（PostgreSQL） | 后台从日志构建新版，追平后在一个事务里切换；读永不停 |
| 读取时转换 | 事件溯源的 upcasting | 源数据与日志永不改写，按需转换 |
| 先预览再执行 | 类似 `terraform plan` | 落实"起草 → 确认 → 发布"的"确认" |

### 改动分类与迁移手段

改动分三个类别，代价依次升高，设计时尽量落在前两种：

| 类别 | 数据怎么变 | 要模型吗 | 例子 |
|---|---|---|---|
| 只改元数据 | 已有的值不变 | 否 | 加可选字段、改名、删字段 |
| 确定性转换 | 用一个确定的函数把旧值算成新值；函数随编译后的定义记进事件，**不记逐行结果**，重放时重新求值（见下） | 否 | 公里 → 英里；文本"好/一般/差" → 枚举 |
| 重新抽取（第一版不做） | 回到源数据原文重新得出新值，新旧并存，确认后切换 | 是 | "备注"拆成"心情"+"天气" |

**每种改动落在哪一类**由 saveslot 判定，结果确定。下表按 schema 文档里每个键的每种变化列全。"改动码"是编译回执与编译结果事件里 `changes[].change` 的取值，"类别"是 `changes[].class` 的取值：新建 `create`、只改元数据 `metadata`、确定性转换 `deterministic`、重新抽取 `reextract`（两边同名）。新建 slot、新增表不属于上面三类，单列为"新建"。类别说的是已有的值怎么变，**不决定要不要建新物理表**：那看物理形状变没变（见下）。"自动"一栏是默认 slot 策略下是否不经确认就生效（策略里的名字写在括号里，见「slot 包含什么」）；"旧写入"一栏是带旧 `sv`、写到这个字段的写入还收不收。

| 对象 | 改动 | 改动码 | 类别 | 自动 | 旧写入 | 第一版 |
|---|---|---|---|---|---|---|
| slot | 新建 | `create_slot` | 新建 | 总是直接生效 | — | 做 |
| | 改名（`rename_to`） | `rename_slot` | 只改元数据 | 要确认 | 收 | 做 |
| | 改时区 | `change_timezone` | 确定性转换（见下） | 要确认 | 收 | 做 |
| 表 | 新增基础表 | `add_table` | 新建 | 自动（`add_table`） | — | 做 |
| | 新增派生表 | `add_derived_table` | 新建（建缓存） | 自动（`add_derived_table`） | — | 做 |
| | 删表（`drop_tables`） | `drop_table` | 只改元数据 | 要确认 | 拒 | 做 |
| | 改名 | `rename_table` | 只改元数据 | 没人在用时自动（`rename_unused`），否则要确认 | 收 | 做 |
| | 改说明 | `change_description` | 只改元数据 | 自动（`description`） | 收 | 做 |
| | 改 `duplicate_keys` | `change_duplicate_keys` | 只改元数据 | 自动（`duplicate_keys`）；只影响之后的新增 | 收 | 做 |
| | 改 `together` | `change_together` | 只改元数据 | 要确认；只影响之后的冲突判定 | 收 | 做 |
| | 改事件类表的 `time.field`（换成另一个已有的日期或时刻字段） | `change_time_field` | 只改元数据 | 要确认 | 收 | 做 |
| | 增、删、改 `entity_key`；改 `granularity`；改表的时间类型；`base` 与 `derived` 互换 | `change_entity_key`、`change_granularity`、`change_time_type`、`change_table_kind` | — | — | — | 不支持 |
| 基础表的字段 | 新增可选字段 | `add_optional_field` | 只改元数据 | 自动（`add_optional_field`） | 收 | 做 |
| | 新增必填字段 | `add_required_field` | 确定性转换：必须给常量形式的 `backfill`（不看表里当时有没有行） | 要确认 | 收（按当前定义校验） | 做 |
| | 删字段（`drop_fields`） | `drop_field` | 只改元数据 | 要确认 | 拒 | 做 |
| | 改名 | `rename_field` | 只改元数据 | 没人在用时自动（`rename_unused`），否则要确认 | 收 | 做 |
| | 改说明 | `change_description` | 只改元数据 | 自动（`description`） | 收 | 做 |
| | 放宽约束：必填改可选、放宽 `min` / `max`、枚举加值、加大 `scale` | `loosen_constraint` | 只改元数据 | 自动（`loosen_constraint`） | 收 | 做 |
| | 收紧约束：可选改必填、收紧 `min` / `max`、删枚举值 | `tighten_constraint` | 确定性转换：可选改必填必须给常量形式的 `backfill`（不看有没有行）；其余有行违反时须给 `backfill` | 要确认 | 收（按当前定义校验） | 做 |
| | 减小 `scale`、改 `rounding` | `change_precision` | 确定性转换（重新舍入） | 要确认 | 收 | 做 |
| | 同量纲改单位 | `change_unit` | 确定性转换（saveslot 自动换算） | 要确认 | 收（值自带单位） | 做 |
| | 换量纲 | `change_dimension` | 确定性转换：须给 `migrate` | 要确认 | 拒 | 做 |
| | 改类型 | `change_type` | 确定性转换：须给 `migrate`（整数改小数、枚举改文本不用给） | 要确认 | 拒 | 做 |
| | 与 `ref` 互转；改 `ref` 的目标 | `change_ref` | — | — | — | 不支持（删了重建） |
| | 重新抽取（`reextract`，含新字段补抽） | `reextract` | 重新抽取 | 要确认 | — | 不支持 |
| 派生表 | 改规则或 `time_dependency` | `change_rule` | 确定性转换（按新规则重建缓存，规则版本加 1） | 要确认 | — | 做 |
| | 改字段说明 | `change_description` | 只改元数据 | 自动（`description`） | — | 做 |
| | 删表 | `drop_table` | 只改元数据 | 要确认 | — | 做 |

- **一份草稿自动生效，当且仅当它的每一项改动都在"自动"之列**；否则整份草稿进待确认。
- **"没人在用"**（`rename_unused`）：最近 30 天没有**提交者以外**的连接实例读写过这张表或这个字段。接口上读写都用名字，所以"读写过"就是"按名字用过"；只有自己在用的，改名不用确认。
- **删除有依赖的对象编译失败**（`validation_failed`，明细码 `still_referenced`，附依赖方的位置）：被 `ref` 指着的表；被派生规则、`entity_key`、`time.field`、`duplicate_keys`、`together` 用到的字段。同一份草稿里把依赖方也一并改掉或删掉时可以。
- **第一版不支持的改动与键**（上表"不支持"的各行，以及 `extends`、`compatibility`、沙箱函数规则、最外层不是聚合的派生规则、引用别的字段的 `migrate` / `backfill`）：草稿里出现时整份草稿报 `not_in_this_version`，指到那个键，不产生任何事件。`reextract` 不会被悄悄当成"只加一个可选字段"——那样 Agent 会以为旧行将被补抽。
- **建不建新物理表**与类别无关，看物理形状变没变（见「物理做法」）：改名、改说明这类只改目录的不建；加字段、删字段、改类型或单位都要建新表并按日志重放。
- **改 slot 时区**：基础数据不动——`date` 字段的值是日历日，不重算；状态类表按日的区间同理。要重建的是按 slot 时区把时刻归到某一天的派生表（规则里对 `zoned_datetime` 取日、分桶的）。它要确认，是因为之后"今天""哪一天"的含义变了。

**确定性转换怎么重放**：转换表达式是受限 SQL，和派生规则用同一套白名单，结果确定。它随编译后的定义记在"编译结果"事件里；重放时 `apply` 处理到切换事件，按编译后的定义把旧版的每条写入转换成新版形状。**逐条转换的规则**：旧写入在字段 f 上的每一项，变成新版同一字段上的一项，值 = 对这一项的旧值求 `migrate`（同量纲换单位是换算，没有 `migrate` 的字段原样）。**只有带值的项求值**：值为空的项（显式清空，`"value": null`）、`no_value` 与 `uncovered` 的项不求值，原样带过去——显式清空过的字段在新版里仍为空，不会被表达式的 `ELSE` 分支填上值。各项的生效状态、区间、值来源、佐证关系、是否被回掉都不变；候选、待确认的项同样转换，仍是候选、待确认。更早一次切换用常量 `backfill` 补出的贡献与写入的项一样转换（带值才求值），仍记在原来那次切换上。`backfill` 只作用于构建完成后仍违反新约束的位置：表达式形式的对该处的旧值求值，值来源沿用那一项的；**该处本来没有贡献、或旧值为空时，表达式形式不求值，这一处保持没有值**（与 `migrate` 同向：没有旧值就没有可算的东西）。没有旧值的位置只有常量形式给值。所以新增必填字段（`add_required_field`）、或把可选改成必填，**一律必须给常量形式的 `backfill`，不看表里当时有没有行**（空表也要给：切换之前还可能有带旧 `sv` 的写入进来），否则编译失败（`validation_failed`，明细码 `backfill_const_required`）。`backfill` 的常量形式与表达式形式不能同时给，同时给报 `validation_failed`（明细码 `backfill_both_forms`）；既收紧范围又改必填时只给常量，它同时用于违反范围的行。常量形式给出的值是**那次切换自己的贡献**：来源表与版本表里它的出处是那条 `schema.switched` 事件（来源种类是"schema 常量"，不指向任何源数据），`history` 里显示为一次由 schema 切换产生的版本。它出自 schema 里写的文字，不随任何隐私删除清除（见「删除 · 由源数据派生出的内容」）。表达式只引用本字段（见「schema 文档格式」），所以每一项的转换只看它自己。切换事件的内容里记每张新版表的行数与结果校验和，做法同派生写入：重放时有就核对，不用它来生成；它由用户内容算出，是内容，输入被删除后清除、之后跳过核对。只有抽取的翻译结果（模型的输出，不可重放）才作为内容记进"迁移结果"事件。迁移进行中发生删除时怎么办，见「删除 · 结果怎么落进日志」。

### 什么自动、什么不自动

| 环节 | 谁做 | 说明 |
|---|---|---|
| 识别改动类型、检查兼容性 | saveslot 自动 | 按「schema 文档格式」的字段匹配规则比对，结果确定 |
| 预览：多少行变、哪些派生值变、哪些消费方会坏 | saveslot 自动 | 消费方从数据目录查得：派生规则、登记的 SKILL、保存的查询，以及写死了字段的 API 脚本 |
| 写迁移函数 | 起草 schema 的 Agent（模型） | 如"好/一般/差"对应哪个枚举值；saveslot 编译、校验、试跑 |
| 执行：元数据变更、确定性转换、缓存重建 | saveslot 自动 | 结果可重放 |
| 重新抽取 | 调用方 Agent（第一版）；用户授权模型调用后也可由 saveslot 的 worker 做 | 结果是提议，与已确认值不同时进待确认 |
| 批准 | 按风险分级 | slot 策略列出哪几类改动自动生效（默认七类：不改动已有的值、不让旧写入失败、不让现有读取读到不同的东西的那些，见上表）；其余须确认 |
| 歧义：改名还是删了再加？ | 问 | 已有字段没被匹配到又没列入删除时报错，退回提交方 Agent 澄清，不猜 |

### 原则

1. **schema 版本不可变，数据不被悄悄重新解读。** 写日志记 schema 版本；按时刻读用当时那版；read_log 也记 schema 版本。
2. **重新抽取的结果是提议。** 与已确认值（尤其用户确认、纠正过的）不同就进待确认；纠错是源数据，重新抽取时一并纳入，不会丢。
3. **改动前先预览影响**，确认后执行；重新抽取在预览里给出成本（如"需重新抽取 2,300 条源数据"）。
4. **对外只有最新版。** 消费方默认只用最新 schema，旧版对外不可见；Agent 每次经 MCP 读当前 schema，自然跟进。
   旧版在内部保留，供按时刻读使用。由此要求：
   - **读取结果自带说明**：值带单位与 schema 版本（如 `3.11 mi · schema v2`），不只回一个数字，
     让 SKILL 或 Agent 记忆里的过时假设（"距离是公里"）能被发现。
   - **只拒绝写到不兼容变化字段的旧版写入**：写入带 schema 版本；自该版本以来，它写到的字段若发生了不兼容变化（改类型、换量纲、删除、语义重构），
     就拒绝并提示重读（"runs.feeling 已改为枚举（schema 4），请重新读取"）；写到的字段没变（或只是改名、加了别的可选字段）就照常接受。
     版本仍以 slot 为单位管理，但兼容性按字段判断——否则改 slot 里任意一张表，都会拒掉所有 Agent 的写入。
     写入的值自带单位、同量纲自动换算，所以**同量纲内只改单位对旧版写入是兼容的**，不在拒绝之列。
     收紧约束（可选改必填、收紧范围、删枚举值）也不算不兼容：写入一律按当前定义校验，不满足就报 `validation_failed`。
   - **不读 schema 的消费方**（写死字段的 API 脚本）无法自动跟进，只能在预览里列出、由用户决定。

### schema 文档格式

**读写同一形状的 JSON 文档；提交"表内整份、slot 内只交改动"；名字由 Agent 写，ID 由 saveslot 分配并回填；删除必须显式。**

- **提交粒度**：草稿只列要新建或改动的表，每张列出的表给完整定义；没列的表不变；删字段写进表的 `drop_fields`，删表写进 `drop_tables`。
  不设字段级增量操作语言——Agent 读到的就是整份定义，改完交回最自然。
- **名字与 ID**：Agent 用名字引用表与字段；saveslot 分配表、字段、规则的 ID，编译结果里回填。表 ID 在用户内唯一、字段 ID 在表内唯一，
  用短 ID（`t1`、`f2`），删掉的不复用；物理名是 `t_<表 ID>_v<n>`、`f_<字段 ID>`（永不对外）。
  **表名在 slot 内唯一**；接口接受限定名 `health.runs`，用户内不重名时可只写表名。
- **并发**：草稿带 `base_version`（起草所依据的版本，建 slot 时为 `null`），与当前版本对不上即拒绝，要求基于新版重新起草。

**字段匹配规则**（结果确定，不猜）：

| 提交里的字段 | saveslot 的处理 |
|---|---|
| 带 `id` | 按 ID 匹配；名字不同即改名 |
| 不带 `id`，名字与现有字段相同 | 同一字段 |
| 不带 `id`，名字是新的 | 新增 |
| 现有字段既没按 ID 也没按名字匹配到，又不在 `drop_fields` 里 | 报错："f3 duration 未出现；要改名请带回 id，要删除请列入 drop_fields" |

不改名的 Agent 可以完全不管 ID；漏写一个字段不会被当成删除。表的匹配同理。

**文档结构**：

| 层级 | 键 | 谁写 | 说明 |
|---|---|---|---|
| slot | `slot`、`base_version`、`timezone`、`rename_to`（可选） | Agent | `timezone` 决定 `date` 的自然日语义；`rename_to` 给 slot 改名 |
| 表 | `name`、`id`、`kind`（`base` / `derived`）、`description`（必填）、`time` | Agent，`id` 由 saveslot 回填 | `time.type`：`none` / `event` / `state` |
| 事件类表 | `time: {type: "event", field: "<字段>"}` | Agent | 指定发生时间字段（`date` 或 `zoned_datetime`） |
| 状态类表 | `time: {type: "state", granularity: "date" \| "instant"}`、`entity_key`（可选，字段名数组，如 `["category"]`） | Agent | 生效区间由 saveslot 管理，不作为字段出现；`entity_key` 是可选的自然键，列出的字段须必填；键字段不随业务时间变化，键唯一是全时间唯一（见「时间 · 按 `entity_key` 写入」） |
| 字段组 | 表上的 `together`（可选，字段名数组的数组，如 `[["start", "end"]]`） | Agent | 同组字段是一个冲突单元（见下方「字段组」） |
| 字段 | `name`、`id`、`type`、`description`（必填）、`required`、`min` / `max`、`values`（枚举）、`unit`、`scale` / `rounding`（`quantity`、`decimal` 的精度，可选）、`ref: {table, target: "row" \| "entity"}` | Agent，`id` 由 saveslot 回填 | 类型的取值范围、单位词表、精度的默认值见「字段类型、同值与单位」 |
| 疑似重复 | `duplicate_keys`（字段名数组的数组，每组是一套判据） | Agent | 只能用在事件类表与无时间表上。软判据：命中生成待处理事项，不拒绝写入（见「写入请求 · 疑似重复」）；首版不做硬唯一约束 |
| 派生表 | `rule.sql`、`rule.time_dependency`（`none` / `bucketed` / `now`）；每个字段一句 `description` | Agent | SQL 用名字写，saveslot 存为按 ID 绑定的形式（改名不坏规则）；字段类型、单位、依赖、重算范围由 saveslot 推断回填 |
| 迁移 | 字段上的 `migrate`（受限 SQL 表达式，确定性转换）、`backfill`（收紧约束时补违反的行）；表上的 `drop_fields`；slot 上的 `drop_tables`。`reextract: {from, instructions}`（重新抽取：从哪些旧字段与源数据原文抽、怎么抽；`from` 为空即新字段补抽）**第一版不支持** | Agent | 只在 saveslot 推不出时写；同量纲改单位由 saveslot 自动换算，不需要迁移函数；重新抽取走抽取作业（见下文「抽取作业」） |
| 官方 schema | `extends`、`compatibility` | — | 键名预留，细则待定 |

- **类型（首版）**：`text`、`integer`、`decimal`、`boolean`、`enum`、`date`、`zoned_datetime`（时刻 + IANA 时区，"哪一天"可复算）、
  `quantity`（数值 + 单位，存为声明单位下的十进制数）、`ref`（指向同一 slot 的另一张表；第一版不跨 slot）。各类型的取值范围见「字段类型、同值与单位」。
- **名字**：slot 名、表名、字段名只用字母、数字与下划线，字母开头，至多 63 个字符；不得以 `_` 开头，字段名不得是 `valid`、`valid_from`、`valid_to`。违反时编译报 `validation_failed`（`reserved_name`）。说明文字不受这个限制。
- **单位取自固定的单位词表**（见「字段类型、同值与单位 · 单位词表」）：同量纲的单位自动换算；词表外的单位编译时拒绝。
- **货币也用 `quantity`，但每种货币自成一个量纲、互不换算**（汇率不是固定系数）：写入单位与字段声明的货币不同报 `validation_failed`。
  要换算就把汇率作为基础数据接入、在派生规则里算（见「派生规则」）。
- **表间关系**：基础表之间用 `ref` 声明；派生关系由 saveslot 解析规则得出。
- **字段组**（`together`）：并发写入按字段合并，单个字段上的约束不会被合并破坏，会被破坏的只是跨字段的关系。例：出差 `start 11-01, end 11-05`，一方把 `end` 改成 11-03，一方把 `start` 改成 11-04，各自都不冲突，合并出 `start` 晚于 `end` 的行。只有 schema 的作者知道哪些字段有关系，所以由 schema 声明：同组字段作为一个冲突单元，改到组里任何一个字段，就与改到组里任何字段的写入相交。不声明时每个字段自成一个单元。字段组只影响冲突判定与事项的目标，不影响挡点、来源、同值判断（见「冲突处理 · 冲突判据」）。字段组在编译后的定义里、随 `sv` 走；删除重放按写入记下的 `sv`。
- **派生字段的单位**由 saveslot 推断（`sum` / `avg` / `min` / `max`、乘除常数）；推不出就报错，要求在该字段写明 `unit`。
- **兼容性与迁移类别由 saveslot 判定**（只改元数据 / 确定性转换 / 重新抽取），在编译回执的 `changes` 里逐项列出。
- **第一版 `migrate`、`backfill` 的表达式只能引用本字段自己的旧值与常量**（表达式里唯一能出现的列名是这个字段在 `base_version` 里的名字）。引用别的字段报 `not_in_this_version`。原因：迁移是把旧版的每条写入逐条转换成新版形状（见下文「确定性转换怎么重放」），一条写入只记它涉及的字段；转换只依赖本字段时，每条写入对这个字段的那一项恰好变成新版的一项，状态、区间、来源原样带过去。依赖别的字段时，一条只写了别的字段的写入也会改变转换结果，它在新版里算不算一项贡献、区间怎么定，需要另一套规则，后续再做。要按几个字段合成一个新字段，第一版的做法是加一个派生表，或由 Agent 读出来重新写入。
- **草稿里的 `migrate` 表达式与 `reextract.from` 一律按 `base_version` 的名字解析**（同一草稿里既改名又改类型时不会歧义；`from` 可以引用本草稿要删的旧字段）。
- **收紧约束**（可选改必填、收紧 `min` / `max`、删枚举值）：字段上给 `backfill`（受限 SQL 表达式或常量，二者只能给一种）处理违反的现有行；没给且有行违反就编译失败，报出违反行数与样例。可选改必填与新增必填字段一律必须给常量形式，不看有没有行。
- **改 slot 时区**改变所有 `date` 的自然日语义，归为确定性转换，须确认；具体重建什么见「改动分类」。
- 目录里取回的完整文档（`catalog` 的完整 schema 一档）已填好 `base_version`（= 当前版本），改完可直接提交。
- **旧名字还认多久**：
  - 写入按请求带的 `sv` 解析名字再映射到字段 ID，任何版本的名字都认——改名后带旧版名字的写入照常接受。
  - 不带 `sv` 的读取：一个名字若是某个字段在**最近 10 个 schema 版本**内用过的旧名、且当前没有别的表或字段叫这个名字，就按旧名解析，并在回执里提示新名。当前名优先。
- **改名自动生效的前提是没有别人在用它**：第一版从读写记录推断（"提交者以外的某个连接实例最近 30 天读写过 runs.duration"），有则列入预览、须确认；显式登记消费方以后再做。
  读一侧从 read_log 推出；写一侧由 `write` 落账时把"本次按名字引用了哪些字段"交给 `audit` 计数（(c) 类，丢了只是预览少列一个消费方）。

**例：新建 slot（v1 草稿）**

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
        { "name": "total_distance", "description": "该周总距离" },
        { "name": "run_count", "description": "该周跑步次数" }
      ]
    }
  ]
}
```

规则里的 `::timestamp` 不能省：否则 PostgreSQL 选带时区的 `date_trunc`，结果随会话时区变，编译时按"非确定函数"拒绝并给出改法。

**编译回执（节选）**：回填 ID 与推断结果。

```json
{
  "draft": "d_…", "slot": "health", "slot_id": "sl_…", "target_sv": 1, "outcome": "applied",
  "document": {
    "tables": [
      { "name": "runs", "id": "t1",
        "fields": [{ "name": "date", "id": "f1" }, { "name": "distance", "id": "f2" }, { "name": "duration", "id": "f3" }, { "name": "feeling", "id": "f4" }] },
      { "name": "weekly_mileage", "id": "t2",
        "rule": { "id": "r1", "version": 1, "depends_on": ["runs.date", "runs.distance"], "scope": { "kind": "group", "key": ["week_start"] } },
        "fields": [
          { "name": "week_start", "id": "f1", "type": "date" },
          { "name": "total_distance", "id": "f2", "type": "quantity", "unit": "km" },
          { "name": "run_count", "id": "f3", "type": "integer" }
        ] }
    ]
  },
  "changes": [{ "target": { "slot": true }, "change": "create_slot", "class": "create",
                "compatible_with_old_writes": true, "destructive": false, "auto": true }]
}
```

回执的完整形状以 contract 的类型定义为准；这里只示意回填了什么。`outcome` 是 `applied`（已生效）或 `pending`（生成了 `schema_change` 事项，等确认）。

**例：v2 草稿**（在读到的 schema 上改，只列 runs）。这是完整设计的例子：其中 `avg_hr` 的 `reextract` 第一版不支持，带着它提交会整份报 `not_in_this_version`；第一版里去掉那个键，`avg_hr` 就是一个普通的新增可选字段。

```json
{
  "slot": "health", "base_version": 1,
  "tables": [{
    "name": "runs", "id": "t1", "kind": "base", "description": "每次跑步一行",
    "time": { "type": "event", "field": "date" },
    "fields": [
      { "id": "f1", "name": "date", "type": "date", "required": true, "description": "跑步当天（slot 时区的自然日）" },
      { "id": "f2", "name": "distance", "type": "quantity", "unit": "mi", "required": true, "min": 0, "description": "距离" },
      { "id": "f3", "name": "moving_time", "type": "quantity", "unit": "min", "description": "移动时间" },
      { "id": "f4", "name": "feeling", "type": "enum", "values": ["good", "ok", "bad"], "description": "跑后感受",
        "migrate": { "sql": "CASE feeling WHEN '好' THEN 'good' WHEN '一般' THEN 'ok' ELSE 'bad' END" } },
      { "name": "avg_hr", "type": "quantity", "unit": "/min", "description": "平均心率",
        "reextract": { "from": [], "instructions": "原文提到心率时填写，没提就留空" } }
    ]
  }]
}
```

| 改动 | 类别 | 处理 |
|---|---|---|
| f2 km → mi | 确定性转换 | saveslot 自动换算，weekly_mileage 重建、单位随之变；同量纲改单位，对旧版写入兼容 |
| f3 改名 | 只改元数据 | 不动数据 |
| f4 文本 → 枚举 | 确定性转换 | 用 `migrate`，在现有行上试跑并报告结果；改了类型，带旧 `sv` 写 `feeling` 的请求被拒。表达式只对带值的项求值：`feeling` 被显式清空过、或从没填过的行，新版里仍为空，不会落到 `ELSE 'bad'` 上 |
| avg_hr 新增 | 只改元数据 + 补抽 | 旧行先为空，补抽走抽取作业；新字段原本为空，补抽结果不需要确认 |

**例：状态类表**（新建 `marketing` slot）：

```json
{
  "slot": "marketing", "base_version": null, "timezone": "Asia/Shanghai",
  "tables": [{
    "name": "budgets", "kind": "base", "description": "各类别的月度预算",
    "time": { "type": "state", "granularity": "date" },
    "entity_key": ["category"],
    "fields": [
      { "name": "category", "type": "text", "required": true, "description": "预算类别" },
      { "name": "amount", "type": "quantity", "unit": "CNY", "required": true, "min": 0, "description": "月度预算金额" }
    ]
  }]
}
```

写入时按 `entity_key: {"category": "推广"}` 定位实体，生效区间用 `valid_from` / `valid_to` 传（见 contract「写入」），不是字段。

状态机、物理做法、抽取作业与官方 schema 见 [`08-schema-migration.md`](08-schema-migration.md)。
