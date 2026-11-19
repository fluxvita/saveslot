// `floz` and `ug` of the unit vocabulary units@1 (03-data-model/10-types-and-units.md «单位词表»,
// «精度与舍入»), deterministic: a write in each unit converts exactly within its dimension and
// rounds at the field's scale; another dimension is refused (`unit_dimension`); a code outside the
// vocabulary is refused with the new codes as candidates (`unit_unknown`).

import type { CompiledSchema } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { unitCandidates, unitCodes, unitOf } from "../schema/index.ts";
import { COMPILED, normalize } from "./requests.fixture.ts";

const quantity = (id: string, name: string, code: string, scale: number) => ({
  id,
  name,
  type: "quantity" as const,
  description: name,
  unit: unitOf(code),
  precision: { scale, rounding: "half_up" as const },
});
const SCHEMA = {
  ...COMPILED,
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
        quantity("f2", "water_ml", "mL", 3),
        quantity("f3", "water_floz", "floz", 4),
        quantity("f4", "dose_mg", "mg", 3),
        quantity("f5", "dose_ug", "ug", 1),
      ],
    },
  ],
} as unknown as CompiledSchema;

const write = (field: string, v: unknown) =>
  normalize(
    { ops: [{ intent: "insert", table: "intake", set: { date: "2026-11-10", [field]: v } }] },
    { compiled: SCHEMA },
  );
const fieldOf = (field: string) =>
  field === "water_ml" ? "f2" : field === "water_floz" ? "f3" : field === "dose_mg" ? "f4" : "f5";
const accepted = (field: string, v: unknown) => {
  const r = write(field, v);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const op = r.request.ops[0];
  if (op === undefined || op.kind !== "write") throw new Error("not a write");
  return { value: op.fields?.[fieldOf(field)]?.value, warnings: r.request.warnings };
};
const refusal = (field: string, v: unknown) => {
  const r = write(field, v);
  if (r.ok || r.error.code !== "validation_failed") throw new Error(JSON.stringify(r));
  return r.error.details;
};

describe("floz and ug in units@1", () => {
  it("floz is the US fluid ounce, exactly 29.5735295625 mL; ug is exactly 1e-6 g", () => {
    expect(unitOf("floz")).toEqual({
      code: "floz",
      dimension: "volume",
      to_base: "0.0295735295625",
    });
    expect(unitOf("ug")).toEqual({ code: "ug", dimension: "mass", to_base: "0.000001" });
    expect(unitCodes()).toEqual(expect.arrayContaining(["floz", "ug"]));
  });

  it("writes and reads each in its own unit, unchanged and without a warning", () => {
    expect(accepted("water_floz", { value: "16", unit: "floz" })).toEqual({
      value: { value: "16", unit: "floz" },
      warnings: [],
    });
    expect(accepted("dose_ug", { value: "400", unit: "ug" })).toEqual({
      value: { value: "400", unit: "ug" },
      warnings: [],
    });
  });

  it("converts floz to mL exactly, rounding at the field's scale (half up)", () => {
    // 16 × 29.5735295625 = 473.176473 exactly: nothing cut off at scale 3.
    expect(accepted("water_ml", { value: "16", unit: "floz" }).value).toEqual({
      value: "473.176",
      unit: "mL",
    });
    // 1 floz = 29.5735295625 mL: the fourth decimal and beyond (5295625) round the third up.
    expect(accepted("water_ml", { value: "1", unit: "floz" })).toEqual({
      value: { value: "29.574", unit: "mL" },
      warnings: [
        {
          code: "unit_converted",
          op: 0,
          field: "water_ml",
          from: { value: "1", unit: "floz" },
          to: { value: "29.574", unit: "mL" },
        },
      ],
    });
  });

  it("converts mL to floz: 500 mL = 16.9070113509… floz, 16.9070 at scale 4", () => {
    expect(accepted("water_floz", { value: "500", unit: "mL" }).value).toEqual({
      value: "16.907",
      unit: "floz",
    });
    // 1 L = 33.8140227018… floz.
    expect(accepted("water_floz", { value: "1", unit: "L" }).value).toEqual({
      value: "33.814",
      unit: "floz",
    });
  });

  it("converts ug to mg and back, rounding half up at the scale", () => {
    expect(accepted("dose_mg", { value: "400", unit: "ug" }).value).toEqual({
      value: "0.4",
      unit: "mg",
    });
    expect(accepted("dose_mg", { value: "5", unit: "ug" }).value).toEqual({
      value: "0.005",
      unit: "mg",
    });
    // 0.4 ug = 0.0004 mg: cut off at scale 3; 0.5 ug = 0.0005 mg: exactly half, away from zero.
    expect(accepted("dose_mg", { value: "0.4", unit: "ug" }).value).toEqual({
      value: "0",
      unit: "mg",
    });
    expect(accepted("dose_mg", { value: "0.5", unit: "ug" }).value).toEqual({
      value: "0.001",
      unit: "mg",
    });
    expect(accepted("dose_ug", { value: "2", unit: "mg" }).value).toEqual({
      value: "2000",
      unit: "ug",
    });
    // 0.0001234 mg = 0.1234 ug: 0.1 at scale 1.
    expect(accepted("dose_ug", { value: "0.0001234", unit: "mg" }).value).toEqual({
      value: "0.1",
      unit: "ug",
    });
    // 1 g = 1,000,000 ug; 1 kg = 1,000,000,000 ug.
    expect(accepted("dose_ug", { value: "1", unit: "kg" }).value).toEqual({
      value: "1000000000",
      unit: "ug",
    });
  });

  it("refuses another dimension: floz and ug are not mass and volume of each other, nor of oz", () => {
    expect(refusal("dose_mg", { value: "1", unit: "floz" })).toEqual([
      { op: 0, table: "ledger.intake", field: "dose_mg", code: "unit_dimension" },
    ]);
    expect(refusal("water_ml", { value: "1", unit: "ug" })).toEqual([
      { op: 0, table: "ledger.intake", field: "water_ml", code: "unit_dimension" },
    ]);
    // The mass ounce is not the fluid ounce.
    expect(refusal("water_floz", { value: "1", unit: "oz" })).toEqual([
      { op: 0, table: "ledger.intake", field: "water_floz", code: "unit_dimension" },
    ]);
    expect(refusal("dose_ug", { value: "1", unit: "mL" })).toEqual([
      { op: 0, table: "ledger.intake", field: "dose_ug", code: "unit_dimension" },
    ]);
  });

  it("unit_unknown lists the new codes as candidates", () => {
    expect(refusal("dose_ug", { value: "1", unit: "mcg" })).toEqual([
      {
        op: 0,
        table: "ledger.intake",
        field: "dose_ug",
        code: "unit_unknown",
        allowed_units: ["ug"],
      },
    ]);
    expect(refusal("water_floz", { value: "1", unit: "fl oz" })).toEqual([
      {
        op: 0,
        table: "ledger.intake",
        field: "water_floz",
        code: "unit_unknown",
        allowed_units: ["floz"],
      },
    ]);
    expect(unitCandidates("UG")).toEqual(["ug"]);
    expect(unitCandidates("FLOZ")).toEqual(["floz"]);
    expect(unitCandidates("µg")).toEqual(["ug"]);
    expect(unitCandidates("μg")).toEqual(["ug"]);
    expect(unitCandidates("microgram")).toEqual(["ug"]);
    expect(unitCandidates("micrograms")).toEqual(["ug"]);
    expect(unitCandidates("fluid ounce")).toEqual(["floz"]);
    expect(unitCandidates("fluid ounces")).toEqual(["floz"]);
    expect(unitCandidates("fl. oz.")).toEqual(["floz"]);
  });
});
