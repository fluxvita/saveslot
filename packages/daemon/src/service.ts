// The local saveslot service process (docs/zh-CN/spec/02-architecture.md §7, §8; 06-cli.md §3 «分步做»,
// §4.1, §8.1): one process per home, one tenant, its DB Worker and database instance opened when the
// process starts and kept open until it stops. Nothing on a request path opens or closes the
// database.
//
// Start, in this order:
// 1. `<home>/run/` at 0700; the home's exclusive lock on `run/saveslot.lock` (an operating-system
//    lock the kernel drops when the process dies: a restarted process takes it at once, with no
//    pid or time-based staleness); `run/saveslot.pid`;
// 2. only now, holding the lock, remove a socket file a dead process left, and listen on
//    `run/saveslot.sock` (0600): `GET /health` answers from here on, `starting`;
// 3. open the tenant: its storage (crash recovery, ownership, durability are the backend's), then
//    the kernel's `openTenant` checks; `ready`, or `failed` with a code and no service.
// While ready, a light read every few seconds notices a DB Worker that died: the database is not
// reopened in the process; the service goes `failed` and exits non-zero, to be started again from
// outside (by `saveslot mcp`, launchd or systemd). Every few seconds too, the buffered reads are
// written (`flushReads`, §7).
//
// Stop (SIGTERM, SIGINT or stop()): `stopping`, stop accepting connections, close the tenant (the
// buffered reads are written, the high water moves up to the log's end, then the storage closes),
// remove the socket and pid files, release the lock.
//
// Log lines go to stderr, one per line, with no user data and no paths.
//
// The test clock (02-architecture §11 «评测对实现的要求»; 06-cli §3 «分步做»): `evalClock`, the
// moment to start at, given only by `--eval-clock`. Every "now" the process takes for the tenant
// (requests, the reads it writes, closing, the MCP text) is that moment plus the real time since
// the start, plus what `POST /v1/eval/clock` moved it forward by; log lines keep the system time.
// One evaluation run is one process, so the home is marked (`control/eval.json`) the first time:
// - a marked home starts with no test clock never (`eval_dir_refused`; `saveslot mcp`'s autostart
//   included), and with one never again (`eval_dir_refused`): a run whose service stopped is void;
// - an unmarked home starts with one only while its log holds nothing but the tenant's genesis,
//   recorded no later than the clock's start (`eval_clock_refused`), so that it is never turned on
//   over a user's data, nor behind the log's end, where every event would be recorded at that end.

import { closeSync, existsSync, fchmodSync, openSync, rmSync, writeSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import type { HealthBody, LocalListener, ToolResultSeen } from "@fluxvita/saveslot-server";
import { listenLocal } from "@fluxvita/saveslot-server";
import {
  ControlFileError,
  Credentials,
  CredentialsCorrupt,
  CursorKeys,
  CursorKeysCorrupt,
  checkLocalDataDir,
  checkLocalHome,
  closeLocalTenant,
  controlDir,
  flushLocalReads,
  importLocalTenant,
  type LocalTenant,
  LocalTenantGate,
  localCallers,
  localLogEnd,
  openLocalTenant,
  probeLocalTenant,
  pruneCredentials,
  removeStaleTemps,
  writePrivate,
} from "@fluxvita/saveslot-service";
import {
  type DirLockHandle,
  osFileLock,
  PgliteBackend,
  type PgliteBackendOptions,
  PgliteStoreError,
} from "@fluxvita/saveslot-store-pglite";
import { redactTokens } from "./mcp-record.ts";
import { nodeSupported } from "./runtime.ts";

export type ServiceState = "starting" | "ready" | "stopping" | "stopped" | "failed";

export interface RunServiceOptions {
  /** The service's home (`~/.saveslot` by default in `main`). */
  readonly home: string;
  readonly version: string;
  /** Stop on SIGTERM and SIGINT (default true). */
  readonly signals?: boolean;
  /** Interval of the DB Worker probe, in milliseconds (default 5000). */
  readonly probeMs?: number;
  /** Interval of writing the buffered reads (`flushReads`), in milliseconds (default 5000, §7). */
  readonly readsFlushMs?: number;
  /** The server-computed request key's window, in milliseconds (default 10 minutes). */
  readonly requestKeyWindowMs?: number;
  /** The clock (tests). */
  readonly clock?: () => string;
  /**
   * The test clock's starting moment, RFC 3339 (`--eval-clock`): evaluations only (02-architecture
   * §11). See the top of this file for the rules it starts by.
   */
  readonly evalClock?: string;
  /**
   * Each MCP tool call's contract result as it ended (tests). Given only in code; never from the
   * command line, configuration or the environment.
   */
  readonly onToolResult?: (seen: ToolResultSeen) => void;
  /**
   * Tests only: how long an export waits for its reader before it cuts the connection (the
   * kernel's EXPORT_STALL_MS otherwise). Given only in code.
   */
  readonly exportStallMs?: number;
  /** Where log lines go (default stderr). */
  readonly log?: (line: string) => void;
  /** Called once the service listens, before the tenant is opened (state `starting`). */
  readonly onListening?: (service: RunningService) => void;
  /**
   * Tests only, given only in code: what opens the tenant (`openLocalTenant` otherwise), and the
   * import as the HTTP surface calls it, handed over once the service listens.
   */
  readonly testing?: {
    readonly openTenant?: typeof openLocalTenant;
    /**
     * What makes the backend the tenant and an import's staging storage are opened and made with,
     * from the options the service gives it (`new PgliteBackend(options)` otherwise).
     */
    readonly backend?: (options: PgliteBackendOptions) => PgliteBackend;
    /** How long an import's body may give nothing (local-import.ts's default otherwise). */
    readonly importBodyIdleMs?: number;
    readonly onImport?: (
      run: (body: AsyncIterable<Uint8Array>, at: string) => Promise<unknown>,
    ) => void;
  };
}

export interface Exited {
  /** 0 after a stop; 1 when the service could not start or failed while running. */
  readonly code: number;
  readonly reason?: string;
}

export interface RunningService {
  readonly state: ServiceState;
  /** Whether it was ever ready: what failed after that failed while serving (`--supervised`). */
  readonly served: boolean;
  /** With `failed`: a stable code. */
  readonly reason: string | undefined;
  /** Stops the service; resolves when everything is released. */
  stop(): Promise<void>;
  readonly exited: Promise<Exited>;
  /** @internal For tests: the open tenant, while there is one. */
  readonly tenant: LocalTenant | undefined;
  /** @internal The local credentials, read once the tenant is open. */
  readonly credentials: Credentials | undefined;
}

/** Paths under the home (06-cli §3 «分步做»; 02-architecture §7). */
export const runDir = (home: string): string => join(home, "run");
export const lockDir = runDir;
export const pidFile = (home: string): string => join(runDir(home), "saveslot.pid");
export const socketFile = (home: string): string => join(runDir(home), "saveslot.sock");
/**
 * The last start's failure (02-architecture §8, local run state): `{at, reason}`, a stable code and
 * the system time, nothing else; written when the service fails or does not start, removed once one
 * is ready. Lost, `saveslot status` only says one line less.
 */
export const lastFailureFile = (home: string): string => join(runDir(home), "last-failure.json");
/**
 * The last start that became ready: how long it took and when (0600; `saveslot doctor` reads it).
 * Local running state only: lost or unreadable, doctor says there is no record.
 */
export const lastStartFile = (home: string): string => join(runDir(home), "last-start.json");
/**
 * The evaluation results (02-architecture §11): with the test clock, each MCP tool call's
 * connection instance, tool, arguments and contract result, one JSON line each; new at each start
 * (what was at the path removed, a link not followed, then made exclusively), 0600, tokens written
 * as `slt_REDACTED` / `sls_REDACTED`. Host and model get the text only.
 */
export const evalResultsFile = (home: string): string => join(runDir(home), "eval-results.jsonl");

/** The mark of a home an evaluation run has used (`--eval-clock`); never in the log. */
export const evalMarkFile = (home: string): string => join(controlDir(home), "eval.json");

/** An RFC 3339 moment with its offset (`2026-11-10T09:00:00+08:00`, `…Z`). */
const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** `--eval-clock`'s value as milliseconds, or undefined when it is not an RFC 3339 moment. */
export function evalClockStart(v: string): number | undefined {
  const ms = MOMENT.test(v) ? Date.parse(v) : Number.NaN;
  return Number.isNaN(ms) ? undefined : ms;
}

/** The test clock asked for over a log that holds more than the tenant's genesis. */
class EvalClockRefused extends Error {}
/** The data directory put elsewhere is not this user's alone (06 §3, §8.1). */
class DataDirOpen extends Error {}

/** A stable code for a failure: the store's own code, or a generic one. Never a message. */
function codeOf(e: unknown): string {
  return e instanceof PgliteStoreError ? e.code : "internal";
}

/** A file as the file system tells it apart: one replaced at the same path is another. */
interface FileId {
  readonly dev: number;
  readonly ino: number;
}

async function fileId(path: string): Promise<FileId | undefined> {
  try {
    const s = await lstat(path);
    return { dev: s.dev, ino: s.ino };
  } catch {
    return undefined;
  }
}

/** Whether a process accepts connections on the socket at `path`. */
function answers(path: string): Promise<boolean> {
  return new Promise((done) => {
    const c = connect(path);
    c.once("connect", () => {
      c.destroy();
      done(true);
    });
    c.once("error", () => done(false));
  });
}

/**
 * Links the socket bound at `bound` to `at`. Never replaces a socket there: one a live service
 * answers on is kept (false); one no process answers on is removed first.
 */
async function linkSocket(bound: string, at: string): Promise<boolean> {
  for (let tries = 0; ; tries++) {
    try {
      await link(bound, at);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (tries > 0 || (await answers(at))) return false;
      await rm(at, { force: true });
    }
  }
}

/** Removes each `<pid>.sock` in `dir` that no process answers on. */
async function removeStaleBound(dir: string): Promise<void> {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!/^[0-9]+\.sock$/.test(name)) continue;
    const path = join(dir, name);
    if (!(await answers(path))) await rm(path, { force: true });
  }
}

/** Removes `path` only while it is still the file `id` names; another file there is left. */
async function removeIfStill(path: string, id: FileId | undefined): Promise<void> {
  if (id === undefined) return;
  const now = await fileId(path);
  if (now !== undefined && now.dev === id.dev && now.ino === id.ino)
    await rm(path, { force: true });
}

/**
 * Starts the service. Resolves once it listens (state `starting`, then `ready` or `failed`), or
 * with `exited` already settled when it could not start at all (no home, or another process holds
 * the home's lock).
 */
export async function runService(o: RunServiceOptions): Promise<RunningService> {
  const begun = performance.now();
  const log =
    o.log ??
    ((line: string) => {
      process.stderr.write(`${line}\n`);
    });
  const say = (event: string, fields: Record<string, string | number> = {}) => {
    const at = new Date().toISOString();
    log([at, event, ...Object.entries(fields).map(([k, v]) => `${k}=${v}`)].join(" "));
    // A failure is kept for `status` once this process is gone; another process holding the home
    // is not this start's failure. Best effort: no home or no run/ yet, nothing is kept.
    // A service that lost the home's storage to another opener writes nothing into the home by
    // path any more: the home at that path may be another service's now.
    if (
      (event === "failed" || event === "not_started") &&
      fields["reason"] !== "already_running" &&
      fields["reason"] !== "ownership_lost"
    ) {
      writeFile(
        lastFailureFile(o.home),
        `${JSON.stringify({ at, reason: String(fields["reason"] ?? "internal") })}\n`,
        { mode: 0o600 },
      ).catch(() => {});
    }
  };
  const since = new Date().toISOString();
  // The test clock: its start, the real time it started at, and how far it was moved forward.
  const evalStart = o.evalClock !== undefined ? evalClockStart(o.evalClock) : undefined;
  const evalBegan = Date.now();
  let evalAhead = 0;
  const evalNow = () =>
    new Date((evalStart as number) + (Date.now() - evalBegan) + evalAhead).toISOString();
  const now: () => string =
    o.clock ?? (evalStart !== undefined ? evalNow : () => new Date().toISOString());
  let state: ServiceState = "starting";
  let reason: string | undefined;
  let tenant: LocalTenant | undefined;
  let credentials: Credentials | undefined;
  let cursors: CursorKeys | undefined;
  const currentTenant = (): LocalTenant => {
    if (tenant === undefined) throw new Error("the tenant is not open");
    return tenant;
  };
  // The tenant's gate for an import, and the import in progress (a stop waits for it).
  const gate = new LocalTenantGate();
  let importRun: Promise<unknown> | undefined;
  /** Aborts the import still reading its body: a stop does not wait on a client that stalled. */
  let importAbort: AbortController | undefined;
  const backendOptions: PgliteBackendOptions = { onEvent: (event, fields) => say(event, fields) };
  const tenantBackend = o.testing?.backend?.(backendOptions) ?? new PgliteBackend(backendOptions);
  const openTenant = o.testing?.openTenant ?? openLocalTenant;
  const leftover = (_path: string, e: unknown) =>
    say("import_leftover_not_removed", { code: codeOf(e) });
  let listener: LocalListener | undefined;
  let lock: DirLockHandle | undefined;
  let probe: NodeJS.Timeout | undefined;
  // The socket and pid files this process made, by device and inode. At its stop it removes them
  // only while they are still these: if the home was moved away and another service now runs at
  // the same path, the files there are that service's (02-architecture §7, the process lock).
  let ownSocket: FileId | undefined;
  let ownPid: FileId | undefined;
  let readsFlush: NodeJS.Timeout | undefined;
  /** The evaluation results' file, open while the service runs on the test clock. */
  let evalResults: number | undefined;
  const onToolResult = (seen: ToolResultSeen) => {
    o.onToolResult?.(seen);
    if (evalResults === undefined) return;
    const line = {
      t: now(),
      connection: seen.principal.kind === "connection" ? seen.principal.actor : null,
      tool: seen.tool,
      arguments: seen.arguments,
      result: seen.result,
    };
    try {
      writeSync(evalResults, `${redactTokens(JSON.stringify(line))}\n`);
    } catch {
      // A hole in the results is worse than a run that visibly ends.
      closeSync(evalResults);
      evalResults = undefined;
      state = "failed";
      reason = "eval_results_failed";
      say("failed", { reason });
      void stop(1);
    }
  };
  /** Settles once opening the tenant has settled, the storage closed again if stopped meanwhile. */
  let opening: Promise<void> | undefined;
  let resolveExited!: (e: Exited) => void;
  let served = false;
  const exited = new Promise<Exited>((r) => {
    resolveExited = r;
  });
  const onSignal = () => {
    void stop();
  };

  const handle: RunningService = {
    get state() {
      return state;
    },
    get served() {
      return served;
    },
    get reason() {
      return reason;
    },
    stop: () => stop(),
    exited,
    get tenant() {
      return tenant;
    },
    get credentials() {
      return credentials;
    },
  };

  let stopping: Promise<void> | undefined;
  function stop(code = 0): Promise<void> {
    stopping ??= (async () => {
      if (state !== "failed") state = "stopping";
      say("stopping");
      if (probe !== undefined) clearInterval(probe);
      if (readsFlush !== undefined) clearInterval(readsFlush);
      if (evalResults !== undefined) {
        closeSync(evalResults);
        evalResults = undefined;
      }
      if (o.signals !== false) {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
      }
      // An import still reading its body is refused and rolled back (before ④); one past it ends.
      importAbort?.abort();
      await listener?.close().catch(() => {});
      // A stop during opening waits for it: the storage is closed before the home's lock goes, so
      // the next process that takes the lock finds the data directory free too.
      await opening;
      await importRun?.catch(() => {});
      if (tenant !== undefined) {
        const t = tenant;
        tenant = undefined;
        try {
          const r = await closeLocalTenant(t, now());
          if (r.readsError !== undefined) say("reads_not_flushed", { code: codeOf(r.readsError) });
          if (r.highWaterError !== undefined)
            say("high_water_not_advanced", { code: codeOf(r.highWaterError) });
        } catch (e) {
          say("tenant_close_failed", { code: codeOf(e) });
        }
      }
      await removeIfStill(socketFile(o.home), ownSocket);
      await removeIfStill(pidFile(o.home), ownPid);
      await lock?.release();
      // A service that failed exits non-zero, however it was stopped (`start` stops one it saw fail).
      const exit = state === "failed" ? Math.max(code, 1) : code;
      if (state !== "failed") state = "stopped";
      say("stopped", { code: exit });
      resolveExited(reason !== undefined && exit !== 0 ? { code: exit, reason } : { code: exit });
    })();
    return stopping;
  }

  const giveUp = (why: string): RunningService => {
    state = "failed";
    reason = why;
    say("not_started", { reason: why });
    resolveExited({ code: 1, reason: why });
    return handle;
  };

  // The Node it runs on, and a warning below the floor (./runtime.ts): it starts all the same.
  say("runtime", { node: process.versions.node });
  if (!nodeSupported(process.versions.node))
    say("runtime_below_floor", { node: process.versions.node });

  // The home must exist: `saveslot init` makes it.
  try {
    if (!(await stat(o.home)).isDirectory()) return giveUp("not_initialized");
  } catch {
    return giveUp("not_initialized");
  }
  if (o.evalClock !== undefined && evalStart === undefined) return giveUp("eval_clock_invalid");
  // A home an evaluation run has used: never again, with the test clock or without.
  if (existsSync(evalMarkFile(o.home))) return giveUp("eval_dir_refused");
  await mkdir(runDir(o.home), { recursive: true, mode: 0o700 });
  await chmod(runDir(o.home), 0o700);
  try {
    lock = await osFileLock.acquire(lockDir(o.home));
  } catch (e) {
    if (e instanceof PgliteStoreError && e.code === "store_locked")
      return giveUp("already_running");
    throw e;
  }
  // A socket here that a live service answers on is that service's, though this process holds the
  // lock (a home moved away and back, or one whose lock directory was replaced): never taken over.
  if (await answers(socketFile(o.home))) {
    await lock.release();
    lock = undefined;
    return giveUp("already_running");
  }
  // Sockets bound under a process's own name and never linked into place: left by a process that
  // died while starting, if no process answers on them.
  await removeStaleBound(runDir(o.home));
  // Bound under a name of this process's own, then linked into place: closing a listener unlinks
  // the path it was bound at, and that path must never be the one another service may hold by
  // then. What closing unlinks is this name, which nothing else uses. A link, not a rename: a
  // socket that appeared at the path meanwhile is never replaced.
  const bound = join(runDir(o.home), `${process.pid}.sock`);
  await rm(bound, { force: true });
  listener = await listenLocal({
    socketPath: bound,
    api: {
      // Stopping: it takes no new requests (04-contract «unavailable»). Failed: it stays so until it
      // is stopped (02-architecture §7), takes no requests either, and has no time to try again.
      notReady: () =>
        state === "stopping" || state === "stopped"
          ? { reason: "stopping", retryAfter: 1 }
          : state === "failed"
            ? { reason: "stopping" }
            : { reason: "starting" },
      ready: () =>
        state === "ready" &&
        (tenant !== undefined || gate.importing) &&
        credentials !== undefined &&
        cursors !== undefined
          ? {
              // The tenant as it is when a request is served, not as it was when it came in.
              callers: localCallers({ tenant: currentTenant, credentials, gate }),
              importing: () => gate.importing,
              import: (r) => importInto(r.body, r.now),
              cursors,
              windows: { requestKey: o.requestKeyWindowMs ?? 600_000, idempotencyKey: 86_400_000 },
              now,
              ...(evalStart !== undefined
                ? {
                    evalClock: {
                      advance: (ms: number) => {
                        evalAhead += ms;
                        const at = now();
                        say("eval_clock_advanced", { ms, now: at });
                        return at;
                      },
                    },
                  }
                : {}),
              onToolResult,
              ...(o.exportStallMs !== undefined ? { exportStallMs: o.exportStallMs } : {}),
              warn: (event, fields) => say(event, fields),
            }
          : undefined,
      log: (fields) => say("request", fields),
    },
    health: (): HealthBody => ({
      state: state === "stopped" ? "stopping" : state,
      version: o.version,
      pid: process.pid,
      since,
      ...(state === "failed" && reason !== undefined ? { reason } : {}),
      // Taken above, before listening: whoever answers here holds it.
      writer_lock: "held",
      ...(evalStart !== undefined
        ? {
            eval_clock: {
              now: now(),
              started_at: new Date(evalStart).toISOString(),
            },
          }
        : {}),
    }),
  });
  if (!(await linkSocket(bound, socketFile(o.home)))) {
    // Another service took the path between the check above and now: it keeps it, and its pid
    // file, which this process has not written.
    await listener.close().catch(() => {});
    listener = undefined;
    await lock.release();
    lock = undefined;
    return giveUp("already_running");
  }
  await unlink(bound).catch(() => {});
  ownSocket = await fileId(socketFile(o.home));
  // Written once the socket at the path is this process's: never over another service's.
  const tmp = `${pidFile(o.home)}.tmp`;
  await writeFile(tmp, `${process.pid}\n`, { mode: 0o600 });
  await rename(tmp, pidFile(o.home));
  ownPid = await fileId(pidFile(o.home));
  if (o.signals !== false) {
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }
  say("listening", { pid: process.pid, version: o.version });
  if (evalStart !== undefined) say("eval_clock", { start: new Date(evalStart).toISOString() });
  o.onListening?.(handle);

  /**
   * An import into the tenant (local-import.ts), holding it: the tenant is closed at the swap and
   * opened again afterwards, whichever way the import ended, as a start opens it (the import's
   * re-entry included). The credentials of principals the import disabled go then. A stop waits
   * for it: `importRun` is the import holding the gate, never one refused as `busy`.
   */
  const importInto = (body: AsyncIterable<Uint8Array>, at: string) =>
    gate.exclusive(() => {
      const run = importHeld(body, at);
      importRun = run;
      return run;
    });
  const importHeld = async (body: AsyncIterable<Uint8Array>, at: string) => {
    const abort = new AbortController();
    importAbort = abort;
    if (stopping !== undefined) abort.abort();
    const t = currentTenant();
    let closed = false;
    try {
      return await importLocalTenant({
        backend: tenantBackend,
        target: {
          tenant: t.tenant,
          store: t.store,
          anchor: t.anchor,
          dataDir: t.dataDir,
          close: async () => {
            closed = true;
            tenant = undefined;
            const r = await closeLocalTenant(t, now());
            if (r.readsError !== undefined)
              say("reads_not_flushed", { code: codeOf(r.readsError) });
            if (r.highWaterError !== undefined)
              say("high_water_not_advanced", { code: codeOf(r.highWaterError) });
          },
        },
        user: t.user,
        body,
        now: at,
        onLeftover: (_path, e) => say("import_leftover_not_removed", { code: codeOf(e) }),
        signal: abort.signal,
        ...(o.testing?.importBodyIdleMs !== undefined
          ? { bodyIdleMs: o.testing.importBodyIdleMs }
          : {}),
      });
    } finally {
      if (closed) await reopenAfterImport();
    }
  };
  /** The tenant opened again after an import; if it does not open, the service fails and stops. */
  const reopenAfterImport = async () => {
    try {
      const r = await openTenant({ home: o.home, backend: tenantBackend, onLeftover: leftover });
      if (!r.ok) {
        state = "failed";
        reason = r.failure;
        say("failed", { reason: r.failure });
        void stop(1);
        return;
      }
      tenant = r.tenant;
      if (credentials !== undefined) {
        const dropped = await pruneCredentials(r.tenant, credentials);
        if (dropped > 0) say("credentials_pruned", { count: dropped });
      }
    } catch (e) {
      state = "failed";
      reason = codeOf(e);
      say("failed", { reason });
      void stop(1);
    }
  };

  o.testing?.onImport?.(importInto);

  opening = (async () => {
    try {
      const r = await openTenant({ home: o.home, backend: tenantBackend, onLeftover: leftover });
      if (stopping !== undefined) {
        // Stopped while opening: close what was opened; stop() waits for this.
        if (r.ok) {
          await closeLocalTenant(r.tenant).catch((e: unknown) => {
            say("tenant_close_failed", { code: codeOf(e) });
          });
        }
        return;
      }
      if (!r.ok) {
        state = "failed";
        reason = r.failure;
        say("failed", { reason: r.failure });
        return;
      }
      // The credentials (02-architecture §5): owned by this user, 0600 in a 0700 directory, of
      // their form; hashes of principals that do not exist or no longer authenticate go.
      try {
        // Holding the home's lock: what a write killed before its rename left goes first.
        removeStaleTemps([join(o.home, "control"), join(o.home, "credentials")]);
        await checkLocalHome(o.home);
        // A data directory put elsewhere (06 §3, §8.1): this user's alone, as the home is. The
        // default one is inside the home's 0700 and not checked (a home made before init made it
        // 0700 has it as the storage made it).
        if (resolve(r.tenant.dataDir) !== resolve(o.home, "data")) {
          try {
            await checkLocalDataDir(r.tenant.dataDir);
          } catch (e) {
            if (e instanceof ControlFileError) throw new DataDirOpen();
            throw e;
          }
        }
        credentials = await Credentials.load(o.home);
        const dropped = await pruneCredentials(r.tenant, credentials);
        if (dropped > 0) say("credentials_pruned", { count: dropped });
        cursors = await CursorKeys.open(o.home, now());
        if (evalStart !== undefined) {
          // Only over a log that holds nothing but the tenant's genesis, recorded no later than
          // the clock's start: a clock behind the log's end would record every event at that end
          // (02-architecture §8), and the test clock would show in nothing the log keeps. Then
          // the home is marked.
          const end = await localLogEnd(r.tenant);
          if (end === undefined || end.seq !== 1 || Date.parse(end.at) > evalStart) {
            throw new EvalClockRefused();
          }
          writePrivate(
            evalMarkFile(o.home),
            `${JSON.stringify({ eval_clock: new Date(evalStart).toISOString() })}\n`,
          );
          // New at this start: whatever is at the path goes first (a link is removed, not
          // followed), then the file is made exclusively.
          rmSync(evalResultsFile(o.home), { force: true });
          evalResults = openSync(evalResultsFile(o.home), "wx", 0o600);
          fchmodSync(evalResults, 0o600);
        }
      } catch (e) {
        await closeLocalTenant(r.tenant).catch(() => {});
        state = "failed";
        reason =
          e instanceof EvalClockRefused
            ? "eval_clock_refused"
            : e instanceof DataDirOpen
              ? "data_dir_permissions"
              : e instanceof ControlFileError
                ? "credentials_permissions"
                : e instanceof CredentialsCorrupt
                  ? "credentials_corrupt"
                  : e instanceof CursorKeysCorrupt
                    ? "cursor_keys_corrupt"
                    : codeOf(e);
        say("failed", { reason });
        return;
      }
      tenant = r.tenant;
    } catch (e) {
      if (stopping !== undefined) return;
      state = "failed";
      reason = codeOf(e);
      // A store of another format: the log also keeps what the backend says to do (its own text,
      // which holds no user data).
      const format =
        e instanceof PgliteStoreError &&
        (e.code === "format_too_old" || e.code === "format_too_new");
      say("failed", { reason, ...(format ? { message: e.message } : {}) });
      return;
    }
    // Gone before the service says it is ready: whoever sees it ready finds no failure kept.
    await rm(lastFailureFile(o.home), { force: true });
    // How long this start took, from the call to ready; not written is no failure of the start.
    await writeFile(
      lastStartFile(o.home),
      `${JSON.stringify({ ms: Math.round(performance.now() - begun), at: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    ).catch(() => say("last_start_not_written", {}));
    state = "ready";
    served = true;
    say("ready");
    let probing = false;
    probe = setInterval(() => {
      const t = tenant;
      // One probe at a time: a slow read is not stacked on. A use of the tenant: none while an
      // import holds it, and an import waits for one in progress before it closes the tenant.
      if (t === undefined || state !== "ready" || probing || gate.importing) return;
      probing = true;
      gate
        .use(() => probeLocalTenant(t))
        .then(
          () => {
            probing = false;
          },
          (e: unknown) => {
            probing = false;
            if (state !== "ready") return;
            // The DB Worker is gone: not reopened in this process (§7); exit non-zero.
            state = "failed";
            reason = codeOf(e);
            say("failed", { reason });
            void stop(1);
          },
        );
    }, o.probeMs ?? 5000);
    let flushing = false;
    readsFlush = setInterval(() => {
      const t = tenant;
      // One flush at a time; a failed one leaves the reads buffered for the next (§7). A use of
      // the tenant, as the probe is.
      if (t === undefined || state !== "ready" || flushing || gate.importing) return;
      flushing = true;
      gate
        .use(() => flushLocalReads(t, now()))
        .then(
          () => {
            flushing = false;
          },
          (e: unknown) => {
            flushing = false;
            if (state === "ready") say("reads_flush_failed", { code: codeOf(e) });
          },
        );
    }, o.readsFlushMs ?? 5000);
  })();
  await opening;
  return handle;
}
