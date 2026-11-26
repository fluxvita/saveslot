// The local mode's backup before a storage format upgrade (02-architecture §8 «格式版本、导出、导入与
// 恢复»): made next to the home before the first step, with the data directory and control/; a
// failure of it fails the start as upgrade_failed at step `backup` with nothing upgraded; a copy
// stopped half way leaves only `.partial`; a backup in place is reused when it is of this state and
// refused when not; skipped, the upgrade goes on and the log says there is none; and the backup is
// a home the version before the upgrade opens.

import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treeDigest, upgradeBackupDir } from "@fluxvita/saveslot-service";
import { createLocalHome } from "@fluxvita/saveslot-service/testing";
import type { PgliteBackendOptions } from "@fluxvita/saveslot-store-pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import { serviceArgs } from "./commands.ts";
import { health } from "./local-request.ts";
import { foregroundArgs, foregroundOptionsOf } from "./main.ts";
import { runService, socketFile } from "./service.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type UpgradeStep = NonNullable<PgliteBackendOptions["formatUpgrade"]>["steps"][number];

let F = 0;
const root = mkdtempSync(join(tmpdir(), "ssb-"));
const template = join(root, "t");
let n = 0;

beforeAll(async () => {
  await createLocalHome(template, testBackend());
  const s = await testBackend().open({ kind: "pglite", dir: join(template, "data") }, {});
  F = s.formatVersion;
  await s.close();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function home(): string {
  const h = join(root, `h${n++}`);
  cpSync(template, h, { recursive: true });
  chmodSync(h, 0o700);
  chmodSync(join(h, "control"), 0o700);
  for (const f of ["credentials.json", "tenant.json"]) chmodSync(join(h, "control", f), 0o600);
  return h;
}

const step = (from: number, sql: string): UpgradeStep => ({ from, sql });
const STEP = () => step(F, "CREATE TABLE up_b (x int);");

/** The service on home `h`, its store upgraded by `steps`, its log lines in `lines`. */
function service(
  h: string,
  steps: readonly UpgradeStep[],
  lines: string[],
  more: {
    upgradeBackup?: boolean;
    freeBytes?: (path: string) => number;
    afterCopy?: (path: string) => void | Promise<void>;
    beforeRename?: () => void | Promise<void>;
  } = {},
) {
  const { upgradeBackup, ...backup } = more;
  return runService({
    home: h,
    version: "t",
    signals: false,
    log: (l) => lines.push(l),
    ...(upgradeBackup !== undefined ? { upgradeBackup } : {}),
    testing: {
      backend: (o) => testBackend({ ...o, formatUpgrade: { format: F + steps.length, steps } }),
      backup,
    },
  });
}

/** The format of home `h`'s store, opened by the kernel's own format (no upgrade). */
async function formatOf(dataDir: string): Promise<number> {
  const s = await testBackend().open({ kind: "pglite", dir: dataDir }, {});
  try {
    return s.formatVersion;
  } finally {
    await s.close();
  }
}

/** Runs `sql` on the store in `dataDir`, opened by the kernel's own format. */
async function onStore(dataDir: string, sql: string): Promise<void> {
  const s = await testBackend().open({ kind: "pglite", dir: dataDir }, {});
  try {
    await s.write((tx) => tx.exec(sql));
  } finally {
    await s.close();
  }
}

/**
 * Waits until `ok` holds, asking again every 25 ms, at most `limitMs` (a bound for a test gone
 * wrong, not a guess at how long the thing takes).
 */
async function until(ok: () => boolean, limitMs = 60_000): Promise<void> {
  const end = Date.now() + limitMs;
  while (!ok() && Date.now() <= end) await new Promise((r) => setTimeout(r, 25));
}

/** The bytes of the files under `root` (what the space check counts). */
function bytesOf(root: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else total += st.size;
    }
  };
  walk(root);
  return total;
}

const events = (lines: string[]) => lines.map((l) => l.split(" ")[1]);
const lineOf = (lines: string[], event: string) => lines.find((l) => l.split(" ")[1] === event);

describe("the backup before an upgrade", () => {
  it("made next to the home before the first step: the data directory and control/, with the record of this state", async () => {
    const h = home();
    const controlBefore = await treeDigest(join(h, "control"));
    const lines: string[] = [];
    const s = await service(h, [STEP()], lines);
    try {
      expect(s.state).toBe("ready");
    } finally {
      await s.stop();
    }
    expect(events(lines).filter((e) => e?.startsWith("upgrad"))).toEqual([
      "upgrading",
      "upgrade_backup",
      "upgrade_backup_made",
      "upgrade_step",
      "upgraded",
    ]);
    const b = upgradeBackupDir(h, F);
    expect(b).toBe(`${h}.format-${F}-backup`);
    expect(readdirSync(b).sort()).toEqual(["backup.json", "control", "data"]);
    expect(existsSync(`${b}.partial`)).toBe(false);
    const record = JSON.parse(readFileSync(join(b, "backup.json"), "utf8"));
    expect(record).toMatchObject({ format: 1, from: F, to: F + 1, control: controlBefore });
    expect(await treeDigest(join(b, "control"))).toBe(controlBefore);
    expect(record.log_end.seq).toBeGreaterThanOrEqual(1);
    // The backup is of the store before its upgrade; the home's is upgraded.
    expect(await formatOf(join(b, "data"))).toBe(F);
    expect(statSync(b).mode & 0o777).toBe(0o700);
  });

  it("is a home the version before the upgrade opens: its data directory and control/ put back", async () => {
    const h = home();
    const s = await service(h, [STEP()], []);
    await s.stop();
    const back = join(root, `back${n++}`);
    cpSync(h, back, { recursive: true });
    const b = upgradeBackupDir(h, F);
    for (const d of ["data", "control"]) {
      rmSync(join(back, d), { recursive: true });
      cpSync(join(b, d), join(back, d), { recursive: true });
    }
    // The version before: no upgrade step, the kernel's format.
    const old = await runService({ home: back, version: "t", signals: false, log: () => {} });
    try {
      expect(old.state).toBe("ready");
      expect((await health(socketFile(back)))?.state).toBe("ready");
    } finally {
      await old.stop();
    }
    // Read back: the log ends where the record says, and none of the upgrade's tables is there.
    const record = JSON.parse(readFileSync(join(b, "backup.json"), "utf8"));
    const st = await testBackend().open({ kind: "pglite", dir: join(back, "data") }, {});
    try {
      const tail = await st.read((tx) =>
        tx.query<{ seq: unknown; header_hash: string }>(
          "SELECT seq, header_hash FROM events ORDER BY seq DESC LIMIT 1",
        ),
      );
      expect({ seq: Number(tail.rows[0]?.seq), hash: tail.rows[0]?.header_hash }).toEqual(
        record.log_end,
      );
      const up = await st.read((tx) =>
        tx.query("SELECT 1 FROM pg_tables WHERE tablename = 'up_b'"),
      );
      expect(up.rows).toEqual([]);
    } finally {
      await st.close();
    }
  });

  it("not enough space: upgrade_failed at step backup, nothing copied and nothing upgraded", async () => {
    const h = home();
    const lines: string[] = [];
    const s = await service(h, [STEP()], lines, { freeBytes: () => 1024 });
    expect([s.state, s.reason]).toEqual(["failed", "upgrade_failed"]);
    expect((await health(socketFile(h)))?.upgrade).toMatchObject({ step: "backup" });
    await s.stop();
    expect(lineOf(lines, "failed")).toContain("reason=upgrade_failed step=backup backup=no_space");
    const b = upgradeBackupDir(h, F);
    expect([existsSync(b), existsSync(`${b}.partial`)]).toEqual([false, false]);
    expect(await formatOf(join(h, "data"))).toBe(F);
  });

  it("a copy stopped half way leaves only .partial; the next start removes it and makes the backup", async () => {
    const h = home();
    let copied = 0;
    const lines: string[] = [];
    const s = await service(h, [STEP()], lines, {
      afterCopy: () => {
        if (++copied === 5) throw new Error("the disk went away");
      },
    });
    expect([s.state, s.reason]).toEqual(["failed", "upgrade_failed"]);
    await s.stop();
    expect(lineOf(lines, "failed")).toContain("step=backup backup=copy_failed");
    const b = upgradeBackupDir(h, F);
    expect([existsSync(b), existsSync(`${b}.partial`)]).toEqual([false, true]);
    expect(await formatOf(join(h, "data"))).toBe(F);
    const t = await service(h, [STEP()], []);
    try {
      expect(t.state).toBe("ready");
    } finally {
      await t.stop();
    }
    expect([existsSync(b), existsSync(`${b}.partial`)]).toEqual([true, false]);
  });

  it("made, then the upgrade fails: the next start reuses it, untouched, and upgrades", async () => {
    const h = home();
    const s = await service(h, [step(F, "SELECT 1/0;")], []);
    expect([s.state, s.reason]).toEqual(["failed", "upgrade_failed"]);
    await s.stop();
    const b = upgradeBackupDir(h, F);
    const record = readFileSync(join(b, "backup.json"), "utf8");
    const mtime = statSync(join(b, "backup.json")).mtimeMs;
    const lines: string[] = [];
    const t = await service(h, [STEP()], lines);
    try {
      expect(t.state).toBe("ready");
    } finally {
      await t.stop();
    }
    expect(events(lines)).toContain("upgrade_backup_reused");
    expect(events(lines)).not.toContain("upgrade_backup_made");
    expect(readFileSync(join(b, "backup.json"), "utf8")).toBe(record);
    expect(statSync(join(b, "backup.json")).mtimeMs).toBe(mtime);
  });

  describe("made, the upgrade failed, and the data used since: refused, not overwritten", () => {
    const cases: [string, (h: string) => Promise<void>][] = [
      [
        "log",
        // An event appended after the one the backup ends with.
        (h) =>
          onStore(
            join(h, "data"),
            `INSERT INTO events (seq, header, header_hash, type, actor, at, op)
             SELECT seq + 1, header, repeat('0', 64), type, actor, at, seq + 1
             FROM events ORDER BY seq DESC LIMIT 1`,
          ),
      ],
      [
        "reads",
        (h) =>
          onStore(
            join(h, "data"),
            "INSERT INTO read_log (read_id, actor, at, pos, operation) VALUES ('rd_t', 'a', '2026-11-26T00:00:00Z', 1, 'query')",
          ),
      ],
      [
        "control",
        async (h) => {
          const f = join(h, "control", "credentials.json");
          writeFileSync(f, `${readFileSync(f, "utf8")} `);
        },
      ],
    ];
    for (const [what, use] of cases) {
      it(`${what} differs`, async () => {
        const h = home();
        const s = await service(h, [step(F, "SELECT 1/0;")], []);
        await s.stop();
        const b = upgradeBackupDir(h, F);
        const record = readFileSync(join(b, "backup.json"), "utf8");
        await use(h);
        const lines: string[] = [];
        const t = await service(h, [STEP()], lines);
        expect([t.state, t.reason]).toEqual(["failed", "upgrade_failed"]);
        await t.stop();
        expect(lineOf(lines, "failed")).toContain(
          `step=backup backup=backup_differs differs=${what}`,
        );
        expect(readFileSync(join(b, "backup.json"), "utf8")).toBe(record);
        expect(await formatOf(join(h, "data"))).toBe(F);
      });
    }
  });

  it("while the copy runs the service answers: /health says starting, at step backup", async () => {
    const h = home();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let copied = 0;
    const running = service(h, [STEP()], [], {
      afterCopy: async () => {
        if (++copied === 3) await held;
      },
    });
    // Held on its third file: the copy has begun and cannot end until released.
    await until(() => copied >= 3);
    const seen = await health(socketFile(h), 2000);
    expect(copied).toBe(3);
    expect(seen).toMatchObject({
      state: "starting",
      upgrade: { from: F, to: F + 1, step: "backup" },
    });
    // Asked again while still held: answered at once, not after the copy.
    const again = await health(socketFile(h), 2000);
    expect(again?.upgrade?.step).toBe("backup");
    release();
    const s = await running;
    try {
      expect(s.state).toBe("ready");
    } finally {
      await s.stop();
    }
  });

  it("stopped while the copy runs: the copy halts, only .partial is left, nothing is upgraded; the next start goes on", async () => {
    const h = home();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let copied = 0;
    let handle: { stop: () => Promise<void> } | undefined;
    const lines: string[] = [];
    const running = runService({
      home: h,
      version: "t",
      signals: false,
      log: (l) => lines.push(l),
      onListening: (svc) => {
        handle = svc;
      },
      testing: {
        backend: (o) => testBackend({ ...o, formatUpgrade: { format: F + 1, steps: [STEP()] } }),
        backup: {
          afterCopy: async () => {
            if (++copied === 3) await held;
          },
        },
      },
    });
    await until(() => copied >= 3);
    expect(copied).toBe(3);
    const stopping = (handle as { stop: () => Promise<void> }).stop();
    release();
    await stopping;
    await running.catch(() => undefined);
    expect(copied).toBe(3);
    expect(events(lines)).not.toContain("upgrade_step");
    const b = upgradeBackupDir(h, F);
    expect([existsSync(b), existsSync(`${b}.partial`)]).toEqual([false, true]);
    expect(await formatOf(join(h, "data"))).toBe(F);
    const t = await service(h, [STEP()], []);
    try {
      expect(t.state).toBe("ready");
    } finally {
      await t.stop();
    }
    expect([existsSync(b), existsSync(`${b}.partial`)]).toEqual([true, false]);
  });

  it("the record is in the copy before it takes the backup's name", async () => {
    const h = home();
    const lines: string[] = [];
    const s = await service(h, [STEP()], lines, {
      beforeRename: () => {
        throw Object.assign(new Error("stopped before the rename"), { code: "EIO" });
      },
    });
    expect([s.state, s.reason]).toEqual(["failed", "upgrade_failed"]);
    await s.stop();
    const b = upgradeBackupDir(h, F);
    expect([existsSync(b), existsSync(join(`${b}.partial`, "backup.json"))]).toEqual([false, true]);
    expect(lineOf(lines, "failed")).toContain("backup=copy_failed code=EIO");
  });

  it("the space check counts the upgrade's own room besides the backup's", async () => {
    const h = home();
    const data = bytesOf(join(h, "data"));
    const backup = data + bytesOf(join(h, "control"));
    const lines: string[] = [];
    // Room for the backup, and for the upgrade but one byte.
    const s = await service(h, [STEP()], lines, { freeBytes: () => backup + data - 1 });
    expect([s.state, s.reason]).toEqual(["failed", "upgrade_failed"]);
    await s.stop();
    expect(lineOf(lines, "failed")).toContain("step=backup backup=no_space");
    expect(existsSync(`${upgradeBackupDir(h, F)}.partial`)).toBe(false);
    // Exactly enough: made.
    const t = await service(h, [STEP()], [], { freeBytes: () => backup + data });
    try {
      expect(t.state).toBe("ready");
    } finally {
      await t.stop();
    }
  });

  it("reused or skipped, the upgrade's own room is checked still", async () => {
    const h = home();
    const first = await service(h, [step(F, "SELECT 1/0;")], []);
    await first.stop();
    expect(existsSync(upgradeBackupDir(h, F))).toBe(true);
    const reused: string[] = [];
    const s = await service(h, [STEP()], reused, { freeBytes: () => 0 });
    expect([s.state, s.reason]).toEqual(["failed", "upgrade_failed"]);
    await s.stop();
    expect(lineOf(reused, "failed")).toContain("step=backup backup=no_space");
    const k = home();
    const skipped: string[] = [];
    const t = await service(k, [STEP()], skipped, { upgradeBackup: false, freeBytes: () => 0 });
    expect([t.state, t.reason]).toEqual(["failed", "upgrade_failed"]);
    await t.stop();
    expect(lineOf(skipped, "failed")).toContain("step=backup backup=no_space");
    expect(await formatOf(join(k, "data"))).toBe(F);
  });

  it("a symbolic link inside control/: refused as link, nothing copied", async () => {
    const h = home();
    symlinkSync(join(h, "control", "tenant.json"), join(h, "control", "linked.json"));
    const lines: string[] = [];
    const s = await service(h, [STEP()], lines);
    expect([s.state, s.reason]).toEqual(["failed", "upgrade_failed"]);
    await s.stop();
    expect(lineOf(lines, "failed")).toContain("step=backup backup=link");
    expect(existsSync(`${upgradeBackupDir(h, F)}.partial`)).toBe(false);
    expect(await formatOf(join(h, "data"))).toBe(F);
  });

  it.skipIf(process.getuid?.() === 0)(
    "the copy failing gives its error's code: a home whose directory is not writable, EACCES",
    async () => {
      const parent = mkdtempSync(join(root, "ro-"));
      const h = join(parent, "home");
      cpSync(home(), h, { recursive: true });
      chmodSync(parent, 0o500);
      const lines: string[] = [];
      try {
        const s = await service(h, [STEP()], lines);
        expect([s.state, s.reason]).toEqual(["failed", "upgrade_failed"]);
        await s.stop();
      } finally {
        chmodSync(parent, 0o700);
      }
      expect(lineOf(lines, "failed")).toContain("step=backup backup=copy_failed code=EACCES");
    },
  );

  it("skipped: a .partial a crash left is removed all the same", async () => {
    const h = home();
    const partial = `${upgradeBackupDir(h, F)}.partial`;
    cpSync(join(h, "control"), join(partial, "control"), { recursive: true });
    const s = await service(h, [STEP()], [], { upgradeBackup: false });
    await s.stop();
    expect(existsSync(partial)).toBe(false);
  });

  it("skipped: the upgrade goes on without one, and the log says so", async () => {
    const h = home();
    const lines: string[] = [];
    const s = await service(h, [STEP()], lines, { upgradeBackup: false });
    try {
      expect(s.state).toBe("ready");
    } finally {
      await s.stop();
    }
    expect(events(lines)).toContain("upgrade_backup_skipped");
    expect(existsSync(upgradeBackupDir(h, F))).toBe(false);
  });
});

describe("--no-upgrade-backup", () => {
  it("the foreground entry: off with the option, off with upgrade.backup = false, on otherwise", async () => {
    const h = home();
    expect((await foregroundOptionsOf(foregroundArgs(["--home", h]))).upgradeBackup).toBe(true);
    expect(
      (await foregroundOptionsOf(foregroundArgs(["--home", h, "--no-upgrade-backup"])))
        .upgradeBackup,
    ).toBe(false);
    writeFileSync(join(h, "config.toml"), "[upgrade]\nbackup = false\n");
    expect((await foregroundOptionsOf(foregroundArgs(["--home", h]))).upgradeBackup).toBe(false);
  });

  it("start passes it on to the service it spawns, and only when given", () => {
    expect(serviceArgs("/h", {})).not.toContain("--no-upgrade-backup");
    expect(serviceArgs("/h", { noUpgradeBackup: true })).toContain("--no-upgrade-backup");
  });
});
