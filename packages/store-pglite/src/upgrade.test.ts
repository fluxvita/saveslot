// The in-place upgrade of a local store (02-architecture §8 «格式版本、导出、导入与恢复»;
// kernel store/upgrade.ts): opened by a version of a later format, a store is upgraded step by step
// before it is returned, each step in a transaction of its own whose last statement sets the format.
// The kernel has no step yet (format 5 is the only one); these cases give the backend a format and
// steps of their own (PgliteBackendOptions `formatUpgrade`).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { META_KEYS, STORAGE_FORMAT_VERSION, type UpgradeStep } from "@fluxvita/saveslot-kernel";
import { afterAll, describe, expect, it } from "vitest";
import type { PgliteTenantStore, StoreEvent } from "./backend.ts";
import { PgliteStoreError } from "./errors.ts";
import { testBackend } from "./testing/test-backend.fixture.ts";

const T = 60_000;
const roots: string[] = [];
function tenantDir(): string {
  const root = mkdtempSync(join(tmpdir(), "saveslot-upgrade-"));
  roots.push(root);
  return join(root, "tenant");
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}, 120_000);

const ref = (dir: string) => ({ kind: "pglite", dir }) as const;
const F = STORAGE_FORMAT_VERSION;

type Seen = { event: StoreEvent; fields: Readonly<Record<string, string | number>> };

/** A backend of format `format` with `steps`, its store events kept in `seen`. */
const backend = (seen: Seen[], format?: number, steps: readonly UpgradeStep[] = []) =>
  testBackend({
    analyze: "stale",
    ...(format !== undefined ? { formatUpgrade: { format, steps } } : {}),
    onEvent: (event, fields) => {
      seen.push({ event, fields });
    },
  });

/** A new store of the kernel's format, closed. */
async function made(): Promise<string> {
  const dir = tenantDir();
  const s = await backend([]).open(ref(dir), { create: true });
  await s.close();
  return dir;
}

const formatOf = (s: PgliteTenantStore) =>
  s.read(async (tx) => {
    const r = await tx.query<{ value: string }>("SELECT value FROM meta WHERE key = $1", [
      META_KEYS.storageFormat,
    ]);
    return Number(r.rows[0]?.value);
  });

const tables = (s: PgliteTenantStore) =>
  s.read(async (tx) => {
    const r = await tx.query<{ t: string }>(
      "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'up\\_%' ORDER BY 1",
    );
    return r.rows.map((x) => x.t);
  });

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PgliteStoreError) return e.code;
    throw e;
  }
  return "no error";
}

const step = (from: number, sql: string): UpgradeStep => ({ from, sql });

describe("a store of an older format is upgraded when opened", () => {
  it(
    "one step: upgraded before the store is returned, then analyzed; opened again, nothing to do",
    async () => {
      const dir = await made();
      const seen: Seen[] = [];
      const b = backend(seen, F + 1, [
        step(F, "CREATE TABLE up_a (x int); INSERT INTO up_a VALUES (1);"),
      ]);
      const s = await b.open(ref(dir));
      try {
        expect(s.formatVersion).toBe(F + 1);
        expect(await formatOf(s)).toBe(F + 1);
        expect(await tables(s)).toEqual(["up_a"]);
      } finally {
        await s.close();
      }
      expect(seen.map((x) => x.event)).toEqual([
        "upgrading",
        "upgrade_step",
        "upgraded",
        "analyzed",
      ]);
      expect(seen[0]?.fields).toEqual({ from: F, to: F + 1 });
      expect(seen[1]?.fields).toEqual({ from: F, to: F + 1 });
      expect(seen[2]?.fields).toMatchObject({ from: F, to: F + 1 });
      expect(seen[3]?.fields).toMatchObject({ at: "upgrade" });
      const again: Seen[] = [];
      const t = await backend(again, F + 1, [step(F, "SELECT 1/0")]).open(ref(dir));
      await t.close();
      expect(again.map((x) => x.event)).not.toContain("upgrading");
    },
    T,
  );

  it(
    "two steps, one after the other, each said before it is done; analyzed once, after the last",
    async () => {
      const dir = await made();
      const seen: Seen[] = [];
      const s = await backend(seen, F + 2, [
        step(F + 1, "CREATE TABLE up_c (x int REFERENCES up_b (x));"),
        step(F, "CREATE TABLE up_b (x int PRIMARY KEY);"),
      ]).open(ref(dir));
      try {
        expect(await formatOf(s)).toBe(F + 2);
        expect(await tables(s)).toEqual(["up_b", "up_c"]);
      } finally {
        await s.close();
      }
      expect(seen.map((x) => [x.event, x.fields["from"], x.fields["to"]])).toEqual([
        ["upgrading", F, F + 2],
        ["upgrade_step", F, F + 1],
        ["upgrade_step", F + 1, F + 2],
        ["upgraded", F, F + 2],
        ["analyzed", undefined, undefined],
      ]);
    },
    T,
  );
});

describe("an upgrade that fails leaves the store of the format of its last step done", () => {
  it(
    "the second of two steps fails: upgrade_failed, the first stays done; the open after goes on from there",
    async () => {
      const dir = await made();
      const first = step(F, "CREATE TABLE up_d (x int);");
      const failed = await backend([], F + 2, [
        first,
        step(F + 1, "CREATE TABLE up_e (x int); SELECT 1/0;"),
      ])
        .open(ref(dir))
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(failed).toBeInstanceOf(PgliteStoreError);
      expect((failed as PgliteStoreError).code).toBe("upgrade_failed");
      // The database's own SQLSTATE (division_by_zero), and the step in the message.
      expect((failed as PgliteStoreError).sqlState).toBe("22012");
      expect((failed as PgliteStoreError).message).toContain(`format ${F + 1} to ${F + 2}`);
      // What is there, read by a store of the format it is of.
      const s = await backend([], F + 1, [first]).open(ref(dir));
      try {
        expect(await formatOf(s)).toBe(F + 1);
        expect(await tables(s)).toEqual(["up_d"]);
      } finally {
        await s.close();
      }
      const t = await backend([], F + 2, [first, step(F + 1, "CREATE TABLE up_e (x int);")]).open(
        ref(dir),
      );
      try {
        expect(await formatOf(t)).toBe(F + 2);
        expect(await tables(t)).toEqual(["up_d", "up_e"]);
      } finally {
        await t.close();
      }
    },
    T,
  );

  it(
    "a step that fails half way leaves nothing of it: the table its first statement made is not there",
    async () => {
      const dir = await made();
      expect(
        await codeOf(
          backend([], F + 1, [step(F, "CREATE TABLE up_f (x int); SELECT 1/0;")]).open(ref(dir)),
        ),
      ).toBe("upgrade_failed");
      const s = await backend([]).open(ref(dir));
      try {
        expect(await formatOf(s)).toBe(F);
        expect(await tables(s)).toEqual([]);
      } finally {
        await s.close();
      }
    },
    T,
  );
});

describe("what is refused before any upgrade", () => {
  it(
    "a format older than any released version wrote: format_too_old; newer than the kernel's: format_too_new",
    async () => {
      const dir = await made();
      expect(await codeOf(backend([], F - 1).open(ref(dir)))).toBe("format_too_new");
      const s = await backend([]).open(ref(dir));
      await s.write((tx) =>
        tx.query("UPDATE meta SET value = $1 WHERE key = $2", [
          String(F - 1),
          META_KEYS.storageFormat,
        ]),
      );
      await s.close();
      expect(await codeOf(backend([], F + 1, [step(F - 1, ""), step(F, "")]).open(ref(dir)))).toBe(
        "format_too_old",
      );
    },
    T,
  );

  it(
    "session settings other than the ones it was made with: session_settings_mismatch, nothing upgraded",
    async () => {
      const dir = await made();
      const s = await backend([]).open(ref(dir));
      await s.write((tx) =>
        tx.query("UPDATE meta SET value = $1 WHERE key = $2", [
          JSON.stringify(["SET TIME ZONE 'Asia/Shanghai'"]),
          META_KEYS.sessionSettings,
        ]),
      );
      await s.close();
      const seen: Seen[] = [];
      expect(
        await codeOf(backend(seen, F + 1, [step(F, "CREATE TABLE up_g (x int);")]).open(ref(dir))),
      ).toBe("session_settings_mismatch");
      expect(seen.map((x) => x.event)).not.toContain("upgrading");
    },
    T,
  );
});
