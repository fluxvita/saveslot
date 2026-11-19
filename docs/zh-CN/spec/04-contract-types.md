# saveslot · 操作契约的类型定义

> 本文是操作契约的**结构**：每个操作的参数、结果、错误与全部枚举，写成 TypeScript 类型。规则与说明（什么时候返回什么、为什么）在 [`04-contract.md`](04-contract.md)；内核规则在 [`03-data-model/`](03-data-model/README.md)；MCP 与 HTTP 怎么承载在 [`05-surfaces.md`](05-surfaces.md)。
> **字段名、嵌套结构与枚举值以本文为准。** 实现里的 `contract-core` / `contract` 两个包与本文逐项对应；OpenAPI 由它们生成，MCP 的 `inputSchema` 由本文件的类型按 [`05-surfaces.md`](05-surfaces.md) 第 1 节的映射表组合生成。MCP 参数的 `description` 是写给模型看的措辞，原文在 [`05-surfaces.md`](05-surfaces.md) 9.1；本文参数上的注释说明类型与约束。

## 0. 约定

### 0.1 写法

- 类型用 TypeScript 写，只表达形状；`?` 表示可选。注释里的"必填""互斥"等约束由服务端校验，违反时报 `invalid_argument`（除非另有说明）。
- **属于 `contract-core`（内核依赖）的**：第 1–3 节的公共类型、各操作结果里的数据部分、第 9 节的领域错误。**属于 `contract`（对外封装）的**：`task`、`idempotency_key`、`limit` / `cursor`、`detail`、句柄、`notices`、`replayed`、`truncated`、第 9 节的外层错误、第 8 节管理类操作。
- **例子里的标识**写成"前缀 + 开头几个字符 + `…`"；`s_1`、`s_2` 是贯穿各文档的例子里两条源数据的简写标签。真实标识的长度与字符集见 data-model「标识的写法」。
- **枚举只增不减**：加可选字段、加错误码、加枚举值升契约的次版本，调用方必须容忍未知的字段与枚举值（architecture §6）。
- **键名统一**：

  | 含义 | 键名 |
  |---|---|
  | 操作号（见 1.2） | `seq` |
  | 记录时刻 | 结果顶层：`recorded_at`；描述某个已发生的事件的嵌套对象（`resolution`、`superseded`、`reads[]`、`removed`）里：`at` |
  | 谁做的 | `actor` |
  | 对象的种类 | `type`（事项）、`kind`（证据、源数据、删除）；schema 改动用 `change`（改动码）与 `class`（类别） |
  | 码 | `code`（错误、提醒、提示、校验明细）、`reason`（原因码：事项为什么产生 / 被取代、标记的成因、错误的细分）；候选的来由用 `cause`（与事件格式同名） |
  | 待处理事项 | `item`（只给 ID）或 `{id, item_ver}` |

### 0.2 第一版不实现

本文写完整设计。第一版不实现的参数、取值、操作统一标 `@later`。**调用第一版不实现的东西一律报 `not_in_this_version`**（第 9 节），第一版生成的 schema 里不出现它们。

| 位置 | 第一版不实现的 |
|---|---|
| `write` | `mode: "job"` 与作业（`status: "job"`、`job`、单个 op 超阈值自动转作业）；`revert: {to, fields}`；逐字段结果 `applied_by_rule`；意图 `applied_by_rule` |
| `write`（MCP） | op 级 `acknowledge`、证据段的 `level`（HTTP 开放） |
| 证据 | 来源级别 `external_authority` |
| `history` | `mode: "composition"` |
| `sources` | `mode: "search"` 的全文检索（第一版是子串匹配，参数相同） |
| `deletion_preview` / `delete` | `kind: "evidence"`、`rows`；结果里的 `reextract`、`cleared`、`collateral_rows` |
| `pending` / `resolve` | 事项类型 `migration_diff` 及其处理方式；作业（`jb_…`）；取代原因 `evidence_deleted`、`migration_failed`；候选的来由 `displaced_by_rule` |
| `schema_draft` | 改动类别 `reextract`；字段上的 `reextract`；`extends`、`compatibility`；`derived` 改 `base`；**在写入过的表上**：表的时间类型变更、增删改 `entity_key`、改 `granularity`、`base` 改 `derived`、`ref` 与其他类型互转、改 `ref` 的目标、换一组来源键（`change_external_key`）、来源键字段改类型或收紧约束（对应的改动码见 5.3；`reason` 是 `table_written`）；`migrate` / `backfill` 表达式引用本字段以外的字段；最外层不是聚合的派生规则、沙箱函数规则。草稿里出现时整份草稿报 `not_in_this_version` |
| 标记 | `stale`、`pending_extraction`；`possibly_affected` 的 `applied_by_rule` |
| 提醒 | `job_items_appended` |
| 提示 | `job_failed` |
| 操作 | `extract_claim`、`extract_submit`、`policy.set` |
| 错误 | `lease_expired`、`referenced` |
| slot 策略 | 冲突期间按来源级别裁定（第一版只有 `keep_current`）；额外的高影响表 / 字段；"某类处理只接受用户会话的确认"开关 |
| 概况 | `catalog` 的表概况第一版只有行数与业务时间范围、规模提示 `scale`、每个字段最近 K 个不同取值；没有"最近一次写入时间"。概况随 P2 给出（07-scope）：在那之前 `table` 档不带 `profile`、`examples`、`described_by` |

---

## 1. 公共类型

### 1.1 标识

```ts
type SlotName = string;         // 用户内唯一；也接受 slot_id
type TableName = string;        // "ledger.expenses"，或在可见范围内不重名时 "expenses"
type FieldName = string;        // 不以 "_" 开头；不是 valid / valid_from / valid_to / row_id / entity_id；作用域内不分 ASCII 大小写唯一（见 04-contract 第 1 节）

type SlotId   = string;         // "sl_…"
type RowId    = string;         // "r_…"   事件类表、无时间表的一行
type EntityId = string;         // "e_…"   状态类表的一个实体
type SourceId = string;         // "s_…"   一条源数据
type ItemId   = string;         // "pi_…"  待处理事项；删除 ID 也是它
type DraftId  = string;         // "d_…"   schema 草稿
type ReadId   = string;         // "rd_…"  一次读取
type ConnectionId = string;     // "ci_…"  连接实例
type JobId    = string;         // "jb_…"  @later

type DeleteConfirm = string;    // "dc_…"  删除确认句柄，签名
type Cursor        = string;    // "cur_…" 翻页句柄，签名
```

### 1.2 序号与版本令牌

```ts
/**
 * 操作号。一次 write / resolve / delete / 撤回各有一个：它的头事件的 seq。
 * 对外出现的 #n 全部是操作号：回执的 seq、ver 里的序号、timeline 的条目、undo 的 n、
 * as_of / since / until 的取值。一次操作内部各条事件的 seq 不对外。
 */
type Seq = number;

/** "v57.0" = （最近一次改动这一行 / 实体当前状态的操作号，租户恢复次数）。恢复次数从 0 起。读取时返回，写入时原样带回。
 *  操作号取版本表里意图不是 schema_switch 的最新版本：schema 切换的补值不改 ver。 */
type Ver = string;

/** "h41.0"：history 的 as_of 返回的历史版本。不能用于写入，不参与兜底。操作号的取法同 Ver（不算 schema 切换的补值）。 */
type HistoricalVer = string;

/** slot 的 schema 版本，整数，从 1 起。 */
type Sv = number;

/** "iv_…"：待处理事项的版本令牌。事项详情与"新生成且回执给全了内容"的回执返回，resolve 时带回。 */
type ItemVer = string;
```

### 1.3 时间

```ts
type DateStr = string;          // "2026-11-10"
type Instant = string;          // RFC 3339，带偏移："2026-11-10T12:31:00+08:00"
/**
 * RFC 9557："2026-11-10T12:31:00+08:00[Asia/Shanghai]"。
 * 给出（读取结果与回执里的值）：该时区在这一瞬间的墙上时间，精确到毫秒（毫秒为 0 时不写小数）；偏移是该时区
 * 在这一瞬间的确切偏移舍到整分（四舍五入，恰好半分时向远离零的方向：-00:44:30 写作 -00:45），写成 ±HH:MM；
 * 方括号里是记下的时区名。UTC 写作 "+00:00[UTC]"。
 * 收进（写入）：偏移与时区名都写了的，偏移必须等于该时区在这个墙上时间的确切偏移按同一规则舍到整分（回拨的那一小时
 * 有两个瞬间，先取确切偏移恰好等于所写偏移的那一个，没有再取舍到整分后相等的那一个），相等就按确切偏移取瞬间，否则与时区不一致、拒绝（"+00:00"、"-00:00"
 * 也按偏移比）；写的是 Z 加时区名的，Z 表示瞬间是 UTC、本地偏移未知（RFC 9557），取这个 UTC 瞬间、记这个时区，
 * 不比偏移；只写时区名的按该时区的墙上时间取瞬间；只写偏移的按偏移取瞬间，时区记为 slot 的。所以读出来的值原样
 * 写回，得到同一个瞬间与时区。
 */
type ZonedDateTime = string;

/** 业务时间上的一个点。表的粒度是 date 时取 DateStr，是 instant 时取 Instant。 */
type BizTime = DateStr | Instant;

/** 记录时间上的一个点：操作号，或时刻（换算成不晚于它的最后一个操作号；未来的时刻等于最新）。 */
type RecordPoint = Seq | Instant;

/** 业务时间区间，左闭右开。 */
interface Interval {
  /** null 表示起点开口，只出现在：事项区间（ItemTarget.spans）与详情各段里的整段时间（此时 valid_to 也是 null，
   *  整实体撤销成为候选），以及事项区间的第一段、详情的段起点开口时（整段时间上的写回被别的项切开之后）；
   *  写入回执里状态类表上作用于整段时间的那一段：整体撤销（不带区间的 revoke），整体撤销的 undo（op 的 intent 可以是
   *  update 或 correct），以及 include_later 一并回掉、成为候选的整段（applied 与 candidate 都是），此时 valid_to 也是 null；
   *  写入回执与 timeline 里回掉一次整体撤销的写回段（被别的项切开时起点开口）。
   *  读取结果里的行总有起点；标记里的事项各段按行的区间切过，事项第一段起点开口时取行的起点，所以也总有起点。 */
  valid_from: BizTime | null;
  valid_to: BizTime | null;        // null = 一直延续
  valid_to_inclusive?: DateStr;    // 只在 date 粒度且 valid_to 非 null 时给：区间里的最后一天
}
```

### 1.4 值

```ts
interface Quantity { value: string; unit: string }   // value 是十进制字符串："45"、"5.2"

/**
 * 字段的值，按 schema 声明的类型：
 *   text → string（返回时是 UntrustedText）     integer → 十进制字符串  decimal → 十进制字符串
 *   boolean → boolean                            enum → string           date → DateStr
 *   zoned_datetime → ZonedDateTime               quantity → Quantity     ref → RowId | EntityId | "@临时名"
 * integer 是 64 位有符号整数，会超出 JSON 数字的安全范围（2^53 − 1），所以结果里一律写成十进制字符串（与事件格式一致）。
 * 写入时 integer、decimal 也接受 JSON 数字（按原始文本解析，不经双精度）；integer 用 JSON 数字时须在安全范围内，否则写成字符串。
 * null = 清空（只对可选字段；必填字段报 validation_failed / required_missing）。清空是一次贡献，值来源是这次写入的证据。
 */
type Value = string | number | boolean | Quantity | null;

type Values = Record<FieldName, Value>;

/** 来自用户内容或调用方撰写、可能含指令的文本。字段值保持原样；不可信边界由外化面加（05-surfaces）。 */
type UntrustedText = string;
```

**与事件格式的写法对照**（同一个值在日志事件里与对外契约里的写法不同，实现时两边各按各的；见 [`09-event-format.md`](09-event-format.md) 1.2、1.3）：

| 值 | 契约（对外） | 事件格式（日志里） |
|---|---|---|
| 时刻 | RFC 3339，可带偏移 | UTC，固定毫秒精度，以 `Z` 结尾 |
| 带时区的时刻 `zoned_datetime` | 一个字符串（带偏移与时区名） | `{"instant": <时刻>, "zone": <IANA 时区名>}` |
| 业务时间区间 | `{valid_from, valid_to}`，开口的一端是 `null`；`date` 粒度另给 `valid_to_inclusive`。整段时间（事项区间与回执里作用于整段时间的那一段：整体撤销、它的 undo、include_later 一并回掉的候选）：`{valid_from: null, valid_to: null}`；起点开口（回掉一次整体撤销的写回段）：`valid_from` 为 `null` | `{"from", "to"}`，开口的一端缺省：`{"to"}` 起点开口，`{"from"}` 终点开口，`{}` 整段时间（`scope_valid` 的整段时间写 `[{}]`；见 09 §1.2） |
| 整数、小数、数量、日期、布尔、枚举、文本 | 两边相同（整数与小数都是十进制字符串） | 同左 |
| "存在"（这一行 / 这段是否存在） | 在字段名的位置上写 `"*"`：`fields` 的键、`unit` 与标记里的字段数组 | `"existence"`；事项 `target` 的 `unit` 写 `["existence"]` |
| 删除的逐行结果 | `result` | `outcome`（`results/<k>/target`），取值相同 |
| 执行后会改掉的段（事项的影响） | `impact.overwritten`（被覆盖的段）与 `impact.filled_gaps`（被填掉的无值区间） | `impact/<k>` 的 `overwritten_segment`：带 `gap` 的段（无值区间）在契约里进 `filled_gaps`；其余（含值被清空成 `null` 的段）进 `overwritten` |
| 疑似重复命中的行 | `FlaggedDetail.related`（命中的那组键值另在 `matched_values`） | `matched`（`write.base` 的 `duplicate`、`item.created` 的 `matched/<k>`） |

### 1.5 目标

```ts
/** 定位一行 / 一个实体 / 一个派生行。除 table 外恰好给一个（insert 时都不给）。
 *  例外：给没有来源键的行补键时，写入 op 同时给 row 与 external_key（04-contract 5.1）。 */
interface Target {
  table: TableName;
  row?: RowId;                             // 事件类表、无时间表
  entity?: EntityId;                       // 状态类表
  entity_key?: Record<FieldName, Value>;   // 状态类表，schema 声明了 entity_key 时：{"category": "餐饮"}
  /** 来源键：事件类表、无时间表，schema 声明了 external_key 时，给出全部键字段的值：{"origin": "band_app", "external_id": "m-2"}。
   *  只用于写入；读操作的参数不收它，给了报 invalid_argument。 */
  external_key?: Record<FieldName, Value>;
  key?: Record<FieldName, Value>;          // 派生表的分组键：{"month": "2026-11-01"}；不分组的整体聚合：空对象 {}。只读
}

/** 结果里的行标识：服务端总是给出 ID；有自然键 / 来源键 / 分组键时一并给出。派生行只给 key（分组键；不分组的整体聚合是空对象 {}）。 */
interface TargetRef {
  table: TableName;
  row?: RowId;
  entity?: EntityId;
  entity_key?: Record<FieldName, Value>;
  external_key?: Record<FieldName, Value>;
  key?: Record<FieldName, Value>;
}
```

### 1.6 主体

```ts
interface Actor {
  kind: "connection" | "user" | "system";
  id: string;            // ConnectionId、用户 ID，或 "system"
  name: string;          // 连接实例名（"MacBook · Claude Code"）、用户名，或 "system"
  /** 主体已吊销（revoked）或因导入而停用（disabled）时给；正常时不给。它写过的数据 actor 不变，名字照旧显示。 */
  state?: "revoked" | "disabled";
}
```

写入回执（含 `resolve` 触发的写入）里的 `Actor` 取这次写入操作当时的样子：`name` 是日志里不晚于这次写入的最后一次登记或改名给出的名字，`state` 是那时的状态。"这次写入"指回执所属的那次操作，不是字段里 `seq` 指向的那次更早的操作：例如 `by: {seq: 11, actor}` 说的是现在生效的值由第 11 号操作给出，`actor` 的名字与状态仍取本次写入当时的。读操作与管理类操作的结果取现在的。所以之后的改名、吊销不改变一次写入的回执，幂等重放也给出同样的主体（[`03-data-model/04-write-and-read.md`](03-data-model/04-write-and-read.md)「幂等重放的回执」）。

### 1.7 每个操作都有的参数与结果

```ts
interface CommonParams {
  /** 可选的任务标识，自报。同一任务的读写用同一个值；参与 ver / item_ver / sv 的兜底与服务端请求键。HTTP 上经请求头传。 */
  task?: string;
}

interface WriteCommonParams extends CommonParams {
  /** 可选的显式幂等键。窗口 24 小时；同一个键配不同的请求内容报 invalid_argument。HTTP 上经请求头传。 */
  idempotency_key?: string;
}

interface PageParams {
  limit?: number;                  // 默认 20，上限 200
  cursor?: Cursor;
}

interface CommonResult {
  warnings?: Warning[];            // 第 7 节
  notices?: Notice[];              // 第 7 节，最多 3 条
}

interface PageResult {
  total: number;                   // 满足条件的总数
  next_cursor?: Cursor;            // 没有下一页时不给
  truncated?: { shown: number; total: number };   // 外化面按结果预算提前截断时给；截断点就是页边界
}
```

---

## 2. 证据

```ts
type EvidenceKind = "user_message" | "agent_note" | "tool_result" | "file_ref" | "source_ref";
type SourceLevel  = "user_stated" | "agent_inferred";      // external_authority @later

type EvidenceSegment = TextSegment | FileRefSegment | SourceRefSegment;

interface TextSegment {
  kind: "user_message" | "agent_note" | "tool_result";
  text: string;                    // 必填，非空
  level?: SourceLevel;             // 覆盖按 kind 推出的默认值。MCP 不暴露
  stated_at?: Instant;             // 可选：这句话是什么时候说的 / 这个结果是什么时候得到的。不给就是未知
}

interface FileRefSegment {
  kind: "file_ref";
  name: string;                    // 必填
  mime: string;                    // 必填
  size: number;                    // 必填，字节
  sha256: string;                  // 必填，十六进制
  origin?: string;                 // 来源位置（URL / 路径）
  excerpt?: string;                // 文本摘录
  level?: SourceLevel;
  stated_at?: Instant;
}

interface SourceRefSegment {
  kind: "source_ref";
  id: SourceId;                    // 同一 slot 里已有的源数据；宽限期内待删除的不能引用
}
```

op 上与证据有关的三个字段（定义在 `WriteOp`；`ResolveParams` 只取 `evidence` 与 `evidence_by_field`，见 5.2）：

```ts
interface EvidenceOnOp {
  /** 只属于这个 op 的段。 */
  evidence?: EvidenceSegment[];
  /** 引用请求级 evidence 的下标。evidence 与 evidence_refs 都没给时，引用全部请求级段。 */
  evidence_refs?: number[];
  /**
   * 按字段指明证据：字段名 → 下标数组。下标数的是这个 op 可见的段：先数内联段，再按 evidence_refs 的顺序数请求级段。
   * 保留键 "valid" 指状态类表区间参数（起点、显式终点）的出处。
   * 值没变的字段只有出现在这里才算佐证。数组不能为空，下标不能越界。
   */
  evidence_by_field?: Record<FieldName | "valid", number[]>;
}
```

源数据的种类比证据多一种 `api_call`（没带证据时的请求本身），少一种 `source_ref`（引用不产生新的源数据）。“纠错”不是种类，是由写入意图得出的标注：一条源数据被某次 `intent: correct` 的写入用作值来源时，读结果里带 `correction: true`。

```ts
type SourceKind = "user_message" | "agent_note" | "tool_result" | "file_ref" | "api_call";
```

---

## 3. 标记

读结果的每一行带 `marks`（没有任何标记时不给）。

```ts
interface Marks {
  /** 有未解决的冲突事项；给出的是按规则裁定的生效值。一行可以有多个事项。 */
  disputed?: Array<{ item: ItemId; fields: Array<FieldName | "*">; spans?: Interval[] }>;   // "*" = 争议的是这一行 / 这段是否存在；spans：事项区间的各段
  /** 有提议尚未生效；给出的是当前值。 */
  awaiting?: Array<{ item: ItemId; fields: Array<FieldName | "*">; spans?: Interval[]; proposed?: Values | null; proposed_revert?: { undo: Seq } }>;  // proposed: null = 提议撤销；提议是一次回退时不给 proposed，给 proposed_revert
  /** 值已生效，只是被标记。 */
  flagged?: Array<{ item: ItemId; reason: FlaggedReason; related?: TargetRef }>;   // related：被比中的行里操作号最大的那一行；完整列表见事项详情的 related
  /** 该行被纠错过。 */
  corrected?: true;
  /** 该行已撤销。只在 include_revoked: true 时出现。 */
  revoked?: { seq: Seq };
  /** 本连接实例之前读过的版本后来受影响；值后来恢复则撤掉。 */
  possibly_affected?: { reason: AffectedReason };
  /** 按时刻读、还原时，当时的部分数据已删除。 */
  partially_deleted?: true;
  /** 这一行有一项可撤回的删除（宽限期内）。 */
  pending_deletion?: { item: ItemId };
  /** 这一行的某个 ref 字段指向的行 / 实体已撤销，或已被隐私删除。引用方的值不变（保留 ID），只标出来；目标的撤销被 undo 后标记消失。 */
  dangling_ref?: Array<{ field: FieldName; state: "revoked" | "deleted" }>;
  /** 这一行当前的值所用到的前提后来变了（04-contract 5.1「写入的前提」）。值没有动；是否仍然成立由读方判断。
   *  任何读取方都看得到。最多列 10 条，按 since 从新到旧；超出时另给 premise_changed_total。打标记、撤标记都不改这一行的 ver。 */
  premise_changed?: Array<{
    premise: TargetRef;            // 前提所在的行 / 实体
    premise_fields?: FieldName[];  // 声明的字段；没有 = 整行
    seen: Ver;                     // 声明时所见的版本
    reason: PremiseReason;
    since: Seq;                    // 使前提不同于所见值的那次操作（删除之后改指那次删除）
    fields: FieldName[];           // 本行里由这条声明覆盖的字段
    declared: { seq: Seq; actor: Actor };   // 哪次写入声明的
  }>;
  premise_changed_total?: number;  // premise_changed 超过 10 条时：总条数
  /** 派生行是读时算出的（规则依赖"现在"，或读状态类表而不带业务时间限定）：值随读取时刻而定，这一行不带 ver。 */
  computed_at_read?: true;
  stale?: { job: JobId };                        // @later
  pending_extraction?: { fields: FieldName[] };  // @later
}

type FlaggedReason  = "duplicate_keys";
type AffectedReason = "correct" | "revoke" | "retroactive" | "plan_changed" | "applied_by_rule" /* @later */;

/** 前提变了的原因。correct、revoke、retroactive、plan_changed 与 AffectedReason 同名同义；update：前提被变更（事件类表、无时间表上的 update 也算）；
 *  deleted：隐私删除改掉了前提的值。一次写入在所声明的范围上同时有追溯与未来的部分时取 retroactive。 */
type PremiseReason = "correct" | "update" | "revoke" | "retroactive" | "plan_changed" | "deleted";

/** 派生行没有自己的标记，带输入上的汇总：落进这个分区的基础行（规则 WHERE 之后的行；FILTER 不影响，HAVING 不涉及）里，
 *  在规则所依赖的字段上、或在这一行的"存在"上带标记的行数。同一行带同一种标记只算一次。四项都为 0 时也给。 */
interface InputMarks {
  disputed: number;
  awaiting: number;
  flagged: number;
  premise_changed: number;   // 规则所依赖的字段上带 premise_changed 的基础行数
  items: ItemId[];       // 涉及的未决事项，按 ID 的字符串顺序，最多 10 个
}
```

---

## 4. 读操作

### 4.1 读结果里的一行

```ts
interface Row extends TargetRef {
  /** 基础表的行必带。派生行也带：最近一次改动它的值的操作号，不能用于写入。
   *  读时计算的派生行（marks.computed_at_read）不带：它没有派生写入，值随读取时刻而定。 */
  ver?: Ver | HistoricalVer;
  historical?: true;             // as_of 读到的历史版本
  values: Values;                // 字段名 → 值。只含请求的 fields（默认全部）
  /** 状态类表：这一段的生效区间。一段一行；同一实体的各段 entity 与 ver 相同。 */
  valid_from?: BizTime;
  valid_to?: BizTime | null;
  valid_to_inclusive?: DateStr;
  marks?: Marks;
  input_marks?: InputMarks;      // 只有派生行
  detail?: RowDetail;            // detail: "detailed" 时
}

interface RowDetail {
  seq: Seq;                      // 最近一次改动它的操作号（与 ver 里的号相同：不算 schema 切换的补值）
  recorded_at: Instant;
  fields: Record<FieldName, {
    field_id: string;
    level?: SourceLevel;         // 仍在的值来源里字面命中的最高声明级别；一段都没命中时不给
    literal: "hit" | "miss" | "na";   // 字面命中
    ref?: { values: Values };    // ref 字段：被引用行的摘要
  }>;
  /** 这一行当前生效的全部前提声明（含没变的）。字段的含义同 Marks.premise_changed；state: current 时不给 reason、since。没有声明时不给。 */
  premises?: Array<{
    premise: TargetRef; premise_fields?: FieldName[]; seen: Ver;
    state: "current" | "changed"; reason?: PremiseReason; since?: Seq;
    fields: FieldName[]; declared: { seq: Seq; actor: Actor };
  }>;
}
```

### 4.2 `catalog`

```ts
interface CatalogParams extends CommonParams {
  /** list（默认）：slot 与表的清单。table：某几张表的字段与概况。schema：某个 slot 的完整 schema 文档。 */
  level?: "list" | "table" | "schema";
  slot?: SlotName;               // list：只看这个 slot。schema：必填
  /** 只对 schema：读这份草稿编译后的文档（ID 已回填），不读当前版本。草稿是什么状态都可以读；照常记读取记录。
   *  草稿不存在或不可见报 not_found（draft）。 */
  draft?: DraftId;
  tables?: TableName[];          // table：必填，1–10 张
  limit?: number;                // 只对 list：默认 50，上限 200（按表计）
  cursor?: Cursor;
}

type CatalogResult = CatalogList | CatalogTables | CatalogSchema;

interface CatalogList extends CommonResult, PageResult {
  level: "list";
  slots: Array<{
    slot: SlotName; slot_id: SlotId; sv: Sv; timezone: string;
    migration?: MigrationStatus;                 // 迁移进行中时
    /** aliases：表的别名，没有时不给。别名不参与名字解析（04-contract 第 10 节 catalog）。 */
    tables: Array<{ table: TableName; kind: "base" | "derived"; description: UntrustedText; aliases?: UntrustedText[] }>;
  }>;
}

interface CatalogTables extends CommonResult {
  level: "table";
  tables: Array<{
    table: TableName; slot: SlotName; sv: Sv; timezone: string;
    kind: "base" | "derived";
    description: UntrustedText;
    aliases?: UntrustedText[];                   // 表的别名，至多 8 个；不参与名字解析
    /** 派生表不给：三种取值都不适用于派生表。 */
    time?: { type: "none" } | { type: "event"; field: FieldName } | { type: "state"; granularity: "date" | "instant" };
    entity_key?: FieldName[];
    external_key?: FieldName[];                  // 来源键的键字段（事件类表、无时间表）
    duplicate_keys?: FieldName[][];
    together?: FieldName[][];                    // 字段组：同组字段作为一个冲突单元
    fields: Array<{
      name: FieldName; type: FieldType; description: UntrustedText;
      aliases?: UntrustedText[];                 // 字段的别名，至多 8 个；不参与名字解析
      required?: true; unit?: string; min?: string; max?: string; values?: string[];
      ref?: { table: TableName; target: "row" | "entity" };
      /** decimal、quantity 字段：小数位数与舍入方式（schema 没声明时是编译器回填的默认值）。写入时超出的位数按它舍入（提醒 rounded）。 */
      precision?: { scale: number; rounding: Rounding };
      examples?: UntrustedText[];                // 最近 K 个不同取值
    }>;
    /** depends_on：规则依赖的字段，每项写成"表名.字段名"（"runs.distance"）。派生规则不跨 slot，表名是同一 slot 内的短表名，不带 slot 前缀。 */
    rule?: { id: string; version: number; sql: UntrustedText; time_dependency: "none" | "bucketed" | "now"; depends_on: string[] };
    /** 概况（连同字段的 examples 与 described_by）随 P2 给出（07-scope），在那之前不带；见 0.2。 */
    profile?: {
      rows: number;
      time_range?: { from: BizTime; to: BizTime };
      /** 规模提示：行数超过舒适线时给，读时按当前行数与内核自带的界线算出，不进事件，不是数据标记。
       *  large：超过 comfortable_rows、不超过 tested_rows；beyond_tested：超过 tested_rows。 */
      scale?: { level: "large" | "beyond_tested"; comfortable_rows: number; tested_rows: number };
    };
    described_by?: { actor: Actor; sv: Sv };     // 说明是谁、在哪一版写的
  }>;
}

type FieldType = "text" | "integer" | "decimal" | "boolean" | "enum" | "date" | "zoned_datetime" | "quantity" | "ref";

/** half_up：四舍五入，恰在一半时远离零。half_even：恰在一半时取偶。 */
type Rounding = "half_up" | "half_even";

interface CatalogSchema extends CommonResult {
  level: "schema";
  slot: SlotName;
  sv: Sv;                        // 带 draft 时是这份草稿确认后会成为的版本，否则是当前版本
  draft?: DraftId;               // 带 draft 参数时原样回显
  document: SchemaDocument;      // ID 与 base_version 已填好，改完可直接交给 schema_draft。带 draft 参数时是那份草稿编译后的文档
  policy: SlotPolicy;            // 只读，8.2。总是当前生效的策略：草稿不改策略
}

/** schema 文档。格式的权威定义在 data-model「schema 文档格式」。 */
type SchemaDocument = Record<string, unknown>;

interface MigrationStatus {
  target_sv: Sv;
  state: "building" | "failed";
  progress?: { done: number; total: number };
  item?: ItemId;                 // 对应的 schema_change（或 @later migration_diff）事项
}
```

例（`level: "list"`）：

```json
{ "level": "list" }
```
```json
{
  "level": "list", "total": 3,
  "slots": [{
    "slot": "ledger", "slot_id": "sl_4KTZ…", "sv": 2, "timezone": "Asia/Shanghai",
    "tables": [
      { "table": "expenses", "kind": "base", "description": "每笔支出一行" },
      { "table": "budgets", "kind": "base", "description": "各类别的月度预算" },
      { "table": "monthly_total", "kind": "derived", "description": "每月支出合计" }
    ]
  }]
}
```

### 4.3 `query`

```ts
interface QueryParams extends CommonParams, PageParams {
  table: TableName;
  /** 条件之间是"与"。状态类表在带 valid_during 时，field 还可以是 "valid_from" / "valid_to"。 */
  where?: Array<{ field: FieldName | "valid_from" | "valid_to"; op: WhereOp; value?: Value | Value[] | boolean }>;
  /** 默认：事件类表按发生时间倒序；状态类表按实体、再按 valid_from；无时间表按最近改动倒序；派生表按分组键升序。 */
  order?: Array<{ field: FieldName; dir?: "asc" | "desc" }>;
  fields?: FieldName[];
  /** 业务时间某一刻。只对状态类表。 */
  valid_at?: BizTime;
  /** 业务时间区间 [a, b)。状态类表：返回与它相交的每一段。事件类表：按发生时间字段筛选。 */
  valid_during?: [BizTime, BizTime | null];
  /** valid_during 返回的段：true = 端点截到区间内。默认 false。 */
  clip?: boolean;
  /** valid_during 返回的段：true（默认）= 按所选字段合并相邻同值段。 */
  coalesce?: boolean;
  /** 求值时刻："今天"（依赖"今天"的派生值）与不带时间限定读状态类表都取它。不传取入口时刻。 */
  at?: Instant;
  include_revoked?: boolean;     // 默认 false
  /** 默认 concise。detailed：每行另给 RowDetail（4.1）。只在返回 Row 的地方有：query，以及 history 的 as_of。 */
  detail?: "concise" | "detailed";
}

/**
 * = !=        所有类型
 * < <= > >=   integer、decimal、quantity（同量纲换算后比较）、date、zoned_datetime
 * in          value 是数组；适用类型同 =
 * contains    只对 text：子串匹配，区分大小写
 * is_null     value 是布尔：true = 为空，false = 不为空
 */
type WhereOp = "=" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "contains" | "is_null";

interface QueryResult extends CommonResult, PageResult {
  table: TableName; slot: SlotName; sv: Sv;
  rows: Row[];
}
```

例：

```json
{ "table": "expenses", "where": [{ "field": "date", "op": "=", "value": "2026-11-10" }] }
```
```json
{
  "table": "ledger.expenses", "slot": "ledger", "sv": 1, "total": 1,
  "rows": [{
    "table": "ledger.expenses", "row": "r_01JC8Z…", "ver": "v25.0",
    "values": { "date": "2026-11-10", "category": "餐饮", "amount": { "value": "54", "unit": "CNY" }, "note": null },
    "marks": { "corrected": true }
  }]
}
```

状态类表，`valid_during`：

```json
{ "table": "budgets", "where": [{ "field": "category", "op": "=", "value": "餐饮" }],
  "valid_during": ["2026-10-01", "2027-01-01"] }
```
```json
{
  "table": "ledger.budgets", "slot": "ledger", "sv": 2, "total": 3,
  "rows": [
    { "table": "ledger.budgets", "entity": "e_01JCB2…", "entity_key": { "category": "餐饮" }, "ver": "v55.0",
      "values": { "category": "餐饮", "amount": { "value": "5000", "unit": "CNY" } },
      "valid_from": "2026-10-01", "valid_to": "2026-11-02", "valid_to_inclusive": "2026-11-01" },
    { "table": "ledger.budgets", "entity": "e_01JCB2…", "entity_key": { "category": "餐饮" }, "ver": "v55.0",
      "values": { "category": "餐饮", "amount": { "value": "3000", "unit": "CNY" } },
      "valid_from": "2026-11-02", "valid_to": "2026-11-10", "valid_to_inclusive": "2026-11-09" },
    { "table": "ledger.budgets", "entity": "e_01JCB2…", "entity_key": { "category": "餐饮" }, "ver": "v55.0",
      "values": { "category": "餐饮", "amount": { "value": "4000", "unit": "CNY" } },
      "valid_from": "2026-11-10", "valid_to": null }
  ]
}
```

### 4.4 `sql`

```ts
interface SqlParams extends CommonParams {
  /** 单条 SELECT。表与字段用名字，可以引用可见范围内多个 slot 的表；状态类表可用 FOR VALID_TIME AS OF … / FROM … TO …；不能用 NOW()。
   *  白名单见 data-model「受限 SQL」（03-data-model/11-restricted-sql.md）。 */
  sql: string;
  /** 位置参数 $1, $2… 的值：字符串、数字、布尔、null。带单位的量传该列声明单位下的十进制字符串。 */
  params?: Array<string | number | boolean | null>;
  max_rows?: number;             // 每页行数。默认 100，上限 1,000
  at?: Instant;                  // 求值时刻：saveslot_today()、saveslot_now() 与不带时间限定读状态类表都取它。不传取入口时刻
  cursor?: Cursor;               // MCP 不暴露
}

interface SqlResult extends CommonResult {
  sv: Record<SlotName, Sv>;      // 查询涉及的每个 slot 各自的 schema 版本
  columns: Array<{ name: string; type: FieldType | "unknown"; unit?: string }>;
  /** 每行一个数组，顺序同 columns。quantity 列的单元格是十进制字符串，单位在 columns 里。整个 rows 是不可信文本。 */
  rows: Array<Array<string | number | boolean | null>>;
  total?: number;                // 能低成本得出时给
  next_cursor?: Cursor;
  truncated?: { shown: number; total?: number };
  /** 从这次查询读到的行版本集合算出的标记汇总。 */
  marks_summary?: InputMarks & { possibly_affected?: number; partially_deleted?: true };
}
```

结果不带 `ver`，也不自动加行 ID（需要时在查询里自己选 `row_id` / `entity_id`）。例：

```json
{ "sql": "SELECT category, sum(amount) AS total FROM expenses WHERE date >= $1 GROUP BY 1 ORDER BY 2 DESC",
  "params": ["2026-11-01"] }
```
```json
{
  "sv": { "ledger": 1 },
  "columns": [{ "name": "category", "type": "text" }, { "name": "total", "type": "quantity", "unit": "CNY" }],
  "rows": [["餐饮", "54"], ["交通", "35"]],
  "total": 2,
  "marks_summary": { "disputed": 1, "awaiting": 0, "flagged": 0, "premise_changed": 0, "items": ["pi_7C2E…"] }
}
```

### 4.5 `history`

```ts
type HistoryParams = TimelineParams | AsOfParams | ChangesParams | CompositionParams;

interface TimelineParams extends CommonParams, PageParams, Target {
  mode?: "timeline";             // 默认
  expand_sources?: boolean;      // 附原文片段
}

interface AsOfParams extends CommonParams, PageParams, Target {
  mode: "as_of";
  /** 记录时间：操作号、时刻，或"某次读取当时"。 */
  as_of: RecordPoint | { read: ReadId } | { task: string };
  /** 不给时，状态类实体返回当时所知的全部段。 */
  valid_at?: BizTime;
  detail?: "concise" | "detailed";   // 同 QueryParams.detail
}

interface ChangesParams extends CommonParams, PageParams {
  mode: "changes";
  table: TableName;              // 基础表。派生表报 invalid_argument（derived_table）
  row?: RowId; entity?: EntityId; entity_key?: Record<FieldName, Value>;   // 不给目标 = 整张表
  /** 不含。"my_last_read" = 本连接实例（带 task 时只认同一任务）对这张表最近一次读取的位置；没读过报 read_first。 */
  since: RecordPoint | "my_last_read";
  /** 含。默认最新。 */
  until?: RecordPoint;
}

interface CompositionParams extends CommonParams, Target {   // @later
  mode: "composition";
  as_of?: RecordPoint;
}

interface TimelineResult extends CommonResult, PageResult {
  mode: "timeline";
  target: TargetRef; sv: Sv;
  timezone: string;              // slot 的时区（同 catalog 的 timezone）：结果里的时刻按它显示
  /** 当前版本。只有它能用于写入；返回它算一次逐行读。 */
  ver: Ver;
  entries: TimelineEntry[];      // 新的在前
  /** 读过各版本的读取（任何连接实例的）；seq 是读到的版本。不给查询条件。只在首页给。 */
  reads?: Array<{ read: ReadId; seq: Seq; at: Instant; actor: Actor; task?: string }>;
}

interface TimelineEntry {
  seq: Seq;
  recorded_at: Instant;
  actor: Actor;
  intent: VersionIntent;
  /** 这次写入是怎么来的：普通写入不给。 */
  via?: { resolve: ItemId; decision: Decision } | { deletion: ItemId; action: "confirm" | "cancel" } | { undo: Seq }
      | { schema: { sv: Sv } };   // schema 切换时常量 backfill 补出的值：actor 是 system，没有源数据
  valid?: Interval;              // 状态类表：这次写入涉及的最大区间；逐字段的在 fields 里
  /** 状态类表上一个字段在这次写入里可以有几项（各段的值或结果不同），此时值是按区间排好的数组。 */
  fields: Record<FieldName | "*", TimelineField | TimelineField[]>;
  /** 这次写入声明的前提，形状同写入回执（5.1）；state 是现在的状态。重申与清除各是一条（fields 可能为空）；清除时是空数组。 */
  premises?: OpResult["premises"];
  affected?: { derived: DerivedChange[]; reads: number };
}

interface TimelineField {
    result: TimelineResultCode;  // 以最近一次给出的为准：写入时的结果，或之后被隐私删除重述的结果
    no_value?: true;             // 这一项（回退、回到合并基）把该字段置为没有值（状态类表：在它的区间上）
    uncovered?: true;            // 这一项（回退、回到合并基）只是让被回掉的写入在这一段不再生效，不给值：这一段回到撤销造成的空洞
    before?: Value; after?: Value;
    valid?: Interval;            // 状态类表：这一项解析出的区间（以最近一次给出的为准：写入时，或之后被隐私删除重新解析的）
    removed?: true;              // 内容已按删除移除
    /** schema_const：这个值出自第 sv 版 schema 切换时的常量 backfill（没有源数据，不随隐私删除清除）。 */
    sources?: { value: SourceRef[]; operation: SourceRef[]; schema_const?: { sv: Sv } };
}

interface SourceRef {
  id: SourceId; kind: SourceKind;
  correction?: true;             // 被一次纠错写入用作值来源
  level?: SourceLevel; literal?: "hit" | "miss" | "na";
  text?: UntrustedText;          // expand_sources: true 时；已删除的不给
  removed?: true;
}

interface AsOfResult extends CommonResult, PageResult {
  mode: "as_of";
  as_of: { seq: Seq; recorded_at?: Instant };   // 早于第一条操作：seq 为 0，不带 recorded_at
  sv: Sv;                        // 当时的 schema 版本，值按它解释
  timezone: string;              // slot 现在的时区（同 catalog 的 timezone）：结果里的时刻按它显示
  rows: Row[];                   // ver 是 HistoricalVer，historical: true；目标当时不存在则为空
  other_reads?: Array<{ read: ReadId; seq: Seq; at: Instant }>;   // as_of: {task} 时：同一任务对这个目标的其余读取
}

interface ChangedField { before?: Value; after?: Value }

interface ChangesResult extends CommonResult, PageResult {
  mode: "changes";
  since: Seq; until: Seq;
  changes: Array<{
    seq: Seq; recorded_at: Instant; actor: Actor;
    intent: VersionIntent;       // 含 deletion、deletion_cancelled：由删除确认或撤回产生的版本
    target: TargetRef;
    /** 事件类表、无时间表：每个字段一个对象。状态类表：每个字段是按区间排好的数组，每段各有区间（与 timeline 的 TimelineField[] 同形）。 */
    fields: Record<FieldName | "*", ChangedField | Array<ChangedField & { valid: Interval }>>;
  }>;
}
```

例（`timeline`）：

```json
{ "table": "expenses", "row": "r_01JC8Z…" }
```
```json
{
  "mode": "timeline", "target": { "table": "ledger.expenses", "row": "r_01JC8Z…" }, "sv": 1, "timezone": "Asia/Shanghai", "ver": "v25.0", "total": 2,
  "entries": [
    { "seq": 25, "recorded_at": "2026-11-10T12:41:07+08:00",
      "actor": { "kind": "connection", "id": "ci_01A…", "name": "MacBook · Claude Code" }, "intent": "correct",
      "fields": { "amount": { "result": "applied",
        "before": { "value": "45", "unit": "CNY" }, "after": { "value": "54", "unit": "CNY" },
        "sources": { "value": [{ "id": "s_2", "kind": "user_message", "correction": true, "level": "user_stated", "literal": "hit" }], "operation": [] } } },
      "affected": { "derived": [{ "table": "ledger.monthly_total", "key": { "month": "2026-11-01" }, "field": "total",
        "before": { "value": "45", "unit": "CNY" }, "after": { "value": "54", "unit": "CNY" } }], "reads": 0 } },
    { "seq": 21, "recorded_at": "2026-11-10T12:31:40+08:00",
      "actor": { "kind": "connection", "id": "ci_01A…", "name": "MacBook · Claude Code" }, "intent": "insert",
      "fields": {
        "date": { "result": "applied", "after": "2026-11-10",
          "sources": { "value": [{ "id": "s_1", "kind": "user_message", "literal": "miss" }], "operation": [] } },
        "category": { "result": "applied", "after": "餐饮",
          "sources": { "value": [{ "id": "s_1", "kind": "user_message", "literal": "miss" }], "operation": [] } },
        "amount": { "result": "applied", "after": { "value": "45", "unit": "CNY" },
          "sources": { "value": [{ "id": "s_1", "kind": "user_message", "level": "user_stated", "literal": "hit" }], "operation": [] } } } }
  ]
}
```

### 4.6 `sources`

```ts
interface SourcesParams extends CommonParams, PageParams {
  mode?: "list" | "search" | "get";   // 默认 list
  slot?: SlotName;
  kind?: SourceKind;
  from?: Instant; to?: Instant;       // 记录时间，[from, to)
  q?: string;                         // search：必填。第一版是子串匹配
  id?: SourceId;                      // get：必填
}

interface SourcesListResult extends CommonResult, PageResult {
  mode: "list" | "search";
  sources: Array<{
    id: SourceId; kind: SourceKind; slot: SlotName;
    recorded_at: Instant; stated_at?: Instant; actor: Actor;
    correction?: true;                // 被一次纠错写入用作值来源
    excerpt?: UntrustedText;          // 原文的前 200 个字符；已删除 / 待删除的不给
    file?: { name: UntrustedText; mime: string; size: number };
    deletion?: SourceDeletion;
  }>;
}

interface SourcesGetResult extends CommonResult {
  mode: "get";
  id: SourceId; kind: SourceKind; level: SourceLevel; slot: SlotName;
  recorded_at: Instant; stated_at?: Instant; actor: Actor;
  correction?: true;                  // 被一次纠错写入用作值来源
  text?: UntrustedText;
  file?: { name: UntrustedText; mime: string; size: number; sha256: string; origin?: UntrustedText; excerpt?: UntrustedText };
  /** 它产生了哪些数据。 */
  produced?: Array<{ target: TargetRef; seq: Seq; fields: FieldName[]; role: "value" | "operation" }>;
  deletion?: SourceDeletion;          // 有它时不给 text / file / produced
}

/** pending：宽限期内，内容读不到，可撤回。removed：已物理删除。 */
type SourceDeletion =
  | { state: "pending"; item: ItemId; expires_at: Instant }
  | { state: "removed"; at: Instant; reason: TombstoneReason };

/** expiry：宽限期到期。restore_backfill：恢复备份后按删除登记补做。import_placeholder：导入时为导出里占位的待删除项补的墓碑。 */
type TombstoneReason = "expiry" | "restore_backfill" | "import_placeholder";
```

例（`get`）：

```json
{ "mode": "get", "id": "s_2" }
```
```json
{
  "mode": "get", "id": "s_2", "kind": "user_message", "correction": true, "level": "user_stated", "slot": "ledger",
  "recorded_at": "2026-11-10T12:41:07+08:00",
  "actor": { "kind": "connection", "id": "ci_01A…", "name": "MacBook · Claude Code" },
  "text": "不对，午饭是 54 元",
  "produced": [{ "target": { "table": "ledger.expenses", "row": "r_01JC8Z…" }, "seq": 25, "fields": ["amount"], "role": "value" }]
}
```

### 4.7 `deletion_preview`

```ts
type DeletionPreviewParams =
  | (CommonParams & PageParams & {
      kind: "privacy" | "evidence" /* @later */;
      /** 要删的源数据。必填、非空；必须属于同一个 slot。 */
      sources: SourceId[];
      rows?: Target[];               // @later：去掉这些行的全部贡献
    })
  | (CommonParams & PageParams & {
      /** 按已有的 dc_ 重出预览。MCP 不暴露。 */
      confirm: DeleteConfirm;
    });

interface DeletionPreviewResult extends CommonResult, PageResult {   // 分页只对 rows[]；total 是 rows 的总数
  confirm: DeleteConfirm;
  confirm_expires_at: Instant;
  slot: SlotName;
  kind: "privacy" | "evidence" /* @later */;
  totals: { sources: number; rows: number; derived: number };
  rows: DeletionRowResult[];
  /** 原本未生效、将因删除生效的写入。最多 50 条，另给总数。 */
  /** valid：这次写入将生效的整体范围（几段时取整体，逐段的执行后见 timeline）。 */
  now_effective: Array<{ seq: Seq; target: TargetRef; fields: Values; valid?: Interval; item: ItemId; item_becomes: "superseded" | "open" }>;
  now_effective_total: number;
  /** 冲突将因删除消失、但仍属高影响的写入：转为待确认，不直接生效。 */
  now_awaiting: Array<{ seq: Seq; target: TargetRef; fields: Values; valid?: Interval; from_item: ItemId; impact: AwaitingImpact }>;
  now_awaiting_total: number;
  /** 将因删除被取代的事项。 */
  superseded: Array<{ item: ItemId; type: ItemType; reason: SupersededReason }>;
  superseded_total: number;
  /** 分组键来自自由文本字段的派生表：分组因删除变空时，键值随之清除。 */
  group_keys_cleared?: Array<{ table: TableName; count: number }>;
  /** 仍引用着将被整行删除的行 / 实体的行：它们不变，之后读取时带 dangling_ref 标记。最多 50 条，另给总数。 */
  dangling_refs: Array<{ target: TargetRef; field: FieldName; to: TargetRef }>;
  dangling_refs_total: number;
  /** 不会删除的。connection_names：连接实例的名称不是由源数据得出的，不在级联范围内。
   *  operation_labels：没有任何源数据的操作（提交 schema 草稿、确认删除、既没带证据也没带 note 的 resolve）自报的 task 与显式幂等键，没有来源可沿着删。 */
  not_deleted: Array<{ kind: "external_file" | "schema_text" | "retained_metadata" | "connection_names" | "operation_labels"; sources?: SourceId[] }>;
  /** 删除后仍保留、但不再支撑任何数据的源数据：只列这次删除之后由"支撑了数据"变成"什么都不支撑"的。
   *  它们不在这次删除的范围内，照常保留；供调用方决定是否一并删除。最多 50 条，另给总数。 */
  orphaned_sources: SourceId[];
  orphaned_sources_total: number;
  /** 预告：以将被改动的值为前提的行，删除后带 premise_changed（reason: deleted）；它们自己不被删除。rows 最多 50 行，count 是总数。没有时不给。 */
  premise_affected?: PremiseAffected;
  /** 本机模式：到期时若 saveslot 没在运行，物理删除在下次启动时执行。 */
  local_deferred?: true;
  reextract?: Array<{ target: TargetRef; fields: FieldName[] }>;   // @later
  cleared?: Array<{ target: TargetRef; fields: FieldName[] }>;     // @later
  collateral_rows?: TargetRef[];                                   // @later
}

interface DeletionRowResult {
  target: TargetRef;
  /** sources_changed：取值没变，这一行因为给出者、判定结果或给出它们的块被重新给出而列出（例：被删的写入给出的值，另有一次佐证或
   *  后来的写入给出同一个值；给出空洞的撤销因删除被重新解析，空洞仍在原处；某一项只是被原样重述）。 */
  result: "deleted" | "kept_fields_cleared" | "fields_reverted" | "resegmented" | "sources_changed";
  /** 删除后的样子。deleted 时不给。事件类表给 values；状态类表给 spans。 */
  after?: { values?: Values; spans?: Span[] };
  /** 只有状态类表：删除后由有值变成无值的区间，以及原因。没有时不给。一个区间只列一次：落在撤销之内取 revocation_extended，否则 required_field_removed。
   *  required_field_removed：某个必填字段在该处已没有仍在的贡献。
   *  revocation_extended：一次只带起点的撤销，终点停在被删写入给出的挡点上，删除后延伸过去；
   *  落在延伸部分里的写入没带齐必填字段，撑不起这一段。 */
  gaps_opened?: Array<{ valid: Interval; cause: "required_field_removed" | "revocation_extended" }>;
  cleared?: FieldName[];             // kept_fields_cleared：变空的字段
  /** fields_reverted：每个回到更早值的字段。 */
  /** from_seq 与 schema_const 必有其一：回到的是哪次写入的值，或回到的是 schema 第 sv 版切换时常量 backfill 的补值（没有写入可指）。 */
  reverted_to?: Record<FieldName, { value: Value; from_seq?: Seq; schema_const?: { sv: Sv }; valid?: Interval; reason: "later_write_removed" | "revert_source_removed" }>;
  /** 每个必填字段删除后还剩哪些写入的贡献（空数组 = 没有了）：这一行靠它们继续存在。 */
  basis?: Record<FieldName, Seq[]>;
  /** 这一行保留下来，但它的来源键随被删的贡献一起去掉：之后连接器再同步同一条记录，会新增另一行。另见提醒 external_key_resync。 */
  external_key_removed?: true;
  /** 这一行的来源键将因这项删除冻结：冻结期间不能转移，按它的同步一律跳过。只在键将冻结的行上给；不列键值。
   *  also_by：同一个键上另外几项未执行的删除。有它时，撤回这一项之后键仍冻结，要等这几项都撤回或执行。 */
  external_key_frozen?: { also_by?: ItemId[] };
  /** 同一次写入里的其他证据段：可用 source_ref + evidence_by_field 按字段佐证后再删。 */
  co_evidence?: Array<{ seq: Seq; fields: FieldName[]; sources: SourceId[] }>;
}

/** 状态类表上一段业务时间里的值。values: null = 这一段没有值。 */
interface Span extends Interval { values: Values | null }
```

例：

```json
{ "kind": "privacy", "sources": ["s_2"] }
```
```json
{
  "confirm": "dc_8ZqK1v…", "confirm_expires_at": "2026-11-11T09:20:00+08:00", "slot": "ledger", "kind": "privacy",
  "totals": { "sources": 1, "rows": 1, "derived": 1 }, "total": 1,
  "rows": [{
    "target": { "table": "ledger.expenses", "row": "r_01JC8Z…" }, "result": "fields_reverted",
    "after": { "values": { "date": "2026-11-10", "category": "餐饮", "amount": { "value": "45", "unit": "CNY" } } },
    "reverted_to": { "amount": { "value": { "value": "45", "unit": "CNY" }, "from_seq": 21, "reason": "later_write_removed" } },
    "basis": { "date": [21], "category": [21], "amount": [21] }
  }],
  "now_effective": [], "now_effective_total": 0,
  "now_awaiting": [], "now_awaiting_total": 0,
  "superseded": [], "superseded_total": 0,
  "dangling_refs": [], "dangling_refs_total": 0,
  "not_deleted": [{ "kind": "retained_metadata" }],
  "orphaned_sources": [], "orphaned_sources_total": 0,
  "local_deferred": true
}
```

落回 schema 切换的补值时（没有写入可指），`reverted_to` 的一项是：

```json
{ "currency": { "value": "CNY", "schema_const": { "sv": 3 }, "reason": "later_write_removed" } }
```

### 4.8 `pending`

```ts
interface PendingParams extends CommonParams, PageParams {
  id?: ItemId | JobId;           // 给了就是看详情
  slot?: SlotName;
  type?: ItemType;
  status?: ItemStatus | "all";   // 默认 open；按挂起时长倒序
}

type ItemType   = "awaiting_confirmation" | "flagged" | "conflict" | "schema_change" | "deletion" | "migration_diff" /* @later */;
type ItemStatus = "open" | "resolved" | "superseded";

interface PendingListResult extends CommonResult, PageResult {
  items: Array<{
    id: ItemId; type: ItemType; status: ItemStatus; slot: SlotName;
    target?: ItemTarget;
    reason: ItemReason;
    opened_at: Instant; opened_by: Actor;
    overdue?: true;              // deletion：已到期但尚未物理删除
  }>;
}

type PendingDetailResult = CommonResult & ItemDetail;

type ItemDetail = AwaitingDetail | FlaggedDetail | ConflictDetail | SchemaChangeDetail | DeletionDetail;

interface ItemBase {
  id: ItemId;
  item_ver: ItemVer;             // 查看详情算读到了它
  status: ItemStatus;
  slot: SlotName;
  reason: ItemReason;
  opened_at: Instant; opened_by: Actor;
  /** 当前凭证可用的处理方式。已关闭的事项为空。deletion 事项宽限期已过、墓碑尚未落账（deletion_overdue 期间）时仍是 open，这里也为空。 */
  decisions: Decision[];
  /** 需要用户会话才能用的处理方式（slot 策略指定时）。@later */
  user_session_only?: Decision[];
  resolution?: ItemResolution;                                        // status: resolved
  superseded?: { reason: SupersededReason; by?: Seq; at: Instant };   // status: superseded
}

/** 事项怎么解决的，两支：
 *  按处理方式解决（resolve）：decision 为 take_candidate 时 candidate 是所取候选在该事项 candidates[] 里的下标（事项解决之后 candidates[] 不再变，下标指的就是这一组里的那一个）；
 *  deletion 事项到期执行（物理删除）：seq 是墓碑事件的 seq（它是一次 system 操作的头事件），actor 恒为 system，不给。"执行"不是调用方可选的处理方式，不进 Decision。 */
type ItemResolution =
  | { decision: Decision; candidate?: number; seq: Seq; at: Instant; actor: Actor; note?: UntrustedText }
  | { executed: true; seq: Seq; at: Instant; reason: TombstoneReason };

/** 事项的目标。unit = 冲突单元里的字段；["*"] = 这一行 / 这段是否存在。 */
interface ItemTarget extends TargetRef { unit?: Array<FieldName | "*">; spans?: Interval[] }   // spans：状态类表上事项区间的各段，按起点升序、互不相接；只有第一段可以起点开口（valid_from 为 null），整段时间是唯一一段 {valid_from: null, valid_to: null}

type ItemReason =
  | "overwrites_change_point"       // awaiting_confirmation：抹掉已记录的变化点（含跨空洞填值）
  | "referenced_row"                // awaiting_confirmation：撤销仍被引用的行
  | "undo_includes_later"           // awaiting_confirmation：undo 连后来的写入一起回掉
  | "undo_hides_later"              // awaiting_confirmation：undo 写回的撤销会遮住后来的写入（与上一种同时成立时记上一种）
  | "conflict_cleared_by_deletion"  // awaiting_confirmation：删除让冲突消失，而该写入仍属高影响
  | "policy_high_impact"            // awaiting_confirmation：slot 策略指定的表 / 字段 @later
  | "duplicate_keys"                // flagged
  | "stale_write"                   // conflict
  | "restored_candidate"            // conflict：撤回删除后放回来的候选，原事项已在宽限期内解决，为它另开的事项
  | "schema_change"                 // schema_change
  | "request"                       // deletion：调用方确认的
  | "restored_unconfirmed"          // deletion：恢复备份后由 system 重新生成，另给了新的宽限期
  | "restored_pending"              // deletion：恢复备份后由 system 重新生成，沿用原到期时刻
  | "restored_executed";            // deletion：恢复备份后由 system 补做，随即物理删除

type SupersededReason =
  | "overwritten"              // 读过事项当前版本的写入改到了它的目标（by = 那次写入）
  | "schema_switched"          // schema 已切换，且事项涉及被改动的字段
  | "draft_replaced"           // schema_change：同一 slot 提交了新草稿
  | "deleted"                  // 目标、候选的全部值来源或成因被隐私删除
  | "deletion_cancelled"       // 因删除而生成的待确认事项，在删除撤回后不再成立
  | "matched_changed"          // flagged：被比中的行被撤销或改动（不看写入方读没读过事项）
  | "nothing_to_revert"        // awaiting_confirmation（提议是 undo）：按当前状态重判后已没有要写回、要遮住或回掉的
  | "evidence_deleted"         // @later
  | "migration_failed";        // @later

type Decision =
  | "confirm" | "reject"                                   // awaiting_confirmation、schema_change
  | "keep" | "revoke"                                      // flagged
  | "keep_effective" | "take_candidate" | "take_previous"  // conflict
  | "cancel"                                               // deletion
  | "accept_all" | "rows" | "keep_rest_and_switch" | "abandon";   // migration_diff @later

interface AwaitingDetail extends ItemBase {
  type: "awaiting_confirmation";
  target: ItemTarget;
  /** 提议的内容，三种之一：set 是字段值；set: null 是撤销；提议是一次回退时不给 set，给 revert（成因 undo_includes_later）。
   *  回退会写回什么不在这里列：会被回掉的写入见 impact.reverted，回到的值执行后见回执。 */
  proposal: { seq: Seq; actor: Actor; intent: Intent; set?: Values | null; revert?: { undo: Seq; include_later?: boolean }; valid?: Interval };
  current: { values?: Values; spans?: Span[] };   // 按事项版本的操作号读这一行，范围同 ConflictDetail.effective
  impact: AwaitingImpact;
}

/** 执行后会改掉什么。在事项版本的绑定范围内。 */
interface AwaitingImpact {
  /** 这两项的 valid 只在状态类表上给：事件类表与无时间表的行没有区间。 */
  overwritten?: Array<{ field: FieldName; valid?: Interval; value: Value; seq: Seq; actor: Actor }>;  // 会被覆盖的段
  filled_gaps?: Array<{ valid?: Interval; revoked_by?: Seq }>;                                         // 会被填掉的无值区间（只列在这里）
  reverted?: Array<{ seq: Seq; actor: Actor; fields: Array<FieldName | "*"> }>;                        // 确认后读到的结果会变的后来写入，不论在不在回退记录里（write-and-read「撤回某次写入」）；fields：结果会变的字段，"*" 是撤销；一条表示至少有一部分会变
  referrers?: TargetRef[];                                                                             // 仍引用该行的行
}

interface FlaggedDetail extends ItemBase {
  type: "flagged";
  target: ItemTarget;
  /** 疑似与它重复的行：最多 10 个，按最近写入排。 */
  related: TargetRef[];
  /** 命中的那一组 duplicate_keys 与键值。 */
  keys: FieldName[];
  matched_values?: Values;
}

interface ConflictDetail extends ItemBase {
  type: "conflict";
  target: ItemTarget;
  /** 当前生效方：按事项版本的操作号读这一行当时的状态，限定在事项的各段与冲突单元的字段上（单元是"存在"时给整行的值）。
   *  状态类表上冲突区间内的生效值可以由几次写入分段给出：spans 每段带给出它的写入；
   *  values 为 null 只用于实体在这一段没有值：从未写过的段不给 seq、actor；有操作让它没值的（撤销留下的空洞，undo 的写回、清空写入或
   *  take_previous 的写回让必填字段没值；没有必填字段的表上是没有任何字段在这一段有生效的写入——清空也算写入，只被清空过的一段有值、字段为空），给让这一格没有值的那次操作（同一段上撤销与 undo 的无值写回都在时，取操作号大的那次：这一段在它之前是有值的）——以版本表的格为准，
   *  同一段上已经没值之后再来的回掉不改变它。实体有值而单元字段在这一段从没写过的，是字段为空不是空洞：values 里这个字段为 null，
   *  这个字段不给出 seq。
   *  顶层 seq / actor 是这些段里操作号最大的那次（事件类表与无时间表只有一个）；一段都没有操作给出时不给。
   *  撤销被撤回之后"由谁给出"两种表不同：事件类表、无时间表上是那次撤回（它让这一行重新存在）；
   *  状态类表上是原来给出这一段值的写入（撤回只让那些值重新生效）。不对称来自版本表：撤回撤销在事件类表、无时间表上给"存在"记一格，在状态类表上不记；这里照格走，不另求一致。 */
  effective: { seq?: Seq; actor?: Actor; values?: Values; spans?: Array<Span & { seq?: Seq; actor?: Actor }>; exists: boolean };
  candidates: Candidate[];
  /** 成因是 restored_candidate 时：候选原来所在的那个事项。 */
  related_item?: ItemId;
  /** take_previous 会回到的样子：合并基（各候选所带 ver 中最早的那个版本）上的值，按合并基的操作号读这一行，范围同 effective。 */
  previous: { seq: Seq; exists: boolean; values?: Values; spans?: Span[] };
  /** take_previous 会回掉的写入：合并基之后在这个冲突单元上生效过的全部写入；以及单元外、合并基之后在事项区间里给出值、
   *  会随 take_previous 让这一段回到无值而失去值的写入（合并基处这一段是无值时，见「时间 · 高影响写入」④ 的第三种成因）。 */
  reverted_by_previous: Array<{ seq: Seq; actor: Actor; fields: Array<FieldName | "*"> }>;   // 此刻回到合并基会让读到的结果变的、晚于合并基的写入；口径同 AwaitingImpact.reverted（write-and-read「撤回某次写入」按读得到的结果判那一条），同形
  /** 候选若生效会属高影响时：会被覆盖的内容。take_candidate 就是对它的确认。 */
  candidate_impact?: Record<string /* 候选的下标 */, AwaitingImpact>;
}

interface Candidate {
  /** 候选在事项里的下标；take_candidate 时用它指明。事项生命周期内不复用。
   *  一个候选 = 一次写入在这个冲突单元上成了候选的全部部分（字段组里的几个字段、状态类表上的几段都算在同一个候选里），
   *  采纳时整体采纳。事件格式里 candidates/<k> 的 k 就是它。 */
  index: number;
  seq: Seq;                      // 候选所在写入的写入号
  actor: Actor;
  intent: Intent;                // revoke 的候选没有 values
  ver: Ver;                      // 它所带的版本
  values?: Values;
  valid?: Interval;              // 状态类表：候选的区间（按它所见版本解析）。几段不相连时是它们的整体范围，逐段的见 candidate_impact 与 timeline
  cause: "stale_write" | "displaced_by_rule" /* @later */;   // 候选的来由
  level?: SourceLevel;
  literal?: "hit" | "miss" | "na";
}

interface SchemaChangeDetail extends ItemBase {
  type: "schema_change";
  draft: DraftId;
  target_sv: Sv;
  changes: SchemaChange[];       // 5.3
  impact: SchemaImpact;          // 草稿提交时的估计，不在事项版本的绑定范围内
  migration?: MigrationStatus;   // 确认之后、迁移进行中或失败时。已解决的事项按 ID 一直可查
}

interface DeletionDetail extends ItemBase {
  type: "deletion";
  kind: "privacy" | "evidence" /* @later */;
  expires_at: Instant;
  totals: { sources: number; rows: number; derived: number };
  states: DeletionState[];
}

interface DeletionState {
  place: "store" | "backups";
  /** store：logically_deleted → physically_deleted。backups：retained → expired。 */
  state: "logically_deleted" | "physically_deleted" | "retained" | "expired";
  since: Instant;
  due?: Instant;                       // 下一状态预计的时刻；backups 没有托管备份时不给
  overdue?: true;                      // 已到期但尚未物理删除
  deferred_to_next_start?: true;       // 本机模式：服务没在运行时推迟到下次启动
  managed?: boolean;                   // backups：false = 不由 saveslot 管理（如系统级备份）
}
```

例（冲突事项详情）：

```json
{ "id": "pi_7C2E…" }
```
```json
{
  "id": "pi_7C2E…", "item_ver": "iv_4f81…", "type": "conflict", "status": "open", "slot": "ledger", "reason": "stale_write",
  "opened_at": "2026-11-10T15:02:11+08:00",
  "opened_by": { "kind": "connection", "id": "ci_01A…", "name": "MacBook · Claude Code" },
  "decisions": ["keep_effective", "take_candidate", "take_previous"],
  "target": { "table": "ledger.expenses", "row": "r_01JD3K…", "unit": ["amount"] },
  "effective": { "seq": 33, "actor": { "kind": "connection", "id": "ci_01B…", "name": "MacBook · Codex" },
    "values": { "amount": { "value": "35", "unit": "CNY" } }, "exists": true },
  "candidates": [{ "index": 0, "seq": 37, "actor": { "kind": "connection", "id": "ci_01A…", "name": "MacBook · Claude Code" },
    "intent": "correct", "ver": "v29.0", "values": { "amount": { "value": "32", "unit": "CNY" } },
    "cause": "stale_write", "level": "user_stated", "literal": "hit" }],
  "previous": { "seq": 29, "exists": true, "values": { "amount": { "value": "30", "unit": "CNY" } } },
  "reverted_by_previous": [{ "seq": 33, "actor": { "kind": "connection", "id": "ci_01B…", "name": "MacBook · Codex" }, "fields": ["amount"] }]
}
```

---

## 5. 写操作

### 5.1 `write`

```ts
type Intent = "insert" | "update" | "correct" | "revoke" | "applied_by_rule" /* 只出现在结果里；@later */;

/** 历史里一个版本的意图：写入的意图，或另外三个版本意图——由删除确认、撤回删除、schema 切换产生的版本（与事件格式 6.2 同名）。 */
type VersionIntent = Intent | "deletion" | "deletion_cancelled" | "schema_switch";   // schema_switch：schema 切换时常量 backfill 补出的版本

interface WriteParams extends WriteCommonParams {
  /** 读取或查目录时拿到的 schema 版本。应带回；没带时兜底。 */
  sv?: Sv;
  /** 请求级证据段，多个 op 共用。 */
  evidence?: EvidenceSegment[];
  /** 同一 slot 内的操作，按顺序执行，整体一个事务。至少一个。 */
  ops: WriteOp[];
  mode?: "job";                  // @later
}

interface WriteOp extends EvidenceOnOp {
  /** insert 新的一条；update 情况变了或补充；correct 原来的值本来就是错的；revoke 这条不该存在。带 revert 时可省略。 */
  intent?: "insert" | "update" | "correct" | "revoke";
  table: TableName;
  row?: RowId;
  entity?: EntityId;
  /** 状态类表按自然键写：实体存在就写入，不存在就创建。意图用 update。 */
  entity_key?: Record<FieldName, Value>;
  /** 按来源键写（事件类表、无时间表，声明了 external_key 时）：给出全部键字段的值；有则按三方比较更新，无则新增。
   *  意图 update 或 correct；不带 ver、不带 row、不带 premises。
   *  例外：给一行没有来源键的行补键时，与 row、ver 一起给（普通的 update）。 */
  external_key?: Record<FieldName, Value>;
  /** 给新插入的行起临时名（"p1"），同一请求里的 ref 与前提写 "@p1"。按来源键的 op 也可以带：新增时绑定新行，命中时绑定命中的那一行，被跳过时不绑定。 */
  as?: string;
  /** 读这一行 / 实体时拿到的版本。update / correct / revoke 应带回；没带时兜底；本请求里新建的行 / 实体不需要。带 revert: {undo} 时可以不带：undo 不做版本冲突判定。
   *  按来源键的 op 不带（带了报 invalid_argument / mutually_exclusive）。 */
  ver?: Ver;
  /** 字段名 → 值。值写 null 是清空一个可选字段。与 revert 互斥；revoke 不带。update 带 premises 时可以不带（重申、清除）。 */
  set?: Values;
  /** 代替 set。 */
  revert?: { undo: Seq; include_later?: boolean } | { to: Seq; fields: FieldName[] } /* @later */;
  /** 只用于状态类表。起点，含。不传 = 现在（correct 且两端都没传时见 04-contract 第 5 节）。 */
  valid_from?: BizTime;
  /** 只用于状态类表。终点，不含。日期 / 时刻；"next_change"（默认：管到下一个已记录的变化）；"open"（一直延续）。 */
  valid_to?: BizTime | "next_change" | "open";
  /** ["overwrite"]：已与用户确认覆盖类的高影响，直接生效。只在这个 op 显式带了当前 ver 时有效。MCP 不暴露。 */
  acknowledge?: Array<"overwrite">;
  /** 这次写入所用到的、已读到的别的行（写入的前提）。最多 16 条。带 revert 的 op、revoke、按来源键的 op 不能带。
   *  update 可以只带 premises、不带 set：值不变，重申这一行以这些为前提仍然成立。
   *  premises: [] 表示清掉这一行的前提声明。 */
  premises?: PremiseRef[];
}

/** 一条前提。目标的写法同 Target：除 table 外恰好给一个；没有按来源键定位的写法。 */
interface PremiseRef {
  table: TableName;                        // 同一 slot 的基础表
  row?: RowId | string;                    // 事件类表、无时间表；也可以写本请求里新建行的临时名 "@p1"
  entity?: EntityId;                       // 状态类表
  entity_key?: Record<FieldName, Value>;   // 状态类表，按自然键
  fields?: FieldName[];                    // 用到的是哪些字段。不给 = 整行（任何字段，以及这一行是否存在）
  ver?: Ver;                               // 读到它时拿到的版本。没带时兜底（premise_ver_fallback）
  /** 只对状态类表：用到的是业务时间上这一点 / 这一段的值，二者互斥。都不给时，声明前提的这一行自己有业务时间就取它，没有就是"从现在起"。 */
  valid_at?: BizTime;
  valid_during?: [BizTime, BizTime | null];
}

interface WriteResult extends CommonResult {
  /** saved：全部字段已生效（生成了 flagged 事项时也是）。pending：有字段成了候选或进了待确认。按来源键被跳过的 op 不影响它。 */
  status: "saved" | "pending" | "job" /* @later */;
  sv: Sv;
  /** 这次写入的写入号。请求里全部 op 都是按来源键的 unchanged / skipped 时不产生事件，不给。 */
  seq?: Seq;
  /** 与请求的 ops 一一对应。幂等重放的回执里，没进事件的按来源键 op 只给它的下标（omitted 含 "unrecorded_ops"）。 */
  ops: Array<OpResult | { op_index: number }>;
  derived: DerivedChange[];      // 最多 20 条
  /** 首次回执：受影响的派生字段条目总数。幂等重放：derived 为空，这里是这次操作的派生写入条数（每个分区一条），omitted 含 derived_values。 */
  derived_total: number;
  pending: PendingRef[];
  superseded: Array<{ item: ItemId; type: ItemType; reason: SupersededReason }>;   // 写入取代事项的原因：overwritten 或 matched_changed
  affected_reads?: AffectedReads;
  /** 这次操作改动的行上，别的行声明过的前提的变化。没有时不给。 */
  premise_affected?: PremiseAffected;
  /** 只统计按来源键的 op；请求里没有按来源键的 op 时不给。幂等重放时 unchanged、skipped 两项不给（omitted 含 "unrecorded_ops"）。 */
  external_key_summary?: { created: number; updated: number; unchanged?: number; pending: number; skipped?: number };
  /** 命中请求键的重发：没有新写入，回执按日志重建。此时 pending[] 给的是事项的当前状态、不带 item_ver；回执里的 ver 与事项都不算读到。
   *  前提的部分（premises、premise_covered、premise_affected）记在元数据里，按日志完整重建，标记状态是当时的。 */
  replayed?: true;
  /** 回执里省略的部分。两种情形会出现：
   *  replayed：按日志重建不出的——affected_reads；derived_values（派生值的改前改后值）；before_values（改前值所出自的贡献已被删除）；
   *    skipped_spans（undo 跳过的部分的区间）；
   *    deleted_content（这次写入自己的内容已被删除的部分）；unrecorded_ops（没进事件的按来源键 op：unchanged、skipped）；
   *    existing_keys（existing_keys 与 similar_keys：由写入那一刻的状态算出，不进事件）。
   *  回执超出外化面的结果预算：写入已生效，不报错，截短并列明——field_results、derived_values、affected_reads、lists（各列表的后几条，含 premise_affected.rows）。
   *  调用方需要时自己读（history / query）。 */
  omitted?: Array<"affected_reads" | "derived_values" | "before_values" | "skipped_spans" | "deleted_content"
                  | "unrecorded_ops" | "existing_keys" | "field_results" | "lists">;
  original_deleted?: { deletion: ItemId };   // 重放命中的原写入已被删除：没有重新写入，不回显内容
  job?: JobId;                   // @later
}

/** 相近的键与已有的键的写法：单字段的键是一个 UntrustedText；多字段的键是"字段名 → 值的文本"。 */
type EntityKeyText = UntrustedText | Record<FieldName, UntrustedText>;

interface OpResult {
  target: TargetRef;
  as?: string;                   // 临时名
  intent: Intent;
  /** 有字段生效时是新 ver；全部没生效或同值时是原 ver。按来源键被跳过、没有命中任何行时不给。 */
  ver?: Ver;
  /** 只有按来源键的 op 带：这个 op 的结局（04-contract 5.4）。 */
  outcome?: "created" | "updated" | "unchanged" | "pending" | "skipped";
  /** outcome: skipped 时：revoked = 命中已撤销的行（附 revoked_by）；pending_deletion = 键被宽限期内的删除占着（附 deletion）；
   *  ref_skipped = 用了一个被跳过的 op 的临时名（附 ref_op）。这几项写入时从当前状态取，不进事件。 */
  skip_reason?: "revoked" | "pending_deletion" | "ref_skipped";
  revoked_by?: Seq;
  deletion?: ItemId;             // pending_deletion：冻结这个键的删除；几项同时冻结时给最早确认的那一项
  ref_op?: number;               // ref_skipped：临时名所属的那个 op 的下标
  created_entity?: true;
  /** created_entity 时：该表已有的实体键，最多 10 个。相近的键在前，其余按最近写入。 */
  existing_keys?: EntityKeyText[];
  /** created_entity 时：写法与新键相近的已有键，最多 5 个，按级别（fold、affix、edit）、编辑距离、最近写入、实体 ID 排序；没有时不给。
   *  判据 keymatch@1（data-model「相近的键」）。revoked：这个实体已撤销（不带区间的 revoke）。都出现在 existing_keys 的开头。 */
  similar_keys?: Array<{ key: EntityKeyText; match: "fold" | "affix" | "edit"; revoked?: true }>;
  /** 逐字段结果。revoke、以及目标是"存在"时键为 "*"。undo 时被跳过的部分不在这里，在 undo.skipped_superseded。
   *  事件类表、无时间表：每个字段一个结果。
   *  状态类表：每个字段是按区间排好的数组，每段各有结果与区间（noop 的那一段除外：它只说这个字段这次没有变化，日志只记字段、不记区间）
   *  （通常只有一段；多段的情形：undo / take_previous 写回几段不同的旧值，
   *  佐证的区间里一部分仍同值、一部分已被别人改掉）。
   *  按来源键的 op 在 outcome 为 unchanged、skipped 时不给；重申与清除前提的 op 可以为空。 */
  fields?: Record<
    FieldName | "*",
    FieldResult | Array<Extract<FieldResult, { result: "noop" }> | (Exclude<FieldResult, { result: "noop" }> & { valid: Interval })>
  >;
  /** 状态类表：每个字段解析出的区间。一个字段有几项时是它们的整体范围，逐项的区间在 fields 的数组里。 */
  resolved?: Record<FieldName | "*", ResolvedInterval>;
  undo?: {
    of: Seq;
    skipped_superseded: Array<{ field: FieldName; valid?: Interval; by: Seq; actor: Actor }>;   // 幂等重放的回执里没有 valid（日志不记跳过的区间），omitted 含 "skipped_spans"
    reverted_later?: Array<{ seq: Seq; actor: Actor; fields: FieldName[] }>;
  };
  /** 与请求的 premises 一一对应。清除（premises: []）时是空数组。 */
  premises?: Array<{
    target: TargetRef; fields?: FieldName[];
    ver: Ver;                        // 实际采用的所见版本（兜底时是兜底到的那个）
    state: "current" | "changed";    // changed：声明时前提已经变了，这一行一写下就带标记
    reason?: PremiseReason; since?: Seq;
  }>;
  /** 这个 op 的声明另外覆盖了本行多少个已有的字段；因 op 未全部生效而没有覆盖时为 0。清除时是被清掉声明的字段数。 */
  premise_covered?: number;
}

/** 字段生效状态。前五个与事件格式的 status 同名同义。 */
type FieldResultCode = "applied" | "candidate" | "awaiting" | "corroborated" | "noop" | "applied_by_rule" /* @later */;

/** timeline 里一项贡献的结果码。比写入回执多一个 dropped：这一项经一次隐私删除的重放后不再是贡献
 *  （与前面的值相同而当初没指证据；它回掉的那次写入已不在；或它的区间并进了同一字段的另一项）。只出现在 timeline。
 *  不含 noop：无操作不产生版本，timeline 不列无操作的字段。 */
type TimelineResultCode = Exclude<FieldResultCode, "noop"> | "dropped";

type FieldResult =
  | { result: "applied";
      before?: Value;            // 新增、或这里原来没有值时不给
      after?: Value;             // 回退写回"没有值"（no_value）或只让被回掉的写入不再生效（uncovered）时不给
      no_value?: true; uncovered?: true;
      merged?: true;             // 带回的 ver 不是当前版本，但这个字段之后没人动过：已自动合并
      overwritten?: Array<{ valid: Interval; value: Value | null; seq: Seq }> }   // 状态类表：被覆盖或被切开的段
  | { result: "corroborated" }   // 同值且显式指了证据：已追加来源，没有新版本
  | { result: "noop" }           // 同值、没指证据：不是这次写入的改动。日志里不留它的值
  | { result: "candidate";
      item: ItemId;
      valid?: Interval;          // 候选的区间
      effective: Value | null;   // 当前生效值
      current_ver: Ver;          // 当前生效版本。不算读到，不参与兜底
      by?: { seq: Seq; actor: Actor };           // 是谁的哪次写入改过它，按这次请求结束时的现状（与 effective、current_ver 同一时刻）：候选区间里各段给出状态的操作（有出处的格——值，或被清空——的来源；没值处是让这一格没有值的那次操作——撤销、undo 的写回、清空写入或 take_previous 的写回，以格为准，同一段上撤销与无值写回都在时取操作号大的那次；从未写过的段不算；一段都不算时不给）中操作号最大的那次（同 ConflictDetail.effective）；effective 是 by 所在那一段（by 给出了几段时取时间上最早的一段）上这个字段现在的值：冲突单元只有这个字段时就是 by 那次写入给的值，单元含多个字段（如"存在"）时 by 是单元里最晚的给出者，effective 仍是这个字段的值，两者可以出自不同的写入；那一段没值、by 是撤销或单元是"存在"本身时 effective 为 null；各段的全貌见 ConflictDetail.effective.spans
      previous: ConflictDetail["previous"];
      impact?: AwaitingImpact }                  // 候选若生效会属高影响时
  | { result: "awaiting"; item: ItemId; impact: AwaitingImpact }
  | { result: "applied_by_rule"; item: ItemId; before: Value; after: Value };   // @later

/** 回执 resolved 里一个字段的解析结果，首次回执与重放按日志给出同样的内容（写入头的原始传参与基础写入里各项的区间）。
 *  不给的情形：无操作的字段（日志里只留字段名，没有区间）；undo 的 op（区间由写回求出，不是从传参解析出来的，整个 op 没有 resolved）；
 *  原始传参已被隐私删除的 op（整个 op 没有，列在 deleted_content 下）。
 *  "*"（撤销的"存在"）给 from_as、to_as 与区间，不给 next_change：Value 对"存在"没有定义。 */
interface ResolvedInterval extends Interval {
  /** 调用方是怎么给起点、终点的（与事件格式的 mode 同名）。corrected_span = correct 且两端都没传：包含"现在"、以挡点为界的那一段。 */
  from_as: "given" | "now" | "corrected_span";
  to_as: "given" | "next_change" | "open" | "corrected_span";
  /** to_as: next_change 且终点不是"一直延续"时：终点处开始的那一段，没有改动。 */
  next_change?: { at: BizTime; value: Value | null };
  /** 这次写入填上的无值区间：生效的部分里，写之前实体在那里没有值的段，不论是怎么没有值的（实体第一段之前、显式终点之后、撤销留下的洞，
   *  data-model「时间 · 无值区间」），相邻的合成一段。这次写入新建的实体不给（写之前它还不存在）。
   *  只列已经生效、已经填上的段：待确认与候选的部分还没填上，不给；它们确认后会填掉什么见 impact.filled_gaps。 */
  filled?: Interval[];
}

interface DerivedChange {
  table: TableName; key: Record<FieldName, Value>; field: FieldName;
  before: Value | null; after: Value | null;
}

interface PendingRef {
  id: ItemId; type: ItemType; reason: ItemReason;
  item_ver?: ItemVer;            // 只有本次新生成、且回执给全了内容的才带（算读到）
  merged?: true;                 // 并入了已有事项：不带 item_ver，要先看详情
  refreshed?: true;              // 本次写入改到了一个没读过的未决事项的目标，或没改到而重算出的内容变了：事项已刷新、保持未决
  /** 只在 replayed 的回执里给：事项现在的状态；已解决的附处理方式。 */
  state?: "open" | "resolved" | "superseded";
  decision?: Decision;
}

interface AffectedReads {
  count: number;                 // 不含本次写入所带 ver 出自的那次读取
  by_reason: Partial<Record<AffectedReason, number>>;
  covered_since: Instant;        // 读取记录保留到哪一刻：更早的读取不在统计内
  /** count 里只能算"可能受影响"的读取数：按表级记录或版本集合匹配到的（data-model「纠错影响查询」）。没有时不给。 */
  possible?: number;
  not_covered?: Array<"derived_reads">;
}

/** 一次操作改动的行上，别的行声明过的前提的变化。出现在写入回执、resolve 的 write、delete 的结果、撤回的 cancelled 里；deletion_preview 里是预告。 */
interface PremiseAffected {
  count: number;                     // 因本次操作新带上标记的依赖行数
  matched: number;                   // 因本次操作撤掉标记的依赖行数
  by_reason: Partial<Record<PremiseReason, number>>;
  /** 新带上标记的依赖行：最多 20 行（deletion_preview 与 delete 里最多 50 行）。回执超出结果预算时属于可截短的列表。 */
  rows: Array<{ target: TargetRef; fields: FieldName[]; declared: { seq: Seq; actor: Actor } }>;
}
```

例一，新增（请求与回执）：

```json
{
  "sv": 1,
  "evidence": [{ "kind": "user_message", "text": "今天午饭花了 45 元" }],
  "ops": [{ "intent": "insert", "table": "expenses",
    "set": { "date": "2026-11-10", "category": "餐饮", "amount": { "value": "45", "unit": "CNY" } } }]
}
```
```json
{
  "status": "saved", "sv": 1, "seq": 21,
  "ops": [{
    "target": { "table": "ledger.expenses", "row": "r_01JC8Z…" }, "intent": "insert", "ver": "v21.0",
    "fields": {
      "date": { "result": "applied", "after": "2026-11-10" },
      "category": { "result": "applied", "after": "餐饮" },
      "amount": { "result": "applied", "after": { "value": "45", "unit": "CNY" } }
    }
  }],
  "derived": [{ "table": "ledger.monthly_total", "key": { "month": "2026-11-01" }, "field": "total",
    "before": null, "after": { "value": "45", "unit": "CNY" } }],
  "derived_total": 1, "pending": [], "superseded": []
}
```

例二，版本对不上、成为候选：

```json
{
  "sv": 1,
  "evidence": [{ "kind": "user_message", "text": "打车是 32 元" }],
  "ops": [{ "intent": "correct", "table": "expenses", "row": "r_01JD3K…", "ver": "v29.0",
    "set": { "amount": { "value": "32", "unit": "CNY" } } }]
}
```
```json
{
  "status": "pending", "sv": 1, "seq": 37,
  "ops": [{
    "target": { "table": "ledger.expenses", "row": "r_01JD3K…" }, "intent": "correct", "ver": "v33.0",
    "fields": { "amount": {
      "result": "candidate", "item": "pi_7C2E…",
      "effective": { "value": "35", "unit": "CNY" }, "current_ver": "v33.0",
      "by": { "seq": 33, "actor": { "kind": "connection", "id": "ci_01B…", "name": "MacBook · Codex" } },
      "previous": { "seq": 29, "exists": true, "values": { "amount": { "value": "30", "unit": "CNY" } } }
    } }
  }],
  "derived": [], "derived_total": 0,
  "pending": [{ "id": "pi_7C2E…", "type": "conflict", "reason": "stale_write", "item_ver": "iv_4f81…" }],
  "superseded": []
}
```

例三，状态类表，默认终点：

```json
{
  "sv": 2,
  "evidence": [{ "kind": "user_message", "text": "其实 11 月 2 号起餐饮预算就降到 3000 了" }],
  "ops": [{ "intent": "update", "table": "budgets", "entity_key": { "category": "餐饮" }, "ver": "v52.0",
    "valid_from": "2026-11-02", "set": { "amount": { "value": "3000", "unit": "CNY" } } }]
}
```
```json
{
  "status": "saved", "sv": 2, "seq": 55,
  "ops": [{
    "target": { "table": "ledger.budgets", "entity": "e_01JCB2…", "entity_key": { "category": "餐饮" } },
    "intent": "update", "ver": "v55.0",
    "fields": { "amount": [{ "result": "applied",
      "valid": { "valid_from": "2026-11-02", "valid_to": "2026-11-10", "valid_to_inclusive": "2026-11-09" },
      "before": { "value": "5000", "unit": "CNY" }, "after": { "value": "3000", "unit": "CNY" },
      "overwritten": [{ "valid": { "valid_from": "2026-11-02", "valid_to": "2026-11-10", "valid_to_inclusive": "2026-11-09" },
        "value": { "value": "5000", "unit": "CNY" }, "seq": 49 }] }] },
    "resolved": { "amount": {
      "valid_from": "2026-11-02", "valid_to": "2026-11-10", "valid_to_inclusive": "2026-11-09",
      "from_as": "given", "to_as": "next_change",
      "next_change": { "at": "2026-11-10", "value": { "value": "4000", "unit": "CNY" } } } }
  }],
  "derived": [], "derived_total": 0, "pending": [], "superseded": [],
  "affected_reads": { "count": 1, "by_reason": { "retroactive": 1 }, "covered_since": "2026-05-14T00:00:00+08:00",
    "not_covered": ["derived_reads"] }
}
```

### 5.2 `resolve`

```ts
/** 证据只有 evidence 与 evidence_by_field：resolve 没有请求级证据，不收 evidence_refs。
 *  evidence_by_field 的下标数的就是本次的 evidence 数组；处理触发写入时，它按字段指明那次写入的证据。 */
interface ResolveParams extends WriteCommonParams, Omit<EvidenceOnOp, "evidence_refs"> {
  id: ItemId;
  decision: Decision;
  /** 读到的事项版本。没带时兜底；deletion 的 cancel 不用带。 */
  item_ver?: ItemVer;
  /** 只用于 conflict 的 take_candidate：采纳哪一个候选（它的下标 index）。只有一个候选时可省略。 */
  candidate?: number;
  /** 备注。带了 note 时，解决请求本身存为一条 api_call 源数据（不论是否触发写入、是否另带了证据），
   *  解决事件以操作来源引用它；事项详情与 item_closed 错误详情里的 resolution.note 都从它回显。它经普通的隐私删除（删这条源数据）清除，清除之后 resolution 不再带 note。 */
  note?: UntrustedText;
  diff_upto?: number;            // @later：migration_diff 的 accept_all
  rows?: { accept?: RowId[]; reject?: RowId[]; set?: Record<RowId, Values> };   // @later：migration_diff 的逐行处理
}

interface ResolveResult extends CommonResult {
  id: ItemId;
  type: ItemType;
  decision: Decision;
  item_ver: ItemVer;             // 解决后的新版本
  status: "resolved";
  /** 处理触发了写入时：形状同写入回执的对应部分。 */
  write?: Pick<WriteResult, "seq" | "sv" | "ops" | "derived" | "derived_total" | "pending" | "superseded" | "affected_reads" | "premise_affected" | "omitted">;
  /** take_previous：它回掉的写入，照这次决定所确认的事项版本里 ConflictDetail.reverted_by_previous 列的（重放回执读同一份，不按当前状态重算）。 */
  reverted_by_previous?: Array<{ seq: Seq; actor: Actor; fields: Array<FieldName | "*"> }>;
  /** schema_change 的 confirm。 */
  schema?: { switched: boolean; sv?: Sv; migration?: MigrationStatus };
  /** deletion 的 cancel。 */
  cancelled?: {
    rows: Array<{ target: TargetRef; ver: Ver }>;                       // 受影响行 / 实体的新 ver
    reverted: Array<{ seq: Seq; target: TargetRef }>;                   // 退回原状态的写入
    restored: ItemId[];                                                 // 恢复的事项
    kept_superseded: Array<{ item: ItemId; by: Seq }>;                  // 保持"已被取代"的事项及改过它的写入
    kept_effective: Array<{ seq: Seq; target: TargetRef; by: Seq }>;    // 因删除生效、宽限期内已被别的写入当作基线的写入：不退回
    /** 撤回后放回来的候选，原事项在宽限期内已被解决：按撤回时的当前状态重新判定的结果，一个候选一条。
     *  reopened：还有部分与当前值不同，另开了一个冲突事项；corroborated：都与当前值相同、其中有指了证据的，成为佐证；
     *  dropped：都与当前值相同、没指证据，不再是改动。 */
    rejudged: Array<{ seq: Seq; target: TargetRef; from_item: ItemId;
                      result: "dropped" | "corroborated" | "reopened"; item?: { id: ItemId; item_ver: ItemVer } }>;
    derived: DerivedChange[];
    premise_affected?: PremiseAffected;   // 撤回让前提的值变了或恢复了：新带上与撤掉标记的依赖行
  };
  replayed?: true;
  /** 回执里省略的部分，取值与 WriteResult.omitted 同一集合：指的是触发的写入（write）的回执。
   *  重放时按日志重建不出的部分，或回执超出外化面的结果预算时截短的部分。操作号、目标、新 ver、生成的事项 ID 不截。 */
  omitted?: WriteResult["omitted"];
}
```

例：

```json
{ "id": "pi_7C2E…", "decision": "keep_effective", "item_ver": "iv_4f81…" }
```
```json
{ "id": "pi_7C2E…", "type": "conflict", "decision": "keep_effective", "item_ver": "iv_9b02…", "status": "resolved" }
```

采纳候选（触发一次写入）：

```json
{ "id": "pi_7C2E…", "decision": "take_candidate", "item_ver": "iv_4f81…" }
```
```json
{
  "id": "pi_7C2E…", "type": "conflict", "decision": "take_candidate", "item_ver": "iv_9b02…", "status": "resolved",
  "write": {
    "seq": 41, "sv": 1,
    "ops": [{ "target": { "table": "ledger.expenses", "row": "r_01JD3K…" }, "intent": "correct", "ver": "v41.0",
      "fields": { "amount": { "result": "applied", "before": { "value": "35", "unit": "CNY" }, "after": { "value": "32", "unit": "CNY" } } } }],
    "derived": [{ "table": "ledger.monthly_total", "key": { "month": "2026-11-01" }, "field": "total",
      "before": { "value": "89", "unit": "CNY" }, "after": { "value": "86", "unit": "CNY" } }],
    "derived_total": 1, "pending": [], "superseded": [],
    "affected_reads": { "count": 0, "by_reason": {}, "covered_since": "2026-05-14T00:00:00+08:00", "not_covered": ["derived_reads"] }
  }
}
```

### 5.3 `schema_draft`

```ts
interface SchemaDraftParams extends WriteCommonParams {
  /** schema 文档（data-model「schema 文档格式」）。新建 slot 时 base_version: null。 */
  document: SchemaDocument;
}

interface SchemaDraftResult extends CommonResult {
  draft: DraftId;
  slot: SlotName; slot_id: SlotId;
  target_sv: Sv;
  /** 回填了 ID 与推断结果（派生字段的类型、单位、依赖、重算范围）的文档。 */
  document: SchemaDocument;
  changes: SchemaChange[];
  impact: SchemaImpact;
  /** applied：已生效（新建 slot；或按 slot 策略自动生效的改动）。pending：生成了 schema_change 事项。 */
  outcome: "applied" | "pending";
  sv?: Sv;                                   // outcome: applied 且已经切换时的新版本（只改目录的改动、新建 slot 当场切换）
  migration?: MigrationStatus;               // outcome: applied 且要后台建新物理表时：切换前 sv 不给，进度见这里与 notices
  item?: { id: ItemId; item_ver: ItemVer };  // outcome: pending。本回执已给出事项的全部内容，算读到
  superseded_draft?: DraftId;                // 被这次提交取代的旧草稿
  replayed?: true;
  /** 回执超出外化面的结果预算：草稿已提交，不报错，截短并列明——changes（逐项改动的后几条）；document（截掉了文档全文，文本提示用 catalog 的 schema 档带 draft 重读）。
   *  草稿 ID、目标 sv、新 sv、生成的事项 ID 不截。 */
  omitted?: Array<"changes" | "document">;
}

interface SchemaChange {
  target: { slot: true } | { table: TableName; field?: FieldName; rule?: true };
  /** 具体是哪一种改动（见下表）。 */
  change: SchemaChangeCode;
  /** 类别：create 新建 slot / 表；metadata 只改元数据；deterministic 确定性转换；reextract 重新抽取 @later。
   *  经 restructure_unused 生效的改动（从未被写入的表）一律是 metadata：没有已有的值，也没有转换。
   *  事件格式 schema.compiled 的 changes 与本类型逐键相同，只是 target 里用 ID 不用名字。类别不决定要不要建新物理表：那看物理形状变没变（migration 字段）。 */
  class: "create" | "metadata" | "deterministic" | "reextract";
  /** 带旧 sv、写到这个字段的写入是否还被接受。 */
  compatible_with_old_writes: boolean;
  destructive: boolean;          // 会丢数据（删字段、收紧约束后置空等）。从未被写入的表上没有值可丢，为 false
  auto: boolean;                 // 按 slot 策略可自动生效（这一项改动所属的类别在 auto_apply 里）
}

type SchemaChangeCode =
  // slot
  | "create_slot" | "rename_slot" | "change_timezone"
  // 表
  | "add_table" | "add_derived_table" | "drop_table" | "rename_table"
  | "change_duplicate_keys" | "change_together" | "change_time_field"
  | "add_external_key" | "drop_external_key"
  // 表：只在从未被写入的表上做；写入过的表上整份草稿报 not_in_this_version（reason: table_written）
  | "change_time_type" | "change_entity_key" | "change_granularity"
  | "change_table_kind"             // 只有 base 改 derived 一个方向；derived 改 base 不支持
  | "change_external_key"
  // 基础表的字段
  | "add_optional_field" | "add_required_field" | "drop_field" | "rename_field"
  | "loosen_constraint" | "tighten_constraint" | "change_precision"
  | "change_unit" | "change_dimension" | "change_type"
  | "change_ref"                    // 字段与 ref 互转、改 ref 的目标：只在这个字段所在的表从未被写入时做
  // 派生表
  | "change_rule"
  // 表、字段、派生字段的说明与别名
  | "change_description" | "change_aliases"
  // @later：草稿里出现时整份报 not_in_this_version，不会出现在第一版的结果里
  | "reextract";

interface SchemaImpact {
  rows_affected: number;
  derived_changed: Array<{ table: TableName; rows: number }>;
  /** 最近按旧名字读写过被改名 / 被删字段的调用方（从读写记录推断）。 */
  consumers: Array<{ actor: Actor; field: string; last_used: Instant; used_for: "read" | "write" }>;
  /** migrate / backfill 的试跑。 */
  trial?: { rows: number; failed: number; samples: Array<{ target: TargetRef; error: ValidationDetailCode }> };
  /** 分组键来自自由文本字段的派生规则。 */
  free_text_group_keys?: Array<{ table: TableName; field: FieldName }>;
  estimated_seconds?: number;
  sources_to_reextract?: number; // @later
}
```

改动码与类别、slot 策略里的自动生效类别（`auto_apply`）的对应（每种改动的完整规则在 data-model「改动分类与迁移手段」）：

| `change` | `class` | 属于哪个 `auto_apply` 类别 |
|---|---|---|
| `create_slot` | `create` | 总是直接生效 |
| `rename_slot` | `metadata` | — |
| `change_timezone` | `deterministic` | — |
| `add_table` | `create` | `add_table` |
| `add_derived_table` | `create` | `add_derived_table` |
| `drop_table` | `metadata` | — |
| `rename_table`、`rename_field` | `metadata` | `rename_unused`（最近 30 天没有提交者以外的连接实例用过它时） |
| `change_description`、`change_aliases` | `metadata` | `description` |
| `change_duplicate_keys` | `metadata` | `duplicate_keys` |
| `change_together` | `metadata` | — |
| `change_time_field` | `metadata` | 从未被写入的表上：`restructure_unused`；否则 — |
| `add_external_key`（写入过的表上：键字段须是同一份草稿新增的字段）、`drop_external_key` | `metadata` | 从未被写入的表上：`restructure_unused`；否则 — |
| `change_external_key` | `metadata` | 只在从未被写入的表上做：`restructure_unused` |
| `change_time_type`、`change_entity_key`、`change_granularity`、`change_table_kind`（`base` 改 `derived`） | `metadata` | 只在从未被写入的表上做：`restructure_unused` |
| `add_optional_field` | `metadata` | `add_optional_field` |
| `add_required_field` | `deterministic` | 从未被写入的表上：`restructure_unused`（仍须给常量形式的 `backfill`）；否则 — |
| `drop_field` | `metadata` | 从未被写入的表上：`restructure_unused`；否则 — |
| `loosen_constraint`（必填改可选、放宽 `min` / `max`、枚举加值、加大 `scale`） | `metadata` | `loosen_constraint` |
| `tighten_constraint`（可选改必填、收紧 `min` / `max`、删枚举值） | `deterministic` | 从未被写入的表上：`restructure_unused`；否则 — |
| `change_precision`（减小 `scale`、改 `rounding`） | `deterministic` | 从未被写入的表上：`restructure_unused`；否则 — |
| `change_unit`（同量纲） | `deterministic` | 从未被写入的表上：`restructure_unused`；否则 — |
| `change_dimension`、`change_type` | `deterministic` | 从未被写入的表上：`restructure_unused`；否则 — |
| `change_ref`（字段与 `ref` 互转、改 `ref` 的目标） | `metadata` | 只在这个字段所在的表从未被写入时做：`restructure_unused` |
| `change_rule`（含 `time_dependency`） | `deterministic` | — |

"—"表示一律要确认。一份草稿的 `outcome` 是 `applied`，当且仅当它的每一项改动都 `auto: true`（新建 slot 总是）：同一个改动码是否自动，依它所在的表而定。

- **"从未被写入"**：日志里没有任何一条以这张表（按表 ID）为目标的基础写入。写过、行已全部撤销，或内容已全部隐私删除，都不算；候选与待确认的写入也算写过。
- **`restructure_unused`** 的条件还要求这张表最近 30 天没有提交者以外的连接实例按名字读写过（与 `rename_unused` 的"没人在用"相同）；有人用过时这些改动要确认。归入它时没有值可丢、也没有值要转换：`class` 一律是 `metadata`（表里 `class` 一栏写的是写入过的表上的类别；`class` 记的是这次切换实际做了什么），`destructive` 为 `false`，`migrate` 不必给。新增必填字段与可选改必填仍须给常量形式的 `backfill`。
- 经 `restructure_unused` 生效的任何改动之后，带旧 `sv` 写这张表的写入一律报 `schema_incompatible`，`changed_fields` 给 `{field: "*", change: <改动码>}`。
- 来源键字段的 `change_type`、`tighten_constraint` 在写入过的表上不支持（`not_in_this_version`）：转换后的值可能相撞。

例（给 `expenses` 加一个可选字段；默认策略下 `add_optional_field` 自动生效）：

```json
{ "document": { "slot": "ledger", "base_version": 1, "tables": [{
    "name": "expenses", "id": "t1", "kind": "base", "description": "每笔支出一行",
    "time": { "type": "event", "field": "date" },
    "fields": [
      { "id": "f1", "name": "date", "type": "date", "required": true, "description": "支出当天（slot 时区的自然日）" },
      { "id": "f2", "name": "category", "type": "text", "required": true, "description": "类别" },
      { "id": "f3", "name": "amount", "type": "quantity", "unit": "CNY", "required": true, "min": 0, "description": "金额" },
      { "id": "f4", "name": "note", "type": "text", "description": "备注" },
      { "name": "payee", "type": "text", "description": "收款方" }
    ] }] } }
```
```json
{
  "draft": "d_2A7C…", "slot": "ledger", "slot_id": "sl_4KTZ…", "target_sv": 2,
  "document": { "slot": "ledger", "base_version": 1, "tables": [{ "name": "expenses", "id": "t1", "…": "…",
    "fields": [{ "id": "f1", "name": "date", "…": "…" }, { "id": "f5", "name": "payee", "type": "text", "description": "收款方" }] }] },
  "changes": [{ "target": { "table": "ledger.expenses", "field": "payee" }, "change": "add_optional_field", "class": "metadata",
    "compatible_with_old_writes": true, "destructive": false, "auto": true }],
  "impact": { "rows_affected": 0, "derived_changed": [], "consumers": [] },
  "outcome": "applied",
  "migration": { "target_sv": 2, "state": "building" }
}
```

### 5.4 `delete`

```ts
interface DeleteParams extends WriteCommonParams {
  /** deletion_preview 返回的 dc_…。只执行，不预览。 */
  confirm: DeleteConfirm;
}

interface DeleteResult extends CommonResult {
  /** 删除 ID 与宽限期内的 deletion 事项是同一个对象。 */
  deletion: {
    id: ItemId; item_ver: ItemVer; expires_at: Instant;
    cancel_with: { op: "resolve"; id: ItemId; decision: "cancel" };
  };
  seq: Seq;
  kind: "privacy" | "evidence" /* @later */;
  /** 从 totals 到 local_deferred：按确认时的状态重算的预览内容。预览里有的列表回执里都有，上限与 _total 同预览（rows 除外，见下）；
   *  rows 另带新 ver，now_awaiting 另带生成的事项。其余是回执另给的。 */
  totals: { sources: number; rows: number; derived: number };
  rows: Array<DeletionRowResult & { ver?: Ver }>;    // 仍存在的行 / 实体带新 ver。最多 200 条，另给 rows_total
  rows_total: number;
  now_effective: DeletionPreviewResult["now_effective"];
  now_effective_total: number;
  now_awaiting: Array<{ seq: Seq; target: TargetRef; item: { id: ItemId; item_ver: ItemVer }; impact: AwaitingImpact }>;
  now_awaiting_total: number;
  superseded: DeletionPreviewResult["superseded"];
  superseded_total: number;
  group_keys_cleared?: DeletionPreviewResult["group_keys_cleared"];
  dangling_refs: DeletionPreviewResult["dangling_refs"];
  dangling_refs_total: number;
  not_deleted: DeletionPreviewResult["not_deleted"];
  orphaned_sources: DeletionPreviewResult["orphaned_sources"];
  orphaned_sources_total: number;
  premise_affected?: PremiseAffected;   // 删除让前提的值变了的依赖行：已带上 premise_changed（reason: deleted）
  local_deferred?: true;
  derived: DerivedChange[];
  derived_total: number;
  states: DeletionState[];
  /** 删除后仍保留的元数据。 */
  retained_metadata: Array<"event_headers" | "row_existence" | "actors_and_intents">;
  replayed?: true;
  /** 回执超出外化面的结果预算：删除已生效，不报错，截短并列明——rows（逐行结果的明细）、derived（派生值的后几条）、
   *  lists（其余各列表的后几条）、premise_affected（premise_affected.rows）。rows 截短时每行只留目标与新 ver：删除 ID、操作号、目标、新 ver、生成的事项 ID 不截。 */
  omitted?: Array<"rows" | "derived" | "lists" | "premise_affected">;
  reextract?: Array<{ target: TargetRef; fields: FieldName[]; job: JobId }>;   // @later
  cleared?: Array<{ target: TargetRef; fields: FieldName[] }>;                 // @later
}
```

例：

```json
{ "confirm": "dc_8ZqK1v…" }
```
```json
{
  "deletion": { "id": "pi_4K9M…", "item_ver": "iv_02d3…", "expires_at": "2026-11-12T09:12:30+08:00",
    "cancel_with": { "op": "resolve", "id": "pi_4K9M…", "decision": "cancel" } },
  "seq": 42, "kind": "privacy",
  "totals": { "sources": 1, "rows": 1, "derived": 1 },
  "rows": [{ "target": { "table": "ledger.expenses", "row": "r_01JC8Z…" }, "result": "fields_reverted",
    "after": { "values": { "date": "2026-11-10", "category": "餐饮", "amount": { "value": "45", "unit": "CNY" } } },
    "reverted_to": { "amount": { "value": { "value": "45", "unit": "CNY" }, "from_seq": 21, "reason": "later_write_removed" } },
    "basis": { "date": [21], "category": [21], "amount": [21] },
    "ver": "v42.0" }],
  "rows_total": 1,
  "now_effective": [], "now_effective_total": 0,
  "now_awaiting": [], "now_awaiting_total": 0,
  "superseded": [], "superseded_total": 0,
  "dangling_refs": [], "dangling_refs_total": 0,
  "not_deleted": [{ "kind": "retained_metadata" }],
  "orphaned_sources": [], "orphaned_sources_total": 0,
  "local_deferred": true,
  "derived": [{ "table": "ledger.monthly_total", "key": { "month": "2026-11-01" }, "field": "total",
    "before": { "value": "89", "unit": "CNY" }, "after": { "value": "80", "unit": "CNY" } }],
  "derived_total": 1,
  "states": [
    { "place": "store", "state": "logically_deleted", "since": "2026-11-11T09:12:30+08:00",
      "due": "2026-11-12T09:12:30+08:00", "deferred_to_next_start": true },
    { "place": "backups", "state": "retained", "since": "2026-11-11T09:12:30+08:00", "managed": false }
  ],
  "retained_metadata": ["event_headers", "row_existence", "actors_and_intents"]
}
```

---

## 6. 抽取作业（`@later`）

`extract_claim` 与 `extract_submit` 不进第一版。请求与结果的形状见 [`04-contract.md`](04-contract.md) 第 10 节里的 JSON；进入实现时在本文补类型。

---

## 7. 提醒与提示

```ts
/** 与本次调用的某个部分有关的结构化提醒。op = ops 的下标。 */
/** 兜底取得的 ver / sv 出自哪里，两者恰好一个：某次读取，或本连接实例某次写入回执（那次写入的操作号）。 */
type FallbackOrigin = { read: ReadId; from_write?: never } | { from_write: Seq; read?: never };

type Warning =
  | { code: "unit_converted"; op: number; field: FieldName; from: Quantity; to: Quantity }
  | { code: "rounded"; op: number; field: FieldName; from: string; to: string; scale: number }          // 小数位数超过字段的 scale，已按 rounding 舍入
  | { code: "timezone_assumed"; op?: number; field?: FieldName; param?: string; timezone: string }   // 时刻没带时区，按 slot 时区
  | { code: "time_truncated"; op?: number; param: string; from: Instant; to: DateStr }               // 按日的表收到时刻，取了所在日
  | ({ code: "ver_fallback"; op: number; ver: Ver } & FallbackOrigin)
  | ({ code: "sv_fallback"; sv: Sv } & FallbackOrigin)
  | { code: "item_ver_fallback"; item_ver: ItemVer; read?: ReadId }
  | { code: "renamed"; op?: number; table?: TableName; from: string; to: string }                    // 用了旧名
  | { code: "multi_segment_unmapped"; op: number; fields: FieldName[] }                              // 多段证据没给字段映射
  | { code: "evidence_unreferenced"; evidence: number[] }                                             // 请求级证据段没被任何 op 引用：请求产生了事件时照存为源数据，但不是任何值的来源
  | { code: "overwrote_corroborated"; op: number; field: FieldName; valid: Interval; sources: SourceId[] }
  | { code: "pending_deletion_on_target"; op?: number; item: ItemId }                                // 目标有一项可撤回的删除
  | { code: "clock_behind_log"; behind_seconds: number }                                             // 入口时刻早于日志末端的记录时刻
  | ({ code: "premise_ver_fallback"; op: number; premise: number; ver: Ver } & FallbackOrigin)   // 前提没带 ver，用了最近一次读到的；premise = premises 的下标
  | { code: "premise_already_changed"; op: number; premise: number; since: Seq }                     // 声明时前提已经变了：这一行一写下就带 premise_changed
  | { code: "evidence_not_stored"; evidence: number[] }                                              // write：请求没有产生事件（全部 op 都是按来源键的 unchanged / skipped），显式带的证据段也没有存下
  | { code: "external_key_skipped"; ops: number[] }                                                  // write：有按来源键的 op 被跳过（outcome: skipped）
  | { code: "external_key_resync"; rows: TargetRef[]; rows_total: number }                           // deletion_preview、delete、到期关闭的 deletion 事项详情：受影响的行有来源键，
                                                                                                     // 物理删除后 saveslot 不记得这个键，连接器再同步同一条记录时会作为新行重新出现。rows 最多 50 行
  | { code: "single_field_external_key"; table: TableName }                                          // schema_draft：来源键只有一个字段，多个来源系统写这张表时 ID 可能相撞
  | { code: "group_key_free_text"; table: TableName }                                                // schema_draft：派生表的分组键来自自由文本字段，删除时随分组一起清除
  | { code: "job_items_appended"; op: number; job: JobId };                                          // @later

/** 与本次调用相关的提示，最多 3 条。每一种都只按调用方的可见范围计算：范围外的 slot 不出现在任何提示里。 */
type Notice =
  | { code: "pending_items"; slot: SlotName; count: number; oldest_opened_at: Instant }       // 本次调用涉及的 slot 里未决的事项：条数与最早一条的产生时刻。每个 slot 一条，count 为 0 的不给；
                                                                                                     // 按 oldest_opened_at 从早到晚、同一时刻按 slot 名取前 3 条。pending 自己的结果不带（它本身就在列事项）
  | { code: "schema_updated"; slot: SlotName; from: Sv; to: Sv; changed: string[] }                  // 本连接实例上次读到的 sv 落后
  | { code: "migration_progress"; slot: SlotName; target_sv: Sv; done: number; total: number; item?: ItemId }
  | { code: "deletion_overdue"; slot: SlotName; item: ItemId }                                       // 已到期的删除尚未物理删除
  | { code: "job_failed"; slot: SlotName; job: JobId };                                              // @later
```

---

## 8. 管理类操作

除 `policy.get` 外只给用户会话；不进 MCP。

### 8.1 `connections.*`

```ts
type Scope = "saveslot.read" | "saveslot.write" | "saveslot.schema" | "saveslot.delete";

interface ConnectionsIssueParams {
  /** 建议写成"设备 · Agent"。同一用户下不重名，重名报 invalid_argument（duplicate_name，param: "name"）；按存下的字符串逐码点比较，不折叠大小写；已吊销、已停用的连接实例的名字仍然占用（历史里同一个名字只指一个主体）。 */
  name: string;
  /** 必须包含 saveslot.read。默认 ["saveslot.read", "saveslot.write", "saveslot.schema"]：能读写、能新建 slot，不能删除。 */
  scopes?: Scope[];
  /** slot 范围：slot 名或 slot_id 的数组。不给 = 全部（含以后新建的）。给了：每个都必须存在（否则 not_found / slot），不能是空数组（invalid_argument / empty_slots）。
   *  签发后不能改。 */
  slots?: SlotName[];
}

interface Connection {
  id: ConnectionId; name: string; scopes: Scope[];
  slots?: Array<{ slot: SlotName; slot_id: SlotId }>;   // slot 范围；不给 = 全部。给了而为空数组 = 范围里的 slot 都已移除，看不到任何 slot（不是全部）
  via: "token" | "oauth";        // 本地令牌 / 静态令牌，或一次 OAuth 授权
  client?: string;               // via: oauth 时的客户端标识
  created_at: Instant;
  last_used_at?: Instant;        // 这一版不给（08-open-questions「连接实例的最近使用时刻」）
  /** 与 Actor.state 一致：已吊销（revoked）或因导入而停用（disabled）时给；有效时不给。 */
  state?: "revoked" | "disabled";
  revoked_at?: Instant;
}

interface ConnectionsIssueResult extends Connection {
  /** 只返回这一次；saveslot 只存它的哈希。 */
  token: string;
}

interface ConnectionsListParams { include_revoked?: boolean; limit?: number; cursor?: Cursor }   // include_revoked: true 时已吊销与已停用的都列出；默认都不列
interface ConnectionsListResult extends PageResult { connections: Connection[] }

interface ConnectionsUpdateParams { id: ConnectionId; name: string }   // 只能改名。已吊销、已停用的连接实例也能改名（不重名照查）；改成现在的名字时不记事件，返回当前结果
interface ConnectionsRevokeParams { id: ConnectionId }
type ConnectionsUpdateResult = Connection;
type ConnectionsRevokeResult = Connection;                             // state 是 revoked，revoked_at 已填；重复吊销返回同一结果
```

例：

```json
{ "name": "MacBook · Claude Code" }
```
```json
{ "id": "ci_01A…", "name": "MacBook · Claude Code", "scopes": ["saveslot.read", "saveslot.write"], "via": "token",
  "created_at": "2026-11-10T12:20:00+08:00", "token": "slt_…" }
```

### 8.2 `policy.get` / `policy.set`

```ts
interface PolicyGetParams { slot: SlotName }

interface SlotPolicy {
  slot: SlotName;
  policy_version: number;        // 策略版本：每次变更加 1（与事件格式同名）
  /** 冲突期间的生效值规则。第一版只有 keep_current。 */
  effective_value_rule: "keep_current" | "by_rank" /* @later */;
  /** 来源级别的秩表。第一版只记不用。 */
  rank: { user_stated: number; agent_inferred: number; miss: number };
  /** 哪些 schema 改动不经确认直接生效。默认策略八个全开；restructure_unused 加入默认策略之前建的 slot 没有它。 */
  auto_apply: Array<"add_table" | "add_derived_table" | "add_optional_field" | "description"
                    | "rename_unused" | "loosen_constraint" | "duplicate_keys" | "restructure_unused">;
  /** 额外算高影响的表 / 字段。@later */
  high_impact?: Array<{ table: TableName; fields?: FieldName[] }>;
  /** 只接受用户会话确认的处理。@later */
  user_session_only?: Array<{ type: ItemType; decision: Decision }>;
  set_by: Actor; set_at: Instant; seq: Seq;
}

interface PolicySetParams extends Omit<SlotPolicy, "policy_version" | "set_by" | "set_at" | "seq"> {}   // @later
```

### 8.3 `reads.list`

```ts
interface ReadsListParams extends PageParams {
  connection?: ConnectionId | string;   // ID 或名字
  slot?: SlotName; table?: TableName;
  of_task?: string;                     // 筛选：只列带这个任务标识的读取。HTTP 上是同名查询参数；不是 CommonParams.task
  since?: Instant; until?: Instant;    // [since, until)
}

interface ReadsListResult extends PageResult {
  /** 读取记录保留到哪一刻。 */
  covered_since: Instant;
  reads: Array<{
    read: ReadId; at: Instant; actor: Actor; task?: string;
    operation: "query" | "sql" | "history" | "sources" | "catalog" | "pending" | "deletion_preview";
    selfcheck?: true;            // 签发连接实例时的自检
    /** 只在这次读取落在一个 slot 上时给。 */
    slot?: SlotName; sv?: Sv; table?: TableName;
    /** 读到的行与版本。只给版本，不给值。最多 50 条，另给总数。 */
    rows?: Array<{ target: TargetRef; seq: Seq }>;
    rows_total?: number;
    /** 读到的行太多、改记成表级记录的表（data-model「读取记录」）：只有表与这次读取所见状态的位置，没有逐行的版本。 */
    coarse?: Array<{ table: TableName; pos: Seq }>;
    valid?: { at?: BizTime; during?: [BizTime, BizTime | null] };   // 问的业务时间
    source?: SourceId;           // 读的是源数据原文
  }>;
}
```

### 8.4 `log.verify` / `log.reconcile` / `export` / `import`

```ts
interface LogVerifyResult {
  events: number;
  chain: { intact: true } | { intact: false; broken_at: number /* 事件的 seq */ };
  checksum_mismatch: Array<{ seq: number; path: string }>;   // 内容块的位置；不含内容
  /** 拆出的索引列与事件头、target 块不符的事件；不算链断裂，照事件头与 target 块重算即可修复。只给位置。 */
  index_mismatch: Array<{ seq: number }>;
  removed: number;                                            // 已按删除移除的内容块数
  /** 恢复留下的 seq 空档；不算断裂。 */
  gaps: Array<{ after: number; before: number; restore: number /* 恢复事件的 seq */ }>;
}

interface LogReconcileResult {
  compared_to: number;           // 比较到的事件 seq
  tables: Array<{ name: string; rows: number; mismatched: number }>;   // 逻辑表：architecture §8 里标了"对拍：是"的全部表
  /** 不一致的位置：只给 ID，不回显值。最多 100 条。 */
  mismatches: Array<{ table: string; row?: string; field?: string; kind: "missing" | "extra" | "different" }>;
  mismatches_total: number;
}

/** 导入到空租户。只给用户会话。输入是导出文件的字节流（一个文件，或按 after 续传切出的几段、按顺序接在一起），没有其他参数。 */
interface ImportResult {
  tenant_id: string; previous_tenant_id: string;
  events: number;                 // 导入的事件条数
  seq: number;                    // tenant.imported 的 seq
  restore_count: number;
  principals_disabled: number;
  slots: number;
  removed: number;                // 导入时已是"已移除"的内容块数
  pending_deletions: { executed: number; carried: number };   // 补了墓碑的；仍待执行的
  exported_at: string;
  not_imported: Array<"read_log" | "credentials" | "external_files">;
}

interface ExportParams {
  after_seq?: number;                  // 从某个事件之后续传
  include_pending_deletion?: boolean;  // 默认 false：宽限期内待删除的内容换成占位
}

/** NDJSON。第一行是清单，之后每行一条事件。清单与事件行的形状以事件格式规格（09-event-format.md 第 8 节）为准。 */
interface ExportHeader {
  saveslot_export: 1;                  // 导出文件格式的版本
  tenant_id: string;
  event_format: number;
  restore_count: number;
  after?: number;                      // 续传：本文件只含 seq 大于它的事件
  upto: number;                        // 本文件最后一条事件的 seq
  events: number;                      // 本文件的事件条数
  exported_at: string;                 // UTC，毫秒精度（事件格式的时刻写法）
  pending_deletions: "placeholder" | "included";
}
```

---

### 8.5 `log.end`

只给用户会话，没有参数。日志末端：最新一条事件的 `seq` 与记录时刻；`recorded_at` 与契约里其他记录时刻同一格式。`saveslot status` 用它对照本机时钟（architecture §8：本机时钟比日志末端早 5 分钟以上时提醒）。

```ts
/** 日志里一条事件都没有时为 null。 */
type LogEndResult = { seq: Seq; recorded_at: Instant } | null;
```

### 8.6 `slots.remove`

只给用户会话。移除一个空的 slot（[`04-contract.md`](04-contract.md) 第 17 节）。

```ts
interface SlotsRemoveParams {
  /** 只收 slot_id：名字可以重用，按名字的移除重发会删掉同名新建的 slot。给的是名字报 invalid_argument（param: "slot_id"）。 */
  slot_id: SlotId;
}

/** 移除时的样子；已移除的 slot 再移除一次返回同一结果（不记事件）。 */
interface SlotsRemoveResult {
  slot_id: SlotId;
  name: SlotName;     // 移除时的名字
  sv: Sv;             // 移除时的当前版本
  removed_at: Instant;
}
```

例：

```json
{ "slot_id": "sl_4KTZ8M2Q9VHB3XCD" }
```
```json
{ "slot_id": "sl_4KTZ8M2Q9VHB3XCD", "name": "spare", "sv": 1, "removed_at": "2026-11-19T10:00:00Z" }
```

## 9. 错误

```ts
interface ErrorEnvelope { error: ErrorObject }

interface ErrorObject {
  code: ErrorCode;
  /** 一句给人看的说明。是不可信文本（05-surfaces 第 5 节）：可能带出调用方传入的内容；程序按 code 与 reason 判断，不解析它。 */
  message?: string;
  /** 细分原因。取值见下表。 */
  reason?: string;
  /** 出问题的参数：JSON 指针式的路径，如 "ops/0/valid_to"。 */
  param?: string;
  /** 校验类错误的逐条明细。判定时才发现的（`required_in_gap`）只列第一个被拒的 op：后面的 op 不再判定；
   *  这个 op 内每个字段、每一段各一条。 */
  details?: ValidationDetail[];
  /** 多久后可以重试，秒。 */
  retry_after?: number;
  /** 其余附带字段见下表。 */
  [extra: string]: unknown;
}

interface ValidationDetail {
  op?: number;                   // ops 的下标
  table?: TableName; field?: FieldName;
  path?: string;                 // schema 文档里的位置："tables/0/fields/2"、"tables/1/rule/sql"
  code: ValidationDetailCode;
  line?: number;                 // 规则 SQL 的行
  valid?: Interval;              // required_in_gap：缺字段的那段区间
  // table：required_in_gap 与 empty_row 给出，写法同回执的 slot.table
  allowed_units?: string[]; allowed_values?: string[]; min?: string; max?: string;
  rows?: number; samples?: TargetRef[];   // backfill_required：违反的行数与样例
  referenced_by?: string[];      // still_referenced：依赖它的对象在 schema 文档里的位置（同 path 的写法）
  /** rule_sql_rejected、nondeterministic_function、unit_inference_failed、migrate_failed、rule_eval_failed：细分原因，与 sql_rejected 的 reason 同一套取值。 */
  sql_reason?: "syntax" | "not_select" | "function" | "node" | "system_time" | "unknown_name" | "type" | "limit" | "runtime";
  suggestion?: string;           // 机器可用的改法：如替换后的 SQL 片段
}

type ErrorCode =
  // 领域错误（contract-core）
  | "invalid_argument" | "unknown_table" | "unknown_field" | "not_found" | "revoked"
  | "derived_readonly" | "validation_failed" | "read_first" | "schema_incompatible"
  | "too_large" | "sql_rejected" | "sql_timeout" | "draft_outdated" | "field_unmatched"
  | "confirmation_mismatch" | "item_closed" | "preview_outdated"
  | "referenced" | "lease_expired"                         // @later
  // 外层错误（contract）
  | "unauthenticated" | "insufficient_scope" | "rate_limited" | "handle_expired"
  | "not_in_this_version" | "unavailable" | "internal"
  | "import_rejected";                                     // 管理类操作 import

type ValidationDetailCode =
  // 写入
  | "type_mismatch" | "unit_missing" | "unit_unknown" | "unit_dimension" | "out_of_range"
  | "enum_value" | "required_missing" | "required_in_gap" | "ref_not_found" | "ref_wrong_table"
  | "malformed"                     // 十进制原文不符合 JSON 数字语法（04-contract 第 1 节「值的编码」）
  | "empty_row"                     // 事件类表或无时间表上的 insert 没有给任何字段非空的值：清空不能单独撑起一行，这一行不会存在（带 op 与 table）
  // schema 编译
  | "reserved_name" | "duplicate_name" | "description_missing" | "unknown_type"
  | "entity_key_not_required" | "cross_slot_ref"
  | "rule_sql_rejected" | "nondeterministic_function" | "unit_inference_failed"
  | "backfill_required" | "untrusted_marker"
  | "migrate_failed"                // schema 编译：migrate 试跑失败；write：迁移进行中带旧 sv 的写入对新版求值转换表达式失败（path 指到 ops/<i>/set/<字段>），按新版本重读再写
  | "backfill_const_required"       // 新增必填字段、或把可选改成必填：一律必须给常量形式的 backfill（不看表里有没有行）
  | "backfill_both_forms"           // backfill 的常量形式与表达式形式同时给了
  | "still_referenced"              // 要删的表或字段仍被依赖（ref、规则、entity_key、external_key、time.field、duplicate_keys、together）
  | "external_key_table_kind"       // external_key 声明在状态类表或派生表上
  | "external_key_field_type"       // 来源键字段的类型不是 text、enum、integer
  | "external_key_existing_field"   // 写入过的表上加来源键，键字段不是同一份草稿新增的字段
  | "external_key_in_together"      // 来源键字段出现在 together 里
  | "rule_eval_failed"              // 写入触发的派生刷新求值出错（如 64 位整数溢出）：整个写入被拒，不产生事件
  | "alias_invalid"                 // 别名超过 8 个或 64 个字符、规范化后为空或含控制字符、同一对象内重复、与同一作用域里仍可解析的名字相同
  | "unknown_reference"             // 文档里按名字指向的字段或表不存在（time.field、entity_key、external_key、together、duplicate_keys、ref.table）
  | "key_not_applicable"            // 键或它的取值用在不适用的类型或表上（如 min 写在 text 字段上、entity_key 写在非状态类表上、ref.target 与目标表的时间类型不符）
  | "out_of_bounds"                 // 取值越界：min 大于 max、超出类型的范围、scale 不在 0–12、个数或长度超限
  | "duplicate_entry"               // 同一个列表里重复的项：枚举值重复、键列表里同一字段出现两次、一个字段进了两个 together 组
  | "timezone_unknown";             // slot 的 timezone 不是认得的时区名
```

每个错误码的附带字段：

| `code` | `reason` | 其余附带字段 |
|---|---|---|
| `invalid_argument` | `missing` / `malformed`（含给出的 `valid_to` 不晚于区间的起点：起点没给、按"现在"算时也是）/ `ambiguous_table` / `mode_mismatch` / `mutually_exclusive` / `not_this_target` / `content_deleted` / `undo_target`（`undo` 的目标是插入或首次创建、从没生效过的候选或待确认写入，或 schema 切换的操作号）/ `event_table_valid_at` / `no_value_now`（状态类表上不带区间的纠错，"现在"那一点该字段无值）/ `no_time_table` / `not_state_table` / `granularity` / `key_field_changed` / `insert_with_entity_key` / `candidate_required` / `derived_table`（`history` 的 `changes` 以派生表为目标；`query` 在派生表上给了 `valid_at` / `valid_during`）/ `pending_deletion_source` / `cross_slot`（预览的源数据跨 slot；前提指向别的 slot 里可见的表；写入的各 op 落在不同的 slot。靠 `param` 区分是哪一种）/ `idempotency_key_reuse` / `index_out_of_range` / `empty_mapping` / `operator_type` / `missing_read_scope` / `empty_slots`（签发时 `slots` 是空数组）/ `slot_not_empty`（`slots.remove`：slot 名下有记录，或有未结的结构变更事项）/ `duplicate_name`（`connections.issue`、`update`：连接实例重名）/ `tenant_not_empty`（导入的目标租户不是空的）/ 按来源键写入：`insert_with_external_key` / `no_external_key` / `duplicate_external_key` / `external_key_in_use` / `external_key_not_transferable` / `external_key_transferred` / `premises_with_external_key` / 写入的前提：`premise_self` / `premises_with_revert` / `premises_with_revoke` / `premise_historical_ver` | `param`；`candidates?: string[]`（`ambiguous_table` 的候选表名）；`candidate_required` 时 `candidate_choices: Array<{ index: number; seq: Seq; actor: Actor }>`（事项的各候选：下标、所在写入、写入者）；`example?: object`（该模式或该参数完整的正确示例）；`duplicate_external_key` 时 `ops: number[]`（同键的两个 op 的下标）；`external_key_in_use` 时 `deletions?: ItemId[]`（键被冻结：冻结它的全部删除）或 `holder?: RowId`（占着它的未撤销的行）；`external_key_not_transferable`、`external_key_transferred` 时 `holder: RowId`（占着或现在持有这个键的行）；`slot_not_empty` 只因未结的结构变更事项时 `cause: "open_schema_change"` 与 `item: ItemId`（先处理哪个事项） |
| `unknown_table` / `unknown_field` | — | `name`、`nearest: string[]`（只取可见的名字，最多 3 个；别名与 `name` 按 `keymatch@1` 的折叠比较后相同的对象，其名字排在最前；其余按折叠之后的编辑距离从小到大，相同时按名字的 `C` 排序） |
| `not_found` | `row` / `entity` / `item` / `source` / `draft` / `connection` / `read` / `slot` / `route`（HTTP：没有这个端点） | `deletions?: ItemId[]`（被宽限期内的删除整行去掉时：全部碰到它的贡献的待执行删除，按操作号排序；不回显内容）；`sources?: Array<{id, state: "unknown" \| "pending_deletion" \| "removed", deletion?}>` |
| `revoked` | — | `target: TargetRef`、`revoked_by: Seq`（用 `revert: {undo}` 恢复） |
| `derived_readonly` | — | `table`、`base_tables: TableName[]` |
| `validation_failed` | `write` / `schema` | `details[]`、`current_sv?`（`write` 的明细码含 `rule_eval_failed` 与 `migrate_failed`：迁移进行中带旧 `sv` 的写入对新版求值失败，拒绝这次写入而不是让切换失败） |
| `read_first` | `no_read` / `task_mismatch` | `target: "row" \| "item" \| "slot" \| "table"`、`ref?: TargetRef \| ItemId \| SlotName`；`task_mismatch` 时 `read_task`、`task` |
| `schema_incompatible` | — | `current_sv`、`changed_fields: Array<{field, change}>`（`field` 是 `"*"` 时表示整张表：这张表经 `restructure_unused` 改过结构） |
| `too_large` | `evidence_segment` / `request` / `request_body`（HTTP：请求体超过服务能接收的上限）/ `admission` / `result_budget` / `premise_entries` / `premise_fan_in` | `limit_bytes?`、`actual_bytes?`；`admission` 时 `estimated_rows`、`suggested_batch`（第一版整条规则重算，代价不随请求大小变化，准入不拒绝、不报 `admission`；按受影响分区估算之后启用）；`result_budget` 时 `narrow_by: string[]`；`premise_fan_in` 时 `target: TargetRef`、`count`（目标当前被多少条有效声明指向）。这些原因都发生在落账之前；已经落账的操作回执超预算时不报错，截短并带 `omitted[]` |
| `sql_rejected` | `syntax`（语法错误，文本不是良构的 Unicode）/ `not_select` / `function` / `node` / `system_time` / `unknown_name` / `type`（类型或单位不合）/ `limit`（超出上限）/ `runtime`（求值出错，如 64 位整数溢出） | `line`、`node`（不暴露物理名）、`use?: "history"` |
| `sql_timeout` | — | `elapsed_ms` |
| `draft_outdated` | `base_version` / `migrating` / `table_written`（确认时，草稿所改结构的那张表已被写入）/ `migrate_failed`（确认时，`migrate` 对试跑之后的新写入求值失败） | `current_sv`；`migrating` 时 `migration: MigrationStatus` |
| `field_unmatched` | — | `fields: Array<{table, id, name}>` |
| `confirmation_mismatch` | `changed` / `restored` | `current: ItemDetail`（含新的 `item_ver`） |
| `item_closed` | `resolved` / `superseded` / `expired` | `resolution?` / `superseded?`（形状同事项详情）；`expired`（`deletion` 的宽限期已过）：已执行给 `resolution`（执行一支），尚未执行给 `expires_at` |
| `preview_outdated` | — | `preview: DeletionPreviewResult`（含新的 `dc_`） |
| `unauthenticated` | `missing` / `invalid` / `revoked` / `expired` | — |
| `insufficient_scope` | — | `required_scope: Scope \| "user_session" \| "all_slots"`（`all_slots`：这项操作需要范围为全部 slot 的凭证——限定了 slot 范围的凭证新建 slot；第一版里限定了 slot 范围的凭证写入范围内的表，见 [`07-scope-v1.md`](07-scope-v1.md)。只对可见的目标报，不泄露范围外的东西） |
| `rate_limited` | `quota` / `busy`（同一租户已有一次对拍或导入在跑） | `retry_after` |
| `handle_expired` | `expired` / `restored` / `executed` / `derived_changed`（翻页期间派生表被刷新过，从首页重读） | `deletion?: ItemId`（已执行过的 `dc_`） |
| `not_in_this_version` | `parameter` / `value` / `operation` / `table_written`（只对从未被写入的表放开的改动用在写入过的表上）/ `not_implemented`（这一版的实现还走不到的情形：参数本身合法，不是留给后续版本的参数） | `param?`、`value?`、`operation?` |
| `unavailable` | `busy` / `restoring` / `importing` / `reconciling` / `starting` | `retry_after?` |
| `internal` | — | `incident: string`（供排查的编号，不含内容） |
| `import_rejected` | `unsupported_format` / `not_from_start` / `segment_order` / `chain_broken` / `checksum_mismatch` / `incomplete` / `replay_failed` | `seq?`、`path?`（只给位置，不回显内容） |
| `referenced`（`@later`） | — | `referrers`、`alternatives` |
| `lease_expired`（`@later`） | `expired` / `migration_abandoned` / `migration_switched` | — |

哪些操作会返回哪些错误码：

| 操作 | 除通用错误外可能返回 |
|---|---|
| 通用（所有操作） | `invalid_argument`、`unauthenticated`、`insufficient_scope`、`rate_limited`、`not_in_this_version`、`unavailable`、`internal` |
| `catalog` | `unknown_table`、`not_found`（`slot`；`draft`）、`too_large`（`result_budget`）、`handle_expired` |
| `query` | `unknown_table`、`unknown_field`、`handle_expired` |
| `sql` | `sql_rejected`（含 `unknown_name`：表不存在或不可见）、`sql_timeout`、`handle_expired` |
| `history` | `unknown_table`、`unknown_field`、`not_found`（含 `as_of: {read}` 指向不可见的读取）、`read_first`、`handle_expired` |
| `sources` | `not_found`（含 `slot`）、`handle_expired` |
| `deletion_preview` | `not_found`、`handle_expired`、`preview_outdated`、`too_large`（`result_budget`） |
| `pending` | `not_found`（含 `slot`）、`handle_expired`、`too_large`（`result_budget`） |
| `write` | `unknown_table`、`unknown_field`、`not_found`（含前提指向的行）、`revoked`、`derived_readonly`、`validation_failed`、`read_first`、`schema_incompatible`、`too_large`（含 `premise_entries`、`premise_fan_in`） |
| `resolve` | `not_found`、`item_closed`、`confirmation_mismatch`、`read_first`、`draft_outdated`（`table_written` / `migrate_failed`：`schema_change` 的 `confirm`），以及触发的写入可能返回的 |
| `schema_draft` | `validation_failed`、`draft_outdated`、`field_unmatched`、`too_large` |
| `delete` | `handle_expired`、`preview_outdated` |
| `connections.*` | `not_found`（含 `connections.issue` 的 `slots` 里不存在的 slot：`slot`） |
| `slots.remove` | `not_found`（`slot`） |
| `policy.get` | `not_found`（`slot`） |
| `log.reconcile` | `rate_limited`（`busy`：同一租户已有一次在跑） |
| `import` | `invalid_argument`（`tenant_not_empty`）、`import_rejected`、`rate_limited`（`busy`：这个租户已有一次导入在进行）、`too_large`（超出部署方配置的上限） |
