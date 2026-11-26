// The in-place upgrade of a store on a PostgreSQL server (02-architecture §8 «格式版本、导出、导入与恢复»;
// kernel store/upgrade.ts): opened by a version of a later format, a store is upgraded once the
// ownership epoch is taken, each step a write transaction under the tenant's lock whose last
// statement sets the format. The kernel has no step yet (format 5 is the only one); these cases give
// the backend a format and steps of their own (PostgresBackendOptions `formatUpgrade`).

import { META_KEYS, STORAGE_FORMAT_VERSION, type UpgradeStep } from "@fluxvita/saveslot-kernel";
import { describe, expect, it } from "vitest";
import { PostgresBackend, type PostgresTenantStore } from "./backend.ts";
import { PostgresStoreError } from "./errors.ts";
import { CELL, testCell, testPostgres } from "./testing/test-postgres.fixture.ts";

const T = 60_000;
const F = STORAGE_FORMAT_VERSION;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PostgresStoreError) return e.code;
    throw e;
  }
  return "no error";
}

const step = (from: number, sql: string): UpgradeStep => ({ from, sql });

type Seen = {
  event: string;
  fields: Readonly<Record<string, string | number>>;
};

const cell = testCell();

describe.skipIf(cell === undefined)("against a server", () => {
  const pg = testPostgres(cell);

  /** A backend of format `format` with `steps`, its events kept in `seen`. */
  const backend = (seen: Seen[] = [], format?: number, steps: readonly UpgradeStep[] = []) =>
    new PostgresBackend({
      cells: { [CELL]: pg.cell },
      ...(format !== undefined ? { formatUpgrade: { format, steps } } : {}),
      onEvent: (event, fields) => {
        seen.push({ event, fields });
      },
    });

  /** A new store of the kernel's format, closed. */
  async function made(): Promise<string> {
    const db = pg.name();
    const s = await pg.backend.open(pg.ref(db), { create: true });
    await s.close();
    return db;
  }

  const formatIn = async (db: string) =>
    Number(
      (await pg.sql(db, "SELECT value FROM meta WHERE key = $1", [META_KEYS.storageFormat]))
        .rows[0]?.["value"],
    );

  const tablesIn = async (db: string) =>
    (
      await pg.sql(
        db,
        "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'up\\_%' ORDER BY 1",
      )
    ).rows.map((r) => r["t"]);

  const closing = async (s: PostgresTenantStore | undefined) => {
    await s?.close();
  };

  describe("a store of an older format is upgraded when opened", () => {
    it(
      "one step: upgraded before the store is returned; opened again, nothing to do",
      async () => {
        const db = await made();
        const seen: Seen[] = [];
        const s = await backend(seen, F + 1, [
          step(F, "CREATE TABLE up_a (x int); INSERT INTO up_a VALUES (1);"),
        ]).open(pg.ref(db), {});
        try {
          expect(s.formatVersion).toBe(F + 1);
          expect(await formatIn(db)).toBe(F + 1);
          expect(await tablesIn(db)).toEqual(["up_a"]);
        } finally {
          await s.close();
        }
        expect(seen.map((x) => x.event)).toEqual(["upgrading", "upgrade_step", "upgraded"]);
        expect(seen[0]?.fields).toEqual({ database: db, from: F, to: F + 1 });
        expect(seen[1]?.fields).toEqual({ database: db, from: F, to: F + 1 });
        expect(seen[2]?.fields).toMatchObject({ database: db, from: F, to: F + 1 });
        const again: Seen[] = [];
        const t = await backend(again, F + 1, [step(F, "SELECT 1/0")]).open(pg.ref(db), {});
        await t.close();
        expect(again).toEqual([]);
      },
      T,
    );

    it(
      "two steps, one after the other",
      async () => {
        const db = await made();
        const s = await backend([], F + 2, [
          step(F + 1, "CREATE TABLE up_c (x int REFERENCES up_b (x));"),
          step(F, "CREATE TABLE up_b (x int PRIMARY KEY);"),
        ]).open(pg.ref(db), {});
        await s.close();
        expect(await formatIn(db)).toBe(F + 2);
        expect(await tablesIn(db)).toEqual(["up_b", "up_c"]);
      },
      T,
    );
  });

  describe("an upgrade that fails leaves the store of the format of its last step done", () => {
    it(
      "the second of two steps fails: upgrade_failed, the first stays done; the open after goes on from there",
      async () => {
        const db = await made();
        const first = step(F, "CREATE TABLE up_d (x int);");
        const failed = await backend([], F + 2, [
          first,
          step(F + 1, "CREATE TABLE up_e (x int); SELECT 1/0;"),
        ])
          .open(pg.ref(db), {})
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(failed).toBeInstanceOf(PostgresStoreError);
        expect((failed as PostgresStoreError).code).toBe("upgrade_failed");
        // The database's own SQLSTATE (division_by_zero), and the step in the message.
        expect((failed as PostgresStoreError).sqlState).toBe("22012");
        expect((failed as PostgresStoreError).message).toContain(`format ${F + 1} to ${F + 2}`);
        expect(await formatIn(db)).toBe(F + 1);
        expect(await tablesIn(db)).toEqual(["up_d"]);
        const s = await backend([], F + 2, [first, step(F + 1, "CREATE TABLE up_e (x int);")]).open(
          pg.ref(db),
          {},
        );
        await s.close();
        expect(await formatIn(db)).toBe(F + 2);
        expect(await tablesIn(db)).toEqual(["up_d", "up_e"]);
      },
      T,
    );

    it(
      "a format older than any released version wrote is refused: format_too_old",
      async () => {
        const db = await made();
        await pg.sql(db, "UPDATE meta SET value = $1 WHERE key = $2", [
          String(F - 1),
          META_KEYS.storageFormat,
        ]);
        expect(
          await codeOf(backend([], F + 1, [step(F - 1, ""), step(F, "")]).open(pg.ref(db), {})),
        ).toBe("format_too_old");
      },
      T,
    );

    it(
      "a step that controls its transaction (a COMMIT half way) is refused; the store stays as it was",
      async () => {
        const db = await made();
        const failed = await backend([], F + 1, [
          step(F, "CREATE TABLE up_t (x int); COMMIT; CREATE TABLE up_u (x int);"),
        ])
          .open(pg.ref(db), {})
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(String(failed)).toContain(
          "the step from format 5 controls its transaction (COMMIT)",
        );
        expect(await formatIn(db)).toBe(F);
        expect(await tablesIn(db)).toEqual([]);
      },
      T,
    );

    it(
      "both too old and of other session settings: format_too_old (the format is checked first)",
      async () => {
        const db = await made();
        await pg.sql(db, "UPDATE meta SET value = $1 WHERE key = $2", [
          String(F - 1),
          META_KEYS.storageFormat,
        ]);
        await pg.sql(db, "UPDATE meta SET value = $1 WHERE key = $2", [
          JSON.stringify(["SET TIME ZONE 'Asia/Shanghai'"]),
          META_KEYS.sessionSettings,
        ]);
        expect(
          await codeOf(backend([], F + 1, [step(F - 1, ""), step(F, "")]).open(pg.ref(db), {})),
        ).toBe("format_too_old");
      },
      T,
    );
  });

  describe("one writer", () => {
    it(
      "an older version holding the store gives it up at its next write once a newer one upgraded it",
      async () => {
        const db = await made();
        const old = await pg.backend.open(pg.ref(db), {});
        let next: PostgresTenantStore | undefined;
        try {
          await old.write((tx) => tx.exec("CREATE TABLE up_h (x int)"));
          next = await backend([], F + 1, [step(F, "CREATE TABLE up_i (x int);")]).open(
            pg.ref(db),
            {},
          );
          expect(await codeOf(old.write((tx) => tx.query("INSERT INTO up_h VALUES (1)")))).toBe(
            "ownership_lost",
          );
          expect(await formatIn(db)).toBe(F + 1);
          expect((await pg.sql(db, "SELECT count(*)::int4 AS n FROM up_h")).rows[0]?.["n"]).toBe(0);
        } finally {
          await closing(next);
          await old.close();
        }
      },
      T,
    );

    it(
      "an older version waiting on the lock while a newer one is in its step: format_too_new, the epoch untouched; the newer goes on",
      async () => {
        const db = await made();
        const epochIn = async () =>
          Number(
            (await pg.sql(db, "SELECT value FROM meta WHERE key = $1", [META_KEYS.ownershipEpoch]))
              .rows[0]?.["value"],
          );
        const newer = backend([], F + 1, [
          step(F, "SELECT pg_sleep(1.5); CREATE TABLE up_l (x int);"),
        ])
          .open(pg.ref(db), {})
          .then(
            (s) => s,
            (e: unknown) => e,
          );
        const activity = async (where: string) =>
          (
            await pg.admin(
              `SELECT count(*)::int4 AS n FROM pg_stat_activity WHERE datname = $1 AND ${where}`,
              [db],
            )
          ).rows[0]?.["n"];
        for (let i = 0; i < 200 && (await activity("query LIKE 'SELECT pg_sleep%'")) !== 1; i++) {
          await new Promise((r) => setTimeout(r, 20));
        }
        // The older version (the kernel's format, no step) reads format F without the lock, then
        // waits on the lock the newer one's step holds.
        const older = pg.backend.open(pg.ref(db), {}).then(
          (s) => s,
          (e: unknown) => e,
        );
        let waited = false;
        for (let i = 0; i < 200 && !waited; i++) {
          waited = (await activity("wait_event_type = 'Lock' AND wait_event = 'advisory'")) === 1;
          if (!waited) await new Promise((r) => setTimeout(r, 20));
        }
        expect(waited).toBe(true);
        expect(await activity("query LIKE 'SELECT pg_sleep%'")).toBe(1);
        const n = await newer;
        const o = await older;
        expect(n).not.toBeInstanceOf(Error);
        const s = n as PostgresTenantStore;
        try {
          expect(o).toBeInstanceOf(PostgresStoreError);
          expect((o as PostgresStoreError).code).toBe("format_too_new");
          expect(await epochIn()).toBe(s.epoch);
          expect(await formatIn(db)).toBe(F + 1);
          await s.write((tx) => tx.query("INSERT INTO up_l VALUES (1)"));
        } finally {
          await s.close();
        }
      },
      T,
    );

    it(
      "a second opener while the first is in a step: the step is done once; the first gives up, the second goes on",
      async () => {
        const db = await made();
        // The first step is slow, and fails when done twice (the second CREATE TABLE of a name).
        const steps = [
          step(F, "SELECT pg_sleep(1.5); CREATE TABLE up_j (x int);"),
          step(F + 1, "CREATE TABLE up_k (x int);"),
        ];
        const first = backend([], F + 2, steps)
          .open(pg.ref(db), {})
          .then(
            (s) => s,
            (e: unknown) => e,
          );
        // The first is in its step: the second reads the format before it is done (the format
        // still F), takes the epoch once the step has committed, and finds the step done.
        for (let i = 0; i < 200; i++) {
          const r = await pg.admin(
            "SELECT count(*)::int4 AS n FROM pg_stat_activity WHERE datname = $1 AND query LIKE 'SELECT pg_sleep%'",
            [db],
          );
          if (r.rows[0]?.["n"] === 1) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        const second = await backend([], F + 2, steps).open(pg.ref(db), {});
        try {
          const a = await first;
          expect(a).toBeInstanceOf(PostgresStoreError);
          expect((a as PostgresStoreError).code).toBe("ownership_lost");
          expect(await formatIn(db)).toBe(F + 2);
          expect(await tablesIn(db)).toEqual(["up_j", "up_k"]);
          await second.write((tx) => tx.query("INSERT INTO up_j VALUES (1)"));
        } finally {
          await second.close();
        }
      },
      T,
    );
  });
});
