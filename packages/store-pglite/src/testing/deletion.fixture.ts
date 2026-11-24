// A deletion confirmed as the `delete` operation will confirm it, for tests: what the sources take
// away and the positions by the kernel's `delete` module, the row's results, restatements and first
// creations by judge's replay of the row's log, encoded by `encodeDeletion`; the event appended and
// applied. Item events are not made (the `delete` operation's), nor `superseded_items` (the log's
// item IDs). One row: the row or entity the sources were cited on.

import {
  appendOperation,
  applyEvents,
  encodeDeletion,
  eventsOf,
  type NewEvent,
  positionsOf,
  readCitations,
  readPositionIndex,
  readTail,
  takenAway,
} from "@fluxvita/saveslot-kernel";
import {
  deletionReplayForTests,
  judgeStateFromLog,
  tableShape,
} from "@fluxvita/saveslot-kernel/testing";
import type { PgliteTenantStore } from "../backend.ts";

export interface ConfirmInput {
  readonly slot: string;
  /** The table's compiled definition. */
  readonly table: { readonly id: string; readonly time: { readonly type: string } } & Record<
    string,
    unknown
  >;
  readonly row: string;
  readonly sources: readonly number[];
  readonly actor: string;
  readonly now: string;
  /** Changes the blocks before they are appended (a test making a result disagree). */
  readonly tamper?: (blocks: Record<string, unknown>) => void;
}

/** Confirms the deletion; returns its event's seq and blocks. */
export async function confirmDeletion(store: PgliteTenantStore, input: ConfirmInput) {
  const isState = input.table.time.type === "state";
  const made = await store.read(async (tx) => {
    const shape = tableShape(input.table as never);
    const ctx = {
      table: input.table.id,
      target: isState ? { entity: input.row } : { row: input.row },
      shape,
      granularity: "date",
    } as never;
    const state = await judgeStateFromLog(tx, ctx);
    const bases = await readCitations(tx, input.slot, input.sources);
    const deleted = takenAway(bases, new Set(input.sources));
    const replay = deletionReplayForTests(shape, state.records, deleted);
    const restated = replay.replay.restated;
    const self = ((await readTail(tx))?.seq ?? 0) + 1;
    const index = await readPositionIndex(tx, {
      slot: input.slot,
      sources: input.sources,
      bases,
      deleted,
      restated,
    });
    const positions = positionsOf({ sources: input.sources, deleted, restated, index, self });
    const r = replay.result;
    const blocks: Record<string, unknown> = {
      ctx: {
        now: input.now,
        today: input.now.slice(0, 10),
        ruleset_version: 1,
        policy_version: 1,
      },
      ...encodeDeletion({
        id: `pi_${"7".repeat(16)}`,
        sources: input.sources,
        dueAt: "2026-12-31T00:00:00.000Z",
        origin: "request",
        positions,
        summaryHash: "c".repeat(64),
        results: r.listed
          ? [
              {
                table: input.table.id,
                id: input.row,
                outcome: replay.outcome as string,
                stretches: r.stretches,
                ...(r.gaps !== undefined ? { gaps: r.gaps } : {}),
              },
            ]
          : [],
        restated,
        recreated: r.recreated,
        superseded: [],
      }),
    };
    return { self, blocks, positions, replay };
  });
  input.tamper?.(made.blocks);
  await store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: input.actor as never,
      now: input.now as never,
      events: [{ type: "deletion.confirmed", slot: input.slot, blocks: made.blocks } as NewEvent],
    });
    await applyEvents(tx, eventsOf(op));
  });
  return made;
}
