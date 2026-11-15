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
  readBufferOf,
  readEvents,
  readTail,
} from "@fluxvita/saveslot-kernel";
import {
  COMPILED_V1,
  createSlotEvents,
  queryInTx,
  writeInTx,
} from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 60_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const OTHER = `ci_${"2".repeat(26)}`;
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
  ],
};
const CHANGES = [
  { target: { slot: true }, change: "create_slot" },
  { target: { table: "t1" }, change: "add_table" },
  { target: { table: "t2" }, change: "add_table" },
  { target: { table: "t3" }, change: "add_table" },
  { target: { table: "t4" }, change: "add_table" },
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
const newId = (kind: "row" | "entity" | "source" | "item") => {
  ids++;
  const n = String(ids).padStart(kind === "row" || kind === "entity" ? 26 : 16, "0");
  return `${{ row: "r_", entity: "e_", source: "s_", item: "pi_" }[kind]}${n}`;
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
      const inside = await op({ intent: "revoke", ...span }, verAt(outside), OTHER);
      expect(
        (await ofType(inside.seq, "item.refreshed")).map(
          (x) => (x.blocks["target"] as { item: string }).item,
        ),
      ).toEqual([item]);
      // Revoked inside, the later writes are hidden already: undoing the restore hides nothing more.
      expect((await impactOf(inside.seq)).filter((b) => b.kind === "reverted_write")).toEqual([]);
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
            actor: USER,
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
        by: { seq: b.seq, actor: OTHER },
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
      by?: { seq: number; actor: string };
    }[];
    return { y, v, z, candidate: part.find((x) => x.result === "candidate") };
  };

  it(
    "on existence, the latest giver a revoke: by is the revoke, effective none, and query reads no row there",
    async () => {
      const { v, candidate } = await scenario(true);
      expect(candidate).toMatchObject({ effective: null, by: { seq: v?.seq, actor: OTHER } });
      expect(await readAt("2026-11-06")).toEqual([]);
    },
    T,
  );

  it(
    "the latest giver a write: by is that write, effective its value, as query reads it there",
    async () => {
      const { y, candidate } = await scenario(false);
      expect(candidate).toMatchObject({ effective: "y", by: { seq: y.seq, actor: OTHER } });
      expect(await readAt("2026-11-12")).toEqual([candidate?.effective]);
    },
    T,
  );
});
