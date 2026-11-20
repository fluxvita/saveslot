// The explicit ends apply writes for a corroboration (02-architecture §8 `base_sources`
// `corroboration_ends`; 09-event-format §5.7 «佐证端点»; 05-time «佐证端点»), wired request by
// request: each op its own `ops/<i>/valid`, `today` or `now` by the table's granularity, an end
// given without a start, a correction's span, every source's row, and none on a table without
// business time. Requests are judged by judge and encoded by the record mapping, one write.head
// per request (several ops in one), then applied on storage. A write cut into several items (which
// takes a conflict): apply-corroboration.test.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  type JudgeInput,
  type NewEvent,
  readTail,
  replay,
} from "@fluxvita/saveslot-kernel";
import {
  COMPILED_V1,
  createSlotEvents,
  eventsOfRequest,
  SLOT,
} from "@fluxvita/saveslot-kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { PgliteTenantStore } from "./backend.ts";
import { testBackend } from "./testing/test-backend.fixture.ts";

const T = 60_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const ENTITY = `e_${"7".repeat(26)}`;
const ROW = `r_${"6".repeat(26)}`;
const FILLER = `e_${"9".repeat(26)}`;

const text = [
  { id: "f2", name: "b", type: "text", required: true, description: "b" },
  { id: "f3", name: "c", type: "text", description: "c" },
];
const table = (id: string, name: string, time: object, fields: object[] = text) => ({
  id,
  name,
  kind: "base",
  description: name,
  time,
  physical: { table: `t_${id}_v1` },
  fields,
});
const COMPILED = {
  ...COMPILED_V1,
  tables: [
    table("t2", "by_day", { type: "state", granularity: "date" }),
    table("t3", "by_instant", { type: "state", granularity: "instant" }),
    table("t4", "happenings", { type: "event", field: "f1" }, [
      { id: "f1", name: "on", type: "date", required: true, description: "the day" },
      ...text,
    ]),
    table("t5", "timeless", { type: "none" }),
  ],
};
const CHANGES = [
  { target: { slot: true }, change: "create_slot" },
  ...["t2", "t3", "t4", "t5"].map((t) => ({ target: { table: t }, change: "add_table" })),
].map((c) => ({
  ...c,
  class: "create",
  compatible_with_old_writes: true,
  destructive: false,
  auto: true,
}));

const STATE_SHAPE = {
  kind: "state" as const,
  fields: ["f2", "f3"],
  valued: ["f2"],
  required: ["f2"],
  groups: [],
};
type Table = "t2" | "t3" | "t4" | "t5";
const ctxOf = (t: Table) => {
  const isState = t === "t2" || t === "t3";
  return {
    table: t as never,
    target: isState ? { entity: ENTITY as never } : { row: ROW as never },
    shape: (t === "t4"
      ? { ...STATE_SHAPE, kind: "event", fields: ["f1", "f2", "f3"], required: ["f1", "f2"] }
      : t === "t5"
        ? { ...STATE_SHAPE, kind: "timeless" }
        : STATE_SHAPE) as never,
    granularity: t === "t3" ? ("instant" as const) : ("date" as const),
  };
};

/**
 * The stores a case opened and their directories: closed and removed when the case ends, so that
 * one case's stores are open at a time (a PGlite instance each: kept open, a file of them holds
 * gigabytes).
 */
const opened: { readonly root: string; store?: { close(): Promise<void> } }[] = [];
afterEach(async () => {
  for (const o of opened.splice(0)) {
    await o.store?.close();
    rmSync(o.root, { recursive: true, force: true });
  }
}, T);

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

const d = (md: string) => `2026-${md}`;
const given = (value: string) => ({ mode: "given" as const, value });
/** A caller's write: `seen` its version, `valid` as the head records it (state tables). */
const write = (
  op: number,
  fields: Record<string, string>,
  more: {
    index?: number;
    seen?: number;
    valid?: unknown;
    now?: string;
    explicit?: readonly string[];
  } = {},
): JudgeInput => {
  const index = more.index ?? 0;
  return {
    kind: "write",
    op,
    index,
    event: op + 1 + index,
    ruleset: 1,
    seen: more.seen ?? op - 1,
    seenExplicit: more.seen !== undefined,
    ...(more.valid !== undefined ? { valid: more.valid } : {}),
    now: more.now ?? d("11-10"),
    fields: Object.fromEntries(
      Object.entries(fields).map(([f, value]) => [
        f,
        { value, ...(more.explicit?.includes(f) ? { explicit: true } : {}) },
      ]),
    ),
  } as JudgeInput;
};

/**
 * A fresh tenant with the slot; then each request (its ops, in order; its sources, by default its
 * own number) judged on the table's row and applied. Returns the store and the judgements.
 */
async function requests(
  t: Table,
  reqs: readonly { readonly ops: readonly JudgeInput[]; readonly sources?: readonly number[] }[],
) {
  const root = mkdtempSync(join(tmpdir(), "saveslot-corroboration-ends-"));
  const at = { root } as (typeof opened)[number];
  opened.push(at);
  const store = await testBackend().open(
    { kind: "pglite", dir: join(root, "tenant") },
    { create: true },
  );
  at.store = store;
  let minute = 0;
  const run = (events: NewEvent[]) =>
    store.write(async (tx) => {
      const now = `2026-11-10T05:${String(minute++).padStart(2, "0")}:00.000Z` as never;
      const op = await appendOperation(tx, { actor: USER as never, now, events });
      await applyEvents(tx, eventsOf(op));
      return op;
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
  const ctx = ctxOf(t);
  const all = reqs.flatMap((r) => r.ops);
  const { judgements } = replay(ctx.shape, all);
  let n = 0;
  for (const [k, r] of reqs.entries()) {
    const js = judgements.slice(n, n + r.ops.length);
    n += r.ops.length;
    const evs = eventsOfRequest(ctx, r.ops, js, k === 0 ? "insert" : "update", r.sources);
    const head = evs[0]?.seq as number;
    for (let tail = (await store.read(readTail))?.seq ?? 0; tail < head - 1; tail++) {
      await run([filler]);
    }
    const op = await run(
      evs.map((e) => ({ type: e.type as never, slot: SLOT, blocks: e.blocks as never })),
    );
    expect(op.events.map((e) => e.seq)).toEqual(evs.map((e) => e.seq));
  }
  return { store, judgements };
}

/** The source table's rows of an event: its items, each source's row, and their ends. */
const rowsOf = async (store: PgliteTenantStore, event: number) =>
  (
    await store.read((tx) =>
      tx.query<{
        field_id: string;
        k: number;
        n: number;
        corroborated: boolean;
        corroboration_ends: string | null;
      }>(
        `SELECT field_id, k, n, corroborated, corroboration_ends FROM base_sources
         WHERE event_seq = $1 ORDER BY field_id COLLATE "C", k, n`,
        [event],
      ),
    )
  ).rows;

const ends = (...ps: string[]) => JSON.stringify(ps);
/** The items of the `n`th op as judge recorded them. */
const itemsOf = (js: readonly { record: unknown }[], n: number) =>
  (js[n]?.record as { items?: { status: string; valid: unknown }[] } | undefined)?.items ?? [];

describe("each op, each source: its own ends", () => {
  it(
    "two ops of one request: each corroboration has the ends of its own op's interval",
    async () => {
      const { store } = await requests("t2", [
        {
          ops: [
            write(
              10,
              { f2: "5000", f3: "x" },
              { valid: { from: given(d("10-01")), to: { mode: "open" } } },
            ),
          ],
        },
        {
          ops: [
            write(
              20,
              { f2: "5000" },
              {
                seen: 10,
                valid: { from: given(d("11-01")), to: given(d("11-10")) },
                explicit: ["f2"],
              },
            ),
            write(
              20,
              { f3: "x" },
              {
                index: 1,
                seen: 10,
                valid: { from: given(d("11-03")), to: given(d("11-15")) },
                explicit: ["f3"],
              },
            ),
          ],
        },
      ]);
      expect(await rowsOf(store, 21)).toEqual([
        {
          field_id: "f2",
          k: 0,
          n: 0,
          corroborated: true,
          corroboration_ends: ends(d("11-01"), d("11-10")),
        },
      ]);
      expect(await rowsOf(store, 22)).toEqual([
        {
          field_id: "f3",
          k: 0,
          n: 0,
          corroborated: true,
          corroboration_ends: ends(d("11-03"), d("11-15")),
        },
      ]);
    },
    T,
  );

  it(
    "an item with two sources: every source's row has the same ends",
    async () => {
      const { store } = await requests("t2", [
        {
          ops: [
            write(10, { f2: "5000" }, { valid: { from: given(d("10-01")), to: { mode: "open" } } }),
          ],
        },
        {
          ops: [
            write(
              20,
              { f2: "5000" },
              {
                seen: 10,
                valid: { from: given(d("11-01")), to: given(d("11-10")) },
                explicit: ["f2"],
              },
            ),
          ],
          sources: [3, 4],
        },
      ]);
      const both = ends(d("11-01"), d("11-10"));
      expect(await rowsOf(store, 21)).toEqual([
        { field_id: "f2", k: 0, n: 0, corroborated: true, corroboration_ends: both },
        { field_id: "f2", k: 0, n: 1, corroborated: true, corroboration_ends: both },
      ]);
    },
    T,
  );
});

describe("the interval as written", () => {
  const base = {
    ops: [write(10, { f2: "5000" }, { valid: { from: given(d("10-01")), to: { mode: "open" } } })],
  };

  it(
    "an end given without a start: the start is now (the head's today), and the end is kept",
    async () => {
      const { store } = await requests("t2", [
        base,
        {
          ops: [
            write(
              20,
              { f2: "5000" },
              {
                seen: 10,
                valid: { from: { mode: "now" }, to: given(d("11-20")) },
                explicit: ["f2"],
              },
            ),
          ],
        },
      ]);
      expect((await rowsOf(store, 21))[0]?.corroboration_ends).toBe(ends(d("11-10"), d("11-20")));
    },
    T,
  );

  it(
    "a correction's span (no interval given) starting today: no ends, an empty list",
    async () => {
      // b: 5000 from 10-01, 6000 from 11-10 (today). The span containing now is [11-10, ∞): a
      // correction restating 6000 there corroborates it, and its interval was not given.
      const { store, judgements } = await requests("t2", [
        base,
        {
          ops: [
            write(
              20,
              { f2: "6000" },
              { seen: 10, valid: { from: given(d("11-10")), to: { mode: "open" } } },
            ),
          ],
        },
        {
          ops: [write(30, { f2: "6000" }, { seen: 20, valid: "corrected_span", explicit: ["f2"] })],
        },
      ]);
      expect(itemsOf(judgements, 2)).toMatchObject([
        { status: "corroborated", valid: [{ from: d("11-10"), to: null }] },
      ]);
      expect((await rowsOf(store, 31))[0]?.corroboration_ends).toBe("[]");
    },
    T,
  );

  it(
    "a table by the instant: the start given, and now as the head's instant, not its date",
    async () => {
      const at = (s: string) => `2026-${s}.000Z`;
      const NOW = at("11-10T05:00:00");
      const { store } = await requests("t3", [
        {
          ops: [
            write(
              10,
              { f2: "5000" },
              { valid: { from: given(at("10-01T00:00:00")), to: { mode: "open" } }, now: NOW },
            ),
          ],
        },
        {
          ops: [
            write(
              20,
              { f2: "5000" },
              {
                seen: 10,
                valid: { from: given(at("11-05T08:30:00")), to: given(at("11-08T00:00:00")) },
                now: NOW,
                explicit: ["f2"],
              },
            ),
          ],
        },
        {
          ops: [
            write(
              30,
              { f2: "5000" },
              {
                seen: 20,
                valid: { from: { mode: "now" }, to: given(at("11-20T00:00:00")) },
                now: NOW,
                explicit: ["f2"],
              },
            ),
          ],
        },
      ]);
      expect((await rowsOf(store, 21))[0]?.corroboration_ends).toBe(
        ends(at("11-05T08:30:00"), at("11-08T00:00:00")),
      );
      expect((await rowsOf(store, 31))[0]?.corroboration_ends).toBe(
        ends(NOW, at("11-20T00:00:00")),
      );
    },
    T,
  );
});

describe("a table without business time: a corroboration, with no ends (null)", () => {
  it.each([
    ["an event table", "t4", { f1: d("11-05"), f2: "5000" }],
    ["a timeless table", "t5", { f2: "5000" }],
  ] as const)(
    "%s",
    async (_, t, first) => {
      const { store, judgements } = await requests(t, [
        { ops: [write(10, first)] },
        { ops: [write(20, { f2: "5000" }, { seen: 10, explicit: ["f2"] })] },
      ]);
      expect(itemsOf(judgements, 1).map((x) => x.status)).toEqual(["corroborated"]);
      expect(await rowsOf(store, 21)).toEqual([
        { field_id: "f2", k: 0, n: 0, corroborated: true, corroboration_ends: null },
      ]);
    },
    T,
  );
});
