// apply of write premises on a real store (09-event-format §5.7 前提块, §5.10 `premise.changed`;
// 02-architecture §8 `premise_decls`, `premise_edges`). The write path does not take `premises` yet
// (they open with the detection), so the declarations here are put into a head by hand; the rest of
// each operation is what judge and the encoder give.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApplyError,
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
  type LoggedEvent,
  SLOT,
} from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgliteTenantStore } from "./backend.ts";
import { testBackend } from "./testing/test-backend.fixture.ts";

const T = 60_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
// Two premise targets and the entity that rests on them.
const TA = `e_${"3".repeat(26)}`;
const TB = `e_${"4".repeat(26)}`;
const DEP = `e_${"5".repeat(26)}`;
const FILLER = `e_${"9".repeat(26)}`;
const DEP1 = `e_${"6".repeat(26)}`;
const DEP2 = `e_${"7".repeat(26)}`;
const DEP3 = `e_${"8".repeat(26)}`;
const DEP4 = `e_${"2".repeat(26)}`;
const d = (md: string) => `2026-${md}` as `${number}-${number}-${number}`;

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
      fields: [
        { id: "f2", name: "b", type: "text", required: true, description: "b" },
        { id: "f3", name: "c", type: "text", description: "c" },
      ],
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
const SHAPE = {
  kind: "state" as const,
  fields: ["f2", "f3"],
  valued: ["f2"],
  required: ["f2"],
  groups: [],
};
const ctxOf = (entity: string) => ({
  table: "t2" as never,
  target: { entity: entity as never },
  shape: SHAPE as never,
  granularity: "date" as const,
});
const CTX = {
  now: "2026-11-10T05:00:00.000Z",
  today: "2026-11-10",
  ruleset_version: 1,
  policy_version: 1,
  literal_checker: "literal@1",
};

const insertAt = (op: number, value: string): JudgeInput =>
  ({
    kind: "write",
    op,
    index: 0,
    event: op + 1,
    ruleset: 1,
    seen: op - 1,
    seenExplicit: false,
    valid: { from: { mode: "given", value: d("10-01") }, to: { mode: "open" } },
    now: d("11-05"),
    fields: { f2: { value } },
  }) as JudgeInput;

let root: string;
let store: PgliteTenantStore;
let minute = 0;

const run = (events: NewEvent[]) =>
  store.write(async (tx) => {
    const now = new Date(Date.UTC(2026, 10, 10, 5) + 1000 * minute++).toISOString() as never;
    const op = await appendOperation(tx, { actor: USER as never, now, events });
    await applyEvents(tx, eventsOf(op));
    return op;
  });
const filler: NewEvent = {
  type: "write.head",
  slot: SLOT,
  blocks: {
    ctx: CTX,
    request: { sv: 1, sv_basis: "explicit", op_count: 1 },
    "ops/0/target": { table: "t2", entity: FILLER, intent: "update" },
  },
};
/** Appends an operation whose head is at `head`, filling the log up to it. */
async function at(head: number, evs: readonly Omit<LoggedEvent, "seq">[]) {
  for (let tail = (await store.read(readTail))?.seq ?? 0; tail < head - 1; tail++)
    await run([filler]);
  const op = await run(
    evs.map((e) => ({ type: e.type as never, slot: SLOT, blocks: e.blocks as never })),
  );
  expect(op.events[0]?.seq).toBe(head);
  return op;
}
/** An entity created by a request of one op at `op`. */
async function created(entity: string, op: number, value: string) {
  const inputs = [insertAt(op, value)];
  const { judgements } = replay(SHAPE as never, inputs);
  return at(op, eventsOfRequest(ctxOf(entity), inputs, judgements, "insert"));
}

const decls = () =>
  store.read((tx) =>
    tx.query(
      `SELECT op::int, op_index, decl_index, dep_table, dep_row, target_table, target_row, fields,
              range_kind, valid, seen_op::int, seen_restore_count, state, reason, since::int, declarer
       FROM premise_decls ORDER BY op, op_index, decl_index`,
    ),
  );
const edges = () =>
  store.read((tx) =>
    tx.query(
      `SELECT item_event::int, field_id, k, target, decl_op::int, decl_op_index, decl_index
       FROM premise_edges ORDER BY item_event, field_id, k, target`,
    ),
  );

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "saveslot-apply-premises-"));
  store = await testBackend().open({ kind: "pglite", dir: join(root, "tenant") }, { create: true });
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
}, T);

afterAll(async () => {
  await store?.close();
  rmSync(root, { recursive: true, force: true });
}, T);

describe("apply of write premises", () => {
  it(
    "declarations, the cover of an op's own items, restatement over them, a state change and a clearing",
    async () => {
      await created(TA, 10, "release 12-01");
      await created(TB, 12, "budget 5000");

      // Operation 20 creates DEP resting on TA's f2 from now on, and on all of TB over November.
      const inputs = [insertAt(20, "plan")];
      const { judgements } = replay(SHAPE as never, inputs);
      const [head, ...rest] = eventsOfRequest(ctxOf(DEP), inputs, judgements, "insert");
      const withPremises = {
        ...(head as LoggedEvent),
        blocks: {
          ...(head as LoggedEvent).blocks,
          "ops/0/premises/0": {
            table: "t2",
            entity: TA,
            fields: ["f2"],
            ver: { op: 10, restore_count: 0, basis: "explicit" },
            range: "from_now",
            state: "current",
          },
          "ops/0/premises/1": {
            table: "t2",
            entity: TB,
            ver: { op: 12, restore_count: 0, basis: "fallback" },
            range: "given",
            state: "current",
          },
          "ops/0/premise_valid/1": {
            during: { from: d("11-01"), to: d("12-01") },
            // Where the stretch came from is not part of it.
            deps: [{ event: 13, field: "f2", k: 0 }],
          },
        },
      };
      const op20 = await at(20, [withPremises, ...rest]);
      const base = op20.events.find((e) => e.type === "write.base");
      const items = (base?.blocks ?? [])
        .map((b) => /^(?:fields\/(f\d+)|(existence))\/(\d+)$/.exec(b.path))
        .filter((m) => m !== null)
        .map((m) => ({ field_id: (m[1] ?? m[2]) as string, k: Number(m[3]) }));
      expect(items.length).toBeGreaterThan(0);

      const decl = {
        op: 20,
        op_index: 0,
        dep_table: "t2",
        dep_row: DEP,
        target_table: "t2",
        seen_restore_count: 0,
        state: "current",
        reason: null,
        since: null,
        declarer: USER,
      };
      expect((await decls()).rows).toEqual([
        {
          ...decl,
          decl_index: 0,
          target_row: TA,
          fields: '["f2"]',
          range_kind: "from_now",
          valid: null,
          seen_op: 10,
        },
        {
          ...decl,
          decl_index: 1,
          target_row: TB,
          fields: null,
          range_kind: "given",
          valid: '{"during":{"from":"2026-11-01","to":"2026-12-01"}}',
          seen_op: 12,
        },
      ]);
      // Every item of the op's write.base, covered by each of the op's declarations.
      const own = (decl_index: number, target: string) =>
        items.map((i) => ({
          item_event: base?.seq,
          ...i,
          target,
          decl_op: 20,
          decl_op_index: 0,
          decl_index,
        }));
      const byKey = (rows: readonly Record<string, unknown>[]) =>
        [...rows].sort((x, y) =>
          `${x["item_event"]}/${x["field_id"]}/${x["k"]}/${x["target"]}` <
          `${y["item_event"]}/${y["field_id"]}/${y["k"]}/${y["target"]}`
            ? -1
            : 1,
        );
      expect(byKey((await edges()).rows)).toEqual(byKey([...own(0, TA), ...own(1, TB)]));

      // Operation 30 restates DEP on TA: no write.base; the items it covers now point at it for
      // TA, and TB's edges stay as they were.
      const covered = items[0] as { field_id: string; k: number };
      const cover =
        covered.field_id === "existence"
          ? { event: base?.seq, existence: covered.k }
          : { event: base?.seq, field: covered.field_id, k: covered.k };
      await at(30, [
        {
          type: "write.head",
          blocks: {
            ctx: CTX,
            request: { sv: 1, sv_basis: "explicit", op_count: 1 },
            "ops/0/target": {
              table: "t2",
              entity: DEP,
              intent: "update",
              ver: { op: 20, restore_count: 0, basis: "explicit" },
            },
            "ops/0/premises/0": {
              table: "t2",
              entity: TA,
              ver: { op: 10, restore_count: 0, basis: "explicit" },
              range: "from_now",
              state: "current",
            },
            "ops/0/premise_covers": [cover],
          },
        },
      ]);
      const after30 = (await edges()).rows;
      const onTa = (rows: readonly Record<string, unknown>[]) =>
        rows.filter(
          (r) => r["target"] === TA && r["field_id"] === covered.field_id && r["k"] === covered.k,
        );
      expect(onTa(after30)).toEqual([
        {
          item_event: base?.seq,
          field_id: covered.field_id,
          k: covered.k,
          target: TA,
          decl_op: 30,
          decl_op_index: 0,
          decl_index: 0,
        },
      ]);
      expect(byKey(after30.filter((r) => r["target"] === TB))).toEqual(byKey(own(1, TB)));

      // Operation 40: TA's value changes; the declaration of 20 is marked, the one of 30 is not.
      const changed: Omit<LoggedEvent, "seq"> = {
        type: "premise.changed",
        blocks: {
          "targets/0": {
            table: "t2",
            entity: TA,
            by_event: 40,
            changed: [{ op: 20, i: 0, j: 0, reason: "update" }],
          },
        },
      };
      await at(40, [filler as never, changed]);
      const states = (await decls()).rows.map((r) => [
        r["op"],
        r["decl_index"],
        r["state"],
        r["reason"],
        r["since"],
      ]);
      expect(states).toEqual([
        [20, 0, "changed", "update", 40],
        [20, 1, "current", null, null],
        [30, 0, "current", null, null],
      ]);
      // It goes back: matched.
      await at(50, [
        filler as never,
        {
          type: "premise.changed",
          blocks: {
            "targets/0": {
              table: "t2",
              entity: TA,
              by_event: 50,
              matched: [{ op: 20, i: 0, j: 0 }],
            },
          },
        },
      ]);
      expect((await decls()).rows[0]).toMatchObject({
        state: "current",
        reason: null,
        since: null,
      });

      // Operation 60 clears DEP's premises: a clearing entry on the item it covers.
      await at(60, [
        {
          type: "write.head",
          blocks: {
            ctx: CTX,
            request: { sv: 1, sv_basis: "explicit", op_count: 1 },
            "ops/0/target": {
              table: "t2",
              entity: DEP,
              intent: "update",
              ver: { op: 20, restore_count: 0, basis: "explicit" },
            },
            "ops/0/premises_cleared": true,
            "ops/0/premise_covers": [cover],
          },
        },
      ]);
      const cleared = (await edges()).rows.filter((r) => r["target"] === "*");
      expect(cleared).toEqual([
        {
          item_event: base?.seq,
          field_id: covered.field_id,
          k: covered.k,
          target: "*",
          decl_op: 60,
          decl_op_index: 0,
          decl_index: null,
        },
      ]);
      // The declarations stay: a clearing makes them void on the items it covers, it does not
      // delete them.
      expect((await decls()).rows).toHaveLength(3);
    },
    T,
  );

  it(
    "a state change of a declaration that is not there stops apply",
    async () => {
      const tail = (await store.read(readTail))?.seq ?? 0;
      const e = await at(tail + 1, [
        filler as never,
        {
          type: "premise.changed",
          blocks: {
            "targets/0": {
              table: "t2",
              entity: TA,
              by_event: tail + 1,
              changed: [{ op: 5, i: 0, j: 0, reason: "update" }],
            },
          },
        },
      ]).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ApplyError);
      expect((e as ApplyError).reason).toBe("inconsistent");
    },
    T,
  );

  it(
    "a repointing, which comes with deletion, is not applied yet",
    async () => {
      const tail = (await store.read(readTail))?.seq ?? 0;
      const e = await at(tail + 1, [
        filler as never,
        {
          type: "premise.changed",
          blocks: {
            "targets/0": {
              table: "t2",
              entity: TA,
              by_event: tail + 1,
              repointed: [{ op: 20, i: 0, j: 0 }],
            },
          },
        },
      ]).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ApplyError);
      expect((e as ApplyError).reason).toBe("not_implemented");
    },
    T,
  );
});

/** A premise on TA's f2 from now on, from #10. */
const onTa = {
  table: "t2",
  entity: TA,
  fields: ["f2"],
  ver: { op: 10, restore_count: 0, basis: "explicit" },
  range: "from_now",
  state: "current",
};
/** An op of a head that restates or clears `entity` (no write.base), covering `covers`. */
const headOp = (i: number, entity: string, seen: object, extra: Record<string, unknown>) => ({
  [`ops/${i}/target`]: { table: "t2", entity, intent: "update", ver: seen },
  ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`ops/${i}/${k}`, v])),
});
/** The request creating `entity` at `op` with a premise on TA, and further ops in its head. */
async function createdResting(
  entity: string,
  op: number,
  more: (base: number) => object,
  ops: number,
) {
  const inputs = [insertAt(op, "plan")];
  const { judgements } = replay(SHAPE as never, inputs);
  const [head, ...rest] = eventsOfRequest(ctxOf(entity), inputs, judgements, "insert");
  const base = rest.find((e) => e.type === "write.base")?.seq as number;
  const h = head as LoggedEvent;
  return at(op, [
    {
      ...h,
      blocks: {
        ...h.blocks,
        request: { sv: 1, sv_basis: "explicit", op_count: ops },
        "ops/0/premises/0": onTa,
        ...more(base),
      },
    },
    ...rest,
  ]).then(() => base);
}
const edgesOn = async (event: number) =>
  (await edges()).rows
    .filter((r) => r["item_event"] === event && r["field_id"] === "f2" && r["k"] === 0)
    .map((r) => [r["target"], r["decl_op"], r["decl_op_index"], r["decl_index"]]);

describe("which declaration is in force on an item: the latest by (operation, op index), not by arrival", () => {
  it(
    "op 1 restating what op 0 of its request created: the write.base of op 0, applied after the head, does not take it back",
    async () => {
      const base = await createdResting(
        DEP1,
        100,
        (b) =>
          headOp(
            1,
            DEP1,
            { op: 100, restore_count: 0, basis: "same_request" },
            {
              "premises/0": onTa,
              premise_covers: [{ event: b, field: "f2", k: 0 }],
            },
          ),
        2,
      );
      expect(await edgesOn(base)).toEqual([[TA, 100, 1, 0]]);
    },
    T,
  );

  it(
    "created, cleared, then restated in one request: the restatement is later than the clearing",
    async () => {
      const seen = { op: 200, restore_count: 0, basis: "same_request" };
      const base = await createdResting(
        DEP2,
        200,
        (b) => ({
          ...headOp(1, DEP2, seen, {
            premises_cleared: true,
            premise_covers: [{ event: b, field: "f2", k: 0 }],
          }),
          ...headOp(2, DEP2, seen, {
            "premises/0": onTa,
            premise_covers: [{ event: b, field: "f2", k: 0 }],
          }),
        }),
        3,
      );
      // The `*` entry of op 1 and TA's of op 2: TA's is later, so it is in force.
      expect(await edgesOn(base)).toEqual([
        ["*", 200, 1, null],
        [TA, 200, 2, 0],
      ]);
    },
    T,
  );

  it(
    "ops 2 and 10 of one head both restating an item: op 10's, though its blocks come first in path order",
    async () => {
      await created(DEP3, 290, "plan");
      const base = 291;
      const seen = { op: 290, restore_count: 0, basis: "explicit" };
      const blocks: Record<string, unknown> = {
        ctx: CTX,
        request: { sv: 1, sv_basis: "explicit", op_count: 11 },
      };
      for (let i = 0; i <= 10; i++)
        Object.assign(
          blocks,
          i === 2 || i === 10
            ? headOp(i, DEP3, seen, {
                "premises/0": onTa,
                premise_covers: [{ event: base, field: "f2", k: 0 }],
              })
            : { [`ops/${i}/target`]: { table: "t2", entity: FILLER, intent: "update" } },
        );
      await at(300, [{ type: "write.head", blocks }]);
      expect(await edgesOn(base)).toEqual([[TA, 300, 10, 0]]);
      // A later operation's declaration does take it over.
      await at(310, [
        {
          type: "write.head",
          blocks: {
            ctx: CTX,
            request: { sv: 1, sv_basis: "explicit", op_count: 1 },
            ...headOp(0, DEP3, seen, {
              "premises/0": onTa,
              premise_covers: [{ event: base, field: "f2", k: 0 }],
            }),
          },
        },
      ]);
      expect(await edgesOn(base)).toEqual([[TA, 310, 0, 0]]);
    },
    T,
  );
});

describe("an item premise_covers names that the op cannot cover stops apply", () => {
  /** The ApplyError of an operation at `op`, or what it threw. */
  const refused = (op: number, evs: readonly Omit<LoggedEvent, "seq">[]) =>
    at(op, evs).then(
      () => "applied",
      (e: unknown) =>
        e instanceof ApplyError ? `${e.reason}: ${e.message.replace(/^.*?: /, "")}` : e,
    );
  const restating = (op: number, entity: string, covers: object[]) => ({
    type: "write.head",
    blocks: {
      ctx: CTX,
      request: { sv: 1, sv_basis: "explicit", op_count: 1 },
      ...headOp(
        0,
        entity,
        { op: op - 10, restore_count: 0, basis: "explicit" },
        {
          "premises/0": onTa,
          premise_covers: covers,
        },
      ),
    },
  });

  it(
    "an event not in the log, an item of another row",
    async () => {
      expect(
        await refused(400, [restating(400, DEP1, [{ event: 99999, field: "f2", k: 0 }])]),
      ).toBe("inconsistent: ops/0/premise_covers: item 99999/f2/0 is not an item in the log");
      // DEP3's item (291), covered by an op on DEP1.
      expect(await refused(410, [restating(410, DEP1, [{ event: 291, field: "f2", k: 0 }])])).toBe(
        "inconsistent: ops/0/premise_covers: item 291/f2/0 is not on the op's target row",
      );
      // An item that is not there in an event that is.
      expect(await refused(420, [restating(420, DEP3, [{ event: 291, field: "f3", k: 0 }])])).toBe(
        "inconsistent: ops/0/premise_covers: item 291/f3/0 is not an item in the log",
      );
    },
    T,
  );

  it(
    "an item of a later op of the same request",
    async () => {
      // Op 1 creates DEP4; op 0, before it, restates DEP4 covering what op 1 writes.
      const input = { ...insertAt(430, "plan"), index: 1, event: 431 } as JudgeInput;
      const { judgements } = replay(SHAPE as never, [input]);
      const [head, ...rest] = eventsOfRequest(ctxOf(DEP4), [input], judgements, "insert");
      const base = rest.find((e) => e.type === "write.base")?.seq as number;
      const h = head as LoggedEvent;
      expect(
        await refused(430, [
          {
            ...h,
            blocks: {
              ...h.blocks,
              request: { sv: 1, sv_basis: "explicit", op_count: 2 },
              ...headOp(
                0,
                DEP4,
                { op: 430, restore_count: 0, basis: "same_request" },
                {
                  "premises/0": onTa,
                  premise_covers: [{ event: base, field: "f2", k: 0 }],
                },
              ),
            },
          },
          ...rest,
        ]),
      ).toBe(`inconsistent: ops/0/premise_covers: item ${base}/f2/0 is not before the op`);
    },
    T,
  );
});
