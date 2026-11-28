// The server mode's callers (02-architecture §5 "How a request is resolved"): the token goes to
// authenticateServer with the identity provider and the credential check passed on as they are
// given, and the request's time; a failure comes back as it is; a caller's tenant is borrowed from
// the pool for each use, under the caller's tenant, and returned when the use ends; a tenant that
// does not serve now, or that the pool cannot lend now, is unavailable by its reason. Stand-ins for
// authenticateServer and the pool; fictional IDs.

import { describe, expect, it } from "vitest";
import type { Principal } from "./auth.ts";
import { ContractError } from "./contract-error.ts";
import type { ControlPlane } from "./control-plane.ts";
import type { CheckCredential } from "./server-auth.ts";
import { type AccountStates, type AuthenticateServer, serverCallers } from "./server-callers.ts";
import { type OpenTenant, type TenantPool, TenantPoolError } from "./tenant-pool.ts";

const TENANT = `tn_${"8".repeat(26)}` as const;
const OTHER = `tn_${"7".repeat(26)}` as const;
const principal: Principal = {
  kind: "connection",
  actor: `ci_${"2".repeat(26)}`,
  scopes: ["saveslot.read"],
  visibility: { kind: "all" },
};
const control = {} as ControlPlane;
const identity: AccountStates = { userState: async () => "active" };
const checkCredential: CheckCredential = async () => "ok";

/** A pool that lends a stand-in tenant and counts the uses in progress. */
function pool() {
  const lent: string[] = [];
  let open = 0;
  const p = {
    use: async <T>(tenant: string, fn: (t: OpenTenant) => Promise<T>): Promise<T> => {
      lent.push(tenant);
      open++;
      try {
        return await fn({ tenant, store: { tenant } } as unknown as OpenTenant);
      } finally {
        open--;
      }
    },
  };
  return { p: p as unknown as TenantPool, lent, open: () => open };
}

describe("the server mode's callers", () => {
  it("pass the identity provider, the credential check and the request's time on as they are given", async () => {
    const seen: Parameters<AuthenticateServer>[0][] = [];
    const { p } = pool();
    const callers = serverCallers({
      control,
      pool: p,
      identity,
      checkCredential,
      now: () => "2026-11-21T08:00:00.000Z",
      authenticate: async (o) => {
        seen.push(o);
        return { tenant: TENANT, principal, release: () => {} };
      },
    });
    await callers.resolve("Bearer t");
    expect(seen).toEqual([
      {
        control,
        pool: p,
        authorization: "Bearer t",
        now: "2026-11-21T08:00:00.000Z",
        identity,
        checkCredential,
      },
    ]);
    expect(seen[0]?.identity).toBe(identity);
    expect(seen[0]?.checkCredential).toBe(checkCredential);
  });

  it.each(["missing", "invalid", "revoked", "expired"] as const)(
    "a credential refused as %s comes back as it is, with no tenant lent",
    async (reason) => {
      const { p, lent } = pool();
      const callers = serverCallers({
        control,
        pool: p,
        identity,
        now: () => "2026-11-21T08:00:00.000Z",
        authenticate: async () => ({ code: "unauthenticated", reason }),
      });
      expect(await callers.resolve("Bearer t")).toEqual({ code: "unauthenticated", reason });
      expect(lent).toEqual([]);
    },
  );

  it("a caller's tenant is borrowed for each use, under its tenant, and returned when the use ends", async () => {
    const { p, lent, open } = pool();
    const callers = serverCallers({
      control,
      pool: p,
      identity,
      now: () => "2026-11-21T08:00:00.000Z",
      authenticate: async () => ({ tenant: TENANT, principal, release: () => {} }),
    });
    const caller = await callers.resolve("Bearer t");
    if (!("principal" in caller)) throw new Error(caller.reason);
    expect(caller).toMatchObject({ principal, tenant: TENANT });
    expect(lent).toEqual([]);
    const seen = await caller.use(async (t) => {
      expect(open()).toBe(1);
      return { tenant: t.tenant, store: t.store };
    });
    expect(seen).toEqual({ tenant: TENANT, store: { tenant: TENANT } });
    expect(open()).toBe(0);
    await caller.use(async () => undefined);
    expect(lent).toEqual([TENANT, TENANT]);
    expect(lent).not.toContain(OTHER);
  });

  /** What `run` rejects with, as the surfaces see it: a contract error's code and reason, or the error itself. */
  const outcome = async (run: Promise<unknown>) => {
    try {
      await run;
      return "resolved";
    } catch (e) {
      if (e instanceof ContractError) return { code: e.code, reason: e.detail.reason };
      return e;
    }
  };

  // 04-contract §16, §17: an import or a restore holding the tenant, by this process's gate or by
  // the anchor's marker, and a staging database not discarded with the marker there, are
  // `unavailable`; the pool's `busy` follows its holder: an import's is `rate_limited` (`busy`), a
  // restore's `unavailable` (`restoring`), as anything during a restore.
  it.each([
    ["import_in_progress", undefined, "unavailable", "importing"],
    ["importing", undefined, "unavailable", "importing"],
    ["staging_not_discarded", undefined, "unavailable", "importing"],
    ["restore_in_progress", undefined, "unavailable", "restoring"],
    ["restoring", undefined, "unavailable", "restoring"],
    ["busy", "importing", "rate_limited", "busy"],
    ["busy", "restoring", "unavailable", "restoring"],
  ] as const)(
    "a tenant the pool refuses for %s (holder %s) is %s (%s) at authentication",
    async (code, holder, contract, reason) => {
      const { p } = pool();
      const callers = serverCallers({
        control,
        pool: p,
        identity,
        now: () => "2026-11-21T08:00:00.000Z",
        authenticate: async () => {
          throw new TenantPoolError(code, "does not serve", holder === undefined ? {} : { holder });
        },
      });
      expect(await outcome(callers.resolve("Bearer t"))).toEqual({ code: contract, reason });
    },
  );

  it.each([
    ["close_failed", "busy", 1],
    ["pool_closed", "stopping", 5],
  ] as const)(
    "a tenant the pool cannot lend now (%s) is unavailable (%s), to be tried again in %i s, at authentication and at the use",
    async (code, reason, retryAfter) => {
      const detail = async (run: Promise<unknown>) => {
        try {
          await run;
          return "resolved";
        } catch (e) {
          if (e instanceof ContractError) return { code: e.code, ...e.detail };
          return e;
        }
      };
      const refused = async () => {
        throw new TenantPoolError(code, "cannot lend");
      };
      const atAuth = serverCallers({
        control,
        pool: pool().p,
        identity,
        now: () => "2026-11-21T08:00:00.000Z",
        authenticate: refused,
      });
      expect(await detail(atAuth.resolve("Bearer t"))).toEqual({
        code: "unavailable",
        reason,
        retry_after: retryAfter,
      });
      const atUse = serverCallers({
        control,
        pool: { use: refused } as unknown as TenantPool,
        identity,
        now: () => "2026-11-21T08:00:00.000Z",
        authenticate: async () => ({ tenant: TENANT, principal, release: () => {} }),
      });
      const caller = await atUse.resolve("Bearer t");
      if (!("principal" in caller)) throw new Error(caller.reason);
      expect(await detail(caller.use(async () => "ran"))).toEqual({
        code: "unavailable",
        reason,
        retry_after: retryAfter,
      });
    },
  );

  it.each(["tenant_creating", "tenant_empty", "unknown_tenant", "log_behind_high_water"] as const)(
    "a tenant refused for %s goes on as it is, for the surface to answer internal",
    async (code) => {
      const { p } = pool();
      const refused = new TenantPoolError(code, "broken");
      const callers = serverCallers({
        control,
        pool: p,
        identity,
        now: () => "2026-11-21T08:00:00.000Z",
        authenticate: async () => {
          throw refused;
        },
      });
      expect(await outcome(callers.resolve("Bearer t"))).toBe(refused);
    },
  );

  it("a tenant that stops serving between authentication and use is unavailable at the use", async () => {
    const p = {
      use: async () => {
        throw new TenantPoolError("import_in_progress", "an import began");
      },
    } as unknown as TenantPool;
    const callers = serverCallers({
      control,
      pool: p,
      identity,
      now: () => "2026-11-21T08:00:00.000Z",
      authenticate: async () => ({ tenant: TENANT, principal, release: () => {} }),
    });
    const caller = await callers.resolve("Bearer t");
    if (!("principal" in caller)) throw new Error(caller.reason);
    expect(await outcome(caller.use(async () => "ran"))).toEqual({
      code: "unavailable",
      reason: "importing",
    });
  });
});
