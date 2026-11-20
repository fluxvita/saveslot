// normalizeWrite: «判定顺序» step 1 of 03-data-model/04-write-and-read.md. What a request becomes
// (targets, intents, values, raw values, intervals, warnings, request key), and each refusal with
// its code, reason and path (04-contract §1–§5, §14; 04-contract-types §5.1, §7, §9).

import { describe, expect, it } from "vitest";
import { checkSvCompatibility } from "./normalize.ts";
import { jsonNumber, keepNumberText } from "./number.ts";
import { ENTITY, errorOf, insertExpense, normalize, onlyOp, ROW } from "./requests.fixture.ts";
import type { ChangedFields } from "./types.ts";

/** `type_mismatch`'s example of each field of the expenses table, as written there (`set`). */
const EXAMPLE: Record<string, unknown> = {
  note: "text",
  pieces: 1,
  paid: true,
  date: "2026-11-12",
  at: "2026-11-12T09:30:00+08:00[Asia/Shanghai]",
  account: `e_${"0".repeat(26)}`,
  amount: { value: "0", unit: "CNY" },
  category: "food",
  rate: "1",
};

const op = (o: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
  ops: [o],
  ...more,
});
const fieldsOf = (r: ReturnType<typeof normalize>) => onlyOp(r).fields;
const warningsOf = (r: ReturnType<typeof normalize>) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.request.warnings;
};
const details = (r: ReturnType<typeof normalize>) => {
  const e = errorOf(r);
  if (e.code !== "validation_failed") throw new Error(JSON.stringify(e));
  return e.details;
};

describe("an accepted request", () => {
  it("an insert: table and field IDs, intent, target, values and raw values", () => {
    const r = normalize(insertExpense({ category: "food", note: "lunch" }), {});
    expect(onlyOp(r)).toEqual({
      index: 0,
      table: "t1",
      intent: "insert",
      target: { kind: "new" },
      ver: undefined,
      kind: "write",
      fields: {
        f1: { value: "2026-11-10", raw: "2026-11-10" },
        f3: { value: { value: "45", unit: "CNY" }, raw: { value: "45", unit: "CNY" } },
        f2: { value: "food", raw: "food" },
        f4: { value: "lunch", raw: "lunch" },
      },
      acknowledge: [],
      named: [
        { field: "f1", name: "date", param: "ops/0/set/date" },
        { field: "f3", name: "amount", param: "ops/0/set/amount" },
        { field: "f2", name: "category", param: "ops/0/set/category" },
        { field: "f4", name: "note", param: "ops/0/set/note" },
      ],
    });
    if (!r.ok) throw new Error();
    expect(r.request.sv).toBeUndefined();
    expect(r.request.task).toBeUndefined();
    expect(r.request.evidence).toEqual([]);
    expect(r.request.warnings).toEqual([]);
  });

  it("resolves names without ASCII case and with the slot's qualified name", () => {
    const r = normalize(
      op({
        intent: "insert",
        table: "LEDGER.Expenses",
        set: { DATE: "2026-11-10", Amount: { value: "1", unit: "CNY" } },
      }),
    );
    expect(onlyOp(r).table).toBe("t1");
    expect(Object.keys(fieldsOf(r) ?? {})).toEqual(["f1", "f3"]);
  });

  it("an update by row, with ver; a revoke; an undo without intent", () => {
    expect(
      onlyOp(
        normalize(
          op({ intent: "update", table: "expenses", row: ROW, ver: "v57.2", set: { note: "x" } }),
        ),
      ),
    ).toMatchObject({
      intent: "update",
      kind: "write",
      target: { kind: "row", row: ROW },
      ver: { op: 57, restoreCount: 2 },
    });
    expect(
      onlyOp(normalize(op({ intent: "revoke", table: "expenses", row: ROW, ver: "v3.0" }))),
    ).toMatchObject({
      intent: "revoke",
      kind: "revoke",
    });
    const u = onlyOp(
      normalize(op({ table: "expenses", row: ROW, revert: { undo: 12, include_later: true } })),
    );
    expect(u).toMatchObject({
      intent: undefined,
      kind: "undo",
      undo: { target: 12, includeLater: true },
    });
    expect(u.fields).toBeUndefined();
    expect(
      onlyOp(
        normalize(op({ intent: "correct", table: "expenses", row: ROW, revert: { undo: 12 } })),
      ),
    ).toMatchObject({
      intent: "correct",
      undo: { target: 12, includeLater: false },
    });
  });

  it("keeps acknowledge as given, and evidence references", () => {
    const r = normalize(
      op(
        {
          intent: "update",
          table: "expenses",
          row: ROW,
          ver: "v1.0",
          set: { note: "x" },
          acknowledge: ["overwrite"],
          evidence_refs: [1, 0],
        },
        {
          evidence: [
            { kind: "user_message", text: "a" },
            { kind: "agent_note", text: "b" },
          ],
        },
      ),
    );
    expect(onlyOp(r)).toMatchObject({ acknowledge: ["overwrite"], evidenceRefs: [1, 0] });
  });

  it("an entity_key target: the key normalized by field ID", () => {
    const o = onlyOp(
      normalize(
        op({
          intent: "update",
          table: "accounts",
          entity_key: { NAME: "Cash" },
          set: { limit: 5 },
        }),
      ),
    );
    expect(o.target).toEqual({ kind: "entity_key", key: { f1: { value: "Cash", raw: "Cash" } } });
    expect(o.fields).toEqual({ f2: { value: "5", raw: "5" } });
  });

  it("clearing an optional field is a null value", () => {
    expect(
      fieldsOf(
        normalize(op({ intent: "update", table: "expenses", row: ROW, set: { note: null } })),
      ),
    ).toEqual({
      f4: { value: null, raw: null },
    });
  });

  it("takes task, idempotency_key and sv", () => {
    const r = normalize(insertExpense(), {});
    const s = normalize({ ...insertExpense(), task: "t", idempotency_key: "k", sv: 1 });
    expect(r.ok && s.ok).toBe(true);
    if (!s.ok) return;
    expect([s.request.task, s.request.sv, s.request.requestKey.idempotencyKey]).toEqual([
      "t",
      1,
      "k",
    ]);
  });
});

describe("values (04-contract §1; 10 «字段类型与取值范围», «精度与舍入», «单位词表»)", () => {
  const value = (field: string, v: unknown, table = "expenses") =>
    fieldsOf(
      normalize(
        op(
          table === "expenses"
            ? { intent: "update", table, row: ROW, set: { [field]: v } }
            : { intent: "insert", table, set: { date: "2026-11-10", [field]: v } },
        ),
      ),
    );

  it.each<[string, unknown, unknown, unknown]>([
    ["pieces", "42", "42", "42"],
    ["pieces", 42, "42", "42"],
    ["pieces", "-9223372036854775808", "-9223372036854775808", "-9223372036854775808"],
    ["pieces", "1e3", "1000", "1e3"],
    ["pieces", "2.0", "2", "2.0"],
    ["pieces", "-0", "0", "-0"],
    ["rate", "1.5", "1.5", "1.5"],
    ["rate", 5.2, "5.2", "5.2"],
    ["rate", "1.50000", "1.5", "1.50000"],
    ["rate", "0.00005", "0", "0.00005"],
    ["rate", "0.00015", "0.0002", "0.00015"],
    ["rate", "0.00025", "0.0002", "0.00025"],
    ["rate", "-0.00025", "-0.0002", "-0.00025"],
    ["rate", "1E-2", "0.01", "1E-2"],
    ["rate", 1e-7, "0", "1e-7"],
    ["rate", "123456789012345678", "123456789012345678", "123456789012345678"],
    ["paid", false, false, false],
    ["category", "rent", "rent", "rent"],
    ["date", "0001-01-01", "0001-01-01", "0001-01-01"],
    ["date", "9999-12-31", "9999-12-31", "9999-12-31"],
    ["account", ENTITY, ENTITY, ENTITY],
    ["note", "", "", ""],
    ["note", "é", "é", "é"],
    [
      "at",
      "2026-11-10T12:31:00+08:00[Asia/Shanghai]",
      { instant: "2026-11-10T04:31:00.000Z", zone: "Asia/Shanghai" },
      { instant: "2026-11-10T04:31:00.000Z", zone: "Asia/Shanghai" },
    ],
    [
      "at",
      "2026-11-10T04:31:00.120Z[Europe/London]",
      { instant: "2026-11-10T04:31:00.120Z", zone: "Europe/London" },
      { instant: "2026-11-10T04:31:00.120Z", zone: "Europe/London" },
    ],
    [
      "at",
      "2026-07-01T12:00:00[America/New_York]",
      { instant: "2026-07-01T16:00:00.000Z", zone: "America/New_York" },
      { instant: "2026-07-01T16:00:00.000Z", zone: "America/New_York" },
    ],
    [
      "amount",
      { value: "12.345", unit: "CNY" },
      { value: "12.35", unit: "CNY" },
      { value: "12.345", unit: "CNY" },
    ],
    ["amount", { value: 0, unit: "CNY" }, { value: "0", unit: "CNY" }, { value: "0", unit: "CNY" }],
  ])("%s ← %j", (field, v, normalized, raw) => {
    const f = value(field, v);
    expect(Object.values(f ?? {})).toEqual([{ value: normalized, raw }]);
  });

  it("converts units exactly within a dimension, then rounds", () => {
    expect(value("distance", { value: "3.2", unit: "mi" }, "runs")?.["f2"]).toEqual({
      value: { value: "5.15", unit: "km" },
      raw: { value: "3.2", unit: "mi" },
    });
    expect(value("distance", { value: "1500", unit: "m" }, "runs")?.["f2"]?.value).toEqual({
      value: "1.5",
      unit: "km",
    });
    expect(value("distance", { value: "5", unit: "m" }, "runs")?.["f2"]?.value).toEqual({
      value: "0.01",
      unit: "km",
    });
    expect(value("distance", { value: "5", unit: "mm" }, "runs")?.["f2"]?.value).toEqual({
      value: "0",
      unit: "km",
    });
    expect(value("distance", { value: "4", unit: "m" }, "runs")?.["f2"]?.value).toEqual({
      value: "0",
      unit: "km",
    });
  });

  it("warns: rounded, unit_converted, timezone_assumed", () => {
    expect(
      warningsOf(
        normalize(
          op({
            intent: "update",
            table: "expenses",
            row: ROW,
            set: { rate: "0.12345", amount: { value: "1", unit: "CNY" } },
          }),
        ),
      ),
    ).toEqual([{ code: "rounded", op: 0, field: "rate", from: "0.12345", to: "0.1234", scale: 4 }]);
    expect(
      warningsOf(
        normalize(
          op({
            intent: "insert",
            table: "runs",
            set: { date: "2026-11-10", distance: { value: "1", unit: "mi" } },
          }),
        ),
      ),
    ).toEqual([
      {
        code: "unit_converted",
        op: 0,
        field: "distance",
        from: { value: "1", unit: "mi" },
        to: { value: "1.61", unit: "km" },
      },
    ]);
    const tz = normalize(
      op({
        intent: "update",
        table: "expenses",
        row: ROW,
        set: { at: "2026-11-10T12:31:00+08:00" },
      }),
    );
    expect(fieldsOf(tz)?.["f8"]?.value).toEqual({
      instant: "2026-11-10T04:31:00.000Z",
      zone: "Asia/Shanghai",
    });
    expect(warningsOf(tz)).toEqual([
      { code: "timezone_assumed", op: 0, field: "at", timezone: "Asia/Shanghai" },
    ]);
    expect(
      warningsOf(
        normalize(
          op({ intent: "update", table: "expenses", row: ROW, set: { at: "2026-11-10T12:31:00" } }),
        ),
      ),
    ).toEqual([{ code: "timezone_assumed", op: 0, field: "at", timezone: "Asia/Shanghai" }]);
  });

  it.each<[string, string, unknown, Record<string, unknown>]>([
    ["text not a string", "note", 1, { code: "type_mismatch" }],
    ["text with a lone surrogate", "note", "\ud800", { code: "type_mismatch" }],
    ["text over 8 KB", "note", "a".repeat(8 * 1024 + 1), { code: "out_of_range" }],
    ["integer not integral", "pieces", "1.5", { code: "type_mismatch" }],
    ["integer as an object", "pieces", { v: 1 }, { code: "type_mismatch" }],
    ["integer as a boolean", "pieces", true, { code: "type_mismatch" }],
    ["integer beyond 64 bits", "pieces", "9223372036854775808", { code: "out_of_range" }],
    // A host's JSON parse of 9007199254740993: the value it hands over.
    ["integer beyond safe as a plain number", "pieces", 2 ** 53 + 2, { code: "malformed" }],
    ["integer with a leading zero", "pieces", "01", { code: "malformed" }],
    ["integer with a plus", "pieces", "+1", { code: "malformed" }],
    ["decimal .5", "rate", ".5", { code: "malformed" }],
    ["decimal 1.", "rate", "1.", { code: "malformed" }],
    ["decimal NaN", "rate", "NaN", { code: "malformed" }],
    ["decimal Infinity as a number", "rate", Number.POSITIVE_INFINITY, { code: "malformed" }],
    ["decimal of 17 significant digits as a number", "rate", 0.1 + 0.2, { code: "malformed" }],
    ["decimal with 19 integer digits", "rate", "1234567890123456789", { code: "out_of_range" }],
    ["decimal with a huge exponent", "rate", "1e999999", { code: "out_of_range" }],
    ["decimal a plain number of 1e21", "rate", 1e21, { code: "out_of_range" }],
    [
      "decimal rounding past 18 digits",
      "rate",
      "999999999999999999.99999",
      { code: "out_of_range" },
    ],
    ["boolean as a string", "paid", "true", { code: "type_mismatch" }],
    [
      "enum value not declared",
      "category",
      "Food",
      { code: "enum_value", allowed_values: ["food", "rent"] },
    ],
    ["date of another shape", "date", "2026/11/10", { code: "type_mismatch" }],
    ["date not in the calendar", "date", "2026-02-30", { code: "type_mismatch" }],
    ["date before 0001", "date", "0000-12-31", { code: "out_of_range" }],
    ["zoned without seconds", "at", "2026-11-10T12:31+08:00", { code: "type_mismatch" }],
    [
      "zoned finer than a millisecond",
      "at",
      "2026-11-10T12:31:00.0001Z",
      { code: "type_mismatch" },
    ],
    [
      "zoned with an unknown zone",
      "at",
      "2026-11-10T12:31:00Z[Mars/Olympus]",
      { code: "type_mismatch" },
    ],
    [
      "zoned whose offset disagrees with its zone",
      "at",
      "2026-11-10T12:31:00+09:00[Asia/Shanghai]",
      { code: "type_mismatch" },
    ],
    ["ref not an ID", "account", "acct-1", { code: "type_mismatch" }],
    ["ref to a temporary name", "account", "@p1", { code: "ref_not_found" }],
    ["quantity without unit", "amount", { value: "1" }, { code: "unit_missing" }],
    ["quantity with null unit", "amount", { value: "1", unit: null }, { code: "unit_missing" }],
    [
      "quantity of an unknown unit",
      "amount",
      { value: "1", unit: "RMB" },
      { code: "unit_unknown", allowed_units: ["CNY"] },
    ],
    [
      "quantity in another currency",
      "amount",
      { value: "1", unit: "USD" },
      { code: "unit_dimension" },
    ],
    [
      "quantity below min",
      "amount",
      { value: "-0.01", unit: "CNY" },
      { code: "out_of_range", min: "0" },
    ],
    ["quantity as a number", "amount", 45, { code: "type_mismatch" }],
    [
      "quantity with an extra key",
      "amount",
      { value: "1", unit: "CNY", note: "x" },
      { code: "type_mismatch" },
    ],
    ["quantity without value", "amount", { unit: "CNY" }, { code: "type_mismatch" }],
  ])("refuses %s", (_, field, v, detail) => {
    expect(
      details(
        normalize(op({ intent: "update", table: "expenses", row: ROW, set: { [field]: v } })),
      ),
    ).toEqual([
      {
        op: 0,
        table: "ledger.expenses",
        field,
        ...detail,
        ...(detail["code"] === "type_mismatch" ? { example: EXAMPLE[field] } : {}),
      },
    ]);
  });

  it("checks bounds on the rounded and converted value", () => {
    const d = (v: unknown) =>
      details(
        normalize(
          op({ intent: "insert", table: "runs", set: { date: "2026-11-10", distance: v } }),
        ),
      );
    expect(
      normalize(
        op({
          intent: "insert",
          table: "runs",
          set: { date: "2026-11-10", distance: { value: "1000.004", unit: "km" } },
        }),
      ).ok,
    ).toBe(true);
    expect(d({ value: "1000.005", unit: "km" })).toEqual([
      {
        op: 0,
        table: "ledger.runs",
        field: "distance",
        code: "out_of_range",
        min: "0",
        max: "1000",
      },
    ]);
    expect(d({ value: "621.38", unit: "mi" })).toEqual([
      {
        op: 0,
        table: "ledger.runs",
        field: "distance",
        code: "out_of_range",
        min: "0",
        max: "1000",
      },
    ]);
    expect(d({ value: "1", unit: "kg" })).toEqual([
      { op: 0, table: "ledger.runs", field: "distance", code: "unit_dimension" },
    ]);
    // 99.5004 rounds to 99.5 at scale 3: within the max.
    expect(
      normalize(
        op({ intent: "insert", table: "runs", set: { date: "2026-11-10", pace: "99.5004" } }),
      ).ok,
    ).toBe(true);
    expect(
      details(
        normalize(
          op({ intent: "insert", table: "runs", set: { date: "2026-11-10", pace: "99.5005" } }),
        ),
      ),
    ).toEqual([
      { op: 0, table: "ledger.runs", field: "pace", code: "out_of_range", min: "-5", max: "99.5" },
    ]);
  });

  it("collects every value problem of the request into one validation_failed", () => {
    const r = normalize({
      ops: [
        { intent: "update", table: "expenses", row: ROW, set: { pieces: "x", paid: 1 } },
        { intent: "insert", table: "expenses", set: { note: "n" } },
        { intent: "update", table: "expenses", row: ROW, set: { date: null } },
      ],
    });
    expect(details(r)).toEqual([
      { op: 0, table: "ledger.expenses", field: "pieces", code: "malformed" },
      {
        op: 0,
        table: "ledger.expenses",
        field: "paid",
        code: "type_mismatch",
        example: EXAMPLE["paid"],
      },
      { op: 1, table: "ledger.expenses", field: "date", code: "required_missing" },
      { op: 1, table: "ledger.expenses", field: "amount", code: "required_missing" },
      { op: 2, table: "ledger.expenses", field: "date", code: "required_missing" },
    ]);
  });

  it("an insert on a table with no required field gives some field a non-empty value: empty_row", () => {
    // Timeless, nothing required: an insert of only empty values would make no row (a clear does
    // not keep one, 03-deletion «重放规则»). Said with the op and the table, among the others.
    const r = normalize({
      ops: [
        { intent: "insert", table: "kv", set: { text: null } },
        { intent: "insert", table: "kv", set: { text: null, rank: null } },
        { intent: "insert", table: "expenses", set: { date: null, note: "n" } },
      ],
    });
    expect(details(r)).toEqual([
      { op: 0, table: "ledger.kv", code: "empty_row" },
      { op: 1, table: "ledger.kv", code: "empty_row" },
      { op: 2, table: "ledger.expenses", field: "date", code: "required_missing" },
      { op: 2, table: "ledger.expenses", field: "amount", code: "required_missing" },
    ]);
    // One non-empty value is enough; an empty one beside it is a clear of that field.
    expect(normalize(op({ intent: "insert", table: "kv", set: { text: null, rank: 2 } })).ok).toBe(
      true,
    );
    // An update clearing every field it names is not refused: the row stands on what it had.
    expect(normalize(op({ intent: "update", table: "kv", row: ROW, set: { text: null } })).ok).toBe(
      true,
    );
    // A state table: a clear is a value there (05-time «无值区间»).
    expect(
      normalize(
        op({
          intent: "insert",
          table: "rooms",
          valid_from: "2026-11-01T00:00:00Z",
          set: { guest: null },
        }),
      ).ok,
    ).toBe(true);
    // A malformed value is not an empty one: only its own detail.
    expect(details(normalize(op({ intent: "insert", table: "kv", set: { rank: "x" } })))).toEqual([
      { op: 0, table: "ledger.kv", field: "rank", code: "malformed" },
    ]);
  });
});

describe("plain numbers, number text and the request key (04-contract §1, §14)", () => {
  it("takes the text of a JsonNumber as written", () => {
    const params = JSON.parse(
      '{"ops":[{"intent":"update","table":"expenses","row":"' +
        ROW +
        '","set":{"rate":1.0000000000000001,"pieces":9007199254740993}}]}',
      keepNumberText,
    );
    const r = normalize(params);
    expect(fieldsOf(r)).toEqual({
      f6: { value: "1", raw: "1.0000000000000001" },
      f5: { value: "9007199254740993", raw: "9007199254740993" },
    });
    if (!r.ok) return;
    expect(r.request.requestKey.content).toContain(
      '"pieces":9007199254740993,"rate":1.0000000000000001',
    );
  });

  it("content: RFC 8785 of the request without task and idempotency_key; fingerprint with a key", () => {
    const a = normalize({ ...insertExpense({ rate: 5.2 }), task: "t", idempotency_key: "k" });
    const b = normalize({ idempotency_key: "k2", ...insertExpense({ rate: 5.2 }) });
    if (!a.ok || !b.ok) throw new Error();
    expect(a.request.requestKey.content).toBe(b.request.requestKey.content);
    expect(a.request.requestKey.content).toBe(
      '{"ops":[{"intent":"insert","set":{"amount":{"unit":"CNY","value":"45"},"date":"2026-11-10","rate":5.2},"table":"expenses"}]}',
    );
    expect(a.request.requestKey.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(a.request.requestKey.fingerprint).toBe(b.request.requestKey.fingerprint);
    const c = normalize(insertExpense());
    expect(c.ok && c.request.requestKey).toEqual({ content: expect.any(String) });
  });

  it("a JsonNumber cannot be forged by a caller's object", () => {
    expect(
      details(
        normalize(
          op({ intent: "update", table: "expenses", row: ROW, set: { rate: { text: "1" } } }),
        ),
      ),
    ).toEqual([
      {
        op: 0,
        table: "ledger.expenses",
        field: "rate",
        code: "type_mismatch",
        example: EXAMPLE["rate"],
      },
    ]);
    expect(() => jsonNumber("1.")).toThrow();
  });
});

describe("business time on state tables (04-contract §4, §5.2)", () => {
  const acc = (o: Record<string, unknown>) =>
    normalize(op({ intent: "update", table: "accounts", entity: ENTITY, set: { limit: 1 }, ...o }));
  const room = (o: Record<string, unknown>) =>
    normalize(op({ intent: "update", table: "rooms", entity: ENTITY, set: { guest: "x" }, ...o }));

  it("defaults: now to next_change; correct with neither end: corrected_span", () => {
    expect(onlyOp(acc({})).valid).toEqual({ from: { mode: "now" }, to: { mode: "next_change" } });
    expect(onlyOp(acc({ intent: "correct" })).valid).toBe("corrected_span");
    expect(onlyOp(acc({ intent: "correct", valid_to: "open" })).valid).toEqual({
      from: { mode: "now" },
      to: { mode: "open" },
    });
    expect(onlyOp(acc({ valid_from: "2026-11-02", valid_to: "2026-12-01" })).valid).toEqual({
      from: { mode: "given", value: "2026-11-02" },
      to: { mode: "given", value: "2026-12-01" },
    });
    expect(onlyOp(acc({ valid_to: "next_change" })).valid).toEqual({
      from: { mode: "now" },
      to: { mode: "next_change" },
    });
  });

  it("a revoke without bounds has none; an undo has none", () => {
    expect(
      onlyOp(normalize(op({ intent: "revoke", table: "accounts", entity: ENTITY }))).valid,
    ).toBeUndefined();
    expect(
      onlyOp(
        normalize(
          op({ intent: "revoke", table: "accounts", entity: ENTITY, valid_from: "2026-11-02" }),
        ),
      ).valid,
    ).toEqual({
      from: { mode: "given", value: "2026-11-02" },
      to: { mode: "next_change" },
    });
    expect(
      onlyOp(normalize(op({ table: "accounts", entity: ENTITY, revert: { undo: 3 } }))).valid,
    ).toBeUndefined();
  });

  it("a date table given an instant takes its day in the slot's zone", () => {
    const r = acc({ valid_from: "2026-11-01T23:30:00Z" });
    expect(onlyOp(r).valid).toMatchObject({ from: { mode: "given", value: "2026-11-02" } });
    expect(warningsOf(r)).toEqual([
      {
        code: "time_truncated",
        op: 0,
        param: "ops/0/valid_from",
        from: "2026-11-01T23:30:00.000Z",
        to: "2026-11-02",
      },
    ]);
    expect(warningsOf(acc({ valid_from: "2026-11-02T08:00:00" }))).toEqual([
      { code: "timezone_assumed", op: 0, param: "ops/0/valid_from", timezone: "Asia/Shanghai" },
      {
        code: "time_truncated",
        op: 0,
        param: "ops/0/valid_from",
        from: "2026-11-02T00:00:00.000Z",
        to: "2026-11-02",
      },
    ]);
  });

  it("an instant table takes instants (in UTC), assumes the slot's zone, refuses dates with an example", () => {
    expect(onlyOp(room({ valid_from: "2026-11-02T10:00:00+08:00" })).valid).toMatchObject({
      from: { mode: "given", value: "2026-11-02T02:00:00.000Z" },
    });
    const assumed = room({ valid_from: "2026-11-02T10:00:00" });
    expect(onlyOp(assumed).valid).toMatchObject({
      from: { mode: "given", value: "2026-11-02T02:00:00.000Z" },
    });
    expect(warningsOf(assumed)).toEqual([
      { code: "timezone_assumed", op: 0, param: "ops/0/valid_from", timezone: "Asia/Shanghai" },
    ]);
    expect(errorOf(room({ valid_to: "2026-11-02" }))).toEqual({
      code: "invalid_argument",
      reason: "granularity",
      param: "ops/0/valid_to",
      example: { valid_from: "2026-11-01T16:00:00.000Z", valid_to: "2026-11-02T16:00:00.000Z" },
    });
  });

  it.each<[string, Record<string, unknown>, string, string]>([
    [
      "an end not after the start",
      { valid_from: "2026-11-02", valid_to: "2026-11-02" },
      "malformed",
      "ops/0/valid_to",
    ],
    [
      "an end before the start",
      { valid_from: "2026-11-02", valid_to: "2026-11-01" },
      "malformed",
      "ops/0/valid_to",
    ],
    ["a start that is no time", { valid_from: "soon" }, "malformed", "ops/0/valid_from"],
    ["a start of next_change", { valid_from: "next_change" }, "malformed", "ops/0/valid_from"],
    ["a number for a start", { valid_from: 20261102 }, "malformed", "ops/0/valid_from"],
  ])("refuses %s", (_, o, reason, param) => {
    expect(errorOf(acc(o))).toEqual({ code: "invalid_argument", reason, param });
  });

  it("refuses intervals on tables without business time intervals", () => {
    expect(
      errorOf(
        normalize(
          op({
            intent: "update",
            table: "expenses",
            row: ROW,
            set: { note: "x" },
            valid_from: "2026-11-02",
          }),
        ),
      ),
    ).toEqual({
      code: "invalid_argument",
      reason: "not_state_table",
      param: "ops/0/valid_from",
    });
    expect(
      errorOf(
        normalize(
          op({
            intent: "update",
            table: "settings",
            row: ROW,
            set: { key: "x" },
            valid_to: "open",
          }),
        ),
      ),
    ).toEqual({
      code: "invalid_argument",
      reason: "not_state_table",
      param: "ops/0/valid_to",
    });
  });
});

describe("refusals of the request's shape", () => {
  it.each<[string, unknown, Record<string, unknown>]>([
    ["not an object", [], { code: "invalid_argument", reason: "malformed", param: "" }],
    [
      "an unknown top-level key",
      { ...insertExpense(), foo: 1 },
      { code: "invalid_argument", reason: "malformed", param: "foo" },
    ],
    [
      "mode",
      { ...insertExpense(), mode: "job" },
      { code: "not_in_this_version", reason: "parameter", param: "mode" },
    ],
    ["no ops", {}, { code: "invalid_argument", reason: "missing", param: "ops" }],
    ["empty ops", { ops: [] }, { code: "invalid_argument", reason: "malformed", param: "ops" }],
    [
      "ops not an array",
      { ops: {} },
      { code: "invalid_argument", reason: "malformed", param: "ops" },
    ],
    [
      "task empty",
      { ...insertExpense(), task: "" },
      { code: "invalid_argument", reason: "malformed", param: "task" },
    ],
    [
      "task too long",
      { ...insertExpense(), task: "t".repeat(257) },
      { code: "invalid_argument", reason: "malformed", param: "task" },
    ],
    [
      "task with a control character",
      { ...insertExpense(), task: "a\nb" },
      { code: "invalid_argument", reason: "malformed", param: "task" },
    ],
    [
      "idempotency_key not a string",
      { ...insertExpense(), idempotency_key: 1 },
      { code: "invalid_argument", reason: "malformed", param: "idempotency_key" },
    ],
    [
      "sv not an integer",
      { ...insertExpense(), sv: 1.5 },
      { code: "invalid_argument", reason: "malformed", param: "sv" },
    ],
    [
      "sv 0",
      { ...insertExpense(), sv: 0 },
      { code: "invalid_argument", reason: "malformed", param: "sv" },
    ],
    [
      "sv above the current one",
      { ...insertExpense(), sv: 2 },
      { code: "invalid_argument", reason: "malformed", param: "sv" },
    ],
    [
      "sv as a string",
      { ...insertExpense(), sv: "1" },
      { code: "invalid_argument", reason: "malformed", param: "sv" },
    ],
  ])("%s", (_, params, error) => {
    expect(errorOf(normalize(params))).toEqual(error);
  });

  it("takes only a version that was in effect: numbers may skip (04-contract §2)", () => {
    // Version 2 was a draft given up: no caller can have read it.
    const at = (sv: number) =>
      normalize({ ...insertExpense(), sv }, { currentSv: 3, knownSv: new Set([1, 3]) });
    expect(errorOf(at(2))).toEqual({
      code: "invalid_argument",
      reason: "malformed",
      param: "sv",
    });
    expect(at(1).ok).toBe(true);
    expect(at(3).ok).toBe(true);
    // Version 1 no exception: a number not in effect is refused whatever it is.
    const without1 = normalize(
      { ...insertExpense(), sv: 1 },
      { currentSv: 3, knownSv: new Set([2, 3]) },
    );
    expect(errorOf(without1)).toEqual({
      code: "invalid_argument",
      reason: "malformed",
      param: "sv",
    });
  });

  it("names tables as the request's version has them: one added since is unknown_table", () => {
    // expenses (t1) since version 3; accounts (t2) in every version; kv (t7) dropped after 1.
    const tableVersions = new Map([
      ["t1", { from: 3, to: 3 }],
      ["t2", { from: 1, to: 3 }],
      ["t7", { from: 1, to: 1 }],
    ]);
    const at = (sv: number) =>
      normalize({ ...insertExpense(), sv }, { currentSv: 3, tableVersions });
    expect(errorOf(at(2))).toEqual({
      code: "unknown_table",
      param: "ops/0/table",
      name: "expenses",
      // The nearest names among the version's tables: not a table it does not have.
      nearest: expect.not.arrayContaining(["expenses"]),
    });
    expect(at(3).ok).toBe(true);
    // A table not in the map counts as in every version.
    expect(normalize({ ...insertExpense(), sv: 2 }, { currentSv: 3 }).ok).toBe(true);
  });

  it("takes exactly 1,000 ops", () => {
    const ops = Array.from({ length: 1000 }, () => insertExpense()["ops"]);
    const r = normalize({ ops: ops.flat() });
    expect(r.ok && r.request.ops.length).toBe(1000);
  });

  it("refuses more than 1,000 ops", () => {
    const ops = Array.from({ length: 1001 }, () => insertExpense()["ops"]);
    expect(errorOf(normalize({ ops: ops.flat() }))).toEqual({
      code: "too_large",
      reason: "ops",
      param: "ops",
      limit: 1000,
      actual: 1001,
    });
  });

  const upd = { intent: "update", table: "expenses", row: ROW, set: { note: "x" } };
  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ["an op not an object", { x: 1 }, { reason: "malformed", param: "ops/0/x" }],
    ["an unknown op key", { ...upd, sett: {} }, { reason: "malformed", param: "ops/0/sett" }],
    ["no table", { intent: "insert", set: {} }, { reason: "missing", param: "ops/0/table" }],
    ["a table not a string", { ...upd, table: 1 }, { reason: "malformed", param: "ops/0/table" }],
    [
      "a table of another slot",
      { ...upd, table: "health.runs" },
      { reason: "cross_slot", param: "ops/0/table" },
    ],
    [
      "no intent and no revert",
      { table: "expenses", row: ROW, set: {} },
      { reason: "missing", param: "ops/0/intent" },
    ],
    [
      "an unknown intent",
      { ...upd, intent: "upsert" },
      { reason: "malformed", param: "ops/0/intent" },
    ],
    [
      "insert with a row",
      { intent: "insert", table: "expenses", row: ROW, set: {} },
      { reason: "mutually_exclusive", param: "ops/0/row" },
    ],
    [
      "insert with ver",
      { intent: "insert", table: "settings", set: { key: "k" }, ver: "v1.0" },
      { reason: "mutually_exclusive", param: "ops/0/ver" },
    ],
    [
      "insert into a table with an entity_key",
      { intent: "insert", table: "accounts", set: { name: "x" } },
      { reason: "insert_with_entity_key", param: "ops/0/table" },
    ],
    [
      "insert without set",
      { intent: "insert", table: "settings" },
      { reason: "missing", param: "ops/0/set" },
    ],
    [
      "an update without a target",
      { intent: "update", table: "expenses", set: { note: "x" } },
      { reason: "missing", param: "ops/0/row" },
    ],
    [
      "an update of a state table without a target",
      { intent: "update", table: "accounts", set: { limit: 1 } },
      { reason: "missing", param: "ops/0/entity" },
    ],
    [
      "two targets",
      { ...upd, entity: ENTITY },
      { reason: "mutually_exclusive", param: "ops/0/entity" },
    ],
    [
      "a row that is no row ID",
      { ...upd, row: "r_1" },
      { reason: "malformed", param: "ops/0/row" },
    ],
    [
      "a row on a state table",
      { intent: "update", table: "accounts", row: ROW, set: { limit: 1 } },
      { reason: "state_table", param: "ops/0/row" },
    ],
    [
      "an entity on an event table",
      { intent: "update", table: "expenses", entity: ENTITY, set: { note: "x" } },
      { reason: "not_state_table", param: "ops/0/entity" },
    ],
    [
      "an entity that is no entity ID",
      { intent: "update", table: "accounts", entity: ROW, set: { limit: 1 } },
      { reason: "malformed", param: "ops/0/entity" },
    ],
    [
      "an entity_key on an event table",
      { intent: "update", table: "expenses", entity_key: { note: "x" }, set: { note: "x" } },
      { reason: "not_state_table", param: "ops/0/entity_key" },
    ],
    [
      "an entity_key on a state table without one",
      { intent: "update", table: "rooms", entity_key: { guest: "x" }, set: { guest: "x" } },
      { reason: "malformed", param: "ops/0/entity_key" },
    ],
    [
      "an entity_key missing a key field",
      { intent: "update", table: "accounts", entity_key: {}, set: { limit: 1 } },
      { reason: "missing", param: "ops/0/entity_key/name" },
    ],
    [
      "an entity_key with another field",
      {
        intent: "update",
        table: "accounts",
        entity_key: { name: "x", limit: 1 },
        set: { limit: 1 },
      },
      { reason: "malformed", param: "ops/0/entity_key/limit" },
    ],
    [
      "an entity_key not an object",
      { intent: "update", table: "accounts", entity_key: "x", set: { limit: 1 } },
      { reason: "malformed", param: "ops/0/entity_key" },
    ],
    ["a ver of another shape", { ...upd, ver: "57" }, { reason: "malformed", param: "ops/0/ver" }],
    ["a historical ver", { ...upd, ver: "h41.0" }, { reason: "malformed", param: "ops/0/ver" }],
    [
      "a ver with a leading zero",
      { ...upd, ver: "v057.0" },
      { reason: "malformed", param: "ops/0/ver" },
    ],
    [
      "update without set",
      { intent: "update", table: "expenses", row: ROW },
      { reason: "missing", param: "ops/0/set" },
    ],
    ["an empty set", { ...upd, set: {} }, { reason: "malformed", param: "ops/0/set" }],
    ["set not an object", { ...upd, set: [] }, { reason: "malformed", param: "ops/0/set" }],
    [
      "one field twice by case",
      { ...upd, set: { note: "a", NOTE: "b" } },
      { reason: "malformed", param: "ops/0/set/NOTE" },
    ],
    [
      "revoke with set",
      { intent: "revoke", table: "expenses", row: ROW, set: { note: "x" } },
      { reason: "mutually_exclusive", param: "ops/0/set" },
    ],
    [
      "revert with set",
      { ...upd, revert: { undo: 3 } },
      { reason: "mutually_exclusive", param: "ops/0/set" },
    ],
    [
      "revert with intent insert",
      { intent: "insert", table: "settings", revert: { undo: 3 } },
      { reason: "mutually_exclusive", param: "ops/0/revert" },
    ],
    [
      "revert with intent revoke",
      { intent: "revoke", table: "expenses", row: ROW, revert: { undo: 3 } },
      { reason: "mutually_exclusive", param: "ops/0/revert" },
    ],
    [
      "revert with an interval",
      { table: "accounts", entity: ENTITY, revert: { undo: 3 }, valid_from: "2026-11-02" },
      { reason: "mutually_exclusive", param: "ops/0/valid_from" },
    ],
    [
      "revert without undo",
      { table: "expenses", row: ROW, revert: {} },
      { reason: "missing", param: "ops/0/revert/undo" },
    ],
    [
      "revert undo 0",
      { table: "expenses", row: ROW, revert: { undo: 0 } },
      { reason: "malformed", param: "ops/0/revert/undo" },
    ],
    [
      "revert with an unknown key",
      { table: "expenses", row: ROW, revert: { undo: 1, x: 1 } },
      { reason: "malformed", param: "ops/0/revert/x" },
    ],
    [
      "include_later not a boolean",
      { table: "expenses", row: ROW, revert: { undo: 1, include_later: "yes" } },
      { reason: "malformed", param: "ops/0/revert/include_later" },
    ],
    [
      "acknowledge not a list",
      { ...upd, acknowledge: "overwrite" },
      { reason: "malformed", param: "ops/0/acknowledge" },
    ],
    [
      "an unknown acknowledge value",
      { ...upd, acknowledge: ["overwrite", "all"] },
      { reason: "malformed", param: "ops/0/acknowledge/1" },
    ],
    [
      "an evidence reference out of range",
      { ...upd, evidence_refs: [0] },
      { reason: "index_out_of_range", param: "ops/0/evidence_refs/0" },
    ],
    [
      "an evidence reference not an integer",
      { ...upd, evidence_refs: ["0"] },
      { reason: "malformed", param: "ops/0/evidence_refs/0" },
    ],
  ])("refuses %s", (_, o, error) => {
    expect(errorOf(normalize(op(o)))).toEqual({ code: "invalid_argument", ...error });
  });

  it.each([
    ["premises", { premises: [] }, "ops/0/premises"],
    ["external_key", { external_key: { k: "1" } }, "ops/0/external_key"],
    ["as", { as: "p1" }, "ops/0/as"],
    ["revert.to", { revert: { to: 3, fields: ["note"] }, set: undefined }, "ops/0/revert/to"],
  ])("%s is not in this version", (_, extra, param) => {
    const o = { intent: "update", table: "expenses", row: ROW, set: { note: "x" }, ...extra };
    if (o.set === undefined) delete (o as { set?: unknown }).set;
    expect(errorOf(normalize(op(o)))).toEqual({
      code: "not_in_this_version",
      reason: "parameter",
      param,
    });
  });

  it("unknown tables and fields come with the nearest names; aliases are not names", () => {
    expect(errorOf(normalize(op({ intent: "insert", table: "expnses", set: {} })))).toEqual({
      code: "unknown_table",
      param: "ops/0/table",
      name: "expnses",
      nearest: ["expenses", "runs", "rooms"],
    });
    expect(errorOf(normalize(op({ intent: "insert", table: "spending", set: {} })))).toMatchObject({
      code: "unknown_table",
    });
    expect(
      errorOf(normalize(op({ intent: "update", table: "expenses", row: ROW, set: { amout: 1 } }))),
    ).toEqual({
      code: "unknown_field",
      param: "ops/0/set/amout",
      name: "amout",
      nearest: ["amount", "account", "at"],
    });
    expect(
      errorOf(
        normalize(op({ intent: "update", table: "expenses", row: ROW, set: { row_id: "x" } })),
      ),
    ).toMatchObject({
      code: "unknown_field",
      name: "row_id",
    });
    expect(
      errorOf(
        normalize(op({ intent: "update", table: "expenses", row: ROW, set: { toString: "x" } })),
      ),
    ).toMatchObject({
      code: "unknown_field",
      name: "toString",
    });
  });

  it("a derived table is read-only", () => {
    expect(
      errorOf(normalize(op({ intent: "insert", table: "weekly", set: { day: "2026-11-10" } }))),
    ).toEqual({
      code: "derived_readonly",
      param: "ops/0/table",
      table: "weekly",
      base_tables: ["runs"],
    });
  });

  it("the first problem of the shape wins over value problems, in document order", () => {
    const r = normalize({
      ops: [
        { intent: "update", table: "expenses", row: ROW, set: { pieces: "x" } },
        { intent: "update", table: "expenses", row: ROW, set: { note: "x" }, premises: [] },
        { intent: "upsert", table: "expenses" },
      ],
    });
    expect(errorOf(r)).toEqual({
      code: "not_in_this_version",
      reason: "parameter",
      param: "ops/1/premises",
    });
  });
});

describe("sv compatibility (04-contract §2)", () => {
  const changed = (sv: number): ChangedFields =>
    sv === 1
      ? new Map([
          ["t1/f4", "tighten_constraint"],
          ["t1/f5", "change_type"],
          ["t2/f1", "change_type"],
          ["t3/*", "change_time_type"],
        ] as const)
      : new Map();
  const at = (params: Record<string, unknown>) =>
    normalize({ ...params, sv: 1 }, { currentSv: 2, changedSince: changed });

  it("refuses writing a field changed since the request's version, with each change", () => {
    expect(
      errorOf(
        at(
          op({
            intent: "update",
            table: "expenses",
            row: ROW,
            set: { paid: true, Note: "x", pieces: 2 },
          }),
        ),
      ),
    ).toEqual({
      code: "schema_incompatible",
      param: "ops/0/set/Note",
      current_sv: 2,
      changed_fields: [
        { field: "note", change: "tighten_constraint" },
        { field: "pieces", change: "change_type" },
      ],
    });
    expect(
      errorOf(
        at(
          op({ intent: "update", table: "accounts", entity_key: { name: "x" }, set: { limit: 1 } }),
        ),
      ),
    ).toEqual({
      code: "schema_incompatible",
      param: "ops/0/entity_key/name",
      current_sv: 2,
      changed_fields: [{ field: "name", change: "change_type" }],
    });
  });

  it("refuses any write to a table changed as a whole, at its table", () => {
    expect(
      errorOf(at(op({ intent: "revoke", table: "rooms", entity: ENTITY, ver: "v3.0" }))),
    ).toEqual({
      code: "schema_incompatible",
      param: "ops/0/table",
      current_sv: 2,
      changed_fields: [{ field: "*", change: "change_time_type" }],
    });
  });

  it("takes an older version writing only unchanged fields; the current version is never checked", () => {
    expect(at(op({ intent: "update", table: "expenses", row: ROW, set: { paid: true } })).ok).toBe(
      true,
    );
    const seen: number[] = [];
    normalize(
      { ...insertExpense({ note: "x" }), sv: 2 },
      {
        currentSv: 2,
        changedSince: (sv) => {
          seen.push(sv);
          return changed(1);
        },
      },
    );
    expect(seen).toEqual([]);
  });

  it("after the caller's fallback, a table the version found does not have is unknown_table", () => {
    const r = normalize(insertExpense(), { currentSv: 3 });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const check = (sv: number) =>
      checkSvCompatibility({
        request: r.request,
        sv,
        currentSv: 3,
        changedSince: () => new Map(),
        tableVersions: new Map([["t1", { from: 2, to: 3 }]]),
        tables: [
          { id: "t1", name: "expenses" },
          { id: "t2", name: "accounts" },
        ],
      });
    expect(check(1)).toEqual({
      code: "unknown_table",
      param: "ops/0/table",
      name: "expenses",
      nearest: expect.not.arrayContaining(["expenses"]),
    });
    expect(check(2)).toBeUndefined();
  });

  it("checks a request without sv after the caller's fallback, by checkSvCompatibility", () => {
    const r = normalize(
      op({ intent: "update", table: "expenses", row: ROW, set: { paid: true, note: "x" } }),
      { currentSv: 2, changedSince: changed },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.request.ops[0]?.named).toEqual([
      { field: "f7", name: "paid", param: "ops/0/set/paid" },
      { field: "f4", name: "note", param: "ops/0/set/note" },
    ]);
    const seen: number[] = [];
    const check = (sv: number) =>
      checkSvCompatibility({
        request: r.request,
        sv,
        currentSv: 2,
        changedSince: (s) => {
          seen.push(s);
          return changed(s);
        },
      });
    expect(check(2)).toBeUndefined();
    expect(seen).toEqual([]);
    expect(check(1)).toEqual({
      code: "schema_incompatible",
      param: "ops/0/set/note",
      current_sv: 2,
      changed_fields: [{ field: "note", change: "tighten_constraint" }],
    });
  });
});

describe("evidence (04-contract §3)", () => {
  const ev = (evidence: unknown) => normalize({ ...insertExpense(), evidence });

  it("normalizes segments: stated_at in UTC, sha256 in lower case", () => {
    const r = ev([
      {
        kind: "user_message",
        text: "lunch 45",
        stated_at: "2026-11-10T12:00:00+08:00",
        level: "agent_inferred",
      },
      {
        kind: "file_ref",
        name: "r.pdf",
        mime: "application/pdf",
        size: 10,
        sha256: "A".repeat(64),
        excerpt: "45",
      },
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.request.evidence).toEqual([
      {
        kind: "user_message",
        text: "lunch 45",
        level: "agent_inferred",
        stated_at: "2026-11-10T04:00:00.000Z",
      },
      {
        kind: "file_ref",
        name: "r.pdf",
        mime: "application/pdf",
        size: 10,
        sha256: "a".repeat(64),
        excerpt: "45",
      },
    ]);
  });

  it.each<[string, unknown, Record<string, unknown>]>([
    ["not a list", {}, { code: "invalid_argument", reason: "malformed", param: "evidence" }],
    [
      "a segment without kind",
      [{ text: "x" }],
      { code: "invalid_argument", reason: "missing", param: "evidence/0/kind" },
    ],
    [
      "an unknown kind",
      [{ kind: "photo" }],
      { code: "invalid_argument", reason: "malformed", param: "evidence/0/kind" },
    ],
    [
      "empty text",
      [{ kind: "user_message", text: "" }],
      { code: "invalid_argument", reason: "malformed", param: "evidence/0/text" },
    ],
    [
      "no text",
      [{ kind: "agent_note" }],
      { code: "invalid_argument", reason: "missing", param: "evidence/0/text" },
    ],
    [
      "an unknown segment key",
      [{ kind: "agent_note", text: "x", by: "me" }],
      { code: "invalid_argument", reason: "malformed", param: "evidence/0/by" },
    ],
    [
      "stated_at without an offset",
      [{ kind: "agent_note", text: "x", stated_at: "2026-11-10T12:00:00" }],
      { code: "invalid_argument", reason: "malformed", param: "evidence/0/stated_at" },
    ],
    [
      "an unknown level",
      [{ kind: "agent_note", text: "x", level: "sure" }],
      { code: "invalid_argument", reason: "malformed", param: "evidence/0/level" },
    ],
    [
      "external_authority",
      [{ kind: "agent_note", text: "x", level: "external_authority" }],
      { code: "not_in_this_version", reason: "value", param: "evidence/0/level" },
    ],
    [
      "a source_ref whose id is no source ID",
      [{ kind: "source_ref", id: "s_x" }],
      { code: "invalid_argument", reason: "malformed", param: "evidence/0/id" },
    ],
    [
      "a source_ref without id",
      [{ kind: "source_ref" }],
      { code: "invalid_argument", reason: "missing", param: "evidence/0/id" },
    ],
    [
      "a source_ref with a key of a text segment",
      [{ kind: "source_ref", id: `s_${"1".repeat(16)}`, level: "user_stated" }],
      { code: "invalid_argument", reason: "malformed", param: "evidence/0/level" },
    ],
    [
      "a file_ref without size",
      [{ kind: "file_ref", name: "a", mime: "b", sha256: "a".repeat(64) }],
      { code: "invalid_argument", reason: "missing", param: "evidence/0/size" },
    ],
    [
      "a file_ref with a bad hash",
      [{ kind: "file_ref", name: "a", mime: "b", size: 1, sha256: "xyz" }],
      { code: "invalid_argument", reason: "malformed", param: "evidence/0/sha256" },
    ],
    [
      "a segment over 32 KB",
      [{ kind: "agent_note", text: "说".repeat(11_000) }],
      {
        code: "too_large",
        reason: "evidence_segment",
        param: "evidence/0/text",
        limit_bytes: 32768,
        actual_bytes: 33000,
      },
    ],
    [
      "a request over 256 KB",
      Array.from({ length: 9 }, () => ({ kind: "agent_note", text: "a".repeat(30_000) })),
      {
        code: "too_large",
        reason: "request",
        param: "evidence",
        limit_bytes: 262144,
        actual_bytes: 270000,
      },
    ],
  ])("refuses %s", (_, evidence, error) => {
    expect(errorOf(ev(evidence))).toEqual(error);
  });

  it("counts only text and excerpt", () => {
    // 200 × (256 + 256 + 2048) characters of name, mime and origin: about 500 KB, not counted.
    const big = {
      kind: "file_ref",
      name: "n".repeat(256),
      mime: "m".repeat(256),
      origin: "o".repeat(2048),
      size: 1,
      sha256: "a".repeat(64),
    };
    expect(ev(Array.from({ length: 200 }, () => big)).ok).toBe(true);
  });
});

describe("an op's own evidence (04-contract §3)", () => {
  const SOURCE = `s_${"1".repeat(16)}`;
  const own = (evidence: unknown, more: Record<string, unknown> = {}) =>
    normalize(
      op({ intent: "update", table: "expenses", row: ROW, set: { note: "x" }, evidence }, more),
    );

  it("is the op's, beside the request's; a source_ref is taken as it is", () => {
    const r = own(
      [
        { kind: "user_message", text: "it was x" },
        { kind: "source_ref", id: SOURCE },
      ],
      {
        evidence: [{ kind: "agent_note", text: "noted" }],
      },
    );
    expect(onlyOp(r).evidence).toEqual([
      { kind: "user_message", text: "it was x" },
      { kind: "source_ref", id: SOURCE },
    ]);
    expect(r.ok && r.request.evidence).toEqual([{ kind: "agent_note", text: "noted" }]);
  });

  it.each<[string, unknown, Record<string, unknown>]>([
    [
      "external_authority",
      [{ kind: "agent_note", text: "x", level: "external_authority" }],
      { code: "not_in_this_version", reason: "value", param: "ops/0/evidence/0/level" },
    ],
    [
      "a segment over 32 KB",
      [{ kind: "agent_note", text: "说".repeat(11_000) }],
      {
        code: "too_large",
        reason: "evidence_segment",
        param: "ops/0/evidence/0/text",
        limit_bytes: 32_768,
        actual_bytes: 33_000,
      },
    ],
    [
      "not an array",
      { kind: "agent_note", text: "x" },
      { code: "invalid_argument", reason: "malformed", param: "ops/0/evidence" },
    ],
  ])("refuses %s, at the op's segment", (_, evidence, error) => {
    expect(errorOf(own(evidence))).toEqual(error);
  });

  it("counts toward the request's 256 KB with the request's own", () => {
    // 8 segments of 30,000 bytes in the request, one more in the op: 270,000 bytes in all.
    const seg = { kind: "agent_note", text: "x".repeat(30_000) };
    const r = own([seg], { evidence: Array.from({ length: 8 }, () => seg) });
    expect(errorOf(r)).toEqual({
      code: "too_large",
      reason: "request",
      param: "evidence",
      limit_bytes: 262_144,
      actual_bytes: 270_000,
    });
    // Without the op's segment, the request's alone is within the limit.
    expect(
      normalize(
        op(
          { intent: "update", table: "expenses", row: ROW, set: { note: "x" } },
          {
            evidence: Array.from({ length: 8 }, () => seg),
          },
        ),
      ).ok,
    ).toBe(true);
  });
});

describe("evidence by field (04-contract §3)", () => {
  const SOURCE = `s_${"1".repeat(16)}`;
  const seg = (text: string) => ({ kind: "agent_note", text });
  const upd = (more: Record<string, unknown>, set: Record<string, unknown> = { note: "x" }) => ({
    intent: "update",
    table: "expenses",
    row: ROW,
    set,
    ...more,
  });
  const byField = (r: ReturnType<typeof normalize>) => {
    const m = onlyOp(r).evidenceByField;
    return m === undefined
      ? undefined
      : {
          fields: Object.fromEntries(m.fields),
          ...(m.valid !== undefined ? { valid: m.valid } : {}),
        };
  };

  it("maps a field by name, case folded, to the indices of the segments it sees", () => {
    const r = normalize(
      op(upd({ evidence_by_field: { NOTE: [1], pieces: [0, 1] } }, { note: "x", pieces: 2 }), {
        evidence: [seg("a"), seg("b")],
      }),
    );
    expect(byField(r)).toEqual({ fields: { f4: [1], f5: [0, 1] } });
  });

  it("counts the op's own segments first, then the request's it cites", () => {
    const r = (more: Record<string, unknown>, map: number[]) =>
      normalize(
        op(upd({ evidence: [seg("own")], evidence_by_field: { note: map }, ...more }), {
          evidence: [seg("a"), seg("b"), seg("c")],
        }),
      );
    // Own segment 0, then request segments 2 and 0 as cited: three seen.
    expect(byField(r({ evidence_refs: [2, 0] }, [2]))).toEqual({ fields: { f4: [2] } });
    expect(errorOf(r({ evidence_refs: [2, 0] }, [3]))).toEqual({
      code: "invalid_argument",
      reason: "index_out_of_range",
      param: "ops/0/evidence_by_field/note/0",
    });
  });

  it("an op with its own segments and no evidence_refs sees only its own", () => {
    // The request's three segments are not cited: index 1 is out of range.
    const r = (map: number[]) =>
      normalize(
        op(upd({ evidence: [seg("own")], evidence_by_field: { note: map } }), {
          evidence: [seg("a"), seg("b"), seg("c")],
        }),
      );
    expect(byField(r([0]))).toEqual({ fields: { f4: [0] } });
    expect(errorOf(r([1]))).toEqual({
      code: "invalid_argument",
      reason: "index_out_of_range",
      param: "ops/0/evidence_by_field/note/0",
    });
  });

  it("an op with neither sees all the request's segments; a source_ref is a segment like any", () => {
    const r = normalize(
      op(upd({ evidence_by_field: { note: [1] } }), {
        evidence: [seg("a"), { kind: "source_ref", id: SOURCE }],
      }),
    );
    expect(byField(r)).toEqual({ fields: { f4: [1] } });
  });

  it("`valid` maps the interval of a write or a revoke on a state table", () => {
    const acc = (o: Record<string, unknown>) =>
      normalize(
        op(
          { table: "accounts", entity: ENTITY, valid_from: "2026-11-02", ...o },
          {
            evidence: [seg("a"), seg("b")],
          },
        ),
      );
    expect(
      byField(
        acc({ intent: "update", set: { limit: 5 }, evidence_by_field: { valid: [1], limit: [0] } }),
      ),
    ).toEqual({ fields: { f2: [0] }, valid: [1] });
    expect(byField(acc({ intent: "revoke", evidence_by_field: { valid: [0] } }))).toEqual({
      fields: {},
      valid: [0],
    });
  });

  it("an entity_key's key field can be mapped: it is a field the op gives", () => {
    const r = normalize(
      op(
        {
          intent: "update",
          table: "accounts",
          entity_key: { name: "Cash" },
          set: { limit: 5 },
          evidence_by_field: { name: [0] },
        },
        { evidence: [seg("a")] },
      ),
    );
    expect(byField(r)).toEqual({ fields: { f1: [0] } });
  });

  it("an empty object is as if not given, on an undo too", () => {
    expect(
      byField(normalize(op(upd({ evidence_by_field: {} }), { evidence: [seg("a")] }))),
    ).toBeUndefined();
    const undo = normalize(
      op(
        { table: "expenses", row: ROW, revert: { undo: 3 }, evidence_by_field: {} },
        { evidence: [seg("a")] },
      ),
    );
    expect(undo.ok).toBe(true);
    expect(byField(undo)).toBeUndefined();
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      "a revoke by entity_key, mapping its key field (a revoke maps only `valid`)",
      {
        intent: "revoke",
        table: "accounts",
        entity_key: { name: "Cash" },
        valid_from: "2026-11-02",
        evidence_by_field: { name: [0], valid: [0] },
      },
      "ops/0/evidence_by_field/name",
    ],
    [
      "`valid` on a write giving no interval (from now to the next change)",
      {
        intent: "update",
        table: "accounts",
        entity: ENTITY,
        set: { limit: 5 },
        evidence_by_field: { valid: [0] },
      },
      "ops/0/evidence_by_field/valid",
    ],
    [
      "`valid` on a revoke of the whole entity",
      { intent: "revoke", table: "accounts", entity: ENTITY, evidence_by_field: { valid: [0] } },
      "ops/0/evidence_by_field/valid",
    ],
  ])("refuses %s: malformed", (_, o, param) => {
    expect(errorOf(normalize(op(o, { evidence: [seg("a")] })))).toEqual({
      code: "invalid_argument",
      reason: "malformed",
      param,
    });
  });

  it("`valid` with one end given: an end alone is an interval", () => {
    const r = normalize(
      op(
        {
          intent: "update",
          table: "accounts",
          entity: ENTITY,
          set: { limit: 5 },
          valid_to: "2026-11-20",
          evidence_by_field: { valid: [0] },
        },
        { evidence: [seg("a")] },
      ),
    );
    expect(byField(r)).toEqual({ fields: {}, valid: [0] });
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    [
      "not an object",
      upd({ evidence_by_field: [0] }),
      { reason: "malformed", param: "ops/0/evidence_by_field" },
    ],
    [
      "a mapping not an array",
      upd({ evidence_by_field: { note: 0 } }),
      { reason: "malformed", param: "ops/0/evidence_by_field/note" },
    ],
    [
      "an empty mapping",
      upd({ evidence_by_field: { note: [] } }),
      { reason: "empty_mapping", param: "ops/0/evidence_by_field/note" },
    ],
    [
      "an index not an integer",
      upd({ evidence_by_field: { note: ["0"] } }),
      { reason: "malformed", param: "ops/0/evidence_by_field/note/0" },
    ],
    [
      "an index twice",
      upd({ evidence_by_field: { note: [0, 0] } }),
      { reason: "malformed", param: "ops/0/evidence_by_field/note/1" },
    ],
    [
      "a negative index",
      upd({ evidence_by_field: { note: [-1] } }),
      { reason: "index_out_of_range", param: "ops/0/evidence_by_field/note/0" },
    ],
    [
      "a field of the table this op gives no value",
      upd({ evidence_by_field: { pieces: [0] } }),
      { reason: "malformed", param: "ops/0/evidence_by_field/pieces" },
    ],
    [
      "the same field twice, by case",
      upd({ evidence_by_field: { note: [0], Note: [0] } }),
      { reason: "malformed", param: "ops/0/evidence_by_field/Note" },
    ],
    [
      "a field of a revoke (it gives no value)",
      { intent: "revoke", table: "expenses", row: ROW, evidence_by_field: { note: [0] } },
      { reason: "malformed", param: "ops/0/evidence_by_field/note" },
    ],
    [
      "`valid` on a table without business time",
      upd({ evidence_by_field: { valid: [0] } }),
      { reason: "not_state_table", param: "ops/0/evidence_by_field/valid" },
    ],
    [
      "an undo (it writes no value of its own)",
      { table: "expenses", row: ROW, revert: { undo: 3 }, evidence_by_field: { note: [0] } },
      { reason: "mutually_exclusive", param: "ops/0/evidence_by_field" },
    ],
  ])("refuses %s", (_, o, error) => {
    expect(errorOf(normalize(op(o, { evidence: [seg("a")] })))).toEqual({
      code: "invalid_argument",
      ...error,
    });
  });

  it("a name the table does not have: unknown_field, with the nearest names", () => {
    expect(
      errorOf(normalize(op(upd({ evidence_by_field: { nte: [0] } }), { evidence: [seg("a")] }))),
    ).toMatchObject({
      code: "unknown_field",
      param: "ops/0/evidence_by_field/nte",
      name: "nte",
    });
  });
});

describe("the number of evidence segments (04-contract §3: at most 1,000 a request)", () => {
  const ref = (k: number) => ({ kind: "source_ref", id: `s_${String(k).padStart(16, "0")}` });
  const refs = (n: number, from = 0) => Array.from({ length: n }, (_, k) => ref(from + k));
  const upd = { intent: "update", table: "expenses", row: ROW, set: { note: "x" } };

  it("exactly 1,000, the request's and an op's together: taken", () => {
    const r = normalize(op({ ...upd, evidence: refs(1) }, { evidence: refs(999, 1) }));
    expect(r.ok).toBe(true);
  });

  it("1,001: too_large, evidence_segments, with no byte counted (source_ref segments)", () => {
    expect(
      errorOf(normalize(op({ ...upd, evidence: refs(2) }, { evidence: refs(999, 2) }))),
    ).toEqual({
      code: "too_large",
      reason: "evidence_segments",
      param: "evidence",
      limit: 1000,
      actual: 1001,
    });
    // The request's alone, too.
    expect(errorOf(normalize(op(upd, { evidence: refs(1001) })))).toMatchObject({
      reason: "evidence_segments",
      actual: 1001,
    });
  });
});
