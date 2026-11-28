// How many statements one `write` sends to the tenant's store, per shape of write. Each statement is
// a round trip in server mode and a message to the database worker in local mode, so the count is
// held here: a shape whose count rises above the one recorded fails. A change that lowers a count
// lowers its recorded value in the same change, so that every cut shows as a number. PGlite
// receives the same kernel statements as PostgreSQL; server mode adds its own around them (the
// transaction, the tenant's lock, the `meta` read).

import { createOpsContext, createTenant, schemaDraft, write } from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgliteTenantStore } from "./backend.ts";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

/** An event table with two fields and a state table with one; no derived table. */
const LEDGER = {
  slot: "ledger",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: "expenses",
      kind: "base",
      description: "one row per expense",
      time: { type: "event", field: "date" },
      fields: [
        { name: "date", type: "date", required: true, description: "the day" },
        { name: "note", type: "text", description: "what for" },
      ],
    },
    {
      name: "balance",
      kind: "base",
      description: "the balance over time",
      time: { type: "state", granularity: "date" },
      fields: [{ name: "amount", type: "text", description: "how much" }],
    },
  ],
};
/** An event table with two fields and a derived table that reads it. */
const VISITS = {
  slot: "visits",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: "visits",
      kind: "base",
      description: "one row per visit",
      time: { type: "event", field: "date" },
      fields: [
        { name: "date", type: "date", required: true, description: "the day" },
        { name: "place", type: "text", description: "where" },
      ],
    },
    {
      name: "per_day",
      kind: "derived",
      description: "visits a day",
      fields: [
        { name: "date", description: "the day" },
        { name: "n", description: "how many" },
      ],
      rule: {
        sql: "SELECT date, count(place) AS n FROM visits GROUP BY date",
        time_dependency: "bucketed",
      },
    },
  ],
};

/**
 * Statements per shape, as recorded. A rise fails; a fall fails too until the value here is
 * lowered, so that a cut is recorded with the change that makes it.
 */
const RECORDED = {
  "insert one event row": 49,
  "insert one state entity": 50,
  "update one state entity": 64,
  "insert one event row, with a derived table": 69,
  "insert one event row, with a premise": 58,
};

let s: ReusableStore;
let minute = 0;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T03:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
// biome-ignore lint/suspicious/noExplicitAny: receipts as the kernel returns them
type Any = any;

/**
 * The statements `fn` sends through every transaction of `store` it opens, in order. The store's
 * methods are wrapped in place rather than the store wrapped in another object: what the kernel
 * keeps per store (the read buffer, the restore count) stays with it.
 */
async function statementsOf(store: PgliteTenantStore, fn: () => Promise<unknown>) {
  const sent: string[] = [];
  const counted = (tx: Any): Any =>
    new Proxy(tx, {
      get(target, key, receiver) {
        const v = Reflect.get(target, key, receiver);
        if (key !== "query" && key !== "exec") return v;
        return (sql: string, ...rest: unknown[]) => {
          sent.push(sql.replace(/\s+/g, " ").trim());
          return v.call(target, sql, ...rest);
        };
      },
    });
  // PGlite has no `recordReads`: a read's record is buffered, and the write flushes it first.
  const own = { write: store.write, read: store.read };
  const writable = store as unknown as Record<keyof typeof own, Any>;
  writable.write = (f: Any) => own.write.call(store, (tx: Any) => f(counted(tx)));
  writable.read = (f: Any) => own.read.call(store, (tx: Any) => f(counted(tx)));
  try {
    await fn();
  } finally {
    Object.assign(writable, own);
  }
  return sent;
}

/** Sends `params` as one write, counting its statements; refuses a receipt that saved nothing. */
async function counted(params: unknown) {
  let receipt: Any;
  const sent = await statementsOf(s.store, async () => {
    receipt = await write(s.store, ctx(), params);
  });
  expect(receipt.status).toBe("saved");
  return { receipt, sent };
}

/** Holds `sent`'s count at the value recorded for `shape`; the statements are in the message. */
function hold(shape: keyof typeof RECORDED, sent: readonly string[]) {
  expect(
    sent.length,
    `${shape}: ${sent.length} statements, ${RECORDED[shape]} recorded\n${sent.join("\n")}`,
  ).toBe(RECORDED[shape]);
}

const insertBalance = (amount: string) =>
  write(s.store, ctx(), {
    sv: 1,
    ops: [{ intent: "insert", table: "balance", valid_from: "2026-11-01", set: { amount } }],
  }) as Promise<Any>;

beforeAll(async () => {
  s = await openReusable("saveslot-write-statements-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), { document: structuredClone(LEDGER) });
  await schemaDraft(s.store, ctx(), { document: structuredClone(VISITS) });
  // A write before the counted one, so that what is read once in a store's life is not counted.
  await insertBalance("0");
}, T);

describe("statements of one write", () => {
  it(
    "insert one event row",
    async () => {
      const { sent } = await counted({
        sv: 1,
        ops: [{ intent: "insert", table: "expenses", set: { date: "2026-11-01", note: "tea" } }],
      });
      hold("insert one event row", sent);
    },
    T,
  );

  it(
    "insert one state entity",
    async () => {
      const { sent } = await counted({
        sv: 1,
        ops: [
          { intent: "insert", table: "balance", valid_from: "2026-11-01", set: { amount: "10" } },
        ],
      });
      hold("insert one state entity", sent);
    },
    T,
  );

  it(
    "update one state entity",
    async () => {
      const first = await insertBalance("10");
      const { sent } = await counted({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "balance",
            entity: first.ops[0].target.entity,
            ver: first.ops[0].ver,
            valid_from: "2026-11-02",
            set: { amount: "12" },
          },
        ],
      });
      hold("update one state entity", sent);
    },
    T,
  );

  it(
    "insert one event row, with a derived table",
    async () => {
      const { receipt, sent } = await counted({
        sv: 1,
        ops: [{ intent: "insert", table: "visits", set: { date: "2026-11-01", place: "park" } }],
      });
      expect(receipt.derived_total).toBe(1);
      hold("insert one event row, with a derived table", sent);
    },
    T,
  );

  it(
    "insert one event row, with a premise",
    async () => {
      const b = await insertBalance("10");
      const { receipt, sent } = await counted({
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "expenses",
            set: { date: "2026-11-01", note: "tea" },
            premises: [
              {
                table: "balance",
                entity: b.ops[0].target.entity,
                fields: ["amount"],
                ver: b.ops[0].ver,
              },
            ],
          },
        ],
      });
      expect(receipt.ops[0].premises).toHaveLength(1);
      hold("insert one event row, with a premise", sent);
    },
    T,
  );
});
