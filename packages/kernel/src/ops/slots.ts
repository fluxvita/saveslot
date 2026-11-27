// `slots.remove` (04-contract §17): removing an empty slot, for a user session. Only a slot with
// no data can be removed (process/decisions/remove-empty-slot.md §3); a slot with records is
// deleted by deletion, a later version.

import { isId, type SlotId } from "@fluxvita/saveslot-contract-core";
import { applyEvents, eventsOf } from "../apply/index.ts";
import { appendOperation, noteEffect, restoresOf } from "../log/index.ts";
import { RULESET_VERSION } from "../rules/version.ts";
import type { ReadTx, TenantStore } from "../store/ports.ts";
import type { OpsContext } from "./context.ts";
import { OpsError } from "./errors.ts";
import { begin } from "./management.ts";

/** `slots.remove` parameters (04-contract-types §8). Only the slot's ID: names can be reused. */
export interface RemoveSlotParams {
  readonly slot_id: SlotId;
}

/** `slots.remove` result: the slot removed, as it was then. */
export interface RemoveSlotResult {
  readonly slot_id: SlotId;
  /** Its name when it was removed. */
  readonly name: string;
  /** Its current version when it was removed. */
  readonly sv: number;
  readonly removed_at: string;
}

/**
 * The event types of a slot that do not count as data (process/decisions/remove-empty-slot.md
 * §3): its policy and its schema's lifecycle. Every other type, any added later included, counts
 * as data, so that a type not considered here keeps a slot from being removed. `item.*` events
 * count unless their item is a schema change (see below).
 */
const NOT_DATA = new Set([
  "slot.policy_set",
  "schema.draft_submitted",
  "schema.compiled",
  "schema.confirmed",
  "schema.rejected",
  "schema.superseded",
  "schema.migration_started",
  "schema.switched",
  "schema.migration_failed",
]);
const ITEM_EVENT = /^item\./;

const notEmpty = (message: string, extra: Record<string, string> = {}) =>
  new OpsError("invalid_argument", message, {
    reason: "slot_not_empty",
    param: "slot_id",
    ...extra,
  });

/**
 * Whether the slot has data, decided from the log in the caller's transaction: throws
 * `slot_not_empty` if it has, or if a schema change item of it is still open.
 */
async function assertEmpty(tx: ReadTx, slot: SlotId): Promise<void> {
  const types = await tx.query<{ type: string }>(
    "SELECT DISTINCT type FROM events WHERE slot = $1",
    [slot],
  );
  const data = types.rows.find((r) => !NOT_DATA.has(r.type) && !ITEM_EVENT.test(r.type));
  if (data !== undefined)
    throw notEmpty("the slot has records; deleting a slot with records is for a later version");
  // Items: a schema change item is no record, but one still open would point at a slot gone.
  const items = await tx.query<{ body: string | null }>(
    `SELECT c.body FROM events e JOIN content c ON c.seq = e.seq AND c.path = 'target'
     WHERE e.slot = $1 AND e.type LIKE 'item.%'`,
    [slot],
  );
  const ids = new Set<string>();
  for (const r of items.rows) {
    const t = r.body === null ? null : (JSON.parse(r.body) as { item?: string; type?: string });
    // A target whose type is not given (item.merged and the like name only the item): looked up
    // below by the item's own type.
    if (t?.item !== undefined) ids.add(t.item);
  }
  if (ids.size === 0) return;
  const rows = await tx.query<{ id: string; type: string; state: string }>(
    "SELECT id, type, state FROM pending_items WHERE id = ANY($1)",
    [[...ids]] as never,
  );
  if (rows.rows.length !== ids.size || rows.rows.some((r) => r.type !== "schema_change"))
    throw notEmpty("the slot has records; deleting a slot with records is for a later version");
  const open = rows.rows.find((r) => r.state === "open");
  if (open !== undefined)
    throw notEmpty("a schema change of the slot is still open: resolve it first", {
      cause: "open_schema_change",
      item: open.id,
    });
}

/** The result of the slot's `slot.removed`, if it was removed, and that operation's number. */
async function removed(
  tx: ReadTx,
  slot: SlotId,
): Promise<{ result: RemoveSlotResult; op: number } | undefined> {
  const r = await tx.query<{ at: string; op: unknown; path: string; body: string | null }>(
    `SELECT e.at, e.op, c.path, c.body FROM events e JOIN content c ON c.seq = e.seq
     WHERE e.slot = $1 AND e.type = 'slot.removed' AND c.path IN ('target', 'name')`,
    [slot],
  );
  if (r.rows.length === 0) return undefined;
  const block = (path: string) => {
    const x = r.rows.find((y) => y.path === path);
    return x?.body == null ? undefined : (JSON.parse(x.body) as Record<string, unknown>);
  };
  const target = block("target");
  const name = block("name");
  if (target === undefined)
    throw new OpsError("internal", "the slot's removal is not in the log as written");
  return {
    result: {
      slot_id: slot,
      // The name block has no source, so no deletion takes it; kept defensive all the same.
      name: typeof name?.["name"] === "string" ? name["name"] : "",
      sv: target["sv"] as number,
      removed_at: (r.rows[0] as { at: string }).at,
    },
    op: Number((r.rows[0] as { op: unknown }).op),
  };
}

/**
 * `slots.remove`. A slot removed before is not removed again: its result is returned as it was
 * (04-contract §17). The slot's ID only; a name is refused, since names can be reused and a
 * removal by name sent again would remove another slot.
 */
export async function removeSlot(
  store: TenantStore,
  ctx: OpsContext,
  params: RemoveSlotParams,
): Promise<RemoveSlotResult> {
  const p = params as unknown as Readonly<Record<string, unknown>>;
  for (const k of Object.keys(p)) {
    if (k !== "slot_id")
      throw new OpsError("invalid_argument", `unknown parameter ${k}`, {
        reason: "malformed",
        param: k,
      });
  }
  const id = p["slot_id"];
  if (id === undefined)
    throw new OpsError("invalid_argument", "slot_id is required", {
      reason: "missing",
      param: "slot_id",
    });
  if (typeof id !== "string" || !isId("slot", id))
    throw new OpsError(
      "invalid_argument",
      "a slot is removed by its ID (sl_…), not by its name: names can be reused",
      { reason: "malformed", param: "slot_id" },
    );
  const slot = id as SlotId;
  return store.write(async (tx) => {
    const actor = await begin(tx, ctx);
    // Removed before: its result as it was, a replay of that operation.
    const before = await removed(tx, slot);
    if (before !== undefined) {
      return noteEffect(before.result, {
        effect: "replayed",
        seq: before.op,
        restores: await restoresOf(store, tx),
      });
    }
    const row = (
      await tx.query<{ name: string; current_sv: unknown }>(
        "SELECT name, current_sv FROM slots WHERE id = $1",
        [slot],
      )
    ).rows[0];
    if (row === undefined) throw new OpsError("not_found", "no such slot", { reason: "slot" });
    await assertEmpty(tx, slot);
    const sv = Number(row.current_sv);
    const op = await appendOperation(tx, {
      actor,
      now: ctx.now as never,
      events: [
        {
          type: "slot.removed",
          slot,
          blocks: {
            ctx: { now: ctx.now, ruleset_version: RULESET_VERSION },
            target: { slot_id: slot, sv },
            name: { name: row.name },
          },
        },
      ],
    });
    await applyEvents(tx, eventsOf(op));
    const done = (await removed(tx, slot)) as { result: RemoveSlotResult };
    return noteEffect(done.result, {
      effect: "appended",
      seq: op.op,
      restores: await restoresOf(store, tx),
    });
  });
}
