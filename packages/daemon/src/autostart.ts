// `saveslot service install` / `uninstall` (docs/zh-CN/spec/06-cli.md §3 step 3, §4.1): starting
// the saveslot service at login. macOS: a launchd agent of the user
// (`~/Library/LaunchAgents/com.fluxvita.saveslot.plist`, in `gui/<uid>`). Linux: a systemd user
// service (`$XDG_CONFIG_HOME/systemd/user/saveslot.service`, default `~/.config`). No other
// platform runs the local service.
//
// The job runs the service in the foreground with `--supervised` (./main.ts): it exits non-zero
// only when it failed after it was ready (02-architecture §7: the DB Worker exiting), and is
// started again then (launchd `KeepAlive.SuccessfulExit = false`, systemd `Restart=on-failure`).
// A service that failed before it served (another process holds the home's lock, as when one was
// started by hand or by an MCP bridge; config.toml refused; the data directory gone; …) exits 0,
// and so does one stopped (`saveslot stop`): neither is started again. Starts are bounded on
// systemd too (`StartLimitIntervalSec=60`, `StartLimitBurst=5`, systemd.unit(5): at most 5 starts
// in 60 s, then the unit is left failed; systemd's own default is 5 in 10 s, which a restart every
// 5 s never reaches); launchd throttles a job by itself (10 s between starts, launchd.plist(5)).
//
// `install` writes the file (a second install replaces it: the paths of a newer Node or saveslot)
// and loads it, which starts the service unless one runs already; the home must be initialized.
// `uninstall` unloads it, which stops the service the job started, and removes the file. The
// commands are run through `System.run`; tests give their own and never run launchctl or
// systemctl.

import { realpathSync } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runsLowMemory } from "./low-memory.ts";
import { TEXTS } from "./texts.ts";

/** The launchd label, and the systemd unit's name. */
export const AUTOSTART_LABEL = "com.fluxvita.saveslot";
export const AUTOSTART_UNIT = "saveslot.service";

/** What a command run gave back: its exit code (`undefined`: it could not be run). */
export interface RunResult {
  readonly code: number | undefined;
}

/** The parts of the system `install` and `uninstall` use. */
export interface System {
  readonly platform: NodeJS.Platform;
  /** The user's home directory (not saveslot's). */
  readonly userHome: string;
  readonly uid: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly run: (command: string, args: readonly string[]) => Promise<RunResult>;
}

/** The service's command line as the job runs it, and where the job writes what Node prints. */
export interface Job {
  /** The program and its arguments: Node, its options, the service's entry, `--home` and so on. */
  readonly argv: readonly string[];
  /** The service's log (`run/saveslot.log`): what Node itself writes on a crash goes there too. */
  readonly log: string;
}

export interface AutostartIO {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Where the job's file is on this platform; undefined: no local service here. */
export function autostartFile(sys: System): string | undefined {
  if (sys.platform === "darwin") {
    return join(sys.userHome, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`);
  }
  if (sys.platform === "linux") {
    const config = sys.env["XDG_CONFIG_HOME"];
    const base = config?.startsWith("/") ? config : join(sys.userHome, ".config");
    return join(base, "systemd", "user", AUTOSTART_UNIT);
  }
  return undefined;
}

const xml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** The launchd agent's property list. */
export function launchdPlist(job: Job): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${AUTOSTART_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...job.argv.map((a) => `    <string>${xml(a)}</string>`),
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(job.log)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(job.log)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/**
 * One argument of `ExecStart=`, quoted (systemd.syntax "Quoting"; systemd.unit "Specifiers",
 * systemd.service "Command lines"): `\` and `"` escaped, `%` and `$` doubled.
 */
const unitArg = (s: string) =>
  `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$$$")}"`;

/** The systemd user service. What Node prints goes to the journal. */
export function systemdUnit(job: Job): string {
  return [
    "[Unit]",
    "Description=saveslot (the local saveslot service)",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${job.argv.map(unitArg).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** The log file, made 0600 if it is not there, so that launchd does not make it readable. */
async function ensureLog(log: string): Promise<void> {
  await mkdir(dirname(log), { recursive: true, mode: 0o700 });
  const f = await open(log, "a", 0o600);
  await f.close();
}

export async function installAutostart(job: Job, io: AutostartIO, sys: System): Promise<number> {
  const file = autostartFile(sys);
  if (file === undefined) {
    io.err(TEXTS.autostartPlatform);
    return 1;
  }
  await mkdir(dirname(file), { recursive: true });
  if (sys.platform === "darwin") {
    await ensureLog(job.log);
    await writeFile(file, launchdPlist(job), { mode: 0o644 });
    const domain = `gui/${sys.uid}`;
    // Loaded already (a second install): unloaded first, or bootstrap refuses it.
    await sys.run("launchctl", ["bootout", `${domain}/${AUTOSTART_LABEL}`]);
    const r = await sys.run("launchctl", ["bootstrap", domain, file]);
    if (r.code !== 0) {
      await rm(file, { force: true });
      io.err(TEXTS.autostartFailed("launchctl bootstrap", r.code));
      return 1;
    }
  } else {
    await writeFile(file, systemdUnit(job), { mode: 0o644 });
    for (const args of [
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", AUTOSTART_UNIT],
    ]) {
      const r = await sys.run("systemctl", args);
      if (r.code !== 0) {
        await rm(file, { force: true });
        await sys.run("systemctl", ["--user", "daemon-reload"]);
        io.err(TEXTS.autostartFailed(`systemctl ${args.join(" ")}`, r.code));
        return 1;
      }
    }
  }
  io.out(TEXTS.autostartInstalled(file, sys.platform === "darwin" ? "launchd" : "systemd"));
  return 0;
}

export async function uninstallAutostart(io: AutostartIO, sys: System): Promise<number> {
  const file = autostartFile(sys);
  if (file === undefined) {
    io.err(TEXTS.autostartPlatform);
    return 1;
  }
  const there = await open(file, "r").then(
    async (f) => {
      await f.close();
      return true;
    },
    () => false,
  );
  if (!there) {
    io.out(TEXTS.autostartNotInstalled(file));
    return 0;
  }
  if (sys.platform === "darwin") {
    // Not loaded (logged in again since a failed load, say): nothing to unload, not a failure.
    await sys.run("launchctl", ["bootout", `gui/${sys.uid}/${AUTOSTART_LABEL}`]);
    await rm(file, { force: true });
  } else {
    const r = await sys.run("systemctl", ["--user", "disable", "--now", AUTOSTART_UNIT]);
    if (r.code !== 0) {
      io.err(TEXTS.autostartFailed("systemctl --user disable --now", r.code));
      return 1;
    }
    await rm(file, { force: true });
    await sys.run("systemctl", ["--user", "daemon-reload"]);
  }
  io.out(TEXTS.autostartRemoved(file));
  return 0;
}
/**
 * Where a package manager keeps a `node` that stays when Node is upgraded: Homebrew (Apple silicon,
 * Intel, Linux) and the system. A fixed list, PATH not read: a tool may put a directory on PATH
 * that lives only as long as the shell (fnm's), and the job would outlive it.
 */
export const STABLE_NODE_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/home/linuxbrew/.linuxbrew/bin",
  "/usr/bin",
  "/bin",
] as const;

/**
 * The Node to write into the job: a path that stays when Node is upgraded, when there is one for
 * this very Node. A package manager keeps each version under a path of its own (Homebrew's
 * `Cellar/node/<version>/bin/node`), gone after an upgrade, and links a stable one to it
 * (`/opt/homebrew/bin/node`): the first `node` in `STABLE_NODE_DIRS` whose real path is this
 * process's. None: this process's path, as before.
 */
export function stableNode(exec: string, real: (p: string) => string = realpathSync): string {
  let self: string;
  try {
    self = real(exec);
  } catch {
    return exec;
  }
  for (const dir of STABLE_NODE_DIRS) {
    const candidate = join(dir, "node");
    if (candidate === exec) return exec;
    try {
      if (real(candidate) === self) return candidate;
    } catch {
      // Not there.
    }
  }
  return exec;
}

/** The text of a `<string>` as `launchdPlist` escaped it. */
const unxml = (s: string) =>
  s
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** One `ExecStart=` argument as `unitArg` quoted it. */
const ununit = (s: string) => s.replace(/\\(.)/g, "$1").replaceAll("%%", "%").replaceAll("$$", "$");

/**
 * The job's file and the programs its command line runs (Node, and the service's entry: the first
 * argument after Node that is not an option), as written there, and whether Node's options before
 * the entry turn the low-memory setting on; undefined when there is no file.
 * A file of another form gives no paths, and its check passes on nothing: `install` writes it anew.
 */
export async function jobProgram(
  sys: System,
): Promise<
  | { readonly file: string; readonly paths: readonly string[]; readonly lowMemory: boolean }
  | undefined
> {
  const file = autostartFile(sys);
  if (file === undefined) return undefined;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  let argv: string[] = [];
  if (sys.platform === "darwin") {
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
    argv = [...array.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1] as string));
  } else {
    const line = /^ExecStart=(.*)$/m.exec(text)?.[1] ?? "";
    argv = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => ununit(m[1] as string));
  }
  const [node, ...rest] = argv;
  const at = rest.findIndex((a) => !a.startsWith("-"));
  const entry = at === -1 ? undefined : rest[at];
  return {
    file,
    paths: [node, entry].filter((p): p is string => p !== undefined),
    // Node's own options are those before the entry (./low-memory.ts).
    lowMemory: runsLowMemory(at === -1 ? rest : rest.slice(0, at)),
  };
}
