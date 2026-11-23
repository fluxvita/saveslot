// The contract's result of an import (04-contract-types `ImportResult`), counted on the staging
// storage around step ③'s import event (02-architecture §8): the same for the local and the server
// mode. The event disables the principals still in force, so they are counted before it and after.

import type { ImportResult } from "@fluxvita/saveslot-contract";
import {
  appendImportEvent,
  type ReadTx,
  type StagedImport,
  type TenantStore,
} from "@fluxvita/saveslot-kernel";
import type { TenantId, UserId } from "./control-plane.ts";

const NOT_IMPORTED: ImportResult["not_imported"] = ["read_log", "credentials", "external_files"];

/**
 * Step ③'s import event appended to `staging`, and the import's result but for its restore count,
 * which ⑥ gives.
 */
export async function appendImportEventCounted(
  staging: TenantStore,
  o: {
    readonly tenant: TenantId;
    readonly user: UserId;
    readonly staged: StagedImport;
    readonly now: Parameters<typeof appendImportEvent>[1]["now"];
  },
): Promise<{
  readonly ev: Awaited<ReturnType<typeof appendImportEvent>>;
  readonly result: Omit<ImportResult, "restore_count">;
}> {
  const disabledBefore = await staging.read(countDisabled);
  const ev = await appendImportEvent(staging, {
    user: o.user,
    tenant: o.tenant,
    manifest: o.staged.manifest,
    now: o.now,
  });
  const [disabledAfter, slots, removed] = await staging.read(
    async (tx) =>
      [await countDisabled(tx), await count(tx, "slots"), await countRemoved(tx)] as const,
  );
  return {
    ev,
    result: {
      tenant_id: o.tenant,
      previous_tenant_id: o.staged.manifest.tenant_id,
      events: o.staged.events,
      seq: ev.seq,
      principals_disabled: disabledAfter - disabledBefore,
      slots,
      removed,
      // An import refuses a file holding a deletion event until apply knows them (`replay_failed`),
      // so it carries no deletion still pending and tombstones none.
      pending_deletions: { executed: 0, carried: 0 },
      exported_at: o.staged.manifest.exported_at,
      not_imported: NOT_IMPORTED,
    },
  };
}

const count = async (tx: ReadTx, table: "slots"): Promise<number> =>
  Number((await tx.query<{ n: unknown }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n ?? 0);

const countDisabled = async (tx: ReadTx): Promise<number> =>
  Number(
    (
      await tx.query<{ n: unknown }>(
        "SELECT count(*) AS n FROM principals WHERE state = 'disabled'",
      )
    ).rows[0]?.n ?? 0,
  );

const countRemoved = async (tx: ReadTx): Promise<number> =>
  Number(
    (
      await tx.query<{ n: unknown }>(
        "SELECT count(*) AS n FROM content WHERE removed_by IS NOT NULL",
      )
    ).rows[0]?.n ?? 0,
  );
