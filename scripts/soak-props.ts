// Long property-test runs for the scheduled pipeline: every property test file, round after round,
// each run in a process of its own with fast-check's fresh random seed, until the time budget is
// spent. The per-property run counts stay as written (several properties stop at about 50 s by
// design), so the many samples come from many rounds and many seeds.
//
// A run ends in one of four ways, and the report keeps them apart:
// - passed: the run ended and its tests passed;
// - failed: a test failed, or the output shows a property that failed, whenever the run was
//   stopped (a failure found and being shrunk when the budget or the run's limit came is kept);
// - stalled: stopped at the run's limit, with no failure in its output;
// - stopped at the end: stopped because the budget ran out, with no failure in its output. Not a
//   result either way, and never counted as passed.
//
// A run is a process group of its own: when it is stopped, or when it ends, whatever it started
// and left running is stopped with it, and counted.
//
// A file run is not a sample. Where a property counts its samples (`Hits`, reported through
// `PROP_COVERAGE`), the report adds them up over the runs that passed; other files are said to
// count none. The report also gives each run's time outside its tests: its time less the time
// Vitest reports spent in the tests themselves. That is process start, Vitest's setup, imports,
// collection and teardown: what batching runs could at most save.
//
// A failed or stalled run's whole output goes to `<dir>/failure-<n>-<file>.log`; its seed, replay
// path and counterexample lines to `<dir>/failures.md`; every run to `<dir>/runs.jsonl` and the
// totals to `<dir>/summary.md`. Exits 1 when any run failed or stalled.
//
// What a run leaves is found with `ps`. Before the first run the soak checks that it can find a
// process group of its own; if not, it says why and exits 2, having run nothing. If `ps` fails
// later, the soak stops with the error rather than report that a run left nothing.
//
// Usage: node scripts/soak-props.ts
//   SOAK_MINUTES     time budget (default 50)
//   SOAK_DIR         output directory (default soak)
//   SOAK_RUN_MINUTES a single run longer than this is stopped: stalled, or failed if its output
//                    shows a failure (default 15)

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `output` without its colors. Vitest colors its output in CI (with CI set, as the soak runs it),
 * and a colored line does not start with what it says: `ESC[41m FAIL …`, `ESC[2m   Duration …`.
 */
export const plain = (output: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is what is removed
  output.replace(/\u001b\[[0-9;]*m/g, "");

/** The lines of a failed run that let it be replayed: seed and path, counterexample, the failure. */
export function replayLines(output: string): string[] {
  const keep = /\{ seed: -?\d+, path: "[^"]*"|Counterexample: |Property failed after|^\s*(FAIL|×) /;
  return plain(output)
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

/**
 * The time Vitest reports spent in the tests themselves, in ms: its `Duration` times the share it
 * gives the tests (`Duration 9.04s (tests 99%, import 1%)`). Undefined without such a report.
 */
export function testsMs(output: string): number | undefined {
  const m = /^\s*Duration\s+([\d.]+)(ms|s)\s+\(([^)]*)\)/m.exec(plain(output));
  const share = m ? /\btests (\d+)%/.exec(m[3] as string) : null;
  if (!m || !share) return undefined;
  return (Number(m[1]) * (m[2] === "s" ? 1000 : 1) * Number(share[1])) / 100;
}

/** The property test files tracked in the repository. */
function propFiles(): string[] {
  const r = spawnSync("git", ["ls-files", "*.prop.test.ts"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  return r.stdout.split("\n").filter((l) => l !== "");
}

/** How the processes of a process group are listed. */
export type ListGroup = (pgid: number) => number[];

/** The processes of process group `pgid`, from `ps`. Throws when `ps` cannot be run. */
export function groupPids(pgid: number): number[] {
  const r = spawnSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.error !== undefined || r.status !== 0 || typeof r.stdout !== "string") {
    const why = r.error?.message ?? `exit ${r.status}: ${String(r.stderr ?? "").trim()}`;
    throw new Error(`cannot list a process group with ps on this machine (${why})`);
  }
  return r.stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([pid, g]) => g === pgid && pid !== undefined && pid > 0)
    .map(([pid]) => pid as number);
}

/**
 * Whether `list` finds the processes of a group: a process group is started and must be found,
 * then stopped and must be gone. Undefined when it works; otherwise why not. Without it, "no
 * process left" would be the answer of a check that looked at nothing.
 */
export async function cannotListGroups(list: ListGroup = groupPids): Promise<string | undefined> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const pgid = child.pid as number;
  const gone = new Promise((r) => child.on("exit", r));
  try {
    const found = list(pgid);
    if (!found.includes(pgid)) {
      return `cannot list a process group with ps on this machine: a process started for the purpose (${pgid}) was not found in its group`;
    }
    return undefined;
  } catch (e) {
    return (e as Error).message;
  } finally {
    signalGroup(pgid, "SIGKILL");
    await gone;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // None left.
  }
}

export interface Ran {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
  readonly ms: number;
  /** Why it was stopped, if it was: the run's limit, or the budget's end. */
  readonly stopped: "limit" | "budget" | undefined;
  /** Processes of the run still there when it ended (or was stopped), then stopped. */
  readonly left: number;
}

/**
 * Runs `argv` as a process group of its own. At `limitMs` (the run's limit) or `budgetMs` (what is
 * left of the budget), whichever comes first, the group is asked to end, then killed `graceMs`
 * later. When the first process ends, whatever of the group is left is killed and counted.
 */
export function runGroup(
  argv: readonly string[],
  o: {
    env: NodeJS.ProcessEnv;
    limitMs: number;
    budgetMs: number;
    graceMs: number;
    list?: ListGroup;
  },
): Promise<Ran> {
  const list = o.list ?? groupPids;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(argv[0] as string, argv.slice(1), {
      env: o.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pgid = child.pid as number;
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => chunks.push(c));
    let stopped: Ran["stopped"];
    let kill: NodeJS.Timeout | undefined;
    const stop = setTimeout(
      () => {
        stopped = o.limitMs <= o.budgetMs ? "limit" : "budget";
        signalGroup(pgid, "SIGTERM");
        kill = setTimeout(() => signalGroup(pgid, "SIGKILL"), o.graceMs);
      },
      Math.max(0, Math.min(o.limitMs, o.budgetMs)),
    );
    child.on("exit", async (status, signal) => {
      clearTimeout(stop);
      if (kill !== undefined) clearTimeout(kill);
      let left: number;
      try {
        left = list(pgid).length;
        // Killed, then waited for until gone: a run does not overlap the next one.
        for (let k = 0; k < 100 && list(pgid).length > 0; k++) {
          signalGroup(pgid, "SIGKILL");
          await new Promise((r) => setTimeout(r, 50));
        }
      } catch (e) {
        // What is left cannot be known: not a 0. The soak stops on it.
        signalGroup(pgid, "SIGKILL");
        reject(e);
        return;
      }
      // What is left may hold the pipes open: wait for them a little, not for ever.
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve({
          status,
          signal,
          output: Buffer.concat(chunks).toString("utf8"),
          ms: Date.now() - started,
          stopped,
          left,
        });
      };
      child.on("close", finish);
      setTimeout(finish, 2_000).unref();
    });
  });
}

export type Outcome = "passed" | "failed" | "stalled" | "stopped at the end";

/** How a run ended (see the top of this file). */
export function outcomeOf(r: Pick<Ran, "status" | "signal" | "output" | "stopped">): Outcome {
  const failure = replayLines(r.output).length > 0;
  if (r.stopped === "budget") return failure ? "failed" : "stopped at the end";
  if (r.stopped === "limit") return failure ? "failed" : "stalled";
  return r.status === 0 && r.signal === null ? "passed" : "failed";
}

/** A property's counts, as `Hits.check` writes them to `PROP_COVERAGE`. */
interface Counted {
  readonly name: string;
  readonly skipped: number;
  readonly samples: number;
  readonly hits: number;
}

function counted(path: string): Counted[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Counted);
}

export interface RunRecord {
  readonly round: number;
  readonly file: string;
  readonly ms: number;
  readonly outcome: Outcome;
  /** The run's time less the time Vitest reports spent in its tests; undefined without a report. */
  readonly outsideMs: number | undefined;
  readonly left: number;
  /** The properties' counts in this run (none for a file that does not count them). */
  readonly properties: readonly Counted[];
}

export interface SoakOptions {
  readonly files: readonly string[];
  /** The command that runs one file. */
  readonly argvOf: (file: string) => readonly string[];
  readonly budgetMs: number;
  readonly runLimitMs: number;
  readonly dir: string;
  readonly env: NodeJS.ProcessEnv;
  /** Between the request to end and the kill. */
  readonly graceMs?: number;
  /** At most this many rounds (no limit by default). */
  readonly maxRounds?: number;
  /** How a run's processes are listed (`ps`, by default). */
  readonly listGroup?: ListGroup;
  readonly log?: (line: string) => void;
}

const median = (xs: readonly number[]): number | undefined => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const sec = (ms: number | undefined) => (ms === undefined ? "–" : (ms / 1000).toFixed(1));

/** The soak: rounds of every file until the budget is spent. Returns the exit code. */
export async function soak(o: SoakOptions): Promise<number> {
  const log = o.log ?? ((l: string) => console.log(l));
  // Checked first: a soak that cannot see what a run leaves would report it left nothing.
  const cannot = await cannotListGroups(o.listGroup);
  if (cannot !== undefined) {
    log(`${cannot}. Nothing was run.`);
    return 2;
  }
  mkdirSync(join(o.dir, "coverage"), { recursive: true });
  writeFileSync(join(o.dir, "runs.jsonl"), "");
  const deadline = Date.now() + o.budgetMs;
  const runs: RunRecord[] = [];
  const failures: string[] = [];
  let round = 0;
  outer: while (Date.now() < deadline && (o.maxRounds === undefined || round < o.maxRounds)) {
    round++;
    for (const file of o.files) {
      const left = deadline - Date.now();
      if (left <= 0) break outer;
      const coverage = join(o.dir, "coverage", `${runs.length + 1}.jsonl`);
      const r = await runGroup(o.argvOf(file), {
        env: { ...o.env, CI: "true", PROP_COVERAGE: coverage },
        limitMs: o.runLimitMs,
        budgetMs: left,
        graceMs: o.graceMs ?? 5_000,
        ...(o.listGroup !== undefined ? { list: o.listGroup } : {}),
      });
      const outcome = outcomeOf(r);
      const inTests = testsMs(r.output);
      const record: RunRecord = {
        round,
        file,
        ms: r.ms,
        outcome,
        outsideMs: inTests === undefined ? undefined : Math.max(0, Math.round(r.ms - inTests)),
        left: r.left,
        properties: counted(coverage),
      };
      runs.push(record);
      writeFileSync(join(o.dir, "runs.jsonl"), `${JSON.stringify(record)}\n`, { flag: "a" });
      log(
        `round ${round} ${outcome} ${sec(r.ms)}s ${file}${r.left > 0 ? ` (${r.left} process(es) left, stopped)` : ""}`,
      );
      if (outcome === "failed" || outcome === "stalled") {
        const name = `failure-${failures.length + 1}-${slug(file)}.log`;
        writeFileSync(join(o.dir, name), r.output);
        const why =
          r.stopped === "limit"
            ? `stopped after ${Math.round(o.runLimitMs / 60_000)} min without finishing`
            : r.stopped === "budget"
              ? "stopped at the budget's end"
              : undefined;
        failures.push(
          [
            `## ${file} (round ${round}, ${outcome}, ${sec(r.ms)}s)`,
            "",
            `Full output: \`${name}\``,
            "",
            "```",
            ...(why !== undefined ? [why] : []),
            ...replayLines(r.output),
            "```",
            "",
          ].join("\n"),
        );
      }
    }
  }

  const count = (rs: readonly RunRecord[], x: Outcome) => rs.filter((r) => r.outcome === x).length;
  const passed = runs.filter((r) => r.outcome === "passed");
  const samplesOf = (rs: readonly RunRecord[]) =>
    rs.reduce((n, r) => n + r.properties.reduce((m, p) => m + p.samples, 0), 0);
  const countingFiles = new Set(runs.filter((r) => r.properties.length > 0).map((r) => r.file));
  const outside = runs.flatMap((r) => (r.outsideMs === undefined ? [] : [r.outsideMs]));
  const totalMs = runs.reduce((n, r) => n + r.ms, 0);
  const outsideTotal = outside.reduce((n, x) => n + x, 0);
  const leftTotal = runs.reduce((n, r) => n + r.left, 0);
  const completed = runs.length - count(runs, "stopped at the end");
  const summary = [
    "# Property soak",
    "",
    `Budget ${o.budgetMs / 60_000} min; ${round} round(s) started; ${completed} file run(s) ended: ${count(runs, "passed")} passed, ${count(runs, "failed")} failed, ${count(runs, "stalled")} stalled. ${count(runs, "stopped at the end")} stopped at the budget's end with no failure seen (not counted as passed).`,
    "",
    `A file run is not a sample. Samples are counted where a property counts them (${countingFiles.size} of ${o.files.length} files): ${samplesOf(passed)} in the runs that passed.`,
    "",
    `Time outside the tests (a run's time less the time Vitest reports in its tests: process start, setup, imports, collection, teardown): median ${sec(median(outside))} s a run, ${sec(outsideTotal)} s of ${sec(totalMs)} s spent in runs.`,
    "",
    `Processes a run left and that were stopped with it: ${leftTotal}.`,
    "",
    "| file | passed | failed | stalled | stopped at the end | samples (runs that passed) | slowest (s) | outside the tests, median (s) |",
    "|---|---|---|---|---|---|---|---|",
    ...o.files.map((f) => {
      const rs = runs.filter((r) => r.file === f);
      const samples = countingFiles.has(f)
        ? String(samplesOf(rs.filter((r) => r.outcome === "passed")))
        : "not counted";
      const slowest = rs.length === 0 ? undefined : Math.max(...rs.map((r) => r.ms));
      const out = median(rs.flatMap((r) => (r.outsideMs === undefined ? [] : [r.outsideMs])));
      return `| ${f} | ${count(rs, "passed")} | ${count(rs, "failed")} | ${count(rs, "stalled")} | ${count(rs, "stopped at the end")} | ${samples} | ${sec(slowest)} | ${sec(out)} |`;
    }),
    "",
  ].join("\n");
  writeFileSync(join(o.dir, "summary.md"), summary);
  writeFileSync(
    join(o.dir, "failures.md"),
    failures.length === 0 ? "No failures.\n" : failures.join("\n"),
  );
  log(summary);
  return failures.length === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const budgetMs = Number(process.env["SOAK_MINUTES"] ?? "50") * 60_000;
  const runLimitMs = Number(process.env["SOAK_RUN_MINUTES"] ?? "15") * 60_000;
  if (!(budgetMs > 0) || !(runLimitMs > 0))
    throw new Error("SOAK_MINUTES and SOAK_RUN_MINUTES must be positive");
  return soak({
    files: propFiles(),
    argvOf: (file) => ["pnpm", "exec", "vitest", "run", file],
    budgetMs,
    runLimitMs,
    dir: process.env["SOAK_DIR"] ?? "soak",
    env: process.env,
  });
}

if (import.meta.main) process.exitCode = await main();
