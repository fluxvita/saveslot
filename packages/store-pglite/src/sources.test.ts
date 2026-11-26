// `sources` against a stored tenant (04-contract «sources»; 04-contract-types §4.6): what a source
// produced in the tables the caller sees only; `correction` on a source a correction took a value
// from; a removed source failing the call that reads it, its content given nowhere; a
// search that looks at a bounded number of sources a call and pages on; and the read record, which
// keeps the mode and IDs but never the search text.

import {
  appendOperation,
  applyEvents,
  compileNewSlot,
  createOpsContext,
  createTenant,
  eventsOf,
  flushReads,
  loadRsql,
  sources,
  sourcesInTx,
  write,
} from "@fluxvita/saveslot-kernel";
import { createSlotEvents, SLOT } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

const DOCUMENT = {
  slot: "ledger",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: "lunch",
      kind: "base",
      description: "one row per lunch",
      time: { type: "none" },
      fields: [
        { name: "note", type: "text", required: true, description: "what" },
        { name: "amount", type: "integer", description: "how much" },
      ],
    },
    {
      name: "secret",
      kind: "base",
      description: "a table some credentials do not see",
      time: { type: "none" },
      fields: [{ name: "body", type: "text", description: "the text" }],
    },
  ],
};

let s: ReusableStore;
let minute = 0;
let lunchTable = "";
type Visibility = Parameters<typeof sourcesInTx>[1]["visibility"];
const ctx = (visibility: Visibility = { kind: "all" }) =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility,
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T03:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });

async function refusal(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await run();
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown>; message?: string };
    if (x.code === undefined) throw e;
    return { code: x.code, message: x.message, ...(x.detail ?? {}) };
  }
  throw new Error("not refused");
}

/** A write with one user message as its evidence; the receipt. */
const said = (text: string, ops: unknown[]) =>
  write(s.store, ctx(), {
    sv: 1,
    evidence: [{ kind: "user_message", text }],
    ops,
  }) as unknown as Promise<{ seq: number; ops: { target: { row: string }; ver: string }[] }>;

type Listed = {
  sources: { id: string; excerpt?: string; correction?: true }[];
  next_position?: string;
};
const list = (params: Record<string, unknown>, visibility?: Visibility) =>
  sources(s.store, ctx(visibility), params) as unknown as Promise<Listed>;

beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-sources-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
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
  const compiled = compileNewSlot({
    document: structuredClone(DOCUMENT),
    slotId: SLOT,
    nextTableNumber: 1,
    nextRuleNumber: 1,
    existingSlotNames: [],
  });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
  lunchTable = (
    compiled.compiled as unknown as { tables: { id: string; name: string }[] }
  ).tables.find((t) => t.name === "lunch")?.id as string;
  const events = createSlotEvents({
    compiled: compiled.compiled as never,
    changes: compiled.changes as never,
  });
  (events[0] as { blocks: Record<string, unknown> }).blocks["draft"] = structuredClone(DOCUMENT);
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-05T00:00:30.000Z" as never,
      events,
    });
    await applyEvents(tx, eventsOf(op));
  });
}, T);

describe("a slot the caller sees only in part", () => {
  it(
    "has no sources for it in any mode: list and search find none, get is the not_found of a source that does not exist",
    async () => {
      await said("noodles, 18, and something else", [
        { intent: "insert", table: "ledger.lunch", set: { note: "noodles", amount: 18 } },
        { intent: "insert", table: "ledger.secret", set: { body: "hush" } },
      ]);
      const id = (await list({ limit: 1 })).sources[0]?.id as string;
      const all = (await sources(s.store, ctx(), { mode: "get", id })) as unknown as {
        produced: { target: { table: string } }[];
      };
      expect(all.produced.map((p) => p.target.table).sort()).toEqual([
        "ledger.lunch",
        "ledger.secret",
      ]);
      const lunchOnly: Visibility = {
        kind: "scoped",
        slots: [{ slot: SLOT as never, tables: [{ table: lunchTable as never }] }],
      };
      expect((await list({}, lunchOnly)).sources).toEqual([]);
      // Named, the slot is there; none of its sources are.
      expect((await list({ slot: "ledger" }, lunchOnly)).sources).toEqual([]);
      expect((await list({ mode: "search", q: "noodles" }, lunchOnly)).sources).toEqual([]);
      const hidden = await refusal(() => sources(s.store, ctx(lunchOnly), { mode: "get", id }));
      const none = await refusal(() =>
        sources(s.store, ctx(lunchOnly), { mode: "get", id: `s_${"0".repeat(16)}` }),
      );
      expect(hidden).toMatchObject({ code: "not_found", reason: "source" });
      expect(JSON.stringify(hidden)).toBe(JSON.stringify(none));
      // The whole slot: as the user session.
      const whole: Visibility = { kind: "scoped", slots: [{ slot: SLOT as never }] };
      expect((await list({}, whole)).sources.map((x) => x.id)).toContain(id);
    },
    T,
  );
});

describe("a correction's sources", () => {
  it(
    "the source a correct write took its value from is marked; the first one is not",
    async () => {
      const first = await said("noodles, 18", [
        { intent: "insert", table: "ledger.lunch", set: { note: "noodles", amount: 18 } },
      ]);
      const row = first.ops[0]?.target.row as string;
      await said("no, it was 21", [
        {
          intent: "correct",
          table: "ledger.lunch",
          row,
          ver: first.ops[0]?.ver,
          set: { amount: 21 },
        },
      ]);
      const listed = (await list({})).sources.filter((x) => x.excerpt !== undefined);
      expect(listed.map((x) => [x.excerpt, x.correction === true])).toEqual([
        ["no, it was 21", true],
        ["noodles, 18", false],
      ]);
    },
    T,
  );
});

// A source pending deletion through a real deletion: sources-pending.test.ts.
describe("a removed source", () => {
  it(
    "fails only the call that reads it (not in this version); the others read as ever, its text nowhere",
    async () => {
      const text = "do not show this line";
      await said(text, [{ intent: "insert", table: "ledger.lunch", set: { note: "x" } }]);
      const id = (await list({ limit: 1 })).sources[0]?.id as string;
      // Set by hand: this version carries no deletion out.
      await s.store.write((tx) =>
        tx.query("UPDATE sources SET deletion_state = 'removed' WHERE source_id = $1", [
          id,
        ] as never),
      );
      await said("another line", [{ intent: "insert", table: "ledger.lunch", set: { note: "y" } }]);
      // Reading it: refused, nothing of it given.
      for (const params of [{ mode: "get", id }, {}, { to: "2100-01-01T00:00:00Z" }]) {
        const e = await refusal(() => sources(s.store, ctx(), params));
        expect(e).toMatchObject({ code: "internal", reason: "not_implemented" });
        expect(JSON.stringify(e)).not.toContain(text);
      }
      // Not reading it: as ever. A list of one (the newer source), and a search by its words.
      const one = await list({ limit: 1 });
      expect(one.sources.map((x: { id: string }) => x.id)).not.toContain(id);
      const found = (await sources(s.store, ctx(), { mode: "search", q: "line" })) as unknown as {
        sources: { id: string; excerpt?: string }[];
      };
      expect(found.sources.map((x) => x.excerpt)).toEqual(["another line"]);
      expect(JSON.stringify(found)).not.toContain(text);
    },
    T,
  );

  it(
    "pending by its state but listed by no pending deletion: internal, nothing of it given",
    async () => {
      const text = "do not show this either";
      await said(text, [{ intent: "insert", table: "ledger.lunch", set: { note: "x" } }]);
      const id = (await list({ limit: 1 })).sources[0]?.id as string;
      await s.store.write((tx) =>
        tx.query("UPDATE sources SET deletion_state = 'pending_deletion' WHERE source_id = $1", [
          id,
        ] as never),
      );
      for (const params of [{ mode: "get", id }, {}]) {
        const e = await refusal(() => sources(s.store, ctx(), params));
        expect(e).toMatchObject({ code: "internal" });
        expect(JSON.stringify(e)).not.toContain(text);
      }
      expect(
        JSON.stringify(await sources(s.store, ctx(), { mode: "search", q: "either" })),
      ).not.toContain(text);
    },
    T,
  );
});

describe("a search looks at a bounded number of sources a call", () => {
  it(
    "a page cut by the scan gives the next one; together, every match, newest first, once",
    async () => {
      for (const [i, text] of ["match 1", "other 2", "match 3", "other 4", "match 5"].entries()) {
        await said(text, [{ intent: "insert", table: "ledger.lunch", set: { note: `n${i}` } }]);
      }
      const page = (position?: string) =>
        s.store.read((tx) =>
          sourcesInTx(tx, {
            actor: USER,
            task: null,
            now: "2026-11-05T05:00:00.000Z",
            visibility: { kind: "all" },
            params: {
              mode: "search",
              q: "MATCH",
              limit: 10,
              ...(position !== undefined ? { position } : {}),
            },
            read: `rd_${"A".repeat(16)}`,
            scanLimit: 3,
          }),
        ) as unknown as Promise<{ result: Listed }>;
      const seen: string[] = [];
      let position: string | undefined;
      let pages = 0;
      do {
        const { result } = await page(position);
        seen.push(...result.sources.map((x) => x.excerpt as string));
        // At most 3 looked at: never all three matches on one page.
        expect(result.sources.length).toBeLessThan(3);
        position = result.next_position;
        pages += 1;
      } while (position !== undefined && pages < 10);
      expect(seen).toEqual(["match 5", "match 3", "match 1"]);
      expect(pages).toBeGreaterThan(1);
    },
    T,
  );
});

describe("the read record", () => {
  it(
    "keeps the mode, never the search text",
    async () => {
      await said("a phrase to find", [
        { intent: "insert", table: "ledger.lunch", set: { note: "x" } },
      ]);
      await list({ mode: "search", q: "phrase to find" });
      await flushReads(
        s.store,
        createOpsContext({
          tenant: TENANT,
          actor: "system",
          trigger: "flushReads",
          task: null,
          visibility: { kind: "all" },
          idempotency_window: 600_000,
          idempotency_key_window: 86_400_000,
          now: "2026-11-05T06:00:00.000Z",
          confirmation: null,
        }),
      );
      const rows = await s.store.read((tx) =>
        tx.query<Record<string, unknown>>("SELECT * FROM read_log WHERE operation = 'sources'"),
      );
      expect(rows.rows).toHaveLength(1);
      const text = JSON.stringify(rows.rows);
      expect(text).toContain("search");
      expect(text).not.toContain("phrase");
    },
    T,
  );
});
