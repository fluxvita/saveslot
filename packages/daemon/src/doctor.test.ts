// `saveslot doctor` (06-cli §3 step 7, §4.1): each check passes, fails with its fix, or reminds;
// 9 only for a failure. On homes made here, a start-at-login job of a system the test makes (no
// launchctl, no systemctl), and a service run in this process.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalHome, sessionFile } from "@fluxvita/saveslot-service";
import { osFileLock } from "@fluxvita/saveslot-store-pglite";
import { afterAll, describe, expect, it, vi } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import { installAutostart, type System } from "./autostart.ts";
import { doctor, type Finding, findings } from "./doctor.ts";
import { homeTemplate } from "./home-copy.fixture.ts";
import { daemonVersion } from "./main.ts";
import { withSession } from "./probes.ts";
import { NODE_FLOOR_TEXT, nodeSupported } from "./runtime.ts";
import { runService } from "./service.ts";
import { TEXTS } from "./texts.ts";

// Each home holds a store (some 40 MB in a thousand files), removed synchronously at the end:
// under the load of other runs that takes more than the default 10 seconds, as in start.test.ts.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const root = mkdtempSync(join(tmpdir(), "saveslot-doctor-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

function system(platform: NodeJS.Platform = "darwin"): System {
  const userHome = join(root, `u${++n}`);
  mkdirSync(userHome);
  return { platform, userHome, uid: 501, env: {}, run: async () => ({ code: 0 }) };
}

/** A home as `saveslot init` makes it, made once; each case takes a copy (home-copy.fixture.ts). */
const template = homeTemplate(join(root, "template"), (home) =>
  initLocalHome({ home, backend: testBackend(), lock: osFileLock, now: new Date().toISOString() }),
);

/** An initialized home of the case's own: a copy of the template. */
function initialized(): Promise<string> {
  return template.copy(join(root, `h${++n}`));
}

/**
 * One initialized home for the cases that only read it (no service started, nothing changed in
 * it): made once, on first use.
 */
let sharedHome: Promise<string> | undefined;
const shared = (): Promise<string> => {
  sharedHome ??= initialized();
  return sharedHome;
};

const by = (all: readonly Finding[], item: string) => all.filter((f) => f.item === item);
const verdicts = (all: readonly Finding[]) =>
  Object.fromEntries(all.map((f) => [f.item, f.verdict]));

describe("doctor without a service", () => {
  it("a home that is not there: that one failure, to init; 9", async () => {
    const out: string[] = [];
    const home = join(root, "none");
    expect(await doctor(home, { out: (l) => out.push(l), err: () => {} }, system())).toBe(9);
    expect(out[0]).toBe(
      TEXTS.doctorLine("fail", "home", `${home} is not initialized. Run: saveslot init`),
    );
    expect(out[1]).toBe(TEXTS.doctorFix("saveslot init"));
    expect(out).toHaveLength(3);
  });

  it("initialized, not started: the files pass, run/ not there yet is fine; the service fails; reminders skipped", async () => {
    const home = await initialized();
    const all = await findings(home, system());
    expect(verdicts(all)).toEqual({
      home: "pass",
      credentials: "pass",
      "run directory": "pass",
      "data directory": "pass",
      runtime: nodeSupported(process.versions.node) ? "pass" : "fail",
      service: "fail",
      "start at login": "skipped",
      "clock, data scale": "skipped",
    });
    expect(by(all, "service")[0]?.fix).toBe("saveslot start");
  }, 60_000);

  it("the session file open to others, run/ 0755, the home 0750: each fails with its fix", async () => {
    const home = await initialized();
    chmodSync(sessionFile(home), 0o644);
    mkdirSync(join(home, "run"), { recursive: true });
    chmodSync(join(home, "run"), 0o755);
    chmodSync(home, 0o750);
    try {
      const all = await findings(home, system());
      expect(by(all, "home")[0]).toMatchObject({
        verdict: "fail",
        fix: TEXTS.doctorChmod(home, "700"),
      });
      expect(by(all, "credentials")[0]?.verdict).toBe("fail");
      expect(by(all, "credentials")[0]?.says).toContain("644");
      expect(by(all, "run directory")[0]).toMatchObject({
        verdict: "fail",
        fix: TEXTS.doctorChmod(join(home, "run"), "700"),
      });
    } finally {
      chmodSync(home, 0o700);
    }
  }, 60_000);

  it("the data directory moved away, or in a synced folder: fails", async () => {
    const moved = await initialized();
    renameSync(join(moved, "data"), join(moved, "data-moved"));
    expect(by(await findings(moved, system()), "data directory")[0]).toMatchObject({
      verdict: "fail",
      fix: TEXTS.doctorDataMissingFix,
    });
    const box = join(root, `s${++n}`, "Dropbox");
    mkdirSync(box, { recursive: true });
    const synced = join(box, "saveslot-data");
    const home = await initialized();
    // As `saveslot init --data-dir` records a data directory elsewhere (local-tenant.ts).
    renameSync(join(home, "data"), synced);
    const tenant = join(home, "control", "tenant.json");
    writeFileSync(
      tenant,
      JSON.stringify({ ...JSON.parse(readFileSync(tenant, "utf8")), data_dir: synced }),
    );
    expect(by(await findings(home, system()), "data directory")[0]).toMatchObject({
      verdict: "fail",
      fix: TEXTS.doctorSyncedFix,
    });
  }, 60_000);

  it("a start-at-login job: passes while its programs are there, fails once one is gone (both platforms)", async () => {
    const home = await initialized();
    for (const platform of ["darwin", "linux"] as const) {
      const sys = system(platform);
      const entry = join(root, `entry${++n}.js`);
      writeFileSync(entry, "");
      const job = (node: string) => ({
        argv: [node, "--conditions=source", entry, "--home", home, "--supervised"],
        log: join(root, `log${n}`),
      });
      await installAutostart(job(process.execPath), { out: () => {}, err: () => {} }, sys);
      expect(by(await findings(home, sys), "start at login")[0]?.verdict).toBe("pass");
      const gone = join(root, `no-node-${n}`);
      await installAutostart(job(gone), { out: () => {}, err: () => {} }, sys);
      const f = by(await findings(home, sys), "start at login")[0];
      expect(f).toMatchObject({ verdict: "fail", fix: "saveslot service install" });
      expect(f?.says).toContain(gone);
      expect(f?.says).not.toContain(entry);
    }
  }, 60_000);

  it("the runtime: this Node passes; one below the floor fails, to upgrade", async () => {
    const home = await shared();
    expect(by(await findings(home, system()), "runtime")[0]?.verdict).toBe(
      nodeSupported(process.versions.node) ? "pass" : "fail",
    );
    const old = by(await findings(home, system(), { node: "24.14.0" }), "runtime")[0];
    expect(old).toMatchObject({ verdict: "fail", fix: TEXTS.doctorNodeFix(NODE_FLOOR_TEXT) });
    expect(old?.says).toContain("Node 24.14.0");
  }, 60_000);

  it("a start-at-login job whose Node is below the floor: fails, to install Node and the job anew", async () => {
    const home = await shared();
    const sys = system("darwin");
    const old = join(root, `old-node-${++n}`);
    writeFileSync(old, "#!/bin/sh\necho v24.14.0\n", { mode: 0o755 });
    const entry = join(root, `entry${n}.js`);
    writeFileSync(entry, "");
    await installAutostart(
      { argv: [old, entry, "--home", home, "--supervised"], log: join(root, `log${n}`) },
      { out: () => {}, err: () => {} },
      sys,
    );
    const f = by(await findings(home, sys), "start at login")[0];
    expect(f).toMatchObject({ verdict: "fail", fix: TEXTS.doctorJobNodeFix(NODE_FLOOR_TEXT) });
    expect(f?.says).toContain("Node 24.14.0");
  }, 60_000);

  it("a platform with no local service: no start-at-login line", async () => {
    const home = await shared();
    expect(by(await findings(home, system("win32")), "start at login")).toEqual([]);
  }, 60_000);
});

describe("doctor's hosts, from the entry package", () => {
  it("their lines come after the start at login, as given", async () => {
    const home = await shared();
    const all = await findings(home, system(), {
      hosts: async () => [{ verdict: "remind", item: "host Codex", says: "x", fix: "y" }],
    });
    const items = all.map((f) => f.item);
    expect(items.indexOf("host Codex")).toBe(items.indexOf("start at login") + 1);
  }, 60_000);

  it("told the service is not ready when it is not running: its reads are not asked for", async () => {
    const home = await shared();
    const ready: boolean[] = [];
    await findings(home, system(), {
      hosts: async (_, r) => {
        ready.push(r);
        return [];
      },
    });
    expect(ready).toEqual([false]);
  }, 60_000);
});

describe("doctor with the service", () => {
  it("ready, this version, holding the lock; the clock behind is a reminder, not a failure (0)", async () => {
    const home = await initialized();
    const lines: string[] = [];
    const s = await runService({
      home,
      version: daemonVersion(),
      signals: false,
      log: (l) => lines.push(l),
    });
    try {
      // The start says the Node it runs on.
      expect(lines.some((l) => l.endsWith(` runtime node=${process.versions.node}`))).toBe(true);
      const ready: boolean[] = [];
      const all = await findings(home, system(), {
        hosts: async (_, r) => {
          ready.push(r);
          return [];
        },
      });
      // The hosts are told the service is ready: their reads may be asked for.
      expect(ready).toEqual([true]);
      expect(verdicts(all)).toMatchObject({
        service: "pass",
        version: "pass",
        lock: "pass",
        clock: "pass",
        data: "pass",
        "data scale": "pass",
      });
      // The start just made is on record; once its record is gone, doctor says so.
      expect(by(all, "data")[0]?.says).toMatch(
        /^the log's end at #\d+; the data directory \d+\.\d MiB; the last cold start \d+\.\d s \(\d{4}-/,
      );
      rmSync(join(home, "run", "last-start.json"));
      expect(by(await findings(home, system()), "data")[0]?.says).toContain(
        "no record of a cold start",
      );
      // The log's end 10 minutes ahead of this clock. Taken from the home: a copy's last event
      // is the template's, made before the case ran.
      const end = (await withSession(home, "/v1/log/end")) as { recorded_at: string };
      const out: string[] = [];
      const code = await doctor(home, { out: (l) => out.push(l), err: () => {} }, system(), {
        now: () => Date.parse(end.recorded_at) - 10 * 60_000,
      });
      expect(code).toBe(0);
      expect(out.join("\n")).toMatch(
        /remind {2}clock: this computer's clock is (9|10) minutes behind/,
      );
      expect(out.at(-1)).toBe(TEXTS.doctorSummary(0, 1));
    } finally {
      await s.stop();
    }
  }, 60_000);

  it("another version answering: fails, to restart; 9", async () => {
    const home = await initialized();
    const s = await runService({ home, version: "0.0.0-other", signals: false, log: () => {} });
    try {
      const out: string[] = [];
      expect(await doctor(home, { out: (l) => out.push(l), err: () => {} }, system())).toBe(9);
      expect(out).toContain(
        TEXTS.doctorLine("fail", "version", TEXTS.doctorVersion("0.0.0-other", daemonVersion())),
      );
      expect(out).toContain(TEXTS.doctorFix(TEXTS.doctorVersionFix));
    } finally {
      await s.stop();
    }
  }, 60_000);

  it("the pid file naming another process: the lock check fails", async () => {
    const home = await initialized();
    const s = await runService({ home, version: daemonVersion(), signals: false, log: () => {} });
    try {
      writeFileSync(join(home, "run", "saveslot.pid"), "1\n");
      expect(by(await findings(home, system()), "lock")[0]?.verdict).toBe("fail");
    } finally {
      await s.stop();
    }
  }, 60_000);
});
