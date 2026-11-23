// Duplicate keys against a brute-force model (03-data-model/04-write-and-read.md «疑似重复»): random
// requests of inserts, updates and revokes on a timeless table with two key groups over a tiny
// domain of values. The model keeps every row's values, whether it is revoked and its last
// operation in effect; for each row a request creates, it works out the match by trying every row
// (the earlier ops of the same request included) and is compared with the `duplicate` block and
// the flagged item in the log. The cases that must be there have fixed cases in
// write-duplicates.test.ts; the floor below only guards the generator. Fictional names.

import {
  createOpsContext,
  createTenant,
  reconcileLog,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { propRuns } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 600_000;
const RUNS = propRuns(12);
/** A run again by its seed (and path), as fast-check reports a counterexample. */
const SEED = process.env["PROP_SEED"] === undefined ? undefined : Number(process.env["PROP_SEED"]);
const TENANT = `tn_${"5".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const FIELDS = ["a", "b", "c"] as const;
type Field = (typeof FIELDS)[number];
const IDS: Record<Field, string> = { a: "f1", b: "f2", c: "f3" };
/** The schema's order: (a, b), then (c). */
const GROUPS: readonly (readonly Field[])[] = [["a", "b"], ["c"]];
const VALUES = ["x", "y", null] as const;

type Values = Partial<Record<Field, string | null>>;
type Op =
  | { t: "insert"; set: Values }
  | { t: "update"; pick: number; set: Values }
  | { t: "revoke"; pick: number };

const values: fc.Arbitrary<Values> = fc.record(
  { a: fc.constantFrom(...VALUES), b: fc.constantFrom(...VALUES), c: fc.constantFrom(...VALUES) },
  { requiredKeys: [] },
);
const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ t: fc.constant("insert" as const), set: values }) },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant("update" as const), pick: fc.nat(20), set: values }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("revoke" as const), pick: fc.nat(20) }) },
);
/** Requests of one to three ops. */
const scenario = fc.array(fc.array(op, { minLength: 1, maxLength: 3 }), {
  minLength: 2,
  maxLength: 8,
});

interface ModelRow {
  readonly id: string;
  values: Values;
  revoked: boolean;
  last: number;
}

/** The match the model gives for a new row: the first group, its rows latest first, at most 10. */
function expected(rows: readonly ModelRow[], self: ModelRow) {
  for (const g of GROUPS) {
    const mine = g.map((f) => self.values[f]);
    if (mine.some((v) => v === undefined || v === null)) continue;
    const hits = rows.filter(
      (r) => r !== self && !r.revoked && g.every((f, i) => r.values[f] === mine[i]),
    );
    if (hits.length === 0) continue;
    const sorted = [...hits].sort((p, q) => q.last - p.last || (p.id < q.id ? -1 : 1));
    return { keys: g.map((f) => IDS[f]), matched: sorted.slice(0, 10).map((r) => r.id) };
  }
  return undefined;
}

let s: ReusableStore;
let scratch: ReusableStore;
let minute = 0;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: "w",
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T${String(6 + Math.floor(++minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
const rows = async (q: string, params: unknown[] = []) =>
  (await s.store.read((tx) => tx.query(q, params as never))).rows as Record<string, unknown>[];

beforeAll(async () => {
  s = await openReusable("saveslot-write-duplicates-prop-");
  scratch = await openReusable("saveslot-write-duplicates-prop-scratch-");
}, T);
afterAll(async () => {
  await s?.close();
  await scratch?.close();
}, T);

it(
  "each row created is flagged exactly as the brute-force model matches it; the log replays the same",
  async () => {
    // Hit: a row created matched something. At least half the runs (the floor guards the
    // generator only; fixed cases cover what must be there).
    let runs = 0;
    let hit = 0;
    await fc.assert(
      fc.asyncProperty(scenario, async (requests: Op[][]) => {
        runs++;
        await s.reset();
        await scratch.reset();
        minute = 0;
        await createTenant(s.store, ctx());
        await schemaDraft(s.store, ctx(), {
          document: {
            slot: "s",
            base_version: null,
            timezone: "UTC",
            tables: [
              {
                name: "things",
                kind: "base",
                description: "things",
                time: { type: "none" },
                fields: FIELDS.map((f) => ({ name: f, type: "text", description: f })),
                duplicate_keys: GROUPS.map((g) => [...g]),
              },
            ],
          },
        });
        const model: ModelRow[] = [];
        /** The open flagged items, by flagged row: the key group flagged on and the rows listed. */
        const items = new Map<string, { group: readonly Field[]; listed: string[] }>();
        let any = false;
        for (const req of requests) {
          // A row an earlier op of the request revokes is not written again in it.
          const gone = new Set<string>();
          const live = () => model.filter((r) => !r.revoked && !gone.has(r.id));
          // The request as sent, and what the model does with each op.
          const ops: unknown[] = [];
          const plan: ((row: string, opNo: number) => void)[] = [];
          for (const o of req) {
            const set = Object.fromEntries(Object.entries(o.t === "revoke" ? {} : o.set));
            if (o.t === "insert") {
              if (Object.values(set).every((v) => v === null || v === undefined)) continue;
              ops.push({ intent: "insert", table: "things", set });
              plan.push((row, n) =>
                model.push({
                  id: row,
                  values: { ...o.set },
                  revoked: false,
                  last: n,
                }),
              );
              continue;
            }
            const target = live()[o.pick % Math.max(1, live().length)];
            if (target === undefined) continue;
            if (o.t === "revoke") {
              ops.push({ intent: "revoke", table: "things", row: target.id });
              gone.add(target.id);
              plan.push((_, n) => {
                target.revoked = true;
                target.last = n;
              });
            } else {
              if (Object.keys(set).length === 0) continue;
              // A change of some field: a new value somewhere moves the row's last operation.
              ops.push({ intent: "update", table: "things", row: target.id, set });
              plan.push((_, n) => {
                const changed = Object.entries(o.set).some(
                  ([f, v]) => (target.values[f as Field] ?? null) !== (v ?? null),
                );
                target.values = { ...target.values, ...o.set };
                if (changed) target.last = n;
              });
            }
          }
          if (ops.length === 0) continue;
          const r = (await write(s.store, ctx(), { sv: 1, ops })) as unknown as {
            seq: number;
            ops: { target: { row: string } }[];
            replayed?: true;
          };
          // The same request again within its window: the first one's receipt, nothing written
          // (04-contract §14). The model does nothing either.
          if (r.replayed === true) continue;
          // Op by op, as the pipeline judges them: the model before each insert.
          const created: { row: string; want: ReturnType<typeof expected> }[] = [];
          plan.forEach((apply, i) => {
            const row = r.ops[i]?.target.row as string;
            const wasThere = model.some((m) => m.id === row);
            apply(row, r.seq);
            if (!wasThere) {
              const self = model.find((m) => m.id === row) as ModelRow;
              created.push({ row, want: expected(model, self) });
            }
          });
          const logged = await rows(
            `SELECT e.target_row, c.body FROM events e JOIN content c ON c.seq = e.seq AND c.path = 'duplicate'
               WHERE e.type = 'write.base' AND e.op = $1`,
            [r.seq],
          );
          const got = new Map(
            logged.map((x) => [x["target_row"] as string, JSON.parse(x["body"] as string)]),
          );
          for (const c of created) {
            const g = got.get(c.row);
            expect({
              row: c.row,
              got: g === undefined ? undefined : { keys: g.keys, matched: g.matched },
            }).toEqual({
              row: c.row,
              got: c.want,
            });
            if (c.want !== undefined) {
              any = true;
              const g = GROUPS.find((x) => x.map((f) => IDS[f]).join() === c.want?.keys.join());
              items.set(c.row, { group: g as readonly Field[], listed: [...c.want.matched] });
            }
          }
          // The request's end: every open flagged item judged again (superseded or refreshed),
          // the ones it opened too; then the store's open items and their rows are the model's.
          for (const [row, it] of [...items]) {
            const self = model.find((m) => m.id === row) as ModelRow;
            const still = self.revoked
              ? []
              : it.listed.filter((id) => {
                  const other = model.find((m) => m.id === id) as ModelRow;
                  // Still matching on any group, as matching is (04-write-and-read «怎么算命中»).
                  return (
                    !other.revoked &&
                    GROUPS.some((g) =>
                      g.every((f) => {
                        const v = self.values[f];
                        return v !== undefined && v !== null && other.values[f] === v;
                      }),
                    )
                  );
                });
            if (still.length === 0) items.delete(row);
            else it.listed = still;
          }
          const open = await rows(
            `SELECT p.target_row, c.path, c.body FROM pending_items p
             JOIN pending_entries e ON e.item_id = p.id
             JOIN content c ON c.seq = e.content_seq AND c.path = e.content_path
             WHERE p.type = 'flagged' AND p.state = 'open' AND e.content_path LIKE 'matched/%'
             ORDER BY p.target_row, e.content_path`,
          );
          const stored = new Map<string, string[]>();
          for (const x of open) {
            const list = stored.get(x["target_row"] as string) ?? [];
            list.push(JSON.parse(x["body"] as string).row);
            stored.set(x["target_row"] as string, list);
          }
          expect(Object.fromEntries([...stored].sort())).toEqual(
            Object.fromEntries([...items].map(([row, it]) => [row, it.listed]).sort()),
          );
          const flagged = await rows(
            `SELECT count(*)::int AS n FROM events WHERE type = 'item.created' AND op = $1`,
            [r.seq],
          );
          // A row flagged when written but left with nothing by the request's end opens no item.
          expect(flagged[0]?.["n"]).toBe(created.filter((c) => items.has(c.row)).length);
        }
        if (any) hit++;
        const replayed = await reconcileLog({ live: s.store, scratch: scratch.store });
        expect(replayed.mismatches_total).toBe(0);
      }),
      {
        numRuns: RUNS,
        ...(SEED !== undefined ? { seed: SEED } : {}),
        ...(process.env["PROP_PATH"] ? { path: process.env["PROP_PATH"], endOnFailure: true } : {}),
      },
    );
    expect({ runs, enough: hit >= runs / 2 }).toEqual({ runs, enough: true });
  },
  T,
);
