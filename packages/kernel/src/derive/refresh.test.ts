// derivedWrites over a fake query function: which derived writes one operation's base changes give
// (06-derived.md «刷新范围与写入准入», «行身份»; 09-event-format.md §4.2 step 6, §5.7
// `write.derived`). Running the queries on a database is tested in store-pglite
// (derive.prop.test.ts).

import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { loadRsql } from "../rules/index.ts";
import { derivedSchema, rule } from "../rules/rsql/rules.fixture.ts";
import { type BaseChange, derivedWrites, type Query } from "./refresh.ts";

let WEEKLY: ReturnType<typeof derivedSchema>;
let WHOLE: ReturnType<typeof derivedSchema>;
beforeAll(async () => {
  await loadRsql();
  WEEKLY = derivedSchema(
    rule(
      "SELECT date_trunc('week', date::timestamp)::date AS week_start, sum(distance) AS total, count(*) AS n FROM runs GROUP BY 1",
      ["week_start", "total", "n"],
      "bucketed",
    ),
  );
  WHOLE = derivedSchema(rule("SELECT sum(distance) AS total FROM runs", ["total"]));
});

type Rows = readonly Record<string, unknown>[];
interface Store {
  /** What the rule gives now. */
  readonly computed: Rows;
  /** partitions of t9: [partition_id, group_key JCS]. */
  readonly partitions: readonly (readonly [string, string])[];
  /** The derived table's rows. */
  readonly stored: Rows;
}

/** A fake query function over `s`, counting the queries by kind. */
function fake(s: Store) {
  const calls = { rule: 0, partitions: 0, stored: 0 };
  const query: Query = async (sql, params) => {
    if (sql.startsWith("WITH ")) {
      calls.rule++;
      return { rows: s.computed };
    }
    if (sql.startsWith("SELECT partition_id, group_key FROM partitions")) {
      calls.partitions++;
      expect(params).toEqual(["t9"]);
      return {
        rows: s.partitions.map(([partition_id, group_key]) => ({ partition_id, group_key })),
      };
    }
    if (sql.startsWith("SELECT partition_id, ") && sql.endsWith('FROM "d_t9_v1"')) {
      calls.stored++;
      return { rows: s.stored };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  return { query, calls };
}

const RUNS: BaseChange = { table: "t1", row: "r_1", fields: ["f1", "f2"] };
let next = 0;
const ids = () => {
  next = 0;
  return () => `p_new${++next}` as const;
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const week = (w: string, total: string, n: string) => ({ f1: w, f2: total, f3: n });
const storedWeek = (p: string, w: string, total: string, n: string) => ({
  partition_id: p,
  ...week(w, total, n),
  ver: "40",
});

describe("derivedWrites", () => {
  it("a new group: a new partition registered with its key, every field from null", async () => {
    const { query } = fake({
      computed: [week("2026-11-02", "31.00", "3")],
      partitions: [],
      stored: [],
    });
    const w = await derivedWrites({
      query,
      schema: WEEKLY,
      changes: [RUNS],
      newPartitionId: ids(),
      readPos: 57,
    });
    expect(w).toEqual([
      {
        target: {
          table: "t9",
          rule: "r1",
          rule_version: 1,
          partition: "p_new1",
          read_pos: 57,
          reads: [{ table: "t1" }],
          emptied: false,
        },
        key: { values: ["2026-11-02"] },
        checksum: {
          checksum: sha('{"f1":"2026-11-02","f2":{"unit":"km","value":"31"},"f3":"3"}'),
        },
        groupKey: ["2026-11-02"],
        changes: [
          { field: "f1", before: null, after: "2026-11-02" },
          { field: "f2", before: null, after: { value: "31", unit: "km" } },
          { field: "f3", before: null, after: "3" },
        ],
      },
    ]);
  });

  it("a changed row: only the changed fields, no key; the same result: no write", async () => {
    const { query } = fake({
      computed: [week("2026-11-02", "37.00", "4"), week("2026-10-26", "15.00", "2")],
      partitions: [
        ["p_a", '["2026-11-02"]'],
        ["p_b", '["2026-10-26"]'],
      ],
      stored: [
        storedWeek("p_a", "2026-11-02", "31", "3"),
        storedWeek("p_b", "2026-10-26", "15", "2"),
      ],
    });
    const w = await derivedWrites({
      query,
      schema: WEEKLY,
      changes: [RUNS],
      newPartitionId: ids(),
      readPos: 60,
    });
    expect(w.map((x) => [x.target.partition, x.key, x.changes])).toEqual([
      [
        "p_a",
        undefined,
        [
          { field: "f2", before: { value: "31", unit: "km" }, after: { value: "37", unit: "km" } },
          { field: "f3", before: "3", after: "4" },
        ],
      ],
    ]);
  });

  it("emptied: no key, no checksum, every value to null; the mapping is kept", async () => {
    const { query } = fake({
      computed: [],
      partitions: [["p_a", '["2026-11-02"]']],
      stored: [storedWeek("p_a", "2026-11-02", "31", "3")],
    });
    const w = await derivedWrites({
      query,
      schema: WEEKLY,
      changes: [RUNS],
      newPartitionId: ids(),
      readPos: 61,
    });
    expect(w).toEqual([
      {
        target: {
          table: "t9",
          rule: "r1",
          rule_version: 1,
          partition: "p_a",
          read_pos: 61,
          reads: [{ table: "t1" }],
          emptied: true,
        },
        groupKey: ["2026-11-02"],
        changes: [
          { field: "f1", before: "2026-11-02", after: null },
          { field: "f2", before: { value: "31", unit: "km" }, after: null },
          { field: "f3", before: "3", after: null },
        ],
      },
    ]);
  });

  it("a group emptied before comes back under its partition ID, without a key block", async () => {
    const { query } = fake({
      computed: [week("2026-11-02", "6.00", "1")],
      partitions: [["p_a", '["2026-11-02"]']],
      stored: [],
    });
    const w = await derivedWrites({
      query,
      schema: WEEKLY,
      changes: [RUNS],
      newPartitionId: ids(),
      readPos: 62,
    });
    expect(w.map((x) => [x.target.partition, x.target.emptied, x.key, x.changes.length])).toEqual([
      ["p_a", false, undefined, 3],
    ]);
  });

  it("a whole aggregate: from nothing to a row (key []), a change, back to nothing", async () => {
    const run = async (computed: Rows, partitions: Store["partitions"], stored: Rows) =>
      derivedWrites({
        query: fake({ computed, partitions, stored }).query,
        schema: WHOLE,
        changes: [RUNS],
        newPartitionId: ids(),
        readPos: 70,
      });
    // No input row: the rule's one row stands for no derived row.
    expect(await run([{ f1: null, inputs: "0" }], [], [])).toEqual([]);
    const first = await run([{ f1: "5.00", inputs: "1" }], [], []);
    expect(first.map((x) => [x.target.partition, x.key, x.groupKey])).toEqual([
      ["p_new1", { values: [] }, []],
    ]);
    const stored = [{ partition_id: "p_w", f1: "5", ver: "70" }];
    const changed = await run([{ f1: "7.00", inputs: "2" }], [["p_w", "[]"]], stored);
    expect(changed.map((x) => [x.target.partition, x.key, x.changes])).toEqual([
      [
        "p_w",
        undefined,
        [{ field: "f1", before: { value: "5", unit: "km" }, after: { value: "7", unit: "km" } }],
      ],
    ]);
    const gone = await run([{ f1: null, inputs: "0" }], [["p_w", "[]"]], stored);
    expect(gone.map((x) => [x.target.partition, x.target.emptied, x.checksum])).toEqual([
      ["p_w", true, undefined],
    ]);
  });

  it("writes are ordered by partition ID within the rule", async () => {
    const { query } = fake({
      computed: [
        week("2026-11-09", "1.00", "1"),
        week("2026-11-02", "2.00", "1"),
        week("2026-10-26", "3.00", "1"),
      ],
      partitions: [["p_m", '["2026-11-02"]']],
      stored: [
        storedWeek("p_z", "2026-01-05", "9", "1"),
        storedWeek("p_m", "2026-11-02", "1", "1"),
      ],
    });
    await expect(
      derivedWrites({ query, schema: WEEKLY, changes: [RUNS], newPartitionId: ids(), readPos: 1 }),
    ).rejects.toThrow("derived row p_z of t9 has no partition");
    const q2 = fake({
      computed: [
        week("2026-11-09", "1.00", "1"),
        week("2026-11-02", "2.00", "1"),
        week("2026-10-26", "3.00", "1"),
      ],
      partitions: [
        ["p_m", '["2026-11-02"]'],
        ["p_z", '["2026-01-05"]'],
      ],
      stored: [
        storedWeek("p_z", "2026-01-05", "9", "1"),
        storedWeek("p_m", "2026-11-02", "1", "1"),
      ],
    });
    const w = await derivedWrites({
      query: q2.query,
      schema: WEEKLY,
      changes: [RUNS],
      newPartitionId: ids(),
      readPos: 1,
    });
    expect(w.map((x) => x.target.partition)).toEqual(["p_m", "p_new1", "p_new2", "p_z"]);
  });

  it("only rules reading a changed table are recomputed, each once however often its table changed", async () => {
    const f = fake({ computed: [], partitions: [], stored: [] });
    expect(
      await derivedWrites({
        query: f.query,
        schema: WEEKLY,
        changes: [{ table: "t2", row: "r_9", fields: ["f3"] }],
        newPartitionId: ids(),
        readPos: 1,
      }),
    ).toEqual([]);
    expect(f.calls).toEqual({ rule: 0, partitions: 0, stored: 0 });
    await derivedWrites({
      query: f.query,
      schema: WEEKLY,
      changes: [RUNS, { ...RUNS, row: "r_2" }, { ...RUNS, row: "r_1", fields: ["f6"] }],
      newPartitionId: ids(),
      readPos: 1,
    });
    expect(f.calls).toEqual({ rule: 1, partitions: 1, stored: 1 });
  });

  it("a partition whose key was cleared stops: registering it again belongs with deletion", async () => {
    const query: Query = async (sql) => {
      if (sql.includes("FROM partitions"))
        return { rows: [{ partition_id: "p_a", group_key: null }] };
      return { rows: [] };
    };
    await expect(
      derivedWrites({ query, schema: WEEKLY, changes: [RUNS], newPartitionId: ids(), readPos: 1 }),
    ).rejects.toThrow("its key was cleared");
  });
});

// --- consistency, order across tables, errors, null fields --------------------------------------

/** A fake query routing by SQL: rule queries by their text, rows by table, partitions by table. */
function routed(o: {
  readonly rules: ReadonlyMap<string, Rows>;
  readonly stored?: Readonly<Record<string, Rows>>;
  readonly partitions?: Readonly<Record<string, readonly (readonly [string, string])[]>>;
}): Query {
  return async (sql, params) => {
    const rule = o.rules.get(sql);
    if (rule !== undefined) return { rows: rule };
    if (sql.startsWith("SELECT partition_id, group_key FROM partitions")) {
      const t = String(params[0]);
      return {
        rows: (o.partitions?.[t] ?? []).map(([partition_id, group_key]) => ({
          partition_id,
          group_key,
        })),
      };
    }
    const m = /FROM "d_(t\d+)_v1"$/.exec(sql);
    if (m !== null) return { rows: o.stored?.[m[1] as string] ?? [] };
    throw new Error(`unexpected query: ${sql}`);
  };
}

const P = (n: number) => `p_${String(n).padStart(16, "0")}`;

/** The weekly schema with a second derived table t10, a copy of t9 under its own IDs. */
function twoTables() {
  const t9 = WEEKLY.tables.find((t) => t.id === "t9");
  if (t9 === undefined || t9.kind !== "derived") throw new Error("no t9");
  const t10 = {
    ...t9,
    id: "t10",
    name: "weekly2",
    physical: { table: "d_t10_v1" },
    rule: { ...t9.rule, id: "r2" },
  };
  return { ...WEEKLY, tables: [...WEEKLY.tables, t10] } as typeof WEEKLY;
}

const run = (schema: typeof WEEKLY, query: Query) =>
  derivedWrites({ query, schema, changes: [RUNS], newPartitionId: ids(), readPos: 9 });

describe("derivedWrites: consistency of what is stored", () => {
  const sqlOf = async (schema: typeof WEEKLY, id: string) => {
    const { evaluateRule } = await import("../rules/index.ts");
    return evaluateRule(schema, id as never).all.sql;
  };

  it("two rows of the rule with one key; two partitions with one key; a partition without an ID", async () => {
    const sql = await sqlOf(WEEKLY, "t9");
    await expect(
      run(
        WEEKLY,
        routed({
          rules: new Map([
            [sql, [week("2026-11-02", "1.00", "1"), week("2026-11-02", "2.00", "1")]],
          ]),
        }),
      ),
    ).rejects.toThrow("two rows with one key");
    await expect(
      run(
        WEEKLY,
        routed({
          rules: new Map([[sql, []]]),
          partitions: {
            t9: [
              ["p_a", '["2026-11-02"]'],
              ["p_b", '["2026-11-02"]'],
            ],
          },
        }),
      ),
    ).rejects.toThrow("two partitions of t9 with one key");
    await expect(
      run(
        WEEKLY,
        routed({ rules: new Map([[sql, []]]), partitions: { t9: [["x", '["2026-11-02"]']] } }),
      ),
    ).rejects.toThrow("a partition without an ID");
  });

  it("a row not under the key its partition was registered with: no write at all", async () => {
    const sql = await sqlOf(WEEKLY, "t9");
    for (const computed of [
      [week("2026-11-02", "31.00", "3")],
      [week("2026-10-26", "31.00", "3")],
    ]) {
      await expect(
        run(
          WEEKLY,
          routed({
            rules: new Map([[sql, computed]]),
            partitions: { t9: [["p_a", '["2026-11-02"]']] },
            stored: { t9: [storedWeek("p_a", "2026-10-26", "31", "3")] },
          }),
        ),
      ).rejects.toThrow("derived row p_a of t9 is not under the key it was registered with");
    }
  });

  it("a whole aggregate registered with a key other than [], or with two partitions", async () => {
    const sql = await sqlOf(WHOLE, "t9");
    const stored = { t9: [{ partition_id: "p_w", f1: "5", ver: "1" }] };
    await expect(
      run(
        WHOLE,
        routed({
          rules: new Map([[sql, [{ f1: "7.00", inputs: "1" }]]]),
          partitions: { t9: [["p_w", '["x"]']] },
        }),
      ),
    ).rejects.toThrow('whole aggregate t9 is registered with key ["x"]');
    await expect(
      run(
        WHOLE,
        routed({
          rules: new Map([[sql, [{ f1: "7.00", inputs: "1" }]]]),
          partitions: {
            t9: [
              ["p_w", "[]"],
              ["p_v", '["y"]'],
            ],
          },
          stored,
        }),
      ),
    ).rejects.toThrow("whole aggregate t9 has several partitions");
  });
});

describe("derivedWrites: order across tables, evaluation errors, null fields, reads", () => {
  it("tables in the schema's order, each rule's writes by partition ID", async () => {
    const schema = twoTables();
    const sql9 = await import("../rules/index.ts").then(
      (m) => m.evaluateRule(schema, "t9").all.sql,
    );
    const sql10 = await import("../rules/index.ts").then(
      (m) => m.evaluateRule(schema, "t10").all.sql,
    );
    expect(sql9).toBe(sql10.replace(/d_t10/g, "d_t9")); // same rule text
    // Both rules print the same query: route both to two groups, and let t10's IDs sort first.
    let n = 0;
    const query = routed({
      rules: new Map([[sql9, [week("2026-11-09", "1.00", "1"), week("2026-11-02", "2.00", "1")]]]),
    });
    const w = await derivedWrites({
      query,
      schema,
      changes: [RUNS],
      newPartitionId: () => `p_${String(10 - ++n).padStart(16, "0")}` as const,
      readPos: 1,
    });
    expect(w.map((x) => [x.target.table, x.target.partition])).toEqual([
      ["t9", P(8)],
      ["t9", P(9)],
      ["t10", P(6)],
      ["t10", P(7)],
    ]);
  });

  it("an evaluation failing on the data is thrown as it is: out of range, a database data error", async () => {
    const sql = (await import("../rules/index.ts")).evaluateRule(WEEKLY, "t9").all.sql;
    const { RuleEvaluationError } = await import("../rules/index.ts");
    await expect(
      run(WEEKLY, routed({ rules: new Map([[sql, [week("10001-01-04", "1.00", "1")]]]) })),
    ).rejects.toBeInstanceOf(RuleEvaluationError);
    const dataError = Object.assign(new Error("bigint out of range"), { code: "22003" });
    await expect(
      run(WEEKLY, async () => {
        throw dataError;
      }),
    ).rejects.toBe(dataError);
  });

  it("only fields whose value differs: a field null on both sides is never listed; null to a value is", async () => {
    // A rule with a field that can be NULL: max over no non-null value.
    const s = derivedSchema(
      rule(
        "SELECT date_trunc('week', date::timestamp)::date AS w, max(pace) AS p, count(*) AS n FROM runs GROUP BY 1",
        ["w", "p", "n"],
        "bucketed",
      ),
    );
    const sql = (await import("../rules/index.ts")).evaluateRule(s, "t9").all.sql;
    const row = (p: string | null, n: string) => ({ f1: "2026-11-02", f2: p, f3: n });
    const stored = (p: string | null, n: string) => ({
      partition_id: "p_a",
      ...row(p, n),
      ver: "1",
    });
    const changed = async (rules: Rows, st: Rows, parts: readonly (readonly [string, string])[]) =>
      (
        await run(
          s,
          routed({ rules: new Map([[sql, rules]]), stored: { t9: st }, partitions: { t9: parts } }),
        )
      )[0]?.changes.map((c) => [c.field, c.before, c.after]);
    // New: the null field is not listed.
    expect(await changed([row(null, "1")], [], [])).toEqual([
      ["f1", null, "2026-11-02"],
      ["f3", null, "1"],
    ]);
    // Changed while the field stays null: not listed.
    expect(
      await changed([row(null, "2")], [stored(null, "1")], [["p_a", '["2026-11-02"]']]),
    ).toEqual([["f3", "1", "2"]]);
    // Null to a value: listed.
    expect(
      await changed([row("4.500", "2")], [stored(null, "2")], [["p_a", '["2026-11-02"]']]),
    ).toEqual([["f2", null, "4.5"]]);
    // Emptied: the field that was null is not listed.
    expect(await changed([], [stored(null, "2")], [["p_a", '["2026-11-02"]']])).toEqual([
      ["f1", "2026-11-02", null],
      ["f3", "2", null],
    ]);
  });

  it("reads: each base table once, in string order of the IDs", async () => {
    const t9 = WEEKLY.tables.find((t) => t.id === "t9");
    if (t9 === undefined || t9.kind !== "derived") throw new Error("no t9");
    const depends = ["t2", "t10", "t1", "t10"].map((table) => ({ table, field: "f1" }));
    const s = {
      ...WEEKLY,
      tables: WEEKLY.tables.map((t) =>
        t.id === "t9" ? { ...t9, rule: { ...t9.rule, depends_on: depends } } : t,
      ),
    } as typeof WEEKLY;
    const sql = (await import("../rules/index.ts")).evaluateRule(s, "t9").all.sql;
    const w = await run(s, routed({ rules: new Map([[sql, [week("2026-11-02", "1.00", "1")]]]) }));
    expect(w[0]?.target.reads).toEqual([{ table: "t1" }, { table: "t10" }, { table: "t2" }]);
  });
});
