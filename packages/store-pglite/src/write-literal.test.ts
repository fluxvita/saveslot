// Literal checks of a write on PGlite (04-write-and-read «来源级别：声明级别与字面命中»; 09 §5.7
// `literal/<field>/<k>`): which items have the block, a segment a source in the order of the
// item's sources, and the text each is checked against: a new segment's text, a file
// reference's excerpt, the text of a source a `source_ref` names; nothing for an api_call or a
// file reference without an excerpt. A field mapped by `evidence_by_field` lists its own segments
// only; a corroboration is checked; a carried item and a no-op are not. And what a request at the
// limits costs. The checker itself is pinned in kernel's literal tests.

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

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const LOG = {
  id: "t1",
  name: "log",
  kind: "base",
  description: "a log",
  time: { type: "none" },
  physical: { table: "t_t1_v1" },
  fields: [
    { id: "f1", name: "text", type: "text", required: true, description: "text" },
    {
      id: "f2",
      name: "amount",
      type: "quantity",
      unit: { code: "CNY", dimension: "currency:CNY" },
      precision: { scale: 2, rounding: "half_up" },
      description: "amount",
    },
    { id: "f3", name: "day", type: "date", description: "day" },
    { id: "f4", name: "count", type: "integer", description: "count" },
    { id: "f5", name: "done", type: "boolean", description: "done" },
    {
      id: "f6",
      name: "distance",
      type: "quantity",
      unit: { code: "km", dimension: "length", to_base: "1000" },
      precision: { scale: 2, rounding: "half_up" },
      description: "distance",
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
  return `2026-11-10T0${Math.floor(minute / 60) % 10}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
};
const newId = (kind: "row" | "entity" | "source" | "item" | "partition") => {
  ids++;
  const n = String(ids).padStart(kind === "row" || kind === "entity" ? 26 : 16, "0");
  return `${{ row: "r_", entity: "e_", source: "s_", item: "pi_", partition: "p_" }[kind]}${n}`;
};

type Receipt = {
  seq: number;
  ops: { target: { row?: string }; ver: string; fields: Record<string, unknown> }[];
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

/** The blocks of the write.base events of an operation, in order. */
const basesOf = async (op: number) =>
  s.store.read(async (tx) =>
    (await readEvents(tx, op, (await readTail(tx))?.seq ?? op))
      .filter((e) => e.header["type"] === "write.base" && Number(e.header["op"]) === op)
      .map(
        (e) =>
          Object.fromEntries(
            [...e.blocks].flatMap(([p, b]) => (b.state === "present" ? [[p, b.value]] : [])),
          ) as Record<string, unknown>,
      ),
  );
/** The literal blocks of a write.base: path → [source, result] pairs. */
const literalOf = (base: Record<string, unknown> | undefined) =>
  Object.fromEntries(
    Object.entries(base ?? {})
      .filter(([p]) => p.startsWith("literal/"))
      .map(([p, v]) => [
        p,
        (v as { segments: { source: number; result: string }[] }).segments.map((x) => [
          x.source,
          x.result,
        ]),
      ]),
  );
const sourceIdOf = async (seq: number) =>
  (
    await s.store.read((tx) =>
      tx.query<{ source_id: string }>("SELECT source_id FROM sources WHERE seq = $1", [seq]),
    )
  ).rows[0]?.source_id as string;
const say = (text: string) => ({ kind: "user_message", text });
const file = (excerpt?: string) => ({
  kind: "file_ref",
  name: "r.pdf",
  mime: "application/pdf",
  size: 10,
  sha256: "A".repeat(64),
  ...(excerpt !== undefined ? { excerpt } : {}),
});
const insert = (set: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
  intent: "insert",
  table: "ledger.log",
  set,
  ...more,
});

beforeAll(async () => {
  s = await openReusable("saveslot-write-literal-");
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
        compiled: { ...COMPILED_V1, tables: [LOG] } as never,
        changes: CHANGES as never,
      }) as never,
    });
    await applyEvents(tx, eventsOf(op));
  });
}, T);

describe("the blocks of a write", () => {
  it(
    "each value item, a segment a source in the order of its sources; each field by its type",
    async () => {
      const r = await send({
        sv: 1,
        evidence: [say("午饭 ¥45，11月5号，3 个人"), say("lunch with Ann")],
        ops: [
          insert({
            text: "lunch",
            amount: { value: "45", unit: "CNY" },
            day: "2026-11-05",
            count: 3,
            done: true,
          }),
        ],
      });
      const a = r.seq + 1;
      const b = r.seq + 2;
      const [base] = await basesOf(r.seq);
      expect(literalOf(base)).toEqual({
        "literal/f1/0": [
          [a, "miss"],
          [b, "hit"],
        ],
        "literal/f2/0": [
          [a, "hit"],
          [b, "miss"],
        ],
        "literal/f3/0": [
          [a, "hit"],
          [b, "miss"],
        ],
        "literal/f4/0": [
          [a, "hit"],
          [b, "miss"],
        ],
        "literal/f5/0": [
          [a, "na"],
          [b, "na"],
        ],
      });
    },
    T,
  );

  it(
    "a Chinese comma ends a clause: ¥45，11月5号 has 45, and the date",
    async () => {
      // "，" is not made a ",": only an ASCII comma groups thousands or joins numbers.
      const r = await send({
        sv: 1,
        evidence: [say("午饭 ¥45，11月5号")],
        ops: [insert({ text: "x", amount: { value: "45", unit: "CNY" }, day: "2026-11-05" })],
      });
      const [base] = await basesOf(r.seq);
      expect(literalOf(base)["literal/f2/0"]).toEqual([[r.seq + 1, "hit"]]);
      expect(literalOf(base)["literal/f3/0"]).toEqual([[r.seq + 1, "hit"]]);
    },
    T,
  );

  it(
    "the text checked: a new segment's, a file's excerpt; none for a file without one, or an api_call",
    async () => {
      const files = await send({
        sv: 1,
        evidence: [file("total 45 CNY"), file()],
        ops: [insert({ text: "x", amount: { value: "45", unit: "CNY" } })],
      });
      const [fb] = await basesOf(files.seq);
      expect(literalOf(fb)["literal/f2/0"]).toEqual([
        [files.seq + 1, "hit"],
        [files.seq + 2, "na"],
      ]);
      const call = await send({ sv: 1, ops: [insert({ text: "x", count: 3 })] });
      const [cb] = await basesOf(call.seq);
      expect(literalOf(cb)).toEqual({
        "literal/f1/0": [[call.seq + 1, "na"]],
        "literal/f4/0": [[call.seq + 1, "na"]],
      });
    },
    T,
  );

  it(
    "a source_ref: the text of the source it names",
    async () => {
      const said = await send({
        sv: 1,
        evidence: [say("it cost 45 元")],
        ops: [insert({ text: "a" })],
      });
      const id = await sourceIdOf(said.seq + 1);
      const r = await send({
        sv: 1,
        ops: [
          insert(
            { text: "b", amount: { value: "45", unit: "CNY" } },
            { evidence: [{ kind: "source_ref", id }] },
          ),
        ],
      });
      const [base] = await basesOf(r.seq);
      expect(literalOf(base)["literal/f2/0"]).toEqual([[said.seq + 1, "hit"]]);
    },
    T,
  );

  it(
    "a field mapped by evidence_by_field: its segments only",
    async () => {
      const r = await send({
        sv: 1,
        evidence: [say("text is lunch"), say("it was 3")],
        ops: [
          insert({ text: "lunch", count: 3 }, { evidence_by_field: { text: [0], count: [1] } }),
        ],
      });
      const [base] = await basesOf(r.seq);
      expect(literalOf(base)).toEqual({
        "literal/f1/0": [[r.seq + 1, "hit"]],
        "literal/f4/0": [[r.seq + 2, "hit"]],
      });
    },
    T,
  );
});

describe("the value checked is the caller's, before conversion and rounding", () => {
  it(
    "3 mi into a km field (4.83 km recorded): the evidence's 3 mi hits, 4.83 km does not",
    async () => {
      const r = await send({
        sv: 1,
        evidence: [say("ran 3 mi"), say("ran 4.83 km")],
        ops: [insert({ text: "x", distance: { value: "3", unit: "mi" } })],
      });
      const [base] = await basesOf(r.seq);
      expect(base?.["fields/f6/0"]).toMatchObject({ value: { value: "4.83", unit: "km" } });
      expect(literalOf(base)["literal/f6/0"]).toEqual([
        [r.seq + 1, "hit"],
        [r.seq + 2, "miss"],
      ]);
    },
    T,
  );

  it(
    "1.005 into two decimals (1.01 recorded): the evidence's 1.005 hits, 1.01 does not",
    async () => {
      const r = await send({
        sv: 1,
        evidence: [say("paid 1.005 元"), say("paid 1.01 元")],
        ops: [insert({ text: "x", amount: { value: "1.005", unit: "CNY" } })],
      });
      const [base] = await basesOf(r.seq);
      expect(base?.["fields/f2/0"]).toMatchObject({ value: { value: "1.01", unit: "CNY" } });
      expect(literalOf(base)["literal/f2/0"]).toEqual([
        [r.seq + 1, "hit"],
        [r.seq + 2, "miss"],
      ]);
    },
    T,
  );
});

describe("which items", () => {
  it(
    "a corroboration is checked; a no-op field has no item, so no block",
    async () => {
      const first = await send({
        sv: 1,
        evidence: [say("lunch, 3")],
        ops: [insert({ text: "lunch", count: 3 })],
      });
      const row = first.ops[0]?.target.row as string;
      const r = await send({
        sv: 1,
        evidence: [say("still lunch")],
        ops: [
          {
            intent: "update",
            table: "ledger.log",
            row,
            ver: first.ops[0]?.ver,
            set: { text: "lunch", count: 3 },
            evidence_by_field: { text: [0] },
          },
        ],
      });
      expect(r.ops[0]?.fields["text"]).toMatchObject({ result: "corroborated" });
      expect(r.ops[0]?.fields["count"]).toEqual({ result: "noop" });
      const [base] = await basesOf(r.seq);
      expect(literalOf(base)).toEqual({ "literal/f1/0": [[r.seq + 1, "hit"]] });
    },
    T,
  );

  it(
    "an undo's write-back is carried: not checked again",
    async () => {
      const first = await send({
        sv: 1,
        evidence: [say("3")],
        ops: [insert({ text: "a", count: 3 })],
      });
      const row = first.ops[0]?.target.row as string;
      const second = await send({
        sv: 1,
        evidence: [say("4")],
        ops: [
          { intent: "update", table: "ledger.log", row, ver: first.ops[0]?.ver, set: { count: 4 } },
        ],
      });
      const undo = await send({
        sv: 1,
        evidence: [say("undo that")],
        ops: [{ table: "ledger.log", row, ver: second.ops[0]?.ver, revert: { undo: second.seq } }],
      });
      expect(undo["refused"]).toBeUndefined();
      const [base] = await basesOf(undo.seq);
      expect(base?.["sources/f4/0"]).toEqual([
        { kind: "value", carried: { event: first.seq + 2, field: "f4", k: 0 } },
      ]);
      expect(literalOf(base)).toEqual({});
    },
    T,
  );
});

describe("the cost of a request at the limits", () => {
  it(
    "1,000 ops citing one segment near 32 KB: each segment indexed once",
    async () => {
      // 32,000 bytes of text with numbers through it; each op's count among them, its text not.
      const words = Array.from({ length: 4000 }, (_, k) => `n${k % 10} ${k} `).join("");
      const segment = words.slice(0, 32_000);
      const ops = Array.from({ length: 1000 }, (_, k) => insert({ text: `row ${k}`, count: k }));
      const started = performance.now();
      const r = await send({ sv: 1, evidence: [say(segment)], ops });
      const ms = performance.now() - started;
      expect(r["refused"]).toBeUndefined();
      const bases = await basesOf(r.seq);
      expect(bases).toHaveLength(1000);
      expect(literalOf(bases[999])["literal/f4/0"]).toEqual([[r.seq + 1, "hit"]]);
      // The whole write, through the pipeline on PGlite; the checks are a small part of it.
      console.info(`1,000 ops, one 32,000-byte segment: ${Math.round(ms)} ms`);
    },
    T,
  );
});
