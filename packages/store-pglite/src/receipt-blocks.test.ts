// A receipt reads its operation's events and their blocks (kernel write/receipt.ts
// `operationEvents`): the blocks by the events' sequence numbers, on `content`'s primary key.
//
// 1. It gives what the join it replaced gives (`content` joined with `events` on `seq`, `op` given),
//    for every operation of a log: one event or many, blocks a deletion cleared, an operation with
//    no event.
// 2. Its plan does not scan the whole of `content`, for a single write's operation nor for a batch
//    of thousands of events, on a log of batches with a few single writes. The join it replaced
//    does for the batch (as on a real log of 8 million blocks, where it did for single writes too:
//    the planner expected thousands of events per operation), so the check tells them apart.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TenantStore } from "@fluxvita/saveslot-kernel";
import { BLOCKS_OF_EVENTS_SQL, operationEvents } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testBackend } from "./testing/test-backend.fixture.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** The statement the receipt read its blocks with before. */
const JOINED =
  "SELECT c.seq, c.path, c.body FROM content c JOIN events e ON e.seq = c.seq WHERE e.op = $1 AND c.body IS NOT NULL";

/** Batches: operations of 2000 events each; then single writes of 5 events each. */
const BATCHES = 100;
const BATCH = 2000;
const SINGLES = 10;
const SINGLE = 5;
/** Blocks per event. */
const BLOCKS = 8;

let root: string;
let store: TenantStore;
/** The operation numbers, by kind. */
const ops = { batch: [] as number[], single: [] as number[] };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "saveslot-receipt-blocks-"));
  store = await testBackend().open({ kind: "pglite", dir: join(root, "tenant") }, { create: true });
  // The log: each operation's events in a row of `seq`, the head's `seq` its operation number.
  let seq = 1;
  const groups: [number, number][] = [];
  for (let b = 0; b < BATCHES; b++) {
    groups.push([seq, BATCH]);
    ops.batch.push(seq);
    seq += BATCH;
  }
  for (let i = 0; i < SINGLES; i++) {
    groups.push([seq, SINGLE]);
    ops.single.push(seq);
    seq += SINGLE;
  }
  await store.write(async (tx) => {
    for (const [op, n] of groups)
      await tx.query(
        `INSERT INTO events (seq, header, header_hash, type, actor, at, op)
         SELECT s, '{}', 'h', 'write.base', 'u_x', '2026-11-25T00:00:00.000Z', $1::bigint
         FROM generate_series($1::bigint, $1::bigint + $2::bigint - 1) AS s`,
        [op, n],
      );
    // Blocks: every fifth event's second block cleared by a deletion (body null).
    await tx.query(
      `INSERT INTO content (seq, path, body, checksum, removed_by)
       SELECT e.seq, 'b' || k,
              CASE WHEN e.seq % 5 = 0 AND k = 2 THEN NULL ELSE '{"k":' || k || ',"s":' || e.seq || '}' END,
              CASE WHEN e.seq % 5 = 0 AND k = 2 THEN NULL ELSE 'c' END,
              CASE WHEN e.seq % 5 = 0 AND k = 2 THEN 1 ELSE NULL END
       FROM events e, generate_series(1, ${BLOCKS}) AS k`,
    );
    await tx.query("ANALYZE events");
    await tx.query("ANALYZE content");
  });
});

afterAll(async () => {
  await store?.close();
  rmSync(root, { recursive: true, force: true });
});

/** What the receipt built from the joined statement: each event with its blocks by path. */
async function joined(op: number) {
  return store.read(async (tx) => {
    const evs = await tx.query<{ seq: unknown; type: string; op: unknown }>(
      "SELECT seq, type, op FROM events WHERE op = $1 ORDER BY seq",
      [op],
    );
    const blocks = await tx.query<{ seq: unknown; path: string; body: string | null }>(JOINED, [
      op,
    ]);
    const by = new Map<number, Record<string, unknown>>();
    for (const b of blocks.rows) {
      const m = by.get(Number(b.seq)) ?? Object.create(null);
      m[b.path] = JSON.parse(b.body as string);
      by.set(Number(b.seq), m);
    }
    return evs.rows.map((e) => ({
      header: { type: e.type, seq: Number(e.seq), op: Number(e.op) },
      blocks: by.get(Number(e.seq)) ?? {},
    }));
  });
}

/** Whether a plan (EXPLAIN's JSON) scans `content` in sequence anywhere. */
function scansContent(node: Record<string, unknown>): boolean {
  if (String(node["Node Type"]).includes("Seq Scan") && node["Relation Name"] === "content")
    return true;
  return ((node["Plans"] as Record<string, unknown>[] | undefined) ?? []).some(scansContent);
}

async function plan(sql: string, param: unknown): Promise<Record<string, unknown>> {
  const r = await store.read((tx) =>
    tx.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (FORMAT JSON) ${sql}`, [param] as never),
  );
  const raw = r.rows[0]?.["QUERY PLAN"];
  const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
    Plan: Record<string, unknown>;
  }[];
  return (parsed[0] as { Plan: Record<string, unknown> }).Plan;
}

describe("a receipt's events and their blocks", () => {
  it("are those the join on the operation gave, for every kind of operation", async () => {
    const some = [
      ...ops.batch.slice(0, 3),
      ...ops.single,
      // No event has this operation number.
      (ops.single[0] as number) + 1,
    ];
    let cleared = 0;
    for (const op of some) {
      const got = await store.read((tx) => operationEvents(tx, op as never));
      expect({ op, got }).toEqual({ op, got: await joined(op) });
      cleared += got.filter((e) => Object.keys(e.blocks).length === BLOCKS - 1).length;
    }
    // Blocks a deletion cleared were among them (and left out by both).
    expect(cleared).toBeGreaterThan(0);
  });

  it("are read on content's key, where the join scanned the whole of content", async () => {
    // A single write's operation and a batch's, as the planner estimates them on this log.
    for (const [label, op, n] of [
      ["single", ops.single[SINGLES - 1] as number, SINGLE],
      ["batch", ops.batch[BATCHES - 1] as number, BATCH],
    ] as const) {
      const seqs = Array.from({ length: n }, (_, i) => op + i);
      const now = await plan(BLOCKS_OF_EVENTS_SQL, seqs);
      expect({ label, scansContent: scansContent(now), plan: now }).toMatchObject({
        label,
        scansContent: false,
      });
    }
    // The witness: the join, for the batch on the same log and statistics, scans it.
    expect(scansContent(await plan(JOINED, ops.batch[BATCHES - 1]))).toBe(true);
  });
});
