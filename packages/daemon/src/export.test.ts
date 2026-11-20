// `export` over HTTP on the local socket (04-contract §17; 05-surfaces §14; 09 §8): NDJSON as the
// log is read, for the user session only, with the reader going away mid-stream stopping the
// read. The service runs on a real tenant; the credentials are the real ones.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalHome, sessionFile } from "@fluxvita/saveslot-service";
import { osFileLock } from "@fluxvita/saveslot-store-pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import { LEDGER } from "./contract-suite.fixture.ts";
import { httpDriver, httpRequest as one } from "./http-driver.fixture.ts";
import { type RunningService, runService, socketFile } from "./service.ts";

const T = 120_000;
interface Row {
  h: { seq: number };
  [k: string]: unknown;
}
const root = mkdtempSync(join(tmpdir(), "saveslot-export-http-"));
const home = join(root, "home");
const lines: string[] = [];
let service: RunningService;
let session = "";
let writer = "";
const driver = httpDriver(() => home);

const ok = (r: Awaited<ReturnType<typeof driver>>): Record<string, unknown> => {
  if (!("result" in r)) throw new Error(JSON.stringify(r));
  return r.result;
};

beforeAll(async () => {
  await initLocalHome({
    home,
    backend: testBackend(),
    lock: osFileLock,
    now: new Date().toISOString(),
  });
  session = readFileSync(sessionFile(home), "utf8").trim();
  service = await runService({
    home,
    version: "t",
    signals: false,
    log: (l) => lines.push(l),
    exportStallMs: 1500,
  });
  ok(await driver(session, "schema_draft", { document: LEDGER }));
  writer = String(ok(await driver(session, "connections.issue", { name: "writer" }))["token"]);
  for (let i = 0; i < 120; i++) {
    ok(
      await driver(writer, "write", {
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "ledger.expenses",
            set: { date: "2026-11-16", note: `n${i} ${"x".repeat(900)}` },
          },
        ],
      }),
    );
  }
}, T);
afterAll(async () => {
  await service?.stop();
  rmSync(root, { recursive: true, force: true });
}, T);

const get = (path: string, token: string) => one(home, { method: "GET", path, token });

describe("export over HTTP", () => {
  it(
    "streams the manifest and every event as NDJSON, in a chunked answer, to the user session",
    async () => {
      const r = await get("/v1/export", session);
      expect(r.status).toBe(200);
      expect(r.headers["content-type"]).toBe("application/x-ndjson");
      expect(r.headers["content-length"]).toBeUndefined();
      expect(r.headers["transfer-encoding"]).toBe("chunked");
      expect(r.body.endsWith("\n")).toBe(true);
      const rows = r.body
        .slice(0, -1)
        .split("\n")
        .map((l) => JSON.parse(l) as Row);
      const [manifest, ...events] = rows;
      expect(manifest).toMatchObject({
        saveslot_export: 1,
        event_format: 1,
        restore_count: 0,
        pending_deletions: "placeholder",
      });
      expect(events).toHaveLength(Number(manifest?.["events"]));
      expect(events.at(-1)?.["h"].seq).toBe(manifest?.["upto"]);
      expect(events.map((e) => e["h"].seq)).toEqual(events.map((_, i) => i + 1));
    },
    T,
  );

  it("`after_seq` continues after an event; the manifest says so", async () => {
    const all = await get("/v1/export", session);
    const total = all.body.split("\n").filter(Boolean).length - 1;
    const r = await get(`/v1/export?after_seq=${total - 3}`, session);
    expect(r.status).toBe(200);
    const [manifest, ...events] = r.body
      .slice(0, -1)
      .split("\n")
      .map((l) => JSON.parse(l) as Row);
    expect(manifest).toMatchObject({ after: total - 3, events: 3, upto: total });
    expect(events).toHaveLength(3);
  });

  it("refuses what is not a count, one beyond the end, and a parameter it does not have", async () => {
    for (const q of [
      "after_seq=x",
      "after_seq=999999",
      "after_seq=-1",
      "include_pending_deletion=maybe",
      "limit=5",
    ]) {
      const r = await get(`/v1/export?${q}`, session);
      const e = (JSON.parse(r.body) as { error: Record<string, unknown> }).error;
      expect([q, r.status, e["code"]]).toEqual([q, 400, "invalid_argument"]);
    }
  });

  it("a connection's credential is refused, with the user session as what is needed", async () => {
    const r = await get("/v1/export", writer);
    const e = (JSON.parse(r.body) as { error: Record<string, unknown> }).error;
    expect([r.status, e["code"], e["required_scope"]]).toEqual([
      403,
      "insufficient_scope",
      "user_session",
    ]);
    // Not a byte of the log went with the refusal.
    expect(r.body).not.toContain("saveslot_export");
  });

  it("no credential: 401", async () => {
    expect((await one(home, { method: "GET", path: "/v1/export" })).status).toBe(401);
  });

  it(
    "a reader that goes away mid-stream stops the read: the service answers the next call at once",
    async () => {
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(
          {
            socketPath: socketFile(home),
            method: "GET",
            path: "/v1/export",
            headers: { authorization: `Bearer ${session}` },
          },
          (res) => {
            res.once("data", () => {
              // The first chunk is in; leave, with most of the log unread.
              req.destroy();
              res.destroy();
              resolve();
            });
          },
        );
        req.on("error", () => {});
        req.end();
        setTimeout(() => reject(new Error("no data")), 30_000).unref();
      });
      // A write queues behind any transaction left open; it must not wait for the whole log.
      const t0 = Date.now();
      ok(
        await driver(writer, "write", {
          sv: 1,
          ops: [
            {
              intent: "insert",
              table: "ledger.expenses",
              set: { date: "2026-11-17", note: "after" },
            },
          ],
        }),
      );
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(ok(await driver(session, "log.verify", {}))["chain"]).toEqual({ intact: true });
    },
    T,
  );

  it(
    "a reader that stops reading holds nothing: writes go on meanwhile, and the service cuts it after the stall time",
    async () => {
      let ended = false;
      let cut = false;
      const res = await new Promise<import("node:http").IncomingMessage>((resolve) => {
        const req = httpRequest(
          {
            socketPath: socketFile(home),
            method: "GET",
            path: "/v1/export",
            headers: { authorization: `Bearer ${session}` },
          },
          (r) => {
            r.once("data", () => {
              r.pause(); // stops reading: the socket fills and the service waits on it
              resolve(r);
            });
            r.on("end", () => {
              ended = true;
            });
            r.on("aborted", () => {
              cut = true;
            });
            r.on("error", () => {
              cut = true;
            });
          },
        );
        req.on("error", () => {
          cut = true;
        });
        req.end();
      });
      // While the reader sits on its unread answer, the tenant serves at once: the service holds
      // no transaction between steps.
      const t0 = Date.now();
      ok(
        await driver(writer, "write", {
          sv: 1,
          ops: [
            {
              intent: "insert",
              table: "ledger.expenses",
              set: { date: "2026-11-18", note: "while paused" },
            },
          ],
        }),
      );
      expect(Date.now() - t0).toBeLessThan(3_000);
      // After the stall time the service gives the export up: the answer is cut, never ended.
      await new Promise((r) => setTimeout(r, 3_000));
      res.resume();
      await new Promise((r) => setTimeout(r, 500));
      expect(ended).toBe(false);
      expect(cut || res.destroyed || res.readableAborted).toBe(true);
    },
    T,
  );
});
