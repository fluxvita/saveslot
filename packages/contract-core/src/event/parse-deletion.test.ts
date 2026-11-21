// Shape checks of the deletion events (09-event-format §5.9): a well-formed sample of every block
// shape, then, block by block, the negatives every checker must report (an unknown key, each
// required key missing, every value replaced by another JSON type), the value-level negatives, and
// the rules between the blocks of one event.

import { describe, expect, it } from "vitest";
import { type ParseResult, parseEvent } from "./parse.ts";

const HASH = "a".repeat(64);
const CONN = `ci_${"2".repeat(26)}`;
const SLOT = `sl_${"4".repeat(16)}`;
const ROW = `r_${"6".repeat(26)}`;
const ENTITY = `e_${"7".repeat(26)}`;
const ITEM = `pi_${"8".repeat(16)}`;
const ITEM_B = `pi_${"9".repeat(16)}`;
const AT = "2026-11-10T04:41:07.123Z";

const head = (type: string, seq: number) => ({
  type,
  v: 1,
  seq,
  at: AT,
  prev_hash: HASH,
  actor: CONN,
  slot: SLOT,
});
const tombstone = (seq: number) => ({
  type: "deletion.executed",
  v: 1,
  seq,
  at: AT,
  prev_hash: HASH,
  actor: "system",
  slot: SLOT,
  trigger: "deletion_expiry",
});
const ctx = { now: AT, today: "2026-11-10", ruleset_version: 1, policy_version: 1 };

type Sample = { header: Record<string, unknown>; blocks: Record<string, unknown> };

const SAMPLES: Record<string, Sample> = {
  // A state table: stretches with intervals and deps, the gaps, restatements of every kind.
  "deletion.confirmed": {
    header: head("deletion.confirmed", 42),
    blocks: {
      ctx,
      request_key: { key: "k1" },
      target: {
        deletion: ITEM,
        kind: "privacy",
        due_at: "2026-11-11T04:41:07.123Z",
        sources: [26, 28],
        origin: "request",
      },
      positions: [
        { seq: 26, path: "text" },
        { seq: 27, path: "fields/f3/0" },
        { seq: 42, path: "summary" },
      ],
      summary: { hash: HASH },
      "results/0/target": { table: "t2", entity: ENTITY, outcome: "resegmented" },
      "results/0/fields/f2/0": {
        valid: { from: "2026-11-20" },
        value: { value: "5000", unit: "CNY" },
        sources: [{ kind: "value", carried: { event: 12, field: "f2", k: 0 } }],
        deps: [
          { event: 12, field: "f2", k: 0 },
          { event: 32, field: "f2", k: 0 },
        ],
      },
      "results/0/fields/f2/1": {
        valid: { from: "2026-11-01", to: "2026-11-20" },
        value: null,
        sources: [],
        deps: [{ event: 30, existence: 0 }],
      },
      "results/0/existence": {
        gaps: [{ from: "2026-11-01", to: "2026-11-20" }, {}],
        deps: [{ event: 30, existence: 0 }],
      },
      "restated/0": {
        event: 18,
        field: "f2",
        k: 0,
        status: "applied",
        valid: { from: "2026-11-02" },
        deps: [{ event: 12, field: "f2", k: 0 }],
      },
      "restated/1": { event: 19, field: "f2", k: 1, status: "dropped" },
      "restated/2": {
        event: 33,
        field: "f2",
        k: 0,
        status: "applied",
        valid: { from: "2026-11-01" },
        deps: [{ event: 12, field: "f2", k: 0 }],
        value: { value: "4000", unit: "CNY" },
        sources: [{ kind: "value", carried: { event: 12, field: "f2", k: 0 } }],
      },
      "restated/3": {
        event: 30,
        existence: 0,
        status: "candidate",
        seen_valid: { to: "2026-11-20" },
        deps: [],
      },
      "restated/4": { event: 35, field: "f3", k: 0, status: "applied", no_value: true },
      "restated/5": {
        event: 37,
        existence: 1,
        status: "applied",
        valid: { from: "2026-11-05" },
        restored: true,
      },
      "recreated/0": { event: 18, created: true },
      superseded_items: [ITEM_B],
    },
  },
  // An event table: a stretch without an interval, a schema constant as the value's source.
  "deletion.confirmed (event table)": {
    header: head("deletion.confirmed", 42),
    blocks: {
      ctx,
      target: {
        deletion: ITEM,
        kind: "privacy",
        due_at: "2026-11-11T04:41:07.123Z",
        sources: [26],
        origin: "restored_pending",
      },
      positions: [],
      "results/0/target": { table: "t1", row: ROW, outcome: "fields_reverted" },
      "results/0/fields/f3/0": {
        value: "7",
        sources: [{ kind: "schema_const", sv: 2, field: "f3" }],
      },
      "restated/0": { event: 21, field: "f3", k: 0, status: "awaiting" },
    },
  },
  "deletion.cancelled": {
    header: head("deletion.cancelled", 50),
    blocks: {
      ctx,
      idempotency: { key: "k1", fingerprint: HASH },
      target: { deletion: ITEM, origin: "request" },
      "results/0/target": { table: "t1", row: ROW, outcome: "sources_changed" },
      "results/0/fields/f2/0": {
        value: "7",
        sources: [{ kind: "value", carried: { event: 21, field: "f2", k: 0 } }],
      },
      "restated/0": { event: 21, field: "f2", k: 0, status: "candidate" },
      "recreated/0": { event: 21, created: false },
      restored_items: [ITEM_B],
      "kept_superseded/0": { item: ITEM_B, by_event: 47 },
      "kept_effective/0": {
        event: 31,
        items: [{ field: "f2", k: 0 }, { existence: 0 }],
        by_event: 45,
      },
    },
  },
  "deletion.executed": {
    header: tombstone(60),
    blocks: {
      target: { deletion: ITEM, reason: "expiry" },
      positions: [{ seq: 27, path: "fields/f3/0" }],
    },
  },
};

const parse = (s: Sample): ParseResult => parseEvent(s.header, s.blocks);
const issues = (r: ParseResult): readonly string[] =>
  !r.ok && r.kind === "invalid" ? r.issues : [];
const withBlock = (s: Sample, path: string, value: unknown): Sample => ({
  ...s,
  blocks: { ...s.blocks, [path]: value },
});
const without = (s: Sample, path: string): Sample => {
  const { [path]: _, ...blocks } = s.blocks;
  return { ...s, blocks };
};
const typeOf = (name: string) => name.split(" ")[0] as string;
const S = (name: string) => SAMPLES[name] as Sample;
function patched(name: string, path: string, patch: Record<string, unknown>): Sample {
  const block = { ...(S(name).blocks[path] as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete block[k];
    else block[k] = v;
  }
  return withBlock(S(name), path, block);
}

describe("parseEvent: the deletion events", () => {
  it.each(Object.entries(SAMPLES))("accepts %s", (name, s) => {
    expect(parse(s)).toEqual({ ok: true, type: typeOf(name) });
  });

  // Every object block of every sample: an unknown key is refused; each key the block requires,
  // removed, is refused by the reason given for it (a key a block may leave out is listed by the
  // block's shape, and removing it must be accepted).
  const OPTIONAL: Record<string, readonly string[]> = {
    // an event table's stretch has neither; a state table's has both (refused as a pair below)
    ResultField: [],
    ResultExistence: [],
    Restated: ["valid", "seen_valid", "deps", "restored", "no_value", "uncovered"],
  };
  const shapeOf = (path: string) =>
    /^results\/\d+\/fields\//.test(path)
      ? "ResultField"
      : /^results\/\d+\/existence$/.test(path)
        ? "ResultExistence"
        : /^restated\//.test(path)
          ? "Restated"
          : path;
  const cases = Object.entries(SAMPLES).flatMap(([name, s]) =>
    Object.entries(s.blocks).flatMap(([path, v]) =>
      v !== null && typeof v === "object" && !Array.isArray(v)
        ? [[name, path, v as Record<string, unknown>] as const]
        : [],
    ),
  );
  it.each(cases)("%s %s: refuses an unknown key and a missing required key", (name, path, v) => {
    const s = S(name);
    expect(issues(parse(withBlock(s, path, { ...v, zz: 1 })))).toContain(`${path}: unknown key zz`);
    const optional = OPTIONAL[shapeOf(path)] ?? [];
    for (const k of Object.keys(v)) {
      const { [k]: _, ...rest } = v;
      const got = issues(parse(withBlock(s, path, rest)));
      if (optional.includes(k)) continue;
      // Refused on this block, by the missing key or by the rule the key took part in.
      expect({ k, refusedHere: got.some((x) => x.startsWith(path)) }).toEqual({
        k,
        refusedHere: true,
      });
    }
  });
  it("a state table's stretch needs both its interval and its deps; the gaps need their deps", () => {
    const c = S("deletion.confirmed");
    const f = c.blocks["results/0/fields/f2/0"] as Record<string, unknown>;
    const { valid: _v, ...noValid } = f;
    const { deps: _d, ...noDeps } = f;
    expect(issues(parse(withBlock(c, "results/0/fields/f2/0", noValid)))).toContain(
      "results/0/fields/f2/0: missing key valid",
    );
    expect(issues(parse(withBlock(c, "results/0/fields/f2/0", noDeps)))).toContain(
      "results/0/fields/f2/0: missing key deps",
    );
    const g = c.blocks["results/0/existence"] as Record<string, unknown>;
    const { deps: _g, ...gapsOnly } = g;
    expect(issues(parse(withBlock(c, "results/0/existence", gapsOnly)))).toContain(
      "results/0/existence: missing key deps",
    );
  });
});

describe("parseEvent: every value of a deletion event's blocks is checked", () => {
  // Each leaf replaced by a value of another JSON type is refused (`null` is a field value, so a
  // field value's leaves are replaced by a number or a string as the others).
  const poison = (v: unknown): unknown =>
    typeof v === "string" ? 123 : typeof v === "number" ? "7" : typeof v === "boolean" ? 1 : 0;
  function leaves(v: unknown, at: (string | number)[] = []): (string | number)[][] {
    if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, [...at, i]));
    if (v !== null && typeof v === "object") {
      return Object.entries(v).flatMap(([k, x]) => leaves(x, [...at, k]));
    }
    return [at];
  }
  function replaced(v: unknown, at: readonly (string | number)[], by: unknown): unknown {
    const [h, ...rest] = at;
    if (h === undefined) return by;
    if (Array.isArray(v)) return v.map((x, i) => (i === h ? replaced(x, rest, by) : x));
    const o = v as Record<string, unknown>;
    return { ...o, [h]: replaced(o[h as string], rest, by) };
  }
  const cases = Object.entries(SAMPLES).flatMap(([name, s]) =>
    Object.entries(s.blocks).flatMap(([path, v]) =>
      leaves(v)
        // A field value of a stretch may be a plain string: "7" -> 123 is still refused, and a
        // string value replaced by a number is a value of another type.
        .map((at) => [name, path, at.join("."), at, v] as const),
    ),
  );
  it.each(cases)("%s %s .%s", (name, path, _, at, v) => {
    const s = S(name);
    const bad = replaced(v, at, poison(at.reduce<unknown>((x, k) => (x as never)[k], v)));
    expect(parse(withBlock(s, path, bad)).ok).toBe(false);
  });
});

describe("parseEvent: a deletion event's blocks, value by value", () => {
  const C = "deletion.confirmed";
  // [sample, block, patch, the issue it must report]
  const cases: [string, string, Record<string, unknown>, string][] = [
    [C, "target", { kind: "evidence" }, "target: kind"],
    [C, "target", { origin: "import" }, "target: origin"],
    [C, "target", { sources: [] }, "target.sources: empty"],
    [C, "target", { sources: [26, 26] }, "target.sources: duplicate seq"],
    [C, "target", { deletion: "x_1" }, "target: deletion"],
    [C, "target", { due_at: "2026-11-11" }, "target: due_at"],
    [C, "results/0/target", { outcome: "gone" }, "results/0/target: outcome"],
    [C, "results/0/target", { row: ROW }, "results/0/target: exactly one of row and entity"],
    // An emptied field has no sources; a field with a value has some.
    // An explicit clearing is carried like any value: its carried item must be in deps.
    [
      C,
      "results/0/fields/f2/1",
      { sources: [{ kind: "value", carried: { event: 12, field: "f2", k: 0 } }] },
      "results/0/fields/f2/1: carried not in deps",
    ],
    [C, "results/0/fields/f2/0", { sources: [] }, "results/0/fields/f2/0: a value without sources"],
    [
      C,
      "results/0/fields/f2/0",
      { deps: [{ event: 32, field: "f2", k: 0 }] },
      "results/0/fields/f2/0: carried not in deps",
    ],
    [C, "restated/2", { deps: [] }, "restated/2: carried not in deps"],
    // A result's source is carried or a schema constant, never a direct source.
    [
      C,
      "results/0/fields/f2/0",
      { sources: [{ kind: "value", source: 26 }] },
      "results/0/fields/f2/0.sources[0]: missing key carried",
    ],
    [
      C,
      "results/0/fields/f2/0",
      { sources: [{ kind: "value", carried: { event: 30, existence: 0 } }] },
      "results/0/fields/f2/0.sources[0]: carried from a field item",
    ],
    // State tables give valid and deps together.
    [C, "results/0/fields/f2/0", { deps: undefined }, "results/0/fields/f2/0: missing key deps"],
    [
      C,
      "results/0/fields/f2/0",
      { valid: { from: "2026-11-20", to: "2026-11-01" } },
      "results/0/fields/f2/0.valid: to after from",
    ],
    [C, "results/0/existence", { gaps: [{ from: 1 }] }, "results/0/existence.gaps[0]: from"],
    // Restatements.
    [C, "restated/0", { status: "gone" }, "restated/0: status"],
    [
      C,
      "restated/0",
      { valid: undefined, seen_valid: { from: "2026-11-02" } },
      "restated/0: seen_valid exactly on a candidate",
    ],
    [
      C,
      "restated/3",
      { seen_valid: undefined, valid: { to: "2026-11-20" } },
      "restated/3: seen_valid exactly on a candidate",
    ],
    [
      C,
      "restated/0",
      { seen_valid: { from: "2026-11-02" } },
      "restated/0: at most one of valid and seen_valid",
    ],
    [C, "restated/1", { valid: { from: "2026-11-02" } }, "restated/1: no interval when dropped"],
    [C, "restated/1", { no_value: true }, "restated/1: no value when dropped"],
    [C, "restated/2", { sources: undefined }, "restated/2: value without sources"],
    [C, "restated/4", { sources: [] }, "restated/4: sources without value"],
    [C, "restated/4", { uncovered: true }, "restated/4: at most one of value, no_value, uncovered"],
    [C, "restated/4", { no_value: false }, "restated/4: no_value"],
    [C, "restated/3", { status: "corroborated", seen_valid: undefined }, "restated/3: status"],
    [C, "restated/5", { restored: false }, "restated/5: restored"],
    [C, "restated/0", { restored: true }, "restated/0: unknown key restored"],
    [C, "restated/3", { value: "x" }, "restated/3: unknown key value"],
    [
      C,
      "restated/2",
      { sources: [{ kind: "value", source: 26 }] },
      "restated/2.sources[0]: missing key carried",
    ],
    [C, "summary", { hash: "x" }, "summary: hash"],
    ["deletion.cancelled", "target", { origin: "restore" }, "target: origin"],
    ["deletion.cancelled", "kept_effective/0", { items: [] }, "kept_effective/0.items: empty"],
    [
      "deletion.cancelled",
      "kept_effective/0",
      { items: [{ field: "f2" }] },
      "kept_effective/0.items[0]: missing key k",
    ],
    ["deletion.cancelled", "kept_superseded/0", { item: "x_1" }, "kept_superseded/0: item"],
    ["deletion.executed", "target", { reason: "expired" }, "target: reason"],
  ];
  it.each(cases)("%s %s %j", (name, path, patch, issue) => {
    expect(issues(parse(patched(name, path, patch)))).toContain(issue);
  });

  it("refuses a malformed or repeated position, an empty or repeated item list", () => {
    const c = S(C);
    expect(issues(parse(withBlock(c, "positions", [{ seq: 26, path: "Text!" }])))).toContain(
      "positions[0]: path",
    );
    expect(
      issues(
        parse(
          withBlock(c, "positions", [
            { seq: 26, path: "text" },
            { seq: 26, path: "text" },
            { seq: 42, path: "summary" },
          ]),
        ),
      ),
    ).toContain("positions: duplicate block");
    expect(issues(parse(withBlock(c, "superseded_items", [])))).toContain(
      "superseded_items: empty",
    );
    expect(issues(parse(withBlock(c, "superseded_items", [ITEM, ITEM])))).toContain(
      "superseded_items: duplicate item",
    );
  });
});

describe("parseEvent: rules between the blocks of one deletion event", () => {
  const C = "deletion.confirmed";
  it("results, restatements and the cancellation's lists from 0 without a gap", () => {
    const c = S(C);
    const moved = { ...c.blocks };
    moved["restated/7"] = moved["restated/5"];
    delete moved["restated/5"];
    expect(issues(parse({ ...c, blocks: moved }))).toContain(
      "restated: indices not from 0 without a gap",
    );
    const x = S("deletion.cancelled");
    const k: Record<string, unknown> = {
      ...x.blocks,
      "kept_effective/2": x.blocks["kept_effective/0"],
    };
    delete k["kept_effective/0"];
    expect(issues(parse({ ...x, blocks: k }))).toContain(
      "kept_effective: indices not from 0 without a gap",
    );
    const r = withBlock(c, "results/0/fields/f2/3", c.blocks["results/0/fields/f2/0"]);
    expect(issues(parse(r))).toContain("results/0/f2: indices not from 0 without a gap");
  });

  it("a result's blocks belong to a row with a target", () => {
    const c = without(S(C), "results/0/target");
    expect(issues(parse(c))).toContain("results/0: no target");
  });

  it("an entity: every stretch with an interval, and its gaps always given (§5.9)", () => {
    const c = S(C);
    const plain = withBlock(c, "results/0/fields/f3/0", {
      value: "7",
      sources: [{ kind: "value", carried: { event: 21, field: "f3", k: 0 } }],
    });
    expect(issues(parse(plain))).toContain("results/0: a stretch of an entity without an interval");
    expect(issues(parse(without(c, "results/0/existence")))).toContain(
      "results/0: an entity without its gaps",
    );
  });

  it("a row: no stretch with an interval, only j = 0, no gaps", () => {
    const e = S(`${C} (event table)`);
    const timed = withBlock(e, "results/0/fields/f3/0", {
      valid: { from: "2026-11-01" },
      value: "7",
      sources: [{ kind: "schema_const", sv: 2, field: "f3" }],
      deps: [],
    });
    expect(issues(parse(timed))).toContain("results/0: a stretch of a row with an interval");
    const second = withBlock(e, "results/0/fields/f3/1", e.blocks["results/0/fields/f3/0"]);
    expect(issues(parse(second))).toContain("results/0/f3: a row's stretch other than 0");
    const gaps = withBlock(e, "results/0/existence", { gaps: [], deps: [] });
    expect(issues(parse(gaps))).toContain("results/0/existence: gaps on a row");
  });

  it("an explicit clearing on an entity is accepted: value null, carried, the item in deps", () => {
    const c = withBlock(S(C), "results/0/fields/f2/1", {
      valid: { from: "2026-11-01", to: "2026-11-20" },
      value: null,
      sources: [{ kind: "value", carried: { event: 34, field: "f2", k: 0 } }],
      deps: [{ event: 34, field: "f2", k: 0 }],
    });
    expect(parse(c)).toEqual({ ok: true, type: C });
  });

  it("a confirmation or cancellation system made carries no request id (§5.1)", () => {
    const e = S(`${C} (event table)`);
    expect(issues(parse(withBlock(e, "request_key", { key: "k1" })))).toContain(
      "request_key: not on an event system made",
    );
    const x = patched("deletion.cancelled", "target", { origin: "restore_cancel" });
    expect(issues(parse(x))).toContain("idempotency: not on an event system made");
  });

  it("the confirmation's own summary is on its list of positions", () => {
    const c = withBlock(S(C), "positions", [{ seq: 26, path: "text" }]);
    expect(issues(parse(c))).toContain("positions: its own summary not listed");
  });

  it("at most one of request_key and idempotency", () => {
    const c = withBlock(S(C), "idempotency", { key: "k1", fingerprint: HASH });
    expect(issues(parse(c))).toContain("event: request_key and idempotency");
  });
});
