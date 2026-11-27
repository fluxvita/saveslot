// The edges a server is not needed for, and could not be made to show on demand: what the store
// says when the connection ends at each point of a transaction, when the server answers a COMMIT
// with a ROLLBACK or by ending the session, and what opening says of a server too old to ask.
// The driver's client is a stand-in that answers as a server would and fails where it is told to.

import { EventEmitter } from "node:events";
import { META_KEYS, SESSION_SETTINGS, STORAGE_FORMAT_VERSION } from "@fluxvita/saveslot-kernel";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { PostgresBackend, type PostgresTenantStore } from "./backend.ts";
import { Connection, type DriverClient, Gone } from "./connection.ts";
import { PostgresStoreError } from "./errors.ts";

/** An error as the server sends one. */
function serverError(severity: "ERROR" | "FATAL" | "PANIC", code: string, message = "refused") {
  return Object.assign(new pg.DatabaseError(message, message.length, "error"), { severity, code });
}

type Answer = { rows?: unknown[]; command?: string; rowCount?: number } | Error | undefined;

class StandIn extends EventEmitter implements DriverClient {
  /** Every statement sent, by its first words. */
  readonly sent: string[] = [];
  version = 180007;
  /** Answers a statement in place of the server's usual answer; undefined leaves it to that. */
  script: (sql: string) => Answer | Promise<Answer> = () => undefined;
  connecting: () => void = () => {};

  async connect(): Promise<void> {
    this.connecting();
  }

  #queue: Promise<unknown> = Promise.resolve();
  /** Queries asked for and not yet answered, and the most there were at once. */
  inFlight = 0;
  mostInFlight = 0;

  /**
   * One statement at a time, in the order asked, as on a connection: the driver queues a query
   * asked for while another runs, which it deprecates. `mostInFlight` shows whether it was asked.
   */
  query(q: string | pg.QueryConfig): Promise<unknown> {
    this.inFlight++;
    this.mostInFlight = Math.max(this.mostInFlight, this.inFlight);
    const answered = this.#queue.then(() => this.#answer(q));
    this.#queue = answered.catch(() => {});
    return answered.finally(() => {
      this.inFlight--;
    });
  }

  async #answer(q: string | pg.QueryConfig): Promise<unknown> {
    const sql = (typeof q === "string" ? q : q.text).trim().replace(/\s+/g, " ");
    const values = typeof q === "string" ? [] : (q.values ?? []);
    this.sent.push(sql.split(" ").slice(0, 3).join(" "));
    const scripted = await this.script(sql);
    if (scripted instanceof Error) throw scripted;
    const a = scripted ?? this.#usual(sql, values);
    return {
      rows: a.rows ?? [],
      command: a.command ?? sql.split(" ")[0],
      rowCount: a.rowCount ?? 0,
    };
  }

  #usual(sql: string, values: unknown[]): Exclude<Answer, Error | undefined> {
    if (sql.includes("server_version_num")) return { rows: [{ version: this.version }] };
    if (sql.includes("server_encoding")) {
      // A server before 17 has no pg_database.datlocale.
      if (this.version < 170000)
        throw serverError("ERROR", "42703", "column d.datlocale does not exist");
      return {
        rows: [{ encoding: "UTF8", provider: "b", locale: "C.UTF-8", collate: "C", ctype: "C" }],
      };
    }
    if (sql.includes("c.relname = 'meta'")) return { rows: [{ ok: true }] };
    if (sql.startsWith("SELECT value FROM meta")) {
      const value = {
        [META_KEYS.storageFormat]: String(STORAGE_FORMAT_VERSION),
        [META_KEYS.sessionSettings]: JSON.stringify(SESSION_SETTINGS),
        [META_KEYS.ownershipEpoch]: "1",
      }[String(values[0])];
      return { rows: value === undefined ? [] : [{ value }] };
    }
    // What each read and write checks first: the format, no seal.
    if (sql.startsWith("SELECT key, value FROM meta")) {
      return { rows: [{ key: META_KEYS.storageFormat, value: String(STORAGE_FORMAT_VERSION) }] };
    }
    if (sql.startsWith("INSERT INTO meta")) return { rows: [{ value: "1" }] };
    return {};
  }

  async end(): Promise<void> {
    this.emit("end");
  }
}

const REF = { kind: "postgres", database: "tenant_a", cell: "here" } as const;
const CELLS = { cells: { here: { host: "stand-in", user: "u" } } };

/** A store opened on a stand-in client. */
async function opened(): Promise<{ store: PostgresTenantStore; client: StandIn }> {
  const client = new StandIn();
  const store = await new PostgresBackend(CELLS, () => client).open(REF, {});
  client.sent.length = 0;
  return { store, client };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PostgresStoreError) return e.code;
    throw e;
  }
  return "no error";
}

describe("a connection that ends, by where the transaction was", () => {
  for (const how of ["end", "error"] as const) {
    it(`while the callback ran, with no statement after (${how}): connection_lost, and COMMIT is never sent`, async () => {
      const { store, client } = await opened();
      const code = await codeOf(
        store.write(async (tx) => {
          await tx.query("INSERT INTO t VALUES (1)");
          // The server ends the idle session (a timeout, an administrator).
          if (how === "end") client.emit("end");
          else client.emit("error", new Error("read ECONNRESET"));
        }),
      );
      expect(code).toBe("connection_lost");
      expect(client.sent).toEqual([
        "BEGIN",
        "SELECT pg_advisory_xact_lock(1397967956, 1)",
        "SELECT key, value",
        "INSERT INTO t",
      ]);
      expect(await codeOf(store.write(async () => {}))).toBe("connection_lost");
    });
  }

  it("under the COMMIT, after it was sent: commit_unknown", async () => {
    const { store, client } = await opened();
    client.script = (sql) =>
      sql === "COMMIT" ? new Error("Connection terminated unexpectedly") : undefined;
    expect(await codeOf(store.write((tx) => tx.query("INSERT INTO t VALUES (1)")))).toBe(
      "commit_unknown",
    );
    expect(client.sent.at(-1)).toBe("COMMIT");
    expect(await codeOf(store.read(async () => {}))).toBe("connection_lost");
  });

  it("under a statement of the transaction: connection_lost", async () => {
    const { store, client } = await opened();
    client.script = (sql) => (sql.startsWith("INSERT") ? new Error("write EPIPE") : undefined);
    expect(await codeOf(store.write((tx) => tx.query("INSERT INTO t VALUES (1)")))).toBe(
      "connection_lost",
    );
    expect(client.sent).not.toContain("COMMIT");
  });

  it("under a read's COMMIT: connection_lost, there being nothing to be in doubt about", async () => {
    const { store, client } = await opened();
    client.script = (sql) =>
      sql === "COMMIT" ? new Error("Connection terminated unexpectedly") : undefined;
    expect(await codeOf(store.read((tx) => tx.query("SELECT 1")))).toBe("connection_lost");
  });
});

describe("a server that ends the session with an error", () => {
  for (const [severity, code] of [
    ["FATAL", "53200"],
    ["FATAL", "XX000"],
    ["PANIC", "58030"],
    ["FATAL", "57P04"],
    ["FATAL", "57P01"],
  ] as const) {
    it(`${severity} ${code} in answer to COMMIT: commit_unknown, not a refusal`, async () => {
      const { store, client } = await opened();
      client.script = (sql) => (sql === "COMMIT" ? serverError(severity, code) : undefined);
      const e = await store
        .write((tx) => tx.query("INSERT INTO t VALUES (1)"))
        .catch((x: unknown) => x);
      expect((e as PostgresStoreError).code).toBe("commit_unknown");
      expect((e as PostgresStoreError).sqlState).toBe(code);
      expect(await codeOf(store.write(async () => {}))).toBe("connection_lost");
    });
  }

  it("FATAL in answer to a statement: connection_lost, and the store is failed", async () => {
    const { store, client } = await opened();
    client.script = (sql) => (sql.startsWith("INSERT") ? serverError("FATAL", "53200") : undefined);
    expect(await codeOf(store.write((tx) => tx.query("INSERT INTO t VALUES (1)")))).toBe(
      "connection_lost",
    );
    expect(await codeOf(store.write(async () => {}))).toBe("connection_lost");
  });

  it("the same SQLSTATE as an ERROR is a refusal: query_failed, and the store goes on", async () => {
    const { store, client } = await opened();
    client.script = (sql) => (sql.startsWith("INSERT") ? serverError("ERROR", "53200") : undefined);
    const e = await store
      .write((tx) => tx.query("INSERT INTO t VALUES (1)"))
      .catch((x: unknown) => x);
    expect((e as PostgresStoreError).code).toBe("query_failed");
    expect((e as PostgresStoreError).sqlState).toBe("53200");
    client.script = () => undefined;
    expect(await codeOf(store.write((tx) => tx.query("INSERT INTO t VALUES (2)")))).toBe(
      "no error",
    );
  });

  it("an ERROR in answer to COMMIT (a deferred constraint): query_failed, not in doubt", async () => {
    const { store, client } = await opened();
    client.script = (sql) => (sql === "COMMIT" ? serverError("ERROR", "23503") : undefined);
    const e = await store
      .write((tx) => tx.query("INSERT INTO t VALUES (1)"))
      .catch((x: unknown) => x);
    expect((e as PostgresStoreError).code).toBe("query_failed");
    client.script = () => undefined;
    expect(await codeOf(store.write(async () => {}))).toBe("no error");
  });
});

describe("statements on one connection, one at a time", () => {
  /** A connection over a stand-in client, as a store's or the control database's. */
  async function connected(): Promise<{ conn: Connection; client: StandIn }> {
    const client = new StandIn();
    const conn = await Connection.connect(CELLS.cells.here, "tenant_a", () => client);
    client.sent.length = 0;
    client.mostInFlight = 0;
    return { conn, client };
  }

  it("statements a transaction asks for at once go to the driver one at a time, and answer in order", async () => {
    const { store, client } = await opened();
    client.mostInFlight = 0;
    client.script = async (sql) => {
      const m = /^SELECT (\d+) AS i$/.exec(sql);
      if (m === null) return undefined;
      // The earlier ones take longer: answers out of order would show.
      await new Promise((r) => setTimeout(r, 25 - 5 * Number(m[1])));
      return { rows: [{ i: Number(m[1]) }] };
    };
    const got = await store.read((tx) =>
      Promise.all(
        [0, 1, 2, 3, 4].map(async (i) => (await tx.query(`SELECT ${i} AS i`)).rows[0]?.["i"]),
      ),
    );
    expect(got).toEqual([0, 1, 2, 3, 4]);
    expect(client.mostInFlight).toBe(1);
  });

  it("a statement the database refuses does not hold up the next", async () => {
    const { conn, client } = await connected();
    client.script = (sql) =>
      sql.startsWith("SELECT 1 / 0")
        ? serverError("ERROR", "22012", "division by zero")
        : undefined;
    const [a, b, c] = await Promise.allSettled([
      conn.run("SELECT 1"),
      conn.run("SELECT 1 / 0"),
      conn.run("SELECT 2"),
    ]);
    expect([a.status, b.status, c.status]).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(client.sent).toEqual(["SELECT 1", "SELECT 1 /", "SELECT 2"]);
    expect(client.mostInFlight).toBe(1);
    await conn.end();
  });

  it("statements still waiting when the connection ends are not sent: they throw Gone", async () => {
    const { conn, client } = await connected();
    let answer = () => {};
    client.script = (sql) =>
      sql === "SELECT 1"
        ? new Promise<undefined>((r) => {
            answer = () => r(undefined);
          })
        : undefined;
    const first = conn.run("SELECT 1");
    const waiting = [conn.run("SELECT 2"), conn.run("SELECT 3")];
    await new Promise((r) => setTimeout(r, 10));
    await conn.end();
    answer();
    await first.catch(() => {});
    for (const w of waiting) {
      const e = await w.then(
        () => undefined,
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(Gone);
      expect((e as Gone).sent).toBe(false);
    }
    expect(client.sent).toEqual(["SELECT 1"]);
  });
});

describe("a COMMIT the server answers with ROLLBACK", () => {
  it("is transaction_failed: the transaction was aborted, though no error reached the callback's end", async () => {
    const { store, client } = await opened();
    client.script = (sql) => (sql === "COMMIT" ? { command: "ROLLBACK" } : undefined);
    expect(await codeOf(store.write((tx) => tx.query("INSERT INTO t VALUES (1)")))).toBe(
      "transaction_failed",
    );
    // The connection is as good as it was.
    client.script = () => undefined;
    expect(await codeOf(store.write(async () => {}))).toBe("no error");
  });

  it("a failing statement the callback did not wait for: transaction_failed, not a commit", async () => {
    const { store, client } = await opened();
    let aborted = false;
    client.script = async (sql) => {
      if (sql.startsWith("SELECT 1 / 0")) {
        // Answered after the callback has returned.
        await new Promise((r) => setTimeout(r, 20));
        aborted = true;
        return serverError("ERROR", "22012", "division by zero");
      }
      // As the server does in an aborted transaction.
      if (sql === "COMMIT" && aborted) return { command: "ROLLBACK" };
      return undefined;
    };
    const code = await codeOf(
      store.write(async (tx) => {
        await tx.query("INSERT INTO t VALUES (1)");
        void tx.query("SELECT 1 / 0").catch(() => {});
      }),
    );
    expect(code).toBe("transaction_failed");
  });

  it("in a read too", async () => {
    const { store, client } = await opened();
    client.script = (sql) => (sql === "COMMIT" ? { command: "ROLLBACK" } : undefined);
    expect(await codeOf(store.read((tx) => tx.query("SELECT 1")))).toBe("transaction_failed");
  });
});

describe("opening, where a server cannot be made to show it", () => {
  it("an older server: unsupported_server_version, asked before anything it would not know", async () => {
    for (const version of [160004, 150008, 170012, 190000]) {
      const client = new StandIn();
      client.version = version;
      const code = await codeOf(
        new PostgresBackend(CELLS, () => client).open(REF, { create: true }),
      );
      expect(code, String(version)).toBe("unsupported_server_version");
      // Nothing after the version was asked: no setting, no catalog of this version's.
      expect(client.sent.filter((s) => !s.includes("typarray"))).toEqual([
        "SELECT current_setting('server_version_num')::int4 AS",
      ]);
    }
  });

  it("this backend's settings come before the kernel's, and both before the database is looked at", async () => {
    const client = new StandIn();
    await new PostgresBackend(CELLS, () => client).open(REF, {});
    const sets = client.sent.filter((s) => s.startsWith("SET"));
    expect(sets.slice(0, 2)).toEqual(["SET search_path =", "SET bytea_output ="]);
    expect(sets).toHaveLength(6 + SESSION_SETTINGS.length);
    const firstCatalog = client.sent.findIndex((s) => s.includes("server_encoding"));
    const lastSet = client.sent.findLastIndex((s) => s.startsWith("SET"));
    expect(lastSet).toBeLessThan(firstCatalog);
  });

  /** A backend whose clients are made per database: `refuse` says which fail to connect, and how. */
  function backendBy(by: (database: string) => { connect?: Error; create?: Error }) {
    const made: string[] = [];
    const backend = new PostgresBackend(CELLS, (config) => {
      const database = String(config.database);
      made.push(database);
      const client = new StandIn();
      const how = by(database);
      if (how.connect) {
        const e = how.connect;
        client.connecting = () => {
          throw e;
        };
      }
      client.script = (sql) => (sql.startsWith("CREATE DATABASE") ? how.create : undefined);
      return client;
    });
    return { backend, made };
  }

  it("no database, create asked, and no maintenance database to make it on: database_not_created", async () => {
    const missing = serverError("FATAL", "3D000", "database does not exist");
    const { backend, made } = backendBy(() => ({ connect: missing }));
    const e = await backend.open(REF, { create: true }).catch((x: unknown) => x);
    expect((e as PostgresStoreError).code).toBe("database_not_created");
    expect((e as PostgresStoreError).sqlState).toBe("3D000");
    expect((e as Error).message).toContain("maintenance database postgres");
    expect(made).toEqual(["tenant_a", "postgres"]);
    // Without create it is the tenant's database that is missing.
    expect(await codeOf(backendBy(() => ({ connect: missing })).backend.open(REF, {}))).toBe(
      "store_not_found",
    );
  });

  it("no database, create asked, and CREATE DATABASE refused: database_not_created, with why", async () => {
    const { backend } = backendBy((database) =>
      database === "tenant_a"
        ? { connect: serverError("FATAL", "3D000", "database does not exist") }
        : { create: serverError("ERROR", "42501", "permission denied to create database") },
    );
    const e = await backend.open(REF, { create: true }).catch((x: unknown) => x);
    expect((e as PostgresStoreError).code).toBe("database_not_created");
    expect((e as PostgresStoreError).sqlState).toBe("42501");
  });

  it("the server's own databases and the cell's maintenance database are no tenant's", async () => {
    const client = new StandIn();
    const backend = new PostgresBackend(
      { cells: { here: { host: "stand-in", user: "u", maintenanceDatabase: "ops" } } },
      () => client,
    );
    for (const database of ["postgres", "template0", "template1", "ops"]) {
      expect(await codeOf(backend.open({ ...REF, database }, { create: true })), database).toBe(
        "bad_database_name",
      );
    }
    expect(client.sent).toEqual([]);
  });
});
