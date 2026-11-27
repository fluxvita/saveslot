// `detail: "detailed"` on `query` (04-contract-types §4.1 `RowDetail`; 04-contract §10 `detail`):
// each row's last change and when it was recorded; each field read with its literal result and
// source level (03-deletion «字段的来源级别»: 仍在的值来源里，字面命中的那些证据段的声明级别取最高;
// any segment hit → hit, else any miss → miss, else na); a ref field with a summary of the row it
// names, read as the page is and recorded as read; every premise in effect on the row, current
// or changed. With `fields`, only the fields read.

import {
  createOpsContext,
  createTenant,
  history,
  pending,
  query,
  readBufferOf,
  resolve,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"9".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const OTHER = `ci_${"2".repeat(26)}`;
// biome-ignore lint/suspicious/noExplicitAny: receipts and rows read loosely in a test
type Any = any;

const DOCUMENT = {
  slot: "food",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: "meals",
      kind: "base",
      description: "a meal",
      time: { type: "none" },
      fields: [{ name: "name", type: "text", required: true, description: "what" }],
    },
    {
      name: "chefs",
      kind: "base",
      description: "a chef over time",
      time: { type: "state", granularity: "date" },
      entity_key: ["chef"],
      fields: [
        { name: "chef", type: "text", required: true, description: "who" },
        { name: "station", type: "text", required: true, description: "where" },
      ],
    },
    {
      name: "orders",
      kind: "base",
      description: "an order",
      time: { type: "none" },
      fields: [
        { name: "item", type: "text", required: true, description: "what" },
        { name: "note", type: "text", description: "a note" },
      ],
    },
    {
      name: "dishes",
      kind: "base",
      description: "a dish",
      time: { type: "none" },
      fields: [
        { name: "dish", type: "text", required: true, description: "what" },
        {
          name: "meal",
          type: "ref",
          description: "its meal",
          ref: { table: "meals", target: "row" },
        },
      ],
    },
  ],
};

let s: ReusableStore;
let minute = 0;
let visibility: unknown = { kind: "all" };
const ctx = (actor = USER) =>
  createOpsContext({
    tenant: TENANT,
    actor,
    trigger: null,
    task: null,
    visibility: visibility as never,
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T03:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
// Each request a key of its own: two steps may send the same body, which the service would answer
// as a repeat with the first receipt (the same row), writing nothing.
let requests = 0;
const w = (params: Any): Promise<Any> =>
  write(s.store, ctx(), { idempotency_key: `t-${++requests}`, ...params });
const q = async (params: Record<string, unknown>): Promise<Any[]> =>
  ((await query(s.store, ctx(), { detail: "detailed", ...params })) as Any).rows;
const opOf = (ver: string) => Number(ver.slice(1).split(".")[0]);

/** A meal named `name`, its value resting on `evidence` (all of it). */
const meal = async (name: string, evidence?: Any[]) =>
  (
    await w({
      sv: 1,
      ...(evidence !== undefined ? { evidence } : {}),
      ops: [
        {
          intent: "insert",
          table: "meals",
          set: { name },
          ...(evidence !== undefined
            ? { evidence_by_field: { name: evidence.map((_, i) => i) } }
            : {}),
        },
      ],
    })
  ).ops[0];

beforeAll(async () => {
  s = await openReusable("saveslot-read-detail-", { buffered: true });
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  visibility = { kind: "all" };
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), { document: structuredClone(DOCUMENT) });
}, T);

describe("a field's literal result and level", () => {
  it.each([
    [
      "a user's words and an agent's both hit: hit, the user's level",
      [
        { kind: "user_message", text: "we had lunch at noon" },
        { kind: "agent_note", text: "lunch, it seems" },
      ],
      { literal: "hit", level: "user_stated" },
    ],
    [
      "the user's words miss, the agent's hit: hit, the agent's level",
      [
        { kind: "user_message", text: "at noon" },
        { kind: "agent_note", text: "so: lunch" },
      ],
      { literal: "hit", level: "agent_inferred" },
    ],
    [
      "every segment misses: miss, no level",
      [{ kind: "user_message", text: "at noon" }],
      {
        literal: "miss",
      },
    ],
    ["no evidence (the request itself): na, no level", undefined, { literal: "na" }],
  ])(
    "%s",
    async (_, evidence, want) => {
      await meal("lunch", evidence as Any[] | undefined);
      const [r] = await q({ table: "meals" });
      expect(r.detail.fields.name).toEqual({ field_id: expect.any(String), ...want });
    },
    T,
  );
});

describe("the last change", () => {
  it(
    "seq is the operation in ver; recorded_at, its record time; a later write moves both",
    async () => {
      const m = await meal("lunch");
      const [a] = await q({ table: "meals" });
      expect(a.detail.seq).toBe(opOf(a.ver));
      expect(a.detail.recorded_at).toMatch(/^2026-11-05T03:\d\d:00\.000Z$/);
      await w({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "meals",
            row: m.target.row,
            ver: m.ver,
            set: { name: "brunch" },
          },
        ],
      });
      const [b] = await q({ table: "meals" });
      expect(b.detail.seq).toBe(opOf(b.ver));
      expect(b.detail.seq).toBeGreaterThan(a.detail.seq);
      expect(b.detail.recorded_at > a.detail.recorded_at).toBe(true);
    },
    T,
  );
});

describe("a state entity, segment by segment", () => {
  it(
    "each stretch's literal result from the writes giving its values there",
    async () => {
      const c = (
        await w({
          sv: 1,
          evidence: [{ kind: "user_message", text: "ann is on the grill" }],
          ops: [
            {
              intent: "update",
              table: "chefs",
              entity_key: { chef: "ann" },
              set: { station: "grill" },
              valid_from: "2026-10-01",
              evidence_by_field: { station: [0], chef: [0] },
            },
          ],
        })
      ).ops[0];
      await w({
        sv: 1,
        evidence: [{ kind: "user_message", text: "she moves in November" }],
        ops: [
          {
            intent: "update",
            table: "chefs",
            entity: c.target.entity,
            ver: c.ver,
            set: { station: "pastry" },
            valid_from: "2026-11-01",
            evidence_by_field: { station: [0] },
          },
        ],
      });
      const rows = await q({ table: "chefs", valid_during: ["2026-10-01", null] });
      expect(
        rows.map((r) => [r.valid_from, r.values.station, r.detail.fields.station.literal]),
      ).toEqual([
        ["2026-10-01", "grill", "hit"],
        ["2026-11-01", "pastry", "miss"],
      ]);
      // One entity, one last change: the same seq on both.
      expect(new Set(rows.map((r) => r.detail.seq)).size).toBe(1);
    },
    T,
  );
});

describe("a ref field's summary", () => {
  it(
    "the meal named, as read; recorded as read; none once the meal is revoked",
    async () => {
      const m = await meal("lunch");
      await w({
        sv: 1,
        ops: [{ intent: "insert", table: "dishes", set: { dish: "soup", meal: m.target.row } }],
      });
      const [d] = await q({ table: "dishes" });
      expect(d.detail.fields.meal).toEqual({
        field_id: expect.any(String),
        literal: "na",
        ref: { values: { name: "lunch" } },
      });
      const entry = readBufferOf(s.store).entries().at(-1) as Any;
      expect(entry.rows.map((r: Any) => r.target).sort()).toEqual([d.row, m.target.row].sort());
      // Read, but no fallback: the summary is not the row, whose version the reader has not seen.
      expect(entry.lastRead.filter((x: Any) => x.kind === "ver").map((x: Any) => x.target)).toEqual(
        [d.row],
      );
      // Another connection that read the meal through the summary only: a write to it without
      // ver has nothing to fall back to.
      await query(s.store, ctx(OTHER), { table: "dishes", detail: "detailed" });
      const refused = await write(s.store, ctx(OTHER), {
        sv: 1,
        ops: [{ intent: "update", table: "meals", row: m.target.row, set: { name: "late lunch" } }],
      }).then(
        () => undefined,
        (e: Any) => e.code,
      );
      expect(refused).toBe("read_first");
      // The meal revoked (it is still referred to: confirmed): no summary, the mark instead.
      const rv = (await w({
        sv: 1,
        ops: [{ intent: "revoke", table: "meals", row: m.target.row, ver: m.ver }],
      })) as Any;
      const item = (rv.pending ?? []).find((p: Any) => p.type === "awaiting_confirmation");
      if (item !== undefined) {
        const it_ = (await pending(s.store, ctx(), { id: item.id })) as Any;
        await resolve(s.store, ctx(), { id: item.id, decision: "confirm", item_ver: it_.item_ver });
      }
      const [after] = await q({ table: "dishes" });
      expect(after.detail.fields.meal.ref).toBeUndefined();
      expect(after.marks.dangling_ref).toEqual([{ field: "meal", state: "revoked" }]);
    },
    T,
  );

  it(
    "a target table the caller cannot see: no summary, nothing of it read",
    async () => {
      const m = await meal("lunch");
      await w({
        sv: 1,
        ops: [{ intent: "insert", table: "dishes", set: { dish: "soup", meal: m.target.row } }],
      });
      const ids = await s.store.read(async (tx) => {
        const slot = (await tx.query<{ id: string }>("SELECT id FROM slots")).rows[0]?.id as string;
        const tables = (
          await tx.query<{ table_id: string; structure: string }>(
            "SELECT table_id, structure FROM catalog",
          )
        ).rows;
        const dishes = tables.find((x) => (JSON.parse(x.structure) as Any).name === "dishes");
        return { slot, dishes: dishes?.table_id as string };
      });
      visibility = { kind: "scoped", slots: [{ slot: ids.slot, tables: [{ table: ids.dishes }] }] };
      const [d] = await q({ table: "dishes" });
      expect(d.detail.fields.meal.ref).toBeUndefined();
      const entry = readBufferOf(s.store).entries().at(-1) as Any;
      expect(entry.rows.map((r: Any) => r.target)).toEqual([d.row]);
    },
    T,
  );
});

describe("premises", () => {
  it(
    "every declaration in effect: current, then changed once its target changes",
    async () => {
      const m = await meal("lunch");
      await w({
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "dishes",
            set: { dish: "soup", meal: m.target.row },
            premises: [{ table: "meals", row: m.target.row, ver: m.ver }],
          },
        ],
      });
      const [d] = await q({ table: "dishes" });
      expect(d.marks?.premise_changed).toBeUndefined();
      expect(d.detail.premises).toEqual([
        {
          premise: { table: "food.meals", row: m.target.row },
          seen: m.ver,
          state: "current",
          fields: ["dish", "meal"],
          declared: { seq: expect.any(Number), actor: expect.any(Object) },
        },
      ]);
      const up = (await w({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "meals",
            row: m.target.row,
            ver: m.ver,
            set: { name: "brunch" },
          },
        ],
      })) as Any;
      const [after] = await q({ table: "dishes" });
      expect(after.detail.premises).toEqual([
        {
          premise: { table: "food.meals", row: m.target.row },
          seen: m.ver,
          state: "changed",
          reason: expect.any(String),
          since: up.seq,
          fields: ["dish", "meal"],
          declared: { seq: expect.any(Number), actor: expect.any(Object) },
        },
      ]);
      // The same declaration in the marks, without its state.
      expect(after.marks.premise_changed).toHaveLength(1);
      expect(after.marks.premise_changed[0].state).toBeUndefined();
    },
    T,
  );
});

describe("premises: hidden, and in order", () => {
  it(
    "a declaration on a table the caller cannot see: only what is of this row",
    async () => {
      const m = await meal("lunch");
      await w({
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "dishes",
            set: { dish: "soup", meal: m.target.row },
            premises: [{ table: "meals", row: m.target.row, ver: m.ver }],
          },
        ],
      });
      const ids = await s.store.read(async (tx) => {
        const slot = (await tx.query<{ id: string }>("SELECT id FROM slots")).rows[0]?.id as string;
        const tables = (
          await tx.query<{ table_id: string; structure: string }>(
            "SELECT table_id, structure FROM catalog",
          )
        ).rows;
        const dishes = tables.find((x) => (JSON.parse(x.structure) as Any).name === "dishes");
        return { slot, dishes: dishes?.table_id as string };
      });
      visibility = { kind: "scoped", slots: [{ slot: ids.slot, tables: [{ table: ids.dishes }] }] };
      const [d] = await q({ table: "dishes" });
      expect(d.detail.premises).toEqual([
        { hidden: true, state: "current", fields: ["dish", "meal"] },
      ]);
    },
    T,
  );

  it(
    "changed before current, whatever order they were declared in",
    async () => {
      const a = await meal("lunch");
      const b = await meal("dinner");
      await w({
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "dishes",
            set: { dish: "soup", meal: a.target.row },
            premises: [
              { table: "meals", row: a.target.row, ver: a.ver },
              { table: "meals", row: b.target.row, ver: b.ver },
            ],
          },
        ],
      });
      // The first declared, on a, stays current; the second, on b, changes.
      await w({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "meals",
            row: b.target.row,
            ver: b.ver,
            set: { name: "supper" },
          },
        ],
      });
      const [d] = await q({ table: "dishes" });
      expect(d.detail.premises.map((p: Any) => [p.premise.row, p.state])).toEqual([
        [b.target.row, "changed"],
        [a.target.row, "current"],
      ]);
    },
    T,
  );
});

describe("fields", () => {
  it(
    "with fields given, only those fields; without, every field",
    async () => {
      const m = await meal("lunch");
      await w({
        sv: 1,
        ops: [{ intent: "insert", table: "dishes", set: { dish: "soup", meal: m.target.row } }],
      });
      expect(Object.keys((await q({ table: "dishes" }))[0].detail.fields)).toEqual([
        "dish",
        "meal",
      ]);
      expect(
        Object.keys((await q({ table: "dishes", fields: ["dish"] }))[0].detail.fields),
      ).toEqual(["dish"]);
    },
    T,
  );
});

describe("which items a field's result is over", () => {
  it(
    "a corroboration of the value counts; a literal block a deletion cleared or holds pending does not",
    async () => {
      // The value's own write misses; a corroboration (the same value, its own evidence) hits.
      const m = await meal("lunch", [{ kind: "user_message", text: "at noon" }]);
      expect((await q({ table: "meals" }))[0].detail.fields.name.literal).toBe("miss");
      await w({
        sv: 1,
        evidence: [{ kind: "agent_note", text: "it was lunch" }],
        ops: [
          {
            intent: "update",
            table: "meals",
            row: m.target.row,
            ver: m.ver,
            set: { name: "lunch" },
            evidence_by_field: { name: [0] },
          },
        ],
      });
      const [r] = await q({ table: "meals" });
      expect(r.detail.fields.name).toMatchObject({ literal: "hit", level: "agent_inferred" });
      // The corroboration's literal block: the latest one written.
      const block = await s.store.read(
        async (tx) =>
          (
            await tx.query<{ seq: unknown; path: string; body: string; checksum: string }>(
              `SELECT seq, path, body, checksum FROM content WHERE path LIKE 'literal/%'
               ORDER BY seq DESC LIMIT 1`,
            )
          ).rows[0] as { seq: unknown; path: string; body: string; checksum: string },
      );
      const set = (sql: string, extra: string[] = []) =>
        s.store.write(async (tx) => {
          await tx.query(sql, [Number(block.seq), block.path, ...extra]);
        });
      // Cleared by a deletion: the block's body gone with it (as a tombstone leaves it).
      await set(
        "UPDATE content SET removed_by = 999999, body = NULL, checksum = NULL WHERE seq = $1 AND path = $2",
      );
      expect((await q({ table: "meals" }))[0].detail.fields.name).toEqual({
        field_id: expect.any(String),
        literal: "miss",
      });
      // Back, then held by a deletion still pending.
      await set(
        "UPDATE content SET removed_by = NULL, body = $3, checksum = $4 WHERE seq = $1 AND path = $2",
        [block.body, block.checksum],
      );
      expect((await q({ table: "meals" }))[0].detail.fields.name.literal).toBe("hit");
      await set("INSERT INTO pending_blocks (seq, path, deletion_seq) VALUES ($1, $2, 999999)");
      expect((await q({ table: "meals" }))[0].detail.fields.name.literal).toBe("miss");
    },
    T,
  );

  it(
    "a candidate taken: its value is carried, its result is the candidate write's",
    async () => {
      const m = await meal("lunch");
      // One change on the version read; another on the same, now stale: a candidate.
      await w({
        sv: 1,
        evidence: [{ kind: "user_message", text: "make it dinner" }],
        ops: [
          {
            intent: "update",
            table: "meals",
            row: m.target.row,
            ver: m.ver,
            set: { name: "dinner" },
            evidence_by_field: { name: [0] },
          },
        ],
      });
      const stale = (await w({
        sv: 1,
        evidence: [{ kind: "agent_note", text: "supper, I gather" }],
        ops: [
          {
            intent: "update",
            table: "meals",
            row: m.target.row,
            ver: m.ver,
            set: { name: "supper" },
            evidence_by_field: { name: [0] },
          },
        ],
      })) as Any;
      const item = (stale.pending ?? [])[0];
      expect(item).toBeDefined();
      const d = (await pending(s.store, ctx(), { id: item.id })) as Any;
      await resolve(s.store, ctx(), {
        id: item.id,
        decision: "take_candidate",
        item_ver: d.item_ver,
        candidate: d.candidates.length - 1,
      });
      const [r] = await q({ table: "meals" });
      expect(r.values.name).toBe("supper");
      expect(r.detail.fields.name).toMatchObject({ literal: "hit", level: "agent_inferred" });
    },
    T,
  );
});

describe("pages", () => {
  it(
    "a later page's rows come with their detail, read as of the first page",
    async () => {
      const a = await meal("lunch", [{ kind: "user_message", text: "lunch" }]);
      const b = await meal("dinner", [{ kind: "user_message", text: "at night" }]);
      const first = (await query(s.store, ctx(), {
        table: "meals",
        detail: "detailed",
        limit: 1,
      })) as Any;
      expect(first.rows).toHaveLength(1);
      // A change after the first page: the second page is read as of the first.
      await w({
        sv: 1,
        evidence: [{ kind: "user_message", text: "dinner it is" }],
        ops: [
          {
            intent: "update",
            table: "meals",
            row: b.target.row,
            ver: b.ver,
            set: { name: "dinner" },
            evidence_by_field: { name: [0] },
          },
        ],
      });
      const second = (await query(s.store, ctx(), {
        table: "meals",
        detail: "detailed",
        limit: 1,
        position: first.next_position,
      })) as Any;
      const byRow = new Map(
        [...first.rows, ...second.rows].map((r: Any) => [r.row, r.detail.fields.name.literal]),
      );
      expect(byRow.get(a.target.row)).toBe("hit");
      expect(byRow.get(b.target.row)).toBe("miss");
    },
    T,
  );
});

describe("corroborations: as of a position, undone, and a value back again", () => {
  /** An order for `item`, its value resting on a user's words that do not name it (a miss). */
  const order = async (item: string) =>
    (
      await w({
        sv: 1,
        evidence: [{ kind: "user_message", text: "at noon" }],
        ops: [
          { intent: "insert", table: "orders", set: { item }, evidence_by_field: { item: [0] } },
        ],
      })
    ).ops[0];
  /** The same item again with an agent's note naming it (a corroboration that hits), and a note. */
  const corroborate = async (o: Any, note: string) =>
    (await w({
      sv: 1,
      evidence: [{ kind: "agent_note", text: `it was ${o.item}` }],
      ops: [
        {
          intent: "update",
          table: "orders",
          row: o.row,
          ver: o.ver,
          set: { item: o.item, note },
          evidence_by_field: { item: [0] },
        },
      ],
    })) as Any;
  const current = async () => (await q({ table: "orders" })) as Any[];
  const undo = async (row: string, seq: number) => {
    const r = (await current()).find((x) => x.row === row);
    await w({
      sv: 1,
      ops: [{ intent: "update", table: "orders", row, ver: r.ver, revert: { undo: seq } }],
    });
  };

  it(
    "as of a record point: a corroboration undone later still counts there",
    async () => {
      const o = await order("lunch");
      const c = await corroborate({ row: o.target.row, ver: o.ver, item: "lunch" }, "x");
      const asOf = async () =>
        (
          (await history(s.store, ctx(), {
            table: "orders",
            row: o.target.row,
            mode: "as_of",
            as_of: c.seq,
            detail: "detailed",
          })) as Any
        ).rows[0].detail.fields.item.literal;
      expect(await asOf()).toBe("hit");
      await undo(o.target.row, c.seq);
      expect((await current())[0].detail.fields.item.literal).toBe("miss");
      expect(await asOf()).toBe("hit");
    },
    T,
  );

  it(
    "a later page: as of the first, a corroboration undone after it still counts",
    async () => {
      const a = await order("lunch");
      const b = await order("lunch");
      const ca = await corroborate({ row: a.target.row, ver: a.ver, item: "lunch" }, "x");
      const cb = await corroborate({ row: b.target.row, ver: b.ver, item: "lunch" }, "y");
      const first = (await query(s.store, ctx(), {
        table: "orders",
        detail: "detailed",
        limit: 1,
      })) as Any;
      expect(first.rows[0].detail.fields.item.literal).toBe("hit");
      await undo(a.target.row, ca.seq);
      await undo(b.target.row, cb.seq);
      const second = (await query(s.store, ctx(), {
        table: "orders",
        detail: "detailed",
        limit: 1,
        position: first.next_position,
      })) as Any;
      expect(second.rows[0].detail.fields.item.literal).toBe("hit");
      // Now, both undone: misses.
      expect((await current()).map((r) => r.detail.fields.item.literal)).toEqual(["miss", "miss"]);
    },
    T,
  );

  it(
    "a value changed away and back: the corroboration of it before still counts",
    async () => {
      const o = await order("lunch");
      const c = await corroborate({ row: o.target.row, ver: o.ver, item: "lunch" }, "x");
      const away = (await w({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "orders",
            row: o.target.row,
            ver: c.ops[0].ver,
            set: { item: "dinner" },
          },
        ],
      })) as Any;
      expect((await current())[0].detail.fields.item.literal).toBe("na");
      await w({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "orders",
            row: o.target.row,
            ver: away.ops[0].ver,
            set: { item: "lunch" },
          },
        ],
      });
      expect((await current())[0].detail.fields.item).toMatchObject({
        literal: "hit",
        level: "agent_inferred",
      });
    },
    T,
  );

  it(
    "a corroboration undone does not count",
    async () => {
      const o = await order("lunch");
      const c = await corroborate({ row: o.target.row, ver: o.ver, item: "lunch" }, "x");
      expect((await current())[0].detail.fields.item.literal).toBe("hit");
      await undo(o.target.row, c.seq);
      expect((await current())[0].detail.fields.item).toEqual({
        field_id: expect.any(String),
        literal: "miss",
      });
    },
    T,
  );
});
