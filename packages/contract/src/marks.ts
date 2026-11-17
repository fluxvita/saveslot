// Row marks (docs/zh-CN/spec/04-contract-types.md §3).

import type { PremiseReason } from "@fluxvita/saveslot-contract-core";
import type { Actor, FieldName, Interval, ItemId, Seq, TargetRef, Values, Ver } from "./common.ts";

/** 04-contract-types §3 `PremiseReason` (same set as the event format's). */
export type { PremiseReason };

/** 04-contract-types §3 `FlaggedReason`. */
export const FLAGGED_REASONS = ["duplicate_keys"] as const;
/** 04-contract-types §3 `FlaggedReason`. */
export type FlaggedReason = (typeof FLAGGED_REASONS)[number];

/** 04-contract-types §3 `AffectedReason`. */
export const AFFECTED_REASONS = ["correct", "revoke", "retroactive", "plan_changed"] as const;
/** 04-contract-types §3 `AffectedReason`. */
export type AffectedReason = (typeof AFFECTED_REASONS)[number];

/** 04-contract-types §3 one entry of `Marks.premise_changed`. */
export interface PremiseChangedMark {
  /** The row / entity the premise is on. */
  premise: TargetRef;
  /** Declared fields; absent = the whole row. */
  premise_fields?: FieldName[];
  /** Version seen when declared. */
  seen: Ver;
  reason: PremiseReason;
  /** The operation that made the premise differ from what was seen. */
  since: Seq;
  /** Fields of this row the declaration covers. */
  fields: FieldName[];
  declared: { seq: Seq; actor: Actor };
}

/** 04-contract-types §3 `Marks`: given on a row of a read result only when it has any mark. */
export interface Marks {
  /** Open conflict items; the value shown is the effective one. `"*"` = existence. */
  disputed?: Array<{ item: ItemId; fields: Array<FieldName | "*">; spans?: Interval[] }>;
  /** A proposal not yet effective; `proposed: null` proposes a revoke; a revert gives `proposed_revert`. */
  awaiting?: Array<{
    item: ItemId;
    fields: Array<FieldName | "*">;
    spans?: Interval[];
    proposed?: Values | null;
    proposed_revert?: { undo: Seq };
  }>;
  /** Effective but flagged; `related` is the matched row with the highest operation number. */
  flagged?: Array<{ item: ItemId; reason: FlaggedReason; related?: TargetRef }>;
  /** The row was corrected. */
  corrected?: true;
  /** The row is revoked; only with `include_revoked: true`. */
  revoked?: { seq: Seq };
  /** A version this connection read earlier was affected later. */
  possibly_affected?: { reason: AffectedReason };
  /** Part of the data at that time has been deleted (as-of reads). */
  partially_deleted?: true;
  /** The row has a deletion that can still be cancelled. */
  pending_deletion?: { item: ItemId };
  /** A `ref` field points at a revoked or privacy-deleted row / entity. */
  dangling_ref?: Array<{ field: FieldName; state: "revoked" | "deleted" }>;
  /** Premises of the current values changed; at most 10, newest `since` first. */
  premise_changed?: PremiseChangedMark[];
  /** Total when `premise_changed` has more than 10. */
  premise_changed_total?: number;
  /** A derived row computed at read time: no `ver`. */
  computed_at_read?: true;
}

/** 04-contract-types §3 `InputMarks`: the mark summary over a derived row's input rows. */
export interface InputMarks {
  disputed: number;
  awaiting: number;
  flagged: number;
  premise_changed: number;
  /** Open items involved, in ID string order, at most 10. */
  items: ItemId[];
}
