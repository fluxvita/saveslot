// Who a request comes from, and the tenant it is served on (docs/zh-CN/spec/02-architecture.md §5
// «身份», «解析流程»): the one port both surfaces go through, whatever the mode. The local mode has
// one tenant and its credentials file; the server mode finds the tenant from the control plane
// and borrows it from its pool. A surface resolves the caller once per request and runs the
// request inside `use`: the tenant is lent for that, never kept past it.

import type {
  ConnectionRecord,
  IssueConnectionParams,
  OpsContext,
  TenantStore,
} from "@fluxvita/saveslot-kernel";
import { type AuthFailure, authenticate, type Principal } from "./auth.ts";
import type { Credentials } from "./credentials.ts";
import { issueLocalConnection, revokeLocalConnection } from "./local-connections.ts";
import type { LocalTenant } from "./local-tenant.ts";

/** What the operations need of a tenant, in either mode: lent for one request. */
export interface ServedTenant {
  readonly tenant: LocalTenant["tenant"];
  readonly store: TenantStore;
  /** `connections.issue` and `connections.revoke`, as the mode keeps the tokens' hashes. */
  readonly connections: ConnectionIssuer;
}

export interface ConnectionIssuer {
  /** The connection and its token, shown this once. */
  issue(
    ctx: OpsContext,
    params: Omit<IssueConnectionParams, "via" | "client" | "id">,
  ): Promise<{ readonly connection: ConnectionRecord; readonly token: string }>;
  revoke(ctx: OpsContext, id: `ci_${string}`): Promise<ConnectionRecord>;
}

/** A request's caller: who it is, and its tenant, lent while `fn` runs. */
export interface ResolvedCaller {
  readonly principal: Principal;
  /** Its tenant's ID, known before the tenant is lent (what a per-tenant limit counts by). */
  readonly tenant: ServedTenant["tenant"];
  use<T>(fn: (t: ServedTenant) => Promise<T>): Promise<T>;
}

export interface CallerResolver {
  /** The caller of a request with this `Authorization` header, or why it is not one. */
  resolve(authorization: string | undefined): Promise<ResolvedCaller | AuthFailure>;
}

/** The local mode's tenant as the operations are served it. */
export function localServedTenant(tenant: LocalTenant, credentials: Credentials): ServedTenant {
  return {
    tenant: tenant.tenant,
    store: tenant.store,
    connections: {
      issue: (ctx, params) => issueLocalConnection({ tenant, credentials, ctx, params }),
      revoke: (ctx, id) => revokeLocalConnection({ tenant, ctx, id }),
    },
  };
}

/**
 * The local mode's callers: the tenant is taken afresh for each request and each `use` (an import
 * swaps the tenant's directory in and opens its store again: one taken earlier is stale by then).
 */
export function localCallers(o: {
  readonly tenant: () => LocalTenant;
  readonly credentials: Credentials;
}): CallerResolver {
  return {
    async resolve(authorization) {
      const who = await authenticate({
        credentials: o.credentials,
        tenant: o.tenant(),
        authorization,
      });
      if (!("kind" in who)) return who;
      return {
        principal: who,
        tenant: o.tenant().tenant,
        use: (fn) => fn(localServedTenant(o.tenant(), o.credentials)),
      };
    },
  };
}
