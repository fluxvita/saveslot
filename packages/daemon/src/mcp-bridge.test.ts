// `saveslot mcp` (06-cli §2, §3 step 3, §4.1, §8.1; 05-surfaces §11): the headers derived from a
// message, the SSE parsing, then the bridge against a stand-in service (what a real one does not
// do on demand), against a real one in this process, and spawned as a host spawns it, driven by
// the official SDK client over stdio in both protocol eras.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { initLocalHome, sessionFile } from "@fluxvita/saveslot-service";
import { osFileLock } from "@fluxvita/saveslot-store-pglite";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import { stop } from "./commands.ts";
import { homeTemplate } from "./home-copy.fixture.ts";
import { httpDriver } from "./http-driver.fixture.ts";
import { health } from "./local-request.ts";
import {
  encodeHeaderValue,
  idOf,
  MAX_IN_FLIGHT,
  MAX_LINE_BYTES,
  MAX_QUEUED,
  runBridge,
  sseData,
  standardHeaders,
} from "./mcp-bridge.ts";
import { type RunningService, runService, socketFile } from "./service.ts";
import { TEXTS } from "./texts.ts";

const T = 60_000;
const MODERN = "2026-07-28";
const META = "io.modelcontextprotocol/protocolVersion";
/** A token of the connection instance form that no service knows. */
const UNKNOWN_TOKEN = `slt_${"A".repeat(43)}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(p: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!p()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(10);
  }
}

describe("the headers derived from a message (2026-07-28)", () => {
  const request = (params: unknown, more: Record<string, unknown> = {}) => ({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params,
    ...more,
  });

  it("a request with an envelope: version, method and the name it names", () => {
    expect(
      standardHeaders(request({ name: "saveslot_catalog", _meta: { [META]: MODERN } })),
    ).toEqual({
      "mcp-protocol-version": MODERN,
      "mcp-method": "tools/call",
      "mcp-name": "saveslot_catalog",
    });
    expect(
      standardHeaders({
        jsonrpc: "2.0",
        id: "r",
        method: "resources/read",
        params: { uri: "saveslot://x", _meta: { [META]: MODERN } },
      }),
    ).toEqual({
      "mcp-protocol-version": MODERN,
      "mcp-method": "resources/read",
      "mcp-name": "saveslot://x",
    });
    expect(
      standardHeaders({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: { _meta: { [META]: MODERN } },
      }),
    ).toEqual({ "mcp-protocol-version": MODERN, "mcp-method": "tools/list" });
  });

  it("a name that cannot be a header as it is: base64 of its UTF-8, as the SDK encodes it", () => {
    const h = standardHeaders(request({ name: "跑步", _meta: { [META]: MODERN } }));
    expect(h["mcp-name"]).toBe(`=?base64?${Buffer.from("跑步").toString("base64")}?=`);
    expect(encodeHeaderValue("plain_name")).toBe("plain_name");
    for (const s of ["", " lead", "trail ", "a\nb", "=?base64?abc?="]) {
      expect(encodeHeaderValue(s)).toBe(`=?base64?${Buffer.from(s).toString("base64")}?=`);
    }
  });

  it("no envelope, or one of the wrong shape: no headers, and nothing thrown", () => {
    const cases: unknown[] = [
      null,
      7,
      "x",
      [request({ _meta: { [META]: MODERN } })], // a batch
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: { _meta: { [META]: MODERN } },
      },
      request(undefined),
      request("params"),
      request([{ _meta: { [META]: MODERN } }]),
      request({ _meta: "meta" }),
      request({ _meta: [MODERN] }),
      request({ _meta: null }),
      request({ _meta: { [META]: 20260728 } }),
      request({ _meta: { [META]: null } }),
      request({ _meta: { [META]: "2026-07-28\r\nx-evil: 1" } }),
      request({ _meta: { [META]: "版本" } }),
      request({ _meta: { [META]: MODERN } }, { method: 7 }),
      request({ _meta: { [META]: MODERN } }, { method: "tools/call\n" }),
      // Inherited, not own: `__proto__` from JSON is an own key of the object, not of `_meta`.
      JSON.parse(
        `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"__proto__":{"${META}":"${MODERN}"}}}}`,
      ),
      { jsonrpc: "2.0", method: "tools/list", params: { _meta: { [META]: MODERN } } }, // no id
    ];
    for (const c of cases) expect(standardHeaders(c)).toEqual({});
  });

  it("a name that is not a string, or a method that names nothing: no mcp-name", () => {
    for (const name of [7, null, { n: "x" }, ["x"]]) {
      expect(standardHeaders(request({ name, _meta: { [META]: MODERN } }))).toEqual({
        "mcp-protocol-version": MODERN,
        "mcp-method": "tools/call",
      });
    }
    for (const method of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(
        standardHeaders({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: { name: "n", _meta: { [META]: MODERN } },
        }),
      ).toEqual({ "mcp-protocol-version": MODERN, "mcp-method": method });
    }
  });

  it("an error answer echoes the id with its type; an id it cannot read is null", () => {
    expect(idOf({ id: 7 })).toBe(7);
    expect(idOf({ id: "7" })).toBe("7");
    expect(idOf({ id: null })).toBe(null);
    expect(idOf({ id: { a: 1 } })).toBe(null);
    expect(idOf({})).toBe(null);
    expect(idOf([{ id: 1 }])).toBe(null);
    expect(idOf(JSON.parse('{"__proto__":{"id":5}}'))).toBe(null);
  });
});

describe("SSE", () => {
  it("joins the data lines of an event, keeps events in order, ignores the rest", () => {
    const body = [
      ": a comment",
      "event: message",
      "id: 1",
      'data: {"a":',
      "data: 1}",
      "",
      "retry: 10",
      'data:{"b":2}',
      "",
      "",
    ].join("\r\n");
    expect(sseData(body)).toEqual(['{"a":\n1}', '{"b":2}']);
    expect(sseData('data: {"c":3}')).toEqual(['{"c":3}']);
  });
});

/** The bridge's streams in this process: what it wrote to stdout, line by line, and to stderr. */
function bridgeStreams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines: string[] = [];
  let buf = "";
  stdout.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  const err: string[] = [];
  return { stdin, stdout, lines, err, log: (l: string) => err.push(l) };
}

interface Seen {
  readonly headers: IncomingMessage["headers"];
  readonly body: Buffer;
}

/** A stand-in service on a socket: `/health` as given, `/mcp` by `answer`. */
function standIn() {
  const root = mkdtempSync(join(tmpdir(), "saveslot-bridge-"));
  // Where a home's socket is: a bridge spawned with `--home root` talks to it.
  mkdirSync(join(root, "run"), { mode: 0o700 });
  const socketPath = socketFile(root);
  const s = {
    home: root,
    socketPath,
    seen: [] as Seen[],
    /** How many times `/health` was asked. */
    healthAsked: 0,
    health: { state: "ready", version: "t", pid: 1, since: "2026-11-17T00:00:00Z" } as Record<
      string,
      unknown
    >,
    answer: (_: Seen, res: ServerResponse): void => {
      res.writeHead(202).end();
    },
  };
  let server: Server;
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.url === "/health") {
          s.healthAsked++;
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(s.health));
          return;
        }
        const seen = { headers: req.headers, body: Buffer.concat(chunks) };
        s.seen.push(seen);
        s.answer(seen, res);
      });
    });
    await new Promise<void>((r) => server.listen(socketPath, r));
  });
  afterEach(() => {
    s.seen.length = 0;
    s.healthAsked = 0;
    s.health = { state: "ready", version: "t", pid: 1, since: "2026-11-17T00:00:00Z" };
    s.answer = (_, res) => {
      res.writeHead(202).end();
    };
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  });
  return s;
}

const json = (res: ServerResponse, status: number, v: unknown) => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
};

describe("the bridge against a stand-in service", () => {
  const s = standIn();
  const bridge = (more: { token?: string; forwardTimeoutMs?: number } = {}) => {
    const io = bridgeStreams();
    const exit = runBridge({
      token: more.token ?? UNKNOWN_TOKEN,
      stdin: io.stdin,
      stdout: io.stdout,
      log: io.log,
      autostart: false,
      startService: async () => 7,
      version: "t",
      socketPath: s.socketPath,
      ...(more.forwardTimeoutMs !== undefined ? { forwardTimeoutMs: more.forwardTimeoutMs } : {}),
    });
    const send = (v: unknown) => io.stdin.write(`${JSON.stringify(v)}\n`);
    return { ...io, exit, send };
  };

  it("an SSE answer: every event in order, each one line; data lines joined", async () => {
    s.answer = (_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        'event: message\ndata: {"jsonrpc":"2.0",\ndata: "method":"notifications/progress","params":{"p":1}}\n\n' +
          'data: {"jsonrpc":"2.0","id":3,\ndata:  "result":{"x":"a\\nb"}}\n\n',
      );
    };
    const b = bridge();
    b.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    b.stdin.end();
    expect(await b.exit).toBe(0);
    expect(b.lines.map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: "2.0", method: "notifications/progress", params: { p: 1 } },
      { jsonrpc: "2.0", id: 3, result: { x: "a\nb" } },
    ]);
  });

  it("--record: a 2026-07-28 request's envelope gives the protocol line", async () => {
    s.answer = (seen, res) => {
      const m = JSON.parse(seen.body.toString("utf8")) as { id: number };
      json(res, 200, { jsonrpc: "2.0", id: m.id, result: {} });
    };
    const lines: string[] = [];
    const record = {
      message: (dir: "in" | "out", line: string) => lines.push(`${dir} ${line}`),
      protocol: (v: string) => lines.push(`protocol ${v}`),
      close: () => {},
    };
    const io = bridgeStreams();
    const exit = runBridge({
      token: UNKNOWN_TOKEN,
      stdin: io.stdin,
      stdout: io.stdout,
      log: io.log,
      autostart: false,
      startService: async () => 7,
      version: "t",
      socketPath: s.socketPath,
      record,
    });
    io.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { [META]: MODERN } } })}\n`,
    );
    io.stdin.end();
    expect(await exit).toBe(0);
    expect(lines.map((l) => l.split(" ")[0])).toEqual(["in", "protocol", "out"]);
    expect(lines[1]).toBe(`protocol ${MODERN}`);
  });

  it("--record: a write that fails ends the bridge, exit 1, record_failed", async () => {
    s.answer = (seen, res) => {
      const m = JSON.parse(seen.body.toString("utf8")) as { id: number };
      json(res, 200, { jsonrpc: "2.0", id: m.id, result: {} });
    };
    let n = 0;
    const record = {
      message: () => {
        n++;
        if (n === 2) throw new Error("ENOSPC");
      },
      protocol: () => {},
      close: () => {},
    };
    const io = bridgeStreams();
    const exit = runBridge({
      token: UNKNOWN_TOKEN,
      stdin: io.stdin,
      stdout: io.stdout,
      log: io.log,
      autostart: false,
      startService: async () => 7,
      version: "t",
      socketPath: s.socketPath,
      record,
    });
    io.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    expect(await exit).toBe(1);
    expect(io.err).toContain(TEXTS.mcpEvent("record_failed"));
    // The answer whose record failed is not written either.
    expect(io.lines).toEqual([]);
  });

  it("a notification: forwarded, nothing written", async () => {
    const b = bridge();
    b.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    b.stdin.end();
    expect(await b.exit).toBe(0);
    expect(s.seen).toHaveLength(1);
    expect(b.lines).toEqual([]);
  });

  it("a batch: forwarded byte for byte, the answer written as it is", async () => {
    s.answer = (_, res) =>
      json(res, 200, [
        { jsonrpc: "2.0", id: 1, result: {} },
        { jsonrpc: "2.0", id: "b", result: {} },
      ]);
    const b = bridge();
    const line =
      '[{"jsonrpc":"2.0","id":1,"method":"ping"},  {"jsonrpc":"2.0","id":"b","method":"ping"}]';
    b.stdin.end(`${line}\n`);
    expect(await b.exit).toBe(0);
    expect(s.seen[0]?.body.toString("utf8")).toBe(line);
    expect(b.lines).toEqual([
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, result: {} },
        { jsonrpc: "2.0", id: "b", result: {} },
      ]),
    ]);
  });

  it("an answer that is not JSON-RPC: -32603 to that id, with the id's type kept", async () => {
    s.answer = (seen, res) => {
      if (JSON.parse(seen.body.toString()).id === 7) {
        res.writeHead(500, { "content-type": "text/plain" }).end("boom");
      } else json(res, 200, { not: "json-rpc" });
    };
    const b = bridge();
    b.send({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    b.send({ jsonrpc: "2.0", id: "7", method: "tools/list" });
    b.send({ jsonrpc: "2.0", method: "notifications/x" });
    b.stdin.end();
    expect(await b.exit).toBe(0);
    const out = b.lines.map((l) => JSON.parse(l) as { id: unknown; error: { code: number } });
    const pairs = out.map((o) => [o.id, o.error.code]);
    expect(pairs).toHaveLength(2);
    expect(pairs).toContainEqual([7, -32603]);
    expect(pairs).toContainEqual(["7", -32603]);
  });

  it("the service's own JSON-RPC error (a 400): passed on, with the request's id", async () => {
    s.answer = (_, res) =>
      json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32020, message: "headers" } });
    const b = bridge();
    b.send({ jsonrpc: "2.0", id: 9, method: "tools/list" });
    b.stdin.end();
    expect(await b.exit).toBe(0);
    expect(JSON.parse(b.lines[0] as string)).toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32020, message: "headers" },
    });
  });

  it("the service's JSON-RPC error with an id of its own, or to a batch: passed on untouched", async () => {
    const theirs = {
      jsonrpc: "2.0",
      id: "its-own",
      error: { code: -32602, message: "m", data: { k: 1 } },
    };
    const batchErr = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch" } };
    s.answer = (seen, res) =>
      json(res, 400, seen.body.toString().startsWith("[") ? batchErr : theirs);
    const b = bridge();
    b.send({ jsonrpc: "2.0", id: 9, method: "tools/list" });
    await until(() => b.lines.length === 1);
    b.send([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    b.stdin.end();
    expect(await b.exit).toBe(0);
    expect(b.lines.map((l) => JSON.parse(l))).toEqual([theirs, batchErr]);
  });

  it("a batch holding a request, when the answer fails: one error with id null", async () => {
    s.answer = (_, res) => res.writeHead(500, { "content-type": "text/plain" }).end("boom");
    const b = bridge();
    b.send([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "n" },
    ]);
    b.send([{ jsonrpc: "2.0", method: "only/notifications" }]);
    b.stdin.end();
    expect(await b.exit).toBe(0);
    expect(b.lines.map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32603, message: expect.any(String) } },
    ]);
  });

  it("503: -32000, the service is not available", async () => {
    s.answer = (_, res) => json(res, 503, { error: { code: "unavailable" } });
    const b = bridge();
    b.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    b.stdin.end();
    expect(await b.exit).toBe(0);
    expect(JSON.parse(b.lines[0] as string).error.code).toBe(-32000);
  });

  it("a line that is not JSON, not an object or an array, or longer than 1 MiB: an error with id null, not forwarded", async () => {
    s.answer = (_, res) => json(res, 200, { jsonrpc: "2.0", id: 1, result: {} });
    const b = bridge();
    b.stdin.write("{not json\n");
    b.stdin.write("\n   \n");
    b.stdin.write("42\n");
    // One byte over the limit, in pieces; then a line of exactly the limit (not JSON: -32700).
    const over = Buffer.alloc(MAX_LINE_BYTES + 1, 0x20);
    over[0] = 0x7b;
    b.stdin.write(over.subarray(0, 1000));
    b.stdin.write(over.subarray(1000));
    b.stdin.write("\n");
    b.stdin.write(`${"x".repeat(MAX_LINE_BYTES)}\r\n`);
    b.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    b.stdin.end();
    expect(await b.exit).toBe(0);
    expect(b.lines.map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: expect.any(String) } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: expect.any(String) } },
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: expect.stringContaining("1 MiB") },
      },
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: expect.any(String) } },
      { jsonrpc: "2.0", id: 1, result: {} },
    ]);
    expect(s.seen).toHaveLength(1);
  });

  it("the headers: fixed ones, the version initialize negotiated, the ones an envelope gives", async () => {
    s.answer = (seen, res) => {
      const m = JSON.parse(seen.body.toString("utf8")) as { id: number; method: string };
      json(res, 200, {
        jsonrpc: "2.0",
        id: m.id,
        result: m.method === "initialize" ? { protocolVersion: "2025-11-25" } : {},
      });
    };
    const b = bridge();
    b.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await until(() => b.lines.length === 1);
    b.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await until(() => b.lines.length === 2);
    b.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "saveslot_catalog", _meta: { [META]: MODERN } },
    });
    b.stdin.end();
    expect(await b.exit).toBe(0);
    const [init, list, call] = s.seen.map((x) => x.headers);
    expect(init?.["accept"]).toBe("application/json, text/event-stream");
    expect(init?.["content-type"]).toBe("application/json");
    expect(init?.["authorization"]).toBe(`Bearer ${UNKNOWN_TOKEN}`);
    expect(init?.["mcp-protocol-version"]).toBeUndefined();
    expect(list?.["mcp-protocol-version"]).toBe("2025-11-25");
    expect(list?.["mcp-method"]).toBeUndefined();
    expect(call?.["mcp-protocol-version"]).toBe(MODERN);
    expect(call?.["mcp-method"]).toBe("tools/call");
    expect(call?.["mcp-name"]).toBe("saveslot_catalog");
    for (const h of s.seen.map((x) => x.headers)) expect(h["mcp-session-id"]).toBeUndefined();
  });

  it("backpressure: at most 8 in flight, and the input paused while they are", async () => {
    const held: ServerResponse[] = [];
    s.answer = (_, res) => {
      held.push(res);
    };
    const b = bridge();
    // Fewer than fill the queue: the pause is the in-flight limit's.
    const n = MAX_IN_FLIGHT + 12;
    for (let i = 0; i < n; i++) b.send({ jsonrpc: "2.0", id: i, method: "ping" });
    await until(() => s.seen.length === MAX_IN_FLIGHT);
    await sleep(200);
    expect(s.seen).toHaveLength(MAX_IN_FLIGHT);
    expect(b.stdin.isPaused()).toBe(true);
    // Answering lets the rest through.
    s.answer = (seen, res) =>
      json(res, 200, { jsonrpc: "2.0", id: JSON.parse(seen.body.toString()).id, result: {} });
    for (const r of held.splice(0)) s.answer({ headers: {}, body: Buffer.from('{"id":-1}') }, r);
    b.stdin.end();
    expect(await b.exit).toBe(0);
    expect(s.seen).toHaveLength(n);
  });

  it("backpressure: while the service is not ready, 64 messages queued, then the input paused", async () => {
    s.health = { ...s.health, state: "starting" };
    s.answer = (seen, res) =>
      json(res, 200, { jsonrpc: "2.0", id: JSON.parse(seen.body.toString()).id, result: {} });
    const b = bridge();
    // Lines of one length: what the bridge took is what is no longer buffered in its stdin.
    const line = (i: number) =>
      `${JSON.stringify({ jsonrpc: "2.0", id: 1000 + i, method: "ping" })}\n`;
    const n = 500;
    for (let i = 0; i < n; i++) b.stdin.write(line(i));
    await until(() => b.stdin.isPaused());
    await sleep(200);
    const left = b.stdin.readableLength + b.stdin.writableLength;
    expect((n * line(0).length - left) / line(0).length).toBe(MAX_QUEUED);
    expect(s.seen).toHaveLength(0);
    s.health = { ...s.health, state: "ready" };
    b.stdin.end();
    expect(await b.exit).toBe(0);
    expect(b.lines).toHaveLength(n);
  });

  it("backpressure: while the service is not ready, at most 8 MiB queued, then the input paused", async () => {
    s.health = { ...s.health, state: "starting" };
    s.answer = (seen, res) =>
      json(res, 200, { jsonrpc: "2.0", id: JSON.parse(seen.body.toString()).id, result: {} });
    const b = bridge();
    // Ten lines of almost 1 MiB: far fewer than 64 messages, past 8 MiB.
    const pad = "x".repeat(MAX_LINE_BYTES - 100);
    for (let i = 0; i < 10; i++) b.send({ jsonrpc: "2.0", id: i, method: "ping", params: { pad } });
    await until(() => b.stdin.isPaused());
    await sleep(200);
    expect(b.stdin.isPaused()).toBe(true);
    s.health = { ...s.health, state: "ready" };
    b.stdin.end();
    expect(await b.exit).toBe(0);
    expect(b.lines).toHaveLength(10);
  });

  it("no answer in time: -32603 to that id; whether it was carried out is not known, a resend as it was is safe", async () => {
    s.answer = () => {};
    const b = bridge({ forwardTimeoutMs: 200 });
    b.send({ jsonrpc: "2.0", id: "slow", method: "tools/list" });
    b.stdin.end();
    expect(await b.exit).toBe(0);
    expect(JSON.parse(b.lines[0] as string)).toMatchObject({
      id: "slow",
      error: { code: -32603, message: TEXTS.mcpTimedOut },
    });
    // The same words as a connection cut after the call was sent: the call surely went out.
    expect(TEXTS.mcpTimedOut).toContain("is not known");
    expect(TEXTS.mcpTimedOut).toContain("as it was, is safe");
    expect(TEXTS.mcpOutcomeUnknown).toContain("as it was, is safe");
    expect(b.err).toContain("saveslot mcp: timeout");
  });

  it("a service of another version: forwarded all the same, a line on stderr", async () => {
    s.health = { ...s.health, version: "other" };
    s.answer = (_, res) => json(res, 200, { jsonrpc: "2.0", id: 1, result: {} });
    const b = bridge();
    b.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    b.stdin.end();
    expect(await b.exit).toBe(0);
    expect(b.lines).toHaveLength(1);
    expect(b.err.some((l) => l.includes("version_mismatch"))).toBe(true);
  });

  for (const [errno, code] of [
    ["EPIPE", 0],
    ["ENOBUFS", 1],
  ] as const) {
    it(`stdout fails with ${errno}: the bridge ends (${code}), giving up on what is in flight`, async () => {
      const held: ServerResponse[] = [];
      const closed: boolean[] = [];
      s.answer = (seen, res) => {
        if (JSON.parse(seen.body.toString()).id === 1) {
          json(res, 200, { jsonrpc: "2.0", id: 1, result: {} });
          return;
        }
        const i = held.push(res) - 1;
        closed[i] = false;
        res.on("close", () => {
          closed[i] = true;
        });
      };
      const io = bridgeStreams();
      const stdout = new Writable({
        write(_c, _e, cb) {
          cb(Object.assign(new Error(errno), { code: errno }));
        },
      });
      const exit = runBridge({
        token: UNKNOWN_TOKEN,
        stdin: io.stdin,
        stdout,
        log: io.log,
        autostart: false,
        startService: async () => 7,
        version: "t",
        socketPath: s.socketPath,
      });
      io.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
      await until(() => held.length === 1);
      io.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
      expect(await exit).toBe(code);
      expect(io.err).toContain(
        code === 0 ? "saveslot mcp: stdout_closed" : "saveslot mcp: stdout_failed",
      );
      // The request still in flight was given up on: its connection is closed.
      await until(() => closed[0] === true, 2000);
    });
  }

  it("a message the service refuses, with an id or without: its error is written", async () => {
    s.answer = (_, res) =>
      json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid" } });
    const b = bridge();
    for (const line of ['{"id":7,"method":7}', '{"id":8}', "{}", "[]"]) b.stdin.write(`${line}\n`);
    b.stdin.end();
    expect(await b.exit).toBe(0);
    expect(b.lines.map((l) => JSON.parse(l).id).sort()).toEqual([7, 8, null, null].sort());
    for (const l of b.lines) expect(JSON.parse(l).error.code).toBe(-32600);
  });

  it("a request nothing answers (a 202, an SSE of notifications only): -32603 to it; other answers passed on", async () => {
    const note = { jsonrpc: "2.0", method: "notifications/progress", params: {} };
    const other = { jsonrpc: "2.0", id: "someone-else", result: {} };
    s.answer = (seen, res) => {
      const id = JSON.parse(seen.body.toString()).id;
      if (id === 1) res.writeHead(202).end();
      else if (id === 2) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify(note)}\n\n`);
      } else json(res, 200, other);
    };
    const b = bridge();
    b.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    await until(() => b.lines.length === 1);
    b.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    await until(() => b.lines.length === 3);
    b.send({ jsonrpc: "2.0", id: 3, method: "ping" });
    b.stdin.end();
    expect(await b.exit).toBe(0);
    const out = b.lines.map((l) => JSON.parse(l));
    expect(out).toEqual([
      { jsonrpc: "2.0", id: 1, error: { code: -32603, message: expect.any(String) } },
      note,
      { jsonrpc: "2.0", id: 2, error: { code: -32603, message: expect.any(String) } },
      other,
      { jsonrpc: "2.0", id: 3, error: { code: -32603, message: expect.any(String) } },
    ]);
  });

  it("an SSE event with no data is skipped", async () => {
    s.answer = (_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data:\n\nevent: x\n\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
    };
    const b = bridge();
    b.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    b.stdin.end();
    expect(await b.exit).toBe(0);
    expect(b.lines.map((l) => JSON.parse(l))).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("an answer past the size limit: -32603, not 'not running'", async () => {
    s.answer = (_, res) =>
      json(res, 200, { jsonrpc: "2.0", id: 1, result: { pad: "x".repeat(500) } });
    const io = bridgeStreams();
    const exit = runBridge({
      token: UNKNOWN_TOKEN,
      stdin: io.stdin,
      stdout: io.stdout,
      log: io.log,
      autostart: false,
      startService: async () => 7,
      version: "t",
      socketPath: s.socketPath,
      maxAnswerBytes: 100,
    });
    io.stdin.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    expect(await exit).toBe(0);
    expect(JSON.parse(io.lines[0] as string)).toMatchObject({ id: 1, error: { code: -32603 } });
  });

  it("a 503 says what /health says: failed, or starting and stopping", async () => {
    s.answer = (_, res) => json(res, 503, { error: { code: "unavailable", reason: "starting" } });
    s.health = { ...s.health, state: "failed", reason: "internal" };
    const b = bridge();
    b.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    await until(() => b.lines.length === 1);
    s.health = { ...s.health, state: "stopping" };
    b.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    b.stdin.end();
    expect(await b.exit).toBe(0);
    const [failed, stopping] = b.lines.map((l) => JSON.parse(l).error);
    expect(failed).toMatchObject({ code: -32000, message: TEXTS.mcpServiceFailed });
    expect(stopping).toMatchObject({ code: -32000, message: TEXTS.mcpUnavailable });
  });

  it("a batch holding a request, on every failing path: one error with id null", async () => {
    const paths: [string, (res: ServerResponse) => void][] = [
      ["401", (res) => json(res, 401, { error: { code: "unauthenticated" } })],
      ["403", (res) => json(res, 403, { error: { code: "insufficient_scope" } })],
      ["503", (res) => json(res, 503, { error: { code: "unavailable" } })],
      ["not JSON-RPC", (res) => json(res, 200, { not: "json-rpc" })],
    ];
    for (const [, answer] of paths) {
      s.answer = (_, res) => answer(res);
      const b = bridge();
      b.send([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
      b.stdin.end();
      expect(await b.exit).toBe(0);
      expect(b.lines.map((l) => JSON.parse(l).id)).toEqual([null]);
    }
    // Unreachable: no service on the socket.
    const io = bridgeStreams();
    const exit = runBridge({
      token: UNKNOWN_TOKEN,
      stdin: io.stdin,
      stdout: io.stdout,
      log: io.log,
      autostart: false,
      startService: async () => 7,
      version: "t",
      socketPath: join(s.home, "nobody.sock"),
    });
    io.stdin.end('[{"jsonrpc":"2.0","id":1,"method":"ping"}]\n');
    expect(await exit).toBe(0);
    expect(io.lines.map((l) => JSON.parse(l))).toMatchObject([
      { id: null, error: { code: -32000 } },
    ]);
  });

  it("the total time limit holds against a service that keeps sending a little", async () => {
    const trickling: ServerResponse[] = [];
    s.answer = (_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      trickling.push(res);
    };
    const drip = setInterval(() => {
      for (const r of trickling) r.write(": still here\n");
    }, 50);
    try {
      const b = bridge({ forwardTimeoutMs: 400 });
      b.send({ jsonrpc: "2.0", id: "t", method: "ping" });
      b.stdin.end();
      const began = Date.now();
      expect(await b.exit).toBe(0);
      expect(Date.now() - began).toBeLessThan(5000);
      expect(JSON.parse(b.lines[0] as string)).toMatchObject({ id: "t", error: { code: -32603 } });
      expect(b.err).toContain("saveslot mcp: timeout");
    } finally {
      clearInterval(drip);
      for (const r of trickling) r.end();
    }
  });

  it("output backpressure: while the host does not read, few requests go through; all are answered once it does", async () => {
    s.answer = (seen, res) =>
      json(res, 200, { jsonrpc: "2.0", id: JSON.parse(seen.body.toString()).id, result: {} });
    const io = bridgeStreams();
    // A host that does not read: nothing is taken until `release`.
    const pending: (() => void)[] = [];
    const written: string[] = [];
    let reading = false;
    const stdout = new Writable({
      highWaterMark: 64,
      write(c, _e, cb) {
        written.push(String(c));
        if (reading) cb();
        else pending.push(cb);
      },
    });
    const exit = runBridge({
      token: UNKNOWN_TOKEN,
      stdin: io.stdin,
      stdout,
      log: io.log,
      autostart: false,
      startService: async () => 7,
      version: "t",
      socketPath: s.socketPath,
    });
    const line = (i: number) =>
      `${JSON.stringify({ jsonrpc: "2.0", id: `q${String(i).padStart(4, "0")}`, method: "ping" })}\n`;
    // A few first, until the output is stuck …
    const first = 20;
    for (let i = 0; i < first; i++) io.stdin.write(line(i));
    await until(() => pending.length > 0);
    await sleep(300);
    expect(s.seen.length).toBeLessThanOrEqual(2 * MAX_IN_FLIGHT);
    expect(io.stdin.isPaused()).toBe(true);
    // … then more: none is taken while the output is stuck (the queue has room for them).
    const n = 300;
    for (let i = first; i < n; i++) io.stdin.write(line(i));
    await sleep(300);
    expect(io.stdin.readableLength + io.stdin.writableLength).toBe((n - first) * line(0).length);
    expect(s.seen.length).toBeLessThanOrEqual(2 * MAX_IN_FLIGHT);
    reading = true;
    for (const cb of pending.splice(0)) cb();
    io.stdin.end();
    expect(await exit).toBe(0);
    expect(written.join("").trim().split("\n")).toHaveLength(n);
  });

  it("stderr on the failing paths: event names and reason codes, nothing of the messages", async () => {
    const marker = "zq-marker-3391";
    s.answer = (seen, res) => {
      const m = JSON.parse(seen.body.toString()) as { id: string };
      if (m.id.endsWith("401")) json(res, 401, { error: { code: "unauthenticated" } });
      else if (m.id.endsWith("403")) json(res, 403, { error: { code: "insufficient_scope" } });
      else if (m.id.endsWith("400"))
        json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -1, message: marker } });
      else if (m.id.endsWith("503")) json(res, 503, { error: { code: "unavailable" } });
      else if (m.id.endsWith("202")) res.writeHead(202).end();
      else res.writeHead(500).end(marker);
    };
    const b = bridge();
    for (const k of ["401", "403", "400", "503", "202", "500"]) {
      b.send({
        jsonrpc: "2.0",
        id: `${marker}-${k}`,
        method: `${marker}/m`,
        params: { name: marker, _meta: { [META]: MODERN } },
      });
    }
    b.stdin.write(`${marker} not json\n`);
    b.stdin.end();
    expect(await b.exit).toBe(0);
    expect(b.err.length).toBeGreaterThan(5);
    for (const l of b.err) expect(l).toMatch(/^saveslot mcp: [a-z0-9_]+$/);
    expect(b.err.join("\n")).not.toContain(marker);
  });

  it("autostart off: the service is not started; requests get -32000", async () => {
    const io = bridgeStreams();
    let starts = 0;
    const exit = runBridge({
      token: UNKNOWN_TOKEN,
      stdin: io.stdin,
      stdout: io.stdout,
      log: io.log,
      autostart: false,
      startService: async () => {
        starts++;
        return 0;
      },
      version: "t",
      socketPath: join(s.home, "nobody.sock"),
    });
    io.stdin.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    expect(await exit).toBe(0);
    expect(starts).toBe(0);
    expect(JSON.parse(io.lines[0] as string)).toMatchObject({ id: 1, error: { code: -32000 } });
  });

  it("starting the service fails, or throws: logged by a code, requests get -32000, no crash", async () => {
    for (const [startService, event] of [
      [async () => 7, "saveslot mcp: autostart_exit_7"],
      [
        async () => {
          throw new Error(`ENOTDIR: ${s.home}`);
        },
        "saveslot mcp: autostart_failed",
      ],
    ] as const) {
      const io = bridgeStreams();
      const exit = runBridge({
        token: UNKNOWN_TOKEN,
        stdin: io.stdin,
        stdout: io.stdout,
        log: io.log,
        autostart: true,
        startService,
        version: "t",
        socketPath: join(s.home, "nobody.sock"),
      });
      io.stdin.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
      expect(await exit).toBe(0);
      expect(io.err).toContain(event);
      expect(io.err.join("\n")).not.toContain(s.home);
      expect(JSON.parse(io.lines[0] as string)).toMatchObject({ id: 1, error: { code: -32000 } });
    }
  });

  it("no SAVESLOT_TOKEN, an empty one, a user session's, or another form: exit 6, stdin not read", async () => {
    for (const token of [
      undefined,
      "",
      `sls_${"A".repeat(43)}`,
      "slt_short",
      ` ${UNKNOWN_TOKEN}`,
    ]) {
      const io = bridgeStreams();
      io.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
      const code = await runBridge({
        token,
        stdin: io.stdin,
        stdout: io.stdout,
        log: io.log,
        autostart: true,
        startService: async () => {
          throw new Error("must not start");
        },
        version: "t",
        socketPath: s.socketPath,
      });
      expect(code).toBe(6);
      expect(io.stdin.listenerCount("data")).toBe(0);
      expect(io.lines).toEqual([]);
      expect(s.seen).toHaveLength(0);
      expect(io.err.join("\n")).not.toContain("sls_");
    }
  });
});

/** A home as init makes it, made once for the file; each fixture takes a copy (home-copy.fixture.ts). */
const templateRoot = mkdtempSync(join(tmpdir(), "saveslot-bridge-template-"));
const template = homeTemplate(join(templateRoot, "home"), (home) =>
  initLocalHome({
    home,
    backend: testBackend(),
    lock: osFileLock,
    now: new Date().toISOString(),
  }),
);
afterAll(() => rmSync(templateRoot, { recursive: true, force: true }));

/** A service on a fresh home, in this process. */
function serviceFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const s = {
    home: join(root, "home"),
    session: "",
    service: undefined as RunningService | undefined,
  };
  beforeAll(async () => {
    await template.copy(s.home);
    s.session = readFileSync(sessionFile(s.home), "utf8").trim();
    s.service = await runService({ home: s.home, version: "t", signals: false, log: () => {} });
  }, T);
  afterAll(async () => {
    await s.service?.stop();
    rmSync(root, { recursive: true, force: true });
  }, T);
  return s;
}

async function issue(home: string, session: string, name: string, scopes: string[]) {
  const r = await httpDriver(() => home)(session, "connections.issue", { name, scopes });
  return (r as { result: { token: string } }).result.token;
}

describe("the bridge against a real service", () => {
  const s = serviceFixture("saveslot-bridge-real-");

  const bridge = (token: string) => {
    const io = bridgeStreams();
    const exit = runBridge({
      token,
      stdin: io.stdin,
      stdout: io.stdout,
      log: io.log,
      autostart: false,
      startService: async () => 7,
      version: "t",
      socketPath: socketFile(s.home),
    });
    return { ...io, exit, send: (v: unknown) => io.stdin.write(`${JSON.stringify(v)}\n`) };
  };

  it(
    "initialize, tools/list, tools/call; every stdout line JSON-RPC; stderr holds nothing of the calls",
    async () => {
      const token = await issue(s.home, s.session, "bridge", ["saveslot.read", "saveslot.write"]);
      const marker = "zq-marker-5817";
      const b = bridge(token);
      b.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: marker, version: "0" },
        },
      });
      await until(() => b.lines.length === 1);
      b.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      b.send({ jsonrpc: "2.0", id: "two", method: "tools/list" });
      await until(() => b.lines.length === 2);
      b.send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "saveslot_catalog", arguments: { task: marker } },
      });
      // A 2026-07-28 call too: its name goes in a header, never to stderr.
      b.send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "saveslot_catalog",
          arguments: { task: marker },
          _meta: {
            [META]: MODERN,
            "io.modelcontextprotocol/clientInfo": { name: marker, version: "0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      });
      b.stdin.end();
      expect(await b.exit).toBe(0);
      const out = b.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      for (const o of out) expect(o["jsonrpc"]).toBe("2.0");
      expect(out.map((o) => o["id"]).sort((a, c) => String(a).localeCompare(String(c)))).toEqual([
        1,
        3,
        4,
        "two",
      ]);
      for (const o of out) expect(o["error"]).toBeUndefined();
      const listed = out.find((o) => o["id"] === "two")?.["result"] as { tools: unknown[] };
      expect(listed.tools.length).toBeGreaterThan(0);
      const errText = b.err.join("\n");
      for (const secret of [token, marker, "saveslot_catalog", "tools/call", s.home]) {
        expect(errText).not.toContain(secret);
      }
    },
    T,
  );

  it("prompts, in each era: forwarded as they are, prompts/get with its name in the header (2026-07-28)", async () => {
    const token = await issue(s.home, s.session, "prompts", ["saveslot.read", "saveslot.write"]);
    const b = bridge(token);
    const envelope = {
      [META]: MODERN,
      "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    b.send({ jsonrpc: "2.0", id: "l1", method: "prompts/list", params: {} });
    b.send({
      jsonrpc: "2.0",
      id: "g1",
      method: "prompts/get",
      params: { name: "overview", arguments: {} },
    });
    b.send({
      jsonrpc: "2.0",
      id: "g2",
      method: "prompts/get",
      params: { name: "pending", arguments: {}, _meta: envelope },
    });
    // A prompt this credential is not listed: the service's own error, passed on with its id.
    b.send({
      jsonrpc: "2.0",
      id: "g3",
      method: "prompts/get",
      params: { name: "track", arguments: {}, _meta: envelope },
    });
    b.stdin.end();
    expect(await b.exit).toBe(0);
    const out = new Map(
      b.lines
        .map((l) => JSON.parse(l) as { id: string; result?: unknown; error?: unknown })
        .map((o) => [o.id, o]),
    );
    expect(out.get("l1")?.result).toMatchObject({
      prompts: [{ name: "overview" }, { name: "pending" }],
    });
    for (const id of ["g1", "g2"]) {
      expect(out.get(id)?.result).toMatchObject({
        messages: [{ role: "user", content: { type: "text" } }],
      });
    }
    expect(out.get("g3")?.error).toMatchObject({ code: -32602 });
    expect(b.err.join("\n")).not.toContain("overview");
  });

  it("a batch to the real service: each answer on a line of its own", async () => {
    const token = await issue(s.home, s.session, "batch", ["saveslot.read"]);
    const b = bridge(token);
    b.send([
      { jsonrpc: "2.0", id: "b1", method: "tools/list" },
      { jsonrpc: "2.0", id: "b2", method: "tools/list" },
    ]);
    b.stdin.end();
    expect(await b.exit).toBe(0);
    const out = b.lines.map((l) => JSON.parse(l) as unknown);
    // However the service frames it (one JSON array, or one SSE event each), every line is whole.
    const answers = out.flatMap((v) => (Array.isArray(v) ? v : [v])) as { id: string }[];
    expect(answers.map((a) => a.id).sort()).toEqual(["b1", "b2"]);
    for (const a of answers) expect(a).toHaveProperty("result");
  });

  it("a token the service does not know: -32001 unauthenticated, the id kept", async () => {
    const b = bridge(UNKNOWN_TOKEN);
    b.send({ jsonrpc: "2.0", id: "x1", method: "tools/list" });
    b.stdin.end();
    expect(await b.exit).toBe(0);
    const o = JSON.parse(b.lines[0] as string);
    expect(o).toMatchObject({
      id: "x1",
      error: { code: -32001, data: { code: "unauthenticated" } },
    });
    expect(b.lines[0]).not.toContain(UNKNOWN_TOKEN);
  });

  it("a tool the token has no scope for: -32003 insufficient_scope", async () => {
    const reader = await issue(s.home, s.session, "reader", ["saveslot.read"]);
    const b = bridge(reader);
    b.send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "saveslot_write", arguments: { ops: [] } },
    });
    b.stdin.end();
    expect(await b.exit).toBe(0);
    expect(JSON.parse(b.lines[0] as string)).toMatchObject({
      id: 5,
      error: {
        code: -32003,
        data: { code: "insufficient_scope", required_scope: "saveslot.write" },
      },
    });
    expect(b.err.join("\n")).not.toContain(reader);
  });

  it(
    "--record: every message in and out, the protocol once agreed, no token; the token still used",
    async () => {
      const token = await issue(s.home, s.session, "recorded", ["saveslot.read", "saveslot.write"]);
      const file = join(s.home, "..", `record-${Date.now()}.jsonl`);
      // Tokens of both forms written into a message by the host: kept out of the record too.
      const pasted = `slt_${"B".repeat(43)}`;
      const session = `sls_${"C".repeat(43)}`;
      const io = bridgeStreams();
      const exit = runBridge({
        token,
        stdin: io.stdin,
        stdout: io.stdout,
        log: io.log,
        autostart: false,
        startService: async () => 7,
        version: "t",
        socketPath: socketFile(s.home),
        record: file,
      });
      const send = (v: unknown) => io.stdin.write(`${JSON.stringify(v)}\n`);
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "h", version: "0" },
        },
      });
      await until(() => io.lines.length === 1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "saveslot_catalog", arguments: { task: `${pasted} ${session}` } },
      });
      io.stdin.end();
      expect(await exit).toBe(0);
      // The service took the bridge's token: the call was served.
      const out = io.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      const called = out.find((o) => o["id"] === 2) as { result: Record<string, unknown> };
      // A tool result is text only (05 §3).
      expect(Object.keys(called.result)).toEqual(["content"]);

      expect(statSync(file).mode & 0o777).toBe(0o600);
      const text = readFileSync(file, "utf8");
      for (const secret of [token, pasted, session]) expect(text).not.toContain(secret);
      const lines = text
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines[0]).toEqual({ record: 1, saveslot: "t" });
      expect(lines.filter((l) => "protocol" in l)).toEqual([{ protocol: "2025-11-25" }]);
      const msgs = lines.filter((l) => "dir" in l) as {
        t: string;
        dir: string;
        msg: Record<string, unknown>;
      }[];
      // In order: what came in and what went out, each as it was.
      expect(msgs.map((m) => [m.dir, m.msg["id"] ?? m.msg["method"]])).toEqual([
        ["in", 1],
        ["out", 1],
        ["in", "notifications/initialized"],
        ["in", 2],
        ["out", 2],
      ]);
      // The protocol line comes after the answer that agreed it.
      expect(lines.findIndex((l) => "protocol" in l)).toBeGreaterThan(
        lines.findIndex((l) => l["dir"] === "out"),
      );
      const recorded = msgs.find((m) => m.dir === "out" && m.msg["id"] === 2)?.msg as {
        result: Record<string, unknown>;
      };
      expect(recorded.result).toEqual(called.result);
      const asked = msgs.find((m) => m.dir === "in" && m.msg["id"] === 2)?.msg as {
        params: { arguments: { task: string } };
      };
      expect(asked.params.arguments.task).toBe("slt_REDACTED sls_REDACTED");
      for (const m of msgs) expect(Number.isNaN(Date.parse(m.t))).toBe(false);
    },
    T,
  );

  it("--record <directory>: each bridge its own new file there, by start and process", async () => {
    const token = await issue(s.home, s.session, "recorded-dir", ["saveslot.read"]);
    const dir = join(s.home, "..", `records-${Date.now()}`);
    mkdirSync(dir, { mode: 0o700 });
    const once = async () => {
      const io = bridgeStreams();
      const exit = runBridge({
        token,
        stdin: io.stdin,
        stdout: io.stdout,
        log: io.log,
        autostart: false,
        startService: async () => 7,
        version: "t",
        socketPath: socketFile(s.home),
        record: dir,
      });
      io.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
      io.stdin.end();
      expect(await exit).toBe(0);
      // Started in another millisecond: another name.
      await sleep(5);
    };
    await once();
    await once();
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    for (const f of files) {
      expect(f).toMatch(new RegExp(`^record-\\d{8}T\\d{9}Z-${process.pid}\\.jsonl$`));
      expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
      const lines = readFileSync(join(dir, f), "utf8").trimEnd().split("\n");
      expect(JSON.parse(lines[0] as string)).toEqual({ record: 1, saveslot: "t" });
      expect(lines.map((l) => JSON.parse(l)["dir"]).filter(Boolean)).toEqual(["in", "out"]);
    }
  });

  it("--record over a file that exists: refused, the file left as it was; nothing read", async () => {
    const token = await issue(s.home, s.session, "recorded-twice", ["saveslot.read"]);
    const file = join(s.home, "..", `record-exists-${Date.now()}.jsonl`);
    writeFileSync(file, "earlier\n");
    const io = bridgeStreams();
    const code = await runBridge({
      token,
      stdin: io.stdin,
      stdout: io.stdout,
      log: io.log,
      autostart: false,
      startService: async () => 7,
      version: "t",
      socketPath: socketFile(s.home),
      record: file,
    });
    expect(code).toBe(1);
    expect(io.err).toEqual([TEXTS.mcpEvent("record_exists")]);
    expect(readFileSync(file, "utf8")).toBe("earlier\n");
  });
});

describe("the service stopped while the bridge runs", () => {
  const s = serviceFixture("saveslot-bridge-stop-");
  it(
    "the next request is answered -32000, the service is not started again and the bridge does not hang",
    async () => {
      const token = await issue(s.home, s.session, "bridge", ["saveslot.read"]);
      const io = bridgeStreams();
      let starts = 0;
      const exit = runBridge({
        token,
        stdin: io.stdin,
        stdout: io.stdout,
        log: io.log,
        autostart: true,
        startService: async () => {
          starts++;
          return 7;
        },
        version: "t",
        socketPath: socketFile(s.home),
      });
      const send = (v: unknown) => io.stdin.write(`${JSON.stringify(v)}\n`);
      send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      await until(() => io.lines.length === 1);
      await s.service?.stop();
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      await until(() => io.lines.length === 2);
      io.stdin.end();
      expect(await exit).toBe(0);
      expect(JSON.parse(io.lines[1] as string)).toMatchObject({ id: 2, error: { code: -32000 } });
      expect(starts).toBe(0);
    },
    T,
  );
});

const FIXTURE = fileURLToPath(new URL("./mcp-bridge-bin.fixture.ts", import.meta.url));

/** The bridge spawned as a host spawns it, on `home`; its stdout lines and stderr text. */
function spawnBridge(home: string, env: Record<string, string>) {
  const child = spawn(process.execPath, ["--conditions=source", FIXTURE, "--home", home], {
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: string[] = [];
  let buf = "";
  child.stdout.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  let err = "";
  child.stderr.on("data", (c: Buffer) => {
    err += c.toString("utf8");
  });
  const exited = new Promise<{ code: number | null; signal: string | null; at: number }>((r) =>
    child.on("exit", (code, signal) => r({ code, signal, at: Date.now() })),
  );
  return { child, lines, err: () => err, exited };
}

describe("the bridge as a process", () => {
  const s = standIn();
  const token = UNKNOWN_TOKEN;

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(
      `${signal}: exits at once with requests in flight`,
      async () => {
        s.answer = () => {}; // never answered
        const b = spawnBridge(s.home, { SAVESLOT_TOKEN: token });
        b.child.stdin?.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
        await until(() => s.seen.length === 1, 30_000);
        const sent = Date.now();
        b.child.kill(signal);
        const e = await b.exited;
        expect(e.signal).toBeNull();
        expect(e.code).toBe(0);
        expect(e.at - sent).toBeLessThan(2000);
      },
      T,
    );
  }

  it(
    "stdout closed by the host: the process exits at once, with other requests in flight",
    async () => {
      const held: ServerResponse[] = [];
      s.answer = (_, res) => {
        held.push(res);
      };
      const b = spawnBridge(s.home, { SAVESLOT_TOKEN: token });
      b.child.stdin?.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
      b.child.stdin?.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
      await until(() => held.length === 2, 30_000);
      b.child.stdout?.destroy();
      await sleep(100);
      const sent = Date.now();
      json(held[0] as ServerResponse, 200, { jsonrpc: "2.0", id: 1, result: {} });
      const e = await b.exited;
      expect(e.code).toBe(0);
      expect(e.at - sent).toBeLessThan(2000);
      expect(b.err()).toContain("saveslot mcp: stdout_closed");
      (held[1] as ServerResponse).destroy();
    },
    T,
  );

  it(
    "stdout closed while the service is still starting: the process exits at once, not after the wait",
    async () => {
      s.health = { ...s.health, state: "starting" }; // the bridge would wait up to a minute
      const b = spawnBridge(s.home, { SAVESLOT_TOKEN: token });
      // Started, and waiting on /health: it has asked, and was told "starting".
      await until(() => s.healthAsked > 0, 30_000);
      b.child.stdout?.destroy();
      const sent = Date.now();
      // A line the bridge answers at once (not JSON), so that it writes and finds stdout gone.
      b.child.stdin?.write("not json\n");
      const e = await b.exited;
      expect(e.code).toBe(0);
      expect(e.at - sent).toBeLessThan(3000);
    },
    T,
  );

  it(
    "no SAVESLOT_TOKEN: exit 6, nothing on stdout, one line on stderr",
    async () => {
      const b = spawnBridge(s.home, {});
      b.child.stdin?.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
      const e = await b.exited;
      expect(e.code).toBe(6);
      expect(b.lines).toEqual([]);
      expect(b.err()).toBe(`${TEXTS.mcpNoToken}\n`);
      expect(s.seen).toHaveLength(0);
    },
    T,
  );
});

describe("mcp.autostart off, on a home where a start would succeed", () => {
  const root = mkdtempSync(join(tmpdir(), "saveslot-bridge-noauto-"));
  const home = join(root, "home");
  beforeAll(async () => {
    await template.copy(home);
  }, T);
  afterAll(async () => {
    await stop(home, { out: () => {}, err: () => {} });
    rmSync(root, { recursive: true, force: true });
  }, T);

  for (const [what, file, event] of [
    ["off", "[mcp]\nautostart = false\n", undefined],
    ["a config.toml start would refuse", "mcp.autostart = 1\n", "saveslot mcp: config_invalid"],
  ] as const) {
    it(
      `${what}: the bridge runs, each request gets -32000, no service is started`,
      async () => {
        writeFileSync(join(home, "config.toml"), file);
        const b = spawnBridge(home, { SAVESLOT_TOKEN: UNKNOWN_TOKEN });
        b.child.stdin?.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
        b.child.stdin?.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
        b.child.stdin?.end();
        const e = await b.exited;
        expect(e.code).toBe(0);
        expect(b.lines.map((l) => JSON.parse(l))).toMatchObject([
          { id: 1, error: { code: -32000 } },
          { id: 2, error: { code: -32000 } },
        ]);
        const err = b.err();
        expect(err).not.toContain("autostart");
        if (event !== undefined) expect(err).toContain(event);
        // Nothing was started: no pid file, no service log, nobody on the socket.
        expect(existsSync(join(home, "run", "saveslot.pid"))).toBe(false);
        expect(existsSync(join(home, "run", "saveslot.log"))).toBe(false);
        expect(await health(socketFile(home))).toBeUndefined();
      },
      T,
    );
  }
});

/** The official client over stdio, the bridge spawned as a host spawns it. */
async function hostClient(home: string, token: string, era: "legacy" | "modern") {
  const client = new Client(
    { name: "saveslot-tests", version: "0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: MODERN } } } : {},
  );
  const stderr: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--conditions=source", FIXTURE, "--home", home],
    env: { SAVESLOT_TOKEN: token, PATH: process.env["PATH"] ?? "" },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (c: Buffer) => stderr.push(c.toString("utf8")));
  await client.connect(transport);
  return { client, stderr };
}

describe("a host over stdio: the official SDK client spawns the bridge", () => {
  const s = serviceFixture("saveslot-bridge-host-");
  for (const era of ["legacy", "modern"] as const) {
    it(
      `${era === "legacy" ? "2025-11-25" : "2026-07-28"}: handshake, tools/list, tools/call`,
      async () => {
        const token = await issue(s.home, s.session, `host-${era}`, [
          "saveslot.read",
          "saveslot.write",
          "saveslot.schema",
          "saveslot.delete",
        ]);
        const { client, stderr } = await hostClient(s.home, token, era);
        try {
          const { tools } = await client.listTools();
          expect(tools.map((t) => t.name)).toContain("saveslot_catalog");
          // The bridge derives no Mcp-Param-* headers: no tool may declare one.
          expect(JSON.stringify(tools)).not.toContain("x-mcp-header");
          const r = await client.callTool({ name: "saveslot_catalog", arguments: {} });
          expect(r.isError).not.toBe(true);
          expect(client.getNegotiatedProtocolVersion?.()).toBe(
            era === "modern" ? MODERN : "2025-11-25",
          );
        } finally {
          await client.close();
        }
        expect(stderr.join("")).not.toContain(token);
      },
      T,
    );
  }
});

describe("two hosts start the service at once", () => {
  const root = mkdtempSync(join(tmpdir(), "saveslot-bridge-two-"));
  const home = join(root, "home");
  let session = "";
  beforeAll(async () => {
    await template.copy(home);
    session = readFileSync(sessionFile(home), "utf8").trim();
  }, T);
  afterAll(async () => {
    await stop(home, { out: () => {}, err: () => {} });
    rmSync(root, { recursive: true, force: true });
  }, T);

  it(
    "both bridges are served, by one service process",
    async () => {
      // A token is issued by a service; the hash stays in the control plane after it stops.
      const svc = await runService({ home, version: "t", signals: false, log: () => {} });
      const token = await issue(home, session, "two", ["saveslot.read"]);
      await svc.stop();
      expect(await health(socketFile(home))).toBeUndefined();

      // Connecting is each host's first request (initialize, or server/discover): both must
      // succeed, the one whose bridge lost the race to start the service too.
      const hosts = await Promise.all([
        hostClient(home, token, "legacy"),
        hostClient(home, token, "modern"),
      ]);
      try {
        const lists = await Promise.all(hosts.map((h) => h.client.listTools()));
        for (const l of lists) expect(l.tools.length).toBeGreaterThan(0);
      } finally {
        await Promise.all(hosts.map((h) => h.client.close()));
      }
      const h = await health(socketFile(home));
      expect(h?.state).toBe("ready");
      expect(readFileSync(join(home, "run", "saveslot.pid"), "utf8").trim()).toBe(String(h?.pid));
      // Starting it wrote nothing of start's own on the bridges' stderr (nor stdout: the hosts
      // read only JSON-RPC there), and the service did not take the bridge's token along.
      for (const host of hosts) {
        for (const line of host.stderr.join("").split("\n").filter(Boolean)) {
          expect(line).toMatch(/^saveslot mcp: [a-z0-9_]+$/);
        }
      }
      const env = execFileSync("ps", ["eww", "-o", "command=", "-p", String(h?.pid)], {
        encoding: "utf8",
      });
      // The environment is shown (PATH is in it), so the token's absence means something.
      expect(env).toContain("PATH=");
      expect(env).not.toContain("SAVESLOT_TOKEN");
      // Both bridges may have spawned one: the later one fails on the home's lock and exits, which
      // can be after both hosts were served (it may still be loading). One process is left.
      const services = () => {
        try {
          return execFileSync("pgrep", ["-f", `bin.ts --home ${home}`], { encoding: "utf8" })
            .trim()
            .split("\n")
            .filter(Boolean);
        } catch {
          return []; // pgrep exits 1 when nothing matches
        }
      };
      await until(() => services().length <= 1, 30_000);
      expect(services()).toEqual([String(h?.pid)]);
      // A process that loses the lock leaves the winner's pid file and socket alone: one started
      // here on purpose, so that the case is there on every run.
      const late = spawnSync(
        process.execPath,
        [
          "--conditions=source",
          fileURLToPath(new URL("./bin.ts", import.meta.url)),
          "--home",
          home,
        ],
        { encoding: "utf8", timeout: T },
      );
      expect(late.status).toBe(1);
      expect(readFileSync(join(home, "run", "saveslot.pid"), "utf8").trim()).toBe(String(h?.pid));
      const after = await hostClient(home, token, "legacy");
      try {
        expect((await after.client.listTools()).tools.length).toBeGreaterThan(0);
      } finally {
        await after.client.close();
      }
      expect((await health(socketFile(home)))?.pid).toBe(h?.pid);
    },
    2 * T,
  );
});

describe("every request answered with an error of its own id when the call cannot be served", () => {
  const s = standIn();
  const real = serviceFixture("saveslot-bridge-answered-");
  const calls = [1, 2, 3].map((id) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "saveslot_catalog", arguments: {} },
  }));
  /** Runs a bridge over `socketPath`, sends the calls, and gives each id's one answer. */
  async function answers(o: { socketPath: string; token?: string; autostart?: boolean }) {
    const io = bridgeStreams();
    const exit = runBridge({
      token: o.token ?? UNKNOWN_TOKEN,
      stdin: io.stdin,
      stdout: io.stdout,
      log: io.log,
      autostart: o.autostart ?? false,
      startService: async () => 7,
      version: "t",
      socketPath: o.socketPath,
    });
    io.stdin.end(calls.map((c) => `${JSON.stringify(c)}\n`).join(""));
    expect(await exit).toBe(0);
    const out = io.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    // One answer per id, each an error (never a null, never no answer), for that id.
    expect(out.map((m) => m["id"]).sort()).toEqual([1, 2, 3]);
    for (const m of out) {
      expect(m).not.toHaveProperty("result");
      expect(m["error"]).toEqual(expect.objectContaining({ code: expect.any(Number) }));
    }
    return { out: out.map((m) => m["error"] as Record<string, unknown>), err: io.err };
  }

  it("the service not running: -32000, not_delivered, nothing written; the words follow autostart", async () => {
    for (const autostart of [false, true]) {
      const { out } = await answers({ socketPath: join(s.home, "nobody.sock"), autostart });
      for (const e of out) {
        expect(e).toEqual({
          code: -32000,
          message: TEXTS.mcpNotDelivered(autostart),
          data: { code: "not_delivered" },
        });
      }
    }
    expect(TEXTS.mcpNotDelivered(false)).not.toContain("starts it again");
  });

  it("the service not serving yet (503): -32000, not available, try again", async () => {
    // Its /health ready to the bridge's first look, its /mcp still 503: a service half up, or
    // going down. (A service that says `starting` is waited for before the input is read.)
    s.answer = (_, res) => json(res, 503, { error: { code: "unavailable", reason: "starting" } });
    const { out } = await answers({ socketPath: s.socketPath });
    for (const e of out) expect(e).toEqual({ code: -32000, message: TEXTS.mcpUnavailable });
  });

  it("the connection cut after the call was sent: -32000, outcome_unknown, a resend with the same key is safe", async () => {
    s.answer = (_, res) => {
      res.socket?.destroy();
    };
    const { out, err } = await answers({ socketPath: s.socketPath });
    for (const e of out) {
      expect(e).toEqual({
        code: -32000,
        message: TEXTS.mcpOutcomeUnknown,
        data: { code: "outcome_unknown" },
      });
    }
    expect(err).toContain(TEXTS.mcpEvent("connection_lost"));
  });

  it(
    "a revoked token: -32001, unauthenticated, reconnect",
    async () => {
      const token = await issue(real.home, real.session, "revoked", ["saveslot.read"]);
      const id = (
        (await httpDriver(() => real.home)(real.session, "connections.list", {})) as {
          result: { connections: { id: string; name: string }[] };
        }
      ).result.connections.find((c) => c.name === "revoked")?.id as string;
      await httpDriver(() => real.home)(real.session, "connections.revoke", { id });
      const { out } = await answers({ socketPath: socketFile(real.home), token });
      for (const e of out) {
        expect(e).toEqual({
          code: -32001,
          message: TEXTS.mcpRefused("unauthenticated"),
          data: { code: "unauthenticated" },
        });
      }
    },
    T,
  );
});
