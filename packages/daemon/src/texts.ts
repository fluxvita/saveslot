// Every static text the service commands print (docs/zh-CN/spec/06-cli.md §3, §4.1, §6.3), here
// and nowhere else. No text holds a token or user data; paths are the user's own home.
//
// Words: to a person, "connection instance" (the MCP texts tell the agent of "a connection"); in a
// sentence, "the saveslot service", and "saveslot service:" only as the label of a status line.

import type { HandleKeyFileError } from "@fluxvita/saveslot-service";
import type { ConfigEntry, ConfigProblem } from "./config.ts";
import type { ServerConfigProblem } from "./server-config.ts";

/**
 * A call sent with no answer back (05-surfaces §11; the request key, 04-contract §14): what to do
 * when whether it was carried out is not known.
 */
const UNKNOWN_OUTCOME =
  "whether the call was carried out is not known. Sending the same call again, as it was, is safe: a write already carried out is answered as a replay, not done twice. If the call had an idempotency_key, send it with that same value; do not make up a new one.";

/** The settings of the deployment's fingerprint, as a refusal names them (06-cli §4.1). */
const FINGERPRINT_SETTING = {
  trusted_proxies: "SAVESLOT_TRUSTED_PROXIES",
  public_url: "SAVESLOT_PUBLIC_URL",
  allowed_origins: "SAVESLOT_ALLOWED_ORIGINS",
  identity:
    "the login (SAVESLOT_IDENTITY_*: set or not, the issuer, the login address, the key IDs)",
  handle_keys: "the key IDs in SAVESLOT_HANDLE_KEY_FILE",
  cell: "the database server of SAVESLOT_CELL_DATABASE_URL",
} as const;

export const TEXTS = {
  initDone: (home: string) =>
    [
      `Created ${home} (0700)`,
      "  data/          your records (the database files)",
      "  control/       saveslot's own keys and records of connection instances",
      "  credentials/   the user session token (0600)",
      "  run/           the service's runtime (0700): saveslot.lock, saveslot.pid, saveslot.sock, saveslot.log",
    ].join("\n"),
  rotated: "The user session token was replaced; the old one no longer works.",
  syncedFolder: (dir: string) =>
    `Warning: ${dir} looks like a folder a sync service (iCloud Drive, Dropbox and the like) keeps; a database there can be damaged by the sync. Consider saveslot init --data-dir elsewhere.`,
  alreadyInitialized: (home: string) =>
    `error: ${home} is initialized already; nothing was changed. To replace the user session token: saveslot stop, then saveslot init --rotate-session`,
  dataDirNotEmpty: (path: string) =>
    `error: the data directory ${path} is not empty; nothing was changed. saveslot init makes a new home only, with a new, empty data directory. If it is another home's data directory, keep using that home (saveslot --home <that home> …). To bring that data into a new home: saveslot --home <that home> export -o <file>; init the new home with an empty data directory; then saveslot --home <new home> import <file>.`,
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
    `The saveslot service started in the background · pid ${pid} · listening on ${socket}`,
  alreadyRunning: (pid: number) => `The saveslot service is running already · pid ${pid}`,
  versionMismatch: (running: string, mine: string) =>
    `error: the running saveslot service is version ${running}, this saveslot is ${mine}. Run saveslot stop, then start again.`,
  startFailed: (reason: string) =>
    `error: the saveslot service did not start (${reason}). The service log is in run/saveslot.log under the home.`,
  /** A data directory put elsewhere is not the user's alone (06 §3, §8.1). */
  startDataDirOpen:
    "error: the saveslot service did not start (data_dir_permissions): the data directory set with --data-dir is open to others, not yours, or a link. Make it a directory of yours with mode 0700 (chmod 700 on it; its path is data_dir in control/tenant.json under the home), then start again.",
  /** The store is of another storage format (02-architecture §8 «格式版本、导出、导入与恢复»): what to do. */
  startFormatTooOld:
    "error: the saveslot service did not start (format_too_old): the store was made by a development version of saveslot, in a storage format this one does not open and does not migrate. Initialize a new home with this version.",
  startFormatTooNew:
    "error: the saveslot service did not start (format_too_new): the store was made by a newer saveslot. Upgrade saveslot to open it.",
  /** The store's format upgraded at the start (02-architecture §8): each step, as it begins. */
  startUpgrading: (from: number, to: number, step: string | undefined) =>
    `Upgrading the store from storage format ${from} to ${to}${step !== undefined ? ` (step ${step})` : ""}; waiting for it to finish, however long it takes.`,
  /** The upgrade goes on without the backup before it (02-architecture §8): said once. */
  upgradeBackupSkipped:
    "warning: the store is upgraded without a backup (upgrade.backup = false, or --no-upgrade-backup). Once upgraded, older versions of saveslot cannot open it, and there is no copy to go back to.",
  /** The backup before an upgrade not made, or one in place of other data (02-architecture §8). */
  startUpgradeBackupFailed:
    "error: the saveslot service did not start (upgrade_failed): the backup before upgrading the store's storage format was not made, and nothing was upgraded. The service log (run/saveslot.log under the home) says why: backup=no_space (free disk space), backup=copy_failed (the copy failed; the log's code= is the error, e.g. EACCES: a directory next to the home that is not writable, ENOSPC: the disk is full), backup=link (a symbolic link inside the data directory or control/: put the file or directory itself back in its place, or skip the backup), or backup=backup_differs (a backup is already next to the home, <home>.format-<n>-backup, of other data than the store now: move it away, or go back to it first). Then start again. To upgrade without a backup, start with --no-upgrade-backup.",
  /** An upgrade that failed (02-architecture §8): what is left, and what to do. */
  startUpgradeFailed: (step: string | undefined) =>
    `error: the saveslot service did not start (upgrade_failed): upgrading the store's storage format failed${step !== undefined ? ` at step ${step}` : ""}. That step was undone; the steps before it stay done. The service log (run/saveslot.log under the home) gives the database's error code (53100: the disk is full). Deal with that (free disk space), then start again: the upgrade goes on from that step.`,
  startHomeUnusable: (code: string) =>
    `error: the saveslot service was not started: the home cannot be used (${code}). Check that it is a directory you can read and write, with run/ a directory in it.`,
  startTimedOut: (pid: number) =>
    `error: the saveslot service did not become ready in time; its process ${pid} is still running (it may be recovering). Check later with saveslot status; the service log is in run/saveslot.log under the home.`,
  notRunning: "The saveslot service is not running.",
  stopped: (pid: number) => `The saveslot service stopped (pid ${pid}).`,
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
  statusLastFailure: (reason: string, at: string, step?: string) =>
    `  the last start failed: ${reason}${step !== undefined ? ` at step ${step} of the storage format upgrade` : ""} at ${at}. The service log is in run/saveslot.log under the home.`,
  status: (s: {
    readonly state: string;
    readonly reason: string | undefined;
    /** The upgrade of the store's format, while it runs or when it failed. */
    readonly upgrade:
      | { readonly from: number; readonly to: number; readonly step?: string }
      | undefined;
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
      ...(s.upgrade !== undefined
        ? [
            `  upgrade   storage format ${s.upgrade.from} to ${s.upgrade.to}${
              s.upgrade.step !== undefined
                ? `, ${s.state === "failed" ? "failed at" : "at"} step ${s.upgrade.step}`
                : ""
            }`,
          ]
        : []),
      `  version   ${s.version} (this saveslot: ${s.mine})`,
      `  pid       ${s.pid}, since ${s.since}`,
      ...(s.lock ? [`  lock      the home's single-writer lock, held by pid ${s.pid}`] : []),
      `  home      ${s.home}`,
      `  data      ${s.data ?? "unknown"}`,
      `  socket    ${s.socket}`,
      `  pending   ${s.pending === undefined ? "unknown" : s.pending}`,
      ...(s.behindMs !== undefined
        ? [
            `warning: this computer's clock is ${Math.floor(s.behindMs / 60_000)} minutes behind the log's end (${s.logEnd}). New events are recorded at the log's end until the clock catches up; check the system clock.`,
          ]
        : []),
    ].join("\n"),
  usage: (message: string) => `error: ${message}`,
  /** `--help` of each service command (06 §4.1, §4.2): what it does and its options. */
  commandHelp: {
    init: "usage: saveslot init [--data-dir <dir>] [--rotate-session]\n  create the saveslot home (the service's files and the user session); --rotate-session issues a new session token",
    start:
      "usage: saveslot start [--foreground] [--no-upgrade-backup]\n  start the local saveslot service in the background (--foreground: in this terminal; --no-upgrade-backup: upgrade the store's storage format, when it needs it, without backing it up first)",
    stop: "usage: saveslot stop\n  stop the local saveslot service; an MCP host that connects again starts it again",
    status:
      "usage: saveslot status\n  whether the local saveslot service runs, its version, home, socket and open pending items",
    config:
      "usage: saveslot config get [<key>] | config set <key> <value>\n  every setting in effect and where it comes from; set one of read_log.flush_seconds, mcp.autostart",
    mcp: "usage: saveslot mcp [--record <dir>]\n  the stdio bridge an MCP host runs; needs SAVESLOT_TOKEN (a token from saveslot connect)",
    doctor:
      "usage: saveslot doctor\n  check the home, its credentials and run directory, the data directory, the service, its version and lock, the start at login; remind of the clock and of large tables",
    service:
      "usage: saveslot service install | uninstall\n  start the saveslot service at login (macOS: a launchd agent; Linux: a systemd user service), or no longer",
  },

  // `saveslot doctor` (06 §3 step 7, §4.1): a line a check, a fix under each failure.
  doctorLine: (verdict: "pass" | "fail" | "remind" | "skipped", item: string, says: string) =>
    `${{ pass: "pass    ", fail: "FAIL    ", remind: "remind  ", skipped: "skipped " }[verdict]}${item}: ${says}`,
  doctorFix: (fix: string) => `        fix: ${fix}`,
  doctorSummary: (failed: number, reminders: number) =>
    `${failed === 0 ? "No check failed" : `${failed} ${failed === 1 ? "check" : "checks"} failed`}; ${reminders} ${reminders === 1 ? "reminder" : "reminders"} (a reminder is not a failure).`,
  doctorMissing: (path: string) => `${path} is not there`,
  doctorChmod: (path: string, mode: string) =>
    `chmod ${mode} ${path} (it must be this user's, not a link)`,
  doctorCredentialsOk: "credentials/ 0700, the session file 0600",
  doctorCredentialsFix: (home: string) =>
    `chmod 700 ${home}/credentials and chmod 600 ${home}/credentials/session; if the session file is gone: saveslot stop, then saveslot init --rotate-session`,
  doctorRunOk: "run/ 0700: the socket and the lock are this user's only",
  doctorNodeOld: (node: string, floor: string) =>
    `Node ${node} is below what saveslot needs (${floor}): JSON.parse there can misread an escaped object key`,
  doctorNodeFix: (floor: string) => `install Node ${floor}, then run saveslot from it`,
  doctorNoTenantDirectory: "the home's tenant directory (control/tenant.json) cannot be read",
  doctorDataMissing: (dir: string) => `${dir}, the data directory the home records, is not there`,
  doctorDataMissingFix:
    "put the data directory back where the home records it (saveslot never makes a new one in its place)",
  doctorSynced: (dir: string) =>
    `${dir} looks like a folder a sync service (iCloud Drive, Dropbox and the like) keeps; a database there can be damaged by the sync`,
  doctorSyncedFix:
    "keep saveslot's data out of synced folders: a new home with saveslot init --data-dir elsewhere",
  doctorNotRunning: "the saveslot service is not running",
  doctorReady: (pid: number) => `the saveslot service is ready (pid ${pid})`,
  doctorNotReady: (state: string, reason: string | undefined) =>
    `the saveslot service is ${state}${reason !== undefined ? ` (${reason})` : ""}`,
  doctorNotReadyFix: "see saveslot status and the service log, run/saveslot.log under the home",
  doctorVersion: (running: string, mine: string) =>
    `the saveslot service running is version ${running}; this saveslot is ${mine}`,
  doctorVersionFix: "saveslot stop, then saveslot start",
  doctorLockOk: (pid: number) =>
    `the home's single-writer lock is held by the service (pid ${pid})`,
  doctorLockWrong: (pid: number, file: string | undefined) =>
    `the service (pid ${pid}) does not hold the home's single-writer lock as its pid file says (${file ?? "no pid file"})`,
  doctorLockFix: "saveslot stop, then saveslot start",
  doctorJobGone: (file: string, gone: readonly string[]) =>
    `${file} runs ${gone.join(" and ")}, which ${gone.length === 1 ? "is" : "are"} not there (a Node or saveslot moved or removed)`,
  doctorJobNodeOld: (file: string, node: string, version: string, floor: string) =>
    `${file} runs ${node}, which is Node ${version}: below what saveslot needs (${floor})`,
  doctorJobNodeFix: (floor: string) =>
    `install Node ${floor}, then run saveslot service install with it to write the job anew`,
  doctorNoJob:
    "not installed (saveslot service install); an MCP host starts the service when it connects",
  doctorNeedsService: "not checked: the saveslot service is not ready",
  doctorClockOk: "not behind the log's end",
  doctorClockBehind: (minutes: number) =>
    `this computer's clock is ${minutes} minutes behind the log's end; new events are recorded at the log's end until it catches up. Check the system clock`,
  doctorScaleUnread: "not checked: the catalog could not be read",
  doctorData: (
    seq: number | undefined,
    bytes: number | undefined,
    start: { ms: number; at: string } | undefined,
  ) =>
    [
      seq !== undefined ? `the log's end at #${seq}` : "the log's end not to be had",
      bytes !== undefined
        ? `the data directory ${(bytes / 1024 / 1024).toFixed(1)} MiB`
        : "the data directory's size not to be had",
      start !== undefined
        ? `the last cold start ${(start.ms / 1000).toFixed(1)} s (${start.at})`
        : "no record of a cold start",
    ].join("; "),
  doctorScaleOk: "every table within the comfortable line",
  doctorScale: (table: string, rows: number, level: string) =>
    `${table}: ${rows} rows, ${level === "beyond_tested" ? "beyond the largest size tested" : "over the comfortable line"}; saveslot is built for records at a person's pace: keep summaries, and the raw series where it comes from`,
  // `saveslot server …` (06 §4.1 «服务器自部署的运维命令», «服务器模式的配置»). A text names a
  // variable, never its value: a connection URL may hold a password.
  server: {
    usage:
      "usage: saveslot server init [--user <name> [--password-file <path>]] | start | restore --tenant <tenant> | --user <name> | user add|list|disable|enable|passwd",
    userUsage:
      "usage: saveslot server user add <name> [--password-file <path>] | list | disable <name> | enable <name> | passwd <name> [--password-file <path>]; with the external login: disable|enable --subject <account ID> [--issuer <issuer>]",
    userTakesName: (sub: string) => `saveslot server user ${sub} takes one account name`,
    passwordFileOnce: "--password-file takes one path, once",
    initPasswordFileWithoutUser:
      "--password-file is for the first user's password: give --user <name> with it",
    initUserOnce: "--user takes one name, once",
    userExternal:
      "error: the external login manages the accounts (SAVESLOT_IDENTITY_* are set); saveslot server init --user and every saveslot server user subcommand but disable and enable (by --subject) are for the built-in local accounts. Nothing was done",
    userSubjectLocal:
      "--subject and --issuer name an account of the external login, which is not configured (SAVESLOT_IDENTITY_* are not set); name a local account instead",
    externalDisabled: (issuer: string, subject: string) =>
      `Disabled the account ${subject} of ${issuer}: every credential of its tenant is refused until it is enabled again; nothing was revoked`,
    externalEnabled: (issuer: string, subject: string) =>
      `Enabled the account ${subject} of ${issuer}: its credentials authenticate again as they were`,
    externalUnknown: (issuer: string, subject: string) =>
      `error: there is no account ${subject} of ${issuer} (it has not signed in here yet). Nothing was done`,
    noPasswordSource:
      "error: there is no terminal to ask the password on; give --password-file <path>. Nothing was done",
    passwordFileRefused: (
      code: "missing" | "not_a_file" | "open_to_others" | "unreadable" | "empty",
    ) =>
      `error: the file --password-file names ${
        {
          missing: "is not there",
          not_a_file: "is not a regular file (a pipe is not taken)",
          open_to_others: "is open to others; take every permission from others (chmod o= on it)",
          unreadable:
            "cannot be read: give this process's user read permission, and check the path (a loop of links, a name too long, a part that is not a directory)",
          empty: "has no password on its first line",
        }[code]
      }. Nothing was done`,
    /** What a refusal says was left: nothing, or (`init --user`, after its tables) the account only. */
    nothingDone: "nothing was done",
    initAccountNotMade:
      "the handle key file and the control database's tables are in place, the account was not made: run saveslot server init --user again",
    passwordsDiffer: (after: string) => `error: the two entries differed each time; ${after}`,
    passwordInterrupted: (after: string) => `Interrupted at the password prompt; ${after}`,
    accountRefused: (
      code: "bad_name" | "bad_password" | "name_taken" | "unknown_user" | string,
      name: string,
      after: string,
    ) =>
      `error: ${
        {
          bad_name: `the name ${JSON.stringify(name)} is not one an account can have: letters a-z, digits, ".", "_", "-", a letter or digit first, 64 at most`,
          bad_password: "the password is not one an account can have: 8 to 1024 characters",
          name_taken: `an account named ${JSON.stringify(name)} is there already`,
          unknown_user: `there is no account named ${JSON.stringify(name)}`,
        }[code] ?? "the account operation was refused"
      }; ${after}`,
    userAdded: (name: string, tenant: string) => `Added the account ${name} · tenant ${tenant}`,
    userNone: "There are no local accounts; add one with saveslot server user add <name>",
    userNoTenant: "(no tenant: run saveslot server user add again)",
    userDisabled: (name: string) =>
      `Disabled the account ${name}: every credential of its tenant is refused until it is enabled again; nothing was revoked`,
    userEnabled: (name: string) =>
      `Enabled the account ${name}: its credentials authenticate again as they were`,
    passwordChanged: (name: string) =>
      `Changed the password of ${name}: its web logins and user sessions have ended; its connections are not affected`,
    initFirstUser: (name: string, tenant: string) =>
      `Made the first account, ${name} · tenant ${tenant}`,
    initAccountsExist: "There are local accounts already: no first account made",
    initAccountFinished: (name: string, tenant: string) =>
      `Finished the account ${name}, which an earlier run left without its tenant · tenant ${tenant}`,
    initNoUser: "No account made: add one with saveslot server user add <name>",
    startRefused: (
      set: "control" | "oauth" | "accounts" | "external",
      reason: "not_initialized" | "format",
    ) =>
      `error: the control database's ${{ control: "control plane", oauth: "authorization server", accounts: "local accounts", external: "external login" }[set]} tables ${
        reason === "format"
          ? "are of a format this saveslot does not know; nothing was changed"
          : "are not there; run saveslot server init first"
      }`,
    listening: (host: string, port: number) =>
      `The saveslot server listens on ${host.includes(":") ? `[${host}]` : host}:${port}`,
    stoppedCleanly: "The saveslot server has stopped",
    identityRefused: (what: string) => `error: the external login's settings: ${what}`,
    alreadyRunning:
      "error: another saveslot server is running on this control database; one server a deployment",
    configProblem: (p: ServerConfigProblem) =>
      p.kind === "missing"
        ? `error: ${p.variable} is not set`
        : `error: ${p.variable} is not valid: ${p.what}`,
    keyFileProblem: (code: HandleKeyFileError["code"]) =>
      `error: the file SAVESLOT_HANDLE_KEY_FILE names ${
        {
          missing: "is not there",
          not_a_file: "is not a file",
          open_to_others: "is open to others; take every permission from others (chmod o= on it)",
          unreadable:
            "cannot be read: give this process's user read permission, and check the path (a loop of links, a name too long, a part that is not a directory)",
          corrupt: "is not a handle key file",
        }[code]
      }`,
    keyFileNoDirectory:
      "error: the directory of SAVESLOT_HANDLE_KEY_FILE is not there; make it, then run saveslot server init again",
    keyFileMade:
      "Made the handle key file (SAVESLOT_HANDLE_KEY_FILE, 0600): keep it, and back it up",
    keyFileKept: "The handle key file (SAVESLOT_HANDLE_KEY_FILE) is there already; left as it is",
    controlUnreachable:
      "error: the control database (SAVESLOT_CONTROL_DATABASE_URL) could not be reached",
    controlLost:
      "error: the connection to the control database (SAVESLOT_CONTROL_DATABASE_URL) went away, and the server lock with it; the server has stopped (start it again)",
    controlFormat:
      "error: the control database's tables are of a format this saveslot does not know; nothing was changed",
    controlReady: "The control database's tables are in place",
    controlUpgraded: (from: number, to: number) =>
      `Upgraded the control database from format ${from} to ${to}`,
    controlUpgradeNeedsAlone:
      "error: the control database is of an older format, upgraded only while no saveslot server runs on it: stop every server, then run saveslot server start or saveslot server init. Nothing was changed",
    controlUpgradeFailed: (step: string, sqlState: string | undefined) =>
      `error: step ${step} of the control database's upgrade failed${sqlState !== undefined ? ` (SQLSTATE ${sqlState})` : ""}; the database is left at the format of its last step done, and the next start goes on from there`,
    cellUnreachable:
      "error: the database server of SAVESLOT_CELL_DATABASE_URL could not be reached to tell which it is",
    cellIdentityRefused: (sqlState: string | undefined) =>
      `error: the database server of SAVESLOT_CELL_DATABASE_URL refused to tell which it is${sqlState !== undefined ? ` (SQLSTATE ${sqlState})` : ""}: it was asked pg_control_system() on its maintenance database; check what the role may run there`,
    configDiffers: (
      differences: readonly {
        readonly item: string;
        readonly ways?: { readonly recorded: string; readonly here: string };
      }[],
    ) =>
      `error: this server's settings differ from the other servers' of this deployment: ${differences
        .map((d) =>
          d.ways === undefined
            ? FINGERPRINT_SETTING[d.item as keyof typeof FINGERPRINT_SETTING]
            : `${FINGERPRINT_SETTING.cell} (told apart by ${d.ways.here} here, by ${d.ways.recorded} for the others: give this server's database role what the others' has, or the same)`,
        )
        .join(
          "; ",
        )}. Settings every server must share are changed with every server stopped. Nothing was changed`,
    restoreTakesTenant:
      "saveslot server restore takes one of --tenant <tenant> and --user <name>, once",
    restoreUserExternal:
      "error: the external login manages the accounts (SAVESLOT_IDENTITY_* are set), so there are no account names here: name the tenant with --tenant <tenant>. Nothing was done",
    restoreNoAccount: (name: string) =>
      `error: there is no account named ${JSON.stringify(name)} (saveslot server user list gives them); nothing was done`,
    restoreAccountTenantNotMade: (name: string) =>
      `error: the tenant of the account ${JSON.stringify(name)} is not made yet: there is nothing to restore. To finish it, run saveslot server user add ${name} again (it sets the password anew); nothing was done`,
    restoringAccount: (name: string, tenant: string) =>
      `The account ${JSON.stringify(name)}'s tenant is ${tenant}`,
    restoreServerRunning:
      "error: a saveslot server is running on this control database; stop it first, then run saveslot server restore again. Nothing was done",
    restoreControlNotReady:
      "error: the control database has no tables of this saveslot, or tables of a format it does not know; nothing was done",
    restoreControlOld:
      "error: the control database is of an older format: run saveslot server start or saveslot server init first, which upgrade it. Nothing was done",
    /** A tenant's creation that waited past its turn (02-architecture §7 «连接»). */
    creatingBusy:
      "error: another tenant was being created by this process, and this one waited too long for its turn. Nothing more was done; run the command again in a moment: it finishes what was begun.",
    /** A tenant's storage format upgrade failed (02-architecture §8): never the database's message. */
    upgradeFailed: (step: string | undefined, sqlState: string | undefined) =>
      `error: upgrading a tenant's storage format failed${step !== undefined ? ` at step ${step}` : ""}${sqlState !== undefined ? ` (SQLSTATE ${sqlState})` : ""}, and the command stopped there. That step was undone; the steps before it stay done. The database's own message is not shown, since it may quote what the store holds; its SQLSTATE says what went wrong (53100: the disk is full). Deal with that, then run the command again: the upgrade goes on from that step.`,
    restoreTenantRefused: (code: "unknown_tenant" | "tenant_not_active") =>
      code === "unknown_tenant"
        ? "error: the tenant directory has no such tenant; nothing was done"
        : "error: the tenant's creation has not finished: there is nothing to restore; nothing was done",
    restoreFlowRefused: (
      code: "deletion_backfill_not_implemented" | "import_in_progress" | "log_empty",
    ) =>
      ({
        deletion_backfill_not_implemented:
          "error: the deletion registry has entries for this tenant, and this saveslot cannot yet make up deletions a restored database lacks; nothing was done",
        import_in_progress:
          "error: an import into this tenant is in progress; it must finish first. Nothing was done",
        log_empty:
          "error: the tenant's database has no log: put back the backup first. Nothing was done",
      })[code],
    restored: (
      tenant: string,
      r: { readonly restoreCount: number; readonly logEnd: number; readonly resumed: boolean },
    ) =>
      [
        r.resumed
          ? `Finished the restore of tenant ${tenant} that an earlier run began`
          : `Restored tenant ${tenant}`,
        `Its restore count is ${r.restoreCount}; its log ends at seq ${r.logEnd}. The server can be started`,
      ].join("\n"),
  },

  // `saveslot service install` / `uninstall` (06 §3 step 3, §4.1).
  autostartUsage: "saveslot service install | uninstall",
  autostartPlatform:
    "error: the local saveslot service runs on macOS and Linux only; there is nothing to install here.",
  autostartInstalled: (file: string, kind: "launchd" | "systemd") =>
    [
      `Installed ${file} (${kind === "launchd" ? "a launchd agent" : "a systemd user service"} of this user).`,
      "The saveslot service now starts at login, and again if it fails while running; it was started now unless one runs already.",
      "To remove it: saveslot service uninstall",
    ].join("\n"),
  autostartNotInstalled: (file: string) =>
    `Nothing to remove: ${file} is not there; the saveslot service is not started at login.`,
  autostartRemoved: (file: string) =>
    [
      `Removed ${file}. The saveslot service no longer starts at login; the one it had started was stopped.`,
      "An MCP host that connects starts it again (mcp.autostart); saveslot start starts it by hand.",
    ].join("\n"),
  autostartFailed: (command: string, code: number | undefined) =>
    `error: ${command} ${code === undefined ? "could not be run" : `ended with exit status ${code}`}; nothing was installed or removed.`,

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
  configUsage: "saveslot config get [<key>] | saveslot config set <key> <value>",
  configSetRefused: "error: nothing was written:",
  configSet: (key: string, value: string) => `${key} = ${value}  (written to config.toml)`,
  configCommentsDropped:
    "The comments config.toml had are not kept: saveslot writes the file anew.",
  configTakesEffectBridge:
    "It takes effect the next time an MCP host runs saveslot mcp; the service need not restart.",
  configTakesEffectRestart:
    "The saveslot service running reads it when it starts: saveslot stop, then saveslot start.",
  configTakesEffectStart: "The saveslot service reads it when it starts.",
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
    `The saveslot service is not running; this call did not reach it, and nothing was written. ${
      autostart
        ? "Start it with saveslot start; the host starts it again when it reconnects."
        : "Start it with saveslot start (automatic start is off: mcp.autostart = false)."
    }`,
  /** The connection was cut after the call was sent: whether it took effect is not known. */
  mcpOutcomeUnknown: `The connection to the saveslot service was lost after the call was sent: ${UNKNOWN_OUTCOME} Check saveslot status if this repeats.`,
  mcpUnavailable:
    "The saveslot service is not available right now (starting or stopping). Try again shortly.",
  /** Upgrading the store's format at its start (02-architecture §8): no timeout, a wait. */
  mcpUpgrading: (step: string | undefined) =>
    `The saveslot service is not available right now: it is upgrading its storage format${step !== undefined ? ` (step ${step})` : ""}, which can take minutes on a large store. Try again later; saveslot status shows how far it is.`,
  mcpServiceFailed:
    "The saveslot service failed to start. See saveslot status; the service log is in run/saveslot.log under the home.",
  mcpTimedOut: `The saveslot service did not answer in time: ${UNKNOWN_OUTCOME}`,
  mcpInternal: "saveslot mcp could not pass on the service's answer.",
  mcpRefused: (code: "unauthenticated" | "insufficient_scope") =>
    code === "unauthenticated"
      ? "unauthenticated: the token is not valid (revoked, or not this saveslot's). Issue a new one with saveslot connect and update the host."
      : "insufficient_scope: this connection instance has no scope for that. Issue one with the scope needed with saveslot connect.",
  mcpParseError: "Parse error: the line is not JSON.",
  mcpInvalidRequest: "Invalid Request: a line is a JSON-RPC object or a batch.",
  mcpLineTooLong: "Invalid Request: the line is longer than 1 MiB.",
} as const;
