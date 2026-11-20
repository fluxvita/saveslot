// planEvent for the slot creation path, sources, request keys and pending items
// (09-event-format §4.5, §5.4–§5.8): the changes each event makes, the physical tables of a
// version, and the forms this phase stops on. Storage-backed tests are in store-pglite.

import type { JsonValue } from "@fluxvita/saveslot-contract-core";
import { beforeAll, describe, expect, it } from "vitest";
import { buildOperation, type NewEvent } from "../log/index.ts";
import { loadRsql } from "../rules/index.ts";
import {
  ApplyError,
  type ApplyEvent,
  baseTableDdl,
  eventsOf,
  type PlanInputs,
  planEvent,
  type SlotInput,
} from "./apply.ts";
import { CHANGES_V1, COMPILED_V1, createSlotEvents, DRAFT, SLOT } from "./slot.fixture.ts";

beforeAll(() => loadRsql());

const USER = `u_${"1".repeat(26)}` as const;
const ROW = `r_${"6".repeat(26)}`;
const ENTITY = `e_${"7".repeat(26)}`;
const ITEM = `pi_${"8".repeat(16)}`;
const SOURCE = `s_${"3".repeat(16)}`;
const MIGRATION = `m_${"3".repeat(16)}`;
const HASH = "a".repeat(64);
const NOW = "2026-11-10T04:00:00.000Z";

/** The events of one operation appended after `after`. */
const op = (after: number, events: NewEvent[]): ApplyEvent[] =>
  eventsOf(
    buildOperation({ seq: after, hash: HASH, at: NOW }, { actor: USER, now: NOW as never, events }),
  );

const reason = (ev: ApplyEvent, inputs: PlanInputs = {}) => {
  try {
    planEvent(ev, inputs);
  } catch (e) {
    if (e instanceof ApplyError)
      return `${e.reason}: ${e.message.replace(/^apply stopped at seq \d+: /, "")}`;
    throw e;
  }
  return "applied";
};

const slotOp = (o: Parameters<typeof createSlotEvents>[0] = {}) => op(1, createSlotEvents(o));
const freshSlot: SlotInput = { currentSv: null, policySeq: 5, tables: new Set<string>() };
const switchInput = (seq = 3, slot = freshSlot): PlanInputs => ({
  switchTo: { seq, compiled: COMPILED_V1 },
  slot,
});

describe("planEvent: creating a slot", () => {
  it("submitted, compiled, confirmed, policy, switched: the slot row, then its version and tables", () => {
    const [draft, compiled, confirmed, policy, switched] = slotOp({
      requestKey: "k1",
    }) as ApplyEvent[];
    expect(planEvent(draft as ApplyEvent)).toEqual([
      { kind: "request_key", key: "k1", op: 2, at: NOW, fingerprint: null },
    ]);
    expect(planEvent(compiled as ApplyEvent)).toEqual([
      { kind: "slot_insert", id: SLOT, name: "ledger", timezone: "Asia/Shanghai" },
    ]);
    expect(planEvent(confirmed as ApplyEvent)).toEqual([]);
    expect(planEvent(policy as ApplyEvent)).toEqual([
      { kind: "slot_policy", id: SLOT, seq: 5, policy_version: 1 },
    ]);
    const changes = planEvent(switched as ApplyEvent, switchInput());
    expect(changes.map((c) => c.kind)).toEqual([
      "ddl",
      ...COMPILED_V1.tables.flatMap(() => ["catalog_insert", "counts_init"]),
      "version_switch",
    ]);
    expect(changes.at(-1)).toEqual({
      kind: "version_switch",
      slot: SLOT,
      sv: 1,
      compiled_seq: 3,
      draft_id: DRAFT,
      name: "ledger",
      timezone: "Asia/Shanghai",
    });
    const ddl = changes[0] as { sql: string };
    expect(ddl.sql).toBe(COMPILED_V1.tables.map((t) => baseTableDdl(t)).join("\n"));
    // The catalog keeps each table's definition as compiled, without its physical name.
    const catalog = changes[1] as { table_id: string; structure: string };
    expect(catalog.table_id).toBe("t1");
    expect(JSON.parse(catalog.structure)).toEqual(
      (({ physical: _, ...rest }) => rest)(COMPILED_V1.tables[0]),
    );
  });

  it("a switch the state does not allow is inconsistent: decided in the plan", () => {
    const switched = slotOp()[4] as ApplyEvent;
    expect(reason(switched, { slot: freshSlot })).toBe("inconsistent: no compiled version 1");
    expect(reason(switched, { switchTo: { seq: 3, compiled: COMPILED_V1 } })).toBe(
      `inconsistent: no slot ${SLOT}`,
    );
    expect(reason(switched, switchInput(3, { ...freshSlot, currentSv: 1 }))).toBe(
      `inconsistent: slot ${SLOT} already has version 1`,
    );
    expect(reason(switched, switchInput(3, { ...freshSlot, policySeq: null }))).toBe(
      `inconsistent: slot ${SLOT} has no policy`,
    );
    expect(reason(switched, switchInput(3, { ...freshSlot, tables: new Set(["t3"]) }))).toBe(
      "inconsistent: table t3 already exists",
    );
  });
});

describe("baseTableDdl: the physical tables of a base table", () => {
  const [t1, t2, t3, t4] = COMPILED_V1.tables;

  it("a state table: entity, interval by its granularity, field columns; the version table by cell", () => {
    expect(baseTableDdl(t2)).toBe(
      [
        'CREATE TABLE "t_t2_v1" (',
        '  entity_id TEXT COLLATE "C" NOT NULL,',
        "  valid_from DATE NOT NULL,",
        "  valid_to DATE,",
        '  "f_f1" TEXT COLLATE "C",',
        '  "f_f2" BIGINT,',
        "  PRIMARY KEY (entity_id, valid_from)",
        ");",
        'CREATE TABLE "t_t2_v1__ver" (',
        '  row_id TEXT COLLATE "C" NOT NULL,',
        '  field_id TEXT COLLATE "C" NOT NULL,',
        "  valid_from DATE NOT NULL,",
        "  valid_to DATE,",
        "  rec_from BIGINT NOT NULL,",
        "  rec_to BIGINT,",
        '  intent TEXT COLLATE "C" NOT NULL,',
        "  src_event BIGINT,",
        '  src_field TEXT COLLATE "C",',
        "  src_k INTEGER,",
        "  revoked BOOLEAN,",
        "  no_value BOOLEAN,",
        '  "f_f1" TEXT COLLATE "C",',
        '  "f_f2" BIGINT,',
        "  PRIMARY KEY (row_id, field_id, valid_from, rec_from)",
        ");",
        'CREATE INDEX "t_t2_v1__ver_row" ON "t_t2_v1__ver" (row_id, rec_from);',
      ].join("\n"),
    );
    expect(baseTableDdl(t3)).toContain("valid_from TIMESTAMPTZ NOT NULL,\n  valid_to TIMESTAMPTZ,");
  });

  it("an event or timeless table: a row ID and the revoked mark; no interval in its version cells", () => {
    const ddl = baseTableDdl(t4);
    expect(ddl).toContain(
      'CREATE TABLE "t_t4_v1" (\n  row_id TEXT COLLATE "C" PRIMARY KEY,\n  revoked BOOLEAN NOT NULL DEFAULT FALSE,\n  "f_f1" TEXT COLLATE "C"\n);',
    );
    expect(ddl).toContain("PRIMARY KEY (row_id, field_id, rec_from)");
    expect(ddl).not.toContain("valid_from");
  });

  it("each field type its SQL type; a zoned_datetime keeps its zone beside the instant", () => {
    const business = baseTableDdl(t1).split(");")[0] as string;
    expect(business.split("\n").filter((l) => l.includes('"f_'))).toEqual([
      '  "f_f1" DATE,',
      '  "f_f2" TEXT COLLATE "C",',
      '  "f_f3" NUMERIC,',
      '  "f_f4" TEXT COLLATE "C",',
      '  "f_f5" BIGINT,',
      '  "f_f6" NUMERIC,',
      '  "f_f7" BOOLEAN,',
      '  "f_f8" TIMESTAMPTZ,',
      '  "f_f8__zone" TEXT COLLATE "C",',
      '  "f_f9" TEXT COLLATE "C"',
    ]);
  });
});

describe("baseTableDdl checks the names it puts into SQL itself", () => {
  const t = COMPILED_V1.tables[3];
  it.each([
    ["a quoted table name", { ...t, physical: { table: 't_t4_v1"; DROP TABLE events; --' } }],
    ["a name of another table", { ...t, physical: { table: "t_t5_v1" } }],
    [
      "a table ID of ten digits",
      { ...t, id: "t1234567890", physical: { table: "t_t1234567890_v1" } },
    ],
    ["a quoted field ID", { ...t, fields: [{ ...t.fields[0], id: 'f1" TEXT, x' }] }],
  ])("%s", (_, bad) => {
    expect(() => baseTableDdl(bad as never)).toThrow(/^not a (physical table name|field ID)/);
  });
});

describe("planEvent: what this phase stops on, never skips", () => {
  const derived = {
    id: "t5",
    name: "totals",
    kind: "derived",
    description: "sums",
    physical: { table: "d_t5_v1" },
    // Depends on today: computed at read time.
    rule: {
      id: "r1",
      version: 1,
      rsql: "rsql@1",
      sql: 'SELECT count("t1"."f5") AS "f1" FROM "t1" WHERE ("t1"."f1" > saveslot_today())',
      time_dependency: "now",
      depends_on: [
        { table: "t1", field: "f1" },
        { table: "t1", field: "f5" },
      ],
      scope: { kind: "tenant" },
    },
    fields: [{ id: "f1", name: "n", type: "integer", description: "rows" }],
  };
  const withTables = (tables: unknown[]) => ({ ...COMPILED_V1, tables }) as unknown as JsonValue;

  it.each([
    [
      "a derived table whose rule does not check against its definition",
      {
        compiled: withTables([
          ...COMPILED_V1.tables,
          {
            ...derived,
            rule: { ...derived.rule, sql: 'SELECT count("t1"."f99") AS "f1" FROM "t1"' },
          },
        ]),
      },
      expect.stringMatching(/^inconsistent: derived table t5: its rule does not check \(/),
    ],
    [
      "an external key",
      { compiled: withTables([{ ...COMPILED_V1.tables[3], external_key: ["f1"] }]) },
      "not_implemented: external key of t4 is not applied yet",
    ],
    [
      "an rsql version the kernel does not know",
      { compiled: { ...COMPILED_V1, rsql: "rsql@2" } as unknown as JsonValue },
      "unknown_version: unknown rsql version rsql@2",
    ],
    [
      "a definition for another slot",
      { compiled: { ...COMPILED_V1, slot: `sl_${"9".repeat(16)}` } as unknown as JsonValue },
      `inconsistent: compiled for sl_${"9".repeat(16)} in slot ${SLOT}`,
    ],
    [
      "a change to a slot (no create_slot)",
      { changes: CHANGES_V1.slice(1) as unknown as JsonValue },
      "not_implemented: a change applied at once is not applied yet",
    ],
  ])("schema.compiled with %s", (_, o, expected) => {
    expect(reason(slotOp(o)[1] as ApplyEvent)).toEqual(expected);
  });

  it("schema.compiled awaiting confirmation", () => {
    const changes = CHANGES_V1.map((c) => ({ ...c, auto: false }));
    const [, compiled] = op(1, [
      createSlotEvents()[0] as NewEvent,
      {
        type: "schema.compiled",
        slot: SLOT,
        blocks: {
          target: { draft_id: DRAFT, target_version: 1, outcome: "pending" },
          compiled: COMPILED_V1 as unknown as JsonValue,
          changes: changes as unknown as JsonValue,
        },
      },
    ]);
    expect(reason(compiled as ApplyEvent)).toBe(
      "not_implemented: a slot awaiting confirmation is not applied yet",
    );
  });

  it("schema.switched from an earlier version (a schema change)", () => {
    const evs = op(9, [
      createSlotEvents()[0] as NewEvent,
      {
        type: "schema.switched",
        slot: SLOT,
        blocks: { target: { draft_id: DRAFT, from_version: 1, to_version: 2, rebuilt_tables: [] } },
      },
    ]);
    expect(reason(evs[1] as ApplyEvent)).toBe(
      "not_implemented: a switch from an earlier version is not applied yet",
    );
  });

  it("a block at path __proto__ is checked like any other path, not taken as the prototype", () => {
    const [ev] = slotOp();
    for (const value of [{ request_key: { key: "smuggled" } }, 5]) {
      const blocks = new Map((ev as ApplyEvent).blocks);
      blocks.set("__proto__", { state: "present", value });
      expect(reason({ ...(ev as ApplyEvent), blocks })).toMatch(/^invalid: .*__proto__/);
    }
  });

  it("a draft changing a slot", () => {
    const [ev] = op(9, [
      {
        type: "schema.draft_submitted",
        slot: SLOT,
        blocks: {
          ctx: { now: NOW, today: "2026-11-10", ruleset_version: 1, policy_version: 1 },
          target: { draft_id: DRAFT, creates_slot: false, base_version: 1 },
          draft: {},
        },
      },
    ]);
    // The draft is in the log; what it becomes is the events after it.
    expect(planEvent(ev as ApplyEvent)).toEqual([]);
  });

  it("a slot whose definition has a table built in an earlier version", () => {
    const v2 = {
      ...COMPILED_V1,
      sv: 2,
      tables: COMPILED_V1.tables.map((x, i) =>
        i === 0
          ? { ...x, physical: { table: "t_t1_v1", since: 1 } }
          : { ...x, physical: { table: `t_${x.id}_v2` } },
      ),
    } as unknown as JsonValue;
    const evs = op(1, [
      createSlotEvents()[0] as NewEvent,
      {
        type: "schema.compiled",
        slot: SLOT,
        blocks: {
          target: { draft_id: DRAFT, target_version: 2, outcome: "applied" },
          compiled: v2,
          changes: CHANGES_V1 as unknown as JsonValue,
        },
      },
    ]);
    expect(reason(evs[1] as ApplyEvent)).toBe(
      "not_implemented: table t1 built in version 1 is not applied yet",
    );
    const switched = slotOp()[4] as ApplyEvent;
    expect(reason(switched, { switchTo: { seq: 3, compiled: v2 as never }, slot: freshSlot })).toBe(
      "not_implemented: table t1 built in version 1 is not applied yet",
    );
  });

  it.each([
    ["key_from", { key_from: `r_${"5".repeat(26)}` }],
    ["by_external_key", { by_external_key: true }],
  ])("a write.head whose op has %s", (_, extra) => {
    const [head] = op(20, [
      {
        type: "write.head",
        slot: SLOT,
        blocks: {
          ctx: writeCtx,
          request: { sv: 1, sv_basis: "explicit", op_count: 1 },
          "ops/0/target": { table: "t4", row: ROW, intent: "update", ...extra },
        },
      },
    ]);
    expect(reason(head as ApplyEvent)).toBe(
      "not_implemented: ops/0/target: writes by external key are not applied yet",
    );
  });

  it.each([
    ["schema.rejected", { target: { draft_id: DRAFT } }],
    [
      "schema.migration_started",
      { target: { migration_id: MIGRATION, draft_id: DRAFT, from_version: 1, to_version: 2 } },
    ],
  ])("%s", (type, blocks) => {
    const head = op(9, [
      {
        type: "schema.draft_submitted",
        slot: SLOT,
        blocks: {
          ctx: { now: NOW, today: "2026-11-10", ruleset_version: 1, policy_version: 1 },
          target: { draft_id: DRAFT, creates_slot: true },
          draft: {},
        },
      },
      { type: type as never, slot: SLOT, blocks },
    ]);
    expect(reason(head[1] as ApplyEvent)).toBe(
      `not_implemented: apply of ${type} is not implemented yet`,
    );
  });
});

// --- sources, request keys, items ----------------------------------------------------------------

const writeCtx = {
  now: NOW,
  today: "2026-11-10",
  ruleset_version: 1,
  policy_version: 1,
  literal_checker: "literal@1",
};
const writeHead = (extra: Record<string, JsonValue> = {}): NewEvent => ({
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
const segment = (op: number) => ({
  field: "f2",
  value: "2",
  valid: { from: "2026-11-01", to: "2026-11-05" },
  op,
  deps: [{ event: op + 1, field: "f2", k: 0 }],
});

describe("planEvent: sources and request keys", () => {
  it("source.recorded: the source of the slot, present", () => {
    const [head, source] = op(20, [
      writeHead(),
      {
        type: "source.recorded",
        slot: SLOT,
        blocks: {
          target: { source_id: SOURCE, kind: "user_message", level: "user_stated" },
          text: { text: "lunch 32" },
        },
      },
    ]);
    expect(planEvent(head as ApplyEvent)).toEqual([]);
    expect(planEvent(source as ApplyEvent)).toEqual([
      {
        kind: "source",
        seq: 22,
        source_id: SOURCE,
        source_kind: "user_message",
        level: "user_stated",
        slot: SLOT,
      },
    ]);
  });

  it("a head event's request key or idempotency key names its operation", () => {
    const [byKey] = op(20, [writeHead({ request_key: { key: "k2" } })]);
    expect(planEvent(byKey as ApplyEvent)).toEqual([
      { kind: "request_key", key: "k2", op: 21, at: NOW, fingerprint: null },
    ]);
    const [byIdem] = op(20, [writeHead({ idempotency: { key: "k3", fingerprint: HASH } })]);
    expect(planEvent(byIdem as ApplyEvent)).toEqual([
      { kind: "request_key", key: "k3", op: 21, at: NOW, fingerprint: HASH },
    ]);
  });
});

describe("planEvent: pending items", () => {
  const conflictTarget = {
    item: ITEM,
    type: "conflict",
    reason: "stale_write",
    table: "t2",
    entity: ENTITY,
    unit: ["f2"],
    merge_base_op: 10,
    origin_event: 32,
    ...versions,
  };

  it("item.created: an open item, its entries by path, the flag of its type with unit and interval", () => {
    const evs = op(30, [
      writeHead(),
      {
        type: "item.created",
        slot: SLOT,
        blocks: {
          target: conflictTarget,
          scope_valid: {
            spans: [{ from: "2026-11-01", to: "2026-11-05" }],
            deps: [{ event: 32, field: "f2", k: 0 }],
          },
          "current/0": segment(20),
          "candidates/0": candidate(32),
          "previous/0": (({ op: _, ...rest }) => rest)(segment(10)),
        },
      },
    ]);
    const created = evs[1] as ApplyEvent;
    expect(planEvent(created)).toEqual([
      {
        kind: "item_insert",
        row: {
          id: ITEM,
          type: "conflict",
          slot_id: SLOT,
          target_table: "t2",
          target_row: ENTITY,
          state: "open",
          version_op: 31,
        },
      },
      {
        kind: "entries_insert",
        entries: ["candidates/0", "current/0", "previous/0", "scope_valid"].map((path, n) => ({
          item: ITEM,
          n,
          seq: 32,
          path,
        })),
      },
      {
        kind: "flag_insert",
        row: {
          table_id: "t2",
          row_id: ENTITY,
          flag: "disputed",
          item_id: ITEM,
          fields: '["f2"]',
          spans: '[{"from":"2026-11-01","to":"2026-11-05"}]',
        },
      },
      {
        // Every entry block's deps, in path order (§5.12 the block dependency index).
        kind: "block_deps",
        rows: [
          ["candidates/0", 32],
          ["current/0", 21],
          ["previous/0", 11],
          ["scope_valid", 32],
        ].map(([path, event]) => ({
          seq: 32,
          path,
          n: 0,
          dep_event: event,
          dep_field: "f2",
          dep_k: 0,
          dep_kind: "deps",
        })),
      },
    ]);
    // Entries are numbered by path, whatever order the blocks come in.
    const reversed: ApplyEvent = { ...created, blocks: new Map([...created.blocks].reverse()) };
    expect(planEvent(reversed)).toEqual(planEvent(created));
    // A removed entry block still stands where it was.
    const removed: ApplyEvent = {
      ...created,
      blocks: new Map(
        [...created.blocks].map(([p, b]) => [
          p,
          p === "current/0" ? { state: "removed", by: 99 } : b,
        ]),
      ),
    };
    expect(planEvent(removed)[1]).toMatchObject({
      entries: expect.arrayContaining([expect.objectContaining({ path: "current/0" })]),
    });
    // ...but depends on nothing: its content is gone.
    const deps = planEvent(removed).find((c) => c.kind === "block_deps") as unknown as {
      rows: { path: string }[];
    };
    expect(deps.rows.map((r) => r.path)).toEqual(["candidates/0", "previous/0", "scope_valid"]);
  });

  it("item.created: awaiting on existence, flagged without a unit or interval, a schema change without a flag", () => {
    const awaiting = op(30, [
      writeHead(),
      {
        type: "item.created",
        slot: SLOT,
        blocks: {
          target: {
            item: ITEM,
            type: "awaiting_confirmation",
            reason: "undo_hides_later",
            table: "t4",
            row: ROW,
            unit: ["existence"],
            origin_event: 32,
            ...versions,
          },
        },
      },
    ])[1] as ApplyEvent;
    expect(planEvent(awaiting).at(-1)).toEqual({
      kind: "flag_insert",
      row: {
        table_id: "t4",
        row_id: ROW,
        flag: "awaiting",
        item_id: ITEM,
        fields: '["existence"]',
        spans: null,
      },
    });
    const flagged = op(30, [
      writeHead(),
      {
        type: "item.created",
        slot: SLOT,
        blocks: {
          target: {
            item: ITEM,
            type: "flagged",
            reason: "duplicate_keys",
            table: "t1",
            row: ROW,
            origin_event: 32,
            ...versions,
          },
        },
      },
    ])[1] as ApplyEvent;
    expect(planEvent(flagged).at(-1)).toMatchObject({ row: { flag: "flagged", fields: null } });
    const schema = op(30, [
      {
        type: "schema.draft_submitted",
        slot: SLOT,
        blocks: {
          ctx: { now: NOW, today: "2026-11-10", ruleset_version: 1, policy_version: 1 },
          target: { draft_id: DRAFT, creates_slot: true },
          draft: {},
        },
      },
      {
        type: "item.created",
        slot: SLOT,
        blocks: {
          target: {
            item: ITEM,
            type: "schema_change",
            reason: "schema_change",
            draft: DRAFT,
            ...versions,
          },
        },
      },
    ])[1] as ApplyEvent;
    expect(planEvent(schema).map((c) => c.kind)).toEqual(["item_insert", "entries_insert"]);
  });

  it("item.created: an entry depending on an existence item", () => {
    const created = op(50, [
      writeHead(),
      {
        type: "item.created",
        slot: SLOT,
        blocks: {
          target: { ...conflictTarget, unit: ["existence"], origin_event: 52 },
          "candidates/0": {
            event: 52,
            intent: "revoke",
            seen: { op: 10, restore_count: 0 },
            cause: "stale_write",
            items: [{ existence: 0, valid: { from: "2026-11-01", to: "2026-11-05" } }],
            deps: [{ event: 52, existence: 0 }],
          },
        },
      },
    ])[1] as ApplyEvent;
    expect(planEvent(created).at(-1)).toEqual({
      kind: "block_deps",
      rows: [
        {
          seq: 52,
          path: "candidates/0",
          n: 0,
          dep_event: 52,
          dep_field: "existence",
          dep_k: 0,
          dep_kind: "deps",
        },
      ],
    });
  });

  it("item.merged: version, whole groups replaced, new entries numbered on, the flag's interval", () => {
    const merged = op(40, [
      writeHead(),
      {
        type: "item.merged",
        slot: SLOT,
        blocks: {
          target: { item: ITEM, merge_base_op: 9, origin_event: 42, ...versions },
          "candidates/1": candidate(42),
          scope_valid: {
            spans: [{ from: "2026-10-30", to: "2026-11-05" }],
            deps: [{ event: 42, field: "f2", k: 0 }],
          },
        },
      },
    ])[1] as ApplyEvent;
    expect(planEvent(merged, { item: { state: "open", nextEntry: 4 } })).toEqual([
      { kind: "item_update", id: ITEM, version_op: 41 },
      {
        kind: "entries_drop",
        item: ITEM,
        groups: ["scope_valid", "previous", "impact"],
        paths: [],
      },
      {
        kind: "entries_insert",
        entries: [
          { item: ITEM, n: 4, seq: 42, path: "candidates/1" },
          { item: ITEM, n: 5, seq: 42, path: "scope_valid" },
        ],
      },
      { kind: "flag_valid", item: ITEM, spans: '[{"from":"2026-10-30","to":"2026-11-05"}]' },
      {
        kind: "block_deps",
        rows: ["candidates/1", "scope_valid"].map((path) => ({
          seq: 42,
          path,
          n: 0,
          dep_event: 42,
          dep_field: "f2",
          dep_k: 0,
          dep_kind: "deps",
        })),
      },
    ]);
  });

  it("item.refreshed: its groups whole, candidates by index; no scope_valid is an empty group", () => {
    const refreshed = op(50, [
      writeHead(),
      {
        type: "item.refreshed",
        slot: SLOT,
        blocks: {
          target: { item: ITEM, by_event: 52, writer_had_read: false, cause: "target_overwritten" },
          "current/0": segment(50),
          "candidates/1": candidate(42),
        },
      },
    ])[1] as ApplyEvent;
    const changes = planEvent(refreshed, { item: { state: "open", nextEntry: 6 } });
    expect(changes[1]).toEqual({
      kind: "entries_drop",
      item: ITEM,
      groups: ["scope_valid", "current", "previous", "impact", "proposed"],
      paths: ["candidates/1"],
    });
    expect(changes[3]).toEqual({ kind: "flag_valid", item: ITEM, spans: null });
  });

  it("an update of an item that is missing or not open is inconsistent: decided in the plan", () => {
    const superseded = op(60, [
      writeHead(),
      {
        type: "item.superseded",
        slot: SLOT,
        blocks: {
          target: { item: ITEM, reason: "overwritten", by_event: 62, writer_had_read: true },
        },
      },
    ])[1] as ApplyEvent;
    expect(reason(superseded)).toBe(`inconsistent: no open item ${ITEM}`);
    expect(reason(superseded, { item: { state: "resolved", nextEntry: 3 } })).toBe(
      `inconsistent: no open item ${ITEM}`,
    );
  });

  it("item.superseded and item.resolved: the state, the decision, the flags gone", () => {
    const superseded = op(60, [
      writeHead(),
      {
        type: "item.superseded",
        slot: SLOT,
        blocks: {
          target: { item: ITEM, reason: "overwritten", by_event: 62, writer_had_read: true },
        },
      },
    ])[1] as ApplyEvent;
    expect(planEvent(superseded, { item: { state: "open", nextEntry: 0 } })).toEqual([
      { kind: "item_update", id: ITEM, state: "superseded", version_op: 61 },
      { kind: "flags_drop", item: ITEM },
    ]);
    const [resolved] = op(70, [
      {
        type: "item.resolved",
        slot: SLOT,
        blocks: {
          ctx: { now: NOW, today: "2026-11-10", ruleset_version: 1, policy_version: 1 },
          request_key: { key: "k4" },
          target: {
            item: ITEM,
            decision: "keep_effective",
            item_op: 41,
            restore_count: 0,
            via: "call",
          },
        },
      },
    ]);
    expect(planEvent(resolved as ApplyEvent, { item: { state: "open", nextEntry: 0 } })).toEqual([
      { kind: "item_update", id: ITEM, state: "resolved", decision: "keep_effective" },
      { kind: "flags_drop", item: ITEM },
      { kind: "request_key", key: "k4", op: 71, at: NOW, fingerprint: null },
    ]);
  });
});
