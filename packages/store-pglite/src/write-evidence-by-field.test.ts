// evidence_by_field on PGlite (04-contract §3; 05-time «用同样的值写»; 09 §5.2 `ops/<i>/explicit`,
// §5.7 `sources/*`, `valid_sources`): a field mapped lists the sources it is mapped to; `valid`
// maps the interval's; a field mapped is explicit, so the same value again is a corroboration (it
// has an item and sources, and the op goes into the events) where without the mapping it is a
// no-op. Corroborations seen from an older version, cut by a change since, through an
// `entity_key`, and covered by a later value; the receipts' warnings overwrote_corroborated and
// multi_segment_unmapped. Requests go through the write pipeline on a real store.

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
import { COMPILED_V1, createSlotEvents, writeInTx } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 60_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const NOTES = {
  id: "t1",
  name: "notes",
  kind: "base",
  description: "notes",
  time: { type: "none" },
  physical: { table: "t_t1_v1" },
  fields: [
    { id: "f1", name: "text", type: "text", required: true, description: "text" },
    { id: "f2", name: "memo", type: "text", description: "memo" },
  ],
};
const ACCOUNTS = {
  id: "t2",
  name: "accounts",
  kind: "base",
  description: "an account over time",
  time: { type: "state", granularity: "date" },
  physical: { table: "t_t2_v1" },
  fields: [
    { id: "f1", name: "name", type: "text", required: true, description: "its name" },
    { id: "f2", name: "balance", type: "text", description: "its balance" },
  ],
  entity_key: ["f1"],
};
/** f2 listed before f10: as strings, f10 comes first. */
const WIDE = {
  id: "t3",
  name: "wide",
  kind: "base",
  description: "two fields",
  time: { type: "none" },
  physical: { table: "t_t3_v1" },
  fields: [
    { id: "f2", name: "first", type: "text", required: true, description: "first" },
    { id: "f10", name: "tenth", type: "text", description: "tenth" },
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
  return `2026-11-10T0${Math.floor(minute / 60) % 10}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
};
const newId = (kind: "row" | "entity" | "source" | "item" | "partition") => {
  ids++;
  const n = String(ids).padStart(kind === "row" || kind === "entity" ? 26 : 16, "0");
  return `${{ row: "r_", entity: "e_", source: "s_", item: "pi_", partition: "p_" }[kind]}${n}`;
};

type Receipt = {
  seq: number;
  request_key?: string;
  ops: {
    target: { row?: string; entity?: string };
    ver: string;
    fields: Record<string, unknown>;
  }[];
  pending: { id: string; type: string }[];
  warnings?: unknown[];
};

async function send(params: unknown): Promise<Receipt & Record<string, unknown>> {
  try {
    return (await s.store.write((tx) =>
      writeInTx(tx, {
        actor: USER as never,
        task: null,
        now: now(),
        windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
        visibility: { kind: "all" },
        params,
        newId,
        reads: readBufferOf(s.store),
      }),
    )) as never;
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { refused: x.code, ...(x.detail ?? {}) } as never;
  }
}

/** The events of an operation: type, seq and blocks present. */
const eventsOfOp = async (op: number) =>
  s.store.read(async (tx) =>
    (await readEvents(tx, op, (await readTail(tx))?.seq ?? op))
      .filter((e) => Number(e.header["op"] ?? e.header["seq"]) === op)
      .map((e) => ({
        type: e.header["type"] as string,
        seq: Number(e.header["seq"]),
        blocks: Object.fromEntries(
          [...e.blocks].flatMap(([p, b]) => (b.state === "present" ? [[p, b.value]] : [])),
        ) as Record<string, unknown>,
      })),
  );
const headOf = async (op: number) =>
  (await eventsOfOp(op)).find((e) => e.type === "write.head")?.blocks ?? {};
/** The write.base events of an operation, by op index: its blocks. */
const basesOf = async (op: number) =>
  (await eventsOfOp(op)).filter((e) => e.type === "write.base").map((e) => e.blocks);
/** The sources a block lists (`sources/*`: value sources; `valid_sources`: seqs). */
const cited = (v: unknown) =>
  ((v ?? []) as ({ source?: number } | number)[]).map((x) =>
    typeof x === "number" ? x : x.source,
  );
const sourceIdOf = async (seq: number) =>
  (
    await s.store.read((tx) =>
      tx.query<{ source_id: string }>("SELECT source_id FROM sources WHERE seq = $1", [seq]),
    )
  ).rows[0]?.source_id as string;
const say = (text: string) => ({ kind: "user_message", text });
const note = (text: string, more: Record<string, unknown> = {}) => ({
  intent: "insert",
  table: "ledger.notes",
  set: { text },
  ...more,
});

beforeAll(async () => {
  s = await openReusable("saveslot-write-evidence-by-field-");
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
      now: now(),
      confirmation: null,
    }),
  );
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-10T00:00:30.000Z" as never,
      events: createSlotEvents({
        compiled: { ...COMPILED_V1, tables: [NOTES, ACCOUNTS, WIDE] } as never,
        changes: CHANGES as never,
      }) as never,
    });
    await applyEvents(tx, eventsOf(op));
  });
}, T);

describe("sources by field", () => {
  it(
    "each field lists the segments it is mapped to; the head lists the fields, in the table's order",
    async () => {
      const r = await send({
        sv: 1,
        evidence: [say("text is a"), say("memo is m")],
        ops: [
          note("a", { set: { memo: "m", text: "a" }, evidence_by_field: { memo: [1], text: [0] } }),
        ],
      });
      const [base] = await basesOf(r.seq);
      expect(cited(base?.["sources/f1/0"])).toEqual([r.seq + 1]);
      expect(cited(base?.["sources/f2/0"])).toEqual([r.seq + 2]);
      expect((await headOf(r.seq))["ops/0/explicit"]).toEqual(["f1", "f2"]);
      expect(r.warnings ?? []).toEqual([]);
    },
    T,
  );

  it(
    "indices count the op's own segments first, then the request's it cites",
    async () => {
      // The request's segment is recorded first (op + 1), the op's own next (op + 2); the op sees
      // its own as 0 and the one it cites as 1.
      const r = await send({
        sv: 1,
        evidence: [say("the request's")],
        ops: [
          note("a", {
            evidence: [say("the op's own")],
            evidence_refs: [0],
            evidence_by_field: { text: [1] },
          }),
        ],
      });
      const [base] = await basesOf(r.seq);
      expect(cited(base?.["sources/f1/0"])).toEqual([r.seq + 1]);
    },
    T,
  );

  it(
    "a field left unmapped where the op sees several segments rests on all of them: multi_segment_unmapped",
    async () => {
      const r = await send({
        sv: 1,
        evidence: [say("text is a"), say("memo is m")],
        ops: [note("a", { set: { text: "a", memo: "m" }, evidence_by_field: { text: [0] } })],
      });
      const [base] = await basesOf(r.seq);
      expect(cited(base?.["sources/f1/0"])).toEqual([r.seq + 1]);
      expect(cited(base?.["sources/f2/0"])).toEqual([r.seq + 1, r.seq + 2]);
      expect(r.warnings).toEqual([{ code: "multi_segment_unmapped", op: 0, fields: ["memo"] }]);
      // Nothing mapped, several segments: every field given.
      const none = await send({
        sv: 1,
        evidence: [say("one"), say("two")],
        ops: [note("b", { set: { text: "b", memo: "n" } })],
      });
      expect(none.warnings).toEqual([
        { code: "multi_segment_unmapped", op: 0, fields: ["text", "memo"] },
      ]);
      // One segment: nothing to tell apart.
      const one = await send({ sv: 1, evidence: [say("one")], ops: [note("c")] });
      expect(one.warnings ?? []).toEqual([]);
    },
    T,
  );
});

describe("what the review found uncovered", () => {
  it(
    "evidence_refs not in ascending order: indices count them in the order given",
    async () => {
      // Request segments at op + 1, + 2, + 3; the op cites 2 then 0: its index 0 is the third.
      const r = await send({
        sv: 1,
        evidence: [say("zero"), say("one"), say("two")],
        ops: [
          note("a", {
            set: { text: "a", memo: "m" },
            evidence_refs: [2, 0],
            evidence_by_field: { text: [0], memo: [1] },
          }),
        ],
      });
      const [base] = await basesOf(r.seq);
      expect(cited(base?.["sources/f1/0"])).toEqual([r.seq + 3]);
      expect(cited(base?.["sources/f2/0"])).toEqual([r.seq + 1]);
    },
    T,
  );

  it(
    "the same request sent again is a resend: the corroboration is not appended twice",
    async () => {
      const first = await send({ sv: 1, evidence: [say("a")], ops: [note("a")] });
      const row = first.ops[0]?.target.row as string;
      const params = {
        sv: 1,
        evidence: [say("still a")],
        ops: [
          {
            intent: "update",
            table: "ledger.notes",
            row,
            ver: first.ops[0]?.ver,
            set: { text: "a" },
            evidence_by_field: { text: [0] },
          },
        ],
      };
      const r = await send(params);
      expect(r.ops[0]?.fields["text"]).toMatchObject({ result: "corroborated" });
      const tail = (await s.store.read(readTail))?.seq;
      const again = await send(params);
      expect(again.seq).toBe(r.seq);
      expect((await s.store.read(readTail))?.seq).toBe(tail);
    },
    T,
  );

  it(
    "a table listing f2 before f10: the head lists them so, read back as judge orders them",
    async () => {
      const first = await send({
        sv: 1,
        evidence: [say("x and y")],
        ops: [{ intent: "insert", table: "ledger.wide", set: { first: "x", tenth: "y" } }],
      });
      const row = first.ops[0]?.target.row as string;
      const r = await send({
        sv: 1,
        evidence: [say("still x, and z")],
        ops: [
          {
            intent: "update",
            table: "ledger.wide",
            row,
            ver: first.ops[0]?.ver,
            set: { tenth: "z", first: "x" },
            evidence_by_field: { tenth: [0], first: [0] },
          },
        ],
      });
      expect(r.ops[0]?.fields["first"]).toMatchObject({ result: "corroborated" });
      expect(r.ops[0]?.fields["tenth"]).toMatchObject({ result: "applied" });
      expect((await headOf(r.seq))["ops/0/explicit"]).toEqual(["f2", "f10"]);
    },
    T,
  );

  it(
    "multi_segment_unmapped lists the unmapped fields with items: a no-op is none",
    async () => {
      const first = await send({
        sv: 1,
        evidence: [say("a, m")],
        ops: [note("a", { set: { text: "a", memo: "m" } })],
      });
      const row = first.ops[0]?.target.row as string;
      const upd = (more: Record<string, unknown>) => ({
        sv: 1,
        evidence: [say("one"), say("two")],
        ops: [
          {
            intent: "update",
            table: "ledger.notes",
            row,
            ver: first.ops[0]?.ver,
            set: { text: "a", memo: "n" },
            ...more,
          },
        ],
      });
      // text the same, not mapped: a no-op, not listed; memo changed, mapped.
      const mapped = await send(upd({ evidence_by_field: { memo: [1] } }));
      expect(mapped.ops[0]?.fields["text"]).toEqual({ result: "noop" });
      expect(mapped.warnings ?? []).toEqual([]);
      // memo not mapped either: memo only.
      const none = await send({
        ...upd({}),
        ops: [{ ...upd({}).ops[0], ver: mapped.ops[0]?.ver, set: { text: "a", memo: "o" } }],
      });
      expect(none.warnings).toEqual([{ code: "multi_segment_unmapped", op: 0, fields: ["memo"] }]);
    },
    T,
  );
});

describe("the same value with evidence pointed at: a corroboration, not a no-op", () => {
  it(
    "beside the no-op it would be: the op goes into the events, cites its evidence, no unreferenced evidence",
    async () => {
      const first = await send({ sv: 1, evidence: [say("it was a")], ops: [note("a")] });
      const row = first.ops[0]?.target.row as string;
      const again = (more: Record<string, unknown>) => ({
        sv: 1,
        evidence: [say("still a")],
        ops: [
          {
            intent: "update",
            table: "ledger.notes",
            row,
            ver: first.ops[0]?.ver,
            set: { text: "a" },
            ...more,
          },
        ],
      });
      // Without the mapping: a no-op. The request is saved all the same (04-contract §5: its
      // write number, request key and sources), but the op leaves only its target and no-op list:
      // no raw value, no write.base. The op names no evidence_refs, so it cites the segment: no
      // evidence_unreferenced, with the mapping or without.
      const noop = await send(again({}));
      expect(noop.ops[0]?.fields["text"]).toEqual({ result: "noop" });
      expect(noop.warnings ?? []).toEqual([]);
      const quiet = await eventsOfOp(noop.seq);
      expect(quiet.map((e) => e.type)).toEqual(["write.head", "source.recorded"]);
      expect(quiet[0]?.blocks["request_key"]).toBeDefined();
      expect(quiet[0]?.blocks["ops/0/noop"]).toEqual(["f1"]);
      expect(quiet[0]?.blocks["ops/0/set/f1"]).toBeUndefined();
      expect(quiet[0]?.blocks["ops/0/explicit"]).toBeUndefined();
      // With it: a corroboration. The raw value and the field pointed at in the head, a
      // write.base whose item cites the segment; the version unchanged.
      const r = await send(again({ evidence_by_field: { text: [0] } }));
      expect(r.ops[0]?.fields["text"]).toMatchObject({ result: "corroborated" });
      expect(r.ops[0]?.ver).toBe(first.ops[0]?.ver);
      expect(r.warnings ?? []).toEqual([]);
      const evs = await eventsOfOp(r.seq);
      expect(evs.map((e) => e.type)).toEqual(["write.head", "source.recorded", "write.base"]);
      const head = evs[0]?.blocks ?? {};
      expect(head["request_key"]).toBeDefined();
      expect(head["ops/0/explicit"]).toEqual(["f1"]);
      expect(head["ops/0/set/f1"]).toBe("a");
      expect(head["ops/0/noop"]).toBeUndefined();
      const base = evs[2]?.blocks ?? {};
      expect(base["fields/f1/0"]).toMatchObject({ status: "corroborated", value: "a" });
      expect(cited(base["sources/f1/0"])).toEqual([r.seq + 1]);
    },
    T,
  );

  it(
    "beside E1's no-op source_ref: mapped, the source it names is cited, with no new source",
    async () => {
      const said = await send({ sv: 1, evidence: [say("it was a")], ops: [note("a")] });
      const x = await sourceIdOf(said.seq + 1);
      const row = said.ops[0]?.target.row as string;
      const r = await send({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "ledger.notes",
            row,
            ver: said.ops[0]?.ver,
            set: { text: "a" },
            evidence: [{ kind: "source_ref", id: x }],
            evidence_by_field: { text: [0] },
          },
        ],
      });
      expect(r.ops[0]?.fields["text"]).toMatchObject({ result: "corroborated" });
      const evs = await eventsOfOp(r.seq);
      expect(evs.map((e) => e.type)).toEqual(["write.head", "write.base"]);
      expect(cited(evs[1]?.blocks["sources/f1/0"])).toEqual([said.seq + 1]);
    },
    T,
  );

  it(
    "seen from an older version, the field unchanged since: a corroboration",
    async () => {
      const first = await send({
        sv: 1,
        evidence: [say("a")],
        ops: [note("a", { set: { text: "a", memo: "m" } })],
      });
      const row = first.ops[0]?.target.row as string;
      // memo changes after the version the next write sees; text does not.
      await send({
        sv: 1,
        evidence: [say("memo n")],
        ops: [
          {
            intent: "update",
            table: "ledger.notes",
            row,
            ver: first.ops[0]?.ver,
            set: { memo: "n" },
          },
        ],
      });
      const r = await send({
        sv: 1,
        evidence: [say("text is still a")],
        ops: [
          {
            intent: "update",
            table: "ledger.notes",
            row,
            ver: first.ops[0]?.ver,
            set: { text: "a" },
            evidence_by_field: { text: [0] },
          },
        ],
      });
      expect(r.ops[0]?.fields["text"]).toMatchObject({ result: "corroborated" });
      expect(r.pending).toEqual([]);
    },
    T,
  );
});

describe("on a state table", () => {
  const CASH = { name: "Cash" };
  const open = async () => {
    const r = await send({
      sv: 1,
      evidence: [say("5000 since October")],
      ops: [
        // An entity_key table makes its entity by an update naming the key.
        {
          intent: "update",
          table: "ledger.accounts",
          entity_key: CASH,
          set: { balance: "5000" },
          valid_from: "2026-10-01",
        },
      ],
    });
    if (r.ops === undefined) throw new Error(JSON.stringify(r));
    return { entity: r.ops[0]?.target.entity as string, ver: r.ops[0]?.ver as string, op: r.seq };
  };
  const update = (
    ver: string,
    from: string,
    to: string | undefined,
    balance: string,
    more: Record<string, unknown> = {},
  ) => ({
    intent: "update",
    table: "ledger.accounts",
    entity_key: CASH,
    ver,
    set: { balance },
    valid_from: from,
    ...(to !== undefined ? { valid_to: to } : {}),
    ...more,
  });
  const partsOf = (r: Receipt, field = "balance") =>
    ((r.ops[0]?.fields[field] ?? []) as { result: string }[]).map((x) => x.result);

  // 05-time «用同样的值写»'s example: base [10-01, ∞) 5000; A says "5000 from 11-20" with evidence
  // pointed at; B says "3000 from 11-02" with no end; both from the same version. The spec gives
  // the same in either order: A a corroboration over [11-20, ∞), B in effect over [11-02, 11-20).
  it(
    "A then B: A a corroboration, B stops at its end",
    async () => {
      const a = await open();
      const A = await send({
        sv: 1,
        evidence: [say("5000 from the 20th")],
        ops: [
          update(a.ver, "2026-11-20", undefined, "5000", { evidence_by_field: { balance: [0] } }),
        ],
      });
      expect(partsOf(A)).toEqual(["corroborated"]);
      const B = await send({
        sv: 1,
        evidence: [say("3000 from the 2nd")],
        ops: [update(a.ver, "2026-11-02", undefined, "3000")],
      });
      expect(B.ops[0]?.fields["balance"]).toMatchObject([
        { result: "applied", valid: { valid_from: "2026-11-02", valid_to: "2026-11-20" } },
      ]);
      expect(B.pending).toEqual([]);
    },
    T,
  );

  // The changed part is judged as A was written: a default end, from 11-20 (B's start 11-02 is
  // another, so no conflict), merged, resolved on the current state: [11-20, ∞), now a change of
  // B's 3000, so in effect, not a corroboration. The end state is A then B's.
  it(
    "B then A: the same end state (A in effect over [11-20, ∞), B stopping there)",
    async () => {
      const a = await open();
      const B = await send({
        sv: 1,
        evidence: [say("3000 from the 2nd")],
        ops: [update(a.ver, "2026-11-02", undefined, "3000")],
      });
      expect(B.ops[0]?.fields["balance"]).toMatchObject([
        { result: "applied", valid: { valid_from: "2026-11-02", valid_to: null } },
      ]);
      const A = await send({
        sv: 1,
        evidence: [say("5000 from the 20th")],
        ops: [
          update(a.ver, "2026-11-20", undefined, "5000", { evidence_by_field: { balance: [0] } }),
        ],
      });
      expect(A.pending).toEqual([]);
      expect(A.ops[0]?.fields["balance"]).toMatchObject([
        { result: "applied", valid: { valid_from: "2026-11-20", valid_to: null } },
      ]);
    },
    T,
  );

  // A corroboration's changed part, merged: resolved on the current state, its span's deps the
  // contributions giving the blocking point it stops at (09 §3.5), the writes that changed it too.
  it(
    "the changed part merged stops at another corroboration's start: that corroboration among its deps",
    async () => {
      const a = await open();
      // C corroborates [11-25, 11-30): no version. B, from that version (current), from 11-02 to
      // the next change: it stops at C's start.
      const C = await send({
        sv: 1,
        evidence: [say("5000 from the 25th to the 30th")],
        ops: [
          update(a.ver, "2026-11-25", "2026-11-30", "5000", {
            evidence_by_field: { balance: [0] },
          }),
        ],
      });
      const B = await send({
        sv: 1,
        evidence: [say("3000 from the 2nd")],
        ops: [update(a.ver, "2026-11-02", undefined, "3000")],
      });
      expect(B.ops[0]?.fields["balance"]).toMatchObject([
        { result: "applied", valid: { valid_from: "2026-11-02", valid_to: "2026-11-25" } },
      ]);
      // A, from the first version (before C and B), 5000 from 11-20 to the next change.
      const A = await send({
        sv: 1,
        evidence: [say("5000 from the 20th")],
        ops: [
          update(a.ver, "2026-11-20", undefined, "5000", { evidence_by_field: { balance: [0] } }),
        ],
      });
      expect(A.pending).toEqual([]);
      // Resolved on the current state, A runs to the next change, 11-25: all of it changed (B's
      // 3000), so one item in effect. [11-25, ∞), still 5000, is no part of A's interval now.
      expect(partsOf(A)).toEqual(["applied"]);
      const base = (await basesOf(A.seq))[0] ?? {};
      const span = (base["span/f2/0"] ?? {}) as { valid?: unknown; deps?: unknown[] };
      expect(span.valid).toEqual({ from: "2026-11-20", to: "2026-11-25" });
      expect(span.deps).toContainEqual({ event: C.seq + 2, field: "f2", k: 0 });
      expect(span.deps).toContainEqual({ event: B.seq + 2, field: "f2", k: 0 });
    },
    T,
  );

  it(
    "the changed part merged stops at a change of value: the item starting there among its deps",
    async () => {
      const a = await open();
      // 6000 from 11-25 on, before the version A and B carry.
      const six = await send({
        sv: 1,
        evidence: [say("6000 from the 25th")],
        ops: [update(a.ver, "2026-11-25", undefined, "6000")],
      });
      const v = six.ops[0]?.ver as string;
      const B = await send({
        sv: 1,
        evidence: [say("3000 from the 2nd")],
        ops: [update(v, "2026-11-02", undefined, "3000")],
      });
      const A = await send({
        sv: 1,
        evidence: [say("5000 from the 20th")],
        ops: [update(v, "2026-11-20", undefined, "5000", { evidence_by_field: { balance: [0] } })],
      });
      expect(A.pending).toEqual([]);
      expect(partsOf(A)).toEqual(["applied"]);
      const span = ((await basesOf(A.seq))[0]?.["span/f2/0"] ?? {}) as {
        valid?: unknown;
        deps?: unknown[];
      };
      expect(span.valid).toEqual({ from: "2026-11-20", to: "2026-11-25" });
      expect(span.deps).toContainEqual({ event: six.seq + 2, field: "f2", k: 0 });
      expect(span.deps).toContainEqual({ event: B.seq + 2, field: "f2", k: 0 });
    },
    T,
  );

  // As it stands, pinned (08 «P3 前»: whether a revert's value write-back covers a corroboration
  // end; develop-del settles it with the rules of taking back, and this case with it).
  it(
    "a corroboration covered by a write from the same version, the write undone: the write-back covers its ends",
    async () => {
      const a = await open();
      const A = await send({
        sv: 1,
        evidence: [say("5000 from the 20th to the 25th")],
        ops: [
          update(a.ver, "2026-11-20", "2026-11-25", "5000", {
            evidence_by_field: { balance: [0] },
          }),
        ],
      });
      const B = await send({
        sv: 1,
        evidence: [say("3000 from the 18th to the 27th")],
        ops: [update(a.ver, "2026-11-18", "2026-11-27", "3000", { acknowledge: ["overwrite"] })],
      });
      expect(B.warnings).toMatchObject([{ code: "overwrote_corroborated" }]);
      const U = await send({
        sv: 1,
        evidence: [say("undo that")],
        ops: [
          {
            table: "ledger.accounts",
            entity_key: CASH,
            ver: B.ops[0]?.ver,
            revert: { undo: B.seq },
            acknowledge: ["overwrite"],
          },
        ],
      });
      expect(U.ops[0]?.fields["balance"]).toMatchObject([{ result: "applied" }]);
      // 5000 again over [11-18, 11-27), written back: A's ends 11-20 and 11-25 covered, so a
      // write from 11-19 to the next change runs past both.
      const C = await send({
        sv: 1,
        evidence: [say("7000 from the 19th")],
        ops: [
          update(U.ops[0]?.ver as string, "2026-11-19", undefined, "7000", {
            acknowledge: ["overwrite"],
          }),
        ],
      });
      expect(C.ops[0]?.fields["balance"]).toMatchObject([
        { result: "applied", valid: { valid_from: "2026-11-19", valid_to: null } },
      ]);
      expect(A.seq).toBeGreaterThan(0);
    },
    T,
  );

  it(
    "seen from an older version, a change since in the middle: corroborations either side, a candidate between",
    async () => {
      const a = await open();
      await send({
        sv: 1,
        evidence: [say("3000 for a few days")],
        ops: [update(a.ver, "2026-11-08", "2026-11-12", "3000")],
      });
      const r = await send({
        sv: 1,
        evidence: [say("5000 from the 5th to the 20th")],
        ops: [
          update(a.ver, "2026-11-05", "2026-11-20", "5000", {
            evidence_by_field: { balance: [0] },
          }),
        ],
      });
      expect(partsOf(r)).toEqual(["corroborated", "candidate", "corroborated"]);
      const base = (await basesOf(r.seq))[0] ?? {};
      expect(base["fields/f2/0"]).toMatchObject({ status: "corroborated" });
      expect(base["fields/f2/2"]).toMatchObject({ status: "corroborated" });
    },
    T,
  );

  it(
    "an entity_key's key field: the same value always; mapped, a corroboration; not mapped, a no-op",
    async () => {
      const a = await open();
      const plain = await send({
        sv: 1,
        evidence: [say("6000 now")],
        ops: [update(a.ver, "2026-11-01", undefined, "6000")],
      });
      expect(plain.ops[0]?.fields["name"]).toEqual([{ result: "noop" }]);
      expect((await headOf(plain.seq))["ops/0/explicit"]).toBeUndefined();
      const mapped = await send({
        sv: 1,
        evidence: [say("Cash is 7000 now")],
        ops: [
          update(plain.ops[0]?.ver as string, "2026-11-02", undefined, "7000", {
            evidence_by_field: { name: [0], balance: [0] },
          }),
        ],
      });
      expect(partsOf(mapped, "name")).toEqual(["corroborated"]);
      expect((await headOf(mapped.seq))["ops/0/explicit"]).toEqual(["f1", "f2"]);
    },
    T,
  );

  it(
    "`valid` maps the interval's sources, for a write and for a revoke",
    async () => {
      const a = await open();
      const w = await send({
        sv: 1,
        evidence: [say("6000"), say("from the 1st to the 9th")],
        ops: [
          update(a.ver, "2026-11-01", "2026-11-09", "6000", {
            evidence_by_field: { balance: [0], valid: [1] },
          }),
        ],
      });
      const wb = (await basesOf(w.seq))[0] ?? {};
      expect(cited(wb["sources/f2/0"])).toEqual([w.seq + 1]);
      expect(cited(wb["valid_sources"])).toEqual([w.seq + 2]);
      const rv = await send({
        sv: 1,
        evidence: [say("closed"), say("from the 20th to the 25th")],
        ops: [
          {
            intent: "revoke",
            table: "ledger.accounts",
            entity_key: CASH,
            ver: w.ops[0]?.ver,
            valid_from: "2026-11-20",
            valid_to: "2026-11-25",
            evidence_by_field: { valid: [1] },
          },
        ],
      });
      const rb = (await basesOf(rv.seq))[0] ?? {};
      expect(cited(rb["valid_sources"])).toEqual([rv.seq + 2]);
    },
    T,
  );

  it(
    "a later value over a corroboration: overwrote_corroborated, with the corroboration's sources",
    async () => {
      const a = await open();
      const c = await send({
        sv: 1,
        evidence: [say("still 5000 from the 15th")],
        ops: [
          update(a.ver, "2026-11-15", "2026-11-25", "5000", {
            evidence_by_field: { balance: [0] },
          }),
        ],
      });
      expect(partsOf(c)).toEqual(["corroborated"]);
      const said = await sourceIdOf(c.seq + 1);
      const r = await send({
        sv: 1,
        evidence: [say("3000 from the 18th to the 22nd")],
        ops: [
          update(c.ops[0]?.ver as string, "2026-11-18", "2026-11-22", "3000", {
            acknowledge: ["overwrite"],
          }),
        ],
      });
      expect(r.warnings).toEqual([
        {
          code: "overwrote_corroborated",
          op: 0,
          field: "balance",
          valid: {
            valid_from: "2026-11-18",
            valid_to: "2026-11-22",
            valid_to_inclusive: "2026-11-21",
          },
          sources: [said],
        },
      ]);
    },
    T,
  );
});
