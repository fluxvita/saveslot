// HTTP over a unix socket against a stand-in server: what is sent, and how each kind of answer
// comes back.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClientUsageError,
  ContractCallError,
  MAX_ANSWER_BYTES,
  request,
  TransportError,
} from "./transport.ts";

const TOKEN = `sls_${"a".repeat(43)}`;

let dir: string;
let socketPath: string;
let server: Server | undefined;
let seen: { method?: string; url?: string; headers: IncomingMessage["headers"]; body: string };

async function serve(answer: (req: IncomingMessage, res: ServerResponse) => void): Promise<void> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      } as typeof seen;
      answer(req, res);
    });
  });
  await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
}

const json = (res: ServerResponse, status: number, v: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(v));
};

async function thrown(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    expect(String((e as Error).message)).not.toContain(TOKEN);
    return e;
  }
  throw new Error("did not throw");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "saveslot-client-http-"));
  socketPath = join(dir, "s.sock");
});
afterEach(async () => {
  if (server !== undefined) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("what is sent", () => {
  it("a POST: the token, the task, the JSON body", async () => {
    await serve((_, res) => json(res, 200, { ok: 1 }));
    const r = await request({
      socketPath,
      method: "POST",
      path: "/v1/query",
      token: TOKEN,
      task: "t-1",
      body: { table: "runs", where: [{ field: "distance", op: ">", value: "5" }] },
    });
    expect(r).toEqual({ ok: 1 });
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/v1/query");
    expect(seen.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(seen.headers["x-task-id"]).toBe("t-1");
    expect(seen.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(seen.body)).toEqual({
      table: "runs",
      where: [{ field: "distance", op: ">", value: "5" }],
    });
  });

  it("a GET: the query string percent-encoded, no body, no token or task when not given", async () => {
    await serve((_, res) => json(res, 200, []));
    await request({
      socketPath,
      method: "GET",
      path: "/v1/reads",
      query: new Map([
        ["connection", "MacBook · Codex&x=1"],
        ["a b&c=d", "1"],
        ["limit", "20"],
      ]),
    });
    expect(seen.url).toBe(
      `/v1/reads?connection=${encodeURIComponent("MacBook · Codex&x=1")}&a%20b%26c%3Dd=1&limit=20`,
    );
    expect(seen.body).toBe("");
    expect(seen.headers).not.toHaveProperty("authorization");
    expect(seen.headers).not.toHaveProperty("x-task-id");
  });
});

describe("answers", () => {
  it("a contract error: its code, status and every field", async () => {
    await serve((_, res) =>
      json(res, 409, {
        error: { code: "confirmation_mismatch", message: "changed", item_ver: "iv_1" },
      }),
    );
    const e = await thrown(request({ socketPath, method: "GET", path: "/v1/pending/x" }));
    expect(e).toBeInstanceOf(ContractCallError);
    expect(e).toMatchObject({
      code: "confirmation_mismatch",
      status: 409,
      message: "changed",
      body: { code: "confirmation_mismatch", message: "changed", item_ver: "iv_1" },
    });
  });

  it.each([
    ["no body", 404, ""],
    ["a body that is not JSON", 500, "<html>"],
    ["JSON without an error", 400, '{"code":"x"}'],
    ["an error without a code", 400, '{"error":{"message":"x"}}'],
    ["an error that is an array", 400, '{"error":["x"]}'],
  ])("an error status with %s: bad_answer", async (_, status, text) => {
    await serve((_, res) => {
      res.writeHead(status);
      res.end(text);
    });
    const e = await thrown(request({ socketPath, method: "GET", path: "/v1/slots", token: TOKEN }));
    expect(e).toBeInstanceOf(TransportError);
    expect(e).toMatchObject({ code: "bad_answer", status });
  });

  it("the 401 of a request without a token: a contract error", async () => {
    await serve((_, res) => json(res, 401, { error: { code: "unauthenticated", message: "x" } }));
    expect(await thrown(request({ socketPath, method: "GET", path: "/v1/slots" }))).toMatchObject({
      code: "unauthenticated",
      status: 401,
    });
  });

  it("an answer past the size limit: bad_answer, too large", async () => {
    await serve((_, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      let left = MAX_ANSWER_BYTES + 1;
      const more = () => {
        while (left > 0) {
          const c = left >= chunk.length ? chunk : chunk.subarray(0, left);
          left -= c.length;
          if (!res.write(c)) return void res.once("drain", more);
        }
        res.end();
      };
      more();
    });
    const e = await thrown(request({ socketPath, method: "GET", path: "/v1/slots", token: TOKEN }));
    expect(e).toBeInstanceOf(TransportError);
    expect(e).toMatchObject({ code: "bad_answer", message: "the answer is too large" });
  });

  it.each([201, 204, 299])("a %d with a JSON body: the result", async (status) => {
    await serve((_, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 204 ? undefined : '{"ok":1}');
    });
    const p = request({ socketPath, method: "GET", path: "/v1/slots" });
    if (status === 204) {
      // No body is no JSON.
      expect(await thrown(p)).toMatchObject({ code: "bad_answer", status });
    } else {
      expect(await p).toEqual({ ok: 1 });
    }
  });

  it.each([
    [301, '{"ok":1}'],
    [304, ""],
  ])("a %d: no success", async (status, text) => {
    await serve((_, res) => {
      res.writeHead(status, { "content-type": "application/json", location: "/v1/x" });
      res.end(text === "" ? undefined : text);
    });
    expect(await thrown(request({ socketPath, method: "GET", path: "/v1/slots" }))).toMatchObject({
      code: "bad_answer",
    });
  });

  it("an error body is read from its own keys only", async () => {
    const proto = Object.prototype as Record<string, unknown>;
    await serve((req, res) =>
      req.url === "/a" ? json(res, 400, {}) : json(res, 400, { error: {} }),
    );
    try {
      proto["error"] = { code: "inherited" };
      proto["code"] = "inherited";
      expect(await thrown(request({ socketPath, method: "GET", path: "/a" }))).toMatchObject({
        code: "bad_answer",
      });
      expect(await thrown(request({ socketPath, method: "GET", path: "/b" }))).toMatchObject({
        code: "bad_answer",
      });
    } finally {
      delete proto["error"];
      delete proto["code"];
    }
  });

  it("a contract error's message is its own message only", async () => {
    const proto = Object.prototype as Record<string, unknown>;
    await serve((_, res) => json(res, 404, { error: { code: "not_found" } }));
    try {
      proto["message"] = "inherited";
      expect(await thrown(request({ socketPath, method: "GET", path: "/a" }))).toMatchObject({
        message: "not_found",
      });
    } finally {
      delete proto["message"];
    }
  });

  it("a 200 that is not JSON: bad_answer", async () => {
    await serve((_, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    expect(await thrown(request({ socketPath, method: "GET", path: "/v1/slots" }))).toMatchObject({
      code: "bad_answer",
    });
  });

  it("an answer cut off: broken", async () => {
    await serve((_, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write('{"a":');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    expect(await thrown(request({ socketPath, method: "GET", path: "/v1/slots" }))).toMatchObject({
      code: "broken",
    });
  });

  it("no answer in time: broken", async () => {
    await serve(() => {});
    expect(
      await thrown(
        request({ socketPath, method: "GET", path: "/v1/slots", token: TOKEN, timeoutMs: 100 }),
      ),
    ).toMatchObject({ code: "broken" });
  });

  it("an answer trickling in past the time limit: broken, at the limit", async () => {
    let timer: NodeJS.Timeout | undefined;
    await serve((_, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      timer = setInterval(() => res.write(" "), 20);
      res.on("close", () => clearInterval(timer));
    });
    const started = Date.now();
    expect(
      await thrown(
        request({ socketPath, method: "GET", path: "/v1/slots", token: TOKEN, timeoutMs: 200 }),
      ),
    ).toMatchObject({ code: "broken", message: "the service did not answer in time" });
    expect(Date.now() - started).toBeLessThan(1000);
    clearInterval(timer);
  });
});

describe("the service not reachable", () => {
  // With the token given, so that `thrown` checks it is in no message.
  it("no socket file: unreachable", async () => {
    expect(
      await thrown(request({ socketPath, method: "GET", path: "/v1/slots", token: TOKEN })),
    ).toMatchObject({ code: "unreachable" });
  });

  it("a file nobody listens on: unreachable", async () => {
    await writeFile(socketPath, "");
    expect(
      await thrown(request({ socketPath, method: "GET", path: "/v1/slots", token: TOKEN })),
    ).toMatchObject({ code: "unreachable" });
  });
});

describe("options that cannot go on the wire", () => {
  it.each([
    ["empty", ""],
    ["absent", undefined],
    ["relative", "s.sock"],
  ])("a socket path %s: refused from the promise, nothing sent", async (_, path) => {
    await serve((_, res) => json(res, 200, {}));
    seen = { headers: {}, body: "" };
    let p: Promise<unknown> | undefined;
    expect(() => {
      p = request({ socketPath: path as string, method: "GET", path: "/v1/slots", token: TOKEN });
    }).not.toThrow();
    const e = await thrown(p as Promise<unknown>);
    expect(e).toBeInstanceOf(ClientUsageError);
    expect(e).toMatchObject({ message: "the socket path must be an absolute path" });
    expect(seen).toEqual({ headers: {}, body: "" });
  });

  it.each([0, -1, 1.5, Number.NaN, 2 ** 31])("a time limit of %d ms: refused", async (t) => {
    expect(
      await thrown(request({ socketPath, method: "GET", path: "/v1/slots", timeoutMs: t })),
    ).toBeInstanceOf(ClientUsageError);
  });
});
