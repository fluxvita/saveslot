// The HTTP adapter as the contract suite's driver, and one request on a service's socket: for the
// HTTP cases, and for the operations another surface does not have (05-surfaces §1 «不进 MCP»).

import { request } from "node:http";
import type { Operation } from "@fluxvita/saveslot-service";
import type { Driver, Outcome } from "./contract-suite.fixture.ts";
import { socketFile } from "./service.ts";

export interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** Where a service listens: the `home` whose socket it is, or a TCP address (the server mode). */
export type Target = string | { readonly host: string; readonly port: number };

/** Where a request to `at` goes, as `node:http`'s `request` takes it. */
export const targetOptions = (at: Target) =>
  typeof at === "string" ? { socketPath: socketFile(at) } : { host: at.host, port: at.port };

/** One request on the socket of the service in `home`, or to its TCP address. */
export function httpRequest(
  home: Target,
  o: {
    method: string;
    path: string;
    token?: string;
    headers?: Record<string, string>;
    body?: string;
    socket?: string;
  },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        ...(o.socket !== undefined ? { socketPath: o.socket } : targetOptions(home)),
        method: o.method,
        path: o.path,
        headers: {
          ...(o.token !== undefined && o.token !== ""
            ? { authorization: `Bearer ${o.token}` }
            : {}),
          ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(o.headers ?? {}),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8").on("data", (c: string) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** A header value as its UTF-8 bytes, one character each, as node sends them (05-surfaces §13). */
export const utf8Header = (v: string): string => Buffer.from(v, "utf8").toString("latin1");

const query = (p: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) s.set(k, Array.isArray(v) ? v.join(",") : String(v));
  const t = s.toString();
  return t === "" ? "" : `?${t}`;
};

/** The contract's operations over HTTP (05-surfaces §14, §15), on the service at `home()`. */
export const httpDriver =
  (home: () => Target): Driver =>
  async (credential, operation: Operation, params, o = {}) => {
    const headers: Record<string, string> = {
      ...(o.task !== undefined ? { "x-task-id": utf8Header(o.task) } : {}),
      ...(o.idempotencyKey !== undefined
        ? { "idempotency-key": utf8Header(o.idempotencyKey) }
        : {}),
    };
    const { id, ...rest } = params as { id?: string } & Record<string, unknown>;
    const at: Record<Operation, { method: string; path: string; body?: true }> = {
      catalog: { method: "GET", path: "/v1/slots" },
      query: { method: "POST", path: "/v1/query", body: true },
      history: { method: "POST", path: "/v1/history", body: true },
      sql: { method: "POST", path: "/v1/sql", body: true },
      pending: { method: "GET", path: id !== undefined ? `/v1/pending/${id}` : "/v1/pending" },
      sources: {
        method: "GET",
        path: rest["mode"] === "get" ? `/v1/sources/${id}` : "/v1/sources",
      },
      "policy.get": { method: "GET", path: `/v1/slots/${String(rest["slot"])}/policy` },
      write: { method: "POST", path: "/v1/writes", body: true },
      resolve: { method: "POST", path: `/v1/pending/${id}/resolution`, body: true },
      schema_draft: { method: "POST", path: "/v1/drafts", body: true },
      "connections.issue": { method: "POST", path: "/v1/connections", body: true },
      "connections.list": { method: "GET", path: "/v1/connections" },
      "connections.update": { method: "PATCH", path: `/v1/connections/${id}`, body: true },
      "connections.revoke": { method: "DELETE", path: `/v1/connections/${id}` },
      "slots.remove": { method: "DELETE", path: `/v1/slots/${String(rest["slot_id"])}` },
      "reads.list": { method: "GET", path: "/v1/reads" },
      "log.verify": { method: "GET", path: "/v1/log/verify" },
      "log.end": { method: "GET", path: "/v1/log/end" },
      // A stream, not a JSON answer: the cases that use it read the body themselves.
      export: { method: "GET", path: "/v1/export" },
    };
    const r = at[operation];
    const inPath = [
      "pending",
      "resolve",
      "connections.update",
      "connections.revoke",
      "sources",
    ].includes(operation);
    const { slot_id: _slot, ...withoutSlot } = rest;
    // The sources' mode is the route's: a list, a search (by `q`), or one by its ID.
    const { mode: _mode, ...withoutMode } = rest;
    const { slot: _named, ...withoutSlotName } = rest;
    const p =
      operation === "slots.remove"
        ? withoutSlot
        : operation === "sources"
          ? withoutMode
          : operation === "policy.get"
            ? withoutSlotName
            : inPath
              ? rest
              : (params as Record<string, unknown>);
    const reply = await httpRequest(home(), {
      method: r.method,
      path: r.body ? r.path : `${r.path}${query(p)}`,
      token: credential,
      headers,
      ...(r.body ? { body: JSON.stringify(p) } : {}),
    });
    const json = JSON.parse(reply.body) as Record<string, unknown>;
    if (reply.status === 200) return { result: json };
    const { message: _, ...error } = json["error"] as Record<string, unknown>;
    return { error } as Outcome;
  };
