// `catalog` on PGlite (04-contract §10 `catalog`; 04-contract-types §4.2, §8.2): a slot created from a
// real schema document, then its three levels within the visible range, each refusal, the read
// recorded, and a write without sv falling back to a catalog read.

import {
  appendOperation,
  applyEvents,
  catalog,
  compileNewSlot,
  createOpsContext,
  createTenant,
  eventsOf,
  flushReads,
  query,
  readBufferOf,
  readsList,
  write,
} from "@fluxvita/saveslot-kernel";
import { createSlotEvents, SLOT } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const OTHER = `ci_${"2".repeat(26)}`;
/** The task of `saveslot connect`'s self-check, as 06-cli §3 step 7 spells it. */
const SELFCHECK_TASK = "saveslot-connect-selfcheck";

/** The document the slot is created from, as a caller would submit it. */
const DOCUMENT = {
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
        { name: "category", type: "enum", description: "kind", values: ["food", "rent"] },
        {
          name: "amount",
          type: "quantity",
          required: true,
          description: "how much",
          min: 0,
          unit: "CNY",
        },
        { name: "rate", type: "decimal", description: "a rate", scale: 4, rounding: "half_even" },
        {
          name: "account",
          type: "ref",
          description: "paid from",
          ref: { table: "accounts", target: "entity" },
        },
      ],
      together: [["category", "amount"]],
      duplicate_keys: [["date", "category", "amount"]],
    },
    {
      name: "accounts",
      kind: "base",
      description: "an account over time",
      time: { type: "state", granularity: "date" },
      fields: [
        { name: "name", type: "text", required: true, description: "its name" },
        { name: "limit", type: "integer", description: "its limit", max: 1000 },
      ],
      entity_key: ["name"],
    },
    {
      name: "settings",
      kind: "base",
      description: "timeless",
      time: { type: "none" },
      fields: [{ name: "key", type: "text", required: true, description: "a key" }],
    },
  ],
};

let s: ReusableStore;
let minute = 0;
const ctx = (
  o: { actor?: string; visibility?: unknown; task?: string; trigger?: "flushReads" } = {},
) =>
  createOpsContext({
    tenant: TENANT,
    actor: o.trigger !== undefined ? "system" : (o.actor ?? USER),
    trigger: o.trigger ?? null,
    task: o.task ?? null,
    visibility: o.visibility ?? { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T03:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
const c = (params: unknown, o: Parameters<typeof ctx>[0] = {}) =>
  catalog(s.store, ctx(o), params) as unknown as Promise<Record<string, unknown>>;
async function refused(params: unknown, o: Parameters<typeof ctx>[0] = {}) {
  try {
    await catalog(s.store, ctx(o), params);
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { code: x.code, ...(x.detail ?? {}) };
  }
  throw new Error("not refused");
}

beforeAll(async () => {
  s = await openReusable("saveslot-catalog-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  readBufferOf(s.store).take();
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

describe("list", () => {
  it("lists the visible slots and their tables in document order", async () => {
    expect(await c({})).toEqual({
      level: "list",
      total: 3,
      slots: [
        {
          slot: "ledger",
          slot_id: SLOT,
          sv: 1,
          timezone: "Asia/Shanghai",
          tables: [
            { table: "expenses", kind: "base", description: "one row per expense" },
            { table: "accounts", kind: "base", description: "an account over time" },
            { table: "settings", kind: "base", description: "timeless" },
          ],
        },
      ],
    });
  });

  it("pages by table, and filters by slot", async () => {
    const p1 = await c({ limit: 2 });
    const p2 = await c({ limit: 2, position: p1["next_position"] });
    const tables = (r: Record<string, unknown>) =>
      (r["slots"] as { tables: { table: string }[] }[]).flatMap((x) =>
        x.tables.map((t) => t.table),
      );
    expect([...tables(p1), ...tables(p2)]).toEqual(["expenses", "accounts", "settings"]);
    expect(p2).not.toHaveProperty("next_position");
    expect((await c({ slot: "LEDGER" }))["total"]).toBe(3);
    expect(await refused({ slot: "health" })).toEqual({
      code: "not_found",
      reason: "slot",
      param: "slot",
    });
  });

  it("shows nothing out of the visible range", async () => {
    const other = { kind: "scoped", slots: [{ slot: `sl_${"9".repeat(16)}` }] };
    expect(await c({}, { visibility: other })).toEqual({ level: "list", total: 0, slots: [] });
    expect(await refused({ slot: "ledger" }, { visibility: other })).toEqual({
      code: "not_found",
      reason: "slot",
      param: "slot",
    });
  });
});

describe("table", () => {
  it("gives each table's definition, names for IDs", async () => {
    const r = await c({ level: "table", tables: ["expenses", "ledger.Accounts"] });
    expect(r).toEqual({
      level: "table",
      tables: [
        {
          table: "expenses",
          slot: "ledger",
          sv: 1,
          timezone: "Asia/Shanghai",
          kind: "base",
          description: "one row per expense",
          time: { type: "event", field: "date" },
          duplicate_keys: [["date", "category", "amount"]],
          together: [["category", "amount"]],
          fields: [
            { name: "date", type: "date", description: "the day", required: true },
            { name: "category", type: "enum", description: "kind", values: ["food", "rent"] },
            {
              name: "amount",
              type: "quantity",
              description: "how much",
              required: true,
              unit: "CNY",
              min: "0",
              precision: { scale: 2, rounding: "half_up" },
            },
            {
              name: "rate",
              type: "decimal",
              description: "a rate",
              precision: { scale: 4, rounding: "half_even" },
            },
            {
              name: "account",
              type: "ref",
              description: "paid from",
              ref: { table: "accounts", target: "entity" },
            },
          ],
        },
        {
          table: "accounts",
          slot: "ledger",
          sv: 1,
          timezone: "Asia/Shanghai",
          kind: "base",
          description: "an account over time",
          time: { type: "state", granularity: "date" },
          entity_key: ["name"],
          fields: [
            { name: "name", type: "text", description: "its name", required: true },
            { name: "limit", type: "integer", description: "its limit", max: "1000" },
          ],
        },
      ],
    });
    // Not in this version: profile, examples, size hints; no aliases (the compiler takes none yet).
    for (const t of r["tables"] as Record<string, unknown>[]) {
      expect(t).not.toHaveProperty("profile");
      expect(t).not.toHaveProperty("aliases");
    }
  });

  it.each<[string, unknown, Record<string, unknown>]>([
    [
      "no tables",
      { level: "table" },
      { code: "invalid_argument", reason: "missing", param: "tables" },
    ],
    [
      "an empty list",
      { level: "table", tables: [] },
      { code: "invalid_argument", reason: "malformed", param: "tables" },
    ],
    [
      "eleven tables",
      { level: "table", tables: Array.from({ length: 11 }, () => "expenses") },
      { code: "invalid_argument", reason: "malformed", param: "tables" },
    ],
    [
      "a table twice",
      { level: "table", tables: ["expenses", "EXPENSES"] },
      { code: "invalid_argument", reason: "malformed", param: "tables/1" },
    ],
    [
      "an unknown table",
      { level: "table", tables: ["expense"] },
      {
        code: "unknown_table",
        param: "tables/0",
        name: "expense",
        // By edit distance: expenses 1, settings 6, accounts 7.
        nearest: ["expenses", "settings", "accounts"],
      },
    ],
  ])("refuses %s", async (_, params, error) => {
    expect(await refused(params)).toEqual(error);
  });

  it("refuses a table out of the visible range as one that does not exist", async () => {
    const other = { kind: "scoped", slots: [{ slot: `sl_${"9".repeat(16)}` }] };
    expect(await refused({ level: "table", tables: ["expenses"] }, { visibility: other })).toEqual({
      code: "unknown_table",
      param: "tables/0",
      name: "expenses",
      nearest: [],
    });
  });
});

describe("schema", () => {
  it("gives the document as submitted with IDs and base_version filled, and the policy", async () => {
    const r = await c({ level: "schema", slot: "ledger" });
    expect(r["slot"]).toBe("ledger");
    expect(r["sv"]).toBe(1);
    const doc = r["document"] as {
      base_version: number;
      tables: { id: string; fields: { id: string }[] }[];
    };
    expect(doc.base_version).toBe(1);
    expect(doc.tables.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(doc.tables[0]?.fields.map((f) => f.id)).toEqual(["f1", "f2", "f3", "f4", "f5"]);
    // Nothing else changes: taking the IDs and base_version out gives the document submitted.
    const back = structuredClone(doc) as Record<string, unknown> & {
      tables: Record<string, unknown>[];
    };
    back["base_version"] = null;
    for (const t of back.tables) {
      delete t["id"];
      for (const f of t["fields"] as Record<string, unknown>[]) delete f["id"];
    }
    expect(back).toEqual(DOCUMENT);
    expect(r["policy"]).toEqual({
      slot: "ledger",
      policy_version: 1,
      effective_value_rule: "keep_current",
      rank: { user_stated: 2, agent_inferred: 1, miss: 0 },
      auto_apply: expect.any(Array),
      set_by: expect.objectContaining({ id: USER }),
      set_at: "2026-11-05T00:00:30.000Z",
      seq: expect.any(Number),
    });
  });

  it("refuses draft (not in this version), a missing slot, an unknown one", async () => {
    expect(
      await refused({ level: "schema", slot: "ledger", draft: `d_${"1".repeat(16)}` }),
    ).toEqual({
      code: "not_in_this_version",
      reason: "parameter",
      param: "draft",
    });
    expect(await refused({ level: "schema" })).toEqual({
      code: "invalid_argument",
      reason: "missing",
      param: "slot",
    });
    expect(await refused({ level: "schema", slot: "health" })).toEqual({
      code: "not_found",
      reason: "slot",
      param: "slot",
    });
  });
});

describe("parameters and the read", () => {
  it("refuses an unknown level, a key of another level, an unknown key", async () => {
    expect(await refused({ level: "slots" })).toMatchObject({
      reason: "malformed",
      param: "level",
    });
    expect(await refused({ level: "list", tables: ["expenses"] })).toMatchObject({
      reason: "malformed",
      param: "tables",
    });
    expect(await refused({ detail: "detailed" })).toMatchObject({
      reason: "malformed",
      param: "detail",
    });
  });

  it.each([
    ["parameters that are not an object", ["expenses"], ""],
    ["a slot that is not a name", { slot: 7 }, "slot"],
    ["an empty slot", { slot: "" }, "slot"],
    ["limit 0", { limit: 0 }, "limit"],
    ["limit 201", { limit: 201 }, "limit"],
    ["a fractional limit", { limit: 1.5 }, "limit"],
    ["a limit that is not a number", { limit: "2" }, "limit"],
  ])("refuses %s", async (_, params, param) => {
    expect(await refused(params)).toEqual({ code: "invalid_argument", reason: "malformed", param });
  });

  it("takes limit 200, and refuses a list position given with another slot filter", async () => {
    expect((await c({ limit: 200 }))["total"]).toBe(3);
    const p1 = await c({ limit: 1 });
    expect(await refused({ slot: "ledger", limit: 1, position: p1["next_position"] })).toEqual({
      code: "invalid_argument",
      reason: "malformed",
      param: "position",
    });
  });

  it("records the read: the level and IDs only, the sv read", async () => {
    await c({ level: "table", tables: ["expenses"] }, { actor: OTHER });
    expect(readBufferOf(s.store).take()).toEqual([
      expect.objectContaining({
        actor: OTHER,
        operation: "catalog",
        slot: SLOT,
        sv: 1,
        shape: `{"level":"table","slots":["${SLOT}"],"tables":["t1"]}`,
        rows: [],
        lastRead: [{ kind: "sv", target: SLOT, op: 1, restoreCount: 0 }],
      }),
    ]);
  });

  it("marks a catalog read under the self-check task, by the task alone", async () => {
    await c({ level: "list" }, { actor: OTHER, task: SELFCHECK_TASK });
    await c({ level: "list" }, { task: SELFCHECK_TASK });
    await c({ level: "list", task: SELFCHECK_TASK }, { actor: OTHER });
    const marked = readBufferOf(s.store).take();
    expect(marked.map((e) => [e.actor, e.task, e.selfcheck])).toEqual([
      [OTHER, SELFCHECK_TASK, true],
      [USER, SELFCHECK_TASK, true],
      [OTHER, SELFCHECK_TASK, true],
    ]);
  });

  it("does not mark a catalog read under another task, nor another read under the task", async () => {
    await c({ level: "list" }, { actor: OTHER });
    await c({ level: "list" }, { actor: OTHER, task: `${SELFCHECK_TASK}-2` });
    await c({ level: "list" }, { actor: OTHER, task: SELFCHECK_TASK.toUpperCase() });
    await query(s.store, ctx({ actor: OTHER, task: SELFCHECK_TASK }), { table: "settings" });
    const entries = readBufferOf(s.store).take();
    expect(entries.map((e) => e.operation)).toEqual(["catalog", "catalog", "catalog", "query"]);
    for (const e of entries) expect(e).not.toHaveProperty("selfcheck");
  });

  it.each([false, true])(
    "gives the mark back in reads.list (reads written: %s)",
    async (flushed) => {
      await c({ level: "list" }, { actor: OTHER, task: SELFCHECK_TASK });
      await c({ level: "list" }, { actor: OTHER, task: "other" });
      await query(s.store, ctx({ actor: OTHER, task: SELFCHECK_TASK }), { table: "settings" });
      if (flushed) {
        await flushReads(s.store, ctx({ trigger: "flushReads" }));
        expect(readBufferOf(s.store).size).toBe(0);
      }
      const r = await readsList(s.store, ctx(), { limit: 200 });
      const got = r.reads.map((x) => ({
        operation: x.operation,
        task: x.task,
        selfcheck: Object.hasOwn(x, "selfcheck") ? x.selfcheck : "absent",
      }));
      expect(got).toEqual(
        expect.arrayContaining([
          { operation: "catalog", task: SELFCHECK_TASK, selfcheck: true },
          { operation: "catalog", task: "other", selfcheck: "absent" },
          { operation: "query", task: SELFCHECK_TASK, selfcheck: "absent" },
        ]),
      );
      expect(got).toHaveLength(3);
    },
  );

  it.each(["schema", "table"])(
    "is what a write without sv falls back to (%s level)",
    async (level) => {
      await c(level === "schema" ? { level, slot: "ledger" } : { level, tables: ["settings"] }, {
        actor: OTHER,
      });
      const read = readBufferOf(s.store).entries().at(-1)?.read;
      const r = await write(s.store, ctx({ actor: OTHER }), {
        ops: [{ intent: "insert", table: "settings", set: { key: "a" } }],
      });
      expect(r.warnings).toContainEqual({ code: "sv_fallback", sv: 1, read });
    },
  );
});
