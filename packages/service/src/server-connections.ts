// Connection instance tokens of the server mode (docs/zh-CN/spec/04-contract.md §12, §16;
// 02-architecture.md §5 «身份», «控制面存储»): as in the local mode (local-connections.ts), issuing
// makes a token, records its hash in the control plane, then registers the connection in the
// tenant's log; revoking registers the revocation and keeps the hash, so the token is refused as
// `revoked`, not as unknown. The token is returned once and kept nowhere.
//
// The hash is recorded before the registration commits, under the ID the registration then takes:
// interrupted between the two, the control plane holds a hash of a principal the tenant's log does
// not have, which authenticates as nothing (`invalid`); no connection is left in the log that no
// one holds a token of. A registration that fails drops the hash again, as far as it can.

import {
  type ConnectionRecord,
  type IssueConnectionParams,
  issueConnection,
  newConnectionId,
  type OpsContext,
  revokeConnection,
  type TenantStore,
} from "@fluxvita/saveslot-kernel";
import type { ConnectionId, ControlPlane, TenantId } from "./control-plane.ts";
import { newToken, tokenHash } from "./tokens.ts";

/** `connections.issue` in the server mode: the connection and its token, shown this once. */
export async function issueServerConnection(o: {
  readonly control: ControlPlane;
  readonly tenant: TenantId;
  /** The tenant's store, lent by the pool for this call. */
  readonly store: TenantStore;
  /** Its actor is the user who issues it, or who authorized it (OAuth). */
  readonly ctx: OpsContext;
  readonly params: Omit<IssueConnectionParams, "via" | "client" | "id">;
  readonly via: IssueConnectionParams["via"];
  /** The OAuth client: exactly when `via` is `oauth`. */
  readonly client?: string;
  /** The OAuth grant the token comes from. */
  readonly grant?: string;
  /** When the token stops authenticating (an OAuth access token); none for a static token. */
  readonly expiresAt?: string;
  /** Tests: called between recording the hash and the registration, with the ID it records. */
  readonly beforeRegistering?: (id: ConnectionId) => void;
}): Promise<{ readonly connection: ConnectionRecord; readonly token: string }> {
  const token = newToken("connection");
  const id = newConnectionId();
  await o.control.putCredential({
    hash: tokenHash(token),
    kind: "connection",
    principal: id,
    tenant: o.tenant,
    ...(o.expiresAt !== undefined ? { expiresAt: o.expiresAt } : {}),
    ...(o.grant !== undefined ? { grant: o.grant } : {}),
  });
  try {
    o.beforeRegistering?.(id);
    const connection = await issueConnection(o.store, o.ctx, {
      ...o.params,
      via: o.via,
      ...(o.client !== undefined ? { client: o.client } : {}),
      id,
    });
    return { connection, token };
  } catch (e) {
    // Not registered: the hash stands for nothing. Dropped now if it can be; left, it
    // authenticates as nothing.
    try {
      await o.control.removeCredentials(o.tenant, new Set([id]), { kind: "connection" });
    } catch {}
    throw e;
  }
}

/** What the control plane's clean-up of a revoked connection needs of the OAuth tables. */
export interface RevokedOAuth {
  /** Deletes the refresh tokens of the connection's grants; how many went. */
  dropRefreshTokens(tenant: TenantId, connection: ConnectionId): Promise<number>;
}

/**
 * `connections.revoke` in the server mode: the revocation in the tenant's log, which refuses the
 * connection from its next request on; then the control plane's clean-up, all in one place.
 */
export async function revokeServerConnection(o: {
  readonly control: ControlPlane;
  /** The OAuth tables: the server mode always has them. */
  readonly oauth: RevokedOAuth;
  readonly tenant: TenantId;
  readonly store: TenantStore;
  readonly ctx: OpsContext;
  readonly id: ConnectionId;
}): Promise<ConnectionRecord> {
  const connection = await revokeConnection(o.store, o.ctx, { id: o.id });
  await cleanUpRevoked(o);
  return connection;
}

/**
 * What the control plane keeps of a revoked connection, and what it drops. Its access tokens'
 * hashes are kept, as in the local mode: they are what lets a refusal say `revoked`. What else
 * the control plane holds of the connection, and should drop, goes here (an OAuth grant's
 * refresh tokens).
 */
async function cleanUpRevoked(o: {
  readonly control: ControlPlane;
  readonly oauth: RevokedOAuth;
  readonly tenant: TenantId;
  readonly id: ConnectionId;
}): Promise<void> {
  await o.oauth.dropRefreshTokens(o.tenant, o.id);
}
