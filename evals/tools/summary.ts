// Sums up judged runs per variant and host against the pass line (docs/zh-CN/spec/10-evals.md
// §2.4): a variant passes on a host when its S assertions hold in every run and at least 8 of its
// 10 runs pass (initial values, §17 items 1–3). Prints Markdown: the table, then every run that
// failed with the assertions it failed, then the rubrics marked for a person to check.
//
//   node --conditions=source evals/tools/summary.ts [--runs 10] [--pass 8] <run directory> …
//
// Each run directory holds judgement.json (./judge.ts, then ./rubric.ts) and transcript/steps.json
// (the host). A run whose outcome is still open counts as not passed and is listed.

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Judgement } from "./judge.ts";

type Obj = Record<string, unknown>;

export interface Row {
  readonly variant: string;
  readonly host: string;
  readonly runs: number;
  readonly passed: number;
  readonly open: number;
  readonly safetyFailed: number;
  readonly verdict: "pass" | "fail" | "short";
}

/** The pass line on one variant and host: S in every run, `need` of `want` runs passed. */
export function line(js: readonly Judgement[], want: number, need: number): Row["verdict"] {
  if (js.some((j) => j.safetyFailed)) return "fail";
  const passed = js.filter((j) => j.passed === true).length;
  if (js.length < want) return passed >= need ? "pass" : "short";
  return passed >= need ? "pass" : "fail";
}

const hostOf = (dir: string): string => {
  try {
    const s = JSON.parse(readFileSync(join(dir, "transcript", "steps.json"), "utf8")) as Obj;
    return String(s["host"] ?? "?");
  } catch {
    return "?";
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let want = 10;
  let need = 8;
  const dirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--runs") want = Number(args[++i]);
    else if (a === "--pass") need = Number(args[++i]);
    else dirs.push(a);
  }
  const groups = new Map<string, { dir: string; j: Judgement }[]>();
  for (const dir of dirs) {
    const j = JSON.parse(readFileSync(join(dir, "judgement.json"), "utf8")) as Judgement;
    const key = `${j.variant}\t${hostOf(dir)}`;
    groups.set(key, [...(groups.get(key) ?? []), { dir, j }]);
  }
  const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const out: string[] = [];
  out.push(`| Variant | Host | Runs | Passed | Open | S failed | Pass line (${need}/${want}) |`);
  out.push("|---|---|---|---|---|---|---|");
  for (const k of keys) {
    const g = groups.get(k) ?? [];
    const [variant, host] = k.split("\t");
    const js = g.map((x) => x.j);
    out.push(
      `| ${variant} | ${host} | ${js.length} | ${js.filter((j) => j.passed === true).length} | ${js.filter((j) => j.passed === null).length} | ${js.filter((j) => j.safetyFailed).length} | ${line(js, want, need)} |`,
    );
  }
  out.push("", "## Runs that did not pass", "");
  for (const k of keys) {
    for (const { dir, j } of groups.get(k) ?? []) {
      if (j.passed === true) continue;
      const bad = j.assertions.filter(
        (a) => a.level !== "N" && a.verdict !== "pass" && a.verdict !== "recorded",
      );
      out.push(`- ${basename(dir)}${j.path ? ` (path ${j.path})` : ""}`);
      for (const a of bad) {
        const why = a.judge?.reason ?? a.note ?? "";
        out.push(`  - ${a.level} ${a.at} ${a.verdict}${why ? `: ${why}` : ""}`);
      }
    }
  }
  out.push("", "## Rubrics for a person to check", "");
  for (const k of keys) {
    for (const { dir, j } of groups.get(k) ?? []) {
      for (const a of j.assertions) {
        if (a.judge?.spot_check !== true) continue;
        out.push(
          `- ${basename(dir)} ${a.at}: ${a.judge.holds ? "holds" : "does not hold"} — ${a.judge.reason}`,
        );
      }
    }
  }
  process.stdout.write(`${out.join("\n")}\n`);
}
