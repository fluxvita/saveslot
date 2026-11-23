// apply keeping the key index (`external_keys`) on storage (09-event-format §5.7 the `write.base`
// apply table: a key field's item in effect gives the row its entry, by the new values; a revoke
// leaves it; §5.12; 04-write-and-read «持有者怎么定» 1). Hand-written events: the write path does
// not write by key yet. An entry is only ever added here: freezing, unfreezing and a deletion's
// recomputing of the holder (09 §5.9) come with the deletion phase, and transferring a key
// (`key_from`) is not in this version.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  type NewEvent,
  readTail,
  reconcileLog,
  resolve,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { COMPILED_V1, createSlotEvents, SLOT } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const ROW = `r_${"6".repeat(26)}`;
const ROW_B = `r_${"5".repeat(26)}`;
const ROW_C = `r_${"4".repeat(26)}`;

// `meals`: a timeless table keyed by (origin, external_id); `cards`: an event table keyed by an
// integer.
const COMPILED = {
  ...COMPILED_V1,
  tables: [
    {
      id: "t1",
      name: "meals",
      kind: "base",
      description: "a meal",
      time: { type: "none" },
      physical: { table: "t_t1_v1" },
      fields: [
        { id: "f1", name: "origin", type: "text", description: "the source system" },
        { id: "f2", name: "external_id", type: "text", description: "its ID there" },
        { id: "f3", name: "energy", type: "integer", description: "kcal" },
      ],
      external_key: ["f1", "f2"],
    },
    {
      id: "t2",
      name: "cards",
      kind: "base",
      description: "a card",
      time: { type: "event", field: "f1" },
      physical: { table: "t_t2_v1" },
      fields: [
        { id: "f1", name: "on", type: "date", required: true, description: "the day" },
        { id: "f2", name: "number", type: "integer", description: "its number" },
      ],
      external_key: ["f2"],
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

let live: ReusableStore;
let scratch: ReusableStore;
let minute = 0;

const run = (events: NewEvent[]) =>
  live.store.write(async (tx) => {
    const now = `2026-11-10T05:${String(minute++).padStart(2, "0")}:00.000Z` as never;
    const op = await appendOperation(tx, { actor: USER as never, now, events });
    await applyEvents(tx, eventsOf(op));
    return op;
  });
const tail = async () => (await live.store.read(readTail))?.seq ?? 0;
const ctxBlock = {
  now: "2026-11-10T05:00:00.000Z",
  today: "2026-11-10",
  ruleset_version: 1,
  policy_version: 1,
  literal_checker: "literal@1",
};

/**
 * One write: its head, an `api_call` source and its `write.base`, numbered from the log's end.
 * `fields`: field ID → [status, value]; `existence`: a revoke's item.
 */
async function writeOp(o: {
  table: "t1" | "t2";
  row: string;
  target: Record<string, unknown>;
  set: Record<string, unknown>;
  fields: Record<string, ["applied" | "candidate", unknown]>;
  existence?: true;
}): Promise<NewEvent[]> {
  const head = (await tail()) + 1;
  const source = head + 1;
  const items = Object.fromEntries(
    Object.entries(o.fields).flatMap(([f, [status, value]]) => [
      [`fields/${f}/0`, { status, value }],
      [`sources/${f}/0`, [{ kind: "value", source }]],
    ]),
  );
  const intent = o.target["intent"] as string;
  return [
    {
      type: "write.head",
      slot: SLOT,
      blocks: {
        ctx: ctxBlock,
        request: { sv: 1, sv_basis: "explicit", op_count: 1 },
        "ops/0/target": { table: o.table, row: o.row, ...o.target },
        ...Object.fromEntries(Object.entries(o.set).map(([f, v]) => [`ops/0/set/${f}`, v])),
      },
    },
    {
      type: "source.recorded",
      slot: SLOT,
      blocks: {
        target: {
          source_id: `s_${String(source).padStart(16, "0")}`,
          kind: "api_call",
          level: "agent_inferred",
          op_index: 0,
        },
        request: { intent },
      },
    },
    {
      type: "write.base",
      slot: SLOT,
      blocks: {
        target: {
          table: o.table,
          row: o.row,
          intent,
          sv: 1,
          cause: "request",
          op_index: 0,
          ...(o.target["created"] === true ? { created: true } : {}),
        },
        ...items,
        ...(o.existence ? { "existence/0": { status: "applied", scope: "whole" } } : {}),
        ...(o.existence ? { op_sources: [source] } : {}),
      },
    },
  ];
}

/** A meal created by its key (an op by external key creating its row: no ver, 09 §5.7). */
const byKey = (row: string, origin: string, id: string, energy: string) =>
  writeOp({
    table: "t1",
    row,
    target: { intent: "update", by_external_key: true, created: true },
    set: { f1: origin, f2: id, f3: energy },
    fields: { f1: ["applied", origin], f2: ["applied", id], f3: ["applied", energy] },
  });

const entries = () =>
  live.store.read(async (tx) =>
    (
      await tx.query(
        "SELECT table_id, key_values, holder_row, yielded_row, state, frozen_by FROM external_keys ORDER BY table_id, key_values",
      )
    ).rows.map((r) => ({ ...r })),
  );
async function stopped(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const x = e as { reason?: string; message?: string };
    return `${x.reason ?? ""}: ${x.message ?? String(e)}`;
  }
  return "applied";
}
const entry = (table: string, key: unknown[], holder: string) => ({
  table_id: table,
  key_values: JSON.stringify(key),
  holder_row: holder,
  yielded_row: null,
  state: "present",
  frozen_by: null,
});

beforeAll(async () => {
  live = await openReusable("saveslot-apply-external-key-");
  scratch = await openReusable("saveslot-apply-external-key-scratch-");
}, T);
afterAll(async () => {
  await live?.close();
  await scratch?.close();
}, T);
beforeEach(async () => {
  await live.reset();
  await scratch.reset();
  minute = 0;
  await createTenant(
    live.store,
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
}, T);

describe("the key index, as writes give rows their keys", () => {
  it(
    "a slot with keyed tables starts with none; a row created by its key holds it",
    async () => {
      expect(await entries()).toEqual([]);
      await run(await byKey(ROW, "band_app", "m-1", "600"));
      expect(await entries()).toEqual([entry("t1", ["band_app", "m-1"], ROW)]);
    },
    T,
  );

  it(
    "the key's values as stored: in the order of the table's key fields; an integer key",
    async () => {
      await run(await byKey(ROW, "z", "a", "1"));
      await run(
        await writeOp({
          table: "t2",
          row: ROW_B,
          target: { intent: "update", by_external_key: true, created: true },
          set: { f1: "2026-11-10", f2: "7" },
          fields: { f1: ["applied", "2026-11-10"], f2: ["applied", "7"] },
        }),
      );
      expect(await entries()).toEqual([entry("t1", ["z", "a"], ROW), entry("t2", ["7"], ROW_B)]);
    },
    T,
  );

  it(
    "a key given to a row without one: the row holds it from that write",
    async () => {
      await run(
        await writeOp({
          table: "t1",
          row: ROW_C,
          target: { intent: "insert", created: true },
          set: { f3: "500" },
          fields: { f3: ["applied", "500"] },
        }),
      );
      expect(await entries()).toEqual([]);
      await run(
        await writeOp({
          table: "t1",
          row: ROW_C,
          target: { intent: "update", ver: { op: 4, restore_count: 0, basis: "explicit" } },
          set: { f1: "band_app", f2: "m-2" },
          fields: { f1: ["applied", "band_app"], f2: ["applied", "m-2"] },
        }),
      );
      expect(await entries()).toEqual([entry("t1", ["band_app", "m-2"], ROW_C)]);
    },
    T,
  );

  it(
    "a revoked row still holds its key",
    async () => {
      await run(await byKey(ROW, "band_app", "m-1", "600"));
      await run(
        await writeOp({
          table: "t1",
          row: ROW,
          target: { intent: "revoke", ver: { op: 4, restore_count: 0, basis: "explicit" } },
          set: {},
          fields: {},
          existence: true,
        }),
      );
      const revoked = await live.store.read((tx) =>
        tx.query<{ revoked: unknown }>(`SELECT revoked FROM "t_t1_v1" WHERE row_id = $1`, [ROW]),
      );
      expect(revoked.rows[0]?.revoked).toBe(true);
      expect(await entries()).toEqual([entry("t1", ["band_app", "m-1"], ROW)]);
    },
    T,
  );

  it(
    "a key field's candidate gives no entry: it changes neither the row nor the index",
    async () => {
      await run(
        await writeOp({
          table: "t1",
          row: ROW_C,
          target: { intent: "insert", created: true },
          set: { f3: "500" },
          fields: { f3: ["applied", "500"] },
        }),
      );
      const stop = await stopped(
        run(
          await writeOp({
            table: "t1",
            row: ROW_C,
            target: { intent: "update", ver: { op: 4, restore_count: 0, basis: "explicit" } },
            set: { f1: "band_app", f2: "m-2" },
            fields: { f1: ["candidate", "band_app"], f2: ["candidate", "m-2"] },
          }),
        ),
      );
      expect(stop).toBe("applied");
      expect(await entries()).toEqual([]);
    },
    T,
  );

  it(
    "a second row with a key another holds: inconsistent, nothing written",
    async () => {
      await run(await byKey(ROW, "band_app", "m-1", "600"));
      const before = await tail();
      expect(await stopped(run(await byKey(ROW_B, "band_app", "m-1", "650")))).toMatch(
        new RegExp(`^inconsistent: .*${ROW_B} given a key of t1 that ${ROW} holds`),
      );
      expect(await tail()).toBe(before);
      expect(await entries()).toEqual([entry("t1", ["band_app", "m-1"], ROW)]);
    },
    T,
  );

  it(
    "a key field's item in effect without the whole key: inconsistent, nothing written",
    async () => {
      const before = await tail();
      const half = await writeOp({
        table: "t1",
        row: ROW,
        target: { intent: "update", by_external_key: true, created: true },
        set: { f1: "band_app", f3: "600" },
        fields: { f1: ["applied", "band_app"], f3: ["applied", "600"] },
      });
      expect(await stopped(run(half))).toMatch(
        new RegExp(`^inconsistent: .*${ROW} has a key field's item in effect, not its whole key`),
      );
      expect(await tail()).toBe(before);
      expect(await entries()).toEqual([]);
    },
    T,
  );

  it(
    "a key transferred from a revoked row (key_from) is not in this version",
    async () => {
      const events = await writeOp({
        table: "t1",
        row: ROW_C,
        target: {
          intent: "update",
          key_from: ROW,
          ver: { op: 4, restore_count: 0, basis: "explicit" },
        },
        set: { f1: "band_app", f2: "m-1" },
        fields: { f1: ["applied", "band_app"], f2: ["applied", "m-1"] },
      });
      expect(await stopped(run(events))).toMatch(
        /^not_implemented: .*transferring an external key is not in this version/,
      );
      expect(await entries()).toEqual([]);
    },
    T,
  );

  it(
    "replayed from an empty storage, the key index is the same",
    async () => {
      await run(await byKey(ROW, "band_app", "m-1", "600"));
      await run(await byKey(ROW_B, "band_app", "m-2", "650"));
      const r = await reconcileLog({ live: live.store, scratch: scratch.store });
      expect(r.mismatches).toEqual([]);
      expect(r.tables.find((t) => t.name === "external_keys")).toMatchObject({ rows: 2 });
    },
    T,
  );
});

describe("a key field in the set of a write by row (key_field_changed)", () => {
  const send = (row: string, ver: number, set: Record<string, unknown>) =>
    write(
      live.store,
      createOpsContext({
        tenant: TENANT,
        actor: USER,
        trigger: null,
        task: null,
        visibility: { kind: "all" },
        idempotency_key_window: 86_400_000,
        idempotency_window: 600_000,
        now: `2026-11-10T07:${String(minute++).padStart(2, "0")}:00.000Z`,
        confirmation: null,
      }),
      { sv: 1, ops: [{ intent: "update", table: "meals", row, ver: `v${ver}.0`, set }] },
    );
  async function refusal(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      const x = e as { code?: string; detail?: Record<string, unknown> };
      if (x.code === undefined) throw e;
      return { code: x.code, ...x.detail };
    }
    return "accepted";
  }

  it(
    "the key the row holds again is let through; another value, or by case, is refused",
    async () => {
      const op = (await tail()) + 1;
      await run(await byKey(ROW, "band_app", "m-1", "600"));
      expect(
        await send(ROW, op, { origin: "band_app", external_id: "m-1", energy: 610 }),
      ).toMatchObject({
        status: "saved",
      });
      // The row's version: the write just made (its head, the log's end less its source and base).
      const after = await tail();
      const ver = after - 2;
      for (const set of [
        { external_id: "m-2" },
        { origin: "Band_app" },
        { origin: "band_app", external_id: "m-1 " },
      ]) {
        expect(await refusal(send(ROW, ver, set))).toEqual({
          code: "invalid_argument",
          reason: "key_field_changed",
          param: `ops/0/set/${Object.keys(set).at(-1)}`,
        });
      }
      expect(await tail()).toBe(after);
      expect(await entries()).toEqual([entry("t1", ["band_app", "m-1"], ROW)]);
    },
    T,
  );

  it(
    "a row without a key is not given one through set",
    async () => {
      const op = (await tail()) + 1;
      await run(
        await writeOp({
          table: "t1",
          row: ROW_C,
          target: { intent: "insert", created: true },
          set: { f3: "500" },
          fields: { f3: ["applied", "500"] },
        }),
      );
      expect(await refusal(send(ROW_C, op, { origin: "band_app", external_id: "m-2" }))).toEqual({
        code: "invalid_argument",
        reason: "key_field_changed",
        param: "ops/0/set/origin",
      });
      expect(await entries()).toEqual([]);
      // Other fields: as before.
      expect(await send(ROW_C, op, { energy: 520 })).toMatchObject({ status: "saved" });
    },
    T,
  );
});

describe("an insert giving key fields: refused by the write path, nothing logged", () => {
  const send = (ops: Record<string, unknown>[]) =>
    write(
      live.store,
      createOpsContext({
        tenant: TENANT,
        actor: USER,
        trigger: null,
        task: null,
        visibility: { kind: "all" },
        idempotency_key_window: 86_400_000,
        idempotency_window: 600_000,
        now: `2026-11-10T08:${String(minute++).padStart(2, "0")}:00.000Z`,
        confirmation: null,
      }),
      { sv: 1, ops },
    );
  async function refusal(ops: Record<string, unknown>[]) {
    const before = await tail();
    try {
      await send(ops);
    } catch (e) {
      const x = e as { code?: string; detail?: Record<string, unknown> };
      if (x.code === undefined) throw e;
      expect(await tail()).toBe(before);
      expect(await entries()).toEqual([]);
      return { code: x.code, ...x.detail };
    }
    return "accepted";
  }

  it.each([
    [
      "the whole key",
      [
        {
          intent: "insert",
          table: "meals",
          set: { origin: "band_app", external_id: "m-1", energy: 1 },
        },
      ],
      "ops/0/set/origin",
    ],
    [
      "part of the key",
      [{ intent: "insert", table: "meals", set: { external_id: "m-1", energy: 1 } }],
      "ops/0/set/external_id",
    ],
    [
      "the same key twice in one request",
      [
        { intent: "insert", table: "cards", set: { on: "2026-11-10", number: 7 } },
        { intent: "insert", table: "cards", set: { on: "2026-11-10", number: 7 } },
      ],
      "ops/0/set/number",
    ],
  ])(
    "%s: insert_with_external_key",
    async (_, ops, param) => {
      expect(await refusal(ops)).toEqual({
        code: "invalid_argument",
        reason: "insert_with_external_key",
        param,
      });
    },
    T,
  );
});

describe("the key index across a switch", () => {
  const opsCtx = () =>
    createOpsContext({
      tenant: TENANT,
      actor: USER,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_key_window: 86_400_000,
      idempotency_window: 600_000,
      now: `2026-11-10T06:${String(minute++).padStart(2, "0")}:00.000Z`,
      confirmation: null,
    });
  // The slot's document as created above, without `meals`, which it drops.
  const document = {
    slot: "ledger",
    base_version: 1,
    timezone: COMPILED.timezone,
    tables: COMPILED.tables
      .filter((t) => t.id === "t2")
      .map((t) => ({
        name: t.name,
        kind: "base",
        description: t.description,
        time: { type: "event", field: "on" },
        fields: t.fields.map(({ id: _, ...f }) => f),
        external_key: ["number"],
      })),
    drop_tables: ["meals"],
  };

  it(
    "a switch dropping a keyed table, once confirmed, clears that table's entries only",
    async () => {
      await run(await byKey(ROW, "band_app", "m-1", "600"));
      await run(
        await writeOp({
          table: "t2",
          row: ROW_B,
          target: { intent: "update", by_external_key: true, created: true },
          set: { f1: "2026-11-10", f2: "7" },
          fields: { f1: ["applied", "2026-11-10"], f2: ["applied", "7"] },
        }),
      );
      const d = (await schemaDraft(live.store, opsCtx(), {
        document,
      })) as unknown as {
        outcome: string;
        changes: { change: string }[];
        item: { id: string; item_ver: string };
      };
      expect(d.changes.map((c) => c.change)).toEqual(["drop_table"]);
      // Destructive: confirmed first, the entries untouched meanwhile.
      expect(d.outcome).toBe("pending");
      expect(await entries()).toEqual([
        entry("t1", ["band_app", "m-1"], ROW),
        entry("t2", ["7"], ROW_B),
      ]);
      await resolve(live.store, opsCtx(), {
        id: d.item.id,
        decision: "confirm",
        item_ver: d.item.item_ver,
      });
      expect(await entries()).toEqual([entry("t2", ["7"], ROW_B)]);
      const r = await reconcileLog({ live: live.store, scratch: scratch.store });
      expect(r.mismatches).toEqual([]);
    },
    T,
  );
});
