// The HTTP adapter (docs/zh-CN/spec/05-surfaces.md §13–§15): `/v1/…` routes onto the contract's
// operations, through the service layer's authentication, permission, paging handles and contract
// errors. Requests in this version are the local ones, on the unix socket.
//
// For a `/v1/` request, in this order:
//   1. the service not ready (still opening the tenant): 503 `unavailable` (`starting`);
//   2. `Authorization` (`Bearer <token>`): none or not good, 401 `unauthenticated` with
//      `WWW-Authenticate` (local: no `resource_metadata`; `error="invalid_token"` for a token that
//      is not good);
//   3. the route: none, 404 `not_found` (`route`); a route of a later version, 501
//      `not_in_this_version` (`operation`);
//   4. the body (POST, PATCH): JSON, at most 1 MiB, read as it arrives and cut off past the limit
//      (413 `too_large`); GET takes its parameters from the query string, by the contract's names,
//      `limit` a number, `include_revoked` a boolean, `tables` a comma-separated list;
//   5. the operation; its result 200, its error by the contract code's status.
//
// Logged per request: method, route name, status, milliseconds. Never a header, a path parameter,
// the query string, a request body or a response body.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authenticate,
  ContractError,
  type Credentials,
  type CursorKeys,
  contractError,
  kernelCall,
  type LocalTenant,
  type Operation,
  runOperation,
} from "@fluxvita/saveslot-service";
import { HTTP_STATUS } from "./status.ts";

/** What the adapter needs once the service is ready. */
export interface ApiContext {
  readonly tenant: LocalTenant;
  readonly credentials: Credentials;
  readonly cursors: CursorKeys;
  readonly windows: { readonly requestKey: number; readonly idempotencyKey: number };
  readonly now: () => string;
  /** Not-implemented paths and internal errors (no request content). */
  readonly warn: (event: string, fields: Readonly<Record<string, string>>) => void;
}

export interface Api {
  /** The service's context, or undefined while it is not ready. */
  readonly ready: () => ApiContext | undefined;
  /** One line per request: method, route name, status, milliseconds. */
  readonly log: (fields: Readonly<Record<string, string | number>>) => void;
}

/** How long a connection closed before its request arrived whole is kept for the response to be read. */
const CLOSE_GRACE_MS = 1000;

/** The request body limit (temporary; 08-open-questions, experiment 4). */
export const MAX_BODY_BYTES = 1024 * 1024;

type Obj = Record<string, unknown>;

/** What each part of a path is, checked for its form before it goes anywhere. */
type Part = "slot" | "table" | "id" | "any";
const PART_FORM: Readonly<Record<Exclude<Part, "any">, RegExp>> = {
  // Names in this version are ASCII letters, digits and underscores (08-open-questions).
  slot: /^[A-Za-z0-9_]{1,64}$/,
  table: /^[A-Za-z0-9_]{1,64}$/,
  // An item (`pi_`) or a connection (`ci_`): 01-objects «标识的写法».
  id: /^(pi_[0-9A-HJKMNP-TV-Z]{16}|ci_[0-9A-HJKMNP-TV-Z]{26})$/,
};

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly name: string;
  /** What the path's parts are, in order (later routes: not looked at). */
  readonly parts?: readonly Part[];
  /** The operation; absent: a route of a later version. */
  readonly operation?: Operation;
  /** Takes a JSON body. */
  readonly body?: true;
  /** The parameters from the path's parts, the query and the body. */
  readonly params?: (parts: readonly string[], query: Obj, body: Obj) => Obj;
}

const SEG = "([^/]+)";
const route = (method: string, path: string, name: string, more: Partial<Route> = {}): Route => ({
  method,
  pattern: new RegExp(`^${path.replaceAll("{}", SEG)}$`),
  name,
  ...more,
});
/** A body that may not name what the path names. */
const withPath = (body: Obj, key: string, value: string): Obj => {
  if (Object.hasOwn(body, key)) {
    throw new ContractError("invalid_argument", `${key} is in the path`, {
      reason: "malformed",
      param: key,
    });
  }
  return { ...body, [key]: value };
};

/** 05-surfaces §14, §15: this version's routes, then the later ones. */
const ROUTES: readonly Route[] = [
  route("GET", "/v1/slots", "slots", {
    operation: "catalog",
    params: (_, q) => ({ ...q, level: "list" }),
  }),
  route("GET", "/v1/slots/{}", "slot", {
    operation: "catalog",
    parts: ["slot"],
    params: ([slot], q) => ({ ...q, level: "list", slot }),
  }),
  route("GET", "/v1/slots/{}/schema", "slot_schema", {
    operation: "catalog",
    parts: ["slot"],
    params: ([slot], q) => ({ ...q, level: "schema", slot }),
  }),
  route("GET", "/v1/slots/{}/tables", "slot_tables", {
    operation: "catalog",
    parts: ["slot"],
    params: ([slot], q) => ({
      ...q,
      level: "table",
      tables: ((q["tables"] as string[] | undefined) ?? []).map((t) => `${slot}.${t}`),
    }),
  }),
  route("GET", "/v1/slots/{}/tables/{}", "slot_table", {
    operation: "catalog",
    parts: ["slot", "table"],
    params: ([slot, table], q) => ({ ...q, level: "table", tables: [`${slot}.${table}`] }),
  }),
  route("GET", "/v1/tables/{}", "table", {
    operation: "catalog",
    parts: ["table"],
    params: ([table], q) => ({ ...q, level: "table", tables: [table] }),
  }),
  route("POST", "/v1/query", "query", { operation: "query", body: true }),
  route("POST", "/v1/history", "history", { operation: "history", body: true }),
  route("GET", "/v1/pending", "pending", { operation: "pending" }),
  route("GET", "/v1/pending/{}", "pending_item", {
    operation: "pending",
    parts: ["id"],
    params: ([id], q) => ({ ...q, id }),
  }),
  route("POST", "/v1/writes", "writes", { operation: "write", body: true }),
  route("POST", "/v1/pending/{}/resolution", "resolution", {
    operation: "resolve",
    parts: ["id"],
    body: true,
    params: ([id], _, b) => withPath(b, "id", id as string),
  }),
  route("POST", "/v1/drafts", "drafts", { operation: "schema_draft", body: true }),
  route("POST", "/v1/connections", "connections_issue", {
    operation: "connections.issue",
    body: true,
  }),
  route("GET", "/v1/connections", "connections_list", { operation: "connections.list" }),
  route("PATCH", "/v1/connections/{}", "connections_update", {
    operation: "connections.update",
    parts: ["id"],
    body: true,
    params: ([id], _, b) => withPath(b, "id", id as string),
  }),
  route("DELETE", "/v1/connections/{}", "connections_revoke", {
    operation: "connections.revoke",
    parts: ["id"],
    params: ([id], q) => ({ ...q, id }),
  }),
  route("GET", "/v1/reads", "reads", { operation: "reads.list" }),
  route("GET", "/v1/log/verify", "log_verify", { operation: "log.verify" }),
  // Later versions.
  route("POST", "/v1/sql", "sql"),
  route("GET", "/v1/sources", "sources"),
  route("GET", "/v1/sources/{}", "source"),
  route("POST", "/v1/deletions/preview", "deletion_preview"),
  route("POST", "/v1/deletions", "deletions"),
  route("GET", "/v1/deletions/{}", "deletion"),
  route("GET", "/v1/drafts/{}", "draft"),
  route("POST", "/v1/claims", "claims"),
  route("POST", "/v1/claims/{}/results", "claim_results"),
  route("GET", "/v1/jobs", "jobs"),
  route("GET", "/v1/jobs/{}", "job"),
  route("GET", "/v1/slots/{}/policy", "policy_get"),
  route("PUT", "/v1/slots/{}/policy", "policy_set"),
  route("POST", "/v1/log/reconcile", "log_reconcile"),
  route("GET", "/v1/export", "export"),
  route("POST", "/v1/import", "import"),
];

/** The query string as parameters, by the contract's names. */
function queryParams(search: URLSearchParams): Obj {
  // Keys are the caller's: no prototype, so `__proto__` or `constructor` is a key like any other,
  // for the operation to refuse as unknown.
  const out: Obj = Object.create(null) as Obj;
  for (const key of new Set(search.keys())) {
    const all = search.getAll(key);
    if (all.length > 1) {
      throw new ContractError("invalid_argument", `${key} given twice`, {
        reason: "malformed",
        param: key,
      });
    }
    const v = all[0] as string;
    out[key] =
      key === "limit" && /^(0|[1-9][0-9]{0,8})$/.test(v)
        ? Number(v)
        : key === "include_revoked" && (v === "true" || v === "false")
          ? v === "true"
          : key === "tables"
            ? v.split(",")
            : v;
  }
  return out;
}

/** The body as JSON, read as it arrives, cut off past the limit. */
function readBody(req: IncomingMessage): Promise<Obj> {
  return new Promise((resolve, reject) => {
    const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      reject(
        new ContractError("invalid_argument", "the body is JSON (Content-Type: application/json)", {
          reason: "malformed",
          param: "",
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        req.pause();
        reject(
          new ContractError("too_large", "the request body is too large", {
            reason: "request_body",
            limit_bytes: MAX_BODY_BYTES,
          }),
        );
        return;
      }
      chunks.push(c);
    });
    req.on("error", (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      let v: unknown;
      try {
        v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        reject(
          new ContractError("invalid_argument", "the body is not JSON", {
            reason: "malformed",
            param: "",
          }),
        );
        return;
      }
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        reject(
          new ContractError("invalid_argument", "the body is a JSON object", {
            reason: "malformed",
            param: "",
          }),
        );
        return;
      }
      resolve(v as Obj);
    });
  });
}

/**
 * Sends a response. One sent before the request has arrived whole (a refusal before the body is
 * read, or a body cut off at the limit) closes the connection: the rest of the request is never
 * read, and its bytes are never taken for a next request on the same connection.
 */
function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Obj = {},
): void {
  const text = JSON.stringify(body);
  const close = !req.complete;
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...(close ? { connection: "close" } : {}),
    ...(headers as Record<string, string>),
  });
  if (close) {
    // Not drained: the request stays paused, so what is left of it is not read past the buffers
    // already full, and the sender is held back by its own. After the response the connection is
    // ended on this side and destroyed only after a grace: destroyed at once (what the HTTP server
    // does after a `Connection: close` response), a client still sending would fail its write and
    // drop the response unread. A request parsed on it meanwhile is not served: after a
    // `Connection: close` response the HTTP server serves none on that connection.
    const socket = req.socket;
    req.pause();
    socket.destroySoon = () => {
      socket.end();
      setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref();
    };
  }
  res.end(text);
}

function sendError(req: IncomingMessage, res: ServerResponse, e: ContractError): number {
  const status = HTTP_STATUS[e.code];
  send(req, res, status, { error: { code: e.code, message: e.message, ...e.detail } });
  return status;
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? undefined : v;
};

/**
 * Handles `req` when it is a `/v1/` request: true when it did (the response is sent or being
 * sent), false for any other path.
 */
export function handleApi(api: Api, req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://local");
  if (!url.pathname.startsWith("/v1/")) return false;
  const started = Date.now();
  let name = "unknown";
  const finish = (status: number) =>
    api.log({ method: req.method ?? "", route: name, status, ms: Date.now() - started });

  void (async () => {
    const ctx = api.ready();
    if (ctx === undefined) {
      finish(
        sendError(
          req,
          res,
          new ContractError("unavailable", "the service is starting", { reason: "starting" }),
        ),
      );
      return;
    }
    try {
      const who = await authenticate({
        credentials: ctx.credentials,
        tenant: ctx.tenant,
        authorization: header(req, "authorization"),
      });
      if (!("kind" in who)) {
        const status = HTTP_STATUS.unauthenticated;
        send(
          req,
          res,
          status,
          { error: { code: who.code, message: "the credential is not good", reason: who.reason } },
          {
            "www-authenticate":
              who.reason === "missing" ? "Bearer" : 'Bearer error="invalid_token"',
          },
        );
        finish(status);
        return;
      }
      let parts: string[] = [];
      const r = ROUTES.find((x) => {
        if (x.method !== req.method) return false;
        const m = x.pattern.exec(url.pathname);
        if (m === null) return false;
        parts = m.slice(1).map((p) => {
          try {
            return decodeURIComponent(p);
          } catch {
            throw new ContractError("invalid_argument", "a path part is not percent-encoded", {
              reason: "malformed",
              param: "",
            });
          }
        });
        return true;
      });
      if (r === undefined) {
        throw new ContractError("not_found", "no such route", { reason: "route" });
      }
      name = r.name;
      if (r.operation === undefined) {
        throw new ContractError("not_in_this_version", "not in this version", {
          reason: "operation",
        });
      }
      // Each part of the path of its form, or refused before it reaches anything.
      (r.parts ?? []).forEach((kind, i) => {
        if (kind !== "any" && !PART_FORM[kind].test(parts[i] ?? "")) {
          throw new ContractError(
            "invalid_argument",
            `the ${kind} in the path is not of its form`,
            {
              reason: "malformed",
              param: kind,
            },
          );
        }
      });
      const query = queryParams(url.searchParams);
      let body: Obj = {};
      if (r.body) {
        if (url.search !== "") {
          throw new ContractError("invalid_argument", "parameters go in the body", {
            reason: "malformed",
            param: "",
          });
        }
        body = await readBody(req);
      }
      const params = r.params !== undefined ? r.params(parts, query, body) : r.body ? body : query;
      const task = header(req, "x-task-id");
      const idempotencyKey = header(req, "idempotency-key");
      const now = ctx.now();
      const call = kernelCall({
        principal: who,
        tenant: ctx.tenant,
        operation: r.operation,
        body: params,
        ...(task !== undefined ? { task } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        now,
        windows: ctx.windows,
        cursors: ctx.cursors,
      });
      const result = await runOperation({
        tenant: ctx.tenant,
        credentials: ctx.credentials,
        cursors: ctx.cursors,
        operation: r.operation,
        call,
        warn: ctx.warn,
      });
      send(req, res, 200, result);
      finish(200);
    } catch (e) {
      finish(sendError(req, res, contractError(e, ctx.warn)));
    }
  })();
  return true;
}
