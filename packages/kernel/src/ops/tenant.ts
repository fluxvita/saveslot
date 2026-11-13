// The tenant-creation entry (docs/zh-CN/spec/02-architecture.md §4 "契约操作与内部操作";
// docs/zh-CN/spec/09-event-format.md §5.2 `tenant.genesis`).
//
// Neither a contract operation nor an internal operation: `saveslot init` or provisioning calls
// it on a new, empty storage. The actor is the user it registers, the trigger is null, and it
// does not check that the actor is registered (nothing is yet). It appends only the genesis event,
// which has no `ctx`.

import { isId, type NodeId, type Seq, type UserId } from "@fluxvita/saveslot-contract-core";
import { applyEvents, eventsOf } from "../apply/index.ts";
import { appendOperation, readTail } from "../log/index.ts";
import { STORAGE_FORMAT_VERSION } from "../store/format-v1.ts";
import type { TenantStore } from "../store/ports.ts";
import type { OpsContext } from "./context.ts";
import { OpsError } from "./errors.ts";
import { newNodeId } from "./ids.ts";

export interface CreateTenantResult {
  readonly seq: Seq;
  readonly node_id: NodeId;
}

/** Appends and applies the genesis event of `ctx.tenant`, registering `ctx.actor` as its user. */
export async function createTenant(
  store: TenantStore,
  ctx: OpsContext,
): Promise<CreateTenantResult> {
  if (!isId("user", ctx.actor) || ctx.trigger !== null) {
    throw new OpsError("internal", "createTenant: the actor must be a user and trigger null");
  }
  const user = ctx.actor as UserId;
  const node_id = newNodeId();
  return store.write(async (tx) => {
    if ((await readTail(tx)) !== undefined) {
      throw new OpsError("internal", "createTenant: the log is not empty");
    }
    const op = await appendOperation(tx, {
      actor: user,
      now: ctx.now,
      events: [
        {
          type: "tenant.genesis",
          node_id,
          blocks: {
            tenant: {
              tenant_id: ctx.tenant,
              storage_format: STORAGE_FORMAT_VERSION,
              event_format: 1,
            },
            user: { principal: user, kind: "user" },
            system: { principal: "system", kind: "system" },
          },
        },
      ],
    });
    await applyEvents(tx, eventsOf(op));
    return { seq: op.op, node_id };
  });
}
