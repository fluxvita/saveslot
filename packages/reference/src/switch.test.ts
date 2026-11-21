// A schema switch in the reference evaluator, one case for each rule of 07 «确定性转换怎么重放»
// (03-data-model/07-schema-evolution.md; 09-event-format.md §5.5). Fictional data.

import type { BizPoint, FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate.ts";
import { iv } from "./interval.ts";
import type { Evaluation, ItemResult, Op, TableSchema, WriteOp } from "./model.ts";
import { type Conversion, type SwitchSpec, switchEvaluation, switchItem } from "./switch.ts";

const d = (md: string) => `2026-${md}` as BizPoint;
const f = (id: string) => id as FieldId;
const EVENT: TableSchema = { kind: "event", required: ["f1"] };
const STATE: TableSchema = { kind: "state", required: ["f1"] };
const kg = (value: string): FieldValue => ({ value, unit: "kg" }) as FieldValue;
const g = (value: string): FieldValue => ({ value, unit: "g" }) as FieldValue;
const KG_TO_G: Conversion = {
  kind: "number",
  from: { unit: "kg", factor: "1000", scale: 6, rounding: "half_up" },
  to: { unit: "g", factor: "1", scale: 6, rounding: "half_up" },
};
const toScale = (scale: number, rounding: "half_up" | "half_even" = "half_up"): Conversion => ({
  kind: "number",
  from: { scale: 2, rounding: "half_up" },
  to: { scale, rounding },
});
const spec = (schema: TableSchema, o: Partial<SwitchSpec> = {}): SwitchSpec => ({
  op: 90,
  event: 91,
  schema,
  ...o,
});

function put(
  op: number,
  fields: Record<string, FieldValue>,
  o: Partial<Omit<WriteOp, "kind" | "op" | "event" | "fields">> & {
    from?: string;
    to?: string;
  } = {},
): WriteOp {
  const { from, to, ...rest } = o;
  return {
    kind: "write",
    op,
    event: op + 1,
    ...(from !== undefined
      ? {
          valid: {
            from: { mode: "given", value: d(from) },
            to: to === undefined ? { mode: "open" } : { mode: "given", value: d(to) },
          },
        }
      : {}),
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, value]) => [k, { value, sources: [`S${op}`] }]),
    ),
    ...rest,
  };
}
const statuses = (ev: Evaluation) => ev.items.map((x) => [x.event, x.target, x.status]);
const values = (ev: Evaluation, field: string) =>
  ev.items.filter((x) => x.target === field).map((x) => x.content);

describe("each item of a field becomes an item of the same field in the new version (07)", () => {
  it("a unit of the same dimension: values converted exactly; statuses, intervals, registrations kept", () => {
    const ops: Op[] = [
      put(10, { f1: "a", f2: kg("4.9") }, { from: "01-01" }),
      put(20, { f2: kg("5.1") }, { from: "02-01" }),
    ];
    const before = evaluate(STATE, ops);
    const { evaluation: after } = switchEvaluation(
      before,
      spec(STATE, { conversions: { [f("f2")]: KG_TO_G } }),
    );
    expect(values(after, "f2")).toEqual([
      { kind: "value", value: g("4900") },
      { kind: "value", value: g("5100") },
    ]);
    expect(statuses(after)).toEqual(statuses(before));
    expect(after.items.map((x) => [x.valid, x.registrations])).toEqual(
      before.items.map((x) => [x.valid, x.registrations]),
    );
    expect(after.fields[f("f2")]?.map((s) => s.value)).toEqual([g("4900"), g("5100")]);
    expect(after.gaps).toEqual(before.gaps);
  });

  it("a precision: rounded to the new scale by the new rounding, half_up and half_even", () => {
    const one = (value: string, c: Conversion) =>
      switchEvaluation(
        evaluate(EVENT, [put(10, { f1: "a", f2: value })]),
        spec(EVENT, { conversions: { [f("f2")]: c } }),
      ).evaluation.fields[f("f2")]?.[0]?.value;
    expect(one("5.4", toScale(0))).toBe("5");
    expect(one("5.5", toScale(0))).toBe("6");
    expect(one("-5.5", toScale(0))).toBe("-6");
    expect(one("4.5", toScale(0, "half_even"))).toBe("4");
    expect(one("5.5", toScale(0, "half_even"))).toBe("6");
    expect(one("0.13", toScale(1))).toBe("0.1");
  });

  it("only a value is converted: an explicit null, no_value and uncovered are carried as they are", () => {
    const item = (content: ItemResult["content"]): ItemResult => ({
      event: 11,
      target: f("f2"),
      k: 0,
      op: 10,
      status: "applied",
      valid: [iv(null)],
      content,
      registrations: [],
    });
    const s = spec(EVENT, { conversions: { [f("f2")]: KG_TO_G } });
    for (const content of [
      { kind: "value", value: null },
      { kind: "noValue" },
      { kind: "uncovered" },
    ] as const) {
      expect(switchItem(item(content), s)).toEqual(item(content));
    }
    // Existence items are not a field's.
    const revoke: ItemResult = { ...item({ kind: "revoke" }), target: "existence" };
    expect(switchItem(revoke, s)).toBe(revoke);
  });

  it("a candidate stays a candidate, its value converted", () => {
    const ops: Op[] = [
      put(10, { f1: "a", f2: kg("1") }),
      // A different value written on a version seen before the first: a candidate.
      put(20, { f2: kg("2") }, { seen: 9 }),
    ];
    const before = evaluate(EVENT, ops);
    expect(statuses(before)).toContainEqual([21, "f2", "candidate"]);
    const { evaluation: after } = switchEvaluation(
      before,
      spec(EVENT, { conversions: { [f("f2")]: KG_TO_G } }),
    );
    expect(statuses(after)).toEqual(statuses(before));
    expect(values(after, "f2")).toEqual([
      { kind: "value", value: g("1000") },
      { kind: "value", value: g("2000") },
    ]);
  });

  it("two values equal once converted: no status changes (the old operations are not judged again)", () => {
    const ops: Op[] = [put(10, { f1: "a", f2: "4.94" }), put(20, { f2: "4.91" }, { seen: 9 })];
    const before = evaluate(EVENT, ops);
    const { evaluation: after } = switchEvaluation(
      before,
      spec(EVENT, { conversions: { [f("f2")]: toScale(1) } }),
    );
    expect(values(after, "f2")).toEqual([
      { kind: "value", value: "4.9" },
      { kind: "value", value: "4.9" },
    ]);
    expect(statuses(after)).toEqual(statuses(before));
  });

  it("a field dropped: its items and segments go; the other fields and existence stay", () => {
    const before = evaluate(EVENT, [put(10, { f1: "a", f2: "x" })]);
    const { evaluation: after } = switchEvaluation(
      before,
      spec(EVENT, { conversions: { [f("f2")]: { kind: "drop" } } }),
    );
    expect(after.items.map((x) => x.target)).toEqual(["f1"]);
    expect(Object.keys(after.fields)).toEqual(["f1"]);
    expect(after.exists).toBe(true);
  });
});

describe("a constant backfill: only where the row or entity exists and the field is broken (07)", () => {
  const required = { [f("f3")]: { required: true } };

  it("an event row: a field added required gets the constant, the switch's own item", () => {
    const { evaluation, backfilled } = switchEvaluation(
      evaluate(EVENT, [put(10, { f1: "a" })]),
      spec(EVENT, { constraints: required, backfill: { [f("f3")]: "none" } }),
    );
    expect(backfilled).toEqual({ f3: [iv(null)] });
    expect(evaluation.items.filter((x) => x.target === "f3")).toEqual([
      {
        event: 91,
        target: "f3",
        k: 0,
        op: 90,
        status: "applied",
        valid: [iv(null)],
        content: { kind: "value", value: "none" },
        registrations: [],
      },
    ]);
    expect(evaluation.fields[f("f3")]).toEqual([
      { valid: [iv(null)], value: "none", by: { event: 91, target: "f3", k: 0 } },
    ]);
  });

  it("an explicit null on a field made required is broken too; a revoked row gets nothing", () => {
    const filled = switchEvaluation(
      evaluate(EVENT, [put(10, { f1: "a", f3: null })]),
      spec(EVENT, { constraints: required, backfill: { [f("f3")]: "none" } }),
    );
    expect(filled.backfilled).toEqual({ f3: [iv(null)] });
    const revoked = evaluate(EVENT, [put(10, { f1: "a" }), { kind: "revoke", op: 20, event: 21 }]);
    expect(revoked.exists).toBe(false);
    const none = switchEvaluation(
      revoked,
      spec(EVENT, { constraints: required, backfill: { [f("f3")]: "none" } }),
    );
    expect(none.backfilled).toEqual({});
    expect(none.evaluation.items.some((x) => x.target === "f3")).toBe(false);
  });

  it("a state entity: only the stretches it exists in with no value; not where it does not exist", () => {
    // The entity exists 01-01 to 03-01 (its required f1); f3 has a value 02-01 on.
    const ev = evaluate(STATE, [
      put(10, { f1: "a" }, { from: "01-01", to: "03-01" }),
      put(20, { f3: "x" }, { from: "02-01" }),
    ]);
    const { backfilled, evaluation } = switchEvaluation(
      ev,
      spec(STATE, { constraints: required, backfill: { [f("f3")]: "none" } }),
    );
    expect(backfilled).toEqual({ f3: [iv(d("01-01"), d("02-01"))] });
    expect(evaluation.fields[f("f3")]?.map((s) => [s.valid, s.value])).toEqual([
      [[iv(d("02-01"), d("03-01"))], "x"],
      [[iv(d("01-01"), d("02-01"))], "none"],
    ]);
  });

  it("a bound tightened with a constant: a value breaking it, converted first, gets the constant", () => {
    // kg to g with max 5000 g: 4.9 kg is 4900 g, kept; 5.1 kg is 5100 g, replaced.
    const run = (value: string) =>
      switchEvaluation(
        evaluate(EVENT, [put(10, { f1: "a", f2: kg(value) })]),
        spec(EVENT, {
          conversions: { [f("f2")]: KG_TO_G },
          constraints: { [f("f2")]: { max: "5000" } },
          backfill: { [f("f2")]: g("0") },
        }),
      );
    expect(run("4.9").backfilled).toEqual({});
    expect(run("4.9").evaluation.fields[f("f2")]?.[0]?.value).toEqual(g("4900"));
    expect(run("5.1").backfilled).toEqual({ f2: [iv(null)] });
    expect(run("5.1").evaluation.fields[f("f2")]?.map((s) => s.value)).toEqual([g("0")]);
    // An enum value taken away.
    const e = switchEvaluation(
      evaluate(EVENT, [put(10, { f1: "a", f2: "gone" })]),
      spec(EVENT, {
        constraints: { [f("f2")]: { values: ["kept"] } },
        backfill: { [f("f2")]: "kept" },
      }),
    );
    expect(e.backfilled).toEqual({ f2: [iv(null)] });
  });
});
