// One connection to a database of a cell: statements one at a time, values as ./values.ts gives
// them, and an error that says whether the database refused a statement or the connection is gone.

import type { ConnectionOptions } from "node:tls";
import type { SqlValue } from "@fluxvita/saveslot-kernel";
import pg from "pg";
import { ARRAY_TYPES_SQL, type ArrayType, parameter, parsers } from "./values.ts";

/**
 * How the databases of a cell are reached. The database's name is the tenant's, not here.
 *
 * What is left out here is not left to nothing: the driver then looks where libpq would. Without
 * `password`, PGPASSWORD and then `~/.pgpass`; without `port`, PGPORT; without `ssl`, PGSSLMODE.
 * A host that must not take anything from the process's environment gives all of them.
 */
export interface PostgresCell {
  /** A host name or address, or the directory of a Unix-domain socket. */
  readonly host: string;
  readonly port?: number;
  readonly user: string;
  /** Given by the host of the backend; never written into an error or a log by it. */
  readonly password?: string | (() => string | Promise<string>);
  readonly ssl?: boolean | ConnectionOptions;
  /** The database to connect to for creating a tenant's (default `postgres`). */
  readonly maintenanceDatabase?: string;
  /** How long a connection attempt may take, in milliseconds (default 10 000). */
  readonly connectTimeoutMs?: number;
}

export interface Result {
  readonly rows: Record<string, unknown>[];
  readonly command: string | null;
  readonly rowCount: number | null;
}

/** What this module asks of the driver's client (a test gives one of its own). */
export interface DriverClient {
  connect(): Promise<unknown>;
  query(q: string | pg.QueryConfig): Promise<unknown>;
  end(): Promise<void>;
  on(event: "error", listener: (e: Error) => void): unknown;
  on(event: "end", listener: () => void): unknown;
}

export type MakeClient = (config: pg.ClientConfig) => DriverClient;

const driverClient: MakeClient = (config) => new pg.Client(config);

/** The database refused a statement, and the connection goes on. */
export class Refused extends Error {
  readonly sqlState: string;
  constructor(message: string, sqlState: string, cause: unknown) {
    super(message, { cause });
    this.sqlState = sqlState;
  }
}

/** The connection is gone: it could not be made, was ended by the server, or broke. */
export class Gone extends Error {
  /** The SQLSTATE the server gave as it ended the connection or refused it, if it gave one. */
  readonly sqlState: string | undefined;
  /**
   * Whether the statement that met this had been sent. False: the connection was known to be gone
   * before, and nothing was sent, so the statement certainly did not run.
   */
  readonly sent: boolean;
  constructor(message: string, sqlState: string | undefined, cause: unknown, sent: boolean) {
    super(message, { cause });
    this.sqlState = sqlState;
    this.sent = sent;
  }
}

/** SQLSTATEs with which a server ends a connection: class 08, and the shutdowns of class 57. */
const endsConnection = (sqlState: string): boolean =>
  sqlState.startsWith("08") || ["57P01", "57P02", "57P03"].includes(sqlState);

/**
 * An error of a statement that leaves the connection usable, as a refusal. Only an ERROR does:
 * the server closes the session after a FATAL or a PANIC whatever its SQLSTATE (out of memory, an
 * internal error), and an error that is not the server's is the socket's or the driver's.
 */
function refusal(e: unknown): Refused | undefined {
  if (!(e instanceof pg.DatabaseError) || e.code === undefined) return undefined;
  if (e.severity === "FATAL" || e.severity === "PANIC" || endsConnection(e.code)) return undefined;
  return new Refused(e.message, e.code, e);
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sqlStateOf = (e: unknown): string | undefined =>
  e instanceof pg.DatabaseError ? e.code : undefined;

interface Ending {
  readonly message: string;
  readonly sqlState: string | undefined;
  readonly cause: unknown;
}

export class Connection {
  readonly #client: DriverClient;
  #gone: Ending | undefined;
  #ended = false;
  readonly #onGone: (() => void)[] = [];
  /** The last statement asked for: the next one is sent once it has settled. */
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(client: DriverClient) {
    this.#client = client;
    // An error with no statement in flight (the server went away while the connection was idle).
    client.on("error", (e) => {
      this.#lose({ message: messageOf(e), sqlState: sqlStateOf(e), cause: e });
    });
    client.on("end", () => {
      this.#lose({ message: "the connection has ended", sqlState: undefined, cause: undefined });
    });
  }

  /**
   * Marks the connection gone and tells the listeners, the first time. After `end` it is gone
   * already, so they are not told.
   */
  #lose(why: Ending): void {
    if (this.#gone !== undefined) return;
    this.#gone = why;
    for (const f of this.#onGone.splice(0)) f();
  }

  /**
   * `listener` is called once when the connection goes away without `end` having been called: the
   * server ended it, or the network did. At once if it is gone already.
   */
  onGone(listener: () => void): void {
    if (this.#gone !== undefined) {
      if (!this.#ended) listener();
      return;
    }
    this.#onGone.push(listener);
  }

  /** Connects. Throws `Gone`, with the server's SQLSTATE when it refused (3D000: no such database). */
  static async connect(
    cell: PostgresCell,
    database: string,
    make: MakeClient = driverClient,
  ): Promise<Connection> {
    let parserOf = parsers([]);
    const client = make({
      host: cell.host,
      user: cell.user,
      database,
      application_name: "saveslot",
      connectionTimeoutMillis: cell.connectTimeoutMs ?? 10_000,
      ...(cell.port !== undefined ? { port: cell.port } : {}),
      ...(cell.password !== undefined ? { password: cell.password } : {}),
      ...(cell.ssl !== undefined ? { ssl: cell.ssl } : {}),
      // Every value by this backend's own parsers; the driver's are not consulted.
      types: {
        getTypeParser: (oid: number) => (text: string) => parserOf(oid)(text),
      } as unknown as pg.CustomTypesConfig,
    });
    const c = new Connection(client);
    try {
      await client.connect();
    } catch (e) {
      // A client that failed to connect holds nothing to end.
      client.end().catch(() => {});
      throw new Gone(messageOf(e), sqlStateOf(e), e, false);
    }
    try {
      const arrays = await c.run(ARRAY_TYPES_SQL);
      parserOf = parsers(arrays.rows as unknown as ArrayType[]);
    } catch (e) {
      await c.end();
      throw e;
    }
    return c;
  }

  get gone(): boolean {
    return this.#gone !== undefined;
  }

  /**
   * Runs `sql`. With `params` (even none) it is one statement by the extended protocol, as PGlite
   * runs a query; without, a script by the simple protocol, and the last statement's result.
   * Throws `Refused` when the database refuses it and goes on, `Gone` when the connection is gone
   * already (nothing is sent) or goes away under it.
   *
   * One statement at a time: one asked for while another runs is sent once that one has settled,
   * whatever it gave, so the driver never gets a query while it is executing one (which it queues
   * itself only as a deprecated behaviour). One still waiting when the connection ends is not sent:
   * it throws `Gone`.
   */
  run(sql: string, params?: readonly SqlValue[]): Promise<Result> {
    const r = this.#tail.then(() => this.#runNow(sql, params));
    this.#tail = r.catch(() => {});
    return r;
  }

  async #runNow(sql: string, params: readonly SqlValue[] | undefined): Promise<Result> {
    if (this.#gone) {
      throw new Gone(this.#gone.message, this.#gone.sqlState, this.#gone.cause, false);
    }
    try {
      const r =
        params === undefined
          ? await this.#client.query(sql)
          : await this.#client.query({
              text: sql,
              values: params.map(parameter),
              // The driver takes this; its type declarations do not list it.
              queryMode: "extended",
            } as pg.QueryConfig);
      const last = (Array.isArray(r) ? r[r.length - 1] : r) as pg.QueryResult | undefined;
      return {
        rows: (last?.rows ?? []) as Record<string, unknown>[],
        command: last?.command ?? null,
        rowCount: last?.rowCount ?? null,
      };
    } catch (e) {
      const refused = refusal(e);
      if (refused) throw refused;
      this.#lose({ message: messageOf(e), sqlState: sqlStateOf(e), cause: e });
      throw new Gone(messageOf(e), sqlStateOf(e), e, true);
    }
  }

  /** Ends the connection. Never throws: one that is gone already is ended. */
  async end(): Promise<void> {
    this.#ended = true;
    this.#gone ??= { message: "the connection has ended", sqlState: undefined, cause: undefined };
    await this.#client.end().catch(() => {});
  }
}
