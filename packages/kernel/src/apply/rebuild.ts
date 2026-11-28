// A base table rebuilt for a new schema version, by row (03-data-model/08-schema-migration.md
// «物理做法»; 07-schema-evolution.md «确定性转换怎么重放»; 09-event-format.md §5.5
// `schema.switched`; the decision record `schema-change-p4.md` §2). One function, by row or
// entity: `apply` calls it for every row at a `schema.switched` that rebuilds the table, and the
// online build calls the same one batch by batch, so that "online build = replay from empty" does
// not rest on two pieces of code agreeing.
//
// - The version table: every cell of the old version's version table, closed or open, carried with
//   its value converted; cells of a dropped field are not carried; `rec_from`, `rec_to`, the source,
//   `intent`, `revoked` and `no_value` stay as they are. The history is in the new version's shape
//   (a premise check reads it). Reading as of a moment before the switch reads the retired table.
// - The business table: settled for the new definition from the row's items in effect, each
//   converted from the version it was written in, with the switch's constant `backfill` items as
//   the event records them. The settled cells are held to the converted open cells: the same cells
//   with the same values; the only differences allowed are the constant's own cells (opened at the
//   switch, intent `schema_switch`) and the cells they take the place of (closed at the switch).
//   Conversion is by item and settling only picks items, so anything else is a defect.
// - The source table: each constant's item, of kind `schema_const`, registered as recorded.
//
// A row's `ver` is not changed by the switch: open cells keep their `rec_from`, and a constant's
// cells (`schema_switch`) do not count in it. A row whose latest cell was in a dropped field has a
// smaller `ver` after it (04-contract §2: `ver` is the last operation that changed the current
// state, and a migration does not).

import { createHash } from "node:crypto";
import {
  type CompiledBaseField,
  type CompiledBaseTable,
  canonicalize,
  type FieldId,
  type FieldValue,
  type JsonValue,
  type Seq,
} from "@fluxvita/saveslot-contract-core";
import { physical, selectOf } from "../store/layout.ts";
import type { ReadTx, SqlValue } from "../store/ports.ts";
import { interval, WHOLE } from "../time/index.ts";
import { canonical, rationalOf } from "../values/index.ts";
import { type ConvertFailure, convertFieldValue, type TableMap } from "./convert.ts";
import { ApplyError, type Backfill, type Change } from "./model.ts";
import { type ConstOf, rowItems } from "./row-items.ts";
import type { SettleItem } from "./settle.ts";
import { contentThrough, mapsBetween, type SlotVersion, versionAt } from "./shapes.ts";
import {
  BASE_SOURCE_COLUMNS,
  columnValues,
  type OpenCell,
  settleRowChanges,
  sourceRows,
} from "./write-base.ts";

/** A table rebuilt at a switch. */
export interface RebuildSpec {
  /** The table as the version switched from defines it (its physical tables are the old ones). */
  readonly from: CompiledBaseTable;
  /** The table as the version switched to defines it. */
  readonly to: CompiledBaseTable;
  readonly map: TableMap;
  /** The slot's versions that took effect, and the one switched to last. */
  readonly versions: readonly SlotVersion[];
  /** The version switched to. */
  readonly sv: number;
  readonly switchSeq: Seq;
  readonly switchOp: Seq;
  readonly backfill: Backfill;
  readonly constOf: ConstOf;
}

/** A conversion the switch cannot make: the build fails (`build_failed`). */
export class RebuildError extends Error {
  override readonly name = "RebuildError";
  readonly row: string;
  readonly failure: ConvertFailure;
  constructor(row: string, failure: ConvertFailure) {
    super(`row ${row}: field ${failure.field} does not convert (${failure.why})`);
    this.row = row;
    this.failure = failure;
  }
}

const isState = (t: CompiledBaseTable) => t.time.type === "state";
const isInstant = (t: CompiledBaseTable) =>
  t.time.type === "state" && t.time.granularity === "instant";
const asText = (col: string, instant: boolean) =>
  instant ? `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` : `${col}::text`;

/** A field's stored columns as a value (read through `selectOf`). */
export function decodeStored(f: CompiledBaseField, cells: readonly unknown[]): FieldValue {
  const [v, zone] = cells;
  if (v === null || v === undefined) return null;
  switch (f.type) {
    case "boolean":
      return v as boolean;
    case "integer":
    case "decimal":
      return canonical(rationalOf(String(v)));
    case "quantity":
      return { value: canonical(rationalOf(String(v))), unit: f.unit.code };
    case "zoned_datetime":
      return { instant: String(v) as never, zone: String(zone) };
    default:
      return String(v);
  }
}

const fieldColumnNames = (t: CompiledBaseTable) =>
  t.fields.flatMap((f) =>
    f.type === "zoned_datetime" ? [`f_${f.id}`, `f_${f.id}__zone`] : [`f_${f.id}`],
  );

/** The rows and entities a rebuild goes through: every one with a cell, and every one filled. */
export async function rebuildRows(tx: ReadTx, spec: RebuildSpec): Promise<string[]> {
  const { versions } = physical(spec.from);
  const r = await tx.query<{ row_id: string }>(`SELECT DISTINCT row_id FROM ${versions}`);
  const ids = new Set(r.rows.map((x) => x.row_id));
  for (const rows of spec.backfill.rows.values()) for (const id of rows) ids.add(id);
  for (const id of spec.backfill.stretches.keys()) ids.add(id);
  return [...ids].sort();
}

/** The constant `backfill` items of a row, as the switch records them. */
function constItems(spec: RebuildSpec, rowId: string): SettleItem[] {
  const out: SettleItem[] = [];
  const by = (field: FieldId) => {
    const value = spec.backfill.values.get(field);
    if (value === undefined) throw new Error(`no constant of field ${field}`);
    return value;
  };
  if (isState(spec.to)) {
    const k = new Map<FieldId, number>();
    for (const s of spec.backfill.stretches.get(rowId) ?? []) {
      const n = k.get(s.field) ?? 0;
      k.set(s.field, n + 1);
      out.push({
        event: spec.switchSeq,
        target: s.field,
        k: n,
        status: "applied",
        valid: interval(s.from as never, s.to as never),
        content: { kind: "value", value: by(s.field) },
        reverted: [],
      });
    }
  } else {
    for (const [field, rows] of spec.backfill.rows) {
      if (!rows.has(rowId)) continue;
      out.push({
        event: spec.switchSeq,
        target: field,
        k: 0,
        status: "applied",
        valid: [WHOLE],
        content: { kind: "value", value: by(field) },
        reverted: [],
      });
    }
  }
  return out;
}

/**
 * The changes rebuilding row or entity `rowId` in the new version's tables. `table`: its business
 * and version tables (cleared first: a row built again in an online build replaces what it had);
 * `sources`: the source table's rows of the switch's constants on it, registered at the switch.
 * Throws {@link RebuildError} on a value that does not convert, {@link ApplyError} on a settled
 * state the converted cells do not agree with.
 */
export async function planRebuildRow(
  tx: ReadTx,
  spec: RebuildSpec,
  rowId: string,
): Promise<{ table: Change[]; sources: Change[] }> {
  const { from, to, map } = spec;
  const state = isState(from);
  const instant = isInstant(from);
  const old = physical(from);
  const next = physical(to);
  const inconsistent = (what: string) =>
    new ApplyError("inconsistent", spec.switchSeq, `table ${to.id}, row ${rowId}: ${what}`);

  // 1. The version table, every cell carried and converted.
  const selects = from.fields.flatMap((f) => selectOf(f).map((s, i) => `${s} AS "v_${f.id}_${i}"`));
  const r = await tx.query<Record<string, unknown>>(
    `SELECT field_id, ${state ? `${asText("valid_from", instant)} AS valid_from, ${asText("valid_to", instant)} AS valid_to,` : ""}
       rec_from, rec_to, intent, src_event, src_field, src_k, revoked, no_value
       ${selects.length > 0 ? `, ${selects.join(", ")}` : ""}
     FROM ${old.versions} WHERE row_id = $1 ORDER BY field_id COLLATE "C", rec_from${state ? ", valid_from" : ""}`,
    [rowId],
  );
  const cols = fieldColumnNames(to);
  const columns = [
    "row_id",
    "field_id",
    ...(state ? ["valid_from", "valid_to"] : []),
    "rec_from",
    "rec_to",
    "intent",
    "src_event",
    "src_field",
    "src_k",
    "revoked",
    "no_value",
    ...cols,
  ];
  const carried: SqlValue[][] = [];
  const openCells: OpenCell[] = [];
  /** The converted value of each open cell, by its identity. */
  const openValues = new Map<string, FieldValue>();
  for (const c of r.rows) {
    const field = c["field_id"] as string;
    let value: FieldValue = null;
    if (field !== "existence") {
      const m = map.fields.get(field as FieldId);
      if (m === undefined)
        throw inconsistent(`a cell of field ${field}, not in version ${spec.sv - 1}`);
      if (m.op === "drop") continue;
      const f = from.fields.find((x) => x.id === field) as CompiledBaseField;
      const stored = decodeStored(
        f,
        selectOf(f).map((_, i) => c[`v_${f.id}_${i}`]),
      );
      const v = convertFieldValue(m, stored);
      if (!v.ok) throw new RebuildError(rowId, { ok: false, field: field as FieldId, why: v.why });
      value = v.value;
    }
    const vf = state ? (c["valid_from"] as string) : null;
    const vt = state ? ((c["valid_to"] as string | null) ?? null) : null;
    const src =
      c["src_event"] === null
        ? null
        : {
            event: Number(c["src_event"]) as Seq,
            target: c["src_field"] as never,
            k: Number(c["src_k"]),
          };
    carried.push([
      rowId,
      field,
      ...(state ? [vf, vt] : []),
      Number(c["rec_from"]),
      c["rec_to"] === null ? null : Number(c["rec_to"]),
      c["intent"] as string,
      src?.event ?? null,
      src?.target ?? null,
      src?.k ?? null,
      c["revoked"] as boolean | null,
      c["no_value"] as boolean | null,
      ...to.fields.flatMap((f) => columnValues(to, f.id, f.id === field ? value : null)),
    ]);
    if (c["rec_to"] === null) {
      const cell: OpenCell = {
        field,
        valid_from: vf,
        valid_to: vt,
        src,
        no_value: c["no_value"] === true,
        rec_from: Number(c["rec_from"]) as Seq,
      };
      openCells.push(cell);
      openValues.set(identity(field, vf, vt, src, cell.no_value), value);
    }
  }

  // 2. The row's items in effect, each in the new version's shape; then the switch's constants.
  const items: SettleItem[] = [];
  for (const x of await rowItems(tx, to.id, rowId, spec.constOf)) {
    if (x.event === spec.switchSeq) continue; // the constants come from the event below
    const sv = x.constSv ?? versionAt(spec.versions, x.shapeSeq);
    const c = contentThrough(mapsBetween(spec.versions, to.id, sv, spec.sv), x.target, x.content);
    if (!c.ok) throw new RebuildError(rowId, c);
    if (c.content === null) continue;
    const { shapeSeq: _, constSv: __, ...item } = x;
    items.push({ ...item, content: c.content });
  }
  const consts = constItems(spec, rowId);
  const { settled, changes } = settleRowChanges(
    to,
    rowId,
    [...items, ...consts],
    openCells,
    0,
    spec.switchOp,
    "schema_switch",
  );

  // 3. The settled cells held to the converted open cells.
  const filled = new Set(consts.map((x) => x.target));
  for (const cell of settled.cells) {
    const key = identity(
      cell.field,
      cell.valid?.from ?? null,
      cell.valid?.to ?? null,
      cell.by,
      cell.noValue === true,
    );
    const was = openValues.get(key);
    if (was !== undefined || openValues.has(key)) {
      if (canonicalize(was as JsonValue) !== canonicalize(cell.value as JsonValue))
        throw inconsistent(`cell of ${cell.field} settles to another value than converted`);
    } else if (cell.by?.event !== spec.switchSeq && !emptyOf(cell))
      throw inconsistent(`cell of ${cell.field} settles where no converted cell is`);
  }
  const cellsChange = changes.find((c) => c.kind === "cells");
  if (cellsChange?.kind === "cells")
    for (const x of cellsChange.close)
      if (!filled.has(x.field as FieldId))
        throw inconsistent(`converted cell of ${x.field} does not settle again`);

  // A field empty where nothing gives it a value, with no converted cell (a field a version added,
  // never written on this row): the switch opens no cell for it, so that a switch makes no version
  // but its constants' (09 §6.2 `schema_switch`); the row's next operation opens it, as for any
  // field. The cells change lists the columns of `settleRowChanges`.
  const withoutEmpty = (c: Change): Change => {
    if (c.kind !== "cells") return c;
    const at = (name: string) => c.columns.indexOf(name);
    const [iField, iFrom, iTo, iSrc, iNoValue] = [
      "field_id",
      "valid_from",
      "valid_to",
      "src_event",
      "no_value",
    ].map(at) as [number, number, number, number, number];
    return {
      ...c,
      rows: c.rows.filter(
        (row) =>
          row[iSrc] !== null ||
          row[iNoValue] === true ||
          openValues.has(
            identity(
              row[iField] as string,
              state ? (row[iFrom] as string) : null,
              state ? ((row[iTo] as string | null) ?? null) : null,
              null,
              false,
            ),
          ),
      ),
    };
  };
  const table: Change[] = [
    {
      kind: "rows_replace",
      table: next.versions.slice(1, -1),
      key: "row_id",
      id: rowId,
      columns,
      rows: [],
    },
    { kind: "rows_insert", table: next.versions, columns, rows: carried },
    ...changes.filter((c) => c.kind !== "counts_add").map(withoutEmpty),
  ];
  const sources: Change[] =
    consts.length === 0
      ? []
      : [
          {
            kind: "rows_insert",
            table: "base_sources",
            columns: BASE_SOURCE_COLUMNS,
            rows: consts.flatMap((x) =>
              sourceRows(spec.switchSeq, rowId, x, {}, null, {
                sources: [{ kind: "schema_const", sv: spec.sv, field: x.target }],
              }),
            ),
          },
        ];
  return { table, sources };
}

/** A cell of a field empty where nothing gives it a value. */
const emptyOf = (c: {
  readonly by: unknown;
  readonly value: FieldValue;
  readonly noValue?: true;
}) => c.by === null && c.value === null && c.noValue !== true;

const identity = (
  field: string,
  from: string | null,
  to: string | null,
  src: { readonly event: Seq; readonly target: string; readonly k: number } | null,
  noValue: boolean,
) =>
  JSON.stringify([field, from, to, src === null ? null : [src.event, src.target, src.k], noValue]);

/**
 * A table's logical rows counted, and their checksum (09 §5.13): each row not revoked as
 * `{"id", "valid" (state tables), "fields": {<field ID>: <value>}}`, every field of the version,
 * ordered by `id` then `valid.from`, each row's JCS joined by a newline, SHA-256 of the whole.
 */
export async function tableChecksum(
  tx: ReadTx,
  t: CompiledBaseTable,
): Promise<{ rows: number; checksum: string }> {
  const state = isState(t);
  const instant = isInstant(t);
  const { business } = physical(t);
  const selects = t.fields.flatMap((f) => selectOf(f).map((s, i) => `${s} AS "v_${f.id}_${i}"`));
  const r = await tx.query<Record<string, unknown>>(
    `SELECT ${state ? `entity_id AS id, ${asText("valid_from", instant)} AS valid_from, ${asText("valid_to", instant)} AS valid_to` : "row_id AS id"}
       ${selects.length > 0 ? `, ${selects.join(", ")}` : ""}
     FROM ${business}${state ? "" : " WHERE NOT revoked"}`,
  );
  const lines = r.rows.map((x) => {
    const fields: Record<string, JsonValue> = {};
    for (const f of t.fields)
      fields[f.id] = decodeStored(
        f,
        selectOf(f).map((_, i) => x[`v_${f.id}_${i}`]),
      ) as JsonValue;
    const valid =
      x["valid_to"] === null || x["valid_to"] === undefined
        ? { from: x["valid_from"] as string }
        : { from: x["valid_from"] as string, to: x["valid_to"] as string };
    return {
      id: x["id"] as string,
      from: state ? (x["valid_from"] as string) : "",
      text: canonicalize(
        (state ? { id: x["id"], valid, fields } : { id: x["id"], fields }) as JsonValue,
      ),
    };
  });
  lines.sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : a.from < b.from ? -1 : a.from > b.from ? 1 : 0,
  );
  return {
    rows: lines.length,
    checksum: createHash("sha256")
      .update(lines.map((x) => x.text).join("\n"))
      .digest("hex"),
  };
}
