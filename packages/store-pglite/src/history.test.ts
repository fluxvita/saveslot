// `history` and `reads.list` on PGlite (04-contract §4 `as_of`, §10 `history`, §17; 04-contract-types
// §4.5, §8.3): rows and entities written through `write`, then their timeline, their state as of
// a record time (an operation, an instant, a read, a task's reads), each refusal, and the audit.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  history,
  newReadId,
  query,
  readBufferOf,
  readsList,
  write,
} from "@fluxvita/saveslot-kernel";
import { COMPILED_V1, createSlotEvents, DRAFT, SLOT } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const OTHER = `ci_${"2".repeat(26)}`;

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
        {
          id: "f3",
          name: "distance",
          type: "quantity",
          description: "how far",
          unit: { code: "km", dimension: "length", to_base: "1000" },
          precision: { scale: 2, rounding: "half_up" },
        },
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
const clock = () => {
  minute++;
  return `2026-11-05T03:${String(minute % 60).padStart(2, "0")}:00.000Z`;
};
const ctx = (
  o: { actor?: string; now?: string; task?: string | null; visibility?: unknown } = {},
) =>
  createOpsContext({
    tenant: TENANT,
    actor: o.actor ?? USER,
    trigger: null,
    task: o.task ?? null,
    visibility: (o.visibility ?? { kind: "all" }) as never,
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: o.now ?? clock(),
    confirmation: null,
  });
type Receipt = Awaited<ReturnType<typeof write>>;
const w = (params: Record<string, unknown>, actor = USER): Promise<Receipt> =>
  write(s.store, ctx({ actor }), { sv: 1, ...params });
const h = (params: Record<string, unknown>, o: Parameters<typeof ctx>[0] = {}) =>
  history(s.store, ctx(o), params) as unknown as Promise<Record<string, unknown>>;
async function refused(params: unknown, o: Parameters<typeof ctx>[0] = {}) {
  try {
    await history(s.store, ctx(o), params);
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { code: x.code, ...(x.detail ?? {}) };
  }
  throw new Error("not refused");
}

let row: string;
let entity: string;
const ops: Record<string, number> = {};

beforeAll(async () => {
  s = await openReusable("saveslot-history-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  readBufferOf(s.store).take();
  minute = 0;
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
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-05T00:00:30.000Z" as never,
      events: createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }),
    });
    await applyEvents(tx, eventsOf(op));
  });
  const ins = await w({
    evidence: [{ kind: "user_message", text: "ran 1 km on the 1st" }],
    ops: [
      {
        intent: "insert",
        table: "spend",
        set: { date: "2026-11-01", note: "a", distance: { value: "1", unit: "km" } },
      },
    ],
  });
  row = ins.ops[0]?.target.row as string;
  ops["insert"] = ins.seq;
  ops["update"] = (
    await w({ ops: [{ intent: "update", table: "spend", row, set: { note: "b" } }] })
  ).seq;
  ops["correct"] = (
    await w({
      ops: [
        { intent: "correct", table: "spend", row, set: { distance: { value: "2000", unit: "m" } } },
      ],
    })
  ).seq;
  ops["revoke"] = (await w({ ops: [{ intent: "revoke", table: "spend", row }] })).seq;
  const b = await w({
    ops: [
      {
        intent: "insert",
        table: "budgets",
        set: { category: "food", amount: 100 },
        valid_from: "2026-11-01",
      },
    ],
  });
  entity = b.ops[0]?.target.entity as string;
  ops["budget"] = b.seq;
  ops["raise"] = (
    await w({
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity,
          set: { amount: 150 },
          valid_from: "2026-11-10",
          valid_to: "2026-11-20",
        },
      ],
    })
  ).seq;
  readBufferOf(s.store).take();
}, T);

const user = { kind: "user", id: USER, name: expect.any(String) };

describe("timeline", () => {
  it("lists each write on a row, newest first: intent, fields before and after, sources", async () => {
    const r = await h({ table: "spend", row });
    expect(r).toMatchObject({
      mode: "timeline",
      target: { table: "ledger.spend", row },
      sv: 1,
      // The slot's time zone, for the moments in the result (05-surfaces §4.1).
      timezone: "Asia/Shanghai",
      ver: `v${ops["revoke"]}.0`,
      total: 4,
    });
    const entries = r["entries"] as unknown as Record<string, unknown>[];
    expect(entries.map((e) => [e["seq"], e["intent"]])).toEqual([
      [ops["revoke"], "revoke"],
      [ops["correct"], "correct"],
      [ops["update"], "update"],
      [ops["insert"], "insert"],
    ]);
    expect(entries[0]).toEqual({
      seq: ops["revoke"],
      recorded_at: expect.any(String),
      actor: user,
      intent: "revoke",
      fields: { "*": { result: "applied" } },
    });
    expect(entries[1]?.["fields"]).toEqual({
      distance: {
        result: "applied",
        before: { value: "1", unit: "km" },
        after: { value: "2", unit: "km" },
        sources: {
          value: [
            {
              id: expect.stringMatching(/^s_/),
              kind: "api_call",
              correction: true,
              level: "agent_inferred",
            },
          ],
          operation: [],
        },
      },
    });
    expect(entries[2]?.["fields"]).toMatchObject({
      note: { result: "applied", before: "a", after: "b" },
    });
    expect(entries[3]?.["fields"]).toMatchObject({
      date: { result: "applied", after: "2026-11-01" },
      note: { result: "applied", after: "a" },
      distance: {
        result: "applied",
        after: { value: "1", unit: "km" },
        sources: { value: [{ kind: "user_message", level: "user_stated" }] },
      },
    });
    expect(entries[3]?.["fields"]).not.toHaveProperty("note.before");
  });

  it("gives source text with expand_sources", async () => {
    const r = await h({ table: "spend", row, expand_sources: true });
    const first = (
      r["entries"] as unknown as {
        fields: Record<string, { sources?: { value: { text?: string }[] } }>;
      }[]
    ).at(-1);
    expect(first?.fields["note"]?.sources?.value[0]?.text).toBe("ran 1 km on the 1st");
  });

  it("pages newest first by limit and position", async () => {
    const p1 = await h({ table: "spend", row, limit: 3 });
    expect((p1["entries"] as unknown[]).length).toBe(3);
    const p2 = await h({ table: "spend", row, limit: 3, position: p1["next_position"] });
    expect((p2["entries"] as unknown as { seq: number }[]).map((e) => e.seq)).toEqual([
      ops["insert"],
    ]);
    expect(p2).not.toHaveProperty("next_position");
  });

  it("an undo's evidence is its operation's source (09 §5.2 undo: op_sources)", async () => {
    const undo = (
      await w({
        evidence: [{ kind: "user_message", text: "that raise was a mistake, put it back" }],
        ops: [{ table: "budgets", entity, revert: { undo: ops["raise"] } }],
      })
    ).seq;
    const r = await h({ table: "budgets", entity, expand_sources: true });
    const first = (r["entries"] as unknown as Record<string, unknown>[])[0];
    expect(first).toMatchObject({ seq: undo, via: { undo: ops["raise"] } });
    // An undo writes back values it did not state: the evidence is the operation's source.
    expect(first?.["fields"]).toMatchObject({
      amount: {
        sources: {
          operation: [{ kind: "user_message", text: "that raise was a mistake, put it back" }],
        },
      },
    });
  });

  it("gives a state entity's items with their intervals, and an undo by what it undid", async () => {
    const undo = (await w({ ops: [{ table: "budgets", entity, revert: { undo: ops["raise"] } }] }))
      .seq;
    const r = await h({ table: "budgets", entity });
    const entries = r["entries"] as unknown as Record<string, unknown>[];
    expect(entries[0]).toMatchObject({ seq: undo, via: { undo: ops["raise"] } });
    // Intervals as read results give them (04-contract-types §1 `Interval`), not the event
    // format's `{from, to}`.
    const valid = {
      valid_from: "2026-11-10",
      valid_to: "2026-11-20",
      valid_to_inclusive: "2026-11-19",
    };
    expect(entries[1]).toMatchObject({
      seq: ops["raise"],
      intent: "update",
      fields: { amount: { result: "applied", before: "100", after: "150" } },
    });
    expect(entries[1]?.["valid"]).toEqual(valid);
    const fields = entries[1]?.["fields"] as Record<string, { valid?: unknown }> | undefined;
    expect(fields?.["amount"]?.valid).toEqual(valid);
  });

  it("lists the reads of the row's versions, and counts as reading it", async () => {
    await query(s.store, ctx({ actor: OTHER, task: "t1" }), {
      table: "spend",
      include_revoked: true,
    });
    const r = await h({ table: "spend", row });
    expect(r["reads"]).toEqual([
      {
        read: expect.stringMatching(/^rd_/),
        seq: expect.any(Number),
        at: expect.any(String),
        actor: expect.objectContaining({ id: OTHER }),
        task: "t1",
      },
    ]);
    const entry = readBufferOf(s.store).entries().at(-1);
    expect(entry).toMatchObject({
      operation: "history",
      shape: `{"mode":"timeline","table":"t1","target":"${row}"}`,
      rows: [{ table: "t1", target: row, ver: { op: ops["revoke"] } }],
      lastRead: [
        { kind: "ver", target: row, op: ops["revoke"], restoreCount: 0 },
        { kind: "sv", op: 1, restoreCount: 0 },
      ],
    });
  });
});

describe("as_of", () => {
  const rowAt = async (as_of: unknown) =>
    (await h({ table: "spend", row, mode: "as_of", as_of }))["rows"] as unknown as Record<
      string,
      unknown
    >[];
  it("gives the row as of each operation, with its historical version", async () => {
    expect(await rowAt((ops["insert"] as number) - 1)).toEqual([]);
    expect(await rowAt(ops["insert"])).toEqual([
      {
        table: "ledger.spend",
        row,
        ver: `h${ops["insert"]}.0`,
        historical: true,
        values: { date: "2026-11-01", note: "a", distance: { value: "1", unit: "km" } },
      },
    ]);
    expect((await rowAt(ops["update"]))[0]?.["values"]).toMatchObject({ note: "b" });
    expect((await rowAt(ops["correct"]))[0]).toMatchObject({
      ver: `h${ops["correct"]}.0`,
      values: { distance: { value: "2", unit: "km" } },
      marks: { corrected: true },
    });
    expect((await rowAt(ops["revoke"]))[0]).toMatchObject({
      marks: { corrected: true, revoked: { seq: ops["revoke"] } },
    });
    // Past the end: the latest.
    expect((await rowAt(10_000))[0]).toMatchObject({ ver: `h${ops["revoke"]}.0` });
  });

  it("takes an instant as the last operation recorded by then", async () => {
    const r = await h({ table: "spend", row, mode: "as_of", as_of: "2026-11-05T03:02:30Z" });
    expect(r["as_of"]).toEqual({ seq: ops["update"], recorded_at: "2026-11-05T03:02:00.000Z" });
    expect(r["sv"]).toBe(1);
    expect(r["timezone"]).toBe("Asia/Shanghai");
  });

  it("gives a state entity's segments then, at a point if asked", async () => {
    const at = async (as_of: number, more: Record<string, unknown> = {}) =>
      (
        (await h({ table: "budgets", entity, mode: "as_of", as_of, ...more }))[
          "rows"
        ] as unknown as Record<string, unknown>[]
      ).map((x) => [
        x["valid_from"],
        x["valid_to"],
        (x["values"] as Record<string, unknown>)["amount"],
        x["valid_to_inclusive"] ?? null,
      ]);
    expect(await at(ops["budget"] as number)).toEqual([["2026-11-01", null, "100", null]]);
    expect(await at(ops["raise"] as number)).toEqual([
      ["2026-11-01", "2026-11-10", "100", "2026-11-09"],
      ["2026-11-10", "2026-11-20", "150", "2026-11-19"],
      ["2026-11-20", null, "100", null],
    ]);
    expect(await at(ops["raise"] as number, { valid_at: "2026-11-15" })).toEqual([
      ["2026-11-10", "2026-11-20", "150", "2026-11-19"],
    ]);
  });

  it("goes back to what a read saw, and to a task's last read with the others listed", async () => {
    const seen = await query(s.store, ctx({ actor: OTHER, task: "plan" }), {
      table: "budgets",
      at: "2026-11-15T04:00:00Z",
    });
    const first = readBufferOf(s.store).entries().at(-1)?.read as string;
    await w({
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity,
          set: { amount: 175 },
          valid_from: "2026-11-12",
          valid_to: "2026-11-20",
        },
      ],
    });
    await query(s.store, ctx({ actor: OTHER, task: "plan" }), {
      table: "budgets",
      at: "2026-11-15T04:00:00Z",
    });
    const second = readBufferOf(s.store).entries().at(-1)?.read as string;
    const byRead = await h({ table: "budgets", entity, mode: "as_of", as_of: { read: first } });
    expect(
      (byRead["rows"] as unknown as Record<string, unknown>[]).map((x) => x["values"]),
    ).toEqual(seen.rows.map((x) => x.values));
    const byTask = await h(
      { table: "budgets", entity, mode: "as_of", as_of: { task: "plan" } },
      { actor: OTHER },
    );
    expect(
      (byTask["rows"] as unknown as Record<string, unknown>[]).map(
        (x) => (x["values"] as Record<string, unknown>)["amount"],
      ),
    ).toEqual(["175"]);
    expect(byTask["other_reads"]).toEqual([
      { read: first, seq: expect.any(Number), at: expect.any(String) },
    ]);
    expect(second).not.toBe(first);
    expect(
      await refused({ table: "budgets", entity, mode: "as_of", as_of: { task: "plan" } }),
    ).toMatchObject({
      code: "not_found",
      param: "as_of/task",
    });
    expect(
      await refused({
        table: "budgets",
        entity,
        mode: "as_of",
        as_of: { read: `rd_${"0".repeat(16)}` },
      }),
    ).toMatchObject({ code: "not_found", param: "as_of/read" });
  });

  it("is a read recorded without a version to fall back to", async () => {
    await h({ table: "spend", row, mode: "as_of", as_of: ops["update"] });
    expect(readBufferOf(s.store).entries().at(-1)).toMatchObject({
      operation: "history",
      rows: [{ target: row, ver: { op: ops["update"] } }],
      lastRead: [],
    });
  });
});

describe("pages fixed to the first page", () => {
  it("timeline: a later page lists the entries up to the first page's operation, with its version", async () => {
    const p1 = await h({ table: "budgets", entity, limit: 1 });
    expect((p1["entries"] as unknown as { seq: number }[]).map((e) => e.seq)).toEqual([
      ops["raise"],
    ]);
    // Meanwhile another write on the entity.
    await w({
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity,
          set: { amount: 120 },
          valid_from: "2026-11-25",
        },
      ],
    });
    const p2 = await h({ table: "budgets", entity, limit: 1, position: p1["next_position"] });
    expect((p2["entries"] as unknown as { seq: number }[]).map((e) => e.seq)).toEqual([
      ops["budget"],
    ]);
    expect([p1["total"], p2["total"]]).toEqual([2, 2]);
    expect(p2["ver"]).toBe(`v${ops["raise"]}.0`);
    expect(p2).not.toHaveProperty("next_position");
    // A fresh first page sees the write.
    expect((await h({ table: "budgets", entity }))["total"]).toBe(3);
  });

  it("as_of: segments page by their start", async () => {
    const all = (await h({ table: "budgets", entity, mode: "as_of", as_of: ops["raise"] }))["rows"];
    const seen: unknown[] = [];
    let position: unknown;
    for (;;) {
      const p = await h({
        table: "budgets",
        entity,
        mode: "as_of",
        as_of: ops["raise"],
        limit: 1,
        ...(position !== undefined ? { position } : {}),
      });
      seen.push(...(p["rows"] as unknown[]));
      if (p["next_position"] === undefined) break;
      position = p["next_position"];
    }
    expect(seen).toEqual(all);
    expect(seen).toHaveLength(3);
  });

  it("reads.list: a later page lists the reads up to the first page's last one", async () => {
    await query(s.store, ctx({ actor: OTHER }), { table: "budgets" });
    await query(s.store, ctx({ actor: OTHER }), { table: "spend", include_revoked: true });
    const p1 = await readsList(s.store, ctx(), { limit: 1 });
    await query(s.store, ctx({ actor: OTHER }), { table: "budgets" });
    const p2 = await readsList(s.store, ctx(), { limit: 5, position: p1.next_position });
    expect([p1.total, p2.total]).toEqual([2, 2]);
    expect(p2.reads).toHaveLength(1);
    expect((await readsList(s.store, ctx(), {})).total).toBe(3);
  });

  it("refuses a position of another call, and one from before a restore", async () => {
    const p1 = await h({ table: "budgets", entity, limit: 1 });
    expect(
      await refused({
        table: "budgets",
        entity,
        limit: 1,
        expand_sources: true,
        position: p1["next_position"],
      }),
    ).toEqual({ code: "invalid_argument", reason: "malformed", param: "position" });
    const o = JSON.parse(Buffer.from(p1["next_position"] as string, "base64url").toString());
    const forged = Buffer.from(JSON.stringify({ ...o, r: 1 })).toString("base64url");
    expect(await refused({ table: "budgets", entity, limit: 1, position: forged })).toEqual({
      code: "handle_expired",
      reason: "restored",
      param: "position",
    });
  });

  it("timeline lists only reads of its own target, buffered ones too", async () => {
    // Another entity of the same table, read alone (the read stays in the buffer).
    await w({
      ops: [
        {
          intent: "insert",
          table: "budgets",
          set: { category: "rent", amount: 5 },
          valid_from: "2026-11-01",
        },
      ],
    });
    await query(s.store, ctx({ actor: OTHER }), {
      table: "budgets",
      where: [{ field: "category", op: "=", value: "rent" }],
    });
    expect(readBufferOf(s.store).size).toBe(1);
    expect(await h({ table: "budgets", entity })).not.toHaveProperty("reads");
  });
});

describe("record points of reads", () => {
  const amounts = (r: Record<string, unknown>) =>
    (r["rows"] as { values: Record<string, unknown>; valid_from?: string }[]).map((x) => [
      x.valid_from,
      x.values["amount"],
    ]);

  it("a later query page is recorded at the first page's operation: {read} gives what it saw", async () => {
    const extra = await w({
      ops: [
        {
          intent: "insert",
          table: "budgets",
          set: { category: "rent", amount: 5 },
          valid_from: "2026-11-01",
        },
      ],
    });
    const during = {
      table: "budgets",
      valid_during: ["2026-11-01", null],
      coalesce: false,
      limit: 1,
    };
    const p1 = await query(s.store, ctx({ actor: OTHER }), during);
    // Meanwhile the entity's amount on [11-10, 11-20) becomes 999.
    await w({
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity,
          set: { amount: 999 },
          valid_from: "2026-11-10",
          valid_to: "2026-11-20",
        },
      ],
    });
    await query(s.store, ctx({ actor: OTHER }), {
      ...during,
      limit: 10,
      position: p1.next_position,
    });
    const later = readBufferOf(s.store).entries().at(-1);
    // The first page read the state as of the insert; so did the later one.
    expect(later?.pos).toBe(extra.seq);
    const back = await h({ table: "budgets", entity, mode: "as_of", as_of: { read: later?.read } });
    expect(amounts(back).map((x) => x[1])).not.toContain("999");
  });

  it("an as_of read is recorded at its record point: {read} of it gives that state", async () => {
    await h({ table: "budgets", entity, mode: "as_of", as_of: ops["budget"] });
    const read = readBufferOf(s.store).entries().at(-1);
    expect(read).toMatchObject({ pos: ops["budget"], historical: true, lastRead: [] });
    const back = await h({ table: "budgets", entity, mode: "as_of", as_of: { read: read?.read } });
    expect(amounts(back)).toEqual([["2026-11-01", "100"]]);
  });

  it("{task} takes the task's last read of the target, not its own as_of reads: the same twice", async () => {
    const plan = { actor: OTHER, task: "plan" };
    await query(s.store, ctx(plan), { table: "budgets", at: "2026-11-15T04:00:00Z" });
    await w({
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity,
          set: { amount: 175 },
          valid_from: "2026-11-12",
          valid_to: "2026-11-20",
        },
      ],
    });
    const once = await h(
      { table: "budgets", entity, mode: "as_of", as_of: { task: "plan" } },
      plan,
    );
    const twice = await h(
      { table: "budgets", entity, mode: "as_of", as_of: { task: "plan" } },
      plan,
    );
    expect(amounts(twice)).toEqual(amounts(once));
    expect(amounts(once)).toEqual([["2026-11-10", "150"]]);
  });

  it("later as_of pages keep the first page's record point, however the log moves", async () => {
    const all = async (as_of: unknown, o: Parameters<typeof ctx>[0] = {}) => {
      // The whole result in one page, read just before; the paged read must give the same.
      const whole = amounts(
        await h({ table: "budgets", entity, mode: "as_of", as_of, limit: 100 }, o),
      );
      const seen: unknown[] = [];
      let position: unknown;
      for (;;) {
        const p = await h(
          {
            table: "budgets",
            entity,
            mode: "as_of",
            as_of,
            limit: 1,
            ...(position !== undefined ? { position } : {}),
          },
          o,
        );
        seen.push(...amounts(p));
        // A write between the pages.
        await w({
          ops: [
            {
              intent: "update",
              table: "budgets",
              entity,
              set: { amount: 1 + seen.length },
              valid_from: "2026-11-25",
            },
          ],
        });
        if (p["next_position"] === undefined) {
          expect(seen).toEqual(whole);
          return seen;
        }
        position = p["next_position"];
      }
    };
    expect(await all("2030-01-01T00:00:00Z")).toEqual([
      ["2026-11-01", "100"],
      ["2026-11-10", "150"],
      ["2026-11-20", "100"],
    ]);
    expect((await all(1_000_000)).length).toBe(4);
    await query(s.store, ctx({ actor: OTHER, task: "t" }), {
      table: "budgets",
      valid_during: ["2026-11-01", null],
      coalesce: false,
    });
    expect((await all({ task: "t" }, { actor: OTHER, task: "t" })).length).toBe(4);
  });

  it("gives seq 0 and no recorded time before any operation", async () => {
    const r = await h({ table: "spend", row, mode: "as_of", as_of: "2026-01-01T00:00:00Z" });
    expect(r["as_of"]).toEqual({ seq: 0 });
    expect(r["rows"]).toEqual([]);
  });

  it("takes an instant equal to an operation's recorded time as that operation", async () => {
    const ev = await s.store.read((tx) =>
      tx.query<{ at: string }>("SELECT at FROM events WHERE seq = $1", [ops["update"] as number]),
    );
    const r = await h({ table: "spend", row, mode: "as_of", as_of: ev.rows[0]?.at });
    expect(r["as_of"]).toMatchObject({ seq: ops["update"] });
  });

  it("valid_at excludes a segment's end", async () => {
    const r = await h({
      table: "budgets",
      entity,
      mode: "as_of",
      as_of: ops["raise"],
      valid_at: "2026-11-20",
    });
    expect(amounts(r)).toEqual([["2026-11-20", "100"]]);
  });

  it("{read} carries its business time only for the same table; a read out of the visible range is not_found", async () => {
    await query(s.store, ctx({ actor: OTHER }), {
      table: "budgets",
      valid_during: ["2026-11-12", "2026-11-15"],
      coalesce: false,
    });
    const read = readBufferOf(s.store).entries().at(-1)?.read;
    const same = await h({ table: "budgets", entity, mode: "as_of", as_of: { read } });
    expect(amounts(same)).toEqual([["2026-11-10", "150"]]);
    // Another table of the slot: the read's position only.
    const other = await h({ table: "spend", row, mode: "as_of", as_of: { read } });
    expect((other["rows"] as unknown[]).length).toBe(1);
    // A read of spend whose time condition no budgets segment meets: budgets takes its position only.
    await query(s.store, ctx({ actor: OTHER }), {
      table: "spend",
      valid_during: ["2027-01-01", "2027-02-01"],
    });
    const ofSpend = readBufferOf(s.store).entries().at(-1)?.read;
    const fromSpend = await h({
      table: "budgets",
      entity,
      mode: "as_of",
      as_of: { read: ofSpend },
    });
    expect(amounts(fromSpend).length).toBe(3);
    // The read was of budgets; a session that sees only spend cannot use it.
    const scoped = { kind: "scoped", slots: [{ slot: SLOT, tables: [{ table: "t1" }] }] };
    expect(
      await refused(
        { table: "spend", row, mode: "as_of", as_of: { read } },
        { visibility: scoped },
      ),
    ).toMatchObject({ code: "not_found" });
  });

  it("binds valid_at in the position", async () => {
    const p1 = await h({
      table: "budgets",
      entity,
      mode: "as_of",
      as_of: ops["raise"],
      valid_at: "2026-11-15",
      limit: 1,
    });
    // One row: no next page; a position of another valid_at, forged from a two-row read.
    const p = await h({ table: "budgets", entity, mode: "as_of", as_of: ops["raise"], limit: 1 });
    expect(
      await refused({
        table: "budgets",
        entity,
        mode: "as_of",
        as_of: ops["raise"],
        valid_at: "2026-11-15",
        limit: 1,
        position: p["next_position"],
      }),
    ).toMatchObject({ reason: "malformed", param: "position" });
    expect(p1).not.toHaveProperty("next_position");
  });
});

describe("reads as of a point are not reads of a version", () => {
  type Rows = { rows: { valid_from?: string; values: Record<string, unknown> }[] };
  const amounts = (r: Record<string, unknown>) =>
    (r as unknown as Rows).rows.map((x) => [x.valid_from, x.values["amount"]]);
  const T1 = { actor: OTHER, task: "T" };
  const byTask = (task: string) =>
    h({ table: "budgets", entity, mode: "as_of", as_of: { task } }, { actor: OTHER, task });
  const write = (amount: number) =>
    w({
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity,
          set: { amount },
          valid_from: "2026-11-12",
          valid_to: "2026-11-20",
        },
      ],
    });
  const seen = [
    ["2026-11-01", "100"],
    ["2026-11-10", "150"],
    ["2026-11-20", "100"],
  ];

  it("{task} skips the task's as_of reads, buffered and written; other_reads leaves them out", async () => {
    await query(s.store, ctx(T1), {
      table: "budgets",
      valid_during: ["2026-11-01", null],
      coalesce: false,
    });
    // The write puts the query in the table; the as_of read after it stays in the buffer.
    await write(175);
    await h({ table: "budgets", entity, mode: "as_of", as_of: ops["budget"] }, T1);
    expect(readBufferOf(s.store).entries().at(-1)).toMatchObject({ historical: true });
    const buffered = await byTask("T");
    expect(amounts(buffered)).toEqual(seen);
    expect(buffered).not.toHaveProperty("other_reads");
    // Another write: the as_of reads are written too, flag and all.
    await write(180);
    expect(readBufferOf(s.store).size).toBe(0);
    const n = await s.store.read((tx) =>
      tx.query<{ c: unknown }>("SELECT count(*) AS c FROM read_log WHERE historical"),
    );
    expect(Number(n.rows[0]?.c)).toBe(2);
    const written = await byTask("T");
    expect(amounts(written)).toEqual(seen);
    expect(written).not.toHaveProperty("other_reads");
  });

  it("a task with only as_of reads of the target has none to go back to, buffered or written", async () => {
    const T2 = { actor: OTHER, task: "T2" };
    await h({ table: "budgets", entity, mode: "as_of", as_of: ops["budget"] }, T2);
    const none = { code: "not_found", reason: "read", param: "as_of/task" };
    expect(
      await refused({ table: "budgets", entity, mode: "as_of", as_of: { task: "T2" } }, T2),
    ).toEqual(none);
    await write(175);
    expect(
      await refused({ table: "budgets", entity, mode: "as_of", as_of: { task: "T2" } }, T2),
    ).toEqual(none);
  });

  it("records a later timeline page at the first page's operation", async () => {
    const p1 = await h({ table: "budgets", entity, limit: 1 });
    const first = readBufferOf(s.store).entries().at(-1)?.pos;
    const moved = await write(175);
    await h({ table: "budgets", entity, limit: 1, position: p1["next_position"] });
    expect(first).toBeLessThan(moved.seq);
    expect(readBufferOf(s.store).entries().at(-1)?.pos).toBe(first);
  });

  it("carries {read}'s business time condition to the later pages", async () => {
    await query(s.store, ctx({ actor: OTHER }), {
      table: "budgets",
      valid_during: ["2026-11-01", "2026-11-15"],
      coalesce: false,
    });
    const read = readBufferOf(s.store).entries().at(-1)?.read;
    const pages: unknown[] = [];
    let position: unknown;
    for (let i = 0; i < 3; i++) {
      const p = await h({
        table: "budgets",
        entity,
        mode: "as_of",
        as_of: { read },
        limit: 1,
        ...(position !== undefined ? { position } : {}),
      });
      pages.push(...amounts(p));
      position = p["next_position"];
      if (position === undefined) break;
    }
    // The segment from 11-20 does not meet the read's interval.
    expect(pages).toEqual(seen.slice(0, 2));
  });

  it("{read} of a visible table in another slot, or of no table, gives its position only", async () => {
    // A second slot, visible: the same schema under other IDs and names (table IDs are the
    // tenant's).
    const OTHER_SLOT = `sl_${"5".repeat(16)}`;
    const compiled = {
      ...COMPILED,
      tables: COMPILED.tables.map((t) => {
        const id = t.id === "t1" ? "t3" : "t4";
        return { ...t, id, physical: { table: `t_${id}_v1` } };
      }),
    };
    const changes = [
      { target: { slot: true }, change: "create_slot" },
      ...compiled.tables.map((t) => ({ target: { table: t.id }, change: "add_table" })),
    ].map((c) => ({
      ...c,
      class: "create",
      compatible_with_old_writes: true,
      destructive: false,
      auto: true,
    }));
    const events = JSON.parse(
      JSON.stringify(createSlotEvents({ compiled: compiled as never, changes: changes as never }))
        .replaceAll(SLOT, OTHER_SLOT)
        .replaceAll(DRAFT, `d_${"2".repeat(16)}`)
        .replaceAll('"ledger"', '"ledger2"'),
    );
    await s.store.write(async (tx) => {
      const op = await appendOperation(tx, { actor: USER as never, now: clock() as never, events });
      await applyEvents(tx, eventsOf(op));
    });
    await query(s.store, ctx({ actor: OTHER }), {
      table: "ledger2.budgets",
      valid_during: ["2027-01-01", "2027-02-01"],
    });
    const there = readBufferOf(s.store).entries().at(-1);
    expect(there).toMatchObject({ slot: OTHER_SLOT, table: "t4" });
    // A table of another slot: its condition does not apply here.
    const fromThere = await h({
      table: "ledger.budgets",
      entity,
      mode: "as_of",
      as_of: { read: there?.read },
    });
    expect(amounts(fromThere)).toEqual(seen);
    // A read of no table (as a slot-level read is recorded).
    const noTable = {
      ...(there as never as object),
      read: newReadId(),
      rows: [],
      coarse: [],
    } as never as Record<string, unknown>;
    delete noTable["table"];
    delete noTable["valid"];
    readBufferOf(s.store).record(noTable as never);
    const fromSlot = await h({
      table: "ledger.budgets",
      entity,
      mode: "as_of",
      as_of: { read: noTable["read"] },
    });
    expect(amounts(fromSlot)).toEqual(seen);
    // Out of the visible range: the other slot not visible.
    const scoped = { kind: "scoped", slots: [{ slot: SLOT }] };
    for (const read of [there?.read, noTable["read"]])
      expect(
        await refused(
          { table: "ledger.budgets", entity, mode: "as_of", as_of: { read } },
          { visibility: scoped },
        ),
      ).toMatchObject({ code: "not_found", param: "as_of/read" });
  });
});

describe("positions carry a business time condition only for as_of", () => {
  const forge = (p: unknown, c: unknown) => {
    const o = JSON.parse(Buffer.from(p as string, "base64url").toString());
    return Buffer.from(JSON.stringify({ ...o, c })).toString("base64url");
  };
  const malformed = { code: "invalid_argument", reason: "malformed", param: "position" };

  it("refuses one in a timeline, query or reads.list position", async () => {
    const t = await h({ table: "budgets", entity, limit: 1 });
    expect(
      await refused({
        table: "budgets",
        entity,
        limit: 1,
        position: forge(t["next_position"], { at: "2026-11-15" }),
      }),
    ).toEqual(malformed);
    const qp = { table: "budgets", valid_during: ["2026-11-01", null], coalesce: false, limit: 1 };
    const q = await query(s.store, ctx(), qp);
    await expect(
      query(s.store, ctx(), { ...qp, position: forge(q.next_position, { at: "2026-11-15" }) }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      detail: { reason: "malformed", param: "position" },
    });
    await query(s.store, ctx({ actor: OTHER }), { table: "budgets" });
    await query(s.store, ctx({ actor: OTHER }), { table: "budgets" });
    const l = await readsList(s.store, ctx(), { limit: 1 });
    await expect(
      readsList(s.store, ctx(), {
        limit: 1,
        position: forge(l.next_position, { at: "2026-11-15" }),
      }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      detail: { reason: "malformed", param: "position" },
    });
  });

  it.each([
    ["a date that does not exist", { at: "2026-99-99" }],
    ["an instant that does not exist", { at: "2026-02-30T00:00:00.000Z" }],
    ["an interval ending before it starts", { during: ["2026-11-15", "2026-11-01"] }],
    ["an empty interval", { during: ["2026-11-15", "2026-11-15"] }],
    [
      "an interval of a date and an instant",
      { during: ["2026-11-01", "2026-11-15T00:00:00.000Z"] },
    ],
    ["both", { at: "2026-11-15", during: ["2026-11-01", null] }],
    ["another key", { on: "2026-11-15" }],
  ])("refuses %s in an as_of position", async (_, c) => {
    const p = await h({ table: "budgets", entity, mode: "as_of", as_of: ops["raise"], limit: 1 });
    expect(
      await refused({
        table: "budgets",
        entity,
        mode: "as_of",
        as_of: ops["raise"],
        limit: 1,
        position: forge(p["next_position"], c),
      }),
    ).toEqual(malformed);
  });
});

describe("reads.list numbers reads as written", () => {
  it("lists every read across pages when the numbering skips", async () => {
    await query(s.store, ctx({ actor: OTHER }), { table: "budgets" });
    await query(s.store, ctx({ actor: OTHER }), { table: "spend" });
    // A rolled-back flush leaves a gap in the numbers.
    await s.store.write((tx) =>
      tx.query("SELECT nextval(pg_get_serial_sequence('read_log', 'n'))"),
    );
    const p1 = await readsList(s.store, ctx(), { limit: 1 });
    // A write between the pages writes any read left in the buffer.
    await w({
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity,
          set: { amount: 120 },
          valid_from: "2026-11-25",
        },
      ],
    });
    const p2 = await readsList(s.store, ctx(), { limit: 1, position: p1.next_position });
    expect([...p1.reads, ...p2.reads].map((r) => r.operation)).toEqual(["query", "query"]);
    expect(p2).not.toHaveProperty("next_position");
  });
});

describe("timeline details", () => {
  it("gives an awaiting item's sources from its event", async () => {
    // The amount on [11-10, 11-20) back to 100: it overwrites the change points (high impact).
    const r = await w({
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity,
          set: { amount: 100 },
          valid_from: "2026-11-10",
          valid_to: "2026-11-20",
        },
      ],
    });
    expect(r.status).toBe("pending");
    const t = await h({ table: "budgets", entity });
    const first = (
      t["entries"] as {
        seq: number;
        fields: Record<string, { result: string; sources: { value: unknown[] } }>;
      }[]
    )[0];
    expect(first?.seq).toBe(r.seq);
    expect(first?.fields["amount"]).toMatchObject({
      result: "awaiting",
      sources: { value: [{ kind: "api_call" }] },
    });
  });

  it("lists reads with the version each read", async () => {
    // A write elsewhere first: the log is past the entity's version when it is read.
    await w({ ops: [{ intent: "insert", table: "spend", set: { date: "2026-11-02" } }] });
    await query(s.store, ctx({ actor: OTHER }), { table: "budgets" });
    await w({
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity,
          set: { amount: 120 },
          valid_from: "2026-11-25",
        },
      ],
    });
    const t = await h({ table: "budgets", entity });
    expect((t["reads"] as { seq: number }[])[0]?.seq).toBe(ops["raise"]);
  });

  it("gives the reads on the first page only, and registers no version read on later pages", async () => {
    await query(s.store, ctx({ actor: OTHER }), { table: "budgets" });
    const p1 = await h({ table: "budgets", entity, limit: 1 }, { actor: OTHER });
    expect(p1["reads"]).toBeDefined();
    readBufferOf(s.store).take();
    const p2 = await h(
      { table: "budgets", entity, limit: 1, position: p1["next_position"] },
      { actor: OTHER },
    );
    expect(p2).not.toHaveProperty("reads");
    expect(readBufferOf(s.store).entries().at(-1)?.lastRead).toEqual([]);
  });

  it("refuses a position from before the target existed", async () => {
    const p1 = await h({ table: "budgets", entity, limit: 1 });
    const o = JSON.parse(Buffer.from(p1["next_position"] as string, "base64url").toString());
    const forged = Buffer.from(JSON.stringify({ ...o, s: (ops["budget"] as number) - 1 })).toString(
      "base64url",
    );
    expect(await refused({ table: "budgets", entity, limit: 1, position: forged })).toEqual({
      code: "invalid_argument",
      reason: "malformed",
      param: "position",
    });
  });

  it("gives a later op of one request the earlier op's value as before, over three writes", async () => {
    const r = await w({
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity,
          set: { amount: 201 },
          valid_from: "2026-11-01",
          valid_to: "2026-11-05",
        },
        {
          intent: "update",
          table: "budgets",
          entity,
          set: { amount: 202 },
          valid_from: "2026-11-01",
          valid_to: "2026-11-05",
        },
        {
          intent: "update",
          table: "budgets",
          entity,
          set: { amount: 203 },
          valid_from: "2026-11-01",
          valid_to: "2026-11-05",
        },
      ],
    });
    const t = await h({ table: "budgets", entity });
    const same = (
      t["entries"] as {
        seq: number;
        fields: Record<string, { before?: unknown; after?: unknown }>;
      }[]
    ).filter((e) => e.seq === r.seq);
    expect(same.map((e) => [e.fields["amount"]?.before, e.fields["amount"]?.after])).toEqual([
      ["202", "203"],
      ["201", "202"],
      ["100", "201"],
    ]);
  });

  it("gives corrected by segment as of a point, as query does", async () => {
    const c = await w({
      ops: [
        {
          intent: "correct",
          table: "budgets",
          entity,
          set: { amount: 160 },
          valid_from: "2026-11-10",
          valid_to: "2026-11-20",
        },
      ],
    });
    const at = async (as_of: number) =>
      (
        (await h({ table: "budgets", entity, mode: "as_of", as_of }))["rows"] as {
          valid_from: string;
          marks?: unknown;
        }[]
      ).map((x) => [x.valid_from, x.marks ?? null]);
    expect(await at(c.seq)).toEqual([
      ["2026-11-01", null],
      ["2026-11-10", { corrected: true }],
      ["2026-11-20", null],
    ]);
    const u = await w({
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity,
          set: { amount: 170 },
          valid_from: "2026-11-10",
          valid_to: "2026-11-20",
        },
      ],
    });
    expect(await at(u.seq)).toEqual([
      ["2026-11-01", null],
      ["2026-11-10", null],
      ["2026-11-20", null],
    ]);
  });
});

describe("refusals", () => {
  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    [
      "no target",
      { table: "spend" },
      { code: "invalid_argument", reason: "missing", param: "row" },
    ],
    [
      "two targets",
      { table: "budgets", entity: `e_${"1".repeat(26)}`, entity_key: {} },
      { code: "invalid_argument", reason: "mutually_exclusive", param: "entity_key" },
    ],
    [
      "row on a state table",
      { table: "budgets", row: `r_${"1".repeat(26)}` },
      { code: "invalid_argument", reason: "malformed", param: "row" },
    ],
    [
      "entity on an event table",
      { table: "spend", entity: `e_${"1".repeat(26)}` },
      { code: "invalid_argument", reason: "not_state_table", param: "entity" },
    ],
    [
      "no such row",
      { table: "spend", row: `r_${"1".repeat(26)}` },
      { code: "not_found", reason: "row", param: "row" },
    ],
    [
      "as_of's key in timeline",
      { table: "spend", row: "r_X", valid_at: "2026-11-01" },
      {
        code: "invalid_argument",
        reason: "mode_mismatch",
        param: "valid_at",
        example: { table: "spend", row: "r_…" },
      },
    ],
    [
      "as_of without as_of",
      { table: "spend", row: "", mode: "as_of" },
      { code: "invalid_argument", reason: "malformed", param: "row" },
    ],
    [
      "changes (not yet)",
      { table: "spend", mode: "changes" },
      { code: "internal", reason: "not_implemented", param: "mode" },
    ],
    [
      "composition",
      { table: "spend", mode: "composition" },
      { code: "not_in_this_version", reason: "value", param: "mode" },
    ],
    [
      "an unknown key",
      { table: "spend", row: "r_X", rows: 1 },
      { code: "invalid_argument", reason: "malformed", param: "rows" },
    ],
  ])("refuses %s", async (_, params, error) => {
    expect(await refused(params)).toEqual(error);
  });

  it("refuses as_of shapes and valid_at where it has no meaning", async () => {
    expect(await refused({ table: "spend", row, mode: "as_of" })).toMatchObject({
      reason: "missing",
      param: "as_of",
    });
    expect(await refused({ table: "spend", row, mode: "as_of", as_of: 0 })).toMatchObject({
      reason: "malformed",
      param: "as_of",
    });
    expect(
      await refused({ table: "spend", row, mode: "as_of", as_of: "2026-11-05" }),
    ).toMatchObject({ reason: "malformed" });
    expect(await refused({ table: "spend", row, mode: "as_of", as_of: { op: 1 } })).toMatchObject({
      reason: "malformed",
    });
    expect(
      await refused({ table: "spend", row, mode: "as_of", as_of: 1, valid_at: "2026-11-01" }),
    ).toMatchObject({
      reason: "event_table_valid_at",
    });
  });
});

describe("reads.list", () => {
  it("lists the reads newest first, with rows and versions, filtered", async () => {
    await query(s.store, ctx({ actor: OTHER, task: "t1" }), { table: "budgets" });
    await h({ table: "spend", row }, { actor: OTHER });
    const all = await readsList(s.store, ctx(), {});
    expect(all.total).toBe(2);
    expect(all.reads[0]).toMatchObject({
      operation: "history",
      table: "ledger.spend",
      rows: [{ target: { table: "ledger.spend", row }, seq: ops["revoke"] }],
      rows_total: 1,
    });
    expect(all.reads[1]).toMatchObject({
      operation: "query",
      task: "t1",
      slot: "ledger",
      sv: 1,
      table: "ledger.budgets",
      rows: [{ target: { table: "ledger.budgets", entity }, seq: ops["raise"] }],
      valid: { at: "2026-11-05" },
    });
    expect((await readsList(s.store, ctx(), { of_task: "t1" })).total).toBe(1);
    expect((await readsList(s.store, ctx(), { table: "spend" })).total).toBe(1);
    const page = await readsList(s.store, ctx(), { limit: 1 });
    const next = await readsList(s.store, ctx(), { limit: 1, position: page.next_position });
    expect([page.reads[0]?.read, next.reads[0]?.read]).toEqual(all.reads.map((x) => x.read));
  });

  it("refuses an unknown table as wherever a table is named; until excludes its instant; limit at most 200", async () => {
    // unknown_table with the nearest names (04-contract-types §9), bare for a bare name and
    // qualified for a qualified one; an unknown slot stays not_found.
    const refusal = (params: Record<string, unknown>) =>
      readsList(s.store, ctx(), params).catch((e: { code?: string; detail?: unknown }) => ({
        code: e.code,
        detail: e.detail,
      }));
    expect(await refusal({ table: "spnd" })).toEqual({
      code: "unknown_table",
      detail: { param: "table", name: "spnd", nearest: ["spend", "budgets"] },
    });
    expect(await refusal({ table: "ledger.spnd" })).toEqual({
      code: "unknown_table",
      detail: { param: "table", name: "ledger.spnd", nearest: ["ledger.spend", "ledger.budgets"] },
    });
    expect(await refusal({ slot: "nope" })).toMatchObject({
      code: "not_found",
      detail: { reason: "slot", param: "slot" },
    });
    await query(s.store, ctx({ actor: OTHER, now: "2026-11-05T04:00:00.000Z" }), {
      table: "budgets",
    });
    expect((await readsList(s.store, ctx(), { until: "2026-11-05T04:00:00Z" })).total).toBe(0);
    expect((await readsList(s.store, ctx(), { until: "2026-11-05T04:00:00.001Z" })).total).toBe(1);
    expect((await readsList(s.store, ctx(), { limit: 200 })).total).toBe(1);
    await expect(readsList(s.store, ctx(), { limit: 201 })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect((await readsList(s.store, ctx(), {})).covered_since).toBe("2026-11-05T00:00:00.000Z");
  });

  it("is for user sessions only", async () => {
    await expect(readsList(s.store, ctx({ actor: OTHER }), {})).rejects.toMatchObject({
      code: "insufficient_scope",
    });
  });
});
