// `type_mismatch`'s example written back on PGlite (04-contract-types §9 `ValidationDetail.example`):
// for each field type, the example a wrong value is refused with is a value the field takes. The
// bounds include ones with more places than the scale, which the example must round within. A
// ref's example is of the right kind of ID; its target is the caller's to name, so it is not here.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  readBufferOf,
} from "@fluxvita/saveslot-kernel";
import { COMPILED_V1, createSlotEvents, writeInTx } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 60_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const KM = { code: "km", dimension: "length", to_base: "1000" };
const FIELDS = [
  { id: "f1", name: "text", type: "text" },
  { id: "f2", name: "kind", type: "enum", values: ["b", "a"] },
  { id: "f3", name: "flag", type: "boolean" },
  { id: "f4", name: "day", type: "date" },
  { id: "f5", name: "at", type: "zoned_datetime" },
  { id: "f6", name: "count", type: "integer", min: "5", max: "9" },
  { id: "f7", name: "rate", type: "decimal", precision: { scale: 2, rounding: "half_even" } },
  {
    id: "f8",
    name: "low",
    type: "decimal",
    min: "0.005",
    precision: { scale: 2, rounding: "half_even" },
  },
  {
    id: "f9",
    name: "high",
    type: "decimal",
    max: "0.999",
    precision: { scale: 2, rounding: "half_up" },
  },
  {
    id: "f10",
    name: "length",
    type: "quantity",
    unit: KM,
    min: "0.0004",
    precision: { scale: 3, rounding: "half_even" },
  },
].map((f) => ({ ...f, description: f.name }));
const COMPILED = {
  ...COMPILED_V1,
  tables: [
    {
      id: "t1",
      name: "things",
      kind: "base",
      description: "things",
      time: { type: "none" },
      physical: { table: "t_t1_v1" },
      fields: FIELDS,
    },
  ],
};
const CHANGES = [
  { target: { slot: true }, change: "create_slot" },
  { target: { table: "t1" }, change: "add_table" },
].map((c) => ({
  ...c,
  class: "create",
  compatible_with_old_writes: true,
  destructive: false,
  auto: true,
}));

let s: ReusableStore;
let minute = 0;
let ids = 0;
const now = () => {
  minute++;
  return `2026-11-05T0${Math.floor(minute / 60) % 10}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
};
const newId = (kind: "row" | "entity" | "source" | "item" | "partition") => {
  ids++;
  const n = String(ids).padStart(kind === "row" || kind === "entity" ? 26 : 16, "0");
  return `${{ row: "r_", entity: "e_", source: "s_", item: "pi_", partition: "p_" }[kind]}${n}`;
};

async function insert(set: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return (await s.store.write((tx) =>
      writeInTx(tx, {
        actor: USER as never,
        task: null,
        now: now(),
        windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
        visibility: { kind: "all" },
        params: { sv: 1, ops: [{ intent: "insert", table: "things", set }] },
        newId,
        reads: readBufferOf(s.store),
      }),
    )) as never;
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { refused: x.code, ...(x.detail ?? {}) };
  }
}

beforeAll(async () => {
  s = await openReusable("saveslot-write-example-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  readBufferOf(s.store).take();
  ids = 0;
  const ctx = createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_key_window: 86_400_000,
    idempotency_window: 600_000,
    now: "2026-11-05T00:00:00.000Z",
    confirmation: null,
  });
  await createTenant(s.store, ctx);
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-05T00:00:30.000Z" as never,
      events: createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }),
    });
    await applyEvents(tx, eventsOf(op));
  });
}, T);

describe("the example a type_mismatch gives is taken by its field", () => {
  it.each(FIELDS.map((f) => [f.name, f.type]))(
    "%s (%s)",
    async (name) => {
      const refused = await insert({ [name]: [] });
      const details = refused["details"] as { field: string; code: string; example?: unknown }[];
      expect(details).toHaveLength(1);
      expect(details[0]).toMatchObject({ field: name, code: "type_mismatch" });
      const example = details[0]?.example;
      expect(example).toBeDefined();
      const r = await insert({ [name]: example });
      expect(r["refused"], JSON.stringify(r)).toBeUndefined();
      expect(
        (r["ops"] as { fields: Record<string, { result: string }> }[])[0]?.fields[name],
      ).toMatchObject({
        result: "applied",
      });
    },
    T,
  );
});
