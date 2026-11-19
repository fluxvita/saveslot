// normalizeWrite on the edges of its input: the caller's objects read by their own keys only, holes
// and `undefined`, text the store cannot hold, time zone names, instants and dates outside
// 0001–9999, offsets, decimal text length, plain numbers, duplicates, file_ref lengths, `nearest`
// with aliases, and raw values of the head event's shape (04-contract §1, §3, §5.1, §14;
// 04-contract-types §9; 09-event-format §1.3; 10 «字段类型与取值范围», «同值判据»).

import { parseEvent } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { resolveWriteSlot } from "./normalize.ts";
import { jsonNumber } from "./number.ts";
import { ENTITY, errorOf, insertExpense, normalize, onlyOp, ROW } from "./requests.fixture.ts";

const op = (o: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
  ops: [o],
  ...more,
});
const details = (r: ReturnType<typeof normalize>) => {
  const e = errorOf(r);
  if (e.code !== "validation_failed") throw new Error(JSON.stringify(e));
  return e.details;
};
const warningsOf = (r: ReturnType<typeof normalize>) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.request.warnings;
};
const codeOf = (r: ReturnType<typeof normalize>) => details(r).map((d) => d.code);
const run = (set: Record<string, unknown>) =>
  normalize(op({ intent: "insert", table: "runs", set: { date: "2026-11-10", ...set } }));
const malformed = (param: string) => ({ code: "invalid_argument", reason: "malformed", param });

describe("own keys only", () => {
  it("does not read evidence, a table or a kind through a prototype", () => {
    const inherited = Object.assign(
      Object.create({ evidence: [{ kind: "user_message", text: "inherited" }] }),
      insertExpense(),
    );
    const r = normalize(inherited);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.request.evidence).toEqual([]);
    expect(r.request.requestKey.content).not.toContain("inherited");

    const opWithInheritedTable = Object.assign(Object.create({ table: "expenses" }), {
      intent: "insert",
      set: { date: "2026-11-10" },
    });
    expect(errorOf(normalize({ ops: [opWithInheritedTable] }))).toEqual({
      code: "invalid_argument",
      reason: "missing",
      param: "ops/0/table",
    });
    expect(resolveWriteSlot({ ops: [opWithInheritedTable] }, [])).toEqual({
      ok: false,
      error: { code: "invalid_argument", reason: "missing", param: "ops/0/table" },
    });

    const segment = Object.assign(Object.create({ kind: "user_message" }), { text: "x" });
    expect(errorOf(normalize({ ...insertExpense(), evidence: [segment] }))).toEqual({
      code: "invalid_argument",
      reason: "missing",
      param: "evidence/0/kind",
    });

    const quantity = Object.assign(Object.create({ unit: "CNY" }), { value: "45" });
    expect(codeOf(normalize(insertExpense({ amount: quantity })))).toEqual(["unit_missing"]);
  });

  it("takes objects without a prototype", () => {
    const set = Object.assign(Object.create(null), {
      date: "2026-11-10",
      amount: Object.assign(Object.create(null), { value: "45", unit: "CNY" }),
    });
    const params = Object.assign(Object.create(null), {
      ops: [Object.assign(Object.create(null), { intent: "insert", table: "expenses", set })],
    });
    expect(normalize(params).ok).toBe(true);
  });

  it("ignores a key that is not enumerable", () => {
    const params = insertExpense();
    Object.defineProperty(params, "mode", { value: "dry_run", enumerable: false });
    expect(normalize(params).ok).toBe(true);
  });
});

describe("undefined counts as not written", () => {
  it("at the top level, in an op, in set and in a quantity", () => {
    const r = normalize({
      ...insertExpense({ note: undefined }),
      mode: undefined,
      evidence: undefined,
      task: undefined,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(Object.keys(r.request.ops[0]?.fields ?? {})).toEqual(["f1", "f3"]);
    expect(r.request.requestKey.content).toBe(
      '{"ops":[{"intent":"insert","set":{"amount":{"unit":"CNY","value":"45"},"date":"2026-11-10"},"table":"expenses"}]}',
    );
    expect(
      errorOf(
        normalize(op({ intent: "update", table: "expenses", row: ROW, set: { note: undefined } })),
      ),
    ).toEqual(malformed("ops/0/set"));
    expect(codeOf(normalize(insertExpense({ amount: { value: "1", unit: undefined } })))).toEqual([
      "unit_missing",
    ]);
  });
});

describe("arrays with holes", () => {
  const ins = { intent: "insert", table: "expenses", set: { date: "2026-11-10" } };
  /** The values with a hole at `at`. */
  const holed = (at: number, ...xs: unknown[]) => {
    const a = new Array(xs.length + 1);
    xs.forEach((x, i) => {
      a[i < at ? i : i + 1] = x;
    });
    return a;
  };
  it.each<[string, unknown, string]>([
    ["ops of new Array(3)", { ops: new Array(3) }, "ops"],
    ["a hole among ops", { ops: holed(1, ins, ins) }, "ops"],
    [
      "a hole in evidence",
      { ops: [ins], evidence: holed(1, { kind: "agent_note", text: "x" }) },
      "evidence",
    ],
    [
      "a hole in acknowledge",
      op({
        intent: "update",
        table: "expenses",
        row: ROW,
        set: { note: "x" },
        acknowledge: holed(0),
      }),
      "ops/0/acknowledge",
    ],
    [
      "a hole in evidence_refs",
      op(
        {
          intent: "update",
          table: "expenses",
          row: ROW,
          set: { note: "x" },
          evidence_refs: holed(1, 0),
        },
        { evidence: [{ kind: "agent_note", text: "x" }] },
      ),
      "ops/0/evidence_refs",
    ],
  ])("refuses %s as malformed", (_, params, param) => {
    expect(errorOf(normalize(params))).toEqual(malformed(param));
  });

  it("refuses them in resolveWriteSlot too", () => {
    expect(resolveWriteSlot({ ops: new Array(2) }, [])).toEqual({
      ok: false,
      error: malformed("ops"),
    });
  });
});

describe("text the store cannot hold", () => {
  it("refuses NUL in a text field and in evidence text", () => {
    expect(codeOf(normalize(insertExpense({ note: "a\u0000b" })))).toEqual(["type_mismatch"]);
    const ev = (segment: Record<string, unknown>) =>
      errorOf(normalize({ ...insertExpense(), evidence: [segment] }));
    expect(ev({ kind: "user_message", text: "a\u0000" })).toEqual(malformed("evidence/0/text"));
    const file = { kind: "file_ref", name: "r", mime: "x", size: 1, sha256: "a".repeat(64) };
    expect(ev({ ...file, excerpt: "\u0000" })).toEqual(malformed("evidence/0/excerpt"));
  });

  it("limits text to 8 KB both as written and after NFC", () => {
    // U+0958 is 3 bytes and decomposes under NFC into 6.
    expect(codeOf(normalize(insertExpense({ note: "क़".repeat(2730) })))).toEqual(["out_of_range"]);
    // e + U+0301 is 3 bytes and composes into 2.
    expect(codeOf(normalize(insertExpense({ note: "é".repeat(2731) })))).toEqual(["out_of_range"]);
    expect(normalize(insertExpense({ note: "é".repeat(2730) })).ok).toBe(true);
  });

  it("limits file_ref name, mime and origin, without control characters", () => {
    const file = { kind: "file_ref", name: "r", mime: "x", size: 1, sha256: "a".repeat(64) };
    const ev = (more: Record<string, unknown>) =>
      normalize({ ...insertExpense(), evidence: [{ ...file, ...more }] });
    expect(ev({ name: "😀".repeat(256), mime: "m".repeat(256), origin: "o".repeat(2048) }).ok).toBe(
      true,
    );
    expect(errorOf(ev({ name: "😀".repeat(257) }))).toEqual(malformed("evidence/0/name"));
    expect(errorOf(ev({ mime: "m".repeat(257) }))).toEqual(malformed("evidence/0/mime"));
    expect(errorOf(ev({ origin: "o".repeat(2049) }))).toEqual(malformed("evidence/0/origin"));
    expect(errorOf(ev({ name: "a\nb" }))).toEqual(malformed("evidence/0/name"));
    expect(errorOf(ev({ origin: "\u0085" }))).toEqual(malformed("evidence/0/origin"));
  });

  it("requires task and idempotency_key well-formed, at most 256 code points", () => {
    for (const key of ["task", "idempotency_key"]) {
      expect(errorOf(normalize({ ...insertExpense(), [key]: "a\uD800" }))).toEqual(malformed(key));
      expect(normalize({ ...insertExpense(), [key]: "😀".repeat(256) }).ok).toBe(true);
      expect(errorOf(normalize({ ...insertExpense(), [key]: "😀".repeat(257) }))).toEqual(
        malformed(key),
      );
    }
  });
});

describe("duplicates", () => {
  it("refuses a value given twice in acknowledge or evidence_refs, at the second", () => {
    const upd = { intent: "update", table: "expenses", row: ROW, set: { note: "x" } };
    expect(errorOf(normalize(op({ ...upd, acknowledge: ["overwrite", "overwrite"] })))).toEqual(
      malformed("ops/0/acknowledge/1"),
    );
    expect(
      errorOf(
        normalize(
          op(
            { ...upd, evidence_refs: [1, 0, 1] },
            {
              evidence: [
                { kind: "agent_note", text: "a" },
                { kind: "agent_note", text: "b" },
              ],
            },
          ),
        ),
      ),
    ).toEqual(malformed("ops/0/evidence_refs/2"));
  });

  it("refuses an entity_key field named twice by case, at that key", () => {
    expect(
      errorOf(
        normalize(
          op({
            intent: "update",
            table: "accounts",
            entity_key: { name: "a", NAME: "b" },
            set: { limit: 1 },
          }),
        ),
      ),
    ).toEqual(malformed("ops/0/entity_key/NAME"));
  });
});

describe("time zones", () => {
  const at = (v: string) => normalize(insertExpense({ at: v }));
  const zoned = (v: string) => {
    const f = onlyOp(at(v)).fields?.["f8" as never] as { value: unknown; raw: unknown };
    return [f.value, f.raw];
  };

  it("takes UTC or Area/Location the runtime knows; nothing else", () => {
    for (const z of ["PRC", "EST", "+08:00", "+0800", "utc", "Mars/Olympus"]) {
      expect(codeOf(at(`2026-11-10T12:00:00+08:00[${z}]`)), z).toEqual(["type_mismatch"]);
      expect(codeOf(at(`2026-11-10T12:00:00[${z}]`)), z).toEqual(["type_mismatch"]);
    }
    expect(at("2026-11-10T04:00:00Z[UTC]").ok).toBe(true);
  });

  it("records the runtime's spelling for a case difference in the value, the caller's in raw", () => {
    expect(zoned("2026-11-10T12:00:00[asia/shanghai]")).toEqual([
      { instant: "2026-11-10T04:00:00.000Z", zone: "Asia/Shanghai" },
      { instant: "2026-11-10T04:00:00.000Z", zone: "asia/shanghai" },
    ]);
    expect(zoned("2026-11-10T12:00:00+08:00[ASIA/SHANGHAI]")[0]).toEqual({
      instant: "2026-11-10T04:00:00.000Z",
      zone: "Asia/Shanghai",
    });
    // An alias stays as written in both.
    expect(zoned("2026-11-10T07:00:00-05:00[US/Eastern]")).toEqual([
      { instant: "2026-11-10T12:00:00.000Z", zone: "US/Eastern" },
      { instant: "2026-11-10T12:00:00.000Z", zone: "US/Eastern" },
    ]);
    // None written: the slot's zone in both.
    expect(zoned("2026-11-10T12:00:00")).toEqual([
      { instant: "2026-11-10T04:00:00.000Z", zone: "Asia/Shanghai" },
      { instant: "2026-11-10T04:00:00.000Z", zone: "Asia/Shanghai" },
    ]);
  });
});

describe("instants and dates within 0001–9999", () => {
  it("refuses a zoned date-time whose instant lies outside, as out of range", () => {
    for (const v of [
      "9999-12-31T23:59:59-12:00",
      "0001-01-01T00:00:00+14:00",
      // Read in the slot's zone (Asia/Shanghai): 0000-12-31T16:00Z.
      "0001-01-01T00:00:00",
      "9999-12-31T23:59:59-05:00[America/New_York]",
      // Within range in UTC, but 10000-01-01 on the wall clock of the zone it is recorded in
      // (the slot's, Asia/Shanghai, none being written): 10-types-and-units.
      "9999-12-31T16:00:00Z",
      "9999-12-31T23:59:59.999Z",
    ])
      expect(codeOf(normalize(insertExpense({ at: v }))), v).toEqual(["out_of_range"]);
    expect(normalize(insertExpense({ at: "9999-12-31T15:59:59.999Z" })).ok).toBe(true);
    expect(normalize(insertExpense({ at: "0001-01-01T00:00:00Z" })).ok).toBe(true);
  });

  it("refuses business time outside, and a day outside in the slot's zone", () => {
    const acct = (valid_from: string) =>
      normalize(
        op({ intent: "update", table: "accounts", entity: ENTITY, set: { limit: 1 }, valid_from }),
      );
    // Within range in UTC, but 10000-01-01 in Asia/Shanghai.
    expect(errorOf(acct("9999-12-31T20:00:00Z"))).toEqual(malformed("ops/0/valid_from"));
    expect(errorOf(acct("0001-01-01T00:00:00+14:00"))).toEqual(malformed("ops/0/valid_from"));
    expect(acct("9999-12-31T15:59:59Z").ok).toBe(true);
    const room = (valid_from: string) =>
      normalize(
        op({ intent: "update", table: "rooms", entity: ENTITY, set: { guest: "a" }, valid_from }),
      );
    expect(errorOf(room("0001-01-01T00:00:00+00:01"))).toEqual(malformed("ops/0/valid_from"));
    expect(room("0001-01-01T00:00:00Z").ok).toBe(true);
  });

  it("refuses stated_at outside", () => {
    expect(
      errorOf(
        normalize({
          ...insertExpense(),
          evidence: [{ kind: "agent_note", text: "x", stated_at: "0001-01-01T00:00:00+01:00" }],
        }),
      ),
    ).toEqual(malformed("evidence/0/stated_at"));
  });
});

describe("offsets", () => {
  it("takes hours 00–23 and minutes 00–59 only", () => {
    expect(codeOf(normalize(insertExpense({ at: "2026-11-10T12:00:00+08:60" })))).toEqual([
      "type_mismatch",
    ]);
    expect(codeOf(normalize(insertExpense({ at: "2026-11-10T12:00:00+24:00" })))).toEqual([
      "type_mismatch",
    ]);
    expect(normalize(insertExpense({ at: "2026-11-10T12:00:00+23:59" })).ok).toBe(true);
    expect(
      errorOf(
        normalize(
          op({
            intent: "update",
            table: "rooms",
            entity: ENTITY,
            set: { guest: "a" },
            valid_from: "2026-11-10T12:00:00-00:60",
          }),
        ),
      ),
    ).toEqual(malformed("ops/0/valid_from"));
  });
});

describe("decimal text length", () => {
  it("refuses more than 100 characters as malformed, in every form and in quantities", () => {
    const ok = `1.${"2".repeat(98)}`;
    const long = `1.${"2".repeat(99)}`;
    expect(ok.length).toBe(100);
    expect(run({ pace: ok }).ok).toBe(true);
    expect(codeOf(run({ pace: long }))).toEqual(["malformed"]);
    expect(codeOf(run({ pace: jsonNumber(long) }))).toEqual(["malformed"]);
    expect(codeOf(run({ laps: `${"0".repeat(0)}1${"0".repeat(100)}` }))).toEqual(["malformed"]);
    expect(codeOf(run({ distance: { value: long, unit: "km" } }))).toEqual(["malformed"]);
    // Long random digits stay fast: refused before parsing. The fastest of a few: one of them
    // may meet a pause that is the machine's, not the refusal's.
    const huge = `1.${"7".repeat(100_000)}`;
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      expect(codeOf(run({ pace: huge }))).toEqual(["malformed"]);
      times.push(performance.now() - started);
    }
    expect(Math.min(...times)).toBeLessThan(100);
  });
});

describe("plain numbers (04-contract §1)", () => {
  it("takes a safe integer of any digits; other numbers up to 15 significant digits", () => {
    const pieces = (v: unknown) => normalize(insertExpense({ pieces: v }));
    const rate = (v: unknown) => normalize(insertExpense({ rate: v }));
    const field = (r: ReturnType<typeof normalize>, id: string) => onlyOp(r).fields?.[id as never];
    expect(field(pieces(9007199254740991), "f5")).toEqual({
      value: "9007199254740991",
      raw: "9007199254740991",
    });
    expect(field(rate(9007199254740991), "f6")).toEqual({
      value: "9007199254740991",
      raw: "9007199254740991",
    });
    expect(field(rate(0.123456789012345), "f6")?.raw).toBe("0.123456789012345");
    expect(codeOf(rate(0.1234567890123456))).toEqual(["malformed"]);
    expect(codeOf(rate(1234567890.123456))).toEqual(["malformed"]);
    // An integer field: a plain number must be a safe integer.
    expect(codeOf(pieces(1e17))).toEqual(["malformed"]);
    expect(codeOf(pieces(9007199254740992))).toEqual(["malformed"]);
  });

  it("gives a fraction on an integer field the same code as text and as a number", () => {
    const pieces = (v: unknown) => codeOf(normalize(insertExpense({ pieces: v })));
    expect(pieces(1.5)).toEqual(["type_mismatch"]);
    expect(pieces("1.5")).toEqual(["type_mismatch"]);
    expect(pieces(jsonNumber("1.5"))).toEqual(["type_mismatch"]);
    expect(pieces(1.0000000000000002)).toEqual(["type_mismatch"]);
  });
});

describe("number edges", () => {
  it("rounds 5e-12 at scale 12 half up, and a value far right of the point to zero", () => {
    const ratio = (v: string) => run({ ratio: v });
    const value = (v: string) => onlyOp(ratio(v)).fields?.["f5" as never]?.value;
    expect(onlyOp(ratio("5e-12")).fields?.["f5" as never]).toEqual({
      value: "0.000000000005",
      raw: "5e-12",
    });
    expect(warningsOf(ratio("5e-12"))).toEqual([]);
    expect(value("4.9e-12")).toBe("0.000000000005");
    expect(value("5e-13")).toBe("0.000000000001");
    expect(value("-5e-13")).toBe("-0.000000000001");
    expect(value("4.9e-13")).toBe("0");
    expect(value("5e-41")).toBe("0");
    expect(warningsOf(ratio("5e-41")).map((w) => w.code)).toEqual(["rounded"]);
  });

  it("converts a quantity with more integer digits than a decimal holds, then checks bounds", () => {
    // 1e20 mm = 1e14 km: parsed (21 digits), converted, then above the field's max.
    expect(details(run({ distance: { value: "1e20", unit: "mm" } }))).toEqual([
      {
        op: 0,
        table: "ledger.runs",
        field: "distance",
        code: "out_of_range",
        min: "0",
        max: "1000",
      },
    ]);
  });
});

describe("nearest with aliases (04-contract-types §9)", () => {
  it("lists a table or field whose alias folds to the name first", () => {
    const nearestOf = (r: ReturnType<typeof normalize>, code: string, name: string) => {
      const e = errorOf(r);
      if (e.code !== code || !("nearest" in e) || e.name !== name)
        throw new Error(JSON.stringify(e));
      return e.nearest;
    };
    const table = normalize(
      op({ intent: "insert", table: "Spending", set: { date: "2026-11-10" } }),
    );
    expect(nearestOf(table, "unknown_table", "Spending")[0]).toBe("expenses");
    const field = run({ MILEAGE: { value: "1", unit: "km" } });
    expect(nearestOf(field, "unknown_field", "MILEAGE")[0]).toBe("distance");
  });

  it("does so in resolveWriteSlot", () => {
    const slots = [
      {
        name: "ledger",
        tables: ["expenses", "budgets", "outings"],
        aliases: new Map([["expenses", ["Outgo"]]]),
      },
    ];
    const error = (table: string) => {
      const r = resolveWriteSlot({ ops: [{ table }] }, slots);
      return r.ok ? undefined : r.error;
    };
    // By distance alone, outings would come first.
    expect(error("outgo")).toMatchObject({ nearest: ["expenses", "outings", "budgets"] });
    expect(error("ledger.outgo")).toMatchObject({
      nearest: ["ledger.expenses", "ledger.outings", "ledger.budgets"],
    });
  });
});

describe("raw values pass the head event's shape check (09 §1.3)", () => {
  const AT = "2026-11-10T04:41:07.123Z";
  const header = {
    type: "write.head",
    v: 1,
    seq: 25,
    at: AT,
    prev_hash: "a".repeat(64),
    actor: `ci_${"2".repeat(26)}`,
    slot: `sl_${"4".repeat(16)}`,
  };
  const blocksFor = (fields: Record<string, { raw: unknown }>) => ({
    ctx: {
      now: AT,
      today: "2026-11-10",
      ruleset_version: 1,
      policy_version: 1,
      literal_checker: "literal@1",
    },
    request: { sv: 1, sv_basis: "explicit", op_count: 1 },
    "ops/0/target": {
      table: "t1",
      row: ROW,
      intent: "update",
      ver: { op: 21, restore_count: 0, basis: "explicit" },
    },
    ...Object.fromEntries(Object.entries(fields).map(([id, f]) => [`ops/0/set/${id}`, f.raw])),
  });

  it("for every field type, in every form a value arrives in", () => {
    const set = {
      date: "2026-11-10",
      category: "food",
      amount: { value: jsonNumber("45.50"), unit: "CNY" },
      note: "é",
      pieces: 3,
      rate: 0.125,
      paid: true,
      at: "2026-11-10T12:00:00+08:00[asia/shanghai]",
      account: ROW,
    };
    const r = normalize(op({ intent: "update", table: "expenses", row: ROW, ver: "v21.0", set }));
    const fields = onlyOp(r).fields ?? {};
    expect(Object.fromEntries(Object.entries(fields).map(([id, f]) => [id, f.raw]))).toEqual({
      f1: "2026-11-10",
      f2: "food",
      f3: { value: "45.50", unit: "CNY" },
      f4: "é",
      f5: "3",
      f6: "0.125",
      f7: true,
      f8: { instant: "2026-11-10T04:00:00.000Z", zone: "asia/shanghai" },
      f9: ROW,
    });
    expect(parseEvent(header, blocksFor(fields))).toMatchObject({ ok: true });
    const cleared = normalize(
      op({ intent: "update", table: "expenses", row: ROW, ver: "v21.0", set: { note: null } }),
    );
    expect(parseEvent(header, blocksFor(onlyOp(cleared).fields ?? {}))).toMatchObject({ ok: true });
  });

  it("which would refuse a number or a JsonNumber in raw", () => {
    expect(parseEvent(header, blocksFor({ f5: { raw: 3 } }))).toMatchObject({ ok: false });
    expect(
      parseEvent(header, blocksFor({ f3: { raw: { value: jsonNumber("1"), unit: "CNY" } } })),
    ).toMatchObject({ ok: false });
  });
});

describe("names echoed in errors", () => {
  it("cuts a name and each path segment to 200 code points", () => {
    const long = "x".repeat(100_000);
    const t = errorOf(
      normalize(op({ intent: "insert", table: long, set: { date: "2026-11-10" } })),
    );
    expect(t).toMatchObject({ code: "unknown_table", name: "x".repeat(200) });
    const f = errorOf(
      normalize(op({ intent: "insert", table: "runs", set: { date: "2026-11-10", [long]: 1 } })),
    );
    expect(f).toMatchObject({
      code: "unknown_field",
      name: "x".repeat(200),
      param: `ops/0/set/${"x".repeat(200)}`,
    });
    expect(errorOf(normalize({ ...insertExpense(), [long]: 1 }))).toEqual({
      code: "invalid_argument",
      reason: "malformed",
      param: "x".repeat(200),
    });
    expect(JSON.stringify(f).length).toBeLessThan(2_000);
  });
});
