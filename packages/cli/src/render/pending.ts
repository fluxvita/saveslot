// The text of `saveslot pending` (docs/zh-CN/spec/06-cli.md §4.5, §5.1): the list, oldest first,
// with how long each item has been open; an item's detail with its version, what it proposes or
// what conflicts, what taking effect would change (each overwritten segment, reverted write and
// referencing row, 06 §5.1), how it was closed, and the choices this credential has. Values and
// names given by writers go inside the boundary.

import {
  type AwaitingImpact,
  CANDIDATE_CAUSES,
  DECISIONS,
  DELETION_ORIGINS,
  ITEM_CREATED_REASONS,
  ITEM_STATUSES,
  ITEM_TYPES,
  type PendingDetailResult,
  type PendingListResult,
  type ResolveResult,
  SUPERSEDED_REASONS,
  VERSION_INTENTS,
} from "@fluxvita/saveslot-client";
import {
  actorOf,
  arr,
  count,
  fieldOf,
  fieldValue,
  idOf,
  int,
  isObj,
  namedValues,
  obj,
  op,
  periodOf,
  type R,
  str,
  targetOf,
} from "./reads.ts";
import { warningsAndNotices } from "./results.ts";
import { code, handle, join, type Line, name, num, type Part, t, time, untrusted } from "./text.ts";

const TYPES: ReadonlySet<string> = new Set<string>(ITEM_TYPES);
const STATUSES: ReadonlySet<string> = new Set<string>(ITEM_STATUSES);
const REASONS: ReadonlySet<string> = new Set<string>([
  ...ITEM_CREATED_REASONS,
  ...DELETION_ORIGINS,
]);
const DECISION: ReadonlySet<string> = new Set<string>(DECISIONS);
const INTENTS: ReadonlySet<string> = new Set<string>(VERSION_INTENTS);
const CAUSES: ReadonlySet<string> = new Set<string>(CANDIDATE_CAUSES);
const SUPERSEDED: ReadonlySet<string> = new Set<string>(SUPERSEDED_REASONS);
const codeOf = (x: unknown, set: ReadonlySet<string>): Part => code(String(x ?? ""), set);

/** How long since `opened` (06 §5.1 "已挂 3 小时"): minutes, hours or days, whole. */
export function openFor(opened: unknown, now: Date): Part[] {
  const at = typeof opened === "string" ? Date.parse(opened) : Number.NaN;
  if (Number.isNaN(at)) return [untrusted(String(opened))];
  const minutes = Math.max(0, Math.floor((now.getTime() - at) / 60_000));
  if (minutes < 60) return t`${num(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t`${num(hours)} h`;
  return t`${num(Math.floor(hours / 24))} d`;
}

/** An item's target: its table and row or entity, or its slot when it has none. */
const itemTarget = (target: unknown, slot: unknown): Part[] =>
  isObj(target) ? targetOf(target) : t`slot ${name(String(slot ?? ""))}`;

/** `saveslot pending` (06 §4.5, §5.1): oldest first, each with how long it has been open. */
export function pendingList(r: PendingListResult, now: Date): Line[] {
  const items = [...arr((r as unknown as R)["items"])].map(obj);
  // Oldest first within the page (06 §5.1); a moment it cannot read goes last.
  const at = (x: R) => {
    const v = typeof x["opened_at"] === "string" ? Date.parse(x["opened_at"]) : Number.NaN;
    return Number.isNaN(v) ? Number.POSITIVE_INFINITY : v;
  };
  items.sort((a, b) => at(a) - at(b));
  const out: Line[] = [t`${num(items.length)} pending items`];
  for (const x of items) {
    out.push(
      t`${idOf(x["id"])} ${codeOf(x["type"], TYPES)} · ${itemTarget(x["target"], x["slot"])} · ${codeOf(x["reason"], REASONS)} · open ${openFor(x["opened_at"], now)}${x["overdue"] === true ? t` · overdue: past its time, not yet deleted` : []}`,
    );
  }
  const next = str((r as unknown as R)["next_cursor"]);
  if (next !== undefined) out.push(t`next page: the same command with --cursor ${handle(next)}`);
  return [...out, ...warningsAndNotices(r)];
}

/**
 * What taking effect would change (06 §5.1): one line per overwritten segment, filled gap,
 * reverted write and referencing row; `deep` indents them under a candidate.
 */
function impactOf(x: unknown, deep: boolean): Line[] {
  const i = obj(x) as Partial<Record<keyof AwaitingImpact, unknown>>;
  const pre = deep ? t`      ` : t`    `;
  const out: Line[] = [];
  for (const o of arr(i.overwritten)) {
    const s = obj(o);
    const period = isObj(s["valid"]) ? t` ${periodOf(s["valid"])}` : [];
    out.push(
      t`${pre}overwritten: ${fieldOf(s["field"])}${period} ${fieldValue(s["value"])} (${op(s["seq"])}, ${actorOf(s["actor"])})`,
    );
  }
  for (const g of arr(i.filled_gaps)) {
    const s = obj(g);
    const period = isObj(s["valid"]) ? t` ${periodOf(s["valid"])}` : [];
    const by = s["revoked_by"] !== undefined ? t` (no value since ${op(s["revoked_by"])})` : [];
    out.push(t`${pre}a gap filled${period}${by}`);
  }
  for (const w of arr(i.reverted)) {
    const s = obj(w);
    out.push(
      t`${pre}reverted: ${op(s["seq"])} (${actorOf(s["actor"])}) ${join(arr(s["fields"]).map(fieldOf), t`, `)}`,
    );
  }
  for (const ref of arr(i.referrers)) out.push(t`${pre}still referenced by ${targetOf(ref)}`);
  return out;
}

/**
 * A side's values over its spans, or its values. On a state table a stretch without a value is all
 * there is to a revoke (05-time): `no value` there, never `no row`. `no row` when an event or
 * timeless table's row does not exist.
 */
function sideOf(x: R): Part[] {
  const spans = arr(x["spans"]);
  if (x["exists"] === false && spans.length === 0) return t`no row`;
  if (spans.length > 0) {
    return join(
      spans.map((sp) => {
        const s = obj(sp);
        return t`${periodOf(s)} ${s["values"] === null ? t`no value` : namedValues(s["values"])}`;
      }),
      t`; `,
    );
  }
  return namedValues(x["values"]);
}

/** `saveslot pending show <pi_…>` (06 §5.1). */
export function pendingDetail(r: PendingDetailResult, now: Date): Line[] {
  const x = r as unknown as R;
  const type = x["type"];
  const out: Line[] = [
    t`${idOf(x["id"])} ${codeOf(type, TYPES)} · ${itemTarget(x["target"], x["slot"])} · ${codeOf(x["status"], STATUSES)} · open ${openFor(x["opened_at"], now)} · version ${idOf(x["item_ver"])}`,
    t`  opened by ${actorOf(x["opened_by"])}, ${time(String(x["opened_at"] ?? ""))} · reason ${codeOf(x["reason"], REASONS)}`,
  ];
  if (type === "awaiting_confirmation") {
    const p = obj(x["proposal"]);
    const what = isObj(p["revert"])
      ? t`undo ${op(p["revert"]["undo"])}${p["revert"]["include_later"] === true ? t` and what came after` : []}`
      : p["set"] === null
        ? t`revoke`
        : namedValues(p["set"]);
    const period = isObj(p["valid"]) ? t` (${periodOf(p["valid"])})` : [];
    out.push(
      t`  proposed: ${codeOf(p["intent"], INTENTS)} ${what}${period} (${op(p["seq"])}, ${actorOf(p["actor"])})`,
    );
    out.push(t`  in effect now: ${sideOf(obj(x["current"]))}`);
    const impact = impactOf(x["impact"], false);
    if (impact.length > 0) out.push(t`  what taking effect would change:`, ...impact);
    if (x["status"] === "open")
      out.push(t`  the value in effect does not change until it is confirmed`);
  }
  if (type === "conflict") {
    const e = obj(x["effective"]);
    const by = e["seq"] !== undefined ? t` (${op(e["seq"])}, ${actorOf(e["actor"])})` : [];
    out.push(t`  in effect: ${sideOf(e)}${by}`);
    const impacts = obj(x["candidate_impact"]);
    for (const c of arr(x["candidates"])) {
      const cd = obj(c);
      const vals = cd["values"] !== undefined ? namedValues(cd["values"]) : t`no values`;
      const period = isObj(cd["valid"]) ? t` (${periodOf(cd["valid"])})` : [];
      out.push(
        t`  candidate ${count(cd["index"])}: ${codeOf(cd["intent"], INTENTS)} ${vals}${period} (${op(cd["seq"])}, ${actorOf(cd["actor"])}, ${codeOf(cd["cause"], CAUSES)})`,
      );
      const key = String(cd["index"]);
      if (Object.hasOwn(impacts, key)) {
        const lines = impactOf(impacts[key], true);
        if (lines.length > 0) out.push(t`    taking it would change:`, ...lines);
      }
    }
    const prev = obj(x["previous"]);
    out.push(t`  before both: ${sideOf(prev)} (${op(prev["seq"])})`);
    const reverted = arr(x["reverted_by_previous"]);
    if (reverted.length > 0) {
      out.push(t`  take_previous would undo: ${join(reverted.map(revertedWrite), t`; `)}`);
    }
  }
  if (type === "flagged") {
    out.push(
      t`  matched on: ${join(arr(x["keys"]).map(fieldOf), t`, `)}${isObj(x["matched_values"]) ? t` (${namedValues(x["matched_values"])})` : []}`,
    );
    for (const rel of arr(x["related"])) out.push(t`  may duplicate ${targetOf(rel)}`);
  }
  if (type === "schema_change") {
    out.push(
      t`  draft ${idOf(x["draft"])} · to schema v${count(x["target_sv"])} · ${num(arr(x["changes"]).length)} changes`,
    );
    for (const c of arr(x["changes"])) out.push(t`    ${untrusted(JSON.stringify(c))}`);
    out.push(
      t`  impact (an estimate made when the draft was submitted): ${untrusted(JSON.stringify(x["impact"] ?? {}))}`,
    );
  }
  if (type === "deletion") {
    const totals = obj(x["totals"]);
    out.push(
      t`  deletes ${count(totals["sources"])} sources, ${count(totals["rows"])} rows, ${count(totals["derived"])} derived values · can be undone until ${time(String(x["expires_at"] ?? ""))}`,
    );
    for (const st of arr(x["states"])) out.push(t`    ${untrusted(JSON.stringify(st))}`);
  }
  out.push(...closedLines(x));
  const decisions = arr(x["decisions"]).map((d) => [codeOf(d, DECISION)]);
  if (decisions.length > 0) out.push(t`  choices: ${join(decisions, t` / `)}`);
  return [...out, ...warningsAndNotices(r)];
}

/**
 * How a closed item ended (04-contract-types §4.8 ItemResolution): resolved by whom, with which
 * decision, the candidate taken (its index, as --candidate names it) and the note the decision was
 * given (the caller's text, inside the boundary); or executed; or superseded. In an item's details
 * and in the `item_closed` error, whose `resolution` and `superseded` have the same shape.
 */
export function closedLines(x: R): Line[] {
  const out: Line[] = [];
  const res = x["resolution"];
  if (isObj(res)) {
    if (res["executed"] === true) {
      out.push(t`  executed at ${op(res["seq"])}, ${time(String(res["at"] ?? ""))}`);
    } else {
      const note = res["note"] !== undefined ? t` · note ${untrusted(String(res["note"]))}` : [];
      const n = int(res["candidate"]);
      const cand = n !== undefined ? t`, candidate ${num(n)}` : [];
      out.push(
        t`  resolved: ${codeOf(res["decision"], DECISION)}${cand} (${op(res["seq"])}, ${actorOf(res["actor"])})${note}`,
      );
    }
  }
  const sup = x["superseded"];
  if (isObj(sup)) {
    out.push(
      t`  superseded: ${codeOf(sup["reason"], SUPERSEDED)}${sup["by"] !== undefined ? t` by ${op(sup["by"])}` : []}`,
    );
  }
  return out;
}

/** A write take_previous takes back or hides: its operation, its writer and the fields it loses. */
const revertedWrite = (w: unknown): Part[] => {
  const x = obj(w);
  const fields = arr(x["fields"]);
  return t`${op(x["seq"])} (${actorOf(x["actor"])})${fields.length > 0 ? t` ${join(fields.map(fieldOf), t`, `)}` : []}`;
};

/** "1 row" or "3 rows". */
const rowCount = (n: number): Part[] => (n === 1 ? t`1 row` : t`${num(n)} rows`);
/** A verb agreeing with a count: its singular form for 1. */
const one = (n: number, singular: Part[], plural: Part[]): Part[] => (n === 1 ? singular : plural);

/**
 * The rows whose premises a write marked or unmarked (05 §6; 04-contract-types §5.1
 * `PremiseAffected`): those now marked, each once however many of its declarations, the ones not
 * listed (beyond the list, or in tables this credential cannot see) counted; then those whose
 * premises are back to the values declared.
 */
export function premiseAffectedLines(w: R): Line[] {
  if (!isObj(w["premise_affected"])) return [];
  const a = w["premise_affected"];
  const out: Line[] = [];
  const marked = int(a["count"]) ?? 0;
  if (marked > 0) {
    const seen = new Set<string>();
    const listed: Part[][] = [];
    for (const e of arr(a["rows"])) {
      const target = obj(obj(e)["target"]);
      const key = `${String(target["table"])} ${String(target["row"] ?? target["entity"])}`;
      if (seen.has(key)) continue;
      seen.add(key);
      listed.push(targetOf(target));
    }
    const more =
      marked > listed.length ? t` (and ${rowCount(marked - listed.length)} not listed)` : [];
    out.push(
      t`  ${rowCount(marked)} ${one(marked, t`rests`, t`rest`)} on what this changed and now ${one(marked, t`carries`, t`carry`)} "premise changed"${listed.length > 0 ? t`: ${join(listed, t`, `)}` : []}${more}`,
    );
  }
  const matched = int(a["matched"]) ?? 0;
  if (matched > 0) {
    out.push(
      t`  ${rowCount(matched)} ${one(matched, t`rests`, t`rest`)} on premises back to the values declared and no longer ${one(matched, t`carries`, t`carry`)} "premise changed"`,
    );
  }
  return out;
}

/**
 * `saveslot pending resolve` (06 §5.2): the decision and the item's new version; what the write it
 * triggered did (its operation, the derived values that changed, the items it opened or
 * superseded). A replay says that nothing new was recorded.
 */
export function resolveResult(r: ResolveResult): Line[] {
  const x = r as unknown as R;
  if (x["replayed"] === true) {
    return [
      t`${idOf(x["id"])} was already resolved as ${codeOf(x["decision"], DECISION)}; nothing new was recorded`,
      ...warningsAndNotices(r),
    ];
  }
  const out: Line[] = [
    t`${idOf(x["id"])} resolved: ${codeOf(x["decision"], DECISION)} · version ${idOf(x["item_ver"])}`,
  ];
  const w = obj(x["write"]);
  if (w["seq"] !== undefined) {
    out.push(t`  written as ${op(w["seq"])} (${num(arr(w["ops"]).length)} ops)`);
    const derived = arr(w["derived"]);
    if (derived.length > 0)
      out.push(t`  derived values changed: ${num(int(w["derived_total"]) ?? derived.length)}`);
    out.push(...premiseAffectedLines(w));
    for (const p of arr(w["pending"]))
      out.push(t`  opened ${idOf(obj(p)["item"] ?? obj(p)["id"])}`);
    for (const sup of arr(w["superseded"])) {
      const q = obj(sup);
      out.push(t`  superseded ${idOf(q["item"])} (${codeOf(q["reason"], SUPERSEDED)})`);
    }
  }
  // take_previous: the writes it took back or hid, as the item's details listed them.
  const reverted = arr(x["reverted_by_previous"]);
  if (reverted.length > 0) {
    out.push(t`  undid: ${join(reverted.map(revertedWrite), t`; `)}`);
  }
  return [...out, ...warningsAndNotices(r)];
}
