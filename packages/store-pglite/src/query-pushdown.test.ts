// `query`'s first page pushed down to SQL (kernel read/query.ts `queryRowsPushed`; 04-contract §10
// `query`, "默认排序", §15): the cases query-pages.prop must not leave to chance. Each is held to
// the whole read (`full`), result and read recorded, page by page; and the pushed-down path is
// shown to be the one taken: one statement on the business table with ORDER BY and LIMIT, and
// none reading the table whole.
//
// Not here: a row whose event time is empty. The time field of an event table is required
// (03-data-model/07-schema-evolution.md), so no such row exists; nulls last are held by the order
// asked for on a field that may be empty.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  type ReadTx,
  write,
} from "@fluxvita/saveslot-kernel";
import { COMPILED_V1, createSlotEvents, queryInTx } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const NOW = "2026-11-15T04:00:00.000Z";

const COMPILED = {
  ...COMPILED_V1,
  tables: [
    {
      id: "t1",
      name: "spend",
      kind: "base",
      description: "events by day",
      time: { type: "event", field: "f1" },
      physical: { table: "t_t1_v1" },
      fields: [
        { id: "f1", name: "date", type: "date", required: true, description: "day" },
        { id: "f2", name: "note", type: "text", description: "free text" },
        { id: "f3", name: "pieces", type: "integer", description: "how many" },
      ],
    },
    {
      id: "t2",
      name: "budgets",
      kind: "base",
      description: "by the day",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t2_v1" },
      fields: [
        { id: "f1", name: "category", type: "text", required: true, description: "kind" },
        { id: "f2", name: "amount", type: "integer", description: "how much" },
      ],
    },
  ],
};
const CHANGES = [
  { target: { slot: true }, change: "create_slot" },
  ...COMPILED.tables.map((t) => ({ target: { table: t.id }, change: "add_table" })),
].map((c) => ({
  ...c,
  class: "create",
  compatible_with_old_writes: true,
  destructive: false,
  auto: true,
}));

let s: ReusableStore;
let minute = 0;
let key = 0;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-15T03:${String(minute++ % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
/** A write of the user's, each with a key of its own (two equal bodies would be one write). */
const w = (ops: unknown[]) =>
  write(s.store, ctx(), { sv: 1, idempotency_key: `k-${++key}`, ops }) as unknown as Promise<{
    readonly ops: readonly {
      readonly target: { readonly row?: string; readonly entity?: string };
    }[];
  }>;

/** The rows of `spend`, by ID: five on one day (ties on the time), others around it. */
const rows: string[] = [];
let revoked: string;

beforeAll(async () => {
  s = await openReusable("saveslot-query-pushdown-");
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
      now: "2026-11-15T00:00:00.000Z",
      confirmation: null,
    }),
  );
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-15T00:00:30.000Z" as never,
      events: createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }),
    });
    await applyEvents(tx, eventsOf(op));
  });
  const spend: Record<string, unknown>[] = [
    { date: "2026-11-03", note: "b", pieces: 1 },
    { date: "2026-11-03", pieces: 2 },
    { date: "2026-11-03", note: "a", pieces: 3 },
    { date: "2026-11-03", note: "c" },
    { date: "2026-11-03", pieces: 1 },
    { date: "2026-11-01", note: "a", pieces: 5 },
    { date: "2026-11-05", note: "z", pieces: 4 },
    { date: "2026-11-02", note: "y" },
  ];
  for (const set of spend)
    rows.push((await w([{ intent: "insert", table: "spend", set }])).ops[0]?.target.row as string);
  revoked = rows[7] as string;
  await w([{ intent: "revoke", table: "spend", row: revoked }]);
  const entity: Record<string, string> = {};
  for (const [category, amount] of [
    ["food", 100],
    ["rent", null],
    ["fun", 30],
  ] as const)
    entity[category] = (
      await w([
        {
          intent: "insert",
          table: "budgets",
          set: { category, ...(amount !== null ? { amount } : {}) },
          valid_from: "2026-11-01",
        },
      ])
    ).ops[0]?.target.entity as string;
  // food: the same value written again (merged when read over an interval), then a new one twice.
  for (const [amount, from] of [
    [100, "2026-11-03"],
    [150, "2026-11-05"],
    [150, "2026-11-07"],
  ] as const)
    await w([
      {
        intent: "update",
        table: "budgets",
        entity: entity["food"],
        set: { amount },
        valid_from: from,
      },
    ]);
  // rent: ten values in a row, none merged: more segments than a batch of a page of one.
  for (let d = 2; d <= 11; d++)
    await w([
      {
        intent: "update",
        table: "budgets",
        entity: entity["rent"],
        set: { amount: d },
        valid_from: `2026-11-${String(d).padStart(2, "0")}`,
      },
    ]);
}, T);

afterAll(async () => {
  await s?.close();
}, T);

/** A read transaction that keeps the statements sent through it. */
function recording(tx: ReadTx, sent: string[]): ReadTx {
  return {
    query: (sql, params) => {
      sent.push(sql);
      return tx.query(sql, params);
    },
  };
}

type Out = Awaited<ReturnType<typeof queryInTx>>;

/** One page both ways: pushed down (with the statements it sent) and as the whole read. */
async function both(
  params: Record<string, unknown>,
  batches?: { page?: number; count?: number },
): Promise<{ pushed: Out; full: Out; sent: string[] }> {
  const sent: string[] = [];
  const input = (full: boolean) => ({
    actor: USER as never,
    task: null,
    now: NOW as never,
    visibility: { kind: "all" } as const,
    params,
    read: "rd_0000000000000000" as never,
    ...(full ? { full: true as const } : {}),
    ...(!full && batches !== undefined ? { batches } : {}),
  });
  const pushed = await s.store.read((tx) => queryInTx(recording(tx, sent), input(false)));
  const full = await s.store.read((tx) => queryInTx(tx, input(true)));
  return { pushed, full, sent };
}

/** The statements that read the business table `t`: with a page's ORDER BY and LIMIT or not. */
const onTable = (sent: readonly string[], t: string) =>
  sent.filter((x) => x.includes(`FROM "${t}"`) && !x.includes("count(*)"));

/** Every page of a query, both ways, each pushed-down page equal to the whole read's. */
async function pages(params: Record<string, unknown>, batches?: { page?: number; count?: number }) {
  const out: Out[] = [];
  let position: string | undefined;
  for (let i = 0; i < 20; i++) {
    const { pushed, full } = await both(
      {
        ...params,
        ...(position !== undefined ? { position } : {}),
      },
      batches,
    );
    expect({ page: i, ...pushed }).toEqual({ page: i, ...full });
    out.push(pushed);
    position = pushed.result.next_position;
    if (position === undefined) break;
  }
  return out;
}

const ids = (o: Out) =>
  o.result.rows.map(
    (r) => (r as { row?: string; entity?: string }).row ?? (r as { entity?: string }).entity,
  );

describe("a first page pushed down to SQL", () => {
  it("is read in SQL, one page and one more, on an event table and a state table at a point", async () => {
    for (const [params, t] of [
      [{ table: "spend", limit: 2 }, "t_t1_v1"],
      [{ table: "budgets", valid_at: "2026-11-10", limit: 2 }, "t_t2_v1"],
    ] as const) {
      const { pushed, full, sent } = await both(params);
      expect(pushed).toEqual(full);
      const reads = onTable(sent, t);
      expect({ t, reads: reads.length }).toEqual({ t, reads: 1 });
      expect(reads[0]).toMatch(/ ORDER BY .* LIMIT \$\d+::bigint$/);
      expect(sent.some((x) => x.includes(`FROM "${t}"`) && x.includes("count(*)"))).toBe(true);
    }
  });

  it("streams a state table over an interval an entity at a time, merged rows whole across pages", async () => {
    const during = ["2026-11-01", null];
    for (const params of [
      { valid_during: during },
      { valid_during: during, coalesce: false },
      { valid_during: ["2026-11-04", "2026-11-08"], clip: true },
      { valid_during: during, where: [{ field: "valid_from", op: ">=", value: "2026-11-05" }] },
      { valid_during: during, fields: ["category"] },
    ])
      for (const limit of [1, 2, 3]) {
        const got = await pages({ table: "budgets", ...params, limit });
        expect(got.flatMap((o) => o.result.rows).length).toBe(got[0]?.result.total);
      }
    // Every statement on the table reads a batch in order: none reads it whole.
    const { sent } = await both({ table: "budgets", valid_during: during, limit: 1 });
    const reads = onTable(sent, "t_t2_v1");
    expect(reads.length).toBeGreaterThan(1);
    for (const x of reads) expect(x).toMatch(/ ORDER BY .* LIMIT \$\d+::bigint$/);
  });

  it("is not where it cannot be: over an interval with an order asked for, the table is read whole", async () => {
    const { pushed, full, sent } = await both({
      table: "budgets",
      valid_during: ["2026-11-01", null],
      order: [{ field: "amount", dir: "desc" }],
      limit: 2,
    });
    expect(pushed).toEqual(full);
    expect(onTable(sent, "t_t2_v1").some((x) => !x.includes("LIMIT"))).toBe(true);
  });

  it("breaks ties on the time by row ID, across a page boundary", async () => {
    const got = await pages({ table: "spend", limit: 2 });
    const order = got.flatMap(ids);
    // Newest first; the five rows of 2026-11-03 by row ID ascending; the revoked row left out.
    const tied = rows.slice(0, 5).sort();
    expect(order).toEqual([rows[6], ...tied, rows[5]]);
    expect(got[0]?.result.total).toBe(7);
  });

  it("breaks ties on a key asked for by the default keys, across page boundaries, both directions", async () => {
    // Five rows share the date asked for: the default keys (the time, then the row ID) order them,
    // and every limit here cuts through them.
    const tied = rows.slice(0, 5).sort();
    for (const dir of ["asc", "desc"] as const)
      for (const limit of [1, 2, 3]) {
        const got = await pages({ table: "spend", order: [{ field: "date", dir }], limit });
        const order = got.flatMap(ids);
        expect({ dir, limit, order }).toEqual({
          dir,
          limit,
          order: dir === "asc" ? [rows[5], ...tied, rows[6]] : [rows[6], ...tied, rows[5]],
        });
      }
  });

  it("gives a next position only when a row follows: limit 1, exactly the rows, one more", async () => {
    const one = await both({ table: "spend", limit: 1 });
    expect(one.pushed.result.rows).toHaveLength(1);
    expect(one.pushed.result.next_position).toBeDefined();
    const exactly = await both({ table: "spend", limit: 7 });
    expect(exactly.pushed.result.rows).toHaveLength(7);
    expect(exactly.pushed.result.next_position).toBeUndefined();
    const short = await both({ table: "spend", limit: 6 });
    expect(short.pushed.result.rows).toHaveLength(6);
    expect(short.pushed.result.next_position).toBeDefined();
    for (const x of [one, exactly, short]) expect(x.pushed).toEqual(x.full);
  });

  it("counts and gives revoked rows with include_revoked", async () => {
    const got = await pages({ table: "spend", include_revoked: true, limit: 3 });
    expect(got[0]?.result.total).toBe(8);
    expect(got.flatMap(ids)).toContain(revoked);
  });

  it("puts empty values last in the order asked for, ascending and descending", async () => {
    for (const dir of ["asc", "desc"] as const) {
      const got = await pages({ table: "spend", order: [{ field: "note", dir }], limit: 3 });
      const notes = got.flatMap((o) => o.result.rows.map((r) => r.values["note"] ?? null));
      const given = notes.filter((n) => n !== null);
      expect(notes.slice(given.length).every((n) => n === null)).toBe(true);
      expect(notes.slice(0, given.length).every((n) => n !== null)).toBe(true);
      expect(given).toEqual(dir === "asc" ? [...given].sort() : [...given].sort().reverse());
    }
    // A state table at a point, on a field some entities have empty.
    await pages({
      table: "budgets",
      valid_at: "2026-11-10",
      order: [{ field: "amount", dir: "desc" }],
      limit: 1,
    });
  });

  it("records as read the rows of the page only", async () => {
    const { pushed } = await both({ table: "spend", limit: 2 });
    const shown = ids(pushed);
    expect(shown).toHaveLength(2);
    const targets = pushed.entry.rows.map((r) => r.target);
    expect([...targets].sort()).toEqual([...shown].sort());
    // None of the rows after the page is among them.
    for (const r of rows) if (!shown.includes(r)) expect(targets).not.toContain(r);
  });
});

// The batches a state table over an interval is streamed in, set by the test (`batches`), so that
// where their boundaries fall does not hang on how the entity IDs sort. `budgets` here: `food` in
// four segments that merge into two rows (into one with only `category` read), `rent` in eleven of
// eleven values, `fun` in one.
describe("a state table over an interval streamed at batch boundaries the test sets", () => {
  const during = ["2026-11-01", null];
  /** How many segments `budgets` has: every one of them meets `during`. */
  const segments = async () =>
    Number(
      (
        await s.store.read((tx) =>
          tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM "t_t2_v1"`),
        )
      ).rows[0]?.n,
    );

  it("merges an entity whose segments lie across batches, read in one piece", async () => {
    // Batches of one, two and three segments: every entity of more than one crosses a boundary,
    // and with only `category` read each merges into one row, whatever the order of the IDs.
    for (const page of [1, 2, 3])
      for (const limit of [1, 2, 3]) {
        const got = await pages(
          { table: "budgets", valid_during: during, fields: ["category"], limit },
          { page },
        );
        expect({ page, limit, rows: got.flatMap(ids).length }).toEqual({ page, limit, rows: 3 });
      }
  });

  it("reads an entity larger than a batch, and ends a stream on a full batch", async () => {
    const n = await segments();
    expect(n).toBeGreaterThan(11);
    // Batches of two: `rent` (eleven segments) spans six. Batches of every segment and of one
    // less: the stream's last batch full, the next one empty; or one segment over.
    for (const page of [2, n, n - 1])
      for (const limit of [1, 3, 200])
        await pages({ table: "budgets", valid_during: during, limit }, { page });
  });

  it("gives the page's rows from the entity it stops on, the page ending within it", async () => {
    // Only `rent`: the page and the row after it both come from the entity the stream stops on.
    for (const limit of [1, 5, 10])
      await pages(
        {
          table: "budgets",
          valid_during: during,
          where: [{ field: "category", op: "=", value: "rent" }],
          limit,
        },
        { page: 2 },
      );
  });

  it("counts across more than one count batch", async () => {
    const n = await segments();
    for (const count of [1, 2, 3, n - 1, n])
      for (const fields of [undefined, ["category"]]) {
        const params = {
          table: "budgets",
          valid_during: during,
          ...(fields !== undefined ? { fields } : {}),
          limit: 1,
        };
        const { pushed, full } = await both(params, { count });
        expect({ count, fields, total: pushed.result.total }).toEqual({
          count,
          fields,
          total: full.result.total,
        });
        expect(pushed).toEqual(full);
      }
  });

  it("reads each batch after the last segment by a row comparison on the primary key", async () => {
    const { sent } = await both({ table: "budgets", valid_during: during, limit: 1 }, { page: 1 });
    const later = onTable(sent, "t_t2_v1").filter((x) => x.includes("ROW("));
    expect(later.length).toBeGreaterThan(0);
    for (const x of later) expect(x).toMatch(/ROW\(entity_id, valid_from\) > ROW\(/);
    // The count reads the columns of the fields read only.
    const counted = await both(
      { table: "budgets", valid_during: during, fields: ["category"], limit: 1 },
      { count: 2 },
    );
    const statements = onTable(counted.sent, "t_t2_v1").filter((x) => !x.includes("c_f2_"));
    expect(statements.length).toBeGreaterThan(0);
  });

  // Last in the file: it writes into the shared data.
  it("gives the marks of the entity the stream stops on, as the whole read does", async () => {
    // Only `rent`: the entity the stream stops on, and the last of the page. One page holds all
    // its rows, so that the rows with a mark are on the page read streamed (a later page is read
    // whole).
    const params = {
      table: "budgets",
      valid_during: during,
      where: [{ field: "category", op: "=", value: "rent" }],
      limit: 20,
    };
    const rent = ids((await both(params)).full)[0] as string;
    // A correction of a stretch `rent` has, written without reading it: an item waits on it, and
    // its rows there carry the item's mark, which the facts give.
    await w([
      {
        intent: "correct",
        table: "budgets",
        entity: rent,
        set: { amount: 77 },
        valid_from: "2026-11-06",
        valid_to: "2026-11-08",
      },
    ]);
    for (const page of [2, 4, 200]) {
      const got = await pages(params, { page });
      expect(got).toHaveLength(1);
      expect(got[0]?.result.rows.some((r) => r.marks !== undefined)).toBe(true);
    }
  });
});
