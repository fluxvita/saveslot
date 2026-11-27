// Who gave a row its state where a pending item is, as the version table's cells say
// (04-contract-types §5.1 `FieldResult.by`, §4.8 `ConflictDetail.effective`). One reading for the
// write receipt's candidates and the item's details, both at an operation, that operation included
// (the receipt at its own, as the request left the row; the details at the item's version).
// - A stretch whose unit fields have cells: the write those cells come from, the latest.
// - A stretch without a value that a revoke or an undo left so: that operation (the existence
//   cell of the revoke; the empty cells of the fields that decide "has a value").
// - Any other stretch (never written there) has no giver, and a part none of whose stretches has
//   one has none.
// Values are not decoded here: a caller decodes the cells it is given.

import type { CompiledBaseTable, FieldId } from "@fluxvita/saveslot-contract-core";
import { INSTANT_TEXT, physical, selectOf } from "../store/layout.ts";
import type { ReadTx } from "../store/ports.ts";
import { cellWithheld, withholdingIn } from "../store/readable-content.ts";
import type { Span } from "./detail.ts";

/** A cell of one row or entity: field, business interval, revoke, its contribution, raw values. */
export type RowCell = {
  readonly field_id: string;
  readonly vf: string | null;
  readonly vt: string | null;
  readonly revoked: boolean | null;
  /** A state table's field cell saying the entity has no value there (`__ver.no_value`). */
  readonly no_value: boolean | null;
  /** The operation of the contribution that gave the cell (`src_event`'s); none: no write did. */
  readonly src_op: unknown;
  readonly src_event: unknown;
  readonly src_field: string | null;
  readonly src_k: number | null;
  /** Only when asked for (`withheld`): its value a deletion removed (`cellWithheld`). */
  readonly withheld?: boolean;
} & Readonly<Record<string, unknown>>;

/**
 * The cells of one row or entity right after operation `op`, that operation included. Cells
 * before an operation are only ever closed by later ones, never changed or removed, so the reading
 * is the same at any later time. Raw value columns: `c_<field>_<i>` (../store `selectOf`).
 */
export async function rowCellsAt(
  tx: ReadTx,
  t: CompiledBaseTable,
  id: string,
  op: number,
  /** Read whether each cell's value a deletion removed (`cellWithheld`): for a past operation. */
  o: { readonly withheld?: boolean } = {},
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
  const r = await tx.query<RowCell>(
    `SELECT v.field_id, ${interval}, v.revoked, v.no_value, v.src_event, v.src_field, v.src_k,
       (SELECT e.op FROM events e WHERE e.seq = v.src_event) AS src_op,
       ${o.withheld === true ? `${cellWithheld("v", await withholdingIn(tx))} AS withheld, ` : ""}${cols.join(", ")} FROM ${versions} v
     WHERE v.row_id = $1 AND v.rec_from <= $2 AND (v.rec_to IS NULL OR v.rec_to > $2)`,
    [id, op],
  );
  return [...r.rows];
}

/** The operation that gave a cell; none for a cell no write gave. */
export const opOfCell = (c: RowCell): number | undefined =>
  c.src_op === null || c.src_op === undefined ? undefined : Number(c.src_op);

/**
 * The fields whose values together decide whether a state entity has a value at a point
 * (03-data-model/05-time «无值区间»): the required ones without a constant backfill; none: any
 * field's value does. The judgement takes them from here (../write `tableShape`); the readers of
 * the version table below do not: they read the cells apply wrote (`no_value`), and apply's settle
 * counts every required field, a constant backfill's included. The two differ only on a required
 * field with a constant backfill, which this version's schema cannot create (a new slot's document
 * refuses `backfill`); they are to be made one, the spec's way, with schema evolution.
 */
export function valuedFields(t: CompiledBaseTable): FieldId[] {
  const isConst = (b: unknown) =>
    b !== null && typeof b === "object" && Object.hasOwn(b as object, "const");
  return t.fields
    .filter((f) => f.required === true && !(f.backfill !== undefined && isConst(f.backfill)))
    .map((f) => f.id);
}

/** The cell, among `cells`, that gave the latest of them; undefined when none was given. */
function latestOf(cells: readonly RowCell[]): RowCell | undefined {
  let top: RowCell | undefined;
  for (const c of cells) {
    const op = opOfCell(c);
    if (op !== undefined && (top === undefined || op > (opOfCell(top) as number))) top = c;
  }
  return top;
}

/** A stretch of the row, or the whole row: the cells covering it and what gave its state. */
export interface Piece {
  readonly from: string | null;
  readonly to: string | null;
  /** The cells covering the stretch. */
  readonly cells: readonly RowCell[];
  /** A revoke's hole. */
  readonly revoked: boolean;
  /** No value there (a state entity; not a hole a revoke left). */
  readonly noValue: boolean;
  /** The cell whose contribution gave the stretch its state; none: no write did. */
  readonly giver?: RowCell;
}

/** The fields a unit reads: its own, or every field for "existence". */
const fieldsOf = (t: CompiledBaseTable, unit: readonly string[]): string[] =>
  unit.includes("existence") ? t.fields.map((f) => f.id) : [...unit];

const covers = (c: RowCell, from: string | null, to: string | null) =>
  (c.vf === null || (from !== null && c.vf <= from)) &&
  (c.vt === null || (to !== null && to <= c.vt));

/**
 * A state entity's stretches over `spans`: cut at every cell boundary inside them; stretches with
 * the same giver and the same cells run together.
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
      const piece = pieceOf(here, from, to, fields);
      const last = out.at(-1);
      if (
        last !== undefined &&
        last.to === from &&
        last.giver === piece.giver &&
        last.revoked === piece.revoked &&
        last.noValue === piece.noValue &&
        sameCells(last.cells, piece.cells)
      )
        out[out.length - 1] = { ...last, to };
      else out.push(piece);
    }
  }
  return out;
}

const sameCells = (a: readonly RowCell[], b: readonly RowCell[]) =>
  a.length === b.length && a.every((c) => b.includes(c));

function pieceOf(
  here: readonly RowCell[],
  from: string | null,
  to: string | null,
  fields: readonly string[],
): Piece {
  // Revoked here: no value. The giver is what left it so last, the revoke or a no_value cell beside
  // it, whichever operation is later. Both are there on a table with no required field when a
  // confirmed undo writes a field back without a value over a stretch another revoke still holds:
  // the stretch had a value until that undo, and a writer that read as far as the revoke has not
  // seen what the undo did (04-contract-types §5.1 `by`).
  const revoke = here.find((c) => c.field_id === "existence" && c.revoked === true);
  if (revoke !== undefined) {
    const giver = latestOf([revoke, ...here.filter((c) => c.no_value === true)]);
    return { from, to, cells: here, revoked: true, noValue: false, ...given(giver) };
  }
  // (On a required field with a constant backfill this follows settle, not `valuedFields`: see
  // there.)
  // The entity has a value where a field cell is not marked no_value: apply writes every field's
  // cell where it has one, a cleared or never written field included (05-time «无值区间», a clear
  // is a contribution); where it has none, only the no_value cells of what left it so (an undo's
  // write-back), the giver; none at all where it was never written.
  if (!here.some((c) => c.field_id !== "existence" && c.no_value !== true)) {
    const giver = latestOf(here.filter((c) => c.no_value === true));
    return { from, to, cells: here, revoked: false, noValue: true, ...given(giver) };
  }
  const giver = latestOf(here.filter((c) => fields.includes(c.field_id)));
  return { from, to, cells: here, revoked: false, noValue: false, ...given(giver) };
}

const given = (c: RowCell | undefined) => (c === undefined ? {} : { giver: c });

/**
 * An event or timeless row: revoked or not, and what gave its state: the revoke; on the unit
 * "existence" the latest of all its cells; on fields, the latest of theirs.
 */
export function rowOf(cells: readonly RowCell[], unit: readonly string[]): Piece {
  const revoke = cells.find((c) => c.field_id === "existence" && c.revoked === true);
  if (revoke !== undefined) {
    return { from: null, to: null, cells, revoked: true, noValue: false, ...given(revoke) };
  }
  const mine = unit.includes("existence") ? cells : cells.filter((c) => unit.includes(c.field_id));
  return {
    from: null,
    to: null,
    cells,
    revoked: false,
    noValue: cells.length === 0,
    ...given(latestOf(mine)),
  };
}

/** The latest giver of `pieces`: a part's `by` (04-contract-types §5.1), the details' top `seq`. */
export function latestGiver(pieces: readonly Piece[]): RowCell | undefined {
  return latestOf(pieces.flatMap((p) => (p.giver !== undefined ? [p.giver] : [])));
}
