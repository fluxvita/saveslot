// Each operation call against a stand-in server: the method, path, query string, headers and body
// it sends, as the service's routes read them (05-surfaces §14).

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogParams } from "@fluxvita/saveslot-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, ClientUsageError, createClient } from "./index.ts";

const TOKEN = `sls_${"a".repeat(43)}`;
const PI = "pi_0123456789ABCDEF" as const;
const CI = `ci_${"0".repeat(26)}` as const;

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

let dir: string;
let server: Server;
let seen: Seen[] = [];
let client: Client;
let socketPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "saveslot-client-ops-"));
  socketPath = join(dir, "s.sock");
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      // A task of "hang" is never answered, for the time limit.
      if (req.headers["x-task-id"] === "hang") return;
      const text = Buffer.concat(chunks).toString("utf8");
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: text === "" ? undefined : JSON.parse(text),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  client = createClient({ socketPath, token: TOKEN });
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

/** What one call sent. */
async function sent(call: () => Promise<unknown>): Promise<Seen> {
  seen = [];
  await call();
  expect(seen).toHaveLength(1);
  const s = seen[0] as Seen;
  expect(s.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
  return s;
}

const req = (s: Seen) => ({
  method: s.method,
  url: s.url,
  task: s.headers["x-task-id"],
  key: s.headers["idempotency-key"],
  body: s.body,
});

describe("catalog", () => {
  it("list, of one slot, schema, and tables by their routes", async () => {
    expect(req(await sent(() => client.catalog({})))).toEqual({
      method: "GET",
      url: "/v1/slots",
      task: undefined,
      key: undefined,
      body: undefined,
    });
    expect(
      req(
        await sent(() =>
          client.catalog({ level: "list", limit: 5, task: "saveslot-connect-selfcheck" }),
        ),
      ),
    ).toMatchObject({ url: "/v1/slots?limit=5", task: "saveslot-connect-selfcheck" });
    expect(req(await sent(() => client.catalog({ slot: "health" })))).toMatchObject({
      url: "/v1/slots/health",
    });
    expect(
      req(await sent(() => client.catalog({ level: "schema", slot: "health" }))),
    ).toMatchObject({ url: "/v1/slots/health/schema" });
    expect(
      req(await sent(() => client.catalog({ level: "table", tables: ["runs"] }))),
    ).toMatchObject({ url: "/v1/tables/runs" });
    expect(
      req(await sent(() => client.catalog({ level: "table", tables: ["health.runs"] }))),
    ).toMatchObject({ url: "/v1/slots/health/tables/runs" });
    expect(
      req(
        await sent(() =>
          client.catalog({ level: "table", tables: ["health.runs", "health.weekly_mileage"] }),
        ),
      ),
    ).toMatchObject({ url: "/v1/slots/health/tables?tables=runs%2Cweekly_mileage" });
  });

  it("refuses what no route takes, sending nothing", async () => {
    seen = [];
    await expect(client.catalog({ level: "table", tables: ["runs", "budgets"] })).rejects.toThrow(
      /HTTP has no endpoint for this combination/,
    );
    for (const p of [
      { level: "schema" },
      { level: "table", tables: ["runs", "budgets"] },
      { level: "table", tables: ["health.runs", "plan.budgets"] },
      { level: "table", tables: [] },
      { level: "slots" },
      { level: "list", tables: ["health.runs"] },
      { level: "schema", slot: "health", tables: ["health.runs"] },
    ]) {
      await expect(client.catalog(p as CatalogParams)).rejects.toThrow(ClientUsageError);
    }
    expect(seen).toEqual([]);
  });
});

describe("parameters that cannot go on the route as given", () => {
  // Each refused, from the promise, with nothing sent.
  async function refused(call: () => Promise<unknown>, message?: RegExp) {
    seen = [];
    let p: Promise<unknown> | undefined;
    expect(() => {
      p = call();
    }).not.toThrow();
    await expect(p).rejects.toThrow(ClientUsageError);
    if (message !== undefined) await expect(p).rejects.toThrow(message);
    expect(seen).toEqual([]);
  }

  it.each(["", ".", ".."])("a path segment %j", async (s) => {
    await refused(() => client.catalog({ slot: s }));
    await refused(() => client.pending({ id: s as typeof PI }));
    await refused(() =>
      client.resolve({ id: s as typeof PI, decision: "confirm", item_ver: "iv_1" }),
    );
    await refused(() => client.connections.update({ id: s as typeof CI, name: "x" }));
    await refused(() => client.connections.revoke({ id: s as typeof CI }));
    await refused(() => client.catalog({ level: "table", tables: [s] }));
    await refused(() => client.catalog({ level: "table", tables: [`health.${s}`] }));
  });

  it("a lone surrogate, in a path or in a query string", async () => {
    await refused(() => client.catalog({ slot: "a\ud800" }), /lone surrogate/);
    await refused(() => client.pending({ slot: "a\udc00" }), /lone surrogate/);
  });

  it("a body that is no JSON", async () => {
    await refused(() => client.query({ table: "health.runs", limit: 1n } as never), /JSON/);
  });

  it.each([
    ["a task with a control character", { task: "a\tb" }],
    ["a task with a line end", { task: "a\nb" }],
    ["a task with DEL", { task: "a\u007fb" }],
    ["a task with a lone surrogate", { task: "a\ud800b" }],
    ["a task with a space at the start", { task: " t" }],
    ["a task with a space at the end", { task: "t " }],
    ["a task that is no string", { task: 1 }],
    ["an idempotency key with a lone surrogate", { idempotency_key: "\udc00" }],
    ["an idempotency key with a space at the end", { idempotency_key: "k " }],
    ["an idempotency key that is no string", { idempotency_key: 1 }],
  ])("%s", async (_, extra) => {
    await refused(() => client.query({ table: "health.runs", ...extra } as never));
    await refused(() =>
      client.resolve({ id: PI, decision: "confirm", item_ver: "iv_1", ...extra } as never),
    );
  });

  it("a token not of a token's form, nothing sent", async () => {
    for (const token of ["", "a b", "tok\n", "令牌", "x\u007f"]) {
      const bad = createClient({ socketPath, token });
      await refused(() => bad.catalog({}), /token's form/);
    }
  });

  it("connections.revoke with anything besides its id", async () => {
    await refused(
      () => client.connections.revoke({ id: CI, reason: "x" } as never),
      /takes only id, not reason/,
    );
  });

  it("a task with spaces inside is sent as it is", async () => {
    expect(
      req(await sent(() => client.query({ table: "health.runs", task: "tidy the bills" }))),
    ).toMatchObject({ task: "tidy the bills" });
  });

  it("task and idempotency key go as their UTF-8 bytes", async () => {
    // Node gives a header's bytes one character each: taken back as bytes, they are the UTF-8.
    const bytes = (h: string | string[] | undefined) =>
      Buffer.from(h as string, "latin1").toString("utf8");
    for (const [task, key] of [
      ["整理账单", "记一笔·午饭"],
      ["café", "naïve"],
      ["a\u0085b", "😀"],
    ] as const) {
      const s = await sent(() =>
        client.resolve({
          id: PI,
          decision: "confirm",
          item_ver: "iv_1",
          task,
          idempotency_key: key,
        }),
      );
      expect([bytes(s.headers["x-task-id"]), bytes(s.headers["idempotency-key"])]).toEqual([
        task,
        key,
      ]);
    }
  });
});

describe("reads with a body", () => {
  it("query and history post their parameters, task in the header only", async () => {
    expect(
      req(await sent(() => client.query({ table: "health.runs", limit: 3, task: "t-1" }))),
    ).toEqual({
      method: "POST",
      url: "/v1/query",
      task: "t-1",
      key: undefined,
      body: { table: "health.runs", limit: 3 },
    });
    expect(
      req(await sent(() => client.history({ mode: "timeline", table: "health.runs", row: "r_1" }))),
    ).toMatchObject({
      method: "POST",
      url: "/v1/history",
      body: { mode: "timeline", table: "health.runs", row: "r_1" },
    });
  });

  it("sql posts its parameters, task in the header only", async () => {
    const p = { sql: "SELECT count(*) AS n FROM runs WHERE date >= $1", params: ["2026-11-01"] };
    expect(req(await sent(() => client.sql({ ...p, max_rows: 5, task: "t-2" })))).toEqual({
      method: "POST",
      url: "/v1/sql",
      task: "t-2",
      key: undefined,
      body: { ...p, max_rows: 5 },
    });
  });
});

describe("pending and resolve", () => {
  it("lists with a query string, reads one by its path", async () => {
    expect(
      req(await sent(() => client.pending({ slot: "health", status: "all", limit: 10 }))),
    ).toMatchObject({ method: "GET", url: "/v1/pending?slot=health&status=all&limit=10" });
    expect(req(await sent(() => client.pending()))).toMatchObject({ url: "/v1/pending" });
    expect(req(await sent(() => client.pending({ id: PI })))).toMatchObject({
      url: `/v1/pending/${PI}`,
    });
  });

  it("resolve puts the id in the path and the idempotency key in its header", async () => {
    expect(
      req(
        await sent(() =>
          client.resolve({
            id: PI,
            decision: "confirm",
            item_ver: "iv_1",
            idempotency_key: "k-1",
            task: "t-2",
          }),
        ),
      ),
    ).toEqual({
      method: "POST",
      url: `/v1/pending/${PI}/resolution`,
      task: "t-2",
      key: "k-1",
      body: { decision: "confirm", item_ver: "iv_1" },
    });
  });

  it("schema_draft posts the document", async () => {
    expect(
      req(
        await sent(() =>
          client.schemaDraft({ document: { slot: "health" }, idempotency_key: "k-2" }),
        ),
      ),
    ).toEqual({
      method: "POST",
      url: "/v1/drafts",
      task: undefined,
      key: "k-2",
      body: { document: { slot: "health" } },
    });
  });
});

describe("administration", () => {
  it("connections.* and reads.list, log.verify and log.end by their routes", async () => {
    expect(
      req(
        await sent(() =>
          client.connections.issue({ name: "MacBook · Codex", scopes: ["saveslot.read"] }),
        ),
      ),
    ).toMatchObject({
      method: "POST",
      url: "/v1/connections",
      body: { name: "MacBook · Codex", scopes: ["saveslot.read"] },
    });
    expect(
      req(await sent(() => client.connections.list({ include_revoked: true, limit: 50 }))),
    ).toMatchObject({ method: "GET", url: "/v1/connections?include_revoked=true&limit=50" });
    expect(req(await sent(() => client.connections.update({ id: CI, name: "renamed" })))).toEqual({
      method: "PATCH",
      url: `/v1/connections/${CI}`,
      task: undefined,
      key: undefined,
      body: { name: "renamed" },
    });
    expect(req(await sent(() => client.connections.revoke({ id: CI })))).toEqual({
      method: "DELETE",
      url: `/v1/connections/${CI}`,
      task: undefined,
      key: undefined,
      body: undefined,
    });
    expect(
      req(
        await sent(() =>
          client.readsList({ connection: "MacBook · Codex", since: "2026-11-17T00:00:00Z" }),
        ),
      ),
    ).toMatchObject({
      method: "GET",
      url: "/v1/reads?connection=MacBook%20%C2%B7%20Codex&since=2026-11-17T00%3A00%3A00Z",
    });
    expect(req(await sent(() => client.logVerify()))).toMatchObject({
      method: "GET",
      url: "/v1/log/verify",
    });
    expect(req(await sent(() => client.logEnd()))).toMatchObject({
      method: "GET",
      url: "/v1/log/end",
    });
  });

  it("percent-encodes what goes in a path, in every call that puts something there", async () => {
    const x = "a/b?c#d %e·";
    const e = encodeURIComponent(x);
    expect(e).toBe("a%2Fb%3Fc%23d%20%25e%C2%B7");
    const id = x as typeof PI & typeof CI;
    const urls = [
      () => client.catalog({ slot: x }),
      () => client.catalog({ level: "schema", slot: x }),
      () => client.catalog({ level: "table", tables: [x] }),
      () => client.catalog({ level: "table", tables: [`${x}.${x}`] }),
      () => client.pending({ id }),
      () => client.resolve({ id, decision: "confirm", item_ver: "iv_1" }),
      () => client.connections.update({ id, name: "n" }),
      () => client.connections.revoke({ id }),
    ];
    const got: string[] = [];
    for (const call of urls) got.push((await sent(call)).url);
    expect(got).toEqual([
      `/v1/slots/${e}`,
      `/v1/slots/${e}/schema`,
      `/v1/tables/${e}`,
      // The first dot splits slot from table; the table keeps the rest.
      `/v1/slots/a%2Fb%3Fc%23d%20%25e%C2%B7/tables/${e}`,
      `/v1/pending/${e}`,
      `/v1/pending/${e}/resolution`,
      `/v1/connections/${e}`,
      `/v1/connections/${e}`,
    ]);
  });
});

describe("options of the client", () => {
  it("catalog table with a slot is refused: the slot goes in the table name", async () => {
    seen = [];
    await expect(
      client.catalog({ level: "table", slot: "health", tables: ["runs"] }),
    ).rejects.toThrow(ClientUsageError);
    expect(seen).toEqual([]);
  });

  it("the time limit is passed down to each request", async () => {
    const quick = createClient({ socketPath, token: TOKEN, timeoutMs: 100 });
    const started = Date.now();
    await expect(quick.query({ table: "health.runs", task: "hang" })).rejects.toMatchObject({
      name: "TransportError",
      code: "broken",
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
