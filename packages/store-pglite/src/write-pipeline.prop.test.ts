// The write pipeline on PGlite against judge and the record mapping (02-architecture §11; 04-write-
// and-read «判定顺序», «一次写入的事件构成»). The comparison's judged scenarios (writes, revokes,
// undos; decisions are `resolve`, a later operation) are sent to the pipeline as write requests,
// one request a step. Each request must append what the record mapping encodes of judge's
// judgement of the same op on the same log: the same events at the same seqs, the same blocks.
// Only what the pipeline adds or chooses is set aside: the request's `api_call` source and the
// head's request-level blocks, the source seqs items point at, and the identifiers of new pending
// items (matched by order of appearance).
//
// Every write and revoke carries its `ver` explicitly here (the scenario judged the same way): the
// `ver` taken from the caller's own earlier writes is a fallback of its own, with fixed cases.

import type { TenantStore } from "@fluxvita/saveslot-kernel";
import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  type NewEvent,
  readBufferOf,
  readEvents,
  readTail,
  view,
} from "@fluxvita/saveslot-kernel";
import {
  asInThisPhase,
  COMPILED_V1,
  createSlotEvents,
  type Decision,
  eventsOfSteps,
  FIRST_OP,
  judged,
  type LoggedEvent,
  resolveInTx,
  SLOT,
  scenario,
  shape,
  writeInTx,
} from "@fluxvita/saveslot-kernel/testing";
import type { Op, TableSchema } from "@fluxvita/saveslot-reference";
import { EVENT, propRuns, STATE } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openReusable, type ReusableStore, snapshot } from "./testing/reusable-store.fixture.ts";

vi.setConfig({ testTimeout: 600_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 550_000, markInterruptAsFailure: true });

const RUNS = propRuns(40);
const SEED = process.env["PROP_SEED"] === undefined ? undefined : Number(process.env["PROP_SEED"]);

const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const ROW = `r_${"6".repeat(26)}`;
const ENTITY = `e_${"7".repeat(26)}`;
const FILLER = `e_${"9".repeat(26)}`;

const fields = [
  { id: "f2", name: "b", type: "text", required: true, description: "b" },
  { id: "f3", name: "c", type: "text", description: "c" },
];
const NAME: Record<string, string> = { f2: "b", f3: "c" };
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

const filler: NewEvent = {
  type: "write.head",
  slot: SLOT,
  blocks: {
    ctx: {
      now: "2026-11-10T05:00:00.000Z",
      today: "2026-11-10",
      ruleset_version: 1,
      policy_version: 1,
      literal_checker: "literal@1",
    },
    request: { sv: 1, sv_basis: "explicit", op_count: 1 },
    "ops/0/target": { table: "t2", entity: FILLER, intent: "update" },
  },
};

let minute = 0;
const at = () => {
  minute++;
  return `2026-11-04T${String(minute % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
};

/** The scenario's ops as this test sends them: `ver` explicit, a write.base after one source. */
function asSent(o: Op, i: number): Op {
  const x = asInThisPhase(o, i);
  const event = x.op + 2;
  if (x.kind === "write" || x.kind === "revoke") {
    return i === 0 ? { ...x, event } : { ...x, event, seen: x.seen ?? x.op - 1 };
  }
  return { ...x, event };
}

/** The write request of a scenario op. */
function requestOf(o: Op, i: number, isState: boolean): unknown {
  const table = isState ? "entities" : "rows";
  const target = i === 0 ? {} : isState ? { entity: ENTITY } : { row: ROW };
  const ver = "seen" in o && o.seen !== undefined && i > 0 ? { ver: `v${o.seen}.0` } : {};
  const ack =
    "acknowledge" in o && o.acknowledge !== undefined ? { acknowledge: ["overwrite"] } : {};
  const valid: Record<string, string> = {};
  let correct = false;
  if ((o.kind === "write" || o.kind === "revoke") && o.valid !== undefined) {
    if (o.valid === "corrected_span") correct = true;
    else {
      if (o.valid.from.mode === "given") valid["valid_from"] = o.valid.from.value;
      if (o.valid.to.mode === "given") valid["valid_to"] = o.valid.to.value;
      else valid["valid_to"] = o.valid.to.mode;
    }
  }
  if (o.kind === "undo") {
    return {
      sv: 1,
      ops: [
        {
          table,
          ...target,
          ...ver,
          ...ack,
          revert: { undo: o.target, include_later: o.includeLater === true },
        },
      ],
    };
  }
  if (o.kind === "revoke") {
    return { sv: 1, ops: [{ intent: "revoke", table, ...target, ...ver, ...valid }] };
  }
  if (o.kind !== "write") throw new Error(`not sent: ${o.kind}`);
  const set = Object.fromEntries(
    Object.entries(o.fields)
      .filter(([f, x]) => x !== undefined && !o.noop?.includes(f as never))
      .map(([f, x]) => [NAME[f] as string, x?.value ?? null]),
  );
  return {
    sv: 1,
    ops: [
      {
        intent: i === 0 ? "insert" : correct ? "correct" : "update",
        table,
        ...target,
        ...ver,
        ...ack,
        ...valid,
        set,
      },
    ],
  };
}

/**
 * An event as compared: the pipeline's own choices set aside (intent, source seqs, request-level
 * head blocks), item IDs replaced by their order of appearance.
 */
/** The events an operation appended from `head` on, but sources, refreshes and supersessions. */
async function logged(store: TenantStore, head: number) {
  return store.read(async (tx) => {
    const last = (await readTail(tx))?.seq ?? 0;
    return (
      (await readEvents(tx, head, last))
        // Sources are the pipeline's; refreshes and supersessions are checked separately.
        .filter(
          (e) =>
            !["source.recorded", "item.refreshed", "item.superseded"].includes(
              e.header["type"] as string,
            ),
        )
        .map(
          (e): LoggedEvent => ({
            type: e.header["type"] as string,
            seq: Number(e.header["seq"]),
            blocks: Object.fromEntries(
              [...e.blocks].flatMap(([p, b]) => (b.state === "present" ? [[p, b.value]] : [])),
            ),
          }),
        )
    );
  });
}

/** The label `comparable` gives an item ID, giving it one when it has none yet. */
function comparableItem(id: string, items: Map<string, string>): string {
  if (!items.has(id)) items.set(id, `item${items.size}`);
  return items.get(id) as string;
}

/**
 * A decision's events as the record mapping gives them, with the value sources the pipeline gives
 * the triggered write's own items: its `api_call` source (the record mapping encodes none).
 */
function resolutionWithSource(e: LoggedEvent): LoggedEvent {
  if (e.type !== "write.base") return e;
  const blocks = Object.fromEntries(
    Object.entries(e.blocks).map(([p, v]) =>
      p.startsWith("sources/") && Array.isArray(v) && v.length === 0
        ? [p, [{ kind: "value", source: 0 }]]
        : [p, v],
    ),
  );
  return { ...e, blocks };
}

function comparable(e: LoggedEvent, items: Map<string, string>): unknown {
  const text = JSON.stringify(e.blocks, (k, v) => {
    if (k === "intent") return undefined;
    if (k === "source" && typeof v === "number") return "S";
    if (typeof v === "string" && /^pi_[0-9A-Z]{16}$/.test(v)) {
      if (!items.has(v)) items.set(v, `item${items.size}`);
      return items.get(v);
    }
    return v;
  });
  const blocks = JSON.parse(text) as Record<string, unknown>;
  if (e.type === "write.head") {
    for (const k of ["ctx", "request", "task", "request_key", "idempotency"]) delete blocks[k];
  }
  // A decision's request-level blocks are the pipeline's; its item version is checked apart (the
  // record mapping does not know of refreshes).
  if (e.type === "item.resolved") {
    for (const k of ["ctx", "task", "request_key", "idempotency", "op_sources", "confirmation"]) {
      delete blocks[k];
    }
    delete (blocks["target"] as Record<string, unknown>)["item_op"];
  }
  // The items' entries are checked against the reference in the property below.
  for (const k of Object.keys(blocks)) {
    if (/^(scope_valid|current\/|previous\/|proposed\/|impact\/)/.test(k)) delete blocks[k];
  }
  return { type: e.type, seq: e.seq, blocks };
}

/**
 * What a row's version is about: its view without the stretches of a field no contribution gives
 * (value null, no `by`). The view lists such a stretch once the field has any item, a candidate
 * included, while the row itself, and its version table, did not change.
 */
function asVersion(state: Parameters<typeof view>[0]): string {
  const v = view(state);
  const fields = Object.fromEntries(
    Object.entries(v.fields).flatMap(([f, xs]) => {
      const given = (xs ?? []).filter((x) => x.value !== null || x.by !== undefined);
      return given.length > 0 ? [[f, given]] : [];
    }),
  );
  return JSON.stringify({ ...v, fields });
}

const both = [
  ["state", STATE, true],
  ["event", EVENT, false],
] as const;

/** What the random samples reached, over both tables (the last test checks it). */
const atRandom = { decisions: 0 };

/**
 * A scenario for each decision, numbered as the pipeline appends (an op's event after its source):
 * a conflict item on f2 (#32 seeing #10, after #22), kept, taken or taken back to its merge base;
 * an undo taking a later write back (#42 undoing #22, after #32), awaiting confirmation, confirmed
 * or rejected. Each decision at op + 5 of the op before it, after that op's item events.
 */
function fixed(isState: boolean): [string, Op[]][] {
  const valid = isState
    ? { valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } } }
    : {};
  const write = (op: number, value: string, seen?: number): Op =>
    ({
      kind: "write",
      op,
      event: op + 2,
      ...(seen !== undefined ? { seen } : {}),
      ...valid,
      fields: { f2: { value, sources: [`S${op}`] } },
    }) as Op;
  const conflict = [write(10, "1"), write(20, "2", 10), write(30, "3", 10)];
  const resolve = (decision: string, extra: object = {}): Op =>
    ({
      kind: "resolve",
      op: 35,
      event: 37,
      decision,
      candidates: [32],
      unit: "f2",
      ...extra,
    }) as Op;
  const awaiting = [
    write(10, "1"),
    write(20, "2", 10),
    write(30, "3", 20),
    { kind: "undo", op: 40, event: 42, target: 20, seen: 30, includeLater: true } as Op,
  ];
  return [
    ["keep_effective", [...conflict, resolve("keep_effective")]],
    ["take_candidate", [...conflict, resolve("take_candidate", { take: 32 })]],
    ["take_previous", [...conflict, resolve("take_previous")]],
    ["confirm", [...awaiting, { kind: "confirm", op: 45, event: 47, target: 42 } as Op]],
    ["reject", [...awaiting, { kind: "reject", op: 45, event: 47, target: 42 } as Op]],
  ];
}

describe.each(both)("%s table", (_, schema: TableSchema, isState) => {
  let main: ReusableStore;
  beforeAll(async () => {
    main = await openReusable("saveslot-write-pipeline-");
  }, 120_000);
  afterAll(async () => {
    await main?.close();
  }, 120_000);

  const seen = { samples: 0, skipped: 0, steps: 0, pending: 0, decisions: 0, overrun: 0 };
  const byKind: Record<string, number> = {};

  /** One judged scenario through the pipeline, every check below; counts decisions in `byKind`. */
  const checkSample = async (all: readonly Op[], generated: readonly Decision[]) => {
    // The scenario's decisions on items, inserted as the pipeline numbers them: a decision that
    // writes has its `api_call` source before its write. (Its undos and revokes are writes,
    // which the skeleton covers.)
    const decisions = generated.filter((d) =>
      ["keep", "take", "previous", "confirm", "reject"].includes(d.kind),
    );
    // One a step, at op + 5: after the step's own events (head, source, base, items at op + 3
    // on), with room for the refreshes it may append before the next step at op + 10.
    const numbering = { slots: [5], eventAfter: 2 };
    // Decisions go through `resolve`, the rest through `write`.
    const raw = all;
    if (raw.length < 2) {
      seen.skipped++;
      return;
    }
    // The record mapping's fixture encodes the first write as an insert only at its operation.
    if (raw[0]?.op !== FIRST_OP) {
      seen.skipped++;
      return;
    }
    const sent = raw.map(asSent);
    // A write of only no-op fields has nothing to send (its fields are left out of the input).
    if (
      sent.some(
        (o) =>
          o.kind === "write" &&
          Object.entries(o.fields).every(
            ([f, x]) => x === undefined || o.noop?.includes(f as never),
          ),
      )
    ) {
      seen.skipped++;
      return;
    }
    // A `ver` names a version of the row (04-contract `ver`): an operation after which the
    // row changed. Each `ver` becomes the latest version at or before it: the row is the same
    // there, so the scenario judges the same. None before the row was made: skipped.
    const first = judged(schema, sent, decisions, numbering);
    const versions = first.steps
      .filter((x, k) => {
        const before = k === 0 ? undefined : asVersion((first.steps[k - 1] as typeof x).state);
        return asVersion(x.state) !== before;
      })
      .map((x) => x.op.op);
    const toVersion = (s: number) => versions.filter((v) => v <= s).at(-1);
    if (
      sent.some(
        (o, i) => i > 0 && "seen" in o && o.seen !== undefined && toVersion(o.seen) === undefined,
      )
    ) {
      seen.skipped++;
      return;
    }
    const ops = sent.map((o, i) =>
      i > 0 && "seen" in o && o.seen !== undefined ? ({ ...o, seen: toVersion(o.seen) } as Op) : o,
    );
    const { steps } = judged(schema, ops, decisions, numbering);
    const ctx = {
      table: (isState ? "t2" : "t1") as never,
      target: isState ? { entity: ENTITY as never } : { row: ROW as never },
      shape: shape(schema),
      granularity: "date" as const,
    };
    const expected = eventsOfSteps(ctx, steps, (after, n) => after + 1 + n);
    await main.reset();
    const store = main.store;
    expect(await store.read(snapshot)).toEqual(main.blank);
    const run = (events: NewEvent[]) =>
      store.write(async (tx) => {
        const op = await appendOperation(tx, {
          actor: USER as never,
          now: at() as never,
          events,
        });
        await applyEvents(tx, eventsOf(op));
      });
    await createTenant(
      store,
      createOpsContext({
        tenant: TENANT,
        actor: USER,
        trigger: null,
        task: null,
        visibility: { kind: "all" },
        idempotency_key_window: 86_400_000,
        idempotency_window: 600_000,
        now: "2026-11-04T00:00:00.000Z",
        confirmation: null,
      }),
    );
    await run(createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }));
    seen.samples++;
    let items = 0;
    const realItems = new Map<string, string>();
    const expectedItems = new Map<string, string>();
    for (const [k, step] of steps.entries()) {
      // Steps refused by judge are not in `steps`: each step carries its own op.
      const o = step.op;
      const want = expected[k] as LoggedEvent[];
      const head = want[0]?.seq as number;
      // The step's numbers were taken by the step before (its refreshes and supersessions, which
      // the record mapping does not number, ran into them): the scenario's numbering cannot hold
      // this sample from here on. The steps compared so far stand; the rest is skipped.
      const start = (await store.read(readTail))?.seq ?? 0;
      if (start >= head) {
        seen.overrun++;
        return;
      }
      for (let tail = start; tail < head - 1; tail++) {
        await run([filler]);
      }
      const now = "now" in step.input ? (step.input.now as string) : "2026-11-05";
      const newId = (kind: "row" | "entity" | "source" | "item" | "partition") =>
        kind === "row"
          ? ROW
          : kind === "entity"
            ? ENTITY
            : kind === "item"
              ? `pi_${String(++items).padStart(16, "0")}`
              : `s_${String(head).padStart(16, "0")}`;
      if (o.kind === "resolve" || o.kind === "confirm" || o.kind === "reject") {
        // The item the record mapping resolves, as the pipeline named it; its current version.
        const t = want[0]?.blocks["target"] as { item: string; candidate?: number };
        const label = expectedItems.get(t.item) ?? comparableItem(t.item, expectedItems);
        const id = [...realItems].find(([, l]) => l === label)?.[0] as string;
        const version = await store.read(async (tx) =>
          Number(
            (
              await tx.query<{ v: unknown }>(
                "SELECT version_op AS v FROM pending_items WHERE id = $1",
                [id],
              )
            ).rows[0]?.v,
          ),
        );
        const r = await store.write((tx) =>
          resolveInTx(tx, {
            actor: USER as never,
            task: `step-${k}`,
            now: `${now}T04:00:00.000Z`,
            windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
            visibility: { kind: "all" },
            params: {
              id,
              decision: o.kind === "resolve" ? o.decision : o.kind,
              item_ver: `iv_${id.slice(3)}.${version}.0`,
              ...(t.candidate !== undefined ? { candidate: t.candidate } : {}),
            },
            reads: readBufferOf(store),
            newId,
          }),
        );
        const gotEvents = await logged(store, head);
        expect({
          step: k,
          events: gotEvents.map((e) => comparable(e, realItems)),
          item_op: (gotEvents[0]?.blocks["target"] as { item_op?: number } | undefined)?.item_op,
        }).toEqual({
          step: k,
          events: want.map((e) => comparable(resolutionWithSource(e), expectedItems)),
          item_op: version,
        });
        expect(r.status).toBe("resolved");
        seen.decisions++;
        const kind = o.kind === "resolve" ? o.decision : o.kind;
        byKind[kind] = (byKind[kind] ?? 0) + 1;
        seen.steps++;
        continue;
      }
      const receipt = await store.write((tx) =>
        writeInTx(tx, {
          actor: USER as never,
          // A task of its own per step: the scenarios repeat requests word for word, which
          // within the window would be resends.
          task: `step-${k}`,
          now: `${now}T04:00:00.000Z`,
          windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
          visibility: { kind: "all" },
          params: requestOf(o, o.op === FIRST_OP ? 0 : 1, isState),
          reads: readBufferOf(store),
          newId,
        }),
      );
      const got = await logged(store, head);
      expect({ step: k, events: got.map((e) => comparable(e, realItems)) }).toEqual({
        step: k,
        events: want.map((e) => comparable(e, expectedItems)),
      });
      // The receipt: pending exactly when some part is a candidate or awaiting.
      const r = step.judgement.record;
      const pending =
        "items" in r && r.items.some((x) => x.status === "candidate" || x.status === "awaiting");
      expect({ step: k, status: receipt.status }).toEqual({
        step: k,
        status: pending ? "pending" : "saved",
      });
      if (pending) seen.pending++;
      seen.steps++;
    }
  };

  it("each judged step sent as a write request appends what the record mapping encodes", async () => {
    await fc.assert(
      fc.asyncProperty(scenario(isState), ({ ops, decisions }) => checkSample(ops, decisions)),
      {
        numRuns: RUNS,
        ...(SEED !== undefined ? { seed: SEED } : {}),
        ...(process.env["PROP_PATH"] ? { path: process.env["PROP_PATH"], endOnFailure: true } : {}),
      },
    );
    if (process.env["JUDGE_STATS"]) console.log(schema.kind, JSON.stringify({ ...seen, byKind }));
    expect(seen.samples).toBeGreaterThan(RUNS / 3);
    // Overruns cut samples short: they must stay rare. Five rounds of 40 a table gave one in 200
    // (a mean of 0.2 a run); more than a tenth of the runs has odds of about 3e-6.
    expect(seen.overrun).toBeLessThanOrEqual(RUNS / 10);
    expect(seen.pending).toBeGreaterThan(0);
    atRandom.decisions += seen.decisions;
  });

  it("each decision through resolve: one fixed scenario each", async () => {
    for (const [kind, ops] of fixed(isState)) {
      const before = byKind[kind] ?? 0;
      await checkSample(ops, []);
      expect({ kind, resolved: (byKind[kind] ?? 0) > before }).toEqual({ kind, resolved: true });
    }
  });
});

it("over both tables, the random samples send decisions through resolve", () => {
  // Guards against a generator gone degenerate only; each decision is the fixed scenarios'. At 40
  // samples a table, 5 rounds gave 9 to 18 decisions over both tables (state 3 to 9, event 6 to
  // 12): at the least of them, the odds of none in a run are e^-9, about 1e-4.
  expect(atRandom.decisions).toBeGreaterThan(0);
});
