// `saveslot service install` / `uninstall` (06-cli §4.1) on a system the test makes: the files
// written, the commands asked for and in what order, what is left when a command fails. Never
// launchctl or systemctl. Then the service with `--supervised` (./main.ts): 0 for a service that
// did not start at all, which the job would otherwise start again and again.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalHome } from "@fluxvita/saveslot-service";
import { osFileLock } from "@fluxvita/saveslot-store-pglite";
import { afterAll, describe, expect, it } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import {
  AUTOSTART_LABEL,
  installAutostart,
  type Job,
  launchdPlist,
  type System,
  systemdUnit,
  uninstallAutostart,
} from "./autostart.ts";
import { autostartCommand, serviceCommand } from "./commands.ts";
import { main, supervisedExit } from "./main.ts";
import { lockDir } from "./service.ts";

const root = mkdtempSync(join(tmpdir(), "saveslot-autostart-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

/** A system of `platform` with its own home; commands recorded, each ending with `codes`' code. */
function system(
  platform: NodeJS.Platform,
  o: { env?: Record<string, string>; codes?: Record<string, number | undefined> } = {},
) {
  const userHome = join(root, `u${++n}`);
  mkdirSync(userHome);
  const calls: string[] = [];
  const sys: System = {
    platform,
    userHome,
    uid: 501,
    env: o.env ?? {},
    run: async (command, args) => {
      const line = [command, ...args].join(" ");
      calls.push(line);
      const hit = Object.entries(o.codes ?? {}).find(([k]) => line.startsWith(k));
      return { code: hit !== undefined ? hit[1] : 0 };
    },
  };
  return { sys, calls, userHome };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

const job = (home: string): Job => ({
  argv: [
    "/opt/node/bin/node",
    "/opt/saveslot/bin.js",
    "--home",
    home,
    "--log",
    join(home, "run", "saveslot.log"),
    "--supervised",
  ],
  log: join(home, "run", "saveslot.log"),
});

describe("service install on macOS", () => {
  it("writes the launchd agent, unloads any loaded one, loads it; the log made 0600 first", async () => {
    const { sys, calls, userHome } = system("darwin");
    const home = join(root, `h${++n}`, "a & <b>");
    const o = io();
    expect(await installAutostart(job(home), o.io, sys)).toBe(0);
    const file = join(userHome, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`);
    expect(calls).toEqual([
      `launchctl bootout gui/501/${AUTOSTART_LABEL}`,
      `launchctl bootstrap gui/501 ${file}`,
    ]);
    const plist = readFileSync(file, "utf8");
    expect(plist).toBe(launchdPlist(job(home)));
    expect(plist).toContain("<string>--supervised</string>");
    expect(plist).toContain("a &amp; &lt;b&gt;");
    expect(plist).not.toContain("a & <b>");
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(statSync(job(home).log).mode & 0o777).toBe(0o600);
    expect(o.out.join("\n")).toContain(file);
    expect(o.err).toEqual([]);
    // The property list as macOS reads it.
    if (process.platform === "darwin") {
      expect(execFileSync("/usr/bin/plutil", ["-lint", file], { encoding: "utf8" })).toContain(
        "OK",
      );
    }
  });

  it("a second install replaces the file", async () => {
    const { sys, userHome } = system("darwin");
    const home = join(root, `h${++n}`);
    await installAutostart(job(home), io().io, sys);
    const other = { ...job(home), argv: ["/usr/local/bin/node", ...job(home).argv.slice(1)] };
    expect(await installAutostart(other, io().io, sys)).toBe(0);
    const file = join(userHome, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`);
    expect(readFileSync(file, "utf8")).toContain("<string>/usr/local/bin/node</string>");
  });

  it("bootstrap failing: exit 1, the file removed", async () => {
    const { sys, userHome } = system("darwin", { codes: { "launchctl bootstrap": 5 } });
    const o = io();
    expect(await installAutostart(job(join(root, `h${++n}`)), o.io, sys)).toBe(1);
    expect(existsSync(join(userHome, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`))).toBe(
      false,
    );
    expect(o.err.join("\n")).toContain("launchctl bootstrap ended with exit status 5");
  });

  it("uninstall: unloads it and removes the file; again, nothing to remove and no command", async () => {
    const { sys, calls, userHome } = system("darwin");
    await installAutostart(job(join(root, `h${++n}`)), io().io, sys);
    calls.length = 0;
    const o = io();
    expect(await uninstallAutostart(o.io, sys)).toBe(0);
    expect(calls).toEqual([`launchctl bootout gui/501/${AUTOSTART_LABEL}`]);
    expect(existsSync(join(userHome, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`))).toBe(
      false,
    );
    calls.length = 0;
    const again = io();
    expect(await uninstallAutostart(again.io, sys)).toBe(0);
    expect(calls).toEqual([]);
    expect(again.out.join("\n")).toContain("Nothing to remove");
  });
});

describe("service install on Linux", () => {
  it("writes the user service, reloads, enables it now; XDG_CONFIG_HOME when absolute", async () => {
    const config = join(root, `c${++n}`);
    const { sys, calls } = system("linux", { env: { XDG_CONFIG_HOME: config } });
    const home = join(root, `h${++n}`, 'a "b" $HOME %h \\ c');
    expect(await installAutostart(job(home), io().io, sys)).toBe(0);
    const file = join(config, "systemd", "user", "saveslot.service");
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now saveslot.service",
    ]);
    const unit = readFileSync(file, "utf8");
    expect(unit).toBe(systemdUnit(job(home)));
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toMatch(
      /\[Unit\]\n(.*\n)*StartLimitIntervalSec=60\nStartLimitBurst=5\n(.*\n)*\[Service\]/,
    );
    expect(unit).toContain('"--supervised"');
    expect(unit).toContain('a \\"b\\" $$HOME %%h \\\\ c');
  });

  it("XDG_CONFIG_HOME relative: ~/.config, as systemd reads it", async () => {
    const { sys, userHome } = system("linux", { env: { XDG_CONFIG_HOME: "rel" } });
    await installAutostart(job(join(root, `h${++n}`)), io().io, sys);
    expect(existsSync(join(userHome, ".config", "systemd", "user", "saveslot.service"))).toBe(true);
  });

  it("enable failing: exit 1, the file removed and systemd reloaded without it", async () => {
    const { sys, calls, userHome } = system("linux", {
      codes: { "systemctl --user enable": 1 },
    });
    const o = io();
    expect(await installAutostart(job(join(root, `h${++n}`)), o.io, sys)).toBe(1);
    expect(existsSync(join(userHome, ".config", "systemd", "user", "saveslot.service"))).toBe(
      false,
    );
    expect(calls.at(-1)).toBe("systemctl --user daemon-reload");
    expect(o.err.join("\n")).toContain("ended with exit status 1");
  });

  it("systemctl not there: said so, exit 1", async () => {
    const { sys } = system("linux", { codes: { systemctl: undefined } });
    const o = io();
    expect(await installAutostart(job(join(root, `h${++n}`)), o.io, sys)).toBe(1);
    expect(o.err.join("\n")).toContain("could not be run");
  });

  it("uninstall: disabled now, the file removed, reloaded; disable failing keeps the file", async () => {
    const ok = system("linux");
    await installAutostart(job(join(root, `h${++n}`)), io().io, ok.sys);
    ok.calls.length = 0;
    expect(await uninstallAutostart(io().io, ok.sys)).toBe(0);
    expect(ok.calls).toEqual([
      "systemctl --user disable --now saveslot.service",
      "systemctl --user daemon-reload",
    ]);
    const bad = system("linux", { codes: { "systemctl --user disable": 1 } });
    await installAutostart(job(join(root, `h${++n}`)), io().io, bad.sys);
    expect(await uninstallAutostart(io().io, bad.sys)).toBe(1);
    expect(existsSync(join(bad.userHome, ".config", "systemd", "user", "saveslot.service"))).toBe(
      true,
    );
  });
});

describe("service install elsewhere, and the command", () => {
  it("another platform: exit 1, nothing written, no command", async () => {
    const { sys, calls, userHome } = system("win32");
    const o = io();
    expect(await installAutostart(job(join(root, `h${++n}`)), o.io, sys)).toBe(1);
    expect(await uninstallAutostart(io().io, sys)).toBe(1);
    expect(calls).toEqual([]);
    expect(existsSync(join(userHome, "Library"))).toBe(false);
    expect(o.err.join("\n")).toContain("macOS and Linux only");
  });

  it("install needs an initialized home (exit 5, nothing written); the job runs it supervised", async () => {
    const { sys, calls, userHome } = system("darwin");
    const home = join(root, `h${++n}`);
    const none = io();
    expect(await autostartCommand(home, ["install"], none.io, sys)).toBe(5);
    expect(calls).toEqual([]);
    expect(none.err.join("\n")).toContain("saveslot init");
    await initLocalHome({
      home,
      backend: testBackend(),
      lock: osFileLock,
      now: new Date().toISOString(),
    });
    expect(await autostartCommand(home, ["install"], io().io, sys)).toBe(0);
    const plist = readFileSync(
      join(userHome, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`),
      "utf8",
    );
    for (const a of ["--home", home, "--log", join(home, "run", "saveslot.log"), "--supervised"]) {
      expect(plist).toContain(`<string>${a}</string>`);
    }
    expect(plist).toContain(`<string>${process.execPath}</string>`);
  }, 60_000);

  it("serviceCommand takes the system it is given", async () => {
    const { sys, calls } = system("darwin");
    const home = join(root, `h${++n}`);
    expect(await serviceCommand("service", ["install", "--home", home], io().io, sys)).toBe(5);
    expect(calls).toEqual([]);
  });

  it("anything but install or uninstall: exit 2", async () => {
    const { sys, calls } = system("darwin");
    for (const args of [[], ["start"], ["install", "now"]]) {
      expect(await autostartCommand(join(root, "x"), args, io().io, sys)).toBe(2);
    }
    expect(calls).toEqual([]);
  });
});

describe("the service, supervised", () => {
  it("the exit code: as it ended, unless supervised and it never served", () => {
    // Never ready (a store refused, the data directory gone): 1 as it was, 0 supervised.
    expect([supervisedExit(1, false, false), supervisedExit(1, false, true)]).toEqual([1, 0]);
    // Failed after it was ready (the DB Worker): 1 either way; stopped: 0 either way.
    expect([supervisedExit(1, true, false), supervisedExit(1, true, true)]).toEqual([1, 1]);
    expect([supervisedExit(0, true, false), supervisedExit(0, true, true)]).toEqual([0, 0]);
  });

  it("not initialized: 1, and 0 supervised", async () => {
    const home = join(root, `none${++n}`);
    expect(await main(["--home", home])).toBe(1);
    expect(await main(["--home", home, "--supervised"])).toBe(0);
  });

  it("config.toml refused: 5, and 0 supervised", async () => {
    const home = join(root, `cfg${++n}`);
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, "config.toml"), "nope = 1\n");
    expect(await main(["--home", home])).toBe(5);
    expect(await main(["--home", home, "--supervised"])).toBe(0);
  });

  it("another process holds the home's lock: 1, and 0 supervised", async () => {
    const home = join(root, `held${++n}`);
    await initLocalHome({
      home,
      backend: testBackend(),
      lock: osFileLock,
      now: new Date().toISOString(),
    });
    mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
    const lock = await osFileLock.acquire(lockDir(home));
    try {
      expect(await main(["--home", home])).toBe(1);
      expect(await main(["--home", home, "--supervised"])).toBe(0);
    } finally {
      await lock.release();
    }
  }, 60_000);
});
