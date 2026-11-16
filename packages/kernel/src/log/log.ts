// The log over the tenant store (02-architecture §4 `log`: event append and `seq` assignment,
// header encoding and chaining, content blocks with checksums, clearing blocks by position,
// `verify`). Every function takes the transaction `ops` opened; none opens its own.
//
// Appending does not apply anything: the events go to `apply` separately, in the same
// transaction (K3).

import type { Hash, Instant, JsonValue, Seq } from "@fluxvita/saveslot-contract-core";
import type { ReadTx, SqlValue, Tx } from "../store/ports.ts";
import {
  buildContinuation,
  buildOperation,
  type LogTail,
  type NewEvent,
  type NewOperation,
  type PreparedOperation,
} from "./build.ts";
import { decodeCanonical } from "./encode.ts";
import {
  LogVerifier,
  type LogVerifyResult,
  type StoredBlockRow,
  type StoredEventRow,
} from "./verify.ts";

// BIGINT columns may come back as bigint or string depending on the driver.
const n = (v: unknown): number => Number(v);
const nOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** The last event of the log, or undefined when the log is empty. */
export async function readTail(tx: ReadTx): Promise<LogTail | undefined> {
  const r = await tx.query<{ seq: unknown; header_hash: string; at: string }>(
    "SELECT seq, header_hash, at FROM events ORDER BY seq DESC LIMIT 1",
  );
  const row = r.rows[0];
  return row === undefined
    ? undefined
    : { seq: n(row.seq), hash: row.header_hash as Hash, at: row.at as Instant };
}

/**
 * Appends one operation: builds its events on the current tail (LogAppendError on a defect) and
 * inserts the events and their content blocks. Returns what was appended, for `apply`.
 */
export async function appendOperation(tx: Tx, input: NewOperation): Promise<PreparedOperation> {
  const prepared = buildOperation(await readTail(tx), input);
  await insertEvents(tx, prepared);
  return prepared;
}

/**
 * Appends more events to an operation this transaction appended, still the end of the log
 * (LogAppendError if another operation came after it): `appended` is what its last append or
 * continuation returned. Returns the new events only, for `apply`.
 */
export async function continueOperation(
  tx: Tx,
  appended: PreparedOperation,
  events: readonly NewEvent[],
): Promise<PreparedOperation> {
  const prepared = buildContinuation(await readTail(tx), appended, events);
  await insertEvents(tx, prepared);
  return prepared;
}

async function insertEvents(tx: Tx, prepared: PreparedOperation): Promise<void> {
  for (const e of prepared.events) {
    await tx.query(
      `INSERT INTO events (seq, header, header_hash, type, actor, at, op, slot,
         target_table, target_row, target_event)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        e.seq,
        e.header,
        e.hash,
        e.type,
        e.actor,
        e.at,
        e.op,
        e.slot,
        e.target.table,
        e.target.row,
        e.target.event,
      ] satisfies SqlValue[],
    );
    for (const b of e.blocks) {
      await tx.query("INSERT INTO content (seq, path, body, checksum) VALUES ($1, $2, $3, $4)", [
        e.seq,
        b.path,
        b.body,
        b.checksum,
      ]);
    }
  }
}

/** A content block as read back (09 §3.3): present, or removed by a tombstone. */
export type BlockState =
  | { readonly state: "present"; readonly value: JsonValue }
  | { readonly state: "removed"; readonly by: Seq };

export interface StoredEvent {
  readonly seq: Seq;
  /** The header's authoritative JCS text. */
  readonly text: string;
  readonly header: Readonly<Record<string, JsonValue>>;
  readonly blocks: ReadonlyMap<string, BlockState>;
}

/** Reads events with `from <= seq <= to`, with their blocks, in `seq` order. */
export async function readEvents(tx: ReadTx, from: Seq, to: Seq): Promise<StoredEvent[]> {
  const evs = await tx.query<{ seq: unknown; header: string }>(
    "SELECT seq, header FROM events WHERE seq BETWEEN $1 AND $2 ORDER BY seq",
    [from, to],
  );
  const blocks = await tx.query<{
    seq: unknown;
    path: string;
    body: string | null;
    removed_by: unknown;
  }>(
    'SELECT seq, path, body, removed_by FROM content WHERE seq BETWEEN $1 AND $2 ORDER BY seq, path COLLATE "C"',
    [from, to],
  );
  const bySeq = new Map<number, Map<string, BlockState>>();
  for (const b of blocks.rows) {
    const m = bySeq.get(n(b.seq)) ?? new Map<string, BlockState>();
    bySeq.set(n(b.seq), m);
    if (b.removed_by !== null) m.set(b.path, { state: "removed", by: n(b.removed_by) });
    else if (b.body !== null)
      m.set(b.path, { state: "present", value: JSON.parse(b.body) as JsonValue });
  }
  return evs.rows.map((e) => ({
    seq: n(e.seq),
    text: e.header,
    header: JSON.parse(e.header) as Record<string, JsonValue>,
    blocks: bySeq.get(n(e.seq)) ?? new Map(),
  }));
}

/**
 * Clears content blocks by position for a tombstone (09 §3.2): the content and checksum are
 * emptied and the tombstone's `seq` recorded. A block already removed keeps the tombstone that
 * removed it first. Returns how many blocks this call cleared.
 */
export async function clearBlocks(
  tx: Tx,
  tombstone: Seq,
  positions: readonly { readonly seq: Seq; readonly path: string }[],
): Promise<number> {
  let cleared = 0;
  for (const p of positions) {
    const r = await tx.query(
      `UPDATE content SET body = NULL, checksum = NULL, removed_by = $1
       WHERE seq = $2 AND path = $3 AND removed_by IS NULL`,
      [tombstone, p.seq, p.path],
    );
    cleared += r.affectedRows ?? 0;
  }
  return cleared;
}

/** `verify` over the whole log, read in batches. */
export async function verifyLog(tx: ReadTx, batch = 1000): Promise<LogVerifyResult> {
  const v = new LogVerifier();
  let after = 0;
  for (;;) {
    const r = await tx.query<Record<string, unknown>>(
      `SELECT e.seq, e.header, e.header_hash, e.type, e.actor, e.at, e.op, e.slot,
              e.target_table, e.target_row, e.target_event
       FROM events e WHERE e.seq > $1 ORDER BY e.seq LIMIT $2`,
      [after, batch],
    );
    const first = r.rows[0];
    const last = r.rows[r.rows.length - 1];
    // Paths of the batch's blocks, with the bodies of `target` and `positions` only.
    const blocks = new Map<
      number,
      { paths: string[]; target: string | null; positions: string | null }
    >();
    if (first !== undefined && last !== undefined) {
      const c = await tx.query<{ seq: unknown; path: string; body: string | null }>(
        `SELECT seq, path, CASE WHEN path IN ('target', 'positions') THEN body END AS body
         FROM content WHERE seq BETWEEN $1 AND $2`,
        [n(first["seq"]), n(last["seq"])],
      );
      for (const b of c.rows) {
        const seq = n(b.seq);
        const x = blocks.get(seq) ?? { paths: [], target: null, positions: null };
        x.paths.push(b.path);
        if (b.path === "target") x.target = b.body;
        if (b.path === "positions") x.positions = b.body;
        blocks.set(seq, x);
      }
    }
    for (const row of r.rows) {
      const seq = n(row["seq"]);
      const b = blocks.get(seq);
      const ev: StoredEventRow = {
        seq,
        header: row["header"] as string,
        header_hash: row["header_hash"] as string,
        type: row["type"] as string,
        actor: row["actor"] as string,
        at: row["at"] as string,
        op: n(row["op"]),
        slot: (row["slot"] as string | null) ?? null,
        target_table: (row["target_table"] as string | null) ?? null,
        target_row: (row["target_row"] as string | null) ?? null,
        target_event: nOrNull(row["target_event"]),
        target_body: b?.target ?? null,
        paths: b?.paths ?? [],
        positions_body: b?.positions ?? null,
      };
      v.addEvent(ev);
      after = ev.seq;
    }
    if (r.rows.length < batch) break;
  }
  let cursor: { seq: number; path: string } = { seq: 0, path: "" };
  for (;;) {
    const r = await tx.query<{
      seq: unknown;
      path: string;
      body: string | null;
      checksum: string | null;
      removed_by: unknown;
    }>(
      `SELECT seq, path, body, checksum, removed_by FROM content
       WHERE (seq, path) > ($1, $2) ORDER BY seq, path LIMIT $3`,
      [cursor.seq, cursor.path, batch],
    );
    for (const row of r.rows) {
      const b: StoredBlockRow = {
        seq: n(row.seq),
        path: row.path,
        body: row.body,
        checksum: row.checksum,
        removed_by: nOrNull(row.removed_by),
      };
      v.addBlock(b);
      cursor = { seq: b.seq, path: b.path };
    }
    if (r.rows.length < batch) break;
  }
  return v.result();
}

/** Parses a stored header text, or undefined when it is not canonical JCS. */
export function parseHeader(text: string): Readonly<Record<string, JsonValue>> | undefined {
  const v = decodeCanonical(text);
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, JsonValue>)
    : undefined;
}
