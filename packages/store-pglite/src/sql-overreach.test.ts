// What a `sql` call must not reach, each case built by hand against a tenant that holds a marked
// value in it (./testing/sql-tenant.fixture.ts): another slot, a system column, an internal table,
// a table out of the call's range, a physical name, `pg_catalog`, `information_schema`, and decoys
// named like a slot's table. Each is refused as a name that is not there, and the refusal is the one
// a name that does not exist gets: not a word more. A statement that is accepted and could touch
// a marked value (a revoked row, an old value, an older table) is run, and no marker is in what
// comes back. The random statements of the same claim are in sql-exec.prop.test.ts.

import { KERNEL_TABLES, loadRsql } from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";
import {
  buildTenant,
  LEDGER_ONLY,
  lastStatements,
  MARK,
  refusal,
  runSql,
} from "./testing/sql-tenant.fixture.ts";

let s: ReusableStore;
beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-sqloverreach-");
  await buildTenant(s);
}, 300_000);
afterAll(async () => {
  await s?.close();
}, 120_000);

type V = NonNullable<Parameters<typeof runSql>[2]>["visibility"];
const TABLE_SCOPE = { kind: "scoped", slots: [{ slot: "x" }] } as const;
const call = (sql: string, visibility: V = LEDGER_ONLY as V) =>
  runSql(s, { sql }, visibility === undefined ? {} : { visibility });

/**
 * The refusal of `sql`, and the refusal of the same statement with the name `hidden` written as
 * `nosuch` (a name no table, column or slot has): equal once the one spelling is replaced.
 */
async function sameAsAbsent(sql: string, hidden: string, visibility?: V) {
  const out = await refusal(call(sql, visibility));
  const absent = await refusal(call(sql.replace(hidden, "nosuch_zz"), visibility));
  // Spelled the way each was written: a quoted name is quoted in the statement, not in the refusal.
  const bare = hidden.replaceAll('"', "");
  const plain = (e: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(e).map(([k, v]) => [
        k,
        typeof v === "string" ? v.replaceAll('"', "").replaceAll(bare, "nosuch_zz") : v,
      ]),
    );
  const renamed = plain(out);
  expect(renamed, sql).toEqual(plain(absent));

  expect(out, sql).toMatchObject({ code: "sql_rejected", reason: "unknown_name" });
  // Nothing of it was given to the database as a statement of the caller's.
  expect(lastStatements.map((x) => x.text).join("\n"), sql).not.toMatch(/SET LOCAL|OFFSET \d/);
}

describe("another slot", () => {
  it.each([
    ["SELECT secret FROM vault.secrets", "vault.secrets"],
    ["SELECT secret FROM secrets", "secrets"],
    ["SELECT secret FROM vault.vault_state", "vault.vault_state"],
    ["SELECT v.secret FROM vault_state v", "vault_state"],
    ["SELECT 1 FROM spend s, vault.secrets v", "vault.secrets"],
    ["SELECT 1 FROM spend WHERE EXISTS (SELECT 1 FROM secrets)", "secrets"],
    ["WITH x AS (SELECT * FROM vault.secrets) SELECT * FROM x", "vault.secrets"],
    ["SELECT * FROM spend UNION ALL SELECT secret, 1, 1, 1, 1, 1, 1, 1 FROM secrets", "secrets"],
  ])("is not a table: %s", async (sql, hidden) => {
    await sameAsAbsent(sql, hidden);
  });

  it("is not named through a table of the slot in range either", async () => {
    await sameAsAbsent("SELECT spend.secret FROM spend", "secret");
    await sameAsAbsent("SELECT ledger.secrets.secret FROM ledger.spend", "secrets");
  });
});

describe("a system column", () => {
  it.each([
    "revoked",
    "rec_from",
    "rec_to",
    "src_event",
    "src_field",
    "src_k",
    "intent",
    "field_id",
    "no_value",
    "ver",
    "sv",
    "partition_id",
    "f_f4",
    "f_f8__zone",
    "ctid",
    "xmin",
    "tableoid",
    "oid",
  ])("is no column of a table: %s", async (name) => {
    await sameAsAbsent(`SELECT s.${name} FROM spend s`, name);
    await sameAsAbsent(`SELECT ${name} FROM spend`, name);
  });

  it("is not a system column of another kind of table: entity_id of an event table, row_id of a state table", async () => {
    await sameAsAbsent("SELECT entity_id FROM spend", "entity_id");
    await sameAsAbsent("SELECT valid_from FROM spend", "valid_from");
    await sameAsAbsent("SELECT row_id FROM budgets", "row_id");
  });
});

describe("an internal table", () => {
  it.each(KERNEL_TABLES.map((t) => t.name))("%s is not a table", async (name) => {
    await sameAsAbsent(`SELECT * FROM ${name}`, name);
    await sameAsAbsent(`SELECT * FROM public.${name}`, `public.${name}`);
    await sameAsAbsent(`SELECT * FROM ledger.${name}`, `ledger.${name}`);
  });
});

describe("a table out of the range", () => {
  const only = {
    kind: "scoped",
    slots: [{ slot: "sl_4444444444444444", tables: [{ table: "t1" }] }],
  } as V;
  it.each([
    ["SELECT * FROM budgets", "budgets"],
    ["SELECT * FROM ledger.budgets", "ledger.budgets"],
    ["SELECT 1 FROM spend, rooms", "rooms"],
    ["SELECT 1 FROM spend WHERE category IN (SELECT category FROM budgets)", "budgets"],
    ["SELECT * FROM odd", "odd"],
  ])("is not a table: %s", async (sql, hidden) => {
    await sameAsAbsent(sql, hidden, only);
    await sameAsAbsent(sql, hidden, { kind: "scoped", slots: [] } as V);
    void TABLE_SCOPE;
  });
});

describe("a physical name", () => {
  it.each([
    "t_t1_v1",
    "public.t_t1_v1",
    '"t_t1_v1"',
    "t_t1_v1__ver",
    "t_t1_v0",
    "t_t5_v1",
    "t_t11_v1",
    "d_t9_v1",
    "ledger.t_t1_v1",
    "t1",
    "ledger.t1",
    "sl_4444444444444444.t1",
  ])("is not a table: %s", async (name) => {
    await sameAsAbsent(`SELECT * FROM ${name}`, name);
  });
});

describe("the system catalog and the information schema", () => {
  it.each([
    "pg_catalog.pg_class",
    "pg_class",
    "pg_catalog.pg_tables",
    "pg_tables",
    "pg_settings",
    "pg_stat_activity",
    "pg_proc",
    "pg_catalog.pg_proc",
    "pg_namespace",
    "pg_roles",
    "pg_authid",
    "pg_catalog.pg_shadow",
    "information_schema.tables",
    "information_schema.columns",
    "information_schema.schemata",
    "information_schema.routines",
  ])("is not a table: %s", async (name) => {
    await sameAsAbsent(`SELECT * FROM ${name}`, name);
  });

  it("is not reached through a function either: they are not on the list", async () => {
    for (const sql of [
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT current_setting('search_path')",
      "SELECT set_config('search_path', 'x', false)",
      "SELECT pg_sleep(10)",
      "SELECT version()",
      "SELECT current_user",
      "SELECT to_regclass('events')",
      "SELECT (SELECT secret FROM public.spend)",
    ]) {
      const e = await refusal(call(sql));
      expect(e, sql).toMatchObject({ code: "sql_rejected" });
      expect(["function", "node", "unknown_name", "syntax"]).toContain(e["reason"]);
    }
  });
});

describe("a decoy named like a table of the slot", () => {
  it("is not read: `spend` is the slot's table, `public.spend` and the schema `ledger` hold others", async () => {
    for (const sql of [
      "SELECT note FROM spend",
      "SELECT note FROM ledger.spend",
      "SELECT s.note FROM ledger.spend s",
    ]) {
      const r = (await call(sql)).result;
      expect(JSON.stringify(r), sql).not.toContain(MARK);
      expect(r.rows, sql).toHaveLength(4);
    }
    await sameAsAbsent("SELECT note FROM public.spend", "public.spend");
    // A name of three parts is no table name whatever it names: the same refusal for every one.
    expect(await refusal(call("SELECT note FROM public.ledger.spend"))).toEqual(
      await refusal(call("SELECT note FROM nosuch.zz.spend")),
    );
  });
});

describe("what could touch a marked value, accepted", () => {
  it.each([
    "SELECT * FROM spend",
    "SELECT note FROM spend WHERE note LIKE '%MARKER%'",
    "SELECT count(*) FROM spend",
    "SELECT note FROM spend WHERE note > ''",
    "SELECT note FROM spend UNION SELECT note FROM spend",
    "SELECT a.note FROM spend a LEFT JOIN spend b ON b.note = a.note",
    "SELECT * FROM (SELECT * FROM spend) s",
    "WITH x AS (SELECT * FROM spend) SELECT * FROM x",
    "SELECT note FROM spend WHERE EXISTS (SELECT 1 FROM spend z WHERE z.note LIKE 'MARKER%')",
    "SELECT * FROM odd",
    "SELECT * FROM settings",
    "SELECT * FROM budgets FOR VALID_TIME FROM '0001-01-01' TO '9999-12-31'",
    "SELECT * FROM rooms FOR VALID_TIME FROM '0001-01-01T00:00:00Z' TO '9999-12-31T00:00:00Z'",
    "SELECT * FROM visits",
  ])("has none of them in the result: %s", async (sql) => {
    const r = await call(sql);
    expect(JSON.stringify(r.result)).not.toContain(MARK);
    expect(JSON.stringify(r.entry)).not.toContain(MARK);
  });

  it("never gives the database a name of a kernel table, a version table or another slot's table", async () => {
    const r = await call("SELECT * FROM spend s JOIN budgets b ON b.category = s.category");
    const text = r.statements
      .map((x) => x.text)
      .filter((t) => /OFFSET \d|^SELECT DISTINCT/.test(t))
      .join("\n");
    for (const name of KERNEL_TABLES.map((t) => t.name)) {
      expect(text, name).not.toMatch(new RegExp(`(FROM|JOIN) "?${name}"?[ )]`));
    }
    expect(text).not.toMatch(/__ver|t_t11|t_t12|t_t1_v0|pg_|information_schema/);
  });
});
