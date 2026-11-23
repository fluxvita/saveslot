// The control plane store (docs/zh-CN/spec/02-architecture.md §5 «控制面存储»): what has to be found
// before a tenant's storage can be opened, so it is kept apart from that storage, out of the tenant's
// log and out of its export. Two implementations: the local mode's files (local-control-plane.ts)
// and the server mode's PostgreSQL database.
//
// What it says of a credential is for finding the tenant and the principal only. Who may do what is
// the tenant log's (`principals`: state, scopes, slot range), read on every request: a principal
// revoked in the log is refused though its token's hash is still here.

import type { AnchorStore, TenantRef } from "@fluxvita/saveslot-kernel";

export type TenantId = `tn_${string}`;
export type UserId = `u_${string}`;
export type ConnectionId = `ci_${string}`;
export type PrincipalId = UserId | ConnectionId;

/** A tenant of the tenant directory, and where its storage is (§5 «租户目录», «路由»). */
export interface TenantEntry {
  readonly id: TenantId;
  /** The user who owns it (v1: a tenant is a user's). */
  readonly owner: UserId;
  readonly ref: TenantRef;
  /** `creating` until its storage holds the genesis; only an `active` tenant serves. */
  readonly state: "creating" | "active";
  /**
   * An import's staging database while there is one, and after the swap the database it replaced
   * until that is dropped (server mode; 02-architecture §5, §8).
   */
  readonly staging?: string;
}

/** What a token's hash stands for. The scopes and the slot range are not here: they are the log's. */
export interface CredentialEntry {
  readonly hash: string;
  readonly kind: "session" | "connection";
  readonly principal: PrincipalId;
  readonly tenant: TenantId;
  /** When the credential stops authenticating; none for credentials that do not expire. */
  readonly expiresAt?: string;
  /**
   * The authorization (an OAuth grant) the credential came from, when it came from one: signing
   * out of one grant leaves the principal's credentials of other grants.
   */
  readonly grant?: string;
}

export interface ControlPlane {
  /** The tenants' anchor store (§8): one per control plane, every tenant in it. */
  readonly anchors: AnchorStore;
  tenant(id: TenantId): Promise<TenantEntry | undefined>;
  /** The tenant a user owns. */
  tenantOf(owner: UserId): Promise<TenantEntry | undefined>;
  /**
   * The credential of a token's hash, expired ones included: whoever authenticates compares
   * `expiresAt` with its own clock and refuses an expired one.
   */
  credential(hash: string): Promise<CredentialEntry | undefined>;
  /**
   * Records a credential, durably, before it returns. Its hash is 64 lower-case hex digits; its
   * expiry, when it has one, a canonical instant (`toISOString`), so that comparing instants as
   * strings orders them; a hash already there is refused.
   */
  putCredential(entry: CredentialEntry): Promise<void>;
  /**
   * Forgets the tenant's credentials of these principals, durably; how many went. A principal's ID
   * can be in two tenants' logs (one imported from the other's export): the other tenant's are left.
   * With `kind`, only those of that kind (a password changed ends a user's sessions, not the
   * connections it issued). The local mode refuses `kind: "session"`: its one session is replaced,
   * never removed.
   */
  removeCredentials(
    tenant: TenantId,
    principals: ReadonlySet<PrincipalId>,
    opts?: { readonly kind?: "session" | "connection" },
  ): Promise<number>;
}

/**
 * The server mode's control plane: the tenant directory's states, which the service's flows write
 * (tenant creation, an import's swap). Each call is one transaction of the control database.
 */
export interface ServerControl extends ControlPlane {
  /** Registers a tenant as `creating`; the owner's tenant as it is when it has one (v1: one a user). */
  registerTenant(e: {
    readonly id: TenantId;
    readonly owner: UserId;
    readonly ref: TenantRef;
  }): Promise<TenantEntry>;
  /** Marks the tenant `active`; on an active tenant, nothing. */
  activateTenant(id: TenantId): Promise<void>;
  /** Records the database an import stages into; `null` forgets it. */
  setStaging(id: TenantId, database: string | null): Promise<void>;
  /**
   * In one transaction, the staging database becomes the tenant's database and the one it replaced
   * is recorded as the staging database, to be dropped (02-architecture §5, §8, import step ⑤);
   * refused when there is none.
   */
  swapInStaging(id: TenantId): Promise<void>;
}
