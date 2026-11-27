// `history` located by `entity_key` (04-contract-types §1.5) when the key was held only by content a
// deletion still pending removed (03-data-model/03-deletion «版本表»): it answers as for a key
// never held, the whole error the same, so a guess cannot tell the key was there; a key other
// content still holds is found as ever; after a cancellation, found again. Fictional names.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnchorStore,
  confirmDeletion,
  createOpsContext,
  createTenant,
  history,
  previewDeletion,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { openFileAnchorStore } from "@fluxvita/saveslot-kernel/anchor-file";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cancelDeletion } from "./testing/deletion.fixture.ts";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"3".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

const BUDGETS = {
  name: "budgets",
  kind: "base",
  description: "a budget by category over time",
  time: { type: "state", granularity: "date" },
  fields: [
    { name: "category", type: "text", required: true, description: "the category" },
    { name: "amount", type: "text", required: true, description: "how much" },
  ],
  entity_key: ["category"],
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
const w = (words: string, ops: unknown[]): Promise<Any> =>
  write(s.store, ctx(), {
    sv: 1,
    evidence: [{ kind: "user_message", text: words }],
    idempotency_key: `k-${++n}`,
    ops,
  });
const budget = (category: string, amount: string) => ({
  intent: "update",
  table: "budgets",
  entity_key: { category },
  set: { amount },
  valid_from: "2026-10-01",
});

const sourceOf = (words: string) =>
  s.store.read(async (tx) => {
    const r = await tx.query<{ source_id: string; seq: unknown }>(
      `SELECT so.source_id, so.seq FROM sources so JOIN content c ON c.seq = so.seq
       WHERE c.path = 'text' AND c.body LIKE $1`,
      [`%${words}%`],
    );
    return { id: r.rows[0]?.source_id as string, seq: Number(r.rows[0]?.seq) };
  });
const compiledOf = (name: string) =>
  s.store.read(async (tx) => {
    const r = await tx.query<{ body: string; slot_id: string }>(
      `SELECT c.body, v.slot_id FROM schema_versions v
       JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled' WHERE v.state = 'current'`,
    );
    const tables = JSON.parse(r.rows[0]?.body as string).tables as Any[];
    return { table: tables.find((t) => t.name === name), slot: r.rows[0]?.slot_id as string };
  });

/** The timeline by key, or the whole error it is refused with, as JSON with its message. */
const byKey = async (category: string): Promise<{ ok: Any } | { refused: string }> => {
  try {
    return { ok: await history(s.store, ctx(), { table: "budgets", entity_key: { category } }) };
  } catch (e) {
    const err = e as Error;
    return { refused: JSON.stringify({ ...err, errorName: err.name, errorMessage: err.message }) };
  }
};

beforeAll(async () => {
  s = await openReusable("saveslot-entity-key-pending-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  dir = mkdtempSync(join(tmpdir(), "saveslot-entity-key-pending-anchor-"));
  anchor = openFileAnchorStore(join(dir, "anchor.json"));
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), {
    document: { slot: "home", base_version: null, timezone: "UTC", tables: [BUDGETS] },
  });
}, T);
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("history by entity_key, the key held only by deleted content", () => {
  it(
    "found before; after, refused as a key never held, the whole error alike; found after a cancellation",
    async () => {
      const made = await w("DELETED-WORDS a budget for SECRET-KEY of 500", [
        budget("SECRET-KEY", "500"),
      ]);
      const entity = made.ops[0].target.entity as string;
      await w("a budget for food of 300", [budget("food", "300")]);

      const before = await byKey("SECRET-KEY");
      expect("ok" in before && before.ok.target.entity).toBe(entity);
      const never = await byKey("NEVER-KEY");
      expect("refused" in never).toBe(true);

      const { binding } = await previewDeletion(s.store, {
        sources: [(await sourceOf("DELETED-WORDS")).id],
      });
      const del = (await confirmDeletion(s.store, anchor, ctx(), {
        binding,
        handle: `dc_${++n}`,
      })) as Any;

      // The same refusal as for a key never held: the whole error, not only its code.
      expect(await byKey("SECRET-KEY")).toEqual(await byKey("NEVER-KEY"));
      expect(JSON.stringify(await byKey("SECRET-KEY"))).not.toContain("SECRET-KEY");
      // A key other content holds: as ever.
      const food = await byKey("food");
      expect("ok" in food).toBe(true);

      const compiled = await compiledOf("budgets");
      await cancelDeletion(s.store, {
        slot: compiled.slot,
        table: compiled.table,
        row: entity,
        sources: [(await sourceOf("DELETED-WORDS")).seq],
        id: del.deletion.id,
        actor: USER,
        now: ctx().now,
      });
      const back = await byKey("SECRET-KEY");
      expect("ok" in back && back.ok.target.entity).toBe(entity);
    },
    T,
  );
});
