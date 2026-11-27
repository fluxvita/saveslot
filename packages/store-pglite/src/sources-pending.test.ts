// `sources` while a source is pending deletion (04-contract-types `SourcesListResult`,
// `SourcesGetResult`, `SourceDeletion`): it is listed and got by what is not its content, with
// `deletion: { state: "pending", item, expires_at }`, and without its text, file, statement time
// or what it produced; a search never finds it; the other sources of the slot read as ever. After
// a cancellation it is back as it was. Fictional names.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnchorStore,
  confirmDeletion,
  createOpsContext,
  createTenant,
  previewDeletion,
  schemaDraft,
  sources,
  write,
} from "@fluxvita/saveslot-kernel";
import { openFileAnchorStore } from "@fluxvita/saveslot-kernel/anchor-file";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cancelDeletion } from "./testing/deletion.fixture.ts";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"3".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

const LUNCH = {
  name: "lunches",
  kind: "base",
  description: "one row per lunch",
  time: { type: "none" },
  fields: [{ name: "amount", type: "text", required: true, description: "what it cost" }],
};

let s: ReusableStore;
let dir: string;
let anchor: AnchorStore;
let minute = 0;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: "w",
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-10T08:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type Any = any;
let n = 0;
const read = (params: Record<string, unknown>): Promise<Any> => sources(s.store, ctx(), params);
const text = (x: unknown) => JSON.stringify(x);

const sourceOf = (words: string) =>
  s.store.read(async (tx) => {
    const r = await tx.query<{ source_id: string; seq: unknown }>(
      `SELECT so.source_id, so.seq FROM sources so JOIN content c ON c.seq = so.seq
       WHERE c.path = 'text' AND c.body LIKE $1`,
      [`%${words}%`],
    );
    return { id: r.rows[0]?.source_id as string, seq: Number(r.rows[0]?.seq) };
  });

beforeAll(async () => {
  s = await openReusable("saveslot-sources-pending-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  dir = mkdtempSync(join(tmpdir(), "saveslot-sources-pending-anchor-"));
  anchor = openFileAnchorStore(join(dir, "anchor.json"));
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), {
    document: { slot: "home", base_version: null, timezone: "UTC", tables: [LUNCH] },
  });
}, T);
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Two lunches, each with its own words: one kept, one whose words are then deleted. */
async function twoLunches() {
  const kept = await write(s.store, ctx(), {
    sv: 1,
    idempotency_key: `k-${++n}`,
    evidence: [{ kind: "user_message", text: "kept words, lunch was 30, lunchtalk" }],
    ops: [{ intent: "insert", table: "lunches", set: { amount: "30" } }],
  } as never);
  const gone = (await write(s.store, ctx(), {
    sv: 1,
    idempotency_key: `k-${++n}`,
    evidence: [
      {
        kind: "user_message",
        text: "DELETED-WORDS lunch was SECRET-45, lunchtalk",
        stated_at: "2026-09-09T09:09:09.000Z",
      },
    ],
    ops: [{ intent: "insert", table: "lunches", set: { amount: "SECRET-45" } }],
  } as never)) as Any;
  const keptSource = await sourceOf("kept words");
  const goneSource = await sourceOf("DELETED-WORDS");
  const { binding } = await previewDeletion(s.store, { sources: [goneSource.id] });
  const del = (await confirmDeletion(s.store, anchor, ctx(), {
    binding,
    handle: `dc_${++n}`,
  })) as Any;
  return { kept, gone, keptSource, goneSource, del };
}

describe("sources with one pending deletion", () => {
  it(
    "list: it is there, with the deletion and nothing of its content; the others as ever",
    async () => {
      const { keptSource, goneSource, del } = await twoLunches();
      const r = await read({ mode: "list" });
      expect(text(r)).not.toContain("SECRET-45");
      expect(text(r)).not.toContain("2026-09-09");
      const ids = r.sources.map((x: Any) => x.id);
      expect(ids).toContain(goneSource.id);
      expect(ids).toContain(keptSource.id);
      const gone = r.sources.find((x: Any) => x.id === goneSource.id);
      expect(gone.deletion).toEqual({
        state: "pending",
        item: del.deletion.id,
        expires_at: del.deletion.expires_at,
      });
      expect(gone).not.toHaveProperty("excerpt");
      expect(gone).not.toHaveProperty("stated_at");
      expect(gone).not.toHaveProperty("file");
      expect(gone).toMatchObject({ kind: "user_message", slot: "home" });
      const kept = r.sources.find((x: Any) => x.id === keptSource.id);
      expect(kept).not.toHaveProperty("deletion");
      expect(kept.excerpt).toContain("kept words");
    },
    T,
  );

  it(
    "search: never finds it, by its words or by words it shares with others",
    async () => {
      const { keptSource } = await twoLunches();
      expect((await read({ mode: "search", q: "deleted-words" })).sources).toEqual([]);
      const shared = await read({ mode: "search", q: "lunchtalk" });
      expect(shared.sources.map((x: Any) => x.id)).toEqual([keptSource.id]);
      expect(text(shared)).not.toContain("SECRET-45");
    },
    T,
  );

  it(
    "get: the deletion, no text, statement time, file or what it produced; another source as ever",
    async () => {
      const { keptSource, goneSource, del } = await twoLunches();
      const g = await read({ mode: "get", id: goneSource.id });
      expect(text(g)).not.toContain("SECRET-45");
      expect(g.deletion).toEqual({
        state: "pending",
        item: del.deletion.id,
        expires_at: del.deletion.expires_at,
      });
      for (const k of ["text", "stated_at", "file", "produced"]) expect(g).not.toHaveProperty(k);
      expect(g).toMatchObject({ id: goneSource.id, kind: "user_message", slot: "home" });
      const k = await read({ mode: "get", id: keptSource.id });
      expect(k.text).toContain("kept words");
      expect(k.produced?.length).toBeGreaterThan(0);
      expect(k).not.toHaveProperty("deletion");
    },
    T,
  );

  it(
    "cancelled: listed, found and got as before, with no deletion",
    async () => {
      const { gone, goneSource, del } = await twoLunches();
      const row = gone.ops[0].target.row as string;
      const compiled = await s.store.read(async (tx) => {
        const r = await tx.query<{ body: string; slot_id: string }>(
          `SELECT c.body, v.slot_id FROM schema_versions v
           JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled' WHERE v.state = 'current'`,
        );
        const tables = JSON.parse(r.rows[0]?.body as string).tables as Any[];
        return {
          table: tables.find((t) => t.name === "lunches"),
          slot: r.rows[0]?.slot_id as string,
        };
      });
      await cancelDeletion(s.store, {
        slot: compiled.slot,
        table: compiled.table,
        row,
        sources: [goneSource.seq],
        id: del.deletion.id,
        actor: USER,
        now: ctx().now,
      });
      const g = await read({ mode: "get", id: goneSource.id });
      expect(g).not.toHaveProperty("deletion");
      expect(g.text).toContain("DELETED-WORDS");
      expect(g.stated_at).toBe("2026-09-09T09:09:09.000Z");
      expect((await read({ mode: "search", q: "deleted-words" })).sources).toHaveLength(1);
    },
    T,
  );
});
