import type {
  CompiledBaseField,
  CompiledBaseTable,
  CompiledUnit,
  FieldId,
  RestatedBlock,
  Seq,
} from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import {
  convertFieldValue,
  convertItem,
  convertRestated,
  convertResult,
  type FieldMap,
  type ItemIn,
  type ResultIn,
  type TableMap,
  tableMapOf,
  tightenedOf,
} from "./convert.ts";

const M: CompiledUnit = { code: "m", dimension: "length", to_base: "1" };
const KM: CompiledUnit = { code: "km", dimension: "length", to_base: "1000" };
const CM: CompiledUnit = { code: "cm", dimension: "length", to_base: "0.01" };
const P = (scale: number, rounding: "half_up" | "half_even" = "half_up") => ({ scale, rounding });

const f = (id: string, rest: Partial<CompiledBaseField> & Pick<CompiledBaseField, "type">) =>
  ({ id: id as FieldId, name: id, description: id, ...rest }) as CompiledBaseField;
const dist = (unit: CompiledUnit, scale: number, extra = {}) =>
  f("f1", { type: "quantity", unit, precision: P(scale), ...extra } as never);
const table = (...fields: CompiledBaseField[]) =>
  ({
    id: "t1",
    name: "runs",
    description: "runs",
    kind: "base",
    physical: { table: "t_t1_v1" },
    time: { type: "none" },
    fields,
  }) as unknown as CompiledBaseTable;

const note = f("f2", { type: "text" });
const fid = (s: string) => s as FieldId;
const seq = (n: number) => n as Seq;

describe("tableMapOf", () => {
  const cases: {
    name: string;
    from: CompiledBaseField[];
    to: CompiledBaseField[];
    fields: Record<string, FieldMap["op"]>;
    added?: TableMap["added"];
  }[] = [
    {
      name: "nothing changed",
      from: [dist(M, 2), note],
      to: [dist(M, 2), note],
      fields: { f1: "keep", f2: "keep" },
    },
    {
      name: "a field dropped",
      from: [dist(M, 2), note],
      to: [dist(M, 2)],
      fields: { f1: "keep", f2: "drop" },
    },
    {
      name: "an optional field added",
      from: [dist(M, 2)],
      to: [dist(M, 2), note],
      fields: { f1: "keep" },
      added: [{ field: fid("f2") }],
    },
    {
      name: "a required field added, with a constant",
      from: [dist(M, 2)],
      to: [dist(M, 2), f("f2", { type: "text", required: true, backfill: { const: "x" } })],
      fields: { f1: "keep" },
      added: [{ field: fid("f2"), backfill: { const: "x" } }],
    },
    {
      name: "an optional field added, emptied by a null constant",
      from: [dist(M, 2)],
      to: [dist(M, 2), f("f2", { type: "text", backfill: { const: null } })],
      fields: { f1: "keep" },
      added: [{ field: fid("f2"), backfill: { const: null } }],
    },
    { name: "unit changed", from: [dist(M, 2)], to: [dist(KM, 2)], fields: { f1: "convert" } },
    { name: "scale down", from: [dist(M, 2)], to: [dist(M, 0)], fields: { f1: "convert" } },
    { name: "scale up: values stay", from: [dist(M, 2)], to: [dist(M, 4)], fields: { f1: "keep" } },
    {
      name: "rounding changed at the same scale: values stay",
      from: [dist(M, 2)],
      to: [f("f1", { type: "quantity", unit: M, precision: P(2, "half_even") } as never)],
      fields: { f1: "keep" },
    },
    {
      name: "a bound tightened: values stay (violations are the backfill's)",
      from: [dist(M, 2)],
      to: [dist(M, 2, { min: "5" })],
      fields: { f1: "keep" },
    },
    {
      name: "loosened to optional, renamed: values stay",
      from: [dist(M, 2, { required: true })],
      to: [{ ...dist(M, 2), name: "length" }],
      fields: { f1: "keep" },
    },
  ];
  for (const c of cases)
    it(c.name, () => {
      const t = tableMapOf(table(...c.from), table(...c.to));
      expect(Object.fromEntries([...t.fields].map(([k, m]) => [k, m.op]))).toEqual(c.fields);
      expect(t.added).toEqual(c.added ?? []);
    });

  it("a kept field tightened by this switch carries its constant; one an earlier version filled does not", () => {
    const from = table(dist(M, 2), note);
    const to = table(dist(M, 2, { min: "5", backfill: { const: { value: "5", unit: "m" } } }), {
      ...note,
      required: true,
      backfill: { const: "none" },
    } as CompiledBaseField);
    // The switch tightens f1 only: f2's constant came with an earlier version.
    const t = tableMapOf(
      from,
      to,
      tightenedOf(
        [
          { change: "tighten_constraint", target: { table: "t1", field: "f1" } },
          { change: "tighten_constraint", target: { table: "t9", field: "f2" } },
          { change: "rename_field", target: { table: "t1", field: "f2" } },
        ],
        "t1",
      ),
    );
    expect(t.tightened).toEqual([
      { field: fid("f1"), backfill: { const: { value: "5", unit: "m" } } },
    ]);
    expect(t.added).toEqual([]);
    // Without the changes, nothing is filled.
    expect(tableMapOf(from, to).tightened).toEqual([]);
  });

  it("a convert carries both sides' unit and precision", () => {
    const t = tableMapOf(table(dist(M, 2)), table(dist(KM, 3)));
    expect(t.fields.get(fid("f1"))).toEqual({
      op: "convert",
      from: { unit: M, ...P(2) },
      to: { unit: KM, ...P(3) },
    });
  });
});

describe("convertFieldValue", () => {
  const conv = (
    from: CompiledUnit,
    fs: number,
    to: CompiledUnit,
    ts: number,
    r: "half_up" | "half_even" = "half_up",
  ) =>
    ({
      op: "convert",
      from: { unit: from, ...P(fs) },
      to: { unit: to, ...P(ts, r) },
    }) as FieldMap;
  const cases: { name: string; m: FieldMap; v: unknown; out: unknown }[] = [
    {
      name: "m to km",
      m: conv(M, 0, KM, 3),
      v: { value: "7000", unit: "m" },
      out: { ok: true, value: { value: "7", unit: "km" } },
    },
    {
      name: "km to m",
      m: conv(KM, 3, M, 0),
      v: { value: "1.234", unit: "km" },
      out: { ok: true, value: { value: "1234", unit: "m" } },
    },
    {
      name: "m to km, rounded half up",
      m: conv(M, 0, KM, 2),
      v: { value: "1235", unit: "m" },
      out: { ok: true, value: { value: "1.24", unit: "km" } },
    },
    {
      name: "scale down, half even",
      m: conv(M, 1, M, 0, "half_even"),
      v: { value: "2.5", unit: "m" },
      out: { ok: true, value: { value: "2", unit: "m" } },
    },
    {
      name: "scale down, half up",
      m: conv(M, 1, M, 0),
      v: { value: "-2.5", unit: "m" },
      out: { ok: true, value: { value: "-3", unit: "m" } },
    },
    {
      name: "cm to m, to zero",
      m: conv(CM, 0, M, 0),
      v: { value: "40", unit: "cm" },
      out: { ok: true, value: { value: "0", unit: "m" } },
    },
    {
      name: "null is not converted",
      m: conv(M, 0, KM, 3),
      v: null,
      out: { ok: true, value: null },
    },
    {
      name: "keep passes anything",
      m: { op: "keep" },
      v: "1.50",
      out: { ok: true, value: "1.50" },
    },
    {
      name: "past the integer digits after conversion",
      m: conv(KM, 0, CM, 0),
      v: { value: "999999999999999", unit: "km" },
      out: { ok: false, why: "out_of_range" },
    },
    {
      name: "a decimal field (no unit)",
      m: { op: "convert", from: { ...P(3) }, to: { ...P(1) } },
      v: "1.25",
      out: { ok: true, value: "1.3" },
    },
  ];
  for (const c of cases)
    it(c.name, () => expect(convertFieldValue(c.m, c.v as never)).toEqual(c.out));
});

const toKm = tableMapOf(table(dist(M, 0), note), table(dist(KM, 3)));

describe("convertItem", () => {
  const sources = [{ kind: "value", source: seq(3) }] as const;
  const span = { valid: { from: { date: "2026-11-01" } } } as never;
  const cases: { name: string; field: string; x: ItemIn; out: unknown }[] = [
    {
      name: "a value converted; sources and span as they are",
      field: "f1",
      x: { item: { status: "applied", value: { value: "1500", unit: "m" } }, sources, span },
      out: {
        ok: true,
        x: { item: { status: "applied", value: { value: "1.5", unit: "km" } }, sources, span },
      },
    },
    {
      name: "null stays",
      field: "f1",
      x: { item: { status: "applied", value: null }, sources },
      out: { ok: true, x: { item: { status: "applied", value: null }, sources } },
    },
    {
      name: "no_value stays",
      field: "f1",
      x: { item: { status: "applied", no_value: true } },
      out: { ok: true, x: { item: { status: "applied", no_value: true } } },
    },
    {
      name: "uncovered stays",
      field: "f1",
      x: { item: { status: "applied", uncovered: true } },
      out: { ok: true, x: { item: { status: "applied", uncovered: true } } },
    },
    {
      name: "a dropped field's item goes",
      field: "f2",
      x: { item: { status: "applied", value: "hi" }, sources },
      out: { ok: true, x: null },
    },
  ];
  for (const c of cases)
    it(c.name, () => expect(convertItem(toKm, fid(c.field), c.x)).toEqual(c.out));

  it("an item with nothing to change is the same object", () => {
    const x: ItemIn = { item: { status: "applied", value: null } };
    const r = convertItem(toKm, fid("f1"), x);
    expect(r.ok && r.x).toBe(x);
  });
});

describe("convertResult", () => {
  const carried = [{ kind: "value", carried: { event: seq(5), field: fid("f1"), k: 0 } }] as const;
  const r: ResultIn = {
    target: { table: "t1", row: "r1", outcome: "kept_fields_cleared" } as never,
    fields: [
      { field: fid("f1"), j: 0, block: { value: { value: "2000", unit: "m" }, sources: carried } },
      { field: fid("f1"), j: 1, block: { value: null, sources: [] } },
      { field: fid("f2"), j: 0, block: { value: "gone", sources: [] } },
    ],
  };
  it("converts the values, drops a dropped field's stretches, keeps target", () =>
    expect(convertResult(toKm, r)).toEqual({
      ok: true,
      r: {
        target: r.target,
        fields: [
          { field: "f1", j: 0, block: { value: { value: "2", unit: "km" }, sources: carried } },
          { field: "f1", j: 1, block: { value: null, sources: [] } },
        ],
      },
    }));
  it("existence passes as it is", () => {
    const existence = { gaps: [{ to: { date: "2026-11-02" } }], deps: [] } as never;
    const out = convertResult(toKm, { ...r, fields: [], existence });
    expect(out.ok && out.r.existence).toBe(existence);
  });
  it("a value past range is a failure, naming the field", () => {
    const big = tableMapOf(table(dist(KM, 0)), table(dist(CM, 0)));
    expect(
      convertResult(big, {
        target: r.target,
        fields: [
          {
            field: fid("f1"),
            j: 0,
            block: { value: { value: "999999999999999", unit: "km" }, sources: [] },
          },
        ],
      }),
    ).toEqual({ ok: false, field: "f1", why: "out_of_range" });
  });
});

describe("convertRestated", () => {
  const ref = { event: seq(7), k: 0 };
  const cases: { name: string; r: RestatedBlock; out: unknown }[] = [
    {
      name: "a carried value converted",
      r: {
        ...ref,
        field: fid("f1"),
        status: "applied",
        value: { value: "500", unit: "m" },
        sources: [],
      } as never,
      out: {
        ok: true,
        r: {
          ...ref,
          field: "f1",
          status: "applied",
          value: { value: "0.5", unit: "km" },
          sources: [],
        },
      },
    },
    {
      name: "a judgement with no value stays",
      r: { ...ref, field: fid("f1"), status: "dropped" } as never,
      out: { ok: true, r: { ...ref, field: "f1", status: "dropped" } },
    },
    {
      name: "no_value stays",
      r: { ...ref, field: fid("f1"), status: "applied", no_value: true } as never,
      out: { ok: true, r: { ...ref, field: "f1", status: "applied", no_value: true } },
    },
    {
      name: "a dropped field's judgement goes",
      r: { ...ref, field: fid("f2"), status: "applied", value: "x", sources: [] } as never,
      out: { ok: true, r: null },
    },
    {
      name: "an existence judgement stays",
      r: { event: seq(7), existence: 0, status: "applied" } as never,
      out: { ok: true, r: { event: 7, existence: 0, status: "applied" } },
    },
  ];
  for (const c of cases) it(c.name, () => expect(convertRestated(toKm, c.r)).toEqual(c.out));
});
