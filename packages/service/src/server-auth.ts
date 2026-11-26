// Who a request of the server mode comes from (docs/zh-CN/spec/02-architecture.md §5 «身份»,
// «权限»; 04-contract.md §12, §16 `unauthenticated`): the `Authorization` header's token → its hash →
// the control plane's credential (routing only) → expired is refused there, before any tenant is
// opened → the tenant owner's account state from the identity provider (disabled refused as
// `account_disabled`, unknown as `invalid`, the tenant still not opened) → the tenant, lent by the pool → the principal's state, scopes and slot range from the
// tenant log (`principals`), as in the local mode: a principal revoked in the log is refused though
// its hash is still in the control plane.
//
// Every request asks the control database for the credential and the tenant's owner, and the
// identity provider for the owner's state: no cache. The control database has
// one connection, so authentications queue with the anchor store's writes; a cache from hash to
// (tenant, principal) is safe, authorization being the log's, but forgetting a credential would
// then have to reach it in every process.

import { type AuthFailure, type Principal, principalFromRow, principalRow } from "./auth.ts";
import type { ControlPlane, CredentialEntry, TenantEntry, TenantId } from "./control-plane.ts";
import type { IdentityProvider } from "./identity.ts";
import { isInstant } from "./server-control-plane.ts";
import type { TenantPool } from "./tenant-pool.ts";
import { bearerToken, tokenHash } from "./tokens.ts";

/**
 * A further check of a credential found and not expired, before its tenant is opened: an OAuth
 * access token's audience (RFC 8707), for one. `invalid` refuses the request as `invalid`.
 */
export type CheckCredential = (c: CredentialEntry) => Promise<"ok" | "invalid">;

/** A request's caller: its tenant, and the principal it acts as with what it may do and see. */
export interface Caller {
  readonly tenant: TenantId;
  readonly principal: Principal;
  /**
   * Lets the tenant count as idle again: it is held from the authentication on, so that it is not
   * closed for another before the request's operation uses it (TenantPool `hold`).
   */
  readonly release: () => void;
  /**
   * The tenant's row of the directory as the authentication read it: its operation's use compares
   * it with what is open (TenantPool `use`), so that the request reads it once.
   */
  readonly entry?: TenantEntry;
}

/**
 * Finds the caller of a request by its bearer token (02-architecture §5; 04-contract §12, §16). A
 * refusal is an `AuthFailure`; a valid credential whose tenant does not serve now (still being
 * created, an import or a restore in progress) throws the pool's `TenantPoolError`, which the
 * surfaces answer as `unavailable` (04-contract §16).
 */
export async function authenticateServer(o: {
  readonly control: ControlPlane;
  readonly pool: TenantPool;
  readonly authorization: string | undefined;
  /**
   * The request's time, compared with a credential's expiry: an instant as `toISOString` writes it
   * (the two compare as strings), anything else refused.
   */
  readonly now: string;
  readonly checkCredential?: CheckCredential;
  /** The account states: every credential of a disabled account's tenant is refused. */
  readonly identity: Pick<IdentityProvider, "userState">;
}): Promise<Caller | AuthFailure> {
  if (!isInstant(o.now)) {
    throw new Error("the request's time is an instant as toISOString writes it");
  }
  if (o.authorization === undefined || o.authorization === "") {
    return { code: "unauthenticated", reason: "missing" };
  }
  const bearer = bearerToken(o.authorization);
  if (bearer === undefined) return { code: "unauthenticated", reason: "invalid" };
  const entry = await o.control.credential(tokenHash(bearer.token));
  // A token of one kind recorded as the other is not a token of this credential.
  if (entry === undefined || entry.kind !== bearer.kind) {
    return { code: "unauthenticated", reason: "invalid" };
  }
  if (entry.expiresAt !== undefined && entry.expiresAt <= o.now) {
    return { code: "unauthenticated", reason: "expired" };
  }
  if (o.checkCredential !== undefined && (await o.checkCredential(entry)) !== "ok") {
    return { code: "unauthenticated", reason: "invalid" };
  }
  const tenant = await o.control.tenant(entry.tenant);
  const state = tenant === undefined ? "unknown" : await o.identity.userState(tenant.owner);
  if (state === "disabled") return { code: "unauthenticated", reason: "account_disabled" };
  if (state !== "active") return { code: "unauthenticated", reason: "invalid" };
  // Held inside this use, so that it is never idle between this use and the operation's.
  let release: (() => void) | undefined;
  const principal = await o.pool.use(
    entry.tenant,
    async (t) => {
      const p = principalFromRow(
        entry.kind,
        entry.principal,
        await principalRow(t.store, entry.principal),
      );
      if ("kind" in p) release = o.pool.hold(entry.tenant);
      return p;
    },
    tenant !== undefined ? { entry: tenant } : {},
  );
  return "kind" in principal && release !== undefined
    ? {
        tenant: entry.tenant,
        principal,
        release,
        ...(tenant !== undefined ? { entry: tenant } : {}),
      }
    : (principal as AuthFailure);
}
