// A deletion confirmed as the `delete` operation will confirm it, for tests: what the sources take
// away and the positions by the kernel's `delete` module, the row's results, restatements and first
// creations by judge's replay of the row's log, encoded by `encodeDeletion`; the event appended and
// applied. Item events are not made (the `delete` operation's), nor `superseded_items` (the log's
// item IDs). One row: the row or entity the sources were cited on. `confirmDeletion` and
// `cancelDeletion` take one deletion at a time, none other pending; `DeletionSession` confirms and
// cancels several in turn. Writes after a deletion are not replayed in this version, so a test
// writes nothing after its first deletion.

import {
  appendOperation,
  applyEvents,
  encodeCancellation,
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
  cancellationReplayForTests,
  DeletionSessionForTests,
  deletionReplayForTests,
  judgeStateFromLog,
  tableShape,
} from "@fluxvita/saveslot-kernel/testing";
import type { PgliteTenantStore } from "../backend.ts";

const DELETION_ID = `pi_${"7".repeat(16)}`;

export interface ConfirmInput {
  readonly slot: string;
  /** The table's compiled definition. */
  readonly table: { readonly id: string; readonly time: { readonly type: string } } & Record<
    string,
    unknown
  >;
  readonly row: string;
  readonly sources: readonly number[];
  /** The deletion's ID (default: one fixed ID; give another for a second deletion). */
  readonly id?: string;
  /**
   * Items the deletion supersedes (`superseded_items`, each with its `item.superseded`, reason
   * `deleted`), as the `delete` operation will name them: given by the test, not worked out.
   */
  readonly superseded?: readonly string[];
  /** Items the cancellation puts back (`restored_items`): given by the test, not worked out. */
  readonly restoredItems?: readonly string[];
  readonly actor: string;
  readonly now: string;
  /** Changes the blocks before they are appended (a test making a result disagree). */
  readonly tamper?: (blocks: Record<string, unknown>) => void;
}

type Tx = Parameters<Parameters<PgliteTenantStore["read"]>[0]>[0];

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
        id: input.id ?? DELETION_ID,
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
        superseded: input.superseded ?? [],
      }),
    };
    return { self, blocks, positions, replay };
  });
  input.tamper?.(made.blocks);
  await store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: input.actor as never,
      now: input.now as never,
      events: [
        { type: "deletion.confirmed", slot: input.slot, blocks: made.blocks } as NewEvent,
        ...(input.superseded ?? []).map(
          (item) =>
            ({
              type: "item.superseded",
              slot: input.slot,
              blocks: { target: { item, reason: "deleted", by_event: made.self } },
            }) as NewEvent,
        ),
      ],
    });
    await applyEvents(tx, eventsOf(op));
  });
  return made;
}

/**
 * Cancels the only pending deletion of the row, confirmed by `confirmDeletion` with these sources
 * (and this ID) and nothing written since: judge's replay without it, encoded; appended and
 * applied. No item is put back (no item events were made with the deletion). Returns its event's
 * seq and blocks.
 */
export async function cancelDeletion(store: PgliteTenantStore, input: ConfirmInput) {
  const isState = input.table.time.type === "state";
  const made = await store.read(async (tx) => {
    const shape = tableShape(input.table as never);
    const ctx = {
      table: input.table.id,
      target: isState ? { entity: input.row } : { row: input.row },
      shape,
      granularity: "date",
    } as never;
    // The records as written: judge reads the log without its deletion events.
    const state = await judgeStateFromLog(tx, ctx);
    const bases = await readCitations(tx, input.slot, input.sources);
    const deleted = takenAway(bases, new Set(input.sources));
    const confirmed = deletionReplayForTests(shape, state.records, deleted);
    const back = cancellationReplayForTests(
      shape,
      state.records,
      deleted,
      confirmed.replay.restated,
    );
    const self = ((await readTail(tx))?.seq ?? 0) + 1;
    const r = back.result;
    const blocks: Record<string, unknown> = {
      ctx: { now: input.now, today: input.now.slice(0, 10), ruleset_version: 1, policy_version: 1 },
      ...encodeCancellation({
        id: input.id ?? DELETION_ID,
        origin: "request",
        results: r.listed
          ? [
              {
                table: input.table.id,
                id: input.row,
                outcome: back.outcome as string,
                stretches: r.stretches,
                ...(r.gaps !== undefined ? { gaps: r.gaps } : {}),
              },
            ]
          : [],
        restated: back.replay.restated,
        recreated: r.recreated,
        restoredItems: input.restoredItems ?? [],
        keptSuperseded: [],
        keptEffective: [],
      }),
    };
    return { self, blocks };
  });
  input.tamper?.(made.blocks);
  await store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: input.actor as never,
      now: input.now as never,
      events: [{ type: "deletion.cancelled", slot: input.slot, blocks: made.blocks } as NewEvent],
    });
    await applyEvents(tx, eventsOf(op));
  });
  return made;
}

/**
 * Several deletions of one row confirmed and cancelled in turn, each as `delete` and its
 * cancellation will make it: judge's replays (`DeletionSessionForTests`), the positions by the
 * `delete` module, encoded, appended and applied. No item events are made.
 */
export class DeletionSession {
  readonly #store: PgliteTenantStore;
  readonly #input: Omit<ConfirmInput, "sources" | "now" | "id" | "tamper">;
  readonly #session: DeletionSessionForTests;
  /** Each deletion's sources, by ID. */
  readonly #sources = new Map<string, readonly number[]>();

  constructor(
    store: PgliteTenantStore,
    input: Omit<ConfirmInput, "sources" | "now" | "id" | "tamper">,
  ) {
    this.#store = store;
    this.#input = input;
    this.#session = new DeletionSessionForTests(tableShape(input.table as never));
  }

  async #records(tx: Tx) {
    const isState = this.#input.table.time.type === "state";
    const ctx = {
      table: this.#input.table.id,
      target: isState ? { entity: this.#input.row } : { row: this.#input.row },
      shape: this.#session.table,
      granularity: "date",
    } as never;
    return (await judgeStateFromLog(tx, ctx)).records;
  }

  #results(r: { listed: boolean; stretches: unknown; gaps?: unknown }, outcome: unknown) {
    return r.listed
      ? [
          {
            table: this.#input.table.id,
            id: this.#input.row,
            outcome: outcome as string,
            stretches: r.stretches as never,
            ...(r.gaps !== undefined ? { gaps: r.gaps as never } : {}),
          },
        ]
      : [];
  }

  async #append(type: string, now: string, blocks: Record<string, unknown>) {
    await this.#store.write(async (tx) => {
      const op = await appendOperation(tx, {
        actor: this.#input.actor as never,
        now: now as never,
        events: [{ type, slot: this.#input.slot, blocks } as NewEvent],
      });
      await applyEvents(tx, eventsOf(op));
    });
  }

  /** Confirms deletion `id` of `sources`; returns its event's seq and blocks. */
  async confirm(id: string, sources: readonly number[], now: string) {
    const made = await this.#store.read(async (tx) => {
      const records = await this.#records(tx);
      const bases = await readCitations(tx, this.#input.slot, sources);
      const deleted = takenAway(bases, new Set(sources));
      const res = this.#session.confirm(records, id, deleted);
      const restated = res.replay.restated;
      const self = ((await readTail(tx))?.seq ?? 0) + 1;
      const index = await readPositionIndex(tx, {
        slot: this.#input.slot,
        sources,
        bases,
        deleted,
        restated,
      });
      const positions = positionsOf({ sources, deleted, restated, index, self });
      const blocks: Record<string, unknown> = {
        ctx: { now, today: now.slice(0, 10), ruleset_version: 1, policy_version: 1 },
        ...encodeDeletion({
          id,
          sources,
          dueAt: "2026-12-31T00:00:00.000Z",
          origin: "request",
          positions,
          summaryHash: "c".repeat(64),
          results: this.#results(res.result, res.outcome),
          restated,
          recreated: res.result.recreated,
          superseded: [],
        }),
      };
      return { self, blocks };
    });
    this.#sources.set(id, sources);
    await this.#append("deletion.confirmed", now, made.blocks);
    return made;
  }

  /** Cancels deletion `id`; returns its event's seq and blocks. */
  async cancel(id: string, now: string) {
    const made = await this.#store.read(async (tx) => {
      const records = await this.#records(tx);
      const back = this.#session.cancel(records, id);
      const self = ((await readTail(tx))?.seq ?? 0) + 1;
      const blocks: Record<string, unknown> = {
        ctx: { now, today: now.slice(0, 10), ruleset_version: 1, policy_version: 1 },
        ...encodeCancellation({
          id,
          origin: "request",
          results: this.#results(back.result, back.outcome),
          restated: back.replay.restated,
          recreated: back.result.recreated,
          restoredItems: [],
          keptSuperseded: [],
          keptEffective: [],
        }),
      };
      return { self, blocks };
    });
    await this.#append("deletion.cancelled", now, made.blocks);
    return made;
  }
}
