// Errors of `judge`. The write pipeline maps them to the contract's error codes.

export type JudgeErrorReason =
  /** `corrected_span` where the field has no value at "now" (05-time «写状态：参数与默认»). */
  | "invalid_argument"
  /** The part taking effect falls where the entity has no value and lacks required fields. */
  | "validation_failed"
  /** A write to a revoked row of an event or timeless table (09-references-conflict-sync). */
  | "revoked"
  /** A ruleset version `judge` does not know. */
  | "unknown_version"
  /** Input that cannot come from a valid request (e.g. confirming a write that is not awaiting). */
  | "invalid"
  /**
   * A construct a deletion's replay does not handle in this version (D1-b, by kind): refused,
   * never judged as something else.
   */
  | "not_implemented";

export class JudgeError extends Error {
  readonly reason: JudgeErrorReason;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(reason: JudgeErrorReason, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "JudgeError";
    this.reason = reason;
    this.detail = detail;
  }
}
