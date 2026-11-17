// The parts a CLI text is made of (06-cli §6.1, §6.4). A line is a list of parts; a part is either
// saveslot's own (its wording, and a value of a restricted shape that has been checked) or
// untrusted (everything else, written as ../untrusted.ts says).
//
// Outside the boundary only, each checked by its shape, never trusted by the field it came from:
// IDs as the kernel writes them, versions, paging handles, slot / table / field names as the spec
// allows them (07-schema-evolution «名字»), canonical decimal numbers where the renderer says a
// number stands, JSON numbers, booleans and null, UTC moments the service recorded, and contract
// codes from a set the renderer gives. A value of another shape goes inside, whatever it looks
// like. The strings of a stored value always go inside, even when they look like an ID (the
// renderer puts them in with `untrusted`, not with a shape).

import type { Static } from "../texts.ts";
import {
  cutCodePoints,
  type Draw,
  drawNumber,
  escapeUntrusted,
  type UntrustedMode,
  wrapEscaped,
} from "../untrusted.ts";

declare const madeHere: unique symbol;
/**
 * A part of a text. Only this file makes one (the brand's key is a symbol of this module alone):
 * an object written elsewhere with the same fields is no Part, so nothing can stand as saveslot's
 * own words without going through `words`, `t` or a shape check.
 */
export type Part = (
  | { readonly kind: "own"; readonly text: string }
  | { readonly kind: "untrusted"; readonly text: string }
) & { readonly [madeHere]: true };
export type Line = readonly Part[];

const own = (text: string): Part => ({ kind: "own", text }) as Part;
/**
 * saveslot's own static wording: a `Static` text, which only ../texts.ts can make. A string made
 * at run time cannot be passed here (it is no `Static`): it goes in with `untrusted`, or through a
 * shape check below.
 */
export const words = (text: Static): Part => own(text);
/** A value from outside saveslot's own wording: written inside the boundary. */
export const untrusted = (text: string): Part => ({ kind: "untrusted", text }) as Part;

const CROCKFORD = "[0-9A-HJKMNP-TV-Z]";
const SEQ = "(?:0|[1-9][0-9]{0,15})";
const SHAPES = {
  // IDs as the kernel writes them; versions; item versions.
  id: new RegExp(
    `^(?:(?:tn|u|ci|r|e)_${CROCKFORD}{26}|(?:sl|s|pi|d|rd)_${CROCKFORD}{16}|[vh]${SEQ}\\.${SEQ}|iv_${CROCKFORD}{16}\\.${SEQ}\\.${SEQ})$`,
  ),
  // A paging handle as the service signs it.
  handle: /^cur_[A-Za-z0-9_-]{1,1024}\.[A-Za-z0-9_-]{43}$/,
  // Slot, table and field names: a letter, then letters, digits, underscores; at most 63.
  name: /^[A-Za-z][A-Za-z0-9_]{0,62}$/,
  // A qualified table name.
  table: /^[A-Za-z][A-Za-z0-9_]{0,62}(?:\.[A-Za-z][A-Za-z0-9_]{0,62})?$/,
  // Canonical decimal text.
  number: /^-?(?:0|[1-9][0-9]{0,30})(?:\.[0-9]{0,29}[1-9])?$/,
  // A UTC moment as the service records it.
  time: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/,
} as const;

/** `v` outside the boundary when it has `shape`, inside otherwise. */
function shaped(ok: boolean, v: string): Part {
  return ok ? own(v) : untrusted(v);
}

export const id = (v: string): Part => shaped(SHAPES.id.test(v), v);
export const handle = (v: string): Part => shaped(SHAPES.handle.test(v), v);
export const name = (v: string): Part => shaped(SHAPES.name.test(v), v);
export const table = (v: string): Part => shaped(SHAPES.table.test(v), v);
export const time = (v: string): Part =>
  shaped(SHAPES.time.test(v) && !Number.isNaN(Date.parse(v)), v);
/** A moment as a wall clock shows it, `YYYY-MM-DD HH:mm`: made from a recorded moment here. */
export const localTime = (v: string): Part =>
  shaped(/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$/.test(v), v);
/** A number: a JSON number as written, or canonical decimal text. */
export const num = (v: number | string): Part =>
  typeof v === "number" ? shaped(Number.isFinite(v), String(v)) : shaped(SHAPES.number.test(v), v);
/** A contract code, outside only when it is one of `allowed` (looked up by Set, never by object). */
export const code = (v: string, allowed: ReadonlySet<string>): Part => shaped(allowed.has(v), v);

/**
 * `value` cut to `max` code points before it is escaped (an escaped text cut could read back to
 * more than one text), with `marker` after it, outside the boundary, when it was cut.
 */
export function cut(value: string, max: number, marker: Static): Part[] {
  const c = cutCodePoints(value, max);
  return c.cut ? [untrusted(c.text), own(marker)] : [untrusted(c.text)];
}

/** saveslot's own wording with parts in it: t`table ${name(x)} has ${num(n)} rows`. */
export function t(strings: TemplateStringsArray, ...parts: readonly (Part | Line)[]): Part[] {
  const out: Part[] = [];
  strings.forEach((s, i) => {
    if (s !== "") out.push(own(s));
    const p = parts[i];
    if (p !== undefined) out.push(...(Array.isArray(p) ? p : [p as Part]));
  });
  return out;
}

/** `parts` with `sep` between them. */
export function join(parts: readonly Line[], sep: Line): Part[] {
  const out: Part[] = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push(...sep);
    out.push(...p);
  });
  return out;
}

/** How the untrusted parts of an output are written: by where stdout goes and the option. */
export type Boundary =
  | { readonly kind: "terminal"; readonly color: boolean }
  | { readonly kind: "tagged" }
  | { readonly kind: "plain" };

/** Between two untrusted values that would touch in plain mode: they are never run together. */
const SEPARATOR = own(" ");

/**
 * The lines as one text. Tagged, one number for the whole output, drawn again until the output
 * holds it in its tags only. Plain, two untrusted values side by side get a space between them
 * (a value cannot end in what begins an escape, but they are kept apart all the same).
 */
export function render(
  lines: readonly Line[],
  boundary: Boundary,
  draw: Draw = drawNumber,
): string {
  const escaped = new Map<Part, string>();
  for (const line of lines) {
    for (const p of line) if (p.kind === "untrusted") escaped.set(p, escapeUntrusted(p.text));
  }
  const write = (mode: UntrustedMode) =>
    lines
      .map((line) => {
        const parts: Part[] = [];
        for (const p of line) {
          const last = parts[parts.length - 1];
          if (mode.kind === "plain" && last?.kind === "untrusted" && p.kind === "untrusted") {
            parts.push(SEPARATOR);
          }
          parts.push(p);
        }
        return parts
          .map((p) => (p.kind === "own" ? p.text : wrapEscaped(escaped.get(p) as string, mode)))
          .join("");
      })
      .join("\n");
  if (boundary.kind !== "tagged") return write(boundary);
  const tags = [...lines.flat()].filter((p) => p.kind === "untrusted").length * 2;
  // 128 random bits found in the output a hundred times running is no accident.
  for (let i = 0; i < 100; i++) {
    const n = draw();
    if (!/^[0-9a-f]{32}$/.test(n)) throw new Error("a boundary number is 32 lowercase hex digits");
    const text = write({ kind: "tagged", n });
    if (text.split(n).length - 1 === tags) return text;
  }
  throw new Error("no boundary number is free of the output");
}
