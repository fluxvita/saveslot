// `import` over HTTP on the local socket (04-contract §17; 05-surfaces `POST /v1/import`): the
// export file's NDJSON streamed in by the user session into the empty tenant; other requests
// refused while it runs (`importing`), another import `busy`; a body cut midway leaves the tenant
// empty. The services run on real tenants with their real credentials, opened by the test
// backend (see TESTING_BACKEND). Fictional data.

import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalHome, openLocalTenant, sessionFile } from "@fluxvita/saveslot-service";
import { osFileLock } from "@fluxvita/saveslot-store-pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import { httpRequest as one } from "./http-driver.fixture.ts";
import {
  lastFailureFile,
  type RunningService,
  type RunServiceOptions,
  runService,
  socketFile,
} from "./service.ts";

const T = 120_000;
/** The stalled upload's case: the import's own steps under load, and a 90 s guard against a hang. */
const STALL_T = 240_000;
const root = mkdtempSync(join(tmpdir(), "saveslot-import-http-"));
const lines: string[] = [];
let file: string[] = [];
let sourceEnd = 0;
const target = join(root, "target");
let service: RunningService | undefined;
let session = "";
let byConnection = 0;

async function home(h: string): Promise<string> {
  await initLocalHome({
    home: h,
    backend: testBackend(),
    lock: osFileLock,
    now: new Date().toISOString(),
  });
  return readFileSync(sessionFile(h), "utf8").trim();
}
/**
 * The service's tenant and its import's staging storage on the test backend, which copies a new
 * storage from the run's template instead of making it, with the run's durability: host fsync in
 * the runs that set SAVESLOT_TEST_DURABILITY=host-fsync (nightly and by hand), not otherwise. What
 * the service opens with by default is tested in service.test.ts.
 */
const TESTING_BACKEND: NonNullable<RunServiceOptions["testing"]>["backend"] = (o) => testBackend(o);
const start = (h: string) =>
  runService({
    home: h,
    version: "t",
    signals: false,
    log: (l) => lines.push(l),
    testing: { backend: TESTING_BACKEND },
  });

beforeAll(async () => {
  // The export file: a source home's log (its genesis, a connection), as the service writes it.
  const source = join(root, "source");
  const s = await home(source);
  const src = await start(source);
  try {
    const issued = await one(source, {
      method: "POST",
      path: "/v1/connections",
      token: s,
      body: '{"name":"desk"}',
    });
    expect(issued.status).toBe(200);
    const r = await one(source, { method: "GET", path: "/v1/export", token: s });
    expect(r.status).toBe(200);
    file = r.body.split("\n").filter((l) => l !== "");
    sourceEnd = JSON.parse(file[0] as string).upto;
    // A connection may not import (the user session's only), whatever the tenant holds: the scope
    // is checked first. Here, on the source, so that the target's log stays its genesis alone.
    byConnection = (
      await one(source, {
        method: "POST",
        path: "/v1/import",
        token: String(JSON.parse(issued.body).token),
        headers: { "content-type": "application/x-ndjson" },
        body: file.join("\n"),
      })
    ).status;
  } finally {
    await src.stop();
  }
  session = await home(target);
  service = await start(target);
}, T);
afterAll(async () => {
  await service?.stop();
  rmSync(root, { recursive: true, force: true });
}, T);

/**
 * An import request whose body is written as `body` gives it: each chunk once the one before is
 * written, so a test can hold the upload between chunks or cut it.
 */
function upload(
  o: { token: string; type?: string; path?: string; home?: string },
  body: AsyncIterable<Uint8Array>,
): Promise<{ status: number; body: string; headers: Record<string, unknown> } | { cut: true }> {
  return new Promise((resolve) => {
    const req = request(
      {
        socketPath: socketFile(o.home ?? target),
        method: "POST",
        path: o.path ?? "/v1/import",
        headers: {
          authorization: `Bearer ${o.token}`,
          "content-type": o.type ?? "application/x-ndjson",
          "transfer-encoding": "chunked",
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (c: string) => {
          text += c;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers }),
        );
        res.on("error", () => resolve({ cut: true }));
      },
    );
    req.on("error", () => resolve({ cut: true }));
    void (async () => {
      try {
        for await (const chunk of body) {
          if (!req.write(chunk)) await new Promise((r) => req.once("drain", r));
        }
        req.end();
      } catch {
        req.destroy();
      }
    })();
  });
}

const bytesOf = (ls: readonly string[]) =>
  new TextEncoder().encode(ls.map((l) => `${l}\n`).join(""));
async function* whole() {
  yield bytesOf(file);
}
const logEnd = async (token = session, h = target) => {
  const r = await one(h, { method: "GET", path: "/v1/log/end", token });
  return { status: r.status, body: JSON.parse(r.body) as Record<string, unknown> };
};
const reasonOf = (body: string) => {
  const e = (JSON.parse(body) as { error?: { code?: string; reason?: string } }).error;
  return { code: e?.code, reason: e?.reason };
};
/** What lies next to the target's data directory (an import's staging or replaced directory). */
const besides = () => readdirSync(target).filter((x) => x.startsWith("data."));

describe("import over HTTP", () => {
  it(
    "is the user session's, with the export file's NDJSON as its body and no parameters",
    async () => {
      expect(byConnection).toBe(403);
      const json = await upload({ token: session, type: "application/json" }, whole());
      expect("status" in json && { status: json.status, ...reasonOf(json.body) }).toEqual({
        status: 400,
        code: "invalid_argument",
        reason: "malformed",
      });
      const query = await upload({ token: session, path: "/v1/import?x=1" }, whole());
      expect("status" in query && query.status).toBe(400);
      expect((await logEnd()).body["seq"]).toBe(1);
    },
    T,
  );

  it(
    "a body cut midway: the tenant still empty, nothing left beside its data directory",
    async () => {
      const bytes = bytesOf(file);
      async function* cut() {
        yield bytes.slice(0, Math.floor(bytes.length / 2));
        await new Promise((r) => setTimeout(r, 200));
        throw new Error("PROBE the client went away");
      }
      expect(await upload({ token: session }, cut())).toEqual({ cut: true });
      // The service ends the import once the body's end shows; the tenant serves again then.
      // Making the staging storage takes seconds on a loaded machine; the import sees the cut
      // body only once it reads it. Waited for by time, not by a number of tries.
      let end: Awaited<ReturnType<typeof logEnd>> | undefined;
      for (const until = Date.now() + 60_000; Date.now() < until; ) {
        end = await logEnd();
        if (end.status === 200) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(end?.body["seq"]).toBe(1);
      expect(besides()).toEqual([]);
    },
    T,
  );

  it(
    "holds the tenant while it runs (importing; another import busy), then gives the result",
    async () => {
      const bytes = bytesOf(file);
      let release = () => {};
      const hold = new Promise<void>((r) => {
        release = r;
      });
      async function* held() {
        yield bytes.slice(0, 10);
        await hold;
        yield bytes.slice(10);
      }
      const running = upload({ token: session }, held());
      // Wait until the import holds the tenant.
      let during: Awaited<ReturnType<typeof logEnd>> | undefined;
      for (const until = Date.now() + 30_000; Date.now() < until; ) {
        during = await logEnd();
        if (during.status === 503) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(during?.status).toBe(503);
      expect(during?.body).toMatchObject({ error: { code: "unavailable", reason: "importing" } });
      const again = await upload({ token: session }, whole());
      expect("status" in again && { status: again.status, ...reasonOf(again.body) }).toEqual({
        status: 429,
        code: "rate_limited",
        reason: "busy",
      });
      // rate_limited always says when to try again, in the body and as Retry-After.
      expect("status" in again && JSON.parse(again.body).error.retry_after).toBe(5);
      expect("status" in again && again.headers["retry-after"]).toBe("5");
      release();
      const r = await running;
      expect("status" in r && r.status).toBe(200);
      const result = JSON.parse((r as { body: string }).body);
      expect(result).toMatchObject({
        events: sourceEnd,
        seq: sourceEnd + 1,
        restore_count: 1,
        removed: 0,
        pending_deletions: { executed: 0, carried: 0 },
        not_imported: ["read_log", "credentials", "external_files"],
      });
      // The imported log is the tenant's now; the session, the importing user's, still serves.
      expect((await logEnd()).body["seq"]).toBe(sourceEnd + 1);
      expect(besides()).toEqual([]);
      // A second import into the tenant now holding the imported log: not empty.
      const twice = await upload({ token: session }, whole());
      expect("status" in twice && { status: twice.status, ...reasonOf(twice.body) }).toEqual({
        status: 400,
        code: "invalid_argument",
        reason: "tenant_not_empty",
      });
    },
    T,
  );
});

describe("the service around an import", () => {
  /** A body that stops after its first bytes until `release`. */
  const heldBody = () => {
    const bytes = bytesOf(file);
    let release = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    async function* body() {
      yield bytes.slice(0, 10);
      await hold;
      yield bytes.slice(10);
    }
    return { body: body(), release };
  };
  /**
   * An opening of the tenant held at the import's end (the second opening, after the one at
   * start): the import past ④–⑥ and still holding the gate until `release`.
   */
  const heldReopen = () => {
    let opens = 0;
    let release = () => {};
    let reached = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const atReopen = new Promise<void>((r) => {
      reached = r;
    });
    const openTenant: typeof openLocalTenant = async (a) => {
      if (++opens > 1) {
        reached();
        await hold;
      }
      return openLocalTenant(a);
    };
    return { openTenant, release: () => release(), atReopen };
  };
  const startWith = (h: string, testing: NonNullable<RunServiceOptions["testing"]>) =>
    runService({
      home: h,
      version: "t",
      signals: false,
      log: (l) => lines.push(l),
      testing: { backend: TESTING_BACKEND, ...testing },
    });
  const untilReady = async (s: RunningService) => {
    for (const until = Date.now() + 30_000; Date.now() < until; ) {
      if (s.state === "ready" && s.tenant !== undefined) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("the service did not become ready");
  };

  const untilImporting = async (token: string, h: string) => {
    for (const until = Date.now() + 30_000; Date.now() < until; ) {
      if ((await logEnd(token, h)).status === 503) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("the import did not take the tenant");
  };

  it(
    "a stop waits for the import holding the tenant past ④, not for a second one refused as busy",
    async () => {
      const h = join(root, "stop-during-import");
      const token = await home(h);
      const held = heldReopen();
      const s = await startWith(h, { openTenant: held.openTenant });
      await untilReady(s);
      const running = upload({ token, home: h }, whole());
      // Held as it opens the tenant again: the body read, ④–⑥ done, the gate still held.
      await held.atReopen;
      const again = await upload({ token, home: h }, whole());
      expect("status" in again && again.status).toBe(429);
      let stopped = false;
      const stopping = s.stop().then(() => {
        stopped = true;
      });
      await new Promise((r) => setTimeout(r, 1_000));
      // The import in progress still holds the tenant: the stop has not closed it under it.
      expect(stopped).toBe(false);
      held.release();
      await stopping;
      const r = await running;
      expect("status" in r && r.status).toBe(200);
      expect(await s.exited).toEqual({ code: 0 });
    },
    T,
  );

  it(
    "the tenant not opening again after an import: the service fails and exits non-zero",
    async () => {
      const h = join(root, "reopen-fails");
      const token = await home(h);
      const s = await start(h);
      const held = heldBody();
      const running = upload({ token, home: h }, held.body);
      await untilImporting(token, h);
      // Opening reads the tenant's ID from here: gone, the opening after the import fails.
      renameSync(join(h, "control", "tenant.json"), join(h, "control", "tenant.json.away"));
      held.release();
      await running;
      const exited = await Promise.race([
        s.exited,
        new Promise((r) => setTimeout(() => r("still running"), 30_000)),
      ]);
      expect(exited).toMatchObject({ code: 1 });
      // Kept for `status`, as any start that failed.
      expect(JSON.parse(readFileSync(lastFailureFile(h), "utf8"))).toMatchObject({
        reason: "not_initialized",
      });
    },
    T,
  );

  it(
    "the tenant's opening after an import throwing: the service fails and exits non-zero",
    async () => {
      const h = join(root, "reopen-throws");
      const token = await home(h);
      let opens = 0;
      const s = await startWith(h, {
        openTenant: async (a) => {
          if (++opens > 1) throw new Error("PROBE the opening threw");
          return openLocalTenant(a);
        },
      });
      await untilReady(s);
      const r = await upload({ token, home: h }, whole());
      expect("status" in r && r.status).toBe(200);
      expect(opens).toBe(2);
      const exited = await Promise.race([
        s.exited,
        new Promise((r) => setTimeout(() => r("still running"), 30_000)),
      ]);
      expect(exited).toMatchObject({ code: 1 });
    },
    T,
  );

  it(
    "with no request open, a stop still waits for the import holding the tenant, not for one refused as busy",
    async () => {
      const h = join(root, "stop-no-request");
      await home(h);
      let run: ((body: AsyncIterable<Uint8Array>, at: string) => Promise<unknown>) | undefined;
      const held = heldReopen();
      const s = await startWith(h, {
        openTenant: held.openTenant,
        onImport: (r) => {
          run = r;
        },
      });
      await untilReady(s);
      if (run === undefined) throw new Error("no import handed over");
      // Called directly, not over HTTP: no connection is open for the listener's close to wait on.
      const first = run(whole(), new Date().toISOString());
      await held.atReopen;
      const refused = await run(whole(), new Date().toISOString()).catch((e: unknown) => e);
      expect(refused).toMatchObject({ code: "rate_limited", detail: { reason: "busy" } });
      let stopped = false;
      const stopping = s.stop().then(() => {
        stopped = true;
      });
      await new Promise((r) => setTimeout(r, 1_000));
      expect(stopped).toBe(false);
      held.release();
      await stopping;
      expect(await first).toMatchObject({ seq: sourceEnd + 1 });
      expect(await s.exited).toEqual({ code: 0 });
    },
    T,
  );

  it(
    "a stop while an upload has stalled: the import refused and rolled back, the stop not held by the client",
    async () => {
      const h = join(root, "stop-stalled");
      const token = await home(h);
      // No idle limit in reach: only the stop's abort can end this import.
      const s = await startWith(h, { importBodyIdleMs: 3_600_000 });
      await untilReady(s);
      async function* stalled() {
        yield bytesOf(file).slice(0, 10);
        await new Promise(() => {});
      }
      const running = upload({ token, home: h }, stalled());
      await untilImporting(token, h);
      // The import under way: its staging directory made (①), so it reads the body now or next.
      while (!readdirSync(h).some((x) => x.startsWith("data.import-"))) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const stopping = s.stop();
      // The stop's abort reaches the import, which the client sees as its refusal: not held until
      // the client gives up. The bound only keeps a hang from lasting the whole case.
      const r = await Promise.race([
        running,
        new Promise<string>((done) => setTimeout(() => done("no answer"), 90_000)),
      ]);
      expect(typeof r === "object" && "status" in r ? r.status : r).toBe(422);
      expect(reasonOf((r as { body: string }).body)).toEqual({
        code: "import_rejected",
        reason: "incomplete",
      });
      // Then the stop ends: nothing else holds it.
      await stopping;
      expect(await s.exited).toEqual({ code: 0 });
      expect(readdirSync(h).filter((x) => x.startsWith("data."))).toEqual([]);
    },
    STALL_T,
  );

  it(
    "the client gone mid-upload, then a stop: the import rolled back, nothing thrown, the stop completes",
    async () => {
      const h = join(root, "client-gone");
      const token = await home(h);
      const s = await start(h);
      const client = request({
        socketPath: socketFile(h),
        method: "POST",
        path: "/v1/import",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-ndjson",
          "transfer-encoding": "chunked",
        },
      });
      client.on("error", () => {});
      client.write(bytesOf(file).slice(0, 10));
      await untilImporting(token, h);
      // The client goes; the import ends on its body's error (no timer): the tenant serves again.
      client.destroy();
      for (;;) {
        if ((await logEnd(token, h)).status === 200) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(readdirSync(h).filter((x) => x.startsWith("data."))).toEqual([]);
      // Nothing thrown on the gone connection held the stop (an error there is answered by no one,
      // and vitest fails the run on it).
      const ended = await Promise.race([
        s.stop().then(() => "stopped"),
        new Promise((r) => setTimeout(() => r("still stopping"), 20_000)),
      ]);
      expect(ended).toBe("stopped");
      expect(await s.exited).toEqual({ code: 0 });
    },
    T,
  );
});
