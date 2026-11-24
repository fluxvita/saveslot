// Writing a ref field on PGlite (03-data-model/04-write-and-read «写入 ref 字段时»; «判定顺序» step 5;
// 04-contract `resolve`): the target must exist, be in the table the field names, not be revoked,
// and, an entity, have a value over some stretch. Only what the write gives and takes effect is
// checked; a corroboration, a candidate, an awaiting write are not, a decision taking one is.
// Refusals are compared whole, and nothing is written.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  pending as pending$,
  readBufferOf,
  readTail,
} from "@fluxvita/saveslot-kernel";
import {
  COMPILED_V1,
  createSlotEvents,
  resolveInTx,
  writeInTx,
} from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 60_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const COMPILED = {
  ...COMPILED_V1,
  tables: [
    {
      id: "t1",
      name: "accounts",
      kind: "base",
      description: "accounts over time",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t1_v1" },
      fields: [{ id: "f1", name: "name", type: "text", required: true, description: "name" }],
    },
    {
      id: "t2",
      name: "payments",
      kind: "base",
      description: "payments",
      time: { type: "none" },
      physical: { table: "t_t2_v1" },
      fields: [
        { id: "f2", name: "memo", type: "text", required: true, description: "memo" },
        {
          id: "f3",
          name: "account",
          type: "ref",
          description: "paid from",
          ref: { table: "t1", target: "entity" },
        },
        {
          id: "f4",
          name: "note",
          type: "ref",
          description: "a note",
          ref: { table: "t3", target: "row" },
        },
      ],
    },
    {
      id: "t3",
      name: "notes",
      kind: "base",
      description: "notes",
      time: { type: "none" },
      physical: { table: "t_t3_v1" },
      fields: [{ id: "f5", name: "text", type: "text", required: true, description: "text" }],
    },
    {
      id: "t4",
      name: "plans",
      kind: "base",
      description: "plans over time",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t4_v1" },
      fields: [
        { id: "f6", name: "label", type: "text", required: true, description: "label" },
        {
          id: "f7",
          name: "account",
          type: "ref",
          description: "charged to",
          ref: { table: "t1", target: "entity" },
        },
      ],
    },
  ],
};
const CHANGES = [
  { target: { slot: true }, change: "create_slot" },
  { target: { table: "t1" }, change: "add_table" },
  { target: { table: "t2" }, change: "add_table" },
  { target: { table: "t3" }, change: "add_table" },
  { target: { table: "t4" }, change: "add_table" },
].map((c) => ({
  ...c,
  class: "create",
  compatible_with_old_writes: true,
  destructive: false,
  auto: true,
}));

let s: ReusableStore;
let minute = 0;
let ids = 0;
const now = () => {
  minute++;
  return `2026-11-05T0${Math.floor(minute / 60) % 10}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
};
const newId = (kind: "row" | "entity" | "source" | "item" | "partition") => {
  ids++;
  const n = String(ids).padStart(kind === "row" || kind === "entity" ? 26 : 16, "0");
  return `${{ row: "r_", entity: "e_", source: "s_", item: "pi_", partition: "p_" }[kind]}${n}`;
};
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_key_window: 86_400_000,
    idempotency_window: 600_000,
    now: now(),
    confirmation: null,
  });

type Receipt = {
  ops: {
    target: { row?: string; entity?: string };
    ver: string;
    fields: Record<string, unknown>;
  }[];
  pending: { id: string; type: string; item_ver?: string }[];
};

/** Sends `params` through the pipeline; the error, if refused. */
async function send(params: unknown): Promise<Receipt & Record<string, unknown>> {
  try {
    return (await s.store.write((tx) =>
      writeInTx(tx, {
        actor: USER as never,
        task: null,
        now: now(),
        windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
        visibility: { kind: "all" },
        params,
        newId,
        reads: readBufferOf(s.store),
      }),
    )) as never;
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { refused: x.code, ...(x.detail ?? {}) } as never;
  }
}

/** Resolves an item through the pipeline; the error, if refused. */
async function resolve(params: unknown): Promise<Record<string, unknown>> {
  try {
    return (await s.store.write((tx) =>
      resolveInTx(tx, {
        actor: USER as never,
        task: null,
        now: now(),
        windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
        visibility: { kind: "all" },
        params,
        newId,
        reads: readBufferOf(s.store),
      }),
    )) as never;
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { refused: x.code, ...(x.detail ?? {}) };
  }
}

const tail = async () => (await s.store.read(readTail))?.seq ?? 0;
/** Refused as `expected`, with nothing written. */
const refused = async (
  run: () => Promise<Record<string, unknown>>,
  expected: Record<string, unknown>,
) => {
  const before = await tail();
  expect(await run()).toEqual(expected);
  expect(await tail()).toBe(before);
};
const saved = (r: Record<string, unknown>) => expect(r["refused"]).toBeUndefined();
const itemOf = async (id: string) =>
  (await pending$(s.store, ctx(), { id })) as unknown as { status: string };

const ver = (r: Receipt, i = 0) => r.ops[i]?.ver as string;
const entityOf = (r: Receipt, i = 0) => r.ops[i]?.target.entity as string;
const rowOf = (r: Receipt, i = 0) => r.ops[i]?.target.row as string;

const account = (name = "cash") =>
  send({ sv: 1, ops: [{ intent: "insert", table: "accounts", set: { name } }] });
const note = (text = "n") =>
  send({ sv: 1, ops: [{ intent: "insert", table: "notes", set: { text } }] });
const pay = (set: Record<string, unknown>) =>
  send({ sv: 1, ops: [{ intent: "insert", table: "payments", set: { memo: "m", ...set } }] });
/**
 * A revoke carried out: one still referred to awaits confirmation (high impact ②, 05-time
 * «高影响写入»), confirmed here so that the target is revoked for the cases below.
 */
async function carriedOut(r: Receipt & Record<string, unknown>) {
  const item = (r.pending ?? []).find((p) => p.type === "awaiting_confirmation");
  if (item !== undefined)
    await resolve({ id: item.id, decision: "confirm", item_ver: item.item_ver });
  return r;
}
const revokeAccount = async (a: Receipt) =>
  carriedOut(
    await send({
      sv: 1,
      ops: [{ intent: "revoke", table: "accounts", entity: entityOf(a), ver: ver(a) }],
    }),
  );
const revokeNote = async (n: Receipt) =>
  carriedOut(
    await send({ sv: 1, ops: [{ intent: "revoke", table: "notes", row: rowOf(n), ver: ver(n) }] }),
  );
/** The detail of a payment op whose ref field fails. */
const bad = (field: string, code: string, op = 0) => ({
  op,
  table: "ledger.payments",
  field,
  code,
});
const failed = (...details: unknown[]) => ({
  refused: "validation_failed",
  reason: "write",
  details,
});

beforeAll(async () => {
  s = await openReusable("saveslot-write-refs-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  readBufferOf(s.store).take();
  ids = 0;
  await createTenant(s.store, ctx());
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-05T00:00:30.000Z" as never,
      events: createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }),
    });
    await applyEvents(tx, eventsOf(op));
  });
}, T);

describe("a write's ref fields (04-write-and-read «写入 ref 字段时»)", () => {
  it(
    "a target that is there: written; null is not checked",
    async () => {
      const a = await account();
      const n = await note();
      saved(await pay({ account: entityOf(a), note: rowOf(n) }));
      saved(await pay({ account: null, note: null }));
    },
    T,
  );

  it(
    "a target that does not exist: ref_not_found, the row form and the entity form",
    async () => {
      await refused(
        () => pay({ account: `e_${"9".repeat(26)}` }),
        failed(bad("account", "ref_not_found")),
      );
      await refused(
        () => pay({ note: `r_${"9".repeat(26)}` }),
        failed(bad("note", "ref_not_found")),
      );
    },
    T,
  );

  it(
    "a target in another table: ref_wrong_table, a detail for each field of the op",
    async () => {
      const a = await account();
      const n = await note();
      // A row where an entity is named, an entity where a row is: each in another table.
      await refused(
        () => pay({ account: rowOf(n), note: entityOf(a) }),
        failed(bad("account", "ref_wrong_table"), bad("note", "ref_wrong_table")),
      );
      // A payment is a row, of the payments table: not a note.
      const p = await pay({});
      await refused(() => pay({ note: rowOf(p) }), failed(bad("note", "ref_wrong_table")));
    },
    T,
  );

  it(
    "a revoked row, and an entity with no value over any stretch: ref_not_found",
    async () => {
      const n = await note();
      await revokeNote(n);
      await refused(() => pay({ note: rowOf(n) }), failed(bad("note", "ref_not_found")));
      const a = await account();
      await revokeAccount(a);
      await refused(() => pay({ account: entityOf(a) }), failed(bad("account", "ref_not_found")));
    },
    T,
  );

  it(
    "an entity with a value only over a past stretch is there",
    async () => {
      const a = await send({
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "accounts",
            valid_from: "2026-10-01",
            valid_to: "2026-10-10",
            set: { name: "old" },
          },
        ],
      });
      saved(await pay({ account: entityOf(a) }));
    },
    T,
  );

  it(
    "the ops before it in the request count: revoked there, ref_not_found at the later op",
    async () => {
      const n = await note();
      await refused(
        () =>
          send({
            sv: 1,
            ops: [
              { intent: "revoke", table: "notes", row: rowOf(n), ver: ver(n) },
              { intent: "insert", table: "payments", set: { memo: "m", note: rowOf(n) } },
            ],
          }),
        failed(bad("note", "ref_not_found", 1)),
      );
    },
    T,
  );

  it(
    "inserted by an op before it in the request: written",
    async () => {
      // The IDs are this case's own sequence: the note inserted first takes the next one.
      const r = await send({
        sv: 1,
        ops: [
          { intent: "insert", table: "notes", set: { text: "n" } },
          {
            intent: "insert",
            table: "payments",
            set: { memo: "m", note: `r_${"1".padStart(26, "0")}` },
          },
        ],
      });
      saved(r);
      expect(rowOf(r, 0)).toBe(`r_${"1".padStart(26, "0")}`);
    },
    T,
  );

  it(
    "restating a value whose target was revoked since is not checked (a no-op); changing to it is",
    async () => {
      const n = await note();
      const p = await pay({ note: rowOf(n) });
      await revokeNote(n);
      // The same value again is a no-op. A corroboration is too (not checked), but a write makes
      // one only with evidence pointed at by field, which comes with `evidence_by_field`.
      const noop = await send({
        sv: 1,
        evidence: [{ kind: "user_message", text: "still that note" }],
        ops: [{ intent: "update", table: "payments", row: rowOf(p), set: { note: rowOf(n) } }],
      });
      saved(noop);
      expect(noop.ops[0]?.fields["note"]).toMatchObject({ result: "noop" });
      // Changing it to that target is a write of it: refused.
      const other = await pay({});
      await refused(
        () =>
          send({
            sv: 1,
            ops: [
              {
                intent: "update",
                table: "payments",
                row: rowOf(other),
                ver: ver(other),
                set: { note: rowOf(n) },
              },
            ],
          }),
        failed(bad("note", "ref_not_found")),
      );
    },
    T,
  );
});

describe("what a write gives but does not take effect, or puts back", () => {
  it(
    "a candidate naming a target that does not exist is written as a candidate",
    async () => {
      const n = await note();
      const p = await pay({});
      await send({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "payments",
            row: rowOf(p),
            ver: ver(p),
            set: { note: rowOf(n) },
          },
        ],
      });
      const c = await send({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "payments",
            row: rowOf(p),
            ver: ver(p),
            set: { note: `r_${"9".repeat(26)}` },
          },
        ],
      });
      saved(c);
      expect(c.ops[0]?.fields["note"]).toMatchObject({ result: "candidate" });
      // Where the note was not changed since, the same write takes effect: checked, refused.
      // Inserted with other content: the same content again would be a replay of the first.
      const q = await pay({ memo: "q" });
      await refused(
        () =>
          send({
            sv: 1,
            ops: [
              {
                intent: "update",
                table: "payments",
                row: rowOf(q),
                ver: ver(q),
                set: { note: `r_${"9".repeat(26)}` },
              },
            ],
          }),
        failed(bad("note", "ref_not_found")),
      );
    },
    T,
  );

  it(
    "an awaiting write naming an entity that does not exist awaits confirmation",
    async () => {
      const e = await send({
        sv: 1,
        ops: [{ intent: "insert", table: "plans", valid_from: "2026-11-01", set: { label: "x" } }],
      });
      const v = await send({
        sv: 1,
        ops: [
          {
            intent: "revoke",
            table: "plans",
            entity: entityOf(e),
            ver: ver(e),
            valid_from: "2026-11-10",
            valid_to: "2026-11-15",
          },
        ],
      });
      const w = await send({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "plans",
            entity: entityOf(e),
            ver: ver(v),
            valid_from: "2026-11-05",
            valid_to: "2026-11-20",
            set: { label: "y", account: `e_${"9".repeat(26)}` },
          },
        ],
      });
      saved(w);
      expect(w.pending[0]?.type).toBe("awaiting_confirmation");
    },
    T,
  );

  /** A payment whose note was changed from `n1` to `n2`; `u` is that change. */
  const changed = async () => {
    const n1 = await note("one");
    const n2 = await note("two");
    const p = await pay({ note: rowOf(n1) });
    const u = await send({
      sv: 1,
      ops: [
        {
          intent: "update",
          table: "payments",
          row: rowOf(p),
          ver: ver(p),
          set: { note: rowOf(n2) },
        },
      ],
    });
    return { n1, p, u };
  };
  const undo = (p: Receipt, u: Record<string, unknown>, more: Record<string, unknown> = {}) =>
    send({
      sv: 1,
      ops: [{ table: "payments", row: rowOf(p), revert: { undo: u["seq"], ...more } }],
    });

  it(
    "an undo putting back a value whose target was revoked since: ref_not_found, nothing written",
    async () => {
      const { n1, p, u } = await changed();
      await revokeNote(n1);
      await refused(() => undo(p, u), failed(bad("note", "ref_not_found")));
    },
    T,
  );

  it(
    "the same undo once the revoke of its target is undone: written",
    async () => {
      const { n1, p, u } = await changed();
      const v = await revokeNote(n1);
      saved(
        await send({
          sv: 1,
          ops: [{ table: "notes", row: rowOf(n1), revert: { undo: v["seq"] } }],
        }),
      );
      const r = await undo(p, u);
      saved(r);
      expect(r.ops[0]?.fields["note"]).toMatchObject({ result: "applied", after: rowOf(n1) });
    },
    T,
  );

  it(
    "confirming an awaiting undo whose write-back names a target revoked since: ref_not_found, the item stays open",
    async () => {
      const { n1, p, u } = await changed();
      // A later write of the note: an undo taking it back too (include_later) awaits confirmation.
      const n3 = await note("three");
      await send({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "payments",
            row: rowOf(p),
            ver: ver(u as Receipt),
            set: { note: rowOf(n3) },
          },
        ],
      });
      const w = await undo(p, u, { include_later: true });
      expect(w.pending[0]?.type).toBe("awaiting_confirmation");
      const item = w.pending[0] as { id: string };
      await revokeNote(n1);
      const d = (await pending$(s.store, ctx(), { id: item.id })) as unknown as {
        item_ver: string;
      };
      await refused(
        () => resolve({ id: item.id, decision: "confirm", item_ver: d.item_ver }),
        failed({ table: "ledger.payments", field: "note", code: "ref_not_found" }),
      );
      expect((await itemOf(item.id)).status).toBe("open");
    },
    T,
  );
});

describe("a revert writing back a different value on each stretch (state tables)", () => {
  /**
   * A plan charged to `x` from 11-01 and to `z` from 11-10, then to `y` over both by one write
   * (acknowledged: it erases the change point at 11-10). Undoing that write puts back `x` on the
   * first stretch and `z` on the second.
   */
  const split = async () => {
    const x = await account("x");
    const z = await account("z");
    const y = await account("y");
    const e = await send({
      sv: 1,
      ops: [
        {
          intent: "insert",
          table: "plans",
          valid_from: "2026-11-01",
          set: { label: "p", account: entityOf(x) },
        },
      ],
    });
    const second = await send({
      sv: 1,
      ops: [
        {
          intent: "update",
          table: "plans",
          entity: entityOf(e),
          ver: ver(e),
          valid_from: "2026-11-10",
          set: { account: entityOf(z) },
        },
      ],
    });
    const w = await send({
      sv: 1,
      ops: [
        {
          intent: "update",
          table: "plans",
          entity: entityOf(e),
          ver: ver(second),
          valid_from: "2026-11-01",
          valid_to: "open",
          acknowledge: ["overwrite"],
          set: { account: entityOf(y) },
        },
      ],
    });
    saved(w);
    expect(w.pending).toEqual([]);
    const undo = () =>
      send({ sv: 1, ops: [{ table: "plans", entity: entityOf(e), revert: { undo: w["seq"] } }] });
    return { x, z, undo };
  };
  const badPlan = { op: 0, table: "ledger.plans", field: "account", code: "ref_not_found" };

  it(
    "the first stretch's target revoked: ref_not_found, nothing written",
    async () => {
      const { x, undo } = await split();
      await revokeAccount(x);
      await refused(undo, failed(badPlan));
    },
    T,
  );

  it(
    "the second stretch's target revoked: ref_not_found, nothing written",
    async () => {
      const { z, undo } = await split();
      await revokeAccount(z);
      await refused(undo, failed(badPlan));
    },
    T,
  );

  it(
    "neither revoked: written, each stretch back to its value",
    async () => {
      const { x, z, undo } = await split();
      const r = await undo();
      saved(r);
      // Two values put back, one on each stretch: both were checked above.
      const parts = r.ops[0]?.fields["account"] as unknown as { after: string }[];
      expect(parts.map((p) => p.after)).toEqual([entityOf(x), entityOf(z)]);
    },
    T,
  );
});

describe("a decision's write (04-contract `resolve`)", () => {
  /** A payment whose note two writes changed from the same version: the later one a candidate. */
  const disputed = async () => {
    const n1 = await note("one");
    const n2 = await note("two");
    const p = await pay({});
    await send({
      sv: 1,
      ops: [
        {
          intent: "update",
          table: "payments",
          row: rowOf(p),
          ver: ver(p),
          set: { note: rowOf(n1) },
        },
      ],
    });
    const c = await send({
      sv: 1,
      ops: [
        {
          intent: "update",
          table: "payments",
          row: rowOf(p),
          ver: ver(p),
          set: { note: rowOf(n2) },
        },
      ],
    });
    expect(c.ops[0]?.fields["note"]).toMatchObject({ result: "candidate" });
    const item = c.pending[0] as { id: string; item_ver: string };
    return { n2, item };
  };

  it(
    "a candidate is not checked when written; taking it is: its target revoked since, ref_not_found, the item stays open",
    async () => {
      const { n2, item } = await disputed();
      await revokeNote(n2);
      const d = (await pending$(s.store, ctx(), { id: item.id })) as unknown as {
        item_ver: string;
      };
      await refused(
        () => resolve({ id: item.id, decision: "take_candidate", item_ver: d.item_ver }),
        failed({ table: "ledger.payments", field: "note", code: "ref_not_found" }),
      );
      expect((await itemOf(item.id)).status).toBe("open");
    },
    T,
  );

  it(
    "taking a candidate whose target is untouched: resolved",
    async () => {
      const { item } = await disputed();
      const d = (await pending$(s.store, ctx(), { id: item.id })) as unknown as {
        item_ver: string;
      };
      saved(await resolve({ id: item.id, decision: "take_candidate", item_ver: d.item_ver }));
    },
    T,
  );

  it(
    "returning to the merge base whose note was revoked since (take_previous): ref_not_found, the item stays open",
    async () => {
      const n0 = await note("zero");
      const p = await pay({ memo: "base", note: rowOf(n0) });
      const n1 = await note("one");
      const n2 = await note("two");
      await send({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "payments",
            row: rowOf(p),
            ver: ver(p),
            set: { note: rowOf(n1) },
          },
        ],
      });
      const c = await send({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "payments",
            row: rowOf(p),
            ver: ver(p),
            set: { note: rowOf(n2) },
          },
        ],
      });
      const item = c.pending[0] as { id: string };
      await revokeNote(n0);
      const d = (await pending$(s.store, ctx(), { id: item.id })) as unknown as {
        item_ver: string;
      };
      await refused(
        () => resolve({ id: item.id, decision: "take_previous", item_ver: d.item_ver }),
        failed({ table: "ledger.payments", field: "note", code: "ref_not_found" }),
      );
      expect((await itemOf(item.id)).status).toBe("open");
    },
    T,
  );

  /** A plan over a gap: a write filling it with an account awaits confirmation. */
  const awaiting = async () => {
    const a = await account();
    const e = await send({
      sv: 1,
      ops: [{ intent: "insert", table: "plans", valid_from: "2026-11-01", set: { label: "x" } }],
    });
    const v = await send({
      sv: 1,
      ops: [
        {
          intent: "revoke",
          table: "plans",
          entity: entityOf(e),
          ver: ver(e),
          valid_from: "2026-11-10",
          valid_to: "2026-11-15",
        },
      ],
    });
    const w = await send({
      sv: 1,
      ops: [
        {
          intent: "update",
          table: "plans",
          entity: entityOf(e),
          ver: ver(v),
          valid_from: "2026-11-05",
          valid_to: "2026-11-20",
          set: { label: "y", account: entityOf(a) },
        },
      ],
    });
    expect(w.pending[0]?.type).toBe("awaiting_confirmation");
    return { a, item: w.pending[0] as { id: string; item_ver: string } };
  };

  it(
    "an awaiting write is not checked when written; confirming it is: its target revoked since, ref_not_found",
    async () => {
      const { a, item } = await awaiting();
      await revokeAccount(a);
      const d = (await pending$(s.store, ctx(), { id: item.id })) as unknown as {
        item_ver: string;
      };
      await refused(
        () => resolve({ id: item.id, decision: "confirm", item_ver: d.item_ver }),
        failed({ table: "ledger.plans", field: "account", code: "ref_not_found" }),
      );
      expect((await itemOf(item.id)).status).toBe("open");
    },
    T,
  );

  it(
    "confirming an awaiting write whose target is untouched: resolved",
    async () => {
      const { item } = await awaiting();
      saved(await resolve({ id: item.id, decision: "confirm", item_ver: item.item_ver }));
    },
    T,
  );
});
