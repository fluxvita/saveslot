// Each result's text (docs/zh-CN/spec/06-cli.md §4, §6.1). A value goes outside the boundary only
// through a shape check in ./text.ts; a stored or caller-written string goes inside, always.

import {
  type CatalogList,
  type CommonResult,
  NOTICE_CODES,
  type PageResult,
  WARNING_CODES,
} from "@fluxvita/saveslot-client";
import { TEMPLATES } from "../templates.ts";
import { gap, type Static, TEXTS } from "../texts.ts";
import {
  code,
  handle,
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
