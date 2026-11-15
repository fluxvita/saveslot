// Long property-test runs for the scheduled pipeline: every property test file, round after round,
// each run in a process of its own with fast-check's fresh random seed, until the time budget is
// spent. The per-property run counts stay as written (several properties stop at about 50 s by
// design), so the many samples come from many rounds and many seeds.
//
// A failing run's whole output goes to `<dir>/failure-<n>-<file>.log`; its seed, replay path and
// counterexample lines to `<dir>/failures.md`; every run to `<dir>/summary.md`. Exits 1 when any
// run failed.
//
// Usage: node scripts/soak-props.ts
//   SOAK_MINUTES     time budget (default 50)
//   SOAK_DIR         output directory (default soak)
//   SOAK_RUN_MINUTES a single run longer than this is stopped and counted as failed: stalled
//                    (default 15)

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The lines of a failed run that let it be replayed: seed and path, counterexample, the failure. */
export function replayLines(output: string): string[] {
  const keep = /\{ seed: -?\d+, path: "[^"]*"|Counterexample: |Property failed after|^\s*(FAIL|×) /;
  return output
    .split("\n")
    .filter((l) => keep.test(l))
    .map((l) => l.trimEnd())
    .filter((l, i, all) => all.indexOf(l) === i);
}

/** A file name for a path: its last parts with separators replaced. */
export function slug(path: string): string {
  return path
    .replace(/\.prop\.test\.ts$/, "")
    .split("/")
    .slice(-3)
    .join("-")
    .replace(/[^A-Za-z0-9_-]/g, "_");
}

/** The property test files tracked in the repository. */
function propFiles(): string[] {
  const r = spawnSync("git", ["ls-files", "*.prop.test.ts"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  return r.stdout.split("\n").filter((l) => l !== "");
}

interface RunRecord {
  readonly round: number;
  readonly file: string;
  readonly seconds: number;
  readonly outcome: "passed" | "failed" | "stalled";
}

function main(): number {
  const budgetMs = Number(process.env["SOAK_MINUTES"] ?? "50") * 60_000;
  const runCapMs = Number(process.env["SOAK_RUN_MINUTES"] ?? "15") * 60_000;
  const dir = process.env["SOAK_DIR"] ?? "soak";
  if (!(budgetMs > 0) || !(runCapMs > 0))
    throw new Error("SOAK_MINUTES and SOAK_RUN_MINUTES must be positive");
  mkdirSync(dir, { recursive: true });
  const files = propFiles();
  const deadline = Date.now() + budgetMs;
  const runs: RunRecord[] = [];
  const failures: string[] = [];
  let round = 0;
  outer: while (Date.now() < deadline) {
    round++;
    for (const file of files) {
      const left = deadline - Date.now();
      if (left <= 0) break outer;
      const started = Date.now();
      const r = spawnSync("pnpm", ["exec", "vitest", "run", file], {
        encoding: "utf8",
        timeout: Math.min(left, runCapMs),
        maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, CI: "true" },
      });
      const seconds = Math.round((Date.now() - started) / 1000);
      const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
      // Stopped by the budget's end: not a result.
      if (r.error !== undefined && Date.now() >= deadline) break outer;
      const outcome: RunRecord["outcome"] =
        r.error !== undefined ? "stalled" : r.status === 0 ? "passed" : "failed";
      runs.push({ round, file, seconds, outcome });
      console.log(`round ${round} ${outcome} ${seconds}s ${file}`);
      if (outcome !== "passed") {
        const name = `failure-${failures.length + 1}-${slug(file)}.log`;
        writeFileSync(join(dir, name), output);
        failures.push(
          [
            `## ${file} (round ${round}, ${outcome}, ${seconds}s)`,
            "",
            `Full output: \`${name}\``,
            "",
            "```",
            ...(outcome === "stalled"
              ? [`stopped after ${SOAK_RUN_LIMIT_TEXT(runCapMs)}`]
              : replayLines(output)),
            "```",
            "",
          ].join("\n"),
        );
      }
    }
  }
  const byFile = new Map<string, RunRecord[]>();
  for (const r of runs) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
  const summary = [
    `# Property soak`,
    "",
    `Budget ${budgetMs / 60_000} min; ${round} round(s) started; ${runs.length} run(s); ${failures.length} failed.`,
    "",
    "| file | runs | failed | slowest (s) |",
    "|---|---|---|---|",
    ...files.map((f) => {
      const rs = byFile.get(f) ?? [];
      const bad = rs.filter((r) => r.outcome !== "passed").length;
      const slowest = Math.max(0, ...rs.map((r) => r.seconds));
      return `| ${f} | ${rs.length} | ${bad} | ${slowest} |`;
    }),
    "",
  ].join("\n");
  writeFileSync(join(dir, "summary.md"), summary);
  writeFileSync(
    join(dir, "failures.md"),
    failures.length === 0 ? "No failures.\n" : failures.join("\n"),
  );
  console.log(summary);
  return failures.length === 0 ? 0 : 1;
}

const SOAK_RUN_LIMIT_TEXT = (ms: number) => `${Math.round(ms / 60_000)} min without finishing`;

if (import.meta.main) process.exitCode = main();
