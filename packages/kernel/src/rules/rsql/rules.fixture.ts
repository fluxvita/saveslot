// A slot for the restricted SQL tests: tables of every time type covering every base field type,
// already given IDs as the schema compiler would. Fictional names.

import type { CompiledBaseTable } from "@fluxvita/saveslot-contract-core";
import type { DerivedRuleInput } from "./derived.ts";

const KM = { code: "km", dimension: "length", to_base: "1000" } as const;
const MI = { code: "mi", dimension: "length", to_base: "1609.344" } as const;
const MIN = { code: "min", dimension: "duration", to_base: "60" } as const;
const CNY = { code: "CNY", dimension: "currency:CNY" } as const;
export const UNITS = { KM, MI, MIN, CNY } as const;

/** runs (event, by date), expenses (event), budgets (state by date), rooms (state by instant), settings (timeless). */
export const TABLES: readonly CompiledBaseTable[] = [
  {
    id: "t1",
    name: "runs",
    kind: "base",
    description: "one run per row",
    time: { type: "event", field: "f1" },
    physical: { table: "t_t1_v1" },
    fields: [
      { id: "f1", name: "date", type: "date", required: true, description: "the day" },
      {
        id: "f2",
        name: "distance",
        type: "quantity",
        required: true,
        description: "how far",
        unit: KM,
        precision: { scale: 2, rounding: "half_up" },
      },
      {
        id: "f3",
        name: "duration",
        type: "quantity",
        description: "how long",
        unit: MIN,
        precision: { scale: 1, rounding: "half_even" },
      },
      { id: "f4", name: "feeling", type: "text", description: "in the user's words" },
      { id: "f5", name: "route", type: "enum", description: "where", values: ["park", "river"] },
      { id: "f6", name: "laps", type: "integer", description: "laps run" },
      {
        id: "f7",
        name: "pace",
        type: "decimal",
        description: "min per km",
        precision: { scale: 3, rounding: "half_up" },
      },
      { id: "f8", name: "started", type: "zoned_datetime", description: "start" },
      {
        id: "f9",
        name: "shoe",
        type: "ref",
        description: "which shoe",
        ref: { table: "t5", target: "row" },
      },
      { id: "f10", name: "race", type: "boolean", description: "a race" },
      {
        id: "f11",
        name: "uphill",
        type: "quantity",
        description: "climb",
        unit: MI,
        precision: { scale: 2, rounding: "half_up" },
      },
    ],
  },
  {
    id: "t2",
    name: "expenses",
    kind: "base",
    description: "one expense per row",
    time: { type: "event", field: "f1" },
    physical: { table: "t_t2_v1" },
    fields: [
      { id: "f1", name: "date", type: "date", required: true, description: "the day" },
      { id: "f2", name: "category", type: "text", required: true, description: "kind" },
      {
        id: "f3",
        name: "amount",
        type: "quantity",
        required: true,
        description: "how much",
        unit: CNY,
        precision: { scale: 2, rounding: "half_up" },
      },
      { id: "f4", name: "note", type: "text", description: "free text" },
    ],
  },
  {
    id: "t3",
    name: "budgets",
    kind: "base",
    description: "a budget over time",
    time: { type: "state", granularity: "date" },
    physical: { table: "t_t3_v1" },
    fields: [
      { id: "f1", name: "category", type: "text", required: true, description: "kind" },
      {
        id: "f2",
        name: "amount",
        type: "quantity",
        required: true,
        description: "monthly",
        unit: CNY,
        precision: { scale: 2, rounding: "half_up" },
      },
    ],
    entity_key: ["f1"],
  },
  {
    id: "t4",
    name: "rooms",
    kind: "base",
    description: "occupancy",
    time: { type: "state", granularity: "instant" },
    physical: { table: "t_t4_v1" },
    fields: [{ id: "f1", name: "guest", type: "text", description: "who" }],
  },
  {
    id: "t5",
    name: "shoes",
    kind: "base",
    description: "timeless",
    time: { type: "none" },
    physical: { table: "t_t5_v1" },
    fields: [{ id: "f1", name: "model", type: "text", required: true, description: "model" }],
  },
];

/** A rule over the slot, with every output column declared as a field in order. */
export function rule(
  sql: string,
  fields: readonly (string | DerivedRuleInput["fields"][number])[],
  timeDependency: DerivedRuleInput["declaredTimeDependency"] = "none",
  more: Partial<DerivedRuleInput> = {},
): DerivedRuleInput {
  return {
    sql,
    declaredTimeDependency: timeDependency,
    fields: fields.map((f) => (typeof f === "string" ? { name: f } : f)),
    slot: { name: "health" },
    tables: TABLES,
    derivedTables: ["weekly"],
    path: "tables/5/rule/sql",
    ...more,
  };
}
