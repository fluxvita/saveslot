// Each result's text (docs/zh-CN/spec/06-cli.md §4, §6.1). A value goes outside the boundary only
// through a shape check in ./text.ts; a stored or caller-written string goes inside, always.

import {
  type CatalogList,
  type CatalogTables,
  type CommonResult,
  FIELD_TYPES,
  GRANULARITIES,
  NOTICE_CODES,
  type PageResult,
  type SchemaDraftResult,
  TIME_DEPENDENCIES,
  WARNING_CODES,
} from "@fluxvita/saveslot-client";
import { TEMPLATES } from "../templates.ts";
import { gap, type Static, TEXTS } from "../texts.ts";
import {
  code,
  handle,
  id,
  join,
  type Line,
  name,
  num,
  type Part,
  t,
  table,
  untrusted,
  words,
} from "./text.ts";

const WARNINGS: ReadonlySet<string> = new Set<string>(WARNING_CODES);
const TYPES: ReadonlySet<string> = new Set<string>(FIELD_TYPES);
const GRANULARITY: ReadonlySet<string> = new Set<string>(GRANULARITIES);
const DEPENDENCY: ReadonlySet<string> = new Set<string>(TIME_DEPENDENCIES);
const NOTICES: ReadonlySet<string> = new Set<string>(NOTICE_CODES);

/** A field of a warning or a notice besides its code: `key=value`, both inside unless a number. */
function field(k: string, v: unknown): Part[] {
  const value = typeof v === "number" ? num(v) : untrusted(JSON.stringify(v));
  return t`${untrusted(k)}=${value}`;
}

/** Every warning, then the notices (06 §6.1): code outside when it is the contract's. */
export function warningsAndNotices(r: CommonResult): Line[] {
  const out: Line[] = [];
  const each = (label: Static, set: ReadonlySet<string>, xs: readonly unknown[] | undefined) => {
    for (const x of xs ?? []) {
      const o = (typeof x === "object" && x !== null ? x : {}) as Record<string, unknown>;
      const c = typeof o["code"] === "string" ? o["code"] : "";
      const rest = Object.keys(o)
        .filter((k) => k !== "code")
        .map((k) => field(k, o[k]));
      out.push([
        ...t`${words(label)} ${code(c, set)}`,
        ...(rest.length > 0 ? t` ${join(rest, t` `)}` : []),
      ]);
    }
  };
  each(TEXTS.warning, WARNINGS, r.warnings);
  each(TEXTS.notice, NOTICES, r.notices);
  return out;
}

/** How much of a paged result was shown, and the next page's handle. */
function paging(r: PageResult, shown: number, next: (cursor: Part) => Line): Line[] {
  const out: Line[] = [];
  if (shown < r.total) out.push([words(TEXTS.shownOf(shown, r.total))]);
  if (r.next_cursor !== undefined)
    out.push([...t`${words(TEXTS.more)} `, ...next(handle(r.next_cursor))]);
  return out;
}

/** `saveslot slot list` (06 §4.3): each slot with its schema version; each table, derived ones marked. */
export function catalogList(r: CatalogList): Line[] {
  const out: Line[] = [];
  if (r.slots.length === 0) out.push([words(TEXTS.noSlots)]);
  let shown = 0;
  for (const s of r.slots) {
    const migrating = s.migration !== undefined ? t` · ${words(TEXTS.migrating)}` : [];
    out.push(
      t`${name(s.slot)} · ${words(TEXTS.schemaVersion)}${num(s.sv)} · ${untrusted(s.timezone)}${migrating}`,
    );
    for (const x of s.tables) {
      shown++;
      const kind = x.kind === "derived" ? t` (${words(TEXTS.derived)})` : [];
      out.push(t`  ${table(x.table)}${kind}  ${untrusted(x.description)}`);
    }
  }
  out.push(...paging(r, shown, (cursor) => t`saveslot slot list --cursor ${cursor}`));
  out.push(...warningsAndNotices(r));
  return out;
}

/** `saveslot schema templates` (06 §4.3): each template's name and what it holds. */
export function schemaTemplates(): Line[] {
  return [...TEMPLATES.keys()].map(
    (n) => t`${name(n)}${words(gap(10 - n.length))}${words(TEXTS.templates.get(n) ?? gap(0))}`,
  );
}

/**
 * `saveslot slot show` (06 §4.3, the text of MCP's `saveslot_catalog` at table level, with the
 * rule's text and the data profile): each table with its kind and time; each field with its type,
 * unit, precision, whether required, and description.
 */
export function catalogTables(r: CatalogTables): Line[] {
  const out: Line[] = [];
  for (const tb of r.tables) {
    const tm = tb.time;
    const kind =
      tb.kind === "derived"
        ? t`${words(TEXTS.derived)}`
        : tm?.type === "event"
          ? t`${words(TEXTS.eventBy)} ${name(tm.field)}`
          : tm?.type === "state"
            ? t`${words(TEXTS.stateBy)} ${code(tm.granularity, GRANULARITY)}`
            : t`${words(TEXTS.noTime)}`;
    out.push(
      t`${name(tb.slot)} · ${words(TEXTS.schemaVersion)}${num(tb.sv)} · ${untrusted(tb.timezone)}`,
    );
    out.push(t`${table(tb.table)} (${kind})  ${untrusted(tb.description)}`);
    for (const f of tb.fields) {
      const unit = f.unit !== undefined ? t` ${untrusted(f.unit)}` : [];
      const scale = f.precision?.scale;
      const decimals = scale !== undefined ? t` ${num(scale)}${words(TEXTS.decimals)}` : [];
      const required = f.required === true ? t` · ${words(TEXTS.required)}` : [];
      out.push(
        t`  ${name(f.name)}  ${code(f.type, TYPES)}${unit}${decimals}${required}  ${untrusted(f.description)}`,
      );
    }
    if (tb.rule !== undefined) {
      out.push(
        t`  ${words(TEXTS.rule)} (${code(tb.rule.time_dependency, DEPENDENCY)}): ${untrusted(tb.rule.sql)}`,
      );
    }
    if (tb.profile !== undefined) {
      const range = tb.profile.time_range;
      const span =
        range !== undefined ? t` · ${untrusted(range.from)} – ${untrusted(range.to)}` : [];
      out.push(t`  ${words(TEXTS.rows)} ${num(tb.profile.rows)}${span}`);
    }
  }
  out.push(...warningsAndNotices(r));
  return out;
}

/**
 * `saveslot slot create` (06 §4.3): the slot, its schema version, its tables; the time zone and
 * where it came from when the command chose it.
 */
export function slotCreated(r: SchemaDraftResult, chosenTimezone: string | undefined): Line[] {
  const listed = r.document["tables"];
  const tables = (Array.isArray(listed) ? listed : []).map((x: unknown) => {
    const n =
      typeof x === "object" && x !== null ? (x as Record<string, unknown>)["name"] : undefined;
    return typeof n === "string" ? table(n) : untrusted(JSON.stringify(n ?? null));
  });
  const out: Line[] = [
    t`${words(TEXTS.created)} ${name(r.slot)} · ${words(TEXTS.schemaVersion)}${num(r.sv ?? r.target_sv)} · ${num(tables.length)} ${words(TEXTS.tables)} (${join(
      tables.map((p) => [p]),
      t`, `,
    )})`,
  ];
  if (chosenTimezone !== undefined) {
    out.push(t`${words(TEXTS.timezoneChosen)} ${untrusted(chosenTimezone)}`);
  }
  if (r.outcome === "pending" && r.item !== undefined) {
    out.push(t`${words(TEXTS.awaitingConfirmation)} ${id(r.item.id)}`);
  }
  out.push(...warningsAndNotices(r));
  return out;
}
