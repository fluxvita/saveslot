// Who a request of the server mode comes from (docs/zh-CN/spec/02-architecture.md §5 «身份»,
// «权限»; 04-contract.md §12, §16 `unauthenticated`): the `Authorization` header's token → its hash →
// the control plane's credential (routing only) → expired is refused there, before any tenant is
// opened → the tenant, lent by the pool → the principal's state, scopes and slot range from the
// tenant log (`principals`), as in the local mode: a principal revoked in the log is refused though
// its hash is still in the control plane.

import type { AuthFailure, Principal } from "./auth.ts";
import type { ControlPlane, TenantId } from "./control-plane.ts";
import type { TenantPool } from "./tenant-pool.ts";

/** A request's caller: its tenant, and the principal it acts as with what it may do and see. */
export interface Caller {
  readonly tenant: TenantId;
  readonly principal: Principal;
}

export async function authenticateServer(_o: {
  readonly control: ControlPlane;
  readonly pool: TenantPool;
  readonly authorization: string | undefined;
  /** The request's time, compared with a credential's expiry. */
  readonly now: string;
}): Promise<Caller | AuthFailure> {
  throw new Error("authenticateServer: not implemented");
}
