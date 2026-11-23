// `POST /v1/import` in the server mode (05-surfaces «导入»; 04-contract §17 `import`): the request's
// body imported into the caller's tenant by `importServerTenant`, as the local mode's route does it.
//
// The body is read as it comes in, each chunk waited for at most the idle time and not past a stop
// (`bodyWithin`): one that stalls, breaks off or is abandoned is `import_rejected` (`incomplete`)
// before ④, and the tenant stays empty. Each line is bounded by the kernel (`too_large`,
// `import_line`); the body as a whole is not.
//
// The caller's authentication used the tenant (`serverCallers`) and must have let it go before this
// is called: the import holds the tenant with the pool's `exclusive`, which waits for every use.

import type { ImportResult } from "@fluxvita/saveslot-contract";
import { importContractError, OpsError } from "@fluxvita/saveslot-kernel";
import { ContractError } from "./contract-error.ts";
import { bodyWithin, IMPORT_BODY_IDLE_MS, IMPORT_BUSY_RETRY_AFTER } from "./local-import.ts";
import { poolContractError } from "./server-callers.ts";
import { importServerTenant } from "./server-import.ts";
import { TenantPoolError } from "./tenant-pool.ts";

/**
 * Imports the request's body into `tenant` and gives the contract's result, nothing else of the
 * import's own. Errors as the contract gives them (`ContractError`): `import_rejected`, `too_large`
 * (`import_line`), `invalid_argument` (`tenant_not_empty`), `rate_limited` (`busy`, with
 * `retry_after`) while another import holds the tenant, `unavailable` as the pool refuses (a
 * restore, a stop); anything else as it is.
 */
export async function importServerRequest(
  o: Omit<Parameters<typeof importServerTenant>[0], "body"> & {
    /** The request's body, as it comes in. */
    readonly body: AsyncIterable<Uint8Array>;
    /** How long the body may give nothing ({@link IMPORT_BODY_IDLE_MS} otherwise). */
    readonly bodyIdleMs?: number;
    /** Aborted when the server stops: a body still being read is abandoned. */
    readonly signal?: AbortSignal;
  },
): Promise<ImportResult> {
  try {
    const r = await importServerTenant({
      control: o.control,
      backend: o.backend,
      pool: o.pool,
      discardDatabase: o.discardDatabase,
      tenant: o.tenant,
      user: o.user,
      body: bodyWithin(o.body, o.bodyIdleMs ?? IMPORT_BODY_IDLE_MS, o.signal),
      now: o.now,
      ...(o.onDiscardFailure !== undefined ? { onDiscardFailure: o.onDiscardFailure } : {}),
    });
    return r.contract;
  } catch (e) {
    throw importRequestError(e);
  }
}

function importRequestError(e: unknown): unknown {
  // Another import holds the tenant: as the local mode answers it, with when to try again.
  if (e instanceof TenantPoolError && e.code === "busy" && e.holder !== "restoring") {
    return new ContractError("rate_limited", "an import of this tenant is in progress", {
      reason: "busy",
      retry_after: IMPORT_BUSY_RETRY_AFTER,
    });
  }
  if (
    e instanceof OpsError &&
    e.code === "invalid_argument" &&
    (e.detail as { reason?: unknown }).reason === "tenant_not_empty"
  ) {
    return new ContractError("invalid_argument", "the tenant is not empty", {
      reason: "tenant_not_empty",
    });
  }
  const c = importContractError(e);
  if (c !== undefined && c.code !== "internal") {
    const { code, ...detail } = c;
    return new ContractError(code, "the import was refused", detail);
  }
  return poolContractError(e);
}
