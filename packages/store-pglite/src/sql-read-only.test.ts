// A `sql` call runs in a read-only transaction and nothing else keeps it from writing: the
// whitelist refuses a statement that is not one SELECT, but the transaction is the second wall.
// Seen as behaviour: during the call the transaction reports itself read-only, and a write
// attempted in it afterwards (the test's own hook, standing in for a statement that got past
// every check) is refused by the database.

import { loadRsql, type SqlValue } from "@fluxvita/saveslot-kernel";
import { sqlInTx } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore, snapshot } from "./testing/reusable-store.fixture.ts";
import { buildTenant, NOW, USER } from "./testing/sql-tenant.fixture.ts";

let s: ReusableStore;
beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-sqlreadonly-");
  await buildTenant(s);
}, 300_000);
afterAll(async () => {
  await s?.close();
}, 120_000);

describe("the transaction of a sql call", () => {
  it("is read-only while the statement runs, and a write in it is refused by the database", async () => {
    const before = await s.store.read((tx) => snapshot(tx));
    let during: unknown;
    let write: unknown;
    await s.store.read(async (tx) => {
      await sqlInTx(
        {
          query: async <R>(text: string, p?: readonly SqlValue[]) => {
            const out = await tx.query<R>(text, p);
            if (text.startsWith("SELECT CAST(")) {
              during = (await tx.query("SHOW transaction_read_only")).rows[0];
            }
            return out;
          },
        },
        {
          actor: USER as never,
          task: null,
          now: NOW as never,
          visibility: { kind: "all" },
          params: { sql: "SELECT note FROM spend" },
          read: `rd_${"4".repeat(16)}` as never,
        },
      );
    });
    // The same kind of transaction, given a write: refused (25006, read_only_sql_transaction).
    try {
      await s.store.read((tx) => tx.query("UPDATE meta SET value = value WHERE false"));
      write = "done";
    } catch (e) {
      write = (e as { sqlState?: string; message?: string }).sqlState ?? (e as Error).message;
    }
    expect(during).toEqual({ transaction_read_only: "on" });
    expect(String(write)).toMatch(/25006|read-only transaction/);
    expect(await s.store.read((tx) => snapshot(tx))).toEqual(before);
  });
});
