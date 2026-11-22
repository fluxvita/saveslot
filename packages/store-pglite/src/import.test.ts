// Import into an empty tenant, the steps into the staging storage, on storage (02-architecture §8
// «格式版本、导出、导入与恢复» steps ① and ②; 09-event-format §3.3, §8): a file written from a
// stored log is checked and replayed into an empty storage, which then holds the same log byte for
// byte and the same materialized state; a file apply cannot replay is refused as `replay_failed`;
// each block lands in its state. Runs on each backend. Fictional IDs and data.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendExported,
  appendOperation,
  applyEvents,
  buildOperation,
  createOpsContext,
  createTenant,
  ExportFileReader,
  eventsOf,
  ImportLineTooLarge,
  ImportRejected,
  importIntoStaging,
  MAX_IMPORT_LINE_BYTES,
  type NewEvent,
  OpsError,
  readTail,
  type TenantStore,
  verifyLog,
} from "@fluxvita/saveslot-kernel";
import { COMPILED_V1, createSlotEvents, SLOT } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bodyOf,
  exportFileOf,
  exportLinesOf,
  replicated,
  segmentOf,
} from "./testing/export-file.fixture.ts";
import { type Reusable, reusable } from "./testing/reusable-store.fixture.ts";
import { testBackend } from "./testing/test-backend.fixture.ts";

const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const row = (k: number) => `r_${String(k).repeat(26)}`;
const T = 120_000;

const COMPILED = {
  ...COMPILED_V1,
  tables: [
    {
      id: "t1",
      name: "rows",
      kind: "base",
      description: "rows",
      time: { type: "none" },
      physical: { table: "t_t1_v1" },
      fields: [
        { id: "f2", name: "b", type: "text", required: true, description: "b" },
        { id: "f3", name: "c", type: "text", description: "c" },
      ],
    },
  ],
};
const CHANGES = [
  { target: { slot: true }, change: "create_slot" },
  { target: { table: "t1" }, change: "add_table" },
].map((c) => ({
  ...c,
  class: "create",
  compatible_with_old_writes: true,
  destructive: false,
  auto: true,
}));
const CTX = {
  now: "2026-11-10T05:00:00.000Z",
  today: "2026-11-10",
  ruleset_version: 1,
  policy_version: 1,
  literal_checker: "literal@1",
};

/** An insert of a row of t1 with f2 = `value`. */
const insert = (id: string, value: string): NewEvent[] =>
  [
    {
      type: "write.head",
      slot: SLOT,
      blocks: {
        ctx: CTX,
        request: { sv: 1, sv_basis: "explicit", op_count: 1 },
        "ops/0/target": { table: "t1", row: id, intent: "insert", created: true },
        "ops/0/set/f2": value,
      },
    },
    {
      type: "write.base",
      slot: SLOT,
      blocks: {
        target: {
          table: "t1",
          row: id,
          intent: "insert",
          sv: 1,
          created: true,
          cause: "request",
          op_index: 0,
        },
        "fields/f2/0": { status: "applied", value },
        "sources/f2/0": [{ kind: "value", source: 7 }],
      },
    },
  ] as NewEvent[];

const run = (s: TenantStore, events: NewEvent[]) =>
  s.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-10T05:00:00.000Z" as never,
      events,
    });
    await applyEvents(tx, eventsOf(op));
  });

const roots: string[] = [];
const stores: TenantStore[] = [];
let source: TenantStore;
let staging: Reusable<TenantStore>;

async function open(name: string): Promise<TenantStore> {
  const root = mkdtempSync(join(tmpdir(), `saveslot-import-${name}-`));
  roots.push(root);
  const s = await testBackend().open(
    { kind: "pglite", dir: join(root, "tenant") },
    { create: true },
  );
  stores.push(s);
  return s;
}

beforeAll(async () => {
  source = await open("source");
  await createTenant(
    source,
    createOpsContext({
      tenant: TENANT,
      actor: USER,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_key_window: 86_400_000,
      idempotency_window: 86_400_000,
      now: "2026-11-10T04:00:00.000Z",
      confirmation: null,
    }),
  );
  await run(source, createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }));
  // Text of several UTF-8 bytes a character, so that a cut body splits characters.
  for (const [k, v] of [
    [1, "一"],
    [2, "二 two"],
    [3, "三"],
  ] as const) {
    await run(source, insert(row(k), v));
  }
  staging = await reusable(await open("staging"));
}, T);

afterAll(async () => {
  for (const s of stores) await s.close().catch(() => {});
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}, T);

const importFile = async (file: readonly string[], o: { size?: number; batch?: number } = {}) => {
  await staging.reset();
  return importIntoStaging({
    staging: staging.store,
    body: bodyOf(file, o.size),
    ...(o.batch !== undefined ? { batch: o.batch } : {}),
  });
};

/** The rejection an import gives, as `{reason, seq, path}`. */
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => {
      if (!(e instanceof ImportRejected)) throw e;
      return { reason: e.reason, seq: e.seq, path: e.path };
    },
  );

describe("a file replayed into an empty storage", () => {
  it(
    "gives the same log, byte for byte, and the same materialized state; verify agrees",
    async () => {
      const file = await exportFileOf(source, TENANT);
      const tail = await source.read(readTail);
      // A body cut every 7 bytes, and batches of 2 events: characters and operations split.
      const staged = await importFile(file, { size: 7, batch: 2 });
      expect(staged).toEqual({
        manifest: JSON.parse(file[0] as string),
        importedUpto: tail?.seq,
        events: tail?.seq,
        segments: 1,
      });
      expect(await staging.store.read(replicated)).toEqual(await source.read(replicated));
      expect(await staging.store.read((tx) => verifyLog(tx))).toEqual(
        await source.read((tx) => verifyLog(tx)),
      );
    },
    T,
  );

  it(
    "in segments cut by `after`, one after the other in the same body",
    async () => {
      const file = await exportFileOf(source, TENANT, [1, 4]);
      const staged = await importFile(file);
      expect(staged.segments).toBe(3);
      expect(await staging.store.read(replicated)).toEqual(await source.read(replicated));
    },
    T,
  );

  it(
    "a last line without its newline is read; an empty line or bytes not UTF-8 are refused",
    async () => {
      const file = await exportFileOf(source, TENANT);
      await staging.reset();
      const text = file.join("\n");
      async function* once(x: string | Uint8Array) {
        yield typeof x === "string" ? new TextEncoder().encode(x) : x;
      }
      await importIntoStaging({ staging: staging.store, body: once(text) });
      expect(await staging.store.read(replicated)).toEqual(await source.read(replicated));
      await staging.reset();
      expect(
        await rejection(importIntoStaging({ staging: staging.store, body: once(`${text}\n\n`) })),
      ).toEqual({ reason: "unsupported_format", seq: undefined, path: undefined });
      // A byte not UTF-8 inside the manifest's tenant ID: a file right but for it. Decoded loosely,
      // it would be a replacement character in a string no check looks into.
      await staging.reset();
      const bytes = new TextEncoder().encode(`${text}\n`);
      const at = new TextEncoder().encode(text.slice(0, text.indexOf(TENANT) + 3)).length;
      expect(bytes[at]).toBe(0x38);
      bytes[at] = 0xff;
      expect(
        await rejection(importIntoStaging({ staging: staging.store, body: once(bytes) })),
      ).toEqual({ reason: "unsupported_format", seq: undefined, path: undefined });
    },
    T,
  );

  it(
    "a line starting with a BOM is refused (it is not its own JCS text); a chunk not bytes is internal",
    async () => {
      const file = await exportFileOf(source, TENANT);
      await staging.reset();
      const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
      async function* withBom() {
        yield bom;
        yield* bodyOf(file);
      }
      expect(
        await rejection(importIntoStaging({ staging: staging.store, body: withBom() })),
      ).toEqual({ reason: "unsupported_format", seq: undefined, path: undefined });
      await staging.reset();
      async function* text() {
        yield file.join("\n") as unknown as Uint8Array;
      }
      const e = await importIntoStaging({ staging: staging.store, body: text() }).catch(
        (x: unknown) => x,
      );
      expect(e instanceof OpsError && e.code).toBe("internal");
    },
    T,
  );

  it(
    "only into an empty storage",
    async () => {
      const file = await exportFileOf(source, TENANT);
      await expect(importIntoStaging({ staging: source, body: bodyOf(file) })).rejects.toThrow(
        OpsError,
      );
    },
    T,
  );
});

describe("a file apply cannot replay", () => {
  it(
    "is refused as replay_failed at the event apply stopped at, its batch not written",
    async () => {
      // Apply has no deletion events in this version: a deletion confirmed after the log's end.
      const lines = await source.read((tx) => exportLinesOf(tx));
      const tail = await source.read(readTail);
      if (tail === undefined) throw new Error("no log");
      const op = buildOperation(tail, {
        actor: USER as never,
        now: "2026-11-10T06:00:00.000Z" as never,
        events: [
          {
            type: "deletion.confirmed",
            slot: SLOT,
            blocks: {
              ctx: CTX,
              target: { deletion: `pi_${"5".repeat(26)}`, sources: [7], due_at: CTX.now },
              positions: [{ seq: 7, path: "ops/0/set/f2" }],
            },
          },
        ],
      });
      const deletion = op.events[0];
      if (deletion === undefined) throw new Error("no event");
      const line = {
        h: JSON.parse(deletion.header),
        c: Object.fromEntries(
          deletion.blocks.map((b) => [b.path, { v: JSON.parse(b.body), sum: b.checksum }]),
        ),
      };
      // The file is right: only apply stops at it.
      const file = segmentOf([...lines, line], { tenant: TENANT });
      const reader = new ExportFileReader();
      for (const l of file) reader.line(l);
      expect(reader.end().upto).toBe(deletion.seq);
      await staging.reset();
      expect(
        await rejection(
          importIntoStaging({ staging: staging.store, body: bodyOf(file), batch: 4 }),
        ),
      ).toEqual({ reason: "replay_failed", seq: deletion.seq, path: undefined });
      // The batches before were written; the one with the deletion was not.
      expect((await staging.store.read(readTail))?.seq ?? 0).toBe(
        Math.floor((deletion.seq - 1) / 4) * 4,
      );
      // Apply's own message stays inside: it may quote the event.
      await staging.reset();
      const e = await importIntoStaging({ staging: staging.store, body: bodyOf(file) }).catch(
        (x: unknown) => x,
      );
      expect((e as Error).message).toBe("apply stopped at this event");
    },
    T,
  );
});

describe("a line too long (09 §8)", () => {
  it(
    "64 MB with no newline: refused once it passes the limit (too_large), the rest never read",
    async () => {
      await staging.reset();
      const chunk = new Uint8Array(16 * 1024).fill(0x61);
      let given = 0;
      async function* endless() {
        for (let i = 0; i < 4096; i++) {
          given += chunk.length;
          yield chunk;
        }
      }
      const started = performance.now();
      const e = await importIntoStaging({ staging: staging.store, body: endless() }).catch(
        (x: unknown) => x,
      );
      const ms = performance.now() - started;
      expect(e instanceof ImportLineTooLarge && { code: e.code, reason: e.reason }).toEqual({
        code: "too_large",
        reason: "import_line",
      });
      // Stopped at the limit: one chunk past it, not the 64 MB given.
      expect(given).toBe(MAX_IMPORT_LINE_BYTES + chunk.length);
      // Linear: a quadratic search took seconds at this size; loose, for a loaded machine.
      expect(ms).toBeLessThan(15_000);
    },
    T,
  );

  it(
    "one byte over the limit and its newline in the same chunk: too_large, not read as a line",
    async () => {
      await staging.reset();
      const chunk = new Uint8Array(MAX_IMPORT_LINE_BYTES + 2).fill(0x61);
      chunk[chunk.length - 1] = 0x0a;
      async function* once() {
        yield chunk;
      }
      const e = await importIntoStaging({ staging: staging.store, body: once() }).catch(
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(ImportLineTooLarge);
    },
    T,
  );
});

describe("a storage that fails while taking an event", () => {
  it(
    "gives an internal error that carries nothing of the storage's message",
    async () => {
      const file = await exportFileOf(source, TENANT);
      await staging.reset();
      // The storage's message may quote the file (a value in a statement): it must stay inside.
      const s = staging.store;
      const failing: TenantStore = {
        read: (fn) => s.read(fn),
        write: () => Promise.reject(new Error(`invalid input: "${TENANT}"`)),
        purgeResidue: () => s.purgeResidue(),
        snapshot: () => s.snapshot(),
        formatVersion: s.formatVersion,
        close: () => s.close(),
      };
      const e = await importIntoStaging({ staging: failing, body: bodyOf(file) }).catch(
        (x: unknown) => x,
      );
      expect(e instanceof OpsError && { code: e.code, message: e.message }).toEqual({
        code: "internal",
        message: "the staging storage could not take an event",
      });
    },
    T,
  );
});

describe("each block lands in its state (09 §3.3)", () => {
  it(
    "present with content and checksum, removed with its tombstone, a placeholder with its deletion",
    async () => {
      await staging.reset();
      await staging.store.write((tx) =>
        appendExported(tx, {
          seq: 1,
          header: { type: "tenant.genesis", actor: USER, at: "2026-11-10T04:00:00.000Z", seq: 1 },
          text: "{}",
          hash: "h",
          blocks: [
            { path: "a", state: "present", value: { x: "一" }, sum: "s" },
            { path: "b", state: "removed", by: 9 },
            { path: "c", state: "placeholder", of: 8 },
          ],
        }),
      );
      const rows = await staging.store.read((tx) =>
        tx.query(
          'SELECT path, body, checksum, removed_by, placeholder_of FROM content ORDER BY path COLLATE "C"',
        ),
      );
      expect(
        rows.rows.map((r) =>
          Object.fromEntries(
            Object.entries(r as object).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]),
          ),
        ),
      ).toEqual([
        { path: "a", body: '{"x":"一"}', checksum: "s", removed_by: null, placeholder_of: null },
        { path: "b", body: null, checksum: null, removed_by: 9, placeholder_of: null },
        { path: "c", body: null, checksum: null, removed_by: null, placeholder_of: 8 },
      ]);
      const ev = await staging.store.read((tx) =>
        tx.query("SELECT seq, header, header_hash, type, actor, op, slot FROM events"),
      );
      expect(
        ev.rows.map((r) => ({
          ...(r as object),
          seq: Number((r as { seq: unknown }).seq),
          op: Number((r as { op: unknown }).op),
        })),
      ).toEqual([
        {
          seq: 1,
          header: "{}",
          header_hash: "h",
          type: "tenant.genesis",
          actor: USER,
          op: 1,
          slot: null,
        },
      ]);
    },
    T,
  );
});
