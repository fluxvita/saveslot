// A `ver` given out before an import, written after it (04-contract §15 «恢复备份或导入之后»;
// 03-data-model/03-deletion.md «恢复次数»; 09-event-format §5.7 `ver`). Of one restore count less
// and not past the restore point: judged by its own operation; past the point, or of an older count:
// read at the point, its operation not checked against the row; of a newer count: not a version of
// this row. The event records the ver as given, and reading the log back after another import
// judges the write as it was. A replayed receipt keeps its restore count; a fallback ver is the one
// given then, from a read or from the caller's own write. A premise's ver the same. The imports are
// appended to the same store (`appendImportEvent`), their point the log's end then; a ver past the
// point is one of the old timeline's operations the log no longer has (a number past its end). The
// setup is import-receipt.test.ts's.

import {
  appendImportEvent,
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  pending,
  readBufferOf,
  readEvents,
  readTail,
} from "@fluxvita/saveslot-kernel";
import {
  COMPILED_V1,
  createSlotEvents,
  judgeStateFromLog,
  queryInTx,
  resolveInTx,
  tableShape,
  writeInTx,
} from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 60_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const ROWS = {
  id: "t1",
  name: "rows",
  kind: "base",
  description: "rows",
  time: { type: "none" },
  physical: { table: "t_t1_v1" },
  fields: [
    { id: "f2", name: "b", type: "text", required: true, description: "b" },
    { id: "f3", name: "c", type: "text", description: "c" },
  ],
};
const COMPILED = { ...COMPILED_V1, tables: [ROWS] };
const CHANGES = [
  { target: { slot: true }, change: "create_slot" },
  { target: { table: "t1" }, change: "add_table" },
].map((c) => ({
  ...c,
  class: "create",
  compatible_with_old_writes: true,
  destructive: false,
  auto: true,
}));

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

type Receipt = {
  seq: number;
  status?: string;
  replayed?: true;
  ops: {
    target: { row?: string };
    ver?: string;
    fields: Record<string, { result: string }>;
    premises?: { ver: string; state: string }[];
  }[];
  pending: { id: string }[];
  warnings?: { code: string; ver?: string }[];
};

/** Writes `params` as the user; the refusal's code and detail, if refused. */
async function send(params: unknown): Promise<Receipt & Record<string, unknown>> {
  try {
    return (await s.store.write((tx) =>
      writeInTx(tx, {
        actor: USER as never,
        task: null,
        now: now(),
        windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
        visibility: { kind: "all" },
        params: { sv: 1, ...(params as object) },
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
const insert = async (b: string) => {
  const r = await send({ ops: [{ intent: "insert", table: "rows", set: { b } }] });
  return { seq: r.seq, row: r.ops[0]?.target.row as string, ver: r.ops[0]?.ver as string };
};
const update = (row: string, set: Record<string, unknown>, ver?: string, more: object = {}) =>
  send({
    ops: [{ intent: "update", table: "rows", row, ...(ver !== undefined ? { ver } : {}), set }],
    ...more,
  });

/** An import appended to this store, of restore count `count`: its point, the log's end. */
const importAt = async (count: number) => {
  const tail = (await s.store.read(readTail))?.seq ?? 0;
  await appendImportEvent(s.store, {
    user: USER as never,
    tenant: `tn_${"9".repeat(26)}` as never,
    manifest: {
      saveslot_export: 1,
      tenant_id: TENANT as never,
      event_format: 1,
      restore_count: count - 1,
      upto: tail as never,
      events: 1,
      exported_at: "2026-11-05T08:00:00.000Z" as never,
      pending_deletions: "placeholder",
    },
    now: now() as never,
  });
};

/** The `ver` block of op 0 of operation `op`'s write head. */
const verBlockOf = async (op: number) => {
  const events = await s.store.read((tx) => readEvents(tx, op, op));
  const head = events.find((e) => e.header["type"] === "write.head");
  const b = head?.blocks.get("ops/0/target");
  return (b?.state === "present" ? (b.value as { ver?: unknown }).ver : undefined) as
    | Record<string, unknown>
    | undefined;
};
const resultOf = (r: Receipt) => r.ops[0]?.fields["b"]?.result;

beforeAll(async () => {
  s = await openReusable("saveslot-ver-across-restore-");
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

describe("an explicit ver from before the import", () => {
  it(
    "one count less, not past the point, nothing since: by its own operation; recorded as given",
    async () => {
      const a = await insert("9");
      await importAt(1);
      const w = await update(a.row, { b: "10" }, `v${a.seq}.0`);
      expect(w).not.toHaveProperty("refused");
      expect(resultOf(w)).toBe("applied");
      expect(w.ops[0]?.ver).toBe(`v${w.seq}.1`);
      expect(await verBlockOf(w.seq)).toEqual({ op: a.seq, restore_count: 0, basis: "explicit" });
    },
    T,
  );

  it(
    "one count less, not past the point, a change before the point: a conflict, as by its own operation",
    async () => {
      const a = await insert("9");
      await update(a.row, { b: "9.5" }, a.ver);
      await importAt(1);
      const w = await update(a.row, { b: "10" }, `v${a.seq}.0`);
      expect(resultOf(w)).toBe("candidate");
    },
    T,
  );

  it(
    "one count less, past the point: read at the point; a change after it is a conflict",
    async () => {
      const a = await insert("9");
      await importAt(1);
      const point = ((await s.store.read(readTail))?.seq ?? 0) - 1;
      // A change after the point, in this timeline.
      await update(a.row, { b: "9.5" }, `v${a.seq}.1`);
      // An operation of the old timeline past the point (the log has no such operation).
      const lost = point + 500;
      const w = await update(a.row, { b: "10" }, `v${lost}.0`);
      expect(resultOf(w)).toBe("candidate");
      expect(await verBlockOf(w.seq)).toEqual({ op: lost, restore_count: 0, basis: "explicit" });
    },
    T,
  );

  it(
    "past the point, nothing after it: read at the point, its operation not checked",
    async () => {
      const a = await insert("9");
      await importAt(1);
      const point = ((await s.store.read(readTail))?.seq ?? 0) - 1;
      const w = await update(a.row, { b: "10" }, `v${point + 500}.0`);
      expect(w).not.toHaveProperty("refused");
      expect(resultOf(w)).toBe("applied");
    },
    T,
  );

  it(
    "two counts less: read at the point, so a change before it is no conflict",
    async () => {
      const a = await insert("9");
      await update(a.row, { b: "9.5" }, a.ver);
      await importAt(1);
      await insert("between");
      await importAt(2);
      // By its own operation it would be a candidate (the 9.5 came after it).
      const w = await update(a.row, { b: "10" }, `v${a.seq}.0`);
      expect(resultOf(w)).toBe("applied");
      expect(await verBlockOf(w.seq)).toEqual({ op: a.seq, restore_count: 0, basis: "explicit" });
    },
    T,
  );

  it(
    "a count newer than the current one: not a version of this row",
    async () => {
      const a = await insert("9");
      const w = await update(a.row, { b: "10" }, `v${a.seq}.3`);
      expect(w).toMatchObject({ refused: "invalid_argument", reason: "not_this_target" });
    },
    T,
  );

  it(
    "read back from the log after another import: judged as it was written",
    async () => {
      const a = await insert("9");
      await update(a.row, { b: "9.5" }, a.ver);
      await importAt(1);
      const w = await update(a.row, { b: "10" }, `v${a.seq}.0`);
      expect(resultOf(w)).toBe("candidate");
      // A second import: two counts less now, and its point past the 9.5. Read at the end of the
      // log the ver would read there and the write apply; as of its write it is a candidate.
      await insert("between");
      await importAt(2);
      const state = await s.store.read((tx) =>
        judgeStateFromLog(tx, {
          table: "t1" as never,
          target: { row: a.row as never },
          shape: tableShape(ROWS as never),
          granularity: "date",
        }),
      );
      const base = (await s.store.read((tx) => readEvents(tx, w.seq, w.seq + 5))).find(
        (e) => e.header["type"] === "write.base" && (e.header["op"] ?? e.seq) === w.seq,
      );
      const item = state.items.find((x) => x.event === Number(base?.seq) && x.target === "f2");
      expect(item?.status).toBe("candidate");
      // Taking the previous value goes back to the merge base, the position the candidate's ver
      // read as of its write (a's 9), not as of the log's end (the second import's point: 9.5).
      const id = w.pending[0]?.id as string;
      const r = (await s.store.write((tx) =>
        resolveInTx(tx, {
          actor: USER as never,
          task: null,
          now: now(),
          windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
          visibility: { kind: "all" },
          params: {
            id,
            decision: "take_previous",
            item_ver: `${id.replace("pi_", "iv_")}.${w.seq}.2`,
          },
          newId,
          reads: readBufferOf(s.store),
        }),
      )) as unknown as Record<string, unknown>;
      expect(r).toMatchObject({ decision: "take_previous" });
      const now2 = await s.store.read((tx) =>
        tx.query<{ b: string }>('SELECT "f_f2" AS b FROM "t_t1_v1" WHERE row_id = $1', [a.row]),
      );
      expect(now2.rows.map((x) => x.b)).toEqual(["9"]);
    },
    T,
  );
});

describe("a candidate whose ver read at the restore point", () => {
  it(
    "its merge base is the point: taking the previous value goes back to the value there",
    async () => {
      const a = await insert("9");
      await importAt(1);
      const point = ((await s.store.read(readTail))?.seq ?? 0) - 1;
      const later = await update(a.row, { b: "9.5" }, `v${a.seq}.1`);
      // An operation of the old timeline past the point: reads at the point, so the 9.5 conflicts.
      const w = await update(a.row, { b: "10" }, `v${point + 500}.0`);
      expect(resultOf(w)).toBe("candidate");
      const id = w.pending[0]?.id as string;
      // The item's candidate carries the ver as given (09 §5.8 `seen`), not one never given out.
      const detail = (await pending(
        s.store,
        createOpsContext({
          tenant: TENANT,
          actor: USER,
          trigger: null,
          task: null,
          visibility: { kind: "all" },
          idempotency_key_window: 86_400_000,
          idempotency_window: 600_000,
          now: now(),
          confirmation: null,
        }),
        { id },
      )) as unknown as { candidates: { seq: number; ver: string }[] };
      expect(detail.candidates.find((c) => c.seq === w.seq)?.ver).toBe(`v${point + 500}.0`);
      const r = (await s.store.write((tx) =>
        resolveInTx(tx, {
          actor: USER as never,
          task: null,
          now: now(),
          windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
          visibility: { kind: "all" },
          params: {
            id,
            decision: "take_previous",
            item_ver: `${id.replace("pi_", "iv_")}.${w.seq}.1`,
          },
          newId,
          reads: readBufferOf(s.store),
        }),
      )) as unknown as Record<string, unknown>;
      expect(r).toMatchObject({ decision: "take_previous" });
      // The merge base is the point (9); read at the token's own op, past the log, it would be
      // the state after the 9.5.
      const b = await s.store.read((tx) =>
        tx.query<{ b: string }>('SELECT "f_f2" AS b FROM "t_t1_v1" WHERE row_id = $1', [a.row]),
      );
      expect(b.rows.map((x) => x.b)).toEqual(["9"]);
      expect(later.seq).toBeGreaterThan(point);
    },
    T,
  );
});

describe("a replayed receipt", () => {
  it(
    "keeps the restore count of its operation, not the current one",
    async () => {
      const a = await insert("9");
      const params = { idempotency_key: "once" };
      const first = await update(a.row, { b: "10" }, a.ver, params);
      expect(first.ops[0]?.ver).toBe(`v${first.seq}.0`);
      await importAt(1);
      const again = await update(a.row, { b: "10" }, a.ver, params);
      expect(again.replayed).toBe(true);
      expect(again.ops[0]?.ver).toBe(`v${first.seq}.0`);
    },
    T,
  );
});

describe("a fallback ver from before the import", () => {
  it(
    "from the caller's own write: the ver that write gave, in the warning and the event alike",
    async () => {
      const a = await insert("9");
      await importAt(1);
      const w = await update(a.row, { b: "10" });
      expect(w.warnings?.find((x) => x.code === "ver_fallback")?.ver).toBe(`v${a.seq}.0`);
      expect(await verBlockOf(w.seq)).toEqual({ op: a.seq, restore_count: 0, basis: "fallback" });
      expect(resultOf(w)).toBe("applied");
    },
    T,
  );

  it(
    "from a read: the ver the read gave, in the warning and the event alike",
    async () => {
      const a = await insert("9");
      await s.store.read((tx) =>
        queryInTx(tx, {
          actor: USER as never,
          task: null,
          now: now() as never,
          visibility: { kind: "all" },
          params: { table: "rows" },
          read: "rd_0000000000000001" as never,
          reads: readBufferOf(s.store),
        } as never),
      );
      await importAt(1);
      const w = await update(a.row, { b: "10" });
      const warning = w.warnings?.find((x) => x.code === "ver_fallback");
      expect(warning?.ver).toBe(`v${a.seq}.0`);
      expect(await verBlockOf(w.seq)).toEqual({ op: a.seq, restore_count: 0, basis: "fallback" });
    },
    T,
  );
});

describe("a premise's ver from before the import", () => {
  it(
    "one count less, not past the point: taken as given, and current when nothing changed",
    async () => {
      const target = await insert("release");
      const dep = await insert("task");
      await importAt(1);
      const w = await send({
        ops: [
          {
            intent: "update",
            table: "rows",
            row: dep.row,
            ver: `v${dep.seq}.0`,
            set: { c: "rests on it" },
            premises: [{ table: "rows", row: target.row, ver: `v${target.seq}.0` }],
          },
        ],
      });
      expect(w).not.toHaveProperty("refused");
      expect(w.ops[0]?.premises).toMatchObject([{ ver: `v${target.seq}.0`, state: "current" }]);
    },
    T,
  );

  it(
    "past the point: read at the point, so a change after it is a premise already changed",
    async () => {
      const target = await insert("release");
      const dep = await insert("task");
      await importAt(1);
      const point = ((await s.store.read(readTail))?.seq ?? 0) - 1;
      // The target changed after the point, in this timeline.
      await update(target.row, { b: "release 2" }, `v${target.seq}.1`);
      const lost = point + 500;
      const w = await send({
        ops: [
          {
            intent: "update",
            table: "rows",
            row: dep.row,
            ver: `v${dep.seq}.0`,
            set: { c: "rests on it" },
            premises: [{ table: "rows", row: target.row, ver: `v${lost}.0` }],
          },
        ],
      });
      expect(w.ops[0]?.premises).toMatchObject([{ ver: `v${lost}.0`, state: "changed" }]);
      // The target changed again, to a third value: still changed (the detection reads the
      // version seen where it reads, the point, not at the token's op past the log's end).
      await update(target.row, { b: "release 3" }, undefined);
      const decl = await s.store.read((tx) =>
        tx.query<{ state: string }>("SELECT state FROM premise_decls WHERE op = $1", [w.seq]),
      );
      expect(decl.rows.map((x) => x.state)).toEqual(["changed"]);
    },
    T,
  );

  it(
    "of the current count, its op past the log's end: not a version, refused, nothing appended",
    async () => {
      const target = await insert("release");
      const dep = await insert("task");
      const tail = (await s.store.read(readTail))?.seq ?? 0;
      const w = await send({
        ops: [
          {
            intent: "update",
            table: "rows",
            row: dep.row,
            ver: dep.ver,
            set: { c: "rests on it" },
            premises: [{ table: "rows", row: target.row, ver: `v${tail + 50}.0` }],
          },
        ],
      });
      expect(w).toMatchObject({ refused: "invalid_argument", reason: "not_this_target" });
      expect((await s.store.read(readTail))?.seq).toBe(tail);
    },
    T,
  );
});

describe("a row's ver of the current count past the log's end", () => {
  it(
    "not a version of the row: refused, nothing appended",
    async () => {
      const a = await insert("9");
      const tail = (await s.store.read(readTail))?.seq ?? 0;
      const w = await update(a.row, { b: "10" }, `v${tail + 50}.0`);
      expect(w).toMatchObject({ refused: "invalid_argument", reason: "not_this_target" });
      expect((await s.store.read(readTail))?.seq).toBe(tail);
    },
    T,
  );
});
