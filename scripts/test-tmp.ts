// Vitest global setup: one run of the tests gets a temporary directory of its own, and nothing of
// it is left when the run ends.
//
// The tests make their homes and stores under `os.tmpdir()` and remove them in their own hooks,
// inside the worker. A hook that times out, a worker that dies and a run that is interrupted skip
// those hooks; a service a test started detached (`saveslot start`) then keeps running, and its
// home stays. So, before the workers start, TMPDIR is pointed at a directory made for this run;
// after the run, in this process: every process still started from under that directory is
// stopped and said, what the tests left in it is said, and the directory is removed. A run that was
// killed outright is cleared by the next run's setup.
//
// A run that ends normally and had to stop a process fails, whatever its tests said: the test that
// started the process is to stop it. What is merely left in the directory is said, not failed on.
//
// The directory is under /tmp, not the system's own temporary directory: a home's socket is a
// file under it, and a socket's path has a limit of about 100 bytes, which macOS's per-user
// temporary directory (some 50 bytes by itself) leaves little of.
//
// SAVESLOT_TEST_KEEP_TMP=1 keeps the directory (and says where it is), to look at what a failed
// test left; the processes are stopped all the same.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A run's directory is `<base>/<RUN_PREFIX>XXXXXX`: `owner` (the run's pid), `t/` (its TMPDIR) and
 * `templates/` (the test backend's store templates, SAVESLOT_TEST_TEMPLATES: the run's, not a
 * test's leftovers, and so not said at the end).
 */
export const RUN_PREFIX = "sst-";
const OWNER = "owner";
const TMP = "t";
const TEMPLATES = "templates";
const TEMPLATES_ENV = "SAVESLOT_TEST_TEMPLATES";

export interface Proc {
  readonly pid: number;
  readonly command: string;
}

/** The processes of `ps -axo pid=,command=` whose command line names a path under `dir`. */
export function processesUnder(ps: string, dir: string, self: number): Proc[] {
  const out: Proc[] = [];
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const command = m[2] as string;
    if (pid !== self && command.includes(`${dir}/`)) out.push({ pid, command });
  }
  return out;
}

/** The runs' directories under `base` whose owner is no longer running. One without an owner file is not touched. */
export function staleRuns(base: string, alive: (pid: number) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(base).sort()) {
    if (!name.startsWith(RUN_PREFIX)) continue;
    const dir = join(base, name);
    let pid: number;
    try {
      pid = Number(readFileSync(join(dir, OWNER), "utf8").trim());
    } catch {
      continue;
    }
    if (Number.isInteger(pid) && pid > 0 && !alive(pid)) out.push(dir);
  }
  return out;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // No permission to signal it: it exists.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const listed = (dir: string): Proc[] =>
  processesUnder(
    execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 1 << 26 }),
    dir,
    process.pid,
  );

const signal = (procs: readonly Proc[], sig: NodeJS.Signals): void => {
  for (const p of procs) {
    try {
      process.kill(p.pid, sig);
    } catch {
      // Gone already.
    }
  }
};

/** Waits in place: the clearing also runs as the process exits, where nothing asynchronous does. */
const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Stops the processes started from under `dir`: asked to end, then killed. Returns those it found. */
export function stopProcessesUnder(dir: string, graceMs = 5_000): Proc[] {
  const found = listed(dir);
  if (found.length === 0) return found;
  signal(found, "SIGTERM");
  const until = Date.now() + graceMs;
  while (Date.now() < until && listed(dir).length > 0) pause(100);
  signal(listed(dir), "SIGKILL");
  return found;
}

let run: string | undefined;
let before: string | undefined;

/**
 * Ends the run's directory: its processes stopped and said, what is left in it said, then removed.
 * Returns the processes it had to stop.
 */
function clear(): Proc[] {
  if (run === undefined) return [];
  const dir = run;
  run = undefined;
  if (before === undefined) delete process.env["TMPDIR"];
  else process.env["TMPDIR"] = before;
  delete process.env[TEMPLATES_ENV];

  const procs = stopProcessesUnder(dir);
  for (const p of procs) {
    console.error(`test-tmp: stopped a process a test left running: ${p.pid} ${p.command}`);
  }
  const left = readdirSync(join(dir, TMP)).sort();
  if (left.length > 0) {
    console.error(`test-tmp: ${left.length} entries the tests did not remove: ${left.join(" ")}`);
  }
  if (process.env["SAVESLOT_TEST_KEEP_TMP"] === "1") {
    console.error(`test-tmp: kept ${dir} (SAVESLOT_TEST_KEEP_TMP=1)`);
    return procs;
  }
  rmSync(dir, { recursive: true, force: true });
  return procs;
}

export function setup(): void {
  const base = realpathSync(existsSync("/tmp") ? "/tmp" : tmpdir());
  for (const dir of staleRuns(base, alive)) {
    const procs = stopProcessesUnder(dir);
    rmSync(dir, { recursive: true, force: true });
    console.error(
      `test-tmp: cleared ${dir}, left by a run that was killed (${procs.length} process(es) stopped)`,
    );
  }
  run = mkdtempSync(join(base, RUN_PREFIX));
  writeFileSync(join(run, OWNER), `${process.pid}\n`);
  mkdirSync(join(run, TMP));
  before = process.env["TMPDIR"];
  process.env["TMPDIR"] = join(run, TMP);
  process.env[TEMPLATES_ENV] = join(run, TEMPLATES);
  // An interrupted run ends by the process exiting, without the teardown. Vitest exits on SIGINT
  // and SIGTERM; a hangup (the terminal closed) has no handler and would end the process at once.
  process.once("exit", clear);
  if (process.listenerCount("SIGHUP") === 0) process.once("SIGHUP", () => process.exit(129));
}

/**
 * The run's normal end. A process still running then was left by a test that should have stopped
 * it: the run fails, having stopped it. (An interrupted run leaves its processes by being
 * interrupted; those are stopped at the exit, and nothing is made of it.)
 */
export function teardown(): void {
  const left = clear();
  if (left.length > 0) {
    throw new Error(
      `${left.length} process(es) a test left running had to be stopped at the end of the run: ${left
        .map((p) => p.pid)
        .join(", ")}. The test that started each must stop it.`,
    );
  }
}
