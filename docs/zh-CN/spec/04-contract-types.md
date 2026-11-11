# saveslot · 操作契约的类型定义

> 本文是操作契约的**结构**：每个操作的参数、结果、错误与全部枚举，写成 TypeScript 类型。规则与说明（什么时候返回什么、为什么）在 [`04-contract.md`](04-contract.md)；内核规则在 [`03-data-model/`](03-data-model/README.md)；MCP 与 HTTP 怎么承载在 [`05-surfaces.md`](05-surfaces.md)。
> **字段名、嵌套结构与枚举值以本文为准。** 实现里的 `contract-core` / `contract` 两个包与本文逐项对应；OpenAPI、MCP 的 `inputSchema` / `outputSchema` 都由它们生成。MCP 参数的 `description` 是写给模型看的措辞，原文在 [`05-surfaces.md`](05-surfaces.md) 9.1；本文参数上的注释说明类型与约束。

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
  | 记录时刻 | `recorded_at` |
  | 谁做的 | `actor` |
  | 对象的种类 | `type`（事项）、`kind`（证据、源数据、改动、删除） |
  | 码 | `code`（错误、提醒、提示、校验明细）、`reason`（原因码：事项为什么产生 / 被取代、标记的成因、错误的细分） |
  | 待处理事项 | `item`（只给 ID）或 `{id, item_ver}` |

### 0.2 第一版不实现

本文写完整设计。第一版不实现的参数、取值、操作统一标 `@later`。**调用第一版不实现的东西一律报 `not_in_this_version`**（第 9 节），第一版生成的 schema 里不出现它们。

| 位置 | 第一版不实现的 |
|---|---|
| `write` | `mode: "job"` 与作业（`status: "job"`、`job`、单个 op 超阈值自动转作业）；`revert: {to, fields}`；逐字段结果 `applied_by_rule` |
| `write`（MCP） | op 级 `acknowledge`、证据段的 `level`（HTTP 开放） |
| `history` | `mode: "composition"` |
| `sources` | `mode: "search"` 的全文检索（第一版是子串匹配，参数相同） |
| `deletion_preview` / `delete` | `kind: "evidence"`、`rows`；结果里的 `reextract`、`cleared`、`collateral_rows` |
| `pending` / `resolve` | 事项类型 `migration_diff` 及其处理方式；作业（`jb_…`） |
| `schema_draft` | 改动类别 `reextract`；字段上的 `reextract`；`extends`、`compatibility`；表的时间类型变更；增、删、改 `entity_key`；改 `granularity`；`base` 与 `derived` 互换；`ref` 与其他类型互转、改 `ref` 的目标（对应的改动码见 5.3）；`migrate` / `backfill` 表达式引用本字段以外的字段；最外层不是聚合的派生规则、沙箱函数规则。草稿里出现时整份草稿报 `not_in_this_version` |
| 标记 | `stale`、`pending_extraction`；`possibly_affected` 的 `applied_by_rule` |
| 提示 | `job_failed` |
| 操作 | `extract_claim`、`extract_submit`、`policy.set` |
| 错误 | `lease_expired`、`referenced` |
| slot 策略 | 冲突期间按来源级别裁定（第一版只有 `keep_current`）；额外的高影响表 / 字段；"某类处理只接受用户会话的确认"开关 |
| 概况 | `catalog` 的表概况第一版只有行数与业务时间范围、每个字段最近 K 个不同取值；没有"最近一次写入时间" |

---

## 1. 公共类型

### 1.1 标识

```ts
type SlotName = string;         // 用户内唯一；也接受 slot_id
type TableName = string;        // "ledger.expenses"，或用户内不重名时 "expenses"
type FieldName = string;        // 不以 "_" 开头；不是 valid / valid_from / valid_to（见 04-contract 第 1 节「保留名」）

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
type ZonedDateTime = string;    // RFC 9557："2026-11-10T12:31:00+08:00[Asia/Shanghai]"

/** 业务时间上的一个点。表的粒度是 date 时取 DateStr，是 instant 时取 Instant。 */
type BizTime = DateStr | Instant;

/** 记录时间上的一个点：操作号，或时刻（换算成不晚于它的最后一个操作号；未来的时刻等于最新）。 */
type RecordPoint = Seq | Instant;

/** 业务时间区间，左闭右开。 */
interface Interval {
  valid_from: BizTime;
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
| 业务时间区间 | `{valid_from, valid_to}`，开口终点是 `null`；`date` 粒度另给 `valid_to_inclusive` | `{"from", "to"}`，开口终点是缺省 |
| 整数、小数、数量、日期、布尔、枚举、文本 | 两边相同（整数与小数都是十进制字符串） | 同左 |

### 1.5 目标

```ts
/** 定位一行 / 一个实体 / 一个派生行。除 table 外恰好给一个（insert 时都不给）。 */
interface Target {
  table: TableName;
  row?: RowId;                             // 事件类表、无时间表
  entity?: EntityId;                       // 状态类表
  entity_key?: Record<FieldName, Value>;   // 状态类表，schema 声明了 entity_key 时：{"category": "餐饮"}
  key?: Record<FieldName, Value>;          // 派生表的分组键：{"month": "2026-11-01"}。只读
}

/** 结果里的行标识：服务端总是给出 ID；有自然键 / 分组键时一并给出。 */
interface TargetRef {
  table: TableName;
  row?: RowId;
  entity?: EntityId;
  entity_key?: Record<FieldName, Value>;
  key?: Record<FieldName, Value>;
}
```

### 1.6 主体

```ts
interface Actor {
  kind: "connection" | "user" | "system";
  id: string;            // ConnectionId、用户 ID，或 "system"
  name: string;          // 连接实例名（"MacBook · Claude Code"）、用户名，或 "system"
}
```

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
  detail?: "concise" | "detailed"; // 默认 concise
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

op 上与证据有关的三个字段（定义在 `WriteOp`、`ResolveParams`）：

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
  disputed?: Array<{ item: ItemId; fields: Array<FieldName | "*">; valid?: Interval }>;   // "*" = 争议的是这一行 / 这段是否存在
  /** 有提议尚未生效；给出的是当前值。 */
  awaiting?: Array<{ item: ItemId; fields: Array<FieldName | "*">; valid?: Interval; proposed?: Values | null; proposed_revert?: { undo: Seq } }>;  // proposed: null = 提议撤销；提议是一次回退时不给 proposed，给 proposed_revert
  /** 值已生效，只是被标记。 */
  flagged?: Array<{ item: ItemId; reason: FlaggedReason; related?: TargetRef }>;
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
  /** 派生行是读时算出的（规则依赖"现在"，或读状态类表而不带业务时间限定）：值随读取时刻而定，这一行不带 ver。 */
  computed_at_read?: true;
  stale?: { job: JobId };                        // @later
  pending_extraction?: { fields: FieldName[] };  // @later
}

type FlaggedReason  = "duplicate_keys";
type AffectedReason = "correct" | "revoke" | "retroactive" | "plan_changed" | "applied_by_rule" /* @later */;

/** 派生行没有自己的标记，带输入上的汇总：只统计规则所依赖的字段上有标记的基础行。 */
interface InputMarks {
  disputed: number;
  awaiting: number;
  flagged: number;
  items: ItemId[];       // 最多 10 个
}
```

---

## 4. 读操作

### 4.1 读结果里的一行

```ts
interface Row extends TargetRef {
  ver: Ver | HistoricalVer;      // 派生行也有：最近一次改动它的值的操作号；不能用于写入
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
}
```

### 4.2 `catalog`

```ts
interface CatalogParams extends CommonParams {
  /** list（默认）：slot 与表的清单。table：某几张表的字段与概况。schema：某个 slot 的完整 schema 文档。 */
  level?: "list" | "table" | "schema";
  slot?: SlotName;               // list：只看这个 slot。schema：必填
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
    tables: Array<{ table: TableName; kind: "base" | "derived"; description: UntrustedText }>;
  }>;
}

interface CatalogTables extends CommonResult {
  level: "table";
  tables: Array<{
    table: TableName; slot: SlotName; sv: Sv; timezone: string;
    kind: "base" | "derived";
    description: UntrustedText;
    time: { type: "none" } | { type: "event"; field: FieldName } | { type: "state"; granularity: "date" | "instant" };
    entity_key?: FieldName[];
    duplicate_keys?: FieldName[][];
    together?: FieldName[][];                    // 字段组：同组字段作为一个冲突单元
    fields: Array<{
      name: FieldName; type: FieldType; description: UntrustedText;
      required?: true; unit?: string; min?: string; max?: string; values?: string[];
      ref?: { table: TableName; target: "row" | "entity" };
      examples?: UntrustedText[];                // 最近 K 个不同取值
    }>;
    rule?: { id: string; version: number; sql: UntrustedText; time_dependency: "none" | "bucketed" | "now"; depends_on: string[] };
    profile: { rows: number; time_range?: { from: BizTime; to: BizTime } };
    described_by?: { actor: Actor; sv: Sv };     // 说明是谁、在哪一版写的
  }>;
}

type FieldType = "text" | "integer" | "decimal" | "boolean" | "enum" | "date" | "zoned_datetime" | "quantity" | "ref";

interface CatalogSchema extends CommonResult {
  level: "schema";
  slot: SlotName; sv: Sv;
  document: SchemaDocument;      // ID 与 base_version 已填好，改完可直接交给 schema_draft
  policy: SlotPolicy;            // 只读，8.2
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
  /** "今天"取哪一刻（依赖"今天"的派生值）。不传取入口时刻。 */
  at?: Instant;
  include_revoked?: boolean;     // 默认 false
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
  /** 单条 SELECT。表与字段用名字；状态类表可用 FOR VALID_TIME AS OF … / FROM … TO …；不能用 NOW()。 */
  sql: string;
  /** 位置参数 $1, $2… 的值：字符串、数字、布尔、null。带单位的量传该列声明单位下的十进制字符串。 */
  params?: Array<string | number | boolean | null>;
  max_rows?: number;             // 每页行数。默认 100，上限 1,000
  at?: Instant;
  cursor?: Cursor;               // MCP 不暴露
}

interface SqlResult extends CommonResult {
  sv: Record<SlotName, Sv>;      // 查询涉及的每个 slot
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
  "marks_summary": { "disputed": 1, "awaiting": 0, "flagged": 0, "items": ["pi_7C2E…"] }
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
}

interface ChangesParams extends CommonParams, PageParams {
  mode: "changes";
  table: TableName;
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
  /** 当前版本。只有它能用于写入；返回它算一次逐行读。 */
  ver: Ver;
  entries: TimelineEntry[];      // 新的在前
  /** 读过各版本的读取（任何连接实例的）。不给查询条件。 */
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
  as_of: { seq: Seq; recorded_at: Instant };
  sv: Sv;                        // 当时的 schema 版本，值按它解释
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
  "mode": "timeline", "target": { "table": "ledger.expenses", "row": "r_01JC8Z…" }, "sv": 1, "ver": "v25.0", "total": 2,
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

type TombstoneReason = "expiry" | "restore_backfill";
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
  kind: "privacy" | "evidence";
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
  /** 本机模式：到期时若 saveslot 没在运行，物理删除在下次启动时执行。 */
  local_deferred?: true;
  reextract?: Array<{ target: TargetRef; fields: FieldName[] }>;   // @later
  cleared?: Array<{ target: TargetRef; fields: FieldName[] }>;     // @later
  collateral_rows?: TargetRef[];                                   // @later
}

interface DeletionRowResult {
  target: TargetRef;
  result: "deleted" | "kept_fields_cleared" | "fields_reverted" | "resegmented";
  /** 删除后的样子。deleted 时不给。事件类表给 values；状态类表给 spans。 */
  after?: { values?: Values; spans?: Span[] };
  cleared?: FieldName[];             // kept_fields_cleared：变空的字段
  /** fields_reverted：每个回到更早值的字段。 */
  /** from_seq 与 schema_const 必有其一：回到的是哪次写入的值，或回到的是 schema 第 sv 版切换时常量 backfill 的补值（没有写入可指）。 */
  reverted_to?: Record<FieldName, { value: Value; from_seq?: Seq; schema_const?: { sv: Sv }; valid?: Interval; reason: "later_write_removed" | "revert_source_removed" }>;
  /** 依据：每个必填字段还剩哪些写入的贡献（空数组 = 没有了）。 */
  basis?: Record<FieldName, Seq[]>;
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
  /** 当前凭证可用的处理方式。已关闭的事项为空。 */
  decisions: Decision[];
  /** 需要用户会话才能用的处理方式（slot 策略指定时）。@later */
  user_session_only?: Decision[];
  resolution?: { decision: Decision; seq: Seq; at: Instant; actor: Actor; note?: UntrustedText };   // status: resolved
  superseded?: { reason: SupersededReason; by?: Seq; at: Instant };                                 // status: superseded
}

/** 事项的目标。unit = 冲突单元里的字段；["*"] = 这一行 / 这段是否存在。 */
interface ItemTarget extends TargetRef { unit?: Array<FieldName | "*">; valid?: Interval }

type ItemReason =
  | "overwrites_change_point"       // awaiting_confirmation：抹掉已记录的变化点（含跨空洞填值）
  | "referenced_row"                // awaiting_confirmation：撤销仍被引用的行
  | "undo_includes_later"           // awaiting_confirmation：undo 连后来的写入一起回掉
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
  current: { values?: Values; spans?: Span[] };
  impact: AwaitingImpact;
}

/** 执行后会改掉什么。在事项版本的绑定范围内。 */
interface AwaitingImpact {
  overwritten?: Array<{ field: FieldName; valid: Interval; value: Value; seq: Seq; actor: Actor }>;   // 会被覆盖的段（含会被填掉的无值区间：value 为 null）
  filled_gaps?: Array<{ valid: Interval; revoked_by?: Seq }>;                                          // 会被填掉的空洞
  reverted?: Array<{ seq: Seq; actor: Actor; fields: FieldName[] }>;                                   // 会被回掉的后来写入
  referrers?: TargetRef[];                                                                             // 仍引用该行的行
}

interface FlaggedDetail extends ItemBase {
  type: "flagged";
  target: ItemTarget;
  /** 疑似与它重复的行：最多 10 个，按最近写入排。 */
  related: TargetRef[];
  /** 命中的那一组 duplicate_keys 与键值。 */
  keys: FieldName[];
  matched?: Values;
}

interface ConflictDetail extends ItemBase {
  type: "conflict";
  target: ItemTarget;
  effective: { seq: Seq; actor: Actor; values?: Values; spans?: Span[]; exists: boolean };
  candidates: Candidate[];
  /** 成因是 restored_candidate 时：候选原来所在的那个事项。 */
  related_item?: ItemId;
  /** take_previous 会回到的样子：合并基（各候选所带 ver 中最早的那个版本）上的值。 */
  previous: { seq: Seq; exists: boolean; values?: Values; spans?: Span[] };
  /** take_previous 会回掉的写入：合并基之后在这个冲突单元上生效过的全部写入。 */
  reverted_by_previous: Array<{ seq: Seq; actor: Actor }>;
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
  kind: "privacy" | "evidence";
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
  "reverted_by_previous": [{ "seq": 33, "actor": { "kind": "connection", "id": "ci_01B…", "name": "MacBook · Codex" } }]
}
```

---

## 5. 写操作

### 5.1 `write`

```ts
type Intent = "insert" | "update" | "correct" | "revoke" | "applied_by_rule" /* 只出现在结果里；@later */;

/** 历史里一个版本的意图：写入的意图，或由删除产生的版本的两个取值（与事件格式 6.2 同名）。 */
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
  /** 给新插入的行起临时名（"p1"），同一请求里的 ref 写 "@p1"。 */
  as?: string;
  /** 读这一行 / 实体时拿到的版本。update / correct / revoke 应带回；没带时兜底；本请求里新建的行 / 实体不需要。带 revert: {undo} 时可以不带：undo 不做版本冲突判定。 */
  ver?: Ver;
  /** 字段名 → 值。值写 null 是清空一个可选字段。与 revert 互斥；revoke 不带。 */
  set?: Values;
  /** 代替 set。 */
  revert?: { undo: Seq; include_later?: boolean } | { to: Seq; fields: FieldName[] } /* @later */;
  /** 只用于状态类表。起点，含。不传 = 现在（correct 且两端都没传时见 04-contract 第 5 节）。 */
  valid_from?: BizTime;
  /** 只用于状态类表。终点，不含。日期 / 时刻；"next_change"（默认：管到下一个已记录的变化）；"open"（一直延续）。 */
  valid_to?: BizTime | "next_change" | "open";
  /** ["overwrite"]：已与用户确认覆盖类的高影响，直接生效。只在这个 op 显式带了当前 ver 时有效。MCP 不暴露。 */
  acknowledge?: Array<"overwrite">;
}

interface WriteResult extends CommonResult {
  /** saved：全部字段已生效（生成了 flagged 事项时也是）。pending：有字段成了候选或进了待确认。 */
  status: "saved" | "pending" | "job" /* @later */;
  sv: Sv;
  seq: Seq;                      // 这次写入的写入号
  ops: OpResult[];               // 与请求的 ops 一一对应
  derived: DerivedChange[];      // 最多 20 条
  derived_total: number;
  pending: PendingRef[];
  superseded: Array<{ item: ItemId; type: ItemType }>;
  affected_reads?: AffectedReads;
  /** 命中请求键的重发：没有新写入，回执按日志重建。此时 pending[] 给的是事项的当前状态、不带 item_ver；回执里的 ver 与事项都不算读到。 */
  replayed?: true;
  /** 回执里省略的部分。两种情形会出现：
   *  replayed：按日志重建不出的——affected_reads；derived_values（派生值的改前改后值）；before_values（改前值所出自的贡献已被删除）；
   *    noop_segments（状态类表上无操作段的区间与解析结果，日志里只留字段名）；skipped_spans（undo 跳过的部分的区间）；
   *    deleted_content（这次写入自己的内容已被删除的部分）。
   *  回执超出外化面的结果预算：写入已生效，不报错，截短并列明——field_results、derived_values、affected_reads、lists（各列表的后几条）。
   *  调用方需要时自己读（history / query）。 */
  omitted?: Array<"affected_reads" | "derived_values" | "before_values" | "noop_segments" | "skipped_spans" | "deleted_content" | "field_results" | "lists">;
  original_deleted?: { deletion: ItemId };   // 重放命中的原写入已被删除：没有重新写入，不回显内容
  job?: JobId;                   // @later
}

interface OpResult {
  target: TargetRef;
  as?: string;                   // 临时名
  intent: Intent;
  /** 有字段生效时是新 ver；全部没生效或同值时是原 ver。 */
  ver: Ver;
  created_entity?: true;
  existing_keys?: UntrustedText[];           // created_entity 时：该表已有的实体键，最多 10 个
  /** 逐字段结果。revoke、以及目标是"存在"时键为 "*"。undo 时被跳过的部分不在这里，在 undo.skipped_superseded。
   *  事件类表、无时间表：每个字段一个结果。
   *  状态类表：每个字段是按区间排好的数组，每段各有结果与区间（通常只有一段；多段的情形：undo / take_previous 写回几段不同的旧值，
   *  佐证的区间里一部分仍同值、一部分已被别人改掉）。 */
  fields: Record<FieldName | "*", FieldResult | Array<FieldResult & { valid: Interval }>>;
  /** 状态类表：每个字段解析出的区间。一个字段有几项时是它们的整体范围，逐项的区间在 fields 的数组里。 */
  resolved?: Record<FieldName | "*", ResolvedInterval>;
  undo?: {
    of: Seq;
    skipped_superseded: Array<{ field: FieldName; valid?: Interval; by: Seq; actor: Actor }>;   // 幂等重放的回执里没有 valid（日志不记跳过的区间），omitted 含 "skipped_spans"
    reverted_later?: Array<{ seq: Seq; actor: Actor; fields: FieldName[] }>;
  };
}

/** 字段生效状态。前五个与事件格式的 status 同名同义。 */
type FieldResultCode = "applied" | "candidate" | "awaiting" | "corroborated" | "noop" | "applied_by_rule" /* @later */;

/** timeline 里一项贡献的结果码。比写入回执多一个 dropped：这一项经一次隐私删除的重放后不再是贡献
 *  （与前面的值相同而当初没指证据；它回掉的那次写入已不在；或它的区间并进了同一字段的另一项）。只出现在 timeline。 */
type TimelineResultCode = FieldResultCode | "dropped";

type FieldResult =
  | { result: "applied"; before: Value | undefined;
      after: Value | undefined;  // 回退写回"没有值"（no_value）或只让被回掉的写入不再生效（uncovered）时不给
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
      by: { seq: Seq; actor: Actor };            // 是谁的哪次写入改过它
      previous: ConflictDetail["previous"];
      impact?: AwaitingImpact }                  // 候选若生效会属高影响时
  | { result: "awaiting"; item: ItemId; impact: AwaitingImpact }
  | { result: "applied_by_rule"; item: ItemId; before: Value; after: Value };   // @later

interface ResolvedInterval extends Interval {
  /** 调用方是怎么给起点、终点的（与事件格式的 mode 同名）。corrected_span = correct 且两端都没传：包含"现在"、以挡点为界的那一段。 */
  from_as: "given" | "now" | "corrected_span";
  to_as: "given" | "next_change" | "open" | "corrected_span";
  /** to_as: next_change 且终点不是"一直延续"时：终点处开始的那一段，没有改动。 */
  next_change?: { at: BizTime; value: Value | null };
  /** 这次写入填上的无值区间。 */
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
  refreshed?: true;              // 本次写入改到了一个没读过的未决事项的目标：事项已刷新、保持未决
  /** 只在 replayed 的回执里给：事项现在的状态；已解决的附处理方式。 */
  state?: "open" | "resolved" | "superseded";
  decision?: Decision;
}

interface AffectedReads {
  count: number;                 // 不含本次写入所依据的那次读取
  by_reason: Partial<Record<AffectedReason, number>>;
  covered_since: Instant;        // 读取记录保留到哪一刻：更早的读取不在统计内
  /** count 里只能算"可能受影响"的读取数：按表级记录或版本集合匹配到的（data-model「纠错影响查询」）。没有时不给。 */
  possible?: number;
  not_covered?: Array<"derived_reads">;
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
interface ResolveParams extends WriteCommonParams, EvidenceOnOp {
  id: ItemId;
  decision: Decision;
  /** 读到的事项版本。没带时兜底；deletion 的 cancel 不用带。 */
  item_ver?: ItemVer;
  /** 只用于 conflict 的 take_candidate：采纳哪一个候选（它的下标 index）。只有一个候选时可省略。 */
  candidate?: number;
  /** 备注。带了 note 时，解决请求本身存为一条 api_call 源数据（不论是否触发写入、是否另带了证据），
   *  解决事件以操作来源引用它；事项详情的 resolution.note 从它回显。它经普通的隐私删除（删这条源数据）清除。 */
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
  write?: Pick<WriteResult, "seq" | "sv" | "ops" | "derived" | "derived_total" | "pending" | "superseded" | "affected_reads">;
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
  };
  replayed?: true;
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
}

interface SchemaChange {
  target: { slot: true } | { table: TableName; field?: FieldName; rule?: true };
  /** 具体是哪一种改动（见下表）。 */
  change: SchemaChangeCode;
  /** 类别：create 新建 slot / 表；metadata 只改元数据；deterministic 确定性转换；reextract 重新抽取 @later。
   *  事件格式 schema.compiled 的 changes 与本类型逐键相同，只是 target 里用 ID 不用名字。类别不决定要不要建新物理表：那看物理形状变没变（migration 字段）。 */
  class: "create" | "metadata" | "deterministic" | "reextract";
  /** 带旧 sv、写到这个字段的写入是否还被接受。 */
  compatible_with_old_writes: boolean;
  destructive: boolean;          // 会丢数据（删字段、收紧约束后置空等）
  auto: boolean;                 // 按 slot 策略可自动生效（这一项改动所属的类别在 auto_apply 里）
}

type SchemaChangeCode =
  // slot
  | "create_slot" | "rename_slot" | "change_timezone"
  // 表
  | "add_table" | "add_derived_table" | "drop_table" | "rename_table"
  | "change_duplicate_keys" | "change_together" | "change_time_field"
  // 基础表的字段
  | "add_optional_field" | "add_required_field" | "drop_field" | "rename_field"
  | "loosen_constraint" | "tighten_constraint" | "change_precision"
  | "change_unit" | "change_dimension" | "change_type"
  // 派生表
  | "change_rule"
  // 表、字段、派生字段的说明
  | "change_description"
  // @later：草稿里出现时整份报 not_in_this_version，不会出现在第一版的结果里
  | "reextract" | "change_entity_key" | "change_granularity" | "change_time_type" | "change_table_kind" | "change_ref";

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
| `change_description` | `metadata` | `description` |
| `change_duplicate_keys` | `metadata` | `duplicate_keys` |
| `change_together`、`change_time_field` | `metadata` | — |
| `add_optional_field` | `metadata` | `add_optional_field` |
| `add_required_field` | `deterministic` | — |
| `drop_field` | `metadata` | — |
| `loosen_constraint`（必填改可选、放宽 `min` / `max`、枚举加值、加大 `scale`） | `metadata` | `loosen_constraint` |
| `tighten_constraint`（可选改必填、收紧 `min` / `max`、删枚举值） | `deterministic` | — |
| `change_precision`（减小 `scale`、改 `rounding`） | `deterministic` | — |
| `change_unit`（同量纲） | `deterministic` | — |
| `change_dimension`、`change_type` | `deterministic` | — |
| `change_rule`（含 `time_dependency`） | `deterministic` | — |

"—"表示一律要确认。一份草稿的 `outcome` 是 `applied`，当且仅当它的每一项改动都 `auto: true`（新建 slot 总是）。

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
  kind: "privacy" | "evidence";
  totals: { sources: number; rows: number; derived: number };
  rows: Array<DeletionRowResult & { ver?: Ver }>;    // 仍存在的行 / 实体带新 ver。最多 200 条，另给 rows_total
  rows_total: number;
  now_effective: DeletionPreviewResult["now_effective"];
  now_awaiting: Array<{ seq: Seq; target: TargetRef; item: { id: ItemId; item_ver: ItemVer }; impact: AwaitingImpact }>;
  superseded: DeletionPreviewResult["superseded"];
  derived: DerivedChange[];
  derived_total: number;
  states: DeletionState[];
  /** 删除后仍保留的元数据。 */
  retained_metadata: Array<"event_headers" | "row_existence" | "actors_and_intents">;
  not_deleted: DeletionPreviewResult["not_deleted"];
  replayed?: true;
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
  "now_effective": [], "now_awaiting": [], "superseded": [],
  "derived": [{ "table": "ledger.monthly_total", "key": { "month": "2026-11-01" }, "field": "total",
    "before": { "value": "89", "unit": "CNY" }, "after": { "value": "80", "unit": "CNY" } }],
  "derived_total": 1,
  "states": [
    { "place": "store", "state": "logically_deleted", "since": "2026-11-11T09:12:30+08:00",
      "due": "2026-11-12T09:12:30+08:00", "deferred_to_next_start": true },
    { "place": "backups", "state": "retained", "since": "2026-11-11T09:12:30+08:00", "managed": false }
  ],
  "retained_metadata": ["event_headers", "row_existence", "actors_and_intents"],
  "not_deleted": [{ "kind": "retained_metadata" }]
}
```

---

## 6. 抽取作业（`@later`）

`extract_claim` 与 `extract_submit` 不进第一版。请求与结果的形状见 [`04-contract.md`](04-contract.md) 第 10 节里的 JSON；进入实现时在本文补类型。

---

## 7. 提醒与提示

```ts
/** 与本次调用的某个部分有关的结构化提醒。op = ops 的下标。 */
type Warning =
  | { code: "unit_converted"; op: number; field: FieldName; from: Quantity; to: Quantity }
  | { code: "rounded"; op: number; field: FieldName; from: string; to: string; scale: number }          // 小数位数超过字段的 scale，已按 rounding 舍入
  | { code: "timezone_assumed"; op?: number; field?: FieldName; param?: string; timezone: string }   // 时刻没带时区，按 slot 时区
  | { code: "time_truncated"; op?: number; param: string; from: Instant; to: DateStr }               // 按日的表收到时刻，取了所在日
  | { code: "ver_fallback"; op: number; ver: Ver; read: ReadId }
  | { code: "sv_fallback"; sv: Sv; read: ReadId }
  | { code: "item_ver_fallback"; item_ver: ItemVer; read?: ReadId }
  | { code: "renamed"; op?: number; table?: TableName; from: string; to: string }                    // 用了旧名
  | { code: "multi_segment_unmapped"; op: number; fields: FieldName[] }                              // 多段证据没给字段映射
  | { code: "evidence_unreferenced"; evidence: number[] }                                             // 请求级证据段没被任何 op 引用：照存为源数据，但不是任何值的来源
  | { code: "overwrote_corroborated"; op: number; field: FieldName; valid: Interval; sources: SourceId[] }
  | { code: "pending_deletion_on_target"; op?: number; item: ItemId }                                // 目标有一项可撤回的删除
  | { code: "clock_behind_log"; behind_seconds: number }                                             // 入口时刻早于日志末端的记录时刻
  | { code: "job_items_appended"; op: number; job: JobId };                                          // @later

/** 与本次调用相关的提示，最多 3 条。 */
type Notice =
  | { code: "pending_items"; slot: SlotName; count: number; oldest_opened_at: Instant }
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
  /** 建议写成"设备 · Agent"。同一用户下不重名。 */
  name: string;
  /** 必须包含 saveslot.read。默认 ["saveslot.read", "saveslot.write"]。 */
  scopes?: Scope[];
}

interface Connection {
  id: ConnectionId; name: string; scopes: Scope[];
  via: "token" | "oauth";        // 本地令牌 / 静态令牌，或一次 OAuth 授权
  client?: string;               // via: oauth 时的客户端标识
  created_at: Instant; last_used_at?: Instant;
  revoked_at?: Instant;
}

interface ConnectionsIssueResult extends Connection {
  /** 只返回这一次；saveslot 只存它的哈希。 */
  token: string;
}

interface ConnectionsListParams { include_revoked?: boolean; limit?: number; cursor?: Cursor }
interface ConnectionsListResult extends PageResult { connections: Connection[] }

interface ConnectionsUpdateParams { id: ConnectionId; name: string }   // 只能改名
interface ConnectionsRevokeParams { id: ConnectionId }
type ConnectionsUpdateResult = Connection;
type ConnectionsRevokeResult = Connection;                             // revoked_at 已填；重复吊销返回同一结果
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
  version: number;               // 策略版本：每次变更加 1
  /** 冲突期间的生效值规则。第一版只有 keep_current。 */
  effective_value_rule: "keep_current" | "by_rank" /* @later */;
  /** 来源级别的秩表。第一版只记不用。 */
  rank: { user_stated: number; agent_inferred: number; miss: number };
  /** 哪些 schema 改动不经确认直接生效。 */
  auto_apply: Array<"add_table" | "add_derived_table" | "add_optional_field" | "description"
                    | "rename_unused" | "loosen_constraint" | "duplicate_keys">;   // 默认策略七个全开
  /** 额外算高影响的表 / 字段。@later */
  high_impact?: Array<{ table: TableName; fields?: FieldName[] }>;
  /** 只接受用户会话确认的处理。@later */
  user_session_only?: Array<{ type: ItemType; decision: Decision }>;
  set_by: Actor; set_at: Instant; seq: Seq;
}

interface PolicySetParams extends Omit<SlotPolicy, "version" | "set_by" | "set_at" | "seq"> {}   // @later
```

### 8.3 `reads.list`

```ts
interface ReadsListParams extends PageParams {
  connection?: ConnectionId | string;   // ID 或名字
  slot?: SlotName; table?: TableName;
  task?: string;
  since?: Instant; until?: Instant;
}

interface ReadsListResult extends PageResult {
  /** 读取记录保留到哪一刻。 */
  covered_since: Instant;
  reads: Array<{
    read: ReadId; at: Instant; actor: Actor; task?: string;
    operation: "query" | "sql" | "history" | "sources" | "catalog" | "pending" | "deletion_preview";
    selfcheck?: true;            // 签发连接实例时的自检
    slot: SlotName; sv: Sv; table?: TableName;
    /** 读到的行与版本。只给版本，不给值。最多 50 条，另给总数。 */
    rows?: Array<{ target: TargetRef; seq: Seq }>;
    rows_total?: number;
    /** 读到的行太多、改记成表级记录的表（data-model「读取记录」）：只有表与读取时的日志位置，没有逐行的版本。 */
    coarse?: Array<{ table: TableName; pos: Seq }>;
    valid?: { at?: BizTime; during?: [BizTime, BizTime | null] };   // 问的业务时间
    source?: SourceId;           // 读的是源数据原文
  }>;
}
```

### 8.4 `log.verify` / `log.reconcile` / `export`

```ts
interface LogVerifyResult {
  events: number;
  chain: { intact: true } | { intact: false; broken_at: number /* 事件的 seq */ };
  checksum_mismatch: Array<{ seq: number; path: string }>;   // 内容块的位置；不含内容
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

## 9. 错误

```ts
interface ErrorEnvelope { error: ErrorObject }

interface ErrorObject {
  code: ErrorCode;
  /** 细分原因。取值见下表。 */
  reason?: string;
  /** 出问题的参数：JSON 指针式的路径，如 "ops/0/valid_to"。 */
  param?: string;
  /** 校验类错误的逐条明细。 */
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
  allowed_units?: string[]; allowed_values?: string[]; min?: string; max?: string;
  rows?: number; samples?: TargetRef[];   // backfill_required：违反的行数与样例
  referenced_by?: string[];      // still_referenced：依赖它的对象在 schema 文档里的位置（同 path 的写法）
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
  | "not_in_this_version" | "unavailable" | "internal";

type ValidationDetailCode =
  // 写入
  | "type_mismatch" | "unit_missing" | "unit_unknown" | "unit_dimension" | "out_of_range"
  | "enum_value" | "required_missing" | "required_in_gap" | "ref_not_found" | "ref_wrong_table"
  // schema 编译
  | "reserved_name" | "duplicate_name" | "description_missing" | "unknown_type"
  | "entity_key_not_required" | "cross_slot_ref"
  | "rule_sql_rejected" | "nondeterministic_function" | "unit_inference_failed"
  | "backfill_required" | "migrate_failed" | "untrusted_marker"
  | "backfill_const_required"       // 新增必填字段、或把可选改成必填：一律必须给常量形式的 backfill（不看表里有没有行）
  | "backfill_both_forms"           // backfill 的常量形式与表达式形式同时给了
  | "still_referenced";              // 要删的表或字段仍被依赖（ref、规则、entity_key、time.field、duplicate_keys、together）
```

每个错误码的附带字段：

| `code` | `reason` | 其余附带字段 |
|---|---|---|
| `invalid_argument` | `missing` / `malformed` / `ambiguous_table` / `mode_mismatch` / `mutually_exclusive` / `not_this_target` / `content_deleted` / `undo_target` / `event_table_valid_at` / `no_value_now`（状态类表上不带区间的纠错，"现在"那一点该字段无值）/ `cross_slot_sources` / `no_time_table` / `not_state_table` / `granularity` / `key_field_changed` / `insert_with_entity_key` / `candidate_required` / `pending_deletion_source` / `cross_slot` / `idempotency_key_reuse` / `index_out_of_range` / `empty_mapping` / `operator_type` / `missing_read_scope` | `param`；`candidates?: string[]`；`example?: object`（该模式或该参数完整的正确示例） |
| `unknown_table` / `unknown_field` | — | `name`、`nearest: string[]` |
| `not_found` | `row` / `entity` / `item` / `source` / `draft` / `connection` / `read` | `deletion?: ItemId`（被宽限期内的删除去掉时；不回显内容）；`sources?: Array<{id, state: "unknown" \| "pending_deletion" \| "removed", deletion?}>` |
| `revoked` | — | `target: TargetRef`、`revoked_by: Seq`（用 `revert: {undo}` 恢复） |
| `derived_readonly` | — | `table`、`base_tables: TableName[]` |
| `validation_failed` | `write` / `schema` | `details[]`、`current_sv?` |
| `read_first` | `no_read` / `task_mismatch` | `target: "row" \| "item" \| "slot" \| "table"`、`ref?: TargetRef \| ItemId \| SlotName`；`task_mismatch` 时 `read_task`、`task` |
| `schema_incompatible` | — | `current_sv`、`changed_fields: Array<{field, change}>` |
| `too_large` | `evidence_segment` / `request` / `admission` / `result_budget` | `limit_bytes?`、`actual_bytes?`；`admission` 时 `estimated_rows`、`suggested_batch`；`result_budget` 时 `narrow_by: string[]`。四种原因都发生在落账之前；已经落账的操作回执超预算时不报错，截短并带 `omitted[]` |
| `sql_rejected` | `not_select` / `function` / `node` / `system_time` / `unknown_name` | `line`、`node`（不暴露物理名）、`use?: "history"` |
| `sql_timeout` | — | `elapsed_ms` |
| `draft_outdated` | `base_version` / `migrating` | `current_sv`；`migrating` 时 `migration: MigrationStatus` |
| `field_unmatched` | — | `fields: Array<{table, id, name}>` |
| `confirmation_mismatch` | `changed` / `restored` | `current: ItemDetail`（含新的 `item_ver`） |
| `item_closed` | `resolved` / `superseded` / `expired` | `resolution?` / `superseded?`（形状同事项详情） |
| `preview_outdated` | — | `preview: DeletionPreviewResult`（含新的 `dc_`） |
| `unauthenticated` | `missing` / `invalid` / `revoked` / `expired` | — |
| `insufficient_scope` | — | `required_scope: Scope \| "user_session"` |
| `rate_limited` | `quota` / `busy` | `retry_after` |
| `handle_expired` | `expired` / `restored` / `executed` | `deletion?: ItemId`（已执行过的 `dc_`） |
| `not_in_this_version` | `parameter` / `value` / `operation` | `param?`、`value?`、`operation?` |
| `unavailable` | `busy` / `restoring` / `reconciling` / `starting` | `retry_after?` |
| `internal` | — | `incident: string`（供排查的编号，不含内容） |
| `referenced`（`@later`） | — | `referrers`、`alternatives` |
| `lease_expired`（`@later`） | `expired` / `migration_abandoned` / `migration_switched` | — |

哪些操作会返回哪些错误码：

| 操作 | 除通用错误外可能返回 |
|---|---|
| 通用（所有操作） | `invalid_argument`、`unauthenticated`、`insufficient_scope`、`rate_limited`、`not_in_this_version`、`unavailable`、`internal` |
| `catalog` | `unknown_table`、`not_found`、`too_large`（`result_budget`） |
| `query` | `unknown_table`、`unknown_field`、`handle_expired` |
| `sql` | `sql_rejected`、`sql_timeout`、`handle_expired` |
| `history` | `unknown_table`、`not_found`、`read_first`、`handle_expired` |
| `sources` | `not_found`、`handle_expired` |
| `deletion_preview` | `not_found`、`handle_expired`、`preview_outdated` |
| `pending` | `not_found`、`handle_expired` |
| `write` | `unknown_table`、`unknown_field`、`not_found`、`revoked`、`derived_readonly`、`validation_failed`、`read_first`、`schema_incompatible`、`too_large` |
| `resolve` | `not_found`、`item_closed`、`confirmation_mismatch`、`read_first`，以及触发的写入可能返回的 |
| `schema_draft` | `validation_failed`、`draft_outdated`、`field_unmatched`、`too_large` |
| `delete` | `handle_expired`、`preview_outdated` |
| `connections.*` | `not_found` |
| `log.reconcile` | `rate_limited`（`busy`：同一租户已有一次在跑） |
