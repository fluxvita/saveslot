// The blocks last given of a row (09 §5.7 «以最近一次为准»), as judge's replay reads them, with a
// deletion's restatements laid over: for tests that replay several deletions of one row in turn.

import type { Restatement } from "./model.ts";
import type { GivenBlock } from "./restate.ts";

/** The blocks last given, less the deleted (event, target)s, with the restatements laid over. */
export function overlay(
  given: ReadonlyMap<string, readonly GivenBlock[]>,
  restated: readonly Restatement[],
  gone: ReadonlySet<string>,
): Map<string, GivenBlock[]> {
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
          content: before?.content ?? { kind: "value", value: null },
        },
      ]);
      continue;
    }
    // A new index has no block of its own: its content is the write's (any other index of it),
    // on existence a restore or a revoke as the restatement says.
    const was =
      (given.get(et) ?? []).find((b) => b.k === r.item.k) ??
      (r.item.target === "existence"
        ? {
            k: r.item.k,
            status: r.status,
            // Event and timeless tables give no interval: an item is the whole of it.
            valid: [{ from: null, to: null }],
            deps: [],
            content: { kind: r.restored ? "restore" : "revoke" } as const,
          }
        : (given.get(et) ?? [])[0]);
    out.set(et, [
      ...rest,
      {
        k: r.item.k,
        status: r.status,
        // A restatement without an interval is an event or timeless table's: the whole of it.
        valid: r.valid ?? [{ from: null, to: null }],
        deps: r.deps,
        // On existence a restatement is a restore exactly when it says so (09 §5.9 `restored`).
        content:
          r.item.target === "existence" && r.content === undefined
            ? { kind: r.restored ? "restore" : "revoke" }
            : (r.content ?? was?.content ?? { kind: "value", value: null }),
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

/** Each (event, target)'s blocks, by index; those with none left out. */
export function normalized(m: Map<string, GivenBlock[]>): Map<string, GivenBlock[]> {
  return new Map(
    [...m]
      .filter(([, bs]) => bs.length > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([et, bs]) => [et, [...bs].sort((x, y) => x.k - y.k)]),
  );
}
