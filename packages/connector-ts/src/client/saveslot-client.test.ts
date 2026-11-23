import { describe, expect, it } from "vitest";
import { SaveslotError } from "../errors.ts";
import { MAX_WAIT_MS, SaveslotClient, utf8Header } from "./saveslot-client.ts";

const CREDENTIAL = "sk_conn_fictional";

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fake service: answers with the next of `answers`, then with `route`. */
function fake(route: (req: Seen) => Answer, answers: Answer[] = []) {
  const seen: Seen[] = [];
  const waits: number[] = [];
  const fetchFn = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    // As the service reads them: the bytes of each value decoded as UTF-8.
    const headers: Record<string, string> = {};
    for (const [k, v] of new Headers(init?.headers)) {
      headers[k] = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(v, "latin1"));
    }
    const req: Seen = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      headers,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    seen.push(req);
    const answer = answers.shift() ?? route(req);
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json", ...answer.headers },
    });
  }) as typeof fetch;
  const client = new SaveslotClient({
    baseUrl: "https://saveslot.example.com/base",
    credential: CREDENTIAL,
    fetch: fetchFn,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { client, seen, waits };
}

const SLOT = (slot: string) => ({
  slot,
  slot_id: `sl_${slot}`,
  sv: 2,
  timezone: "Asia/Shanghai",
  tables: [{ table: "messages", kind: "base", description: "" }],
});

describe("SaveslotClient", () => {
  it("reads one slot over every page of its tables, under the base path, with the credential", async () => {
    const page = (tables: string[], next?: string) => ({
      status: 200,
      body: {
        level: "list",
        total: 1,
        slots: [{ ...SLOT("mail"), tables: tables.map((table) => ({ table, kind: "base" })) }],
        ...(next === undefined ? {} : { next_cursor: next }),
      },
    });
    const { client, seen } = fake(() => ({ status: 500 }), [page(["a", "b"], "c2"), page(["c"])]);
    const slot = await client.getSlot("mail");
    expect(slot?.tables.map((t) => t.table)).toEqual(["a", "b", "c"]);
    expect(slot?.timezone).toBe("Asia/Shanghai");
    expect(seen.map((s) => s.path)).toEqual([
      "/base/v1/slots/mail",
      "/base/v1/slots/mail?cursor=c2",
    ]);
    expect(seen[0]?.headers["authorization"]).toBe(`Bearer ${CREDENTIAL}`);
  });

  it("a slot the credential cannot see is undefined; one with no time zone is a bad reply", async () => {
    const missing = fake(() => ({ status: 404, body: { error: { code: "not_found" } } }));
    expect(await missing.client.getSlot("mail")).toBeUndefined();
    const { timezone: _, ...noZone } = SLOT("mail");
    const bad = fake(() => ({ status: 200, body: { level: "list", total: 1, slots: [noZone] } }));
    await expect(bad.client.getSlot("mail")).rejects.toMatchObject({ code: "bad_reply" });
  });

  it("reads tables ten at a time", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const { client, seen } = fake((req) => {
      const asked = new URL(`https://x${req.path}`).searchParams.get("tables")?.split(",") ?? [];
      return {
        status: 200,
        body: {
          level: "table",
          tables: asked.map((table) => ({
            table,
            slot: "mail",
            sv: 2,
            kind: "base",
            fields: [{ name: "message_id" }],
          })),
        },
      };
    });
    const tables = await client.getTables("mail", names);
    expect(tables).toHaveLength(12);
    expect(tables[0]).toEqual({
      slot: "mail",
      table: "t0",
      sv: 2,
      kind: "base",
      fields: ["message_id"],
    });
    expect(seen).toHaveLength(2);
  });

  it("writes with an idempotency key and a task", async () => {
    const { client, seen } = fake(() => ({
      status: 200,
      body: { status: "saved", sv: 2, seq: 7, ops: [], pending: [] },
    }));
    const request = {
      sv: 2,
      ops: [{ intent: "insert" as const, table: "mail.messages", set: {} }],
    };
    const receipt = await client.write(request, { idempotencyKey: "k1", task: "mail-sync" });
    expect(receipt.status).toBe("saved");
    expect(seen[0]?.body).toEqual(request);
    expect(seen[0]?.headers["idempotency-key"]).toBe("k1");
    expect(seen[0]?.headers["x-task-id"]).toBe("mail-sync");
  });

  it("sends a task in any Unicode as UTF-8 bytes, and refuses a key it cannot send before sending", async () => {
    const { client, seen } = fake(() => ({
      status: 200,
      body: { status: "saved", sv: 2, ops: [], pending: [] },
    }));
    await client.write({ ops: [] }, { task: "整理账单 · 🧾" });
    expect(seen[0]?.headers["x-task-id"]).toBe("整理账单 · 🧾");
    expect(utf8Header("é")).toBe("\u00c3\u00a9");
    await expect(client.write({ ops: [] }, { task: "a\nb" })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(
      client.write({ ops: [] }, { idempotencyKey: "k".repeat(257) }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(seen).toHaveLength(1);
  });

  it("an extra header fetch cannot carry is refused at once, not tried again", async () => {
    const seen: unknown[] = [];
    const client = new SaveslotClient({
      baseUrl: "https://saveslot.example.com",
      credential: CREDENTIAL,
      headers: { "x-trace": "a\r\nb" },
      fetch: (async () => {
        seen.push(1);
        return new Response("{}");
      }) as typeof fetch,
      sleep: async () => {},
    });
    await expect(client.getSlot("mail")).rejects.toMatchObject({ code: "invalid_argument" });
    expect(seen).toEqual([]);
  });

  it("a body JSON cannot carry is refused at once, not tried again as unreachable", async () => {
    const { client, seen, waits } = fake(() => ({ status: 200, body: {} }));
    await expect(
      client.write({ ops: [{ intent: "insert", table: "t", set: { n: 10n } }] }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(seen).toEqual([]);
    expect(waits).toEqual([]);
  });

  it("a credential Headers refuses is an invalid_argument with no cause quoting it", async () => {
    const seen: unknown[] = [];
    const client = new SaveslotClient({
      baseUrl: "https://saveslot.example.com",
      credential: "slt_secret\nline2",
      fetch: (async () => {
        seen.push(1);
        return new Response("{}");
      }) as typeof fetch,
      sleep: async () => {},
    });
    const error = await client.getSlot("mail").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_argument", details: { header: "Authorization" } });
    expect((error as Error).cause).toBeUndefined();
    expect(String((error as Error).message)).not.toContain("secret");
    expect(seen).toEqual([]);
  });

  it("tries again after 503 as Retry-After says, under the same key", async () => {
    const { client, seen, waits } = fake(
      () => ({ status: 200, body: { status: "saved", sv: 2, ops: [], pending: [] } }),
      [{ status: 503, headers: { "retry-after": "2" } }],
    );
    await client.write({ ops: [] }, { idempotencyKey: "k1" });
    expect(waits).toEqual([2000]);
    expect(seen.map((s) => s.headers["idempotency-key"])).toEqual(["k1", "k1"]);
  });

  it("waits at most MAX_WAIT_MS, whatever Retry-After says", async () => {
    const { client, waits } = fake(
      () => ({ status: 200, body: { status: "saved", sv: 2, ops: [], pending: [] } }),
      [{ status: 429, headers: { "retry-after": "86400" } }],
    );
    await client.write({ ops: [] });
    expect(waits).toEqual([MAX_WAIT_MS]);
  });

  it("gives the service's error code, and never the credential", async () => {
    const { client } = fake(() => ({
      status: 401,
      body: { error: { code: "unauthenticated", message: "the token is not valid" } },
    }));
    const error = await client.getSlot("mail").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SaveslotError);
    expect(error).toMatchObject({ code: "unauthenticated", status: 401 });
    expect(String((error as Error).message)).not.toContain(CREDENTIAL);
  });

  it("gives up as unreachable after the retries", async () => {
    const { client, seen } = fake(() => new TypeError("fetch failed"));
    await expect(client.getSlot("mail")).rejects.toMatchObject({ code: "unreachable" });
    expect(seen).toHaveLength(5);
  });

  it("refuses a bad base URL and an empty credential", () => {
    expect(() => new SaveslotClient({ baseUrl: "not a url", credential: "x" })).toThrow(
      expect.objectContaining({ code: "invalid_config" }),
    );
    expect(
      () => new SaveslotClient({ baseUrl: "https://saveslot.example.com", credential: "" }),
    ).toThrow(expect.objectContaining({ code: "invalid_config" }));
  });
});
