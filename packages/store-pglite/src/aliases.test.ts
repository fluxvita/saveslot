// Aliases on a slot compiled from a real document and stored (docs/zh-CN/spec/03-data-model/
// 07-schema-evolution.md «schema 文档格式» 别名; 04-contract §11 `nearest`): they are not names, so a
// request that uses one is refused as an unknown table or field, and `nearest` puts the objects
// whose alias folds to the request's word first, as names, in `C` order.

import {
  appendOperation,
  applyEvents,
  compileNewSlot,
  createOpsContext,
  createTenant,
  eventsOf,
  loadRsql,
  query,
  write,
} from "@fluxvita/saveslot-kernel";
import { createSlotEvents, DRAFT, SLOT } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";
import { runSql, refusal as sqlRefusal } from "./testing/sql-tenant.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

/**
 * Two tables share the alias `spending`, two share `diary`, two fields of `expenses` share `cost`.
 * `log_2` is before `log_1` in the document: the order of names is not the order of the document.
 */
const DOCUMENT = {
  slot: "ledger",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: "expenses",
      kind: "base",
      description: "one row per expense",
      aliases: ["spending", "花销"],
      time: { type: "none" },
      fields: [
        { name: "note", type: "text", required: true, description: "what for" },
        { name: "amount", type: "integer", description: "how much", aliases: ["cost", "价钱"] },
        { name: "fee", type: "integer", description: "a fee on top", aliases: ["cost"] },
        { name: "zzz", type: "text", description: "a field far from any word" },
      ],
    },
    {
      name: "budgets",
      kind: "base",
      description: "one row per budget",
      aliases: ["spending"],
      time: { type: "none" },
      fields: [{ name: "limit", type: "integer", description: "the limit" }],
    },
    {
      name: "notes",
      kind: "base",
      description: "free notes",
      time: { type: "none" },
      fields: [{ name: "body", type: "text", description: "the text" }],
    },
    {
      name: "log_2",
      kind: "base",
      description: "a log",
      aliases: ["diary"],
      time: { type: "none" },
      fields: [{ name: "body", type: "text", description: "the text" }],
    },
    {
      name: "log_1",
      kind: "base",
      description: "another log",
      aliases: ["diary"],
      time: { type: "none" },
      fields: [{ name: "body", type: "text", description: "the text" }],
    },
  ],
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

async function refusal(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await run();
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { code: x.code, ...(x.detail ?? {}) };
  }
  throw new Error("not refused");
}
const read = (params: unknown) => refusal(() => query(s.store, ctx(), params));
const writing = (ops: unknown[]) => refusal(() => write(s.store, ctx(), { sv: 1, ops }));

beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-aliases-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  await createTenant(
    s.store,
    createOpsContext({
      tenant: TENANT,
      actor: USER,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_key_window: 86_400_000,
      idempotency_window: 600_000,
      now: "2026-11-05T00:00:00.000Z",
      confirmation: null,
    }),
  );
  const compiled = compileNewSlot({
    document: structuredClone(DOCUMENT),
    slotId: SLOT,
    nextTableNumber: 1,
    nextRuleNumber: 1,
    existingSlotNames: [],
  });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
  const events = createSlotEvents({
    compiled: compiled.compiled as never,
    changes: compiled.changes as never,
  });
  (events[0] as { blocks: Record<string, unknown> }).blocks["draft"] = structuredClone(DOCUMENT);
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-05T00:00:30.000Z" as never,
      events,
    });
    await applyEvents(tx, eventsOf(op));
  });
}, T);

describe("a table alias is not a name: nearest puts the tables of that alias first", () => {
  // `spending` is an alias of `expenses` and of `budgets`, a name of neither: both come first, then
  // the next by edit distance. Among those of the alias the order is the edit distance, then `C`.
  it("a read", async () => {
    const e = await read({ table: "spending" });
    expect(e).toEqual({
      code: "unknown_table",
      param: "table",
      name: "spending",
      nearest: ["expenses", "budgets", "notes"],
    });
  });

  it("the tables of one alias, equally near, in C order, not in the order of the document", async () => {
    const e = await read({ table: "diary" });
    expect((e["nearest"] as string[]).slice(0, 2)).toEqual(["log_1", "log_2"]);
    expect(JSON.stringify(e["nearest"])).not.toMatch(/diary/);
  });

  it("a write", async () => {
    const e = await writing([{ intent: "insert", table: "Spending", set: { note: "x" } }]);
    expect(e).toMatchObject({
      code: "unknown_table",
      param: "ops/0/table",
      name: "Spending",
      nearest: ["expenses", "budgets", "notes"],
    });
  });

  it("an alias in another script, folded as a code point sequence", async () => {
    // `花销` is the alias of `expenses` only: that name first, never the alias text.
    const e = await read({ table: "花销" });
    expect((e["nearest"] as string[])[0]).toBe("expenses");
    expect(JSON.stringify(e["nearest"])).not.toMatch(/花销|spending/);
  });

  it("without the alias word, the order is by edit distance alone", async () => {
    const e = await read({ table: "note" });
    expect((e["nearest"] as string[])[0]).toBe("notes");
  });
});

/**
 * A second slot `wallet` with its own `expenses`, without aliases. `slot` decides whether it comes
 * before or after `ledger` among the visible slots.
 */
async function addWallet(slot: string): Promise<void> {
  const document = {
    slot: "wallet",
    base_version: null,
    timezone: "Asia/Shanghai",
    tables: [
      {
        name: "expenses",
        kind: "base",
        description: "a wallet's expenses",
        time: { type: "none" },
        fields: [{ name: "note", type: "text", description: "what for" }],
      },
    ],
  };
  const compiled = compileNewSlot({
    document: structuredClone(document),
    slotId: slot as never,
    nextTableNumber: 6,
    nextRuleNumber: 1,
    existingSlotNames: ["ledger"],
  });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
  const events = JSON.parse(
    JSON.stringify(
      createSlotEvents({
        compiled: compiled.compiled as never,
        changes: compiled.changes as never,
      }),
    )
      .replaceAll(SLOT, slot)
      .replaceAll(DRAFT, `d_${"2".repeat(16)}`)
      .replaceAll('"ledger"', '"wallet"'),
  );
  events[0].blocks["draft"] = structuredClone(document);
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-05T00:01:00.000Z" as never,
      events,
    });
    await applyEvents(tx, eventsOf(op));
  });
}

describe("two slots with a table of one name, only one with the alias", () => {
  // Without a slot, the candidates are bare names: the tables of one name join their aliases, on
  // reads as on writes, whichever slot comes first.
  it.each([
    ["after", `sl_${"9".repeat(16)}`],
    ["before", `sl_${"1".repeat(16)}`],
  ])("the other slot %s ledger: expenses first, on a read and on a write", async (_, slot) => {
    await addWallet(slot);
    const r = await read({ table: "spending" });
    expect((r["nearest"] as string[]).slice(0, 2)).toEqual(["expenses", "budgets"]);
    const w = await writing([{ intent: "insert", table: "spending", set: { note: "x" } }]);
    expect((w["nearest"] as string[]).slice(0, 2)).toEqual(["expenses", "budgets"]);
    expect(r["nearest"]).toEqual(w["nearest"]);
  });
});

describe("a field alias is not a name either", () => {
  it("a read", async () => {
    expect(await read({ table: "expenses", fields: ["price"] })).toMatchObject({
      code: "unknown_field",
      nearest: expect.not.arrayContaining(["cost", "价钱"]),
    });
    // `价钱` is the alias of `amount` only; `cost` of `amount` and `fee`.
    const one = await read({ table: "expenses", fields: ["价钱"] });
    expect(one).toMatchObject({ code: "unknown_field", param: "fields/0", name: "价钱" });
    expect((one["nearest"] as string[])[0]).toBe("amount");
    const two = await read({ table: "expenses", fields: ["COST"] });
    expect((two["nearest"] as string[]).slice(0, 2)).toEqual(["amount", "fee"]);
    expect(JSON.stringify(two["nearest"])).not.toMatch(/cost|价钱/i);
  });

  it("a write", async () => {
    const e = await writing([{ intent: "insert", table: "expenses", set: { note: "x", cost: 3 } }]);
    expect(e).toMatchObject({ code: "unknown_field", name: "cost" });
    expect((e["nearest"] as string[]).slice(0, 2)).toEqual(["amount", "fee"]);
    expect(JSON.stringify(e["nearest"])).not.toMatch(/cost|价钱/i);
  });
});

describe("the names still work", () => {
  it("a write and a read by name", async () => {
    await write(s.store, ctx(), {
      sv: 1,
      ops: [{ intent: "insert", table: "expenses", set: { note: "lunch", amount: 3 } }],
    });
    const r = (await query(s.store, ctx(), { table: "expenses" })) as unknown as { total: number };
    expect(r.total).toBe(1);
  });
});

describe("an alias is no name in the restricted SQL either", () => {
  /** A refusal with the one word the statement spelled replaced, to compare two spellings. */
  const spelled = (e: Record<string, unknown>, word: string) =>
    JSON.parse(JSON.stringify(e).replaceAll(word, "X")) as Record<string, unknown>;
  const sql = (text: string) => sqlRefusal(runSql(s, { sql: text }));

  it("a table alias is refused as any unknown table, in the same words", async () => {
    const alias = await sql("SELECT 1 FROM spending");
    const none = await sql("SELECT 1 FROM nosuch_zz");
    expect(alias).toMatchObject({ code: "sql_rejected", reason: "unknown_name" });
    expect(spelled(alias, "spending")).toEqual(spelled(none, "nosuch_zz"));
  });

  it("a field alias is refused as any unknown field", async () => {
    const alias = await sql("SELECT cost FROM expenses");
    const none = await sql("SELECT nosuch_zz FROM expenses");
    expect(alias).toMatchObject({ code: "sql_rejected", reason: "unknown_name" });
    expect(spelled(alias, "cost")).toEqual(spelled(none, "nosuch_zz"));
  });

  it("the names resolve", async () => {
    const r = await runSql(s, { sql: "SELECT amount FROM expenses" });
    expect(r.result.warnings).toBeUndefined();
  });
});
