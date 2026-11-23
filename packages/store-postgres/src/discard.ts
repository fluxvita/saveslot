// Dropping a tenant's database an import leaves behind (docs/zh-CN/spec/02-architecture.md §8
// «格式版本、导出、导入与恢复» steps ② and ⑤, «重入»; §5 «租户目录»): its staging database, when the
// import is refused or rolled back, and the database it replaced, which held the genesis event only.
//
// A drop cannot be undone, so the name is checked against what the tenant's own databases can be
// called, and never the one the tenant directory names now:
// - a staging database: the tenant's database name, `_`, and the import ID in lower case
//   (`<tenant>_im_<16 Crockford characters>`);
// - the database an import replaced: the tenant's database name itself, once the directory names
//   the staging one instead.
// Anything else is refused (`discard_refused`) and nothing is dropped. A database of that shape the
// directory no longer names and nothing dropped (a crash between the swap and the drop) is
// recognised by the same shape.

import { DATABASE_NAME, SERVER_DATABASES } from "./backend.ts";
import { Connection, type PostgresCell } from "./connection.ts";
import { PostgresStoreError } from "./errors.ts";

/** The staging database names of the tenant whose database is `tenantDatabase`. */
export const stagingDatabaseShape = (tenantDatabase: string): RegExp =>
  new RegExp(`^${tenantDatabase}_im_[0-9a-hjkmnp-tv-z]{16}$`);

/** What a drop is asked: the database, and what tells whether it is the tenant's to drop. */
export interface DiscardRequest {
  /** The tenant's own database name (the server mode's `databaseOf`). */
  readonly tenantDatabase: string;
  /** The database the tenant's directory entry names now. */
  readonly current: string;
  readonly database: string;
}

/**
 * `discardDatabase`'s guard, nothing dropped: refuses (`discard_refused`) unless `database` is the
 * tenant's staging database or the one an import replaced, and not `current`. Both names must be
 * names a database may have, and neither one of the server's own (`postgres`, the templates); the
 * tenant's is checked before it goes into the staging shape.
 */
export function checkDiscard(o: DiscardRequest): void {
  const named = (n: string) => DATABASE_NAME.test(n) && !SERVER_DATABASES.includes(n);
  const own =
    named(o.tenantDatabase) &&
    (o.database === o.tenantDatabase || stagingDatabaseShape(o.tenantDatabase).test(o.database));
  if (!named(o.database) || !own || o.database === o.current) {
    throw new PostgresStoreError(
      "discard_refused",
      o.database === o.current
        ? "the database is the one the tenant's directory names"
        : "the database is not one of the tenant's to discard",
    );
  }
}

/**
 * Drops `database` of the cell, waiting for the connections to it to be ended (`WITH (FORCE)`);
 * nothing when it is not there. Refused first by {@link checkDiscard}.
 */
export async function discardDatabase(cell: PostgresCell, o: DiscardRequest): Promise<void> {
  checkDiscard(o);
  const c = await Connection.connect(cell, cell.maintenanceDatabase ?? "postgres");
  try {
    await c.run(`DROP DATABASE IF EXISTS "${o.database}" WITH (FORCE)`);
  } finally {
    await c.end();
  }
}
