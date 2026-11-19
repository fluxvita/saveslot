// The copies tests take of a template home (./home-copy.fixture.ts): each is what init made, a
// home of its own, and the template stays as it was made.

import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalHome, sessionFile } from "@fluxvita/saveslot-service";
import { osFileLock } from "@fluxvita/saveslot-store-pglite";
import { afterAll, describe, expect, it, vi } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import { LEDGER } from "./contract-suite.fixture.ts";
import { copyHome, homeDigest, homeEntries, homeTemplate } from "./home-copy.fixture.ts";
import { httpDriver, httpRequest } from "./http-driver.fixture.ts";
import { runService } from "./service.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const root = mkdtempSync(join(tmpdir(), "ssd-copy-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let inits = 0;
const template = homeTemplate(join(root, "template"), (home) => {
  inits++;
  return initLocalHome({
    home,
    backend: testBackend(),
    lock: osFileLock,
    now: "2026-11-01T00:00:00.000Z",
  });
});

const serve = (home: string) => runService({ home, version: "t", signals: false, log: () => {} });

describe("a copy of a template home", () => {
  it("is made of one init, however many copies; each has init's entries, modes and bytes", async () => {
    const a = await template.copy(join(root, "a"));
    const b = await template.copy(join(root, "b"));
    expect(inits).toBe(1);
    const made = await template.made();
    expect(homeEntries(a)).toEqual(homeEntries(template.dir));
    expect(homeDigest(a)).toBe(made);
    expect(homeDigest(b)).toBe(made);
    // What init makes private is private in the copy.
    expect(homeEntries(a)).toContain("control d 700");
    expect(homeEntries(a)).toContain("control/credentials.json f 600");
  });

  it("a plain copy is not one: its modes differ, the digest says so, and the service refuses it", async () => {
    const plain = join(root, "plain");
    cpSync(template.dir, plain, { recursive: true });
    chmodSync(plain, 0o700);
    chmodSync(join(plain, "control"), 0o755);
    expect(homeDigest(plain)).not.toBe(await template.made());
    const s = await serve(plain);
    expect([s.state, s.reason]).toEqual(["failed", "credentials_permissions"]);
    await s.stop();
  });

  it("a file changed, added or of another mode in a home changes its digest", async () => {
    const made = await template.made();
    const changed = await template.copy(join(root, "changed"));
    writeFileSync(join(changed, "control", "tenant.json"), "{}");
    expect(homeDigest(changed)).not.toBe(made);
    const added = await template.copy(join(root, "added"));
    writeFileSync(join(added, "left-by-a-case"), "");
    expect(homeDigest(added)).not.toBe(made);
    const mode = await template.copy(join(root, "mode"));
    chmodSync(join(mode, "control", "credentials.json"), 0o644);
    expect(homeDigest(mode)).not.toBe(made);
  });

  it("two copies are two homes: each serves on its own, what is written and issued in one is not in the other, and the template is as it was made", async () => {
    const a = await template.copy(join(root, "one"));
    const b = await template.copy(join(root, "two"));
    const session = readFileSync(sessionFile(a), "utf8").trim();
    const sa = await serve(a);
    const sb = await serve(b);
    try {
      const inA = httpDriver(() => a);
      const inB = httpDriver(() => b);
      expect(
        await inA(session, "schema_draft", { document: { ...LEDGER, slot: "ledger" } } as never),
      ).toMatchObject({ result: { outcome: "applied" } });
      const issued = (await inA(session, "connections.issue", {
        name: "Only in a",
        scopes: ["saveslot.read"],
      } as never)) as { result: { token: string } };
      const endA = (await inA(session, "log.end", {} as never)) as { result: { seq: number } };
      const endB = (await inB(session, "log.end", {} as never)) as { result: { seq: number } };
      // b's log is still the template's; a's went on. The connection issued in a is none of b's.
      expect(endA.result.seq).toBeGreaterThan(endB.result.seq);
      const token = issued.result.token;
      expect((await httpRequest(a, { method: "GET", path: "/v1/slots", token })).status).toBe(200);
      expect((await httpRequest(b, { method: "GET", path: "/v1/slots", token })).status).toBe(401);
    } finally {
      await sa.stop();
      await sb.stop();
    }
    expect(homeDigest(template.dir)).toBe(await template.made());
  });

  it("does not copy over a home that is there", async () => {
    const there = await template.copy(join(root, "there"));
    expect(() => copyHome(template.dir, there)).toThrow();
  });
});
