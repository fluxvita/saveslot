// A test bed for the authorization server's HTTP side (the server package does not depend on the
// kernel): real tables, a tenant, the deps over them. Tests only.

import { join } from "node:path";
import {
  createOpsContext,
  createTenant,
  type StorageBackend,
  type TenantStore,
} from "@fluxvita/saveslot-kernel";
import type { TenantId, UserId } from "./control-plane.ts";
import { type IdentityProvider, UserSessionError, writeUserSession } from "./identity.ts";
import type { ClientFetcher } from "./oauth-client.ts";
import type { OAuthDeps } from "./oauth-server.ts";
import { initOAuthTables, type OAuthStore, openOAuthStore } from "./oauth-store.ts";
import { initControlPlane, type ServerControlPlane } from "./server-control-plane.ts";

/** What a test of the authorization server's HTTP side needs: real tables, a tenant, deps. */
export interface OAuthTestBed {
  readonly control: TenantStore;
  readonly tenant: TenantStore;
  readonly oauth: OAuthStore;
  readonly cp: ServerControlPlane;
  readonly deps: OAuthDeps;
  /** The logins a user session may be issued from (`sessionsFrom`), by ID: add and remove freely. */
  readonly logins: Map<string, UserId>;
  close(): Promise<void>;
}

/**
 * A stand-in for the identity provider's `issueUserSession`, over `control`: a session is written
 * only from a login in `live` (its ID to its user), as the provider writes it; from any other,
 * `login_ended`.
 */
export function sessionsFrom(
  control: TenantStore,
  live: ReadonlyMap<string, UserId>,
): Pick<IdentityProvider, "issueUserSession"> {
  return {
    issueUserSession: (user, o) =>
      control.write(async (tx) => {
        if (!("login" in o.from) || live.get(o.from.login) !== user) {
          throw new UserSessionError("login_ended", "the login has ended");
        }
        return writeUserSession(tx, user, {
          expiresAt: o.expiresAt,
          ...(o.grant === undefined ? {} : { grant: o.grant }),
        });
      }),
  };
}

/**
 * A control database with its tables and one active tenant of `user`, its storage with the
 * genesis, and the authorization server's deps over them: a pool that lends that tenant, user
 * sessions issued from `logins` (`sessionsFrom`), and `fetchClient` as given. Under `dir`, on `backend` (the test
 * backend: the caller gives it, as this file is compiled with the package).
 */
export async function oauthTestBed(o: {
  readonly backend: StorageBackend;
  readonly dir: string;
  readonly tenant: TenantId;
  readonly user: UserId;
  readonly now: string;
  readonly external: string;
  readonly fetchClient: ClientFetcher;
}): Promise<OAuthTestBed> {
  const control = await o.backend.open(
    { kind: "pglite", dir: join(o.dir, "control") },
    { create: true },
  );
  const cp = await initControlPlane(control);
  await initOAuthTables(control);
  const oauth = await openOAuthStore(control);
  await control.write((tx) =>
    tx.query(
      "INSERT INTO tenants (id, owner, cell, database, state) VALUES ($1, $2, 'c1', 'd1', 'active')",
      [o.tenant, o.user],
    ),
  );
  const tenant = await o.backend.open(
    { kind: "pglite", dir: join(o.dir, "tenant") },
    { create: true },
  );
  await createTenant(
    tenant,
    createOpsContext({
      tenant: o.tenant,
      actor: o.user,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_window: 600_000,
      idempotency_key_window: 86_400_000,
      now: o.now,
      confirmation: null,
    }),
  );
  const logins = new Map<string, UserId>();
  const deps: OAuthDeps = {
    store: oauth,
    control: cp,
    identity: sessionsFrom(control, logins),
    pool: {
      use: (_id, fn) => fn({ tenant: o.tenant, owner: o.user, store: tenant, anchor: cp.anchors }),
    },
    fetchClient: o.fetchClient,
    external: o.external,
    windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
  };
  return {
    control,
    tenant,
    oauth,
    cp,
    deps,
    logins,
    close: async () => {
      await tenant.close();
      await control.close();
    },
  };
}
