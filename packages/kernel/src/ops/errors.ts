// Errors an `ops` entry returns to the service layer, by contract error code
// (docs/zh-CN/spec/04-contract-types.md §9). Only the codes the implemented entries use.

export type OpsErrorCode = "invalid_argument" | "not_found" | "insufficient_scope" | "internal";

export interface OpsErrorDetail {
  readonly reason?: string;
  readonly param?: string;
  readonly required_scope?: string;
  /** `slot_not_empty` for an open schema change item only: why, and which item. */
  readonly cause?: string;
  readonly item?: string;
}

export class OpsError extends Error {
  override readonly name = "OpsError";
  readonly code: OpsErrorCode;
  readonly detail: OpsErrorDetail;
  constructor(code: OpsErrorCode, message: string, detail: OpsErrorDetail = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}
