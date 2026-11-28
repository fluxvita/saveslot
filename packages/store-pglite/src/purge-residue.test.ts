// The in-place residue clean-up on PGlite (02-architecture §7 «残留清理的做法»): after it, a byte
// search of the store's directory finds none of the deleted text; with any one step left out, it
// finds some (each step has its control, as in experiment 7).

import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PgliteBackend, type PgliteBackendOptions, type PgliteTenantStore } from "./backend.ts";
import { PgliteStoreError } from "./errors.ts";
import { newToken, writeOwner } from "./owner.ts";
import type { MaintainStep } from "./protocol.ts";

const T = 120_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}, 120_000);

function tenantDir(): string {
  const root = mkdtempSync(join(tmpdir(), "saveslot-purge-"));
  roots.push(root);
  return join(root, "tenant");
}

/** Every file under `dir` holding `marker`, by path relative to it. */
function filesWith(dir: string, marker: string): string[] {
  const needle = Buffer.from(marker);
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && readFileSync(p).includes(needle)) out.push(p.slice(dir.length + 1));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * A store with a table `notes`: a row holding `marker` once, and 300 rows holding it as the most
 * common value of their column, so that ANALYZE puts it into `pg_statistic`; analyzed, then all of
 * them deleted, as a physical deletion would. The store is left open.
 */
async function deletedMarker(
  opts: Pick<PgliteBackendOptions, "purgeSteps"> = {},
): Promise<{ dir: string; marker: string; store: PgliteTenantStore }> {
  const dir = tenantDir();
  const marker = `XRESIDUE_${randomBytes(12).toString("hex")}`;
  const store = await new PgliteBackend({ durability: "host-fsync", ...opts }).open(
    { kind: "pglite", dir },
    { create: true },
  );
  await store.write(async (tx) => {
    await tx.exec("CREATE TABLE notes (id serial PRIMARY KEY, body text)");
    await tx.exec(`INSERT INTO notes (body) VALUES ('${marker} once')`);
    await tx.exec(`INSERT INTO notes (body) SELECT '${marker}' FROM generate_series(1, 300)`);
    await tx.exec(
      "INSERT INTO notes (body) SELECT md5(random()::text) FROM generate_series(1, 2000)",
    );
    await tx.exec("ANALYZE notes");
  });
  await store.write((tx) => tx.exec(`DELETE FROM notes WHERE position('XRESIDUE_' in body) > 0`));
  return { dir, marker, store };
}

describe("purgeResidue on PGlite", () => {
  it(
    "every step: the deleted text is found before the clean-up and nowhere after it",
    async () => {
      const before = await deletedMarker();
      await before.store.close();
      expect(filesWith(before.dir, before.marker).length).toBeGreaterThan(0);

      const { dir, marker, store } = await deletedMarker();
      expect(await store.purgeResidue(["notes"])).toEqual({ ok: true });
      await store.close();
      expect(filesWith(dir, marker)).toEqual([]);
    },
    T,
  );

  const without = (left: readonly MaintainStep["op"][]) => (steps: readonly MaintainStep[]) =>
    steps.filter((s) => !left.includes(s.op));
  it.each([
    ["the table rewritten", ["rewrite"]],
    ["the statistics rewritten", ["rewrite_statistics"]],
    ["the write-ahead log (checkpoints and the segment switch)", ["checkpoint", "switch_wal"]],
  ] as const)(
    "without %s, the deleted text is still found",
    async (_, left) => {
      const { dir, marker, store } = await deletedMarker({ purgeSteps: without(left) });
      await store.purgeResidue(["notes"]);
      await store.close();
      expect(filesWith(dir, marker).length).toBeGreaterThan(0);
    },
    T,
  );

  it(
    "a name that is not one of the store's tables: refused, no step runs",
    async () => {
      const sent: string[] = [];
      const { store } = await deletedMarker({
        purgeSteps: (steps) => {
          sent.push(...steps.map((s) => s.op));
          return steps;
        },
      });
      try {
        await expect(store.purgeResidue(["notes", "pg_class"])).rejects.toThrow(
          /not tables of this store: pg_class/,
        );
        expect(sent).toEqual([]);
      } finally {
        await store.close();
      }
    },
    T,
  );

  it(
    "after the storage changed hands: refused (ownership_lost), the worker not asked",
    async () => {
      const { dir, store } = await deletedMarker();
      try {
        writeOwner(dir, { token: newToken(), startedAt: new Date().toISOString(), epoch: null });
        const e = await store.purgeResidue(["notes"]).catch((x: unknown) => x);
        expect(e instanceof PgliteStoreError ? e.code : e).toBe("ownership_lost");
      } finally {
        await store.close();
      }
    },
    T,
  );

  it(
    "a step that fails ends the worker: worker_failed",
    async () => {
      // The table dropped between the check of the names and its rewrite.
      let store: PgliteTenantStore | undefined;
      const r = await deletedMarker({
        purgeSteps: (steps) => {
          void store?.write((tx) => tx.exec("DROP TABLE notes"));
          return steps;
        },
      });
      store = r.store;
      try {
        const e = await store.purgeResidue(["notes"]).catch((x: unknown) => x);
        expect(e instanceof PgliteStoreError ? e.code : e).toBe("worker_failed");
        const after = await store.read(async () => 1).catch((x: unknown) => x);
        expect(after instanceof PgliteStoreError ? after.code : after).toBe("worker_failed");
      } finally {
        await store.close();
      }
    },
    T,
  );
});
