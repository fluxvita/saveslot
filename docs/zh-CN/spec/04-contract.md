# saveslot · 操作契约（contract）

> 契约在核心里的位置见 [`02-architecture.md`](02-architecture.md) §6；数据机制与内核规则见 [`03-data-model/`](03-data-model/README.md)；MCP 与 HTTP 两个外化面见 [`05-surfaces.md`](05-surfaces.md)，CLI 见 [`06-cli.md`](06-cli.md)。
> **本文写规则与说明；参数、结果、错误的结构与全部枚举在 [`04-contract-types.md`](04-contract-types.md)，字段名与取值以它为准。**
> 两份文档写的都是完整设计。第一版不实现的部分在类型文件里标 `@later`，清单见它的 0.2 节；范围以 [`07-scope-v1.md`](07-scope-v1.md) 为准。待定项统一记在 [`08-open-questions.md`](08-open-questions.md)。

## 本文是什么

**契约是与传输方式无关的操作形状：有哪些操作、各收什么参数、回什么结构化结果、报什么错。** MCP、HTTP、CLI、App、将来的开发者 SDK 都由它生成，地位相同（architecture §2、§11）。

- **分两部分**：第一部分 `contract-core` 是数据的形状，内核依赖它；第二部分 `contract` 是对外的封装（幂等、分页、句柄、凭证、外层错误），服务层与外化面依赖它。
- **不写内核规则**：冲突、高影响、取代、删除结果这些规则的权威定义在 data-model，本文只引用，并写明它们在接口上表现成什么。
- **不写外化面的事**：文本怎么渲染、标记的措辞、MCP 工具名与注解、HTTP 路径与状态码，都在 05-surfaces.md；CLI 的命令与交互在 06-cli.md。
- 报错、标记、提醒在契约里只有结构化字段（码与附带的字段）；人读的说明由外化面按这些字段渲染。

## 操作一览

| 操作 | 读 / 写 | 所需 scope | 做什么 | 第一版 |
|---|---|---|---|---|
| `catalog` | 读 | `saveslot.read` | 数据目录：slot、表、字段、关系、概况、规则；完整 schema 文档 | 做（概况简化） |
| `query` | 读 | `saveslot.read` | 简单查询，可按业务时间 | 做 |
| `sql` | 读 | `saveslot.read` | 只读受限 SQL | 做 |
| `history` | 读 | `saveslot.read` | 一行 / 实体的时间线、某个记录时刻的样子、一段时间内的变化、派生值的构成 | 做（无 `composition`） |
| `sources` | 读 | `saveslot.read` | 列出、搜索、读取源数据 | 做（搜索是子串匹配） |
| `deletion_preview` | 读 | `saveslot.read` | 删除的影响预览，返回删除确认句柄 | 做（只有按源数据的隐私删除） |
| `pending` | 读 | `saveslot.read` | 待处理事项：列出、看详情 | 做（无作业） |
| `write` | 写 | `saveslot.write` | 写基础表：新增 / 变更 / 纠错 / 撤销，含回退 | 做（无作业） |
| `resolve` | 写 | 按事项类型 × 处理方式（第 6 节） | 处理一个待处理事项 | 做（无 `migration_diff`） |
| `schema_draft` | 写 | `saveslot.schema` | 提交 schema 草稿，返回编译结果与影响预览 | 做（无重新抽取） |
| `delete` | 写（不可逆） | `saveslot.delete` | 执行一次已预览的删除 | 做 |
| `extract_claim` / `extract_submit` | 写 | `saveslot.read` + `saveslot.write` | 领取、提交抽取工作项 | 后续 |
| 管理类（第 17 节） | 读 / 写 | 用户会话¹ | 连接实例、移除空 slot、slot 策略、读取审计、日志校验、对拍、导出、导入到空租户 | 做（`policy.set` 后续） |

¹ `policy.get` 例外：任何有 `saveslot.read` 的凭证都可以调用。

---

# 第一部分 · contract-core（数据的形状）

## 1. 引用、序号与值的编码

类型见 types 第 1 节。

- **表**：限定名 `ledger.expenses`，或在可见范围内不重名时只写 `expenses`；有歧义时报 `invalid_argument`（`ambiguous_table`）并附候选。**slot** 参数接受名字或 `slot_id`。
- **名字只在可见范围内解析**（可见范围见第 12 节）：不重名的判断、`ambiguous_table` 的候选、旧名解析都只看这个凭证可见的 slot 与表。范围外的名字不会出现在任何结果、报错、候选与提示里。
- **名字按版本解析**：写入按请求带的 `sv` 解析名字（改名后带旧名的写入照常接受）；读取接受最近几个版本内的旧名，`warnings` 给 `renamed`（data-model「schema 文档格式」）。表与字段的别名（`aliases`）不是名字，不参与解析，见第 10 节 `catalog`。
- **行**：事件类表、无时间表用 `row`；状态类表用 `entity` 或 `entity_key`（schema 声明的自然键）；派生表用 `key`（分组键，只读；saveslot 内部换成不透明的 `partition_id`）。除 `table` 外恰好给一个。事件类表、无时间表声明了来源键时，写入还可以用 `external_key` 定位（5.1）；读操作的参数不收 `external_key`，给了报 `invalid_argument`。结果里服务端总是给出 ID，有自然键 / 分组键 / 来源键时一并给出。
- **值与元字段分层**：读结果里字段的值放在每行的 `values` 下，行标识、`ver`、区间、标记在行对象上。用户字段名因此不会和元字段撞名。
- **名字不分 ASCII 大小写唯一**：slot 名、表名、字段名在各自的作用域内按 ASCII 大小写不敏感判断唯一（`Expenses` 与 `expenses` 不能并存）；请求与受限 SQL 里的名字解析同样不分大小写。
- **名字与保留名**：slot 名、表名、字段名只用字母、数字与下划线，字母开头，至多 63 个字符（所以**不得以 `_` 开头**）；字段名**不得是 `valid`、`valid_from`、`valid_to`、`row_id`、`entity_id`**。写法不合规与用了保留名都报 `validation_failed`（`reserved_name`），见 data-model「字段类型与取值范围」。
  - `row_id`、`entity_id` 是受限 SQL 里每张表都有的系统列（data-model「[受限 SQL](03-data-model/11-restricted-sql.md)」）。
  - `valid`、`valid_from`、`valid_to` 这三个名字在 `evidence_by_field`（`valid`）与 `query` 的 `where`（`valid_from` / `valid_to`）里和字段名共用一个命名空间。
  - `_` 前缀留给将来的元字段：以后在这类共用命名空间里新增名字，一律以 `_` 开头，不需要迁移已有的 schema。
- **操作号**：一次 `write`、`resolve`、`delete`、撤回各有一个操作号（它的头事件的 `seq`；`write` 的也叫写入号）。**对外出现的序号全部是操作号**：回执的 `seq`、`ver` 里的序号、`timeline` 的条目、`undo` 的目标、`as_of` / `since` / `until` 的取值。一次操作内部各条事件的序号不对外（data-model「编号」）。
- **值的编码**（types 1.4）：
  - `decimal`、`integer` 写入时接受十进制字符串（推荐）或 JSON 数字，服务端按原始文本解析，不经双精度；返回一律是字符串。`integer` 是 64 位有符号整数，超出 JSON 数字安全范围（2^53 − 1）的值必须写成字符串。
  - **JSON 数字的精度看通道**：HTTP 通道由 saveslot 自己解析请求体，JSON 数字按原始文本解析。经 MCP 等由宿主或 SDK 解析参数的通道，saveslot 拿到的已是双精度数，取它最短的往返十进制写法：安全整数（绝对值不超过 2^53 − 1 的整数）无论几位都照收，它本来就是精确的；其余的有效数字不超过 15 位照收（15 位以内的十进制原文解析成双精度再写回，仍是原文），超过 15 位报 `validation_failed`（`malformed`），提示写成字符串；`integer` 字段收到的数字另须是安全整数，否则同样报 `malformed`。宿主已经把原文解析走了样的（如 `1.0000000000000001` 被解析成 `1`），saveslot 无从发现：要更多位数请写成字符串。
  - **调用方交来的十进制原文**（`decimal`、`integer` 的值，`quantity` 的 `value`）：字符串与 JSON 数字用同一套语法，即 JSON 数字的语法 `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`，可带指数。不接受前导零（`01`）、正号（`+1`）、`.5`、`1.`、`NaN`、`Infinity`，报 `validation_failed`（`malformed`）。原文至多 100 个字符，超过的同样报 `malformed`，在解析之前判。原始值因此只有一种文法。
  - `integer` 字段收到带小数部分的值（`"1.5"` 或 `1.5`）：不论写成字符串还是数字，都报 `validation_failed`（`type_mismatch`）。
  - `quantity`、`decimal` 的小数位数超过字段的 `scale` 时，按字段的 `rounding` 舍入后落账，`warnings` 给 `rounded`（data-model「精度与舍入」）。例外：换算过单位的 `quantity` 只给 `unit_converted`（`to` 是换算并舍入后的值），不另给 `rounded`——换算后的精确值未必是有限小数，`rounded` 的 `from` 写不出来。
  - **清空**：值写 `null` 是清空一个可选字段，它是一次有来源的贡献；必填字段不能清空，报 `validation_failed`（`required_missing`）。事件类表、无时间表上清空不能单独撑起一行（data-model「删除 · 重放规则」的「行 / 实体的存在」）：没有必填字段的表上，`insert` 没有给任何字段非空的值，报 `validation_failed`（`empty_row`，明细带 `op` 与 `table`），什么都不落账。只看这个 op 自己给的值，同一请求里后面的 op 补不上它。`update` / `correct` 把一行剩下的值都清空不拒绝：行靠早先非空的贡献仍然存在，各字段为空。状态类表上清空本身就算有值（data-model「时间 · 无值区间」），不适用这一条。
  - `quantity` 必须带 `unit`，缺了报 `validation_failed`（`unit_missing`）；单位取自固定的单位词表，不在词表里报 `unit_unknown`，量纲与字段不同（含货币不同）报 `unit_dimension`；同量纲的单位自动换算到字段声明的单位，`warnings` 给 `unit_converted`。
  - 值的 JSON 类型与字段声明的类型不符（如给 `integer` 字段一个对象或布尔）：`validation_failed`（`type_mismatch`）。`enum` 字段的值不在声明的取值里：`validation_failed`（`enum_value`，附 `allowed_values`）。
  - `zoned_datetime` 缺时区时按 slot 时区，`warnings` 给 `timezone_assumed`。时区写成 `[UTC]` 或 `[区域/地点]`，且须是运行时认得的名字，与 slot 时区同一条规则（data-model「schema 文档格式」）；`PRC`、`EST`、`+08:00` 这类写法、与时区不符的偏移，报 `validation_failed`（`type_mismatch`）。时区名与运行时的规范名只差大小写时，规范化后的值用规范名的写法，原始值照调用方写的记（data-model「同值判据」）。
  - **日期与时刻的范围**：时刻换算到 UTC 之后、按日的表取它在 slot 时区的那一天之后，都须落在 0001-01-01 至 9999-12-31。字段值越界报 `validation_failed`（`out_of_range`），区间参数与 `stated_at` 越界报 `invalid_argument`（`malformed`）。偏移按 RFC 3339：小时 00–23、分钟 00–59，否则是写法不对（字段值 `type_mismatch`，区间参数 `malformed`）。时刻至多到毫秒，更细的位数须全是 0，否则同样是写法不对。
  - `ref` 写被引用行的 `row` / `entity`，或同一请求里新插入行的临时名 `"@p1"`。
  - `text` 须是良构的 Unicode（不含孤立代理项），不得含 NUL（U+0000：PostgreSQL 的 `text` 存不了），否则报 `validation_failed`（`type_mismatch`）；8 KB 的上限对调用方的原文与 NFC 之后的结果都判，超出报 `out_of_range`。返回时是不可信文本（第 8 节）。

## 2. 版本令牌：`ver`、`sv`、`item_ver`

| 令牌 | 是什么 | 规则 |
|---|---|---|
| `ver` | 一行 / 一个实体当前版本的令牌，编码（最近一次改动它当前状态的操作号，租户恢复次数），写成 `v57.0`。恢复次数从 0 起 | 读取时返回、写入时原样带回。业务写入、系统裁定、删除确认、撤回删除改动过它时换新；迁移、派生刷新、同值佐证不改变它。换不换只看这一行 / 实体在版本表里的格有没有变：值变了，或值没变而这一格改由本次操作给出（见 data-model「版本标记 `ver`」与 architecture §8「版本表」）。例如在已经撤销的区间里再撤销一次，那一段改由后一次撤销给出，换新；对同一次写入再撤回一次，写回的值与出处都和现在相同，不换；撤销落在从没写过值的时间段上，没有格变化，也不换。状态类表按实体给，不按段。操作号不是这一行 / 实体的写入时报 `invalid_argument`（`not_this_target`） |
| | 派生行也带 `ver`：最近一次改动它的值的操作号。读时计算的派生行（`marks.computed_at_read`）不带 | 只用于识别版本，不能用于写入 |
| | `history` 的 `as_of` 返回的历史版本写成 `h41.0`，另带 `historical: true`：操作号是 `as_of` 的位置及以前最后一次改动这一行 / 实体的操作号（同 `ver`，不算 schema 切换），恢复次数取读取当时的 | 不能用于写入，不参与兜底 |
| `sv` | slot 的 schema 版本：递增的整数，**不保证连续**——版本号在草稿编译时分配，被拒或被取代的草稿占过的号不再使用。slot 的当前版本是最近一次切换到的那一版，不是号最大的那一版（号最大的可能还在待确认或已被拒） | 每个结果都带它所用的 `sv`；写入应带回。调用方只比较相等与先后，不对它做加减 |
| `item_ver` | 待处理事项的版本令牌（`iv_…`），编码（事项 ID、事项内容最近一次变化的操作号、租户恢复次数） | 事项产生、合并、刷新、条目被清除、被取代、解决时都换新。`resolve` 时带回。各处理方式绑定什么见第 6 节 |

**兜底**（只在本节定义，其余各处引用）：`ver`、`item_ver`、`sv` 没带时，用本连接实例最近一次读到的版本，`warnings` 给出 `ver_fallback` / `item_ver_fallback` / `sv_fallback`（附来源读取；`ver` 兜底取自本连接实例自己的写入回执时，不附读取，改附那次写入的操作号 `from_write`）。无可兜底时报 `read_first`。

- **单位**：连接实例。凭用户会话调用时是这个用户会话（它的所有调用共用一份"最近读到"）；给人用的外化面应显式带回版本、不靠兜底。
- **`task`**：带了 `task` 的调用只认同一 `task` 下的读取；没带 `task` 的调用只认没带 `task` 的读取。读过但 `task` 不同时，`read_first` 的 `reason` 是 `task_mismatch`；`saveslot connect` 用新令牌做的那次自检（`task: "saveslot-connect-selfcheck"`，[`06-cli.md`](06-cli.md) §3 第 7 步）不是 Agent 自己的读取，不算在内，这时是 `no_read`。
- **什么算读到 `ver`**：逐行读——`query`、`history` 的 `timeline` 返回的当前版本（`changes` 不返回 `ver`，不算）；以及本连接实例自己的写入回执里**已生效**的 `ver`。`sql`、聚合类读取、按时刻读到的历史版本不算；回执里 `candidate` 结果附的 `current_ver` 不算。派生行的 `ver` 不能用于写入，读派生表不登记行版本，只算读到 `sv`。
- **什么算读到 `item_ver`**：查看该事项的详情；`resolve` 报 `confirmation_mismatch` 时附带的 `current`，它就是该事项此刻的详情，等同于查看详情；或本次写入 / 删除 / 草稿提交**新生成**了该事项、且回执给出了它的全部内容（data-model「待处理事项 · 事项 ID 与事项版本」）。只列出事项 ID 的地方不算；回执里标了 `merged` 或 `refreshed` 的不算，要先看详情。
- **什么算读到 `sv`**：本连接实例对该 slot 的任何一次读取，含 `catalog`。带回的 `sv` 落后时不一概拒绝，只拒绝写到不兼容变化的字段（`schema_incompatible`）。
- **前提里的 `ver`**（`ops[i].premises[j].ver`，5.1）与写入目标的 `ver` 同一套规则：应带回，没带时兜底，提醒是 `premise_ver_fallback`；无可兜底报 `read_first`。
- **按来源键的 op 不用兜底**：它不带 `ver`，所见版本由内核取同步基线（5.1），不查读取记录，没读过也不报 `read_first`。

恢复备份或导入之后各令牌怎么处理，见第 15 节。

## 3. 证据

类型见 types 第 2 节。

| `kind` | 含义 | 默认来源级别 |
|---|---|---|
| `user_message` | 用户原话 | `user_stated` |
| `agent_note` | 调用方的转述、推断、总结 | `agent_inferred` |
| `tool_result` | 工具或设备的输出 | `agent_inferred` |
| `file_ref` | 外部文件引用：saveslot 不保管文件，只存文件名、类型、大小、内容哈希、可选的来源位置与文本摘录 | `agent_inferred` |
| `source_ref` | 引用同一 slot 里已有的源数据，不复制原文 | 同被引用的那条 |
| （saveslot 生成）`api_call` | 没带证据时的请求本身。`write`：每个在事件里留下了东西的 op 各存一条，只含该 op（贡献、前提的声明、重申、清除都算留下了东西）；无操作字段的值不记；没进事件的按来源键 op（`unchanged`、`skipped`，5.1）不存。`resolve`：带了 `note`、或会触发写入而没带证据时，连同 `note` 存一条。只出现在源数据里，调用方不能传 | `agent_inferred` |

- **“纠错”是标注，不是种类**：一条源数据被某次意图为 `correct` 的写入用作值来源时，读结果里带 `correction: true`（types 4.6）；它由写入意图得出，不改变这条源数据的种类与来源级别。
- **必填**：三种文本段的 `text` 必填且非空；`file_ref` 的 `name`、`mime`、`size`、`sha256` 必填，`origin`、`excerpt` 可选；`source_ref` 的 `id` 必填，引用宽限期内待删除的源数据报 `invalid_argument`（`pending_deletion_source`）；被引用的必须是调用方交来的源数据，`api_call` 类的不能被引用，报 `invalid_argument`（`malformed`）；引用别的 slot 里可见的源数据报 `invalid_argument`（`cross_slot`），不存在或不可见的报 `not_found`（`source`）。
- **大小**（初值，open-questions「接口的数值与细则」）：单段 32 KB，单次请求 256 KB；**按 UTF-8 字节数，只算 `text` 与 `excerpt`**。超出报 `too_large`（`evidence_segment` / `request`）。一次请求至多 1,000 段（请求级与全部内联段合计，`source_ref` 段也算），超出报 `too_large`（`evidence_segments`，附 `limit` 与 `actual`，都是段数），与字节上限同一步检查。大文本只交 `file_ref` 加摘录。`file_ref` 的 `name`、`mime` 各至多 256 个字符、`origin` 至多 2048 个字符（按码点数），不含控制字符。
- **证据文本**（`text`、`excerpt` 与 `file_ref` 的各项文本）须是良构的 Unicode、不含 NUL；不符合的、超长的报 `invalid_argument`（`malformed`，`param` 指到那一项）。
- **声明级别**：段上的 `level` 覆盖按 `kind` 推出的默认值；`external_authority` 第一版不开放，声明它报 `not_in_this_version`。级别只在字面命中时参与冲突裁决（data-model「来源级别」）。
  - 将来开放 `external_authority` 时，能否声明它由连接实例被授予的权限决定：只能由用户会话在签发时授予，写入方不能自报，别的连接实例不能转授；授予记在主体登记事件里。没被授予而声明了它，整个请求被拒，不降级成 `agent_inferred`——降级会让写入方误以为自己的值带着权威级别。
- **陈述时间**：段上可选的 `stated_at`，这句话是什么时候说的；不给就是未知。只记录，第一版不参与任何判定。
- **段放在哪**：请求级 `evidence`（多个 op 共用），或写在 op 里（`ops[i].evidence`，只属于这个 op）。op 引用请求级的段用 `ops[i].evidence_refs`（下标数组）。
- **op 可见的段** = 它的内联段，加上 `evidence_refs` 列出的请求级段；两者都没给时，引用全部请求级段。**空数组与不给相同**：请求级的 `evidence: []`、`ops[i].evidence: []`、`ops[i].evidence_refs: []` 都按没给处理（补全可选参数时填的 `[]` 是"没什么要说的"，不是"一段都不引用"）。
- **按字段指明**：`ops[i].evidence_by_field`，字段名 → 下标数组。下标数的是这个 op 可见的段：**先数内联段，再按 `evidence_refs` 的顺序数请求级段**。键 `valid` 指状态类表区间参数的出处。下标越界报 `invalid_argument`（`index_out_of_range`）；映射到空数组报 `invalid_argument`（`empty_mapping`）；下标不是整数、或在同一数组里重复，报 `invalid_argument`（`malformed`，`evidence_refs` 同）。键是表里没有的字段名报 `unknown_field`（附相近的名字）；是表里有、但这个 op 没给值的字段（不在 `set` 里，也不是 `entity_key` 的键）报 `invalid_argument`（`malformed`）——撤销不给字段值，只能映射 `valid`。`valid` 只用于状态类表，否则报 `invalid_argument`（`not_state_table`）；这个 op 一个区间参数都没给时（整体撤销，或从现在到下一次变化的写入）没有区间可指，报 `invalid_argument`（`malformed`，`param` 指到这个键）。`undo` 不写自己的值，带非空的 `evidence_by_field` 报 `invalid_argument`（`mutually_exclusive`）。空对象等于没给。
- **一个字段引用多段时，这几段同时需要**（含不给映射的默认；规则见 data-model「删除 · 来源」）。带多段又没给字段映射时，`warnings` 给 `multi_segment_unmapped`。
- **值没变的字段只有按字段显式指向证据时才算佐证**；没指的是无操作（第 5 节）。

## 4. 时间参数

| 参数 | 含义 | 在哪些操作可用 |
|---|---|---|
| （不传） | 现在知道的、现在生效的 | 所有读操作 |
| `valid_at` | 业务时间某一刻（状态类表：区间包含它） | `query`、`sql`（`FOR VALID_TIME AS OF`）、`history` 的 `as_of` |
| `valid_during` | 业务时间区间 `[a, b)` | `query`、`sql`（`FOR VALID_TIME FROM … TO …`） |
| `at` | 求值时刻："今天"（依赖"今天"的派生值）与不带时间限定读状态类表都取它；不传取入口时刻 | `query`、`sql` |
| `as_of` | 记录时间：saveslot 当时知道什么 | **只在 `history`** |

- **区间一律左闭右开。** 结果里的区间在按日的表上同时给 `valid_to_inclusive`（区间里的最后一天）；一直延续的区间 `valid_to` 为 `null`。
- **日期与时刻的换算**：按日的表收到时刻，按 slot 时区取所在日，`warnings` 给 `time_truncated`；按时刻的表收到日期，读写都报 `invalid_argument`（`granularity`），`example` 给出那一天在 slot 时区下的起止时刻。
- **状态类表**：
  - 默认读取返回每个实体当前生效的那一段，带它的 `valid_from` / `valid_to`；当前没有值的实体不出现。"当前"取求值时刻 `at`（不传取入口时刻）：按日的表上是它在 slot 时区下的那一天，按时刻的表上就是这一刻。
  - `valid_at`：返回那一刻生效的段。
  - `valid_during`：返回与区间相交的每一段，一段一行。端点默认不截到区间内（`clip: true` 才截）；相邻同值段默认按所选字段合并（`coalesce: false` 才不合并）。`where` 里的 `valid_from` / `valid_to` 只在带 `valid_during` 时可用。次序是：
    1. 对字段的条件先筛实体原始的各段；
    2. 剩下的段里，相接、所选字段的值相同的合并，不论它们自己是否与区间相交——调用方看到的是这个值真实的起止。只看值，不看标记：标记是读取当时的，若由它决定怎么合并，翻页期间出现的标记会把已经给出的行拆开。合并后的行带上各段的标记：事项类的标记带事项区间与这一行相交的各段（`spans`；截取之后与截取后的行相交，不再相交的事项不标），`corrected` 是任一段出自纠错就有；
    3. 留下与区间相交的；
    4. `valid_from` / `valid_to` 的条件作用在合并之后的段上；
    5. 最后才 `clip`。
  - `clip`、`coalesce` 只用于带 `valid_during` 读状态类表：用在别的表上报 `invalid_argument`（`not_state_table`），用在状态类表上却没给 `valid_during` 报 `invalid_argument`（`malformed`）。不悄悄忽略。
  - `valid_at` 与 `valid_during` 同时给：`invalid_argument`（`mutually_exclusive`）。
- **事件类表**没有生效区间：传 `valid_at` 报 `invalid_argument`（`event_table_valid_at`），`example` 给出改写成 `valid_during` 或 `where` 的写法。`valid_during` 按发生时间字段筛选；字段是 `zoned_datetime` 而区间给的是日期时，按 slot 时区的自然日。
- **无时间表**传 `valid_at` / `valid_during`：`invalid_argument`（`no_time_table`）。
- **派生表**没有业务时间：传 `valid_at` / `valid_during` 报 `invalid_argument`（`derived_table`）；按周、按月分桶的派生表用 `where` 筛分组键。
- **`as_of: S`** = 操作号不大于 S 的全部操作都已完整生效时的状态；给时刻时换成不晚于它的最后一个操作号，未来的时刻等于最新。`as_of` 不带 `valid_at` 读状态类实体，返回当时所知的全部段。`changes` 的 `since` 不含、`until` 含。
- `sql` 里出现 `FOR SYSTEM_TIME` 报 `sql_rejected`（`system_time`），附 `use: "history"`。不带时间限定读状态类表 = 包含求值时刻（`at`，不传时为入口时刻）的那一段。

## 5. 写入：意图与 op

类型见 types 5.1。一次请求里的 op 属于同一 slot，**按顺序执行，整体一个事务**，共用一个写入号（不产生事件的请求没有写入号，见 5.4）。

### 5.1 op 的写法

| 意图 | 目标 | `ver` | 内容 |
|---|---|---|---|
| `insert` | 不给。只用于没有 `entity_key` 的表；用在有 `entity_key` 的状态类表上报 `invalid_argument`（`insert_with_entity_key`）；`set` 里出现来源键字段报 `invalid_argument`（`insert_with_external_key`），改用按来源键写入 | 不带 | `set`，必填字段要齐 |
| `update` / `correct` | `row`、`entity` 或 `entity_key` | 应带回 | `set` 或 `revert`，二选一；`update` 带 `premises` 时可以都不带（重申、清除） |
| `update` / `correct`，按来源键 | `external_key`，不带 `row` | 不带 | `set` |
| `revoke` | `row`、`entity` 或 `entity_key` | 应带回 | 不带 `set`、不带 `revert` |

- **"应带回"**：不带时用兜底（第 2 节），兜底也没有才报 `read_first`。按来源键的 op 是例外：不带 `ver`、不带 `row`。给没有来源键的行补键的 op（见下）是普通的 `update`，照常带 `row` 与 `ver`。
- **`update` 与 `correct`**：`update` 是情况变了或补充信息；`correct` 是原来的值本来就是错的，会触发纠错影响查询。只有调用方分得清，必须显式标注（data-model「写入请求」）。
- **按 `entity_key` 写入 = 有则写入、无则创建**：意图用 `update`；实体不存在时创建，结果带 `created_entity: true` 与 `existing_keys`（该表已有的实体键，最多 10 个；同一请求里在它之前新建的键也算，排在最前）。键的文本给成能原样写回的写法（带时区的时刻是该时区下带偏移的本地时刻加时区名）。
  - 新键与已有的键写法相近时，另带 `similar_keys`（最多 5 个），每个附相近的原因 `match`：`fold`（折叠大小写、全半角、空白之后相同）、`affix`（一方是另一方的开头或结尾）、`edit`（只差一两个字），已撤销的实体另标 `revoked`。判据是 `keymatch@1`（data-model「相近的键」），比较范围是该表本次调用可见的全部实体，含已撤销的。`existing_keys` 里相近的键排在前面，其余按最近写入。
  - 两项都是写入那一刻按当时的状态算出的提示：写入照常生效，不生成事项，不进事件。写错了键的改法是撤销刚建的实体（不带区间的 `revoke`），再按对的键写入。
- **请求所在的 slot**：表名写限定名 `slot.table` 时就是那个 slot；只写表名时，取可见范围内唯一有这张表的 slot，几个 slot 里都有报 `invalid_argument`（`ambiguous_table`，附候选的限定名），哪里都没有报 `unknown_table`。各 op 落在不同的 slot 报 `invalid_argument`（`cross_slot`，`param` 指到第一个不一致的 `ops/<i>/table`）。
- **与状态无关的参数校验**（判定顺序第 1 步）：带回的 `sv` 大于当前版本，或不是这个 slot 生效过的版本号（待确认、被拒、被取代的草稿占过的号），报 `invalid_argument`（`malformed`，`param` 为 `sv`）；`ver` 写成历史版本（`h41.0`）或别的写法报 `invalid_argument`（`malformed`）；`entity_key` 用在非状态类表上报 `invalid_argument`（`not_state_table`），状态类表没声明自然键报 `malformed`，键字段缺了报 `missing`、多了报 `malformed`（`param` 指到那个键）；写派生表报 `derived_readonly`。
- **其余与状态无关的原因码**（同属判定顺序第 1 步；`param` 都指到出问题的那一项）：
  - 请求里的对象只认自身的键；值为 `undefined` 的键当作没写（经 JSON 传来的请求不会有，嵌入调用时会有）；数组有空位报 `invalid_argument`（`malformed`）。不认识的参数键报 `invalid_argument`（`malformed`）。
  - 一次超过 1,000 个 op：`too_large`（`ops`，附 `limit` 与 `actual`，都是 op 个数；临时值，open-questions「接口的数值与细则」）。
  - `task`、`idempotency_key` 为空、超过 256 个字符（按码点数）、不是良构的 Unicode 或含控制字符：`invalid_argument`（`malformed`）。
  - 状态类表上给 `row`：`invalid_argument`（`state_table`）。
  - 同一个 `set` 里按不分大小写是同一字段的两个键：`invalid_argument`（`malformed`，`param` 指到第二种写法）；`entity_key` 里同样，`param` 指到那个键。
  - `acknowledge`、`evidence_refs` 里的重复项：`invalid_argument`（`malformed`，`param` 指到第二次出现的那一项）。
  - 限定名 `slot.table` 的 slot 不是本请求所在的 slot：`invalid_argument`（`cross_slot`）。
  - 状态类表上 `valid_from` 不早于 `valid_to`：`invalid_argument`（`malformed`，`param` 为 `valid_to`）。两端都给时在这一步；只给 `valid_to`、起点按"现在"（slot 时区下的那一天或那一刻）算时，在判定这个 op 时才知道，排在 `not_found`、`read_first` 之后，同样报 `invalid_argument`（`malformed`，`param` 为 `ops/<i>/valid_to`）。
  - `ref` 写临时名 `"@p1"`：第一版没有 `as`，请求里不会有绑定它的 op，报 `validation_failed`（`ref_not_found`）。
- **`valid_from` / `valid_to` 只用于状态类表**；用在别的表上报 `invalid_argument`（`not_state_table`）。实体的键字段不随业务时间变化：带区间的写入里出现 `entity_key` 的键字段且值与实体的键不同，报 `invalid_argument`（`key_field_changed`）。
- **同一请求里多个 op 作用于同一行 / 实体**：后面的 op 看得到前面 op 的结果。对本请求里新建的行 / 实体，后面的 op 不需要 `ver`；对请求之前已存在的，各 op 带的 `ver` 都表示"请求开始时所见的版本"，冲突判定只比请求之外的写入。各 op 独立判定：一个 op 成了候选，不影响其他 op 生效。同一行 / 实体只得一个新 `ver`。
- **`acknowledge: ["overwrite"]`**：已与用户确认覆盖类的高影响，直接生效。**只在这个 op 显式带了当前 `ver` 时有效**，否则照常进待确认（data-model「写状态」）。哪些外化面开放见 surfaces。

**按来源键写入**（事件类表与无时间表，schema 声明了 `external_key` 时；规则的权威定义在 data-model「按来源键写入」）：

- **写法**：`external_key` 给出全部键字段的值（缺一个报 `invalid_argument`（`missing`））；意图是 `update` 或 `correct`；不带 `ver`（带了报 `invalid_argument`（`mutually_exclusive`））、不带 `row`；不能带 `premises`（`invalid_argument`（`premises_with_external_key`））。用在没声明来源键的表上报 `invalid_argument`（`no_external_key`）。
- **有则更新、无则新增**：内核按键定位。没有这一行就新增；有就做三方比较——这个字段上次按来源键交来的值（基线值）、当前生效值、这次交来的值：与基线值相同的字段是无操作（来源没变，用户在 saveslot 里的改动不会被每次同步盖回去）；不同的，以这个字段的基线位置为所见版本，按普通的冲突判据生效或成为候选。键命中已撤销的行、或键正被一项宽限期内的删除占着时，这个 op 被跳过，不报错。每个 op 的结局在回执的 `outcome` 里（5.4）。
- **同一请求里同一个键出现两次**，整个请求被拒：`invalid_argument`（`duplicate_external_key`，附两个 op 的下标）。
- **临时名 `as`**：新增时绑定到新分配的行，命中已有行时绑定到命中的那一行，同一请求里后面的 op 可以用它写 `ref`。这个 op 被跳过时临时名不绑定：后面用它写 `ref` 的按来源键 op 一并跳过（`skip_reason: "ref_skipped"`），普通 op 报 `validation_failed`（`ref_not_found`）。
- **键字段不可改**：`set` 里出现键字段且与行上的值不同，报 `invalid_argument`（`key_field_changed`）。
- **给没有来源键的行补一次键**：普通的 `update`，带 `row` 与 `ver`（可以同时带 `set` 改别的字段），另带 `external_key`；只有这种写法能同时给 `row` 与 `external_key`。这一行须未撤销、全部键字段都没有值；行已有键时，与已有的键相同是无操作，不同报 `key_field_changed`。键的状态决定结果：
  - 有宽限期内的删除会去掉这个键在任何一行上的贡献（键被冻结）：`invalid_argument`（`external_key_in_use`，附冻结它的全部删除 ID）。
  - 被一行未撤销的行占着：`invalid_argument`（`external_key_in_use`，附占着它的行 ID）。要转，先撤销它。
  - 被一行已撤销、创建时就带着这个键的行占着：键转到这一行。
  - 被一行已撤销、键是补键得来的行占着：`invalid_argument`（`external_key_not_transferable`，附占着它的行 ID）。不连环转移。
  - 没被占用：补上。之后这一行的键不可改。
- **让出了键的被撤销行不能再重新存在**：`undo` 那次撤销、带 `include_later` 的回退连带回掉它、确认一项这样的待确认回退，生效时报 `invalid_argument`（`external_key_transferred`，附现在持有这个键的行 ID）。

**写入的前提**（`ops[i].premises`；规则的权威定义在 data-model「写入的前提」）：

- **是什么**：这次写下的内容是根据 saveslot 里哪些已读到的行定的。之后那些行在所声明的字段（与业务时间）上的值变了，这一行对任何读取方都带 `premise_changed` 标记（第 7 节）；这一行的值不动。前提不是证据：证据指向源数据原文，前提指向 saveslot 里会变的数据。
- **一条前提**：目标（`row`、`entity` 或 `entity_key`，除 `table` 外恰好给一个；`row` 也可以写本请求里新建行的临时名 `"@p1"`——**这一版没有做**：临时名随 `as` 一起，报 `not_in_this_version`）、可选的 `fields`（不给 = 整行）、`ver`（应带回，兜底见第 2 节）；目标在状态类表上时可带 `valid_at` 或 `valid_during`，都不给时，声明前提的这一行自己有业务时间就取它，没有就是"从现在起"。每个 op 最多 16 条，超出报 `too_large`（`premise_entries`）。
- **哪些 op 能带**：`insert`、`update`、`correct`。带 `revert` 的 op、`revoke`、按来源键的 op 不能带，分别报 `invalid_argument`（`premises_with_revert` / `premises_with_revoke` / `premises_with_external_key`）。`resolve` 没有这个参数。
- **重申与清除**：`update` 不带 `set`、带非空的 `premises` 是**重申**——值不变，按所见的 `ver`，这一行现有的值以这些为前提仍然成立。`update` 带 `premises: []` 是**清除**：这一行的前提声明全部去掉，这是去掉前提的唯一写法。两者都不改行的 `ver`，都不能被 `undo`（没有可撤回的改动）。不带 `set` 的 `update` 也没带 `premises`，报 `invalid_argument`（`missing`）。
- **一个带 `premises` 的 op 覆盖什么**：它自己写下的各项，以及这一行在所见版本上就已生效、之后仍生效的其余各项——后者只在这个 op 全部字段都已生效时才覆盖（有字段成了候选或进了待确认时只覆盖自己写下的项）；清除不受这一条限制，照样清掉整行。回执的 `premise_covered` 给出另外覆盖的字段数。
- **校验**（判定顺序第 5 步，与 `ref` 目标的校验同处）：
  - 表不存在或不可见报 `unknown_table`，字段不存在报 `unknown_field`；行 / 实体不存在、已被隐私删除或不可见报 `not_found`（`param` 指到 `ops/<i>/premises/<j>`；被宽限期内的删除整行去掉时附全部相关删除的 ID）。
  - 指向本 op 自己的目标：`invalid_argument`（`premise_self`）。同一个 op 的两条声明解析到同一个目标：`invalid_argument`（`premise_duplicate_target`，`param` 指后出现的那条，附两条的下标）——一个出处项对一个前提目标只有一条有效声明，要几个字段就并进一条的 `fields`，要两段时间就给一段盖住两段的 `valid_during` 或不给范围。指向派生表：`not_in_this_version`（`value`）。指向别的 slot 里可见的表：`invalid_argument`（`cross_slot`）。`ver` 是历史版本：`invalid_argument`（`premise_historical_ver`）；不是这个目标的版本：`invalid_argument`（`not_this_target`）。`valid_at` / `valid_during` 用在非状态类表的目标上：`invalid_argument`（`not_state_table`）；两者同时给：`invalid_argument`（`mutually_exclusive`）。
  - 目标已被 1,000 条有效声明指向：拒绝声明方，`too_large`（`premise_fan_in`，附目标与当前条数）。上限只在声明时检查，落在声明方：被依赖的一方永远不会因为别人的声明而写不进去。
  - **不拒绝的两种**：`ver` 已过期、且所声明的范围上现在的值与所见版本上的值不同（中间变过又改回来的不算）；前提目标已撤销、且所见版本早于那次撤销（所见版本本身就是那次撤销时记 `current`、不标）。两者都照常写入，这一行一写下就带标记，回执的 `premises[].state` 是 `changed`，`warnings` 给 `premise_already_changed`。理由：证据（用户刚说的话）要落下，标记对所有读方可见，写入方在同一个回执里就知道。`ver` 已过期但所声明的范围没变过的，照常写入、不标。
  - 重申、清除的目标行已撤销：`revoked`，与普通的 `update` 相同。

### 5.2 状态类表的区间

| 传了什么 | 解析结果 |
|---|---|
| 都不传，意图不是 `correct` | 起点 = 现在；终点 = 下一个已记录的变化（`next_change`） |
| 都不传，意图是 `correct` | 每个字段各自取**包含"现在"、以挡点为界的那一段的整个生效期**。"现在"那一点没有值时报 `invalid_argument`，提示给出区间 |
| 只传 `valid_from` | 终点 = `next_change` |
| `valid_to` 是日期 / 时刻、`"open"` | 照用，对 op 里所有字段相同 |

- **`next_change` 逐字段解析**：每个字段各自取严格晚于起点的第一个挡点为终点；后面没有挡点就一直延续。挡点是这个字段取值变化的地方（含有值与无值的交界），以及显式佐证的端点（data-model「写状态」）。回执的 `resolved` 逐字段给出解析结果；终点不是"一直延续"时附 `next_change`：终点处开始的那一段的值，它没有被改动。
- **无值区间**：写入落在无值区间的部分必须带齐全部必填字段，否则 `validation_failed`（`required_in_gap`，附缺的字段与区间）。显式区间跨过无值区间时照填，属高影响；会被填掉的无值区间只列在 `impact.filled_gaps` 里，不算会被覆盖的段（`impact.overwritten`）。
- **`revoke`** 不带区间时撤销整个实体，带区间时这段时间变成无值。

### 5.3 回退

`revert` 代替 `set`，意图可省略。回掉写入的意图：`undo` 调用方给了意图就用它，没给时取**被撤回的操作在这一行（或实体）上 `seq` 最大的那条 `write.base` 的意图**，不看 `include_later` 连带回掉的写入；`take_previous` 取**回退记录里事件 `seq` 最大的那一项所在 `write.base` 的意图**，回退记录为空时取 `update`。

| 形式 | 含义 |
|---|---|
| `{undo: n, include_later?}` | 撤回写入号 n 对这一行 / 实体的全部改动。字段与区间由内核从那次写入取 |
| `{to: n, fields}`（后续） | 取这一行 / 实体在操作号 n 时这些字段的值；状态类表上必须同时带区间与 `ver` |

- **默认只撤回仍然生效的部分**；已被后来的写入覆盖的部分跳过：它们不出现在逐字段结果里，由 `undo.skipped_superseded` 逐项列出（字段、区间、覆盖它的写入）。
- **`include_later: true`** 连后来的写入一起回掉，一律按高影响进待确认。此时待确认事项的 `proposal` 不带 `set`，带 `revert: {undo, include_later}`（`set` 留给字段值与撤销两种提议，`set: null` 专指提议撤销）；会被回掉的后来写入列在 `impact.reverted` 里，回到的值在确认执行后的回执里给出。读结果的 `awaiting` 标记相应带 `proposed_revert`，不带 `proposed`。
- **`undo` 不做版本冲突判定，`ver` 可以不带**：调用方点名了要撤回的那次写入，默认只撤回它仍然生效的部分，别人在它之后写的值不会被动。它仍要过依赖状态的校验（行已撤销报 `revoked`，`revoked_by` 指当前生效、该先撤回的那条撤销；撤回的正是当前生效的撤销时不报；写回的 `ref` 值同样校验目标，目标已撤销报 `validation_failed`（`ref_not_found`），整次回退不生效）与高影响判定。撤回一次带区间的撤销（恢复那段的值）不算高影响。
- **宽限期内不能撤回受影响的行上的写入**：目标行 / 实体受一项仍待执行的删除影响时，`undo` 报 `invalid_argument`（`pending_deletion_target`，`param` 指到那个 op），附相关的删除与最晚的到期时刻，整次请求不生效；删除到期或被撤回之后照常。行已被整行删除时报的是 `not_found`。按版本的回退是普通写入，不受限。
- **回执里的 `reverted_later` 与待确认事项的 `impact.reverted` 不是一个口径**：前者是回退记录里标了 `later` 的条目，照记录列；后者是确认之前给人看的预告，只列确认之后读的人会看到不一样的后来写入——不论它在不在回退记录里，被撤回的那次 `undo` 自己的确认不算在内。所以同一次撤回，两处列出的写入可以不同，哪一边都可能多出一条。
- 目标是插入或首次创建：`invalid_argument`（`undo_target`），提示用 `revoke`。目标是从没生效过的候选或待确认写入：同一错误，提示用 `resolve`。目标是 schema 切换的操作号（常量 `backfill` 补值的那一条）：同一错误，提示提交新的 schema 草稿。目标在这一行 / 实体上没有可撤回的改动（只做了同值佐证、全是无操作等）：同一错误。目标是撤销、系统裁定、由 `resolve` 触发的写入时可以撤回。
- n 不是这一行 / 实体的写入：`invalid_argument`（`not_this_target`）；目标内容已删除：`invalid_argument`（`content_deleted`）。

### 5.4 判定与回执

**判定顺序**（data-model「写入请求」）：与状态无关的校验（`sv`、类型、单位、参数的格式与互斥）→ 请求键查重；没命中时核对证据里 `source_ref` 引用的源数据（整个请求一次，排在 `sv` / `ver` 的兜底与 `read_first` 之前）→ 同值 → `ver` 与冲突 → 对将要生效的部分做依赖状态的校验（含 `ref` 目标与前提）→ 高影响 → 疑似重复。按来源键的 op 先由内核按键定位，同值与冲突两步换成三方比较的输入（5.1）。

**逐字段结果**（types 的 `FieldResult`）：

| `result` | 什么时候 | 生效了吗 |
|---|---|---|
| `applied` | 值已生效。带回的 `ver` 不是当前版本、但这个字段之后没人动过时另带 `merged: true` | 是 |
| `corroborated` | 与所见版本同值，且用 `evidence_by_field` 显式指了证据：追加了来源，没有新版本 | 值不变 |
| `noop` | 与所见版本同值，没指证据：不是这次写入的改动 | 值不变 |
| `candidate` | `ver` 对不上，且这个冲突单元之后被别的写入改过：记为候选，生成或并入冲突事项 | 否 |
| `awaiting` | 高影响：生成待确认事项 | 否 |

- 这五种结果与事件格式里字段的生效状态同名同义（[`09-event-format.md`](09-event-format.md) 6.3）。`undo` 时被跳过的部分不是一种字段结果，见 5.3。
- **回退与"回到冲突前"的写回项**，结果都是 `applied`，可能不带 `after`，改带两个标记之一（`timeline` 里同样）：
  - `no_value: true`：这一处回到"没有任何贡献"的状态——被回掉的写入之前这里就没有值。它与把可选字段显式写成 `null` 不同：后者是一个有来源的空值。
  - `uncovered: true`：这一段只是"不再算数"，没有给值——被回掉的是在一段撤销留下的空白里填的值，回掉之后空白重新露出；撤销之下的值没有动，那次撤销以后被撤回或被删除时会照常出现。
- **来源是 schema 常量的值**：写回项或删除结果回到的是某次 schema 切换时常量 `backfill` 补出的值时，`timeline` 里这一项的 `sources` 不列源数据，带 `schema_const: {sv}`（哪一版的补值）；删除结果的 `reverted_to` 同样带 `schema_const: {sv}`，不带 `from_seq`。写入回执的逐字段结果不给来源。这种值没有原话可查；常量本身不随删除清除，但状态类表上一段补值所依赖的贡献被删除时，那一段补值不再存在（data-model「删除 · 来源：值来源与操作来源」）。
- **同值按写入方所见的版本判**（带回的 `ver` 指向的版本），不是按当前值。原样带回的字段因此不会被当成改动，也不会造成冲突。
- **冲突单元**是一个字段，或 schema 用 `together` 声明的一组字段。撤销改的是"存在"，与每个冲突单元都相交；结果的键是 `"*"`。状态类表上还要求区间相交，判据见 data-model「冲突处理」。
- **既版本对不上、又是高影响**：先成为候选；`candidate` 结果里附 `impact`（若生效会覆盖什么），`take_candidate` 就是对它的确认。
- **写到已撤销的行**（事件类表、无时间表）：`update` / `correct` 报 `revoked`（附撤销它的写入号）；再次 `revoke` 是无操作。状态类表没有"已撤销"状态，撤销就是无值区间。
- **全部字段都是无操作的请求**：照常存源数据、记写入号，`status: saved`，`ver` 不变。例外：一个请求里全部 op 都是按来源键的 `unchanged` 或 `skipped` 时，这个请求**不追加任何事件**——没有写入号、没有源数据、没有请求键；回执照给，不带 `seq`。调用方显式带的证据此时**也不存**：没有任何东西需要它（"显式带的证据照存"只对产生了事件的请求成立）；回执的 `warnings` 给 `evidence_not_stored`，如实写明这些段没有存下。

**回执的 `status`**：

| `status` | 含义 |
|---|---|
| `saved` | 全部字段已生效（含 `corroborated`、`noop`）；生成了 `flagged` 事项时也是 `saved` |
| `pending` | 有任何字段成了候选或进了待确认 |
| `job`（后续） | 转为后台作业 |

**被拒的写入不是一种状态，是报错**（第 11 节）：整个请求不生效。

- `pending[]`：本次生成、并入或刷新的事项。新生成的带 `item_ver`；`merged`（并入已有事项）与 `refreshed`（改到了一个没读过的未决事项的目标，或事项没被改到、重算出的内容变了）不带，要先看详情。
- `superseded[]`：因本次写入被取代的事项。**只有读过事项当前版本的写入方改到它的目标，事项才被取代**；没读过时事项刷新、保持未决（data-model「待处理事项」）。
- `affected_reads`：触发影响查询时给——`correct`、`revoke`、状态类表上任何让值发生变化的写入。按原因计数，不含本次写入所带 `ver` 出自的那次读取；`covered_since` 是读取记录保留到的时刻，更早的读取不在统计内；`possible` 是其中只能算"可能受影响"的读取数（受限 SQL 读了很多行、只留了表级记录的读取，以及按版本集合匹配的读取）：这类读取说不出到底用没用到被改的那一行，宁可多报，所以单独计数；`not_covered` 列出没有覆盖的读取种类。
- `derived[]`：受影响的派生值，一个派生行上变了的一个字段一条（分组键字段不单列，它们在 `key` 里），最多 20 条，另给 `derived_total`（字段条目的总数）。列的是值的变化：派生行出现或消失时，前后都是 null 的字段没有条目；除分组键以外的字段前后都是 null 的派生行，`derived[]` 里没有它，`derived_total` 也不计它。幂等重放的回执里 `derived[]` 为空，`derived_total` 是这次操作的派生写入条数（每个受影响的分区一条），见第 14 节。读时计算的派生值没有派生写入，不列在 `derived[]` 里，也不计入 `derived_total`；它的值在下一次读取时按当时的数据算出。
- `premise_affected`：这次操作改动的行上，别的行声明过的前提的变化——新带上 `premise_changed` 的依赖行数（`count`）、撤掉标记的依赖行数（`matched`）、按原因计数（按行计，一行同时算进几个原因时各计一次，所以各项之和可以大于 `count`）、列出的标记按条——每个依赖行上被标记的每条声明一条，最多 20 条（`deletion_preview` 与 `delete` 里最多 50 条），`count` 仍是行数。已撤销的依赖行照样计数并列出，与带 `include_revoked` 的读取同口径。没有时不给。`resolve` 触发的写入、`delete` 的结果、撤回删除的 `cancelled` 里同样有它；`deletion_preview` 里是预告。
- 每个 op 的 `premises[]` 与请求的 `premises` 一一对应：实际采用的所见版本（兜底时是兜底到的那个）、`state`（`current` / `changed`，`changed` 时附原因与使前提变了的操作号）。
- `replayed`：幂等重放（第 14 节）。

**按来源键的 op 的结局**（`OpResult.outcome`，只有按来源键的 op 带）：

| `outcome` | 含义 | 回执带什么 |
|---|---|---|
| `created` | 新增了一行 | `target.row`、`ver`、逐字段结果 |
| `updated` | 至少一个非键字段生效（可能另有字段成了候选） | 逐字段结果 |
| `unchanged` | 全部字段无操作 | 只有 `target` 与原 `ver`，不列逐字段结果 |
| `pending` | 没有字段生效，有字段成了候选或进了待确认 | 逐字段结果 |
| `skipped` | 命中已撤销的行、键被宽限期内的删除占着，或用了一个被跳过的 op 的临时名 | `skip_reason`：`revoked`（附 `revoked_by`）/ `pending_deletion`（附 `deletion`）/ `ref_skipped`（附那个 op 的下标 `ref_op`）。这几项写入时从当前状态取 |

- `unchanged` 与 `skipped` 的 op **不进任何事件**，也不为它存源数据；同一请求里的其他 op 照常执行。
- 回执另给 `external_key_summary`：`created`、`updated`、`unchanged`、`pending`、`skipped` 五个计数，只统计按来源键的 op。
- `status` 的规则不变：`skipped` 不影响它，另给提醒 `external_key_skipped`（列出被跳过的 op 下标）。
- 被跳过不报错：普通写入写到已撤销的行报 `revoked`，因为调用方点名了这一行；连接器整批交来，不知道其中哪条被用户撤销过，一条被撤销的记录不应让同批的其余记录失败。要恢复由人来：按行 ID `revert: {undo}` 撤回那次撤销。

**写入准入**：超出准入阈值报 `too_large`（`admission`），附 `estimated_rows` 与 `suggested_batch`，由调用方分批。后续加入作业后，带 `mode: "job"` 的转作业。第一版每次基础改动整条重算受影响的规则，代价随规则所读的表变大、不随请求大小变化，分批也降不下来，所以准入不拒绝、不报这个原因；按受影响分区估算之后启用（open-questions「派生刷新的代价估算与准入阈值」）。

## 6. 待处理事项：类型 × 处理方式 × 是否生效 × scope

执行语义、取代与合并规则、事项 ID 与事项版本的权威定义在 data-model「待处理事项」，本表只给接口上的组合。类型见 types 4.8。

| 类型 | 产生于 | 值生效了吗 | 处理方式（`decision`） | 所需 scope |
|---|---|---|---|---|
| `awaiting_confirmation` | 高影响写入（清单见 data-model「写状态」）；隐私删除让冲突消失、而候选仍属高影响时由冲突事项转来 | 否：读到的是当前值 + 提议 | `confirm` / `reject` | `saveslot.write` |
| `flagged` | 疑似重复（`duplicate_keys`） | 是 | `keep` / `revoke` | `saveslot.write` |
| `conflict` | 带过期 `ver` 的写入改到了之后被别人改过的冲突单元；同一目标的后续候选并入同一事项 | 生效值按规则给出（第一版：保持当前值） | `keep_effective` / `take_candidate`（多个候选时带 `candidate`：候选的下标）/ `take_previous` | `saveslot.write` |
| `schema_change` | `schema_draft`（不能自动生效的变更） | 否 | `confirm` / `reject` | `saveslot.schema` |
| `deletion` | 已确认的删除，处于 24 小时宽限期 | 已逻辑删除 | `cancel` | `saveslot.delete` |
| `migration_diff`（后续） | 结果要进差异清单的迁移 | 否 | `accept_all` / `rows` / `keep_rest_and_switch` / `abandon` | `saveslot.schema` |

- **事项的目标**：行 / 实体，加冲突单元（`unit`），状态类表另加区间（逐段给出，可以是几段不相连的区间）。同一（行 / 实体，冲突单元）上，候选区间与已有事项的区间相交（按任一段）的并入它，同时与几个相交时并入最早的那个；不相交的另成一项。撤销参与的冲突，`unit` 是 `["*"]`。待确认事项不合并，每次高影响写入各成一项。
- **冲突的三种处理**：
  - `keep_effective`：保持当前生效值，所有候选不生效。
  - `take_candidate`：采纳一个候选，只落本事项的冲突单元。候选是撤销时撤销生效；候选是修改而当前已撤销时，行恢复存在并落这次修改。
  - `take_previous`：回到合并基——事项现存各候选所带 `ver` 中最早的那个版本——在这个冲突单元（与区间）上的值。详情的 `previous` 给出这个值，`reverted_by_previous` 列出回到合并基会让读到的结果变的写入（口径见 data-model「写入与读取 · 撤回某次写入」）。
- **各处理方式绑定什么**（data-model「待处理事项 · 事项 ID 与事项版本」）：

  | 事项 · 处理方式 | `resolve` 要带什么 | 核对什么 |
  |---|---|---|
  | 默认 | `item_ver`（或兜底） | 事项内容自读到以后没变 |
  | `deletion` · `cancel` | 不用带 | 不核对，只要仍在宽限期；宽限期已过报 `item_closed`（`expired`） |
  | `migration_diff`（后续）· `abandon` / `keep_rest_and_switch` | `item_ver`（或兜底） | 只核对是哪一个迁移与恢复次数 |
  | `migration_diff`（后续）· `accept_all` | `diff_upto` | 只接受序号 ≤ k 的条目 |
  | `migration_diff`（后续）· `rows` | `item_ver`（或兜底） | 只核对所列的行的差异条目没变 |

- 事项详情只列出**当前凭证可用的**处理方式（`decisions`）；用了不可用的处理方式报 `insufficient_scope`。
- **目标受一项仍待执行的删除影响的事项**（`deletion` 与 `schema_change` 之外）：`decisions` 为空，另带 `blocked`（原因 `pending_deletion`、相关的删除、最晚的到期时刻）；列表里这样的事项带 `blocked: true`。这时调用任何处理方式都报 `invalid_argument`（`pending_deletion_target`）。
- **确认委托给调用方**：saveslot 不区分确认出自人还是 Agent（architecture §3）。slot 策略可以指定"某类处理只接受用户会话的确认"，届时事项详情的 `user_session_only` 列出这些处理方式，连接实例调用它们报 `insufficient_scope`（`required_scope: "user_session"`）；这个开关第一版不实现。
- **读到的行是谁最近改的**：`query` 与 `history` 的 `as_of` 读到的基础表的行带 `changed_by`——它 `ver` 里那次操作的写入者，不是调用方自己时才给。看到别人刚改过要改的那一行，调用方先告诉用户、问过再写；内核不因此拒绝或改判写入（带着刚读到的 `ver` 写，按契约就是看过最新的再写）。

## 7. 数据标记

标记是结构化字段，不是文字（architecture §6）。类型见 types 第 3 节。

| 标记 | 含义 |
|---|---|
| `disputed` | 有未解决的冲突事项；给出的是按规则给出的生效值。带事项、冲突单元里的字段、区间 |
| `awaiting` | 有提议尚未生效；给出的是当前值 |
| `flagged` | 值已生效，只是被标记；算不算数由读方判断 |
| `corrected` | 该行被纠错过。状态类表上按段给：这一段里所读字段的值出自纠错写入（合并的段里任一段是即可） |
| `revoked` | 该行已撤销；只在 `include_revoked: true` 时出现 |
| `possibly_affected` | 本连接实例之前读过的版本后来受影响；值后来恢复则撤掉 |
| `partially_deleted` | 按时刻读、还原时，当时的部分数据已删除 |
| `pending_deletion` | 这一行受一项可撤回的删除影响（判据见 data-model「删除 · 撤回与宽限期」的"受影响"；这段时间里它上面的事项不能处理、写入不能 `undo`） |
| `dangling_ref` | 这一行的某个 `ref` 字段指向的行 / 实体已撤销或已被隐私删除；引用方的值不变，只标出来。带字段与状态（`revoked` / `deleted`） |
| `premise_changed` | 这一行当前的值所用到的前提（5.1）后来变了；值没有动，是否仍然成立由读方判断。**任何读取方**都看得到。带前提所在的行、声明的字段、声明时所见的版本、原因、使它变了的操作号、本行里由这条声明覆盖的字段、哪次写入声明的 |
| `computed_at_read` | 派生行是读时算出的（规则依赖"现在"，或读状态类表而不带业务时间限定）：值随读取时刻而定，这一行不带 `ver` |
| `stale` / `pending_extraction`（后续） | 大写入作业进行中 / 迁移切换时还没抽完 |

- **`disputed`、`awaiting` 与 `premise_changed` 只在读到的值会随之而变时才标**：请求了 `fields` 而其中不含事项涉及的字段（`premise_changed`：不含这条声明覆盖的字段）时，这一行不带这个标记。
- `possibly_affected` 的 `reason`：`correct`（你曾读到的值已被纠正）、`revoke`（所含的一条记录已被撤销）、`retroactive`（你读取的业务时间上的值后来被追溯修改）、`plan_changed`（你读过的未来安排已变更）。
- `premise_changed` 的 `reason`：上面四个同名同义，另有 `update`（前提被变更）、`deleted`（隐私删除改掉了前提的值）与 `schema_switched`（schema 切换删掉了所声明的字段）。一次写入在所声明的范围上同时有追溯与未来的部分时取 `retroactive`。
- `premise_changed` 与 `possibly_affected` 的区别：后者只给读过旧版本的那个连接实例，回答"你当时读到的对不对"，不在日志里；前者是这一行的状态，由显式声明得出、进日志，事件类表与无时间表上的 `update` 也会触发它。一行最多列 10 条，按 `since` 从新到旧（同一 `since` 的几条，后声明的在前），超出时另给总数。打标记、撤标记都不改这一行的 `ver`。
- 前提目标所在的表（或 slot）对读方不可见时，这条标记照样给，带 `hidden: true`：依赖行的值站在一个已经变了的前提上，对任何读得到这一行的人都要紧。它只带这一行自己的东西——本行里被覆盖的字段与 `since`；读方只知道这一行依据的某条记录变了以及从哪次操作起，不知道是哪张表、哪一行、哪些字段，也不知道怎么变的（不给原因）。它照常计入 10 条的截取与总数，`fields` 过滤照常。
- 派生行没有自己的标记，带 `input_marks`：只统计规则所依赖的字段上有标记的基础行（含 `premise_changed` 的计数）。规则不带时间限定读状态类表时，读到的是每个实体含求值时刻的那一段，标记的业务时间范围还要与那一段相交才计，与按那一刻读基础表时打不打这个标记相同。
- `sql` 的结果带同一形状的汇总（`marks_summary`），从这次查询读到的行版本集合算出。

## 8. 不可信文本

**来自用户内容或调用方撰写、可能含指令的文本，在契约里标为类型 `UntrustedText`**（OpenAPI / JSON Schema 上加 `x-untrusted: true`）。字段值保持原样，不带任何标签；不可信边界由外化面的渲染器统一加（MCP 见 surfaces「不可信边界」），渲染器测试检查这些字段都被包住（architecture §6、§11）。

属于 `UntrustedText` 的：`text` 类型的值与取值示例；源数据原文、`file_ref` 的摘录、文件名与来源位置；`sql` 的整个 `rows`；待处理事项里的当前值 / 提议值 / 候选值与 `note`；`existing_keys` 与 `similar_keys` 里的键；报错里回显的用户输入；schema 里由调用方撰写的说明、别名（`aliases`）与规则原文（附写入者与版本）；抽取工作项的 `instructions` 与写入原文。

**入口一侧**：`schema_draft` 收到的文档里，说明或别名含有外化面的边界标记（形如 `<untrusted-data-`、`</untrusted-data-`）时报 `validation_failed`（`untrusted_marker`）——那是调用方把读到的标签原样带了回来。其余写入不做这项检查：源数据原样存。

## 9. 内核补全的字段

| 字段 | 怎么来 | 调用方能否覆盖 |
|---|---|---|
| actor | 凭证 | 否 |
| slot | 由表推出 | 否（一次写入只涉及一个 slot） |
| 源数据 | 每段证据存为一条；没带就把请求本身存为 `api_call`（每个在事件里留下了东西的 op 一条，第 3 节） | — |
| 来源级别 | 按证据段的 `kind`；没带证据一律 `agent_inferred` | 可在段上声明（第 3 节） |
| 字面命中 | 写入时按字段 × 证据段判定并记下（data-model「来源级别」） | 否 |
| 记录时间 | 操作号与 `recorded_at`。记录时刻由内核保证单调：入口时刻早于日志末端的记录时刻时取日志末端，`warnings` 给 `clock_behind_log`（data-model「写日志」里的记录时刻） | 否 |
| `row_id` / `entity_id` | 新增、按来源键新增或按 `entity_key` 首次创建时生成，回执返回 | 否 |
| 按来源键的 op 的所见版本 | 这个字段的同步基线位置（5.1） | 否 |
| 生效起点 / 终点（状态类） | 第 5.2 节 | 可显式传 |
| `ver` / `item_ver` / `sv` | 兜底（第 2 节） | 应当带回 |
| 单位换算 | 同量纲换算到字段声明的单位，精度与舍入按编译后的定义 | — |

## 10. 各操作的规则

参数与结果的结构、每个操作的 JSON 例子见 types 第 4、5 节。

### `catalog`

- 三档：`list`（默认，slot 与表的清单，按表分页）、`table`（某几张表的字段、单位、精度、关系、规则原文、依赖、概况；`tables` 必填，1–10 张）、`schema`（某个 slot 的完整 schema 文档，附 slot 策略；`slot` 必填）。缺了必填的参数报 `invalid_argument`（`missing`）。
- 只列可见范围内的 slot 与表；概况、取值示例、关系只涉及可见的表。`slot` 参数指向不存在或不可见的 slot，报 `not_found`（`slot`）。
- **别名**：表与字段可带 `aliases`（schema 作者写的用户说法、旧称、口语叫法）。`list` 档带表的别名，`table` 档带表与每个字段的别名，`schema` 档是文档原样。别名是不可信文本（第 8 节），**不参与名字解析**：请求与受限 SQL 里只认名字，写了别名的请求照旧报 `unknown_table` / `unknown_field`；报错的 `nearest` 怎样借别名给出对的名字，见第 11 节。改别名的改动码是 `change_aliases`，归入自动生效类别 `description`。
- `table` 档的表定义带 `external_key`（声明了来源键时：键字段的名字）。
- `schema` 档返回的文档 ID 与 `base_version` 已填好，可以直接改了交给 `schema_draft`；原样交回是 `no_change`。文档由当前版本的编译后定义生成，派生规则的文本是提交时的原文（见 data-model「schema 文档格式」）。带 `draft`（草稿 ID）时返回那份草稿编译后的文档（ID 已回填），不论草稿处于什么状态；读取照常记读取记录；草稿不存在或不可见报 `not_found`（`draft`）。`schema_draft` 的回执截掉了文档全文时，就用它重读。文档不能分页；超出外化面的结果预算时报 `too_large`（`result_budget`），不截断。（这是读操作，什么都没落账；已经落账的操作不用这个错误，见 surfaces 第 3 节。）
- 概况：行数、业务时间范围、每个字段最近 K 个不同取值（按操作号取，确定性）。`table` 档每张表都带 `profile`（行数、业务时间范围与规模提示），只数调用方可见范围内的表；读时计算的派生表不带：它没有落表的行可数，现算一遍规则也不是目录该做的事。行数数的是表里现有的行：事件类与无时间表数未撤销的行，状态类表数区间段（相邻且全部字段同值的段先合并，物理上怎么切不改变结果，与 `query` 的 `total` 同口径），派生表数它自己的行。业务时间范围：事件类表的 `from` 与 `to` 是时间字段的最早值与最晚值，两端都含（只算未撤销的行）；状态类表的 `from` 是最早的区间起点，`to` 是最晚的 `valid_to`，不含（与契约里所有 `valid_to` 同一约定），有一直延续的段时不给 `to`；无时间表、派生表与空表不给。读时由当前数据现算，不进事件。slot 有迁移在进行时，`list` 档带 `migration`；这期间涉及这个 slot 的调用在 `notices` 里给 `migration_progress`（目标版本与进度）。
- **规模提示**：`table` 档的概况在行数过界时带 `scale`：超过舒适线（`comfortable_rows`）、不超过实测线（`tested_rows`）是 `large`，超过实测线是 `beyond_tested`；两条线的数值随内核版本发布（architecture「容量边界与实测数值」）。按这张表当前的 `profile.rows` 读时算出，不进事件，不是数据标记；不超过舒适线时不带。`list` 档不带。

### `query`

- **逐行读**：返回的 `ver` 可用于写入，也作兜底。读取自动记入 read_log（data-model「读取记录」）。
- `where` 的运算符对各类型的适用范围见 types 4.3；用在不适用的类型上报 `invalid_argument`（`operator_type`）。`quantity` 的比较值带单位，同量纲换算后比较。
  - **比较值按写入的同一套规则读**（第 1 节「值的编码」），不合格的报 `invalid_argument`（`malformed`，`param` 指到那个值）。`text` 的比较值先做 NFC 再比，`contains` 同样。`decimal`、`integer`、`quantity` 按精确值比较，不按字段的精度舍入（舍入会让比较值越过已存的值）。
  - `zoned_datetime` 按时刻比较。拿日期去比报 `invalid_argument`（`malformed`），`example` 给出时刻的写法；按日比较要用内部日期列，留待它实现。这是有意与同值判据（时刻与时区都相同）不同：排序类运算符只能按时刻比，`=` 若与 `<=` 加 `>=` 不一致会更糟。比较值没带偏移与时区时按 slot 时区读，`warnings` 给 `timezone_assumed`。
  - 报错里回显调用方写的名字（`name`、`param` 里的各段）各截到 200 个字符。
  - `!=` 的结果含该字段为空的行（空与任何值都不相等）；`<`、`<=`、`>`、`>=` 不含空。
- 默认只返回未撤销的行；`include_revoked: true` 时已撤销的行带 `marks.revoked`。状态类表上撤销是无值区间，没有"已撤销的行"，`include_revoked` 不多给任何东西。
- 默认排序：事件类表按发生时间倒序，同一时间按行 ID 升序；状态类表按实体 ID 升序、再按 `valid_from` 升序；无时间表按最近改动倒序，同一次改动按行 ID 升序；派生表按分组键升序。给了 `order` 时先按它，再按这组默认的键。空值在升序、降序里都排在最后；文本按码点比较。`cursor` 以这组键为准：下一页从上一页最后一行的键之后开始。
- `total` 数的是返回的行，即合并（`coalesce`）之后的段；一个实体的几段可以分在两页。
- 状态类表一段一行；`ver` 按实体给，同一实体的各段相同。时间参数见第 4 节。
- 行上可能带 `premise_changed`（第 7 节）。`detail: "detailed"` 时每行另给 `detail.premises`：这一行当前生效的全部前提声明（含没变的），读方据此看"这一行站在什么上"。

### `sql`

- 单条 SELECT；表与字段用名字；白名单（语句、节点、函数、运算符、聚合）、解析与防线见 data-model「[受限 SQL](03-data-model/11-restricted-sql.md)」。
- **可以引用可见范围内多个 slot 的表**：`sql` 只读，不涉及版本归属与原子性；结果的 `sv` 按 slot 分别给出。派生规则与 `ref` 字段不跨 slot，这一条不变。引用了不存在或不可见的表，报 `sql_rejected`（`unknown_name`）；`marks_summary` 只统计可见的行。
- 结果是列定义加行数组；`quantity` 列的单位在列定义里，单元格是十进制字符串。位置参数是标量；带单位的量按该列声明的单位传十进制字符串。
- `max_rows` 是每页行数（默认 100，上限 1,000），`cursor` 翻下一页。
- 结果不带 `ver`、不自动加行 ID，不算逐行读、不能作兜底；带 `marks_summary`。整个 `rows` 是不可信文本。
- 超时报 `sql_timeout`。

### `history`

四种模式，参数按模式区分（JSON Schema 写成 `oneOf`）；模式与参数配错报 `invalid_argument`（`mode_mismatch`），`example` 给该模式完整的示例。

| `mode` | 回答什么 |
|---|---|
| `timeline`（默认） | 一行 / 实体的每次操作：谁、什么时候、什么意图、每个字段的结果与前后值、来源（值来源与操作来源分开）；读过各版本的读取。返回当前 `ver`，算逐行读 |
| `as_of` | 目标在某个记录时刻的样子；`ver` 是历史版本。行上只带当时的 `corrected` 与 `revoked`：事项标记（`disputed`、`awaiting`）与 `premise_changed` 说的是现在的状态（前提声明的状态不按时刻留存），不给 |
| `changes` | 两个记录时刻之间的变化；可以不给目标，返回整张表的变化 |
| `composition`（后续） | 派生行由哪些基础行构成 |

- 四种模式都按 `limit` / `cursor` 分页。
- `timeline` 列出这一行 / 实体上的全部操作，含没有生效的（候选、待确认）与由 `resolve`、删除、撤回触发的；条目的 `via` 说明来由。内容已按删除移除的字段带 `removed: true`。schema 切换时常量 `backfill` 补出的值也是一条：`intent` 是 `schema_switch`，`via` 是 `{schema: {sv}}`，`actor` 是 `system`，没有源数据；它不改行的 `ver`，所以当前 `ver` 里的操作号可以比这一条早。回退写回的字段可能带 `no_value` 或 `uncovered`（含义见 5.4）。声明了前提的写入带 `premises`（目标、字段、所见版本、现在是否已变）；重申与清除也各是一条，清除的 `premises` 是空数组；同一请求里对同一行的几个 op 各是一条，按 op 下标从后往前。已不再作数的声明（被同一目标上更晚的声明取代，或被清除）给 `ended`，不带原因与 `since`。后面的页停在第一页的操作号上，但前提的状态是现在的，`since` 可以大于那个操作号。前提目标所在的表对读方不可见时，那一条只给 `hidden: true`、现在是否已变与 `since`，不给目标、字段、所见版本与原因：这是有意的例外，读方知道这次写入依据的某条记录变了以及从哪次操作起，不知道是什么、怎么变的。
- `as_of` 接受操作号、时刻、`{read}`（任何连接实例的一次读取）或 `{task}`（**限本连接实例**的该任务，默认取它对这个目标的最后一次读取，`other_reads` 列出其余几次；`as_of` 自己的读取读到的是历史版本，不算在内）；后两种按那次读取所见状态的位置还原，那次读取读的是同一张表时另沿用它的业务时间条件，别的表的读取只取位置。早于第一条操作的时刻给 `seq: 0`、不带 `recorded_at`，结果为空。结果标明当时的 `sv`，值按它解释。`{read}` 指向一次不可见范围内的读取时报 `not_found`（`read`）；`{task}` 下没有读过这个目标报 `not_found`（`read`，`param` 为 `as_of/task`）。
  - 事件类表、无时间表上，到那时已撤销的行照样返回，带 `marks.revoked`；那时还不存在的目标结果为空。
  - 目标从未有过任何版本（对它的写入都没有生效，例如唯一的一次写入只成了候选或待确认）时报 `not_found`（`row` / `entity`），与 ID 不存在相同，各种模式都一样；目标有过版本、`as_of` 早于它的第一个版本时结果为空（上一条）。
- 翻页同第 15 节：`timeline` 的后续页只列首页操作号及以前的条目，`ver` 取那一刻的；`reads` 只在首页给，返回并登记当前 `ver` 的也只有首页。`as_of` 的各页按段的起点；记录点（时刻、超出日志的操作号、`{read}`、`{task}`）在首页解析，截到首页的操作号，随位置带到后续页，之后的写入与读取不改变它。`changes` 的各页新的在前、同一操作内按目标 ID；窗口（`since` 与 `until` 解析成的操作号，`"my_last_read"` 也在首页解析）在首页定下，随位置带到后续页：之后的写入不进窗口，首页本身登记的读取也不改变后续页的 `since`。`reads.list` 的后续页只列到首页时最后一条读取记录。
- `timeline` 的一条是一次基础写入：同一请求里几个 op 写同一行时各是一条，`seq` 相同，`total` 数的是条目。字段的 `before` 是这次写入之前、在这一项区间起点上的值（同一请求里前面的 op 已写过的，是它写下的值；这里原来没有值时不给）。没有生效的项（候选、待确认）的来源取自这次写入自己的事件。
- **`changes` 的窗口**：只看操作号在 `(since, until]` 内的操作，`since` 不含、`until` 含，`until` 不给则到最新。点是操作号或时刻，解析同 `as_of`（取不晚于它的最后一个操作号，早于第一条操作的时刻是 0，超过最新的是最新），另允许 `0`（从头看起）。结果的 `since`、`until` 是解析出的操作号。`since` 不早于 `until` 时结果为空，不报错。`since` 必填，缺了报 `invalid_argument`（`missing`）。
- **`changes` 的条目**：一条是一次操作对一行 / 实体的改动，新的在前，同一操作内按目标 ID；同一请求里几个 op 写同一行的算一条，给这次操作前后的净变化（`timeline` 一条是一次基础写入，这里不同）。净变化为零的（先写后改回）没有条目。条目的 `intent` 取这次操作里最后一个 op 的意图（同一请求里意图不同时，不取第一个）。只列值实际变了的字段，没有变的不出现：同值再写、状态类表上写入把一段切成几段而值没变的部分，都没有条目。没有生效的写入（候选、待确认）不是变化，到它生效的那次操作（`resolve` 触发的写入以那次操作的操作号）才算。`before`、`after` 没有值时不给。`intent` 取这次操作写进版本表的意图（含 `deletion`、`deletion_cancelled`、`schema_switch`）；撤回（`undo`）是一次写入，条目给它写回的值，意图是它记下的，不带 `via`，要看来由用 `timeline`。
  - 事件类表、无时间表：每个变了的字段一个对象。状态类表：每个变了的字段是数组，每项是前后的值不同的一段业务时间（相邻、前后值都相同的合并），带 `valid`。
  - `*`（这一行 / 这一段是否存在）：撤销或撤销的撤回改变了它时给，`before`、`after` 是布尔，`true` 表示存在；事件类表、无时间表是对象，状态类表是数组、每项带被撤销或恢复的那一段 `valid`。新增不给 `*`。带区间的撤销让那段时间没有值，该字段也给出这一段取值的消失。
- `changes` 的 `since: "my_last_read"` = 本连接实例（带 `task` 时只认同一任务，没带时只认没带 `task` 的读取；用户会话时是这个会话）上次读过的位置，即那次读取的"所见状态的位置"（data-model「读取记录」）。**按读取覆盖的范围认**：目标是整张表（不给行或实体）的 `changes`，只认覆盖这张表的读取——`query`，以及目标是整张表且把窗口给全了的 `changes`；目标是某一行或实体的 `changes`，认覆盖这张表的读取，加上对这一行或实体的读取（`timeline`、`as_of`、对它的 `changes`），取最近的一次。只读过某一行的，对整张表问 `"my_last_read"` 得到 `read_first`（`no_read`）：它没见过那张表的其余行，不给一个漏了的答案。按记录时刻读的（`as_of`）位置是它的记录点；读派生表、别的表、别的连接实例的读取不算；`sql` 的读取也不算：它读到哪些行取决于查询，读取记录里记的又是超集，不能当作看过这张表。`saveslot connect` 的自检读取不算；没读过、或只在别的 `task` 下读过，都报 `read_first`（`target: "table"`，`param: "since"`；`reason` 分别是 `no_read` 与 `task_mismatch`，后者带 `read_task` 与 `task`，不带 `ver`）。**读完整个窗口才算读过**：`changes` 把窗口（`since` 到 `until`）给全了才登记位置为 `until`——首页放得下整个窗口时在首页登记；放不下时首页与中间的页都不登记，返回最后一页时登记。记成读过的，必须恰好是回给调用方的。`changes` 不返回 `ver`，不算逐行读，不作 `ver` 的兜底；它登记所读 slot 的 `sv`（首页），不带 `sv` 的写入可由此按 `sv_fallback` 通过。
- **读时计算的派生表**（`marks.computed_at_read`）上，`timeline` 与 `as_of` 报 `not_in_this_version`（`param` 为 `table`）：它的行不是哪次操作写下的，也没有按时刻的状态。
- **`changes` 不以派生表为目标**，`table` 是派生表时报 `invalid_argument`（`derived_table`）。读过派生值（如月度合计）的一方要知道读到的值是否已不成立：对派生规则所汇总的基础表查 `changes`，`since` 取那次读取结果的操作号——不用 `my_last_read`：只读过合计的一方对基础表没有读取记录，会得到 `read_first`；或者直接重读合计。第一版的影响查询不覆盖对派生值的读取，这是读方唯一的办法。

### `sources`

- `list`（默认）、`search`（`q` 必填；第一版是子串匹配）、`get`（`id` 必填）。`from` / `to` 按记录时间，`[from, to)`。`kind` 的取值含 saveslot 生成的 `api_call`；被纠错写入用作值来源的带 `correction: true`。只返回可见 slot 的源数据；`slot` 过滤指向不存在或不可见的 slot 报 `not_found`（`slot`），不可见的源数据 ID 报 `not_found`。
- `get` 返回原文或文件引用、所属 slot、记录时间、写入者，以及它产生了哪些数据。读源数据原文也记入 read_log。
- **宽限期内待删除的**不返回内容，带 `deletion: {state: "pending", item, expires_at}`；**已物理删除的**带 `deletion: {state: "removed", at, reason}`。列表里同样处理。

### `deletion_preview`

**不删任何东西。** 两种调用：给 `{kind, sources}` 出预览；或只给 `{confirm}`，按已有的 `dc_` 绑定的目标重新给出预览（返回的仍是同一个 `dc_`，有效期不变）。

- `sources` 必填、非空，必须属于同一个 slot，否则 `invalid_argument`（`cross_slot`）。一句话涉及两个 slot 时是两条源数据，各自预览、各自删除。
- `sources` 里有不存在、已在宽限期内待删除、已物理删除的 ID：`not_found`，`sources[]` 逐个给出状态。
- 结果要写明哪些内容由 data-model「删除 · 预览与回执要写明的内容」定义。**原本未生效、将因删除生效的写入单列**（`now_effective`）；冲突将消失但仍属高影响、将转为待确认的写入另列（`now_awaiting`）。`not_deleted` 如实列出不会删除的：外部文件、schema 里的文字、保留的元数据、连接实例的名称（`connection_names`：它不是由源数据得出的，不在级联范围内）、没有任何源数据的操作自报的任务标识与显式幂等键（`operation_labels`）。
- **删除后仍保留、但不再支撑任何数据的源数据**（`orphaned_sources`）：只列这次删除之后由"支撑了数据"变成"什么都不支撑"的源数据 ID——典型的是同一次写入里的另一段证据、后来对同一件事的转述。它们不在这次删除的范围内，照常保留；列出来供调用方决定是否一并删除。
- **以将被改动的值为前提的行**（`premise_affected`，预告）：删除会让它们带上 `premise_changed`（原因 `deleted`），它们自己不会被删除。删除不沿前提传播：依赖行的值来源是它自己的证据。
- **来源键**：受影响的行有来源键时，`warnings` 给 `external_key_resync`——物理删除之后 saveslot 不记得这个键，连接器再次同步同一条记录时它会作为新的一行重新出现；要彻底忘掉，先在来源系统里删除，或让连接器停止同步它。行的来源全部被删时，之后的同步也不会补回当时被跳过的记录（被跳过的 op 不进日志，预览不逐条列出）。一项删除可以让多个键同时冻结；同一个键也可以被几项删除同时冻结，要等这几项都撤回或执行之后才按删除后的状态重算持有者，撤回其中一项不解冻。行保留下来、但会失去来源键的，逐行结果带 `external_key_removed`。预览与回执的逐行结果在键将冻结的行上带 `external_key_frozen`（不列键值）；同一个键还被另外几项未执行的删除冻结时附 `also_by`（那几项的删除 ID）：撤回这一项之后它仍冻结，要等它们撤回或执行。宽限期内被这项删除去掉的键仍然占位：命中它的按来源键 op 被跳过（`pending_deletion`）。
- 逐行结果列出值或给出它的贡献与删除前不同的行：取值没变、只因为给出者、判定结果或给出它们的块被重新给出而列出的行，`result` 是 `sources_changed`（例：被删的写入给出的值，另有一次佐证给出同一个值；给出空洞的撤销因删除被重新解析，空洞仍在原处）。
- 状态类表上由有值变成无值的区间单列在逐行结果的 `gaps_opened` 里，附原因：`required_field_removed` 是某个必填字段在该处已没有仍在的贡献；`revocation_extended` 是某次只带起点的撤销因删除延伸，吞掉了之后没带齐必填字段的写入；一个区间只列一次，落在撤销之内取后者，否则取前者（data-model「预览与回执要写明的内容」）。它在预览与回执里现算，不进事件。事件类表、无时间表上整行删除由 `result` 表达，不用它。
- 逐行结果里 `fields_reverted` 的 `reverted_to` 写明每个字段回到谁的值：`from_seq`（回到那次写入的值）与 `schema_const: {sv}`（回到那一版 schema 切换时常量 `backfill` 的补值，没有写入可指）二者必有其一。
- **只有 `rows[]` 分页**；其余列表各自最多 50 条，另给总数。`totals` 总是全量；`dc_` 绑定的是整份预览，不随翻页变。
- **删除 ID 在预览时预分配**，绑定在 `dc_` 里。认出"这个 `dc_` 已经执行过"靠的是按这个删除 ID 查删除表，不靠内容哈希。
- **预览何时过期**：预览之后有写入、解决或删除改到了预览列出的任何一行 / 实体、事项或源数据（data-model「预览与回执要写明的内容」）。
- 按 `{confirm}` 重出预览时的判定顺序：这个 `dc_` 已经执行过 → `handle_expired`（`executed`，附删除 ID）；签名过期或恢复次数对不上 → `handle_expired`；影响范围内有晚于预览的写入 → `preview_outdated`（附新预览）。

### `pending`

- 给 `id` 看详情；不给则列出。`status` 默认 `open`，按挂起时长倒序。只列可见 slot 的事项；`slot` 过滤指向不存在或不可见的 slot 报 `not_found`（`slot`），不可见的事项 ID 报 `not_found`。
- **事项详情给出事项的全部内容**：目标、当前值、提议或候选、影响、可用的处理方式。影响在事项版本的绑定范围内（data-model「待处理事项」）。查看详情算读到了该事项版本。
- **已关闭的事项按 ID 一直可查**：已解决的给 `resolution`，已被取代的给 `superseded`。`flagged` 事项被比中的行被撤销或改动时，取代（或刷新）的原因是 `matched_changed`：它不看写入方读没读过事项。`deletion` 事项到期后仍可查 `states[]`：到期执行（物理删除）之后是已解决，`resolution` 是执行的一支（`executed: true`、墓碑的操作号与时刻、原因），没有处理方式，`actor` 恒为 `system` 而不给；宽限期已过、尚未物理删除时仍是 `open`、`decisions` 为空，带 `overdue`；这期间涉及这个 slot 的调用在 `notices` 里给 `deletion_overdue`（附删除 ID），直到墓碑落账。受影响的行曾有来源键时，`deletion` 事项到期关闭后的详情在 `warnings` 里再给一次 `external_key_resync`：那之后的第一次同步就会把记录写回来，而此时不会再有别的提示。
- `schema_change` 事项确认之后、迁移进行中或失败时，详情带 `migration`（目标版本、状态、进度）：调用方凭事项 ID 查迁移进行到哪。

### `resolve`

**判定顺序**（data-model「待处理事项」）：

1. 事项不存在 → `not_found`。
2. 事项已关闭：已解决、处理方式相同 → 返回原结果，`replayed: true`；已解决、处理方式不同，或已被取代 → `item_closed`（附已有结果，或取代的原因）。所以过了很久用旧 `item_ver` 重发同一处理方式，也按重放返回。
3. 事项不是 `deletion`、也不是 `schema_change`，而它的目标受一项仍待执行的删除影响（data-model「删除 · 撤回与宽限期」）→ `invalid_argument`（`pending_deletion_target`），附相关的删除与最晚的到期时刻；不核对绑定的内容，不产生事件。
4. 按第 6 节核对绑定的内容；对不上 → `confirmation_mismatch`，附 `current`：该事项此刻的详情（含新的 `item_ver`），与同一时刻查看详情所得相同，算读到（第 2 节）。
5. `schema_change` 的 `confirm`：在同一个事务里重新判断。草稿里凡按"从未被写入"编译的改动（只对从未被写入的表放开的结构改动，以及归入 `restructure_unused` 的各项，见 `schema_draft` 一节），所在的表在确认时已被写入，一律报 `draft_outdated`（`table_written`）；草稿带 `migrate` 时，对试跑之后的新写入（迁移期间带旧 `sv` 的写入）重新求值，有失败的报 `draft_outdated`（`migrate_failed`）。两种都不产生任何事件，事项保持未决；调用方 `reject` 这份草稿，或提交新草稿取代它。

- **触发的写入同样过 `ref` 目标的校验**（data-model「写入 ref 字段时」）：采纳候选、回到合并基、确认待确认写入（含确认一次撤回）时，这次将要生效的 `ref` 值按处理时的状态校验，不过报 `validation_failed`（`ref_not_found` / `ref_wrong_table`），明细不带 `op`、带 `table` 与 `field`；不产生任何事件，事项保持未决。
- `take_candidate` 在事项有多个候选时必须给 `candidate`（详情里候选的 `index`；下标在事项生命周期内不复用），否则 `invalid_argument`（`candidate_required`，附候选 `candidate_choices`：每个候选的下标、所在写入的操作号与写入者）。
- `evidence` 与 `note`：`resolve` 没有请求级证据，证据只有 `evidence` 与 `evidence_by_field`，不收 `evidence_refs`；`evidence_by_field` 的下标数的就是本次的 `evidence` 数组，处理触发写入时按字段指明那次写入的证据（这一版不收，报 `not_in_this_version`：这一版各种处理方式触发的写入的项都是搬运来的，按字段指明证据改变不了它们的来源；`migration_diff` 的 `set` 带值时才用得上）。`evidence` 每段存为一条源数据；带了 `note`、或处理会触发写入而没带证据时，解决请求本身（含 `note`）另存一条 `api_call`。**不触发写入的处理方式（`keep_effective`、`reject`、`keep`、schema 的确认与拒绝）同样如此**，所以 `note` 总有地方落、总能被隐私删除清掉。它们只是操作来源；事项详情的 `resolution.note` 从这条源数据回显，源数据被删后不再回显。既没带证据也没带 `note`、又不触发写入的解决不产生源数据。
- 结果：触发了写入时带 `write`（形状同写入回执的对应部分，含 `premise_affected`）；`schema_change` 的 `confirm` 带 `schema`（是否已切换、新 `sv`，或迁移状态）；`deletion` 的 `cancel` 带 `cancelled`（受影响行的新 `ver`、退回原状态的写入、恢复的事项、保持"已被取代"的事项、因已被当作基线而不退回的写入、前提的变化 `premise_affected`）。
- **撤回时被重新判定的候选**（`cancelled.rejudged[]`，后续）：第一版不会出现——宽限期内受影响的行上不能解决事项，被删除去掉的候选撤回时回到仍未决的原事项，或随已关闭的原事项关闭。放开那条限制之后：删除曾从一个冲突事项里去掉某个候选，而那个事项在宽限期内已经被解决。撤回后候选回来，原事项的解决不动，候选按撤回时的当前值重新判定，一个候选一条：还有部分与当前值不同 → `reopened`，为它另开一个冲突事项（成因 `restored_candidate`，详情的 `related_item` 指回原事项；附新事项的 `id` 与 `item_ver`）；都与当前值相同、其中有指了证据的 → `corroborated`，成为佐证；都相同且没指证据 → `dropped`，不再是改动。后两种没有事项可处理，所以要在这里列出，调用方才知道那次写入最终没有生效。
- **确认记录**另记 `via: "call" | "elicitation"`（`elicitation` 后续）：由外化面填写，调用方不能传，只作记录。

### `schema_draft`

- 参数是 schema 文档（data-model「schema 文档格式」）；新建 slot 时 `base_version: null`。新提交的草稿取代该 slot 尚未确认的旧草稿（旧草稿的 `schema_change` 事项标已被取代，原因 `draft_replaced`）。
- **一次调用同时返回编译结果与影响预览**：回填了 ID 与推断结果的文档、逐项改动（改动码 `change`、类别、对旧版写入是否兼容、是否破坏性、是否可自动生效）、影响（受影响行数、派生值变化、按旧名字使用它的调用方、`migrate` / `backfill` 的试跑结果）。**这一版不计算使用方**：改已有 slot 的回执不给 `consumers`（给空列表就成了"没有使用方"的结论），"没人在用"也一律按在用处理，改名一律要确认。
- 草稿与当前版本相比没有任何改动，报 `invalid_argument`（`no_change`，`param` 为 `document`），不产生任何事件、不占版本号。只相对于当前版本判：与待确认的那份内容完全相同的草稿（不在幂等窗口内，或换了 `task`）照常取代它、拿新的版本号。
- 改已有 slot 时的报错次序：slot 找不到或不在范围 → `base_version` 的写法 → 草稿过时（`draft_outdated`，`base_version`）→ 迁移进行中（`draft_outdated`，`migrating`，带 `current_sv` 与 `migration`）→ 其余。

  | `outcome` | 什么时候 |
  |---|---|
  | `applied` | 新建 slot（编译通过即生效，`sv: 1`）；或全部改动按 slot 策略都可自动生效。返回新 `sv`；需要后台构建时带 `migration` |
  | `pending` | 生成 `schema_change` 事项，附 `id` 与 `item_ver`；本回执已给出它的全部内容，算读到 |

- **一份草稿自动生效，当且仅当它的每一项改动所属的类别都在 slot 策略的 `auto_apply` 里**（types 5.3 的对应表）；否则整份草稿进待确认。默认策略八类全开；`restructure_unused` 这一类在它加入默认策略之前建的 slot 里没有，第一版也没有改策略的操作。
- **从未被写入的表**（日志里没有任何一条以这张表为目标的基础写入；写过、行已全部撤销或内容已全部删除的都不算）上，下面这些改动放开：改表的时间类型（`change_time_type`）、增删改 `entity_key`（`change_entity_key`）、改 `granularity`（`change_granularity`）、`base` 改 `derived`（`change_table_kind`；反方向仍不支持）、字段与 `ref` 互转或改 `ref` 的目标（`change_ref`）、加 / 去掉 / 换来源键（`add_external_key` / `drop_external_key` / `change_external_key`）。表 ID 与字段 ID 不变。
  - 这张表最近 30 天也没有提交者以外的连接实例按名字读写过时，这些改动，连同同一张表上的 `drop_field`、`change_type`、`change_dimension`、`change_unit`、`change_precision`、`tighten_constraint`，`add_required_field`、`change_time_field`，都归入 `restructure_unused`，自动生效：没有值可丢，`class` 记 `metadata`，`destructive` 是 `false`，`migrate` 不必给。新增必填字段与可选改必填仍须给常量形式的 `backfill`。有别人读写过时要确认，影响的 `consumers` 列出他们。
  - 依赖这张表的派生规则在同一次编译里按新定义重新编译；规则的输出没变的不另列改动。
  - 经 `restructure_unused` 生效的任何改动之后，带旧 `sv` 写这张表的写入一律被拒：`schema_incompatible`，`changed_fields` 给一项 `{field: "*", change: <改动码>}`，`"*"` 表示整张表。
  - 草稿等确认期间这张表被写入了：草稿里凡按"从未被写入"编译的改动都不再成立，确认时一律报 `draft_outdated`（`table_written`，见 `resolve`）。
- **第一版不支持的键或改动**：`reextract`、`extends`、`compatibility`、`derived` 改 `base`；在写入过的表上改时间类型、增删改 `entity_key`、改 `granularity`、`base` 改 `derived`、`ref` 互转与改目标、换一组来源键（`change_external_key`）、改来源键字段的类型或收紧它的约束。写入过的表上仍可以加来源键（键字段须是同一份草稿新增的字段）或去掉它，都要确认。草稿里出现时整份报 `not_in_this_version`，`param` 指到那个键，不产生任何事件；因为表已被写入而不支持的，`reason` 是 `table_written`。
- **这一版建 slot 时不收的派生规则**：用到 `saveslot_date` 的、分组键是 `decimal` / `quantity` 且小数位上界可能超出推断精度的（算法见 [`03-data-model/11-restricted-sql.md`](03-data-model/11-restricted-sql.md)「小数分组键」）。都报 `not_in_this_version`，`param` 指到那张派生表的规则（`tables/<i>/rule`），不产生任何事件。派生规则读读时计算的派生表，这一版同样报 `not_in_this_version`，`param` 是 `tables/<i>/rule/sql`。
- **新建 slot** 要求凭证的 slot 范围是"全部"：限定了 slot 范围的凭证报 `insufficient_scope`（`required_scope: "all_slots"`），不论草稿里的 slot 名是否与某个不可见的 slot 重名。凭证同时没有 `saveslot.schema` 时先报缺 scope（`required_scope: "saveslot.schema"`）：先查动作，再查范围。
- 文档的形式不对报 `invalid_argument`，`param` 是文档里的位置（写法同明细的 `path`，如 `tables/0/fields/2/min`）：文档不是对象、键的 JSON 类型不对、出现不认识的键、字符串不是良构的 Unicode（含孤立的代理项，写不进日志）、枚举值不合内容规则（见 data-model「字段类型与取值范围」）（`malformed`），缺了必有的键（`missing`）。不认识的键不忽略：拼错的 `requried` 若被忽略，字段就悄悄成了可选。`param` 落在派生表的规则上（`tables/<i>/rule` 及其下的键，或写在表上而不在规则里的 `tables/<i>/sql`）时，`example` 给出一条完整的规则 `{sql, time_dependency}`；落在 `time_dependency` 上时另带 `allowed_values`，是这一版建 slot 收的取值（`none`、`bucketed`、`now`）。`min` / `max` 可以写十进制字符串（不带指数），也可以写 JSON 数字，但数字只收 ±(2^53 − 1) 之内的整数；带小数的边界一律写成字符串：JSON 数字解析之后，已经分不出调用方写的是哪个十进制数。
- 编译失败报 `validation_failed`（`schema`），`details[]` 逐条指出文档里的位置。`base_version` 不是当前版本、或迁移进行中，报 `draft_outdated`（带 `current_sv`）：**草稿过时一律最先报**，`base_version` 的写法查完就查它，草稿别处有什么问题都不看——调用方先要基于当前版本重新起草。有已有字段没匹配到、也没列入删除，报 `field_unmatched`。
- `drop_tables`、表的 `drop_fields` 收名字，也收 ID；一个字符串既是某一项的名字、又是另一项的 ID 时按名字。
- 表与字段先按 `id` 匹配，没带 `id` 的再在没被 `id` 认领的那些里按名字匹配。新增的表或字段用了同一份草稿里另一项改掉的旧名（A 改名为 B，同时新增一个叫 A 的），报 `validation_failed`（`name_renamed_away`），不猜这个名字指哪一个。
- 两项之间的冲突（重名、名字与别名相同）有一方是草稿列出的，报在列出的那一方上：草稿没列出的表不在文档里，报在那里调用方无处可改。两张表重名报 `duplicate_name`。一张表的名字与另一张表的别名相同：别名所在的表在草稿里列出时，报在那个别名上，`alias_invalid`（`reason: name`，同「别名」的规则）；没列出时没有别名的位置可指，报在列出那一方的 `name` 上，`duplicate_name`。由重名引出的、按这个名字的引用上的发现（`ref` 的目标）不另报。
- 四个与数据有关的编译明细码：
  - `still_referenced`：要删的表或字段仍被依赖（被 `ref` 指着的表；被派生规则、`entity_key`、`external_key`、`time.field`、`duplicate_keys`、`together` 用到的字段）。`referenced_by` 列出依赖方：草稿里列出了它时给它在文档里的位置（如 `tables/0/fields/8`），没列出时给名字（`表.字段`，派生表给表名）。按改动之后的样子判：同一份草稿里把依赖方一并删掉或改掉即可。
  - `backfill_const_required`：新增必填字段、或把可选改成必填，一律必须给常量形式的 `backfill`，不看表里当时有没有行。表达式形式只对已有值的位置求值，没有旧值的位置只能由常量给值。
  - `backfill_required`：收紧 `min` / `max` 或删枚举值时，已有的行违反新约束而没给 `backfill`；附违反的行数与样例。它与 `backfill_const_required` 的分工：改必填（新增必填字段、可选改必填）不看有没有行，看的是有没有常量形式的 `backfill`；其余收紧看的是有没有行违反。
  - `backfill_both_forms`：`backfill` 的常量形式与表达式形式同时给了；只能给一种（既收紧范围又改必填时只给常量）。
- 其余几个编译明细码何时出现：

  | 明细码 | 什么时候 |
  |---|---|
  | `description_missing` | 表、字段、派生字段没写说明（`description` 必填），或写成空串、全是空白 |
  | `unknown_type` | 字段的 `type` 不是 types 4.2 的 `FieldType` 之一。明细带 `allowed_values`：全部 `FieldType` |
  | `entity_key_not_required` | `entity_key` 列出的字段不是必填字段 |
  | `unknown_reference` | 文档里按名字指向的东西不存在：`time.field`、`entity_key`、`external_key`、`together`、`duplicate_keys` 里的字段名，`ref.table` 里的表名 |
  | `key_not_applicable` | 键或它的取值用在不适用的类型或表上：`min` / `max` 不在 `integer`、`decimal`、`quantity` 上，`values` 不在 `enum` 上，`unit` 不在 `quantity` 上，`scale` / `rounding` 不在 `decimal`、`quantity` 上，`ref` 不在 `ref` 字段上；`entity_key` 不在状态类表上，`duplicate_keys` 在状态类表上；`time.field` 指的字段不是必填的 `date` 或 `zoned_datetime`；`ref.target` 是 `row` 而目标是状态类表，或是 `entity` 而目标不是状态类表；`ref.table` 指向派生表（`ref` 只在基础表之间）；派生表上写了 `time`、`entity_key`、`together`、`duplicate_keys`，基础表上写了 `rule`；派生字段上写了 `required`、`min`、`max`、`values`、`ref`，写了不是 `decimal` 的 `type`，或在 `decimal` 上写了 `unit`。类型不对的两处明细带 `allowed_values`：`time.field` 指的字段是 `["date", "zoned_datetime"]`，派生字段的 `type` 是 `["decimal"]`；`time.field` 指的字段不是必填时明细带 `reason: "not_required"`；类型与必填都不对时报两条 |
  | `out_of_bounds` | 取值越界：`min` 大于 `max`；`min` / `max` 超出类型的范围（`integer` 是 64 位有符号整数，`decimal`、`quantity` 的整数部分至多 18 位）；`scale` 不在 0–12；表没有字段；slot 没有基础表（明细带 `min: "1"`）；租户的 slot、slot 的表（基础表与派生表合计）、表的字段超过上限（明细带 `max`；上限是临时值，见 open-questions「接口的数值与细则」）；枚举没有取值或超过 200 个，枚举值为空或超过 64 个字符；说明超过 500 个字符；`entity_key` 为空，`external_key` 不是 1–4 个字段，`together` 的一组少于两个字段，`duplicate_keys` 的一组为空。长度按码点数。明细的 `min` / `max` 是 `path` 处的值应落在的界，适用几个给几个，写成十进制字符串：说明 `max: "500"`；枚举的取值个数 `min: "1"`、`max: "200"`，单个取值 `min: "1"`、`max: "64"`；`scale` 是 `min: "0"`、`max: "12"`；`entity_key` 是 `min: "1"`；`external_key` 是 `min: "1"`、`max: "4"`；`together` 的一组 `min: "2"`；`duplicate_keys` 的一组 `min: "1"`；`min` / `max` 超出类型的范围时给类型的两头（`integer` 是 ±64 位，`decimal`、`quantity` 是 ±`999999999999999999.999999999999`）；`min` 大于 `max` 时报在 `…/max` 上，带 `min`（给的 `min`：`max` 至少是它） |
  | `duplicate_entry` | 同一个列表里重复的项：枚举值重复（区分大小写）；`entity_key`、`external_key`、`together`、`duplicate_keys` 的一组里同一字段出现两次；一个字段进了两个 `together` 组。名字相撞是 `duplicate_name`（名字与另一项的别名相同见上） |
  | `timezone_unknown` | slot 的 `timezone` 不是认得的时区名：不是 `UTC` 或"区域/地点"的写法（如偏移量 `+08:00`、没有 `/` 的短名 `CST`），或不在所用的时区库里 |

- 来源键的编译明细码：声明在状态类表或派生表上（`external_key_table_kind`）；键字段的类型不是 `text`、`enum`、`integer`（`external_key_field_type`）；写入过的表上把已有字段声明为键（`external_key_existing_field`）；键字段出现在 `together` 里（`external_key_in_together`）。只声明了一个键字段时，`warnings` 给 `single_field_external_key`：多个来源系统写这张表时 ID 可能相撞。
- 派生表规则的分组键来自自由文本字段（`text`，不含 `enum`）时，`warnings` 给 `group_key_free_text`：分组键是用户原文，删除时随分组一起清除（data-model「派生行身份」）。
- 别名不合规则（超过 8 个、超过 64 个字符、规范化后为空、含换行或控制字符、首尾是空白、同一对象内重复、与同一作用域里仍可解析的名字相同）：`validation_failed`，明细码 `alias_invalid`，`path` 指到那一项，`reason` 指出违反的是哪一条（`count`、`length`、`empty`、`control`、`surrounding_space`、`repeat`、`name`，一项同时违反几条时按这个顺序取第一条；`count` 与 `length` 带 `max`）。
- `migrate` 与表达式形式的 `backfill` 第一版只能引用本字段的旧值与常量，引用别的字段报 `not_in_this_version`；它们只对带值的位置求值，空值原样带过去。

### `delete`

- 参数只有 `confirm`（`deletion_preview` 返回的 `dc_`）。只执行，不预览。
- **判定顺序**：这个 `dc_` 已经执行过 → 返回原结果，`replayed: true`；签名过期或恢复次数对不上 → `handle_expired`；影响范围内有晚于预览的写入 → `preview_outdated`（附新预览与新的 `dc_`）。
- 结果 = 按确认时的状态重算的预览内容，加回执另给的项。预览里有的列表回执里都有，上限与总数同预览：总量；逐行结果（另带新 `ver`）；因删除生效的写入、转为待确认的写入（另带生成的事项）、被取代的事项；清除的分组键（`group_keys_cleared`）；仍引用被删行的行（`dangling_refs`）；不会删除的内容；删除后不再支撑任何数据的源数据（`orphaned_sources`）；前提的变化（`premise_affected`）；本机模式的推迟执行（`local_deferred`）。另给：删除 ID（与宽限期内的 `deletion` 事项是同一个对象）、到期时刻、撤回方法；受影响的派生值；每处的状态与时间；删除后保留的元数据。受影响的行有来源键时同样给 `external_key_resync`。不宣称"已从所有备份删除"。
- 撤回走 `resolve`（`deletion` 事项、`cancel`）。撤销一行不是删除，用 `write` 的 `revoke`。

### 抽取作业：`extract_claim` / `extract_submit`（后续）

规则（来源簇、翻译必须给全、因删除补抽、什么进差异清单）见 data-model「抽取作业」。

`extract_claim` 参数：`job`（可选；不给则领取本连接实例有权限的最早的作业）、`max_items`（可选；服务端另按字节预算裁剪）、`schema_digest`（可选：上次领取拿到的摘要）。同一连接实例 + `task` 有未过期租约时返回原租约。没有可领取的工作项时不报错，返回 `items: []` 与 `reason`：`none_available` / `job_ended`。

```json
{
  "lease": "ls_…", "expires_in": 900,
  "job": { "id": "jb_…", "kind": "migration_reextract", "slot": "health", "target_version": 3, "done": 120, "total": 2300 },
  "schema_digest": "sd_…",
  "target_schema": { "tables": [{ "name": "runs", "fields": [
    { "name": "effort", "type": "enum", "values": ["easy", "moderate", "hard"], "description": "主观强度" },
    { "name": "soreness", "type": "text", "description": "酸痛部位与程度" } ] }] },
  "instructions": "从原 feeling 与源数据原文中拆出强度与酸痛；原文没提就留空",
  "items": [{
    "item": "it_1", "table": "runs", "row": "r_01JC…",
    "writes": [
      { "op": "w_41", "intent": "insert", "source": "今天跑了 15 公里，腿有点酸，跑得很累",
        "old": { "feeling": "腿有点酸，很累" } }
    ]
  }]
}
```

- 第一次领取完整返回 `target_schema` 与 `instructions`；之后带上 `schema_digest`、且内容没变时省略这两项。
- `instructions`、`source`、`old` 里的文本值是 `UntrustedText`；`source` 为 `null` 时附 `reason: "evidence_deleted"`。

`extract_submit` 参数：

```json
{
  "lease": "ls_…", "model": "claude-…",
  "results": [
    { "item": "it_1", "writes": [{ "op": "w_41", "set": { "effort": "hard", "soreness": "腿有点酸" } }] },
    { "item": "it_2", "skip": { "reason": "no_content" } }
  ]
}
```

- `model`：可选，自报的模型名，记进日志、只作参考。
- 每个工作项过一遍写入的确定性校验；失败的逐项给出原因，租约内可重交；部分提交允许，按 `(lease, item)` 幂等。跳过原因码只有 `no_content` / `ambiguous`。
- 结果：已接受 / 校验失败 / 已跳过的工作项数，作业进度，是否还有可领取的工作项。
- 迁移已放弃或已切换后，用原租约提交报 `lease_expired`，附 `reason`。

## 11. 领域错误

错误对象的形状、每个错误码附带的字段、哪些操作会返回哪些错误码，见 types 第 9 节。

- `code` 与附带的结构化字段由契约定义；人读的说明与下一步由外化面按这些字段渲染。
- **一次写入整体要么全部记下、要么全部拒绝**：有 op 违反确定性校验时整个请求不生效，只返回错误；`details[]` 逐条定位到 op 与字段。
- **被拒的写入不产生事件，也不去重**（第 14 节）。
- **冲突不是报错**：`ver` 对不上、且改到同一冲突单元时，写入记为候选，回执 `status: pending`。
- **不存在与不可见报同一个错误**：可见范围外的东西对这个凭证与不存在完全相同（第 12 节）。
  - 按名字引用的（表名、字段名）：报该操作对不存在的名字本来报的那个——`query`、`history`、`write`、`catalog` 报 `unknown_table` / `unknown_field`，`sql` 报 `sql_rejected`（`unknown_name`）。
  - 按 ID 引用的（行、实体、事项、源数据、草稿、一次读取）：`not_found`，与 ID 不存在相同。写进参数里的行 ID 也一样：`ref` 字段的值指向不可见的行报 `validation_failed`（`ref_not_found`），前提指向不可见的行报 `not_found`；`ref_wrong_table`、`cross_slot` 只在目标可见时才报，否则"这个 ID 在别处存在"就从错误码里漏出去了。
  - 按名字或 ID 指定 slot 的参数（`catalog` 的 `slot`、`sources` 与 `pending` 的 `slot` 过滤、`policy.get`、`connections.issue` 的 `slots`）：`not_found`（`slot`）。
- **`nearest`**（`unknown_table` / `unknown_field` 附的最接近的名字）只从可见的名字里取。别名与请求里那个名字按 `keymatch@1` 的折叠（data-model「相近的键」）比较后相同的对象，其**名字**排在最前；其余按与请求里那个名字在 `keymatch@1` 折叠之后的编辑距离从小到大排，相同时按名字的 `C` 排序（按码点）；最多给 3 个。返回的是名字，不是别名文字，所以报错里不出现不可信文本。不带 slot 的表名，几个 slot 里同名的表算一个名字，它们的别名合在一起比较。例外是 `reads.list` 的 `table` 过滤：它认的是读取记录里出现过的表名，`nearest` 只按这些表名给，不借别名。

| `code` | 什么时候 |
|---|---|
| `invalid_argument` | 参数缺失、格式不对、互斥的参数同时给、模式与参数配错；表名有歧义；`changes` 以派生表为目标；`revert` 的目标不对；时间参数用在不适用的表上、粒度不对；多候选时没给 `candidate`；引用待删除的源数据；宽限期内对受删除影响的行做决定（解决事项、`undo`）；预览跨 slot；同一显式幂等键配不同的请求内容；证据下标越界或映射为空；运算符不适用于字段类型；按来源键写入的写法不对、同一请求里同一个来源键出现两次、补键时键已被占用或不能转移、让出了键的行要重新存在；前提用在不能带的 op 上、指向自己、指向历史版本或别的 slot；签发时 slot 列表为空；导入的目标租户不是空的。细分见 `reason` |
| `unknown_table` / `unknown_field` | 名字不存在，或不在可见范围内（含前提里的表与字段）；附最接近的名字 |
| `not_found` | 行 / 实体不存在、已被删除或不可见（含前提指向的行）；事项、源数据、草稿、连接实例、读取不存在或不可见；指定的 slot 不存在或不可见（`slot`）。被宽限期内的删除整行去掉时附全部相关删除的 ID（`deletions`），不回显内容 |
| `revoked` | 事件类表、无时间表上写到已撤销的行（含重申、清除前提的目标行）。按来源键命中已撤销的行不报错，那个 op 被跳过 |
| `derived_readonly` | 写派生表；附它的基础表 |
| `validation_failed` | 写入的类型、单位量纲、范围、必填不符，`ref` 的目标不存在或不可见，写入触发的派生刷新求值出错（`rule_eval_failed`），迁移进行中带旧 `sv` 的写入对新版求值转换表达式失败（`migrate_failed`，`path` 指到那个 op 的那个字段，按新版本重读再写）；schema 编译失败（含来源键与别名的规则） |
| `read_first` | 没带 `ver` / `item_ver` / `sv`（含前提里的 `ver`）、也没有可兜底的读取；`since: "my_last_read"` 而没读过 |
| `schema_incompatible` | 带回的 `sv` 之后，所写字段发生了不兼容变化；或所写的表经 `restructure_unused` 改过结构（`changed_fields` 给 `"*"`） |
| `too_large` | 证据段或请求超上限；超出写入准入阈值（第一版不报，见第 5.4 节「写入准入」）；不可分页的结果超出外化面的结果预算；一个 op 的前提超过 16 条，或前提目标已被 1,000 条有效声明指向 |
| `sql_rejected` | 受限 SQL 校验不过（含引用了不存在或不可见的表、类型或单位不合、超出上限），或执行时求值出错（`runtime`） |
| `sql_timeout` | 受限 SQL 执行超时 |
| `draft_outdated` | 草稿的 `base_version` 不是当前版本，或迁移进行中；确认时草稿所改结构的那张表已被写入（`table_written`），或 `migrate` 对试跑之后的新写入求值失败（`migrate_failed`） |
| `field_unmatched` | 草稿里有已有字段没匹配到、也没列入删除 |
| `confirmation_mismatch` | 解决事项时绑定的内容对不上；恢复备份或导入之前拿到的 `item_ver` |
| `item_closed` | 事项已用不同处理方式解决、已被取代，或 `deletion` 的宽限期已过（同一处理方式重发是重放，不报错） |
| `preview_outdated` | `dc_` 绑定的影响范围内有晚于预览的写入 |
| `referenced`、`lease_expired`（后续） | 删除证据被引用挡住；抽取租约失效 |

---

# 第二部分 · contract（对外封装）

## 12. 调用方：凭证与 scope

**两类凭证**（第一版单节点，没有节点凭证）：

| 凭证 | 谁持有 | 能做什么 |
|---|---|---|
| 用户会话 | 人：本地由 `saveslot init` 生成，服务器模式经 CLI 登录（App 后续） | 一切，包括签发与吊销连接实例、审计、导出 |
| 连接实例 | 一个 Agent 或脚本（本地：写进 MCP 配置的令牌；远程：一次 OAuth 授权，或用户会话签发的静态令牌——给走不了 OAuth 的脚本） | 按 scope 与 slot 范围 |

- actor 一律由凭证得出，请求里不能填。确认与数据真实性委托给调用方，见 architecture §3。
- **scope**（签发连接实例时显式选，**默认 `saveslot.read saveslot.write`**；`saveslot.schema`、`saveslot.delete` 要显式加上）：

  | scope | 允许 |
  |---|---|
  | `saveslot.read` | 全部读操作（含 `deletion_preview`、`policy.get`） |
  | `saveslot.write` | `write`；`resolve` 中 `saveslot.write` 的组合 |
  | `saveslot.schema` | `schema_draft`；`resolve` 中 `schema_change` 的处理 |
  | `saveslot.delete` | `delete`；`resolve` 中 `deletion` 的 `cancel` |

- **每个连接实例都必须有 `saveslot.read`**：写入要先读（`ver`、`sv`、事项详情），没有读权限的连接实例走不通任何流程。签发时不含 `saveslot.read` 报 `invalid_argument`（`missing_read_scope`）。只读的连接实例就是只有 `saveslot.read`。
- **授权 = scope × slot 范围**：slot 范围是"全部"或"一个 slot 列表"，签发时定下（`connections.issue` 的 `slots`，不给 = 全部）。同一组 scope 对范围内的每个 slot 一样；要"A 可写、B 只读"就签发两个连接实例。slot 是凭证授权范围的最小单位；表级、字段级的数据权限是后续（open-questions「数据权限的表级、字段级」）。用户会话的范围恒为全部。
  - **范围外的 slot 对这个凭证与不存在完全相同**：目录里不出现；按名字引用报该操作对不存在的名字本来报的错误，按 ID 引用报 `not_found`（第 11 节）；`notices` 只按可见范围计算；名字解析只在可见范围内做（第 1 节）。冲突、同值、高影响、疑似重复的判定不因范围而变。
  - **范围是"全部"时包括之后新建的 slot**；范围是列表时，之后别人新建的 slot 不纳入。
  - **限定了范围的凭证不能新建 slot**：报 `insufficient_scope`（`required_scope: "all_slots"`）。建出来的 slot 不在它的列表里，它自己都看不见；先由用户会话或范围为"全部"的连接实例建好，再签发限定到它的凭证。凭证同时没有 `saveslot.schema` 时先报缺 scope：先查动作，再查范围。
  - 范围的权威在日志里（主体登记事件），服务层按它构造调用上下文的可见范围。
- **第一版 scope 与 slot 范围签发后都不能改**：要改就吊销后重签。远程授权的 step-up（越权后重新授权）得到的是一个新的连接实例，原来那个不变。来源键的唯一范围是表、不含连接实例，换一个连接实例接着同步不会重复新增。
- **声明"外部权威"级别的权限**（后续）：将来开放 `external_authority` 时，它是用户会话在签发时授予连接实例的一项权限，与 scope、slot 范围一同记在主体登记事件里（第 3 节）。
- **凭证失效**：令牌缺失、无效、已吊销、会话过期，一律 `unauthenticated`，`reason` 区分四种情形（第 16 节）。吊销立即生效。
- **吊销之后留下什么**：吊销只让这个凭证此后的请求被拒，不触发任何删除，也不改动已有的数据。它写过的数据 `actor` 不变；结果里的 `Actor.name` 照旧是它的名字，`Actor.state` 是 `revoked`，文本渲染时名字后标"已吊销"。它的名字**仍然占用**：同一用户下不能再签发同名的连接实例，历史里同一个名字只指一个主体。它发起而尚未处理的事项（冲突、待确认、已标记、schema 变更、宽限期内的删除）照常保留，由用户会话或其他有相应 scope 的连接实例处理；宽限期内的删除照常到期执行。读取记录里它的读取照常参与影响查询。
- **停用的主体**：导入到空租户（第 17 节）把导入前登记的全部用户主体与连接实例置为停用（`system` 除外）。停用的主体不能认证，第一版不能恢复；它写过的数据、发起而未处理的事项，与吊销之后留下的完全一样；`Actor.state` 是 `disabled`，文本渲染时名字后标"已停用"，名字同样仍然占用。`connections.list` 里的连接实例同样带 `state`（`revoked` / `disabled`）。

## 13. 任务、分页与附带信息

- **`task`**：除管理类操作外，所有操作都有可选的任务标识，自报，用于关联同一任务的读写；参与兜底（第 2 节）与服务端请求键（第 14 节）。
- **分页**：`limit` 默认 20、上限 200；`cursor` 是不透明句柄（第 15 节）。结果给 `total` 与 `next_cursor`。外化面按自己的结果预算提前截断时另给 `truncated`，截断点就是页边界：`next_cursor` 从没显示的第一行开始。
- **`detail`**：`concise`（默认）/ `detailed`（每行另给最近一次改动的操作号与记录时间，每个字段的 ID、来源级别、字面命中；`ref` 字段附被引用行的摘要；这一行当前生效的全部前提声明）。只在返回行的地方有：`query`，以及 `history` 的 `as_of`。读时计算的派生表上 `detailed` 报 `not_in_this_version`：这些行没有操作号、记录时间与字段来源可给。
- **`warnings[]`**：与本次调用的某个部分有关的结构化提醒；码表见 types 第 7 节。
- **`notices[]`**：与本次调用相关的提示，最多 3 条；码表见 types 第 7 节。每一种提示都只按可见范围计算，范围外的 slot 不出现在任何提示里。"相关"指本次调用涉及的 slot：`catalog` 列出或点到的 slot、`query` / `history` 读的表所在的 slot、`write` 写的表所在的 slot、`resolve` 处理的事项所在的 slot、`schema_draft` 新建的 slot。提示按此刻的状态算，计算本身不记进读取记录；报错的结果不带提示。
- **`replayed`**：幂等重放时为 true。

## 14. 幂等

- **写操作一律服务端幂等**（`write`、`resolve`、`schema_draft`、`delete`）。
  - 没给 `idempotency_key`：请求键 = 调用方 + `task` + 规范化后的请求内容。
  - 给了 `idempotency_key`：请求键 = 调用方 + 该键。
  - **调用方**是连接实例；凭用户会话调用时是这个用户会话。
  - **规范化**：对调用方发来的请求体做 JCS（RFC 8785）编码，不含 `task` 与 `idempotency_key`，**不含服务端兜底补上的 `ver` / `sv` / `item_ver`**。所以隔了一次读取、原样重发的请求仍是同一个请求键。
  - **JSON 数字在规范形里的写法看通道**（第 1 节）：saveslot 自己解析请求体的通道按数字在请求体里的原文写；经宿主解析的通道拿到的是双精度数，按 JCS 的数字写法写。所以同一个请求体经 HTTP 与经 MCP 发来，规范形可能不同（`1.50` 与 `1.5`），是两个请求键；同一通道上的原样重发不受影响。
  - **例外一：前提的版本**。规范化**包含每条前提解析后的所见版本**（含兜底取得的）。"前提又变了、再核对一次、请求体逐字不变"是重申的正常用法；不含它，第二次重申会在窗口里被当成第一次的重放，返回一个过时的 `state: current`。只对前提这一处；写入目标兜底补上的 `ver` 仍不进规范化。显式幂等键不受这一条影响：它照键与请求体重放，不看前提版本，所以同一个键、请求体逐字不变地再发，即使前提在两次之间变过，返回的仍是第一次的回执；要重新核对，换一个键。
  - **例外二：只含按来源键 op 的请求不计算服务端请求键**，不论在不在窗口内，重发都逐条三方比较：来源键本身就让重发幂等，同样的内容再交一遍得到 `unchanged`。显式 `idempotency_key` 照样可用：请求产生了事件时照旧记下；请求没产生事件时不被记下，重发按来源键重新判定，结果相同。含普通 op 的请求照旧计算请求键（按原始请求体，其中按来源键 op 的内容同样在内）；连接器把按来源键的 op 与普通 op 分开请求即可。
  - 两个例外作用于不同的请求：按来源键的 op 不能带前提。
- **窗口**（服务层策略，经调用上下文交给内核，K13 不变）：**显式 `idempotency_key` 24 小时；服务端算出的请求键 10 分钟**。窗口外的同内容请求是新请求；同一件事被记了两次由来源键（同一条外部记录再交一遍是更新或无操作）与 `duplicate_keys`（两行是不是记重了）发现，不靠幂等。
- 同一显式键配不同的请求内容：`invalid_argument`（`idempotency_key_reuse`）。为此显式键另记一份请求内容指纹，指纹是内容，随证据删除（architecture K13）。
- **只对产生事件的终态结果去重**：`saved`、`pending`（以及后续的 `job`）。**被拒的写入不产生事件，也不去重**：重发时按当时的状态重新校验（例如先按 `read_first` 读过之后原样重发，会正常执行）；`rate_limited`、`unavailable` 这类暂时性错误同样不记。
- **恰好一次由内核保证**（architecture K13）：请求键随写入同一事务记下、查重；崩溃后重发也不会写两次。请求键是内容，随该写入的证据删除一起删；物理删除前已列入待删除的请求键照样命中，结果带 `original_deleted`，不重新写入（data-model「撤回与宽限期」）。
- **重放返回什么**：`replayed: true`，没有新写入。回执按日志重建：操作号、每个 op 的逐字段结果、当时得到的 `ver`、新建的行 / 实体 ID、当时生成或并入的事项 ID。按日志重建不出的部分省略并在 `omitted[]` 里列明：`affected_reads`；派生值的改前改后值（`derived_values`；此时 `derived[]` 为空，`derived_total` 按日志里这次操作的派生写入条数给，与首次回执按字段条目计的口径不同）；逐字段结果里的改前值——日志不记写入前的值，它所出自的贡献已被删除时取不回（`before_values`）；`undo` 跳过的部分的区间（`skipped_spans`）；这次写入自己的内容已被删除的部分（`deleted_content`，此时另有 `original_deleted`）；没进事件的按来源键 op（`unrecorded_ops`：这些下标只给 `op_index`，`external_key_summary` 里 `unchanged`、`skipped` 两项的计数也不给）；`existing_keys` 与 `similar_keys`（取值 `existing_keys`；两者由写入那一刻的状态算出，不进事件）。无操作字段的区间与解析结果（`resolved` 里它的那一项）首次回执和重放都不给：日志里只留了它的字段名，没有区间。警告（`warnings`）一律不给，也不列进 `omitted`：警告是写入那一刻附带的提示，不进日志，重放只还原日志里有的东西；逐字段结果里的 `merged` 由日志里的所见版本与行的版本算出，照给。不按当前状态重算这些部分：那会让同一请求的两次回执不同。`notices` 不在此列：它按重放此刻的状态算，提示讲的是现在，本来就不进日志。前提的部分（`premises`、`premise_covered`、`premise_affected`）记在元数据里，可以完整重建，标记状态是当时的。事项只给**当前状态**（未决 / 已解决附处理方式 / 已被取代），不给 `item_ver`；回执里的 `ver` 与事项都不算读到、不参与兜底。
- 窗口内真的又发生了一笔内容与证据都一字不差的写入时，调用方要带一个不同的 `idempotency_key`；否则按重发处理。
- 同一请求键的请求还在执行时，后到的等待前一个的结果，不并行执行。
- `resolve` 对已解决事项、同一处理方式的重发返回原结果；其中触发的写入（`write`）按上面写入重放的规则重建，重建不出的部分同样列在 `write.omitted[]` 里，`derived_total` 同样按派生写入条数给；同一 `dc_` 的 `delete` 重发返回原结果。

## 15. 句柄与令牌

| 句柄 | 前缀 | 性质 | 有效期 | 失效后 |
|---|---|---|---|---|
| 待处理事项 | `pi_` | 短的稳定 ID，不签名、不绑内容；内容绑定靠 `item_ver` | 不过期 | 已关闭报 `item_closed` |
| schema 草稿 | `d_` | 稳定 ID | 同其 `schema_change` 事项 | — |
| 删除确认 | `dc_` | 签名，绑定"租户 + 恢复次数 + 目标 + 影响摘要的哈希 + 预览时的操作号" | 10 分钟 | `handle_expired`，重新预览；已执行过的附删除 ID。影响范围变了报 `preview_outdated` |
| 翻页 | `cur_` | 签名，绑定查询条件 + 首页的操作号 + 恢复次数 | 1 小时 | `handle_expired`，重新查询 |
| 作业、抽取租约（后续） | `jb_`、`ls_` | 稳定 ID；签名 | 作业结束后 30 天；15 分钟 | `not_found`；`lease_expired` |

- 翻页固定在首页的操作号：翻页期间的新写入不会造成漏行、重行；换条件即失效。后续各页按首页那一刻的记录状态（与首页的求值时刻）给出行与值；标记是读取当时的（未决事项没有历史），行怎么切分不受标记影响。首页之后有恢复或导入的，后续页报 `handle_expired`（`restored`）。`history` 的 `changes` 把首页解析出的 `since` 也记在位置里。派生表没有按时刻的状态：首页之后这张派生表被刷新过，后续页报 `handle_expired`（`derived_changed`），从首页重读；没被刷新过的，读到的与首页那一刻相同。读时计算的派生表没有派生写入：位置里记着首页的操作号与求值时刻 `at`，规则所读的基础表在首页的操作号之后有了新版本，后续页报 `handle_expired`（`derived_changed`）；没有的，按同一个 `at` 重算，与首页那一刻相同。句柄绑定的是查询条件，不含 `limit`：页与页之间可以换每页条数。
- **恢复备份或导入之后**：`ver`、`item_ver`、`dc_`、`cur_` 都带租户恢复次数。恢复与导入都让恢复次数加 1，之前签发的一律对不上。**恢复点**是最近那次恢复的 `restored_to`（`tenant.restored`），或导入的 `imported_upto`（`tenant.imported`）。
  - `ver`：恢复次数**恰好比当前小 1**、且操作号不超过恢复点的，按它自己的操作号判定冲突；其余的（操作号在恢复点之后，或恢复次数更旧），以恢复点为它读到的位置，按冲突判据比较恢复点之后的写入。前提里的 `ver` 同此。
    - 理由：恢复点及以前的事件在两条时间线里逐字节相同，按原操作号判不会错，还能多查出恢复点之前的并发改动；恢复点之后的那段可能已经丢失，只能保守处理。恢复次数差 2 及以上时，中间那次恢复之前的时间线是否与现在一致无从判断，所以不放宽。
  - `item_ver` 报 `confirmation_mismatch`（`restored`）；
  - 句柄报 `handle_expired`（`restored`）。导入后句柄另因签名密钥与租户 ID 不同而失效，报的是同一个错误；
  - `pi_` 在恢复出的日志里不存在时报 `not_found`（data-model「删除之后 · 删除登记」）。
- 确认的用户与凭证记在确认记录里，不在句柄里；`dc_` 绑定的影响摘要哈希写进"删除已确认"事件的内容区，随被删内容到期删除。

## 16. 外层错误

附带字段见 types 第 9 节。

| `code` | 什么时候 |
|---|---|
| `unauthenticated` | 凭证缺失（`missing`）、无效（`invalid`）、已吊销（`revoked`）、过期（`expired`） |
| `insufficient_scope` | 凭证没有所需 scope（含 `resolve` 用了当前凭证不可用的处理方式）；连接实例调用只给用户会话的管理类操作（`required_scope: "user_session"`）；限定了 slot 范围的凭证新建 slot（`required_scope: "all_slots"`，缺 scope 时先报缺 scope；第一版里限定了 slot 范围的凭证写入范围内的表同报这一个，见 [`07-scope-v1.md`](07-scope-v1.md)） |
| `rate_limited` | 限流或配额（`quota`）；同一租户已有一次对拍或导入在跑（`busy`） |
| `handle_expired` | 签名句柄过期（`expired`）、恢复次数对不上（`restored`）、`dc_` 已经执行过而又拿它重出预览（`executed`）、翻页期间派生表被刷新过（`derived_changed`） |
| `not_in_this_version` | 调用了本版本不实现的参数、取值或操作。`reason` 说明是哪一种，附是哪个；schema 草稿里只对从未被写入的表放开的改动用在写入过的表上时，`reason` 是 `table_written` |
| `unavailable` | 暂时不能处理：写入排队或加锁超时（`busy`）、租户正在走恢复流程（`restoring`）、租户正在导入（`importing`）、对拍进入比较阶段而排队超时（`reconciling`）、服务刚启动还在补跑到期任务（`starting`）。可重试时附 `retry_after` |
| `internal` | 服务端内部错误。附 `incident`（供排查的编号，不含用户内容） |
| `import_rejected` | 导入的文件不合格：格式不认识（`unsupported_format`）、不是从头开始（`not_from_start`）、续传的几段顺序不对（`segment_order`）、事件头链断裂（`chain_broken`）、内容校验和不符（`checksum_mismatch`）、条数或末尾对不上（`incomplete`）、重放失败（`replay_failed`）。只给位置（`seq`、`path`），不回显内容 |

- **本版本不实现的东西一律报 `not_in_this_version`，不静默忽略**：本版本生成的 schema 里不出现这些参数与取值，但服务端认得完整设计里的名字，收到时给出这个明确的错误，而不是笼统的 `invalid_argument`。
- `item_closed` 与 `preview_outdated` 在第 11 节：由内核判断。签名本身过期才是这里的 `handle_expired`。

## 17. 管理类操作

契约的一部分，除 `policy.get` 外只给用户会话（连接实例调用报 `insufficient_scope`，`required_scope: "user_session"`）；不进 MCP（surfaces）。参数与结果见 types 第 8 节。

| 操作 | 做什么 |
|---|---|
| `connections.issue` | 签发连接实例：名字、scope、slot 范围（`slots`：slot 名或 `slot_id` 的数组，不给 = 全部；名字不分 ASCII 大小写，同一个 slot 列了几次只记一次；每个都必须存在且可见，否则 `not_found`（`slot`），按名字与按 ID 找不到的应答相同；空数组报 `invalid_argument`（`empty_slots`））。结果里的令牌只返回这一次，saveslot 只存它的哈希 |
| `connections.list` / `update` / `revoke` | 列出（含每个连接实例的 slot 范围；`include_revoked: true` 时已吊销与已停用的都列出）、改名、吊销。`update` 只能改名；吊销立即生效，重复吊销返回同一结果：吊销已吊销或已停用的连接实例不记事件，返回它的当前状态（已停用的仍是 `disabled`）。签发、改名、吊销都记为日志事件 |
| `slots.remove` | 移除一个空的 slot。**只收 `slot_id`，不收名字**（`invalid_argument`，`param: "slot_id"`）：名字在 slot 移除后可以重用，按名字的移除一旦重发，会删掉后来同名新建的那个 slot；CLI 先把名字解析成 `slot_id`、在确认屏上显示，再按 ID 发。"空"按日志判：这个 slot 名下除结构（`schema.*`）与策略（`slot.policy_set`）外没有任何事件（结构变更事项的 `item.*` 也不算），在同一个写事务里判定并记下 `slot.removed`；不空报 `invalid_argument`（`slot_not_empty`）；判据与各事件类型的归类见 [`../process/decisions/remove-empty-slot.md`](../process/decisions/remove-empty-slot.md)，与表级的"从未被写入"并排见 data-model「schema 演进」。结构变更事项还开着时同样报 `slot_not_empty`，`details` 带原因与事项 ID。不存在的 `slot_id` 报 `not_found`（`slot`）。不收 `Idempotency-Key`：已移除的 slot 再移除一次，返回第一次的结果、不记事件。移除之后：名字可以重用，用同一个名字新建的是另一个 slot（另一个 `slot_id`），连接实例的 slot 范围、读取记录不会指到它；范围只剩已移除 slot 的连接实例什么都看不到（范围为空不等于不限 slot），`connections.list` 里它的 `slots` 是空数组；读取记录照旧保留，列出时查不到名字的写原始 `slot_id`，按名字过滤一个已移除的 slot 报 `not_found` |
| `policy.get` | slot 策略：策略版本（`policy_version`）、冲突期间的生效值规则（`effective_value_rule`）、来源级别的秩表（第一版只记不用）、哪些 schema 改动自动生效。任何有 `saveslot.read` 的凭证可调用；slot 须在它的可见范围内，否则 `not_found`（`slot`） |
| `policy.set`（后续） | 修改 slot 策略 |
| `reads.list` | 读取审计：哪个连接实例在什么时候读了哪些数据（含对源数据原文的读取）。只给版本，不给值；每条带 `task`；结果写明读取记录保留到哪一刻（没有清理时是租户创建的时刻）。`since` 含、`until` 不含；`slot` 不存在报 `not_found`（`slot`），`table` 不存在报 `unknown_table`（同别处按名字指表：带 `name` 与 `nearest`，给的是 `slot.table` 就列带 slot 的名字，只给表名就列表名）。一次读取在某张表上读到的行版本数超过阈值（初值 1,000，多见于受限 SQL 的聚合）时，这张表不逐行列，列在 `coarse` 里：只有表与这次读取所见状态的位置（data-model「读取记录」） |
| `log.verify` | 校验日志：事件总数、事件头链完整与否（或自哪一条起断裂）、内容校验和不符的位置、索引列与事件头不符的位置（不算断裂）、已按删除移除的数量、恢复留下的序号空档（不算断裂） |
| `log.end` | 日志末端：最新一条事件的 `seq` 与记录时刻（日志为空时为 null）。只读、不带参数；`saveslot status` 用它对照本机时钟 |
| `log.reconcile` | 对拍：把日志从空存储重放到一份临时存储，与线上的逻辑表逐表比较（范围见 architecture §11）。同步返回，日志大时耗时长；只有最后的比较阶段让该租户的写入排队。同一租户同时只跑一个，再次调用报 `rate_limited`（`busy`）。结果只给表 / 行 / 字段的 ID，不回显值。**它查不出 `delete` 自己算错的结果**（architecture §11「记录与重算一致」） |
| `export` | 导出全部日志事件，NDJSON：第一行是清单，之后每行一条事件，形状以 [`09-event-format.md`](09-event-format.md) 第 8 节为准，可在任何后端经 `apply` 重放。宽限期内待删除的内容默认换成占位，`include_pending_deletion: true` 才包含；`after_seq` 从某个位置之后续传（清单里记为 `after`）。读取记录不在导出里 |
| `import` | 导入到空租户：把一份导出装进一个空租户（日志里只有创世事件，锚点里没有删除登记、恢复记录与进行中的恢复或导入）。逐事件原样追加并交给 `apply` 重放，追加一条 `tenant.imported`，恢复次数加 1；导入前登记的主体一律停用（第 12 节），凭证由用户在目标处重新签发。整体要么完成、要么目标租户保持为空；期间这个租户的其他请求报 `unavailable`（`importing`）。导出里待删除内容的占位在导入时立即补墓碑，那些删除在目标处不可撤回。读取记录、控制面的内容（凭证、授权、签名密钥、源头的删除登记）、外部文件带不过来，结果如实列出。错误：`invalid_argument`（`tenant_not_empty`）、`import_rejected`、`rate_limited`（`busy`）、`too_large`。合并导入、迁移流程不在第一版 |

有记录的 slot 整个删除第一版不做（positioning「后续规划」）；空的 slot 用 `slots.remove` 移除。
