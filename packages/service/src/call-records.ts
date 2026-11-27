// The server mode's call records (02-architecture §9 «调用记录»;
// docs/zh-CN/process/decisions/server-call-records.md): one line of JSON for each call that passed
// authentication, a `/v1` request or an MCP tool call, with no content: who (tenant, actor, how
// its credential came to be), what (surface, operation, route), how it ended (outcome, the
// contract's reason, an incident) and what it did to the tenant's log (effect, status, seq,
// restores). Written by the deployer's choice (`SAVESLOT_CALL_RECORDS`); an observation, not a
// ledger: a record that cannot be written in time is dropped and counted, never waited for.

import { randomBytes } from "node:crypto";
import { ERROR_REASONS, type ErrorCode } from "@fluxvita/saveslot-contract";
import type { CallEffect } from "@fluxvita/saveslot-kernel";

export type { CallEffect } from "@fluxvita/saveslot-kernel";

import type { CallerSource } from "./caller-source.ts";
import type { ContractError } from "./contract-error.ts";

/** The record format's version: fields added keep it; one taken away or changed raises it. */
export const CALL_RECORD_VERSION = 1;

/** A call's ID: `call_` and 32 hex characters, new for each call. */
export const newCallId = (): string => `call_${randomBytes(16).toString("hex")}`;

/** The header that gives a `/v1` call's ID back (05-surfaces «HTTP»). */
export const CALL_HEADER = "Saveslot-Call";

/** Every field a call record may have, as 02-architecture §9's table lists them, in its order. */
export const CALL_RECORD_FIELDS = [
  "record",
  "v",
  "call",
  "at",
  "ms",
  "tenant",
  "actor",
  "via",
  "registration",
  "client",
  "surface",
  "operation",
  "route",
  "outcome",
  "reason",
  "incident",
  "effect",
  "status",
  "seq",
  "restores",
  "complete",
] as const satisfies readonly (keyof CallRecord)[];

/** One call record, as written. Every field is in 02-architecture §9's table; no other. */
export interface CallRecord {
  readonly record: "call";
  readonly v: number;
  readonly call: string;
  readonly at: string;
  readonly ms: number;
  readonly tenant: string;
  readonly actor: string;
  readonly via: CallerSource["via"];
  readonly registration?: NonNullable<CallerSource["registration"]>;
  readonly client?: string;
  readonly surface: "http" | "mcp";
  readonly operation: string;
  readonly route: string;
  readonly outcome: string;
  readonly reason?: string;
  readonly incident?: string;
  readonly effect?: CallEffect["effect"];
  readonly status?: "saved" | "pending";
  readonly seq?: number;
  readonly restores?: number;
  readonly complete?: boolean;
}

/** How a call ended, as its record gives it: `ok`, or the contract's error. */
export type CallEnd =
  | { readonly ok: true; readonly effect?: CallEffect; readonly complete?: boolean }
  | { readonly ok: false; readonly error: ContractError; readonly complete?: boolean };

/** The fields a call's record takes from how it ended. */
function endOf(end: CallEnd): Partial<CallRecord> & { readonly outcome: string } {
  if (end.ok) {
    const e = end.effect;
    return {
      outcome: "ok",
      ...(e !== undefined ? { effect: e.effect } : {}),
      ...(e?.status !== undefined ? { status: e.status } : {}),
      ...(e?.seq !== undefined ? { seq: e.seq } : {}),
      ...(e?.seq !== undefined && e.restores !== undefined ? { restores: e.restores } : {}),
      ...(end.complete !== undefined ? { complete: end.complete } : {}),
    };
  }
  const { code, detail } = end.error;
  // A reason only when it is one of the contract's for that code: never a value a caller gave.
  const reasons = ERROR_REASONS[code as ErrorCode] as readonly string[] | undefined;
  const reason = detail.reason;
  return {
    outcome: code,
    ...(typeof reason === "string" && reasons?.includes(reason) === true ? { reason } : {}),
    ...(code === "internal" && typeof detail["incident"] === "string"
      ? { incident: detail["incident"] }
      : {}),
    ...(end.complete !== undefined ? { complete: end.complete } : {}),
  };
}

/** A call's record. `started` and `now` are milliseconds of one clock (`performance.now()`). */
export function callRecord(o: {
  readonly call: string;
  readonly at: string;
  readonly started: number;
  readonly now: number;
  readonly tenant: string;
  readonly actor: string;
  readonly source: CallerSource;
  readonly surface: "http" | "mcp";
  readonly operation: string;
  readonly route: string;
  readonly end: CallEnd;
}): CallRecord {
  return {
    record: "call",
    v: CALL_RECORD_VERSION,
    call: o.call,
    at: o.at,
    ms: Math.max(0, Math.round(o.now - o.started)),
    tenant: o.tenant,
    actor: o.actor,
    via: o.source.via,
    ...(o.source.registration !== undefined ? { registration: o.source.registration } : {}),
    ...(o.source.client !== undefined ? { client: o.source.client } : {}),
    surface: o.surface,
    operation: o.operation,
    route: o.route,
    ...endOf(o.end),
  };
}

/** Records waiting to be written, at most: past it, a new record is dropped, not waited for. */
export const CALL_RECORDS_PENDING_MAX = 1000;
/** A minute: the dropped records are told at most once in it. */
const DROP_WINDOW_MS = 60_000;

/**
 * Writes call records to `sink`, one line each, without ever holding a call up: at most `max`
 * waiting; past it, or when the sink fails, a record is dropped and counted, and the count of a
 * minute is told once (`call_record_failed`, to `warn`: the standard error, which a standard
 * output that broke does not take with it).
 */
export class CallRecorder {
  readonly #sink: (line: string) => Promise<void>;
  readonly #warn: (event: string, fields: Readonly<Record<string, string>>) => void;
  readonly #max: number;
  #pending = 0;
  #dropped = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(o: {
    /** Writes one line; resolves once it is written, rejects when it cannot be. */
    readonly sink: (line: string) => Promise<void>;
    readonly warn: (event: string, fields: Readonly<Record<string, string>>) => void;
    readonly max?: number;
  }) {
    this.#sink = o.sink;
    this.#warn = o.warn;
    this.#max = o.max ?? CALL_RECORDS_PENDING_MAX;
  }

  /** Records waiting to be written. */
  get pending(): number {
    return this.#pending;
  }

  /** Writes `r`, or drops it; returns at once either way. */
  write(r: CallRecord): void {
    if (this.#pending >= this.#max) {
      this.#drop();
      return;
    }
    this.#pending++;
    let p: Promise<void>;
    try {
      p = this.#sink(JSON.stringify(r));
    } catch {
      this.#pending--;
      this.#drop();
      return;
    }
    p.then(
      () => {
        this.#pending--;
      },
      () => {
        this.#pending--;
        this.#drop();
      },
    );
  }

  #drop(): void {
    this.#dropped++;
    if (this.#timer !== undefined) return;
    // Told at the minute's end, with every record of it dropped.
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const n = this.#dropped;
      this.#dropped = 0;
      try {
        this.#warn("call_record_failed", { dropped: String(n) });
      } catch {
        // A warning that cannot be written is not the call's failure either.
      }
    }, DROP_WINDOW_MS);
    this.#timer.unref?.();
  }

  /** Tells the records dropped and not yet told, at once (the server closing). */
  flushDropped(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const n = this.#dropped;
    this.#dropped = 0;
    if (n > 0) this.#warn("call_record_failed", { dropped: String(n) });
  }
}
