// The write pipeline on PGlite, case by case (04-write-and-read «写入请求», «幂等», «判定顺序»,
// «一次写入的事件构成»; 04-contract-types §5.1, §9; 04-contract §2): the main path of each kind of
// op, the `ver` and `sv` taken from the caller's own writes, the idempotent replay, and each
// refusal. Receipts and event blocks are compared whole: a part-match would let extra keys or
// values through. The judged scenarios through the pipeline are write-pipeline.prop.test.ts.

import {
  appendOperation,
  applyEvents,
  confirmationHash,
  createOpsContext,
  createTenant,
  entryChecksums,
  eventsOf,
  flushReads,
  readBufferOf,
  readEvents,
  readTail,
  write,
} from "@fluxvita/saveslot-kernel";
import { COMPILED_V1, createSlotEvents, SLOT, writeInTx } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 60_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const OTHER = `ci_${"2".repeat(26)}`;
const fields = [
  { id: "f2", name: "b", type: "text", required: true, description: "b" },
  { id: "f3", name: "c", type: "text", description: "c" },
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
  ],
};
const CHANGES = [
  { target: { slot: true }, change: "create_slot" },
  { target: { table: "t1" }, change: "add_table" },
  { target: { table: "t2" }, change: "add_table" },
  { target: { table: "t3" }, change: "add_table" },
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

/** The n-th identifier `newId` gave in the current case. */
const idN = (kind: "row" | "entity" | "source" | "item", n: number) =>
  `${{ row: "r_", entity: "e_", source: "s_", item: "pi_", partition: "p_" }[kind]}${String(n).padStart(kind === "row" || kind === "entity" ? 26 : 16, "0")}`;

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

const tail = async () => (await s.store.read(readTail))?.seq ?? 0;
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

const HASH = expect.stringMatching(/^[0-9a-f]{64}$/);
const ANY = expect.any(String);
const ctxBlock = {
  now: ANY,
  today: "2026-11-05",
  ruleset_version: 1,
  policy_version: 1,
  literal_checker: "literal@1",
};
const receipt = (seq: number, ops: unknown[], extra: Record<string, unknown> = {}) => ({
  status: "saved",
  sv: 1,
  seq,
  ops,
  derived: [],
  derived_total: 0,
  pending: [],
  superseded: [],
  ...extra,
});
const rowAt = (r: { readonly ops: readonly { readonly target: { readonly row?: string } }[] }) =>
  r.ops[0]?.target.row as string;
const verAt = (r: { readonly ops: readonly { readonly ver?: string }[] }) =>
  r.ops[0]?.ver as string;
const insertRow = (b = "x", extra: Record<string, unknown> = {}) =>
  send({ sv: 1, ops: [{ intent: "insert", table: "rows", set: { b }, ...extra }] });
const update = (
  row: string,
  set: Record<string, unknown>,
  ver?: string,
  o: Parameters<typeof send>[1] = {},
) =>
  send(
    {
      sv: 1,
      ops: [{ intent: "update", table: "rows", row, ...(ver !== undefined ? { ver } : {}), set }],
    },
    o,
  );

describe("the main path", () => {
  it(
    "an insert without evidence: head, the op's api_call source, the write.base citing it; saved",
    async () => {
      const r = await insertRow();
      const row = idN("row", 1);
      expect(r).toEqual(
        receipt(r.seq, [
          {
            target: { table: "ledger.rows", row },
            intent: "insert",
            ver: `v${r.seq}.0`,
            fields: { b: { result: "applied", after: "x" } },
          },
        ]),
      );
      expect(await eventsOfOp(r.seq)).toEqual([
        {
          type: "write.head",
          seq: r.seq,
          blocks: {
            ctx: ctxBlock,
            request: { sv: 1, sv_basis: "explicit", op_count: 1 },
            request_key: { key: HASH },
            "ops/0/target": { table: "t1", row, intent: "insert", created: true },
            "ops/0/set/f2": "x",
          },
        },
        {
          type: "source.recorded",
          seq: r.seq + 1,
          blocks: {
            target: {
              source_id: idN("source", 2),
              kind: "api_call",
              level: "agent_inferred",
              op_index: 0,
            },
            request: { intent: "insert", table: "rows", set: { b: "x" } },
          },
        },
        {
          type: "write.base",
          seq: r.seq + 2,
          blocks: {
            target: {
              table: "t1",
              row,
              intent: "insert",
              sv: 1,
              created: true,
              cause: "request",
              op_index: 0,
            },
            "fields/f2/0": { status: "applied", value: "x" },
            "sources/f2/0": [{ kind: "value", source: r.seq + 1 }],
          },
        },
      ]);
    },
    T,
  );

  it(
    "request-level evidence: one source per segment, by its kind's level; an op's evidence_refs",
    async () => {
      const r = await send({
        sv: 1,
        evidence: [
          { kind: "user_message", text: "it is x" },
          { kind: "agent_note", text: "noted" },
        ],
        ops: [
          { intent: "insert", table: "rows", set: { b: "x" } },
          { intent: "insert", table: "rows", evidence_refs: [1], set: { b: "y" } },
        ],
      });
      const evs = await eventsOfOp(r.seq);
      expect(evs.filter((e) => e.type === "source.recorded").map((e) => e.blocks)).toEqual([
        {
          target: { source_id: idN("source", 3), kind: "user_message", level: "user_stated" },
          text: { text: "it is x" },
        },
        {
          target: { source_id: idN("source", 4), kind: "agent_note", level: "agent_inferred" },
          text: { text: "noted" },
        },
      ]);
      expect(
        evs.filter((e) => e.type === "write.base").map((e) => e.blocks["sources/f2/0"]),
      ).toEqual([
        [
          { kind: "value", source: r.seq + 1 },
          { kind: "value", source: r.seq + 2 },
        ],
        [{ kind: "value", source: r.seq + 2 }],
      ]);
    },
    T,
  );

  it(
    "an update with ver: applied, a new ver; a same-valued field a no-op, its value kept nowhere",
    async () => {
      const a = await insertRow();
      const row = rowAt(a);
      const r = await update(row, { b: "x", c: "y" }, verAt(a));
      expect(r).toEqual(
        receipt(r.seq, [
          {
            target: { table: "ledger.rows", row },
            intent: "update",
            ver: `v${r.seq}.0`,
            fields: { b: { result: "noop" }, c: { result: "applied", after: "y" } },
          },
        ]),
      );
      const [head, source] = await eventsOfOp(r.seq);
      expect(head?.blocks["ops/0/noop"]).toEqual(["f2"]);
      expect(Object.keys(head?.blocks ?? {}).filter((k) => k.startsWith("ops/0/set/"))).toEqual([
        "ops/0/set/f3",
      ]);
      // The source keeps the request without the no-op field's value: its name only.
      expect(source?.blocks["request"]).toEqual({
        intent: "update",
        table: "rows",
        row,
        ver: verAt(a),
        set: { c: "y" },
        noop: ["b"],
      });
    },
    T,
  );

  it(
    "a state table: each field an array of parts, a no-op field too; a created entity",
    async () => {
      const e = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "x" } }],
      });
      const entity = e.ops[0]?.target.entity as string;
      expect(e.ops[0]).toEqual({
        target: { table: "ledger.entities", entity },
        intent: "insert",
        ver: `v${e.seq}.0`,
        created_entity: true,
        fields: {
          b: [
            { result: "applied", after: "x", valid: { valid_from: "2026-11-01", valid_to: null } },
          ],
        },
      });
      const r = await send({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "entities",
            entity,
            ver: e.ops[0]?.ver,
            valid_from: "2026-11-01",
            set: { b: "x", c: "y" },
          },
        ],
      });
      expect(r.ops[0]?.fields).toEqual({
        b: [{ result: "noop" }],
        c: [{ result: "applied", after: "y", valid: { valid_from: "2026-11-01", valid_to: null } }],
      });
    },
    T,
  );

  it(
    "a later op of a request sees the earlier ones: the same value again is a no-op",
    async () => {
      const a = await insertRow();
      const row = rowAt(a);
      const r = await send({
        sv: 1,
        ops: [
          { intent: "update", table: "rows", row, ver: verAt(a), set: { c: "p" } },
          { intent: "update", table: "rows", row, ver: verAt(a), set: { c: "p" } },
        ],
      });
      expect(r.ops.map((o) => o.fields)).toEqual([
        { c: { result: "applied", after: "p" } },
        { c: { result: "noop" } },
      ]);
    },
    T,
  );

  it(
    "a stale ver: a candidate on a new conflict item; later stale writes join it, the third at index 2",
    async () => {
      const a = await insertRow();
      const row = rowAt(a);
      const ver = verAt(a);
      const y = await update(row, { b: "y" }, ver);
      const c1 = await update(row, { b: "z" }, ver);
      // The item's ID comes before the request's source's.
      const item = idN("item", ids - 1);
      expect(c1).toEqual(
        receipt(
          c1.seq,
          [
            {
              target: { table: "ledger.rows", row },
              intent: "update",
              ver: `v${y.seq}.0`,
              fields: {
                b: {
                  result: "candidate",
                  after: "z",
                  item,
                  effective: "y",
                  current_ver: `v${y.seq}.0`,
                  by: { seq: y.seq, actor: USER },
                  previous: { seq: a.seq, exists: true, values: { b: "x" } },
                },
              },
            },
          ],
          {
            status: "pending",
            pending: [
              {
                id: item,
                type: "conflict",
                reason: "stale_write",
                item_ver: `iv_${item.slice(3)}.${c1.seq}.0`,
              },
            ],
          },
        ),
      );
      const c2 = await update(row, { b: "w" }, ver);
      expect(c2.pending).toEqual([
        { id: item, type: "conflict", reason: "stale_write", merged: true },
      ]);
      const candidates = async (op: number) =>
        Object.keys(
          (await eventsOfOp(op)).find((e) => e.type === "item.merged")?.blocks ?? {},
        ).filter((p) => p.startsWith("candidates/"));
      expect(await candidates(c2.seq)).toEqual(["candidates/1"]);
      const c3 = await update(row, { b: "v" }, ver);
      expect(await candidates(c3.seq)).toEqual(["candidates/2"]);
    },
    T,
  );

  it(
    "a stale write seeing an older version joins the item and lowers its merge base",
    async () => {
      const a = await insertRow();
      const row = rowAt(a);
      const b = await update(row, { c: "1" }, verAt(a));
      await update(row, { b: "y" }, verAt(b));
      const z1 = await update(row, { b: "z" }, verAt(b));
      const created = (await eventsOfOp(z1.seq)).find((e) => e.type === "item.created");
      expect(
        (created?.blocks["target"] as { merge_base_op?: number } | undefined)?.merge_base_op,
      ).toBe(b.seq);
      const z2 = await update(row, { b: "w" }, verAt(a));
      const merged = (await eventsOfOp(z2.seq)).find((e) => e.type === "item.merged");
      expect(
        (merged?.blocks["target"] as { merge_base_op?: number } | undefined)?.merge_base_op,
      ).toBe(a.seq);
    },
    T,
  );

  it(
    "three stale ops of one request on one field: one conflict item, candidates 0, 1 and 2",
    async () => {
      const a = await insertRow();
      const row = rowAt(a);
      const ver = verAt(a);
      await update(row, { b: "y" }, ver);
      const r = await send({
        sv: 1,
        ops: ["z", "w", "v"].map((b) => ({
          intent: "update",
          table: "rows",
          row,
          ver,
          set: { b },
        })),
      });
      // One item, listed once: opened by this request, its contents as of the request's end.
      expect(r.pending).toEqual([
        {
          id: r.pending[0]?.id,
          type: "conflict",
          reason: "stale_write",
          item_ver: expect.stringMatching(/^iv_/),
        },
      ]);
      expect(
        (await eventsOfOp(r.seq))
          .filter((e) => e.type === "item.created" || e.type === "item.merged")
          .map((e) => Object.keys(e.blocks).filter((p) => p.startsWith("candidates/"))),
      ).toEqual([["candidates/0"], ["candidates/1"], ["candidates/2"]]);
    },
    T,
  );

  it(
    "several ops in one request: one head, one operation number, each op citing its own source",
    async () => {
      const a = await insertRow("p");
      const row = rowAt(a);
      const r = await send({
        sv: 1,
        ops: [
          { intent: "insert", table: "rows", set: { b: "q" } },
          { intent: "update", table: "rows", row, ver: verAt(a), set: { c: "r" } },
        ],
      });
      expect(r.ops.map((o) => o.ver)).toEqual([`v${r.seq}.0`, `v${r.seq}.0`]);
      const evs = await eventsOfOp(r.seq);
      expect(evs.map((e) => e.type)).toEqual([
        "write.head",
        "source.recorded",
        "source.recorded",
        "write.base",
        "write.base",
      ]);
      expect(evs[0]?.blocks["request"]).toEqual({ sv: 1, sv_basis: "explicit", op_count: 2 });
      expect(evs.slice(3).map((e) => Object.values(e.blocks).find(Array.isArray))).toEqual([
        [{ kind: "value", source: evs[1]?.seq }],
        [{ kind: "value", source: evs[2]?.seq }],
      ]);
    },
    T,
  );

  it(
    "undo without an intent takes the undone write's; revoke and undo of the revoke",
    async () => {
      const a = await insertRow();
      const row = rowAt(a);
      const c = await send({
        sv: 1,
        ops: [{ intent: "correct", table: "rows", row, ver: verAt(a), set: { b: "y" } }],
      });
      const u = await send({ sv: 1, ops: [{ table: "rows", row, revert: { undo: c.seq } }] });
      expect(u.ops[0]).toEqual({
        target: { table: "ledger.rows", row },
        intent: "correct",
        ver: `v${u.seq}.0`,
        fields: { b: { result: "applied", after: "x" } },
        undo: { of: c.seq, skipped_superseded: [] },
      });
      const v = await send({
        sv: 1,
        ops: [{ intent: "revoke", table: "rows", row, ver: verAt(u) }],
      });
      expect(v.ops[0]).toEqual({
        target: { table: "ledger.rows", row },
        intent: "revoke",
        ver: `v${v.seq}.0`,
        fields: { "*": { result: "applied" } },
      });
      const back = await send({ sv: 1, ops: [{ table: "rows", row, revert: { undo: v.seq } }] });
      expect(back.ops[0]?.fields).toEqual({ "*": { result: "applied" } });
    },
    T,
  );

  it(
    "correct on a state table with neither end: the interval is corrected_span",
    async () => {
      const e = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "x" } }],
      });
      const r = await send({
        sv: 1,
        ops: [
          {
            intent: "correct",
            table: "entities",
            entity: e.ops[0]?.target.entity,
            ver: e.ops[0]?.ver,
            set: { b: "y" },
          },
        ],
      });
      expect((await eventsOfOp(r.seq))[0]?.blocks["ops/0/valid"]).toEqual({
        from: { mode: "corrected_span" },
        to: { mode: "corrected_span" },
      });
    },
    T,
  );

  it(
    "a resolved conflict item is not joined: the next stale write opens a new one",
    async () => {
      const a = await insertRow();
      const row = rowAt(a);
      const ver = verAt(a);
      await update(row, { b: "y" }, ver);
      const c1 = await update(row, { b: "z" }, ver);
      const item = c1.pending[0]?.id as string;
      await s.store.write(async (tx) => {
        const hash = confirmationHash(await entryChecksums(tx, item));
        const op = await appendOperation(tx, {
          actor: USER as never,
          now: now() as never,
          events: [
            {
              type: "item.resolved",
              slot: SLOT as never,
              blocks: {
                ctx: {
                  now: "2026-11-05T09:00:00.000Z",
                  today: "2026-11-05",
                  ruleset_version: 1,
                  policy_version: 1,
                },
                target: {
                  item,
                  decision: "keep_effective",
                  item_op: c1.seq,
                  restore_count: 0,
                  via: "call",
                },
                ...(hash !== undefined ? { confirmation: { hash } } : {}),
              },
            },
          ],
        });
        await applyEvents(tx, eventsOf(op));
      });
      const c2 = await update(row, { b: "w" }, ver);
      expect(c2.pending).toEqual([
        {
          id: idN("item", ids - 1),
          type: "conflict",
          reason: "stale_write",
          item_ver: `iv_${idN("item", ids - 1).slice(3)}.${c2.seq}.0`,
        },
      ]);
      expect(c2.pending[0]?.id).not.toBe(item);
    },
    T,
  );

  it(
    "the ops entry: identifiers of its own; a row's receipt carries no created_entity",
    async () => {
      const ctx = createOpsContext({
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
      const r = await write(s.store, ctx, {
        sv: 1,
        ops: [{ intent: "insert", table: "rows", set: { b: "x" } }],
      });
      const row = rowAt(r as never);
      expect(row).toMatch(/^r_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(r).toEqual(
        receipt(r.seq, [
          {
            target: { table: "ledger.rows", row },
            intent: "insert",
            ver: `v${r.seq}.0`,
            fields: { b: { result: "applied", after: "x" } },
          },
        ]),
      );
    },
    T,
  );
});

describe("ver and sv taken from the caller's own writes", () => {
  it(
    "ver from the caller's latest write that changed the row: recorded as a fallback, warned in the receipt",
    async () => {
      const a = await insertRow();
      const row = rowAt(a);
      const b = await update(row, { c: "1" }, verAt(a));
      const r = await update(row, { b: "y" });
      expect(r).toEqual(
        receipt(
          r.seq,
          [
            {
              target: { table: "ledger.rows", row },
              intent: "update",
              ver: `v${r.seq}.0`,
              fields: { b: { result: "applied", after: "y" } },
            },
          ],
          { warnings: [{ code: "ver_fallback", op: 0, ver: `v${b.seq}.0`, from_write: b.seq }] },
        ),
      );
      expect(
        ((await eventsOfOp(r.seq))[0]?.blocks["ops/0/target"] as { ver?: unknown } | undefined)
          ?.ver,
      ).toEqual({ op: b.seq, restore_count: 0, basis: "fallback" });
    },
    T,
  );

  it(
    "nothing to go by: read_first, no_read for another connection, task_mismatch under another task",
    async () => {
      const a = await insertRow("x", {});
      const row = rowAt(a);
      const ref = { table: "ledger.rows", row };
      expect(await update(row, { b: "y" }, undefined, { actor: OTHER })).toEqual({
        refused: "read_first",
        reason: "no_read",
        target: "row",
        ref,
        param: "ops/0/ver",
      });
      expect(await update(row, { b: "y" }, undefined, { task: "t-2" })).toEqual({
        refused: "read_first",
        reason: "task_mismatch",
        target: "row",
        ref,
        param: "ops/0/ver",
        read_task: null,
        task: "t-2",
      });
    },
    T,
  );

  it(
    "a call without a task does not take what was written under a task",
    async () => {
      const a = await send(
        { sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "x" } }] },
        { task: "t-1" },
      );
      expect(await update(rowAt(a), { b: "y" })).toEqual({
        refused: "read_first",
        reason: "task_mismatch",
        target: "row",
        ref: { table: "ledger.rows", row: rowAt(a) },
        param: "ops/0/ver",
        read_task: "t-1",
        task: null,
      });
    },
    T,
  );

  it(
    "sv left out: read_first without a write on the slot; then from the latest one, warned",
    async () => {
      expect(await send({ ops: [{ intent: "insert", table: "rows", set: { b: "x" } }] })).toEqual({
        refused: "read_first",
        reason: "no_read",
        target: "slot",
        ref: "ledger",
        param: "sv",
      });
      const a = await insertRow();
      const r = await send({ ops: [{ intent: "insert", table: "rows", set: { b: "y" } }] });
      expect(r.warnings).toEqual([{ code: "sv_fallback", sv: 1, from_write: a.seq }]);
      expect((await eventsOfOp(r.seq))[0]?.blocks["request"]).toEqual({
        sv: 1,
        sv_basis: "fallback",
        op_count: 1,
      });
    },
    T,
  );
});

describe("a ver that is not a version of the row: not_this_target, nothing written", () => {
  it(
    "another row's version, an operation that never was, a restore count not the current one",
    async () => {
      const a = await insertRow();
      const row = rowAt(a);
      await update(row, { b: "theirs" }, verAt(a), { actor: OTHER });
      const other = await insertRow("q");
      const refusal = {
        refused: "invalid_argument",
        reason: "not_this_target",
        param: "ops/0/ver",
      };
      for (const ver of [verAt(other), "v999.0", `${verAt(a).split(".")[0]}.7`]) {
        const before = await tail();
        expect(await update(row, { b: "mine" }, ver)).toEqual(refusal);
        expect(await tail()).toBe(before);
      }
    },
    T,
  );
});

describe("idempotency", () => {
  it(
    "the same request again within the window: the original receipt, replayed, nothing appended",
    async () => {
      const params = { sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "x" } }] };
      const first = await send(params);
      const before = await tail();
      expect(await send(params)).toEqual({ ...first, replayed: true });
      expect(await tail()).toBe(before);
    },
    T,
  );

  it(
    "the task in the request or in the call context: the same request key",
    async () => {
      const first = await send({
        sv: 1,
        task: "t-1",
        ops: [{ intent: "insert", table: "rows", set: { b: "x" } }],
      });
      const again = await send(
        { sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "x" } }] },
        { task: "t-1" },
      );
      expect(again).toEqual({ ...first, replayed: true });
    },
    T,
  );

  it(
    "an explicit idempotency key: the same content replays, even past the request keys' window; other content is refused",
    async () => {
      const params = {
        sv: 1,
        idempotency_key: "k-1",
        ops: [{ intent: "insert", table: "rows", set: { b: "x" } }],
      };
      const first = await send(params);
      const head = (await eventsOfOp(first.seq))[0];
      expect(head?.blocks["idempotency"]).toEqual({ key: HASH, fingerprint: HASH });
      expect(head?.blocks["request_key"]).toBeUndefined();
      expect(await send(params, { window: 0 })).toEqual({ ...first, replayed: true });
      expect(
        await send({ ...params, ops: [{ intent: "insert", table: "rows", set: { b: "y" } }] }),
      ).toEqual({
        refused: "invalid_argument",
        reason: "idempotency_key_reuse",
        param: "idempotency_key",
      });
    },
    T,
  );

  it(
    "not a resend: another connection, another task, or past the window",
    async () => {
      const params = { sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "x" } }] };
      const first = await send(params, { task: "t-1" });
      for (const o of [
        { actor: OTHER, task: "t-1" },
        { task: "t-2" },
        { task: "t-1", window: 0 },
      ]) {
        const r = await send(params, o);
        expect(r).not.toHaveProperty("replayed");
        expect(r.seq).toBeGreaterThan(first.seq);
      }
    },
    T,
  );

  it(
    "a replay after the row changed: the ver is the one the write gave, not the row's latest",
    async () => {
      const a = await insertRow();
      const row = rowAt(a);
      const params = {
        sv: 1,
        ops: [{ intent: "update", table: "rows", row, ver: verAt(a), set: { c: "p" } }],
      };
      const first = await send(params);
      await update(row, { c: "q" }, verAt(first));
      expect((await send(params)).ops[0]?.ver).toBe(`v${first.seq}.0`);
    },
    T,
  );

  it(
    "a replay whose original head content is gone: internal not_implemented, not a crash",
    async () => {
      const params = { sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "x" } }] };
      const first = await send(params);
      await s.store.write((tx) =>
        tx.query(
          "UPDATE content SET body = NULL, checksum = NULL WHERE seq = $1 AND path = 'request'",
          [first.seq],
        ),
      );
      expect(await send(params)).toEqual({ refused: "internal", reason: "not_implemented" });
    },
    T,
  );
});

describe("refusals: nothing is written", () => {
  const refused = async (params: unknown, expected: Record<string, unknown>) => {
    const before = await tail();
    expect(await send(params)).toEqual(expected);
    expect(await tail()).toBe(before);
  };

  it(
    "a table of no slot; a schema version that is not one",
    async () => {
      await refused(
        { sv: 1, ops: [{ intent: "insert", table: "nope", set: { b: "x" } }] },
        {
          refused: "unknown_table",
          code: "unknown_table",
          param: "ops/0/table",
          name: "nope",
          nearest: ["notes", "rows", "entities"],
        },
      );
      await refused(
        { sv: 2, ops: [{ intent: "insert", table: "rows", set: { b: "x" } }] },
        { refused: "invalid_argument", code: "invalid_argument", reason: "malformed", param: "sv" },
      );
    },
    T,
  );

  it(
    "a row that does not exist, or a row of another table",
    async () => {
      const a = await insertRow();
      await refused(
        {
          sv: 1,
          ops: [
            {
              intent: "update",
              table: "rows",
              row: `r_${"3".repeat(26)}`,
              ver: "v1.0",
              set: { b: "y" },
            },
          ],
        },
        { refused: "not_found", param: "ops/0" },
      );
      await refused(
        {
          sv: 1,
          ops: [
            { intent: "update", table: "notes", row: rowAt(a), ver: verAt(a), set: { b: "y" } },
          ],
        },
        { refused: "not_found", param: "ops/0" },
      );
    },
    T,
  );

  it(
    "judge's refusals: undoing the creation, a revoked row, a gap without its required field",
    async () => {
      const a = await insertRow();
      const row = rowAt(a);
      await refused(
        { sv: 1, ops: [{ table: "rows", row, revert: { undo: a.seq } }] },
        { refused: "invalid_argument", param: "ops/0", undo_target: a.seq },
      );
      const v = await send({
        sv: 1,
        ops: [{ intent: "revoke", table: "rows", row, ver: verAt(a) }],
      });
      await refused(
        { sv: 1, ops: [{ intent: "update", table: "rows", row, ver: verAt(v), set: { b: "y" } }] },
        { refused: "revoked", param: "ops/0", ops: [v.seq] },
      );
      const e = await send({
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "entities",
            valid_from: "2026-11-01",
            valid_to: "2026-11-03",
            set: { b: "x" },
          },
        ],
      });
      await refused(
        {
          sv: 1,
          ops: [
            {
              intent: "update",
              table: "entities",
              entity: e.ops[0]?.target.entity,
              ver: e.ops[0]?.ver,
              valid_from: "2026-11-05",
              valid_to: "2026-11-07",
              set: { c: "y" },
            },
          ],
        },
        {
          refused: "validation_failed",
          param: "ops/0",
          missing: ["f2"],
          valid: [{ from: "2026-11-05", to: "2026-11-07" }],
        },
      );
    },
    T,
  );
});

describe("reads: the fallback looks at the last read first; a write flushes the reads it finds", () => {
  let reads = 0;
  /** Records a read by `actor` (under `task`) of what `last` lists, as a read entry point would. */
  const read = (
    last: { kind: "ver" | "sv"; target: string; op: number }[],
    o: { actor?: string; task?: string | null } = {},
  ) => {
    const id = `rd_${String(++reads).padStart(16, "0")}`;
    readBufferOf(s.store).record({
      read: id as never,
      actor: (o.actor ?? USER) as never,
      task: o.task ?? null,
      at: now() as never,
      pos: 1 as never,
      operation: "query",
      rows: [],
      coarse: [],
      lastRead: last.map((x) => ({ ...x, restoreCount: 0 })),
    });
    return id;
  };

  it(
    "ver: the newer of the last read and the caller's own write; its own later write wins, applied",
    async () => {
      const a = await insertRow();
      const row = rowAt(a);
      read([{ kind: "ver", target: row, op: a.seq }]);
      const own = await update(row, { c: "own" }, verAt(a));
      const r = await update(row, { b: "y" });
      // Seen at its own write: no conflict with itself, and the warning names that write.
      expect(r.status).toBe("saved");
      expect(r.warnings).toEqual([
        { code: "ver_fallback", op: 0, ver: `v${own.seq}.0`, from_write: own.seq },
      ]);
    },
    T,
  );

  it(
    "ver: read after the caller's own write, another's change included: the version read, warned with the read",
    async () => {
      const a = await insertRow();
      const row = rowAt(a);
      const theirs = await update(row, { c: "theirs" }, verAt(a), { actor: OTHER });
      const r1 = read([{ kind: "ver", target: row, op: theirs.seq }]);
      const r = await update(row, { b: "y" });
      expect(r.status).toBe("saved");
      expect(r.warnings).toEqual([
        { code: "ver_fallback", op: 0, ver: `v${theirs.seq}.0`, read: r1 },
      ]);
      expect(
        ((await eventsOfOp(r.seq))[0]?.blocks["ops/0/target"] as { ver?: unknown } | undefined)
          ?.ver,
      ).toEqual({
        op: theirs.seq,
        restore_count: 0,
        basis: "fallback",
      });
    },
    T,
  );

  it(
    "sv: the schema version last read; warned with the read",
    async () => {
      const r1 = read([{ kind: "sv", target: SLOT, op: 1 }]);
      const r = await send({ ops: [{ intent: "insert", table: "rows", set: { b: "x" } }] });
      expect(r.warnings).toEqual([{ code: "sv_fallback", sv: 1, read: r1 }]);
    },
    T,
  );

  it(
    "read under another task, never written: read_first, task_mismatch with the task read under",
    async () => {
      const a = await insertRow();
      const row = rowAt(a);
      // The reads land in the stored ones first (the ops entry flushes them at its start).
      read([{ kind: "ver", target: row, op: a.seq }], { actor: OTHER, task: "t-1" });
      await flushReads(
        s.store,
        createOpsContext({
          tenant: TENANT,
          actor: "system",
          trigger: "flushReads",
          task: null,
          visibility: { kind: "all" },
          idempotency_key_window: 86_400_000,
          idempotency_window: 600_000,
          now: now(),
          confirmation: null,
        }),
      );
      expect(await update(row, { b: "y" }, undefined, { actor: OTHER })).toEqual({
        refused: "read_first",
        reason: "task_mismatch",
        target: "row",
        ref: { table: "ledger.rows", row },
        param: "ops/0/ver",
        read_task: "t-1",
        task: null,
      });
    },
    T,
  );

  it(
    "the ops entry writes the buffered reads first: they stay even when the write is refused",
    async () => {
      const r1 = read([{ kind: "sv", target: SLOT, op: 1 }]);
      const ctx = createOpsContext({
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
      await expect(
        write(s.store, ctx, { sv: 1, ops: [{ intent: "insert", table: "nope", set: { b: "x" } }] }),
      ).rejects.toMatchObject({ code: "unknown_table" });
      expect(readBufferOf(s.store).size).toBe(0);
      const kept = await s.store.read((tx) =>
        tx.query<{ read_id: string }>("SELECT read_id FROM last_read WHERE kind = 'sv'"),
      );
      expect(kept.rows.map((x) => x.read_id)).toEqual([r1]);
    },
    T,
  );
});

describe("ver: the version a receipt gives is one a later write may bring back (04-contract §2)", () => {
  const E = (entity: string) => ({ table: "entities", entity });
  /** The cells an operation opened and closed in the entity's version table. */
  const cellsOf = (op: number) =>
    s.store.read(async (tx) => {
      const q = (where: string) =>
        tx.query<{ field_id: string; f: string; t: string | null }>(
          `SELECT field_id, valid_from::text AS f, valid_to::text AS t FROM t_t2_v1__ver
           WHERE ${where} = $1 ORDER BY field_id, valid_from`,
          [op],
        );
      return { opened: (await q("rec_from")).rows, closed: (await q("rec_to")).rows };
    });

  it(
    "a stale write that only becomes a candidate gives no new version; the one it gives is accepted",
    async () => {
      // A revoke of [11-01, 11-07), a fill, its undo, the revoke's undo, a write, the undo of the
      // revoke's undo; then a stale write of c seeing the fill's undo: a candidate.
      const e = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "entities", valid_from: "2026-10-01", set: { b: "1" } }],
      });
      const entity = e.ops[0]?.target.entity as string;
      const ack = { acknowledge: ["overwrite"] };
      const v20 = await send({
        sv: 1,
        ops: [
          {
            ...E(entity),
            intent: "revoke",
            ver: verAt(e),
            valid_from: "2026-11-01",
            valid_to: "2026-11-07",
          },
        ],
      });
      const w30 = await send({
        sv: 1,
        ops: [
          {
            ...E(entity),
            intent: "update",
            ver: verAt(v20),
            valid_from: "2026-11-03",
            valid_to: "2026-11-05",
            ...ack,
            set: { b: "5" },
          },
        ],
      });
      const u40 = await send({
        sv: 1,
        ops: [{ ...E(entity), ver: verAt(w30), ...ack, revert: { undo: w30.seq } }],
      });
      const u50 = await send({
        sv: 1,
        ops: [{ ...E(entity), ver: verAt(u40), ...ack, revert: { undo: v20.seq } }],
      });
      const w60 = await send({
        sv: 1,
        ops: [
          {
            ...E(entity),
            intent: "update",
            ver: verAt(u50),
            valid_from: "2026-11-01",
            valid_to: "2026-11-03",
            ...ack,
            set: { b: "6" },
          },
        ],
      });
      await send({ sv: 1, ops: [{ ...E(entity), revert: { undo: u50.seq } }] });
      const w80 = await send({
        sv: 1,
        ops: [
          {
            ...E(entity),
            intent: "update",
            ver: verAt(u40),
            valid_from: "2026-11-01",
            valid_to: "2026-11-03",
            ...ack,
            set: { c: "1" },
          },
        ],
      });
      expect(w80.ops[0]?.fields["c"]).toMatchObject([{ result: "candidate" }]);
      // No cell opened or closed: the version stays the one before, and the receipt says so.
      expect(await cellsOf(w80.seq)).toEqual({ opened: [], closed: [] });
      expect(verAt(w80)).toBe(verAt(w60));
      const put = (ver: string) =>
        send({
          sv: 1,
          ops: [
            {
              ...E(entity),
              intent: "update",
              ver,
              valid_from: "2026-11-01",
              valid_to: "2026-11-03",
              set: { b: "7" },
            },
          ],
        });
      expect(await put(`v${w80.seq}.0`)).toMatchObject({
        refused: "invalid_argument",
        reason: "not_this_target",
      });
      expect(await put(verAt(w80))).not.toHaveProperty("refused");
    },
    T,
  );

  it(
    "the undo of a fill where nothing was ever written opens a cell: its version is the undo's, and accepted",
    async () => {
      // The entity has a value from 11-05 on; before it nothing was ever written.
      const e = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "entities", valid_from: "2026-11-05", set: { b: "x" } }],
      });
      const entity = e.ops[0]?.target.entity as string;
      const fill = await send({
        sv: 1,
        ops: [
          {
            ...E(entity),
            intent: "update",
            ver: verAt(e),
            valid_from: "2026-11-01",
            valid_to: "2026-11-03",
            acknowledge: ["overwrite"],
            set: { b: "f" },
          },
        ],
      });
      expect(fill).not.toHaveProperty("refused");
      const u = await send({
        sv: 1,
        ops: [
          {
            ...E(entity),
            ver: verAt(fill),
            acknowledge: ["overwrite"],
            revert: { undo: fill.seq },
          },
        ],
      });
      expect(u).not.toHaveProperty("refused");
      // ① The undo's receipt gives its own operation as the version.
      expect(verAt(u)).toBe(`v${u.seq}.0`);
      // ② It closes the fill's cells and opens one: the field defining "has a value" (b, required)
      // gets a cell without a value where the entity has none (02-architecture §8 版本表).
      expect(await cellsOf(u.seq)).toEqual({
        opened: [{ field_id: "f2", f: "2026-11-01", t: "2026-11-03" }],
        closed: [
          { field_id: "f2", f: "2026-11-01", t: "2026-11-03" },
          { field_id: "f3", f: "2026-11-01", t: "2026-11-03" },
        ],
      });
      // ③ A write bringing that version back is accepted.
      const again = await send({
        sv: 1,
        ops: [
          {
            ...E(entity),
            intent: "update",
            ver: verAt(u),
            valid_from: "2026-11-05",
            set: { c: "y" },
          },
        ],
      });
      expect(again).not.toHaveProperty("refused");
    },
    T,
  );
});
