// The 出处项 of a row's or entity's field cells (01-objects «出处项»; 02-integrity «标记出现在哪一行»
// step 1), from the sources table: what `stateAt` gives as a field's source, and what the marks of
// premises are found on.

import type {
  CompiledBaseField,
  CompiledBaseTable,
  FieldId,
  FieldValue,
} from "@fluxvita/saveslot-contract-core";
import { INSTANT_TEXT, physical, selectOf } from "../store/layout.ts";
import type { ReadTx } from "../store/ports.ts";
import { READABLE_CONTENT } from "../store/readable-content.ts";
import { sameValue } from "./same-value.ts";

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

export const cellValue = (f: CompiledBaseField, c: StateCell, decode: Decode): FieldValue =>
  decode(
    f,
    selectOf(f).map((_, i) => c[`c_${f.id}_${i}`]),
  );

/** The cells of a row or entity in effect at version position `ver` (`rec_from ≤ ver < rec_to`). */
export async function cellsAt(
  tx: ReadTx,
  t: CompiledBaseTable,
  rowId: string,
  ver: number,
): Promise<StateCell[]> {
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
  return [...r.rows];
}

/** `cellsAt` for the rows of a page at once, by row: one statement, whatever their number. */
export async function cellsOfRows(
  tx: ReadTx,
  t: CompiledBaseTable,
  rowIds: readonly string[],
  ver: number,
): Promise<Map<string, StateCell[]>> {
  const { versions } = physical(t);
  const interval =
    t.time.type === "state"
      ? t.time.granularity === "date"
        ? "valid_from::text AS vf, valid_to::text AS vt"
        : `to_char(valid_from, ${INSTANT_TEXT}) AS vf, to_char(valid_to, ${INSTANT_TEXT}) AS vt`
      : "NULL AS vf, NULL AS vt";
  const cols = t.fields.flatMap((f) => selectOf(f).map((x, i) => `${x} AS c_${f.id}_${i}`));
  const r = await tx.query<StateCell & { row_id: string }>(
    `SELECT row_id, field_id, ${interval}, revoked, no_value, src_event, src_field, src_k,
       ${cols.join(", ")}
     FROM ${versions}
     WHERE row_id = ANY($1) AND rec_from <= $2 AND (rec_to IS NULL OR rec_to > $2)`,
    [[...rowIds], ver] as never,
  );
  const out = new Map<string, StateCell[]>();
  for (const c of r.rows) {
    const list = out.get(c.row_id) ?? [];
    list.push(c);
    out.set(c.row_id, list);
  }
  return out;
}

type SourceRow = {
  row_id?: string;
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

const SOURCE_COLUMNS = `b.row_id, b.event_seq, b.field_id, b.k, b.carried_event, b.carried_field,
       b.carried_k, b.status, b.valid_from, b.valid_to, b.reverted, c.body`;
const SOURCE_FROM = `FROM base_sources b
     JOIN events e ON e.seq = b.event_seq
     LEFT JOIN ${READABLE_CONTENT} c ON c.seq = b.event_seq
       AND c.path = 'fields/' || b.field_id || '/' || b.k`;

/** How the 出处项 are read. */
export interface SourceOptions {
  /**
   * A corroboration counts as reverted only by registrations of operations up to the version read
   * (a receipt rebuilt later must read what was so then); otherwise by every registration of now.
   */
  readonly revertsUpToVer?: boolean;
}

/** The 出处项 of a row's cells from its rows of the sources table (see `sourceItemsAt`). */
function itemsFrom(
  rows: readonly SourceRow[],
  t: CompiledBaseTable,
  decode: Decode,
  ver: number,
  o: SourceOptions,
): (field: FieldId, cell: StateCell) => string[] {
  const carried = new Map<string, string[]>();
  const corroborations: SourceRow[] = [];
  for (const x of rows) {
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
    if (set.size === 0) return [];
    const f = t.fields.find((x) => x.id === field);
    const value = f === undefined ? null : cellValue(f, cell, decode);
    for (const x of corroborations) {
      if (x.field_id !== field) continue;
      const reverts = JSON.parse(x.reverted) as { op?: number }[];
      if (reverts.some((r) => o.revertsUpToVer !== true || (r.op ?? 0) <= ver)) continue;
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
    return [...set].sort();
  };
}

/**
 * The 出处项 of each field cell, from the sources table: the contribution that gave the cell its
 * value, followed through its carried references to the end, and the corroborations of the same
 * value still in force (not reverted, content not deleted, on a state table meeting the cell's
 * interval). What the table holds is read as of now, limited to operations up to `ver`: an item's
 * status and its registrations of being reverted are those of now.
 */
export async function sourceItemsAt(
  tx: ReadTx,
  t: CompiledBaseTable,
  rowId: string,
  ver: number,
  decode: Decode,
  o: SourceOptions = {},
): Promise<(field: FieldId, cell: StateCell) => string[]> {
  const r = await tx.query<SourceRow>(
    `SELECT ${SOURCE_COLUMNS}
     ${SOURCE_FROM}
     WHERE b.row_id = $1 AND e.op <= $2 AND b.field_id <> 'existence'`,
    [rowId, ver],
  );
  return itemsFrom(r.rows, t, decode, ver, o);
}

/** `sourceItemsAt` for the rows of a page at once: one statement, whatever their number. */
export async function sourceItemsOfRows(
  tx: ReadTx,
  t: CompiledBaseTable,
  rowIds: readonly string[],
  ver: number,
  decode: Decode,
  o: SourceOptions = {},
): Promise<(rowId: string, field: FieldId, cell: StateCell) => string[]> {
  const r = await tx.query<SourceRow>(
    `SELECT ${SOURCE_COLUMNS}
     ${SOURCE_FROM}
     WHERE b.row_id = ANY($1) AND e.op <= $2 AND b.field_id <> 'existence'`,
    [[...rowIds], ver] as never,
  );
  const byRow = new Map<string, SourceRow[]>();
  for (const x of r.rows) {
    const list = byRow.get(x.row_id as string) ?? [];
    list.push(x);
    byRow.set(x.row_id as string, list);
  }
  const of = new Map([...byRow].map(([row, rows]) => [row, itemsFrom(rows, t, decode, ver, o)]));
  return (rowId, field, cell) => of.get(rowId)?.(field, cell) ?? [];
}
