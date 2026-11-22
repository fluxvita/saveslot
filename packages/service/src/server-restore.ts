// A server-mode tenant restored from a backup (docs/zh-CN/spec/02-architecture.md §8 «恢复备份、快照、
// 冷租户归档之后必须走恢复流程»; 06-cli.md §4.1 `saveslot server restore`): after the deployer has put
// a tenant's database back from a backup, and before the tenant serves, the kernel's restore flow
// runs on it with the control plane's anchor store. The control database is not put back: its
// deletion registry and high water mark are what the flow goes by.
//
// The deletions the registry holds and the restored log lacks are not made up yet: a tenant with
// entries in its registry is refused by the kernel before anything changes
// (`deletion_backfill_not_implemented`), never restored over. A restore stopped half way is taken
// up where it stopped by running it again (the anchor's marker); run on a tenant whose restore has
// finished, it is another restore (a new `tenant.restored`, the restore count raised once more).

import { type RestoreResult, restoreTenant, type StorageBackend } from "@fluxvita/saveslot-kernel";
import type { TenantId } from "./control-plane.ts";
import type { ServerControlPlane } from "./server-control-plane.ts";

/** The kernel's refusals of the flow, for the entry package, which does not depend on the kernel. */
export { RestoreError, type RestoreErrorCode } from "@fluxvita/saveslot-kernel";

/** Why a tenant cannot be restored here, before the kernel is asked. */
export class ServerRestoreError extends Error {
  override readonly name = "ServerRestoreError";
  readonly code: "unknown_tenant" | "tenant_not_active";
  constructor(code: ServerRestoreError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Runs the restore flow on `tenant`'s storage, opened through `backend`, closed after. Throws
 * `ServerRestoreError` for a tenant the directory does not have or has not finished, and the
 * kernel's `RestoreError` as it gives it.
 */
export async function restoreTenantFromBackup(o: {
  readonly control: ServerControlPlane;
  readonly backend: StorageBackend;
  readonly tenant: TenantId;
  readonly now: string;
}): Promise<RestoreResult> {
  const entry = await o.control.tenant(o.tenant);
  if (entry === undefined) {
    throw new ServerRestoreError("unknown_tenant", "the tenant directory has no such tenant");
  }
  if (entry.state !== "active") {
    throw new ServerRestoreError("tenant_not_active", "the tenant's creation has not finished");
  }
  const store = await o.backend.open(entry.ref, { create: false });
  try {
    return await restoreTenant({
      store,
      anchor: o.control.anchors,
      tenant: o.tenant,
      now: o.now as Parameters<typeof restoreTenant>[0]["now"],
    });
  } finally {
    await store.close();
  }
}
