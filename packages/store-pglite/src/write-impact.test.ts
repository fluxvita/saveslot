// The impact of an awaiting undo names the later writes whose result a reader would see change
// once it is confirmed (04-write-and-read «撤回某次写入（undo）»; 05-time «高影响写入» ④), in the
// undo's record or not, and only those: a write whose contribution is taken back while what a
// reader sees stays the same is not named.

import {
  createOpsContext,
  createTenant,
  pending,
  query,
  readBufferOf,
  resolve,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { resolveInTx } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore, snapshot } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"9".repeat(26)}`;
const USER = `u_${"2".repeat(26)}`;
const OTHER = `ci_${"6".repeat(26)}`;
/** Reads details; never writes (a principal that read an item and then writes supersedes it). */
const THIRD = `ci_${"7".repeat(26)}`;
/** Another writer. */
const THIRD_WRITER = `ci_${"8".repeat(26)}`;
/** A writer that reads no item. */
const FOURTH = `ci_${"4".repeat(26)}`;

let s: ReusableStore;
let minute = 0;
const ctxOf = (actor: string) =>
  createOpsContext({
    tenant: TENANT,
    actor,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T04:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  } as never);

const field = (name: string, required?: true) => ({
  name,
  type: name === "date" ? "date" : "text",
  description: name,
  ...(required ? { required } : {}),
});

beforeAll(async () => {
  s = await openReusable("saveslot-write-impact-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  await createTenant(s.store, ctxOf(USER));
  await schemaDraft(s.store, ctxOf(USER), {
    document: {
      slot: "home",
      base_version: null,
      timezone: "Asia/Shanghai",
      tables: [
        {
          name: "rows",
          kind: "base",
          description: "rows",
          time: { type: "none" },
          fields: [field("b", true), field("c")],
        },
        {
          name: "events",
          kind: "base",
          description: "events",
          time: { type: "event", field: "date" },
          fields: [field("date", true), field("b", true), field("c")],
        },
        {
          name: "entities",
          kind: "base",
          description: "entities",
          time: { type: "state", granularity: "date" },
          fields: [field("b", true), field("c")],
        },
      ],
    },
  } as never);
}, T);

// biome-ignore lint/suspicious/noExplicitAny: receipts and details as the contract gives them
type Any = any;
const put = (table: string, op: Record<string, unknown>, actor = USER): Promise<Any> =>
  write(s.store, ctxOf(actor), { sv: 1, ops: [{ table, ...op }] } as never);
const detail = (id: string): Promise<Any> => pending(s.store, ctxOf(THIRD), { id } as never);
const verAt = (r: Any) => r.ops[0].ver as string;
const named = (d: Any) =>
  ((d.impact?.reverted ?? []) as Any[]).map((x) => ({ seq: x.seq, fields: x.fields }));

/**
 * An undo of a restore awaits, taking back a revoke with include_later; another principal then
 * undoes the restore, revoking the row again. On a table where a revoke changes only existence,
 * confirming restores the row over that later revoke.
 */
async function revokeOverRevoke(
  table: string,
  key: "row" | "entity",
  set: Record<string, unknown>,
  span = {},
) {
  const e = await put(table, {
    intent: "insert",
    ...(key === "entity" ? { valid_from: "2026-11-01" } : {}),
    set,
  });
  const id = e.ops[0].target[key] as string;
  const target = { [key]: id };
  const v = await put(table, { ...target, intent: "revoke", ver: verAt(e), ...span });
  const r = await put(table, { ...target, revert: { undo: v.seq }, ver: verAt(v) });
  const p = await put(table, {
    ...target,
    revert: { undo: v.seq, include_later: true },
    ver: verAt(r),
  });
  const item = p.pending?.[0]?.id as string;
  expect(p.pending?.[0]?.type).toBe("awaiting_confirmation");
  const o = await put(table, { ...target, revert: { undo: r.seq }, ver: verAt(r) }, OTHER);
  return { id, item, o };
}

describe("the impact of an awaiting undo, by what a reader sees", () => {
  it(
    "a timeless row: a later revoke the confirmation lifts is named",
    async () => {
      const { item, o } = await revokeOverRevoke("rows", "row", { b: "b0" });
      expect(o.status).toBe("saved");
      expect(named(await detail(item))).toEqual([{ seq: o.seq, fields: ["*"] }]);
    },
    T,
  );

  it(
    "an event table row: a later revoke the confirmation lifts is named",
    async () => {
      const { item, o } = await revokeOverRevoke("events", "row", { date: "2026-11-05", b: "b0" });
      expect(o.status).toBe("saved");
      expect(named(await detail(item))).toEqual([{ seq: o.seq, fields: ["*"] }]);
    },
    T,
  );

  it(
    "a state table: the later revoke keeps the stretch without a value, so it is not named",
    async () => {
      // A revoke on a state table takes the values of its interval: confirming restores existence
      // there but brings no value back, and the stretch reads the same before and after.
      const { id, item, o } = await revokeOverRevoke(
        "entities",
        "entity",
        { b: "b0" },
        { valid_from: "2026-11-05", valid_to: "2026-11-10" },
      );
      expect(o.status).toBe("saved");
      const d = await detail(item);
      expect(named(d).map((x: Any) => x.seq)).not.toContain(o.seq);
      const before = await query(s.store, ctxOf(THIRD), {
        table: "entities",
        valid_during: ["2026-10-01", null],
        clip: false,
      } as never);
      const c = await resolve(s.store, ctxOf(THIRD), {
        id: item,
        decision: "confirm",
        item_ver: d.item_ver,
      } as never);
      expect((c as Any).status).toBe("resolved");
      const after = await query(s.store, ctxOf(THIRD), {
        table: "entities",
        valid_during: ["2026-10-01", null],
        clip: false,
      } as never);
      const shown = (q: Any) =>
        (q.rows as Any[])
          .filter((x) => x.entity === id)
          .map((x) => [x.valid_from, x.valid_to, x.values]);
      expect(shown(after)).toEqual(shown(before));
    },
    T,
  );

  it(
    "a write-back without a value, hidden with its stretch, changes nothing a reader sees: not named",
    async () => {
      // b over [11-05, 11-10); another principal's c there; the entity revoked and the revoke
      // undone with include_later; c's write undone (c written back without a value); then the
      // include_later undo undone: awaiting, it would revoke the stretch again.
      const span = { valid_from: "2026-11-05", valid_to: "2026-11-10" };
      const e = await put("entities", { intent: "insert", ...span, set: { b: "b0" } });
      const entity = e.ops[0].target.entity as string;
      const c = await put(
        "entities",
        { entity, intent: "update", ver: verAt(e), ...span, set: { c: "c1" } },
        OTHER,
      );
      const v = await put("entities", { entity, intent: "revoke", ver: verAt(c) });
      const u = await put("entities", {
        entity,
        revert: { undo: v.seq, include_later: true },
        ver: verAt(v),
        acknowledge: ["overwrite"],
      });
      const n = await put("entities", {
        entity,
        revert: { undo: c.seq },
        ver: verAt(u),
        acknowledge: ["overwrite"],
      });
      const p = await put("entities", { entity, revert: { undo: u.seq }, ver: verAt(n) });
      const item = p.pending?.[0]?.id as string;
      expect(p.pending?.[0]?.type).toBe("awaiting_confirmation");
      expect(named(await detail(item)).map((x: Any) => x.seq)).not.toContain(n.seq);
    },
    T,
  );

  it(
    "a stretch without a value that confirming fills: a later revoke leaving it so is named",
    async () => {
      // b0 from 11-01; USER writes b1 over [11-05, 11-10); another principal revokes that
      // stretch; USER undoes its write with include_later, taking the revoke back: awaiting.
      // Confirming writes b0 back there: the stretch goes from no value to b0, and the revoke that
      // left it without one is named.
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        set: { b: "b0" },
      });
      const entity = e.ops[0].target.entity as string;
      const span = { valid_from: "2026-11-05", valid_to: "2026-11-10" };
      const w = await put("entities", {
        entity,
        intent: "update",
        ver: verAt(e),
        ...span,
        set: { b: "b1" },
      });
      const x = await put("entities", { entity, intent: "revoke", ver: verAt(w), ...span }, OTHER);
      const p = await put("entities", {
        entity,
        revert: { undo: w.seq, include_later: true },
        ver: verAt(x),
      });
      const item = p.pending?.[0]?.id as string;
      expect(p.pending?.[0]?.type).toBe("awaiting_confirmation");
      expect(named(await detail(item))).toEqual([{ seq: x.seq, fields: ["*"] }]);
    },
    T,
  );

  it(
    "a stretch without a value that confirming fills: the undone revoke itself is not named",
    async () => {
      // b0 from 11-01; USER revokes [11-01, 11-10); another principal writes b1 over [11-05, 11-10);
      // USER undoes its revoke with include_later, taking that write back: awaiting. Confirming
      // writes b0 back over [11-01, 11-10): on [11-01, 11-05) the stretch goes from no value to b0,
      // but the revoke leaving it so is the operation undone, not a later write; on [11-05, 11-10)
      // b1 goes.
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        set: { b: "b0" },
      });
      const entity = e.ops[0].target.entity as string;
      const v = await put("entities", {
        entity,
        intent: "revoke",
        ver: verAt(e),
        valid_from: "2026-11-01",
        valid_to: "2026-11-10",
      });
      const w = await put(
        "entities",
        {
          entity,
          intent: "update",
          ver: verAt(v),
          valid_from: "2026-11-05",
          valid_to: "2026-11-10",
          set: { b: "b1" },
        },
        OTHER,
      );
      const p = await put("entities", {
        entity,
        revert: { undo: v.seq, include_later: true },
        ver: verAt(w),
      });
      const item = p.pending?.[0]?.id as string;
      expect(p.pending?.[0]?.type).toBe("awaiting_confirmation");
      expect(named(await detail(item))).toEqual([{ seq: w.seq, fields: ["b"] }]);
    },
    T,
  );

  it(
    "an optional field nobody gave on a stretch another write filled: confirming shows a value there, and no write is named for it",
    async () => {
      // b (required) and c from 11-01; USER writes c1; another principal revokes [11-05, 11-10);
      // a third fills that stretch with b5 alone. USER undoes the c write with include_later: the
      // confirmation writes c0 back and takes the revoke back, so c on [11-05, 11-10) goes from
      // empty to c0. A result is given only by a contribution (a value, a clear, a revoke); c read
      // empty there because no write gave it, which is no one's result. The revoke's "no value
      // here" was filled by b5 before the confirmation and is read nowhere: it is not named either.
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        set: { b: "b0", c: "c0" },
      });
      const entity = e.ops[0].target.entity as string;
      const span = { valid_from: "2026-11-05", valid_to: "2026-11-10" };
      const w = await put("entities", {
        entity,
        intent: "update",
        ver: verAt(e),
        set: { c: "c1" },
      });
      const r = await put("entities", { entity, intent: "revoke", ver: verAt(w), ...span }, OTHER);
      const f = await put(
        "entities",
        {
          entity,
          intent: "update",
          ver: verAt(r),
          ...span,
          set: { b: "b5" },
          acknowledge: ["overwrite"],
        },
        FOURTH,
      );
      expect(f.status).toBe("saved");
      const p = await put("entities", {
        entity,
        revert: { undo: w.seq, include_later: true },
        ver: verAt(f),
      });
      const item = p.pending?.[0]?.id as string;
      expect(p.pending?.[0]?.type).toBe("awaiting_confirmation");
      const d = await detail(item);
      expect(named(d).map((x: Any) => x.seq)).not.toContain(r.seq);
      expect(named(d)).toEqual([]);
      const c = await resolve(s.store, ctxOf(THIRD), {
        id: item,
        decision: "confirm",
        item_ver: d.item_ver,
      } as never);
      expect((c as Any).status).toBe("resolved");
      const after = await query(s.store, ctxOf(THIRD), {
        table: "entities",
        valid_during: ["2026-11-05", "2026-11-10"],
        clip: true,
      } as never);
      expect(
        (after.rows as Any[]).filter((x) => x.entity === entity).map((x) => x.values.c),
      ).toEqual(["c0"]);
    },
    T,
  );

  it(
    "a later write of the value the confirmation writes back: what a reader sees stays, nothing is named",
    async () => {
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        set: { b: "b0" },
      });
      const entity = e.ops[0].target.entity as string;
      const span = { valid_from: "2026-11-05", valid_to: "2026-11-10" };
      const w = await put("entities", {
        entity,
        intent: "update",
        ver: verAt(e),
        ...span,
        set: { b: "b1" },
      });
      const x = await put(
        "entities",
        {
          entity,
          intent: "update",
          ver: verAt(w),
          ...span,
          set: { b: "b0" },
          acknowledge: ["overwrite"],
        },
        OTHER,
      );
      expect(x.status).toBe("saved");
      const p = await put("entities", {
        entity,
        revert: { undo: w.seq, include_later: true },
        ver: verAt(x),
      });
      const item = p.pending?.[0]?.id as string;
      expect(p.pending?.[0]?.type).toBe("awaiting_confirmation");
      expect(named(await detail(item))).toEqual([]);
    },
    T,
  );

  it(
    "a later write covered whole by a still later one: only the still later one is named",
    async () => {
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        set: { b: "b0" },
      });
      const entity = e.ops[0].target.entity as string;
      const span = { valid_from: "2026-11-05", valid_to: "2026-11-10" };
      const w = await put("entities", {
        entity,
        intent: "update",
        ver: verAt(e),
        ...span,
        set: { b: "b1" },
      });
      const x = await put(
        "entities",
        { entity, intent: "update", ver: verAt(w), ...span, set: { b: "b2" } },
        OTHER,
      );
      const y = await put(
        "entities",
        { entity, intent: "update", ver: verAt(x), ...span, set: { b: "b3" } },
        FOURTH,
      );
      expect(y.status).toBe("saved");
      const p = await put("entities", {
        entity,
        revert: { undo: w.seq, include_later: true },
        ver: verAt(y),
      });
      const item = p.pending?.[0]?.id as string;
      expect(p.pending?.[0]?.type).toBe("awaiting_confirmation");
      expect(named(await detail(item))).toEqual([{ seq: y.seq, fields: ["b"] }]);
    },
    T,
  );

  it(
    "later writes of different fields overlapping each other: each is named with its own field",
    async () => {
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        set: { b: "b0", c: "c0" },
      });
      const entity = e.ops[0].target.entity as string;
      const w = await put("entities", {
        entity,
        intent: "update",
        ver: verAt(e),
        valid_from: "2026-11-05",
        valid_to: "2026-11-10",
        set: { b: "b1", c: "c1" },
      });
      const x = await put(
        "entities",
        {
          entity,
          intent: "update",
          ver: verAt(w),
          valid_from: "2026-11-05",
          valid_to: "2026-11-08",
          set: { b: "b2" },
        },
        OTHER,
      );
      const y = await put(
        "entities",
        {
          entity,
          intent: "update",
          ver: verAt(x),
          valid_from: "2026-11-07",
          valid_to: "2026-11-10",
          set: { c: "c2" },
        },
        FOURTH,
      );
      expect(y.status).toBe("saved");
      const p = await put("entities", {
        entity,
        revert: { undo: w.seq, include_later: true },
        ver: verAt(y),
      });
      const item = p.pending?.[0]?.id as string;
      expect(p.pending?.[0]?.type).toBe("awaiting_confirmation");
      expect(named(await detail(item))).toEqual([
        { seq: x.seq, fields: ["b"] },
        { seq: y.seq, fields: ["c"] },
      ]);
    },
    T,
  );

  it(
    "a refresh judges the confirmation numbered after every event: a later revoke left as it is is not named",
    async () => {
      // b0 over [11-01, 11-10); revoked whole and restored by undoing the revoke; an undo of the
      // restore with include_later awaits (it would revoke again). Another principal then revokes
      // [11-05, 11-10). Confirming revokes all of [11-01, 11-10): the later revoke's stretch reads
      // "no value" before and after, so it is not named. Judged with a number one past the last
      // operation, the confirmation's write-back took the event number of that revoke and was
      // registered with it: it seemed to bring b0 back there, and the revoke was named.
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        valid_to: "2026-11-10",
        set: { b: "b0" },
      });
      const entity = e.ops[0].target.entity as string;
      const v = await put("entities", { entity, intent: "revoke", ver: verAt(e) });
      const r = await put("entities", { entity, revert: { undo: v.seq }, ver: verAt(v) });
      const p = await put("entities", {
        entity,
        intent: "correct",
        revert: { undo: r.seq, include_later: true },
        ver: verAt(r),
      });
      const item = p.pending?.[0]?.id as string;
      expect(p.pending?.[0]?.type).toBe("awaiting_confirmation");
      const x = await put(
        "entities",
        {
          entity,
          intent: "revoke",
          ver: verAt(r),
          valid_from: "2026-11-05",
          valid_to: "2026-11-10",
        },
        OTHER,
      );
      expect(x.status).toBe("saved");
      const d = await detail(item);
      expect(named(d)).toEqual([]);
      const c = await resolve(s.store, ctxOf(THIRD), {
        id: item,
        decision: "confirm",
        item_ver: d.item_ver,
      } as never);
      expect((c as Any).status).toBe("resolved");
      const q = await query(s.store, ctxOf(THIRD), {
        table: "entities",
        valid_during: ["2026-10-01", null],
        clip: false,
      } as never);
      expect((q.rows as Any[]).filter((y) => y.entity === entity)).toEqual([]);
    },
    T,
  );

  it(
    "a conflict item's take_previous, judged numbered after every event: a write it leaves as it reads is not listed",
    async () => {
      // b0 over [11-01, 11-10); USER writes b1 over [11-05, 11-10); a third principal writes c
      // there; another principal writes b2 there from before b1: a candidate, opening a conflict
      // item whose merge base has b0 on that stretch. A writer that has not read the item then
      // writes b4 there (in effect; the item is refreshed). Taking the merge base writes b0 back:
      // the stretch keeps a value, and c stays as it reads, so nothing is listed. Judged one past
      // the last operation, the take_previous's write-back took the event number of b4's item,
      // which it takes back, and was registered with it: the stretch seemed to lose its value, and
      // c was listed.
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        valid_to: "2026-11-10",
        set: { b: "b0" },
      });
      const entity = e.ops[0].target.entity as string;
      const span = { valid_from: "2026-11-05", valid_to: "2026-11-10" };
      const b1 = await put("entities", {
        entity,
        intent: "update",
        ver: verAt(e),
        ...span,
        set: { b: "b1" },
      });
      const c = await put(
        "entities",
        { entity, intent: "update", ver: verAt(b1), ...span, set: { c: "c3" } },
        THIRD_WRITER,
      );
      const b2 = await put(
        "entities",
        { entity, intent: "update", ver: verAt(e), ...span, set: { b: "b2" } },
        OTHER,
      );
      const item = (b2.pending as Any[] | undefined)?.find((q) => q.type === "conflict")
        ?.id as string;
      expect(item).toMatch(/^pi_/);
      const b4 = await put(
        "entities",
        { entity, intent: "update", ver: verAt(c), ...span, set: { b: "b4" } },
        FOURTH,
      );
      expect(b4.status).toBe("saved");
      expect(((b4.pending ?? []) as Any[]).find((q) => q.id === item)?.refreshed).toBe(true);
      const d = await detail(item);
      expect(((d.reverted_by_previous ?? []) as Any[]).map((x) => x.seq)).not.toContain(c.seq);
    },
    T,
  );
});

describe("a decision made in a transaction that is then rolled back", () => {
  it(
    "leaves the store and the read buffer as they were, while the transaction itself sees it",
    async () => {
      // A conflict item: b1 over [11-05, 11-10), then another principal's b2 there from before it.
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        valid_to: "2026-11-10",
        set: { b: "b0" },
      });
      const entity = e.ops[0].target.entity as string;
      const span = { valid_from: "2026-11-05", valid_to: "2026-11-10" };
      await put("entities", { entity, intent: "update", ver: verAt(e), ...span, set: { b: "b1" } });
      const b2 = await put(
        "entities",
        { entity, intent: "update", ver: verAt(e), ...span, set: { b: "b2" } },
        OTHER,
      );
      const item = (b2.pending as Any[]).find((q) => q.type === "conflict")?.id as string;
      const d = await detail(item);
      const buffer = readBufferOf(s.store);
      const size = buffer.size;
      const before = await s.store.read(snapshot);
      const ROLLBACK = new Error("roll back");
      let seen: unknown;
      const thrown = await s.store
        .write(async (tx) => {
          const r = await resolveInTx(tx, {
            actor: THIRD as never,
            task: null,
            now: "2026-11-05T05:00:00.000Z" as never,
            windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
            visibility: { kind: "all" },
            params: { id: item, decision: "take_previous", item_ver: d.item_ver },
            newId: (kind: string) => `${kind === "item" ? "pi_" : "s_"}${"9".repeat(16)}`,
            reads: buffer,
          } as never);
          seen = [
            (r as Any).status,
            (
              await tx.query<{ state: string }>("SELECT state FROM pending_items WHERE id = $1", [
                item,
              ])
            ).rows[0]?.state,
          ];
          throw ROLLBACK;
        })
        .catch((x: unknown) => x);
      expect(thrown).toBe(ROLLBACK);
      // Inside: decided.
      expect(seen).toEqual(["resolved", "resolved"]);
      // Afterwards: nothing of it, in the store or in the read buffer.
      expect(await s.store.read(snapshot)).toEqual(before);
      expect(buffer.size).toBe(size);
      expect((await detail(item)).status).toBe("open");
    },
    T,
  );
});

describe("a conflict item's reverted_by_previous, by what a reader sees", () => {
  /**
   * b0 over [11-01, 11-10); USER writes b1 over [11-05, 11-10); another principal writes b2 there
   * from before b1: a candidate, opening a conflict item whose merge base has b0 on that stretch.
   */
  async function conflictOverB0() {
    const e = await put("entities", {
      intent: "insert",
      valid_from: "2026-11-01",
      valid_to: "2026-11-10",
      set: { b: "b0" },
    });
    const entity = e.ops[0].target.entity as string;
    const span = { valid_from: "2026-11-05", valid_to: "2026-11-10" };
    const b1 = await put("entities", {
      entity,
      intent: "update",
      ver: verAt(e),
      ...span,
      set: { b: "b1" },
    });
    const b2 = await put(
      "entities",
      { entity, intent: "update", ver: verAt(e), ...span, set: { b: "b2" } },
      OTHER,
    );
    const item = (b2.pending as Any[]).find((q) => q.type === "conflict")?.id as string;
    expect(item).toMatch(/^pi_/);
    return { entity, span, b1, item };
  }

  it(
    "a later write that puts the merge base's value back: taking the merge base changes nothing there, nothing is listed",
    async () => {
      const { entity, span, b1, item } = await conflictOverB0();
      expect(named({ impact: { reverted: (await detail(item)).reverted_by_previous } })).toEqual([
        { seq: b1.seq, fields: ["b"] },
      ]);
      const back = await put(
        "entities",
        {
          entity,
          intent: "update",
          ver: verAt(b1),
          ...span,
          set: { b: "b0" },
          acknowledge: ["overwrite"],
        },
        FOURTH,
      );
      expect(back.status).toBe("saved");
      expect((await detail(item)).reverted_by_previous).toEqual([]);
    },
    T,
  );

  it(
    "a later revoke of the stretch: taking the merge base leaves it (covered), so it is not listed",
    async () => {
      // The revoke covers b1 there: a take_previous takes back no more than is in effect, so it
      // writes nothing back on that stretch, which keeps reading "no value".
      const { entity, span, b1, item } = await conflictOverB0();
      const v = await put(
        "entities",
        { entity, intent: "revoke", ver: verAt(b1), ...span },
        FOURTH,
      );
      expect(v.status).toBe("saved");
      expect((await detail(item)).reverted_by_previous).toEqual([]);
    },
    T,
  );

  it(
    "a conflict on existence: taking the merge base lifts the revoke in effect, which is listed",
    async () => {
      // b0 over [11-01, 11-10); USER revokes [11-05, 11-10); another principal revokes it from
      // before: a candidate on existence. The merge base has b0 there: taking it lifts USER's
      // revoke, and the stretch reads b0 again.
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        valid_to: "2026-11-10",
        set: { b: "b0" },
      });
      const entity = e.ops[0].target.entity as string;
      const span = { valid_from: "2026-11-05", valid_to: "2026-11-10" };
      const v = await put("entities", { entity, intent: "revoke", ver: verAt(e), ...span });
      const w = await put("entities", { entity, intent: "revoke", ver: verAt(e), ...span }, OTHER);
      const item = (w.pending as Any[] | undefined)?.find((q) => q.type === "conflict")
        ?.id as string;
      expect(item).toMatch(/^pi_/);
      expect(named({ impact: { reverted: (await detail(item)).reverted_by_previous } })).toEqual([
        { seq: v.seq, fields: ["*"] },
      ]);
    },
    T,
  );

  it(
    "only writes after the merge base are listed: one before it whose result changes too is not",
    async () => {
      // b0 over [11-01, 11-05); USER fills [11-05, 11-10) with b1 and writes c1 there; USER undoes
      // the fill (awaiting: it would hide c1) and it is confirmed: the stretch has no value. USER
      // fills it again with b5 (c1 shows again), and another principal writes b6 there from before
      // b5: a conflict item whose merge base is that confirmation. Taking the merge base leaves the
      // stretch without a value again: b5's result changes and so does c1's, but c1 was written
      // before the merge base; only b5 is listed.
      const e = await put("entities", {
        intent: "insert",
        valid_from: "2026-11-01",
        valid_to: "2026-11-05",
        set: { b: "b0" },
      });
      const entity = e.ops[0].target.entity as string;
      const span = { valid_from: "2026-11-05", valid_to: "2026-11-10" };
      const b1 = await put("entities", {
        entity,
        intent: "update",
        ver: verAt(e),
        ...span,
        set: { b: "b1" },
      });
      const c1 = await put("entities", {
        entity,
        intent: "update",
        ver: verAt(b1),
        ...span,
        set: { c: "c1" },
      });
      const u = await put("entities", { entity, revert: { undo: b1.seq }, ver: verAt(c1) });
      const awaiting = u.pending?.[0]?.id as string;
      expect(u.pending?.[0]?.type).toBe("awaiting_confirmation");
      const ok = (await resolve(s.store, ctxOf(THIRD), {
        id: awaiting,
        decision: "confirm",
        item_ver: (await detail(awaiting)).item_ver,
      } as never)) as Any;
      expect(ok.status).toBe("resolved");
      const base = ok.write.ops[0].ver as string;
      const b5 = await put("entities", {
        entity,
        intent: "update",
        ver: base,
        ...span,
        set: { b: "b5" },
      });
      const b6 = await put(
        "entities",
        { entity, intent: "update", ver: base, ...span, set: { b: "b6" } },
        OTHER,
      );
      const item = (b6.pending as Any[] | undefined)?.find((q) => q.type === "conflict")
        ?.id as string;
      expect(item).toMatch(/^pi_/);
      expect(named({ impact: { reverted: (await detail(item)).reverted_by_previous } })).toEqual([
        { seq: b5.seq, fields: ["b"] },
      ]);
    },
    T,
  );
});
