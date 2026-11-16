// The errors the write and resolve pipelines return, by contract error code (04-contract-types §9).

/** An error the write pipeline returns, by contract error code (04-contract-types §9). */
export class WriteError extends Error {
  override readonly name = "WriteError";
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}
