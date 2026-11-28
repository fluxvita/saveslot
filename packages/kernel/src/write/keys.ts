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
  type TableId,
} from "@fluxvita/saveslot-contract-core";
import type { NormalizedField } from "../request/index.ts";
import { foldKey, type Match, matchKey } from "../request/keymatch/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { READABLE_CONTENT } from "../store/readable-content.ts";
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
     JOIN ${READABLE_CONTENT} c ON c.seq = o.origin_seq AND c.body IS NOT NULL AND c.path LIKE 'fields/%'
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

/**
 * Entities compared for `similar_keys`, the most recently written first (10 «比较范围», initial
 * value).
 */
export const SIMILAR_SCOPE = 5000;
/** `similar_keys` given at most. */
export const SIMILAR_MAX = 5;

/** A key written alike (04-contract-types `OpResult.similar_keys`). */
export interface SimilarKey {
  readonly key: EntityKeyText;
  readonly match: Match;
  readonly revoked?: true;
}

/** What `similarKeys` reads of a table once a request (`createSimilarCache`). */
interface TableSnapshot {
  /** The stored entities with their keys, the most recently written first, then by entity ID. */
  readonly byRecency: readonly {
    readonly entity: EntityId;
    readonly key: KeyValues;
    readonly at: number;
  }[];
  /** The stored entities' keys, by entity. */
  readonly keyOf: ReadonlyMap<EntityId, KeyValues>;
  /** The stored entities with a value over some stretch (a row in the business table). */
  readonly valued: ReadonlySet<string>;
}

/**
 * What `similarKeys` reads once a request and keeps: each table's stored keys, their latest write
 * and whether they have a value (the store does not change while a request is judged: its own
 * writes come in as `here`), and each text folded (`foldKey`).
 */
export interface SimilarCache {
  readonly tables: Map<TableId, TableSnapshot>;
  readonly folded: Map<string, readonly number[]>;
}

export const createSimilarCache = (): SimilarCache => ({ tables: new Map(), folded: new Map() });

async function snapshotOf(
  tx: ReadTx,
  t: CompiledBaseTable,
  cache: SimilarCache,
): Promise<TableSnapshot> {
  const had = cache.tables.get(t.id);
  if (had !== undefined) return had;
  const name = t.physical.table;
  if (!/^t[1-9][0-9]{0,8}$/.test(t.id) || !new RegExp(`^t_${t.id}_v[1-9][0-9]{0,8}$`).test(name)) {
    throw new Error(`not a physical table name: ${JSON.stringify(name)}`);
  }
  const stored = await tableKeys(tx, t);
  const latest = await tx.query<{ row_id: string; at: unknown }>(
    `SELECT row_id, max(rec_from) AS at FROM "${name}__ver" GROUP BY row_id`,
  );
  const at = new Map(latest.rows.map((x) => [x.row_id, Number(x.at)]));
  const valued = new Set(
    (await tx.query<{ id: string }>(`SELECT DISTINCT entity_id AS id FROM "${name}"`)).rows.map(
      (x) => x.id,
    ),
  );
  const byRecency = [...stored]
    .map(([entity, key]) => ({ entity, key, at: at.get(entity) ?? 0 }))
    .sort((a, b) => b.at - a.at || (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0));
  const snap = { byRecency, keyOf: stored, valued };
  cache.tables.set(t.id, snap);
  return snap;
}

function foldedOf(s: string, cache: SimilarCache): readonly number[] {
  let f = cache.folded.get(s);
  if (f === undefined) {
    f = foldKey(s);
    cache.folded.set(s, f);
  }
  return f;
}

/**
 * The table's keys written like `key` (10-types-and-units «相近的键», `keymatch@1`): of its entities,
 * the most recently written `SIMILAR_SCOPE`, revoked ones included and marked; at most
 * `SIMILAR_MAX`, by level, distance, latest write, entity ID. None for a key without a `text` field.
 *
 * As at the write (04-contract-types: worked out from the state at that moment): `here` are the
 * entities this request's earlier ops gave a new version, the latest first; they are the most
 * recent of all.
 * `revoked` is the entity having a value at no point at that moment (a revoke of the whole, or
 * revokes over every stretch it had a value), the same as a stored entity with no row in the
 * business table; the caller reads it off the entity's state in the request. `key`: one this
 * request created, not stored yet.
 */
export async function similarKeys(
  tx: ReadTx,
  t: CompiledBaseTable,
  key: KeyValues,
  here: readonly {
    readonly entity: EntityId;
    readonly key?: KeyValues;
    readonly revoked: boolean;
  }[],
  cache: SimilarCache,
): Promise<SimilarKey[]> {
  const fields = keyFields(t);
  if (!fields.some((f) => f.type === "text")) return [];
  const snap = await snapshotOf(tx, t, cache);
  const mine = new Set(here.map((x) => x.entity as string));
  const all: { entity: EntityId; key: KeyValues; at: number; revoked: boolean }[] = [];
  here.forEach((x, i) => {
    const k = x.key ?? snap.keyOf.get(x.entity);
    if (k !== undefined)
      all.push({ entity: x.entity, key: k, at: Number.MAX_SAFE_INTEGER - i, revoked: x.revoked });
  });
  for (const x of snap.byRecency) {
    if (all.length >= SIMILAR_SCOPE) break;
    if (mine.has(x.entity)) continue;
    all.push({ ...x, revoked: !snap.valued.has(x.entity) });
  }
  all.splice(SIMILAR_SCOPE);
  const LEVEL: Record<Match, number> = { fold: 0, affix: 1, edit: 2 };
  const found = all.flatMap((x) => {
    const m = matchKey(
      fields.map((f) => {
        const a = key[f.id] ?? null;
        const b = x.key[f.id] ?? null;
        return f.type === "text" && typeof a === "string" && typeof b === "string"
          ? { text: true as const, a, b, folded: { a: foldedOf(a, cache), b: foldedOf(b, cache) } }
          : {
              text: false as const,
              equal: canonicalize(a as JcsValue) === canonicalize(b as JcsValue),
            };
      }),
    );
    return m === undefined ? [] : [{ ...x, ...m }];
  });
  return found
    .sort(
      (a, b) =>
        LEVEL[a.match] - LEVEL[b.match] ||
        a.distance - b.distance ||
        b.at - a.at ||
        (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0),
    )
    .slice(0, SIMILAR_MAX)
    .map((x) => ({
      key: keyText(t, x.key),
      match: x.match,
      ...(x.revoked ? { revoked: true as const } : {}),
    }));
}
