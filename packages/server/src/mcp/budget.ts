// The result budget (docs/zh-CN/spec/05-surfaces.md §3 «结果预算», MCP only): a result's text is at
// most 100,000 characters.
//   - A page of a list (query's rows, history's entries or rows, pending items, the catalog's
//     tables): as many as fit are shown, and the cut is the page's end: the operation is called
//     again for that many, so that the next page starts at the first not shown and nothing is
//     skipped. The result says `truncated: {shown, total}`.
//   - A result of a read that is no page, over the budget: `too_large` (`result_budget`), with how
//     to ask for less. Nothing was recorded but the read; reading less is the way.
//   - A receipt (write, resolve, schema_draft): the operation took effect, so it is never refused
//     for its size. A write's keeps its operation number, each op's target and new ver, and the
//     items made; it loses each field's result first, then the later entries of its lists. A
//     schema draft's keeps the slot, its version and the draft; it loses the list of changes
//     first, then the document with its IDs filled in, its text within the budget. Each says
//     what it lost in `omitted`.

import { ContractError } from "@fluxvita/saveslot-service";
import type { ToolName } from "./names.ts";
import { renderResult } from "./render.ts";

/** The budget of a result's text, in characters (05 §3). */
export const BUDGET = 100_000;

/** The room the line giving the next page's handle takes: a handle is at most 1,024 characters. */
const HANDLE_ROOM = 1_200;

type R = Record<string, unknown>;

/** The list a tool's result is a page of, if it is one. */
function listOf(tool: ToolName, r: R): string | undefined {
  if (tool === "saveslot_query") return "rows";
  if (tool === "saveslot_history")
    return r["mode"] === "as_of" ? "rows" : r["mode"] === "changes" ? "changes" : "entries";
  if (tool === "saveslot_pending" && r["id"] === undefined) return "items";
  if (tool === "saveslot_catalog" && r["level"] === "list") return "slots";
  return undefined;
}

/** How many entries the page has: the catalog's tables, or the list's entries. */
function sizeOf(tool: ToolName, r: R, list: string): number {
  const xs = Array.isArray(r[list]) ? (r[list] as unknown[]) : [];
  if (tool !== "saveslot_catalog") return xs.length;
  return xs.reduce<number>((n, s) => n + ((s as { tables?: unknown[] }).tables?.length ?? 0), 0);
}

/** The page cut to its first `k` entries, without a next page of its own. */
function cut(tool: ToolName, r: R, list: string, k: number): R {
  const xs = Array.isArray(r[list]) ? (r[list] as R[]) : [];
  const { next_cursor: _, ...rest } = r;
  if (tool !== "saveslot_catalog") return { ...rest, [list]: xs.slice(0, k) };
  const slots: R[] = [];
  let left = k;
  for (const s of xs) {
    if (left <= 0) break;
    const tables = Array.isArray(s["tables"]) ? (s["tables"] as unknown[]) : [];
    slots.push({ ...s, tables: tables.slice(0, left) });
    left -= tables.length;
  }
  return { ...rest, [list]: slots };
}

const fits = (tool: ToolName, r: R, budget: number) => renderResult(tool, r).length <= budget;

/** A read result within the budget: its text. */
const within = (tool: ToolName, r: R, budget: number) => fits(tool, r, budget);

/** The lists a receipt may cut, and the objects whose lists it may cut (05 §3). */
const LISTS = ["derived", "superseded", "warnings"] as const;
const NESTED = ["affected_reads", "premise_affected"] as const;
/** What a cut list keeps of its first entries. */
const KEPT = 3;

/** A write receipt shortened, step by step, until its text fits; it says what it lost. */
function shortenWrite(w: R, fitsAs: (w: R) => boolean): R {
  const omitted = new Set<string>(Array.isArray(w["omitted"]) ? (w["omitted"] as string[]) : []);
  const done = (x: R): R => ({ ...x, omitted: [...omitted] });
  // 1. Each op keeps its target, intent and new ver; its fields' results go.
  let out: R = {
    ...w,
    ops: Array.isArray(w["ops"]) ? (w["ops"] as R[]).map(({ fields: _, ...op }) => op) : w["ops"],
  };
  omitted.add("field_results");
  if (fitsAs(done(out))) return done(out);
  // 2. The later entries of its lists, and of the lists in its objects.
  for (const list of LISTS) {
    const xs = out[list];
    if (Array.isArray(xs) && xs.length > KEPT) {
      out = { ...out, [list]: xs.slice(0, KEPT) };
    }
  }
  for (const key of NESTED) {
    const o = out[key];
    if (typeof o !== "object" || o === null || Array.isArray(o)) continue;
    const kept: R = Object.fromEntries(
      Object.entries(o as R).map(([k, v]) => {
        if (Array.isArray(v) && v.length > KEPT) return [k, v.slice(0, KEPT)];
        return [k, v];
      }),
    );
    out = { ...out, [key]: kept };
  }
  // From here on something is cut: a list here, or the ops below.
  omitted.add("lists");
  if (fitsAs(done(out))) return done(out);
  // 3. The first ops only, as many as fit, the rest counted.
  const ops = Array.isArray(out["ops"]) ? (out["ops"] as R[]) : [];
  let lo = 0;
  let hi = ops.length;
  const withOps = (k: number): R =>
    done({ ...out, ops: ops.slice(0, k), ops_omitted: ops.length - k });
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fitsAs(withOps(mid))) lo = mid;
    else hi = mid - 1;
  }
  if (fitsAs(withOps(lo))) return withOps(lo);
  // 4. The operation number, whether it was a replay or its original deleted, the counts, and
  // the first of its items that fit: that it was shortened, and nothing it did not see.
  const pending = Array.isArray(out["pending"]) ? (out["pending"] as unknown[]) : [];
  const least = (k: number): R =>
    done({
      status: out["status"],
      sv: out["sv"],
      ...(out["seq"] !== undefined ? { seq: out["seq"] } : {}),
      ...(out["replayed"] !== undefined ? { replayed: out["replayed"] } : {}),
      ...(out["original_deleted"] !== undefined
        ? { original_deleted: out["original_deleted"] }
        : {}),
      ops: [],
      ops_omitted: ops.length,
      pending: pending.slice(0, k),
      pending_omitted: pending.length - k,
    });
  let a = 0;
  let b = pending.length;
  while (a < b) {
    const mid = Math.ceil((a + b) / 2);
    if (fitsAs(least(mid))) a = mid;
    else b = mid - 1;
  }
  return least(a);
}

/** The receipt shortened to fit (05 §3): a write's, or the write in a resolve's. */
function shorten(tool: ToolName, r: R, budget: number): R {
  if (tool === "saveslot_resolve") {
    const w = r["write"];
    const { warnings: _, ...head } = r;
    if (typeof w !== "object" || w === null) return head;
    return {
      ...head,
      write: shortenWrite(w as R, (x) => fits(tool, { ...head, write: x }, budget)),
    };
  }
  return shortenWrite(r, (x) => fits(tool, x, budget));
}

/** How a read over the budget can ask for less (04-contract-types §9 `narrow_by`), by tool and case. */
function narrowBy(tool: ToolName, r: R, page: boolean): string[] {
  switch (tool) {
    case "saveslot_query":
      return page ? ["fields"] : ["fields", "where", "valid_during", "limit"];
    case "saveslot_history":
      return r["mode"] === "as_of"
        ? ["valid_at"]
        : r["mode"] === "changes"
          ? ["limit"]
          : ["expand_sources", "limit"];
    case "saveslot_catalog":
      return r["level"] === "schema" ? ["level"] : r["level"] === "table" ? ["tables"] : ["slot"];
    case "saveslot_pending":
      return r["id"] === undefined ? ["slot", "type"] : [];
    default:
      return [];
  }
}

const tooLarge = (tool: ToolName, r: R, page: boolean) =>
  new ContractError("too_large", "the result is larger than a result may be", {
    reason: "result_budget",
    narrow_by: narrowBy(tool, r, page),
  });

/** A result as plain JSON: what is measured and written is what JSON would give. */
export const plain = (r: unknown): R => JSON.parse(JSON.stringify(r)) as R;

/** The text of `r` with one more line's room kept, should it be cut: does it fit? */
const fitsCut = (tool: ToolName, r: R, budget: number) => within(tool, r, budget - HANDLE_ROOM);

/**
 * The budget of one call: `fit` for the operation, measuring its result as the contract gives it
 * and saying how many entries to keep (undefined: all; a result that does not fit and is no
 * page, or of which no entry fits, is too large); `finish` for the result given back, which
 * marks a page cut as truncated and shortens a receipt.
 */
/** The tools whose results are receipts: never refused for their size, shortened (05 §3). */
const RECEIPTS: ReadonlySet<ToolName> = new Set([
  "saveslot_write",
  "saveslot_resolve",
  "saveslot_schema_draft",
]);

/**
 * A schema draft's receipt shortened (05 §3): its changes go first, then the document with its IDs
 * filled in; the slot, its version and the draft stay. Its text within `budget`.
 */
function shortenDraft(r: R, budget: number): R {
  const ok = (x: R) => fits("saveslot_schema_draft", x, budget);
  const omitted = new Set<string>(Array.isArray(r["omitted"]) ? (r["omitted"] as string[]) : []);
  const done = (x: R): R => ({ ...x, omitted: [...omitted] });
  let out: R = { ...r, changes: [] };
  omitted.add("changes");
  if (ok(done(out))) return done(out);
  const { document: _, ...rest } = out;
  out = rest;
  omitted.add("document");
  return done(out);
}

export function budgetFor(tool: ToolName, budget: number) {
  let cutAt: { readonly shown: number; readonly total: number } | undefined;
  const fit = (raw: unknown): number | undefined => {
    const result = plain(raw);
    // A receipt is never refused for its size: finish shortens it.
    if (RECEIPTS.has(tool)) return undefined;
    if (within(tool, result, budget)) return undefined;
    const list = listOf(tool, result);
    if (list === undefined) throw tooLarge(tool, result, false);
    const n = sizeOf(tool, result, list);
    const total = typeof result["total"] === "number" ? result["total"] : n;
    // The most entries whose text, cut there, fits with room for the line giving the next
    // page's handle (the cut page has one).
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (
        fitsCut(tool, { ...cut(tool, result, list, mid), truncated: { shown: mid, total } }, budget)
      )
        lo = mid;
      else hi = mid - 1;
    }
    if (lo === 0) throw tooLarge(tool, result, true);
    const keep = Math.min(lo, n - 1);
    if (keep < 1) throw tooLarge(tool, result, true);
    cutAt = { shown: keep, total };
    return keep;
  };
  const finish = (result: R): R => {
    if (tool === "saveslot_schema_draft") {
      return within(tool, result, budget) ? result : shortenDraft(result, budget);
    }
    if (tool === "saveslot_write" || tool === "saveslot_resolve") {
      return fits(tool, result, budget) ? result : shorten(tool, result, budget);
    }
    if (cutAt === undefined) return result;
    // Shown of the page's own total: the first computation's numbers are not this result's.
    const list = listOf(tool, result);
    const shown = list === undefined ? cutAt.shown : sizeOf(tool, result, list);
    const total = typeof result["total"] === "number" ? result["total"] : undefined;
    const out = { ...result, truncated: total !== undefined ? { shown, total } : { shown } };
    // Computed in the same read as it was measured, with room kept: it fits. Should it not, the
    // read is already recorded, so this is the adapter's fault, reported as such (an internal
    // error, with a warning that holds no data), not a refusal of the caller's.
    if (!within(tool, out, budget)) throw new Error("a page kept to fit did not fit");
    return out;
  };
  return { fit, finish };
}
