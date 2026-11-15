// Pending item entries and what a write does to open items, against the reference evaluator
// (01-objects «待处理事项», «不过期：合并、取代与刷新»; 09-event-format §5.8). The comparison's
// judged scenarios go through the write pipeline as write requests, one a step. For each item event
// a step appends:
// - `current/<k>` gives the unit's values on the item's interval as the reference evaluator gives
//   them after the step (on the unit "existence": revoked stretches have no value, stretches with
//   a value have one);
// - `previous/<k>` gives them as the reference evaluator gives them at the item's merge base;
// - the item's unit, interval (`scope_valid` spans) and merge base are those worked out from the
//   scenario's judgements here: candidates join the open item of their unit whose interval meets
//   theirs, the earliest, the merge base the earliest version a candidate saw;
// and an open item is refreshed for being reached, or superseded, by a step exactly when the
// reference evaluator's state before and after the step differ on the item's unit within its
// interval: the conflict criterion's "改到", judged by a different implementation from the
// pipeline's. In some samples the steps share a task, so a writer's own receipt of an item makes
// it read and a reached item is superseded unless joined or refreshed since; in the others each
// step has its own, and reached items are refreshed.
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
  judged,
  SLOT,
  scenario,
  writeInTx,
} from "@fluxvita/saveslot-kernel/testing";
import {
  covers,
  type Evaluation,
  elementarySegments,
  endpoints,
  evaluateLog,
  type Iv,
  type Op,
  type TableSchema,
  union,
} from "@fluxvita/saveslot-reference";
import { EVENT, propRuns, STATE } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

vi.setConfig({ testTimeout: 600_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 550_000, markInterruptAsFailure: true });

// The default runs this file alone in about a minute and a half; larger counts are the first
// push's batch and the scheduled long runs.
const RUNS = propRuns(120);
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
 * The scenario's ops as this test sends them: operation numbers ten times larger (room for the
 * refresh and supersede events a step may add), a write.base after one source, `ver` explicit.
 */
function asSent(o: Op, i: number): Op {
  const x = asInThisPhase(o, i);
  const op = x.op * 10;
  const event = op + 2;
  const seen = "seen" in x && x.seen !== undefined ? x.seen * 10 : undefined;
  if (x.kind === "write" || x.kind === "revoke") {
    return i === 0
      ? ({ ...x, op, event } as Op)
      : ({ ...x, op, event, seen: seen ?? op - 1 } as Op);
  }
  if (x.kind === "undo") {
    return {
      ...x,
      op,
      event,
      target: x.target * 10,
      ...(seen !== undefined ? { seen } : {}),
    } as Op;
  }
  return { ...x, op, event } as Op;
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
 * What a row's version is about: its view without the stretches of a field no contribution gives
 * (value null, no `by`), and without a field left with none. The view lists such a stretch once
 * the field has any item, a candidate included, while the row itself, and its version table, did
 * not change.
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

type Span = { from: string | null; to: string | null };
const WHOLE_SPAN: Span = { from: null, to: null };
/** A block's interval: an end left out is open (09 §5.7 `span`). */
const spanIn = (v: { from?: string | null; to?: string | null } | undefined): Span =>
  v === undefined ? WHOLE_SPAN : { from: v.from ?? null, to: v.to ?? null };

/** A field's state on a stretch as the reference evaluator gives it (judge's token, in kind). */
function refToken(ev: Evaluation, f: string, seg: Iv, isState: boolean): string {
  if (isState && ev.gaps.some((x) => covers([x], seg))) return "no value";
  if (!isState && !ev.exists) return "no row";
  return JSON.stringify(
    (ev.fields[f as never] ?? []).find((x) => covers(x.valid, seg))?.value ?? null,
  );
}

/** The elementary segments of the sets inside `scope`, every interval read with open ends as null. */
const segmentsIn = (scope: readonly Span[], sets: readonly (readonly Span[])[]): Iv[] =>
  elementarySegments(endpoints([scope, ...sets].map((xs) => xs.map(spanIn)) as Iv[][])).filter(
    (g) => covers(scope.map(spanIn) as Iv[], g),
  );

interface Tracked {
  readonly unit: readonly string[];
  scope: Span[];
  mergeBase: number;
  readonly type: "conflict" | "awaiting_confirmation";
}

const unitKey = (u: readonly string[]) => [...u].sort().join(",");
const meets = (a: readonly Span[], b: readonly Span[]) =>
  a.some((x) =>
    b.some(
      (y) =>
        (x.to === null || y.from === null || y.from < x.to) &&
        (y.to === null || x.from === null || x.from < y.to),
    ),
  );

/** Samples, and items superseded or refreshed for being reached, over both tables. */
const totals = { samples: 0, superseded: 0, refreshed: 0 };

describe.each(both)("%s table", (_, schema: TableSchema, isState) => {
  let main: ReusableStore;
  beforeAll(async () => {
    main = await openReusable("saveslot-write-items-");
  }, 120_000);
  afterAll(async () => {
    await main?.close();
  }, 120_000);

  it("item entries and refreshes as the reference evaluator gives them", async () => {
    let drawn = 0;
    const seen = {
      samples: 0,
      skipped: 0,
      entries: 0,
      reached: 0,
      unreached: 0,
      inside: 0,
      outside: 0,
      superseded: 0,
      refreshed: 0,
      joined: 0,
    };
    await fc.assert(
      fc.asyncProperty(scenario(isState), async ({ ops: all }) => {
        // By the sample's number, not by chance: every second sample ends with a write reaching
        // the items it opens; two in four run under one task (reached items superseded), the
        // others a task a step (refreshed).
        const nth = drawn++;
        const reach = nth % 2 === 1;
        const oneTask = nth % 4 < 2;
        const cut = all.findIndex(
          (o) => o.kind !== "write" && o.kind !== "revoke" && o.kind !== "undo",
        );
        const raw = cut < 0 ? all : all.slice(0, cut);
        if (raw.length < 2 || raw[0]?.op !== 10) {
          seen.skipped++;
          return;
        }
        const sent = raw.map(asSent);
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
        // Each `ver` the latest version of the row at or before it (as in write-pipeline.prop).
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
        // A sample that opens an item ends with a write reaching it: the current version, over
        // the whole time on a state table, acknowledged. Random steps reach an open item rarely;
        // this makes every such sample check a reach (superseded or refreshed, by its task).
        const judgedOnce = judged(schema, ops, []);
        const opens = judgedOnce.steps.some(
          (x) =>
            x.judgement.conflicts.length > 0 ||
            ("items" in x.judgement.record &&
              x.judgement.record.items.some((y) => y.status === "awaiting")),
        );
        const last = judgedOnce.steps.at(-1)?.op.op ?? 0;
        if (opens && reach) {
          const op = last + 10;
          ops.push({
            kind: "write",
            op,
            event: op + 2,
            seen: versions.filter((v) => v <= last).at(-1) ?? last,
            ...(isState
              ? { valid: { from: { mode: "given", value: "2026-01-01" }, to: { mode: "open" } } }
              : {}),
            fields: { f2: { value: "reached", sources: [`S${op}`] } },
            acknowledge: ["overwrite"],
          } as unknown as Op);
        }
        const { steps } = opens && reach ? judged(schema, ops, []) : judgedOnce;
        await main.reset();
        const store = main.store;
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
        let model = 0;
        let fillers = 9_000_000;
        const tracked = new Map<string, Tracked>();
        const refAt = (n: number) =>
          evaluateLog(
            schema,
            steps.filter((x) => x.op.op <= n).map((x) => x.op),
          ).final;
        let before = refAt(0);
        for (const [k, step] of steps.entries()) {
          const o = step.op;
          // Up to the step's operation number in one operation: a filler head and sources.
          const tail = (await store.read(readTail))?.seq ?? 0;
          if (tail < o.op - 1) {
            await run([
              filler,
              ...Array.from(
                { length: o.op - 2 - tail },
                (): NewEvent => ({
                  type: "source.recorded",
                  slot: SLOT,
                  blocks: {
                    target: {
                      source_id: `s_${String(++fillers).padStart(16, "0")}`,
                      kind: "agent_note",
                      level: "agent_inferred",
                    },
                    text: { text: "filler" },
                  },
                }),
              ),
            ]);
          }
          const now = "now" in step.input ? (step.input.now as string) : "2026-11-05";
          await store.write((tx) =>
            writeInTx(tx, {
              actor: USER as never,
              // One task for every step in some samples: a step's own receipt of an item counts as
              // read by the later steps (an item reached at the version it was opened with is
              // superseded). A task a step in the others: reached items are refreshed.
              task: oneTask ? "shared" : `step-${k}`,
              now: `${now}T04:00:00.000Z`,
              windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
              visibility: { kind: "all" },
              // Under one task the scenarios repeat requests word for word, which would be resends:
              // a key of the step's own keeps each a request of its own.
              params: {
                ...(requestOf(o, o.op === 100 ? 0 : 1, isState) as object),
                ...(oneTask ? { idempotency_key: `step-${k}` } : {}),
              },
              reads: readBufferOf(store),
              newId: (kind) =>
                kind === "row"
                  ? ROW
                  : kind === "entity"
                    ? ENTITY
                    : kind === "item"
                      ? `pi_${String(++items).padStart(16, "0")}`
                      : `s_${String(o.op).padStart(16, "0")}`,
            }),
          );
          const evs = await store.read(async (tx) =>
            (await readEvents(tx, o.op, (await readTail(tx))?.seq ?? o.op)).map((e) => ({
              type: e.header["type"] as string,
              seq: Number(e.header["seq"]),
              blocks: Object.fromEntries(
                [...e.blocks].flatMap(([p, b]) => (b.state === "present" ? [[p, b.value]] : [])),
              ) as Record<string, unknown>,
            })),
          );
          const after = refAt(o.op);
          const stretches = (blocks: Record<string, unknown>, prefix: string) =>
            Object.entries(blocks)
              .filter(([p]) => p.startsWith(`${prefix}/`))
              .map(([, v]) => {
                const y = v as { field: string; value?: unknown; revoked?: true; valid?: Span };
                return y.valid === undefined ? y : { ...y, valid: spanIn(y.valid) };
              });

          // "改到": the open items before this step, against the reference before and after it. A
          // refresh for changed entries (`entries_changed`) is not one.
          const reachedNow = new Set(
            evs
              .filter(
                (e) =>
                  e.type === "item.superseded" ||
                  (e.type === "item.refreshed" &&
                    (e.blocks["target"] as { cause: string }).cause === "target_overwritten"),
              )
              .map((e) => (e.blocks["target"] as { item: string }).item),
          );
          seen.superseded += evs.filter((e) => e.type === "item.superseded").length;
          seen.refreshed +=
            reachedNow.size - evs.filter((e) => e.type === "item.superseded").length;
          const written =
            "items" in step.judgement.record
              ? step.judgement.record.items.filter((x) => x.status === "applied")
              : [];
          for (const [id, t] of tracked) {
            const fields = t.unit[0] === "existence" ? ["f2"] : t.unit;
            const segs = isState
              ? segmentsIn(t.scope, [
                  before.gaps,
                  after.gaps,
                  ...fields.flatMap((f) =>
                    [...(before.fields[f as never] ?? []), ...(after.fields[f as never] ?? [])].map(
                      (x) => x.valid,
                    ),
                  ),
                ])
              : [WHOLE_SPAN as Iv];
            // On the unit "existence" only having a value or not counts (the conflict unit).
            const gone = (tok: string) => tok === "no value" || tok === "no row";
            const changed =
              t.unit[0] === "existence"
                ? segs.some(
                    (g) =>
                      gone(refToken(before, "f2", g, isState)) !==
                      gone(refToken(after, "f2", g, isState)),
                  )
                : fields.some((f) =>
                    segs.some(
                      (g) => refToken(before, f, g, isState) !== refToken(after, f, g, isState),
                    ),
                  );
            expect({ step: k, item: id, reached: reachedNow.has(id) }).toEqual({
              step: k,
              item: id,
              reached: changed,
            });
            if (changed) seen.reached++;
            else seen.unreached++;
            const inside =
              !isState ||
              written.some((x) =>
                (x.valid as unknown as Span[]).some((v) =>
                  t.scope.some(
                    (s) =>
                      (s.to === null || v.from === null || v.from < s.to) &&
                      (v.to === null || s.from === null || s.from < v.to),
                  ),
                ),
              );
            if (inside) seen.inside++;
            else seen.outside++;
          }
          // The items as worked out here from the step's judgement: each conflict joins the open
          // conflict item of its unit whose interval meets its candidate items', the earliest of
          // several, or opens one; a write awaiting confirmation opens one. Opened in this order,
          // the pipeline numbers them the same way.
          const recordItems = "items" in step.judgement.record ? step.judgement.record.items : [];
          const spansOf = (xs: readonly { valid: unknown }[]): Span[] =>
            isState
              ? (union(...xs.map((x) => x.valid as Iv[])) as unknown as Span[])
              : [WHOLE_SPAN];
          const expected = new Map<string, Tracked>();
          for (const c of step.judgement.conflicts) {
            const unit = c.unit === "existence" ? ["existence"] : [...c.unit.fields].sort();
            const mine = spansOf(
              recordItems.filter((x) => c.items.some((r) => r.target === x.target && r.k === x.k)),
            );
            const seenOp = ("seen" in o ? (o.seen as number | undefined) : undefined) ?? o.op - 1;
            const prior = [...tracked].find(
              ([, t]) =>
                t.type === "conflict" &&
                unitKey(t.unit) === unitKey(unit) &&
                (!isState || meets(t.scope, mine)),
            );
            if (prior !== undefined) {
              const [id, t] = prior;
              t.scope = isState
                ? (union(...([...t.scope, ...mine] as Iv[]).map((x) => [x])) as unknown as Span[])
                : [WHOLE_SPAN];
              t.mergeBase = Math.min(t.mergeBase, seenOp);
              expected.set(id, t);
              seen.joined++;
            } else {
              const id = `pi_${String(++model).padStart(16, "0")}`;
              const t: Tracked = { unit, scope: mine, mergeBase: seenOp, type: "conflict" };
              tracked.set(id, t);
              expected.set(id, t);
            }
          }
          const proposal = recordItems.filter((x) => x.status === "awaiting");
          if (proposal.length > 0) {
            const id = `pi_${String(++model).padStart(16, "0")}`;
            const unit = proposal.some((x) => x.target === "existence")
              ? ["existence"]
              : [...new Set(proposal.map((x) => x.target as string))].sort();
            const t: Tracked = {
              unit,
              scope: spansOf(proposal),
              mergeBase: 0,
              type: "awaiting_confirmation",
            };
            tracked.set(id, t);
            expected.set(id, t);
          }
          for (const e of evs) {
            const t = e.blocks["target"] as
              | { item: string; unit?: string[]; merge_base_op?: number; type?: string }
              | undefined;
            if (t === undefined) continue;
            if (e.type === "item.superseded") tracked.delete(t.item);
            if (e.type === "item.created" || e.type === "item.merged") {
              // Unit, interval and merge base as worked out here.
              const x = expected.get(t.item);
              expect({ step: k, item: t.item, known: x !== undefined }).toEqual({
                step: k,
                item: t.item,
                known: true,
              });
              if (x === undefined) continue;
              if (e.type === "item.created") {
                expect({ step: k, unit: t.unit }).toEqual({ step: k, unit: x.unit });
              }
              if (x.type === "conflict") {
                expect({ step: k, item: t.item, base: t.merge_base_op }).toEqual({
                  step: k,
                  item: t.item,
                  base: x.mergeBase,
                });
              }
              if (isState) {
                const sv = e.blocks["scope_valid"] as { spans: Span[] } | undefined;
                expect({ step: k, item: t.item, spans: (sv?.spans ?? []).map(spanIn) }).toEqual({
                  step: k,
                  item: t.item,
                  spans: x.scope.map(spanIn),
                });
              }
            }
            const x = tracked.get(t.item);
            if (x === undefined) continue;
            // current/<k> and previous/<k> against the reference after the step and at the merge base.
            const check = (prefix: "current" | "previous", ref: Evaluation) => {
              const entries = stretches(e.blocks, prefix);
              if (
                entries.length === 0 &&
                !(prefix in e.blocks) &&
                e.type === "item.merged" &&
                prefix === "current"
              )
                return;
              const fields = x.unit[0] === "existence" ? ["existence"] : x.unit;
              for (const f of fields) {
                const mine = entries.filter((y) => y.field === f);
                const segs = isState
                  ? segmentsIn(x.scope, [
                      ref.gaps,
                      ...mine.map((y) => [y.valid ?? WHOLE_SPAN]),
                      ...(f === "existence"
                        ? []
                        : (ref.fields[f as never] ?? []).map((y) => y.valid)),
                    ])
                  : [WHOLE_SPAN as Iv];
                for (const g of segs) {
                  const entry = mine.find((y) => covers([(y.valid ?? WHOLE_SPAN) as Iv], g));
                  if (f === "existence") {
                    // A revoked stretch has no value; a stretch with a value has one.
                    if (entry !== undefined) {
                      const gone = ["no value", "no row"].includes(refToken(ref, "f2", g, isState));
                      expect({ step: k, prefix, g, revoked: entry.revoked === true }).toEqual({
                        step: k,
                        prefix,
                        g,
                        revoked: gone,
                      });
                    }
                    continue;
                  }
                  const tok = refToken(ref, f, g, isState);
                  const mineTok =
                    entry === undefined ? "absent" : JSON.stringify(entry.value ?? null);
                  // No entry: no write ever gave the field a state there (current), or no value at all.
                  const want =
                    tok === "no value" || tok === "no row" || tok === "null"
                      ? ["absent", "null"]
                      : [tok];
                  expect({
                    step: k,
                    prefix,
                    f,
                    g,
                    entry: want.includes(mineTok) ? "ok" : mineTok,
                  }).toEqual({ step: k, prefix, f, g, entry: "ok" });
                }
              }
              seen.entries++;
            };
            if (e.type === "item.created" || e.type === "item.refreshed") check("current", after);
            if (e.type !== "item.superseded" && x.unit[0] !== undefined)
              check("previous", refAt(x.mergeBase));
          }
          before = after;
        }
      }),
      {
        numRuns: RUNS,
        ...(SEED !== undefined ? { seed: SEED } : {}),
        ...(process.env["PROP_PATH"] ? { path: process.env["PROP_PATH"], endOnFailure: true } : {}),
      },
    );
    // The cases each sample must reach are built in (above); these only guard against a generator
    // gone degenerate as a whole.
    expect(seen.samples).toBeGreaterThan(RUNS / 3);
    expect({
      reached: seen.reached > 0,
      unreached: seen.unreached > 0,
      inside: seen.inside > 0,
      outside: isState ? seen.outside > 0 : true,
      joined: seen.joined > 0,
      entries: seen.entries > 0,
    }).toEqual({
      reached: true,
      unreached: true,
      inside: true,
      outside: true,
      joined: true,
      entries: true,
    });
    totals.samples += seen.samples;
    totals.superseded += seen.superseded;
    totals.refreshed += seen.refreshed;
  });
});

describe("both tables", () => {
  it("reached items were superseded and refreshed", () => {
    expect({
      superseded: totals.superseded > 0,
      refreshed: totals.refreshed > 0,
    }).toEqual({ superseded: true, refreshed: true });
  });
});
