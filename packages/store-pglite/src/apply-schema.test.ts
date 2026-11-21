// apply on PGlite for creating a slot, sources, request keys and pending items (09-event-format
// §4.5, §5.4–§5.8; 02-architecture §8): a slot's physical tables come only from apply of its
// compiled definition; and K12 (02-architecture §11 «测试矩阵»): replaying the whole log from an
// empty storage gives the state applied event by event, table by table, the physical tables'
// shapes included. Fictional IDs and names.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApplyError,
  appendOperation,
  applyEvents,
  confirmationHash,
  createOpsContext,
  createTenant,
  entryChecksums,
  eventsOf,
  KERNEL_TABLES,
  type NewEvent,
  type ReadTx,
  readEvents,
  readTail,
} from "@fluxvita/saveslot-kernel";
import { COMPILED_V1, createSlotEvents, DRAFT, SLOT } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgliteTenantStore } from "./backend.ts";
import { testBackend } from "./testing/test-backend.fixture.ts";

const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const ROW = `r_${"6".repeat(26)}`;
const ENTITY = `e_${"7".repeat(26)}`;
const CONFLICT = `pi_${"8".repeat(16)}`;
const AWAITING = `pi_${"9".repeat(16)}`;
const SOURCE = `s_${"3".repeat(16)}`;
const HASH = "a".repeat(64);
const T = 60_000;

const roots: string[] = [];
const open = async (name: string) => {
  const root = mkdtempSync(join(tmpdir(), `saveslot-${name}-`));
  roots.push(root);
  return testBackend().open({ kind: "pglite", dir: join(root, "tenant") }, { create: true });
};

let minute = 0;
const nextNow = () => `2026-11-10T05:${String(minute++).padStart(2, "0")}:00.000Z` as never;

/** Appends one operation and applies it in the same transaction, as an operation does. */
const run = (s: PgliteTenantStore, events: NewEvent[]) =>
  s.write(async (tx) => {
    const op = await appendOperation(tx, { actor: USER as never, now: nextNow(), events });
    await applyEvents(tx, eventsOf(op));
    return op.op;
  });

const stopped = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApplyError)
      return `${e.reason}: ${e.message.replace(/^apply stopped at seq \d+: /, "")}`;
    throw e;
  }
  return "applied";
};

const rows = (s: PgliteTenantStore, sql: string) =>
  s.read(async (tx) => (await tx.query(sql)).rows.map((r) => JSON.parse(JSON.stringify(r, big))));
const big = (_: string, v: unknown) => (typeof v === "bigint" ? Number(v) : v);

/** The columns of the slot's physical tables, as the database has them. */
const physical = (tx: ReadTx) =>
  tx.query(
    `SELECT table_name, column_name, data_type, collation_name, is_nullable, column_default,
       numeric_precision, numeric_scale, ordinal_position
     FROM information_schema.columns WHERE table_name LIKE 't\\_%' ESCAPE '\\'
     ORDER BY table_name, ordinal_position`,
  );
/** Their indexes and constraints, by definition. */
const physicalIndexes = (tx: ReadTx) =>
  tx.query(
    `SELECT tablename, indexname, indexdef FROM pg_indexes
     WHERE tablename LIKE 't\\_%' ESCAPE '\\' ORDER BY tablename, indexname`,
  );
const physicalConstraints = (tx: ReadTx) =>
  tx.query(
    `SELECT c.relname, k.conname, pg_get_constraintdef(k.oid) AS def
     FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
     WHERE c.relname LIKE 't\\_%' ESCAPE '\\' ORDER BY c.relname, k.conname`,
  );

const writeCtx = {
  now: "2026-11-10T05:00:00.000Z",
  today: "2026-11-10",
  ruleset_version: 1,
  policy_version: 1,
  literal_checker: "literal@1",
};
const writeHead = (extra: NewEvent["blocks"] = {}): NewEvent => ({
  type: "write.head",
  slot: SLOT,
  blocks: {
    ctx: writeCtx,
    request: { sv: 1, sv_basis: "explicit", op_count: 1 },
    "ops/0/target": { table: "t2", entity: ENTITY, intent: "update" },
    ...extra,
  },
});
const versions = { ruleset_version: 1, policy_version: 1 };
const candidate = (event: number) => ({
  event,
  intent: "update",
  seen: { op: 10, restore_count: 0 },
  cause: "stale_write",
  items: [{ field: "f2", k: 0, value: "3", valid: { from: "2026-11-01", to: "2026-11-05" } }],
  deps: [{ event, field: "f2", k: 0 }],
});
const scope = (from: string, event: number) => ({
  spans: [{ from, to: "2026-11-05" }],
  deps: [{ event, field: "f2", k: 0 }],
});

const previous = (value: string, event: number) => ({
  field: "f2",
  value,
  valid: { from: "2026-11-01", to: "2026-11-05" },
  deps: [{ event, field: "f2", k: 0 }],
});

const SLOT_B = `sl_${"5".repeat(16)}`;
const DRAFT_B = `d_${"2".repeat(16)}`;
const OTHER_DRAFT = `d_${"3".repeat(16)}`;
/** The operation creating a second slot with one timeless table, varied to be refused. */
function otherSlot(
  o: { switchDraft?: string; switchVersion?: number; policy?: boolean; tableId?: string } = {},
): NewEvent[] {
  const id = o.tableId ?? "t14";
  const compiled = {
    ...COMPILED_V1,
    slot: SLOT_B,
    tables: [{ ...COMPILED_V1.tables[3], id, physical: { table: `t_${id}_v1` } }],
  };
  return createSlotEvents({
    compiled: compiled as never,
    changes: [
      { target: { slot: true }, change: "create_slot" },
      { target: { table: id }, change: "add_table" },
    ].map((c) => ({
      ...c,
      class: "create",
      compatible_with_old_writes: true,
      destructive: false,
      auto: true,
    })) as never,
  })
    .filter((e) => o.policy !== false || e.type !== "slot.policy_set")
    .map((e) => {
      const blocks = JSON.parse(JSON.stringify(e.blocks).replaceAll(DRAFT, DRAFT_B));
      if (e.type === "schema.switched") {
        blocks.target = {
          ...blocks.target,
          ...(o.switchDraft !== undefined ? { draft_id: o.switchDraft } : {}),
          ...(o.switchVersion !== undefined ? { to_version: o.switchVersion } : {}),
        };
      }
      return { ...e, slot: SLOT_B, blocks } as NewEvent;
    });
}

let store: PgliteTenantStore;

beforeAll(async () => {
  store = await open("apply-schema");
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
}, T);

afterAll(async () => {
  await store?.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}, 120_000);

describe("creating a slot: its tables from its compiled definition", () => {
  it(
    "before: no physical table",
    async () => {
      expect((await store.read(physical)).rows).toEqual([]);
    },
    T,
  );

  it(
    "the slot, its current version, catalog and counts; a business and a version table per base table",
    async () => {
      const op = await run(store, createSlotEvents({ requestKey: "create-ledger" }));
      expect(await rows(store, "SELECT * FROM slots")).toEqual([
        {
          id: SLOT,
          name: "ledger",
          timezone: "Asia/Shanghai",
          current_sv: 1,
          policy_seq: op + 3,
          policy_version: 1,
        },
      ]);
      expect(await rows(store, "SELECT * FROM schema_versions")).toEqual([
        {
          slot_id: SLOT,
          sv: 1,
          compiled_seq: op + 1,
          draft_id: expect.any(String),
          state: "current",
          // The slot's first version is switched to in its own creation.
          switched_seq: op + 4,
        },
      ]);
      expect(
        await rows(store, "SELECT table_id, sv, slot_id FROM catalog ORDER BY table_id"),
      ).toEqual(COMPILED_V1.tables.map((t) => ({ table_id: t.id, sv: 1, slot_id: SLOT })));
      // The catalog keeps each table's definition as compiled, without its physical name.
      const structures = await rows(
        store,
        "SELECT table_id, structure FROM catalog ORDER BY table_id",
      );
      expect(structures.map((r: { structure: string }) => JSON.parse(r.structure))).toEqual(
        COMPILED_V1.tables.map(({ physical: _, ...rest }) => rest),
      );
      expect(await rows(store, "SELECT * FROM counts ORDER BY table_id")).toEqual(
        COMPILED_V1.tables.map((t) => ({ table_id: t.id, partition_key: "", row_count: 0 })),
      );
      expect(await rows(store, "SELECT key, op, fingerprint FROM request_keys")).toEqual([
        { key: "create-ledger", op, fingerprint: null },
      ]);
      const cols = (await store.read(physical)).rows as {
        table_name: string;
        column_name: string;
        data_type: string;
        collation_name: string | null;
      }[];
      expect([...new Set(cols.map((c) => c.table_name))]).toEqual([
        "t_t1_v1",
        "t_t1_v1__ver",
        "t_t2_v1",
        "t_t2_v1__ver",
        "t_t3_v1",
        "t_t3_v1__ver",
        "t_t4_v1",
        "t_t4_v1__ver",
      ]);
      const of = (t: string) =>
        cols
          .filter((c) => c.table_name === t)
          .map((c) => `${c.column_name} ${c.data_type}${c.collation_name === "C" ? " C" : ""}`);
      expect(of("t_t1_v1")).toEqual([
        "row_id text C",
        "revoked boolean",
        "f_f1 date",
        "f_f2 text C",
        "f_f3 numeric",
        "f_f4 text C",
        "f_f5 bigint",
        "f_f6 numeric",
        "f_f7 boolean",
        "f_f8 timestamp with time zone",
        "f_f8__zone text C",
        "f_f9 text C",
      ]);
      expect(of("t_t2_v1")).toEqual([
        "entity_id text C",
        "valid_from date",
        "valid_to date",
        "f_f1 text C",
        "f_f2 bigint",
      ]);
      expect(of("t_t3_v1").slice(0, 3)).toEqual([
        "entity_id text C",
        "valid_from timestamp with time zone",
        "valid_to timestamp with time zone",
      ]);
    },
    T,
  );

  it(
    "the same slot again is inconsistent, and nothing of it is kept",
    async () => {
      const before = await store.read((tx) => readTail(tx));
      expect(await stopped(run(store, createSlotEvents()))).toBe(
        `inconsistent: slot ${SLOT} already exists`,
      );
      expect(await store.read((tx) => readTail(tx))).toEqual(before);
    },
    T,
  );

  it.each([
    [
      "a switch to a draft not compiled",
      { switchDraft: OTHER_DRAFT },
      "inconsistent: no compiled version 1",
    ],
    [
      "a switch to a version not compiled",
      { switchVersion: 2 },
      "inconsistent: no compiled version 2",
    ],
    [
      "a switch without the slot's policy",
      { policy: false },
      `inconsistent: slot ${SLOT_B} has no policy`,
    ],
    ["a table ID another slot uses", { tableId: "t4" }, "inconsistent: table t4 already exists"],
  ])(
    "%s is inconsistent, and nothing of it is kept",
    async (_, o, expected) => {
      const before = await store.read((tx) => readTail(tx));
      expect(await stopped(run(store, otherSlot(o)))).toBe(expected);
      expect(await store.read((tx) => readTail(tx))).toEqual(before);
    },
    T,
  );

  it(
    "a second switch of the slot is inconsistent, not a database error",
    async () => {
      const [draft, , , , switched] = createSlotEvents();
      expect(await stopped(run(store, [draft as NewEvent, switched as NewEvent]))).toBe(
        `inconsistent: slot ${SLOT} already has version 1`,
      );
    },
    T,
  );
});

describe("schema_versions' states (storage format 4)", () => {
  it(
    "takes failed, a migration that failed (not rejected: nobody decided it); refuses a state not listed",
    async () => {
      const put = (state: string) =>
        store.write((tx) =>
          tx.query(
            `INSERT INTO schema_versions (slot_id, sv, compiled_seq, draft_id, state)
             VALUES ('sl_${"9".repeat(16)}', 1, 1, $1, $2)`,
            [`d_${"9".repeat(16)}`, state],
          ),
        );
      await expect(put("migrating")).rejects.toThrow();
      await put("failed");
      expect(
        await rows(
          store,
          `SELECT state FROM schema_versions WHERE slot_id = 'sl_${"9".repeat(16)}'`,
        ),
      ).toEqual([{ state: "failed" }]);
      await store.write((tx) =>
        tx.query(`DELETE FROM schema_versions WHERE slot_id = 'sl_${"9".repeat(16)}'`),
      );
    },
    T,
  );
});

describe("sources, request keys and pending items", () => {
  let conflictOp = 0;
  let mergeOp = 0;
  let refreshOp = 0;

  it(
    "a write's head and its source: the source registered, the request key indexed",
    async () => {
      const op = await run(store, [
        writeHead({ idempotency: { key: "w1", fingerprint: HASH } }),
        {
          type: "source.recorded",
          slot: SLOT,
          blocks: {
            target: { source_id: SOURCE, kind: "user_message", level: "user_stated" },
            text: { text: "limit is 3" },
          },
        },
      ]);
      expect(
        await rows(
          store,
          "SELECT seq, source_id, kind, level, slot_id, deletion_state FROM sources",
        ),
      ).toEqual([
        {
          seq: op + 1,
          source_id: SOURCE,
          kind: "user_message",
          level: "user_stated",
          slot_id: SLOT,
          deletion_state: "present",
        },
      ]);
      expect(
        await rows(store, "SELECT key, op, fingerprint FROM request_keys WHERE key = 'w1'"),
      ).toEqual([{ key: "w1", op, fingerprint: HASH }]);
    },
    T,
  );

  it(
    "the same source recorded twice is inconsistent",
    async () => {
      expect(
        await stopped(
          run(store, [
            writeHead(),
            {
              type: "source.recorded",
              slot: SLOT,
              blocks: {
                target: { source_id: SOURCE, kind: "user_message", level: "user_stated" },
                text: { text: "again" },
              },
            },
          ]),
        ),
      ).toBe(`inconsistent: source ${SOURCE} is already recorded`);
    },
    T,
  );

  it(
    "a request key used again (after its window): the index names the latest operation",
    async () => {
      const op = await run(store, [
        writeHead({ idempotency: { key: "w1", fingerprint: "b".repeat(64) } }),
      ]);
      expect(
        await rows(store, "SELECT key, op, fingerprint FROM request_keys WHERE key = 'w1'"),
      ).toEqual([{ key: "w1", op, fingerprint: "b".repeat(64) }]);
      // The time it was used: the idempotency window runs from it.
      expect(await rows(store, "SELECT at FROM request_keys WHERE key = 'w1'")).toEqual(
        await rows(store, `SELECT at FROM events WHERE seq = ${op}`),
      );
    },
    T,
  );

  it(
    "item.created: open items, their entries, the flags of their types",
    async () => {
      conflictOp = await run(store, [
        writeHead(),
        {
          type: "item.created",
          slot: SLOT,
          blocks: {
            target: {
              item: CONFLICT,
              type: "conflict",
              reason: "stale_write",
              table: "t2",
              entity: ENTITY,
              unit: ["f2"],
              merge_base_op: 10,
              origin_event: 99,
              ...versions,
            },
            scope_valid: scope("2026-11-01", 99),
            "candidates/0": candidate(99),
            "previous/0": previous("1", 99),
            "impact/0": {
              kind: "reverted_write",
              op: 20,
              deps: [{ event: 21, field: "f2", k: 0 }],
            },
          },
        },
        {
          type: "item.created",
          slot: SLOT,
          blocks: {
            target: {
              item: AWAITING,
              type: "awaiting_confirmation",
              reason: "undo_hides_later",
              table: "t4",
              row: ROW,
              unit: ["existence"],
              origin_event: 98,
              ...versions,
            },
          },
        },
      ]);
      expect(await rows(store, "SELECT * FROM pending_items ORDER BY id")).toEqual([
        {
          id: CONFLICT,
          type: "conflict",
          slot_id: SLOT,
          target_table: "t2",
          target_row: ENTITY,
          state: "open",
          decision: null,
          version_op: conflictOp,
        },
        {
          id: AWAITING,
          type: "awaiting_confirmation",
          slot_id: SLOT,
          target_table: "t4",
          target_row: ROW,
          state: "open",
          decision: null,
          version_op: conflictOp,
        },
      ]);
      expect(
        await rows(
          store,
          "SELECT item_id, n, content_seq, content_path FROM pending_entries ORDER BY item_id, n",
        ),
      ).toEqual([
        ...["candidates/0", "impact/0", "previous/0", "scope_valid"].map((path, n) => ({
          item_id: CONFLICT,
          n,
          content_seq: conflictOp + 1,
          content_path: path,
        })),
      ]);
      expect(await rows(store, "SELECT * FROM block_deps ORDER BY seq, path, n")).toEqual(
        [
          ["candidates/0", 99],
          ["impact/0", 21],
          ["previous/0", 99],
          ["scope_valid", 99],
        ].map(([path, event]) => ({
          seq: conflictOp + 1,
          path,
          n: 0,
          dep_event: event,
          dep_field: "f2",
          dep_k: 0,
          dep_kind: "deps",
        })),
      );
      expect(await rows(store, "SELECT * FROM flags ORDER BY item_id")).toEqual([
        {
          table_id: "t2",
          row_id: ENTITY,
          flag: "disputed",
          item_id: CONFLICT,
          fields: '["f2"]',
          spans: '[{"from":"2026-11-01","to":"2026-11-05"}]',
        },
        {
          table_id: "t4",
          row_id: ROW,
          flag: "awaiting",
          item_id: AWAITING,
          fields: '["existence"]',
          spans: null,
        },
      ]);
    },
    T,
  );

  it(
    "item.merged: a new candidate numbered on, the scope replaced, the flag's interval follows",
    async () => {
      const op = await run(store, [
        writeHead(),
        {
          type: "item.merged",
          slot: SLOT,
          blocks: {
            target: { item: CONFLICT, merge_base_op: 9, origin_event: 97, ...versions },
            "candidates/1": candidate(97),
            "previous/0": previous("0", 97),
            scope_valid: scope("2026-10-30", 97),
          },
        },
      ]);
      mergeOp = op;
      expect(
        await rows(
          store,
          "SELECT n, content_seq, content_path FROM pending_entries WHERE item_id = '" +
            CONFLICT +
            "' ORDER BY n",
        ),
      ).toEqual([
        // previous, impact and scope_valid are given whole: the item's earlier ones go.
        { n: 0, content_seq: conflictOp + 1, content_path: "candidates/0" },
        { n: 4, content_seq: op + 1, content_path: "candidates/1" },
        { n: 5, content_seq: op + 1, content_path: "previous/0" },
        { n: 6, content_seq: op + 1, content_path: "scope_valid" },
      ]);
      expect(
        await rows(store, `SELECT version_op FROM pending_items WHERE id = '${CONFLICT}'`),
      ).toEqual([{ version_op: op }]);
      expect(await rows(store, `SELECT spans FROM flags WHERE item_id = '${CONFLICT}'`)).toEqual([
        { spans: '[{"from":"2026-10-30","to":"2026-11-05"}]' },
      ]);
    },
    T,
  );

  it(
    "item.refreshed: candidates by index; no scope given empties the flag's interval",
    async () => {
      const op = await run(store, [
        writeHead(),
        {
          type: "item.refreshed",
          slot: SLOT,
          blocks: {
            target: {
              item: CONFLICT,
              by_event: 96,
              writer_had_read: false,
              cause: "target_overwritten",
            },
            "candidates/0": candidate(99),
          },
        },
      ]);
      refreshOp = op;
      expect(
        await rows(
          store,
          `SELECT n, content_seq, content_path FROM pending_entries WHERE item_id = '${CONFLICT}' ORDER BY n`,
        ),
      ).toEqual([
        { n: 4, content_seq: mergeOp + 1, content_path: "candidates/1" },
        { n: 7, content_seq: op + 1, content_path: "candidates/0" },
      ]);
      expect(await rows(store, `SELECT spans FROM flags WHERE item_id = '${CONFLICT}'`)).toEqual([
        { spans: null },
      ]);
    },
    T,
  );

  it(
    "a decision whose confirmation is not the item's entries' hash is inconsistent, nothing kept",
    async () => {
      const before = await store.read((tx) => readTail(tx));
      const wrong = stopped(
        run(store, [
          {
            type: "item.resolved",
            slot: SLOT,
            blocks: {
              ctx: {
                now: "2026-11-10T05:00:00.000Z",
                today: "2026-11-10",
                ruleset_version: 1,
                policy_version: 1,
              },
              target: {
                item: CONFLICT,
                decision: "keep_effective",
                item_op: 41,
                restore_count: 0,
                via: "call",
              },
              confirmation: { hash: "0".repeat(64) },
            },
          },
        ]),
      );
      expect(await wrong).toBe(
        `inconsistent: the confirmation of ${CONFLICT} does not match its entries`,
      );
      expect(await store.read((tx) => readTail(tx))).toEqual(before);
    },
    T,
  );

  it(
    "a decision without a confirmation on an item with entries is inconsistent, nothing kept",
    async () => {
      const before = await store.read((tx) => readTail(tx));
      const missing = stopped(
        run(store, [
          {
            type: "item.resolved",
            slot: SLOT,
            blocks: {
              ctx: {
                now: "2026-11-10T05:00:00.000Z",
                today: "2026-11-10",
                ruleset_version: 1,
                policy_version: 1,
              },
              target: {
                item: CONFLICT,
                decision: "keep_effective",
                item_op: 41,
                restore_count: 0,
                via: "call",
              },
            },
          },
        ]),
      );
      expect(await missing).toBe(
        `inconsistent: the confirmation of ${CONFLICT} does not match its entries`,
      );
      expect(await store.read((tx) => readTail(tx))).toEqual(before);
    },
    T,
  );

  it(
    "item.superseded and item.resolved: state, decision, flags gone, the resolution's request key",
    async () => {
      const sup = await run(store, [
        writeHead(),
        {
          type: "item.superseded",
          slot: SLOT,
          blocks: {
            target: { item: AWAITING, reason: "overwritten", by_event: 95, writer_had_read: true },
          },
        },
      ]);
      // The hash of what the decision confirms: the item's entries as they are (§5.8).
      const hash = await store.read(async (tx) =>
        confirmationHash(await entryChecksums(tx, CONFLICT)),
      );
      const res = await run(store, [
        {
          type: "item.resolved",
          slot: SLOT,
          blocks: {
            ctx: {
              now: "2026-11-10T05:00:00.000Z",
              today: "2026-11-10",
              ruleset_version: 1,
              policy_version: 1,
            },
            request_key: { key: "r1" },
            target: {
              item: CONFLICT,
              decision: "keep_effective",
              item_op: 41,
              restore_count: 0,
              via: "call",
            },
            ...(hash !== undefined ? { confirmation: { hash } } : {}),
          },
        },
      ]);
      expect(
        await rows(store, "SELECT id, state, decision, version_op FROM pending_items ORDER BY id"),
      ).toEqual([
        { id: CONFLICT, state: "resolved", decision: "keep_effective", version_op: refreshOp },
        { id: AWAITING, state: "superseded", decision: null, version_op: sup },
      ]);
      expect(await rows(store, "SELECT * FROM flags")).toEqual([]);
      expect(await rows(store, "SELECT key, op FROM request_keys WHERE key = 'r1'")).toEqual([
        { key: "r1", op: res },
      ]);
    },
    T,
  );

  it(
    "an item event for an item not open is inconsistent, and nothing of its operation is kept",
    async () => {
      const before = await store.read((tx) => readTail(tx));
      const again = stopped(
        run(store, [
          writeHead(),
          {
            type: "item.superseded",
            slot: SLOT,
            blocks: {
              target: {
                item: CONFLICT,
                reason: "overwritten",
                by_event: 95,
                writer_had_read: true,
              },
            },
          },
        ]),
      );
      expect(await again).toBe(`inconsistent: no open item ${CONFLICT}`);
      expect(await store.read((tx) => readTail(tx))).toEqual(before);
    },
    T,
  );
});

/** Every row of every materialized table and of the slot's physical tables, and their shapes. */
async function state(tx: ReadTx): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  const all = (r: { rows: readonly unknown[] }) => r.rows.map((x) => JSON.stringify(x, big)).sort();
  for (const t of KERNEL_TABLES.filter((t) => t.class === "materialized")) {
    out[t.name] = all(await tx.query(`SELECT * FROM ${t.name}`));
  }
  const shapes = await physical(tx);
  out["physical shapes"] = all(shapes);
  out["physical indexes"] = all(await physicalIndexes(tx));
  out["physical constraints"] = all(await physicalConstraints(tx));
  for (const name of new Set(shapes.rows.map((r) => (r as { table_name: string }).table_name))) {
    out[name] = all(await tx.query(`SELECT * FROM "${name}"`));
  }
  out["meta.tenant_id"] = [
    ...(await tx.query("SELECT value FROM meta WHERE key = 'tenant_id'")).rows,
  ];
  return out;
}

describe("K12: replaying the log from an empty storage gives the same state", () => {
  let replica: PgliteTenantStore;

  beforeAll(async () => {
    replica = await open("apply-schema-replica");
    const events = await store.read((tx) => tx.query("SELECT * FROM events ORDER BY seq"));
    const content = await store.read((tx) => tx.query("SELECT * FROM content ORDER BY seq, path"));
    await replica.write(async (tx) => {
      for (const [table, rs] of [
        ["events", events.rows],
        ["content", content.rows],
      ] as const) {
        for (const r of rs) {
          const cols = Object.keys(r as object);
          await tx.query(
            `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
            Object.values(r as object) as never,
          );
        }
      }
      const last = (await readTail(tx))?.seq ?? 0;
      await applyEvents(tx, await readEvents(tx, 1, last));
    });
  }, T);

  afterAll(async () => {
    await replica?.close();
  }, 120_000);

  it(
    "every materialized table, every physical table and its shape are equal",
    async () => {
      const live = await store.read(state);
      expect(live["physical shapes"]?.length).toBeGreaterThan(0);
      expect(live["pending_items"]).toHaveLength(2);
      expect(await replica.read(state)).toEqual(live);
    },
    T,
  );

  it.each([
    ["an index dropped", 'DROP INDEX "t_t2_v1__ver_row"'],
    ["an index added", 'CREATE INDEX "t_t2_v1_x" ON "t_t2_v1" (valid_to)'],
    [
      "a business table's primary key dropped",
      'ALTER TABLE "t_t2_v1" DROP CONSTRAINT "t_t2_v1_pkey"',
    ],
    ["a default dropped", 'ALTER TABLE "t_t1_v1" ALTER COLUMN revoked DROP DEFAULT'],
    [
      "a numeric given a precision",
      'ALTER TABLE "t_t1_v1" ALTER COLUMN "f_f3" TYPE numeric(10, 2)',
    ],
  ])(
    "a physical table's shape changed by hand is found: %s",
    async (_, ddl) => {
      const replicaState = await replica.read(state);
      // Changed in a transaction that then rolls back, so the cases do not add up.
      const differs = await store
        .write(async (tx) => {
          await tx.exec(ddl);
          const changed = JSON.stringify(await state(tx)) !== JSON.stringify(replicaState);
          throw Object.assign(new Error("roll back"), { changed });
        })
        .catch((e: { changed?: boolean }) => e.changed);
      expect(differs).toBe(true);
      expect(await store.read(state)).toEqual(replicaState);
    },
    T,
  );

  it(
    "a table created by hand, bypassing apply, is found",
    async () => {
      await store.write((tx) => tx.exec('CREATE TABLE "t_t9_v1" (row_id TEXT)'));
      expect(await replica.read(state)).not.toEqual(await store.read(state));
    },
    T,
  );
});
