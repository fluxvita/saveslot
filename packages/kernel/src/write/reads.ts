// What the write pipeline reads from the state, in the caller's transaction: the slots and their
// compiled definitions, a row's or entity's events (to rebuild what `judge` needs), the open
// pending items on it, the `ver` / `sv` taken from the caller's own earlier writes, and the request
// key index.

import type {
  CompiledSchema,
  ItemId,
  JsonValue,
  OpNumber,
  Seq,
  SlotId,
} from "@fluxvita/saveslot-contract-core";
import type { ReadTx } from "../store/ports.ts";
import type { StoredEvent } from "./record.ts";

export interface SlotRow {
  readonly slot: SlotId;
  readonly name: string;
  readonly timezone: string;
  readonly sv: number;
  readonly policyVersion: number;
  readonly compiled: CompiledSchema;
}

/** The slots with a current definition. */
export async function readSlots(tx: ReadTx): Promise<SlotRow[]> {
  const r = await tx.query<{
    id: string;
    name: string;
    timezone: string;
    current_sv: unknown;
    policy_version: unknown;
    body: string | null;
  }>(
    `SELECT s.id, s.name, s.timezone, s.current_sv, s.policy_version, c.body
     FROM slots s JOIN schema_versions v ON v.slot_id = s.id AND v.state = 'current'
     JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
     ORDER BY s.id`,
  );
  return r.rows
    .filter((x) => x.body !== null)
    .map((x) => ({
      slot: x.id as SlotId,
      name: x.name,
      timezone: x.timezone,
      sv: Number(x.current_sv),
      policyVersion: Number(x.policy_version ?? 1),
      compiled: JSON.parse(x.body as string) as CompiledSchema,
    }));
}

async function eventsAt(
  tx: ReadTx,
  where: string,
  args: readonly unknown[],
): Promise<StoredEvent[]> {
  const heads = await tx.query<{ seq: unknown; type: string; op: unknown }>(
    `SELECT seq, type, op FROM events WHERE ${where} ORDER BY seq`,
    args as never,
  );
  if (heads.rows.length === 0) return [];
  const seqs = heads.rows.map((h) => Number(h.seq));
  const blocks = await tx.query<{ seq: unknown; path: string; body: string | null }>(
    "SELECT seq, path, body FROM content WHERE seq = ANY($1) AND body IS NOT NULL",
    [seqs] as never,
  );
  const by = new Map<number, Record<string, unknown>>();
  for (const b of blocks.rows) {
    const s = Number(b.seq);
    const m = by.get(s) ?? Object.create(null);
    m[b.path] = JSON.parse(b.body as string) as JsonValue;
    by.set(s, m);
  }
  return heads.rows.map((h) => ({
    header: {
      type: h.type,
      seq: Number(h.seq) as Seq,
      op: Number(h.op) as OpNumber,
    },
    blocks: by.get(Number(h.seq)) ?? {},
  }));
}

/**
 * The events `decodeRecords` reads for a row or entity: its `write.base` and pending item events,
 * the head events of those operations, and the `item.resolved` events on its items (a decision
 * that writes nothing has no event on the row).
 */
export async function rowEvents(tx: ReadTx, table: string, row: string): Promise<StoredEvent[]> {
  const own = await eventsAt(
    tx,
    "target_table = $1 AND target_row = $2 AND type IN ('write.base', 'item.created')",
    [table, row],
  );
  const items = [
    ...new Set(
      own
        .filter((e) => e.header.type === "item.created")
        .map((e) => (e.blocks["target"] as { item: ItemId }).item),
    ),
  ];
  // Joins and resolutions of the row's items: their target names the item, not the row.
  // TODO(index): a lookup of an item's events without reading their targets.
  const onItems =
    items.length === 0
      ? []
      : await eventsAt(
          tx,
          `type IN ('item.merged', 'item.resolved') AND seq IN (SELECT c.seq FROM content c
             WHERE c.path = 'target' AND c.body IS NOT NULL AND (c.body::jsonb ->> 'item') = ANY($1))`,
          [items],
        );
  const ops = [
    ...new Set(
      [...own, ...onItems].filter((e) => e.header.type !== "item.resolved").map((e) => e.header.op),
    ),
  ];
  const heads = ops.length === 0 ? [] : await eventsAt(tx, "seq = ANY($1)", [ops]);
  const all = new Map<number, StoredEvent>();
  for (const e of [...own, ...onItems, ...heads]) all.set(e.header.seq, e);
  return [...all.values()].sort((a, b) => a.header.seq - b.header.seq);
}

/** The table a row or entity was created in, if it was (`row_origins`). */
export async function rowTable(tx: ReadTx, row: string): Promise<string | undefined> {
  const r = await tx.query<{ table_id: string }>(
    "SELECT table_id FROM row_origins WHERE row_id = $1",
    [row],
  );
  return r.rows[0]?.table_id;
}

/** The task a head event recorded (`task`), as SQL on head event `e`: NULL when it has none. */
const taskOf = `(SELECT t.body::jsonb #>> '{}' FROM content t WHERE t.seq = e.seq AND t.path = 'task' AND t.body IS NOT NULL)`;

/**
 * The operations of `actor` under the same task as the call (04-contract «兜底»: a call with a
 * task counts only what it wrote under that task; a call without one only what it wrote without).
 */
const byCaller = (actorArg: string, taskArg: string) =>
  `e.actor = ${actorArg} AND ${taskOf} IS NOT DISTINCT FROM ${taskArg}::text`;

/** What a fallback found: the operation it takes from, or why there is none. */
export type Fallback<T> =
  | { readonly found: T; readonly op: OpNumber }
  | { readonly reason: "no_read" }
  | { readonly reason: "task_mismatch"; readonly readTask: string | null };

/**
 * `ver` taken from the caller's own write receipts (04-write-and-read «版本标记应带回»): the latest
 * operation of this connection, under the call's task, that changed the row's version table. Without
 * one, `task_mismatch` when it wrote the row under another task (or without one), `no_read`
 * otherwise; reads would be the other source, not kept in this version.
 */
export async function verFromWrite(
  tx: ReadTx,
  verTable: string,
  row: string,
  actor: string,
  task: string | null,
): Promise<Fallback<OpNumber>> {
  const r = await tx.query<{ v: unknown; read_task: string | null; same: boolean }>(
    `SELECT v.rec_from AS v, ${taskOf} AS read_task, (${byCaller("$2", "$3")}) AS same
     FROM "${verTable}" v JOIN events e ON e.seq = v.rec_from
     WHERE v.row_id = $1 AND v.intent <> 'schema_switch' AND e.actor = $2
     ORDER BY (${byCaller("$2", "$3")}) DESC, v.rec_from DESC LIMIT 1`,
    [row, actor, task],
  );
  const x = r.rows[0];
  if (x === undefined) return { reason: "no_read" };
  if (!x.same) return { reason: "task_mismatch", readTask: x.read_task };
  return { found: Number(x.v) as OpNumber, op: Number(x.v) as OpNumber };
}

/** `sv` taken from the caller's own latest write on the slot, as for `ver`. */
export async function svFromWrite(
  tx: ReadTx,
  slot: string,
  actor: string,
  task: string | null,
): Promise<Fallback<number>> {
  const r = await tx.query<{
    seq: unknown;
    body: string | null;
    read_task: string | null;
    same: boolean;
  }>(
    `SELECT e.seq, c.body, ${taskOf} AS read_task, (${byCaller("$2", "$3")}) AS same
     FROM events e JOIN content c ON c.seq = e.seq AND c.path = 'request'
     WHERE e.type = 'write.head' AND e.slot = $1 AND e.actor = $2
     ORDER BY (${byCaller("$2", "$3")}) DESC, e.seq DESC LIMIT 1`,
    [slot, actor, task],
  );
  const x = r.rows[0];
  if (x === undefined || x.body === null) return { reason: "no_read" };
  if (!x.same) return { reason: "task_mismatch", readTask: x.read_task };
  return { found: (JSON.parse(x.body) as { sv: number }).sv, op: Number(x.seq) as OpNumber };
}

/** The operations of the row's versions (01-objects «版本标记»: not `schema_switch`). */
export async function rowVersions(tx: ReadTx, verTable: string, row: string): Promise<Set<number>> {
  const r = await tx.query<{ v: unknown }>(
    `SELECT DISTINCT rec_from AS v FROM "${verTable}" WHERE row_id = $1 AND intent <> 'schema_switch'`,
    [row],
  );
  return new Set(r.rows.map((x) => Number(x.v)));
}

/** The current restore count (01-objects «版本标记»): 0 until a backup is restored. */
export async function restoreCount(tx: ReadTx): Promise<number> {
  const r = await tx.query<{ header: string }>(
    "SELECT header FROM events WHERE type = 'tenant.restored' ORDER BY seq DESC LIMIT 1",
  );
  const h = r.rows[0]?.header;
  return h === undefined ? 0 : ((JSON.parse(h) as { restore_count?: number }).restore_count ?? 0);
}

/** A request key recorded at or after `since`. */
export async function requestKeyHit(
  tx: ReadTx,
  key: string,
  since: string,
): Promise<{ op: OpNumber; fingerprint: string | null } | undefined> {
  const r = await tx.query<{ op: unknown; fingerprint: string | null }>(
    "SELECT op, fingerprint FROM request_keys WHERE key = $1 AND at >= $2",
    [key, since],
  );
  const x = r.rows[0];
  return x === undefined ? undefined : { op: Number(x.op) as OpNumber, fingerprint: x.fingerprint };
}

/** The open items of a row or entity (`pending_items`), by ID. */
export async function openItems(tx: ReadTx, table: string, row: string): Promise<Set<string>> {
  const r = await tx.query<{ id: string }>(
    "SELECT id FROM pending_items WHERE target_table = $1 AND target_row = $2 AND state = 'open'",
    [table, row],
  );
  return new Set(r.rows.map((x) => x.id));
}
