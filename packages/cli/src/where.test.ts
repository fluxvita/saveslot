// `--where` and `--where-json` (06-cli §4.7): the shorthand's grammar, the values by the field's
// type, the usage errors with where they are; the spec's own example among the cases.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEXTS } from "./texts.ts";
import { UsageError } from "./usage.ts";
import { canonicalDecimal, type FieldInfo, parseCondition, parseConditionsJson } from "./where.ts";

const FIELDS: ReadonlyMap<string, FieldInfo> = new Map<string, FieldInfo>([
  ["distance", { type: "quantity", unit: "km" }],
  ["count", { type: "integer" }],
  ["price", { type: "decimal" }],
  ["done", { type: "boolean" }],
  ["date", { type: "date" }],
  ["note", { type: "text" }],
  ["at", { type: "zoned_datetime" }],
]);
const parse = (s: string) => parseCondition(s, FIELDS, 1);
const refused = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof UsageError) return e.text;
    throw e;
  }
  throw new Error("not refused");
};

describe("the spec's examples", () => {
  const spec = readFileSync(new URL("../../../docs/zh-CN/spec/06-cli.md", import.meta.url), "utf8");
  const examples = [...spec.matchAll(/--where '([^']+)'/g)].map((m) => m[1] as string);

  it("every --where of 06 parses into the condition it means", () => {
    expect(examples).toEqual(["distance>5km"]);
    expect(parse("distance>5km")).toEqual({
      field: "distance",
      op: ">",
      value: { value: "5", unit: "km" },
    });
  });
});

describe("the shorthand", () => {
  it.each([
    ["count = 3", { field: "count", op: "=", value: "3" }],
    ["count<=3", { field: "count", op: "<=", value: "3" }],
    ["count >= 3", { field: "count", op: ">=", value: "3" }],
    ["count!=3", { field: "count", op: "!=", value: "3" }],
    ["count<3", { field: "count", op: "<", value: "3" }],
    ["distance > 5.2 km", { field: "distance", op: ">", value: { value: "5.2", unit: "km" } }],
    ["date>=2026-11-01", { field: "date", op: ">=", value: "2026-11-01" }],
    ["note = two words ", { field: "note", op: "=", value: "two words" }],
    ['note = " kept "', { field: "note", op: "=", value: " kept " }],
    ['note = "a\\"b"', { field: "note", op: "=", value: 'a"b' }],
    ["done = true", { field: "done", op: "=", value: true }],
    [
      "at > 2026-11-10T12:31:00+08:00[Asia/Shanghai]",
      { field: "at", op: ">", value: "2026-11-10T12:31:00+08:00[Asia/Shanghai]" },
    ],
    ["unknown_field=x", { field: "unknown_field", op: "=", value: "x" }],
    ["valid_from>=2026-11-01", { field: "valid_from", op: ">=", value: "2026-11-01" }],
  ])("%s", (text, condition) => {
    expect(parse(text)).toEqual(condition);
  });

  it("integers and decimals as canonical decimal text, of any size", () => {
    expect(parse("count=007").value).toBe("7");
    expect(parse("count=5.0").value).toBe("5");
    expect(parse("count=-0").value).toBe("0");
    expect(parse("price=+1.50").value).toBe("1.5");
    expect(parse("count=123456789012345678901234567890").value).toBe(
      "123456789012345678901234567890",
    );
    expect(canonicalDecimal("-0012.3400")).toBe("-12.34");
  });

  it("a field name as the spec allows one: at most 63, a letter first", () => {
    const long = `a${"b".repeat(62)}`;
    expect(parse(`${long}=1`).field).toBe(long);
    // Sixty-four characters: the name ends at 63, and what follows is no operator.
    expect(refused(() => parse(`${long}c=1`))).toBe(TEXTS.whereNoOperator(1, 64));
    expect(refused(() => parse("1abc=1"))).toBe(TEXTS.whereNoField(1));
  });

  it.each([
    ["distance>5", TEXTS.whereUnitMissing(1)],
    ["count=three", TEXTS.whereNotNumber(1)],
    ["distance>far", TEXTS.whereNotNumber(1)],
    ["done=yes", TEXTS.whereNotBoolean(1)],
    ["count=", TEXTS.whereNoValue(1)],
    ['note="unclosed', TEXTS.whereBadString(1)],
    ["note in a,b", TEXTS.whereNoOperator(1, 5)],
    ["note contains x", TEXTS.whereNoOperator(1, 5)],
    ["note is null", TEXTS.whereNoOperator(1, 5)],
    ["= 3", TEXTS.whereNoField(1)],
  ])("%s: a usage error saying where", (text, said) => {
    expect(refused(() => parse(text))).toBe(said);
  });

  it("which --where it is, counted from 1", () => {
    expect(refused(() => parseCondition("count=x", FIELDS, 3))).toBe(TEXTS.whereNotNumber(3));
  });
});

describe("--where-json", () => {
  it("one object or an array of them, as written, in order", () => {
    expect(
      parseConditionsJson([
        '{"field":"note","op":"contains","value":"x"}',
        '[{"field":"note","op":"is_null","value":true},{"field":"n","op":"in","value":[1,2]}]',
      ]),
    ).toEqual([
      { field: "note", op: "contains", value: "x" },
      { field: "note", op: "is_null", value: true },
      { field: "n", op: "in", value: [1, 2] },
    ]);
  });

  it.each([["not json"], ["3"], ['"x"'], ["[1]"], ["[[]]"], ["null"]])("%s: refused", (text) => {
    expect(refused(() => parseConditionsJson(["{}", text]))).toBe(TEXTS.whereJsonBad(2));
  });
});
