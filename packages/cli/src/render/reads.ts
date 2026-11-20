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
    const fields = arr(x["premise_fields"]);
    const what = fields.length > 0 ? t`the ${join(fields.map(fieldOf), t`, `)} of ` : [];
    const verb = said(PREMISE_VERB, x["reason"]) ?? [untrusted(String(x["reason"]))];
    const covers = arr(x["fields"]);
    below.push(
      t`  ! premise changed: ${what}${targetOf(x["premise"])} (seen ${idOf(x["seen"])}) was ${verb} in ${op(x["since"])}${covers.length > 0 ? t`; covers this row's ${join(covers.map(fieldOf), t`, `)}` : t`; covers the whole row`}`,
    );
  }
  const total = int(k["premise_changed_total"]);
  if (total !== undefined) below.push(t`  ${num(total)} premises changed in all`);
  return { inline, below };
}

/** Input marks of a derived row (05 §4.2): the counts, and the open items among them. */
function inputMarksOf(x: unknown): Part[] {
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
  return counts.length > 0 ? t`! among its inputs: ${join(counts, t`, `)}${listed}` : [];
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
  if (Object.hasOwn(row, "valid_from")) cells.push(periodOf(row));
  const values = namedValues(row["values"]);
  if (values.length > 0) cells.push(values);
  const tail = [...m.inline, inputMarksOf(row["input_marks"])].filter((x) => x.length > 0);
  const line = join([head.length > 0 ? head : t` `, ...cells, ...tail], t` | `);
  const detail = isObj(row["detail"])
    ? [t`  detail: ${untrusted(JSON.stringify(row["detail"]))}`]
    : [];
  return [line, ...m.below, ...detail];
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
    out.push(
      t`${op(x["seq"])} ${inZone(x["recorded_at"], x0["timezone"])} ${code(String(x["intent"] ?? ""), INTENTS)}${period}  ${actorOf(x["actor"])}  ${join(fields, t`; `)}`,
    );
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

/** `saveslot history --as-of` (06 §4.7): the rows as they were then, not for writing. */
export function asOfResult(r: AsOfResult): Line[] {
  const at = obj((r as unknown as R)["as_of"]);
  const rows = r.rows;
  return [
    t`as of ${op(at["seq"])}${at["recorded_at"] !== undefined ? t` (${inZone(at["recorded_at"], r.timezone)})` : []} · schema v${count(r.sv)}`,
    ...(rows.length > 0 ? rowsOf(rows, true) : [t`it did not exist yet`]),
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
    const fields = Object.entries(obj(x["fields"])).map(([f, v]) =>
      join(
        (Array.isArray(v) ? v : [v]).map((c0) => {
          const c = obj(c0);
          const period = isObj(c["valid"]) ? t` (${periodOf(c["valid"])})` : [];
          if (f === "*") return t`${c["before"] === true ? t`revoked` : t`restored`}${period}`;
          const change = Object.hasOwn(c, "before")
            ? t`${fieldValue(c["before"])} -> ${fieldValue(c["after"])}`
            : fieldValue(c["after"]);
          return t`${fieldOf(f)} ${change}${period}`;
        }),
        t`; `,
      ),
    );
    const target = obj(x["target"]);
    out.push(
      t`${op(x["seq"])} ${inZone(x["recorded_at"], x0["timezone"])} ${code(String(x["intent"] ?? ""), INTENTS)}  ${actorOf(x["actor"])}  ${idOf(target["row"] ?? target["entity"])}  ${join(fields, t`; `)}`,
    );
  }
  return [...out, ...pageOf(x0, list.length, () => t`changes`), ...warningsAndNotices(r)];
}
