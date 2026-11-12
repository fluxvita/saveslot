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
