# saveslot · 事件格式 v1

[English](../../spec/09-event-format.md) · 简体中文

> 日志里每种事件的字段级定义。实现 `log` 与 `apply` 以本文为准；它也是导出文件的格式说明：不依赖 saveslot 的代码，只凭本文应当能读懂一份导出的日志。
> 规则本身（什么时候产生哪种事件、判定怎么做）在 [`03-data-model/`](03-data-model/README.md)；分层与不变量在 [`02-architecture.md`](02-architecture.md)。本文只定义"事件里写什么、怎么写"。
> **冻结规则**：本文自第一次对外发布起冻结，此后只增不改（§1.6）；冻结之前开发过程中产生的日志不承诺兼容（[`07-scope-v1.md`](07-scope-v1.md)「事件格式的冻结点」）。之后新出现的待定项登记在 [`08-open-questions.md`](08-open-questions.md)。

## 1. 范围与约定

### 1.1 事件由什么组成

一个租户一条只追加的日志。日志里的每一条是一个**事件**，由两部分组成：

| 部分 | 是什么 | 能删吗 | 进链吗 |
|---|---|---|---|
| **事件头** | 一个 JSON 对象。说明这是第几条、什么类型、谁做的、什么时候、属于哪次操作 | 永不删改 | 是 |
| **内容块** | 零个或多个，每块是一个 JSON 值，按 `(seq, path)` 寻址，各带一个校验和 | 只有墓碑事件落账时可以整块清空 | 否 |

- 事件头里**不出现任何用户内容，也不出现任何由用户内容算出的值**（判定方法见 §2.3）。
- 内容块分两种：**元数据块**（只含不透明 ID、枚举、序号与下标、版本号、布尔值、入口时刻与由它得出的日期和到期时刻、导出时刻、客户端软件的标识，第一版不会被删除）与**数据块**（含用户内容或由它算出的值，记来源，在删除级联范围内）。§5 每个事件的词表里标了每个 path 属于哪种。

### 1.2 编码

| 项 | 规定 |
|---|---|
| 事件头、内容块 | JSON，按 **RFC 8785（JCS）** 序列化为 UTF-8 字节。JCS 字节是权威形式；存储里拆出的索引列只是索引，`verify` 核对它们与权威形式一致 |
| 缺省字段 | 不编码。没有值的可选字段不出现在对象里，不写 `null`。新增可选字段因此不改变旧事件的字节 |
| 整数 | `seq`、下标、版本号、计数用 JSON 数字，取值范围 0 至 2^53 − 1 |
| 十进制数 | **一律写成字符串**（`"45"`、`"5.5"`），不用 JSON 数字。金额、数量、`decimal` 字段、`min` / `max` 都是。由 saveslot 求出或换算后的值用**规范形** `-?(0\|[1-9][0-9]*)(\.[0-9]*[1-9])?`：不带指数与正号，整数部分无前导零，小数部分无尾随零，零写 `"0"`（没有 `-0`），按 `scale` 舍入之后再写成这个形状。同值的两个数因此只有一种字节。调用方交来的原始值不规范化（§1.3） |
| 时刻 | 字符串，UTC，固定毫秒精度：`2026-11-10T04:41:07.123Z` |
| 日期 | 字符串 `YYYY-MM-DD` |
| 业务时间区间 | 对象 `{"from": <点>, "to": <点>}`，左闭右开；缺省的一端是开口：`to` 缺省表示一直延续，`from` 缺省表示起点开口，两端都缺省的 `{}` 是整段时间。起点开口与整段时间只出现在"存在"上——贡献的解析区间（§5.7 `span/existence/…`）、"存在"的事项条目（§5.8 `current/<k>` 等），例如回掉一次整体撤销的写回项，或整段时间上的写回被别的项切开时——以及 `scope_valid` 的第一段里（只有第一段可以缺省 `from`，整段时间写成 `[{}]`）。字段的区间与调用方给的区间总有 `from`。点的写法随表的粒度：`date` 粒度用日期，`instant` 粒度用时刻 |
| 布尔、枚举 | JSON 布尔；枚举用小写 snake_case 字符串 |
| 字段值 | 见 §1.3 |
| 哈希、校验和 | 64 位小写十六进制字符串 |

### 1.3 字段值的写法

事件里凡是"某个字段的值"，按字段类型写成：

| 字段类型 | 写法 | 例 |
|---|---|---|
| `text`、`enum` | 字符串 | `"餐饮"` |
| `integer` | 十进制字符串 | `"3"` |
| `decimal` | 十进制字符串 | `"5.5"` |
| `boolean` | 布尔 | `true` |
| `date` | 日期字符串 | `"2026-11-10"` |
| `zoned_datetime` | `{"instant": <时刻>, "zone": <IANA 时区名>}` | `{"instant":"2026-11-10T04:31:00.000Z","zone":"Asia/Shanghai"}` |
| `quantity` | `{"value": <十进制字符串>, "unit": <单位代码>}`，已换算到字段声明的单位，精度与舍入按编译后的定义（§7） | `{"value":"54","unit":"CNY"}` |
| `ref` | 被引用的行或实体的 ID | `"r_01JC8Z…"` |
| 空值（可选字段显式置空） | `null` | `null` |

"原始值"指调用方交来、未经换算的值，形状相同，单位是调用方给的那个；十进制按调用方的原文记（调用方给的是 JSON 数字时，记它在请求里的数字文本），不改写成规范形，字面命中比的就是它。十进制原文（`decimal`、`integer` 的值，`quantity` 的 `value`）的语法见 [`04-contract.md`](04-contract.md) 第 1 节「值的编码」：字符串与 JSON 数字同一套 JSON 数字语法，不合语法的在写入时报 `validation_failed`（`malformed`），进不了事件。除原始值外，事件里的十进制值都是 §1.2 的规范形，`integer` 同样（没有小数部分）。原始值出现在两处：`write.head` 的 `ops/<i>/set/<字段ID>` 块；以及没带证据的写入为每个进了事件的 op 存下的 `api_call` 源数据的 `request` 块（那一个 op 的请求 JSON，§5.6）。

### 1.4 标识

事件里的标识都是不透明字符串，由 saveslot 分配，不含可读名称。

| 标识 | 形状 | 说明 |
|---|---|---|
| `seq` | 整数 | 事件在日志里的位置，从 1 起 |
| 操作号 | 整数 | 一次操作的头事件的 `seq`（§4.1） |
| `tn_…` | 租户 ID | 全局唯一 |
| `u_…`、`ci_…`；固定值 `system` | 主体 ID：用户、连接实例、内核自身 | 全局唯一 |
| `n_…` | 节点 ID（`node_id`） | 全局唯一；见 §2.2 |
| `sl_…` | slot ID | 租户内唯一 |
| `t1`、`f2`、`r1` | 表 ID（租户内唯一）、字段 ID（表内唯一）、规则 ID（租户内唯一） | 递增的短 ID，删掉的不复用；数字部分从 1 起、无前导零、至多 9 位 |
| `r_…` | 行 ID（UUIDv7） | 事件类表、无时间表 |
| `e_…` | 实体 ID（UUIDv7） | 状态类表 |
| `p_…` | 派生行的 `partition_id` | |
| 源数据 | 用产生它的 `source.recorded` 事件的 `seq` 引用；对外的 `s_…` ID 记在该事件里 | |
| `pi_…` | 待处理事项 ID；删除 ID 与它是同一个 | |
| `d_…`、`m_…` | schema 草稿 ID、迁移 ID | |
| `rs_…` | 一次恢复的 ID（`restore_id`） | |

各前缀的位数与生成方式见 [`03-data-model/01-objects.md`](03-data-model/01-objects.md)「标识的写法」；例子里的 ID 用 `…` 缩写。

### 1.5 链与校验和

- **事件头哈希** = SHA-256（事件头的 JCS 字节）。
- 事件头的 `prev_hash` = 上一条事件的事件头哈希。第一条事件（租户创世）的 `prev_hash` 是 64 个 `0`。
- **内容块校验和** = SHA-256（该块 JSON 值的 JCS 字节）。它和内容存在一起，随内容一起清空；**事件头里不放任何内容块的校验和**。
- 校验和只用于发现存储损坏。它不是对内容的承诺：块被删除后不留任何由它算出的值，事后无从证明、也无从比对"这里原来是什么"。
- 哈希与校验和由应用层计算，不依赖数据库函数。

### 1.6 版本与演进

- 每个事件头带 `v`：**该事件类型的格式版本**，从 1 起。
- **只增不改**：已有类型的已有字段、已有 path 的含义与形状不变。可以做的改动只有五种：新增事件类型；给已有类型新增可选的事件头字段；给已有类型新增 path；给已有的块新增可选键；给枚举新增取值。**规则只有一条：凡是带了旧内核不认识的形状的事件，必须带更高的 `v`。** 用到新事件头字段、新 path、新键或新枚举值的事件，该事件类型的 `v` 加一；没用到这些的事件照旧写原来的 `v`，旧事件的字节不变。新旧版本的事件并存于同一条日志。新增事件类型从 `v` = 1 起。
- **新内核必须能重放所有旧版本的事件。**
- **旧内核遇到不认识的事件类型或不认识的 `v`，停止 `apply` 并报错，不跳过。** 没有"忽略未知键"这条路径：在认识的 `v` 之下，事件头字段、path、块里的键、枚举值都是已知的全集，出现全集之外的东西说明事件不合法，同样停止（它可能改变事件的含义）。`apply` 按严格模式解析。
- **版本串同样不认识就停**：`compiled.compiler`、`compiled.rsql`、`rule.rsql`、`ctx.ruleset_version`、`ctx.literal_checker`，以及之后同类的版本串（规则、白名单、核对器、编译器的版本），取到内核不认识的值时，`apply` 停止并报错。内核不能按那个版本求值或重算的情形，一律不降级成按别的版本算：事件的 `v` 认得，不代表里面记的判定版本认得。

---

## 2. 通用事件头

### 2.1 字段

| 字段 | 类型 | 出现在 | 含义 |
|---|---|---|---|
| `seq` | 整数 | 所有事件 | 日志位置 |
| `v` | 整数 | 所有事件 | 该事件类型的格式版本 |
| `type` | 字符串 | 所有事件 | 事件类型（§6.1） |
| `actor` | 字符串 | 所有事件 | 做这件事的主体 ID；必须已在本租户登记（`tenant.genesis`、`tenant.imported` 的 `actor` 由该事件自己登记）。内核自己产生的事件是 `system` |
| `at` | 时刻 | 所有事件 | 记录时刻。取 max（调用上下文的 `now`，上一条事件的 `at`）；同一次操作的全部事件 `at` 相同。先后顺序以 `seq` 为准，`at` 只保证不倒退 |
| `prev_hash` | 哈希 | 所有事件 | 上一条事件的事件头哈希 |
| `op` | 整数 | 操作里头事件以外的事件 | 所属操作的操作号（头事件的 `seq`）。**没有 `op` 的事件就是一次操作的头事件** |
| `slot` | slot ID | 属于某个 slot 的事件 | 租户级事件（创世、恢复、导入、主体）没有 |
| `trigger` | 枚举（§6.9） | `actor` 为 `system` 的头事件 | 由哪个后台任务或流程触发 |
| `node_id` | 字符串 | 只有 `tenant.genesis`、`tenant.restored`、`tenant.imported` | 见 §2.2 |
| `restore_count` | 整数 | 只有 `tenant.restored`、`tenant.imported` | 见 §5.2 |
| `restore_id`、`restored_to`、`high_water` | 字符串、整数、整数 | 只有 `tenant.restored` | 见 §5.2 |
| `imported_upto` | 整数 | 只有 `tenant.imported` | 见 §5.2 |

除此之外，事件头没有别的字段。表、行、意图、被引用的事件等都在内容块里：定位与意图在元数据块 `target`，调用上下文在 `ctx`；对别的事件的引用分布在 `target`（`origin_event`、`by_event`）、`revert`、`take`、`valid_sources`、`op_sources`、`positions`、写入头的 `ops/<i>/baseline`、`ops/<i>/premises/<j>`、`ops/<i>/premise_covers`、`premise.changed` 的 `targets/<k>` 以及各块的 `sources`、`deps` 里。

例（一次纠错写入里的基础写入事件的事件头）：

```json
{"actor":"ci_7HQ2…","at":"2026-11-10T04:41:07.123Z","op":25,"prev_hash":"9f2c…e1","seq":27,"slot":"sl_4KTZ…","type":"write.base","v":1}
```

### 2.2 事件的身份

第一版的事件头**没有** `event_id`。约定：

> 一条事件的身份 =（它之前最近一条 `tenant.genesis`、`tenant.restored` 或 `tenant.imported` 事件的 `node_id`，它自己的 `seq`）。`tenant.genesis`、`tenant.restored`、`tenant.imported` 自己的身份用它们自己的 `node_id`。

- `tenant.genesis` 的 `node_id` 在建租户时随机生成。
- 每次恢复换一个新的 `node_id`。恢复后 `seq` 从高水位之后接着编，但两次推进高水位之间分配过的 `seq` 可能被再用一次；换 `node_id` 保证丢失的那段时间线上的事件与恢复后的新事件不会同名。
- 每次导入换一个新的 `node_id`。导入的事件原样保留源头的 `seq`，导入之后在目标处产生的事件，与源头在导出之后继续产生的事件，`seq` 会相同；换 `node_id` 保证两者不同名。

### 2.3 "不含用户内容"的判定方法

一个值能不能放进事件头，按下面的顺序判断，任何一条不满足就只能放内容块：

1. 它是 saveslot 分配的不透明标识、固定枚举、序号、版本号、或记录时刻之一。
2. 把这个租户的全部用户输入（原话、字段值、名称、调用方自报的标识、调用方给的时间）换成别的，它不变。
3. 它不是任何内容的哈希、校验和、长度或计数。

按这三条，下面这些都**不能**放事件头：请求键、显式幂等键与内容指纹、分组键值、来源键的值、任何内容的哈希、业务时间区间（起止点是用户说的；前提声明里的业务时间同样）、字段值、表名与字段名、连接实例的名称、任务标识 `task`、调用方给的 `stated_at`。

---

## 3. 内容块

### 3.1 寻址

每个内容块的地址是 `(seq, path)`：所在事件的 `seq` 加一个 `path`。

`path` 的语法：

- 一段或多段，用 `/` 连接，全部是 ASCII。
- 每一段只能是三种之一：**该事件类型的固定词**（小写字母与下划线，如 `fields`、`text`、`target`）、**不透明 ID**（字段 ID、表 ID）、**十进制下标**（从 0 起，无前导零）。
- `path` 里不出现用户内容或由它算出的值。因此地址可以写进墓碑、删除事件的位置列表、日志之外的删除登记和导出占位。

每种事件类型有哪些 path、每个 path 的 JSON 形状，在 §5 逐个列出。词表随事件格式版本只增不改。

### 3.2 删除一个块

- **块是删除的最小单位，整块清空，没有块内的部分删除。** 需要按字段、按条目删除的内容，在词表里就切成了每字段每项一块（值、来源、字面命中、区间各一块）、每条目一块。
- 只有 `deletion.executed`（墓碑）事件能清空内容块；`apply` 处理墓碑时，把它列出的每个块的内容与校验和清空，并记下墓碑的 `seq`。
- 清空后的块仍占着地址，状态是"已由 #n 移除"（n 是墓碑的 `seq`）。标记里没有内容，也没有原内容的校验和或长度。
- 重放时 `apply` 遇到"已由 #n 移除"的块，按该块不存在处理。重放到早于墓碑的事件时不需要往后看。

### 3.3 一个块的三种状态

| 状态 | 存储里 | 导出文件里（§8） |
|---|---|---|
| 在 | 内容 + 校验和 | `{"v": <内容>, "sum": <校验和>}` |
| 已移除 | 内容与校验和为空，`removed_by` = 墓碑的 `seq` | `{"removed_by": <墓碑的 seq>}` |
| 待删除（宽限期内，默认不导出） | 内容 + 校验和（仍在存储里，只是读不到） | `{"pending_deletion": <删除已确认事件的 seq>}`。同一块被两次待执行的删除列入时，写最早的那一次 |

没有移除标记却找不到内容，或内容与校验和不符，`verify` 报"不符"；"已移除"单独报，不算不符。

### 3.4 来源与级联

每个数据块在 §5 的词表里写明两件事：

- **来源**：它依赖哪些源数据。写法有三种：直接依赖某些 `source.recorded` 事件；依赖"某次写入对某个字段的贡献"（即另一个事件的 `fields/<字段ID>/<k>` 块，沿它继续追）；依赖本事件里的另一个块。
- **删除时**：隐私删除级联到它的来源时，它被列进那次删除的位置列表，到期清空。

元数据块没有来源，第一版不会被任何删除列入位置列表。

### 3.5 求得的内容单独成块，带 `deps`

**一个数据块里只放本次请求自己带来的内容**（调用方这次给的值、这次给的区间端点）。凡是由**别的贡献**求得或抄来的内容，放在单独的数据块里，块上带 `deps`，指明内容出自哪些贡献：

```json
"deps": [{"event": 15, "field": "f2", "k": 0}, {"event": 22, "existence": 0}]
```

`deps` 的每一项指向一条 `write.base` 事件的一项贡献：某个字段的第 `k` 项，或它对"存在"的第 `k` 项贡献（`"existence": <k>`）。schema 切换时 `backfill` 补出的值（§5.5）不是 `write.base` 的贡献，**常量本身不进 `deps`，也不用 `carried` 引用**：它的值出自 schema 里写的常量，不随删除清除，抄一份不产生删不到的用户内容。块里的值出自它时，来源写成 `schema_const` 条目（§5.7）。但**状态类表补值段的区间来自别的贡献**：块里的区间端点或一段的范围出自一段补值段（`backfill/<表ID>/<字段ID>/<n>`）时，把那一块的 `deps` 抄进本块的 `deps`。

区间端点停在一个挡点上时，"给出挡点的贡献"按 [`03-data-model/05-time.md`](03-data-model/05-time.md)「状态类表的状态」的定义取：该时刻是其区间端点的全部贡献（这个字段与"存在"上的；该时刻是有值 ↔ 无值的边界时，另含算"有值"的字段上的），两侧都算，已被盖住的也算；只算排在被解析的那次写入之前、生效的贡献（候选与待确认不算），区间取当前状态里的（删除重放时是本次重放里的），含留下相邻空洞的撤销、佐证端点所属的佐证项。

这类块有：

| 块 | 求得或抄来的是什么 |
|---|---|
| `write.base` 的 `span/…`（§5.7） | 一项贡献解析后的区间：默认终点、`corrected_span` 停在别的贡献给出的挡点上；回退、回到合并基写回的各项，区间抄自被回掉的写入与搬运来的各段；过期 `ver` 的写入被期间的写入切成几项 |
| `write.base` 的 `ack/<j>`、`duplicate` | 被覆盖、被比中的贡献的区间与值；被覆盖的一段原来没有值时（`ack/<j>` 的 `no_value`），是给出它两端的贡献与它所在的撤销 |
| `schema.switched` 的 `backfill/<表ID>/<字段ID>/<n>`（§5.5；状态类表，事件类表与无时间表的 `backfill_rows/*` 是元数据块，不在此列） | 状态类表上常量补值的区间：由别的贡献定下的、实体存在而该字段为空或有值而违反新约束的段 |
| `write.head` 的 `ops/<i>/premise_valid/<j>`（§5.7） | 前提声明的范围取自依赖行的业务时间、而那个时间值出自别的贡献时，解析出的点或区间 |
| 事项的条目块与 `scope_valid`（§5.8） | 别的写入的值与区间 |
| 删除事件的 `results/…`、`restated/<k>`（§5.9） | 删除后的各段、被重述的贡献 |

规则只有两条：

1. **`deps` 里任何一项被隐私删除，或被某次删除重述（§5.9，无论重述成什么结果），这个块就列入那次删除的位置列表。** 一次删除列哪些块与其他待执行的删除无关：「被这次删除重述」按只有这一次删除（加上已执行的删除）的重放判，不按事件里 `restated/<k>` 的口径——§5.9 的 `restated` 是带着其他待执行的删除算的，别的待执行删除已经重述过同一项时，这次删除的事件里不再重述它，它的块却仍要列入；「被隐私删除」也只看这次删除自己去掉的贡献。这样撤回其中一项删除，另一项的位置列表不用变。列的是那次删除之前的事件给出的块：删除事件自己给出的块（`restated/<k>`、`results/…`）不列入它自己的位置列表——它们就是这次删除之后的结果，`deps` 指向同一事件里另一个被重述的项（重述为 `dropped` 的影子、被回退写回的项等）也一样；之后的删除照本条判它们。判"被隐私删除"按（事件, 字段或"存在"）认，不按下标：同一条事件在同一个目标上的各项来源相同，总是一起被删，而下标会随删除重编（§5.7）。 唯一的例外是 `schema.switched` 的 `backfill/<表ID>/<字段ID>/<n>`：它只在 `deps` 里有一项**被隐私删除**时列入，被重述不列入（补值位置照记录，删除不重述它）；它的 `deps` 按上面"给出挡点的贡献"的口径取两端（§5.5），端点日期最初出自的那次写入一定在内，所以不会因此漏删。带区间的块（`span/…`、`results/…/fields/…`、带 `value` 的 `restated/<k>`）里，值来源的搬运引用 `carried`（§5.7）指向的那一项**一律同时列进 `deps`**，所以这类块只需要看 `deps`。不带区间的 `sources/<字段ID>/<k>` 没有 `deps`：它的 `carried` 指向的项被删除、或被重述为 `dropped` 时，它连同同一项的 `fields` 列入位置列表（搬运项没有 `literal` 块）。
2. **被清掉、而 `apply` 之后仍需要的结果（含已不是贡献的项（`dropped`）），由那次删除事件重新给出**（`restated/<k>`、`results/…`，事项条目由随后的 `item.refreshed`）。**一项贡献的判定结果以日志里最近一次给出它的事件为准。**

这样，日志里由某个贡献求得的内容，在这个贡献被删除时都找得到、删得掉；删除事件自己的块同样带 `deps`，后来的删除照此清掉它们。

---

## 4. 一次操作的事件构成与顺序

### 4.1 操作与操作号

**一次操作** = 调用方的一次请求（或内核的一次后台动作）在一个事务里追加的全部事件。它们的 `seq` 连续。

- 第一条是**头事件**：没有 `op` 字段。它的 `seq` 是这次操作的**操作号**。
- 其余事件带 `op` = 操作号。
- 同一次操作的事件 `actor`、`at` 相同。

**对外的序号一律是操作号**：写入回执的 `seq`、`ver` 里的序号、`history` 时间线的 #n、`revert: {undo: n}` 的 n、`as_of`、`changes` 的 `since` / `until`、版本表的记录时间区间、事项版本里的序号。操作内部各事件自己的 `seq` 只用于内容块寻址与事件之间的引用，不对外。

按记录位置读（`as_of: S`）时，操作号不大于 S 的操作整体可见，其余整体不可见；S 落在一次操作中间等同于落在它的操作号上。

哪些事件类型可以做头事件：

| 头事件 | 操作 |
|---|---|
| `write.head` | 一次 `write` 请求 |
| `item.resolved` | 一次 `resolve`（删除的撤回除外） |
| `deletion.confirmed` | 确认一次删除 |
| `deletion.cancelled` | 撤回一次删除 |
| `deletion.executed` | 到期物理删除；导入时为占位的待删除项补的墓碑 |
| `schema.draft_submitted` | 提交一份 schema 草稿 |
| `schema.switched`、`schema.migration_failed` | 后台迁移走到切换或失败 |
| `slot.policy_set` | 改 slot 策略（建 slot 时的初始策略属于 `schema.draft_submitted` 的操作）。**作头事件是保留的形状，第一版不产生**：第一版里它只作为建 slot 那次操作的一员出现 |
| `principal.registered`、`principal.renamed`、`principal.revoked` | 主体管理 |
| `tenant.genesis`、`tenant.restored`、`tenant.imported` | 建租户、恢复、导入到空租户 |

`premise.changed`（§5.10）不是头事件：它只作为写入、解决、删除确认、撤回删除、schema 切换（新版删除了前提声明所声明的字段时）这几种操作的一员出现。

带元数据块 `ctx`（§5.1）的头事件：**调用方发起的全部头事件**（`write.head`、`item.resolved`、`deletion.confirmed`、`deletion.cancelled`、`schema.draft_submitted`、三种 `principal.*`；将来作头事件的 `slot.policy_set` 也带），以及 `system` 产生的 `deletion.confirmed`、`deletion.cancelled`、`principal.revoked`。其余由系统生成的头事件（`tenant.genesis`、`tenant.restored`、`deletion.executed`、`schema.switched`、`schema.migration_failed`）不带。`tenant.imported` 虽由用户会话发起，但它与创世事件一样是建立租户状态的事件，不做判定、没有 slot，也不带。带了请求键的另有 `request_key` 块。

### 4.2 写入

**进了事件的 op**：`write.head` 里有它的 `ops/<i>/target` 的 op。普通 op 一律进事件，全部字段都是无操作的、只改前提的（重申、清除）也进。按来源键定位的 op 只在它留下了东西时进事件：新增了一行，或命中已有行且至少一个字段不是无操作；结果是 `unchanged`（全部字段无操作）或 `skipped`（被跳过）的按来源键 op 不进任何事件，只出现在回执里（[`03-data-model/04-write-and-read.md`](03-data-model/04-write-and-read.md)「按来源键写入」）。

一次 `write` 请求追加的事件，按这个顺序：

1. `write.head`：一条。
2. `source.recorded`：每段新证据一条，按证据在请求里的先后（先请求级、再各 op 的内联段）。没带证据时，**每个进了事件的 op 一条 `api_call`**：请求级证据与内联证据都没有的 op 才产生；没进事件的 op 不存。一次请求里有的 op 带证据、有的不带时，`api_call` 排在全部证据段之后，按 op 在请求里的顺序。`source_ref` 不产生事件。
3. 逐个进了事件的 op，按请求里的顺序：
   - `write.base`：这个 op 作用的行或实体一条（一个 op 只作用于一行或一个实体；回退连带改动多行时每行一条）。无操作的字段不进 `write.base`；这个 op 的全部字段都是无操作时不产生，只改前提的 op（重申、清除）也不产生。
   - 这个 op 开出或并入的事项：`item.created`、`item.merged`（条目按整次请求结束时的状态，见第 4 步）。
4. 已有事项的刷新与取代：全部 op 的事件之后，`item.refreshed`、`item.superseded`，每个事项至多一条（§5.8「一次请求里的事项内容」）。
5. `premise.changed`：全部 op 与事项事件之后，至多一条，只在这次操作让某些前提声明变了状态时有（§5.10）。
6. `write.derived`：按派生依赖的拓扑序、同一规则内按 `partition_id` 的字典序，每个结果有变化的派生行一条。

**一个请求里没有任何 op 进事件**（全部是按来源键的 `unchanged` / `skipped`）时，这次请求**不追加任何事件**：没有 `write.head`、没有源数据、没有请求键，也没有操作号；回执照给。

例：第一步"今天午饭花了 45 元"（与 [`../guide/02-walkthrough.md`](../guide/02-walkthrough.md) 是同一本账、同一套序号）。

| `seq` | `type` | `op` | 说明 |
|---|---|---|---|
| 21 | `write.head` | — | 头事件，操作号 21 |
| 22 | `source.recorded` | 21 | 原话，对外 ID `s_1` |
| 23 | `write.base` | 21 | 新增午饭那一行 |
| 24 | `write.derived` | 21 | 2026-11 的月合计 |

回执里 `seq: 21`，这一行的 `ver: "v21.0"`。

例：带过期 `ver` 的写入成为冲突候选。

| `seq` | `type` | `op` | 说明 |
|---|---|---|---|
| 37 | `write.head` | — | 操作号 37 |
| 38 | `source.recorded` | 37 | "打车是 32 元" |
| 39 | `write.base` | 37 | `fields/f3/0` 的 `status` 是 `candidate` |
| 40 | `item.created` | 37 | 冲突事项 |

生效值没变，没有 `write.derived`；这一行的 `ver` 不变。

### 4.3 解决事项

`resolve` 追加的事件：

1. `item.resolved`：头事件。
2. `source.recorded`：解决请求带的证据每段一条；带了 `note`、或处理会触发写入而又没带证据时，另有一条 `api_call`（请求本身，含 `note`）。既没带证据、也没带 `note`、又不触发写入时不产生。`item.resolved` 以操作来源引用它们（`op_sources`）。
3. 处理触发的 `write.base`（采纳候选、确认提议、回到合并基、撤销被标记的行），以及由它引出的事项事件。
4. `premise.changed`：至多一条，规则同写入（§5.10）。
5. `write.derived`。

处理 `schema_change` 事项时，`item.resolved` 之后是 `schema.confirmed` 或 `schema.rejected`，见 §4.5。

例：`take_candidate`，采纳上例的 32。

| `seq` | `type` | `op` | 说明 |
|---|---|---|---|
| 41 | `item.resolved` | — | 操作号 41 |
| 42 | `source.recorded` | 41 | `api_call`：解决请求本身 |
| 43 | `write.base` | 41 | 金额 32，值来源是对 #39 那次贡献的引用，#42 是操作来源 |
| 44 | `write.derived` | 41 | 月合计 |

### 4.4 删除

**确认**：

1. `deletion.confirmed`：头事件，写全算好的结果。
2. 因删除而转为待确认的写入各引出一条 `item.created`；因删除被取代的事项各一条 `item.superseded`；内容条目被清掉而仍未决的事项各一条 `item.refreshed`。
3. `premise.changed`：至多一条（§5.10）。
4. `write.derived`：受影响的行在删除前、删除后所落的**每个**派生分区各一条，**结果没变也追加**（写入里"结果没变的不记"对删除确认不成立）。墓碑落账之后从头重放时，被删内容在中间各事件处已经不在，派生分区一路算出的是另一组中间值；这些派生写入是把它拉回线上结果的唯一一处。

**撤回**：`deletion.cancelled`（头）→ 事项事件 → `premise.changed`（至多一条）→ `write.derived`，形状与确认对称：撤回同样为受影响的行所落的每个派生分区各追加一条 `write.derived`，结果没变也追加。

**到期**：`deletion.executed`（头，墓碑），只这一条。它不改变当前业务状态。导入时为占位的待删除项补的墓碑（§5.2 `tenant.imported`）也是这样一条。

例：删掉纠错那句话（午饭金额回到 45）。

| `seq` | `type` | `op` | `actor` | 说明 |
|---|---|---|---|---|
| 42 | `deletion.confirmed` | — | 连接实例 A | 操作号 42（接讲解里"保持 35"的那次解决 #41；§4.3 的例子是另一条分支——采纳候选，占用 #41–#44——两个例子不同时成立）；午饭那一行的新 `ver` 是 `v42.0` |
| 43 | `write.derived` | 42 | 连接实例 A | 月合计 |
| 44 | `deletion.executed` | — | `system` | 24 小时后（宽限期在 2026-11-11T05:02:11Z 到期，这期间这个租户没有别的操作，所以紧接着就是它）；`trigger: "deletion_expiry"` |

### 4.5 schema

**提交草稿**（建 slot 或改结构），编译不通过是报错，不产生任何事件。编译通过后：

1. `schema.draft_submitted`：头事件。
2. `schema.superseded`：这个 slot 有一份尚未确认的旧草稿时，一条（连同旧草稿的 `schema_change` 事项的 `item.superseded`）。
3. `schema.compiled`。
4. 之后分两种：
   - 自动生效（新建 slot，或按 slot 策略可自动生效）：`schema.confirmed` → 建 slot 时一条 `slot.policy_set`（初始策略）→ **不需要重建任何物理表**（`rebuilt_tables` 为空：只改目录的变更）或建 slot 时直接 `schema.switched`（其后至多一条 `premise.changed`，见本节末），否则 `schema.migration_started`。判据是物理形状变没变，与改动类别无关：加一个可选字段属于"只改元数据"类别，但要重建物理表，走 `schema.migration_started`。**新增一张表不算重建**：新表是空的，没有旧写入要转换，建表在切换的事务里完成，直接 `schema.switched`（`rebuilt_tables` 为空）。**从未被写入的表改结构同理**：这张表换一张新的物理表（编译后定义里的 `physical.since` 是本版），但日志里没有以它为目标的 `write.base`，没有旧写入要转换，同样在切换的事务里建表、直接 `schema.switched`，不列入 `rebuilt_tables`。
   - 待确认：`item.created`（`schema_change` 事项）。

**确认或拒绝**（`resolve`）：`item.resolved`（头）→ `schema.confirmed` 或 `schema.rejected` → 确认时接着是 `schema.switched`（不需要重建物理表；其后至多一条 `premise.changed`，见本节末）或 `schema.migration_started`。草稿里凡按"从未被写入"编译的改动（`class` 因此记 `metadata`、可以不给 `migrate` 的那些），所在的表在确认时已被写入的，`resolve` 一律被拒（`draft_outdated`，`table_written`），不产生任何事件，事项保持未决。确认时不按写入过的表重新编译：`schema.compiled` 里记下的、确认方看到的判定就是要执行的判定。

**后台迁移结束**：`schema.switched`（头，`actor: "system"`，`trigger: "migration"`）→ 因切换被取代的事项各一条 `item.superseded` → `premise.changed`（见下）。失败则是 `schema.migration_failed`（头）。

**切换时的前提**：任何一次切换（不需要重建物理表的，以及后台迁移结束的）之后，新版删除了某条前提声明所声明的字段（含随表删除的字段）时，在 `schema.switched` 与它的 `item.superseded` 之后至多一条 `premise.changed`（§5.10）；没有这样的声明时不产生。

后台构建新版表的过程不产生事件。

例：建 `ledger` slot。

| `seq` | `type` | `op` |
|---|---|---|
| 2 | `schema.draft_submitted` | — |
| 3 | `schema.compiled` | 2 |
| 4 | `schema.confirmed` | 2 |
| 5 | `slot.policy_set` | 2 |
| 6 | `schema.switched` | 2 |

例：给 `ledger` 加一张 `budgets` 表（第 1 版 → 第 2 版；`add_table` 按默认策略自动生效，不重建已有的表）。

| `seq` | `type` | `op` |
|---|---|---|
| 45 | `schema.draft_submitted` | — |
| 46 | `schema.compiled` | 45 |
| 47 | `schema.confirmed` | 45 |
| 48 | `schema.switched` | 45 |

### 4.6 后台任务与恢复

内核自己发起的操作，头事件的 `actor` 是 `system`，并带 `trigger`。第一版有六种：到期物理删除（`deletion.executed`）、迁移切换或失败、恢复流程里追加的 `tenant.restored`、恢复流程里按删除登记补出的删除事件（`deletion.confirmed`、`deletion.cancelled`、`deletion.executed`）、导入时为占位的待删除项补的墓碑（`deletion.executed`，`trigger: "import"`）、刷新令牌被重放时吊销连接实例（`principal.revoked`，`trigger: "oauth_refresh_replay"`）。导入本身的 `tenant.imported` 由发起导入的用户主体做，不是 `system`。

读取记录的落盘与清理、残留清理、高水位推进、对拍、日志校验、导出都不产生事件。

---

## 5. 事件类型

每个类型给出：谁产生、事件头特有字段、内容块词表、`apply` 据此做什么。词表里"种类"一栏：**元**是元数据块，**数**是数据块。

### 5.1 头事件共有的块

| path | 种类 | 内容 | 说明 |
|---|---|---|---|
| `ctx` | 元 | 见下 | 这次操作的调用上下文与判定版本。调用方发起的全部头事件都有，`system` 产生的删除确认与撤回、吊销也有；其余由系统生成的头事件没有（清单见 §4.1） |
| `task` | 数 | 字符串 | 调用方自报的任务标识。来源同 `request_key` |
| `request_key` | 数 | `{"key": <字符串>}` | 服务端由"连接实例 + 任务 + 规范化请求"算出的请求键。规范化请求含各条前提解析后的所见版本（含兜底取得的）；写入目标兜底补上的 `ver` 不在其内 |
| `idempotency` | 数 | `{"key": <字符串>, "fingerprint": <哈希>}` | 调用方显式给的幂等键，与请求内容的指纹（按整个请求体算） |

`task`、`request_key`、`idempotency` 只出现在调用方发起的头事件里。它们的来源：本操作的全部 `source.recorded` 事件，与被 `source_ref` 引用、并出现在本操作事件里的源数据（某个进了事件的 op 的 `sources/<字段ID>/<k>`、`valid_sources` 或 `op_sources` 列着它）。其中任何一条被隐私删除，这三个块随之删除。没被任何进了事件的 op 用到的 `source_ref` 段不在其内：本操作没有记下对它的引用，请求里只有那条源数据的 ID，删掉它之后本操作里没有它的残留。宽限期内 `request_key` 与 `idempotency` 仍参与查重。同一个头事件里 `request_key` 与 `idempotency` 至多出现一个：调用方给了显式幂等键就只记 `idempotency`。

**只含按来源键 op 的 `write` 不记 `request_key`**：来源键本身让重发幂等（同样的内容再交一遍，结果是 `unchanged`），服务端不为这种请求算请求键。调用方给了显式幂等键、且请求产生了事件时，照旧记 `idempotency`；请求没产生事件时什么都不记。含普通 op 的请求照旧记 `request_key`。

**没有任何源数据的操作**（`delete`、撤回删除（`deletion.cancelled`：请求本身不带任何证据或内容）、`schema_draft`、既没带证据、也没带 `note`、又不触发写入的 `resolve`；**产生事件的 `write` 总有源数据**：至少有它的证据，或每个进了事件的 op 的 `api_call`）：这三个块没有来源，不在任何隐私删除的级联范围内。删除预览的"不会删除"里如实列出（契约的 `operation_labels`）；所以任务标识不应包含用户内容。没有任何 op 进事件的 `write` 不产生事件，也就没有这三个块。

`ctx` 的形状：

```json
{
  "now": "2026-11-10T04:41:07.123Z",
  "today": "2026-11-10",
  "ruleset_version": 1,
  "policy_version": 1,
  "literal_checker": "literal@1"
}
```

| 键 | 含义 |
|---|---|
| `now` | 调用上下文里的当前时刻（入口取的，可能早于事件头的 `at`） |
| `today` | `now` 在该 slot 时区下的日期。没有 slot 的操作（`principal.*`）与不做判定的 `slot.removed` 缺省不写 |
| `ruleset_version` | 这次操作做机械判定时用的规则版本（内核的整数版本号）。不做判定的操作也照记当时内核的版本。内核不认识的版本：`apply` 停止（§1.6） |
| `policy_version` | 这次操作判定时该 slot 的策略版本。没有 slot 的操作（`principal.*`）与 `slot.removed` 缺省不写；新建 slot 的 `schema.draft_submitted` 记同一操作里初始策略的版本 |
| `literal_checker` | 字面命中核对器的版本（含同义表版本）。只有 `write.head` 有。内核不认识的版本：`apply` 停止（§1.6） |

删除重放时，每次旧写入按它自己的头事件记下的 `ruleset_version` 与 `policy_version` 重算。

### 5.2 租户

#### `tenant.genesis`

日志的第一条事件（`seq` = 1，`prev_hash` 为 64 个 `0`）。由 `saveslot init` 或服务器模式建租户时产生。`actor` 是被登记的用户主体。

事件头特有：`node_id`。

它由系统在建租户时生成，不是一次调用方的操作：**不带 `ctx`**，也没有 `task`、`request_key`。

| path | 种类 | 内容 |
|---|---|---|
| `tenant` | 元 | `{"tenant_id": <字符串>, "storage_format": <整数>, "event_format": 1}` |
| `user` | 元 | `{"principal": <主体 ID>, "kind": "user"}` |
| `system` | 元 | `{"principal": "system", "kind": "system"}` |

`apply`：建 `principals` 的两行。

#### `tenant.restored`

恢复备份、快照之后追加的第一条事件。`actor: "system"`，`trigger: "restore"`。

事件头特有：

| 字段 | 含义 |
|---|---|
| `node_id` | 新生成，之后的事件身份用它 |
| `restore_id` | 这次恢复的 ID，恢复流程靠它判断这条事件是否已经追加过 |
| `restore_count` | 恢复之后的租户恢复次数（恢复前的值加 1）。对外的 `ver`、事项版本、句柄里的第二个数就是它 |
| `restored_to` | 恢复出的日志里最后一条事件的 `seq` |
| `high_water` | 恢复时锚点存储记下的 `seq` 高水位。本事件的 `seq` = max（`restored_to`，`high_water`）+ 1 |

没有内容块。`verify` 据此认可 `restored_to` 与本事件之间的 `seq` 空档。`restored_to` 也是判定恢复之前发出的 `ver` 时用的恢复点（[`04-contract.md`](04-contract.md) 第 15 节）。

`apply`：没有物化动作。当前恢复次数不另存，取日志里最近一条 `tenant.restored` 或 `tenant.imported` 的 `restore_count`（`ver`、事项版本、句柄都读它）；锚点存储里的恢复次数与它同值——恢复流程先在锚点里加 1、再把加 1 后的值写进本事件。

#### `tenant.imported`

把一份导出装进一个空租户之后追加的事件（导入只给用户会话，见 [`04-contract.md`](04-contract.md) 第 17 节）。头事件；`actor` 是发起导入的用户主体，由本事件登记，与创世事件登记用户主体同一种做法。

导入的做法：导出文件里的事件逐条原样追加并交给 `apply`（事件头的字节与导出里的相同，内容块按导出里的三种状态落，§3.3），然后追加本事件，再为导出里每一项占位的待删除项各补一条墓碑（`deletion.executed`，`trigger: "import"`，`reason: "import_placeholder"`，§5.9）。哪些删除算占位按块判定：拼接后的文件里，一项删除的位置列表里任一块是占位（`pending_deletion`），这项删除就补墓碑；不看清单的 `pending_deletions`。补墓碑按对应删除确认事件的 `seq` 升序。导出时显式包含了待删除内容的，这些删除在目标处仍是待执行，照事件里记下的到期时刻继续。不逐条重新执行契约操作：那样会重新判定、重新分配 `seq` 与 ID，得到的不是同一条日志。

事件头特有：

| 字段 | 含义 |
|---|---|
| `node_id` | 新生成，之后的事件身份用它（§2.2） |
| `restore_count` | 导出清单里的恢复次数加 1（几段续传时取最后一段的清单，§8）。导入之前发出的事项版本因此一律对不上，导入之前的 `ver` 也认得出来。清单里的这个数先要核对：是不超过 2^31 − 2 的非负整数，并且等于导入的日志自己的当前恢复次数（最近一条恢复或导入事件里的，没有则为 0）；否则清单与内容对不上，拒绝，不落账 |
| `imported_upto` | 导入的最后一条事件的 `seq`。本事件的 `seq` = `imported_upto` + 1。它也是判定导入之前发出的 `ver` 时用的导入点（[`04-contract.md`](04-contract.md) 第 15 节） |

它不是一次判定，**不带 `ctx`**，也没有 `task`、`request_key`。导入用的 ID 只给暂存的存储命名、与锚点里的"导入进行中"标记配对，不进事件。

| path | 种类 | 内容 |
|---|---|---|
| `tenant` | 元 | `{"tenant_id": <目标租户的 ID>, "previous_tenant_id": <导出里的租户 ID>, "storage_format": <整数>, "event_format": <整数>}` |
| `user` | 元 | `{"principal": <发起导入的用户主体 ID>, "kind": "user"}` |
| `export` | 元 | `{"exported_at": <清单里的导出时刻>, "pending_deletions": "placeholder" \| "included"}`。几段续传文件拼接导入时，取第一段的清单 |

- 与 `tenant.restored` 分成两种事件：恢复不换租户、不换用户、不停用主体，说明的是一段 `seq` 空档；导入没有空档，`verify` 核对的是 `prev_hash` 接在导入的最后一条之后、`seq` 恰为 `imported_upto` + 1。
- 已导入事件的字节不变：创世事件里仍是原来的租户 ID。**当前的租户 ID 以最近一条 `tenant.genesis` 或 `tenant.imported` 为准**；导出时清单里的 `tenant_id` 取它。
- 导入只能对空租户做一次：导入之后租户不再是空的。

`apply`：登记新的用户主体；**把在它之前登记过、仍有效的用户主体与连接实例置为停用**（`disabled`；`system` 除外）；已吊销的保持已吊销（`revoked`）。本事件 `user` 里的主体不被停用、状态为有效：它在导入的日志里登记过时（同一个用户把自己的导出装回一个空租户），也是如此；记下当前恢复次数与当前租户 ID。停用的主体不能认证、第一版不能恢复；它们写过的事件 `actor` 不变。

### 5.3 主体

三种都是头事件，带 §5.1 的 `ctx`（没有 slot，所以只有 `now`、`ruleset_version`）。`principal.registered`、`principal.renamed` 的 `actor` 是发起的用户主体；`principal.revoked` 的 `actor` 见该类型下的说明，三种发起者的 `ctx` 形状相同。**第一版不带 `task`、`request_key`、`idempotency`**：契约的 `connections.*` 没有任务标识与幂等键参数，主体管理不做幂等去重。

#### `principal.registered`

| path | 种类 | 内容 |
|---|---|---|
| `principal` | 元 | `{"principal": <主体 ID>, "kind": "connection", "scopes": ["saveslot.read","saveslot.write"], "slots": ["sl_4KTZ…"], "via": "token" \| "oauth", "client": <OAuth 客户端标识>}`。`client` 在 `via` 为 `oauth` 时必有、否则没有，是客户端软件的标识，不是用户内容。`slots` 见下 |
| `name` | 数 | `{"name": "MacBook · Claude Code"}`。用户起的名字。来源：无，不在隐私删除的级联范围内；删除预览的 `not_deleted` 里以 `connection_names` 如实列出 |

`scopes` 不重复、必含 `saveslot.read`，按 `Scope` 枚举的列出顺序（`saveslot.read`、`saveslot.write`、`saveslot.schema`、`saveslot.delete`）排列：同一组权限只有一种写法。

`slots` 是这个连接实例的 **slot 范围**：slot ID 的数组，按 ID 升序、不重复、不为空。**缺省 = 全部**，含之后新建的 slot（缺省字段不编码，不限定范围的登记事件里没有这个键）。同一组 `scopes` 对范围内的每个 slot 一样。它只含 saveslot 分配的不透明 ID，与 `scopes` 同放在元数据块里；主体事件是租户级事件，事件头没有 `slot`，范围也不进事件头。范围签发后不能改，要改就吊销后重签。服务层按 `principals` 里记下的范围构造调用上下文的可见范围，控制面不另存一份。

#### `principal.renamed`

| path | 种类 | 内容 |
|---|---|---|
| `principal` | 元 | `{"principal": <主体 ID>}` |
| `name` | 数 | `{"name": <新名字>}` |

#### `principal.revoked`

| path | 种类 | 内容 |
|---|---|---|
| `principal` | 元 | `{"principal": <主体 ID>}` |

`actor` 有三种：发起吊销的用户主体（`connections.revoke`）；被吊销的连接实例自己（经 OAuth 吊销端点吊销自己的授权，[`05-surfaces.md`](05-surfaces.md) 第 15 节），这时 `actor` 必须等于 `principal` 块里的主体，连接实例不能吊销别的主体，日志里出现这样的事件时 `apply` 停止；`system`，`trigger: "oauth_refresh_replay"`（同一张刷新令牌被第二次使用，按令牌泄露处理）。用户主体与连接实例发起的不带 `trigger`。三种的 `apply` 相同。对已经吊销或停用的主体再吊销，不论谁发起，都不产生事件：已吊销、已停用的连接实例也写不出一条吊销自己的事件。

`apply`：维护 `principals`（种类、名称、scope、slot 范围、状态）。状态由事件得出：`principal.revoked` 之后是已吊销（`revoked`）；`tenant.imported` 把它之前登记、仍有效的主体置为已停用（`disabled`，§5.2），已吊销的保持已吊销；都没有的是有效的。令牌本身不在日志里，在控制面。

### 5.4 slot 策略与移除

#### `slot.policy_set`

建 slot 时作为 `schema.draft_submitted` 操作的一员产生（初始策略）；之后改策略时是头事件（第一版没有改策略的操作，只产生初始的那一条）。

| path | 种类 | 内容 |
|---|---|---|
| `policy` | 元 | 见下 |

```json
{
  "policy_version": 1,
  "effective_value_rule": "keep_current",
  "rank": {"user_stated": 2, "agent_inferred": 1, "miss": 0},
  "auto_apply": ["add_table", "add_derived_table", "add_optional_field", "description",
                 "rename_unused", "loosen_constraint", "duplicate_keys", "restructure_unused"],
  "high_impact": [],
  "user_session_only": []
}
```

| 键 | 含义 |
|---|---|
| `policy_version` | 这个 slot 的策略版本，每条 `slot.policy_set` 加 1 |
| `effective_value_rule` | 冲突期间的生效值规则。第一版只有 `keep_current` |
| `rank` | 来源级别的秩表：字面命中时取声明级别的秩，未命中取 `miss`。第一版只记不用 |
| `auto_apply` | 哪些类别的 schema 改动可以不经确认自动生效。取值：`add_table`、`add_derived_table`、`add_optional_field`、`description`、`rename_unused`、`loosen_constraint`、`duplicate_keys`、`restructure_unused`（各自的含义见 [`03-data-model/07-schema-evolution.md`](03-data-model/07-schema-evolution.md)「改动分类与迁移手段」的表；改别名 `change_aliases` 归入 `description`，从未被写入、没人在用的表上的结构改动，以及这类表上原本要确认的字段改动（含新增必填字段、改时间字段），归入 `restructure_unused`）。建 slot 时的默认策略八个全开，如上例。取值写在建 slot 时的这条事件里：日志里 `auto_apply` 不含 `restructure_unused` 的 slot 不享有这一类，第一版也没有改策略的操作 |
| `high_impact` | 策略额外指定为高影响的表或字段：`[{"table": <表 ID>, "fields": [<字段 ID>]}]`。第一版恒为空；**非空是保留的形状，不属于 `v` = 1**，启用时 `slot.policy_set` 的 `v` 加一 |
| `user_session_only` | 只接受用户会话确认的处理方式：`[{"type": <事项类型>, "decision": <处理方式>}]`。第一版恒为空；非空同上，是保留的形状 |

`apply`：更新 `slots` 的当前策略指针。

#### `slot.removed`

移除一个空的 slot（契约 `slots.remove`）。头事件，`actor` 是发起移除的用户主体；事件头的 `slot` 是被移除的 slot。带 §5.1 的 `ctx`，只有 `now` 与 `ruleset_version`（不做判定）；**不带 `task`、`request_key`、`idempotency`**：`slots.remove` 没有这些参数，按 `slot_id` 再移除一次返回第一次的结果，不记事件。

| path | 种类 | 内容 |
|---|---|---|
| `target` | 元 | `{"slot_id": <slot ID>, "sv": <移除时的当前版本>}`。`slot_id` 与事件头的 `slot` 相同 |
| `name` | 数 | `{"name": <移除时的 slot 名>}`。用户起的名字。来源：无，不在隐私删除的级联范围内（同 `principal.registered` 的 `name`） |

只有空的 slot 才能移除，是否为空在写入时按日志判定（契约 §17），`apply` 不再判。`apply`：删 `slots` 行、这个 slot 的数据目录（`catalog`）与行数计数（`counts`），DROP 它当前版本的物理表（基础表与它的版本表、派生表）。**保留** schema 版本表里它的各版本：表号与 `slot_id` 不再使用（新 slot 的表号按 schema 版本表里已有的最大号往后排，新 `slot_id` 与其中出现过的查重）；保留建它那次操作的请求键（窗口内重发那次 `schema_draft` 返回原回执，不会再建一个）；`principals` 不变（连接实例的 slot 范围里留着这个 ID，读取与鉴权时滤掉）；读取记录不变。`target.slot_id` 与事件头不符、这个 slot 不存在或当前版本不是 `target.sv` 时，`apply` 停止。

### 5.5 schema 生命周期

#### `schema.draft_submitted`

头事件。`actor` 是提交者。带 §5.1 的块。

| path | 种类 | 内容 |
|---|---|---|
| `target` | 元 | `{"draft_id": "d_…", "base_version": <整数>, "creates_slot": <布尔>}`。建 slot 时没有 `base_version` |
| `draft` | 数 | 提交的 schema 文档全文（JSON）。来源：无。schema 文档里的名称、说明、枚举值不在隐私删除的级联范围内 |

#### `schema.compiled`

| path | 种类 | 内容 |
|---|---|---|
| `target` | 元 | `{"draft_id": "d_…", "target_version": <整数>, "outcome": "applied" \| "pending"}`。`target_version` 是这份草稿在编译时分到的版本号：这个 slot 已用过的号之后的下一个，被拒、被取代的草稿占过的号也算用过，分配后不再用于别的草稿；所以一个版本号只对应一份编译后的定义，`sv` 可以不连续 |
| `compiled` | 数 | 编译后的定义（§7）。来源：无，理由同上。重放用它，不重新编译 |
| `changes` | 元 | 逐项改动，见下 |

`changes` 是一个数组，每项的键与契约的 `SchemaChange`（[`04-contract-types.md`](04-contract-types.md) 5.3）逐个相同，只有一处不同：`target` 里的表、字段写 ID 不写名字（名字是用户写的文字，不进元数据块）。

```json
[
  {"target": {"slot": true}, "change": "create_slot", "class": "create",
   "compatible_with_old_writes": true, "destructive": false, "auto": true},
  {"target": {"table": "t1"}, "change": "add_table", "class": "create",
   "compatible_with_old_writes": true, "destructive": false, "auto": true},
  {"target": {"table": "t2", "rule": true}, "change": "change_rule", "class": "deterministic",
   "compatible_with_old_writes": true, "destructive": false, "auto": false},
  {"target": {"table": "t1", "field": "f4"}, "change": "change_type", "class": "deterministic",
   "compatible_with_old_writes": false, "destructive": false, "auto": false}
]
```

| 键 | 含义 |
|---|---|
| `target` | 改的是什么，四种写法：slot 级 `{"slot": true}`（`create_slot`、`rename_slot`、`change_timezone`）；表级 `{"table": <表 ID>}`；字段级 `{"table": <表 ID>, "field": <字段 ID>}`；派生规则 `{"table": <表 ID>, "rule": true}` |
| `change` | 改动码，取值见 [`03-data-model/07-schema-evolution.md`](03-data-model/07-schema-evolution.md)「改动分类与迁移手段」的表（含改别名 `change_aliases`、来源键的 `add_external_key` / `drop_external_key` / `change_external_key`，以及只在从未被写入的表上允许的 `change_time_type`、`change_entity_key`、`change_granularity`、`change_table_kind`、`change_ref`） |
| `class` | 类别：`create`（新建 slot、新增表）/ `metadata` / `deterministic`。保留值：`reextract`。凡经 `restructure_unused` 生效的改动（从未被写入、没人在用的表上的改动，含表一级的结构改动与字段一级的 `drop_field`、`change_type`、`add_required_field`、`change_time_field` 等），一律记 `metadata`：这张表没有已有的值，也没有转换，`migrate` 不必给。`class` 记的是这次切换实际做了什么，不是改动码的固有属性。确认时这张表已被写入的，整份草稿不能确认（§4.5） |
| `compatible_with_old_writes`、`destructive`、`auto` | 编译时的判定结果，照记。`target.outcome` 由各项的 `auto` 得出（全部为真才是 `applied`）；重放读记下的值，不按当时的策略重算 |
| `as_never_written` | 可选，只能是 `true`、只配 `class: metadata`、目标只能是表或字段：这一项按"从未被写入"编译（[`03-data-model/07`](03-data-model/07-schema-evolution.md)「从未被写入的表上改结构」），只在这张表一直没被写入时成立。确认时的重新判断（§4.5：这张表已被写入则整份不能确认，`table_written`）与切换之后带旧 `sv` 的整表拒绝只看这个键，不从 `class` 与改动码推（只改目录的改动同样记 `metadata`）。新增的可选键，兼容旧事件 |

`changes` 的次序与草稿的写法无关，同一份改动总是同一个次序：slot 一级的改动；然后现有的表按表 ID，每张表先表一级的改动、再按字段 ID 的字段改动；然后被删的表按表 ID；最后新增的表按分到的 ID。同一个目标上的几项按改动码在 [`04-contract-types.md`](04-contract-types.md) 5.3 `SchemaChangeCode` 里列出的次序。（表 ID、字段 ID 按数字部分比较。）

每个 slot 的第一条 `schema.compiled` 总含一项 `create_slot`（上例的前两项是新建 slot 的情形，后两项是之后某次修改的情形，放在一起只为列全写法）。

影响预览里的行数、试跑样例是提交时的估计，不进事件。

#### `schema.confirmed`

| path | 种类 | 内容 |
|---|---|---|
| `target` | 元 | `{"draft_id": "d_…", "target_version": <整数>, "by": "auto" \| "resolve"}` |

#### `schema.rejected`

确认方拒绝了草稿。

| path | 种类 | 内容 |
|---|---|---|
| `target` | 元 | `{"draft_id": "d_…"}` |

#### `schema.superseded`

尚未确认的草稿被同一 slot 的新草稿取代。

| path | 种类 | 内容 |
|---|---|---|
| `target` | 元 | `{"draft_id": "d_…", "by_draft": "d_…"}` |

#### `schema.migration_started`

| path | 种类 | 内容 |
|---|---|---|
| `target` | 元 | `{"migration_id": "m_…", "draft_id": "d_…", "from_version": <整数>, "to_version": <整数>}` |

`apply`：只记迁移状态。构建中的新版表是本地运行状态，不由本事件建立。

#### `schema.switched`

当前版本指针指向新版。不需要重建物理表的变更（`rebuilt_tables` 为空）与建 slot 时，它是提交或确认那次操作的一员；经过后台迁移的是头事件（`actor: "system"`，`trigger: "migration"`）。

| path | 种类 | 内容 |
|---|---|---|
| `target` | 元 | `{"draft_id": "d_…", "from_version": <整数>, "to_version": <整数>, "migration_id": "m_…", "rebuilt_tables": ["t1","t2"]}`。建 slot 时没有 `from_version`；没有经过迁移时没有 `migration_id`。`rebuilt_tables` 只列按日志重建了物理表、要核对的**基础表**；新增的表与从未被写入而改了结构的表虽然新建了物理表，但没有旧写入要转换，不列入。派生表每次切换都按新定义重建，不列在这里，也没有 `tables/<表ID>` 块（它们的核对靠各自派生写入的校验和） |
| `tables/<表ID>` | 数 | `{"rows": <整数>, "checksum": <哈希>}`：该新版表建好后的逻辑行数与结果校验和（算法见 §5.13）。每张重建的表一块。来源：该表全部行的全部贡献 |
| `backfill_rows/<表ID>/<字段ID>/<n>` | 元 | 事件类表、无时间表：这次切换的常量 `backfill` 给这个字段补了值的行，行 ID 列表。全部行 ID 按升序连续切分，每块至多 10,000 个，`n` 从 0 起。没有补值时不出现 |
| `backfill/<表ID>/<字段ID>/<n>` | 数 | 状态类表：补了值的一段，`{"entity": <实体 ID>, "valid": {…}, "deps": […]}`，一段一块，`n` 从 0 起。区间由别的贡献决定（补的是实体存在、该字段为空或有值而违反新约束的那些段；实体存在的区间由写入与撤销决定，切换不重算）。`deps` 是给出这段区间两端的贡献：按 §3.5"给出挡点的贡献"的口径，该时刻是其区间端点的全部贡献，两侧都算，已被盖住的也算（这个字段与"存在"上的贡献；有值 ↔ 无值的边界另含算"有值"的字段上的），不沿它们自己的 `deps` 递归 | `deps`（§3.5；只在其中一项被删除时清除，被重述不清除） |

- `tables/<表ID>` 用来核对，不用来生成：重放到本事件时，`apply` 按 `compiled` 里的定义把旧版的每条写入转换成新版形状、建好 `rebuilt_tables` 里的表，再与这一块比较；块已被删除时跳过核对。逐条转换是逐项的：旧写入在一个字段上的每一项变成新版同一字段上的一项，带值的项按 `migrate` 求值（更早一次切换补出的贡献同样转换，仍记在那次切换上），值为空（`"value": null`）、`no_value`、`uncovered` 的项不求值、原样带过去；状态、区间、来源、是否被回掉不变（[`03-data-model/07-schema-evolution.md`](03-data-model/07-schema-evolution.md)「确定性转换怎么重放」）。
- 该表有任何一行的任何贡献被隐私删除时，这一块列入那次删除的位置列表。
- **补值位置照记录，删除不改**：之后的删除不重述切换补值，也不追补常量。删除让某处字段变空时，它就是空的（`kept_fields_cleared`），即使那个字段是必填的。状态类表的补值段，`deps` 里的贡献被删时这一块列入那次删除的位置列表（§3.5），那一段补值随之不再存在；`deps` 里的贡献只是被重述时不列入，那一段补值照旧。
- `apply`：建新版物理表（重放时；`compiled` 里 `physical.since` 等于本版的表都要建）；改 `slots` 的当前版本；旧版标为已退役；按新定义重建派生表；`counts` 按新版表重建；键索引 `external_keys` 按新版表重建（去掉了来源键的表，条目清空）。重建时保留"已让出"与"冻结"（连同冻结集合）：让出了键的已撤销行上仍留着键字段的值，按值重建会与持有者同键。前提的声明与状态不因切换而变：出处项的（事件、字段 ID、下标）在转换前后相同，`premise_edges` 不转换；没有字段被删时切换不产生 `premise.changed`，有时见 §5.10。常量 `backfill` 补出的值**照 `backfill_rows/*` 与 `backfill/*` 的记录**登记为本事件的贡献（`base_sources` 里事件 `seq` 是本事件、另带行或实体 ID、种类是 schema 常量；版本表里出处是本事件、意图 `schema_switch`），不按重放到这里时的状态现算补在哪。`backfill/<表ID>/<字段ID>/<n>` 已被移除的那一段不登记：那一段补值不再存在。**实体或行在重放到这里时不存在，两种表的处理不同**：
  - 事件类表、无时间表：`backfill_rows/<表ID>/<字段ID>/<n>` 列出的行在重放到这里时不存在的，照记录登记进来源表（这一项贡献照样存在），业务表上没有这一行就不写；这一行之后由删除结果整行给出（§5.9「列哪些」里"存在"的给出者变了的行）。
  - 状态类表：`backfill/<表ID>/<字段ID>/<n>` 照记录登记、照记录落账，与实体在重放到这里时存不存在无关。实体当时不存在（创建它的贡献的区间块已被清掉、在原事件处没落账），就在业务表上建这一段，只含这个字段（同 §5.7 `write.base` 写到不存在的行或实体时"只含这次写入给出的字段"）；其余字段由之后的删除结果给出（被重述的项给出的段照「列哪些」列出，列出的实体都带 `results/<k>/existence`）。补值不改行或实体的 `ver`。之后的事件不引用这项贡献：值落回它时来源写 `schema_const` 条目（§5.7）。

#### `schema.migration_failed`

头事件，`actor: "system"`，`trigger: "migration"`。

| path | 种类 | 内容 |
|---|---|---|
| `target` | 元 | `{"migration_id": "m_…", "reason": "build_failed" \| "verify_failed"}` |

`apply`：迁移状态置为失败，旧版仍是当前。

### 5.6 源数据

#### `source.recorded`

一段证据存为一条源数据。别的事件用本事件的 `seq` 引用它。

| path | 种类 | 内容 |
|---|---|---|
| `target` | 元 | `{"source_id": "s_…", "kind": <证据种类>, "level": "user_stated" \| "agent_inferred", "op_index": <整数>}`。`op_index` 只在 `write` 的 `api_call` 时有：这条源数据是请求里第几个 op 的请求（与 `write.head` 的 `ops/<i>` 的 `i` 相同）。`resolve` 的 `api_call` 没有 |
| `text` | 数 | `{"text": <原文>}`。`user_message`、`agent_note`、`tool_result` |
| `file` | 数 | `{"name": …, "mime": …, "size": <整数>, "sha256": <哈希>, "origin": …, "excerpt": …}`。`file_ref`；后三个键可缺 |
| `request` | 数 | 请求本身的 JSON。`api_call`：`write` 是那一个 op（无操作字段的值不记，只留字段名；按来源键的 op 含 `external_key` 的值；重申与清除含它的 `premises`）；`resolve` 只记 `id`、`decision`、`candidate`、`note` 与所带证据的引用（`evidence`：各段的源数据 ID，按证据在请求里的先后；没带证据时没有这个键），**不含证据段的内容**——证据各有自己的源数据，这里再记一份就是一处删不到的副本 |
| `stated_at` | 数 | `{"at": <时刻>}`。调用方给的"这句话是什么时候说的"，可缺 |

- `kind` 取值：`user_message`、`agent_note`、`tool_result`、`file_ref`、`api_call`。`source_ref` 不产生事件。
- **`api_call` 的粒度**：`write` 没带证据时，每个进了事件的 op 各一条（§4.2），只含该 op；没进事件的按来源键 op 不存。一条同步来的记录对应一个 op，删掉它的源数据只去掉这条记录的贡献，不牵连同批的别的记录。`resolve` 的 `api_call` 一次请求至多一条（§4.3）。请求产生了事件时，调用方显式带的证据照存，不论有没有被进了事件的 op 引用；请求没有产生事件时（§4.2 末段），没有任何东西需要源数据，证据也不存；回执如实写明证据没有存下。
- 每条源数据恰有 `text`、`file`、`request` 之一。
- 四个数据块的来源都是本事件自己：这条源数据被隐私删除时，四块全部删除，`target` 留下。
- `apply`：登记源数据（供来源表引用、供 `sources` 列出与搜索）。

### 5.7 写入

#### `write.head`（逻辑写入头）

每次产生事件的 `write` 请求一条，头事件（没有任何 op 进事件的请求不产生它，§4.2）。带 §5.1 的块，另有：

| path | 种类 | 内容 | 来源 |
|---|---|---|---|
| `request` | 元 | `{"sv": <整数>, "sv_basis": "explicit" \| "fallback", "op_count": <整数>}`：请求带的 schema 版本，它是调用方带的还是按读取记录兜底取得的，以及请求里 op 的总数（含没进事件的） | — |
| `ops/<i>/target` | 元 | 见下 | — |
| `ops/<i>/set/<字段ID>` | 数 | 这个字段的**原始值**（§1.3）。只对不是无操作的字段记。来源键的键字段只在得到键的那次写入里记（按来源键新增，或补键） | 该字段在这个 op 里引用的全部证据（同时需要）；键字段：这个 op 的全部证据 |
| `ops/<i>/noop` | 元 | 这个 op 里无操作的字段 ID 列表：`["f4"]`。按来源键命中已有行时，键字段也列在这里。没有无操作字段时不出现 | — |
| `ops/<i>/explicit` | 元 | 这个 op 里按字段显式指向了证据的字段 ID 列表（`evidence_by_field` 的键，不含 `valid`；按表的字段顺序）：`["f2"]`。只用于同值判断：其中与所见版本同值的字段是佐证，不是无操作；重放与删除重放按它恢复判定的输入。没有显式字段时不出现 | — |
| `ops/<i>/valid` | 数 | 区间参数的原始写法，见下 | `evidence_by_field` 的 `valid` 映射到的证据；没映射就是这个 op 的全部证据 |
| `ops/<i>/revert` | 元 | `{"undo_op": <操作号>, "include_later": <布尔>}` | — |
| `ops/<i>/acknowledge` | 元 | `["overwrite"]` | — |
| `ops/<i>/named_fields` | 元 | 这个 op 里按名字引用的字段 ID 列表，供改名预览统计 | — |
| `ops/<i>/refs` | 数 | 请求里用临时名引用本请求里的行时：`{"as": "<临时名>"}`（本 op 登记的临时名：新建的行，或按来源键命中的行）。临时名是调用方起的文字，只在本请求内有意义；解析后的行 ID 记在引用它的字段值里 | 这个 op 的全部证据 |
| `ops/<i>/baseline` | 元 | 按来源键命中已有行时，逐字段的同步基线位置：`{"f2": 30, "f3": 50}`（字段 ID → 操作号）。新增时没有 | — |
| `ops/<i>/premises/<j>` | 元 | 这个 op 声明的第 `j` 条前提，见下 | — |
| `ops/<i>/premise_valid/<j>` | 数 | 第 `j` 条前提的业务时间，见下。范围是 `row_time` 或 `given` 时有 | 见下 |
| `ops/<i>/premise_covers` | 元 | 这个 op 的声明另外覆盖的出处项：`[{"event": 52, "field": "f1", "k": 0}]`（对"存在"的一项写成 `{"event": …, "existence": <k>}`）。为空时不出现 | — |
| `ops/<i>/premises_cleared` | 元 | `true`：这个 op 带的是 `premises: []`（清除）。它覆盖的项同样列在 `ops/<i>/premise_covers` 里 | — |

**没有 `ops/<i>/explicit` 等于没有显式字段。**

**无操作的字段不留值**：与所见版本同值、又没有显式指向证据的字段，事件里只在 `ops/<i>/noop` 列出字段 ID，任何块里都没有它的值。显式指向了证据的同值字段是佐证（`ops/<i>/explicit`），照常有项与来源。

**op 的个数由 `request.op_count` 给出**。`ops/<i>` 的 `i` 是 op 在请求里的下标；没进事件的 op（按来源键的 `unchanged`、`skipped`）留空号，它的下标下没有任何块。`write.base` 的 `target.op_index`、`api_call` 的 `target.op_index`、前提声明的身份都用这个下标。

`ops/<i>/target`：

```json
{
  "table": "t1",
  "row": "r_01JC8Z…",
  "intent": "correct",
  "ver": {"op": 21, "restore_count": 0, "basis": "explicit"}
}
```

| 键 | 含义 |
|---|---|
| `table` | 表 ID |
| `row` / `entity` | 目标行或实体。新增时是 saveslot 刚分配的 ID；按来源键定位时是定位到的或新分配的行 ID |
| `by_entity_key` | `true` 表示调用方是按 `entity_key` 定位的 |
| `by_external_key` | `true` 表示调用方是按来源键（`external_key`）定位的。定位的结果就是 `row`，`apply` 照它落账，删除重放也不重新定位 |
| `key_from` | 给没有来源键的行补键、而这个键从一行已撤销的行转来时：那一行的行 ID。那一行从此不再占这个键 |
| `created` | `true` 表示这个 op 新建了这一行或这个实体（`undo` 据此识别首次创建）。它是机械判定：隐私删除让它变化时，删除事件的 `recreated/<k>` 给出新值，以最近一次给出的为准（§5.9） |
| `intent` | 意图（§6.2） |
| `ver` | 这个 op 所见的版本。`basis`：`explicit`（调用方带的）/ `fallback`（按读取记录兜底）/ `same_request`（本请求前面的 op 新建的，不需要 `ver`；`op` 填本操作号）/ `external_key`（按来源键命中已有行：所见版本由内核取同步基线位置，`op` 是这个 op 涉及的字段里最早的基线位置，逐字段的位置在 `ops/<i>/baseline`；`restore_count` 是写入那一刻的当前恢复次数。它是内核在本日志里取的位置，不是令牌：解码与重放都照记录的 `op`，不按下面的恢复点换算）。`current`：`true` 表示写入时这个版本就是这一行的当前版本（`op` 与 `restore_count` 都与当前版本相同）；只有 `basis` 为 `explicit` 或 `fallback` 时可能带，`fallback` 取到的版本同样比过才带，`same_request` 与 `external_key` 不带。带它的 op，所见状态是它之前那一刻的状态（按 op 在请求里的次序，同一请求里前面的 op 也在内），含 `op` 之后没有换版本的记录（佐证、删除的重述、生效但没有改动任何值的项）；冲突判据里"V 之后"的下界同样取这一刻。它在写入时判定一次，重放照记录，不再比版本号。不带这个键时，所见状态取截至 `op` 那次操作（所见位置）。恢复或导入之前签发的令牌（`basis` 为 `explicit` 或 `fallback`）原样记（`op` 与 `restore_count` 都是调用方给的）；它的所见位置按 [`04-contract.md`](04-contract.md) 第 15 节换算：恢复次数恰好比本事件那一刻的当前值小 1、且 `op` 不超过那一刻的恢复点的，取它自己的 `op`；其余取那一刻的恢复点。恢复次数与恢复点都取本事件之前最近的那条恢复或导入事件的，所以之后再有恢复或导入，重放得到的所见位置也不变。新增时没有 `ver` |

`ops/<i>/valid`（只有状态类表有）。调用方对状态类表的写入总有这一块，起止都没给时写 `{"from": {"mode": "now"}, "to": {"mode": "next_change"}}`；没带区间的撤销没有。写入管线编码时照此检查，缺了就是无效事件：

```json
{"from": {"mode": "given", "value": "2026-11-02"}, "to": {"mode": "next_change"}}
```

| 键 | `mode` 取值 |
|---|---|
| `from` | `given`（带 `value`）/ `now` / `corrected_span` |
| `to` | `given`（带 `value`）/ `open` / `next_change` / `corrected_span` |

`corrected_span` 是意图为 `correct` 而起止都没传时的写法：区间取该字段包含"现在"、以挡点为界的那一段。`next_change` 与 `corrected_span` 解析出的端点是机械判定的结果，删除重放时按删除后的状态重新解析。但端点本身是由别的贡献求得的值（停在谁给出的挡点上），所以解析结果记在 `write.base` 的 `span/<字段ID>/<k>` 块里并带 `deps`（§3.5；给出挡点的贡献两侧都算）；给出挡点的贡献被删、或解析结果被删除重放改掉时，旧块清除，由删除事件的 `restated/<k>` 给出新值（§5.9）。

`ops/<i>/baseline`：按来源键写入时，判定用的所见版本按字段取，每个字段取它自己的同步基线位置（[`03-data-model/04-write-and-read.md`](03-data-model/04-write-and-read.md)「按来源键写入」）。这一块只含字段 ID 与操作号，是写入时的日志位置，删除重放照记录用它，与兜底取得的 `ver` 同样处理。

**前提**（[`03-data-model/02-integrity-and-records.md`](03-data-model/02-integrity-and-records.md)「写入的前提」）：调用方在 op 里声明这次写入以哪些已读到的值为前提。声明是原始传参，记在写入头里：重申与清除没有基础写入，候选与待确认的写入也要记下声明。按来源键的 op 与带 `revert` 的 op、撤销不能带前提，所以 `ops/<i>/baseline` 与前提块不会出现在同一个 op 上。一条声明的身份 =（声明所在的操作号，op 下标 `i`，声明下标 `j`）。

`ops/<i>/premises/<j>`：

```json
{"table": "t1", "row": "r_01JF…", "fields": ["f2"],
 "ver": {"op": 40, "restore_count": 0, "basis": "explicit"},
 "range": "whole", "state": "current"}
```

| 键 | 含义 |
|---|---|
| `table`、`row` / `entity` | 前提目标。按 `entity_key` 或临时名给的，这里记解析后的 ID（键值与临时名是内容，不记在这里） |
| `fields` | 声明的字段 ID 列表。缺省 = 整行 |
| `ver` | 所见版本。同 `ops/<i>/target` 的 `ver`（恢复之前签发的令牌原样记，所见位置同样按 04-contract 第 15 节换算；所见位置早于本操作，`same_request` 时就是本操作。所见位置要按恢复点换算，令牌的 `op` 可以不早于本操作——导入之后，导出方在导出之后发出的令牌——所以这一条由 `apply` 核对，形状检查只核 `op` 是正整数），但没有 `current`（前提只比值，不参与取值判定），`basis` 取 `explicit` / `fallback` / `same_request`（前提没有按来源键的写法） |
| `range` | 声明的业务时间范围的种类：`whole`（前提目标在事件类表、无时间表上：没有业务时间）/ `from_now`（前提目标在状态类表上，从 `ctx.now` 起一直延续；`date` 粒度从 `ctx.today` 起）/ `row_time`（前提目标在状态类表上，取依赖行自己的业务时间，见 `ops/<i>/premise_valid/<j>`）/ `given`（前提目标在状态类表上，调用方给了时间，见同一块） |
| `state` | 落账时的判定结果：`current`（所见的值就是现在的值）/ `changed`（声明时已经变了：一写下就带标记） |
| `reason`、`since` | 只在 `state` 为 `changed` 时有：`since` 是所见位置之后、从它起一直到声明时都与所见版本在所声明范围上不同的那一段版本里的第一个操作号（`since` 大于所见位置；所见位置要按恢复点换算，所以它不一定大于 `ver.op`，这条由 `apply` 核对，形状检查不核）（在所见那一刻声明、再逐次检测，得出的就是它）；`reason` 是那次操作的原因码（§6.8） |

这一块是元数据：只有不透明 ID、字段 ID、操作号、恢复次数与枚举。键名用 `range` 而不用 `scope`：`write.base` 的 `existence/<k>` 已有 `scope`。

同一个 op 的各条声明，前提目标（`table` 与 `row` / `entity`）互不相同：一个出处项对一个前提目标只有一条有效声明（见下「覆盖」），同一 op 里第二条会把第一条挤掉。两条声明指向同一个目标的 `write.head` 不是合法事件。

`ops/<i>/premise_valid/<j>`：`{"at": <点>}` 或 `{"during": {"from": <点>, "to": <点>}}`，解析后、已按前提目标所在表的粒度对齐的业务时间。业务时间的起止点是用户说的，所以是数据块：

| `range` | 内容 | 来源 |
|---|---|---|
| `given` | 调用方给的 `valid_at` / `valid_during` | 这个 op 的全部证据（与没映射时的 `ops/<i>/valid` 相同） |
| `row_time`，出自这个 op 自己写下的时间字段或区间 | 依赖行这次写下的时间值（不论这一部分生效、成了候选还是进了待确认） | 与那一块相同（`ops/<i>/set/<字段ID>` 或 `ops/<i>/valid`） |
| `row_time`，出自别的贡献（这个 op 没写时间字段，或区间端点按 `next_change` / `corrected_span` 解析而来） | 依赖行在 op 之后的时间值 | 块里带 `deps`，指向给出它的贡献（§3.5） |

取自依赖行的范围在声明时定下，之后依赖行的时间被改，这条声明的范围不跟着变。这一块被某次删除确认列入位置列表起（不等到墓碑），这条声明的范围按整条时间线处理（宁可多报），并在那次删除的检测里按整条时间线重判一次，变化写进同一操作的 `premise.changed`；撤回那次删除时范围恢复（仍被别的待执行删除列出的除外），同样重判一次（[`03-data-model/02-integrity-and-records.md`](03-data-model/02-integrity-and-records.md)「写入的前提」的「检测」）。墓碑只清空 `premise_decls` 里业务时间的副本。

**覆盖**：一条声明覆盖本 op 的 `write.base` 在目标行上的全部项，加上 `ops/<i>/premise_covers` 列出的项——这一行在 op 所见版本上就已生效、op 之后仍然生效的其余各项。`premise_covers` 只在这个 op 全部字段都已生效（`applied`、`corroborated`、无操作）时才有；有字段成了候选或进了待确认时不记，之后它经采纳或因删除而生效也不补记。**清除不受这一条限制**：带 `premises: []` 的 op 照样把这些项记进 `premise_covers`，清掉的是整行的声明。重申（不带 `set` 的 `update`）没有自己写下的项，只有 `premise_covers`。对同一个出处项、同一个前提目标，以最晚的一条覆盖它的声明为准；清除覆盖的项上，它之前的全部声明一并失效。

前提不参与任何取值判定：同值、冲突、高影响、存在、回掉、删除重放都不读它，它也不进任何块的 `deps`。

`apply`：把 `request_key` / `idempotency` 写进请求键索引（指向本操作号）；按 `ops/<i>/premises/<j>`、`ops/<i>/premise_valid/<j>` 在 `premise_decls` 里登记声明；按 `ops/<i>/premise_covers`、`ops/<i>/premises_cleared` 改写 `premise_edges`（清除登记一条前提目标为"全部"的条目）；补键带 `key_from`、且同一操作里这个 op 的 `write.base` 上键字段项 `fields/<键字段ID>/0` 在（没被移除）时，键索引 `external_keys` 的条目改指本 op 的行，`key_from` 那一行标为"已让出"；那一项已被移除时（墓碑之后从头重放），不转移，持有者仍按[`03-data-model/04-write-and-read.md`](03-data-model/04-write-and-read.md)「持有者怎么定」定。其余块只供 `timeline`、幂等重放的回执、删除重放与审计使用。

#### `write.base`（基础写入）

一个 op 对一行或一个实体的写入。状态类表按实体记一条，不按物理段。

**一个字段的贡献是按区间排好的若干项，一项一块。** 事件类表与无时间表上每个字段恒为一项（`k = 0`）。状态类表上通常也是一项；一个字段在不同区间上值不同或状态不同时有多项：`undo`、回到合并基要写回几段不同的旧值；佐证的区间里一部分仍同值（`corroborated`）、一部分已被别人改掉（按普通写入参与判定）；`undo` 只回掉仍生效的部分。各项的区间互不相交，`k` 按区间起点升序、从 0 起。

| path | 种类 | 内容 | 来源 |
|---|---|---|---|
| `target` | 元 | 见下 | — |
| `fields/<字段ID>/<k>` | 数 | 这次写入对该字段的一项贡献：生效状态与值，见下 | `sources/<字段ID>/<k>` 列出的值来源；状态类表另加 `valid_sources` |
| `sources/<字段ID>/<k>` | 数 | 这一项的值来源列表，见下 | 同 `fields/<字段ID>/<k>`，两块同生同灭 |
| `literal/<字段ID>/<k>` | 数 | 这一项的字面命中记录，见下 | 同 `fields/<字段ID>/<k>` |
| `span/<字段ID>/<k>` | 数 | 状态类表：这一项解析后的区间，见下 | 同 `fields/<字段ID>/<k>`，另加本块的 `deps`（§3.5） |
| `existence/<k>` | 元 | 对"存在"的一项贡献，与字段一样按项记（事件类表、无时间表恒为 `k = 0`）。撤销：`{"status": …, "scope": "whole" \| "interval"}`；恢复存在（回掉一次撤销时的写回项）：另带 `"restored": true`。见下 | — |
| `span/existence/<k>` | 数 | `scope` 为 `interval` 的那一项的区间：撤销的区间，或恢复存在的区间。回掉写回的项靠本块的 `deps` 记出处，所以写回落在整段时间上时也是 `interval`，区间写 `{}`；被别的项切开时可以起点开口，写 `{"to": …}`（§1.2）。只有调用方给的整体撤销是 `whole`、没有本块。见下 | 调用方给的撤销：`valid_sources`（调用方给的带区间的撤销总有这个块），另加本块的 `deps`；回掉写回的项：本块的 `deps` |
| `valid_sources` | 元 | 区间参数的来源：`[<源数据事件的 seq>]`。状态类表上带区间参数的基础写入（写入与撤销）总有这个块：`evidence_by_field` 的 `valid` 映射到的段，没映射就是这个 op 的全部证据（没带证据时是它的 `api_call`）。不带区间参数的（状态类表上不给起点终点的写入、纠错的默认区间 `corrected_span`、整体撤销）没有这个块 | — |
| `op_sources` | 元 | 操作来源：`[<源数据事件的 seq>]`。`undo` 的基础写入：这次请求的证据（没带时是它的 `api_call`）。调用方给的撤销：它的证据里不作区间来源的段，整体撤销是全部证据（没带时是它的 `api_call`）。一条都没有时不出现；之前的事件可能没有这个块 | — |
| `duplicate` | 数 | 疑似重复的判定：`{"matched": [<行 ID>], "keys": [<字段 ID>], "deps": […]}`。`matched` 是命中的行：1 到 10 个，各出现一次，不含这一行自己，按最近写入排（被比中行上最后一次生效写入的操作号降序）；`keys` 是命中的那一组 `duplicate_keys`，非空、各字段一次。只在新增且已生效的行上有（目标是行，不是实体）。写入时判一次，之后不重算 | `deps`：被比中的那些行在这些字段上当时生效的贡献 |
| `ack/<j>` | 数 | `acknowledge` 确认覆盖的一段：原来有值时 `{"field": "f2", "valid": {…}, "value": …, "op": <写下这一段的操作号>, "deps": […]}`；原来没有值时 `{"field": "f2", "valid": {…}, "no_value": true, "deps": […]}`，没有 `value` 与 `op`。`no_value` 与 `fields/<f>/<k>` 里的同名键同义：这一段原来没有值，不区分是实体无值还是字段没有贡献。`value` 与 `no_value` 恰有其一 | `deps`：写下这一段的贡献（原来有值时），给出这一段两端的贡献，这一段在一次撤销之内时另含那次撤销 |
| `revert` | 元 | **回退记录**：这次写入回掉了哪几次操作在哪些目标上的改动，见下。`revert: {undo}` 与 `take_previous` 的基础写入都带它，形状相同。只有事件 `seq`、操作号与目标（字段 ID 或"存在"），不含下标与区间 | — |
| `take` | 元 | **采纳记录**：`take_candidate` 触发的基础写入带它，为删除重放留下所需的记录，见 §5.8「`item.resolved`」。只有事项、候选号、操作号与（事件, 目标），不含下标与区间，不随删除清除 | — |

`target`：

```json
{"op_index": 0, "table": "t1", "row": "r_01JC8Z…", "intent": "correct", "cause": "request", "sv": 1}
```

| 键 | 含义 |
|---|---|
| `op_index` | 对应 `write.head` 的第几个 op（请求里的下标，即 `ops/<i>` 的 `i`）。由 `resolve` 触发的没有 |
| `table`、`row` / `entity` | 目标 |
| `intent` | 意图（§6.2） |
| `cause` | `request`（调用方的写入）/ `resolve`（处理事项触发）。保留值见 §10 |
| `item` | `cause` 为 `resolve` 时，被处理的事项 ID |
| `sv` | 这次写入按哪个 schema 版本解释字段 |
| `created` | 同头事件 |

`fields/<字段ID>/<k>`：

```json
{"status": "applied", "value": {"value": "54", "unit": "CNY"}}
```

| 键 | 含义 |
|---|---|
| `status` | 这一项的生效状态：`applied`、`candidate`、`awaiting`、`corroborated`（§6.3）。无操作的字段没有项 |
| `value` | 写入的值，规范写法（§1.3） |
| `no_value` | `true`：这一项把该字段置回**没有任何贡献**的状态（状态类表：在它的区间上）。三种表都适用，只出现在回退与回到合并基里：写回的那一处在取值位置上**没有任何贡献**。它**盖住**下面的值。取值位置上该处在一次撤销之内时不用它，用 `uncovered`。此时没有 `value`，这一项也没有 `sources/<字段ID>/<k>` 与 `literal/<字段ID>/<k>`。它与 `"value": null` 不同：后者是把一个可选字段显式置空，是一个有来源的值。必填字段被置回没有值时，行或该业务时刻是否还存在按存在的普通规则判断 |
| `uncovered` | `true`：这一项**只做登记，不给值，也不盖住下面的东西**——被回掉的项在这一段不再生效，它之下是什么就露出什么。只出现在回退与回到合并基里：取值位置上这一段在一次撤销之内（被回掉的是在空洞里填值的写入）。此时没有 `value`、`sources`、`literal`，有 `span/<字段ID>/<k>` 与 `deps`。与 `no_value` 的区别：`no_value` 把这一处置为没有任何贡献，之后撤销被回掉时这里仍然没有值；`uncovered` 不盖，撤销被回掉或被删之后，撤销之下原来的值照常出现。它也不盖住别的写入：该处另有一次不在回退记录里、后来才因删除而生效的填值时，露出的是那次填值 |

状态类表上，每一项另有一块 `span/<字段ID>/<k>`，记这一项解析后的区间：

```json
{"valid": {"from": "2026-11-02", "to": "2026-11-10"},
 "deps": [{"event": 15, "field": "f2", "k": 0}]}
```

```json
{"seen_valid": {"from": "2026-11-02"}}
```

| 键 | 含义 |
|---|---|
| `valid` | 这一项解析后的生效区间（逐字段、逐项）。`status` 为 `applied`、`awaiting`、`corroborated` 时按写入当时的状态解析 |
| `seen_valid` | 只有 `candidate`：按写入方所见版本解析的区间。候选的区间就是它，此时没有 `valid` |
| `deps` | 解析这个区间时用到的别的贡献（§3.5）：默认终点、`corrected_span` 停在的挡点是谁给出的（两侧都算）；把这次写入切成几项的那些贡献（所见版本之后改过值的写入）；这一项是搬运来的时，`sources/<字段ID>/<k>` 里 `carried` 指向的那一项。**回掉写回的项**（回退、回到合并基）另含：回退记录的条目覆盖的各项、盖住被跳过部分的各次写入的贡献、这一项每个区间端点处取值位置上相邻两段状态的给出者；回到合并基的另含事项的各候选。其中出自状态类表补值段的，抄那一块 `backfill/…` 的 `deps`（§3.5）。普通写入两端都由本次请求显式给出、又只有一项时没有 `deps` |

- 请求里出现、且不是无操作的字段至少有一项。请求里没出现的字段、无操作的字段都没有块。
- **来源键的键字段**只在得到键的那次写入里有一项（`fields/<键字段ID>/0`，`applied`，来源是这次写入的证据）：按来源键新增，或给没有来源键的行补键。按来源键命中已有行时键字段是无操作，不记佐证。
- **事件不记写入前的值，也不记写入后的整行。** 写入后的状态由"之前的状态 + 本事件 `status` 为 `applied` 的各项"得出；状态类表是把每一项的 `value` 赋给它的 `valid` 区间内的每个业务时刻，再按"相邻且各字段值都相同的点归为一段"规范化分段。这两步都是确定的，不含判定。
- `status` 为 `corroborated`：值与所见版本相同且显式指了证据。不产生新版本，只给该字段在这一项的 `valid` 区间上追加来源。**佐证端点** = 这次佐证的起点与**显式**终点里落在佐证项区间端点上的那些（默认终点解析出的端点不算）；它由这一项当前的 `status`、`valid` 与 `write.head` 的 `ops/<i>/valid` 原始写法得出，不另记。没有 `ops/<i>/valid` 的项（`resolve` 触发的写入、回掉写回的项，之后经删除重述为 `corroborated` 的）没有显式端点；这一块被删除移除时也没有，不拿"现在"补。
- **一项贡献的判定结果（生效状态、区间、`deps`）以日志里最近一次给出它的事件为准**：本事件，或之后某条 `deletion.confirmed` / `deletion.cancelled` 的 `restated/<k>`（§5.9）。之后的 `undo`、冲突判据、对它的引用都读最新的。
- **重放时遇到 `span` 块已被移除的项**：这一项在本事件处不落账；它由之后重述它的那条删除事件落账（没有被重述，说明它已不是贡献）。

`sources/<字段ID>/<k>`：

```json
[{"kind": "value", "source": 26}]
```

```json
[{"kind": "value", "carried": {"event": 39, "field": "f3", "k": 0}}]
```

| 条目 | 含义 |
|---|---|
| `{"kind":"value","source":<seq>}` | 值来源是一条源数据（`source.recorded` 的 `seq`） |
| `{"kind":"value","carried":{"event":<seq>,"field":<字段ID>,"k":<整数>}}` | 值是搬运来的（回退、采纳候选、回到合并基）：引用另一条 `write.base` 事件对该字段的第 `k` 项贡献。状态类表上搬运的区间就是这一项自己的区间（`span/<字段ID>/<k>`），这里不重复记。删除重放里，采纳项可以引用被采纳写入在重放里与所见同值、不再算贡献的那一项（下标是日志最近一次给出的那个，这次或更早的删除把它重述为 `dropped`）：值来源仍是它写入时那一块的来源；它不因此重新算贡献 |
| `{"kind":"schema_const","sv":<整数>,"field":<字段ID>}` | 值出自 schema 常量：第 `sv` 版切换时，这个字段的常量 `backfill` 补出的值（`field` 是该版里的字段 ID；表就是本事件的目标表）。值照常写在项里。不指向任何事件，常量本身不产生 `deps`（状态类表上这一项的区间出自一段补值段时，`span` 抄那一块 `backfill/…` 的 `deps`，§3.5）。这一项没有 `literal` 块 |

同一块里的多条 `source` 是"同时需要"；多条 `carried` 是"任一仍在即可"（采纳候选时并入的同值候选）。

`existence/<k>` 与 `span/existence/<k>`：

```json
{"status": "applied", "scope": "interval"}
```

```json
{"valid": {"from": "2026-11-10", "to": "2026-11-20"}}
```

"存在"与字段一样按项记：一次写入对"存在"的贡献是按区间排好的若干项，各项区间互不相交，`k` 从 0 起。调用方的一次撤销恒为一项；回掉写回的可以是几项（恢复存在的范围被别的写入隔成不相连的几段时）。

- `scope` 为 `whole`：撤销整行或整个实体。它不含内容，是纯粹的决定，没有值来源；撤销请求的证据记作操作来源（`op_sources`），证据被删也照记录、行不复活；这时没有 `span/existence/<k>`。
- `scope` 为 `interval`（只有状态类表）：等于"这段没有值"。区间记在 `span/existence/<k>`，它是内容。调用方给的撤销，来源是 `valid_sources`，来源被隐私删除后这次撤销整体没有贡献；证据里不作区间来源的段（`evidence_by_field` 的 `valid` 只映射到一部分段时的其余段）记作操作来源（`op_sources`）；只带起点的撤销，终点按 `next_change` 解析（任一字段在起点之后的第一个挡点），解析结果同样记在这里，并带 `deps`（给出那个挡点的贡献，两侧都算，§3.5）。
- 重放时 `scope` 为 `interval` 而 `span/existence/<k>` 已被移除：这一项在本事件处不落账，规则同字段项。
- **回掉写回的"存在"项**（带回退记录 `revert` 的写入）有两种，都按回掉的统一定义求得（见下）：
  - `restored: true`：被回掉的是一次撤销，取值位置上这一段是存在的 → 行或实体在这一段恢复存在。被撤销盖住的值本来就还在，不需要写回字段项；字段另有改动要回掉的，照常写回字段项。
  - 不带 `restored`：被回掉的是一次"恢复存在"，取值位置上这一段是不存在的 → 写回一项撤销，形状与普通撤销的项相同。它没有 `valid_sources`，区间的来源是 `span/existence/<k>` 的 `deps`。
  - 两种的 `scope` 与被回掉的那一项相同；`interval` 时 `deps` 含回退记录的条目覆盖的对应项、给出取值位置上状态的那一项、盖住被跳过部分的写入、这一项每个区间端点处取值位置上相邻两段状态的给出者。
- **采纳"存在"上的修改候选写的"存在"项**（事件类表、无时间表，带采纳记录 `take` 的写入）：`restored: true`、`scope` 为 `whole`，行恢复存在；没有 `revert` 块，不登记那次撤销——撤销之后另有生效的恢复存在时那次撤销不再算（03-deletion「重放规则」"字段的值"一行）。状态类表上采纳这类候选不写"存在"项，按填无值区间落字段项（必填字段从合并基搬运）。

`literal/<字段ID>/<k>`：

```json
{"segments": [{"source": 22, "result": "hit"}, {"source": 26, "result": "miss"}]}
```

按这一项引用的每段证据各记一条，`result` 取 `hit` / `miss` / `na`；`segments` 的次序与这一项的 `sources/<字段ID>/<k>` 相同。`result` 为 `na` 的情形：字段类型不适用、值为空，或这段证据没有可比的原文——`api_call`（它就是请求本身）、没带 `excerpt` 的 `file_ref`；带 `excerpt` 的 `file_ref` 按 `excerpt` 核对。核对器版本在头事件的 `ctx` 里。只有值来源是源数据（`source` 条目）的项有这一块：搬运来的项（`carried`）不重新做字面核对，没有 `literal` 块，它的核对结果看被搬运的那一项；来源是 `schema_const` 的项、`no_value` 与 `uncovered` 的项同样没有。

`revert`（回退记录）与"回掉"的统一定义：

`undo` 与 `take_previous` 是同一种操作——**回掉**——的两个取法。一次回掉由三样东西构成：

| | 是什么 | 怎么来 |
|---|---|---|
| ① 回退记录 | 回掉哪几次操作在哪些目标上的改动，逐条列（事件, 目标） | **照记录**。写入时列定，记在本块里；删除重放不改它 |
| ② 范围 | 在哪些业务时间上回掉（状态类表） | **重放里重求** |
| ③ 取值的位置与值 | 回到哪个位置的状态；那里的值是什么 | 位置**照记录**，值**重放里重求** |

```json
{"before_op": 25,
 "items": [{"event": 27, "field": "f3"}, {"event": 27, "field": "f1"}],
 "skipped": [{"event": 27, "field": "f1", "by_op": 33}]}
```

```json
{"as_of_op": 29, "item": "pi_3KD…",
 "items": [{"event": 35, "field": "f3"}]}
```

| 键 | 含义 |
|---|---|
| `before_op` | `undo`：取值的位置是这次操作**之前**的状态。它就是被撤回的那次写入的操作号 |
| `as_of_op` | `take_previous`：取值的位置是**截至**这个操作号的状态。它是解决时事项记下的合并基（`merge_base_op`），之后不重算。与 `before_op` 恰有其一 |
| `item` | `take_previous`：所解决的事项 |
| `items` | 回退记录的条目：`{"event", "field"}`，或对"存在"的一条 `{"event", "existence": true}`，**不带下标**。一条覆盖该事件在该目标上、在重放里的全部项：不论下标是写入时就有的还是由删除编出的，也不论写入时的状态。`include_later` 连带回掉的后来写入的条目另带 `"later": true` |
| `skipped` | 只有 `undo`：**这次 `undo` 写入时**已被后来的写入盖住而跳过的条目，形状同 `items` 的条目另带 `by_op`（盖住它的那次写入）；同一条目被几次写入分别盖住时各记一条。**这些条目同样列在 `items` 里**，这里只是另外标出当时的情况，供历史与回执使用；跳过的区间不记，删除重放不读它 |

**① 回退记录里列哪些条目**（写入时列定）：

- `undo`，被撤回的操作 m 是普通写入：m 在本行或本实体上每条基础写入 e、**e 写入时的每个目标 t**（字段或"存在"，按 e 写入时的块），**不论 e 在 t 上的项当时是生效、佐证、候选还是待确认**，也与它现在还剩哪些项无关（来源键字段除外；无操作的字段不进基础写入，不是目标）。被撤回的操作写入时是候选或待确认、之后因删除生效的部分因此同样回掉：人撤回的是那次操作，不是当时列得出的那几项。全部被跳过时照常记这条基础写入：没有写回项，只有 `target`、`op_sources` 与本块。
- `undo`，m 本身是一次回掉：m 的基础写入、**m 的回退记录里出现过的每个目标**（含"存在"），不论 m 写入时在该目标上有没有写回项。m 当时没有写回项时不能 `undo`（`invalid_argument`），"当时"按这次 `undo` 写入时的状态判、含待执行的删除：待执行的删除把 m 的写回项全部重述成 `dropped` 时被拒；待执行的删除让 m 有了写回项时被接受，之后撤回那次删除，这次 `undo` 覆盖不到任何项，末端与它从未被接受时相同。m 在这一行没有生效的项、且在这一行恰有一条经确认生效的待确认回掉时，取确认触发的那条基础写入与它的回退记录（§5.8），不取提议那条；m 在这一行另有生效的项时，撤回的是 m 自己的改动，那次回掉用确认的操作号撤回；m 没有生效的项、却有两条以上经确认的提议时，照"没有可撤回的改动"拒绝，各用确认的操作号撤回。
- `undo`，m 是一次确认（`resolve` 对写入类待确认事项的 `confirm`）：（m 的基础写入, **被确认的那次写入在它写入时的每个目标**），按被确认写入当时的块列，不看这次 `undo` 写入那一刻哪些目标实际生效、也不只取确认时在待确认的那几个。之后一次删除让被确认写入的别的目标经这次确认生效时，同样被这条记录回掉：人撤回的是那次确认。
- `include_later` 连带的后来写入：写入（或确认）时，后来的某一项生效（`applied`，不含佐证）、按回掉的步骤 3 取代被撤回操作的某个生效项、且区间相交时，列（该项的基础写入, 该项的目标），标 `later`。该目标不必是被撤回操作的目标：后来的撤销取代被撤回操作的字段项（列"存在"），后来的填值或恢复存在取代被撤回操作的撤销（列字段或"存在"）。后来的写入本身是回掉时，同样按它的项挑。
- `take_previous`：事项的冲突单元与区间内，**合并基之后、本次解决之前有项生效过的（事件, 目标）**。"生效过" = 在这段记录时间里落账为 `applied` 或 `corroborated`（写入时，或经删除重述），不论解决那一刻它是否已被后来的写入盖住、是否已被别的回掉登记过；含回退或回到合并基写回的项。目标是"存在"的事项，冲突单元是整行或整个实体：这段时间里对任何字段、对"存在"有项生效过的都列入。**事项的候选不进回退记录**，由事项的解决关闭。
- 记录不随删除重放改变。记录之外的操作不补：解决时还没生效、之后才因一次删除而生效的写入不在记录里；它对结果的影响完全由下面的范围规则决定（它排在回退记录的条目覆盖的某一项之后时算盖住那一项，三种表相同）。

**② 范围**：

- **一项的范围 = 它的区间，扣除仍被盖住的部分；`take_previous` 再与事项的区间取交；`undo` 里标 `later` 的条目上的项 x 再与 D(x) 取交。** D(x) = 被撤回的操作在重放里生效（或佐证）、不标 `later`、x 按步骤 3 取代的各项的区间之并（事件类表上是 ⊤ 或 ∅）：连带的后来写入只在与被撤回的操作相交的区间上回掉，超出的部分照旧生效。 "盖住"：在这一项之后、本次回掉之前，有不在回退记录里的已生效的项在该处取代了它（同一字段上更晚的值；撤销之上更晚的恢复存在或填值；字段值或恢复存在之上更晚的撤销）。事项的区间 = 仍存在的各候选的区间之并。
- **三种表是同一条规则。** 事件类表、无时间表上一项没有区间，当作一个不可分的整体：仍被盖住时范围为空，这一项**整项不回掉**；否则整项回掉。事项的区间在这两种表上是整个冲突单元，候选全都不在时为空。
- 写入时按当时的状态求，结果就是本事件写回各项的区间（`span/…`）之和；范围为空的项没有写回项。
- **删除重放时重新求**：各项取它在重放里的区间（被重述过就按重述后的），被删的操作不算盖住，被删的候选不计入事项的区间。所以盖住它的写入被删之后，原来跳过的部分（或整项）也回掉；被回掉的项的区间被重新解析之后，回掉的是新的整段；候选被删之后，事项的区间相应缩小。写入时没有写回项、重放后范围不再为空的，写回项由删除事件的 `restated/<k>` 首次给出（下标从该字段或"存在"在本事件里已用过的最大下标之后接着编）。
- **登记的效力只在范围内**：回退记录的条目覆盖的项在范围内不再生效，范围之外照常生效。

**③ 值**：范围内的每一处，取重放里"取值的位置"上的状态。字段一侧：该处有值，写回项以 `carried` 引用给出它的贡献（给出它的是 schema 切换的补值时不写 `carried`，来源写 `schema_const` 条目，`span` 的 `deps` 不列常量本身；状态类表上这一处出自一段补值段，抄那一块 `backfill/…` 的 `deps`）；没有任何贡献，写回 `no_value`；**该处在一次撤销之内，写回一条 `uncovered` 的项**——被回掉的项（在空洞里填值的那一项）登记之后不再算填值，撤销重新露出，这一处回到空洞，撤销之下的值没有动，之后撤销被回掉或被删时照常出现。"存在"一侧：该处是存在的，写回"恢复存在"；是不存在的，写回一项撤销。任何情况下都不会落回被回掉的项自己的值。

**不变式：本事件在一个字段（或"存在"）上写回各项的区间之和，就是这次回掉在该字段（或"存在"）上的范围。** 范围内处处有写回项（有值、`no_value`、`uncovered`、恢复存在、撤销之一）；`apply` 登记"已被回掉"只读这些项的区间，不自己求范围。回退记录的条目覆盖的一项登记在"它的区间与这个范围之交"上；标 `later` 的条目上的项 x 再与 D(x) 取交。只有范围为空（全部被跳过的 `undo`）时没有写回项。

**权威定义是参考求值器的伪代码**，在 [`03-data-model/03-deletion.md`](03-data-model/03-deletion.md)「重放规则 · 回掉的权威定义」；本节与其余文档的文字说明与它不一致时，以伪代码为准。

**被回掉的项是否生效，以回退记录为准，不看写回了什么。** 从本操作号起，`items` 列出的各（事件, 目标）在重放里的项，在范围内不再提供任何东西：不给值，不追加来源，它的佐证端点不再算挡点。来源表这样登记，之后的 `undo`、冲突判据、参考求值器都按它。

**写回的项**（两种取法规则相同）：

- `span/…`（及重述）的 `deps` 含：回退记录的条目覆盖的各项、给出取值位置上状态的贡献、盖住被跳过部分的写入；`take_previous` 另含各候选。另含：**写回项每个区间端点处，取值位置上相邻两段状态的给出者**，两侧都列（一侧没有任何贡献时只列另一侧；一侧在撤销之内时列那次撤销）。以上任何一项是状态类表的常量补值段时，常量本身不列，抄那一块 `backfill/…` 的 `deps`。例：#12 显式 `[10-01, 11-20) 5000`；#42 显式 `[11-10, 11-25) 4800`；`undo` #42 写回 `f2/0` 5000 `[11-10, 11-20)` 与 `f2/1` `no_value` `[11-20, 11-25)`。`f2/1` 的端点 11-20 是取值位置上 #12 那一段的终点，`f2/1` 的 `deps` 是 `[#42/f2/0, #12/f2/0]`；删除 #12 的来源时这一块随之清除。
- 它们与普通贡献一样参加删除重放的同值重算（§5.9），有两条限定：
  - 回退记录的条目覆盖的项里还有在重放里是贡献的（含佐证）、且范围非空时，写回的项**不因为与之前同值而被丢掉**（它的作用是让那些项不生效）。
  - 回退记录的条目覆盖的项在重放里全都不是贡献，或范围为空时，写回的项成为 `dropped`。例：`take_previous` 之后候选全被删，事项的区间为空，生效的一方照常生效；生效的一方全被删而候选还在，写回的项为 `dropped`，候选保持已关闭。
- 一条写回项对应的、回退记录的条目覆盖的项只有一部分不再是贡献时，把它的区间重述窄即可。

**回掉的目标本身是一次回掉**（撤回一次撤回；撤回一次 `take_previous` 的解决）：按普通写入处理，回掉的是那次写回的各项，取值的位置是那次操作之前。回退记录列的是那次回掉的基础写入在它的回退记录里出现过的每个目标（见上面的列法），所以它之后因删除长出的写回项同样被覆盖。那次操作登记为"已被回掉"的项**登记不变**，它们的值经由这次的写回项（搬运自它们）重新出现。被撤回的是一次 `take_previous` 的解决时，事项保持已解决。

**回退记录的条目在删除重放里覆盖什么**：一条（事件, 目标）覆盖该事件在该目标上、在重放里的**全部项**，不论下标是写入时就有的还是由删除编出的，不论写入时的状态。所以同一（事件, 目标）的各项总被同一组回掉覆盖，**不再有因覆盖不同而切开的情形**。任何写入的项都按下面的分项与编号规则，不只回掉的写回项：

- **一项在重放里的区间是它的状态与内容相同的极大连续段。** 写回项的"内容"含给出者：给出者不同的相邻段不并，否则 `carried` 只剩一个，删掉另一个给出者时级联不对。
- **原有项**沿用它的下标，留在与它写入时区间块相交的第一段上；几条原有项落进同一段时**一律并成一项**，留下标最小的，其余重述为 `dropped`。写入时的区间块在这次确认或撤回之前已被某次到期执行的删除清掉的原有项，按下一条里"之前由删除编出的下标"同样处理，用它的原区间：清掉那一块的删除必定重述过它（§5.9「哪些项要重述」第 2 条），所以原区间总读得到。没有任何可读区间块的原有下标（曾重述为 `dropped`、之后又成为贡献的）按起点顺序从小到大依次用回，不另编新号——`carried`、`premise_covers` 可能还指着它。
- **新分出来的项**从该目标已用过的最大下标之后接着编。之前由删除编出的下标留在与它原区间相交的第一段上（原区间 = 本次重放之前日志里最近一次给出这一项的区间：按日志顺序往前找，跳过被撤回的删除的确认事件给出的块，也跳过重述为 `dropped` 的，取第一块给出了区间的；被撤回的删除给出的块在任何重放里都不作原区间，撤回事件自己的重述照算）。最近一次给出的块只用于这类下标保留编号。
- **新编出的下标从哪一项分出**，以基础写入事件写入时给出的区间块为准（它固定在日志里，不随删除的先后、也不随被撤回的删除变）：看新下标在这次重放里的区间起点落在哪一条原有项写入时的区间里；落在各区间之外或空隙里，归左邻（按写入时区间的起点排序，在最前面时归第一项）。写入时的区间块已被到期执行的删除清掉的原有项，在这里用它的原区间。它只用于编号与前提声明的第 2 部分（`premise_covers`，见 [`03-data-model/02-integrity-and-records.md`](03-data-model/02-integrity-and-records.md)「写入的前提」），不影响回掉的覆盖。
- **偏离二按（事件, 目标）写入时各项的状态判，不按区间、也不按幸存的下标判**：普通写入或撤销在一个目标上写入时各项全部是 `applied` 或 `corroborated` 的，重放里这个目标上的各项都受保护；有一项不是的，各项都按重放判（[`03-data-model/03-deletion.md`](03-data-model/03-deletion.md)「删除结果的定义」偏离二）。读的是本事件 `fields/<字段ID>/<k>`、`existence/<k>` 的 `status`，不读 `span`：`span` 带 `deps`，会被别的删除清掉，状态块只随这项贡献自己的来源清除。带 `revert` 或 `take` 的基础写入、`cause` 为 `resolve` 的基础写入不经这条判据；一次回掉写入时是待确认还是已生效，看同一操作里有没有 `origin_event` 指向它的 `awaiting_confirmation` 事项，不读写回项的状态块。
- 下标仍是寻址：重述、`carried`、`deps`、`candidates/<k>.items`、`kept_effective/<k>.items`、前提声明第 2 部分的 `premise_covers` 都按下标引用。

**回掉状态的判定次序**：一次重放的结果里哪些回掉生效（写入时生效、经确认生效，或因删除生效——那时它的记录是提议时列的那一份），按操作号顺序逐个判定：判定某次回掉时，早于它的回掉按已判定的状态算，它自己按生效算；判定一次即定，不因之后的回掉或判定的结果回头重判；结果里的登记算的是全部判为生效的回掉。它自己按生效算，高影响 ④ 因此在它生效时的状态里判（见 [`03-data-model/05-time.md`](03-data-model/05-time.md)「高影响写入」）。

例（回掉一次"恢复存在"）：操作 20（#22）撤销 `[11-05, 11-15)`；操作 30（#32）`undo: 20`，写回 `existence/0 {applied, interval, restored}`；操作 40 `undo: 30`，基础写入 #42。取值位置是操作 30 之前，那时这一段是不存在的，所以写回一项撤销：

```
existence/0        {"status":"applied","scope":"interval"}
span/existence/0   {"valid":{"from":"2026-11-05","to":"2026-11-15"},"deps":[{"event":32,"existence":0},{"event":22,"existence":0}]}
revert             {"before_op":30,"items":[{"event":32,"existence":true}]}
```

例（恢复存在的范围是两段）：实体全程有值；操作 20（#22）撤销 `[11-05, 11-15)`；操作 25 在空洞里填了 `[11-08, 11-10)`（带齐必填字段）；操作 40 `undo: 20`，基础写入 #42：

```
existence/0        {"status":"applied","scope":"interval","restored":true}
span/existence/0   {"valid":{"from":"2026-11-05","to":"2026-11-08"},"deps":[{"event":22,"existence":0},{"event":27,"field":"f2","k":0}]}
existence/1        {"status":"applied","scope":"interval","restored":true}
span/existence/1   {"valid":{"from":"2026-11-10","to":"2026-11-15"},"deps":[{"event":22,"existence":0},{"event":27,"field":"f2","k":0}]}
revert             {"before_op":20,"items":[{"event":22,"existence":true}]}
```

例（撤回一次在空洞里填值的写入）：实体全程 5000（#12）；操作 20（#22）撤销 `[11-05, 11-15)`；操作 25（#27）在空洞里填了 `[11-08, 11-10) 3000`；操作 40 `undo: 25`，基础写入 #42。取值位置（操作 25 之前）上这一段在撤销之内，写回一条不带内容的项：

```
fields/f2/0   {"status":"applied","uncovered":true}
span/f2/0     {"valid":{"from":"2026-11-08","to":"2026-11-10"},"deps":[{"event":27,"field":"f2","k":0},{"event":22,"existence":0}]}
revert        {"before_op":25,"items":[{"event":27,"field":"f2"}]}
```

`apply` 按 `span/f2/0` 把 #27 的项登记为"已被操作 40 回掉"，它不再算填值，`[11-08, 11-10)` 回到 #22 的空洞；实体的 `ver` 换成 `v40.0`。之后操作 50 `undo: 20`：撤销被回掉，写回"恢复存在" `[11-05, 11-15)`；`[11-08, 11-10)` 上 #27 与 #22 都已被回掉，露出 #12 的 5000，全程 5000。

例（没有值）：实体已有 #12 `[10-01, 11-01) 5000`，11-01 之后没有值；#22（操作 20）在空着的时间里填了 `[11-02, 11-20) 3000`；操作 40 `undo: 20`，基础写入 #42：

```
fields/f2/0   {"status":"applied","no_value":true}
span/f2/0     {"valid":{"from":"2026-11-02","to":"2026-11-20"},"deps":[{"event":22,"field":"f2","k":0}]}
revert        {"before_op":20,"items":[{"event":22,"field":"f2"}]}
```

`apply` 把该字段在 `[11-02, 11-20)` 上置为没有值；必填字段没有值的业务时刻成为无值区间。来源表里 #22 的第 0 项登记为"已被操作 40 回掉"。事件类表上的例子：撤回"第一次填备注"的那次写入，写回 `fields/f4/0 {"status":"applied","no_value":true}`，备注回到没有任何贡献的状态。

例（`take_previous`，生效一方的区间比事项的区间大）：#12 `[10-01, ∞) 5000`；L（操作 20，基础 #22）显式 `[11-02, 12-01) 3000`，已生效；A（基础 #27）带旧 `ver` 写显式 `[11-10, 11-15) 4000`，成为候选，事项的区间是 `[11-10, 11-15)`，合并基是操作 10。操作 40 以 `take_previous` 解决，基础写入 #41：

```
fields/f2/0   {"status":"applied","value":{"value":"5000","unit":"CNY"}}
sources/f2/0  [{"kind":"value","carried":{"event":12,"field":"f2","k":0}}]
span/f2/0     {"valid":{"from":"2026-11-10","to":"2026-11-15"},"deps":[{"event":12,"field":"f2","k":0},{"event":22,"field":"f2","k":0},{"event":27,"field":"f2","k":0}]}
revert        {"as_of_op":10,"item":"pi_…","items":[{"event":22,"field":"f2"}]}
```

L 只在 `[11-10, 11-15)` 上被回掉，两侧的 3000 照旧。

`apply`：

| 看什么 | 改什么 |
|---|---|
| `fields/*/*` 里 `status: applied` | 业务表当前版本的对应字段（状态类表：按 `span/*/*` 的区间逐项赋值后规范化分段）。目标行或实体在重放到这里时不存在（创建它的写入的块已全部移除）的，建一行，只含这次写入给出的字段；它与线上的中间状态不必相同，末端由删除结果整行给出（§5.9）；版本表在受影响的单元格上各加一个版本，记录时间区间从本操作号起（版本表按一次操作结束时的状态落格：同一操作里几条 `write.base` 改到同一格时，后一个 op 覆盖前一个 op 的值，格子记最后给值的那一项贡献，见 [`02-architecture.md`](02-architecture.md) §8）；`counts` |
| `fields/*/*` 里 `applied`、`corroborated`；`existence/*` 里 `applied` | `base_sources`（字段 × 项 × 来源；状态类表带区间）。"存在"项的字段 ID 一栏用固定值 `existence`（字段 ID 都是 `f<n>`，不会相撞） |
| 各块的 `deps` 与 `carried` | `block_deps`（块 → 它依赖的贡献），供删除找级联的块 |
| `existence/*` 里 `applied`、不带 `restored` | 业务表的已撤销标记或无值区间（区间取 `span/existence/<k>`）；版本表 |
| `fields/*/*` 里 `no_value` | 该字段在这一项的区间上置为没有值；版本表 |
| `fields/*/*` 里 `uncovered` | 不赋值。该字段在这一项的区间上取登记之后露出的那一项（最后一个生效、没被登记回掉的字段项或撤销）；版本表 |
| `revert` | **只在这次基础写入生效时登记**：`base_sources` 里把 `items` 列出的各（事件, 目标）在当前的项登记为"已被本操作回掉"（登记的范围只读块：不标 `later` 的条目上的项（`undo` 里是被撤回操作自己的项，`take_previous` 的条目都不标）登记在"它的区间 ∩ 本事件在同一字段或'存在'上写回各项的区间之和"上；标 `later` 的条目上的项 x 再与 D(x) 取交，D(x) 由 `apply` 自己算：被撤回操作的项里，状态为 `applied` 或 `corroborated`（来源表里的当前区间，被删除重述过的按重述后的）、且 x 按回掉的步骤 3 能取代的那些项的区间之并，取代关系只看内容的种类，都在块里；之后被删除事件重述的，按重述后的区间）。这次写入进了待确认时不登记，确认生效时（由那次解决触发的落账）登记；待确认的回掉因一次删除不再属高影响、在自己的写入号生效时，由那条删除事件的落账登记（用提议时列的回退记录）；被拒绝或被取代则不登记。全部被跳过的 `undo` 算已生效，没有写回项，登记的范围为空。登记"已被回掉"只有这一条路径 |
| `take` | 无。`take` 不登记回掉：覆盖集里的写入由采纳写下的项按普通的取代关系盖过 |
| `existence/*` 里 `applied`、带 `restored` | 业务表在该范围内撤掉已撤销标记或无值区间；版本表 |
| `candidate`、`awaiting` | 不改业务表与版本表 |
| `duplicate` | 无（标记由 `item.created` 得出） |
| 键字段的 `fields/<键字段ID>/0`（`applied`） | 键索引 `external_keys`：按新值登记这一行的条目。撤销不动条目 |
| 由 `target.op_index` 找到的本 op 的前提声明 | `premise_edges`：本事件的全部项（不论生效、候选还是待确认）登记为被这些声明覆盖。这一部分按（事件, 目标）覆盖：之后删除重述在本事件上新编出的下标同样被覆盖 |

这一行或实体的 `ver` 在这次操作改变了它的版本表（开或关了格，意图不是 `schema_switch`）时换成本操作号，与契约里 `ver` 的定义（最近一次改动它当前状态的操作号）一致。写回项生效、但露出来的仍是原来在生效的那一项时，版本表不变，`ver` 也不变：例如操作 30 写 `[11-05, 11-07)`，操作 43 回掉它（写回 `uncovered`，露出更早的撤销），操作 80 再回掉操作 30——它的写回项照样生效、照样登记，露出来的还是那条撤销；被更晚、未回掉的项盖住的写回项同理。

例（状态类表，`undo` 一次覆盖了两段的写入）：基础 #12 `[10-01, ∞) 5000`；#15 `[11-10, ∞) 4000`；#22 `[11-02, 11-20) 3000`；操作 30 `undo: 20`，基础写入 #32：

```
fields/f2/0   {"status":"applied","value":{"value":"5000","unit":"CNY"}}
sources/f2/0  [{"kind":"value","carried":{"event":12,"field":"f2","k":0}}]
span/f2/0     {"valid":{"from":"2026-11-02","to":"2026-11-10"},"deps":[{"event":12,"field":"f2","k":0},{"event":15,"field":"f2","k":0},{"event":22,"field":"f2","k":0}]}
fields/f2/1   {"status":"applied","value":{"value":"4000","unit":"CNY"}}
sources/f2/1  [{"kind":"value","carried":{"event":15,"field":"f2","k":0}}]
span/f2/1     {"valid":{"from":"2026-11-10","to":"2026-11-20"},"deps":[{"event":12,"field":"f2","k":0},{"event":15,"field":"f2","k":0},{"event":22,"field":"f2","k":0}]}
revert        {"before_op":20,"items":[{"event":22,"field":"f2"}]}
```

#### `write.derived`（派生写入）

规则引擎刷新一个派生行。

| path | 种类 | 内容 | 来源 |
|---|---|---|---|
| `target` | 元 | `{"table": "t2", "rule": "r1", "rule_version": 1, "partition": "p_8WM…", "read_pos": <seq>, "reads": [{"table": "t1"}], "emptied": <布尔>}` | — |
| `key` | 数 | 分组键值：`{"values": ["2026-11-01"]}`，按分组键字段在派生表里的字段 ID 顺序，与 `GROUP BY` 里写的次序无关；不分组的整体聚合：`{"values": []}` | 落进该分组的基础行在分组键所依赖字段上的贡献 |
| `checksum` | 数 | `{"checksum": <哈希>}`：这次刷新结果的校验和（§5.13） | 读集里的基础贡献 |

- `read_pos`：刷新时读到的日志位置：本操作里派生刷新开始之前最后一条事件的 `seq`。同一次操作的各条 `write.derived` 相同（整批刷新在同一个位置上算出）。
- `reads`：读了哪些基础表，不重复，按表 ID 的字符串顺序（`t10` 在 `t2` 之前）。第一版只记到表一级；更细的读集将来作为新增的可选键加入，不改已有事件。
- `emptied`：`true` 表示这个分组刷新后没有行了，派生行删除。这时没有结果，所以没有 `checksum`，也没有 `key`；`emptied` 为 `false` 时必有 `checksum`（被列入删除的位置列表时按 §1.1 仍算有）。
- `key` 只在两种情况下有：这个 `partition_id` 第一次出现（登记"分组键值 → `partition_id`"的映射）；上一次登记映射的 `key` 块已被列入某次删除的位置列表，而这个分组又有了行（重新登记）。
- 分组因删除而变空时，登记映射的 `key` 块列入位置列表。
- 分组变空（`emptied`）之后同一分组键又有了行，沿用原来的 `partition_id`，不论变空是因为撤销还是删除；映射的 `key` 块还在时这条派生写入不再带 `key`。
- `checksum` 用来核对，不用来生成；读集里有贡献被删除时列入位置列表，之后按时刻还原该派生值时跳过核对。
- 删除确认与撤回删除里，受影响的行所落的每个分区都有一条，结果没变也有（§4.4）。
- `apply`：按 `rule_version` 的规则在当前基础数据上重算这个分区，写进派生表；有 `checksum` 就核对；维护 `partitions`、`derived_reads`。派生行的版本是本操作号。

### 5.8 待处理事项

事项的当前状态完全由这五种事件（以及删除生命周期事件）算出。事项版本对外编码（事项 ID，事项内容最近一次变化的操作号，租户恢复次数）。

事项内容按条目切块。条目块里的值与区间都出自别的写入，所以每个条目块都带 `deps`（§3.5）：

```json
"deps": [{"event": 39, "field": "f3", "k": 0}]
```

`deps` 列出条目里的**值与区间端点**所出自的全部贡献：写下这个值的那一项，以及把这一段截成现在这样的那些贡献。`deps` 列出的贡献被隐私删除或被重述时，这个条目块列入位置列表；事项仍未决的，随后的 `item.refreshed`（`entries_deleted`）重新给出条目，候选与 `matched` 条目也在内。

**引用的命名**（全文一致）：

| 值是什么 | 键名 |
|---|---|
| 操作号 | `op`，或以 `_op` 结尾 |
| 事件 `seq`（`write.base`、头事件等） | `event`，或以 `_event` 结尾；指向内容块的再带 `field` 与 `k`（或 `"existence": <k>`），或带 `path` |
| 源数据（`source.recorded` 事件的 `seq`） | `source`，或 `sources`、以 `_sources` 结尾（`valid_sources`、`op_sources`） |
| 日志位置 | `read_pos`（`write.derived`）：读到的最后一条事件的 `seq` |

位置列表里块地址的 `seq` 是地址的一部分。

#### `item.created`

| path | 种类 | 内容 | 来源 |
|---|---|---|---|
| `target` | 元 | 见下 | — |
| `scope_valid` | 数 | 状态类表：事项覆盖的业务时间区间，逐段给出 `{"spans": [{"from": …, "to": …}, …], "deps": […]}`。只有这一种形状，一段时也是长度为 1 的 `spans`；各段按起点升序、互不相交也不相接（相接的合成一段）、粒度一致（都按日或都按时刻）；只有第一段可以缺 `from`（起点开口，例如整段时间上的写回被别的项切开后、回掉它的事项覆盖的那一段），只有最后一段可以缺 `to`（开口）；两端都给时 `from` 早于 `to`。整段时间写成 `[{}]`（例如整实体撤销成为候选），它既是第一段也是最后一段，不与别的段并列。并入与相交的判断把开口的起点当作负无穷、开口的终点当作正无穷。整段时间也明写出来，不用"没给 `scope_valid`"表示：在 `item.merged`、`item.refreshed` 里没给有别的读法（零块即空组）。落账进标记时，整段时间不存区间。不取各段的外包：标记、"改到"的判断与执行都按 `spans` 逐段走。**回退类的待确认事项（提议是一次 `undo`）**：`spans` 是按当前状态判定这次确认会写回的各项区间之并，即确认时实际写的区间，随刷新重算 | `deps`：各候选或提议的那几项贡献；回退类的待确认事项另加这次判定列出的回退条目所对应的贡献（范围取决于它们现在的样子） |
| `current/<k>` | 数 | 当前生效值的一段：`{"field": "f3", "value": …, "valid": {…}, "op": <写下它的操作号>, "deps": […]}`。`valid` 只在状态类表上有，本表 `proposed`、`previous` 与 `impact` 的 `overwritten_segment` 同样；"存在"的条目整段时间写 `{}`、起点开口写 `{"to": …}`（§1.2，例如"存在"事项里整实体撤销留下的那一段），字段的条目总有 `from` | `deps` |
| `candidates/<k>` | 数 | 一个候选（一次写入在这个冲突单元上的全部候选项），见下 | `deps` |
| `proposed/<k>` | 数 | 待确认的提议在一个字段上的值：`{"field": …, "value": …, "valid": {…}, "deps": […]}` | `deps` |
| `previous/<k>` | 数 | 合并基上的值的一段：`{"field": …, "value": …, "valid": {…}, "deps": […]}`。`take_previous` 会回到它 | `deps` |
| `impact/<k>` | 数 | 执行后会改掉什么的一条，见下 | `deps` |
| `matched/<k>` | 数 | `flagged`：疑似重复的另一行 `{"row": …, "deps": […]}`。`flagged` 事项必有，从 0 起无空号，至多 10 条，各行一次，不含被标记的那一行，次序同 `write.base` 的 `duplicate.matched`；`flagged` 事项只有 `target` 与这一组，别的类型没有这一组 | `deps` |

`target`：

```json
{
  "item": "pi_3KD…",
  "type": "conflict",
  "reason": "stale_write",
  "table": "t1",
  "row": "r_01JC9A…",
  "unit": ["f3"],
  "merge_base_op": 29,
  "origin_event": 39,
  "ruleset_version": 1,
  "policy_version": 1
}
```

| 键 | 含义 |
|---|---|
| `item` | 事项 ID |
| `type` | 事项类型（§6.4） |
| `reason` | 成因码（§6.6） |
| `table`、`row` / `entity` | 目标所在。`schema_change` 事项没有，改为 `draft` |
| `unit` | 冲突单元，一律是数组：一个字段（`["f3"]`），或 schema 声明的一个字段组里的全部字段（各字段 ID）。目标是"存在"（撤销参与的冲突）时写 `["existence"]`。`awaiting_confirmation` 事项：提议涉及"存在"时写 `["existence"]`（整行或整段，字段不另列），否则是提议涉及的全部字段，按字段 ID 排序。`flagged` 事项可缺（标记的是整行）；`schema_change` 没有 |
| `merge_base_op` | `conflict` 必有，其余类型没有：合并基的操作号（各候选所带 `ver` 中最早的那个版本） |
| `origin_event` | 由写入引起的事项（`conflict`、`awaiting_confirmation`、`flagged`）必有：引出这个事项的 `write.base` 事件的 `seq`。`schema_change` 没有 |
| `draft` | `schema_change` 必有，其余类型没有：草稿 ID |
| `related_item` | 当且仅当成因为 `restored_candidate`：候选原来所在的那个事项（第一版不出现） |
| `ruleset_version`、`policy_version` | 判定这个事项时用的两个版本 |

冲突单元是"存在"的事项（过期写入撞上撤销，或撤销成了候选），`current/<k>` 与 `previous/<k>` 只记这个单元上的东西，两种条目都列：
- 被撤销的段：`{"field": "existence", "revoked": true, "valid": {…}, "op": <那次撤销的操作号>, "deps": […]}`；
- 有值的段：`{"field": "existence", "valid": {…}, "deps": […]}`，不带 `revoked`、`op`、`value`，`deps` 是让这一段有值的那些贡献。

`valid` 只在状态类表上有（事件类表与无时间表上整行一条），`previous` 里同样。事项区间里两种条目都没盖到的段，没有值、也不是撤销造成的（例如在从未写过的一段里填了值、这次填值又被撤回之后的那一段）。洞里的填值被撤回之后，那一段回到撤销留下的空洞，条目是撤销条目。条目不列各字段的值。契约里冲突事项的 `effective` 与 `previous`（`{seq, exists, values?, spans?}`）、待确认事项的 `current` 在读取时组装：按事项版本的操作号（`previous` 按合并基的操作号）读这一行当时的状态，限定在事项的各段与冲突单元的字段上（单元是"存在"时给整行的值），不从这些条目推，也不进事项内容（[`04-contract-types.md`](04-contract-types.md) 4.8）。

**一次请求里的事项内容**：事项版本的操作号是这次请求的，分不出请求里的第几个 op；回执给出事项的全部内容就算读过。所以事项的内容按整次请求结束时的状态算：
- 一次请求里，每个事项至多产生一组内容。这次请求新开的事项，`item.created`（以及请求里后来的 op 并入它的 `item.merged`）的条目按请求结束时的状态；已有的事项被这次请求里任何一个 op 改到，只在全部 op 的事件之后算一次刷新或取代，条目同样按请求结束时的状态，`by_event` 是最后一个改到它的 `write.base`。
- 是否"读过"按请求开始时事项的版本判。这次请求并入过的事项一律按没读过，与并入、改到的先后无关：不取代（取代会把这次请求刚并进去的候选一起丢掉），被改到时刷新，事件里记 `writer_had_read: false`。
- 被改到的事项，`by_event` 逐个 op 判：比较每个 op 之前与之后事项单元上的生效值，最后一个确实改了的 op 的 `write.base`；改了又改回的，按最后那次算。
- 这次请求新开的 `flagged` 事项，到请求结束时已没有任何列出的行命中（或被标记的行已被撤销）的，不开：`matched` 至少一行，按结束时的状态它没有条目。写入里的 `duplicate` 块照写，它是写入时的判定。
- 这次请求并入了、又没有哪个 op 改到的事项，并入带来的内容变化由 `item.merged` 自己给出（它带 `current`），不另出 `item.refreshed`，回执只标 `merged`。
- 内容不能悄悄过期：一次请求结束时，对它写过的每一行上没被改到的未决事项重算内容（条目连同 `op`、`deps`，以及影响），与现有内容不同就刷新（`cause` 为 `entries_changed`），只刷新、不取代，不看读没读过。例如同一段被第二次撤销，"存在"事项的条目改指后一次撤销；字段单元上的同值佐证，值没变、不算改到，但影响里多了一次写入。
- 回执的 `pending[]` 里每个事项只出现一次，带上适用的标记（`merged`、`refreshed`；这次请求新开的事项给 `item_ver`，不标 `merged`）；被取代的只出现在 `superseded[]`。

"改到"也按冲突单元：事项的冲突单元是字段时，看这些字段在事项区间里的状态有没有变；是"存在"时，只看有值与无值的变化（状态类表逐段看该段是否有值，事件类表与无时间表看整行是否被撤销），字段值的改动不算改到它——事项内容里没有字段值，字段值变了事项内容不变，不该刷新。

`candidates/<k>`：

```json
{"event": 39, "intent": "correct",
 "seen": {"op": 29, "restore_count": 0},
 "cause": "stale_write",
 "items": [{"field": "f3", "k": 0, "value": {"value": "32", "unit": "CNY"}}],
 "deps": [{"event": 39, "field": "f3", "k": 0}]}
```

**一个候选 = 一次写入在这个冲突单元上成了候选的全部项**，一个候选一条。冲突单元是字段组时，同一次写入改了组里两个字段，是一个候选、`items` 里两项；状态类表上一次写入在这个单元上被切成几段、其中几段成了候选，也是一个候选、`items` 里几项。同一条 `write.base` 在同一个事项里至多是一个候选。

- `event` 是候选所在的 `write.base` 事件的 `seq`（写入者即该事件的 `actor`）；`seen` 是候选所带的 `ver`（按来源键的写入是这个冲突单元各字段的同步基线位置中最早的那个，取自 `ops/<i>/baseline`）；`cause` 见 §6.7。
- `items` 逐项列出：`field` 与 `k` 指明是那条事件的哪一项，`value` 是它的值；状态类表每项另有 `valid`（这一项的所见区间）。候选是撤销时 `intent` 为 `revoke`，`items` 里是 `{"existence": <k>}`（带区间的撤销另有 `valid`），没有 `field` 与 `value`。
- `deps` 含 `items` 里的每一项，以及截出这些区间的贡献。
- 事项的候选项（采纳与回到合并基所说的 K）按（`event`, 事项 `target.unit`）认，不按 `items` 里的下标：删除让同一次候选写入的几项合并、留最小下标时，按下标认会认丢。
- **下标 `k` 就是候选号**，全文只有这一套：契约 `Candidate.index`、`resolve` 的 `candidate`、`item.resolved` 的 `candidate`、`item.refreshed` 的 `dropped_candidates` / `restored_candidates` 与它重新给出的 `candidates/<k>`，指的都是它。`take_candidate` 采纳该候选的**全部项**。
- 候选的一部分项因隐私删除不再是贡献、其余仍在时，候选还是这个候选（下标不变）：原条目块按 `deps` 清除，随后的 `item.refreshed` 用同一个下标重新给出只含剩余项的条目。因这次删除不再是这个事项里的候选的，才列入 `dropped_candidates`：成因被删而生效、转为待确认（由接替的事项接着）、被回退记录覆盖、全部项都被删掉；同一事项里还有候选仍未决时，事项刷新而不被取代。

`impact/<k>` 的形状随成因：

| 成因 | 形状 |
|---|---|
| 抹掉变化点（高影响 ①）、跨空洞填值 | `{"kind": "overwritten_segment", "field": …, "valid": {…}, "value": …, "op": <写下这一段的操作号>, "deps": […]}` |
| 撤销仍被引用的行（高影响 ②） | `{"kind": "referencing_row", "table": …, "row": …, "field": …}`；引用方在状态类表上时写 `entity` 代替 `row` |
| `undo` 带 `include_later`（高影响 ④） | `{"kind": "reverted_write", "op": <操作号>, "deps": […]}` |
| `conflict`：`take_previous` 会回掉的写入 | `{"kind": "reverted_write", "op": <操作号>, "deps": […]}` |
| `conflict`：候选若生效会属高影响时，它会覆盖的段 | `{"kind": "overwritten_segment", …}`。只在把这个候选的各项放到当前状态之上生效会抹掉当前的变化点时列（与写入判高影响 ① 同一个判法，逐个候选判；只有状态类表有变化点）；`deps` 另含该候选的那几项，读的一方据此分出是哪个候选的 |

`overwritten_segment` 覆盖的是无值的段（会被填上的无值区间）时带 `"gap": true`，`value` 为 `null`，`op` 是留下它的那次撤销，没有撤销留下它时不给 `op`；契约里它进 `filled_gaps`。被显式清空成 `null` 的字段值是一个值，不是无值的段：它不带 `gap`，`op` 是清空它的那次写入，契约里进 `overwritten`。不带 `gap` 的块必有 `op`。

`apply`：`pending_items` 加一行（状态未决，事项版本 = 本操作号）；`pending_entries` 登记各条目块的位置；按事项类型设标记：`conflict` → `disputed`（带事项、`unit` 里的字段、区间），`awaiting_confirmation` → `awaiting`（同上），`flagged` → `flagged`。

#### `item.merged`

新的候选并入已有的冲突事项。

| path | 种类 | 内容 |
|---|---|---|
| `target` | 元 | `{"item": "pi_…", "merge_base_op": <操作号>, "origin_event": <seq>, "ruleset_version": …, "policy_version": …}` |
| `candidates/<k>` | 数 | 新并入的候选。`k` 接着该事项已有候选的下标往后编，整个事项生命周期内不复用 |
| `scope_valid`、`previous/<k>`、`impact/<k>` | 数 | 合并后重算的结果，**整组取代**该事项之前的同名条目。这几组每次都整组给出，零块即空组 |
| `current/<k>` | 数 | 合并后（按整次请求结束时的状态）的当前生效值，整组取代之前的 `current`；没给出 `current` 的 `item.merged` 沿用之前的 |

`apply`：事项版本换成本操作号；之前的 `previous/*`、`impact/*`、`scope_valid` 条目作废（块本身仍在各自的事件里）。

#### `item.refreshed`

事项的目标被一次没读过它的写入改到，或高影响 ② 的引用方有变化，或一次请求结束时重算出的内容变了：事项保持未决，内容更新。

| path | 种类 | 内容 |
|---|---|---|
| `target` | 元 | `{"item": "pi_…", "by_event": <seq>, "writer_had_read": <布尔>, "cause": "target_overwritten" \| "references_changed" \| "entries_deleted" \| "entries_restored" \| "matched_changed" \| "entries_changed", "dropped_candidates": [<下标>], "restored_candidates": [<下标>], "merge_base_op": <操作号>}` |
| `current/<k>`、`previous/<k>`、`impact/<k>`、`proposed/<k>`、`scope_valid` | 数 | 刷新后的结果，整组取代之前的同名条目。**这几组每次都整组给出，零块即空组**；没有"没给出即不变"的读法 |
| `matched/<k>` | 数 | `flagged` 事项仍命中的那几行，形状与 `item.created` 里的相同（带 `deps`）。**给出时整组取代之前的 `matched`**，从 0 起重新编号；没给出时不变。只随四种成因出现：`matched_changed`（必有，且只有这一组：一部分行不再命中时给出其余的，保持原来的先后；全都不再命中时事项被取代，不刷新）、`entries_changed`（行都仍命中，但有的行改由别的贡献给出命中的值：整组重新给出，`deps` 指向现在给出的贡献，先后不变）、`entries_deleted`（条目块被一次删除清掉而行仍命中时整组重新给出）、`entries_restored` |
| `candidates/<k>` | 数 | 重新给出的候选条目，形状与 `item.created` 里的相同（带 `deps`）。**沿用原下标 `k`，只取代同下标的那一条**，没给出的保持原样。用在两处：条目块被一次删除清掉而条目仍在（例如候选的所见区间被重新解析，或候选少了一项而其余项仍在，候选仍是候选）；撤回删除时放回被去掉的候选 |

- `cause` 为 `entries_changed`：一次请求结束时，事项没被改到，但重算出的内容与现有不同（"一次请求里的事项内容"）；`by_event` 是这次请求在这一行上最后一条 `write.base`；没有 `writer_had_read`。
- `writer_had_read`：写入方当时是否读过这个事项的当前版本。写入时查一次读取审计，把结果记在这里，重放不重算。`cause` 为 `target_overwritten` 时恒为 `false`（读过就是取代，不是刷新）。
- `cause` 为 `entries_deleted`：隐私删除清掉了事项的部分条目而事项仍未决（例如去掉了一个候选），`dropped_candidates` 列出被去掉的候选下标；同一次删除里另有候选回到这个事项时，`restored_candidates` 一并列在这一条里（一次操作里每个事项至多一条 `item.refreshed`，§4.2）；此时没有 `by_event`。`by_event` 是改到事项目标的那条 `write.base` 事件（`references_changed` 时是引用方的那条）。
- `cause` 为 `matched_changed`：`flagged` 事项比中的两行里任何一行（被标记的那一行，或被比中的另一行）被撤销或改动，有的行不再命中，事项仍未决；`by_event` 见 `item.superseded` 的同一原因。`cause` 为 `entries_changed` 而事项是 `flagged` 的：列出的行都仍命中，只是给出命中的值的贡献变了（例如两行在同一个请求里都改成同一个新值）；不重新给出的话，以后删到新贡献的来源时条目块不在位置列表里（§3.5）。`flagged` 事项不看读没读过，没有 `writer_had_read`。
- `flagged` 事项"命中"与写入时同一个定义：几组 `duplicate_keys` 里任一组命中即命中。被标记的行与列出的某一行在**任何一组**上都不再命中，这一行才算不再命中；`matched/<k>` 的 `deps` 取它现在命中的第一组（标记时命中的那一组在先）。写入的 `duplicate.keys` 仍是标记时命中的那一组，不随之后的写入改。
- `cause` 为 `entries_restored`：撤回一次删除之后，或之后的删除让当初被去掉的候选回到仍未决的原事项（因先前的删除才生效、本次回到原来的种类），事项当初被去掉的候选放回来。`restored_candidates` 只列**整条被去掉过**的候选的下标（与 `dropped_candidates` 对称）；候选当初只少了一部分项、撤回后那些项回来的，下标不进 `restored_candidates`，本事件用同一下标重新给出含全部项的 `candidates/<k>`。本事件的 `candidates/<k>` 按撤回或删除之后的状态重新给出它们（以本事件为准，不读回原来的块）；此时没有 `by_event`。
- **第一版不出现这一种**：宽限期内受这项删除影响的行上不能解决事项（data-model「删除 · 撤回与宽限期」），被去掉候选的事项撤回时要么仍未决（走上一条），要么已在宽限期内被取代（不放回）。格式留着，供放开那条限制时用：撤回删除时事项**已经解决**的，不产生 `item.refreshed`，原事项的解决不动。放回来的候选按撤回时的当前状态重新判定，由撤回事件逐项重述：与当前生效值同值的项，按普通规则成为 `dropped`（没指证据）或 `corroborated`（指了证据）；否则仍是 `candidate`。只要还有一项是 `candidate`，随后一条 `item.created`（成因 `restored_candidate`）为这个候选另开事项，新事项里它的 `items` 只含仍是候选的那几项。回执的 `rejudged` 按候选给一条：还有项是候选记 `reopened`；否则有项成了佐证记 `corroborated`，全部成了 `dropped` 记 `dropped`。
- `target` 各键的出现条件：`dropped_candidates` 只随 `entries_deleted`，`restored_candidates` 随 `entries_restored`，或随 `entries_deleted`（同一次删除里既有候选离开、又有候选回来时：有候选离开就取 `entries_deleted`，只有候选回来才取 `entries_restored`），出现时非空；`by_event` 在 `entries_deleted`、`entries_restored` 时没有，其余成因必有；`writer_had_read` 在 `target_overwritten`（恒为 `false`）与 `references_changed` 时必有，其余成因没有；`merge_base_op` 对每种成因都可缺，给出时是刷新后的合并基。
- **回退类的待确认事项**（提议是一次 `undo`）：刷新时按当前状态重新判定，`scope_valid` 取这次确认会写回的区间（与确认时的判定相同），`impact/*` 取同一次 `undo` 按当前状态重判的结果（确认的判定不算高影响 ①，列不出会被覆盖的段）；两次判定列出的回退条目相同。两组块各列各自的 `deps`：`scope_valid` 的出自确认的判定，`impact/*` 的出自 `undo` 的重判。只有 `deps` 变了，内容也算变了：事项刷新、版本换新（与确认哈希把 `deps` 算在内一致）。重判之后既没有要写回的项、也没有要遮住或回掉的写入时，不刷新，改发 `item.superseded`（`nothing_to_revert`）。写入方读过事项时照旧是 `overwritten`：那种情形本来就不刷新，也就没有要替代的刷新。
- `apply`：事项版本换成本操作号。

#### `item.superseded`

事项不再需要处理。

| path | 种类 | 内容 |
|---|---|---|
| `target` | 元 | `{"item": "pi_…", "reason": <取代原因，§6.6>, "by_event": <seq>, "writer_had_read": <布尔>}` |

`by_event` 是取代它的事件的 `seq`：`overwritten` 时是那条 `write.base`，`schema_switched` 时是 `schema.switched`，`deleted` / `deletion_cancelled` 时是删除确认或撤回的头事件，`draft_replaced` 时是 `schema.superseded`。`matched_changed` 时是改到比中的两行之一的那条 `write.base`：逐个 op 判，取这次操作里最后一个确实让事项要说的内容（哪些行仍命中、各由哪些贡献给出、被标记的行在不在）变了的 op 在这些行上的 `write.base`；只改了别的字段的 op 不算。`item.refreshed` 的 `matched_changed`、`entries_changed`（`flagged` 事项的）同样这样取。`nothing_to_revert` 时是让它没事可做的那条 `write.base`（改到它的那条，或这次请求在这一行上最后一条）。`writer_had_read` 只在 `reason` 为 `overwritten` 时有；`flagged` 事项不带它。

`apply`：事项状态置为已被取代；撤掉对应标记；事项版本换成本操作号。

#### `item.resolved`

头事件。人或 Agent 处理了一个事项。带 §5.1 的块。

| path | 种类 | 内容 | 来源 |
|---|---|---|---|
| `target` | 元 | 见下 | — |
| `op_sources` | 元 | 这次解决的操作来源：`[<源数据事件的 seq>]`（解决请求带的证据，以及这次解决的 `api_call`：带了 `note`、或处理触发写入而没带证据时有，§4.3）。一条都没有时不出现 | — |
| `confirmation` | 数 | `{"hash": <哈希>}`：所确认内容的哈希 | 被确认的那些条目块；其中任何一块被删除，本块随之删除 |

```json
{"item": "pi_3KD…", "decision": "take_candidate", "candidate": 0,
 "item_op": 37, "restore_count": 0, "via": "call"}
```

| 键 | 含义 |
|---|---|
| `decision` | 处理方式（§6.5） |
| `candidate` | `take_candidate`：采纳的候选下标（`candidates/<k>` 的 `k`）。采纳该候选的全部项 |
| `item_op`、`restore_count` | 所确认的事项版本 |
| `via` | `call`。保留值：`elicitation` |

- 谁解决的是事件头的 `actor`；经哪个凭证由 `actor` 得出。
- `confirmation` 的哈希**追加时算、落账时核对**：内核追加本事件前，从事项当前有效的条目块算出它写进本块；落账时按落账到这里的状态再算一遍，与本块不一致即为日志与状态不符（`inconsistent`），停止落账。两处用同一个算法：SHA-256（被确认的条目块的校验和，按 `(seq, path)` 排序后以换行连接）。
  - 被确认的条目块 = 该事项当前有效的全部条目块，也就是"事项内容"：事项的 `item.created`、`item.merged`、`item.refreshed` 给出的 `current`、`candidates`、`proposed`、`previous`、`impact`、`matched`、`scope_valid` 各块，减去之后被同一事项的事件整组取代的（规则同上面 `item.merged`、`item.refreshed`）。候选与提议以它们的条目块进哈希，块里引用的贡献（`deps`、候选的 `event`）随块一起算在内。刷新与 `confirmation_mismatch` 用的是同一个"事项内容"：内容变了，事项版本跟着换新，旧版本的哈希也就对不上。
  - `schema_change` 事项是对应草稿的 `schema.compiled` 的 `compiled` 块。
  - 没有任何条目块的事项不产生本块。被确认的条目块里有一块被删除时，本块随之删除，落账不再核对它。
- `note` 不在本事件里：它随解决请求存为源数据（§4.3），由 `op_sources` 引用，事项详情回显的 `note` 从那里取，随那条源数据的隐私删除清除。
- **`take_candidate`** 触发的基础写入带采纳记录 `take`：

  ```json
  {"item": "pi_3KD…", "candidate": 0, "merge_base_op": 29,
   "items": [{"event": 35, "field": "f3"}]}
  ```

  | 键 | 含义 |
  |---|---|
  | `item`、`candidate` | 所解决的事项与采纳的候选号 |
  | `merge_base_op` | 解决时事项记下的合并基，之后不重算 |
  | `items` | 覆盖集：事项的冲突单元与区间内、合并基之后、本次解决之前有项生效过的（事件, 目标），列法与 `take_previous` 的回退记录相同（§5.7），条目形状同 `revert.items`（不带 `later`） |
  | `filled` | 状态类表：采纳填上的撤销，`[{"event": <seq>, "existence": true}, …]`（条目写法同 `items`）——解决时在生效、与采纳范围相交的撤销（data-model「删除 · 搬运的值」）。一条都没有时不出现 |

  这块是元信息，只有序号与目标，不随删除清除。覆盖集里的写入不登记回掉：采纳写下的项按普通的取代关系盖过它们。

  **填上的撤销只记是哪几条，不记它们当时的区间**：区间抄自那条撤销的内容，端点可以只出自之后被删的内容。重放按整条判撤销与采纳项的关系（data-model「删除 · 搬运的值」）：列在 `filled` 里的撤销整条不盖住采纳项，没列到的整段盖住。
- **`take_previous`** 触发的基础写入带回退记录 `revert`（§5.7）：合并基的操作号记在它的 `as_of_op` 里，被回掉的（事件, 目标）列在 `items` 里。它与 `undo` 是同一种操作，重放规则只有 §5.7 那一套。候选不在回退记录里，由本事件关闭。
- **确认一次待确认的回退**（`awaiting_confirmation` · `confirm`，提议是 `undo`）：确认触发的基础写入带**自己的** `revert`，按确认时的状态列定（与事项刷新后的影响一致），登记与写回都按它、以本次解决的操作号为准。提议那条基础写入里的 `revert` 只是提议内容，用于事项与预览，不用于登记。
- 处理 `deletion` 事项（撤回）不产生本事件，见 `deletion.cancelled`。
- `apply`：事项状态置为已解决、记下处理方式；撤掉对应标记；`request_key` 进请求键索引。处理触发的写入由随后的 `write.base` 落账。

### 5.9 删除

#### `deletion.confirmed`

头事件。一次隐私删除被确认，进入宽限期。带 `ctx`（`system` 产生的也带）；调用方确认的另带 §5.1 的其余块。**一次删除只针对一个 slot**：`sources` 都属于事件头 `slot` 指的那个 slot，跨 slot 由调用方分成多次删除。调用方确认的，`actor` 是确认者；恢复流程按删除登记重新生成的，`actor` 是 `system`、`trigger` 是 `restore`。

| path | 种类 | 内容 | 来源 |
|---|---|---|---|
| `target` | 元 | 见下 | — |
| `positions` | 元 | 到期要清空的内容块：`[{"seq": 26, "path": "text"}, {"seq": 27, "path": "fields/f3/0"}, {"seq": 42, "path": "summary"}]`（42 是本事件自己：`summary` 列在它自己的位置列表里） | — |
| `summary` | 数 | `{"hash": <哈希>}`：影响摘要的哈希（确认句柄绑定的那个） | 被删的内容；它自己列在 `positions` 里 |
| `results/<k>/target` | 元 | 一个受影响的行或实体：`{"table": …, "row": …, "outcome": <枚举>}`（状态类表写 `entity`） | — |
| `results/<k>/fields/<字段ID>/<j>` | 数 | 删除后该字段的一段，见下 | 块里的 `carried` 引用的贡献，另加块里的 `deps` |
| `results/<k>/existence` | 数 | 状态类表：删除后的全部无值区间 `{"gaps": [{"from": …, "to": …}], "deps": […]}`，没有无值区间时 `gaps` 为空数组。什么时候必须给，见下面「列哪些」 | `deps`：留下这些空洞的撤销，以及截断它们的贡献 |
| `restated/<k>` | 数 | 被这次删除**重述**的一项贡献：重放之后它的判定结果，见下 | 它指向的那一项贡献，另加块里的 `deps` 与 `carried` |
| `recreated/<k>` | 元 | 首次创建标记的变化：`{"event": <write.base 的 seq>, "created": <布尔>}` | — |
| `superseded_items` | 元 | 因删除被取代的事项 ID 列表 | — |

`target`：

```json
{"deletion": "pi_9QX…", "kind": "privacy", "due_at": "2026-11-11T05:02:11.000Z",
 "sources": [26], "origin": "request"}
```

| 键 | 含义 |
|---|---|
| `deletion` | 删除 ID，也是宽限期内那条 `deletion` 事项的 ID |
| `kind` | `privacy`。保留值见 §10 |
| `due_at` | 宽限期到期时刻 |
| `sources` | 被删的源数据（`source.recorded` 的 `seq`） |
| `origin` | `request` / `restored_unconfirmed`（登记里有、恢复出的日志里没有，重新生成并给新的宽限期）/ `restored_pending`（登记待执行，沿用原到期时刻）/ `restored_executed`（登记已执行，`due_at` 即本事件的 `at`，紧接着就是墓碑） |

`results/<k>/target` 的 `outcome`：`deleted`（整行删除）/ `kept_fields_cleared`（保留，部分字段变空）/ `fields_reverted`（部分字段回到更早的值）/ `resegmented`（状态类表重新分段）/ `sources_changed`（取值没变，这一行因为给出者、判定结果或给出它们的块被重新给出而列出：例如只换了给出它的贡献；给出空洞的撤销被重新解析、空洞仍在原处；或某一项只是被原样重述）。

一行同时符合几种时按上面的先后取第一个符合的：`deleted`（删除前存在、之后不存在）→ `kept_fields_cleared`（删除前有值的字段里，有一个之后在任何地方都没有值）→ `fields_reverted`（事件类表、无时间表上取值变了）→ `resegmented`（状态类表上取值或它的分段变了，无值区间也算）→ `sources_changed`。删除前不存在、删除后存在的行（例如让它不存在的撤销被删）记 `fields_reverted`：行回到更早的样子。

`results/<k>/fields/<字段ID>/<j>`：删除后这个字段的一段（事件类表恒为 `j = 0`）：

```json
{"value": {"value": "45", "unit": "CNY"},
 "sources": [{"kind": "value", "carried": {"event": 23, "field": "f3", "k": 0}}]}
```

状态类表另带 `valid` 与 `deps`：

```json
{"valid": {"from": "2026-11-20"}, "value": {"value": "5000", "unit": "CNY"},
 "sources": [{"kind": "value", "carried": {"event": 12, "field": "f2", "k": 0}}],
 "deps": [{"event": 12, "field": "f2", "k": 0}, {"event": 32, "field": "f2", "k": 0}]}
```

- **段的定义**：状态类表上，删除后该字段的状态按"由哪一项贡献给出"切成段——同一项贡献连续给出值的最长区间是一段。`carried` 指向给出这一段的那一项。`deps` **总是含 `carried` 指向的那一项**（这一段的区间出自它，它被重述时这一块要清除），另加把这一段截成现在这样的其他贡献（盖住它两侧的写入、留下相邻空洞的撤销）。
- **列哪些**：三种表同一条——**取值，或给出它的贡献项，与删除前不同的字段都列；由本次被重述的项给出的也列**。只换了给出者、值没变的字段同样要列：墓碑落账之后从头重放，被删的贡献已经不在，业务表只能从这里取到这些字段。状态类表按段列出，两类段就是这条的特例，**整段列出，不裁剪到有变化的那部分**：
  1. 段内任何一个业务时刻上，取值或给出它的贡献项与删除前不同；
  2. 由本次被重述的项（`restated`）给出的段。

  状态类表上还有一类变化落在没有值的地方：`apply` 在那里存的单元格——决定"有值"的字段上无值写回项给出的单元格，以及版本表里"存在"上标为已撤销的单元格——与删除前不同时，实体同样必须列出。后者只存在于有生效字段项的地方：撤销下面字段项生效的范围因删除而变了，它就随之伸缩，即使每个字段的给出者都还是那次撤销。这些地方都在 `results/<k>/existence` 的空洞里，由它给出，不另列字段的段。

  另外，**"存在"的给出者变了的行整行列出**（三种表都一样）：创建这一行或实体的那项贡献被删、而行靠别的贡献留了下来时，每个字段的值与给出者都列出，出自 schema 常量的也列（来源写 `schema_const`）。从头重放时，这一行由这条结果新建，字段齐全；下面 `apply` 的"行在重放里不存在时新建"靠这一条成立。

  另外，**有"存在"项被删除或被重述（含原样重述），或有 `uncovered` 写回项被重述时，这一行或实体必须列出**，三种表都一样。事件类表、无时间表没有 `existence` 块，行在不在由 `outcome` 表达，结局按删除后的样子取既有的值（整行删除 `deleted`，字段变空 `kept_fields_cleared`，字段回到更早的值 `fields_reverted`，取值都没变 `sources_changed`）。状态类表上与这些项的区间相交的各字段的段整段列出，"这些项的区间"取重述前最近一次给出的区间与重述后的区间之并。从头重放时，这些项的 `span` 块已移除、在原事件处不落账（§5.7），空洞与"已被回掉"的登记只能从这里与 `restated/<k>` 取到。

  事件类表、无时间表上删除前后都已撤销的行不因字段而列出：撤销之后字段的值仍留在行上，删除可能让它们换了给出者，但读不到它们，结果不说它们；`apply` 照来源表给它们落账（见下面 `apply` 第一条）。

  **状态类表上凡是列出了实体（不论因为上面哪一条），都给 `results/<k>/existence`**（删除后的全部空洞，没有空洞时 `gaps` 为空数组）。

  没列到的段保持原样。这一段没有任何贡献时 `value` 为 `null`、`sources` 为空数组；这一段的值是一次显式清空（§5.7 的 `"value": null`）时 `value` 为 `null`、`sources` 照常写 `carried`。被重述为 `no_value` 的写回项仍露在外面的部分，按第 2 类（由本次被重述的项给出的段）列出，同样写成 `value: null`、`sources: []`，`deps` 含那一项写回项。带区间的撤销被删除时，重新可见的值按它所在的整段列出（那一段的区间是给出它的贡献自己的，不含被删的撤销区间），`results/<k>/existence` 给出删除后剩下的空洞。空洞的区间可以没有 `from`（从最早起）；`from` 与 `to` 都没有表示整个实体在任何业务时刻都没有值。
- 值是从更早的贡献搬来的，来源一律写成 `carried`。以后删到这些贡献的来源时，本块同样在级联范围内。值落回 schema 切换的补值时，来源写 `schema_const` 条目（§5.7），不写 `carried`，常量本身不进 `deps`；状态类表上这一段的区间出自补值段，把那一块 `backfill/…` 的 `deps` 抄进来（§3.5）。带值的 `restated/<k>` 同样适用。

`restated/<k>`：重放之后，某一项贡献的判定结果。形状与 `write.base` 里一项的判定结果相同（`fields` 的 `status` 加 `span` 的内容）：

```json
{"event": 18, "field": "f2", "k": 0, "status": "applied", "valid": {"from": "2026-11-02"}}
```

```json
{"event": 26, "field": "f2", "k": 0, "status": "corroborated",
 "valid": {"from": "2026-11-05", "to": "2026-11-20"}}
```

| 键 | 含义 |
|---|---|
| `event`、`field`、`k` | 指向哪条 `write.base` 的哪个字段的第几项。重述的是对"存在"的一项贡献时，没有 `field` 与 `k`，改为 `"existence": <k>`；它是恢复存在的项时另带 `"restored": true` |
| `status` | 重放之后的生效状态：`applied`、`corroborated`、`candidate`、`awaiting`，或 `dropped`（这一项不再是贡献：成了同值而当初没指证据；回退记录的条目覆盖的项全都不是贡献或范围为空（回掉写回的项）；或它的区间并进了同一字段的另一项）。搬运来的项（回退、采纳候选、回到合并基写回的）与普通贡献一视同仁 |
| `valid` / `seen_valid` | 状态类表：重放之后的区间。`candidate` 用 `seen_valid`；`dropped` 没有 |
| `deps` | 重放之后解析这个区间时用到的别的贡献，含义同 `span` 的 `deps` |
| `value`、`sources` | 只在搬运项（回退、回到合并基写回的项）被重放改了值或搬运来源时有：新的值与新的 `carried` 引用（`carried` 指向的项同时列进 `deps`） |
| `no_value` | `true`：重放之后这一项写回的是"没有值"（含义同 `write.base` 的 `no_value`）。此时没有 `value` 与 `sources` |
| `uncovered` | `true`：重放之后这一项只做登记、不给值（含义同 `write.base` 的 `uncovered`）。此时没有 `value` 与 `sources` |

- **哪些项要重述**：
  1. 重放之后，判定结果（生效状态、区间、`deps`、搬运项的值与来源、是否 `no_value` 或 `uncovered`）与日志里最近一次给出的不同的每一项。比较 `deps` 时，事件类表与无时间表上的项本身没有 `deps`，带值的 `restated/<k>` 块里一并列进 `deps` 的搬运项（§3.5）不算作不同。
  2. **给出它当前判定结果的块被本次删除清掉、而重放之后仍是贡献的每一项**。这个块是它原来的 `span`，或更早一次删除的 `restated/<k>`。结果没变也重新给出，因为原块已不可读；不重新给出的话，从空存储重放时这一项会被当成"已不是贡献"。这里的"本次清掉"以本次删除自己的位置列表为准（[`03-data-model/03-deletion.md`](03-data-model/03-deletion.md)「多项删除各自列全位置」），其他待执行删除在重放里的影响不改变这一点。最近一次给出它的是更早一次删除的 `restated/<k>`、而且是 `dropped` 的项，这块被本次删除清掉时，同样再次重述为 `dropped`：它不是贡献，但不重新给出的话，从空存储重放时这一项退回它写入时的块，又成了贡献。

  3. **撤回事件另重述"最近一次给出的区间块出自被撤回的那次删除"的每一项**，结果没变也原样重述（与"存在"项的原样重述同类）。被撤回删除给出的块之后不再算（§5.7「被撤回的删除给出的块不算」），不重述的话，往前找最近一次给出的区间会越过这一项的当前区间、取到一块过时的。

  原来的字段块被本次删除清掉、重放之后又有了新结果的搬运项，沿用原来的 `k` 重述。撤回事件同样按 1、2 两条，另加第 3 条。"存在"项或 `uncovered` 写回项被重述（含原样重述）时，`results` 里同时列出这一行或实体，状态类表另给 `results/<k>/existence`（上面「列哪些」）。
- **重述覆盖的情形**：候选或待确认的项因删除而生效（给出生效后的 `status` 与 `valid`，可能是 `applied`，也可能是 `corroborated`）；因删除转为待确认（`awaiting`，新事项由随后的 `item.created` 给出，它的 `origin_event` 指向这条 `write.base`）；改值变佐证、佐证变改值；默认终点、`corrected_span`、只带起点的撤销的终点被重新解析；回退写回的项因"之前的状态"变了而变。
- **以最近一次为准**：一项贡献的判定结果以日志里最近一次给出它的事件为准。之后的 `undo`、冲突判据里"那次写入记下的区间"、对它的引用都按它；佐证端点按重述后的 `status` 与 `valid` 得出。
- 它是数据块：指向的那一项被删除或再次被重述、`deps` 里任何一项被删除或被重述时，它列入那次删除的位置列表（§3.5）。

**`recreated/<k>`**：删除重放让"哪次写入是首次创建"变了时记下。`created` 同样以最近一次给出的为准。

**`positions` 是这次删除要清空的全部内容块**，各项删除各自列全（与别的待执行删除重叠的块照列）。它包括：

| 类别 | 块 |
|---|---|
| 被删的源数据 | `text` / `file` / `request` / `stated_at` |
| 这些来源的贡献 | `write.base` 的 `fields/*/*`、`sources/*/*`、`literal/*/*`、`span/*/*`、带区间撤销的 `span/existence/*` |
| 原始传参与操作标识 | `write.head` 的 `ops/<i>/set/*`、`ops/<i>/valid`、`ops/<i>/refs`，以及来源与它们相同的 `ops/<i>/premise_valid/*`；相关操作的 `task`、`request_key`、`idempotency` |
| `deps` 里有被删或被重述的贡献的块（§3.5） | 别的写入的 `span/*/*`、`span/existence/*`、`ack/*`、`duplicate`；带 `deps` 的 `ops/<i>/premise_valid/*`；事项的条目块与 `scope_valid`；更早的删除事件的 `results/*/fields/*/*`、`results/*/existence`、`restated/*` |
| `deps` 里有被删的贡献的补值段（被重述不算，§3.5 规则 1 的例外） | `schema.switched` 的 `backfill/*/*/*` |
| `carried` 指向被删或被重述为 `dropped` 的贡献的项 | 搬运项的 `fields/*/*`、`sources/*/*`（搬运项没有 `literal` 块；它的 `span` 已在上一行） |
| 随之失效的 | `item.resolved` 的 `confirmation`；派生写入的 `key`、`checksum`；`schema.switched` 的 `tables/*` |
| 本事件自己的 | `summary` |

受影响的行或实体的 `ver` 换成本操作号。

`apply`：

  - **业务表按来源表落账、以 `results/*` 核对**：先按下面 `base_sources` 一条改来源表，再把这次删除碰到的每一行或实体（有项的字段块或区间块列在 `positions` 里、有项被 `restated` 重述，或列在 `results` 里的）按它在来源表里的全部生效项落账，与 `write.base` 落账是同一个确定性计算（把生效项的值赋给它们的区间、规范化分段，不判定、不重放）；版本表在变了的单元格上加一个版本（意图记为 `deletion`），内容被重述改了的项（搬运项的新值、改成 `no_value` 的写回项）给出的单元格一并换新。落账的结果必须就是 `results` 说的样子，逐项核对：`results` 列出的每个字段的每一段，同一区间上的取值与给出者（`carried` 指向的项；值为空、没有来源的段只核对为空）；状态类表的实体，全部无值区间等于 `results/<k>/existence`；结局为 `deleted` 的行或实体落账后不存在（别的结局不核对存在与否：删除前后都不存在的行也可能因给出者变了而列出）。列出的行或实体里，没列到的字段与段保持原样：在列出的段与无值区间之外，每一段由哪一项给出（或没有项给出、是否记为无值），落账前后相同。碰到了而没列在 `results` 里的行或实体，落账后的单元格必须与原来相同；唯一的例外是删除前后都不存在（不存在或已撤销）的事件类表、无时间表的行，照来源表落账、不核对。任何一处不符，`apply` 以不一致停下，不另算一个样子。`results` 里的行或实体在重放到这里时不存在（创建它的写入的块全已移除，`apply` 当时没有建行），落账时随它的生效项新建。
  - `base_sources`：去掉字段块列在 `positions` 里的项；`positions` 里列到的状态类表补值段（`schema.switched` 的 `backfill/*/*/*`）对应的 schema 常量贡献同样去掉；按 `restated/*` 写入每个被重述项的生效状态、区间与搬运引用，含 `no_value` 与 `uncovered` 的写回项（`dropped` 的去掉；`candidate`、`awaiting` 的不算生效；同一项两者都有时以 `restated` 为准）。因删除而生效的项在贡献先后里仍排在自己原来的位置。`block_deps` 随之更新。
  - 被回掉的是哪些项（回退记录 `revert`）不因重述而变；登记的范围按重述后的写回项区间重算（同 §5.7 `revert` 的 `apply`）。
  - `premise_decls`：`positions` 里列到某条声明的 `ops/<i>/premise_valid/<j>` 时，这条声明的范围从本事件起按整条时间线处理（业务时间的副本留到墓碑才清空）；状态的变化由同一操作里的 `premise.changed` 落账。
  - `counts`：整行删除、行因删除而出现或消失时更新行数。
  - `recreated`：更新首次创建的登记。
  - `premise_edges`：`restated/*` 在同一（事件，字段或"存在"）上新编出的下标，被覆盖该（事件, 目标）的声明（op 自己写下的那一部分）覆盖；`premise_covers` 列出的项上新编出的下标，随它所分出的那一项一并被覆盖，"从哪一项分出"按写入时的区间块判，那一块已被到期执行的删除清掉时按原区间判（§5.7）。前提状态的变化由同一操作里的 `premise.changed` 落账（§5.10）。
  - 键索引 `external_keys`：`positions` 里出现某条 `write.base` 的键字段项（`fields/<键字段ID>/0`）时，那一行持有的键，或它让出的键（它是 `key_from` 那一行时），条目转为"冻结"，持有者不变。冻结由 `positions` 推出，不由 `results` 里键字段值的前后差推出：从头重放时被删的块已不在，差值可能是"空 → 空"。冻结记的是**删除 ID 的集合**：几项待执行的删除冻结同一个键时各记一个。不另加块。
  - `superseded_items`：事项状态由随后的 `item.superseded` 事件落账。
  - `positions` 列出的块此后读不到（逻辑删除），到期前仍在存储里。
  - `deletions` 加一行（待执行）；宽限期内的 `deletion` 事项由这一行得出。
  - 被删的源数据（`target.sources`）在源数据登记里记为待删除：之后的写入不能再以它为证据（`pending_deletion_source`）。撤回时置回。

#### `deletion.cancelled`

头事件。宽限期内撤回一次删除。`actor` 是撤回者；恢复流程按登记补出的，`actor` 是 `system`、`trigger` 是 `restore`。带 `ctx`；调用方撤回的另带 §5.1 的其余块。

| path | 种类 | 内容 |
|---|---|---|
| `target` | 元 | `{"deletion": "pi_…", "origin": "request" \| "restore_cancel"}` |
| `results/<k>/target`、`results/<k>/fields/<字段ID>/<j>`、`results/<k>/existence` | 元 / 数 | 与 `deletion.confirmed` 同形：撤回后受影响的行或实体的样子（按定义连同宽限期内的写入再算一次） |
| `restated/<k>`、`recreated/<k>` | 数 / 元 | 与 `deletion.confirmed` 同形：撤回后各项贡献的判定结果与首次创建标记。因那次删除而生效、撤回后退回未生效状态的写入，在这里重述为 `candidate` 或 `awaiting`；被那次删除重述过的项，在这里按撤回后的状态再重述一次 |
| `restored_items` | 元 | 恢复为未决的事项 ID 列表 |
| `kept_superseded/<k>` | 元 | 保持"已被取代"的事项：`{"item": "pi_…", "by_event": <seq>}` |
| `kept_effective/<k>` | 元 | 因删除而生效、宽限期内已被别的写入当作基线而不退回的写入（只在撤回前它在这个目标上的各项全部生效时记；判定按（事件, 目标），`items` 只供回执，下标不参与判定）：`{"event": <seq>, "items": [{"field": …, "k": …}], "by_event": <以它为基线的那条 write.base 的 seq>}`（对"存在"的一项写成 `{"existence": <k>}`）。宽限期内以它为基线的写入有几次时，`by_event` 取第一次 |

- 被那次删除列入 `positions` 的块恢复可读（仍被别的待执行删除列出的除外）。其中带 `deps` 的块，内容是删除之前求得的；撤回之后是否仍然成立由重放决定，变了的由本事件的 `restated`、`results` 重新给出，并以本事件为准。
- 那次删除确认事件自己的 `results/*`、`restated/*` 块此后不再是"最近一次给出的"；它们留在日志里，照 §3.5 随它们的 `deps` 清除。

`apply`：与确认相同，按来源表落账、以 `results/*` 核对（版本的意图记为 `deletion_cancelled`；行在重放里不存在时新建，同确认；`restated/*` 只改来源表，不改业务表）。碰到的行是被撤回的那次删除碰到的与本事件碰到的；落账时每一项的判定取日志里最近一次给出的，被撤回的删除给出的块不算，已撤回的别的删除给出的也不算；读不到的块是仍待执行的其他删除列出的；行回来或消失时更新 `counts`；按 `restated/*`、`recreated/*` 更新来源表与首次创建的登记；被那次删除去掉的状态类表补值段放回 `base_sources`（仍被别的待执行删除列出的除外）；被那次删除改成按整条时间线处理的前提声明，范围恢复为 `premise_valid` 记下的业务时间（同上例外）；被这次删除冻结的来源键条目从冻结集合里去掉这项删除的 ID，集合空了才转回"在"；`deletions` 置为已撤回；恢复的事项由 `restored_items` 置回未决。前提状态的变化由同一操作里的 `premise.changed` 落账。

#### `deletion.executed`（墓碑）

头事件，`actor: "system"`。`trigger`：到期的是 `deletion_expiry`，恢复流程补的是 `restore_backfill`，导入时为占位的待删除项补的是 `import`。

| path | 种类 | 内容 |
|---|---|---|
| `target` | 元 | `{"deletion": "pi_…", "reason": "expiry" \| "restore_backfill" \| "import_placeholder"}` |
| `positions` | 元 | 这次清空的内容块：`[{"seq": …, "path": …}]` |

- 墓碑里没有任何描述被删内容的文字，也没有由它算出的值。
- `positions` 一般等于对应 `deletion.confirmed` 的 `positions`；块已被更早的墓碑清空的跳过，不重复列。
- **导入时补的墓碑**（`reason: "import_placeholder"`）：导出默认把宽限期内待删除的块换成占位（§8），这些内容不在文件里。导入紧接着 `tenant.imported` 为每一项这样的删除补一条墓碑，排在它之后；这些删除在目标处不可撤回，对应的 `deletion` 事项按到期关闭。这样存储里只有"在"与"已移除"两种真实状态，不留表现成可撤回却撤回不了的占位。
- 墓碑永不过期。
- `apply`：把 `positions` 列出的每个块清空并记 `removed_by` = 本事件的 `seq`；清掉各版本物理表（含退役表）、版本表、`pending_entries`、`partitions`、请求键索引、全文索引、`premise_decls` 里的业务时间中由这些块得出的内容；对 `positions` 涉及的每个键，从冻结集合里去掉这项删除的 ID，再按[`03-data-model/04-write-and-read.md`](03-data-model/04-write-and-read.md)「持有者怎么定」重算持有者（去掉的是补键那次写入的键贡献时，条目指回 `key_from` 那一行，前提是它的键贡献仍在；否则去掉条目）；集合里还有别的删除 ID 时仍是冻结；`deletions` 置为已执行。当前业务状态不变。

### 5.10 前提

#### `premise.changed`

一次操作让某些前提声明变了状态时，记下这些变化：由"没变"转为"已变"（打标记）、由"已变"转回"没变"（撤标记），以及删除时的改指。**不是头事件**，带 `op`；事件头的 `slot`、`actor`、`at` 同所属操作。一次操作至多一条，只在有变化时产生；在操作里排在全部 `write.base` 与事项事件之后、`write.derived` 之前（§4.2–§4.4）。产生它的操作只有五种：写入、`resolve` 触发的写入、删除确认、撤回删除，以及 schema 切换（只在新版删除了某条声明所声明的字段时；见本节末）。

判定在线上、在当时做一次：比较"现在的值"与"所见版本上的值"要读历史版本，而内容被物理删除之后重放读不到当时的值。所以变化写进事件，`apply` 照做，不自己比较（判据与检测步骤见 [`03-data-model/02-integrity-and-records.md`](03-data-model/02-integrity-and-records.md)「写入的前提」）。

| path | 种类 | 内容 |
|---|---|---|
| `targets/<k>` | 元 | 一个值变了的前提目标，以及因此变了状态的声明，见下 |

```json
{"table": "t1", "row": "r_01JF…", "by_event": 62,
 "changed":   [{"op": 50, "i": 0, "j": 0, "reason": "update"}],
 "matched":   [{"op": 73, "i": 0, "j": 0}],
 "repointed": [{"op": 45, "i": 1, "j": 0}]}
```

| 键 | 含义 |
|---|---|
| `table`、`row` / `entity` | 前提目标 |
| `by_event` | 使它变化的事件：本操作里那条 `write.base` 的 `seq`（几条都改到这个目标时取最早的那条；它不参与 `apply`，只供展示）；由删除引起时是 `deletion.confirmed` / `deletion.cancelled` 的 `seq`；由 schema 切换引起时是 `schema.switched` 的 `seq` |
| `changed` | 由"没变"转为"已变"的声明。声明用（操作号 `op`，op 下标 `i`，声明下标 `j`）指明（§5.7）。`reason` 逐条给（状态类表上同一次写入对不同的声明可以是不同的原因），取值见 §6.8；`since` 就是本操作号，不另记 |
| `matched` | 由"已变"转回"没变"的声明（现在的值又与所见的值相同，且所见版本上的值读得到） |
| `repointed` | 只出现在删除确认与撤回删除里：保持"已变"、`since` 改为本操作号、`reason` 改为 `deleted` 的声明 |

- **schema 切换里的 `premise.changed`**：新版删除了某条声明所声明的字段（含随表删除的字段）时，"没变"的声明转为"已变"，`reason` 是 `schema_switched`，`since` 是本操作号；`by_event` 是 `schema.switched` 的 `seq`；每个受影响的前提目标一块，只有 `changed`。已经是"已变"的声明不动（`since`、`reason` 保持）；声明了几个字段、只删其中一个的，这条声明同样转为"已变"；声明不扩成整行。切换本身不重判任何别的声明（不撤标记、不改指）：`migrate` 让值在新版里重新相等时，撤标记发生在之后下一次改到这个前提目标的操作里，照常规检测比较。标记里列的字段只列当前版本里还在的。
- `changed`、`matched`、`repointed` 三个键各自为空时各自不出现；三个都空的前提目标不出块（每块至少有其一）。每个有变化的前提目标一块，`k` 从 0 起。
- **全是元数据**，第一版不随任何删除清除；它留下的信息见 §9.2。
- `apply`：按 `changed` / `matched` / `repointed` 改 `premise_decls` 里对应声明的状态、原因与 `since`。别的什么都不做。

### 5.11 第一版产生事件的操作一览

| 操作 | 产生事件吗 |
|---|---|
| `write`、`resolve`、`schema_draft`、`delete`、撤回删除 | 是（上文） |
| 签发、改名、吊销连接实例 | 是（`principal.*`） |
| 移除空 slot | 是（`slot.removed`）；再移除一次已移除的 slot：否 |
| 导入到空租户 | 是：导入的事件原样追加，之后一条 `tenant.imported`，再为每一项占位的待删除项各补一条墓碑（§5.2） |
| 被拒的请求（校验失败、`read_first`、`insufficient_scope`、编译失败、确认时表已被写入的 `resolve`……） | 否。被拒的写入不产生事件，也不做去重 |
| 全部字段都是无操作的写入 | `write.head` 与 `source.recorded`；没有 `write.base` |
| 重申与清除前提（不带 `set` 的 `update` 只带 `premises`，或带 `premises: []`） | `write.head`（含前提块）与 `source.recorded`（证据，或这个 op 的 `api_call`）；没有 `write.base`，行的 `ver` 不变 |
| 全部 op 都是按来源键的 `unchanged` / `skipped` 的写入 | 否（§4.2）。回执照给，没有操作号 |
| 所有读操作（含删除预览） | 否。读取记进读取记录，不进日志 |
| 日志校验、对拍、导出、读取审计查询 | 否 |
| 读取记录的落盘与清理、残留清理、高水位推进、所有权 epoch（本机模式） | 否 |

### 5.12 `apply` 维护的物化状态由什么重建

| 物化状态 | 由哪些事件的哪些部分重建 |
|---|---|
| 主体登记（含 scope、slot 范围、状态） | `tenant.genesis` 的 `user`、`system`；`principal.*`；`tenant.imported` 的 `user` 与停用 |
| 当前恢复次数 | 最近一条 `tenant.restored` 或 `tenant.imported` 的 `restore_count`（都没有则为 0） |
| 当前租户 ID | 最近一条 `tenant.genesis` 或 `tenant.imported` 的 `tenant` |
| slot、当前版本指针、当前策略 | `schema.compiled` 的 `compiled`；`schema.switched` 的 `target`；`slot.policy_set`；`slot.removed`（删去） |
| schema 版本表、迁移状态、数据目录的结构部分 | `schema.*`；`slot.removed`（删去它的数据目录，schema 版本表保留） |
| 业务表当前版本、版本表、行数计数 | `write.base` 的 `target`、`fields/*/*`（`applied`）、`existence/*`；`write.base` 的 `span/*/*`、`span/existence/*`；`deletion.confirmed` / `deletion.cancelled` 的 `results/*`、`restated/*`；`schema.switched`（按 `compiled` 转换旧版写入）；`deletion.executed`（清空）；`slot.removed`（删去物理表与计数） |
| 来源表（含每项贡献的当前区间、首次创建的登记、佐证端点） | `write.base` 的 `fields/*/*` 与 `existence/*` 的 `status`、`span/*/*`、`span/existence/*`、`sources/*/*`、`valid_sources`、`op_sources`、`target.created`、`revert`（"已被回掉"的登记）；`write.head` 的 `ops/<i>/valid`（判别显式终点）、`ops/<i>/target.by_external_key`（哪些贡献是同步贡献，供同步基线）；`deletion.*` 的 `restated/*`、`recreated/*`；`schema.switched`（按 `compiled` 转换旧版各项，登记常量 `backfill` 补出的贡献） |
| 块依赖索引 | 各数据块的 `deps` 与 `sources/*/*`、`results/*`、`restated/*` 里的 `carried` |
| 派生表、分组映射、派生读集 | `write.derived`；`schema.switched`（按新规则重建） |
| 待处理事项及其条目 | `item.*`；`deletion.confirmed` / `deletion.cancelled`（`deletion` 事项本身、`superseded_items`、`restored_items`） |
| 数据标记 `disputed`、`awaiting`、`flagged` | 未决事项的 `target` 与 `scope_valid` |
| 键索引 `external_keys`（来源键 → 行，状态"在"、"冻结"及冻结它的删除 ID 集合，"已让出"的行） | `schema.compiled` 的 `compiled`（表的 `external_key`）；`write.base` 的键字段项；`write.head` 的 `ops/<i>/target.key_from`（同一操作里键字段项在时）；`deletion.confirmed` 的 `positions`（冻结）与 `results/*`；`deletion.cancelled`（解冻）；`deletion.executed`（重算持有者）；`schema.switched`（按新版表重建） |
| 前提声明 `premise_decls` | `write.head` 的 `ops/<i>/premises/<j>`、`ops/<i>/premise_valid/<j>`；`premise.changed`；`deletion.confirmed` 的 `positions`（列到 `premise_valid` 的声明，范围改按整条时间线）；`deletion.cancelled`（范围恢复）；`deletion.executed`（清空业务时间） |
| 前提覆盖 `premise_edges` | `write.base`（按 `target.op_index` 找到本 op 的声明，登记本事件的各项）；`write.head` 的 `ops/<i>/premise_covers`、`ops/<i>/premises_cleared`；删除事件的 `restated/*`（新编出的下标）。只增与改写，不删 |
| 请求键索引 | 各头事件的 `request_key`、`idempotency` |
| 删除表 | `deletion.*` 的 `target` |
| 源数据登记、全文索引 | `source.recorded` |
| 数据目录的概况与取值示例 | 由当前业务表现算，不由事件直接给出 |

### 5.13 结果校验和的算法

用于 `write.derived` 的 `checksum` 与 `schema.switched` 的 `tables/<表ID>`。

- **一个派生行**：把结果列按字段 ID 的字典序排成对象 `{<字段ID>: <值>}`（值按 §1.3），取 JCS 字节的 SHA-256。
- **一张表**：按新版表的最终逻辑行算，有常量补值时取补值之后的值。把每个逻辑行写成 `{"id": <行或实体 ID>, "valid": <区间，状态类表才有>, "fields": {<字段ID>: <值>}}`：`fields` 列新版这张表的每个字段，没有值的写 `null`；`valid` 按 §1.2 的区间写法，开口时不写 `to`。按 `id`、再按 `valid.from` 排序；逐行取 JCS 字节，以一个换行符（`0x0A`）连接；对整体取 SHA-256，按 §1.2 写成哈希。已撤销的行不计入。

---

## 6. 枚举

**"保留值"只指第一版不产生、遇到即停机的那一类；第一版正在用的专用取值（主体 `system`、"存在"的 `existence`）叫"固定值"，是 `v` = 1 的合法内容。保留值不属于 `v` = 1 的取值集合。** 本节各表里列出的是第一版内核会产生的取值；标"保留"的只是把名字占住，第一版内核不产生，也不接受——在 `v` = 1 的事件里遇到，按未知形状停机（§1.6）。将来启用某个保留值时，用到它的事件所属类型的 `v` 加一。"第一版恒为空"的键同理：非空的形状不属于 `v` = 1。

### 6.1 事件类型

第一版产生：

| `type` | 说明 |
|---|---|
| `tenant.genesis` | 租户创世 |
| `tenant.restored` | 恢复 |
| `tenant.imported` | 导入到空租户 |
| `principal.registered`、`principal.renamed`、`principal.revoked` | 主体 |
| `slot.policy_set` | slot 策略 |
| `slot.removed` | 移除空 slot |
| `schema.draft_submitted`、`schema.compiled`、`schema.confirmed`、`schema.rejected`、`schema.superseded`、`schema.migration_started`、`schema.switched`、`schema.migration_failed` | schema 生命周期 |
| `source.recorded` | 源数据 |
| `write.head`、`write.base`、`write.derived` | 写入 |
| `item.created`、`item.merged`、`item.refreshed`、`item.superseded`、`item.resolved` | 待处理事项 |
| `deletion.confirmed`、`deletion.cancelled`、`deletion.executed` | 删除 |
| `premise.changed` | 前提状态的变化 |

留位（第一版不产生）：见 §10。

### 6.2 意图 `intent`

| 值 | 含义 |
|---|---|
| `insert` | 新增 |
| `update` | 变更 |
| `correct` | 纠错 |
| `revoke` | 撤销 |

回退（`revert`）不是意图，`write.base` 另带回退记录 `revert`；它与 `take_previous` 触发的基础写入是同一种操作（区别只在 `revert` 块里是 `before_op` 还是 `as_of_op`）。回掉写入的意图：`undo` 调用方给了意图就用它，没给时取**被撤回的操作在这一行（或实体）上 `seq` 最大的那条 `write.base` 的意图**，不看 `include_later` 连带回掉的写入；`take_previous` 取**回退记录里事件 `seq` 最大的那一项所在 `write.base` 的意图**，回退记录为空时取 `update`。处理事项触发的另两种写入同样沿用：`take_candidate` 取**被采纳候选各项里事件 `seq` 最大的那一项所在 `write.base` 的意图**，确认待确认事项（`confirm`）取**提议各项里事件 `seq` 最大的那一项所在 `write.base` 的意图**。这些意图只表示"沿用的来历"，实际效果以写回项为准：例如目标是"存在"的冲突里生效的一方是撤销，`take_previous` 那条恢复存在的写入沿用到的意图是 `revoke`，而它写回的是 `existence` 的 `restored` 项；`timeline` 展示这类写入时以回退记录与写回项说明做了什么，不单看意图。保留值：`applied_by_rule`（系统裁定，§10）。

版本表里每个版本也记一个意图，供 `timeline` 与 `changes` 给出。除上面四个外另有三个取值，只用于由删除或 schema 切换产生的版本，不出现在 `write.base` 里：

| 值 | 含义 |
|---|---|
| `deletion` | 这个版本由一次删除确认产生 |
| `deletion_cancelled` | 这个版本由一次撤回删除产生 |
| `schema_switch` | 这个版本由一次 schema 切换的 `backfill` 在本来没有值的位置补出（出处是那条 `schema.switched`） |

### 6.3 字段生效状态 `status`

| 值 | 含义 | 改业务表吗 | 记来源吗 |
|---|---|---|---|
| `applied` | 已生效 | 是 | 是 |
| `candidate` | 冲突候选，未生效 | 否 | 记在事件里，不进来源表 |
| `awaiting` | 高影响，等待确认，未生效 | 否 | 同上 |
| `corroborated` | 同值且显式指了证据：追加来源 | 否 | 是 |
| `dropped` | 只出现在删除事件的 `restated/<k>` 里：这一项经删除重放后不再是贡献（成了同值而当初没指证据）；回掉写回的项，其回退记录的条目覆盖的项全都不是贡献或范围为空；或它的区间并进了同一字段的另一项 | 否 | 否 |
| `noop` | 与所见版本同值且没指证据：无操作。**不出现在 `write.base` 里**（无操作的字段没有项，只在 `write.head` 的 `ops/<i>/noop` 列出字段 ID）；这个取值只用于契约的回执 | 否 | 否 |

保留值：`applied_by_rule`（后续：系统裁定让候选按规则生效）。

### 6.4 事项类型 `type`

`conflict`、`awaiting_confirmation`、`flagged`、`schema_change`。`deletion` 事项不由 `item.*` 事件表达（§5.9）。保留值：`migration_diff`、`sync_rejected`。

### 6.5 处理方式 `decision`

| 事项类型 | 取值 |
|---|---|
| `conflict` | `keep_effective`、`take_candidate`、`take_previous` |
| `awaiting_confirmation` | `confirm`、`reject` |
| `flagged` | `keep`、`revoke` |
| `schema_change` | `confirm`、`reject` |

`deletion` 事项的撤回（对外的处理方式 `cancel`）不经 `item.resolved`，由 `deletion.cancelled` 表达（§5.9）。

保留值：`migration_diff` 的 `accept_all`、`rows`（逐行接受、拒绝或给值）、`keep_rest_and_switch`、`abandon`。

### 6.6 成因码与取代原因

`item.created` 的 `reason`：

| 值 | 事项类型 | 含义 |
|---|---|---|
| `stale_write` | `conflict` | 带过期 `ver` 的写入与期间的写入相交 |
| `overwrites_change_point` | `awaiting_confirmation` | 抹掉已记录的变化点（含跨空洞填值） |
| `referenced_row` | `awaiting_confirmation` | 撤销仍被引用的行 |
| `undo_includes_later` | `awaiting_confirmation` | `undo` 连后来的写入一起回掉 |
| `undo_hides_later` | `awaiting_confirmation` | `undo` 写回的撤销会遮住后来的写入（两种成因同时成立时记 `undo_includes_later`） |
| `conflict_cleared_by_deletion` | `awaiting_confirmation` | 删除让冲突消失，而该写入仍属高影响 |
| `restored_candidate` | `conflict` | 撤回删除放回了一个候选，而它原来所在的事项在宽限期内已被解决：为它另开一个事项，`related_item` 指向原事项。第一版不出现（宽限期内受影响的行上不能解决事项） |
| `duplicate_keys` | `flagged` | 命中疑似重复的判据 |
| `schema_change` | `schema_change` | 草稿需要确认 |

保留值：`policy_high_impact`。

`deletion` 事项没有 `item.created`；对外给出的成因码就是 `deletion.confirmed` 的 `origin`（§6.8）。

`item.superseded` 的 `reason`：

| 值 | 含义 |
|---|---|
| `overwritten` | 目标被一次读过该事项的写入改到 |
| `schema_switched` | schema 已切换，且事项涉及被改动的字段 |
| `deleted` | 隐私删除让事项失去目标、候选或提议失去全部值来源、或成因被删 |
| `draft_replaced` | `schema_change` 事项对应的草稿被新草稿取代 |
| `deletion_cancelled` | 因删除而生成的待确认事项，在删除撤回后不再成立 |
| `matched_changed` | `flagged` 事项比中的两行里任何一行被撤销或改动，疑似重复不再成立 |
| `nothing_to_revert` | 回退类的待确认事项按当前状态重判之后，已没有要写回的段、也没有要遮住或回掉的写入 |

保留值：`evidence_deleted`、`migration_failed`。

### 6.7 候选的来由 `cause`

`stale_write`。保留值：`displaced_by_rule`。

### 6.8 其他取值

| 字段 | 取值 |
|---|---|
| `source.recorded` 的 `kind` | `user_message`、`agent_note`、`tool_result`、`file_ref`、`api_call` |
| 来源级别 `level` | `user_stated`、`agent_inferred`。保留：`external_authority` |
| 字面命中 `result` | `hit`、`miss`、`na` |
| `ver.basis` | `explicit`、`fallback`、`same_request`、`external_key`（最后一个只在 `ops/<i>/target` 里，不在前提声明里） |
| 前提声明的 `range` | `whole`、`from_now`、`row_time`、`given` |
| 前提声明的 `state` | `current`、`changed` |
| 前提的原因 `reason`（声明块与 `premise.changed` 的 `changed`） | `correct`、`update`、`revoke`、`retroactive`、`plan_changed`、`deleted`、`schema_switched` |
| `valid` 的 `mode` | `given`、`now`、`open`、`next_change`、`corrected_span` |
| `write.base` 的 `cause` | `request`、`resolve` |
| `existence` 的 `scope` | `whole`、`interval` |
| `deletion.confirmed` 的 `kind` | `privacy` |
| `deletion.confirmed` 的 `origin` | `request`、`restored_unconfirmed`、`restored_pending`、`restored_executed` |
| `deletion.cancelled` 的 `origin` | `request`、`restore_cancel` |
| `deletion.executed` 的 `reason` | `expiry`、`restore_backfill`、`import_placeholder` |
| `tenant.imported` 的 `export.pending_deletions` | `placeholder`、`included` |
| 删除结果 `outcome` | `deleted`、`kept_fields_cleared`、`fields_reverted`、`resegmented`、`sources_changed`（取值没变，这一行因为给出者、判定结果或给出它们的块被重新给出而列出，§5.9） |
| `schema.compiled` 的 `outcome` | `applied`、`pending` |
| 改动类别 `class` | `create`、`metadata`、`deterministic`。保留：`reextract` |
| `schema.migration_failed` 的 `reason` | `build_failed`、`verify_failed` |
| `item.refreshed` 的 `cause` | `target_overwritten`、`references_changed`、`entries_deleted`、`entries_restored`、`matched_changed`、`entries_changed` |
| `item.resolved` 的 `via` | `call`。保留：`elicitation` |
| 主体 `kind` | `user`、`connection`、`system` |
| 主体的状态（`principals` 里，由事件得出，不写在块里） | `revoked`（由 `principal.revoked`）、`disabled`（由 `tenant.imported`）；两者都不是的主体有效 |
| `write.head` `request.sv_basis` | `explicit`、`fallback` |
| `schema.confirmed` 的 `by` | `auto`、`resolve` |
| `principal.registered` 的 `via` | `token`、`oauth` |
| `impact/<k>` 的 `kind` | `overwritten_segment`、`referencing_row`、`reverted_write` |
| `sources/…` 条目的 `kind` | `value`（来自源数据，或带 `carried` 的搬运）、`schema_const`（出自 schema 常量） |
| `slot.policy_set` 的 `effective_value_rule` | `keep_current` |
| `slot.policy_set` 的 `auto_apply` | 八个改动类取值，见 §5.4 |
| 事项 `target.unit` 的固定值 | `"existence"`（目标是"存在"时 `unit` 写 `["existence"]`；第一版在用，不是保留值） |
| 编译后定义（§7）里的枚举 | 表的 `kind`、`time.type`、`granularity`、`rule.time_dependency`、`rule.scope.kind`、`rounding`、`ref.target`：取值列在 §7 的表里 |
| 导出清单（§8）的 `pending_deletions` | 取值列在 §8 |

**哪些键算枚举**：§5、§7、§8 的表格与形状说明里写成 `a | b` 或"取值：…"的键都是枚举，受 §1.6"遇到不认识的取值就停"的约束；本节是它们的索引，以各节的定义为准。

### 6.9 `trigger`

| 值 | 用在 |
|---|---|
| `deletion_expiry` | 到期物理删除 |
| `migration` | 后台迁移的切换与失败 |
| `restore` | `tenant.restored`；恢复流程按登记重新生成的删除确认与撤回 |
| `restore_backfill` | 恢复流程补的墓碑 |
| `import` | 导入时为占位的待删除项补的墓碑 |
| `oauth_refresh_replay` | 刷新令牌被重放时吊销这次授权的连接实例（`principal.revoked`） |

保留值：`job`、`retired_purge`、`rejudge`、`ruling`。

---

## 7. 编译后的 schema 定义

`schema.compiled` 的 `compiled` 块。建第一个 slot 就产生，之后重放、按时刻读、删除重放、迁移构建都只读它，不重新编译草稿。

```json
{
  "compiler": 1,
  "rsql": "rsql@1",
  "slot": "sl_4KTZ…",
  "name": "ledger",
  "sv": 1,
  "timezone": "Asia/Shanghai",
  "tables": [
    {
      "id": "t1", "name": "expenses", "kind": "base", "description": "每笔支出一行",
      "aliases": ["花销", "开销"],
      "time": {"type": "event", "field": "f1"},
      "physical": {"table": "t_t1_v1"},
      "fields": [
        {"id": "f1", "name": "date", "type": "date", "required": true, "description": "支出当天"},
        {"id": "f2", "name": "category", "type": "text", "required": true, "description": "类别"},
        {"id": "f3", "name": "amount", "type": "quantity", "required": true, "min": "0", "description": "金额",
         "unit": {"code": "CNY", "dimension": "currency:CNY"},
         "precision": {"scale": 2, "rounding": "half_up"}},
        {"id": "f4", "name": "note", "type": "text", "description": "备注"}
      ],
      "duplicate_keys": [["f1", "f2", "f3"]],
      "together": []
    },
    {
      "id": "t2", "name": "monthly_total", "kind": "derived", "description": "每月支出合计",
      "physical": {"table": "d_t2_v1"},
      "rule": {
        "id": "r1", "version": 1, "rsql": "rsql@1",
        "sql": "SELECT date_trunc('month', \"t1\".\"f1\"::timestamp)::date AS \"f1\", sum(\"t1\".\"f3\") AS \"f2\" FROM \"t1\" GROUP BY 1",
        "time_dependency": "bucketed",
        "depends_on": [{"table": "t1", "field": "f1"}, {"table": "t1", "field": "f3"}],
        "scope": {"kind": "group", "key": ["f1"], "key_from_free_text": false}
      },
      "fields": [
        {"id": "f1", "name": "month", "type": "date", "description": "该月第一天"},
        {"id": "f2", "name": "total", "type": "quantity", "description": "该月支出合计",
         "unit": {"code": "CNY", "dimension": "currency:CNY"},
         "precision": {"scale": 2, "rounding": "half_up"}}
      ]
    }
  ]
}
```

| 位置 | 键 | 含义 |
|---|---|---|
| 顶层 | `compiler` | 编译器输出格式的版本。定义的结构有不兼容变化时加 1；`apply` 遇到不认识的值停止。分工：事件的 `v` 管 `schema.compiled` 这条事件有哪些块、块里有哪些键；`compiler` 管 `compiled` 块内部这份定义的结构与编译规则（同一份草稿编译出什么）。给定义新增键（如字段的 `offset`、多字段的 `migrate`）时两者都加一 |
| | `rsql` | 编译这一版时用的受限 SQL 白名单版本（如 `rsql@1`，[`03-data-model/11-restricted-sql.md`](03-data-model/11-restricted-sql.md)「白名单的版本与变更」）。这一版的 `migrate` / `backfill` 表达式按它求值，重放也按它。派生规则各自另记（`rule.rsql`）。内核保留旧版本的行为；白名单改变了已有项的行为就出新版本。内核不认识的版本：`apply` 停止（§1.6） |
| | `slot`、`name`、`sv`、`timezone` | slot ID、名称、这一版的版本号、时区 |
| | `tables` | **这一版里全部的表**（不只是改动的），每张给完整定义。重放时只凭这一块就能解释这一版的全部写入 |
| 表 | `id`、`name`、`kind`、`description` | 都必有。`kind`：`base` / `derived`。`description` 在表、基础表字段、派生字段上都必有（schema 文档里说明是必填的，编译时缺了就不通过） |
| | `aliases` | 别名：字符串数组，可缺。给 Agent 看的说法，不参与名字解析。基础表、派生表都可以有 |
| | `time` | `{"type": "none"}` / `{"type": "event", "field": <字段 ID>}` / `{"type": "state", "granularity": "date" \| "instant"}`。事件类表的 `field` 是本表一个必填的 `date` 或 `zoned_datetime` 字段 |
| | `entity_key` | 状态类表的自然键：字段 ID 数组，可缺；给出时非空，各键字段都必填 |
| | `together` | 字段组：字段 ID 数组的数组。同组字段是一个冲突单元，所以一个字段至多在一个组里，每组至少两个字段 |
| | `duplicate_keys` | 疑似重复的判据：字段 ID 数组的数组。只出现在事件类表与无时间表上（状态类表不声明它，见 [`03-data-model/04-write-and-read.md`](03-data-model/04-write-and-read.md)「疑似重复」） |
| | `external_key` | 来源键：字段 ID 数组（1–4 个），可缺。只出现在事件类表与无时间表上；键字段不出现在 `together` 里 |
| | `physical` | `{"table": <物理表名>, "since": <整数>}`。`since` 是这张物理表最初建于哪个版本；与本版 `sv` 相同时可省，表示本版新建（新增的表、重建的表、从未被写入而改了结构的表） |
| 基础表的字段 | `id`、`name`、`type`、`description`、`required` | 前四个必有；`required` 只在为 `true` 时出现，缺省即可选 |
| | `aliases` | 别名，同表的 `aliases` |
| | `min`、`max` | 十进制字符串 |
| | `values` | `enum` 的取值 |
| | `unit` | `quantity`：`{"code": <单位代码>, "dimension": <量纲标识>, "to_base": <十进制字符串>}`。`to_base` 是换算到该量纲基准单位的系数；货币与温度没有（每种货币、每种温度单位自成量纲，不换算）。代码、量纲与系数取自单位词表 `units@1`（[`03-data-model/10-types-and-units.md`](03-data-model/10-types-and-units.md)） |
| | `precision` | `quantity`、`decimal`：`{"scale": <小数位数 0–12>, "rounding": "half_up" \| "half_even"}`。字段没声明时由编译器按默认回填（货币取 ISO 4217 的最小单位位数，其余 6；舍入 `half_up`）。写入换算后的舍入、同值判断、`min` / `max` 校验都按它；字面命中比的是原始值 |
| | `ref` | `{"table": <表 ID>, "target": "row" \| "entity"}` |
| | `migrate` | 这一版对该字段做的确定性转换：`{"sql": <按上一版的表 ID、字段 ID 绑定的表达式>}`。第一版表达式里只能出现本字段在上一版里的 ID 与常量；只对带值的项求值。同量纲换单位不写 `migrate`，按新旧单位换算（[`03-data-model/07`](03-data-model/07-schema-evolution.md)「确定性转换怎么重放」） |
| | `backfill` | 收紧约束时对违反行的补值：`{"sql": …}`（同样只引用本字段；只对有旧值的位置求值）或 `{"const": <值>}`（没有旧值的位置只有它给值；新增必填字段、可选改必填一律必须是这一种，不看表里有没有行）。两种形式不同时出现 |
| | `from` | 这一版的该字段在上一版里对应的字段 ID（改名、换类型时）。新增字段没有 |
| 派生表 | `rule.id`、`rule.version` | 规则 ID 与版本。规则文本或它依赖的字段定义有变化时版本加 1 |
| | `rule.rsql` | 这条规则编译时用的白名单版本。规则按它求值，重放也按它。一条规则只在它因别的原因重新编译时才换用当前白名单版本；没被改到的规则一直按记下的版本求值，原样抄进之后各版的 `compiled`。所以同一份 `compiled` 里的规则可以停在不同版本，与顶层 `rsql` 也可以不同。换用时，用到受影响项的规则版本加 1。内核不认识的版本：`apply` 停止（§1.6） |
| | `rule.sql` | 按表 ID、字段 ID 绑定后的受限 SQL，输出列名是派生字段 ID |
| | `rule.time_dependency` | `none` / `bucketed` / `now` |
| | `rule.depends_on` | 静态列级依赖 |
| | `rule.scope` | 重算范围：`{"kind": "group", "key": [<派生字段 ID>], "key_from_free_text": <布尔>}` 或 `{"kind": "tenant"}`。`group` 时 `key_from_free_text` 必有，表示分组键来自自由文本字段 |
| 派生表的字段 | `type`、`unit`、`precision` | 由编译器推断回填 |
| | `aliases` | 别名，同表的 `aliases` |

- 名称、说明、别名、枚举值是 schema 作者写的文字，可能含用户原话；它们不在隐私删除的级联范围内。
- 重新抽取（`reextract`）的声明不进第一版的编译结果，留位见 §10。

---

## 8. 导出文件

导出 = 这个租户的全部事件，从 `seq` 1 起（续传时从 `after` 之后起），按 `seq` 升序。读取记录、控制面、物化状态都不在其中。

- 文件是 **NDJSON**：每行一个 JSON 对象，UTF-8，行尾 `0x0A`。每行本身按 JCS 序列化：一行不等于它自己的 JCS 序列化（别的空白、行尾、键序，同一个键出现两次），导入按格式不认识拒绝。一行至多 16 MiB（按字节；远在任何一条事件之上），超过的导入报 `too_large`（`import_line`）。
- **第一行是清单**，之后每行一个事件。
- 导出文件可以整体包在 age 文件里（CLI 的可选加密）；包装不属于导出格式，解开后就是本节定义的 NDJSON。
- 一份导出可以装进一个空租户（导入，见 §5.2 `tenant.imported`）：几段续传文件按顺序接起来，逐事件原样重放。

清单：

```json
{"event_format": 1, "events": 43, "exported_at": "2026-11-10T08:00:00.000Z",
 "pending_deletions": "placeholder", "restore_count": 0, "saveslot_export": 1,
 "tenant_id": "tn_…", "upto": 43, "upto_hash": "5b1e…a7"}
```

| 键 | 含义 |
|---|---|
| `saveslot_export` | 导出文件格式的版本 |
| `tenant_id`、`event_format` | 当前的租户 ID（最近一条 `tenant.genesis` 或 `tenant.imported` 里的）；事件格式的版本 |
| `restore_count` | 导出时的租户恢复次数。导入时 `tenant.imported` 的 `restore_count` 取它加 1；几段续传文件拼接导入时取最后一段的（续传的那一段更新） |
| `after` | 续传时才有：本文件只含 `seq` 大于它的事件。带 `after` 的文件不能单独重放，要接在前一段之后。接在前一段之后的这一段：`saveslot_export`、`event_format` 是导入不认识的版本，报 `unsupported_format`（与第一段一样）；认识的版本、`tenant_id` 必须与第一段相同，`restore_count` 不得小于前一段的，否则报 `segment_order`；`pending_deletions` 各段可以不同（每个块自己带着状态）。第一段至少有创世事件，`events` 为 0 的第一段导入报 `incomplete` |
| `upto`、`events` | 本文件最后一条事件的 `seq`；本文件的事件条数（有恢复空档时小于 `upto` 与起点之差） |
| `upto_hash` | 第 `upto` 条事件头的哈希，写法同 `prev_hash`（§2.1）。最后一条事件头后面没有下一条的 `prev_hash` 替它作证，由它来核：导入在每段末尾比较本段最后一条事件头的哈希（没有事件的段比较前一段最后一条的），不等报 `chain_broken`，位置是 `upto` |
| `exported_at` | 导出时刻 |
| `pending_deletions` | `placeholder`（默认：宽限期内待删除的块换成占位）/ `included`（用户会话显式要求包含） |

事件行（每行按 JCS 序列化，键按字典序：`c` 在 `h` 之前；下面的例子为了易读分了行）：

```json
{"c": {"fields/f3/0": {"pending_deletion": 42},
       "literal/f3/0": {"pending_deletion": 42},
       "sources/f3/0": {"pending_deletion": 42},
       "target": {"sum": "c20a…5d",
                  "v": {"cause": "request", "intent": "correct", "op_index": 0, "row": "r_01JC8Z…", "sv": 1, "table": "t1"}}},
 "h": {"actor": "ci_7HQ2…", "at": "2026-11-10T04:41:07.123Z", "op": 25, "prev_hash": "9f2c…e1",
       "seq": 27, "slot": "sl_4KTZ…", "type": "write.base", "v": 1}}
```

| 键 | 含义 |
|---|---|
| `h` | 事件头对象。读取方对它重新做 JCS 序列化，得到的字节就是进链的字节 |
| `c` | 内容块：`path` → 块的状态（§3.3 的三种形状之一）。没有内容块的事件没有 `c` |

例子是宽限期内导出的（删除在 2026-11-10T05:02Z 确认，导出在三小时后；清单的 `upto` 是 43，墓碑 #44 还没有追加）：这次纠错的三个块同生同灭，都是待删除的占位。墓碑落账之后再导出，它们是 `{"removed_by": 44}`。

读取方校验：逐行对 `h` 取事件头哈希，核对下一行的 `prev_hash`；对每个 `{"v", "sum"}` 核对校验和。`seq` 的空档必须由随后的 `tenant.restored` 说明。

带占位的导出重放后，日志末端的业务状态与线上一致（删除后的样子写在 `deletion.confirmed` 里）；占位处的历史内容不可得，也无法再撤回那次删除。导入时因此为这些删除立即补墓碑（§5.9）。

---

## 9. 事件头里留下了什么

隐私删除只清空内容块。事件头永远留在链上，元数据块在第一版里也不删除；另有几类数据块没有来源，或来源不是被删的那句话，也不随这次删除清除。这一节列出删除之后还留着什么，以及每一项为什么留、能不能不留。

### 9.1 事件头（进链，不能删改）

| 字段 | 看得出什么 | 为什么必须在事件头 | 若要求不保留 |
|---|---|---|---|
| `seq`、`prev_hash` | 日志里有过这一条，位置在哪 | 链的组成部分 | 不可能移走：没有它们就没有链 |
| `v`、`type` | 这是一次什么性质的操作（一次写入、一条证据、一次确认……）。不含意图、不含表 | 重放时必须在不读内容的情况下知道怎么处理这条事件；旧内核据此判断能不能继续 | 可以把类型合并得更粗（例如把 `write.base` 与 `source.recorded` 并成一种），代价是新事件格式版本，旧事件不变 |
| `actor` | 是哪个主体做的 | 每个事件都有经手人是内核不变量；主体的吊销、审计都按它 | 可移进元数据块。代价：`verify` 不读内容就无法检查"actor 已登记" |
| `at` | 什么时候记下的 | 幂等窗口、宽限期到期、记录时刻单调都依赖它 | 可降低精度（到秒或到分钟），是新版本里的写法变化 |
| `op` | 哪几条事件属于同一次操作 | 按记录位置读时，操作要整体可见或整体不可见 | 可移进元数据块，代价同 `actor` |
| `slot` | 属于哪个 slot（不透明 ID，不是名字） | 将来按 slot 做部分复制时，事件头是全量复制的，要靠它过滤 | 可移进元数据块；部分复制届时改为读元数据块 |
| `trigger` | 内核的哪类后台任务 | 不涉及用户 | — |
| `node_id`、`restore_*`、`high_water`、`imported_upto` | 租户建于哪个节点、恢复过几次、导入过的日志到哪一条 | 事件身份与 `seq` 空档的说明 | 不涉及用户内容 |

### 9.2 元数据块（不进链，第一版不删除）

| 内容 | 看得出什么 | 若要求不保留 |
|---|---|---|
| 表 ID、行或实体 ID（含 `schema.switched` 的 `backfill_rows/<表ID>/<字段ID>/<n>` 行 ID 列表） | 某张表里有过某一行；行 ID 是 UUIDv7，带毫秒级的创建时间 | 整行被隐私删除时，把这一行的全部 `target` 块也列进位置列表。**不改事件头，不改已有事件**；代价是整行删除后版本表里不再留"该处已删除"的记录，按时刻读到那一段时看不到这一行存在过 |
| 意图 | 这次写入是新增、变更、纠错还是撤销 | 同上，随 `target` 一起删 |
| 被引用的源数据与写入的 `seq` | 哪次写入引用了哪条证据（都只是序号） | 同上 |
| 事项的类型、成因码、处理方式 | 有过一次冲突或待确认，后来怎么处理的 | 事项的目标整行被删时一并删除 `target` 块 |
| 删除 ID、到期时刻、位置列表 | 有过一次删除，清掉了哪些位置 | 不能删："删除不复活"靠墓碑与位置列表保证 |
| 规则版本、策略版本、`now`、`today` | 判定时用的版本与入口时刻。`today` 是入口时刻在 slot 时区下的日期，看得出用户给 slot 设的时区落在哪一天，看不出别的 | 不涉及用户内容 |
| 连接实例的 slot 范围（`principal.registered` 的 `slots`） | 某个连接实例被授权访问哪几个 slot（只有不透明 ID） | 不涉及用户内容；slot 名不在这里 |
| 来源键的定位与基线（`ops/<i>/target` 的 `by_external_key`、`key_from`，`ops/<i>/baseline`，`request.op_count`） | 某次写入是按来源键定位的、落到哪一行；某一行的来源键是从哪一行转来的；每个字段的同步基线在哪次操作；一次同步请求里一共有几个 op（含没变、被跳过、没进事件的）。**来源键的值不在这里**：它是键字段的普通数据块，随证据删除 | 做法同表 ID、行 ID 一行：整行被隐私删除时，把涉及这一行的 `ops/<i>/target`、`ops/<i>/baseline` 也列进位置列表。`op_count` 只是请求级的一个计数，不随某一行删除 |
| 前提的声明与状态变化（`ops/<i>/premises/<j>`、`ops/<i>/premise_covers`、`ops/<i>/premises_cleared`，`premise.changed`） | 某次写入声明过以某张表的某一行、第几号字段、在哪个版本上的值为前提；某次写入清除过前提；某条声明在哪次操作里变了状态。看不出前提的值、依赖行的值与声明的业务时间（`premise_valid` 是数据块） | 同上：依赖行被整行隐私删除时，把它的声明块也列进位置列表；不改事件头 |
| 导入的记录（`tenant.imported` 的 `tenant`、`export`） | 这条日志从哪个租户 ID 导入、导出于什么时刻、是否含待删除内容 | 不涉及用户内容 |

### 9.3 看不出什么

删除到期后，从留下的东西里看不出：被删内容给出的任何值、证据原文、出自被删内容的业务时间区间（含由它求得的端点：别的写入停在它上面的默认终点、回退与删除结果里抄下的区间，见 §3.5）、改的是哪个字段的名字与值（**字段 ID 留得下来**：它出现在数据块的 path 里，而 path 留在位置列表中；也出现在几处元数据块里——无操作字段的列表 `ops/<i>/noop`、显式指证据的字段列表 `ops/<i>/explicit`、`named_fields`、`ops/<i>/baseline` 的键、前提声明的 `fields` 与 `premise_covers` 的条目、回退记录 `revert` 的条目、事项 `target` 的 `unit`、`kept_effective` 的 `items`。所以看得出"哪次写入、哪个事项、哪条前提涉及第几号字段"，看不出字段名与值）、表名与字段名、分组键值、来源键的值、被删内容的哈希或长度。**有一处例外：别的请求的请求键与显式幂等键指纹，见 §9.5。**

另外，一次操作里各类事件的条数本身看得出几件事：这次写入带了几段证据、有几个 op、引出了几个事项、有几个派生行变了、有没有前提变了状态。事件条数由用户内容决定，但不含内容本身。按来源键写入时没进事件的 op 不留任何块，只在 `op_count` 里算一个数；全部 op 都没进事件的请求在日志里什么都不留。

把字段 ID 也去掉的办法是把 path 与这些元数据块里的字段 ID 换成不带含义的序号，属于新的事件格式版本；第一版不做。

### 9.4 不随这次删除清除的数据块

下面这些是数据块（含用户写的文字，或由用户内容算出的值），但它们没有来源，或者来源不是被删的那句话，所以一次隐私删除清不到它们。删除预览的 `not_deleted` 如实列出其中与本次删除有关的。

| 内容 | 在哪 | 为什么不清除 | 怎么去掉 |
|---|---|---|---|
| 连接实例的名称 | `principal.registered` / `principal.renamed` 的 `name` | 用户起的名字，不是由源数据得出的 | 给连接实例改名只追加新名字；清除旧名字要新增一种删除，第一版没有 |
| schema 草稿与编译结果里的文字（表名、字段名、说明、别名、枚举值、`migrate` 与 `backfill` 里的常量） | `schema.draft_submitted`、`schema.compiled` 的块（§5.5、§7） | schema 作者写的文字，不记来源。其中 `backfill` 的常量经切换补进业务表与版本表之后同样不清除，之后引用它的写回项与删除结果里也照抄这个值 | 同上；第一版只能不在 schema 里写用户原话 |
| 没有任何源数据的操作自报的任务标识、请求键、显式幂等键与指纹 | `deletion.confirmed`、`deletion.cancelled`、`schema.draft_submitted`、既没带证据、也没带 `note`、又不触发写入的 `item.resolved` 的 `task`、`request_key`、`idempotency`（§5.1） | 这些操作没有证据，三个块没有来源可沿着删 | 任务标识不要包含用户内容（工具描述里写明）；请求键过了幂等窗口后可以由一次新增的清理动作清空，第一版不做 |
| 别的请求的请求键与幂等键指纹 | 见 §9.5 | 它们只随自己那次请求的证据删除 | 见 §9.5 |
| 另一句话里重复的内容 | 别的 `source.recorded` 的 `text` 等 | 用户在另一句话里说了同样的内容，那是另一条源数据，不在这次删除的范围内 | 把那条源数据也列为删除目标 |

"存在"项 `existence/<k>` 是元数据块（只有状态与范围，没有内容），照 §9.2 留下：看得出某一行被撤销过。

### 9.5 已知边界：请求键是含内容的哈希

- **请求键**（`request_key`）由"连接实例 + 任务 + 规范化请求"算出；**显式幂等键的指纹**（`idempotency.fingerprint`）是请求内容的哈希。两者都按**原始请求体**算，请求里原样带回的无操作字段的值也参与了计算。
- 它们的来源是**本次请求的证据**：本次请求的任何一段证据被隐私删除，它们随之清除。它们**不随**"无操作字段所同值的那个旧来源"清除。
- 所以有这样一种情形：用户说过一句话 A（记下值 X），后来另一次请求原样带回了 X、并带着另一句话 B 的证据。隐私删除 A 之后，X 在全库的值、原文、区间里都检索不到；但那次请求的请求键还在，它是一个含 X 的哈希。
- **按来源键写入的请求也在这条边界内**，有两种：
  - **含普通 op 的请求**照旧记请求键，按原始请求体算，其中按来源键 op 的内容（包括 `unchanged`、`skipped`、没进事件的那些 op 交来的记录）同样进了这个哈希。它们只随这次请求自己的证据删除：一条同步来的记录被隐私删除之后，宽限期内下一次同步若仍交来它、又与普通 op 同在一个请求里，它的内容就进了一个新的请求键。连接器把按来源键的 op 与普通 op 分开请求即可避开。
  - **连接器的显式幂等键**：调用方给了 `idempotency_key`、且请求产生了事件时，指纹按整个请求体算，含没进事件的 op 的内容，规则同上。连接器用来源键就已幂等，一般不必再给显式幂等键。
  - 只含按来源键 op 的请求不记请求键（§5.1），没有这个问题；全部 op 都没进事件的请求什么都不留。
- **看得出什么**：拿到这个租户存储的人，如果已经知道那次请求的其余全部内容，可以用猜测的 X 重算哈希来比对。哈希本身推不出 X。
- **为什么留**：幂等判断靠请求键（宽限期内重发一条刚被删除的写入时不能重新写入）；把无操作字段排除在请求键之外，会让"带回的值不同"的两次请求被判为同一次。日志里除此之外不留无操作字段的任何值（§5.7）。
- **若要求不保留**：请求键过了幂等窗口（服务端算出的 10 分钟，显式幂等键 24 小时）之后不再有用，可以新增一种清理动作把过期的 `request_key`、`idempotency` 块清空；这是新增事件类型，不改已有事件。第一版不做：它们只随证据删除。

### 9.6 待办：法务确认

> **待办（服务器模式上线前；不挡本机模式与开发）**：把本节发给法务，并说明服务器模式打算在哪些地区提供。请法务逐项回答"可以留 / 不可以留"：
>
> 1. §9.1 的事件头：删除后仍看得出某时刻有过一次什么性质的操作、由哪个连接实例做的、属于哪个 slot。
> 2. §9.2 的元数据块：某张表里有过某一行（行 ID 带毫秒级创建时间）、写入的意图、涉及第几号字段、有过冲突及其处理方式。
> 3. §9.2 的前提声明：某次写入声明过以某张表的某一行、第几号字段、在哪个版本上的值为前提，以及这条声明在哪次操作里变了状态；依赖行或前提目标被隐私删除后仍留下。
> 4. §9.5 的请求键与显式幂等键指纹：由请求内容算出的哈希，只随本次请求的证据删除；连接器的混合请求里，没进事件的记录内容也在其中。
> 5. §9.2 的 `request.op_count`：删除之后仍看得出一次同步请求交了多少条记录（含没变、被跳过的）。
> 6. §9.4 的几类文字：连接实例的名称、schema 里的文字、另一句话里重复的内容。
> 7. 删除的执行方式：24 小时宽限期与法定删除时限的关系；物理删除的时点、备份保留期怎么向用户告知。
>
> 每一项"不可以留"对应的改法与代价见各小节的"若要求不保留"一栏。只有"日志里有过这一条"（`seq`、`prev_hash`）无法去掉。

---

## 10. 留位与演进

下面这些第一版不产生。每一项写明将来加入时新增什么；**加入时都不需要改写已有事件**。按 §1.6 的规则，凡是用到下表里新增的 path、键或枚举值的事件，该事件类型的 `v` 加一；没用到的事件照旧。

| 能力 | 将来新增什么 |
|---|---|
| 系统裁定（级别高的候选自动生效） | `write.base` 的 `cause` 加 `ruling`、`intent` 加 `applied_by_rule`、字段项的 `status` 加 `applied_by_rule`（按规则生效）；候选的 `cause` 加 `displaced_by_rule`；`trigger` 加 `ruling`；`slot.policy_set` 的 `effective_value_rule` 加 `by_rank`（按来源级别的秩裁定）。它要用到的输入第一版已经在记：`literal/*`、`stated_at`、`ctx` 的两个版本号、`merge_base_op`、`ver.basis`、`writer_had_read`、`seen_valid` |
| 重判（让旧事项改用新规则或新策略） | 新事件类型 `judge.rejudged`（头事件，`trigger: "rejudge"`）：列出被重判的写入与事项、新的生效状态、新的两个版本号。内核停用某个旧规则版本之前，必须先对还用着它的写入做一次重判 |
| 删除证据（只删原文，值留下） | `deletion.confirmed` 的 `kind` 加 `evidence`；`item.superseded` 的 `reason` 用上 `evidence_deleted`。位置列表只含源数据的原文块 |
| 按行隐私删除 | `deletion.confirmed` 的 `target` 加可选的 `rows`；计算与事件形状不变 |
| 抽取作业（重新抽取类迁移、新字段补抽） | 新事件类型 `schema.migration_result`（翻译结果按 `items/<工作项>/<字段ID>` 切块，来源是工作项附带的全部原文）、`schema.migration_abandoned`（第一版不产生：确定性迁移没有人工放弃的出口）；`schema.switched` 加可选块 `pending_extraction`；事项类型 `migration_diff` 及其处理方式；`compiled` 的字段加 `reextract`；`deletion.confirmed` 加可选块 `reextract/<k>`；数据标记 `pending_extraction` |
| 大写入作业 | 新事件类型 `job.accepted`（请求内容按 op 切块）、`job.completed`、`job.failed`；`trigger` 加 `job`；数据标记 `stale` |
| 退役表清理 | 新事件类型 `schema.retired_purged`（`actor: "system"`，`trigger: "retired_purge"`），列出被清理的物理表 |
| slot 策略修改、策略指定的高影响 | `slot.policy_set` 作为头事件由用户会话产生（没有 `op` 字段、带 `ctx`，是新的形状，`v` 加一）；`high_impact`、`user_session_only` 开始有内容；成因码 `policy_high_impact` |
| scope 变更 | 新事件类型 `principal.scope_changed`；slot 范围随它一起改，不另设事件 |
| 外部权威级别（`external_authority`） | `principal.registered` 的 `principal` 块加可选键，记这个连接实例是否被授予声明这一级别（授予只能由用户会话在签发时做）；源数据 `target.level` 启用保留值 `external_authority` |
| 以派生行为前提 | `ops/<i>/premises/<j>` 的目标加可选键 `partition`；`premise.changed` 由派生写入触发 |
| 官方 schema（`extends` / `compatibility`） | `compiled` 顶层加可选键 `extends`：`{"id", "version", "hash"}`（只记标识、版本与官方定义的内容哈希，定义全文已在 `tables` 里）；表与字段加可选键 `official`：`{"id"}`（官方给的稳定句柄，字段 ID 仍由 saveslot 分配）；`compatibility` 暂不留键，随升级流程一起加；改动码加 `declare_extends`（类别 `metadata`）。用到这些键的 `schema.compiled` 的 `v` 与 `compiler` 加一。草稿里出现 `extends` / `compatibility` 在实现之前整份报 `not_in_this_version` |
| `elicitation` 确认 | 启用 `item.resolved` 的 `via` 的保留值 `elicitation`；用到它的 `item.resolved` 的 `v` 加一 |
| 加密 | 存储里每个内容块留有可空的密钥标识；校验和改为对密文求时是存储格式的变化，不是事件格式的变化 |
| 签名检查点、哈希树 | 新事件类型，定期对一段事件头做承诺；旧事件不追加 |
| 回退到指定版本（`revert: {to, fields}`） | `write.head` 的 `ops/<i>/revert` 加可选键 `to_op`、`fields`；`write.base` 的形状不变（值来源照旧是 `carried`） |
| 改正实体的键（`rekey`） | 一种新的写入意图或 `ops/<i>/target` 的可选键，连同它自己的 `write.base` 形状；第一版键不可改，写错了靠撤销重写 |
| 引用多个字段的 `migrate` / `backfill` | `compiled` 里字段的 `migrate` / `backfill` 允许出现别的字段 ID，并新增"由转换产生的贡献"的记法（一条只写了输入字段的旧写入在新字段上产生的项）；属于新版本下的重放规则：带这种定义的 `schema.compiled`（`v` 与 `compiler` 都加一）与随后的 `schema.switched`（`v` 加一）；旧的编译与切换事件按旧规则重放 |
| 温度单位互相换算 | `compiled` 里 `unit` 加可选键 `offset`（十进制字符串）；已有定义没有它，含义不变 |
| 词表外的自定义单位 | `compiled` 里 `unit` 的 `code` 取词表外的值时另带完整定义；属于新的单位词表版本 |

**多节点**（本地 + 云、多设备、离线写入）：

- 别的节点产生、被主节点接受的事件，事件头加一个可选字段 `origin`：`{"node": <node_id>, "seq": <该节点上的序号>}`。没有 `origin` 的事件，身份按 §2.2 的约定推出，所以已有事件不用动。
- 新事件类型 `sync.primary_changed`（主节点切换）等同步控制事件；事项类型 `sync_rejected`。
- 事件头只含不透明 ID 且带 `slot`，按 slot 做部分复制时事件头与墓碑全量复制，内容块按 slot 过滤。

---

## 11. 本文待定项

没有。写格式时遗留的几项都已定下：单位词表、精度与舍入见 [`03-data-model/10-types-and-units.md`](03-data-model/10-types-and-units.md)；默认策略与 `auto_apply` 的取值见 §5.4；标识的前缀见 §1.4。之后新出现的待定项登记在 [`08-open-questions.md`](08-open-questions.md)。
