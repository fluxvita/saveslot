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

/** The contract's error codes (04-contract-types §9 `ErrorCode`). */
export const ERROR_CODES = [
  "invalid_argument",
  "unknown_table",
  "unknown_field",
  "not_found",
  "revoked",
  "derived_readonly",
  "validation_failed",
  "read_first",
  "schema_incompatible",
  "too_large",
  "sql_rejected",
  "sql_timeout",
  "draft_outdated",
  "field_unmatched",
  "confirmation_mismatch",
  "item_closed",
  "preview_outdated",
  "referenced",
  "lease_expired",
  "unauthenticated",
  "insufficient_scope",
  "rate_limited",
  "handle_expired",
  "not_in_this_version",
  "unavailable",
  "internal",
  "import_rejected",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const KNOWN: ReadonlySet<string> = new Set(ERROR_CODES);

/** An error as the contract gives it: a code and its detail (no stack, no internal message). */
export class ContractError extends Error {
  override readonly name = "ContractError";
  readonly code: ErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(code: ErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/** What a kernel error looks like: WriteError, ReadError and OpsError all have these. */
interface KernelError {
  readonly name: string;
  readonly code: string;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

const isKernelError = (e: unknown): e is KernelError =>
  e instanceof Error &&
  typeof (e as { code?: unknown }).code === "string" &&
  ["WriteError", "ReadError", "OpsError"].includes(e.name);

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
): ContractError {
  if (e instanceof ContractError) return e;
  if (isKernelError(e) && KNOWN.has(e.code)) {
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
  const incident = newIncident();
  warn("internal", {
    incident,
    error: e instanceof Error ? e.name : typeof e,
    ...(isKernelError(e) ? { code: e.code } : {}),
  });
  return new ContractError("internal", "internal error", { incident });
}
