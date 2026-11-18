// Resolving pending items on PGlite (04-contract `resolve`, §6; 01-objects «待处理事项»; 09-event-format
// §5.8 `item.resolved`): each decision of this version, the order of the checks with each refusal,
// the item version bound and taken by fallback, a repeat by request key and by the same decision,
// and the other items on the row the triggered write reaches.
import {
  appendOperation,
  applyEvents,
  clearBlocks,
  createOpsContext,
  createTenant,
  entryChecksums,
  eventsOf,
  issueConnection,
  pending as pending$,
  type ResolveReceipt,
  readBufferOf,
  readEvents,
  readTail,
  renameConnection,
  resolve as resolve$,
  revokeConnection,
  WriteError,
} from "@fluxvita/saveslot-kernel";
import {
  COMPILED_V1,
  createSlotEvents,
  resolveInTx,
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

/** Resolves through the pipeline as `actor`; the error, if refused. */
async function resolve(
  params: unknown,
  o: { actor?: string; task?: string | null } = {},
): Promise<ResolveReceipt & Record<string, unknown>> {
  try {
    return (await s.store.write((tx) =>
      resolveInTx(tx, {
        actor: (o.actor ?? USER) as never,
        task: o.task ?? null,
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
  s = await openReusable("saveslot-resolve-cases-");
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
const ofType = async (op: number, type: string) =>
  (await eventsOfOp(op)).filter((e) => e.type === type);

/** 9 then 9.5 in effect (op b); a write of 10 seeing op a: a candidate on a conflict item. */
// Each scenario's rows differ (`c`): the same request again would be a repeat of the first.
let scenario = 0;
async function disputed() {
  scenario++;
  const a = await send({
    sv: 1,
    ops: [{ intent: "insert", table: "rows", set: { b: "9", c: `s${scenario}` } }],
  });
  const row = rowAt(a);
  const b = await update(row, { b: "9.5" }, verAt(a));
  const c = await update(row, { b: "10" }, verAt(a));
  const item = c.pending[0]?.id as string;
  return { a, b, c, row, item };
}

/** The value of `b` on a row of `rows` now. */
const bOf = async (row: string) =>
  (
    await s.store.read((tx) =>
      tx.query<{ f_f2: unknown }>("SELECT f_f2 FROM t_t1_v1 WHERE row_id = $1", [row]),
    )
  ).rows[0]?.f_f2;
const verOfItem = (r: { pending: readonly { id: string; item_ver?: string }[] }, id: string) =>
  r.pending.find((p) => p.id === id)?.item_ver as string;
/** An item's details, read by the user (04-contract-types §4.8). */
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
  )) as unknown as Record<string, unknown>;
const flagsOf = async (item: string) =>
  (await s.store.read((tx) => tx.query("SELECT flag FROM flags WHERE item_id = $1", [item]))).rows;

describe("the decisions of this version (04-contract §6)", () => {
  it(
    "keep_effective: the item resolved, its flag gone, the value kept, no write; item.resolved confirms the entries",
    async () => {
      const { c, row, item } = await disputed();
      const BEFORE = await bOf(row);
      const r = await resolve({
        id: item,
        decision: "keep_effective",
        item_ver: verOfItem(c, item),
      });
      expect(r).toMatchObject({
        id: item,
        type: "conflict",
        decision: "keep_effective",
        status: "resolved",
      });
      expect(r).not.toHaveProperty("write");
      expect(await itemRow(item)).toMatchObject({ state: "resolved" });
      expect(await flagsOf(item)).toEqual([]);
      expect(await bOf(row)).toEqual(BEFORE);
      const [ev] = await ofType(Number(r.item_ver.split(".")[1]), "item.resolved");
      expect(ev?.blocks["target"]).toEqual({
        item,
        decision: "keep_effective",
        item_op: c.seq,
        restore_count: 0,
        via: "call",
      });
      expect(ev?.blocks["confirmation"]).toMatchObject({
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      // Neither evidence nor a note, and no write: no source.
      expect(ev?.blocks).not.toHaveProperty("op_sources");
    },
    T,
  );

  it(
    "take_candidate: the candidate's value written by the decision, with its take record and an api_call source",
    async () => {
      const { c, row, item } = await disputed();
      const r = await resolve({
        id: item,
        decision: "take_candidate",
        item_ver: verOfItem(c, item),
      });
      expect(r).toMatchObject({ decision: "take_candidate", status: "resolved" });
      expect(r.write?.ops[0]?.fields["b"]).toMatchObject({ result: "applied", after: "10" });
      const op = r.write?.seq as number;
      const [base] = await ofType(op, "write.base");
      expect(base?.blocks["take"]).toMatchObject({ item, candidate: 0 });
      expect(base?.blocks["target"]).toMatchObject({ cause: "resolve", item, intent: "update" });
      const [src] = await ofType(op, "source.recorded");
      expect(src?.blocks["target"]).toMatchObject({ kind: "api_call" });
      expect((await ofType(op, "item.resolved"))[0]?.blocks["op_sources"]).toEqual([src?.seq]);
      expect(JSON.stringify(await bOf(row))).toContain("10");
    },
    T,
  );

  it(
    "take_previous: back to the merge base's value, with a revert record",
    async () => {
      const { a, c, row, item } = await disputed();
      const r = await resolve({
        id: item,
        decision: "take_previous",
        item_ver: verOfItem(c, item),
      });
      expect(r.write?.ops[0]?.fields["b"]).toMatchObject({ result: "applied", after: "9" });
      const [base] = await ofType(r.write?.seq as number, "write.base");
      expect(base?.blocks["revert"]).toMatchObject({ as_of_op: a.seq, item });
      expect(JSON.stringify(await bOf(row))).toContain("9");
    },
    T,
  );

  it(
    "confirm and reject an awaiting item (a fill across a gap): confirmed, the proposal takes effect; rejected, nothing changes",
    async () => {
      const proposal = async () => {
        scenario++;
        const e = await send({
          sv: 1,
          ops: [
            {
              intent: "insert",
              table: "entities",
              valid_from: "2026-11-01",
              set: { b: "x", c: `s${scenario}` },
            },
          ],
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
              valid_from: "2026-11-10",
              valid_to: "2026-11-15",
            },
          ],
        });
        const w = await send({
          sv: 1,
          ops: [
            {
              intent: "update",
              table: "entities",
              entity,
              ver: verAt(v),
              valid_from: "2026-11-05",
              valid_to: "2026-11-20",
              set: { b: "y" },
            },
          ],
        });
        const item = w.pending[0]?.id as string;
        expect(w.pending[0]?.type).toBe("awaiting_confirmation");
        return { w, item };
      };
      const yes = await proposal();
      const r1 = await resolve({
        id: yes.item,
        decision: "confirm",
        item_ver: verOfItem(yes.w, yes.item),
      });
      expect(r1).toMatchObject({ type: "awaiting_confirmation", decision: "confirm" });
      const parts = r1.write?.ops[0]?.fields["b"] as unknown as { result: string }[];
      expect(parts.map((p) => p.result)).toEqual(parts.map(() => "applied"));
      const no = await proposal();
      const r2 = await resolve({
        id: no.item,
        decision: "reject",
        item_ver: verOfItem(no.w, no.item),
      });
      expect(r2).toMatchObject({ decision: "reject", status: "resolved" });
      expect(r2).not.toHaveProperty("write");
    },
    T,
  );
});

describe("the order of the checks (04-contract `resolve`)", () => {
  it(
    "no such item: not_found",
    async () => {
      expect(
        await resolve({ id: `pi_${"9".repeat(16)}`, decision: "keep_effective" }),
      ).toMatchObject({
        refused: "not_found",
        param: "id",
      });
    },
    T,
  );

  it(
    "a repeat: the same request (request key), and the same decision in another request; another decision: item_closed",
    async () => {
      const { c, item } = await disputed();
      const params = { id: item, decision: "keep_effective", item_ver: verOfItem(c, item) };
      const first = await resolve(params);
      const tail = (await s.store.read(readTail))?.seq;
      const again = await resolve(params);
      expect(again).toEqual({ ...first, replayed: true });
      // Another request (a note), the same decision: the original result too.
      const noted = await resolve({ ...params, note: "same again" });
      expect(noted).toEqual({ ...first, replayed: true });
      expect((await s.store.read(readTail))?.seq).toBe(tail);
      expect(await resolve({ ...params, decision: "take_previous" })).toMatchObject({
        refused: "item_closed",
        reason: "resolved",
        resolution: { decision: "keep_effective", seq: first.write?.seq ?? expect.any(Number) },
      });
    },
    T,
  );

  it(
    "a superseded item: item_closed with the reason",
    async () => {
      const { b, c, row, item } = await disputed();
      // The writer had its receipt with the item: a write reaching it supersedes it.
      const by = await update(row, { b: "11" }, verAt(b));
      expect((await itemRow(item))?.state).toBe("superseded");
      // The shape the item's details give (04-contract-types §9 item_closed, §4.8).
      const superseded = (await detailOf(item))["superseded"];
      expect(superseded).toEqual({ reason: "overwritten", by: by.seq, at: expect.any(String) });
      expect(
        await resolve({ id: item, decision: "keep_effective", item_ver: verOfItem(c, item) }),
      ).toEqual({ refused: "item_closed", reason: "superseded", superseded });
    },
    T,
  );

  it(
    "a decision the item's type does not take: invalid_argument",
    async () => {
      const { c, item } = await disputed();
      expect(
        await resolve({ id: item, decision: "confirm", item_ver: verOfItem(c, item) }),
      ).toMatchObject({
        refused: "invalid_argument",
        param: "decision",
      });
    },
    T,
  );

  it(
    "an item version no longer current (the item refreshed since): confirmation_mismatch with the new one",
    async () => {
      const { b, c, row, item } = await disputed();
      const w = await update(row, { b: "9.6" }, verAt(b), { actor: OTHER });
      expect((await ofType(w.seq, "item.refreshed")).length).toBe(1);
      expect(
        await resolve({ id: item, decision: "keep_effective", item_ver: verOfItem(c, item) }),
      ).toMatchObject({
        refused: "confirmation_mismatch",
        reason: "changed",
        current: { id: item, item_ver: `iv_${item.slice(3)}.${w.seq}.0` },
      });
      expect((await itemRow(item))?.state).toBe("open");
    },
    T,
  );

  it(
    "item_ver left out: from the caller's own receipt, or its read of the item (item_ver_fallback); neither: read_first",
    async () => {
      const { c, item } = await disputed();
      expect(
        await resolve({ id: item, decision: "keep_effective" }, { actor: OTHER }),
      ).toMatchObject({
        refused: "read_first",
        reason: "no_read",
        param: "item_ver",
      });
      readBufferOf(s.store).record({
        read: `rd_${"7".repeat(16)}` as never,
        actor: OTHER as never,
        task: null,
        at: now() as never,
        pos: 1 as never,
        operation: "pending",
        rows: [],
        coarse: [],
        lastRead: [{ kind: "item", target: item, op: c.seq, restoreCount: 0 }],
      });
      const read = await resolve({ id: item, decision: "keep_effective" }, { actor: OTHER });
      expect(read.warnings).toEqual([
        { code: "item_ver_fallback", item_ver: verOfItem(c, item), read: `rd_${"7".repeat(16)}` },
      ]);
      const other = await disputed();
      const own = await resolve({ id: other.item, decision: "keep_effective" });
      expect(own.warnings).toEqual([
        { code: "item_ver_fallback", item_ver: verOfItem(other.c, other.item) },
      ]);
    },
    T,
  );

  it(
    "take_candidate on an item with two candidates: candidate_required with the choices; naming one takes it",
    async () => {
      const { a, c, row, item } = await disputed();
      const d = await update(row, { b: "12" }, verAt(a), { actor: OTHER });
      expect(d.pending[0]).toMatchObject({ id: item, merged: true });
      const ver = `iv_${item.slice(3)}.${d.seq}.0`;
      expect(await resolve({ id: item, decision: "take_candidate", item_ver: ver })).toMatchObject({
        refused: "invalid_argument",
        reason: "candidate_required",
        candidate_choices: [
          { index: 0, seq: c.seq, actor: { kind: "user", id: USER, name: USER } },
          { index: 1, seq: d.seq, actor: { kind: "user", id: OTHER, name: OTHER } },
        ],
      });
      expect(
        await resolve({ id: item, decision: "take_candidate", item_ver: ver, candidate: 2 }),
      ).toMatchObject({ refused: "invalid_argument", reason: "index_out_of_range" });
      const r = await resolve({
        id: item,
        decision: "take_candidate",
        item_ver: ver,
        candidate: 1,
      });
      expect(r.write?.ops[0]?.fields["b"]).toMatchObject({ result: "applied", after: "12" });
      const [base] = await ofType(r.write?.seq as number, "write.base");
      expect(base?.blocks["take"]).toMatchObject({ candidate: 1 });
    },
    T,
  );
});

describe("more on the checks", () => {
  it(
    "the same decision on another candidate is not a repeat: item_closed",
    async () => {
      const { a, row, item } = await disputed();
      const d = await update(row, { b: "12" }, verAt(a), { actor: OTHER });
      const ver = `iv_${item.slice(3)}.${d.seq}.0`;
      await resolve({ id: item, decision: "take_candidate", item_ver: ver, candidate: 0 });
      expect(
        await resolve({ id: item, decision: "take_candidate", item_ver: ver, candidate: 1 }),
      ).toMatchObject({
        refused: "item_closed",
        reason: "resolved",
        resolution: { decision: "take_candidate", candidate: 0 },
      });
    },
    T,
  );

  it(
    "an item version of another restore count: confirmation_mismatch, restored",
    async () => {
      const { c, item } = await disputed();
      expect(
        await resolve({
          id: item,
          decision: "keep_effective",
          item_ver: `iv_${item.slice(3)}.${c.seq}.1`,
        }),
      ).toMatchObject({ refused: "confirmation_mismatch", reason: "restored" });
    },
    T,
  );

  it(
    "the fallback takes the newer of the own receipt and the read: a read of the refreshed version binds it",
    async () => {
      const { b, row, item } = await disputed();
      // Refreshed by another connection after the resolver's own receipt gave the item.
      const w = await update(row, { b: "9.6" }, verAt(b), { actor: OTHER });
      readBufferOf(s.store).record({
        read: `rd_${"6".repeat(16)}` as never,
        actor: USER as never,
        task: null,
        at: now() as never,
        pos: 1 as never,
        operation: "pending",
        rows: [],
        coarse: [],
        lastRead: [{ kind: "item", target: item, op: w.seq, restoreCount: 0 }],
      });
      const r = await resolve({ id: item, decision: "keep_effective" });
      expect(r).toMatchObject({
        status: "resolved",
        warnings: [{ code: "item_ver_fallback", item_ver: `iv_${item.slice(3)}.${w.seq}.0` }],
      });
    },
    T,
  );
});

describe("the note a decision was given, in its resolution (04-contract-types §4.8 ItemResolution.note)", () => {
  const decide = async (note?: string) => {
    const { c, item } = await disputed();
    const r = await resolve({
      id: item,
      decision: "keep_effective",
      item_ver: verOfItem(c, item),
      ...(note !== undefined ? { note } : {}),
    });
    expect(r.status).toBe("resolved");
    return { item, op: Number(r.item_ver.split(".")[1]) };
  };
  /** The resolution as the item's details and as item_closed (another decision) give it. */
  const resolutions = async (item: string) => [
    ((await detailOf(item)) as { resolution?: unknown }).resolution,
    ((await resolve({ id: item, decision: "take_previous" })) as { resolution?: unknown })
      .resolution,
  ];

  it(
    "with a note: the details and item_closed give it back; without: neither has one",
    async () => {
      const noted = await decide("the later one");
      for (const r of await resolutions(noted.item))
        expect(r).toMatchObject({ decision: "keep_effective", note: "the later one" });
      const bare = await decide();
      for (const r of await resolutions(bare.item)) {
        expect(r).toMatchObject({ decision: "keep_effective" });
        expect(r).not.toHaveProperty("note");
      }
    },
    T,
  );

  it(
    "its source deleted: the note is gone from the resolution, the rest stays",
    async () => {
      const { item, op } = await decide("to be forgotten");
      const [call] = (await ofType(op, "source.recorded")).filter(
        (e) => (e.blocks["target"] as { kind: string }).kind === "api_call",
      );
      // As a deletion clears it: the request block of the api_call source.
      await s.store.write(async (tx) => {
        await clearBlocks(tx, (await readTail(tx))?.seq ?? 0, [
          { seq: call?.seq as number, path: "request" },
        ]);
      });
      for (const r of await resolutions(item)) {
        expect(r).toMatchObject({ decision: "keep_effective", seq: op });
        expect(r).not.toHaveProperty("note");
      }
    },
    T,
  );
});

describe("sources: evidence, and the note in an api_call (09 §4.3, §5.4)", () => {
  const evidence = [{ kind: "user_message", text: "SECRET-EVIDENCE" }];
  it.each([
    ["take_candidate", true],
    ["keep_effective", false],
  ])(
    "%s with a note and evidence: the segment, then an api_call with the note and the segment's ID",
    async (decision, writes) => {
      const { c, item } = await disputed();
      const r = await resolve({
        id: item,
        decision,
        item_ver: verOfItem(c, item),
        note: "SECRET-NOTE",
        evidence,
      });
      expect(r.status).toBe("resolved");
      const op = Number(r.item_ver.split(".")[1]);
      const sources = await ofType(op, "source.recorded");
      expect(sources.map((e) => (e.blocks["target"] as { kind: string }).kind)).toEqual([
        "user_message",
        "api_call",
      ]);
      const [segment, call] = sources;
      const segmentId = (segment?.blocks["target"] as { source_id?: string } | undefined)
        ?.source_id;
      // The request as asked, the evidence named by its source ID, not copied.
      expect(call?.blocks["request"]).toEqual({
        id: item,
        decision,
        note: "SECRET-NOTE",
        evidence: [segmentId],
      });
      expect(JSON.stringify(call?.blocks)).not.toContain("SECRET-EVIDENCE");
      const [head] = await ofType(op, "item.resolved");
      expect(head?.blocks["op_sources"]).toEqual([segment?.seq, call?.seq]);
      const [base] = await ofType(op, "write.base");
      if (writes) {
        // The taken candidate's value is carried from the candidate's write: the evidence and the
        // note are the decision's sources (op_sources), not the value's.
        expect(base?.blocks["sources/f2/0"]).toEqual([
          { kind: "value", carried: expect.objectContaining({ field: "f2", k: 0 }) },
        ]);
      } else expect(base).toBeUndefined();
    },
    T,
  );

  it(
    "a note alone, no write: an api_call; neither note nor evidence nor write: no source",
    async () => {
      const one = await disputed();
      const r1 = await resolve({
        id: one.item,
        decision: "keep_effective",
        item_ver: verOfItem(one.c, one.item),
        note: "n",
      });
      const s1 = await ofType(Number(r1.item_ver.split(".")[1]), "source.recorded");
      expect(s1.map((e) => e.blocks["request"])).toEqual([
        { id: one.item, decision: "keep_effective", note: "n" },
      ]);
      const two = await disputed();
      const r2 = await resolve({
        id: two.item,
        decision: "keep_effective",
        item_ver: verOfItem(two.c, two.item),
      });
      expect(await ofType(Number(r2.item_ver.split(".")[1]), "source.recorded")).toEqual([]);
    },
    T,
  );
});

describe("take_candidate again on a resolved item, the candidate left out", () => {
  it(
    "one candidate: left out names it, a repeat",
    async () => {
      const { c, item } = await disputed();
      const ver = verOfItem(c, item);
      const first = await resolve({ id: item, decision: "take_candidate", item_ver: ver });
      const again = await resolve({ id: item, decision: "take_candidate", note: "again" });
      expect(again).toEqual({ ...first, replayed: true });
    },
    T,
  );

  it(
    "several candidates: left out names none (an open item would say candidate_required), item_closed",
    async () => {
      const { a, row, item } = await disputed();
      const d = await update(row, { b: "12" }, verAt(a), { actor: OTHER });
      const ver = `iv_${item.slice(3)}.${d.seq}.0`;
      // Open, the same request is refused for want of a candidate.
      expect(await resolve({ id: item, decision: "take_candidate", item_ver: ver })).toMatchObject({
        refused: "invalid_argument",
        reason: "candidate_required",
      });
      // Candidate 0 taken: left out is still not "the same", though it would be the first.
      await resolve({ id: item, decision: "take_candidate", item_ver: ver, candidate: 0 });
      expect(await resolve({ id: item, decision: "take_candidate", note: "again" })).toMatchObject({
        refused: "item_closed",
        reason: "resolved",
        resolution: { decision: "take_candidate", candidate: 0 },
      });
    },
    T,
  );
});

describe("a restore since the receipt (04-contract §15)", () => {
  it(
    "item_ver left out, from an own receipt before a restore: confirmation_mismatch, restored",
    async () => {
      const { item } = await disputed();
      await s.store.write(async (tx) => {
        const tail = (await readTail(tx))?.seq ?? 0;
        // Appended only: applying a restore comes with restores.
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
      expect(await resolve({ id: item, decision: "keep_effective" })).toMatchObject({
        refused: "confirmation_mismatch",
        reason: "restored",
      });
    },
    T,
  );
});

describe("what the confirmation covers (09 §5.8)", () => {
  it(
    "after a refresh: the candidates the item was opened with and the refresh's groups, not the groups it replaced",
    async () => {
      const { b, c, row, item } = await disputed();
      const w = await update(row, { b: "9.6" }, verAt(b), { actor: OTHER });
      const [created] = await ofType(c.seq, "item.created");
      const [refreshed] = await ofType(w.seq, "item.refreshed");
      // By the rule, listed by hand: the refresh gives current, previous, impact (and scope_valid)
      // whole; candidates stay as the item was opened with them.
      const expected = [
        ...Object.keys(created?.blocks ?? {})
          .filter((p) => p.startsWith("candidates/"))
          .map((path) => ({ seq: created?.seq, path })),
        ...Object.keys(refreshed?.blocks ?? {})
          .filter((p) => /^(current|previous|impact|proposed)\/|^scope_valid$/.test(p))
          .map((path) => ({ seq: refreshed?.seq, path })),
      ];
      expect(expected.some((x) => x.seq === created?.seq)).toBe(true);
      expect(expected.some((x) => x.seq === refreshed?.seq)).toBe(true);
      const covered = await s.store.read((tx) => entryChecksums(tx, item));
      const key = (x: { seq: number | undefined; path: string }) => `${x.seq} ${x.path}`;
      expect(covered.map(key).sort()).toEqual(expected.map(key).sort());
      // None of the item.created's current/previous/impact: replaced by the refresh.
      expect(covered.some((x) => x.seq === created?.seq && !x.path.startsWith("candidates/"))).toBe(
        false,
      );
    },
    T,
  );
});

describe("the other items on the row (01-objects «不过期»)", () => {
  it(
    "a triggered write not reaching another item (a stretch apart): the other item is left alone",
    async () => {
      // Two conflict items on b over one row: impossible (they join). On an entity, two items on b
      // over stretches apart; taking one candidate over both stretches reaches the other.
      const e = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "x" } }],
      });
      const entity = e.ops[0]?.target.entity as string;
      const put = (b: string, ver: string, from: string, to: string, actor = USER) =>
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
      const y = await put("y", verAt(e), "2026-11-01", "2026-11-20");
      // A stale write over the whole stretch, and one apart from it by another connection.
      const wide = await put("w", verAt(e), "2026-11-01", "2026-11-10");
      const apart = await put("q", verAt(e), "2026-11-12", "2026-11-14", OTHER);
      const one = wide.pending[0]?.id as string;
      const two = apart.pending[0]?.id as string;
      expect(one).not.toBe(two);
      // Taking `w` changes [11-01, 11-10): it does not reach the other item's stretch.
      const r = await resolve({
        id: one,
        decision: "take_candidate",
        item_ver: verOfItem(wide, one),
      });
      expect(r.write?.pending ?? []).toEqual([]);
      expect((await itemRow(two))?.state).toBe("open");
      void y;
    },
    T,
  );

  it.each([
    ["another connection's", OTHER, "refreshed"],
    ["the resolver's own", USER, "superseded"],
  ])(
    "a triggered write reaching another conflict item (%s): %s",
    async (_, by, outcome) => {
      // b = 9.5 in effect over 9; a stale b = 10 makes item B on b; a stale revoke of the row
      // makes item A on its existence. Taking the revoke leaves b without a value: it reaches B.
      scenario++;
      const a = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "rows", set: { b: "9", c: `s${scenario}` } }],
      });
      const row = rowAt(a);
      await update(row, { b: "9.5" }, verAt(a), { actor: OTHER });
      const stale = await update(row, { b: "10" }, verAt(a), { actor: by });
      const b = stale.pending[0]?.id as string;
      const revoke = await send({
        sv: 1,
        ops: [{ intent: "revoke", table: "rows", row, ver: verAt(a) }],
      });
      const itemA = revoke.pending[0]?.id as string;
      expect(itemA).not.toBe(b);
      const r = await resolve({
        id: itemA,
        decision: "take_candidate",
        item_ver: verOfItem(revoke, itemA),
      });
      if (outcome === "refreshed") {
        expect(r.write?.pending).toEqual([expect.objectContaining({ id: b, refreshed: true })]);
        expect((await itemRow(b))?.state).toBe("open");
      } else {
        expect(r.write?.superseded).toEqual([{ item: b, type: "conflict", reason: "overwritten" }]);
        expect((await itemRow(b))?.state).toBe("superseded");
      }
    },
    T,
  );

  it(
    "confirming one of two awaiting items on a row: the other, reached, is refreshed when the resolver had not read it and superseded when it had",
    async () => {
      const twoProposals = async (secondBy: string) => {
        scenario++;
        const e = await send({
          sv: 1,
          ops: [
            {
              intent: "insert",
              table: "entities",
              valid_from: "2026-11-01",
              set: { b: "x", c: `s${scenario}` },
            },
          ],
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
              valid_from: "2026-11-10",
              valid_to: "2026-11-15",
            },
          ],
        });
        const fill = (b: string, actor: string) =>
          send(
            {
              sv: 1,
              ops: [
                {
                  intent: "update",
                  table: "entities",
                  entity,
                  ver: verAt(v),
                  valid_from: "2026-11-05",
                  valid_to: "2026-11-20",
                  set: { b },
                },
              ],
            },
            { actor },
          );
        const one = await fill("y", USER);
        const two = await fill("z", secondBy);
        return { one, two, a: one.pending[0]?.id as string, b: two.pending[0]?.id as string };
      };
      // The second proposed by another connection: the resolver had not read it.
      const p = await twoProposals(OTHER);
      expect(p.two.pending[0]?.type).toBe("awaiting_confirmation");
      const r = await resolve({ id: p.a, decision: "confirm", item_ver: verOfItem(p.one, p.a) });
      expect(r.write?.pending).toEqual([expect.objectContaining({ id: p.b, refreshed: true })]);
      expect((await itemRow(p.b))?.state).toBe("open");
      // Both proposed by the resolver: it had the second whole in its receipt.
      const q = await twoProposals(USER);
      const r2 = await resolve({ id: q.a, decision: "confirm", item_ver: verOfItem(q.one, q.a) });
      expect(r2.write?.superseded).toEqual([
        { item: q.b, type: "awaiting_confirmation", reason: "overwritten" },
      ]);
      expect((await itemRow(q.b))?.state).toBe("superseded");
    },
    T,
  );
});

describe("a decision's write without a required field where the entity has no value (04-contract-types §9)", () => {
  it(
    "taking a candidate on existence over a stretch without a value: validation_failed, no op and no param",
    async () => {
      const put = (o: Record<string, unknown>, actor = USER) =>
        send({ sv: 1, ops: [{ table: "entities", ...o }] }, { actor });
      const e = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "entities", valid_from: "2026-11-05", set: { b: "1" } }],
      });
      const entity = e.ops[0]?.target.entity as string;
      await put(
        {
          entity,
          intent: "revoke",
          ver: verAt(e),
          valid_from: "2026-11-05",
          valid_to: "2026-11-09",
        },
        OTHER,
      );
      const z = await put({
        entity,
        intent: "update",
        ver: verAt(e),
        valid_from: "2026-11-01",
        valid_to: "2026-11-07",
        set: { c: "x" },
      });
      const item = z.pending?.[0]?.id as string;
      // A decision has no ops: the detail names the table, not an op, and there is no `param`.
      expect(
        await resolve({ id: item, decision: "take_candidate", item_ver: verOfItem(z, item) }),
      ).toEqual({
        refused: "validation_failed",
        reason: "write",
        details: [
          {
            table: "ledger.entities",
            field: "b",
            code: "required_in_gap",
            valid: {
              valid_from: "2026-11-01",
              valid_to: "2026-11-05",
              valid_to_inclusive: "2026-11-04",
            },
          },
        ],
      });
      expect((await itemRow(item))?.state).toBe("open");
    },
    T,
  );

  it(
    "taking a candidate on a field into two stretches revoked since: one detail per stretch",
    async () => {
      const put = (o: Record<string, unknown>, actor = USER) =>
        send({ sv: 1, ops: [{ table: "entities", ...o }] }, { actor });
      const e = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "1" } }],
      });
      const entity = e.ops[0]?.target.entity as string;
      const c = (v: string) => ({
        valid_from: "2026-11-01",
        valid_to: "2026-11-07",
        set: { c: v },
      });
      await put({ entity, intent: "update", ver: verAt(e), ...c("m") });
      const z = await put({ entity, intent: "update", ver: verAt(e), ...c("x") }, OTHER);
      const item = z.pending?.[0]?.id as string;
      // Two holes in the candidate's interval: the candidate's c would fall where b has no value.
      const r1 = await put({
        entity,
        intent: "revoke",
        ver: verAt(z),
        valid_from: "2026-11-01",
        valid_to: "2026-11-03",
      });
      await put({
        entity,
        intent: "revoke",
        ver: verAt(r1),
        valid_from: "2026-11-05",
        valid_to: "2026-11-06",
      });
      const d = (await detailOf(item)) as { item_ver: string; target: { unit: string[] } };
      expect(d.target.unit).toEqual(["c"]);
      const gap = (from: string, to: string, last: string) => ({
        table: "ledger.entities",
        field: "b",
        code: "required_in_gap",
        valid: { valid_from: from, valid_to: to, valid_to_inclusive: last },
      });
      expect(await resolve({ id: item, decision: "take_candidate", item_ver: d.item_ver })).toEqual(
        {
          refused: "validation_failed",
          reason: "write",
          details: [
            gap("2026-11-01", "2026-11-03", "2026-11-02"),
            gap("2026-11-05", "2026-11-06", "2026-11-05"),
          ],
        },
      );
    },
    T,
  );

  it(
    "taking a candidate on a row revoked since: revoked, no param (a decision has no ops)",
    async () => {
      const { b, row, item } = await disputed();
      // By another principal, who had not read the item: it is refreshed, not superseded.
      const v = await send(
        { sv: 1, ops: [{ intent: "revoke", table: "rows", row, ver: verAt(b) }] },
        { actor: OTHER },
      );
      const d = (await detailOf(item)) as { item_ver: string };
      expect(await resolve({ id: item, decision: "take_candidate", item_ver: d.item_ver })).toEqual(
        { refused: "revoked", ops: [v.seq] },
      );
    },
    T,
  );
});

describe("confirmation_mismatch gives the item as it is now (04-contract-types §9 `current`)", () => {
  const ctxOf = (actor: string) =>
    createOpsContext({
      tenant: TENANT,
      actor: actor as never,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_key_window: 86_400_000,
      idempotency_window: 600_000,
      now: now(),
      confirmation: null,
    });
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      if (e instanceof WriteError) return { code: e.code, ...e.detail } as Record<string, unknown>;
      throw e;
    }
    throw new Error("not refused");
  };
  /** The reads a call recorded: exactly the ones in the buffer since it was emptied, put back. */
  const recordedBy = async (p: Promise<unknown>) => {
    readBufferOf(s.store).take();
    const err = await refusal(p);
    const reads = readBufferOf(s.store).take();
    readBufferOf(s.store).restore(reads);
    return { err, reads };
  };

  it(
    "the contents changed: current is the pending detail, word for word, item_ver included; it counts as read",
    async () => {
      const { b, c, row, item } = await disputed();
      await update(row, { b: "9.6" }, verAt(b), { actor: OTHER });
      const { err, reads } = await recordedBy(
        resolve$(s.store, ctxOf(USER), {
          id: item,
          decision: "keep_effective",
          item_ver: verOfItem(c, item),
        }),
      );
      expect(err).toMatchObject({ code: "confirmation_mismatch", reason: "changed" });
      // Exactly one read: the item's detail, by the caller.
      expect(reads).toEqual([expect.objectContaining({ actor: USER, operation: "pending" })]);
      const detail = await pending$(s.store, ctxOf(USER), { id: item });
      expect(err["current"]).toEqual(detail);
      // Read through the mismatch: left out, the item version is the one current gave.
      const r = await resolve$(s.store, ctxOf(USER), { id: item, decision: "keep_effective" });
      expect(r).toMatchObject({
        status: "resolved",
        warnings: [
          { code: "item_ver_fallback", item_ver: (detail as { item_ver: string }).item_ver },
        ],
      });
    },
    T,
  );

  it(
    "the item changed again after the mismatch: left out, item_ver is still the one read, a mismatch again",
    async () => {
      const { b, c, row, item } = await disputed();
      const w = await update(row, { b: "9.6" }, verAt(b), { actor: OTHER });
      await refusal(
        resolve$(s.store, ctxOf(USER), {
          id: item,
          decision: "keep_effective",
          item_ver: verOfItem(c, item),
        }),
      );
      await update(row, { b: "9.7" }, verAt(w), { actor: OTHER });
      expect(
        await refusal(resolve$(s.store, ctxOf(USER), { id: item, decision: "keep_effective" })),
      ).toMatchObject({ code: "confirmation_mismatch", reason: "changed" });
    },
    T,
  );

  it(
    "a restore since: confirmation_mismatch restored, with current",
    async () => {
      const { c, item } = await disputed();
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
      const { err, reads } = await recordedBy(
        resolve$(s.store, ctxOf(USER), {
          id: item,
          decision: "keep_effective",
          item_ver: verOfItem(c, item),
        }),
      );
      expect(reads).toEqual([expect.objectContaining({ actor: USER, operation: "pending" })]);
      expect(err).toMatchObject({
        code: "confirmation_mismatch",
        reason: "restored",
        current: { id: item, item_ver: `iv_${item.slice(3)}.${c.seq}.1` },
      });
      expect(err["current"]).toEqual(await pending$(s.store, ctxOf(USER), { id: item }));
    },
    T,
  );
});

describe("how a resolved item closed: its details and item_closed give the same resolution", () => {
  it(
    "take_candidate: the candidate taken, by its index in the item's candidates; seq and at",
    async () => {
      const { a, c, row, item } = await disputed();
      const d = await update(row, { b: "12" }, verAt(a), { actor: OTHER });
      const ver = `iv_${item.slice(3)}.${d.seq}.0`;
      const r = await resolve({
        id: item,
        decision: "take_candidate",
        item_ver: ver,
        candidate: 1,
      });
      const detail = await detailOf(item);
      const resolution = detail["resolution"] as { candidate: number; at: string };
      expect(resolution).toEqual({
        decision: "take_candidate",
        candidate: 1,
        seq: r.write?.seq,
        at: expect.any(String),
        actor: { kind: "user", id: USER, name: USER },
      });
      // The index names the candidate taken among the item's candidates as they were then.
      const candidates = detail["candidates"] as { index: number; seq: number }[];
      expect(candidates.map((x) => [x.index, x.seq])).toEqual([
        [0, c.seq],
        [1, d.seq],
      ]);
      expect(candidates[resolution.candidate]?.seq).toBe(d.seq);
      expect(await resolve({ id: item, decision: "keep_effective", item_ver: ver })).toEqual({
        refused: "item_closed",
        reason: "resolved",
        resolution,
      });
    },
    T,
  );
});

describe("an error's details name principals as they are now (04-contract-types §1.6)", () => {
  const ops = (second: number) =>
    createOpsContext({
      tenant: TENANT,
      actor: USER,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_key_window: 86_400_000,
      idempotency_window: 600_000,
      now: `2026-11-05T00:00:${String(second).padStart(2, "0")}.000Z`,
      confirmation: null,
    });
  const register = async () =>
    (await issueConnection(s.store, ops(40), { name: "Desk · Host", via: "token" })).id;
  const rename = (id: string) =>
    renameConnection(s.store, ops(41), { id: id as never, name: "Laptop · Host" });
  const revoke = (id: string) => revokeConnection(s.store, ops(42), { id: id as never });

  it(
    "candidate_required: each candidate's writer, renamed since the write",
    async () => {
      const desk = await register();
      const a = await send({ sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "9" } }] });
      const row = rowAt(a);
      await update(row, { b: "9.5" }, verAt(a));
      const c = await update(row, { b: "10" }, verAt(a), { actor: desk });
      const item = c.pending[0]?.id as string;
      const d = await update(row, { b: "12" }, verAt(a));
      await rename(desk);
      const ver = `iv_${item.slice(3)}.${d.seq}.0`;
      expect(await resolve({ id: item, decision: "take_candidate", item_ver: ver })).toEqual({
        refused: "invalid_argument",
        reason: "candidate_required",
        param: "candidate",
        candidate_choices: [
          { index: 0, seq: c.seq, actor: { kind: "connection", id: desk, name: "Laptop · Host" } },
          { index: 1, seq: d.seq, actor: { kind: "user", id: USER, name: USER } },
        ],
      });
    },
    T,
  );

  it(
    "item_closed: who resolved it, renamed and then revoked since",
    async () => {
      const desk = await register();
      const { c, item } = await disputed();
      // The decision's operation: the next position (keep_effective triggers no write).
      const op = ((await s.store.read(readTail))?.seq ?? 0) + 1;
      await resolve(
        { id: item, decision: "keep_effective", item_ver: verOfItem(c, item) },
        { actor: desk },
      );
      const at = ((await detailOf(item))["resolution"] as { at: string }).at;
      const again = () =>
        resolve({ id: item, decision: "take_previous", item_ver: verOfItem(c, item) });
      const closed = (actor: Record<string, unknown>) => ({
        refused: "item_closed",
        reason: "resolved",
        resolution: { decision: "keep_effective", seq: op, at, actor },
      });
      await rename(desk);
      expect(await again()).toEqual(
        closed({ kind: "connection", id: desk, name: "Laptop · Host" }),
      );
      await revoke(desk);
      expect(await again()).toEqual(
        closed({ kind: "connection", id: desk, name: "Laptop · Host", state: "revoked" }),
      );
    },
    T,
  );
});

describe("a log the decoder cannot read back: the write is an internal error, not a bare exception", () => {
  it(
    "a decision the decoder does not know, on the row written next",
    async () => {
      const { b, c, row, item } = await disputed();
      await resolve({ id: item, decision: "keep_effective", item_ver: verOfItem(c, item) });
      const resolved = Number(
        (
          await s.store.read((tx) =>
            tx.query<{ seq: unknown }>(
              "SELECT seq FROM events WHERE type = 'item.resolved' ORDER BY seq DESC LIMIT 1",
            ),
          )
        ).rows[0]?.seq,
      );
      // Tamper with the log behind the checksums' back: the decision becomes one no decoder knows.
      await s.store.write((tx) =>
        tx.query("UPDATE content SET body = $2 WHERE seq = $1 AND path = 'target'", [
          resolved,
          JSON.stringify({
            item,
            decision: "bogus",
            item_op: c.seq,
            restore_count: 0,
            via: "call",
          }),
        ]),
      );
      expect(await update(row, { b: "11" }, verAt(b))).toEqual({
        refused: "internal",
        reason: "inconsistent",
      });
    },
    T,
  );
});
