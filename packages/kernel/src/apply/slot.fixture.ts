// A hand-written slot for tests of apply (09-event-format §4.5, §5.4, §5.5, §7): the events of the
// operation that creates it, with a compiled definition covering every base field type and every
// time type. Fictional IDs and names.

import type { CompiledSchema, JsonValue } from "@fluxvita/saveslot-contract-core";
import type { NewEvent } from "../log/index.ts";

export const SLOT = `sl_${"4".repeat(16)}` as const;
export const DRAFT = `d_${"1".repeat(16)}` as const;
export const SLOT_NOW = "2026-11-10T03:00:00.000Z";

/** Version 1 of the slot: an event table, two state tables (date, instant), a timeless table. */
export const COMPILED_V1 = {
  compiler: 1,
  rsql: "rsql@1",
  slot: SLOT,
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
  ],
} as const satisfies CompiledSchema;

/** The changes of the first compiled definition: the slot and each table. */
export const CHANGES_V1 = [
  { target: { slot: true }, change: "create_slot" },
  ...COMPILED_V1.tables.map((t) => ({ target: { table: t.id }, change: "add_table" })),
].map((c) => ({
  ...c,
  class: "create",
  compatible_with_old_writes: true,
  destructive: false,
  auto: true,
}));

export const POLICY_V1 = {
  policy_version: 1,
  effective_value_rule: "keep_current",
  rank: { user_stated: 2, agent_inferred: 1, miss: 0 },
  auto_apply: [
    "add_table",
    "add_derived_table",
    "add_optional_field",
    "description",
    "rename_unused",
    "loosen_constraint",
    "duplicate_keys",
    "restructure_unused",
  ],
  high_impact: [],
  user_session_only: [],
};

/**
 * The events of the operation creating the slot (§4.5): submitted, compiled, confirmed by policy,
 * the initial policy, switched. `compiled` replaces the definition (to test what apply refuses).
 */
export function createSlotEvents(
  o: { compiled?: JsonValue; changes?: JsonValue; requestKey?: string } = {},
): NewEvent[] {
  const ctx = { now: SLOT_NOW, today: "2026-11-10", ruleset_version: 1, policy_version: 1 };
  return [
    {
      type: "schema.draft_submitted",
      slot: SLOT,
      blocks: {
        ctx,
        ...(o.requestKey !== undefined ? { request_key: { key: o.requestKey } } : {}),
        target: { draft_id: DRAFT, creates_slot: true },
        draft: { name: "ledger", tables: [{ name: "expenses" }] },
      },
    },
    {
      type: "schema.compiled",
      slot: SLOT,
      blocks: {
        target: { draft_id: DRAFT, target_version: 1, outcome: "applied" },
        compiled: (o.compiled ?? COMPILED_V1) as JsonValue,
        changes: (o.changes ?? CHANGES_V1) as JsonValue,
      },
    },
    {
      type: "schema.confirmed",
      slot: SLOT,
      blocks: { target: { draft_id: DRAFT, target_version: 1, by: "auto" } },
    },
    { type: "slot.policy_set", slot: SLOT, blocks: { policy: POLICY_V1 } },
    {
      type: "schema.switched",
      slot: SLOT,
      blocks: { target: { draft_id: DRAFT, to_version: 1, rebuilt_tables: [] } },
    },
  ];
}
