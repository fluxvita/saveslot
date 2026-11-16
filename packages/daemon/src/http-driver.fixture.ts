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

/** One request on the socket of the service in `home`. */
export function httpRequest(
  home: string,
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
        socketPath: o.socket ?? socketFile(home),
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

const query = (p: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) s.set(k, Array.isArray(v) ? v.join(",") : String(v));
  const t = s.toString();
  return t === "" ? "" : `?${t}`;
};

/** The contract's operations over HTTP (05-surfaces §14, §15), on the service in `home()`. */
export const httpDriver =
  (home: () => string): Driver =>
  async (credential, operation: Operation, params, o = {}) => {
    const headers: Record<string, string> = {
      ...(o.task !== undefined ? { "x-task-id": o.task } : {}),
      ...(o.idempotencyKey !== undefined ? { "idempotency-key": o.idempotencyKey } : {}),
    };
    const { id, ...rest } = params as { id?: string } & Record<string, unknown>;
    const at: Record<Operation, { method: string; path: string; body?: true }> = {
      catalog: { method: "GET", path: "/v1/slots" },
      query: { method: "POST", path: "/v1/query", body: true },
      history: { method: "POST", path: "/v1/history", body: true },
      pending: { method: "GET", path: id !== undefined ? `/v1/pending/${id}` : "/v1/pending" },
      write: { method: "POST", path: "/v1/writes", body: true },
      resolve: { method: "POST", path: `/v1/pending/${id}/resolution`, body: true },
      schema_draft: { method: "POST", path: "/v1/drafts", body: true },
      "connections.issue": { method: "POST", path: "/v1/connections", body: true },
      "connections.list": { method: "GET", path: "/v1/connections" },
      "connections.update": { method: "PATCH", path: `/v1/connections/${id}`, body: true },
      "connections.revoke": { method: "DELETE", path: `/v1/connections/${id}` },
      "reads.list": { method: "GET", path: "/v1/reads" },
      "log.verify": { method: "GET", path: "/v1/log/verify" },
    };
    const r = at[operation];
    const inPath = ["pending", "resolve", "connections.update", "connections.revoke"].includes(
      operation,
    );
    const p = inPath ? rest : (params as Record<string, unknown>);
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
