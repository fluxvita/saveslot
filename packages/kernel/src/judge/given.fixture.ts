// The blocks last given of a row (09 §5.7 «以最近一次为准»), as judge's replay reads them, with a
// deletion's restatements laid over: for tests that replay several deletions of one row in turn.

import type { ItemContent, OpRecord, Restatement } from "./model.ts";
import type { GivenBlock } from "./restate.ts";

/**
 * The blocks last given, less the deleted (event, target)s, with the restatements laid over.
 * `written`: the records as written, where the content of an item that is not carried comes from.
 */
export function overlay(
  given: ReadonlyMap<string, readonly GivenBlock[]>,
  restated: readonly Restatement[],
  gone: ReadonlySet<string>,
  written: readonly OpRecord[],
): Map<string, GivenBlock[]> {
  const own = ownContent(written);
  const out = new Map<string, GivenBlock[]>();
  for (const [et, blocks] of given) if (!gone.has(et)) out.set(et, [...blocks]);
  for (const r of restated) {
    const et = `${r.item.event}/${r.item.target}`;
    const rest = (out.get(et) ?? []).filter((b) => b.k !== r.item.k);
    if (r.status === "dropped") {
      // Last given as dropped: kept so (rule 1 compares with it), landing on the last interval
      // given before (numbering only).
      const before = (out.get(et) ?? []).find((b) => b.k === r.item.k);
      const landing = before?.landing ?? before?.valid ?? [];
      out.set(et, [
        ...rest,
        {
          k: r.item.k,
          status: "dropped",
          valid: [],
          ...(landing.length > 0 ? { landing } : {}),
          deps: [],
          content: droppedContent(own, r, before),
        },
      ]);
      continue;
    }
    // The block last given for the index, for the carried references of a restatement that does
    // not give the content.
    const was = (given.get(et) ?? []).find((b) => b.k === r.item.k);
    out.set(et, [
      ...rest,
      {
        k: r.item.k,
        status: r.status,
        // A restatement without an interval is an event or timeless table's: the whole of it.
        valid: r.valid ?? [{ from: null, to: null }],
        deps: r.deps,
        content: r.content ?? contentOf(own, r),
        // A restatement that gives the content gives the carried references with it (none for
        // a write-back with no value or that only registers).
        ...(r.content !== undefined
          ? r.carried !== undefined
            ? { carried: r.carried }
            : {}
          : was?.carried !== undefined
            ? { carried: was.carried }
            : {}),
      },
    ]);
  }
  return normalized(out);
}

/** The content of each item as written, by `${event}/${target}/${k}` and, for any index, `${event}/${target}`. */
function ownContent(written: readonly OpRecord[]): Map<string, ItemContent> {
  const out = new Map<string, ItemContent>();
  for (const r of written) {
    if (!("items" in r)) continue;
    for (const x of r.items) {
      const et = `${r.event}/${x.target}`;
      out.set(`${et}/${x.k}`, x.content);
      if (!out.has(et)) out.set(et, x.content);
    }
  }
  return out;
}

/** The content as written of a restatement's item: its own index's, else any index's of it. */
function writtenContent(
  own: ReadonlyMap<string, ItemContent>,
  r: Restatement,
): ItemContent | undefined {
  const et = `${r.item.event}/${r.item.target}`;
  return own.get(`${et}/${r.item.k}`) ?? own.get(et);
}

/**
 * The content of an index restated as dropped. It is never read (rule 1 compares a dropped block's
 * status first, numbering reads intervals only): the block it last had, else its own as written.
 * With neither — an index only a cancelled or a since-dropped deletion gave, of an (event, target)
 * with no item when written, such as a revert's write-back — it gives nothing (`uncovered`).
 */
function droppedContent(
  own: ReadonlyMap<string, ItemContent>,
  r: Restatement,
  before: GivenBlock | undefined,
): ItemContent {
  return before?.content ?? writtenContent(own, r) ?? { kind: "uncovered" };
}

/**
 * The content of a restatement that does not give it (09 §5.9: `value` and `sources` only for
 * carried items; `no_value` and `uncovered` said as such): on existence a restore exactly when it
 * says so (`restored`), else a revoke; on a field the write's own value, fixed in the write event,
 * whatever block a deletion gave the index since. Never another block's, never a made-up null.
 *
 * An (event, target) with no item when written that a deletion makes a contribution: a field judged
 * a no-op stays one in every replay (09 §5.7 `ops/<i>/noop`, `ReplayOptions.noop`; the fixed case
 * in replay-deletion.test.ts); a revoke's existence (a no-op on a row revoked already) is restated
 * with `restored` as it is; a revert's write-back is carried or says `no_value` or `uncovered`, so
 * its restatement gives the content. None reaches the records here; one that did would throw.
 */
function contentOf(own: ReadonlyMap<string, ItemContent>, r: Restatement): ItemContent {
  if (r.item.target === "existence") return { kind: r.restored ? "restore" : "revoke" };
  const c = writtenContent(own, r);
  if (c === undefined) {
    throw new Error(
      `overlay: ${r.item.event}/${r.item.target} is restated without content and has no item as written`,
    );
  }
  return c;
}

/** Each (event, target)'s blocks, by index; those with none left out. */
export function normalized(m: Map<string, GivenBlock[]>): Map<string, GivenBlock[]> {
  return new Map(
    [...m]
      .filter(([, bs]) => bs.length > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([et, bs]) => [et, [...bs].sort((x, y) => x.k - y.k)]),
  );
}
