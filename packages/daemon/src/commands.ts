// The service commands `init`, `start`, `stop`, `status`, `config` and `service` (docs/zh-CN/spec/06-cli.md §3 «分步做»
// and its steps 2–3, §4.1, §6.2). They manage the local service process; none is a contract
// operation. The entry package dispatches to `serviceCommand`.
//
// - `init [--data-dir <dir>] [--rotate-session]`: the only command that opens the storage itself, under the home's
//   lock; refused (exit 5, nothing changed) on a home initialized already or while the service
//   runs.
// - `start [--foreground]`: in the background, a detached process of this package's entry, its
//   log appended to `run/saveslot.log` (0600); waits for `GET /health` to say ready. A service
//   running already: same version, nothing to do; another version, exit 1 (it is not restarted:
//   a host may be connected). Failing to start: the process is stopped, exit 7.
//   config.toml is read and checked first (./config.ts): refused, exit 5 and no process spawned.
// - `stop`: signals only a process it has verified. `/health` answering: SIGTERM to the pid of the
//   pid file only when `/health` names that same pid, then waits for that process to exit; another
//   pid: no signal, exit 7. `/health` not answering: the home's lock not held means nothing runs (a
//   pid file left is removed, exit 0); held (starting, or stuck): no signal, exit 7.
// - `status`: what `/health` says, the paths, and the number of pending items (`pending`, as the
//   user session).
// - `config get [<key>]`: each key's value in effect and its source (default or config.toml);
//   a key no part of this version uses is listed as such.
// - `config set <key> <value>`: the two keys this version uses (./config.ts `setConfig`); another
//   known key is refused as not supported (exit 2), and so is a value not of the key's type and
//   limits. A file that is refused already is not written over (exit 5). Says when the value takes
//   effect: the flush interval when the service next starts, the MCP bridge's start at its next run.
// - `service install` / `uninstall`: starting the service at login (./autostart.ts); `install`
//   needs an initialized home (exit 5), as `start` does.
// - `doctor`: each check passed, failed or a reminder (./doctor.ts); 9 when one failed.
//
// The lock is probed only when `/health` does not answer, and once after the stopped process has
// exited: a probe takes the lock for a moment, and a service starting in that moment (one an MCP
// bridge starts, 06-cli §3 step 3) fails with `store_locked`. What is left of that window: a
// service starting just when `stop` or `status` finds no answer on the socket, or just after the
// process `stop` waited for has exited. Such a start fails and is not retried.
//
// `start` itself probes the lock once, after the process it spawned has exited without `/health`
// answering: held, another process is starting (a second start, or a bridge, at the same moment),
// and that one is waited for; the probe fails at once then, and takes nothing from it.

import { spawn } from "node:child_process";
import { closeSync, fchmodSync, openSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { HealthBody } from "@fluxvita/saveslot-server";
import {
  AlreadyInitialized,
  ControlFileError,
  initLocalHome,
  LocalTenantError,
  readTenantDirectory,
  rotateSession,
  ServiceRunning,
} from "@fluxvita/saveslot-service";
import { osFileLock, PgliteStoreError } from "@fluxvita/saveslot-store-pglite";
import { installAutostart, type System, stableNode, uninstallAutostart } from "./autostart.ts";
import {
  type Config,
  ConfigInvalid,
  type ConfigKey,
  KEYS,
  readConfig,
  setConfig,
  setValue,
} from "./config.ts";
import { type DoctorOptions, doctor } from "./doctor.ts";
import { initBackend } from "./init-backend.ts";
import { health } from "./local-request.ts";
import { daemonVersion, main } from "./main.ts";
import { runBridge } from "./mcp-bridge.ts";
import { CLOCK_BEHIND_MS, clockBehind, looksSynced, withSession } from "./probes.ts";
import {
  evalClockStart,
  lastFailureFile,
  lockDir,
  pidFile,
  runDir,
  socketFile,
} from "./service.ts";
import { homeProblem } from "./setup-support.ts";
import { TEXTS } from "./texts.ts";

export { CLOCK_BEHIND_MS, clockBehind, looksSynced };

export interface CommandIO {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** The service's log in the background (06-cli §3 «分步做»). */
export const logFile = (home: string): string => join(runDir(home), "saveslot.log");

/** How long `start` waits for ready and `stop` for the process to go, in milliseconds. */
const WAIT_MS = 60_000;
const POLL_MS = 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How long `start` waits for a service it saw fail to exit, after asking it to stop. */
const FAILED_EXIT_WAIT_MS = 10_000;

/**
 * Whether the home's lock is held by a process; takes and releases it when it is free, so it is
 * asked only when `/health` does not answer (see the head of this file).
 */
async function lockHeld(home: string): Promise<boolean> {
  try {
    const l = await osFileLock.acquire(lockDir(home));
    await l.release();
    return false;
  } catch (e) {
    if (e instanceof PgliteStoreError && e.code === "store_locked") return true;
    // No run/ directory: nothing ever ran here.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

async function readPid(home: string): Promise<number | undefined> {
  try {
    const t = (await readFile(pidFile(home), "utf8")).trim();
    return /^[1-9][0-9]{0,9}$/.test(t) ? Number(t) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether process `pid` still exists (signal 0; EPERM: it exists, as another user's). */
function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The path of this package's process entry, as a source or built file. */
function binPath(): string {
  const self = fileURLToPath(import.meta.url);
  return fileURLToPath(new URL(`./bin${extname(self)}`, import.meta.url));
}

/**
 * `init`. `dataDir`, when given, is absolute and normalized already (the command line resolves it
 * against the current directory).
 */
export async function init(
  home: string,
  o: { readonly rotate: boolean; readonly dataDir?: string },
  io: CommandIO,
): Promise<number> {
  const rotate = o.rotate;
  if (!rotate) {
    // The home as it is, before anything is made in it: what is wrong, and how to put it right.
    const problem = await homeProblem(home);
    if (problem !== undefined) {
      io.err(problem);
      return 1;
    }
  }
  try {
    if (rotate) {
      await rotateSession(home, osFileLock);
      io.out(TEXTS.rotated);
      return 0;
    }
    const r = await initLocalHome({
      home,
      ...(o.dataDir !== undefined ? { dataDir: o.dataDir } : {}),
      backend: initBackend(),
      lock: osFileLock,
      now: new Date().toISOString(),
    });
    io.out(TEXTS.initDone(home));
    if (looksSynced(r.dataDir)) io.err(TEXTS.syncedFolder(r.dataDir));
    return 0;
  } catch (e) {
    if (e instanceof AlreadyInitialized) {
      io.err(TEXTS.alreadyInitialized(home));
      return 5;
    }
    if (e instanceof ServiceRunning) {
      io.err(TEXTS.serviceRunningForInit);
      return 5;
    }
    if (rotate && (e as NodeJS.ErrnoException).code === "ENOENT") {
      io.err(TEXTS.notInitialized(home));
      return 5;
    }
    // A home it cannot make or use as it is: the path and why, and how to put it right; 1.
    if (e instanceof ControlFileError) {
      io.err(TEXTS.initMode(e.path, e.message.replace(`${e.path} `, "")));
      return 1;
    }
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") {
      io.err(TEXTS.initInTheWay((e as NodeJS.ErrnoException).path ?? home, code));
      return 1;
    }
    throw e;
  }
}

/** Waits until `/health` says ready or failed, the process has exited, or the time is up. */
async function waitReady(
  socket: string,
  exited: () => boolean,
  stop?: AbortSignal,
): Promise<HealthBody | "exited" | "timeout" | "stopped"> {
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    // Asked to stop (a signal to `setup`): no longer waited for; the process is left to start.
    if (stop?.aborted === true) return "stopped";
    const h = await health(socket, 2000);
    if (h !== undefined && (h.state === "ready" || h.state === "failed")) return h;
    if (h === undefined && exited()) return "exited";
    await sleep(POLL_MS);
  }
  return "timeout";
}

/**
 * `start`. What it cannot do for the file system's sake (a home that is a file, a directory that
 * cannot be read, `run/` that is a file) is a failure to start, exit 7, said by a code without a
 * path; it does not throw.
 */
export async function start(
  home: string,
  io: CommandIO,
  o: {
    /** Aborted: no longer waited for (the caller is stopping); 1. */
    readonly stop?: AbortSignal;
    /** Called when this call started the service (not one that was running already). */
    readonly onStarted?: () => void;
    /** `--eval-clock`: the test clock's starting moment, passed on to the service (evaluations). */
    readonly evalClock?: string;
  } = {},
): Promise<number> {
  try {
    return await startService(home, io, o);
  } catch (e) {
    io.err(TEXTS.startHomeUnusable(failureCode(e)));
    return 7;
  }
}

/** A stable code for what went wrong: a home's, a file system's, or `internal`; never a path. */
function failureCode(e: unknown): string {
  if (e instanceof LocalTenantError) return e.code;
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^E[A-Z]+$/.test(code) ? code.toLowerCase() : "internal";
}

/** The environment the service is spawned with: this one without `SAVESLOT_TOKEN`. */
function serviceEnv(): NodeJS.ProcessEnv {
  const { SAVESLOT_TOKEN: _, ...env } = process.env;
  return env;
}

async function startService(
  home: string,
  io: CommandIO,
  o: {
    readonly stop?: AbortSignal;
    readonly onStarted?: () => void;
    readonly evalClock?: string;
  },
): Promise<number> {
  try {
    await readTenantDirectory(home);
  } catch (e) {
    if (e instanceof LocalTenantError && e.code === "not_initialized") {
      io.err(TEXTS.notInitialized(home));
      return 5;
    }
    throw e;
  }
  const socket = socketFile(home);
  const mine = daemonVersion();
  const running = await health(socket);
  if (running !== undefined && running.state !== "failed") {
    const h = running.state === "ready" ? running : await waitReady(socket, () => false, o.stop);
    if (h === "stopped") return 1;
    if (typeof h === "object" && h.state === "ready") {
      if (h.version !== mine) {
        io.err(TEXTS.versionMismatch(h.version, mine));
        return 1;
      }
      io.out(TEXTS.alreadyRunning(h.pid));
      return 0;
    }
    if (h === "timeout") {
      // Still starting (it may be recovering): left alone; a second process would only fail.
      io.err(TEXTS.startTimedOut(running.pid));
      return 7;
    }
  }

  // Refused here, before a process is spawned: the reason goes to the user, not to the log.
  if ((await checkedConfig(home, io)) === undefined) return 5;

  await mkdir(runDir(home), { recursive: true, mode: 0o700 });
  const log = openSync(logFile(home), "a", 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    fchmodSync(log, 0o600);
    const bin = binPath();
    // Run from the sources (development, tests): the workspace packages by their source entries.
    const conditions = bin.endsWith(".ts") ? ["--conditions=source"] : [];
    // A bridge runs with a connection's token; the service takes no token and keeps none.
    const evalClock = o.evalClock !== undefined ? ["--eval-clock", o.evalClock] : [];
    // The service writes its own lines to the log and rotates it (./log-file.ts); the descriptor
    // given as stdout and stderr keeps what Node itself writes on a crash.
    const args = [...conditions, bin, "--home", home, "--log", logFile(home), ...evalClock];
    child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", log, log],
      env: serviceEnv(),
    });
  } finally {
    closeSync(log);
  }
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  child.unref();

  let h = await waitReady(socket, () => exited, o.stop);
  let other: number | undefined;
  if (h === "exited" && (await lockHeld(home))) {
    // Ours lost the home's lock to a process starting meanwhile (another start, a bridge): that
    // one is not listening yet; it is waited for as ours would have been.
    other = await readPid(home);
    h = await waitReady(socket, () => false, o.stop);
  }
  if (h === "stopped") return 1;
  if (typeof h === "object" && h.state === "ready") {
    // Another start may have won the home's lock: then it is that process that answers.
    if (h.version !== mine) {
      io.err(TEXTS.versionMismatch(h.version, mine));
      return 1;
    }
    if (h.pid === child.pid) o.onStarted?.();
    io.out(h.pid === child.pid ? TEXTS.started(h.pid, socket) : TEXTS.alreadyRunning(h.pid));
    return 0;
  }
  if (typeof h === "object") {
    // Failed: the process holds the lock while it lives; stopped, and waited for (a bounded
    // while), so that what comes next (`status`, another start) finds the home free.
    if (h.pid === child.pid && !exited) {
      const gone = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill("SIGTERM");
      await Promise.race([gone, sleep(FAILED_EXIT_WAIT_MS)]);
    }
    io.err(
      h.reason === "format_too_old"
        ? TEXTS.startFormatTooOld
        : h.reason === "format_too_new"
          ? TEXTS.startFormatTooNew
          : TEXTS.startFailed(h.reason ?? "failed"),
    );
    // A store of another format is refused until something is done about it (06-cli §6.2: 5);
    // any other failure of a started service may pass on a retry (7).
    return h.reason === "format_too_old" || h.reason === "format_too_new" ? 5 : 7;
  }
  if (h === "timeout") {
    // Not killed: it may be recovering (02-architecture §8), which takes as long as it takes.
    io.err(TEXTS.startTimedOut(other ?? (child.pid as number)));
    return 7;
  }
  io.err(TEXTS.startFailed("exited"));
  return 7;
}

export async function stop(home: string, io: CommandIO): Promise<number> {
  const h = await health(socketFile(home));
  if (h === undefined) {
    if (!(await lockHeld(home))) {
      await rm(pidFile(home), { force: true });
      io.out(TEXTS.notRunning);
      return 0;
    }
    io.err(TEXTS.stopUnverified);
    return 7;
  }
  const pid = await readPid(home);
  if (pid === undefined || h.pid !== pid) {
    io.err(TEXTS.stopPidMismatch);
    return 7;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
  // Waits for that process to exit, without touching the lock meanwhile.
  const until = Date.now() + WAIT_MS;
  while (exists(pid)) {
    if (Date.now() >= until) {
      io.err(TEXTS.stopTimedOut(pid));
      return 7;
    }
    await sleep(POLL_MS);
  }
  io.out(TEXTS.stopped(pid));
  // Its lock went with it; held now, it is another service's, started meanwhile.
  if (await lockHeld(home)) io.err(TEXTS.startedAgain);
  else io.err(TEXTS.stopHint);
  return 0;
}

/** The number of open pending items, as the user session sees them; undefined when not to be had. */
/**
 * A request with the home's user session, its answer as JSON; undefined when there is no session
 * to read, the service does not answer, or the answer is no 200 of JSON. Never throws.
 */
async function pendingCount(home: string): Promise<number | undefined> {
  const v = await withSession(home, "/v1/pending?limit=1");
  const total =
    typeof v === "object" && v !== null ? (v as Record<string, unknown>)["total"] : undefined;
  return typeof total === "number" ? total : undefined;
}

/** The recorded time of the log's newest event (`log.end`); undefined when not to be had. */
async function logEndAt(home: string): Promise<string | undefined> {
  const v = await withSession(home, "/v1/log/end");
  const at =
    typeof v === "object" && v !== null ? (v as Record<string, unknown>)["recorded_at"] : undefined;
  return typeof at === "string" ? at : undefined;
}

/** The last start's failure as kept under run/, when it is of its form; undefined otherwise. */
async function lastFailure(home: string): Promise<{ reason: string; at: string } | undefined> {
  try {
    const v = JSON.parse(await readFile(lastFailureFile(home), "utf8")) as Record<string, unknown>;
    const { reason, at } = v;
    if (typeof reason !== "string" || !/^[a-z0-9_]{1,64}$/.test(reason)) return undefined;
    if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return undefined;
    return { reason, at: new Date(Date.parse(at)).toISOString() };
  } catch {
    return undefined;
  }
}

export async function status(
  home: string,
  io: CommandIO,
  o: { readonly now?: () => number } = {},
): Promise<number> {
  const socket = socketFile(home);
  const h = await health(socket);
  if (h === undefined) {
    if (await lockHeld(home)) {
      io.out(TEXTS.statusNotAnswering);
      return 7;
    }
    io.out(TEXTS.statusNotRunning);
    // Why the last start failed, when it did (02-architecture §8): a code and a time, as kept.
    const last = await lastFailure(home);
    if (last !== undefined) io.out(TEXTS.statusLastFailure(last.reason, last.at));
    return 7;
  }
  const pending = h.state === "ready" ? await pendingCount(home) : undefined;
  // The data directory the home records (the one the service opened); unknown when unreadable.
  const data = await readTenantDirectory(home).then(
    (d) => d.dataDir,
    () => undefined,
  );
  // The clock behind the log's end by more than 5 minutes (02-architecture §8): said, not refused.
  // The end comes with the user session (`log.end`), not from /health; none to be had, no line.
  const logEnd = h.state === "ready" ? await logEndAt(home) : undefined;
  // Under the test clock, behind is measured from its moment, not this computer's.
  const clockNow =
    h.eval_clock !== undefined ? Date.parse(h.eval_clock.now) : (o.now ?? Date.now)();
  const behindMs = clockBehind(logEnd, clockNow);
  io.out(
    TEXTS.status({
      lock: h.writer_lock === "held",
      behindMs,
      // The time as parsed, written again: not the string as the service sent it.
      logEnd:
        behindMs !== undefined ? new Date(Date.parse(logEnd as string)).toISOString() : undefined,
      state: h.state,
      reason: h.reason,
      version: h.version,
      mine: daemonVersion(),
      pid: h.pid,
      since: h.since,
      ...(h.eval_clock !== undefined ? { evalClock: h.eval_clock.now } : {}),
      home,
      data,
      socket,
      pending,
    }),
  );
  return h.state === "ready" ? 0 : 7;
}

/** The home's configuration, or undefined after saying on stderr why the file is refused. */
async function checkedConfig(home: string, io: CommandIO): Promise<Config | undefined> {
  try {
    return await readConfig(home);
  } catch (e) {
    if (!(e instanceof ConfigInvalid)) throw e;
    io.err(TEXTS.configInvalid);
    for (const p of e.problems) io.err(TEXTS.configProblem(p));
    return undefined;
  }
}

/** `config get [<key>]` and `config set <key> <value>` (06 §4.2). */
export async function configCommand(
  home: string,
  args: readonly string[],
  io: CommandIO,
): Promise<number> {
  const [verb, key, ...rest] = args;
  if (verb === "set") return configSet(home, args.slice(1), io);
  if (verb !== "get" || rest.length > 0) {
    io.err(TEXTS.usage(TEXTS.configUsage));
    return 2;
  }
  if (key !== undefined && !KEYS.has(key as ConfigKey)) {
    io.err(TEXTS.configUnknownKey(key));
    return 2;
  }
  const config = await checkedConfig(home, io);
  if (config === undefined) return 5;
  for (const e of config.entries) {
    if (key === undefined || e.key === key) io.out(TEXTS.configEntry(e));
  }
  return 0;
}

/** `config set <key> <value>`: one of the keys this version uses. */
async function configSet(home: string, args: readonly string[], io: CommandIO): Promise<number> {
  const [key, written, ...rest] = args;
  if (key === undefined || written === undefined || rest.length > 0) {
    io.err(TEXTS.usage(TEXTS.configUsage));
    return 2;
  }
  if (!KEYS.has(key as ConfigKey)) {
    io.err(TEXTS.configUnknownKey(key));
    return 2;
  }
  const v = setValue(key as ConfigKey, written);
  if (!v.ok) {
    io.err(TEXTS.configSetRefused);
    io.err(TEXTS.configProblem(v.problem));
    return 2;
  }
  const config = await checkedConfig(home, io);
  if (config === undefined) return 5;
  const { commentsDropped } = await setConfig(home, config, key as ConfigKey, v.value);
  io.out(TEXTS.configSet(key, String(v.value)));
  if (commentsDropped) io.out(TEXTS.configCommentsDropped);
  if (key === "mcp.autostart") io.out(TEXTS.configTakesEffectBridge);
  else if ((await health(socketFile(home))) !== undefined) io.out(TEXTS.configTakesEffectRestart);
  else io.out(TEXTS.configTakesEffectStart);
  return 0;
}

/** The service command `name` with its arguments; resolves with the exit code. */
export async function serviceCommand(
  name: "init" | "start" | "stop" | "status" | "config" | "mcp" | "service" | "doctor",
  argv: readonly string[],
  io: CommandIO,
  /** Tests: the system `service` runs its commands on (never launchctl or systemctl in a test). */
  sys: System = realSystem(),
  /** `doctor`: what the entry package adds (the hosts' entries, from the CLI package). */
  more: DoctorOptions = {},
): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      options: {
        home: { type: "string" },
        help: { type: "boolean", short: "h" },
        ...(name === "init"
          ? { "rotate-session": { type: "boolean" }, "data-dir": { type: "string" } }
          : {}),
        ...(name === "start"
          ? { foreground: { type: "boolean" }, "eval-clock": { type: "string" } }
          : {}),
        ...(name === "mcp" ? { record: { type: "string" } } : {}),
      },
      strict: true,
      allowPositionals: name === "config" || name === "service",
    }));
  } catch (e) {
    io.err(TEXTS.usage((e as Error).message));
    return 2;
  }
  if (values["help"] === true) {
    io.out(TEXTS.commandHelp[name]);
    return 0;
  }
  const home = resolve(
    typeof values["home"] === "string" ? values["home"] : join(homedir(), ".saveslot"),
  );
  switch (name) {
    case "init": {
      const dataDir = values["data-dir"];
      if (typeof dataDir === "string" && values["rotate-session"] === true) {
        io.err(TEXTS.usage("--data-dir is only for a new home, not with --rotate-session"));
        return 2;
      }
      if (dataDir === "") {
        io.err(TEXTS.usage("--data-dir needs a directory"));
        return 2;
      }
      return init(
        home,
        {
          rotate: values["rotate-session"] === true,
          // Relative to the current directory, normalized: what the home records is this path.
          ...(typeof dataDir === "string" ? { dataDir: resolve(dataDir) } : {}),
        },
        io,
      );
    }
    case "start": {
      const evalClock = values["eval-clock"];
      if (typeof evalClock === "string" && evalClockStart(evalClock) === undefined) {
        io.err(TEXTS.usage("--eval-clock needs an RFC 3339 moment with its offset"));
        return 2;
      }
      const clock = typeof evalClock === "string" ? ["--eval-clock", evalClock] : [];
      return values["foreground"] === true
        ? main(["--home", home, ...clock])
        : start(home, io, typeof evalClock === "string" ? { evalClock } : {});
    }
    case "stop":
      return stop(home, io);
    case "status":
      return status(home, io);
    case "config":
      return configCommand(home, positionals, io);
    case "mcp": {
      const record = values["record"];
      if (record === "") {
        io.err(TEXTS.usage("--record needs a file"));
        return 2;
      }
      return mcpCommand(home, io, typeof record === "string" ? resolve(record) : undefined);
    }
    case "service":
      return autostartCommand(home, positionals, io, sys);
    case "doctor":
      return doctor(home, io, sys, more);
  }
}

/** This process's system: the platform, the user, and commands run without a shell. */
function realSystem(): System {
  return {
    platform: process.platform,
    userHome: homedir(),
    uid: process.getuid?.() ?? -1,
    env: process.env,
    run: (command, args) =>
      new Promise((r) => {
        const child = spawn(command, [...args], { stdio: "ignore" });
        child.once("error", () => r({ code: undefined }));
        child.once("exit", (code) => r({ code: code ?? undefined }));
      }),
  };
}

/** The service's command line as `start` spawns it, in the foreground and supervised. */
function supervisedArgv(home: string): string[] {
  const bin = binPath();
  const conditions = bin.endsWith(".ts") ? ["--conditions=source"] : [];
  return [
    // A path that stays when Node is upgraded, when this Node has one (./autostart.ts).
    stableNode(process.execPath),
    ...conditions,
    bin,
    "--home",
    home,
    "--log",
    logFile(home),
    "--supervised",
  ];
}

/** `service install` / `uninstall` (06 §4.1). */
export async function autostartCommand(
  home: string,
  args: readonly string[],
  io: CommandIO,
  sys: System,
): Promise<number> {
  const [verb, ...rest] = args;
  if ((verb !== "install" && verb !== "uninstall") || rest.length > 0) {
    io.err(TEXTS.usage(TEXTS.autostartUsage));
    return 2;
  }
  if (verb === "uninstall") return uninstallAutostart(io, sys);
  try {
    await readTenantDirectory(home);
  } catch (e) {
    if (e instanceof LocalTenantError && e.code === "not_initialized") {
      io.err(TEXTS.notInitialized(home));
      return 5;
    }
    throw e;
  }
  return installAutostart({ argv: supervisedArgv(home), log: logFile(home) }, io, sys);
}

/**
 * `saveslot mcp` on this process's stdin and stdout (see ./mcp-bridge.ts). stderr gets the
 * bridge's event lines only: the service it starts writes nothing there, its texts are dropped
 * (they may hold the home's path) and its exit code is what the bridge logs. The service is
 * started only with `mcp.autostart` on (its default). SIGTERM and SIGINT
 * exit at once, without waiting for what is in flight: that is how a host ends a session; so does
 * stdout breaking (exit 0 for EPIPE, 1 otherwise).
 */
export async function mcpCommand(home: string, io: CommandIO, record?: string): Promise<number> {
  const quit = () => process.exit(0);
  process.once("SIGTERM", quit);
  process.once("SIGINT", quit);
  // `mcp.autostart` (06-cli §3 step 3, §4.2). A config.toml start would refuse, or one that cannot
  // be read: no start is tried; it is said by a code, and the bridge runs all the same.
  let autostart = false;
  try {
    autostart = (await readConfig(home)).mcpAutostart;
  } catch (e) {
    io.err(TEXTS.mcpEvent(e instanceof ConfigInvalid ? "config_invalid" : "config_unreadable"));
  }
  const code = await runBridge({
    token: process.env["SAVESLOT_TOKEN"],
    stdin: process.stdin,
    stdout: process.stdout,
    log: io.err,
    autostart,
    startService: () => start(home, { out: () => {}, err: () => {} }),
    version: daemonVersion(),
    socketPath: socketFile(home),
    ...(record !== undefined ? { record } : {}),
    // Nothing can be written any more: what is left (a start being waited for) is not waited for.
    onStdoutBroken: (c) => process.exit(c),
  });
  process.stdin.destroy();
  return code;
}
