// HTTP to the local saveslot service over its unix socket, or to a saveslot server at its external
// address (docs/zh-CN/spec/06-cli.md §2 «CLI 怎么连 saveslot», «用户会话凭证»; 05-surfaces.md
// §13–§15). One request, one JSON answer:
// - 2xx: the operation's result;
// - a contract error body `{"error": {"code", "message", ...}}`: thrown as a ContractCallError;
// - the service not reachable (no socket, nobody listening), the connection cut, no whole answer
//   within the time limit, the answer not JSON or past the size limit: thrown as a TransportError,
//   with no contract code;
// - options that cannot go on the wire as given: thrown as a ClientUsageError, nothing sent.
// Every error comes out of the returned promise, none is thrown synchronously.
// The socket path is the caller's (from the configuration), never taken from the environment
// (06 §8.1), and must be absolute: node:http takes an empty or absent one as no socket at all and
// would send the token over TCP to localhost. A server is an origin and nothing more: `https:`, or
// `http:` on a loopback address only, so that a token never crosses a network in the clear. No
// redirect is followed: a 3xx is no contract answer. The token goes in `Authorization` and nowhere
// else; it is in no error message.

import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isAbsolute } from "node:path";

/** Parameters a call cannot put on the wire: refused before anything is sent. */
export class ClientUsageError extends Error {
  override readonly name = "ClientUsageError";
}

/** A contract error the service answered with (04-contract-types §9). */
export class ContractCallError extends Error {
  override readonly name = "ContractCallError";
  /** The contract's error code. */
  readonly code: string;
  /** The HTTP status. */
  readonly status: number;
  /** The whole error object as answered: code, message and the code's detail fields. */
  readonly body: Readonly<Record<string, unknown>>;
  constructor(status: number, body: Readonly<Record<string, unknown>>) {
    super(
      Object.hasOwn(body, "message") && typeof body["message"] === "string"
        ? body["message"]
        : String(body["code"]),
    );
    this.code = String(body["code"]);
    this.status = status;
    this.body = body;
  }
}

/**
 * The service could not be asked, or its answer was no contract answer.
 * - `unreachable`: no socket file, or nobody listening on it;
 * - `broken`: the connection failed or closed before a whole answer, or timed out;
 * - `bad_answer`: an answer that is not JSON, too large, or an error status without an error body.
 */
export class TransportError extends Error {
  override readonly name = "TransportError";
  readonly code: "unreachable" | "broken" | "bad_answer";
  /** The HTTP status, for `bad_answer`. */
  readonly status: number | undefined;
  constructor(code: TransportError["code"], message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Where a request goes: the local service's socket, or a server's origin; one of the two. */
export type Destination =
  | { readonly socketPath: string; readonly server?: undefined }
  | {
      /** An origin: `https://host[:port]`, or `http://` on a loopback address (tests, a tunnel). */
      readonly server: string;
      readonly socketPath?: undefined;
    };

export type RequestOptions = Destination & {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** The path, already percent-encoded where it carries IDs or names. */
  readonly path: string;
  readonly token?: string;
  /** Query parameters (GET, DELETE). */
  readonly query?: ReadonlyMap<string, string>;
  /** The JSON body (POST, PATCH). */
  readonly body?: unknown;
  /** `X-Task-Id` (04-contract §2 `task`). */
  readonly task?: string;
  /** `Idempotency-Key` (04-contract-types §1.7 `idempotency_key`). */
  readonly idempotencyKey?: string;
  /**
   * Milliseconds from the call until the whole answer is in, after which the request is given up
   * (default 60 s). A total limit: an answer that keeps trickling in does not extend it.
   */
  readonly timeoutMs?: number;
};

/** Answers past this many bytes are not read (the contract's results stay far below it). */
export const MAX_ANSWER_BYTES = 64 * 1024 * 1024;

const UNREACHABLE = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK", "EACCES"]);
/** A server's address not found or not answering: nobody to ask, as an absent socket. */
const UNREACHABLE_SERVER = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * A server's origin as a URL, or a usage error: `https:`, or `http:` on a loopback address; no
 * user, path, query or fragment (`https://host/` is the origin as URL writes it).
 */
export function serverOrigin(server: unknown): URL {
  let u: URL;
  try {
    if (typeof server !== "string") throw new TypeError();
    u = new URL(server);
  } catch {
    throw new ClientUsageError("the server address is not a URL");
  }
  const secure = u.protocol === "https:";
  if (!secure && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {
    throw new ClientUsageError(
      "the server address must be https (http only on a loopback address)",
    );
  }
  if (
    u.username !== "" ||
    u.password !== "" ||
    u.pathname !== "/" ||
    u.search !== "" ||
    u.hash !== ""
  ) {
    throw new ClientUsageError(
      "the server address must be an origin: no user, path, query or fragment",
    );
  }
  return u;
}

/** The longest time limit a timer can hold (setTimeout fires at once past it). */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** The path with its query string: each key and value percent-encoded. */
function target(path: string, query: ReadonlyMap<string, string> | undefined): string {
  if (query === undefined || query.size === 0) return path;
  const q = [...query].map(([k, v]) => `${encode(k)}=${encode(v)}`);
  return `${path}?${q.join("&")}`;
}

/** `encodeURIComponent`, its URIError (a lone surrogate) as a usage error. */
export function encode(s: string): string {
  try {
    return encodeURIComponent(s);
  } catch {
    throw new ClientUsageError("a name or value holds a lone surrogate and cannot be encoded");
  }
}

/**
 * `X-Task-Id` or `Idempotency-Key` as it goes on the wire, or a usage error. The value is sent as
 * its UTF-8 bytes (05-surfaces §13): node writes a header value one byte per character, so the
 * bytes are handed over as one character each. Refused: what is no string; what is not
 * well-formed (a lone surrogate would be sent as U+FFFD); C0 control characters and DEL, which a
 * header cannot carry; a space at either end, which HTTP strips, changing the value on the way.
 * The contract's own checks (length, control characters) are the service's.
 */
function textHeaderValue(name: string, v: unknown): string {
  if (typeof v !== "string") throw new ClientUsageError(`${name} must be a string`);
  if (!v.isWellFormed()) {
    throw new ClientUsageError(`${name} holds a lone surrogate and cannot be encoded`);
  }
  if ([...v].some((c) => (c.codePointAt(0) as number) < 0x20 || c === "\u007f")) {
    throw new ClientUsageError(`${name} holds a control character, which a header cannot carry`);
  }
  if (/^ | $/.test(v)) {
    throw new ClientUsageError(`${name} begins or ends with a space, which HTTP would strip`);
  }
  return Buffer.from(v, "utf8").toString("latin1");
}

/** The token: printable ASCII without spaces, as a token's form is; anything else a usage error. */
function tokenValue(v: unknown): string {
  if (typeof v !== "string" || !/^[\x21-\x7e]+$/.test(v)) {
    throw new ClientUsageError("the token is not of a token's form");
  }
  return v;
}

/** The request's headers and body, or a usage error. */
function prepare(o: RequestOptions): {
  headers: Record<string, string>;
  body: Buffer | undefined;
  path: string;
  timeoutMs: number;
  server: URL | undefined;
} {
  let server: URL | undefined;
  if (o.server !== undefined) {
    if (o.socketPath !== undefined)
      throw new ClientUsageError("a socket path or a server, not both");
    server = serverOrigin(o.server);
  } else if (typeof o.socketPath !== "string" || !isAbsolute(o.socketPath)) {
    throw new ClientUsageError("the socket path must be an absolute path");
  }
  const timeoutMs = o.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new ClientUsageError(
      `the time limit must be a whole number of ms, 1 to ${MAX_TIMEOUT_MS}`,
    );
  }
  let body: Buffer | undefined;
  if (o.body !== undefined) {
    let text: string;
    try {
      text = JSON.stringify(o.body);
    } catch {
      // A BigInt or a cycle: TypeError.
      throw new ClientUsageError("the parameters cannot be written as JSON");
    }
    body = Buffer.from(text, "utf8");
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (o.token !== undefined) headers["authorization"] = `Bearer ${tokenValue(o.token)}`;
  if (o.task !== undefined) headers["x-task-id"] = textHeaderValue("task", o.task);
  if (o.idempotencyKey !== undefined) {
    headers["idempotency-key"] = textHeaderValue("idempotency_key", o.idempotencyKey);
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(body.length);
  }
  return { headers, body, path: target(o.path, o.query), timeoutMs, server };
}

/** Opens the request: over the socket, or to the server's origin (https, or loopback http). */
function open(
  o: RequestOptions,
  server: URL | undefined,
  path: string,
  headers: Record<string, string>,
  onAnswer: (res: IncomingMessage) => void,
): ClientRequest {
  if (server === undefined) {
    return httpRequest({ socketPath: o.socketPath, method: o.method, path, headers }, onAnswer);
  }
  return (server.protocol === "https:" ? httpsRequest : httpRequest)(
    {
      protocol: server.protocol,
      // URL keeps the brackets of an IPv6 address; the request takes it without them.
      hostname: server.hostname.replace(/^\[(.*)\]$/, "$1"),
      port: server.port === "" ? undefined : Number(server.port),
      method: o.method,
      path,
      headers,
    },
    onAnswer,
  );
}

/** No answer in time; the socket's words as they were, the server's of its own. */
const late = (server: URL | undefined) =>
  new TransportError(
    "broken",
    server === undefined
      ? "the service did not answer in time"
      : "the saveslot server did not answer in time",
  );

/** The request failed before an answer: nobody to ask, or the connection failed. */
function failed(server: URL | undefined, e: NodeJS.ErrnoException): TransportError {
  if (server === undefined) {
    return e.code !== undefined && UNREACHABLE.has(e.code)
      ? new TransportError("unreachable", "the saveslot service is not running or not reachable")
      : new TransportError("broken", "the connection to the saveslot service failed");
  }
  return e.code !== undefined && UNREACHABLE_SERVER.has(e.code)
    ? new TransportError("unreachable", "the saveslot server is not reachable")
    : new TransportError("broken", "the connection to the saveslot server failed");
}

/**
 * Reads a JSON answer whole: a 2xx gives its value to `done`; a contract error, an answer too large,
 * cut off or not JSON go to `fail` (06-cli §2: one request, one JSON answer).
 */
function readAnswer(
  res: IncomingMessage,
  fail: (e: Error) => void,
  done: (v: unknown) => void,
): void {
  let over = false;
  const stop = (e: Error) => {
    over = true;
    fail(e);
  };
  const chunks: Buffer[] = [];
  let size = 0;
  res.on("data", (c: Buffer) => {
    size += c.length;
    if (size > MAX_ANSWER_BYTES) {
      // Stopped before destroying: destroying emits the events of a cut-off answer.
      stop(new TransportError("bad_answer", "the answer is too large", res.statusCode));
      res.destroy();
      return;
    }
    chunks.push(c);
  });
  res.on("error", () => stop(new TransportError("broken", "the answer was cut off")));
  res.on("aborted", () => stop(new TransportError("broken", "the answer was cut off")));
  res.on("end", () => {
    if (over) return;
    const status = res.statusCode ?? 0;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      stop(new TransportError("bad_answer", `an answer that is not JSON (${status})`, status));
      return;
    }
    if (status >= 200 && status < 300) {
      done(parsed);
      return;
    }
    const error =
      parsed !== null && typeof parsed === "object" && Object.hasOwn(parsed, "error")
        ? (parsed as { error: unknown }).error
        : undefined;
    if (
      error !== null &&
      typeof error === "object" &&
      !Array.isArray(error) &&
      Object.hasOwn(error, "code") &&
      typeof (error as Record<string, unknown>)["code"] === "string"
    ) {
      stop(new ContractCallError(status, error as Record<string, unknown>));
    } else {
      stop(
        new TransportError("bad_answer", `an error answer without an error (${status})`, status),
      );
    }
  });
}

/** Sends one request; resolves with the result of a 2xx answer. */
export async function request(o: RequestOptions): Promise<unknown> {
  const { headers, body, path, timeoutMs, server } = prepare(o);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = () => {
      settled = true;
      clearTimeout(timer);
    };
    const fail = (e: Error) => {
      if (settled) return;
      settle();
      reject(e);
    };
    const onAnswer = (res: IncomingMessage) =>
      readAnswer(res, fail, (v) => {
        settle();
        resolve(v);
      });
    const req = open(o, server, path, headers, onAnswer);
    const timer = setTimeout(() => {
      fail(late(server));
      req.destroy();
    }, timeoutMs);
    req.on("error", (e: NodeJS.ErrnoException) => {
      fail(failed(server, e));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Sends one request whose 2xx answer is a stream, not a JSON value (`export`): resolves at the
 * answer's headers with the body still to be read. An error answer is read whole and thrown as
 * `request` throws it. The time limit is for the headers only; the stream is the reader's, and a
 * stream cut off comes out of it as a `TransportError` (`broken`). No size limit: the reader takes
 * it as it comes.
 */
export async function requestStream(o: RequestOptions): Promise<IncomingMessage> {
  const { headers, body, path, timeoutMs, server } = prepare(o);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    };
    const req = open(o, server, path, headers, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 200 && status < 300) {
        if (settled) {
          res.destroy();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(res);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_ANSWER_BYTES) {
          fail(new TransportError("bad_answer", "the answer is too large", status));
          res.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on("error", () => fail(new TransportError("broken", "the answer was cut off")));
      res.on("end", () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          fail(new TransportError("bad_answer", `an answer that is not JSON (${status})`, status));
          return;
        }
        const error =
          parsed !== null && typeof parsed === "object" && Object.hasOwn(parsed, "error")
            ? (parsed as { error: unknown }).error
            : undefined;
        if (
          error !== null &&
          typeof error === "object" &&
          !Array.isArray(error) &&
          typeof (error as Record<string, unknown>)["code"] === "string"
        ) {
          fail(new ContractCallError(status, error as Record<string, unknown>));
        } else {
          fail(
            new TransportError(
              "bad_answer",
              `an error answer without an error (${status})`,
              status,
            ),
          );
        }
      });
    });
    const timer = setTimeout(() => {
      fail(late(server));
      req.destroy();
    }, timeoutMs);
    req.on("error", (e: NodeJS.ErrnoException) => fail(failed(server, e)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** An OAuth endpoint's error answer (RFC 6749 §5.2, RFC 8628 §3.5): `{"error": "<code>", ...}`. */
export class OAuthError extends Error {
  override readonly name = "OAuthError";
  /** The answer's `error`: `invalid_grant`, `authorization_pending`, `slow_down`, … */
  readonly code: string;
  readonly status: number;
  /** The whole answer, for what an error carries besides its code (`interval`, …). */
  readonly body: Readonly<Record<string, unknown>>;
  constructor(status: number, body: Readonly<Record<string, unknown>>) {
    super(String(body["error"]));
    this.code = String(body["error"]);
    this.status = status;
    this.body = body;
  }
}

/** The OAuth endpoints a client posts to (05-surfaces §15). */
export type OAuthPath = "/oauth/token" | "/oauth/revoke" | "/oauth/device";

/**
 * POSTs to one of a server's OAuth endpoints, the parameters as
 * `application/x-www-form-urlencoded` (RFC 6749 §4.1.3). The rules of `request`: `server` passes
 * `serverOrigin`, no redirect is followed, the same time and size limits. A 2xx answer: the JSON
 * object answered, or undefined for an empty body (a revocation answers 200 with nothing, RFC
 * 7009 §2.2). An error answer with a string `error`: an OAuthError. Anything else: a
 * TransportError. No `Authorization`: the CLI is a public client and sends `client_id` in the form.
 */
export async function oauthPost(o: {
  readonly server: string;
  readonly path: OAuthPath;
  readonly form: ReadonlyMap<string, string>;
  readonly timeoutMs?: number;
}): Promise<Record<string, unknown> | undefined> {
  const server = serverOrigin(o.server);
  const timeoutMs = o.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new ClientUsageError(
      `the time limit must be a whole number of ms, 1 to ${MAX_TIMEOUT_MS}`,
    );
  }
  const body = Buffer.from(
    [...o.form].map(([k, v]) => `${encode(k)}=${encode(v)}`).join("&"),
    "utf8",
  );
  const headers = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
    "content-length": String(body.length),
  };
  const options = { server: o.server, method: "POST", path: o.path } as const;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    };
    const req = open(options, server, o.path, headers, (res) => {
      const status = res.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_ANSWER_BYTES) {
          fail(new TransportError("bad_answer", "the answer is too large", status));
          res.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on("error", () => fail(new TransportError("broken", "the answer was cut off")));
      res.on("aborted", () => fail(new TransportError("broken", "the answer was cut off")));
      res.on("end", () => {
        if (settled) return;
        const text = Buffer.concat(chunks).toString("utf8");
        if (status >= 200 && status < 300 && text === "") {
          settled = true;
          clearTimeout(timer);
          resolve(undefined);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          fail(new TransportError("bad_answer", `an answer that is not JSON (${status})`, status));
          return;
        }
        const obj =
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined;
        if (status >= 200 && status < 300 && obj !== undefined) {
          settled = true;
          clearTimeout(timer);
          resolve(obj);
        } else if (status >= 400 && obj !== undefined && typeof obj["error"] === "string") {
          fail(new OAuthError(status, obj));
        } else {
          fail(new TransportError("bad_answer", `an answer of no OAuth form (${status})`, status));
        }
      });
    });
    const timer = setTimeout(() => {
      fail(late(server));
      req.destroy();
    }, timeoutMs);
    req.on("error", (e: NodeJS.ErrnoException) => fail(failed(server, e)));
    req.write(body);
    req.end();
  });
}

/** How long the answer to an upload may take once its body is sent (an import replays the log). */
export const UPLOAD_ANSWER_MS = 10 * 60_000;

/**
 * Sends one request whose body is `upload`, streamed as it comes (`import`: 05-surfaces §13), and
 * resolves with the result of its JSON answer. No time limit while the body is sent (it may be
 * large); once it is all sent, the answer is waited for up to `timeoutMs` (UPLOAD_ANSWER_MS when
 * not given). When `upload` fails on the way (a file that does not read, an age file found cut
 * short at its end), the request is destroyed before its end is sent, so the server is left with a
 * body that is not whole, and the source's error is what this rejects with.
 */
export async function requestUpload(
  o: RequestOptions & {
    readonly upload: AsyncIterable<Uint8Array>;
    readonly contentType: "application/x-ndjson";
  },
): Promise<unknown> {
  if (o.body !== undefined) throw new ClientUsageError("an upload has no JSON body as well");
  const { headers, path, server } = prepare({ ...o, timeoutMs: o.timeoutMs ?? UPLOAD_ANSWER_MS });
  const timeoutMs = o.timeoutMs ?? UPLOAD_ANSWER_MS;
  headers["content-type"] = o.contentType;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = () => {
      settled = true;
      clearTimeout(timer);
    };
    const fail = (e: Error) => {
      if (settled) return;
      settle();
      reject(e);
    };
    const req = open(o, server, path, headers, (res) =>
      readAnswer(res, fail, (v) => {
        if (settled) return;
        settle();
        resolve(v);
      }),
    );
    req.on("error", (e: NodeJS.ErrnoException) => fail(failed(server, e)));
    void (async () => {
      try {
        for await (const chunk of o.upload) {
          // Answered already (refused early): nothing more is sent.
          if (settled) return;
          if (!req.write(chunk)) {
            await new Promise<void>((r) => {
              req.once("drain", r);
              req.once("close", r);
            });
          }
        }
      } catch (e) {
        // Not whole: the request destroyed first, so no end of the body ever reaches the server.
        req.destroy();
        fail(e as Error);
        return;
      }
      if (settled) return;
      req.end();
      timer = setTimeout(() => {
        fail(late(server));
        req.destroy();
      }, timeoutMs);
    })();
  });
}
