// Kernel invariants through the real write path on PGlite (02-architecture §3), each with the
// evidence the unit cases do not give:
//   K1   no value computed from user content (request key, idempotency key and its fingerprint,
//        content hashes) and none of what 09-event-format §2.3 keeps out of a header (business
//        time interval, `task`, `stated_at`) is in any event header, for a write, a resolution and
//        a schema submission;
//   K3   a write failing after its events are appended and applied leaves neither events nor
//        state, nor its request key (K13, same transaction);
//   K13  a rejected request is not deduplicated: resent after the state changed, it is judged
//        again;
//   K7   the log replayed into an empty store under another clock gives the same materialized
//        state;
//   K14  the header actor of `item.resolved` is the principal that made the decision.
// Fictional IDs and data.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  KERNEL_TABLES,
  type ResolveReceipt,
  readBufferOf,
  readEvents,
  readTail,
  schemaDraft,
} from "@fluxvita/saveslot-kernel";
import {
  acceptPremisesForTests,
  COMPILED_V1,
  createSlotEvents,
  failPremiseDetectionForTests,
  resolveInTx,
  writeInTx,
} from "@fluxvita/saveslot-kernel/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openReusable, type ReusableStore, snapshot } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const OTHER = `ci_${"2".repeat(26)}`;
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
      id: "t3",
      name: "notes",
      kind: "base",
      description: "notes",
      time: { type: "none" },
      physical: { table: "t_t3_v1" },
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
  { target: { table: "t3" }, change: "add_table" },
].map((c) => ({
  ...c,
  class: "create",
  compatible_with_old_writes: true,
  destructive: false,
  auto: true,
}));
const DOCUMENT = {
  slot: "journal",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: "entries",
      kind: "base",
      description: "one row per entry",
      time: { type: "none" },
      fields: [{ name: "text", type: "text", description: "the text" }],
    },
  ],
};

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
const ctx = (o: { task?: string } = {}) =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: o.task ?? null,
    visibility: { kind: "all" },
    idempotency_key_window: 86_400_000,
    idempotency_window: 600_000,
    now: now(),
    confirmation: null,
  });

interface SendOptions {
  readonly actor?: string;
  readonly task?: string | null;
}

/** Sends `params` through the pipeline as `actor`; the error, if refused. */
async function send(params: unknown, o: SendOptions = {}) {
  try {
    return await s.store.write((tx) =>
      writeInTx(tx, {
        actor: (o.actor ?? USER) as never,
        task: o.task ?? null,
        now: now(),
        windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
        visibility: { kind: "all" },
        params,
        newId,
        reads: readBufferOf(s.store),
      }),
    );
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { refused: x.code, ...(x.detail ?? {}) } as never;
  }
}

/** Resolves through the pipeline as `actor`; the error, if refused. */
async function resolve(
  params: unknown,
  o: SendOptions = {},
): Promise<ResolveReceipt & Record<string, unknown>> {
  try {
    return (await s.store.write((tx) =>
      resolveInTx(tx, {
        actor: (o.actor ?? USER) as never,
        task: o.task ?? null,
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

const tail = async () => (await s.store.read(readTail))?.seq ?? 0;
const rowAt = (r: { readonly ops: readonly { readonly target: { readonly row?: string } }[] }) =>
  r.ops[0]?.target.row as string;
const verAt = (r: { readonly ops: readonly { readonly ver?: string }[] }) =>
  r.ops[0]?.ver as string;
const update = (row: string, set: Record<string, unknown>, ver: string, o: SendOptions = {}) =>
  send({ sv: 1, ops: [{ intent: "update", table: "rows", row, ver, set }] }, o);

beforeAll(async () => {
  s = await openReusable("saveslot-kernel-invariants-");
  acceptPremisesForTests(true);
}, T);
afterAll(async () => {
  acceptPremisesForTests(false);
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  // The open store's buffered reads outlive a reset: a case must not see an earlier case's.
  readBufferOf(s.store).take();
  ids = 0;
  minute = 0;
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
      now: "2026-11-05T00:00:00.000Z",
      confirmation: null,
    }),
  );
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-05T00:00:30.000Z" as never,
      events: createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }),
    });
    await applyEvents(tx, eventsOf(op));
  });
}, T);
afterEach(() => {
  failPremiseDetectionForTests(false);
  vi.useRealTimers();
});

// Each scenario's rows differ (`c`): the same request again would be a repeat of the first.
let scenario = 0;
/** 9 then 9.5 in effect, then a write of 10 seeing the first: a candidate on a conflict item. */
async function disputed(by: string = USER, other: string = USER) {
  scenario++;
  const a = await send(
    { sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "9", c: `s${scenario}` } }] },
    { actor: USER },
  );
  const row = rowAt(a);
  await update(row, { b: "9.5" }, verAt(a), { actor: other });
  const c = await update(row, { b: "10" }, verAt(a), { actor: by });
  const item = c.pending[0]?.id as string;
  expect(item).toMatch(/^pi_/);
  return { a, row, c, item, itemVer: c.pending[0]?.item_ver as string };
}

describe("K1: nothing computed from user content, and nothing 09 §2.3 forbids, is in a header", () => {
  /** The events after `since`: their rows of `events` as text, and what their content holds. */
  async function eventsAfter(since: number) {
    const rows = await s.store.read((tx) =>
      tx.query<Record<string, unknown>>("SELECT * FROM events WHERE seq > $1 ORDER BY seq", [
        since,
      ]),
    );
    const content = await s.store.read((tx) =>
      tx.query<{ seq: unknown; path: string; body: string | null; checksum: string | null }>(
        "SELECT seq, path, body, checksum FROM content WHERE seq > $1 ORDER BY seq, path",
        [since],
      ),
    );
    return {
      // The whole row: the header and the columns derived from it.
      headers: rows.rows.map((r) => ({
        seq: Number(r["seq"]),
        text: JSON.stringify(r, (_, v) => (typeof v === "bigint" ? String(v) : v)),
      })),
      content: content.rows,
    };
  }

  /**
   * Checks the events after `since`: each value of `named` (a value the caller sent, not in any
   * header), and each value computed from the content (request key, idempotency key and
   * fingerprint, every block checksum), is in no header. The values must be in the operation's
   * content to count: a value never recorded proves nothing. Returns the labels checked.
   */
  async function expectNoneInHeaders(
    since: number,
    named: Record<string, { value: string; inContent: boolean }>,
  ): Promise<string[]> {
    const { headers, content } = await eventsAfter(since);
    const bodyOf = (path: string) => {
      const b = content.find((x) => x.path === path)?.body;
      return b === null || b === undefined ? undefined : (JSON.parse(b) as Record<string, string>);
    };
    const checked: Record<string, string> = {};
    for (const [label, v] of Object.entries(named)) {
      checked[label] = v.value;
      if (v.inContent) {
        expect(
          content.some((x) => (x.body ?? "").includes(v.value)),
          `${label} is in the operation's content`,
        ).toBe(true);
      }
    }
    const rk = bodyOf("request_key");
    if (rk !== undefined) checked["request key"] = rk["key"] as string;
    const idem = bodyOf("idempotency");
    if (idem !== undefined) {
      checked["idempotency key"] = idem["key"] as string;
      checked["idempotency fingerprint"] = idem["fingerprint"] as string;
    }
    const sums = new Set(content.flatMap((x) => (x.checksum === null ? [] : [x.checksum])));
    expect(sums.size, "the operation has content checksums").toBeGreaterThan(2);
    sums.forEach((sum, k) => {
      checked[`content hash ${k}`] = sum;
    });
    for (const value of Object.values(checked)) expect(value.length).toBeGreaterThan(3);
    const leaks = Object.entries(checked).flatMap(([label, value]) =>
      headers
        .filter((h) => h.text.includes(value))
        .map((h) => `${label} in the header of ${h.seq}`),
    );
    expect(leaks).toEqual([]);
    return Object.keys(checked);
  }

  const CARRIED = {
    "business time from": { value: "2026-10-01", inContent: true },
    "business time to": { value: "2026-10-20", inContent: true },
    task: { value: "task-k1-alpha", inContent: true },
    stated_at: { value: "2026-09-09T09:09:09.000Z", inContent: true },
    "field value": { value: "secret-value-k1", inContent: true },
  };
  const carrying = (extra: Record<string, unknown>) => ({
    sv: 1,
    task: "task-k1-alpha",
    evidence: [
      {
        kind: "user_message",
        text: "the secret is secret-value-k1",
        stated_at: "2026-09-09T09:09:09.000Z",
      },
    ],
    ops: [
      {
        intent: "insert",
        table: "entities",
        valid_from: "2026-10-01",
        valid_to: "2026-10-20",
        set: { b: "secret-value-k1" },
      },
    ],
    ...extra,
  });

  it(
    "a write carrying a request key, task, stated_at, a business time interval and a value",
    async () => {
      const before = await tail();
      const r = await send(carrying({}));
      expect(r.status).toBe("saved");
      const checked = await expectNoneInHeaders(before, CARRIED);
      expect(checked).toContain("request key");
      expect(checked).not.toContain("idempotency key");
    },
    T,
  );

  it(
    "a write carrying an explicit idempotency key (its key and fingerprint) and the rest",
    async () => {
      const before = await tail();
      const r = await send(carrying({ idempotency_key: "k-raw-1" }));
      expect(r.status).toBe("saved");
      const checked = await expectNoneInHeaders(before, {
        ...CARRIED,
        // Stored hashed: the raw key is nowhere, so it can only be absent from the headers.
        "raw idempotency key": { value: "k-raw-1", inContent: false },
      });
      expect(checked).toEqual(
        expect.arrayContaining(["idempotency key", "idempotency fingerprint"]),
      );
      expect(checked).not.toContain("request key");
    },
    T,
  );

  it(
    "a resolution carrying a request key and a task; then one carrying an idempotency key",
    async () => {
      const first = await disputed();
      const before1 = await tail();
      const r1 = await resolve({
        id: first.item,
        decision: "keep_effective",
        item_ver: first.itemVer,
        task: "task-k1-alpha",
      });
      expect(r1["refused"]).toBeUndefined();
      const checked1 = await expectNoneInHeaders(before1, {
        task: { value: "task-k1-alpha", inContent: true },
      });
      expect(checked1).toContain("request key");

      const second = await disputed();
      const before2 = await tail();
      const r2 = await resolve({
        id: second.item,
        decision: "keep_effective",
        item_ver: second.itemVer,
        task: "task-k1-alpha",
        idempotency_key: "k-raw-2",
      });
      expect(r2["refused"]).toBeUndefined();
      const checked2 = await expectNoneInHeaders(before2, {
        task: { value: "task-k1-alpha", inContent: true },
        "raw idempotency key": { value: "k-raw-2", inContent: false },
      });
      expect(checked2).toEqual(
        expect.arrayContaining(["idempotency key", "idempotency fingerprint"]),
      );
    },
    T,
  );

  it(
    "a schema submission carrying a task and an idempotency key",
    async () => {
      const before = await tail();
      const r = await schemaDraft(s.store, ctx(), {
        document: structuredClone(DOCUMENT),
        task: "task-k1-alpha",
        idempotency_key: "k-raw-3",
      });
      expect(r).toMatchObject({ slot: "journal", outcome: "applied" });
      const checked = await expectNoneInHeaders(before, {
        task: { value: "task-k1-alpha", inContent: true },
        "raw idempotency key": { value: "k-raw-3", inContent: false },
        "table name": { value: "entries", inContent: true },
      });
      expect(checked).toEqual(
        expect.arrayContaining(["idempotency key", "idempotency fingerprint"]),
      );

      // Without an explicit key: the request key.
      const before2 = await tail();
      await schemaDraft(s.store, ctx(), {
        document: { ...structuredClone(DOCUMENT), slot: "journal2" },
        task: "task-k1-alpha",
      });
      expect(await expectNoneInHeaders(before2, {})).toContain("request key");
    },
    T,
  );
});

describe("K3, K13: a write failing after its events are appended leaves nothing", () => {
  it(
    "events, every table of the store and the request key are as before; the request is no replay",
    async () => {
      const a = await send({ sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "v1" } }] });
      const row = rowAt(a);
      // A note resting on the row's `b`, so that changing `b` has a premise to mark.
      const note = await send({
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "notes",
            set: { b: "n" },
            premises: [{ table: "rows", row, fields: ["b"], ver: verAt(a) }],
          },
        ],
      });
      expect(note.status).toBe("saved");
      const params = {
        sv: 1,
        ops: [{ intent: "update", table: "rows", row, ver: verAt(a), set: { b: "v2" } }],
      };
      const before = {
        tail: await tail(),
        store: await s.store.read(snapshot),
        keys: (await s.store.read((tx) => tx.query("SELECT * FROM request_keys ORDER BY key")))
          .rows,
      };
      expect(before.keys.length).toBe(2);

      failPremiseDetectionForTests(true);
      let inside: { tail: number; keys: number; rowB: unknown } | undefined;
      await expect(
        s.store.write(async (tx) => {
          try {
            return await writeInTx(tx, {
              actor: USER as never,
              task: null,
              now: now(),
              windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
              visibility: { kind: "all" },
              params,
              newId,
              reads: readBufferOf(s.store),
            });
          } catch (e) {
            // The failure is where the events are appended and applied and the operation is not
            // finished: the log has grown, the key is recorded, the row has its new value.
            inside = {
              tail: ((await readTail(tx))?.seq ?? 0) as number,
              keys: Number(
                (await tx.query<{ n: unknown }>("SELECT count(*) AS n FROM request_keys")).rows[0]
                  ?.n,
              ),
              rowB: (
                await tx.query<{ f_f2: unknown }>("SELECT f_f2 FROM t_t1_v1 WHERE row_id = $1", [
                  row,
                ])
              ).rows[0]?.f_f2,
            };
            throw e;
          }
        }),
      ).rejects.toThrow("premise detection failed");
      expect(inside?.tail).toBeGreaterThan(before.tail);
      expect(inside).toMatchObject({ keys: 3, rowB: "v2" });

      // After the rollback: the log tail, every table (materialized state and the request-key
      // index among them) and the index rows themselves are as they were.
      expect(await tail()).toBe(before.tail);
      expect(await s.store.read(snapshot)).toEqual(before.store);
      expect(
        (await s.store.read((tx) => tx.query("SELECT * FROM request_keys ORDER BY key"))).rows,
      ).toEqual(before.keys);

      // The key was not kept: the same request is not answered as a replay, it is written.
      failPremiseDetectionForTests(false);
      const again = await send(params);
      expect(again).not.toHaveProperty("replayed");
      expect(again.status).toBe("saved");
      expect(again.seq).toBe(before.tail + 1);
    },
    T,
  );
});

describe("K13: a rejected request is not deduplicated", () => {
  it(
    "refused for a missing read, resent after the read: judged on the new state and saved",
    async () => {
      const a = await send({ sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "x" } }] });
      const row = rowAt(a);
      // No `ver` and nothing the caller read or wrote: read_first.
      const params = { sv: 1, ops: [{ intent: "update", table: "rows", row, set: { c: "z" } }] };
      const keysBefore = (await s.store.read((tx) => tx.query("SELECT * FROM request_keys"))).rows;
      const before = await tail();
      expect(await send(params, { actor: OTHER })).toMatchObject({
        refused: "read_first",
        reason: "no_read",
      });
      // A refusal makes no event and no key.
      expect(await tail()).toBe(before);
      expect((await s.store.read((tx) => tx.query("SELECT * FROM request_keys"))).rows).toEqual(
        keysBefore,
      );

      // The state changes: the caller reads the row.
      readBufferOf(s.store).record({
        read: `rd_${"5".repeat(16)}` as never,
        actor: OTHER as never,
        task: null,
        at: now() as never,
        pos: 1 as never,
        operation: "query",
        rows: [],
        coarse: [],
        lastRead: [{ kind: "ver", target: row, op: a.seq, restoreCount: 0 }],
      });

      const again = await send(params, { actor: OTHER });
      expect(again).not.toHaveProperty("refused");
      expect(again).not.toHaveProperty("replayed");
      expect(again.status).toBe("saved");
      expect(again.seq).toBe(before + 1);
      expect(again.warnings).toEqual([
        expect.objectContaining({ code: "ver_fallback", ver: verAt(a) }),
      ]);
    },
    T,
  );
});

describe("K7: replay uses only the times the events recorded", () => {
  it(
    "replayed into an empty store under another clock: the materialized state row for row",
    async () => {
      // The live writes run under one clock, the replay under a clock years later in another day.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-05T01:00:00.000Z"));
      const a = await send({
        sv: 1,
        task: "t-k7",
        idempotency_key: "k7-key",
        ops: [{ intent: "insert", table: "rows", set: { b: "9", c: "k7" } }],
      });
      const row = rowAt(a);
      await update(row, { b: "9.5" }, verAt(a));
      const conflicting = await update(row, { b: "10" }, verAt(a), { actor: OTHER });
      const item = conflicting.pending[0]?.id as string;
      const resolved = await resolve({
        id: item,
        decision: "keep_effective",
        item_ver: conflicting.pending[0]?.item_ver,
      });
      expect(resolved["refused"]).toBeUndefined();
      await send({
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "entities",
            valid_from: "2026-10-01",
            valid_to: "2026-10-20",
            set: { b: "e" },
          },
        ],
      });
      await send({
        sv: 1,
        ops: [{ intent: "insert", table: "notes", set: { b: "n" } }],
      });

      const events = await s.store.read((tx) => tx.query("SELECT * FROM events ORDER BY seq"));
      const content = await s.store.read((tx) =>
        tx.query("SELECT * FROM content ORDER BY seq, path"),
      );
      const last = await tail();
      const KEEP = new Set(
        KERNEL_TABLES.filter((t) => t.class === "materialized").map((t) => t.name),
      );
      const KERNEL = new Set(KERNEL_TABLES.map((t) => t.name));
      const pick = (x: Record<string, string[]>) =>
        Object.fromEntries(Object.entries(x).filter(([k]) => KEEP.has(k) || !KERNEL.has(k)));
      const live = pick(await s.store.read(snapshot));
      for (const name of ["request_keys", "pending_items", "t_t1_v1", "t_t2_v1", "t_t3_v1"])
        expect(live[name]?.length, name).toBeGreaterThan(0);

      vi.setSystemTime(new Date("2031-06-30T23:59:59.000Z"));
      const into = await openReusable("saveslot-k7-replay-");
      try {
        await into.store.write(async (tx) => {
          for (const [table, rows] of [
            ["events", events.rows],
            ["content", content.rows],
          ] as const)
            for (const row of rows as Record<string, unknown>[]) {
              const cols = Object.keys(row);
              await tx.query(
                `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
                Object.values(row) as never,
              );
            }
          await applyEvents(tx, await readEvents(tx, 1 as never, last as never));
        });
        expect(pick(await into.store.read(snapshot))).toEqual(live);
      } finally {
        await into.close();
      }
    },
    T,
  );
});

describe("K14: who decided is recorded in the header of item.resolved", () => {
  /** The header `actor` of the `item.resolved` events after `since`, and their `actor` column. */
  async function resolvedActors(since: number) {
    const rows = await s.store.read((tx) =>
      tx.query<{ header: string; actor: string }>(
        "SELECT header, actor FROM events WHERE seq > $1 AND type = 'item.resolved'",
        [since],
      ),
    );
    return rows.rows.map((r) => ({
      header: (JSON.parse(r.header) as { actor: string }).actor,
      column: r.actor,
    }));
  }

  it(
    "a connection deciding what a user's write opened, and a user deciding what a connection's did",
    async () => {
      // The item's candidate is by USER; OTHER decides.
      const first = await disputed(USER, USER);
      const before1 = await tail();
      expect(
        (
          await resolve(
            { id: first.item, decision: "keep_effective", item_ver: first.itemVer },
            { actor: OTHER },
          )
        )["refused"],
      ).toBeUndefined();
      expect(await resolvedActors(before1)).toEqual([{ header: OTHER, column: OTHER }]);

      // The candidate is by OTHER; USER decides: the header names the decider, not the writer.
      const second = await disputed(OTHER, OTHER);
      const before2 = await tail();
      expect(
        (
          await resolve(
            { id: second.item, decision: "keep_effective", item_ver: second.itemVer },
            { actor: USER },
          )
        )["refused"],
      ).toBeUndefined();
      expect(await resolvedActors(before2)).toEqual([{ header: USER, column: USER }]);
    },
    T,
  );
});
