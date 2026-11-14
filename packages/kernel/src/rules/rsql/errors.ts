// Why a derived rule is refused (docs/zh-CN/spec/03-data-model/11-restricted-sql.md «拒绝时报什么»,
// derived rule column). Thrown inside the compiler at the first problem, turned into the result there.

/** Reasons, the same values as `sql_rejected`'s (04-contract-types `ValidationDetail.sql_reason`). */
export type SqlReason =
  | "syntax"
  | "not_select"
  | "function"
  | "node"
  | "system_time"
  | "unknown_name"
  | "type"
  | "limit"
  | "runtime";

export type RuleDetailCode =
  | "rule_sql_rejected"
  | "nondeterministic_function"
  | "unit_inference_failed"
  | "cross_slot_ref";

export type RsqlStop =
  | {
      readonly kind: "rejected";
      readonly code: RuleDetailCode;
      readonly reason?: SqlReason;
      /** Byte offset in the rule text, when the problem has a place. */
      readonly loc?: number;
      /** For people: what is wrong, by logical names and node or function names only. */
      readonly message: string;
      readonly suggestion?: string;
    }
  /** Outermost level not an aggregate (06 «刷新范围与写入准入»). */
  | { readonly kind: "not_in_this_version"; readonly loc?: number; readonly message: string }
  /** In the whitelist, not compiled by this kernel yet. */
  | { readonly kind: "not_implemented"; readonly loc?: number; readonly message: string };

export class RsqlError extends Error {
  readonly stop: RsqlStop;
  constructor(stop: RsqlStop) {
    super(stop.message);
    this.name = "RsqlError";
    this.stop = stop;
  }
}

export function reject(
  code: RuleDetailCode,
  reason: SqlReason | undefined,
  loc: number | undefined,
  message: string,
  suggestion?: string,
): never {
  throw new RsqlError({
    kind: "rejected",
    code,
    ...(reason !== undefined ? { reason } : {}),
    ...(loc !== undefined ? { loc } : {}),
    message,
    ...(suggestion !== undefined ? { suggestion } : {}),
  });
}

/** Node or form not in the whitelist. */
export const refuseNode = (loc: number | undefined, what: string): never =>
  reject("rule_sql_rejected", "node", loc, `${what} is not allowed in a derived rule`);

/** Refused only because the result is not determined (11 «确定性»). */
export const refuseNondeterministic = (
  loc: number | undefined,
  reason: "function" | "node",
  what: string,
  suggestion?: string,
): never =>
  reject(
    "nondeterministic_function",
    reason,
    loc,
    `${what}: its result is not determined by the data`,
    suggestion,
  );

export const notYet = (loc: number | undefined, what: string): never => {
  throw new RsqlError({
    kind: "not_implemented",
    ...(loc !== undefined ? { loc } : {}),
    message: `${what} in a derived rule is not compiled yet`,
  });
};
