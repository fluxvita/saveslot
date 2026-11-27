// The server mode's import holders (02-architecture §8 «格式版本、导出、导入与恢复», the import's
// hold across processes): an import holds its tenant by a session advisory lock on a control
// database connection of its own, and says so in the tenant directory (`tenants.import_holder`,
// written after the lock is taken and cleared before it is released). A use of the tenant that
// finds the mark asks whether another session holds the lock: held, the tenant is being imported
// into; free, the import's process ended, and the finder, once it holds the lock itself, finishes
// it by the re-entry rules.
//
// The lock's key is the first 8 bytes of the tenant ID's SHA-256, as a bigint (02-architecture §5
// `tenants`). Two tenants' keys alike is not ruled out: then an import of one is taken for one of
// the other (`busy`), or the other's holder for alive; nothing is lost either way.

import { createHash } from "node:crypto";
import type { TenantId } from "./control-plane.ts";
import type { ControlDb } from "./server-control-plane.ts";

/** A control database connection of the holder's own: closing it releases its session locks. */
export interface HolderConnection extends ControlDb {
  close(): Promise<void>;
}

/** The holder lock's key of a tenant: its ID's SHA-256, the first 8 bytes, signed. */
export function holderLockKey(tenant: string): bigint {
  return createHash("sha256").update(tenant, "utf8").digest().readBigInt64BE(0);
}

/** The key as `pg_locks` shows a bigint advisory lock: its high and low 32 bits. */
function lockParts(key: bigint): [string, string] {
  const u = BigInt.asUintN(64, key);
  return [(u >> 32n).toString(), (u & 0xffff_ffffn).toString()];
}

/** An import's hold of a tenant: the lock, on a connection of its own. */
export interface ImportHold {
  /** Writes the tenant's mark: this import holds it. */
  mark(importId: string): Promise<void>;
  /** Clears the tenant's mark, whoever's it was: last, before `release`. */
  clear(): Promise<void>;
  /** Releases the lock and closes the connection. */
  release(): Promise<void>;
}

export interface ImportHolders {
  /** Whether a session other than the control database's own holds the tenant's holder lock. */
  held(tenant: TenantId): Promise<boolean>;
  /** The holder lock taken on a connection of its own; undefined when another session holds it. */
  take(tenant: TenantId): Promise<ImportHold | undefined>;
}

/** The holders over the control database `db`, each hold on a connection `open` gives. */
export function controlImportHolders(o: {
  readonly db: ControlDb;
  readonly open: () => Promise<HolderConnection>;
}): ImportHolders {
  return {
    held: async (tenant) => {
      const [hi, lo] = lockParts(holderLockKey(tenant));
      const r = await o.db.read((tx) =>
        tx.query<{ held: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_locks
             WHERE locktype = 'advisory' AND granted AND classid = $1::oid AND objid = $2::oid
               AND objsubid = 1 AND pid <> pg_backend_pid()
               AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
           ) AS held`,
          [hi, lo],
        ),
      );
      return r.rows[0]?.held === true;
    },
    take: async (tenant) => {
      const key = holderLockKey(tenant).toString();
      const conn = await o.open();
      let got = false;
      try {
        const r = await conn.write((tx) =>
          tx.query<{ got: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS got", [key]),
        );
        got = r.rows[0]?.got === true;
      } finally {
        if (!got) await conn.close().catch(() => {});
      }
      if (!got) return undefined;
      return {
        mark: async (importId) => {
          await conn.write((tx) =>
            tx.query("UPDATE tenants SET import_holder = $2 WHERE id = $1", [tenant, importId]),
          );
        },
        clear: async () => {
          await conn.write((tx) =>
            tx.query("UPDATE tenants SET import_holder = NULL WHERE id = $1", [tenant]),
          );
        },
        release: async () => {
          // Closing the connection releases it; unlocked first for a connection the host keeps.
          await conn
            .write((tx) => tx.query("SELECT pg_advisory_unlock($1::bigint)", [key]))
            .catch(() => {});
          await conn.close().catch(() => {});
        },
      };
    },
  };
}
