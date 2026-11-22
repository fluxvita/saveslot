// Removing an empty slot on PGlite (04-contract §17 `slots.remove`; 09 §5.4 `slot.removed`):
// who may, what counts as empty, what storage keeps, and what a connection whose range named the
// slot sees afterwards. Fictional IDs and names.

import {
  applyEvents,
  catalog,
  createOpsContext,
  createTenant,
  issueConnection,
  KERNEL_TABLES,
  listConnections,
  readEvents,
  readTail,
  removeSlot,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore, snapshot } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

const DOCUMENT = {
  slot: "home",
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

let s: ReusableStore;
let minute = 0;
const ctx = (actor: string, visibility: unknown = { kind: "all" }) =>
  createOpsContext({
    tenant: TENANT,
    actor,
    trigger: null,
    task: null,
    visibility: visibility as never,
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T03:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });

// biome-ignore lint/suspicious/noExplicitAny: receipts as the kernel returns them
type Any = any;
const draft = (
  doc: Record<string, unknown> = {},
  actor = USER,
  visibility?: unknown,
): Promise<Any> =>
  schemaDraft(s.store, ctx(actor, visibility), {
    document: { ...structuredClone(DOCUMENT), ...doc },
  });
const remove = (slot_id: unknown, actor = USER): Promise<Any> =>
  removeSlot(s.store, ctx(actor), { slot_id } as never);
/** An error's code and detail, or "accepted". */
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (typeof x.code === "string") return { code: x.code, ...(x.detail ?? {}) };
    throw e;
  }
  return "accepted";
};
const slotNames = async (visibility?: unknown) =>
  ((await catalog(s.store, ctx(USER, visibility), {})) as Any).slots.map((x: Any) => x.slot);
/** The visibility the service builds for a connection from its registered range. */
const visibilityOf = async (id: string) => {
  const c = (await listConnections(s.store, ctx(USER))).connections.find((x) => x.id === id);
  const slots = (c as Any)?.slots as string[] | undefined;
  return slots === undefined
    ? { kind: "all" }
    : { kind: "scoped", slots: slots.map((slot) => ({ slot })) };
};
const writeExpense = (actor: string, visibility: unknown, slot = "home") =>
  write(s.store, ctx(actor, visibility), {
    sv: 1,
    ops: [
      { table: `${slot}.expenses`, intent: "insert", set: { date: "2026-11-01", note: "tea" } },
    ],
  });
const tables = async () =>
  (
    await s.store.read((tx) =>
      tx.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename ~ '^(t|d)_t[0-9]+_v[0-9]+' ORDER BY tablename",
      ),
    )
  ).rows.map((r) => r.tablename);

beforeAll(async () => {
  s = await openReusable("saveslot-slot-remove-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  await createTenant(s.store, ctx(USER));
}, T);

describe("a connection whose range named a removed slot", () => {
  it(
    "sees nothing and cannot write once it is removed, nor sees a slot created later under the same name",
    async () => {
      const home = await draft();
      const conn = await issueConnection(s.store, ctx(USER), {
        name: "laptop",
        via: "token",
        slots: [home.slot_id],
      } as never);
      const range = await visibilityOf(conn.id);
      // Before: the range is that one slot, and the connection sees it.
      expect(range).toEqual({ kind: "scoped", slots: [{ slot: home.slot_id }] });
      expect(await slotNames(range)).toEqual(["home"]);

      const r = await remove(home.slot_id);
      expect(r).toMatchObject({ slot_id: home.slot_id, name: "home", sv: 1 });
      // The range still names the removed slot (apply does not change principals). It is a range
      // with nothing left in it, not "every slot": the connection sees nothing.
      expect(await visibilityOf(conn.id)).toEqual(range);
      expect(await slotNames(range)).toEqual([]);
      // Its write is refused as a write to a table that never existed: nothing is in range.
      const nowhere = await refusal(writeExpense(conn.id, range, "nowhere"));
      expect(nowhere).toMatchObject({ code: "unknown_table" });
      // The same answer but for the name it echoes.
      const asHome = { ...(nowhere as object), name: "home.expenses" };
      expect(await refusal(writeExpense(conn.id, range))).toEqual(asHome);

      // A slot created under the same name is another slot (another ID): the connection does not
      // see it, while a user session does. A changed time zone makes the draft a new request, not a
      // resend of the first (whose request key stays).
      const later = await draft({ timezone: "UTC" });
      expect(later.replayed).toBeUndefined();
      expect(later.slot_id).not.toBe(home.slot_id);
      expect(await slotNames()).toEqual(["home"]);
      expect(await slotNames(range)).toEqual([]);
      expect(await refusal(writeExpense(conn.id, range))).toEqual(asHome);
      expect(((await writeExpense(USER, { kind: "all" })) as Any).status).toBe("saved");
    },
    T,
  );
});

describe("what is refused", () => {
  it(
    "a slot with a record, and the slot stays",
    async () => {
      const home = await draft();
      await writeExpense(USER, { kind: "all" });
      expect(await refusal(remove(home.slot_id))).toMatchObject({
        code: "invalid_argument",
        reason: "slot_not_empty",
        param: "slot_id",
      });
      expect(await slotNames()).toEqual(["home"]);
    },
    T,
  );

  it(
    "a name rather than the ID, an unknown ID, and a caller that is not a user session",
    async () => {
      const home = await draft();
      expect(await refusal(remove("home"))).toMatchObject({
        code: "invalid_argument",
        reason: "malformed",
        param: "slot_id",
      });
      expect(await refusal(remove(`sl_${"9".repeat(16)}`))).toMatchObject({
        code: "not_found",
        reason: "slot",
      });
      const conn = await issueConnection(s.store, ctx(USER), { name: "desk", via: "token" });
      expect(await refusal(remove(home.slot_id, conn.id))).toMatchObject({
        code: "insufficient_scope",
        required_scope: "user_session",
      });
      expect(await slotNames()).toEqual(["home"]);
    },
    T,
  );
});

describe("what removing does", () => {
  it(
    "removing it again returns the first result and appends nothing",
    async () => {
      const home = await draft();
      const r = await remove(home.slot_id);
      const end = await s.store.read(async (tx) => (await readTail(tx))?.seq);
      expect(await remove(home.slot_id)).toEqual(r);
      expect(await s.store.read(async (tx) => (await readTail(tx))?.seq)).toBe(end);
    },
    T,
  );

  it(
    "drops its tables and rows but keeps its versions; table numbers and its ID are not used again",
    async () => {
      const home = await draft();
      expect(await tables()).toEqual([
        "d_t3_v1",
        "t_t1_v1",
        "t_t1_v1__ver",
        "t_t2_v1",
        "t_t2_v1__ver",
      ]);
      await remove(home.slot_id);
      expect(await tables()).toEqual([]);
      const rows = (sql: string) =>
        s.store.read(async (tx) => (await tx.query(sql, [home.slot_id])).rows.length);
      expect(await rows("SELECT 1 FROM slots WHERE id = $1")).toBe(0);
      expect(await rows("SELECT 1 FROM catalog WHERE slot_id = $1")).toBe(0);
      expect(
        await rows(
          "SELECT 1 FROM counts WHERE table_id IN ('t1', 't2', 't3') AND $1::text IS NOT NULL",
        ),
      ).toBe(0);
      expect(await rows("SELECT 1 FROM schema_versions WHERE slot_id = $1")).toBe(1);
      const next = await draft({ timezone: "UTC" });
      expect((next.document as Any).tables.map((t: Any) => t.id)).toEqual(["t4", "t5", "t6"]);
      expect(next.slot_id).not.toBe(home.slot_id);
    },
    T,
  );

  it(
    "twenty removals at once: one slot.removed, the same result for each",
    async () => {
      const home = await draft();
      const results = await Promise.all(Array.from({ length: 20 }, () => remove(home.slot_id)));
      for (const r of results) expect(r).toEqual(results[0]);
      const n = await s.store.read(
        async (tx) =>
          (await tx.query("SELECT 1 FROM events WHERE type = 'slot.removed'")).rows.length,
      );
      expect(n).toBe(1);
    },
    T,
  );

  it(
    "keeps the request key of its creation: sending that draft again returns the first receipt",
    async () => {
      const home = await draft();
      await remove(home.slot_id);
      const resent = await draft();
      expect(resent).toMatchObject({ slot_id: home.slot_id, replayed: true });
      expect(await slotNames()).toEqual([]);
    },
    T,
  );

  it(
    "frees a place under the slot limit",
    async () => {
      const ids: string[] = [];
      for (let i = 1; i <= 100; i++)
        ids.push((await draft({ slot: `s${i}`, tables: [DOCUMENT.tables[0]] })).slot_id);
      expect(await refusal(draft({ slot: "s101", tables: [DOCUMENT.tables[0]] }))).toMatchObject({
        code: "validation_failed",
      });
      await remove(ids[0]);
      expect((await draft({ slot: "s101", tables: [DOCUMENT.tables[0]] })).slot).toBe("s101");
    },
    T,
  );

  it(
    "is rebuilt as it was: the log replayed into an empty storage gives the same state",
    async () => {
      const home = await draft();
      await draft({ slot: "work" });
      await remove(home.slot_id);
      const replica = await openReusable("saveslot-slot-remove-replica-");
      try {
        const last = (await s.store.read(async (tx) => (await readTail(tx))?.seq)) as number;
        const events = await s.store.read((tx) => tx.query("SELECT * FROM events ORDER BY seq"));
        const content = await s.store.read((tx) =>
          tx.query("SELECT * FROM content ORDER BY seq, path"),
        );
        await replica.store.write(async (tx) => {
          const insert = async (table: string, rows: readonly Record<string, unknown>[]) => {
            for (const e of rows) {
              const cols = Object.keys(e);
              await tx.query(
                `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
                Object.values(e) as never,
              );
            }
          };
          await insert("events", events.rows as never);
          await insert("content", content.rows as never);
          await applyEvents(tx, await readEvents(tx, 1, last));
        });
        const kept = new Set(
          KERNEL_TABLES.filter((t) => t.class !== "materialized").map((t) => t.name),
        );
        const state = async (store: typeof s.store) => {
          const all = await store.read(snapshot);
          return Object.fromEntries(Object.entries(all).filter(([name]) => !kept.has(name)));
        };
        expect(await state(replica.store)).toEqual(await state(s.store));
      } finally {
        await replica.close();
      }
    },
    T,
  );
});
