// `saveslot connect` apart from its requests (docs/zh-CN/spec/06-cli.md §3.2, §8.2): the hosts it
// knows, `--scope`, the path the host is to start saveslot by, what the host is given, and running
// the host's own command to add it (`--apply`).
//
// The token is passed in and handed on, never kept: into the text of the host's setup, and into the
// arguments of the host's command when it is run. Nothing here writes it anywhere else; the host's
// own output is not passed on (it may echo what it was given).

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  type Client,
  type Connection,
  type ConnectionsIssueParams,
  type ConnectionsIssueResult,
  createClient,
  SCOPES,
  type Scope,
  SELFCHECK_TASK,
} from "@fluxvita/saveslot-client";
import { showable } from "./render/text.ts";
import { type Static, TEXTS } from "./texts.ts";
import { Failed, UsageError } from "./usage.ts";

/** The hosts `connect` makes a setup for (06 §3.2's table), by the name the command line takes. */
export const HOSTS = [
  "claude-code",
  "codex",
  "cursor",
  "claude-desktop",
  "generic",
  "http",
] as const;
export type Host = (typeof HOSTS)[number];

/** The hosts `setup` looks for (06 §3.3). */
export const SETUP_HOSTS = ["claude-code", "codex", "cursor", "claude-desktop"] as const;
export type SetupHost = (typeof SETUP_HOSTS)[number];

/**
 * The one place for what a host is run by: the executable of a host with an add command, and its
 * command to remove the entry (the arguments after the executable); for one without (an app, no
 * command line), the configuration directories whose presence says it is installed (only whether
 * they are there is looked at, never what is in them). Display names are in ./texts.ts.
 */
export const HOST_INFO: Readonly<
  Record<
    SetupHost,
    {
      readonly exe?: string;
      readonly remove?: readonly string[];
      readonly dirs?: (home: string, platform: NodeJS.Platform) => string[];
    }
  >
> = {
  "claude-code": { exe: "claude", remove: ["mcp", "remove", "saveslot", "--scope", "user"] },
  codex: { exe: "codex", remove: ["mcp", "remove", "saveslot"] },
  cursor: { dirs: (home) => [join(home, ".cursor")] },
  "claude-desktop": {
    dirs: (home, platform) =>
      platform === "darwin"
        ? [join(home, "Library", "Application Support", "Claude")]
        : [join(home, ".config", "Claude")],
  },
};

/** The hosts with a command to add saveslot: the ones `--apply` and `setup` can run. */
export const APPLIES: ReadonlySet<Host> = new Set<Host>(
  SETUP_HOSTS.filter((h) => HOST_INFO[h].exe !== undefined),
);

/** The host's command to remove saveslot's entry, as its arguments; undefined for an app. */
export function removeCommand(host: SetupHost): string[] | undefined {
  const { exe, remove } = HOST_INFO[host];
  return exe !== undefined && remove !== undefined ? [exe, ...remove] : undefined;
}

/** The hosts `saveslot snippet` has a place for (06 §3.4). */
export const SNIPPET_HOSTS = [
  "claude-code",
  "codex",
  "vscode",
  "cursor",
  "gemini",
  "claude-desktop",
  "chatgpt",
] as const;
export type SnippetHost = (typeof SNIPPET_HOSTS)[number];

/** The scopes of an instance when none are given (06 §3.2): the service's default too. */
export const DEFAULT_SCOPES: readonly Scope[] = ["saveslot.read", "saveslot.write"];

/** A scope as the command line names it, with or without `saveslot.`; undefined if none. */
function scopeNamed(s: string): Scope | undefined {
  const full = s.startsWith("saveslot.") ? s : `saveslot.${s}`;
  return (SCOPES as readonly string[]).includes(full) ? (full as Scope) : undefined;
}

/**
 * `--scope` (06 §3.2), given once or more, each a comma list: all `+x` / `-x` (from the default),
 * or none of them (the whole set). Undefined when not given: the service's default. Every set
 * holds `saveslot.read`; it comes back in the order of `SCOPES`.
 */
export function parseScopes(given: readonly string[]): Scope[] | undefined {
  if (given.length === 0) return undefined;
  const items = given.flatMap((g) => g.split(",")).map((x) => x.trim());
  if (items.some((x) => x === "" || x === "+" || x === "-")) throw new UsageError(TEXTS.scopeBad);
  const signed = items.filter((x) => x.startsWith("+") || x.startsWith("-"));
  if (signed.length > 0 && signed.length < items.length) throw new UsageError(TEXTS.scopeMixed);
  const set = new Set<Scope>(signed.length > 0 ? DEFAULT_SCOPES : []);
  for (const x of items) {
    const sign = x[0] === "+" || x[0] === "-" ? x[0] : "";
    const scope = scopeNamed(x.slice(sign.length));
    if (scope === undefined) throw new UsageError(TEXTS.scopeUnknown);
    if (sign === "-") set.delete(scope);
    else set.add(scope);
  }
  if (!set.has("saveslot.read")) throw new UsageError(TEXTS.scopeNoRead);
  return SCOPES.filter((s) => set.has(s));
}

/**
 * The path the host is to start saveslot by: the one this program was started by, absolute,
 * links kept (06 §3.2). Refused (exit 1, nothing issued) when it is missing, no file, not
 * executable, or not showable as it is in the command printed.
 */
export async function entryPath(entry: string | undefined): Promise<string> {
  if (entry === undefined || !isAbsolute(entry) || !showable(entry)) {
    throw new Failed(TEXTS.entryUnusable, 1);
  }
  try {
    if (!(await stat(entry)).isFile()) throw new Error("not a file");
    await access(entry, constants.X_OK);
  } catch {
    throw new Failed(TEXTS.entryUnusable, 1);
  }
  return entry;
}

/** Whether the path is in npx's cache (a `_npx` directory in it), which goes away: said, not refused. */
export const entryMayGo = (entry: string): boolean => entry.split("/").includes("_npx");

/** The host's command to add saveslot, as its arguments (06 §3.2: user level, name first). */
export function addCommand(host: Host, token: string, entry: string): string[] | undefined {
  const env = `SAVESLOT_TOKEN=${token}`;
  if (host === "claude-code")
    return [
      HOST_INFO[host].exe as string,
      "mcp",
      "add",
      "saveslot",
      "--scope",
      "user",
      "-e",
      env,
      "--",
      entry,
      "mcp",
    ];
  if (host === "codex")
    return [
      HOST_INFO[host].exe as string,
      "mcp",
      "add",
      "saveslot",
      "--env",
      env,
      "--",
      entry,
      "mcp",
    ];
  return undefined;
}

/** The configuration a host without an add command is given to paste (06 §3.2). */
export function pastedConfig(host: Host, token: string, entry: string): unknown {
  const server = { command: entry, args: ["mcp"], env: { SAVESLOT_TOKEN: token } };
  if (host === "generic") return server;
  return { mcpServers: { saveslot: server } };
}

/** How long the host's command may take before it is stopped (06 §3.2). */
export const HOST_TIMEOUT_MS = 60_000;

/**
 * The executable `name` is on `PATH` (the environment's): the first absolute `PATH` entry holding
 * an executable file of that name; undefined when none does. `--apply` runs that file, and shows it.
 */
export async function onPath(name: string, path: string | undefined): Promise<string | undefined> {
  for (const dir of (path ?? "").split(":")) {
    if (!isAbsolute(dir)) continue;
    const file = join(dir, name);
    try {
      if (!(await stat(file)).isFile()) continue;
      await access(file, constants.X_OK);
      return file;
    } catch {}
  }
  return undefined;
}

/** What became of the host's command. */
export type Applied =
  | { readonly kind: "done" }
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "signal" }
  | { readonly kind: "not_found" }
  | { readonly kind: "cannot_run" }
  | { readonly kind: "timeout" }
  /** Stopped because this process was asked to stop (SIGINT, SIGTERM). */
  | { readonly kind: "interrupted" };

/**
 * Runs the host's command, `argv[0]` an absolute path: no shell, in a process group of its own,
 * its output read and dropped (stdout handed to `onOut` when given, never shown as it is). Done
 * when it exits (what it left running is its own); after `timeoutMs`, its whole group is killed
 * and its output pipes closed. Never throws.
 */
export function runHostCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs = HOST_TIMEOUT_MS,
  /** Handed what the host writes, and on which stream; done then once both streams have ended. */
  onOut?: (chunk: Buffer, stream: "stdout" | "stderr") => void,
  /** Aborted: the host's whole group is killed, as on a timeout. */
  stop?: AbortSignal,
): Promise<Applied> {
  const [file, ...args] = argv as [string, ...string[]];
  // The host is the user's own tool and is given the user's environment (06 §8.2).
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
  const failed = (e: unknown): Applied =>
    (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "not_found" } : { kind: "cannot_run" };
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        env: childEnv,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      // A file the system cannot execute (no `#!`, ENOEXEC) can throw here, not as an event.
      resolve(failed(e));
      return;
    }
    let settled = false;
    const done = (a: Applied) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(a);
    };
    // A caller of its stdout gets all of it: done once the host has exited and its stdout has
    // ended (what it started may hold the pipe: then the timeout ends it).
    let exited: Applied | undefined;
    let open = onOut === undefined ? 0 : 2;
    const ended = () => open === 0;
    if (onOut !== undefined) {
      for (const stream of ["stdout", "stderr"] as const) {
        child[stream]?.on("data", (c: Buffer) => onOut(c, stream));
        child[stream]?.on("end", () => {
          open -= 1;
          if (ended() && exited !== undefined) done(exited);
        });
      }
    } else {
      child.stdout?.resume();
      child.stderr?.resume();
    }
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      killGroup();
      done({ kind: "timeout" });
    }, timeoutMs);
    const onStop = () => {
      killGroup();
      done({ kind: "interrupted" });
    };
    if (stop?.aborted === true) onStop();
    stop?.addEventListener("abort", onStop, { once: true });
    child.on("error", (e) => done(failed(e)));
    child.on("exit", (code) => {
      exited =
        code === 0 ? { kind: "done" } : code === null ? { kind: "signal" } : { kind: "exit", code };
      if (ended()) done(exited);
    });
  });
}

/** Revokes a connection instance as far as it can, never throwing: whether it did. */
export async function revokeQuietly(session: Client, id: Connection["id"]): Promise<boolean> {
  try {
    await session.connections.revoke({ id });
    return true;
  } catch {
    return false;
  }
}

/** What became of an issue: ready, its token held here only; or not usable, and revoked if it could be. */
export type Checked =
  | {
      readonly kind: "ready";
      readonly issued: ConnectionsIssueResult;
      readonly connection: Connection;
      readonly token: string;
      readonly slots: number;
      readonly more: boolean;
    }
  | {
      /** The service gave no token of the shape it gives. */
      readonly kind: "malformed";
      readonly connection: Connection;
      readonly error?: undefined;
      readonly revoked: boolean;
    }
  | {
      /** The new token could not read the catalog. */
      readonly kind: "refused";
      readonly connection: Connection;
      readonly error: unknown;
      readonly revoked: boolean;
    };

/**
 * `connections.issue` with the user session, then the self-check with the new token (06 §3 step
 * 7): a token of the service's shape that reads the catalog, as the self-check. Not usable: the
 * instance is revoked (as far as it can be) and its token dropped. The issue's own error is thrown.
 * Used by `connect` and by `setup`.
 */
export async function issueChecked(
  session: Client,
  socketPath: string,
  params: ConnectionsIssueParams,
): Promise<Checked> {
  const issued = await session.connections.issue(params);
  const { token, ...connection } = issued;
  if (typeof token !== "string" || !/^slt_[A-Za-z0-9_-]{43}$/.test(token)) {
    return { kind: "malformed", connection, revoked: await revokeQuietly(session, connection.id) };
  }
  try {
    const own = createClient({ socketPath, token });
    const r = await own.catalog({ level: "list", limit: 200, task: SELFCHECK_TASK });
    return {
      kind: "ready",
      issued,
      connection,
      token,
      slots: r.slots.length,
      more: r.next_cursor !== undefined,
    };
  } catch (error) {
    return {
      kind: "refused",
      connection,
      error,
      revoked: await revokeQuietly(session, connection.id),
    };
  }
}

/** How long a host's version and look-up commands may take (06 §3.3 item 1: 5 seconds). */
export const PROBE_TIMEOUT_MS = 5_000;

/** At most this much of what a host's command writes is kept, per stream. */
const KEPT = 1024 * 1024;

/**
 * Runs a host's command for what it writes: what became of it, and its stdout and stderr (each cut
 * at 1 MiB). Stopped with the rest when `stop` is aborted.
 */
export async function hostOutput(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs = PROBE_TIMEOUT_MS,
  stop?: AbortSignal,
): Promise<{ readonly applied: Applied; readonly out: string; readonly err: string }> {
  const kept = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  const size = { stdout: 0, stderr: 0 };
  const applied = await runHostCommand(
    argv,
    env,
    timeoutMs,
    (c, stream) => {
      if (size[stream] >= KEPT) return;
      kept[stream].push(c);
      size[stream] += c.length;
    },
    stop,
  );
  const text = (b: Buffer[]) => Buffer.concat(b).subarray(0, KEPT).toString("utf8");
  return { applied, out: text(kept.stdout), err: text(kept.stderr) };
}

/**
 * The version a host's executable gives (`--version`, 5 seconds): its first line, at most 80
 * characters; undefined when it does not run or does not end well. A host is found only when
 * this answers (06 §3.3 item 1).
 */
export async function hostVersion(
  exe: string,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs = PROBE_TIMEOUT_MS,
  stop?: AbortSignal,
): Promise<string | undefined> {
  const r = await hostOutput([exe, "--version"], env, timeoutMs, stop);
  if (r.applied.kind !== "done") return undefined;
  return Array.from((r.out.split("\n")[0] ?? "").trim())
    .slice(0, 80)
    .join("");
}

/**
 * Whether the host has an entry named `saveslot` (its own look-up command, `mcp get saveslot`):
 * `yes` with what the command printed (looked at by the caller, never shown: it may hold the
 * token), `no` when it ends with another status, `unknown` when it does not end at all.
 */
export async function hostEntry(
  exe: string,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs = PROBE_TIMEOUT_MS,
  stop?: AbortSignal,
): Promise<{ readonly kind: "yes"; readonly out: string } | { readonly kind: "no" | "unknown" }> {
  const r = await hostOutput([exe, "mcp", "get", "saveslot"], env, timeoutMs, stop);
  // Both streams: a host may print its entry on either.
  if (r.applied.kind === "done") return { kind: "yes", out: `${r.out}\n${r.err}` };
  return r.applied.kind === "exit" ? { kind: "no" } : { kind: "unknown" };
}

/** What went wrong with the host's command, said (06 §3.2, §3.3 item 8): one mapping for both. */
export function appliedWhy(ran: Applied): Static {
  switch (ran.kind) {
    case "exit":
      return TEXTS.applyExit(ran.code);
    case "signal":
      return TEXTS.applySignal;
    case "not_found":
      return TEXTS.applyGone;
    case "cannot_run":
      return TEXTS.applyCannotRun;
    case "interrupted":
      return TEXTS.applyInterrupted;
    default:
      return TEXTS.applyTimeout;
  }
}

/** The same as a stable code, for `--json` (06 §6.1). */
export function appliedReason(ran: Applied): string {
  switch (ran.kind) {
    case "exit":
      return "command_failed";
    case "signal":
      return "command_signal";
    case "timeout":
      return "command_timeout";
    case "interrupted":
      return "interrupted";
    default:
      return "cannot_run";
  }
}

/** A terminal's escape sequences (CSI and OSC, and a lone escape), taken out before reading. */
const ESCAPES = new RegExp(
  `${String.fromCodePoint(0x1b)}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${String.fromCodePoint(0x07)}${String.fromCodePoint(0x1b)}]*(?:${String.fromCodePoint(0x07)}|${String.fromCodePoint(0x1b)}\\\\)|.)`,
  "g",
);

/** What can be part of a path, for the boundaries around it: anything else ends it. */
const PATH_CHAR = /[A-Za-z0-9._\-/~+@]/;

/**
 * Whether a host's look-up output (`mcp get saveslot`, both streams) names this saveslot's path,
 * whatever its format: escape sequences taken out, then the path with no path character (a letter,
 * a digit, `.`, `_`, `-`, `/`, `~`, `+` or `@`) right before or after it. So `/usr/local/bin/saveslot-old` and
 * `/opt/usr/local/bin/saveslot` are not `/usr/local/bin/saveslot`; `(…)`, `…,` and colours around
 * it are. A path the host shows another way (a link resolved, `~`, quoted or escaped) is not seen:
 * that waits for real hosts' output. The only place that reads that output.
 */
export function entryHolds(output: string, path: string): boolean {
  if (path === "") return false;
  const text = output.replace(ESCAPES, "");
  for (let i = text.indexOf(path); i !== -1; i = text.indexOf(path, i + 1)) {
    const before = text[i - 1];
    const after = text[i + path.length];
    const free = (c: string | undefined) => c === undefined || !PATH_CHAR.test(c);
    if (free(before) && free(after)) return true;
  }
  return false;
}

/** What became of `issueAndAdd`: not usable (revoked as far as it could be), or ran. */
export type Added =
  | { readonly kind: "not_ready"; readonly checked: Exclude<Checked, { kind: "ready" }> }
  | {
      readonly kind: "ran";
      readonly checked: Extract<Checked, { kind: "ready" }>;
      readonly ran: Applied;
    };

/**
 * The one way a host is given an instance (`connect --apply`, `setup`): issued, self-checked, then
 * the host's add command run by `exe`, the token in its arguments. What follows a failure is the
 * caller's (`connect` keeps the instance, `setup` revokes it). The issue's own error is thrown.
 */
export async function issueAndAdd(o: {
  readonly session: Client;
  readonly socketPath: string;
  readonly params: ConnectionsIssueParams;
  readonly host: Host;
  readonly exe: string;
  readonly entry: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number | undefined;
  readonly stop?: AbortSignal;
}): Promise<Added> {
  const checked = await issueChecked(o.session, o.socketPath, o.params);
  if (checked.kind !== "ready") return { kind: "not_ready", checked };
  const [, ...args] = addCommand(o.host, checked.token, o.entry) as string[];
  const ran = await runHostCommand([o.exe, ...args], o.env, o.timeoutMs, undefined, o.stop);
  return { kind: "ran", checked, ran };
}
