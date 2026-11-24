// A key added to a row through the write path (03-data-model/04-write-and-read.md «给没有来源键的行
// 补键»; 04-contract §5.1): added, then hit by a sync; the row holding it or another; the key held
// by a row not revoked or revoked (a transfer, not in this version), a revoke in the same request
// too; a revoked row; two keys for one row in a request; an undo never taking the key back.

import {
  createOpsContext,
  createTenant,
  readEvents,
  readTail,
  reconcileLog,
  resolve,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
// biome-ignore lint/suspicious/noExplicitAny: receipts and blocks read loosely in a test
type Any = any;

// `meals`: timeless, keyed by (origin, external_id); `energy` and `note` in one conflict group,
// `rating` alone.
const MEALS = {
  name: "meals",
  kind: "base",
  description: "a meal",
  time: { type: "none" },
  fields: [
    { name: "origin", type: "text", description: "the source system" },
    { name: "external_id", type: "text", description: "its ID there" },
    { name: "energy", type: "integer", description: "kcal" },
    { name: "note", type: "text", description: "a note" },
    { name: "rating", type: "integer", description: "1 to 5" },
  ],
  together: [["energy", "note"]],
  external_key: ["origin", "external_id"],
};
const DOCUMENT = { slot: "food", base_version: null, timezone: "Asia/Shanghai", tables: [MEALS] };

let s: ReusableStore;
let scratch: ReusableStore;
let minute = 0;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" } as never,
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T03:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
const w = (params: unknown): Promise<Any> => write(s.store, ctx(), params);
async function refused(params: unknown) {
  try {
    await w(params);
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { code: x.code, ...x.detail };
  }
  return "accepted";
}
const tail = async () => (await s.store.read(readTail))?.seq ?? 0;
/** The events of operation `op`, by type, with their present blocks. */
const opEvents = (op: number) =>
  s.store.read(async (tx) => {
    const evs = await readEvents(tx, op, (await readTail(tx))?.seq ?? op);
    return evs
      .filter((e) => e.header["seq"] === op || e.header["op"] === op)
      .map((e) => ({
        type: e.header["type"] as string,
        blocks: Object.fromEntries(
          [...e.blocks].flatMap(([k, b]) => (b.state === "present" ? [[k, b.value]] : [])),
        ) as Record<string, Any>,
      }));
  });
const byKey = (id: string, set: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  intent: "update",
  table: "meals",
  external_key: { origin: "band_app", external_id: id },
  set,
  ...extra,
});
const rows = () =>
  s.store.read(
    async (tx) =>
      (await tx.query<{ n: unknown }>("SELECT count(*) AS n FROM external_keys")).rows[0]?.n,
  );

beforeAll(async () => {
  s = await openReusable("saveslot-add-key-");
  scratch = await openReusable("saveslot-add-key-scratch-");
}, T);
afterAll(async () => {
  await s?.close();
  await scratch?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  await scratch.reset();
  minute = 0;
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), { document: structuredClone(DOCUMENT) });
}, T);

/** A meal written by hand (no key): its row and ver. */
const byHand = async (energy = 500) => {
  const r = await w({ sv: 1, ops: [{ intent: "insert", table: "meals", set: { energy } }] });
  return { row: r.ops[0].target.row as string, ver: r.ops[0].ver as string };
};
const KEY = { origin: "band_app", external_id: "m-2" };
const addKey = (row: string, ver: string, key = KEY, set?: Record<string, unknown>) => ({
  intent: "update",
  table: "meals",
  row,
  ver,
  external_key: key,
  ...(set !== undefined ? { set } : {}),
});
const entries = () =>
  s.store.read(async (tx) =>
    (
      await tx.query<{ key_values: string; holder_row: string }>(
        "SELECT key_values, holder_row FROM external_keys ORDER BY key_values",
      )
    ).rows.map((x) => [x.key_values, x.holder_row]),
  );

describe("a key added to a row", () => {
  it(
    "added: the index names the row; a sync then hits it, judged on the value at the key's write",
    async () => {
      const m = await byHand(500);
      const r = await w({ sv: 1, ops: [addKey(m.row, m.ver)] });
      expect(r.ops[0]).toMatchObject({
        target: { row: m.row, external_key: { origin: "band_app", external_id: "m-2" } },
      });
      expect(await entries()).toEqual([['["band_app","m-2"]', m.row]]);
      // The first sync: no baseline value, compared with the value at the key's write (500).
      const same = await w({ sv: 1, ops: [byKey("m-2", { energy: 500 })] });
      expect(same.ops[0]).toMatchObject({ outcome: "unchanged", target: { row: m.row } });
      const changed = await w({ sv: 1, ops: [byKey("m-2", { energy: 650 })] });
      expect(changed.ops[0]).toMatchObject({ outcome: "updated", target: { row: m.row } });
    },
    T,
  );

  it(
    "with another field changed in the same op",
    async () => {
      const m = await byHand(500);
      const r = await w({ sv: 1, ops: [addKey(m.row, m.ver, KEY, { note: "lunch" })] });
      expect(Object.keys(r.ops[0].fields).sort()).toEqual(["external_id", "note", "origin"]);
      expect(await entries()).toEqual([['["band_app","m-2"]', m.row]]);
    },
    T,
  );

  it(
    "the row holding the same key: its key fields no-ops; another key: key_field_changed",
    async () => {
      const m = await byHand(500);
      const first = await w({ sv: 1, ops: [addKey(m.row, m.ver)] });
      const again = await w({ sv: 1, ops: [addKey(m.row, first.ops[0].ver)] });
      expect(again.ops[0].fields).toMatchObject({
        origin: { result: "noop" },
        external_id: { result: "noop" },
      });
      expect(
        await refused({
          sv: 1,
          ops: [addKey(m.row, first.ops[0].ver, { origin: "band_app", external_id: "m-3" })],
        }),
      ).toEqual({
        code: "invalid_argument",
        reason: "key_field_changed",
        param: "ops/0/external_key",
      });
    },
    T,
  );

  it(
    "two keys for one row in one request: key_field_changed at the second",
    async () => {
      const m = await byHand(500);
      expect(
        await refused({
          sv: 1,
          ops: [
            addKey(m.row, m.ver),
            addKey(m.row, m.ver, { origin: "band_app", external_id: "m-3" }),
          ],
        }),
      ).toEqual({
        code: "invalid_argument",
        reason: "key_field_changed",
        param: "ops/1/external_key",
      });
      expect(await entries()).toEqual([]);
    },
    T,
  );

  it(
    "held by a row not revoked: external_key_in_use, the holder named",
    async () => {
      const synced = await w({ sv: 1, ops: [byKey("m-2", { energy: 650 })] });
      const m = await byHand(500);
      expect(await refused({ sv: 1, ops: [addKey(m.row, m.ver)] })).toEqual({
        code: "invalid_argument",
        reason: "external_key_in_use",
        param: "ops/0/external_key",
        holder: synced.ops[0].target.row,
      });
    },
    T,
  );

  it(
    "held by a revoked row, revoked before or in the same request: a transfer, not in this version",
    async () => {
      const synced = await w({ sv: 1, ops: [byKey("m-2", { energy: 650 })] });
      const s0 = synced.ops[0];
      const m = await byHand(500);
      const notYet = {
        code: "not_in_this_version",
        reason: "parameter",
        param: "ops/1/external_key",
      };
      // In the same request: the revoke first, then the key.
      const before = await tail();
      expect(
        await refused({
          sv: 1,
          ops: [
            { intent: "revoke", table: "meals", row: s0.target.row, ver: s0.ver },
            addKey(m.row, m.ver),
          ],
        }),
      ).toEqual(notYet);
      expect(await tail()).toBe(before);
      // Revoked before.
      await w({
        sv: 1,
        ops: [{ intent: "revoke", table: "meals", row: s0.target.row, ver: s0.ver }],
      });
      expect(await refused({ sv: 1, ops: [addKey(m.row, m.ver)] })).toEqual({
        ...notYet,
        param: "ops/0/external_key",
      });
    },
    T,
  );

  it(
    "a revoked row: revoked, as any update naming it",
    async () => {
      const m = await byHand(500);
      const rv = await w({
        sv: 1,
        ops: [{ intent: "revoke", table: "meals", row: m.row, ver: m.ver }],
      });
      expect(await refused({ sv: 1, ops: [addKey(m.row, rv.ops[0].ver)] })).toMatchObject({
        code: "revoked",
      });
    },
    T,
  );
});

describe("the row before the key (review of part 6)", () => {
  it(
    "a revoked row is revoked whatever holds the key: a row not revoked, or a revoked one",
    async () => {
      const m = await byHand(500);
      const rv = await w({
        sv: 1,
        ops: [{ intent: "revoke", table: "meals", row: m.row, ver: m.ver }],
      });
      // The key held by a row not revoked.
      await w({ sv: 1, ops: [byKey("m-2", { energy: 650 })] });
      expect(await refused({ sv: 1, ops: [addKey(m.row, rv.ops[0].ver)] })).toMatchObject({
        code: "revoked",
        revoked_by: rv.seq,
      });
      // The key held by a revoked row.
      const other = await w({ sv: 1, ops: [byKey("m-3", { energy: 1 })] });
      await w({
        sv: 1,
        ops: [
          { intent: "revoke", table: "meals", row: other.ops[0].target.row, ver: other.ops[0].ver },
        ],
      });
      expect(
        await refused({
          sv: 1,
          ops: [addKey(m.row, rv.ops[0].ver, { origin: "band_app", external_id: "m-3" })],
        }),
      ).toMatchObject({ code: "revoked", revoked_by: rv.seq });
    },
    T,
  );

  it(
    "a key added, then given again in set by a later op of the same request: let through",
    async () => {
      const m = await byHand(500);
      const r = await w({
        sv: 1,
        ops: [
          addKey(m.row, m.ver),
          {
            intent: "update",
            table: "meals",
            row: m.row,
            ver: m.ver,
            set: { origin: "band_app", energy: 520 },
          },
        ],
      });
      expect(r.ops).toHaveLength(2);
      expect(await entries()).toEqual([['["band_app","m-2"]', m.row]]);
    },
    T,
  );

  it(
    "a receipt gives the key as the row held it then: a replay of a write before the key, without it",
    async () => {
      const params = {
        sv: 1,
        idempotency_key: "first",
        ops: [{ intent: "insert", table: "meals", set: { energy: 500 } }],
      };
      const first = await w(params);
      const row = first.ops[0].target.row;
      expect(first.ops[0].target.external_key).toBeUndefined();
      const k = await w({ sv: 1, ops: [addKey(row, first.ops[0].ver)] });
      expect(k.ops[0].target.external_key).toEqual({ origin: "band_app", external_id: "m-2" });
      const again = await w(params);
      expect(again.replayed).toBe(true);
      expect(again.ops[0].target.external_key).toBeUndefined();
    },
    T,
  );
});

describe("an undo never takes the key back", () => {
  it(
    "the write only added the key: no change to undo",
    async () => {
      const m = await byHand(500);
      const r = await w({ sv: 1, ops: [addKey(m.row, m.ver)] });
      expect(
        await refused({
          sv: 1,
          ops: [{ table: "meals", row: m.row, ver: r.ops[0].ver, revert: { undo: r.seq } }],
        }),
      ).toMatchObject({ code: "invalid_argument", reason: "undo_target" });
    },
    T,
  );

  it(
    "the write added the key and changed a field: the field goes back, the key stays",
    async () => {
      const m = await byHand(500);
      const r = await w({ sv: 1, ops: [addKey(m.row, m.ver, KEY, { energy: 550 })] });
      const u = await w({
        sv: 1,
        ops: [{ table: "meals", row: m.row, ver: r.ops[0].ver, revert: { undo: r.seq } }],
      });
      expect(Object.keys(u.ops[0].fields)).toEqual(["energy"]);
      expect(await entries()).toEqual([['["band_app","m-2"]', m.row]]);
      // Still the key's: a sync of the same value is unchanged against the value at the key's write.
      const sync = await w({ sv: 1, ops: [byKey("m-2", { energy: 650 })] });
      expect(sync.ops[0]).toMatchObject({ target: { row: m.row } });
      const r2 = await reconcileLog({ live: s.store, scratch: scratch.store });
      expect(r2.mismatches).toEqual([]);
    },
    T,
  );
});
