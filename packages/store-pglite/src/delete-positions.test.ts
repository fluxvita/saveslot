// A deletion's positions on logs the write and resolve paths make (09 §5.1, §5.7, §5.9
// `positions`), fixed cases: a resolution's request identifiers go with its own source; a given
// premise's business time goes with any of its op's evidence, the request's or one no field maps
// to; evidence mapped to some fields only takes those. The index is read from storage
// (`readPositionIndex`), not given.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  positionsOf,
  readBufferOf,
  readCitations,
  readPositionIndex,
  readTail,
  takenAway,
} from "@fluxvita/saveslot-kernel";
import {
  COMPILED_V1,
  createSlotEvents,
  resolveInTx,
  SLOT,
  writeInTx,
} from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 60_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
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
const opts = (task: string | null) => ({
  actor: USER as never,
  task,
  now: now(),
  windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
  visibility: { kind: "all" } as never,
  newId,
  reads: readBufferOf(s.store),
});
// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type R = any;
const send = async (params: unknown, task: string | null = null): Promise<R> =>
  s.store.write((tx) => writeInTx(tx, { ...opts(task), params } as never));
const resolve = async (params: unknown, task: string | null = null): Promise<R> =>
  s.store.write((tx) => resolveInTx(tx, { ...opts(task), params } as never));

beforeAll(async () => {
  s = await openReusable("saveslot-delete-positions-fixed-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
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

/** The events of an operation: seq, type, present block paths and bodies. */
const opEvents = (op: number) =>
  s.store.read(async (tx) => {
    const r = await tx.query<{ seq: unknown; type: string; path: string; body: string | null }>(
      `SELECT e.seq, e.type, c.path, c.body FROM events e JOIN content c ON c.seq = e.seq
       WHERE (e.seq = $1 OR e.op = $1) ORDER BY e.seq, c.path COLLATE "C"`,
      [op],
    );
    return r.rows.map((x) => ({
      seq: Number(x.seq),
      type: x.type,
      path: x.path,
      body: x.body === null ? null : JSON.parse(x.body),
    }));
  });

const positionsFor = (sources: number[]) =>
  s.store.read(async (tx) => {
    const bases = await readCitations(tx, SLOT, sources);
    const deleted = takenAway(bases, new Set(sources));
    const index = await readPositionIndex(tx, {
      slot: SLOT,
      sources,
      bases,
      deleted,
      restated: [],
    });
    const self = ((await readTail(tx))?.seq ?? 0) + 1;
    const p = positionsOf({ sources, deleted, restated: [], index, self });
    return { deleted: [...deleted].sort(), positions: p.map((x) => `${x.seq} ${x.path}`) };
  });

describe("request identifiers and an op's evidence, on logs the write path makes", () => {
  it(
    "a resolution's's task and request_key go with the resolve's own source (§5.1; 03-deletion \"含解决请求带的证据与备注\")",
    async () => {
      const a = await send({ sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "9" } }] });
      const row = a.ops[0].target.row;
      await send({
        sv: 1,
        ops: [{ intent: "update", table: "rows", row, ver: a.ops[0].ver, set: { b: "9.5" } }],
      });
      const c = await send({
        sv: 1,
        ops: [{ intent: "update", table: "rows", row, ver: a.ops[0].ver, set: { b: "10" } }],
      });
      const item = c.pending[0].id;
      const r = await resolve(
        {
          id: item,
          decision: "keep_effective",
          item_ver: c.pending[0].item_ver,
          note: "SECRET-NOTE",
        },
        "TASK-SECRET",
      );
      const op = Number(r.item_ver.split(".")[1]);
      const evs = await opEvents(op);
      const note = evs.find((e) => e.type === "source.recorded")?.seq as number;
      const out = await positionsFor([note]);
      expect(out.positions).toEqual(expect.arrayContaining([`${op} task`, `${op} request_key`]));
    },
    T,
  );

  it(
    'a reaffirming op (no write.base) with request evidence and a given premise: premise_valid goes with the evidence (§5.7 premise_valid, given: "这个 op 的全部证据")',
    async () => {
      const y = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "entities", set: { b: "y" }, valid_from: "2026-10-01" }],
      });
      const a = await send({ sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "9" } }] });
      const w = await send(
        {
          sv: 1,
          evidence: [{ kind: "user_message", text: "SECRET: still holds for November" }],
          ops: [
            {
              intent: "update",
              table: "rows",
              row: a.ops[0].target.row,
              ver: a.ops[0].ver,
              premises: [
                {
                  table: "entities",
                  entity: y.ops[0].target.entity,
                  ver: y.ops[0].ver,
                  valid_during: ["2026-11-01", "2026-12-01"],
                },
              ],
            },
          ],
        },
        "TASK-2",
      );
      const evs = await opEvents(w.seq);
      const ev = evs.find((e) => e.type === "source.recorded")?.seq as number;
      const out = await positionsFor([ev]);
      expect(out.positions).toEqual(
        expect.arrayContaining([`${w.seq} ops/0/premise_valid/0`, `${w.seq} task`]),
      );
    },
    T,
  );

  it(
    "a write whose fields and interval map to evidence 0 only: a given premise rests on all the op's evidence, so deleting evidence 1 lists it",
    async () => {
      const y = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "entities", set: { b: "y" }, valid_from: "2026-10-01" }],
      });
      const w = await send({
        sv: 1,
        evidence: [
          { kind: "user_message", text: "SECRET-0 plan b" },
          { kind: "user_message", text: "SECRET-1 because of the budget in November" },
        ],
        ops: [
          {
            intent: "insert",
            table: "entities",
            set: { b: "plan" },
            valid_from: "2026-11-10",
            evidence_by_field: { b: [0], valid: [0] },
            premises: [
              {
                table: "entities",
                entity: y.ops[0].target.entity,
                ver: y.ops[0].ver,
                valid_during: ["2026-11-01", "2026-12-01"],
              },
            ],
          },
        ],
      });
      const evs = await opEvents(w.seq);
      const srcs = evs
        .filter((e) => e.type === "source.recorded" && e.path === "target")
        .map((e) => e.seq);
      const out1 = await positionsFor([srcs[1] as number]);
      const out0 = await positionsFor([srcs[0] as number]);
      expect(out1.positions).toEqual(expect.arrayContaining([`${w.seq} ops/0/premise_valid/0`]));
      // Evidence 0, which the fields and the interval map to: the premise goes too.
      expect(out0.positions).toEqual(
        expect.arrayContaining([`${w.seq} ops/0/premise_valid/0`, `${w.seq} ops/0/valid`]),
      );
    },
    T,
  );

  it(
    "evidence mapped to some fields only: the unmapped field rests on all evidence (and), the mapped one on its own",
    async () => {
      const w = await send({
        sv: 1,
        evidence: [
          { kind: "user_message", text: "SECRET-0" },
          { kind: "user_message", text: "SECRET-1" },
        ],
        ops: [
          {
            intent: "insert",
            table: "rows",
            set: { b: "x", c: "y" },
            evidence_by_field: { b: [0] },
          },
        ],
      });
      const evs = await opEvents(w.seq);
      const srcs = evs
        .filter((e) => e.type === "source.recorded" && e.path === "target")
        .map((e) => e.seq);
      const o1 = await positionsFor([srcs[1] as number]);
      const o0 = await positionsFor([srcs[0] as number]);
      const base = evs.find((e) => e.type === "write.base")?.seq as number;
      expect(o1.deleted).toEqual([`${base}/f3`]);
      // Evidence 0: both (the unmapped field rests on all the evidence).
      expect(o0.deleted).toEqual([`${base}/f2`, `${base}/f3`]);
      expect(o1.positions).toContain(`${w.seq} ops/0/set/f3`);
      expect(o1.positions).not.toContain(`${w.seq} ops/0/set/f2`);
    },
    T,
  );
});
