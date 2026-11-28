// Some events' blocks are read by `content`'s primary key, one event at a time
// (kernel store/readable-content.ts `readableContentOf`, `rawContentOf`): the plan does not turn on
// the planner's estimate of how many blocks an event has. `content` is analyzed from a small
// sample, and on a large store that estimate was off by orders of magnitude: `seq = ANY` of a few
// thousand events then scanned the whole table. Here the estimate is set by hand
// (`n_distinct`) so that the plain `seq = ANY` read scans, as it did, and the two reads compared:
// the same rows, and the reads by key never scan `content`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLOCKS_OF_EVENTS_SQL,
  READABLE_CONTENT,
  rawContentOf,
  readableContentOf,
} from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgliteTenantStore } from "./backend.ts";
import { testBackend } from "./testing/test-backend.fixture.ts";

const T = 60_000;
const EVENTS = 20_000;
const PATHS = ["head", "target", "fields/f1/0", "fields/f2/0"];

let root: string;
let s: PgliteTenantStore;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "saveslot-content-by-seq-"));
  s = await testBackend({ analyze: "stale" }).open(
    { kind: "pglite", dir: join(root, "tenant") },
    { create: true },
  );
  await s.write(async (tx) => {
    // Blocks of stand-in events (no kernel event is read here, only `content`'s rows), stored out
    // of `seq` order, as a store with deletions and long histories comes to be: so that an index
    // scan over most of the table costs the planner more than reading it whole.
    await tx.query(
      `INSERT INTO content (seq, path, body, checksum)
       SELECT g, p, '{}', 'h' FROM generate_series(1, $1::int) g, unnest($2::text[]) p
       ORDER BY md5(g::text || p)`,
      [EVENTS, PATHS] as never,
    );
    // A cleared block: left out where the body is asked for.
    await tx.query(
      "UPDATE content SET body = NULL, checksum = NULL, removed_by = 1 WHERE seq = 11 AND path = 'target'",
    );
    // An estimate of 200 events where there are 20,000: each event taken for 400 blocks (it has 4).
    await tx.query("ALTER TABLE content ALTER COLUMN seq SET (n_distinct = 200)");
    await tx.query("ANALYZE content");
  });
}, T);

afterAll(async () => {
  await s?.close();
  rmSync(root, { recursive: true, force: true });
}, T);

/**
 * The plan of `sql` with `params`, as text. The cache the planner assumes is made smaller than the
 * table, as on a large store (`content` there was 4.8 GB): with a table that fits in it, the
 * planner takes even an index scan of all of it for cheap.
 */
const plan = (sql: string, params: unknown[]) =>
  s.read(async (tx) => {
    await tx.query("SET LOCAL effective_cache_size = '64kB'");
    const r = await tx.query<Record<string, string>>(`EXPLAIN ${sql}`, params as never);
    return r.rows.map((x) => Object.values(x)[0]).join("\n");
  });

const rows = (sql: string, params: unknown[]) =>
  s.read(async (tx) => (await tx.query(sql, params as never)).rows);

/** 2,000 events spread over the table, one of them twice, and one with no blocks. */
const SEQS = [...Array.from({ length: 2000 }, (_, i) => 1 + i * 10), 11, EVENTS + 5];

describe("blocks of some events, read by content's key", () => {
  it(
    "the plain seq = ANY read scans content on this estimate (what the reads by key avoid)",
    async () => {
      const p = await plan(
        `SELECT seq, path, body FROM ${READABLE_CONTENT} c WHERE seq = ANY($1) AND body IS NOT NULL ORDER BY seq, path COLLATE "C"`,
        [SEQS],
      );
      expect(p).toMatch(/Seq Scan on content/);
    },
    T,
  );

  it(
    "the receipt's read (BLOCKS_OF_EVENTS_SQL) looks up each event by the key, with the same rows",
    async () => {
      const p = await plan(BLOCKS_OF_EVENTS_SQL, [SEQS]);
      expect(p).not.toMatch(/Seq Scan on content/);
      expect(p).toMatch(/Index Scan on content_pkey|Index Scan using content_pkey/);
      const plain = await rows(
        `SELECT seq, path, body FROM ${READABLE_CONTENT} c WHERE seq = ANY($1) AND body IS NOT NULL ORDER BY seq, path COLLATE "C"`,
        [SEQS],
      );
      expect(plain.length).toBe(2000 * 4 - 1);
      expect(await rows(BLOCKS_OF_EVENTS_SQL, [SEQS])).toEqual(plain);
    },
    T,
  );

  it(
    "readableContentOf and rawContentOf give the rows of their seq = ANY reads, each once",
    async () => {
      for (const [by, plain] of [
        [readableContentOf("$1"), `${READABLE_CONTENT}`],
        [rawContentOf("$1"), "content"],
      ] as const) {
        const keyed = `SELECT * FROM ${by} c ORDER BY seq, path COLLATE "C"`;
        expect(await plan(keyed, [SEQS])).not.toMatch(/Seq Scan on content/);
        expect(await rows(keyed, [SEQS])).toEqual(
          await rows(
            `SELECT * FROM ${plain} c WHERE seq = ANY($1) ORDER BY seq, path COLLATE "C"`,
            [SEQS],
          ),
        );
      }
    },
    T,
  );

  it(
    "a condition on the block, given to the lookup, is applied inside it, with the same rows",
    async () => {
      for (const [by, plain] of [
        [readableContentOf("$1", "x.path = 'target'"), `${READABLE_CONTENT}`],
        [rawContentOf("$1", "x.path IN ('head', 'fields/f1/0')"), "content"],
      ] as const) {
        const where = by.includes("'target'")
          ? "path = 'target'"
          : "path IN ('head', 'fields/f1/0')";
        const keyed = `SELECT * FROM ${by} c ORDER BY seq, path COLLATE "C"`;
        const p = await plan(keyed, [SEQS]);
        expect(p).not.toMatch(/Seq Scan on content/);
        expect(p).toMatch(/Index Cond: \(\(seq = u\.seq\) AND \(path/);
        expect(await rows(keyed, [SEQS])).toEqual(
          await rows(
            `SELECT * FROM ${plain} c WHERE seq = ANY($1) AND ${where} ORDER BY seq, path COLLATE "C"`,
            [SEQS],
          ),
        );
      }
    },
    T,
  );

  it(
    "an empty list reads nothing",
    async () => {
      expect(await rows(BLOCKS_OF_EVENTS_SQL, [[]])).toEqual([]);
    },
    T,
  );
});
