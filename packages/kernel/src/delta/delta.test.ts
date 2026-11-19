import type { CompiledBaseTable, FieldValue } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import type { ReadTx } from "../store/ports.ts";
import { targetDelta } from "./delta.ts";
import { sameValue } from "./same-value.ts";
import { type StateCell, segmentsOf, stateAt, stateFromCells } from "./state.ts";
import type { ComparedDelta, EntitySegment, TargetState } from "./types.ts";

const seg = (
  from: string,
  to: string | null,
  values: Record<string, FieldValue>,
  source: Record<string, string> = {},
): EntitySegment => ({ from, to, values, source });
const entity = (...segments: EntitySegment[]): TargetState => ({
  kind: "entity",
  segments,
  revoked: [],
});
const revokedOn = (
  revoked: [string, string | null][],
  ...segments: EntitySegment[]
): TargetState => ({
  kind: "entity",
  segments,
  revoked: revoked.map(([from, to]) => ({ from, to })),
});
const row = (
  presence: "absent" | "live" | "revoked",
  fields: Record<string, [FieldValue, string?]> = {},
): TargetState => ({
  kind: "row",
  presence,
  fields: Object.fromEntries(
    Object.entries(fields).map(([k, [value, source]]) => [k, { value, source: source ?? "" }]),
  ),
});

describe("sameValue", () => {
  it("takes normalised values of every type by their canonical form", () => {
    expect(sameValue("a", "a")).toBe(true);
    expect(sameValue("a", "b")).toBe(false);
    expect(sameValue(true, false)).toBe(false);
    // A decimal is its normalised text: "1.5" and "1.50" are different texts, so different values
    // (a value that is not normalised is not given to it).
    expect(sameValue("1.5", "1.5")).toBe(true);
    expect(sameValue("1.5", "1.50")).toBe(false);
    expect(sameValue({ value: "5", unit: "km" }, { value: "5", unit: "km" })).toBe(true);
    expect(sameValue({ value: "5", unit: "km" }, { value: "5", unit: "mi" })).toBe(false);
    const z = { instant: "2026-11-01T00:00:00.000Z" as never, zone: "Asia/Shanghai" };
    expect(sameValue(z, { zone: "Asia/Shanghai", instant: z.instant })).toBe(true);
    expect(sameValue(z, { ...z, zone: "UTC" })).toBe(false);
  });

  it("tells empty from non-empty, and takes no value for nothing it can compare", () => {
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(null, "")).toBe(false);
    expect(sameValue(false, null)).toBe(false);
    // No value is not an empty value: it is refused, whichever side it is on.
    expect(() => sameValue(undefined as never, null)).toThrow(TypeError);
    expect(() => sameValue(null, undefined as never)).toThrow(TypeError);
    expect(() => sameValue(undefined as never, undefined as never)).toThrow(TypeError);
  });
});

describe("targetDelta of a row", () => {
  it("gives a creation as existence and the fields' values, none with a before, and no null", () => {
    const d = targetDelta(row("absent"), row("live", { f1: ["x"], f2: [null] }));
    expect(d).toEqual([
      { comparable: true, field: "existence", change: "value", after: true },
      { comparable: true, field: "f1", change: "value", after: "x" },
    ]);
    for (const x of d) expect(x).not.toHaveProperty("before");
    // A row of nulls only is still a creation.
    expect(targetDelta(row("absent"), row("live", { f1: [null] }))).toEqual([
      { comparable: true, field: "existence", change: "value", after: true },
    ]);
  });

  it("gives a revoke and its taking back as existence, and the fields that differ with it", () => {
    const live = row("live", { f1: ["x"], f2: ["p"] });
    const gone = row("revoked", { f1: ["x"], f2: ["p"] });
    expect(targetDelta(live, gone)).toEqual([
      { comparable: true, field: "existence", change: "value", before: true, after: false },
    ]);
    expect(targetDelta(gone, live)).toEqual([
      { comparable: true, field: "existence", change: "value", before: false, after: true },
    ]);
    // A field written in the same operation is listed too, the row there or not.
    const written = row("revoked", { f1: ["y"], f2: ["p"] });
    expect(targetDelta(live, written)).toEqual([
      { comparable: true, field: "existence", change: "value", before: true, after: false },
      { comparable: true, field: "f1", change: "value", before: "x", after: "y" },
    ]);
    expect(targetDelta(gone, row("live", { f1: ["y"], f2: ["p"] }))).toEqual([
      { comparable: true, field: "existence", change: "value", before: false, after: true },
      { comparable: true, field: "f1", change: "value", before: "x", after: "y" },
    ]);
  });

  it("gives a row seen before its creation and revoked now as the fields, and existence", () => {
    const d = targetDelta(row("absent"), row("revoked", { f1: ["x"] }));
    expect(d).toEqual([
      { comparable: true, field: "existence", change: "value", after: false },
      { comparable: true, field: "f1", change: "value", after: "x" },
    ]);
    expect(d[0]).not.toHaveProperty("before");
  });

  it("is nothing for a row with no cell on either side, and refuses a row that goes absent", () => {
    expect(targetDelta(row("absent"), row("absent"))).toEqual([]);
    expect(() => targetDelta(row("live", { f1: ["x"] }), row("absent"))).toThrow(RangeError);
    expect(() => targetDelta(row("revoked", { f1: ["x"] }), row("absent"))).toThrow(RangeError);
  });

  it("tells value, source only and none apart, in the order of the IDs", () => {
    const b = row("live", { f10: ["a", "s1"], f2: ["a", "s1"], f3: ["a", "s1"] });
    const a = row("live", { f10: ["b", "s1"], f2: ["a", "s2"], f3: ["a", "s1"] });
    expect(targetDelta(b, a)).toEqual([
      { comparable: true, field: "f2", change: "source_only", before: "a", after: "a" },
      { comparable: true, field: "f10", change: "value", before: "a", after: "b" },
    ]);
  });

  it("lists a value cleared as a change to an empty value, which is a value", () => {
    expect(targetDelta(row("live", { f1: ["a"] }), row("live", { f1: [null] }))).toEqual([
      { comparable: true, field: "f1", change: "value", before: "a", after: null },
    ]);
  });

  it("refuses to compare a row with an entity", () => {
    expect(() => targetDelta(row("live"), entity())).toThrow(TypeError);
  });
});

describe("targetDelta of an entity", () => {
  it("is nothing when only the cut differs", () => {
    const one = entity(seg("2026-11-01", null, { f1: "a" }));
    const cut = entity(
      seg("2026-11-01", "2026-11-10", { f1: "a" }),
      seg("2026-11-10", "2026-11-20", { f1: "a" }),
      seg("2026-11-20", null, { f1: "a" }),
    );
    expect(targetDelta(one, cut)).toEqual([]);
    expect(targetDelta(cut, one)).toEqual([]);
  });

  it("gives the stretch that changed, however either side is cut", () => {
    const before = entity(
      seg("2026-11-01", "2026-11-10", { f1: "a" }),
      seg("2026-11-10", null, { f1: "a" }),
    );
    const after = entity(
      seg("2026-11-01", "2026-11-05", { f1: "a" }),
      seg("2026-11-05", "2026-11-15", { f1: "b" }),
      seg("2026-11-15", null, { f1: "a" }),
    );
    expect(targetDelta(before, after)).toEqual([
      {
        comparable: true,
        field: "f1",
        change: "value",
        stretches: [
          { from: "2026-11-05", to: "2026-11-15", change: "value", before: "a", after: "b" },
        ],
      },
    ]);
  });

  it("runs adjacent stretches with the same values together, and not across a stretch that did not change", () => {
    const before = entity(
      seg("2026-11-01", "2026-11-05", { f1: "a" }),
      seg("2026-11-05", "2026-11-08", { f1: "b" }),
      seg("2026-11-08", "2026-11-12", { f1: "a" }),
      seg("2026-11-12", null, { f1: "a" }),
    );
    const after = entity(
      seg("2026-11-01", "2026-11-03", { f1: "x" }),
      seg("2026-11-03", "2026-11-05", { f1: "x" }),
      seg("2026-11-05", "2026-11-08", { f1: "b" }),
      seg("2026-11-08", "2026-11-12", { f1: "x" }),
      seg("2026-11-12", null, { f1: "x" }),
    );
    expect(targetDelta(before, after)).toMatchObject([
      {
        stretches: [
          { from: "2026-11-01", to: "2026-11-05", before: "a", after: "x" },
          { from: "2026-11-08", to: null, before: "a", after: "x" },
        ],
      },
    ]);
  });

  it("does not run stretches together that differ in what they were or became", () => {
    const before = entity(
      seg("2026-11-01", "2026-11-05", { f1: "a" }),
      seg("2026-11-05", null, { f1: "b" }),
    );
    const after = entity(seg("2026-11-01", null, { f1: "x" }));
    expect(targetDelta(before, after)).toMatchObject([
      {
        stretches: [
          { from: "2026-11-01", to: "2026-11-05", before: "a", after: "x" },
          { from: "2026-11-05", to: null, before: "b", after: "x" },
        ],
      },
    ]);
  });

  it("gives a stretch that gains or loses a value, with no member for the side that has none", () => {
    const whole = entity(seg("2026-11-01", null, { f1: "a" }));
    const gap = entity(
      seg("2026-11-01", "2026-11-05", { f1: "a" }),
      seg("2026-11-08", null, { f1: "a" }),
    );
    const only = (d: ReturnType<typeof targetDelta>) =>
      d.filter((x) => x.field !== "existence").map((x) => x.comparable && x.stretches);
    expect(only(targetDelta(whole, gap))).toEqual([
      [{ from: "2026-11-05", to: "2026-11-08", change: "value", before: "a" }],
    ]);
    expect(only(targetDelta(gap, whole))).toEqual([
      [{ from: "2026-11-05", to: "2026-11-08", change: "value", after: "a" }],
    ]);
    expect(only(targetDelta(entity(), whole))).toEqual([
      [{ from: "2026-11-01", to: null, change: "value", after: "a" }],
    ]);
  });

  it("does not take an empty value on one side and no value on the other for a change of the field", () => {
    const empty = entity(seg("2026-11-01", null, { f1: null }, { f1: "s1" }));
    // Only `existence` says the stretch gained or lost its value.
    expect(targetDelta(empty, entity())).toEqual([
      {
        comparable: true,
        field: "existence",
        change: "value",
        stretches: [{ from: "2026-11-01", to: null, change: "value", before: true }],
      },
    ]);
    expect(targetDelta(entity(), empty)).toEqual([
      {
        comparable: true,
        field: "existence",
        change: "value",
        stretches: [{ from: "2026-11-01", to: null, change: "value", after: true }],
      },
    ]);
    // Revoked, it is `existence` alone that says so.
    expect(targetDelta(empty, revokedOn([["2026-11-01", null]]))).toEqual([
      {
        comparable: true,
        field: "existence",
        change: "value",
        stretches: [{ from: "2026-11-01", to: null, change: "value", before: true, after: false }],
      },
    ]);
  });

  it("tells a stretch never written, one revoked and one revoked in part apart", () => {
    const whole = entity(seg("2026-11-01", null, { f1: "a" }));
    const never = entity();
    const revoked = revokedOn([["2026-11-01", null]]);
    const partly = revokedOn(
      [["2026-11-05", "2026-11-08"]],
      seg("2026-11-01", "2026-11-05", { f1: "a" }),
      seg("2026-11-08", null, { f1: "a" }),
    );
    const existence = (d: ReturnType<typeof targetDelta>) =>
      d.find((x) => x.field === "existence") as ComparedDelta | undefined;
    expect(existence(targetDelta(never, never))).toBeUndefined();
    // Never written against live: a creation, given by its `after`; the other way, a loss.
    expect(existence(targetDelta(never, whole))).toMatchObject({
      stretches: [{ from: "2026-11-01", to: null, after: true }],
    });
    expect(existence(targetDelta(whole, never))?.stretches?.[0]).toEqual({
      from: "2026-11-01",
      to: null,
      change: "value",
      before: true,
    });
    expect(existence(targetDelta(whole, revoked))).toMatchObject({
      stretches: [{ from: "2026-11-01", to: null, before: true, after: false }],
    });
    expect(existence(targetDelta(whole, partly))).toMatchObject({
      stretches: [{ from: "2026-11-05", to: "2026-11-08", before: true, after: false }],
    });
    expect(existence(targetDelta(partly, whole))).toMatchObject({
      stretches: [{ from: "2026-11-05", to: "2026-11-08", before: false, after: true }],
    });
    // Seen before it was there and revoked now differs from live and revoked now.
    expect(existence(targetDelta(never, revoked))?.stretches?.[0]).toEqual({
      from: "2026-11-01",
      to: null,
      change: "value",
      after: false,
    });
    // Seen and now the same revoke, cut another way: nothing.
    expect(
      targetDelta(
        revokedOn([["2026-11-05", "2026-11-08"]]),
        revokedOn([
          ["2026-11-05", "2026-11-06"],
          ["2026-11-06", "2026-11-08"],
        ]),
      ),
    ).toEqual([]);
  });

  it("takes the strongest of a field's stretches as its change", () => {
    const before = entity(seg("2026-11-01", null, { f1: "a" }, { f1: "s1" }));
    const only = entity(
      seg("2026-11-01", "2026-11-05", { f1: "a" }, { f1: "s2" }),
      seg("2026-11-05", null, { f1: "a" }, { f1: "s1" }),
    );
    expect(targetDelta(before, only)).toMatchObject([{ change: "source_only" }]);
    const both = entity(
      seg("2026-11-01", "2026-11-05", { f1: "a" }, { f1: "s2" }),
      seg("2026-11-05", null, { f1: "b" }, { f1: "s1" }),
    );
    expect(targetDelta(before, both)).toMatchObject([
      {
        change: "value",
        stretches: [
          { from: "2026-11-01", to: "2026-11-05", change: "source_only" },
          { from: "2026-11-05", to: null, change: "value" },
        ],
      },
    ]);
  });
});

// A table of text fields f1 and f2 whose cells carry the value in `c_<f>_0`.
const TABLE = {
  id: "t1",
  time: { type: "state", granularity: "date" },
  physical: { table: "t_t1_v1" },
  fields: [
    { id: "f1", name: "a", type: "text" },
    { id: "f2", name: "b", type: "text" },
  ],
} as unknown as CompiledBaseTable;
const decode = (_f: unknown, cols: readonly unknown[]): FieldValue => (cols[0] ?? null) as never;
const cell = (field: string, vf: string | null, vt: string | null, value: string | null, o = {}) =>
  ({
    field_id: field,
    vf,
    vt,
    revoked: false,
    no_value: false,
    [`c_${field}_0`]: value,
    ...o,
  }) as StateCell;

describe("a state from cells", () => {
  it("leaves out where an entity has no value and where a revoke is in effect, and runs equal pieces together", () => {
    const cells = [
      cell("f1", "2026-11-01", "2026-11-05", "x"),
      cell("f2", "2026-11-01", "2026-11-05", "y"),
      cell("f1", "2026-11-05", "2026-11-08", "x"),
      cell("f2", "2026-11-05", "2026-11-08", "y"),
      cell("f1", "2026-11-08", "2026-11-10", null, { no_value: true }),
      cell("f2", "2026-11-08", "2026-11-10", null, { no_value: true }),
      cell("existence", "2026-11-10", "2026-11-12", null, { revoked: true }),
      cell("f1", "2026-11-10", "2026-11-12", "x"),
      cell("f1", "2026-11-12", null, "z"),
    ];
    const segs = segmentsOf(TABLE, cells, { decode });
    expect(segs.map((s) => [s.from, s.to, s.values["f1"] ?? null, s.values["f2"] ?? null])).toEqual(
      [
        ["2026-11-01", "2026-11-08", "x", "y"],
        ["2026-11-12", null, "z", null],
      ],
    );
  });

  it("tells a row's three presences", () => {
    const t = { ...TABLE, time: { type: "event", field: "f1" } } as unknown as CompiledBaseTable;
    const live = [cell("existence", null, null, null), cell("f1", null, null, "x")];
    const states = [
      stateFromCells(t, [], { decode }),
      stateFromCells(t, live, { decode }),
      stateFromCells(t, [...live, cell("existence", null, null, null, { revoked: true })], {
        decode,
      }),
    ];
    expect(states.map((x) => x.kind === "row" && x.presence)).toEqual([
      "absent",
      "live",
      "revoked",
    ]);
  });
});

describe("stateAt on a fake transaction", () => {
  const rows = (cells: StateCell[], sources: Record<string, unknown>[] = []) => {
    const asked: { sql: string; params: readonly unknown[] }[] = [];
    const tx: ReadTx = {
      async query<R>(sql: string, params: readonly unknown[] = []) {
        asked.push({ sql, params });
        return { rows: (sql.includes("base_sources") ? sources : cells) as R[] } as never;
      },
    };
    return { tx, asked };
  };
  const row_ = (o: Record<string, unknown>) => ({
    event_seq: 10,
    field_id: "f1",
    k: 0,
    carried_event: null,
    carried_field: null,
    carried_k: null,
    status: "applied",
    valid_from: null,
    valid_to: null,
    reverted: "[]",
    body: null,
    ...o,
  });
  const event = { time: { type: "event", field: "f1" } };
  const given = { src_event: 30, src_field: "f1", src_k: 0 };

  it("asks the sources table only when sources are asked for", async () => {
    const t = { ...TABLE, ...event } as unknown as CompiledBaseTable;
    const f = rows([cell("f1", null, null, "x", given)]);
    await stateAt(f.tx, t, "r1", 40, { decode });
    expect(f.asked).toHaveLength(1);
    expect(f.asked[0]?.params).toEqual(["r1", 40]);
    const g = rows([cell("f1", null, null, "x", given)], []);
    await stateAt(g.tx, t, "r1", 40, { decode, sources: true });
    expect(g.asked).toHaveLength(2);
  });

  it("follows carried references to their end and adds corroborations of the same value in force", async () => {
    const t = { ...TABLE, ...event } as unknown as CompiledBaseTable;
    const sources = [
      // 30 carries 20 carries 10; 10 gave the value.
      row_({ event_seq: 30, carried_event: 20, carried_field: "f1", carried_k: 0 }),
      row_({ event_seq: 20, carried_event: 10, carried_field: "f1", carried_k: 0 }),
      row_({ event_seq: 10 }),
      // Corroborations: of the same value, in force; another value; reverted; its content deleted.
      row_({ event_seq: 11, status: "corroborated", body: JSON.stringify({ value: "x" }) }),
      row_({ event_seq: 12, status: "corroborated", body: JSON.stringify({ value: "other" }) }),
      row_({
        event_seq: 13,
        status: "corroborated",
        body: JSON.stringify({ value: "x" }),
        reverted: '[{"op":14,"valid":[]}]',
      }),
      row_({ event_seq: 15, status: "corroborated", body: null }),
    ];
    const f = rows([cell("f1", null, null, "x", given), cell("f2", null, null, "y")], sources);
    const s = await stateAt(f.tx, t, "r1", 40, { decode, sources: true });
    expect(s.kind === "row" && s.fields["f1"]?.source).toBe("10/f1/0,11/f1/0");
    // A cell no write gave has no 出处项.
    expect(s.kind === "row" && s.fields["f2"]?.source).toBe("");
  });

  it("does not follow a carried loop for ever", async () => {
    const t = { ...TABLE, ...event } as unknown as CompiledBaseTable;
    const sources = [
      row_({ event_seq: 30, carried_event: 20, carried_field: "f1", carried_k: 0 }),
      row_({ event_seq: 20, carried_event: 30, carried_field: "f1", carried_k: 0 }),
    ];
    const f = rows([cell("f1", null, null, "x", given)], sources);
    const s = await stateAt(f.tx, t, "r1", 40, { decode, sources: true });
    expect(s.kind === "row" && s.fields["f1"]?.source).toBe("");
  });
});
