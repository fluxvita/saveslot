// Test fixture run as a separate process, so that it starts with the restricted SQL parser not
// loaded: reports the outcome as one JSON line on stdout.
//   node --conditions=source derived-tenant.fixture.ts <dir> setup
//     Creates a tenant at <dir> with a slot of derived tables over `runs` and one run. Loads the
//     parser itself, explicitly: compiling the rules needs it.
//   node --conditions=source derived-tenant.fixture.ts <dir> serve <empty-dir>
//     Opens the tenant at <dir> as a host does (the kernel's `openTenant`), submits no schema
//     document, and then (a) queries a derived table, (b) writes a run and refreshes the derived
//     tables in the same operation, (c) replays the log, derived writes included, into an empty
//     storage at <empty-dir>. Each step reports "ok" or the error it threw.

import {
  appendOperation,
  applyEvents,
  continueOperation,
  createOpsContext,
  createTenant,
  derivedWrites,
  eventsOf,
  isRsqlLoaded,
  loadRsql,
  openTenant,
  query,
  readEvents,
  readTail,
  type Tx,
} from "@fluxvita/saveslot-kernel";
import { derivedSchema, rule } from "@fluxvita/saveslot-kernel/rsql-testing";
import { createSlotEvents, SLOT } from "@fluxvita/saveslot-kernel/testing";
import { PgliteBackend } from "../backend.ts";

type CompiledSchema = ReturnType<typeof derivedSchema>;

const [dir = "", mode, emptyDir] = process.argv.slice(2);
if (dir === "" || (mode !== "setup" && mode !== "serve")) {
  throw new Error("usage: derived-tenant.fixture.ts <dir> setup | <dir> serve <empty-dir>");
}

const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const ctx = (now: string) =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_key_window: 86_400_000,
    idempotency_window: 86_400_000,
    now,
    confirmation: null,
  });

/** One operation inserting a run in the base table directly; its derived writes appended. */
async function insertRun(tx: Tx, schema: CompiledSchema, n: number, now: string): Promise<void> {
  const row = `r_${String(n).padStart(26, "0")}`;
  await tx.query(`INSERT INTO "t_t1_v1" (row_id, "f_f1", "f_f2") VALUES ($1, $2, $3)`, [
    row,
    "2026-11-02",
    "5",
  ]);
  const opened = await appendOperation(tx, {
    actor: USER as never,
    now: now as never,
    events: [
      {
        type: "write.head",
        slot: SLOT,
        blocks: {
          ctx: {
            now,
            today: now.slice(0, 10),
            ruleset_version: 1,
            policy_version: 1,
            literal_checker: "literal@1",
          },
          request: { sv: 1, sv_basis: "explicit", op_count: 1 },
          "ops/0/target": { table: "t1", row, intent: "insert" },
        } as never,
      },
    ],
  });
  await applyEvents(tx, eventsOf(opened));
  const writes = await derivedWrites({
    query: async (sql, params) => tx.query<Record<string, unknown>>(sql, params as never),
    schema,
    changes: [{ table: "t1" as never, row: row as never, fields: [] }],
    newPartitionId: () => `p_${String(n).padStart(16, "0")}` as never,
    readPos: opened.op,
  });
  const more = await continueOperation(
    tx,
    opened,
    writes.map((w) => ({
      type: "write.derived" as const,
      slot: SLOT,
      blocks: {
        target: w.target as never,
        ...(w.key !== undefined ? { key: w.key as never } : {}),
        ...(w.checksum !== undefined ? { checksum: w.checksum as never } : {}),
      },
    })),
  );
  await applyEvents(tx, eventsOf(more));
}

async function setup(): Promise<unknown> {
  await loadRsql();
  const base = derivedSchema(
    rule(
      "SELECT date_trunc('week', date::timestamp)::date AS week, sum(distance) AS total FROM runs GROUP BY 1",
      ["week", "total"],
      "bucketed",
    ),
  );
  const schema = { ...base, slot: SLOT } as CompiledSchema;
  const store = await new PgliteBackend().open({ kind: "pglite", dir }, { create: true });
  try {
    await createTenant(store, ctx("2026-11-10T04:00:00.000Z"));
    const change = (target: Record<string, unknown>, kind: string) => ({
      target,
      change: kind,
      class: "create",
      compatible_with_old_writes: true,
      destructive: false,
      auto: true,
    });
    await store.write(async (tx) => {
      const op = await appendOperation(tx, {
        actor: USER as never,
        now: "2026-11-10T04:01:00.000Z" as never,
        events: createSlotEvents({
          compiled: schema as never,
          changes: [
            change({ slot: true }, "create_slot"),
            ...schema.tables.map((t) =>
              change({ table: t.id }, t.kind === "base" ? "add_table" : "add_derived_table"),
            ),
          ] as never,
        }),
      });
      await applyEvents(tx, eventsOf(op));
    });
    await store.write((tx) => insertRun(tx, schema, 1, "2026-11-10T04:02:00.000Z"));
  } finally {
    await store.close();
  }
  return { setup: "ok" };
}

const outcome = async (f: () => Promise<unknown>): Promise<unknown> => {
  try {
    return (await f()) ?? "ok";
  } catch (e) {
    return String((e as Error).message ?? e);
  }
};

async function serve(): Promise<unknown> {
  const before = isRsqlLoaded();
  const store = await new PgliteBackend().open({ kind: "pglite", dir }, {});
  try {
    const tail = await store.read((tx) => readTail(tx));
    const decision = await openTenant({ logEnd: tail?.seq ?? (0 as never), highWater: 0 });
    // The compiled definition as the log keeps it: nothing here compiles a rule.
    const schema = await store.read(async (tx) => {
      const r = await tx.query<{ body: string }>(
        `SELECT c.body FROM schema_versions v JOIN content c ON c.seq = v.compiled_seq
         AND c.path = 'compiled' WHERE v.state = 'current'`,
      );
      return JSON.parse(r.rows[0]?.body as string) as CompiledSchema;
    });
    const a = await outcome(async () => {
      const r = await query(store, ctx("2026-11-10T05:00:00.000Z"), { table: "weekly" });
      return r.rows.length === 1 ? "ok" : `rows: ${r.rows.length}`;
    });
    const b = await outcome(() =>
      store.write((tx) => insertRun(tx, schema, 2, "2026-11-10T05:01:00.000Z")),
    );
    const c = await outcome(async () => {
      const events = await store.read((tx) => tx.query("SELECT * FROM events ORDER BY seq"));
      const content = await store.read((tx) =>
        tx.query("SELECT * FROM content ORDER BY seq, path"),
      );
      const runs = await store.read((tx) =>
        tx.query<Record<string, unknown>>(
          'SELECT row_id, CAST("f_f1" AS text) AS "f_f1", CAST("f_f2" AS text) AS "f_f2" FROM "t_t1_v1"',
        ),
      );
      const replica = await new PgliteBackend().open(
        { kind: "pglite", dir: emptyDir as string },
        { create: true },
      );
      try {
        await replica.write(async (tx) => {
          for (const [table, rows] of [
            ["events", events.rows],
            ["content", content.rows],
          ] as const) {
            for (const x of rows) {
              const cols = Object.keys(x);
              await tx.query(
                `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
                Object.values(x) as never,
              );
            }
          }
          const last = (await readTail(tx))?.seq ?? 0;
          const all = await readEvents(tx, 1, last);
          if (!all.some((e) => e.header["type"] === "write.derived")) {
            throw new Error("no derived write in the log");
          }
          // Operation by operation. The runs were inserted in the base table directly (the write
          // pipeline does not write a table a rule reads in this version): each is inserted again
          // just before its operation, as it was the first time.
          const ops = new Map<number, typeof all>();
          const opOf = new Map(events.rows.map((x) => [Number(x["seq"]), Number(x["op"])]));
          for (const e of all) {
            const op = opOf.get(Number(e.header["seq"])) as number;
            ops.set(op, [...(ops.get(op) ?? []), e]);
          }
          for (const [, events] of [...ops].sort(([x], [y]) => x - y)) {
            const head = events[0];
            if (head?.header["type"] === "write.head") {
              const t = head.blocks.get("ops/0/target");
              const row = (t?.state === "present" ? t.value : {}) as { row?: string };
              const r = runs.rows.find((x) => x["row_id"] === row.row) as Record<string, unknown>;
              await tx.query(`INSERT INTO "t_t1_v1" (row_id, "f_f1", "f_f2") VALUES ($1, $2, $3)`, [
                r["row_id"],
                r["f_f1"],
                r["f_f2"],
              ] as never);
            }
            await applyEvents(tx, events);
          }
        });
      } finally {
        await replica.close();
      }
    });
    return { before, decision: decision.kind, a, b, c };
  } finally {
    await store.close();
  }
}

process.stdout.write(`${JSON.stringify(await (mode === "setup" ? setup() : serve()))}\n`);
