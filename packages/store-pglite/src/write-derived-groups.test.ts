// The derived refresh through the write pipeline, narrowed to the affected groups (06-derived.md
// «刷新范围与写入准入»), on what the other files do not reach: a rule whose WHERE fails on the new
// data fails the write as the recomputation does (validation_failed, rule_eval_failed), though the
// groups of the changed rows are worked out first; and a timeless table, whose rows have no time.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  derivedLayout,
  evaluateRule,
  eventsOf,
  loadRsql,
  type ReadTx,
  readBufferOf,
  readTail,
} from "@fluxvita/saveslot-kernel";
import { derivedSchema, rule, TABLES } from "@fluxvita/saveslot-kernel/rsql-testing";
import { createSlotEvents, SLOT, writeInTx } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore, snapshot } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

type Schema = ReturnType<typeof derivedSchema>;
type Derived = Extract<Schema["tables"][number], { kind: "derived" }>;

const RULES = [
  // A WHERE that overflows 64 bits on a large `laps` (a database data error, 22003).
  ["t9", "long_runs", "SELECT count(*) AS n FROM runs WHERE laps * 4000000000 > 0", ["n"], "none"],
  // Over the timeless table `shoes`, by model.
  ["t10", "by_model", "SELECT model AS m, count(*) AS n FROM shoes GROUP BY 1", ["m", "n"], "none"],
] as const;
type DerivedId = (typeof RULES)[number][0];

let schema: Schema;
let s: ReusableStore;
let minute = 0;
let ids = 0;
const now = () => `2026-11-10T08:${String(minute++ % 60).padStart(2, "0")}:00.000Z`;
const newId = (kind: "row" | "entity" | "source" | "item" | "partition") => {
  ids++;
  const n = String(ids).padStart(kind === "row" || kind === "entity" ? 26 : 16, "0");
  return `${{ row: "r_", entity: "e_", source: "s_", item: "pi_", partition: "p_" }[kind]}${n}`;
};

beforeAll(async () => {
  await loadRsql();
  const derived = RULES.map(([id, name, sql, fields, td], i): Derived => {
    const t = derivedSchema(rule(sql, fields, td)).tables.find((x) => x.id === "t9") as Derived;
    return {
      ...t,
      id,
      name,
      physical: { table: `d_${id}_v1` },
      rule: { ...t.rule, id: `r${i + 1}` as Derived["rule"]["id"] },
    } as Derived;
  });
  const base = derivedSchema(rule(RULES[0][2], RULES[0][3], RULES[0][4]));
  const shoes = TABLES.find((t) => t.id === "t5");
  if (shoes === undefined) throw new Error("no shoes in the fixture");
  schema = {
    ...base,
    slot: SLOT,
    tables: [
      ...base.tables.filter((t) => t.kind === "base"),
      ...(base.tables.some((t) => t.id === "t5") ? [] : [shoes]),
      ...derived,
    ],
  } as Schema;
  s = await openReusable("saveslot-write-derived-groups-");
}, T);

afterAll(async () => {
  await s?.close();
}, T);

beforeEach(async () => {
  await s.reset();
  readBufferOf(s.store).take();
  ids = 0;
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
      now: "2026-11-10T04:00:00.000Z",
      confirmation: null,
    }),
  );
  const change = (target: Record<string, unknown>, kind: string) => ({
    target,
    change: kind,
    class: "create",
    compatible_with_old_writes: true,
    destructive: false,
    auto: true,
  });
  const events = createSlotEvents({
    compiled: schema as never,
    changes: [
      change({ slot: true }, "create_slot"),
      ...schema.tables.map((t) =>
        change({ table: t.id }, t.kind === "base" ? "add_table" : "add_derived_table"),
      ),
    ] as never,
  });
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-10T04:00:30.000Z" as never,
      events,
    });
    await applyEvents(tx, eventsOf(op));
  });
}, T);

type Receipt = {
  readonly seq: number;
  readonly ops: readonly { readonly target: { readonly row?: string }; readonly ver?: string }[];
};

/** Sends `params` through the pipeline; the error's code and details, if refused. */
async function send(params: unknown): Promise<Receipt & Record<string, unknown>> {
  try {
    return (await s.store.write((tx) =>
      writeInTx(tx, {
        actor: USER as never,
        task: null,
        now: now() as never,
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

const rowOf = (r: Receipt) => r.ops[0]?.target.row as string;
const verOf = (r: Receipt) => r.ops[0]?.ver as string;
const tailSeq = () => s.store.read(async (tx) => (await readTail(tx))?.seq ?? 0);

/** A derived table as stored and as its rule gives it, each by decoded key. */
async function compare(tx: ReadTx, id: DerivedId) {
  const t = schema.tables.find((x) => x.id === id) as Derived;
  const e = evaluateRule(schema, id);
  const want = new Map<string, unknown>();
  for (const r of (await tx.query<Record<string, unknown>>(e.all.sql)).rows) {
    const d = e.decode(r);
    if (d !== undefined) want.set(JSON.stringify(d.key), d.values);
  }
  const l = derivedLayout(t);
  const cols = l.fields.map(({ field, column }) =>
    field.type === "boolean"
      ? `"${column}" AS "${field.id}"`
      : `CAST("${column}" AS text) AS "${field.id}"`,
  );
  const got = new Map<string, unknown>();
  for (const r of (
    await tx.query<Record<string, unknown>>(`SELECT ${cols.join(", ")} FROM "${l.table}"`)
  ).rows) {
    const d = e.decode({ ...r, inputs: "1" });
    if (d !== undefined) got.set(JSON.stringify(d.key), d.values);
  }
  return { got: [...got].sort(), want: [...want].sort() };
}

const expectRefreshed = () =>
  s.store.read(async (tx) => {
    for (const [id] of RULES) {
      const c = await compare(tx, id);
      expect(c.got, id).toEqual(c.want);
    }
  });

const RULE_FAILED = {
  refused: "validation_failed",
  reason: "write",
  details: [{ code: "rule_eval_failed", sql_reason: "runtime" }],
};

describe("a rule failing on the new data, the groups worked out first", () => {
  it(
    "a new row whose laps make the rule's WHERE overflow: validation_failed (rule_eval_failed), nothing kept",
    async () => {
      const a = await send({
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "runs",
            set: { date: "2026-11-02", distance: { value: "1", unit: "km" }, laps: 3 },
          },
        ],
      });
      expect(a).not.toHaveProperty("refused");
      const before = await tailSeq();
      const snap = await s.store.read(snapshot);
      const r = await send({
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "runs",
            set: {
              date: "2026-11-03",
              distance: { value: "1", unit: "km" },
              laps: "9000000000000000000",
            },
          },
        ],
      });
      expect(r).toEqual(RULE_FAILED);
      expect(await tailSeq()).toBe(before);
      expect(await s.store.read(snapshot)).toEqual(snap);
    },
    T,
  );

  it(
    "a row changed to such laps: the same refusal, nothing kept",
    async () => {
      const a = await send({
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "runs",
            set: { date: "2026-11-02", distance: { value: "1", unit: "km" }, laps: 3 },
          },
        ],
      });
      const before = await tailSeq();
      const r = await send({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "runs",
            row: rowOf(a),
            ver: verOf(a),
            set: { laps: "9000000000000000000" },
          },
        ],
      });
      expect(r).toEqual(RULE_FAILED);
      expect(await tailSeq()).toBe(before);
    },
    T,
  );
});

describe("a timeless table", () => {
  it(
    "inserts, a row moved to another model, a revoke and its undo: each derived table equals its rule",
    async () => {
      const shoe = (model: string) =>
        send({ sv: 1, ops: [{ intent: "insert", table: "shoes", set: { model } }] });
      const a = await shoe("pegasus");
      const b = await shoe("ghost");
      const c = await shoe("pegasus-2");
      for (const r of [a, b, c]) expect(r).not.toHaveProperty("refused");
      await expectRefreshed();
      const moved = await send({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "shoes",
            row: rowOf(a),
            ver: verOf(a),
            set: { model: "ghost" },
          },
        ],
      });
      expect(moved).not.toHaveProperty("refused");
      await expectRefreshed();
      const revoked = await send({
        sv: 1,
        ops: [{ intent: "revoke", table: "shoes", row: rowOf(b), ver: verOf(b) }],
      });
      expect(revoked).not.toHaveProperty("refused");
      await expectRefreshed();
      const undone = await send({
        sv: 1,
        ops: [{ table: "shoes", row: rowOf(b), revert: { undo: revoked.seq } }],
      });
      expect(undone).not.toHaveProperty("refused");
      await expectRefreshed();
      expect(evaluateRule(schema, "t10").narrowable).toBe(true);
    },
    T,
  );
});
