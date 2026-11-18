// Pending items through the write pipeline on PGlite (01-objects «待处理事项», «不过期：合并、取代与
// 刷新»; 09-event-format §5.8): the entries an item is opened with, and what a write that takes
// effect on an open item's unit within its interval does to it: refresh it when the writer had not
// read its current version, supersede it when it had. The reference comparison of the entries is
// write-items.prop.test.ts.
import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  history,
  pending as pending$,
  readBufferOf,
  readEvents,
  readTail,
  resolve as resolve$,
} from "@fluxvita/saveslot-kernel";
import {
  COMPILED_V1,
  createSlotEvents,
  queryInTx,
  resolveInTx,
  writeInTx,
} from "@fluxvita/saveslot-kernel/testing";
import { evaluateLog } from "@fluxvita/saveslot-reference";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 60_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const OTHER = `ci_${"2".repeat(26)}`;
/**
 * A principal as a receipt names it (04-contract-types §1.6): the tenant's user and a connection
 * these cases never register have no name in the log, so their ID stands in, as the reads give it.
 */
const asActor = (id: string) => ({ kind: "user", id, name: id });
const fields = [
  { id: "f2", name: "b", type: "text", required: true, description: "b" },
  { id: "f3", name: "c", type: "text", description: "c" },
  { id: "f4", name: "__proto__", type: "text", description: "a name that is not a key" },
];
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
      fields,
    },
    {
      id: "t3",
      name: "notes",
      kind: "base",
      description: "notes",
      time: { type: "none" },
      physical: { table: "t_t3_v1" },
      fields,
    },
    {
      id: "t2",
      name: "entities",
      kind: "base",
      description: "entities over time",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t2_v1" },
      fields,
    },
    {
      id: "t4",
      name: "moments",
      kind: "base",
      description: "entities over time, by instant",
      time: { type: "state", granularity: "instant" },
      physical: { table: "t_t4_v1" },
      fields,
    },
    {
      id: "t5",
      name: "loose",
      kind: "base",
      description: "entities over time, no field required",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t5_v1" },
      fields: [
        { id: "f2", name: "b", type: "text", description: "b" },
        { id: "f3", name: "c", type: "text", description: "c" },
      ],
    },
    {
      id: "t6",
      name: "gauges",
      kind: "base",
      description: "a quantity and a moment over time",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t6_v1" },
      fields: [
        {
          id: "f2",
          name: "amount",
          type: "quantity",
          required: true,
          description: "how far",
          unit: { code: "km", dimension: "length", to_base: "1000" },
          precision: { scale: 2, rounding: "half_up" },
        },
        { id: "f3", name: "at", type: "zoned_datetime", description: "when" },
      ],
    },
    {
      id: "t7",
      name: "free",
      kind: "base",
      description: "timeless, no field required",
      time: { type: "none" },
      physical: { table: "t_t7_v1" },
      fields: [
        { id: "f2", name: "b", type: "text", description: "b" },
        { id: "f3", name: "c", type: "text", description: "c" },
      ],
    },
  ],
};
const CHANGES = [
  { target: { slot: true }, change: "create_slot" },
  { target: { table: "t1" }, change: "add_table" },
  { target: { table: "t2" }, change: "add_table" },
  { target: { table: "t3" }, change: "add_table" },
  { target: { table: "t4" }, change: "add_table" },
  { target: { table: "t5" }, change: "add_table" },
  { target: { table: "t6" }, change: "add_table" },
  { target: { table: "t7" }, change: "add_table" },
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

/** Sends `params` through the pipeline as `actor`; the error, if refused. */
async function send(
  params: unknown,
  o: { actor?: string; task?: string | null; window?: number; keyWindow?: number } = {},
) {
  try {
    return await s.store.write((tx) =>
      writeInTx(tx, {
        actor: (o.actor ?? USER) as never,
        task: o.task ?? null,
        now: now(),
        windows: { requestKey: o.window ?? 600_000, idempotencyKey: o.keyWindow ?? 86_400_000 },
        visibility: { kind: "all" },
        params,
        newId,
        reads: readBufferOf(s.store),
      }),
    );
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { refused: x.code, ...(x.detail ?? {}) } as never;
  }
}

async function eventsOfOp(op: number) {
  return s.store.read(async (tx) =>
    (await readEvents(tx, op, (await readTail(tx))?.seq ?? op)).map((e) => ({
      type: e.header["type"],
      seq: Number(e.header["seq"]),
      blocks: Object.fromEntries(
        [...e.blocks].flatMap(([p, b]) => (b.state === "present" ? [[p, b.value]] : [])),
      ) as Record<string, unknown>,
    })),
  );
}

beforeAll(async () => {
  s = await openReusable("saveslot-write-cases-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  // The open store's buffered reads outlive a reset: a case must not see an earlier case's.
  readBufferOf(s.store).take();
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

const rowAt = (r: { readonly ops: readonly { readonly target: { readonly row?: string } }[] }) =>
  r.ops[0]?.target.row as string;
const verAt = (r: { readonly ops: readonly { readonly ver?: string }[] }) =>
  r.ops[0]?.ver as string;
const update = (
  row: string,
  set: Record<string, unknown>,
  ver: string,
  o: Parameters<typeof send>[1] = {},
) => send({ sv: 1, ops: [{ intent: "update", table: "rows", row, ver, set }] }, o);
const itemRow = async (id: string) =>
  (
    await s.store.read((tx) =>
      tx.query<{ state: string; version_op: unknown }>(
        "SELECT state, version_op FROM pending_items WHERE id = $1",
        [id],
      ),
    )
  ).rows.map((x) => ({ state: x.state, version_op: Number(x.version_op) }))[0];
/** The spans of an item's flag. */
const flagSpans = async (item: string) =>
  JSON.parse(
    (
      await s.store.read((tx) =>
        tx.query<{ spans: string }>("SELECT spans FROM flags WHERE item_id = $1", [item]),
      )
    ).rows[0]?.spans ?? "null",
  );
const ofType = async (op: number, type: string) =>
  (await eventsOfOp(op)).filter((e) => e.type === type);

/** 9 then 9.5 in effect (op b); a write of 10 seeing op a: a candidate on a conflict item. */
async function disputed() {
  const a = await send({ sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "9" } }] });
  const row = rowAt(a);
  const b = await update(row, { b: "9.5" }, verAt(a));
  const c = await update(row, { b: "10" }, verAt(a));
  const item = c.pending[0]?.id as string;
  return { a, b, c, row, item };
}

describe("a write reaching an open item", () => {
  it(
    "the writer had not read it (01-objects: 9.5 in effect, 10 a candidate, 9.6 written unread): refreshed, candidate 10 still there",
    async () => {
      const { a, b, row, item } = await disputed();
      // Another connection, which never saw the item, writes 9.6 on the version it read.
      const w = await update(row, { b: "9.6" }, verAt(b), { actor: OTHER });
      const [base] = await ofType(w.seq, "write.base");
      const [refreshed] = await ofType(w.seq, "item.refreshed");
      expect(refreshed?.blocks["target"]).toEqual({
        item,
        by_event: base?.seq,
        writer_had_read: false,
        cause: "target_overwritten",
        merge_base_op: a.seq,
      });
      // The current value is the new one; the merge base still 9 (take_previous returns to it).
      expect(refreshed?.blocks["current/0"]).toMatchObject({
        field: "f2",
        value: "9.6",
        op: w.seq,
      });
      expect(refreshed?.blocks["previous/0"]).toMatchObject({ field: "f2", value: "9" });
      // The item stays open, its version now this operation; nothing superseded.
      expect(await itemRow(item)).toEqual({ state: "open", version_op: w.seq });
      // The receipt lists it as refreshed, still pending.
      expect(w.pending).toEqual([
        { id: item, type: "conflict", reason: "stale_write", refreshed: true },
      ]);
      expect(w.superseded).toEqual([]);
      expect(await ofType(w.seq, "item.superseded")).toEqual([]);
      // Candidate 10 is still the item's: the next stale write joins after it.
      const j = await update(row, { b: "11" }, verAt(a));
      const merged = (await ofType(j.seq, "item.merged"))[0];
      expect(merged?.blocks["target"]).toMatchObject({ item });
      expect(Object.keys(merged?.blocks ?? {}).filter((p) => p.startsWith("candidates/"))).toEqual([
        "candidates/1",
      ]);
    },
    T,
  );

  it(
    "the writer had read its current version (its own receipt gave it whole): superseded",
    async () => {
      const { b, row, item } = await disputed();
      // The caller whose write opened the item writes again, on the version in effect.
      const w = await update(row, { b: "12" }, verAt(b));
      const [base] = await ofType(w.seq, "write.base");
      expect((await ofType(w.seq, "item.superseded")).map((e) => e.blocks)).toEqual([
        { target: { item, reason: "overwritten", by_event: base?.seq, writer_had_read: true } },
      ]);
      expect(await ofType(w.seq, "item.refreshed")).toEqual([]);
      expect((await itemRow(item))?.state).toBe("superseded");
    },
    T,
  );

  it(
    "the writer read its current version (a read of the item): superseded; a read of an older version does not count",
    async () => {
      const { b, c, row, item } = await disputed();
      const readItem = (op: number) =>
        readBufferOf(s.store).record({
          read: `rd_${String(op).padStart(16, "0")}` as never,
          actor: OTHER as never,
          task: null,
          at: now() as never,
          pos: 1 as never,
          operation: "pending",
          rows: [],
          coarse: [],
          lastRead: [{ kind: "item", target: item, op, restoreCount: 0 }],
        });
      // An older version read: not the current one, so the write refreshes it.
      readItem(c.seq - 1);
      const w1 = await update(row, { b: "9.6" }, verAt(b), { actor: OTHER });
      expect((await ofType(w1.seq, "item.refreshed")).length).toBe(1);
      // The refreshed version read: the next write supersedes it.
      readItem(w1.seq);
      const w2 = await update(row, { b: "9.7" }, verAt(w1), { actor: OTHER });
      const [base] = await ofType(w2.seq, "write.base");
      expect((await ofType(w2.seq, "item.superseded")).map((e) => e.blocks)).toEqual([
        { target: { item, reason: "overwritten", by_event: base?.seq, writer_had_read: true } },
      ]);
    },
    T,
  );

  it(
    "once refreshed the item has a new version: the writer of the opening receipt no longer counts as having read it",
    async () => {
      const { b, row, item } = await disputed();
      const w1 = await update(row, { b: "9.6" }, verAt(b), { actor: OTHER });
      const w2 = await update(row, { b: "9.7" }, verAt(w1));
      expect(
        (await ofType(w2.seq, "item.refreshed")).map(
          (e) => (e.blocks["target"] as { item: string }).item,
        ),
      ).toEqual([item]);
      expect(await ofType(w2.seq, "item.superseded")).toEqual([]);
    },
    T,
  );

  it(
    "a write on another field, or one that only becomes a candidate, does not reach the item",
    async () => {
      const { a, b, row, item } = await disputed();
      const other = await update(row, { c: "note" }, verAt(b), { actor: OTHER });
      expect(await ofType(other.seq, "item.refreshed")).toEqual([]);
      const stale = await update(row, { b: "13" }, verAt(a), { actor: OTHER });
      expect(await ofType(stale.seq, "item.refreshed")).toEqual([]);
      expect(await ofType(stale.seq, "item.superseded")).toEqual([]);
      expect((await itemRow(item))?.state).toBe("open");
    },
    T,
  );

  it(
    "a state table: a write outside the item's interval does not reach it; one inside does",
    async () => {
      const e = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "x" } }],
      });
      const entity = e.ops[0]?.target.entity as string;
      const put = (b: string, from: string, to: string, ver: string, actor = USER) =>
        send(
          {
            sv: 1,
            ops: [
              {
                intent: "update",
                table: "entities",
                entity,
                ver,
                valid_from: from,
                valid_to: to,
                set: { b },
              },
            ],
          },
          { actor },
        );
      const y = await put("y", "2026-11-05", "2026-11-07", verAt(e));
      const z = await put("z", "2026-11-05", "2026-11-07", verAt(e));
      const item = z.pending[0]?.id as string;
      const outside = await put("w", "2026-11-10", "2026-11-12", verAt(y), OTHER);
      expect(await ofType(outside.seq, "item.refreshed")).toEqual([]);
      // Over the item's interval exactly: no change point erased, so it takes effect (not awaiting).
      const inside = await put("v", "2026-11-05", "2026-11-07", verAt(outside), OTHER);
      expect(
        (await ofType(inside.seq, "item.refreshed")).map(
          (x) => (x.blocks["target"] as { item: string }).item,
        ),
      ).toEqual([item]);
    },
    T,
  );
});

describe("an awaiting item kept in the log", () => {
  it(
    "a later request reaching it within its interval refreshes it: its proposal is read back from the write that opened it",
    async () => {
      // An entity; [11-03, 11-05) revoked, then restored by undoing the revoke; a write in that
      // stretch; undoing the restore would hide it (high impact): awaiting, an item on existence
      // over [11-03, 11-05).
      const e = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "x" } }],
      });
      const entity = e.ops[0]?.target.entity as string;
      const op = (extra: Record<string, unknown>, ver: string | undefined, actor = USER) =>
        send(
          {
            sv: 1,
            ops: [{ table: "entities", entity, ...(ver !== undefined ? { ver } : {}), ...extra }],
          },
          { actor },
        );
      const span = { valid_from: "2026-11-03", valid_to: "2026-11-05" };
      const v = await op({ intent: "revoke", ...span }, verAt(e));
      const r = await op({ revert: { undo: v.seq } }, undefined);
      const w = await op({ intent: "update", ...span, set: { c: "later" } }, verAt(r));
      const u = await op({ revert: { undo: r.seq } }, undefined);
      expect(u.pending[0]?.type).toBe("awaiting_confirmation");
      const item = u.pending[0]?.id as string;
      const impactOf = async (n: number) =>
        Object.entries((await ofType(n, "item.refreshed"))[0]?.blocks ?? {})
          .filter(([p]) => p.startsWith("impact/"))
          .map(([, b]) => b as { kind: string; op?: number });
      // A later write in the stretch: undoing the restore would hide it too. It changes no value
      // on existence, so it reaches nothing; the impact, judged again, now names it as well.
      const x = await op({ intent: "update", ...span, set: { c: "later still" } }, verAt(w), OTHER);
      const [changed] = await ofType(x.seq, "item.refreshed");
      expect(changed?.blocks["target"]).toMatchObject({ item, cause: "entries_changed" });
      expect(
        (await impactOf(x.seq)).filter((b) => b.kind === "reverted_write").map((b) => b.op),
      ).toEqual([w.seq, x.seq]);
      // Another request, outside the interval: not reached. Then one revoking inside it: reached.
      const outside = await op(
        { intent: "revoke", valid_from: "2026-11-10", valid_to: "2026-11-12" },
        verAt(x),
        OTHER,
      );
      expect(await ofType(outside.seq, "item.refreshed")).toEqual([]);
      // Revoked inside, the later writes are hidden already and the stretch is revoked: undoing the
      // restore would write nothing and hide nothing more. The item is closed, superseded by that
      // revoke (04-write-and-read «撤回某次写入（undo）»), not refreshed.
      const inside = await op({ intent: "revoke", ...span }, verAt(outside), OTHER);
      expect(await ofType(inside.seq, "item.refreshed")).toEqual([]);
      const [closed] = await ofType(inside.seq, "item.superseded");
      expect(closed?.blocks["target"]).toEqual({
        item,
        reason: "nothing_to_revert",
        by_event: expect.any(Number),
      });
      expect((await itemRow(item))?.state).toBe("superseded");
    },
    T,
  );
});

describe("the entries an item is opened with", () => {
  it(
    "a conflict item: its interval, the values now and at the merge base, what take_previous takes back and the candidate overwrites",
    async () => {
      const e = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "x" } }],
      });
      const entity = e.ops[0]?.target.entity as string;
      const put = (b: string, ver: string) =>
        send({
          sv: 1,
          ops: [
            {
              intent: "update",
              table: "entities",
              entity,
              ver,
              valid_from: "2026-11-05",
              valid_to: "2026-11-07",
              set: { b },
            },
          ],
        });
      const y = await put("y", verAt(e));
      const z = await put("z", verAt(e));
      const [created] = await ofType(z.seq, "item.created");
      const blocks = created?.blocks ?? {};
      // Subset matches on `deps` only: which contributions cut a stretch is judge's to say; the
      // value-giving item must be among them.
      expect(blocks["scope_valid"]).toMatchObject({
        spans: [{ from: "2026-11-05", to: "2026-11-07" }],
      });
      expect(blocks["current/0"]).toMatchObject({
        field: "f2",
        value: "y",
        valid: { from: "2026-11-05", to: "2026-11-07" },
        op: y.seq,
      });
      expect((blocks["current/0"] as { deps: unknown[] }).deps).toContainEqual({
        event: y.seq + 2,
        field: "f2",
        k: 0,
      });
      expect(blocks["previous/0"]).toMatchObject({
        field: "f2",
        value: "x",
        valid: { from: "2026-11-05", to: "2026-11-07" },
      });
      expect(blocks["previous/0"]).not.toHaveProperty("op");
      expect(
        Object.entries(blocks)
          .filter(([p]) => p.startsWith("impact/"))
          .map(([, v]) => v),
      ).toEqual([expect.objectContaining({ kind: "reverted_write", op: y.seq })]);
      // Taking z keeps both change points (x | z | x): not high impact, nothing listed as
      // overwritten. With q from 11-07 on (x | y | q), a stale q on [11-05, 11-07) would erase the
      // point at 11-07 (x | q | q): what it overwrites is listed, naming that candidate among its
      // deps, and its receipt gives it as the candidate's impact.
      const q = await send({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "entities",
            entity,
            ver: verAt(y),
            valid_from: "2026-11-07",
            set: { b: "q" },
          },
        ],
      });
      expect(q.ops[0]?.fields["b"]).toMatchObject([{ result: "applied" }]);
      const w = await put("q", verAt(e));
      const [merged] = await ofType(w.seq, "item.merged");
      const impact = Object.entries(merged?.blocks ?? {})
        .filter(([p]) => p.startsWith("impact/"))
        .map(([, v]) => v as { kind: string; deps: { event: number }[] });
      expect(impact).toEqual([
        expect.objectContaining({
          kind: "overwritten_segment",
          field: "f2",
          value: "y",
          op: y.seq,
          valid: { from: "2026-11-05", to: "2026-11-07" },
        }),
        expect.objectContaining({ kind: "reverted_write", op: y.seq }),
      ]);
      expect(impact[0]?.deps.map((d) => d.event)).toContain(w.seq + 2);
      const partsOf = (r: typeof w) =>
        (r.ops[0]?.fields["b"] ?? []) as readonly { impact?: unknown }[];
      expect(partsOf(w)[0]?.impact).toEqual({
        overwritten: [
          {
            field: "b",
            valid: {
              valid_from: "2026-11-05",
              valid_to: "2026-11-07",
              valid_to_inclusive: "2026-11-06",
            },
            value: "y",
            seq: y.seq,
            actor: asActor(USER),
          },
        ],
      });
      expect(partsOf(z)[0]).not.toHaveProperty("impact");
    },
    T,
  );

  it(
    "two touching stretches of one value from two writes: two entries, each with its own write",
    async () => {
      const e = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "x" } }],
      });
      const entity = e.ops[0]?.target.entity as string;
      const put = (b: string, from: string, to: string, ver: string) =>
        send({
          sv: 1,
          ops: [
            {
              intent: "update",
              table: "entities",
              entity,
              ver,
              valid_from: from,
              valid_to: to,
              acknowledge: ["overwrite"],
              set: { b },
            },
          ],
        });
      const y1 = await put("y", "2026-11-03", "2026-11-05", verAt(e));
      const y2 = await put("y", "2026-11-05", "2026-11-07", verAt(y1));
      expect(y2.status).toBe("saved");
      const z = await put("z", "2026-11-03", "2026-11-07", verAt(e));
      const [created] = await ofType(z.seq, "item.created");
      const current = Object.entries(created?.blocks ?? {})
        .filter(([p]) => p.startsWith("current/"))
        .map(([, v]) => v as { value: unknown; valid: unknown; op: number });
      expect(current.map((x) => [x.value, x.valid, x.op])).toEqual([
        ["y", { from: "2026-11-03", to: "2026-11-05" }, y1.seq],
        ["y", { from: "2026-11-05", to: "2026-11-07" }, y2.seq],
      ]);
    },
    T,
  );

  it(
    "where the entity has no value (a required field emptied), an optional field's value is not current",
    async () => {
      const e = await send({
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "entities",
            valid_from: "2026-11-01",
            valid_to: "2026-11-05",
            set: { b: "x" },
          },
        ],
      });
      const entity = e.ops[0]?.target.entity as string;
      const put = (set: Record<string, string>, from: string, ver: string) =>
        send({
          sv: 1,
          ops: [
            {
              intent: "update",
              table: "entities",
              entity,
              ver,
              valid_from: from,
              valid_to: "open",
              set,
            },
          ],
        });
      // b fills [11-05, ∞); c is written there after it; undoing b's fill leaves c alone in a gap.
      const b = await put({ b: "x2" }, "2026-11-05", verAt(e));
      const c = await put({ c: "m" }, "2026-11-05", verAt(b));
      const u = await send({
        sv: 1,
        ops: [
          {
            table: "entities",
            entity,
            ver: verAt(c),
            acknowledge: ["overwrite"],
            revert: { undo: b.seq },
          },
        ],
      });
      expect(u.status).toBe("saved");
      // A stale write on c over the gap: a candidate whose interval has no value now.
      const z = await put({ c: "z" }, "2026-11-05", verAt(b));
      const [created] = await ofType(z.seq, "item.created");
      expect(created).toBeDefined();
      const current = Object.entries(created?.blocks ?? {}).filter(([p]) =>
        p.startsWith("current/"),
      );
      expect(current).toEqual([]);
      expect(c.seq).toBeGreaterThan(b.seq);
    },
    T,
  );

  it(
    "an item on existence (a stale write meeting a revoke): the revoked stretch, no field values",
    async () => {
      const a = await send({ sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "x" } }] });
      const row = rowAt(a);
      const v = await send({
        sv: 1,
        ops: [{ intent: "revoke", table: "rows", row, ver: verAt(a) }],
      });
      const stale = await update(row, { b: "y" }, verAt(a));
      const [created] = await ofType(stale.seq, "item.created");
      expect(created?.blocks["target"]).toMatchObject({ unit: ["existence"] });
      expect(created?.blocks["current/0"]).toMatchObject({
        field: "existence",
        revoked: true,
        op: v.seq,
      });
      expect(created?.blocks["current/0"]).not.toHaveProperty("value");
      // At the merge base the row had a value: a stretch with one, no revoke, no op.
      expect(created?.blocks["previous/0"]).toEqual({
        field: "existence",
        deps: expect.arrayContaining([expect.objectContaining({ field: "f2" })]),
      });
      expect(created?.blocks["previous/1"]).toBeUndefined();
      // take_previous would take the revoke back.
      expect(
        Object.entries(created?.blocks ?? {})
          .filter(([p]) => p.startsWith("impact/"))
          .map(([, v]) => v),
      ).toContainEqual(expect.objectContaining({ kind: "reverted_write", op: v.seq }));
    },
    T,
  );
});

describe("one request, one set of contents an item (01-objects «不过期»)", () => {
  const fresh = (row: string, b: string, ver: string) => ({
    intent: "update",
    table: "rows",
    row,
    ver,
    set: { b },
  });

  it(
    "two ops reaching an item, 9.6 then 9.7: one refresh, after both, with 9.7",
    async () => {
      const { a, b, row, item } = await disputed();
      const params = { sv: 1, ops: [fresh(row, "9.6", verAt(b)), fresh(row, "9.7", verAt(b))] };
      const w = await send(params, { actor: OTHER });
      const bases = await ofType(w.seq, "write.base");
      const refreshed = await ofType(w.seq, "item.refreshed");
      expect(refreshed.length).toBe(1);
      expect(refreshed[0]?.blocks["target"]).toEqual({
        item,
        by_event: bases[1]?.seq,
        writer_had_read: false,
        cause: "target_overwritten",
        merge_base_op: a.seq,
      });
      // The value the request ends with, given by the op that wrote it.
      expect(refreshed[0]?.blocks["current/0"]).toEqual({
        field: "f2",
        value: "9.7",
        op: w.seq,
        deps: [{ event: bases[1]?.seq, field: "f2", k: 0 }],
      });
      // Every event of the request comes before the refresh.
      expect((refreshed[0]?.seq ?? 0) > (bases[1]?.seq ?? 0)).toBe(true);
      expect(w.pending).toEqual([
        { id: item, type: "conflict", reason: "stale_write", refreshed: true },
      ]);
      // A replay gives the item's state now with it.
      const again = await send(params, { actor: OTHER });
      expect(again.pending).toEqual([
        { id: item, type: "conflict", reason: "stale_write", refreshed: true, state: "open" },
      ]);
    },
    T,
  );

  it(
    "an item opened by an op and reached by a later one: its entries as the request ends, no refresh",
    async () => {
      const a = await send({ sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "1" } }] });
      const row = rowAt(a);
      const b = await update(row, { b: "2" }, verAt(a));
      const w = await send({ sv: 1, ops: [fresh(row, "10", verAt(a)), fresh(row, "3", verAt(b))] });
      const [created] = await ofType(w.seq, "item.created");
      expect(created?.blocks["current/0"]).toMatchObject({ field: "f2", value: "3", op: w.seq });
      expect(await ofType(w.seq, "item.refreshed")).toEqual([]);
      const item = created?.blocks["target"] as { item: string };
      expect(w.pending).toEqual([
        {
          id: item.item,
          type: "conflict",
          reason: "stale_write",
          item_ver: `iv_${item.item.slice(3)}.${w.seq}.0`,
        },
      ]);
      expect(w.ops[0]?.fields["b"]).toMatchObject({
        result: "candidate",
        effective: "3",
        by: { seq: w.seq },
      });
    },
    T,
  );

  it(
    "an item the request joined and then reached: refreshed even by a writer that had read it",
    async () => {
      const { a, b, row, item } = await disputed();
      // USER's own receipt opened the item: read. Joining it in this request is not reading the
      // joined version, so reaching it after is a refresh.
      const w = await send({
        sv: 1,
        ops: [fresh(row, "11", verAt(a)), fresh(row, "12", verAt(b))],
      });
      expect((await ofType(w.seq, "item.merged")).length).toBe(1);
      expect(await ofType(w.seq, "item.superseded")).toEqual([]);
      const [refreshed] = await ofType(w.seq, "item.refreshed");
      expect(refreshed?.blocks["target"]).toMatchObject({ item, cause: "target_overwritten" });
      expect(w.pending).toEqual([
        { id: item, type: "conflict", reason: "stale_write", merged: true, refreshed: true },
      ]);
      expect(w.superseded).toEqual([]);
    },
    T,
  );

  it(
    "an item no op reached whose entries changed: refreshed, entries_changed, reads not looked at",
    async () => {
      // A revoke of [11-05, 11-07), a stale write meeting it: an item on existence. A second
      // revoke of the same stretch changes no value there, so it reaches nothing; the entry now
      // names the second revoke.
      const e = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "x" } }],
      });
      const entity = e.ops[0]?.target.entity as string;
      const revoke = (ver: string) =>
        send({
          sv: 1,
          ops: [
            {
              intent: "revoke",
              table: "entities",
              entity,
              ver,
              valid_from: "2026-11-05",
              valid_to: "2026-11-07",
            },
          ],
        });
      const r1 = await revoke(verAt(e));
      const stale = await send({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "entities",
            entity,
            ver: verAt(e),
            valid_from: "2026-11-05",
            valid_to: "2026-11-07",
            set: { b: "y" },
          },
        ],
      });
      const item = stale.pending[0]?.id as string;
      const r2 = await revoke(verAt(r1));
      const [base] = await ofType(r2.seq, "write.base");
      const [refreshed] = await ofType(r2.seq, "item.refreshed");
      expect(refreshed?.blocks["target"]).toEqual({
        item,
        by_event: base?.seq,
        cause: "entries_changed",
        merge_base_op: e.seq,
      });
      expect(refreshed?.blocks["current/0"]).toMatchObject({
        field: "existence",
        revoked: true,
        op: r2.seq,
      });
      expect(r2.pending).toEqual([
        { id: item, type: "conflict", reason: "stale_write", refreshed: true },
      ]);
    },
    T,
  );
});

describe("which item a candidate joins, and the items' spans (01-objects «目标与合并»)", () => {
  it(
    "candidates apart open items apart; one meeting both joins the earlier; its spans stay apart",
    async () => {
      const e = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "x" } }],
      });
      const entity = e.ops[0]?.target.entity as string;
      const put = (b: string, ver: string, from: string, to: string) =>
        send({
          sv: 1,
          ops: [
            {
              intent: "update",
              table: "entities",
              entity,
              ver,
              valid_from: from,
              valid_to: to,
              set: { b },
            },
          ],
        });
      const y = await put("y", verAt(e), "2026-11-05", "2026-11-07");
      const w = await put("w", verAt(y), "2026-11-12", "2026-11-14");
      const z1 = await put("z1", verAt(e), "2026-11-05", "2026-11-07");
      const z2 = await put("z2", verAt(e), "2026-11-12", "2026-11-14");
      const first = z1.pending[0]?.id as string;
      const second = z2.pending[0]?.id as string;
      expect(second).not.toBe(first);
      expect(z2.pending[0]?.item_ver).toBeDefined();
      const [c2] = await ofType(z2.seq, "item.created");
      expect(c2?.blocks["scope_valid"]).toMatchObject({
        spans: [{ from: "2026-11-12", to: "2026-11-14" }],
      });
      // A candidate across both stretches meets both items: it joins the earlier one only (the
      // judge makes the whole write one candidate item on [11-05, 11-14)).
      const z3 = await put("z3", verAt(e), "2026-11-05", "2026-11-14");
      const merged = await ofType(z3.seq, "item.merged");
      expect(merged.map((m) => (m.blocks["target"] as { item: string }).item)).toEqual([first]);
      expect(merged[0]?.blocks["scope_valid"]).toMatchObject({
        spans: [{ from: "2026-11-05", to: "2026-11-14" }],
      });
      // The joined candidate's receipt reads the item's current entries (an item.merged gives
      // `current` of its own here): the latest write giving a value, and the value it gave.
      expect(z3.ops[0]?.fields["b"]).toMatchObject([
        { result: "candidate", item: first, effective: "w", by: { seq: w.seq } },
      ]);
      expect(await flagSpans(first)).toEqual([{ from: "2026-11-05", to: "2026-11-14" }]);
      expect(await flagSpans(second)).toEqual([{ from: "2026-11-12", to: "2026-11-14" }]);
    },
    T,
  );
});

describe("the merge base (01-objects «冲突事项的内容»)", () => {
  it(
    "a later candidate seeing a newer version leaves it at the earliest seen; rebuilt from the log, a join's lowered one holds",
    async () => {
      const { a, b, row, item } = await disputed();
      const d = await update(row, { b: "9.7" }, verAt(b), { actor: OTHER });
      // Seeing b (9.5), now stale: joins, the merge base stays a.
      const j1 = await update(row, { b: "11" }, verAt(b), { actor: OTHER });
      const [m1] = await ofType(j1.seq, "item.merged");
      expect(m1?.blocks["target"]).toMatchObject({ item, merge_base_op: a.seq });
      expect(d.pending[0]?.refreshed).toBe(true);
    },
    T,
  );

  it(
    "an item opened at a newer version, joined by an older one: lowered; a later join keeps it",
    async () => {
      const a = await send({ sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "1" } }] });
      const row = rowAt(a);
      const b = await update(row, { b: "2" }, verAt(a));
      const c = await update(row, { b: "3" }, verAt(b));
      const opened = await update(row, { b: "4" }, verAt(b), { actor: OTHER });
      const item = opened.pending[0]?.id as string;
      const [created] = await ofType(opened.seq, "item.created");
      expect(created?.blocks["target"]).toMatchObject({ merge_base_op: b.seq });
      const older = await update(row, { b: "5" }, verAt(a), { actor: OTHER });
      const [m1] = await ofType(older.seq, "item.merged");
      expect(m1?.blocks["target"]).toMatchObject({ item, merge_base_op: a.seq });
      // A new request reads the item from the log: the merge base it holds is a, not b.
      const again = await update(row, { b: "6" }, verAt(b), { actor: OTHER });
      const [m2] = await ofType(again.seq, "item.merged");
      expect(m2?.blocks["target"]).toMatchObject({ item, merge_base_op: a.seq });
      expect(c.seq).toBeGreaterThan(b.seq);
    },
    T,
  );
});

describe("items on existence", () => {
  it(
    "on an event table: a revoke undone reaches it; a stale revoke's receipt names who gave the row",
    async () => {
      const a = await send({ sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "1" } }] });
      const row = rowAt(a);
      const b = await update(row, { b: "2" }, verAt(a), { actor: OTHER });
      // A revoke seeing a, after b changed the row: a candidate on existence.
      const stale = await send({
        sv: 1,
        ops: [{ intent: "revoke", table: "rows", row, ver: verAt(a) }],
      });
      const item = stale.pending[0]?.id as string;
      const [created] = await ofType(stale.seq, "item.created");
      expect(created?.blocks["target"]).toMatchObject({ unit: ["existence"] });
      expect(created?.blocks["current/0"]).toEqual({
        field: "existence",
        deps: [{ event: b.seq + 2, field: "f2", k: 0 }],
      });
      expect(stale.ops[0]?.fields["*"]).toMatchObject({
        result: "candidate",
        effective: null,
        by: { seq: b.seq, actor: asActor(OTHER) },
        previous: { seq: a.seq, exists: true },
      });
      // Revoked by OTHER, then the revoke undone: the row has a value again, reached each time.
      const v = await send(
        { sv: 1, ops: [{ intent: "revoke", table: "rows", row, ver: verAt(b) }] },
        { actor: OTHER },
      );
      expect(v.pending).toEqual([
        { id: item, type: "conflict", reason: "stale_write", refreshed: true },
      ]);
      const u = await send(
        { sv: 1, ops: [{ table: "rows", row, revert: { undo: v.seq } }] },
        { actor: OTHER },
      );
      expect(u).not.toHaveProperty("refused");
      const [refreshed] = await ofType(u.seq, "item.refreshed");
      expect(refreshed?.blocks["target"]).toMatchObject({ item, cause: "target_overwritten" });
    },
    T,
  );

  it(
    "on a state table: the candidate's receipt says where the row had a value at the merge base",
    async () => {
      const e = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "x" } }],
      });
      const entity = e.ops[0]?.target.entity as string;
      const v = await send({
        sv: 1,
        ops: [
          {
            intent: "revoke",
            table: "entities",
            entity,
            ver: verAt(e),
            valid_from: "2026-11-05",
            valid_to: "2026-11-07",
          },
        ],
      });
      const stale = await send({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "entities",
            entity,
            ver: verAt(e),
            valid_from: "2026-11-05",
            valid_to: "2026-11-07",
            set: { b: "y" },
          },
        ],
      });
      const parts = stale.ops[0]?.fields["b"] as unknown as readonly Record<string, unknown>[];
      expect(parts.find((p) => p["result"] === "candidate")).toMatchObject({
        effective: null,
        by: { seq: v.seq },
        previous: { seq: e.seq, exists: true },
      });
    },
    T,
  );
});

describe("receipts by field name", () => {
  it(
    "a field named __proto__ is a key of its own in the receipt",
    async () => {
      const r = await send(
        JSON.parse(
          '{"sv":1,"ops":[{"intent":"insert","table":"rows","set":{"b":"x","__proto__":"p"}}]}',
        ),
      );
      expect(Object.hasOwn(r.ops[0]?.fields ?? {}, "__proto__")).toBe(true);
      expect(Object.getOwnPropertyDescriptor(r.ops[0]?.fields, "__proto__")?.value).toEqual({
        result: "applied",
        after: "p",
      });
    },
    T,
  );
});

describe("refreshes, round two (09-event-format §5.8 «一次请求里的事项内容»)", () => {
  it(
    "once refreshed, a write to another field, to another row, or not reaching it leaves it alone",
    async () => {
      const { b, row, item } = await disputed();
      const w = await update(row, { b: "9.6" }, verAt(b), { actor: OTHER });
      expect((await ofType(w.seq, "item.refreshed")).length).toBe(1);
      const version = (await itemRow(item))?.version_op;
      const other = await update(row, { c: "note" }, verAt(w), { actor: OTHER });
      const again = await update(row, { c: "note2" }, verAt(other), { actor: OTHER });
      const elsewhere = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "rows", set: { b: "else" } }],
      });
      for (const r of [other, again, elsewhere]) {
        expect(await ofType(r.seq, "item.refreshed")).toEqual([]);
        expect(r.pending).toEqual([]);
      }
      expect(await itemRow(item)).toEqual({ state: "open", version_op: version });
    },
    T,
  );

  const fresh = (row: string, set: Record<string, unknown>, ver: string) => ({
    intent: "update",
    table: "rows",
    row,
    ver,
    set,
  });

  it(
    "by_event is the last op that changed the unit: not one writing another field, not a candidate",
    async () => {
      const { a, b, row, item } = await disputed();
      const byEvent = async (r: { seq: number }) =>
        (
          (await ofType(r.seq, "item.refreshed"))[0]?.blocks["target"] as
            | { by_event: number }
            | undefined
        )?.by_event;
      const bases = async (r: { seq: number }) =>
        (await ofType(r.seq, "write.base")).map((e) => e.seq);
      // 9.6, then another field: the first op.
      const r1 = await send(
        { sv: 1, ops: [fresh(row, { b: "9.6" }, verAt(b)), fresh(row, { c: "n" }, verAt(b))] },
        { actor: OTHER },
      );
      expect(await byEvent(r1)).toBe((await bases(r1))[0]);
      // 12 in effect, then 11 seeing a: a candidate joining the item; the first op.
      const r2 = await send(
        { sv: 1, ops: [fresh(row, { b: "12" }, verAt(r1)), fresh(row, { b: "11" }, verAt(a))] },
        { actor: OTHER },
      );
      expect(await byEvent(r2)).toBe((await bases(r2))[0]);
      // 9.7 then back to 12: both change it, the last one counts.
      const r3 = await send(
        { sv: 1, ops: [fresh(row, { b: "9.7" }, verAt(r2)), fresh(row, { b: "12" }, verAt(r2))] },
        { actor: OTHER },
      );
      expect(await byEvent(r3)).toBe((await bases(r3))[1]);
      expect(item).toBeDefined();
    },
    T,
  );

  it(
    "a join with no op reaching the item: item.merged with the current values, no refresh; listed as merged",
    async () => {
      const { a, row, item } = await disputed();
      const j = await update(row, { b: "11" }, verAt(a), { actor: OTHER });
      const [merged] = await ofType(j.seq, "item.merged");
      expect(merged?.blocks["current/0"]).toMatchObject({ field: "f2", value: "9.5" });
      expect(await ofType(j.seq, "item.refreshed")).toEqual([]);
      expect(j.pending).toEqual([
        { id: item, type: "conflict", reason: "stale_write", merged: true },
      ]);
    },
    T,
  );

  it(
    "a writer that joined the item and then reached it in one request had not read it, whatever the order",
    async () => {
      const { a, b, row, item } = await disputed();
      // USER's own receipt opened the item. Reach first, then join.
      const w = await send({
        sv: 1,
        ops: [fresh(row, { b: "12" }, verAt(b)), fresh(row, { b: "11" }, verAt(a))],
      });
      expect(await ofType(w.seq, "item.superseded")).toEqual([]);
      const [refreshed] = await ofType(w.seq, "item.refreshed");
      expect(refreshed?.blocks["target"]).toMatchObject({
        item,
        cause: "target_overwritten",
        writer_had_read: false,
      });
    },
    T,
  );

  it(
    "two revokes side by side are two entries, each naming its own",
    async () => {
      const e = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "x" } }],
      });
      const entity = e.ops[0]?.target.entity as string;
      const revoke = (ver: string, from: string, to: string) =>
        send({
          sv: 1,
          ops: [
            { intent: "revoke", table: "entities", entity, ver, valid_from: from, valid_to: to },
          ],
        });
      const r1 = await revoke(verAt(e), "2026-11-03", "2026-11-05");
      const r2 = await revoke(verAt(r1), "2026-11-05", "2026-11-07");
      const stale = await send({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "entities",
            entity,
            ver: verAt(e),
            valid_from: "2026-11-03",
            valid_to: "2026-11-07",
            set: { b: "y" },
          },
        ],
      });
      const [created] = await ofType(stale.seq, "item.created");
      const current = Object.entries(created?.blocks ?? {})
        .filter(([p]) => p.startsWith("current/"))
        .map(([, b]) => b as { revoked?: true; op?: number; valid?: unknown });
      expect(current.filter((c) => c.revoked)).toEqual([
        expect.objectContaining({ op: r1.seq, valid: { from: "2026-11-03", to: "2026-11-05" } }),
        expect.objectContaining({ op: r2.seq, valid: { from: "2026-11-05", to: "2026-11-07" } }),
      ]);
    },
    T,
  );

  it(
    "a table by instant: intervals in the receipt without valid_to_inclusive",
    async () => {
      const r = await send({
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "moments",
            valid_from: "2026-11-01T08:00:00.000Z",
            valid_to: "2026-11-01T10:00:00.000Z",
            set: { b: "x" },
          },
        ],
      });
      expect(r.ops[0]?.fields["b"]).toEqual([
        {
          result: "applied",
          after: "x",
          valid: { valid_from: "2026-11-01T08:00:00.000Z", valid_to: "2026-11-01T10:00:00.000Z" },
        },
      ]);
    },
    T,
  );

  it(
    "the writer's own receipt counts as read only with no restore since",
    async () => {
      const { b, row, item } = await disputed();
      // A restore after the receipt (appended only: its apply comes with restores).
      await s.store.write(async (tx) => {
        const tail = (await readTail(tx))?.seq ?? 0;
        await appendOperation(tx, {
          actor: "system" as never,
          now: "2026-11-05T09:00:00.000Z" as never,
          events: [
            {
              type: "tenant.restored",
              trigger: "restore",
              node_id: `n_${"5".repeat(26)}`,
              restore_id: `rs_${"9".repeat(16)}`,
              restore_count: 1,
              restored_to: tail,
              high_water: tail,
              blocks: {},
            } as never,
          ],
        });
      });
      const w = await update(row, { b: "12" }, `v${b.seq}.1`);
      expect(w).not.toHaveProperty("refused");
      expect(await ofType(w.seq, "item.superseded")).toEqual([]);
      const [refreshed] = await ofType(w.seq, "item.refreshed");
      expect(refreshed?.blocks["target"]).toMatchObject({ item, cause: "target_overwritten" });
    },
    T,
  );

  it(
    "a row with an open flagged item: the write stops, not implemented, nothing written",
    async () => {
      const a = await send({ sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "1" } }] });
      const row = rowAt(a);
      // Flagged items come with duplicate detection: one put in place here.
      await s.store.write((tx) =>
        tx.query(
          `INSERT INTO pending_items (id, type, slot_id, target_table, target_row, state, version_op)
           VALUES ('pi_9999999999999999', 'flagged', NULL, 't1', $1, 'open', $2)`,
          [row, a.seq],
        ),
      );
      const before = (await s.store.read(readTail))?.seq;
      expect(await update(row, { b: "2" }, verAt(a))).toMatchObject({
        refused: "internal",
        reason: "not_implemented",
      });
      expect((await s.store.read(readTail))?.seq).toBe(before);
    },
    T,
  );
});

describe("a candidate's by and effective: the write that gave what it met (04-contract-types FieldResult)", () => {
  /** What query reads of the entities table at a day. */
  const readAt = async (day: string) =>
    (
      await s.store.read((tx) =>
        queryInTx(tx, {
          actor: USER as never,
          task: null,
          now: "2026-11-05T12:00:00.000Z" as never,
          visibility: { kind: "all" },
          params: { table: "entities", valid_at: day },
          read: "rd_0000000000000000" as never,
        }),
      )
    ).result.rows.map((x) => x.values["b"]);
  const scenario = async (revoke: boolean) => {
    const put = (o: Record<string, unknown>, actor = USER) =>
      send({ sv: 1, ops: [{ table: "entities", ...o }] }, { actor });
    const e = await send({
      sv: 1,
      ops: [
        {
          intent: "insert",
          table: "entities",
          valid_from: "2026-11-01",
          valid_to: "2026-11-20",
          set: { b: "x" },
        },
      ],
    });
    const entity = e.ops[0]?.target.entity as string;
    const y = await put(
      {
        intent: "update",
        entity,
        ver: verAt(e),
        valid_from: "2026-11-10",
        valid_to: "2026-11-20",
        set: { b: "y" },
      },
      OTHER,
    );
    const v = revoke
      ? await put(
          {
            intent: "revoke",
            entity,
            ver: verAt(y),
            valid_from: "2026-11-05",
            valid_to: "2026-11-08",
          },
          OTHER,
        )
      : undefined;
    const z = await put({
      intent: "update",
      entity,
      ver: verAt(e),
      valid_from: "2026-11-03",
      valid_to: "2026-11-25",
      set: { b: "z" },
    });
    const part = (z.ops[0]?.fields["b"] ?? []) as readonly {
      result: string;
      effective?: unknown;
      by?: { seq: number; actor: unknown };
    }[];
    return { y, v, z, candidate: part.find((x) => x.result === "candidate") };
  };

  it(
    "on existence, the latest giver a revoke: by is the revoke, effective none, and query reads no row there",
    async () => {
      const { v, candidate } = await scenario(true);
      expect(candidate).toMatchObject({
        effective: null,
        by: { seq: v?.seq, actor: asActor(OTHER) },
      });
      expect(await readAt("2026-11-06")).toEqual([]);
    },
    T,
  );

  it(
    "the latest giver a write: by is that write, effective its value, as query reads it there",
    async () => {
      const { y, candidate } = await scenario(false);
      expect(candidate).toMatchObject({
        effective: "y",
        by: { seq: y.seq, actor: asActor(OTHER) },
      });
      expect(await readAt("2026-11-12")).toEqual([candidate?.effective]);
    },
    T,
  );
});

/** An entity on the state table from 11-01, with `set`. */
const entityWith = async (set: Record<string, unknown>) => {
  const e = await send({
    sv: 1,
    ops: [{ intent: "insert", table: "entities", valid_from: "2026-11-01", set }],
  });
  return { e, entity: e.ops[0]?.target.entity as string };
};
const on = (entity: string, op: Record<string, unknown>, actor = USER) =>
  send({ sv: 1, ops: [{ table: "entities", entity, ...op }] }, { actor });
const blocksOf = (blocks: Record<string, unknown> | undefined, prefix: string) =>
  Object.entries(blocks ?? {})
    .filter(([p]) => p.startsWith(`${prefix}/`))
    .map(([, v]) => v as Record<string, unknown>);
const partsOf = (r: { ops: readonly { fields: Record<string, unknown> }[] }, field: string) =>
  (r.ops[0]?.fields[field] ?? []) as readonly Record<string, unknown>[];
const iv = (from: string, to: string, incl: string) => ({
  valid_from: from,
  valid_to: to,
  valid_to_inclusive: incl,
});

describe("a value cleared to null and a gap (09-event-format §5.8 `impact`)", () => {
  it(
    "a stale write over a value cleared to null: the cleared stretch is overwritten, named by the write that cleared it, not a gap",
    async () => {
      // b = x, c = 1; another connection clears c from 11-10; a stale c = 2 on [11-05, 11-20)
      // would erase the change point at 11-10.
      const { e, entity } = await entityWith({ b: "x", c: "1" });
      const clear = await on(
        entity,
        { intent: "update", ver: verAt(e), valid_from: "2026-11-10", set: { c: null } },
        OTHER,
      );
      const stale = await on(entity, {
        intent: "update",
        ver: verAt(e),
        valid_from: "2026-11-05",
        valid_to: "2026-11-20",
        set: { c: "2" },
      });
      const [created] = await ofType(stale.seq, "item.created");
      const segs = blocksOf(created?.blocks, "impact").filter(
        (b) => b["kind"] === "overwritten_segment",
      );
      expect(segs).toContainEqual(
        expect.objectContaining({
          field: "f3",
          value: null,
          op: clear.seq,
          valid: { from: "2026-11-10", to: "2026-11-20" },
        }),
      );
      expect(segs.filter((b) => "gap" in b)).toEqual([]);
      const part = partsOf(stale, "c").find((p) => p["result"] === "candidate");
      expect(part?.["impact"]).toEqual({
        overwritten: expect.arrayContaining([
          {
            field: "c",
            valid: iv("2026-11-10", "2026-11-20", "2026-11-19"),
            value: null,
            seq: clear.seq,
            actor: asActor(OTHER),
          },
        ]),
      });
    },
    T,
  );

  it(
    "a write filling a stretch a revoke left without a value: a gap, named by the revoke",
    async () => {
      const { e, entity } = await entityWith({ b: "x" });
      const v = await on(
        entity,
        { intent: "revoke", ver: verAt(e), valid_from: "2026-11-10", valid_to: "2026-11-15" },
        OTHER,
      );
      const w = await on(entity, {
        intent: "update",
        ver: verAt(v),
        valid_from: "2026-11-05",
        valid_to: "2026-11-20",
        set: { b: "y" },
      });
      expect(w.pending[0]?.type).toBe("awaiting_confirmation");
      const [created] = await ofType(w.seq, "item.created");
      const gaps = blocksOf(created?.blocks, "impact").filter((b) => b["gap"] === true);
      expect(gaps).toEqual([
        expect.objectContaining({
          kind: "overwritten_segment",
          field: "f2",
          value: null,
          gap: true,
          op: v.seq,
          valid: { from: "2026-11-10", to: "2026-11-15" },
        }),
      ]);
      const impact = partsOf(w, "b").find((p) => p["result"] === "awaiting")?.["impact"] as {
        overwritten?: { value: unknown }[];
        filled_gaps?: unknown[];
      };
      expect(impact.filled_gaps).toEqual([
        { valid: iv("2026-11-10", "2026-11-15", "2026-11-14"), revoked_by: v.seq },
      ]);
      expect(impact.overwritten?.map((o) => o.value)).not.toContain(null);
    },
    T,
  );
});

describe("a stale revoke of the whole entity on a state table (09-event-format §5.8 `scope_valid`)", () => {
  it(
    "a stale revoke of the whole entity: an item over the whole time, spans [{}], a flag without spans; later writes reach it",
    async () => {
      const { e, entity } = await entityWith({ b: "x" });
      const y = await on(entity, { intent: "update", ver: verAt(e), set: { b: "y" } }, OTHER);
      const stale = await on(entity, { intent: "revoke", ver: verAt(e) });
      const item = stale.pending[0]?.id as string;
      expect(stale.pending[0]?.type).toBe("conflict");
      const [created] = await ofType(stale.seq, "item.created");
      expect(created?.blocks["scope_valid"]).toMatchObject({ spans: [{}] });
      expect(await flagSpans(item)).toBeNull();
      // A later write by a connection that had not read it reaches it anywhere in time.
      const later = await on(
        entity,
        { intent: "update", ver: verAt(y), valid_from: "2026-12-01", set: { b: "z" } },
        OTHER,
      );
      const [refreshed] = await ofType(later.seq, "item.refreshed");
      expect(refreshed?.blocks["target"]).toMatchObject({ item });
      expect(refreshed?.blocks["scope_valid"]).toMatchObject({ spans: [{}] });
      expect(await flagSpans(item)).toBeNull();
    },
    T,
  );

  it(
    "an item with an interval joined by a stale revoke of the whole entity: its interval becomes the whole time",
    async () => {
      const { e, entity } = await entityWith({ b: "x" });
      const v = await on(
        entity,
        { intent: "revoke", ver: verAt(e), valid_from: "2026-11-05", valid_to: "2026-11-07" },
        OTHER,
      );
      const stale = await on(entity, {
        intent: "update",
        ver: verAt(e),
        valid_from: "2026-11-05",
        valid_to: "2026-11-07",
        set: { b: "y" },
      });
      const item = stale.pending[0]?.id as string;
      expect(await flagSpans(item)).toEqual([{ from: "2026-11-05", to: "2026-11-07" }]);
      const whole = await on(entity, { intent: "revoke", ver: verAt(e) });
      const [merged] = await ofType(whole.seq, "item.merged");
      expect(merged?.blocks["target"]).toMatchObject({ item });
      expect(merged?.blocks["scope_valid"]).toMatchObject({ spans: [{}] });
      expect(await flagSpans(item)).toBeNull();
      const later = await on(
        entity,
        { intent: "update", ver: verAt(v), valid_from: "2026-12-01", set: { b: "z" } },
        OTHER,
      );
      const [refreshed] = await ofType(later.seq, "item.refreshed");
      expect(refreshed?.blocks["target"]).toMatchObject({ item });
      expect(refreshed?.blocks["scope_valid"]).toMatchObject({ spans: [{}] });
    },
    T,
  );
});

describe("who gave what a candidate met: the receipt's by and the item's effective agree", () => {
  const from = "2026-11-05";
  const stale = (entity: string, ver: string) =>
    on(entity, { intent: "update", ver, valid_from: from, valid_to: "open", set: { c: "z" } });
  const revoke = (entity: string, ver: string) =>
    on(entity, { intent: "revoke", ver, valid_from: from, valid_to: "open" }, OTHER);
  const undo = (entity: string, of: number, ver: string) =>
    on(entity, { revert: { undo: of }, ver, acknowledge: ["overwrite"] }, OTHER);
  /** The item's details read now, by the user. */
  const detailOf = async (id: string) =>
    (await pending$(
      s.store,
      createOpsContext({
        tenant: TENANT,
        actor: USER,
        trigger: null,
        task: null,
        visibility: { kind: "all" },
        idempotency_key_window: 86_400_000,
        idempotency_window: 600_000,
        now: now(),
        confirmation: null,
      }),
      { id },
    )) as unknown as {
      effective: { seq?: number; actor?: unknown; spans: { seq?: number; actor?: unknown }[] };
    };
  /** The candidate's by, the item's top seq and each span's: one operation, `seq` by `actor`. */
  const agree = async (z: Awaited<ReturnType<typeof send>>, seq: number, actor: string) => {
    const part = partsOf(z, "c").find((p) => p["result"] === "candidate") as Record<
      string,
      unknown
    >;
    expect(part, "a candidate").toBeDefined();
    const by = { seq, actor: asActor(actor) };
    expect(part["by"]).toEqual(by);
    const d = await detailOf(part["item"] as string);
    expect({ seq: d.effective.seq, actor: d.effective.actor }).toEqual(by);
    expect(d.effective.spans.map((x) => ({ seq: x.seq, actor: x.actor }))).toEqual(
      d.effective.spans.map(() => by),
    );
  };
  /** An entity with b only before `from`, and b filled from `from` on: undoing the fill empties it. */
  const filled = async () => {
    const e = await send({
      sv: 1,
      ops: [
        {
          intent: "insert",
          table: "entities",
          valid_from: "2026-11-01",
          valid_to: from,
          set: { b: "x" },
        },
      ],
    });
    const entity = e.ops[0]?.target.entity as string;
    const fill = await on(entity, {
      intent: "update",
      ver: verAt(e),
      valid_from: from,
      valid_to: "open",
      set: { b: "x2" },
    });
    return { entity, fill };
  };

  it(
    "a revoke's hole: the revoke",
    async () => {
      const { e, entity } = await entityWith({ b: "x", c: "m" });
      const r = await revoke(entity, verAt(e));
      await agree(await stale(entity, verAt(e)), r.seq, OTHER);
    },
    T,
  );

  it(
    "an undo's hole (a required field's fill undone): the undo",
    async () => {
      const { entity, fill } = await filled();
      const u = await undo(entity, fill.seq, verAt(fill));
      expect(u.status).toBe("saved");
      await agree(await stale(entity, verAt(fill)), u.seq, OTHER);
    },
    T,
  );

  it(
    "a revoke undone: the hole filled again, by the write that gave the values",
    async () => {
      const { e, entity } = await entityWith({ b: "x", c: "m" });
      const r = await revoke(entity, verAt(e));
      const back = await undo(entity, r.seq, verAt(r));
      expect(back.status).toBe("saved");
      await agree(await stale(entity, verAt(r)), e.seq, USER);
    },
    T,
  );

  it(
    "the same fill undone twice: the first undo, the second changing no cell",
    async () => {
      const { entity, fill } = await filled();
      const u1 = await undo(entity, fill.seq, verAt(fill));
      const u2 = await undo(entity, fill.seq, verAt(u1));
      expect(verAt(u2)).toBe(verAt(u1));
      await agree(await stale(entity, verAt(fill)), u1.seq, OTHER);
    },
    T,
  );

  it(
    "a revoke inside a revoke's hole: the later revoke",
    async () => {
      const { e, entity } = await entityWith({ b: "x", c: "m" });
      const r1 = await revoke(entity, verAt(e));
      const r2 = await revoke(entity, verAt(r1));
      expect(verAt(r2)).not.toBe(verAt(r1));
      await agree(await stale(entity, verAt(e)), r2.seq, OTHER);
    },
    T,
  );

  it(
    "the field never written there, the entity given a value again: no by, and no seq in the details",
    async () => {
      const { e, entity } = await entityWith({ b: "x" });
      const r = await revoke(entity, verAt(e));
      const refill = await on(
        entity,
        { intent: "update", ver: verAt(r), valid_from: from, valid_to: "open", set: { b: "y" } },
        OTHER,
      );
      expect(refill.ops[0]?.fields["b"]).toMatchObject([{ result: "applied" }]);
      const z = await stale(entity, verAt(r));
      const part = partsOf(z, "c").find((p) => p["result"] === "candidate") as Record<
        string,
        unknown
      >;
      expect(part).toBeDefined();
      expect(part).not.toHaveProperty("by");
      expect(part["effective"]).toBeNull();
      const d = await detailOf(part["item"] as string);
      expect(d.effective).not.toHaveProperty("seq");
      expect(d.effective.spans.map((x) => x.seq)).toEqual(d.effective.spans.map(() => undefined));
    },
    T,
  );

  it(
    "a part over stretches given by different writes: the latest of them",
    async () => {
      const { e, entity } = await entityWith({ b: "x", c: "m" });
      const one = await on(
        entity,
        {
          intent: "update",
          ver: verAt(e),
          valid_from: "2026-11-05",
          valid_to: "2026-11-10",
          set: { c: "n" },
        },
        OTHER,
      );
      const two = await on(entity, {
        intent: "update",
        ver: verAt(one),
        valid_from: "2026-11-10",
        valid_to: "open",
        set: { c: "o" },
      });
      // From the insert's version over [11-05, ∞): two stretches, given by one and two.
      const z = await stale(entity, verAt(e));
      const part = partsOf(z, "c").find((p) => p["result"] === "candidate") as Record<
        string,
        unknown
      >;
      expect(part["by"]).toEqual({ seq: two.seq, actor: asActor(USER) });
      expect(part["effective"]).toBe("o");
      const d = await detailOf(part["item"] as string);
      expect({ seq: d.effective.seq, actor: d.effective.actor }).toEqual(part["by"]);
      expect(d.effective.spans.map((x) => x.seq)).toEqual([one.seq, two.seq]);
    },
    T,
  );

  it(
    "a part never written anywhere: a candidate without by, the details without seq",
    async () => {
      // The entity is only [11-10, 11-15); a revoke from 11-05 on and its undo leave [11-15, ∞)
      // never written; a write there from the insert's version meets what changed since.
      const e = await send({
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "entities",
            valid_from: "2026-11-10",
            valid_to: "2026-11-15",
            set: { b: "x" },
          },
        ],
      });
      const entity = e.ops[0]?.target.entity as string;
      const r = await revoke(entity, verAt(e));
      await undo(entity, r.seq, verAt(r));
      const z = await on(entity, {
        intent: "update",
        ver: verAt(e),
        valid_from: "2026-11-15",
        valid_to: "2026-11-20",
        set: { c: "z" },
      });
      const part = partsOf(z, "c").find((p) => p["result"] === "candidate") as Record<
        string,
        unknown
      >;
      expect(part, "a candidate").toBeDefined();
      expect(part).not.toHaveProperty("by");
      const d = await detailOf(part["item"] as string);
      expect(d.effective).not.toHaveProperty("seq");
    },
    T,
  );

  it(
    "a later op of the same request writes the unit: by is that write, effective its value",
    async () => {
      const { e, entity } = await entityWith({ b: "x" });
      const c1 = await on(
        entity,
        {
          intent: "update",
          ver: verAt(e),
          valid_from: "2026-11-05",
          valid_to: "2026-11-10",
          set: { c: "c1" },
        },
        OTHER,
      );
      // From the insert's version, b and c over [11-01, ∞): c stale, c1 met on [11-05, 11-10).
      const z = await on(entity, {
        intent: "update",
        ver: verAt(e),
        valid_from: "2026-11-01",
        valid_to: "open",
        set: { b: "q", c: "z" },
      });
      const part = partsOf(z, "c").find((p) => p["result"] === "candidate") as Record<
        string,
        unknown
      >;
      expect(part["by"]).toEqual({ seq: c1.seq, actor: asActor(OTHER) });
      expect(part["effective"]).toBe("c1");
      const d = await detailOf(part["item"] as string);
      expect(d.effective.seq).toBe(c1.seq);
    },
    T,
  );

  it(
    "a part on existence: the latest giver of any field (the unit is every field)",
    async () => {
      const { e, entity } = await entityWith({ b: "x", c: "m" });
      const c2 = await on(entity, { intent: "update", ver: verAt(e), set: { c: "c2" } }, OTHER);
      const z = await on(entity, { intent: "revoke", ver: verAt(e) });
      const part = (
        z.ops[0]?.fields["*"] as unknown as Record<string, unknown>[] | undefined
      )?.find((p) => p["result"] === "candidate") as Record<string, unknown>;
      expect(part["by"]).toEqual({ seq: c2.seq, actor: asActor(OTHER) });
      const d = await detailOf(part["item"] as string);
      expect(d.effective.seq).toBe(c2.seq);
    },
    T,
  );

  it(
    "a timeless row whose revoke was undone: the undo, as its existence cell says",
    async () => {
      const a = await send({ sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "1" } }] });
      const row = rowAt(a);
      const v = await send(
        { sv: 1, ops: [{ intent: "revoke", table: "rows", row, ver: verAt(a) }] },
        {
          actor: OTHER,
        },
      );
      const u = await send(
        { sv: 1, ops: [{ table: "rows", row, revert: { undo: v.seq }, ver: verAt(v) }] },
        { actor: OTHER },
      );
      expect(u.status).toBe("saved");
      const z = await send({
        sv: 1,
        ops: [{ intent: "update", table: "rows", row, ver: verAt(a), set: { b: "2" } }],
      });
      const part = z.ops[0]?.fields["b"] as unknown as Record<string, unknown>;
      expect(part["result"]).toBe("candidate");
      expect(part["by"]).toEqual({ seq: u.seq, actor: asActor(OTHER) });
      const d = await detailOf(part["item"] as string);
      expect(d.effective.seq).toBe(u.seq);
    },
    T,
  );

  it(
    "an undo of a whole revoke with an intent: the whole time, not an error",
    async () => {
      for (const intent of ["update", "correct"]) {
        const { e, entity } = await entityWith({ b: intent });
        const r = await on(entity, { intent: "revoke", ver: verAt(e) }, OTHER);
        const u = await send(
          {
            sv: 1,
            ops: [
              {
                table: "entities",
                entity,
                intent,
                revert: { undo: r.seq },
                ver: verAt(r),
                acknowledge: ["overwrite"],
              },
            ],
            idempotency_key: `k-undo-${intent}`,
          },
          { actor: OTHER },
        );
        expect((u as { refused?: string }).refused, intent).toBeUndefined();
        expect(u.ops[0]?.fields["*"], intent).toEqual([
          { result: "applied", valid: { valid_from: null, valid_to: null } },
        ]);
      }
    },
    T,
  );

  it(
    "a table with no required field: a stretch whose only contribution is a clear has a value, empty",
    async () => {
      // loose: b over [11-01, 11-10); OTHER clears b there. A clear is a contribution in effect
      // (05-time «无值区间»): the entity still has a value there, every field empty, given by the
      // clearing write.
      const a = await send({
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "loose",
            valid_from: "2026-11-01",
            valid_to: "2026-11-10",
            set: { b: "x" },
          },
        ],
      });
      const entity = a.ops[0]?.target.entity as string;
      const r = await send(
        {
          sv: 1,
          ops: [
            {
              table: "loose",
              entity,
              intent: "update",
              ver: verAt(a),
              valid_from: "2026-11-01",
              valid_to: "2026-11-10",
              set: { b: null },
            },
          ],
        },
        { actor: OTHER },
      );
      expect((r as { refused?: string }).refused ?? r.status).toBe("saved");
      // A revoke from before the clearing meets it on existence.
      const z = await on(entity, { table: "loose", intent: "revoke", ver: verAt(a) });
      const part = (
        z.ops[0]?.fields["*"] as unknown as Record<string, unknown>[] | undefined
      )?.find((p) => p["result"] === "candidate") as Record<string, unknown>;
      expect(part["by"]).toEqual({ seq: r.seq, actor: asActor(OTHER) });
      expect(part["effective"]).toBeNull();
      const d = await detailOf(part["item"] as string);
      expect(d.effective).toMatchObject({ seq: r.seq, exists: true });
      expect(
        d.effective.spans.map((x) => {
          const y = x as { valid_from: unknown; values?: unknown; seq?: unknown };
          return [y.valid_from, y.values, y.seq];
        }),
      ).toEqual([
        [null, null, undefined],
        ["2026-11-01", { b: null, c: null }, r.seq],
        ["2026-11-10", null, undefined],
      ]);
    },
    T,
  );

  it(
    "the replay gives the by the first receipt gave",
    async () => {
      const { entity, fill } = await filled();
      const u = await undo(entity, fill.seq, verAt(fill));
      const params = {
        sv: 1,
        ops: [
          {
            table: "entities",
            entity,
            intent: "update",
            ver: verAt(fill),
            valid_from: from,
            valid_to: "open",
            set: { c: "z" },
          },
        ],
        idempotency_key: "k-by",
      };
      const first = await send(params);
      const again = await send(params);
      expect(again.replayed).toBe(true);
      expect(partsOf(again, "c")).toEqual(partsOf(first, "c"));
      expect(
        (partsOf(first, "c").find((p) => p["result"] === "candidate") as Record<string, unknown>)[
          "by"
        ],
      ).toEqual({ seq: u.seq, actor: asActor(OTHER) });
    },
    T,
  );
});

describe("a revoke of the whole entity: its part on a state table is the whole time", () => {
  const WHOLE_TIME = { valid_from: null, valid_to: null };
  it(
    "applied and as a candidate, each with the whole time; the replay gives the same",
    async () => {
      const { e, entity } = await entityWith({ b: "x" });
      const later = await on(entity, { intent: "update", ver: verAt(e), set: { b: "y" } });
      const params = (ver: string, key: string) => ({
        sv: 1,
        ops: [{ table: "entities", entity, intent: "revoke", ver }],
        idempotency_key: key,
      });
      // From the old version: a candidate over the whole time.
      const stale = await send(params(verAt(e), "k-whole-1"));
      expect(stale.ops[0]?.fields["*"]).toEqual([
        expect.objectContaining({ result: "candidate", valid: WHOLE_TIME }),
      ]);
      // From the current one: applied over the whole time.
      const applied = await send(params(verAt(later), "k-whole-2"));
      expect(applied.ops[0]?.fields["*"]).toEqual([{ result: "applied", valid: WHOLE_TIME }]);
      for (const [r, key] of [
        [stale, "k-whole-1"],
        [applied, "k-whole-2"],
      ] as const) {
        const again = await send(params(key === "k-whole-1" ? verAt(e) : verAt(later), key));
        expect(again.replayed).toBe(true);
        expect(again.ops).toEqual(r.ops);
      }
    },
    T,
  );
});

describe("intervals open at the start, and the whole time, in the log (09 §5.7, §5.8)", () => {
  const ctxNow = () =>
    createOpsContext({
      tenant: TENANT,
      actor: USER,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_key_window: 86_400_000,
      idempotency_window: 600_000,
      now: now(),
      confirmation: null,
    });
  const WHOLE = { valid_from: null, valid_to: null };

  it(
    "a whole revoke from an older version where another revoked the whole entity: a candidate over the whole time",
    async () => {
      const { e, entity } = await entityWith({ b: "x" });
      const theirs = await on(entity, { intent: "revoke", ver: verAt(e) }, OTHER);
      const params = {
        sv: 1,
        ops: [{ table: "entities", entity, intent: "revoke", ver: verAt(e) }],
        idempotency_key: "k-whole-whole",
      };
      const z = await send(params);
      expect(z.ops[0]?.fields["*"]).toEqual([
        expect.objectContaining({
          result: "candidate",
          effective: null,
          by: { seq: theirs.seq, actor: asActor(OTHER) },
        }),
      ]);
      // The item's entries: the whole time as `{}`, the item's interval as `[{}]`.
      const [created] = await ofType(z.seq, "item.created");
      expect(created?.blocks["scope_valid"]).toMatchObject({ spans: [{}] });
      expect(created?.blocks["current/0"]).toMatchObject({
        field: "existence",
        revoked: true,
        op: theirs.seq,
        valid: {},
      });
      // Read out: the whole time is both ends null.
      const item = (z.ops[0]?.fields["*"] as unknown as { item: string }[] | undefined)?.[0]
        ?.item as string;
      const d = (await pending$(s.store, ctxNow(), { id: item })) as unknown as {
        target: { spans: unknown[] };
        effective: { seq: number; spans: unknown[]; exists: boolean };
      };
      expect(d.target.spans).toEqual([WHOLE]);
      expect(d.effective).toMatchObject({ seq: theirs.seq, exists: false });
      // The revoke's cells lie where the entity had items (from 11-01); before that, never written.
      expect(d.effective.spans).toEqual([
        {
          valid_from: null,
          valid_to: "2026-11-01",
          valid_to_inclusive: "2026-10-31",
          values: null,
        },
        {
          valid_from: "2026-11-01",
          valid_to: null,
          values: null,
          seq: theirs.seq,
          actor: asActor(OTHER),
        },
      ]);
      const again = await send(params);
      expect(again.replayed).toBe(true);
      expect(again.ops).toEqual(z.ops);
    },
    T,
  );

  it(
    "an interval revoke, a whole revoke, the whole revoke undone: write-backs open at the start and at the end",
    async () => {
      const { e, entity } = await entityWith({ b: "x" });
      const r1 = await on(entity, {
        intent: "revoke",
        ver: verAt(e),
        valid_from: "2026-11-05",
        valid_to: "2026-11-10",
      });
      const r2 = await on(entity, { intent: "revoke", ver: verAt(r1) });
      const params = {
        sv: 1,
        ops: [
          {
            table: "entities",
            entity,
            revert: { undo: r2.seq },
            ver: verAt(r2),
            acknowledge: ["overwrite"],
          },
        ],
        idempotency_key: "k-undo-whole",
      };
      const u = await send(params);
      expect(u.status).toBe("saved");
      expect(u.ops[0]?.fields["*"]).toEqual([
        {
          result: "applied",
          valid: { valid_from: null, valid_to: "2026-11-05", valid_to_inclusive: "2026-11-04" },
        },
        {
          result: "applied",
          valid: {
            valid_from: "2026-11-05",
            valid_to: "2026-11-10",
            valid_to_inclusive: "2026-11-09",
          },
        },
        { result: "applied", valid: { valid_from: "2026-11-10", valid_to: null } },
      ]);
      // In the log: `{to}` open at the start, `{from}` open at the end.
      const [base] = await ofType(u.seq, "write.base");
      expect(base?.blocks["span/existence/0"]).toMatchObject({ valid: { to: "2026-11-05" } });
      expect(base?.blocks["span/existence/2"]).toMatchObject({ valid: { from: "2026-11-10" } });
      // The entity has its value again but on r1's stretch, and takes later writes.
      const rows = (
        await s.store.read((tx) =>
          tx.query<{ f: string; t: string | null }>(
            `SELECT valid_from::text AS f, valid_to::text AS t FROM "t_t2_v1"
             WHERE entity_id = $1 ORDER BY valid_from`,
            [entity],
          ),
        )
      ).rows.map((r) => [r.f, r.t]);
      expect(rows).toEqual([
        ["2026-11-01", "2026-11-05"],
        ["2026-11-10", null],
      ]);
      // The row's timeline gives the undo's write-back open at the start as the contract does.
      const tl = (await history(s.store, ctxNow(), { table: "entities", entity })) as unknown as {
        entries: { seq: number; fields: Record<string, { valid?: unknown }[]> }[];
      };
      const undone = tl.entries.find((x) => x.seq === u.seq) as
        | { valid?: unknown; fields: Record<string, { valid?: unknown }[]> }
        | undefined;
      // The entry's interval is the widest of its parts: open at both ends here.
      expect(undone?.valid).toEqual(WHOLE);
      expect(undone?.fields["*"]?.[0]?.valid).toEqual({
        valid_from: null,
        valid_to: "2026-11-05",
        valid_to_inclusive: "2026-11-04",
      });
      const later = await on(entity, {
        intent: "update",
        ver: verAt(u),
        valid_from: "2026-11-12",
        valid_to: "open",
        set: { c: "after" },
      });
      expect((later as { refused?: string }).refused ?? later.status).toBe("saved");
      const again = await send(params);
      expect(again.replayed).toBe(true);
      expect(again.ops).toEqual(u.ops);
    },
    T,
  );
  it(
    "the caller's whole revoke is scope whole without a span; its undo's write-back is the whole time with deps",
    async () => {
      const { e, entity } = await entityWith({ b: "x" });
      const r = await on(entity, { intent: "revoke", ver: verAt(e) });
      const [rb] = await ofType(r.seq, "write.base");
      expect(rb?.blocks["existence/0"]).toEqual({ status: "applied", scope: "whole" });
      expect(rb?.blocks).not.toHaveProperty("span/existence/0");
      const u = await on(entity, {
        revert: { undo: r.seq },
        ver: verAt(r),
        acknowledge: ["overwrite"],
      });
      expect(u.ops[0]?.fields["*"]).toEqual([{ result: "applied", valid: WHOLE }]);
      // The write-back has its deps, which only a span block carries: an interval, `{}` (09 §5.7).
      const [ub] = await ofType(u.seq, "write.base");
      expect(ub?.blocks["existence/0"]).toEqual({
        status: "applied",
        scope: "interval",
        restored: true,
      });
      expect(ub?.blocks["span/existence/0"]).toEqual({
        valid: {},
        deps: [expect.objectContaining({ existence: 0 })],
      });
      // The timeline gives both the whole time, as their receipts do.
      const tl = (await history(s.store, ctxNow(), { table: "entities", entity })) as unknown as {
        entries: { seq: number; valid?: unknown; fields: Record<string, { valid?: unknown }> }[];
      };
      for (const seq of [r.seq, u.seq]) {
        const x = tl.entries.find((y) => y.seq === seq);
        expect({ seq, entry: x?.valid, part: x?.fields["*"]?.valid }).toEqual({
          seq,
          entry: WHOLE,
          part: WHOLE,
        });
      }
    },
    T,
  );

  it(
    "a candidate's whole revoke in the timeline: the whole time, as in its receipt",
    async () => {
      const { e, entity } = await entityWith({ b: "x" });
      await on(
        entity,
        { intent: "update", ver: verAt(e), valid_from: "2026-11-05", set: { b: "y" } },
        OTHER,
      );
      const z = await on(entity, { intent: "revoke", ver: verAt(e) });
      expect(z.ops[0]?.fields["*"]).toEqual([
        expect.objectContaining({ result: "candidate", valid: WHOLE }),
      ]);
      const tl = (await history(s.store, ctxNow(), { table: "entities", entity })) as unknown as {
        entries: { seq: number; valid?: unknown; fields: Record<string, { valid?: unknown }> }[];
      };
      const x = tl.entries.find((y) => y.seq === z.seq);
      expect({ entry: x?.valid, part: x?.fields["*"]?.valid }).toEqual({
        entry: WHOLE,
        part: WHOLE,
      });
    },
    T,
  );

  it(
    "segments joined in a read: their marks' touching spans are one span",
    async () => {
      const { e, entity } = await entityWith({ b: "x" });
      // b is y from 11-10 on; c changes at 11-15, so the entity has two segments there.
      const y = await on(
        entity,
        { intent: "update", ver: verAt(e), valid_from: "2026-11-10", set: { b: "y" } },
        OTHER,
      );
      await on(
        entity,
        { intent: "update", ver: verAt(y), valid_from: "2026-11-15", set: { c: "m" } },
        OTHER,
      );
      // A write of b from before y: a candidate on b over [11-10, ∞), marked on both segments.
      const z = await on(entity, {
        intent: "update",
        ver: verAt(e),
        valid_from: "2026-11-10",
        set: { b: "z" },
      });
      const item = z.pending?.[0]?.id as string;
      // Reading b only, the two segments are one row; its mark is the item's one span.
      const rows = await rowsOf(entity, { valid_during: ["2026-10-01", null], fields: ["b"] });
      const row = rows.find((r) => r.valid_from === "2026-11-10");
      expect(row?.valid_to).toBeNull();
      expect((row?.marks as { disputed?: unknown } | undefined)?.disputed).toEqual([
        { item, fields: ["b"], spans: [{ valid_from: "2026-11-10", valid_to: null }] },
      ]);
    },
    T,
  );

  /** An entity, its whole revoke undone with an intent, an interval revoke cutting the undo's
   * write-back, and that undo undone by another principal: an awaiting item whose first span is
   * open at the start. */
  const undoneUndo = async (insert: Record<string, unknown>) => {
    const put = (o: Record<string, unknown>, actor = USER) =>
      send({ sv: 1, ops: [{ table: "entities", ...o }] }, { actor });
    const e = await send({ sv: 1, ops: [{ intent: "insert", table: "entities", ...insert }] });
    const entity = e.ops[0]?.target.entity as string;
    const r = await put({ entity, intent: "revoke", ver: verAt(e) });
    const u = await put({
      entity,
      intent: "correct",
      revert: { undo: r.seq },
      ver: verAt(r),
      acknowledge: ["overwrite"],
    });
    const cut = await put({
      entity,
      intent: "revoke",
      ver: verAt(u),
      valid_from: "2026-11-05",
      valid_to: "2026-11-10",
    });
    const z = await put(
      { entity, revert: { undo: u.seq }, ver: verAt(u), acknowledge: ["overwrite"] },
      OTHER,
    );
    return { entity, cut, z, put };
  };
  const rowsOf = async (entity: string, params: Record<string, unknown>) =>
    (
      await s.store.read((tx) =>
        queryInTx(tx, {
          actor: USER as never,
          task: null,
          now: "2026-11-05T12:00:00.000Z" as never,
          visibility: { kind: "all" },
          params: { table: "entities", ...params },
          read: "rd_0000000000000000" as never,
        }),
      )
    ).result.rows.filter((x) => (x as { entity?: string }).entity === entity) as unknown as {
      valid_from: string;
      valid_to: string | null;
      marks?: { awaiting?: { item: string; spans?: unknown[] }[] };
    }[];

  it(
    "an undo of a whole revoke's undo, cut by an interval revoke: an item whose first span is open at the start",
    async () => {
      const { entity, z } = await undoneUndo({ valid_from: "2026-11-10", set: { b: "b0" } });
      const item = z.pending?.[0]?.id as string;
      expect(z.ops[0]?.fields["*"]).toEqual([
        {
          result: "awaiting",
          item,
          impact: {},
          valid: { valid_from: null, valid_to: "2026-11-05", valid_to_inclusive: "2026-11-04" },
        },
        {
          result: "awaiting",
          item,
          impact: {},
          valid: { valid_from: "2026-11-10", valid_to: null },
        },
      ]);
      // In the log: the first span of the item's interval open at the start (09 §5.8).
      const [created] = await ofType(z.seq, "item.created");
      expect(created?.blocks["scope_valid"]).toMatchObject({
        spans: [{ to: "2026-11-05" }, { from: "2026-11-10" }],
      });
      expect(await flagSpans(item)).toEqual([{ to: "2026-11-05" }, { from: "2026-11-10" }]);
      const d = (await pending$(s.store, ctxNow(), { id: item })) as unknown as {
        target: { spans: unknown[] };
      };
      expect(d.target.spans).toEqual([
        { valid_from: null, valid_to: "2026-11-05", valid_to_inclusive: "2026-11-04" },
        { valid_from: "2026-11-10", valid_to: null },
      ]);
      // The row (from 11-10 on) is marked over its part of the item: from its start.
      const [row] = await rowsOf(entity, { valid_at: "2026-11-12" });
      expect(row?.marks?.awaiting).toEqual([
        { item, fields: ["*"], spans: [{ valid_from: "2026-11-10", valid_to: null }] },
      ]);
    },
    T,
  );

  it(
    "a row across the end of an item's span open at the start: its mark cut to the row",
    async () => {
      const { entity, z, put } = await undoneUndo({
        valid_from: "2026-11-01",
        valid_to: "2026-11-20",
        set: { b: "b0" },
      });
      const item = z.pending?.[0]?.id as string;
      // The hole between the item's spans filled with the same value by a write of its own (not an
      // undo of the revoke, which would widen what confirming the item does): one row
      // [11-01, 11-20) across 11-05, the item's spans as they were.
      const back = await put({
        entity,
        intent: "update",
        ver: verAt(z),
        valid_from: "2026-11-05",
        valid_to: "2026-11-10",
        set: { b: "b0" },
        acknowledge: ["overwrite"],
      });
      expect(back.status).toBe("saved");
      const rows = await rowsOf(entity, { valid_during: ["2026-10-01", null] });
      expect(rows.map((r) => [r.valid_from, r.valid_to])).toEqual([["2026-11-01", "2026-11-20"]]);
      expect(rows[0]?.marks?.awaiting).toEqual([
        {
          item,
          fields: ["*"],
          spans: [
            { valid_from: "2026-11-01", valid_to: "2026-11-05", valid_to_inclusive: "2026-11-04" },
            { valid_from: "2026-11-10", valid_to: "2026-11-20", valid_to_inclusive: "2026-11-19" },
          ],
        },
      ]);
    },
    T,
  );
});

describe("a state table with no required field: a clear is a contribution (05-time «无值区间»)", () => {
  const loose = (op: Record<string, unknown>, actor = USER) =>
    send({ sv: 1, ops: [{ table: "loose", ...op }] }, { actor });
  const entityOf = (r: { ops: readonly { target: { entity?: string } }[] }) =>
    r.ops[0]?.target.entity as string;
  /** `query` on loose: the business table's path, or the version table's as of the latest op. */
  const queryLoose = (params: Record<string, unknown>, asOf?: boolean) =>
    s.store.read(async (tx) => {
      const latest = Number(
        (await tx.query<{ op: unknown }>("SELECT max(op) AS op FROM events")).rows[0]?.op,
      );
      return (
        await queryInTx(tx, {
          actor: USER as never,
          task: null,
          now: "2026-11-05T12:00:00.000Z" as never,
          visibility: { kind: "all" },
          params: { table: "loose", ...params },
          read: "rd_0000000000000000" as never,
          ...(asOf === true ? { asOf: latest } : {}),
        })
      ).result as unknown as {
        rows: Record<string, unknown>[];
        total: number;
        next_position?: string;
      };
    });
  const detailOf = async (id: string) =>
    (await pending$(
      s.store,
      createOpsContext({
        tenant: TENANT,
        actor: `ci_${"3".repeat(26)}`,
        trigger: null,
        task: null,
        visibility: { kind: "all" },
        idempotency_key_window: 86_400_000,
        idempotency_window: 600_000,
        now: now(),
        confirmation: null,
      }),
      { id },
    )) as unknown as { effective: Record<string, unknown> };

  const asAt = (r: Record<string, unknown>) => [r["valid_from"], r["values"]];
  const bothAt = async (params: Record<string, unknown>) => {
    const first = await queryLoose(params);
    const later = await queryLoose(params, true);
    expect(later.rows).toEqual(first.rows);
    return first.rows;
  };

  it(
    "a stretch only cleared is a row on every page, whatever the page size",
    async () => {
      // Two other entities first; then one with b over [11-10, 11-15), its c cleared over
      // [11-01, 11-05): that stretch's only contribution is the clear.
      await loose({ intent: "insert", valid_from: "2026-11-01", set: { b: "o1" } });
      await loose({ intent: "insert", valid_from: "2026-11-01", set: { b: "o2" } });
      const a = await loose({
        intent: "insert",
        valid_from: "2026-11-10",
        valid_to: "2026-11-15",
        set: { b: "b0" },
      });
      await loose({
        intent: "update",
        entity: entityOf(a),
        ver: verAt(a),
        valid_from: "2026-11-01",
        valid_to: "2026-11-05",
        set: { c: null },
      });
      const P = { valid_during: ["2026-10-01", null], clip: false, coalesce: true };
      const whole = await queryLoose({ ...P, limit: 200 });
      expect(whole.rows.map(asAt)).toEqual([
        ["2026-11-01", { b: "o1", c: null }],
        ["2026-11-01", { b: "o2", c: null }],
        ["2026-11-01", { b: null, c: null }],
        ["2026-11-10", { b: "b0", c: null }],
      ]);
      expect((await queryLoose({ ...P, limit: 200 }, true)).rows).toEqual(whole.rows);
      for (const limit of [1, 2]) {
        const pages = [await queryLoose({ ...P, limit })];
        while (pages.at(-1)?.next_position !== undefined)
          pages.push(await queryLoose({ ...P, limit, position: pages.at(-1)?.next_position }));
        expect({ limit, rows: pages.flatMap((x) => x.rows) }).toEqual({ limit, rows: whole.rows });
      }
    },
    T,
  );

  it(
    "b and c written on a stretch, then undone: no value there, given by the undo",
    async () => {
      const a = await loose({ intent: "insert", valid_from: "2026-11-10", set: { b: "x" } });
      const e = entityOf(a);
      const w2 = await loose({
        intent: "update",
        entity: e,
        ver: verAt(a),
        valid_from: "2026-11-01",
        valid_to: "2026-11-05",
        set: { b: "y", c: "z" },
      });
      // Taking away both change points of the stretch awaits a confirmation (05-time, high
      // impact ①): confirmed, the undo writes the stretch back without a value.
      const u = await loose({ entity: e, revert: { undo: w2.seq }, ver: verAt(w2) }, OTHER);
      expect(u.pending[0]?.type).toBe("awaiting_confirmation");
      const conf = (await s.store.write((tx) =>
        resolveInTx(tx, {
          actor: OTHER as never,
          task: null,
          now: now(),
          windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
          visibility: { kind: "all" },
          params: { id: u.pending[0]?.id, decision: "confirm", item_ver: u.pending[0]?.item_ver },
          newId,
          reads: readBufferOf(s.store),
        }),
      )) as unknown as { write: { seq: number } };
      const by = { seq: conf.write.seq, actor: asActor(OTHER) };
      expect(await bothAt({ valid_at: "2026-11-02" })).toEqual([]);
      // A write from before the undo meets the stretch: its by and the details name the undo.
      const z = await loose({
        intent: "update",
        entity: e,
        ver: verAt(w2),
        valid_from: "2026-11-01",
        valid_to: "2026-11-05",
        set: { c: "q" },
      });
      const part = partsOf(z, "c").find((p) => p["result"] === "candidate") as Record<
        string,
        unknown
      >;
      expect(part["by"]).toEqual(by);
      const d = await detailOf(part["item"] as string);
      expect(d.effective).toMatchObject({ ...by, exists: false });
      expect(d.effective["spans"]).toEqual([
        { ...iv("2026-11-01", "2026-11-05", "2026-11-04"), values: null, ...by },
      ]);
    },
    T,
  );

  it(
    "a clear, then a revoke over it: no value again, on both paths",
    async () => {
      const a = await loose({
        intent: "insert",
        valid_from: "2026-11-01",
        valid_to: "2026-11-10",
        set: { b: "x" },
      });
      const e = entityOf(a);
      const c = await loose({
        intent: "update",
        entity: e,
        ver: verAt(a),
        valid_from: "2026-11-01",
        valid_to: "2026-11-10",
        set: { b: null },
      });
      expect((await bothAt({ valid_at: "2026-11-03" })).map(asAt)).toEqual([
        ["2026-11-01", { b: null, c: null }],
      ]);
      await loose({
        intent: "revoke",
        entity: e,
        ver: verAt(c),
        valid_from: "2026-11-01",
        valid_to: "2026-11-10",
      });
      expect(await bothAt({ valid_at: "2026-11-03" })).toEqual([]);
    },
    T,
  );
});

describe("a stretch both revoked and left without a value by a later undo (04-contract-types §5.1 by)", () => {
  it(
    "the giver is the later of the two: the undo that took the value away",
    async () => {
      // loose: b over [11-15, 11-20); revoked from 11-01, then revoked again by another principal;
      // c written over [11-15, 11-20) (the stretch has a value again, {b: null, c: c4}); undoing
      // the first revoke with what came after awaits, and is confirmed: c is written back without
      // a value there, while the second revoke still holds it.
      const lo = (op: Record<string, unknown>, actor = USER) =>
        send({ sv: 1, ops: [{ table: "loose", ...op }] }, { actor });
      const a = await lo({
        intent: "insert",
        valid_from: "2026-11-15",
        valid_to: "2026-11-20",
        set: { b: "b7" },
      });
      const e = a.ops[0]?.target.entity as string;
      const whole = { valid_from: "2026-11-01", valid_to: "open" };
      const r1 = await lo({ entity: e, intent: "revoke", ver: verAt(a), ...whole });
      const r2 = await lo({ entity: e, intent: "revoke", ver: verAt(r1), ...whole }, OTHER);
      const w = await lo({
        entity: e,
        intent: "update",
        ver: verAt(r2),
        valid_from: "2026-11-15",
        valid_to: "2026-11-20",
        set: { c: "c4" },
      });
      const u = await lo({
        entity: e,
        revert: { undo: r1.seq, include_later: true },
        ver: verAt(w),
      });
      expect(u.pending?.[0]?.type).toBe("awaiting_confirmation");
      const conf = (await s.store.write((tx) =>
        resolveInTx(tx, {
          actor: OTHER as never,
          task: null,
          now: now(),
          windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
          visibility: { kind: "all" },
          params: {
            id: u.pending?.[0]?.id,
            decision: "confirm",
            item_ver: u.pending?.[0]?.item_ver,
          },
          newId,
          reads: readBufferOf(s.store),
        }),
      )) as unknown as { write: { seq: number } };
      // Both cells on the stretch: the existence one revoked by the second revoke, c's without a
      // value by the confirmation.
      const cells = await s.store.read((tx) =>
        tx.query<{
          field_id: string;
          revoked: boolean | null;
          no_value: boolean | null;
          op: unknown;
        }>(
          `SELECT field_id, revoked, no_value, (SELECT op FROM events e WHERE e.seq = v.src_event) AS op
           FROM t_t5_v1__ver v WHERE row_id = $1 AND rec_to IS NULL ORDER BY field_id`,
          [e],
        ),
      );
      expect(cells.rows.map((x) => [x.field_id, x.revoked, x.no_value, Number(x.op)])).toEqual([
        ["existence", true, null, r2.seq],
        ["f3", null, true, conf.write.seq],
      ]);
      // A write from the second revoke's version meets the stretch: by is the confirmation.
      const z = await lo({
        entity: e,
        intent: "update",
        ver: verAt(r2),
        valid_from: "2026-11-15",
        valid_to: "2026-11-20",
        set: { c: "zz" },
      });
      const part = partsOf(z, "c").find((p) => p["result"] === "candidate") as Record<
        string,
        unknown
      >;
      const by = { seq: conf.write.seq, actor: asActor(OTHER) };
      expect(part["by"]).toEqual(by);
      const d = (await pending$(
        s.store,
        createOpsContext({
          tenant: TENANT,
          actor: `ci_${"3".repeat(26)}`,
          trigger: null,
          task: null,
          visibility: { kind: "all" },
          idempotency_key_window: 86_400_000,
          idempotency_window: 600_000,
          now: now(),
          confirmation: null,
        }),
        { id: part["item"] as string },
      )) as unknown as { effective: Record<string, unknown> };
      expect(d.effective).toMatchObject({ ...by, exists: false });
    },
    T,
  );
});

describe("no_value is part of a version cell (02-architecture §8)", () => {
  const lo = (op: Record<string, unknown>, actor = USER) =>
    send({ sv: 1, ops: [{ table: "loose", ...op }] }, { actor });
  /** The entity at a point, by the business table and by the version table (later pages). */
  const at = async (entity: string, day: string) => {
    const read = (asOf: boolean) =>
      s.store.read(async (tx) => {
        const latest = Number(
          (await tx.query<{ op: unknown }>("SELECT max(op) AS op FROM events")).rows[0]?.op,
        );
        return (
          await queryInTx(tx, {
            actor: USER as never,
            task: null,
            now: "2026-11-05T12:00:00.000Z" as never,
            visibility: { kind: "all" },
            params: { table: "loose", valid_at: day },
            read: "rd_0000000000000000" as never,
            ...(asOf ? { asOf: latest } : {}),
          })
        ).result.rows
          .filter((x) => (x as { entity?: string }).entity === entity)
          .map((x) => (x as { values: unknown }).values);
      });
    const first = await read(false);
    expect(await read(true)).toEqual(first);
    return first;
  };
  /** b over [11-01, 11-10) where the entity had nothing (it is made over [11-15, 11-20)), and c. */
  const written = async (cTo: string) => {
    const a = await lo({
      intent: "insert",
      valid_from: "2026-11-15",
      valid_to: "2026-11-20",
      set: { b: "x" },
    });
    const e = a.ops[0]?.target.entity as string;
    const b = await lo({
      entity: e,
      intent: "update",
      ver: verAt(a),
      valid_from: "2026-11-01",
      valid_to: "2026-11-10",
      set: { b: "y" },
      acknowledge: ["overwrite"],
    });
    const c = await lo({
      entity: e,
      intent: "update",
      ver: verAt(b),
      valid_from: "2026-11-01",
      valid_to: cTo,
      set: { c: "z" },
    });
    // b undone: written back without a value over [11-01, 11-10).
    const u = await lo({
      entity: e,
      revert: { undo: b.seq },
      ver: verAt(c),
      acknowledge: ["overwrite"],
    });
    return { e, c, u };
  };

  it(
    "two touching cells the same but for no_value stay two: one stretch with a value, one without",
    async () => {
      // c over [11-01, 11-05) only: b's write-back cell is a field empty there, and says the
      // entity has no value over [11-05, 11-10); same value, same giver, side by side.
      const { e } = await written("2026-11-05");
      expect(await at(e, "2026-11-03")).toEqual([{ b: null, c: "z" }]);
      expect(await at(e, "2026-11-07")).toEqual([]);
    },
    T,
  );

  it(
    "a cell that turns from an empty field into no value is closed and opened again",
    async () => {
      // c over all of [11-01, 11-10): b's write-back cell is an empty field over the whole
      // stretch. Undoing c leaves the entity no value there: the same cell (field, interval,
      // giver) now says no value.
      const { e, c, u } = await written("2026-11-10");
      expect(await at(e, "2026-11-03")).toEqual([{ b: null, c: "z" }]);
      await lo({ entity: e, revert: { undo: c.seq }, ver: verAt(u), acknowledge: ["overwrite"] });
      expect(await at(e, "2026-11-03")).toEqual([]);
    },
    T,
  );
});

describe("a candidate's effective, decoded from the cell's columns as the write gave it (04-contract-types §5.1)", () => {
  const ga = (op: Record<string, unknown>, actor = USER) =>
    send({ sv: 1, ops: [{ table: "gauges", ...op }] }, { actor });
  const afterOf = (r: { ops: readonly { fields: Record<string, unknown> }[] }, field: string) =>
    ((r.ops[0]?.fields[field] ?? []) as Record<string, unknown>[])[0]?.["after"];

  it(
    "a quantity and a zoned date-time: the effective is the after of the write that gave it, key for key",
    async () => {
      const a = await ga({
        intent: "insert",
        valid_from: "2026-11-01",
        set: { amount: { value: "5", unit: "km" }, at: "2026-11-01T12:00:00+08:00[Asia/Shanghai]" },
      });
      const e = a.ops[0]?.target.entity as string;
      const w = await ga({
        entity: e,
        intent: "update",
        ver: verAt(a),
        valid_from: "2026-11-05",
        set: {
          amount: { value: "7.25", unit: "km" },
          at: "2026-11-05T09:30:00+01:00[Europe/Paris]",
        },
      });
      // From the insert's version, each field met over [11-05, …): a candidate, effective w's.
      for (const [field, value] of [
        ["amount", { value: "9", unit: "km" }],
        ["at", "2026-11-06T10:00:00+09:00[Asia/Tokyo]"],
      ] as const) {
        const z = await ga(
          {
            entity: e,
            intent: "update",
            ver: verAt(a),
            valid_from: "2026-11-05",
            set: { [field]: value },
          },
          OTHER,
        );
        const part = partsOf(z, field).find((p) => p["result"] === "candidate") as Record<
          string,
          unknown
        >;
        expect(part["by"]).toEqual({ seq: w.seq, actor: asActor(USER) });
        // The same JSON text: the value and the order of its keys.
        expect(JSON.stringify(part["effective"])).toBe(JSON.stringify(afterOf(w, field)));
      }
    },
    T,
  );
});

describe("a revert proposal awaiting confirmation: what it shows is what confirming it does (05-time «高影响写入»)", () => {
  // Reads by a third principal: a principal that read the item and then writes supersedes it
  // (01-objects «不过期»), and these cases are about refreshing it.
  const THIRD = `ci_${"3".repeat(26)}`;
  /** A principal that writes without having read the item. */
  const FOURTH = `ci_${"4".repeat(26)}`;
  const ctxOf = (actor: string) =>
    createOpsContext({
      tenant: TENANT,
      actor,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_key_window: 86_400_000,
      idempotency_window: 600_000,
      now: now(),
      confirmation: null,
    });
  const put = (op: Record<string, unknown>, actor = USER) =>
    send({ sv: 1, ops: [{ table: "entities", ...op }] }, { actor });
  type Detail = {
    item_ver: string;
    status: string;
    target: { spans?: Record<string, unknown>[] };
    impact?: { reverted?: { seq: number }[]; overwritten?: unknown[] };
    superseded?: { reason: string; by: number };
  };
  const detail = async (id: string) =>
    (await pending$(s.store, ctxOf(THIRD), { id })) as unknown as Detail;
  const decide = async (params: Record<string, unknown>) => {
    try {
      return (await s.store.write((tx) =>
        resolveInTx(tx, {
          actor: OTHER as never,
          task: null,
          now: now(),
          windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
          visibility: { kind: "all" },
          params,
          newId,
          reads: readBufferOf(s.store),
        }),
      )) as unknown as Record<string, unknown>;
    } catch (e) {
      const x = e as { code?: string; detail?: Record<string, unknown> };
      if (x.code === undefined) throw e;
      return { refused: x.code, ...(x.detail ?? {}) };
    }
  };
  /** The parts of `*` (or a field) the confirmation's write gave, as intervals. */
  const written = (r: Record<string, unknown>, field = "*") =>
    (
      ((r["write"] as { ops: { fields: Record<string, unknown> }[] }).ops[0]?.fields[field] ??
        []) as { valid?: unknown }[]
    ).map((p) => p.valid);
  const marksOf = async (entity: string) =>
    (
      await s.store.read((tx) =>
        queryInTx(tx, {
          actor: THIRD as never,
          task: null,
          now: "2026-11-05T12:00:00.000Z" as never,
          visibility: { kind: "all" },
          params: { table: "entities", valid_during: ["2026-10-01", null], clip: false },
          read: "rd_0000000000000000" as never,
        }),
      )
    ).result.rows
      .filter((x) => (x as { entity?: string }).entity === entity)
      .map((x) => {
        const y = x as unknown as {
          valid_from: string;
          valid_to: string | null;
          marks?: { awaiting?: { spans?: unknown[] }[] };
        };
        const a = y.marks?.awaiting?.[0];
        return [y.valid_from, y.valid_to, a === undefined ? "none" : (a.spans ?? "whole")];
      });
  const span = (from: string | null, to: string | null, incl?: string) => ({
    valid_from: from,
    valid_to: to,
    ...(incl !== undefined ? { valid_to_inclusive: incl } : {}),
  });

  it(
    "widened by a refresh: the item, its flag and the confirmation all say the whole time",
    async () => {
      // An entity over [11-01, 11-20); revoked whole and the revoke undone; an interval revoke
      // [11-05, 11-10); another principal undoes the undo: awaiting, two spans either side.
      const a = await put({
        intent: "insert",
        valid_from: "2026-11-01",
        valid_to: "2026-11-20",
        set: { b: "b0" },
      });
      const e = a.ops[0]?.target.entity as string;
      const w = await put({ entity: e, intent: "revoke", ver: verAt(a) });
      const c = await put({ entity: e, intent: "correct", revert: { undo: w.seq }, ver: verAt(w) });
      const r = await put({
        entity: e,
        intent: "revoke",
        ver: verAt(c),
        valid_from: "2026-11-05",
        valid_to: "2026-11-10",
      });
      const u = await put(
        { entity: e, intent: "correct", revert: { undo: c.seq }, ver: verAt(r) },
        OTHER,
      );
      const item = u.pending?.[0]?.id as string;
      const proposed = await detail(item);
      expect(proposed.target.spans).toEqual([
        span(null, "2026-11-05", "2026-11-04"),
        span("2026-11-10", null),
      ]);
      // The interval revoke undone: confirming now would revoke the whole time.
      const x = await put({ entity: e, revert: { undo: r.seq }, ver: verAt(r) });
      const widened = await detail(item);
      expect(widened.target.spans).toEqual([span(null, null)]);
      expect(widened.item_ver).not.toBe(proposed.item_ver);
      expect(await marksOf(e)).toEqual([["2026-11-01", "2026-11-20", "whole"]]);
      // The old item version is no longer current: confirmation_mismatch, its current the details
      // with the new spans (through the operation, which reads them).
      const mismatch = await resolve$(s.store, ctxOf(OTHER), {
        id: item,
        decision: "confirm",
        item_ver: proposed.item_ver,
      }).then(
        () => undefined,
        (err: unknown) => err as { code?: string; detail?: { current?: Detail } },
      );
      expect(mismatch?.code).toBe("confirmation_mismatch");
      expect(mismatch?.detail?.current).toMatchObject({
        item_ver: widened.item_ver,
        target: { spans: [span(null, null)] },
      });
      // A later write elsewhere: listed in the impact, and taken back by the confirmation.
      const y = await put({
        entity: e,
        intent: "update",
        ver: verAt(x),
        valid_from: "2026-10-20",
        valid_to: "2026-10-25",
        set: { b: "early" },
      });
      const before = await detail(item);
      expect(before.target.spans).toEqual([span(null, null)]);
      expect(before.impact?.reverted?.map((q) => q.seq)).toEqual([y.seq]);
      const done = await decide({ id: item, decision: "confirm", item_ver: before.item_ver });
      expect(written(done)).toEqual(before.target.spans);
      expect(await marksOf(e)).toEqual([]);
    },
    T,
  );

  it(
    "narrowed by a refresh: the flag leaves what it no longer covers, the confirmation writes the rest",
    async () => {
      // b0 over [11-01, 11-20); b1 over [11-05, 11-15); undoing that awaits (two change points
      // go). Another principal then corrects [11-05, 11-10): only [11-10, 11-15) is left to undo.
      const a = await put({
        intent: "insert",
        valid_from: "2026-11-01",
        valid_to: "2026-11-20",
        set: { b: "b0" },
      });
      const e = a.ops[0]?.target.entity as string;
      const b1 = await put({
        entity: e,
        intent: "update",
        ver: verAt(a),
        valid_from: "2026-11-05",
        valid_to: "2026-11-15",
        set: { b: "b1" },
      });
      const u = await put({ entity: e, revert: { undo: b1.seq }, ver: verAt(b1) }, OTHER);
      const item = u.pending?.[0]?.id as string;
      expect((await detail(item)).target.spans).toEqual([
        span("2026-11-05", "2026-11-15", "2026-11-14"),
      ]);
      await put(
        {
          entity: e,
          intent: "correct",
          ver: verAt(b1),
          valid_from: "2026-11-05",
          valid_to: "2026-11-10",
          set: { b: "b3" },
        },
        FOURTH,
      );
      const narrowed = await detail(item);
      expect(narrowed.target.spans).toEqual([span("2026-11-10", "2026-11-15", "2026-11-14")]);
      expect(await marksOf(e)).toEqual([
        ["2026-11-01", "2026-11-05", "none"],
        ["2026-11-05", "2026-11-10", "none"],
        ["2026-11-10", "2026-11-15", [span("2026-11-10", "2026-11-15", "2026-11-14")]],
        ["2026-11-15", "2026-11-20", "none"],
      ]);
      const done = await decide({ id: item, decision: "confirm", item_ver: narrowed.item_ver });
      expect(written(done, "b")).toEqual(narrowed.target.spans);
    },
    T,
  );

  it(
    "nothing left to revert: closed as superseded by the write that left it so, in its transaction",
    async () => {
      const a = await put({ intent: "insert", valid_from: "2026-11-01", set: { b: "b0" } });
      const e = a.ops[0]?.target.entity as string;
      const b1 = await put({
        entity: e,
        intent: "update",
        ver: verAt(a),
        valid_from: "2026-11-05",
        valid_to: "2026-11-10",
        set: { b: "b1" },
      });
      const u = await put({ entity: e, revert: { undo: b1.seq }, ver: verAt(b1) });
      const item = u.pending?.[0]?.id as string;
      const proposed = await detail(item);
      // Another principal corrects all of [11-05, 11-10): nothing of b1 is left in effect.
      const c = await put(
        {
          entity: e,
          intent: "correct",
          ver: verAt(b1),
          valid_from: "2026-11-05",
          valid_to: "2026-11-10",
          set: { b: "b3" },
        },
        FOURTH,
      );
      expect(c.superseded).toEqual([
        expect.objectContaining({ item, reason: "nothing_to_revert" }),
      ]);
      const closed = await detail(item);
      expect(closed.status).toBe("superseded");
      expect(closed.superseded).toMatchObject({ reason: "nothing_to_revert", by: c.seq });
      // The proposal and the spans it had stay in the details, as history.
      expect(closed.target.spans).toEqual(proposed.target.spans);
      expect(await marksOf(e)).toEqual([
        ["2026-11-01", "2026-11-05", "none"],
        ["2026-11-05", "2026-11-10", "none"],
        ["2026-11-10", null, "none"],
      ]);
      // Neither confirmed nor rejected now: item_closed, with the closing.
      for (const decision of ["confirm", "reject"]) {
        expect(await decide({ id: item, decision, item_ver: proposed.item_ver })).toMatchObject({
          refused: "item_closed",
          reason: "superseded",
        });
      }
      // A later write that gives the undo something to do again does not bring it back.
      await put({ entity: e, revert: { undo: c.seq }, ver: verAt(c), acknowledge: ["overwrite"] });
      expect((await detail(item)).status).toBe("superseded");
    },
    T,
  );

  it(
    "a high impact write awaiting confirmation keeps the interval it proposed",
    async () => {
      // b0 over [11-01, 11-20), b1 over [11-05, 11-10); a write of b2 over [11-01, 11-20) would
      // take away those change points: it awaits, proposing [11-01, 11-20).
      const a = await put({
        intent: "insert",
        valid_from: "2026-11-01",
        valid_to: "2026-11-20",
        set: { b: "b0" },
      });
      const e = a.ops[0]?.target.entity as string;
      const b1 = await put({
        entity: e,
        intent: "update",
        ver: verAt(a),
        valid_from: "2026-11-05",
        valid_to: "2026-11-10",
        set: { b: "b1" },
      });
      const p = await put({
        entity: e,
        intent: "update",
        ver: verAt(b1),
        valid_from: "2026-11-01",
        valid_to: "2026-11-20",
        set: { b: "b2" },
      });
      const item = p.pending?.[0]?.id as string;
      expect(p.pending?.[0]?.type).toBe("awaiting_confirmation");
      const proposed = await detail(item);
      // A write inside the interval refreshes the item; its interval stays the proposal's.
      await put(
        {
          entity: e,
          intent: "update",
          ver: verAt(b1),
          valid_from: "2026-11-12",
          valid_to: "2026-11-14",
          set: { b: "b4" },
        },
        THIRD,
      );
      const refreshed = await detail(item);
      expect(refreshed.item_ver).not.toBe(proposed.item_ver);
      expect(refreshed.target.spans).toEqual(proposed.target.spans);
    },
    T,
  );

  /**
   * A timeless row restored, revoked and restored again by undos, b written, and another principal's
   * undo of the last restore awaiting (it would revoke the row again and hide b); then the row is
   * revoked: confirming would write nothing back, and b is hidden by the revoke, not the proposal.
   */
  const rowRevokedUnderProposal = async () => {
    const putRow = (op: Record<string, unknown>, actor = USER) =>
      send({ sv: 1, ops: [{ table: "rows", ...op }] }, { actor });
    const e = await putRow({ intent: "insert", set: { b: "b0", c: "c0" } });
    const row = e.ops[0]?.target.row as string;
    const r1 = await putRow({ row, intent: "revoke", ver: verAt(e) });
    const u1 = await putRow(
      {
        row,
        revert: { undo: r1.seq, include_later: true },
        ver: verAt(r1),
        acknowledge: ["overwrite"],
      },
      OTHER,
    );
    const u2 = await putRow({ row, revert: { undo: u1.seq }, ver: verAt(u1) });
    const u3 = await putRow({
      row,
      revert: { undo: u2.seq },
      ver: verAt(u2),
      acknowledge: ["overwrite"],
    });
    const w = await putRow({ row, intent: "update", ver: verAt(u3), set: { b: "b6" } });
    const p = await putRow({ row, revert: { undo: u3.seq }, ver: verAt(w) }, OTHER);
    const item = p.pending?.[0]?.id as string;
    const proposed = await detail(item);
    expect(proposed.impact?.reverted?.map((x) => x.seq)).toEqual([w.seq]);
    const rv = await putRow({ row, intent: "revoke", ver: verAt(w) });
    return { item, proposed, rv };
  };

  it(
    "a timeless row revoked under an awaiting undo that would hide a later write: nothing left to revert",
    async () => {
      const { item, proposed, rv } = await rowRevokedUnderProposal();
      // The item closes in the revoke's transaction.
      expect(rv.superseded).toEqual([
        expect.objectContaining({ item, reason: "nothing_to_revert" }),
      ]);
      expect(rv.pending).toEqual([]);
      const closed = await detail(item);
      expect(closed.status).toBe("superseded");
      expect(closed.superseded).toMatchObject({ reason: "nothing_to_revert", by: rv.seq });
      for (const decision of ["confirm", "reject"]) {
        expect(await decide({ id: item, decision, item_ver: proposed.item_ver })).toMatchObject({
          refused: "item_closed",
          reason: "superseded",
        });
      }
    },
    T,
  );

  it(
    "confirming a revert proposal that would write nothing, still open in a log without its closing, is refused",
    async () => {
      const { item, rv } = await rowRevokedUnderProposal();
      // The same log without the item.superseded that closed it (the last event of the revoke):
      // replayed, the item is open while confirming it would write nothing back.
      const log = await s.store.read(async (tx) => ({
        events: (await tx.query("SELECT * FROM events ORDER BY seq")).rows,
        content: (await tx.query("SELECT * FROM content ORDER BY seq, path")).rows,
      }));
      const closing = log.events.filter(
        (x) => (x as { type: string }).type === "item.superseded",
      ) as { seq: unknown; op: unknown }[];
      expect(closing.map((x) => Number(x.op))).toEqual([rv.seq]);
      const drop = Number(closing[0]?.seq);
      expect(drop).toBe(Number((log.events.at(-1) as { seq: unknown }).seq));
      await s.reset();
      await s.store.write(async (tx) => {
        for (const [name, list] of [
          ["events", log.events],
          ["content", log.content],
        ] as const) {
          for (const r of list) {
            if (Number((r as { seq: unknown }).seq) === drop) continue;
            const cols = Object.keys(r as object);
            await tx.query(
              `INSERT INTO ${name} (${cols.join(", ")}) VALUES (${cols.map((_, n) => `$${n + 1}`).join(", ")})`,
              Object.values(r as object) as never,
            );
          }
        }
        const last = (await readTail(tx))?.seq ?? 0;
        await applyEvents(tx, await readEvents(tx, 1, last));
      });
      const open = await detail(item);
      expect(open.status).toBe("open");
      const tail = await s.store.read(async (tx) => (await readTail(tx))?.seq);
      expect(
        await decide({ id: item, decision: "confirm", item_ver: open.item_ver }),
      ).toMatchObject({ refused: "internal", reason: "inconsistent" });
      // Nothing was written.
      expect(await s.store.read(async (tx) => (await readTail(tx))?.seq)).toBe(tail);
    },
    T,
  );

  /**
   * b0 over [11-01, 11-05), OTHER's b1 over [11-05, 11-10), and OTHER's undo of it awaiting (it
   * would leave [11-05, 11-10) without a value, taking away a change point: high impact).
   */
  const proposalOverC = async () => {
    const a = await put({
      intent: "insert",
      valid_from: "2026-11-01",
      valid_to: "2026-11-05",
      set: { b: "b0" },
    });
    const e = a.ops[0]?.target.entity as string;
    const w = await put(
      {
        entity: e,
        intent: "update",
        ver: verAt(a),
        valid_from: "2026-11-05",
        valid_to: "2026-11-10",
        set: { b: "b1" },
      },
      OTHER,
    );
    const p = await put({ entity: e, revert: { undo: w.seq }, ver: verAt(w) }, OTHER);
    const item = p.pending?.[0]?.id as string;
    expect(p.pending?.[0]?.type).toBe("awaiting_confirmation");
    return { e, w, item };
  };
  /** The `by_event` of the item's `item.superseded`, and the `write.base` events of an operation. */
  const supersededBy = async (item: string) =>
    s.store.read(async (tx) => {
      const r = await tx.query<{ body: string }>(
        `SELECT c.body FROM content c JOIN events e ON e.seq = c.seq
         WHERE e.type = 'item.superseded' AND c.path = 'target'`,
      );
      const t = r.rows.map((x) => JSON.parse(x.body)).find((x) => x.item === item);
      return Number(t?.by_event);
    });
  const basesOf = async (op: number) =>
    s.store.read(async (tx) =>
      (
        await tx.query<{ seq: unknown }>(
          "SELECT seq FROM events WHERE op = $1 AND type = 'write.base' ORDER BY seq",
          [op],
        )
      ).rows.map((x) => Number(x.seq)),
    );

  it(
    "a writer that had read a revert proposal and leaves it nothing to do supersedes it as overwritten",
    async () => {
      const { e, w, item } = await proposalOverC();
      await pending$(s.store, ctxOf(USER), { id: item });
      const u = await put({
        entity: e,
        revert: { undo: w.seq },
        ver: verAt(w),
        acknowledge: ["overwrite"],
      });
      expect(u.status).toBe("saved");
      expect(u.superseded).toEqual([expect.objectContaining({ item, reason: "overwritten" })]);
      expect((await detail(item)).superseded).toMatchObject({ reason: "overwritten", by: u.seq });
    },
    T,
  );

  it(
    "the proposer, who has read its own proposal, leaving it nothing to do supersedes it as overwritten",
    async () => {
      const { e, w, item } = await proposalOverC();
      const c = await put(
        {
          entity: e,
          intent: "correct",
          ver: verAt(w),
          valid_from: "2026-11-05",
          valid_to: "2026-11-10",
          set: { b: "b3" },
        },
        OTHER,
      );
      expect(c.superseded).toEqual([expect.objectContaining({ item, reason: "overwritten" })]);
    },
    T,
  );

  it(
    "a writer that had read a revert proposal and widens it, writing outside its interval, supersedes it",
    async () => {
      // b0 over [11-01, 11-20); OTHER's b1 over [11-05, 11-15); USER revokes [11-10, 11-15); OTHER's
      // undo of b1 awaits over [11-05, 11-10).
      const a = await put({
        intent: "insert",
        valid_from: "2026-11-01",
        valid_to: "2026-11-20",
        set: { b: "b0" },
      });
      const e = a.ops[0]?.target.entity as string;
      const w = await put(
        {
          entity: e,
          intent: "update",
          ver: verAt(a),
          valid_from: "2026-11-05",
          valid_to: "2026-11-15",
          set: { b: "b1" },
        },
        OTHER,
      );
      const rv = await put({
        entity: e,
        intent: "revoke",
        ver: verAt(w),
        valid_from: "2026-11-10",
        valid_to: "2026-11-15",
      });
      const p = await put({ entity: e, revert: { undo: w.seq }, ver: verAt(rv) }, OTHER);
      const item = p.pending?.[0]?.id as string;
      expect((await detail(item)).target.spans).toEqual([
        span("2026-11-05", "2026-11-10", "2026-11-09"),
      ]);
      await pending$(s.store, ctxOf(USER), { id: item });
      // USER undoes its revoke: b1 is back on [11-10, 11-15), which the proposal would now undo too.
      const u = await put({
        entity: e,
        revert: { undo: rv.seq },
        ver: verAt(rv),
        acknowledge: ["overwrite"],
      });
      expect(u.status).toBe("saved");
      expect(u.superseded).toEqual([expect.objectContaining({ item, reason: "overwritten" })]);
    },
    T,
  );

  it(
    "a high impact write awaiting confirmation is refreshed, not closed, by a write that reaches it",
    async () => {
      // b0 over [11-01, 11-20), b1 over [11-05, 11-10); b2 over [11-01, 11-20) awaits (it would take
      // away those change points). The closing of a revert proposal with nothing to do is not for it.
      const a = await put({
        intent: "insert",
        valid_from: "2026-11-01",
        valid_to: "2026-11-20",
        set: { b: "b0" },
      });
      const e = a.ops[0]?.target.entity as string;
      const b1 = await put({
        entity: e,
        intent: "update",
        ver: verAt(a),
        valid_from: "2026-11-05",
        valid_to: "2026-11-10",
        set: { b: "b1" },
      });
      const p = await put({
        entity: e,
        intent: "update",
        ver: verAt(b1),
        valid_from: "2026-11-01",
        valid_to: "2026-11-20",
        set: { b: "b2" },
      });
      const item = p.pending?.[0]?.id as string;
      expect(p.pending?.[0]?.type).toBe("awaiting_confirmation");
      const w = await put(
        {
          entity: e,
          intent: "correct",
          ver: verAt(b1),
          valid_from: "2026-11-12",
          valid_to: "2026-11-14",
          set: { b: "b4" },
        },
        FOURTH,
      );
      expect(w.superseded).toEqual([]);
      expect(w.pending).toEqual([expect.objectContaining({ id: item, refreshed: true })]);
      expect((await detail(item)).status).toBe("open");
    },
    T,
  );

  it(
    "a revert proposal's scope_valid depends on its own items and on those of what it takes back",
    async () => {
      const { w, item } = await proposalOverC();
      const [wBase] = await basesOf(w.seq);
      const deps = await s.store.read(async (tx) => {
        const r = await tx.query<{ body: string }>(
          `SELECT c.body FROM content c JOIN events e ON e.seq = c.seq
           WHERE e.type = 'item.created' AND c.path = 'scope_valid'`,
        );
        const created = await tx.query<{ body: string }>(
          `SELECT c.body FROM content c JOIN events e ON e.seq = c.seq
           WHERE e.type = 'item.created' AND c.path = 'target'`,
        );
        const at = created.rows.findIndex((x) => JSON.parse(x.body).item === item);
        return (JSON.parse(r.rows[at]?.body ?? "{}").deps ?? []) as { event: number }[];
      });
      const events = new Set(deps.map((d) => Number(d.event)));
      // b1's item (taken back) and the proposal's own.
      expect(events.has(wBase as number)).toBe(true);
      expect([...events].some((x) => x > (wBase as number))).toBe(true);
    },
    T,
  );

  it(
    "a request whose first op leaves a revert proposal nothing to do: a later op still reaches it",
    async () => {
      const { e, w, item } = await proposalOverC();
      await pending$(s.store, ctxOf(USER), { id: item });
      // The first op takes all of b1 away; the second writes inside the interval the item had as
      // the request began, which the first op emptied.
      const r = await send(
        {
          sv: 1,
          ops: [
            {
              table: "entities",
              entity: e,
              intent: "correct",
              ver: verAt(w),
              valid_from: "2026-11-05",
              valid_to: "2026-11-10",
              set: { b: "b3" },
            },
            {
              table: "entities",
              entity: e,
              intent: "correct",
              ver: verAt(w),
              valid_from: "2026-11-06",
              valid_to: "2026-11-07",
              set: { b: "b4" },
            },
          ],
        },
        { actor: USER },
      );
      expect(r.status).toBe("saved");
      expect(r.superseded).toEqual([expect.objectContaining({ item, reason: "overwritten" })]);
      // The last write that reached it is the second op's.
      const bases = await basesOf(r.seq);
      expect(bases).toHaveLength(2);
      expect(await supersededBy(item)).toBe(bases[1]);
    },
    T,
  );
});

describe("a timeless table with no required field: a row stands on a non-empty value (03-deletion «重放规则»)", () => {
  const free = (op: Record<string, unknown>) => send({ sv: 1, ops: [{ table: "free", ...op }] });
  const eventCount = async () =>
    Number(
      (await s.store.read((tx) => tx.query<{ n: unknown }>("SELECT count(*) AS n FROM events")))
        .rows[0]?.n,
    );

  it(
    "an insert of only empty values is refused, and nothing is recorded",
    async () => {
      const before = await eventCount();
      const r = await free({ intent: "insert", set: { b: null, c: null } });
      expect(r).toMatchObject({
        refused: "validation_failed",
        reason: "write",
        details: [{ op: 0, table: "ledger.free", code: "empty_row" }],
      });
      // No operation number, no write.base, no source data.
      expect(await eventCount()).toBe(before);
    },
    T,
  );

  it(
    "a write, then a clear of its only value: the row stays, every field empty, as the reference evaluator has it",
    async () => {
      const a = await free({ intent: "insert", set: { b: "x" } });
      const row = rowAt(a);
      const c = await free({ intent: "update", row, ver: verAt(a), set: { b: null } });
      expect(c.status).toBe("saved");
      const business = await s.store.read((tx) =>
        tx.query("SELECT revoked, f_f2, f_f3 FROM t_t7_v1 WHERE row_id = $1", [row]),
      );
      expect(business.rows).toEqual([{ revoked: false, f_f2: null, f_f3: null }]);
      // The cell of b is the clear's.
      const cell = await s.store.read((tx) =>
        tx.query<{ op: unknown }>(
          `SELECT (SELECT e.op FROM events e WHERE e.seq = v.src_event) AS op FROM t_t7_v1__ver v
           WHERE row_id = $1 AND field_id = 'f2' AND rec_to IS NULL`,
          [row],
        ),
      );
      expect(cell.rows.map((x) => Number(x.op))).toEqual([c.seq]);
      // The row is still written to: the clear's ver is current.
      expect((await free({ intent: "update", row, ver: verAt(c), set: { c: "y" } })).status).toBe(
        "saved",
      );
      // The reference evaluator on the same two writes: the row exists, b empty, given by the clear.
      const ref = evaluateLog({ kind: "timeless", required: [] }, [
        { kind: "write", op: 1, event: 2, fields: { f2: { value: "x", sources: ["s1"] } } },
        {
          kind: "write",
          op: 3,
          event: 4,
          seen: 1,
          fields: { f2: { value: null, sources: ["s2"] } },
        },
      ] as never).final;
      expect({ exists: ref.exists, f2: ref.fields["f2" as never] }).toEqual({
        exists: true,
        f2: [
          { valid: [{ from: null, to: null }], value: null, by: { event: 4, target: "f2", k: 0 } },
        ],
      });
    },
    T,
  );
});
