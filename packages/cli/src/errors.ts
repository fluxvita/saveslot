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
} from "@fluxvita/saveslot-client";
import { code, type Line, t, untrusted, words } from "./render/text.ts";
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

/** The exit code of a contract error: §6.2; `rate_limited` with reason `busy` is 7. */
export function exitOf(errorCode: string, reason: unknown): number {
  if (errorCode === "rate_limited" && reason === "busy") return 7;
  return EXIT_BY_CODE.get(errorCode as ErrorCode) ?? 5;
}

/** What the command says on stderr for an error, and its exit code; never a token or a path. */
export function describeError(e: unknown): { readonly lines: Line[]; readonly exit: number } {
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
    const hint = TEXTS.nextStep.get(e.code as ErrorCode);
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
