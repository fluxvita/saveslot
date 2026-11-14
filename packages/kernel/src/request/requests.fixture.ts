// A slot for the request tests: the tables of apply's version 1 (every base field type, every time
// type; copied, a fixture of another module cannot be imported) plus `runs` (a convertible unit, a
// bounded quantity) and the derived `weekly`. Fictional names.

import type { CompiledSchema } from "@fluxvita/saveslot-contract-core";
import { normalizeWrite } from "./normalize.ts";
import type { NormalizeWriteInput, NormalizeWriteResult } from "./types.ts";

export const COMPILED: CompiledSchema = {
  compiler: 1,
  rsql: "rsql@1",
  slot: `sl_${"4".repeat(16)}`,
  name: "ledger",
  sv: 1,
  timezone: "Asia/Shanghai",
  tables: [
    {
      id: "t1",
      name: "expenses",
      kind: "base",
      description: "one row per expense",
      aliases: ["spending"],
      time: { type: "event", field: "f1" },
      physical: { table: "t_t1_v1" },
      fields: [
        { id: "f1", name: "date", type: "date", required: true, description: "the day" },
        { id: "f2", name: "category", type: "enum", description: "kind", values: ["food", "rent"] },
        {
          id: "f3",
          name: "amount",
          type: "quantity",
          required: true,
          description: "how much",
          min: "0",
          unit: { code: "CNY", dimension: "currency:CNY" },
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
        {
          id: "f9",
          name: "account",
          type: "ref",
          description: "paid from",
          ref: { table: "t2", target: "entity" },
        },
      ],
      together: [["f2", "f3"]],
      duplicate_keys: [["f1", "f2", "f3"]],
    },
    {
      id: "t2",
      name: "accounts",
      kind: "base",
      description: "an account over time",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t2_v1" },
      fields: [
        { id: "f1", name: "name", type: "text", required: true, description: "its name" },
        { id: "f2", name: "limit", type: "integer", description: "its limit" },
      ],
      entity_key: ["f1"],
    },
    {
      id: "t3",
      name: "rooms",
      kind: "base",
      description: "occupancy by the instant",
      time: { type: "state", granularity: "instant" },
      physical: { table: "t_t3_v1" },
      fields: [{ id: "f1", name: "guest", type: "text", description: "who" }],
    },
    {
      id: "t4",
      name: "settings",
      kind: "base",
      description: "timeless",
      time: { type: "none" },
      physical: { table: "t_t4_v1" },
      fields: [{ id: "f1", name: "key", type: "text", required: true, description: "a key" }],
    },
    {
      id: "t5",
      name: "runs",
      kind: "base",
      description: "one run per row",
      time: { type: "event", field: "f1" },
      physical: { table: "t_t5_v1" },
      fields: [
        { id: "f1", name: "date", type: "date", required: true, description: "the day" },
        {
          id: "f2",
          name: "distance",
          type: "quantity",
          description: "how far",
          aliases: ["mileage"],
          min: "0",
          max: "1000",
          unit: { code: "km", dimension: "length", to_base: "1000" },
          precision: { scale: 2, rounding: "half_up" },
        },
        {
          id: "f3",
          name: "pace",
          type: "decimal",
          description: "min per km",
          min: "-5",
          max: "99.5",
          precision: { scale: 3, rounding: "half_up" },
        },
        { id: "f4", name: "laps", type: "integer", description: "laps", min: "0", max: "100" },
        {
          id: "f5",
          name: "ratio",
          type: "decimal",
          description: "a fine ratio",
          precision: { scale: 12, rounding: "half_up" },
        },
      ],
    },
    {
      id: "t6",
      name: "weekly",
      kind: "derived",
      description: "weekly distance",
      physical: { table: "d_t6_v1" },
      rule: {
        id: "r1",
        version: 1,
        rsql: "rsql@1",
        sql: 'SELECT "t5"."f1" AS "f1", sum("t5"."f2") AS "f2" FROM "t5" GROUP BY 1',
        time_dependency: "bucketed",
        depends_on: [
          { table: "t5", field: "f1" },
          { table: "t5", field: "f2" },
        ],
        scope: { kind: "group", key: ["f1"], key_from_free_text: false },
      },
      fields: [
        { id: "f1", name: "day", type: "date", description: "the day" },
        {
          id: "f2",
          name: "total",
          type: "quantity",
          description: "distance",
          unit: { code: "km", dimension: "length", to_base: "1000" },
          precision: { scale: 2, rounding: "half_up" },
        },
      ],
    },
  ],
} as CompiledSchema;

export const ROW = `r_${"1".repeat(26)}`;
export const ENTITY = `e_${"2".repeat(26)}`;

/** normalizeWrite over the fixture slot at sv 1. */
export function normalize(
  params: unknown,
  more: Partial<Omit<NormalizeWriteInput, "params">> = {},
): NormalizeWriteResult {
  return normalizeWrite({
    params,
    compiled: COMPILED,
    currentSv: 1,
    changedSince: () => new Map(),
    ...more,
  });
}

/** A valid insert into expenses with all required fields. */
export function insertExpense(set: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ops: [
      {
        intent: "insert",
        table: "expenses",
        set: { date: "2026-11-10", amount: { value: "45", unit: "CNY" }, ...set },
      },
    ],
  };
}

/** The request's only op, or throws with the error. */
export function onlyOp(r: NormalizeWriteResult) {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.request.ops[0] as NonNullable<(typeof r.request.ops)[number]>;
}

/** The error of a refused request. */
export function errorOf(r: NormalizeWriteResult) {
  if (r.ok) throw new Error(`accepted: ${JSON.stringify(r.request.ops)}`);
  return r.error;
}
