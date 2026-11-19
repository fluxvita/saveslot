// Slots for the `sql` front end tests (./sql.ts): the slot of ./rules.fixture.ts with one derived
// table in it, and a second slot (a ledger in another time zone) that has a table of the same name.
// Fictional names. What a caller can see is given as `visibleSlots()` gives it: only the tables it
// can see are in `tables`.

import type { CompiledSchema, CompiledTable } from "@fluxvita/saveslot-contract-core";
import { derivedSchema, rule, TABLES, UNITS } from "./rules.fixture.ts";
import { checkSql, type SqlError, type SqlOutcome, type SqlSlot } from "./sql.ts";

let schema: CompiledSchema | undefined;

/** The slot `health`: runs, expenses, budgets, rooms, shoes and the derived table `weekly`. */
export function healthSchema(): CompiledSchema {
  schema ??= derivedSchema(
    rule(
      "SELECT date_trunc('week', date::timestamp)::date AS week, sum(distance) AS km FROM runs GROUP BY 1",
      ["week", "km"],
      "bucketed",
    ),
  );
  return schema;
}

export const LEDGER_TABLES: readonly CompiledTable[] = [
  {
    id: "t1",
    name: "expenses",
    kind: "base",
    description: "one expense per row",
    time: { type: "event", field: "f1" },
    physical: { table: "t_t1_v1" },
    fields: [
      { id: "f1", name: "date", type: "date", required: true, description: "the day" },
      {
        id: "f2",
        name: "amount",
        type: "quantity",
        required: true,
        description: "how much",
        unit: UNITS.CNY,
        precision: { scale: 2, rounding: "half_up" },
      },
    ],
  },
  {
    id: "t2",
    name: "accounts",
    kind: "base",
    description: "timeless",
    time: { type: "none" },
    physical: { table: "t_t2_v1" },
    fields: [{ id: "f1", name: "owner", type: "text", required: true, description: "who" }],
  },
];

export const health = (over: Partial<SqlSlot> = {}): SqlSlot => ({
  slot: "sl_health",
  name: "health",
  timezone: "Asia/Shanghai",
  sv: 3,
  tables: healthSchema().tables,
  ...over,
});

export const ledger = (over: Partial<SqlSlot> = {}): SqlSlot => ({
  slot: "sl_ledger",
  name: "ledger",
  timezone: "Europe/London",
  sv: 7,
  tables: LEDGER_TABLES,
  ...over,
});

/** `health` with its own tables only (no derived table). */
export const baseTables = TABLES;

/** The outcome of a query as one string: `ok`, or `<code>/<reason>`. */
export function outcome(r: SqlOutcome): string {
  return r.ok ? "ok" : `${r.error.code}/${r.error.reason}`;
}

/** Checks a query over `slots` (the health slot alone when none are given). */
export function check(
  sql: string,
  params: readonly unknown[] = [],
  slots: readonly SqlSlot[] = [health()],
): SqlOutcome {
  return checkSql({ sql, params, slots, context: "S" });
}

/** The refusal of a query, or a thrown error when it is accepted. */
export function refusal(
  sql: string,
  params: readonly unknown[] = [],
  slots?: readonly SqlSlot[],
): SqlError {
  const r = check(sql, params, slots);
  if (r.ok) throw new Error(`accepted: ${sql}`);
  return r.error;
}
