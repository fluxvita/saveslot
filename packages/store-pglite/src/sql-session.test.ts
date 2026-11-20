// The session a `sql` statement runs in (11-restricted-sql.md «处理步骤» 8; 02-architecture §7, §8
// «固定的会话设置»): `standard_conforming_strings = on` because the printed string literals leave a
// backslash alone, `search_path` fixed because functions are printed without a schema, and, on a
// backend that enforces one, a statement timeout. They are set for the transaction and gone after.

import { createOpsContext, loadRsql, sql as sqlOp } from "@fluxvita/saveslot-kernel";
import { sqlInTx } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";
import { buildTenant, NOW, runSql, TENANT, USER } from "./testing/sql-tenant.fixture.ts";

let s: ReusableStore;
beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-sqlsession-");
  await buildTenant(s);
}, 300_000);
afterAll(async () => {
  await s?.close();
}, 120_000);

/** The limits the statements set, in order: what is left of the call's one deadline when each runs. */
const limits = (texts: readonly string[]) =>
  texts.flatMap((t) => {
    const m = /^SET LOCAL statement_timeout = (\d+)$/.exec(t);
    return m === null ? [] : [Number(m[1])];
  });

const settings = () =>
  s.store.read(async (tx) => {
    const r = await tx.query<{ name: string; setting: string }>(
      "SELECT name, setting FROM pg_settings ORDER BY name",
    );
    return Object.fromEntries(r.rows.map((x) => [x.name, x.setting]));
  });

describe("string literals", () => {
  it.each([
    ["a backslash", "SELECT 'a\\b' AS x", "a\\b"],
    ["two", "SELECT 'a\\\\b' AS x", "a\\\\b"],
    ["one before a quote", "SELECT 'it''s \\' AS x", "it's \\"],
    ["a backslash n", "SELECT 'line\\nbreak' AS x", "line\\nbreak"],
    ["a backslash x", "SELECT '\\x41' AS x", "\\x41"],
    ["a unicode escape", "SELECT '\\u0041' AS x", "\\u0041"],
  ])("with %s is read back as it is", async (_n, sql, want) => {
    expect((await runSql(s, { sql })).result.rows).toEqual([[want]]);
  });

  it("is so also when the session was not set the way the kernel sets it", async () => {
    // A session with the setting off would read `'a\\b'` as a backslash and a `b`: the call sets it.
    const r = await s.store.read(async (tx) => {
      await tx.query("SET LOCAL standard_conforming_strings = off");
      return sqlInTx(tx, {
        actor: USER as never,
        task: null,
        now: NOW as never,
        visibility: { kind: "all" },
        params: { sql: "SELECT 'a\\b' AS x, 'a\\\\b' AS y" },
        read: `rd_${"0".repeat(16)}` as never,
      });
    });
    expect(r.result.rows).toEqual([["a\\b", "a\\\\b"]]);
  });
});

describe("the settings of the session", () => {
  it("are set for the call before the statement, put back after the read record's statements, and gone with the transaction", async () => {
    const before = await settings();
    const r = await runSql(s, { sql: "SELECT note FROM spend" });
    const texts = r.statements.map((x) => x.text);
    const at = (needle: string) => texts.findIndex((t) => t.includes(needle));
    expect(texts).toContain("SET LOCAL standard_conforming_strings = on");
    expect(texts).toContain("SET LOCAL search_path = pg_catalog");
    const main = at("OFFSET 0 LIMIT");
    expect(at("SET LOCAL search_path = pg_catalog")).toBeLessThan(main);
    expect(at("SET LOCAL standard_conforming_strings = on")).toBeLessThan(main);
    // Put back before the kernel's own tables are read for the record.
    expect(at("SELECT set_config('search_path'")).toBeGreaterThan(main);
    expect(at("SELECT set_config('search_path'")).toBeLessThan(at('FROM "t_t1_v1__ver"'));
    expect(await settings()).toEqual(before);
  });

  it("are as they were after a call that failed", async () => {
    const before = await settings();
    await expect(
      runSql(s, { sql: "SELECT 9223372036854775807 + pieces FROM spend" }),
    ).rejects.toMatchObject({
      code: "sql_rejected",
    });
    expect(await settings()).toEqual(before);
  });

  it("have no statement timeout on PGlite, where there is none; a timeout given is set where one is asked for", async () => {
    const without = await runSql(s, { sql: "SELECT 1" });
    expect(without.statements.map((x) => x.text).join("\n")).not.toContain("statement_timeout");
    const given = await runSql(s, { sql: "SELECT 1" }, { timeoutMs: 1234 });
    expect(limits(given.statements.map((x) => x.text))[0]).toBeGreaterThan(1200);
    expect(limits(given.statements.map((x) => x.text))[0]).toBeLessThanOrEqual(1234);
  });

  it("is a whole number of milliseconds, or a mistake of the caller of the kernel", async () => {
    await expect(runSql(s, { sql: "SELECT 1" }, { timeoutMs: 0.5 })).rejects.toThrow(
      /whole number/,
    );
  });

  it("is asked for by the operation only of a store that enforces one", async () => {
    const seen: string[] = [];
    const store = new Proxy(s.store, {
      get(target, key, receiver) {
        if (key === "read") {
          return (fn: (tx: { query: (...a: never[]) => Promise<unknown> }) => Promise<unknown>) =>
            target.read((tx) =>
              fn({
                query: ((t: string, p?: never) => {
                  seen.push(t);
                  return tx.query(t, p);
                }) as never,
              }),
            );
        }
        // The first part is about a store that enforces no timeout, whichever backend this runs on.
        if (key === "enforcesStatementTimeout") return false;
        return Reflect.get(target, key, receiver);
      },
    });
    const ctx = createOpsContext({
      tenant: TENANT,
      actor: USER,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_window: 600_000,
      idempotency_key_window: 86_400_000,
      now: NOW,
      confirmation: null,
    });
    await sqlOp(store, ctx, { sql: "SELECT 1" });
    expect(seen.join("\n")).not.toContain("statement_timeout");
    // A store that says it enforces one is given the kernel's value, or the one the caller injects.
    const enforcing = new Proxy(store, {
      get: (t, k, r) => (k === "enforcesStatementTimeout" ? true : Reflect.get(t, k, r)),
    });
    seen.length = 0;
    await sqlOp(enforcing, ctx, { sql: "SELECT 1" });
    expect(limits(seen)[0]).toBeGreaterThan(9000);
    expect(limits(seen)[0]).toBeLessThanOrEqual(10000);
    seen.length = 0;
    await sqlOp(enforcing, ctx, { sql: "SELECT 1" }, { timeoutMs: 250 });
    expect(limits(seen)[0]).toBeGreaterThan(150);
    expect(limits(seen)[0]).toBeLessThanOrEqual(250);
  });
});
