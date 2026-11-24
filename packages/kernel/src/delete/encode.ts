// Encoding a deletion's and a cancellation's results into event blocks
// (docs/zh-CN/spec/09-event-format.md §5.9 `deletion.confirmed`, `deletion.cancelled`): the
// replay's rows (`results/<k>/…`), restatements (`restated/<k>`), first-creation changes
// (`recreated/<k>`), and the lists beside them. The inverse of `decodeDeletionRecords`
// (write/record.ts); the round trip is checked in ../delete-encode.prop.test.ts.
//
// Pure. What goes in is already worked out: the replay's results by `judge` (`deletionResult`,
// `cancellationResult`), the positions by ./positions.ts, the impact summary's hash by the
// caller. Nothing is checked here beyond what the blocks' shapes need; `parseEvent` checks the
// event as a whole.

import type { FieldId, JsonValue, Seq } from "@fluxvita/saveslot-contract-core";
import type {
  BlockAddress,
  ItemRef,
  Restatement,
  ResultRow,
  ResultStretch,
} from "../judge/index.ts";
import type { Interval, IntervalSet } from "../time/index.ts";

type Blocks = Record<string, JsonValue>;

/** References without repeats, in their first order. */
function uniqueRefs(xs: readonly ItemRef[]): ItemRef[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = `${x.event}/${x.target}/${x.k}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Code-point order. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A contribution reference (§3.5): `{event, field, k}`, or `{event, existence}`. */
const refOut = (r: ItemRef): JsonValue =>
  r.target === "existence"
    ? { event: r.event, existence: r.k }
    : { event: r.event, field: r.target, k: r.k };

/** One interval as a block writes it: a missing end is open (§1.2). */
const endsOut = (x: Interval): { from?: string; to?: string } => ({
  ...(x.from !== null ? { from: x.from } : {}),
  ...(x.to !== null ? { to: x.to } : {}),
});

/** An item's or a stretch's interval: one interval (§5.7 `span`, §5.9 `results`). */
function spanOut(v: IntervalSet, what: string): { from?: string; to?: string } {
  const [x] = v;
  if (v.length !== 1 || x === undefined) {
    throw new Error(`${what}: one interval, not ${v.length}`);
  }
  return endsOut(x);
}

/** Value sources of a result or a valued restatement: carried, or a schema constant (§5.9). */
function sourcesOut(
  carried: readonly ItemRef[],
  schemaConst: { readonly sv: number; readonly field: FieldId } | undefined,
): JsonValue[] {
  return [
    ...carried.map((c): JsonValue => ({ kind: "value", carried: refOut(c) })),
    ...(schemaConst !== undefined
      ? [{ kind: "schema_const", sv: schemaConst.sv, field: schemaConst.field }]
      : []),
  ];
}

/** `restated/<k>` (§5.9). */
export function restatementOut(r: Restatement): JsonValue {
  const out: Record<string, JsonValue> = {
    ...(refOut(r.item) as Record<string, JsonValue>),
    status: r.status,
  };
  if (r.restored === true) out["restored"] = true;
  if (r.status !== "dropped" && r.valid !== undefined) {
    out[r.status === "candidate" ? "seen_valid" : "valid"] = spanOut(
      r.valid,
      `restated ${r.item.event}/${r.item.target}/${r.item.k}`,
    );
  }
  // A carried item's new value names what it carries in `deps` too (§5.9, §3.5 rule 1): judge
  // gives an event or timeless table's restatement no `deps`.
  const valued = r.item.target !== "existence" && r.content?.kind === "value";
  const deps = valued ? uniqueRefs([...r.deps, ...(r.carried ?? [])]) : r.deps;
  if (deps.length > 0) out["deps"] = deps.map(refOut);
  if (r.item.target !== "existence" && r.content !== undefined) {
    if (r.content.kind === "value") {
      out["value"] = r.content.value as JsonValue;
      out["sources"] = sourcesOut(r.carried ?? [], r.schemaConst);
    } else if (r.content.kind === "no_value") out["no_value"] = true;
    else if (r.content.kind === "uncovered") out["uncovered"] = true;
  }
  return out;
}

/** `results/<k>/fields/<f>/<j>` (§5.9): a state table's stretch has its interval and `deps`. */
function stretchOut(s: ResultStretch, entity: boolean): JsonValue {
  const base: Record<string, JsonValue> = {
    value: s.value as JsonValue,
    sources: sourcesOut(s.carried, s.schemaConst),
  };
  if (!entity) return base;
  return {
    ...base,
    valid: spanOut(s.valid ?? [], `results ${s.field}/${s.j}`),
    deps: s.deps.map(refOut),
  };
}

/**
 * `results/<k>/…` of one row or entity. An entity (a state table's) is the row with gaps: §5.9
 * gives `results/<k>/existence` on every entity listed, and never on a row.
 */
function resultOut(k: number, r: ResultRow, out: Blocks): void {
  const entity = r.gaps !== undefined;
  out[`results/${k}/target`] = {
    table: r.table,
    [entity ? "entity" : "row"]: r.id,
    outcome: r.outcome,
  };
  // The stretches listed of each field, numbered from 0 in their order (§5.9: the indices of a
  // row's stretches of a field run from 0 without a gap; judge numbers them among all the field's).
  const next = new Map<string, number>();
  for (const s of [...r.stretches].sort((a, b) => cmp(a.field, b.field) || a.j - b.j)) {
    const j = next.get(s.field) ?? 0;
    next.set(s.field, j + 1);
    out[`results/${k}/fields/${s.field}/${j}`] = stretchOut(s, entity);
  }
  if (r.gaps !== undefined) {
    out[`results/${k}/existence`] = {
      gaps: r.gaps.gaps.map(endsOut),
      deps: r.gaps.deps.map(refOut),
    };
  }
}

/** The blocks both events have: `results`, `restated`, `recreated`. */
function replayOut(
  results: readonly ResultRow[],
  restated: readonly Restatement[],
  recreated: readonly { readonly event: Seq; readonly created: boolean }[],
): Blocks {
  const out: Blocks = {};
  results.forEach((r, k) => {
    resultOut(k, r, out);
  });
  restated.forEach((r, k) => {
    out[`restated/${k}`] = restatementOut(r);
  });
  recreated.forEach((r, k) => {
    out[`recreated/${k}`] = { event: r.event, created: r.created };
  });
  return out;
}

/** What a `deletion.confirmed` says, besides its header and `ctx` (§5.9). */
export interface DeletionContent {
  readonly id: string;
  readonly sources: readonly Seq[];
  readonly dueAt: string;
  readonly origin: string;
  /** Sorted and without duplicates; the event's own `summary` among them (./positions.ts). */
  readonly positions: readonly BlockAddress[];
  /** The impact summary's hash (`summary`), which the confirmation handle binds. */
  readonly summaryHash: string;
  readonly results: readonly ResultRow[];
  readonly restated: readonly Restatement[];
  readonly recreated: readonly { readonly event: Seq; readonly created: boolean }[];
  /** Items superseded by the deletion (`superseded_items`); none: no block. */
  readonly superseded: readonly string[];
}

/** The blocks of a `deletion.confirmed` other than `ctx` and the request-id blocks (§5.9). */
export function encodeDeletion(d: DeletionContent): Blocks {
  return {
    target: {
      deletion: d.id,
      kind: "privacy",
      due_at: d.dueAt,
      sources: [...d.sources],
      origin: d.origin,
    },
    positions: d.positions.map((p) => ({ seq: p.seq, path: p.path })),
    summary: { hash: d.summaryHash },
    ...replayOut(d.results, d.restated, d.recreated),
    ...(d.superseded.length > 0 ? { superseded_items: [...d.superseded] } : {}),
  };
}

/** What a `deletion.cancelled` says, besides its header and `ctx` (§5.9). */
export interface CancellationContent {
  readonly id: string;
  readonly origin: string;
  readonly results: readonly ResultRow[];
  readonly restated: readonly Restatement[];
  readonly recreated: readonly { readonly event: Seq; readonly created: boolean }[];
  /** Items back to undecided (`restored_items`); none: no block. */
  readonly restoredItems: readonly string[];
  readonly keptSuperseded: readonly { readonly item: string; readonly byEvent: Seq }[];
  /** By (event, target): the items as the receipt lists them (§5.9 `kept_effective`). */
  readonly keptEffective: readonly {
    readonly event: Seq;
    readonly items: readonly ItemRef[];
    readonly byEvent: Seq;
  }[];
}

/** The blocks of a `deletion.cancelled` other than `ctx` and the request-id blocks (§5.9). */
export function encodeCancellation(c: CancellationContent): Blocks {
  const out: Blocks = {
    target: { deletion: c.id, origin: c.origin },
    ...replayOut(c.results, c.restated, c.recreated),
  };
  if (c.restoredItems.length > 0) out["restored_items"] = [...c.restoredItems];
  c.keptSuperseded.forEach((x, k) => {
    out[`kept_superseded/${k}`] = { item: x.item, by_event: x.byEvent };
  });
  c.keptEffective.forEach((x, k) => {
    out[`kept_effective/${k}`] = {
      event: x.event,
      items: x.items.map(
        (i): JsonValue =>
          i.target === "existence" ? { existence: i.k } : { field: i.target, k: i.k },
      ),
      by_event: x.byEvent,
    };
  });
  return out;
}
