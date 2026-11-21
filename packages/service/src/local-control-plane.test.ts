// The local control plane over its files: the tenant directory's one tenant, the credentials the
// service loaded, and the anchor store (the kernel's conformance cases). Fictional IDs.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageBackend } from "@fluxvita/saveslot-kernel";
import { anchorStoreConformance } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, describe, expect, it } from "vitest";
import { Credentials } from "./credentials.ts";
import { LocalControlPlane, tenantFile } from "./local-control-plane.ts";
import { openLocalTenant } from "./local-tenant.ts";
import { newToken, tokenHash } from "./tokens.ts";

const root = mkdtempSync(join(tmpdir(), "saveslot-control-plane-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const TENANT = `tn_${"8".repeat(26)}` as const;
const USER = `u_${"1".repeat(26)}` as const;
const CI = `ci_${"5".repeat(26)}` as const;
let n = 0;
/** An initialized home: `control/` at 0700 with the tenant directory and credentials. */
function home(): { home: string; credentials: Credentials; session: string } {
  const h = join(root, String(n++));
  mkdirSync(join(h, "control"), { recursive: true, mode: 0o700 });
  writeFileSync(tenantFile(h), JSON.stringify({ format: 1, user: USER, tenant: TENANT }));
  const session = tokenHash(newToken("session"));
  return { home: h, credentials: Credentials.create(h, session), session };
}

describe("the tenant directory", () => {
  it("gives the one tenant by its ID and by its owner, its storage the data directory", async () => {
    const h = home();
    const cp = new LocalControlPlane(h.home);
    const entry = {
      id: TENANT,
      owner: USER,
      ref: { kind: "pglite", dir: join(h.home, "data") },
      state: "active",
    };
    expect(await cp.tenant(TENANT)).toEqual(entry);
    expect(await cp.tenantOf(USER)).toEqual(entry);
    expect(await cp.tenant(`tn_${"9".repeat(26)}` as const)).toBeUndefined();
    expect(await cp.tenantOf(`u_${"2".repeat(26)}` as const)).toBeUndefined();
  });
});

describe("credentials", () => {
  it("are found by hash: the session the user's, a connection its principal's, of the one tenant", async () => {
    const h = home();
    const cp = new LocalControlPlane(h.home, h.credentials);
    const connection = tokenHash(newToken("connection"));
    h.credentials.addConnection(connection, CI);
    expect(await cp.credential(h.session)).toEqual({
      hash: h.session,
      kind: "session",
      principal: USER,
      tenant: TENANT,
    });
    expect(await cp.credential(connection)).toEqual({
      hash: connection,
      kind: "connection",
      principal: CI,
      tenant: TENANT,
    });
    expect(await cp.credential(tokenHash(newToken("connection")))).toBeUndefined();
    // Only a hash as it is computed: not upper case, not with anything after it.
    expect(await cp.credential(h.session.toUpperCase())).toBeUndefined();
    expect(await cp.credential(`${h.session}zz`)).toBeUndefined();
  });

  it("are written to the file: a connection added, the session replaced, a principal's removed", async () => {
    const h = home();
    const cp = new LocalControlPlane(h.home, h.credentials);
    const connection = tokenHash(newToken("connection"));
    const session = tokenHash(newToken("session"));
    await cp.putCredential({ hash: connection, kind: "connection", principal: CI, tenant: TENANT });
    await cp.putCredential({ hash: session, kind: "session", principal: USER, tenant: TENANT });
    const reread = await Credentials.load(h.home);
    expect(reread.connection(connection)).toBe(CI);
    expect(reread.sessionHash).toBe(session);
    expect(await cp.removeCredentials(TENANT, new Set([CI]))).toBe(1);
    await expect(cp.removeCredentials(`tn_${"9".repeat(26)}`, new Set([CI]))).rejects.toThrow(
      "not the local tenant",
    );
    expect((await Credentials.load(h.home)).connection(connection)).toBeUndefined();
  });

  it("refuses what the local mode does not have: another tenant, another user, an expiry, a grant", async () => {
    const h = home();
    const cp = new LocalControlPlane(h.home, h.credentials);
    const hash = tokenHash(newToken("connection"));
    const other = `tn_${"9".repeat(26)}` as const;
    await expect(
      cp.putCredential({ hash, kind: "connection", principal: CI, tenant: other }),
    ).rejects.toThrow("not the local tenant");
    await expect(
      cp.putCredential({
        hash,
        kind: "session",
        principal: `u_${"2".repeat(26)}` as const,
        tenant: TENANT,
      }),
    ).rejects.toThrow("not the local user");
    await expect(
      cp.putCredential({
        hash,
        kind: "connection",
        principal: CI,
        tenant: TENANT,
        expiresAt: "2026-12-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("local credentials do not expire");
    await expect(
      cp.putCredential({ hash, kind: "connection", principal: CI, tenant: TENANT, grant: "g_1" }),
    ).rejects.toThrow("local credentials come from no grant");
  });

  it("are not read before they are loaded", async () => {
    const h = home();
    await expect(new LocalControlPlane(h.home).credential(h.session)).rejects.toThrow(
      "the local credentials are not loaded",
    );
  });
});

anchorStoreConformance("local control plane", () => {
  const h = home();
  return {
    store: new LocalControlPlane(h.home).anchors,
    reopen: () => new LocalControlPlane(h.home).anchors,
  };
});

describe("opening the local tenant through it", () => {
  it("gives not_initialized for a home with no control directory, before any storage is opened", async () => {
    const h = join(root, String(n++));
    mkdirSync(h, { recursive: true });
    const backend = {
      open: () => Promise.reject(new Error("the storage must not be opened")),
    } as unknown as StorageBackend;
    expect(await openLocalTenant({ home: h, backend })).toEqual({
      ok: false,
      failure: "not_initialized",
    });
  });
});
