// Checks the claims index (docs/zh-CN/spec/11-claims.md): every row links back to the spec, has
// an oracle and a known status, and every test it names is a case that exists in the named test
// file and is not skipped. A row with no test says so in its status; a row with a test does not.
//
// A test reference in the 测试 column is a code span with the test file's path from the
// repository root, then the case's titles as code spans: the `it` title, or the titles of the
// `describe` blocks around it and then the `it` title, innermost last. Titles are matched as they
// are written in the source (an `it.each` title keeps its `%s`). Whether the named tests pass is
// not checked here: `pnpm check` runs them.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { splitFences } from "./markdown.ts";

export const CLAIMS_FILE = "docs/zh-CN/spec/11-claims.md";

/** The statuses a row may have; only a row with no test reference is `无测试`. */
export const STATUSES = ["成立", "部分有测试", "已知不成立", "无测试"];
const COLUMNS = ["编号", "断言", "预言", "测试", "状态"] as const;

export interface TestCase {
  /** Titles of the enclosing `describe` blocks, outermost first, then the case's own title. */
  chain: string[];
  /** `.skip` or `.todo` on the case or on a block around it: it never runs. */
  skipped: boolean;
  /** `.skipIf` / `.runIf` on the case or on a block around it: it runs in some runs only. */
  conditional: boolean;
}

export interface TestRef {
  file: string;
  chain: string[];
}

export interface ClaimRow {
  line: number;
  id: string;
  claim: string;
  oracle: string;
  tests: TestRef[];
  /** Code spans of the 测试 cell before the first test file: titles that belong to no file. */
  strayTitles: string[];
  status: string;
}

export interface ClaimProblem {
  line: number;
  id: string;
  reason: string;
}

const ROOTS: Record<string, "block" | "case"> = {
  describe: "block",
  suite: "block",
  xdescribe: "block",
  it: "case",
  test: "case",
  xit: "case",
  xtest: "case",
};

/**
 * What a call's callee says: `it`, `it.skip`, `describe.skipIf(c)`, `it.each(rows)` and so on,
 * as the root name and the modifiers after it. Undefined when it is no test-defining call.
 */
function callee(expr: ts.Expression): { root: string; mods: string[] } | undefined {
  const mods: string[] = [];
  let e = expr;
  for (;;) {
    if (ts.isCallExpression(e) || ts.isTaggedTemplateExpression(e)) {
      e = ts.isCallExpression(e) ? e.expression : e.tag;
    } else if (ts.isPropertyAccessExpression(e)) {
      mods.push(e.name.text);
      e = e.expression;
    } else {
      break;
    }
  }
  return ts.isIdentifier(e) && e.text in ROOTS ? { root: e.text, mods } : undefined;
}

/** A title written as a string, or as a template (substitutions kept as in the source). */
function title(node: ts.Expression | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.getText().slice(1, -1);
  return undefined;
}

/** The cases a test file defines, read from its source without running it. */
export function testCases(source: string, fileName = "x.test.ts"): TestCase[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: TestCase[] = [];
  const visit = (node: ts.Node, around: TestCase): void => {
    let inner = around;
    if (ts.isCallExpression(node)) {
      const c = callee(node.expression);
      const name = title(node.arguments[0]);
      if (c !== undefined && name !== undefined) {
        inner = {
          chain: [...around.chain, name],
          skipped:
            around.skipped ||
            c.root.startsWith("x") ||
            c.mods.includes("skip") ||
            c.mods.includes("todo"),
          conditional: around.conditional || c.mods.includes("skipIf") || c.mods.includes("runIf"),
        };
        if (ROOTS[c.root] === "case") {
          out.push(inner);
          return;
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(file, { chain: [], skipped: false, conditional: false });
  return out;
}

/** The cells of a table line, split at unescaped pipes; `\|` in a cell is a pipe. */
function cells(line: string): string[] {
  const parts = line.trim().split(/(?<!\\)\|/);
  return parts.slice(1, parts.length - 1).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** The contents of a cell's code spans, in order. */
function codeSpans(cell: string): string[] {
  return [...cell.matchAll(/(`+)(.+?)\1(?!`)/g)].map((m) => (m[2] ?? "").trim());
}

/** The rows of every table of the claims file whose header has the five columns. */
export function claimRows(text: string): ClaimRow[] {
  const rows: ClaimRow[] = [];
  type At = Record<(typeof COLUMNS)[number], number>;
  let at: At | undefined;
  splitFences(text).prose.forEach((line, i) => {
    if (!line.trim().startsWith("|")) {
      at = undefined;
      return;
    }
    const c = cells(line);
    if (at === undefined) {
      const found = Object.fromEntries(COLUMNS.map((name) => [name, c.indexOf(name)]));
      if (COLUMNS.every((name) => (found[name] ?? -1) >= 0)) at = found as At;
      return;
    }
    if (c.every((x) => /^:?-+:?$/.test(x))) return;
    const header = at;
    const cell = (name: (typeof COLUMNS)[number]) => c[header[name]] ?? "";
    const tests: TestRef[] = [];
    const strayTitles: string[] = [];
    for (const span of codeSpans(cell("测试"))) {
      const last = tests[tests.length - 1];
      if (span.endsWith(".test.ts")) tests.push({ file: span, chain: [] });
      else if (last !== undefined) last.chain.push(span);
      else strayTitles.push(span);
    }
    rows.push({
      line: i + 1,
      id: cell("编号"),
      claim: cell("断言"),
      oracle: cell("预言"),
      tests,
      strayTitles,
      status: cell("状态"),
    });
  });
  return rows;
}

const endsWith = (chain: readonly string[], tail: readonly string[]): boolean =>
  tail.length <= chain.length && tail.every((t, i) => chain[chain.length - tail.length + i] === t);

export function checkClaims(
  root: string,
  file = CLAIMS_FILE,
): { problems: ClaimProblem[]; rows: number; tests: number; conditional: number } {
  const problems: ClaimProblem[] = [];
  const rows = claimRows(readFileSync(join(root, file), "utf8"));
  const cache = new Map<string, TestCase[]>();
  const seen = new Set<string>();
  let tests = 0;
  let conditional = 0;
  if (rows.length === 0) problems.push({ line: 1, id: "", reason: "no claim rows found" });
  for (const row of rows) {
    const bad = (reason: string) => problems.push({ line: row.line, id: row.id, reason });
    if (row.id === "") bad("no id");
    else if (seen.has(row.id)) bad("the id is used by an earlier row");
    seen.add(row.id);
    if (!/\]\([^)]+\)/.test(row.claim)) bad("the claim does not link to where the spec states it");
    if (row.oracle === "") bad("no oracle");
    if (!STATUSES.includes(row.status)) {
      bad(`status "${row.status}" is not one of: ${STATUSES.join(", ")}`);
    } else if (row.tests.length === 0 && row.status !== "无测试") {
      bad(`status "${row.status}" needs a test reference; a row with no test is 无测试`);
    } else if (row.tests.length > 0 && row.status === "无测试") {
      bad("status 无测试 on a row that names a test");
    }
    for (const t of row.strayTitles) bad(`title "${t}" comes before any test file`);
    for (const ref of row.tests) {
      tests++;
      if (!existsSync(join(root, ref.file))) {
        bad(`${ref.file}: file does not exist`);
        continue;
      }
      if (ref.chain.length === 0) {
        bad(`${ref.file}: no case named; write the case's title after the file`);
        continue;
      }
      let cases = cache.get(ref.file);
      if (cases === undefined) {
        cases = testCases(readFileSync(join(root, ref.file), "utf8"), ref.file);
        cache.set(ref.file, cases);
      }
      const named = cases.filter((c) => endsWith(c.chain, ref.chain));
      const name = ref.chain.join(" › ");
      if (named.length === 0) bad(`${ref.file}: no case titled "${name}"`);
      else if (named.every((c) => c.skipped)) bad(`${ref.file}: "${name}" is skipped`);
      else if (named.some((c) => c.conditional)) conditional++;
    }
  }
  return { problems, rows: rows.length, tests, conditional };
}

if (import.meta.main) {
  const { problems, rows, tests, conditional } = checkClaims(process.cwd());
  for (const p of problems) console.error(`${CLAIMS_FILE}:${p.line}: ${p.id || "?"}: ${p.reason}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s) in the claims index.`);
    process.exit(1);
  }
  console.log(
    `Claims OK: ${rows} rows, ${tests} test references (${conditional} to cases that run only under a condition).`,
  );
}
