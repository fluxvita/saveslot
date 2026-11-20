// A tenant for the execution fuzz and the derived-table cases of `sql`: the slot `health` of the
// front end's own fixture (runs, expenses, budgets, rooms, shoes and the derived table `weekly`, kernel
// rsql-testing), which the generator of random statements draws its tables and columns from, as a
// slot that is really there, with data. And what no accepted statement may reach, each seeded with a
// marked value (`MARKER_…`): a slot the caller cannot see, rows revoked, a value corrected, the kernel's
// own tables, a table of an older version, decoys named like a table of the slot.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  readBufferOf,
  write,
} from "@fluxvita/saveslot-kernel";
import { derivedSchema, rule } from "@fluxvita/saveslot-kernel/rsql-testing";
import { createSlotEvents, DRAFT, SLOT } from "@fluxvita/saveslot-kernel/testing";
import type { ReusableStore } from "./reusable-store.fixture.ts";

export const TENANT = `tn_${"8".repeat(26)}`;
export const USER = `u_${"1".repeat(26)}`;
export const HEALTH = SLOT;
export const VAULT = `sl_${"6".repeat(16)}`;
export const MARK = "MARKER_";
export const NOW = "2026-11-05T04:00:00.000Z";

type Schema = ReturnType<typeof derivedSchema>;

/** The slot `health`, as a slot of the tenant (a real ID). */
export function healthSchema(): Schema {
  const base = derivedSchema(
    rule(
      "SELECT date_trunc('week', date::timestamp)::date AS week, sum(distance) AS km FROM runs GROUP BY 1",
      ["week", "km"],
      "bucketed",
    ),
  );
  return { ...base, slot: HEALTH } as Schema;
}

const VAULT_SCHEMA = {
  compiler: 1,
  rsql: "rsql@1",
  slot: VAULT,
  name: "vault",
  sv: 1,
  timezone: "UTC",
  tables: [
    {
      id: "t21",
      name: "secrets",
      kind: "base",
      description: "not for the caller",
      time: { type: "none" },
      physical: { table: "t_t21_v1" },
      fields: [{ id: "f1", name: "secret", type: "text", required: true, description: "x" }],
    },
    {
      id: "t22",
      name: "vault_state",
      kind: "base",
      description: "not for the caller",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t22_v1" },
      fields: [{ id: "f1", name: "secret", type: "text", description: "x" }],
    },
  ],
};

const ctxOf = (now: string) =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now,
    confirmation: null,
  });

const changesOf = (c: { tables: readonly { id: string; kind?: string }[] }) =>
  [
    { target: { slot: true }, change: "create_slot" },
    ...c.tables.map((t) => ({
      target: { table: t.id },
      change: t.kind === "derived" ? "add_derived_table" : "add_table",
    })),
  ].map((x) => ({
    ...x,
    class: "create",
    compatible_with_old_writes: true,
    destructive: false,
    auto: true,
  }));

let minute = 0;
const clock = () => {
  minute++;
  return `2026-11-05T03:${String(minute % 60).padStart(2, "0")}:00.000Z`;
};

/** Empties the store and builds the tenant. */
export async function buildHealth(s: ReusableStore): Promise<void> {
  await s.reset();
  readBufferOf(s.store).take();
  minute = 0;
  await createTenant(s.store, ctxOf("2026-11-05T00:00:00.000Z"));
  const create = async (compiled: unknown, vault: boolean) => {
    const base = createSlotEvents({
      compiled: compiled as never,
      changes: changesOf(compiled as never) as never,
    });
    const events = vault
      ? JSON.parse(
          JSON.stringify(base)
            .replaceAll(SLOT, VAULT)
            .replaceAll(DRAFT, `d_${"2".repeat(16)}`)
            .replaceAll('"ledger"', '"vault"'),
        )
      : base;
    await s.store.write(async (tx) => {
      const op = await appendOperation(tx, {
        actor: USER as never,
        now: "2026-11-05T00:00:30.000Z" as never,
        events,
      });
      await applyEvents(tx, eventsOf(op));
    });
  };
  await create(healthSchema(), false);
  await create(VAULT_SCHEMA, true);

  const w = (ops: unknown[]) => write(s.store, ctxOf(clock()), { sv: 1, ops });
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

  const shoeA = target(await w([ins("shoes", { model: "a" })])).row as string;
  const shoeB = target(await w([ins("shoes", { model: "b" })])).row as string;
  const gone = target(await w([ins("shoes", { model: `${MARK}REVOKED_SHOE` })])).row as string;
  await w([{ intent: "revoke", table: "shoes", row: gone }]);
  const run = (set: Record<string, unknown>) =>
    w([
      ins("runs", {
        distance: { value: "5", unit: "km" },
        ...set,
      }),
    ]);
  await run({
    date: "2026-11-01",
    duration: { value: "30", unit: "min" },
    feeling: "good",
    route: "park",
    laps: 3,
    pace: "5.5",
    race: false,
    shoe: shoeA,
  });
  await run({
    date: "2026-11-02",
    distance: { value: "10", unit: "km" },
    feeling: "a, b",
    route: "river",
    laps: 5,
    pace: "6",
    race: true,
    shoe: shoeB,
    started: "2026-11-02T07:00:00+08:00",
  });
  await run({
    date: "2026-11-03",
    feeling: "50%",
    route: "park",
    laps: 0,
    pace: "4.25",
    race: false,
    uphill: { value: "0.5", unit: "mi" },
  });
  await run({ date: "2026-11-08", distance: { value: "7", unit: "km" }, route: "river" });
  const old = target(await run({ date: "2026-11-04", feeling: `${MARK}OLD_VALUE`, laps: 1 }))
    .row as string;
  await w([{ intent: "correct", table: "runs", row: old, set: { feeling: "fixed" } }]);
  const revoked = target(await run({ date: "2026-11-05", feeling: `${MARK}REVOKED`, laps: 99 }))
    .row as string;
  await w([{ intent: "revoke", table: "runs", row: revoked }]);
  await w([
    ins("expenses", {
      date: "2026-11-01",
      category: "food",
      amount: { value: "30", unit: "CNY" },
      note: "lunch",
    }),
  ]);
  await w([
    ins("expenses", {
      date: "2026-11-02",
      category: "rent",
      amount: { value: "1000", unit: "CNY" },
    }),
  ]);
  const budget = (category: string, amount: string, more: Record<string, unknown>) =>
    w([
      {
        intent: "update",
        table: "budgets",
        entity_key: { category },
        set: { amount: { value: amount, unit: "CNY" } },
        ...more,
      },
    ]);
  await budget("food", "100", { valid_from: "2026-11-01" });
  await budget("food", "150", { valid_from: "2026-11-10", valid_to: "2026-11-20" });
  await budget("rent", "800", { valid_from: "2026-10-01", valid_to: "2026-10-15" });
  await w([
    ins(
      "rooms",
      { guest: "ann" },
      { valid_from: "2026-11-01T10:00:00Z", valid_to: "2026-11-06T10:00:00Z" },
    ),
  ]);
  await write(s.store, ctxOf(clock()), {
    sv: 1,
    ops: [ins("secrets", { secret: `${MARK}VAULT_ROW` })],
  });
  await write(s.store, ctxOf(clock()), {
    sv: 1,
    ops: [ins("vault_state", { secret: `${MARK}VAULT_STATE` }, { valid_from: "2026-01-01" })],
  });

  await s.store.write(async (tx) => {
    await tx.exec(
      `INSERT INTO principals (id, kind, name, scopes, slots, state, registered_seq)
         VALUES ('p_${MARK}id', 'user', '${MARK}principal', '${MARK}scopes', NULL, 'active', 1);
       INSERT INTO slots (id, name, timezone, current_sv) VALUES ('sl_${MARK}id', '${MARK}slot', 'UTC', 1);
       CREATE TABLE "t_t1_v0" (row_id text, revoked boolean, f_f4 text);
       INSERT INTO "t_t1_v0" VALUES ('r_${MARK}old', false, '${MARK}OLD_TABLE');
       CREATE TABLE public.runs (row_id text, feeling text);
       INSERT INTO public.runs VALUES ('r_${MARK}decoy', '${MARK}decoy');
       CREATE SCHEMA health;
       CREATE TABLE health.runs (laps int, feeling text);
       INSERT INTO health.runs VALUES (1, '${MARK}decoy_schema')`,
    );
  });
  readBufferOf(s.store).take();
}
