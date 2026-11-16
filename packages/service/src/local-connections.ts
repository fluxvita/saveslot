// Connection instance tokens of the local mode (docs/zh-CN/spec/04-contract.md §12; 06-cli.md §3.2,
// §8.2): issuing makes a token, records its hash, then registers the connection; revoking
// registers the revocation and keeps the hash, so the token is refused as `revoked` (§16), not as
// unknown. The token is returned once and kept nowhere.
//
// The hash is recorded before the registration commits, under the ID the registration then takes:
// interrupted between the two, the credentials hold a hash of a principal that does not exist,
// which authenticates as nothing (`invalid`) and is dropped at the next start (`pruneCredentials`);
// no connection is left in the log that no one holds a token of.
// Kept: the hashes of revoked and disabled connections (one 64-character hash each).

import {
  type ConnectionRecord,
  type IssueConnectionParams,
  issueConnection,
  newConnectionId,
  type OpsContext,
  revokeConnection,
} from "@fluxvita/saveslot-kernel";
import type { Credentials } from "./credentials.ts";
import type { LocalTenant } from "./local-tenant.ts";
import { newToken, tokenHash } from "./tokens.ts";

/** `connections.issue` with a local token: the connection and its token, shown this once. */
export async function issueLocalConnection(o: {
  readonly tenant: LocalTenant;
  readonly credentials: Credentials;
  readonly ctx: OpsContext;
  readonly params: Omit<IssueConnectionParams, "via" | "client" | "id">;
  /** Tests: called between recording the hash and the registration, with the ID it records. */
  readonly beforeRegistering?: (id: string) => void;
}): Promise<{ readonly connection: ConnectionRecord; readonly token: string }> {
  const token = newToken("connection");
  const id = newConnectionId();
  o.credentials.addConnection(tokenHash(token), id);
  try {
    o.beforeRegistering?.(id);
    const connection = await issueConnection(o.tenant.store, o.ctx, {
      ...o.params,
      via: "token",
      id,
    });
    return { connection, token };
  } catch (e) {
    // Not registered: the hash stands for nothing. Dropped now, or else at the next start.
    try {
      o.credentials.removePrincipals(new Set([id]));
    } catch {}
    throw e;
  }
}

/**
 * `connections.revoke`. The token's hash stays: the revocation in the log refuses it, and keeping
 * the hash is what lets the refusal say `revoked`.
 */
export async function revokeLocalConnection(o: {
  readonly tenant: LocalTenant;
  readonly ctx: OpsContext;
  readonly id: `ci_${string}`;
}): Promise<ConnectionRecord> {
  return revokeConnection(o.tenant.store, o.ctx, { id: o.id });
}

/**
 * At start: drops the hashes of principals that do not exist (an issue interrupted before it
 * committed); how many went. Revoked and disabled connections keep theirs.
 */
export async function pruneCredentials(t: LocalTenant, credentials: Credentials): Promise<number> {
  const ids = credentials.principals();
  if (ids.length === 0) return 0;
  const r = await t.store.read((tx) =>
    tx.query<{ id: string }>(
      "SELECT id FROM principals WHERE kind = 'connection' AND id = ANY($1)",
      [ids] as never,
    ),
  );
  const registered = new Set(r.rows.map((x) => x.id));
  return credentials.removePrincipals(new Set(ids.filter((id) => !registered.has(id))));
}
