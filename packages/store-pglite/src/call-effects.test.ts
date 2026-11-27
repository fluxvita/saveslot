// What each operation that appends to the log notes beside its result for the server mode's call
// records (log/effect.ts; docs/zh-CN/process/decisions/server-call-records.md §2): `appended` with
// the operation it appended, the latest in the log; `replayed` with the first one's, when the same
// request is sent again or a removal is asked again; `none` when nothing was appended. Every
// operation that appends has a case here, so an operation added later without its effect fails.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpsContext,
  createTenant,
  effectOf,
  issueConnection,
  removeSlot,
  renameConnection,
  resolve,
  restoreTenant,
  revokeConnection,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { openFileAnchorStore } from "@fluxvita/saveslot-kernel/anchor-file";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const EXPENSES = {
  name: "expenses",
  kind: "base",
  description: "one row per expense",
  time: { type: "event", field: "date" },
  fields: [
    { name: "date", type: "date", required: true, description: "the day" },
    { name: "note", type: "text", description: "what for" },
  ],
};
const DOCUMENT = {
  slot: "ledger",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [EXPENSES],
};

let s: ReusableStore;
let minute = 0;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T03:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
// biome-ignore lint/suspicious/noExplicitAny: receipts as the kernel returns them
type Any = any;
/** The latest operation's number in the log. */
const lastOp = async () =>
  Number(
    (await s.store.read((tx) => tx.query<{ op: unknown }>("SELECT max(op) AS op FROM events")))
      .rows[0]?.op,
  );

beforeAll(async () => {
  s = await openReusable("saveslot-call-effects-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  await createTenant(s.store, ctx());
}, T);

describe("an operation's effect, beside its result", () => {
  it(
    "schema_draft: a new slot appended; sent again, replayed with the same operation",
    async () => {
      const first = await schemaDraft(s.store, ctx(), { document: DOCUMENT });
      expect(effectOf(first)).toEqual({ effect: "appended", seq: await lastOp(), restores: 0 });
      const again = await schemaDraft(s.store, ctx(), { document: DOCUMENT });
      expect(effectOf(again)).toEqual({ ...effectOf(first), effect: "replayed" });
    },
    T,
  );

  it(
    "schema_draft of a change, and resolve of its item: each appended",
    async () => {
      await schemaDraft(s.store, ctx(), { document: DOCUMENT });
      const renamed = {
        ...DOCUMENT,
        base_version: 1,
        tables: [
          {
            ...EXPENSES,
            id: "t1",
            fields: [
              { ...EXPENSES.fields[0], id: "f1" },
              { ...EXPENSES.fields[1], id: "f2", name: "memo" },
            ],
          },
        ],
      };
      const d = (await schemaDraft(s.store, ctx(), { document: renamed })) as Any;
      expect(effectOf(d)).toEqual({ effect: "appended", seq: await lastOp(), restores: 0 });
      const r = await resolve(s.store, ctx(), {
        id: d.item.id,
        decision: "confirm",
        item_ver: d.item.item_ver,
      });
      expect(effectOf(r)).toEqual({ effect: "appended", seq: await lastOp(), restores: 0 });
    },
    T,
  );

  it(
    "write: appended and saved; the same request again, replayed with the same operation",
    async () => {
      await schemaDraft(s.store, ctx(), { document: DOCUMENT });
      const params = {
        sv: 1,
        ops: [{ table: "expenses", intent: "insert", set: { date: "2026-11-01", note: "tea" } }],
      };
      const first = await write(s.store, ctx(), params);
      expect(effectOf(first)).toEqual({
        effect: "appended",
        seq: await lastOp(),
        restores: 0,
        status: "saved",
      });
      const again = await write(s.store, ctx(), params);
      expect(effectOf(again)).toEqual({ ...effectOf(first), effect: "replayed" });
    },
    T,
  );

  it(
    "slots.remove: appended; asked again, replayed with the same operation",
    async () => {
      const slot = ((await schemaDraft(s.store, ctx(), { document: DOCUMENT })) as Any).slot_id;
      const first = await removeSlot(s.store, ctx(), { slot_id: slot } as never);
      expect(effectOf(first)).toEqual({ effect: "appended", seq: await lastOp(), restores: 0 });
      const again = await removeSlot(s.store, ctx(), { slot_id: slot } as never);
      expect(effectOf(again)).toEqual({ ...effectOf(first), effect: "replayed" });
    },
    T,
  );

  it(
    "a write after a restore on the same store: the new restore count, not the one kept from before",
    async () => {
      await schemaDraft(s.store, ctx(), { document: DOCUMENT });
      const insert = (note: string) =>
        write(s.store, ctx(), {
          sv: 1,
          ops: [{ table: "expenses", intent: "insert", set: { date: "2026-11-01", note } }],
        });
      expect(effectOf(await insert("before"))).toMatchObject({ restores: 0 });
      const dir = mkdtempSync(join(tmpdir(), "saveslot-call-effects-anchor-"));
      try {
        const anchor = openFileAnchorStore(join(dir, "anchor.json"));
        await anchor.advanceHighWater(TENANT as never, await lastOp());
        await restoreTenant({ store: s.store, anchor, tenant: TENANT as never, now: ctx().now });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      expect(effectOf(await insert("after"))).toMatchObject({
        effect: "appended",
        seq: await lastOp(),
        restores: 1,
      });
    },
    T,
  );

  it(
    "connections: issued, renamed, revoked appended; renamed to its name or revoked again, none",
    async () => {
      const issued = await issueConnection(s.store, ctx(), {
        name: "kitchen tablet",
        via: "token",
      });
      expect(effectOf(issued)).toEqual({ effect: "appended", seq: await lastOp(), restores: 0 });
      const id = issued.id;
      const renamed = await renameConnection(s.store, ctx(), { id, name: "hall tablet" } as never);
      expect(effectOf(renamed)).toEqual({ effect: "appended", seq: await lastOp(), restores: 0 });
      const same = await renameConnection(s.store, ctx(), { id, name: "hall tablet" } as never);
      expect(effectOf(same)).toEqual({ effect: "none" });
      const revoked = await revokeConnection(s.store, ctx(), { id } as never);
      expect(effectOf(revoked)).toEqual({ effect: "appended", seq: await lastOp(), restores: 0 });
      const again = await revokeConnection(s.store, ctx(), { id } as never);
      expect(effectOf(again)).toEqual({ effect: "none" });
    },
    T,
  );
});

// Writes by external key (03-data-model «按来源键写入»): a value the user changed and then the source
// changed again is a candidate (a pending write, a conflict item); the same values sent again
// change nothing and append nothing. The item resolved by taking the candidate triggers a write.
describe("by external key: a pending write, a write that appends nothing, a resolution and its repeat", () => {
  const MEALS = {
    name: "meals",
    kind: "base",
    description: "a meal",
    time: { type: "none" },
    fields: [
      { name: "origin", type: "text", description: "the source system" },
      { name: "external_id", type: "text", description: "its ID there" },
      { name: "energy", type: "integer", description: "kcal" },
    ],
    external_key: ["origin", "external_id"],
  };
  const FOOD = { slot: "food", base_version: null, timezone: "Asia/Shanghai", tables: [MEALS] };
  /** A context of its own task: a request sent again under another task is not a replay of it. */
  const tasked = (task: string) => ({ ...ctx(), task });
  const byKey = (energy: number) => ({
    sv: 1,
    ops: [
      {
        intent: "update",
        table: "meals",
        external_key: { origin: "band_app", external_id: "m-1" },
        set: { energy },
      },
    ],
  });

  it(
    "sent again under another task with the same values: none, no operation",
    async () => {
      await schemaDraft(s.store, ctx(), { document: FOOD });
      const first = await write(s.store, tasked("first"), byKey(600));
      expect(effectOf(first)).toMatchObject({ effect: "appended", status: "saved" });
      const same = await write(s.store, tasked("second"), byKey(600));
      expect(same.seq).toBeUndefined();
      expect(effectOf(same)).toEqual({ effect: "none" });
    },
    T,
  );

  it(
    "a candidate: appended and pending; the item resolved by taking it, appended with its write's status; resolved again, replayed with the first resolution's operation",
    async () => {
      await schemaDraft(s.store, ctx(), { document: FOOD });
      const first = (await write(s.store, ctx(), byKey(600))) as Any;
      await write(s.store, ctx(), {
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "meals",
            row: first.ops[0].target.row,
            ver: first.ops[0].ver,
            set: { energy: 500 },
          },
        ],
      });
      const candidate = (await write(s.store, ctx(), byKey(650))) as Any;
      expect(candidate.status).toBe("pending");
      expect(effectOf(candidate)).toEqual({
        effect: "appended",
        seq: await lastOp(),
        restores: 0,
        status: "pending",
      });
      const item = candidate.pending[0];
      const decide = { id: item.id, decision: "take_candidate", item_ver: item.item_ver };
      const taken = (await resolve(s.store, ctx(), decide)) as Any;
      expect(taken.write).toBeDefined();
      expect(effectOf(taken)).toEqual({
        effect: "appended",
        seq: await lastOp(),
        restores: 0,
        status: "saved",
      });
      const again = await resolve(s.store, ctx(), decide);
      expect(effectOf(again)).toEqual({ ...effectOf(taken), effect: "replayed" });
    },
    T,
  );
});
