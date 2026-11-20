// `export` in the client: the request it sends, and that a stream that is not whole never reads
// as whole — cut off, short of the manifest's count, or not ending at its `upto`.

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient } from "./client.ts";
import { ContractCallError, TransportError } from "./transport.ts";

const TOKEN = `sls_${"a".repeat(43)}`;
let dir: string;
let socketPath: string;
let server: Server | undefined;
let url = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "saveslot-client-export-"));
  socketPath = join(dir, "s.sock");
});
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function serve(answer: (req: IncomingMessage, res: ServerResponse) => void) {
  server = createServer((req, res) => {
    url = req.url ?? "";
    answer(req, res);
  });
  await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
}

const manifest = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    saveslot_export: 1,
    tenant_id: "tn_x",
    event_format: 1,
    restore_count: 0,
    upto: 3,
    events: 3,
    exported_at: "2026-11-10T08:00:00.000Z",
    pending_deletions: "placeholder",
    ...o,
  });
const event = (seq: number) => JSON.stringify({ h: { seq } });

const client = () => createClient({ socketPath, token: TOKEN });
async function readAll(s: ReadableStream<Uint8Array>): Promise<string> {
  let out = "";
  for await (const c of s) out += Buffer.from(c).toString("utf8");
  return out;
}

describe("client.export", () => {
  it("sends the parameters in the query and gives the manifest, then the bytes as they came", async () => {
    await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${manifest()}\n`);
      res.write(`${event(1)}\n${event(2)}`);
      res.end(`\n${event(3)}\n`);
    });
    const r = await client().export({ after_seq: 0, include_pending_deletion: true });
    expect(url).toBe("/v1/export?after_seq=0&include_pending_deletion=true");
    expect(r.manifest).toMatchObject({ upto: 3, events: 3 });
    expect(await readAll(r.body)).toBe(`${manifest()}\n${event(1)}\n${event(2)}\n${event(3)}\n`);
  });

  it("an error answer is the contract's error, before any stream", async () => {
    await serve((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "insufficient_scope", message: "no", required_scope: "user_session" },
        }),
      );
    });
    const e = await client()
      .export()
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ContractCallError);
    expect((e as ContractCallError).code).toBe("insufficient_scope");
  });

  it("cut off mid-stream: the stream fails, it does not end", async () => {
    await serve((_req, res) => {
      res.writeHead(200);
      res.write(`${manifest()}\n${event(1)}\n`);
      setTimeout(() => res.destroy(), 20);
    });
    const r = await client().export();
    const e = await readAll(r.body).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TransportError);
    expect((e as TransportError).code).toBe("broken");
  });

  it("an answer that ends short of the manifest's events fails at its end", async () => {
    await serve((_req, res) => {
      res.writeHead(200);
      res.end(`${manifest()}\n${event(1)}\n${event(2)}\n`);
    });
    const r = await client().export();
    const e = await readAll(r.body).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TransportError);
    expect((e as Error).message).toContain("2 events, the manifest says 3");
  });

  it("an answer that ends inside a line fails", async () => {
    await serve((_req, res) => {
      res.writeHead(200);
      res.end(`${manifest()}\n${event(1)}\n${event(2)}\n{"h":{"seq":`);
    });
    const e = await readAll((await client().export()).body).catch((x: unknown) => x);
    expect((e as Error).message).toContain("no end");
  });

  it("an answer whose last event is not the manifest's upto fails", async () => {
    await serve((_req, res) => {
      res.writeHead(200);
      res.end(`${manifest({ upto: 4 })}\n${event(1)}\n${event(2)}\n${event(3)}\n`);
    });
    const e = await readAll((await client().export()).body).catch((x: unknown) => x);
    expect((e as Error).message).toContain("upto");
  });

  it("an empty continuation (no events) is whole", async () => {
    await serve((_req, res) => {
      res.writeHead(200);
      res.end(`${manifest({ after: 3, events: 0 })}\n`);
    });
    const r = await client().export({ after_seq: 3 });
    expect(await readAll(r.body)).toContain('"events":0');
  });

  it("an answer that is not a manifest is refused at once", async () => {
    await serve((_req, res) => {
      res.writeHead(200);
      res.end('{"not":"a manifest"}\n');
    });
    const e = await client()
      .export()
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TransportError);
    expect((e as TransportError).code).toBe("bad_answer");
  });

  it("a line that is not JSON fails", async () => {
    await serve((_req, res) => {
      res.writeHead(200);
      res.end(`${manifest()}\n${event(1)}\nnot json\n${event(3)}\n`);
    });
    const e = await readAll((await client().export()).body).catch((x: unknown) => x);
    expect((e as Error).message).toContain("line 3 is not JSON");
  });

  it("a gap in the seq fails, unless a tenant.restored explains it", async () => {
    await serve((_req, res) => {
      res.writeHead(200);
      res.end(`${manifest()}\n${event(1)}\n${event(3)}\n${event(4)}\n`);
    });
    const e = await readAll((await client().export()).body).catch((x: unknown) => x);
    expect((e as Error).message).toContain("event 3 does not follow 1");

    await new Promise<void>((r) => server?.close(() => r()));
    const restored = JSON.stringify({ h: { seq: 9, type: "tenant.restored", restored_to: 2 } });
    await serve((_req, res) => {
      res.writeHead(200);
      res.end(`${manifest({ upto: 9 })}\n${event(1)}\n${event(2)}\n${restored}\n`);
    });
    expect(await readAll((await client().export()).body)).toContain('"restored_to":2');
  });

  it("the manifest's after must be the after_seq asked for", async () => {
    await serve((_req, res) => {
      res.writeHead(200);
      res.end(`${manifest({ after: 1, events: 2 })}\n${event(2)}\n${event(3)}\n`);
    });
    const e = await client()
      .export({ after_seq: 2 })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TransportError);
    expect((e as Error).message).toContain("not the after_seq asked for");
  });

  it("no events: upto must be after", async () => {
    await serve((_req, res) => {
      res.writeHead(200);
      res.end(`${manifest({ after: 3, upto: 5, events: 0 })}\n`);
    });
    const e = await readAll((await client().export({ after_seq: 3 })).body).catch(
      (x: unknown) => x,
    );
    expect((e as Error).message).toContain("no events, and upto is not after");
  });

  it("a reader that cancels, or a check that fails, closes the connection at once", async () => {
    let closed: () => void = () => {};
    const gone = new Promise<void>((r) => {
      closed = r;
    });
    await serve((req, res) => {
      res.writeHead(200);
      res.write(`${manifest({ upto: 1000, events: 1000 })}\n${event(1)}\n`);
      // Never ends on its own: only the reader can end it.
      req.socket.on("close", () => closed());
    });
    const r = await client().export();
    const reader = r.body.getReader();
    await reader.read();
    await reader.cancel();
    await gone;

    let closed2: () => void = () => {};
    const gone2 = new Promise<void>((r2) => {
      closed2 = r2;
    });
    await new Promise<void>((r2) => server?.close(() => r2()));
    await serve((req, res) => {
      res.writeHead(200);
      res.write(`${manifest({ upto: 1000, events: 1000 })}\n${event(1)}\n${event(5)}\n`);
      req.socket.on("close", () => closed2());
    });
    const bad = await readAll((await client().export()).body).catch((x: unknown) => x);
    expect((bad as Error).message).toContain("does not follow");
    await gone2;
  });
});
