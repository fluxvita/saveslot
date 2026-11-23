// `ConnectorClient` against a fake service. The fake refuses what today's service refuses (a draft
// with `base_version`, `external_key` or `aliases`: 501 `not_in_this_version`), lists tables with
// `kind` `base`, replays a write sent again under its key (and refuses other content under it as
// `invalid_argument` / `idempotency_key_reuse`), and reads header values as UTF-8 bytes.
// `connector-client.service.test.ts` runs the same flows against the real service.

import { beforeEach, describe, expect, it } from "vitest";
import {
  ConnectorClient,
  type ConnectorManifest,
  ConnectorPlatform,
  type ConnectorProvider,
  MAX_RETRIES,
  SaveslotError,
  type SchemaBuilder,
  SDK_VERSION,
  SlotRecord,
  type TableDefinition,
} from "../index.ts";

const MANIFEST: ConnectorManifest = {
  id: "com.example.mail",
  name: "Mail",
  description: "Messages from a mailbox.",
  logo: "https://example.com/mail.png",
  version: "1.2.0",
  publisher: "Example",
  platforms: [ConnectorPlatform.Cloud],
};

beforeEach(() => ConnectorClient.reset());

const MESSAGES: TableDefinition = {
  name: "messages",
  description: "One message received",
  time: { type: "event", field: "received_at" },
  fields: [
    { name: "message_id", type: "text", required: true, description: "The Message-ID" },
    { name: "received_at", type: "zoned_datetime", required: true, description: "When received" },
    { name: "subject", type: "text", description: "The subject" },
  ],
};

const NOTES: TableDefinition = {
  name: "notes",
  description: "A note about the mailbox",
  time: { type: "none" },
  fields: [{ name: "text", type: "text", description: "The note" }],
};

class MailProvider implements ConnectorProvider {
  readonly #tables: TableDefinition[];
  constructor(tables: TableDefinition[] = [MESSAGES, NOTES]) {
    this.#tables = tables;
  }
  defineSchema(schema: SchemaBuilder): SchemaBuilder {
    schema.addSlot("mail", "Asia/Shanghai");
    for (const t of this.#tables) schema.addTable(t);
    return schema;
  }
}

class MailMessage extends SlotRecord {
  readonly #m: { id: string; subject: string };
  constructor(m: { id: string; subject: string }) {
    super();
    this.#m = m;
  }
  table() {
    return "messages";
  }
  fields() {
    return {
      message_id: this.#m.id,
      received_at: "2026-11-18T09:00:00+08:00[Asia/Shanghai]",
      subject: this.#m.subject,
    };
  }
}

class Note extends SlotRecord {
  readonly #fields: Record<string, unknown>;
  constructor(text: string, extra: Record<string, unknown> = {}) {
    super();
    this.#fields = { text, ...extra };
  }
  table() {
    return "notes";
  }
  fields() {
    return this.#fields;
  }
}

interface FakeTable {
  table: string;
  fields: string[];
}

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
  raw: string | undefined;
}

/** A service holding at most the slot `mail`, as `state` says; a draft can only create it. */
function fakeService(
  state: { sv: number; tables: FakeTable[] } | undefined,
  o: { draftOutcome?: "applied" | "pending"; statuses?: number[] } = {},
) {
  let slot = state;
  const seen: Seen[] = [];
  const keys = new Map<string, { body: string; receipt: unknown }>();
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const later = (param: string) =>
    json(501, { error: { code: "not_in_this_version", param, message: param } });
  const slotJson = () =>
    slot === undefined
      ? []
      : [
          {
            slot: "mail",
            slot_id: "sl_mail",
            sv: slot.sv,
            timezone: "Asia/Shanghai",
            tables: slot.tables.map((t) => ({ table: t.table, kind: "base", description: "" })),
          },
        ];
  const fn = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = Object.create(null);
    for (const [k, v] of new Headers(init?.headers)) {
      headers[k] = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(v, "latin1"));
    }
    const raw = init?.body === undefined ? undefined : String(init.body);
    const body = raw === undefined ? undefined : JSON.parse(raw);
    seen.push({
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      headers,
      body,
      raw,
    });
    const status = o.statuses?.shift();
    if (status !== undefined && status !== 200) {
      return json(status, { error: { code: "unauthenticated", message: "not valid" } });
    }
    if (url.pathname === "/v1/slots/mail") {
      if (slot === undefined) return json(404, { error: { code: "not_found" } });
      return json(200, { level: "list", total: 1, slots: slotJson() });
    }
    if (url.pathname === "/v1/slots/mail/tables" && slot !== undefined) {
      const current = slot;
      const names = url.searchParams.get("tables")?.split(",") ?? [];
      const tables = names.map((n) => current.tables.find((t) => t.table === n));
      if (tables.includes(undefined)) return json(404, { error: { code: "unknown_table" } });
      return json(200, {
        level: "table",
        tables: tables.map((t) => ({
          table: t?.table,
          slot: "mail",
          sv: current.sv,
          timezone: "Asia/Shanghai",
          kind: "base",
          description: "",
          fields: t?.fields.map((name) => ({ name, type: "text", description: name })),
        })),
      });
    }
    if (url.pathname === "/v1/drafts") {
      const document = (body as { document: Record<string, unknown> }).document;
      if (document["base_version"] !== null) return later("base_version");
      const listed = document["tables"] as Record<string, unknown>[];
      for (const [i, t] of listed.entries()) {
        if ("external_key" in t) return later(`tables/${i}/external_key`);
        if ("aliases" in t) return later(`tables/${i}/aliases`);
      }
      const outcome = o.draftOutcome ?? "applied";
      if (outcome === "applied") {
        slot = {
          sv: 1,
          tables: listed.map((t) => ({
            table: String(t["name"]),
            fields: (t["fields"] as { name: string }[]).map((f) => f.name),
          })),
        };
      }
      return json(200, {
        draft: "dr_1",
        slot: "mail",
        slot_id: "sl_mail",
        target_sv: 1,
        outcome,
        ...(outcome === "applied" ? { sv: 1 } : {}),
      });
    }
    if (url.pathname === "/v1/writes") {
      const key = headers["idempotency-key"] ?? "";
      const done = keys.get(key);
      if (done !== undefined && done.body !== raw) {
        return json(400, {
          error: {
            code: "invalid_argument",
            reason: "idempotency_key_reuse",
            message: "the idempotency key was used with another request",
          },
        });
      }
      if (done !== undefined) return json(200, { ...(done.receipt as object), replayed: true });
      const receipt = { status: "saved", sv: slot?.sv, ops: [], pending: [] };
      keys.set(key, { body: raw ?? "", receipt });
      return json(200, receipt);
    }
    return json(404, { error: { code: "not_found", message: "no such thing" } });
  }) as typeof fetch;
  return { fn, seen, posts: () => seen.filter((s) => s.method === "POST") };
}

const MAIL_STATE = () => ({
  sv: 3,
  tables: [
    { table: "messages", fields: ["message_id", "received_at", "subject"] },
    { table: "notes", fields: ["text"] },
  ],
});

function sdkOn(fn: typeof fetch, provider: ConnectorProvider = new MailProvider()) {
  return ConnectorClient.builder()
    .setManifest(MANIFEST)
    .setCredential("sk_conn_fictional")
    .setBaseUrl("https://saveslot.example.com")
    .setProvider(provider)
    .setFetch(fn)
    .build();
}

function caught(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("builder", () => {
  const base = () =>
    ConnectorClient.builder()
      .setManifest(MANIFEST)
      .setCredential("c")
      .setBaseUrl("https://saveslot.example.com")
      .setProvider(new MailProvider());

  it("builds and keeps a frozen copy of the manifest", () => {
    const sdk = base().build();
    expect(sdk.manifest).toEqual(MANIFEST);
    expect(sdk.manifest).not.toBe(MANIFEST);
    expect(Object.isFrozen(sdk.manifest)).toBe(true);
    expect(sdk.initialized).toBe(false);
  });

  it.each([
    ["manifest", () => ConnectorClient.builder().setCredential("c").setBaseUrl("https://x")],
    ["credential", () => base().setCredential("")],
    ["baseUrl", () => base().setBaseUrl("")],
    [
      "provider",
      () =>
        ConnectorClient.builder().setManifest(MANIFEST).setCredential("c").setBaseUrl("https://x"),
    ],
    ["manifest.name", () => base().setManifest({ ...MANIFEST, name: " " })],
    ["manifest.platforms", () => base().setManifest({ ...MANIFEST, platforms: [] })],
    [
      "manifest.platforms",
      () => base().setManifest({ ...MANIFEST, platforms: ["web" as ConnectorPlatform] }),
    ],
    ["manifest.platforms", () => base().setManifest({ ...MANIFEST, platforms: ["ios", "ios"] })],
    [
      "manifest.packages.android",
      () =>
        base().setManifest({
          ...MANIFEST,
          platforms: ["ios", "android"],
          packages: { ios: "https://apps.apple.com/app/id000" },
        }),
    ],
    [
      "manifest.packages.flutter",
      () => base().setManifest({ ...MANIFEST, packages: { flutter: "com.example.mail" } }),
    ],
    ["headers.Authorization", () => base().setHeaders({ Authorization: "Bearer other" })],
    ["headers.idempotency-key", () => base().setHeaders({ "idempotency-key": "k" })],
    ["retries", () => base().setRetries(Number.POSITIVE_INFINITY)],
    ["retries", () => base().setRetries(MAX_RETRIES + 1)],
    ["retries", () => base().setRetries(-1)],
    ["retries", () => base().setRetries(1.5)],
    ["timeout", () => base().setTimeout(0)],
    ["timeout", () => base().setTimeout(Number.NaN)],
  ])("refuses to build without a valid %s", (field, make) => {
    const error = caught(() => make().build());
    expect(error).toBeInstanceOf(SaveslotError);
    expect(error).toMatchObject({ code: "invalid_config", details: { field } });
  });

  it("keeps a package address for each mobile platform", () => {
    const sdk = base()
      .setManifest({
        ...MANIFEST,
        platforms: [ConnectorPlatform.IOS, ConnectorPlatform.Android],
        packages: { ios: "https://apps.apple.com/app/id000", android: "com.example.mail" },
      })
      .build();
    expect(sdk.manifest.platforms).toEqual(["ios", "android"]);
    expect(sdk.manifest.packages).toEqual({
      ios: "https://apps.apple.com/app/id000",
      android: "com.example.mail",
    });
    expect(Object.isFrozen(sdk.manifest.platforms)).toBe(true);
  });

  it("has a platform list nobody can change", () => {
    expect(Object.isFrozen(ConnectorPlatform)).toBe(true);
    expect(Object.values(ConnectorPlatform)).toEqual([
      "cloud",
      "ios",
      "android",
      "flutter",
      "react_native",
    ]);
  });

  it("builds one instance, reached from anywhere with with()", () => {
    expect(() => ConnectorClient.with()).toThrow(expect.objectContaining({ code: "not_built" }));
    const sdk = base().build();
    expect(ConnectorClient.with()).toBe(sdk);
    expect(() => base().build()).toThrow(expect.objectContaining({ code: "already_built" }));
    ConnectorClient.reset();
    expect(base().build()).not.toBe(sdk);
  });

  it("sends an extra header named __proto__ like any other", async () => {
    const { fn, seen } = fakeService(MAIL_STATE());
    const sdk = base().setHeaders(JSON.parse('{"__proto__": "x"}')).setFetch(fn).build();
    await sdk.init();
    expect(Object.entries(seen[0]?.headers ?? {})).toContainEqual(["__proto__", "x"]);
  });

  it("refuses a credential a token cannot be, without quoting it", () => {
    for (const credential of ["slt_secret\nline2", "slt_secret ", "slt_秘密"]) {
      ConnectorClient.reset();
      const error = caught(() => base().setCredential(credential).build());
      expect(error).toMatchObject({ code: "invalid_config", details: { field: "credential" } });
      expect(String((error as Error).message)).not.toContain("secret");
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("cannot be made without the builder", () => {
    const Ctor = ConnectorClient as unknown as new (...a: unknown[]) => unknown;
    expect(() => new Ctor(Symbol("create"), {})).toThrow(SaveslotError);
  });

  it("sends the credential, the SDK and connector in User-Agent (as UTF-8), and the extra headers", async () => {
    const { fn, seen } = fakeService(MAIL_STATE());
    const sdk = ConnectorClient.builder()
      .setManifest({ ...MANIFEST, id: "com.example.邮件" })
      .setCredential("sk_conn_fictional")
      .setBaseUrl("https://saveslot.example.com")
      .setProvider(new MailProvider())
      .setHeaders({ "X-Trace-Id": "trace-1" })
      .setFetch(fn)
      .build();
    await sdk.init();
    expect(seen[0]?.headers).toMatchObject({
      authorization: "Bearer sk_conn_fictional",
      "user-agent": `saveslot-connector-ts/${SDK_VERSION} (com.example.邮件/1.2.0)`,
      "x-trace-id": "trace-1",
      accept: "application/json",
    });
  });
});

describe("init", () => {
  it("creates the slot with every declared table when it does not exist", async () => {
    const { fn, posts } = fakeService(undefined);
    const sdk = sdkOn(fn);
    await sdk.init();
    expect(sdk.initialized).toBe(true);
    const drafts = posts();
    expect(drafts).toHaveLength(1);
    const document = drafts[0]?.body?.["document"] as Record<string, unknown>;
    expect(document).toMatchObject({ slot: "mail", base_version: null, timezone: "Asia/Shanghai" });
    expect((document["tables"] as { name: string }[]).map((t) => t.name)).toEqual([
      "messages",
      "notes",
    ]);
    expect(drafts[0]?.headers["x-task-id"]).toBe("com.example.mail");
  });

  it("creates nothing when the slot has every table, even when init is called at once twice", async () => {
    const { fn, posts, seen } = fakeService(MAIL_STATE());
    const sdk = sdkOn(fn);
    await Promise.all([sdk.init(), sdk.init()]);
    await sdk.init();
    expect(posts()).toHaveLength(0);
    expect(
      seen.filter((s) => s.path === "/v1/slots/mail/tables?tables=messages%2Cnotes"),
    ).toHaveLength(1);
  });

  it("reports a missing table or field and changes nothing, without pointing at a way it cannot take", async () => {
    const state = MAIL_STATE();
    state.tables = [{ table: "messages", fields: ["message_id", "received_at"] }];
    const { fn, posts } = fakeService(state);
    const sdk = sdkOn(fn);
    const error = await sdk.init().catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "schema_mismatch",
      details: {
        tables: [
          { table: "messages", missingFields: ["subject"] },
          { table: "notes", missing: true },
        ],
      },
    });
    expect((error as Error).message).not.toContain("updateTable");
    expect(sdk.initialized).toBe(false);
    expect(posts()).toHaveLength(0);
  });

  it("stops when creating waits for the user's confirmation", async () => {
    const { fn } = fakeService(undefined, { draftOutcome: "pending" });
    const sdk = sdkOn(fn);
    await expect(sdk.init()).rejects.toMatchObject({
      code: "schema_pending",
      details: { draft: "dr_1" },
    });
    expect(sdk.initialized).toBe(false);
  });

  it("stays uninitialized when the credential is refused, and can try again", async () => {
    const { fn } = fakeService(MAIL_STATE(), { statuses: [401] });
    const sdk = sdkOn(fn);
    await expect(sdk.init()).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
    expect(sdk.initialized).toBe(false);
    await sdk.init();
    expect(sdk.initialized).toBe(true);
  });

  it.each([
    ["no slot", { defineSchema: (s: SchemaBuilder) => s.addTable(MESSAGES) }],
    ["no table", { defineSchema: (s: SchemaBuilder) => s.addSlot("mail", "UTC") }],
    [
      "two slots",
      { defineSchema: (s: SchemaBuilder) => s.addSlot("mail", "UTC").addSlot("other", "UTC") },
    ],
    [
      "a table twice",
      {
        defineSchema: (s: SchemaBuilder) =>
          s
            .addSlot("mail", "UTC")
            .addTable(MESSAGES)
            .addTable({ ...MESSAGES, name: "Messages" }),
      },
    ],
    ["another builder", { defineSchema: () => ({}) as SchemaBuilder }],
  ])("refuses a schema with %s", async (_, provider) => {
    const { fn, posts } = fakeService(undefined);
    await expect(sdkOn(fn, provider).init()).rejects.toMatchObject({ code: "invalid_schema" });
    expect(posts()).toHaveLength(0);
  });
});

describe("write", () => {
  it("refuses before init", async () => {
    const { fn } = fakeService(MAIL_STATE());
    await expect(sdkOn(fn).write([new Note("hi")])).rejects.toMatchObject({
      code: "not_initialized",
    });
  });

  it("writes records by table, as inserts, with the slot's version and the manifest id as task", async () => {
    const { fn, posts } = fakeService(MAIL_STATE());
    const sdk = sdkOn(fn);
    await sdk.init();
    const result = await sdk.write([
      new MailMessage({ id: "m1", subject: "Hello" }),
      new Note("checked"),
      new MailMessage({ id: "m1", subject: "Hello again" }),
    ]);
    const [messages, notes] = posts();
    expect(messages?.body).toEqual({
      sv: 3,
      ops: ["Hello", "Hello again"].map((subject) => ({
        intent: "insert",
        table: "mail.messages",
        set: {
          message_id: "m1",
          received_at: "2026-11-18T09:00:00+08:00[Asia/Shanghai]",
          subject,
        },
      })),
    });
    expect(notes?.body).toEqual({
      sv: 3,
      ops: [{ intent: "insert", table: "mail.notes", set: { text: "checked" } }],
    });
    expect(messages?.headers["x-task-id"]).toBe("com.example.mail");
    expect(result).toEqual({ records: 3, created: 3, replayed: 0, pending: 0 });
  });

  it("sends a field named __proto__ like any other", async () => {
    const { fn, posts } = fakeService(MAIL_STATE());
    const sdk = sdkOn(fn);
    await sdk.init();
    const extra: Record<string, unknown> = {};
    Object.defineProperty(extra, "__proto__", { value: "kept", enumerable: true });
    await sdk.write([new Note("x", extra)]);
    expect(posts()[0]?.raw).toContain('"__proto__":"kept"');
  });

  it("splits large writes, each under its own key derived from the given one", async () => {
    const { fn, posts } = fakeService(MAIL_STATE());
    const sdk = sdkOn(fn);
    await sdk.init();
    const notes = Array.from({ length: 250 }, (_, i) => new Note(`note ${i}`));
    await sdk.write(notes, { key: "sync-7", task: "整理账单" });
    expect(posts().map((p) => p.headers["idempotency-key"])).toEqual([
      "sync-7.notes.0",
      "sync-7.notes.1",
      "sync-7.notes.2",
    ]);
    expect(posts().map((p) => (p.body as { ops: unknown[] }).ops.length)).toEqual([100, 100, 50]);
    expect(posts()[0]?.headers["x-task-id"]).toBe("整理账单");
  });

  it("counts a write sent again under the same key as replayed, not created", async () => {
    const { fn } = fakeService(MAIL_STATE());
    const sdk = sdkOn(fn);
    await sdk.init();
    const notes = Array.from({ length: 150 }, (_, i) => new Note(`note ${i}`));
    expect(await sdk.write(notes, { key: "k" })).toEqual({
      records: 150,
      created: 150,
      replayed: 0,
      pending: 0,
    });
    expect(await sdk.write(notes, { key: "k" })).toEqual({
      records: 150,
      created: 0,
      replayed: 150,
      pending: 0,
    });
  });

  it("refuses a table not declared, a bad task, and a key too long for a later part, sending nothing", async () => {
    const { fn, posts } = fakeService(MAIL_STATE());
    const sdk = sdkOn(fn);
    await sdk.init();
    class Lap extends SlotRecord {
      table() {
        return "laps";
      }
      fields() {
        return {};
      }
    }
    await expect(sdk.write([new Lap()])).rejects.toMatchObject({ code: "unknown_table" });
    await expect(sdk.write([new Note("x")], { task: " padded " })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    // `<key>.notes.0` is 256 characters, `<key>.notes.10` is 257.
    const notes = Array.from({ length: 1100 }, (_, i) => new Note(`note ${i}`));
    await expect(sdk.write(notes, { key: "k".repeat(248) })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(posts()).toHaveLength(0);
  });

  it("refuses a record JSON cannot carry before sending anything, naming it", async () => {
    const { fn, posts } = fakeService(MAIL_STATE());
    const sdk = sdkOn(fn);
    await sdk.init();
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    for (const bad of [{ count: 10n }, { cycle }]) {
      const error = await sdk
        .write([new Note("fine"), new Note("bad", bad)], { key: "k" })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "invalid_argument",
        status: undefined,
        details: { table: "notes", record: 1 },
      });
    }
    expect(posts()).toHaveLength(0);
  });

  it("tells other records under a key already used apart, with what had been applied", async () => {
    const { fn, posts } = fakeService(MAIL_STATE());
    const sdk = sdkOn(fn);
    await sdk.init();
    const first = Array.from({ length: 150 }, (_, i) => new Note(`note ${i}`));
    await sdk.write(first, { key: "P" });
    const more = [...first, ...Array.from({ length: 10 }, (_, i) => new Note(`new ${i}`))];
    const error = await sdk.write(more, { key: "P" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SaveslotError);
    expect(error).toMatchObject({
      code: "key_reused",
      status: 400,
      written: { records: 160, created: 0, replayed: 100, pending: 0 },
    });
    expect((error as Error).message).toContain("write 2 of 2");
    expect(posts()).toHaveLength(4);
  });

  it("gives what had been applied with any error once sending has started", async () => {
    const { fn } = fakeService(MAIL_STATE(), { statuses: [200, 200, 200, 200, 401] });
    const sdk = sdkOn(fn);
    await sdk.init();
    const notes = Array.from({ length: 150 }, (_, i) => new Note(`note ${i}`));
    await expect(sdk.write(notes)).rejects.toMatchObject({
      code: "unauthenticated",
      status: 401,
      written: { records: 150, created: 100, replayed: 0, pending: 0 },
    });
  });
});
