// Shape checks of anchor store values (docs/zh-CN/spec/02-architecture.md §8 "锚点存储";
// 03-data-model/03-deletion.md "删除登记"), shared by implementations: what a write may store and
// what a stored anchor must look like. Messages name the position, never the value.

import {
  type Anchor,
  type BlockPosition,
  DELETION_ENTRY_STATES,
  DELETION_KINDS,
  type DeletionEntry,
} from "./anchor.ts";

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** UTC instant with millisecond precision (09-event-format §1.3). */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A non-negative safe integer. */
export const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** A log position: a positive safe integer. */
export const isSeq = (v: unknown): v is number => isCount(v) && v >= 1;
/**
 * A non-empty, well-formed string (an ID or a path), without U+0000: PostgreSQL's text cannot hold
 * it, and every anchor store refuses alike what one of them cannot store.
 */
export const isName = (v: unknown): v is string =>
  typeof v === "string" && v !== "" && v.isWellFormed() && !v.includes("\u0000");

/** The first problem of an object's keys: unknown, or a required one missing. */
function keysProblem(
  v: Obj,
  required: readonly string[],
  optional: readonly string[] = [],
): string | undefined {
  for (const k of Object.keys(v)) {
    if (!required.includes(k) && !optional.includes(k)) return "an unknown key";
  }
  for (const k of required) if (!Object.hasOwn(v, k)) return `missing key ${k}`;
  return undefined;
}

function positionProblem(v: unknown): string | undefined {
  if (!isObject(v)) return "not an object";
  const k = keysProblem(v, ["seq", "path"]);
  if (k !== undefined) return k;
  if (!isSeq(v["seq"])) return "seq";
  if (!isName(v["path"])) return "path";
  return undefined;
}

/** The first problem of a deletion entry, as `<key>: <what>`; undefined when it is of the port's shape. */
export function entryProblem(v: unknown): string | undefined {
  if (!isObject(v)) return "not an object";
  const k = keysProblem(v, [
    "deletion",
    "kind",
    "state",
    "dueAt",
    "confirmedSeq",
    "sources",
    "positions",
  ]);
  if (k !== undefined) return k;
  if (!isName(v["deletion"])) return "deletion";
  if (!(DELETION_KINDS as readonly unknown[]).includes(v["kind"])) return "kind";
  if (!(DELETION_ENTRY_STATES as readonly unknown[]).includes(v["state"])) return "state";
  if (typeof v["dueAt"] !== "string" || !INSTANT.test(v["dueAt"])) return "dueAt";
  if (!isSeq(v["confirmedSeq"])) return "confirmedSeq";
  const sources = v["sources"];
  if (!Array.isArray(sources)) return "sources";
  for (const [i, s] of sources.entries()) if (!isSeq(s)) return `sources[${i}]`;
  const positions = v["positions"];
  if (!Array.isArray(positions)) return "positions";
  for (const [i, p] of positions.entries()) {
    const pp = positionProblem(p);
    if (pp !== undefined) return `positions[${i}]: ${pp}`;
  }
  return undefined;
}

/** The first problem of a list of entries, including two entries with one deletion ID. */
export function entriesProblem(v: unknown): string | undefined {
  if (!Array.isArray(v)) return "not an array";
  const ids = new Set<unknown>();
  for (const [i, e] of v.entries()) {
    const p = entryProblem(e);
    if (p !== undefined) return `[${i}]: ${p}`;
    const id = (e as Obj)["deletion"];
    if (ids.has(id)) return `[${i}]: deletion ID listed twice`;
    ids.add(id);
  }
  return undefined;
}

/** The first problem of a stored anchor. */
export function anchorProblem(v: unknown): string | undefined {
  if (!isObject(v)) return "not an object";
  const k = keysProblem(
    v,
    ["deletions", "highWater", "restoreCount"],
    ["restoreInProgress", "importInProgress"],
  );
  if (k !== undefined) return k;
  const d = entriesProblem(v["deletions"]);
  if (d !== undefined) return `deletions${d.startsWith("[") ? "" : ": "}${d}`;
  if (!isCount(v["highWater"])) return "highWater";
  if (!isCount(v["restoreCount"])) return "restoreCount";
  for (const m of ["restoreInProgress", "importInProgress"]) {
    if (Object.hasOwn(v, m) && !isName(v[m])) return m;
  }
  return undefined;
}

/** A deep copy of an entry with exactly the port's keys. */
export function copyEntry(e: DeletionEntry): DeletionEntry {
  return {
    deletion: e.deletion,
    kind: e.kind,
    state: e.state,
    dueAt: e.dueAt,
    confirmedSeq: e.confirmedSeq,
    sources: [...e.sources],
    positions: e.positions.map((p): BlockPosition => ({ seq: p.seq, path: p.path })),
  };
}

/** A deep copy of an anchor with exactly the port's keys. */
export function copyAnchor(a: Anchor): Anchor {
  return {
    deletions: a.deletions.map(copyEntry),
    highWater: a.highWater,
    restoreCount: a.restoreCount,
    ...(a.restoreInProgress !== undefined ? { restoreInProgress: a.restoreInProgress } : {}),
    ...(a.importInProgress !== undefined ? { importInProgress: a.importInProgress } : {}),
  };
}

/** The anchor of a tenant never written. */
export const EMPTY_ANCHOR: Anchor = Object.freeze({
  deletions: Object.freeze([]) as readonly DeletionEntry[],
  highWater: 0,
  restoreCount: 0,
});
