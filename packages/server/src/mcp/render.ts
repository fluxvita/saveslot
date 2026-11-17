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
  if (parts.length <= 2 && parts.every((p) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(p))) {
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

/** A period of business time (05 §4.1). */
function periodOf(x: unknown): Part[] {
  const p = obj(x);
  const from = p["valid_from"];
  const to = p["valid_to"];
  const last = p["valid_to_inclusive"];
  if (from === null || from === undefined) return t`all time`;
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

const AFFECTED: ReadonlyMap<string, () => Part[]> = new Map([
  ["correct", () => t`⚠ a value you read was corrected since`],
  ["revoke", () => t`⚠ a record in a value you read was revoked since`],
  ["retroactive", () => t`⚠ the value at the business time you read was changed afterwards`],
  ["plan_changed", () => t`⚠ the future arrangement you read has changed`],
]);
const PREMISE_VERB: ReadonlyMap<string, () => Part[]> = new Map([
  ["correct", () => t`corrected`],
  ["update", () => t`changed`],
  ["revoke", () => t`revoked`],
  ["retroactive", () => t`changed retroactively`],
  ["plan_changed", () => t`changed for what comes after`],
  ["deleted", () => t`deleted`],
]);

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
  return counts.length > 0 ? t`⚠ among its inputs: ${join(counts, t`, `)}` : [];
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
  if (row["key"] !== undefined) head.push(...t` ${namedValues(row["key"])}`);
  const cells: Part[][] = [];
  if (Object.hasOwn(row, "valid_from")) cells.push(periodOf(row));
  const values = valuesOf(row["values"]);
  if (values.length > 0) cells.push(values);
  const tail = [...m.inline, inputMarksOf(row["input_marks"])].filter((x) => x.length > 0);
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

const WARNINGS: ReadonlyMap<string, () => Part[]> = new Map([
  ["unit_converted", () => t`converted to the field's unit`],
  ["rounded", () => t`rounded to the field's precision`],
  ["timezone_assumed", () => t`a moment without a zone was taken in the slot's time zone`],
  ["time_truncated", () => t`the time was cut to the table's granularity`],
  ["ver_fallback", () => t`no ver was given: the one you last read was used`],
  ["sv_fallback", () => t`no sv was given: the one you last read was used`],
  ["item_ver_fallback", () => t`no item_ver was given: the one you last read was used`],
  ["renamed", () => t`a field was renamed`],
  ["overwrote_corroborated", () => t`a value corroborated by other evidence was overwritten`],
  ["pending_deletion_on_target", () => t`the row has a deletion that can still be undone`],
  ["clock_behind_log", () => t`this machine's clock is behind the log; the log's time was used`],
  [
    "evidence_unreferenced",
    () => t`an evidence segment is used by no op: stored, but the source of no value`,
  ],
  ["evidence_not_stored", () => t`nothing was recorded, and the evidence was not stored`],
  ["premise_ver_fallback", () => t`a premise without ver: the one you last read was used`],
  [
    "premise_already_changed",
    () => t`a premise had changed since you read it; the row carries "premise changed"`,
  ],
  ["external_key_skipped", () => t`some ops were skipped`],
]);

/** Warnings and notices (05 §4.3): one line each; notices at most 3. */
function remindersOf(r: R): Line[] {
  const out: Line[] = [];
  for (const w of arr(r["warnings"])) {
    const c = obj(w)["code"];
    // multi_segment_unmapped stays in the structured result only (05 §4.3).
    if (c === "multi_segment_unmapped") continue;
    const text = said(WARNINGS, c);
    const at = int(obj(w)["op"]);
    out.push(
      text !== undefined
        ? t`Note (${codeIn(c, keysOf(WARNINGS))}${at !== undefined ? t`, op ${num(at)}` : []}): ${text}`
        : t`Note: ${untrusted(String(c))}`,
    );
  }
  for (const n of arr(r["notices"]).slice(0, 3)) {
    out.push(t`Notice: ${untrusted(JSON.stringify(n))}`);
  }
  return out;
}

const FIELD_TYPES: ReadonlySet<string> = new Set([
  "text",
  "integer",
  "decimal",
  "boolean",
  "enum",
  "date",
  "zoned_datetime",
  "quantity",
  "ref",
]);
const GRANULARITIES: ReadonlySet<string> = new Set(["date", "instant"]);

// --- catalog -----------------------------------------------------------------------------------

/** The tables of a catalog's list page. */
const tablesIn = (r: R) =>
  arr(r["slots"]).reduce<number>((n, s) => n + arr(obj(s)["tables"]).length, 0);

function catalog(r: R): Line[] | { json: true; lead: Line[] } {
  need(
    (r["level"] === "schema" && isObj(r["document"])) ||
      (r["level"] === "table" && Array.isArray(r["tables"])) ||
      Array.isArray(r["slots"]),
  );
  if (r["level"] === "schema") {
    return {
      json: true,
      lead: [
        t`${tableOf(r["slot"])} · schema v${count(r["sv"])}: the full schema document and the slot's policy (read-only), as JSON. To change the schema, edit the document and submit it without the tags.`,
      ],
    };
  }
  if (r["level"] === "table") {
    const out: Line[] = [];
    for (const x of arr(r["tables"])) {
      const tb = obj(x);
      const tm = obj(tb["time"]);
      const kind =
        tb["kind"] === "derived"
          ? t`derived · read-only`
          : tm["type"] === "event"
            ? t`base · event, by ${fieldOf(tm["field"])}`
            : tm["type"] === "state"
              ? t`base · state, by ${codeIn(tm["granularity"], GRANULARITIES)}`
              : t`base · no time`;
      out.push(
        t`${tableOf(tb["slot"])} · schema v${count(tb["sv"])} · ${untrusted(String(tb["timezone"] ?? ""))}`,
      );
      out.push(t`${tableOf(tb["table"])} (${kind}) ${stored(String(tb["description"] ?? ""))}`);
      for (const f of arr(tb["fields"])) {
        const fd = obj(f);
        const unit = fd["unit"] !== undefined ? t` ${untrusted(String(fd["unit"]))}` : [];
        const scale = int(obj(fd["precision"])["scale"]);
        const decimals = scale !== undefined ? t` ${num(scale)} decimal places` : [];
        const required = fd["required"] === true ? t` · required` : [];
        out.push(
          t`  ${fieldOf(fd["name"])}  ${codeIn(fd["type"], FIELD_TYPES)}${unit}${decimals}  ${stored(String(fd["description"] ?? ""))}${required}`,
        );
      }
    }
    return out;
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
      const aliases = arr(tb["aliases"]);
      out.push(
        t`  ${tableOf(tb["table"])} (${kind}) ${stored(String(tb["description"] ?? ""))}${
          aliases.length > 0
            ? t` · aliases: ${join(
                aliases.map((a) => untrusted(String(a))),
                t`, `,
              )}`
            : []
        }`,
      );
    }
  }
  if (out.length === 0) out.push(t`No slots yet.`);
  return [...out, ...pageOf(r, tablesIn(r), () => t`tables`)];
}

// --- query and history --------------------------------------------------------------------------

function query(r: R): Line[] {
  need(Array.isArray(r["rows"]) && typeof r["table"] === "string");
  const rows = arr(r["rows"]);
  return [
    t`${tableOf(r["table"])} · ${tableOf(r["slot"])} schema v${count(r["sv"])} · ${ofTotal(rows.length, r["total"])} rows`,
    ...rowsOf(rows),
    ...pageOf(r, rows.length, () => t`rows`),
  ];
}

const INTENTS: ReadonlySet<string> = new Set([
  "insert",
  "update",
  "correct",
  "revoke",
  "deletion",
  "deletion_cancelled",
  "schema_switch",
]);

const RESULT: ReadonlyMap<string, () => Part[]> = new Map([
  ["applied", () => t``],
  ["candidate", () => t` (candidate, not in effect)`],
  ["awaiting", () => t` (awaiting confirmation, not in effect)`],
  ["corroborated", () => t` (unchanged; added as evidence)`],
  ["noop", () => t` (unchanged)`],
]);
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

function history(r: R): Line[] {
  need(Array.isArray(r["entries"]) || (r["mode"] === "as_of" && Array.isArray(r["rows"])));
  if (r["mode"] === "as_of") {
    const at = obj(r["as_of"]);
    const rows = arr(r["rows"]);
    return [
      t`As of ${op(at["seq"])} (${inZone(at["recorded_at"], r["timezone"])}) · schema v${count(r["sv"])}`,
      ...(rows.length > 0 ? rowsOf(rows, true) : [t`It did not exist yet.`]),
      ...pageOf(r, rows.length, () => t`rows`),
    ];
  }
  const entries = arr(r["entries"]);
  const out: Line[] = [
    t`${targetOf(r["target"])} · current ver=${idOf(r["ver"])} · ${ofTotal(entries.length, r["total"])} changes`,
  ];
  for (const e of entries) {
    const x = obj(e);
    const fields = Object.entries(obj(x["fields"])).map(([f, v]) => {
      const c = obj(v);
      const change = Object.hasOwn(c, "before")
        ? t`${fieldValue(c["before"])} → ${fieldValue(c["after"])}`
        : fieldValue(c["after"]);
      return t`${fieldOf(f)} ${change}${resultOf(c["result"])}${sourcesOf(c["sources"])}`;
    });
    out.push(
      t`${op(x["seq"])} ${inZone(x["recorded_at"], r["timezone"])} ${codeIn(x["intent"], INTENTS)}  ${actorOf(x["actor"])}  ${join(fields, t`; `)}`,
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
  return [...out, ...pageOf(r, entries.length, () => t`changes`)];
}

// --- pending ------------------------------------------------------------------------------------

const ITEM_TYPES: ReadonlySet<string> = new Set([
  "conflict",
  "awaiting_confirmation",
  "flagged",
  "schema_change",
  "deletion",
]);
const ITEM_REASONS: ReadonlySet<string> = new Set([
  "overwrites_change_point",
  "referenced_row",
  "undo_includes_later",
  "undo_hides_later",
  "conflict_cleared_by_deletion",
  "policy_high_impact",
  "duplicate_keys",
  "stale_write",
  "restored_candidate",
  "schema_change",
  "request",
  "restored_unconfirmed",
  "restored_pending",
  "restored_executed",
]);
const ITEM_STATUS: ReadonlySet<string> = new Set(["open", "resolved", "superseded"]);
const DECISIONS: ReadonlySet<string> = new Set([
  "keep_effective",
  "take_candidate",
  "take_previous",
  "confirm",
  "reject",
  "keep",
  "revoke",
  "cancel",
]);
const reasonOf = (x: unknown): Part[] => (x === undefined ? [] : t` · ${codeIn(x, ITEM_REASONS)}`);

function itemTarget(x: unknown): Part[] {
  const tg = obj(x);
  const unit = arr(tg["unit"]);
  return t`${targetOf(tg)}${unit.length > 0 ? t` ${join(unit.map(fieldOf), t`, `)}` : []}`;
}

function pending(r: R): Line[] {
  need(typeof r["id"] === "string" || Array.isArray(r["items"]));
  if (r["id"] !== undefined) {
    const out: Line[] = [
      t`${idOf(r["id"])} ${codeIn(r["type"], ITEM_TYPES)} · ${itemTarget(r["target"])}${reasonOf(r["reason"])} · ${codeIn(r["status"], ITEM_STATUS)} · opened ${timeOf(r["opened_at"])} by ${actorOf(r["opened_by"])}${r["item_ver"] !== undefined ? t` · version ${idOf(r["item_ver"])}` : []}`,
    ];
    if (isObj(r["effective"])) {
      const e = r["effective"];
      out.push(
        t`  In effect: ${e["exists"] === false ? t`no row` : namedValues(e["values"])} (${op(e["seq"])}, ${actorOf(e["actor"])})`,
      );
    }
    for (const c of arr(r["candidates"])) {
      const x = obj(c);
      out.push(
        t`  Candidate ${count(x["index"])}: ${namedValues(x["values"])} (${op(x["seq"])}, ${actorOf(x["actor"])}, ${codeIn(x["intent"], INTENTS)})`,
      );
    }
    if (isObj(r["previous"])) {
      const p = r["previous"];
      out.push(
        t`  Before: ${p["exists"] === false ? t`no row` : namedValues(p["values"])} (${op(p["seq"])})`,
      );
    }
    const reverted = arr(r["reverted_by_previous"]);
    if (reverted.length > 0) {
      out.push(
        t`  take_previous would undo: ${join(
          reverted.map((x) => t`${op(obj(x)["seq"])} (${actorOf(obj(x)["actor"])})`),
          t`, `,
        )}`,
      );
    }
    if (isObj(r["impact"])) out.push(t`  Impact: ${stored(JSON.stringify(r["impact"]))}`);
    if (isObj(r["resolution"])) {
      const res = obj(r["resolution"]);
      const note = res["note"] !== undefined ? t` · note ${stored(String(res["note"]))}` : [];
      out.push(
        t`  Resolved: ${codeIn(res["decision"], DECISIONS)} (${op(res["seq"])}, ${actorOf(res["actor"])})${note}`,
      );
    }
    const decisions = arr(r["decisions"]).map((d) => codeIn(d, DECISIONS));
    if (decisions.length > 0) out.push(t`  Choices: ${join(decisions, t` / `)}`);
    return [...out, ...remindersOf(r)];
  }
  const items = arr(r["items"]);
  const out: Line[] = [t`${ofTotal(items.length, r["total"])} pending items`];
  for (const i of items) {
    const x = obj(i);
    out.push(
      t`${idOf(x["id"])} ${codeIn(x["type"], ITEM_TYPES)} · ${itemTarget(x["target"])}${reasonOf(x["reason"])} · opened ${timeOf(x["opened_at"])}${x["overdue"] === true ? t` · overdue, not yet deleted; will be retried` : []}`,
    );
  }
  return [...out, ...pageOf(r, items.length, () => t`items`), ...remindersOf(r)];
}

// --- write and resolve ---------------------------------------------------------------------------

/** One field's result in a receipt (05 §6 `saveslot_write`). */
function fieldResult(f: string, x: unknown): Part[] {
  const c = obj(x);
  const period = isObj(c["valid"]) ? t` ${periodOf(c["valid"])}` : [];
  const result = str(c["result"]) ?? "applied";
  if (result === "candidate" || result === "awaiting") {
    const by = obj(c["by"]);
    const now =
      c["effective"] !== undefined
        ? t`; in effect is ${fieldValue(c["effective"])}${by["seq"] !== undefined ? t` (${op(by["seq"])}${c["current_ver"] !== undefined ? t`, ver=${idOf(c["current_ver"])}` : []})` : []}`
        : [];
    return t`${fieldOf(f)}${period} not in effect: yours (${fieldValue(c["after"])}) ${result === "candidate" ? t`is a candidate` : t`awaits confirmation`} in ${idOf(c["item"])}${now}`;
  }
  if (result === "corroborated")
    return t`${fieldOf(f)}${period} unchanged; this was added as its evidence`;
  if (result === "noop") return [];
  const before = Object.hasOwn(c, "before") ? t`${fieldValue(c["before"])} → ` : [];
  return t`${fieldOf(f)}${period} ${before}${fieldValue(c["after"])}`;
}

function receiptOps(r: R): Line[] {
  const out: Line[] = [];
  for (const o of arr(r["ops"])) {
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
    out.push(
      t`${targetOf(x["target"])} ${codeIn(x["intent"], INTENTS)}: ${what}${x["ver"] !== undefined ? t` (ver=${idOf(x["ver"])})` : []}${created}`,
    );
  }
  const more = int(r["ops_omitted"]);
  if (more !== undefined && more > 0) {
    out.push(t`${num(more)} more ops are left out of this receipt: saveslot_history shows them`);
  }
  return out;
}

function receiptTail(r: R): Line[] {
  const out: Line[] = [];
  for (const d of arr(r["derived"])) out.push(t`Derived: ${stored(JSON.stringify(d))}`);
  for (const p of arr(r["pending"])) {
    const x = obj(p);
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
    out.push(t`Superseded: ${idOf(x["item"])} ${codeIn(x["type"], ITEM_TYPES)}`);
  }
  if (isObj(r["affected_reads"])) {
    out.push(t`Earlier reads used the old value: ${stored(JSON.stringify(r["affected_reads"]))}`);
  }
  if (isObj(r["premise_affected"])) {
    out.push(t`Rows whose premises changed: ${stored(JSON.stringify(r["premise_affected"]))}`);
  }
  return [...out, ...remindersOf(r), ...shortened(r)];
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

const STATUSES: ReadonlySet<string> = new Set(["saved", "pending"]);

function write(r: R): Line[] {
  need(Array.isArray(r["ops"]) && STATUSES.has(String(r["status"])));
  const status = r["status"] === "pending" ? t`Recorded, not all in effect` : t`Saved`;
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
  out.push(t`${status} · schema v${count(r["sv"])}${seq}`);
  return [...out, ...receiptOps(r), ...receiptTail(r)];
}

function resolve(r: R): Line[] {
  need(typeof r["id"] === "string" && typeof r["decision"] === "string");
  const head = t`${idOf(r["id"])} ${codeIn(r["type"], ITEM_TYPES)}: ${codeIn(r["decision"], DECISIONS)} · ${codeIn(r["status"], ITEM_STATUS)}${r["item_ver"] !== undefined ? t` · version ${idOf(r["item_ver"])}` : []}`;
  const replayed =
    r["replayed"] === true
      ? [t`This item was already resolved this way; nothing new was changed.`]
      : [];
  const receipt = isObj(r["write"]) ? [...receiptOps(r["write"]), ...receiptTail(r["write"])] : [];
  return [head, ...replayed, ...receipt, ...remindersOf(r)];
}

const RENDER: ReadonlyMap<ToolName, (r: R) => Line[] | { json: true; lead: Line[] }> = new Map<
  ToolName,
  (r: R) => Line[] | { json: true; lead: Line[] }
>([
  ["saveslot_catalog", catalog],
  ["saveslot_query", query],
  ["saveslot_history", history],
  ["saveslot_pending", pending],
  ["saveslot_write", write],
  ["saveslot_resolve", resolve],
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
export function renderStrict(tool: ToolName, result: R): string {
  const f = RENDER.get(tool);
  if (f === undefined) throw new Error("no renderer");
  const out = f(result);
  return Array.isArray(out) ? render(out) : renderJson(out.lead, result);
}

/** A tool's result as text; JSON as written when its renderer cannot give it. */
export function renderResult(tool: ToolName, result: R): string {
  try {
    return renderStrict(tool, result);
  } catch {
    // A shape the renderer did not expect, or a renderer's fault: the whole of it inside the
    // boundary instead.
    return renderJson([], asPlain(result, { result: "not shown" }));
  }
}

// --- errors -------------------------------------------------------------------------------------

const NEXT: ReadonlyMap<string, () => Part[]> = new Map([
  ["invalid_argument", () => t`Check the parameter named, and send the request again.`],
  ["unknown_table", () => t`Use saveslot_catalog to see the tables.`],
  ["unknown_field", () => t`Use saveslot_catalog with level "table" to see the fields.`],
  [
    "not_found",
    () =>
      t`It may have been deleted, or be out of this connection's range; locate it again with saveslot_query.`,
  ],
  ["revoked", () => t`To restore it, use revert: {undo: n} with the operation that revoked it.`],
  ["derived_readonly", () => t`Derived tables are read-only: write to their source tables.`],
  ["validation_failed", () => t`Correct the values named, and send the request again.`],
  [
    "insufficient_scope",
    () => t`This connection may not do this; the user can use a connection that may.`,
  ],
  ["not_in_this_version", () => t`This is not in this version of saveslot.`],
  ["too_large", () => t`Ask for less.`],
  ["unavailable", () => t`saveslot is not ready; try again shortly.`],
  ["internal", () => t`An error inside saveslot; the incident is logged.`],
  ["read_first", () => t`Read the row first (saveslot_query), then write with the ver you read.`],
]);

/** The reasons of the contract's errors this version gives (04-contract-types §9). */
const ERROR_REASONS: ReadonlySet<string> = new Set([
  "malformed",
  "missing",
  "mutually_exclusive",
  "not_implemented",
  "parameter",
  "operation",
  "value",
  "slot",
  "draft",
  "route",
  "cursor",
  "request_body",
  "result_budget",
  "starting",
  "no_read",
  "schema",
  "write",
  "idempotency_key_reuse",
  "invalid",
  "revoked",
]);

/** The codes of a validation's details this version gives. */
const DETAIL_CODES: ReadonlySet<string> = new Set([
  "type_mismatch",
  "required_missing",
  "out_of_range",
  "unknown_enum",
  "description_missing",
  "duplicate_name",
  "untrusted_marker",
]);

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
]);

/** The details shown of a refusal; the rest are counted. */
const DETAILS_SHOWN = 20;

function errorLines(error: R): Line[] {
  const c = error["code"];
  const lines: Line[] = [
    t`Refused: ${codeIn(c, keysOf(NEXT))}${error["reason"] !== undefined ? t` (${codeIn(error["reason"], ERROR_REASONS)})` : []}${error["param"] !== undefined ? t` · parameter ${untrusted(String(error["param"]))}` : []}`,
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
  const details = arr(error["details"]);
  for (const d of details.slice(0, DETAILS_SHOWN)) {
    const x = obj(d);
    lines.push(
      t`  ${x["op"] !== undefined ? t`op ${count(x["op"])} ` : []}${x["field"] !== undefined ? t`${fieldOf(x["field"])}: ` : []}${codeIn(x["code"], DETAIL_CODES)}`,
    );
  }
  if (details.length > DETAILS_SHOWN) {
    lines.push(t`  and ${num(details.length - DETAILS_SHOWN)} more`);
  }
  if (error["required_scope"] !== undefined) {
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
  const next = said(NEXT, c);
  if (next !== undefined) lines.push(next);
  return lines;
}

/** A contract error as text (05 §7): what was refused, and the next step; never no text. */
export function renderError(error: R): string {
  try {
    return render(errorLines(error));
  } catch {
    return renderJson([], asPlain({ error }, { error: { code: "internal" } }));
  }
}
