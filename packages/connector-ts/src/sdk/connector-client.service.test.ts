// The SDK against the real local service, over its socket (05-surfaces §13–§14): `init` creates
// the slot, `write` inserts, a task in any Unicode goes out as UTF-8, a write sent again under its
// key is applied once and counted as replayed, other records under a used key are `key_reused`, a
// key too long for one of its parts or a record JSON cannot carry sends nothing, and a slot lacking
// a declared table is left as it is.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type RunningService, runService, socketFile } from "../../../daemon/src/service.ts";
import { initLocalHome, sessionFile } from "../../../service/src/index.ts";
import { osFileLock } from "../../../store-pglite/src/index.ts";
import { testBackend } from "../../../store-pglite/src/testing/test-backend.fixture.ts";
import {
  ConnectorClient,
  type ConnectorManifest,
  ConnectorPlatform,
  type ConnectorProvider,
  SaveslotError,
  type SchemaBuilder,
  SlotRecord,
  type TableDefinition,
} from "../index.ts";
import { socketFetch } from "../testing/socket-fetch.fixture.ts";

const T = 60_000;
const root = mkdtempSync(join(tmpdir(), "saveslot-connector-"));
const home = join(root, "home");
let service: RunningService;
let credential = "";
/** Requests the SDK made, as `METHOD /path`. */
const calls: string[] = [];

const viaSocket = () => socketFetch(socketFile(home));
const counted: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
  return viaSocket()(input, init);
};

beforeAll(async () => {
  await initLocalHome({
    home,
    backend: testBackend(),
    lock: osFileLock,
    now: new Date().toISOString(),
  });
  service = await runService({ home, version: "t", signals: false, log: () => {} });
  expect(service.state).toBe("ready");
  // The credential a connector gets from `saveslot connect http`: default scopes, every slot.
  const session = readFileSync(sessionFile(home), "utf8").trim();
  const issued = await viaSocket()("http://saveslot.local/v1/connections", {
    method: "POST",
    headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "mail connector" }),
  });
  expect(issued.status).toBe(200);
  credential = ((await issued.json()) as { token: string }).token;
}, T);
afterAll(async () => {
  await service?.stop();
  rmSync(root, { recursive: true, force: true });
}, T);
beforeEach(() => {
  ConnectorClient.reset();
  calls.length = 0;
});

const MANIFEST: ConnectorManifest = {
  id: "com.example.邮件",
  name: "Mail",
  description: "Messages from a mailbox.",
  logo: "https://example.com/mail.png",
  version: "1.0.0",
  publisher: "Example",
  platforms: [ConnectorPlatform.Cloud],
};

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

class Provider implements ConnectorProvider {
  readonly slot: string;
  readonly tables: TableDefinition[];
  constructor(slot: string, tables: TableDefinition[] = [MESSAGES]) {
    this.slot = slot;
    this.tables = tables;
  }
  defineSchema(schema: SchemaBuilder): SchemaBuilder {
    schema.addSlot(this.slot, "Asia/Shanghai");
    for (const t of this.tables) schema.addTable(t);
    return schema;
  }
}

class MailMessage extends SlotRecord {
  readonly n: number;
  constructor(n: number) {
    super();
    this.n = n;
  }
  table() {
    return "messages";
  }
  fields() {
    return {
      message_id: `<${this.n}@example.com>`,
      received_at: "2026-11-18T09:00:00+08:00[Asia/Shanghai]",
      subject: `Message ${this.n}`,
    };
  }
}

const messages = (count: number) => Array.from({ length: count }, (_, i) => new MailMessage(i));

function build(provider: ConnectorProvider): ConnectorClient {
  return ConnectorClient.builder()
    .setManifest(MANIFEST)
    .setCredential(credential)
    .setBaseUrl("http://saveslot.local")
    .setFetch(counted)
    .setRetries(0)
    .setProvider(provider)
    .build();
}

const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof SaveslotError) return e;
    throw e;
  }
  throw new Error("expected a rejection");
};

describe("ConnectorClient against the local service", () => {
  it(
    "init creates the slot, then writes insert; a second init only reads",
    async () => {
      const sdk = build(new Provider("mail"));
      await sdk.init();
      expect(calls).toContain("POST /v1/drafts");
      const r = await sdk.write(messages(3));
      expect(r).toEqual({ records: 3, created: 3, replayed: 0, pending: 0 });

      ConnectorClient.reset();
      calls.length = 0;
      await build(new Provider("mail")).init();
      expect(calls).not.toContain("POST /v1/drafts");
    },
    T,
  );

  it(
    "a task in any Unicode goes out as UTF-8, as does the manifest in User-Agent",
    async () => {
      const sdk = build(new Provider("mail_task"));
      await sdk.init();
      const r = await sdk.write(messages(2), { task: "整理账单" });
      expect([r.created, r.replayed]).toEqual([2, 0]);
    },
    T,
  );

  it(
    "the same records under the same key are applied once, and come back as replayed",
    async () => {
      const sdk = build(new Provider("mail_replay"));
      await sdk.init();
      const first = await sdk.write(messages(250), { key: "sync-2026-11-19" });
      expect(first).toEqual({ records: 250, created: 250, replayed: 0, pending: 0 });
      const again = await sdk.write(messages(250), { key: "sync-2026-11-19" });
      expect(again).toEqual({ records: 250, created: 0, replayed: 250, pending: 0 });
    },
    T,
  );

  it(
    "other records under a key already used: key_reused, with what had been applied",
    async () => {
      const sdk = build(new Provider("mail_key_reuse"));
      await sdk.init();
      await sdk.write(messages(150), { key: "P" });
      const e = await rejection(sdk.write(messages(160), { key: "P" }));
      expect(e.code).toBe("key_reused");
      expect(e.written).toEqual({ records: 160, created: 0, replayed: 100, pending: 0 });
    },
    T,
  );

  it(
    "a record with a BigInt is refused before anything is sent, not retried",
    async () => {
      const sdk = build(new Provider("mail_bigint"));
      await sdk.init();
      calls.length = 0;
      class Big extends SlotRecord {
        table() {
          return "messages";
        }
        fields() {
          return { ...new MailMessage(1).fields(), subject: 10n };
        }
      }
      const e = await rejection(sdk.write([new Big()]));
      expect([e.code, e.status]).toEqual(["invalid_argument", undefined]);
      expect(calls).toEqual([]);
    },
    T,
  );

  it(
    "a key fitting the first parts but not the eleventh is refused before anything is sent",
    async () => {
      const sdk = build(new Provider("mail_long_key"));
      await sdk.init();
      calls.length = 0;
      const e = await rejection(sdk.write(messages(1100), { key: "k".repeat(245) }));
      expect(e.code).toBe("invalid_argument");
      expect(calls).toEqual([]);
    },
    T,
  );

  it(
    "a slot lacking a declared table: schema_mismatch, and the slot is left as it is",
    async () => {
      await build(new Provider("mail_grow")).init();
      ConnectorClient.reset();
      calls.length = 0;
      const NOTES: TableDefinition = {
        name: "notes",
        description: "A note",
        time: { type: "none" },
        fields: [{ name: "text", type: "text", description: "The note" }],
      };
      const e = await rejection(build(new Provider("mail_grow", [MESSAGES, NOTES])).init());
      expect(e.code).toBe("schema_mismatch");
      expect(e.details).toEqual({ tables: [{ table: "notes", missing: true }] });
      expect(e.message).not.toContain("updateTable");
      expect(calls.filter((c) => c.startsWith("POST"))).toEqual([]);
    },
    T,
  );

  it(
    "a credential the service does not know: unauthenticated, at init",
    async () => {
      const e = await rejection(
        ConnectorClient.builder()
          .setManifest(MANIFEST)
          .setCredential(`slt_${"A".repeat(43)}`)
          .setBaseUrl("http://saveslot.local")
          .setFetch(counted)
          .setProvider(new Provider("mail"))
          .build()
          .init(),
      );
      expect([e.code, e.status]).toEqual(["unauthenticated", 401]);
    },
    T,
  );
});
