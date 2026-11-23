// Another connection to the database a test store's directory stands for, on PostgreSQL only: plain
// transactions over store-postgres's connection, with no store opened on it (no ownership epoch
// taken, nothing of the kernel's checked). For tests of what holds when two connections write the
// same database at the same time; PGlite has one connection to a database and cannot give this.

import type { QueryResult, ReadTx, SqlValue, Tx } from "@fluxvita/saveslot-kernel";
import { Connection } from "../../store-postgres/src/connection.ts";
import { cellFromEnv } from "../../store-postgres/src/testing/server.fixture.ts";
import { databaseOf, TEST_BACKEND } from "./index.fixture.ts";

/** Read and write transactions on one connection, one at a time, as a store's. */
export interface SecondConnection {
  read<T>(fn: (tx: ReadTx) => Promise<T>): Promise<T>;
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /** Called once when the connection goes away before `close`. */
  onLost(listener: () => void): void;
}

/** A connection of its own to the database of `dir` (which a test store made). */
export async function secondConnection(dir: string): Promise<SecondConnection> {
  const cell = cellFromEnv();
  if (TEST_BACKEND !== "postgres" || cell === undefined) {
    throw new Error("a second connection is only on PostgreSQL");
  }
  const conn = await Connection.connect(cell, databaseOf(dir));
  const tx: Tx = {
    query: async <R>(sql: string, params?: readonly SqlValue[]): Promise<QueryResult<R>> => {
      const r = await conn.run(sql, params ?? []);
      return { rows: r.rows as R[] };
    },
    exec: async (sql: string) => {
      await conn.run(sql);
    },
  };
  let tail: Promise<unknown> = Promise.resolve();
  const run = <T>(begin: string, fn: (tx: Tx) => Promise<T>): Promise<T> => {
    const p = tail.then(async () => {
      await conn.run(begin);
      try {
        const r = await fn(tx);
        await conn.run("COMMIT");
        return r;
      } catch (e) {
        await conn.run("ROLLBACK").catch(() => {});
        throw e;
      }
    });
    tail = p.catch(() => undefined);
    return p;
  };
  return {
    read: (fn) => run("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", fn),
    write: (fn) => run("BEGIN", fn),
    close: () => conn.end(),
    onLost: (listener) => conn.onGone(listener),
  };
}
