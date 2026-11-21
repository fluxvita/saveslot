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

import type { IncomingMessage } from "node:http";
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
  ExportHeader,
  ExportParams,
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
  SlotsRemoveParams,
  SlotsRemoveResult,
  SourcesGetResult,
  SourcesListResult,
  SourcesParams,
  SourcesResult,
  SqlParams,
  SqlResult,
  TimelineParams,
  TimelineResult,
} from "@fluxvita/saveslot-contract";
import {
  ClientUsageError,
  encode,
  type RequestOptions,
  request,
  requestStream,
  TransportError,
} from "./transport.ts";

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
  sql(p: SqlParams): Promise<SqlResult>;
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
  readonly slots: {
    /** Removes an empty slot, by its ID only (04-contract §17). */
    remove(p: SlotsRemoveParams): Promise<SlotsRemoveResult>;
  };
  /** A list (default), a search (with `q`), or one source by its `id` (05-surfaces §14). */
  sources(p: SourcesParams & { mode: "get"; id: string }): Promise<SourcesGetResult>;
  sources(p?: SourcesParams & { mode?: "list" | "search" }): Promise<SourcesListResult>;
  sources(p?: SourcesParams): Promise<SourcesResult>;
  readsList(p?: ReadsListParams): Promise<ReadsListResult>;
  logVerify(): Promise<LogVerifyResult>;
  logEnd(): Promise<LogEndResult>;
  /**
   * `export` (04-contract §17): the manifest, and the whole NDJSON (manifest line first) as a
   * stream, checked as it is read: the lines are the manifest's count and the last event is its
   * `upto`, or the stream fails with a `TransportError` (`broken`) at its end, so a file that was
   * cut off is never taken for a whole one.
   */
  export(p?: ExportParams): Promise<ExportStream>;
}

export interface ExportStream {
  readonly manifest: ExportHeader;
  readonly body: ReadableStream<Uint8Array>;
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
    sql: async (p) => withBody("POST", "/v1/sql", p) as Promise<SqlResult>,
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
    slots: {
      remove: async (p) => {
        const { slot_id, ...rest } = p;
        const extra = Object.keys(rest);
        if (extra.length > 0) {
          throw new ClientUsageError(`slots.remove takes only slot_id, not ${extra.join(", ")}`);
        }
        return send({
          method: "DELETE",
          path: `/v1/slots/${seg(slot_id)}`,
        }) as Promise<SlotsRemoveResult>;
      },
    },
    // The route says the mode: one by its ID; a search is a list with `q` (05-surfaces §14).
    sources: (async (p: SourcesParams = {}) => {
      const { mode = "list", id, ...rest } = p;
      if (mode === "get") {
        if (id === undefined) throw new ClientUsageError("sources get takes an id");
        return get(`/v1/sources/${seg(id)}`, rest);
      }
      if (id !== undefined) throw new ClientUsageError(`sources ${mode} takes no id`);
      if ((mode === "search") !== (rest.q !== undefined)) {
        throw new ClientUsageError("q is for a search, and a search needs q");
      }
      return get("/v1/sources", rest);
    }) as Client["sources"],
    readsList: async (p = {}) => get("/v1/reads", p) as Promise<ReadsListResult>,
    logVerify: async () => get("/v1/log/verify") as Promise<LogVerifyResult>,
    logEnd: async () => get("/v1/log/end") as Promise<LogEndResult>,
    export: async (p = {}) => {
      const { rest, task } = split(p);
      return exportStream(
        await requestStream({
          socketPath: o.socketPath,
          token: o.token,
          ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
          method: "GET",
          path: "/v1/export",
          query: query(rest),
          ...(task !== undefined ? { task } : {}),
        }),
        typeof rest["after_seq"] === "number" ? rest["after_seq"] : undefined,
      );
    },
  };
}

type Connection = ConnectionsUpdateResult;

const broken = (why: string) =>
  new TransportError("broken", `the export stream is not whole: ${why}`);

/**
 * The export answer as a checked stream. The first line is read and checked as the manifest
 * (its `after` must be the `after_seq` asked for) before this resolves; the rest is passed on as
 * it comes, each line parsed and checked: the events' `seq` follow one another from `after` + 1
 * (a gap only where a `tenant.restored` explains it, its `restored_to` being the event before),
 * and at the end their number and the last `seq` must be the manifest's (with no events, `upto`
 * is `after`). Whenever the reader stops early (it cancels, or a check fails) the answer is
 * destroyed, so the service stops reading the log.
 */
async function exportStream(
  res: IncomingMessage,
  askedAfter: number | undefined,
): Promise<ExportStream> {
  let done = false;
  const stop = () => {
    if (!done) res.destroy();
    done = true;
  };
  const it = (res as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  let first = Buffer.alloc(0);
  let manifest: ExportHeader;
  let nl: number;
  try {
    // The manifest line: read until its line end.
    for (;;) {
      nl = first.indexOf(0x0a);
      if (nl >= 0) break;
      let n: IteratorResult<Buffer>;
      try {
        n = await it.next();
      } catch {
        throw new TransportError("broken", "the answer was cut off");
      }
      if (n.done) throw broken("it ends inside the manifest line");
      first = Buffer.concat([first, n.value]);
      if (first.length > 1 << 20) {
        throw new TransportError("bad_answer", "the manifest line is too long");
      }
    }
    try {
      manifest = JSON.parse(first.subarray(0, nl).toString("utf8")) as ExportHeader;
    } catch {
      throw new TransportError("bad_answer", "the first line is not the manifest");
    }
    if (
      manifest === null ||
      typeof manifest !== "object" ||
      manifest.saveslot_export !== 1 ||
      !Number.isSafeInteger(manifest.events) ||
      !Number.isSafeInteger(manifest.upto)
    ) {
      throw new TransportError("bad_answer", "the first line is not an export manifest");
    }
    if ((manifest.after ?? undefined) !== (askedAfter || undefined)) {
      throw new TransportError("bad_answer", "the manifest's after is not the after_seq asked for");
    }
  } catch (e) {
    stop();
    throw e;
  }
  const after = manifest.after ?? 0;

  async function* lines(): AsyncGenerator<Uint8Array> {
    let events = 0;
    let prev = after; // the seq of the last event line, or `after`
    let tail = Buffer.alloc(0); // the bytes of the line in progress
    const line = (bytes: Buffer) => {
      let ev: { h?: { seq?: unknown; type?: unknown; restored_to?: unknown } };
      try {
        ev = JSON.parse(bytes.toString("utf8")) as typeof ev;
      } catch {
        throw broken(`line ${events + 2} is not JSON`);
      }
      const seq = ev?.h?.seq;
      if (typeof seq !== "number") throw broken(`line ${events + 2} has no seq`);
      const gapExplained = ev.h?.type === "tenant.restored" && ev.h.restored_to === prev;
      if (seq !== prev + 1 && !(gapExplained && seq > prev)) {
        throw broken(`event ${seq} does not follow ${prev}`);
      }
      prev = seq;
      events += 1;
    };
    const take = (chunk: Buffer) => {
      let at = 0;
      for (;;) {
        const i = chunk.indexOf(0x0a, at);
        if (i < 0) break;
        line(Buffer.concat([tail, chunk.subarray(at, i)]));
        tail = Buffer.alloc(0);
        at = i + 1;
      }
      tail = Buffer.concat([tail, chunk.subarray(at)]);
    };
    try {
      yield first;
      take(first.subarray(nl + 1));
      for (;;) {
        let n: IteratorResult<Buffer>;
        try {
          n = await it.next();
        } catch {
          throw new TransportError("broken", "the answer was cut off");
        }
        if (n.done) break;
        take(n.value);
        yield n.value;
      }
      if (tail.length > 0) throw broken("the last line has no end");
      if (events !== manifest.events) {
        throw broken(`${events} events, the manifest says ${manifest.events}`);
      }
      if (prev !== manifest.upto) {
        throw broken(
          events === 0
            ? "no events, and upto is not after"
            : "the last event is not the manifest's upto",
        );
      }
      done = true;
    } finally {
      // Cancelled by the reader, or a check failed: let the service know at once.
      stop();
    }
  }
  return { manifest, body: ReadableStream.from(lines()) };
}
