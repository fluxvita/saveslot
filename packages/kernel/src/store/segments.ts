// The segments of a state table as a reader sees them (03-data-model/11-restricted-sql.md «时间»
// «SQL 看到的段»; 05-time «状态类表的状态»): the physical table is cut wherever a write cut it, and
// two adjacent segments of one entity that hold the same values are one segment to every reader.
// This is the one place that says so in SQL: `sql` reads a state table through it, and the profile
// of a table in `catalog` counts and bounds its rows through it, so the two cannot disagree about
// what a segment is.
//
// A segment `s` is joined to the one before it (the same entity's, in business-time order) when it
// starts where that one ends (`valid_from = lag(valid_to)`; an open end meets nothing) and every
// field, with a zoned date-time's zone, holds the same value (`IS DISTINCT FROM` takes NULL as a
// value: two empty fields are the same). The segments are then numbered by islands: the number of
// segments that are not joined, up to and including this one. An island starts at its first
// segment and ends at the latest end of its segments, open if any of them is.

import type { CompiledBaseTable } from "@fluxvita/saveslot-contract-core";
import { column, physical } from "./layout.ts";

/** The columns the merged segments have, as the physical table names them. */
export interface SegmentColumns {
  /** `entity_id`, `valid_from`, `valid_to`. */
  readonly keys: readonly ["entity_id", "valid_from", "valid_to"];
  /** The fields' columns, a zoned date-time's zone column after its instant. */
  readonly fields: readonly string[];
}

/** The columns `mergedSegments(t)` gives: the physical names of a state table's. */
export function segmentColumns(t: CompiledBaseTable): SegmentColumns {
  return {
    keys: ["entity_id", "valid_from", "valid_to"],
    fields: t.fields.flatMap((f) => [
      column(f),
      ...(f.type === "zoned_datetime" ? [`"f_${f.id}__zone"`] : []),
    ]),
  };
}

/**
 * A SELECT of a state table's segments with the adjacent same-valued ones of an entity merged: the
 * columns of `segmentColumns(t)` (quoted, as the physical table has them), one row per merged
 * segment, its `valid_from` the first's and its `valid_to` the last's. `from` is the table as it
 * is written in SQL: the business table's name as `physical(t)` gives it unless the caller
 * qualifies it.
 */
export function mergedSegments(t: CompiledBaseTable, from: string = physical(t).business): string {
  if (t.time.type !== "state") throw new Error("only a state table has segments to merge");
  const { fields } = segmentColumns(t);
  const same =
    fields.length === 0
      ? "TRUE"
      : `NOT ((${fields.join(", ")}) IS DISTINCT FROM (${fields.map((c) => `lag(${c}) OVER w`).join(", ")}))`;
  const own = fields.length === 0 ? "" : `, ${fields.join(", ")}`;
  return [
    `SELECT "entity_id", "valid_from", "valid_to"${own}`,
    `FROM (SELECT "entity_id", "valid_from", "joined",`,
    `CASE WHEN bool_or("valid_to" IS NULL) OVER g THEN NULL ELSE max("valid_to") OVER g END AS "valid_to"${own}`,
    `FROM (SELECT "entity_id", "valid_from", "valid_to", "joined"${own},`,
    `sum(CASE WHEN "joined" THEN 0 ELSE 1 END) OVER (PARTITION BY "entity_id" ORDER BY "valid_from") AS "island"`,
    `FROM (SELECT "entity_id", "valid_from", "valid_to"${own},`,
    `coalesce("valid_from" = lag("valid_to") OVER w AND ${same}, FALSE) AS "joined"`,
    `FROM ${from} WINDOW w AS (PARTITION BY "entity_id" ORDER BY "valid_from")) AS "a") AS "b"`,
    `WINDOW g AS (PARTITION BY "entity_id", "island")) AS "c" WHERE NOT "joined"`,
  ].join(" ");
}
