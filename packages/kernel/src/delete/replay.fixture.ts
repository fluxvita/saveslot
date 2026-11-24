// A deletion's replay of one row for tests in other packages: judge's `deletionResult` on the
// records as written, with the items as the records give them (no item events read). The kernel's
// `delete` operation will pass what the log's item events say instead.

import { itemsByRecords } from "../judge/fates.ts";
import { overlay } from "../judge/given.fixture.ts";
import type { OpRecord, Restatement, TableShape } from "../judge/model.ts";
import {
  type CancellationLog,
  cancellationResult,
  deletionResult,
  type ExternalFor,
} from "../judge/replay-deletion.ts";
import { type GivenBlock, givenByRecords } from "../judge/restate.ts";
import { RowState } from "../judge/state.ts";

/** No deletion or cancellation event as L of the conflict criterion: no write after a deletion. */
const NO_EXTERNAL: ExternalFor = () => [];

/** A cancellation with no operation after the deletion cancelled, nothing kept by earlier ones. */
const NO_GRACE: CancellationLog = {
  cancelledOp: Number.MAX_SAFE_INTEGER,
  coveredSince: Number.MAX_SAFE_INTEGER,
  keptEffective: new Set<string>(),
  effectiveSince: () => 0,
};

/**
 * The replay of the row with `deleted` taken away; `external`: the deletion and cancellation events
 * already in the log as L of the conflict criterion, for a replay's deleted set (none by default);
 * `pendingBefore`: what the deletions pending before it take away (none by default).
 */
export const deletionReplayForTests = (
  table: TableShape,
  records: readonly OpRecord[],
  deleted: ReadonlySet<string>,
  external: ExternalFor = NO_EXTERNAL,
  pendingBefore: ReadonlySet<string> = new Set(),
) =>
  deletionResult(
    table,
    records,
    deleted,
    pendingBefore,
    itemsByRecords(new RowState(table, records)),
    external,
  );

/**
 * The replay of the row with a pending deletion cancelled (no write since): `deleted` its
 * contributions, `restated` its restatements (the items whose last interval block came from it are
 * those not restated as dropped, 09 §5.9 rule 3); the blocks last given are the records'.
 * `others`: what the other pending deletions take away (none by default); `external`: as for
 * `deletionReplayForTests`; nothing written in the grace period (`NO_GRACE`).
 */
export const cancellationReplayForTests = (
  table: TableShape,
  records: readonly OpRecord[],
  deleted: ReadonlySet<string>,
  restated: readonly Restatement[],
  others: ReadonlySet<string> = new Set(),
  external: ExternalFor = NO_EXTERNAL,
) =>
  cancellationResult(
    table,
    records,
    others,
    deleted,
    itemsByRecords(new RowState(table, records)),
    givenByRecords(records),
    new Set(
      restated
        .filter((r) => r.status !== "dropped")
        .map((r) => `${r.item.event}/${r.item.target}/${r.item.k}`),
    ),
    external,
    NO_GRACE,
  );

/**
 * Several deletions of one row, confirmed and cancelled in turn, as judge replays each (no write
 * after the first, so nothing written in a grace period): the blocks last given are the records'
 * with the restatements of the deletion and cancellation events laid over in log order, those of a
 * cancelled deletion left out (09 §5.7 «被撤回的删除给出的块不算»); a confirmation's replay takes away what it deletes and what the
 * deletions still pending do; a cancellation's, what the others still pending do. Each call is
 * recorded as the event the caller appends next.
 */
export class DeletionSessionForTests {
  readonly #deletions = new Map<string, { deleted: ReadonlySet<string>; cancelled: boolean }>();
  readonly #log: {
    readonly kind: "confirm" | "cancel";
    readonly id: string;
    readonly restated: readonly Restatement[];
  }[] = [];

  readonly table: TableShape;

  constructor(table: TableShape) {
    this.table = table;
  }

  /** What the deletions pending take away, but `except`'s. */
  #pending(except?: string): Set<string> {
    const out = new Set<string>();
    for (const [id, d] of this.#deletions)
      if (!d.cancelled && id !== except) for (const k of d.deleted) out.add(k);
    return out;
  }

  /**
   * The blocks last given, `gone` taken away; the restatements of cancelled deletions and of those
   * in `skip` left out.
   */
  #latest(records: readonly OpRecord[], gone: ReadonlySet<string>, skip: readonly string[] = []) {
    let m: Map<string, GivenBlock[]> = new Map(
      [...givenByRecords(records)].filter(([et]) => !gone.has(et)),
    );
    for (const e of this.#log) {
      const off = this.#deletions.get(e.id)?.cancelled === true || skip.includes(e.id);
      if (e.kind === "confirm" && off) continue;
      m = overlay(m, e.restated, gone);
    }
    return m;
  }

  /**
   * The replay of deletion `id` taking `deleted` away, recorded; with `alone`, the restatements of
   * its replay with no other deletion pending (what its positions are worked out from, 09 §3.5
   * rule 1): the blocks last given without any pending deletion's, a cancellation's counted.
   */
  confirm(
    records: readonly OpRecord[],
    id: string,
    deleted: ReadonlySet<string>,
    external: ExternalFor = NO_EXTERNAL,
  ) {
    const before = this.#pending();
    const res = deletionResult(
      this.table,
      records,
      new Set([...before, ...deleted]),
      before,
      itemsByRecords(new RowState(this.table, records)),
      external,
      this.#latest(records, before),
    );
    const pending = [...this.#deletions].filter(([, d]) => !d.cancelled).map(([x]) => x);
    const alone =
      pending.length === 0
        ? res.replay.restated
        : deletionResult(
            this.table,
            records,
            deleted,
            new Set(),
            itemsByRecords(new RowState(this.table, records)),
            external,
            this.#latest(records, new Set(), pending),
          ).replay.restated;
    this.#deletions.set(id, { deleted, cancelled: false });
    this.#log.push({ kind: "confirm", id, restated: res.replay.restated });
    return { ...res, alone };
  }

  /** The replay of deletion `id` cancelled, recorded. */
  cancel(records: readonly OpRecord[], id: string, external: ExternalFor = NO_EXTERNAL) {
    const d = this.#deletions.get(id);
    if (d === undefined || d.cancelled) throw new Error(`no pending deletion ${id}`);
    const others = this.#pending(id);
    // The items whose last interval block came from the cancelled deletion (09 §5.9 rule 3): its
    // restatements not dropped, and not restated again by a later event in force.
    const at = this.#log.findIndex((e) => e.kind === "confirm" && e.id === id);
    const item = (r: Restatement) => `${r.item.event}/${r.item.target}/${r.item.k}`;
    const later = new Set(
      this.#log
        .slice(at + 1)
        .filter((e) => !(e.kind === "confirm" && this.#deletions.get(e.id)?.cancelled))
        .flatMap((e) => e.restated.map(item)),
    );
    const from = new Set(
      (this.#log[at]?.restated ?? [])
        .filter((r) => r.status !== "dropped")
        .map(item)
        .filter((k) => !later.has(k)),
    );
    const back = cancellationResult(
      this.table,
      records,
      others,
      d.deleted,
      itemsByRecords(new RowState(this.table, records)),
      this.#latest(records, others, [id]),
      from,
      external,
      NO_GRACE,
    );
    this.#deletions.set(id, { ...d, cancelled: true });
    this.#log.push({ kind: "cancel", id, restated: back.replay.restated });
    return back;
  }
}
