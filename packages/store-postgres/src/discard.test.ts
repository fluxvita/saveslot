// Dropping a database an import leaves behind (02-architecture §8 «格式版本、导出、导入与恢复»,
// «重入»): only the tenant's staging database or the one its import replaced, never the one its
// directory names now; anything else refused with nothing dropped. Against a real server: a drop
// cannot be undone, so what stays is checked on the server, not taken from the error.

import { describe, expect, it } from "vitest";
import { checkDiscard, discardDatabase, stagingDatabaseShape } from "./discard.ts";
import { PostgresStoreError } from "./errors.ts";
import { testCell, testPostgres } from "./testing/test-postgres.fixture.ts";

const T = 60_000;
const IMPORT = "im_0123456789abcdef";

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PostgresStoreError) return e.code;
    throw e;
  }
  return "no error";
}

describe("the staging database's name", () => {
  it("is the tenant's database name, `_`, and an import ID in lower-case Crockford", () => {
    const shape = stagingDatabaseShape("t1");
    expect(shape.test(`t1_${IMPORT}`)).toBe(true);
    for (const other of [
      `t2_${IMPORT}`,
      `t1_x_${IMPORT}`,
      `t1_${IMPORT.toUpperCase()}`,
      "t1_im_0123456789abcdeu", // u is not a Crockford character
      `t1_${IMPORT}0`,
      "t1",
    ]) {
      expect(shape.test(other), other).toBe(false);
    }
  });
});

describe("the guard, before anything reaches a server", () => {
  const refused = (o: Parameters<typeof checkDiscard>[0]) => {
    try {
      checkDiscard(o);
    } catch (e) {
      if (e instanceof PostgresStoreError) return e.code;
      throw e;
    }
    return "allowed";
  };

  it("checks the tenant's database name before it goes into the staging shape", () => {
    // Read as a pattern, `t1|x` would match `t1zzz`: a database of another name dropped.
    expect(refused({ tenantDatabase: "t1|x", current: "t2", database: "t1zzz" })).toBe(
      "discard_refused",
    );
    expect(refused({ tenantDatabase: "t1.", current: "t2", database: `t1a_${IMPORT}` })).toBe(
      "discard_refused",
    );
    expect(refused({ tenantDatabase: "t1", current: "t1", database: `t1_${IMPORT}` })).toBe(
      "allowed",
    );
  });

  it("refuses the database the directory names, whichever of the tenant's two it is", () => {
    // The import refused or rolled back: the directory names the tenant's own database.
    expect(refused({ tenantDatabase: "t1", current: "t1", database: "t1" })).toBe(
      "discard_refused",
    );
    // The import done: the directory names the staging database.
    expect(
      refused({ tenantDatabase: "t1", current: `t1_${IMPORT}`, database: `t1_${IMPORT}` }),
    ).toBe("discard_refused");
    // The other one of the two, in each case, may go.
    expect(refused({ tenantDatabase: "t1", current: `t1_${IMPORT}`, database: "t1" })).toBe(
      "allowed",
    );
  });

  it("refuses a name with anything before the tenant's database name", () => {
    expect(refused({ tenantDatabase: "t1", current: "t1", database: `xt1_${IMPORT}` })).toBe(
      "discard_refused",
    );
    expect(refused({ tenantDatabase: "t1", current: "t1", database: "xt1" })).toBe(
      "discard_refused",
    );
  });

  it("refuses the server's own databases, as the tenant's or as the one dropped", () => {
    for (const own of ["postgres", "template0", "template1"]) {
      expect(refused({ tenantDatabase: own, current: "t2", database: own }), own).toBe(
        "discard_refused",
      );
      expect(refused({ tenantDatabase: "t1", current: "t1", database: own }), own).toBe(
        "discard_refused",
      );
    }
  });
});

const cell = testCell();

describe.skipIf(cell === undefined)("against a server", () => {
  const pg = testPostgres(cell);

  const exists = async (name: string) =>
    (await pg.admin("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rows.length === 1;
  const made = async (...names: string[]) => {
    for (const n of names) await pg.admin(`CREATE DATABASE "${n}"`);
  };

  it("drops the tenant's staging database, and the one an import replaced once the directory names the staging one", async () => {
    // Each drop waits for a checkpoint, behind every other file's writes on a busy server: the
    // two cases below run at once, so that their drops share one, and the case has the time a
    // group of drops is given at the run's end (vitest.config `teardownTimeout`).
    const rolledBack = { tenant: pg.name(), staging: "" };
    rolledBack.staging = `${rolledBack.tenant}_${IMPORT}`;
    const done = { tenant: pg.name(), staging: "" };
    done.staging = `${done.tenant}_${IMPORT}`;
    await made(rolledBack.tenant, rolledBack.staging, done.tenant, done.staging);
    await Promise.all([
      // The import refused or rolled back: the directory still names the tenant's database.
      discardDatabase(pg.cell, {
        tenantDatabase: rolledBack.tenant,
        current: rolledBack.tenant,
        database: rolledBack.staging,
      }),
      // The import done: the directory names the staging database, the replaced one goes.
      discardDatabase(pg.cell, {
        tenantDatabase: done.tenant,
        current: done.staging,
        database: done.tenant,
      }),
    ]);
    expect(await exists(rolledBack.staging)).toBe(false);
    expect(await exists(rolledBack.tenant)).toBe(true);
    expect(await exists(done.tenant)).toBe(false);
    expect(await exists(done.staging)).toBe(true);
    // Gone already (a drop run again after a crash): nothing to do.
    await discardDatabase(pg.cell, {
      tenantDatabase: done.tenant,
      current: done.staging,
      database: done.tenant,
    });
  }, 300_000);

  it(
    "refuses the database the directory names, whichever of the two it is; nothing dropped",
    async () => {
      const tenant = pg.name();
      const staging = `${tenant}_${IMPORT}`;
      await made(tenant, staging);
      expect(
        await codeOf(
          discardDatabase(pg.cell, { tenantDatabase: tenant, current: tenant, database: tenant }),
        ),
      ).toBe("discard_refused");
      expect(
        await codeOf(
          discardDatabase(pg.cell, { tenantDatabase: tenant, current: staging, database: staging }),
        ),
      ).toBe("discard_refused");
      expect([await exists(tenant), await exists(staging)]).toEqual([true, true]);
    },
    T,
  );

  it(
    "refuses a database not of the tenant: another tenant's, its staging one, any other name; nothing dropped",
    async () => {
      const tenant = pg.name();
      const other = pg.name();
      const othersStaging = `${other}_${IMPORT}`;
      const near = `${tenant}_x`;
      await made(tenant, other, othersStaging, near);
      for (const database of [other, othersStaging, near]) {
        expect(
          await codeOf(
            discardDatabase(pg.cell, { tenantDatabase: tenant, current: tenant, database }),
          ),
          database,
        ).toBe("discard_refused");
      }
      // A tenant's database name no database may have, given as the database too: the shape
      // matches it, the name check does not.
      expect(
        await codeOf(
          discardDatabase(pg.cell, {
            tenantDatabase: `${tenant}"`,
            current: tenant,
            database: `${tenant}"`,
          }),
        ),
      ).toBe("discard_refused");
      // A name no database may have: refused before anything reaches the server.
      expect(
        await codeOf(
          discardDatabase(pg.cell, {
            tenantDatabase: tenant,
            current: tenant,
            database: `${tenant}" WITH (FORCE); --`,
          }),
        ),
      ).toBe("discard_refused");
      expect(await Promise.all([tenant, other, othersStaging, near].map(exists))).toEqual([
        true,
        true,
        true,
        true,
      ]);
    },
    T,
  );
});
