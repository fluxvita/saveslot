// `saveslot mcp`: the stdio bridge an MCP host starts (docs/zh-CN/spec/06-cli.md §2 «谁用、做什么»,
// §3 step 3, §4.1, §8.1; 05-surfaces §11). It forwards each JSON-RPC message the host writes on
// stdin to the local service's `/mcp` (Streamable HTTP, stateless) and writes what comes back to
// stdout, one message per line. The MCP adapter lives in the service; the bridge does not
// interpret the protocol beyond what the transport needs.
//
// - stdin: one message per line (MCP's stdio framing: a message holds no newline); empty lines are
//   skipped. A line is at most 1 MiB, the service's limit on a `/mcp` body: a longer line, or one
//   that is not a JSON object or array, is answered with a JSON-RPC error (id null) and not
//   forwarded. A JSON array (a batch) is forwarded as it is; the bridge implements no batch
//   semantics.
// - One `POST /mcp` per line, at most 8 in flight; answers are written as they arrive, each message
//   in one write of a whole line. Reading stops (the input is paused) while 8 are in flight, or
//   while the queue of messages waiting for the service holds 64 messages or 8 MiB.
// - Headers: `Accept`, `Content-Type`, `Authorization: Bearer $SAVESLOT_TOKEN`. No session id: the
//   service keeps none. The protocol version: on 2025-11-25 the version `initialize` negotiated, on
//   every later request; on 2026-07-28 a request carries its version in `params._meta` and the
//   HTTP entry requires `MCP-Protocol-Version`, `Mcp-Method` and, for the methods that name one,
//   `Mcp-Name` to agree with it, so they are derived from the message, as the SDK's own HTTP
//   transport derives them (see `standardHeaders`). A message with no such envelope gets none of
//   them. `Mcp-Param-*` (a tool's `x-mcp-header` declarations) is not implemented: no saveslot
//   tool declares one, and a test pins that.
// - Answers: `application/json` written as one line; `text/event-stream` parsed as SSE, every event
//   written in order as one line each; 202 (a notification) nothing. No GET stream is opened. An
//   answer is read whole before it is written.
// - Errors, for a request (a message with a method and an id; the id is echoed with its type) and
//   for a batch holding one (id null): 401 -32001, 403 -32003, both with the contract's code and
//   the next step; 503 -32000; the service not reachable -32000 with `data.code`: `not_delivered`
//   when no connection was made (nothing of the call was written; the words follow autostart),
//   `outcome_unknown` when the connection was cut after the call was sent (sending the same call
//   again as it was is a replay: same content, or the same idempotency key if it had one); the
//   service is not started again
//   (only once, when the bridge starts); no answer within 10 minutes, another status, or an answer
//   that is not JSON-RPC -32603. A JSON-RPC error the service answers with (the SDK's own on a 400)
//   is passed on as it is; only an id it could not give (null or none) becomes the request's, and
//   a batch's is left alone. For a notification or anything else without an id: nothing on stdout.
// - Starting: `/health` is asked first; no answer and autostart on, the service is started by the
//   same function as `saveslot start`. While it starts the input is read and queued.
// - The token is only `SAVESLOT_TOKEN`, a connection instance token (`slt_`); missing, empty or
//   of another form (a user session's `sls_` too): exit 6, stdin is not read. The socket is the
//   home's (`<home>/run/saveslot.sock`).
// - stdout carries JSON-RPC only. stderr carries event names and reason codes only: never the
//   token, never anything of a request or an answer (a method, a tool name or a URI derived for a
//   header included), never a path but the socket's.
// - stdin closed: what is queued and in flight is finished, then exit 0. stdout closed (EPIPE):
//   exit at once. SIGTERM / SIGINT are the command's (`mcpCommand`): exit at once.
// - `--record <file or directory>` (evaluations only, ./mcp-record.ts): every message read and
//   written goes to the record too, the one place a request's content is written; in a directory,
//   a new file per bridge; a file that exists is refused (exit 1, `record_exists`), a write that
//   fails ends the bridge (exit 1, `record_failed`).

import type { Readable, Writable } from "node:stream";
import { type HealthBody, MAX_BODY_BYTES } from "@fluxvita/saveslot-server";
import {
  health,
  type LocalAnswer,
  LocalAnswerTooLarge,
  LocalUnreachable,
  localRequest,
  upgradeOf,
} from "./local-request.ts";
import { type CallRecord, openRecord } from "./mcp-record.ts";
import { TEXTS } from "./texts.ts";

/** At most this many `POST /mcp` at once. */
export const MAX_IN_FLIGHT = 8;
/** The queue of messages waiting for the service: at most this many, and this many bytes. */
export const MAX_QUEUED = 64;
export const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
/** A line is at most what `/mcp` takes as a body. */
export const MAX_LINE_BYTES = MAX_BODY_BYTES;
/** How long one forwarded message may take, in milliseconds: a write may take long. */
export const FORWARD_TIMEOUT_MS = 10 * 60_000;
/** How long the bridge waits for a starting service to be ready, in milliseconds. */
const READY_WAIT_MS = 60_000;

/** A connection instance token (the client's credential rules: a bridge runs as one). */
const CONNECTION_TOKEN = /^slt_[A-Za-z0-9_-]{43}$/;

/** The protocol version meta key of the 2026-07-28 envelope. */
const VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";

/** For the methods that name something, the `params` field `Mcp-Name` mirrors. */
const NAME_SOURCE: ReadonlyMap<string, string> = new Map([
  ["tools/call", "name"],
  ["prompts/get", "name"],
  ["resources/read", "uri"],
  ["tasks/get", "taskId"],
  ["tasks/update", "taskId"],
  ["tasks/cancel", "taskId"],
]);

/** A header value sent as it is: printable ASCII and tab, no leading or trailing space. */
const PLAIN_HEADER = /^[\t\x20-\x7e]*$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * `Mcp-Name`'s value: as it is, or base64 of its UTF-8 between `=?base64?` and `?=` when it is
 * empty, has leading or trailing whitespace, holds anything but printable ASCII and tab, or looks
 * like that form itself (the SDK's encoding).
 */
export function encodeHeaderValue(s: string): string {
  const plain =
    s.length > 0 &&
    s === s.trim() &&
    PLAIN_HEADER.test(s) &&
    !(s.startsWith("=?base64?") && s.endsWith("?="));
  return plain ? s : `=?base64?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

/**
 * The 2026-07-28 standard headers of `message`, derived from it: for a single request whose
 * `params._meta` names a protocol version, `mcp-protocol-version`, `mcp-method` and, when the
 * method names something, `mcp-name`. Anything else (a notification, a batch, no envelope, or an
 * envelope of the wrong shape): none. Never throws.
 */
export function standardHeaders(message: unknown): Record<string, string> {
  if (!isObject(message)) return {};
  if (!Object.hasOwn(message, "id") || typeof message["method"] !== "string") return {};
  const method = message["method"];
  const params = message["params"];
  if (!isObject(params)) return {};
  const meta = params["_meta"];
  if (!isObject(meta)) return {};
  const version = meta[VERSION_META_KEY];
  // A value that cannot be a header as it is: no envelope, as the service will tell.
  if (typeof version !== "string" || !PLAIN_HEADER.test(version) || !PLAIN_HEADER.test(method)) {
    return {};
  }
  const out: Record<string, string> = {
    "mcp-protocol-version": version,
    "mcp-method": method,
  };
  const field = NAME_SOURCE.get(method);
  if (field !== undefined && Object.hasOwn(params, field)) {
    const name = params[field];
    if (typeof name === "string") out["mcp-name"] = encodeHeaderValue(name);
  }
  return out;
}

/**
 * A message's id for an error answer: a string or a number as it is, otherwise null. An integer id
 * past 2^53 is read as the nearest number, so an error the bridge makes up names it so; the
 * service refuses such an id (400) anyway, and only those errors are the bridge's own.
 */
export function idOf(message: unknown): string | number | null {
  if (!isObject(message) || !Object.hasOwn(message, "id")) return null;
  const id = message["id"];
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/** Whether `message` is a notification as JSON-RPC has it: a method and no id. */
function isNotification(message: unknown): boolean {
  return (
    isObject(message) && typeof message["method"] === "string" && !Object.hasOwn(message, "id")
  );
}

/**
 * Whether an answer is owed to `message`: to any single message but a notification (a request,
 * and a message the service will refuse: `{"id":7,"method":7}`, `{"id":8}`, `{}`), and to a batch
 * that is empty or holds one.
 */
function isOwed(message: unknown): boolean {
  if (Array.isArray(message)) return message.length === 0 || !message.every(isNotification);
  return !isNotification(message);
}

/** Whether `v` answers the message of id `id`: a response (a result or an error) with that id. */
function answers(v: unknown, id: string | number | null): boolean {
  if (!isObject(v) || !(Object.hasOwn(v, "result") || Object.hasOwn(v, "error"))) return false;
  return (v["id"] ?? null) === id;
}

/**
 * The data of each event of an SSE body, in order: the `data:` lines of an event joined by
 * newlines; an empty line ends an event; `event`, `id`, `retry` and comments (a line starting with
 * a colon: a field with no name) are ignored.
 */
export function sseData(body: string): string[] {
  const out: string[] = [];
  let data: string[] | undefined;
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (line === "") {
      // An event with no data, or only empty data lines, is skipped (as the SDK does).
      if (data !== undefined && data.join("\n") !== "") out.push(data.join("\n"));
      data = undefined;
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") continue;
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (data === undefined) data = [];
    data.push(value);
  }
  if (data !== undefined && data.join("\n") !== "") out.push(data.join("\n"));
  return out;
}

/** A JSON-RPC error answer as one line. */
function errorLine(id: string | number | null, code: number, message: string, data?: unknown) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

/** The scope a 403 says is needed, when it says one of saveslot's. */
function requiredScope(body: Buffer): string | undefined {
  try {
    const v = JSON.parse(body.toString("utf8")) as unknown;
    const s = isObject(v) && isObject(v["error"]) ? v["error"]["required_scope"] : undefined;
    return typeof s === "string" && /^saveslot\.[a-z_]+$/.test(s) ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `v` is a JSON-RPC message (or a batch of them) the host can be given. */
function isJsonRpc(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0 && v.every(isJsonRpc);
  return isObject(v) && v["jsonrpc"] === "2.0";
}

export interface BridgeOptions {
  /** `SAVESLOT_TOKEN`, as the environment has it. */
  readonly token: string | undefined;
  readonly stdin: Readable;
  readonly stdout: Writable;
  /** One line to stderr: an event name and a reason code, nothing else. */
  readonly log: (line: string) => void;
  /** Start the service when it does not answer (`mcp.autostart`). */
  readonly autostart: boolean;
  /** Starts the service (`saveslot start`'s function); resolves with its exit code. */
  readonly startService: () => Promise<number>;
  /** This saveslot's version, compared with the service's. */
  readonly version: string;
  readonly socketPath: string;
  /**
   * Called when stdout breaks, with the exit code (0 for EPIPE, 1 otherwise), after what is in
   * flight has been given up on; the command exits the process here.
   */
  readonly onStdoutBroken?: (code: number) => void;
  /**
   * `--record`: the call record's file, new, or a directory to make one in (evaluations only); a
   * record itself, for tests.
   */
  readonly record?: string | CallRecord;
  /** For tests. */
  readonly forwardTimeoutMs?: number;
  readonly maxAnswerBytes?: number;
}

/** Runs the bridge until stdin closes (after what is pending is finished) or stdout closes. */
export async function runBridge(o: BridgeOptions): Promise<number> {
  if (o.token === undefined || !CONNECTION_TOKEN.test(o.token)) {
    o.log(TEXTS.mcpNoToken);
    return 6;
  }
  const token = o.token;
  const timeoutMs = o.forwardTimeoutMs ?? FORWARD_TIMEOUT_MS;
  let record: CallRecord | undefined;
  if (typeof o.record === "object") record = o.record;
  else if (o.record !== undefined) {
    try {
      record = openRecord(o.record, o.version);
    } catch (e) {
      o.log(
        TEXTS.mcpEvent(
          (e as NodeJS.ErrnoException).code === "EEXIST" ? "record_exists" : "record_failed",
        ),
      );
      return 1;
    }
  }

  let finish: (code: number) => void = () => {};
  const done = new Promise<number>((r) => {
    finish = r;
  });
  let finished = false;
  /** The forwards in flight, to give up on when the bridge ends early. */
  const aborts = new Set<AbortController>();
  const end = (code: number) => {
    if (finished) return;
    finished = true;
    try {
      record?.close();
    } catch {}
    o.stdin.pause();
    o.stdin.removeAllListeners("data");
    for (const a of aborts) a.abort();
    finish(code);
  };

  // Output backpressure: while stdout takes no more, no new forward starts and stdin is paused;
  // what is in flight (at most MAX_IN_FLIGHT answers) is all that can wait to be written.
  let outputBlocked = false;
  /** Keeps `what` in the record; a write that fails ends the bridge. */
  const keep = (what: (r: CallRecord) => void): boolean => {
    if (record === undefined) return true;
    try {
      what(record);
      return true;
    } catch {
      o.log(TEXTS.mcpEvent("record_failed"));
      end(1);
      return false;
    }
  };
  const write = (line: string) => {
    if (finished) return;
    if (!keep((r) => r.message("out", line))) return;
    if (!o.stdout.write(`${line}\n`) && !outputBlocked) {
      outputBlocked = true;
      flowControl();
      o.stdout.once("drain", () => {
        outputBlocked = false;
        pump();
      });
    }
  };
  o.stdout.on("error", (e: NodeJS.ErrnoException) => {
    const code = e.code === "EPIPE" ? 0 : 1;
    o.log(TEXTS.mcpEvent(code === 0 ? "stdout_closed" : "stdout_failed"));
    end(code);
    o.onStdoutBroken?.(code);
  });

  // The version `initialize` negotiated (2025-11-25), sent on every later request.
  let negotiated: string | undefined;

  const queue: Buffer[] = [];
  let queuedBytes = 0;
  let inFlight = 0;
  let ready = false;
  let inputEnded = false;

  const flowControl = () => {
    if (finished) return;
    const full = outputBlocked || inFlight >= MAX_IN_FLIGHT || queue.length >= MAX_QUEUED;
    if (full || queuedBytes >= MAX_QUEUED_BYTES) o.stdin.pause();
    else if (!inputEnded) o.stdin.resume();
  };
  const settleIfDone = () => {
    if (inputEnded && queue.length === 0 && inFlight === 0) end(0);
  };

  const pump = () => {
    while (ready && !finished && !outputBlocked && inFlight < MAX_IN_FLIGHT && queue.length > 0) {
      const line = queue.shift() as Buffer;
      queuedBytes -= line.length;
      inFlight++;
      void forward(line).finally(() => {
        inFlight--;
        pump();
        flowControl();
        settleIfDone();
      });
    }
    flowControl();
  };

  /** Forwards one line and writes what comes back. Never rejects. */
  const forward = async (line: Buffer): Promise<void> => {
    let message: unknown;
    try {
      message = JSON.parse(line.toString("utf8"));
    } catch {
      // Checked when the line was read; unreachable.
      message = undefined;
    }
    // A batch's error has id null.
    const owed = isOwed(message);
    const id = idOf(message);
    const fail = (event: string, code: number, text: string, data?: unknown) => {
      o.log(TEXTS.mcpEvent(event));
      if (owed) write(errorLine(id, code, text, data));
    };

    const derived = standardHeaders(message);
    const enveloped = derived["mcp-protocol-version"];
    if (enveloped !== undefined && !keep((r) => r.protocol(enveloped))) return;
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(negotiated !== undefined ? { "mcp-protocol-version": negotiated } : {}),
      ...derived,
    };
    const abort = new AbortController();
    aborts.add(abort);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, timeoutMs);
    let a: LocalAnswer;
    try {
      a = await localRequest({
        socketPath: o.socketPath,
        method: "POST",
        path: "/mcp",
        headers,
        body: line,
        timeoutMs,
        signal: abort.signal,
        ...(o.maxAnswerBytes !== undefined ? { maxBytes: o.maxAnswerBytes } : {}),
      });
    } catch (e) {
      if (finished) return;
      if (timedOut) return fail("timeout", -32603, TEXTS.mcpTimedOut);
      // The service answered: it runs; the answer is what is wrong.
      if (e instanceof LocalAnswerTooLarge)
        return fail("answer_too_large", -32603, TEXTS.mcpInternal);
      if (e instanceof LocalUnreachable) {
        // Not connected: the call surely did not reach the service. Cut after: not known.
        return e.connected
          ? fail("connection_lost", -32000, TEXTS.mcpOutcomeUnknown, { code: "outcome_unknown" })
          : fail("unreachable", -32000, TEXTS.mcpNotDelivered(o.autostart), {
              code: "not_delivered",
            });
      }
      return fail("request_failed", -32603, TEXTS.mcpInternal);
    } finally {
      clearTimeout(timer);
      aborts.delete(abort);
    }

    if (a.status === 401 || a.status === 403) {
      const code = a.status === 401 ? "unauthenticated" : "insufficient_scope";
      const scope = a.status === 403 ? requiredScope(a.body) : undefined;
      return fail(code, a.status === 401 ? -32001 : -32003, TEXTS.mcpRefused(code), {
        code,
        ...(scope !== undefined ? { required_scope: scope } : {}),
      });
    }
    if (a.status === 503) {
      // `/mcp` says `starting` whenever it cannot serve; `/health` says which.
      const h = await health(o.socketPath, 2000);
      const u = h?.state === "starting" ? upgradeOf(h) : undefined;
      return h?.state === "failed"
        ? fail("service_failed", -32000, TEXTS.mcpServiceFailed)
        : u !== undefined
          ? fail("unavailable", -32000, TEXTS.mcpUpgrading(u.step))
          : fail("unavailable", -32000, TEXTS.mcpUnavailable);
    }
    const ctype = String(a.headers["content-type"] ?? "").toLowerCase();
    const text = a.body.toString("utf8");
    let values: unknown[];
    try {
      values = ctype.startsWith("text/event-stream")
        ? sseData(text).map((d) => JSON.parse(d) as unknown)
        : text === ""
          ? []
          : [JSON.parse(text) as unknown];
    } catch {
      return fail("not_json_rpc", -32603, TEXTS.mcpInternal);
    }
    if (!values.every(isJsonRpc)) return fail("not_json_rpc", -32603, TEXTS.mcpInternal);
    if (a.status < 200 || a.status > 299) {
      // The service's own JSON-RPC error (the SDK's on a 400): passed on as it is, but for an
      // id it could not give (null or none), which becomes this request's. A batch's: as it is.
      const only = values.length === 1 ? values[0] : undefined;
      if (isObject(only) && isObject(only["error"])) {
        o.log(TEXTS.mcpEvent(`http_${a.status}`));
        if (!owed) return;
        const theirs = only["id"];
        const known = Array.isArray(message) || (theirs !== null && theirs !== undefined);
        write(JSON.stringify(known ? only : { ...only, id }));
        return;
      }
      return fail(`http_${a.status}`, -32603, TEXTS.mcpInternal);
    }
    // Nothing that answers this message (a 202 to a request, an SSE of notifications only): the
    // bridge answers it. More answers, or answers to other ids, are passed on as they are.
    const answered = Array.isArray(message)
      ? values.length > 0
      : values.some((v) => answers(v, id));
    for (const v of values) {
      let agreed: string | undefined;
      if (
        isObject(message) &&
        message["method"] === "initialize" &&
        isObject(v) &&
        isObject(v["result"]) &&
        typeof v["result"]["protocolVersion"] === "string" &&
        PLAIN_HEADER.test(v["result"]["protocolVersion"])
      ) {
        negotiated = v["result"]["protocolVersion"];
        agreed = negotiated;
      }
      write(JSON.stringify(v));
      // The record says the agreed version after the answer that agreed it.
      const said = agreed;
      if (said !== undefined && !keep((r) => r.protocol(said))) return;
    }
    if (owed && !answered) fail("unanswered", -32603, TEXTS.mcpInternal);
  };

  // The input: lines of bytes, each at most MAX_LINE_BYTES.
  let partial: Buffer[] = [];
  let partialBytes = 0;
  let overlong = false;
  const takeLine = (raw: Buffer) => {
    const line = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.subarray(0, -1) : raw;
    if (line.toString("utf8").trim() === "") return;
    if (!keep((r) => r.message("in", line.toString("utf8")))) return;
    let v: unknown;
    try {
      v = JSON.parse(line.toString("utf8"));
    } catch {
      o.log(TEXTS.mcpEvent("parse_error"));
      write(errorLine(null, -32700, TEXTS.mcpParseError));
      return;
    }
    if (v === null || typeof v !== "object") {
      o.log(TEXTS.mcpEvent("invalid_request"));
      write(errorLine(null, -32600, TEXTS.mcpInvalidRequest));
      return;
    }
    queue.push(line);
    queuedBytes += line.length;
    pump();
  };
  const onData = (chunk: Buffer) => {
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, from);
      const piece = chunk.subarray(from, nl === -1 ? chunk.length : nl);
      if (!overlong) {
        partialBytes += piece.length;
        if (partialBytes > MAX_LINE_BYTES + 1) {
          overlong = true;
          partial = [];
        } else partial.push(piece);
      }
      if (nl === -1) break;
      if (overlong || partialBytes > MAX_LINE_BYTES + 1) {
        o.log(TEXTS.mcpEvent("line_too_long"));
        write(errorLine(null, -32600, TEXTS.mcpLineTooLong));
      } else {
        const raw = Buffer.concat(partial);
        // The limit is on the line without its CR.
        const bytes = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.length - 1 : raw.length;
        if (bytes > MAX_LINE_BYTES) {
          o.log(TEXTS.mcpEvent("line_too_long"));
          write(errorLine(null, -32600, TEXTS.mcpLineTooLong));
        } else takeLine(raw);
      }
      partial = [];
      partialBytes = 0;
      overlong = false;
      from = nl + 1;
    }
  };
  o.stdin.on("data", onData);
  o.stdin.on("end", () => {
    if (partial.length > 0 || overlong) onData(Buffer.from("\n"));
    inputEnded = true;
    settleIfDone();
  });
  o.stdin.on("error", () => {
    inputEnded = true;
    settleIfDone();
  });

  // The service: asked once; started once when it does not answer.
  void (async () => {
    let h = await health(o.socketPath);
    if (h === undefined && o.autostart) {
      o.log(TEXTS.mcpEvent("autostart"));
      let exit: number | undefined;
      try {
        const code = await o.startService();
        if (code !== 0) exit = code;
      } catch {
        // Nothing of it is said: it may hold the home's path.
        o.log(TEXTS.mcpEvent("autostart_failed"));
      }
      h = await health(o.socketPath);
      // A start that stopped waiting because the service upgrades the store's format (exit 7,
      // `untilUpgrading`) did not fail: it is said as `service_upgrading` below, not as an exit.
      if (exit !== undefined && !(h?.state === "starting" && upgradeOf(h) !== undefined)) {
        o.log(TEXTS.mcpEvent(`autostart_exit_${exit}`));
      }
    }
    h = await untilSettled(o.socketPath, h);
    if (h === undefined) o.log(TEXTS.mcpEvent("not_running"));
    else if (h.state === "starting" && upgradeOf(h) !== undefined)
      o.log(TEXTS.mcpEvent("service_upgrading"));
    else if (h.state !== "ready") o.log(TEXTS.mcpEvent(`service_${h.state}`));
    else if (h.version !== o.version) o.log(TEXTS.mcpVersionMismatch);
    ready = true;
    pump();
    settleIfDone();
  })();

  return done;
}

/**
 * While the service says `starting`, asks again, up to a minute; not while it upgrades the store's
 * format (02-architecture §8), which may take longer: its calls are answered `unavailable` then.
 */
async function untilSettled(
  socketPath: string,
  first: HealthBody | undefined,
): Promise<HealthBody | undefined> {
  let h = first;
  const until = Date.now() + READY_WAIT_MS;
  while (
    h !== undefined &&
    h.state === "starting" &&
    upgradeOf(h) === undefined &&
    Date.now() < until
  ) {
    await new Promise((r) => setTimeout(r, 200));
    h = await health(socketPath);
  }
  return h;
}
