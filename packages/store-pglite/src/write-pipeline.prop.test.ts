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
  eventsOfSteps,
  FIRST_OP,
  judged,
  type LoggedEvent,
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

const RUNS = propRuns(60);
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

describe.each(both)("%s table", (_, schema: TableSchema, isState) => {
  let main: ReusableStore;
  beforeAll(async () => {
    main = await openReusable("saveslot-write-pipeline-");
  }, 120_000);
  afterAll(async () => {
    await main?.close();
  }, 120_000);

  it("each judged step sent as a write request appends what the record mapping encodes", async () => {
    const seen = { samples: 0, skipped: 0, steps: 0, pending: 0 };
    await fc.assert(
      fc.asyncProperty(scenario(isState), async ({ ops: all }) => {
        // Decisions are `resolve` operations, not write requests: the log up to the first one.
        const cut = all.findIndex(
          (o) => o.kind !== "write" && o.kind !== "revoke" && o.kind !== "undo",
        );
        const raw = cut < 0 ? all : all.slice(0, cut);
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
        const first = judged(schema, sent, []);
        const versions = first.steps
          .filter((x, k) => {
            const before = k === 0 ? undefined : asVersion((first.steps[k - 1] as typeof x).state);
            return asVersion(x.state) !== before;
          })
          .map((x) => x.op.op);
        const toVersion = (s: number) => versions.filter((v) => v <= s).at(-1);
        if (
          sent.some(
            (o, i) =>
              i > 0 && "seen" in o && o.seen !== undefined && toVersion(o.seen) === undefined,
          )
        ) {
          seen.skipped++;
          return;
        }
        const ops = sent.map((o, i) =>
          i > 0 && "seen" in o && o.seen !== undefined
            ? ({ ...o, seen: toVersion(o.seen) } as Op)
            : o,
        );
        const { steps } = judged(schema, ops, []);
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
          for (let tail = (await store.read(readTail))?.seq ?? 0; tail < head - 1; tail++) {
            await run([filler]);
          }
          const now = "now" in step.input ? (step.input.now as string) : "2026-11-05";
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
              newId: (kind) =>
                kind === "row"
                  ? ROW
                  : kind === "entity"
                    ? ENTITY
                    : kind === "item"
                      ? `pi_${String(++items).padStart(16, "0")}`
                      : `s_${String(head).padStart(16, "0")}`,
            }),
          );
          const got = await store.read(async (tx) => {
            const last = (await readTail(tx))?.seq ?? 0;
            return (await readEvents(tx, head, last))
              .filter((e) => e.header["type"] !== "source.recorded")
              .map((e) => ({
                type: e.header["type"] as string,
                seq: Number(e.header["seq"]),
                blocks: Object.fromEntries(
                  [...e.blocks].flatMap(([p, b]) => (b.state === "present" ? [[p, b.value]] : [])),
                ),
              }));
          });
          expect({ step: k, events: got.map((e) => comparable(e, realItems)) }).toEqual({
            step: k,
            events: want.map((e) => comparable(e, expectedItems)),
          });
          // The receipt: pending exactly when some part is a candidate or awaiting.
          const r = step.judgement.record;
          const pending =
            "items" in r &&
            r.items.some((x) => x.status === "candidate" || x.status === "awaiting");
          expect({ step: k, status: receipt.status }).toEqual({
            step: k,
            status: pending ? "pending" : "saved",
          });
          if (pending) seen.pending++;
          seen.steps++;
        }
      }),
      {
        numRuns: RUNS,
        ...(SEED !== undefined ? { seed: SEED } : {}),
        ...(process.env["PROP_PATH"] ? { path: process.env["PROP_PATH"], endOnFailure: true } : {}),
      },
    );
    if (process.env["JUDGE_STATS"]) console.log(schema.kind, JSON.stringify(seen));
    expect(seen.samples).toBeGreaterThan(RUNS / 3);
    expect(seen.pending).toBeGreaterThan(0);
  });
});
