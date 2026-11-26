// The SDK against the real local service, over its socket (05-surfaces §13–§14): `init` creates
// the slot, `write` inserts, a task in any Unicode goes out as UTF-8, a write sent again under its
// key is applied once and counted as replayed, other records under a used key are `key_reused`, a
// key too long for one of its parts or a record JSON cannot carry sends nothing, a slot lacking
// a declared table is left as it is, and a table with a source key is written by it: created,
// then unchanged when synced again as it was, updated when the source changed, awaiting when the
// user changed the field in saveslot since, skipped when the user revoked the row; a refusal of a
// later part names the caller's record.

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
let session = "";
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
  session = readFileSync(sessionFile(home), "utf8").trim();
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
  readonly id: string;
  readonly fare: number;
  constructor(id: string, fare: number) {
    super();
    this.id = id;
    this.fare = fare;
  }
  table() {
    return "rides";
  }
  fields() {
    return { origin: "app", ride_id: this.id, fare: this.fare };
  }
}

/** The receipts of the writes the SDK sent, in order. */
const receipts: Record<string, unknown>[] = [];
const recording: typeof fetch = async (input, init) => {
  const r = await counted(input, init);
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname === "/v1/writes" && r.status === 200) {
    receipts.push((await r.clone().json()) as Record<string, unknown>);
  }
  return r;
};

/** A write the user makes in saveslot, with their session. */
async function asUser(sv: number, ops: unknown[]): Promise<Record<string, unknown>> {
  const r = await viaSocket()("http://saveslot.local/v1/writes", {
    method: "POST",
    headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
    body: JSON.stringify({ sv, ops }),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as Record<string, unknown>;
}

const messages = (count: number) => Array.from({ length: count }, (_, i) => new MailMessage(i));

function build(provider: ConnectorProvider, fetchFn: typeof fetch = counted): ConnectorClient {
  return ConnectorClient.builder()
    .setManifest(MANIFEST)
    .setCredential(credential)
    .setBaseUrl("http://saveslot.local")
    .setFetch(fetchFn)
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
      expect(r).toEqual({ ...NONE, records: 3, created: 3 });

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
      expect(first).toEqual({ ...NONE, records: 250, created: 250 });
      const again = await sdk.write(messages(250), { key: "sync-2026-11-19" });
      expect(again).toEqual({ ...NONE, records: 250, created: 0, replayed: 250 });
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
      expect(e.written).toEqual({ ...NONE, records: 160, created: 0, replayed: 100 });
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
    "a table with a source key: created, unchanged when synced again, updated when changed",
    async () => {
      const sdk = build(new Provider("rides", [RIDES]));
      await sdk.init();
      const rides = (fares: number[]) => fares.map((fare, i) => new Ride(`r-${i}`, fare));
      expect(await sdk.write(rides([10, 20, 30]))).toEqual({ ...NONE, records: 3, created: 3 });
      expect(await sdk.write(rides([10, 20, 30]))).toEqual({ ...NONE, records: 3, unchanged: 3 });
      expect(await sdk.write(rides([10, 25, 30, 40]))).toEqual({
        ...NONE,
        records: 4,
        created: 1,
        updated: 1,
        unchanged: 2,
      });

      // The slot has the key: a second connector declaring the same is at home there.
      ConnectorClient.reset();
      await build(new Provider("rides", [RIDES])).init();
    },
    T,
  );

  it(
    "by source key: awaiting when the user changed the field since, skipped when the user revoked the row",
    async () => {
      receipts.length = 0;
      const sdk = build(new Provider("rides_user", [RIDES]), recording);
      await sdk.init();
      expect(await sdk.write([new Ride("r-0", 10), new Ride("r-1", 20)])).toEqual({
        ...NONE,
        records: 2,
        created: 2,
      });
      const created = receipts[0] as {
        sv: number;
        ops: { target: { row: string }; ver: string }[];
      };
      const [first, second] = created.ops;
      // The user changes r-0's fare in saveslot, and revokes r-1.
      await asUser(created.sv, [
        {
          intent: "update",
          table: "rides_user.rides",
          row: first?.target.row,
          ver: first?.ver,
          set: { fare: 15 },
        },
        { intent: "revoke", table: "rides_user.rides", row: second?.target.row, ver: second?.ver },
      ]);
      // The source changes both: r-0's change waits for the user, r-1 is not written back.
      expect(await sdk.write([new Ride("r-0", 11), new Ride("r-1", 21)])).toEqual({
        ...NONE,
        records: 2,
        awaiting: 1,
        skipped: 1,
        pending: 1,
      });
    },
    T,
  );

  it(
    "a refusal of a later part names the caller's record, with what had been applied",
    async () => {
      const sdk = build(new Provider("rides_refused", [RIDES]));
      await sdk.init();
      const rides = Array.from({ length: 150 }, (_, i) => new Ride(`r-${i}`, i));
      // A fare that is not an integer: the service refuses op 20 of the second part.
      class BadFare extends SlotRecord {
        table() {
          return "rides";
        }
        fields() {
          return { origin: "app", ride_id: "r-bad", fare: "not a number" };
        }
      }
      const records: SlotRecord[] = [...rides.slice(0, 120), new BadFare(), ...rides.slice(120)];
      const e = await rejection(sdk.write(records));
      expect([e.code, e.status]).toEqual(["validation_failed", 422]);
      expect(e.records).toEqual([120]);
      expect(e.written).toEqual({ ...NONE, records: 151, created: 100 });
      expect(e.message).toContain("record 120");
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
