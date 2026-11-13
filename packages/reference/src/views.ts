// Readable views of an evaluation, for assertions.

import type { FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import { type IvSet, normalize, type Point } from "./interval.ts";
import type { Evaluation, ItemRef, ItemResult } from "./model.ts";

/** `[from, to)` with `-inf` / `inf` for open ends. */
export function showIv(valid: IvSet): string {
  return normalize(valid)
    .map((x) => `[${x.from ?? "-inf"}, ${x.to ?? "inf"})`)
    .join(" + ");
}

/**
 * The field's values as the query layer shows them by default: adjacent segments with the same
 * value merged regardless of who gives them (05-time «查询»). Gaps are left out.
 */
export function timeline(ev: Evaluation, f: FieldId): string[] {
  const out: { from: Point | null; to: Point | null; value: FieldValue }[] = [];
  for (const seg of ev.fields[f] ?? []) {
    for (const x of normalize(seg.valid)) {
      const last = out[out.length - 1];
      if (
        last !== undefined &&
        last.to === x.from &&
        JSON.stringify(last.value) === JSON.stringify(seg.value)
      ) {
        last.to = x.to;
      } else {
        out.push({ from: x.from, to: x.to, value: seg.value });
      }
    }
  }
  return out.map((x) => `${showIv([{ from: x.from, to: x.to }])} ${JSON.stringify(x.value)}`);
}

/** Segments as 09 §5.9 lists them: one per giving item, with the giver. */
export function segments(ev: Evaluation, f: FieldId): string[] {
  return (ev.fields[f] ?? []).map(
    (s) =>
      `${showIv(s.valid)} ${JSON.stringify(s.value)}${s.by ? ` by #${s.by.event}/${s.by.target}/${s.by.k}` : ""}`,
  );
}

export function findItem(ev: Evaluation, ref: ItemRef): ItemResult | undefined {
  return ev.items.find((x) => x.event === ref.event && x.target === ref.target && x.k === ref.k);
}

/** Items of one event, as `target/k status valid content`, sorted. */
export function itemsOf(ev: Evaluation, event: number): string[] {
  return ev.items
    .filter((x) => x.event === event)
    .map((x) => {
      const c = x.content;
      const content =
        c.kind === "value" ? JSON.stringify(c.value) : c.kind === "noValue" ? "no_value" : c.kind;
      const carried = x.carried?.length
        ? ` carried ${x.carried.map((r) => `#${r.event}/${r.target}/${r.k}`).join(",")}`
        : "";
      const valid = x.status === "dropped" ? "" : ` ${showIv(x.valid)}`;
      return `${x.target}/${x.k} ${x.status}${valid}${x.status === "dropped" ? "" : ` ${content}${carried}`}`;
    })
    .sort();
}

/**
 * An evaluation without restatement bookkeeping, for order independence (03-deletion «推论»
 * «顺序无关»): state and items are compared, restatement indices and `dropped` entries are not.
 * Items lose their index `k`, and so do references to items (`carried`, a segment's giver). A
 * revert's record (by event and target) is compared in no particular order.
 */
export function stateWithoutIndices(ev: Evaluation): unknown {
  const ref = (r: ItemRef) => ({ event: r.event, target: r.target });
  const byJson = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b));
  return {
    kind: ev.kind,
    exists: ev.exists,
    gaps: ev.gaps,
    created: ev.created,
    reverts: ev.reverts.map((r) => ({ ...r, record: [...r.record].sort(byJson) })),
    fields: Object.fromEntries(
      Object.entries(ev.fields).map(([f, segs]) => [
        f,
        (segs ?? []).map((s) => ({
          valid: s.valid,
          value: s.value,
          ...(s.by ? { by: ref(s.by) } : {}),
        })),
      ]),
    ),
    items: ev.items
      .filter((x) => x.status !== "dropped")
      .map((x) => ({
        event: x.event,
        target: x.target,
        op: x.op,
        status: x.status,
        valid: x.valid,
        content: x.content,
        ...(x.carried ? { carried: x.carried.map(ref) } : {}),
        registrations: x.registrations,
        ...(x.closed ? { closed: true } : {}),
      }))
      .sort(byJson),
  };
}
