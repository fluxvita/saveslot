// Writing by `entity_key` against a model of keys and entities (03-data-model/05-time «按 entity_key
// 写入»; 04-contract §5.1), on three tables: a text key, a key of two fields (text and decimal, two
// keys sharing the first), and a key that is not text (a zoned date-time and a quantity; one instant
// in two zones is two keys). Keys are written in ways that are the same value (NFC forms, decimals
// by scale, a zoned date-time with its milliseconds or its zone in another case).
//
// Random requests: by key, by entity, revoking by entity, two ops by key in one request. Every
// sample also has, at places of its own, a revoke by key, a request creating a key and revoking it,
// and a second connection writing by key without `ver`. After each request: each op went to the
// model's entity for its key, or created one where it holds none (a revoke by a key none holds is
// not_found; a second connection that never read an existing key gets read_first); a key field given
// unlike the entity's key was refused; each key has one entity at most; a creation's existing_keys
// are the request's earlier new keys, then the model's keys, the latest changed first, as text that
// writes back. Every fourth sample, the log replayed into an empty storage gives the same tables.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  readBufferOf,
  readEvents,
  readTail,
} from "@fluxvita/saveslot-kernel";
import { COMPILED_V1, createSlotEvents, writeInTx } from "@fluxvita/saveslot-kernel/testing";
import { propRuns } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore, snapshot } from "./testing/reusable-store.fixture.ts";

const RUNS = propRuns(15);
const SEED = process.env["PROP_SEED"] === undefined ? undefined : Number(process.env["PROP_SEED"]);
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const OTHER = `ci_${"2".repeat(26)}`;
const money = (id: string, name: string) => ({
  id,
  name,
  type: "decimal",
  required: true,
  description: name,
  precision: { scale: 2, rounding: "half_up" },
});
const state = { type: "state", granularity: "date" };
const COMPILED = {
  ...COMPILED_V1,
  tables: [
    {
      id: "t2",
      name: "budgets",
      kind: "base",
      description: "budgets",
      time: state,
      physical: { table: "t_t2_v1" },
      fields: [
        { id: "f1", name: "category", type: "text", required: true, description: "category" },
        money("f2", "amount"),
      ],
      entity_key: ["f1"],
    },
    {
      id: "t4",
      name: "limits",
      kind: "base",
      description: "limits by region and level",
      time: state,
      physical: { table: "t_t4_v1" },
      fields: [
        { id: "f1", name: "region", type: "text", required: true, description: "region" },
        money("f5", "level"),
        money("f2", "amount"),
      ],
      entity_key: ["f1", "f5"],
    },
    {
      id: "t5",
      name: "bookings",
      kind: "base",
      description: "bookings by when and deposit",
      time: state,
      physical: { table: "t_t5_v1" },
      fields: [
        { id: "f6", name: "at", type: "zoned_datetime", required: true, description: "when" },
        {
          id: "f7",
          name: "deposit",
          type: "quantity",
          required: true,
          description: "deposit",
          unit: { code: "CNY", dimension: "currency:CNY" },
          precision: { scale: 2, rounding: "half_up" },
        },
        money("f2", "amount"),
      ],
      entity_key: ["f6", "f7"],
    },
  ],
};
const CHANGES = [
  { target: { slot: true }, change: "create_slot" },
  { target: { table: "t2" }, change: "add_table" },
  { target: { table: "t4" }, change: "add_table" },
  { target: { table: "t5" }, change: "add_table" },
].map((c) => ({
  ...c,
  class: "create",
  compatible_with_old_writes: true,
  destructive: false,
  auto: true,
}));

/** A keyed table as the model sees it: its keys, how each is written, how it is shown. */
interface Keyed {
  readonly table: string;
  readonly id: string;
  readonly keys: number;
  /** Key `k` written its `way`-th way (the same value each way). */
  key(k: number, way: number): Record<string, unknown>;
  /** Key `k` as existing_keys shows it. */
  shown(k: number): unknown;
}

const pick = <T>(xs: readonly T[], i: number) => xs[i % xs.length] as T;

const TABLES: readonly Keyed[] = [
  {
    table: "budgets",
    id: "t2",
    keys: 4,
    // café composed and decomposed are one key; Café and cafe are keys of their own.
    key: (k, way) => ({
      category: pick(pick([["café", "café"], ["Café"], ["cafe"], ["tea"]], k), way),
    }),
    shown: (k) => pick(["café", "Café", "cafe", "tea"], k),
  },
  {
    table: "limits",
    id: "t4",
    keys: 4,
    // Two keys share each region; levels written 1, "1.0", "1.00".
    key: (k, way) => ({
      region: pick(["north", "north", "south", "south"], k),
      level: pick(
        [
          [1, "1.0", "1.00"],
          [2, "2.0", "2.00"],
        ],
        k,
      )[way % 3],
    }),
    shown: (k) => ({
      region: pick(["north", "north", "south", "south"], k),
      level: pick(["1", "2"], k),
    }),
  },
  {
    table: "bookings",
    id: "t5",
    keys: 4,
    // One instant in Shanghai and in Tokyo: two keys. Written with milliseconds, or the zone's
    // name in another case; deposits 5 and 5.0.
    key: (k, way) => ({
      at: pick(
        pick(
          [
            [
              "2026-11-05T10:00:00+08:00[Asia/Shanghai]",
              "2026-11-05T10:00:00.000+08:00[asia/shanghai]",
            ],
            ["2026-11-05T11:00:00+09:00[Asia/Tokyo]", "2026-11-05T11:00:00.000+09:00[asia/tokyo]"],
          ],
          k % 2,
        ),
        way,
      ),
      deposit: {
        value: pick([pick(["5", "5.0"], way), pick(["6", "6.0"], way)], Math.floor(k / 2)),
        unit: "CNY",
      },
    }),
    shown: (k) => ({
      at: pick(
        ["2026-11-05T10:00:00+08:00[Asia/Shanghai]", "2026-11-05T11:00:00+09:00[Asia/Tokyo]"],
        k % 2,
      ),
      deposit: pick(["5 CNY", "6 CNY"], Math.floor(k / 2)),
    }),
  },
];

type Step =
  | { kind: "key"; key: number; way: number; amount: number; setKey: "none" | "same" | "other" }
  | { kind: "entity"; which: number; way: number; amount: number; setKey: "same" | "other" }
  | { kind: "revoke"; which: number }
  | { kind: "pair"; a: number; b: number; way: number }
  | { kind: "revokeKey"; key: number; way: number }
  | { kind: "createRevoke"; key: number; way: number }
  | { kind: "other"; key: number; way: number };

const random: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("key" as const),
      key: fc.nat(3),
      way: fc.nat(2),
      amount: fc.nat(2),
      setKey: fc.constantFrom("none" as const, "none" as const, "same" as const, "other" as const),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("entity" as const),
      which: fc.nat(5),
      way: fc.nat(2),
      amount: fc.nat(2),
      setKey: fc.constantFrom("same" as const, "same" as const, "other" as const),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("revoke" as const), which: fc.nat(5) }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("pair" as const),
      a: fc.nat(3),
      b: fc.nat(3),
      way: fc.nat(2),
    }),
  },
);

/** The kinds every sample has, at places of its own. */
const forced = fc.tuple(
  fc.record({ kind: fc.constant("revokeKey" as const), key: fc.nat(3), way: fc.nat(2) }),
  fc.record({ kind: fc.constant("createRevoke" as const), key: fc.nat(3), way: fc.nat(2) }),
  fc.record({ kind: fc.constant("other" as const), key: fc.nat(3), way: fc.nat(2) }),
);

const steps: fc.Arbitrary<Step[]> = fc
  .tuple(
    fc.array(random, { minLength: 1, maxLength: 12 }),
    forced,
    fc.tuple(fc.nat(), fc.nat(), fc.nat()),
  )
  .map(([xs, musts, at]) => {
    const out: Step[] = [...xs];
    musts.forEach((m, i) => {
      out.splice((at[i] as number) % (out.length + 1), 0, m);
    });
    return out;
  });

/** The model: per key (by its index), the entity holding it, its latest `ver` and whether revoked. */
interface Held {
  entity: string;
  ver: string;
  revoked: boolean;
}

type OpReceipt = {
  target: { entity?: string };
  ver?: string;
  created_entity?: true;
  existing_keys?: unknown[];
};
type Result = { ops?: OpReceipt[]; refused?: string; reason?: string; param?: string };

const opOf = (ver: string) => Number(ver.slice(1).split(".")[0]);

// One store for the samples and one to replay into, for the whole file: the tables' groups run one
// after another, and each sample empties what it uses before using it (opening PGlite builds a
// database, seconds; emptying one takes milliseconds).
let main: ReusableStore;
let replica: ReusableStore;
beforeAll(async () => {
  main = await openReusable("saveslot-entity-key-");
  replica = await openReusable("saveslot-entity-key-replica-");
}, 120_000);
afterAll(async () => {
  await main?.close();
  await replica?.close();
}, 120_000);

describe.each(TABLES)("writing by entity_key: $table", (t: Keyed) => {
  it("ops go to the model's entity for their key, or create it; one entity a key", async () => {
    const seen = { samples: 0, created: 0, located: 0, changed: 0, replayed: 0 };
    await fc.assert(
      fc.asyncProperty(steps, async (sample) => {
        const store = main.store;
        await main.reset();
        let ids = 0;
        let minute = 0;
        let requests = 0;
        const newId = (kind: "row" | "entity" | "source" | "item" | "partition") => {
          ids++;
          const n = String(ids).padStart(kind === "row" || kind === "entity" ? 26 : 16, "0");
          return `${{ row: "r_", entity: "e_", source: "s_", item: "pi_", partition: "p_" }[kind]}${n}`;
        };
        await createTenant(
          store,
          createOpsContext({
            tenant: TENANT,
            actor: USER,
            trigger: null,
            task: null,
            visibility: { kind: "all" },
            idempotency_key_window: 86_400_000,
            idempotency_window: 600_000,
            now: "2026-11-05T00:00:00.000Z",
            confirmation: null,
          }),
        );
        await store.write(async (tx) => {
          const op = await appendOperation(tx, {
            actor: USER as never,
            now: "2026-11-05T00:00:30.000Z" as never,
            events: createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }),
          });
          await applyEvents(tx, eventsOf(op));
        });
        // Each request a key of its own: the samples repeat requests word for word.
        const send = async (ops: unknown[], actor = USER): Promise<Result> => {
          minute++;
          try {
            return (await store.write((tx) =>
              writeInTx(tx, {
                actor: actor as never,
                task: null,
                now: `2026-11-05T${String(1 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`,
                windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
                visibility: { kind: "all" },
                params: { sv: 1, idempotency_key: `r-${++requests}`, ops },
                newId,
                reads: readBufferOf(store),
              }),
            )) as never;
          } catch (e) {
            const x = e as { code?: string; detail?: Record<string, unknown> };
            if (x.code === undefined) throw e;
            return { refused: x.code, ...(x.detail ?? {}) };
          }
        };

        const held = new Map<number, Held>();
        const order: number[] = []; // keys in creation order (for `which`)
        // The model's keys as a creation's receipt lists them: the latest changed first.
        const expectedKeys = () =>
          [...held]
            .sort(([, a], [, b]) => opOf(b.ver) - opOf(a.ver) || (a.entity < b.entity ? -1 : 1))
            .map(([k]) => t.shown(k))
            .slice(0, 10);
        const otherKey = (k: number) => t.key((k + 1) % t.keys, 0);
        const byKey = (k: number, way: number, amount: number, extra: object = {}) => ({
          intent: "update",
          table: t.table,
          entity_key: t.key(k, way),
          set: { amount: String(amount + 1) },
          valid_from: "2026-10-01",
          ...extra,
        });
        const revokeByKey = (k: number, way: number, extra: object = {}) => ({
          intent: "revoke",
          table: t.table,
          entity_key: t.key(k, way),
          ...extra,
        });
        const create = (k: number, o: OpReceipt, before: unknown[], at: object) => {
          expect({ at, created: o.created_entity, keys: o.existing_keys }).toEqual({
            at,
            created: true,
            keys: before,
          });
          order.push(k);
          seen.created++;
        };

        for (const [n, st] of sample.entries()) {
          const at = { step: n, st };
          if (st.kind === "key") {
            const h = held.get(st.key);
            const set: Record<string, unknown> = { amount: String(st.amount + 1) };
            if (st.setKey === "same") Object.assign(set, t.key(st.key, st.way + 1));
            if (st.setKey === "other") Object.assign(set, otherKey(st.key));
            const before = expectedKeys();
            const r = await send([
              { ...byKey(st.key, st.way, st.amount, h ? { ver: h.ver } : {}), set },
            ]);
            if (st.setKey === "other") {
              expect({ at, r }).toMatchObject({ at, r: { reason: "key_field_changed" } });
              seen.changed++;
              continue;
            }
            expect({ at, refused: r.refused }).toEqual({ at, refused: undefined });
            const o = r.ops?.[0] as OpReceipt;
            if (h === undefined) {
              create(st.key, o, before, at);
              held.set(st.key, {
                entity: o.target.entity as string,
                ver: o.ver as string,
                revoked: false,
              });
            } else {
              expect({ at, entity: o.target.entity, created: o.created_entity }).toEqual({
                at,
                entity: h.entity,
                created: undefined,
              });
              held.set(st.key, { ...h, ver: o.ver as string, revoked: false });
              seen.located++;
            }
          } else if (st.kind === "entity" || st.kind === "revoke") {
            if (order.length === 0) continue;
            const k = order[st.which % order.length] as number;
            const h = held.get(k) as Held;
            if (st.kind === "revoke") {
              if (h.revoked) continue;
              const r = await send([
                { intent: "revoke", table: t.table, entity: h.entity, ver: h.ver },
              ]);
              expect({ at, refused: r.refused }).toEqual({ at, refused: undefined });
              held.set(k, { ...h, ver: r.ops?.[0]?.ver as string, revoked: true });
              continue;
            }
            const keySet = st.setKey === "same" ? t.key(k, st.way) : otherKey(k);
            const r = await send([
              {
                intent: "update",
                table: t.table,
                entity: h.entity,
                ver: h.ver,
                set: { ...keySet, amount: String(st.amount + 1) },
                valid_from: "2026-10-01",
              },
            ]);
            if (st.setKey === "other") {
              expect({ at, reason: r.reason }).toEqual({ at, reason: "key_field_changed" });
              seen.changed++;
              continue;
            }
            expect({ at, refused: r.refused }).toEqual({ at, refused: undefined });
            held.set(k, { ...h, ver: r.ops?.[0]?.ver as string, revoked: false });
          } else if (st.kind === "revokeKey") {
            const h = held.get(st.key);
            if (h === undefined) {
              const r = await send([revokeByKey(st.key, st.way)]);
              expect({ at, r }).toMatchObject({
                at,
                r: { refused: "not_found", param: "ops/0/entity_key" },
              });
              continue;
            }
            if (h.revoked) continue;
            const r = await send([revokeByKey(st.key, st.way, { ver: h.ver })]);
            expect({ at, refused: r.refused, entity: r.ops?.[0]?.target.entity }).toEqual({
              at,
              refused: undefined,
              entity: h.entity,
            });
            held.set(st.key, { ...h, ver: r.ops?.[0]?.ver as string, revoked: true });
          } else if (st.kind === "createRevoke") {
            // A key created (or written) and revoked in one request: the key stays with its entity.
            const h = held.get(st.key);
            const before = expectedKeys();
            const r = await send([
              byKey(st.key, st.way, 0, h ? { ver: h.ver } : {}),
              // An entity there before the request: each op brings the version it saw.
              revokeByKey(st.key, st.way + 1, h ? { ver: h.ver } : {}),
            ]);
            expect({ at, refused: r.refused }).toEqual({ at, refused: undefined });
            const [first, second] = r.ops as [OpReceipt, OpReceipt];
            const entity = h?.entity ?? (first.target.entity as string);
            expect({ at, a: first.target.entity, b: second.target.entity }).toEqual({
              at,
              a: entity,
              b: entity,
            });
            if (h === undefined) create(st.key, first, before, at);
            held.set(st.key, { entity, ver: second.ver as string, revoked: true });
          } else if (st.kind === "other") {
            // A second connection, which never read anything, writes by key without ver.
            const h = held.get(st.key);
            const before = expectedKeys();
            const r = await send([byKey(st.key, st.way, 1)], OTHER);
            if (h !== undefined) {
              expect({ at, r }).toMatchObject({ at, r: { refused: "read_first" } });
              continue;
            }
            expect({ at, refused: r.refused }).toEqual({ at, refused: undefined });
            const o = r.ops?.[0] as OpReceipt;
            create(st.key, o, before, at);
            held.set(st.key, {
              entity: o.target.entity as string,
              ver: o.ver as string,
              revoked: false,
            });
          } else {
            // Two ops a request: the second sees the first (a key it created needs no ver), and a
            // key the first created leads the second's existing_keys.
            const ha = held.get(st.a);
            const hb = st.b === st.a ? undefined : held.get(st.b);
            const before = expectedKeys();
            const r = await send([
              byKey(st.a, st.way, 1, ha ? { ver: ha.ver } : {}),
              // An entity there before the request: each op brings the version it saw.
              byKey(
                st.b,
                st.way + 1,
                2,
                (hb ?? (st.b === st.a ? ha : undefined)) ? { ver: (hb ?? ha)?.ver } : {},
              ),
            ]);
            expect({ at, refused: r.refused }).toEqual({ at, refused: undefined });
            const [oa, ob] = r.ops as [OpReceipt, OpReceipt];
            const entA = ha?.entity ?? (oa.target.entity as string);
            expect({ at, a: oa.target.entity }).toEqual({ at, a: entA });
            if (ha === undefined) create(st.a, oa, before, at);
            held.set(st.a, { entity: entA, ver: oa.ver as string, revoked: false });
            if (st.b === st.a) {
              expect({ at, b: ob.target.entity, createdB: ob.created_entity }).toEqual({
                at,
                b: entA,
                createdB: undefined,
              });
            } else {
              const entB = hb?.entity ?? (ob.target.entity as string);
              expect({ at, b: ob.target.entity }).toEqual({ at, b: entB });
              if (hb === undefined) {
                create(
                  st.b,
                  ob,
                  [...(ha === undefined ? [t.shown(st.a)] : []), ...before].slice(0, 10),
                  at,
                );
              }
              held.set(st.b, { entity: entB, ver: ob.ver as string, revoked: false });
            }
          }
          // One entity a key: the version table has exactly the model's entities.
          const stored = await store.read(async (tx) =>
            (
              await tx.query<{ row_id: string }>(
                `SELECT DISTINCT row_id FROM "t_${t.id}_v1__ver" ORDER BY row_id`,
              )
            ).rows.map((x) => x.row_id),
          );
          expect({ at, stored }).toEqual({
            at,
            stored: [...held.values()].map((h) => h.entity).sort(),
          });
        }

        // Replaying the log into an empty storage gives the same business and version tables.
        seen.samples++;
        if (seen.samples % 4 === 0) {
          await replica.reset();
          const events = await store.read((tx) => tx.query("SELECT * FROM events ORDER BY seq"));
          const content = await store.read((tx) =>
            tx.query("SELECT * FROM content ORDER BY seq, path"),
          );
          await replica.store.write(async (tx) => {
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
            await applyEvents(tx, await readEvents(tx, 1, (await readTail(tx))?.seq ?? 0));
          });
          const tables = (x: Record<string, string[]>) => ({
            business: x[`t_${t.id}_v1`],
            version: x[`t_${t.id}_v1__ver`],
            origins: x["row_origins"],
          });
          expect(tables(await replica.store.read(snapshot))).toEqual(
            tables(await store.read(snapshot)),
          );
          seen.replayed++;
        }
      }),
      {
        numRuns: RUNS,
        ...(SEED !== undefined ? { seed: SEED } : {}),
        ...(process.env["PROP_PATH"] ? { path: process.env["PROP_PATH"], endOnFailure: true } : {}),
      },
    );
    // The cases each sample must have are built in; these only guard against a generator gone
    // degenerate as a whole.
    expect(seen.samples).toBe(RUNS);
    expect(seen.created).toBeGreaterThan(0);
    expect(seen.located).toBeGreaterThan(0);
    expect(seen.changed).toBeGreaterThan(0);
    expect(seen.replayed).toBeGreaterThan(0);
  }, 600_000);
});
