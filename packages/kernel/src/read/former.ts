// The versions whose names still resolve (03-data-model/07-schema-evolution.md «旧名字还认多久»):
// besides the current version, the last 10 retired ones, by count, not by version number (numbers
// may skip, 04-contract §2). One reading for the restricted SQL's old names and the aliases of a
// draft.

import type { CompiledSchema } from "@fluxvita/saveslot-contract-core";
import type { ReadTx } from "../store/ports.ts";

/** How many retired versions' names still resolve. */
export const FORMER_VERSIONS = 10;

/** Each slot's last retired versions' definitions, the latest first. */
export async function formerVersions(
  tx: ReadTx,
  slots: readonly string[],
): Promise<Map<string, CompiledSchema[]>> {
  const out = new Map<string, CompiledSchema[]>();
  if (slots.length === 0) return out;
  // Retired in switch order: a slot's versions are switched to one at a time, in number order.
  const r = await tx.query<{ slot_id: string; body: string | null }>(
    `SELECT v.slot_id, c.body FROM schema_versions v
     JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
     WHERE v.slot_id = ANY($1) AND v.state = 'retired'
     ORDER BY v.slot_id, v.sv DESC`,
    [slots] as never,
  );
  for (const x of r.rows) {
    if (x.body === null) continue;
    const list = out.get(x.slot_id) ?? [];
    if (list.length < FORMER_VERSIONS) list.push(JSON.parse(x.body) as CompiledSchema);
    out.set(x.slot_id, list);
  }
  return out;
}
