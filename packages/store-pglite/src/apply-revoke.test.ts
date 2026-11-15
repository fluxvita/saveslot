// apply of revokes and their undo on storage (09-event-format §5.7; 04-write-and-read «已撤销的行仍
// 占着它的键»; 02-architecture §8 版本表; 01-objects «版本标记»). An event or timeless table's
// revoke changes only existence: the row keeps its values and field cells, and the version table
// gets an `existence` cell marked revoked; undoing it gives an `existence` cell from the restore
// and reopens no field cell. A state table's whole revoke leaves the entity no business row and an
// `existence` cell marked revoked over what the entity had. Each of these operations changes the
// version table, so `ver` becomes its own number.
// Judged scenarios compare only rows that exist; these are the cases they do not see.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  type NewEvent,
  readTail,
} from "@fluxvita/saveslot-kernel";
import {
  asInThisPhase,
  COMPILED_V1,
  createSlotEvents,
  eventsOfSteps,
  judged,
  type LoggedEvent,
  SLOT,
  shape,
} from "@fluxvita/saveslot-kernel/testing";
import type { LogEntry, TableSchema } from "@fluxvita/saveslot-reference";
import { EVENT, STATE } from "@fluxvita/saveslot-reference/testing";
import { afterAll, describe, expect, it } from "vitest";
import { PgliteBackend, type PgliteTenantStore } from "./backend.ts";

const T = 60_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const ROW = `r_${"6".repeat(26)}`;
const ENTITY = `e_${"7".repeat(26)}`;
const FILLER = `e_${"9".repeat(26)}`;

const fields = [
  { id: "f2", name: "b", type: "text", required: true, description: "b" },
  { id: "f3", name: "c", type: "text", description: "c" },
];
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

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}, T);

/** A fresh tenant with the slot, and the judged log `ops` applied operation by operation. */
async function applied(schema: TableSchema, ops: LogEntry[]) {
  const isState = schema.kind === "state";
  const root = mkdtempSync(join(tmpdir(), "saveslot-apply-revoke-"));
  roots.push(root);
  const store = await new PgliteBackend().open(
    { kind: "pglite", dir: join(root, "tenant") },
    { create: true },
  );
  let minute = 0;
  const run = (s: PgliteTenantStore, events: NewEvent[]) =>
    s.write(async (tx) => {
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
  await run(store, createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }));
  const { steps } = judged(schema, (ops as never[]).map(asInThisPhase), []);
  const ctx = {
    table: (isState ? "t2" : "t1") as never,
    target: isState ? { entity: ENTITY as never } : { row: ROW as never },
    shape: shape(schema),
    granularity: "date" as const,
  };
  const perStep: LoggedEvent[][] = eventsOfSteps(ctx, steps, (after, n) => after + 1 + n);
  return { store, run, perStep, steps };
}

async function at(
  store: PgliteTenantStore,
  run: (s: PgliteTenantStore, e: NewEvent[]) => Promise<unknown>,
  evs: LoggedEvent[],
) {
  const head = evs[0]?.seq as number;
  for (let tail = (await store.read(readTail))?.seq ?? 0; tail < head - 1; tail++)
    await run(store, [filler]);
  await run(
    store,
    evs.map((e) => ({ type: e.type as never, slot: SLOT, blocks: e.blocks as never })),
  );
}

const num = (v: unknown) => (v === null ? null : Number(v));

async function cells(store: PgliteTenantStore, table: string, id: string) {
  const r = await store.read((tx) =>
    tx.query<Record<string, unknown>>(
      `SELECT field_id, rec_from, rec_to, intent, src_event, src_field, src_k, revoked, f_f2, f_f3
       FROM "${table}" WHERE row_id = $1 ORDER BY field_id, rec_from`,
      [id],
    ),
  );
  return r.rows.map((c) => ({
    ...c,
    rec_from: num(c["rec_from"]),
    rec_to: num(c["rec_to"]),
    src_event: num(c["src_event"]),
  }));
}

const ver = async (store: PgliteTenantStore, table: string, id: string) =>
  num(
    (
      await store.read((tx) =>
        tx.query<{ v: unknown }>(
          `SELECT max(rec_from) AS v FROM "${table}" WHERE row_id = $1 AND intent <> 'schema_switch'`,
          [id],
        ),
      )
    ).rows[0]?.v,
  );

describe("an event or timeless table: a revoke changes only existence", () => {
  it(
    "revoked: values and field cells kept, an existence cell marked revoked; undone: an existence cell from the restore",
    async () => {
      // Op 10 writes f2 "a" and f3 "c"; op 20 revokes the row; op 30 undoes op 20.
      const ops: LogEntry[] = [
        {
          kind: "write",
          op: 10,
          event: 11,
          seen: 0,
          fields: {
            f2: { value: "a", sources: ["S1", "S2"] },
            f3: { value: "c", sources: ["S3"] },
          },
          acknowledge: ["overwrite"],
        },
        { kind: "revoke", op: 20, event: 21, seen: 10 },
        { kind: "undo", op: 30, event: 31, target: 20, seen: 20, acknowledge: ["overwrite"] },
      ] as LogEntry[];
      const { store, run, perStep } = await applied(EVENT, ops);
      try {
        const step = async (k: number) => at(store, run, perStep[k] as LoggedEvent[]);
        const row = async () =>
          (
            await store.read((tx) =>
              tx.query("SELECT revoked, f_f2, f_f3 FROM t_t1_v1 WHERE row_id = $1", [ROW]),
            )
          ).rows;
        const count = async () =>
          num(
            (
              await store.read((tx) =>
                tx.query<{ row_count: unknown }>(
                  "SELECT row_count FROM counts WHERE table_id = 't1'",
                ),
              )
            ).rows[0]?.row_count,
          );
        await step(0);
        await step(1);
        expect(await row()).toEqual([{ revoked: true, f_f2: "a", f_f3: "c" }]);
        expect(await count()).toBe(0);
        const fieldCell = (f: string, value: string) => ({
          field_id: f,
          rec_from: 10,
          rec_to: null,
          intent: "insert",
          src_event: 11,
          src_field: f,
          src_k: 0,
          revoked: null,
          f_f2: f === "f2" ? value : null,
          f_f3: f === "f3" ? value : null,
        });
        const revokedCell = {
          field_id: "existence",
          rec_from: 20,
          rec_to: null,
          intent: "revoke",
          src_event: 21,
          src_field: "existence",
          src_k: 0,
          revoked: true,
          f_f2: null,
          f_f3: null,
        };
        expect(await cells(store, "t_t1_v1__ver", ROW)).toEqual([
          revokedCell,
          fieldCell("f2", "a"),
          fieldCell("f3", "c"),
        ]);
        expect(await ver(store, "t_t1_v1__ver", ROW)).toBe(20);
        await step(2);
        expect(await row()).toEqual([{ revoked: false, f_f2: "a", f_f3: "c" }]);
        expect(await count()).toBe(1);
        // The field cells are not reopened; the revoke's cell ends, the restore's opens.
        expect(await cells(store, "t_t1_v1__ver", ROW)).toEqual([
          { ...revokedCell, rec_to: 30 },
          {
            field_id: "existence",
            rec_from: 30,
            rec_to: null,
            intent: "update",
            src_event: 31,
            src_field: "existence",
            src_k: 0,
            revoked: null,
            f_f2: null,
            f_f3: null,
          },
          fieldCell("f2", "a"),
          fieldCell("f3", "c"),
        ]);
        expect(await ver(store, "t_t1_v1__ver", ROW)).toBe(30);
        // The revoke registered as reverted by operation 30.
        const reg = await store.read((tx) =>
          tx.query<{ reverted: string }>(
            "SELECT reverted FROM base_sources WHERE row_id = $1 AND event_seq = 21",
            [ROW],
          ),
        );
        expect(reg.rows.map((r) => JSON.parse(r.reverted))).toEqual([
          [{ op: 30, valid: [{ from: null, to: null }] }],
        ]);
      } finally {
        await store.close();
      }
    },
    T,
  );
});

describe("a state table: a whole revoke", () => {
  it(
    "no business row, an existence cell marked revoked over what the entity had, ver at the revoke",
    async () => {
      const ops: LogEntry[] = [
        {
          kind: "write",
          op: 10,
          event: 11,
          seen: 0,
          valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
          fields: { f2: { value: "x", sources: ["S1"] } },
          acknowledge: ["overwrite"],
        },
        { kind: "revoke", op: 20, event: 21, seen: 10 },
      ] as LogEntry[];
      const { store, run, perStep } = await applied(STATE, ops);
      try {
        await at(store, run, perStep[0] as LoggedEvent[]);
        await at(store, run, perStep[1] as LoggedEvent[]);
        const rows = await store.read((tx) =>
          tx.query("SELECT * FROM t_t2_v1 WHERE entity_id = $1", [ENTITY]),
        );
        expect(rows.rows).toEqual([]);
        const open = await store.read((tx) =>
          tx.query<Record<string, unknown>>(
            `SELECT field_id, valid_from::text AS valid_from, valid_to::text AS valid_to, rec_from, intent, src_event, revoked
             FROM t_t2_v1__ver WHERE row_id = $1 AND rec_to IS NULL`,
            [ENTITY],
          ),
        );
        expect(
          open.rows.map((c) => ({
            ...c,
            rec_from: num(c["rec_from"]),
            src_event: num(c["src_event"]),
          })),
        ).toEqual([
          {
            field_id: "existence",
            valid_from: "2026-10-01",
            valid_to: null,
            rec_from: 20,
            intent: "revoke",
            src_event: 21,
            revoked: true,
          },
        ]);
        expect(await ver(store, "t_t2_v1__ver", ENTITY)).toBe(20);
      } finally {
        await store.close();
      }
    },
    T,
  );
});
