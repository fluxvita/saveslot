// A paging position expires once a deletion was confirmed or cancelled anywhere in the tenant
// after its first page (04-contract §15): what a read leaves out changed between the pages, so a
// later page could give a stretch twice or miss one. The next page is refused with
// `handle_expired` (`deletion_changed`); a deletion only carried out (`deletion.executed`) does not
// expire it. Held here for every read that takes a position, through its public entry: a control
// page taken with the position first (given), then a stand-in deletion event in another slot, then
// the same position refused.
//
// A deletion cannot be made through the operations in 0.1.0 (no privacy deletion): its events are
// appended as stand-ins, the latest operation, only for the check they meet (the latest operation
// of a confirmed or cancelled deletion against the position's point).
//
// The static guard lists the kernel files that decode a position: a new read with a position must
// be added both to that list and to the cases below, which is the point of the guard.

import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import {
  catalog,
  createOpsContext,
  createTenant,
  history,
  issueConnection,
  listConnections,
  loadRsql,
  pending,
  query,
  readsList,
  schemaDraft,
  sources,
  sql,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
/** A slot ID no read here is of: the stand-in deletion is in another slot. */
const ELSEWHERE = `sl_${"9".repeat(16)}`;

const DOCUMENT = {
  slot: "ledger",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: "spend",
      kind: "base",
      description: "one row per expense",
      time: { type: "event", field: "date" },
      fields: [
        { name: "date", type: "date", required: true, description: "the day" },
        { name: "note", type: "text", description: "what for" },
      ],
    },
    {
      name: "budgets",
      kind: "base",
      description: "a budget over time",
      time: { type: "state", granularity: "date" },
      fields: [
        { name: "category", type: "text", required: true, description: "kind" },
        { name: "amount", type: "integer", description: "how much" },
      ],
    },
    {
      name: "notes",
      kind: "base",
      description: "timeless notes",
      time: { type: "none" },
      fields: [{ name: "b", type: "text", required: true, description: "the note" }],
    },
    {
      name: "totals",
      kind: "derived",
      description: "expenses a day",
      fields: [
        { name: "date", description: "the day" },
        { name: "n", description: "how many" },
      ],
      rule: {
        sql: "SELECT date, count(note) AS n FROM spend GROUP BY date",
        time_dependency: "bucketed",
      },
    },
  ],
};

let s: ReusableStore;
let minute = 0;
let key = 0;
const ctx = (actor = USER) =>
  createOpsContext({
    tenant: TENANT,
    actor,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-15T03:${String(minute++ % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type Any = any;
/** A write, each with a key of its own (two equal bodies would be one write). */
const w = (ops: unknown[], o: { actor?: string; evidence?: unknown[] } = {}): Promise<Any> =>
  write(s.store, ctx(o.actor), {
    sv: 1,
    idempotency_key: `k-${++key}`,
    ...(o.evidence !== undefined ? { evidence: o.evidence } : {}),
    ops,
  });

/** What the cases page over, made fresh for each. */
let row: string;
let entity: string;
let asOf: number;

beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-positions-expire-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
// Each case on a store of its own: the stand-in event stays in the log, so the store is reset and
// the data built again before every case (simpler than ordering the cases around each other's
// stand-ins).
beforeEach(async () => {
  await s.reset();
  minute = 0;
  await createTenant(s.store, ctx());
  const d = (await schemaDraft(s.store, ctx(), { document: structuredClone(DOCUMENT) })) as Any;
  expect(d.outcome).toBe("applied");
  // Two connections (`connections.list`); the first also writes the other side of the conflicts.
  const desk = await issueConnection(s.store, ctx(), { name: "desk", via: "token" });
  await issueConnection(s.store, ctx(), { name: "phone", via: "token" });
  // Three expenses on three days, each said by the user (three sources, three derived groups);
  // the first changed once (two timeline entries).
  const spent: string[] = [];
  for (const day of [1, 2, 3])
    spent.push(
      (
        await w(
          [{ intent: "insert", table: "spend", set: { date: `2026-11-0${day}`, note: `n${day}` } }],
          {
            evidence: [{ kind: "user_message", text: `spent on the ${day}th` }],
          },
        )
      ).ops[0].target.row,
    );
  row = spent[0] as string;
  await w([{ intent: "update", table: "spend", row, set: { note: "lunch" } }]);
  // A budget in two segments (from the 1st, a new amount from the 5th).
  entity = (
    await w([
      {
        intent: "insert",
        table: "budgets",
        set: { category: "food", amount: 10 },
        valid_from: "2026-11-01",
      },
    ])
  ).ops[0].target.entity;
  asOf = (
    await w([
      { intent: "update", table: "budgets", entity, set: { amount: 20 }, valid_from: "2026-11-05" },
    ])
  ).seq;
  // Two conflicts (two pending items): a note changed by the connection, then by the user on the
  // version before it.
  for (const b of ["9", "x"]) {
    const a = await w([{ intent: "insert", table: "notes", set: { b } }]);
    const at = { row: a.ops[0].target.row, ver: a.ops[0].ver };
    await w([{ intent: "update", table: "notes", ...at, set: { b: `${b}1` } }], { actor: desk.id });
    const c = await w([{ intent: "update", table: "notes", ...at, set: { b: `${b}2` } }]);
    expect(c.pending?.length).toBe(1);
  }
  // Two reads recorded (`reads.list`).
  await query(s.store, ctx(), { table: "spend" });
  await query(s.store, ctx(), { table: "budgets" });
}, T);

/** A stand-in event of the type in another slot, the latest operation. */
const standIn = (type: string) =>
  s.store.write((tx) =>
    tx.query(
      `INSERT INTO events (seq, header, header_hash, type, actor, at, op, slot)
       SELECT max(seq) + 1, '{}', 'h', $1, 'system', '2026-11-15T04:30:00.000Z', max(op) + 1, $2
       FROM events`,
      [type, ELSEWHERE],
    ),
  );

/** The code and reason a read is refused with; "given" when it is not refused. */
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "given",
    (e: { code?: string; detail?: { reason?: string } }) => {
      if (e.code === undefined) throw e;
      return [e.code, e.detail?.reason];
    },
  );

interface Entry {
  readonly name: string;
  /** The kernel file that decodes its position. */
  readonly file: string;
  readonly read: (params: Record<string, unknown>) => Promise<unknown>;
  readonly params: () => Record<string, unknown>;
}

const ENTRIES: readonly Entry[] = [
  {
    name: "query on a base table",
    file: "read/query.ts",
    read: (p) => query(s.store, ctx(), p),
    params: () => ({ table: "spend", limit: 1 }),
  },
  {
    name: "query on a derived table",
    file: "read/derived.ts",
    read: (p) => query(s.store, ctx(), p),
    params: () => ({ table: "totals", limit: 1 }),
  },
  {
    name: "history as_of",
    file: "read/history.ts",
    read: (p) => history(s.store, ctx(), p),
    params: () => ({ table: "budgets", entity, mode: "as_of", as_of: asOf, limit: 1 }),
  },
  {
    name: "history timeline",
    file: "read/timeline.ts",
    read: (p) => history(s.store, ctx(), p),
    params: () => ({ table: "spend", row, limit: 1 }),
  },
  {
    name: "history changes",
    file: "read/changes.ts",
    read: (p) => history(s.store, ctx(), p),
    params: () => ({ mode: "changes", table: "spend", since: 0, limit: 1 }),
  },
  {
    name: "sources (a list)",
    file: "read/sources.ts",
    read: (p) => sources(s.store, ctx(), p),
    params: () => ({ limit: 1 }),
  },
  {
    name: "pending (a list)",
    file: "read/pending.ts",
    read: (p) => pending(s.store, ctx(), p),
    params: () => ({ limit: 1 }),
  },
  {
    name: "sql",
    file: "read/sql.ts",
    read: (p) => sql(s.store, ctx(), p),
    params: () => ({ sql: "SELECT date, note FROM spend ORDER BY date", max_rows: 1 }),
  },
  {
    name: "catalog list",
    file: "read/catalog.ts",
    read: (p) => catalog(s.store, ctx(), p),
    params: () => ({ limit: 1 }),
  },
  {
    name: "connections.list",
    file: "ops/principals.ts",
    read: (p) => listConnections(s.store, ctx(), p as never),
    params: () => ({ limit: 1 }),
  },
  {
    name: "reads.list",
    file: "read/reads-list.ts",
    read: (p) => readsList(s.store, ctx(), p),
    params: () => ({ limit: 1 }),
  },
];

describe("the reads that decode a position", () => {
  it("are exactly the entries held below", () => {
    const root = join(import.meta.dirname, "..", "..", "kernel", "src");
    const callers = (readdirSync(root, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".fixture.ts"))
      .map((f) => f.split(sep).join("/"))
      // page.ts and rows.ts define them (sql.ts defines its own decoder and calls it: a caller).
      .filter((f) => f !== "read/page.ts" && f !== "read/rows.ts")
      .filter((f) => /\b(positionOf|decodePosition)\(/.test(readFileSync(join(root, f), "utf8")))
      .sort();
    expect(callers).toEqual(ENTRIES.map((e) => e.file).sort());
    expect(callers).toHaveLength(11);
  });
});

describe("a position after a deletion confirmed since its first page", () => {
  it.each(ENTRIES)(
    "$name: given before, handle_expired (deletion_changed) after",
    async (e) => {
      const params = e.params();
      const first = (await e.read(params)) as { next_position?: string };
      expect(first.next_position).toEqual(expect.any(String));
      const next = { ...params, position: first.next_position };
      expect(await outcome(e.read(next))).toBe("given");
      await standIn("deletion.confirmed");
      expect(await outcome(e.read(next))).toEqual(["handle_expired", "deletion_changed"]);
    },
    T,
  );
});

describe("a position after a deletion confirmed before its first page", () => {
  it.each(ENTRIES)(
    "$name: given",
    async (e) => {
      await standIn("deletion.confirmed");
      // A read recorded after the deletion: `reads.list` compares with the state its first page's
      // last read record read (wider than needed: a record from before the deletion expires it).
      await query(s.store, ctx(), { table: "spend", limit: 1 });
      const params = e.params();
      const first = (await e.read(params)) as { next_position?: string };
      expect(first.next_position).toEqual(expect.any(String));
      expect(await outcome(e.read({ ...params, position: first.next_position }))).toBe("given");
    },
    T,
  );
});

describe("other deletion events", () => {
  const params = { table: "spend", limit: 1 };
  const firstPosition = async () =>
    ((await query(s.store, ctx(), params)) as { next_position?: string }).next_position as string;

  it(
    "a deletion cancelled since the first page expires the position",
    async () => {
      const position = await firstPosition();
      await standIn("deletion.cancelled");
      expect(await outcome(query(s.store, ctx(), { ...params, position }))).toEqual([
        "handle_expired",
        "deletion_changed",
      ]);
    },
    T,
  );

  it(
    "a deletion only carried out since the first page does not: the next page is given",
    async () => {
      const position = await firstPosition();
      await standIn("deletion.executed");
      const next = (await query(s.store, ctx(), { ...params, position })) as Any;
      expect(next.rows).toHaveLength(1);
    },
    T,
  );
});
