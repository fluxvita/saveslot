// The row behind a pending item as of an operation (04-contract-types §4.8 `ConflictDetail.effective`
// and `.previous`, `AwaitingDetail.current`): read from the version table as of the operation — the
// item's version for the side in effect, the merge base for `previous` — the way `history`'s
// `as_of` reads it, limited to the item's spans and its unit's fields ("existence": the whole row).
// - State tables: the item's spans cut where the cells change. A piece gives the values then and
//   the write that gave them (the latest of its cells' operations); a hole a revoke left gives that
//   revoke, `values: null`; a piece no write ever gave a state is `values: null` without a write.
// - Event and timeless tables: the row then, `exists` false when revoked (with the revoke).
// The item's entries are not read here: they say what the item holds, the table what the row was.

import type {
  CompiledBaseField,
  CompiledBaseTable,
  FieldValue,
} from "@fluxvita/saveslot-contract-core";
import type { Span } from "../pending/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { decode, INSTANT_TEXT, physical, selectOf } from "./select.ts";
import type { RowCell } from "./versions.ts";

/** The cells of one row or entity in effect after operation `s`. */
export async function rowCellsAsOf(
  tx: ReadTx,
  t: CompiledBaseTable,
  id: string,
  s: number,
): Promise<RowCell[]> {
  const { versions } = physical(t);
  const state = t.time.type === "state";
  const interval = state
    ? t.time.granularity === "date"
      ? "valid_from::text AS vf, valid_to::text AS vt"
      : `to_char(valid_from, ${INSTANT_TEXT}) AS vf, to_char(valid_to, ${INSTANT_TEXT}) AS vt`
    : "NULL AS vf, NULL AS vt";
  const cols = t.fields.flatMap((f) => selectOf(f).map((x, i) => `${x} AS c_${f.id}_${i}`));
  // A cell's record start is when it was last cut, not who wrote its value: the operation of the
  // contribution that gave it (`src_event`) is (02-architecture §8, the version table).
  const r = await tx.query<RowCell & { src_op: unknown }>(
    `SELECT v.field_id, ${interval}, v.rec_from, v.revoked,
       (SELECT e.op FROM events e WHERE e.seq = v.src_event) AS src_op,
       ${cols.join(", ")} FROM ${versions} v
     WHERE v.row_id = $1 AND v.rec_from <= $2 AND (v.rec_to IS NULL OR v.rec_to > $2)`,
    [id, s],
  );
  return [...r.rows];
}

/** The operation that gave a cell (its contribution's); none for a cell no write gave a value. */
const opOfCell = (c: RowCell): number | undefined => {
  const op = (c as { src_op?: unknown }).src_op;
  return op === null || op === undefined ? undefined : Number(op);
};
const latest = (cells: readonly RowCell[]): number | undefined => {
  const ops = cells.flatMap((c) => {
    const op = opOfCell(c);
    return op === undefined ? [] : [op];
  });
  return ops.length === 0 ? undefined : Math.max(...ops);
};

const cellValue = (f: CompiledBaseField, c: RowCell): FieldValue =>
  decode(
    f,
    selectOf(f).map((_, i) => c[`c_${f.id}_${i}`]),
  );

/** A piece of the row: its interval, its values (null: none), and the write that gave it. */
export interface Piece {
  readonly from: string | null;
  readonly to: string | null;
  readonly values: Readonly<Record<string, FieldValue>> | null;
  readonly op?: number;
}

const covers = (c: RowCell, from: string | null, to: string | null) =>
  (c.vf === null || (from !== null && c.vf <= from)) &&
  (c.vt === null || (to !== null && to <= c.vt));

/** The fields a unit reads: its own, or every field for "existence". */
function fieldsOf(t: CompiledBaseTable, unit: readonly string[]): CompiledBaseField[] {
  return unit.includes("existence") ? [...t.fields] : t.fields.filter((f) => unit.includes(f.id));
}

/** The values of `fields` from `cells` (by name), or null when none of them has a cell. */
function valuesFrom(
  fields: readonly CompiledBaseField[],
  cells: readonly RowCell[],
): { values: Record<string, FieldValue> | null; op?: number } {
  const mine = cells.filter((c) => fields.some((f) => f.id === c.field_id));
  if (mine.length === 0) return { values: null };
  const values: Record<string, FieldValue> = Object.create(null);
  for (const f of fields) {
    const c = mine.find((x) => x.field_id === f.id);
    values[f.name] = c === undefined ? null : cellValue(f, c);
  }
  const op = latest(mine);
  return { values, ...(op !== undefined ? { op } : {}) };
}

const revokedPiece = (from: string | null, to: string | null, revoke: RowCell): Piece => {
  const op = opOfCell(revoke);
  return { from, to, values: null, ...(op !== undefined ? { op } : {}) };
};

/**
 * A state entity's pieces over `spans` as of the cells given: cut at every cell boundary inside
 * them, pieces with the same values and write run together.
 */
export function piecesOver(
  t: CompiledBaseTable,
  cells: readonly RowCell[],
  spans: readonly Span[],
  unit: readonly string[],
): Piece[] {
  const fields = fieldsOf(t, unit);
  const out: Piece[] = [];
  for (const s of spans) {
    const points = new Set<string>();
    for (const c of cells) {
      for (const p of [c.vf, c.vt]) {
        if (p === null) continue;
        if ((s.from === null || p > s.from) && (s.to === null || p < s.to)) points.add(p);
      }
    }
    const cuts = [s.from, ...[...points].sort(), s.to];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const from = cuts[i] ?? null;
      const to = cuts[i + 1] ?? null;
      const here = cells.filter((c) => covers(c, from, to));
      const revoke = here.find((c) => c.field_id === "existence" && c.revoked === true);
      const piece: Piece =
        revoke !== undefined
          ? revokedPiece(from, to, revoke)
          : { from, to, ...valuesFrom(fields, here) };
      const last = out.at(-1);
      if (
        last !== undefined &&
        last.to === from &&
        last.op === piece.op &&
        JSON.stringify(last.values) === JSON.stringify(piece.values)
      )
        out[out.length - 1] = { ...last, to };
      else out.push(piece);
    }
  }
  return out;
}

/** An event or timeless row as of the cells given: revoked or not, its values, the latest write. */
export function rowOf(
  t: CompiledBaseTable,
  cells: readonly RowCell[],
  unit: readonly string[],
): { exists: boolean; values?: Record<string, FieldValue>; op?: number } {
  const revoke = cells.find((c) => c.field_id === "existence" && c.revoked === true);
  if (revoke !== undefined) {
    const op = opOfCell(revoke);
    return { exists: false, ...(op !== undefined ? { op } : {}) };
  }
  if (cells.length === 0) return { exists: false };
  const { values, op } = valuesFrom(fieldsOf(t, unit), cells);
  const all = latest(cells);
  return {
    exists: true,
    ...(values !== null ? { values } : {}),
    // On the unit "existence" the whole row's latest write; on fields, theirs.
    ...(unit.includes("existence")
      ? all !== undefined
        ? { op: all }
        : {}
      : op !== undefined
        ? { op }
        : {}),
  };
}
