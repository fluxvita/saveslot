// One page of an ordered list, by `limit` and `position` (04-contract §13, §15), for the reads other
// than `query` (`history`'s `timeline` and `as_of`, `reads.list`): the same unsigned position as
// `query`'s (./rows.ts), binding a digest of the call's parameters, the first page's point (an
// operation number, or for the read audit its last read record), its evaluation time and the
// restore count, and carrying the last item's keys. The caller lists what the first page's point
// fixes; this takes the items after the keys.

import { createHash } from "node:crypto";
import type { JsonValue } from "@fluxvita/saveslot-contract-core";
import { canonicalize } from "@fluxvita/saveslot-contract-core";
import { get, has, isJsonNumber, type Obj } from "../request/index.ts";
import { cmpKeys, decodePosition, encodePosition, type KeySpec, type Position } from "./rows.ts";
import { invalid } from "./types.ts";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 200;

/** `limit`: 1–200, a plain number or a JSON number kept with its text; 20 when not given. */
export function limitOf(params: Obj): number {
  if (!has(params, "limit")) return DEFAULT_LIMIT;
  const v = get(params, "limit");
  const n = typeof v === "number" ? v : isJsonNumber(v) ? Number(v.text) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw invalid("malformed", "limit");
  return n;
}

/** A digest of the parameters a position belongs to (without the page). */
export const digest = (identity: JsonValue): string =>
  createHash("sha256").update(canonicalize(identity)).digest("hex").slice(0, 32);

/** The position given, checked; undefined on a first page. */
export function positionOf(
  params: Obj,
  check: {
    readonly identity: string;
    readonly specs: readonly KeySpec[];
    readonly restoreCount: number;
    readonly latest: number;
    readonly condition?: true;
  },
): Position | undefined {
  if (!has(params, "position")) return undefined;
  const v = get(params, "position");
  if (typeof v !== "string" || v === "") throw invalid("malformed", "position");
  return decodePosition(v, "position", check);
}

/** The page after the position's keys, and the next page's position when more follow. */
export function pageAfter<T>(
  items: readonly {
    readonly item: T;
    readonly keys: readonly (string | boolean | number | null)[];
  }[],
  o: {
    readonly specs: readonly KeySpec[];
    readonly identity: string;
    readonly position: Position | undefined;
    /** The first page's point and evaluation time (taken from the position on later pages). */
    readonly seq: number;
    readonly at: string;
    readonly restoreCount: number;
    readonly limit: number;
    readonly condition?: Position["condition"];
  },
): { readonly page: T[]; readonly next?: string } {
  const after = o.position?.keys;
  const rest =
    after === undefined ? items : items.filter((x) => cmpKeys(o.specs, x.keys, after) > 0);
  const page = rest.slice(0, o.limit);
  const last = page.at(-1);
  return {
    page: page.map((x) => x.item),
    ...(rest.length > page.length && last !== undefined
      ? {
          next: encodePosition(o.identity, {
            seq: o.seq,
            at: o.at,
            restoreCount: o.restoreCount,
            keys: last.keys,
            ...(o.condition !== undefined ? { condition: o.condition } : {}),
          }),
        }
      : {}),
  };
}
