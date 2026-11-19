// `type_mismatch`'s example (04-contract-types §9 `ValidationDetail.example`): a valid value of the
// field's type as `set` takes it, within the field's bounds and in its unit, the same whatever was
// given. Each example is taken by the field it is the example of.

import type { CompiledBaseField } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { exampleOf, normalizeValue } from "./values.ts";

const field = (o: Record<string, unknown>) =>
  ({ id: "f1", name: "x", description: "x", ...o }) as unknown as CompiledBaseField;
const KM = { code: "km", dimension: "length", to_base: "1000" };

describe("the example of each field type", () => {
  it.each<[string, Record<string, unknown>, string, unknown]>([
    ["text", { type: "text" }, "Asia/Shanghai", "text"],
    ["enum: its first value", { type: "enum", values: ["b", "a"] }, "Asia/Shanghai", "b"],
    ["boolean", { type: "boolean" }, "Asia/Shanghai", true],
    ["date", { type: "date" }, "Asia/Shanghai", "2026-11-12"],
    [
      "zoned date-time: named in the slot's zone",
      { type: "zoned_datetime" },
      "America/New_York",
      "2026-11-11T20:30:00-05:00[America/New_York]",
    ],
    [
      "ref to rows",
      { type: "ref", ref: { table: "t2", target: "row" } },
      "UTC",
      `r_${"0".repeat(26)}`,
    ],
    [
      "ref to entities",
      { type: "ref", ref: { table: "t2", target: "entity" } },
      "UTC",
      `e_${"0".repeat(26)}`,
    ],
    ["integer", { type: "integer" }, "UTC", 1],
    ["integer above 1: its min", { type: "integer", min: "5", max: "9" }, "UTC", 5],
    ["integer below 1: its max", { type: "integer", max: "-3" }, "UTC", -3],
    [
      "integer whose bound is past a safe number: as text",
      { type: "integer", min: "9007199254740993" },
      "UTC",
      "9007199254740993",
    ],
    ["decimal", { type: "decimal", precision: { scale: 2, rounding: "half_even" } }, "UTC", "1"],
    [
      "decimal with a max only",
      { type: "decimal", max: "0.5", precision: { scale: 2, rounding: "half_even" } },
      "UTC",
      "0.5",
    ],
    [
      "decimal whose min has more places than its scale: the min taken up to the scale",
      { type: "decimal", min: "0.005", precision: { scale: 2, rounding: "half_even" } },
      "UTC",
      "0.01",
    ],
    [
      "decimal whose max has more places than its scale: the max taken down to the scale",
      { type: "decimal", max: "0.999", precision: { scale: 2, rounding: "half_up" } },
      "UTC",
      "0.99",
    ],
    [
      "decimal with a negative max past its scale: taken down, away from zero",
      { type: "decimal", max: "-0.001", precision: { scale: 2, rounding: "half_up" } },
      "UTC",
      "-0.01",
    ],
    [
      "quantity whose min has more places than its scale",
      { type: "quantity", unit: KM, min: "0.0004", precision: { scale: 3, rounding: "half_even" } },
      "UTC",
      { value: "0.001", unit: "km" },
    ],
    [
      "quantity: in the field's unit, within its bounds",
      { type: "quantity", unit: KM, min: "2", precision: { scale: 3, rounding: "half_even" } },
      "UTC",
      { value: "2", unit: "km" },
    ],
  ])("%s", (_, o, zone, expected) => {
    const f = field(o);
    const example = exampleOf(f, zone);
    expect(example).toEqual(expected);
    // The example is taken by its own field, unchanged.
    const r = normalizeValue(f, example, { op: 0, name: "x", zone, kept: true });
    expect(r.ok).toBe(true);
    // And given with a value of another type, whatever it is.
    for (const wrong of [[], { nope: 1 }]) {
      expect(normalizeValue(f, wrong, { op: 0, name: "x", zone, kept: true })).toMatchObject({
        ok: false,
        detail: { code: "type_mismatch", example: expected },
      });
    }
  });
});

describe("no example where no value fits", () => {
  it("a decimal whose bounds hold no value of its scale: type_mismatch without an example", () => {
    const f = field({
      type: "decimal",
      min: "0.001",
      max: "0.009",
      precision: { scale: 2, rounding: "half_even" },
    });
    expect(exampleOf(f, "UTC")).toBeUndefined();
    expect(normalizeValue(f, [], { op: 0, name: "x", zone: "UTC", kept: true })).toEqual({
      ok: false,
      detail: { op: 0, field: "x", code: "type_mismatch" },
    });
  });
});
