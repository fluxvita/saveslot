// A flagged item (03-data-model/01-objects.md «待处理事项», «各处理方式的执行语义»; 04-contract-types
// §4.8 `FlaggedDetail`): its detail, and its two decisions. `keep`: the data as it is, the flag
// taken off. `revoke`: the flagged row revoked, a revoke as any other. Each case ends with the log
// replayed into an empty storage. Fictional names.

import {
  createOpsContext,
  createTenant,
  pending,
  query,
  readTail,
  reconcileLog,
  resolve,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"4".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

const MEALS = {
  name: "meals",
  kind: "base",
  description: "one row per meal",
  time: { type: "event", field: "day" },
  fields: [
    { name: "day", type: "date", required: true, description: "the day" },
    { name: "energy", type: "quantity", unit: "kcal", description: "energy" },
    { name: "note", type: "text", description: "what it was" },
  ],
  duplicate_keys: [["day", "energy"]],
};

let s: ReusableStore;
let scratch: ReusableStore;
let minute = 0;
const ctx = (task: string | null = "w") =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T07:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type Any = any;
async function answer(f: () => Promise<unknown>): Promise<Any> {
  try {
    return await f();
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { code: x.code, ...(x.detail ?? {}) };
  }
}
const rows = async (q: string, params: unknown[] = []) =>
  (await s.store.read((tx) => tx.query(q, params as never))).rows as Record<string, unknown>[];
const tail = async () => s.store.read(async (tx) => (await readTail(tx))?.seq ?? 0);
const w = (ops: unknown[]): Promise<Any> => write(s.store, ctx(), { sv: 1, ops });
const meal = (set: Record<string, unknown>) => ({ intent: "insert", table: "meals", set });
const decide = (item: Any, decision: string): Promise<Any> =>
  answer(() => resolve(s.store, ctx(), { id: item.id, decision, item_ver: item.item_ver }));
const replaysTheSame = async () => {
  const r = await reconcileLog({ live: s.store, scratch: scratch.store });
  expect(r.mismatches).toEqual([]);
  expect(r.mismatches_total).toBe(0);
};
/** Two meals alike: the second is flagged with the first. */
async function flaggedPair() {
  const a = (await w([meal({ day: "2026-11-01", energy: { value: 600, unit: "kcal" } })])).ops[0]
    .target.row as string;
  const r = await w([
    meal({ day: "2026-11-01", energy: { value: 600, unit: "kcal" }, note: "salad" }),
  ]);
  return { a, b: r.ops[0].target.row as string, item: r.pending[0] as Any };
}

beforeAll(async () => {
  s = await openReusable("saveslot-resolve-flagged-");
  scratch = await openReusable("saveslot-resolve-flagged-scratch-");
}, T);
afterAll(async () => {
  await s?.close();
  await scratch?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  await scratch.reset();
  minute = 0;
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx("schema"), {
    document: { slot: "food", base_version: null, timezone: "Asia/Shanghai", tables: [MEALS] },
  });
}, T);

describe("the detail of a flagged item", () => {
  it(
    "its row, the rows it matched, the key group by name and the row's values on it, its decisions",
    async () => {
      const { a, b, item } = await flaggedPair();
      const d = (await pending(s.store, ctx(), { id: item.id })) as Any;
      expect(d).toMatchObject({
        id: item.id,
        type: "flagged",
        status: "open",
        reason: "duplicate_keys",
        target: { table: "food.meals", row: b },
        related: [{ table: "food.meals", row: a }],
        keys: ["day", "energy"],
        decisions: ["keep", "revoke"],
      });
      expect(d.matched_values).toMatchObject({ day: "2026-11-01" });
      expect(d.item_ver).toBe(item.item_ver);
    },
    T,
  );
});

describe("keep", () => {
  it(
    "writes nothing, takes the flag off, closes the item; the row can be written again",
    async () => {
      const { b, item } = await flaggedPair();
      const before = await tail();
      const r = await decide(item, "keep");
      expect(r).toMatchObject({ status: "resolved" });
      const types = await rows("SELECT type FROM events WHERE seq > $1 ORDER BY seq", [before]);
      expect(types.map((x) => x["type"])).not.toContain("write.base");
      const read = await query(s.store, ctx(), { table: "meals" });
      const row = read.rows.find((x: Any) => x.row === b) as Any;
      expect(row.marks?.flagged).toBeUndefined();
      expect(row.values.note).toBe("salad");
      // Closed: the row takes writes again.
      expect(
        await w([{ intent: "update", table: "meals", row: b, set: { note: "a salad" } }]),
      ).toMatchObject({ status: "saved" });
      // The same decision again is the same result; another is refused.
      expect(await decide(item, "keep")).toMatchObject({ status: "resolved" });
      expect(await decide(item, "revoke")).toMatchObject({ code: "item_closed" });
      await replaysTheSame();
    },
    T,
  );
});

describe("revoke", () => {
  it(
    "revokes the flagged row, closes the item; the row it matched is untouched",
    async () => {
      const { a, b, item } = await flaggedPair();
      const before = await tail();
      expect(await decide(item, "revoke")).toMatchObject({ status: "resolved" });
      const base = await rows(
        `SELECT e.target_row, c.body FROM events e JOIN content c ON c.seq = e.seq AND c.path = 'target'
         WHERE e.type = 'write.base' AND e.seq > $1`,
        [before],
      );
      expect(base).toHaveLength(1);
      expect(JSON.parse(base[0]?.["body"] as string)).toMatchObject({
        row: b,
        intent: "revoke",
        cause: "resolve",
        item: item.id,
      });
      const read = await query(s.store, ctx(), { table: "meals" });
      expect(read.rows.map((x: Any) => x.row)).toEqual([a]);
      // The row as the log has it, read back for the next write: revoked.
      expect(
        await answer(() => w([{ intent: "update", table: "meals", row: b, set: { note: "x" } }])),
      ).toMatchObject({ code: "revoked" });
      expect(await decide(item, "revoke")).toMatchObject({ status: "resolved" });
      expect(await decide(item, "keep")).toMatchObject({ code: "item_closed" });
      await replaysTheSame();
    },
    T,
  );

  it(
    "a decision not a flagged item's is refused, with those it takes",
    async () => {
      const { item } = await flaggedPair();
      expect(await decide(item, "keep_effective")).toMatchObject({
        code: "invalid_argument",
        param: "decision",
        allowed_values: ["keep", "revoke"],
      });
    },
    T,
  );
});
