// apply of a request with several ops on one entity (09-event-format §4.2, §5.7; 02-architecture
// §8 版本表): the version table keeps one version per cell and operation, so a later op of the
// operation overwrites an earlier op's cell in place; what is left agrees with judge. The
// comparison's scenarios have one op per request; this is the case they do not reach.

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
  view,
} from "@fluxvita/saveslot-kernel";
import {
  COMPILED_V1,
  createSlotEvents,
  eventsOfRequest,
  type LoggedEvent,
  SLOT,
} from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgliteBackend, type PgliteTenantStore } from "./backend.ts";

const T = 60_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const ENTITY = `e_${"7".repeat(26)}`;
const FILLER = `e_${"9".repeat(26)}`;
const d = (md: string) => `2026-${md}` as `${number}-${number}-${number}`;

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
const SHAPE = {
  kind: "state" as const,
  fields: ["f2", "f3"],
  valued: ["f2"],
  required: ["f2"],
  groups: [],
};
const CTX = {
  table: "t2" as never,
  target: { entity: ENTITY as never },
  shape: SHAPE as never,
  granularity: "date" as const,
};

const write = (
  op: number,
  index: number,
  value: string,
  from: string,
  seen: number,
  explicit: boolean,
): JudgeInput =>
  ({
    kind: "write",
    op,
    index,
    event: op + 1 + index,
    ruleset: 1,
    seen,
    seenExplicit: explicit,
    valid: { from: { mode: "given", value: d(from) }, to: { mode: "open" } },
    now: d("11-05"),
    fields: { f2: { value } },
  }) as JudgeInput;

let root: string;
let store: PgliteTenantStore;
let minute = 0;

const run = (events: NewEvent[]) =>
  store.write(async (tx) => {
    const now = `2026-11-10T05:${String(minute++).padStart(2, "0")}:00.000Z` as never;
    const op = await appendOperation(tx, { actor: USER as never, now, events });
    await applyEvents(tx, eventsOf(op));
    return op;
  });
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
async function at(evs: LoggedEvent[]) {
  const head = evs[0]?.seq as number;
  for (let tail = (await store.read(readTail))?.seq ?? 0; tail < head - 1; tail++)
    await run([filler]);
  const op = await run(
    evs.map((e) => ({ type: e.type as never, slot: SLOT, blocks: e.blocks as never })),
  );
  expect(op.events.map((e) => e.seq)).toEqual(evs.map((e) => e.seq));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "saveslot-apply-request-"));
  store = await new PgliteBackend().open(
    { kind: "pglite", dir: join(root, "tenant") },
    { create: true },
  );
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

describe("a request with several ops on one entity", () => {
  it(
    "the later op overwrites the earlier op's cell in place; the rest agrees with judge",
    async () => {
      // Operation 10 creates the entity; operation 20 writes f2 from 11-01 twice: "2", then "3".
      const inputs = [
        write(10, 0, "1", "10-01", 9, false),
        write(20, 0, "2", "11-01", 10, true),
        write(20, 1, "3", "11-01", 20, false),
      ];
      const { judgements, state } = replay(SHAPE as never, inputs);
      await at(eventsOfRequest(CTX, inputs.slice(0, 1), judgements.slice(0, 1), "insert"));
      await at(eventsOfRequest(CTX, inputs.slice(1), judgements.slice(1), "update"));
      const cells = await store.read((tx) =>
        tx.query(
          `SELECT field_id, valid_from::text AS vf, valid_to::text AS vt, rec_from, rec_to, src_event, f_f2
           FROM t_t2_v1__ver WHERE row_id = $1 AND field_id = 'f2' ORDER BY rec_from, valid_from`,
          [ENTITY],
        ),
      );
      expect(
        cells.rows.map((r) => ({
          ...r,
          rec_from: Number(r["rec_from"]),
          rec_to: r["rec_to"] === null ? null : Number(r["rec_to"]),
          src_event: Number(r["src_event"]),
        })),
      ).toEqual([
        {
          field_id: "f2",
          vf: d("10-01"),
          vt: null,
          rec_from: 10,
          rec_to: 20,
          src_event: 11,
          f_f2: "1",
        },
        {
          field_id: "f2",
          vf: d("10-01"),
          vt: d("11-01"),
          rec_from: 20,
          rec_to: null,
          src_event: 11,
          f_f2: "1",
        },
        // One version of the cell at operation 20: the second op's, not the first's.
        {
          field_id: "f2",
          vf: d("11-01"),
          vt: null,
          rec_from: 20,
          rec_to: null,
          src_event: 22,
          f_f2: "3",
        },
      ]);
      const rows = await store.read((tx) =>
        tx.query(
          "SELECT valid_from::text AS vf, valid_to::text AS vt, f_f2 FROM t_t2_v1 WHERE entity_id = $1 ORDER BY valid_from",
          [ENTITY],
        ),
      );
      expect(rows.rows).toEqual([
        { vf: d("10-01"), vt: d("11-01"), f_f2: "1" },
        { vf: d("11-01"), vt: null, f_f2: "3" },
      ]);
      // As judge has it.
      expect(JSON.parse(JSON.stringify(view(state).fields["f2" as never]))).toEqual([
        {
          valid: [{ from: d("10-01"), to: d("11-01") }],
          value: "1",
          by: { event: 11, target: "f2", k: 0 },
        },
        {
          valid: [{ from: d("11-01"), to: null }],
          value: "3",
          by: { event: 22, target: "f2", k: 0 },
        },
      ]);
    },
    T,
  );
});
