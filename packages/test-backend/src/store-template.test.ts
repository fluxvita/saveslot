// The store template (store-template.fixture.ts): a storage the test backend copies from it is the
// storage made for real, structure, rows and sequences; storages copied from one template touch
// neither each other nor the template; other creation parameters get another template; neither a
// template half made nor one of other parameters is copied; two first creations at once, in one
// process or in two, get one template and whole storages; `template: false`, or a run without a
// templates directory, makes the storage for real. PGlite only: on PostgreSQL there is no template.
//
// A storage made for real (initdb in WASM, seconds) is made once in beforeAll and compared against;
// the cases whose subject is not making a template share one templates directory.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TenantStore } from "@fluxvita/saveslot-kernel";
import type { PgliteTenantStore } from "@fluxvita/saveslot-store-pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  TEST_BACKEND,
  TEST_DURABILITY,
  type TestBackendOptions,
  testBackend,
} from "./index.fixture.ts";
import { copyTemplate, TEMPLATES_ENV, templateFor, templateKey } from "./store-template.fixture.ts";

const T = 180_000;
// Made in a hook, not when the file loads: on PostgreSQL every case is skipped, and so are the
// hooks, which would leave a directory made at load behind.
let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "saveslot-store-template-"));
});
afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
}, T);

/**
 * Each case's own directory of templates, in place of the run's; `shared()` gives the cases whose
 * subject is not making a template one directory for them all instead.
 */
let templates: string;
let sharedTemplates: string | undefined;
let before: string | undefined;
beforeEach(() => {
  templates = mkdtempSync(join(root, "templates-"));
  before = process.env[TEMPLATES_ENV];
  process.env[TEMPLATES_ENV] = templates;
});
const shared = () => {
  sharedTemplates ??= mkdtempSync(join(root, "shared-"));
  templates = sharedTemplates;
  process.env[TEMPLATES_ENV] = templates;
};
afterEach(() => {
  if (before === undefined) delete process.env[TEMPLATES_ENV];
  else process.env[TEMPLATES_ENV] = before;
});

let n = 0;
const fresh = () => join(root, `s${++n}`);

/** A schema of the database that is not the server's own, by the column holding its name. */
const OWN = (col: string) => `${col} NOT LIKE 'pg\\_%' AND ${col} <> 'information_schema'`;

/** The database's structure, one line per thing, in the shape of reusable-store.fixture.test.ts. */
const STRUCTURE: Record<string, string> = {
  schemas: `SELECT nspname FROM pg_namespace WHERE ${OWN("nspname")}`,
  relations: `SELECT n.nspname || '.' || c.relname || ' ' || c.relkind::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${OWN("n.nspname")} AND c.relkind NOT IN ('t')`,
  columns: `SELECT n.nspname || '.' || c.relname || ' ' || a.attnum || ' ' || a.attname || ' '
      || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull || ' ' || a.attidentity::text
      || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE ${OWN("n.nspname")} AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'c')
      AND a.attnum > 0 AND NOT a.attisdropped`,
  indexes: `SELECT indexdef FROM pg_indexes WHERE ${OWN("schemaname")}`,
  constraints: `SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)
    FROM pg_constraint WHERE connamespace::regnamespace::text NOT LIKE 'pg\\_%'
      AND connamespace::regnamespace::text <> 'information_schema'`,
  triggers: `SELECT tgrelid::regclass::text || ' ' || tgname || ' ' || pg_get_triggerdef(oid)
    FROM pg_trigger WHERE NOT tgisinternal`,
  views: `SELECT schemaname || '.' || viewname || ' ' || definition FROM pg_views
    WHERE ${OWN("schemaname")}`,
  functions: `SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid)
      || ') ' || p.prokind::text || ' ' || pg_get_function_result(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${OWN("n.nspname")}`,
  types: `SELECT n.nspname || '.' || t.typname || ' ' || t.typtype::text
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE ${OWN("n.nspname")}`,
  settings: `SELECT d.setdatabase || ' ' || array_to_string(d.setconfig, ',')
    FROM pg_db_role_setting d`,
  encoding: `SELECT datname || ' ' || pg_encoding_to_char(encoding) || ' ' || datcollate || ' ' || datctype
    FROM pg_database WHERE datname = current_database()`,
};

const big = (_: string, v: unknown) => (typeof v === "bigint" ? String(v) : v);

/** Structure, every table's rows, every sequence's position. */
async function state(store: TenantStore) {
  return store.read(async (tx) => {
    const structure: Record<string, string[]> = {};
    for (const [what, sql] of Object.entries(STRUCTURE)) {
      const rows = await tx.query<Record<string, string>>(`SELECT * FROM (${sql}) x(line)`);
      structure[what] = rows.rows.map((r) => r["line"] as string).sort();
    }
    const names = await tx.query<{ nspname: string; relname: string; relkind: string }>(
      `SELECT n.nspname, c.relname, c.relkind FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE ${OWN("n.nspname")} AND c.relkind IN ('r', 'p', 'S')
         ORDER BY n.nspname, c.relname`,
    );
    const tables: Record<string, string[]> = {};
    const sequences: Record<string, string> = {};
    for (const { nspname, relname, relkind } of names.rows) {
      const name = `"${nspname}"."${relname}"`;
      if (relkind === "S") {
        const r = await tx.query(`SELECT last_value, is_called FROM ${name}`);
        sequences[name] = JSON.stringify(r.rows[0], big);
      } else {
        const rows = await tx.query(`SELECT * FROM ${name}`);
        tables[name] = rows.rows.map((x) => JSON.stringify(x, big)).sort();
      }
    }
    return { structure, tables, sequences };
  });
}

async function opened<R>(
  dir: string,
  o: TestBackendOptions,
  f: (s: PgliteTenantStore) => Promise<R>,
): Promise<R> {
  const s = await testBackend(o).open({ kind: "pglite", dir }, { create: true });
  try {
    return await f(s);
  } finally {
    await s.close();
  }
}

describe.skipIf(TEST_BACKEND !== "pglite")("the store template", () => {
  /**
   * A storage made for real, once: its directory, its epoch at first open, its state; and what the
   * templates directory it was made under held after (`template: false` makes none).
   */
  let real: { dir: string; epoch: number; state: Awaited<ReturnType<typeof state>> };
  let leftByReal: string[];
  beforeAll(async () => {
    const dir = fresh();
    const was = process.env[TEMPLATES_ENV];
    const under = mkdtempSync(join(root, "real-"));
    process.env[TEMPLATES_ENV] = under;
    try {
      real = await opened(dir, { template: false }, async (s) => ({
        dir,
        epoch: s.epoch,
        state: await state(s),
      }));
    } finally {
      if (was === undefined) delete process.env[TEMPLATES_ENV];
      else process.env[TEMPLATES_ENV] = was;
    }
    leftByReal = readdirSync(under);
  }, T);

  it(
    "a storage copied from it is the storage made for real: structure, rows, sequences, epoch, the directory's entries",
    async () => {
      shared();
      const copied = fresh();
      const a = await opened(copied, {}, async (s) => ({ epoch: s.epoch, state: await state(s) }));
      expect(readdirSync(templates)).toEqual([templateKey(TEST_DURABILITY)]);
      expect(Object.keys(a.state.tables).length).toBeGreaterThan(5);
      expect(a.state.structure["columns"]?.length).toBeGreaterThan(20);
      expect(a).toEqual({ epoch: real.epoch, state: real.state });
      expect(readdirSync(copied).sort()).toEqual(readdirSync(real.dir).sort());
    },
    T,
  );

  it(
    "storages copied from one template touch neither each other nor the template",
    async () => {
      shared();
      const one = fresh();
      const blank = await opened(one, {}, async (s) => {
        const was = await state(s);
        await s.write((tx) =>
          tx.exec("CREATE TABLE t_mine (x INT); INSERT INTO t_mine VALUES (1)"),
        );
        return was;
      });
      const other = fresh();
      expect(await opened(other, {}, state)).toEqual(blank);
      const again = await opened(one, {}, (s) => s.read((tx) => tx.query("SELECT x FROM t_mine")));
      expect(again.rows).toEqual([{ x: 1 }]);
      expect(readdirSync(templates)).toHaveLength(1);
    },
    T,
  );

  it(
    "other creation parameters get another template, each copied for its own",
    async () => {
      expect(templateKey("host-fsync")).not.toBe(templateKey("pglite-default"));
      await opened(fresh(), { durability: "host-fsync" }, async () => {});
      await opened(fresh(), { durability: "pglite-default" }, async () => {});
      expect(readdirSync(templates).sort()).toEqual(
        [templateKey("host-fsync"), templateKey("pglite-default")].sort(),
      );
    },
    T,
  );

  it(
    "neither a template half made nor one of other parameters is copied",
    async () => {
      const key = templateKey(TEST_DURABILITY);
      // What a maker killed halfway leaves, and a template of parameters this run does not have.
      for (const left of [`${key}.making-1-dead`, "0".repeat(32)]) {
        mkdirSync(join(templates, left));
        writeFileSync(join(templates, left, "PG_VERSION"), "not a storage\n");
      }
      expect(await opened(fresh(), {}, state)).toEqual(real.state);
      expect(readdirSync(templates).sort()).toEqual(
        [`${key}.making-1-dead`, "0".repeat(32), key].sort(),
      );
    },
    T,
  );

  it(
    "something under the key that is not a storage is refused, not copied",
    async () => {
      mkdirSync(join(templates, templateKey("pglite-default"), "base"), { recursive: true });
      await expect(templateFor(templates, "pglite-default")).rejects.toThrow("holds no storage");
    },
    T,
  );

  it(
    "two first creations at once in one process: one template, two whole storages",
    async () => {
      const dirs = [fresh(), fresh()];
      const both = await Promise.all(dirs.map((d) => opened(d, {}, state)));
      expect(both[0]).toEqual(real.state);
      expect(both[1]).toEqual(real.state);
      expect(readdirSync(templates)).toEqual([templateKey(TEST_DURABILITY)]);
      // And copying into a directory that already holds a storage leaves it to the opening.
      expect(await copyTemplate(templates, dirs[0] as string, TEST_DURABILITY)).toBe(false);
    },
    T,
  );

  it(
    "two processes making the template at once: one is renamed into place, both get it, and a copy is whole",
    async () => {
      const made = await Promise.all([maker(templates), maker(templates)]);
      // Both were making it at the same time: each started before the other ended.
      expect(made[0]?.started).toBeLessThan(made[1]?.ended as number);
      expect(made[1]?.started).toBeLessThan(made[0]?.ended as number);
      const key = templateKey(TEST_DURABILITY);
      expect(made.map((m) => m.at)).toEqual([join(templates, key), join(templates, key)]);
      // Nothing half made is left: the one whose rename came second dropped its own.
      expect(readdirSync(templates)).toEqual([key]);
      expect(await opened(fresh(), {}, state)).toEqual(real.state);
    },
    T,
  );

  it(
    "template: false, or a run without a templates directory, makes the storage for real",
    async () => {
      // The storage made with `template: false` in beforeAll left no template where it was made.
      expect(leftByReal).toEqual([]);
      delete process.env[TEMPLATES_ENV];
      await opened(fresh(), {}, async () => {});
      expect(readdirSync(templates)).toEqual([]);
    },
    T,
  );
});

const MAKER = join(import.meta.dirname, "make-template.fixture.ts");

/** make-template.fixture.ts in a process of its own: when it made the template, and where it is. */
function maker(templates: string): Promise<{ at: string; started: number; ended: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      // Wasm code GC off, as the test forks have it (vitest.config.ts, nodejs/node#66366).
      [
        "--no-wasm-code-gc",
        "--conditions=source",
        "--no-warnings",
        MAKER,
        templates,
        TEST_DURABILITY,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    child.stdout?.on("data", (b) => {
      out += String(b);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`the maker exited ${code}`)),
    );
  });
}
