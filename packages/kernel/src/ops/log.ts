// `log.verify` (docs/zh-CN/spec/04-contract.md §17; 04-contract-types.md §8.4): checks the log's
// header chain, content checksums, index columns, removals and restore gaps, in one read
// transaction. For user sessions only.

import { type LogVerifyResult, verifyLog } from "../log/index.ts";
import type { TenantStore } from "../store/ports.ts";
import type { OpsContext } from "./context.ts";
import { begin } from "./management.ts";

/** `log.verify` for a user session. */
export async function logVerify(store: TenantStore, ctx: OpsContext): Promise<LogVerifyResult> {
  return store.read(async (tx) => {
    await begin(tx, ctx);
    return verifyLog(tx);
  });
}
