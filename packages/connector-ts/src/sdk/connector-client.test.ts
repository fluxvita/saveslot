// `ConnectorClient` against a fake service. The fake refuses what today's service refuses (a draft
// with `base_version` or `aliases`: 501 `not_in_this_version`), lists tables with `kind` `base`
// and their source key, replays a write sent again under its idempotency key (and refuses other
// content under it as `invalid_argument` / `idempotency_key_reuse`), and reads header values as
// UTF-8 bytes. It records an idempotency key only when the request has one and appends something:
// a write whose ops by source key all end `unchanged` or `skipped` is not recorded, as the real
// service does not record it. Of a write by source key it refuses, as the real service does, an
// `insert` giving a key field, `external_key` on a table without a source key, a `ver` or a `row`
// with it, a key field missing or null, a `set` that is empty or absent, and two ops with one key
// (`duplicate_external_key`); a value `invalid` says is refused as `validation_failed` naming its
// op. Writes by source key end as the real service's would for a row nobody else touched (created
// the first time, unchanged when the same, updated when not), or as `byKey` says for a key.
// `connector-client.service.test.ts` runs the same flows, `awaiting` and `skipped` included,
// against the real service.

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

/** A write result with nothing counted. */
const NONE = {
  records: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  awaiting: 0,
  skipped: 0,
  replayed: 0,
  pending: 0,
};

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
  externalKey?: string[];
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
  o: {
    draftOutcome?: "applied" | "pending";
    statuses?: number[];
    /** How a write by this source key (its values, as JSON) ends, other than by comparison. */
    byKey?: Record<string, "pending" | "skipped">;
    /** A field value the fake refuses as `validation_failed`, naming the op that has it. */
    invalid?: unknown;
  } = {},
) {
  let slot = state;
  /** Per `table|key`: the `set` last delivered, as JSON. */
  const delivered = new Map<string, string>();
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
          ...(t?.externalKey === undefined ? {} : { external_key: t.externalKey }),
        })),
      });
    }
    if (url.pathname === "/v1/drafts") {
      const document = (body as { document: Record<string, unknown> }).document;
      if (document["base_version"] !== null) return later("base_version");
      const listed = document["tables"] as Record<string, unknown>[];
      for (const [i, t] of listed.entries()) {
        if ("aliases" in t) return later(`tables/${i}/aliases`);
      }
      const outcome = o.draftOutcome ?? "applied";
      if (outcome === "applied") {
        slot = {
          sv: 1,
          tables: listed.map((t) => ({
            table: String(t["name"]),
            fields: (t["fields"] as { name: string }[]).map((f) => f.name),
            ...(Array.isArray(t["external_key"])
              ? { externalKey: t["external_key"] as string[] }
              : {}),
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
      const key = headers["idempotency-key"];
      const done = key === undefined ? undefined : keys.get(key);
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
      const ops = (body as { ops: Record<string, unknown>[] }).ops;
      const refused = refusal(ops, slot?.tables ?? [], o.invalid);
      if (refused !== undefined) return json(refused.status, { error: refused.error });
      const keyed = ops.filter((op) => op["external_key"] !== undefined);
      const summary = { created: 0, updated: 0, unchanged: 0, pending: 0, skipped: 0 };
      const outcomes = keyed.map((op) => {
        const key = JSON.stringify(op["external_key"]);
        const at = `${String(op["table"])}|${key}`;
        const set = JSON.stringify(op["set"]);
        const outcome =
          o.byKey?.[key] ??
          (delivered.get(at) === undefined
            ? "created"
            : delivered.get(at) === set
              ? "unchanged"
              : "updated");
        if (outcome !== "skipped" && outcome !== "pending") delivered.set(at, set);
        summary[outcome] += 1;
        return { outcome };
      });
      const receipt = {
        status: summary.pending > 0 ? "pending" : "saved",
        sv: slot?.sv,
        ops: keyed.length > 0 ? outcomes : [],
        pending: Array.from({ length: summary.pending }, (_, i) => ({ item: `it_${i}` })),
        ...(keyed.length > 0 ? { external_key_summary: summary } : {}),
      };
      // A request that appends nothing does not record its key (04-write-and-read).
      const appends = summary.unchanged + summary.skipped < ops.length;
      if (key !== undefined && appends) keys.set(key, { body: raw ?? "", receipt });
      return json(200, receipt);
    }
    return json(404, { error: { code: "not_found", message: "no such thing" } });
  }) as typeof fetch;
  return { fn, seen, posts: () => seen.filter((s) => s.method === "POST") };
}

/** What the service refuses in a write's ops before applying any, as it would answer. */
function refusal(
  ops: readonly Record<string, unknown>[],
  tables: readonly FakeTable[],
  invalid: unknown,
): { status: number; error: Record<string, unknown> } | undefined {
  const bad = (reason: string, param: string, extra: Record<string, unknown> = {}) => ({
    status: 400,
    error: { code: "invalid_argument", reason, param, message: `${reason} at ${param}`, ...extra },
  });
  const seen = new Map<string, number>();
  for (const [i, op] of ops.entries()) {
    const name = String(op["table"]).split(".").pop();
    const keyFields = tables.find((t) => t.table === name)?.externalKey;
    const set = op["set"] as Record<string, unknown> | undefined;
    const ek = op["external_key"] as Record<string, unknown> | undefined;
    if (op["intent"] === "insert" && keyFields !== undefined) {
      const field = Object.keys(set ?? {}).find((f) => keyFields.includes(f));
      if (field !== undefined) return bad("insert_with_external_key", `ops/${i}/set/${field}`);
    }
    if (ek === undefined) continue;
    if (keyFields === undefined) return bad("no_external_key", `ops/${i}/external_key`);
    if ("ver" in op) return bad("mutually_exclusive", `ops/${i}/ver`);
    if ("row" in op) return bad("mutually_exclusive", `ops/${i}/row`);
    for (const f of keyFields) {
      if (ek[f] === undefined || ek[f] === null)
        return bad("missing", `ops/${i}/external_key/${f}`);
    }
    if (set === undefined) return bad("missing", `ops/${i}/set`);
    if (Object.keys(set).length === 0) return bad("malformed", `ops/${i}/set`);
    const id = `${name}|${JSON.stringify(keyFields.map((f) => ek[f]))}`;
    const first = seen.get(id);
    if (first !== undefined) {
      return bad("duplicate_external_key", `ops/${i}/external_key`, { ops: [first, i] });
    }
    seen.set(id, i);
  }
  for (const [i, op] of ops.entries()) {
    const set = (op["set"] ?? {}) as Record<string, unknown>;
    const field = Object.keys(set).find((f) => invalid !== undefined && set[f] === invalid);
    if (field !== undefined) {
      return {
        status: 422,
        error: {
          code: "validation_failed",
          message: "a value is not valid",
          details: [{ op: i, table: op["table"], field, code: "type_mismatch" }],
        },
      };
    }
  }
  return undefined;
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
    expect(result).toEqual({ ...NONE, records: 3, created: 3 });
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
    expect(await sdk.write(notes, { key: "k" })).toEqual({ ...NONE, records: 150, created: 150 });
    expect(await sdk.write(notes, { key: "k" })).toEqual({ ...NONE, records: 150, replayed: 150 });
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
      written: { ...NONE, records: 160, created: 0, replayed: 100 },
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
      written: { ...NONE, records: 150, created: 100 },
    });
  });
});

describe("writes by source key", () => {
  // Rides from an app: a timeless table keyed by (origin, ride_id).
  const RIDES: TableDefinition = {
    name: "rides",
    description: "One ride taken",
    time: { type: "none" },
    externalKey: ["origin", "ride_id"],
    fields: [
      { name: "origin", type: "text", required: true, description: "The app" },
      { name: "ride_id", type: "text", required: true, description: "The ride's ID there" },
      { name: "fare", type: "integer", description: "What it cost" },
    ],
  };

  class Ride extends SlotRecord {
    readonly #fields: Record<string, unknown>;
    constructor(id: string, fare: number, extra: Record<string, unknown> = {}) {
      super();
      this.#fields = { origin: "app", ride_id: id, fare, ...extra };
    }
    table() {
      return "rides";
    }
    fields() {
      return this.#fields;
    }
  }

  const RIDES_STATE = () => ({
    sv: 2,
    tables: [
      { table: "rides", fields: ["origin", "ride_id", "fare"], externalKey: ["origin", "ride_id"] },
      { table: "notes", fields: ["text"] },
    ],
  });

  it("declares the key in the draft that creates the slot", async () => {
    const { fn, posts } = fakeService(undefined);
    await sdkOn(fn, new MailProvider([RIDES])).init();
    const draft = posts()[0]?.body as { document: { tables: Record<string, unknown>[] } };
    expect(draft.document.tables[0]?.["external_key"]).toEqual(["origin", "ride_id"]);
  });

  it("writes each record by its key, as update, the key fields out of set", async () => {
    const { fn, posts } = fakeService(RIDES_STATE());
    const sdk = sdkOn(fn, new MailProvider([RIDES, NOTES]));
    await sdk.init();
    await sdk.write([new Ride("r-1", 12), new Note("synced")]);
    const [rides, notes] = posts();
    expect(rides?.body).toEqual({
      sv: 2,
      ops: [
        {
          intent: "update",
          table: "mail.rides",
          external_key: { origin: "app", ride_id: "r-1" },
          set: { fare: 12 },
        },
      ],
    });
    // A table without a key is written as before.
    expect(notes?.body).toMatchObject({ ops: [{ intent: "insert", table: "mail.notes" }] });
  });

  it("counts each record by how it ended: created, unchanged, updated, awaiting, skipped", async () => {
    const id = (ride: string) => JSON.stringify({ origin: "app", ride_id: ride });
    const { fn } = fakeService(RIDES_STATE(), {
      byKey: { [id("r-4")]: "pending", [id("r-5")]: "skipped" },
    });
    const sdk = sdkOn(fn, new MailProvider([RIDES, NOTES]));
    await sdk.init();
    const first = await sdk.write([new Ride("r-1", 10), new Ride("r-2", 20), new Ride("r-3", 30)]);
    expect(first).toEqual({ ...NONE, records: 3, created: 3 });
    const again = await sdk.write([
      new Ride("r-1", 10),
      new Ride("r-2", 21),
      new Ride("r-3", 30),
      new Ride("r-4", 40),
      new Ride("r-5", 50),
      new Note("not keyed"),
    ]);
    expect(again).toEqual({
      ...NONE,
      records: 6,
      created: 1,
      updated: 1,
      unchanged: 2,
      awaiting: 1,
      skipped: 1,
      pending: 1,
    });
  });

  it("refuses a record without a key field, or with it null, sending nothing", async () => {
    const { fn, posts } = fakeService(RIDES_STATE());
    const sdk = sdkOn(fn, new MailProvider([RIDES, NOTES]));
    await sdk.init();
    class NoId extends SlotRecord {
      table() {
        return "rides";
      }
      fields() {
        return { origin: "app", fare: 1 };
      }
    }
    await expect(sdk.write([new Ride("r-1", 1), new NoId()])).rejects.toMatchObject({
      code: "invalid_argument",
      details: { table: "rides", record: 1, field: "ride_id" },
    });
    await expect(sdk.write([new Ride("r-1", 1, { origin: null })])).rejects.toMatchObject({
      code: "invalid_argument",
      details: { table: "rides", record: 0, field: "origin" },
    });
    expect(posts()).toHaveLength(0);
  });

  it("refuses two records with the same key in one call, even in different parts, sending nothing", async () => {
    const { fn, posts } = fakeService(RIDES_STATE());
    const sdk = sdkOn(fn, new MailProvider([RIDES, NOTES]));
    await sdk.init();
    const rides = Array.from({ length: 150 }, (_, i) => new Ride(`r-${i}`, i));
    // The same key in another normalization form: the service compares text after NFC.
    rides.push(new Ride("caf\u00e9", 1), new Ride("cafe\u0301", 2));
    const error = await sdk.write(rides).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "invalid_argument",
      details: { table: "rides", records: [150, 151] },
    });
    await expect(sdk.write([new Ride("r-1", 1), new Ride("r-1", 2)])).rejects.toMatchObject({
      details: { records: [0, 1] },
    });
    expect(posts()).toHaveLength(0);
  });

  it("refuses a record with only its key fields, naming it, sending nothing", async () => {
    const { fn, posts } = fakeService(RIDES_STATE());
    const sdk = sdkOn(fn, new MailProvider([RIDES, NOTES]));
    await sdk.init();
    class KeyOnly extends SlotRecord {
      readonly #extra: Record<string, unknown>;
      constructor(extra: Record<string, unknown> = {}) {
        super();
        this.#extra = extra;
      }
      table() {
        return "rides";
      }
      fields() {
        return { origin: "app", ride_id: "r-9", ...this.#extra };
      }
    }
    await expect(
      sdk.write([new Ride("r-1", 1), new Note("n"), new KeyOnly()]),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      status: undefined,
      details: { table: "rides", record: 2 },
    });
    // A field whose value is undefined is not sent: it does not count.
    await expect(sdk.write([new KeyOnly({ fare: undefined })])).rejects.toMatchObject({
      code: "invalid_argument",
      details: { table: "rides", record: 0 },
    });
    expect(posts()).toHaveLength(0);
    // A field set to null is a value to write.
    await expect(sdk.write([new KeyOnly({ fare: null })])).resolves.toMatchObject({ created: 1 });
  });

  it("names the caller's record when the service refuses an op of a later part", async () => {
    const { fn, posts } = fakeService(RIDES_STATE(), { invalid: -1 });
    const sdk = sdkOn(fn, new MailProvider([RIDES, NOTES]));
    await sdk.init();
    // Notes between the rides: a ride's index in the call is not its index in its part.
    const records: SlotRecord[] = [];
    for (let i = 0; i < 150; i++) records.push(new Ride(`r-${i}`, i), new Note(`note ${i}`));
    // Ride 130 is op 30 of the second part of rides, and record 260 of the call.
    records[260] = new Ride("r-130", -1);
    const error = await sdk.write(records).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SaveslotError);
    expect(error).toMatchObject({
      code: "validation_failed",
      status: 422,
      records: [260],
      details: { details: [{ op: 30, field: "fare" }] },
      written: { ...NONE, records: 300, created: 100 },
    });
    expect((error as Error).message).toContain("write 2 of 4; record 260");
    expect(posts()).toHaveLength(2);
  });

  it("an answer to a write by source key without external_key_summary is a bad reply", async () => {
    const { fn } = fakeService(RIDES_STATE());
    const stripped = (async (input: URL | string, init?: RequestInit) => {
      const r = await fn(input, init);
      if (new URL(String(input)).pathname !== "/v1/writes") return r;
      const { external_key_summary: _, ...body } = (await r.json()) as Record<string, unknown>;
      return new Response(JSON.stringify(body), { status: r.status });
    }) as typeof fetch;
    const sdk = sdkOn(stripped, new MailProvider([RIDES, NOTES]));
    await sdk.init();
    await expect(sdk.write([new Ride("r-1", 1)])).rejects.toMatchObject({ code: "bad_reply" });
    // A table without a source key needs none.
    await expect(sdk.write([new Note("n")])).resolves.toMatchObject({ created: 1 });
  });

  it("the fake refuses what the service refuses of a write by source key", async () => {
    const { fn } = fakeService(RIDES_STATE());
    const post = async (op: Record<string, unknown>, extra: Record<string, unknown>[] = []) => {
      const r = await fn("https://saveslot.example.com/v1/writes", {
        method: "POST",
        body: JSON.stringify({ sv: 2, ops: [...extra, op] }),
      });
      return ((await r.json()) as { error?: Record<string, unknown> }).error;
    };
    const keyed = {
      intent: "update",
      table: "mail.rides",
      external_key: { origin: "app", ride_id: "r-1" },
      set: { fare: 1 },
    };
    expect(
      await post({ intent: "insert", table: "mail.rides", set: { origin: "app" } }),
    ).toMatchObject({ reason: "insert_with_external_key" });
    expect(await post({ ...keyed, table: "mail.notes" })).toMatchObject({
      reason: "no_external_key",
    });
    expect(await post({ ...keyed, ver: "v1.0" })).toMatchObject({ reason: "mutually_exclusive" });
    expect(await post({ ...keyed, external_key: { origin: "app" } })).toMatchObject({
      reason: "missing",
      param: "ops/0/external_key/ride_id",
    });
    expect(await post({ ...keyed, set: {} })).toMatchObject({
      reason: "malformed",
      param: "ops/0/set",
    });
    expect(await post(keyed, [keyed])).toMatchObject({
      reason: "duplicate_external_key",
      ops: [0, 1],
    });
  });

  it("refuses at init a slot whose table has another key, or a key when none is declared", async () => {
    const other = RIDES_STATE();
    (other.tables[0] as FakeTable).externalKey = ["ride_id"];
    const a = sdkOn(fakeService(other).fn, new MailProvider([RIDES, NOTES]));
    await expect(a.init()).rejects.toMatchObject({
      code: "schema_mismatch",
      details: {
        tables: [
          { table: "rides", externalKey: { declared: ["origin", "ride_id"], slot: ["ride_id"] } },
        ],
      },
    });
    ConnectorClient.reset();
    const { externalKey: _, ...unkeyed } = RIDES;
    const b = sdkOn(fakeService(RIDES_STATE()).fn, new MailProvider([unkeyed, NOTES]));
    await expect(b.init()).rejects.toMatchObject({
      code: "schema_mismatch",
      details: {
        tables: [{ table: "rides", externalKey: { declared: null, slot: ["origin", "ride_id"] } }],
      },
    });
    // The same fields in another order are the same key.
    ConnectorClient.reset();
    const c = sdkOn(
      fakeService(RIDES_STATE()).fn,
      new MailProvider([{ ...RIDES, externalKey: ["ride_id", "origin"] }, NOTES]),
    );
    await expect(c.init()).resolves.toBeUndefined();
  });
});
