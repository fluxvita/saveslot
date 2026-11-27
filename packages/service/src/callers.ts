// Who a request comes from, and the tenant it is served on (docs/zh-CN/spec/02-architecture.md §5
// «身份», "解析流程"): the one port both surfaces go through, whatever the mode. The local mode has
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
import type { CallerSource } from "./caller-source.ts";
import type { Credentials } from "./credentials.ts";
import { issueLocalConnection, revokeLocalConnection } from "./local-connections.ts";
import { importingError, type LocalTenantGate } from "./local-import.ts";
import type { LocalTenant } from "./local-tenant.ts";

/** What the operations need of a tenant, in either mode: lent for one request. */
export interface ServedTenant {
  readonly tenant: LocalTenant["tenant"];
  readonly store: TenantStore;
  /** `connections.issue` and `connections.revoke`, as the mode keeps the tokens' hashes. */
  readonly connections: ConnectionIssuer;
  /**
   * The server mode's first lending of a request's tenant: a read-only operation that meets the
   * connection gone throws `RetryOnLostConnection`, and the use lends it once more (opened again).
   */
  readonly retryOnLost?: boolean;
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
  /**
   * The server mode: lets its tenant count as idle again (02-architecture §7 «连接»). Its
   * authentication holds the tenant from then until the request's response ends; the surfaces
   * call this once it has (a second call does nothing).
   */
  readonly release?: () => void;
  /** The server mode: how its credential came to be, for its call records. */
  readonly source?: CallerSource;
}

/**
 * Releases the caller's hold on its tenant when this request's response ends (its `close`, which
 * is the response's, a keep-alive connection's later requests aside), or at once when it ended
 * already (the client gone before the caller was found).
 */
export function releaseWithResponse(
  caller: Pick<ResolvedCaller, "release">,
  res: { readonly closed: boolean; once(event: "close", fn: () => void): unknown },
): void {
  const release = caller.release;
  if (release === undefined) return;
  if (res.closed) release();
  else res.once("close", release);
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
 * With a gate, authenticating and each use run as uses of the tenant: refused with `unavailable`
 * (`importing`) while an import holds it, and waited for by an import that begins. A request
 * authenticated before an import or a restore and served after it is refused the same way (02-
 * architecture §8): its caller was found on a tenant that is not the one it would run on.
 */
export function localCallers(o: {
  readonly tenant: () => LocalTenant;
  readonly credentials: Credentials;
  readonly gate?: LocalTenantGate;
}): CallerResolver {
  const asUse = <T>(fn: () => Promise<T>): Promise<T> =>
    o.gate !== undefined ? o.gate.use(fn) : fn();
  return {
    resolve: (authorization) =>
      asUse(async () => {
        const at = o.tenant();
        const who = await authenticate({ credentials: o.credentials, tenant: at, authorization });
        if (!("kind" in who)) return who;
        const point = at.restorePoint;
        return {
          principal: who,
          tenant: at.tenant,
          use: (fn) =>
            asUse(async () => {
              const now = o.tenant();
              if (
                now.restorePoint.restoreCount !== point.restoreCount ||
                now.restorePoint.point !== point.point
              ) {
                throw importingError();
              }
              return fn(localServedTenant(now, o.credentials));
            }),
        };
      }),
  };
}
