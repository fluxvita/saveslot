// What each operation that appends to the log notes beside its result for the server mode's call
// records (log/effect.ts; docs/zh-CN/process/decisions/server-call-records.md §2): `appended` with
// the operation it appended, the latest in the log; `replayed` with the first one's, when the same
// request is sent again or a removal is asked again; `none` when nothing was appended. Every
// operation that appends has a case here, so an operation added later without its effect fails.

import {
  createOpsContext,
  createTenant,
  effectOf,
  issueConnection,
  removeSlot,
  renameConnection,
  resolve,
  revokeConnection,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
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
