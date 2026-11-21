// Each tool's result as text (docs/zh-CN/spec/05-surfaces.md §4, §6, §7), in English (05 §9
// «语言»): the elements 05 §6 requires, the marks of 05 §4.2, the warnings and notices of 05 §4.3,
// the next steps of 05 §7.
//
// What stands outside the boundary (05 §5): saveslot's wording; what the service itself made
// (IDs, versions, operation numbers, the moments it recorded, counts, the names of slots, tables
// and fields); its own codes, from the constant sets here; a field's value only when JSON gives it
// as a number, a boolean or null, or the number of a quantity. Every string a field holds, every
// name given to a connection or a writer, every message, every code not in its set goes inside,
// whatever it looks like: a string that has the shape of an ID is not therefore the service's.
//
// Lookups are by Map or own property only: a code from a result may be any string, `constructor`
// and `__proto__` among them. A result whose shape a renderer does not know, and a renderer that
// fails, give JSON as written instead: a call always has its text.

import {
  type AffectedReason,
  CHANGE_CLASSES,
  DECISIONS as CONTRACT_DECISIONS,
  FIELD_TYPES as CONTRACT_FIELD_TYPES,
  GRANULARITIES as CONTRACT_GRANULARITIES,
  ITEM_TYPES as CONTRACT_ITEM_TYPES,
  DELETION_ORIGINS,
  ERROR_REASONS,
  type ErrorCode,
  type FieldResultCode,
  HISTORY_MODES,
  ITEM_CREATED_REASONS,
  ITEM_STATUSES,
  type PremiseReason,
  REF_TARGETS,
  ROUNDINGS,
  SCHEMA_CHANGE_CODES,
  SQL_REASONS,
  SUPERSEDED_REASONS,
  TIME_DEPENDENCIES,
  VALIDATION_DETAIL_CODES,
  VERSION_INTENTS,
  type Warning,
  type WriteResult,
} from "@fluxvita/saveslot-contract";
import type { ToolName } from "./names.ts";
import {
  code,
  handle,
  id,
  join,
  type Line,
  localTime,
  name,
  num,
  type Part,
  render,
  renderJson,
  renderTable,
  SHOWN_CHARS,
  t,
  time,
  untrusted,
} from "./text.ts";

type R = Readonly<Record<string, unknown>>;
const isObj = (x: unknown): x is R => typeof x === "object" && x !== null && !Array.isArray(x);
const obj = (x: unknown): R => (isObj(x) ? x : {});
const arr = (x: unknown): readonly unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
const int = (x: unknown): number | undefined =>
  typeof x === "number" && Number.isSafeInteger(x) ? x : undefined;
const own = (o: R, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

/** A shape the renderer relies on; anything else goes to JSON as written. */
function need(ok: boolean): void {
  if (!ok) throw new Error("a result of a shape the renderer does not know");
}

/** The first of `makers` the string is of the shape of, or untrusted. */
function as(v: string, ...makers: readonly ((s: string) => Part)[]): Part {
  for (const make of makers) {
    try {
      return make(v);
    } catch {}
  }
  return untrusted(v);
}

/** A code of the service's from `set`, or untrusted. */
const codeIn = (x: unknown, set: ReadonlySet<string>): Part =>
  typeof x === "string" && set.has(x) ? code(x, set) : untrusted(String(x ?? ""));

/** A sentence of a table, by its code; undefined when the code is not one. */
const said = (table: ReadonlyMap<string, () => Part[]>, x: unknown): Part[] | undefined => {
  const f = typeof x === "string" ? table.get(x) : undefined;
  return f?.();
};

const keysOf = (m: ReadonlyMap<string, unknown>): ReadonlySet<string> => new Set(m.keys());
/**
 * A table of texts by the contract's codes: written as an object `satisfies Record<Code, …>`, so a
 * code the contract adds or drops fails to compile here (no hand-kept list falls behind).
 */
const textsBy = <K extends string>(o: Record<K, () => Part[]>): ReadonlyMap<string, () => Part[]> =>
  new Map(Object.entries(o) as [string, () => Part[]][]);

/** An ID the service made; untrusted when it is not one. */
const idOf = (x: unknown): Part => as(String(x ?? ""), id);
/** A moment the service recorded; untrusted when it is not one. */
const timeOf = (x: unknown): Part => as(String(x ?? ""), time);
/**
 * A moment the service recorded, as the slot's wall clock shows it (05 §4.1: `YYYY-MM-DD HH:mm`
 * in the slot's time zone); as recorded when the zone or the moment is not one this can read.
 */
function inZone(x: unknown, zone: unknown): Part {
  const at = typeof x === "string" ? Date.parse(x) : Number.NaN;
  if (typeof zone !== "string" || Number.isNaN(at)) return timeOf(x);
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
    return as(
      `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`,
      localTime,
    );
  } catch {
    return timeOf(x);
  }
}

/** An operation number. */
const op = (x: unknown): Part[] =>
  t`#${int(x) !== undefined ? num(int(x) as number) : untrusted(String(x))}`;
/** A count or schema version. */
const count = (x: unknown): Part =>
  int(x) !== undefined ? num(int(x) as number) : untrusted(String(x));

/** A table's name, `slot.table` or `table`: names; untrusted when it is not made of names. */
function tableOf(x: unknown): Part[] {
  const s = String(x ?? "");
  const parts = s.split(".");
  if (parts.length <= 2 && parts.every((p) => /^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(p))) {
    return join(
      parts.map((p) => name(p)),
      t`.`,
    );
  }
  return [untrusted(s)];
}

/** A field name; untrusted when it is not one. `*` is a row's being there. */
const fieldOf = (x: unknown): Part[] =>
  x === "*" ? t`whether it exists` : [as(String(x ?? ""), name)];

/** Who did something: the system, or the name it was given (untrusted), and its state. */
function actorOf(x: unknown): Part[] {
  const a = obj(x);
  if (a["kind"] === "system") return t`system`;
  const label = str(a["name"]) ?? str(a["id"]) ?? "";
  const state =
    a["state"] === "revoked" ? t` (revoked)` : a["state"] === "disabled" ? t` (disabled)` : [];
  return [untrusted(label), ...state];
}

/** A stored string: untrusted; the text shows a long one in part and says so (text.ts). */
const stored = (s: string): Part[] => [untrusted(s)];

/**
 * A field's value (05 §4.1, §5): JSON's numbers, booleans and null, and a quantity's number,
 * outside the boundary; every string inside, whatever it looks like.
 */
function fieldValue(v: unknown): Part[] {
  if (v === null || v === undefined) return t`—`;
  if (typeof v === "boolean") return [code(String(v), BOOLEANS)];
  if (typeof v === "number") return [as(String(v), num)];
  if (typeof v === "string") {
    // Shown in part past the text's limit: fields can leave the column out (05 §3).
    return Array.from(v).length > SHOWN_CHARS
      ? t`${untrusted(v)} (fields can leave this column out)`
      : [untrusted(v)];
  }
  if (isObj(v) && Object.hasOwn(v, "value") && Object.hasOwn(v, "unit")) {
    const value = v["value"];
    return t`${typeof value === "string" ? as(value, num) : fieldValue(value)} ${untrusted(String(v["unit"]))}`;
  }
  return stored(JSON.stringify(v));
}

const BOOLEANS: ReadonlySet<string> = new Set(["true", "false"]);

/** Values, in their order: `value | value`. */
const valuesOf = (values: unknown): Part[] =>
  join(
    Object.values(obj(values)).map((v) => fieldValue(v)),
    t` | `,
  );

/** Values with their fields: `field value, field value`. */
const namedValues = (values: unknown): Part[] =>
  join(
    Object.entries(obj(values)).map(([f, v]) => t`${fieldOf(f)} ${fieldValue(v)}`),
    t`, `,
  );

/** The day before a date: the inclusive end of a period that ends at it (05 §4.1). */
function dayBefore(d: string): string {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() - 1);
  return Number.isNaN(x.getTime()) ? d : x.toISOString().slice(0, 10);
}

/** A period of business time (05 §4.1). */
function periodOf(x: unknown): Part[] {
  const p = obj(x);
  const from = p["valid_from"];
  const to = p["valid_to"];
  const last = p["valid_to_inclusive"];
  if (from === null || from === undefined) {
    // Open at the start too: a write-back taking back a revoke of the whole time (09 §1.2).
    if (to === null || to === undefined) return t`all time`;
    return last !== undefined ? t`through ${timeOf(last)} (inclusive)` : t`until ${timeOf(to)}`;
  }
  if (to === null || to === undefined) return t`from ${timeOf(from)}`;
  if (last !== undefined) return t`${timeOf(from)} to ${timeOf(last)} (inclusive)`;
  return t`${timeOf(from)} until ${timeOf(to)}`;
}

/** A row's or entity's reference: its table and ID. */
function targetOf(x: unknown): Part[] {
  const r = obj(x);
  const ref = r["row"] ?? r["entity"];
  return ref !== undefined ? t`${tableOf(r["table"])} ${idOf(ref)}` : tableOf(r["table"]);
}

const AFFECTED = textsBy<AffectedReason>({
  correct: () => t`⚠ a value you read was corrected since`,
  revoke: () => t`⚠ a record in a value you read was revoked since`,
  retroactive: () => t`⚠ the value at the business time you read was changed afterwards`,
  plan_changed: () => t`⚠ the future arrangement you read has changed`,
});
const PREMISE_VERB = textsBy<PremiseReason>({
  correct: () => t`corrected`,
  update: () => t`changed`,
  revoke: () => t`revoked`,
  retroactive: () => t`changed retroactively`,
  plan_changed: () => t`changed for what comes after`,
  deleted: () => t`deleted`,
});

/** A row's marks (05 §4.2), on its line; premises changed, each on a line of its own. */
function marksOf(m: unknown): { inline: Part[][]; below: Line[] } {
  const k = obj(m);
  const inline: Part[][] = [];
  for (const d of arr(k["disputed"])) {
    const x = obj(d);
    inline.push(t`⚠ disputed (${idOf(x["item"])}: ${join(arr(x["fields"]).map(fieldOf), t`, `)})`);
  }
  for (const a of arr(k["awaiting"])) {
    const x = obj(a);
    const what =
      x["proposed"] === null
        ? t`proposed: revoke`
        : isObj(x["proposed_revert"])
          ? t`proposed: undo ${op(x["proposed_revert"]["undo"])}`
          : t`proposed: ${namedValues(x["proposed"])}`;
    inline.push(t`⚠ a change awaiting confirmation (${idOf(x["item"])}): ${what}`);
  }
  for (const f of arr(k["flagged"])) {
    const x = obj(f);
    const related = isObj(x["related"]) ? t`: may duplicate ${targetOf(x["related"])}` : [];
    inline.push(t`⚠ flagged (${idOf(x["item"])})${related}`);
  }
  if (k["corrected"] === true) inline.push(t`corrected`);
  if (isObj(k["revoked"])) inline.push(t`revoked (${op(k["revoked"]["seq"])})`);
  if (isObj(k["possibly_affected"])) {
    const reason = k["possibly_affected"]["reason"];
    inline.push(said(AFFECTED, reason) ?? t`⚠ possibly affected (${untrusted(String(reason))})`);
  }
  if (k["partially_deleted"] === true) inline.push(t`partly deleted`);
  if (isObj(k["pending_deletion"])) {
    inline.push(t`a deletion that can still be undone (${idOf(k["pending_deletion"]["item"])})`);
  }
  for (const r of arr(k["dangling_ref"])) {
    const x = obj(r);
    inline.push(
      t`⚠ ${fieldOf(x["field"])} points to a record that was ${x["state"] === "deleted" ? t`deleted` : t`revoked`}`,
    );
  }
  if (k["computed_at_read"] === true) inline.push(t`computed when read, no ver`);
  const below: Line[] = [];
  for (const p of arr(k["premise_changed"])) {
    const x = obj(p);
    const fields = arr(x["premise_fields"]);
    const what = fields.length > 0 ? t`the ${join(fields.map(fieldOf), t`, `)} of ` : [];
    const verb = said(PREMISE_VERB, x["reason"]) ?? [untrusted(String(x["reason"]))];
    const covers = arr(x["fields"]);
    below.push(
      t`  ⚠ premise changed: ${what}${targetOf(x["premise"])} (seen ${idOf(x["seen"])}) was ${verb} in ${op(x["since"])}${covers.length > 0 ? t`; covers this row's ${join(covers.map(fieldOf), t`, `)}` : t`; covers the whole row`}`,
    );
  }
  const total = int(k["premise_changed_total"]);
  if (total !== undefined) below.push(t`  ${num(total)} premises changed in all`);
  return { inline, below };
}

/** Input marks of a derived row (05 §4.2). */
function inputMarksOf(x: unknown): Part[] {
  if (!isObj(x)) return [];
  const counts: Part[][] = [];
  for (const [k, label] of [
    ["flagged", () => t`flagged`],
    ["disputed", () => t`disputed`],
    ["awaiting", () => t`awaiting confirmation`],
    ["premise_changed", () => t`with a changed premise`],
  ] as const) {
    const n = int(own(x, k));
    if (n !== undefined && n > 0) counts.push(t`${num(n)} ${label()}`);
  }
  // The open items among them, by ID (at most 10, 04-contract-types §3 `InputMarks`).
  const items = arr(own(x, "items"));
  const listed = items.length > 0 ? t` (${join(items.map(idOf), t`, `)})` : [];
  return counts.length > 0 ? t`⚠ among its inputs: ${join(counts, t`, `)}${listed}` : [];
}

/** One row of a read (05 §6 `saveslot_query`). */
function rowLine(row: R, historical = false, first = true): Line[] {
  const m = marksOf(row["marks"]);
  const head: Part[] = [];
  const ref = row["row"] ?? row["entity"] ?? undefined;
  if (first && ref !== undefined) head.push(idOf(ref));
  if (first && row["ver"] !== undefined) {
    head.push(...t` ver=${idOf(row["ver"])}`);
    if (historical) head.push(...t` (a historical version, not for writing)`);
  }
  // A state table's entity by its key, on the entity's first stretch; a derived row's group key.
  if (first && isObj(row["entity_key"])) head.push(...t` ${namedValues(row["entity_key"])}`);
  if (row["key"] !== undefined) head.push(...t` ${namedValues(row["key"])}`);
  const cells: Part[][] = [];
  if (Object.hasOwn(row, "valid_from")) cells.push(periodOf(row));
  const values = valuesOf(row["values"]);
  if (values.length > 0) cells.push(values);
  // Someone else changed it last: the name, inside the untrusted boundary as every writer's is.
  const by =
    first && isObj(row["changed_by"]) ? t`last changed by ${actorOf(row["changed_by"])}` : [];
  const tail = [...m.inline, inputMarksOf(row["input_marks"]), by].filter((x) => x.length > 0);
  const line = join([head.length > 0 ? head : t`  `, ...cells, ...tail], t` | `);
  return [line, ...m.below];
}

/** The rows of a read: an entity's segments together, its ID and ver on the first only. */
function rowsOf(rows: readonly unknown[], historical = false): Line[] {
  const out: Line[] = [];
  let last: unknown;
  for (const r of rows) {
    const row = obj(r);
    const entity = row["entity"];
    const first = entity === undefined || entity !== last;
    last = entity;
    out.push(...rowLine(row, historical, first));
  }
  return out;
}

/** `N of total`, or `N` when the result gives no total. */
const ofTotal = (shown: number, total: unknown): Part[] =>
  int(total) !== undefined ? t`${num(shown)} of ${num(int(total) as number)}` : t`${num(shown)}`;

/**
 * The page's end (05 §4.2 `truncated`): shown of the result's own total, and the next page's
 * handle, as the service signed it.
 */
function pageOf(r: R, shown: number, unit: () => Part[]): Line[] {
  const next = str(r["next_cursor"]);
  if (next === undefined && !isObj(r["truncated"])) return [];
  return [
    t`Showing ${ofTotal(shown, r["total"])} ${unit()}${next !== undefined ? t`; next page: cursor=${as(next, handle)}` : []}; or narrow the request (a date range, fewer fields)`,
  ];
}

const WARNINGS = textsBy<Warning["code"]>({
  // What to do the next time (05 §4.3): over MCP an op cannot say which segment backs which field.
  multi_segment_unmapped: () =>
    t`this op cites several evidence segments, so each field takes them all as its source; next time, give each op only the segments its values come from (evidence_refs)`,
  unit_converted: () => t`converted to the field's unit`,
  rounded: () => t`rounded to the field's precision`,
  timezone_assumed: () => t`a moment without a zone was taken in the slot's time zone`,
  time_truncated: () => t`the time was cut to the table's granularity`,
  ver_fallback: () => t`no ver was given: the one you last read was used`,
  sv_fallback: () => t`no sv was given: the one you last read was used`,
  item_ver_fallback: () => t`no item_ver was given: the one you last read was used`,
  renamed: () => t`a field was renamed`,
  overwrote_corroborated: () => t`a value corroborated by other evidence was overwritten`,
  pending_deletion_on_target: () => t`the row has a deletion that can still be undone`,
  clock_behind_log: () =>
    t`this machine's clock is behind the log's end; the time recorded is the log's end`,
  evidence_unreferenced: () =>
    t`an evidence segment is cited by no op: stored as source data, but no value comes from it`,
  evidence_not_stored: () => t`nothing was recorded, and the evidence was not stored`,
  premise_ver_fallback: () => t`a premise without ver: the one you last read was used`,
  premise_already_changed: () =>
    t`a premise had changed since you read it; the row carries "premise changed"`,
  external_key_skipped: () => t`some ops were skipped`,
  external_key_resync: () =>
    t`rows lose their source key: a connector syncing the same record again adds another row`,
  single_field_external_key: () =>
    t`the source key has one field: IDs from several source systems may collide`,
  group_key_free_text: () =>
    t`a derived table groups by a free-text field: deleting it clears the whole group`,
});

/** Where a fallback version came from (04-contract-types §7 `FallbackOrigin`). */
function originOf(w: R): Part[] {
  if (w["read"] !== undefined) return t`the one you last read (${idOf(w["read"])})`;
  if (w["from_write"] !== undefined) return t`the one your receipt of ${op(w["from_write"])} gave`;
  return t`the one your own last write gave`;
}

/**
 * A warning with what it carries (05 §4.3), for the codes this version gives; undefined for the
 * others, which are said by WARNINGS alone.
 */
function warningDetail(w: R): Part[] | undefined {
  const c = w["code"];
  if (c === "unit_converted") {
    const from = obj(w["from"]);
    const to = obj(w["to"]);
    return t`${fieldOf(w["field"])} converted: ${fieldValue({ value: from["value"], unit: from["unit"] })} → ${fieldValue({ value: to["value"], unit: to["unit"] })}`;
  }
  if (c === "multi_segment_unmapped") {
    const fields = arr(w["fields"]).map((f) => fieldOf(f));
    return t`${join(fields, t`, `)}: ${said(WARNINGS, c) as Part[]}`;
  }
  if (c === "rounded") {
    return t`${fieldOf(w["field"])} rounded to ${count(w["scale"])} decimal places: ${as(String(w["from"] ?? ""), num)} → ${as(String(w["to"] ?? ""), num)}`;
  }
  if (c === "timezone_assumed") {
    const where =
      w["field"] !== undefined
        ? t`${fieldOf(w["field"])}: `
        : w["param"] !== undefined
          ? t`${untrusted(String(w["param"]))}: `
          : [];
    return t`${where}a moment without a time zone was taken in ${untrusted(String(w["timezone"] ?? ""))}`;
  }
  if (c === "time_truncated") {
    return t`${untrusted(String(w["param"] ?? ""))}: the table records by day; ${timeOf(w["from"])} was taken as ${timeOf(w["to"])}`;
  }
  if (c === "ver_fallback") {
    return t`no ver was given; ${idOf(w["ver"])} was used, ${originOf(w)}`;
  }
  if (c === "sv_fallback") {
    return t`no sv was given; schema v${count(w["sv"])} was used, ${originOf(w)}`;
  }
  if (c === "item_ver_fallback") {
    return t`no item_ver was given; ${idOf(w["item_ver"])} was used, ${originOf(w)}`;
  }
  if (c === "clock_behind_log") {
    return t`this machine's clock is ${behindBy(w["behind_seconds"])} behind the log's end; the time recorded is the log's end`;
  }
  if (c === "evidence_unreferenced") {
    const segments = arr(w["evidence"]).map((i) => [count(i)]);
    return segments.length === 1
      ? t`evidence segment ${join(segments, t`, `)} is cited by no op: stored as source data, but no value comes from it`
      : t`evidence segments ${join(segments, t`, `)} are cited by no op: stored as source data, but no value comes from them`;
  }
  return undefined;
}

/** How far behind (04-contract-types §7 `clock_behind_log`): seconds, minutes or hours, rounded. */
function behindBy(x: unknown): Part[] {
  const s = int(x);
  if (s === undefined) return [untrusted(String(x))];
  if (s < 60) return t`${num(s)} s`;
  if (s < 2 * 3600) return t`${num(Math.round(s / 60))} min`;
  return t`${num(Math.round(s / 3600))} h`;
}

/**
 * A notice (05 §4.3): `pending_items` as a sentence; the codes this version does not give are
 * shown as written, inside the boundary.
 */
function noticeLine(n: R, now: Date): Line {
  if (n["code"] === "pending_items") {
    const items = int(n["count"]) === 1 ? t`1 pending item` : t`${count(n["count"])} pending items`;
    return t`Notice: ${tableOf(n["slot"])} has ${items}, the oldest open for ${openFor(n["oldest_opened_at"], now)} (saveslot_pending shows them)`;
  }
  return t`Notice: ${untrusted(JSON.stringify(n))}`;
}

/** The ops a merged warning names at most; the rest are counted. */
const OPS_NAMED = 5;

/**
 * Warnings and notices (05 §4.3): one line each; notices at most 3. Warnings of one code on one
 * field (or none) are one line, with how many and which ops: a long write would otherwise give a
 * line for each op. The line gives their detail when it is the same for all of them; otherwise the
 * code's own sentence and the field, so that no one warning's values stand for the others'.
 */
function remindersOf(r: R, now: Date): Line[] {
  const out: Line[] = [];
  const groups = new Map<string, R[]>();
  for (const w of arr(r["warnings"]).map(obj)) {
    const k = JSON.stringify([String(w["code"]), w["field"] ?? null]);
    groups.set(k, [...(groups.get(k) ?? []), w]);
  }
  for (const ws of groups.values()) {
    const first = ws[0] as R;
    const c = first["code"];
    const known = said(WARNINGS, c) !== undefined;
    if (!known) {
      for (const _ of ws) out.push(t`Note: ${untrusted(String(c))}`);
      continue;
    }
    if (ws.length === 1) {
      const at = int(first["op"]);
      const text = warningDetail(first) ?? (said(WARNINGS, c) as Part[]);
      out.push(
        t`Note (${codeIn(c, keysOf(WARNINGS))}${at !== undefined ? t`, op ${num(at)}` : []}): ${text}`,
      );
      continue;
    }
    // The same detail for all of them, as each would be drawn: drawn once.
    const drawn = ws.map((w) => {
      const d = warningDetail(w);
      // Each drawing has a boundary number of its own: compared without it.
      return d === undefined
        ? undefined
        : render([d]).replace(/untrusted-data-[0-9a-f]{32}/g, "untrusted-data");
    });
    const same = drawn[0] !== undefined && drawn.every((d) => d === drawn[0]);
    const text = same
      ? (warningDetail(first) as Part[])
      : first["field"] !== undefined
        ? t`${fieldOf(first["field"])}: ${said(WARNINGS, c) as Part[]}`
        : (said(WARNINGS, c) as Part[]);
    const ops = ws.map((w) => int(w["op"])).filter((n): n is number => n !== undefined);
    const named = ops.slice(0, OPS_NAMED).map((n) => [num(n)]);
    const more = ops.length > OPS_NAMED ? t` and ${num(ops.length - OPS_NAMED)} more` : [];
    const which = ops.length > 0 ? t`: ${join(named, t`, `)}${more}` : [];
    out.push(
      t`Note (${codeIn(c, keysOf(WARNINGS))}, ${num(ws.length)} times${ops.length > 0 ? t`, ops` : []}${which}): ${text}`,
    );
  }
  for (const n of arr(r["notices"]).slice(0, 3)) out.push(noticeLine(obj(n), now));
  return out;
}

const FIELD_TYPES: ReadonlySet<string> = new Set<string>(CONTRACT_FIELD_TYPES);
const GRANULARITIES: ReadonlySet<string> = new Set<string>(CONTRACT_GRANULARITIES);

// --- catalog -----------------------------------------------------------------------------------

/** A table's kind and time type, as a catalog or a schema document gives them. */
function tableKind(tb: R): Part[] {
  const tm = obj(tb["time"]);
  return tb["kind"] === "derived"
    ? t`derived · read-only`
    : tm["type"] === "event"
      ? t`base · event, by ${fieldOf(tm["field"])}`
      : tm["type"] === "state"
        ? t`base · state, by ${codeIn(tm["granularity"], GRANULARITIES)}`
        : t`base · without time`;
}

/** The tables of a catalog's list page. */
const tablesIn = (r: R) =>
  arr(r["slots"]).reduce<number>((n, s) => n + arr(obj(s)["tables"]).length, 0);

const ROUNDING: ReadonlySet<string> = new Set<string>(ROUNDINGS);
const REF_TARGET: ReadonlySet<string> = new Set<string>(REF_TARGETS);

/** ` · aliases: …` for a table or field that has aliases: stored text of the schema's author. */
function aliasesOf(v: unknown): Line {
  const aliases = arr(v);
  return aliases.length > 0
    ? t` · aliases: ${join(
        aliases.map((a) => untrusted(String(a))),
        t`, `,
      )}`
    : [];
}

/**
 * One field of a catalog table (05 §6 `saveslot_catalog` `table`): its name, type, unit, places
 * and rounding, description, whether required, its range, its values, what it refers to.
 */
function catalogField(fd: R): Line {
  const unit = fd["unit"] !== undefined ? t` ${untrusted(String(fd["unit"]))}` : [];
  const p = obj(fd["precision"]);
  const scale = int(p["scale"]);
  const rounding = p["rounding"] !== undefined ? t` (${codeIn(p["rounding"], ROUNDING)})` : [];
  const decimals = scale !== undefined ? t` ${num(scale)} decimal places${rounding}` : [];
  const required = fd["required"] === true ? t` · required` : [];
  // Bounds as the schema gives them: decimal strings, shown as numbers when they are numbers.
  const min = fd["min"] !== undefined ? t` · ≥ ${as(String(fd["min"]), num)}` : [];
  const max = fd["max"] !== undefined ? t` · ≤ ${as(String(fd["max"]), num)}` : [];
  const values = arr(fd["values"]);
  const oneOf =
    values.length > 0
      ? t` · one of ${join(
          values.map((v) => [untrusted(String(v))]),
          t`, `,
        )}`
      : [];
  const ref = obj(fd["ref"]);
  const refers = isObj(fd["ref"])
    ? t` · refers to ${tableOf(ref["table"])} (${codeIn(ref["target"], REF_TARGET)})`
    : [];
  return t`  ${fieldOf(fd["name"])}  ${codeIn(fd["type"], FIELD_TYPES)}${unit}${decimals}  ${stored(String(fd["description"] ?? ""))}${aliasesOf(fd["aliases"])}${required}${min}${max}${oneOf}${refers}`;
}

/**
 * A table's data profile (05 §3 `saveslot_catalog`): ` · 132 rows · 2026-03-02 to 2026-11-08`, and
 * after it, as a fact, the scale hint when the table has one: the lines are the ones the result
 * gives (no thousands separators, 05 §4.1). Nothing is said of a table without a profile.
 */
function profileOf(tb: R): Part[] {
  if (!isObj(tb["profile"])) return [];
  const p = tb["profile"];
  const range = obj(p["time_range"]);
  const tm = obj(tb["time"]);
  // An event table's range: both ends are values of the time field (instants as the slot's wall
  // clock, 05 §4.1). A state table's: the period of 05 §4.1, its `to` exclusive.
  const at = (x: unknown) =>
    typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) ? timeOf(x) : inZone(x, tb["timezone"]);
  const span = !isObj(p["time_range"])
    ? []
    : tm["type"] === "state"
      ? t` · ${periodOf({
          valid_from: range["from"],
          valid_to: range["to"] ?? null,
          ...(tm["granularity"] === "date" && typeof range["to"] === "string"
            ? { valid_to_inclusive: dayBefore(range["to"]) }
            : {}),
        })}`
      : t` · ${at(range["from"])} to ${at(range["to"])}`;
  const scale = obj(p["scale"]);
  const hint =
    scale["level"] === "large"
      ? t` · many rows (over ${count(scale["comfortable_rows"])}): writes and derived-table refreshes on this table are slower than on a small table`
      : scale["level"] === "beyond_tested"
        ? t` · beyond the tested range (tested up to ${count(scale["tested_rows"])} rows): writes, derived-table refreshes and reads at a past time may be much slower`
        : [];
  return t` · ${count(p["rows"])} rows${span}${hint}`;
}

function catalog(r: R, now: Date): Line[] | { json: true; lead: Line[] } {
  need(
    (r["level"] === "schema" && isObj(r["document"])) ||
      (r["level"] === "table" && Array.isArray(r["tables"])) ||
      Array.isArray(r["slots"]),
  );
  if (r["level"] === "schema") {
    return {
      json: true,
      lead: [
        // Changing a slot comes with 07-scope-v1 P4; then this line goes on: "To change the
        // schema, edit the document and submit it without the tags." (05 §9 «这一版不出现的句子»)
        t`${tableOf(r["slot"])} · schema v${count(r["sv"])}: the full schema document and the slot's policy (read-only), as JSON.`,
      ],
    };
  }
  if (r["level"] === "table") {
    const out: Line[] = [];
    for (const x of arr(r["tables"])) {
      const tb = obj(x);
      const kind = tableKind(tb);
      out.push(
        t`${tableOf(tb["slot"])} · schema v${count(tb["sv"])} · ${untrusted(String(tb["timezone"] ?? ""))}`,
      );
      // A derived table's rule: its ID and version, and the base fields it depends on.
      const rule = obj(tb["rule"]);
      const ruled = isObj(tb["rule"])
        ? t` · rule ${as(String(rule["id"] ?? ""), name)} v${count(rule["version"])}${
            arr(rule["depends_on"]).length > 0
              ? t` · depends on ${join(arr(rule["depends_on"]).map(tableOf), t`, `)}`
              : []
          }`
        : [];
      out.push(
        t`${tableOf(tb["table"])} (${kind}) ${stored(String(tb["description"] ?? ""))}${aliasesOf(tb["aliases"])}${ruled}${profileOf(tb)}`,
      );
      const key = arr(tb["entity_key"]);
      if (key.length > 0) out.push(t`  entity key: ${join(key.map(fieldOf), t`, `)}`);
      for (const f of arr(tb["fields"])) out.push(catalogField(obj(f)));
      // What the table declares, as declared, and that this version does not check it (the
      // check, `flagged`, comes with P2: 07-scope-v1). Drop the parenthesis when it does.
      for (const g of arr(tb["duplicate_keys"])) {
        out.push(
          t`  duplicate keys declared: ${join(arr(g).map(fieldOf), t` + `)} (not checked in this version: a second row with the same values is saved and not flagged)`,
        );
      }
      for (const g of arr(tb["together"])) {
        out.push(t`  field group (one conflict unit): ${join(arr(g).map(fieldOf), t` + `)}`);
      }
    }
    return [...out, ...remindersOf(r, now)];
  }
  const out: Line[] = [];
  for (const s of arr(r["slots"])) {
    const slot = obj(s);
    out.push(
      t`${tableOf(slot["slot"])} · schema v${count(slot["sv"])} · ${untrusted(String(slot["timezone"] ?? ""))}`,
    );
    for (const x of arr(slot["tables"])) {
      const tb = obj(x);
      const kind = tb["kind"] === "derived" ? t`derived · read-only` : t`base`;
      out.push(
        t`  ${tableOf(tb["table"])} (${kind}) ${stored(String(tb["description"] ?? ""))}${aliasesOf(tb["aliases"])}`,
      );
    }
  }
  if (out.length === 0) out.push(t`No slots yet.`);
  return [...out, ...pageOf(r, tablesIn(r), () => t`tables`), ...remindersOf(r, now)];
}

// --- query and history --------------------------------------------------------------------------

/**
 * The entity a page of a state table's rows is all of, by its key (05 §6 `saveslot_query`: 实体);
 * undefined when the page holds more than one entity, or rows without one. The business range the
 * read asked for is not in the result, so the first line does not say it.
 */
function oneEntity(rows: readonly unknown[]): unknown {
  const entities = new Set(rows.map((x) => obj(x)["entity"]));
  const first = obj(rows[0]);
  return entities.size === 1 && first["entity"] !== undefined && isObj(first["entity_key"])
    ? first["entity_key"]
    : undefined;
}

function query(r: R, now: Date): Line[] {
  need(Array.isArray(r["rows"]) && typeof r["table"] === "string");
  const rows = arr(r["rows"]);
  const entity = oneEntity(rows);
  return [
    t`${tableOf(r["table"])} · ${tableOf(r["slot"])} schema v${count(r["sv"])}${entity !== undefined ? t` · entity ${namedValues(entity)}` : []} · ${ofTotal(rows.length, r["total"])} rows`,
    ...rowsOf(rows),
    ...pageOf(r, rows.length, () => t`rows`),
    ...remindersOf(r, now),
  ];
}

/** The marks over the rows a statement read (05 §6 `saveslot_sql`): how many, and where to look. */
function sqlMarksOf(x: unknown): Line[] {
  if (!isObj(x)) return [];
  const counts: Part[][] = [];
  for (const [k, label] of [
    ["disputed", () => t`disputed`],
    ["awaiting", () => t`awaiting confirmation`],
    ["flagged", () => t`flagged`],
    ["premise_changed", () => t`with a changed premise`],
    ["possibly_affected", () => t`possibly affected since this connection read them`],
  ] as const) {
    const n = int(own(x, k));
    if (n !== undefined && n > 0) counts.push(t`${num(n)} ${label()}`);
  }
  const lines: Line[] = [];
  if (counts.length > 0) {
    const items = arr(own(x, "items"));
    const listed = items.length > 0 ? t` (${join(items.map(idOf), t`, `)})` : [];
    lines.push(
      t`⚠ Among the rows this result read: ${join(counts, t`, `)}${listed}. To look at them row by row, use saveslot_query.`,
    );
  }
  if (own(x, "partially_deleted") === true) {
    lines.push(
      t`⚠ Part of the data at this instant has since been deleted; the result leaves it out.`,
    );
  }
  return lines;
}

/**
 * `saveslot_sql` (05 §4, §6): the slots read with their schema versions, the marks over the rows
 * read, then the table inside one boundary: the columns (a quantity's with its unit) and a line
 * per row. No next page over MCP (05 §3): when there are more rows, the text says so.
 */
function sql(r: R, now: Date): Table {
  need(isObj(r["sv"]) && Array.isArray(r["columns"]) && Array.isArray(r["rows"]));
  const columns = arr(r["columns"]).map(obj);
  const rows = arr(r["rows"]);
  need(rows.every((x) => Array.isArray(x) && x.length === columns.length));
  need(columns.every((c) => typeof c["name"] === "string"));
  const slots = Object.entries(obj(r["sv"])).map(([s, v]) => t`${tableOf(s)} schema v${count(v)}`);
  const more = r["next_cursor"] !== undefined || isObj(r["truncated"]);
  const total = int(r["total"]);
  // Without a total the count shown must not read as all of them (05 §6).
  const shown =
    more && total === undefined ? t`the first ${num(rows.length)}` : ofTotal(rows.length, total);
  return {
    table: true,
    lead: [t`${join(slots, t`, `)} · ${shown} rows`, ...sqlMarksOf(r["marks_summary"])],
    header: columns.map((c) => {
      const unit = str(c["unit"]);
      return unit !== undefined ? `${String(c["name"])} (${unit})` : String(c["name"]);
    }),
    rows: rows as readonly (readonly unknown[])[],
    tail: [
      ...(more
        ? [
            total !== undefined
              ? t`Showing the first ${num(rows.length)} of ${num(total)} rows. Add conditions or aggregate (max_rows is at most 1,000).`
              : t`Showing the first ${num(rows.length)} rows; there are more. Add conditions or aggregate (max_rows is at most 1,000).`,
          ]
        : []),
      ...remindersOf(r, now),
    ],
  };
}

/** A version's intent (04-contract-types §5.1 `VersionIntent`). */
const INTENTS: ReadonlySet<string> = new Set<string>(VERSION_INTENTS);

const RESULT = textsBy<FieldResultCode>({
  applied: () => t``,
  candidate: () => t` (candidate, not in effect)`,
  awaiting: () => t` (awaiting confirmation, not in effect)`,
  corroborated: () => t` (unchanged; added as evidence)`,
  noop: () => t` (unchanged)`,
});
const resultOf = (x: unknown): Part[] =>
  said(RESULT, x ?? "applied") ?? t` (${untrusted(String(x))})`;

/** The sources of a change: IDs and, when expanded, the words (untrusted). */
function sourcesOf(x: unknown): Part[] {
  const s = obj(x);
  const parts: Part[][] = [];
  for (const v of arr(s["value"])) {
    const src = obj(v);
    const text = src["text"] !== undefined ? t` ${stored(String(src["text"]))}` : [];
    parts.push(t`${idOf(src["id"])}${src["correction"] === true ? t` (correction)` : []}${text}`);
  }
  for (const v of arr(s["operation"])) parts.push(t`operation ${idOf(obj(v)["id"])}`);
  return parts.length > 0 ? t`  source ${join(parts, t`; `)}` : [];
}

/**
 * How a write came about, when not by a plain write (05 §6 `saveslot_history`: 由 resolve、撤回触发的
 * 写明来由): resolving an item with a decision, or undoing an operation. Any other shape is shown as
 * written, inside the boundary.
 */
function viaOf(x: unknown): Part[] {
  if (x === undefined) return [];
  const v = obj(x);
  if (Object.hasOwn(v, "resolve") && Object.keys(v).length === 2 && Object.hasOwn(v, "decision")) {
    return t`, resolving ${idOf(v["resolve"])} with ${codeIn(v["decision"], DECISIONS)}`;
  }
  if (Object.hasOwn(v, "undo") && Object.keys(v).length === 1) return t`, undoing ${op(v["undo"])}`;
  return t`, by ${stored(JSON.stringify(x))}`;
}

/**
 * An entry's intent and how it came about. An undo records the caller's intent, or the undone
 * write's when the caller gave none (09-event-format), so "revoke" alone could read as a revoke
 * where the row came back: an undo leads with what it undoes, and says the intent is as recorded.
 */
function intentOf(x: R): Part[] {
  const v = obj(x["via"]);
  if (Object.hasOwn(v, "undo") && Object.keys(v).length === 1) {
    return t`undo of ${op(v["undo"])} (recorded as ${codeIn(x["intent"], INTENTS)})`;
  }
  return t`${codeIn(x["intent"], INTENTS)}${viaOf(x["via"])}`;
}

function history(r: R, now: Date): Line[] {
  if (r["mode"] === "changes") return changesOf(r, now);
  need(Array.isArray(r["entries"]) || (r["mode"] === "as_of" && Array.isArray(r["rows"])));
  if (r["mode"] === "as_of") {
    const at = obj(r["as_of"]);
    const rows = arr(r["rows"]);
    return [
      t`As of ${op(at["seq"])} (${inZone(at["recorded_at"], r["timezone"])}) · schema v${count(r["sv"])}`,
      ...(rows.length > 0 ? rowsOf(rows, true) : [t`It did not exist yet.`]),
      ...pageOf(r, rows.length, () => t`rows`),
      ...remindersOf(r, now),
    ];
  }
  const entries = arr(r["entries"]);
  const out: Line[] = [
    t`${targetOf(r["target"])} · current ver=${idOf(r["ver"])} · ${ofTotal(entries.length, r["total"])} changes`,
  ];
  for (const e of entries) {
    const x = obj(e);
    // A field changed over several stretches of a state table is an array: one part per stretch.
    const fields = Object.entries(obj(x["fields"])).map(([f, v]) =>
      join(
        (Array.isArray(v) ? v : [v]).map((p) => {
          const c = obj(p);
          const change = Object.hasOwn(c, "before")
            ? t`${fieldValue(c["before"])} → ${fieldValue(c["after"])}`
            : fieldValue(c["after"]);
          const period = isObj(c["valid"]) ? t` (${periodOf(c["valid"])})` : [];
          return t`${fieldOf(f)} ${change}${period}${resultOf(c["result"])}${sourcesOf(c["sources"])}`;
        }),
        t`; `,
      ),
    );
    // The widest interval of the write (05 §4.3), on state tables.
    const period = isObj(x["valid"]) ? t` (${periodOf(x["valid"])})` : [];
    out.push(
      t`${op(x["seq"])} ${inZone(x["recorded_at"], r["timezone"])} ${intentOf(x)}${period}  ${actorOf(x["actor"])}  ${fields.length > 0 ? join(fields, t`; `) : t`no change`}`,
    );
  }
  const reads = arr(r["reads"]);
  if (reads.length > 0) {
    out.push(
      t`Read by: ${join(
        reads.map((x) => {
          const rd = obj(x);
          const task = rd["task"] !== undefined ? t` · task ${untrusted(String(rd["task"]))}` : [];
          return t`${idOf(rd["read"])} (${op(rd["seq"])}) · ${actorOf(rd["actor"])}${task} · ${inZone(rd["at"], r["timezone"])}`;
        }),
        t`; `,
      )}`,
    );
  }
  return [...out, ...pageOf(r, entries.length, () => t`changes`), ...remindersOf(r, now)];
}

/**
 * `saveslot_history` with `mode: "changes"` (05 §6): the range, then each change on a line of its own,
 * newest first: operation, moment, intent, who, which row, and the fields that changed with their
 * values before and after. A revoke or taking one back is `revoked` / `restored`, not a value.
 */
function changesOf(r: R, now: Date): Line[] {
  need(Array.isArray(r["changes"]) && typeof int(r["since"]) === "number");
  const list = arr(r["changes"]);
  const range =
    r["since"] === 0
      ? t`from the start to ${op(r["until"])}`
      : t`after ${op(r["since"])} up to ${op(r["until"])}`;
  const out: Line[] = [
    t`${targetOf(r["target"])} · ${range} · ${ofTotal(list.length, r["total"])} changes`,
  ];
  if (list.length === 0 && r["total"] === 0) out.push(t`No changes.`);
  for (const e of list) {
    const x = obj(e);
    const fields = Object.entries(obj(x["fields"])).map(([f, v]) =>
      join(
        (Array.isArray(v) ? v : [v]).map((p) => {
          const c = obj(p);
          const period = isObj(c["valid"]) ? t` (${periodOf(c["valid"])})` : [];
          if (f === "*") return t`${c["before"] === true ? t`revoked` : t`restored`}${period}`;
          const change = Object.hasOwn(c, "before")
            ? t`${fieldValue(c["before"])} → ${fieldValue(c["after"])}`
            : fieldValue(c["after"]);
          return t`${fieldOf(f)} ${change}${period}`;
        }),
        t`; `,
      ),
    );
    const target = obj(x["target"]);
    out.push(
      t`${op(x["seq"])} ${inZone(x["recorded_at"], r["timezone"])} ${codeIn(x["intent"], INTENTS)}  ${actorOf(x["actor"])}  ${idOf(target["row"] ?? target["entity"])}  ${join(fields, t`; `)}`,
    );
  }
  return [...out, ...pageOf(r, list.length, () => t`changes`), ...remindersOf(r, now)];
}

// --- pending ------------------------------------------------------------------------------------

const ITEM_TYPES: ReadonlySet<string> = new Set<string>(CONTRACT_ITEM_TYPES);
/** 04-contract-types §4.8 `ItemReason`: the reasons an item is opened with, and a deletion's origins. */
const ITEM_REASONS: ReadonlySet<string> = new Set<string>([
  ...ITEM_CREATED_REASONS,
  ...DELETION_ORIGINS,
]);
const ITEM_STATUS: ReadonlySet<string> = new Set<string>(ITEM_STATUSES);
const DECISIONS: ReadonlySet<string> = new Set<string>(CONTRACT_DECISIONS);
const reasonOf = (x: unknown): Part[] => (x === undefined ? [] : t` · ${codeIn(x, ITEM_REASONS)}`);

/**
 * What an item is about: its target, or its slot when it has none (a `schema_change` item is the
 * slot's schema as a whole).
 */
const itemWhere = (x: R): Part[] =>
  x["target"] !== undefined ? itemTarget(x["target"]) : t`slot ${tableOf(x["slot"])}`;

/** An item's reason, unless it only says the item's type again (`schema_change`). */
const itemReason = (x: R): Part[] => (x["reason"] === x["type"] ? [] : reasonOf(x["reason"]));

function itemTarget(x: unknown): Part[] {
  const tg = obj(x);
  const unit = arr(tg["unit"]);
  return t`${targetOf(tg)}${unit.length > 0 ? t` ${join(unit.map(fieldOf), t`, `)}` : []}`;
}

/**
 * What carrying out an item would change (04-contract-types `AwaitingImpact`; 05 §6
 * `saveslot_pending`, `saveslot_write`): the stretches it would overwrite, the gaps it would fill,
 * the writes it would undo; one line each, indented by `pad`. In a receipt's awaiting or candidate
 * part, an item's detail, and a conflict's candidates alike. A kind this version does not know is
 * still shown, as written, inside the boundary.
 */
function impactLines(x: unknown, pad: string): Line[] {
  const im = obj(x);
  const out: Line[] = [];
  const indent = (l: Part[]): Line => [...padded(pad), ...l];
  const seen = new Set<string>();
  const once = (k: string, v: unknown) => {
    const key = `${k} ${JSON.stringify(v)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  for (const o of arr(own(im, "overwritten"))) {
    const e = obj(o);
    if (!once("overwritten", e)) continue;
    const period = isObj(e["valid"]) ? t`${periodOf(e["valid"])}: ` : [];
    out.push(
      indent(
        t`overwrite ${period}${fieldOf(e["field"])} ${fieldValue(e["value"])} (${op(e["seq"])}, ${actorOf(e["actor"])})`,
      ),
    );
  }
  for (const g of arr(own(im, "filled_gaps"))) {
    const e = obj(g);
    if (!once("filled_gaps", e)) continue;
    const period = isObj(e["valid"]) ? periodOf(e["valid"]) : t`the whole time`;
    const why = e["revoked_by"] !== undefined ? t` (revoked by ${op(e["revoked_by"])})` : [];
    out.push(indent(t`fill ${period}, which has no value${why}`));
  }
  for (const v of arr(own(im, "reverted"))) {
    const e = obj(v);
    if (!once("reverted", e)) continue;
    out.push(
      indent(
        t`undo ${op(e["seq"])} (${actorOf(e["actor"])}): ${join(arr(e["fields"]).map(fieldOf), t`, `)}`,
      ),
    );
  }
  for (const [k, v] of Object.entries(im)) {
    if (k === "overwritten" || k === "filled_gaps" || k === "reverted") continue;
    out.push(indent(t`${untrusted(k)}: ${stored(JSON.stringify(v))}`));
  }
  return out;
}

/**
 * The head of an impact: "Carrying it out would:" over its lines. With nothing listed, an undo
 * says that confirming it records the undo and changes no value read now; anything else says
 * nothing more.
 */
function impactHead(lines: Line[], isUndo: boolean): Line[] {
  if (lines.length > 0) return [t`  Carrying it out would:`, ...lines];
  return isUndo ? [t`  Confirming it records this undo; no value read now changes.`] : [];
}

/**
 * Whose writes confirming an item would undo (an impact's `reverted`), as a sentence to tell the
 * user: each write's operation, writer and fields. None when it undoes no write.
 */
function revertedTell(x: unknown): Line[] {
  const reverted = arr(own(obj(x), "reverted"));
  if (reverted.length === 0) return [];
  return [
    t`  Tell the user that confirming it undoes ${join(
      reverted.map((v) => {
        const e = obj(v);
        return t`${op(e["seq"])} by ${actorOf(e["actor"])} (${join(arr(e["fields"]).map(fieldOf), t`, `)})`;
      }),
      t`; `,
    )}.`,
  ];
}

/** A write take_previous takes back or hides: its operation, its writer and the fields it loses. */
const revertedWrite = (w: unknown): Part[] => {
  const x = obj(w);
  const fields = arr(x["fields"]);
  return t`${op(x["seq"])} (${actorOf(x["actor"])})${fields.length > 0 ? t`: ${join(fields.map(fieldOf), t`, `)}` : []}`;
};

/** Spaces before a line's text: saveslot's own. */
function padded(pad: string): Part[] {
  if (pad === "    ") return t`    `;
  if (pad === "      ") return t`      `;
  return t`  `;
}

/** The proposal of an awaiting item (04-contract-types §4.8 `proposal`): what it would write. */
function proposalOf(x: unknown): Part[] {
  const p = obj(x);
  const what = isObj(p["revert"])
    ? t`undo ${op(obj(p["revert"])["undo"])}`
    : p["set"] !== undefined
      ? namedValues(p["set"])
      : t`revoke`;
  const period = isObj(p["valid"]) ? t` ${periodOf(p["valid"])}` : [];
  return t`${what}${period} (${op(p["seq"])}, ${actorOf(p["actor"])}, ${codeIn(p["intent"], INTENTS)})`;
}

/**
 * How long an item has been open (05 §6 `saveslot_pending`: 已挂多久): whole minutes, hours, or
 * days from 48 hours on; as recorded when the moment is not one this can read.
 */
function openFor(opened: unknown, now: Date): Part[] {
  const at = typeof opened === "string" ? Date.parse(opened) : Number.NaN;
  if (Number.isNaN(at)) return [timeOf(opened)];
  const minutes = Math.max(0, Math.floor((now.getTime() - at) / 60_000));
  if (minutes < 60) return t`${num(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t`${num(hours)} h`;
  return t`${num(Math.floor(hours / 24))} d`;
}

/**
 * A side of an item (its effective side, the merge base, an awaiting item's current values): a
 * state table's by stretch, each with the write that gave it when the stretch says so; other
 * tables' by field. `no value` for a stretch without one: on a state table a stretch without a value
 * is all there is to a revoke (05-time), so the entity is never `no row` there. `no row` when an
 * event or timeless table's row does not exist.
 */
function sideOf(x: R): Part[] {
  const spans = arr(x["spans"]);
  if (x["exists"] === false && spans.length === 0) return t`no row`;
  if (spans.length > 0) {
    return join(
      spans.map((sp) => {
        const s = obj(sp);
        const values = s["values"] === null ? t`no value` : namedValues(s["values"]);
        const by = s["seq"] !== undefined ? t` (${op(s["seq"])}, ${actorOf(s["actor"])})` : [];
        return t`${periodOf(s)} ${values}${by}`;
      }),
      t`; `,
    );
  }
  const values = namedValues(x["values"]);
  return values.length > 0 ? values : t`no value`;
}

/** Whether a side gives the write behind it by stretch rather than as a whole. */
const byStretch = (x: R): boolean => arr(x["spans"]).some((sp) => obj(sp)["seq"] !== undefined);

const SUPERSEDED: ReadonlySet<string> = new Set<string>(SUPERSEDED_REASONS);

/**
 * What each of a conflict's decisions would do (05 §6 `saveslot_pending`: 可选), for the decisions
 * this credential has; what take_previous would undo is listed once, above. Any other decision is
 * named by its code.
 */
function conflictChoices(r: R): Line[] {
  const candidates = arr(r["candidates"]).map((c) => obj(c)["index"]);
  const prev = obj(r["previous"]);
  const undoes = arr(r["reverted_by_previous"]).length > 0 ? t`; see what it would undo above` : [];
  const out: Line[] = [];
  for (const d of arr(r["decisions"])) {
    if (d === "keep_effective") out.push(t`    keep_effective: keep the value in effect (above)`);
    else if (d === "take_candidate") {
      // With one candidate the parameter can be left out (05 §9.1 `candidate`).
      if (candidates.length === 1) {
        out.push(t`    take_candidate: put candidate ${count(candidates[0])} in effect`);
      } else {
        for (const k of candidates) {
          out.push(
            t`    take_candidate candidate=${count(k)}: put candidate ${count(k)} in effect`,
          );
        }
      }
    } else if (d === "take_previous") {
      out.push(
        t`    take_previous: go back to the value at ${op(prev["seq"])} (${sideOf(prev)})${undoes}`,
      );
    } else out.push(t`    ${codeIn(d, DECISIONS)}`);
  }
  return out;
}

/**
 * How a closed item ended (04-contract-types §4.8): the decision that resolved it, which candidate,
 * by whom and when, with the note given; or what superseded it, by which operation and when.
 */
function closedLines(r: R): Line[] {
  const out: Line[] = [];
  if (isObj(r["resolution"])) {
    const res = obj(r["resolution"]);
    const note = res["note"] !== undefined ? t` · note ${stored(String(res["note"]))}` : [];
    // take_candidate: which candidate, by the index the candidates above are listed with.
    const which = res["candidate"] !== undefined ? t` ${count(res["candidate"])}` : [];
    const at = res["at"] !== undefined ? t`, ${timeOf(res["at"])}` : [];
    out.push(
      t`  Resolved: ${codeIn(res["decision"], DECISIONS)}${which} (${op(res["seq"])}, ${actorOf(res["actor"])}${at})${note}`,
    );
  }
  if (isObj(r["superseded"])) {
    const sup = obj(r["superseded"]);
    const by = sup["by"] !== undefined ? t` by ${op(sup["by"])}` : [];
    const at = sup["at"] !== undefined ? t` (${timeOf(sup["at"])})` : [];
    out.push(t`  Superseded: ${codeIn(sup["reason"], SUPERSEDED)}${by}${at}`);
  }
  return out;
}

function pending(r: R, now: Date): Line[] {
  need(typeof r["id"] === "string" || Array.isArray(r["items"]));
  // The moments are as the service recorded them (UTC): a pending result does not give the slot's
  // time zone (05 §4.1 asks for it), and a second read only to learn it is not worth it.
  if (r["id"] !== undefined) {
    if (r["type"] === "schema_change") return schemaChangeItem(r, now);
    const out: Line[] = [
      t`${idOf(r["id"])} ${codeIn(r["type"], ITEM_TYPES)} · ${itemTarget(r["target"])}${reasonOf(r["reason"])} · ${codeIn(r["status"], ITEM_STATUS)} · opened ${openFor(r["opened_at"], now)} ago (${timeOf(r["opened_at"])}) by ${actorOf(r["opened_by"])}${r["item_ver"] !== undefined ? t` · version ${idOf(r["item_ver"])}` : []}`,
    ];
    if (isObj(r["effective"])) {
      const e = r["effective"];
      // By stretch, each stretch names its write; otherwise the side's own.
      const by = byStretch(e) ? [] : t` (${op(e["seq"])}, ${actorOf(e["actor"])})`;
      out.push(t`  In effect: ${sideOf(e)}${by}`);
    }
    const candidateImpact = obj(r["candidate_impact"]);
    for (const c of arr(r["candidates"])) {
      const x = obj(c);
      const what = x["values"] !== undefined ? namedValues(x["values"]) : t`revoke`;
      const period = isObj(x["valid"]) ? t` ${periodOf(x["valid"])}` : [];
      out.push(
        t`  Candidate ${count(x["index"])}: ${what}${period} (${op(x["seq"])}, ${actorOf(x["actor"])}, ${codeIn(x["intent"], INTENTS)})`,
      );
      // Taking it would be high impact: what it would change.
      const im = own(candidateImpact, String(x["index"]));
      if (isObj(im)) {
        out.push(t`    Taking candidate ${count(x["index"])} would:`, ...impactLines(im, "      "));
      }
    }
    if (isObj(r["previous"])) {
      const p = r["previous"];
      out.push(t`  Before (${op(p["seq"])}): ${sideOf(p)}`);
    }
    const reverted = arr(r["reverted_by_previous"]);
    if (reverted.length > 0) {
      out.push(t`  take_previous would undo: ${join(reverted.map(revertedWrite), t`; `)}`);
    }
    if (isObj(r["proposal"])) out.push(t`  Proposed: ${proposalOf(r["proposal"])}`);
    if (isObj(r["current"])) out.push(t`  In effect now: ${sideOf(r["current"])}`);
    if (isObj(r["impact"])) {
      const isUndo = isObj(obj(r["proposal"])["revert"]);
      out.push(...impactHead(impactLines(r["impact"], "    "), isUndo));
      out.push(...revertedTell(r["impact"]));
      if (r["status"] === "open") out.push(t`  Not in effect; the value in effect is unchanged.`);
    }
    out.push(...closedLines(r));
    const decisions = arr(r["decisions"]);
    if (decisions.length > 0) {
      if (r["type"] === "conflict") out.push(t`  Choices:`, ...conflictChoices(r));
      else
        out.push(
          t`  Choices: ${join(
            decisions.map((d) => [codeIn(d, DECISIONS)]),
            t` / `,
          )}`,
        );
    }
    return [...out, ...remindersOf(r, now)];
  }
  const items = arr(r["items"]);
  // One slot on the page: it heads the list (05 §6 `saveslot_pending`).
  const slots = new Set(items.map((i) => obj(i)["slot"]));
  const slot = slots.size === 1 && items.length > 0 ? t`${tableOf(obj(items[0])["slot"])} · ` : [];
  const out: Line[] = [t`${slot}${ofTotal(items.length, r["total"])} pending items`];
  for (const i of items) {
    const x = obj(i);
    const status =
      x["status"] !== undefined && x["status"] !== "open"
        ? t` · ${codeIn(x["status"], ITEM_STATUS)}`
        : [];
    out.push(
      t`${idOf(x["id"])} ${codeIn(x["type"], ITEM_TYPES)} · ${itemWhere(x)}${itemReason(x)}${status} · opened ${openFor(x["opened_at"], now)} ago${x["overdue"] === true ? t` · overdue, not yet deleted; will be retried` : []}`,
    );
  }
  return [...out, ...pageOf(r, items.length, () => t`items`), ...remindersOf(r, now)];
}

// --- write and resolve ---------------------------------------------------------------------------

/** One field's result in a receipt (05 §6 `saveslot_write`). */
function fieldResult(f: string, x: unknown): Part[] {
  const c = obj(x);
  const period = isObj(c["valid"]) ? t` ${periodOf(c["valid"])}` : [];
  const result = str(c["result"]) ?? "applied";
  if (result === "candidate") return t`${fieldOf(f)}${period} not in effect (see below)`;
  if (result === "awaiting") return t`${fieldOf(f)}${period} awaits confirmation (see below)`;
  if (result === "corroborated")
    return t`${fieldOf(f)}${period} unchanged; this was added as its evidence`;
  if (result === "noop") return [];
  const before = Object.hasOwn(c, "before") ? t`${fieldValue(c["before"])} → ` : [];
  // A stale ver, this field untouched since (04-contract §5.4 `applied`).
  const merged =
    c["merged"] === true ? t` (nobody changed this field since the version you gave: merged)` : [];
  return t`${fieldOf(f)}${period} ${before}${fieldValue(c["after"])}${merged}`;
}

/** The conflict item's decisions (05 §6 `saveslot_write`: 处理). */
const CONFLICT_DECISIONS = ["keep_effective", "take_candidate", "take_previous"] as const;

/**
 * A field that became a candidate (05 §6 `saveslot_write`): its value at the version the write
 * gave (the merge base: what the caller read only if it gave the version it read), the value in
 * effect and who gave it, the item and its version, and how to resolve it. With a fallback `ver`,
 * which version that was and where it came from.
 */
function candidateLines(f: string, c: R, at: number, r: R): Line[] {
  const prev = obj(c["previous"]);
  const by = obj(c["by"]);
  const fallback = arr(r["warnings"])
    .map(obj)
    .find((w) => w["code"] === "ver_fallback" && int(w["op"]) === at);
  const given =
    fallback !== undefined
      ? t`at the version used (${idOf(fallback["ver"])}, ${originOf(fallback)}, ${op(prev["seq"])})`
      : t`at the version you gave (${op(prev["seq"])})`;
  const values = obj(prev["values"]);
  // A state table gives the merge base by stretch: each stretch's value of this field.
  const spans = arr(prev["spans"])
    .map(obj)
    .map((sp) => {
      const v = obj(sp["values"]);
      return t`${periodOf(sp)} ${Object.hasOwn(v, f) ? fieldValue(v[f]) : t`no value`}`;
    });
  const then =
    prev["exists"] === false
      ? t`the row did not exist`
      : spans.length > 0
        ? t`it was ${join(spans, t`; `)}`
        : Object.hasOwn(values, f)
          ? t`it was ${fieldValue(values[f])}`
          : t`it had no value`;
  const who = by["seq"] !== undefined ? t` by ${actorOf(by["actor"])} (${op(by["seq"])})` : [];
  // What the user is told: who changed it after the version given, and that this did not happen.
  const tell =
    by["seq"] !== undefined
      ? t`  Tell the user this was not done: ${actorOf(by["actor"])} changed the record (${op(by["seq"])}) after the version you gave; ask what they want before resolving.`
      : t`  Tell the user this was not done: the record was changed after the version you gave; ask what they want before resolving.`;
  const item = c["item"];
  const ref = arr(r["pending"])
    .map(obj)
    .find((p) => p["id"] === item);
  const version = ref?.["item_ver"] !== undefined ? t` (version ${idOf(ref["item_ver"])})` : [];
  // Taking it would be high impact: what it would change.
  const taking = isObj(c["impact"])
    ? [t`  Taking your value would:`, ...impactLines(c["impact"], "    ")]
    : [];
  // A revoke that became a candidate on the whole row (`*`): the unit is the row's existence and
  // `effective` is null by the contract (04-contract-types FieldResult), which is not "no value".
  // The row existed at the version given (a revoke of a row that did not exist is no candidate)
  // and was changed since by another write, not revoked (a second revoke would be the same value).
  if (f === "*" && (c["after"] === null || c["after"] === undefined) && prev["exists"] !== false) {
    return [
      t`  The whole row: ${given} it existed; it has been changed since${who}, ver=${idOf(c["current_ver"])}, and still exists. Your revoke did not take effect: it is a candidate in conflict item ${idOf(item)}${version}; the row stays as it is. saveslot_pending ${idOf(item)} shows its values in effect.`,
      tell,
      ...taking,
      t`  To resolve: saveslot_resolve ${idOf(item)} (${join(
        CONFLICT_DECISIONS.map((d) => [code(d, DECISIONS)]),
        t` / `,
      )})`,
    ];
  }
  return [
    t`  ${fieldOf(f)}: ${given} ${then}; now it is ${fieldValue(c["effective"])}, set${who}, ver=${idOf(c["current_ver"])}. Your value ${fieldValue(c["after"])} did not take effect: it is a candidate in conflict item ${idOf(item)}${version}; the value in effect stays ${fieldValue(c["effective"])}.`,
    tell,
    ...taking,
    t`  To resolve: saveslot_resolve ${idOf(item)} (${join(
      CONFLICT_DECISIONS.map((d) => [code(d, DECISIONS)]),
      t` / `,
    )})`,
  ];
}

/**
 * A write awaiting confirmation (05 §6 `saveslot_write`: 高影响写入进待确认时): the parts that
 * await, the item and its version, what carrying it out would change, and that it is not in
 * effect until the user agrees and it is confirmed. One block per item of an op: the item's impact
 * is the op's, given on each of its parts.
 */
function awaitingLines(parts: readonly { f: string; c: R }[], r: R, isUndo: boolean): Line[] {
  const first = parts[0];
  if (first === undefined) return [];
  const item = first.c["item"];
  const ref = arr(r["pending"])
    .map(obj)
    .find((p) => p["id"] === item);
  const version = ref?.["item_ver"] !== undefined ? t` (version ${idOf(ref["item_ver"])})` : [];
  const what = join(
    parts.map(({ f, c }) => {
      const period = isObj(c["valid"]) ? t` ${periodOf(c["valid"])}` : [];
      const value = Object.hasOwn(c, "after") ? t` ${fieldValue(c["after"])}` : t` no value`;
      return t`${fieldOf(f)}${period}${value}`;
    }),
    t`; `,
  );
  const lines = impactLines(first.c["impact"], "    ");
  const head =
    lines.length > 0
      ? [
          t`  ${what}: awaits confirmation in ${idOf(item)}${version}. Carrying it out would:`,
          ...lines,
        ]
      : [
          t`  ${what}: awaits confirmation in ${idOf(item)}${version}.`,
          ...(isUndo ? [t`  Confirming it records this undo; no value read now changes.`] : []),
        ];
  return [
    ...head,
    ...revertedTell(first.c["impact"]),
    t`  Not in effect; the value in effect is unchanged. Tell the user the above in this reply and ask them; what they said before this item appeared is not agreement to it. Once they agree: saveslot_resolve ${idOf(item)} confirm (or reject).`,
  ];
}

/**
 * An undo's parts not undone, and the later writes undone with it (05 §6 `saveslot_write`). Those
 * later writes are left out when the op awaits confirmation: its impact lists them already.
 */
function undoLines(u: R, awaiting: boolean): Line[] {
  const out: Line[] = [];
  for (const s of arr(u["skipped_superseded"])) {
    const x = obj(s);
    out.push(
      t`  skipped ${fieldOf(x["field"])}: changed since by ${op(x["by"])} (${actorOf(x["actor"])}), no longer what ${op(u["of"])} wrote; to undo it too, write the undo again with include_later: true (it will await confirmation)`,
    );
  }
  for (const l of awaiting ? [] : arr(u["reverted_later"])) {
    const x = obj(l);
    out.push(
      t`  also undoes ${op(x["seq"])} (${actorOf(x["actor"])}): ${join(arr(x["fields"]).map(fieldOf), t`, `)}`,
    );
  }
  return out;
}

/** An entity key as given back (04-contract-types `EntityKeyText`): its text, or by field. */
const keyText = (k: unknown): Part[] =>
  isObj(k)
    ? join(
        Object.entries(k).map(([f, v]) => t`${fieldOf(f)} ${untrusted(String(v))}`),
        t`, `,
      )
    : [untrusted(String(k))];

/**
 * How each field of a state-table write resolved (04-contract §5.2 «next_change 逐字段解析»; 05 §6
 * `saveslot_write`), beyond the interval its parts already show: a start taken as now, a
 * correction's stretch, the stretches without a value it filled, and the unchanged value where a
 * default end met the next change. Fields whose line would read the same share it.
 */
function resolvedLines(x: R): Line[] {
  const lines = new Map<string, { fields: string[]; text: Part[] }>();
  const add = (f: string, text: Part[]) => {
    // Each drawing has a boundary number of its own: compared without it.
    const k = render([text]).replace(/untrusted-data-[0-9a-f]{32}/g, "untrusted-data");
    const line = lines.get(k) ?? { fields: [], text };
    line.fields.push(f);
    lines.set(k, line);
  };
  for (const [f, v] of Object.entries(obj(x["resolved"]))) {
    const ri = obj(v);
    if (ri["from_as"] === "now") {
      add(f, t`start taken as now (${timeOf(ri["valid_from"])}): no valid_from was given`);
    }
    if (ri["from_as"] === "corrected_span" || ri["to_as"] === "corrected_span") {
      add(f, t`the correction applies to the stretch it corrects`);
    }
    const filled = arr(ri["filled"]);
    if (filled.length > 0) {
      add(f, t`fills ${join(filled.map(periodOf), t`; `)}, which had no value`);
    }
    if (isObj(ri["next_change"])) {
      const next = ri["next_change"];
      add(
        f,
        next["value"] === null
          ? t`Tell the user it now holds up to ${timeOf(next["at"])}, and that what is recorded from then on (no value) is unchanged.`
          : t`Tell the user it now holds up to ${timeOf(next["at"])}, and that what is recorded from then on (${fieldValue(next["value"])}) is unchanged.`,
      );
    }
  }
  return [...lines.values()].map(
    ({ fields, text }) => t`  ${join(fields.map(fieldOf), t`, `)}: ${text}`,
  );
}

function receiptOps(r: R): Line[] {
  const out: Line[] = [];
  for (const [at, o] of arr(r["ops"]).entries()) {
    const x = obj(o);
    if (!Object.hasOwn(x, "target")) {
      out.push(t`op ${count(x["op_index"])}: not recorded then (unchanged or skipped)`);
      continue;
    }
    // A receipt shortened to fit has no field results: that is not "no change".
    let what: Part[];
    if (!Object.hasOwn(x, "fields")) what = t`field results left out of this receipt`;
    else {
      const fields: Part[][] = [];
      for (const [f, v] of Object.entries(obj(x["fields"]))) {
        for (const one of Array.isArray(v) ? v : [v]) {
          const p = fieldResult(f, one);
          if (p.length > 0) fields.push(p);
        }
      }
      what = fields.length > 0 ? join(fields, t`; `) : t`no change`;
    }
    const created = x["created_entity"] === true ? t` · new entity` : [];
    const undo = isObj(x["undo"]) ? x["undo"] : undefined;
    const undoes = undo !== undefined ? t` (undoes ${op(undo["of"])})` : [];
    out.push(
      t`${targetOf(x["target"])} ${codeIn(x["intent"], INTENTS)}${undoes}: ${what}${x["ver"] !== undefined ? t` (ver=${idOf(x["ver"])})` : []}${created}`,
    );
    // A new entity by its key: the keys the table had, so that a key written wrong shows.
    const keys = arr(x["existing_keys"]);
    if (keys.length > 0)
      out.push(t`  Keys already in the table: ${join(keys.map(keyText), t`; `)}`);
    out.push(...resolvedLines(x));
    const awaiting = new Map<unknown, { f: string; c: R }[]>();
    for (const [f, v] of Object.entries(obj(x["fields"]))) {
      for (const one of Array.isArray(v) ? v : [v]) {
        const c = obj(one);
        if (c["result"] === "candidate") out.push(...candidateLines(f, c, at, r));
        if (c["result"] === "awaiting") {
          const list = awaiting.get(c["item"]) ?? [];
          list.push({ f, c });
          awaiting.set(c["item"], list);
        }
      }
    }
    for (const parts of awaiting.values()) out.push(...awaitingLines(parts, r, undo !== undefined));
    if (undo !== undefined) out.push(...undoLines(undo, awaiting.size > 0));
  }
  const more = int(r["ops_omitted"]);
  if (more !== undefined && more > 0) {
    out.push(t`${num(more)} more ops are left out of this receipt: saveslot_history shows them`);
  }
  return out;
}

/**
 * The derived values a write changed (04-contract-types `DerivedChange`; 05 §6 `saveslot_write`):
 * one line per derived row (its table and group key), each field it changed before and after.
 */
function derivedLines(r: R): Line[] {
  const rows = new Map<string, { table: unknown; key: unknown; fields: Part[][] }>();
  const changes = arr(r["derived"]);
  for (const d of changes) {
    const x = obj(d);
    const id = `${String(x["table"])} ${JSON.stringify(x["key"] ?? null)}`;
    const row = rows.get(id) ?? { table: x["table"], key: x["key"], fields: [] };
    const before =
      x["before"] === null || x["before"] === undefined ? t`—` : fieldValue(x["before"]);
    row.fields.push(t`${fieldOf(x["field"])} ${before} → ${fieldValue(x["after"])}`);
    rows.set(id, row);
  }
  const out: Line[] = [];
  for (const row of rows.values()) {
    const key = Object.entries(obj(row.key));
    const keyed = key.length > 0 ? t` (${namedValues(row.key)})` : [];
    out.push(t`Derived: ${tableOf(row.table)}${keyed}: ${join(row.fields, t`; `)}`);
  }
  const total = int(r["derived_total"]);
  if (r["replayed"] === true) {
    if (total !== undefined && total > 0) {
      out.push(
        t`Derived: ${num(total)} derived rows were written; a replay does not give their values.`,
      );
    }
  } else if (total !== undefined && total > changes.length) {
    out.push(
      t`${num(total - changes.length)} more derived changes are not listed in this receipt.`,
    );
  }
  return out;
}

/** The items a receipt's op lines already name with their version and next step. */
function itemsSaid(r: R): Set<unknown> {
  const said = new Set<unknown>();
  for (const o of arr(r["ops"])) {
    for (const v of Object.values(obj(obj(o)["fields"]))) {
      for (const p of Array.isArray(v) ? v : [v]) {
        const c = obj(p);
        if (c["result"] === "candidate" || c["result"] === "awaiting") said.add(c["item"]);
      }
    }
  }
  return said;
}

function receiptTail(r: R, now: Date): Line[] {
  const out: Line[] = [...derivedLines(r)];
  const said = itemsSaid(r);
  for (const p of arr(r["pending"])) {
    const x = obj(p);
    if (x["merged"] === true) {
      out.push(
        t`Merged into ${idOf(x["id"])} (it holds other writes' candidates too); look at it with saveslot_pending ${idOf(x["id"])} first.`,
      );
      continue;
    }
    if (x["refreshed"] === true) {
      out.push(
        t`Your write changed the target of an open item ${idOf(x["id"])}; it is still open; look at it with saveslot_pending ${idOf(x["id"])} first.`,
      );
      continue;
    }
    // Said above with its version and what to do: not again.
    if (said.has(x["id"])) continue;
    out.push(
      t`Pending: ${idOf(x["id"])} ${codeIn(x["type"], ITEM_TYPES)}${x["item_ver"] !== undefined ? t` (version ${idOf(x["item_ver"])})` : []}. Before resolving a change with a large effect, tell the user and get their agreement; then saveslot_resolve.`,
    );
  }
  const morePending = int(r["pending_omitted"]);
  if (morePending !== undefined && morePending > 0) {
    out.push(
      t`${num(morePending)} pending items are left out of this receipt: saveslot_pending shows them`,
    );
  }
  for (const s of arr(r["superseded"])) {
    const x = obj(s);
    // Why each was closed (04-contract-types §4.8 `SupersededReason`), as the item's details say it.
    const why = x["reason"] !== undefined ? t` · ${codeIn(x["reason"], SUPERSEDED)}` : [];
    out.push(
      t`Superseded: ${idOf(x["item"])} ${codeIn(x["type"], ITEM_TYPES)}${why}. Tell the user this proposal no longer applies because of this change; saveslot_pending ${idOf(x["item"])} shows what it proposed and who proposed it.`,
    );
  }
  if (isObj(r["affected_reads"])) {
    out.push(t`Earlier reads used the old value: ${stored(JSON.stringify(r["affected_reads"]))}`);
  }
  if (isObj(r["premise_affected"])) {
    out.push(t`Rows whose premises changed: ${stored(JSON.stringify(r["premise_affected"]))}`);
  }
  return [...out, ...remindersOf(r, now), ...shortened(r)];
}

/** A receipt shortened to fit the budget says so (05 §3), and only what its status says. */
function shortened(r: R): Line[] {
  const omitted = arr(r["omitted"]);
  if (!omitted.includes("field_results") && !omitted.includes("lists")) return [];
  if (r["replayed"] === true) {
    return [t`The receipt was shortened to fit. saveslot_history shows all of it.`];
  }
  return r["status"] === "pending"
    ? [
        t`The receipt was shortened to fit; the write is recorded, not all of it in effect. saveslot_history shows all of it.`,
      ]
    : [
        t`The receipt was shortened to fit; the write took effect. saveslot_history shows all of it.`,
      ];
}

const STATUSES: ReadonlySet<string> = new Set(
  Object.keys({ saved: true, pending: true } satisfies Record<WriteResult["status"], true>),
);

/** The field results of a receipt's ops, every part. */
const resultsOf = (r: R): string[] =>
  arr(r["ops"]).flatMap((o) =>
    Object.values(obj(obj(o)["fields"])).flatMap((v) =>
      (Array.isArray(v) ? v : [v]).map((p) => String(obj(p)["result"] ?? "applied")),
    ),
  );

/** How a receipt's write stands (05 §6 `saveslot_write`, the first line). */
function statusOf(r: R): Part[] {
  if (r["status"] !== "pending") return t`Saved`;
  const results = resultsOf(r);
  if (results.includes("awaiting")) return t`Recorded, awaiting confirmation`;
  return results.some((x) => x === "applied" || x === "corroborated")
    ? t`Recorded, partly not in effect`
    : t`Recorded, not in effect`;
}

/** The slot of a receipt, from its targets' qualified table names (`slot.table`). */
function slotOf(r: R): Part[] {
  const table = str(obj(obj(arr(r["ops"])[0])["target"])["table"]);
  const slot = table?.includes(".") === true ? table.split(".")[0] : undefined;
  return slot !== undefined ? t`${as(slot, name)} ` : [];
}

function write(r: R, now: Date): Line[] {
  need(Array.isArray(r["ops"]) && STATUSES.has(String(r["status"])));
  const status = statusOf(r);
  const seq = r["seq"] !== undefined ? t` · ${op(r["seq"])}` : t` · nothing recorded`;
  const out: Line[] = [];
  if (r["replayed"] === true) {
    out.push(
      t`This is the receipt of an earlier identical request; nothing new was recorded. If this really is a new record, submit it again with an idempotency_key.`,
    );
  }
  if (isObj(r["original_deleted"])) {
    out.push(
      t`The original write was deleted (${idOf(r["original_deleted"]["deletion"])}); it was not written again.`,
    );
  }
  out.push(t`${status} · ${slotOf(r)}schema v${count(r["sv"])}${seq}`);
  return [...out, ...receiptOps(r), ...receiptTail(r, now)];
}

function resolve(r: R, now: Date): Line[] {
  need(typeof r["id"] === "string" && typeof r["decision"] === "string");
  const head = t`${idOf(r["id"])} ${codeIn(r["type"], ITEM_TYPES)}: ${codeIn(r["decision"], DECISIONS)} · ${codeIn(r["status"], ITEM_STATUS)}${r["item_ver"] !== undefined ? t` · version ${idOf(r["item_ver"])}` : []}`;
  const replayed =
    r["replayed"] === true
      ? [t`This item was already resolved this way; nothing new was changed.`]
      : [];
  const receipt = isObj(r["write"])
    ? [...receiptOps(r["write"]), ...receiptTail(r["write"], now)]
    : [];
  // take_previous: the writes it took back or hid, as the item's details listed them.
  const reverted = arr(r["reverted_by_previous"]);
  const undid = reverted.length > 0 ? [t`Undid: ${join(reverted.map(revertedWrite), t`; `)}`] : [];
  return [head, ...replayed, ...undid, ...receipt, ...remindersOf(r, now)];
}

/** The changes a new slot's receipt says by its tables already (05 §6 `saveslot_schema_draft`). */
const SAID_BY_TABLES: ReadonlySet<unknown> = new Set([
  "create_slot",
  "add_table",
  "add_derived_table",
]);

const CHANGE_CODES: ReadonlySet<string> = new Set<string>(SCHEMA_CHANGE_CODES);
const CLASSES: ReadonlySet<string> = new Set<string>(CHANGE_CLASSES);

/** What a change is to (04-contract-types §5.3 `SchemaChange.target`): the slot, a table, a field. */
function changeTarget(x: unknown): Part[] {
  const g = obj(x);
  if (g["slot"] === true) return t`the slot`;
  const table = tableOf(g["table"]);
  if (g["field"] !== undefined) return t`${table}.${fieldOf(g["field"])}`;
  if (g["rule"] === true) return t`${table} rule`;
  return table;
}

/**
 * A draft's changes, one line each (05 §6 `saveslot_schema_draft`; the same in a `schema_change`
 * item's detail): target, code, class, whether writes in the earlier version are still taken,
 * whether it loses data, and, when the draft waits, which changes wait.
 */
function changeLines(changes: unknown, waiting: boolean, pad: "  " | "    "): Line[] {
  return arr(changes).map((x) => {
    const c = obj(x);
    const old =
      c["compatible_with_old_writes"] === true
        ? t`writes in the earlier version still taken`
        : t`writes in the earlier version refused`;
    const loses = c["destructive"] === true ? t`loses data` : t`loses no data`;
    const waits = waiting && c["auto"] !== true ? t` · waits for confirmation` : [];
    return t`${padded(pad)}${changeTarget(c["target"])}: ${codeIn(c["change"], CHANGE_CODES)} (${codeIn(c["class"], CLASSES)}) · ${old} · ${loses}${waits}`;
  });
}

/** A draft's impact (04-contract-types §5.3 `SchemaImpact`): rows to change, derived values. */
function schemaImpactLine(x: unknown, pad: "" | "  "): Line {
  const impact = obj(x);
  const derived = arr(impact["derived_changed"]).map((y) => {
    const d = obj(y);
    return t`${tableOf(d["table"])} ${count(d["rows"])} rows`;
  });
  return t`${pad === "" ? [] : t`  `}Impact: ${count(impact["rows_affected"])} rows to change${derived.length > 0 ? t`; derived values change in ${join(derived, t`, `)}` : []}`;
}

/**
 * A `schema_change` item's detail (04-contract-types §4.8 `SchemaChangeDetail`; 05 §4): its
 * draft and the version it compiles to, each change as the draft's receipt writes it, the impact
 * as estimated when the draft was submitted, how it ended, and where the slot's document as the
 * draft would make it is read. The detail gives no version the draft was written on: only the
 * version it goes to.
 */
function schemaChangeItem(r: R, now: Date): Line[] {
  const open = r["status"] === "open";
  const out: Line[] = [
    t`${idOf(r["id"])} ${codeIn(r["type"], ITEM_TYPES)} · ${itemWhere(r)}${itemReason(r)} · ${codeIn(r["status"], ITEM_STATUS)} · opened ${openFor(r["opened_at"], now)} ago (${timeOf(r["opened_at"])}) by ${actorOf(r["opened_by"])}${r["item_ver"] !== undefined ? t` · version ${idOf(r["item_ver"])}` : []}`,
    t`  Draft ${idOf(r["draft"])} → schema v${count(r["target_sv"])}`,
    ...changeLines(r["changes"], open, "    "),
    schemaImpactLine(r["impact"], "  "),
    t`  The slot as this draft would make it: saveslot_catalog with level "schema" and draft ${idOf(r["draft"])}.`,
    ...closedLines(r),
  ];
  if (open)
    out.push(
      t`  Not in effect; the slot is unchanged. This version cannot confirm it yet: it stays pending until a newer draft replaces it.`,
    );
  return [...out, ...remindersOf(r, now)];
}

/**
 * A draft changing an existing slot (05 §6 `saveslot_schema_draft`, P4): first what came of it,
 * in effect or awaiting confirmation (with its item); then each change with its target, class,
 * whether writes in the earlier version are still taken and whether it loses data; then the
 * impact. This version computes no usage (`consumers`) and runs no trial.
 */
function schemaChange(r: R, now: Date, out: Line[], omitted: readonly unknown[]): Line[] {
  const applied = r["outcome"] === "applied";
  const base = obj(r["document"])["base_version"];
  const from = int(base) !== undefined ? t`v${count(base)} → ` : [];
  const head = t`slot ${tableOf(r["slot"])} · schema ${from}v${count(r["target_sv"])} · draft ${idOf(r["draft"])}`;
  if (applied) out.push(t`In effect · ${head}`);
  else {
    const item = obj(r["item"]);
    out.push(
      t`Awaiting confirmation · ${head} · item ${idOf(item["id"])} (version ${idOf(item["item_ver"])})`,
    );
  }
  out.push(...changeLines(r["changes"], !applied, "  "), schemaImpactLine(r["impact"], ""));
  if (applied) {
    out.push(
      t`Its whole schema now: saveslot_catalog with level "schema". Write with sv ${count(r["sv"])}.`,
    );
  } else {
    out.push(
      t`Tell the user the changes above. This version cannot confirm it yet: it stays pending until a newer draft replaces it, and the slot stays as it is.`,
    );
  }
  const shortened =
    omitted.length > 0
      ? [t`The receipt was shortened to fit; the draft was submitted all the same.`]
      : [];
  return [...out, ...remindersOf(r, now), ...shortened];
}

/**
 * A schema draft's receipt (05 §6 `saveslot_schema_draft`). A new slot, in effect at once: what
 * was created, each table with its kind and time type, its entity key, and each field's name, type
 * and unit, so that the model can tell the user what there is now. The descriptions are the
 * caller's own and are not repeated; a change of a kind this version does not make is shown as
 * written, inside the boundary. A draft changing an existing slot: `schemaChange`.
 */
function schemaDraft(r: R, now: Date): Line[] {
  const omitted = arr(r["omitted"]);
  const outcome = r["outcome"];
  // A new slot is version 1; a change to an existing slot compiles to a later one. Not told by its
  // changes: a receipt shortened to fit leaves them out.
  const isChange = (int(r["target_sv"]) ?? 1) > 1;
  need(
    (outcome === "applied" || (isChange && outcome === "pending" && isObj(r["item"]))) &&
      (isObj(r["document"]) || omitted.includes("document")) &&
      typeof r["draft"] === "string",
  );
  const out: Line[] = [];
  if (r["replayed"] === true) {
    out.push(t`This is the receipt of an earlier identical request; nothing new was recorded.`);
  }
  if (isChange) return schemaChange(r, now, out, omitted);
  out.push(
    t`Created · slot ${tableOf(r["slot"])} · schema v${count(r["sv"])} · draft ${idOf(r["draft"])}`,
  );
  for (const x of arr(obj(r["document"])["tables"])) {
    const tb = obj(x);
    const fields = arr(tb["fields"]).map((f) => {
      const fd = obj(f);
      const unit = fd["unit"] !== undefined ? t` ${untrusted(String(fd["unit"]))}` : [];
      return t`${fieldOf(fd["name"])} ${codeIn(fd["type"], FIELD_TYPES)}${unit}`;
    });
    out.push(t`${tableOf(tb["name"])} (${tableKind(tb)}): ${join(fields, t`, `)}`);
    const key = arr(tb["entity_key"]);
    if (key.length > 0) out.push(t`  entity key: ${join(key.map(fieldOf), t`, `)}`);
  }
  for (const c of arr(r["changes"])) {
    if (!SAID_BY_TABLES.has(obj(c)["change"])) out.push(t`Change: ${stored(JSON.stringify(c))}`);
  }
  if (omitted.includes("document")) {
    out.push(
      t`Its tables and fields are left out of this receipt to fit: saveslot_catalog with level "table" shows them.`,
    );
  }
  out.push(t`Write to its base tables with sv ${count(r["sv"])}.`);
  // Shortened to fit the budget (05 §3): the slot was created all the same.
  const shortened =
    omitted.length > 0 ? [t`The receipt was shortened to fit; the slot was created.`] : [];
  return [...out, ...remindersOf(r, now), ...shortened];
}

/** A table of stored data, inside one boundary between its lead and tail (`renderTable`). */
interface Table {
  readonly table: true;
  readonly lead: Line[];
  readonly header: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly tail: Line[];
}
type Renderer = (r: R, now: Date) => Line[] | { json: true; lead: Line[] } | Table;
const RENDER: ReadonlyMap<ToolName, Renderer> = new Map<ToolName, Renderer>([
  ["saveslot_catalog", catalog],
  ["saveslot_query", query],
  ["saveslot_sql", sql],
  ["saveslot_history", history],
  ["saveslot_pending", pending],
  ["saveslot_write", write],
  ["saveslot_resolve", resolve],
  ["saveslot_schema_draft", schemaDraft],
]);

/** A value as plain JSON for a fallback, which must not fail: what JSON cannot hold is dropped. */
function asPlain(v: unknown, otherwise: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(v)) as unknown;
  } catch {
    return otherwise;
  }
}

/** A tool's result as text by its renderer; throws on a shape the renderer does not know. */
export function renderStrict(tool: ToolName, result: R, now: Date = new Date()): string {
  const f = RENDER.get(tool);
  if (f === undefined) throw new Error("no renderer");
  const out = f(result, now);
  if (Array.isArray(out)) return render(out);
  if ("table" in out) return renderTable(out.lead, out.header, out.rows, out.tail);
  return renderJson(out.lead, result);
}

/** A tool's result as text; JSON as written when its renderer cannot give it. */
export function renderResult(tool: ToolName, result: R, now: Date = new Date()): string {
  try {
    return renderStrict(tool, result, now);
  } catch {
    // A shape the renderer did not expect, or a renderer's fault: the whole of it inside the
    // boundary instead.
    return renderJson([], asPlain(result, { result: "not shown" }));
  }
}

// --- errors -------------------------------------------------------------------------------------

/** The next step by error code (05 §7): the contract's codes only, not every one has a step. */
const NEXT: ReadonlyMap<string, () => Part[]> = new Map(
  Object.entries({
    invalid_argument: () => t`Check the parameter named, and send the request again.`,
    unknown_table: () => t`Use saveslot_catalog to see the tables.`,
    unknown_field: () => t`Use saveslot_catalog with level "table" to see the fields.`,
    not_found: () =>
      t`It may have been deleted, or be out of this connection's range; locate it again with saveslot_query.`,
    revoked: () => t`To restore it, use revert: {undo: n} with the operation that revoked it.`,
    item_closed: () =>
      t`The item is closed: there is nothing left to decide. Tell the user how it ended (above).`,
    handle_expired: () => t`Read again from the first page, without cursor.`,
    derived_readonly: () => t`Derived tables are read-only: write to their source tables.`,
    validation_failed: () => t`Correct the values named, and send the request again.`,
    insufficient_scope: () =>
      t`This connection may not do this; the user can use a connection that may.`,
    not_in_this_version: () => t`This is not in this version of saveslot.`,
    too_large: () => t`Ask for less.`,
    sql_rejected: () =>
      t`Rewrite the statement where it says (saveslot_catalog has the tables and fields), and send it again.`,
    sql_timeout: () =>
      t`The statement took too long: add conditions, a shorter date range, or aggregate, and send it again.`,
    unavailable: () => t`saveslot is not ready; try again shortly.`,
    internal: () =>
      t`An error inside saveslot (the incident is logged); whether this call took effect is not known: read the state it concerns before deciding whether to send it again.`,
    read_first: () => t`Read the row first (saveslot_query), then write with the ver you read.`,
    confirmation_mismatch: () =>
      t`The item changed after you read it (its current content is above): tell the user what changed, and resolve it with the new item_ver only once they decide again.`,
  } satisfies Partial<Record<ErrorCode, () => Part[]>>) as [string, () => Part[]][],
);

/** The reasons of the contract's errors this version gives (04-contract-types §9), every code's. */
const REASONS: ReadonlySet<string> = new Set<string>(Object.values(ERROR_REASONS).flat());

/** Why a rule's SQL was refused (04-contract-types §9 `SqlReason`). */
const SQL_REASON: ReadonlySet<string> = new Set<string>(SQL_REASONS);

/** The codes of a validation's details: the contract's (04-contract-types §9), as the CLI shows them. */
const DETAIL_CODES: ReadonlySet<string> = new Set<string>(VALIDATION_DETAIL_CODES);

/** How to ask for less, by the parameter to change (05 §7 `too_large`, `result_budget`). */
const NARROW: ReadonlyMap<string, () => Part[]> = new Map([
  ["fields", () => t`ask for fewer fields (fields)`],
  ["where", () => t`add conditions (where)`],
  ["valid_during", () => t`a shorter range of business time (valid_during)`],
  ["valid_at", () => t`one day or moment of business time (valid_at)`],
  ["limit", () => t`a smaller limit`],
  ["expand_sources", () => t`leave out the evidence text (expand_sources: false)`],
  ["tables", () => t`fewer tables (tables)`],
  ["slot", () => t`one slot at a time (slot)`],
  ["type", () => t`one type of item at a time (type)`],
  ["level", () => t`level "table" for the tables you need, instead of the whole document`],
  ["sql", () => t`select fewer or shorter columns, or aggregate (sql)`],
]);

/**
 * Where in the request a detail is (a JSON pointer's segments, `tables/0/fields/2/unit`): its
 * numbers and names as they are, any other segment (a key the caller wrote) inside the boundary.
 */
function pathOf(x: unknown): Part[] {
  return join(
    String(x ?? "")
      .split("/")
      .map((seg) => (/^(0|[1-9][0-9]{0,8})$/.test(seg) ? [num(Number(seg))] : [as(seg, name)])),
    t`/`,
  );
}

/** Allowed values that are the service's own codes: field types, a rule's time dependencies. */
const ALLOWED_CODES: ReadonlySet<string> = new Set<string>([
  ...CONTRACT_FIELD_TYPES,
  ...TIME_DEPENDENCIES,
]);

/** Allowed values as given: the service's own codes as they are, anything else inside the boundary. */
const allowedOf = (xs: readonly unknown[]): Part[] =>
  join(
    xs.map((v) => [codeIn(v, ALLOWED_CODES)]),
    t`, `,
  );

/** What each rule of an alias says when broken (04-contract-types §9 `reason` of `alias_invalid`). */
const ALIAS_RULES: ReadonlyMap<string, Part[]> = new Map([
  ["count", t`too many aliases on one table or field`],
  ["length", t`the alias is too long (characters counted after NFC)`],
  ["empty", t`the alias is empty`],
  ["control", t`the alias holds a line break or a control character`],
  ["surrounding_space", t`the alias starts or ends with white space`],
  ["repeat", t`the alias repeats one before it on the same table or field`],
  [
    "name",
    t`the alias is a name that still resolves in its scope: a table of this slot or a field of its table, by its current name or an old one of the last 10 versions`,
  ],
]);

/**
 * What a schema draft's detail says of how to put it right, beyond its code (04-contract
 * «schema_draft»): the values the service allows, a time field that is not required; and, in our
 * own words, that a derived field's type is usually left out. Nothing of the document is in them.
 */
function detailGuide(x: R): Line[] {
  const lines: Line[] = [];
  const allowed = arr(x["allowed_values"]);
  if (allowed.length > 0) lines.push(t`    allowed: ${allowedOf(allowed)}`);
  if (x["reason"] === "not_required") lines.push(t`    the field it names needs required: true`);
  // The rule an alias breaks (07 «schema 文档格式» 别名), in our words: not the alias itself.
  if (x["code"] === "alias_invalid") {
    const rule = ALIAS_RULES.get(String(x["reason"]));
    if (rule !== undefined) lines.push(t`    ${rule}`);
  }
  // A name not of a name's form and a reserved name are one code (03-data-model/10 «名字»).
  if (x["code"] === "reserved_name") {
    lines.push(
      t`    a name is letters, digits and underscores, a letter first, at most 63; a field is not named valid, valid_from, valid_to, row_id or entity_id`,
    );
  }
  // A ref field's value (03-data-model/04 «引用字段（ref）»).
  if (x["code"] === "ref_not_found") {
    lines.push(
      t`    the row or entity it names is not there, is revoked, or is out of this connection's range: locate it with saveslot_query`,
    );
  }
  if (x["code"] === "ref_wrong_table") {
    lines.push(t`    it names a row of another table than the one the field refers to`);
  }
  const path = String(x["path"] ?? "");
  if (x["code"] === "key_not_applicable" && /^tables\/[0-9]+\/fields\/[0-9]+\/type$/.test(path)) {
    lines.push(t`    a derived table's fields take their types from the rule: leave type out`);
  }
  return lines;
}

/**
 * What a refused parameter of a schema draft should look like (05 §7), beyond the example and
 * values the service gives: what a rule's SQL is, and that a rule has no other keys. Our own words.
 */
function paramGuide(error: R): Line[] {
  const param = String(error["param"] ?? "");
  if (/^tables\/[0-9]+\/(?:rule|sql|rule\/sql)$/.test(param)) {
    return [
      t`A derived table's rule is {sql, time_dependency}: sql is one SELECT over one base table of the slot, each column named by AS <field name>.`,
    ];
  }
  if (/^tables\/[0-9]+\/rule\/(?!time_dependency$)[^/]+$/.test(param)) {
    return [
      t`A derived table's rule takes only sql and time_dependency; the rows it groups by and the range it covers are in the SQL.`,
    ];
  }
  return [];
}

/** The details shown of a refusal; the rest are counted. */
const DETAILS_SHOWN = 20;

/** What to do about an `invalid_argument`, by its reason, where the reason alone does not say. */
const REASON_NEXT: ReadonlyMap<string, () => Part[]> = new Map([
  [
    "insert_with_entity_key",
    () =>
      t`This table has an entity key: a new entity is written with intent "update" and its entity_key, which creates it; insert is not used here.`,
  ],
  [
    "candidate_required",
    () =>
      t`This conflict has several candidates (listed above): ask the user which one, then send take_candidate again with candidate set to its index.`,
  ],
  [
    "ambiguous_table",
    () =>
      t`More than one slot has a table of this name: write it as slot.table, one of the candidates.`,
  ],
  // 04-contract §5: one item has one premise in force on one target.
  [
    "premise_duplicate_target",
    () =>
      t`An op declares one premise on one record. To rest on several of its fields, list them in one premise's fields; to rest on two stretches of business time, give one valid_during that covers both, or no range.`,
  ],
  [
    "premise_historical_ver",
    () =>
      t`This ver is a past version, as saveslot_history's as_of gives it: a premise rests on the current version. Read the record again with saveslot_query, and declare the ver it gives.`,
  ],
]);

function errorLines(error: R, now: Date): Line[] {
  const c = error["code"];
  const lines: Line[] = [
    t`Refused: ${codeIn(c, keysOf(NEXT))}${error["reason"] !== undefined ? t` (${codeIn(error["reason"], REASONS)})` : []}${error["param"] !== undefined ? t` · parameter ${untrusted(String(error["param"]))}` : []}`,
  ];
  if (error["message"] !== undefined) lines.push(t`Message: ${stored(String(error["message"]))}`);
  if (error["name"] !== undefined) lines.push(t`Not found: ${untrusted(String(error["name"]))}`);
  const nearest = arr(error["nearest"]);
  if (nearest.length > 0) {
    lines.push(
      t`Nearest: ${join(
        nearest.map((n) => tableOf(n)),
        t`, `,
      )}`,
    );
  }
  const candidates = arr(error["candidates"]);
  if (candidates.length > 0) {
    lines.push(
      t`Candidates: ${join(
        candidates.map((n) => tableOf(n)),
        t`, `,
      )}`,
    );
  }
  // candidate_required: each candidate by its index, with its write and its writer (05 §7).
  const choices = arr(error["candidate_choices"]);
  if (choices.length > 0) {
    lines.push(
      t`Candidates: ${join(
        choices.map((ch) => {
          const x = obj(ch);
          return t`${count(x["index"])} (${op(x["seq"])}, ${actorOf(x["actor"])})`;
        }),
        t` / `,
      )}`,
    );
  }
  // premise_duplicate_target: the two premises that name the same record (04-contract-types §9).
  const twice = arr(error["premises"]);
  if (
    c === "invalid_argument" &&
    error["reason"] === "premise_duplicate_target" &&
    twice.length === 2
  ) {
    lines.push(t`Same record: premises ${count(twice[0])} and ${count(twice[1])} of this op`);
  }
  // revoked: the row or entity (04-contract-types §9 `target`).
  if (error["code"] === "revoked" && isObj(error["target"])) {
    const tg = obj(error["target"]);
    const which = tg["entity"] ?? tg["row"];
    lines.push(
      t`Revoked: ${tableOf(tg["table"])}${which !== undefined ? t` ${as(String(which), id)}` : []}`,
    );
  }
  // sql_rejected: where in the statement (04-contract-types §9 `line`, `node`) and the service's
  // hint. The hint is the kernel's own text today, but nothing here tells it from a stored string,
  // so inside the boundary like a detail's `suggestion`; a node may be a name the caller wrote.
  if (c === "sql_rejected") {
    const at = [
      ...(int(error["line"]) !== undefined ? [t`line ${count(error["line"])}`] : []),
      ...(error["node"] !== undefined ? [t`at ${untrusted(String(error["node"]))}`] : []),
    ];
    if (at.length > 0) lines.push(t`Where: ${join(at, t`, `)}`);
    if (error["suggestion"] !== undefined) {
      lines.push(t`Suggestion: ${stored(String(error["suggestion"]))}`);
    }
  }
  if (c === "sql_timeout" && int(error["elapsed_ms"]) !== undefined) {
    lines.push(t`Stopped after ${count(error["elapsed_ms"])} ms`);
  }
  // item_closed: how it ended, as the item's details give it (04-contract-types §9).
  if (error["code"] === "item_closed") lines.push(...closedLines(error));
  // A complete correct example the service gives (04-contract-types §9): it may hold the
  // caller's names, so inside the boundary.
  if (isObj(error["example"])) {
    lines.push(t`Example: ${stored(JSON.stringify(error["example"]))}`);
  }
  // The values a parameter of a few takes in this version (04-contract-types §9).
  const allowed = arr(error["allowed_values"]);
  if (allowed.length > 0) lines.push(t`Allowed: ${allowedOf(allowed)}`);
  // confirmation_mismatch: the item as it is now, with its new item_ver (05 §7).
  if (isObj(error["current"])) {
    lines.push(t`The item now:`, ...pending(error["current"], now).map((l) => t`  ${l}`));
  }
  const details = arr(error["details"]);
  for (const d of details.slice(0, DETAILS_SHOWN)) {
    const x = obj(d);
    // What the detail says of how to put it right (04-contract-types §9 ValidationDetail): the
    // bounds, the units meant, a rule's line, why its SQL was refused, and a fix. A bound may be
    // the caller's own (a max under the min given: the min), so inside the boundary.
    const units = arr(x["allowed_units"]);
    const how = [
      ...(x["max"] !== undefined ? [t`at most ${untrusted(String(x["max"]))}`] : []),
      ...(x["min"] !== undefined ? [t`at least ${untrusted(String(x["min"]))}`] : []),
      ...(units.length > 0
        ? [
            t`units meant: ${join(
              units.map((u) => [untrusted(String(u))]),
              t`, `,
            )}`,
          ]
        : []),
      ...(x["line"] !== undefined ? [t`line ${count(x["line"])}`] : []),
      ...(x["sql_reason"] !== undefined ? [t`${codeIn(x["sql_reason"], SQL_REASON)}`] : []),
    ];
    lines.push(
      // Whatever the detail gives of where (04-contract-types §9 ValidationDetail): the op, the
      // table, the field, the stretch.
      t`  ${x["op"] !== undefined ? t`op ${count(x["op"])} ` : []}${x["path"] !== undefined ? t`${pathOf(x["path"])}: ` : []}${x["table"] !== undefined ? t`${tableOf(x["table"])} ` : []}${x["field"] !== undefined ? t`${fieldOf(x["field"])}: ` : []}${codeIn(x["code"], DETAIL_CODES)}${x["valid"] !== undefined ? t`, ${periodOf(x["valid"])}` : []}${how.length > 0 ? t` (${join(how, t`; `)})` : []}`,
    );
    // A fix the service worked out from what the caller wrote: inside the boundary.
    if (x["suggestion"] !== undefined) {
      lines.push(t`    suggestion: ${stored(String(x["suggestion"]))}`);
    }
    lines.push(...detailGuide(x));
  }
  if (details.length > DETAILS_SHOWN) {
    lines.push(t`  and ${num(details.length - DETAILS_SHOWN)} more`);
  }
  // Tags left in a description or an alias, as a schema document read back holds them (05 §5).
  if (details.some((d) => obj(d)["code"] === "untrusted_marker")) {
    lines.push(
      t`The document still holds the tags a result puts around stored data (in a description or an alias): remove them and submit the document again.`,
    );
  }
  if (error["required_scope"] === "all_slots") {
    lines.push(
      t`This needs a connection whose range is every slot; this connection reaches only some of them.`,
    );
  } else if (error["required_scope"] !== undefined) {
    lines.push(t`Needs: ${untrusted(String(error["required_scope"]))}`);
  }
  const narrow = arr(error["narrow_by"]);
  if (narrow.length > 0) {
    lines.push(
      t`To read less: ${join(
        narrow.map((n) => said(NARROW, n) ?? [untrusted(String(n))]),
        t`; or `,
      )}.`,
    );
  }
  if (error["incident"] !== undefined) {
    lines.push(t`Incident ${untrusted(String(error["incident"]))}`);
  }
  lines.push(...paramGuide(error));
  const why = c === "invalid_argument" ? said(REASON_NEXT, error["reason"]) : undefined;
  if (why !== undefined) lines.push(why);
  const next = c === "read_first" ? readFirstNext(error) : (ownNext(error) ?? said(NEXT, c));
  if (next !== undefined) lines.push(next);
  return lines;
}

/**
 * A refused value's parameter and the contract's values for it (04-contract-types §9: a value is
 * given only when it is one of them): such a value is a code; any other stays inside the boundary.
 */
const NOT_TAKEN_VALUES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["mode", new Set<string>(HISTORY_MODES)],
]);

/**
 * The next step where the error's own fields say it (05 §7): the operation that revoked a row,
 * a derived table's base tables, the bound a request passed, a slot not found, why a page handle
 * no longer holds. Numbers as the service gives them; names as names, or inside the boundary.
 */
function ownNext(error: R): Part[] | undefined {
  const c = error["code"];
  const reason = error["reason"];
  if (c === "sql_rejected" && error["use"] === "history") {
    return t`saveslot_sql reads the record as it is now (at a business time with at); for what was recorded before, use saveslot_history.`;
  }
  if (c === "revoked" && int(error["revoked_by"]) !== undefined) {
    return t`It was revoked at ${op(error["revoked_by"])}; to restore it, use revert: {undo: ${count(error["revoked_by"])}}.`;
  }
  if (c === "derived_readonly" && error["table"] !== undefined) {
    const bases = arr(error["base_tables"]);
    return bases.length > 0
      ? t`${tableOf(error["table"])} is a derived table, read-only: write to its base tables (${join(
          bases.map((b) => tableOf(b)),
          t`, `,
        )}) instead.`
      : t`${tableOf(error["table"])} is a derived table, read-only: write to its base tables instead.`;
  }
  if (c === "too_large" && reason === "ops" && int(error["limit"]) !== undefined) {
    return t`At most ${count(error["limit"])} ops in one write (this one has ${count(error["actual"])}): split it into several writes.`;
  }
  if (
    c === "too_large" &&
    (reason === "evidence_segment" || reason === "request") &&
    int(error["limit_bytes"]) !== undefined
  ) {
    const what = reason === "evidence_segment" ? t`one evidence segment` : t`a request's evidence`;
    return t`At most ${count(error["limit_bytes"])} bytes in ${what} (this has ${count(error["actual_bytes"])}): give a long text as a file_ref with the part that matters as its excerpt.`;
  }
  if (c === "not_in_this_version" && reason === "value" && error["value"] !== undefined) {
    const known = NOT_TAKEN_VALUES.get(String(error["param"] ?? ""));
    const value =
      known !== undefined ? codeIn(error["value"], known) : untrusted(String(error["value"]));
    // The parameter as the header gives it: inside the boundary.
    return t`This version of saveslot does not take ${untrusted(String(error["param"] ?? ""))}: ${value}.`;
  }
  if (c === "not_found" && reason === "slot") {
    return t`No slot of that name in this connection's range; saveslot_catalog lists the slots.`;
  }
  if (c === "handle_expired" && reason === "derived_changed") {
    return t`The derived table was refreshed since the first page: read again from the first page, without cursor.`;
  }
  if (c === "handle_expired" && reason === "expired") {
    return t`The cursor has expired: run the query again from the first page, without cursor.`;
  }
  return undefined;
}

/**
 * The next step of a `read_first` (05 §7): by what is to be read and why the fallback found
 * nothing. A task name is the caller's own text: inside the boundary.
 */
function readFirstNext(error: R): Part[] {
  const target = error["target"];
  if (error["reason"] === "task_mismatch") {
    const taskOf = (x: unknown): Part[] =>
      typeof x === "string" ? t`task ${untrusted(x)}` : t`no task`;
    if (target === "table") {
      return t`It was read under ${taskOf(error["read_task"])}; this call has ${taskOf(error["task"])}. A "my_last_read" counts only a read under the same task: use the same task, or give since an operation number or a moment.`;
    }
    const pass = target === "slot" ? t`sv` : target === "item" ? t`item_ver` : t`ver`;
    return t`It was read under ${taskOf(error["read_task"])}; this call has ${taskOf(error["task"])}. A left-out ${pass} is taken only from a read under the same task: pass ${pass}, or use the same task.`;
  }
  if (target === "slot") {
    return t`Pass sv (the slot's schema version, from saveslot_catalog), or read the slot once with saveslot_catalog or saveslot_query.`;
  }
  if (target === "item") {
    return t`Look at the item first with saveslot_pending, then send it again with the item_ver you read.`;
  }
  if (target === "table") return t`Read the table first with saveslot_query.`;
  return t`Read the row first (saveslot_query), then write with the ver you read.`;
}

/** A contract error as text (05 §7): what was refused, and the next step; never no text. */
export function renderError(error: R, now: Date = new Date()): string {
  try {
    return render(errorLines(error, now));
  } catch {
    return renderJson([], asPlain({ error }, { error: { code: "internal" } }));
  }
}
