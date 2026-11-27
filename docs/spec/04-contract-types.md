# saveslot · Type definitions of the operation contract

> Translated from docs/zh-CN/spec/04-contract-types.md, updated in the same commit as this file.
> The Chinese edition is authoritative; where the two differ, the Chinese one holds.

> This document is the **structure** of the operation contract: the parameters, results, errors and all enumerations of every operation, written as TypeScript types. The rules and explanations (what is returned when, and why) are in [`04-contract.md`](04-contract.md); the kernel rules are in [`03-data-model/`](03-data-model/README.md); how MCP and HTTP carry the contract is in [`05-surfaces.md`](05-surfaces.md).
> **Field names, nested structures and enumeration values are defined by this document.** The two packages `contract-core` / `contract` in the implementation correspond to it item by item; OpenAPI is generated from them, and the MCP `inputSchema` is composed from the types in this file by the mapping table in section 1 of [`05-surfaces.md`](05-surfaces.md). The `description` of an MCP parameter is wording written for the model, and its original text is in [`05-surfaces.md`](05-surfaces.md) 9.1; the comments on parameters in this document describe types and constraints.

## 0. Conventions

### 0.1 Notation

- Types are written in TypeScript and express shape only; `?` marks an optional field. Constraints such as "required" and "mutually exclusive" in comments are checked by the server, and a violation reports `invalid_argument` (unless stated otherwise).
- **Belonging to `contract-core` (a kernel dependency)**: the common types in sections 1 to 3, the data part of each operation's result, and the domain errors in section 9. **Belonging to `contract` (the outer wrapping)**: `task`, `idempotency_key`, `limit` / `cursor`, `detail`, handles, `notices`, `replayed`, `truncated`, the outer errors in section 9, and the administrative operations in section 8.
- **Identifiers in examples** are written as "prefix + the first few characters + `…`"; `s_1` and `s_2` are shorthand labels for the two sources in the examples that run through the documents. The length and character set of real identifiers are in "How identifiers are written" in the data model.
- **Enumerations only grow**: adding an optional field, an error code or an enumeration value raises the minor version of the contract, and callers must tolerate unknown fields and enumeration values (the architecture document §6).
- **Uniform key names**:

  | Meaning | Key name |
  |---|---|
  | Operation number (see 1.2) | `seq` |
  | Recorded time | At the top level of a result: `recorded_at`; inside a nested object that describes an event that has happened (`resolution`, `superseded`, `reads[]`, `removed`): `at` |
  | Who did it | `actor` |
  | Kind of an object | `type` (items), `kind` (evidence, sources, deletion); for schema changes, `change` (the change code) and `class` (the class) |
  | Code | `code` (errors, warnings, hints, validation details), `reason` (the reason code: why an item arose or was superseded, the cause of a flag, a refinement of an error); the origin of a candidate uses `cause` (the same name as in the event format) |
  | Pending item | `item` (the ID only) or `{id, item_ver}` |

### 0.2 Not implemented in the first version

This document writes out the complete design. Parameters, values and operations that the first version does not implement are all marked `@later`. **Calling anything the first version does not implement always reports `not_in_this_version`** (section 9), and the schema generated for the first version does not contain them. The table below lists what the first version does not implement; 0.1.0 has further parts that are not provided yet, listed after the table.

| Where | What the first version does not implement |
|---|---|
| `write` | `mode: "job"` and jobs (`status: "job"`, `job`, a single op that exceeds the threshold being turned into a job automatically); `revert: {to, fields}`; the per-field result `applied_by_rule`; the intent `applied_by_rule` |
| `write` (MCP) | the op-level `acknowledge`; the `level` of an evidence segment (open on HTTP) |
| Evidence | the source level `external_authority` |
| `history` | `mode: "composition"` |
| `sources` | full-text search in `mode: "search"` (the first version does substring matching, with the same parameters) |
| `deletion_preview` / `delete` | `kind: "evidence"`, `rows`; `reextract`, `cleared`, `collateral_rows` in the result |
| `pending` / `resolve` | the item type `migration_diff` and its decisions; jobs (`jb_…`); the supersession reasons `evidence_deleted`, `migration_failed`; the candidate origin `displaced_by_rule` |
| `schema_draft` | the change class `reextract`; `reextract` on a field; `extends`, `compatibility`; `derived` changed to `base`; **on a table that has been written to**: a change of the time type of the table, adding, removing or changing `entity_key`, changing `granularity`, `base` changed to `derived`, converting `ref` to or from other types, changing the target of a `ref`, replacing the set of external keys (`change_external_key`), changing the type of an external key field or tightening its constraints, changing a type (`change_type`), replacing a dimension (`change_dimension`) (the corresponding change codes are in 5.3; `reason` is `table_written`); `migrate` on a field, and `backfill` in expression form (the constant form is carried out; `reason` is `parameter`, and `param` points to that key); a `migrate` / `backfill` expression that references fields other than its own field; a derivation rule whose outermost operation is not an aggregate, and sandbox function rules. When one appears in a draft, the whole draft reports `not_in_this_version` |
| Flags | `stale`, `pending_extraction`; `applied_by_rule` of `possibly_affected` |
| Warnings | `job_items_appended` |
| Hints | `job_failed` |
| Operations | `extract_claim`, `extract_submit`, `policy.set` |
| Errors | `lease_expired`, `referenced` |
| Slot policy | arbitration by source level during a conflict (the first version has only `keep_current`); extra high-impact tables / fields; the switch "a kind of handling accepts confirmation only from a user session" |
| Profile | In the first version the table profile of `catalog` has only the row count and the valid-time range, the size hint `scale`, and the most recent K distinct values of each field; there is no "time of the most recent write". The `table` level carries `profile` (row count, valid-time range, size hint); the `examples` and `described_by` of each field are not provided in the first version |

**Not provided in 0.1.0 yet (part of the first version)**: 0.1.0 is the first version released publicly and provides only a part of the first version ([`07-scope-v1.md`](07-scope-v1.md) section 7). The items below are within the design scope of the first version and are written out in this document as they are; calling them in 0.1.0 reports `not_in_this_version`. This is separate from the table above: the table above lists what the first version does not do, and the table below lists what the first version does and 0.1.0 does not provide yet.

| Which part | What it includes | Where the types are |
|---|---|---|
| Privacy deletion | `deletion_preview`, `delete`, canceling a deletion (`cancel` on a `deletion` item); the fields and flags that exist only because of them (`pending_deletion`, `dangling_ref`), the item type `deletion`, the handle `dc_`, and the `deletion` field of `sources` | 4.7, 5.4; `Marks` (section 3), the rows of the `ErrorCode` table that concern deletion (`preview_outdated`, `pending_deletion_source`, `pending_deletion_target`, `executed` of `handle_expired`, and so on) |
| A migration that rebuilds a physical table | adding a field, removing a field, tightening a constraint, changing precision, and changing a unit on a table that has been written to; the progress of the migration (`migration`, `migration_progress`) | 5.3 (`SchemaChange`, `SchemaImpact`, `MigrationStatus`); `draft_outdated` and the `table_written` and `migrate_failed` of `not_in_this_version` |
| Comparison | `log.reconcile` | the `log.reconcile` part of 8.4 |
| Changing the slot policy | `policy.set` (it is already after the first version, and is also in the table above) | 8.2 |

---

## 1. Common types

### 1.1 Identifiers

```ts
type SlotName = string;         // unique within a user; slot_id is also accepted
type TableName = string;        // "ledger.expenses", or "expenses" when the name is not duplicated within the visible range
type FieldName = string;        // does not start with "_"; is not valid / valid_from / valid_to / row_id / entity_id; unique within its scope ignoring ASCII case (see 04-contract section 1)

type SlotId   = string;         // "sl_…"
type RowId    = string;         // "r_…"   one row of an event table or a timeless table
type EntityId = string;         // "e_…"   one entity of a state table
type SourceId = string;         // "s_…"   one source
type ItemId   = string;         // "pi_…"  a pending item; a deletion ID is also one
type DraftId  = string;         // "d_…"   a schema draft
type ReadId   = string;         // "rd_…"  one read
type ConnectionId = string;     // "ci_…"  a connection
type JobId    = string;         // "jb_…"  @later

type DeleteConfirm = string;    // "dc_…"  deletion confirmation handle, signed
type Cursor        = string;    // "cur_…" paging handle, signed
```

### 1.2 Sequence numbers and version tokens

```ts
/**
 * Operation number. Each write / resolve / delete / deletion cancellation has one: the seq of its head event.
 * Every #n that appears externally is an operation number: the seq of a receipt, the number in ver, the entries of the timeline, the n of undo,
 * the values of as_of / since / until. The seq of the individual events inside one operation is not exposed.
 */
type Seq = number;

/** "v57.0" = (the operation number of the most recent change to this row / the entity's current state, the tenant's restore count). The restore count starts at 0. Returned on reads, passed back unchanged on writes.
 *  The operation number is taken from the latest version in the version table whose intent is not schema_switch: the backfill of a schema switch does not change ver. */
type Ver = string;

/** "h41.0": a historical version returned by as_of of history. It cannot be used for writes and does not take part in the fallback. The operation number is taken in the same way as for Ver (the backfill of a schema switch is not counted). */
type HistoricalVer = string;

/** The schema version of a slot, an integer, starting at 1. */
type Sv = number;

/** "iv_…": the version token of a pending item. Returned in the item details and in a receipt for an item that is "newly created and whose receipt gives the full content", and passed back on resolve. */
type ItemVer = string;
```

### 1.3 Time

```ts
type DateStr = string;          // "2026-11-10"
type Instant = string;          // RFC 3339, with an offset: "2026-11-10T12:31:00+08:00"
/**
 * RFC 9557: "2026-11-10T12:31:00+08:00[Asia/Shanghai]".
 * When given (values in read results and receipts): the wall-clock time of that zone at that instant, to millisecond precision (no fraction is written when the milliseconds are 0); the offset is the exact offset of that zone
 * at that instant rounded to a whole minute (rounded half away from zero: -00:44:30 is written as -00:45), written as ±HH:MM;
 * the part in square brackets is the recorded zone name. UTC is written as "+00:00[UTC]".
 * When accepted (writes): if both the offset and the zone name are written, the offset must equal the exact offset of that zone at this wall-clock time rounded to a whole minute by the same rule (the hour that is set back
 * has two instants: first take the one whose exact offset equals the written offset exactly, and if there is none, take the one that is equal after rounding to a whole minute); if equal, the instant is taken by the exact offset, otherwise it is inconsistent with the zone and rejected ("+00:00" and "-00:00"
 * are also compared as offsets); if Z plus a zone name is written, Z means the instant is UTC and the local offset is unknown (RFC 9557), so this UTC instant is taken and this zone is recorded,
 * and the offset is not compared; if only a zone name is written, the instant is taken from the wall-clock time in that zone; if only an offset is written, the instant is taken by the offset and the zone is recorded as the slot's. So a value that is read and written back unchanged
 * gives the same instant and zone.
 */
type ZonedDateTime = string;

/** A point on valid time. When the granularity of the table is date it takes DateStr, when instant it takes Instant. */
type BizTime = DateStr | Instant;

/** A point on recorded time: an operation number, or an instant (converted to the last operation number not later than it; a future instant equals the latest). */
type RecordPoint = Seq | Instant;

/** An interval on valid time, closed on the left and open on the right. */
interface Interval {
  /** null means the start is open. It appears only in: an item interval (ItemTarget.spans) and the whole time span in the details segments (valid_to is also null then,
   *  and the revocation of the whole entity becomes a candidate), and the first segment of an item interval or a details segment whose start is open (after a write-back over the whole time span has been cut up by other items);
   *  in a write receipt, the segment on a state table that acts on the whole time span: a revoke of the whole (a revoke without an interval), the undo of a revoke of the whole (the intent of the op can be
   *  update or correct), and the whole segment that include_later reverts together and turns into a candidate (both applied and candidate), where valid_to is also null;
   *  in a write receipt and in the timeline, the write-back segment that reverts a revoke of the whole (its start is open when it is cut up by other items).
   *  A row in a read result always has a start; the item segments in flags are cut by the interval of the row, and when the first segment of an item has an open start it takes the start of the row, so it also always has a start. */
  valid_from: BizTime | null;
  valid_to: BizTime | null;        // null = continues indefinitely
  valid_to_inclusive?: DateStr;    // given only when the granularity is date and valid_to is not null: the last day in the interval
}
```

### 1.4 Values

```ts
interface Quantity { value: string; unit: string }   // value is a decimal string: "45", "5.2"

/**
 * The value of a field, according to the type declared in the schema:
 *   text → string (UntrustedText when returned)     integer → decimal string  decimal → decimal string
 *   boolean → boolean                                enum → string             date → DateStr
 *   zoned_datetime → ZonedDateTime                   quantity → Quantity       ref → RowId | EntityId | "@temporary name"
 * integer is a 64-bit signed integer and can exceed the safe range of JSON numbers (2^53 − 1), so results always write it as a decimal string (consistent with the event format).
 * On writes, integer and decimal also accept a JSON number (parsed from the original text, not through a double); an integer given as a JSON number must be within the safe range, otherwise write it as a string.
 * null = clear (only for optional fields; a required field reports validation_failed / required_missing). Clearing is a contribution, and the value source is the evidence of this write.
 */
type Value = string | number | boolean | Quantity | null;

type Values = Record<FieldName, Value>;

/** Text that comes from user content or is written by the caller and may contain instructions. The field value is kept unchanged; the untrusted boundary is added by the surface (05-surfaces). */
type UntrustedText = string;
```

**Comparison with the notation of the event format** (the same value is written differently in a log event and in the external contract, and an implementation follows each side separately; see [`09-event-format.md`](09-event-format.md) 1.2 and 1.3):

| Value | Contract (external) | Event format (in the log) |
|---|---|---|
| Instant | RFC 3339, may carry an offset | UTC, fixed millisecond precision, ending in `Z` |
| Time with a zone `zoned_datetime` | one string (with the offset and the zone name) | `{"instant": <instant>, "zone": <IANA zone name>}` |
| Interval on valid time | `{valid_from, valid_to}`, with `null` on an open end; for `date` granularity `valid_to_inclusive` is also given. The whole time span (item intervals, and the segment of a receipt that acts on the whole time span: a revoke of the whole, its undo, the candidate that include_later reverts together): `{valid_from: null, valid_to: null}`; start open (the write-back segment that reverts a revoke of the whole): `valid_from` is `null` | `{"from", "to"}`, with the open end omitted: `{"to"}` has an open start, `{"from"}` has an open end, `{}` is the whole time span (the whole time span of `scope_valid` is written `[{}]`; see 09 §1.2) |
| Integer, decimal, quantity, date, boolean, enum, text | the same on both sides (integers and decimals are both decimal strings) | same as on the left |
| "Existence" (whether this row / this segment exists) | write `"*"` in the position of the field name: the key of `fields`, and the field arrays in `unit` and in flags | `"existence"`; the `unit` of an item `target` is written `["existence"]` |
| Per-row result of a deletion | `result` | `outcome` (`results/<k>/target`), with the same values |
| Segments that execution will change (the impact of an item) | `impact.overwritten` (the segments overwritten) and `impact.filled_gaps` (the intervals without a value that are filled) | `overwritten_segment` of `impact/<k>`: a segment that carries `gap` (an interval without a value) goes into `filled_gaps` in the contract; the others (including a segment whose value is cleared to `null`) go into `overwritten` |
| Row hit as a suspected duplicate | `FlaggedDetail.related` (the group of key values that matched is given separately in `matched_values`) | `matched` (the `duplicate` of `write.base`, the `matched/<k>` of `item.created`) |

### 1.5 Targets

```ts
/** Locates a row / an entity / a derived row. Exactly one besides table is given (none for insert).
 *  Exception: when adding a key to a row that has no external key, the write op gives both row and external_key (04-contract 5.1). */
interface Target {
  table: TableName;
  row?: RowId;                             // event table, timeless table
  entity?: EntityId;                       // state table
  entity_key?: Record<FieldName, Value>;   // state table, when the schema declares entity_key: {"category": "Dining"}
  /** External key: for event tables and timeless tables whose schema declares external_key, the values of all the key fields: {"origin": "band_app", "external_id": "m-2"}.
   *  Used only for writes; the parameters of read operations do not accept it, and giving it reports invalid_argument. */
  external_key?: Record<FieldName, Value>;
  key?: Record<FieldName, Value>;          // the group key of a derived table: {"month": "2026-11-01"}; for an overall aggregate without grouping: the empty object {}. Read only
}

/** Row identification in results: the server always gives the ID; when there is a natural key / external key / group key it is given too. A derived row gives only key (the group key; an overall aggregate without grouping is the empty object {}). */
interface TargetRef {
  table: TableName;
  row?: RowId;
  entity?: EntityId;
  entity_key?: Record<FieldName, Value>;
  external_key?: Record<FieldName, Value>;
  key?: Record<FieldName, Value>;
}
```

### 1.6 Principals

```ts
interface Actor {
  kind: "connection" | "user" | "system";
  id: string;            // a ConnectionId, a user ID, or "system"
  name: string;          // the connection name ("MacBook · Claude Code"), the user name, or "system"
  /** Given when the principal has been revoked (revoked) or deactivated by an import (disabled); not given when normal. The actor of the data it has written does not change, and the name is still displayed as before. */
  state?: "revoked" | "disabled";
}
```

The `Actor` in a write receipt (including a write triggered by `resolve`) takes the form it had at the time of that write operation: `name` is the name given by the last registration or renaming in the log that is not later than this write, and `state` is the state at that time. "This write" means the operation the receipt belongs to, not the earlier operation that `seq` in a field points to: for example, `by: {seq: 11, actor}` says that the value now in effect was given by operation 11, and the name and state of `actor` are still those at the time of this write. The results of read operations and administrative operations take the present ones. So a later renaming or revocation does not change the receipt of a write, and an idempotent replay gives the same principal as well ("The receipt of an idempotent replay" in [`03-data-model/04-write-and-read.md`](03-data-model/04-write-and-read.md)).

### 1.7 Parameters and results every operation has

```ts
interface CommonParams {
  /** An optional task identifier, self-reported. Reads and writes of the same task use the same value; it takes part in the fallback for ver / item_ver / sv and in the server-side request key. Passed in a request header on HTTP. */
  task?: string;
}

interface WriteCommonParams extends CommonParams {
  /** An optional explicit idempotency key. The window is 24 hours; the same key with different request content reports invalid_argument. Passed in a request header on HTTP. */
  idempotency_key?: string;
}

interface PageParams {
  limit?: number;                  // default 20, maximum 200
  cursor?: Cursor;
}

interface CommonResult {
  warnings?: Warning[];            // section 7
  notices?: Notice[];              // section 7, at most 3
}

interface PageResult {
  total: number;                   // the total number that satisfy the conditions
  next_cursor?: Cursor;            // not given when there is no next page
  truncated?: { shown: number; total: number };   // given when the surface cuts the result short according to the result budget; the cut point is the page boundary
}
```

---

## 2. Evidence

```ts
type EvidenceKind = "user_message" | "agent_note" | "tool_result" | "file_ref" | "source_ref";
type SourceLevel  = "user_stated" | "agent_inferred";      // external_authority @later

type EvidenceSegment = TextSegment | FileRefSegment | SourceRefSegment;

interface TextSegment {
  kind: "user_message" | "agent_note" | "tool_result";
  text: string;                    // required, non-empty
  level?: SourceLevel;             // overrides the default derived from kind. Not exposed on MCP
  stated_at?: Instant;             // optional: when this sentence was said / when this result was obtained. Unknown when not given
}

interface FileRefSegment {
  kind: "file_ref";
  name: string;                    // required
  mime: string;                    // required
  size: number;                    // required, in bytes
  sha256: string;                  // required, hexadecimal
  origin?: string;                 // source location (URL / path)
  excerpt?: string;                // text excerpt
  level?: SourceLevel;
  stated_at?: Instant;
}

interface SourceRefSegment {
  kind: "source_ref";
  id: SourceId;                    // an existing source in the same slot that was handed in by a caller; an api_call one, or one awaiting deletion within the grace period, cannot be referenced
}
```

The three evidence-related fields on an op (defined on `WriteOp`; `ResolveParams` takes only `evidence` and `evidence_by_field`, see 5.2):

```ts
interface EvidenceOnOp {
  /** Segments that belong to this op only. */
  evidence?: EvidenceSegment[];
  /** Indexes into the request-level evidence. When neither evidence nor evidence_refs is given, all the request-level segments are referenced. */
  evidence_refs?: number[];
  /**
   * Names the evidence per field: field name → an array of indexes. The indexes count the segments visible to this op: first the inline segments, then the request-level segments in the order of evidence_refs.
   * The reserved key "valid" refers to the origin of the interval parameters of a state table (the start, an explicit end).
   * A field whose value did not change counts as corroborated only if it appears here. The array cannot be empty, and an index cannot be out of bounds.
   */
  evidence_by_field?: Record<FieldName | "valid", number[]>;
}
```

Sources have one more kind than evidence, `api_call` (the request itself when no evidence was given), and one fewer, `source_ref` (a reference does not produce a new source). A "correction" is not a kind but an annotation derived from the write intent: when a source is used as a value source by a write with `intent: correct`, the read result carries `correction: true`.

```ts
type SourceKind = "user_message" | "agent_note" | "tool_result" | "file_ref" | "api_call";
```

---

## 3. Flags

Each row of a read result carries `marks` (not given when there is no flag).

```ts
interface Marks {
  /** There is an open conflict item; the value given is the value in effect as decided by the rule. A row can have several items. */
  disputed?: Array<{ item: ItemId; fields: Array<FieldName | "*">; spans?: Interval[] }>;   // "*" = what is disputed is whether this row / this segment exists; spans: the segments of the item interval
  /** There is a proposal that has not taken effect yet; the value given is the current value. */
  awaiting?: Array<{ item: ItemId; fields: Array<FieldName | "*">; spans?: Interval[]; proposed?: Values | null; proposed_revert?: { undo: Seq } }>;  // proposed: null = a proposed revoke; when the proposal is a revert, proposed is not given and proposed_revert is given
  /** The value has taken effect and is only flagged. */
  flagged?: Array<{ item: ItemId; reason: FlaggedReason; related?: TargetRef }>;   // related: among the rows matched, the row with the largest operation number; the full list is in the related of the item details
  /** This row has been corrected. */
  corrected?: true;
  /** This row has been revoked. Appears only with include_revoked: true. */
  revoked?: { seq: Seq };
  /** A version that this connection read earlier was affected later; removed if the value is later restored. */
  possibly_affected?: { reason: AffectedReason };
  /** When read by instant and restored, part of the data at that time has been deleted. */
  partially_deleted?: true;
  /** This row is affected by a deletion that can still be canceled (within the grace period; for the criterion see "affected" in "Deletion · Cancelling a deletion and the grace period" in the data model). */
  pending_deletion?: { item: ItemId };
  /** A row / entity that a ref field of this row points to has been revoked, or has been privacy-deleted. The value of the referencing row does not change (the ID is kept) and is only flagged; when the revoke of the target is undone, the flag disappears. */
  dangling_ref?: Array<{ field: FieldName; state: "revoked" | "deleted" }>;
  /** A premise used by the current value of this row has since changed (04-contract 5.1 "The premises of a write"). The value was not touched; whether it still holds is for the reader to judge.
   *  Visible to any reader. At most 10 are listed, from newest to oldest by since; when there are more, premise_changed_total is given in addition. Adding and removing the flag do not change the ver of this row.
   *  Of several with the same since, the one declared later comes first. When the table (or slot) that the premise target is in is not visible to the reader, there is a second shape: only what belongs to this row itself (the fields covered and since),
   *  with the target, the declared fields, the version seen, the reason and the table name not given. When the table that the premise target is in has been deleted in a schema switch (reason is schema_switched),
   *  and the reader's range contains it (the whole slot, or it is listed by table ID), the first shape is given, with the table name and the declared fields as of the last version before the deletion;
   *  otherwise it is the second shape: the table merely being in the range now does not mean the reader could see the deleted one back then. */
  premise_changed?: Array<{
    premise: TargetRef;            // the row / entity the premise is on
    premise_fields?: FieldName[];  // the declared fields; absent = the whole row
    seen: Ver;                     // the version seen at the time of the declaration
    reason: PremiseReason;
    since: Seq;                    // the operation that made the premise differ from the value seen (after a deletion, it points to that deletion instead)
    fields: FieldName[];           // the fields in this row that this declaration covers
    declared: { seq: Seq; actor: Actor };   // which write declared it
  } | {
    hidden: true;                  // the premise target is not visible to the reader
    since: Seq;
    fields: FieldName[];           // the fields in this row that this declaration covers
  }>;
  premise_changed_total?: number;  // when premise_changed has more than 10 entries: the total count
  /** A derived row is computed at read time (the rule depends on "now", or a state table is read without a valid-time qualifier): the value depends on the time of the read, and this row carries no ver. */
  computed_at_read?: true;
  stale?: { job: JobId };                        // @later
  pending_extraction?: { fields: FieldName[] };  // @later
}

type FlaggedReason  = "duplicate_keys";
type AffectedReason = "correct" | "revoke" | "retroactive" | "plan_changed" | "applied_by_rule" /* @later */;

/** The reasons a premise changed. correct, revoke, retroactive and plan_changed have the same names and meanings as in AffectedReason; update: the premise was changed (an update on an event table or a timeless table also counts);
 *  deleted: a privacy deletion changed the value of the premise; schema_switched: a schema switch removed the declared field (including fields removed along with a table).
 *  When one write has both a retroactive part and a future part on the declared range, retroactive is taken. */
type PremiseReason = "correct" | "update" | "revoke" | "retroactive" | "plan_changed" | "deleted" | "schema_switched";

/** A derived row has no flags of its own and carries a summary over its inputs: among the base rows that fall into this partition (the rows after the WHERE of the rule; FILTER has no effect and HAVING is not involved),
 *  the number of rows that carry a flag on the fields the rule depends on, or on the "existence" of the row. The same kind of flag on the same row is counted once. Given even when all four items are 0. */
interface InputMarks {
  disputed: number;
  awaiting: number;
  flagged: number;
  premise_changed: number;   // the number of base rows that carry premise_changed on the fields the rule depends on
  items: ItemId[];       // the open items involved, in the string order of their IDs, at most 10
}
```

---
## 4. Read operations

### 4.1 A row in a read result

```ts
interface Row extends TargetRef {
  /** Always present on a base table row. Derived rows carry it too: the operation number of the latest operation that changed its value; it cannot be used for writes.
   *  A derived row computed at read time (marks.computed_at_read) does not carry it: it has no derived write, and its value depends on the moment of the read. */
  ver?: Ver | HistoricalVer;
  historical?: true;             // a historical version read with as_of
  values: Values;                // field name → value. Contains only the requested fields (all by default)
  /** State table: the valid interval of this segment. One row per segment; the segments of the same entity have the same entity and ver. */
  valid_from?: BizTime;
  valid_to?: BizTime | null;
  valid_to_inclusive?: DateStr;
  marks?: Marks;
  /** Base table rows only: the writer of the operation in ver, given only when it is not the caller itself (as_of of query and history). */
  changed_by?: Actor;
  input_marks?: InputMarks;      // derived rows only
  detail?: RowDetail;            // when detail is "detailed"
}

interface RowDetail {
  seq: Seq;                      // the operation number of the latest operation that changed it (the same number as in ver: a backfill from a schema switch does not count)
  recorded_at: Instant;
  fields: Record<FieldName, {
    field_id: string;
    level?: SourceLevel;         // the highest declared level among the value sources still present that have a literal match; not given when none matches
    literal: "hit" | "miss" | "na";   // literal match
    ref?: { values: Values };    // ref field: a summary of the referenced row
  }>;
  /** All premise declarations currently in effect on this row (including unchanged ones). A field means the same as in Marks.premise_changed; with state: current, reason and since are not given. Not given when there are no declarations.
   *  A declaration whose target table is not visible gives only hidden, state, since (when changed) and fields, the same as Marks. as_of of history does not give it (the state of premise declarations is not kept by moment). */
  premises?: Array<
    | { premise: TargetRef; premise_fields?: FieldName[]; seen: Ver;
        state: "current" | "changed"; reason?: PremiseReason; since?: Seq;
        fields: FieldName[]; declared: { seq: Seq; actor: Actor } }
    | { hidden: true; state: "current" | "changed"; since?: Seq; fields: FieldName[] }
  >;
}
```

### 4.2 `catalog`

```ts
interface CatalogParams extends CommonParams {
  /** list (default): the list of slots and tables. table: the fields and profile of some tables. schema: the complete schema document of a slot. */
  level?: "list" | "table" | "schema";
  slot?: SlotName;               // list: look at this slot only. schema: required
  /** schema only: reads the document of the whole slot after switching to this draft (IDs filled in, base_version is the current version), not the current version. A draft in any state can be read; a read record is made as usual.
   *  A draft that does not exist, does not belong to the slot or is not visible reports not_found (draft); when not all tables of the slot are within the visible range, its draft is not visible. */
  draft?: DraftId;
  tables?: TableName[];          // table: required, 1–10 tables
  limit?: number;                // list only: default 50, maximum 200 (counted in tables)
  cursor?: Cursor;
}

type CatalogResult = CatalogList | CatalogTables | CatalogSchema;

interface CatalogList extends CommonResult, PageResult {
  level: "list";
  slots: Array<{
    slot: SlotName; slot_id: SlotId; sv: Sv; timezone: string;
    migration?: MigrationStatus;                 // while a migration is in progress
    /** aliases: aliases of the table, not given when there are none. Aliases take no part in name resolution (04-contract.md section 10, catalog). */
    tables: Array<{ table: TableName; kind: "base" | "derived"; description: UntrustedText; aliases?: UntrustedText[] }>;
  }>;
}

interface CatalogTables extends CommonResult {
  level: "table";
  tables: Array<{
    table: TableName; slot: SlotName; sv: Sv; timezone: string;
    kind: "base" | "derived";
    description: UntrustedText;
    aliases?: UntrustedText[];                   // aliases of the table, at most 8; they take no part in name resolution
    /** Not given for derived tables: none of the three values applies to a derived table. */
    time?: { type: "none" } | { type: "event"; field: FieldName } | { type: "state"; granularity: "date" | "instant" };
    entity_key?: FieldName[];
    external_key?: FieldName[];                  // key fields of the external key (event tables, timeless tables)
    duplicate_keys?: FieldName[][];
    together?: FieldName[][];                    // field groups: fields in the same group form one conflict unit
    fields: Array<{
      name: FieldName; type: FieldType; description: UntrustedText;
      aliases?: UntrustedText[];                 // aliases of the field, at most 8; they take no part in name resolution
      required?: true; unit?: string; min?: string; max?: string; values?: string[];
      ref?: { table: TableName; target: "row" | "entity" };
      /** decimal and quantity fields: the number of decimal places and the rounding mode (when the schema does not declare them, the defaults filled in by the compiler). On write, digits beyond it are rounded by it (warning rounded). */
      precision?: { scale: number; rounding: Rounding };
      examples?: UntrustedText[];                // the latest K distinct values
    }>;
    /** depends_on: the fields the rule depends on, each written as "table name.field name" ("runs.distance"). A derivation rule does not cross slots; the table name is the short table name within the same slot, without a slot prefix. */
    rule?: { id: string; version: number; sql: UntrustedText; time_dependency: "none" | "bucketed" | "now"; depends_on: string[] };
    /** Profile: every table at level `table` carries it. The first version does not give the examples and described_by of a field; see 0.2.
     *  rows: for event tables and timeless tables, the number of rows not revoked; for state tables, the number of interval segments (adjacent segments with the same value in all fields are merged first; a revoke in a state table is an interval without a value and takes no row); for derived tables, their own number of rows.
     *  time_range: for event tables, the earliest and the latest value of the time field (only rows not revoked are counted); for state tables, from is the earliest interval start and to is the latest valid_to (exclusive, the same convention as every valid_to in the contract);
     *  for event tables, to is inclusive (the latest value of the time field); for state tables, to is not given when a segment continues without end;
     *  not given for timeless tables, derived tables and empty tables. A date type gives DateStr, an instant type gives Instant (UTC).
     *  A derived table computed at read time (rule.time_dependency is now) carries no profile. */
    profile?: {
      rows: number;
      time_range?: { from: BizTime; to?: BizTime };   // for state tables, to is not given when a segment continues without end
      /** Scale hint: given when the number of rows exceeds the comfortable line; computed at read time from the current number of rows and the limits shipped with the kernel; it does not enter an event and is not a data flag.
       *  large: above comfortable_rows and not above tested_rows; beyond_tested: above tested_rows. */
      scale?: { level: "large" | "beyond_tested"; comfortable_rows: number; tested_rows: number };
    };
    described_by?: { actor: Actor; sv: Sv };     // who wrote the description, and in which version
  }>;
}

type FieldType = "text" | "integer" | "decimal" | "boolean" | "enum" | "date" | "zoned_datetime" | "quantity" | "ref";

/** half_up: round half up, away from zero exactly at the half. half_even: round half to even exactly at the half. */
type Rounding = "half_up" | "half_even";

interface CatalogSchema extends CommonResult {
  level: "schema";
  slot: SlotName;
  sv: Sv;                        // with draft, the version this draft would become once confirmed; otherwise the current version
  draft?: DraftId;               // echoed unchanged when the draft parameter is given
  document: SchemaDocument;      // IDs and base_version are filled in; after editing it can be handed directly to schema_draft. With the draft parameter, the document of the whole slot after switching to that draft
  policy: SlotPolicy;            // read-only, 8.2. Always the policy currently in effect: a draft does not change the policy
}

/** The schema document. The authoritative definition of the format is in "Schema document format" in the data model. */
type SchemaDocument = Record<string, unknown>;

interface MigrationStatus {
  target_sv: Sv;
  state: "building" | "failed";
  progress?: { done: number; total: number };
  item?: ItemId;                 // the corresponding schema_change (or @later migration_diff) item
}
```

Example (`level: "list"`):

```json
{ "level": "list" }
```
```json
{
  "level": "list", "total": 3,
  "slots": [{
    "slot": "ledger", "slot_id": "sl_4KTZ…", "sv": 2, "timezone": "Asia/Shanghai",
    "tables": [
      { "table": "expenses", "kind": "base", "description": "One row per expense" },
      { "table": "budgets", "kind": "base", "description": "Monthly budget per category" },
      { "table": "monthly_total", "kind": "derived", "description": "Total expenses per month" }
    ]
  }]
}
```

### 4.3 `query`

```ts
interface QueryParams extends CommonParams, PageParams {
  table: TableName;
  /** Conditions are combined with "and". On a state table with valid_during, field can also be "valid_from" / "valid_to". */
  where?: Array<{ field: FieldName | "valid_from" | "valid_to"; op: WhereOp; value?: Value | Value[] | boolean }>;
  /** Default: event tables by occurrence time, descending; state tables by entity, then by valid_from; timeless tables by latest change, descending; derived tables by group key, ascending. */
  order?: Array<{ field: FieldName; dir?: "asc" | "desc" }>;
  fields?: FieldName[];
  /** A moment in valid time. State tables only. */
  valid_at?: BizTime;
  /** A valid-time interval [a, b). State tables: returns every segment that intersects it. Event tables: filters by the occurrence time field. */
  valid_during?: [BizTime, BizTime | null];
  /** Segments returned by valid_during: true = endpoints are cut to the interval. Default false. */
  clip?: boolean;
  /** Segments returned by valid_during: true (default) = merge adjacent segments with the same value in the selected fields. */
  coalesce?: boolean;
  /** Evaluation moment: "today" (for derived values that depend on "today") and reading a state table without a time qualifier both take it. When not passed, the moment of entry is used. */
  at?: Instant;
  include_revoked?: boolean;     // default false
  /** Default concise. detailed: each row also gets a RowDetail (4.1). Only where a Row is returned: query, and as_of of history. */
  detail?: "concise" | "detailed";
}

/**
 * = !=        all types
 * < <= > >=   integer, decimal, quantity (compared after conversion to the same dimension), date, zoned_datetime
 * in          value is an array; the applicable types are the same as for =
 * contains    text only: substring match, case-sensitive
 * is_null     value is a boolean: true = is empty, false = is not empty
 */
type WhereOp = "=" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "contains" | "is_null";

interface QueryResult extends CommonResult, PageResult {
  table: TableName; slot: SlotName; sv: Sv;
  rows: Row[];
}
```

Example:

```json
{ "table": "expenses", "where": [{ "field": "date", "op": "=", "value": "2026-11-10" }] }
```
```json
{
  "table": "ledger.expenses", "slot": "ledger", "sv": 1, "total": 1,
  "rows": [{
    "table": "ledger.expenses", "row": "r_01JC8Z…", "ver": "v25.0",
    "values": { "date": "2026-11-10", "category": "Dining", "amount": { "value": "54", "unit": "CNY" }, "note": null },
    "marks": { "corrected": true }
  }]
}
```

A state table, `valid_during`:

```json
{ "table": "budgets", "where": [{ "field": "category", "op": "=", "value": "Dining" }],
  "valid_during": ["2026-10-01", "2027-01-01"] }
```
```json
{
  "table": "ledger.budgets", "slot": "ledger", "sv": 2, "total": 3,
  "rows": [
    { "table": "ledger.budgets", "entity": "e_01JCB2…", "entity_key": { "category": "Dining" }, "ver": "v55.0",
      "values": { "category": "Dining", "amount": { "value": "5000", "unit": "CNY" } },
      "valid_from": "2026-10-01", "valid_to": "2026-11-02", "valid_to_inclusive": "2026-11-01" },
    { "table": "ledger.budgets", "entity": "e_01JCB2…", "entity_key": { "category": "Dining" }, "ver": "v55.0",
      "values": { "category": "Dining", "amount": { "value": "3000", "unit": "CNY" } },
      "valid_from": "2026-11-02", "valid_to": "2026-11-10", "valid_to_inclusive": "2026-11-09" },
    { "table": "ledger.budgets", "entity": "e_01JCB2…", "entity_key": { "category": "Dining" }, "ver": "v55.0",
      "values": { "category": "Dining", "amount": { "value": "4000", "unit": "CNY" } },
      "valid_from": "2026-11-10", "valid_to": null }
  ]
}
```

### 4.4 `sql`

```ts
interface SqlParams extends CommonParams {
  /** A single SELECT. Tables and fields are given by name, and tables of several slots within the visible range can be referenced; state tables can use FOR VALID_TIME AS OF … / FROM … TO …; NOW() cannot be used.
   *  The allowlist is in "Restricted SQL" in the data model (03-data-model/11-restricted-sql.md). */
  sql: string;
  /** The values of the positional parameters $1, $2…: string, number, boolean, null. A quantity with a unit is passed as a decimal string in the unit declared for that column. */
  params?: Array<string | number | boolean | null>;
  max_rows?: number;             // rows per page. Default 100, maximum 1,000
  at?: Instant;                  // evaluation moment: saveslot_today(), saveslot_now() and reading a state table without a time qualifier all take it. When not passed, the moment of entry is used
  cursor?: Cursor;               // not exposed by MCP
}

interface SqlResult extends CommonResult {
  sv: Record<SlotName, Sv>;      // the schema version of each slot the query involves
  columns: Array<{ name: string; type: FieldType | "unknown"; unit?: string }>;
  /** One array per row, in the order of columns. The cells of integer, decimal and quantity columns are all decimal strings (consistent with §1; not written as JSON numbers even when the number is small), and the unit is in columns. The whole of rows is untrusted text. */
  rows: Array<Array<string | number | boolean | null>>;
  total?: number;                // given when it can be obtained cheaply
  next_cursor?: Cursor;
  truncated?: { shown: number; total?: number };
  /** A summary of flags computed from the set of row versions this query read. */
  marks_summary?: InputMarks & { possibly_affected?: number; partially_deleted?: true };
}
```

The result carries no `ver` and adds no row ID automatically (select `row_id` / `entity_id` in the query when needed). Example:

```json
{ "sql": "SELECT category, sum(amount) AS total FROM expenses WHERE date >= $1 GROUP BY 1 ORDER BY 2 DESC",
  "params": ["2026-11-01"] }
```
```json
{
  "sv": { "ledger": 1 },
  "columns": [{ "name": "category", "type": "text" }, { "name": "total", "type": "quantity", "unit": "CNY" }],
  "rows": [["Dining", "54"], ["Transport", "35"]],
  "total": 2,
  "marks_summary": { "disputed": 1, "awaiting": 0, "flagged": 0, "premise_changed": 0, "items": ["pi_7C2E…"] }
}
```

### 4.5 `history`

```ts
type HistoryParams = TimelineParams | AsOfParams | ChangesParams | CompositionParams;

interface TimelineParams extends CommonParams, PageParams, Target {
  mode?: "timeline";             // default
  expand_sources?: boolean;      // with excerpts of the original text
}

interface AsOfParams extends CommonParams, PageParams, Target {
  mode: "as_of";
  /** Recorded time: an operation number, an instant, or "at the time of a read". */
  as_of: RecordPoint | { read: ReadId } | { task: string };
  /** When not given, a state table entity returns all segments known at that time. */
  valid_at?: BizTime;
  detail?: "concise" | "detailed";   // same as QueryParams.detail
}

interface ChangesParams extends CommonParams, PageParams {
  mode: "changes";
  table: TableName;              // a base table. A derived table reports invalid_argument (derived_table)
  row?: RowId; entity?: EntityId; entity_key?: Record<FieldName, Value>;   // no target = the whole table
  /** Exclusive. Required. "my_last_read" = the position this connection last read (with task, only the same task counts), recognized by the range the read covered (a call on the whole table only recognizes reads that covered the table); if there was no read, reports read_first (no_read); if it was read only under another task, reports read_first (task_mismatch). 0 looks from the beginning. */
  since: RecordPoint | "my_last_read";
  /** Inclusive. Default latest. */
  until?: RecordPoint;
}

interface CompositionParams extends CommonParams, Target {   // @later
  mode: "composition";
  as_of?: RecordPoint;
}

interface TimelineResult extends CommonResult, PageResult {
  mode: "timeline";
  target: TargetRef; sv: Sv;
  timezone: string;              // the slot's time zone (same as timezone in catalog): instants in the result are shown in it
  /** The current version. Only it can be used for writes; returning it counts as a per-row read. */
  ver: Ver;
  entries: TimelineEntry[];      // newest first
  /** The reads (of any connection) that read each version; seq is the version read. No query conditions are given. Given on the first page only. */
  reads?: Array<{ read: ReadId; seq: Seq; at: Instant; actor: Actor; task?: string }>;
}

interface TimelineEntry {
  seq: Seq;
  recorded_at: Instant;
  actor: Actor;
  intent: VersionIntent;
  /** How this write came about: not given for an ordinary write. */
  via?: { resolve: ItemId; decision: Decision } | { deletion: ItemId; action: "confirm" | "cancel" } | { undo: Seq }
      | { schema: { sv: Sv } };   // a value filled in by a constant backfill at a schema switch: the actor is system, and there is no source data
  valid?: Interval;              // state table: the largest interval this write touches; per-field ones are in fields
  /** On a state table, a field can have several items in one write (the segments differ in value or result); the value is then an array ordered by interval. */
  fields: Record<FieldName | "*", TimelineField | TimelineField[]>;
  /** The premises this write declared, in the same shape as the write receipt (5.1), one to one with the request; state is the current state. A restate and a clear are one entry each (fields may be empty); for a clear it is an empty array.
   *  Several ops on the same row in one request are one entry each, and within the same operation number they go by op index from largest to smallest (consistent with newest first for the whole table).
   *  A declaration that no longer counts (superseded by a later declaration on the same target, or cleared) gives state: "ended", without reason and since: it takes part in no flag now.
   *  When the table (or slot) of the premise target is not visible to the reader, that entry takes a third shape: an intentional exception, giving state and since, and not giving what changed and how
   *  (the target, the declared fields, the version seen, the reason and the table name); the count and order stay as they are. The ended and the not-visible shapes appear only in timeline (they are not in a receipt: the writer can see the targets it declared).
   *  Later pages stop at the operation number of the first page, but state and since are current, so since can be greater than the operation number a page stops at. */
  premises?: Array<OpResult["premises"][number] | {
    target: TargetRef; fields?: FieldName[]; ver: Ver;
    state: "ended";                // superseded or cleared
  } | {
    hidden: true;                  // the premise target is not visible to the reader
    state: "current" | "changed" | "ended";
    since?: Seq;                   // only when state is changed
  }>;
  affected?: { derived: DerivedChange[]; reads: number };
}

interface TimelineField {
    result: TimelineResultCode;  // the latest one given prevails: the result at write time, or the result restated later by a privacy deletion
    no_value?: true;             // this item (a revert, taking the previous value) sets the field to no value (state table: over its interval)
    uncovered?: true;            // this item (a revert, taking the previous value) only makes the reverted write stop taking effect in this segment, and gives no value: this segment returns to the gap left by the revoke
    before?: Value; after?: Value;
    valid?: Interval;            // state table: the interval this item resolved to (the latest one given prevails: at write time, or re-resolved later by a privacy deletion)
    removed?: true;              // the content has been removed by a deletion; result is then removed
    /** schema_const: this value comes from the constant backfill at the schema switch to version sv (it has no source data and is not cleared by a privacy deletion). */
    sources?: { value: SourceRef[]; operation: SourceRef[]; schema_const?: { sv: Sv } };
}

interface SourceRef {
  id: SourceId; kind: SourceKind;
  correction?: true;             // used as a value source by a correction write
  level?: SourceLevel; literal?: "hit" | "miss" | "na";
  text?: UntrustedText;          // when expand_sources: true; not given for a deleted one
  removed?: true;
}

interface AsOfResult extends CommonResult, PageResult {
  mode: "as_of";
  as_of: { seq: Seq; recorded_at?: Instant };   // earlier than the first operation: seq is 0, with no recorded_at
  sv: Sv;                        // the schema version at that time, by which values are interpreted
  timezone: string;              // the slot's current time zone (same as timezone in catalog): instants in the result are shown in it
  rows: Row[];                   // ver is a HistoricalVer, historical: true; empty if the target did not exist at that time
  other_reads?: Array<{ read: ReadId; seq: Seq; at: Instant }>;   // with as_of: {task}: the other reads of this target by the same task
}

/** before / after are not given when there is no value, nor when a contribution a deletion removed gave it (the entry then carries partially_deleted). "*": a boolean, true means exists. */
interface ChangedField { before?: Value; after?: Value }

interface ChangesResult extends CommonResult, PageResult {
  mode: "changes";
  target: TargetRef;             // the table, or the row / entity looked at
  timezone: string;              // the slot's time zone (same as timezone in catalog): instants in the result are shown in it
  since: Seq; until: Seq;        // the resolved operation numbers: after (exclusive) up to and including this one
  /** Newest first. One entry is the change one operation made to one row / entity. */
  changes: Array<{
    seq: Seq; recorded_at: Instant; actor: Actor;
    intent: VersionIntent;       // includes deletion, deletion_cancelled: versions produced by a deletion confirmation or cancellation
    target: TargetRef;
    /** Lists only the fields whose value actually changed. Event tables, timeless tables: one object per field. State tables: each field is an array ordered by interval, each segment with its own interval (the same shape as TimelineField[] in timeline). "*" is whether this row / this segment exists, given when a revoke or the undo of a revoke changes it. */
    fields: Record<FieldName | "*", ChangedField | Array<ChangedField & { valid: Interval }>>;
    /** A field's before or after came from a contribution a deletion removed (in its grace period or carried out): that side is not given (data-model "Deletion · Version table"). */
    partially_deleted?: true;
  }>;
}
```

Example (`timeline`):

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
        "category": { "result": "applied", "after": "Dining",
          "sources": { "value": [{ "id": "s_1", "kind": "user_message", "literal": "miss" }], "operation": [] } },
        "amount": { "result": "applied", "after": { "value": "45", "unit": "CNY" },
          "sources": { "value": [{ "id": "s_1", "kind": "user_message", "level": "user_stated", "literal": "hit" }], "operation": [] } } } }
  ]
}
```

### 4.6 `sources`

```ts
interface SourcesParams extends CommonParams, PageParams {
  mode?: "list" | "search" | "get";   // default list
  slot?: SlotName;
  kind?: SourceKind;
  from?: Instant;                     // recorded time, [from, to)
  to?: Instant;
  q?: string;                         // search: required. In the first version, substring match
  id?: SourceId;                      // get: required
}

interface SourcesListResult extends CommonResult, Omit<PageResult, "total"> {
  mode: "list" | "search";
  /** Always for list. For search, only when the source data the filters take can be scanned in full by one call (all the matches); otherwise not given, and next_cursor says more may follow (04-contract sources). */
  total?: number;
  sources: Array<{
    id: SourceId; kind: SourceKind; slot: SlotName;
    recorded_at: Instant; stated_at?: Instant; actor: Actor;
    correction?: true;                // used as a value source by a correction write
    excerpt?: UntrustedText;          // the first 200 characters of the original text; not given for a deleted or pending-deletion one
    file?: { name: UntrustedText; mime: string; size: number };
    deletion?: SourceDeletion;
  }>;
}

interface SourcesGetResult extends CommonResult {
  mode: "get";
  id: SourceId; kind: SourceKind; level: SourceLevel; slot: SlotName;
  recorded_at: Instant; stated_at?: Instant; actor: Actor;
  correction?: true;                  // used as a value source by a correction write
  text?: UntrustedText;
  file?: { name: UntrustedText; mime: string; size: number; sha256: string; origin?: UntrustedText; excerpt?: UntrustedText };
  /** What data it produced. role: value means it is the value source of these items (when it is also the operation source or the interval source of the same item, only this one is listed); operation means it is the operation source of this operation; interval means it is the source of the interval parameters of these items (valid_sources of writes with an interval and of revokes on state tables), listed only when it serves only as an interval source. */
  produced?: Array<{ target: TargetRef; seq: Seq; fields: FieldName[]; role: "value" | "operation" | "interval" }>;
  deletion?: SourceDeletion;          // when it is given, text / file / produced are not given
}

/** pending: within the grace period, the content cannot be read and the deletion can be cancelled. removed: physically erased. */
type SourceDeletion =
  | { state: "pending"; item: ItemId; expires_at: Instant }
  | { state: "removed"; at: Instant; reason: TombstoneReason };

/** expiry: the grace period expired. restore_backfill: re-applied from the deletion register after restoring a backup. import_placeholder: a tombstone added at import for an item that was a pending-deletion placeholder in the export. */
type TombstoneReason = "expiry" | "restore_backfill" | "import_placeholder";
```

Example (`get`):

```json
{ "mode": "get", "id": "s_2" }
```
```json
{
  "mode": "get", "id": "s_2", "kind": "user_message", "correction": true, "level": "user_stated", "slot": "ledger",
  "recorded_at": "2026-11-10T12:41:07+08:00",
  "actor": { "kind": "connection", "id": "ci_01A…", "name": "MacBook · Claude Code" },
  "text": "No, lunch was 54 yuan",
  "produced": [{ "target": { "table": "ledger.expenses", "row": "r_01JC8Z…" }, "seq": 25, "fields": ["amount"], "role": "value" }]
}
```
### 4.7 `deletion_preview`

```ts
type DeletionPreviewParams =
  | (CommonParams & PageParams & {
      kind: "privacy" | "evidence" /* @later */;
      /** The source data to delete. Required and non-empty; must all belong to the same slot. */
      sources: SourceId[];
      rows?: Target[];               // @later: remove all contributions to these rows
    })
  | (CommonParams & PageParams & {
      /** Produce the preview again for an existing dc_. Not exposed over MCP. */
      confirm: DeleteConfirm;
    });

interface DeletionPreviewResult extends CommonResult, PageResult {   // paging applies to rows[] only; total is the total number of rows
  confirm: DeleteConfirm;
  confirm_expires_at: Instant;
  slot: SlotName;
  kind: "privacy" | "evidence" /* @later */;
  totals: { sources: number; rows: number; derived: number };
  rows: DeletionRowResult[];
  /** Writes that were not in effect and will take effect because of the deletion. At most 50, with a total given separately. */
  /** valid: the overall range over which this write will take effect (for several segments, the overall range; the per-segment results are in the timeline after execution). */
  now_effective: Array<{ seq: Seq; target: TargetRef; fields: Values; valid?: Interval; item: ItemId; item_becomes: "superseded" | "open" }>;
  now_effective_total: number;
  /** Writes whose conflict will disappear because of the deletion but which are still high-impact: they turn into awaiting confirmation and do not take effect directly. */
  now_awaiting: Array<{ seq: Seq; target: TargetRef; fields: Values; valid?: Interval; from_item: ItemId; impact: AwaitingImpact }>;
  now_awaiting_total: number;
  /** Items that will be superseded because of the deletion. */
  superseded: Array<{ item: ItemId; type: ItemType; reason: SupersededReason }>;
  superseded_total: number;
  /** Derived tables whose group key comes from a free-text field: when a group becomes empty because of the deletion, the key value is cleared with it. */
  group_keys_cleared?: Array<{ table: TableName; count: number }>;
  /** Rows that still reference a row / entity that will be deleted as a whole row: they stay unchanged, and later reads carry a dangling_ref flag. At most 50, with a total given separately. */
  dangling_refs: Array<{ target: TargetRef; field: FieldName; to: TargetRef }>;
  dangling_refs_total: number;
  /** What will not be deleted. connection_names: the name of a connection is not derived from source data, so it is outside the cascade.
   *  operation_labels: for operations that have no source data (submitting a schema draft, confirming a deletion, a resolve that carries neither evidence nor a note), the self-reported task and the explicit idempotency key; there is no provenance to follow for deleting them. */
  not_deleted: Array<{ kind: "external_file" | "schema_text" | "retained_metadata" | "connection_names" | "operation_labels"; sources?: SourceId[] }>;
  /** Source data that is kept after the deletion but no longer supports any data: only those that go from "supported data" to "supports nothing" as a result of this deletion.
   *  They are outside the scope of this deletion and are kept as usual; this lets the caller decide whether to delete them as well. At most 50, with a total given separately. */
  orphaned_sources: SourceId[];
  orphaned_sources_total: number;
  /** Advance notice: rows whose premise is the values that will be changed carry premise_changed (reason: deleted) after the deletion; they are not deleted themselves. rows has at most 50 rows, and count is the total. Not given when there are none. */
  premise_affected?: PremiseAffected;
  /** Local mode: if saveslot is not running at expiry, the physical erasure is carried out at the next start. */
  local_deferred?: true;
  reextract?: Array<{ target: TargetRef; fields: FieldName[] }>;   // @later
  cleared?: Array<{ target: TargetRef; fields: FieldName[] }>;     // @later
  collateral_rows?: TargetRef[];                                   // @later
}

interface DeletionRowResult {
  target: TargetRef;
  /** sources_changed: the values did not change; the row is listed because its givers, judgement results or the blocks that gave them are given again (for example: the value given by a deleted write is also given by a corroboration or a later write;
   *  the undo of a write that gave a gap is resolved again because of the deletion and the gap is still in its original place; an item is merely restated unchanged). */
  result: "deleted" | "kept_fields_cleared" | "fields_reverted" | "resegmented" | "sources_changed";
  /** What it looks like after the deletion. Not given when deleted. Event tables give values; state tables give spans. */
  after?: { values?: Values; spans?: Span[] };
  /** State tables only: the intervals that go from having a value to having no value after the deletion, with the cause. Not given when there are none. An interval is listed once: one inside a revocation takes revocation_extended, otherwise required_field_removed.
   *  required_field_removed: a required field has no remaining contribution there.
   *  revocation_extended: a revoke that carries only a start has its end stopped at a stop point given by a deleted write, and after the deletion it extends past it;
   *  a write that falls within the extended part does not carry all required fields and cannot support this segment. */
  gaps_opened?: Array<{ valid: Interval; cause: "required_field_removed" | "revocation_extended" }>;
  cleared?: FieldName[];             // kept_fields_cleared: the fields that become empty
  /** fields_reverted: each field that goes back to an earlier value. */
  /** Exactly one of from_seq and schema_const is present: either the value of a particular write is gone back to, or the value gone back to is a constant backfill filled in when schema version sv was switched (there is no write to point to). */
  reverted_to?: Record<FieldName, { value: Value; from_seq?: Seq; schema_const?: { sv: Sv }; valid?: Interval; reason: "later_write_removed" | "revert_source_removed" }>;
  /** For each required field, the contributions of the writes that remain after the deletion (an empty array = none): the row continues to exist because of them. */
  basis?: Record<FieldName, Seq[]>;
  /** This row is kept, but its external key is removed together with the deleted contributions: if a connector later syncs the same record again, it adds a different row. See also the warning external_key_resync. */
  external_key_removed?: true;
  /** The external key of this row will be frozen by this deletion: while frozen it cannot be transferred, and any sync by it is skipped. Given only on rows whose key will be frozen; the key value is not listed.
   *  also_by: other deletions on the same key that have not been executed. When present, the key is still frozen after this item is cancelled, until these are all cancelled or executed. */
  external_key_frozen?: { also_by?: ItemId[] };
  /** Other evidence segments in the same write: they can be corroborated field by field with source_ref + evidence_by_field before deleting. */
  co_evidence?: Array<{ seq: Seq; fields: FieldName[]; sources: SourceId[] }>;
}

/** The values over one stretch of valid time on a state table. values: null = no value over this stretch. */
interface Span extends Interval { values: Values | null }
```

Example:

```json
{ "kind": "privacy", "sources": ["s_2"] }
```
```json
{
  "confirm": "dc_8ZqK1v…", "confirm_expires_at": "2026-11-11T09:20:00+08:00", "slot": "ledger", "kind": "privacy",
  "totals": { "sources": 1, "rows": 1, "derived": 1 }, "total": 1,
  "rows": [{
    "target": { "table": "ledger.expenses", "row": "r_01JC8Z…" }, "result": "fields_reverted",
    "after": { "values": { "date": "2026-11-10", "category": "Dining", "amount": { "value": "45", "unit": "CNY" } } },
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

When it goes back to a backfill value from a schema switch (there is no write to point to), an entry of `reverted_to` is:

```json
{ "currency": { "value": "CNY", "schema_const": { "sv": 3 }, "reason": "later_write_removed" } }
```

### 4.8 `pending`

```ts
interface PendingParams extends CommonParams, PageParams {
  id?: ItemId | JobId;           // when given, show the details
  slot?: SlotName;
  type?: ItemType;
  status?: ItemStatus | "all";   // default open; ordered by pending duration, longest first
}

type ItemType   = "awaiting_confirmation" | "flagged" | "conflict" | "schema_change" | "deletion" | "migration_diff" /* @later */;
type ItemStatus = "open" | "resolved" | "superseded";

interface PendingListResult extends CommonResult, PageResult {
  items: Array<{
    id: ItemId; type: ItemType; status: ItemStatus; slot: SlotName;
    target?: ItemTarget;
    reason: ItemReason;
    opened_at: Instant; opened_by: Actor;
    overdue?: true;              // deletion: past its expiry but not yet physically erased
    blocked?: true;              // the target is affected by a deletion that is still waiting to be executed, so the item cannot be handled now; the cause and the expiry time are in blocked in the details
  }>;
}

type PendingDetailResult = CommonResult & ItemDetail;

type ItemDetail = AwaitingDetail | FlaggedDetail | ConflictDetail | SchemaChangeDetail | DeletionDetail;

interface ItemBase {
  id: ItemId;
  item_ver: ItemVer;             // viewing the details counts as having read it
  status: ItemStatus;
  slot: SlotName;
  reason: ItemReason;
  opened_at: Instant; opened_by: Actor;
  /** The ways of handling it that the current credential may use. Empty for a closed item. A deletion item whose grace period has passed but whose tombstone is not yet recorded (during deletion_overdue) is still open, and this is empty as well. Also empty when the target is affected by a deletion that is still waiting to be executed (blocked). */
  decisions: Decision[];
  /** The target is affected by a deletion that is still waiting to be executed (items other than deletion and schema_change): decisions is empty then, and any way of handling it reports
   *  invalid_argument (pending_deletion_target). deletions is ordered by operation number; expires_at is the latest expiry time among them. */
  blocked?: { reason: "pending_deletion"; deletions: ItemId[]; expires_at: Instant };
  /** Ways of handling that require a user session (when the slot policy specifies it). @later */
  user_session_only?: Decision[];
  resolution?: ItemResolution;                                        // status: resolved
  superseded?: { reason: SupersededReason; by?: Seq; at: Instant };   // status: superseded
}

/** How the item was settled, in two branches:
 *  Settled by a decision (resolve): when decision is take_candidate, candidate is the index of the chosen candidate in the item's candidates[] (once the item is resolved candidates[] no longer changes, so the index points to that one in this set);
 *  A deletion item executed at expiry (physical erasure): seq is the seq of the tombstone event (the head event of a system operation), and actor is always system, so it is not given. "Execute" is not a way of handling that the caller can choose, and it is not part of Decision. */
type ItemResolution =
  | { decision: Decision; candidate?: number; seq: Seq; at: Instant; actor: Actor; note?: UntrustedText }
  | { executed: true; seq: Seq; at: Instant; reason: TombstoneReason };

/** The target of an item. unit = the fields in the conflict unit; ["*"] = whether this row / this stretch exists. */
interface ItemTarget extends TargetRef { unit?: Array<FieldName | "*">; spans?: Interval[] }   // spans: the segments of the item's interval on a state table, in ascending order of start and not touching one another; only the first segment may have an open start (valid_from is null), and the whole of time is the single segment {valid_from: null, valid_to: null}

type ItemReason =
  | "overwrites_change_point"       // awaiting_confirmation: erases a recorded change point (including filling a value across a gap)
  | "referenced_row"                // awaiting_confirmation: revokes a row that is still referenced
  | "undo_includes_later"           // awaiting_confirmation: the undo reverts later writes together with it
  | "undo_hides_later"              // awaiting_confirmation: the revoke that the undo writes back would hide later writes (when this and the previous one both hold, the previous one is recorded)
  | "conflict_cleared_by_deletion"  // awaiting_confirmation: the deletion makes the conflict disappear, and the write is still high-impact
  | "policy_high_impact"            // awaiting_confirmation: tables / fields named by the slot policy @later
  | "duplicate_keys"                // flagged
  | "stale_write"                   // conflict
  | "restored_candidate"            // @later. conflict: a candidate put back after a deletion was cancelled; the original item was already resolved within the grace period, and this is the item opened separately for it
  | "schema_change"                 // schema_change
  | "request"                       // deletion: confirmed by the caller
  | "restored_unconfirmed"          // deletion: regenerated by system after a backup restore, with a new grace period given
  | "restored_pending"              // deletion: regenerated by system after a backup restore, keeping the original expiry time
  | "restored_executed";            // deletion: made up by system after a backup restore, and physically erased immediately

type SupersededReason =
  | "overwritten"              // a write that read the item's current version changed its target (by = that write)
  | "schema_switched"          // the schema has been switched, and the item involves a changed field
  | "draft_replaced"           // schema_change: a new draft was submitted for the same slot
  | "deleted"                  // all value sources or causes of the target and candidates were privacy-deleted
  | "deletion_cancelled"       // an awaiting-confirmation item generated because of a deletion no longer holds once the deletion is cancelled
  | "matched_changed"          // flagged: the matched row was revoked or changed (whether the writer had read the item is not considered)
  | "nothing_to_revert"        // awaiting_confirmation (the proposal is an undo): after judging again against the current state, there is nothing left to write back, hide or revert
  | "evidence_deleted"         // @later
  | "migration_failed";        // @later

type Decision =
  | "confirm" | "reject"                                   // awaiting_confirmation, schema_change
  | "keep" | "revoke"                                      // flagged
  | "keep_effective" | "take_candidate" | "take_previous"  // conflict
  | "cancel"                                               // deletion
  | "accept_all" | "rows" | "keep_rest_and_switch" | "abandon";   // migration_diff @later

interface AwaitingDetail extends ItemBase {
  type: "awaiting_confirmation";
  target: ItemTarget;
  /** The proposed content, one of three: set is field values; set: null is a revoke; when the proposal is a revert, set is not given and revert is given (cause undo_includes_later).
   *  What a revert will write back is not listed here: the writes that will be reverted are in impact.reverted, and the values gone back to are in the receipt after execution. */
  proposal: { seq: Seq; actor: Actor; intent: Intent; set?: Values | null; revert?: { undo: Seq; include_later?: boolean }; valid?: Interval };
  current: { values?: Values; spans?: Span[] };   // this row read at the operation number of the item version, with the same range as ConflictDetail.effective
  impact: AwaitingImpact;
}

/** What will be changed after execution. Within the range the item version is bound to. */
interface AwaitingImpact {
  /** valid on these two is given on state tables only: rows of event tables and timeless tables have no interval. */
  overwritten?: Array<{ field: FieldName; valid?: Interval; value: Value; seq: Seq; actor: Actor }>;  // the segments that will be overwritten
  filled_gaps?: Array<{ valid?: Interval; revoked_by?: Seq }>;                                         // the intervals without a value that will be filled (listed here only)
  reverted?: Array<{ seq: Seq; actor: Actor; fields: Array<FieldName | "*"> }>;                        // later writes whose result as read will change after confirmation, whether or not they are in the revert record (write-and-read, "Undoing a write"); fields: the fields whose result will change, "*" is a revoke; one entry means at least part of it will change
  referrers?: Array<TargetRef & { field: FieldName }>;                                                 // rows that still reference this row, one entry per reference field
}

interface FlaggedDetail extends ItemBase {
  type: "flagged";
  target: ItemTarget;
  /** Rows suspected of duplicating it: at most 10, ordered by most recent write. */
  related: TargetRef[];
  /** The set of duplicate_keys that matched, and the key values. */
  keys: FieldName[];
  matched_values?: Values;
}

interface ConflictDetail extends ItemBase {
  type: "conflict";
  target: ItemTarget;
  /** The side currently in effect: the state of this row at that time, read at the operation number of the item version, limited to the item's segments and the fields of the conflict unit (when the unit is "exists", the values of the whole row are given).
   *  On a state table the value in effect within the conflict interval may be given by several writes in segments: each segment of spans carries the write that gave it;
   *  values of null is used only when the entity has no value over this segment: for a segment that was never written, seq and actor are not given; for a segment that an operation left without a value (a gap left by a revoke, an undo's write-back, a clearing write or
   *  a take_previous write-back leaving a required field without a value; on a table with no required fields, no field has a write in effect over this segment, where clearing also counts as a write, and a segment that has only been cleared has a value whose fields are empty), the operation that left this cell without a value is given (when both a revoke and an undo's no-value write-back are present on the same segment, the one with the larger operation number is taken: this segment had a value before it), as the cell of the version table says,
   *  and a revert that comes after the segment already has no value does not change it. Where the entity has a value but the unit's field was never written over this segment, the field is empty and there is no gap: this field is null in values,
   *  and seq is not given for this field.
   *  The top-level seq / actor is the one with the largest operation number among these segments (event tables and timeless tables have only one); not given when no operation gave any segment.
   *  After a revoke is undone, "who gave it" differs between the two kinds of table: on event tables and timeless tables it is that undo (it makes the row exist again);
   *  on state tables it is the write that originally gave the value for this segment (the undo only makes those values take effect again). The asymmetry comes from the version table: undoing a revoke records a cell for "exists" on event tables and timeless tables and records none on state tables; this follows the cells and does not seek consistency. */
  effective: { seq?: Seq; actor?: Actor; values?: Values; spans?: Array<Span & { seq?: Seq; actor?: Actor }>; exists: boolean };
  candidates: Candidate[];
  /** When the cause is restored_candidate: the item the candidate was originally in. @later */
  related_item?: ItemId;
  /** What take_previous would go back to: the values at the merge base (the earliest of the ver values the candidates carry), this row read at the operation number of the merge base, with the same range as effective. */
  previous: { seq: Seq; exists: boolean; values?: Values; spans?: Span[] };
  /** The writes that take_previous would revert: all writes that took effect on this conflict unit after the merge base; and the writes outside the unit that gave a value within the item's interval after the merge base
   *  and would lose their value when take_previous returns this segment to having no value (when this segment has no value at the merge base, see cause three of ④ in "Time · High-impact writes"). */
  reverted_by_previous: Array<{ seq: Seq; actor: Actor; fields: Array<FieldName | "*"> }>;   // writes later than the merge base whose result as read would change if the row went back to the merge base now; the same basis as AwaitingImpact.reverted (write-and-read, "Undoing a write" judges that one by the result that can be read), and the same shape
  /** When a candidate would be high-impact if it took effect: the content that would be overwritten. take_candidate is the confirmation of it. */
  candidate_impact?: Record<string /* index of the candidate */, AwaitingImpact>;
}

interface Candidate {
  /** The index of the candidate in the item; used to identify it for take_candidate. Not reused during the item's lifetime.
   *  One candidate = all the parts that one write became a candidate for on this conflict unit (several fields in a field group and several segments on a state table all count as the same candidate),
   *  and it is adopted as a whole. The k in candidates/<k> in the event format is this one. */
  index: number;
  seq: Seq;                      // the write number of the write the candidate is in
  actor: Actor;
  intent: Intent;                // a revoke candidate has no values
  ver: Ver;                      // the version it carries
  values?: Values;
  valid?: Interval;              // state tables: the candidate's interval (resolved against the version it saw). When several segments are not connected, it is their overall range; the per-segment results are in candidate_impact and the timeline
  cause: "stale_write" | "displaced_by_rule" /* @later */;   // why it is a candidate
  level?: SourceLevel;
  literal?: "hit" | "miss" | "na";
}

interface SchemaChangeDetail extends ItemBase {
  type: "schema_change";
  draft: DraftId;
  target_sv: Sv;
  changes: SchemaChange[];       // 5.3
  impact: SchemaImpact;          // the estimate when the draft was submitted, not within the range the item version is bound to
  migration?: MigrationStatus;   // after confirmation, while the migration is in progress or when it fails. A resolved item can always be looked up by ID
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
  /** store: logically_deleted → physically_deleted. backups: retained → expired. */
  state: "logically_deleted" | "physically_deleted" | "retained" | "expired";
  since: Instant;
  due?: Instant;                       // the expected time of the next state; not given for backups when there are no managed backups
  overdue?: true;                      // past its expiry but not yet physically erased
  deferred_to_next_start?: true;       // local mode: postponed to the next start when the service was not running
  managed?: boolean;                   // backups: false = not managed by saveslot (for example system-level backups)
}
```

Example (details of a conflict item):

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
## 5. Write operations

### 5.1 `write`

```ts
type Intent = "insert" | "update" | "correct" | "revoke" | "applied_by_rule" /* appears only in results; @later */;

/** The intent of one version in the history: the intent of a write, or one of three other version intents: the versions produced by a deletion confirmation, by canceling a deletion, and by a schema switch (same names as event format 6.2). */
type VersionIntent = Intent | "deletion" | "deletion_cancelled" | "schema_switch";   // schema_switch: a version added by a constant backfill when the schema switches

interface WriteParams extends WriteCommonParams {
  /** The schema version obtained when reading or querying the catalog. Should be passed back; when not passed, the fallback applies. */
  sv?: Sv;
  /** Request-level evidence segments, shared by several ops. */
  evidence?: EvidenceSegment[];
  /** Operations within the same slot, executed in order, as one transaction in total. At least one. */
  ops: WriteOp[];
  mode?: "job";                  // @later
}

interface WriteOp extends EvidenceOnOp {
  /** insert: a new row; update: the situation changed, or something is added; correct: the original value was wrong to begin with; revoke: this row should not exist. May be omitted when revert is given. */
  intent?: "insert" | "update" | "correct" | "revoke";
  table: TableName;
  row?: RowId;
  entity?: EntityId;
  /** State tables are written by natural key: if the entity exists it is written, otherwise it is created. The intent is update. */
  entity_key?: Record<FieldName, Value>;
  /** Write by external key (event tables and timeless tables, when external_key is declared): give the values of all key fields; if the row exists it is updated by three-way comparison, otherwise it is added.
   *  The intent is update or correct; no ver, no row, no premises.
   *  Exception: when adding a key to a row that has no external key, give it together with row and ver (an ordinary update). */
  external_key?: Record<FieldName, Value>;
  /** Gives a newly inserted row a temporary name ("p1"); later refs and premises in the same request write "@p1". An op by external key may also carry it: when a row is added it binds the new row, on a hit it binds the row that was hit, when skipped it binds nothing.
   *  1 to 64 letters, digits, _, -; only for insert and for ops by external key; any other op that carries it reports invalid_argument / mutually_exclusive (param points to ops/<i>/as); a duplicate name in the same request reports invalid_argument / duplicate_name. */
  as?: string;
  /** The version obtained when this row / entity was read. update / correct / revoke should pass it back; when not passed, the fallback applies; not needed for a row / entity created in this request. May be omitted with revert: {undo}: undo does no version conflict judgement.
   *  An op by external key does not carry it (carrying it reports invalid_argument / mutually_exclusive). */
  ver?: Ver;
  /** Field name → value. Writing null as a value clears an optional field. Mutually exclusive with revert; revoke does not carry it. May be omitted when update carries premises (restate, clear). */
  set?: Values;
  /** Replaces set. */
  revert?: { undo: Seq; include_later?: boolean } | { to: Seq; fields: FieldName[] } /* @later */;
  /** State tables only. The starting point, inclusive. Not passed = now (for correct with neither end passed, see section 5 of 04-contract). */
  valid_from?: BizTime;
  /** State tables only. The end point, exclusive. A date / instant; "next_change" (default: reaches to the next recorded change); "open" (continues indefinitely). */
  valid_to?: BizTime | "next_change" | "open";
  /** ["overwrite"]: a high-impact overwrite that has been confirmed with the user takes effect directly. Valid only when this op explicitly carries the current ver. Not exposed through MCP. */
  acknowledge?: Array<"overwrite">;
  /** Other rows, already read, that this write used (the premises of the write). At most 16. An op that carries revert, revoke, and an op by external key cannot carry it.
   *  An update may carry only premises and no set: the values stay unchanged, and it restates that this row still holds on the basis of these.
   *  premises: [] means clearing the premise declarations of this row. */
  premises?: PremiseRef[];
}

/** One premise. The target is written like Target: exactly one besides table; there is no way to locate it by external key. */
interface PremiseRef {
  table: TableName;                        // a base table of the same slot
  row?: RowId | string;                    // event tables, timeless tables; may also be the temporary name of a row created in this request, "@p1"
  entity?: EntityId;                       // state tables
  entity_key?: Record<FieldName, Value>;   // state tables, by natural key
  fields?: FieldName[];                    // which fields were used. Not given = the whole row (any field, and whether the row exists)
  ver?: Ver;                               // the version obtained when it was read. When not passed, the fallback applies (premise_ver_fallback)
  /** State tables only: what was used is the value at this point / over this stretch of valid time; the two are mutually exclusive. When neither is given, if the row declaring the premise has a valid time of its own, that is taken; if not, it is "from now on". */
  valid_at?: BizTime;
  valid_during?: [BizTime, BizTime | null];
}

interface WriteResult extends CommonResult {
  /** saved: all fields have taken effect (also when flagged items were generated). pending: some field became a candidate or went to awaiting confirmation. A skipped op by external key does not affect it. */
  status: "saved" | "pending" | "job" /* @later */;
  sv: Sv;
  /** The write number of this write. Not given when all ops in the request are by external key and unchanged / skipped, since no event is produced. */
  seq?: Seq;
  /** One-to-one with the ops of the request. In the receipt of an idempotent replay, an op by external key that did not enter an event gets only its index (omitted contains "unrecorded_ops"). */
  ops: Array<OpResult | { op_index: number }>;
  derived: DerivedChange[];      // at most 20
  /** First receipt: the total number of affected derived field entries. Idempotent replay: derived is empty, and this is the number of derived writes of this operation (one per partition), and omitted contains derived_values. */
  derived_total: number;
  pending: PendingRef[];
  superseded: Array<{ item: ItemId; type: ItemType; reason: SupersededReason }>;   // why the write superseded the item: overwritten or matched_changed
  affected_reads?: AffectedReads;
  /** Changes, on the rows this operation changed, to premises declared by other rows. Not given when there are none. */
  premise_affected?: PremiseAffected;
  /** Counts only ops by external key; not given when the request has none. On an idempotent replay, if the request has an op by external key that did not enter an event (an empty number in the log), the two entries unchanged and skipped are not given (omitted contains "unrecorded_ops"); those that exist are given as usual (both are 0). */
  external_key_summary?: { created: number; updated: number; unchanged?: number; pending: number; skipped?: number };
  /** A resend that hits the request key: nothing new is written, and the receipt is rebuilt from the log. Here pending[] gives the current state of the item and carries no item_ver; neither the ver nor the items in the receipt count as read.
   *  The premise parts (premises, premise_covered, premise_affected) are recorded in the metadata and rebuilt completely from the log; the flag state is the one at that time. */
  replayed?: true;
  /** The parts omitted from the receipt. It appears in two cases:
   *  replayed: what cannot be rebuilt from the log: affected_reads; derived_values (the values of derived fields before and after); before_values (the contribution the before value came from has been deleted);
   *    skipped_spans (the intervals of the parts an undo skipped);
   *    deleted_content (the part of this write's own content that has been deleted); unrecorded_ops (ops by external key that did not enter an event: unchanged, skipped);
   *    existing_keys (existing_keys and similar_keys: computed from the state at the moment of the write, not entered into events).
   *  The receipt exceeds the result budget of the surface: the write has taken effect, no error is reported, the receipt is truncated and the truncation is listed: field_results, derived_values, affected_reads, lists (the last entries of each list, including premise_affected.rows).
   *  The caller reads them itself when needed (history / query). */
  omitted?: Array<"affected_reads" | "derived_values" | "before_values" | "skipped_spans" | "deleted_content"
                  | "unrecorded_ops" | "existing_keys" | "field_results" | "lists">;
  original_deleted?: { deletion: ItemId };   // the original write hit by the replay has been deleted (its request key is listed by a pending deletion): nothing is written again, and the content is not echoed: ops is empty, omitted has deleted_content, only the original operation number and sv are given; when several deletions list it, the one confirmed first
  job?: JobId;                   // @later
}

/** How a similar key and an existing key are written: a single-field key is one UntrustedText; a multi-field key is "field name → text of the value". */
type EntityKeyText = UntrustedText | Record<FieldName, UntrustedText>;

interface OpResult {
  target: TargetRef;
  as?: string;                   // the temporary name
  intent: Intent;
  /** When some field took effect, the new ver; when none took effect or the value is the same, the original ver. Not given when an op by external key is skipped and hits no row. */
  ver?: Ver;
  /** Carried only by an op by external key: the outcome of this op (04-contract 5.4). */
  outcome?: "created" | "updated" | "unchanged" | "pending" | "skipped";
  /** When outcome is skipped: revoked = hit a revoked row (with revoked_by); pending_deletion = the key is held by a deletion within its grace period (with deletion);
   *  ref_skipped = used the temporary name of a skipped op (with ref_op). These are taken from the current state at write time and do not enter events. */
  skip_reason?: "revoked" | "pending_deletion" | "ref_skipped";
  revoked_by?: Seq;
  deletion?: ItemId;             // pending_deletion: the deletion that freezes this key; when several items freeze it at once, the earliest confirmed one is given
  ref_op?: number;               // ref_skipped: the index of the op that the temporary name belongs to
  created_entity?: true;
  /** When created_entity: the entity keys that already exist in the table, at most 10. Similar keys first, the rest by most recent write. */
  existing_keys?: EntityKeyText[];
  /** When created_entity: existing keys written similarly to the new key, at most 5, ordered by level (fold, affix, edit), edit distance, most recent write, entity ID; not given when there are none.
   *  Criterion keymatch@1 ("Similar keys" in the data model). revoked: at the moment of the write this entity has no value at any point in time (revoked as a whole, or interval revokes cover all periods that had values). All of them appear at the start of existing_keys. */
  similar_keys?: Array<{ key: EntityKeyText; match: "fold" | "affix" | "edit"; revoked?: true }>;
  /** Results per field. For revoke, and when the target is "existence", the key is "*". The parts skipped by an undo are not here; they are in undo.skipped_superseded.
   *  Event tables, timeless tables: one result per field.
   *  State tables: each field is an array sorted by interval, each segment with its own result and interval (except the noop segment: it only says that this field did not change this time, and the log records only the field, not the interval)
   *  (usually only one segment; cases with several segments: undo / take_previous writes back several different old values,
   *  or in the interval of a corroboration, part still has the same value and part has been changed by someone else).
   *  Not given for an op by external key when outcome is unchanged or skipped; may be empty for an op that restates or clears premises. */
  fields?: Record<
    FieldName | "*",
    FieldResult | Array<Extract<FieldResult, { result: "noop" }> | (Exclude<FieldResult, { result: "noop" }> & { valid: Interval })>
  >;
  /** State tables: the interval resolved for each field. When a field has several entries, this is their overall extent; the interval of each entry is in the array in fields. */
  resolved?: Record<FieldName | "*", ResolvedInterval>;
  undo?: {
    of: Seq;
    skipped_superseded: Array<{ field: FieldName; valid?: Interval; by: Seq; actor: Actor }>;   // the receipt of an idempotent replay has no valid (the log does not record the skipped intervals), and omitted contains "skipped_spans"
    reverted_later?: Array<{ seq: Seq; actor: Actor; fields: FieldName[] }>;   // entries marked later in the revert record; not counted the same way as the item's impact.reverted, see contract 5.3
  };
  /** One-to-one with the premises of the request. An empty array when clearing (premises: []). */
  premises?: Array<{
    target: TargetRef; fields?: FieldName[];
    ver: Ver;                        // the version seen that was actually adopted (when the fallback applied, the one it fell back to)
    state: "current" | "changed";    // changed: the premise had already changed at declaration time, so this row carries the flag as soon as it is written
    reason?: PremiseReason; since?: Seq;
  }>;
  /** How many other existing fields of this row the declaration of this op additionally covers; 0 when nothing is covered because the op did not take full effect. When clearing, the number of fields whose declaration was cleared. */
  premise_covered?: number;
}

/** The effect status of a field. The first five have the same names and meanings as the status of the event format. */
type FieldResultCode = "applied" | "candidate" | "awaiting" | "corroborated" | "noop" | "applied_by_rule" /* @later */;

/** The result code of one contribution in the timeline. One more than the write receipt, dropped: after the replay of a privacy deletion this item is no longer a contribution
 *  (it has the same value as the one before it and originally did not point to evidence; the write it reverted is gone; or its interval was merged into another item of the same field). Appears only in the timeline.
 *  Does not include noop: a no-op produces no version, and the timeline does not list fields with a no-op.
 *  removed: the content of this item has been removed by a deletion (in the grace period or carried out), and the entry carries removed: true as well; the two are either both there or both absent.
 *  It differs from dropped: dropped is one of the three cases above, no longer a contribution after the replay, with its content still there; removed is an item whose source data was deleted, its content unreadable,
 *  whether a contribution in effect that was taken away or a candidate or awaiting item whose evidence was deleted. After the deletion is cancelled, the original result code is back. */
type TimelineResultCode = Exclude<FieldResultCode, "noop"> | "dropped" | "removed";

type FieldResult =
  | { result: "applied";
      before?: Value;            // not given when added, or when there was no value here before
      after?: Value;             // not given when a revert writes back "no value" (no_value) or only makes the reverted write stop taking effect (uncovered)
      no_value?: true; uncovered?: true;
      merged?: true;             // the ver passed back is not the current version, but nobody touched this field after it: merged automatically
      overwritten?: Array<{ valid: Interval; value: Value | null; seq: Seq }> }   // state tables: the segments that were overwritten or cut apart
  | { result: "corroborated" }   // the same value with evidence explicitly pointed to: a source is appended, no new version
  | { result: "noop" }           // the same value, no evidence pointed to: not a change made by this write. The log does not keep its value
  | { result: "candidate";
      item: ItemId;
      valid?: Interval;          // the interval of the candidate
      effective: Value | null;   // the value currently in effect
      current_ver: Ver;          // the version currently in effect. Does not count as read, and does not take part in the fallback
      by?: { seq: Seq; actor: Actor };           // whose write, and which one, changed it, as things stand at the end of this request (the same moment as effective and current_ver): among the operations that gave a state in each segment of the candidate interval (a cell with an origin: the source of a value, or of being cleared; where there is no value, the operation that left that cell without a value: a revoke, the write-back of an undo, a clearing write or the write-back of take_previous, judged per cell; where a revoke and a no-value write-back are both present on the same segment, the one with the larger operation number; segments that were never written do not count; not given when no segment counts), the one with the largest operation number (same as ConflictDetail.effective); effective is the current value of this field on the segment where by lies (when by gives several segments, the earliest one in time): when the conflict unit has only this field, it is the value that write by gave; when the unit has several fields (such as "existence"), by is the latest giver in the unit while effective is still the value of this field, and the two may come from different writes; when that segment has no value, by is a revoke, or the unit is "existence" itself, effective is null; for the full picture of the segments see ConflictDetail.effective.spans
      previous: ConflictDetail["previous"];
      impact?: AwaitingImpact }                  // when the candidate would be high-impact if it took effect
  | { result: "awaiting"; item: ItemId; impact: AwaitingImpact }
  | { result: "applied_by_rule"; item: ItemId; before: Value; after: Value };   // @later

/** The resolution result of one field in the receipt's resolved; the first receipt and a replay give the same content from the log (the original parameters of the write header and the interval of each item in the base write).
 *  Cases where it is not given: a field with a no-op (the log keeps only the field name, with no interval); an undo op (the interval is obtained from the write-back, not resolved from the parameters, and the whole op has no resolved);
 *  an op whose original parameters have been privacy-deleted (the whole op has none, listed under deleted_content).
 *  "*" (the "existence" of a revoke) gives from_as, to_as and the interval, and does not give next_change: Value is not defined for "existence". */
interface ResolvedInterval extends Interval {
  /** How the caller gave the start and the end (same names as mode in the event format). corrected_span = correct with neither end passed: the span that contains "now" and is bounded by stop points. */
  from_as: "given" | "now" | "corrected_span";
  to_as: "given" | "next_change" | "open" | "corrected_span";
  /** The step that starts at the end point and that this write did not change (value is null when there is no value): given when to_as is next_change and the end point is not "continues indefinitely",
   *  or when to_as is given and a recorded step (with or without a value) still starts at the end point; not given when nothing is recorded after the end point. As of the state when this operation completed. */
  next_change?: { at: BizTime; value: Value | null };
  /** The intervals without a value that this write filled: within the part that took effect, the segments where the entity had no value before this op, however it came to have none (before the first segment of the entity, after an explicit end point, a hole left by a revoke,
   *  "Time · Intervals without a value" in the data model), with adjacent ones joined into one segment. "Before this op" includes the ops ahead of it in the same request: the parts of them that have already taken effect count as usual:
   *  where an earlier op gave a value it does not count as filled, and a hole an earlier op revoked out does count. Not given for an entity this op creates (it did not exist before); given as usual for one an earlier op creates.
   *  Lists only the segments that have taken effect and have been filled: the parts awaiting confirmation and the candidate parts are not yet filled, so they are not given; what they would fill once confirmed is in impact.filled_gaps. */
  filled?: Interval[];
}

interface DerivedChange {
  table: TableName; key: Record<FieldName, Value>; field: FieldName;
  before: Value | null; after: Value | null;
}

interface PendingRef {
  id: ItemId; type: ItemType; reason: ItemReason;
  item_ver?: ItemVer;            // carried only by an item newly generated in this write whose content the receipt gives in full (counts as read)
  merged?: true;                 // merged into an existing item: carries no item_ver, so the details must be looked at first
  refreshed?: true;              // this write changed the target of an open item that had not been read, or did not change it but the recomputed content changed: the item is refreshed and stays open
  /** Given only in a replayed receipt: the state of the item now; for a resolved one, with how it was handled. */
  state?: "open" | "resolved" | "superseded";
  decision?: Decision;
}

interface AffectedReads {
  count: number;                 // does not include the read that the ver carried by this write came from
  by_reason: Partial<Record<AffectedReason, number>>;
  covered_since: Instant;        // the moment up to which read records are kept: earlier reads are not counted
  /** The number of reads in count that can only be counted as "possibly affected": matched by a table-level record or by a version set ("Querying the reads a correction affects" in the data model). Not given when there are none. */
  possible?: number;
  not_covered?: Array<"derived_reads">;
}

/** Changes, on the rows an operation changed, to premises declared by other rows. Appears in the write receipt, in the write of resolve, in the result of delete, and in the cancelled of a deletion cancellation; in deletion_preview it is a forecast. */
interface PremiseAffected {
  count: number;                     // the number of dependent rows newly flagged because of this operation (a revoked dependent row is counted and listed all the same)
  matched: number;                   // the number of dependent rows whose flag was removed because of this operation
  /** The number of dependent rows by reason; when a row counts under several reasons at once, it is counted once for each, so the sum of the entries can exceed count. */
  by_reason: Partial<Record<PremiseReason, number>>;
  /** The newly added flags, per entry: one entry for each flagged declaration on each dependent row (the same row can appear several times), at most 20 (at most 50 in deletion_preview and delete);
   *  count is still the number of rows. When the receipt exceeds the result budget this is a list that may be truncated. */
  rows: Array<{ target: TargetRef; fields: FieldName[]; declared: { seq: Seq; actor: Actor } }>;
}
```

Example 1, adding a row (request and receipt):

```json
{
  "sv": 1,
  "evidence": [{ "kind": "user_message", "text": "Lunch today cost 45 CNY" }],
  "ops": [{ "intent": "insert", "table": "expenses",
    "set": { "date": "2026-11-10", "category": "Dining", "amount": { "value": "45", "unit": "CNY" } } }]
}
```
```json
{
  "status": "saved", "sv": 1, "seq": 21,
  "ops": [{
    "target": { "table": "ledger.expenses", "row": "r_01JC8Z…" }, "intent": "insert", "ver": "v21.0",
    "fields": {
      "date": { "result": "applied", "after": "2026-11-10" },
      "category": { "result": "applied", "after": "Dining" },
      "amount": { "result": "applied", "after": { "value": "45", "unit": "CNY" } }
    }
  }],
  "derived": [{ "table": "ledger.monthly_total", "key": { "month": "2026-11-01" }, "field": "total",
    "before": null, "after": { "value": "45", "unit": "CNY" } }],
  "derived_total": 1, "pending": [], "superseded": []
}
```

Example 2, the version does not match and the write becomes a candidate:

```json
{
  "sv": 1,
  "evidence": [{ "kind": "user_message", "text": "The taxi was 32 CNY" }],
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

Example 3, a state table, default end point:

```json
{
  "sv": 2,
  "evidence": [{ "kind": "user_message", "text": "Actually the dining budget dropped to 3000 starting November 2" }],
  "ops": [{ "intent": "update", "table": "budgets", "entity_key": { "category": "Dining" }, "ver": "v52.0",
    "valid_from": "2026-11-02", "set": { "amount": { "value": "3000", "unit": "CNY" } } }]
}
```
```json
{
  "status": "saved", "sv": 2, "seq": 55,
  "ops": [{
    "target": { "table": "ledger.budgets", "entity": "e_01JCB2…", "entity_key": { "category": "Dining" } },
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
/** The only evidence is evidence and evidence_by_field: resolve has no request-level evidence and does not accept evidence_refs.
 *  The indexes of evidence_by_field count into the evidence array of this request; when handling a triggered write, it points out, per field, the evidence of that write. */
interface ResolveParams extends WriteCommonParams, Omit<EvidenceOnOp, "evidence_refs"> {
  id: ItemId;
  decision: Decision;
  /** The item version that was read. When not passed, the fallback applies; the cancel of a deletion does not need to pass it. */
  item_ver?: ItemVer;
  /** Only for the take_candidate of a conflict: which candidate is adopted (its index). May be omitted when there is only one candidate. */
  candidate?: number;
  /** A note. When note is passed, the resolve request itself is stored as an api_call source (whether or not it triggers a write, and whether or not it also carries evidence),
   *  the resolution event references it as its operation source; resolution.note in the item details and in the details of the item_closed error is echoed from it. It is cleared by an ordinary privacy deletion (deleting this source), and after the clearing resolution no longer carries note. */
  note?: UntrustedText;
  diff_upto?: number;            // @later: accept_all of migration_diff
  rows?: { accept?: RowId[]; reject?: RowId[]; set?: Record<RowId, Values> };   // @later: row-by-row handling of migration_diff
}

interface ResolveResult extends CommonResult {
  id: ItemId;
  type: ItemType;
  decision: Decision;
  item_ver: ItemVer;             // the new version after resolution
  status: "resolved";
  /** When the handling triggered a write: same shape as the corresponding part of the write receipt. */
  write?: Pick<WriteResult, "seq" | "sv" | "ops" | "derived" | "derived_total" | "pending" | "superseded" | "affected_reads" | "premise_affected" | "omitted">;
  /** take_previous: the writes it reverted, as listed in ConflictDetail.reverted_by_previous in the item version that this decision confirmed (a replayed receipt reads the same copy, not recomputed from the current state). */
  reverted_by_previous?: Array<{ seq: Seq; actor: Actor; fields: Array<FieldName | "*"> }>;
  /** schema_change: on confirm, switched and the new sv (or the migration status); on reject, switched: false.
   *  slot: when this switch carries rename_slot, the name of the slot in the version switched to (taken from the compiled definition of that version, not from the current slot name: if it is renamed later, resending the same request gets the same receipt); not given when there is no rename. */
  schema?: { switched: boolean; sv?: Sv; slot?: SlotName; migration?: MigrationStatus };
  /** The cancel of a deletion. */
  cancelled?: {
    rows: Array<{ target: TargetRef; ver: Ver }>;                       // the new ver of the affected rows / entities
    reverted: Array<{ seq: Seq; target: TargetRef }>;                   // the writes returned to their original state
    restored: ItemId[];                                                 // the items that were restored
    kept_superseded: Array<{ item: ItemId; by: Seq }>;                  // the items that stay "superseded", and the writes that changed them
    kept_effective: Array<{ seq: Seq; target: TargetRef; by: Seq }>;    // writes that took effect because of the deletion and were taken as the baseline by other writes within the grace period: not returned
    /** @later: always an empty array in the first version (an item cannot be resolved on an affected row within the grace period; a candidate that was removed goes back to the original item that is still open, or closes together with the original item that has been closed).
     *  Candidates put back after cancelling a deletion, whose original item was resolved within the grace period: the result of judging again by the current state at the time of the cancellation, one entry per candidate.
     *  reopened: part of it still differs from the current value, so another conflict item was opened; corroborated: all of it is the same as the current value, and some of it pointed to evidence, so it becomes a corroboration;
     *  dropped: all of it is the same as the current value and none pointed to evidence, so it is no longer a change. */
    rejudged: Array<{ seq: Seq; target: TargetRef; from_item: ItemId;
                      result: "dropped" | "corroborated" | "reopened"; item?: { id: ItemId; item_ver: ItemVer } }>;
    derived: DerivedChange[];
    premise_affected?: PremiseAffected;   // the undo changed or restored the value of a premise: the dependent rows newly flagged and whose flag was removed
  };
  replayed?: true;
  /** The parts omitted from the receipt, with values from the same set as WriteResult.omitted: it refers to the receipt of the triggered write (write).
   *  What cannot be rebuilt from the log on a replay, or the parts truncated when the receipt exceeds the result budget of the surface. The operation number, the target, the new ver and the generated item IDs are not truncated. */
  omitted?: WriteResult["omitted"];
}
```

Example:

```json
{ "id": "pi_7C2E…", "decision": "keep_effective", "item_ver": "iv_4f81…" }
```
```json
{ "id": "pi_7C2E…", "type": "conflict", "decision": "keep_effective", "item_ver": "iv_9b02…", "status": "resolved" }
```

Adopting a candidate (triggers a write):

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
  /** The schema document (data-model "Schema document format"). When creating a slot, base_version: null. */
  document: SchemaDocument;
}

interface SchemaDraftResult extends CommonResult {
  draft: DraftId;
  slot: SlotName; slot_id: SlotId;
  target_sv: Sv;
  /** The document with IDs and inferred results filled in (types, units and dependencies of derived fields, the recompute scope). */
  document: SchemaDocument;
  changes: SchemaChange[];
  impact: SchemaImpact;
  /** applied: already in effect (a new slot, or a change that takes effect automatically under the slot policy). pending: a schema_change item was generated. */
  outcome: "applied" | "pending";
  sv?: Sv;                                   // outcome: applied and already switched: the new version (changes that only touch the catalog, and a new slot, switch on the spot)
  migration?: MigrationStatus;               // outcome: applied and a new physical table must be built in the background: sv is not given before the switch; progress is here and in notices
  item?: { id: ItemId; item_ver: ItemVer };  // outcome: pending. This receipt already gives the whole content of the item, so it counts as read
  superseded_draft?: DraftId;                // the older draft superseded by this submission
  replayed?: true;
  /** The receipt exceeds the surface's result budget: the draft is submitted, no error is raised, and the receipt is truncated with the truncation listed: changes (the last entries of the per-change list); document (the full document is cut; the text hint says to re-read it with the schema level of catalog and the draft).
   *  The draft ID, the target sv, the new sv and the generated item ID are not truncated. */
  omitted?: Array<"changes" | "document">;
}

interface SchemaChange {
  /** The name after the change: a renamed slot, table or field gives the new name (the name of rename_slot is the slot name after the change, the same convention as rename_table / rename_field). */
  target: { slot: true; name: SlotName } | { table: TableName; field?: FieldName; rule?: true };
  /** Which kind of change this is (see the table below). */
  change: SchemaChangeCode;
  /** Class: create creates a slot / table; metadata changes metadata only; deterministic is a deterministic conversion; reextract is re-extraction @later.
   *  A change that takes effect through restructure_unused (a table never written) is always metadata: there are no existing values and no conversion.
   *  The changes of the event format's schema.compiled have exactly the same keys as this type, except that target uses IDs instead of names. The class does not decide whether a new physical table is needed: that depends on whether the physical shape changes (the migration field). */
  class: "create" | "metadata" | "deterministic" | "reextract";
  /** Whether a write that carries the old sv and writes to this field is still accepted. Always false for an entry with as_never_written: after the switch, writes to this table that carry the old sv are rejected for the whole table. */
  compatible_with_old_writes: boolean;
  destructive: boolean;          // loses data (dropping a table or field, nulling out after a constraint is tightened, and so on). false on a table never written, where there are no values to lose
  auto: boolean;                 // can take effect automatically under the slot policy (the class this change belongs to is in auto_apply)
  /** This entry is compiled as "never written" (appears only on such entries, the value is always true, the class is always metadata): it holds only while the table has never been written.
   *  If the table has been written by the time of confirmation, the whole draft reports draft_outdated (table_written); after the switch, writes to this table that carry the old sv are always rejected (changed_fields gives "*"). */
  as_never_written?: true;
}

type SchemaChangeCode =
  // slot
  | "create_slot" | "rename_slot" | "change_timezone"
  // table
  | "add_table" | "add_derived_table" | "drop_table" | "rename_table"
  | "change_duplicate_keys" | "change_together" | "change_time_field"
  | "add_external_key" | "drop_external_key"
  // table: made only on a table never written; on a table that has been written, the whole draft reports not_in_this_version (reason: table_written)
  | "change_time_type" | "change_entity_key" | "change_granularity"
  | "change_table_kind"             // only one direction, base to derived; derived to base is not supported
  | "change_external_key"
  // fields of a base table
  | "add_optional_field" | "add_required_field" | "drop_field" | "rename_field"
  | "loosen_constraint" | "tighten_constraint" | "change_precision"
  | "change_unit" | "change_dimension" | "change_type"
  | "change_ref"                    // converting between a field and a ref, or changing the target of a ref: made only when the table holding this field has never been written
  | "declare_extends"               // declares conformance to an official schema (class metadata)  @later
  // derived table
  | "change_rule"
  // descriptions and aliases of tables, fields and derived fields
  | "change_description" | "change_aliases"
  // @later: when it appears in a draft, the whole draft reports not_in_this_version; it does not appear in results of the first version
  | "reextract";

interface SchemaImpact {
  rows_affected: number;
  derived_changed: Array<{ table: TableName; rows: number }>;
  /** Callers that most recently read or wrote a renamed / dropped field under its old name (inferred from the read and write records). */
  consumers?: Array<{ actor: Actor; field: string; last_used: Instant; used_for: "read" | "write" }>;  // 0.1.0 does not compute consumers when changing an existing slot and does not give it (a new slot gives an empty list: nobody has used a slot that was just created)
  /** A trial run of migrate / backfill. */
  trial?: { rows: number; failed: number; samples: Array<{ target: TargetRef; error: ValidationDetailCode }> };
  /** Derivation rules whose group key comes from a free-text field. */
  free_text_group_keys?: Array<{ table: TableName; field: FieldName }>;
  estimated_seconds?: number;
  sources_to_reextract?: number; // @later
}
```

The correspondence between change codes, classes and the automatic-effect categories (`auto_apply`) in the slot policy (the complete rules for each kind of change are in data-model "Kinds of change and means of migration"):

| `change` | `class` | Which `auto_apply` category it belongs to |
|---|---|---|
| `create_slot` | `create` | Always takes effect directly |
| `rename_slot` | `metadata` | — |
| `change_timezone` | `deterministic` | — |
| `add_table` | `create` | `add_table` |
| `add_derived_table` | `create` | `add_derived_table` |
| `drop_table` | `metadata` | — |
| `rename_table`, `rename_field` | `metadata` | `rename_unused` (when no connection other than the submitter has used it in the last 30 days) |
| `change_description`, `change_aliases` | `metadata` | `description` |
| `change_duplicate_keys` | `metadata` | `duplicate_keys` |
| `change_together` | `metadata` | — |
| `change_time_field` | `metadata` | On a table never written: `restructure_unused`; otherwise — |
| `add_external_key` (on a table that has been written, the key field must be a field added by the same draft), `drop_external_key` | `metadata` | On a table never written: `restructure_unused`; otherwise — |
| `change_external_key` | `metadata` | Made only on a table never written: `restructure_unused` |
| `change_time_type`, `change_entity_key`, `change_granularity`, `change_table_kind` (`base` to `derived`) | `metadata` | Made only on a table never written: `restructure_unused` |
| `add_optional_field` | `metadata` | `add_optional_field` |
| `add_required_field` | `deterministic` | On a table never written: `restructure_unused` (a `backfill` in constant form is still required); otherwise — |
| `drop_field` | `metadata` | On a table never written: `restructure_unused`; otherwise — |
| `loosen_constraint` (required to optional, relaxing `min` / `max`, adding an enum value, increasing `scale`) | `metadata` | `loosen_constraint` |
| `tighten_constraint` (optional to required, tightening `min` / `max`, removing an enum value) | `deterministic` | On a table never written: `restructure_unused`; otherwise — |
| `change_precision` (decreasing `scale`, changing `rounding`) | `deterministic` | On a table never written: `restructure_unused`; otherwise — |
| `change_unit` (same dimension) | `deterministic` | On a table never written: `restructure_unused`; otherwise — |
| `change_dimension`, `change_type` | `deterministic` | On a table never written: `restructure_unused`; otherwise — |
| `change_ref` (converting between a field and a `ref`, changing the target of a `ref`) | `metadata` | Made only when the table holding this field has never been written: `restructure_unused` |
| `change_rule` (including `time_dependency`) | `deterministic` | — |

"—" means confirmation is always required. The `outcome` of a draft is `applied` if and only if every change in it has `auto: true` (a new slot always does): whether the same change code is automatic depends on the table it is on.

- **"Never written"**: the log has no base write that targets this table (by table ID). A table that was written but whose rows have all been revoked, or whose content has all been privacy-deleted, does not count as never written; candidate and awaiting-confirmation writes also count as written.
- **`restructure_unused`** additionally requires that no connection other than the submitter has read or written this table by name in the last 30 days (the same "nobody is using it" as `rename_unused`); when someone has used it, these changes need confirmation. When a change is filed under it, there are no values to lose and no values to convert: `class` is always `metadata` (the `class` column in the table gives the class on a table that has been written; `class` records what this switch actually does), `destructive` is `false`, and `migrate` need not be given. Adding a required field and changing optional to required still need a `backfill` in constant form.
- After any change that takes effect through `restructure_unused`, writes to this table that carry the old `sv` are always reported as `schema_incompatible`, with `changed_fields` giving `{field: "*", change: <change code>}`. After a table is dropped, writes to it that carry an `sv` from before the drop are treated the same way, with `change` being `drop_table`.
- `change_type` and `tighten_constraint` on an external key field are not supported on a table that has been written (`not_in_this_version`): the converted values might collide.

Example (adding an optional field to `expenses`; under the default policy `add_optional_field` takes effect automatically):

```json
{ "document": { "slot": "ledger", "base_version": 1, "tables": [{
    "name": "expenses", "id": "t1", "kind": "base", "description": "One row per expense",
    "time": { "type": "event", "field": "date" },
    "fields": [
      { "id": "f1", "name": "date", "type": "date", "required": true, "description": "The day of the expense (a calendar day in the slot's time zone)" },
      { "id": "f2", "name": "category", "type": "text", "required": true, "description": "Category" },
      { "id": "f3", "name": "amount", "type": "quantity", "unit": "CNY", "required": true, "min": 0, "description": "Amount" },
      { "id": "f4", "name": "note", "type": "text", "description": "Note" },
      { "name": "payee", "type": "text", "description": "Payee" }
    ] }] } }
```
```json
{
  "draft": "d_2A7C…", "slot": "ledger", "slot_id": "sl_4KTZ…", "target_sv": 2,
  "document": { "slot": "ledger", "base_version": 1, "tables": [{ "name": "expenses", "id": "t1", "…": "…",
    "fields": [{ "id": "f1", "name": "date", "…": "…" }, { "id": "f5", "name": "payee", "type": "text", "description": "Payee" }] }] },
  "changes": [{ "target": { "table": "ledger.expenses", "field": "payee" }, "change": "add_optional_field", "class": "metadata",
    "compatible_with_old_writes": true, "destructive": false, "auto": true }],
  "impact": { "rows_affected": 0, "derived_changed": [] },
  "outcome": "applied",
  "migration": { "target_sv": 2, "state": "building" }
}
```

### 5.4 `delete`

```ts
interface DeleteParams extends WriteCommonParams {
  /** The dc_… returned by deletion_preview. Executes only; does not preview. */
  confirm: DeleteConfirm;
}

interface DeleteResult extends CommonResult {
  /** The deletion ID and the deletion item during the grace period are the same object. */
  deletion: {
    id: ItemId; item_ver: ItemVer; expires_at: Instant;
    cancel_with: { op: "resolve"; id: ItemId; decision: "cancel" };
  };
  seq: Seq;
  kind: "privacy" | "evidence" /* @later */;
  /** From totals to local_deferred: the preview content, recomputed from the state at confirmation. Every list the preview has is also in the receipt, with the same limits and _total as the preview (except rows, see below);
   *  rows additionally carries the new ver, and now_awaiting additionally carries the generated item. The rest is given by the receipt alone. */
  totals: { sources: number; rows: number; derived: number };
  rows: Array<DeletionRowResult & { ver?: Ver }>;    // a row / entity that still exists carries the new ver. At most 200 entries, with rows_total given separately
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
  premise_affected?: PremiseAffected;   // dependent rows whose premise value the deletion changed: premise_changed (reason: deleted) is already attached
  local_deferred?: true;
  derived: DerivedChange[];
  derived_total: number;
  states: DeletionState[];
  /** Metadata retained after the deletion. */
  retained_metadata: Array<"event_headers" | "row_existence" | "actors_and_intents">;
  replayed?: true;
  /** The receipt exceeds the surface's result budget: the deletion has taken effect, no error is raised, and the receipt is truncated with the truncation listed: rows (the per-row result details), derived (the last entries of the derived values),
   *  lists (the last entries of the other lists), premise_affected (premise_affected.rows). When rows is truncated, each row keeps only its target and new ver: the deletion ID, the operation number, the target, the new ver and the generated item ID are not truncated. */
  omitted?: Array<"rows" | "derived" | "lists" | "premise_affected">;
  reextract?: Array<{ target: TargetRef; fields: FieldName[]; job: JobId }>;   // @later
  cleared?: Array<{ target: TargetRef; fields: FieldName[] }>;                 // @later
}
```

Example:

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
    "after": { "values": { "date": "2026-11-10", "category": "Dining", "amount": { "value": "45", "unit": "CNY" } } },
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

## 6. Extraction jobs (`@later`)

`extract_claim` and `extract_submit` are not part of the first version. The shapes of the requests and results are in the JSON in section 10 of [`04-contract.md`](04-contract.md); the types are added to this document when they enter implementation.

---

## 7. Warnings and hints

```ts
/** A structured warning about some part of this call. op = the index into ops. */
/** Where the ver / sv obtained by fallback came from, exactly one of the two: a read, or a write receipt of this connection (the operation number of that write). */
type FallbackOrigin = { read: ReadId; from_write?: never } | { from_write: Seq; read?: never };

type Warning =
  | { code: "unit_converted"; op: number; field: FieldName; from: Quantity; to: Quantity }
  | { code: "rounded"; op: number; field: FieldName; from: string; to: string; scale: number }          // more decimal places than the field's scale; rounded according to rounding
  | { code: "timezone_assumed"; op?: number; field?: FieldName; param?: string; timezone: string }   // the instant carried no time zone; the slot's time zone was used
  | { code: "time_truncated"; op?: number; param: string; from: Instant; to: DateStr }               // a table with day granularity received an instant; the day it falls on was taken
  | ({ code: "ver_fallback"; op: number; ver: Ver } & FallbackOrigin)
  | ({ code: "sv_fallback"; sv: Sv } & FallbackOrigin)
  | { code: "item_ver_fallback"; item_ver: ItemVer; read?: ReadId }
  | { code: "renamed"; op?: number; table?: TableName; from: string; to: string }                    // an old name was used
  | { code: "multi_segment_unmapped"; op: number; fields: FieldName[] }                              // multi-segment evidence came without a field mapping
  | { code: "evidence_unreferenced"; evidence: number[] }                                             // a request-level evidence segment is not referenced by any op: when the request produced events, the new segment is still stored as source data (a source_ref segment adds nothing), but it is not the provenance of any value
  | { code: "overwrote_corroborated"; op: number; field: FieldName; valid: Interval; sources: SourceId[] }
  | { code: "pending_deletion_on_target"; op?: number; item: ItemId }                                // the target has a deletion that can be canceled
  | { code: "clock_behind_log"; behind_seconds: number }                                             // the entry instant is earlier than the recorded time at the end of the log
  | ({ code: "premise_ver_fallback"; op: number; premise: number; ver: Ver } & FallbackOrigin)   // the premise carried no ver; the one read most recently was used; premise = the index into premises
  | { code: "premise_already_changed"; op: number; premise: number; since: Seq }                     // the premise had already changed at the time of the declaration: this row carries premise_changed as soon as it is written
  | { code: "evidence_not_stored"; evidence: number[]; op_evidence?: Array<{ op: number; evidence: number[] }> }   // write: evidence segments were not stored. When the request produced no events (all ops are unchanged / skipped by external key): the request-level segments (evidence) and the segments inlined in each op (op_evidence, by op index and its evidence indexes). When events were produced: the segments inlined in ops by external key that did not enter an event (evidence is empty)
  | { code: "external_key_skipped"; ops: number[] }                                                  // write: some ops by external key were skipped (outcome: skipped)
  | { code: "external_key_resync"; rows: TargetRef[]; rows_total: number }                           // deletion_preview, delete, and the detail of a deletion item closed on expiry: the affected rows have external keys,
                                                                                                     // and after physical erasure saveslot does not remember the key, so when a connector syncs the same record again it reappears as a new row. rows has at most 50 rows
  | { code: "single_field_external_key"; table: TableName }                                          // schema_draft: the external key has only one field, so IDs may collide when several source systems write this table
  | { code: "group_key_free_text"; table: TableName }                                                // schema_draft: the group key of a derived table comes from a free-text field and is cleared along with the group on deletion
  | { code: "job_items_appended"; op: number; job: JobId };                                          // @later

/** Hints about this call, at most 3. Each kind is computed only within the caller's visible range: a slot outside the visible range does not appear in any hint. */
type Notice =
  | { code: "pending_items"; slot: SlotName; count: number; oldest_opened_at: Instant }       // open items in the slots this call involves: the count and the instant the earliest one arose. One per slot; a slot whose count is 0 is not given;
                                                                                                     // ordered by oldest_opened_at from earliest to latest, ties by slot name, the first 3. The result of pending does not carry it (it is itself listing items)
  | { code: "schema_updated"; slot: SlotName; from: Sv; to: Sv; changed: string[] }                  // the sv this connection last read is behind. changed: the targets of every switch between from and to,
                                                                                                     // compatible ones included, written as "table" or "table.field", using current names (a dropped one uses its name before the drop); changes to the slot itself
                                                                                                     // (rename, time zone change) are written as the slot's current name. Deduplicated and sorted by name
  | { code: "migration_progress"; slot: SlotName; target_sv: Sv; done: number; total: number; item?: ItemId }
  | { code: "deletion_overdue"; slot: SlotName; item: ItemId }                                       // a deletion that is due has not yet been physically erased
  | { code: "job_failed"; slot: SlotName; job: JobId };                                              // @later
```

---

## 8. Administrative operations

Except for `policy.get`, only given to user sessions; not exposed through MCP.

### 8.1 `connections.*`

```ts
type Scope = "saveslot.read" | "saveslot.write" | "saveslot.schema" | "saveslot.delete";

interface ConnectionsIssueParams {
  /** Recommended form: "device · agent". Unique under the same user; a duplicate reports invalid_argument (duplicate_name, param: "name"); compared code point by code point on the stored string, without case folding; the name of a revoked or disabled connection is still occupied (in the history one name refers to only one principal). */
  name: string;
  /** Must include saveslot.read. Default ["saveslot.read", "saveslot.write", "saveslot.schema"]: can read and write and can create slots, cannot delete; `saveslot.delete` must always be given explicitly.
   *  When an OAuth authorization request has no requested scope, ["saveslot.read", "saveslot.write"] is given (04-contract section 12). */
  scopes?: Scope[];
  /** Slot scope: an array of slot names or slot_ids. Not given = all (including ones created later). When given: each must exist (otherwise not_found / slot), and it must not be an empty array (invalid_argument / empty_slots).
   *  It cannot be changed after issuing. */
  slots?: SlotName[];
}

interface Connection {
  id: ConnectionId; name: string; scopes: Scope[];
  slots?: Array<{ slot: SlotName; slot_id: SlotId }>;   // slot scope; not given = all. Given but an empty array = the slots in the scope have all been removed, and no slot is visible (not all slots)
  via: "token" | "oauth";        // a local token / static token, or one OAuth authorization
  client?: string;               // the client identifier when via: oauth
  created_at: Instant;
  last_used_at?: Instant;        // not given in the first version (08-open-questions "The last-used moment of a connection")
  /** Consistent with Actor.state: given when revoked (revoked) or disabled because of an import (disabled); not given when valid. */
  state?: "revoked" | "disabled";
  revoked_at?: Instant;
}

interface ConnectionsIssueResult extends Connection {
  /** Returned only this once; saveslot stores only its hash. */
  token: string;
}

interface ConnectionsListParams { include_revoked?: boolean; limit?: number; cursor?: Cursor }   // include_revoked: true lists both revoked and disabled ones; by default neither is listed
interface ConnectionsListResult extends PageResult { connections: Connection[] }

interface ConnectionsUpdateParams { id: ConnectionId; name: string }   // can only rename. A revoked or disabled connection can also be renamed (the uniqueness check still applies); renaming to the current name records no event and returns the current result
interface ConnectionsRevokeParams { id: ConnectionId }
type ConnectionsUpdateResult = Connection;
type ConnectionsRevokeResult = Connection;                             // state is revoked and revoked_at is filled in; revoking again returns the same result
```

Example:

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
  policy_version: number;        // the policy version: increased by 1 on each change (the same name as in the event format)
  /** The rule for the value in effect during a conflict. The first version has only keep_current. */
  effective_value_rule: "keep_current" | "by_rank" /* @later */;
  /** The rank table of source levels. The first version only records it and does not use it. */
  rank: { user_stated: number; agent_inferred: number; miss: number };
  /** Which schema changes take effect directly without confirmation. The default policy has all eight on; a slot's policy is the full text written when it was created, and for a slot whose policy has no restructure_unused, this kind of change needs confirmation. */
  auto_apply: Array<"add_table" | "add_derived_table" | "add_optional_field" | "description"
                    | "rename_unused" | "loosen_constraint" | "duplicate_keys" | "restructure_unused">;
  /** Tables / fields additionally counted as high-impact. @later */
  high_impact?: Array<{ table: TableName; fields?: FieldName[] }>;
  /** Decisions accepted only from a user session. @later */
  user_session_only?: Array<{ type: ItemType; decision: Decision }>;
  set_by: Actor; set_at: Instant; seq: Seq;
}

interface PolicySetParams extends Omit<SlotPolicy, "policy_version" | "set_by" | "set_at" | "seq"> {}   // @later
```

### 8.3 `reads.list`

```ts
interface ReadsListParams extends PageParams {
  connection?: ConnectionId | string;   // ID or name
  slot?: SlotName; table?: TableName;
  of_task?: string;                     // filter: list only reads that carry this task identifier. On HTTP it is a query parameter of the same name; it is not CommonParams.task
  since?: Instant; until?: Instant;    // [since, until)
}

interface ReadsListResult extends PageResult {
  /** The instant up to which read records are kept. */
  covered_since: Instant;
  reads: Array<{
    read: ReadId; at: Instant; actor: Actor; task?: string;
    operation: "query" | "sql" | "history" | "sources" | "catalog" | "pending" | "deletion_preview";
    selfcheck?: true;            // the self-check when a connection is issued
    /** Given only when this read falls on one slot. */
    slot?: SlotName; sv?: Sv; table?: TableName;
    /** The rows and versions read. Only versions are given, not values. At most 50 entries, with the total given separately. */
    rows?: Array<{ target: TargetRef; seq: Seq }>;
    rows_total?: number;
    /** Tables where too many rows were read and the record was changed to a table-level record (data-model "Read records"): only the table and the position of the state seen by this read, with no per-row versions. */
    coarse?: Array<{ table: TableName; pos: Seq }>;
    valid?: { at?: BizTime; during?: [BizTime, BizTime | null] };   // the valid time asked about
    source?: SourceId;           // what was read is the original text of source data
  }>;
}
```

### 8.4 `log.verify` / `log.reconcile` / `export` / `import`

```ts
interface LogVerifyResult {
  events: number;
  chain: { intact: true } | { intact: false; broken_at: number /* the seq of the event */ };
  checksum_mismatch: Array<{ seq: number; path: string }>;   // the position of the content block; no content
  /** Events whose extracted index columns do not match the event header and the target block; not counted as a broken chain, and can be repaired by recomputing from the event header and the target block. Only positions are given. */
  index_mismatch: Array<{ seq: number }>;
  removed: number;                                            // the number of content blocks already removed by deletion
  /** Gaps in seq left by a restore; not counted as a break. */
  gaps: Array<{ after: number; before: number; restore: number /* the seq of the restore event */ }>;
}

interface LogReconcileResult {
  compared_to: number;           // the event seq compared up to
  /** Logical tables: all tables marked "replay comparison: yes" in architecture §8. mismatched is the number of rows with at least one inconsistency: state tables count by entity; a table that gives no row also counts by rows. */
  tables: Array<{ name: string; rows: number; mismatched: number }>;
  /**
   * The positions of inconsistencies: IDs only, values are not echoed. Each entry is a deduplicated (table, row, field, kind), one entry per place; at most 100 entries.
   * row is a row identifier without content, made only of primary key columns and never assembled from non-key columns: event tables and timeless tables give the row ID; state tables give the entity ID,
   * not the start of the valid interval; tables keyed by table ID (counts) give the table ID; tables whose primary key contains content (external_keys, request_keys and the like)
   * do not give row, only table and kind.
   */
  mismatches: Array<{ table: string; row?: string; field?: string; kind: "missing" | "extra" | "different" }>;
  /** The number of entries after deduplication, counted before truncating to 100. It counts by position while mismatched counts by row; the two differ in basis on purpose. */
  mismatches_total: number;
}

/** Import into an empty tenant. Given only to user sessions. The input is the byte stream of the export file (one file, or several segments cut by resuming with after, joined in order); there are no other parameters. */
interface ImportResult {
  tenant_id: string; previous_tenant_id: string;
  events: number;                 // the number of events imported
  seq: number;                    // the seq of tenant.imported
  restore_count: number;
  principals_disabled: number;
  slots: number;
  removed: number;                // the number of content blocks that were already "removed" at import
  pending_deletions: { executed: number; carried: number };   // those for which a tombstone was added; those still waiting to be executed
  exported_at: string;
  not_imported: Array<"read_log" | "credentials" | "external_files">;
}

interface ExportParams {
  after_seq?: number;                  // resume after a given event
  include_pending_deletion?: boolean;  // default false: content awaiting deletion during the grace period is replaced by a placeholder
}

/** NDJSON. The first line is the manifest, then one event per line. The shapes of the manifest and the event lines follow the event format specification (09-event-format.md section 8). */
interface ExportHeader {
  saveslot_export: 1;                  // the version of the export file format
  tenant_id: string;
  event_format: number;
  restore_count: number;
  after?: number;                      // resuming: this file contains only events whose seq is greater than it
  upto: number;                        // the seq of the last event in this file
  upto_hash: string;                   // the hash of the header of event number upto, written the same way as prev_hash
  events: number;                      // the number of events in this file
  exported_at: string;                 // UTC, millisecond precision (the instant notation of the event format)
  pending_deletions: "placeholder" | "included";
}
```

---

### 8.5 `log.end`

Given only to user sessions; no parameters. The end of the log: the `seq` and recorded time of the latest event; `recorded_at` has the same format as the other recorded times in the contract. `saveslot status` uses it to compare against the local clock (architecture §8: warn when the local clock is more than 5 minutes behind the end of the log).

```ts
/** null when the log has no event at all. */
type LogEndResult = { seq: Seq; recorded_at: Instant } | null;
```

### 8.6 `slots.remove`

Given only to user sessions. Removes an empty slot ([`04-contract.md`](04-contract.md) section 17).

```ts
interface SlotsRemoveParams {
  /** Accepts only slot_id: a name can be reused, and resending a removal by name would delete a newly created slot of the same name. A name given reports invalid_argument (param: "slot_id"). */
  slot_id: SlotId;
}

/** The state at the time of removal; removing an already removed slot again returns the same result (no event is recorded). */
interface SlotsRemoveResult {
  slot_id: SlotId;
  name: SlotName;     // the name at the time of removal
  sv: Sv;             // the current version at the time of removal
  removed_at: Instant;
}
```

Example:

```json
{ "slot_id": "sl_4KTZ8M2Q9VHB3XCD" }
```
```json
{ "slot_id": "sl_4KTZ8M2Q9VHB3XCD", "name": "spare", "sv": 1, "removed_at": "2026-11-19T10:00:00Z" }
```

## 9. Errors

```ts
interface ErrorEnvelope { error: ErrorObject }

interface ErrorObject {
  code: ErrorCode;
  /** One sentence for humans. It is untrusted text (05-surfaces section 5): it may carry content passed in by the caller; programs decide by code and reason and do not parse it. */
  message?: string;
  /** The finer cause. The values are in the table below. */
  reason?: string;
  /** The parameter that went wrong: a JSON-pointer-style path, such as "ops/0/valid_to". */
  param?: string;
  /** Per-entry details of validation errors. For one found only at judgement (`required_in_gap`), only the first rejected op is listed: later ops are no longer judged;
   *  within this op, one entry for each field and each segment. */
  details?: ValidationDetail[];
  /** After how long a retry is possible, in seconds. */
  retry_after?: number;
  /** The other accompanying fields are in the table below. */
  [extra: string]: unknown;
}

interface ValidationDetail {
  op?: number;                   // the index into ops
  table?: TableName; field?: FieldName;
  path?: string;                 // the position in the schema document: "tables/0/fields/2", "tables/1/rule/sql"; in a write, when the value is not the op's own, its position in the request (the key of a premise: "ops/0/premises/1/entity_key/category", where table is that premise's table)
  code: ValidationDetailCode;
  line?: number;                 // the line of the rule SQL
  valid?: Interval;              // required_in_gap: the interval in which the field is missing
  // table: write details always give it (this op's table), written the same way as the receipt's slot.table
  allowed_units?: string[]; allowed_values?: string[]; min?: string; max?: string;
  example?: Value;               // type_mismatch: a valid value for this field's type, written as in the set of ops. Unrelated to the value given this time; the correction computed for this value is suggestion, and the two may appear together
  rows?: number; samples?: TargetRef[];   // backfill_required: the number of violating rows and samples (at most 5, positions only, no values; state tables count by entity)
  referenced_by?: string[];      // still_referenced: the dependents. When the draft lists it, its position in the document (written like path); when it does not, the name (table.field, the table name for a derived table)
  reason?: "not_required"        // used only for key_not_applicable on the time.field of an event table: the field it points to is not required
    | "count" | "length" | "empty" | "control"
    | "surrounding_space" | "repeat" | "name";   // used only for alias_invalid: which rule is violated. count: more than 8; length: more than 64 characters (both carry max); empty: empty after normalization; control: contains a line break (including U+2028, U+2029) or a control character; surrounding_space: starts or ends with whitespace; repeat: duplicates an earlier alias of the same object; name: equals a name that is still resolvable in the same scope; when one item violates several, the first in this order is taken
  /** rule_sql_rejected, nondeterministic_function, unit_inference_failed, migrate_failed, rule_eval_failed: the finer cause, with the same set of values as the reason of sql_rejected. */
  sql_reason?: "syntax" | "not_select" | "function" | "node" | "system_time" | "unknown_name" | "type" | "limit" | "runtime";
  suggestion?: string;           // a machine-usable correction: such as the replaced SQL fragment; in a write, for a type_mismatch where a zoned_datetime was written as an object {instant, zone?}, the string that should be written (2026-11-12T09:30:00+08:00[Asia/Shanghai]; when no zone is written, the slot's time zone is used)
}

type ErrorCode =
  // domain errors (contract-core)
  | "invalid_argument" | "unknown_table" | "unknown_field" | "not_found" | "revoked"
  | "derived_readonly" | "validation_failed" | "read_first" | "schema_incompatible"
  | "too_large" | "sql_rejected" | "sql_timeout" | "draft_outdated" | "field_unmatched"
  | "confirmation_mismatch" | "item_closed" | "preview_outdated"
  | "referenced" | "lease_expired"                         // @later
  // outer errors (contract)
  | "unauthenticated" | "insufficient_scope" | "rate_limited" | "handle_expired"
  | "not_in_this_version" | "unavailable" | "internal"
  | "import_rejected";                                     // the administrative operation import

type ValidationDetailCode =
  // write
  | "type_mismatch" | "unit_missing" | "unit_unknown" | "unit_dimension" | "out_of_range"
  | "enum_value" | "required_missing" | "required_in_gap" | "ref_not_found" | "ref_wrong_table"
  | "malformed"                     // the decimal original text does not conform to JSON number syntax (04-contract section 1 "The encoding of values")
  | "empty_row"                     // an insert on an event table or a timeless table gave no field a non-empty value: a clearing cannot hold up a row by itself, and this row will not exist (carries op and table)
  // schema compilation
  | "reserved_name" | "duplicate_name" | "description_missing" | "unknown_type"
  | "entity_key_not_required" | "cross_slot_ref"
  | "rule_sql_rejected" | "nondeterministic_function" | "unit_inference_failed"
  | "backfill_required" | "untrusted_marker"
  | "migrate_failed"                // schema compilation: the trial run of migrate failed; write: during a migration, a write carrying the old sv failed to evaluate the conversion expression against the new version (path points to ops/<i>/set/<field>); re-read under the new version and write again
  | "backfill_const_required"       // adding a required field, or changing optional to required: a backfill in constant form must always be given (whether the table has rows is not considered)
  | "backfill_both_forms"           // both the constant form and the expression form of backfill were given
  | "still_referenced"              // the table or field to be dropped is still depended on (ref, rule, entity_key, external_key, time.field, duplicate_keys, together)
  | "name_renamed_away"             // a newly added table or field uses an old name that another item in the same draft renames away: whether it means the old one or the new one is not guessed
  | "external_key_table_kind"       // external_key is declared on a state table or a derived table
  | "external_key_field_type"       // the type of an external key field is not text, enum or integer
  | "external_key_existing_field"   // an external key is added on a table that has been written, and the key field is not a field added by the same draft
  | "external_key_in_together"      // an external key field appears in together
  | "rule_eval_failed"              // the derived refresh triggered by a write failed to evaluate (such as 64-bit integer overflow): the whole write is rejected and produces no event
  | "alias_invalid"                 // more than 8 aliases or more than 64 characters, empty after normalization, contains a line break or a control character, starts or ends with whitespace, duplicated within the same object, or equal to a name still resolvable in the same scope; reason says which
  | "unknown_reference"             // a field or table pointed to by name in the document does not exist (time.field, entity_key, external_key, together, duplicate_keys, ref.table)
  | "key_not_applicable"            // a key or its value is used on an inapplicable type or table (such as min on a text field, entity_key on a table that is not a state table, a ref.target that does not match the time type of the target table)
  | "out_of_bounds"                 // a value is out of bounds: min greater than max, beyond the range of the type, scale not within 0–12, too many items or too long
  | "duplicate_entry"               // a repeated item in the same list: a repeated enum value, the same field twice in a key list, one field in two together groups
  | "timezone_unknown";             // the slot's timezone is not a recognized time zone name
```

The accompanying fields of each error code:

| `code` | `reason` | Other accompanying fields |
|---|---|---|
| `invalid_argument` | `missing` / `malformed` (including a given `valid_to` that is not later than the start of the interval: also when the start is not given and "now" is used) / `ambiguous_table` / `mode_mismatch` / `mutually_exclusive` / `not_this_target` / `content_deleted` / `undo_target` (the target of `undo` is an insert or a first creation, a candidate or awaiting-confirmation write that never took effect, the operation number of a schema switch, or there is no change that can be undone: only a same-value corroboration was made, all are no-ops, and so on; see data-model "What write n is") / `event_table_valid_at` / `no_value_now` (a correction without an interval on a state table, where the field has no value at the point "now") / `no_time_table` / `not_state_table` / `state_table` (write: `row` was given on a state table) / `granularity` / `key_field_changed` / `insert_with_entity_key` / `candidate_required` / `derived_table` (the `changes` of `history` targets a derived table; `query` gave `valid_at` / `valid_during` on a derived table) / `pending_deletion_source` / `pending_deletion_target` (resolving an item or `undo` on a row / entity affected by a deletion during the grace period; with `target: TargetRef`, `deletions: ItemId[]` (sorted by operation number), `expires_at: Instant` (the latest expiry among them)) / `cross_slot` (the sources of a preview span slots; a premise points to a table visible in another slot; the ops of a write fall in different slots; the `source_ref` of evidence points to source data visible in another slot. `param` tells which one) / `idempotency_key_reuse` / `index_out_of_range` / `empty_mapping` / `operator_type` / `missing_read_scope` / `empty_slots` (`slots` is an empty array at issuing) / `slot_not_empty` (`slots.remove`: the slot has records under its name, or has an open schema change item) / `duplicate_name` (`connections.issue`, `update`: duplicate connection name; write: two ops in the same request have the same temporary name `as`) / `tenant_not_empty` (the target tenant of the import is not empty) / writes by external key: `insert_with_external_key` / `no_external_key` / `duplicate_external_key` / `external_key_in_use` / `external_key_not_transferable` / `external_key_transferred` / `premises_with_external_key` / premises of a write: `premise_self` / `premises_with_revert` / `premises_with_revoke` / `premise_historical_ver` / `premise_duplicate_target` (two premises of the same op resolve to the same target) / `premise_target_pending` (the premise points to a row newly created by this request, and that creation did not take effect at the end of the request; with `as?` and `op`) / `no_change` (`schema_draft`: the draft has no change compared with the slot's current version) | `param`; `candidates?: string[]` (the candidate table names of `ambiguous_table`); for `candidate_required`, `candidate_choices: Array<{ index: number; seq: Seq; actor: Actor }>` (the candidates of the item: index, the write it belongs to, the writer); `example?: object` (a complete correct example of that mode or that parameter); `allowed_values?: string[]` (when the parameter takes a limited set of values: the values accepted in the first version); for `duplicate_external_key`, `ops: number[]` (the indexes of the two ops with the same key); for `premise_duplicate_target`, `premises: number[]` (the indexes of the two premises pointing to the same target); for `external_key_in_use`, `deletions?: ItemId[]` (the key is frozen: all the deletions that freeze it) or `holder?: RowId` (the row that holds it and is not revoked); for `external_key_not_transferable` and `external_key_transferred`, `holder: RowId` (the row that holds, or now holds, this key); for `slot_not_empty` only because of an open schema change item, `cause: "open_schema_change"` and `item: ItemId` (which item to handle first) |
| `unknown_table` / `unknown_field` | — | `name`, `nearest: string[]` (only visible names, at most 3; an object whose alias equals `name` after the folding comparison of `keymatch@1` has its name first; the rest by edit distance after folding from small to large, ties by the `C` ordering of the name) |
| `not_found` | `row` / `entity` / `item` / `source` / `draft` / `connection` / `read` / `slot` / `route` (HTTP: no such endpoint) | `deletions?: ItemId[]` (when a row is removed entirely by a deletion during the grace period: all pending deletions that touch its contributions, sorted by operation number; content is not echoed); `sources?: Array<{id, state: "unknown" \| "pending_deletion" \| "removed", deletion?}>` |
| `revoked` | — | `target: TargetRef`, `revoked_by: Seq` (restore with `revert: {undo}`) |
| `derived_readonly` | — | `table`, `base_tables: TableName[]` |
| `validation_failed` | `write` / `schema` | `details[]`, `current_sv?` (the detail codes of `write` include `rule_eval_failed` and `migrate_failed`: during a migration, a write carrying the old `sv` failed to evaluate against the new version, and this write is rejected instead of making the switch fail) |
| `read_first` | `no_read` / `task_mismatch` | `target: "row" \| "item" \| "slot" \| "table"`, `ref?: TargetRef \| ItemId \| SlotName`; for `task_mismatch`, `read_task: string \| null` (the `task` of the read that was found; read under other `task`s more than once, the read of the latest position seen, and of those the least `task` by code point), `task: string \| null` (the `task` of this call); `null` means that read or this call carried no `task` |
| `schema_incompatible` | — | `current_sv`, `changed_fields: Array<{field, change}>` (a `field` of `"*"` means the whole table: this table's structure was changed through `restructure_unused`, or it has been dropped) |
| `too_large` | `evidence_segment` / `request` (the total bytes of evidence in one request) / `ops` (the number of ops in one write) / `evidence_segments` (the number of evidence segments in one request, including `source_ref` segments) / `request_body` (HTTP: the request body exceeds the limit the service can accept) / `admission` / `result_budget` / `premise_entries` / `premise_fan_in` / `import_line` (a line in the export file being imported exceeds 16 MiB) | `limit_bytes?`, `actual_bytes?` (`evidence_segment`, `request`: bytes); for `ops`, `limit`, `actual` (the number of ops); for `evidence_segments`, `limit`, `actual` (the number of segments); for `admission`, `estimated_rows`, `suggested_batch` (in the first version the whole rule is recomputed, the cost does not vary with the request size, and admission neither rejects nor reports `admission`; it is enabled after estimating by affected partition); for `result_budget`, `narrow_by: string[]`; for `premise_fan_in`, `target: TargetRef`, `count` (how many valid declarations currently point to the target). All these causes occur before anything is recorded; when the receipt of an operation that is already recorded exceeds the budget, no error is reported and it is truncated with `omitted[]` |
| `sql_rejected` | `syntax` (a syntax error, or the text is not well-formed Unicode) / `not_select` / `function` / `node` / `system_time` / `unknown_name` / `type` (type or unit mismatch) / `limit` (a limit exceeded) / `runtime` (an evaluation error, such as 64-bit integer overflow) | `line`, `node` (physical names are not exposed), `use?: "history"` |
| `sql_timeout` | — | `elapsed_ms` |
| `draft_outdated` | `base_version` / `migrating` / `table_written` (at confirmation, the table whose structure the draft changes has been written) / `migrate_failed` (at confirmation, `migrate` failed to evaluate against writes made after the trial run) / `name_taken` (at confirmation, the slot name the draft changes to is already used by another slot) / `backfill_required` (at confirmation, a constraint the draft tightened without giving a `backfill` is violated by values written in the meantime) | `current_sv`; for `migrating`, `migration: MigrationStatus`; for `backfill_required`, `details` (the same shape as the `backfill_required` detail of `schema_draft`) |
| `field_unmatched` | — | `fields: Array<{table, id, name}>` |
| `confirmation_mismatch` | `changed` / `restored` | `current: ItemDetail` (with the new `item_ver`) |
| `item_closed` | `resolved` / `superseded` / `expired` | `resolution?` / `superseded?` (the same shape as the item detail); `expired` (the grace period of the `deletion` has passed): if already executed, gives `resolution` (the execute branch); if not yet executed, gives `expires_at` |
| `preview_outdated` | — | `preview: DeletionPreviewResult` (with the new `dc_`) |
| `unauthenticated` | `missing` / `invalid` / `revoked` / `expired` / `account_disabled` (server mode: the account of the tenant owner is disabled) | — |
| `insufficient_scope` | — | `required_scope: Scope \| "user_session" \| "all_slots"` (`all_slots`: this operation needs a credential whose scope is all slots, as when a credential limited to some slots creates a slot. Reported only for visible targets and does not reveal anything outside the visible range) |
| `rate_limited` | `quota` / `busy` (the same tenant already has a reconcile or an import running) | `retry_after` |
| `handle_expired` | `expired` / `restored` / `executed` / `derived_changed` (a derived table was refreshed during paging; re-read from the first page) | `deletion?: ItemId` (the `dc_` that has already been executed) |
| `not_in_this_version` | `parameter` / `value` / `operation` / `table_written` (a change allowed only on a table never written is used on a table that has been written) / `not_implemented` (a case that the implementation of 0.1.0 cannot reach yet: the parameter itself is valid, and it is not a parameter reserved for a later version) | `param?`, `value?` (carried when `reason` is `value` and that value is one of the fixed values of the parameter in the contract; a string the caller wrote casually is not carried), `operation?` |
| `unavailable` | `busy` / `restoring` / `importing` / `reconciling` / `starting` / `stopping` | `retry_after?` |
| `internal` | — | `incident: string` (a number for troubleshooting, with no content) |
| `import_rejected` | `unsupported_format` / `not_from_start` / `segment_order` / `chain_broken` / `checksum_mismatch` / `incomplete` / `replay_failed` | `seq?`, `path?` (positions only, no content echoed) |
| `referenced` (`@later`) | — | `referrers`, `alternatives` |
| `lease_expired` (`@later`) | `expired` / `migration_abandoned` / `migration_switched` | — |

Which operations return which error codes:

| Operation | Possible returns besides the general errors |
|---|---|
| General (all operations) | `invalid_argument`, `unauthenticated`, `insufficient_scope`, `rate_limited`, `not_in_this_version`, `unavailable`, `internal` |
| `catalog` | `unknown_table`, `not_found` (`slot`; `draft`), `too_large` (`result_budget`), `handle_expired` |
| `query` | `unknown_table`, `unknown_field`, `handle_expired` |
| `sql` | `sql_rejected` (including `unknown_name`: the table does not exist or is not visible), `sql_timeout`, `handle_expired` |
| `history` | `unknown_table`, `unknown_field`, `not_found` (including `as_of: {read}` pointing to a read that is not visible), `read_first`, `handle_expired` |
| `sources` | `not_found` (including `slot`), `handle_expired` |
| `deletion_preview` | `not_found`, `handle_expired`, `preview_outdated`, `too_large` (`result_budget`) |
| `pending` | `not_found` (including `slot`), `handle_expired`, `too_large` (`result_budget`) |
| `write` | `unknown_table`, `unknown_field`, `not_found` (including the row a premise points to), `revoked`, `derived_readonly`, `validation_failed`, `read_first`, `schema_incompatible`, `too_large` (including `premise_entries`, `premise_fan_in`) |
| `resolve` | `not_found`, `item_closed`, `confirmation_mismatch`, `read_first`, `draft_outdated` (`table_written` / `migrate_failed` / `name_taken` / `backfill_required`: the `confirm` of a `schema_change`), and those the triggered write may return |
| `schema_draft` | `validation_failed`, `draft_outdated`, `field_unmatched`, `too_large` |
| `delete` | `handle_expired`, `preview_outdated` |
| `connections.*` | `not_found` (including a slot in the `slots` of `connections.issue` that does not exist: `slot`) |
| `slots.remove` | `not_found` (`slot`) |
| `policy.get` | `not_found` (`slot`) |
| `log.reconcile` | `rate_limited` (`busy`: the same tenant already has one running) |
| `import` | `invalid_argument` (`tenant_not_empty`), `import_rejected`, `rate_limited` (`busy`: this tenant already has an import in progress), `too_large` (`import_line`) |
