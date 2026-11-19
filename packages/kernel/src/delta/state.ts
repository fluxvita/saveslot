// A target's state at a version position, from the version table (docs/zh-CN/spec/02-architecture.md
// §8, `t_<table>_v<n>__ver`: every cell with the record interval it held). Reads and writes both
// take the state they compare from here, so the two see the same one.
//
// A row (event or timeless table) is there, revoked when a revoke is in effect, or has no cell at
// all. An entity (state table) has a value on a stretch of business time where a field cell there
// is not marked `no_value` and no revoke is in effect (05-time «无值区间»); equal pieces run
// together.

import type {
  CompiledBaseField,
  CompiledBaseTable,
  FieldId,
  FieldValue,
} from "@fluxvita/saveslot-contract-core";
import { INSTANT_TEXT, physical, selectOf } from "../store/layout.ts";
import type { ReadTx } from "../store/ports.ts";
import { sameValue } from "./same-value.ts";
import type { EntitySegment, Presence, Range, SourceKey, TargetState } from "./types.ts";

/** A cell of one row or entity: field, business interval, revoke, `no_value`, raw value columns. */
export type StateCell = {
  field_id: string;
  vf: string | null;
  vt: string | null;
  revoked: boolean | null;
  no_value: boolean | null;
  /** The contribution that gave the cell its value: event, field, item (none: no write did). */
  src_event?: unknown;
  src_field?: unknown;
  src_k?: unknown;
} & Record<string, unknown>;

/** Decodes a field's value from its raw columns (`selectOf`'s order): `../request` `decodeColumns`. */
export type Decode = (f: CompiledBaseField, columns: readonly unknown[]) => FieldValue;

/** What a state is built with. */
export interface StateOptions {
  readonly decode: Decode;
  /** The 出处项 of a field cell; without it every source is empty. */
  readonly sourceOf?: (field: FieldId, cell: StateCell) => SourceKey;
}

const cellValue = (f: CompiledBaseField, c: StateCell, decode: Decode): FieldValue =>
  decode(
    f,
    selectOf(f).map((_, i) => c[`c_${f.id}_${i}`]),
  );

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

type SourceRow = {
  event_seq: unknown;
  field_id: string;
  k: number;
  carried_event: unknown;
  carried_field: string | null;
  carried_k: number | null;
  status: string;
  valid_from: string | null;
  valid_to: string | null;
  reverted: string;
  body: string | null;
};

const itemKey = (event: unknown, field: string, k: unknown): string => `${event}/${field}/${k}`;

/**
 * The 出处项 of each field cell, from the sources table: the contribution that gave the cell its
 * value, followed through its carried references to the end, and the corroborations of the same
 * value still in force (not reverted, content not deleted, on a state table meeting the cell's
 * interval). What the table holds is read as of now, limited to operations up to `ver`: an item's
 * status and its registrations of being reverted are those of now.
 */
async function sourcesOf(
  tx: ReadTx,
  t: CompiledBaseTable,
  rowId: string,
  ver: number,
  decode: Decode,
): Promise<(field: FieldId, cell: StateCell) => SourceKey> {
  const r = await tx.query<SourceRow>(
    `SELECT b.event_seq, b.field_id, b.k, b.carried_event, b.carried_field, b.carried_k, b.status,
       b.valid_from, b.valid_to, b.reverted, c.body
     FROM base_sources b
     JOIN events e ON e.seq = b.event_seq
     LEFT JOIN content c ON c.seq = b.event_seq
       AND c.path = 'fields/' || b.field_id || '/' || b.k
     WHERE b.row_id = $1 AND e.op <= $2 AND b.field_id <> 'existence'`,
    [rowId, ver],
  );
  const carried = new Map<string, string[]>();
  const corroborations: SourceRow[] = [];
  for (const x of r.rows) {
    const key = itemKey(x.event_seq, x.field_id, x.k);
    if (x.carried_event !== null)
      carried.set(key, [
        ...(carried.get(key) ?? []),
        itemKey(x.carried_event, x.carried_field as string, x.carried_k as number),
      ]);
    else if (!carried.has(key)) carried.set(key, []);
    if (x.status === "corroborated" && x.body !== null) corroborations.push(x);
  }
  const ends = (key: string, seen: Set<string>): string[] => {
    if (seen.has(key)) return [];
    seen.add(key);
    const next = carried.get(key) ?? [];
    return next.length === 0 ? [key] : next.flatMap((n) => ends(n, seen));
  };
  const state = t.time.type === "state";
  return (field, cell) => {
    const set = new Set<string>();
    if (cell.src_event !== null && cell.src_event !== undefined && cell.src_field != null)
      for (const e of ends(itemKey(cell.src_event, String(cell.src_field), cell.src_k), new Set()))
        set.add(e);
    if (set.size === 0) return "";
    const f = t.fields.find((x) => x.id === field);
    const value = f === undefined ? null : cellValue(f, cell, decode);
    for (const x of corroborations) {
      if (x.field_id !== field || (JSON.parse(x.reverted) as unknown[]).length > 0) continue;
      const held = (JSON.parse(x.body as string) as { value?: FieldValue }).value;
      if (held === undefined || !sameValue(held, value)) continue;
      if (
        state &&
        cell.vf !== null &&
        !(
          (x.valid_to === null || cell.vf < x.valid_to) &&
          (cell.vt === null || (x.valid_from ?? "") < cell.vt)
        )
      )
        continue;
      set.add(itemKey(x.event_seq, x.field_id, x.k));
    }
    return [...set].sort().join(",");
  };
}

/**
 * The state of a row or entity at version position `ver` (an operation number, that operation
 * included): the cells in effect then, as `targetDelta` compares them. The values are stable: cells
 * before an operation are closed by later ones, never changed, so they read the same at any later
 * time. The 出处项 are not: the sources table is read as it is now, so a corroboration or a
 * registration of being reverted made later shows in the set of an earlier position.
 *
 * With `sources`, each field's source is its 出处项 set, which costs one more query, against the
 * sources table; without it every source is empty, and a comparison gives no `source_only`.
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
  const { versions } = physical(t);
  const interval =
    t.time.type === "state"
      ? t.time.granularity === "date"
        ? "valid_from::text AS vf, valid_to::text AS vt"
        : `to_char(valid_from, ${INSTANT_TEXT}) AS vf, to_char(valid_to, ${INSTANT_TEXT}) AS vt`
      : "NULL AS vf, NULL AS vt";
  const cols = t.fields.flatMap((f) => selectOf(f).map((x, i) => `${x} AS c_${f.id}_${i}`));
  const r = await tx.query<StateCell>(
    `SELECT field_id, ${interval}, revoked, no_value, src_event, src_field, src_k, ${cols.join(", ")}
     FROM ${versions} WHERE row_id = $1 AND rec_from <= $2 AND (rec_to IS NULL OR rec_to > $2)`,
    [rowId, ver],
  );
  const cells = [...r.rows];
  return stateFromCells(t, cells, {
    decode: o.decode,
    ...(o.sources === true ? { sourceOf: await sourcesOf(tx, t, rowId, ver, o.decode) } : {}),
  });
}
