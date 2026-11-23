// Connection tokens of the server mode (04-contract §12, §16; 02-architecture §5): issued, the
// token's hash is in the control plane under the tenant and the connection registered in its log,
// with the grant and expiry given; interrupted between the two, the hash is there and the
// connection is not (it authenticates as nothing); a registration that fails drops the hash;
// revoked, the log says so and the hash stays, so the token is refused as revoked, and its refresh
// tokens are dropped. A real control
// plane and a real tenant store; fictional IDs.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpsContext,
  createTenant,
  type OpsContext,
  type TenantStore,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "../../test-backend/src/index.fixture.ts";
import type { ControlPlane } from "./control-plane.ts";
import { issueServerConnection, revokeServerConnection } from "./server-connections.ts";
import { initControlPlane } from "./server-control-plane.ts";
import { tokenHash } from "./tokens.ts";

const T = 60_000;
const TENANT = `tn_${"8".repeat(26)}` as const;
const USER = `u_${"1".repeat(26)}` as const;
const NOW = "2026-11-20T08:00:00.000Z";
const root = mkdtempSync(join(tmpdir(), "saveslot-server-connections-"));
let controlDb: TenantStore;
let store: TenantStore;
let control: ControlPlane;

const ctx = (): OpsContext =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_key_window: 86_400_000,
    idempotency_window: 600_000,
    now: NOW,
    confirmation: null,
  });

/** The connection's state in the tenant's log, or undefined when it is not registered. */
async function registered(id: string): Promise<string | undefined> {
  const r = await store.read((tx) =>
    tx.query<{ state: string }>("SELECT state FROM principals WHERE id = $1", [id]),
  );
  return r.rows[0]?.state;
}

/**
 * The control plane, with the hash of each credential recorded through it seen, and `changes`
 * in place of its methods. Each method is the instance's own, bound to it.
 */
function watched(changes: Partial<ControlPlane> = {}): { cp: ControlPlane; hashes: string[] } {
  const hashes: string[] = [];
  const cp: ControlPlane = {
    anchors: control.anchors,
    tenant: (id) => control.tenant(id),
    tenantOf: (owner) => control.tenantOf(owner),
    credential: (hash) => control.credential(hash),
    putCredential: async (e) => {
      hashes.push(e.hash);
      await control.putCredential(e);
    },
    removeCredentials: (tenant, principals, opts) =>
      control.removeCredentials(tenant, principals, opts),
    ...changes,
  };
  return { cp, hashes };
}

beforeAll(async () => {
  controlDb = await testBackend().open(
    { kind: "pglite", dir: join(root, "control") },
    { create: true },
  );
  control = await initControlPlane(controlDb);
  // The tenant as the control plane's directory has it (its creation is not tested here).
  await controlDb.write((tx) =>
    tx.query(
      "INSERT INTO tenants (id, owner, cell, database, state) VALUES ($1, $2, 'a', 'db1', 'active')",
      [TENANT, USER],
    ),
  );
  store = await testBackend().open({ kind: "pglite", dir: join(root, "tenant") }, { create: true });
  await createTenant(store, ctx());
}, T);

afterAll(async () => {
  await store?.close();
  await controlDb?.close();
  rmSync(root, { recursive: true, force: true });
}, T);

describe("issuing a connection in the server mode", () => {
  it("records the token's hash under the tenant, with its grant and expiry, and registers the connection", async () => {
    const { connection, token } = await issueServerConnection({
      control,
      tenant: TENANT,
      store,
      ctx: ctx(),
      params: { name: "notes app", scopes: ["saveslot.read"] },
      via: "oauth",
      client: "https://notes.example/client.json",
      grant: "gr_1",
      expiresAt: "2026-11-20T09:00:00.000Z",
    });
    expect(connection).toMatchObject({
      name: "notes app",
      scopes: ["saveslot.read"],
      via: "oauth",
      client: "https://notes.example/client.json",
    });
    expect(await control.credential(tokenHash(token))).toEqual({
      hash: tokenHash(token),
      kind: "connection",
      principal: connection.id,
      tenant: TENANT,
      grant: "gr_1",
      expiresAt: "2026-11-20T09:00:00.000Z",
    });
    expect(await registered(connection.id)).toBe("active");
  });

  it("interrupted after the hash, before the registration: the hash is there, the connection is not", async () => {
    // A process that stops there never cleans up: a control plane whose removal does nothing.
    const { cp: stopped, hashes } = watched({ removeCredentials: async () => 0 });
    let id: string | undefined;
    const stop = new Error("the process stops here");
    await expect(
      issueServerConnection({
        control: stopped,
        tenant: TENANT,
        store,
        ctx: ctx(),
        params: { name: "cut short" },
        via: "token",
        beforeRegistering: (x) => {
          id = x;
          throw stop;
        },
      }),
    ).rejects.toBe(stop);
    expect(hashes).toHaveLength(1);
    expect(await control.credential(hashes[0] as string)).toMatchObject({
      principal: id,
      tenant: TENANT,
    });
    expect(await registered(id as string)).toBeUndefined();
  });

  it("a registration that fails drops the hash again", async () => {
    const { cp: watching, hashes } = watched();
    // The name is taken: the kernel refuses the registration.
    await expect(
      issueServerConnection({
        control: watching,
        tenant: TENANT,
        store,
        ctx: ctx(),
        params: { name: "notes app" },
        via: "token",
      }),
    ).rejects.toMatchObject({ code: "invalid_argument", detail: { reason: "duplicate_name" } });
    expect(hashes).toHaveLength(1);
    expect(await control.credential(hashes[0] as string)).toBeUndefined();
  });
});

describe("revoking a connection in the server mode", () => {
  it("registers the revocation and keeps the hash, so the token is refused as revoked", async () => {
    const { connection, token } = await issueServerConnection({
      control,
      tenant: TENANT,
      store,
      ctx: ctx(),
      params: { name: "to revoke" },
      via: "token",
    });
    const dropped: string[] = [];
    const oauth = {
      dropRefreshTokens: async (tenant: string, id: string) => {
        dropped.push(`${tenant} ${id}`);
        return 0;
      },
    };
    const revoked = await revokeServerConnection({
      control,
      oauth,
      tenant: TENANT,
      store,
      ctx: ctx(),
      id: connection.id,
    });
    expect(revoked).toMatchObject({ id: connection.id, state: "revoked" });
    expect(await registered(connection.id)).toBe("revoked");
    // The clean-up asked the OAuth tables to drop the connection's refresh tokens.
    expect(dropped).toEqual([`${TENANT} ${connection.id}`]);
    expect(await control.credential(tokenHash(token))).toMatchObject({
      principal: connection.id,
      tenant: TENANT,
    });
    // Again: the same answer, nothing more recorded.
    expect(
      await revokeServerConnection({
        control,
        oauth,
        tenant: TENANT,
        store,
        ctx: ctx(),
        id: connection.id,
      }),
    ).toEqual(revoked);
  });
});
