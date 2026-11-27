// The text of reads (docs/zh-CN/spec/06-cli.md §4.7, §6.1): `query` rows with their marks, and
// `history` as a timeline or as of a point. Written after the MCP renderer's text (05-surfaces §4,
// §6), with the next steps as CLI commands. Every string of a stored value goes inside the
// boundary; what stands outside is the renderer's wording and what passes a shape check.

import {
  type AffectedReason,
  type AsOfResult,
  type ChangesResult,
  type FieldResultCode,
  type PremiseReason,
  type QueryResult,
  SOURCE_LEVELS,
  type SqlResult,
  type TimelineResult,
  VERSION_INTENTS,
} from "@fluxvita/saveslot-client";
import { warningsAndNotices } from "./results.ts";
import {
  code,
  handle,
  id,
  inZone,
  join,
  type Line,
  name,
  num,
  type Part,
  t,
  table,
  time,
  untrusted,
} from "./text.ts";

export type R = Readonly<Record<string, unknown>>;
export const isObj = (x: unknown): x is R =>
  typeof x === "object" && x !== null && !Array.isArray(x);
export const obj = (x: unknown): R => (isObj(x) ? x : {});
export const arr = (x: unknown): readonly unknown[] => (Array.isArray(x) ? x : []);
export const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
export const int = (x: unknown): number | undefined =>
  typeof x === "number" && Number.isInteger(x) ? x : undefined;

/** An ID or version the service made; inside when it is not one. */
export const idOf = (x: unknown): Part => id(String(x ?? ""));
/** An operation number. */
export const op = (x: unknown): Part[] =>
  t`#${int(x) !== undefined ? num(int(x) as number) : untrusted(String(x))}`;
/** A count or a version number. */
export const count = (x: unknown): Part =>
  int(x) !== undefined ? num(int(x) as number) : untrusted(String(x));
/** A table's name: checked by its shape. */
const tableOf = (x: unknown): Part => table(String(x ?? ""));
/** A field name; `*` is a row's being there. */
export const fieldOf = (x: unknown): Part[] =>
  x === "*" ? t`whether it exists` : [name(String(x ?? ""))];

/** Who did something: the system, or the name it was given (inside), and its state. */
export function actorOf(x: unknown): Part[] {
  const a = obj(x);
  if (a["kind"] === "system") return t`system`;
  const label = str(a["name"]) ?? str(a["id"]) ?? "";
  const state =
    a["state"] === "revoked" ? t` (revoked)` : a["state"] === "disabled" ? t` (disabled)` : [];
  return [untrusted(label), ...state];
}

const BOOLEANS: ReadonlySet<string> = new Set(["true", "false"]);

/**
 * A field's value: JSON's numbers, booleans and null, and a quantity's number, outside the
 * boundary; every string inside, whatever it looks like (an RFC 9557 moment included).
 */
export function fieldValue(v: unknown): Part[] {
  if (v === null || v === undefined) return t`—`;
  if (typeof v === "boolean") return [code(String(v), BOOLEANS)];
  if (typeof v === "number") return [num(v)];
  if (typeof v === "string") return [untrusted(v)];
  if (isObj(v) && Object.hasOwn(v, "value") && Object.hasOwn(v, "unit")) {
    const value = v["value"];
    return t`${typeof value === "string" ? num(value) : fieldValue(value)} ${untrusted(String(v["unit"]))}`;
  }
  return [untrusted(JSON.stringify(v))];
}

/** Values with their fields: `field value, field value`. */
export const namedValues = (values: unknown): Part[] =>
  join(
    Object.entries(obj(values)).map(([f, v]) => t`${fieldOf(f)} ${fieldValue(v)}`),
    t`, `,
  );

/** A period of business time (05 §4.1): the dates and moments are values, inside. */
/**
 * A state row's stretch: an end left out, as one a deletion removed is (04-contract `history`
 * `as_of`: the key absent, the row marked `partially_deleted`), written "(deleted)", not read as
 * open; with both ends there, as any period.
 */
function rowPeriodOf(row: R): Part[] {
  const hasFrom = Object.hasOwn(row, "valid_from");
  const hasTo = Object.hasOwn(row, "valid_to");
  if (hasFrom && hasTo) return periodOf(row);
  const from = hasFrom ? untrusted(String(row["valid_from"])) : t`(deleted)`;
  if (hasTo && row["valid_to"] === null) return t`from ${from}`;
  const last = row["valid_to_inclusive"];
  if (!hasTo) return t`${from} until (deleted)`;
  return last !== undefined
    ? t`${from} to ${untrusted(String(last))} (inclusive)`
    : t`${from} until ${untrusted(String(row["valid_to"]))}`;
}

export function periodOf(x: unknown): Part[] {
  const p = obj(x);
  const from = p["valid_from"];
  const to = p["valid_to"];
  const last = p["valid_to_inclusive"];
  if (from === null || from === undefined) {
    // Open at the start too: a write-back taking back a revoke of the whole time (09 §1.2).
    if (to === null || to === undefined) return t`all time`;
    return last !== undefined
      ? t`through ${untrusted(String(last))} (inclusive)`
      : t`until ${untrusted(String(to))}`;
  }
  if (to === null || to === undefined) return t`from ${untrusted(String(from))}`;
  if (last !== undefined)
    return t`${untrusted(String(from))} to ${untrusted(String(last))} (inclusive)`;
  return t`${untrusted(String(from))} until ${untrusted(String(to))}`;
}

/** A row's or entity's reference: its table and ID. */
export function targetOf(x: unknown): Part[] {
  const r = obj(x);
  const ref = r["row"] ?? r["entity"];
  return ref !== undefined ? t`${tableOf(r["table"])} ${idOf(ref)}` : [tableOf(r["table"])];
}

const said = (m: ReadonlyMap<string, () => Part[]>, x: unknown): Part[] | undefined =>
  typeof x === "string" ? m.get(x)?.() : undefined;
/**
 * A table of texts by the contract's codes: written as an object `satisfies Record<Code, …>`, so a
 * code the contract adds or drops fails to compile here (no hand-kept list falls behind).
 */
const textsBy = <K extends string>(o: Record<K, () => Part[]>): ReadonlyMap<string, () => Part[]> =>
  new Map(Object.entries(o) as [string, () => Part[]][]);

const AFFECTED = textsBy<AffectedReason>({
  correct: () => t`! a value read was corrected since`,
  revoke: () => t`! a record in a value read was revoked since`,
  retroactive: () => t`! the value at the business time read was changed afterwards`,
  plan_changed: () => t`! the future arrangement read has changed`,
});
const PREMISE_VERB = textsBy<PremiseReason>({
  correct: () => t`corrected`,
  update: () => t`changed`,
  revoke: () => t`revoked`,
  retroactive: () => t`changed retroactively`,
  plan_changed: () => t`changed for what comes after`,
  deleted: () => t`deleted`,
  schema_switched: () => t`dropped by a schema change`,
});

/**
 * A row's marks (05 §4.2), on its line; premises changed, each on a line of its own. The next
 * step for an item is a CLI command.
 */
function marksOf(m: unknown): { inline: Part[][]; below: Line[] } {
  const k = obj(m);
  const inline: Part[][] = [];
  for (const d of arr(k["disputed"])) {
    const x = obj(d);
    inline.push(
      t`! disputed (${idOf(x["item"])}: ${join(arr(x["fields"]).map(fieldOf), t`, `)}; saveslot pending show ${idOf(x["item"])})`,
    );
  }
  for (const a of arr(k["awaiting"])) {
    const x = obj(a);
    const what =
      x["proposed"] === null
        ? t`proposed: revoke`
        : isObj(x["proposed_revert"])
          ? t`proposed: undo ${op(x["proposed_revert"]["undo"])}`
          : t`proposed: ${namedValues(x["proposed"])}`;
    inline.push(t`! a change awaiting confirmation (${idOf(x["item"])}): ${what}`);
  }
  for (const f of arr(k["flagged"])) {
    const x = obj(f);
    const related = isObj(x["related"]) ? t`: may duplicate ${targetOf(x["related"])}` : [];
    inline.push(t`! flagged (${idOf(x["item"])})${related}`);
  }
  if (k["corrected"] === true) inline.push(t`corrected`);
  if (isObj(k["revoked"])) inline.push(t`revoked (${op(k["revoked"]["seq"])})`);
  if (isObj(k["possibly_affected"])) {
    const reason = k["possibly_affected"]["reason"];
    inline.push(said(AFFECTED, reason) ?? t`! possibly affected (${untrusted(String(reason))})`);
  }
  if (k["partially_deleted"] === true) inline.push(t`partly deleted`);
  if (isObj(k["pending_deletion"])) {
    inline.push(t`a deletion that can still be undone (${idOf(k["pending_deletion"]["item"])})`);
  }
  for (const r of arr(k["dangling_ref"])) {
    const x = obj(r);
    inline.push(
      t`! ${fieldOf(x["field"])} points to a record that was ${x["state"] === "deleted" ? t`deleted` : t`revoked`}`,
    );
  }
  if (k["computed_at_read"] === true) inline.push(t`computed when read, no ver`);
  const below: Line[] = [];
  for (const p of arr(k["premise_changed"])) {
    const x = obj(p);
    const covers = arr(x["fields"]);
    const coverage =
      covers.length > 0
        ? t`covers this row's ${join(covers.map(fieldOf), t`, `)}`
        : t`covers the whole row`;
    // Its target's table (or slot) not seen: only what is of this row, as a whole sentence.
    if (x["hidden"] === true) {
      below.push(
        t`  ! premise changed: a record this row rests on, in a table you cannot see, changed in ${op(x["since"])}; ${coverage}`,
      );
      continue;
    }
    const fields = arr(x["premise_fields"]);
    const what = fields.length > 0 ? t`the ${join(fields.map(fieldOf), t`, `)} of ` : [];
    const verb = said(PREMISE_VERB, x["reason"]) ?? [untrusted(String(x["reason"]))];
    below.push(
      t`  ! premise changed: ${what}${targetOf(x["premise"])} (seen ${idOf(x["seen"])}) was ${verb} in ${op(x["since"])}; ${coverage}`,
    );
  }
  const total = int(k["premise_changed_total"]);
  if (total !== undefined) below.push(t`  ${num(total)} premises changed in all`);
  return { inline, below };
}

/**
 * Input marks (05 §4.2): the counts, and the open items among them; `among` names what they are
 * among (a derived row's inputs, the rows a statement read).
 */
function inputMarksOf(x: unknown, among: () => Part[] = () => t`its inputs`): Part[] {
  if (!isObj(x)) return [];
  const counts: Part[][] = [];
  for (const [k, label] of [
    ["flagged", () => t`flagged`],
    ["disputed", () => t`disputed`],
    ["awaiting", () => t`awaiting confirmation`],
    ["premise_changed", () => t`with a changed premise`],
  ] as const) {
    const n = int(x[k]);
    if (n !== undefined && n > 0) counts.push(t`${num(n)} ${label()}`);
  }
  const items = arr(x["items"]);
  const listed =
    items.length > 0
      ? t` (${join(
          items.map((i) => [idOf(i)]),
          t`, `,
        )})`
      : [];
  return counts.length > 0 ? t`! among ${among()}: ${join(counts, t`, `)}${listed}` : [];
}

/** One row of a read: its ID and ver, its period, its values, its marks. */
function rowLine(row: R, historical: boolean, first: boolean): Line[] {
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
  // A state row has a stretch, even with an end left out.
  if (Object.hasOwn(row, "entity") && !Object.hasOwn(row, "key")) cells.push(rowPeriodOf(row));
  const values = namedValues(row["values"]);
  if (values.length > 0) cells.push(values);
  const tail = [...m.inline, inputMarksOf(row["input_marks"])].filter((x) => x.length > 0);
  const line = join([head.length > 0 ? head : t` `, ...cells, ...tail], t` | `);
  return [line, ...m.below, ...detailOf(row["detail"])];
}

const LEVELS: ReadonlySet<string> = new Set<string>(SOURCE_LEVELS);
/** A field's literal result (04-contract-types §4.1 `RowDetail`). */
const LITERAL = textsBy<"hit" | "miss" | "na">({
  hit: () => t`literal hit`,
  miss: () => t`literal miss`,
  na: () => t`literal not applicable`,
});

/**
 * `--detail detailed` (06 §4.7, as 05 §4.1 words it): below the row, its last change and when; each
 * field's literal result and source level, a ref field's summary of the record it names; each
 * premise in effect, changed or not. One on a table you cannot see: only what is of this row.
 */
function detailOf(d: unknown): Line[] {
  if (!isObj(d)) return [];
  const out: Line[] = [
    t`  last changed in ${op(d["seq"])}, recorded ${time(String(d["recorded_at"] ?? ""))}`,
  ];
  for (const [field, v] of Object.entries(obj(d["fields"]))) {
    const x = obj(v);
    const level = x["level"] !== undefined ? t`, ${code(String(x["level"]), LEVELS)}` : [];
    const literal = said(LITERAL, x["literal"]) ?? [untrusted(String(x["literal"]))];
    const ref = isObj(x["ref"]) ? t` · names ${namedValues(x["ref"]["values"])}` : [];
    out.push(t`  ${fieldOf(field)}: ${literal}${level}${ref}`);
  }
  for (const p of arr(d["premises"])) {
    const x = obj(p);
    const covers = arr(x["fields"]);
    const coverage =
      covers.length > 0
        ? t`covers this row's ${join(covers.map(fieldOf), t`, `)}`
        : t`covers the whole row`;
    const state =
      x["state"] === "changed"
        ? t`changed: ${said(PREMISE_VERB, x["reason"]) ?? [untrusted(String(x["reason"]))]}${x["since"] !== undefined ? t` in ${op(x["since"])}` : []}`
        : t`unchanged`;
    if (x["hidden"] === true) {
      out.push(t`  premise: a record in a table you cannot see · ${coverage} · ${state}`);
      continue;
    }
    const fields = arr(x["premise_fields"]);
    const what = fields.length > 0 ? t`the ${join(fields.map(fieldOf), t`, `)} of ` : [];
    const declared = obj(x["declared"]);
    out.push(
      t`  premise: ${what}${targetOf(x["premise"])} (seen ${idOf(x["seen"])}) · ${coverage} · declared in ${op(declared["seq"])} by ${actorOf(declared["actor"])} · ${state}`,
    );
  }
  return out;
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

/** How much of a page was shown, and the next page as a CLI option. */
function pageOf(r: R, shown: number, unit: () => Part[]): Line[] {
  const next = str(r["next_cursor"]);
  const total = int(r["total"]);
  const out: Line[] = [];
  if (total !== undefined && shown < total)
    out.push(t`${num(shown)} of ${num(total)} ${unit()} shown`);
  if (next !== undefined) out.push(t`next page: the same command with --cursor ${handle(next)}`);
  return out;
}

/** `saveslot query` (06 §4.7): the table, its rows with their marks, the page. */
export function queryResult(r: QueryResult): Line[] {
  const rows = r.rows;
  return [
    t`${tableOf(r.table)} · ${name(r.slot)} schema v${count(r.sv)} · ${num(rows.length)} rows`,
    ...rowsOf(rows),
    ...pageOf(r as unknown as R, rows.length, () => t`rows`),
    ...warningsAndNotices(r),
  ];
}

const NUMERIC: ReadonlySet<string> = new Set(["integer", "decimal", "quantity"]);

/**
 * `saveslot sql` (06 §4.7): a compact table. The slots read and their schema versions, the marks
 * over the rows read, the columns (a quantity's with its unit), a line per row, the page. A
 * number column's decimal text is shown as a number when it is one; every other cell is a value,
 * inside.
 */
export function sqlResult(r: SqlResult): Line[] {
  const rows = arr(r.rows);
  const columns = arr(r.columns).map(obj);
  const slots = Object.entries(obj(r.sv)).map(([s, v]) => t`${name(s)} schema v${count(v)}`);
  const marks = inputMarksOf(r.marks_summary, () => t`the rows read`);
  const head = columns.map((c) => {
    const unit = str(c["unit"]);
    return t`${name(String(c["name"] ?? ""))}${unit !== undefined ? t` (${untrusted(unit)})` : []}`;
  });
  const cell = (v: unknown, i: number): Part[] =>
    typeof v === "string" && NUMERIC.has(String(columns[i]?.["type"])) ? [num(v)] : fieldValue(v);
  return [
    t`${join(slots, t`, `)} · ${num(rows.length)} rows`,
    ...(marks.length > 0 ? [marks] : []),
    join(head, t` | `),
    ...rows.map((x) => join(arr(x).map(cell), t` | `)),
    ...pageOf(r as unknown as R, rows.length, () => t`rows`),
    ...warningsAndNotices(r),
  ];
}

const INTENTS: ReadonlySet<string> = new Set<string>(VERSION_INTENTS);

const RESULT = textsBy<FieldResultCode | "removed">({
  applied: () => t``,
  candidate: () => t` (candidate, not in effect)`,
  awaiting: () => t` (awaiting confirmation, not in effect)`,
  corroborated: () => t` (unchanged; added as evidence)`,
  noop: () => t` (unchanged)`,
  removed: () => t` (removed by a deletion)`,
});
const resultOf = (x: unknown): Part[] =>
  said(RESULT, x ?? "applied") ?? t` (${untrusted(String(x))})`;

/** The sources of a change: IDs and, with --sources, the words (inside). */
function sourcesOf(x: unknown): Part[] {
  const s = obj(x);
  const parts: Part[][] = [];
  for (const v of arr(s["value"])) {
    const src = obj(v);
    const text = src["text"] !== undefined ? t` ${untrusted(String(src["text"]))}` : [];
    parts.push(t`${idOf(src["id"])}${src["correction"] === true ? t` (correction)` : []}${text}`);
  }
  for (const v of arr(s["operation"])) parts.push(t`operation ${idOf(obj(v)["id"])}`);
  return parts.length > 0 ? t`  source ${join(parts, t`; `)}` : [];
}

/** `saveslot history` as a timeline (06 §4.7): each change, newest first; who read it. */
export function timelineResult(r: TimelineResult): Line[] {
  const x0 = r as unknown as R;
  const entries = arr(x0["entries"]);
  const out: Line[] = [
    t`${targetOf(x0["target"])} · current ver=${idOf(x0["ver"])} · ${num(entries.length)} changes`,
  ];
  for (const e of entries) {
    const x = obj(e);
    const fields = Object.entries(obj(x["fields"])).map(([f, v]) => {
      const changes = Array.isArray(v) ? v : [v];
      return join(
        changes.map((c0) => {
          const c = obj(c0);
          const change = Object.hasOwn(c, "before")
            ? t`${fieldValue(c["before"])} -> ${fieldValue(c["after"])}`
            : fieldValue(c["after"]);
          return t`${fieldOf(f)} ${change}${resultOf(c["result"])}${sourcesOf(c["sources"])}`;
        }),
        t`; `,
      );
    });
    const period = isObj(x["valid"]) ? t` (${periodOf(x["valid"])})` : [];
    // A restatement or a clearing writes no field: said for what it is.
    const premises = Array.isArray(x["premises"]) ? arr(x["premises"]) : undefined;
    const none =
      premises === undefined
        ? []
        : premises.length === 0
          ? t`premises cleared`
          : t`premises restated`;
    out.push(
      t`${op(x["seq"])} ${inZone(x["recorded_at"], x0["timezone"])} ${code(String(x["intent"] ?? ""), INTENTS)}${period}  ${actorOf(x["actor"])}  ${fields.length > 0 ? join(fields, t`; `) : none}`,
    );
    out.push(...timelinePremiseLines(premises ?? []));
  }
  const reads = arr(x0["reads"]);
  if (reads.length > 0) {
    out.push(
      t`read by: ${join(
        reads.map((x) => {
          const rd = obj(x);
          const task = rd["task"] !== undefined ? t` · task ${untrusted(String(rd["task"]))}` : [];
          return t`${idOf(rd["read"])} (${op(rd["seq"])}) · ${actorOf(rd["actor"])}${task} · ${inZone(rd["at"], x0["timezone"])}`;
        }),
        t`; `,
      )}`,
    );
  }
  return [...out, ...pageOf(x0, entries.length, () => t`changes`), ...warningsAndNotices(r)];
}

/**
 * The premises a timeline entry declared (05-surfaces §6 `timeline`; 04-contract-types §4.5
 * `TimelineEntry.premises`), one a line under it: what it rests on and the version seen, then
 * whether it changed since (and how, in which operation), or no longer holds (superseded or
 * cleared since). A target in a table this credential cannot see says only that, and its state.
 */
function timelinePremiseLines(premises: readonly unknown[]): Line[] {
  return premises.map((p) => {
    const q = obj(p);
    if (q["hidden"] === true) {
      const state =
        q["state"] === "changed"
          ? t`changed in ${op(q["since"])}`
          : q["state"] === "ended"
            ? t`no longer in force (superseded or cleared since)`
            : t`unchanged`;
      return t`  premise: a record in a table you cannot see; ${state}`;
    }
    const fields = arr(q["fields"]);
    const what = fields.length > 0 ? t`the ${join(fields.map(fieldOf), t`, `)} of ` : [];
    const state =
      q["state"] === "changed"
        ? t`${said(PREMISE_VERB, q["reason"]) ?? [untrusted(String(q["reason"]))]} in ${op(q["since"])}`
        : q["state"] === "ended"
          ? t`no longer in force (superseded or cleared since)`
          : t`unchanged`;
    return t`  premise: ${what}${targetOf(q["target"])} (seen ${idOf(q["ver"])}); ${state}`;
  });
}

/** `saveslot history --as-of` (06 §4.7): the rows as they were then, not for writing. */
export function asOfResult(r: AsOfResult): Line[] {
  const at = obj((r as unknown as R)["as_of"]);
  const rows = r.rows;
  return [
    t`as of ${op(at["seq"])}${at["recorded_at"] !== undefined ? t` (${inZone(at["recorded_at"], r.timezone)})` : []} · schema v${count(r.sv)}`,
    ...(rows.length > 0
      ? rowsOf(rows, true)
      : r.partially_deleted === true
        ? []
        : [t`it did not exist yet`]),
    // Left out for what a deletion removed (04-contract `history` as_of): not "nothing then".
    ...(r.partially_deleted === true
      ? [t`part of what was recorded then has since been deleted and is left out`]
      : []),
    ...pageOf(r as unknown as R, rows.length, () => t`rows`),
    ...warningsAndNotices(r),
  ];
}

/**
 * `saveslot history changes` (06 §4.7): the table, the range, then each change newest first: its
 * operation, moment, intent, who, which row or entity, and what changed. A revoke or taking one
 * back is `revoked` / `restored`.
 */
export function changesResult(r: ChangesResult): Line[] {
  const x0 = r as unknown as R;
  const list = arr(x0["changes"]);
  const range =
    x0["since"] === 0
      ? t`from the start to ${op(x0["until"])}`
      : t`after ${op(x0["since"])} up to ${op(x0["until"])}`;
  const out: Line[] = [t`${targetOf(x0["target"])} · ${range} · ${num(list.length)} changes`];
  if (list.length === 0 && x0["total"] === 0) out.push(t`no changes`);
  for (const e of list) {
    const x = obj(e);
    // A side from content deleted since is not given (`partially_deleted`): "not shown", as on MCP.
    const deleted = x["partially_deleted"] === true;
    const side = (c: R, k: "before" | "after"): Part[] =>
      !Object.hasOwn(c, k) && deleted ? t`not shown` : fieldValue(c[k]);
    const fields = Object.entries(obj(x["fields"])).map(([f, v]) =>
      join(
        (Array.isArray(v) ? v : [v]).map((c0) => {
          const c = obj(c0);
          // An end left out (from content a deletion removed) is "(deleted)", not open.
          const period = isObj(c["valid"]) ? t` (${rowPeriodOf(obj(c["valid"]))})` : [];
          if (f === "*") return t`${c["before"] === true ? t`revoked` : t`restored`}${period}`;
          const change =
            Object.hasOwn(c, "before") || (deleted && x["intent"] !== "insert")
              ? t`${side(c, "before")} -> ${side(c, "after")}`
              : side(c, "after");
          return t`${fieldOf(f)} ${change}${period}`;
        }),
        t`; `,
      ),
    );
    const target = obj(x["target"]);
    out.push(
      t`${op(x["seq"])} ${inZone(x["recorded_at"], x0["timezone"])} ${code(String(x["intent"] ?? ""), INTENTS)}  ${actorOf(x["actor"])}  ${idOf(target["row"] ?? target["entity"])}  ${join(fields, t`; `)}${deleted ? t` · partly deleted: what is not shown came from content deleted since` : []}`,
    );
  }
  return [...out, ...pageOf(x0, list.length, () => t`changes`), ...warningsAndNotices(r)];
}
