// Replay across the two backends (02-architecture §11 «测试矩阵», «重放对拍»; §8 the «对拍» column;
// K12). A random history is written through the write pipeline into a store on one backend; its
// log is then given, from the first event, to `apply` on an empty store of the other backend; and
// the tables §8 marks as compared must be the same row by row, with the same columns. Both ways:
// written on PGlite and replayed on PostgreSQL, written on PostgreSQL and replayed on PGlite.
//
// The history is a slot with tables of every time type and derived tables over one of them, and
// then requests that insert, change, revoke and restore rows and entities, and corroborate a value
// with evidence pointed at it. Its values are chosen for where two databases could differ:
// decimals that round, integers beyond 2^53, text outside ASCII and outside the BMP, instants
// given with a zone's name around a clock change, and aggregates (sum, avg, max, a week's start)
// the database works out in the derived writes.
//
// What is compared is what each backend hands the kernel for `SELECT *`, so a value that one
// backend parses differently from the other is a difference here too; and each table's columns by
// name, type, precision and scale, and whether they take NULL.
//
// A table compared while empty on both sides shows nothing. The fixed histories (`EVERY`) put rows
// in every compared table this version's kernel writes, a conflict item and its resolution among
// them, and check that they did. Three are empty on both sides and are named in `EMPTY`:
// deletions, external keys and migrations; the kernel does not write them yet, and each is to get
// its steps here with the feature that writes it. Premises are not taken by the write path yet
// either: their steps append a head by hand (a restatement or a clearing on a run, covering the
// items of its insert) and a `premise.changed`, so that `apply` fills both premise tables.
//
// Needs a PostgreSQL server (SAVESLOT_TEST_POSTGRES_URL); without one it is skipped, and says so.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  KERNEL_TABLES,
  loadRsql,
  type NewEvent,
  type ReadTx,
  readBufferOf,
  readEvents,
  readTail,
  type TenantStore,
  WriteError,
} from "@fluxvita/saveslot-kernel";
import { derivedSchema, fc, propRuns, rule } from "@fluxvita/saveslot-kernel/rsql-testing";
import { createSlotEvents, resolveInTx, SLOT, writeInTx } from "@fluxvita/saveslot-kernel/testing";
import { PgliteBackend } from "@fluxvita/saveslot-store-pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Reusable, reusable } from "../../store-pglite/src/testing/reusable-store.fixture.ts";
import { testCell, testPostgres } from "../../store-postgres/src/testing/test-postgres.fixture.ts";
import { TEST_DURABILITY } from "./index.fixture.ts";

vi.setConfig({ testTimeout: 600_000 });
// Room under the 600 s limit for the sample running when the limit comes: a real difference found
// late, while shrinking, ends as a failure with the counterexample so far, not as a timeout.
fc.configureGlobal({ interruptAfterTimeLimit: 420_000, markInterruptAsFailure: true });

const RUNS = propRuns(12);
/** `PROP_SEED` fixes the seed (and `PROP_PATH` with it replays one counterexample). */
const SEED = process.env["PROP_SEED"] === undefined ? undefined : Number(process.env["PROP_SEED"]);

type Schema = ReturnType<typeof derivedSchema>;
type Derived = Extract<Schema["tables"][number], { kind: "derived" }>;

const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

/** Derived tables over runs: what the database itself computes, on each backend, into the log. */
const RULES = [
  [
    "t9",
    "SELECT date_trunc('week', date::timestamp)::date AS w, sum(distance) AS total, count(*) AS n FROM runs GROUP BY 1",
    ["w", "total", "n"],
    "bucketed",
  ],
  [
    "t10",
    "SELECT route AS r, max(pace) AS p, count(feeling) AS f FROM runs GROUP BY 1",
    ["r", "p", "f"],
    "none",
  ],
  [
    "t11",
    "SELECT sum(distance) AS total, avg(laps) AS laps FROM runs WHERE race",
    ["total", "laps"],
    "none",
  ],
  [
    "t12",
    "SELECT feeling AS f, avg(pace) AS p, min(laps) AS least FROM runs GROUP BY 1",
    ["f", "p", "least"],
    "none",
  ],
] as const;

function slotSchema(): Schema {
  const derived = RULES.map(([id, sql, fields, td], i): Derived => {
    const t = derivedSchema(rule(sql, fields, td)).tables.find((x) => x.id === "t9") as Derived;
    return {
      ...t,
      id,
      name: `derived_${id}`,
      physical: { table: `d_${id}_v1` },
      rule: { ...t.rule, id: `r${i + 1}` as Derived["rule"]["id"] },
    } as Derived;
  });
  const base = derivedSchema(rule(RULES[0][1], RULES[0][2], RULES[0][3]));
  return {
    ...base,
    slot: SLOT,
    tables: [...base.tables.filter((t) => t.kind === "base"), ...derived],
  } as Schema;
}

// --- the history -------------------------------------------------------------------------------

type Cells = Readonly<Record<string, unknown>>;
type Step =
  | { readonly k: "run"; readonly cells: Cells; readonly shoe: number | null }
  | { readonly k: "run.update"; readonly n: number; readonly cells: Cells }
  | { readonly k: "run.revoke"; readonly n: number }
  | { readonly k: "run.restore"; readonly n: number }
  /** An update of a run with the `ver` it had when inserted: a candidate on a conflict item. */
  | { readonly k: "run.stale"; readonly n: number; readonly cells: Cells }
  /** A decision on an open item. */
  | {
      readonly k: "resolve";
      readonly n: number;
      readonly decision: "keep_effective" | "take_candidate" | "take_previous";
    }
  | { readonly k: "shoe"; readonly model: string }
  /**
   * Run `n` restated on run `m` (or its premises cleared), covering the items of its insert; the
   * earliest declaration so far marked changed. `wide`: a head of eleven ops, ops 2 and 10 both
   * restating, so that the earlier op's edge arrives after the later one's (blocks go in path
   * order). A head by hand.
   */
  | {
      readonly k: "premise";
      readonly n: number;
      readonly m: number;
      readonly clear: boolean;
      readonly wide: boolean;
    }
  | {
      readonly k: "expense";
      readonly date: string;
      readonly category: string;
      readonly amount: string;
      readonly note: string | null;
    }
  | {
      readonly k: "budget";
      readonly category: string;
      readonly amount: string;
      readonly from: string;
    }
  /**
   * The amount a category's budget was last given, again, with evidence pointed at it
   * (`evidence_by_field`), from that write's start to the next day: a corroboration, its ends given.
   */
  | { readonly k: "budget.corroborate"; readonly category: string }
  | { readonly k: "room"; readonly guest: string | null; readonly from: string }
  | {
      readonly k: "room.update";
      readonly n: number;
      readonly guest: string | null;
      readonly from: string;
    }
  | { readonly k: "room.revoke"; readonly n: number };

const km = (value: string) => ({ value, unit: "km" });
const TEXTS = ["", "ok", "说", "Straße", "𝄞 clef", "ÀB a", "a\tb\\c'd"];
/** Instants as a caller writes them: an offset, a zone's name, around a clock change, long ago. */
const STARTED = [
  "2026-11-02T07:30:00+08:00",
  "2026-10-25T02:30:00+01:00[Europe/Berlin]",
  "2026-10-25T02:30:00+02:00[Europe/Berlin]",
  "2026-03-29T03:00:00+02:00[Europe/Berlin]",
  "2026-11-01T23:59:59-03:00[America/Sao_Paulo]",
  "1999-12-31T23:59:59.999Z",
];
const runCells = fc.record(
  {
    date: fc.constantFrom("2026-10-28", "2026-11-01", "2026-11-02", "2026-11-09", "2026-12-31"),
    distance: fc.constantFrom("1", "2.5", "0.005", "0.015", "12345678.125").map(km),
    duration: fc.option(
      fc.constantFrom("30", "0.25", "0.35", "61.05").map((value) => ({ value, unit: "min" })),
      { nil: null },
    ),
    feeling: fc.option(fc.constantFrom(...TEXTS), { nil: null }),
    route: fc.option(fc.constantFrom("park", "river"), { nil: null }),
    laps: fc.option(fc.constantFrom("0", "3", "-8", "9007199254740993"), { nil: null }),
    pace: fc.option(fc.constantFrom("4.5", "5.2505", "-1", "0.0005", "1e2"), { nil: null }),
    started: fc.option(fc.constantFrom(...STARTED), { nil: null }),
    race: fc.option(fc.boolean(), { nil: null }),
    uphill: fc.option(
      fc.constantFrom("0.5", "1.005").map((value) => ({ value, unit: "mi" })),
      { nil: null },
    ),
  },
  { requiredKeys: [] },
);
const INSTANTS = [
  "2026-11-05T00:00:00+08:00",
  "2026-11-06T10:00:00+08:00",
  "2026-11-10T08:30:00.250Z",
  "2026-10-25T02:30:00+01:00",
];
const guest = fc.option(fc.constantFrom(...TEXTS), { nil: null });
const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      k: fc.constant("run" as const),
      cells: runCells.map((c) => ({ date: "2026-11-02", distance: km("1"), ...c })),
      shoe: fc.option(fc.nat(9), { nil: null }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({ k: fc.constant("run.update" as const), n: fc.nat(9), cells: runCells }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("run.revoke" as const), n: fc.nat(9) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("run.restore" as const), n: fc.nat(9) }) },
  {
    weight: 1,
    arbitrary: fc.record({ k: fc.constant("shoe" as const), model: fc.constantFrom(...TEXTS) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant("expense" as const),
      date: fc.constantFrom("2026-10-31", "2026-11-01"),
      category: fc.constantFrom("food", "书"),
      amount: fc.constantFrom("12.345", "0.005", "99999999999.99"),
      note: fc.option(fc.constantFrom(...TEXTS), { nil: null }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant("budget" as const),
      category: fc.constantFrom("food", "书"),
      amount: fc.constantFrom("5000", "0.005", "0.015", "99999999999.99"),
      from: fc.constantFrom("2026-09-01", "2026-10-01", "2026-11-15"),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant("budget.corroborate" as const),
      category: fc.constantFrom("food", "书"),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant("room" as const),
      guest,
      from: fc.constantFrom(...INSTANTS),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant("room.update" as const),
      n: fc.nat(9),
      guest,
      from: fc.constantFrom(...INSTANTS),
    }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("room.revoke" as const), n: fc.nat(9) }) },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant("premise" as const),
      n: fc.nat(9),
      m: fc.nat(9),
      clear: fc.boolean(),
      wide: fc.boolean(),
    }),
  },
);

interface Receipt {
  readonly seq: number;
  readonly status: string;
  readonly ops: {
    readonly target: { readonly row?: string; readonly entity?: string };
    readonly ver: string;
  }[];
  readonly pending?: readonly { readonly id: string; readonly item_ver?: string }[];
}

const ctx = (now: string) =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_key_window: 86_400_000,
    idempotency_window: 86_400_000,
    now,
    confirmation: null,
  });

/** By kind of step: the requests saved, and those the pipeline did not save. */
type Reached = Record<string, { saved: number; not: number }>;

/**
 * Writes the history into an empty store: the tenant, the slot, then a request a step, each an
 * operation of its own. A step that has nothing to act on is left out; a request the pipeline does
 * not save stays in the history as whatever it left. Returns what the steps came to.
 */
async function write(store: TenantStore, schema: Schema, steps: readonly Step[]): Promise<Reached> {
  const reached: Reached = {};
  await createTenant(store, ctx("2026-11-10T04:00:00.000Z"));
  const change = (target: Record<string, unknown>, kind: string) => ({
    target,
    change: kind,
    class: "create",
    compatible_with_old_writes: true,
    destructive: false,
    auto: true,
  });
  await store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-10T05:00:00.000Z" as never,
      events: createSlotEvents({
        compiled: schema as never,
        changes: [
          change({ slot: true }, "create_slot"),
          ...schema.tables.map((t) =>
            change({ table: t.id }, t.kind === "base" ? "add_table" : "add_derived_table"),
          ),
        ] as never,
      }),
    });
    await applyEvents(tx, eventsOf(op));
  });

  let ids = 0;
  let partitions = 0;
  const newId = (kind: "row" | "entity" | "source" | "item" | "partition") =>
    kind === "partition"
      ? `p_${String(++partitions).padStart(16, "0")}`
      : `${{ row: "r_", entity: "e_", source: "s_", item: "pi_" }[kind]}${String(++ids).padStart(kind === "row" || kind === "entity" ? 26 : 16, "0")}`;
  const runs: { id: string; first: string; ver: string; revoked?: number; op: number }[] = [];
  const runsTable = schema.tables.find((t) => t.name === "runs") as Schema["tables"][number];
  const RUNS_ID = runsTable.id;
  const DISTANCE_ID = (runsTable.fields as readonly { id: string; name: string }[]).find(
    (f) => f.name === "distance",
  )?.id as string;
  /** The premise declarations made so far, (op, i, j), the earliest first. */
  const declared: { op: number; i: number; j: number; target: string; changed?: true }[] = [];
  /** The open items the stale updates made, with their item version. */
  const items: { id: string; ver: string }[] = [];
  const rooms: { id: string; ver: string; revoked?: boolean }[] = [];
  const shoes: string[] = [];
  /** By category, the amount and start of the budget write saved last. */
  const budgets = new Map<string, { amount: string; from: string }>();
  const at = <T>(xs: readonly T[], n: number) => xs[n % Math.max(xs.length, 1)];

  for (const [i, s] of steps.entries()) {
    if (s.k === "premise") {
      const hit = reached[s.k] ?? { saved: 0, not: 0 };
      reached[s.k] = hit;
      const dep = at(runs, s.n);
      const on = at(runs, s.m);
      if (dep === undefined || on === undefined || dep === on || dep.revoked !== undefined) {
        hit.not++;
        continue;
      }
      await store.write(async (tx) => {
        const tail = (await readTail(tx))?.seq ?? 0;
        const op = tail + 1;
        const base = await tx.query<{ seq: unknown }>(
          "SELECT seq FROM events WHERE type = 'write.base' AND op = $1 ORDER BY seq LIMIT 1",
          [dep.op],
        );
        const event = Number(base.rows[0]?.seq);
        const items = await tx.query<{ path: string }>(
          "SELECT path FROM content WHERE seq = $1 AND path LIKE 'fields/%'",
          [event],
        );
        const covers = items.rows.map((r) => {
          const [, field, k] = r.path.split("/");
          return { event, field: field as string, k: Number(k) };
        });
        const verOf = (v: string) => Number(/^v(\d+)\./.exec(v)?.[1]);
        const wide = s.wide && !s.clear;
        const restating = wide ? [2, 10] : [0];
        /** Op `i` on the run: restating (or clearing) with its covers, or only its target. */
        const opBlocks = (i: number, premised: boolean): Record<string, unknown> => ({
          [`ops/${i}/target`]: {
            table: RUNS_ID,
            row: dep.id,
            intent: "update",
            ver: { op: verOf(dep.ver), restore_count: 0, basis: "explicit" },
          },
          ...(!premised
            ? {}
            : s.clear
              ? { [`ops/${i}/premises_cleared`]: true }
              : {
                  [`ops/${i}/premises/0`]: {
                    table: RUNS_ID,
                    row: on.id,
                    ...(s.m % 2 === 0 ? { fields: [DISTANCE_ID] } : {}),
                    ver: { op: verOf(on.ver), restore_count: 0, basis: "explicit" },
                    range: "whole",
                    state: "current",
                  },
                }),
          ...(premised && covers.length > 0 ? { [`ops/${i}/premise_covers`]: covers } : {}),
        });
        const head: NewEvent = {
          type: "write.head",
          slot: SLOT,
          blocks: {
            ctx: {
              now: "2026-11-10T07:00:00.000Z",
              today: "2026-11-10",
              ruleset_version: 1,
              policy_version: 1,
              literal_checker: "literal@1",
            },
            request: { sv: 1, sv_basis: "explicit", op_count: wide ? 11 : 1 },
            ...Object.assign({}, ...restating.map((i) => opBlocks(i, true))),
            ...Object.assign(
              {},
              ...(wide ? [...Array(11).keys()].filter((i) => !restating.includes(i)) : []).map(
                (i) => opBlocks(i, false),
              ),
            ),
          },
        };
        const first = declared.find((d) => d.changed === undefined);
        const changed: NewEvent[] =
          first === undefined
            ? []
            : [
                {
                  type: "premise.changed",
                  slot: SLOT,
                  blocks: {
                    // The declaration's premise target. No write in this operation changed it (the
                    // change is made up, for apply to record): `by_event`, shown only and not
                    // applied (§5.10), names the head, the one earlier event of the operation.
                    "targets/0": {
                      table: RUNS_ID,
                      row: first.target,
                      by_event: op,
                      changed: [{ op: first.op, i: first.i, j: first.j, reason: "update" }],
                    },
                  },
                },
              ];
        const appended = await appendOperation(tx, {
          actor: USER as never,
          now: `2026-11-10T07:${String(i).padStart(2, "0")}:30.000Z` as never,
          events: [head, ...changed],
        });
        await applyEvents(tx, eventsOf(appended));
        if (first !== undefined) first.changed = true;
        if (!s.clear) for (const i of restating) declared.push({ op, i, j: 0, target: on.id });
      });
      hit.saved++;
      continue;
    }
    const run = s.k.startsWith("run.") ? at(runs, (s as { n: number }).n) : undefined;
    const item = s.k === "resolve" ? at(items, s.n) : undefined;
    const room = s.k.startsWith("room.") ? at(rooms, (s as { n: number }).n) : undefined;
    let op: Record<string, unknown> | undefined;
    if (s.k === "run") {
      const shoe = s.shoe === null ? undefined : at(shoes, s.shoe);
      op = { intent: "insert", table: "runs", set: { ...s.cells, ...(shoe ? { shoe } : {}) } };
    } else if (s.k === "run.update") {
      if (run && run.revoked === undefined && Object.keys(s.cells).length > 0)
        op = { intent: "update", table: "runs", row: run.id, ver: run.ver, set: s.cells };
    } else if (s.k === "run.revoke") {
      if (run && run.revoked === undefined)
        op = { intent: "revoke", table: "runs", row: run.id, ver: run.ver };
    } else if (s.k === "run.restore") {
      if (run && run.revoked !== undefined)
        op = { table: "runs", row: run.id, revert: { undo: run.revoked } };
    } else if (s.k === "run.stale") {
      if (
        run &&
        run.revoked === undefined &&
        run.ver !== run.first &&
        Object.keys(s.cells).length > 0
      )
        op = { intent: "update", table: "runs", row: run.id, ver: run.first, set: s.cells };
    } else if (s.k === "resolve") {
      if (item) op = { id: item.id, decision: s.decision, item_ver: item.ver };
    } else if (s.k === "shoe") {
      op = { intent: "insert", table: "shoes", set: { model: s.model } };
    } else if (s.k === "expense") {
      op = {
        intent: "insert",
        table: "expenses",
        set: {
          date: s.date,
          category: s.category,
          amount: { value: s.amount, unit: "CNY" },
          ...(s.note !== null ? { note: s.note } : {}),
        },
      };
    } else if (s.k === "budget") {
      op = {
        intent: "update",
        table: "budgets",
        entity_key: { category: s.category },
        set: { amount: { value: s.amount, unit: "CNY" } },
        valid_from: s.from,
      };
    } else if (s.k === "budget.corroborate") {
      // The last write's value holds over its start's day at least: a date table's next blocking
      // point is a day after it or later.
      const last = budgets.get(s.category);
      if (last) {
        const next = new Date(`${last.from}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        op = {
          intent: "update",
          table: "budgets",
          entity_key: { category: s.category },
          set: { amount: { value: last.amount, unit: "CNY" } },
          valid_from: last.from,
          valid_to: next.toISOString().slice(0, 10),
          evidence: [{ kind: "user_message", text: `still ${last.amount}` }],
          evidence_by_field: { amount: [0] },
        };
      }
    } else if (s.k === "room") {
      op = { intent: "insert", table: "rooms", valid_from: s.from, set: { guest: s.guest } };
    } else if (s.k === "room.update") {
      if (room && !room.revoked)
        op = {
          intent: "update",
          table: "rooms",
          entity: room.id,
          ver: room.ver,
          valid_from: s.from,
          set: { guest: s.guest },
        };
    } else if (room && !room.revoked) {
      op = { intent: "revoke", table: "rooms", entity: room.id, ver: room.ver };
    }
    if (op === undefined) continue;
    const params =
      s.k === "resolve"
        ? { ...op, idempotency_key: `step-${i}` }
        : { sv: 1, idempotency_key: `step-${i}`, ops: [op] };
    const hit = reached[s.k] ?? { saved: 0, not: 0 };
    reached[s.k] = hit;
    let receipt: Receipt;
    try {
      const input = {
        actor: USER as never,
        task: null,
        now: `2026-11-10T07:${String(i).padStart(2, "0")}:00.000Z` as never,
        windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
        visibility: { kind: "all" as const },
        params,
        newId,
        reads: readBufferOf(store),
      };
      receipt = (await store.write(
        (tx): Promise<unknown> =>
          s.k === "resolve" ? resolveInTx(tx, input) : writeInTx(tx, input),
      )) as Receipt;
    } catch (e) {
      // A request the pipeline refuses leaves nothing: its transaction is rolled back.
      if (!(e instanceof WriteError)) throw e;
      hit.not++;
      continue;
    } finally {
      // The read log is local state, not replayed: what the request read is dropped.
      readBufferOf(store).take();
    }
    // A stale update is saved as a candidate, its item open: "pending".
    const done = s.k === "resolve" ? "resolved" : s.k === "run.stale" ? "pending" : "saved";
    if (receipt.status !== done) {
      hit.not++;
      continue;
    }
    hit.saved++;
    if (s.k === "resolve") {
      // Closed: no longer one to decide on. A decision that writes moves its row's `ver`, and the
      // run's next update is judged on the `ver` it holds (a candidate, or refused), as any other.
      items.splice(items.indexOf(item as (typeof items)[number]), 1);
      continue;
    }
    if (s.k === "run.stale") {
      for (const p of receipt.pending ?? []) {
        if (p.item_ver === undefined) continue;
        const known = items.find((x) => x.id === p.id);
        if (known) known.ver = p.item_ver;
        else items.push({ id: p.id, ver: p.item_ver });
      }
    }
    const first = receipt.ops[0] as Receipt["ops"][number];
    if (s.k === "run")
      runs.push({
        id: first.target.row as string,
        first: first.ver,
        ver: first.ver,
        op: receipt.seq,
      });
    else if (s.k === "shoe") shoes.push(first.target.row as string);
    else if (s.k === "budget") budgets.set(s.category, { amount: s.amount, from: s.from });
    else if (s.k === "room") rooms.push({ id: first.target.entity as string, ver: first.ver });
    else if (run) {
      run.ver = first.ver;
      if (s.k === "run.revoke") run.revoked = receipt.seq;
      else if (s.k === "run.restore") delete run.revoked;
    } else if (room) {
      room.ver = first.ver;
      if (s.k === "room.revoke") room.revoked = true;
    }
  }
  return reached;
}

// --- replay and comparison ---------------------------------------------------------------------

/** Gives the log of `from` to apply on the empty store `into`, from the first event. */
async function replay(from: TenantStore, into: TenantStore): Promise<number> {
  const events = await from.read((tx) => tx.query("SELECT * FROM events ORDER BY seq"));
  const content = await from.read((tx) => tx.query("SELECT * FROM content ORDER BY seq, path"));
  return into.write(async (tx) => {
    for (const [table, rs] of [
      ["events", events.rows],
      ["content", content.rows],
    ] as const) {
      for (const r of rs) {
        const cols = Object.keys(r as object);
        await tx.query(
          `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
          Object.values(r as object) as never,
        );
      }
    }
    const last = (await readTail(tx))?.seq ?? 0;
    await applyEvents(tx, await readEvents(tx, 1, last));
    return events.rows.length;
  });
}

const BY_NAME = new Map(KERNEL_TABLES.map((t) => [t.name, t]));
/** The catalog is compared by structure: not its profile and value samples (§8). */
const NOT_COMPARED: ReadonlyMap<string, readonly string[]> = new Map([
  ["catalog", ["profile", "samples"]],
]);

interface Compared {
  readonly columns: string[];
  readonly rows: string[];
}

/**
 * The tables §8 marks as compared: the kernel's materialized tables that are, and every table
 * apply made (business, version and derived tables). Each with its columns and its rows, as text.
 */
async function compared(tx: ReadTx): Promise<Map<string, Compared>> {
  const names = await tx.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const text = (_: string, v: unknown) =>
    typeof v === "bigint"
      ? `${v}n`
      : v instanceof Uint8Array
        ? `bytes:${Buffer.from(v).toString("hex")}`
        : v;
  const out = new Map<string, Compared>();
  for (const { tablename } of names.rows) {
    const kernel = BY_NAME.get(tablename);
    if (kernel !== undefined && !(kernel.class === "materialized" && kernel.reconciled)) continue;
    const left = NOT_COMPARED.get(tablename) ?? [];
    const columns = await tx.query<{
      column_name: string;
      data_type: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [tablename],
    );
    const rows = await tx.query<Record<string, unknown>>(`SELECT * FROM "${tablename}"`);
    out.set(tablename, {
      columns: columns.rows
        .filter((c) => !left.includes(c.column_name))
        .map(
          (c) =>
            `${c.column_name} ${c.data_type}(${c.numeric_precision ?? ""},${c.numeric_scale ?? ""}) ${c.is_nullable}`,
        ),
      rows: rows.rows
        .map((r) =>
          JSON.stringify(
            Object.fromEntries(Object.entries(r).filter(([k]) => !left.includes(k))),
            text,
          ),
        )
        .sort(),
    });
  }
  return out;
}

/** The compared tables empty on both sides in the fixed histories: this kernel writes none of them. */
const EMPTY = ["deletions", "external_keys", "migrations"];

const cell = testCell();
const pg = testPostgres(cell);

describe.skipIf(cell === undefined)("a log replayed on the other backend", () => {
  let schema: Schema;
  let root: string;
  let pglite: Reusable<TenantStore>;
  let postgres: Reusable<TenantStore>;

  beforeAll(async () => {
    await loadRsql();
    schema = slotSchema();
    root = mkdtempSync(join(tmpdir(), "saveslot-replay-across-"));
    pglite = await reusable<TenantStore>(
      await new PgliteBackend({ durability: TEST_DURABILITY }).open(
        { kind: "pglite", dir: join(root, "tenant") },
        { create: true },
      ),
    );
    postgres = await reusable<TenantStore>(
      await pg.backend.open(pg.ref(pg.name()), { create: true }),
    );
  }, 120_000);
  afterAll(async () => {
    await pglite?.store.close();
    await postgres?.store.close();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }, 120_000);

  type Seen = { samples: number; events: number; saved: number; derivedRows: number };
  const fresh = (): Seen => ({ samples: 0, events: 0, saved: 0, derivedRows: 0 });

  /** The history written on one backend and replayed on the other: the compared tables agree. */
  const check = async (
    steps: readonly Step[],
    written: Reusable<TenantStore>,
    replayed: Reusable<TenantStore>,
    seen: Seen = fresh(),
  ) => {
    await written.reset();
    await replayed.reset();
    const reached = await write(written.store, schema, steps);
    seen.events += await replay(written.store, replayed.store);
    const want = await written.store.read(compared);
    const got = await replayed.store.read(compared);
    // Table by table, so that a difference names its table.
    expect([...got.keys()]).toEqual([...want.keys()]);
    for (const [name, table] of want) expect({ [name]: got.get(name) }).toEqual({ [name]: table });
    seen.samples++;
    seen.saved += Object.values(reached).reduce((n, x) => n + x.saved, 0);
    seen.derivedRows += RULES.reduce(
      (n, [id]) => n + (want.get(`d_${id}_v1`)?.rows.length ?? 0),
      0,
    );
    return { reached, want };
  };

  const options = {
    numRuns: RUNS,
    ...(SEED !== undefined ? { seed: SEED } : {}),
    ...(process.env["PROP_PATH"] ? { path: process.env["PROP_PATH"], endOnFailure: true } : {}),
  };
  const history = fc.array(step, { minLength: 4, maxLength: 24 });

  /**
   * The random histories of one direction, then a guard against a generator gone degenerate (a
   * comparison of empty tables always agrees). Not when one counterexample is replayed.
   */
  const property = async (
    written: () => Reusable<TenantStore>,
    replayed: () => Reusable<TenantStore>,
  ) => {
    const seen = fresh();
    await fc.assert(
      fc.asyncProperty(history, async (steps) => {
        await check(steps, written(), replayed(), seen);
      }),
      options,
    );
    if (options.path !== undefined) return;
    expect(seen.samples).toBeGreaterThanOrEqual(RUNS);
    expect(seen.saved).toBeGreaterThan(2 * seen.samples);
    expect(seen.derivedRows).toBeGreaterThan(seen.samples);
  };

  it("written on PGlite, replayed on PostgreSQL: the compared tables are the same", async () => {
    await property(
      () => pglite,
      () => postgres,
    );
  });

  it("written on PostgreSQL, replayed on PGlite: the compared tables are the same", async () => {
    await property(
      () => postgres,
      () => pglite,
    );
  });

  // What a random history reaches only by chance: every kind of step, each one saved.
  const EVERY: readonly Step[] = [
    { k: "shoe", model: "𝄞 clef" },
    {
      k: "run",
      shoe: 0,
      cells: {
        date: "2026-11-01",
        distance: km("12345678.125"),
        duration: { value: "0.25", unit: "min" },
        feeling: "Straße",
        route: "river",
        laps: "9007199254740993",
        pace: "5.2505",
        started: "2026-10-25T02:30:00+01:00[Europe/Berlin]",
        race: true,
        uphill: { value: "1.005", unit: "mi" },
      },
    },
    {
      k: "run",
      shoe: null,
      cells: { date: "2026-11-09", distance: km("0.015"), race: true, laps: "3", feeling: "" },
    },
    { k: "run.update", n: 1, cells: { pace: "0.0005", feeling: "说", started: STARTED[4] } },
    { k: "run.update", n: 0, cells: { feeling: "a\tb\\c'd" } },
    { k: "run.revoke", n: 0 },
    { k: "run.restore", n: 0 },
    // Two conflict items: one resolved by taking its candidate, one left open (its flags stay).
    { k: "run.stale", n: 1, cells: { feeling: "ok" } },
    { k: "run.stale", n: 0, cells: { feeling: "ÀB a" } },
    { k: "resolve", n: 0, decision: "take_candidate" },
    { k: "expense", date: "2026-10-31", category: "书", amount: "12.345", note: "" },
    { k: "budget", category: "书", amount: "0.015", from: "2026-10-01" },
    { k: "budget", category: "书", amount: "99999999999.99", from: "2026-11-15" },
    { k: "budget.corroborate", category: "书" },
    { k: "room", guest: "ÀB a", from: "2026-11-05T00:00:00+08:00" },
    { k: "room.update", n: 0, guest: null, from: "2026-11-10T08:30:00.250Z" },
    { k: "room", guest: "ok", from: "2026-11-06T10:00:00+08:00" },
    { k: "room.revoke", n: 1 },
    // Run 1 rests on run 0's distance, run 0 on all of run 1 (the first marked changed); then
    // run 1's premises are cleared.
    { k: "premise", n: 1, m: 0, clear: false, wide: false },
    { k: "premise", n: 0, m: 1, clear: false, wide: true },
    { k: "premise", n: 1, m: 0, clear: true, wide: false },
  ];
  /** Every step saved, and rows in every compared table but those named in `EMPTY`. */
  const everySaved = ({ reached, want }: Awaited<ReturnType<typeof check>>) => {
    const kinds = [...new Set(EVERY.map((s) => s.k))];
    expect(Object.keys(reached).sort()).toEqual(kinds.sort());
    for (const k of kinds) expect({ [k]: reached[k]?.not }).toEqual({ [k]: 0 });
    const empty = [...want].filter(([, t]) => t.rows.length === 0).map(([name]) => name);
    expect(empty.sort()).toEqual([...EMPTY].sort());
    // A corroboration with its explicit ends is among the source table's rows: one item, with a
    // row for each of its sources (its value's and its interval's), every row the same ends.
    type Row = {
      event_seq: number;
      row_id: string;
      field_id: string;
      k: number;
      corroborated: boolean;
      corroboration_ends: string | null;
    };
    const corroborations = (want.get("base_sources")?.rows ?? [])
      .map((r) => JSON.parse(r) as Row)
      .filter((r) => r.corroborated);
    const items = new Set(
      corroborations.map((r) => JSON.stringify([r.event_seq, r.row_id, r.field_id, r.k])),
    );
    expect(items.size).toBe(1);
    expect([...new Set(corroborations.map((r) => r.corroboration_ends))]).toEqual([
      '["2026-11-15","2026-11-16"]',
    ]);
  };

  it("every kind of step, written on PGlite and replayed on PostgreSQL", async () => {
    everySaved(await check(EVERY, pglite, postgres));
  });

  it("every kind of step, written on PostgreSQL and replayed on PGlite", async () => {
    everySaved(await check(EVERY, postgres, pglite));
  });
});
