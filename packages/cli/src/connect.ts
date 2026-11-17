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
import { SCOPES, type Scope } from "@fluxvita/saveslot-client";
import { showable } from "./render/text.ts";
import { TEXTS } from "./texts.ts";
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

/** The hosts with a command to add saveslot: the ones `--apply` can run. */
export const APPLIES: ReadonlySet<Host> = new Set<Host>(["claude-code", "codex"]);

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

const DEFAULT_SCOPES: readonly Scope[] = ["saveslot.read", "saveslot.write"];

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
    return ["claude", "mcp", "add", "saveslot", "--scope", "user", "-e", env, "--", entry, "mcp"];
  if (host === "codex")
    return ["codex", "mcp", "add", "saveslot", "--env", env, "--", entry, "mcp"];
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
  | { readonly kind: "timeout" };

/**
 * Runs the host's command, `argv[0]` an absolute path: no shell, in a process group of its own,
 * its output read and dropped. Done when it exits (what it left running is its own); after
 * `timeoutMs`, its whole group is killed and its output pipes closed. Never throws.
 */
export function runHostCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs = HOST_TIMEOUT_MS,
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
    child.stdout?.resume();
    child.stderr?.resume();
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {}
      done({ kind: "timeout" });
    }, timeoutMs);
    child.on("error", (e) => done(failed(e)));
    child.on("exit", (code) =>
      done(
        code === 0 ? { kind: "done" } : code === null ? { kind: "signal" } : { kind: "exit", code },
      ),
    );
  });
}
