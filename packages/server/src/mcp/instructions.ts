// The server's `instructions` (docs/zh-CN/spec/05-surfaces.md §9 «服务器的 instructions», §11):
// static lines chosen by the credential's tools, then the slots it can see, by name and table
// count. Given in the result of `initialize` (2025-11-25) and of `server/discover` (2026-07-28).
//
// The slot names are the only user content in it (05 §5 «slot、表、字段的名字是受限的值»): each
// goes in as a name part, checked against the name shape like any name in a result, never as a
// string put together by hand. No table name, description, alias or row goes in.

import type { ListedSlot } from "@fluxvita/saveslot-service";
import type { ToolName } from "./names.ts";
import { type Line, name, num, render, t } from "./text.ts";
import { compose, INSTRUCTIONS } from "./texts.ts";

/** The slot list at most, its lead included, in code points (05 §9 «slot 清单» 3). */
export const SLOT_LIST_MAX = 1_500;

/** A slot name longer than this is not listed, and counts as not listed (05 §9 «slot 清单» 3). */
const NAME_MAX = 32;

const length = (s: string) => Array.from(s).length;

/** One slot's line: its name, and how many tables the credential sees in it. */
const slotLine = (s: ListedSlot): Line =>
  s.tables === 1
    ? t`${name(s.name)}: ${num(1)} table`
    : t`${name(s.name)}: ${num(s.tables)} tables`;

/** The line that ends a list that could not hold every slot. */
const notListedLine = (n: number): Line =>
  n === 1
    ? t`${num(1)} more slot is not listed; see it with saveslot_catalog.`
    : t`${num(n)} more slots are not listed; see them with saveslot_catalog.`;

/**
 * The slot list (05 §9 «slot 清单»): the lead, then a line per slot in name order, within
 * SLOT_LIST_MAX code points; the slots past it, and those with a name longer than NAME_MAX, are
 * counted in a last line. With no slot to see, the sentence for the credential instead.
 */
export function slotList(
  slots: readonly ListedSlot[],
  o: { readonly scoped: boolean; readonly schema: boolean },
): string {
  if (slots.length === 0) {
    const n = INSTRUCTIONS.noSlots;
    return o.scoped ? n.scoped : o.schema ? n.schema : n.noSchema;
  }
  const sorted = [...slots].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const listable = sorted.filter((s) => length(s.name) <= NAME_MAX);
  const lines: Line[] = [];
  // Room is kept for the last line whenever a slot may be left out: as long as the count could be.
  const room = (left: number) => (left > 0 ? length(render([notListedLine(slots.length)])) + 1 : 0);
  let used = length(INSTRUCTIONS.slotsLead);
  for (const s of listable) {
    const line = render([slotLine(s)]);
    // The slots that would still be left out once this one is listed.
    const after = slots.length - lines.length - 1;
    if (used + 1 + length(line) + room(after) > SLOT_LIST_MAX) break;
    lines.push(slotLine(s));
    used += 1 + length(line);
  }
  const notListed = slots.length - lines.length;
  if (notListed > 0) lines.push(notListedLine(notListed));
  return `${INSTRUCTIONS.slotsLead}\n${render(lines)}`;
}

/** The whole of `instructions` for a credential with these tools and slots. */
export function instructionsFor(
  tools: ReadonlySet<ToolName>,
  slots: readonly ListedSlot[],
  o: { readonly scoped: boolean },
): string {
  const lines = INSTRUCTIONS.lines.map((l) => compose(l, tools)).filter((l) => l !== "");
  const list = slotList(slots, { scoped: o.scoped, schema: tools.has("saveslot_schema_draft") });
  return [...lines, list].join("\n");
}
