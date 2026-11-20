// `schema_draft` creating a slot (04-contract §10 `schema_draft`; 04-contract-types §5.3) through
// the ops entry: the slot is created in one operation and query, write and catalog use it; the
// receipt; replays and explicit idempotency keys; a slot with a derived table, refreshed by writes
// and read with its input marks; every refusal of this version.

import {
  catalog,
  createOpsContext,
  createTenant,
  DEFAULT_SLOT_POLICY,
  query,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { POLICY_V1 } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

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
        { name: "note", type: "text", description: "what for" },
      ],
    },
    {
      name: "budgets",
      kind: "base",
      description: "by the day",
      time: { type: "state", granularity: "date" },
      fields: [{ name: "amount", type: "integer", required: true, description: "how much" }],
    },
  ],
};

let s: ReusableStore;
let minute = 0;
const ctx = (o: { visibility?: unknown; task?: string } = {}) =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: o.task ?? null,
    visibility: (o.visibility ?? { kind: "all" }) as never,
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T03:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
const draft = (params: unknown, o: Parameters<typeof ctx>[0] = {}) =>
  schemaDraft(s.store, ctx(o), params);
async function refused(params: unknown, o: Parameters<typeof ctx>[0] = {}) {
  try {
    await draft(params, o);
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { code: x.code, ...(x.detail ?? {}) };
  }
  throw new Error("not refused");
}
const slotCount = async () =>
  Number(
    (await s.store.read((tx) => tx.query<{ n: unknown }>("SELECT count(*) AS n FROM slots")))
      .rows[0]?.n,
  );

beforeAll(async () => {
  s = await openReusable("saveslot-schema-draft-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
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
}, T);

describe("creating a slot", () => {
  it(
    "creates it at once: the receipt, then query, write and catalog use it",
    async () => {
      const r = await draft({ document: structuredClone(DOCUMENT) });
      expect(r).toMatchObject({
        slot: "ledger",
        target_sv: 1,
        outcome: "applied",
        sv: 1,
        impact: { rows_affected: 0, derived_changed: [], consumers: [] },
        changes: [
          expect.objectContaining({ target: { slot: true }, change: "create_slot", auto: true }),
          expect.objectContaining({ target: { table: "expenses" }, change: "add_table" }),
          expect.objectContaining({ target: { table: "budgets" }, change: "add_table" }),
        ],
      });
      expect(r.slot_id).toMatch(/^sl_[0-9A-HJKMNP-TV-Z]{16}$/);
      expect(r.draft).toMatch(/^d_[0-9A-HJKMNP-TV-Z]{16}$/);
      expect(r).not.toHaveProperty("replayed");
      expect(r).not.toHaveProperty("warnings");
      // The document as submitted, with IDs and base_version filled in.
      const doc = r.document as { base_version: number; tables: { id: string }[] };
      expect(doc.base_version).toBe(1);
      expect(doc.tables.map((t) => t.id)).toEqual(["t1", "t2"]);

      const w = await write(s.store, ctx(), {
        sv: 1,
        ops: [{ intent: "insert", table: "expenses", set: { date: "2026-11-02", note: "tea" } }],
      });
      expect(w.status).toBe("saved");
      const q = await query(s.store, ctx(), { table: "expenses" });
      expect(q.rows.map((x) => x.values)).toEqual([{ date: "2026-11-02", note: "tea" }]);
      const c = (await catalog(s.store, ctx(), {})) as unknown as {
        slots: { slot: string; sv: number }[];
      };
      expect(c.slots.map((x) => [x.slot, x.sv])).toEqual([["ledger", 1]]);
    },
    T,
  );

  it(
    "writes the default policy of the spec into the slot's policy event",
    async () => {
      // The fixture's policy (apply cannot import schema) is the same text.
      expect(POLICY_V1).toEqual(DEFAULT_SLOT_POLICY);
      const r = await draft({ document: structuredClone(DOCUMENT) });
      const body = await s.store.read((tx) =>
        tx.query<{ body: string }>(
          `SELECT c.body FROM events e JOIN content c ON c.seq = e.seq AND c.path = 'policy'
           WHERE e.type = 'slot.policy_set' AND e.slot = $1`,
          [r.slot_id],
        ),
      );
      expect(JSON.parse(body.rows[0]?.body ?? "null")).toEqual(DEFAULT_SLOT_POLICY);
    },
    T,
  );

  it(
    "gives a second slot the tenant's next table numbers",
    async () => {
      await draft({ document: structuredClone(DOCUMENT) });
      const r = await draft({ document: { ...structuredClone(DOCUMENT), slot: "health" } });
      expect((r.document as { tables: { id: string }[] }).tables.map((t) => t.id)).toEqual([
        "t3",
        "t4",
      ]);
      expect(await slotCount()).toBe(2);
    },
    T,
  );
});

/** The document with a derived table over expenses: notes a day. */
const WITH_DERIVED = {
  ...structuredClone(DOCUMENT),
  tables: [
    ...structuredClone(DOCUMENT).tables,
    {
      name: "totals",
      kind: "derived",
      description: "notes a day",
      fields: [
        { name: "date", description: "the day" },
        { name: "n", description: "how many" },
      ],
      rule: {
        sql: "SELECT date, count(note) AS n FROM expenses GROUP BY date",
        time_dependency: "bucketed",
      },
    },
  ],
};

describe("a slot with a derived table", () => {
  it(
    "is created with it; a write refreshes it, its receipt gives the change; query reads it with input marks",
    async () => {
      const r = await draft({ document: structuredClone(WITH_DERIVED) });
      expect(r).toMatchObject({ slot: "ledger", outcome: "applied", sv: 1 });
      expect(r.changes).toContainEqual(
        expect.objectContaining({ target: { table: "totals" }, change: "add_derived_table" }),
      );
      const empty = await query(s.store, ctx(), { table: "totals" });
      expect(empty.rows).toEqual([]);

      const w = (await write(s.store, ctx(), {
        sv: 1,
        ops: [{ intent: "insert", table: "expenses", set: { date: "2026-11-02", note: "tea" } }],
      })) as unknown as { status: string; derived: unknown[]; derived_total: number };
      expect(w.status).toBe("saved");
      expect(w.derived).toEqual([
        {
          table: "ledger.totals",
          key: { date: "2026-11-02" },
          field: "n",
          before: null,
          after: "1",
        },
      ]);
      expect(w.derived_total).toBe(1);
      await write(s.store, ctx(), {
        sv: 1,
        ops: [{ intent: "insert", table: "expenses", set: { date: "2026-11-02", note: "bun" } }],
      });
      const q = await query(s.store, ctx(), { table: "totals" });
      expect(q.rows.map((x) => [x.key, x.values, x.input_marks])).toEqual([
        [
          { date: "2026-11-02" },
          { date: "2026-11-02", n: "2" },
          { disputed: 0, awaiting: 0, flagged: 0, premise_changed: 0, items: [] },
        ],
      ]);
    },
    T,
  );

  it(
    "replays the same request: the same receipt, no second slot",
    async () => {
      const first = await draft({ document: structuredClone(WITH_DERIVED) });
      const again = await draft({ document: structuredClone(WITH_DERIVED) });
      const { replayed, ...rest } = again;
      expect(replayed).toBe(true);
      expect(rest).toEqual(first);
      expect(await slotCount()).toBe(1);
    },
    T,
  );

  /** The document with expenses carrying a decimal and a zoned date-time, and one derived rule. */
  const ruled = (sql: string, fields: string[], time_dependency: string) => ({
    ...structuredClone(DOCUMENT),
    tables: [
      {
        ...structuredClone(DOCUMENT).tables[0],
        fields: [
          ...(structuredClone(DOCUMENT).tables[0]?.fields ?? []),
          { name: "price", type: "decimal", description: "how much" },
          { name: "paid_at", type: "zoned_datetime", description: "when paid" },
        ],
      },
      structuredClone(DOCUMENT).tables[1],
      {
        name: "summary",
        kind: "derived",
        description: "a summary",
        fields: fields.map((name) => ({ name, description: name })),
        rule: { sql, time_dependency },
      },
    ],
  });

  it.each([
    [
      "depending on today",
      ruled(
        "SELECT count(note) AS n FROM expenses WHERE date > saveslot_today() - 30",
        ["n"],
        "now",
      ),
    ],
    ["reading a state table", ruled("SELECT sum(amount) AS total FROM budgets", ["total"], "now")],
  ])("takes a rule %s: computed when read, the slot is created", async (_, doc) => {
    await draft({ document: doc });
    expect(await slotCount()).toBe(1);
    // No base row yet: the whole aggregate has no input row, so no row.
    expect((await query(s.store, ctx(), { table: "summary" })).rows).toEqual([]);
  });

  it.each([
    [
      "calling saveslot_date",
      ruled(
        "SELECT saveslot_date(paid_at) AS d, count(note) AS n FROM expenses GROUP BY 1",
        ["d", "n"],
        "bucketed",
      ),
    ],
    [
      "with a decimal group key that may have more places than its scale",
      ruled("SELECT price / 2 AS k, count(note) AS n FROM expenses GROUP BY 1", ["k", "n"], "none"),
    ],
  ])("refuses a rule %s: not_in_this_version on the rule, nothing logged", async (_, doc) => {
    expect(await refused({ document: doc })).toEqual({
      code: "not_in_this_version",
      reason: "parameter",
      param: "tables/2/rule",
    });
    const n = await s.store.read((tx) =>
      tx.query<{ n: unknown }>("SELECT count(*) AS n FROM events WHERE type LIKE 'schema.%'"),
    );
    expect(Number(n.rows[0]?.n)).toBe(0);
    expect(await slotCount()).toBe(0);
  });
});

describe("idempotency", () => {
  it(
    "replays the same request: the same receipt, no second slot",
    async () => {
      const first = await draft({ document: structuredClone(DOCUMENT) });
      const again = await draft({ document: structuredClone(DOCUMENT) });
      const { replayed, ...rest } = again;
      expect(replayed).toBe(true);
      expect(rest).toEqual(first);
      expect(await slotCount()).toBe(1);
    },
    T,
  );

  it(
    "an explicit key: the same document replays; another document is refused",
    async () => {
      const first = await draft({ document: structuredClone(DOCUMENT), idempotency_key: "k1" });
      const again = await draft({ document: structuredClone(DOCUMENT), idempotency_key: "k1" });
      expect(again).toMatchObject({ replayed: true, slot_id: first.slot_id, draft: first.draft });
      expect(
        await refused({
          document: { ...structuredClone(DOCUMENT), slot: "health" },
          idempotency_key: "k1",
        }),
      ).toEqual({
        code: "invalid_argument",
        reason: "idempotency_key_reuse",
        param: "idempotency_key",
      });
      expect(await slotCount()).toBe(1);
    },
    T,
  );
});

describe("refusals", () => {
  const keyed = {
    ...structuredClone(DOCUMENT),
    tables: [
      { ...structuredClone(DOCUMENT).tables[0], external_key: ["note"] },
      structuredClone(DOCUMENT).tables[1],
    ],
  };

  it.each([
    [
      "a caller whose range is not every slot",
      { document: DOCUMENT },
      { visibility: { kind: "scoped", slots: [] } },
      { code: "insufficient_scope", required_scope: "all_slots" },
    ],
    [
      "a draft changing a slot not in range (./schema-draft-change.test.ts has the rest)",
      { document: { ...DOCUMENT, base_version: 1 } },
      { visibility: { kind: "scoped", slots: [] } },
      { code: "not_found", reason: "slot", param: "slot" },
    ],
    ["no document", {}, {}, { code: "invalid_argument", reason: "missing", param: "document" }],
    [
      "an unknown key",
      { document: DOCUMENT, mode: "x" },
      {},
      { code: "invalid_argument", reason: "malformed", param: "mode" },
    ],
    [
      "a document that is not an object",
      { document: [] },
      {},
      { code: "invalid_argument", reason: "malformed", param: "" },
    ],
    [
      "a malformed task",
      { document: DOCUMENT, task: "" },
      {},
      { code: "invalid_argument", reason: "malformed", param: "task" },
    ],
  ])("refuses %s", async (_, params, o, error) => {
    expect(await refused(params, o)).toEqual(error);
    expect(await slotCount()).toBe(0);
  });

  it(
    "refuses a document that does not compile, and a slot name in use",
    async () => {
      const bad = structuredClone(DOCUMENT) as { tables: { description?: string }[] };
      delete bad.tables[0]?.description;
      expect(await refused({ document: bad })).toMatchObject({
        code: "validation_failed",
        reason: "schema",
        details: [expect.objectContaining({ code: "description_missing" })],
      });
      await draft({ document: structuredClone(DOCUMENT) });
      expect(
        await refused({ document: { ...structuredClone(DOCUMENT), timezone: "UTC" } }),
      ).toMatchObject({
        code: "validation_failed",
        details: [expect.objectContaining({ code: "duplicate_name" })],
      });
      expect(await slotCount()).toBe(1);
    },
    T,
  );

  it(
    "stops an external key before anything is logged (not applied yet)",
    async () => {
      expect(await refused({ document: keyed })).toEqual({
        code: "internal",
        reason: "not_implemented",
        param: "tables/0/external_key",
      });
      const n = await s.store.read((tx) =>
        tx.query<{ n: unknown }>("SELECT count(*) AS n FROM events WHERE type LIKE 'schema.%'"),
      );
      expect(Number(n.rows[0]?.n)).toBe(0);
    },
    T,
  );
});

describe("warnings", () => {
  it(
    "name the table they are about, not a position in the document (04-contract-types §7 `Warning`)",
    async () => {
      const document = structuredClone(DOCUMENT) as unknown as {
        tables: Record<string, unknown>[];
      };
      document.tables.push({
        name: "notes_by_text",
        kind: "derived",
        description: "expenses by their note",
        rule: {
          sql: "SELECT note AS k, count(*) AS n FROM expenses GROUP BY 1",
          time_dependency: "none",
        },
        fields: [
          { name: "k", description: "the note" },
          { name: "n", description: "how many" },
        ],
      });
      const r = await draft({ document });
      // An external key is not applied in this version, so its warning cannot be reached here.
      expect(r.warnings).toEqual([{ code: "group_key_free_text", table: "notes_by_text" }]);
      // A replay rebuilds them from the compiled schema in the log, as the first receipt gave them.
      const { replayed, ...again } = await draft({ document });
      expect(replayed).toBe(true);
      expect(again.warnings).toEqual(r.warnings);
      expect(again).toEqual(r);
    },
    T,
  );
});
