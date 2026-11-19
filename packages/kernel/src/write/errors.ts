// The errors the write and resolve pipelines return, by contract error code (04-contract-types §9).

import type { KernelErrorCode, KernelErrorDetail } from "@fluxvita/saveslot-contract-core";

/** An error the write pipeline returns, by contract error code (04-contract-types §9). */
export class WriteError<C extends KernelErrorCode = KernelErrorCode> extends Error {
  override readonly name = "WriteError";
  readonly code: C;
  readonly detail: KernelErrorDetail<C>;
  constructor(
    code: C,
    message: string,
    detail: KernelErrorDetail<C> = {},
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.code = code;
    this.detail = detail;
  }
}
