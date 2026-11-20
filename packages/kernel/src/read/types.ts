// What reads return (docs/zh-CN/spec/04-contract-types.md §1.7, §3, §4.1, §4.3) and how they fail
// (§9).

import type {
  BizPoint,
  DateStr,
  EntityId,
  EVENT_DECISIONS,
  FieldStatus,
  ItemId,
  KernelErrorCode,
  KernelErrorDetail,
  KernelErrorReason,
  PremiseReason,
  RowId,
  Seq,
  SourceId,
  SourceKind,
  SourceLevel,
  VersionIntent,
} from "@fluxvita/saveslot-contract-core";
import { echoName, echoPath } from "../request/index.ts";
import type { ValueOut } from "../time/index.ts";

/** A refused read: the contract's error code and its details (`reason`, `param`, …). */
export class ReadError<C extends KernelErrorCode = KernelErrorCode> extends Error {
  override readonly name = "ReadError";
  readonly code: C;
  readonly detail: KernelErrorDetail<C>;
  /** The echoed names and paths in `detail` are cut to `ECHO_CHARS` code points each. */
  constructor(code: C, message: string, detail: KernelErrorDetail<C> = {}) {
    super(echoName(message));
    this.code = code;
    this.detail = {
      ...detail,
      ...(typeof detail["param"] === "string" ? { param: echoPath(detail["param"]) } : {}),
      ...(typeof detail["name"] === "string" ? { name: echoName(detail["name"]) } : {}),
    };
  }
}

export const invalid = (
  reason: KernelErrorReason<"invalid_argument">,
  param: string,
  extra: Record<string, unknown> = {},
) => new ReadError("invalid_argument", `${param}: ${reason}`, { reason, param, ...extra });

/** Not built yet in this version of the kernel (an internal error to the caller). */
export const notImplemented = (param: string, what: string) =>
  new ReadError("internal", `${param}: ${what} is not implemented`, {
    reason: "not_implemented",
    param,
  });

/** Field values as the contract gives them (a zoned date-time as text: ../time `valueOut`). */
export type Values = Readonly<Record<string, ValueOut>>;

/** §1.5 `TargetRef`. */
export interface TargetRef {
  /** Qualified: `slot.table`. */
  readonly table: string;
  readonly row?: RowId;
  readonly entity?: EntityId;
  readonly entity_key?: Values;
  /** A derived row's group key by field name; `{}` for a whole aggregate. */
  readonly key?: Values;
}

/**
 * §1 `Interval`: a business time interval of a read result, `[valid_from, valid_to)`. `valid_to`
 * null: open. `valid_to_inclusive`: on date-grained tables, the last day of an interval that ends.
 */
export interface Interval {
  /** Null: open at the start (a write-back taking back a revoke of the whole time, 09 §5.7). */
  readonly valid_from: BizPoint | null;
  readonly valid_to: BizPoint | null;
  readonly valid_to_inclusive?: DateStr;
}

/** §3 `Marks`, the part this version gives. */
export interface Marks {
  readonly disputed?: readonly {
    readonly item: ItemId;
    readonly fields: readonly string[];
    /** State tables: the item's spans within this row's interval, in order. */
    readonly spans?: readonly Interval[];
  }[];
  readonly awaiting?: readonly {
    readonly item: ItemId;
    readonly fields: readonly string[];
    /** State tables: the item's spans within this row's interval, in order. */
    readonly spans?: readonly Interval[];
  }[];
  readonly flagged?: readonly { readonly item: ItemId; readonly reason: "duplicate_keys" }[];
  readonly corrected?: true;
  readonly revoked?: { readonly seq: Seq };
  /**
   * The premises of the values read changed (04-contract §7): at most 10, the latest `since`
   * first; `premise_changed_total` when there are more.
   */
  readonly premise_changed?: readonly PremiseChangedMark[];
  readonly premise_changed_total?: number;
  /** A derived row computed when read (04-contract §7): its value follows the evaluation time; no `ver`. */
  readonly computed_at_read?: true;
}

/**
 * §3 one entry of `Marks.premise_changed`. A premise whose target's table the caller cannot see
 * gives only what is of this row: `hidden`, `since` and the fields covered.
 */
export type PremiseChangedMark =
  | {
      readonly premise: TargetRef;
      readonly premise_fields?: readonly string[];
      readonly seen: string;
      readonly reason: PremiseReason;
      readonly since: Seq;
      readonly fields: readonly string[];
      readonly declared: { readonly seq: Seq; readonly actor: Actor };
    }
  | {
      readonly hidden: true;
      readonly since: Seq;
      readonly fields: readonly string[];
    };

/** §4.1 `Row`, without `detail` (not in this version yet). */
export interface Row extends TargetRef {
  /**
   * `v…` (current), or `h…` read as of a record time (with `historical`). Absent on a derived row
   * computed when read (`marks.computed_at_read`).
   */
  readonly ver?: string;
  readonly historical?: true;
  readonly values: Values;
  readonly valid_from?: BizPoint;
  readonly valid_to?: BizPoint | null;
  readonly valid_to_inclusive?: DateStr;
  readonly marks?: Marks;
  /** The writer of the operation in `ver`, when it is not the caller (base rows only). */
  readonly changed_by?: Actor;
  /** Derived rows only: the marks on the rows the rule reads, on the fields it depends on. */
  readonly input_marks?: InputMarks;
}

/** §3 `InputMarks`: base rows of the partition with marks on the fields the rule depends on. */
export interface InputMarks {
  readonly disputed: number;
  readonly awaiting: number;
  readonly flagged: number;
  /** Premises are a later version: always 0 here. */
  readonly premise_changed: number;
  /** The open items among them, by ID in string order, at most 10. */
  readonly items: readonly ItemId[];
}

export type ReadWarning =
  | {
      readonly code: "time_truncated";
      readonly param: string;
      readonly from: string;
      readonly to: DateStr;
    }
  | { readonly code: "timezone_assumed"; readonly param: string; readonly timezone: string };

/** §4.3 `QueryReadResult`. */
export interface QueryReadResult {
  readonly table: string;
  readonly slot: string;
  readonly sv: number;
  readonly total: number;
  /** The next page's position, unsigned (the service layer wraps it as `next_cursor`). */
  readonly next_position?: string;
  readonly rows: readonly Row[];
  readonly warnings?: readonly ReadWarning[];
}

/** §4.5 `AsOfResult`. */
export interface AsOfResult {
  readonly mode: "as_of";
  /** `recorded_at` absent before any operation (`seq` 0). */
  readonly as_of: { readonly seq: Seq; readonly recorded_at?: string };
  readonly sv: number;
  /** The slot's time zone: the moments of the result are shown in it (05-surfaces §4.1). */
  readonly timezone: string;
  readonly total: number;
  readonly next_position?: string;
  readonly rows: readonly Row[];
  readonly other_reads?: readonly {
    readonly read: string;
    readonly seq: Seq;
    readonly at: string;
  }[];
}

/** §1.6 `Actor`. */
export interface Actor {
  readonly kind: "connection" | "user" | "system";
  readonly id: string;
  readonly name: string;
  readonly state?: "revoked" | "disabled";
}

/** §4.5 `SourceRef`. */
export interface SourceRef {
  readonly id: SourceId;
  readonly kind: SourceKind;
  readonly correction?: true;
  readonly level?: SourceLevel;
  readonly literal?: "hit" | "miss" | "na";
  readonly text?: string;
  readonly removed?: true;
}

/** §4.5 `TimelineField`. */
export interface TimelineField {
  /** §5.1 `TimelineResultCode`. */
  readonly result: FieldStatus | "dropped";
  readonly no_value?: true;
  readonly uncovered?: true;
  readonly before?: ValueOut;
  readonly after?: ValueOut;
  readonly valid?: Interval;
  readonly removed?: true;
  readonly sources?: {
    readonly value: readonly SourceRef[];
    readonly operation: readonly SourceRef[];
  };
}

/** §4.5 `TimelineEntry`, without `premises` and `affected` (not in this version yet). */
export interface TimelineEntry {
  readonly seq: Seq;
  readonly recorded_at: string;
  readonly actor: Actor;
  readonly intent: VersionIntent;
  readonly via?:
    | { readonly resolve: ItemId; readonly decision: (typeof EVENT_DECISIONS)[number] }
    | { readonly undo: Seq };
  readonly valid?: Interval;
  readonly fields: Readonly<Record<string, TimelineField | readonly TimelineField[]>>;
}

/** §4.5 `TimelineResult`. */
export interface TimelineResult {
  readonly mode: "timeline";
  readonly target: TargetRef;
  readonly sv: number;
  /** The slot's time zone: the moments of the result are shown in it (05-surfaces §4.1). */
  readonly timezone: string;
  readonly ver: string;
  readonly total: number;
  readonly next_position?: string;
  readonly entries: readonly TimelineEntry[];
  readonly reads?: readonly {
    readonly read: string;
    readonly seq: Seq;
    readonly at: string;
    readonly actor: Actor;
    readonly task?: string;
  }[];
}

/** §4.5 `ChangedField`. */
export interface ChangedField {
  readonly before?: ValueOut;
  readonly after?: ValueOut;
}

/** §4.5 `ChangesResult.changes[]`: one operation's change to one row or entity. */
export interface ChangeEntry {
  readonly seq: Seq;
  readonly recorded_at: string;
  readonly actor: Actor;
  readonly intent: VersionIntent;
  readonly target: TargetRef;
  /**
   * Event and timeless tables: a field is one `ChangedField`. State tables: an array, a part per
   * stretch of business time. `*`: whether the row exists (`before` / `after` are booleans, true
   * for existing), given when a revoke or its taking back changes it.
   */
  readonly fields: Readonly<
    Record<string, ChangedField | readonly (ChangedField & { readonly valid: Interval })[]>
  >;
}

/** §4.5 `ChangesResult`. */
export interface ChangesResult {
  readonly mode: "changes";
  /** The table, or the row or entity, asked about. */
  readonly target: TargetRef;
  /** The slot's time zone: the moments of the result are shown in it (05-surfaces §4.1). */
  readonly timezone: string;
  /** As resolved: the operations after `since` up to `until`. */
  readonly since: Seq;
  readonly until: Seq;
  readonly total: number;
  readonly next_position?: string;
  /** Newest first. */
  readonly changes: readonly ChangeEntry[];
}
