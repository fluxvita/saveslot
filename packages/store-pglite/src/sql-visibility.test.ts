// What a `sql` call can see (04-write-and-read «可见范围»; 11-restricted-sql.md «名字»): every table
// the statement names must be within the call's range, and what is outside it is, to the caller,
// what does not exist: the same refusal, the same words, and nothing of it in the candidates or the
// result. Field-level visibility is not in this version: a call carrying it is refused whole and
// runs no query at all.

import { loadRsql } from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";
import {
  buildTenant,
  LEDGER,
  LEDGER_ONLY,
  lastStatements,
  MARK,
  refusal,
  runSql,
  VAULT,
} from "./testing/sql-tenant.fixture.ts";

let s: ReusableStore;
beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-sqlvis-");
  await buildTenant(s);
}, 300_000);
afterAll(async () => {
  await s?.close();
}, 120_000);

type V = Parameters<typeof runSql>[2] extends infer O
  ? O extends { visibility?: infer X }
    ? X
    : never
  : never;
const call = (sql: string, visibility: V) => runSql(s, { sql }, { visibility });

/** The refusal of a statement with the one name `from` replaced by `to`, so that two compare. */
async function refusedAs(sql: string, visibility: V, from: string, to: string) {
  const e = await refusal(call(sql, visibility));
  return JSON.parse(JSON.stringify(e).replaceAll(from, to));
}

describe("a table out of range", () => {
  it("is refused as a table that does not exist, with the same words", async () => {
    for (const [hidden, visibility] of [
      ["vault.secrets", LEDGER_ONLY],
      ["secrets", LEDGER_ONLY],
      ["vault_state", LEDGER_ONLY],
      ["ledger.budgets", { kind: "scoped", slots: [{ slot: LEDGER, tables: [{ table: "t1" }] }] }],
      ["budgets", { kind: "scoped", slots: [{ slot: LEDGER, tables: [{ table: "t1" }] }] }],
      ["secrets", { kind: "scoped", slots: [] }],
    ] as const) {
      const out = await refusedAs(`SELECT * FROM ${hidden}`, visibility as V, hidden, "nosuch_zz");
      const absent = await refusedAs(
        "SELECT * FROM nosuch_zz",
        visibility as V,
        "nosuch_zz",
        "nosuch_zz",
      );
      expect(out).toEqual(absent);
      expect(out).toMatchObject({ code: "sql_rejected", reason: "unknown_name" });
    }
  });

  it("runs nothing of the statement: the database is given none of it", async () => {
    await refusal(call("SELECT secret FROM vault.secrets", LEDGER_ONLY as V));
    const texts = lastStatements.map((x) => x.text).join("\n");
    expect(texts).not.toMatch(/t_t11|SET LOCAL|OFFSET/);
  });

  it("does not make a name ambiguous: a bare name is one table in the range, whatever is outside", async () => {
    // `secrets` exists in the vault slot only; with the vault in range it is that table.
    expect((await call("SELECT secret FROM secrets", { kind: "all" })).result.rows).toEqual([
      [`${MARK}VAULT_ROW`],
    ]);
    expect(await refusal(call("SELECT secret FROM secrets", LEDGER_ONLY as V))).toMatchObject({
      reason: "unknown_name",
    });
  });

  it("is not in the candidates, the result's slots or the read record", async () => {
    const r = await call("SELECT category FROM budgets", LEDGER_ONLY as V);
    expect(r.result.sv).toEqual({ ledger: 1 });
    expect(JSON.stringify([r.result, r.entry])).not.toMatch(
      new RegExp(`${VAULT}|vault|t11|t12|${MARK}`),
    );
  });

  it("can be read when it is in range: the vault is a slot like another", async () => {
    const r = await call("SELECT secret FROM vault.secrets", { kind: "all" });
    expect(r.result).toMatchObject({ sv: { vault: 1 }, rows: [[`${MARK}VAULT_ROW`]] });
    expect(r.entry.rows.map((x) => x.table)).toEqual(["t11"]);
  });

  it("is a table of a slot in range with a table in range alone: the others of its slot are out", async () => {
    const only = { kind: "scoped", slots: [{ slot: LEDGER, tables: [{ table: "t5" }] }] } as V;
    expect((await call("SELECT key FROM settings ORDER BY 1", only)).result.rows).toEqual([
      ["a"],
      ["b"],
    ]);
    expect(await refusal(call("SELECT note FROM spend", only))).toMatchObject({
      reason: "unknown_name",
    });
    expect(await refusal(call("SELECT 1 FROM settings s, budgets b", only))).toMatchObject({
      reason: "unknown_name",
    });
    expect(
      await refusal(
        call("SELECT key FROM settings WHERE key IN (SELECT category FROM budgets)", only),
      ),
    ).toMatchObject({ reason: "unknown_name" });
  });
});

describe("visibility by field", () => {
  const byField = {
    kind: "scoped",
    slots: [{ slot: LEDGER, tables: [{ table: "t1", fields: ["f1"] }] }],
  } as V;

  it("is refused whole, as the other reads refuse it", async () => {
    expect(await refusal(call("SELECT date FROM spend", byField))).toMatchObject({
      code: "internal",
      reason: "not_implemented",
    });
  });

  it("runs no query at all: not the statement, not the listing of the slots either", async () => {
    await refusal(call("SELECT 1", byField));
    expect(lastStatements).toEqual([]);
  });

  it("is refused whatever the statement is, even one that reads no table, and wherever the field level sits", async () => {
    for (const sql of [
      "SELECT 1",
      "SELECT note FROM spend",
      "this is not sql",
      "SELECT secret FROM vault.secrets",
    ]) {
      expect(await refusal(call(sql, byField))).toMatchObject({
        code: "internal",
        reason: "not_implemented",
      });
      expect(lastStatements).toEqual([]);
    }
    const later = {
      kind: "scoped",
      slots: [
        { slot: VAULT },
        { slot: LEDGER, tables: [{ table: "t5" }, { table: "t1", fields: [] }] },
      ],
    } as V;
    expect(await refusal(call("SELECT 1", later))).toMatchObject({ reason: "not_implemented" });
    expect(lastStatements).toEqual([]);
  });

  it("is not recorded as read", async () => {
    await refusal(call("SELECT 1", byField));
    expect(lastStatements.some((x) => /INSERT/.test(x.text))).toBe(false);
  });
});
