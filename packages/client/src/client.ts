// The contract's operations as calls on the local service's HTTP routes (docs/zh-CN/spec/05-surfaces.md
// §14; 04-contract-types for the shapes). Each call maps its parameters onto the route as the
// service reads them back:
// - `task` goes in `X-Task-Id` and `idempotency_key` in `Idempotency-Key`, never in a body or a
//   query (04-contract-types §1.7);
// - IDs and names that the route takes in its path go there, percent-encoded, and not in the body;
// - GET parameters go in the query string: `limit` as a number, `include_revoked` as true / false,
//   `tables` comma-separated; absent ones are left out.
// Parameters no route takes, or that the route would take differently from what was given, are
// refused as a ClientUsageError and nothing is sent: a parameter is never dropped, since the
// contract answers an unexpected one with invalid_argument, and a call must not turn that into a
// success. Results come back as the contract's result types, errors as ContractCallError or
// TransportError (./transport.ts); every error comes out of the returned promise.

import type {
  AsOfParams,
  AsOfResult,
  CatalogList,
  CatalogParams,
  CatalogResult,
  CatalogSchema,
  CatalogTables,
  ChangesParams,
  ChangesResult,
  ConnectionsIssueParams,
  ConnectionsIssueResult,
  ConnectionsListParams,
  ConnectionsListResult,
  ConnectionsRevokeParams,
  ConnectionsRevokeResult,
  ConnectionsUpdateParams,
  ConnectionsUpdateResult,
  HistoryParams,
  HistoryResult,
  LogEndResult,
  LogVerifyResult,
  PendingDetailResult,
  PendingListResult,
  PendingParams,
  PendingResult,
  QueryParams,
  QueryResult,
  ReadsListParams,
  ReadsListResult,
  ResolveParams,
  ResolveResult,
  SchemaDraftParams,
  SchemaDraftResult,
  TimelineParams,
  TimelineResult,
} from "@fluxvita/saveslot-contract";
import { ClientUsageError, encode, type RequestOptions, request } from "./transport.ts";

export interface ClientOptions {
  /** The service's socket, from the configuration (06-cli §8.1). */
  readonly socketPath: string;
  /** The credential's token (./credentials.ts). */
  readonly token: string;
  /** Milliseconds before a request is given up (default 60 s). */
  readonly timeoutMs?: number;
}

type Query = Map<string, string>;
type Obj = Record<string, unknown>;

/**
 * One path segment, percent-encoded. Empty, `.` and `..` are refused: percent-encoding leaves the
 * dots as they are, and the service's URL parsing would fold them into another route.
 */
function seg(s: unknown): string {
  if (typeof s !== "string") throw new ClientUsageError("a name or ID in a path must be a string");
  if (s === "" || s === "." || s === "..") {
    throw new ClientUsageError(`"${s}" cannot be a name or ID in a path`);
  }
  return encode(s);
}

/** `task` and `idempotency_key` taken out of `p`, for the headers. */
function split(p: object): { rest: Obj; task?: string; idempotencyKey?: string } {
  const { task, idempotency_key, ...rest } = p as Obj;
  // Passed on whatever their type: the transport refuses a value that is no string.
  return {
    rest,
    ...(task !== undefined ? { task: task as string } : {}),
    ...(idempotency_key !== undefined ? { idempotencyKey: idempotency_key as string } : {}),
  };
}

/** The query string of `p`: each present value as the service parses it back. */
function query(p: Obj): Query {
  const q: Query = new Map();
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) q.set(k, v.join(","));
    else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      q.set(k, String(v));
    else throw new ClientUsageError(`${k} cannot go in a query string`);
  }
  return q;
}

/** A slot-qualified table name `slot.table` split, or undefined for a bare name. */
function qualified(name: string): { slot: string; table: string } | undefined {
  const i = name.indexOf(".");
  return i < 0 ? undefined : { slot: name.slice(0, i), table: name.slice(i + 1) };
}

export interface Client {
  catalog(p: CatalogParams & { level?: "list" }): Promise<CatalogList>;
  catalog(p: CatalogParams & { level: "table" }): Promise<CatalogTables>;
  catalog(p: CatalogParams & { level: "schema" }): Promise<CatalogSchema>;
  catalog(p: CatalogParams): Promise<CatalogResult>;
  query(p: QueryParams): Promise<QueryResult>;
  history(p: TimelineParams): Promise<TimelineResult>;
  history(p: AsOfParams): Promise<AsOfResult>;
  history(p: ChangesParams): Promise<ChangesResult>;
  history(p: HistoryParams): Promise<HistoryResult>;
  pending(p: PendingParams & { id: string }): Promise<PendingDetailResult>;
  pending(p?: PendingParams & { id?: undefined }): Promise<PendingListResult>;
  pending(p?: PendingParams): Promise<PendingResult>;
  resolve(p: ResolveParams): Promise<ResolveResult>;
  schemaDraft(p: SchemaDraftParams): Promise<SchemaDraftResult>;
  readonly connections: {
    issue(p: ConnectionsIssueParams): Promise<ConnectionsIssueResult>;
    list(p?: ConnectionsListParams): Promise<ConnectionsListResult>;
    update(p: ConnectionsUpdateParams): Promise<ConnectionsUpdateResult>;
    revoke(p: ConnectionsRevokeParams): Promise<ConnectionsRevokeResult>;
  };
  readsList(p?: ReadsListParams): Promise<ReadsListResult>;
  logVerify(): Promise<LogVerifyResult>;
  logEnd(): Promise<LogEndResult>;
}

export function createClient(o: ClientOptions): Client {
  const send = (
    r: Pick<RequestOptions, "method" | "path" | "query" | "body" | "task" | "idempotencyKey">,
  ) =>
    request({
      socketPath: o.socketPath,
      token: o.token,
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      ...r,
    });
  const get = (path: string, p: object = {}) => {
    const { rest, task } = split(p);
    return send({
      method: "GET",
      path,
      query: query(rest),
      ...(task !== undefined ? { task } : {}),
    });
  };
  const withBody = (method: "POST" | "PATCH", path: string, p: object) => {
    const { rest, task, idempotencyKey } = split(p);
    return send({
      method,
      path,
      body: rest,
      ...(task !== undefined ? { task } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
  };

  async function catalog(p: CatalogParams): Promise<unknown> {
    const { level = "list", slot, tables, ...rest } = p;
    if (level !== "table" && tables !== undefined) {
      throw new ClientUsageError(`catalog ${String(level)}: tables is for the table level`);
    }
    switch (level) {
      case "list":
        return get(slot === undefined ? "/v1/slots" : `/v1/slots/${seg(slot)}`, rest);
      case "schema":
        if (slot === undefined) throw new ClientUsageError("catalog schema: slot is required");
        return get(`/v1/slots/${seg(slot)}/schema`, rest);
      case "table": {
        if (slot !== undefined) throw new ClientUsageError("catalog table: name tables, not slot");
        const ts = tables ?? [];
        const one = ts.length === 1 ? (ts[0] as string) : undefined;
        if (one !== undefined) {
          const q = qualified(one);
          return get(
            q === undefined
              ? `/v1/tables/${seg(one)}`
              : `/v1/slots/${seg(q.slot)}/tables/${seg(q.table)}`,
            rest,
          );
        }
        // Several tables: HTTP has one route for them, of one slot (05-surfaces §13, §14); the
        // contract's other combinations (no tables, tables of several slots, bare names) have none.
        const qs = ts.map(qualified);
        const s = qs[0]?.slot;
        if (s === undefined || qs.some((q) => q === undefined || q.slot !== s)) {
          throw new ClientUsageError(
            "catalog table: HTTP has no endpoint for this combination of tables; give one table, or several of one slot, each written slot.table",
          );
        }
        return get(`/v1/slots/${seg(s)}/tables`, {
          ...rest,
          tables: qs.map((q) => q?.table as string),
        });
      }
      default:
        throw new ClientUsageError(`catalog: no level ${String(level)}`);
    }
  }

  async function pending(p: PendingParams = {}): Promise<unknown> {
    const { id, ...rest } = p;
    return get(id === undefined ? "/v1/pending" : `/v1/pending/${seg(id)}`, rest);
  }

  return {
    catalog: catalog as Client["catalog"],
    query: async (p) => withBody("POST", "/v1/query", p) as Promise<QueryResult>,
    history: (async (p: HistoryParams) => withBody("POST", "/v1/history", p)) as Client["history"],
    pending: pending as Client["pending"],
    resolve: async (p) => {
      const { id, ...rest } = p;
      return withBody("POST", `/v1/pending/${seg(id)}/resolution`, rest) as Promise<ResolveResult>;
    },
    schemaDraft: async (p) => withBody("POST", "/v1/drafts", p) as Promise<SchemaDraftResult>,
    connections: {
      issue: async (p) => withBody("POST", "/v1/connections", p) as Promise<ConnectionsIssueResult>,
      list: async (p = {}) => get("/v1/connections", p) as Promise<ConnectionsListResult>,
      update: async (p) => {
        const { id, ...rest } = p;
        return withBody("PATCH", `/v1/connections/${seg(id)}`, rest) as Promise<Connection>;
      },
      revoke: async (p) => {
        const { id, ...rest } = p;
        const extra = Object.keys(rest);
        if (extra.length > 0) {
          throw new ClientUsageError(`connections.revoke takes only id, not ${extra.join(", ")}`);
        }
        return send({
          method: "DELETE",
          path: `/v1/connections/${seg(id)}`,
        }) as Promise<Connection>;
      },
    },
    readsList: async (p = {}) => get("/v1/reads", p) as Promise<ReadsListResult>,
    logVerify: async () => get("/v1/log/verify") as Promise<LogVerifyResult>,
    logEnd: async () => get("/v1/log/end") as Promise<LogEndResult>,
  };
}

type Connection = ConnectionsUpdateResult;
