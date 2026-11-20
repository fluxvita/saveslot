// A tenant for the tests of `sql` (11-restricted-sql.md): a visible slot `ledger` with every kind of
// table, and what a `sql` call must never reach, each seeded with a marked value:
//
// - a slot the caller cannot see (`vault`, with an event table and a state table);
// - the kernel's own tables (a principal, a slot row and the events of every write above);
// - rows revoked, and a value that was corrected (its old value stays in the version table);
// - physical tables of an older version of a table, and decoys named like the tables of the slot.
//
// Every marked value begins with `MARKER_`; nothing the caller may see does. Fictional data.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  readBufferOf,
  type Visibility,
  write,
} from "@fluxvita/saveslot-kernel";
import {
  COMPILED_V1,
  createSlotEvents,
  DRAFT,
  SLOT,
  sqlInTx,
} from "@fluxvita/saveslot-kernel/testing";
import type { ReusableStore } from "./reusable-store.fixture.ts";

export const TENANT = `tn_${"8".repeat(26)}`;
export const USER = `u_${"1".repeat(26)}`;
export const LEDGER = SLOT;
export const VAULT = `sl_${"6".repeat(16)}`;
export const MARK = "MARKER_";
/** The time of the calls: 2026-11-05 12:00 in Asia/Shanghai. */
export const NOW = "2026-11-05T04:00:00.000Z";

const km = { code: "km", dimension: "length", to_base: "1000" };

export const LEDGER_SCHEMA = {
  ...COMPILED_V1,
  tables: [
    {
      id: "t1",
      name: "spend",
      kind: "base",
      description: "events by day",
      time: { type: "event", field: "f1" },
      physical: { table: "t_t1_v1" },
      fields: [
        { id: "f1", name: "date", type: "date", required: true, description: "day" },
        { id: "f2", name: "category", type: "enum", description: "kind", values: ["food", "rent"] },
        {
          id: "f3",
          name: "distance",
          type: "quantity",
          description: "how far",
          unit: km,
          precision: { scale: 2, rounding: "half_up" },
        },
        { id: "f4", name: "note", type: "text", description: "free text" },
        { id: "f5", name: "pieces", type: "integer", description: "how many" },
        {
          id: "f6",
          name: "rate",
          type: "decimal",
          description: "a rate",
          precision: { scale: 4, rounding: "half_even" },
        },
        { id: "f7", name: "paid", type: "boolean", description: "settled" },
        { id: "f8", name: "at", type: "zoned_datetime", description: "when" },
      ],
    },
    {
      id: "t2",
      name: "visits",
      kind: "base",
      description: "events by the instant",
      time: { type: "event", field: "f1" },
      physical: { table: "t_t2_v1" },
      fields: [
        { id: "f1", name: "at", type: "zoned_datetime", required: true, description: "when" },
        { id: "f2", name: "who", type: "text", description: "who" },
      ],
    },
    {
      id: "t3",
      name: "budgets",
      kind: "base",
      description: "by the day",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t3_v1" },
      fields: [
        { id: "f1", name: "category", type: "text", required: true, description: "kind" },
        { id: "f2", name: "amount", type: "integer", description: "how much" },
      ],
    },
    {
      id: "t4",
      name: "rooms",
      kind: "base",
      description: "by the instant",
      time: { type: "state", granularity: "instant" },
      physical: { table: "t_t4_v1" },
      fields: [{ id: "f1", name: "guest", type: "text", description: "who" }],
    },
    {
      id: "t5",
      name: "settings",
      kind: "base",
      description: "timeless",
      time: { type: "none" },
      physical: { table: "t_t5_v1" },
      fields: [{ id: "f1", name: "key", type: "text", required: true, description: "a key" }],
    },
    {
      // Fields named like functions and like the physical table's own columns.
      id: "t6",
      name: "odd",
      kind: "base",
      description: "names that are not columns of the caller's",
      time: { type: "none" },
      physical: { table: "t_t6_v1" },
      fields: [
        { id: "f1", name: "to_json", type: "text", description: "a function's name" },
        { id: "f2", name: "concat", type: "text", description: "a function's name" },
        { id: "f3", name: "revoked", type: "text", description: "an internal column's name" },
        { id: "f4", name: "f_f1", type: "text", description: "a physical column's name" },
        { id: "f5", name: "lag", type: "integer", description: "a window function's name" },
      ],
    },
  ],
};

export const VAULT_SCHEMA = {
  ...COMPILED_V1,
  slot: VAULT,
  name: "vault",
  tables: [
    {
      id: "t11",
      name: "secrets",
      kind: "base",
      description: "not for the caller",
      time: { type: "none" },
      physical: { table: "t_t11_v1" },
      fields: [{ id: "f1", name: "secret", type: "text", required: true, description: "x" }],
    },
    {
      id: "t12",
      name: "vault_state",
      kind: "base",
      description: "not for the caller",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t12_v1" },
      fields: [{ id: "f1", name: "secret", type: "text", description: "x" }],
    },
  ],
};

const changesOf = (c: { tables: readonly { id: string }[] }) =>
  [
    { target: { slot: true }, change: "create_slot" },
    ...c.tables.map((t) => ({ target: { table: t.id }, change: "add_table" })),
  ].map((x) => ({
    ...x,
    class: "create",
    compatible_with_old_writes: true,
    destructive: false,
    auto: true,
  }));

const ctxOf = (now: string, actor = USER) =>
  createOpsContext({
    tenant: TENANT,
    actor,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now,
    confirmation: null,
  });

export interface Tenant {
  readonly rows: { r1: string; r2: string; r3: string; entityA: string; entityB: string };
}

let minute = 0;
const clock = () => {
  minute++;
  return `2026-11-05T03:${String(minute % 60).padStart(2, "0")}:00.000Z`;
};

/** Empties the store and builds the tenant: both slots, the data, the decoys. */
export async function buildTenant(s: ReusableStore): Promise<Tenant> {
  await s.reset();
  readBufferOf(s.store).take();
  minute = 0;
  await createTenant(s.store, ctxOf("2026-11-05T00:00:00.000Z"));
  const create = async (compiled: unknown, vault: boolean) => {
    const events = vault
      ? JSON.parse(
          JSON.stringify(
            createSlotEvents({
              compiled: compiled as never,
              changes: changesOf(compiled as never) as never,
            }),
          )
            .replaceAll(SLOT, VAULT)
            .replaceAll(DRAFT, `d_${"2".repeat(16)}`)
            .replaceAll('"ledger"', '"vault"'),
        )
      : createSlotEvents({
          compiled: compiled as never,
          changes: changesOf(compiled as never) as never,
        });
    await s.store.write(async (tx) => {
      const op = await appendOperation(tx, {
        actor: USER as never,
        now: "2026-11-05T00:00:30.000Z" as never,
        events,
      });
      await applyEvents(tx, eventsOf(op));
    });
  };
  await create(LEDGER_SCHEMA, false);
  await create(VAULT_SCHEMA, true);

  const w = (sv: number, ops: unknown[]) => write(s.store, ctxOf(clock()), { sv, ops });
  const ins = (
    table: string,
    set: Record<string, unknown>,
    more: Record<string, unknown> = {},
  ) => ({
    intent: "insert",
    table,
    set,
    ...more,
  });
  const target = (r: Awaited<ReturnType<typeof write>>) =>
    r.ops[0]?.target as { row?: string; entity?: string };
  const r1 = target(
    await w(1, [
      ins("spend", {
        date: "2026-11-01",
        category: "food",
        distance: { value: "1.5", unit: "km" },
        note: "lunch",
        pieces: 2,
        rate: "0.5",
        paid: true,
        at: "2026-11-01T12:00:00+08:00",
      }),
    ]),
  ).row as string;
  const r2 = target(
    await w(1, [
      ins("spend", {
        date: "2026-11-03",
        category: "rent",
        distance: { value: "1200", unit: "m" },
        note: "Café",
        pieces: 1,
      }),
    ]),
  ).row as string;
  const r3 = target(
    await w(1, [
      ins("spend", { date: "2026-11-03", category: "food", distance: { value: "3", unit: "km" } }),
    ]),
  ).row as string;
  // A revoked row, and a corrected value whose old one stays in the version table.
  const gone = target(
    await w(1, [ins("spend", { date: "2026-11-05", category: "food", note: `${MARK}REVOKED` })]),
  ).row as string;
  await w(1, [{ intent: "revoke", table: "spend", row: gone }]);
  const fixed = target(
    await w(1, [ins("spend", { date: "2026-11-04", category: "food", note: `${MARK}OLD_VALUE` })]),
  ).row as string;
  await w(1, [{ intent: "correct", table: "spend", row: fixed, set: { note: "fixed" } }]);

  const entityA = target(
    await w(1, [ins("budgets", { category: "food", amount: 100 }, { valid_from: "2026-11-01" })]),
  ).entity as string;
  await w(1, [
    {
      intent: "update",
      table: "budgets",
      entity: entityA,
      set: { amount: 150 },
      valid_from: "2026-11-10",
      valid_to: "2026-11-20",
    },
  ]);
  const entityB = target(
    await w(1, [
      ins(
        "budgets",
        { category: "rent", amount: 50 },
        { valid_from: "2026-10-01", valid_to: "2026-10-15" },
      ),
    ]),
  ).entity as string;
  await w(1, [
    ins(
      "rooms",
      { guest: "ann" },
      { valid_from: "2026-11-01T10:00:00Z", valid_to: "2026-11-02T10:00:00Z" },
    ),
  ]);
  await w(1, [ins("visits", { at: "2026-11-02T23:30:00+08:00", who: "bo" })]);
  await w(1, [ins("settings", { key: "b" })]);
  await w(1, [ins("settings", { key: "a" })]);
  await w(1, [ins("odd", { to_json: "tj", concat: "cc", revoked: "rv", f_f1: "ff", lag: 7 })]);
  // The slot the caller cannot see.
  await write(s.store, ctxOf(clock()), {
    sv: 1,
    ops: [ins("secrets", { secret: `${MARK}VAULT_ROW` })],
  });
  await write(s.store, ctxOf(clock()), {
    sv: 1,
    ops: [ins("vault_state", { secret: `${MARK}VAULT_STATE` }, { valid_from: "2026-01-01" })],
  });

  // The kernel's own tables and what an older version of a table leaves.
  await s.store.write(async (tx) => {
    await tx.exec(
      `INSERT INTO principals (id, kind, name, scopes, slots, state, registered_seq)
         VALUES ('p_${MARK}id', 'user', '${MARK}principal', '${MARK}scopes', NULL, 'active', 1);
       INSERT INTO slots (id, name, timezone, current_sv) VALUES ('sl_${MARK}id', '${MARK}slot', 'UTC', 1);
       CREATE TABLE "t_t1_v0" (row_id text, revoked boolean, f_f1 date, f_f4 text);
       INSERT INTO "t_t1_v0" VALUES ('r_${MARK}old', false, '2026-11-01', '${MARK}OLD_TABLE');
       CREATE TABLE public.spend (row_id text, note text);
       INSERT INTO public.spend VALUES ('r_${MARK}decoy', '${MARK}decoy');
       CREATE SCHEMA ledger;
       CREATE TABLE ledger.spend (date date, note text);
       INSERT INTO ledger.spend VALUES ('2026-11-01', '${MARK}decoy_schema')`,
    );
  });
  readBufferOf(s.store).take();
  return { rows: { r1, r2, r3, entityA, entityB } };
}

export const LEDGER_ONLY = { kind: "scoped", slots: [{ slot: LEDGER }] } as const;

export interface Run {
  readonly result: Awaited<ReturnType<typeof sqlInTx>>["result"];
  readonly entry: Awaited<ReturnType<typeof sqlInTx>>["entry"];
  /** The statements the call gave the database, in order, with their parameters. */
  readonly statements: readonly { readonly text: string; readonly params: readonly unknown[] }[];
}

let reads = 0;
/** The statements of the latest call, also when it was refused. */
export let lastStatements: { text: string; params: readonly unknown[] }[] = [];
/** The database errors the latest call logged (the kernel's log of what the caller is not told). */
export let lastDatabaseErrors: unknown[] = [];
/** One `sql` call in a read transaction of its own, the statements it makes kept. */
export async function runSql(
  s: ReusableStore,
  params: unknown,
  o: { visibility?: Visibility; now?: string; timeoutMs?: number } = {},
): Promise<Run> {
  const statements: { text: string; params: readonly unknown[] }[] = [];
  lastStatements = statements;
  const logged: unknown[] = [];
  lastDatabaseErrors = logged;
  const out = await s.store.read((tx) =>
    sqlInTx(
      {
        query: (text, p) => {
          statements.push({ text, params: p ?? [] });
          return tx.query(text, p);
        },
      },
      {
        actor: USER as never,
        task: null,
        now: (o.now ?? NOW) as never,
        visibility: o.visibility ?? { kind: "all" },
        params,
        read: `rd_${String(++reads).padStart(16, "0")}` as never,
        onDatabaseError: (e) => logged.push(e),
        ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      },
    ),
  );
  return { ...out, statements };
}

/** What a refused call is: its code and detail. */
export async function refusal(run: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await run;
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown>; message?: string };
    if (x.code === undefined) throw e;
    return { code: x.code, ...(x.detail ?? {}), message: x.message };
  }
  throw new Error("not refused");
}
