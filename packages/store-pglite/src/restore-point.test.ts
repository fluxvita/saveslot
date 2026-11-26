// The latest restore or import (kernel store/restore-point.ts): the statement does not depend on
// the planner's guess of how rare the two event types are. With statistics that miss them (a rare
// type left out of the most common values, as ANALYZE's sample can leave it), `… ORDER BY seq DESC
// LIMIT 1` walks the whole key of `events` backwards; the statement used takes `events_type`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ReadTx, restorePoint } from "@fluxvita/saveslot-kernel";
import { afterAll, describe, expect, it } from "vitest";
import { testBackend } from "./testing/test-backend.fixture.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}, 120_000);

const plan = (rows: readonly Record<string, unknown>[]) =>
  rows.map((r) => String(r["QUERY PLAN"])).join("\n");

/** `tx`, keeping each statement it is asked to run. */
function recording(tx: ReadTx, seen: { sql: string; params: readonly unknown[] }[]): ReadTx {
  return {
    ...tx,
    query: (async (sql: string, params?: readonly unknown[]) => {
      seen.push({ sql, params: params ?? [] });
      return tx.query(sql, params as never);
    }) as ReadTx["query"],
  };
}

describe("the latest restore or import, whatever the statistics say of the two types", () => {
  it("takes events_type where `ORDER BY seq DESC LIMIT 1` walks the key, and finds the latest", async () => {
    const root = mkdtempSync(join(tmpdir(), "saveslot-restore-point-"));
    roots.push(root);
    const s = await testBackend().open(
      { kind: "pglite", dir: join(root, "tenant") },
      { create: true },
    );
    try {
      await s.write(async (tx) => {
        // 5,000 stand-in events (no kernel read of them here): two common types, one at 2 %, and
        // two restores. Statistics on `type` with room for the two most common values only: the
        // others are left to a guess, as when the sample misses a rare type.
        await tx.query(
          `INSERT INTO events (seq, header, header_hash, type, actor, at, op)
           SELECT g, CASE g WHEN 1000 THEN '{"restore_count":1,"restored_to":900}'
                            WHEN 3000 THEN '{"restore_count":2,"restored_to":2900}' ELSE '{}' END,
             'h',
             CASE WHEN g IN (1000, 3000) THEN 'tenant.restored' WHEN g % 50 = 25 THEN 'write.head'
                  WHEN g % 2 = 0 THEN 'write.base' ELSE 'source.recorded' END,
             'u', '2026-01-01T00:00:00Z', g
           FROM generate_series((SELECT coalesce(max(seq), 0) FROM events) + 1, 5000) g`,
        );
        await tx.exec("ALTER TABLE events ALTER COLUMN type SET STATISTICS 2");
        await tx.exec("ANALYZE events");
      });
      await s.read(async (tx) => {
        // The guess goes wrong here: the old form walks the key.
        const old = plan(
          (
            await tx.query(
              "EXPLAIN SELECT seq, header FROM events WHERE type IN ('tenant.restored', 'tenant.imported') ORDER BY seq DESC LIMIT 1",
            )
          ).rows,
        );
        expect(old).toContain("Index Scan Backward using events_pkey on events");

        const seen: { sql: string; params: readonly unknown[] }[] = [];
        const latest = await restorePoint(recording(tx, seen));
        expect(latest).toEqual({ restoreCount: 2, seq: 3000, point: 2900 });
        const before = await restorePoint(recording(tx, seen), { before: 3000 as never });
        expect(before).toEqual({ restoreCount: 1, seq: 1000, point: 900 });
        expect(seen.length).toBe(2);
        for (const q of seen) {
          const p = plan((await tx.query(`EXPLAIN ${q.sql}`, q.params as never)).rows);
          expect(p, q.sql).toContain("events_type");
          expect(p, q.sql).not.toContain("events_pkey");
        }
      });
    } finally {
      await s.close();
    }
  }, 60_000);
});
