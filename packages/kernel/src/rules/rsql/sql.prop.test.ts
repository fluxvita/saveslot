// Properties of the `sql` front end (./sql.ts; 11-restricted-sql.md «怎么测» experiment 2, context S).
//
// 1. The same outcome under every spelling and place: a case of the manual list (./sql-cases.fixture.ts)
//    keeps its exact reason code under random chains of case, quoting, comments, line breaks, and
//    put into a subquery, a CASE, a CTE; a positive case stays accepted with the same columns.
// 2. Random statements (./sql-generate.fixture.ts): a clean one is accepted; one with a refused
//    expression put in gets that expression's reason; and an accepted one prints, as the printer
//    gives it, to text that the parser reads back as an equal tree, that holds only whitelisted nodes
//    and functions, and that is accepted again with the same result columns.
// 3. Text that is mostly not a statement never throws, and is refused for a reason of the contract,
//    with a line that is in the text, no physical name, and no "not compiled yet".

import { SQL_REASONS } from "@fluxvita/saveslot-contract-core";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { loadRsql, rsqlParser } from "./load.ts";
import { Hits, propRuns } from "./rsql-testing.fixture.ts";
import { check, health, healthSchema, ledger, outcome } from "./sql.fixture.ts";
import { readSql } from "./sql.ts";
import { inRuns, REFUSED } from "./sql-cases.fixture.ts";
import {
  cleanStatement,
  type Generated,
  refusedStatement,
  TOKENS,
} from "./sql-generate.fixture.ts";
import { EXPR_PLACES, SELECT_PLACES, SPELLINGS, variations } from "./sql-mutate.fixture.ts";
import { POSITIVE } from "./sql-positive.fixture.ts";
import { printQuery } from "./sql-print.ts";
import { AGGREGATES, FUNCTIONS, NODES, WINDOW_FUNCTIONS } from "./whitelist.ts";

vi.setConfig({ testTimeout: 600_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 580_000, markInterruptAsFailure: true });
await loadRsql();

const both = [health(), ledger()];
const shape = (q: unknown): string =>
  JSON.stringify(q, (k, v: unknown) =>
    k === "loc"
      ? undefined
      : v !== null && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
        : v,
  );
const cols = (r: ReturnType<typeof check>) =>
  r.ok ? r.analysis.columns.map((c) => `${c.name}:${c.type}:${c.unit ?? ""}`).join(",") : "";
const physical = healthSchema().tables.map((t) => t.physical.table);

/** What every refusal must satisfy, however the text came about. */
function wellFormedRefusal(sql: string, r: ReturnType<typeof check>): void {
  if (r.ok) return;
  const e = r.error;
  expect(e.message.length).toBeGreaterThan(0);
  expect(e.message).not.toMatch(/not compiled yet|not implemented/);
  if (e.code === "sql_rejected") expect(SQL_REASONS).toContain(e.reason);
  else expect(["ambiguous_table", "granularity", "malformed"]).toContain(e.reason);
  const line = "line" in e ? e.line : undefined;
  if (line !== undefined) {
    const lines = sql.split(/\r\n|\r|\n/).length + 1;
    expect(Number.isInteger(line) && line >= 1 && line <= lines, `line ${line} of ${lines}`).toBe(
      true,
    );
  }
  const text = JSON.stringify(e);
  // (A caller who typed a physical name gets it back as the name they wrote.)
  for (const p of physical) if (!sql.toLowerCase().includes(p)) expect(text).not.toContain(p);
}

const REFUSED_FIXED = REFUSED.filter((c) => !/VALID_TIME|SYSTEM_TIME/i.test(c.sql));
const spellings = fc.array(fc.constantFrom(...SPELLINGS), { minLength: 1, maxLength: 3 });

describe("spellings and places of the manual list", () => {
  it("every refused case keeps its outcome under a random chain of spellings and a place", () => {
    const hits = new Hits(0.95);
    fc.assert(
      fc.property(
        fc.constantFrom(...REFUSED),
        spellings,
        fc.option(fc.nat(), { nil: undefined }),
        hits.track((c, chain, placeIndex) => {
          let sql = c.where === "expr" ? inRuns(c.sql) : c.sql;
          if (placeIndex !== undefined && c.where !== "stmt") {
            const places = c.where === "expr" ? EXPR_PLACES : SELECT_PLACES;
            const p = places[placeIndex % places.length];
            if (p === undefined) return;
            if (
              c.where === "expr" &&
              /(^|\s)(sum|count|min|max|avg|OVER)\b/i.test(c.sql) &&
              /WHERE|condition|join/.test(p.name)
            )
              return;
            sql = p.put(c.sql);
          }
          for (const m of chain) sql = m.apply(sql);
          const r = check(sql, [...(c.params ?? [])]);
          expect({ sql, got: outcome(r) }).toEqual({ sql, got: c.want });
          wellFormedRefusal(sql, r);
          hits.hit();
        }),
      ),
      { numRuns: propRuns(1500) },
    );
    hits.check();
  });

  it("every positive case stays accepted with its columns under a random chain of spellings", () => {
    fc.assert(
      fc.property(fc.constantFrom(...POSITIVE), spellings, (p, chain) => {
        const slots = p.ledger === true ? both : [health()];
        const params = [...(p.params ?? [])];
        const base = check(p.sql, params, slots);
        expect(base.ok, p.sql).toBe(true);
        let sql = p.sql;
        for (const m of chain) sql = m.apply(sql);
        const r = check(sql, params, slots);
        expect({ sql, got: outcome(r) }).toEqual({ sql, got: "ok" });
        expect(cols(r)).toBe(cols(base));
      }),
      { numRuns: propRuns(1000) },
    );
  });

  it("every variation of every refused case, with the case's exact reason (a fixed sweep)", () => {
    let n = 0;
    for (const c of REFUSED_FIXED) {
      for (const v of variations(c)) {
        n++;
        expect({
          v: v.name,
          sql: v.sql,
          got: outcome(check(v.sql, [...(c.params ?? [])])),
        }).toEqual({
          v: v.name,
          sql: v.sql,
          got: c.want,
        });
      }
    }
    expect(n).toBeGreaterThan(4000);
  });
});

/** The names of the parse tree's nodes, by the whitelist's names. */
function treeNodes(tree: unknown): Set<string> {
  const seen = new Set<string>();
  const walk = (v: unknown, key?: string): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x, key);
      return;
    }
    if (v === null || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (/^[A-Z]/.test(k) && x !== null && typeof x === "object") seen.add(k);
      if (k === "stmts") seen.add("RawStmt");
      walk(x, k);
    }
  };
  walk(tree);
  return seen;
}

/** The last name of every function call in the tree. */
function treeFunctions(tree: unknown): Set<string> {
  const seen = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v === null || typeof v !== "object") return;
    const f = (v as { FuncCall?: { funcname?: { String?: { sval?: string } }[] } }).FuncCall;
    const last = f?.funcname?.at(-1)?.String?.sval;
    if (last !== undefined) seen.add(last);
    Object.values(v).forEach(walk);
  };
  walk(tree);
  return seen;
}

const ALLOWED_NODES = new Set(NODES.filter((n) => n.contexts.includes("S")).map((n) => n.name));
const ALLOWED_FUNCTIONS = new Set([
  ...[...FUNCTIONS, ...AGGREGATES, ...WINDOW_FUNCTIONS].flatMap((f) => [
    f.name,
    ...(f.aliases ?? []),
  ]),
  // The parser's own names for syntax the whitelist spells otherwise.
  "extract",
  "btrim",
  "substring",
  "position",
  "char_length",
  "date_part",
  "overlay",
]);

/** Everything an accepted statement must satisfy. */
function acceptedHolds(g: Generated): void {
  const slots = [health()];
  const r = check(g.sql, g.params, slots);
  if (!r.ok) throw new Error(`${g.sql}\n→ ${JSON.stringify(r.error)}`);
  // The caller's text, read alone, then printed: the tree is the same.
  const read = readSql(g.sql);
  if (!read.ok) throw new Error(`${g.sql}\n→ ${JSON.stringify(read.error)}`);
  const text = printQuery(read.query);
  const again = readSql(text);
  if (!again.ok) throw new Error(`${g.sql}\n→ ${text}\n→ ${JSON.stringify(again.error)}`);
  expect(shape(again.query), `${g.sql}\n→ ${text}`).toBe(shape(read.query));
  // The analysed query, its stars expanded and its names resolved, prints to text the parser reads
  // as a tree of whitelisted nodes only, and that is accepted again with the same result.
  const printed = printQuery(r.analysis.query);
  const tree = rsqlParser().parse(printed);
  const nodes = treeNodes(tree);
  expect(
    [...nodes].filter((n) => !ALLOWED_NODES.has(n)),
    printed,
  ).toEqual([]);
  expect(
    [...treeFunctions(tree)].filter((f) => !ALLOWED_FUNCTIONS.has(f)),
    printed,
  ).toEqual([]);
  const second = check(printed, g.params, slots);
  if (!second.ok) throw new Error(`${g.sql}\n→ ${printed}\n→ ${JSON.stringify(second.error)}`);
  expect(cols(second), printed).toBe(cols(r));
  expect(shape(readSql(printed).ok ? (readSql(printed) as { query: unknown }).query : null)).toBe(
    shape(r.analysis.query),
  );
  // Nothing of the caller's spelling is left: comments and the break markers are not in the text.
  expect(printed.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "")).not.toMatch(/--|\/\*/);
}

/**
 * A random statement can pass a limit of 11 «代价» (the table references and the subqueries add up
 * over its parts): it is then refused as `limit`, which the fixed tests pin at the limit and one over,
 * and does not count here. Rare; the properties require that most statements are not.
 */
const LIMIT = "sql_rejected/limit";
const overLimit = (g: Generated): boolean => outcome(check(g.sql, g.params)) === LIMIT;

describe("random statements", () => {
  it("clean ones are accepted, and what is printed of them reads back as the same query", () => {
    const hits = new Hits(0.9);
    fc.assert(
      fc.property(
        cleanStatement,
        hits.track((g) => {
          if (overLimit(g)) return;
          acceptedHolds(g);
          hits.hit();
        }),
      ),
      { numRuns: propRuns(1500) },
    );
    hits.check();
  });

  it("with a refused expression put in, they get that expression's reason", () => {
    const hits = new Hits(0.9);
    fc.assert(
      fc.property(
        refusedStatement,
        hits.track((g) => {
          const r = check(g.sql, g.params);
          if (outcome(r) === LIMIT) return;
          expect({ sql: g.sql, bad: g.bad, got: outcome(r) }).toEqual({
            sql: g.sql,
            bad: g.bad,
            got: g.want,
          });
          wellFormedRefusal(g.sql, r);
          hits.hit();
        }),
      ),
      { numRuns: propRuns(1500) },
    );
    hits.check();
  });

  it("with a spelling applied to either kind, keep their outcome", () => {
    const hits = new Hits(0.9);
    fc.assert(
      fc.property(
        fc.oneof(cleanStatement, refusedStatement),
        spellings,
        hits.track((g, chain) => {
          if (overLimit(g)) return;
          let sql = g.sql;
          for (const m of chain) sql = m.apply(sql);
          const r = check(sql, g.params);
          // Comments and spaces make the text longer: that alone may pass the limit of its size.
          if (outcome(r) === LIMIT && new TextEncoder().encode(sql).length > 16384) return;
          expect({ sql, got: outcome(r) }).toEqual({ sql, got: g.want });
          if (g.want === "ok") expect(cols(r)).toBe(cols(check(g.sql, g.params)));
          hits.hit();
        }),
      ),
      { numRuns: propRuns(1000) },
    );
    hits.check();
  });

  it("reach each form of the grammar often enough to mean something", () => {
    const hits = new Hits(0.3);
    const forms = new Map<string, number>();
    const mark: [string, RegExp][] = [
      ["join", /\bJOIN\b/],
      ["subquery", /\(SELECT\b/],
      ["cte", /\bWITH\b/],
      ["set operation", /\b(UNION|INTERSECT|EXCEPT)\b/],
      ["group by", /\bGROUP BY\b/],
      ["window", /\bOVER\b/],
      ["param", /\$1\b/],
      ["case", /\bCASE\b/],
      ["distinct", /\bDISTINCT\b/],
      ["exists", /\bEXISTS\b/],
      ["in list", /\bIN \(/],
      ["like", /\bLIKE\b/],
    ];
    fc.assert(
      fc.property(
        cleanStatement,
        hits.track((g) => {
          if (overLimit(g)) return;
          expect(check(g.sql, g.params).ok, g.sql).toBe(true);
          hits.hit();
          for (const [name, re] of mark)
            if (re.test(g.sql)) forms.set(name, (forms.get(name) ?? 0) + 1);
        }),
      ),
      { numRuns: propRuns(1500) },
    );
    hits.check();
    const n = hits.hits;
    // Each form is in at least 3% of the statements.
    expect(
      mark
        .map(([name]) => [name, (forms.get(name) ?? 0) / n] as const)
        .filter(([, share]) => share < 0.03),
    ).toEqual([]);
  });
});

describe("text that is mostly not a statement", () => {
  const soup = fc
    .array(fc.constantFrom(...TOKENS), { minLength: 0, maxLength: 24 })
    .map((ts) => ts.join(" "));
  const anyText = fc.oneof(
    soup,
    fc.string({ unit: "binary", maxLength: 60 }),
    fc.string({ unit: "grapheme", maxLength: 60 }),
  );

  it("never throws, and is refused for a reason of the contract, or accepted as a statement", () => {
    const hits = new Hits(0.9);
    fc.assert(
      fc.property(
        anyText,
        hits.track((sql) => {
          const r = check(sql, [], both);
          wellFormedRefusal(sql, r);
          if (r.ok) acceptedHolds({ sql, params: [], want: "ok" });
          hits.hit();
        }),
      ),
      { numRuns: propRuns(4000) },
    );
    hits.check();
  });

  it("with parameters a statement does not have, or not enough of them, is `malformed`, never a throw", () => {
    fc.assert(
      fc.property(
        soup,
        fc.array(fc.oneof(fc.integer(), fc.string(), fc.constant(null), fc.boolean()), {
          maxLength: 4,
        }),
        (sql, params) => {
          const r = check(sql, params, both);
          wellFormedRefusal(sql, r);
        },
      ),
      { numRuns: propRuns(1500) },
    );
  });
});
