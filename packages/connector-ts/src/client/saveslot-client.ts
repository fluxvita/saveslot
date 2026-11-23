// `SaveslotClient`: the SDK's internal class that calls the service over HTTP. Its state is
// private; the public SDK class holds one and is the only way in.
//
// The credential is sent in `Authorization` and nowhere else, and is in no error message.
// A call with no answer, or answered with 429 / 503, is tried again after a wait; a write carries
// an idempotency key, so trying it again is safe.
//
// Header values go out as UTF-8 bytes (05-surfaces §13): a task like "整理账单" is encoded, not
// refused, and a value `fetch` cannot send is an `invalid_argument` before anything is sent, not
// a request tried again as if the service had not answered. So is a body that cannot be
// serialized: it is serialized once, before the first try.

import { SaveslotError } from "../errors.ts";
import type {
  DraftReceipt,
  SaveslotApi,
  SlotSummary,
  TableInfo,
  WriteOptions,
  WriteReceipt,
  WriteRequest,
} from "./api.ts";

export interface SaveslotClientOptions {
  /** The service's base URL, e.g. `https://saveslot.example.com`. */
  readonly baseUrl: string;
  /** The connection credential. */
  readonly credential: string;
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Milliseconds for one request (default 30 000). */
  readonly timeoutMs?: number;
  /** Tries after no answer, 429 or 503 (default 4, at most `MAX_RETRIES`). */
  readonly retries?: number;
  /** Waits between tries; replaceable in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** `User-Agent`: the SDK and the connector sending the request. */
  readonly userAgent?: string;
  /** Extra headers on every request; they cannot replace the SDK's own. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Headers the SDK sets itself; extra headers may not name them. */
export const RESERVED_HEADERS: readonly string[] = [
  "authorization",
  "content-type",
  "accept",
  "user-agent",
  "x-task-id",
  "idempotency-key",
  "prefer",
];

/**
 * `X-Task-Id` and `Idempotency-Key` (05-surfaces §13): not empty, at most 256 characters, no
 * control characters, no leading or trailing white space (HTTP would strip it on the way).
 */
export function checkHeaderText(name: string, value: string): void {
  if (
    value === "" ||
    [...value].length > 256 ||
    value !== value.trim() ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
    /[\u0000-\u001f\u007f-\u009f]/.test(value) ||
    !value.isWellFormed()
  ) {
    throw new SaveslotError(
      "invalid_argument",
      `${name} must be 1–256 characters, with no control characters and no surrounding white space`,
      { details: { header: name } },
    );
  }
}

/** The catalog reads at most this many tables at once (05-surfaces §14). */
const TABLES_PER_READ = 10;

/** The most tries `retries` may ask for after the first. */
export const MAX_RETRIES = 10;

/** The longest wait between tries, whatever `Retry-After` says. */
export const MAX_WAIT_MS = 60_000;

/**
 * A header value as `fetch` sends it: one character per byte of the value's UTF-8 encoding, so
 * the bytes on the wire are UTF-8. ASCII is unchanged.
 */
export function utf8Header(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) out += String.fromCharCode(byte);
  return out;
}

export class SaveslotClient implements SaveslotApi {
  readonly #baseUrl: URL;
  readonly #credential: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #userAgent: string | undefined;
  readonly #headers: Readonly<Record<string, string>>;

  constructor(o: SaveslotClientOptions) {
    let base: URL;
    try {
      base = new URL(o.baseUrl.endsWith("/") ? o.baseUrl : `${o.baseUrl}/`);
    } catch (cause) {
      throw new SaveslotError("invalid_config", "the base URL is not a URL", { cause });
    }
    if (o.credential === "") throw new SaveslotError("invalid_config", "the credential is empty");
    this.#baseUrl = base;
    this.#credential = o.credential;
    this.#fetch = o.fetch ?? globalThis.fetch;
    this.#timeoutMs = o.timeoutMs ?? 30_000;
    this.#retries = o.retries ?? 4;
    this.#sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.#userAgent = o.userAgent;
    this.#headers = { ...o.headers };
  }

  async getSlot(slot: string): Promise<SlotSummary | undefined> {
    const path = `v1/slots/${encodeURIComponent(slot)}`;
    let found: SlotSummary | undefined;
    const tables: SlotSummary["tables"][number][] = [];
    let cursor: string | undefined;
    do {
      let reply: unknown;
      try {
        reply = await this.#call(
          "GET",
          cursor === undefined ? path : `${path}?${new URLSearchParams({ cursor })}`,
        );
      } catch (e) {
        if (e instanceof SaveslotError && e.status === 404) return undefined;
        throw e;
      }
      if (!isObject(reply) || !Array.isArray(reply["slots"])) {
        throw new SaveslotError("bad_reply", "the catalog answer has no slots");
      }
      const first: unknown = reply["slots"][0];
      if (first === undefined) return found === undefined ? undefined : { ...found, tables };
      const page = readSlot(first);
      found ??= page;
      tables.push(...page.tables);
      cursor = typeof reply["next_cursor"] === "string" ? reply["next_cursor"] : undefined;
    } while (cursor !== undefined);
    return found === undefined ? undefined : { ...found, tables };
  }

  async getTables(slot: string, tables: readonly string[]): Promise<TableInfo[]> {
    const out: TableInfo[] = [];
    for (let from = 0; from < tables.length; from += TABLES_PER_READ) {
      const part = tables.slice(from, from + TABLES_PER_READ);
      const query = new URLSearchParams({ tables: part.join(",") });
      const reply = await this.#call("GET", `v1/slots/${encodeURIComponent(slot)}/tables?${query}`);
      if (!isObject(reply) || !Array.isArray(reply["tables"])) {
        throw new SaveslotError("bad_reply", "the catalog answer has no tables");
      }
      for (const t of reply["tables"]) out.push(readTable(t));
    }
    return out;
  }

  async write(request: WriteRequest, options: WriteOptions = {}): Promise<WriteReceipt> {
    const reply = await this.#call("POST", "v1/writes", request, writeHeaders(options));
    if (!isObject(reply) || (reply["status"] !== "saved" && reply["status"] !== "pending")) {
      throw new SaveslotError("bad_reply", "the write answer has no status");
    }
    return reply as unknown as WriteReceipt;
  }

  async submitDraft(
    document: Readonly<Record<string, unknown>>,
    options: WriteOptions = {},
  ): Promise<DraftReceipt> {
    const reply = await this.#call("POST", "v1/drafts", { document }, writeHeaders(options));
    if (
      !isObject(reply) ||
      typeof reply["draft"] !== "string" ||
      (reply["outcome"] !== "applied" && reply["outcome"] !== "pending")
    ) {
      throw new SaveslotError("bad_reply", "the draft answer has no draft or outcome");
    }
    return reply as unknown as DraftReceipt;
  }

  async #call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    const url = new URL(path, this.#baseUrl);
    const sent = sendable({
      ...this.#headers,
      ...(this.#userAgent === undefined ? {} : { "user-agent": this.#userAgent }),
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    });
    // Apart from the others, and with no `cause`: the error `Headers` gives quotes the value.
    try {
      sent.set("authorization", `Bearer ${this.#credential}`);
    } catch {
      throw new SaveslotError("invalid_argument", "the credential cannot be sent in a header", {
        details: { header: "Authorization" },
      });
    }
    const text = body === undefined ? undefined : serialize(body);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers: sent,
          ...(text === undefined ? {} : { body: text }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (cause) {
        if (attempt < this.#retries) {
          await this.#sleep(backoff(attempt));
          continue;
        }
        throw new SaveslotError("unreachable", `${method} ${url.pathname}: no answer`, { cause });
      }
      if ((response.status === 429 || response.status === 503) && attempt < this.#retries) {
        await response.body?.cancel();
        const wait = retryAfter(response.headers.get("retry-after")) ?? backoff(attempt);
        await this.#sleep(Math.min(wait, MAX_WAIT_MS));
        continue;
      }
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (cause) {
        throw new SaveslotError("bad_reply", `${method} ${url.pathname}: the answer is not JSON`, {
          status: response.status,
          cause,
        });
      }
      if (response.ok) return parsed;
      const error = isObject(parsed) && isObject(parsed["error"]) ? parsed["error"] : undefined;
      if (error === undefined || typeof error["code"] !== "string") {
        throw new SaveslotError(
          "bad_reply",
          `${method} ${url.pathname}: status ${response.status}`,
          {
            status: response.status,
          },
        );
      }
      throw new SaveslotError(
        error["code"],
        typeof error["message"] === "string" ? error["message"] : error["code"],
        { status: response.status, details: error },
      );
    }
  }
}

/**
 * Every header value as UTF-8 bytes, checked by `Headers` before the first try: a value it cannot
 * carry (a line break in an extra header, say) is the caller's mistake, refused at once.
 */
function sendable(headers: Readonly<Record<string, string>>): Headers {
  try {
    const out = new Headers();
    for (const [name, value] of Object.entries(headers)) out.set(name, utf8Header(value));
    return out;
  } catch (cause) {
    throw new SaveslotError("invalid_argument", "a header value cannot be sent", { cause });
  }
}

/** The body as JSON; a value JSON cannot carry (a BigInt, a cycle) is refused, not retried. */
function serialize(body: unknown): string {
  try {
    return JSON.stringify(body);
  } catch (cause) {
    throw new SaveslotError("invalid_argument", "the request body cannot be serialized as JSON", {
      cause,
    });
  }
}

/** `Idempotency-Key` (given, or a new one) and `X-Task-Id` (when given) of a write or a draft. */
function writeHeaders(o: WriteOptions): Record<string, string> {
  const key = o.idempotencyKey ?? globalThis.crypto.randomUUID();
  checkHeaderText("Idempotency-Key", key);
  if (o.task !== undefined) checkHeaderText("X-Task-Id", o.task);
  return { "idempotency-key": key, ...(o.task === undefined ? {} : { "x-task-id": o.task }) };
}

function readSlot(s: unknown): SlotSummary {
  if (
    !isObject(s) ||
    typeof s["slot"] !== "string" ||
    typeof s["slot_id"] !== "string" ||
    typeof s["sv"] !== "number" ||
    typeof s["timezone"] !== "string" ||
    !Array.isArray(s["tables"])
  ) {
    throw new SaveslotError("bad_reply", "a slot in the catalog answer is not readable");
  }
  return {
    slot: s["slot"],
    slotId: s["slot_id"],
    sv: s["sv"],
    timezone: s["timezone"],
    tables: s["tables"].map((t) => ({
      table: isObject(t) ? String(t["table"]) : "",
      kind: isObject(t) ? String(t["kind"]) : "",
    })),
  };
}

function readTable(t: unknown): TableInfo {
  if (
    !isObject(t) ||
    typeof t["table"] !== "string" ||
    typeof t["slot"] !== "string" ||
    typeof t["sv"] !== "number" ||
    !Array.isArray(t["fields"])
  ) {
    throw new SaveslotError("bad_reply", "a table in the catalog answer is not readable");
  }
  return {
    slot: t["slot"],
    table: t["table"],
    sv: t["sv"],
    kind: String(t["kind"]),
    fields: t["fields"].map((f) => (isObject(f) ? String(f["name"]) : "")),
  };
}

/** Seconds, or an HTTP date; a value that is neither is ignored. */
function retryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** 1 s, 2 s, 4 s … at most 30 s. */
function backoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
