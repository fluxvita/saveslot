// Evidence without a mapping on PGlite (04-contract §3; 09 §4.2, §5.4): an op's own segments and
// `source_ref`. An op sees its own segments and the request's it cites; with segments of its own
// and no `evidence_refs`, none of the request's. New segments become sources, the request's first,
// then each op's own in op order; a `source_ref` is the source it names, with no event; an op with
// no evidence at all gets its `api_call`. Refusals are compared whole, with nothing written.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  pending as pending$,
  readBufferOf,
  readEvents,
  readTail,
} from "@fluxvita/saveslot-kernel";
import {
  COMPILED_V1,
  createSlotEvents,
  DRAFT,
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
  { id: "f1", name: "text", type: "text", required: true, description: "text" },
  { id: "f2", name: "memo", type: "text", description: "memo" },
];
const notes = (id: string) => ({
  id,
  name: "notes",
  kind: "base",
  description: "notes",
  time: { type: "none" },
  physical: { table: `t_${id}_v1` },
  fields,
});
const CHANGES = (table: string) =>
  [
    { target: { slot: true }, change: "create_slot" },
    { target: { table }, change: "add_table" },
  ].map((c) => ({
    ...c,
    class: "create",
    compatible_with_old_writes: true,
    destructive: false,
    auto: true,
  }));
/** A second slot, `health`, with a notes table of its own. */
const SLOT2 = `sl_${"5".repeat(16)}`;
const DRAFT2 = `d_${"2".repeat(16)}`;

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
const ctx = () =>
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

type Receipt = {
  seq: number;
  ops: { target: { row?: string }; ver: string; fields: Record<string, unknown> }[];
  pending: { id: string; type: string; item_ver?: string }[];
  warnings?: unknown[];
};

async function send(
  params: unknown,
  actor: string = USER,
): Promise<Receipt & Record<string, unknown>> {
  try {
    return (await s.store.write((tx) =>
      writeInTx(tx, {
        actor: actor as never,
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

async function resolve(params: unknown): Promise<Record<string, unknown>> {
  try {
    return (await s.store.write((tx) =>
      resolveInTx(tx, {
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
    return { refused: x.code, ...(x.detail ?? {}) };
  }
}

const tail = async () => (await s.store.read(readTail))?.seq ?? 0;
/** The events of an operation: type, seq and blocks present. */
const eventsOfOp = async (op: number) =>
  s.store.read(async (tx) =>
    (await readEvents(tx, op, (await readTail(tx))?.seq ?? op))
      .filter(
        (e) => Number(e.header["op"] ?? e.header["seq"]) === op || Number(e.header["seq"]) === op,
      )
      .map((e) => ({
        type: e.header["type"] as string,
        seq: Number(e.header["seq"]),
        blocks: Object.fromEntries(
          [...e.blocks].flatMap(([p, b]) => (b.state === "present" ? [[p, b.value]] : [])),
        ) as Record<string, unknown>,
      })),
  );
/** The sources of an operation, as recorded: seq, kind and text or op index. */
const sourcesOfOp = async (op: number) =>
  (await eventsOfOp(op))
    .filter((e) => e.type === "source.recorded")
    .map((e) => {
      const t = e.blocks["target"] as { kind: string; op_index?: number };
      const text = (e.blocks["text"] as { text?: string } | undefined)?.text;
      return {
        seq: e.seq,
        kind: t.kind,
        ...(text !== undefined ? { text } : {}),
        ...(t.op_index !== undefined ? { op: t.op_index } : {}),
      };
    });
/** The value sources of each base write of an operation, by op index: of field f1 (`text`). */
const valueSourcesOfOp = async (op: number) =>
  (await eventsOfOp(op))
    .filter((e) => e.type === "write.base")
    .map((e) => ((e.blocks["sources/f1/0"] ?? []) as { source?: number }[]).map((x) => x.source));
const sourceRow = async (seq: number) =>
  (
    await s.store.read((tx) =>
      tx.query<{ source_id: string; kind: string }>(
        "SELECT source_id, kind FROM sources WHERE seq = $1",
        [seq],
      ),
    )
  ).rows[0] as { source_id: string; kind: string };

const refused = async (
  run: () => Promise<Record<string, unknown>>,
  expected: Record<string, unknown>,
) => {
  const before = await tail();
  expect(await run()).toEqual(expected);
  expect(await tail()).toBe(before);
};
const insert = (text: string, more: Record<string, unknown> = {}) => ({
  intent: "insert",
  table: "ledger.notes",
  set: { text },
  ...more,
});
const say = (text: string) => ({ kind: "user_message", text });

beforeAll(async () => {
  s = await openReusable("saveslot-write-evidence-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  readBufferOf(s.store).take();
  ids = 0;
  await createTenant(s.store, ctx());
  const slot = (events: unknown) =>
    s.store.write(async (tx) => {
      const op = await appendOperation(tx, {
        actor: USER as never,
        now: "2026-11-05T00:00:30.000Z" as never,
        events: events as never,
      });
      await applyEvents(tx, eventsOf(op));
    });
  await slot(
    createSlotEvents({
      compiled: { ...COMPILED_V1, tables: [notes("t1")] } as never,
      changes: CHANGES("t1") as never,
    }),
  );
  // The second slot: the same events with its own slot and draft IDs, name and table.
  const second = JSON.stringify(
    createSlotEvents({
      compiled: { ...COMPILED_V1, name: "health", tables: [notes("t9")] } as never,
      changes: CHANGES("t9") as never,
    }),
  )
    .replaceAll(SLOT, SLOT2)
    .replaceAll(DRAFT, DRAFT2)
    .replaceAll('"ledger"', '"health"');
  await slot(JSON.parse(second));
}, T);

describe("an op's own evidence", () => {
  it(
    "sources: the request's, then each op's own in op order; an op's values from what it sees",
    async () => {
      const r = await send({
        sv: 1,
        evidence: [say("R0")],
        ops: [
          insert("a", { evidence: [say("A")] }),
          insert("b"),
          insert("c", { evidence: [say("B"), say("C")] }),
        ],
      });
      const op = r.seq;
      expect(await sourcesOfOp(op)).toEqual([
        { seq: op + 1, kind: "user_message", text: "R0" },
        { seq: op + 2, kind: "user_message", text: "A" },
        { seq: op + 3, kind: "user_message", text: "B" },
        { seq: op + 4, kind: "user_message", text: "C" },
      ]);
      // op 0: its own only (no evidence_refs); op 1: the request's; op 2: its own two.
      expect(await valueSourcesOfOp(op)).toEqual([[op + 2], [op + 1], [op + 3, op + 4]]);
      // op 2 sees two segments and maps none of its fields to them (evidence_by_field).
      expect(r.warnings).toEqual([{ code: "multi_segment_unmapped", op: 2, fields: ["text"] }]);
    },
    T,
  );

  it(
    "with segments of its own and no evidence_refs, an op cites none of the request's",
    async () => {
      const r = await send({
        sv: 1,
        evidence: [say("R0")],
        ops: [insert("a", { evidence: [say("A")] })],
      });
      expect(await valueSourcesOfOp(r.seq)).toEqual([[r.seq + 2]]);
      expect(r.warnings).toEqual([{ code: "evidence_unreferenced", evidence: [0] }]);
    },
    T,
  );

  it(
    "with evidence_refs too: its own, then the request's it names",
    async () => {
      const r = await send({
        sv: 1,
        evidence: [say("R0"), say("R1")],
        ops: [insert("a", { evidence: [say("A")], evidence_refs: [1] })],
      });
      const op = r.seq;
      expect(await valueSourcesOfOp(op)).toEqual([[op + 3, op + 2]]);
      expect(r.warnings).toEqual([
        { code: "multi_segment_unmapped", op: 0, fields: ["text"] },
        { code: "evidence_unreferenced", evidence: [0] },
      ]);
    },
    T,
  );

  it(
    "no evidence in the request: an api_call only for the ops with none of their own",
    async () => {
      const r = await send({
        sv: 1,
        ops: [insert("a", { evidence: [say("A")] }), insert("b")],
      });
      const op = r.seq;
      expect(await sourcesOfOp(op)).toEqual([
        { seq: op + 1, kind: "user_message", text: "A" },
        { seq: op + 2, kind: "api_call", op: 1 },
      ]);
      expect(await valueSourcesOfOp(op)).toEqual([[op + 1], [op + 2]]);
    },
    T,
  );
});

describe("an empty array is as if not given", () => {
  it(
    "an op's evidence: [] with no request evidence: the op's api_call",
    async () => {
      const r = await send({ sv: 1, ops: [insert("a", { evidence: [] })] });
      expect(r["refused"]).toBeUndefined();
      expect(await sourcesOfOp(r.seq)).toEqual([{ seq: r.seq + 1, kind: "api_call", op: 0 }]);
      expect(await valueSourcesOfOp(r.seq)).toEqual([[r.seq + 1]]);
    },
    T,
  );

  it(
    "an op's evidence: [] beside the request's: the op cites all of the request's",
    async () => {
      const r = await send({ sv: 1, evidence: [say("R0")], ops: [insert("a", { evidence: [] })] });
      expect(r["refused"]).toBeUndefined();
      expect(await valueSourcesOfOp(r.seq)).toEqual([[r.seq + 1]]);
      expect(r.warnings ?? []).toEqual([]);
    },
    T,
  );

  it(
    "evidence_refs: [] beside the request's: all of the request's",
    async () => {
      const r = await send({
        sv: 1,
        evidence: [say("R0"), say("R1")],
        ops: [insert("a", { evidence_refs: [] })],
      });
      expect(r["refused"]).toBeUndefined();
      expect(await valueSourcesOfOp(r.seq)).toEqual([[r.seq + 1, r.seq + 2]]);
    },
    T,
  );

  it(
    "the request's evidence: []: each op's api_call",
    async () => {
      const r = await send({ sv: 1, evidence: [], ops: [insert("a")] });
      expect(r["refused"]).toBeUndefined();
      expect(await sourcesOfOp(r.seq)).toEqual([{ seq: r.seq + 1, kind: "api_call", op: 0 }]);
    },
    T,
  );
});

describe("source_ref", () => {
  it(
    "names the source it refers to: no new source, the value from that one",
    async () => {
      const first = await send({ sv: 1, evidence: [say("it was a")], ops: [insert("a")] });
      const said = await sourceRow(first.seq + 1);
      expect(said.kind).toBe("user_message");
      const r = await send({
        sv: 1,
        ops: [insert("a, again", { evidence: [{ kind: "source_ref", id: said.source_id }] })],
      });
      expect(await sourcesOfOp(r.seq)).toEqual([]);
      expect(await valueSourcesOfOp(r.seq)).toEqual([[first.seq + 1]]);
      // The request's too, beside a new segment of an op.
      const both = await send({
        sv: 1,
        evidence: [{ kind: "source_ref", id: said.source_id }],
        ops: [insert("b", { evidence: [say("B")], evidence_refs: [0] })],
      });
      expect(await sourcesOfOp(both.seq)).toEqual([
        { seq: both.seq + 1, kind: "user_message", text: "B" },
      ]);
      expect(await valueSourcesOfOp(both.seq)).toEqual([[both.seq + 1, first.seq + 1]]);
    },
    T,
  );

  /** The sources an operation's events cite: value sources, interval sources, operation sources. */
  const citedByOp = async (op: number) => {
    const out = new Set<number>();
    for (const e of await eventsOfOp(op)) {
      for (const [path, v] of Object.entries(e.blocks)) {
        if (path.startsWith("sources/") && Array.isArray(v)) {
          for (const x of v as { source?: number }[]) if (x.source !== undefined) out.add(x.source);
        }
        if ((path === "op_sources" || path.startsWith("valid_sources")) && Array.isArray(v)) {
          for (const x of v as unknown[]) if (typeof x === "number") out.add(x);
        }
      }
    }
    return [...out].sort((a, b) => a - b);
  };

  it(
    "a request-level source_ref no op cites: warned as unreferenced, cited nowhere in the operation",
    async () => {
      const said = await send({ sv: 1, evidence: [say("it was a")], ops: [insert("a")] });
      const x = (await sourceRow(said.seq + 1)).source_id;
      const r = await send({
        sv: 1,
        evidence: [{ kind: "source_ref", id: x }, say("B")],
        ops: [insert("b", { evidence_refs: [1] })],
      });
      expect(r.warnings).toEqual([{ code: "evidence_unreferenced", evidence: [0] }]);
      expect(await citedByOp(r.seq)).toEqual([r.seq + 1]);
    },
    T,
  );

  it(
    "a source_ref of an op that is a no-op: the operation's events do not cite it",
    async () => {
      const said = await send({ sv: 1, evidence: [say("it was a")], ops: [insert("a")] });
      const x = (await sourceRow(said.seq + 1)).source_id;
      const row = said.ops[0]?.target.row as string;
      const r = await send({
        sv: 1,
        ops: [
          // The same value again: a no-op, nothing of it in the events.
          {
            intent: "update",
            table: "ledger.notes",
            row,
            ver: said.ops[0]?.ver,
            set: { text: "a" },
            evidence: [{ kind: "source_ref", id: x }],
          },
          insert("b", { evidence: [say("B")] }),
        ],
      });
      expect(r.ops[0]?.fields["text"]).toMatchObject({ result: "noop" });
      expect(await citedByOp(r.seq)).toEqual([r.seq + 1]);
      expect(await citedByOp(r.seq)).not.toContain(said.seq + 1);
    },
    T,
  );

  it.each<[string, (id: string) => Record<string, unknown>, string]>([
    [
      "in the request",
      (id) => ({ evidence: [{ kind: "source_ref", id }], ops: [insert("x")] }),
      "evidence/0/id",
    ],
    [
      "in an op",
      (id) => ({
        ops: [insert("y"), insert("x", { evidence: [say("s"), { kind: "source_ref", id }] })],
      }),
      "ops/1/evidence/1/id",
    ],
  ])(
    "refusals, %s",
    async (_, at, param) => {
      // No such source.
      await refused(() => send({ sv: 1, ...at(`s_${"9".repeat(16)}`) }), {
        refused: "not_found",
        reason: "source",
        param,
      });
      // The record of a call without evidence: no original to refer to.
      const call = await send({ sv: 1, ops: [insert("by api")] });
      const recorded = await sourceRow(call.seq + 1);
      expect(recorded.kind).toBe("api_call");
      await refused(() => send({ sv: 1, ...at(recorded.source_id) }), {
        refused: "invalid_argument",
        reason: "malformed",
        param,
      });
      // A source of another visible slot.
      const elsewhere = await send({
        sv: 1,
        evidence: [say("in health")],
        ops: [{ intent: "insert", table: "health.notes", set: { text: "h" } }],
      });
      const other = await sourceRow(elsewhere.seq + 1);
      await refused(() => send({ sv: 1, ...at(other.source_id) }), {
        refused: "invalid_argument",
        reason: "cross_slot",
        param,
      });
    },
    T,
  );

  it(
    "keep_effective's evidence may name a source: no new source in the decision's operation",
    async () => {
      const said = await send({ sv: 1, evidence: [say("it was z")], ops: [insert("a")] });
      const ref = (await sourceRow(said.seq + 1)).source_id;
      const row = said.ops[0]?.target.row as string;
      await send({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "ledger.notes",
            row,
            ver: said.ops[0]?.ver,
            set: { memo: "y" },
          },
        ],
      });
      const c = await send({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "ledger.notes",
            row,
            ver: said.ops[0]?.ver,
            set: { memo: "z" },
          },
        ],
      });
      const item = c.pending[0] as { id: string };
      const d = (await pending$(s.store, ctx(), { id: item.id })) as unknown as {
        item_ver: string;
      };
      const op = (await tail()) + 1;
      const r = (await resolve({
        id: item.id,
        decision: "keep_effective",
        item_ver: d.item_ver,
        evidence: [{ kind: "source_ref", id: ref }],
      })) as { seq?: number; refused?: string };
      expect(r.refused).toBeUndefined();
      // The decision's operation: its head names the source as its operation source, and no
      // source.recorded: the evidence is the source it names.
      const events = await eventsOfOp(op);
      expect(events.find((e) => e.type === "item.resolved")?.blocks["op_sources"]).toEqual([
        said.seq + 1,
      ]);
      expect(events.filter((e) => e.type === "source.recorded")).toEqual([]);
    },
    T,
  );
});

describe("source_ref, more", () => {
  /** A source this case recorded: a user's words. */
  const recorded = async () => {
    const said = await send({ sv: 1, evidence: [say("it was a")], ops: [insert("a")] });
    return { said, seq: said.seq + 1, id: (await sourceRow(said.seq + 1)).source_id };
  };
  const setState = (id: string, state: string) =>
    s.store.write((tx) =>
      tx.query("UPDATE sources SET deletion_state = $1 WHERE source_id = $2", [state, id]),
    );

  it(
    "a deleted source is not there; one in a pending deletion is refused as such",
    async () => {
      // Deletion is not implemented yet: the states are set directly. When it comes, these take
      // the real path (a confirmed deletion, a deletion in its grace period).
      const a = await recorded();
      await setState(a.id, "removed");
      await refused(
        () => send({ sv: 1, evidence: [{ kind: "source_ref", id: a.id }], ops: [insert("x")] }),
        { refused: "not_found", reason: "source", param: "evidence/0/id" },
      );
      const b = await recorded();
      await setState(b.id, "pending_deletion");
      await refused(
        () => send({ sv: 1, evidence: [{ kind: "source_ref", id: b.id }], ops: [insert("y")] }),
        { refused: "invalid_argument", reason: "pending_deletion_source", param: "evidence/0/id" },
      );
    },
    T,
  );

  it(
    "one source named twice is one value source",
    async () => {
      const a = await recorded();
      const ref = { kind: "source_ref", id: a.id };
      const twice = await send({ sv: 1, evidence: [ref, ref], ops: [insert("x")] });
      expect(await valueSourcesOfOp(twice.seq)).toEqual([[a.seq]]);
      const both = await send({
        sv: 1,
        evidence: [ref],
        ops: [insert("y", { evidence: [ref], evidence_refs: [0] })],
      });
      expect(await valueSourcesOfOp(both.seq)).toEqual([[a.seq]]);
    },
    T,
  );

  it(
    "checked after the request key, before sv's fallback and read_first",
    async () => {
      const a = await recorded();
      const params = { sv: 1, evidence: [{ kind: "source_ref", id: a.id }], ops: [insert("x")] };
      const first = await send(params);
      expect(first["refused"]).toBeUndefined();
      // The source deleted since: the same request again is a replay, answered as it was.
      await setState(a.id, "removed");
      const again = await send(params);
      expect({ seq: again.seq, replayed: again["replayed"] }).toEqual({
        seq: first.seq,
        replayed: true,
      });
      // A principal that has read nothing, without sv: the evidence is refused first...
      const OTHER = `ci_${"2".repeat(26)}`;
      const bad = {
        evidence: [{ kind: "source_ref", id: `s_${"9".repeat(16)}` }],
        ops: [insert("y")],
      };
      await refused(() => send(bad, OTHER), {
        refused: "not_found",
        reason: "source",
        param: "evidence/0/id",
      });
      // ...and without that segment, the same request is read_first on sv.
      expect((await send({ ops: [insert("y")] }, OTHER))["refused"]).toBe("read_first");
    },
    T,
  );

  it(
    "taking a candidate with evidence naming a source: the decision's operation sources and its api_call name it",
    async () => {
      const a = await recorded();
      const row = a.said.ops[0]?.target.row as string;
      const ver = a.said.ops[0]?.ver;
      await send({
        sv: 1,
        ops: [{ intent: "update", table: "ledger.notes", row, ver, set: { memo: "y" } }],
      });
      const c = await send({
        sv: 1,
        ops: [{ intent: "update", table: "ledger.notes", row, ver, set: { memo: "z" } }],
      });
      const item = c.pending[0] as { id: string };
      const d = (await pending$(s.store, ctx(), { id: item.id })) as unknown as {
        item_ver: string;
      };
      const op = (await tail()) + 1;
      const r = (await resolve({
        id: item.id,
        decision: "take_candidate",
        item_ver: d.item_ver,
        note: "the later one",
        evidence: [{ kind: "source_ref", id: a.id }],
      })) as { seq?: number; refused?: string };
      expect(r.refused).toBeUndefined();
      const events = await eventsOfOp(op);
      // One new source: the decision's own api_call (it has a note), naming the evidence by ID.
      const recordedHere = events.filter((e) => e.type === "source.recorded");
      expect(recordedHere.map((e) => (e.blocks["target"] as { kind: string }).kind)).toEqual([
        "api_call",
      ]);
      expect(
        (recordedHere[0]?.blocks["request"] as { evidence?: string[] } | undefined)?.evidence,
      ).toEqual([a.id]);
      // The decision's operation sources (on its head, item.resolved): the named source, then the
      // api_call. Its write's items are carried from the candidate, as a taken candidate's are.
      const head = events.find((e) => e.type === "item.resolved");
      expect(head?.blocks["op_sources"]).toEqual([a.seq, recordedHere[0]?.seq]);
      expect(events.some((e) => e.type === "write.base")).toBe(true);
    },
    T,
  );
});
