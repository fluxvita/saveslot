// A target's state at a version position, from the version table (docs/zh-CN/spec/02-architecture.md
// §8, `t_<table>_v<n>__ver`: every cell with the record interval it held). Reads and writes both
// take the state they compare from here, so the two see the same one.
//
// A row (event or timeless table) is there, revoked when a revoke is in effect, or has no cell at
// all. An entity (state table) has a value on a stretch of business time where a field cell there
// is not marked `no_value` and no revoke is in effect (05-time «无值区间»); equal pieces run
// together.

import type { CompiledBaseTable, FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import type { ReadTx } from "../store/ports.ts";
import { sameValue } from "./same-value.ts";
import { cellsAt, cellValue, type Decode, type StateCell, sourceItemsAt } from "./sources.ts";

export type { Decode, StateCell };

import type { EntitySegment, Presence, Range, SourceKey, TargetState } from "./types.ts";

/** What a state is built with. */
export interface StateOptions {
  readonly decode: Decode;
  /** The origin items of a field cell; without it every source is empty. */
  readonly sourceOf?: (field: FieldId, cell: StateCell) => SourceKey;
}

/** A state entity's segments: where it has a value, equal pieces (values and sources) running together. */
export function segmentsOf(
  t: CompiledBaseTable,
  cells: readonly StateCell[],
  o: StateOptions,
): EntitySegment[] {
  const points = new Set<string>();
  for (const c of cells) {
    if (c.vf !== null) points.add(c.vf);
    if (c.vt !== null) points.add(c.vt);
  }
  const sorted = [...points].sort();
  const out: EntitySegment[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const from = sorted[i] as string;
    const to = sorted[i + 1] ?? null;
    const here = cells.filter(
      (c) => (c.vf as string) <= from && (c.vt === null || (to !== null && to <= c.vt)),
    );
    if (here.some((c) => c.field_id === "existence" && c.revoked === true)) continue;
    const values: Record<FieldId, FieldValue> = Object.create(null);
    const source: Record<FieldId, SourceKey> = Object.create(null);
    for (const f of t.fields) {
      const c = here.find((x) => x.field_id === f.id);
      values[f.id] = c === undefined ? null : cellValue(f, c, o.decode);
      source[f.id] = c === undefined ? "" : (o.sourceOf?.(f.id, c) ?? "");
    }
    // The entity has a value here when a field cell says so: apply writes every field's cell, not
    // marked no_value, where it has one (a clear and a field never written included), and only
    // no_value cells or a revoke's where it has none (05-time «无值区间»).
    const valued = here.some((c) => c.field_id !== "existence" && c.no_value !== true);
    if (!valued) continue;
    const last = out.at(-1);
    if (
      last !== undefined &&
      last.to === from &&
      t.fields.every(
        (f) =>
          sameValue(last.values[f.id] as FieldValue, values[f.id] as FieldValue) &&
          last.source[f.id] === source[f.id],
      )
    )
      out[out.length - 1] = { ...last, to };
    else out.push({ from, to, values, source });
  }
  return out;
}

/**
 * The state of a target from its cells in effect at one version position. Which table the cells
 * belong to is the caller's: a row that is not in the table has no cell and reads as `absent`.
 */
export function stateFromCells(
  t: CompiledBaseTable,
  cells: readonly StateCell[],
  o: StateOptions,
): TargetState {
  if (t.time.type === "state") {
    const revoked: Range[] = cells
      .filter((c) => c.field_id === "existence" && c.revoked === true)
      .map((c) => ({ from: c.vf ?? "", to: c.vt }));
    return { kind: "entity", segments: segmentsOf(t, cells, o), revoked };
  }
  const presence: Presence =
    cells.length === 0
      ? "absent"
      : cells.some((c) => c.field_id === "existence" && c.revoked === true)
        ? "revoked"
        : "live";
  const fields: Record<FieldId, { value: FieldValue; source: SourceKey }> = Object.create(null);
  for (const f of t.fields) {
    const c = cells.find((x) => x.field_id === f.id);
    fields[f.id] = {
      value: c === undefined ? null : cellValue(f, c, o.decode),
      source: c === undefined ? "" : (o.sourceOf?.(f.id, c) ?? ""),
    };
  }
  return { kind: "row", presence, fields };
}

/**
 * The state of a row or entity at version position `ver` (an operation number, that operation
 * included): the cells in effect then, as `targetDelta` compares them. The values are stable: cells
 * before an operation are closed by later ones, never changed, so they read the same at any later
 * time. The origin items are not: the sources table is read as it is now, so a corroboration or a
 * registration of being reverted made later shows in the set of an earlier position.
 *
 * With `sources`, each field's source is its set of origin items, which costs one more query,
 * against the sources table; without it every source is empty, and a comparison gives no
 * `source_only`.
 *
 * The caller answers for the table and the row (a row that is not in the table reads as `absent`,
 * with no error) and for `decode`, which must be the decoding that matches `selectOf`'s columns
 * (`../request` `decodeColumns`): a decoder that does not match gives wrong values, unchecked.
 */
export async function stateAt(
  tx: ReadTx,
  t: CompiledBaseTable,
  rowId: string,
  ver: number,
  o: { readonly decode: Decode; readonly sources?: boolean },
): Promise<TargetState> {
  const cells = await cellsAt(tx, t, rowId, ver);
  return stateFromCells(t, cells, {
    decode: o.decode,
    ...(o.sources === true
      ? {
          sourceOf: await (async () => {
            const of = await sourceItemsAt(tx, t, rowId, ver, o.decode);
            return (field: FieldId, cell: StateCell): SourceKey => of(field, cell).join(",");
          })(),
        }
      : {}),
  });
}
