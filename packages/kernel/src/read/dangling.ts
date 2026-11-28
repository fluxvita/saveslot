// Ref values pointing at a row or entity revoked since (04-contract §7 `dangling_ref`;
// 03-data-model/04-write-and-read «引用字段 · 目标被撤销»: "the referencing row is not touched and
// keeps the original ID", and when read it carries a mark).
//
// Of the rows a read gives, the targets their ref fields name that are revoked as the read sees
// them: now, or as of a record time (`asOf`). An event or timeless row revoked; a state entity with
// a value over no stretch of business time (a revoke of the whole entity). A revoke undone is
// not revoked, so the mark goes with it. A target deleted (`deleted`) comes with deletion.

import type { CompiledBaseTable, CompiledTable, TableId } from "@fluxvita/saveslot-contract-core";
import { physical } from "../store/layout.ts";
import type { ReadTx } from "../store/ports.ts";

/** The targets revoked, of the values `rows` give their ref fields. */
export async function revokedTargets(
  tx: ReadTx,
  table: CompiledBaseTable,
  tables: readonly CompiledTable[],
  rows: readonly { readonly values: Readonly<Record<string, unknown>> }[],
  asOf?: number,
): Promise<Set<string>> {
  // The IDs named, by the table each field names.
  const named = new Map<TableId, Set<string>>();
  for (const f of table.fields) {
    if (f.type !== "ref") continue;
    const to = (f as { ref: { table: TableId } }).ref.table;
    for (const r of rows) {
      const v = r.values[f.id];
      if (typeof v !== "string") continue;
      const set = named.get(to) ?? new Set<string>();
      set.add(v);
      named.set(to, set);
    }
  }
  const out = new Set<string>();
  for (const [id, set] of named) {
    const t = tables.find((x) => x.id === id);
    if (t?.kind !== "base") continue;
    const target = t as CompiledBaseTable;
    const ids = [...set];
    const { business, versions } = physical(target);
    if (target.time.type !== "state") {
      const r =
        asOf === undefined
          ? await tx.query<{ id: string }>(
              `SELECT row_id AS id FROM ${business} WHERE row_id = ANY($1) AND revoked`,
              [ids] as never,
            )
          : await tx.query<{ id: string }>(
              `SELECT DISTINCT row_id AS id FROM ${versions}
               WHERE row_id = ANY($1) AND field_id = 'existence' AND revoked
                 AND rec_from <= $2 AND (rec_to IS NULL OR rec_to > $2)`,
              [ids, asOf] as never,
            );
      for (const x of r.rows) out.add(x.id);
      continue;
    }
    // A state entity: revoked when no stretch has a value. The ones with some.
    const r =
      asOf === undefined
        ? await tx.query<{ id: string }>(
            `SELECT DISTINCT entity_id AS id FROM ${business} WHERE entity_id = ANY($1)`,
            [ids] as never,
          )
        : await tx.query<{ id: string }>(
            `SELECT DISTINCT row_id AS id FROM ${versions}
             WHERE row_id = ANY($1) AND rec_from <= $2 AND (rec_to IS NULL OR rec_to > $2)
               AND NOT coalesce(revoked, false) AND NOT coalesce(no_value, false)`,
            [ids, asOf] as never,
          );
    const valued = new Set(r.rows.map((x) => x.id));
    // Only those the table has had: an entity of it at all (any cell), now without a value.
    const known = await tx.query<{ id: string }>(
      `SELECT DISTINCT row_id AS id FROM ${versions} WHERE row_id = ANY($1)${
        asOf === undefined ? "" : " AND rec_from <= $2"
      }`,
      (asOf === undefined ? [ids] : [ids, asOf]) as never,
    );
    for (const x of known.rows) if (!valued.has(x.id)) out.add(x.id);
  }
  return out;
}

/** The `dangling_ref` marks of a row's values (by field ID), every ref field read. */
export function danglingOf(
  table: CompiledBaseTable,
  values: Readonly<Record<string, unknown>>,
  gone: ReadonlySet<string>,
): { field: string; state: "revoked" }[] {
  return table.fields.flatMap((f) => {
    const v = values[f.id];
    return f.type === "ref" && typeof v === "string" && gone.has(v)
      ? [{ field: f.name, state: "revoked" as const }]
      : [];
  });
}
