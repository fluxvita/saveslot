// Who a request comes from (docs/zh-CN/spec/02-architecture.md §5 «身份», «权限»; 04-contract.md §12,
// §16 `unauthenticated`): the `Authorization` header's token → its hash → the principal, then the
// principal's state, scopes and slot range read from the tenant (`principals`) on every request, so
// a revocation holds from the next request on, without a restart.
//
// Failures say only which of `missing`, `invalid`, `revoked` (`expired` is for sessions that
// expire, which local ones do not). A malformed header is `invalid` with no hash computed; a
// connection token's hash not found is compared once against a fixed hash too, so "not found" and
// "found, other hash" do not differ in the work done.

import type { TenantStore, Visibility } from "@fluxvita/saveslot-kernel";
import type { Credentials } from "./credentials.ts";
import type { LocalTenant } from "./local-tenant.ts";
import { bearerToken, sameHash, tokenHash } from "./tokens.ts";

/** The four scopes (04-contract §12); a user session has them all. */
export const SCOPES = [
  "saveslot.read",
  "saveslot.write",
  "saveslot.schema",
  "saveslot.delete",
] as const;
export type Scope = (typeof SCOPES)[number];
type SlotId = `sl_${string}`;

/** The principal a request acts as, with what it may do and see. */
export type Principal =
  | {
      readonly kind: "user";
      readonly actor: `u_${string}`;
      readonly scopes: readonly Scope[];
      readonly visibility: Visibility;
    }
  | {
      readonly kind: "connection";
      readonly actor: `ci_${string}`;
      readonly scopes: readonly Scope[];
      readonly visibility: Visibility;
    };

export interface AuthFailure {
  readonly code: "unauthenticated";
  /**
   * 04-contract §16: `expired` for a credential past its expiry (the server mode's sessions);
   * `account_disabled` for any credential of a tenant whose owner's account is disabled (server mode).
   */
  readonly reason: "missing" | "invalid" | "revoked" | "expired" | "account_disabled";
}

/** A hash no token has: what a connection hash not found is compared with. */
const NO_HASH = "0".repeat(64);

/** A principal's row in the tenant's `principals`: what authorizing it reads. */
export interface PrincipalRow {
  readonly kind: string;
  readonly state: string;
  readonly scopes: string | null;
  readonly slots: string | null;
}

/** The principal's row in the tenant's log, if it has one. */
export async function principalRow(
  store: TenantStore,
  id: string,
): Promise<PrincipalRow | undefined> {
  const r = await store.read((tx) =>
    tx.query<PrincipalRow>("SELECT kind, state, scopes, slots FROM principals WHERE id = $1", [id]),
  );
  return r.rows[0];
}

/**
 * The principal a credential of `kind` stands for, from its row in `principals`; why not, when it
 * does not authenticate. A user session has every scope and every slot; a connection instance its
 * scopes and slot range as registered. No row: a hash recorded by an issue that never committed.
 */
export function principalFromRow(
  kind: "session" | "connection",
  id: string,
  row: PrincipalRow | undefined,
): Principal | AuthFailure {
  if (kind === "session") {
    // The user is disabled once the tenant is imported into: it no longer authenticates.
    if (row?.kind !== "user" || row.state !== "active") {
      return { code: "unauthenticated", reason: "invalid" };
    }
    return {
      kind: "user",
      actor: id as `u_${string}`,
      scopes: SCOPES,
      visibility: { kind: "all" },
    };
  }
  if (row?.kind !== "connection") return { code: "unauthenticated", reason: "invalid" };
  if (row.state === "revoked") return { code: "unauthenticated", reason: "revoked" };
  if (row.state !== "active") return { code: "unauthenticated", reason: "invalid" };
  const scopes = JSON.parse(row.scopes ?? "[]") as Scope[];
  const slots = row.slots === null ? undefined : (JSON.parse(row.slots) as SlotId[]);
  return {
    kind: "connection",
    actor: id as `ci_${string}`,
    scopes,
    visibility:
      slots === undefined
        ? { kind: "all" }
        : { kind: "scoped", slots: slots.map((slot) => ({ slot })) },
  };
}

/** Authenticates a request by its `Authorization` header. */
export async function authenticate(o: {
  readonly credentials: Credentials;
  readonly tenant: LocalTenant;
  readonly authorization: string | undefined;
}): Promise<Principal | AuthFailure> {
  if (o.authorization === undefined || o.authorization === "") {
    return { code: "unauthenticated", reason: "missing" };
  }
  const bearer = bearerToken(o.authorization);
  if (bearer === undefined) return { code: "unauthenticated", reason: "invalid" };
  const hash = tokenHash(bearer.token);

  if (bearer.kind === "session") {
    if (!sameHash(hash, o.credentials.sessionHash)) {
      return { code: "unauthenticated", reason: "invalid" };
    }
    return principalFromRow(
      "session",
      o.tenant.user,
      await principalRow(o.tenant.store, o.tenant.user),
    );
  }

  const principal = o.credentials.connection(hash);
  if (principal === undefined) {
    // Not found is refused after the same comparison a found hash gets: the two paths do the same
    // work, so how long a refusal takes does not tell them apart.
    sameHash(hash, NO_HASH);
    return { code: "unauthenticated", reason: "invalid" };
  }
  // The found hash compared too, as the path above (its result is known: the lookup was by it).
  sameHash(hash, hash);
  return principalFromRow("connection", principal, await principalRow(o.tenant.store, principal));
}
