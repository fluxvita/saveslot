// Exit codes and the text of an error (docs/zh-CN/spec/06-cli.md §6.2, §6.3). The text is general:
// it goes by `code`, `reason` and `message`, not by each code's detail fields, so it does not wait
// for those to settle; `--json` gives the whole error object as answered.

import {
  ClientUsageError,
  ContractCallError,
  CredentialError,
  ERROR_CODES,
  type ErrorCode,
  TransportError,
  VALIDATION_DETAIL_CODES,
} from "@fluxvita/saveslot-client";
import { closedLines } from "./render/pending.ts";
import { periodOf, type R } from "./render/reads.ts";
import { code, id, join, type Line, num, t, untrusted, words } from "./render/text.ts";
import { TEXTS } from "./texts.ts";

/** 06 §6.2, by contract code; `rate_limited` by its reason. A code not here exits 5. */
export const EXIT_BY_CODE: ReadonlyMap<ErrorCode, number> = new Map<ErrorCode, number>([
  ["internal", 1],
  ["read_first", 3],
  ["confirmation_mismatch", 3],
  ["item_closed", 3],
  ["preview_outdated", 3],
  ["handle_expired", 3],
  ["draft_outdated", 3],
  ["schema_incompatible", 3],
  ["not_found", 4],
  ["unknown_table", 4],
  ["unknown_field", 4],
  ["invalid_argument", 5],
  ["validation_failed", 5],
  ["field_unmatched", 5],
  ["sql_rejected", 5],
  ["sql_timeout", 5],
  ["too_large", 5],
  ["derived_readonly", 5],
  ["revoked", 5],
  ["not_in_this_version", 5],
  ["import_rejected", 5],
  ["rate_limited", 5],
  ["unauthenticated", 6],
  ["insufficient_scope", 6],
  ["unavailable", 7],
]);

/** The contract's codes, for writing a code outside the boundary. */
const CODES: ReadonlySet<string> = new Set<string>(ERROR_CODES);
const DETAIL_CODES: ReadonlySet<string> = new Set<string>(VALIDATION_DETAIL_CODES);

/** The exit code of a contract error: §6.2; `rate_limited` with reason `busy` is 7. */
export function exitOf(errorCode: string, reason: unknown): number {
  if (errorCode === "rate_limited" && reason === "busy") return 7;
  // A conflict with several candidates and none named: a usage error (06 §5.2).
  if (errorCode === "invalid_argument" && reason === "candidate_required") return 2;
  return EXIT_BY_CODE.get(errorCode as ErrorCode) ?? 5;
}

/** What the command says on stderr for an error, and its exit code; never a token or a path. */
export function describeError(
  e: unknown,
  o: {
    /** false: no general next step (the caller says its own; the code's is not about this). */
    readonly nextStep?: boolean;
  } = {},
): { readonly lines: Line[]; readonly exit: number } {
  if (e instanceof ContractCallError) {
    const reason = Object.hasOwn(e.body, "reason") ? e.body["reason"] : undefined;
    const message = Object.hasOwn(e.body, "message") ? e.body["message"] : undefined;
    const head = t`error ${code(e.code, CODES)}`;
    const lines: Line[] = [
      [
        ...head,
        ...(typeof reason === "string" ? t` (${untrusted(reason)})` : []),
        ...(typeof message === "string" ? t`: ${untrusted(message)}` : []),
      ],
    ];
    // Each detail (a compile failure's positions among them, 06 §4.3 slot create; a write's fields
    // without a value, by op, table, field and stretch, 04-contract-types §9): its code, and where
    // it is. The stretch is written as reads write periods (open at the start, or all time).
    const details = Object.hasOwn(e.body, "details") ? e.body["details"] : undefined;
    for (const d of Array.isArray(details) ? details : []) {
      const x = (typeof d === "object" && d !== null ? d : {}) as Record<string, unknown>;
      // The keys are the CLI's own words; their values come from the service, inside the boundary.
      const where = (["op", "path", "table", "field", "line"] as const)
        .filter((k) => x[k] !== undefined)
        .map(
          (k) =>
            t`${words(TEXTS.detailKey(k))} ${typeof x[k] === "number" ? num(x[k] as number) : untrusted(String(x[k]))}`,
        );
      if (typeof x["valid"] === "object" && x["valid"] !== null) {
        where.push(t`${words(TEXTS.detailValid)} ${periodOf(x["valid"])}`);
      }
      // The bound passed, as the MCP text gives it too.
      const n = (v: unknown) =>
        typeof v === "string" && /^(0|[1-9][0-9]{0,8})$/.test(v)
          ? num(Number(v))
          : untrusted(String(v));
      const bound = [
        ...(x["max"] !== undefined ? [t`${words(TEXTS.detailMax)} ${n(x["max"])}`] : []),
        ...(x["min"] !== undefined ? [t`${words(TEXTS.detailMin)} ${n(x["min"])}`] : []),
        // Why a rule's SQL was refused, as the MCP text gives it (05 §7): the contract's code.
        ...(typeof x["sql_reason"] === "string"
          ? [t`${words(TEXTS.detailSqlReason)} ${untrusted(x["sql_reason"])}`]
          : []),
      ];
      lines.push([
        ...t`  ${code(String(x["code"] ?? ""), DETAIL_CODES)}`,
        ...(bound.length > 0 ? t` (${join(bound, t`, `)})` : []),
        ...(where.length > 0 ? t`${words(TEXTS.detail)} ${join(where, t`, `)}` : []),
      ]);
      // A fix the service worked out from what the caller wrote: inside the boundary.
      if (typeof x["suggestion"] === "string") {
        lines.push(t`    ${words(TEXTS.detailSuggestion)} ${untrusted(x["suggestion"])}`);
      }
      // As many slots as the tenant may have: there is no way yet to make room.
      if (x["code"] === "out_of_bounds" && x["path"] === "slot" && x["max"] !== undefined) {
        lines.push(t`  ${words(TEXTS.slotsFull)}`);
      }
    }
    // The item's version now, for one that changed since it was read (06 §5.2).
    const current = Object.hasOwn(e.body, "current") ? e.body["current"] : undefined;
    if (typeof current === "object" && current !== null && Object.hasOwn(current, "item_ver")) {
      lines.push(
        t`  ${words(TEXTS.itemVersionNow)} ${id(String((current as { item_ver: unknown }).item_ver))}`,
      );
    }
    // An item closed already: how it ended, as its details say it (04-contract-types §9).
    if (e.code === "item_closed") lines.push(...closedLines(e.body as R));
    // The candidates to name with --candidate.
    const choices = Object.hasOwn(e.body, "candidate_choices")
      ? e.body["candidate_choices"]
      : undefined;
    for (const c of Array.isArray(choices) ? choices : []) {
      const x = (typeof c === "object" && c !== null ? c : {}) as Record<string, unknown>;
      lines.push(
        t`  --candidate ${typeof x["index"] === "number" ? num(x["index"]) : untrusted(String(x["index"]))} (#${typeof x["seq"] === "number" ? num(x["seq"]) : untrusted(String(x["seq"]))})`,
      );
    }
    const hint = o.nextStep === false ? undefined : TEXTS.nextStep.get(e.code as ErrorCode);
    if (hint !== undefined) lines.push(t`  ${words(hint)}`);
    return { lines, exit: exitOf(e.code, reason) };
  }
  if (e instanceof CredentialError) {
    return { lines: [[words(TEXTS.credential(e.code))]], exit: 6 };
  }
  if (e instanceof TransportError) {
    return {
      lines: [[words(TEXTS.transport(e.code))]],
      exit: e.code === "bad_answer" ? 1 : 7,
    };
  }
  if (e instanceof ClientUsageError) {
    return { lines: [t`error: ${untrusted(e.message)}`], exit: 2 };
  }
  return { lines: [[words(TEXTS.internal)]], exit: 1 };
}

/** Whether an error's details point at `path` in the document. */
function detailAt(e: ContractCallError, path: string): boolean {
  const details = Object.hasOwn(e.body, "details") ? e.body["details"] : undefined;
  return (
    Array.isArray(details) &&
    details.some(
      (d) => typeof d === "object" && d !== null && (d as { path?: unknown }).path === path,
    )
  );
}

/**
 * A slot's time zone refused when the command line gave one (`slot create`, `setup`): what it
 * takes. Undefined for any other error.
 */
export function timezoneHint(e: unknown, given: boolean) {
  return given && e instanceof ContractCallError && detailAt(e, "timezone")
    ? TEXTS.timezoneRefused
    : undefined;
}
