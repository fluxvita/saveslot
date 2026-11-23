// Shape checks of the slot policy and schema lifecycle events (09-event-format §5.4, §5.5, §7): a
// well-formed sample of every block shape, then, block by block, the negatives every checker must
// report (an unknown key, each required key missing), value by value, every leaf, and the rules
// between the blocks of one event.

import { describe, expect, it } from "vitest";
import { type ParseResult, parseEvent } from "./parse.ts";
import { ID_PATTERNS, isId } from "./values.ts";

const HASH = "a".repeat(64);
const USER = `u_${"5".repeat(26)}`;
const SLOT = `sl_${"4".repeat(16)}`;
const DRAFT = `d_${"1".repeat(16)}`;
const DRAFT_B = `d_${"2".repeat(16)}`;
const MIGRATION = `m_${"3".repeat(16)}`;
const ROW = `r_${"6".repeat(26)}`;
const ROW_B = `r_${"7".repeat(26)}`;
const ENTITY = `e_${"7".repeat(26)}`;
const AT = "2026-11-10T04:41:07.123Z";

const header = (type: string, seq: number, op?: number) => ({
  type,
  v: 1,
  seq,
  ...(op !== undefined ? { op } : {}),
  at: AT,
  prev_hash: HASH,
  actor: USER,
  slot: SLOT,
});
const ctx = { now: AT, today: "2026-11-10", ruleset_version: 1, policy_version: 1 };

/** A definition covering every field type, every time type, and a derived table. */
const COMPILED = {
  compiler: 1,
  rsql: "rsql@1",
  slot: SLOT,
  name: "ledger",
  sv: 2,
  timezone: "Asia/Shanghai",
  tables: [
    {
      id: "t1",
      name: "expenses",
      kind: "base",
      description: "one row per expense",
      aliases: ["spending"],
      time: { type: "event", field: "f1" },
      physical: { table: "t_t1_v1", since: 1 },
      fields: [
        { id: "f1", name: "date", type: "date", required: true, description: "the day" },
        { id: "f2", name: "category", type: "enum", description: "kind", values: ["food", "rent"] },
        {
          id: "f3",
          name: "amount",
          type: "quantity",
          required: true,
          description: "how much",
          min: "0",
          unit: { code: "CNY", dimension: "currency:CNY" },
          precision: { scale: 2, rounding: "half_up" },
        },
        {
          id: "f4",
          name: "weight",
          type: "quantity",
          description: "how heavy",
          unit: { code: "g", dimension: "mass", to_base: "0.001" },
          precision: { scale: 6, rounding: "half_even" },
          migrate: { sql: '"f4" * 1000' },
          from: "f9",
        },
        { id: "f5", name: "note", type: "text", description: "free text", aliases: ["memo"] },
        { id: "f6", name: "count", type: "integer", description: "pieces", min: "1", max: "99" },
        {
          id: "f7",
          name: "rate",
          type: "decimal",
          description: "a rate",
          precision: { scale: 4, rounding: "half_up" },
          backfill: { sql: 'abs("f7")' },
        },
        {
          id: "f8",
          name: "paid",
          type: "boolean",
          description: "settled",
          backfill: { const: true },
        },
        { id: "f10", name: "at", type: "zoned_datetime", description: "when" },
        {
          id: "f11",
          name: "account",
          type: "ref",
          description: "the account",
          ref: { table: "t3", target: "entity" },
        },
      ],
      together: [["f3", "f4"]],
      duplicate_keys: [["f1", "f2", "f3"]],
      external_key: ["f5"],
    },
    {
      id: "t3",
      name: "accounts",
      kind: "base",
      description: "an account over time",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t3_v2" },
      fields: [
        { id: "f1", name: "name", type: "text", required: true, description: "its name" },
        { id: "f2", name: "balance", type: "integer", description: "its balance" },
      ],
      entity_key: ["f1"],
    },
    {
      id: "t4",
      name: "settings",
      kind: "base",
      description: "timeless",
      time: { type: "none" },
      physical: { table: "t_t4_v2" },
      fields: [{ id: "f1", name: "key", type: "text", description: "a key" }],
    },
    {
      id: "t2",
      name: "monthly_total",
      kind: "derived",
      description: "monthly sums",
      physical: { table: "d_t2_v1", since: 1 },
      rule: {
        id: "r1",
        version: 1,
        rsql: "rsql@1",
        sql: 'SELECT "t1"."f1" AS "f1", sum("t1"."f3") AS "f2" FROM "t1" GROUP BY 1',
        time_dependency: "bucketed",
        depends_on: [
          { table: "t1", field: "f1" },
          { table: "t1", field: "f3" },
        ],
        scope: { kind: "group", key: ["f1"], key_from_free_text: false },
      },
      fields: [
        { id: "f1", name: "month", type: "date", description: "first day" },
        {
          id: "f2",
          name: "total",
          type: "quantity",
          description: "the sum",
          unit: { code: "CNY", dimension: "currency:CNY" },
          precision: { scale: 2, rounding: "half_up" },
        },
        {
          id: "f3",
          name: "n",
          type: "decimal",
          description: "avg",
          precision: { scale: 6, rounding: "half_up" },
        },
      ],
    },
    {
      id: "t5",
      name: "everything",
      kind: "derived",
      description: "tenant-wide",
      physical: { table: "d_t5_v2" },
      rule: {
        id: "r2",
        version: 3,
        rsql: "rsql@1",
        sql: 'SELECT count(*) AS "f1" FROM "t1"',
        time_dependency: "none",
        depends_on: [],
        scope: { kind: "tenant" },
      },
      fields: [{ id: "f1", name: "n", type: "integer", description: "rows" }],
    },
  ],
};

const CHANGES = [
  {
    target: { slot: true },
    change: "change_timezone",
    class: "deterministic",
    compatible_with_old_writes: true,
    destructive: false,
    auto: true,
  },
  {
    target: { table: "t3" },
    change: "add_table",
    class: "create",
    compatible_with_old_writes: true,
    destructive: false,
    auto: true,
  },
  {
    target: { table: "t1", field: "f4" },
    change: "change_unit",
    class: "deterministic",
    compatible_with_old_writes: false,
    destructive: false,
    auto: false,
  },
  {
    target: { table: "t5", rule: true },
    change: "change_rule",
    class: "metadata",
    compatible_with_old_writes: true,
    destructive: false,
    auto: false,
  },
];

type Sample = { header: Record<string, unknown>; blocks: Record<string, unknown> };

const SAMPLES: Record<string, Sample> = {
  "slot.policy_set": {
    header: header("slot.policy_set", 5, 2),
    blocks: {
      policy: {
        policy_version: 1,
        effective_value_rule: "keep_current",
        rank: { user_stated: 2, agent_inferred: 1, miss: 0 },
        auto_apply: ["add_table", "description", "restructure_unused"],
        high_impact: [],
        user_session_only: [],
      },
    },
  },
  "schema.draft_submitted": {
    header: header("schema.draft_submitted", 2),
    blocks: {
      ctx,
      task: "track expenses",
      request_key: { key: "k1" },
      target: { draft_id: DRAFT, creates_slot: true },
      draft: { name: "ledger", tables: [] },
    },
  },
  "schema.draft_submitted (a change)": {
    header: header("schema.draft_submitted", 45),
    blocks: {
      ctx,
      idempotency: { key: "k2", fingerprint: HASH },
      target: { draft_id: DRAFT, creates_slot: false, base_version: 1 },
      draft: {},
    },
  },
  "schema.compiled": {
    header: header("schema.compiled", 46, 45),
    blocks: {
      target: { draft_id: DRAFT, target_version: 2, outcome: "pending" },
      compiled: COMPILED,
      changes: CHANGES,
    },
  },
  "schema.confirmed": {
    header: header("schema.confirmed", 47, 45),
    blocks: { target: { draft_id: DRAFT, target_version: 2, by: "resolve" } },
  },
  "schema.rejected": {
    header: header("schema.rejected", 47, 45),
    blocks: { target: { draft_id: DRAFT } },
  },
  "schema.superseded": {
    header: header("schema.superseded", 47, 45),
    blocks: { target: { draft_id: DRAFT, by_draft: DRAFT_B } },
  },
  "schema.migration_started": {
    header: header("schema.migration_started", 48, 45),
    blocks: {
      target: { migration_id: MIGRATION, draft_id: DRAFT, from_version: 1, to_version: 2 },
    },
  },
  "schema.switched": {
    header: header("schema.switched", 6, 2),
    blocks: { target: { draft_id: DRAFT, to_version: 1, rebuilt_tables: [] } },
  },
  "schema.switched (after a migration)": {
    header: { ...header("schema.switched", 70), actor: "system", trigger: "migration" },
    blocks: {
      target: {
        draft_id: DRAFT,
        from_version: 1,
        to_version: 2,
        migration_id: MIGRATION,
        rebuilt_tables: ["t1"],
      },
      "tables/t1": { rows: 3, checksum: HASH },
      "backfill_rows/t1/f8/0": [ROW, ROW_B],
      "backfill/t3/f2/0": {
        entity: ENTITY,
        valid: { from: "2026-11-01", to: "2026-11-05" },
        deps: [{ event: 27, field: "f2", k: 0 }],
      },
    },
  },
  "schema.migration_failed": {
    header: { ...header("schema.migration_failed", 70), actor: "system", trigger: "migration" },
    blocks: { target: { migration_id: MIGRATION, reason: "verify_failed" } },
  },
};

const parse = (s: Sample, removed: string[] = []): ParseResult =>
  parseEvent(s.header, s.blocks, removed);
const issues = (r: ParseResult): readonly string[] =>
  !r.ok && r.kind === "invalid" ? r.issues : [];
const withBlock = (s: Sample, path: string, value: unknown): Sample => ({
  ...s,
  blocks: { ...s.blocks, [path]: value },
});
const typeOf = (name: string) => name.split(" ")[0] as string;
const S = (name: string) => SAMPLES[name] as Sample;

describe("parseEvent: slot policy and schema events", () => {
  it.each(Object.entries(SAMPLES))("accepts %s", (name, s) => {
    expect(parse(s)).toEqual({ ok: true, type: typeOf(name) });
  });

  it("accepts a change compiled as on a table never written (as_never_written, metadata)", () => {
    const s = withBlock(S("schema.compiled"), "changes", [
      CHANGES[0],
      CHANGES[1],
      { ...CHANGES[2], class: "metadata", as_never_written: true },
      CHANGES[3],
    ]);
    expect(parse(s)).toEqual({ ok: true, type: "schema.compiled" });
  });

  const optional = new Set(["from_version", "migration_id", "literal_checker"]);
  const cases = Object.entries(SAMPLES).flatMap(([name, s]) =>
    Object.entries(s.blocks).flatMap(([path, v]) =>
      // `draft` is the schema document itself: any keys.
      v !== null && typeof v === "object" && !Array.isArray(v) && path !== "draft"
        ? [[name, path, v as Record<string, unknown>] as const]
        : [],
    ),
  );
  it.each(cases)("%s %s: refuses an unknown key and a missing required key", (name, path, v) => {
    const s = S(name);
    expect(issues(parse(withBlock(s, path, { ...v, zz: 1 })))).toContain(`${path}: unknown key zz`);
    for (const k of Object.keys(v)) {
      if (optional.has(k)) continue;
      const { [k]: _, ...rest } = v;
      expect({ k, ok: parse(withBlock(s, path, rest)).ok }).toEqual({ k, ok: false });
    }
  });
});

// --- value-level negatives -----------------------------------------------------------------------

type Json = Record<string, unknown>;
const clone = <T>(v: T): T => structuredClone(v);
/** The compiled sample after `edit`, in the schema.compiled sample. */
function compiledWith(edit: (c: Json & { tables: Json[] }) => void): Sample {
  const c = clone(COMPILED) as unknown as Json & { tables: Json[] };
  edit(c);
  return withBlock(S("schema.compiled"), "compiled", c);
}
const tableOf = (c: { tables: Json[] }, n: number) => c.tables[n] as Json & { fields: Json[] };
const fieldOf = (c: { tables: Json[] }, t: number, f: number) => tableOf(c, t).fields[f] as Json;

describe("parseEvent: the compiled definition, value by value", () => {
  const cases: [string, (c: Json & { tables: Json[] }) => void, string][] = [
    ["compiler 2", (c) => (c["compiler"] = 2), "compiled: compiler"],
    ["rsql without a version", (c) => (c["rsql"] = "rsql"), "compiled: rsql"],
    ["slot ID", (c) => (c["slot"] = "sl_1"), "compiled: slot"],
    ["sv 0", (c) => (c["sv"] = 0), "compiled: sv"],
    ["empty timezone", (c) => (c["timezone"] = ""), "compiled: timezone"],
    ["two tables with one ID", (c) => (tableOf(c, 2)["id"] = "t3"), "compiled.tables: unique ids"],
    [
      "physical name not t_<table>_v<since>",
      (c) => ((tableOf(c, 0)["physical"] as Json)["table"] = "t_t1_v2"),
      "compiled.tables[0].physical: table",
    ],
    [
      "physical name with SQL in it",
      (c) => ((tableOf(c, 1)["physical"] as Json)["table"] = 't_t3_v2"; DROP TABLE events; --'),
      "compiled.tables[1].physical: table",
    ],
    [
      "a derived table under t_",
      (c) => ((tableOf(c, 3)["physical"] as Json)["table"] = "t_t2_v1"),
      "compiled.tables[3].physical: table",
    ],
    [
      "since after this version",
      (c) => (tableOf(c, 0)["physical"] = { table: "t_t1_v3", since: 3 }),
      "compiled.tables[0].physical: since",
    ],
    ["table kind", (c) => (tableOf(c, 0)["kind"] = "view"), "compiled.tables[0]: kind"],
    [
      "empty description",
      (c) => (tableOf(c, 0)["description"] = ""),
      "compiled.tables[0]: description",
    ],
    ["no fields", (c) => (tableOf(c, 2)["fields"] = []), "compiled.tables[2].fields: empty"],
    [
      "two fields with one ID",
      (c) => (fieldOf(c, 1, 1)["id"] = "f1"),
      "compiled.tables[1].fields: unique ids",
    ],
    [
      "field type",
      (c) => (fieldOf(c, 0, 4)["type"] = "string"),
      "compiled.tables[0].fields[4]: type",
    ],
    [
      "values on a text field",
      (c) => (fieldOf(c, 0, 4)["values"] = ["a"]),
      "compiled.tables[0].fields[4]: unknown key values",
    ],
    [
      "an enum without values",
      (c) => delete fieldOf(c, 0, 1)["values"],
      "compiled.tables[0].fields[1]: missing key values",
    ],
    [
      "empty values",
      (c) => (fieldOf(c, 0, 1)["values"] = []),
      "compiled.tables[0].fields[1]: values empty",
    ],
    [
      "repeated values",
      (c) => (fieldOf(c, 0, 1)["values"] = ["a", "a"]),
      "compiled.tables[0].fields[1].values: unique",
    ],
    [
      "required false",
      (c) => (fieldOf(c, 0, 4)["required"] = false),
      "compiled.tables[0].fields[4]: required only as true",
    ],
    [
      "min not canonical",
      (c) => (fieldOf(c, 0, 5)["min"] = "01"),
      "compiled.tables[0].fields[5]: min",
    ],
    [
      "a quantity without a unit",
      (c) => delete fieldOf(c, 0, 2)["unit"],
      "compiled.tables[0].fields[2]: missing key unit",
    ],
    [
      "to_base not canonical",
      (c) => ((fieldOf(c, 0, 3)["unit"] as Json)["to_base"] = "1e-3"),
      "compiled.tables[0].fields[3].unit: to_base",
    ],
    [
      "scale 13",
      (c) => ((fieldOf(c, 0, 6)["precision"] as Json)["scale"] = 13),
      "compiled.tables[0].fields[6].precision: scale",
    ],
    [
      "rounding",
      (c) => ((fieldOf(c, 0, 6)["precision"] as Json)["rounding"] = "up"),
      "compiled.tables[0].fields[6].precision: rounding",
    ],
    [
      "a ref to a table not in the definition",
      (c) => (fieldOf(c, 0, 9)["ref"] = { table: "t9", target: "entity" }),
      "compiled.tables[0].fields[9].ref: table",
    ],
    [
      "both backfill forms",
      (c) => (fieldOf(c, 0, 7)["backfill"] = { const: true, sql: "x" }),
      "compiled.tables[0].fields[7].backfill: unknown key sql",
    ],
    [
      "empty migrate sql",
      (c) => (fieldOf(c, 0, 3)["migrate"] = { sql: "" }),
      "compiled.tables[0].fields[3].migrate: sql",
    ],
    [
      "from not a field ID",
      (c) => (fieldOf(c, 0, 3)["from"] = "x"),
      "compiled.tables[0].fields[3]: from",
    ],
    [
      "an event time field not in the table",
      (c) => (tableOf(c, 0)["time"] = { type: "event", field: "f99" }),
      "compiled.tables[0].time: field",
    ],
    [
      "granularity",
      (c) => (tableOf(c, 1)["time"] = { type: "state", granularity: "month" }),
      "compiled.tables[1].time: granularity",
    ],
    [
      "time type",
      (c) => (tableOf(c, 2)["time"] = { type: "period" }),
      "compiled.tables[2].time: type",
    ],
    [
      "entity_key on an event table",
      (c) => (tableOf(c, 0)["entity_key"] = ["f1"]),
      "compiled.tables[0]: entity_key only on a state table",
    ],
    [
      "an entity key field not in the table",
      (c) => (tableOf(c, 1)["entity_key"] = ["f9"]),
      "compiled.tables[1].entity_key[0]: a required field",
    ],
    [
      "external_key on a state table",
      (c) => (tableOf(c, 1)["external_key"] = ["f1"]),
      "compiled.tables[1]: external_key not on a state table",
    ],
    [
      "five key fields",
      (c) => (tableOf(c, 0)["external_key"] = ["f1", "f2", "f3", "f4", "f5"]),
      "compiled.tables[0]: external_key 1–4",
    ],
    [
      "a key field in together",
      (c) => (tableOf(c, 0)["external_key"] = ["f3"]),
      "compiled.tables[0]: external_key fields not in together",
    ],
    [
      "a group field not in the table",
      (c) => (tableOf(c, 0)["together"] = [["f3", "f99"]]),
      "compiled.tables[0].together[0][1]: a field of this table",
    ],
    [
      "an empty duplicate key",
      (c) => (tableOf(c, 0)["duplicate_keys"] = [[]]),
      "compiled.tables[0].duplicate_keys[0]: empty",
    ],
    [
      "required on a derived field",
      (c) => (fieldOf(c, 3, 0)["required"] = true),
      "compiled.tables[3].fields[0]: unknown key required",
    ],
    [
      "a derived decimal without precision",
      (c) => delete fieldOf(c, 3, 2)["precision"],
      "compiled.tables[3].fields[2]: missing key precision",
    ],
    [
      "rule ID",
      (c) => ((tableOf(c, 3)["rule"] as Json)["id"] = "rule1"),
      "compiled.tables[3].rule: id",
    ],
    [
      "rule rsql",
      (c) => ((tableOf(c, 3)["rule"] as Json)["rsql"] = "sql@1"),
      "compiled.tables[3].rule: rsql",
    ],
    [
      "time dependency",
      (c) => ((tableOf(c, 3)["rule"] as Json)["time_dependency"] = "daily"),
      "compiled.tables[3].rule: time_dependency",
    ],
    [
      "a dependency on a field not in its table",
      (c) => ((tableOf(c, 3)["rule"] as Json)["depends_on"] = [{ table: "t1", field: "f99" }]),
      "compiled.tables[3].rule.depends_on[0]: field",
    ],
    [
      "a dependency on a table not in the definition",
      (c) => ((tableOf(c, 3)["rule"] as Json)["depends_on"] = [{ table: "t9", field: "f1" }]),
      "compiled.tables[3].rule.depends_on[0]: table",
    ],
    [
      "a group key not a field of the derived table",
      (c) =>
        ((tableOf(c, 3)["rule"] as Json)["scope"] = {
          kind: "group",
          key: ["f9"],
          key_from_free_text: false,
        }),
      "compiled.tables[3].rule.scope.key[0]: a field of this table",
    ],
    [
      "a tenant scope with a key",
      (c) => ((tableOf(c, 4)["rule"] as Json)["scope"] = { kind: "tenant", key: [] }),
      "compiled.tables[4].rule.scope: unknown key key",
    ],
  ];
  it.each(cases)("refuses %s", (_, edit, issue) => {
    expect(issues(parse(compiledWith(edit)))).toContain(issue);
  });
});

function patched(name: string, path: string, patch: Record<string, unknown>): Sample {
  const block = { ...(S(name).blocks[path] as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete block[k];
    else block[k] = v;
  }
  return withBlock(S(name), path, block);
}

describe("parseEvent: the other schema blocks, value by value", () => {
  const cases: [string, Sample, string][] = [
    [
      "a policy version 0",
      patched("slot.policy_set", "policy", { policy_version: 0 }),
      "policy: policy_version",
    ],
    [
      "an effective value rule",
      patched("slot.policy_set", "policy", { effective_value_rule: "latest" }),
      "policy: effective_value_rule",
    ],
    [
      "an unknown auto-apply class",
      patched("slot.policy_set", "policy", { auto_apply: ["add_column"] }),
      "policy.auto_apply[0]: a class",
    ],
    [
      "a repeated auto-apply class",
      patched("slot.policy_set", "policy", { auto_apply: ["add_table", "add_table"] }),
      "policy.auto_apply: unique",
    ],
    [
      "a non-empty high_impact (reserved)",
      patched("slot.policy_set", "policy", { high_impact: [{ table: "t1", fields: ["f1"] }] }),
      "policy: high_impact",
    ],
    [
      "a non-empty user_session_only (reserved)",
      patched("slot.policy_set", "policy", {
        user_session_only: [{ type: "conflict", decision: "x" }],
      }),
      "policy: user_session_only",
    ],
    [
      "a literal checker on a schema head",
      patched("schema.draft_submitted", "ctx", { literal_checker: "literal@1" }),
      "ctx: unknown key literal_checker",
    ],
    [
      "a base version when creating the slot",
      patched("schema.draft_submitted", "target", { base_version: 1 }),
      "target: unknown key base_version",
    ],
    [
      "no base version for a change",
      patched("schema.draft_submitted (a change)", "target", { base_version: undefined }),
      "target: missing key base_version",
    ],
    [
      "a draft ID",
      patched("schema.draft_submitted", "target", { draft_id: "d_1" }),
      "target: draft_id",
    ],
    [
      "a draft that is not an object",
      withBlock(S("schema.draft_submitted"), "draft", []),
      "draft: not an object",
    ],
    ["an outcome", patched("schema.compiled", "target", { outcome: "done" }), "target: outcome"],
    ["no changes", withBlock(S("schema.compiled"), "changes", []), "changes: empty"],
    [
      "a slot-level target on add_table",
      withBlock(S("schema.compiled"), "changes", [{ ...CHANGES[0], change: "add_table" }]),
      "changes[0]: a slot-level change",
    ],
    [
      "change_rule on a table",
      withBlock(S("schema.compiled"), "changes", [{ ...CHANGES[1], change: "change_rule" }]),
      "changes[0]: a table or field change",
    ],
    [
      "a rule target on another change",
      withBlock(S("schema.compiled"), "changes", [{ ...CHANGES[3], change: "rename_table" }]),
      "changes[0]: change_rule on a rule",
    ],
    [
      "the reserved class reextract",
      withBlock(S("schema.compiled"), "changes", [{ ...CHANGES[1], class: "reextract" }]),
      "changes[0]: class",
    ],
    [
      "as_never_written false",
      withBlock(S("schema.compiled"), "changes", [
        { ...CHANGES[2], class: "metadata", as_never_written: false },
      ]),
      "changes[0]: as_never_written true",
    ],
    [
      "as_never_written on a deterministic change",
      withBlock(S("schema.compiled"), "changes", [{ ...CHANGES[2], as_never_written: true }]),
      "changes[0]: as_never_written with class metadata",
    ],
    [
      "as_never_written on a slot",
      withBlock(S("schema.compiled"), "changes", [
        { ...CHANGES[0], class: "metadata", as_never_written: true },
      ]),
      "changes[0]: as_never_written on a table or field",
    ],
    [
      "as_never_written on a rule",
      withBlock(S("schema.compiled"), "changes", [{ ...CHANGES[3], as_never_written: true }]),
      "changes[0]: as_never_written on a table or field",
    ],
    ["confirmed by", patched("schema.confirmed", "target", { by: "user" }), "target: by"],
    [
      "superseded by itself",
      patched("schema.superseded", "target", { by_draft: DRAFT }),
      "target: by another draft",
    ],
    [
      "a migration to an earlier version",
      patched("schema.migration_started", "target", { to_version: 1 }),
      "target: to_version after from_version",
    ],
    [
      "a migration on a slot being created",
      patched("schema.switched", "target", { migration_id: MIGRATION }),
      "target: migration_id without from_version",
    ],
    [
      "a switch to an earlier version",
      patched("schema.switched (after a migration)", "target", { to_version: 1 }),
      "target: to_version after from_version",
    ],
    [
      "backfill rows out of order",
      withBlock(S("schema.switched (after a migration)"), "backfill_rows/t1/f8/0", [ROW_B, ROW]),
      "backfill_rows/t1/f8/0[1]: ascending",
    ],
    [
      "no backfill rows",
      withBlock(S("schema.switched (after a migration)"), "backfill_rows/t1/f8/0", []),
      "backfill_rows/t1/f8/0: 1 to 10,000 rows",
    ],
    [
      "a failure reason",
      patched("schema.migration_failed", "target", { reason: "timeout" }),
      "target: reason",
    ],
  ];
  it.each(cases)("refuses %s", (_, s, issue) => {
    expect(issues(parse(s))).toContain(issue);
  });
});

describe("parseEvent: rules between the blocks of one schema event", () => {
  it("schema.compiled: the definition is of the target version", () => {
    const s = patched("schema.compiled", "target", { target_version: 3 });
    expect(issues(parse(s))).toContain("compiled: sv is the target version");
  });

  it("schema.compiled: the outcome is applied exactly when every change is auto", () => {
    expect(issues(parse(patched("schema.compiled", "target", { outcome: "applied" })))).toContain(
      "target: outcome",
    );
    const all = withBlock(
      patched("schema.compiled", "target", { outcome: "applied" }),
      "changes",
      CHANGES.map((c) => ({ ...c, auto: true })),
    );
    expect(parse(all)).toEqual({ ok: true, type: "schema.compiled" });
  });

  it("schema.switched: tables/<t> for each rebuilt table and only those, rebuilt only in a migration", () => {
    const migrated = S("schema.switched (after a migration)");
    const { "tables/t1": _, ...noTable } = migrated.blocks;
    expect(issues(parse({ ...migrated, blocks: noTable }))).toContain("event: tables/t1 missing");
    expect(issues(parse(withBlock(migrated, "tables/t3", { rows: 1, checksum: HASH })))).toContain(
      "tables/t3: not a rebuilt table",
    );
    expect(
      issues(parse(patched("schema.switched", "target", { rebuilt_tables: ["t1"] }))),
    ).toContain("target: rebuilt_tables without a migration");
  });

  it("schema.draft_submitted: at most one of request_key and idempotency", () => {
    const s = withBlock(S("schema.draft_submitted"), "idempotency", {
      key: "k",
      fingerprint: HASH,
    });
    expect(issues(parse(s))).toContain("event: request_key and idempotency");
  });
});

describe("parseEvent: every value of a schema block is checked", () => {
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
    const [head, ...rest] = at;
    if (head === undefined) return by;
    if (Array.isArray(v)) return v.map((x, i) => (i === head ? replaced(x, rest, by) : x));
    const o = v as Record<string, unknown>;
    return { ...o, [head]: replaced(o[head as string], rest, by) };
  }
  // `draft` is the schema document itself and takes any values.
  const cases = Object.entries(SAMPLES).flatMap(([name, s]) =>
    Object.entries(s.blocks)
      .filter(([path]) => path !== "draft")
      .flatMap(([path, v]) => leaves(v).map((at) => [name, path, at.join("."), at, v] as const)),
  );
  it.each(cases)("%s %s .%s", (name, path, _, at, v) => {
    const bad = replaced(v, at, poison(at.reduce<unknown>((x, k) => (x as never)[k], v)));
    expect(parse(withBlock(S(name), path, bad)).ok).toBe(false);
  });
});

// --- what the leaf types alone do not catch --------------------------------------------------------

/** Every leaf of a block, by path. */
function leafPaths(v: unknown, at: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(v)) return v.flatMap((x, i) => leafPaths(x, [...at, i]));
  if (v !== null && typeof v === "object") {
    return Object.entries(v).flatMap(([k, x]) => leafPaths(x, [...at, k]));
  }
  return [at];
}
function objectPaths(v: unknown, at: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(v)) return v.flatMap((x, i) => objectPaths(x, [...at, i]));
  if (v !== null && typeof v === "object") {
    return [at, ...Object.entries(v).flatMap(([k, x]) => objectPaths(x, [...at, k]))];
  }
  return [];
}
const get = (v: unknown, at: readonly (string | number)[]) =>
  at.reduce<unknown>((x, k) => (x as never)[k], v);
function put(v: unknown, at: readonly (string | number)[], by: (old: unknown) => unknown): unknown {
  const [head, ...rest] = at;
  if (head === undefined) return by(v);
  if (Array.isArray(v)) return v.map((x, i) => (i === head ? put(x, rest, by) : x));
  const o = v as Record<string, unknown>;
  return { ...o, [head]: put(o[head as string], rest, by) };
}
const blocksOf = () =>
  Object.entries(SAMPLES).flatMap(([name, s]) =>
    Object.entries(s.blocks)
      .filter(([path]) => path !== "draft")
      .map(([path, v]) => [name, path, v] as const),
  );

describe("parseEvent: every ID of a schema block is checked for its form", () => {
  // Each leaf that is an ID of some kind, made into a string of the wrong form for that kind.
  const kinds = Object.entries(ID_PATTERNS);
  const cases = blocksOf().flatMap(([name, path, v]) =>
    leafPaths(v).flatMap((at) => {
      const x = get(v, at);
      if (typeof x !== "string") return [];
      const kind = kinds.find(([, re]) => re.test(x))?.[0];
      return kind === undefined ? [] : [[name, path, at.join("."), at, kind] as const];
    }),
  );
  it("reaches the IDs of every block", () => {
    expect(new Set(cases.map((c) => c[4]))).toEqual(
      new Set(["table", "field", "rule", "slot", "draft", "migration", "row", "entity"]),
    );
  });
  it.each(cases)("%s %s .%s (%s)", (name, path, _, at) => {
    const s = S(name);
    for (const bad of [
      (x: string) => `${x}x`,
      (x: string) => x.toUpperCase().replace(/^./, "Q"),
      (x: string) => x.slice(0, -1),
    ]) {
      expect(
        parse(
          withBlock(
            s,
            path,
            put(s.blocks[path], at, (x) => bad(x as string)),
          ),
        ).ok,
      ).toBe(false);
    }
  });
  it("a short ID of ten digits: t, f and r IDs have at most nine", () => {
    expect(isId("table", "t123456789")).toBe(true);
    for (const kind of ["table", "field", "rule"] as const) {
      const p = { table: "t", field: "f", rule: "r" }[kind];
      expect(isId(kind, `${p}1234567890`)).toBe(false);
      expect(isId(kind, `${p}0`)).toBe(false);
      expect(isId(kind, `${p}01`)).toBe(false);
    }
  });
});

describe("parseEvent: every object of a schema block refuses a key it does not have", () => {
  // A key that is legitimate elsewhere, added where it is not; keys optional in places are left
  // out (their absence is not the point here), as are the field type keys (the next test).
  const optional = new Set([
    "aliases",
    "since",
    "required",
    "min",
    "max",
    "to_base",
    "from",
    "migrate",
    "backfill",
    "entity_key",
    "together",
    "duplicate_keys",
    "external_key",
    "base_version",
    "from_version",
    "migration_id",
    "literal_checker",
    "request_key",
    "idempotency",
    "task",
    "values",
    "unit",
    "precision",
    "ref",
  ]);
  const sampleOf = new Map<string, unknown>([["offset", "0"]]);
  for (const [, , v] of blocksOf()) {
    for (const at of objectPaths(v)) {
      for (const [k, x] of Object.entries(get(v, at) as object))
        if (!sampleOf.has(k)) sampleOf.set(k, x);
    }
  }
  const cases = blocksOf().flatMap(([name, path, v]) =>
    objectPaths(v)
      .filter((at) => !Array.isArray(get(v, at)) && !at.includes("const"))
      .flatMap((at) => {
        const own = new Set(Object.keys(get(v, at) as object));
        return (
          [...sampleOf.keys()]
            // A change's target names a table, and may name a field of it too.
            .filter((k) => !own.has(k) && !optional.has(k))
            .filter((k) => !(path === "changes" && at.at(-1) === "target" && k === "field"))
            .map((k) => [name, path, at.join(".") || "(block)", at, k] as const)
        );
      }),
  );
  it.each(cases)("%s %s .%s + %s", (name, path, _, at, k) => {
    const s = S(name);
    const bad = put(s.blocks[path], at, (o) => ({ ...(o as object), [k]: sampleOf.get(k) }));
    expect(parse(withBlock(s, path, bad)).ok).toBe(false);
  });
});

describe("parseEvent: a field carries only the keys of its type", () => {
  const extras: Record<string, unknown> = {
    values: ["a"],
    min: "0",
    max: "9",
    precision: { scale: 2, rounding: "half_up" },
    unit: { code: "g", dimension: "mass", to_base: "0.001" },
    ref: { table: "t3", target: "entity" },
  };
  const own: Record<string, string[]> = {
    text: [],
    boolean: [],
    date: [],
    zoned_datetime: [],
    enum: ["values"],
    integer: ["min", "max"],
    decimal: ["min", "max", "precision"],
    quantity: ["min", "max", "unit", "precision"],
    ref: ["ref"],
  };
  const derivedOwn: Record<string, string[]> = {
    ...Object.fromEntries(Object.keys(own).map((t) => [t, []])),
    decimal: ["precision"],
    quantity: ["unit", "precision"],
  };
  // A base field and a derived field of each type, with each key its type does not have.
  const base = (type: string) => ({
    id: "f20",
    name: "x",
    type,
    description: "x",
    ...Object.fromEntries(
      (own[type] ?? []).filter((k) => !["min", "max"].includes(k)).map((k) => [k, extras[k]]),
    ),
  });
  const derived = (type: string) => ({
    id: "f20",
    name: "x",
    type,
    description: "x",
    ...Object.fromEntries((derivedOwn[type] ?? []).map((k) => [k, extras[k]])),
  });
  const withField = (t: number, f: unknown) =>
    compiledWith((c) => {
      tableOf(c, t)["fields"] = [...tableOf(c, t)["fields"], f as Json];
    });
  it.each(Object.keys(own))("%s: as written, accepted", (type) => {
    expect(parse(withField(1, base(type)))).toEqual({ ok: true, type: "schema.compiled" });
    expect(parse(withField(3, derived(type)))).toEqual({ ok: true, type: "schema.compiled" });
  });
  const cases = Object.keys(own).flatMap((type) => [
    ...Object.keys(extras)
      .filter((k) => !(own[type] ?? []).includes(k))
      .map((k) => ["base", type, k] as const),
    ...[...Object.keys(extras), "required", "migrate", "backfill", "from"]
      .filter((k) => !(derivedOwn[type] ?? []).includes(k))
      .map((k) => ["derived", type, k] as const),
  ]);
  it.each(cases)("%s %s + %s: refused", (where, type, k) => {
    const more = {
      required: true,
      migrate: { sql: "x" },
      backfill: { sql: "x" },
      from: "f9",
    } as Record<string, unknown>;
    const f = where === "base" ? base(type) : derived(type);
    const s = withField(where === "base" ? 1 : 3, { ...f, [k]: extras[k] ?? more[k] });
    expect(issues(parse(s))).toEqual(
      expect.arrayContaining([expect.stringMatching(new RegExp(`unknown key ${k}$`))]),
    );
  });
  it.each([
    ["quantity", "precision"],
    ["quantity", "unit"],
    ["decimal", "precision"],
    ["ref", "ref"],
    ["enum", "values"],
  ])("a base %s without %s: refused", (type, k) => {
    const { [k]: _, ...f } = base(type) as Record<string, unknown>;
    expect(issues(parse(withField(1, f)))).toEqual(
      expect.arrayContaining([expect.stringMatching(new RegExp(`missing key ${k}$`))]),
    );
  });
});

describe("parseEvent: values that have the right type but not a right value", () => {
  const cases: [string, Sample, string][] = [
    [
      "a negative scale",
      compiledWith((c) => ((fieldOf(c, 0, 6)["precision"] as Json)["scale"] = -1)),
      "compiled.tables[0].fields[6].precision: scale",
    ],
    [
      "a fractional scale",
      compiledWith((c) => ((fieldOf(c, 0, 6)["precision"] as Json)["scale"] = 1.5)),
      "compiled.tables[0].fields[6].precision: scale",
    ],
    ["rsql@0", compiledWith((c) => (c["rsql"] = "rsql@0")), "compiled: rsql"],
    [
      "a rule's rsql@0",
      compiledWith((c) => ((tableOf(c, 3)["rule"] as Json)["rsql"] = "rsql@0")),
      "compiled.tables[3].rule: rsql",
    ],
    [
      "a rule version 0",
      compiledWith((c) => ((tableOf(c, 3)["rule"] as Json)["version"] = 0)),
      "compiled.tables[3].rule: version",
    ],
    [
      "an empty rule",
      compiledWith((c) => ((tableOf(c, 3)["rule"] as Json)["sql"] = "")),
      "compiled.tables[3].rule: sql",
    ],
    [
      "an external key field not in the table",
      compiledWith((c) => (tableOf(c, 0)["external_key"] = ["f99"])),
      "compiled.tables[0].external_key[0]: a field",
    ],
    [
      "an empty external key",
      compiledWith((c) => (tableOf(c, 0)["external_key"] = [])),
      "compiled.tables[0]: external_key 1–4",
    ],
    [
      "an event time on a text field",
      compiledWith((c) => (tableOf(c, 0)["time"] = { type: "event", field: "f5" })),
      "compiled.tables[0].time: field",
    ],
    [
      "an empty entity key",
      compiledWith((c) => (tableOf(c, 1)["entity_key"] = [])),
      "compiled.tables[1]: entity_key empty",
    ],
    [
      "an entity key field not required",
      compiledWith((c) => (tableOf(c, 1)["entity_key"] = ["f2"])),
      "compiled.tables[1].entity_key[0]: a required field",
    ],
    [
      "duplicate_keys on a state table",
      compiledWith((c) => (tableOf(c, 1)["duplicate_keys"] = [["f1"]])),
      "compiled.tables[1]: duplicate_keys not on a state table",
    ],
    [
      "a field in two groups",
      compiledWith(
        (c) =>
          (tableOf(c, 0)["together"] = [
            ["f3", "f4"],
            ["f4", "f6"],
          ]),
      ),
      "compiled.tables[0].together: a field in at most one group",
    ],
    [
      "a group repeated",
      compiledWith(
        (c) =>
          (tableOf(c, 0)["together"] = [
            ["f3", "f4"],
            ["f3", "f4"],
          ]),
      ),
      "compiled.tables[0].together: a field in at most one group",
    ],
    [
      "a group of one field",
      compiledWith((c) => (tableOf(c, 0)["together"] = [["f3"]])),
      "compiled.tables[0].together[0]: a group of two fields or more",
    ],
    [
      "a base version 0",
      patched("schema.draft_submitted (a change)", "target", { base_version: 0 }),
      "target: base_version",
    ],
    [
      "a checksum not a hash",
      withBlock(S("schema.switched (after a migration)"), "tables/t1", {
        rows: 3,
        checksum: "abc",
      }),
      "tables/t1: checksum",
    ],
    [
      "backfill rows over 10,000",
      withBlock(
        S("schema.switched (after a migration)"),
        "backfill_rows/t1/f8/0",
        Array.from({ length: 10001 }, (_, i) => `r_${String(i).padStart(26, "0")}`),
      ),
      "backfill_rows/t1/f8/0: 1 to 10,000 rows",
    ],
    [
      "backfill rows repeated",
      withBlock(S("schema.switched (after a migration)"), "backfill_rows/t1/f8/0", [ROW, ROW]),
      "backfill_rows/t1/f8/0[1]: ascending",
    ],
    [
      "pending though every change is auto",
      withBlock(
        patched("schema.compiled", "target", { outcome: "pending" }),
        "changes",
        CHANGES.map((c) => ({ ...c, auto: true })),
      ),
      "target: outcome",
    ],
  ];
  it.each(cases)("refuses %s", (_, s, issue) => {
    expect(issues(parse(s))).toContain(issue);
  });
  it("10,000 backfill rows are accepted", () => {
    const rows = Array.from({ length: 10000 }, (_, i) => `r_${String(i).padStart(26, "0")}`);
    expect(
      parse(withBlock(S("schema.switched (after a migration)"), "backfill_rows/t1/f8/0", rows)).ok,
    ).toBe(true);
  });
});

describe("parseEvent: an object where a scalar belongs is refused, not thrown on", () => {
  const evil = { toString: 1, valueOf: 1 };
  const cases = blocksOf().flatMap(([name, path, v]) =>
    leafPaths(v).map((at) => [name, path, at.join("."), at] as const),
  );
  it.each(cases)("%s %s .%s", (name, path, _, at) => {
    const s = S(name);
    const r = parse(
      withBlock(
        s,
        path,
        put(s.blocks[path], at, () => evil),
      ),
    );
    expect(r.ok).toBe(false);
  });
});

describe("parseEvent: a table ID of the wrong form with a physical name made to match it", () => {
  it.each(["T1", 't1"', "t01", "t1234567890", "t1 "])("%s", (bad) => {
    const s = compiledWith((c) => {
      tableOf(c, 1)["id"] = bad;
      tableOf(c, 1)["physical"] = { table: `t_${bad}_v2` };
    });
    expect(issues(parse(s))).toContain("compiled.tables[1]: id");
  });
});
