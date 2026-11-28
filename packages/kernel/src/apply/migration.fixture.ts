// A migration started on a hand-made log, for other packages' tests of a switch rebuilding tables
// (store-pglite schema-rebuild): the confirmation of a pending `schema_change` item, as the
// confirmation path will log it once migrations are open (09-event-format §5.5: `item.resolved`,
// `schema.confirmed`, `schema.migration_started`). Source only; only test files may import it.

import type { Seq } from "@fluxvita/saveslot-contract-core";
import { appendOperation } from "../log/log.ts";
import type { Tx } from "../store/ports.ts";
import { applyEvents, eventsOf } from "./apply.ts";
import { confirmationHash, confirmedChecksums } from "./confirmation.ts";

/**
 * Confirms the open `schema_change` item of the slot's pending version `to`, and starts migration
 * `id` from version `from`: one operation, appended and applied in `tx`. Returns its number.
 */
export async function startMigrationForTests(
  tx: Tx,
  o: {
    readonly slot: string;
    readonly from: number;
    readonly to: number;
    readonly id: string;
    readonly actor: string;
    readonly now: string;
  },
): Promise<Seq> {
  const item = await tx.query<{ id: string; version_op: unknown }>(
    "SELECT id, version_op FROM pending_items WHERE type = 'schema_change' AND state = 'open' AND slot_id = $1",
    [o.slot],
  );
  const draft = await tx.query<{ draft_id: string }>(
    "SELECT draft_id FROM schema_versions WHERE slot_id = $1 AND sv = $2 AND state = 'pending'",
    [o.slot, o.to],
  );
  const it = item.rows[0];
  const d = draft.rows[0];
  if (it === undefined || d === undefined) throw new Error("no pending schema change to confirm");
  const hash = confirmationHash(await confirmedChecksums(tx, it.id));
  if (hash === undefined || hash === "removed") throw new Error("nothing to confirm");
  const op = await appendOperation(tx, {
    actor: o.actor as never,
    now: o.now as never,
    events: [
      {
        type: "item.resolved",
        slot: o.slot,
        blocks: {
          ctx: {
            now: o.now,
            today: o.now.slice(0, 10),
            ruleset_version: 1,
            policy_version: 1,
          },
          target: {
            item: it.id,
            decision: "confirm",
            item_op: Number(it.version_op),
            restore_count: 0,
            via: "call",
          },
          confirmation: { hash },
        },
      },
      {
        type: "schema.confirmed",
        slot: o.slot,
        blocks: { target: { draft_id: d.draft_id, target_version: o.to, by: "resolve" } },
      },
      {
        type: "schema.migration_started",
        slot: o.slot,
        blocks: {
          target: {
            migration_id: o.id,
            draft_id: d.draft_id,
            from_version: o.from,
            to_version: o.to,
          },
        },
      },
    ] as never,
  });
  await applyEvents(tx, eventsOf(op));
  return op.op as Seq;
}
