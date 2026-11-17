// Entities of a state table by their natural key (03-data-model/05-time «按 entity_key 写入»;
// 04-contract §5.1). An entity's key is what the `write.base` that created it gave its key fields:
// every entity of a table with `entity_key` is created by key (an insert is refused there), key
// fields cannot change, and `row_origins` names the creating event. Values are read from its content
// blocks, as apply reads values. This is the one source of keys: the version table is not one (an
// entity created and revoked by one request lays no key cell, the cells being those of the
// operation's end).
//
// Keys compare by their values' tokens: the values are normalized (10 «同值判据»), so equal tokens
// are the same value (decimals rounded to the field's scale, quantities in the field's unit, text in
// NFC, a zoned date-time as its instant and zone).
//
// Each lookup reads the creating events of the whole table: fine at this phase's sizes; an index
// table of keys is left until there are numbers for large tables (or the deletion phase needs one).

import {
  type CompiledBaseField,
  type CompiledBaseTable,
  canonicalize,
  type EntityId,
  type FieldId,
  type FieldValue,
  type JcsValue,
} from "@fluxvita/saveslot-contract-core";
import type { NormalizedField } from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { zonedText } from "../time/index.ts";

export type EntityKey = Readonly<Record<FieldId, NormalizedField>>;
export type KeyValues = Readonly<Record<FieldId, FieldValue>>;

/** A key as shown to the caller (04-contract-types `EntityKeyText`): one field's text, or by name. */
export type EntityKeyText = string | Readonly<Record<string, string>>;

/** The table's key fields, in the order `entity_key` lists them. */
export function keyFields(t: CompiledBaseTable): CompiledBaseField[] {
  const ids = ("entity_key" in t ? t.entity_key : undefined) ?? [];
  return ids.map((id) => t.fields.find((f) => f.id === id) as CompiledBaseField);
}

/** A key as a token comparable for equality. */
export function keyToken(t: CompiledBaseTable, key: KeyValues): string {
  return canonicalize(keyFields(t).map((f) => (key[f.id] ?? null) as JcsValue));
}

/** The key of each entity of the table, from the event that created it. */
export async function tableKeys(
  tx: ReadTx,
  t: CompiledBaseTable,
): Promise<Map<EntityId, KeyValues>> {
  const ids = new Set<string>(keyFields(t).map((f) => f.id));
  const r = await tx.query<{ row_id: string; path: string; body: string }>(
    `SELECT o.row_id, c.path, c.body FROM row_origins o
     JOIN content c ON c.seq = o.origin_seq AND c.body IS NOT NULL AND c.path LIKE 'fields/%'
     WHERE o.table_id = $1 ORDER BY o.row_id, c.path`,
    [t.id],
  );
  const out = new Map<EntityId, Record<FieldId, FieldValue>>();
  for (const x of r.rows) {
    const [, f] = x.path.split("/");
    if (f === undefined || !ids.has(f)) continue;
    const key = out.get(x.row_id as EntityId) ?? {};
    // A key field has one value over the entity's time: the first item gives it.
    if (!Object.hasOwn(key, f)) {
      const block = JSON.parse(x.body) as { value?: FieldValue };
      key[f as FieldId] = block.value ?? null;
    }
    out.set(x.row_id as EntityId, key);
  }
  return out;
}

/** The entities holding this key: one at most, unless the store breaks the key's uniqueness. */
export async function entitiesByKey(
  tx: ReadTx,
  t: CompiledBaseTable,
  key: KeyValues,
): Promise<EntityId[]> {
  const token = keyToken(t, key);
  return [...(await tableKeys(tx, t))].filter(([, k]) => keyToken(t, k) === token).map(([e]) => e);
}

/** An entity's key, from the event that created it. */
export async function keyOf(
  tx: ReadTx,
  t: CompiledBaseTable,
  entity: EntityId,
): Promise<KeyValues | undefined> {
  return (await tableKeys(tx, t)).get(entity);
}

/** A key value as text a caller can write back. */
function valueText(v: FieldValue): string {
  if (v === null) return "";
  if (typeof v === "boolean") return String(v);
  // As every value goes out (../time `zonedText`): written back, it names the same instant.
  if (typeof v === "object" && "instant" in v) return zonedText(v.instant, v.zone);
  if (typeof v === "object" && "unit" in v) return `${v.value} ${v.unit}`;
  return String(v);
}

/** A key as shown to the caller: one field's text, or each field's by name. */
export function keyText(t: CompiledBaseTable, key: KeyValues): EntityKeyText {
  const fields = keyFields(t);
  const [one] = fields;
  if (fields.length === 1 && one !== undefined) return valueText(key[one.id] ?? null);
  return Object.fromEntries(fields.map((f) => [f.name, valueText(key[f.id] ?? null)]));
}

/**
 * The table's entity keys, at most `limit`, the latest written first (by the latest operation that
 * gave the entity a cell), then by entity ID; entities revoked as a whole included (05-time: the
 * entity and its key stay).
 */
export async function existingKeys(
  tx: ReadTx,
  t: CompiledBaseTable,
  limit: number,
): Promise<EntityKeyText[]> {
  const keys = await tableKeys(tx, t);
  if (keys.size === 0) return [];
  const name = t.physical.table;
  if (!/^t[1-9][0-9]{0,8}$/.test(t.id) || !new RegExp(`^t_${t.id}_v[1-9][0-9]{0,8}$`).test(name)) {
    throw new Error(`not a physical table name: ${JSON.stringify(name)}`);
  }
  const latest = await tx.query<{ row_id: string; at: unknown }>(
    `SELECT row_id, max(rec_from) AS at FROM "${name}__ver" GROUP BY row_id`,
  );
  const at = new Map(latest.rows.map((x) => [x.row_id, Number(x.at)]));
  return [...keys]
    .sort(([a], [b]) => (at.get(b) ?? 0) - (at.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, limit)
    .map(([, k]) => keyText(t, k));
}
