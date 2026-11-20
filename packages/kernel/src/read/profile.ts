// The profile of a table in `catalog` at the `table` level (docs/zh-CN/spec/04-contract.md §10
// `catalog` «概况» «规模提示»; 04-contract-types.md §4.2 `profile`): its row count, the range of its
// business time, and the scale hint. Worked out when read, from the current data: nothing is
// stored, nothing goes into an event, and the hint is no mark on the data.
//
// What a row is: a live row of the table as stored. An event or timeless table: the rows not
// revoked. A state table: its segments (a revoke is an interval with no value there, so a
// revoked stretch is no row). A derived table: its rows. The business-time range is the same
// rows' business time: the earliest and the latest value of the time field (event table); the
// earliest start and the latest end, exclusive, as every `valid_to` is, none while a segment runs
// on (state table). A timeless or derived table has none; nor has an empty table.

import type { CompiledBaseField, CompiledTable } from "@fluxvita/saveslot-contract-core";
import { computedAtRead, derivedLayout } from "../rules/index.ts";
import { column, INSTANT_TEXT, physical } from "../store/layout.ts";
import type { ReadTx } from "../store/ports.ts";
import { mergedSegments } from "../store/segments.ts";

/** The two lines of 02-architecture «容量边界与实测数值»: rows, per table. */
export interface ScaleBounds {
  readonly comfortable_rows: number;
  readonly tested_rows: number;
}

/**
 * The lines this version ships: the placeholder first values the spec gives for the PGlite
 * backend, until experiment 9 measures them (02-architecture «容量边界与实测数值»; 08-open-questions).
 */
export const SCALE_BOUNDS: ScaleBounds = { comfortable_rows: 100_000, tested_rows: 1_000_000 };

export interface Scale extends ScaleBounds {
  readonly level: "large" | "beyond_tested";
}

export interface TableProfile {
  readonly rows: number;
  /** `to` for a state table is the latest `valid_to` (exclusive); none while a segment runs on. */
  readonly time_range?: { readonly from: string; readonly to?: string };
  readonly scale?: Scale;
}

/** The scale hint of a table with `rows` rows; none at or below the comfortable line. */
export function scaleOf(rows: number, bounds: ScaleBounds): Scale | undefined {
  if (rows <= bounds.comfortable_rows) return undefined;
  return {
    level: rows <= bounds.tested_rows ? "large" : "beyond_tested",
    comfortable_rows: bounds.comfortable_rows,
    tested_rows: bounds.tested_rows,
  };
}

interface Counted {
  n: unknown;
  lo: string | null;
  hi: string | null;
}

/** A table's profile: counted in the read transaction, over the whole table the caller can see. */
export async function profileOf(
  tx: ReadTx,
  t: CompiledTable,
  bounds: ScaleBounds = SCALE_BOUNDS,
): Promise<TableProfile | undefined> {
  // A derived table computed when read has no stored rows to count, and computing its rule is not
  // the catalog's to do: no profile (04-contract §10 «概况»).
  if (t.kind === "derived" && computedAtRead(t)) return undefined;
  let sql: string;
  if (t.kind === "derived") {
    sql = `SELECT count(*) AS n, NULL::text AS lo, NULL::text AS hi FROM "${derivedLayout(t).table}"`;
  } else {
    const { business } = physical(t);
    if (t.time.type === "event") {
      const timeId = t.time.field;
      const f = t.fields.find((x) => x.id === timeId) as CompiledBaseField;
      const c = column(f);
      const text = (e: string) =>
        f.type === "date" ? `${e}::text` : `to_char(${e}, ${INSTANT_TEXT})`;
      sql = `SELECT count(*) AS n, ${text(`min(${c})`)} AS lo, ${text(`max(${c})`)} AS hi FROM ${business} WHERE NOT revoked`;
    } else if (t.time.type === "state") {
      const text = (e: string) =>
        t.time.type === "state" && t.time.granularity === "date"
          ? `${e}::text`
          : `to_char(${e}, ${INSTANT_TEXT})`;
      // Segments after merging the adjacent ones of an entity that hold the same values, by the one
      // generator `sql` reads state tables through (../store/segments.ts): the physical cut changes
      // no count. Merging keeps an island's earliest start and latest end, so the range is the same.
      sql = `SELECT count(*) AS n, ${text("min(valid_from)")} AS lo, ${text("CASE WHEN bool_or(valid_to IS NULL) THEN NULL ELSE max(valid_to) END")} AS hi FROM (${mergedSegments(t, business)}) AS "m"`;
    } else {
      sql = `SELECT count(*) AS n, NULL::text AS lo, NULL::text AS hi FROM ${business} WHERE NOT revoked`;
    }
  }
  const [row] = (await tx.query<Counted>(sql)).rows;
  const rows = Number(row?.n ?? 0);
  const scale = scaleOf(rows, bounds);
  return {
    rows,
    ...(row?.lo != null
      ? { time_range: { from: row.lo, ...(row.hi != null ? { to: row.hi } : {}) } }
      : {}),
    ...(scale !== undefined ? { scale } : {}),
  };
}
