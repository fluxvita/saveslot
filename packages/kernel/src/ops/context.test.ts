import { describe, expect, it } from "vitest";
import {
  createOpsContext,
  deserializeOpsContext,
  type OpsContext,
  OpsContextError,
  serializeOpsContext,
} from "./context.ts";

const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const CONN = `ci_${"2".repeat(26)}`;
const SLOT_A = `sl_${"4".repeat(16)}`;
const SLOT_B = `sl_${"5".repeat(16)}`;
const NOW = "2026-11-10T04:41:07.123Z";

const base = {
  tenant: TENANT,
  actor: CONN,
  trigger: null,
  task: null,
  visibility: { kind: "all" },
  idempotency_key_window: 86_400_000,
  idempotency_window: 86_400_000,
  now: NOW,
  confirmation: null,
};
const full = {
  ...base,
  task: "weekly review",
  visibility: {
    kind: "scoped",
    slots: [{ slot: SLOT_A, tables: [{ table: "t2" }, { table: "t10" }] }, { slot: SLOT_B }],
  },
  idempotency_key_window: 3_600_000,
  confirmation: { item_op: 42, restore_count: 0, via: "call" },
};
const internal = { ...base, actor: "system", trigger: "expireDeletions" };

const refuse = (input: unknown) => {
  try {
    createOpsContext(input);
  } catch (e) {
    if (e instanceof OpsContextError) return `${e.reason}: ${e.message}`;
    throw e;
  }
  return "accepted";
};

describe("createOpsContext", () => {
  it.each([
    ["a minimal context", base],
    ["every field set", full],
    ["an internal operation", internal],
    ["a user session", { ...base, actor: USER }],
  ])("accepts %s as is", (_, input) => {
    expect(createOpsContext(input)).toEqual(input);
  });

  it("freezes the context deeply", () => {
    const ctx = createOpsContext(full);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.visibility)).toBe(true);
    expect(Object.isFrozen(ctx.confirmation)).toBe(true);
    if (ctx.visibility.kind !== "scoped") throw new Error("scoped expected");
    expect(Object.isFrozen(ctx.visibility.slots[0]?.tables?.[0])).toBe(true);
    expect(() => {
      (ctx as { now: string }).now = "2027-01-01T00:00:00.000Z";
    }).toThrow(TypeError);
  });

  it("does not share objects with the input", () => {
    const input = structuredClone(full);
    const ctx = createOpsContext(input);
    input.visibility.slots.pop();
    expect(ctx).toEqual(full);
  });

  it("refuses field-level visibility as not implemented", () => {
    const v = {
      kind: "scoped",
      slots: [{ slot: SLOT_A, tables: [{ table: "t1", fields: ["f1"] }] }],
    };
    expect(refuse({ ...base, visibility: v })).toBe(
      "not_implemented: ops context: visibility.slots[0].tables[0].fields: field-level visibility is not implemented",
    );
  });

  it.each([
    ["an unknown key", { ...base, slot: SLOT_A }, "context has an unknown key slot"],
    ["a missing key", (({ task: _, ...r }) => r)(base), "context misses task"],
    ["a malformed tenant", { ...base, tenant: "tn_1" }, "tenant is not a tenant ID"],
    ["a malformed actor", { ...base, actor: "root" }, "actor is not a principal"],
    [
      "system without a trigger",
      { ...base, actor: "system" },
      "trigger must name the internal operation when actor is system",
    ],
    [
      "system with an unknown trigger",
      { ...internal, trigger: "compact" },
      "trigger must name the internal operation when actor is system",
    ],
    [
      "a trigger without system",
      { ...base, trigger: "flushReads" },
      "trigger only with actor system",
    ],
    ["a numeric task", { ...base, task: 3 }, "task is not a string or null"],
    [
      "a negative window",
      { ...base, idempotency_window: -1 },
      "idempotency_window is not a non-negative integer",
    ],
    ["a date as now", { ...base, now: "2026-11-10" }, "now is not an instant"],
    [
      "an unknown visibility",
      { ...base, visibility: { kind: "some" } },
      "visibility.kind is unknown",
    ],
    [
      "all with slots",
      { ...base, visibility: { kind: "all", slots: [] } },
      "visibility has an unknown key slots",
    ],
    [
      "unsorted slots",
      { ...base, visibility: { kind: "scoped", slots: [{ slot: SLOT_B }, { slot: SLOT_A }] } },
      "visibility.slots not ascending and unique",
    ],
    [
      "repeated tables",
      {
        ...base,
        visibility: {
          kind: "scoped",
          slots: [{ slot: SLOT_A, tables: [{ table: "t1" }, { table: "t1" }] }],
        },
      },
      "visibility.slots[0].tables not ascending and unique",
    ],
    [
      "a malformed table",
      {
        ...base,
        visibility: { kind: "scoped", slots: [{ slot: SLOT_A, tables: [{ table: "t01" }] }] },
      },
      "visibility.slots[0].tables[0].table is not a table ID",
    ],
    [
      "an unknown via",
      { ...full, confirmation: { ...full.confirmation, via: "mail" } },
      "confirmation.via is unknown",
    ],
    [
      "op 0",
      { ...full, confirmation: { ...full.confirmation, item_op: 0 } },
      "confirmation.item_op is not an operation number",
    ],
  ])("refuses %s", (_, input, message) => {
    expect(refuse(input)).toBe(`invalid: ops context: ${message}`);
  });
});

describe("serialization", () => {
  it.each([
    ["minimal", base],
    ["full", full],
    ["internal", internal],
  ])("round-trips a %s context", (_, input) => {
    const ctx: OpsContext = createOpsContext(input);
    const text = serializeOpsContext(ctx);
    const back = deserializeOpsContext(text);
    expect(back).toEqual(ctx);
    expect(Object.isFrozen(back)).toBe(true);
    expect(serializeOpsContext(back)).toBe(text);
  });

  it("keeps nullable fields as null in the text", () => {
    expect(JSON.parse(serializeOpsContext(createOpsContext(base)))).toEqual(base);
  });

  it("checks what it reads", () => {
    expect(() => deserializeOpsContext("{")).toThrow(OpsContextError);
    expect(() => deserializeOpsContext(JSON.stringify({ ...base, now: 1 }))).toThrow(
      "now is not an instant",
    );
  });
});
