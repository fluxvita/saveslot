// The server mode's control database (docs/zh-CN/spec/02-architecture.md §5 «控制面存储»): a
// PostgreSQL database of its own, opened as a plain connection with read and write transactions,
// one at a time in the order asked. Not a tenant's storage: no kernel tables, no ownership epoch, no
// kernel session settings checked. The service's control plane runs its statements on it.
//
// Each transaction says its isolation, whatever the database's default: a write at READ COMMITTED
// (two connections' writes of one row take turns on its lock, not fail), a read at REPEATABLE READ,
// read only (its statements see one snapshot), as the control plane assumes of it.
//
// What is checked: the database's name (as a tenant's), the server's major version, and that it is
// not a tenant's storage (a control plane pointed at one by mistake would make its tables there and
// go on; refused, the mistake shows when the service starts). A connection
// that goes away leaves the control database failed: every later call refuses, and the host opens
// it again.

import type { QueryResult, ReadTx, SqlValue, Tx } from "@fluxvita/saveslot-kernel";
import { checkVersion, connectOrCreate, DATABASE_NAME, hasMeta } from "./backend.ts";
import type { Connection, MakeClient, PostgresCell } from "./connection.ts";
import { PostgresStoreError } from "./errors.ts";

/** The control database: read and write transactions, as a tenant store has, and closing. */
export interface ControlDatabase {
  read<T>(fn: (tx: ReadTx) => Promise<T>): Promise<T>;
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Opens the control database of a cell; with `create`, makes it when it is not there. */
export async function openControlDatabase(
  cell: PostgresCell,
  database: string,
  opts: { readonly create?: boolean } = {},
  make?: MakeClient,
): Promise<ControlDatabase> {
  if (!DATABASE_NAME.test(database)) {
    throw new PostgresStoreError("bad_database_name", `not a database name this backend takes`);
  }
  const conn = await connectOrCreate(cell, database, opts.create === true, make);
  try {
    await checkVersion(conn);
    if (await hasMeta(conn)) {
      throw new PostgresStoreError("tenant_storage", `${database} is a tenant's storage`);
    }
  } catch (e) {
    await conn.end().catch(() => {});
    throw e;
  }
  return new PlainDatabase(conn);
}

class PlainDatabase implements ControlDatabase {
  readonly #conn: Connection;
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(conn: Connection) {
    this.#conn = conn;
  }

  #run<T>(begin: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("the control database is closed"));
    const conn = this.#conn;
    const tx: Tx = {
      query: async <R>(sql: string, params?: readonly SqlValue[]): Promise<QueryResult<R>> => {
        const r = await conn.run(sql, params ?? []);
        return {
          rows: r.rows as R[],
          ...(r.rowCount !== null && r.command !== "SELECT" ? { affectedRows: r.rowCount } : {}),
        };
      },
      exec: async (sql: string) => {
        await conn.run(sql);
      },
    };
    const p = this.#tail.then(async () => {
      await conn.run(begin);
      let result: T;
      try {
        result = await fn(tx);
      } catch (e) {
        await conn.run("ROLLBACK").catch(() => {});
        throw e;
      }
      await conn.run("COMMIT");
      return result;
    });
    this.#tail = p.catch(() => undefined);
    return p;
  }

  read<T>(fn: (tx: ReadTx) => Promise<T>): Promise<T> {
    return this.#run("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", fn);
  }

  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#run("BEGIN ISOLATION LEVEL READ COMMITTED", fn);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    await this.#conn.end();
  }
}
