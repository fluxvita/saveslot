// What reads return (docs/zh-CN/spec/04-contract-types.md §1.7, §3, §4.1, §4.3) and how they fail
// (§9).

import type {
  BizPoint,
  DateStr,
  EntityId,
  FieldValue,
  ItemId,
  RowId,
  Seq,
} from "@fluxvita/saveslot-contract-core";
import { echoName, echoPath } from "../request/index.ts";

/** A refused read: the contract's error code and its details (`reason`, `param`, …). */
export class ReadError extends Error {
  override readonly name = "ReadError";
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;
  /** The echoed names and paths in `detail` are cut to `ECHO_CHARS` code points each. */
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(echoName(message));
    this.code = code;
    this.detail = {
      ...detail,
      ...(typeof detail["param"] === "string" ? { param: echoPath(detail["param"]) } : {}),
      ...(typeof detail["name"] === "string" ? { name: echoName(detail["name"]) } : {}),
    };
  }
}

export const invalid = (reason: string, param: string, extra: Record<string, unknown> = {}) =>
  new ReadError("invalid_argument", `${param}: ${reason}`, { reason, param, ...extra });

/** Not built yet in this version of the kernel (an internal error to the caller). */
export const notImplemented = (param: string, what: string) =>
  new ReadError("internal", `${param}: ${what} is not implemented`, {
    reason: "not_implemented",
    param,
  });

export type Values = Readonly<Record<string, FieldValue>>;

/** §1.5 `TargetRef`. */
export interface TargetRef {
  /** Qualified: `slot.table`. */
  readonly table: string;
  readonly row?: RowId;
  readonly entity?: EntityId;
  readonly entity_key?: Values;
}

export interface Interval {
  readonly from: BizPoint;
  readonly to?: BizPoint;
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
}

/** §4.1 `Row`, without `detail` (not in this version yet). */
export interface Row extends TargetRef {
  readonly ver: string;
  readonly values: Values;
  readonly valid_from?: BizPoint;
  readonly valid_to?: BizPoint | null;
  readonly valid_to_inclusive?: DateStr;
  readonly marks?: Marks;
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
