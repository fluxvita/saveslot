// authenticateServer on either backend (02-architecture §5; 04-contract §12, §16): the token's hash
// found in the control plane, an expired credential refused before any tenant opens, the principal
// read from the tenant's log — a connection revoked there refused though its hash is still in the
// control plane. Fictional IDs.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpsContext,
  issueConnection,
  newConnectionId,
  revokeConnection,
  type StorageBackend,
  type TenantRef,
  type TenantStore,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "../../test-backend/src/index.fixture.ts";
import { SCOPES } from "./auth.ts";
import type { TenantEntry } from "./control-plane.ts";
import { authenticateServer } from "./server-auth.ts";
import { initControlPlane, type ServerControlPlane } from "./server-control-plane.ts";
import { createServerTenant } from "./server-tenant.ts";
import { TenantPool } from "./tenant-pool.ts";
import { newToken, tokenHash } from "./tokens.ts";

const T = 120_000;
const NOW = "2026-11-20T10:00:00.000Z";
const CELL = "cell_a";
const root = mkdtempSync(join(tmpdir(), "saveslot-server-auth-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), T);

let opens = 0;
const backend: StorageBackend = {
  open: (ref: TenantRef, opts) => {
    if (ref.kind !== "postgres") throw new Error("a server tenant's storage is a database");
    opens++;
    return testBackend().open({ kind: "pglite", dir: join(root, ref.cell, ref.database) }, opts);
  },
};

let control: TenantStore;
let cp: ServerControlPlane;
let pool: TenantPool;
let tenant: TenantEntry;
beforeAll(async () => {
  control = await testBackend().open(
    { kind: "pglite", dir: join(root, "control") },
    { create: true },
  );
  cp = await initControlPlane(control);
  pool = new TenantPool({ control: cp, backend, idleMs: 60_000, now: () => NOW });
  tenant = await createServerTenant({
    control: cp,
    backend,
    owner: `u_${"1".repeat(26)}`,
    cell: CELL,
    cells: new Set([CELL]),
    now: NOW,
  });
}, T);
afterAll(async () => {
  await pool?.closeAll();
  await control?.close();
}, T);

const ctx = () =>
  createOpsContext({
    tenant: tenant.id,
    actor: tenant.owner,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: NOW,
    confirmation: null,
  });

const auth = (authorization: string | undefined, now = NOW) =>
  authenticateServer({ control: cp, pool, authorization, now });

/** A connection registered in the tenant's log, its token's hash in the control plane. */
async function connection(
  scopes = ["saveslot.read"] as const,
): Promise<{ id: `ci_${string}`; token: string }> {
  const token = newToken("connection");
  const id = newConnectionId();
  await cp.putCredential({
    hash: tokenHash(token),
    kind: "connection",
    principal: id,
    tenant: tenant.id,
  });
  await pool.use(tenant.id, (t) =>
    issueConnection(t.store, ctx(), { name: `c-${id.slice(-6)}`, scopes, via: "token", id }),
  );
  return { id, token };
}

describe("authenticateServer", () => {
  it(
    "refuses a missing header as missing, and a malformed one or an unknown token as invalid",
    async () => {
      expect(await auth(undefined)).toEqual({ code: "unauthenticated", reason: "missing" });
      expect(await auth("Basic x")).toEqual({ code: "unauthenticated", reason: "invalid" });
      expect(await auth(`Bearer ${newToken("connection")}`)).toEqual({
        code: "unauthenticated",
        reason: "invalid",
      });
    },
    T,
  );

  it(
    "gives a user session's caller: the tenant, the user with every scope and every slot",
    async () => {
      const token = newToken("session");
      await cp.putCredential({
        hash: tokenHash(token),
        kind: "session",
        principal: tenant.owner,
        tenant: tenant.id,
        expiresAt: "2026-11-21T10:00:00.000Z",
      });
      expect(await auth(`Bearer ${token}`)).toEqual({
        tenant: tenant.id,
        principal: {
          kind: "user",
          actor: tenant.owner,
          scopes: SCOPES,
          visibility: { kind: "all" },
        },
      });
    },
    T,
  );

  it(
    "gives a connection's caller with the scopes the tenant's log registered",
    async () => {
      const c = await connection();
      expect(await auth(`Bearer ${c.token}`)).toEqual({
        tenant: tenant.id,
        principal: {
          kind: "connection",
          actor: c.id,
          scopes: ["saveslot.read"],
          visibility: { kind: "all" },
        },
      });
    },
    T,
  );

  it(
    "refuses a connection revoked in the log as revoked, its hash still in the control plane",
    async () => {
      const c = await connection();
      await pool.use(tenant.id, (t) => revokeConnection(t.store, ctx(), { id: c.id }));
      expect((await cp.credential(tokenHash(c.token)))?.principal).toBe(c.id);
      expect(await auth(`Bearer ${c.token}`)).toEqual({
        code: "unauthenticated",
        reason: "revoked",
      });
    },
    T,
  );

  it(
    "refuses an expired credential as expired, without opening the tenant",
    async () => {
      const token = newToken("session");
      await cp.putCredential({
        hash: tokenHash(token),
        kind: "session",
        principal: tenant.owner,
        tenant: tenant.id,
        expiresAt: NOW,
      });
      const refusing = new TenantPool({
        control: cp,
        backend: { open: () => Promise.reject(new Error("no tenant may be opened")) },
        idleMs: 60_000,
      });
      const before = opens;
      expect(
        await authenticateServer({
          control: cp,
          pool: refusing,
          authorization: `Bearer ${token}`,
          now: NOW,
        }),
      ).toEqual({ code: "unauthenticated", reason: "expired" });
      expect(opens).toBe(before);
    },
    T,
  );

  it(
    "refuses a credential the further check finds invalid, as invalid, without opening the tenant",
    async () => {
      const token = newToken("session");
      await cp.putCredential({
        hash: tokenHash(token),
        kind: "session",
        principal: tenant.owner,
        tenant: tenant.id,
        expiresAt: "2026-11-21T10:00:00.000Z",
      });
      const uses: string[] = [];
      const recording = {
        use: async (t: string) => {
          uses.push(t);
          throw new Error("the tenant must not be opened");
        },
      } as unknown as TenantPool;
      const seen: string[] = [];
      expect(
        await authenticateServer({
          control: cp,
          pool: recording,
          authorization: `Bearer ${token}`,
          now: NOW,
          checkCredential: async (c) => {
            seen.push(c.hash);
            return "invalid";
          },
        }),
      ).toEqual({ code: "unauthenticated", reason: "invalid" });
      expect(seen).toEqual([tokenHash(token)]);
      expect(uses).toEqual([]);
      // Passing the check, the same credential authenticates.
      expect(
        await authenticateServer({
          control: cp,
          pool,
          authorization: `Bearer ${token}`,
          now: NOW,
          checkCredential: async () => "ok",
        }),
      ).toMatchObject({ tenant: tenant.id, principal: { kind: "user" } });
    },
    T,
  );

  it(
    "refuses a token whose hash is recorded as the other kind, its principal active in the log",
    async () => {
      const { id } = await connection();
      const token = newToken("session");
      await cp.putCredential({
        hash: tokenHash(token),
        kind: "connection",
        principal: id,
        tenant: tenant.id,
      });
      expect(await auth(`Bearer ${token}`)).toEqual({ code: "unauthenticated", reason: "invalid" });
    },
    T,
  );

  it(
    "takes the request's time only as toISOString writes it",
    async () => {
      const { token } = await connection();
      // Three hours after an expiry of 13:00Z, written with an offset: as a string, before it.
      for (const now of ["2026-11-20T05:00:00-08:00", "2026-11-20T13:00:00Z", "yesterday"]) {
        await expect(auth(`Bearer ${token}`, now), now).rejects.toThrow(
          "the request's time is an instant as toISOString writes it",
        );
      }
    },
    T,
  );
});
