// `saveslot doctor` (06-cli §3 step 7, §4.1): each check passes, fails with its fix, or reminds;
// 9 only for a failure. On homes made here, a start-at-login job of a system the test makes (no
// launchctl, no systemctl), and a service run in this process.

import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalHome, sessionFile } from "@fluxvita/saveslot-service";
import { osFileLock } from "@fluxvita/saveslot-store-pglite";
import { afterAll, describe, expect, it } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import { installAutostart, type System } from "./autostart.ts";
import { doctor, type Finding, findings } from "./doctor.ts";
import { daemonVersion } from "./main.ts";
import { runService } from "./service.ts";
import { TEXTS } from "./texts.ts";

const root = mkdtempSync(join(tmpdir(), "saveslot-doctor-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

function system(platform: NodeJS.Platform = "darwin"): System {
  const userHome = join(root, `u${++n}`);
  mkdirSync(userHome);
  return { platform, userHome, uid: 501, env: {}, run: async () => ({ code: 0 }) };
}

async function initialized(o: { dataDir?: string } = {}): Promise<string> {
  const home = join(root, `h${++n}`);
  await initLocalHome({
    home,
    backend: testBackend(),
    lock: osFileLock,
    now: new Date().toISOString(),
    ...(o.dataDir !== undefined ? { dataDir: o.dataDir } : {}),
  });
  return home;
}

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
    const data = join(root, `d${++n}`);
    const moved = await initialized({ dataDir: data });
    renameSync(data, `${data}-moved`);
    expect(by(await findings(moved, system()), "data directory")[0]).toMatchObject({
      verdict: "fail",
      fix: TEXTS.doctorDataMissingFix,
    });
    const box = join(root, `s${++n}`, "Dropbox");
    mkdirSync(box, { recursive: true });
    const synced = join(box, "saveslot-data");
    const home = await initialized({ dataDir: synced });
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

  it("a platform with no local service: no start-at-login line", async () => {
    const home = await initialized();
    expect(by(await findings(home, system("win32")), "start at login")).toEqual([]);
  }, 60_000);
});

describe("doctor with the service", () => {
  it("ready, this version, holding the lock; the clock behind is a reminder, not a failure (0)", async () => {
    const home = await initialized();
    const s = await runService({ home, version: daemonVersion(), signals: false, log: () => {} });
    try {
      const all = await findings(home, system());
      expect(verdicts(all)).toMatchObject({
        service: "pass",
        version: "pass",
        lock: "pass",
        clock: "pass",
        "data scale": "pass",
      });
      // The log's end 10 minutes ahead of this clock.
      const out: string[] = [];
      const code = await doctor(home, { out: (l) => out.push(l), err: () => {} }, system(), {
        now: () => Date.now() - 10 * 60_000,
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
