// Read records (docs/zh-CN/spec/03-data-model/02-integrity-and-records.md «读取记录：read_log»;
// 02-architecture.md §4 `audit`, §7 «read_log 的持久性», §8 `read_log`, `read_log_rows`, `last_read`).
//
// Reads are recorded in a buffer in the process that holds the tenant's storage, one buffer per open
// store, and written to storage in a write transaction: at the start of any write transaction, at
// each flush interval, and before the storage is closed. The caller (`ops`) opens the transaction;
// this module only writes what it is given.
//
// A read records versions, never values: what it read (slot and `sv`, table, rows or entities with
// the version read, or a table-level record), the structural fingerprint of its query, its business
// time condition, and the log position when read. It also says what it counts as having read for
// the fallback of `ver`, `sv` and item versions (04-contract §2): `last_read` keeps the latest of
// each per actor, task and target, the buffer's not yet written ones first.

import type {
  Instant,
  JsonValue,
  OpNumber,
  PrincipalId,
  Seq,
  SlotId,
  SourceId,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { canonicalize } from "@fluxvita/saveslot-contract-core";
import type { ReadTx, Tx } from "../store/ports.ts";

/** A read's ID (01-objects «标识的写法»): `rd_` and 16 Crockford Base32 characters. */
export type ReadId = `rd_${string}`;
export const READ_ID = /^rd_[0-9A-HJKMNP-TV-Z]{16}$/;

export const READ_OPERATIONS = [
  "query",
  "sql",
  "history",
  "sources",
  "catalog",
  "pending",
  "deletion_preview",
] as const;
export type ReadOperation = (typeof READ_OPERATIONS)[number];

/** A version read: (operation number, restore count). */
export interface ReadVersion {
  readonly op: OpNumber;
  readonly restoreCount: number;
}

/** A row, entity or derived partition read, with the version read (none for a computed one). */
export interface ReadRow {
  readonly table: TableId;
  readonly target: string;
  readonly ver?: ReadVersion;
}

/** What a read counts as having read, for the fallback (04-contract §2 «什么算读到»). */
export interface LastReadEntry {
  readonly kind: "ver" | "sv" | "item";
  /** Row or entity ID (`ver`), slot ID (`sv`), pending item ID (`item`). */
  readonly target: string;
  /** The operation number; for `sv` the schema version. */
  readonly op: number;
  /** The restore count; 0 for `sv`. */
  readonly restoreCount: number;
}

export interface ReadEntry {
  readonly read: ReadId;
  readonly actor: PrincipalId;
  readonly task: string | null;
  /** The entry's "now". */
  readonly at: Instant;
  /** The latest operation number when read. */
  readonly pos: Seq;
  readonly operation: ReadOperation;
  /** The self-check when a connection is issued (04-contract-types §8.3). */
  readonly selfcheck?: true;
  readonly slot?: SlotId;
  readonly sv?: number;
  readonly table?: TableId;
  /** Structural fingerprint: no caller values (04-write-and-read «读取记录里记什么形状»). */
  readonly shape?: string;
  /** The business time condition: the only caller-given value kept. */
  readonly valid?: JsonValue;
  /** A source read in full. */
  readonly source?: SourceId;
  /** Rows read with their versions: one per entity on state tables. */
  readonly rows: readonly ReadRow[];
  /** Tables recorded at table level (read beyond the threshold): no rows. */
  readonly coarse: readonly TableId[];
  readonly lastRead: readonly LastReadEntry[];
}

export interface LastRead {
  readonly op: number;
  readonly restoreCount: number;
  readonly read: ReadId;
}

export interface LastReadQuery {
  readonly actor: PrincipalId;
  /** Only reads under the same task count; `null` only reads without a task (04-contract §2). */
  readonly task: string | null;
  readonly kind: LastReadEntry["kind"];
  readonly target: string;
}

/** Reads recorded and not yet written, in the order recorded. */
export class ReadBuffer {
  #entries: ReadEntry[] = [];

  record(entry: ReadEntry): void {
    this.#entries.push(entry);
  }

  get size(): number {
    return this.#entries.length;
  }

  /** Takes every buffered read out of the buffer, to be written. */
  take(): ReadEntry[] {
    const out = this.#entries;
    this.#entries = [];
    return out;
  }

  /** Puts back reads whose writing failed, before those recorded since. */
  restore(taken: readonly ReadEntry[]): void {
    this.#entries = [...taken, ...this.#entries];
  }

  /** The latest buffered read of the target, if any. */
  lastRead(q: LastReadQuery): LastRead | undefined {
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const e = this.#entries[i] as ReadEntry;
      if (e.actor !== q.actor || e.task !== q.task) continue;
      for (let j = e.lastRead.length - 1; j >= 0; j--) {
        const x = e.lastRead[j] as LastReadEntry;
        if (x.kind === q.kind && x.target === q.target)
          return { op: x.op, restoreCount: x.restoreCount, read: e.read };
      }
    }
    return undefined;
  }

  /** A buffered read by its ID. */
  find(read: ReadId): ReadEntry | undefined {
    return this.#entries.find((e) => e.read === read);
  }
}

const buffers = new WeakMap<object, ReadBuffer>();

/** The read buffer of an open store (one per store object, for as long as it lives). */
export function readBufferOf(store: object): ReadBuffer {
  let b = buffers.get(store);
  if (b === undefined) {
    b = new ReadBuffer();
    buffers.set(store, b);
  }
  return b;
}

/** Rows per INSERT statement: 6 parameters each, well below PostgreSQL's 65,535. */
const ROWS_PER_INSERT = 1000;

/** Writes reads into `read_log`, `read_log_rows` and `last_read`, in the order given. */
export async function writeReads(tx: Tx, entries: readonly ReadEntry[]): Promise<void> {
  for (const e of entries) {
    await tx.query(
      `INSERT INTO read_log (read_id, actor, task, at, pos, operation, selfcheck, slot_id, sv,
         table_id, shape, valid, source_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        e.read,
        e.actor,
        e.task,
        e.at,
        e.pos,
        e.operation,
        e.selfcheck === true,
        e.slot ?? null,
        e.sv ?? null,
        e.table ?? null,
        e.shape ?? null,
        e.valid === undefined ? null : canonicalize(e.valid),
        e.source ?? null,
      ],
    );
    const rows: [TableId, string | null, ReadVersion | undefined][] = [
      ...e.rows.map((r): [TableId, string | null, ReadVersion | undefined] => [
        r.table,
        r.target,
        r.ver,
      ]),
      ...e.coarse.map((t): [TableId, string | null, ReadVersion | undefined] => [
        t,
        null,
        undefined,
      ]),
    ];
    for (let from = 0; from < rows.length; from += ROWS_PER_INSERT) {
      const chunk = rows.slice(from, from + ROWS_PER_INSERT);
      const params: (string | number | null)[] = [];
      const values = chunk.map(([table, target, ver], i) => {
        params.push(e.read, from + i, table, target, ver?.op ?? null, ver?.restoreCount ?? null);
        const b = i * 6;
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
      });
      await tx.query(
        `INSERT INTO read_log_rows (read_id, k, table_id, target, ver_op, ver_restore_count)
         VALUES ${values.join(", ")}`,
        params,
      );
    }
    for (const x of e.lastRead) {
      await tx.query(
        `INSERT INTO last_read (actor, task, target, kind, op, restore_count, read_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (actor, task, target, kind)
         DO UPDATE SET op = EXCLUDED.op, restore_count = EXCLUDED.restore_count,
           read_id = EXCLUDED.read_id`,
        [e.actor, e.task ?? "", x.target, x.kind, x.op, x.restoreCount, e.read],
      );
    }
  }
}

/**
 * Writes every buffered read in the caller's write transaction and returns them. If the
 * transaction does not commit, the caller puts them back with `buffer.restore(taken)`.
 */
export async function flushBuffer(tx: Tx, buffer: ReadBuffer): Promise<ReadEntry[]> {
  const taken = buffer.take();
  try {
    await writeReads(tx, taken);
  } catch (e) {
    buffer.restore(taken);
    throw e;
  }
  return taken;
}

/** The version the actor last read of the target: the buffer's latest, else the stored one. */
export async function lastRead(
  tx: ReadTx,
  buffer: ReadBuffer,
  q: LastReadQuery,
): Promise<LastRead | undefined> {
  const buffered = buffer.lastRead(q);
  if (buffered !== undefined) return buffered;
  const r = await tx.query<{ op: string | number; restore_count: number; read_id: string }>(
    `SELECT op, restore_count, read_id FROM last_read
     WHERE actor = $1 AND task = $2 AND kind = $3 AND target = $4`,
    [q.actor, q.task ?? "", q.kind, q.target],
  );
  const [row] = r.rows;
  if (row === undefined) return undefined;
  return { op: Number(row.op), restoreCount: row.restore_count, read: row.read_id as ReadId };
}
