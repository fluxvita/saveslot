// An import and the item versions given out before it (03-data-model/03-deletion.md «恢复次数»:
// the current restore count is the latest restore or import event's; 04-contract §15
// `restored`; 09-event-format §5.2 `tenant.imported`). A user who imports their own export stays
// active; a receipt of theirs from before the import no longer binds an item, one from after it
// does. The setup is resolve.test.ts's, cut down to one table. Fictional IDs and data.

import {
  appendImportEvent,
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  readBufferOf,
  readEvents,
} from "@fluxvita/saveslot-kernel";
import {
  COMPILED_V1,
  createSlotEvents,
  resolveInTx,
  writeInTx,
} from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 60_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
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

let s: ReusableStore;
let minute = 0;
let ids = 0;
const now = () => {
  minute++;
  return `2026-11-05T0${Math.floor(minute / 60) % 10}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
};
const newId = (kind: "row" | "entity" | "source" | "item" | "partition") => {
  ids++;
  const n = String(ids).padStart(kind === "row" || kind === "entity" ? 26 : 16, "0");
  return `${{ row: "r_", entity: "e_", source: "s_", item: "pi_", partition: "p_" }[kind]}${n}`;
};
const pipeline = { windows: { requestKey: 600_000, idempotencyKey: 86_400_000 } };

/** Writes `params` as the user. */
const send = (params: unknown) =>
  s.store.write((tx) =>
    writeInTx(tx, {
      actor: USER as never,
      task: null,
      now: now(),
      ...pipeline,
      visibility: { kind: "all" },
      params,
      newId,
      reads: readBufferOf(s.store),
    }),
  );

/** Resolves as the user; the refusal's code and detail, if refused. */
async function resolve(params: unknown): Promise<Record<string, unknown>> {
  try {
    return (await s.store.write((tx) =>
      resolveInTx(tx, {
        actor: USER as never,
        task: null,
        now: now(),
        ...pipeline,
        visibility: { kind: "all" },
        params,
        newId,
        reads: readBufferOf(s.store),
      }),
    )) as never;
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { refused: x.code, ...(x.detail ?? {}) };
  }
}

const rowAt = (r: { readonly ops: readonly { readonly target: { readonly row?: string } }[] }) =>
  r.ops[0]?.target.row as string;
const verAt = (r: { readonly ops: readonly { readonly ver?: string }[] }) =>
  r.ops[0]?.ver as string;
const update = (row: string, set: Record<string, unknown>, ver: string) =>
  send({ sv: 1, ops: [{ intent: "update", table: "rows", row, ver, set }] });

/** 9 then 9.5 in effect; a write of 10 seeing the first: a conflict item, opened by the user. */
async function disputed() {
  const a = await send({ sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "9" } }] });
  const row = rowAt(a);
  const b = await update(row, { b: "9.5" }, verAt(a));
  const c = await update(row, { b: "10" }, verAt(a));
  return { b, row, item: c.pending[0]?.id as string };
}

/** The events of operation `op` of a type, with their blocks' values. */
const ofType = async (op: number, type: string) =>
  (await s.store.read((tx) => readEvents(tx, op, op + 50)))
    .filter((e) => (e.header["op"] ?? e.seq) === op && e.header["type"] === type)
    .map((e) => ({
      blocks: Object.fromEntries(
        [...e.blocks].map(([k, v]) => [k, v.state === "present" ? v.value : undefined]),
      ),
    }));

/** The user imports their own export: they stay active; the restore count becomes 1. */
const importOwnExport = () =>
  appendImportEvent(s.store, {
    user: USER as never,
    tenant: `tn_${"9".repeat(26)}` as never,
    manifest: {
      saveslot_export: 1,
      tenant_id: TENANT as never,
      event_format: 1,
      restore_count: 0,
      upto: 1,
      events: 1,
      exported_at: "2026-11-05T08:00:00.000Z" as never,
      pending_deletions: "placeholder",
    },
    now: "2026-11-05T09:00:00.000Z" as never,
  });

beforeAll(async () => {
  s = await openReusable("saveslot-import-receipt-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);

beforeEach(async () => {
  await s.reset();
  ids = 0;
  await createTenant(
    s.store,
    createOpsContext({
      tenant: TENANT,
      actor: USER,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_key_window: 86_400_000,
      idempotency_window: 600_000,
      now: "2026-11-05T00:00:00.000Z",
      confirmation: null,
    }),
  );
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-05T00:00:30.000Z" as never,
      events: createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }),
    });
    await applyEvents(tx, eventsOf(op));
  });
}, T);

describe("an import since the receipt", () => {
  it(
    "item_ver left out, from an own receipt before the import: confirmation_mismatch, restored",
    async () => {
      const { item } = await disputed();
      await importOwnExport();
      expect(await resolve({ id: item, decision: "keep_effective" })).toMatchObject({
        refused: "confirmation_mismatch",
        reason: "restored",
      });
    },
    T,
  );

  it(
    "item_ver left out, from an own receipt after the import: the receipt binds the item",
    async () => {
      await importOwnExport();
      const { item } = await disputed();
      // The receipt's restore count is the import's, as the current one is: nothing to refuse.
      expect((await resolve({ id: item, decision: "keep_effective" }))["refused"]).toBeUndefined();
    },
    T,
  );

  // pending/ `writerHadRead`: the writer's own receipt counts as having read the item only with no
  // restore or import since. Before the import it did; after it, the write that overwrites the
  // item takes it as not read: it refreshes the item instead of superseding it.
  it(
    "without an import, the writer's own receipt counts as read: the write supersedes the item",
    async () => {
      const { b, row } = await disputed();
      const w = await update(row, { b: "12" }, `v${b.seq}.0`);
      expect(w).not.toHaveProperty("refused");
      expect(await ofType(w.seq, "item.superseded")).toHaveLength(1);
      expect(await ofType(w.seq, "item.refreshed")).toEqual([]);
    },
    T,
  );

  // The same as the case below but for the order: the item is opened after the import, so the
  // receipt is of the current restore count, and `ver` is `.1` in both. Only the import's place
  // differs.
  it(
    "the writer's own receipt from after the import counts as read: the write supersedes the item",
    async () => {
      await importOwnExport();
      const { b, row } = await disputed();
      const w = await update(row, { b: "12" }, `v${b.seq}.1`);
      expect(w).not.toHaveProperty("refused");
      expect(await ofType(w.seq, "item.superseded")).toHaveLength(1);
      expect(await ofType(w.seq, "item.refreshed")).toEqual([]);
    },
    T,
  );

  it(
    "the writer's own receipt from before the import does not count as read after it",
    async () => {
      const { b, row, item } = await disputed();
      await importOwnExport();
      const w = await update(row, { b: "12" }, `v${b.seq}.1`);
      expect(w).not.toHaveProperty("refused");
      expect(await ofType(w.seq, "item.superseded")).toEqual([]);
      const [refreshed] = await ofType(w.seq, "item.refreshed");
      expect(refreshed?.blocks["target"]).toMatchObject({ item, cause: "target_overwritten" });
    },
    T,
  );
});
