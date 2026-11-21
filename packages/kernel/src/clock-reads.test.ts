// K7 (02-architecture §3): the kernel does not read the clock. "Now" comes in with the call and is
// recorded in the event; replay uses only the times the events hold. This scans the kernel's
// non-test source for a read of the clock. The two timing calls of the restricted SQL read
// (`performance.now()` in read/sql.ts, a statement's run time against its limit, never recorded
// and never in a result) are the allow-list; a new entry needs a reason in this file.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = import.meta.dirname;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    // Test code and test fixtures are not kernel code.
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".fixture.ts")
      ? [p]
      : [];
  });
}

/** The text without comments (string contents stay: a clock read is never in a string). */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

/** What reads the clock. `new Date(x)` with an argument and `Date.UTC`, `Date.parse` do not. */
const CLOCK_READS: readonly [string, RegExp][] = [
  ["Date.now", /\bDate\s*\.\s*now\b/g],
  ["new Date()", /\bnew\s+Date\s*\(\s*(?:undefined\s*)?\)/g],
  ["Date()", /(?<!new\s)(?<![.\w])Date\s*\(\s*\)/g],
  ["performance.now", /\bperformance\s*\.\s*(?:now|timeOrigin|mark|measure)\b/g],
  ["process.uptime", /\bprocess\s*\.\s*(?:uptime|cpuUsage)\b/g],
  ["hrtime", /\bhrtime\b/g],
  ["Temporal.Now", /\bTemporal\s*\.\s*Now\b/g],
  ["Intl format without a date", /\.format\s*\(\s*\)/g],
  ["event timeStamp", /\btimeStamp\b/g],
  ["monotonic clock module", /from\s+["'](?:node:)?perf_hooks["']/g],
];

/** The reads each file may have, by label: counted, so a third one is not let in with them. */
const ALLOWED: Record<string, Record<string, number>> = {
  "read/sql.ts": { "performance.now": 2 },
};

describe("K7: the kernel's non-test source does not read the clock", () => {
  const files = sources(SRC);

  it("scans the kernel's source (a guard against scanning nothing)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => relative(SRC, f) === "read/sql.ts")).toBe(true);
  });

  it("reads the clock only where the allow-list says, as many times as it says", () => {
    const found: Record<string, Record<string, number>> = {};
    for (const f of files) {
      const text = code(readFileSync(f, "utf8"));
      for (const [label, re] of CLOCK_READS) {
        const n = [...text.matchAll(re)].length;
        if (n === 0) continue;
        const file = relative(SRC, f);
        found[file] = { ...found[file], [label]: n };
      }
    }
    expect(found).toEqual(ALLOWED);
  });

  it("the patterns see what they are for", () => {
    const hits = (text: string) =>
      CLOCK_READS.filter(([, re]) => [...code(text).matchAll(re)].length > 0).map(([l]) => l);
    expect(hits("const t = Date.now();")).toEqual(["Date.now"]);
    expect(hits("const t = new Date();")).toEqual(["new Date()"]);
    expect(hits("const t = new Date(\n);")).toEqual(["new Date()"]);
    expect(hits("const t = Date();")).toEqual(["Date()"]);
    expect(hits("const t = performance.now();")).toEqual(["performance.now"]);
    expect(hits("const t = process.hrtime.bigint();")).toEqual(["hrtime"]);
    expect(hits("const s = new Intl.DateTimeFormat('en').format();")).toEqual([
      "Intl format without a date",
    ]);
    // Not reads: a date given, a comment, a parse.
    expect(hits("const t = new Date(ms); const u = Date.parse(s);")).toEqual([]);
    expect(hits("// Date.now() is not used\n/* new Date() */ const x = 1;")).toEqual([]);
  });
});
