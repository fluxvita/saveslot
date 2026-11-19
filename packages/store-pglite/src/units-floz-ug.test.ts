// `floz` and `ug` end to end on PGlite (03-data-model/10-types-and-units.md «单位词表», «精度与
// 舍入»): a quantity written in each unit, or converted from another unit of its dimension and
// rounded at the field's scale, reads back as the value the field declares; a condition in another
// unit of the dimension converts the same way.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  query,
  readBufferOf,
  write,
} from "@fluxvita/saveslot-kernel";
import { COMPILED_V1, createSlotEvents } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

const unit = (code: string, dimension: string, to_base: string) => ({ code, dimension, to_base });
const quantity = (id: string, name: string, u: ReturnType<typeof unit>, scale: number) => ({
  id,
  name,
  type: "quantity",
  description: name,
  unit: u,
  precision: { scale, rounding: "half_up" },
});
const COMPILED = {
  ...COMPILED_V1,
  tables: [
    {
      id: "t1",
      name: "intake",
      kind: "base",
      description: "one intake per row",
      time: { type: "event", field: "f1" },
      physical: { table: "t_t1_v1" },
      fields: [
        { id: "f1", name: "date", type: "date", required: true, description: "the day" },
        quantity("f2", "water_ml", unit("mL", "volume", "0.001"), 3),
        quantity("f3", "water_floz", unit("floz", "volume", "0.0295735295625"), 4),
        quantity("f4", "dose_mg", unit("mg", "mass", "0.001"), 3),
        quantity("f5", "dose_ug", unit("ug", "mass", "0.000001"), 1),
      ],
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
const NOW = "2026-11-05T04:00:00.000Z";
const clock = () => `2026-11-05T03:${String(++minute % 60).padStart(2, "0")}:00.000Z`;
const ctx = (now: string) =>
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
const put = (set: Record<string, unknown>) =>
  write(s.store, ctx(clock()), { sv: 1, ops: [{ intent: "insert", table: "intake", set }] });
const read = (params: Record<string, unknown>) =>
  query(s.store, ctx(NOW), { table: "intake", ...params });

beforeAll(async () => {
  s = await openReusable("saveslot-units-");
  readBufferOf(s.store).take();
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
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-05T00:00:30.000Z" as never,
      events: createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }),
    });
    await applyEvents(tx, eventsOf(op));
  });
}, T);
afterAll(async () => {
  await s?.close();
}, T);

describe("floz and ug written and read", () => {
  it(
    "each unit is stored as declared, converted and rounded from the others of its dimension",
    async () => {
      // Row 1: the declared units as they are. Row 2: other units of the dimensions.
      await put({
        date: "2026-11-01",
        water_floz: { value: "16", unit: "floz" },
        dose_ug: { value: "400", unit: "ug" },
        water_ml: { value: "250", unit: "mL" },
        dose_mg: { value: "5", unit: "mg" },
      });
      const second = await put({
        date: "2026-11-02",
        water_ml: { value: "1", unit: "floz" },
        water_floz: { value: "500", unit: "mL" },
        dose_mg: { value: "0.5", unit: "ug" },
        dose_ug: { value: "2", unit: "mg" },
      });
      expect(
        (second.warnings ?? []).map((w) => (w as { code: string; field: string }).field),
      ).toEqual(["water_ml", "water_floz", "dose_mg", "dose_ug"]);

      const rows = await read({ order: [{ field: "date", dir: "asc" }] });
      expect(rows.rows.map((r) => r.values)).toEqual([
        {
          date: "2026-11-01",
          water_ml: { value: "250", unit: "mL" },
          water_floz: { value: "16", unit: "floz" },
          dose_mg: { value: "5", unit: "mg" },
          dose_ug: { value: "400", unit: "ug" },
        },
        {
          date: "2026-11-02",
          // 1 floz = 29.5735295625 mL, 29.574 at scale 3.
          water_ml: { value: "29.574", unit: "mL" },
          // 500 mL = 16.9070113509... floz, 16.907 at scale 4.
          water_floz: { value: "16.907", unit: "floz" },
          // 0.5 ug = 0.0005 mg, half up at scale 3.
          dose_mg: { value: "0.001", unit: "mg" },
          dose_ug: { value: "2000", unit: "ug" },
        },
      ]);
    },
    T,
  );

  it(
    "a condition in another unit of the dimension converts to the field's",
    async () => {
      const dates = async (field: string, op: string, value: unknown) =>
        (
          await read({ where: [{ field, op, value }], order: [{ field: "date", dir: "asc" }] })
        ).rows.map((r) => r.values["date"]);
      // 8 floz = 236.5882365 mL: row 1 holds 250 mL, row 2 29.574 mL.
      expect(await dates("water_ml", ">", { value: "8", unit: "floz" })).toEqual(["2026-11-01"]);
      expect(await dates("water_floz", ">=", { value: "16", unit: "floz" })).toEqual([
        "2026-11-01",
        "2026-11-02",
      ]);
      // 400 ug = 0.4 mg: strictly above it, only the 5 mg row.
      expect(await dates("dose_mg", ">", { value: "400", unit: "ug" })).toEqual(["2026-11-01"]);
      expect(await dates("dose_ug", "=", { value: "2", unit: "mg" })).toEqual(["2026-11-02"]);
    },
    T,
  );
});
