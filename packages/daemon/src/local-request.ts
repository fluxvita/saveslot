// A request to the local service over its socket, for the service commands (`start`, `stop`,
// `status`) and the MCP bridge: the daemon does not depend on the client package (02-architecture
// §11). The answer comes back as it is: status, headers and the whole body, at most a bounded size.
// The socket path is the caller's (06-cli §8.1); a token passed in goes in `Authorization` only.

import { type IncomingHttpHeaders, request } from "node:http";
import type { HealthBody } from "@fluxvita/saveslot-server";

export interface LocalAnswer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/** The service could not be asked: no socket, nobody listening, the connection cut, no answer in time. */
export class LocalUnreachable extends Error {
  override readonly name: string = "LocalUnreachable";
}

/** The service answered, past the size an answer may have: cut off and refused. */
export class LocalAnswerTooLarge extends LocalUnreachable {
  override readonly name: string = "LocalAnswerTooLarge";
}

/** Answers past this size are cut off and refused. */
const MAX_BYTES = 64 * 1024 * 1024;

export function localRequest(o: {
  readonly socketPath: string;
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Buffer;
  readonly timeoutMs?: number;
  /** Aborting it gives up on the request: the connection is closed and the call is unreachable. */
  readonly signal?: AbortSignal;
  /** The largest answer taken, in bytes (default 64 MiB). */
  readonly maxBytes?: number;
}): Promise<LocalAnswer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (tooLarge = false) => {
      if (settled) return;
      settled = true;
      reject(
        tooLarge
          ? new LocalAnswerTooLarge("the saveslot service's answer is too large")
          : new LocalUnreachable("the saveslot service could not be reached"),
      );
    };
    const req = request(
      {
        socketPath: o.socketPath,
        method: o.method,
        path: o.path,
        headers: {
          ...o.headers,
          ...(o.body !== undefined ? { "content-length": String(o.body.length) } : {}),
        },
        timeout: o.timeoutMs ?? 60_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > (o.maxBytes ?? MAX_BYTES)) {
            fail(true);
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on("error", () => fail());
        res.on("aborted", () => fail());
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      fail();
    });
    req.on("error", () => fail());
    if (o.signal !== undefined) {
      if (o.signal.aborted) {
        req.destroy();
        fail();
        return;
      }
      o.signal.addEventListener("abort", () => {
        req.destroy();
        fail();
      });
    }
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** `GET /health`, or undefined when the service cannot be reached or answers something else. */
export async function health(
  socketPath: string,
  timeoutMs = 5000,
): Promise<HealthBody | undefined> {
  let a: LocalAnswer;
  try {
    a = await localRequest({ socketPath, method: "GET", path: "/health", timeoutMs });
  } catch {
    return undefined;
  }
  if (a.status !== 200) return undefined;
  try {
    const v = JSON.parse(a.body.toString("utf8")) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
    const h = v as Record<string, unknown>;
    if (typeof h["state"] !== "string" || typeof h["version"] !== "string") return undefined;
    if (typeof h["pid"] !== "number" || typeof h["since"] !== "string") return undefined;
    return h as unknown as HealthBody;
  } catch {
    return undefined;
  }
}
