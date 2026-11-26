// The write pipeline on PGlite against judge and the record mapping (02-architecture §11;
// 04-write-and-read «判定顺序», «一次写入的事件构成»). The comparison's judged scenarios (writes, revokes,
// undos; decisions are `resolve`, a later operation) are sent to the pipeline as write requests,
// one request a step. Each request must append what the record mapping encodes of judge's
// judgement of the same op on the same log: the same events at the same seqs, the same blocks.
// Only what the pipeline adds or chooses is set aside: the request's `api_call` source and the
// head's request-level blocks, the source seqs items point at, and the identifiers of new pending
// items (matched by order of appearance).
//
// Every write and revoke carries its `ver` explicitly here (the scenario judged the same way): the
// `ver` taken from the caller's own earlier writes is a fallback of its own, with fixed cases.
//
// What is checked here is the pipeline: how a request maps to a judged op, the events it appends,
// the versions it gives. The judgement is its given input (`judgeOp`, compared with the reference
// evaluator in the kernel's reference.prop.test.ts), and so is "which steps give a new version"
// (testing/version.fixture.ts): it comes from the same judged state, not from a second source.
// The reference evaluator gives states, not items and their sources, so the steps where what is
// shown stays the same but where it comes from changes have no check independent of judge; fixed
// cases in write-pipeline.test.ts cover them on the store.

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
} from "@fluxvita/saveslot-kernel";
import {
  asWritten,
  COMPILED_V1,
  checkLiteral,
  createSlotEvents,
  type Decision,
  eventsOfSteps,
  FIRST_OP,
  indexEvidence,
  type Judged,
  judged,
  judgeOp,
  type LoggedEvent,
  resolveInTx,
  SLOT,
  scenario,
  shape,
  writeInTx,
} from "@fluxvita/saveslot-kernel/testing";
import type { Op, TableSchema } from "@fluxvita/saveslot-reference";
import {
  EVENT,
  propRuns,
  SOURCES,
  STATE,
  type Step,
  step,
  toOps,
} from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openReusable, type ReusableStore, snapshot } from "./testing/reusable-store.fixture.ts";
import { seenAsVersions } from "./testing/version.fixture.ts";

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

/**
 * The scenario's ops as this test sends them: `ver` explicit, a write.base after its sources (three
 * segments for an op with explicit fields, else its api_call).
 */
function asSent(o: Op, i: number): Op {
  const x = asWritten(o, i);
  const explicit = x.kind === "write" && Object.values(x.fields).some((f) => f?.explicit === true);
  const event = x.op + 1 + (explicit ? 3 : 1);
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
  // Explicit fields: three segments of evidence, each explicit field mapped to a subset of them
  // (evidence_by_field); the op's other fields rest on all three. No explicit field: the op's
  // api_call.
  const explicit = Object.entries(o.fields)
    .filter(([, x]) => x?.explicit === true)
    .map(([f]) => f);
  const pointed =
    explicit.length > 0
      ? {
          evidence_by_field: Object.fromEntries(
            explicit.map((f) => [NAME[f] as string, mappedOf(o.op, f)]),
          ),
        }
      : {};
  return {
    sv: 1,
    ...(explicit.length > 0
      ? { evidence: [0, 1, 2].map((k) => ({ kind: "agent_note", text: segmentText(o.op, k) })) }
      : {}),
    ops: [
      {
        intent: i === 0 ? "insert" : correct ? "correct" : "update",
        table,
        ...target,
        ...ver,
        ...ack,
        ...valid,
        set,
        ...pointed,
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

/** The text of an op's `k`th segment, as this test sends it. */
const segmentText = (op: number, k: number) => `op ${op} #${k}`;

/**
 * The record mapping's events with the literal checks the pipeline adds (09 §5.7
 * `literal/<field>/<k>`): a block for each value item whose sources are source data, a segment a
 * source in their order, the head's raw value checked against that segment's text: an op's `k`th
 * segment follows the head at `head + 1 + k`; an op sending none has its api_call there (nothing
 * to check). The checker itself is pinned in kernel's literal tests.
 */
function withLiteral(events: readonly LoggedEvent[], o: Op, head: number): LoggedEvent[] {
  const sends = o.kind === "write" && Object.values(o.fields).some((x) => x?.explicit === true);
  const at = (seq: number) =>
    sends ? indexEvidence(segmentText(o.op, seq - head - 1)) : undefined;
  const raw = events.find((e) => e.type === "write.head")?.blocks ?? {};
  return events.map((e) => {
    if (e.type !== "write.base") return e;
    const blocks: Record<string, unknown> = { ...e.blocks };
    for (const [p, v] of Object.entries(e.blocks)) {
      const m = /^sources\/(f[0-9]+)\/([0-9]+)$/.exec(p);
      if (m === null || !Array.isArray(v)) continue;
      const sources = (v as { source?: number }[]).filter((x) => x.source !== undefined);
      if (sources.length === 0) continue;
      blocks[`literal/${m[1]}/${m[2]}`] = {
        segments: sources.map((x) => ({
          source: x.source,
          result: checkLiteral(
            { type: "text" },
            raw[`ops/0/set/${m[1]}`] ?? null,
            at(x.source as number),
          ),
        })),
      };
    }
    return { ...e, blocks };
  });
}

/** The segments of the three an explicit field is mapped to: a non-empty subset, by op and field. */
function mappedOf(op: number, field: string): number[] {
  const mask = ((op * 5 + Number(field.slice(1)) * 3) % 7) + 1;
  return [0, 1, 2].filter((k) => (mask >> k) & 1);
}

/**
 * The record mapping's sources for what this test sends, as source seqs: a field mapped, its
 * segments; any other value item of an op sending segments, all three; an op's api_call, its one.
 * Segments and the api_call follow the head (09 §4.2).
 */
function withSources(events: readonly LoggedEvent[], o: Op, head: number): LoggedEvent[] {
  const explicit =
    o.kind === "write"
      ? Object.entries(o.fields)
          .filter(([, x]) => x?.explicit === true)
          .map(([f]) => f)
      : [];
  return events.map((e) => {
    if (e.type !== "write.base") return e;
    const blocks: Record<string, unknown> = { ...e.blocks };
    for (const [path, v] of Object.entries(e.blocks)) {
      const m = /^sources\/(f[0-9]+)\/[0-9]+$/.exec(path);
      if (m === null || !Array.isArray(v)) continue;
      if (!(v as { source?: number }[]).every((x) => x.source !== undefined)) continue;
      const segs =
        explicit.length === 0
          ? [0]
          : explicit.includes(m[1] as string)
            ? mappedOf(o.op, m[1] as string)
            : [0, 1, 2];
      blocks[path] = segs.map((k) => ({ kind: "value", source: head + 1 + k }));
    }
    // The interval's sources (`valid_sources`, 09 §5.7): `valid` is never mapped here, so all the
    // op's evidence: its three segments, or its api_call.
    if (Array.isArray(e.blocks["valid_sources"])) {
      blocks["valid_sources"] = (explicit.length === 0 ? [0] : [0, 1, 2]).map((k) => head + 1 + k);
    }
    return { ...e, blocks };
  });
}

function comparable(e: LoggedEvent, items: Map<string, string>, head?: number): unknown {
  const text = JSON.stringify(e.blocks, (k, v) => {
    if (k === "intent") return undefined;
    // A value source by where its segment stands in the request (S0 first after the head).
    if (k === "source" && typeof v === "number")
      return head === undefined ? "S" : `S${v - head - 1}`;
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
  // An undo's operation sources are source seqs, the pipeline's like the others: only that there
  // are some is compared.
  if (e.type === "write.base" && Array.isArray(blocks["op_sources"])) {
    blocks["op_sources"] = (blocks["op_sources"] as unknown[]).map(() => "S");
  }
  // The interval's sources likewise (a write's or a revoke's given an interval).
  if (e.type === "write.base" && Array.isArray(blocks["valid_sources"])) {
    blocks["valid_sources"] = (blocks["valid_sources"] as unknown[]).map(() => "S");
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

const both = [
  ["state", STATE, true],
  ["event", EVENT, false],
] as const;

/** What the random samples reached, over both tables (the last test checks it). */
/** A confirm or reject as judged here: the awaiting write it decides on. */
interface DecisionInput {
  readonly op: number;
  readonly event: number;
  readonly ruleset: number;
  readonly target: number;
}

/**
 * Whether an awaiting undo has nothing left to do on `state` (09 §5.8: no part to write back, and
 * no write to hide or take back), with what its confirmation would skip; undefined while it has
 * something, or for a proposal that is no undo. Judged as the spec says: a confirmation now, and
 * the same undo judged again now.
 */
function nothingLeft(
  state: Judged["before"],
  d: DecisionInput,
): { readonly skipped: readonly { readonly byOp: number }[] } | undefined {
  const opened = state.records.find((r) => r.event === d.target);
  if (opened?.kind !== "undo" || opened.revert.before === undefined) return undefined;
  const base = { op: d.op, index: 0, event: d.event, ruleset: d.ruleset };
  // A judgement judge refuses: a refused confirmation has not nothing to do; an undo refused now
  // has nothing it would hide or take back.
  const tryJudge = (input: unknown) => {
    try {
      return judgeOp(state, input as never).judgement;
    } catch (e) {
      if ((e as Error).name !== "JudgeError") throw e;
      return undefined;
    }
  };
  const confirm = tryJudge({ ...base, kind: "confirm", target: d.target })?.record;
  if (confirm?.kind !== "confirm" || confirm.revert === undefined) return undefined;
  if (confirm.items.length > 0) return undefined;
  const again = tryJudge({
    ...base,
    kind: "undo",
    seen: d.op - 1,
    seenExplicit: true,
    target: opened.revert.before,
    ...(opened.includeLater ? { includeLater: true } : {}),
  });
  if (again !== undefined && (again.takesBack.length > 0 || again.hides.length > 0)) {
    return undefined;
  }
  return { skipped: confirm.revert.skipped };
}

const atRandom = { decisions: 0, corroborations: 0 };

/**
 * An explicit restatement of the latest write's value, seeing the version just before: a
 * corroboration wherever that value is still the one in effect.
 */
const restated: fc.Arbitrary<Step> = fc.record({
  t: fc.constant("resend" as const),
  back: fc.constant(0),
  src: fc.constantFrom(...SOURCES),
  explicit: fc.constant(true),
  mark: fc.constant(false),
  to: fc.constant("same" as const),
});

/**
 * Random steps with one explicit restatement among them. The scenarios meet a corroboration only
 * when an explicit field happens to carry the value in effect (`explicit` a coin, the value one of
 * three); a quarter of the samples are these.
 */
const samples = (state: boolean) =>
  fc.oneof(
    { weight: 3, arbitrary: scenario(state) },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.array(step, { minLength: 1, maxLength: 7 }), restated, fc.nat())
        .map(([steps, extra, at]) => {
          const out = [...steps];
          out.splice(1 + (at % out.length), 0, extra);
          return { ops: toOps(out, state), decisions: [] as Decision[] };
        }),
    },
  );

/**
 * A sample run first in every run: a creation, then the same value restated explicitly with the
 * version before; a corroboration, met whatever the generator does.
 */
const restatedOnce = (state: boolean) => ({
  ops: toOps(
    [
      {
        t: "write",
        f: "f2",
        v: "1",
        src: ["S1"],
        from: 0,
        to: "open",
        lag: 0,
        explicit: false,
        ack: true,
      },
      { t: "resend", back: 0, src: "S2", explicit: true, mark: false, to: "same" },
    ],
    state,
  ),
  decisions: [] as Decision[],
});

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

/**
 * The scenarios' operations spread out: SPREAD times the room between steps, and between a step and
 * the decision inserted after it. The scenarios number a step every 10 and a decision at op + 5,
 * while a step appends up to five events past its operation (its head, source and base, then
 * items, refreshes and supersessions, which the record mapping does not number): a decision at
 * op + 5 found its numbers taken, and the sample was cut short there (an overrun). At 2, over
 * seeds 1 to 20 on both tables (5,025 steps), a step's events reached at most op + 5, against a
 * decision at op + 10 and the next step at op + 20.
 *
 * Each operation moves by its step and its offset in the step; an event moves with its operation
 * (the same distance after it); `seen` and an undo's target are operations, a decision's
 * candidates, taken candidate and confirmed write are events. The first write stays at FIRST_OP.
 */
const SPREAD = 2;
const spreadOp = (n: number) =>
  n < FIRST_OP ? n : FIRST_OP + (Math.floor(n / 10) - 1) * 10 * SPREAD + (n % 10) * SPREAD;
function spread(ops: readonly Op[]): Op[] {
  const events = new Map(ops.map((o) => [o.event, spreadOp(o.op) + (o.event - o.op)]));
  const ev = (e: number) => {
    const m = events.get(e);
    if (m === undefined) throw new Error(`event ${e} is no op's`);
    return m;
  };
  return ops.map((o): Op => {
    const at = { op: spreadOp(o.op), event: ev(o.event) };
    switch (o.kind) {
      case "write":
      case "revoke":
        return { ...o, ...at, ...(o.seen !== undefined ? { seen: spreadOp(o.seen) } : {}) };
      case "undo":
        return {
          ...o,
          ...at,
          target: spreadOp(o.target),
          ...(o.seen !== undefined ? { seen: spreadOp(o.seen) } : {}),
        };
      case "resolve":
        return {
          ...o,
          ...at,
          candidates: o.candidates.map(ev),
          ...(o.take !== undefined ? { take: ev(o.take) } : {}),
        };
      default:
        // confirm, reject
        return { ...o, ...at, target: ev(o.target) };
    }
  });
}

// One store for the samples, for the whole file: the tables' groups run one after another, and each
// sample empties it before using it (opening PGlite builds a database, seconds; emptying one takes
// milliseconds).
let main: ReusableStore;
beforeAll(async () => {
  main = await openReusable("saveslot-write-pipeline-");
}, 120_000);
afterAll(async () => {
  await main?.close();
}, 120_000);

describe.each(both)("%s table", (_, schema: TableSchema, isState) => {
  const seen = {
    samples: 0,
    skipped: 0,
    steps: 0,
    pending: 0,
    decisions: 0,
    overrun: 0,
    closed: 0,
    // Steps judged a corroboration, of the random samples; and of the fixed one (restatedOnce),
    // which makes one every run.
    corroborations: 0,
    corroborationsFixed: 0,
  };
  const byKind: Record<string, number> = {};

  /** One judged scenario through the pipeline, every check below; counts decisions in `byKind`. */
  const checkSample = async (all: readonly Op[], generated: readonly Decision[]) => {
    // The scenario's decisions on items, inserted as the pipeline numbers them: a decision that
    // writes has its `api_call` source before its write. (Its undos and revokes are writes,
    // which the skeleton covers.)
    const decisions = generated.filter((d) =>
      ["keep", "take", "previous", "confirm", "reject"].includes(d.kind),
    );
    // One a step, at op + 5 * SPREAD: after the step's own events (head, source, base, items at
    // op + 3 on), with room for the refreshes it may append before the next step.
    const numbering = { slots: [5 * SPREAD], eventAfter: 2 };
    // Decisions go through `resolve`, the rest through `write`.
    const raw = spread(all);
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
    // Each `ver` the latest version of the row at or before the op it names (version.fixture.ts).
    const ops = seenAsVersions(sent, (x) => judged(schema, x, decisions, numbering).steps);
    if (ops === undefined) {
      seen.skipped++;
      return;
    }
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
    let sources = 0;
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
              : `s_${String(head * 10 + ++sources).padStart(16, "0")}`;
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
        // A confirmation judge finds nothing to write back for (every entry covered by later
        // writes, `skipped`): the pipeline closed the item as nothing_to_revert in the transaction
        // of the write that left it so (04-write-and-read «撤回某次写入（undo）»), which the record
        // mapping does not model. The confirmation is refused as item_closed, closed by the op that
        // covers the entries; the step appends nothing. Any other refusal still fails.
        // Whether the item is still open is the spec's test, judged on the state before the step,
        // the same for a confirm and a reject (09 §5.8 `item.refreshed`): an awaiting undo with
        // nothing left to write back, and nothing to hide or take back, was closed as
        // nothing_to_revert by the write that left it so. A reject's own record says nothing of
        // it, so both ask what a confirmation and the undo would do now.
        const left =
          o.kind === "confirm" || o.kind === "reject"
            ? nothingLeft(step.before, step.input as unknown as DecisionInput)
            : undefined;
        if (left !== undefined) {
          const params = { id, decision: o.kind, item_ver: `iv_${id.slice(3)}.${version}.0` };
          const refused = await store
            .write((tx) =>
              resolveInTx(tx, {
                actor: USER as never,
                task: `step-${k}`,
                now: `${now}T04:00:00.000Z`,
                windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
                visibility: { kind: "all" },
                params,
                reads: readBufferOf(store),
                newId,
              }),
            )
            .then(
              () => undefined,
              (e: unknown) => e as { code?: string; detail?: Record<string, unknown> },
            );
          const by = refused?.detail?.["superseded"] as
            | { reason?: string; by?: number }
            | undefined;
          expect({
            step: k,
            code: refused?.code,
            reason: by?.reason,
            byCoveringOp: left.skipped.some((x) => x.byOp === by?.by),
          }).toEqual({
            step: k,
            code: "item_closed",
            reason: "nothing_to_revert",
            byCoveringOp: true,
          });
          expect({ step: k, events: await logged(store, head) }).toEqual({ step: k, events: [] });
          seen.closed++;
          seen.steps++;
          continue;
        }
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
      expect({ step: k, events: got.map((e) => comparable(e, realItems, head)) }).toEqual({
        step: k,
        events: withLiteral(withSources(want, o, head), o, head).map((e) =>
          comparable(e, expectedItems, head),
        ),
      });
      // multi_segment_unmapped: an op sending three segments warns of its fields with items that
      // are not mapped, in the table's order.
      if (o.kind === "write") {
        const rec = step.judgement.record;
        const mapped = Object.entries(o.fields)
          .filter(([, x]) => x?.explicit === true)
          .map(([f]) => f);
        const withItems = new Set("items" in rec ? rec.items.map((x) => x.target as string) : []);
        const unmapped = Object.keys(NAME).filter((f) => withItems.has(f) && !mapped.includes(f));
        const got = (
          (receipt as unknown as { warnings?: { code: string }[] }).warnings ?? []
        ).filter((w) => w.code === "multi_segment_unmapped");
        expect({ step: k, warned: got }).toEqual({
          step: k,
          warned:
            mapped.length > 0 && unmapped.length > 0
              ? [{ code: "multi_segment_unmapped", op: 0, fields: unmapped.map((f) => NAME[f]) }]
              : [],
        });
      }
      // The receipt: pending exactly when some part is a candidate or awaiting.
      const r = step.judgement.record;
      const pending =
        "items" in r && r.items.some((x) => x.status === "candidate" || x.status === "awaiting");
      expect({ step: k, status: receipt.status }).toEqual({
        step: k,
        status: pending ? "pending" : "saved",
      });
      if (pending) seen.pending++;
      // A corroboration sent through the pipeline (`evidence_by_field`) and appended as encoded.
      if ("items" in r && r.items.some((x) => x.status === "corroborated")) seen.corroborations++;
      seen.steps++;
    }
  };

  it("each judged step sent as a write request appends what the record mapping encodes", async () => {
    await fc.assert(
      fc.asyncProperty(
        samples(isState).map((x) => ({ ...x, fixed: false })),
        async ({ ops, decisions, fixed }) => {
          const before = seen.corroborations;
          await checkSample(ops, decisions);
          if (fixed) {
            seen.corroborationsFixed += seen.corroborations - before;
            seen.corroborations = before;
          }
        },
      ),
      {
        numRuns: RUNS,
        examples: [[{ ...restatedOnce(isState), fixed: true }]],
        ...(SEED !== undefined ? { seed: SEED } : {}),
        ...(process.env["PROP_PATH"] ? { path: process.env["PROP_PATH"], endOnFailure: true } : {}),
      },
    );
    if (process.env["JUDGE_STATS"]) console.log(schema.kind, JSON.stringify({ ...seen, byKind }));
    expect(seen.samples).toBeGreaterThan(RUNS / 3);
    // Overruns cut samples short: they must stay rare. With the operations spread out (SPREAD),
    // seeds 1 to 20 gave none on either table, the nearest a step came to the next numbers being
    // four events short. The bound guards against the generator or the pipeline's refreshes going
    // wrong as a whole, not a sample now and then.
    expect(seen.overrun).toBeLessThanOrEqual(RUNS / 10);
    expect(seen.pending).toBeGreaterThan(0);
    // The fixed sample's corroboration, every run, sent through the pipeline and checked as encoded.
    expect(seen.corroborationsFixed).toBe(1);
    atRandom.decisions += seen.decisions;
    atRandom.corroborations += seen.corroborations;
  });

  it.runIf(isState)(
    "a `ver` on a step that only changed where cells come from: fixed scenarios",
    async () => {
      const g = (value: string) => ({ mode: "given", value });
      const span = (from: string, to?: string) => ({
        valid: { from: g(from), to: to === undefined ? { mode: "open" } : g(to) },
      });
      const write = (op: number, seen: number | undefined, valid: object, value: string): Op =>
        ({
          kind: "write",
          op,
          event: op + 1,
          ...(seen !== undefined ? { seen } : {}),
          ...valid,
          fields: { f2: { value, sources: [`S${op}`] } },
          acknowledge: ["overwrite"],
        }) as Op;
      const revoke = (op: number, seen: number, valid: object): Op =>
        ({ kind: "revoke", op, event: op + 1, seen, ...valid, validSources: [`S${op}`] }) as Op;
      const undo = (op: number, target: number, seen?: number, includeLater?: true): Op =>
        ({
          kind: "undo",
          op,
          event: op + 1,
          target,
          ...(seen !== undefined ? { seen } : {}),
          ...(includeLater ? { includeLater } : {}),
          acknowledge: ["overwrite"],
        }) as Op;
      const scenarios: [string, Op[]][] = [
        // A revoke over a stretch never written changes no cell: no version. The write after it,
        // seeing it, is sent seeing #10, still the current version, so its `ver` is marked
        // current, by the pipeline (version table) and by the scenario alike.
        [
          "a revoke over a stretch never written gives no version; a write after it is current",
          [
            write(10, 0, span("2026-11-05"), "1"),
            revoke(20, 10, span("2026-11-01", "2026-11-03")),
            write(30, 20, span("2026-11-01", "2026-11-03"), "2"),
          ],
        ],
        // A revoke inside a span already revoked gives a version (the span now comes from it); the
        // write after it sees exactly that version.
        [
          "a revoke inside a revoked span, then a write seeing it",
          [
            write(10, 0, span("2026-10-01"), "1"),
            revoke(20, 10, span("2026-11-01", "2026-11-07")),
            revoke(30, 20, span("2026-11-01", "2026-11-03")),
            write(40, 30, span("2026-11-01", "2026-11-03"), "2"),
          ],
        ],
        // Undo #90 sees #80, which gives no version: sent seeing #60, it awaits confirmation instead
        // of taking effect, and gives no version; the write after it, seeing #90, is sent seeing #60.
        [
          "an earlier `ver` mapped changes which later steps give versions",
          [
            write(10, 0, span("2026-10-01"), "1"),
            revoke(20, 10, span("2026-11-03", "2026-11-09")),
            write(30, 29, span("2026-11-05", "2026-11-07"), "5"),
            undo(40, 30, 30),
            undo(50, 20, 40),
            write(60, 50, span("2026-11-03", "2026-11-05"), "6"),
            undo(70, 50, 60),
            undo(80, 30, undefined, true),
            undo(90, 60, 80),
            write(100, 90, span("2026-11-09", "2026-11-11"), "3"),
          ],
        ],
      ];
      for (const [name, ops] of scenarios) {
        const before = { ...seen };
        await checkSample(ops, []);
        expect({
          name,
          sampled: seen.samples - before.samples,
          skipped: seen.skipped - before.skipped,
          steps: seen.steps - before.steps,
        }).toEqual({
          name,
          sampled: 1,
          skipped: 0,
          steps: ops.length,
        });
      }
    },
  );

  it.runIf(isState)(
    "a confirmation with nothing left to write back: the item was closed by the covering write",
    async () => {
      // An undo of the restore (#70) awaits, hiding #60; the revoke #80 then covers its only entry,
      // so confirming it writes nothing back: the pipeline closed it as nothing_to_revert at #80.
      const g = (value: string) => ({ mode: "given", value });
      const span = (from: string, to?: string) => ({
        valid: { from: g(from), to: to === undefined ? { mode: "open" } : g(to) },
      });
      const ops = [
        {
          kind: "write",
          op: 10,
          event: 12,
          ...span("2026-10-01"),
          fields: { f2: { value: "1", sources: ["S10"] } },
          acknowledge: ["overwrite"],
        },
        {
          kind: "revoke",
          op: 20,
          event: 22,
          seen: 10,
          ...span("2026-11-01", "2026-11-07"),
          validSources: ["S20"],
        },
        {
          kind: "write",
          op: 30,
          event: 32,
          seen: 20,
          ...span("2026-11-03", "2026-11-05"),
          fields: { f2: { value: "5", sources: ["S30"] } },
          acknowledge: ["overwrite"],
        },
        { kind: "undo", op: 40, event: 42, target: 30, seen: 30, acknowledge: ["overwrite"] },
        { kind: "undo", op: 50, event: 52, target: 20, seen: 40, acknowledge: ["overwrite"] },
        {
          kind: "write",
          op: 60,
          event: 62,
          seen: 50,
          ...span("2026-11-01", "2026-11-03"),
          fields: { f2: { value: "6", sources: ["S60"] } },
          acknowledge: ["overwrite"],
        },
        { kind: "undo", op: 70, event: 72, target: 50 },
        {
          kind: "revoke",
          op: 80,
          event: 82,
          seen: 60,
          ...span("2026-11-01", "2026-11-07"),
          validSources: ["S1"],
        },
        {
          kind: "write",
          op: 90,
          event: 92,
          seen: 80,
          ...span("2026-11-01"),
          fields: { f2: { value: "1", sources: ["S1"] } },
          acknowledge: ["overwrite"],
        },
      ] as unknown as Op[];
      const before = { ...seen };
      // The confirmation of the one open item, inserted after #80.
      await checkSample(ops, [{ after: 7, pick: 0, kind: "confirm", flag: 0, focus: false }]);
      expect({
        sampled: seen.samples - before.samples,
        closed: seen.closed - before.closed,
        steps: seen.steps - before.steps,
      }).toEqual({ sampled: 1, closed: 1, steps: ops.length + 1 });
    },
  );

  it.runIf(isState)(
    "a rejection of an item the covering write closed: refused as item_closed, nothing appended",
    async () => {
      // The counterexample of a random sample, as a fixed case: #40 (seen #10) is a candidate;
      // #70 undoes #50; #80 writes 1 back over 11-01..11-07, which leaves the awaiting undo's
      // proposal nothing to write back, so the pipeline closed the item as nothing_to_revert at #80.
      // A reject then is refused as a confirm is: the item is no longer open.
      const g = (value: string) => ({ mode: "given", value });
      const span = (from: string, to?: string) => ({
        valid: { from: g(from), to: to === undefined ? { mode: "open" } : g(to) },
      });
      const write = (op: number, value: string, source: string, more: object) => ({
        kind: "write",
        op,
        event: op + 1,
        fields: { f2: { value, sources: [source] } },
        ...more,
      });
      const ack = { acknowledge: ["overwrite"] };
      const ops = [
        write(10, "1", "S10", { seen: 0, ...span("2026-10-01"), ...ack }),
        write(20, "2", "S20", { seen: 10, ...span("2026-11-01", "2026-11-07"), ...ack }),
        write(30, "3", "S30", { seen: 20, ...span("2026-11-03", "2026-11-09"), ...ack }),
        write(40, "4", "S40", { seen: 10, ...span("2026-11-01", "2026-11-05") }),
        write(50, "5", "S50", span("2026-11-03", "2026-11-07")),
        {
          kind: "write",
          op: 60,
          event: 61,
          seen: 50,
          valid: { from: g("2026-11-01"), to: { mode: "next_change" } },
          fields: { f2: { value: "1", sources: ["S5"], explicit: false } },
          ...ack,
        },
        { kind: "undo", op: 70, event: 71, target: 50, includeLater: false, ...ack },
        {
          kind: "write",
          op: 80,
          event: 81,
          seen: 70,
          ...span("2026-11-01", "2026-11-07"),
          fields: { f2: { value: "1", sources: ["S2"], explicit: false } },
          ...ack,
        },
      ] as unknown as Op[];
      const before = { ...seen };
      // The rejection of the one awaiting item, inserted after #80.
      await checkSample(ops, [{ after: 7, pick: 0, kind: "reject", flag: 0, focus: false }]);
      expect({
        sampled: seen.samples - before.samples,
        closed: seen.closed - before.closed,
      }).toEqual({ sampled: 1, closed: 1 });
      // Closed so, the item answers a confirm and a reject the same: item_closed, with the same
      // reason and the write that closed it (#80 of the scenario, as spread out when sent).
      const store = main.store;
      const closedItem = (
        await store.read((tx) =>
          tx.query<{ id: string; v: unknown }>(
            "SELECT id, version_op AS v FROM pending_items WHERE state = 'superseded'",
          ),
        )
      ).rows;
      expect(closedItem).toHaveLength(1);
      const { id, v } = closedItem[0] as { id: string; v: unknown };
      const answer = (decision: string) =>
        store
          .write((tx) =>
            resolveInTx(tx, {
              actor: USER as never,
              task: `again-${decision}`,
              now: "2026-11-06T04:00:00.000Z",
              windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
              visibility: { kind: "all" },
              params: { id, decision, item_ver: `iv_${id.slice(3)}.${Number(v)}.0` },
              reads: readBufferOf(store),
              newId: () => "x",
            }),
          )
          .then(
            () => undefined,
            (e: { code?: string; detail?: Record<string, unknown> }) => ({
              code: e.code,
              detail: e.detail,
            }),
          );
      const onConfirm = await answer("confirm");
      expect(onConfirm).toMatchObject({
        code: "item_closed",
        detail: {
          reason: "superseded",
          superseded: { reason: "nothing_to_revert", by: spreadOp(80) },
        },
      });
      expect(await answer("reject")).toEqual(onConfirm);
    },
  );

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

it("over both tables, the random samples send corroborations through the pipeline", () => {
  // Guards against a generator gone degenerate only (no explicit field sent, or none the same
  // value): each table's fixed sample makes one every run, and the corroborations' ends and
  // covering are the fixed cases' (apply-corroboration). Judged without the store over seeds 1 to
  // 300, 40 samples a table: with a quarter of the samples restating explicitly, a mean of 15.8
  // over both tables (variance 27.7, least 4, none at 0); before, a mean of 5.8 and two seeds at 0.
  // Fitted as a negative binomial, none in a run has odds of about 1e-5.
  expect(atRandom.corroborations).toBeGreaterThan(0);
});
