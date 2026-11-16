// planDerived: the changes of a `write.derived` and the checks against its partition recomputed
// (09-event-format.md §5.7; 06-derived.md «行身份»). The inputs are given here as readInputs would
// read them; recomputing on a database is tested in store-pglite (derive.prop.test.ts).

import { beforeAll, describe, expect, it } from "vitest";
import { loadRsql, rowChecksum } from "../rules/index.ts";
import { derivedSchema, rule } from "../rules/rsql/rules.fixture.ts";
import { type DerivedInput, derivedTableDdl, planDerived } from "./derived.ts";
import { ApplyError } from "./model.ts";

let schema: ReturnType<typeof derivedSchema>;
beforeAll(async () => {
  await loadRsql();
  schema = derivedSchema(
    rule(
      "SELECT date_trunc('week', date::timestamp)::date AS w, sum(distance) AS total FROM runs GROUP BY 1",
      ["w", "total"],
      "bucketed",
    ),
  );
});

const P = `p_${"5".repeat(16)}`;
const ROW = { values: { f1: "2026-11-02", f2: { value: "31", unit: "km" } }, key: ["2026-11-02"] };
const SEQ = 42;
const OP = 40;
const target = (o: Record<string, unknown> = {}) => ({
  table: "t9",
  rule: "r1",
  rule_version: 1,
  partition: P,
  read_pos: 41,
  reads: [{ table: "t1" }],
  emptied: false,
  ...o,
});
const input = (o: Partial<DerivedInput> = {}): DerivedInput => ({
  schema,
  registered: { groupKey: '["2026-11-02"]' },
  keyTakenBy: undefined,
  recomputed: { rows: [ROW as never] },
  exists: true,
  ...o,
});
const checksum = () => ({ checksum: rowChecksum(ROW.values as never) });

/** The verdict of planDerived: the kinds of its changes, or the stop's reason and message. */
function verdict(
  present: Record<string, unknown>,
  inp: DerivedInput | undefined,
  removed: string[] = [],
): unknown {
  try {
    return planDerived(SEQ, OP, present as never, new Set(removed), inp).map((c) => c.kind);
  } catch (e) {
    if (e instanceof ApplyError)
      return `${e.reason}: ${e.message.replace(/^apply stopped at seq \d+: /, "")}`;
    throw e;
  }
}

describe("planDerived", () => {
  it("a new partition: registered, its row set to the recomputed values, ver the operation", () => {
    const changes = planDerived(
      SEQ,
      OP,
      { target: target(), key: { values: ["2026-11-02"] }, checksum: checksum() } as never,
      new Set(),
      input({ registered: undefined, exists: false }),
    );
    expect(changes).toEqual([
      { kind: "partition_insert", table_id: "t9", partition: P, group_key: '["2026-11-02"]' },
      {
        kind: "derived_set",
        table: "d_t9_v1",
        partition: P,
        columns: ["f_f1", "f_f2"],
        values: ["2026-11-02", "31"],
        ver: OP,
      },
      {
        kind: "derived_reads",
        rows: [
          { derived_seq: SEQ, base_table_id: "t1", partition_id: P, rule_version: 1, read_pos: 41 },
        ],
      },
    ]);
  });

  it("a registered partition: set again without a key; emptied: the row removed", () => {
    expect(verdict({ target: target(), checksum: checksum() }, input())).toEqual([
      "derived_set",
      "derived_reads",
    ]);
    expect(
      verdict({ target: target({ emptied: true }) }, input({ recomputed: { rows: [] } })),
    ).toEqual(["derived_delete", "derived_reads"]);
  });

  it("emptied must agree with the recomputation, and so must the checksum", () => {
    expect(verdict({ target: target({ emptied: true }) }, input())).toBe(
      `inconsistent: partition ${P} is not empty`,
    );
    expect(
      verdict({ target: target(), checksum: checksum() }, input({ recomputed: { rows: [] } })),
    ).toBe(`inconsistent: partition ${P} gives 0 rows, not one`);
    expect(
      verdict(
        { target: target(), checksum: checksum() },
        input({ recomputed: { rows: [ROW as never, ROW as never] } }),
      ),
    ).toBe(`inconsistent: partition ${P} gives 2 rows, not one`);
    expect(verdict({ target: target(), checksum: { checksum: "0".repeat(64) } }, input())).toBe(
      `inconsistent: partition ${P}: the checksum is not the recomputed row's`,
    );
    expect(
      verdict(
        { target: target({ emptied: true }) },
        input({ recomputed: { rows: [] }, exists: false }),
      ),
    ).toBe(`inconsistent: partition ${P} has no row to empty`);
  });

  it("a checksum cleared by a deletion is not checked", () => {
    expect(verdict({ target: target() }, input(), ["checksum"])).toEqual([
      "derived_set",
      "derived_reads",
    ]);
  });

  it("read_pos within the operation: not before its head, before this event", () => {
    const at = (read_pos: number) =>
      verdict({ target: target({ read_pos }), checksum: checksum() }, input());
    expect(at(OP)).toEqual(["derived_set", "derived_reads"]);
    expect(at(SEQ - 1)).toEqual(["derived_set", "derived_reads"]);
    expect(at(SEQ)).toBe(
      `inconsistent: read_pos ${SEQ} is not within operation ${OP} before ${SEQ}`,
    );
    expect(at(OP - 1)).toBe(
      `inconsistent: read_pos ${OP - 1} is not within operation ${OP} before ${SEQ}`,
    );
  });

  it("the key block: on the first write of a partition only, never for a key registered elsewhere", () => {
    expect(
      verdict({ target: target(), checksum: checksum() }, input({ registered: undefined })),
    ).toBe(`inconsistent: partition ${P} is not registered`);
    expect(
      verdict({ target: target(), key: { values: ["2026-11-02"] }, checksum: checksum() }, input()),
    ).toBe(`inconsistent: partition ${P} is registered already`);
    expect(
      verdict(
        { target: target(), key: { values: ["2026-11-02"] }, checksum: checksum() },
        input({ registered: undefined, keyTakenBy: "p_OTHER" }),
      ),
    ).toBe("inconsistent: its key is registered for partition p_OTHER");
  });

  it("registering again after a deletion: not in this version", () => {
    expect(
      verdict(
        { target: target(), checksum: checksum() },
        input({ registered: { groupKey: null } }),
      ),
    ).toBe(`not_implemented: partition ${P}: its key was cleared`);
    expect(verdict({ target: target(), checksum: checksum() }, input(), ["key"])).toBe(
      "not_implemented: a derived write whose key was deleted",
    );
  });

  it("the table, rule and reads are the definition's", () => {
    expect(verdict({ target: target({ table: "t1" }), checksum: checksum() }, input())).toBe(
      "inconsistent: no derived table t1",
    );
    expect(verdict({ target: target({ rule_version: 2 }), checksum: checksum() }, input())).toBe(
      "inconsistent: rule r1 v2 is not r1 v1",
    );
    expect(
      verdict(
        { target: target({ reads: [{ table: "t1" }, { table: "t2" }] }), checksum: checksum() },
        input(),
      ),
    ).toBe("inconsistent: reads t1,t2 are not the tables rule r1 reads");
    expect(verdict({ target: target(), checksum: checksum() }, undefined)).toBe(
      "inconsistent: no derived table t9 in the slot",
    );
  });

  it("a recomputation that meets a data error: inconsistent, not rule_eval_failed", () => {
    expect(
      verdict(
        { target: target(), checksum: checksum() },
        input({ recomputed: { error: "f1: 10001-01-04 is not a date of 0001–9999" } }),
      ),
    ).toBe(`inconsistent: recomputing partition ${P}: f1: 10001-01-04 is not a date of 0001–9999`);
  });
});

describe("derivedTableDdl", () => {
  it("partition_id, a column per derived field, ver", () => {
    const t = schema.tables.find((x) => x.id === "t9");
    if (t === undefined || t.kind !== "derived") throw new Error("no t9");
    expect(derivedTableDdl(t, (type) => (type === "date" ? "DATE" : "NUMERIC"))).toBe(
      'CREATE TABLE "d_t9_v1" (\n  partition_id TEXT COLLATE "C" PRIMARY KEY,\n  "f_f1" DATE,\n  "f_f2" NUMERIC,\n  ver BIGINT NOT NULL\n);',
    );
  });
});

describe("canonicalKeyFault: a key block in the canonical form of the key fields", () => {
  const tableOf = (sql: string, fields: string[]) => {
    const t = derivedSchema(rule(sql, fields)).tables.find((x) => x.id === "t9");
    if (t === undefined || t.kind !== "derived") throw new Error("no t9");
    return t;
  };
  it("decimal, quantity, integer, boolean keys: canonical taken, other spellings refused", async () => {
    const { canonicalKeyFault } = await import("./derived.ts");
    const cases: [string, unknown, unknown][] = [
      ["pace", "1.5", "1.50"],
      ["distance", { value: "2.5", unit: "km" }, { value: "2.5", unit: "m" }],
      ["laps", "3", "03"],
      ["race", true, "true"],
    ];
    for (const [col, ok, bad] of cases) {
      const t = tableOf(`SELECT ${col} AS k, count(*) AS n FROM runs GROUP BY 1`, ["k", "n"]);
      expect({ col, ok: canonicalKeyFault(t, [ok] as never) }).toEqual({ col, ok: undefined });
      expect({ col, bad: canonicalKeyFault(t, [bad] as never) }).toEqual({
        col,
        bad: expect.stringMatching(/^key value 0 is not a canonical /),
      });
      expect(canonicalKeyFault(t, [null])).toBeUndefined();
      expect(canonicalKeyFault(t, [ok, ok] as never)).toBe("a key of 2 values for 1 key fields");
    }
    // More places than the field's scale (pace: 3).
    const pace = tableOf("SELECT pace AS k, count(*) AS n FROM runs GROUP BY 1", ["k", "n"]);
    expect(canonicalKeyFault(pace, ["1.2345"])).toBe("key value 0 is not a canonical decimal");
  });
});

describe("planDerived: more of what it checks", () => {
  it("the rule ID is the definition's", () => {
    expect(verdict({ target: target({ rule: "r9" }), checksum: checksum() }, input())).toBe(
      "inconsistent: rule r9 v1 is not r1 v1",
    );
  });

  it("the row recomputed under a key block is the group the block names", () => {
    expect(
      verdict(
        { target: target(), key: { values: ["2026-11-09"] }, checksum: checksum() },
        input({ registered: undefined, exists: false }),
      ),
    ).toBe(`inconsistent: partition ${P}: its key is not the recomputed row's`);
  });

  it("a partition ID registered for another derived table", () => {
    expect(
      verdict(
        { target: target(), key: { values: ["2026-11-02"] }, checksum: checksum() },
        input({ registered: undefined, exists: false, idTakenBy: "t10" }),
      ),
    ).toBe(`inconsistent: partition ${P} is registered for table t10`);
  });
});
