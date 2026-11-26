// The planner's statistics of a local store (02-architecture §7 «本机存储»): PGlite runs PostgreSQL
// in single-user mode, with no autovacuum, so the store gathers them itself, at open and after a
// write, when the log has grown past what they last counted (db-worker.ts `stale`). ANALYZE
// changes no row: a failure or an interruption is reported and nothing else.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { PgliteTenantStore, StoreEvent } from "./backend.ts";
import { testBackend } from "./testing/test-backend.fixture.ts";

const roots: string[] = [];
function tenantDir(): string {
  const root = mkdtempSync(join(tmpdir(), "saveslot-analyze-"));
  roots.push(root);
  return join(root, "tenant");
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}, 120_000);

const ref = (dir: string) => ({ kind: "pglite", dir }) as const;

/** Each case opens stores and runs ANALYZE: seconds on a loaded machine, past Vitest's default. */
const T = 30_000;

type Seen = { event: StoreEvent; fields: Readonly<Record<string, string | number>> };

/** When each store event came, apart from what the cases compare. */
const times = new WeakMap<Seen, number>();

/**
 * A backend whose store events are kept in `seen`. "stale" unless asked otherwise, whatever the run
 * sets (SAVESLOT_TEST_ANALYZE): these cases are about when it runs.
 */
function backendSeeing(seen: Seen[], analyze: "stale" | "always" = "stale") {
  return testBackend({
    analyze,
    onEvent: (event, fields) => {
      seen.push({ event, fields });
      times.set(seen.at(-1) as Seen, performance.now());
    },
  });
}

/**
 * Appends `n` stand-in events to the log (the store's own table; no kernel event is read here),
 * and waits for what the write queued behind it unless `settle` is false.
 */
const append = async (s: PgliteTenantStore, n: number, settle = true) => {
  await s.write(async (tx) => {
    await tx.query(
      `INSERT INTO events (seq, header, header_hash, type, actor, at, op)
       SELECT e.last + g, '{}', 'h', 'write.base', 'u', '2026-01-01T00:00:00Z', e.last + g
       FROM (SELECT coalesce(max(seq), 0) AS last FROM events) e, generate_series(1, $1::int) g`,
      [n],
    );
  });
  if (settle) await settled(s);
};

/** What the planner knows of `events`: the rows it counted (-1: never), and its statistics rows. */
const statistics = (s: PgliteTenantStore) =>
  s.read(async (tx) => {
    const r = await tx.query<{ counted: number; rows: number }>(
      `SELECT c.reltuples::float8 AS counted,
         (SELECT count(*) FROM pg_statistic WHERE starelid = c.oid)::int AS rows
       FROM pg_class c WHERE c.oid = 'public.events'::regclass`,
    );
    return { counted: Number(r.rows[0]?.counted), rows: Number(r.rows[0]?.rows) };
  });

/** The log's last `seq`. */
const end = (s: PgliteTenantStore) =>
  s.read(async (tx) => {
    const r = await tx.query<{ n: number }>("SELECT coalesce(max(seq), 0)::int AS n FROM events");
    return Number(r.rows[0]?.n);
  });

/** Waits for what a write queued behind itself (its checkpoint, its ANALYZE): a read comes after. */
const settled = (s: PgliteTenantStore) => s.read(async () => {});

const analyzed = (seen: Seen[], at: "open" | "write") =>
  seen.filter((x) => x.event === "analyzed" && x.fields["at"] === at).length;

/**
 * A trip for ANALYZE: an expression index whose function reads a mode from a table and, on each row
 * ANALYZE samples, fails ('fail') or sleeps ('slow'). The mode is in a table, not the session, so it
 * holds across a reopen. Test-only objects; the stand-in rows here never meet a kernel read.
 */
const tripMode = async (s: PgliteTenantStore, mode: "fail" | "slow" | "") => {
  await s.write(async (tx) => {
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS analyze_trip_mode (mode text);
      CREATE OR REPLACE FUNCTION analyze_trip(v text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
      DECLARE m text := (SELECT mode FROM public.analyze_trip_mode LIMIT 1);
      BEGIN
        IF m = 'fail' THEN RAISE EXCEPTION 'analyze trip'; END IF;
        IF m = 'slow' THEN PERFORM pg_sleep(0.002); END IF;
        RETURN v;
      END $$;
    `);
    await tx.query("DELETE FROM analyze_trip_mode");
    await tx.query("INSERT INTO analyze_trip_mode VALUES ($1)", [mode]);
  });
  await settled(s);
};

/** Puts the trip on `content` (by path) or on a scratch table of its own, 2,000 rows (an index). */
const tripOn = async (s: PgliteTenantStore, table: "content" | "analyze_trip") => {
  await tripMode(s, "");
  await s.write(async (tx) => {
    if (table === "content") {
      // Statistics on an expression, not an index: ANALYZE with a column list (as content is
      // analyzed) skips expression indexes, but builds these.
      await tx.exec("CREATE STATISTICS content_trip ON (analyze_trip(path)) FROM content");
      return;
    }
    await tx.exec(`
      CREATE TABLE analyze_trip (v text);
      INSERT INTO analyze_trip SELECT g::text FROM generate_series(1, 2000) g;
      CREATE INDEX analyze_trip_v ON analyze_trip (analyze_trip(v));
    `);
  });
  await settled(s);
};

/** The worker requests posted while `f` runs, by kind, in order. */
async function posting<T>(f: (kinds: string[]) => Promise<T>): Promise<T> {
  const post = Worker.prototype.postMessage;
  const kinds: string[] = [];
  const spy = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    value: unknown,
  ) {
    kinds.push((value as { request: { kind: string } }).request.kind);
    post.call(this, value);
  });
  try {
    return await f(kinds);
  } finally {
    spy.mockRestore();
  }
}

describe("statistics gathered when stale", () => {
  it(
    "not at all while the log is under the threshold, then once after the write that passes it",
    async () => {
      const seen: Seen[] = [];
      const s = await backendSeeing(seen).open(ref(tenantDir()), { create: true });
      try {
        const start = await end(s);
        expect(start).toBeLessThan(50);
        expect(await statistics(s)).toMatchObject({ counted: -1 });
        await append(s, 50 - start);
        expect(analyzed(seen, "write")).toBe(0);
        expect(await statistics(s)).toMatchObject({ counted: -1, rows: 0 });
        await append(s, 1);
        expect(analyzed(seen, "write")).toBe(1);
        const st = await statistics(s);
        expect(st.counted).toBe(51);
        expect(st.rows).toBeGreaterThan(0);
      } finally {
        await s.close();
      }
      expect(seen.filter((x) => x.event !== "analyzed")).toEqual([]);
    },
    T,
  );

  it(
    "again only when the log has grown by 50 rows and a tenth of what was counted",
    async () => {
      const seen: Seen[] = [];
      const s = await backendSeeing(seen).open(ref(tenantDir()), { create: true });
      try {
        await append(s, 200 - (await end(s)));
        expect(analyzed(seen, "write")).toBe(1);
        expect((await statistics(s)).counted).toBe(200);
        // 200 + 50 + 20 = 270: at 270 not yet, at 271 again.
        await append(s, 70);
        expect(analyzed(seen, "write")).toBe(1);
        await append(s, 1);
        expect(analyzed(seen, "write")).toBe(2);
        expect((await statistics(s)).counted).toBe(271);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it(
    "not at open when the statistics are current (stale at open: the interrupted case below)",
    async () => {
      const dir = tenantDir();
      const first: Seen[] = [];
      const s = await backendSeeing(first).open(ref(dir), { create: true });
      await append(s, 300);
      await s.close();
      expect(analyzed(first, "write")).toBe(1);
      // Current: nothing at open.
      const second: Seen[] = [];
      const t = await backendSeeing(second).open(ref(dir));
      await t.close();
      expect(analyzed(second, "open")).toBe(0);
    },
    T,
  );
});

describe("a failure or an interruption leaves the store as it was", () => {
  it(
    "an ANALYZE that fails: the write stands, the failure is reported, the next check tries again",
    async () => {
      const seen: Seen[] = [];
      const s = await backendSeeing(seen).open(ref(tenantDir()), { create: true });
      try {
        await tripOn(s, "analyze_trip");
        await tripMode(s, "fail");
        await append(s, 100);
        expect(seen.filter((x) => x.event === "analyze_failed")).toEqual([
          { event: "analyze_failed", fields: { at: "write", code: "P0001" } },
        ]);
        expect(await end(s)).toBeGreaterThanOrEqual(100);
        // The tables before the failing one may have theirs; `events`, last, has none.
        expect((await statistics(s)).counted).toBe(-1);
        // Still stale: the next write's check runs it, and it goes through once the trip is off.
        await tripMode(s, "");
        expect(analyzed(seen, "write")).toBe(1);
        expect((await statistics(s)).counted).toBeGreaterThanOrEqual(100);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it(
    "an ANALYZE at open that fails: the store opens all the same, the failure is reported, the next check tries again",
    async () => {
      const dir = tenantDir();
      const s = await backendSeeing([]).open(ref(dir), { create: true });
      await tripOn(s, "analyze_trip");
      await tripMode(s, "fail");
      await append(s, 100);
      await s.close();
      const seen: Seen[] = [];
      const t = await backendSeeing(seen).open(ref(dir));
      try {
        expect(seen).toEqual([{ event: "analyze_failed", fields: { at: "open", code: "P0001" } }]);
        expect((await statistics(t)).counted).toBe(-1);
        await tripMode(t, "");
        expect(analyzed(seen, "write")).toBe(1);
        expect((await statistics(t)).counted).toBeGreaterThanOrEqual(100);
      } finally {
        await t.close();
      }
    },
    T,
  );

  it(
    "after the write's reply: the write's caller has its result while the ANALYZE is still to come",
    async () => {
      const seen: Seen[] = [];
      const s = await backendSeeing(seen).open(ref(tenantDir()), { create: true });
      try {
        await tripOn(s, "analyze_trip");
        await tripMode(s, "slow");
        await append(s, 100, false);
        const replied = performance.now();
        expect(seen.filter((x) => x.event === "analyzed")).toEqual([]);
        await settled(s);
        const ran = seen.filter((x) => x.event === "analyzed");
        expect(ran.length).toBe(1);
        expect(times.get(ran[0] as Seen)).toBeGreaterThan(replied);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it(
    "an ANALYZE stopped half way by the end of the process: the store opens, and is analyzed then",
    async () => {
      const dir = tenantDir();
      const seen: Seen[] = [];
      const s = await backendSeeing(seen).open(ref(dir), { create: true });
      await tripOn(s, "analyze_trip");
      await tripMode(s, "slow");
      const rows = (await end(s)) + 100;
      await posting(async (kinds) => {
        await append(s, 100, false);
        // The write's ANALYZE is queued behind it and takes seconds ('slow'). Stopped only once it
        // has been sent to the worker and has not answered: under way, not yet to start.
        const until = performance.now() + 10_000;
        while (!kinds.includes("analyze") && performance.now() < until)
          await new Promise((r) => setTimeout(r, 10));
        expect(kinds).toContain("analyze");
        await new Promise((r) => setTimeout(r, 100));
        expect(seen.filter((x) => x.event === "analyzed" || x.event === "analyze_failed")).toEqual(
          [],
        );
        await s.terminateWorker();
      });
      await s.close();
      expect(seen.filter((x) => x.event === "analyzed")).toEqual([]);

      const after: Seen[] = [];
      const t = await backendSeeing(after).open(ref(dir));
      try {
        expect(analyzed(after, "open")).toBe(1);
        expect(after.filter((x) => x.event === "analyze_failed")).toEqual([]);
        expect(await end(t)).toBe(rows);
        expect((await statistics(t)).counted).toBe(rows);
      } finally {
        await t.close();
      }
    },
    T,
  );
});

describe("always (tests looking for an order a query does not fix)", () => {
  it(
    "after every write and at every open",
    async () => {
      const dir = tenantDir();
      const seen: Seen[] = [];
      const s = await backendSeeing(seen, "always").open(ref(dir), { create: true });
      await append(s, 1);
      await append(s, 1);
      await s.close();
      expect(analyzed(seen, "open")).toBe(1);
      expect(analyzed(seen, "write")).toBe(2);
    },
    T,
  );
});

describe("content, with a lower statistics target", () => {
  /** The session's statistics target, and how many histogram bounds `content.path` got. */
  const target = (s: PgliteTenantStore) =>
    s.read(async (tx) => {
      const t = await tx.query<{ v: string }>(
        "SELECT current_setting('default_statistics_target') AS v",
      );
      const h = await tx.query<{ n: number | null }>(
        `SELECT array_length(histogram_bounds::text::text[], 1) AS n FROM pg_stats
         WHERE schemaname = 'public' AND tablename = 'content' AND attname = 'path'`,
      );
      return { session: t.rows[0]?.v, bounds: h.rows[0]?.n ?? null };
    });
  /** 5,000 stand-in blocks of distinct paths (the store's own table; no kernel read here). */
  const blocks = (s: PgliteTenantStore) =>
    s.write(async (tx) => {
      await tx.query(
        `INSERT INTO content (seq, path, body, checksum)
         SELECT 1, 'p/' || lpad(g::text, 5, '0'), '{}', 'c' FROM generate_series(1, 5000) g`,
      );
    });

  it(
    "content gets at most 11 histogram bounds (target 10); the session is back at the default after",
    async () => {
      const s = await backendSeeing([]).open(ref(tenantDir()), { create: true });
      try {
        await blocks(s);
        await append(s, 100);
        const r = await target(s);
        expect(r.session).toBe("100");
        expect(r.bounds).not.toBeNull();
        expect(r.bounds).toBeLessThanOrEqual(11);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it(
    "an ANALYZE of content that fails: reported, and the session is at the default target right after",
    async () => {
      const seen: Seen[] = [];
      const s = await backendSeeing(seen).open(ref(tenantDir()), { create: true });
      try {
        await blocks(s);
        // The trip on content only: the other tables go through, content's own transaction fails.
        await tripOn(s, "content");
        await tripMode(s, "fail");
        await append(s, 100);
        expect(seen.filter((x) => x.event === "analyze_failed")).toEqual([
          { event: "analyze_failed", fields: { at: "write", code: "P0001" } },
        ]);
        expect((await target(s)).session).toBe("100");
        expect((await statistics(s)).counted).toBe(-1);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it(
    "no statistics of content.body or events.header (samples of the user's content); the others, and the row counts",
    async () => {
      const s = await backendSeeing([]).open(ref(tenantDir()), { create: true });
      try {
        await s.write(async (tx) => {
          await tx.query(
            `INSERT INTO content (seq, path, body, checksum)
             SELECT 1, 'p/' || lpad(g::text, 5, '0'), '{"memo":"PRIVATE-' || (g % 3) || '"}', 'c'
             FROM generate_series(1, 5000) g`,
          );
          await tx.query(
            `INSERT INTO events (seq, header, header_hash, type, actor, at, op)
             SELECT e.last + g, '{"note":"PRIVATE-' || (g % 3) || '"}', 'h', 'write.base', 'u',
               '2026-01-01T00:00:00Z', e.last + g
             FROM (SELECT coalesce(max(seq), 0) AS last FROM events) e, generate_series(1, 100) g`,
          );
        });
        await settled(s);
        const r = await s.read(async (tx) => {
          const cols = await tx.query<{ c: string }>(
            `SELECT c.relname || '.' || a.attname AS c FROM pg_statistic st
             JOIN pg_class c ON c.oid = st.starelid
             JOIN pg_attribute a ON a.attrelid = st.starelid AND a.attnum = st.staattnum
             WHERE c.relname IN ('content', 'events') ORDER BY 1`,
          );
          const counted = await tx.query<{ relname: string; n: number }>(
            "SELECT relname, reltuples::float8 AS n FROM pg_class WHERE relname IN ('content', 'events')",
          );
          return { cols: cols.rows.map((x) => x.c), counted: counted.rows };
        });
        expect(r.cols).not.toContain("content.body");
        expect(r.cols).not.toContain("events.header");
        expect(r.cols).toEqual(
          expect.arrayContaining(["content.path", "content.seq", "events.type"]),
        );
        for (const x of r.counted) expect(Number(x.n), x.relname).toBeGreaterThanOrEqual(100);
      } finally {
        await s.close();
      }
    },
    T,
  );
});

describe("what the statistics change", () => {
  // The latest restore or import (ops: the restore count): with no statistics the planner walks
  // the whole key of `events` backwards looking for one, with them it takes `events_type`. 5,000
  // rows: past where the plan turns (about 1,000 rows), and under ANALYZE's sample of 30,000 rows
  // a table, so the statistics are read from every row, not drawn.
  const LATEST_RESTORE =
    "SELECT seq, header FROM events WHERE type IN ('tenant.restored', 'tenant.imported') ORDER BY seq DESC LIMIT 1";
  const plan = (rows: readonly Record<string, unknown>[]) =>
    rows.map((r) => String(r["QUERY PLAN"])).join("\n");

  it(
    "the latest restore is looked up by type once the store has statistics",
    async () => {
      const s = await testBackend({ analyze: "stale" }).open(ref(tenantDir()), { create: true });
      try {
        // The plan without statistics is read in the write itself: its commit is followed by the
        // check that gathers them.
        const before = await s.write(async (tx) => {
          await tx.query(
            `INSERT INTO events (seq, header, header_hash, type, actor, at, op)
           SELECT g, '{}', 'h', (ARRAY['write.head', 'write.base', 'source'])[g % 3 + 1], 'u',
             '2026-01-01T00:00:00Z', g
           FROM generate_series((SELECT coalesce(max(seq), 0) FROM events) + 1, 5000) g`,
          );
          return plan((await tx.query(`EXPLAIN ${LATEST_RESTORE}`)).rows);
        });
        await settled(s);
        const after = await s.read(async (tx) =>
          plan((await tx.query(`EXPLAIN ${LATEST_RESTORE}`)).rows),
        );
        expect(before).toContain("Index Scan Backward using events_pkey on events");
        expect(before).not.toContain("events_type");
        expect(after).toContain("Index Scan using events_type on events");
      } finally {
        await s.close();
      }
    },
    T,
  );
});
