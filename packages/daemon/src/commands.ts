// The service commands `init`, `start`, `stop` and `status` (docs/zh-CN/spec/06-cli.md §3 «分步做»
// and its steps 2–3, §4.1, §6.2). They manage the local service process; none is a contract
// operation. The entry package dispatches to `serviceCommand`.
//
// - `init [--rotate-session]`: the only command that opens the storage itself, under the home's
//   lock; refused (exit 5, nothing changed) on a home initialized already or while the service
//   runs.
// - `start [--foreground]`: in the background, a detached process of this package's entry, its
//   log appended to `run/saveslot.log` (0600); waits for `GET /health` to say ready. A service
//   running already: same version, nothing to do; another version, exit 1 (it is not restarted:
//   a host may be connected). Failing to start: the process is stopped, exit 7.
// - `stop`: signals only a process it has verified. `/health` answering: SIGTERM to the pid of the
//   pid file only when `/health` names that same pid, then waits for that process to exit; another
//   pid: no signal, exit 7. `/health` not answering: the home's lock not held means nothing runs (a
//   pid file left is removed, exit 0); held (starting, or stuck): no signal, exit 7.
// - `status`: what `/health` says, the paths, and the number of pending items (`pending`, as the
//   user session).
//
// The lock is probed only when `/health` does not answer, and once after the stopped process has
// exited: a probe takes the lock for a moment, and a service starting in that moment (one an MCP
// bridge starts, 06-cli §3 step 3) fails with `store_locked`. What is left of that window: a
// service starting just when `stop` or `status` finds no answer on the socket, or just after the
// process `stop` waited for has exited. Such a start fails and is not retried by `start`; the
// bridge that started it starts it again on its next request.

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
  initLocalHome,
  LocalTenantError,
  readPrivate,
  readTenantDirectory,
  rotateSession,
  ServiceRunning,
  sessionFile,
} from "@fluxvita/saveslot-service";
import { osFileLock, PgliteBackend, PgliteStoreError } from "@fluxvita/saveslot-store-pglite";
import { health, localRequest } from "./local-request.ts";
import { daemonVersion, main } from "./main.ts";
import { lockDir, pidFile, runDir, socketFile } from "./service.ts";
import { TEXTS } from "./texts.ts";

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

/** Path segments of folders that sync services keep (06-cli §3 step 2; 02-architecture §7). */
const SYNCED = [
  "/Library/Mobile Documents/", // iCloud Drive
  "/Library/CloudStorage/", // Dropbox, OneDrive, Google Drive and others on macOS
  "/Dropbox/",
  "/OneDrive/",
  "/Google Drive/",
];

export function looksSynced(dir: string): boolean {
  const d = `${resolve(dir)}/`;
  return SYNCED.some((s) => d.includes(s));
}

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

export async function init(home: string, rotate: boolean, io: CommandIO): Promise<number> {
  try {
    if (rotate) {
      await rotateSession(home, osFileLock);
      io.out(TEXTS.rotated);
      return 0;
    }
    const r = await initLocalHome({
      home,
      backend: new PgliteBackend(),
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
    throw e;
  }
}

/** Waits until `/health` says ready or failed, the process has exited, or the time is up. */
async function waitReady(
  socket: string,
  exited: () => boolean,
): Promise<HealthBody | "exited" | "timeout"> {
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    const h = await health(socket, 2000);
    if (h !== undefined && (h.state === "ready" || h.state === "failed")) return h;
    if (h === undefined && exited()) return "exited";
    await sleep(POLL_MS);
  }
  return "timeout";
}

export async function start(home: string, io: CommandIO): Promise<number> {
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
    const h = running.state === "ready" ? running : await waitReady(socket, () => false);
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

  await mkdir(runDir(home), { recursive: true, mode: 0o700 });
  const log = openSync(logFile(home), "a", 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    fchmodSync(log, 0o600);
    const bin = binPath();
    // Run from the sources (development, tests): the workspace packages by their source entries.
    const conditions = bin.endsWith(".ts") ? ["--conditions=source"] : [];
    child = spawn(process.execPath, [...conditions, bin, "--home", home], {
      detached: true,
      stdio: ["ignore", log, log],
    });
  } finally {
    closeSync(log);
  }
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  child.unref();

  const h = await waitReady(socket, () => exited);
  if (typeof h === "object" && h.state === "ready") {
    // Another start may have won the home's lock: then it is that process that answers.
    if (h.version !== mine) {
      io.err(TEXTS.versionMismatch(h.version, mine));
      return 1;
    }
    io.out(h.pid === child.pid ? TEXTS.started(h.pid, socket) : TEXTS.alreadyRunning(h.pid));
    return 0;
  }
  if (typeof h === "object") {
    // Failed: the process holds the lock while it lives; stopped so that the next start can run.
    if (h.pid === child.pid) child.kill("SIGTERM");
    io.err(TEXTS.startFailed(h.reason ?? "failed"));
    return 7;
  }
  if (h === "timeout") {
    // Not killed: it may be recovering (02-architecture §8), which takes as long as it takes.
    io.err(TEXTS.startTimedOut(child.pid as number));
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
async function pendingCount(home: string): Promise<number | undefined> {
  let token: string | undefined;
  try {
    token = (await readPrivate(sessionFile(home)))?.trim();
  } catch {
    return undefined;
  }
  if (token === undefined) return undefined;
  try {
    const a = await localRequest({
      socketPath: socketFile(home),
      method: "GET",
      path: "/v1/pending?limit=1",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      timeoutMs: 10_000,
    });
    if (a.status !== 200) return undefined;
    const v = JSON.parse(a.body.toString("utf8")) as Record<string, unknown>;
    return typeof v["total"] === "number" ? v["total"] : undefined;
  } catch {
    return undefined;
  }
}

export async function status(home: string, io: CommandIO): Promise<number> {
  const socket = socketFile(home);
  const h = await health(socket);
  if (h === undefined) {
    io.out((await lockHeld(home)) ? TEXTS.statusNotAnswering : TEXTS.statusNotRunning);
    return 7;
  }
  const pending = h.state === "ready" ? await pendingCount(home) : undefined;
  io.out(
    TEXTS.status({
      state: h.state,
      reason: h.reason,
      version: h.version,
      mine: daemonVersion(),
      pid: h.pid,
      since: h.since,
      home,
      // The default place; reads the data directory the home records once it can record one.
      data: join(home, "data"),
      socket,
      pending,
    }),
  );
  return h.state === "ready" ? 0 : 7;
}

/** The service command `name` with its arguments; resolves with the exit code. */
export async function serviceCommand(
  name: "init" | "start" | "stop" | "status",
  argv: readonly string[],
  io: CommandIO,
): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        home: { type: "string" },
        ...(name === "init" ? { "rotate-session": { type: "boolean" } } : {}),
        ...(name === "start" ? { foreground: { type: "boolean" } } : {}),
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    io.err(TEXTS.usage((e as Error).message));
    return 2;
  }
  const home = resolve(
    typeof values["home"] === "string" ? values["home"] : join(homedir(), ".saveslot"),
  );
  switch (name) {
    case "init":
      return init(home, values["rotate-session"] === true, io);
    case "start":
      return values["foreground"] === true ? main(["--home", home]) : start(home, io);
    case "stop":
      return stop(home, io);
    case "status":
      return status(home, io);
  }
}
