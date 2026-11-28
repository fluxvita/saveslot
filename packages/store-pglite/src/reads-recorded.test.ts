// When a read's record is written (02-architecture §7 «read_log 的持久性»). A store with
// `recordReads` (PostgreSQL: the server mode) writes it before the read answers, in a transaction
// that takes no tenant lock; one without (PGlite: the local mode) keeps it in the read buffer, as
// before. A record that cannot be written fails the read (`ReadNotRecorded`), with nothing kept.
// Reads recorded out of the order they were made (several processes): the version last read and
// `my_last_read` are those of the latest position, not of the latest record.

import {
  createOpsContext,
  flushReads,
  history,
  newReadId,
  query,
  type ReadEntry,
  ReadNotRecorded,
  readBufferOf,
  type TenantStore,
  write,
  writeReads,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_BACKEND } from "../../test-backend/src/index.fixture.ts";
import {
  secondConnection,
  WRITE_LOCK_SQL,
} from "../../test-backend/src/second-connection.fixture.ts";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";
import { buildTenant, NOW, TENANT, USER } from "./testing/sql-tenant.fixture.ts";

const T = 60_000;
let s: ReusableStore;
beforeAll(async () => {
  s = await openReusable("saveslot-reads-recorded-");
  await buildTenant(s);
}, 300_000);
afterAll(async () => {
  await s?.close();
}, 120_000);

let task = 0;
const ctx = (t: string) =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: t,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: NOW,
    confirmation: null,
  });

/** The store as one without `recordReads`, or with the one given: its own read buffer. */
const as = (store: TenantStore, recordReads?: TenantStore["recordReads"]): TenantStore => ({
  write: (fn) => store.write(fn),
  read: (fn) => store.read(fn),
  purgeResidue: (t) => store.purgeResidue(t),
  snapshot: () => store.snapshot(),
  formatVersion: store.formatVersion,
  close: () => store.close(),
  ...(recordReads !== undefined ? { recordReads } : {}),
});

/** The reads of `task` written in the store. */
const logged = (t: string) =>
  s.store.read(async (tx) => {
    const r = await tx.query<{ read_id: string }>("SELECT read_id FROM read_log WHERE task = $1", [
      t,
    ] as never);
    return r.rows.map((x) => x.read_id);
  });

const insert = (t: string, note: string) =>
  write(s.store, ctx(t), {
    sv: 1,
    ops: [
      { intent: "insert", table: "spend", set: { date: "2026-11-06", category: "food", note } },
    ],
  });

describe("a read's record", () => {
  it(
    "without `recordReads`: kept in the read buffer, not written, as before",
    async () => {
      const t = `buffered-${++task}`;
      const plain = as(s.store);
      await query(plain, ctx(t), { table: "spend" });
      expect(
        readBufferOf(plain)
          .entries()
          .map((e) => e.task),
      ).toEqual([t]);
      expect(await logged(t)).toEqual([]);
      readBufferOf(plain).take();
    },
    T,
  );

  it(
    "with `recordReads`: written before the read answers, nothing left in the buffer",
    async () => {
      const t = `written-${++task}`;
      const calls: number[] = [];
      const recording = as(s.store, async (fn) => {
        calls.push(1);
        // Written through the real store's transaction where it has one.
        const real = s.store as TenantStore;
        return real.recordReads !== undefined ? real.recordReads(fn) : real.write(fn);
      });
      await query(recording, ctx(t), { table: "spend" });
      expect(calls).toHaveLength(1);
      expect(readBufferOf(recording).size).toBe(0);
      expect(await logged(t)).toHaveLength(1);
    },
    T,
  );

  it(
    "that cannot be written fails the read with ReadNotRecorded: nothing written, nothing buffered",
    async () => {
      const t = `failed-${++task}`;
      const cause = Object.assign(new Error("the connection is gone"), { code: "connection_lost" });
      const failing = as(s.store, async () => {
        throw cause;
      });
      const e = await query(failing, ctx(t), { table: "spend" }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ReadNotRecorded);
      expect((e as Error).cause).toBe(cause);
      expect((e as Error).message).not.toContain("connection is gone");
      expect(readBufferOf(failing).size).toBe(0);
      expect(await logged(t)).toEqual([]);
    },
    T,
  );
});

describe("reads recorded out of the order they were made", () => {
  it(
    "the version last read and `my_last_read` stay at the latest position",
    async () => {
      const t = `order-${++task}`;
      // A real read's record, as the template of two: one made before a write, one after it.
      const plain = as(s.store);
      await query(plain, ctx(t), { table: "spend" });
      const [made] = readBufferOf(plain).take() as ReadEntry[];
      if (made === undefined) throw new Error("the read recorded nothing");
      const before = made.pos;
      const after = (await insert(`${t}-w`, "between the two reads")).seq;
      expect(after).toBeGreaterThan(before);
      const target = made.lastRead.find((x) => x.kind === "ver");
      if (target === undefined) throw new Error("the read read no row");
      const at = (pos: number, op: number): ReadEntry => ({
        ...made,
        read: newReadId(),
        pos: pos as never,
        lastRead: made.lastRead.map((x) => (x === target ? { ...x, op: op as never } : x)),
      });
      // The later read recorded first, the earlier one after it (another process, slower).
      await s.store.write((tx) => writeReads(tx, [at(after, after)]));
      await s.store.write((tx) => writeReads(tx, [at(before, before)]));
      const last = await s.store.read(async (tx) => {
        const r = await tx.query<{ op: unknown }>(
          "SELECT op FROM last_read WHERE actor = $1 AND task = $2 AND kind = 'ver' AND target = $3",
          [USER, t, target.target] as never,
        );
        return r.rows.map((x) => Number(x.op));
      });
      expect(last).toEqual([after]);
      // A later restore count is later, whatever its operation number.
      await s.store.write((tx) =>
        writeReads(tx, [
          { ...at(before, before), lastRead: [{ ...target, op: 1 as never, restoreCount: 1 }] },
        ]),
      );
      const restored = await s.store.read(async (tx) => {
        const r = await tx.query<{ op: unknown; restore_count: number }>(
          "SELECT op, restore_count FROM last_read WHERE actor = $1 AND task = $2 AND kind = 'ver' AND target = $3",
          [USER, t, target.target] as never,
        );
        return r.rows.map((x) => [Number(x.op), x.restore_count]);
      });
      expect(restored).toEqual([[1, 1]]);
      // `changes` since my last read starts after the later read: the write between is not in it.
      const r = (await history(s.store, ctx(t), {
        mode: "changes",
        table: "spend",
        since: "my_last_read",
      })) as unknown as { since: number };
      expect(r.since).toBe(after);
    },
    T,
  );
});

describe("my_last_read after a later read at an earlier position", () => {
  for (const flushed of [false, true]) {
    it(
      `is the read of the greatest position, the buffer ${flushed ? "written out" : "not written out"} in between`,
      async () => {
        const t = `greatest-${flushed}-${++task}`;
        const a = (await insert(`${t}-w`, "a")).seq;
        await query(s.store, ctx(t), { table: "spend" });
        // A write: the buffer (where there is one) written out.
        const b = (await insert(`${t}-w`, "b")).seq;
        await query(s.store, ctx(t), { table: "spend" });
        // Made after the read at b, at position a: a whole-table changes ending at a.
        await history(s.store, ctx(t), { mode: "changes", table: "spend", since: 1, until: a });
        if (flushed) {
          await flushReads(
            s.store,
            createOpsContext({ ...ctx(t), actor: "system", trigger: "flushReads" }),
          );
        }
        const r = (await history(s.store, ctx(t), {
          mode: "changes",
          table: "spend",
          since: "my_last_read",
        })) as unknown as { since: number };
        expect(r.since).toBe(b);
      },
      T,
    );
  }
});

describe.skipIf(TEST_BACKEND !== "postgres")("on PostgreSQL (the server mode)", () => {
  it(
    "a read is in the log for another connection as soon as it answers, before any write or close",
    async () => {
      const t = `seen-${++task}`;
      const second = await secondConnection(s.dir);
      try {
        await query(s.store, ctx(t), { table: "spend" });
        expect(readBufferOf(s.store).size).toBe(0);
        const seen = await second.read(async (tx) => {
          const reads = await tx.query<{ n: unknown }>(
            "SELECT count(*) AS n FROM read_log WHERE task = $1",
            [t] as never,
          );
          const last = await tx.query<{ n: unknown }>(
            "SELECT count(*) AS n FROM last_read WHERE task = $1",
            [t] as never,
          );
          return [Number(reads.rows[0]?.n), Number(last.rows[0]?.n) > 0];
        });
        expect(seen).toEqual([1, true]);
      } finally {
        await second.close();
      }
    },
    T,
  );

  it(
    "a read is answered and recorded while another connection holds the tenant's write lock",
    async () => {
      const t = `locked-${++task}`;
      const second = await secondConnection(s.dir);
      let release = () => {};
      const held = new Promise<void>((r) => {
        release = r;
      });
      let locked = () => {};
      const taken = new Promise<void>((r) => {
        locked = r;
      });
      const holding = second.write(async (tx) => {
        await tx.query(WRITE_LOCK_SQL);
        locked();
        await held;
      });
      try {
        await taken;
        const answered = await Promise.race([
          query(s.store, ctx(t), { table: "spend" }).then(() => "answered"),
          new Promise((r) => setTimeout(() => r("waited for the lock"), 5_000)),
        ]);
        expect(answered).toBe("answered");
        expect(await logged(t)).toHaveLength(1);
      } finally {
        release();
        await holding;
        await second.close();
      }
    },
    T,
  );
});
