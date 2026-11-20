// Block shape checks of a write's events (docs/zh-CN/spec/09-event-format.md §5.6 `source.recorded`,
// §5.7 `write.head`, `write.base` and `write.derived`, §5.8 the pending item events), shape by shape,
// as the types in ./blocks.ts give them. Shapes only: whether a field ID exists in the schema, or whether a
// value fits the field's type, is the kernel's check.
//
// Not here yet, so still `unsupported`: the blocks of later phases (`refs`, `baseline`, the premise
// blocks, `duplicate`, `matched`).

import { check, type Issues, isObject, type Json, keys, type ShapeChecker, str } from "./check.ts";
import {
  CANDIDATE_CAUSES,
  EVENT_DECISIONS,
  EXISTENCE_SCOPES,
  FIELD_STATUSES,
  INTENTS,
  LITERAL_RESULTS,
  REFRESH_CAUSES,
  SOURCE_KINDS,
  SOURCE_LEVELS,
  SUPERSEDED_REASONS,
  SV_BASES,
  VER_BASES,
} from "./enums.ts";
import {
  isCanonicalDecimal,
  isDate,
  isEventInteger,
  isHash,
  isId,
  isInstant,
  isRawDecimal,
} from "./values.ts";

// --- values --------------------------------------------------------------------------------------

export const oneOf = (list: readonly string[], v: Json) => (list as readonly Json[]).includes(v);
const seq = (v: Json) => isEventInteger(v) && v >= 1;
export const int = (v: Json) => isEventInteger(v);
export const id = (kind: Parameters<typeof isId>[0], v: Json) => str(v) && isId(kind, v);
const point = (v: Json): v is string => str(v) && (isDate(v) || isInstant(v));

export function interval(v: Json, at: string, issues: Issues): void {
  if (!keys(v, at, ["from"], ["to"], issues)) return;
  const from = v["from"];
  check(point(from), at, "from", issues);
  if ("to" in v) {
    const to = v["to"];
    check(point(to), at, "to", issues);
    if (point(from) && point(to)) {
      check(isDate(from) === isDate(to), at, "from and to of one granularity", issues);
      check(from < to, at, "to after from", issues);
    }
  }
}

/**
 * An interval on existence as a contribution's span or an item's entry writes it (§1.2, §5.7, §5.8):
 * a missing end is open, `{to}` open at the start (a write-back that takes back a revoke of the
 * whole time, cut by another item), `{}` the whole time. Both ends given: one granularity, `to`
 * after `from`. A field's spans and entries always have a start (`interval`).
 */
export function openInterval(v: Json, at: string, issues: Issues): void {
  if (!keys(v, at, [], ["from", "to"], issues)) return;
  if ("from" in v) check(point(v["from"]), at, "from", issues);
  if ("to" in v) check(point(v["to"]), at, "to", issues);
  const from = v["from"];
  const to = v["to"];
  if (point(from) && point(to)) {
    check(isDate(from) === isDate(to), at, "from and to of one granularity", issues);
    check(from < to, at, "to after from", issues);
  }
}

/** A field value (§1.3); `raw`: as the caller gave it (`ops/<i>/set`), else normalized. */
export function value(v: Json, at: string, issues: Issues, raw = false): void {
  if (v === null || str(v) || typeof v === "boolean") return;
  if (!isObject(v)) {
    issues.push(`${at}: not a field value`);
    return;
  }
  if ("instant" in v) {
    if (!keys(v, at, ["instant", "zone"], [], issues)) return;
    check(str(v["instant"]) && isInstant(v["instant"]), at, "instant", issues);
    check(str(v["zone"]) && v["zone"] !== "", at, "zone", issues);
    return;
  }
  if (!keys(v, at, ["value", "unit"], [], issues)) return;
  const d = v["value"];
  check(str(d) && (raw ? isRawDecimal(d) : isCanonicalDecimal(d)), at, "decimal", issues);
  check(str(v["unit"]) && v["unit"] !== "", at, "unit", issues);
}

function contribution(v: Json, at: string, issues: Issues): void {
  if (isObject(v) && "existence" in v) {
    if (!keys(v, at, ["event", "existence"], [], issues)) return;
    check(seq(v["event"]), at, "event", issues);
    check(int(v["existence"]), at, "existence", issues);
    return;
  }
  if (!keys(v, at, ["event", "field", "k"], [], issues)) return;
  check(seq(v["event"]), at, "event", issues);
  check(id("field", v["field"]), at, "field", issues);
  check(int(v["k"]), at, "k", issues);
}

export function list(
  v: Json,
  at: string,
  issues: Issues,
  each: ShapeChecker,
  nonEmpty = false,
): void {
  if (!Array.isArray(v)) {
    issues.push(`${at}: not an array`);
    return;
  }
  check(!nonEmpty || v.length > 0, at, "empty", issues);
  v.forEach((x, i) => {
    each(x, `${at}[${i}]`, issues);
  });
}

export const deps: ShapeChecker = (v, at, issues) => list(v, at, issues, contribution);

function tableTarget(v: Record<string, Json>, at: string, issues: Issues): void {
  check(id("table", v["table"]), at, "table", issues);
  const row = "row" in v;
  check(row !== "entity" in v, at, "exactly one of row and entity", issues);
  if (row) check(id("row", v["row"]), at, "row", issues);
  else if ("entity" in v) check(id("entity", v["entity"]), at, "entity", issues);
}

/** A revert record entry (§5.7): (event, field) or (event, existence), never an index. */
function revertTarget(extra: readonly string[]): ShapeChecker {
  return (v, at, issues) => {
    const onExistence = isObject(v) && "existence" in v;
    const req = onExistence ? ["event", "existence"] : ["event", "field"];
    if (!keys(v, at, req, extra, issues)) return;
    check(seq(v["event"]), at, "event", issues);
    if (onExistence) check(v["existence"] === true, at, "existence", issues);
    else check(id("field", v["field"]), at, "field", issues);
    if ("later" in v) check(v["later"] === true, at, "later", issues);
    if ("by_op" in v) check(int(v["by_op"]), at, "by_op", issues);
  };
}

function versions(v: Record<string, Json>, at: string, issues: Issues): void {
  check(int(v["ruleset_version"]), at, "ruleset_version", issues);
  check(int(v["policy_version"]), at, "policy_version", issues);
}

export const slotCtx =
  (literal: "required" | "absent"): ShapeChecker =>
  (v, at, issues) => {
    const base = ["now", "today", "ruleset_version", "policy_version"];
    const req = literal === "required" ? [...base, "literal_checker"] : base;
    if (!keys(v, at, req, [], issues)) return;
    check(str(v["now"]) && isInstant(v["now"]), at, "now", issues);
    check(str(v["today"]) && isDate(v["today"]), at, "today", issues);
    versions(v, at, issues);
    if ("literal_checker" in v) check(str(v["literal_checker"]), at, "literal_checker", issues);
  };

// --- shapes --------------------------------------------------------------------------------------

/**
 * An entry on the unit "existence" (09 §5.8): a revoked stretch, `{field: "existence", revoked:
 * true, valid?, op, deps}`, `op` the revoke; or a stretch with a value, `{field: "existence",
 * valid?, deps}`. A stretch neither covers has no value, and not from a revoke.
 */
function existenceEntry(v: Record<string, unknown>, at: string, issues: string[]): void {
  if (!("revoked" in v)) {
    if (!keys(v, at, ["field", "deps"], ["valid"], issues)) return;
    if ("valid" in v) openInterval(v["valid"], `${at}.valid`, issues);
    deps(v["deps"], `${at}.deps`, issues);
    return;
  }
  if (!keys(v, at, ["field", "revoked", "op", "deps"], ["valid"], issues)) return;
  check(v["revoked"] === true, at, "revoked", issues);
  check(int(v["op"]), at, "op", issues);
  if ("valid" in v) openInterval(v["valid"], `${at}.valid`, issues);
  deps(v["deps"], `${at}.deps`, issues);
}

export const WRITE_SHAPES: Record<string, ShapeChecker> = {
  // §5.7 write.derived
  DerivedTarget(v, at, issues) {
    const req = ["table", "rule", "rule_version", "partition", "read_pos", "reads", "emptied"];
    if (!keys(v, at, req, [], issues)) return;
    check(id("table", v["table"]), at, "table", issues);
    check(id("rule", v["rule"]), at, "rule", issues);
    check(int(v["rule_version"]) && v["rule_version"] >= 1, at, "rule_version", issues);
    check(id("partition", v["partition"]), at, "partition", issues);
    // The seq of the last event of its operation before the derived refresh began (the same for
    // every derived write of the operation): a member event, after its head.
    check(int(v["read_pos"]) && v["read_pos"] >= 1, at, "read_pos", issues);
    list(
      v["reads"],
      `${at}.reads`,
      issues,
      (r, rat, ris) => {
        if (!keys(r, rat, ["table"], [], ris)) return;
        check(id("table", r["table"]), rat, "table", ris);
      },
      true,
    );
    // One spelling of a read set: no table twice, in ascending string order of the IDs ("t10"
    // before "t2").
    const reads = v["reads"];
    if (Array.isArray(reads)) {
      const ids = reads.map((r) => (isObject(r) ? r["table"] : undefined));
      if (ids.every((x): x is string => str(x))) {
        check(
          ids.every((x, i) => i === 0 || (ids[i - 1] as string) < x),
          `${at}.reads`,
          "not in ascending order without repeats",
          issues,
        );
      }
    }
    check(typeof v["emptied"] === "boolean", at, "emptied", issues);
  },
  DerivedKey(v, at, issues) {
    if (!keys(v, at, ["values"], [], issues)) return;
    list(v["values"], `${at}.values`, issues, (x, xat, xis) => value(x, xat, xis));
  },
  Checksum(v, at, issues) {
    if (!keys(v, at, ["checksum"], [], issues)) return;
    check(str(v["checksum"]) && isHash(v["checksum"]), at, "checksum", issues);
  },
  // §5.1
  WriteCtx: slotCtx("required"),
  // §5.1: `literal_checker` only on write.head (a decision's write checks nothing literally).
  ResolveCtx: slotCtx("absent"),
  Task(v, at, issues) {
    check(str(v) && v !== "", at, "task", issues);
  },
  RequestKey(v, at, issues) {
    if (!keys(v, at, ["key"], [], issues)) return;
    check(str(v["key"]) && v["key"] !== "", at, "key", issues);
  },
  Idempotency(v, at, issues) {
    if (!keys(v, at, ["key", "fingerprint"], [], issues)) return;
    check(str(v["key"]) && v["key"] !== "", at, "key", issues);
    check(str(v["fingerprint"]) && isHash(v["fingerprint"]), at, "fingerprint", issues);
  },

  // §5.6 source.recorded
  SourceTarget(v, at, issues) {
    if (!keys(v, at, ["source_id", "kind", "level"], ["op_index"], issues)) return;
    check(id("source", v["source_id"]), at, "source_id", issues);
    check(oneOf(SOURCE_KINDS, v["kind"]), at, "kind", issues);
    check(oneOf(SOURCE_LEVELS, v["level"]), at, "level", issues);
    if ("op_index" in v) {
      check(v["kind"] === "api_call", at, "op_index only on api_call", issues);
      check(int(v["op_index"]), at, "op_index", issues);
    }
  },
  SourceText(v, at, issues) {
    if (!keys(v, at, ["text"], [], issues)) return;
    check(str(v["text"]), at, "text", issues);
  },
  SourceFile(v, at, issues) {
    if (!keys(v, at, ["name", "mime", "size"], ["sha256", "origin", "excerpt"], issues)) return;
    check(str(v["name"]), at, "name", issues);
    check(str(v["mime"]), at, "mime", issues);
    check(int(v["size"]), at, "size", issues);
    if ("sha256" in v) check(str(v["sha256"]) && isHash(v["sha256"]), at, "sha256", issues);
    if ("origin" in v) check(str(v["origin"]), at, "origin", issues);
    if ("excerpt" in v) check(str(v["excerpt"]), at, "excerpt", issues);
  },
  SourceRequest(v, at, issues) {
    check(isObject(v), at, "not an object", issues);
  },
  StatedAt(v, at, issues) {
    if (!keys(v, at, ["at"], [], issues)) return;
    check(str(v["at"]) && isInstant(v["at"]), at, "at", issues);
  },

  // §5.7 write.head
  WriteRequest(v, at, issues) {
    if (!keys(v, at, ["sv", "sv_basis", "op_count"], [], issues)) return;
    check(int(v["sv"]), at, "sv", issues);
    check(oneOf(SV_BASES, v["sv_basis"]), at, "sv_basis", issues);
    check(int(v["op_count"]) && (v["op_count"] as number) >= 1, at, "op_count", issues);
  },
  OpTarget(v, at, issues) {
    const opt = ["row", "entity", "by_entity_key", "by_external_key", "key_from", "created", "ver"];
    if (!keys(v, at, ["table", "intent"], opt, issues)) return;
    tableTarget(v, at, issues);
    check(oneOf(INTENTS, v["intent"]), at, "intent", issues);
    for (const flag of ["by_entity_key", "by_external_key", "created"]) {
      if (flag in v) check(v[flag] === true, at, flag, issues);
    }
    if ("key_from" in v) check(id("row", v["key_from"]), at, "key_from", issues);
    check(!(v["by_entity_key"] && v["by_external_key"]), at, "one way to locate", issues);
    // An insert has no `ver` (§5.7: "新增时没有 ver").
    check(!(v["intent"] === "insert" && "ver" in v), at, "ver on an insert", issues);
    if ("ver" in v) {
      const ver = v["ver"];
      if (keys(ver, `${at}.ver`, ["op", "restore_count", "basis"], ["current"], issues)) {
        check(int(ver["op"]), `${at}.ver`, "op", issues);
        check(int(ver["restore_count"]), `${at}.ver`, "restore_count", issues);
        check(oneOf(VER_BASES, ver["basis"]), `${at}.ver`, "basis", issues);
        // §5.2: only when true; a version the op took from its own request or a key has none.
        if ("current" in ver) {
          check(ver["current"] === true, `${at}.ver`, "current", issues);
          check(
            ver["basis"] === "explicit" || ver["basis"] === "fallback",
            `${at}.ver`,
            "current on this basis",
            issues,
          );
        }
        if (ver["basis"] === "external_key") {
          check(
            v["by_external_key"] === true,
            at,
            "external_key basis without by_external_key",
            issues,
          );
        }
      }
    }
  },
  RawValue(v, at, issues) {
    value(v, at, issues, true);
  },
  FieldIdList(v, at, issues) {
    // Absent when there are none (§5.7): never empty.
    list(v, at, issues, (x, a, is) => check(id("field", x), a, "field", is), true);
    if (Array.isArray(v)) check(new Set(v).size === v.length, at, "duplicate field", issues);
  },
  ValidParam(v, at, issues) {
    if (!keys(v, at, ["from", "to"], [], issues)) return;
    const end = (e: Json, a: string, modes: readonly string[]) => {
      if (isObject(e) && e["mode"] === "given") {
        if (keys(e, a, ["mode", "value"], [], issues)) check(point(e["value"]), a, "value", issues);
      } else if (keys(e, a, ["mode"], [], issues))
        check(oneOf(modes, e["mode"]), a, "mode", issues);
    };
    end(v["from"], `${at}.from`, ["now", "corrected_span"]);
    end(v["to"], `${at}.to`, ["open", "next_change", "corrected_span"]);
    const span = (e: Json) => isObject(e) && e["mode"] === "corrected_span";
    check(span(v["from"]) === span(v["to"]), at, "corrected_span on both ends", issues);
    // Both ends given: one granularity, the end after the start.
    const given = (e: Json) => (isObject(e) && e["mode"] === "given" ? e["value"] : undefined);
    const from = given(v["from"]);
    const to = given(v["to"]);
    if (point(from) && point(to)) {
      check(isDate(from) === isDate(to), at, "from and to of one granularity", issues);
      check(from < to, at, "to after from", issues);
    }
  },
  OpRevert(v, at, issues) {
    if (!keys(v, at, ["undo_op", "include_later"], [], issues)) return;
    check(int(v["undo_op"]), at, "undo_op", issues);
    check(typeof v["include_later"] === "boolean", at, "include_later", issues);
  },
  Acknowledge(v, at, issues) {
    check(Array.isArray(v) && v.length === 1 && v[0] === "overwrite", at, "acknowledge", issues);
  },

  // §5.7 write.base
  WriteBaseTarget(v, at, issues) {
    const req = ["table", "intent", "sv", "cause"];
    if (!keys(v, at, req, ["row", "entity", "created", "op_index", "item"], issues)) return;
    tableTarget(v, at, issues);
    check(oneOf(INTENTS, v["intent"]), at, "intent", issues);
    check(int(v["sv"]), at, "sv", issues);
    if ("created" in v) check(v["created"] === true, at, "created", issues);
    if (v["cause"] === "request") {
      check(int(v["op_index"]), at, "op_index", issues);
      check(!("item" in v), at, "item only with cause resolve", issues);
    } else if (v["cause"] === "resolve") {
      check(id("item", v["item"]), at, "item", issues);
      check(!("op_index" in v), at, "op_index only with cause request", issues);
    } else issues.push(`${at}: cause`);
  },
  FieldItem(v, at, issues) {
    const kind = isObject(v) ? ["value", "no_value", "uncovered"].filter((k) => k in v) : [];
    check(kind.length === 1, at, "exactly one of value, no_value, uncovered", issues);
    if (!keys(v, at, ["status", ...kind.slice(0, 1)], [], issues)) return;
    check(oneOf(FIELD_STATUSES, v["status"]), at, "status", issues);
    if (kind[0] === "value") value(v["value"], `${at}.value`, issues);
    else if (kind[0] !== undefined) check(v[kind[0]] === true, at, kind[0], issues);
  },
  Sources(v, at, issues) {
    list(
      v,
      at,
      issues,
      (e, a, is) => {
        if (isObject(e) && e["kind"] === "schema_const") {
          if (keys(e, a, ["kind", "sv", "field"], [], is)) {
            check(int(e["sv"]), a, "sv", is);
            check(id("field", e["field"]), a, "field", is);
          }
          return;
        }
        const from = isObject(e) && "carried" in e ? "carried" : "source";
        if (!keys(e, a, ["kind", from], [], is)) return;
        check(e["kind"] === "value", a, "kind", is);
        if (from === "source") check(seq(e["source"]), a, "source", is);
        else {
          const c = e["carried"];
          if (isObject(c) && "existence" in c) is.push(`${a}: carried from a field item`);
          else contribution(c, `${a}.carried`, is);
        }
      },
      true,
    );
  },
  Literal(v, at, issues) {
    if (!keys(v, at, ["segments"], [], issues)) return;
    list(
      v["segments"],
      `${at}.segments`,
      issues,
      (e, a, is) => {
        if (!keys(e, a, ["source", "result"], [], is)) return;
        check(seq(e["source"]), a, "source", is);
        check(oneOf(LITERAL_RESULTS, e["result"]), a, "result", is);
      },
      true,
    );
  },
  Span(v, at, issues) {
    const which = isObject(v) ? ["valid", "seen_valid"].filter((k) => k in v) : [];
    check(which.length === 1, at, "exactly one of valid and seen_valid", issues);
    if (!keys(v, at, which.slice(0, 1), ["deps"], issues)) return;
    // A field's span always has a start: only existence takes back a revoke of the whole time (§1.2).
    if (which[0] !== undefined) interval(v[which[0]], `${at}.${which[0]}`, issues);
    if ("deps" in v) deps(v["deps"], `${at}.deps`, issues);
  },
  ExistenceItem(v, at, issues) {
    if (!keys(v, at, ["status", "scope"], ["restored"], issues)) return;
    // Existence has no corroboration: a revoke or a restore is applied, a candidate or awaiting.
    check(
      oneOf(FIELD_STATUSES, v["status"]) && v["status"] !== "corroborated",
      at,
      "status",
      issues,
    );
    check(oneOf(EXISTENCE_SCOPES, v["scope"]), at, "scope", issues);
    if ("restored" in v) check(v["restored"] === true, at, "restored", issues);
  },
  ExistenceSpan(v, at, issues) {
    if (!keys(v, at, ["valid"], ["deps"], issues)) return;
    openInterval(v["valid"], `${at}.valid`, issues);
    if ("deps" in v) deps(v["deps"], `${at}.deps`, issues);
  },
  SourceSeqList(v, at, issues) {
    list(v, at, issues, (x, a, is) => check(seq(x), a, "seq", is), true);
    if (Array.isArray(v)) check(new Set(v).size === v.length, at, "duplicate seq", issues);
  },
  Ack(v, at, issues) {
    // A stretch that had a value (`value`, `op`) or none (`no_value`): exactly one of the two.
    const had = isObject(v) && "value" in v;
    const none = isObject(v) && "no_value" in v;
    check(had !== none, at, "exactly one of value and no_value", issues);
    const req = ["field", "valid", "deps", ...(none ? ["no_value"] : ["value", "op"])];
    if (!keys(v, at, req, [], issues)) return;
    check(id("field", v["field"]), at, "field", issues);
    interval(v["valid"], `${at}.valid`, issues);
    if (none) check(v["no_value"] === true, at, "no_value", issues);
    else {
      value(v["value"], `${at}.value`, issues);
      check(int(v["op"]), at, "op", issues);
    }
    deps(v["deps"], `${at}.deps`, issues);
  },
  Revert(v, at, issues) {
    if (isObject(v) && "as_of_op" in v) {
      if (!keys(v, at, ["as_of_op", "item", "items"], [], issues)) return;
      check(int(v["as_of_op"]), at, "as_of_op", issues);
      check(id("item", v["item"]), at, "item", issues);
      list(v["items"], `${at}.items`, issues, revertTarget([]));
      return;
    }
    if (!keys(v, at, ["before_op", "items"], ["skipped"], issues)) return;
    check(int(v["before_op"]), at, "before_op", issues);
    list(v["items"], `${at}.items`, issues, revertTarget(["later"]));
    if ("skipped" in v) {
      list(v["skipped"], `${at}.skipped`, issues, (e, a, is) => {
        check(isObject(e) && "by_op" in e, a, "by_op", is);
        revertTarget(["by_op"])(e, a, is);
      });
    }
  },
  Take(v, at, issues) {
    if (!keys(v, at, ["item", "candidate", "merge_base_op", "items"], [], issues)) return;
    check(id("item", v["item"]), at, "item", issues);
    check(int(v["candidate"]), at, "candidate", issues);
    check(int(v["merge_base_op"]), at, "merge_base_op", issues);
    list(v["items"], `${at}.items`, issues, revertTarget([]));
  },

  // §5.8 pending items
  ItemCreatedTarget(v, at, issues) {
    const type = isObject(v) ? v["type"] : undefined;
    const common = ["item", "type", "reason", "ruleset_version", "policy_version"];
    if (type === "schema_change") {
      if (!keys(v, at, [...common, "draft"], [], issues)) return;
      check(v["reason"] === "schema_change" && id("draft", v["draft"]), at, "draft", issues);
    } else {
      const req = [...common, "table", "origin_event"];
      const opt = ["row", "entity", "unit", "merge_base_op", "related_item"];
      if (!keys(v, at, req, opt, issues)) return;
      tableTarget(v, at, issues);
      check(seq(v["origin_event"]), at, "origin_event", issues);
      const reasons: Record<string, readonly string[]> = {
        conflict: ["stale_write", "restored_candidate"],
        awaiting_confirmation: [
          "overwrites_change_point",
          "referenced_row",
          "undo_includes_later",
          "undo_hides_later",
          "conflict_cleared_by_deletion",
        ],
        flagged: ["duplicate_keys"],
      };
      const allowed =
        typeof type === "string" && Object.hasOwn(reasons, type) ? reasons[type] : undefined;
      check(allowed !== undefined && oneOf(allowed, v["reason"]), at, "type and reason", issues);
      check("unit" in v || type === "flagged", at, "unit", issues);
      if ("unit" in v) {
        const u = v["unit"];
        const ok =
          Array.isArray(u) &&
          u.length > 0 &&
          ((u.length === 1 && u[0] === "existence") ||
            (u.every((f) => id("field", f)) && new Set(u).size === u.length));
        check(ok, at, "unit", issues);
      }
      check("merge_base_op" in v === (type === "conflict"), at, "merge_base_op", issues);
      if ("merge_base_op" in v) check(int(v["merge_base_op"]), at, "merge_base_op", issues);
      const restored = v["reason"] === "restored_candidate";
      check("related_item" in v === restored, at, "related_item", issues);
      if (restored) check(id("item", v["related_item"]), at, "related_item", issues);
    }
    check(id("item", v["item"]), at, "item", issues);
    versions(v, at, issues);
  },
  /**
   * The item's interval as its spans: at least one, by start, neither overlapping nor touching
   * (touching ones are one span), of one granularity; only the first one may be open at the start
   * (`{to}`, a write-back over the whole time cut by another item), only the last one at the end.
   * The whole time is `[{}]`, both the first span and the last.
   */
  ScopeValid(v, at, issues) {
    if (!keys(v, at, ["spans", "deps"], [], issues)) return;
    const spans = v["spans"];
    if (!Array.isArray(spans) || spans.length === 0) {
      issues.push(`${at}.spans: at least one span`);
    } else {
      /** A span's one point that tells its granularity: its start, or its end when open there. */
      const pointOf = (s: Json) =>
        isObject(s)
          ? point(s["from"])
            ? s["from"]
            : point(s["to"])
              ? s["to"]
              : undefined
          : undefined;
      spans.forEach((s, i) => {
        const where = `${at}.spans[${i}]`;
        if (i === 0) {
          openInterval(s, where, issues);
          // Open at both ends: the whole time, which meets every other span.
          if (isObject(s) && !("from" in s) && !("to" in s)) {
            check(spans.length === 1, at, "the whole time alone", issues);
          }
        } else {
          interval(s, where, issues);
        }
        // One granularity: every span by date, or every one by instant.
        const first = pointOf(spans[0]);
        const here = pointOf(s);
        if (i > 0 && first !== undefined && here !== undefined) {
          check(isDate(first) === isDate(here), at, "spans of one granularity", issues);
        }
        const prev = i > 0 ? spans[i - 1] : undefined;
        if (isObject(prev)) {
          check("to" in prev, at, "only the last span open", issues);
          if (isObject(s) && "to" in prev && point(prev["to"]) && point(s["from"])) {
            check(prev["to"] < s["from"], at, "spans by start, apart", issues);
          }
        }
      });
    }
    deps(v["deps"], `${at}.deps`, issues);
  },
  CurrentEntry(v, at, issues) {
    if (isObject(v) && v["field"] === "existence") {
      existenceEntry(v, at, issues);
      return;
    }
    if (!keys(v, at, ["field", "value", "op", "deps"], ["valid"], issues)) return;
    check(id("field", v["field"]), at, "field", issues);
    check(int(v["op"]), at, "op", issues);
    value(v["value"], `${at}.value`, issues);
    if ("valid" in v) interval(v["valid"], `${at}.valid`, issues);
    deps(v["deps"], `${at}.deps`, issues);
  },
  Candidate(v, at, issues) {
    if (!keys(v, at, ["event", "intent", "seen", "cause", "items", "deps"], [], issues)) return;
    check(seq(v["event"]), at, "event", issues);
    check(oneOf(INTENTS, v["intent"]), at, "intent", issues);
    const seen = v["seen"];
    if (keys(seen, `${at}.seen`, ["op", "restore_count"], [], issues)) {
      check(int(seen["op"]), `${at}.seen`, "op", issues);
      check(int(seen["restore_count"]), `${at}.seen`, "restore_count", issues);
    }
    check(oneOf(CANDIDATE_CAUSES, v["cause"]), at, "cause", issues);
    list(
      v["items"],
      `${at}.items`,
      issues,
      (e, a, is) => {
        if (isObject(e) && "existence" in e) {
          if (!keys(e, a, ["existence"], ["valid"], is)) return;
          check(int(e["existence"]), a, "existence", is);
          if ("valid" in e) openInterval(e["valid"], `${a}.valid`, is);
        } else {
          if (!keys(e, a, ["field", "k", "value"], ["valid"], is)) return;
          check(id("field", e["field"]), a, "field", is);
          check(int(e["k"]), a, "k", is);
          value(e["value"], `${a}.value`, is);
          if ("valid" in e) interval(e["valid"], `${a}.valid`, is);
        }
      },
      true,
    );
    // A revoke candidate has its existence item only; any other has field items only.
    if (Array.isArray(v["items"])) {
      const ex = v["items"].filter((e) => isObject(e) && "existence" in e).length;
      if (v["intent"] === "revoke") {
        check(ex === 1 && v["items"].length === 1, at, "a revoke candidate's items", issues);
      } else check(ex === 0, at, "an existence item on a candidate that is not a revoke", issues);
    }
    deps(v["deps"], `${at}.deps`, issues);
  },
  /** `previous/<n>`: a field's value at the merge base, or an entry on the unit "existence". */
  PreviousEntry(v, at, issues) {
    if (isObject(v) && v["field"] === "existence") {
      existenceEntry(v, at, issues);
      return;
    }
    if (!keys(v, at, ["field", "value", "deps"], ["valid"], issues)) return;
    check(id("field", v["field"]), at, "field", issues);
    value(v["value"], `${at}.value`, issues);
    if ("valid" in v) interval(v["valid"], `${at}.valid`, issues);
    deps(v["deps"], `${at}.deps`, issues);
  },
  FieldEntry(v, at, issues) {
    if (!keys(v, at, ["field", "value", "deps"], ["valid"], issues)) return;
    check(id("field", v["field"]), at, "field", issues);
    value(v["value"], `${at}.value`, issues);
    if ("valid" in v) interval(v["valid"], `${at}.valid`, issues);
    deps(v["deps"], `${at}.deps`, issues);
  },
  Impact(v, at, issues) {
    const kind = isObject(v) ? v["kind"] : undefined;
    if (kind === "overwritten_segment") {
      // A stretch without a value (a gap filled: `gap`, value null) has no op unless a revoke left
      // it; any other stretch, a value cleared to null among them, names the write that gave it.
      if (!keys(v, at, ["kind", "field", "value", "deps"], ["valid", "op", "gap"], issues)) return;
      check(id("field", v["field"]), at, "field", issues);
      if ("gap" in v) check(v["gap"] === true && v["value"] === null, at, "gap", issues);
      if ("op" in v) check(int(v["op"]), at, "op", issues);
      check("op" in v || "gap" in v, at, "op", issues);
      value(v["value"], `${at}.value`, issues);
      if ("valid" in v) interval(v["valid"], `${at}.valid`, issues);
      deps(v["deps"], `${at}.deps`, issues);
    } else if (kind === "referencing_row") {
      if (!keys(v, at, ["kind", "table", "field"], ["row", "entity"], issues)) return;
      tableTarget(v, at, issues);
      check(id("field", v["field"]), at, "field", issues);
    } else if (kind === "reverted_write") {
      if (!keys(v, at, ["kind", "op", "deps"], [], issues)) return;
      check(int(v["op"]), at, "op", issues);
      deps(v["deps"], `${at}.deps`, issues);
    } else issues.push(`${at}: kind`);
  },
  ItemMergedTarget(v, at, issues) {
    const req = ["item", "merge_base_op", "origin_event", "ruleset_version", "policy_version"];
    if (!keys(v, at, req, [], issues)) return;
    check(id("item", v["item"]), at, "item", issues);
    check(int(v["merge_base_op"]), at, "merge_base_op", issues);
    check(seq(v["origin_event"]), at, "origin_event", issues);
    versions(v, at, issues);
  },
  ItemRefreshedTarget(v, at, issues) {
    const cause = isObject(v) ? v["cause"] : undefined;
    const byCause: Record<string, { req: string[]; opt: string[] }> = {
      target_overwritten: { req: ["by_event", "writer_had_read"], opt: [] },
      references_changed: { req: ["by_event", "writer_had_read"], opt: [] },
      matched_changed: { req: ["by_event"], opt: [] },
      entries_changed: { req: ["by_event"], opt: [] },
      entries_deleted: { req: [], opt: ["dropped_candidates"] },
      entries_restored: { req: [], opt: ["restored_candidates"] },
    };
    const shape =
      typeof cause === "string" && Object.hasOwn(byCause, cause) ? byCause[cause] : undefined;
    check(shape !== undefined && oneOf(REFRESH_CAUSES, cause), at, "cause", issues);
    if (shape === undefined) return;
    if (!keys(v, at, ["item", "cause", ...shape.req], [...shape.opt, "merge_base_op"], issues))
      return;
    check(id("item", v["item"]), at, "item", issues);
    if ("by_event" in v) check(seq(v["by_event"]), at, "by_event", issues);
    if (cause === "target_overwritten") check(v["writer_had_read"] === false, at, "read", issues);
    if (cause === "references_changed") {
      check(typeof v["writer_had_read"] === "boolean", at, "writer_had_read", issues);
    }
    for (const k of ["dropped_candidates", "restored_candidates"]) {
      if (k in v) {
        const ks = v[k];
        check(Array.isArray(ks) && ks.length > 0 && ks.every(int), at, k, issues);
      }
    }
    if ("merge_base_op" in v) check(int(v["merge_base_op"]), at, "merge_base_op", issues);
  },
  ItemSupersededTarget(v, at, issues) {
    // `writer_had_read` only with `overwritten`, and not there for a flagged item (§5.8): the
    // event does not tell the item's type, so it may be absent.
    const overwritten = isObject(v) && v["reason"] === "overwritten";
    const opt = overwritten ? ["writer_had_read"] : [];
    if (!keys(v, at, ["item", "reason", "by_event"], opt, issues)) return;
    check(id("item", v["item"]), at, "item", issues);
    check(seq(v["by_event"]), at, "by_event", issues);
    check(oneOf(SUPERSEDED_REASONS, v["reason"]), at, "reason", issues);
    if ("writer_had_read" in v) {
      check(typeof v["writer_had_read"] === "boolean", at, "writer_had_read", issues);
    }
  },
  ItemResolvedTarget(v, at, issues) {
    const take = isObject(v) && v["decision"] === "take_candidate";
    const req = [
      "item",
      "decision",
      "item_op",
      "restore_count",
      "via",
      ...(take ? ["candidate"] : []),
    ];
    if (!keys(v, at, req, [], issues)) return;
    check(id("item", v["item"]), at, "item", issues);
    check(oneOf(EVENT_DECISIONS, v["decision"]), at, "decision", issues);
    check(int(v["item_op"]), at, "item_op", issues);
    check(int(v["restore_count"]), at, "restore_count", issues);
    check(v["via"] === "call", at, "via", issues);
    if (take) check(int(v["candidate"]), at, "candidate", issues);
  },
  Confirmation(v, at, issues) {
    if (!keys(v, at, ["hash"], [], issues)) return;
    check(str(v["hash"]) && isHash(v["hash"]), at, "hash", issues);
  },
};

// --- rules between the blocks of one event ----------------------------------------------------

/**
 * A rule between blocks of one event. `paths` holds the present blocks and the removed ones (a
 * removed data block counts as present, §1.1); `blocks` the present ones.
 */
export type EventRule = (
  paths: ReadonlySet<string>,
  blocks: Readonly<Record<string, Json>>,
  issues: Issues,
) => void;

/** §5.1: at most one of `request_key` and `idempotency`. */
const oneRequestId: EventRule = (paths, _, issues) => {
  check(
    !(paths.has("request_key") && paths.has("idempotency")),
    "event",
    "request_key and idempotency",
    issues,
  );
};

const TEXT_KINDS = ["user_message", "agent_note", "tool_result"];

export const WRITE_EVENT_RULES: Readonly<Record<string, EventRule>> = {
  // §5.7: an emptied partition has no result, so neither a key nor a checksum; a partition with a
  // row has the checksum of its result.
  "write.derived"(paths, blocks, issues) {
    const t = blocks["target"];
    const emptied = isObject(t) ? t["emptied"] : undefined;
    if (emptied === true) {
      check(!paths.has("key"), "key", "not with emptied", issues);
      check(!paths.has("checksum"), "checksum", "not with emptied", issues);
    } else if (emptied === false) {
      check(paths.has("checksum"), "checksum", "required unless emptied", issues);
    }
  },
  // §5.6: exactly one of `text`, `file`, `request`, each with its kinds.
  "source.recorded"(paths, blocks, issues) {
    const content = ["text", "file", "request"].filter((p) => paths.has(p));
    check(content.length === 1, "event", "exactly one of text, file, request", issues);
    const t = blocks["target"];
    const kind = isObject(t) ? t["kind"] : undefined;
    if (paths.has("text")) check(oneOf(TEXT_KINDS, kind), "text", "kind", issues);
    if (paths.has("file")) check(kind === "file_ref", "file", "kind", issues);
    if (paths.has("request")) check(kind === "api_call", "request", "kind", issues);
  },
  // §5.7: the ops of the request are 0 .. op_count − 1.
  "write.head"(paths, blocks, issues) {
    oneRequestId(paths, blocks, issues);
    const r = blocks["request"];
    const count = isObject(r) && int(r["op_count"]) ? r["op_count"] : undefined;
    if (count === undefined) return;
    for (const p of paths) {
      const m = /^ops\/(\d+)\//.exec(p);
      if (m !== null) check(Number(m[1]) < count, p, "op index not below op_count", issues);
    }
  },
  // §5.7: a value item has its sources, a `no_value` or `uncovered` item none; spans and literal
  // checks belong to an item; an existence item has a span exactly when its scope is `interval`;
  // a write is a revert or a take, not both.
  "write.base"(paths, blocks, issues) {
    for (const p of paths) {
      const field = /^(sources|span|literal)\/(f\d+\/\d+)$/.exec(p);
      if (field !== null) {
        check(paths.has(`fields/${field[2]}`), p, "no such item", issues);
      }
      const item = /^fields\/(f\d+\/\d+)$/.exec(p);
      if (item !== null && p in blocks) {
        const v = blocks[p];
        const valued = isObject(v) && "value" in v;
        const hasSources = paths.has(`sources/${item[1]}`);
        check(
          valued === hasSources,
          p,
          valued ? "sources required" : "sources only on a value",
          issues,
        );
      }
      const ex = /^existence\/(\d+)$/.exec(p);
      if (ex !== null) {
        const v = blocks[p];
        const interval = isObject(v) && v["scope"] === "interval";
        const hasSpan = paths.has(`span/existence/${ex[1]}`);
        check(
          interval === hasSpan,
          p,
          interval ? "span required" : "no span with scope whole",
          issues,
        );
      }
      const exSpan = /^span\/existence\/(\d+)$/.exec(p);
      if (exSpan !== null) check(paths.has(`existence/${exSpan[1]}`), p, "no such item", issues);
    }
    check(!(paths.has("revert") && paths.has("take")), "event", "revert and take", issues);
  },
  // §5.8: a schema change item has no candidates.
  "item.created"(paths, blocks, issues) {
    const t = blocks["target"];
    if (isObject(t) && t["type"] === "schema_change") {
      check(
        ![...paths].some((p) => p.startsWith("candidates/")),
        "event",
        "candidates on a schema change",
        issues,
      );
    }
  },
  "item.resolved": oneRequestId,
};
