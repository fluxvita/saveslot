// HTTP to a server at its external address (06-cli §2: a server profile): which addresses are
// taken, what is sent over loopback HTTP, and that a token never leaves for another place: not
// over a redirect, not in the clear when TLS fails.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "./client.ts";
import {
  ClientUsageError,
  ContractCallError,
  request,
  requestStream,
  serverOrigin,
  TransportError,
} from "./transport.ts";

const TOKEN = `sls_${"b".repeat(43)}`;

const servers: (Server | TcpServer)[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    if ("closeAllConnections" in s) s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/** A loopback HTTP server answering with `answer`; its origin and what it was sent. */
async function serve(answer: (req: IncomingMessage, res: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      } as Seen);
      answer(req, res);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, seen };
}

const json = (res: ServerResponse, status: number, v: unknown, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
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

describe("the server's address", () => {
  it("an origin: https, or http on a loopback address", () => {
    for (const ok of [
      "https://saveslot.example",
      "https://saveslot.example:8443",
      "https://saveslot.example/",
      "http://127.0.0.1:9",
      "http://[::1]:9",
      "http://localhost:9",
    ]) {
      expect([ok, serverOrigin(ok).origin]).toEqual([ok, new URL(ok).origin]);
    }
  });

  it("anything else: a usage error", () => {
    for (const bad of [
      "http://saveslot.example",
      "http://10.0.0.1",
      "ftp://saveslot.example",
      "https://user:pass@saveslot.example",
      "https://saveslot.example/v1",
      "https://saveslot.example?x=1",
      "https://saveslot.example#x",
      "saveslot.example",
      "",
      42,
    ]) {
      let e: unknown;
      try {
        serverOrigin(bad);
      } catch (x) {
        e = x;
      }
      expect([bad, e instanceof ClientUsageError]).toEqual([bad, true]);
    }
  });

  it("a socket path and a server both: a usage error, nothing sent", async () => {
    const { origin, seen } = await serve((_, res) => json(res, 200, {}));
    const e = await thrown(
      request({
        server: origin,
        socketPath: "/tmp/s.sock",
        method: "GET",
        path: "/v1/slots",
      } as never),
    );
    expect(e).toBeInstanceOf(ClientUsageError);
    expect(seen).toEqual([]);
  });
});

describe("over loopback HTTP", () => {
  it("a POST: the token, the task, the JSON body; the result", async () => {
    const { origin, seen } = await serve((_, res) => json(res, 200, { status: "saved" }));
    const r = await request({
      server: origin,
      method: "POST",
      path: "/v1/writes",
      token: TOKEN,
      task: "weekly",
      body: { sv: 1, ops: [] },
    });
    expect(r).toEqual({ status: "saved" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/v1/writes", body: '{"sv":1,"ops":[]}' });
    expect(seen[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]?.headers["x-task-id"]).toBe("weekly");
  });

  it("a contract error: its code and fields, as from the socket", async () => {
    const { origin } = await serve((_, res) =>
      json(res, 403, {
        error: { code: "insufficient_scope", message: "m", required_scope: "all_slots" },
      }),
    );
    const e = await thrown(
      request({ server: origin, method: "GET", path: "/v1/slots", token: TOKEN }),
    );
    expect(e).toBeInstanceOf(ContractCallError);
    expect(e).toMatchObject({ code: "insufficient_scope", status: 403 });
  });

  it("the client's calls: on the server's routes", async () => {
    const { origin, seen } = await serve((_, res) => json(res, 200, { level: "list", slots: [] }));
    const c = createClient({ server: origin, token: TOKEN });
    expect(await c.catalog({})).toEqual({ level: "list", slots: [] });
    expect(seen[0]?.url).toBe("/v1/slots");
    expect(seen[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
  });
});

describe("a streamed answer from the server", () => {
  it("over loopback HTTP: the body read as it comes, the token sent", async () => {
    const { origin, seen } = await serve((_, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write('{"a":1}\n');
      res.end('{"b":2}\n');
    });
    const res = await requestStream({
      server: origin,
      method: "GET",
      path: "/v1/export",
      token: TOKEN,
    });
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString("utf8")).toBe('{"a":1}\n{"b":2}\n');
    expect(seen[0]?.url).toBe("/v1/export");
    expect(seen[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("a redirect is not followed: bad_answer, and its target is sent nothing", async () => {
    const elsewhere = await serve((_, res) => json(res, 200, {}));
    const { origin } = await serve((_, res) => {
      res.writeHead(302, { location: `${elsewhere.origin}/v1/export` });
      res.end();
    });
    const e = await thrown(
      requestStream({ server: origin, method: "GET", path: "/v1/export", token: TOKEN }),
    );
    expect(e).toBeInstanceOf(TransportError);
    expect(e).toMatchObject({ code: "bad_answer", status: 302 });
    expect(elsewhere.seen).toEqual([]);
  });
});

describe("the token goes nowhere else", () => {
  it("a redirect is not followed: bad_answer, and its target is sent nothing", async () => {
    const elsewhere = await serve((_, res) => json(res, 200, {}));
    const { origin } = await serve((_, res) => {
      res.writeHead(302, { location: `${elsewhere.origin}/v1/slots` });
      res.end();
    });
    const e = await thrown(
      request({ server: origin, method: "GET", path: "/v1/slots", token: TOKEN }),
    );
    expect(e).toBeInstanceOf(TransportError);
    expect(e).toMatchObject({ code: "bad_answer", status: 302 });
    expect(elsewhere.seen).toEqual([]);
  });

  it("https to a server that speaks no TLS: broken, and no request reaches it", async () => {
    // A plain TCP server on loopback: what it is sent is only a TLS handshake, never the token.
    let received = Buffer.alloc(0);
    const tcp = createTcpServer((socket) => {
      socket.on("data", (c: Buffer) => {
        received = Buffer.concat([received, c]);
        socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}");
      });
    });
    servers.push(tcp);
    await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
    const { port } = tcp.address() as AddressInfo;
    const e = await thrown(
      request({
        server: `https://127.0.0.1:${port}`,
        method: "GET",
        path: "/v1/slots",
        token: TOKEN,
        timeoutMs: 10_000,
      }),
    );
    expect(e).toBeInstanceOf(TransportError);
    expect(e).toMatchObject({ code: "broken" });
    expect(received.includes(Buffer.from(TOKEN))).toBe(false);
    expect(received.includes(Buffer.from("/v1/slots"))).toBe(false);
  });
});

describe("the server not reachable", () => {
  it("nobody listening at the port: unreachable, said of the server", async () => {
    const probe = createTcpServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const { port } = probe.address() as AddressInfo;
    await new Promise((r) => probe.close(r));
    const e = await thrown(
      request({
        server: `http://127.0.0.1:${port}`,
        method: "GET",
        path: "/v1/slots",
        token: TOKEN,
      }),
    );
    expect(e).toMatchObject({
      code: "unreachable",
      message: "the saveslot server is not reachable",
    });
  });
});
