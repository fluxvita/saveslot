// The HTTP adapter on the local socket, against a running service (05-surfaces §13–§15): the
// contract cases through an HTTP driver, then what is HTTP's own — statuses and headers, the body
// limit, the query string, routes of later versions, the service still starting — and the log:
// one line a request, never a token, a header value, a path part or a body.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalHome, sessionFile } from "@fluxvita/saveslot-service";
import { osFileLock } from "@fluxvita/saveslot-store-pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import { contractSuite } from "./contract-suite.fixture.ts";
import { httpDriver, httpRequest, type Reply, utf8Header } from "./http-driver.fixture.ts";
import { type RunningService, runService, socketFile } from "./service.ts";

const T = 60_000;
const root = mkdtempSync(join(tmpdir(), "saveslot-http-"));
const home = join(root, "home");
const lines: string[] = [];
let service: RunningService;
let session = "";

/** One request on this service's socket. */
const http = (o: Parameters<typeof httpRequest>[1]) => httpRequest(home, o);
const driver = httpDriver(() => home);

beforeAll(async () => {
  await initLocalHome({
    home,
    backend: testBackend(),
    lock: osFileLock,
    now: new Date().toISOString(),
  });
  session = readFileSync(sessionFile(home), "utf8").trim();
  service = await runService({ home, version: "t", signals: false, log: (l) => lines.push(l) });
  expect(service.state).toBe("ready");
}, T);
afterAll(async () => {
  await service?.stop();
  rmSync(root, { recursive: true, force: true });
}, T);

describe("the contract over HTTP", () => {
  contractSuite(() => ({ driver, session }));
});

describe("HTTP's own", () => {
  const err = (r: Reply) => (JSON.parse(r.body) as { error: Record<string, unknown> }).error;

  it("/health takes no token; a path outside /v1/ is 404 with no body", async () => {
    expect((await http({ method: "GET", path: "/health" })).status).toBe(200);
    const r = await http({ method: "GET", path: "/elsewhere" });
    expect([r.status, r.body]).toEqual([404, ""]);
  });

  it("401 with WWW-Authenticate: Bearer, and error=invalid_token for a token that is not good", async () => {
    const missing = await http({ method: "GET", path: "/v1/slots" });
    expect([missing.status, missing.headers["www-authenticate"], err(missing)["reason"]]).toEqual([
      401,
      "Bearer",
      "missing",
    ]);
    const bad = await http({ method: "GET", path: "/v1/slots", token: `slt_${"A".repeat(43)}` });
    expect([bad.status, bad.headers["www-authenticate"], err(bad)["reason"]]).toEqual([
      401,
      'Bearer error="invalid_token"',
      "invalid",
    ]);
    // Authentication comes first: an unknown route without a token is 401, not 404.
    expect((await http({ method: "GET", path: "/v1/nowhere" })).status).toBe(401);
  });

  it("an unknown route is 404 (route); a route of a later version is 501", async () => {
    const r = await http({ method: "GET", path: "/v1/nowhere", token: session });
    expect([r.status, err(r)["code"], err(r)["reason"]]).toEqual([404, "not_found", "route"]);
    const later = await http({ method: "POST", path: "/v1/sql", token: session, body: "{}" });
    expect([later.status, err(later)["code"]]).toEqual([501, "not_in_this_version"]);
  });

  it("the body: JSON only, at most 1 MiB, cut off past it; parameters not in the query string too", async () => {
    const type = await http({
      method: "POST",
      path: "/v1/query",
      token: session,
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect([type.status, err(type)["code"]]).toEqual([400, "invalid_argument"]);
    const big = await http({
      method: "POST",
      path: "/v1/query",
      token: session,
      body: JSON.stringify({ table: "ledger.expenses", pad: "x".repeat(1024 * 1024) }),
    });
    expect([big.status, err(big)["code"], err(big)["reason"]]).toEqual([
      413,
      "too_large",
      "request_body",
    ]);
    const both = await http({ method: "POST", path: "/v1/query?x=1", token: session, body: "{}" });
    expect(both.status).toBe(400);
    const notJson = await http({ method: "POST", path: "/v1/query", token: session, body: "{" });
    expect(notJson.status).toBe(400);
  });

  it("the query string: a key twice is refused; limit a number; a table by its two path parts", async () => {
    const twice = await http({ method: "GET", path: "/v1/slots?limit=1&limit=2", token: session });
    expect([twice.status, err(twice)["param"]]).toEqual([400, "limit"]);
    const one = await http({ method: "GET", path: "/v1/slots?limit=1", token: session });
    expect(one.status).toBe(200);
    const table = await http({
      method: "GET",
      path: "/v1/slots/ledger/tables/expenses",
      token: session,
    });
    expect(table.status).toBe(200);
    expect(table.body).toContain("expenses");
  });

  it("each path part of its form, or refused before it reaches anything", async () => {
    const cases: [string, string, string | undefined, string][] = [
      ["GET", "/v1/pending/constructor", undefined, "id"],
      ["GET", "/v1/pending/__proto__", undefined, "id"],
      ["POST", "/v1/pending/toString/resolution", "{}", "id"],
      ["PATCH", "/v1/connections/__proto__", JSON.stringify({ name: "x" }), "id"],
      ["DELETE", `/v1/connections/pi_${"1".repeat(16)}x`, undefined, "id"],
      ["GET", "/v1/slots/con%2Fstructor", undefined, "slot"],
      ["GET", "/v1/slots/ledger/tables/ex%20penses", undefined, "table"],
      ["GET", `/v1/tables/${"t".repeat(65)}`, undefined, "table"],
    ];
    for (const [method, path, body, param] of cases) {
      const r = await http({
        method,
        path,
        token: session,
        ...(body !== undefined ? { body } : {}),
      });
      expect({ path, status: r.status, param: err(r)["param"] }).toEqual({
        path,
        status: 400,
        param,
      });
    }
  });

  it("task and idempotency key only as headers: in the body they are refused", async () => {
    for (const k of ["task", "idempotency_key"]) {
      const r = await http({
        method: "POST",
        path: "/v1/query",
        token: session,
        body: JSON.stringify({ [k]: "x" }),
      });
      expect([r.status, err(r)["param"]]).toEqual([400, k]);
    }
    const id = await http({
      method: "POST",
      path: `/v1/pending/pi_${"1".repeat(16)}/resolution`,
      token: session,
      body: JSON.stringify({ id: `pi_${"2".repeat(16)}`, decision: "keep_effective" }),
    });
    expect([id.status, err(id)["param"]]).toEqual([400, "id"]);
  });

  it("task and idempotency key are UTF-8 bytes: decoded, then checked as the contract checks them", async () => {
    const query = (task: string) =>
      http({
        method: "POST",
        path: "/v1/query",
        token: session,
        headers: { "x-task-id": task },
        body: JSON.stringify({ table: "ledger.expenses", limit: 1 }),
      });
    const refused = async (task: string, reason?: string) => {
      const r = await query(task);
      expect([r.status, err(r)["code"], err(r)["param"]]).toEqual([
        400,
        "invalid_argument",
        "task",
      ]);
      if (reason !== undefined) expect(err(r)["reason"]).toBe(reason);
    };
    // 256 code points of three bytes each pass; 257 do not: the limit counts the decoded text.
    expect((await query(utf8Header("账".repeat(256)))).status).toBe(200);
    await refused(utf8Header("账".repeat(257)));
    // A control character that is one only once decoded (U+0085 is C2 85).
    await refused(utf8Header("a\u0085b"));
    // Bytes that are not UTF-8.
    await refused("\xff\xfe", "malformed");
    await refused("\xe8\xb4", "malformed");

    // A task read back as it was given.
    const task = `整理账单 ${Date.now()}`;
    expect((await query(utf8Header(task))).status).toBe(200);
    const reads = JSON.parse(
      (await http({ method: "GET", path: "/v1/reads?limit=200", token: session })).body,
    ) as { reads: { task?: string }[] };
    expect(reads.reads.map((x) => x.task)).toContain(task);
  });

  it("an idempotency key in Chinese: the same key again is a replay", async () => {
    const write = () =>
      http({
        method: "POST",
        path: "/v1/writes",
        token: session,
        // 200 code points, 600 bytes: within the limit only as decoded text.
        headers: { "idempotency-key": utf8Header("记一笔午饭".repeat(40)) },
        body: JSON.stringify({
          sv: 1,
          ops: [{ intent: "insert", table: "ledger.expenses", set: { date: "2026-11-16" } }],
        }),
      });
    const first = await write();
    const again = await write();
    expect([first.status, again.status]).toEqual([200, 200]);
    const a = JSON.parse(first.body) as { replayed?: true; ops: { target: unknown }[] };
    const b = JSON.parse(again.body) as { replayed?: true; ops: { target: unknown }[] };
    expect(a.replayed).toBeUndefined();
    expect(b.replayed).toBe(true);
    expect(b.ops[0]?.target).toEqual(a.ops[0]?.target);
  });

  it("every route of this version reaches its operation; every later one is 501", async () => {
    // A connection to rename, an item ID of the right form.
    const issued = JSON.parse(
      (
        await http({
          method: "POST",
          path: "/v1/connections",
          token: session,
          body: JSON.stringify({ name: "routes" }),
        })
      ).body,
    ) as { id: string };
    const ITEM = `pi_${"3".repeat(16)}`;
    // A row to read the history of.
    const written = JSON.parse(
      (
        await http({
          method: "POST",
          path: "/v1/writes",
          token: session,
          body: JSON.stringify({
            sv: 1,
            ops: [{ intent: "insert", table: "ledger.expenses", set: { date: "2026-11-15" } }],
          }),
        })
      ).body,
    ) as { ops: { target: { row: string } }[] };
    const row = written.ops[0]?.target.row;
    const ours: [string, string, string | undefined, number][] = [
      ["GET", "/v1/slots", undefined, 200],
      ["GET", "/v1/slots/ledger", undefined, 200],
      ["GET", "/v1/slots/ledger/schema", undefined, 200],
      ["GET", "/v1/slots/ledger/tables?tables=expenses", undefined, 200],
      ["GET", "/v1/slots/ledger/tables/expenses", undefined, 200],
      ["GET", "/v1/tables/expenses", undefined, 200],
      ["POST", "/v1/query", JSON.stringify({ table: "ledger.expenses" }), 200],
      ["POST", "/v1/history", JSON.stringify({ table: "ledger.expenses", row }), 200],
      ["GET", "/v1/pending", undefined, 200],
      // No such item: the operation answers (404 not_found, item), not the router.
      ["GET", `/v1/pending/${ITEM}`, undefined, 404],
      [
        "POST",
        `/v1/pending/${ITEM}/resolution`,
        JSON.stringify({ decision: "keep_effective" }),
        404,
      ],
      ["POST", "/v1/writes", JSON.stringify({ sv: 1, ops: [] }), 400],
      ["POST", "/v1/drafts", JSON.stringify({ document: { slot: "x" } }), 400],
      ["POST", "/v1/connections", JSON.stringify({ name: "routes 2" }), 200],
      ["GET", "/v1/connections", undefined, 200],
      ["PATCH", `/v1/connections/${issued.id}`, JSON.stringify({ name: "renamed" }), 200],
      ["DELETE", `/v1/connections/${issued.id}`, undefined, 200],
      ["GET", "/v1/reads", undefined, 200],
      ["GET", "/v1/log/verify", undefined, 200],
      ["GET", "/v1/log/end", undefined, 200],
    ];
    for (const [method, path, body, status] of ours) {
      const r = await http({
        method,
        path,
        token: session,
        ...(body !== undefined ? { body } : {}),
      });
      const reason = r.status === 200 ? undefined : err(r)["reason"];
      expect({ method, path, status: r.status, routed: reason !== "route" }).toEqual({
        method,
        path,
        status,
        routed: true,
      });
    }
    const later: [string, string][] = [
      ["POST", "/v1/sql"],
      ["GET", "/v1/sources"],
      ["GET", "/v1/sources/s_1"],
      ["POST", "/v1/deletions/preview"],
      ["POST", "/v1/deletions"],
      ["GET", "/v1/deletions/pi_1"],
      ["GET", "/v1/drafts/d_1"],
      ["POST", "/v1/claims"],
      ["POST", "/v1/claims/ls_1/results"],
      ["GET", "/v1/jobs"],
      ["GET", "/v1/jobs/jb_1"],
      ["GET", "/v1/slots/ledger/policy"],
      ["PUT", "/v1/slots/ledger/policy"],
      ["POST", "/v1/log/reconcile"],
      ["GET", "/v1/export"],
      ["POST", "/v1/import"],
    ];
    for (const [method, path] of later) {
      const r = await http({
        method,
        path,
        token: session,
        ...(method === "GET" ? {} : { body: "{}" }),
      });
      expect({ method, path, status: r.status }).toEqual({ method, path, status: 501 });
    }
  });

  it(
    "503 while the service is still opening the tenant",
    async () => {
      // A second home, its request sent the moment the socket listens.
      const h2 = join(root, "starting");
      await initLocalHome({
        home: h2,
        backend: testBackend(),
        lock: osFileLock,
        now: new Date().toISOString(),
      });
      let early: Promise<Reply> | undefined;
      const s2 = await runService({
        home: h2,
        version: "t",
        signals: false,
        log: () => {},
        onListening: () => {
          early = http({ method: "GET", path: "/v1/slots", socket: socketFile(h2) });
        },
      });
      try {
        const r = await (early as Promise<Reply>);
        expect([r.status, err(r)["code"], err(r)["reason"]]).toEqual([
          503,
          "unavailable",
          "starting",
        ]);
      } finally {
        await s2.stop();
      }
    },
    T,
  );
});

describe("connections a response is sent on before the request arrived whole", () => {
  /** Writes `chunks` on one raw connection; everything read until the server closes it. */
  function raw(
    chunks: readonly (string | Buffer | number)[],
  ): Promise<{ text: string; closed: boolean }> {
    return new Promise((resolve) => {
      const sock = connect(socketFile(home));
      let text = "";
      sock.setEncoding("latin1");
      sock.on("data", (c: string) => {
        text += c;
      });
      sock.on("error", () => {});
      sock.on("close", () => resolve({ text, closed: true }));
      // A number is a pause, in milliseconds, before the next chunk.
      void (async () => {
        for (const c of chunks) {
          if (typeof c === "number") await new Promise((r) => setTimeout(r, c));
          else if (!sock.destroyed) sock.write(c);
        }
      })();
      // Never ends its side: only the server's close ends this.
      setTimeout(() => {
        sock.destroy();
        resolve({ text, closed: false });
      }, 10_000);
    });
  }
  const head = (o: { method: string; path: string; token?: string; length: number }) =>
    `${o.method} ${o.path} HTTP/1.1\r\nHost: local\r\n${o.token !== undefined ? `Authorization: Bearer ${o.token}\r\n` : ""}Content-Type: application/json\r\nContent-Length: ${o.length}\r\n\r\n`;

  it(
    "a body past the limit: 413, Connection: close, the connection closed; a request after it on that connection is not served",
    async () => {
      const body = Buffer.alloc(2 * 1024 * 1024, 0x20);
      const next =
        "GET /v1/slots HTTP/1.1\r\nHost: local\r\nAuthorization: Bearer " + session + "\r\n\r\n";
      const r = await raw([
        head({ method: "POST", path: "/v1/query", token: session, length: body.length }),
        body,
        next,
      ]);
      expect(r.closed).toBe(true);
      const responses = r.text.match(/HTTP\/1\.1 \d{3}/g) ?? [];
      expect(responses).toEqual(["HTTP/1.1 413"]);
      expect(r.text.toLowerCase()).toContain("connection: close");
    },
    T,
  );

  it(
    "refused before the body is read (no token): 401 at once and the connection closed, the body not waited for",
    async () => {
      // Says 8 MiB, sends 1 KiB: the server answers without reading or waiting for the rest.
      const r = await raw([
        head({ method: "POST", path: "/v1/query", length: 8 * 1024 * 1024 }),
        Buffer.alloc(1024, 0x20),
      ]);
      expect(r.closed).toBe(true);
      expect(r.text.match(/HTTP\/1\.1 \d{3}/g)).toEqual(["HTTP/1.1 401"]);
      expect(r.text.toLowerCase()).toContain("connection: close");
    },
    T,
  );

  it(
    "the rest of the body and a next request arriving after the response: that request is not served",
    async () => {
      const next = `GET /v1/connections HTTP/1.1\r\nHost: local\r\nAuthorization: Bearer ${session}\r\n\r\n`;
      // Its response could not be read anyway (this side is ended): what shows it was served is
      // the log, one line a request.
      const before = lines.length;
      const r = await raw([
        head({ method: "POST", path: "/v1/query", length: 4 }),
        "{}",
        200,
        "  ",
        next,
      ]);
      expect(r.closed).toBe(true);
      expect(r.text.match(/HTTP\/1\.1 \d{3}/g)).toEqual(["HTTP/1.1 401"]);
      expect(lines.slice(before).filter((l) => l.includes(" request "))).toEqual([
        expect.stringContaining("status=401"),
      ]);
    },
    T,
  );

  it(
    "a route of a later version with a body still coming: 501 and closed",
    async () => {
      const r = await raw([
        head({ method: "POST", path: "/v1/sql", token: session, length: 8 * 1024 * 1024 }),
        "{",
      ]);
      expect(r.closed).toBe(true);
      expect(r.text.match(/HTTP\/1\.1 \d{3}/g)).toEqual(["HTTP/1.1 501"]);
    },
    T,
  );
});

describe("query keys of the caller's", () => {
  it("__proto__ and constructor are keys like any other: refused as unknown", async () => {
    for (const k of ["__proto__", "constructor"]) {
      const r = await http({ method: "GET", path: `/v1/connections?${k}=x`, token: session });
      expect({
        k,
        status: r.status,
        param: (JSON.parse(r.body) as { error: { param: string } }).error.param,
      }).toEqual({
        k,
        status: 400,
        param: k,
      });
    }
  });
});

describe("the log", () => {
  it("one line a request with its route and status; no token, header value, path part or body", () => {
    const requests = lines.filter((l) => l.includes(" request "));
    expect(requests.length).toBeGreaterThan(20);
    for (const l of requests) expect(l).toMatch(/ method=\w+ route=\w+ status=\d{3} ms=\d+$/);
    const all = lines.join("\n");
    expect(all).not.toMatch(/(slt|sls)_[A-Za-z0-9_-]{8}/);
    for (const secret of [
      "Bearer",
      "tea",
      "bus",
      "weekly-review",
      "tea-1",
      "ledger.expenses",
      "pi_1111",
    ]) {
      expect({ secret, found: all.includes(secret) }).toEqual({ secret, found: false });
    }
  });
});
