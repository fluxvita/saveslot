import { describe, expect, it } from "vitest";
import {
  type Context,
  matchAll,
  matchValue,
  parsePath,
  resolvePath,
  sameQuantity,
} from "./match.ts";

const ctx = (bound: Record<string, unknown> = {}, extra: Partial<Context> = {}): Context => ({
  bound: (n) => bound[n],
  ...extra,
});

describe("paths", () => {
  it("reads names, indexes, any element and quoted keys", () => {
    expect(parsePath("ops[0].set.distance")).toEqual(["ops", 0, "set", "distance"]);
    expect(parsePath('ops[0].fields["*"].result')).toEqual(["ops", 0, "fields", "*", "result"]);
    expect(parsePath("ops[*].intent")[1]).not.toBe("*");
    expect(() => parsePath("ops[x]")).toThrow();
  });

  it("[*] gives every element; a key named * is just that key", () => {
    const x = { ops: [{ i: "a" }, { i: "b" }], f: { "*": { r: 1 } } };
    expect(resolvePath(x, "ops[*].i").map((f) => f.value)).toEqual(["a", "b"]);
    expect(resolvePath(x, 'f["*"].r').map((f) => f.value)).toEqual([1]);
  });
});

describe("matchers of §2.5", () => {
  it("scalars: numbers and numeric strings by value; bound names", () => {
    expect(matchValue("5", 5, ctx())).toBe(true);
    expect(matchValue("5.0", 5, ctx())).toBe(true);
    expect(matchValue("x", "y", ctx())).toBe(false);
    expect(matchValue("r_1", "$row", ctx({ row: "r_1" }))).toBe(true);
    expect(() => matchValue("r_1", "$nothing", ctx())).toThrow(/nothing bound/);
  });

  it("present, absent, in, contains, codes, has and lacks", () => {
    const x = { a: 1, w: [{ code: "x" }], marks: { corrected: true } };
    expect(matchAll(x, { a: { present: true }, b: { absent: true } }, ctx())).toBe(true);
    expect(matchAll(x, { b: { in: [{ absent: true }, 2] } }, ctx())).toBe(true);
    expect(matchAll(x, { a: { in: [2, 3] } }, ctx())).toBe(false);
    expect(matchValue("今天 5 公里", { contains: "5 公里" }, ctx())).toBe(true);
    expect(matchAll(x, { w: { has_code: "x" }, missing: { lacks_code: "x" } }, ctx())).toBe(true);
    expect(matchAll(x, { marks: { has: ["corrected"] } }, ctx())).toBe(true);
    expect(matchAll({}, { marks: { lacks: ["disputed"] } }, ctx())).toBe(true);
  });

  it("quantities convert lengths and take a tolerance", () => {
    expect(sameQuantity({ value: "5", unit: "km" }, { value: 5000, unit: "m" })).toBe(true);
    expect(sameQuantity({ value: "3", unit: "mi" }, { value: 4.828032, unit: "km" })).toBe(true);
    expect(sameQuantity({ value: "4.83", unit: "km" }, { value: 3, unit: "mi" })).toBe(false);
    expect(
      sameQuantity({ value: "4.83", unit: "km" }, { value: 4.83, unit: "km", within: 0.01 }),
    ).toBe(true);
    expect(
      sameQuantity({ value: "4.85", unit: "km" }, { value: 4.83, unit: "km", within: 0.01 }),
    ).toBe(false);
    expect(sameQuantity({ value: "32", unit: "CNY" }, { value: 32, unit: "USD" })).toBe(false);
  });

  it("from_read asks for the latest read of the holder's target", () => {
    const op = { row: "r_1", ver: "v2" };
    const c = ctx(
      {},
      { latestRead: (h) => ((h as { row: string }).row === "r_1" ? "v2" : undefined) },
    );
    expect(matchAll({ ops: [op] }, { "ops[0].ver": { from_read: true } }, c)).toBe(true);
    expect(
      matchAll({ ops: [{ ...op, ver: "v1" }] }, { "ops[0].ver": { from_read: true } }, c),
    ).toBe(false);
  });

  it("an object expects its paths; an array, its elements in order", () => {
    expect(matchValue({ a: { b: 1 }, c: 2 }, { "a.b": 1 }, ctx())).toBe(true);
    expect(matchValue(["*"], ["*"], ctx())).toBe(true);
    expect(matchValue(["a", "b"], ["a"], ctx())).toBe(false);
  });
});

describe("matchers added for the P1 variants", () => {
  it("not, every, comparisons", () => {
    expect(matchAll({}, { "error.code": { not: "confirmation_mismatch" } }, ctx())).toBe(true);
    expect(
      matchAll(
        { error: { code: "confirmation_mismatch" } },
        { "error.code": { not: "confirmation_mismatch" } },
        ctx(),
      ),
    ).toBe(false);
    expect(matchValue([{ r: "a" }, { r: "a" }], { every: { r: "a" } }, ctx())).toBe(true);
    expect(matchValue([{ r: "a" }, { r: "b" }], { every: { r: "a" } }, ctx())).toBe(false);
    expect(matchValue([], { every: { r: "a" } }, ctx())).toBe(false);
    expect(matchValue("2026-11-12", { gt: "2026-11-10" }, ctx())).toBe(true);
    expect(matchValue("2026-11-10", { gt: "2026-11-10" }, ctx())).toBe(false);
    expect(matchValue("open", { gt: "2026-11-10" }, ctx())).toBe(false);
    expect(matchValue(3, { lte: "3" }, ctx())).toBe(true);
  });

  it("written_in_step asks the run", () => {
    const c = ctx({}, { writtenInStep: (v) => v === "pi_1" });
    expect(matchAll({ id: "pi_1" }, { id: { written_in_step: true } }, c)).toBe(true);
    expect(matchAll({ id: "pi_2" }, { id: { written_in_step: true } }, c)).toBe(false);
    expect(() => matchAll({ id: "pi_1" }, { id: { written_in_step: true } }, ctx())).toThrow();
  });
});
