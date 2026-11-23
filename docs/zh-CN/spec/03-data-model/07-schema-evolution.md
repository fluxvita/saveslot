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

**每种改动落在哪一类**由 saveslot 判定，结果确定。下表按 schema 文档里每个键的每种变化列全。"改动码"是编译回执与编译结果事件里 `changes[].change` 的取值，"类别"是 `changes[].class` 的取值：新建 `create`、只改元数据 `metadata`、确定性转换 `deterministic`、重新抽取 `reextract`（两边同名）。新建 slot、新增表不属于上面三类，单列为"新建"。类别说的是已有的值怎么变，**不决定要不要建新物理表**：那看物理形状变没变（见下）。"自动"一栏是默认 slot 策略下是否不经确认就生效（策略里的名字写在括号里，见「slot 包含什么」）；"旧写入"一栏是带旧 `sv`、写到这个字段的写入还收不收。**"类别"与"旧写入"两栏写的是写入过的表上的情形**：一项改动经 `restructure_unused` 生效时（从未被写入、没人在用的表），`changes[].class` 一律记 `metadata`，`migrate` 不必给；之后带旧 `sv` 写这张表的写入一律被拒（见下）。`class` 记的是这次切换实际做了什么：这张表没有已有的值，也没有转换。

| 对象 | 改动 | 改动码 | 类别 | 自动 | 旧写入 | 第一版 |
|---|---|---|---|---|---|---|
| slot | 新建 | `create_slot` | 新建 | 总是直接生效 | — | 做 |
| | 改名（`rename_to`） | `rename_slot` | 只改元数据 | 要确认 | 收 | 做 |
| | 改时区 | `change_timezone` | 确定性转换（见下） | 要确认 | 收 | 做 |
| 表 | 新增基础表（可带 `external_key`） | `add_table` | 新建 | 自动（`add_table`） | — | 做 |
| | 新增派生表 | `add_derived_table` | 新建（建缓存） | 自动（`add_derived_table`） | — | 做 |
| | 删表（`drop_tables`） | `drop_table` | 只改元数据 | 要确认 | 拒 | 做 |
| | 改名 | `rename_table` | 只改元数据 | 没人在用时自动（`rename_unused`），否则要确认 | 收 | 做 |
| | 改说明 | `change_description` | 只改元数据 | 自动（`description`） | 收 | 做 |
| | 改别名（`aliases`） | `change_aliases` | 只改元数据 | 自动（`description`） | 收 | 做 |
| | 改 `duplicate_keys` | `change_duplicate_keys` | 只改元数据 | 自动（`duplicate_keys`）；只影响之后的新增 | 收 | 做 |
| | 改 `together` | `change_together` | 只改元数据 | 要确认；只影响之后的冲突判定 | 收 | 做 |
| | 改事件类表的 `time.field`（换成另一个已有的日期或时刻字段） | `change_time_field` | 只改元数据 | 从未被写入、没人在用的表上自动（`restructure_unused`）；否则要确认 | 收 | 做 |
| | 改表的时间类型 | `change_time_type` | 只改元数据（表里没有值） | 没人在用时自动（`restructure_unused`），否则要确认 | 拒（整张表） | 表从未被写入时做，否则不支持 |
| | 增、删、改 `entity_key` | `change_entity_key` | 只改元数据（表里没有值） | 没人在用时自动（`restructure_unused`），否则要确认 | 拒（整张表） | 表从未被写入时做，否则不支持 |
| | 改 `granularity` | `change_granularity` | 只改元数据（表里没有值） | 没人在用时自动（`restructure_unused`），否则要确认 | 拒（整张表） | 表从未被写入时做，否则不支持 |
| | `base` 改 `derived` | `change_table_kind` | 只改元数据（表里没有值） | 没人在用时自动（`restructure_unused`），否则要确认 | 拒（整张表） | 表从未被写入时做，否则不支持 |
| | `derived` 改 `base` | `change_table_kind` | — | — | — | 不支持（删了重建） |
| | 给已有的表加 `external_key` | `add_external_key` | 只改元数据 | 从未被写入、没人在用的表上自动（`restructure_unused`）；否则要确认 | 收（按当前定义校验） | 做；写入过的表上键字段必须是同一份草稿里新增的字段 |
| | 去掉 `external_key` | `drop_external_key` | 只改元数据 | 从未被写入、没人在用的表上自动（`restructure_unused`）；否则要确认 | 收 | 做 |
| | 换一组键字段 | `change_external_key` | 只改元数据 | 没人在用时自动（`restructure_unused`），否则要确认 | 收 | 表从未被写入时做，否则不支持（一份草稿里去掉旧键、新增字段并声明新键） |
| 基础表的字段 | 新增可选字段 | `add_optional_field` | 只改元数据 | 自动（`add_optional_field`） | 收 | 做 |
| | 新增必填字段 | `add_required_field` | 确定性转换：必须给常量形式的 `backfill`（不看表里当时有没有行） | 从未被写入、没人在用的表上自动（`restructure_unused`）；否则要确认（`backfill` 照样要给） | 收（按当前定义校验） | 做 |
| | 删字段（`drop_fields`） | `drop_field` | 只改元数据 | 从未被写入、没人在用的表上自动（`restructure_unused`）；否则要确认 | 拒 | 做 |
| | 改名 | `rename_field` | 只改元数据 | 没人在用时自动（`rename_unused`），否则要确认 | 收 | 做 |
| | 改说明 | `change_description` | 只改元数据 | 自动（`description`） | 收 | 做 |
| | 改别名（`aliases`） | `change_aliases` | 只改元数据 | 自动（`description`） | 收 | 做 |
| | 放宽约束：必填改可选、放宽 `min` / `max`、枚举加值、枚举取值只调换顺序（不改变任何取值的含义）、加大 `scale` | `loosen_constraint` | 只改元数据 | 自动（`loosen_constraint`） | 收 | 做 |
| | 收紧约束：可选改必填、收紧 `min` / `max`、删枚举值 | `tighten_constraint` | 确定性转换：可选改必填必须给常量形式的 `backfill`（不看有没有行）；其余有行违反时须给 `backfill` | 从未被写入、没人在用的表上自动（`restructure_unused`）；否则要确认 | 收（按当前定义校验） | 做 |
| | 减小 `scale`、改 `rounding` | `change_precision` | 确定性转换（重新舍入） | 从未被写入、没人在用的表上自动（`restructure_unused`）；否则要确认 | 收 | 做 |
| | 同量纲改单位 | `change_unit` | 确定性转换（saveslot 自动换算） | 从未被写入、没人在用的表上自动（`restructure_unused`）；否则要确认 | 收（值自带单位） | 做 |
| | 换量纲 | `change_dimension` | 确定性转换：须给 `migrate`（从未被写入的表上不必给） | 从未被写入、没人在用的表上自动（`restructure_unused`）；否则要确认 | 拒 | 表从未被写入时做；写入过的表上后续（报 `not_in_this_version`，见 [07-scope-v1](../07-scope-v1.md)） |
| | 改类型 | `change_type` | 确定性转换：须给 `migrate`（整数改小数、枚举改文本不用给；从未被写入的表上不必给） | 从未被写入、没人在用的表上自动（`restructure_unused`）；否则要确认 | 拒 | 表从未被写入时做；写入过的表上后续（报 `not_in_this_version`，见 [07-scope-v1](../07-scope-v1.md)） |
| | 来源键的键字段改类型、收紧约束 | `change_type`、`tighten_constraint` | 同上两行 | 同上两行 | 同上两行 | 表从未被写入时做（改后的类型仍须是来源键允许的类型）；否则不支持：转换后的值可能相撞 |
| | 与 `ref` 互转；改 `ref` 的目标 | `change_ref` | 只改元数据（表里没有值） | 没人在用时自动（`restructure_unused`），否则要确认 | 拒 | 这个字段所在的表从未被写入时做，否则不支持（删了重建） |
| | 重新抽取（`reextract`，含新字段补抽） | `reextract` | 重新抽取 | 要确认 | — | 不支持 |
| 派生表 | 改规则或 `time_dependency` | `change_rule` | 确定性转换（按新规则重建缓存，规则版本加 1） | 要确认 | — | 做 |
| | 改字段说明 | `change_description` | 只改元数据 | 自动（`description`） | — | 做 |
| | 改表或字段的别名 | `change_aliases` | 只改元数据 | 自动（`description`） | — | 做 |
| | 删表 | `drop_table` | 只改元数据 | 要确认 | — | 做 |

- **一份草稿自动生效，当且仅当它的每一项改动都在"自动"之列**；否则整份草稿进待确认。**同一个改动码是否自动，可以依它所在的表而定**：上表"自动"一栏写着 `restructure_unused` 的各行，在从未被写入、没人在用的表上自动，在别的表上照那一栏的后半句。同一份草稿里另有须确认的改动（例如同时改了另一张写入过的表）时，整份进待确认。
- **"没人在用"**（`rename_unused`、`restructure_unused`）：最近 30 天没有**提交者以外**的连接实例读写过这张表或这个字段。接口上读写都用名字，所以"读写过"就是"按名字用过"；只有自己在用的，改名、改结构不用确认。有别人在用时，预览的 `impact.consumers` 列出它们。
- **从未被写入**（`never_written`）：一张基础表从未被写入，当且仅当日志里没有任何一条以这张表（按表 ID）为目标的 `write.base` 事件。判据只看日志，重放时可以复算；实现上查事件表里按表 ID 建的索引列，不扫全表。

  | 情形 | 算不算从未被写入 | 原因 |
  |---|---|---|
  | 建好之后一次都没写过 | 算 | — |
  | 写过，行已全部撤销 | **不算** | 撤销是一次写入；行与它的历史还在，按时刻读、`timeline`、`undo` 都要用，改了结构这些历史无处安放 |
  | 写过，内容已全部隐私删除、物理删除也已执行 | **不算** | 事件头与墓碑留在日志里；重放到切换时仍要处理这些写入 |
  | 写过，但写入没生效（成了候选，或在待确认里） | **不算** | 候选与待确认的写入同样是 `write.base` 事件，迁移时要一并转换；指向它们的事项也还在 |
  | 只被读过（读到空结果） | 算 | 读取记录不在日志里，没有要迁移的东西；但它让这张表"有人在用"，改结构要确认 |

- **空 slot**（能用契约 `slots.remove` 移除的）是 slot 一级的同一类判据，范围更宽：slot 名下除结构（`schema.*`）与策略（`slot.policy_set`）外没有任何事件——源数据、任何写入（含没生效、全被拒的）、事项（结构变更事项除外，但它开着时也不能移除）、删除、前提变化都算有记录，以后新加的事件类型也算。所以 slot 里每张表都"从未被写入"不等于 slot 为空（例如只有源数据、只有被撤销的写入）。各事件类型的归类见 [`../../process/decisions/remove-empty-slot.md`](../../process/decisions/remove-empty-slot.md)。
  | 被派生规则或别的表的 `ref` 依赖 | 算 | 依赖方按下面的规则处理 |
  | 经历过别的 schema 变更（加过字段、改过名） | 算 | 没有写入，之前的切换都没有补过值 |

  不用"当前没有未撤销的行"：那样的表仍有历史与事件，改结构就得回答"已撤销的事件类的行在状态类表里是什么"。也不按字段判断"这个字段从未被写入"：那要多一个定义（显式写 `null`、切换补出的常量算不算），而表里有数据时删掉字段再加一个代价很小。代价是写过一条测试数据的表只能删了重建，编译回执与文档写明这一点。
- **从未被写入的表上改结构**：没有值可丢、也没有值要转换，`destructive` 为 `false`，`class` 记 `metadata`，`migrate` 不必给；表 ID 与字段 ID 不变。改完的定义按新建表的规则校验：改成事件类要指定 `time.field`；改成状态类不能再带 `duplicate_keys`、`external_key`；`entity_key` 只能出现在状态类表上、键字段须必填；`external_key` 只能出现在事件类表与无时间表上、键字段的类型按来源键的限制；`base` 改 `derived` 后字段的类型与单位改由编译器从规则推断。**新增必填字段与可选改必填仍须给常量形式的 `backfill`**：这一条不看表有没有被写入过、也不分自动生效还是要确认，一律要给。这样同一份草稿的编译结果不随表当时的状态与走哪条路径而变；要给的只是一个常量，代价很小（见下「确定性转换怎么重放」）。
  - `derived` 改 `base` 仍不支持：派生表"有没有数据"不能只凭日志判断（依赖"今天"的规则读时计算，从不产生派生写入，但调用方已经读到过值）；派生表自己没有数据可丢，删了重建没有损失。
  - **依赖方**：第一版：改到被派生规则读的字段时（改类型、换量纲、改单位、改精度），整份草稿报 `not_in_this_version`（`reason`：`not_implemented`，`param` 指到那个键），见 [07-scope-v1](../07-scope-v1.md)；删掉被读的字段照旧报 `still_referenced`。以下是完整设计。依赖这张表的派生规则在同一次编译里按新定义重新编译；编译不过，整份草稿报 `validation_failed`（`rule_sql_rejected`，`path` 指到那条规则），在同一份草稿里一并改掉即可。编译得过时规则版本加 1；规则的输出字段、单位、`time_dependency`、重算范围都没变的不另列改动，有变化的另列一项 `change_rule`，按它的规则要确认。别的表里指向这张表的 `ref` 字段，`ref.target`（`row` / `entity`）必须与改后的时间类型相符：不相符而引用方也从未被写入时，在同一份草稿里把引用方一并改掉（引用方的 `change_ref`）；引用方写入过时编译失败（`validation_failed`，`still_referenced`，指到引用方）。
  - **编译时表已被写入**：只在从未被写入的表上才做的改动，整份报 `not_in_this_version`，`reason` 是 `table_written`，`param` 指到那个键。
  - **确认时重新判断**：草稿等确认期间旧版照常可写。确认时在同一个事务里重新判断：草稿里**凡按"从未被写入"编译的改动**——表一级的结构改动，以及 `class` 因此记为 `metadata`、可以不给 `migrate` 的那些（删字段、改类型、改单位、收紧约束、来源键的增删换等）——所在的表这时已被写入，`resolve` 一律报 `draft_outdated`（`reason`：`table_written`），不产生任何事件，事项保持未决。不按"这项改动在写入过的表上本来也允许"放行：编译结果与确认方看到的是"不丢数据、没有转换"，表被写入之后照它切换，就会丢掉或不经转换地带过刚写进去的值。"从未被写入"一旦不成立就永远不成立，这份草稿不可能再被确认：调用方 `reject` 它，或提交新草稿取代它。
    - **收紧约束而没给 `backfill` 的草稿，确认时重数违反的位置**：提交时没有违反，等确认期间旧版写进了违反新约束的值，确认时（同一个事务）报 `draft_outdated`（`reason`：`backfill_required`，明细同编译时的 `backfill_required`），不产生任何事件，事项保持未决。与 `table_written` 不同，它可以补救：调用方 `reject` 它，提交一份带 `backfill` 的新草稿。
    - **改 slot 名的草稿，确认时也重判新名**：待确认的草稿不占名字，其间别的 slot 可以用上这个名字（新建，或另一份改名草稿先确认）。确认带 `rename_slot` 的草稿时，在同一个事务里按提交时同一套比较（不分 ASCII 大小写）重新判断新名：已被另一个 slot 用着，`resolve` 报 `draft_outdated`（`reason`：`name_taken`），不产生任何事件，事项保持未决；调用方 `reject` 它，或另起一个名字提交新草稿。重放时切换之后若出现两个比较后同名的 slot，`apply` 按不一致停下。
  - **带旧 `sv` 的写入**：经 `restructure_unused` 生效的任何改动（不只是改时间类型、`entity_key`、`granularity`、`base` 改 `derived` 这些表一级的改动，也包括删字段、改类型、来源键的增删换等），之后带旧 `sv` 写这张表的写入一律被拒（`schema_incompatible`），`changed_fields` 里给一项 `{field: "*", change: <改动码>}`。表的结构是整体换过的，写入里的字段不按旧定义逐个解释；一种情形一个码，调用方只需重读。
  - 与"删表再建同名表"相比，就地改结构只要一份草稿（同名的表按名字匹配成同一张表，一份草稿里表达不了"删掉再建一张同名的"），没人在用时不用确认，表 ID、字段 ID、说明、别名与其他约束都留着，依赖它的派生规则与 `ref` 按新定义重新编译，不必先删掉。
- **删除有依赖的对象编译失败**（`validation_failed`，明细码 `still_referenced`，附依赖方的位置）：被 `ref` 指着的表；被派生规则、`entity_key`、`external_key`、`time.field`、`duplicate_keys`、`together` 用到的字段。同一份草稿里把依赖方也一并改掉或删掉时可以（如删键字段时一并去掉 `external_key`）。
- **第一版不支持的改动与键**（上表"不支持"的各行；"表从未被写入时做"的各行用在写入过的表上；以及 `extends`、`compatibility`、沙箱函数规则、最外层不是聚合的派生规则、字段上的 `migrate`、表达式形式的 `backfill`）：草稿里出现时整份草稿报 `not_in_this_version`，指到那个键，不产生任何事件。`reextract` 不会被悄悄当成"只加一个可选字段"——那样 Agent 会以为旧行将被补抽。
- **来源键**（`external_key`）：
  - **写入过的表上，键只能加在同一份草稿新增的字段上**（因此现有的行在这些字段上都没有值，键索引从空开始）；键字段是已有字段时编译报 `validation_failed`（`external_key_existing_field`）。键字段若有历史，一次隐私删除可能让它落回更早的值，而那个值此时可能已被另一行占用；这与"键不可改"是同一个原因（见「时间 · 按 `entity_key` 写入」）。从未被写入的表上没有行，键索引是空的，键可以加在已有字段上，也可以直接换一组字段。
  - 去掉来源键：键索引清空；键字段变回普通字段，值留在行上，不再不可改。
  - **写入过的表上，来源键的改动都要确认**，不为来源键新增自动生效的类别；从未被写入的表上归入已有的 `restructure_unused`。
  - 键字段放进 `together`：编译报 `validation_failed`（`external_key_in_together`）。键字段改名、改说明、枚举加值照已有规则。
  - 写入过的表上按上面的规则改来源键（加在新增字段上、去掉）之后，带旧 `sv` 的写入照收（按当前定义校验）；从未被写入的表上经 `restructure_unused` 改来源键，照上面一律被拒。切换时键索引按新版表重建；迁移不改行 ID。
- **规则与受限 SQL 白名单的版本**：`schema.compiled` 里每条派生规则记下自己编译时用的白名单版本（`rule.rsql`，`rsql@1` 这样的写法），这一版的转换表达式另记一个（顶层 `rsql`）；派生规则与转换表达式重放时按记下的版本求值，内核保留旧版本的行为。白名单改变已有项的行为就出新版本。**一条规则只在它因别的原因重新编译时才换用当前的白名单版本**：它自己被改（`change_rule`），或它依赖的定义变了而在同一次编译里重新编译；换用并在这次改动里，不单列一项改动。没有被改到的规则一直按记下的版本求值，所以内核升级不会让无关的草稿进待确认。换用让规则的结果有变化的（用到了行为改变的项），规则版本加 1、按新版本重建派生缓存（见 [「受限 SQL」](11-restricted-sql.md)「白名单的版本与变更」）。转换表达式不换用：它记下的版本在每次从头重放时都按原样求值。
- **建不建新物理表**与类别无关，看物理形状变没变（见「物理做法」）：改名、改说明、改别名这类只改目录的不建；加字段、删字段、改类型或单位都要建新表并按日志重放；从未被写入的表改结构换一张新的物理表，但没有写入要转换，与新增一张表一样在切换的事务里建好。
- **改 slot 时区**：基础数据不动——`date` 字段的值是日历日，不重算；状态类表按日的区间同理。要重建的是按 slot 时区把时刻归到某一天的派生表（规则里用 `saveslot_date(f)` 对 `zoned_datetime` 取日、分桶的）；`saveslot_date(f)` 背后的内部日期列在改时区的切换里随之重算（见 [「受限 SQL」](11-restricted-sql.md)「时间」）。它要确认，是因为之后"今天""哪一天"的含义变了。

**确定性转换怎么重放**：第一版没有转换表达式：`migrate` 与表达式形式的 `backfill` 报 `not_in_this_version`（见 [07-scope-v1](../07-scope-v1.md)），本段讲表达式的部分是完整设计；同量纲换单位、改精度与常量形式的 `backfill` 照本段做。转换表达式是受限 SQL，和派生规则用同一套白名单（见 [「受限 SQL」](11-restricted-sql.md)），结果确定。它随编译后的定义记在"编译结果"事件里；重放时 `apply` 处理到切换事件，按编译后的定义把旧版的每条写入转换成新版形状。**逐条转换的规则**：旧写入在字段 f 上的每一项，变成新版同一字段上的一项，值 = 对这一项的旧值求 `migrate`（同量纲换单位是换算，没有 `migrate` 的字段原样）。**只有带值的项求值**：值为空的项（显式清空，`"value": null`）、`no_value` 与 `uncovered` 的项不求值，原样带过去——显式清空过的字段在新版里仍为空，不会被表达式的 `ELSE` 分支填上值。各项的生效状态、区间、值来源、佐证关系、是否被回掉都不变；候选、待确认的项同样转换，仍是候选、待确认。更早一次切换用常量 `backfill` 补出的贡献与写入的项一样转换（带值才求值），仍记在原来那次切换上。`backfill` 只作用于构建完成后仍违反新约束的位置，**而且只在存在的行上**：事件类表、无时间表上是未撤销的行；状态类表上是实体存在、该字段没有值的区间。已撤销的行、撤销留下的无值区间、实体不存在的区间都不补——"必填"约束的是存在的行；在撤销之内补值等于在无值区间里填值，之后撤回那次撤销时行就回不来。在这些位置上：表达式形式的对该处的旧值求值，值来源沿用那一项的；**该处本来没有贡献、或旧值为空时，表达式形式不求值，这一处保持没有值**（与 `migrate` 同向：没有旧值就没有可算的东西）。没有旧值的位置只有常量形式给值。所以新增必填字段（`add_required_field`）、或把可选改成必填，**一律必须给常量形式的 `backfill`，不看表里当时有没有行**（空表也要给，从未被写入的表改结构时同样要给：编译结果不随表当时的状态而变），否则编译失败（`validation_failed`，明细码 `backfill_const_required`）。`backfill` 的常量形式与表达式形式不能同时给，同时给报 `validation_failed`（明细码 `backfill_both_forms`）；既收紧范围又改必填时只给常量，它同时用于违反范围的行。常量形式给出的值是**那次切换自己的贡献**：来源表与版本表里它的出处是那条 `schema.switched` 事件（来源种类是"schema 常量"，不指向任何源数据），`history` 里显示为一次由 schema 切换产生的版本。这个版本不能撤回：`undo` 的目标是 schema 切换的操作号时报 `invalid_argument`（`undo_target`），要改就提交新的 schema 草稿；常量补出的项也从不列进任何回退记录（`undo`、`include_later`、`take_previous` 都跳过它们）。常量本身出自 schema 里写的文字，不随任何隐私删除清除（见「删除 · 由源数据派生出的内容」）。**补值不改 `ver`，所以带当前 `ver` 的写入与补值不冲突**：判定取"当前 `ver`"时跳过意图为 `schema_switch` 的项；补值只是缺省常量，覆盖它不丢任何人看过的判断，读过旧值的一方靠 `schema_updated` 提示得知。**补在哪些位置照记录**：`schema.switched` 记下补值的位置，`apply` 照记录登记，重放不按当时的状态现算——事件类表、无时间表上是每个字段补了值的行 ID 列表（不透明标识，是元数据）；状态类表上是实体 ID 与区间，区间由别的贡献求得（哪段业务时间上实体存在、该字段没有值），是内容，记下它出自哪些贡献（与「删除 · 由别的贡献求得的内容」同一种做法）。**之后的删除不改补值的位置**：删除让某处字段变空时不追补常量（删除本来就可能让必填字段变空，见「删除 · 重放规则」）；状态类表上补值区间所出自的贡献被删时，记下的区间随之清除，那一段补值不再存在。不选"让删除重述切换补值"：那要让删除事件能指向切换事件、按行定位一项补值，参考求值器也要多一类贡献，收益只是被删之后的必填字段仍有一个常量值。表达式只引用本字段（见「schema 文档格式」），所以每一项的转换只看它自己。切换事件的内容里记每张新版表的行数与结果校验和，做法同派生写入：重放时有就核对，不用它来生成；它由用户内容算出，是内容，输入被删除后清除、之后跳过核对。只有抽取的翻译结果（模型的输出，不可重放）才作为内容记进"迁移结果"事件。迁移进行中发生删除时怎么办，见「删除 · 结果怎么落进日志」。

### 什么自动、什么不自动

| 环节 | 谁做 | 说明 |
|---|---|---|
| 识别改动类型、检查兼容性 | saveslot 自动 | 按「schema 文档格式」的字段匹配规则比对，结果确定 |
| 预览：多少行变、哪些派生值变、哪些消费方会坏 | saveslot 自动 | 消费方从数据目录查得：派生规则、登记的 SKILL、保存的查询，以及写死了字段的 API 脚本 |
| 写迁移函数 | 起草 schema 的 Agent（模型） | 如"好/一般/差"对应哪个枚举值；saveslot 编译、校验、试跑 |
| 执行：元数据变更、确定性转换、缓存重建 | saveslot 自动 | 结果可重放 |
| 重新抽取 | 调用方 Agent（第一版）；用户授权模型调用后也可由调用模型的后台执行方（worker）做 | 结果是提议，与已确认值不同时进待确认 |
| 批准 | 按风险分级 | slot 策略列出哪几类改动自动生效（默认八类：不改动已有的值、不让旧写入失败、不让现有读取读到不同的东西的那些，见上表）；其余须确认 |
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
     **经 `restructure_unused` 生效的改动**（从未被写入的表改结构，含改时间类型、`entity_key`、`granularity` 这类没有对应字段的表一级改动）视为这张表的全部字段都发生了不兼容变化：带旧 `sv` 写这张表的写入一律被拒。
   - **不读 schema 的消费方**（写死字段的 API 脚本）无法自动跟进，只能在预览里列出、由用户决定。

### schema 文档格式

**读写同一形状的 JSON 文档；提交"表内整份、slot 内只交改动"；名字由 Agent 写，ID 由 saveslot 分配并回填；删除必须显式。**

- **提交粒度**：草稿只列要新建或改动的表，每张列出的表给完整定义；没列的表不变；删字段写进表的 `drop_fields`，删表写进 `drop_tables`。
  不设字段级增量操作语言——Agent 读到的就是整份定义，改完交回最自然。
- **名字与 ID**：Agent 用名字引用表与字段；saveslot 分配表、字段、规则的 ID，编译结果里回填。表 ID 在用户内唯一、字段 ID 在表内唯一，
  用短 ID（`t1`、`f2`），删掉的不复用；物理名是 `t_<表 ID>_v<n>`、`f_<字段 ID>`（永不对外）。
  **表名在 slot 内唯一**（不分 ASCII 大小写，字段名在表内同理，见「字段类型与取值范围」的名字一条）；接口接受限定名 `health.runs`，在本次调用的可见范围内不重名时可只写表名。
- **并发**：草稿带 `base_version`（起草时读到的 schema 版本，建 slot 时为 `null`），与当前版本对不上即拒绝，要求基于新版重新起草。

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
| slot | `slot`、`base_version`、`timezone`、`rename_to`（可选） | Agent | `timezone` 决定 `date` 的自然日语义，是一个 IANA 时区名：`UTC`，或"区域/地点"的写法（至少一个 `/`，如 `Asia/Shanghai`、`Etc/GMT+8`）；别名也可以用，照原样记；偏移量（`+08:00`）与没有 `/` 的短名（`CST`）不收；`rename_to` 给 slot 改名 |
| 表 | `name`、`id`、`kind`（`base` / `derived`）、`description`（必填）、`aliases`（可选）、`time` | Agent，`id` 由 saveslot 回填 | `time.type`：`none` / `event` / `state`；`aliases` 见下方「别名」 |
| 事件类表 | `time: {type: "event", field: "<字段>"}` | Agent | 指定发生时间字段（`date` 或 `zoned_datetime`），这个字段须必填：每一行都有发生时间 |
| 状态类表 | `time: {type: "state", granularity: "date" \| "instant"}`、`entity_key`（可选，字段名数组，如 `["category"]`） | Agent | 生效区间由 saveslot 管理，不作为字段出现；`entity_key` 是可选的自然键，列出的字段须必填；键字段不随业务时间变化，键唯一是全时间唯一（见「时间 · 按 `entity_key` 写入」） |
| 来源键 | 表上的 `external_key`（可选，字段名数组，1–4 个字段，如 `["origin", "external_id"]`） | Agent | 记录在来源系统里的标识，按它写入时有则更新、无则新增（见「按来源键写入」）。只能用在事件类表与无时间表上（否则 `validation_failed`，`external_key_table_kind`）；键字段的类型只能是 `text`、`enum`、`integer`（否则 `external_key_field_type`：别的类型同值要经换算、舍入或时区，不适合当标识）；键字段可选可必填，可选时表里可以有没有来源键的行；唯一范围是表，比较按同值判据。只声明了一个键字段时编译回执给提醒 `single_field_external_key`（多个来源系统写这张表时 ID 可能相撞，键里宜带一个区分来源的字段） |
| 字段组 | 表上的 `together`（可选，字段名数组的数组，如 `[["start", "end"]]`） | Agent | 同组字段是一个冲突单元（见下方「字段组」）；不能含来源键的键字段 |
| 字段 | `name`、`id`、`type`、`description`（必填）、`aliases`（可选）、`required`、`min` / `max`、`values`（枚举）、`unit`、`scale` / `rounding`（`quantity`、`decimal` 的精度，可选）、`ref: {table, target: "row" \| "entity"}` | Agent，`id` 由 saveslot 回填 | 类型的取值范围、单位词表、精度的默认值见「字段类型、同值与单位」 |
| 疑似重复 | `duplicate_keys`（字段名数组的数组，每组是一套判据） | Agent | 只能用在事件类表与无时间表上。软判据：命中生成待处理事项，不拒绝写入（见「写入请求 · 疑似重复」）；首版不做硬唯一约束 |
| 派生表 | `rule.sql`、`rule.time_dependency`（`none` / `bucketed` / `now`）；每个字段一句 `description`，可选 `type`（只收 `decimal`）、`unit`、`scale` / `rounding` | Agent | SQL 用名字写，saveslot 存为按 ID 绑定的形式（改名不坏规则）；字段类型、单位、精度、依赖、重算范围由 saveslot 推断回填；派生字段的类型是 `text`、`enum`、`ref`、`integer`、`decimal`、`quantity`、`boolean`、`date` 之一，不能是 `zoned_datetime`（聚合出的时刻没有时区部分，取日用 `saveslot_date`）。规则的输出列按名字（不分 ASCII 大小写）一一对到派生字段，表达式须写 `AS <字段名>`。字段上写的 `type` / `unit` / `scale` / `rounding` 只在推不出时补上；推得出时写了就须与推断一致：与推断的单位矛盾（含把带单位的结果写成 `decimal`）报 `unit_inference_failed`，其余报 `rule_sql_rejected` |
| 迁移 | 字段上的 `migrate`（受限 SQL 表达式，确定性转换）、`backfill`（收紧约束时补违反的行）；表上的 `drop_fields`；slot 上的 `drop_tables`。`reextract: {from, instructions}`（重新抽取：从哪些旧字段与源数据原文抽、怎么抽；`from` 为空即新字段补抽）**第一版不支持** | Agent | 只在 saveslot 推不出时写；同量纲改单位由 saveslot 自动换算，不需要迁移函数；重新抽取走抽取作业（见下文「抽取作业」） |
| 官方 schema | `extends`、`compatibility` | — | 第一版不收，草稿里出现报 `not_in_this_version`；编译后的定义里留位见「官方 schema 与用户 schema」（`compatibility` 不留键），细则见 open-questions「官方 schema 的细则」 |

- **类型（首版）**：`text`、`integer`、`decimal`、`boolean`、`enum`、`date`、`zoned_datetime`（时刻 + IANA 时区，"哪一天"可复算）、
  `quantity`（数值 + 单位，存为声明单位下的十进制数）、`ref`（指向同一 slot 的一张表，可以是它自己所在的表；第一版不跨 slot）。各类型的取值范围见「字段类型、同值与单位」。
- **名字**：slot 名、表名、字段名只用字母、数字与下划线，字母开头，至多 63 个字符；不得以 `_` 开头，字段名不得是 `valid`、`valid_from`、`valid_to`、`row_id`、`entity_id`。违反时编译报 `validation_failed`（`reserved_name`）。各自作用域内不分 ASCII 大小写唯一（`duplicate_name`）。说明文字与别名不受这个限制。
- **别名**（`aliases`，表与字段上可选，基础表、派生表、基础字段、派生字段都可以带）：用户与 Agent 对这张表、这个字段的其他叫法（口语叫法、旧称、另一种语言的叫法），帮读目录的 Agent 把用户的说法对到名字上。不设 slot 级的别名。
  - 上限：每个对象至多 8 个，每个至多 64 个字符（见「字段类型、同值与单位」）。
  - 内容（编译时检查，结果确定）：落账前做 NFC 规范化；规范化后不得为空，不得含换行（含行分隔符 U+2028、段分隔符 U+2029）与控制字符，首尾不得是空白；同一对象的别名之间不得重复；**不得等于同一作用域里任何仍可解析的名字**——表的别名不得等于本 slot 任一张表的当前名字或仍可按旧名解析的表名（最近 10 个 schema 版本内），字段的别名对照本表各字段（含它自己）的当前名字与仍可解析的旧名。本次草稿要删掉的表名与字段名在这一份草稿里仍算占用：删与起别名分两份草稿做，免得同一份里一个名字换了所指。比较按 NFC 之后逐码点进行，只有 ASCII 字母不分大小写（名字本身不分 ASCII 大小写唯一，SQL 里也不分大小写解析）。否则 Agent 照别名写了那个词，请求按旧名解析到另一张表或另一个字段上，与别名的提示相反。别的对象的别名与它相同是允许的：用户的说法本来就可能有歧义，由说明去区分。违反任一条报 `validation_failed`（`alias_invalid`），`path` 指到那一项，`reason` 指出是哪一条（04-contract-types 第 9 节）。
  - **按不可信文本处理**，规则与说明相同：契约里是不可信文本，渲染进不可信边界；出现边界标记时报 `validation_failed`（`untrusted_marker`）；不出现在工具描述、参数说明与服务器的 `instructions` 里。别名是 schema 作者写的文字，与名称、说明一样不在隐私删除的级联范围内，不要把用户的隐私原话写成别名。
  - **不参与名字解析**：请求里的表名、字段名，受限 SQL 里的标识符，都只认名字（含改名后仍可解析的旧名），写别名的请求照旧报 `unknown_table` / `unknown_field`。名字是标识符、在作用域内唯一，别名是自由文字、允许重复；别名若可解析，改一个别名就可能让同一个请求落到另一个字段上，"只改说明"一类就不再能自动生效。报错时用它来提示：`nearest` 里，别名与请求里那个名字按「相近的键」的折叠 N 相同的对象，其**名字**排在最前；只在本次调用可见的范围内找，返回的是名字，不是别名文字。
  - 改别名的改动码是 `change_aliases`，归入自动生效类别 `description`（见「改动分类与迁移手段」）：只改目录，不建新物理表。
- **单位取自固定的单位词表**（见「字段类型、同值与单位 · 单位词表」）：同量纲的单位自动换算；词表外的单位编译时拒绝。
- **货币也用 `quantity`，但每种货币自成一个量纲、互不换算**（汇率不是固定系数）：写入单位与字段声明的货币不同报 `validation_failed`。
  要换算就把汇率作为基础数据接入、在派生规则里算（见「派生规则」）。
- **表间关系**：基础表之间用 `ref` 声明；派生关系由 saveslot 解析规则得出。
- **字段组**（`together`）：并发写入按字段合并，单个字段上的约束不会被合并破坏，会被破坏的只是跨字段的关系。例：出差 `start 11-01, end 11-05`，一方把 `end` 改成 11-03，一方把 `start` 改成 11-04，各自都不冲突，合并出 `start` 晚于 `end` 的行。只有 schema 的作者知道哪些字段有关系，所以由 schema 声明：同组字段作为一个冲突单元，改到组里任何一个字段，就与改到组里任何字段的写入相交。不声明时每个字段自成一个单元。字段组只影响冲突判定与事项的目标，不影响挡点、来源、同值判断（见「冲突处理 · 冲突判据」）。字段组在编译后的定义里、随 `sv` 走；删除重放按写入记下的 `sv`。**来源键的键字段不能进字段组**（`validation_failed`，`external_key_in_together`）：键字段从不参与同步基线，放进字段组会让它与同组字段的冲突判定纠缠在一起。
- **派生字段的单位**由 saveslot 推断（`sum` / `avg` / `min` / `max`、乘除常数）；推不出（两个带单位的量相乘、相除）就报 `unit_inference_failed`，要求把该字段声明为 `decimal`，或写明 `unit`。
- **兼容性与迁移类别由 saveslot 判定**（只改元数据 / 确定性转换 / 重新抽取），在编译回执的 `changes` 里逐项列出。
- **`migrate`、`backfill` 的表达式只能引用本字段自己的旧值与常量**（表达式里唯一能出现的列名是这个字段在 `base_version` 里的名字）。第一版不收这两种表达式，草稿里出现报 `not_in_this_version`（见 [07-scope-v1](../07-scope-v1.md)）；引用别的字段同样报 `not_in_this_version`。原因：迁移是把旧版的每条写入逐条转换成新版形状（见下文「确定性转换怎么重放」），一条写入只记它涉及的字段；转换只依赖本字段时，每条写入对这个字段的那一项恰好变成新版的一项，状态、区间、来源原样带过去。依赖别的字段时，一条只写了别的字段的写入也会改变转换结果，它在新版里算不算一项贡献、区间怎么定，需要另一套规则，后续再做。要按几个字段合成一个新字段，第一版的做法是加一个派生表，或由 Agent 读出来重新写入。
- **草稿里的 `migrate` 表达式与 `reextract.from` 一律按 `base_version` 的名字解析**（同一草稿里既改名又改类型时不会歧义；`from` 可以引用本草稿要删的旧字段）。
- **收紧约束**（可选改必填、收紧 `min` / `max`、删枚举值）：字段上给 `backfill`（受限 SQL 表达式或常量，二者只能给一种；第一版只收常量形式，表达式形式报 `not_in_this_version`，见 [07-scope-v1](../07-scope-v1.md)）处理违反的现有行（只补存在的行：未撤销的行、实体存在的区间，见上「确定性转换怎么重放」）；没给且有行违反就编译失败，报出违反行数与样例（`backfill_required`；样例只给位置——行 ID 或实体 ID——不给值；状态类表按实体计，一个实体有几段违反也只算一个）。可选改必填与新增必填字段一律必须给常量形式，不看有没有行。
  - `min` / `max` 按字段的单位与精度解释。同一份草稿换了单位或精度时，新旧约束按新的单位与精度比较：旧界先换算到新单位、按新精度与舍入方式舍入，再与新界比；所以 `5 m` 改成 `5 km` 对 `min` 是收紧，`10 kg` 改成 `10000 g` 对 `max` 不算改动。
- **改 slot 时区**改变所有 `date` 的自然日语义，归为确定性转换，须确认；具体重建什么见「改动分类」。
- 目录里取回的完整文档（`catalog` 的完整 schema 一档）已填好 `base_version`（= 当前版本），改完可直接提交；**原样交回是 `no_change`**。它由当前版本的编译后定义生成，不是历次草稿的原文（改已有 slot 的草稿只列它改的表）：边界写成十进制字符串，`quantity` / `decimal` 的精度连同默认值一并写出。编译后的定义里没有、只能取原文的只有派生规则的文本（编译后的定义按 ID 绑定它）：取最近一份写到这张派生表的草稿里的原文；之后它引用的表或字段改名，文本不改写，仍是旧名字，规则照样按 ID 求值。改已有 slot 时，草稿里列出的派生表若与这份文档给出的一致——规则文本逐字节相同，名字、说明、别名、各字段的名字与说明、规则与字段上回填的键都相同——视为没有列出，不按名字重新解析规则；有一处不同仍是改派生表，这一版报 `not_in_this_version`。
- **旧名字还认多久**：
  - 写入按请求的 `sv`（显式带的，或按 04-contract §2 兜底取到的）解析名字再映射到字段 ID，任何版本的名字都认——改名后带旧版名字的写入照常接受。那一版还没有的表（之后才新增的）在那一版里没有这个名字：带旧 `sv` 写它报 `unknown_table`，与名字不存在相同。`sv` 是按 slot 的：不带 slot 前缀的表名，在一个 slot 里按现版本的名字有、在另一个 slot 里按请求的 `sv` 那一版的名字有，报 `ambiguous_table`，两边都列为候选。回执与报错里的表名、字段名按请求的 `sv` 那一版给，与回执的 `sv` 一致。
  - 不带 `sv` 的读取：一个名字若是某个字段在**最近 10 个 schema 版本**内用过的旧名、且当前在可见范围内没有别的表或字段叫这个名字，就按旧名解析，并在回执里提示新名。当前名优先。
  - **slot 名不进这套规则**：slot 改名之后旧名不再解析——按旧名写的限定名（`旧名.表名`）报 `unknown_table`，以 slot 名作参数的地方报 `not_found`（`slot`），都与名字不存在相同。旧名之后可以被新建的 slot 用上，认旧名会让同一个名字指向两处。
  - **别名不是名字**，不进这套规则：改名时旧名不会自动变成别名；"当前有没有别的表或字段叫这个名字"也不看别名。想让旧名在 10 个版本之后仍能被人和 Agent 认出来，起草方可以把它写进 `aliases`，它只是提示，不恢复解析。
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
  "changes": [
    { "target": { "slot": true }, "change": "create_slot", "class": "create",
      "compatible_with_old_writes": true, "destructive": false, "auto": true },
    { "target": { "table": "runs" }, "change": "add_table", "class": "create",
      "compatible_with_old_writes": true, "destructive": false, "auto": true },
    { "target": { "table": "weekly_mileage" }, "change": "add_derived_table", "class": "create",
      "compatible_with_old_writes": true, "destructive": false, "auto": true }
  ]
}
```

回执的完整形状以 contract 的类型定义为准；这里只示意回填了什么。`outcome` 是 `applied`（已生效）或 `pending`（生成了 `schema_change` 事项，等确认）。

**例：v2 草稿**（在读到的 schema 上改，只列 runs）。这是完整设计的例子：其中 `avg_hr` 的 `reextract` 第一版不支持，带着它提交会整份报 `not_in_this_version`；第一版里去掉那个键，`avg_hr` 就是一个普通的新增可选字段。`f4` 的 `migrate`（文本改枚举）第一版同样报 `not_in_this_version`（见 [07-scope-v1](../07-scope-v1.md)）。

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
