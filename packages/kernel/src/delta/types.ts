// The shapes `delta` compares and gives (docs/zh-CN/spec/03-data-model/02-integrity-and-records.md
// «写入的前提 · 检测», the same-value criterion, origin items).

import type { FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";

/** A point of business time as the version table writes it: a date or an instant, as text. */
export type BizTime = string;

/**
 * What gives a field its value, as one comparable text: the set of origin items (01-objects
 * «出处项»), the contribution that gave the current value (carried references followed to their
 * end) and the corroborations still in force, each as `event/field/item`, sorted and joined. Empty:
 * the value has no origin items. Two texts are equal exactly when the sets are.
 */
export type SourceKey = string;

/**
 * A row's presence: no cell yet (not created, or not at that position), there, or revoked. A
 * revoke and its taking back change `existence`; a creation does not.
 */
export type Presence = "absent" | "live" | "revoked";

/** A stretch of business time, `to` null: open to the end. */
export interface Range {
  readonly from: BizTime;
  readonly to: BizTime | null;
}

/** One stretch of a state table's entity: the values and their sources on [from, to). */
export interface EntitySegment {
  readonly from: BizTime;
  /** Null: open to the end. */
  readonly to: BizTime | null;
  readonly values: Readonly<Record<FieldId, FieldValue>>;
  readonly source: Readonly<Record<FieldId, SourceKey>>;
}

/**
 * One target (a row of an event or timeless table, or an entity of a state table) as the version
 * table has it at a version position. Applied values only: see `targetDelta`.
 */
export type TargetState =
  | {
      readonly kind: "row";
      readonly presence: Presence;
      readonly fields: Readonly<Record<FieldId, { value: FieldValue; source: SourceKey }>>;
    }
  | {
      readonly kind: "entity";
      /** Sorted, not overlapping; a stretch where the entity has no value (a revoke's included) is not here. */
      readonly segments: readonly EntitySegment[];
      /**
       * The stretches where a revoke is in effect. No segment is there; with none either, a stretch
       * is one the entity has no value on and was not revoked (never written, or cleared).
       */
      readonly revoked: readonly Range[];
    };

/** How a field differs: the value, only what gave it, or not at all. */
export type Change = "value" | "source_only" | "none";

/** A stretch of an entity's field where before and after differ. */
export interface Stretch {
  readonly from: BizTime;
  readonly to: BizTime | null;
  readonly change: Exclude<Change, "none">;
  /** Not given where that side has no value there (and for `existence`, a boolean: true is there). */
  readonly before?: FieldValue;
  readonly after?: FieldValue;
}

/** A target's field, or its `existence`, that differs. */
export interface ComparedDelta {
  readonly comparable: true;
  readonly field: FieldId | "existence";
  /** A row: this field's. An entity: the strongest of its stretches (`value` over `source_only`). */
  readonly change: Exclude<Change, "none">;
  /**
   * A row's field or its existence (a boolean, true: not revoked). Not given for a side with no
   * value there (before a creation); `null` is an empty value. Not given for an entity.
   */
  readonly before?: FieldValue;
  readonly after?: FieldValue;
  /** An entity's field: where it differs, stretches that run together as one. */
  readonly stretches?: readonly Stretch[];
}

/**
 * A comparison that cannot be made: the content of a version position is deleted or pending
 * deletion (docs/zh-CN/spec/03-data-model/03-deletion.md, P3). The first version never gives it:
 * every position compares.
 */
export interface IncomparableDelta {
  readonly comparable: false;
  readonly field: FieldId | "existence";
}

export type FieldDelta = ComparedDelta | IncomparableDelta;
