// Every static text the service commands print (docs/zh-CN/spec/06-cli.md §3, §4.1, §6.3), here
// and nowhere else. No text holds a token or user data; paths are the user's own home.

import type { ConfigEntry, ConfigProblem } from "./config.ts";

/**
 * A call sent with no answer back (05-surfaces §11; the request key, 04-contract §14): what to do
 * when whether it was carried out is not known.
 */
const UNKNOWN_OUTCOME =
  "whether the call was carried out is not known. Sending the same call again, as it was, is safe: a write already carried out is answered as a replay, not done twice. If the call had an idempotency_key, send it with that same value; do not make up a new one.";

export const TEXTS = {
  initDone: (home: string) =>
    [
      `Created ${home} (0700)`,
      "  data/          the tenant's data (PGlite); the tenant genesis written",
      "  control/       the control plane: credential hashes, tenant directory, anchors, handle keys",
      "  credentials/   the user session token (0600)",
      "  run/           the service's runtime (0700): saveslot.lock, saveslot.pid, saveslot.sock, saveslot.log",
    ].join("\n"),
  rotated: "The user session token was replaced; the old one no longer works.",
  syncedFolder: (dir: string) =>
    `Warning: ${dir} looks like a folder a sync service (iCloud Drive, Dropbox and the like) keeps; a database there can be damaged by the sync. Consider saveslot init --data-dir elsewhere.`,
  alreadyInitialized: (home: string) =>
    `error: ${home} is initialized already; nothing was changed. To replace the user session token: saveslot stop, then saveslot init --rotate-session`,
  serviceRunningForInit:
    "error: the saveslot service is running on this home; nothing was changed. Stop it first: saveslot stop",
  notInitialized: (home: string) => `error: ${home} is not initialized. Run: saveslot init`,
  initHomeMode: (path: string, mode: string, entries: number | undefined) =>
    `error: ${path} cannot be saveslot's home as it is: its mode is ${mode}, and saveslot's home must be 0700 (only you can read it). ${
      entries === 0
        ? `It is empty: chmod 700 ${path}, or remove it and let saveslot make it.`
        : entries === undefined
          ? `chmod 700 ${path} if it is meant to be saveslot's home.`
          : `It already holds ${entries} ${entries === 1 ? "entry" : "entries"}: if it is meant to be saveslot's home, chmod 700 ${path}; if not, give another path with --home.`
    } Then run the command again.`,
  initLink: (path: string) =>
    `error: ${path} is a symbolic link; saveslot's home is a directory of its own. Give the directory it points to with --home, or put a directory in the link's place, then run the command again.`,
  initParent: (path: string, above: string) =>
    `error: ${path} cannot be made: ${above} is not a directory this user can write. Make ${path} yourself (mode 0700), or give another path with --home, then run the command again.`,
  initAboveLink: (path: string, above: string, why: string) =>
    `error: ${path} cannot be made: ${above} is a symbolic link that ${why}. Point it at a directory or remove it, or give another path with --home, then run the command again.`,
  initOtherUser: (path: string) =>
    `error: ${path} belongs to another user; saveslot's home is yours alone. Give another path with --home, then run the command again.`,
  initMode: (path: string, why: string) =>
    `error: ${path} cannot be used as it is: ${why}. saveslot makes its directories 0700 and its files 0600, all its own: put it right (chmod), then run the command again.`,
  initInTheWay: (path: string, code: string) =>
    `error: ${path} is in the way (${code}): saveslot makes a directory there. Move it away, then run the command again.`,
  initSubLink: (path: string) =>
    `error: ${path} is a symbolic link; saveslot keeps a directory of its own there. Put a directory in the link's place (or remove the link), then run the command again.`,
  initSubMode: (path: string, mode: string) =>
    `error: ${path} has mode ${mode}; saveslot keeps it 0700 (only you can read it): chmod 700 ${path}, then run the command again.`,
  started: (pid: number, socket: string) =>
    `saveslot service started in the background · pid ${pid} · listening on ${socket}`,
  alreadyRunning: (pid: number) => `saveslot service is running already · pid ${pid}`,
  versionMismatch: (running: string, mine: string) =>
    `error: the running saveslot service is version ${running}, this saveslot is ${mine}. Run saveslot stop, then start again.`,
  startFailed: (reason: string) =>
    `error: the saveslot service did not start (${reason}). The service log is in run/saveslot.log under the home.`,
  /** The store is of another storage format (02-architecture §8 «格式版本检查»): what to do. */
  startFormatTooOld:
    "error: the saveslot service did not start (format_too_old): the store was made by a development version of saveslot, in a storage format this one does not open and does not migrate. Initialize a new home with this version.",
  startFormatTooNew:
    "error: the saveslot service did not start (format_too_new): the store was made by a newer saveslot. Upgrade saveslot to open it.",
  startHomeUnusable: (code: string) =>
    `error: the saveslot service was not started: the home cannot be used (${code}). Check that it is a directory you can read and write, with run/ a directory in it.`,
  startTimedOut: (pid: number) =>
    `error: the saveslot service did not become ready in time; its process ${pid} is still running (it may be recovering). Check later with saveslot status; the service log is in run/saveslot.log under the home.`,
  notRunning: "saveslot service is not running.",
  stopped: (pid: number) => `saveslot service stopped (pid ${pid}).`,
  stopHint:
    "An MCP host that connects again starts it again; to stop it for good, set mcp.autostart = false or remove saveslot from the host.",
  stopUnverified:
    "error: the home's lock is held but the service does not answer on its socket (starting, or stuck); no signal was sent. Try again shortly.",
  stopPidMismatch:
    "error: the pid file does not name the process that answers on the socket; no signal was sent.",
  stopTimedOut: (pid: number) => `error: the saveslot service (pid ${pid}) did not stop in time.`,
  startedAgain:
    "A saveslot service holds the home again: one was started meanwhile (an MCP host connecting starts it). See saveslot status.",
  statusNotAnswering: "saveslot service: not answering (starting, or stuck)",
  statusNotRunning: "saveslot service: not running",
  statusLastFailure: (reason: string, at: string) =>
    `  the last start failed: ${reason} at ${at}. The service log is in run/saveslot.log under the home.`,
  status: (s: {
    readonly state: string;
    readonly reason: string | undefined;
    readonly version: string;
    readonly mine: string;
    readonly pid: number;
    readonly since: string;
    /** The test clock's moment, when the service runs on one. */
    readonly evalClock?: string;
    readonly home: string;
    readonly data: string | undefined;
    readonly socket: string;
    readonly pending: number | undefined;
    readonly lock: boolean;
    /** How far this computer's clock is behind the log's end, when it is by more than the limit. */
    readonly behindMs: number | undefined;
    readonly logEnd: string | undefined;
  }) =>
    [
      ...(s.evalClock !== undefined
        ? [`eval clock: ${s.evalClock} (not the system clock: an evaluation run)`]
        : []),
      `saveslot service: ${s.state}${s.reason !== undefined ? ` (${s.reason})` : ""}`,
      `  version   ${s.version} (this saveslot: ${s.mine})`,
      `  pid       ${s.pid}, since ${s.since}`,
      ...(s.lock ? [`  lock      the home's single-writer lock, held by pid ${s.pid}`] : []),
      `  home      ${s.home}`,
      `  data      ${s.data ?? "unknown"}`,
      `  socket    ${s.socket}`,
      `  pending   ${s.pending === undefined ? "unknown" : s.pending}`,
      ...(s.behindMs !== undefined
        ? [
            `warning: this computer's clock is ${Math.floor(s.behindMs / 60_000)} minutes behind the log's last record (${s.logEnd}). New events are recorded at that time until the clock catches up; check the system clock.`,
          ]
        : []),
    ].join("\n"),
  usage: (message: string) => `error: ${message}`,
  /** `--help` of each service command (06 §4.1, §4.2): what it does and its options. */
  commandHelp: {
    init: "usage: saveslot init [--data-dir <dir>] [--rotate-session]\n  create the saveslot home (the service's files and the user session); --rotate-session issues a new session token",
    start:
      "usage: saveslot start [--foreground]\n  start the local saveslot service in the background (--foreground: in this terminal)",
    stop: "usage: saveslot stop\n  stop the local saveslot service; an MCP host that connects again starts it again",
    status:
      "usage: saveslot status\n  whether the local saveslot service runs, its version, home, socket and open pending items",
    config: "usage: saveslot config get [<key>]\n  every setting in effect and where it comes from",
    mcp: "usage: saveslot mcp [--record <dir>]\n  the stdio bridge an MCP host runs; needs SAVESLOT_TOKEN (a token from saveslot connect)",
  },

  // The configuration (`config.toml`): keys, lines and limits, never a value from the file.
  configInvalid: "error: config.toml under the home is not valid; nothing was started.",
  configProblem: (p: ConfigProblem): string => {
    switch (p.kind) {
      case "not_utf8":
        return "  the file is not UTF-8";
      case "not_toml":
        return p.line !== undefined
          ? `  the file is not valid TOML (line ${p.line})`
          : "  the file is not valid TOML";
      case "unknown_key":
        return `  ${p.key}: not a key saveslot knows`;
      case "unsupported_key":
        return `  ${p.key}: not supported in this version; remove it to use the default`;
      case "not_integer":
        return `  ${p.key}: must be a whole number, at least ${p.min}`;
      case "out_of_range":
        return `  ${p.key}: must be at least ${p.min} and at most ${p.max}`;
      case "not_boolean":
        return `  ${p.key}: must be true or false`;
    }
  },
  configEntry: (e: ConfigEntry): string =>
    `${e.key} = ${e.value}  (${e.source === "file" ? "config.toml" : "default"}${e.used ? "" : "; not in use in this version"})`,
  configSetNotYet:
    "error: saveslot config set is not in this version; edit config.toml under the home, then restart the service.",
  configUnknownKey: (key: string) => `error: ${key} is not a key saveslot knows`,

  // `saveslot mcp`: stderr gets event names and reason codes only; the error texts go to the host
  // in JSON-RPC errors. None holds a token, a path, or anything of a request or an answer.
  mcpNoToken:
    "saveslot mcp: no_token: SAVESLOT_TOKEN must be a connection instance token (slt_…). Issue one with saveslot connect.",
  mcpEvent: (event: string) => `saveslot mcp: ${event}`,
  mcpVersionMismatch:
    "saveslot mcp: version_mismatch: the running saveslot service is another version; restart it (saveslot stop, then saveslot start).",
  /** The call did not reach the service: nothing of it was written. */
  mcpNotDelivered: (autostart: boolean) =>
    `saveslot service is not running; this call did not reach it, and nothing was written. ${
      autostart
        ? "Start it with saveslot start; the host starts it again when it reconnects."
        : "Start it with saveslot start (automatic start is off: mcp.autostart = false)."
    }`,
  /** The connection was cut after the call was sent: whether it took effect is not known. */
  mcpOutcomeUnknown: `The connection to the saveslot service was lost after the call was sent: ${UNKNOWN_OUTCOME} Check saveslot status if this repeats.`,
  mcpUnavailable:
    "saveslot service is not available right now (starting or stopping). Try again shortly.",
  mcpServiceFailed:
    "saveslot service failed to start. See saveslot status; the service log is in run/saveslot.log under the home.",
  mcpTimedOut: `saveslot service did not answer in time: ${UNKNOWN_OUTCOME}`,
  mcpInternal: "saveslot mcp could not pass on the service's answer.",
  mcpRefused: (code: "unauthenticated" | "insufficient_scope") =>
    code === "unauthenticated"
      ? "unauthenticated: the token is not valid (revoked, or not this saveslot's). Issue a new one with saveslot connect and update the host."
      : "insufficient_scope: this connection instance has no scope for that. Issue one with the scope needed with saveslot connect.",
  mcpParseError: "Parse error: the line is not JSON.",
  mcpInvalidRequest: "Invalid Request: a line is a JSON-RPC object or a batch.",
  mcpLineTooLong: "Invalid Request: the line is longer than 1 MiB.",
} as const;
