// Edges of normalizeWrite that a mutation run over the module found untested: number grammar and
// limits, integer bounds, time text, ver, evidence, the request key's arrays, the slot of one bare
// table name, a JsonNumber where an integer is expected.

import { describe, expect, it } from "vitest";
import { dateInZone } from "../time/index.ts";
import { resolveWriteSlot } from "./normalize.ts";
import { jsonNumber } from "./number.ts";
import { ENTITY, errorOf, insertExpense, normalize, onlyOp, ROW } from "./requests.fixture.ts";

const upd = (set: Record<string, unknown>, more: Record<string, unknown> = {}) =>
  normalize({ ops: [{ intent: "update", table: "expenses", row: ROW, set, ...more }] });
const run = (set: Record<string, unknown>) =>
  normalize({ ops: [{ intent: "insert", table: "runs", set: { date: "2026-11-10", ...set } }] });
const detailsOf = (r: ReturnType<typeof normalize>) => {
  const e = errorOf(r);
  return e.code === "validation_failed" ? e.details : e;
};

describe("numbers", () => {
  it("checks an integer field's bounds", () => {
    expect(run({ laps: 100 }).ok).toBe(true);
    expect(run({ laps: "0" }).ok).toBe(true);
    expect(detailsOf(run({ laps: 101 }))).toEqual([
      { op: 0, table: "ledger.runs", field: "laps", code: "out_of_range", min: "0", max: "100" },
    ]);
    expect(detailsOf(run({ laps: "-1" }))).toEqual([
      { op: 0, table: "ledger.runs", field: "laps", code: "out_of_range", min: "0", max: "100" },
    ]);
  });

  it("refuses a quantity past 18 integer digits when only a min bounds it", () => {
    expect(detailsOf(upd({ amount: { value: "1e18", unit: "CNY" } }))).toEqual([
      { op: 0, table: "ledger.expenses", field: "amount", code: "out_of_range" },
    ]);
    expect(detailsOf(upd({ amount: { value: "999999999999999999.999", unit: "CNY" } }))).toEqual([
      { op: 0, table: "ledger.expenses", field: "amount", code: "out_of_range" },
    ]);
    expect(upd({ amount: { value: "999999999999999999.994", unit: "CNY" } }).ok).toBe(true);
  });

  it.each<[unknown, string]>([
    [{ value: "01", unit: "CNY" }, "malformed"],
    [{ value: "1e99", unit: "CNY" }, "out_of_range"],
    [{ value: "1", unit: 5 }, "type_mismatch"],
  ])("refuses the quantity %j", (v, code) => {
    expect(detailsOf(upd({ amount: v }))).toEqual([
      {
        op: 0,
        table: "ledger.expenses",
        field: "amount",
        code,
        ...(code === "type_mismatch" ? { example: { value: "0", unit: "CNY" } } : {}),
      },
    ]);
  });

  it("an exponent past 2^53: too large up, a value rounding to zero down", () => {
    expect(detailsOf(upd({ rate: "1e99999999999999999999" }))).toEqual([
      { op: 0, table: "ledger.expenses", field: "rate", code: "out_of_range" },
    ]);
    const tiny = upd({ rate: "1e-99999999999999999999" });
    expect(onlyOp(tiny).fields).toEqual({ f6: { value: "0", raw: "1e-99999999999999999999" } });
    expect(tiny.ok && tiny.request.warnings.map((w) => w.code)).toEqual(["rounded"]);
  });

  it("a plain number with trailing zeros counts its significant digits only", () => {
    expect(onlyOp(upd({ rate: 1234500000000000 })).fields).toEqual({
      f6: { value: "1234500000000000", raw: "1234500000000000" },
    });
  });

  it("enum takes strings only", () => {
    expect(detailsOf(upd({ category: 1 }))).toEqual([
      {
        op: 0,
        table: "ledger.expenses",
        field: "category",
        code: "type_mismatch",
        example: "food",
      },
    ]);
  });

  it.each(["0.5", "1.25", "1e0", "1E10", "-0.07e-3"])("a JsonNumber of %s", (t) => {
    expect(jsonNumber(t).text).toBe(t);
  });

  it("takes JsonNumbers where integers are expected (sv, evidence references, sizes)", () => {
    const r = normalize({
      ...insertExpense(),
      sv: jsonNumber("1"),
      evidence: [
        { kind: "agent_note", text: "a" },
        {
          kind: "file_ref",
          name: "n",
          mime: "m",
          size: jsonNumber("25"),
          sha256: "0".repeat(64),
          origin: "https://x",
        },
      ],
      ops: [
        {
          ...((insertExpense()["ops"] as unknown[])[0] as object),
          evidence_refs: [jsonNumber("0"), jsonNumber("1")],
        },
      ],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.request.sv).toBe(1);
    expect(r.request.ops[0]?.evidenceRefs).toEqual([0, 1]);
    expect(r.request.evidence[1]).toEqual({
      kind: "file_ref",
      name: "n",
      mime: "m",
      size: 25,
      sha256: "0".repeat(64),
      origin: "https://x",
    });
  });

  it("refuses a negative file size", () => {
    expect(
      errorOf(
        normalize({
          ...insertExpense(),
          evidence: [{ kind: "file_ref", name: "n", mime: "m", size: -1, sha256: "0".repeat(64) }],
        }),
      ),
    ).toEqual({
      code: "invalid_argument",
      reason: "malformed",
      param: "evidence/0/size",
    });
  });

  it("takes exactly 256 KB of evidence", () => {
    const seg = (n: number) => ({ kind: "agent_note", text: "a".repeat(n) });
    expect(
      normalize({ ...insertExpense(), evidence: [...Array.from({ length: 8 }, () => seg(32_768))] })
        .ok,
    ).toBe(true);
  });
});

describe("time text", () => {
  it("takes one fractional digit; refuses hour 24, minute 60, a zone on an interval point", () => {
    expect(onlyOp(upd({ at: "2026-11-10T04:31:00.5Z" })).fields).toMatchObject({
      f8: { value: { instant: "2026-11-10T04:31:00.500Z" } },
    });
    expect(detailsOf(upd({ at: "2026-11-10T24:00:00Z" }))).toEqual([
      {
        op: 0,
        table: "ledger.expenses",
        field: "at",
        code: "type_mismatch",
        example: "2026-11-12T09:30:00+08:00[Asia/Shanghai]",
      },
    ]);
    expect(detailsOf(upd({ at: "2026-11-10T12:60:00Z" }))).toEqual([
      {
        op: 0,
        table: "ledger.expenses",
        field: "at",
        code: "type_mismatch",
        example: "2026-11-12T09:30:00+08:00[Asia/Shanghai]",
      },
    ]);
    const r = normalize({
      ops: [
        {
          intent: "update",
          table: "rooms",
          entity: ENTITY,
          set: { guest: "x" },
          valid_from: "2026-11-02T10:00:00+08:00[Asia/Shanghai]",
        },
      ],
    });
    expect(errorOf(r)).toEqual({
      code: "invalid_argument",
      reason: "malformed",
      param: "ops/0/valid_from",
    });
  });

  it("the day of the first instants of year 1 west of UTC is in year 0", () => {
    expect(dateInZone(Date.parse("0001-01-01T00:00:00Z"), "America/New_York")).toBe("0000-12-31");
  });
});

describe("ver and the request key", () => {
  it.each([
    ["v10.0", { op: 10, restoreCount: 0 }],
    ["v1.10", { op: 1, restoreCount: 10 }],
  ])("reads %s", (ver, expected) => {
    expect(onlyOp(upd({ note: "x" }, { ver })).ver).toEqual(expected);
  });

  it("refuses a ver beyond safe integers", () => {
    expect(errorOf(upd({ note: "x" }, { ver: "v99999999999999999.0" }))).toEqual({
      code: "invalid_argument",
      reason: "malformed",
      param: "ops/0/ver",
    });
  });

  it("writes arrays with every comma", () => {
    const r = normalize({
      evidence: [
        { kind: "user_message", text: "a" },
        { kind: "agent_note", text: "b" },
      ],
      ops: [
        { intent: "update", table: "expenses", row: ROW, set: { note: "a" } },
        {
          intent: "update",
          table: "expenses",
          row: ROW,
          set: { note: "b" },
          evidence_refs: [0, 1],
        },
        { intent: "update", table: "expenses", row: ROW, set: { note: "c" } },
      ],
    });
    expect(r.ok && r.request.requestKey.content).toBe(
      `{"evidence":[{"kind":"user_message","text":"a"},{"kind":"agent_note","text":"b"}],"ops":[{"intent":"update","row":"${ROW}","set":{"note":"a"},"table":"expenses"},{"evidence_refs":[0,1],"intent":"update","row":"${ROW}","set":{"note":"b"},"table":"expenses"},{"intent":"update","row":"${ROW}","set":{"note":"c"},"table":"expenses"}]}`,
    );
  });
});

describe("the request's slot", () => {
  it("takes the one slot of a single bare name", () => {
    expect(
      resolveWriteSlot({ ops: [{ table: "runs" }] }, [{ name: "health", tables: ["runs"] }]),
    ).toEqual({
      ok: true,
      slot: "health",
    });
  });

  it("a name starting with a dot has an empty slot part", () => {
    expect(
      errorOf(normalize({ ops: [{ intent: "insert", table: ".expenses", set: {} }] })),
    ).toEqual({
      code: "invalid_argument",
      reason: "cross_slot",
      param: "ops/0/table",
    });
  });
});
