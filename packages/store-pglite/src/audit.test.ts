// Read records on PGlite (02-architecture §7 «read_log 的持久性», §8 `read_log`, `read_log_rows`,
// `last_read`): what writing a read leaves in the three tables, the latest version read per actor
// and task, and the internal operation `flushReads` (written in its own transaction; put back into
// the buffer when that fails).

import {
  createOpsContext,
  flushReads,
  lastRead,
  newReadId,
  type ReadEntry,
  readBufferOf,
  type TenantStore,
  writeReads,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const A = `ci_${"A".repeat(26)}` as ReadEntry["actor"];
const E1 = `e_${"1".repeat(26)}`;
const R1 = `r_${"2".repeat(26)}`;
const SLOT = `sl_${"3".repeat(16)}` as ReadEntry["slot"] & string;
const T1 = "t1" as ReadEntry["rows"][number]["table"];
type TableId = typeof T1;

const ctx = (trigger: string | null, actor: string = "system") =>
  createOpsContext({
    tenant: `tn_${"4".repeat(26)}`,
    actor,
    trigger,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 0,
    idempotency_key_window: 0,
    now: "2026-11-15T08:00:00.000Z",
    confirmation: null,
  });

function entry(o: Partial<ReadEntry> = {}): ReadEntry {
  return {
    read: newReadId(),
    actor: A,
    task: null,
    at: "2026-11-15T08:00:00.000Z" as ReadEntry["at"],
    pos: 12 as ReadEntry["pos"],
    operation: "query",
    slot: SLOT,
    sv: 1,
    table: T1,
    shape: '{"table":"t1","where":[{"field":"f1","op":"=","value":"?"}]}',
    valid: { at: "2026-11-15" },
    rows: [
      { table: T1, target: E1, ver: { op: 9 as never, restoreCount: 0 } },
      { table: T1, target: R1, ver: { op: 11 as never, restoreCount: 0 } },
    ],
    coarse: [],
    lastRead: [
      { kind: "ver", target: E1, op: 9, restoreCount: 0 },
      { kind: "sv", target: SLOT, op: 1, restoreCount: 0 },
    ],
    ...o,
  };
}

let rs: ReusableStore;
let store: TenantStore;
// Opening PGlite takes seconds, more under a full parallel run.
beforeAll(async () => {
  rs = await openReusable("saveslot-audit-");
  store = rs.store;
}, 120_000);
afterAll(() => rs?.close(), 120_000);
beforeEach(async () => {
  await rs.reset();
  readBufferOf(store).take();
}, 120_000);

const rowsOf = (sql: string) =>
  store.read(async (tx) =>
    (await tx.query(sql)).rows.map((r) =>
      JSON.parse(JSON.stringify(r, (_, v) => (typeof v === "bigint" ? Number(v) : v))),
    ),
  );

describe("writeReads", () => {
  it("writes one row per read, its rows in order, table-level records, and last_read", async () => {
    const e = entry({ coarse: ["t2" as TableId] });
    await store.write((tx) => writeReads(tx, [e]));
    expect(await rowsOf("SELECT * FROM read_log")).toEqual([
      {
        read_id: e.read,
        n: 1,
        actor: A,
        task: null,
        at: "2026-11-15T08:00:00.000Z",
        pos: 12,
        operation: "query",
        selfcheck: false,
        slot_id: SLOT,
        sv: 1,
        table_id: "t1",
        shape: e.shape,
        valid: '{"at":"2026-11-15"}',
        source_id: null,
      },
    ]);
    expect(await rowsOf("SELECT * FROM read_log_rows ORDER BY k")).toEqual([
      { read_id: e.read, k: 0, table_id: "t1", target: E1, ver_op: 9, ver_restore_count: 0 },
      { read_id: e.read, k: 1, table_id: "t1", target: R1, ver_op: 11, ver_restore_count: 0 },
      {
        read_id: e.read,
        k: 2,
        table_id: "t2",
        target: null,
        ver_op: null,
        ver_restore_count: null,
      },
    ]);
    expect(await rowsOf("SELECT * FROM last_read ORDER BY kind")).toEqual([
      { actor: A, task: "", target: SLOT, kind: "sv", op: 1, restore_count: 0, read_id: e.read },
      { actor: A, task: "", target: E1, kind: "ver", op: 9, restore_count: 0, read_id: e.read },
    ]);
  });

  it("writes more rows than one statement takes", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({
      table: T1,
      target: `r_${String(i).padStart(26, "0")}`,
      ver: { op: 1 as never, restoreCount: 0 },
    }));
    await store.write((tx) => writeReads(tx, [entry({ rows })]));
    const [c] = await rowsOf("SELECT count(*)::int AS n, max(k) AS k FROM read_log_rows");
    expect(c).toEqual({ n: 2500, k: 2499 });
  });

  it("keeps the latest read per actor, task and target, the later of a batch winning", async () => {
    const first = entry();
    const later = entry({ lastRead: [{ kind: "ver", target: E1, op: 15, restoreCount: 0 }] });
    const tasked = entry({
      task: "t1",
      lastRead: [{ kind: "ver", target: E1, op: 20, restoreCount: 0 }],
    });
    await store.write((tx) => writeReads(tx, [first, later, tasked]));
    const q = { actor: A, task: null, kind: "ver" as const, target: E1 };
    const empty = readBufferOf({});
    expect(await store.read((tx) => lastRead(tx, empty, q))).toEqual({
      op: 15,
      restoreCount: 0,
      read: later.read,
    });
    expect(await store.read((tx) => lastRead(tx, empty, { ...q, task: "t1" }))).toEqual({
      op: 20,
      restoreCount: 0,
      read: tasked.read,
    });
    expect(await store.read((tx) => lastRead(tx, empty, { ...q, task: "t2" }))).toBeUndefined();
  });
});

describe("lastRead", () => {
  it("takes a buffered read before a written one", async () => {
    await store.write((tx) => writeReads(tx, [entry()]));
    const buffered = entry({ lastRead: [{ kind: "ver", target: E1, op: 30, restoreCount: 0 }] });
    readBufferOf(store).record(buffered);
    expect(
      await store.read((tx) =>
        lastRead(tx, readBufferOf(store), { actor: A, task: null, kind: "ver", target: E1 }),
      ),
    ).toEqual({ op: 30, restoreCount: 0, read: buffered.read });
  });
});

describe("flushReads", () => {
  it("writes the buffered reads and empties the buffer", async () => {
    const [e1, e2] = [entry(), entry()];
    readBufferOf(store).record(e1);
    readBufferOf(store).record(e2);
    expect(await flushReads(store, ctx("flushReads"))).toEqual({ flushed: 2 });
    expect(readBufferOf(store).size).toBe(0);
    expect((await rowsOf("SELECT read_id FROM read_log ORDER BY n")).map((r) => r.read_id)).toEqual(
      [e1.read, e2.read],
    );
    expect(await flushReads(store, ctx("closeTenant"))).toEqual({ flushed: 0 });
  });

  it("puts the reads back when the transaction fails", async () => {
    const e = entry();
    readBufferOf(store).record(e);
    // A read whose ID is already written: the INSERT fails, nothing commits.
    await store.write((tx) => writeReads(tx, [{ ...entry(), read: e.read }]));
    const later = entry();
    await expect(flushReads(store, ctx("flushReads"))).rejects.toThrow();
    readBufferOf(store).record(later);
    expect(
      readBufferOf(store)
        .take()
        .map((x) => x.read),
    ).toEqual([e.read, later.read]);
    expect(await rowsOf("SELECT count(*)::int AS n FROM read_log_rows")).toEqual([{ n: 2 }]);
  });

  it("puts the reads back when the commit fails after writing", async () => {
    const e = entry();
    const failing = {
      ...store,
      write: (fn: (tx: never) => Promise<unknown>) =>
        store.write(async (tx) => {
          await fn(tx as never);
          throw new Error("commit failed");
        }),
    } as unknown as TenantStore;
    readBufferOf(failing).record(e);
    await expect(flushReads(failing, ctx("flushReads"))).rejects.toThrow("commit failed");
    expect(readBufferOf(failing).take()).toEqual([e]);
    expect(await rowsOf("SELECT count(*)::int AS n FROM read_log")).toEqual([{ n: 0 }]);
  });

  it("runs only as the flushReads or closeTenant task", async () => {
    await expect(flushReads(store, ctx(null, A))).rejects.toThrow(/flushReads/);
    await expect(flushReads(store, ctx("openTenant"))).rejects.toThrow(/flushReads/);
  });
});
