// The errors the service layer returns to a surface (docs/zh-CN/spec/04-contract.md §16;
// 04-contract-types.md §9): a contract error code with its detail. Errors from the kernel's
// entries (write, read, ops) carry the code and detail already and pass through. Two are changed:
//
// - `internal` with `reason: "not_implemented"`: a path the kernel stops on in this version (a
//   hole to fill in this phase, not a parameter of a later one) is `not_in_this_version`, the reason
//   kept; each is reported through `warn` (no request content) so evaluations can count them.
// - any other `internal`, and anything that is no contract error: `internal` with an `incident`
//   (a random reference for the logs), the kernel's message and detail kept out of the response.

import { randomBytes } from "node:crypto";
import { ERROR_CODES, type ErrorCode, type ErrorReason } from "@fluxvita/saveslot-contract";
import type { KERNEL_OUTER_ERROR_REASONS } from "@fluxvita/saveslot-kernel";

// The outer codes the kernel raises are the contract's, with the contract's reasons, but for
// `internal`: its reasons (`not_implemented`, `inconsistent`) are the kernel's own, and are never
// passed on (see `contractError`). Checked at compile time: a reason the kernel gives that the
// contract does not list makes `true` below unassignable.
type KernelOuter = typeof KERNEL_OUTER_ERROR_REASONS;
const kernelOuterIsTheContracts: {
  readonly [C in Exclude<keyof KernelOuter, "internal">]: C extends ErrorCode
    ? KernelOuter[C][number] extends ErrorReason<C>
      ? true
      : false
    : false;
} = { not_in_this_version: true, handle_expired: true, insufficient_scope: true };
void kernelOuterIsTheContracts;

export type { ErrorCode };

const KNOWN: ReadonlySet<string> = new Set(ERROR_CODES);

/** An error as the contract gives it: a code and its detail (no stack, no internal message). */
export class ContractError<C extends ErrorCode = ErrorCode> extends Error {
  override readonly name = "ContractError";
  readonly code: C;
  readonly detail: { readonly reason?: ErrorReason<C> } & Readonly<Record<string, unknown>>;
  constructor(
    code: C,
    message: string,
    detail: { readonly reason?: ErrorReason<C> } & Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/**
 * What a kernel error looks like: the kernel's entries throw errors of their own classes (write,
 * read, ops, schema draft, …), each with a contract code and its detail. Recognized by having a
 * contract code, not by class: a system error's code (`ENOENT`, a store's `store_locked`) is none.
 */
interface KernelError {
  readonly name: string;
  readonly code: string;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

const isKernelError = (e: unknown): e is KernelError =>
  e instanceof Error &&
  typeof (e as { code?: unknown }).code === "string" &&
  KNOWN.has((e as unknown as { code: string }).code);

/** The contract's parameter names that appear in error paths: structure, not content. */
const STRUCTURE = new Set([
  "ops",
  "table",
  "row",
  "entity",
  "entity_key",
  "external_key",
  "set",
  "valid_from",
  "valid_to",
  "ver",
  "sv",
  "evidence",
  "intent",
  "revert",
  "undo",
  "include_later",
  "premises",
  "acknowledge",
  "id",
  "decision",
  "item_ver",
  "candidate",
  "note",
  "document",
  "tables",
  "slot",
  "limit",
  "cursor",
  "task",
  "idempotency_key",
  "mode",
  "level",
  "draft",
  "since",
  "until",
  "as_of",
  "valid_at",
  "during",
  "where",
  "fields",
  "order",
  "name",
  "scopes",
  "slots",
]);

/** A parameter path with every segment but indexes and contract parameter names as `*`. */
export const structuralPath = (path: string): string =>
  path
    .split("/")
    .map((s) => (/^\d+$/.test(s) || STRUCTURE.has(s) ? s : "*"))
    .join("/");

/**
 * A tenant store's connection gone under a use (02-architecture §7 «连接»), by the store's code: the
 * error itself, or the one it was raised over. `connection_lost`: the transaction certainly did
 * not commit; `commit_unknown`: its COMMIT was sent and no answer came, so it may have.
 */
export function lostConnectionOf(e: unknown): "connection_lost" | "commit_unknown" | undefined {
  for (const x of [e, e instanceof Error ? e.cause : undefined]) {
    const code = (x as { code?: unknown } | null | undefined)?.code;
    if (code === "connection_lost" || code === "commit_unknown") return code;
  }
  return undefined;
}

/** A tenant's connection gone, raised over the store's error with the tenant it was met on. */
export class LostConnectionOf extends Error {
  override readonly name = "LostConnectionOf";
  readonly tenant: string;
  constructor(tenant: string, cause: unknown) {
    super("the tenant's connection was gone", { cause });
    this.tenant = tenant;
  }
}

/**
 * A read-only operation that met its tenant's connection gone, nothing given yet: the caller's use
 * lends the tenant once more (opened again) and runs it again, once (server-callers.ts).
 */
export class RetryOnLostConnection extends Error {
  override readonly name = "RetryOnLostConnection";
  constructor() {
    super("the tenant's connection was gone; to be run once more on it opened again");
  }
}

/** Seconds a call refused for its tenant's connection gone is tried again after. */
const LOST_RETRY_AFTER = 1;

/** A new incident reference: random, no user content. */
export const newIncident = (): string => `inc_${randomBytes(8).toString("hex")}`;

/**
 * The contract error of anything an operation threw. `warn` hears of every path not implemented
 * (by its reason) and every internal error (by its incident and the error's own name and code,
 * never its message or detail, which may echo request content).
 */
export function contractError(
  e: unknown,
  warn: (event: string, fields: Readonly<Record<string, string>>) => void,
  o: { readonly tenant?: string } = {},
): ContractError {
  if (e instanceof ContractError) return e;
  // Logged where it was thrown (the try given up), once: answered as `connection_lost` is.
  if (e instanceof RetryOnLostConnection) {
    return new ContractError("unavailable", "the tenant's connection was gone; try again", {
      reason: "busy",
      retry_after: LOST_RETRY_AFTER,
    });
  }
  const lost = lostConnectionOf(e);
  if (lost !== undefined) {
    const tenant = o.tenant ?? (e instanceof LostConnectionOf ? e.tenant : undefined);
    warn("tenant_connection_lost", { ...(tenant !== undefined ? { tenant } : {}), code: lost });
    // Certainly not committed: nothing was recorded, and to retry is the answer (04-contract
    // `unavailable`). Maybe committed is not that: internal, below.
    if (lost === "connection_lost") {
      return new ContractError("unavailable", "the tenant's connection was gone; try again", {
        reason: "busy",
        retry_after: LOST_RETRY_AFTER,
      });
    }
  }
  if (isKernelError(e)) {
    const detail: Record<string, unknown> = { ...(e.detail ?? {}) };
    // The kernel's page position is the caller's `cursor`.
    if (detail["param"] === "position") detail["param"] = "cursor";
    if (e.code === "internal" && detail["reason"] === "not_implemented") {
      // Which stop, by structure only: the error's kind and the parameter path it names, with
      // every segment that is not an index or one of the contract's parameter names starred
      // (a field or table name is the caller's).
      warn("not_implemented", {
        error: e.name,
        ...(typeof detail["param"] === "string" ? { param: structuralPath(detail["param"]) } : {}),
      });
      return new ContractError("not_in_this_version", e.message, detail);
    }
    if (e.code !== "internal") return new ContractError(e.code as ErrorCode, e.message, detail);
  }
  return internalError(e, warn);
}

/** `internal`, with a new incident told to `warn` by the error's name and code, never its text. */
export function internalError(
  e: unknown,
  warn: (event: string, fields: Readonly<Record<string, string>>) => void,
): ContractError {
  const incident = newIncident();
  // The error it was caused by, if any: by name and code too (an internal error raised over
  // another, e.g. a detail that could not be read for a mismatch).
  const cause = e instanceof Error ? e.cause : undefined;
  warn("internal", {
    incident,
    error: e instanceof Error ? e.name : typeof e,
    ...(isKernelError(e) ? { code: e.code } : {}),
    ...(cause instanceof Error ? { cause: cause.name } : {}),
    ...(isKernelError(cause) ? { cause_code: cause.code } : {}),
  });
  return new ContractError("internal", "internal error", { incident });
}
