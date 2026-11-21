// Block shape checks of the deletion events (docs/zh-CN/spec/09-event-format.md §5.9
// `deletion.confirmed`, `deletion.cancelled`, `deletion.executed`), shape by shape, as the types
// in ./blocks.ts give them. Shapes only: whether a contribution a block refers to exists, or
// whether a result matches the replay, is the kernel's check.

import { check, type Issues, isObject, type Json, keys, type ShapeChecker, str } from "./check.ts";
import {
  CANCEL_ORIGINS,
  DELETION_KINDS,
  DELETION_ORIGINS,
  DELETION_OUTCOMES,
  RESTATED_STATUSES,
  TOMBSTONE_REASONS,
} from "./enums.ts";
import {
  contribution,
  deps,
  type EventRule,
  id,
  int,
  interval,
  list,
  noHoles,
  oneOf,
  oneRequestId,
  openInterval,
  tableTarget,
  value,
} from "./shapes-write.ts";
import { isEventInteger, isHash, isInstant } from "./values.ts";
import { checkPathSyntax } from "./vocabulary.ts";

const seq = (v: Json) => isEventInteger(v) && v >= 1;

/**
 * A value source in deletion results and in a valued restatement (§5.9): `carried` from a field
 * item, or a `schema_const` entry; never a direct `source`, so that a later deletion of the
 * carried contribution's sources cascades to the block.
 */
const carriedSource: ShapeChecker = (e, a, is) => {
  if (isObject(e) && e["kind"] === "schema_const") {
    if (keys(e, a, ["kind", "sv", "field"], [], is)) {
      check(int(e["sv"]), a, "sv", is);
      check(id("field", e["field"]), a, "field", is);
    }
    return;
  }
  if (!keys(e, a, ["kind", "carried"], [], is)) return;
  check(e["kind"] === "value", a, "kind", is);
  const c = e["carried"];
  if (isObject(c) && "existence" in c) is.push(`${a}: carried from a field item`);
  else contribution(c, `${a}.carried`, is);
};

/** A block address (§5.9 `positions`): an event and a well-formed block path (§3.1). */
const blockAddress: ShapeChecker = (v, at, issues) => {
  if (!keys(v, at, ["seq", "path"], [], issues)) return;
  check(seq(v["seq"]), at, "seq", issues);
  const p = v["path"];
  check(str(p) && checkPathSyntax(p).ok, at, "path", issues);
};

/**
 * In a block with an interval, the item a `carried` source points to is also in `deps` (§3.5 rule
 * 1, §5.9): a later deletion finds the cascade by `deps` alone.
 */
function carriedInDeps(sources: Json, depsList: Json, at: string, issues: Issues): void {
  if (!Array.isArray(sources) || !Array.isArray(depsList)) return;
  const listed = new Set(
    depsList.map((d) =>
      isObject(d) ? `${String(d["event"])}/${String(d["field"])}/${String(d["k"])}` : "",
    ),
  );
  for (const e of sources) {
    const c = isObject(e) ? e["carried"] : undefined;
    if (!isObject(c)) continue;
    const key = `${String(c["event"])}/${String(c["field"])}/${String(c["k"])}`;
    check(listed.has(key), at, "carried not in deps", issues);
  }
}

const itemIds: ShapeChecker = (v, at, issues) => {
  list(v, at, issues, (x, a, is) => check(id("item", x), a, "item", is), true);
  if (Array.isArray(v)) check(new Set(v).size === v.length, at, "duplicate item", issues);
};

export const DELETION_SHAPES: Record<string, ShapeChecker> = {
  DeletionConfirmedTarget(v, at, issues) {
    if (!keys(v, at, ["deletion", "kind", "due_at", "sources", "origin"], [], issues)) return;
    check(id("item", v["deletion"]), at, "deletion", issues);
    check(oneOf(DELETION_KINDS, v["kind"]), at, "kind", issues);
    check(str(v["due_at"]) && isInstant(v["due_at"]), at, "due_at", issues);
    const sources = v["sources"];
    list(sources, `${at}.sources`, issues, (x, a, is) => check(seq(x), a, "seq", is), true);
    if (Array.isArray(sources))
      check(new Set(sources).size === sources.length, `${at}.sources`, "duplicate seq", issues);
    check(oneOf(DELETION_ORIGINS, v["origin"]), at, "origin", issues);
  },
  Positions(v, at, issues) {
    list(v, at, issues, blockAddress);
    if (Array.isArray(v)) {
      const seen = new Set(
        v.map((x) => (isObject(x) ? `${String(x["seq"])}/${String(x["path"])}` : "")),
      );
      check(seen.size === v.length, at, "duplicate block", issues);
    }
  },
  Summary(v, at, issues) {
    if (!keys(v, at, ["hash"], [], issues)) return;
    check(str(v["hash"]) && isHash(v["hash"]), at, "hash", issues);
  },
  ResultTarget(v, at, issues) {
    const row = isObject(v) && "row" in v ? "row" : "entity";
    if (!keys(v, at, ["table", row, "outcome"], [], issues)) return;
    tableTarget(v, at, issues);
    check(oneOf(DELETION_OUTCOMES, v["outcome"]), at, "outcome", issues);
  },
  ResultField(v, at, issues) {
    const state = isObject(v) && ("valid" in v || "deps" in v);
    const req = state ? ["value", "sources", "valid", "deps"] : ["value", "sources"];
    if (!keys(v, at, req, [], issues)) return;
    value(v["value"], `${at}.value`, issues);
    const sources = v["sources"];
    list(sources, `${at}.sources`, issues, carriedSource);
    // A value has its sources. `null` either has none (no contribution gives the stretch) or is
    // an explicit clearing, carried like any value (§5.7, §5.9).
    if (Array.isArray(sources)) {
      check(v["value"] === null || sources.length > 0, at, "a value without sources", issues);
    }
    if (state) {
      interval(v["valid"], `${at}.valid`, issues);
      deps(v["deps"], `${at}.deps`, issues);
      carriedInDeps(sources, v["deps"], at, issues);
    }
  },
  ResultExistence(v, at, issues) {
    if (!keys(v, at, ["gaps", "deps"], [], issues)) return;
    list(v["gaps"], `${at}.gaps`, issues, openInterval);
    deps(v["deps"], `${at}.deps`, issues);
  },
  Restated(v, at, issues) {
    if (!isObject(v)) {
      issues.push(`${at}: not an object`);
      return;
    }
    const onExistence = "existence" in v;
    const kinds = ["value", "no_value", "uncovered"].filter((k) => k in v);
    const which = ["valid", "seen_valid"].filter((k) => k in v);
    const ref = onExistence ? ["event", "existence"] : ["event", "field", "k"];
    const optional = onExistence
      ? ["valid", "seen_valid", "deps", "restored"]
      : ["valid", "seen_valid", "deps", "value", "sources", "no_value", "uncovered"];
    if (!keys(v, at, [...ref, "status"], optional, issues)) return;
    contribution(
      onExistence
        ? { event: v["event"], existence: v["existence"] }
        : { event: v["event"], field: v["field"], k: v["k"] },
      at,
      issues,
    );
    const status = v["status"];
    check(oneOf(RESTATED_STATUSES, status), at, "status", issues);
    if (onExistence) check(status !== "corroborated", at, "status", issues);
    // A candidate's interval is `seen_valid`, any other's `valid`; a dropped item has none.
    check(which.length <= 1, at, "at most one of valid and seen_valid", issues);
    if (status === "dropped") {
      check(which.length === 0, at, "no interval when dropped", issues);
      check(kinds.length === 0, at, "no value when dropped", issues);
    } else if (which[0] !== undefined) {
      check(
        (which[0] === "seen_valid") === (status === "candidate"),
        at,
        "seen_valid exactly on a candidate",
        issues,
      );
      const iv = v[which[0]];
      if (onExistence) openInterval(iv, `${at}.${which[0]}`, issues);
      else interval(iv, `${at}.${which[0]}`, issues);
    }
    if ("deps" in v) deps(v["deps"], `${at}.deps`, issues);
    if ("restored" in v) check(v["restored"] === true, at, "restored", issues);
    // A carried item's new value with its sources, or `no_value`, or `uncovered`: at most one.
    check(kinds.length <= 1, at, "at most one of value, no_value, uncovered", issues);
    if (kinds[0] === "value") {
      check("sources" in v, at, "value without sources", issues);
      value(v["value"], `${at}.value`, issues);
      list(v["sources"], `${at}.sources`, issues, carriedSource, true);
      carriedInDeps(v["sources"], v["deps"] ?? [], at, issues);
    } else {
      check(!("sources" in v), at, "sources without value", issues);
      if (kinds[0] !== undefined) check(v[kinds[0]] === true, at, kinds[0], issues);
    }
  },
  Recreated(v, at, issues) {
    if (!keys(v, at, ["event", "created"], [], issues)) return;
    check(seq(v["event"]), at, "event", issues);
    check(typeof v["created"] === "boolean", at, "created", issues);
  },
  ItemIdList: itemIds,
  DeletionCancelledTarget(v, at, issues) {
    if (!keys(v, at, ["deletion", "origin"], [], issues)) return;
    check(id("item", v["deletion"]), at, "deletion", issues);
    check(oneOf(CANCEL_ORIGINS, v["origin"]), at, "origin", issues);
  },
  KeptSuperseded(v, at, issues) {
    if (!keys(v, at, ["item", "by_event"], [], issues)) return;
    check(id("item", v["item"]), at, "item", issues);
    check(seq(v["by_event"]), at, "by_event", issues);
  },
  KeptEffective(v, at, issues) {
    if (!keys(v, at, ["event", "items", "by_event"], [], issues)) return;
    check(seq(v["event"]), at, "event", issues);
    check(seq(v["by_event"]), at, "by_event", issues);
    list(
      v["items"],
      `${at}.items`,
      issues,
      (x, a, is) => {
        if (isObject(x) && "existence" in x) {
          if (keys(x, a, ["existence"], [], is)) check(int(x["existence"]), a, "existence", is);
          return;
        }
        if (!keys(x, a, ["field", "k"], [], is)) return;
        check(id("field", x["field"]), a, "field", is);
        check(int(x["k"]), a, "k", is);
      },
      true,
    );
  },
  DeletionExecutedTarget(v, at, issues) {
    if (!keys(v, at, ["deletion", "reason"], [], issues)) return;
    check(id("item", v["deletion"]), at, "deletion", issues);
    check(oneOf(TOMBSTONE_REASONS, v["reason"]), at, "reason", issues);
  },
};

/**
 * The indexed blocks of one result row and of the event: indices from 0 without a gap; a row's
 * fields and gaps belong to a row with a target. By the target: an entity (a state table's) has
 * every stretch with an interval and its gaps (`results/<k>/existence`, always given when an
 * entity is listed, §5.9); a row (an event or timeless table's) has every stretch without one, at
 * `j = 0`, and no gaps.
 */
function results(
  paths: ReadonlySet<string>,
  blocks: Readonly<Record<string, Json>>,
  issues: Issues,
) {
  const rows = new Set<number>();
  const withTarget = new Set<number>();
  const stretches = new Map<string, number[]>();
  const timed = new Map<number, Set<boolean>>();
  const gaps = new Set<number>();
  for (const p of paths) {
    const t = /^results\/(\d+)\/target$/.exec(p);
    if (t !== null) {
      rows.add(Number(t[1]));
      withTarget.add(Number(t[1]));
      continue;
    }
    const e = /^results\/(\d+)\/existence$/.exec(p);
    if (e !== null) {
      rows.add(Number(e[1]));
      gaps.add(Number(e[1]));
      continue;
    }
    const f = /^results\/(\d+)\/fields\/(f\d+)\/(\d+)$/.exec(p);
    if (f === null) continue;
    const k = Number(f[1]);
    rows.add(k);
    const key = `${k}/${f[2]}`;
    stretches.set(key, [...(stretches.get(key) ?? []), Number(f[3])]);
    const v = blocks[p];
    if (isObject(v)) timed.set(k, (timed.get(k) ?? new Set()).add("valid" in v));
  }
  noHoles([...rows], "results", issues);
  for (const k of rows) check(withTarget.has(k), `results/${k}`, "no target", issues);
  for (const [key, js] of stretches) noHoles(js, `results/${key}`, issues);
  for (const k of withTarget) {
    const t = blocks[`results/${k}/target`];
    if (!isObject(t)) continue;
    const entity = "entity" in t;
    const kinds = timed.get(k) ?? new Set<boolean>();
    if (entity) {
      check(
        !kinds.has(false),
        `results/${k}`,
        "a stretch of an entity without an interval",
        issues,
      );
      check(gaps.has(k), `results/${k}`, "an entity without its gaps", issues);
    } else {
      check(!kinds.has(true), `results/${k}`, "a stretch of a row with an interval", issues);
      check(!gaps.has(k), `results/${k}/existence`, "gaps on a row", issues);
      for (const [key, js] of stretches) {
        if (key.startsWith(`${k}/`))
          check(
            js.every((j) => j === 0),
            `results/${key}`,
            "a row's stretch other than 0",
            issues,
          );
      }
    }
  }
}

/** §5.1: the request-id blocks only on a head event a caller made, not on one `system` made. */
function callerOnly(
  paths: ReadonlySet<string>,
  blocks: Readonly<Record<string, Json>>,
  caller: Json,
  issues: Issues,
) {
  const t = blocks["target"];
  const origin = isObject(t) ? t["origin"] : undefined;
  if (origin === caller) return;
  for (const p of ["task", "request_key", "idempotency"]) {
    check(!paths.has(p), p, "not on an event system made", issues);
  }
}

const indexed = (paths: ReadonlySet<string>, prefix: string, issues: Issues) => {
  const re = new RegExp(`^${prefix}/(\\d+)$`);
  const present = [...paths].flatMap((p) => {
    const m = re.exec(p);
    return m === null ? [] : [Number(m[1])];
  });
  noHoles(present, prefix, issues);
};

export const DELETION_EVENT_RULES: Readonly<Record<string, EventRule>> = {
  "deletion.confirmed"(paths, blocks, issues, at) {
    oneRequestId(paths, blocks, issues, at);
    callerOnly(paths, blocks, "request", issues);
    results(paths, blocks, issues);
    indexed(paths, "restated", issues);
    indexed(paths, "recreated", issues);
    // Its own summary is cleared with the content it summarizes.
    const positions = blocks["positions"];
    if (paths.has("summary") && Array.isArray(positions)) {
      check(
        positions.some((x) => isObject(x) && x["seq"] === at.seq && x["path"] === "summary"),
        "positions",
        "its own summary not listed",
        issues,
      );
    }
  },
  "deletion.cancelled"(paths, blocks, issues, at) {
    oneRequestId(paths, blocks, issues, at);
    callerOnly(paths, blocks, "request", issues);
    results(paths, blocks, issues);
    indexed(paths, "restated", issues);
    indexed(paths, "recreated", issues);
    indexed(paths, "kept_superseded", issues);
    indexed(paths, "kept_effective", issues);
  },
};
