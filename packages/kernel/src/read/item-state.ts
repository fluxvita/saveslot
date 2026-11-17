// The row behind a pending item as of an operation (04-contract-types §4.8 `ConflictDetail.effective`
// and `.previous`, `AwaitingDetail.current`): the version table's cells at the item's version, that
// operation included (the side in effect), or at the merge base (`previous`), limited to the item's
// spans and its unit's fields ("existence": the whole row). Which cells there are and what gave a
// stretch its state come from ../pending/cells.ts, which the write receipt's candidates use too;
// here the values are decoded.
// - State tables: the item's spans cut where the cells change, each piece with its values and the
//   write that gave its state; a hole a revoke left gives that revoke, `values: null`.
// - Event and timeless tables: the row then, `exists` false when revoked (with the revoke).

import type {
  CompiledBaseField,
  CompiledBaseTable,
  FieldValue,
} from "@fluxvita/saveslot-contract-core";
import {
  opOfCell,
  type RowCell,
  rowCellsAt,
  rowOf as rowStateOf,
  type Span,
  piecesOver as stretchesOver,
} from "../pending/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { decode, selectOf } from "./select.ts";

/** The cells of one row or entity in effect after operation `s` (that operation included). */
export function rowCellsAsOf(
  tx: ReadTx,
  t: CompiledBaseTable,
  id: string,
  s: number,
): Promise<RowCell[]> {
  return rowCellsAt(tx, t, id, s);
}

const cellValue = (f: CompiledBaseField, c: RowCell): FieldValue =>
  decode(
    f,
    selectOf(f).map((_, i) => c[`c_${f.id}_${i}`]),
  );

/** A piece of the row: its interval, its values (null: none), and the write that gave its state. */
export interface Piece {
  readonly from: string | null;
  readonly to: string | null;
  readonly values: Readonly<Record<string, FieldValue>> | null;
  readonly op?: number;
}

/** The fields a unit reads: its own, or every field for "existence". */
function fieldsOf(t: CompiledBaseTable, unit: readonly string[]): CompiledBaseField[] {
  return unit.includes("existence") ? [...t.fields] : t.fields.filter((f) => unit.includes(f.id));
}

/** The values of `fields` from `cells` (by name), or null when none of them has a cell. */
function valuesFrom(
  fields: readonly CompiledBaseField[],
  cells: readonly RowCell[],
): Record<string, FieldValue> | null {
  const mine = cells.filter((c) => fields.some((f) => f.id === c.field_id));
  if (mine.length === 0) return null;
  const values: Record<string, FieldValue> = Object.create(null);
  for (const f of fields) {
    const c = mine.find((x) => x.field_id === f.id);
    values[f.name] = c === undefined ? null : cellValue(f, c);
  }
  return values;
}

/** A state entity's pieces over `spans`: pieces with the same values and write run together. */
export function piecesOver(
  t: CompiledBaseTable,
  cells: readonly RowCell[],
  spans: readonly Span[],
  unit: readonly string[],
): Piece[] {
  const fields = fieldsOf(t, unit);
  const out: Piece[] = [];
  for (const s of stretchesOver(t, cells, spans, unit)) {
    const op = s.giver === undefined ? undefined : opOfCell(s.giver);
    const piece: Piece = {
      from: s.from,
      to: s.to,
      values: s.revoked || s.noValue ? null : valuesFrom(fields, s.cells),
      ...(op !== undefined ? { op } : {}),
    };
    const last = out.at(-1);
    if (
      last !== undefined &&
      last.to === piece.from &&
      last.op === piece.op &&
      JSON.stringify(last.values) === JSON.stringify(piece.values)
    )
      out[out.length - 1] = { ...last, to: piece.to };
    else out.push(piece);
  }
  return out;
}

/** An event or timeless row as of the cells given: revoked or not, its values, what gave them. */
export function rowOf(
  t: CompiledBaseTable,
  cells: readonly RowCell[],
  unit: readonly string[],
): { exists: boolean; values?: Record<string, FieldValue>; op?: number } {
  const row = rowStateOf(cells, unit);
  const op = row.giver === undefined ? undefined : opOfCell(row.giver);
  if (row.revoked) return { exists: false, ...(op !== undefined ? { op } : {}) };
  if (cells.length === 0) return { exists: false };
  const values = valuesFrom(fieldsOf(t, unit), cells);
  return {
    exists: true,
    ...(values !== null ? { values } : {}),
    ...(op !== undefined ? { op } : {}),
  };
}
