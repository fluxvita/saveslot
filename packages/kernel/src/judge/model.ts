// Input, record and output types of `judge` (docs/zh-CN/spec/02-architecture.md §4, module
// `judge`).
//
// `judge` is a pure function: it reads no storage and produces no events. Its state is one row or
// entity: the judged records of the operations on it, in log order. A record holds what the log
// keeps of a judgement — the raw parameters the caller gave (`write.head`, 09 §5.7) and, item by
// item, the status, resolved interval, value and `deps` (`write.base`, 09 §5.7) — and nothing
// else, so the state rebuilt from the records of a replay is the replay's state. `write` builds
// the state from the records it reads and judges only the new operation; old writes keep their
// recorded judgement, each under its own ruleset version.

import type {
  BizPoint,
  FieldId,
  FieldValue,
  OpNumber,
  Seq,
} from "@fluxvita/saveslot-contract-core";
import type { IntervalSet } from "../time/index.ts";

/** A field, or the row's or entity's existence. */
export type Target = FieldId | "existence";

/** The status of one contribution item (09 §5.7 `fields/<f>/<k>.status`). */
export type ItemStatus = "applied" | "corroborated" | "candidate" | "awaiting";

/** One item of a `write.base` event: field `f` item `k`, or existence item `k` (09 §3.5). */
export interface ItemRef {
  readonly event: Seq;
  readonly target: Target;
  readonly k: number;
}

export type TableKind = "state" | "event" | "timeless";

/** What `judge` needs of a table's compiled definition. */
export interface TableShape {
  readonly kind: TableKind;
  /** Every base field of the table. */
  readonly fields: readonly FieldId[];
  /**
   * The fields that define "has a value" (05-time «无值区间»): the required fields without a
   * constant `backfill`. Existence, gaps and the value ↔ no value boundaries of high impact ① are
   * judged on them.
   */
  readonly valued: readonly FieldId[];
  /** The fields a write must carry where it falls in a gap: every required field. */
  readonly required: readonly FieldId[];
  /**
   * Conflict groups (`together`): fields judged as one conflict unit. A field in no group is a
   * unit of its own (09-references-conflict-sync «冲突判据»).
   */
  readonly groups: readonly (readonly FieldId[])[];
}

// ---------------------------------------------------------------------------------------------
// Raw parameters (09 §5.7 `ops/<i>/valid`; 05-time «写状态：参数与默认»).

export type FromParam =
  | { readonly mode: "given"; readonly value: BizPoint }
  | { readonly mode: "now" };
export type ToParam =
  | { readonly mode: "given"; readonly value: BizPoint }
  | { readonly mode: "open" }
  | { readonly mode: "next_change" };

/** `corrected_span`: intent correct with neither end given. */
export type ValidParam = { readonly from: FromParam; readonly to: ToParam } | "corrected_span";

/** The conflict unit of an item or a pending item: a group of fields, or existence. */
export type Unit = { readonly fields: readonly FieldId[] } | "existence";

// ---------------------------------------------------------------------------------------------
// Operations to judge.

interface OpBase {
  /** The operation number: the `seq` of the request's head event (09 §4.1). */
  readonly op: OpNumber;
  /** The op's place in its request (`op_index`); later ops see earlier ones' results. */
  readonly index: number;
  /** The `seq` of this op's `write.base` event on this row or entity. */
  readonly event: Seq;
  /** The ruleset version the operation is judged by (04-write-and-read «规则版本与策略版本»). */
  readonly ruleset: number;
}

interface SeenVersion {
  /**
   * The version the op saw (`ver`): an operation number before `op`. The ops of the same request
   * before this one are seen as well (04-write-and-read «同一请求里的多个 op»).
   */
  readonly seen: OpNumber;
  /** `ver` was given explicitly, not taken from the read log. */
  readonly seenExplicit: boolean;
}

export interface FieldInput {
  /** The value after validation and unit conversion, in its canonical form. */
  readonly value: FieldValue;
  /** `evidence_by_field` points at evidence for this field. */
  readonly explicit?: boolean;
}

export interface WriteInput extends OpBase, SeenVersion {
  readonly kind: "write";
  /** State tables. Absent: from now, to the next change. */
  readonly valid?: ValidParam;
  /** "Now" for `from: now` and `corrected_span`: today or the instant, by the table's time type. */
  readonly now: BizPoint;
  readonly fields: Readonly<Partial<Record<FieldId, FieldInput>>>;
  /** `acknowledge: ["overwrite"]`. */
  readonly acknowledge?: boolean;
}

export interface RevokeInput extends OpBase, SeenVersion {
  readonly kind: "revoke";
  /** State tables: the revoked interval. Absent: the whole row or entity. */
  readonly valid?: { readonly from: FromParam; readonly to: ToParam };
  readonly now: BizPoint;
}

/** A person confirms an awaiting write: its proposal is executed as recorded. */
export interface ConfirmInput extends OpBase {
  readonly kind: "confirm";
  /** The event of the awaiting write. */
  readonly target: Seq;
}

export interface RejectInput extends OpBase {
  readonly kind: "reject";
  readonly target: Seq;
}

/**
 * A conflict item resolved by keeping the effective value: these candidates do not take effect.
 *
 * Decisions on a conflict item (`keep_effective`, `take_previous`, `take_candidate`) are on the
 * whole item (04-contract §6): the caller passes every candidate the item holds at
 * the decision, never a subset. Judge does not look the item up and does not check this.
 */
export interface KeepEffectiveInput extends OpBase {
  readonly kind: "keep_effective";
  readonly unit: Unit;
  /** The events whose candidates on `unit` make up the item: all of them (see above). */
  readonly candidates: readonly Seq[];
}

/**
 * `undo`: take back operation `target` on this row or entity (04-write-and-read «撤回某次写入（undo）»).
 * `ver` is optional; `seen` counts only for `acknowledge`.
 */
export interface UndoInput extends OpBase, SeenVersion {
  readonly kind: "undo";
  readonly target: OpNumber;
  readonly includeLater?: boolean;
  readonly acknowledge?: boolean;
}

/** A conflict item resolved by `take_previous`: back to the value at the merge base. */
export interface TakePreviousInput extends OpBase {
  readonly kind: "take_previous";
  readonly unit: Unit;
  /** All candidates of the item, as for `KeepEffectiveInput`. */
  readonly candidates: readonly Seq[];
}

/** A conflict item resolved by `take_candidate`: the candidate of write `take` takes effect. */
export interface TakeCandidateInput extends OpBase {
  readonly kind: "take_candidate";
  readonly unit: Unit;
  /** All candidates of the item, as for `KeepEffectiveInput`. */
  readonly candidates: readonly Seq[];
  /** The event of the candidate taken: one of `candidates`. */
  readonly take: Seq;
}

export type JudgeInput =
  | WriteInput
  | RevokeInput
  | ConfirmInput
  | RejectInput
  | KeepEffectiveInput
  | UndoInput
  | TakePreviousInput
  | TakeCandidateInput;

// ---------------------------------------------------------------------------------------------
// Records: what the log keeps of a judgement.

export type ItemContent =
  | { readonly kind: "value"; readonly value: FieldValue }
  | { readonly kind: "revoke" }
  /** A write-back of "no contribution at all" (09 §5.7 `no_value`). */
  | { readonly kind: "no_value" }
  /** A write-back that only registers: gives nothing, covers nothing (09 §5.7 `uncovered`). */
  | { readonly kind: "uncovered" }
  /** A write-back that restores existence (09 §5.7 `existence` with `restored`). */
  | { readonly kind: "restore" };

/** An entry of a revert record: an (event, target), never an index (09 §5.7 `revert.items`). */
export interface RevertEntry {
  readonly event: Seq;
  readonly target: Target;
  /** A later write an `include_later` undo takes back with the undone operation. */
  readonly later?: true;
}

/**
 * A revert (03-deletion «回掉的权威定义»): the record R, where the values are taken from, and the
 * skipped entries (`undo` only, for history and receipts).
 */
export interface RevertSpec {
  readonly entries: readonly RevertEntry[];
  /** `undo`: the operation taken back (values from before it). */
  readonly before?: OpNumber;
  /** `take_previous`: the merge base (values as of it). */
  readonly mergeBase?: OpNumber;
  /** `take_previous`: the events whose candidates make up the item, on `unit`. */
  readonly candidates?: readonly Seq[];
  readonly unit?: Unit;
  /** Entries already covered by later writes when the undo was written, one per covering op. */
  readonly skipped: readonly (RevertEntry & { readonly byOp: OpNumber })[];
}

export interface RecordedItem {
  readonly target: Target;
  readonly k: number;
  readonly status: ItemStatus;
  /** `valid`, or `seen_valid` for a candidate (09 §5.7 `span/…`). */
  readonly valid: IntervalSet;
  readonly content: ItemContent;
  /** Carried from these items (a confirmed proposal). */
  readonly carried?: readonly ItemRef[];
  /**
   * The contributions the interval came from (09 §3.5): the givers of the blocking points a default
   * end or `corrected_span` stopped at, the writes that cut a same-valued write into items, the
   * carried items. Empty when both ends were given by the request and the field has one item.
   */
  readonly deps: readonly ItemRef[];
  /**
   * A candidate of a field in an item whose unit is existence: the write met a revoke in between
   * (09-references-conflict-sync «撤销与并发修改»).
   */
  readonly onExistence?: true;
}

interface RecordBase {
  readonly op: OpNumber;
  readonly index: number;
  readonly event: Seq;
  readonly ruleset: number;
}

export interface WriteRecord extends RecordBase, SeenVersion {
  readonly kind: "write" | "revoke";
  readonly valid?: ValidParam;
  readonly now: BizPoint;
  /** `acknowledge: ["overwrite"]` as the caller gave it. */
  readonly acknowledge?: true;
  /** Fields whose evidence the caller pointed at explicitly (`evidence_by_field`). */
  readonly explicit: readonly FieldId[];
  readonly items: readonly RecordedItem[];
  /** Fields judged a no-op: no item, no value kept (09 §5.7 `ops/<i>/noop`). */
  readonly noop: readonly FieldId[];
  /** A high impact write taken into effect by `acknowledge`: the stretches it overwrote (`ack/<j>`). */
  readonly ack: readonly AckStretch[];
}

export interface ConfirmRecord extends RecordBase {
  readonly kind: "confirm";
  readonly target: Seq;
  readonly items: readonly RecordedItem[];
  /**
   * Confirming an awaiting undo: the revert as listed at the confirmation (04-write-and-read
   * «撤回某次写入（undo）», 09 §5.8); its write-backs are `items`.
   */
  readonly revert?: RevertSpec;
}

/**
 * An `undo` or a `take_previous`. `status` is the revert's: awaiting (an undo of high impact; its
 * items are the proposal, with status awaiting) or applied.
 */
export interface RevertRecord extends RecordBase {
  readonly kind: "undo" | "take_previous";
  readonly status: "applied" | "awaiting";
  readonly revert: RevertSpec;
  readonly items: readonly RecordedItem[];
  /** `undo`: as the caller gave them. */
  readonly seen?: OpNumber;
  readonly seenExplicit?: boolean;
  readonly acknowledge?: true;
  readonly includeLater?: true;
  /** An undo of high impact ① taken into effect by `acknowledge`: the stretches it overwrote. */
  readonly ack: readonly AckStretch[];
}

export interface RejectRecord extends RecordBase {
  readonly kind: "reject";
  readonly target: Seq;
}

export interface KeepEffectiveRecord extends RecordBase {
  readonly kind: "keep_effective";
  readonly unit: Unit;
  readonly candidates: readonly Seq[];
}

/**
 * A `take_candidate` (09 §5.8 `take`): the candidate taken, the merge base and the covered
 * (event, target)s, kept for a privacy deletion's replay; its items are what the candidate wrote.
 */
export interface TakeCandidateRecord extends RecordBase {
  readonly kind: "take_candidate";
  readonly unit: Unit;
  readonly candidates: readonly Seq[];
  readonly take: Seq;
  readonly mergeBase: OpNumber;
  readonly cover: readonly RevertEntry[];
  readonly items: readonly RecordedItem[];
}

export type OpRecord =
  | WriteRecord
  | ConfirmRecord
  | RejectRecord
  | KeepEffectiveRecord
  | RevertRecord
  | TakeCandidateRecord;

// ---------------------------------------------------------------------------------------------
// What a judgement says beyond the record (receipts, pending items).

/** The state of a field on a stretch before a write. */
export type Shown =
  | {
      readonly kind: "value";
      readonly value: FieldValue;
      readonly by: ItemRef;
      readonly op: OpNumber;
    }
  /** The entity has a value there but the field has no contribution. */
  | { readonly kind: "none" }
  /** The entity has no value there (state tables). */
  | { readonly kind: "no_value"; readonly by?: ItemRef; readonly op?: OpNumber };

/**
 * A stretch a write overwrites (09 §5.7 `ack/<j>`, §5.8 `impact` `overwritten_segment`): the
 * value there before the write, who gave it, and the contributions its value and ends came from.
 */
export interface Overwritten {
  readonly field: FieldId;
  readonly valid: IntervalSet;
  readonly was: Shown;
  readonly deps: readonly ItemRef[];
}

/**
 * A stretch an `acknowledge` confirmed overwriting, as the log keeps it (09 §5.7 `ack/<j>`): the
 * value and the operation that wrote it, or no value (the entity had none there, or the field no
 * contribution: not told apart), with the contributions its ends (and value) came from.
 */
export type AckStretch = {
  readonly field: FieldId;
  readonly valid: IntervalSet;
  readonly deps: readonly ItemRef[];
} & (
  | { readonly value: FieldValue; readonly op: OpNumber; readonly noValue?: never }
  | { readonly noValue: true; readonly value?: never; readonly op?: never }
);

/** A conflict of one op on one unit (09-references-conflict-sync «冲突判据»). */
export interface Conflict {
  readonly unit: Unit;
  /** The operations after the seen version it conflicts with. */
  readonly with: readonly OpNumber[];
  /** This op's candidate items on the unit. */
  readonly items: readonly ItemRef[];
}

/** A corroboration a write in effect covers with another value (`overwrote_corroborated`). */
export interface CoveredCorroboration {
  readonly field: FieldId;
  readonly valid: IntervalSet;
  readonly corroboration: ItemRef;
}

export interface Judgement {
  readonly record: OpRecord;
  readonly conflicts: readonly Conflict[];
  /**
   * High impact ①: per field, change points of the seen version still there before the write and
   * gone after it (05-time «高影响写入»). Non-empty with the write awaiting, or acknowledged.
   */
  readonly erased: readonly { readonly field: FieldId; readonly at: readonly BizPoint[] }[];
  /** The stretches the write overwrites, listed when it is high impact. */
  readonly overwritten: readonly Overwritten[];
  /** The write was high impact and took effect by `acknowledge` (09 §5.7 `ack/<j>`). */
  readonly acknowledged: boolean;
  readonly warnings: readonly CoveredCorroboration[];
  /** The write counts as the first creation of the row or entity (03-deletion «首次创建标记»). */
  readonly created: boolean;
  /**
   * High impact ④ of an `undo` (05-time «高影响写入»): the later operations it takes back (an
   * entry marked `later` with a non-empty range), and the later field items in effect a
   * write-back revoke hides.
   */
  readonly takesBack: readonly OpNumber[];
  readonly hides: readonly ItemRef[];
}

// ---------------------------------------------------------------------------------------------
// The row or entity after the operations.

export interface FieldStretch {
  readonly valid: IntervalSet;
  /** `null` with no `by`: the row or entity exists there but the field has no value. */
  readonly value: FieldValue;
  readonly by?: ItemRef;
}

export interface RowView {
  readonly kind: TableKind;
  /** Event and timeless tables: the row exists. State tables: some point has a value. */
  readonly exists: boolean;
  /** State tables: where the entity has no value. */
  readonly gaps: IntervalSet;
  readonly fields: Readonly<Partial<Record<FieldId, readonly FieldStretch[]>>>;
  /** The write that counts as the first creation. */
  readonly created: Seq | undefined;
}
