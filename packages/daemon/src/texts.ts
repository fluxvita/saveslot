// Every static text the service commands print (docs/zh-CN/spec/06-cli.md §3, §4.1, §6.3), here
// and nowhere else. No text holds a token or user data; paths are the user's own home.

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
  started: (pid: number, socket: string) =>
    `saveslot service started in the background · pid ${pid} · listening on ${socket}`,
  alreadyRunning: (pid: number) => `saveslot service is running already · pid ${pid}`,
  versionMismatch: (running: string, mine: string) =>
    `error: the running saveslot service is version ${running}, this saveslot is ${mine}. Run saveslot stop, then start again.`,
  startFailed: (reason: string) =>
    `error: the saveslot service did not start (${reason}). The service log is in run/saveslot.log under the home.`,
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
  status: (s: {
    readonly state: string;
    readonly reason: string | undefined;
    readonly version: string;
    readonly mine: string;
    readonly pid: number;
    readonly since: string;
    readonly home: string;
    readonly data: string | undefined;
    readonly socket: string;
    readonly pending: number | undefined;
  }) =>
    [
      `saveslot service: ${s.state}${s.reason !== undefined ? ` (${s.reason})` : ""}`,
      `  version   ${s.version} (this saveslot: ${s.mine})`,
      `  pid       ${s.pid}, since ${s.since}`,
      `  home      ${s.home}`,
      `  data      ${s.data ?? "unknown"}`,
      `  socket    ${s.socket}`,
      `  pending   ${s.pending === undefined ? "unknown" : s.pending}`,
    ].join("\n"),
  usage: (message: string) => `error: ${message}`,
} as const;
