// What every management operation starts with (04-contract §17): the storage is the context's
// tenant, and the caller is an active user session. Not exported from the package.

import type { UserId } from "@fluxvita/saveslot-contract-core";
import type { ReadTx } from "../store/ports.ts";
import type { OpsContext } from "./context.ts";
import { OpsError } from "./errors.ts";

/** The checks every management operation starts with; returns the acting user. */
export async function begin(tx: ReadTx, ctx: OpsContext): Promise<UserId> {
  const t = await tx.query<{ value: string }>("SELECT value FROM meta WHERE key = 'tenant_id'");
  if (t.rows[0]?.value !== ctx.tenant) {
    throw new OpsError("internal", "the context's tenant is not the tenant of this storage");
  }
  // Only user sessions (04-contract §17). The service layer checks this first; this is defence.
  const r = await tx.query<{ kind: string; state: string; id: string }>(
    "SELECT id, kind, state FROM principals WHERE id = $1",
    [ctx.actor],
  );
  const actor = r.rows[0];
  if (actor?.kind !== "user" || actor.state !== "active") {
    throw new OpsError("insufficient_scope", "management operations are for user sessions", {
      required_scope: "user_session",
    });
  }
  return actor.id as UserId;
}
