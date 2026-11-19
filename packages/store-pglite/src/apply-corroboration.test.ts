// Corroborations on a state table, applied (05-time «用同样的值写», «佐证端点»; 02-architecture §8
// `base_sources`): a corroboration's explicit ends are written once in `corroboration_ends`, the
// default end not among them; they are blocking points while they count, so a later interval
// resolved with a default end stops there and records the corroboration among its deps; a write
// covering the point, or a revert taking the corroboration back, stops it counting, and a revert
// of the covering write makes it count again. The column is never changed after it is written.
//
// The corroborations come from the record mapping's events (the write pipeline takes
// `evidence_by_field` later); the writes after them go through the pipeline.

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
  type NewEvent,
  type ReadTx,
  readBufferOf,
  readEvents,
  readTail,
} from "@fluxvita/saveslot-kernel";
import {
  asWritten,
  COMPILED_V1,
  createSlotEvents,
  eventsOfSteps,
  judged,
  type LoggedEvent,
  SLOT,
  shape,
  writeInTx,
} from "@fluxvita/saveslot-kernel/testing";
import type { LogEntry } from "@fluxvita/saveslot-reference";
import { STATE } from "@fluxvita/saveslot-reference/testing";
import { afterAll, describe, expect, it } from "vitest";
import type { PgliteTenantStore } from "./backend.ts";
import { testBackend } from "./testing/test-backend.fixture.ts";

const T = 60_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const ENTITY = `e_${"7".repeat(26)}`;

const fields = [
  { id: "f2", name: "b", type: "text", required: true, description: "b" },
  { id: "f3", name: "c", type: "text", description: "c" },
];
const COMPILED = {
  ...COMPILED_V1,
  tables: [
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
  },
};

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}, T);

const g = (value: string) => ({ mode: "given" as const, value: `2026-${value}` });
const write = (
  op: number,
  value: string,
  from: string,
  to: string | "next" | "open",
  more: { seen?: number; explicit?: boolean; c?: string; cExplicit?: true; ack?: true } = {},
): LogEntry =>
  ({
    kind: "write",
    op,
    event: op + 1,
    ...(more.seen !== undefined ? { seen: more.seen } : {}),
    valid: {
      from: g(from),
      to: to === "next" ? { mode: "next_change" } : to === "open" ? { mode: "open" } : g(to),
    },
    fields: {
      f2: { value, sources: [`S${op}`], ...(more.explicit ? { explicit: true } : {}) },
      ...(more.c !== undefined
        ? {
            f3: {
              value: more.c,
              sources: [`S${op}`],
              ...(more.cExplicit ? { explicit: true } : {}),
            },
          }
        : {}),
    },
    ...(more.ack ? { acknowledge: ["overwrite"] } : {}),
  }) as unknown as LogEntry;

/** A fresh tenant with the slot, and `ops` judged and applied operation by operation. */
async function applied(ops: LogEntry[]) {
  const root = mkdtempSync(join(tmpdir(), "saveslot-apply-corroboration-"));
  roots.push(root);
  const store = await testBackend().open(
    { kind: "pglite", dir: join(root, "tenant") },
    { create: true },
  );
  let minute = 0;
  const run = (events: NewEvent[]) =>
    store.write(async (tx) => {
      const now = `2026-11-10T05:${String(minute++).padStart(2, "0")}:00.000Z` as never;
      const op = await appendOperation(tx, { actor: USER as never, now, events });
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
      idempotency_window: 86_400_000,
      now: "2026-11-10T04:00:00.000Z",
      confirmation: null,
    }),
  );
  await run(createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }));
  const { steps } = judged(STATE, (ops as never[]).map(asWritten), []);
  const ctx = {
    table: "t2" as never,
    target: { entity: ENTITY as never },
    shape: shape(STATE),
    granularity: "date" as const,
  };
  const perStep: LoggedEvent[][] = eventsOfSteps(ctx, steps, (after, n) => after + 1 + n);
  for (const evs of perStep) {
    const head = evs[0]?.seq as number;
    for (let tail = (await store.read(readTail))?.seq ?? 0; tail < head - 1; tail++)
      await run([filler]);
    await run(evs.map((e) => ({ type: e.type as never, slot: SLOT, blocks: e.blocks as never })));
  }
  return store;
}

/** A request through the write pipeline; the error, if refused. */
async function send(store: PgliteTenantStore, params: unknown) {
  try {
    return (await store.write((tx) =>
      writeInTx(tx, {
        actor: USER as never,
        task: null,
        now: "2026-11-10T06:00:00.000Z",
        windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
        visibility: { kind: "all" },
        params,
        newId: () => `s_${"5".repeat(16)}`,
        reads: readBufferOf(store),
      }),
    )) as unknown as {
      seq: number;
      ops: { fields: Record<string, { result: string; after?: unknown; valid?: unknown }[]> }[];
    };
  } catch (e) {
    const x = e as { code?: string; detail?: unknown };
    if (x.code === undefined) throw e;
    throw new Error(`refused: ${x.code} ${JSON.stringify(x.detail)}`);
  }
}
const update = (ver: number, from: string, b: string, more: Record<string, unknown> = {}) => ({
  sv: 1,
  ops: [
    {
      intent: "update",
      table: "entities",
      entity: ENTITY,
      ver: `v${ver}.0`,
      valid_from: `2026-${from}`,
      set: { b },
      ...more,
    },
  ],
});

/** A corroboration's row in the source table: whether it is one and its explicit ends. */
const endsOf = async (store: PgliteTenantStore, event: number, field = "f2") =>
  (
    await store.read((tx) =>
      tx.query<{ k: number; corroborated: boolean; corroboration_ends: string | null }>(
        `SELECT k, corroborated, corroboration_ends FROM base_sources
         WHERE event_seq = $1 AND field_id = $2 ORDER BY k`,
        [event, field],
      ),
    )
  ).rows;
/** The explicit ends of every row an event wrote in the source table, whatever the field. */
const endsOfEvent = async (store: PgliteTenantStore, event: number) =>
  (
    await store.read((tx) =>
      tx.query<{ corroboration_ends: string | null }>(
        `SELECT corroboration_ends FROM base_sources WHERE event_seq = $1 ORDER BY field_id, k`,
        [event],
      ),
    )
  ).rows.map((r) => r.corroboration_ends);
/** A block of the `write.base` of an operation. */
const baseBlock = async (store: PgliteTenantStore, op: number, path: string) =>
  store.read(async (tx) => {
    const evs = await readEvents(tx, op, (await readTail(tx))?.seq ?? op);
    const base = evs.find((e) => e.header["type"] === "write.base");
    const b = base?.blocks.get(path);
    return b?.state === "present" ? b.value : undefined;
  });
/** The parts of `b` a receipt gives: value and interval. */
const parts = (r: Awaited<ReturnType<typeof send>>) =>
  (r.ops[0]?.fields["b"] ?? []).map((p) => ({ result: p.result, after: p.after, valid: p.valid }));
/** An interval as a receipt gives it on a table by day: the last day included too. */
const span = (from: string, to: string | null, last?: string) => ({
  valid_from: `2026-${from}`,
  valid_to: to === null ? null : `2026-${to}`,
  ...(last !== undefined ? { valid_to_inclusive: `2026-${last}` } : {}),
});
/** The entity's current version, from the version table (an undo's need not be its own number). */
const verNow = async (store: PgliteTenantStore) =>
  Number(
    (
      await store.read((tx) =>
        tx.query<{ v: unknown }>(
          `SELECT max(rec_from) AS v FROM "t_t2_v1__ver" WHERE row_id = $1 AND intent <> 'schema_switch'`,
          [ENTITY],
        ),
      )
    ).rows[0]?.v,
  );

const BASE = write(10, "5000", "10-01", "open");

describe("a corroboration's explicit ends are written once (05-time «佐证端点»)", () => {
  it(
    "the start and an explicit end; a default end, stopping at a real change, is not one",
    async () => {
      // b: 5000 from 10-01, 6000 from 11-15. #30 restates 5000 from 11-05 to the next change: its
      // interval ends at 11-15, a change point it did not say; #40 says 11-10 itself.
      const store = await applied([
        BASE,
        write(20, "6000", "11-15", "open", { seen: 10 }),
        write(30, "5000", "11-05", "next", { seen: 20, explicit: true }),
        write(40, "5000", "11-05", "11-10", { seen: 20, explicit: true }),
      ]);
      expect(await baseBlock(store, 30, "span/f2/0")).toMatchObject({
        valid: { from: "2026-11-05", to: "2026-11-15" },
      });
      expect(await endsOf(store, 31)).toEqual([
        { k: 0, corroborated: true, corroboration_ends: '["2026-11-05"]' },
      ]);
      expect(await endsOf(store, 41)).toEqual([
        { k: 0, corroborated: true, corroboration_ends: '["2026-11-05","2026-11-10"]' },
      ]);
      // No interval given: the pipeline writes "from now, to the next change"; now is the head's
      // `today`, the table being by day. The start is an end all the same.
      const fromNow = {
        ...(write(40, "5000", "11-05", "next", { seen: 10, explicit: true }) as object),
        valid: { from: { mode: "now" }, to: { mode: "next_change" } },
      };
      const store2 = await applied([BASE, fromNow as LogEntry]);
      const today = await store2.read(async (tx) => {
        const evs = await readEvents(tx, 40, 40);
        const ctx = evs[0]?.blocks.get("ctx");
        return ctx?.state === "present" ? (ctx.value as { today: string }).today : undefined;
      });
      expect(today).toMatch(/^2026-/);
      expect(await endsOf(store2, 41)).toEqual([
        { k: 0, corroborated: true, corroboration_ends: JSON.stringify([today]) },
      ]);
      // A write's own items: not a corroboration, no ends.
      expect(await endsOf(store, 11)).toEqual([
        { k: 0, corroborated: false, corroboration_ends: null },
      ]);
    },
    T,
  );

  it(
    "a write cut into items, a change in the middle: the first item has the start, the last the end",
    async () => {
      // b: 5000 from 10-01; #20 3000 over [11-08, 11-12). #30, seeing #10, restates 5000 over
      // [11-05, 11-20) with evidence pointed at: 5000 still on either side (corroborations), the
      // middle changed since (a candidate).
      const store = await applied([
        BASE,
        write(20, "3000", "11-08", "11-12", { seen: 10 }),
        write(30, "5000", "11-05", "11-20", { seen: 10, explicit: true }),
      ]);
      // The candidate (k 1) is not in effect: it has no row in the source table.
      expect(await endsOf(store, 31)).toEqual([
        { k: 0, corroborated: true, corroboration_ends: '["2026-11-05"]' },
        { k: 2, corroborated: true, corroboration_ends: '["2026-11-20"]' },
      ]);
    },
    T,
  );

  it(
    "a corroboration in the middle of a write: neither end bounds it, so an empty list",
    async () => {
      // b: 5000 from 10-01; 3000 over [11-01, 11-08) (#20) and over [11-12, 11-25) (#30). #40,
      // seeing #10, restates 5000 over [11-05, 11-20): candidates on either side, 5000 still over
      // [11-08, 11-12).
      const store = await applied([
        BASE,
        write(20, "3000", "11-01", "11-08", { seen: 10 }),
        write(30, "3000", "11-12", "11-25", { seen: 20 }),
        write(40, "5000", "11-05", "11-20", { seen: 10, explicit: true }),
      ]);
      // The candidates (k 0, 2) are not in effect: no rows.
      expect(await endsOf(store, 41)).toEqual([
        { k: 1, corroborated: true, corroboration_ends: "[]" },
      ]);
    },
    T,
  );
});

describe("a corroboration never awaits: no decision carries one out", () => {
  it(
    "in a write awaiting confirmation for another field, the corroboration takes effect at once, with the write's ends",
    async () => {
      // #30 erases #20's change points on b (high impact): b awaits; c restated with evidence
      // pointed at is a corroboration, in effect at once (it changes no value). #40 confirms b.
      // So in this version only a caller's write gives a corroboration (a deletion's restatement
      // comes later): none is carried out by a decision, whose items have no raw interval.
      const store = await applied([
        write(10, "5000", "10-01", "open", { c: "x" }),
        write(20, "6000", "11-05", "11-10", { seen: 10 }),
        write(30, "7000", "11-01", "11-20", { seen: 20, c: "x", cExplicit: true }),
        { kind: "confirm", op: 40, event: 41, target: 31 } as never,
      ]);
      expect(await endsOf(store, 31, "f3")).toEqual([
        { k: 0, corroborated: true, corroboration_ends: '["2026-11-01","2026-11-20"]' },
      ]);
      expect(await endsOf(store, 41, "f3")).toEqual([]);
      // A decision's items have no ends (apply gives none: no raw interval). Null today because
      // none is a corroboration; pinned so that this turns red if one ever becomes one.
      const confirmed = await endsOfEvent(store, 41);
      expect(confirmed.length).toBeGreaterThan(0);
      expect(confirmed.every((e) => e === null)).toBe(true);
    },
    T,
  );
});

describe("an end is a blocking point while it counts (05-time «用同样的值写»)", () => {
  // 05-time's example: base [10-01, ∞) 5000; A says "5000 from 11-20"; B writes 3000 from 11-02
  // with no end, from the same version.
  it(
    "A pointed at evidence: B stops at 11-20, and B's interval names A's corroboration among its deps",
    async () => {
      const store = await applied([
        BASE,
        write(20, "5000", "11-20", "next", { seen: 10, explicit: true }),
      ]);
      const b = await send(store, update(10, "11-02", "3000"));
      expect(parts(b)).toEqual([
        { result: "applied", after: "3000", valid: span("11-02", "11-20", "11-19") },
      ]);
      const deps = ((await baseBlock(store, b.seq, "span/f2/0")) as { deps?: unknown[] }).deps;
      expect(deps).toContainEqual({ event: 21, field: "f2", k: 0 });
    },
    T,
  );

  it(
    "A did not (a no-op): B runs to the end of time",
    async () => {
      const store = await applied([BASE, write(20, "5000", "11-20", "next", { seen: 10 })]);
      const b = await send(store, update(10, "11-02", "3000"));
      expect(parts(b)).toEqual([{ result: "applied", after: "3000", valid: span("11-02", null) }]);
    },
    T,
  );

  it(
    "a revoke with only a start stops there too, its interval's deps naming the corroboration",
    async () => {
      const store = await applied([
        BASE,
        write(20, "5000", "11-20", "next", { seen: 10, explicit: true }),
      ]);
      const r = await send(store, {
        sv: 1,
        ops: [
          {
            intent: "revoke",
            table: "entities",
            entity: ENTITY,
            ver: "v10.0",
            valid_from: "2026-11-02",
          },
        ],
      });
      const existence = (await baseBlock(store, r.seq, "span/existence/0")) as {
        valid: unknown;
        deps?: unknown[];
      };
      expect(existence.valid).toEqual({ from: "2026-11-02", to: "2026-11-20" });
      expect(existence.deps).toContainEqual({ event: 21, field: "f2", k: 0 });
    },
    T,
  );
});

describe("when an end stops counting, and counts again", () => {
  const A = write(20, "5000", "11-20", "next", { seen: 10, explicit: true });
  // A write of another value over [11-18, 11-25) covers 11-20.
  const COVER = write(30, "6000", "11-18", "11-25", { seen: 10 });

  it(
    "covered over by a later write: a default end passes it; the column is unchanged",
    async () => {
      const store = await applied([BASE, A, COVER]);
      const b = await send(store, update(30, "11-19", "7000"));
      expect(parts(b)).toEqual([
        { result: "applied", after: "7000", valid: span("11-19", "11-25", "11-24") },
      ]);
      expect(await endsOf(store, 21)).toEqual([
        { k: 0, corroborated: true, corroboration_ends: '["2026-11-20"]' },
      ]);
    },
    T,
  );

  it(
    "the covering write undone writes 5000 back over the point: covered again, a default end passes it",
    async () => {
      // The undo's write-back is a value item of its own over [11-18, 11-25): it covers 11-20 as
      // the write it takes back did (the reference evaluator gives the same). So writing once and
      // undoing differs from never writing; whether a write-back should cover is open (08 «P3 前»).
      const store = await applied([
        BASE,
        A,
        COVER,
        // Acknowledged with the current version: taken into effect, not awaiting.
        {
          kind: "undo",
          op: 40,
          event: 41,
          target: 30,
          seen: 30,
          acknowledge: ["overwrite"],
        } as never,
      ]);
      const b = await send(store, update(await verNow(store), "11-19", "7000"));
      expect(parts(b)).toEqual([{ result: "applied", after: "7000", valid: span("11-19", null) }]);
    },
    T,
  );

  it(
    "covered by a revoke, the revoke undone: the end counts again, and is among the deps",
    async () => {
      // An undo of a revoke writes back the entity's existence, no value: nothing covers 11-20.
      const store = await applied([
        BASE,
        A,
        {
          kind: "revoke",
          op: 30,
          event: 31,
          seen: 10,
          valid: { from: g("11-18"), to: g("11-25") },
          validSources: ["S30"],
        } as never,
        {
          kind: "undo",
          op: 40,
          event: 41,
          target: 30,
          seen: 30,
          acknowledge: ["overwrite"],
        } as never,
      ]);
      const b = await send(store, update(await verNow(store), "11-19", "7000"));
      expect(parts(b)).toEqual([
        { result: "applied", after: "7000", valid: span("11-19", "11-20", "11-19") },
      ]);
      const deps = ((await baseBlock(store, b.seq, "span/f2/0")) as { deps?: unknown[] }).deps;
      expect(deps).toContainEqual({ event: 21, field: "f2", k: 0 });
      expect(await endsOf(store, 21)).toEqual([
        { k: 0, corroborated: true, corroboration_ends: '["2026-11-20"]' },
      ]);
    },
    T,
  );

  it(
    "a write over no value undone writes back no value, which covers nothing: the end counts again",
    async () => {
      // R revokes [11-18, 11-25), covering 11-20; C gives 6000 where R left no value. C undone
      // writes back no value (R still covers); R undone writes back existence. Neither write-back
      // gives a value on f2, so once both are taken back, 11-20 counts again.
      const store = await applied([
        BASE,
        A,
        {
          kind: "revoke",
          op: 30,
          event: 31,
          seen: 10,
          valid: { from: g("11-18"), to: g("11-25") },
          validSources: ["S30"],
        } as never,
        write(40, "6000", "11-18", "11-25", { seen: 30 }),
        {
          kind: "undo",
          op: 50,
          event: 51,
          target: 40,
          seen: 40,
          acknowledge: ["overwrite"],
        } as never,
        {
          kind: "undo",
          op: 60,
          event: 61,
          target: 30,
          seen: 50,
          acknowledge: ["overwrite"],
        } as never,
      ]);
      const b = await send(store, update(await verNow(store), "11-19", "7000"));
      expect(parts(b)).toEqual([
        { result: "applied", after: "7000", valid: span("11-19", "11-20", "11-19") },
      ]);
      const deps = ((await baseBlock(store, b.seq, "span/f2/0")) as { deps?: unknown[] }).deps;
      expect(deps).toContainEqual({ event: 21, field: "f2", k: 0 });
    },
    T,
  );

  it(
    "the corroboration taken back by an undo: a default end passes it; the column is unchanged",
    async () => {
      // A also changes c, so the write can be undone; the undo takes back its corroboration too.
      const AC = write(20, "5000", "11-20", "next", { seen: 10, explicit: true, c: "y" });
      const store = await applied([
        BASE,
        AC,
        {
          kind: "undo",
          op: 30,
          event: 31,
          target: 20,
          seen: 20,
          acknowledge: ["overwrite"],
        } as never,
      ]);
      const b = await send(store, update(await verNow(store), "11-02", "3000"));
      expect(parts(b)).toEqual([{ result: "applied", after: "3000", valid: span("11-02", null) }]);
      expect(await endsOf(store, 21)).toEqual([
        { k: 0, corroborated: true, corroboration_ends: '["2026-11-20"]' },
      ]);
      // A revert's write-backs have no ends either (only a caller's write or revoke has them);
      // likewise pinned for when a write-back can be a corroboration.
      const undone = await endsOfEvent(store, 31);
      expect(undone.length).toBeGreaterThan(0);
      expect(undone.every((e) => e === null)).toBe(true);
    },
    T,
  );
});

describe("replayed from an empty storage (K12)", () => {
  /** Every row of every materialized table and of the slot's tables. */
  async function everything(tx: ReadTx): Promise<Record<string, unknown[]>> {
    const out: Record<string, unknown[]> = {};
    const big = (_: string, v: unknown) => (typeof v === "bigint" ? String(v) : v);
    const all = (r: { rows: readonly unknown[] }) =>
      r.rows.map((x) => JSON.stringify(x, big)).sort();
    for (const t of KERNEL_TABLES.filter((t) => t.class === "materialized")) {
      out[t.name] = all(await tx.query(`SELECT * FROM ${t.name}`));
    }
    for (const t of ["t_t2_v1", "t_t2_v1__ver"]) {
      out[t] = all(await tx.query(`SELECT * FROM "${t}"`));
    }
    return out;
  }

  /**
   * The log of `store` copied into a fresh storage and applied from the first event; `removed`
   * blocks (seq, path) copied as a deletion leaves them: no body, removed by the last event.
   */
  async function replayed(store: PgliteTenantStore, removed: [number, string][] = []) {
    const root = mkdtempSync(join(tmpdir(), "saveslot-apply-corroboration-replay-"));
    roots.push(root);
    const replica = await testBackend().open(
      { kind: "pglite", dir: join(root, "tenant") },
      { create: true },
    );
    const events = await store.read((tx) => tx.query("SELECT * FROM events ORDER BY seq"));
    const content = await store.read((tx) => tx.query("SELECT * FROM content ORDER BY seq, path"));
    const last = (await store.read(readTail))?.seq ?? 0;
    await replica.write(async (tx) => {
      for (const [table, rs] of [
        ["events", events.rows],
        ["content", content.rows],
      ] as const) {
        for (const r0 of rs) {
          const r = { ...(r0 as Record<string, unknown>) };
          if (
            table === "content" &&
            removed.some(([seq, path]) => Number(r["seq"]) === seq && r["path"] === path)
          ) {
            Object.assign(r, { body: null, checksum: null, removed_by: last });
          }
          const cols = Object.keys(r);
          await tx.query(
            `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
            Object.values(r) as never,
          );
        }
      }
      await applyEvents(tx, await readEvents(tx, 1, last));
    });
    return replica;
  }

  // A corroboration (#20, ends 11-20), covered by a revoke (#30), the revoke undone (#40).
  const HISTORY: LogEntry[] = [
    BASE,
    write(20, "5000", "11-20", "next", { seen: 10, explicit: true }),
    {
      kind: "revoke",
      op: 30,
      event: 31,
      seen: 20,
      valid: { from: g("11-18"), to: g("11-25") },
      validSources: ["S30"],
    } as never,
    { kind: "undo", op: 40, event: 41, target: 30, seen: 30, acknowledge: ["overwrite"] } as never,
  ];

  it(
    "a log with a corroboration, and a write through the pipeline stopping at its end: the same tables",
    async () => {
      const store = await applied(HISTORY);
      await send(store, update(await verNow(store), "11-19", "7000"));
      expect(await endsOf(store, 21)).toEqual([
        { k: 0, corroborated: true, corroboration_ends: '["2026-11-20"]' },
      ]);
      const replica = await replayed(store);
      expect(await replica.read(everything)).toEqual(await store.read(everything));
    },
    T,
  );

  it(
    "the head's interval removed by a deletion: no ends (an empty list), never now; the rest the same",
    async () => {
      // The corroboration starts today (the heads' `today`, 11-05): were "now" put in for the
      // removed interval, it would bound the item and be written.
      const store = await applied([
        BASE,
        write(20, "5000", "11-05", "11-20", { seen: 10, explicit: true }),
      ]);
      expect(await endsOf(store, 21)).toEqual([
        { k: 0, corroborated: true, corroboration_ends: '["2026-11-05","2026-11-20"]' },
      ]);
      const replica = await replayed(store, [[20, "ops/0/valid"]]);
      expect(await endsOf(replica, 21)).toEqual([
        { k: 0, corroborated: true, corroboration_ends: "[]" },
      ]);
      const { base_sources: a, ...restA } = await replica.read(everything);
      const { base_sources: b, ...restB } = await store.read(everything);
      expect(restA).toEqual(restB);
      expect(a?.length).toBe(b?.length);
    },
    T,
  );
});
