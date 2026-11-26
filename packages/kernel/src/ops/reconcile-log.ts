// `log.reconcile` (docs/zh-CN/spec/04-contract.md, 04-contract-types §8.4 `LogReconcileResult`;
// 02-architecture.md §7 "对拍", §8 the "对拍" column, §11 K12): the log replayed from an empty
// storage into a scratch one, and the tables §8 marks as compared set against the live ones.
//
// In three parts, as §7 has them:
//
// 1. the log copied into the scratch storage in batches (events and content rows as they are, each
//    batch in its own transactions on either side) and given to `apply` there; reads and writes go
//    on meanwhile;
// 2. again until a batch reaches the live log's end as it was when the batch began;
// 3. one read transaction on the live storage: its log's end read, the scratch storage brought up to
//    it, and every compared table set against the live one, all in that transaction. On PGlite reads
//    and writes share one queue, so writes wait meanwhile; on PostgreSQL a tenant's read
//    transaction is one snapshot, so the comparison sees the log's end it read whatever is written.
//
// A batch ends where an operation does: the events of one operation are applied together.
//
// The tables: the kernel's materialized ones marked compared (`catalog` without its profile and
// value samples), and the business, version and derived tables `apply` made. A table on one side
// only, or with other columns or another primary key, is a mismatch of the table, and so is one with
// no primary key (every table `apply` makes has one, and a row has no ID without it); otherwise the
// rows are merged by primary key, a page at a time on each side: a row on the live side only is
// `extra` (made without `apply`), on the scratch side only `missing`, and a column that differs is
// `different` with that field.
//
// Mismatches name IDs only, never values (04-contract-types §8.4): the table's physical name, the
// row's ID and the field's ID. A row's ID comes from primary key columns only: a row or entity ID
// (a state table's row is its entity; the stretch's start is business time, content), a partition
// ID, a kernel table's key. A table whose key holds content (request keys, external keys' values)
// names no row; `counts` is named by its table ID, its partition key left out.
//
// Counted as §8.4 has it: a place (table, row, field, kind) is listed once however many rows give
// it (two cells of one field of one row removed are one place), and `mismatches_total` counts
// places; `tables[].mismatched` counts rows with at least one mismatch.
//
// What it cannot see: a `delete` that worked out the wrong result writes that result into the log,
// and replaying the log gives it again (02-architecture §11 «记录与重算一致»).

import type { Seq } from "@fluxvita/saveslot-contract-core";
import { applyEvents } from "../apply/apply.ts";
import { readEvents, readTail } from "../log/index.ts";
import { KERNEL_TABLES } from "../store/format-v1.ts";
import type { ReadTx, SqlValue, TenantStore } from "../store/ports.ts";
import { OpsError } from "./errors.ts";

/** One place the two sides differ: IDs only. */
export interface ReconcileMismatch {
  readonly table: string;
  readonly row?: string;
  readonly field?: string;
  readonly kind: "missing" | "extra" | "different";
}

/** 04-contract-types §8.4 `LogReconcileResult`. */
export interface ReconcileResult {
  readonly compared_to: Seq;
  readonly tables: readonly {
    readonly name: string;
    readonly rows: number;
    /** Rows with at least one mismatch: a state table's by entity; a table without rows' IDs by rows. */
    readonly mismatched: number;
  }[];
  /** Places, each (table, row, field, kind) once, in the order found; the first 100. */
  readonly mismatches: readonly ReconcileMismatch[];
  /** All the places, before the cap. Counts places where `mismatched` counts rows, on purpose. */
  readonly mismatches_total: number;
}

/** How many mismatches a result lists; the rest are counted only. */
export const RECONCILE_MISMATCHES_SHOWN = 100;

export interface ReconcileOptions {
  /** The tenant's storage, read only. */
  readonly live: TenantStore;
  /** An empty storage of the same format, the host's, discarded after. */
  readonly scratch: TenantStore;
  /** Events a batch takes at most before it is rounded up to its operation's end. */
  readonly batch?: number;
  /** Told where it is: replaying, catching up (writes wait on PGlite from here), comparing. */
  readonly onPhase?: (phase: "replay" | "catch_up" | "compare", seq: Seq) => void;
  /** Rows a page takes on each side when tables are compared. */
  readonly page?: number;
}

export async function reconcileLog(o: ReconcileOptions): Promise<ReconcileResult> {
  const batch = o.batch ?? 1000;
  if (!(await o.scratch.read(isEmpty))) {
    throw new OpsError("internal", "log.reconcile: the scratch storage is not empty");
  }
  let done = 0;
  o.onPhase?.("replay", done);
  for (;;) {
    const end = (await o.live.read((tx) => readTail(tx)))?.seq ?? 0;
    if (done >= end) break;
    while (done < end) {
      const rows = await o.live.read((tx) => batchOf(tx, done, end, batch));
      done = await copy(o.scratch, rows);
    }
  }
  return o.live.read(async (live) => {
    const end = (await readTail(live))?.seq ?? 0;
    o.onPhase?.("catch_up", end);
    while (done < end) done = await copy(o.scratch, await batchOf(live, done, end, batch));
    o.onPhase?.("compare", end);
    return o.scratch.read((scratch) => compare(live, scratch, end, o.page ?? 1000));
  });
}

/** Whether a storage holds nothing a replay writes: no event, no row of a materialized table. */
async function isEmpty(tx: ReadTx): Promise<boolean> {
  if ((await readTail(tx)) !== undefined) return false;
  const r = await tx.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  for (const { tablename: t } of r.rows) {
    const k = KERNEL.get(t);
    if (k === undefined ? !SLOT_TABLE.test(t) : k.class === "local") continue;
    if ((await tx.query(`SELECT 1 FROM "${t}" LIMIT 1`)).rows.length > 0) return false;
  }
  return true;
}

interface Batch {
  readonly to: Seq;
  readonly events: readonly Record<string, unknown>[];
  readonly content: readonly Record<string, unknown>[];
}

/** The rows of the events after `from`, up to `batch` of them and on to their operation's end. */
async function batchOf(tx: ReadTx, from: Seq, end: Seq, batch: number): Promise<Batch> {
  const ahead = await tx.query<{ seq: unknown }>(
    "SELECT seq FROM events WHERE seq > $1 AND seq <= $2 ORDER BY seq OFFSET $3 LIMIT 1",
    [from, end, batch - 1],
  );
  let to = end;
  const last = ahead.rows[0]?.seq;
  if (last !== undefined) {
    const r = await tx.query<{ to: unknown }>(
      "SELECT max(seq) AS to FROM events WHERE op = (SELECT op FROM events WHERE seq = $1)",
      [last as SqlValue],
    );
    to = Math.min(end, Number(r.rows[0]?.to));
  }
  const events = await tx.query<Record<string, unknown>>(
    "SELECT * FROM events WHERE seq > $1 AND seq <= $2 ORDER BY seq",
    [from, to],
  );
  const content = await tx.query<Record<string, unknown>>(
    "SELECT * FROM content WHERE seq > $1 AND seq <= $2 ORDER BY seq, path",
    [from, to],
  );
  return { to, events: events.rows, content: content.rows };
}

/** Appends a batch's rows to the scratch storage as they are, and applies its events there. */
async function copy(scratch: TenantStore, b: Batch): Promise<Seq> {
  await scratch.write(async (tx) => {
    for (const [table, rows] of [
      ["events", b.events],
      ["content", b.content],
    ] as const) {
      for (const r of rows) {
        const cols = Object.keys(r);
        await tx.query(
          `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols
            .map((_, i) => `$${i + 1}`)
            .join(", ")})`,
          Object.values(r) as SqlValue[],
        );
      }
    }
    const first = Number(b.events[0]?.["seq"] ?? b.to);
    if (b.events.length > 0) await applyEvents(tx, await readEvents(tx, first, b.to));
  });
  return b.to;
}

// --- comparison ---------------------------------------------------------------------------------

const KERNEL = new Map(KERNEL_TABLES.map((t) => [t.name, t]));
/** Columns not compared: the catalog's profile and value samples (§8). */
const LEFT_OUT: ReadonlyMap<string, readonly string[]> = new Map([
  ["catalog", ["profile", "samples"]],
]);
/** Tables whose primary key holds content: a mismatch names the table, never a row. */
const CONTENT_KEYED: ReadonlySet<string> = new Set(["request_keys", "external_keys"]);
/** Key columns that are content, left out of the row: `counts` is named by its table ID. */
const CONTENT_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  ["counts", ["partition_key"]],
]);
/** Tables `apply` makes for a slot: business, version and derived. */
const SLOT_TABLE = /^[td]_[a-z0-9]+_v[1-9][0-9]*(__ver)?$/;

function compared(name: string): boolean {
  const k = KERNEL.get(name);
  if (k !== undefined)
    return k.class === "materialized" && k.reconciled !== undefined && k.reconciled !== false;
  return SLOT_TABLE.test(name);
}

interface Column {
  readonly name: string;
  readonly type: string;
  readonly shape: string;
}

async function tablesOf(tx: ReadTx): Promise<string[]> {
  const r = await tx.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  return r.rows.map((x) => x.tablename).filter(compared);
}

async function columnsOf(tx: ReadTx, table: string): Promise<Column[]> {
  const left = LEFT_OUT.get(table) ?? [];
  const r = await tx.query<{
    column_name: string;
    data_type: string;
    numeric_precision: number | null;
    numeric_scale: number | null;
    is_nullable: string;
  }>(
    `SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return r.rows
    .filter((c) => !left.includes(c.column_name))
    .map((c) => ({
      name: c.column_name,
      type: c.data_type,
      shape: `${c.column_name} ${c.data_type}(${c.numeric_precision ?? ""},${c.numeric_scale ?? ""}) ${c.is_nullable}`,
    }));
}

async function keyOf(tx: ReadTx, table: string): Promise<string[]> {
  const r = await tx.query<{ column_name: string }>(
    `SELECT k.column_name
       FROM information_schema.table_constraints c
       JOIN information_schema.key_column_usage k
         ON k.constraint_name = c.constraint_name AND k.table_schema = c.table_schema
            AND k.table_name = c.table_name
       WHERE c.table_schema = 'public' AND c.table_name = $1 AND c.constraint_type = 'PRIMARY KEY'
       ORDER BY k.ordinal_position`,
    [table],
  );
  return r.rows.map((x) => x.column_name);
}

async function count(tx: ReadTx, table: string): Promise<number> {
  const r = await tx.query<{ n: unknown }>(`SELECT count(*) AS n FROM "${table}"`);
  return Number(r.rows[0]?.n ?? 0);
}

/** A key column's order: how the query sorts by it, and how two of its values (as text) compare. */
interface KeyOrder {
  readonly column: string;
  readonly sql: string;
  readonly compare: (x: string, y: string) => number;
}

const INTEGER = new Set(["bigint", "integer", "smallint"]);

/**
 * The one place the database's order and the merge's agree: an integer key by its value, any other
 * as text by code point (under "C"). Sorted one way and merged another, a single row on one side
 * only would misalign every row after it.
 */
function keyOrder(table: string, column: Column): KeyOrder {
  const col = `"${table}"."${column.name}"`;
  return INTEGER.has(column.type)
    ? {
        column: column.name,
        sql: col,
        compare: (x, y) => (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0),
      }
    : { column: column.name, sql: `${col}::text COLLATE "C"`, compare: byCodePoint };
}

/** Two rows' keys in the order the pages come in. A primary key's columns are never null. */
function compareKey(
  a: Record<string, string | null>,
  b: Record<string, string | null>,
  key: readonly KeyOrder[],
): number {
  for (const k of key) {
    const c = k.compare(a[k.column] ?? "", b[k.column] ?? "");
    if (c !== 0) return c;
  }
  return 0;
}

function byCodePoint(x: string, y: string): number {
  const a = [...x];
  const b = [...y];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = (a[i]?.codePointAt(0) ?? 0) - (b[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

let cursors = 0;

/**
 * Pages of a table's rows in key order, every column as text: a cursor of the transaction, so a
 * page costs its rows whatever came before it.
 */
async function* pages(
  tx: ReadTx,
  table: string,
  columns: readonly Column[],
  key: readonly KeyOrder[],
  size: number,
): AsyncGenerator<readonly Record<string, string | null>[]> {
  const select = columns.map((c) => `"${c.name}"::text AS "${c.name}"`).join(", ");
  // The table's own columns, not the text output columns of the same names.
  const order = key.map((k) => k.sql).join(", ");
  const cursor = `reconcile_${++cursors}`;
  await tx.query(
    `DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT ${select} FROM "${table}" ORDER BY ${order}`,
  );
  try {
    for (;;) {
      const r = await tx.query<Record<string, string | null>>(`FETCH ${size} FROM ${cursor}`);
      if (r.rows.length === 0) return;
      yield r.rows;
    }
  } finally {
    await tx.query(`CLOSE ${cursor}`);
  }
}

async function* rowsOf(
  tx: ReadTx,
  table: string,
  columns: readonly Column[],
  key: readonly KeyOrder[],
  size: number,
): AsyncGenerator<Record<string, string | null>> {
  for await (const p of pages(tx, table, columns, key, size)) yield* p;
}

/** The field a column holds: `f_<field>` and its `__zone` give the field's ID, others their name. */
function fieldOf(column: string): string {
  const m = /^f_(f[1-9][0-9]*)(__zone)?$/.exec(column);
  return m?.[1] ?? column;
}

/** A row's ID, from its primary key's columns only: no other column is read for it. */
function rowOf(
  table: string,
  key: readonly string[],
  r: Record<string, string | null>,
): string | undefined {
  if (CONTENT_KEYED.has(table)) return undefined;
  if (SLOT_TABLE.test(table)) {
    const id = ["row_id", "entity_id"].find((k) => key.includes(k)) ?? key[0];
    return id === undefined ? undefined : (r[id] ?? undefined);
  }
  const content = CONTENT_KEYS.get(table) ?? [];
  const named = key.filter((k) => !content.includes(k)).map((k) => r[k] ?? "");
  return named.length === 0 ? undefined : named.join("/");
}

async function compare(
  live: ReadTx,
  scratch: ReadTx,
  end: Seq,
  page: number,
): Promise<ReconcileResult> {
  const mismatches: ReconcileMismatch[] = [];
  let total = 0;
  const note = (m: ReconcileMismatch) => {
    total++;
    if (mismatches.length < RECONCILE_MISMATCHES_SHOWN) mismatches.push(m);
  };
  const tables: { name: string; rows: number; mismatched: number }[] = [];
  const [l, s] = await Promise.all([tablesOf(live), tablesOf(scratch)]);
  const names = [...new Set([...l, ...s])].sort(byCodePoint);
  for (const name of names) {
    const inLive = l.includes(name);
    const inScratch = s.includes(name);
    if (!inLive || !inScratch) {
      tables.push({ name, rows: await count(inLive ? live : scratch, name), mismatched: 1 });
      note({ table: name, kind: inLive ? "extra" : "missing" });
      continue;
    }
    const [lc, sc] = [await columnsOf(live, name), await columnsOf(scratch, name)];
    const [key, sk] = [await keyOf(live, name), await keyOf(scratch, name)];
    const shape = (cs: readonly Column[], k: readonly string[]) =>
      [...cs.map((c) => c.shape), `PRIMARY KEY (${k.join(", ")})`].join("\n");
    if (shape(lc, key) !== shape(sc, sk) || key.length === 0) {
      tables.push({ name, rows: await count(live, name), mismatched: 1 });
      note({ table: name, kind: "different" });
      continue;
    }
    const order = key.map((k) =>
      keyOrder(name, lc.find((c) => c.name === k) ?? { name: k, type: "text", shape: "" }),
    );
    const isVersion = name.endsWith("__ver");
    let rows = 0;
    let mismatched = 0;
    // A row's places come together: its ID is the key's leading column (a row, entity or partition
    // ID; a kernel table's key from its first column), so looking back at the row before is enough
    // to count a row once and list a place once. A table without rows' IDs counts rows.
    let last: string | undefined;
    const seen = new Set<string>();
    const place = (
      row: string | undefined,
      found: readonly { field?: string | undefined; kind: ReconcileMismatch["kind"] }[],
    ) => {
      if (row === undefined) mismatched++;
      else if (row !== last) {
        mismatched++;
        last = row;
        seen.clear();
      }
      for (const f of found) {
        const k = `${f.field ?? ""}\u0000${f.kind}`;
        if (seen.has(k)) continue;
        seen.add(k);
        note({
          table: name,
          ...(row === undefined ? {} : { row }),
          ...(f.field === undefined ? {} : { field: f.field }),
          kind: f.kind,
        });
      }
    };
    const a = rowsOf(live, name, lc, order, page);
    const b = rowsOf(scratch, name, lc, order, page);
    let x = await a.next();
    let y = await b.next();
    while (!x.done || !y.done) {
      const c = x.done ? 1 : y.done ? -1 : compareKey(x.value, y.value, order);
      if (c < 0 && !x.done) {
        rows++;
        const id = idOf(name, key, x.value, isVersion);
        place(id.row, [{ field: id.field, kind: "extra" }]);
        x = await a.next();
      } else if (c > 0 && !y.done) {
        const id = idOf(name, key, y.value, isVersion);
        place(id.row, [{ field: id.field, kind: "missing" }]);
        y = await b.next();
      } else if (!x.done && !y.done) {
        rows++;
        const differ = lc.filter(
          (col) => (x.value[col.name] ?? null) !== (y.value[col.name] ?? null),
        );
        if (differ.length > 0) {
          const id = idOf(name, key, x.value, isVersion);
          const fields =
            isVersion && id.field !== undefined
              ? [id.field]
              : [...new Set(differ.map((d) => fieldOf(d.name)))];
          place(
            id.row,
            fields.map((field) => ({ field, kind: "different" as const })),
          );
        }
        x = await a.next();
        y = await b.next();
      }
    }
    tables.push({ name, rows, mismatched });
  }
  return { compared_to: end, tables, mismatches, mismatches_total: total };
}

/** A row's ID, and for a version table the field of its cell. */
function idOf(
  table: string,
  key: readonly string[],
  r: Record<string, string | null>,
  isVersion: boolean,
): { row?: string; field?: string } {
  const row = rowOf(table, key, r);
  const field = isVersion ? (r["field_id"] ?? undefined) : undefined;
  return { ...(row === undefined ? {} : { row }), ...(field === undefined ? {} : { field }) };
}
