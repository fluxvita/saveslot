// Writes by external key through the write path, step by step, against the reference evaluator's
// sync model (03-data-model/04-write-and-read «按来源键写入»; 09-event-format §4.2). One row of a
// timeless table, created by key; then syncs (evidence pointed at or not), a user's changes (on
// the current version or a stale one), revokes, revokes undone at once, undos, and the three
// resolutions of an open conflict (on the field or on existence), each step one request to the
// real pipeline.
//
// After each step:
// (1) what entered the log, as the pipeline arranges it (09 §4.2): an op by key enters exactly when
//     its outcome is not `unchanged` or `skipped`; one that did not has no target in the head, no
//     `api_call`, and a request none of whose ops entered appends nothing. This checks the
//     arrangement only: the pipeline and judge share `encodeOp`, whose encoding is guarded by the
//     round trip in kernel/src/write/record.test.ts and the fixed cases.
// (2) the outcome the receipt gives is the reference's;
// (3) the key index has the one entry, the row's;
// (4) independently of the kernel's judging: the row's existence and values in effect, and its
//     open conflict items by unit, are the reference's.
// At the end the log replayed from an empty storage gives the same state (`log.reconcile`).
//
// The reference models no validation: a step the pipeline refuses (a write to a revoked row, an
// undo with nothing to undo, a decision on an item gone) is left out of both. A key added to a row
// by hand comes with part 6's request (its real write path).

import {
  createOpsContext,
  createTenant,
  pending,
  query,
  readEvents,
  readTail,
  reconcileLog,
  resolve,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import {
  evaluateLog,
  type LogEntry,
  type LogStep,
  type ResolveOp,
  type TableSchema,
} from "@fluxvita/saveslot-reference";
import { propRuns } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

vi.setConfig({ testTimeout: 600_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 500_000, markInterruptAsFailure: true });

// A sample is a dozen requests on a real store: about 20 s. 12 by default (the fixed samples
// among them); the nightly long batch raises it with PROP_RUNS.
const RUNS = propRuns(12);
const SEED = process.env["PROP_SEED"] === undefined ? undefined : Number(process.env["PROP_SEED"]);
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
// biome-ignore lint/suspicious/noExplicitAny: receipts read loosely in a test
type Any = any;

// The reference's timeless table (f1 required, f2) is `items` here: f1 is `label`, f2 `amount`;
// the key (origin, external_id) is the kernel's alone.
const TIMELESS: TableSchema = { kind: "timeless", required: ["f1"] };
const DOCUMENT = {
  slot: "sync",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: "items",
      kind: "base",
      description: "an item",
      time: { type: "none" },
      fields: [
        { name: "label", type: "text", required: true, description: "f1" },
        { name: "amount", type: "integer", description: "f2" },
        { name: "origin", type: "text", description: "the source system" },
        { name: "external_id", type: "text", description: "its ID there" },
      ],
      external_key: ["origin", "external_id"],
    },
  ],
};
const KEY = { origin: "band", external_id: "k-1" };
const VALUES = ["1", "2", "3"];

type Step =
  | { t: "sync"; v: string; explicit: boolean; f1: string }
  | { t: "local"; v: string; lag: number }
  | { t: "revoke" }
  | { t: "revokeBack" }
  | { t: "undo"; back: number }
  | { t: "resolve"; decision: ResolveOp["decision"]; unit: "f2" | "existence" };

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      t: fc.constant("sync" as const),
      v: fc.constantFrom(...VALUES),
      explicit: fc.boolean(),
      f1: fc.constantFrom("a", "a", "b"),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant("local" as const),
      v: fc.constantFrom(...VALUES),
      lag: fc.constantFrom(0, 0, 1),
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("revoke" as const) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("revokeBack" as const) }) },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant("undo" as const), back: fc.nat({ max: 2 }) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant("resolve" as const),
      decision: fc.constantFrom<ResolveOp["decision"]>(
        "take_candidate",
        "keep_effective",
        "take_previous",
      ),
      unit: fc.constantFrom<"f2" | "existence">("f2", "f2", "existence"),
    }),
  },
);
const scenario = fc.record({
  first: fc.constantFrom(...VALUES),
  steps: fc.array(step, { minLength: 1, maxLength: 7 }),
});

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
    now: `2026-11-05T${String(Math.floor(++minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
/** A call of the pipeline: its receipt, or the code it was refused with. */
async function call<T>(f: () => Promise<T>): Promise<{ ok: T } | { refused: string }> {
  try {
    return { ok: await f() };
  } catch (e) {
    const x = e as { code?: string };
    if (x.code === undefined) throw e;
    return { refused: x.code };
  }
}
const tail = async () => (await s.store.read(readTail))?.seq ?? 0;
const eventsSince = (after: number) =>
  s.store.read(async (tx) => {
    const end = (await readTail(tx))?.seq ?? after;
    if (end <= after) return [];
    return (await readEvents(tx, after + 1, end)).map((e) => ({
      type: e.header["type"] as string,
      blocks: Object.fromEntries(
        [...e.blocks].flatMap(([k, b]) => (b.state === "present" ? [[k, b.value]] : [])),
      ) as Record<string, Any>,
    }));
  });
const field = (value: string, source: string, explicit = false) => ({
  value,
  sources: [source],
  ...(explicit ? { explicit: true as const } : {}),
});

/**
 * The conflict items, live: open, or superseded (a write that overwrote its target: the kernel
 * closes the item, the reference models no supersession and keeps its candidates pending). Each
 * with its unit, version and number of candidates.
 */
async function liveItems(states: readonly string[] = ["open"]) {
  const ids = await s.store.read(async (tx) =>
    (
      await tx.query<{ id: string }>(
        "SELECT id FROM pending_items WHERE state = ANY($1) AND type = 'conflict' ORDER BY id",
        [states] as never,
      )
    ).rows.map((x) => x.id),
  );
  const out: {
    id: string;
    unit: string;
    item_ver: string;
    candidates: number;
    writes: number[];
  }[] = [];
  for (const id of ids) {
    const d = (await pending(s.store, ctx(), { id })) as Any;
    const names = d.target.unit as string[];
    const unit = names.includes("*") ? "existence" : names.includes("amount") ? "f2" : "f1";
    const writes = (d.candidates as Any[]).map((c) => c.seq as number);
    out.push({ id, unit, item_ver: d.item_ver, candidates: writes.length, writes });
  }
  return out;
}
/** The reference's open candidates: the writes they come from. */
function referenceCandidates(st: LogStep["state"]): number {
  return new Set(st.items.filter((x) => x.status === "candidate" && !x.closed).map((x) => x.event))
    .size;
}

/**
 * An idempotency key of its own for each ordinary request: two steps may send the same body (the
 * same row, ver and value), which the service takes for a repeat and answers with the first
 * receipt, writing nothing; the reference would judge the second as a write. Requests of ops by
 * source key only have no service request key, so a sync sent again is judged again.
 */
const once = (op: number) => `step-${op}`;

async function runScenario(first: string, steps: readonly Step[], seen: Record<string, number>) {
  await s.reset();
  await scratch.reset();
  minute = 0;
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), { document: structuredClone(DOCUMENT) });
  const log: LogEntry[] = [];
  // Each step that entered the log: the reference's op, the live operation, the row's ver after it.
  const done: { ref: number; live: number; ver: string; kind: string }[] = [];
  let row = "";
  let refOp = 0;
  const count = (k: string) => {
    seen[k] = (seen[k] ?? 0) + 1;
  };

  /** One step: the request sent, its reference entry; both kept unless the pipeline refused it. */
  async function apply(entry: LogEntry, send: () => Promise<Any>, byKey: boolean): Promise<void> {
    const before = await tail();
    const r = await call(send);
    if ("refused" in r) {
      count(`refused_${entry.kind}_${r.refused}`);
      return;
    }
    const receipt = r.ok;
    // Every step is a request of its own: a repeat would write nothing the reference judges.
    expect({ op: entry.op, replayed: receipt.replayed === true }).toEqual({
      op: entry.op,
      replayed: false,
    });
    const ref = evaluateLog(TIMELESS, [...log, entry]);
    const last = ref.steps.at(-1) as LogStep;
    if (last.refused || last.rejected !== undefined) {
      // The pipeline took what the reference refuses: a difference.
      expect({ op: entry.op, kind: entry.kind, reference: "refused" }).toEqual({
        op: entry.op,
        kind: entry.kind,
        reference: "accepted",
      });
    }
    const appended = await eventsSince(before);
    if (byKey) {
      const outcome = receipt.ops[0].outcome;
      count(`outcome_${outcome}`);
      // (2) the outcome.
      expect({ op: entry.op, outcome }).toEqual({ op: entry.op, outcome: last.outcome });
      // (1) what entered the log.
      const entered = outcome !== "unchanged" && outcome !== "skipped";
      expect({ op: entry.op, appended: appended.length > 0 }).toEqual({
        op: entry.op,
        appended: entered,
      });
      if (entered) {
        const head = appended.find((e) => e.type === "write.head")?.blocks as Any;
        expect(head["ops/0/target"]?.by_external_key).toBe(true);
        // One source: its evidence, or its `api_call` when it has none.
        const sources = appended.filter((e) => e.type === "source.recorded");
        expect(sources.length).toBe(1);
        // 09 §4.2: the head, then the sources, then the write.
        const order = appended.map((e) => e.type);
        expect(order.slice(0, 3)).toEqual(["write.head", "source.recorded", "write.base"]);
      } else {
        expect(receipt.seq).toBeUndefined();
      }
      if (outcome === "created") row = receipt.ops[0].target.row;
    }
    log.push(entry);
    if (receipt.seq !== undefined && appended.length > 0) {
      const ver = await s.store.read(async (tx) =>
        Number(
          (
            await tx.query<{ v: unknown }>(
              `SELECT max(rec_from) AS v FROM "t_t1_v1__ver" WHERE row_id = $1`,
              [row],
            )
          ).rows[0]?.v,
        ),
      );
      done.push({ ref: entry.op, live: receipt.seq, ver: `v${ver}.0`, kind: entry.kind });
    }
    // (3) the key index: the one entry, the row's.
    const keys = await s.store.read(async (tx) =>
      (await tx.query<{ h: string }>("SELECT holder_row AS h FROM external_keys")).rows.map(
        (x) => x.h,
      ),
    );
    expect(keys).toEqual([row]);
    // (4) the row as the reference has it: existence, values in effect, open items by unit.
    const fin = ref.final;
    const live = (await query(s.store, ctx(), { table: "items" })) as Any;
    const liveRow = (live.rows as Any[])[0];
    const f = (name: "f1" | "f2") => fin.fields[name as never]?.[0]?.value ?? null;
    expect({
      op: entry.op,
      exists: liveRow !== undefined,
      f1: liveRow?.values?.label ?? null,
      f2:
        liveRow?.values?.amount === undefined || liveRow?.values?.amount === null
          ? null
          : String(liveRow.values.amount),
    }).toEqual({
      op: entry.op,
      exists: fin.exists,
      f1: fin.exists ? f("f1") : null,
      f2: fin.exists ? f("f2") : null,
    });
    // Conflict items: the writes their candidates come from, each once (a write may be a
    // candidate in several units, one item each). The reference's pending candidates are the
    // live open items' and the superseded ones'.
    const candidates = new Set((await liveItems(["open", "superseded"])).flatMap((x) => x.writes))
      .size;
    expect({ op: entry.op, candidates }).toEqual({
      op: entry.op,
      candidates: referenceCandidates(fin),
    });
  }

  const sync = (v: string, explicit: boolean, f1: string) => {
    refOp += 10;
    const op = refOp;
    const entry: LogEntry = {
      kind: "write",
      op,
      event: op + 1,
      byKey: true,
      fields: { f1: field(f1, `api${op}`), f2: field(v, `api${op}`, explicit) },
    };
    return apply(
      entry,
      () =>
        write(s.store, ctx(), {
          sv: 1,
          ...(explicit ? { evidence: [{ kind: "tool_result", text: `amount ${v}` }] } : {}),
          ops: [
            {
              intent: "update",
              table: "items",
              external_key: KEY,
              set: { label: f1, amount: Number(v) },
              ...(explicit ? { evidence_by_field: { amount: [0] } } : {}),
            },
          ],
        }),
      true,
    );
  };

  await sync(first, false, "a");
  for (const st of steps) {
    if (st.t === "sync") await sync(st.v, st.explicit, st.f1);
    else if (st.t === "local") {
      const vers = done.filter((d) => d.kind !== "resolve");
      const at = vers[vers.length - 1 - st.lag] ?? vers[vers.length - 1];
      if (at === undefined) continue;
      refOp += 10;
      const op = refOp;
      await apply(
        {
          kind: "write",
          op,
          event: op + 1,
          seen: at.ref,
          fields: { f2: field(st.v, `user${op}`) },
        },
        () =>
          write(s.store, ctx(), {
            sv: 1,
            idempotency_key: once(op),
            ops: [
              { intent: "update", table: "items", row, ver: at.ver, set: { amount: Number(st.v) } },
            ],
          }),
        false,
      );
    } else if (st.t === "revoke" || st.t === "revokeBack") {
      const cur = done.at(-1);
      if (cur === undefined) continue;
      refOp += 10;
      const op = refOp;
      const before = done.length;
      await apply(
        { kind: "revoke", op, event: op + 1 },
        () =>
          write(s.store, ctx(), {
            sv: 1,
            idempotency_key: once(op),
            ops: [{ intent: "revoke", table: "items", row, ver: cur.ver }],
          }),
        false,
      );
      if (st.t === "revokeBack" && done.length > before) {
        const rv = done.at(-1) as (typeof done)[number];
        await apply(
          { kind: "undo", op: op + 5, event: op + 6, target: op },
          () =>
            write(s.store, ctx(), {
              sv: 1,
              idempotency_key: once(op + 5),
              ops: [{ table: "items", row, ver: rv.ver, revert: { undo: rv.live } }],
            }),
          false,
        );
      }
    } else if (st.t === "undo") {
      const writes = done.filter((d) => (d.kind === "write" || d.kind === "revoke") && d.ref > 10);
      const target = writes[writes.length - 1 - st.back];
      const cur = done.at(-1);
      if (target === undefined || cur === undefined) continue;
      refOp += 10;
      const op = refOp;
      await apply(
        { kind: "undo", op, event: op + 1, target: target.ref },
        () =>
          write(s.store, ctx(), {
            sv: 1,
            idempotency_key: once(op),
            ops: [{ table: "items", row, ver: cur.ver, revert: { undo: target.live } }],
          }),
        false,
      );
    } else {
      const open = evaluateLog(TIMELESS, log).final.items.filter(
        (x) =>
          x.status === "candidate" && !x.closed && (st.unit === "existence" || x.target === "f2"),
      );
      const events = [...new Set(open.map((x) => x.event))].sort((a, b) => a - b);
      const take = events.at(-1);
      const item = (await liveItems()).find((x) => x.unit === st.unit);
      if (take === undefined || item === undefined) continue;
      refOp += 10;
      const op = refOp;
      // On existence the latest candidate alone, kept only when the reference does not reject it
      // (whether its items are on existence is the reference's to say).
      const o: ResolveOp = {
        kind: "resolve",
        op,
        event: op + 1,
        decision: st.decision,
        candidates: st.unit === "existence" ? [take] : events,
        unit: st.unit,
        ...(st.decision === "take_candidate" ? { take } : {}),
      };
      const judged = evaluateLog(TIMELESS, [...log, o]).steps.at(-1);
      if (judged === undefined || judged.refused || judged.rejected !== undefined) {
        refOp -= 10;
        continue;
      }
      count(`resolve_${st.unit}_${st.decision}`);
      await apply(
        o,
        () =>
          resolve(s.store, ctx(), {
            id: item.id,
            decision: st.decision,
            item_ver: item.item_ver,
            ...(st.decision === "take_candidate" ? { candidate: item.candidates - 1 } : {}),
          }),
        false,
      );
    }
  }
  // Replayed from an empty storage: the same state.
  const r = await reconcileLog({ live: s.store, scratch: scratch.store });
  expect(r.mismatches).toEqual([]);
}

/**
 * Fixed samples, every run: the source sent again (unchanged); the row revoked and a sync
 * skipped; the revoke undone and the source changed (a candidate on existence), taken back; a
 * corroboration with evidence; a user's change and a conflict on the field, kept effective.
 */
const FIXED: [{ first: string; steps: Step[] }][] = [
  [
    {
      first: "1",
      steps: [
        { t: "sync", v: "1", explicit: false, f1: "a" },
        { t: "revoke" },
        { t: "sync", v: "2", explicit: false, f1: "a" },
        { t: "undo", back: 0 },
        { t: "sync", v: "2", explicit: false, f1: "c" },
        { t: "resolve", decision: "take_previous", unit: "existence" },
      ],
    },
  ],
  [
    {
      first: "1",
      steps: [
        { t: "sync", v: "1", explicit: true, f1: "a" },
        { t: "local", v: "3", lag: 0 },
        { t: "sync", v: "2", explicit: false, f1: "a" },
        { t: "resolve", decision: "keep_effective", unit: "f2" },
        { t: "sync", v: "2", explicit: false, f1: "a" },
      ],
    },
  ],
  // A write by key a candidate in two units (label and amount), so in two items: one write.
  [
    {
      first: "1",
      steps: [
        { t: "sync", v: "3", explicit: false, f1: "b" },
        { t: "local", v: "1", lag: 0 },
        { t: "sync", v: "1", explicit: false, f1: "b" },
        { t: "undo", back: 2 },
        { t: "sync", v: "2", explicit: false, f1: "a" },
      ],
    },
  ],
  // Two local writes with the same body (the same ver and value): the second is a write, not a
  // repeat (each request its own idempotency key); a candidate, the version it gave changed since.
  [
    {
      first: "1",
      steps: [
        { t: "local", v: "2", lag: 0 },
        { t: "local", v: "2", lag: 1 },
      ],
    },
  ],
  // A local write on a stale version makes a conflict item; a later one on the current version
  // overwrites its target and the kernel closes the item as superseded.
  [
    {
      first: "1",
      steps: [
        { t: "sync", v: "2", explicit: false, f1: "a" },
        { t: "local", v: "3", lag: 1 },
        { t: "local", v: "1", lag: 0 },
      ],
    },
  ],
];

beforeAll(async () => {
  s = await openReusable("saveslot-write-by-key-prop-");
  scratch = await openReusable("saveslot-write-by-key-prop-scratch-");
}, 120_000);
afterAll(async () => {
  await s?.close();
  await scratch?.close();
}, 120_000);

describe("writes by external key through the write path, against the reference's sync model", () => {
  it("each step: what entered the log, the outcome, the key index, the row and its items", async () => {
    const seen: Record<string, number> = {};
    // Hit: a write by key that left nothing beyond the first (the arrangement without events).
    let samples = 0;
    let hits = 0;
    await fc.assert(
      fc.asyncProperty(scenario, async ({ first, steps }) => {
        const before = (seen["outcome_unchanged"] ?? 0) + (seen["outcome_skipped"] ?? 0);
        await runScenario(first, steps, seen);
        samples++;
        if ((seen["outcome_unchanged"] ?? 0) + (seen["outcome_skipped"] ?? 0) > before) hits++;
      }),
      { numRuns: RUNS, examples: FIXED, ...(SEED !== undefined ? { seed: SEED } : {}) },
    );
    if (process.env["JUDGE_STATS"]) console.log(JSON.stringify({ ...seen, samples, hits }));
    // The minimum only guards against the generator going wrong as a whole; the cases that must
    // be reached are built in the fixed samples.
    expect({ share: hits / samples >= 0.1 ? "at least 0.1" : hits / samples }).toEqual({
      share: "at least 0.1",
    });
    for (const k of [
      "outcome_created",
      "outcome_updated",
      "outcome_unchanged",
      "outcome_pending",
      "outcome_skipped",
      "resolve_existence_take_previous",
      "resolve_f2_keep_effective",
    ])
      expect({ k, reached: (seen[k] ?? 0) > 0 }).toEqual({ k, reached: true });
  });
});
