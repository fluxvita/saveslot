// The local service while the store's storage format is upgraded at its start (02-architecture §8
// «格式版本、导出、导入与恢复»; 06-cli §6.2): `/health` says `starting` with the upgrade and its
// step, the log has each step, a failed upgrade is `upgrade_failed` with its step (kept for
// `status`), `start` waits on while it runs and says each step, and exits 5 when it failed.

import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HealthBody } from "@fluxvita/saveslot-server";
import { createLocalHome } from "@fluxvita/saveslot-service/testing";
import type { PgliteBackendOptions } from "@fluxvita/saveslot-store-pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import { failedStart, status, waitReady } from "./commands.ts";
import { health } from "./local-request.ts";
import { lastFailureFile, runService, socketFile } from "./service.ts";
import { TEXTS } from "./texts.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** An upgrade step (kernel `UpgradeStep`; the daemon does not import the kernel). */
type UpgradeStep = NonNullable<PgliteBackendOptions["formatUpgrade"]>["steps"][number];

/** The kernel's storage format: the one the template home's store is made with. */
let F = 0;
const root = mkdtempSync(join(tmpdir(), "ssu-"));
const template = join(root, "t");
let n = 0;

beforeAll(async () => {
  await createLocalHome(template, testBackend());
  const s = await testBackend().open({ kind: "pglite", dir: join(template, "data") }, {});
  F = s.formatVersion;
  await s.close();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A copy of the template home, its modes set back as init makes them. */
function home(): string {
  const h = join(root, String(n++));
  cpSync(template, h, { recursive: true });
  chmodSync(h, 0o700);
  chmodSync(join(h, "control"), 0o700);
  for (const f of ["credentials.json", "tenant.json"]) chmodSync(join(h, "control", f), 0o600);
  return h;
}

const step = (from: number, sql: string): UpgradeStep => ({ from, sql });

/** The service on home `h`, its store upgraded to `F + steps.length` by `steps`. */
function upgradingService(h: string, steps: readonly UpgradeStep[], lines: string[]) {
  return runService({
    home: h,
    version: "t",
    signals: false,
    log: (l) => lines.push(l),
    testing: {
      backend: (o) => testBackend({ ...o, formatUpgrade: { format: F + steps.length, steps } }),
    },
  });
}

describe("the service", () => {
  it("while it upgrades: /health says starting, with the upgrade and its step; then ready, without", async () => {
    const h = home();
    const lines: string[] = [];
    const running = upgradingService(
      h,
      [step(F, "CREATE TABLE up_a (x int);"), step(F + 1, "SELECT pg_sleep(1.5);")],
      lines,
    );
    let seen: HealthBody | undefined;
    for (let i = 0; i < 400 && seen === undefined; i++) {
      const b = await health(socketFile(h), 2000);
      if (b?.upgrade?.step === `${F + 1}->${F + 2}`) seen = b;
      else await new Promise((r) => setTimeout(r, 25));
    }
    expect(seen).toMatchObject({
      state: "starting",
      upgrade: { from: F, to: F + 2, step: `${F + 1}->${F + 2}` },
    });
    const s = await running;
    try {
      expect(s.state).toBe("ready");
      const after = await health(socketFile(h));
      expect(after?.state).toBe("ready");
      expect(after?.upgrade).toBeUndefined();
      const events = lines.map((l) => l.split(" ")[1]);
      expect(events.filter((e) => e?.startsWith("upgrad"))).toEqual([
        "upgrading",
        "upgrade_step",
        "upgrade_step",
        "upgraded",
      ]);
    } finally {
      await s.stop();
    }
  });

  it("an upgrade that fails: upgrade_failed, the step on /health, in the log (with SQLSTATE, not the message) and for status", async () => {
    const h = home();
    const lines: string[] = [];
    const s = await upgradingService(h, [step(F, "SELECT 1/0;")], lines);
    expect([s.state, s.reason]).toEqual(["failed", "upgrade_failed"]);
    const b = await health(socketFile(h));
    expect(b).toMatchObject({
      state: "failed",
      reason: "upgrade_failed",
      upgrade: { from: F, to: F + 1, step: `${F}->${F + 1}` },
    });
    const failed = lines.find((l) => l.split(" ")[1] === "failed");
    expect(failed).toContain(`reason=upgrade_failed step=${F}->${F + 1} sql_state=22012`);
    expect(failed).not.toContain("division");
    await s.stop();
    expect(JSON.parse(readFileSync(lastFailureFile(h), "utf8"))).toMatchObject({
      reason: "upgrade_failed",
      step: `${F}->${F + 1}`,
    });
    const out: string[] = [];
    expect(await status(h, { out: (l) => out.push(l), err: () => {} })).toBe(7);
    expect(out.join("\n")).toContain(`upgrade_failed at step ${F}->${F + 1}`);
  });
});

describe("start", () => {
  it("a failed upgrade is 5, as a store of another format; another failure 7", () => {
    const h = (reason: string, upgrade?: HealthBody["upgrade"]): HealthBody => ({
      state: "failed",
      reason,
      version: "t",
      pid: 1,
      since: "2026-11-26T00:00:00Z",
      ...(upgrade !== undefined ? { upgrade } : {}),
    });
    expect(failedStart(h("upgrade_failed", { from: 5, to: 6, step: "5->6" }))).toEqual({
      text: TEXTS.startUpgradeFailed("5->6"),
      code: 5,
    });
    expect(failedStart(h("format_too_old")).code).toBe(5);
    expect(failedStart(h("format_too_new")).code).toBe(5);
    expect(failedStart(h("internal")).code).toBe(7);
  });

  describe("the wait for ready, against a stand-in /health", () => {
    let server: Server;
    const socket = join(root, "w.sock");
    /** What /health answers. */
    let body: HealthBody = { state: "starting", version: "t", pid: 1, since: "x" };
    beforeAll(async () => {
      server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      });
      await new Promise<void>((r) => server.listen(socket, r));
    });
    afterAll(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });

    const starting: HealthBody = { state: "starting", version: "t", pid: 1, since: "x" };
    const upgrading = (s: string): HealthBody => ({
      ...starting,
      upgrade: { from: 5, to: 7, step: s },
    });

    it("upgrading for longer than the wait: waited on, each step told once; ready after", async () => {
      body = upgrading("5->6");
      const told: (string | undefined)[] = [];
      const waited = waitReady(socket, () => false, undefined, {
        waitMs: 300,
        upgrading: (u) => told.push(u.step),
      });
      await new Promise((r) => setTimeout(r, 700));
      body = upgrading("6->7");
      await new Promise((r) => setTimeout(r, 700));
      body = { ...starting, state: "ready" };
      expect(await waited).toMatchObject({ state: "ready" });
      expect(told).toEqual(["5->6", "6->7"]);
    });

    it("starting without an upgrade for longer than the wait: the time is up", async () => {
      body = starting;
      expect(await waitReady(socket, () => false, undefined, { waitMs: 300 })).toBe("timeout");
    });

    it("untilUpgrading (the MCP bridge's start): it ends at the upgrade", async () => {
      body = upgrading("5->6");
      expect(
        await waitReady(socket, () => false, undefined, { waitMs: 300, untilUpgrading: true }),
      ).toBe("upgrading");
    });
  });
});
