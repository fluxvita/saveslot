// Whether a premise's target differs, on what the premise declared, between the version it saw and
// another state (docs/zh-CN/spec/03-data-model/02-integrity-and-records.md «写入的前提»:
// «一条声明有什么», «什么算前提变了»). The detection (whether a mark is taken off), the marks of a
// read and the state of a declaration made late all ask this one question.

import type { FieldId } from "@fluxvita/saveslot-contract-core";
import { targetDelta } from "./delta.ts";
import type { BizTime, ComparedDelta, FieldDelta, Range, Stretch, TargetState } from "./types.ts";

/**
 * What a premise declared: its fields (not given: the whole row, its existence included) and, on a
 * state table, its business time: a point, or a stretch (`to` null: open to the end). Not given on
 * a row of an event or timeless table, which has no business time, and on an entity for the whole
 * time line.
 */
export interface PremiseScope {
  readonly fields?: readonly FieldId[];
  readonly range?: { readonly at: BizTime } | Range;
}

/**
 * One way the target differs within the scope. A row's field or existence: as `targetDelta` gives
 * it. An entity's: its stretches within the scope, those of a `value` change only, cut to the
 * declared stretch; for a point, the one stretch that holds it, whole.
 */
export type PremiseDiff =
  | (Omit<ComparedDelta, "change" | "stretches"> & { readonly stretches?: readonly Stretch[] })
  | Extract<FieldDelta, { comparable: false }>;

const cut = (s: Stretch, r: PremiseScope["range"]): Stretch | undefined => {
  if (r === undefined) return s;
  if ("at" in r) return s.from <= r.at && (s.to === null || r.at < s.to) ? s : undefined;
  // Business time points are texts of one writing, ordered as strings.
  const from = [s.from, r.from].sort()[1] as BizTime;
  const to = s.to === null ? r.to : r.to === null ? s.to : ([s.to, r.to].sort()[0] as BizTime);
  return to === null || from < to ? { ...s, from, to } : undefined;
};

/**
 * How `now` differs from `seen` on what the premise declared; empty exactly when the premise has
 * not changed: on every declared field (and business time) the value now is the same value as the
 * one seen. Only values count: a change of what gave a value (`source_only`) is none.
 *
 * - A field counts when it is declared, or when no fields are. On an entity, only its stretches
 *   within the declared business time, each cut to it; the changed stretches stay as they are
 *   (a mark says where the value changed), they are not folded into "this field changed".
 * - A declared field that had a value and has none has changed, however the value went (a revoke,
 *   an undo of a fill, a deletion): it is the field's own entry. An empty value (`null`) against no
 *   value is not a change of the field, as in `targetDelta`: a premise on `fields` looks at those
 *   fields only, and whether the row is there belongs to a premise on the whole row (a revoke
 *   aside, which always counts). One that declared f1 saw "f1 has no content", and that is still
 *   so.
 * - Existence. A revoke counts whatever was declared: it meets every field (on an entity, where
 *   its business time meets the declared one), and so does taking it back. Any other difference in
 *   existence (an entity's stretch with no value and no revoke on one side) is given as an
 *   `existence` entry only for a premise on the whole row; on declared fields what changed is
 *   given by those fields, above.
 * - A position that does not compare (deleted content, P3) is given as it is, for the declared
 *   fields and existence: the caller does not take a mark off what it cannot compare.
 *
 * The scope's business time is for an entity; on a row it must not be given.
 */
export function premiseDelta(
  seen: TargetState,
  now: TargetState,
  scope: PremiseScope,
): PremiseDiff[] {
  if (seen.kind === "row" && scope.range !== undefined)
    throw new TypeError("a premise on a row of an event or timeless table has no business time");
  const declared = scope.fields === undefined ? undefined : new Set<string>(scope.fields);
  const out: PremiseDiff[] = [];
  for (const d of targetDelta(seen, now)) {
    const existence = d.field === "existence";
    if (!existence && declared !== undefined && !declared.has(d.field)) continue;
    if (!d.comparable) {
      out.push(d);
      continue;
    }
    // A revoke on either side: `existence` holds `false` there.
    const revoke = (x: { before?: unknown; after?: unknown }) =>
      x.before === false || x.after === false;
    if (d.stretches === undefined) {
      // A row: its field, or its existence, as a whole.
      if (d.change !== "value") continue;
      if (existence && declared !== undefined && !revoke(d)) continue;
      const { change: _, ...rest } = d;
      out.push(rest);
      continue;
    }
    const stretches = d.stretches.flatMap((s) => {
      if (s.change !== "value") return [];
      if (existence && declared !== undefined && !revoke(s)) return [];
      const c = cut(s, scope.range);
      return c === undefined ? [] : [c];
    });
    if (stretches.length === 0) continue;
    const { change: _, stretches: __, ...rest } = d;
    out.push({ ...rest, stretches });
  }
  return out;
}
