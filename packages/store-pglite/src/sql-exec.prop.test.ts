// The execution fuzz of `sql`: no accepted statement reaches what it must not. Random statements the
// checker accepts (the front end's generator, over the slot `health`) are run on a tenant that also
// holds what no statement may reach, each with a marked value (./testing/sql-health.fixture.ts): a
// slot the caller cannot see, rows revoked, a value corrected, the kernel's own tables, a table of
// an older version, decoys named like a table of the slot. For each, four things:
//
// 1. no marker in the result, and none in what the call records;
// 2. the database's contents and the session's settings are what they were before the call;
// 3. the functions in the text that was executed (read again by the parser) are the whitelist's,
//    and the few the rewrite itself adds;
// 4. every table in the read record is one of the visible slot, and every row in it one that is applied and not revoked.
//
// On PGlite by default; on PostgreSQL with SAVESLOT_TEST_BACKEND=postgres (./testing/test-backend).
// The run count is PROP_RUNS or the default below.

import { KERNEL_TABLES, loadRsql } from "@fluxvita/saveslot-kernel";
import {
  AGGREGATES,
  cleanStatement,
  FUNCTIONS,
  fc,
  propRuns,
  rsqlParser,
  WINDOW_FUNCTIONS,
} from "@fluxvita/saveslot-kernel/rsql-testing";
import { sqlInTx } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore, snapshot } from "./testing/reusable-store.fixture.ts";
import {
  buildHealth,
  HEALTH,
  healthSchema,
  MARK,
  NOW,
  USER,
} from "./testing/sql-health.fixture.ts";

let s: ReusableStore;
let visibleTables: Set<string>;
/** For each visible table, the IDs of the rows (entities, partitions) that are applied and not revoked now. */
const live = new Map<string, Set<string>>();
beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-sqlfuzz-");
  await buildHealth(s);
  const tables = healthSchema().tables as unknown as {
    id: string;
    kind: string;
    time?: { type: string };
    physical: { table: string };
  }[];
  visibleTables = new Set(tables.map((t) => t.id));
  for (const t of tables) {
    const name = `"${t.physical.table}"`;
    const q =
      t.kind === "derived"
        ? `SELECT DISTINCT partition_id AS id FROM ${name}`
        : t.time?.type === "state"
          ? `SELECT DISTINCT entity_id AS id FROM ${name}`
          : `SELECT DISTINCT row_id AS id FROM ${name} WHERE NOT revoked`;
    const r = await s.store.read((tx) => tx.query<{ id: string }>(q));
    live.set(t.id, new Set(r.rows.map((x) => String(x.id))));
  }
}, 300_000);
afterAll(async () => {
  await s?.close();
}, 120_000);

/** The functions the rewrite itself puts in the executed text (merging segments, positions). */
const ADDED = ["bool_or"];
const ALLOWED = new Set(
  [...FUNCTIONS, ...AGGREGATES, ...WINDOW_FUNCTIONS]
    .flatMap((e) => [e.name, ...(e.aliases ?? [])])
    .concat(ADDED),
);

/**
 * The relations a parse tree reads. The kernel's own lookups of a row's version and flags (the read
 * record) read its tables; a statement built from the caller's text never does.
 */
function relationsIn(tree: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(tree)) for (const x of tree) relationsIn(x, out);
  else if (tree !== null && typeof tree === "object") {
    for (const [k, v] of Object.entries(tree)) {
      if (k === "RangeVar") out.add((v as { relname: string }).relname);
      relationsIn(v, out);
    }
  }
  return out;
}
const KERNEL = new Set(KERNEL_TABLES.map((t) => t.name));

/** Every function called in a parse tree, by its last name part. */
function functionsIn(tree: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(tree)) for (const x of tree) functionsIn(x, out);
  else if (tree !== null && typeof tree === "object") {
    for (const [k, v] of Object.entries(tree)) {
      if (k === "FuncCall") {
        const names = (v as { funcname: { String: { sval: string } }[] }).funcname;
        out.add((names[names.length - 1] as { String: { sval: string } }).String.sval);
      }
      functionsIn(v, out);
    }
  }
  return out;
}

/** The functions of the kernel's own lookups for the read record. */
const LOOKUP = new Set(["to_char", "max"]);
const SESSION = "SELECT name, setting FROM pg_settings ORDER BY name";
const counts = { samples: 0, executed: 0, refused: 0, rows: 0 };
const KERNEL_SET = /^(SET LOCAL|SHOW|SELECT set_config)/;

const RUNS = propRuns(150);

/** The four things, for one statement. */
async function holds(g: { sql: string; params: readonly unknown[] }): Promise<void> {
  counts.samples++;
  const before = await s.store.read((tx) => snapshot(tx));
  const statements: { text: string; params: readonly unknown[] }[] = [];
  let outcome: unknown;
  let entry: unknown;
  let settingsBefore: unknown;
  let settingsAfter: unknown;
  await s.store.read(async (tx) => {
    settingsBefore = (await tx.query(SESSION)).rows;
    try {
      const out = await sqlInTx(
        {
          query: (text, p) => {
            statements.push({ text, params: p ?? [] });
            return tx.query(text, p);
          },
        },
        {
          actor: USER as never,
          task: null,
          now: NOW as never,
          visibility: { kind: "scoped", slots: [{ slot: HEALTH }] },
          params: { sql: g.sql, ...(g.params.length > 0 ? { params: g.params } : {}) },
          read: `rd_${"0".repeat(16)}` as never,
        },
      );
      outcome = out.result;
      entry = out.entry;
      counts.executed++;
      counts.rows += out.result.rows.length;
    } catch (e) {
      // A statement the checker accepts can still fail as it runs (a division, a range): refused
      // as the caller's, never as anything else.
      const x = e as { code?: string; detail?: { reason?: string } };
      if (x.code !== "sql_rejected" || x.detail?.reason !== "runtime") throw e;
      counts.refused++;
    }
    settingsAfter = (await tx.query(SESSION)).rows;
  });

  // 1. no marker anywhere in what came back or what is recorded.
  const seen = JSON.stringify([outcome, entry], (_k, v) => (typeof v === "bigint" ? String(v) : v));
  expect(seen, g.sql).not.toContain(MARK);

  // 2. the database and the session as they were.
  const after = await s.store.read((tx) => snapshot(tx));
  expect(after, g.sql).toEqual(before);
  expect(settingsAfter, g.sql).toEqual(settingsBefore);

  // 3. the functions of what was executed.
  for (const st of statements) {
    if (KERNEL_SET.test(st.text)) continue;
    const tree = rsqlParser().parse(st.text);
    const functions = functionsIn(tree);
    if ([...relationsIn(tree)].some((r) => KERNEL.has(r))) {
      // The kernel's own lookup of versions and flags for the read record: fixed text, no table of
      // the caller's but the version table of a physical one, and only the functions it is written with.
      for (const f of functions) expect(LOOKUP.has(f), `${f} in ${st.text}`).toBe(true);
      expect(st.text, "a lookup of the kernel's must not carry the caller's text").not.toMatch(
        /FROM "t_t\d+_v\d+" /,
      );
      continue;
    }
    for (const f of functions) {
      expect(ALLOWED.has(f), `${f} in ${st.text}`).toBe(true);
      added.add(f);
    }
  }

  // 4. every table of the read record is visible, and every row of it a live one.
  const e = entry as { rows?: { table: string }[]; coarse?: string[]; table?: string } | undefined;
  if (e !== undefined) {
    const ids = new Set([
      ...(e.rows ?? []).map((r) => r.table),
      ...(e.coarse ?? []),
      ...(e.table !== undefined ? [e.table] : []),
    ]);
    for (const id of ids) expect(visibleTables.has(id), `${id} for ${g.sql}`).toBe(true);
    // 5. every row of the record is one that is applied now, not revoked, in a visible table.
    for (const r of (e as { rows?: { table: string; target: string }[] }).rows ?? []) {
      expect(live.get(r.table)?.has(r.target), `${r.table}/${r.target} for ${g.sql}`).toBe(true);
    }
  }
}
const added = new Set<string>();

/** Statements over the tables that are read through the rewrite: state, derived, joined to events. */
const stateStatement = fc
  .tuple(
    fc.constantFrom("budgets", "rooms"),
    fc.constantFrom(
      "*",
      "count(*)",
      "valid_from, valid_to",
      "entity_id, valid_from",
      "min(valid_from), max(valid_to)",
    ),
    fc.nat({ max: 5 }),
    fc.constantFrom("", " WHERE valid_from IS NOT NULL", " LIMIT 1", " ORDER BY 1"),
  )
  .map(([table, list, n, tail]) => {
    const day = table === "budgets";
    const at = (d: string) => (day ? d : `${d}T10:00:00Z`);
    const clauses = [
      "",
      ` FOR VALID_TIME AS OF '${at("2026-11-02")}'`,
      ` FOR VALID_TIME AS OF '${at("2026-11-15")}'`,
      ` FOR VALID_TIME FROM '${at("2026-10-01")}' TO '${at("2026-12-01")}'`,
      ` FOR VALID_TIME FROM '${at("2026-11-01")}' TO '${at("2026-11-12")}'`,
      ` FOR VALID_TIME AS OF '${at("2025-01-01")}'`,
    ];
    const grouped = list.includes("(") ? "" : tail;
    return { sql: `SELECT ${list} FROM ${table}${clauses[n]}${grouped}`, params: [] as unknown[] };
  });

const joined = fc
  .constantFrom(
    "SELECT b.category, count(*) FROM budgets b CROSS JOIN runs r GROUP BY 1",
    "SELECT r.laps, b.amount FROM runs r JOIN budgets b ON b.category = r.route",
    "SELECT * FROM weekly",
    "SELECT week, km FROM weekly ORDER BY 1",
    "SELECT (SELECT count(*) FROM budgets) AS n, (SELECT count(*) FROM rooms) AS m",
    "WITH c AS (SELECT * FROM budgets FOR VALID_TIME AS OF '2026-11-15') SELECT * FROM c, shoes",
  )
  .map((sql) => ({ sql, params: [] as unknown[] }));

describe("what an accepted statement reaches", () => {
  it("event and none tables: reads nothing it must not, changes nothing, calls only what is allowed, records only what is visible", async () => {
    await fc.assert(fc.asyncProperty(cleanStatement, holds), { numRuns: RUNS });
    process.stderr.write(`sql-exec fuzz: ${JSON.stringify({ runs: RUNS, ...counts })}\n`);
    expect(counts.executed).toBeGreaterThan(RUNS * 0.5);
  }, 3_600_000);

  it("state and derived tables (the rewrite merges segments): the same four things", async () => {
    added.clear();
    await fc.assert(fc.asyncProperty(fc.oneof(stateStatement, joined), holds), {
      numRuns: RUNS,
    });
    process.stderr.write(
      `sql-exec fuzz (state): ${JSON.stringify({ runs: RUNS, ...counts, added: [...added] })}\n`,
    );
    // What the rewrite adds, `bool_or` of the merge of segments, is in the executed text.
    expect(added.has("bool_or")).toBe(true);
  }, 3_600_000);
});
