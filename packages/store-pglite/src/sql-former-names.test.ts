// The names a table and a field had in the last 10 schema versions (11-restricted-sql.md «名字»):
// they still resolve, and the call says so with a `renamed` warning. An older name, or a name of
// a slot the call cannot see, does not resolve, and is refused as a name that is not there. The
// earlier versions are made by hand: a retired version in `schema_versions` with the schema's
// definition of the time, which is all that the lookup reads.

import { loadRsql } from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";
import {
  buildTenant,
  LEDGER,
  LEDGER_ONLY,
  refusal,
  runSql,
  VAULT,
} from "./testing/sql-tenant.fixture.ts";

let s: ReusableStore;
beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-sqlformer-");
  await buildTenant(s);

  type Compiled = {
    sv: number;
    tables: { id: string; name: string; fields: { id: string; name: string }[] }[];
  };
  const current = async (slot: string): Promise<Compiled> =>
    s.store.read(async (tx) => {
      const r = await tx.query<{ body: string }>(
        `SELECT c.body FROM schema_versions v JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
         WHERE v.slot_id = $1 AND v.state = 'current'`,
        [slot] as never,
      );
      return JSON.parse((r.rows[0] as { body: string }).body) as Compiled;
    });
  /** A retired version `sv` of `slot` whose definition is the current one with names changed. */
  const retire = async (slot: string, sv: number, seq: number, rename: (c: Compiled) => void) => {
    const old = structuredClone(await current(slot));
    old.sv = sv;
    rename(old);
    await s.store.write(async (tx) => {
      await tx.exec(
        `INSERT INTO content (seq, path, body, checksum) VALUES (${seq}, 'compiled', '${JSON.stringify(old).replaceAll("'", "''")}', 'x');
         INSERT INTO schema_versions (slot_id, sv, compiled_seq, draft_id, state) VALUES ('${slot}', ${sv}, ${seq}, 'd_${String(sv).padStart(16, "0")}', 'retired')`,
      );
    });
  };
  // The ledger had `outlay` with a field `memo` where it has `spend` and `note`, one version ago; and
  // `ancient` (the twelfth retired version back, out of the range of 10). The vault had `hoard`.
  await retire(LEDGER, 0, 900_001, (c) => {
    const t = c.tables.find((x) => x.name === "spend") as Compiled["tables"][number];
    t.name = "outlay";
    (t.fields.find((f) => f.name === "note") as { name: string }).name = "memo";
  });
  // Ten retired versions between: the names that resolve are those of the last 10 retired
  // versions by count, not by version number (numbers may skip).
  for (let k = 1; k <= 10; k++) await retire(LEDGER, -k, 900_100 + k, () => {});
  await retire(LEDGER, -11, 900_002, (c) => {
    (c.tables.find((x) => x.name === "spend") as Compiled["tables"][number]).name = "ancient";
  });
  await retire(VAULT, 0, 900_003, (c) => {
    (c.tables.find((x) => x.name === "secrets") as Compiled["tables"][number]).name = "hoard";
  });
  // A retired version whose number is far back but the second retired one: within the 10.
  await retire(VAULT, -50, 900_004, (c) => {
    (c.tables.find((x) => x.name === "secrets") as Compiled["tables"][number]).name = "relic";
  });
}, 300_000);
afterAll(async () => {
  await s?.close();
}, 120_000);

const call = (sql: string, visibility?: Parameters<typeof runSql>[2] extends infer O ? O : never) =>
  runSql(s, { sql }, visibility as never);

/** A refusal with the one name the statement spelled replaced, to compare two spellings. */
const spelled = (e: Record<string, unknown>, name: string) =>
  JSON.parse(JSON.stringify(e).replaceAll(name, "X")) as Record<string, unknown>;

describe("a name of the last 10 versions", () => {
  it("resolves to the table, and the call says it was renamed", async () => {
    const old = await call("SELECT note FROM outlay ORDER BY 1");
    const now = await call("SELECT note FROM spend ORDER BY 1");
    expect(old.result.rows).toEqual(now.result.rows);
    expect(old.result.rows.length).toBeGreaterThan(0);
    expect(old.result.warnings).toEqual([{ code: "renamed", from: "outlay", to: "spend" }]);
    expect(now.result.warnings).toBeUndefined();
    // The read is of the table's rows, as with the name it has now.
    expect(old.entry.rows.map((r) => r.table)).toEqual(now.entry.rows.map((r) => r.table));
  });

  it("resolves a field the same way", async () => {
    const r = await call("SELECT memo FROM outlay ORDER BY 1");
    const now = await call("SELECT note FROM spend ORDER BY 1");
    expect(r.result.rows).toEqual(now.result.rows);
    expect(r.result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "renamed", from: "memo", to: "note" }),
      ]),
    );
  });

  it("is not read by the name the table has now in the same words: the shape is the same", async () => {
    const a = await call("SELECT note FROM outlay");
    const b = await call("SELECT note FROM spend");
    expect(a.entry.shape).toBe(b.entry.shape);
  });
});

describe("a name that does not resolve", () => {
  it("a name older than 10 versions is a name that is not there", async () => {
    const gone = await refusal(call("SELECT 1 FROM ancient"));
    const none = await refusal(call("SELECT 1 FROM nosuch_zz"));
    expect(gone).toMatchObject({ code: "sql_rejected", reason: "unknown_name" });
    expect(spelled(gone, "ancient")).toEqual(spelled(none, "nosuch_zz"));
  });

  it("a former name of a slot the call cannot see is a name that is not there", async () => {
    const hidden = await refusal(call("SELECT 1 FROM hoard", { visibility: LEDGER_ONLY } as never));
    const none = await refusal(
      call("SELECT 1 FROM nosuch_zz", { visibility: LEDGER_ONLY } as never),
    );
    expect(hidden).toMatchObject({ code: "sql_rejected", reason: "unknown_name" });
    expect(spelled(hidden, "hoard")).toEqual(spelled(none, "nosuch_zz"));
  });

  it("counts versions, not version numbers: a number far back within the last 10 resolves", async () => {
    const r = await call("SELECT 1 FROM relic");
    expect(r.result.warnings).toEqual([{ code: "renamed", from: "relic", to: "secrets" }]);
  });

  it("and where the call can see that slot, the former name resolves", async () => {
    const r = await call("SELECT 1 FROM hoard");
    expect(r.result.warnings).toEqual([{ code: "renamed", from: "hoard", to: "secrets" }]);
  });
});
