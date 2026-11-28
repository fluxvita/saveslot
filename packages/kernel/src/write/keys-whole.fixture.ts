// The key lookups as they were before a request read a table's keys once (./keys.ts): each one
// reads the creating events of the whole table, and `existingKeys` aggregates the version table.
// Kept as the reference the cached lookups are compared with (store-pglite write-entity-key.test.ts).

import type { CompiledBaseTable, EntityId } from "@fluxvita/saveslot-contract-core";
import type { ReadTx } from "../store/ports.ts";
import { type EntityKeyText, type KeyValues, keyText, keyToken, tableKeys } from "./keys.ts";

export async function entitiesByKeyWhole(
  tx: ReadTx,
  t: CompiledBaseTable,
  key: KeyValues,
): Promise<EntityId[]> {
  const token = keyToken(t, key);
  return [...(await tableKeys(tx, t))].filter(([, k]) => keyToken(t, k) === token).map(([e]) => e);
}

export async function keyOfWhole(
  tx: ReadTx,
  t: CompiledBaseTable,
  entity: EntityId,
): Promise<KeyValues | undefined> {
  return (await tableKeys(tx, t)).get(entity);
}

export async function existingKeysWhole(
  tx: ReadTx,
  t: CompiledBaseTable,
  limit: number,
): Promise<EntityKeyText[]> {
  const keys = await tableKeys(tx, t);
  if (keys.size === 0) return [];
  const latest = await tx.query<{ row_id: string; at: unknown }>(
    `SELECT row_id, max(rec_from) AS at FROM "${t.physical.table}__ver" GROUP BY row_id`,
  );
  const at = new Map(latest.rows.map((x) => [x.row_id, Number(x.at)]));
  return [...keys]
    .sort(([a], [b]) => (at.get(b) ?? 0) - (at.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, limit)
    .map(([, k]) => keyText(t, k));
}
