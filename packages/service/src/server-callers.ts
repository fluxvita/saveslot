// The server mode's callers (docs/zh-CN/spec/02-architecture.md §5 "解析流程"): a request's token is
// authenticated against the control plane and its tenant's log (`authenticateServer`), and the
// tenant is borrowed from the pool for the request, never kept past it. Connections are issued and
// revoked with their hashes in the control plane. Behind the same port as the local mode's
// (callers.ts).

import type { AuthFailure } from "./auth.ts";
import type { CallerResolver, ServedTenant } from "./callers.ts";
import { ContractError } from "./contract-error.ts";
import type { ControlPlane, TenantId, UserId } from "./control-plane.ts";
import { authenticateServer, type Caller, type CheckCredential } from "./server-auth.ts";
import {
  issueServerConnection,
  type RevokedOAuth,
  revokeServerConnection,
} from "./server-connections.ts";
import { type OpenTenant, type TenantPool, TenantPoolError } from "./tenant-pool.ts";

/** What the callers need of the identity provider: an account's state. */
export interface AccountStates {
  userState(user: UserId): Promise<"active" | "disabled" | "unknown">;
}

/** How a token is authenticated: `authenticateServer`, or a stand-in in tests. */
export type AuthenticateServer = (o: {
  readonly control: ControlPlane;
  readonly pool: TenantPool;
  readonly authorization: string | undefined;
  readonly now: string;
  readonly identity: AccountStates;
  readonly checkCredential?: CheckCredential;
}) => Promise<Caller | AuthFailure>;

/**
 * Seconds to wait for a tenant whose storage did not close (`busy`): it clears once that storage is
 * released, the same order as the limiter's least wait.
 */
const BUSY_RETRY_AFTER = 1;
/**
 * Seconds to wait for a server stopping (`stopping`): the process drains and its manager starts it
 * again within seconds; once it is up and catching up, the answer is `starting`.
 */
const STOPPING_RETRY_AFTER = 5;

/**
 * A tenant that does not serve now, as the contract says it (04-contract §16, §17): `unavailable`
 * for an import or a restore holding it, by this process's gate (`importing`, `restoring`) or by the
 * anchor's marker (`import_in_progress`, `restore_in_progress`), and for an import's staging
 * database not discarded with the marker there (`importing`: the import is not rolled back yet);
 * for a storage that did not close and cannot be opened again yet (`busy`); for a server stopping.
 * The pool's `busy` (an exclusive refused while another that refuses holds the tenant) follows its
 * holder: during a restore anything is `unavailable` (`restoring`); while an import holds it,
 * `rate_limited` (`busy`), as for another import or a reconcile in progress.
 * Anything else the pool refuses is not the caller's to wait out (a tenant not yet created or empty
 * behind a valid credential, a log behind its high water) and goes on as it is, to be answered
 * `internal`.
 */
async function serving<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw poolContractError(e);
  }
}

/** The pool's refusal as the contract gives it (see {@link serving}); anything else as it is. */
export function poolContractError(e: unknown): unknown {
  if (e instanceof TenantPoolError) {
    if (
      e.code === "importing" ||
      e.code === "import_in_progress" ||
      e.code === "staging_not_discarded"
    ) {
      return new ContractError("unavailable", "the tenant is being imported", {
        reason: "importing",
      });
    }
    if (e.code === "restoring" || e.code === "restore_in_progress") {
      return new ContractError("unavailable", "the tenant is being restored", {
        reason: "restoring",
      });
    }
    if (e.code === "busy" && e.holder === "restoring") {
      return new ContractError("unavailable", "the tenant is being restored", {
        reason: "restoring",
      });
    }
    if (e.code === "busy") {
      return new ContractError("rate_limited", "an import holds the tenant", {
        reason: "busy",
      });
    }
    if (e.code === "pool_full" || e.code === "open_failed") {
      return new ContractError("unavailable", "no connection for the tenant is free yet", {
        reason: "busy",
        retry_after: BUSY_RETRY_AFTER,
      });
    }
    if (e.code === "close_failed") {
      return new ContractError("unavailable", "the tenant cannot be opened yet", {
        reason: "busy",
        retry_after: BUSY_RETRY_AFTER,
      });
    }
    if (e.code === "pool_closed") {
      return new ContractError("unavailable", "the server is stopping", {
        reason: "stopping",
        retry_after: STOPPING_RETRY_AFTER,
      });
    }
  }
  return e;
}

export function serverCallers(o: {
  readonly control: ControlPlane;
  readonly pool: TenantPool;
  /** A disabled account refuses every credential of its tenant. */
  readonly identity: AccountStates;
  /** A further check of a credential found and not expired (an OAuth token's audience). */
  readonly checkCredential?: CheckCredential;
  /**
   * The OAuth tables, whose refresh tokens of a connection go when it is revoked (`runServer`
   * always gives them); absent, there are none to drop.
   */
  readonly oauth?: RevokedOAuth;
  /** The request's time, as `toISOString` writes it (`authenticateServer` refuses any other). */
  readonly now: () => string;
  readonly authenticate?: AuthenticateServer;
}): CallerResolver {
  const authenticate = o.authenticate ?? authenticateServer;
  const oauth: RevokedOAuth = o.oauth ?? { dropRefreshTokens: async () => 0 };
  const served = (tenant: TenantId, t: OpenTenant): ServedTenant => ({
    tenant,
    store: t.store,
    connections: {
      issue: (ctx, params) =>
        issueServerConnection({
          control: o.control,
          tenant,
          store: t.store,
          ctx,
          params,
          via: "token",
        }),
      revoke: (ctx, id) =>
        revokeServerConnection({ control: o.control, oauth, tenant, store: t.store, ctx, id }),
    },
  });
  return {
    async resolve(authorization) {
      const caller = await serving(() =>
        authenticate({
          control: o.control,
          pool: o.pool,
          authorization,
          now: o.now(),
          identity: o.identity,
          ...(o.checkCredential !== undefined ? { checkCredential: o.checkCredential } : {}),
        }),
      );
      if (!("principal" in caller)) return caller;
      return {
        principal: caller.principal,
        tenant: caller.tenant,
        use: (fn) =>
          serving(() =>
            o.pool.use(caller.tenant, (t) => fn(served(caller.tenant, t)), {
              ...(caller.entry !== undefined ? { entry: caller.entry } : {}),
            }),
          ),
        release: caller.release,
      };
    },
  };
}
