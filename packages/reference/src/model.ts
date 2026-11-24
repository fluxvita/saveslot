// Input and output model of the reference evaluator.
//
// The evaluator is a pure function of "the write events of one row or entity + the set of deleted
// source data" (02-architecture §11 «测试矩阵», bullet «参考求值器与性质测试»). Its input is a
// minimal model of the request side of the log: what the caller said (the raw parameters of
// `write.head`, 09 §5.7) and what people decided (`undo`, item resolutions). Everything saveslot
// judges mechanically (statuses, resolved intervals, revert ranges, write-back items) is the
// evaluator's output, never its input, because the definition recomputes it (03-deletion
// «两条原则» ②). Mapping to the event format v1 (09):
//
// | Model                         | Event format v1                                                     |
// |-------------------------------|---------------------------------------------------------------------|
// | `op`                          | operation number (09 §4.1); orders contributions                    |
// | `event`                       | `seq` of the op's `write.base`; item references use it              |
// | `WriteOp.seen`                | `ops/<i>/target.ver.op` (absent: the version just before `op`)      |
// | `seenCurrent`                 | `ops/<i>/target.ver.current`: the op saw the state just before it   |
// | `WriteOp.valid`               | `ops/<i>/valid` (`corrected_span` for both ends)                    |
// | `WriteOp.fields[f]`           | `ops/<i>/set/f` with its evidence (`sources/f/<k>` `source` rows);   |
// |                               | `explicit` = `evidence_by_field` pointed at evidence for `f`        |
// | `WriteOp.validSources`        | `valid_sources` (absent: all evidence of the op)                    |
// | `WriteOp.noop`                | `ops/<i>/noop` (no value is recorded for these fields)              |
// | `acknowledge`                 | `ops/<i>/acknowledge` `["overwrite"]`; counts only with an explicit |
// |                               | current ver (`seen`) (05-time «高影响写入»)                          |
// | `RevokeOp`                    | an op with intent revoke: `existence/0` + `span/existence/0`        |
// | `UndoOp`                      | `ops/<i>/revert` `{undo_op, include_later}`                         |
// | `ResolveOp`                   | `item.resolved` with `decision`; the item is given by its           |
// |                               | candidates' events and its conflict unit                            |
// | `ConfirmOp`                   | `item.resolved` of an `awaiting_confirmation` item (confirm/reject) |
// | `SourceKey`                   | the `seq` of a `source.recorded` event (written as a label)         |
// | `ItemResult`                  | one `fields/<f>/<k>` or `existence/<k>` item with its `span`, as     |
// |                               | `write.base` or a later `restated/<k>` gives it (09 §5.9)           |
// | `Evaluation.fields` / `gaps`  | `results/<k>/fields/<f>/<j>` / `results/<k>/existence` (09 §5.9)     |
// | `DeletionEvent`               | `deletion.confirmed` (`target.deletion`, `target.sources`)          |
// | `CancelEvent`                 | `deletion.cancelled` (`target.deletion`)                            |
// | `ExecuteEvent`                | `deletion.executed` (`target.deletion`)                             |
// | `ItemResult.closed`           | the item is resolved, rejected, or `kept_superseded` (09 §5.9)      |
//
// Writes by source key (`external_key`, 04-write-and-read «按来源键写入») are modelled on event and
// timeless tables: `WriteOp.byKey` is such an op, judged against the field's sync baseline
// (09-references-conflict-sync «冲突判据», last part), and `LogStep.outcome` says what it came to.
// Key fields are not modelled (they take no part in the baseline or in revert records), nor is a
// key transferred from a revoked row (not in the first version); a log with both ops by key and
// deletion events is refused as not modelled (deletions meeting sync are P3).
//
// Not modelled in this first version: schema switches and constant backfill, premises, `ref`
// fields and high impact ②, system rulings, deletion of evidence and deletion by row (07-scope-v1:
// later), `deps`.

import type {
  BizPoint,
  FieldId,
  FieldValue,
  OpNumber,
  RestatedStatus,
  Seq,
} from "@fluxvita/saveslot-contract-core";
import type { IvSet } from "./interval.ts";

/** A source datum, standing for the `seq` of its `source.recorded` event. */
export type SourceKey = string;

export type TableKind = "state" | "event" | "timeless";

export interface TableSchema {
  readonly kind: TableKind;
  /** Required fields (03-deletion «重放规则», «行 / 实体的存在»). */
  readonly required: readonly FieldId[];
  /**
   * Field groups judged together (09-references-conflict-sync «冲突单元», «组值»): a write
   * conflicts on a group when an operation after its version changed any field of the group and
   * the group value differs (conflict criterion ⑤: then every part of the write judged on the
   * group is a candidate); the same-value step stays field by field. A write's candidates on a
   * group go to the item on existence when any of its fields met a revoke.
   */
  readonly groups?: readonly (readonly FieldId[])[];
}

export type FromParam =
  | { readonly mode: "given"; readonly value: BizPoint }
  | { readonly mode: "now" };
export type ToParam =
  | { readonly mode: "given"; readonly value: BizPoint }
  | { readonly mode: "open" }
  | { readonly mode: "next_change" };

/** `ops/<i>/valid`; `corrected_span` is intent correct with neither end given (05-time). */
export type ValidParam = { readonly from: FromParam; readonly to: ToParam } | "corrected_span";

export interface FieldInput {
  readonly value: FieldValue;
  /** The evidence this field cites; all are needed together (03-deletion «贡献»). */
  readonly sources: readonly SourceKey[];
  /** `evidence_by_field` explicitly pointed at evidence for this field (corroboration). */
  readonly explicit?: boolean;
}

interface OpBase {
  readonly op: OpNumber;
  readonly event: Seq;
  /** `ctx.today`: what "now" resolves to for `from: now` and `corrected_span`. */
  readonly now?: BizPoint;
}

export interface WriteOp extends OpBase {
  readonly kind: "write";
  readonly seen?: OpNumber;
  /**
   * `seen` was the row's current version when written: the op saw the state just before it,
   * whatever came after `seen` with no new version (a corroboration, a deletion's restatement).
   * Judged at the write and recorded; a replay takes it as it is.
   */
  readonly seenCurrent?: true;
  /** State tables only. Absent on a state table means `from: now`, `to: next_change`. */
  readonly valid?: ValidParam;
  readonly validSources?: readonly SourceKey[];
  readonly fields: Readonly<Partial<Record<FieldId, FieldInput>>>;
  readonly noop?: readonly FieldId[];
  readonly acknowledge?: readonly ["overwrite"];
  /**
   * An op by source key (`external_key` without `row`): no `seen`, no `seenCurrent`; the version
   * it saw is each field's baseline position. It creates the row when there is none yet.
   */
  readonly byKey?: true;
  /**
   * A key added to a row that had none (`row` + `ver` + `external_key`): an ordinary write, here
   * only the operation from which the row has its key (a baseline position when nothing else is).
   */
  readonly keyAdded?: true;
}

export interface RevokeOp extends OpBase {
  readonly kind: "revoke";
  readonly seen?: OpNumber;
  readonly seenCurrent?: true;
  /** State tables: the revoked interval. Absent: the whole row or entity (a pure decision). */
  readonly valid?: { readonly from: FromParam; readonly to: ToParam };
  /** Sources of the interval (the user's words); absent means the revoke has no evidence. */
  readonly validSources?: readonly SourceKey[];
  /**
   * High impact ② (05-time «高影响写入»): the target is still referred to by another row, as the
   * write path found it when written (other rows: given, not modelled here).
   */
  readonly referenced?: true;
}

export interface UndoOp extends OpBase {
  readonly kind: "undo";
  /** The operation number being undone (`undo_op`). */
  readonly target: OpNumber;
  readonly includeLater?: boolean;
  /** `ops/<i>/target.ver.op`, explicit; an `undo` may carry it (needed for `acknowledge`). */
  readonly seen?: OpNumber;
  readonly seenCurrent?: true;
  readonly acknowledge?: readonly ["overwrite"];
}

export interface ResolveOp extends OpBase {
  readonly kind: "resolve";
  readonly decision: "take_candidate" | "keep_effective" | "take_previous";
  /** Events of the writes whose candidates make up the conflict item. */
  readonly candidates: readonly Seq[];
  /**
   * The conflict unit: a field, a field group (fields judged together, 01-objects «冲突单元»), or
   * "existence" for items targeting the row or entity.
   */
  readonly unit: FieldId | readonly FieldId[] | "existence";
  /** `take_candidate`: the event of the chosen candidate. */
  readonly take?: Seq;
}

export interface ConfirmOp extends OpBase {
  readonly kind: "confirm" | "reject";
  /** Event of the awaiting write (or awaiting undo). */
  readonly target: Seq;
}

export type Op = WriteOp | RevokeOp | UndoOp | ResolveOp | ConfirmOp;

/**
 * A privacy deletion confirmed (`deletion.confirmed`, 09 §5.9): from here on, until cancelled,
 * its sources count as deleted. `id` is the deletion ID.
 */
export interface DeletionEvent {
  readonly kind: "deletion";
  readonly op: OpNumber;
  readonly id: string;
  readonly sources: readonly SourceKey[];
}

/** A pending deletion cancelled in its grace period (`deletion.cancelled`, 09 §5.9). */
export interface CancelEvent {
  readonly kind: "cancel";
  readonly op: OpNumber;
  readonly id: string;
}

/**
 * A pending deletion carried out at its expiry (`deletion.executed`, 09 §5.9): the content on its
 * list of positions is removed for good. The state does not change; it can no longer be
 * cancelled; a later deletion's replay reads what is left (03-deletion «到期物理删除»).
 */
export interface ExecuteEvent {
  readonly kind: "execute";
  readonly op: OpNumber;
  readonly id: string;
}

/** One entry of the log of a row or entity: an operation, or a deletion event. */
export type LogEntry = Op | DeletionEvent | CancelEvent | ExecuteEvent;

/** An item reference: `{event, field, k}` or `{event, existence: k}` (09 §5.7). */
export interface ItemRef {
  readonly event: Seq;
  readonly target: FieldId | "existence";
  readonly k: number;
}

export type ItemContent =
  | { readonly kind: "value"; readonly value: FieldValue }
  /** `no_value`: set back to "no contribution at all". */
  | { readonly kind: "noValue" }
  /** `uncovered`: registration only, gives nothing and covers nothing. */
  | { readonly kind: "uncovered" }
  /** A revoke (`existence` without `restored`). */
  | { readonly kind: "revoke" }
  /** A restore (`existence` with `restored: true`). */
  | { readonly kind: "restore" };

export interface Registration {
  /** The revert that registered the item as reverted. */
  readonly byOp: OpNumber;
  readonly valid: IvSet;
}

export interface ItemResult extends ItemRef {
  readonly op: OpNumber;
  readonly status: RestatedStatus;
  /** `valid` (or `seen_valid` for candidates); empty for dropped items. */
  readonly valid: IvSet;
  readonly content: ItemContent;
  /** Write-backs and taken candidates: the items the value is carried from. */
  readonly carried?: readonly ItemRef[];
  readonly registrations: readonly Registration[];
  /**
   * A candidate or awaiting item whose pending item is closed: resolved or rejected by a person,
   * or kept superseded when a deletion was cancelled. Pending = candidate or awaiting, not closed.
   */
  readonly closed?: true;
}

/** One segment of a field after replay: the longest stretch one item gives (09 §5.9). */
export interface FieldSegment {
  readonly valid: IvSet;
  /** `null` with no `by`: the row or entity exists here but the field has no value. */
  readonly value: FieldValue;
  readonly by?: ItemRef;
}

/**
 * One entry of a revert record (09 §5.7 `revert.items`): an (event, target), not an index. It
 * covers every item of that (event, target) in a replay.
 */
export interface RevertEntry {
  readonly event: Seq;
  readonly target: FieldId | "existence";
  /** A later write an `include_later` undo takes back with the undone operation. */
  readonly later?: true;
}

/** Why a resolution was rejected: what the same write would get (04-write-and-read «判定顺序»). */
/**
 * Why a resolution was rejected when judged; `invalid`: a candidate listed has no open candidate
 * item on the unit, or the one taken is not listed (as the kernel's `invalid`).
 */
export type RejectionReason = "required_in_gap" | "revoked" | "missing_required" | "invalid";

export interface RevertResult {
  readonly op: OpNumber;
  readonly event: Seq;
  readonly status: "applied" | "awaiting" | "rejected";
  /** Rejected because the row is still revoked once the undo is written. */
  readonly reason?: "revoked";
  /** The revert record R as listed when the revert took effect (or was proposed). */
  readonly record: readonly RevertEntry[];
  /** `overwrote_corroborated`: the write-back revoke hides a later corroboration (05-time). */
  readonly warnings?: readonly "overwrote_corroborated"[];
}

export interface Evaluation {
  readonly kind: TableKind;
  /** Event and timeless tables: whether the row exists. State tables: whether any point has a value. */
  readonly exists: boolean;
  /** State tables: the intervals without a value (09 §5.9 `results/<k>/existence`). */
  readonly gaps: IvSet;
  readonly fields: Readonly<Partial<Record<FieldId, readonly FieldSegment[]>>>;
  /** Every contribution item of the replay, plus `dropped` ones that were items before. */
  readonly items: readonly ItemResult[];
  readonly reverts: readonly RevertResult[];
  /** take_candidate resolutions: the merge base and the cover set O each recorded (09 §5.8 `take`). */
  readonly takeCandidates: readonly {
    readonly op: OpNumber;
    readonly mergeBase: OpNumber;
    readonly cover: readonly RevertEntry[];
    /**
     * What deletions pending when it was judged removed and that was in effect without them, by
     * `<event>/<target>`, with the intervals then: back after a cancellation, it does not cover
     * the take there (03-deletion «撤回与宽限期»).
     */
    readonly restorable?: readonly { readonly key: string; readonly valid: IvSet }[];
  }[];
  /** The write that counts as the first creation (03-deletion «首次创建标记»). */
  readonly created: Seq | undefined;
}

/** The state after one log entry. */
export interface LogStep {
  readonly entry: LogEntry;
  /**
   * The entry was refused and did not enter the log: a request citing a source pending deletion
   * or writing to a row or entity pending deletions removed whole (03-deletion «撤回与宽限期»), or
   * a deletion of a source already pending deletion.
   */
  readonly refused: boolean;
  /**
   * Refused as `not_found`. Non-empty: the row or entity was removed whole by pending deletions;
   * every pending deletion touching its contributions, by operation number. Empty: the ordinary
   * `not_found`, nothing of the row or entity is left and pending deletions are not the cause.
   */
  readonly notFound?: readonly string[];
  /** Refused because the resolution was rejected when judged, and why. */
  readonly rejected?: RejectionReason;
  readonly state: Evaluation;
  /** A cancellation: the writes it recorded as kept in effect (`kept_effective`). */
  readonly keptEffective?: readonly {
    readonly event: Seq;
    readonly target: FieldId | "existence";
  }[];
  /**
   * A cancellation: writes whose judgement changed because of the writes kept in effect (the
   * cancellation's replay against the same replay without them): statuses before and after, and
   * the kept writes behind it (03-deletion «预览与回执要写明的内容»).
   */
  readonly knockOn?: readonly {
    readonly event: Seq;
    readonly target: FieldId | "existence";
    readonly before: string;
    readonly after: string;
    readonly because: readonly { readonly event: Seq; readonly target: FieldId | "existence" }[];
  }[];
  /** A cancellation: events whose pending items it kept superseded (`kept_superseded`). */
  readonly keptSuperseded?: readonly Seq[];
  /**
   * A person's decision on items (a conflict resolution, a confirmation or rejection): the
   * (event, target) it recorded, as `<event>/<target>` (the items it decided, when judged).
   */
  readonly decided?: readonly string[];
  /**
   * A write by source key (`WriteOp.byKey`): what it came to (04-write-and-read «写法与定位»).
   * `unchanged` (every field a no-op) and `skipped` (the row is revoked) leave nothing: the op
   * does not enter the log, and `state` is the one before it.
   */
  readonly outcome?: SyncOutcome;
  /** `skipped`: the revoke in effect, by operation number. */
  readonly revokedBy?: OpNumber;
  /** A write by source key that was judged: each field's result and the baseline it was judged on. */
  readonly syncFields?: Readonly<Partial<Record<FieldId, SyncFieldResult>>>;
  /** A cancellation: candidates it put back after their item was resolved, and their judgement. */
  readonly putBack?: readonly {
    readonly event: Seq;
    readonly target: FieldId | "existence";
    readonly judged: "dropped" | "corroborated" | "candidate";
  }[];
}

export type SyncOutcome = "created" | "updated" | "unchanged" | "pending" | "skipped";

export interface SyncFieldResult {
  readonly status: "applied" | "corroborated" | "candidate" | "awaiting" | "noop";
  /**
   * The field's sync baseline (09-references-conflict-sync «冲突判据»): the value of its latest
   * sync contribution (absent when it has none) and the operation of its latest one in effect, or
   * the operation the row got its key from.
   */
  readonly baseline: { readonly value?: FieldValue; readonly position: OpNumber };
}

export interface LogEvaluation {
  readonly steps: readonly LogStep[];
  readonly final: Evaluation;
  /**
   * Interval blocks removed by the deletions carried out (`execute`), as
   * `<event>/<target>#<index in the item's history>`, sorted: what their lists of positions held.
   */
  readonly removed: readonly string[];
}
