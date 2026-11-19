// Errors an `ops` entry returns to the service layer, by contract error code
// (docs/zh-CN/spec/04-contract-types.md §9). Only the codes the implemented entries use.

import type { KernelErrorReason } from "@fluxvita/saveslot-contract-core";

export type OpsErrorCode = "invalid_argument" | "not_found" | "insufficient_scope" | "internal";

export interface OpsErrorDetail<C extends OpsErrorCode = OpsErrorCode> {
  readonly reason?: KernelErrorReason<C>;
  readonly param?: string;
  readonly required_scope?: string;
  /** `slot_not_empty` for an open schema change item only: why, and which item. */
  readonly cause?: string;
  readonly item?: string;
}

export class OpsError<C extends OpsErrorCode = OpsErrorCode> extends Error {
  override readonly name = "OpsError";
  readonly code: C;
  readonly detail: OpsErrorDetail<C>;
  constructor(code: C, message: string, detail: OpsErrorDetail<C> = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}
