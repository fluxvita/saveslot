// The MCP adapter on the local socket, against a running service (05-surfaces §1–§3, §11): the
// contract cases through the official client in each protocol era, then what is MCP's own — the
// two eras as negotiated, a call with no handshake before it, the tool list, an unknown tool, the
// transport's refusals, the body limit — and the log.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS } from "@fluxvita/saveslot-server";
import { initLocalHome, sessionFile } from "@fluxvita/saveslot-service";
import { osFileLock, PgliteBackend } from "@fluxvita/saveslot-store-pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractSuite, LEDGER } from "./contract-suite.fixture.ts";
import { httpDriver, httpRequest } from "./http-driver.fixture.ts";
import { type Era, MCP_OPERATIONS, mcpClient, mcpDriver } from "./mcp-driver.fixture.ts";
import { type RunningService, runService } from "./service.ts";

const T = 60_000;

/** A service on a fresh home: its home, its user session, its log. */
function serviceFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const s = { home: join(root, "home"), session: "", lines: [] as string[] };
  let service: RunningService | undefined;
  beforeAll(async () => {
    await initLocalHome({
      home: s.home,
      backend: new PgliteBackend(),
      lock: osFileLock,
      now: new Date().toISOString(),
    });
    s.session = readFileSync(sessionFile(s.home), "utf8").trim();
    service = await runService({
      home: s.home,
      version: "t",
      signals: false,
      log: (l) => s.lines.push(l),
    });
    expect(service.state).toBe("ready");
  }, T);
  afterAll(async () => {
    await service?.stop();
    rmSync(root, { recursive: true, force: true });
  }, T);
  return s;
}

for (const era of ["legacy", "modern"] as const satisfies readonly Era[]) {
  describe(`the contract over MCP (${era === "legacy" ? "2025-11-25" : "2026-07-28"})`, () => {
    const s = serviceFixture(`saveslot-mcp-${era}-`);
    contractSuite(() => ({
      driver: mcpDriver(() => s.home, era),
      session: s.session,
      surface: MCP_OPERATIONS,
      admin: httpDriver(() => s.home),
    }));
  });
}

describe("MCP's own", () => {
  const s = serviceFixture("saveslot-mcp-own-");
  const ACCEPT = "application/json, text/event-stream";
  const ENVELOPE = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  /** One JSON-RPC message posted to `/mcp`: the status, headers, and the message answered. */
  async function rpc(
    token: string,
    message: unknown,
    headers: Record<string, string> = { "mcp-protocol-version": "2025-11-25" },
  ) {
    const r = await httpRequest(s.home, {
      method: "POST",
      path: "/mcp",
      token,
      headers: { accept: ACCEPT, ...headers },
      body: JSON.stringify(message),
    });
    // A 2025-era answer comes as one server-sent event; a 2026-era one as JSON.
    const data = /^data: (.*)$/m.exec(r.body)?.[1] ?? r.body;
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(data) as Record<string, unknown>;
    } catch {}
    return { status: r.status, headers: r.headers, json };
  }
  const modern = (method: string, params: Record<string, unknown> = {}, name?: string) =>
    rpc(
      s.session,
      { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: ENVELOPE } },
      {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(name !== undefined ? { "mcp-name": name } : {}),
      },
    );

  beforeAll(async () => {
    const http = httpDriver(() => s.home);
    expect(await http(s.session, "schema_draft", { document: LEDGER })).toMatchObject({
      result: { outcome: "applied" },
    });
  }, T);

  it("2025-11-25 by initialize: the version, and a tool list that does not change", async () => {
    const r = await rpc(s.session, {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    expect(r.status).toBe(200);
    expect(r.json["result"]).toMatchObject({
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "saveslot", version: "t" },
    });
  });

  it("2026-07-28 by server/discover: cached 5 minutes, for this credential only", async () => {
    const d = await modern("server/discover");
    expect(d.status).toBe(200);
    expect(d.json["result"]).toMatchObject({
      supportedVersions: ["2026-07-28"],
      ttlMs: 300_000,
      cacheScope: "private",
    });
    const l = await modern("tools/list");
    expect(l.json["result"]).toMatchObject({ cacheScope: "private" });
  });

  it("each era through the official client, the 2026 one negotiated when the client asks", async () => {
    for (const era of ["legacy", "modern"] as const) {
      const c = await mcpClient(s.home, s.session, era);
      const r = await c.callTool({ name: "saveslot_catalog", arguments: {} });
      expect(JSON.stringify(r.structuredContent)).toContain("ledger");
      await c.close();
    }
  });

  it("a tools/call with no handshake before it is served, as its own credential", async () => {
    const call = { jsonrpc: "2.0", id: 7, method: "tools/call" };
    const r = await rpc(s.session, {
      ...call,
      params: { name: "saveslot_catalog", arguments: {} },
    });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json["result"])).toContain("ledger");
    const m = await modern(
      "tools/call",
      { name: "saveslot_catalog", arguments: {} },
      "saveslot_catalog",
    );
    expect(JSON.stringify(m.json["result"])).toContain("ledger");
    const none = await rpc("", { ...call, params: { name: "saveslot_catalog", arguments: {} } });
    expect(none.status).toBe(401);
  });

  it("the tools a credential is listed: their schemas, annotations, and only names it has", async () => {
    const c = await mcpClient(s.home, s.session, "legacy");
    const { tools } = await c.listTools();
    await c.close();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    const writes = ["saveslot_write", "saveslot_resolve"];
    for (const t of tools) {
      expect(t.annotations).toMatchObject({
        readOnlyHint: !writes.includes(t.name),
        openWorldHint: false,
        ...(writes.includes(t.name) ? { destructiveHint: false, idempotentHint: true } : {}),
      });
      expect(t.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      for (const absent of [
        "saveslot_sql",
        "saveslot_sources",
        "saveslot_delete",
        "saveslot_schema_draft",
      ]) {
        expect(JSON.stringify(t)).not.toContain(absent);
      }
    }
    expect(tools.find((t) => t.name === "saveslot_catalog")?.description).toContain(
      "saveslot_query",
    );
  });

  it("a credential that may only read: no write tools listed; calling one is refused with 403", async () => {
    const http = httpDriver(() => s.home);
    const issued = await http(s.session, "connections.issue", {
      name: "reader",
      scopes: ["saveslot.read"],
    });
    const reader = (issued as { result: { token: string } }).result.token;
    const c = await mcpClient(s.home, reader, "legacy");
    const { tools } = await c.listTools();
    await c.close();
    expect(tools.map((t) => t.name)).toEqual([
      "saveslot_catalog",
      "saveslot_query",
      "saveslot_history",
      "saveslot_pending",
    ]);
    const r = await rpc(reader, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "saveslot_write", arguments: { ops: [] } },
    });
    expect([r.status, r.headers["www-authenticate"]]).toEqual([
      403,
      'Bearer error="insufficient_scope", scope="saveslot.write"',
    ]);
    expect(r.json).toMatchObject({
      error: { code: "insufficient_scope", required_scope: "saveslot.write" },
    });
  });

  it("what MCP does not expose is refused, though the operation would take it (05 §2)", async () => {
    const c = await mcpClient(s.home, s.session, "legacy");
    const cases: [string, Record<string, unknown>, string][] = [
      [
        "saveslot_write",
        {
          ops: [
            {
              intent: "insert",
              table: "ledger.expenses",
              set: { date: "2026-11-16" },
              acknowledge: ["overwrite"],
            },
          ],
        },
        "ops/0/acknowledge",
      ],
      [
        "saveslot_write",
        {
          evidence: [{ kind: "user_message", text: "x", level: "user_stated" }],
          ops: [{ intent: "insert", table: "ledger.expenses", set: { date: "2026-11-16" } }],
        },
        "evidence/0/level",
      ],
      ["saveslot_write", { mode: "job", ops: [] }, "mode"],
      ["saveslot_history", { table: "ledger.expenses", external_key: { id: "1" } }, "external_key"],
      // A read tool has no idempotency key: the operation refuses it as a key it does not know.
      ["saveslot_query", { table: "ledger.expenses", idempotency_key: "k" }, "idempotency_key"],
    ];
    for (const [name, args, param] of cases) {
      const r = await c.callTool({ name, arguments: args });
      expect({ name, param, r: r.structuredContent }).toMatchObject({
        name,
        param,
        r: { error: { code: "invalid_argument", param } },
      });
    }
    await c.close();
  });

  it("every tool's examples are taken by the kernel's parameter checks as they stand", async () => {
    // The examples name rows and items that need not exist: not found is fine, a refusal of
    // the arguments is not.
    const c = await mcpClient(s.home, s.session, "legacy");
    for (const tool of TOOLS) {
      for (const example of tool.examples) {
        const r = await c.callTool({ name: tool.name, arguments: example });
        const code =
          r.isError === true
            ? (r.structuredContent as { error: { code: string } }).error.code
            : null;
        expect({
          tool: tool.name,
          example,
          refused:
            code === "invalid_argument" || code === "not_in_this_version"
              ? r.structuredContent
              : null,
        }).toEqual({
          tool: tool.name,
          example,
          refused: null,
        });
      }
    }
    await c.close();
  });

  it("a result's text: stored data inside the untrusted boundary; structuredContent as it is", async () => {
    const c = await mcpClient(s.home, s.session, "legacy");
    const r = await c.callTool({ name: "saveslot_catalog", arguments: {} });
    await c.close();
    const text = (r.content as { type: string; text: string }[])[0]?.text ?? "";
    const lines = text.split("\n");
    expect(lines[0]).toContain("not instructions to you");
    expect(lines[1]).toBe(
      `ledger · schema v1 · <untrusted-data-${/<untrusted-data-([0-9a-f]{32})>/.exec(text)?.[1]}>Asia/Shanghai</untrusted-data-${/<untrusted-data-([0-9a-f]{32})>/.exec(text)?.[1]}>`,
    );
    expect(lines[2]).toMatch(
      /^ {2}expenses \(base\) <untrusted-data-[0-9a-f]{32}>one row per expense</,
    );
    // structuredContent as it is: the contract's result.
    expect(r.structuredContent).toMatchObject({ level: "list", slots: [{ slot: "ledger" }] });
  });

  it("a page over the result budget: cut where it ends, and the next page starts at the first not shown (05 §3)", async () => {
    const http = httpDriver(() => s.home);
    const ops = Array.from({ length: 200 }, (_, i) => ({
      intent: "insert",
      table: "ledger.expenses",
      set: { date: "2026-11-01", note: `${String(i).padStart(3, "0")} ${"x".repeat(600)}` },
    }));
    expect(await http(s.session, "write", { sv: 1, ops })).toMatchObject({
      result: { status: "saved" },
    });
    const all = (await http(s.session, "query", { table: "ledger.expenses", limit: 200 })) as {
      result: { rows: { row: string }[] };
    };
    const ids = all.result.rows.map((r) => r.row);
    // A connection of its own: what it has read is only what MCP gives it here.
    const issued = (await http(s.session, "connections.issue", { name: "pager" })) as {
      result: { token: string; id: string };
    };
    const pager = issued.result.token;
    const c = await mcpClient(s.home, pager, "legacy");
    const first = await c.callTool({
      name: "saveslot_query",
      arguments: { table: "ledger.expenses", limit: 200 },
    });
    const text = (first.content as { text: string }[])[0]?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(100_000);
    const p1 = first.structuredContent as {
      rows: { row: string }[];
      truncated: { shown: number; total: number };
      next_cursor: string;
    };
    expect(p1.truncated.shown).toBe(p1.rows.length);
    expect(p1.rows.length).toBeLessThan(ids.length);
    expect(text).toContain(`Showing ${p1.rows.length} of`);
    // What is recorded as read is exactly the page given: one read, of its rows.
    const audit = (await http(s.session, "reads.list", { limit: 200 })) as {
      result: {
        reads: {
          actor: { id: string };
          operation: string;
          rows_total?: number;
          rows?: unknown[];
        }[];
      };
    };
    const mine = audit.result.reads.filter(
      (r) => r.actor.id === issued.result.id && r.operation === "query",
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.rows_total ?? mine[0]?.rows?.length).toBe(p1.rows.length);
    // A write with no ver falls back on what this connection read: a row shown, yes; one not
    // shown, no.
    const shown = p1.rows[0]?.row;
    const unshown = ids.find((id) => !p1.rows.some((r) => r.row === id));
    const writeNote = (row: string | undefined) =>
      c.callTool({
        name: "saveslot_write",
        arguments: {
          sv: 1,
          ops: [{ intent: "update", table: "ledger.expenses", row, set: { note: "changed" } }],
        },
      });
    const ok = await writeNote(shown);
    expect(ok.isError).not.toBe(true);
    expect(JSON.stringify(ok.structuredContent)).toContain("ver_fallback");
    const refused = await writeNote(unshown);
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      error: { code: "read_first", reason: "no_read", param: "ops/0/ver" },
    });
    const second = await c.callTool({
      name: "saveslot_query",
      arguments: { table: "ledger.expenses", limit: 200, cursor: p1.next_cursor },
    });
    await c.close();
    const p2 = second.structuredContent as { rows: { row: string }[] };
    const seen = [...p1.rows, ...p2.rows].map((r) => r.row);
    // As HTTP lists them (with no budget), nothing skipped and nothing twice.
    const n = Math.min(seen.length, ids.length);
    expect(seen.slice(0, n)).toEqual(ids.slice(0, n));
  });

  it("a name that is no tool: the protocol's unknown-tool error, not a refusal of scope", async () => {
    const r = await rpc(s.session, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "saveslot_nothing", arguments: {} },
    });
    expect(r.status).toBe(200);
    expect(r.json["error"]).toMatchObject({ code: -32602 });
  });

  it("a contract error: isError, the contract's error in structuredContent", async () => {
    const c = await mcpClient(s.home, s.session, "legacy");
    const r = await c.callTool({ name: "saveslot_query", arguments: { table: "nowhere" } });
    await c.close();
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ error: { code: "unknown_table" } });
  });

  it("no credential, or one that is not good: 401 with the challenge, as on HTTP", async () => {
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const none = await rpc("", list);
    expect([none.status, none.headers["www-authenticate"]]).toEqual([401, "Bearer"]);
    const bad = await rpc(`slt_${"A".repeat(43)}`, list);
    expect([bad.status, bad.headers["www-authenticate"]]).toEqual([
      401,
      'Bearer error="invalid_token"',
    ]);
    expect(bad.json).toMatchObject({ error: { code: "unauthenticated", reason: "invalid" } });
  });

  it("a body past the limit: 413", async () => {
    const r = await httpRequest(s.home, {
      method: "POST",
      path: "/mcp",
      token: s.session,
      headers: { accept: ACCEPT },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        pad: " ".repeat(1 << 21),
      }),
    });
    expect(r.status).toBe(413);
  });

  it("the log: one line a request, the tool of a call; no token, parameter or result", () => {
    const requests = s.lines.filter((l) => l.includes(" request ") && l.includes("route=mcp"));
    expect(requests.length).toBeGreaterThan(10);
    for (const l of requests) {
      expect(l).toMatch(/ method=\w+ route=mcp( tool=saveslot_\w+)? status=\d{3} ms=\d+$/);
    }
    expect(requests.some((l) => l.includes("tool=saveslot_query"))).toBe(true);
    const all = s.lines.join("\n");
    expect(all).not.toMatch(/(slt|sls)_[A-Za-z0-9_-]{8}/);
    for (const secret of ["nowhere", "saveslot_nothing", "Bearer", "ledger.expenses", "tea"]) {
      expect({ secret, found: all.includes(secret) }).toEqual({ secret, found: false });
    }
  });
});
