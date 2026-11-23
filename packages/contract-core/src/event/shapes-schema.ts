// Block shape checks of the slot policy and schema lifecycle events (docs/zh-CN/spec/09-event-format.md
// §5.4 `slot.policy_set`, §5.5 `schema.*`, §7 the compiled schema definition), as the types in
// ./blocks.ts and ./compiled.ts give them.
//
// The compiled definition is checked as a whole: its keys and values, and its references inside
// itself (a key, group or time field names a field of the same table; a ref or a rule's dependency
// names a table and field of the same definition). The physical table name is pinned to
// `t_<table>_v<since>` (`d_…` for a derived table; 02-architecture §8): `apply` creates tables
// under that name.
// Whether a draft compiles, and whether the definition follows from it, is the compiler's.
//
// The submitted draft is the schema document verbatim: here only an object. Its rules are the
// compiler's (03-data-model/07-schema-evolution.md).

import { check, type Issues, isObject, type Json, keys, type ShapeChecker, str } from "./check.ts";
import {
  AUTO_APPLY_CLASSES,
  CHANGE_CLASSES,
  COMPILE_OUTCOMES,
  CONFIRMED_BY,
  EFFECTIVE_VALUE_RULES,
  FIELD_TYPES,
  GRANULARITIES,
  MIGRATION_FAILURE_REASONS,
  REF_TARGETS,
  ROUNDINGS,
  SCHEMA_CHANGE_CODES,
  TIME_DEPENDENCIES,
} from "./enums.ts";
import {
  deps,
  type EventRule,
  id,
  int,
  interval,
  list,
  oneOf,
  slotCtx,
  value,
} from "./shapes-write.ts";
import { isCanonicalDecimal, isHash } from "./values.ts";

const version = (v: Json) => int(v) && (v as number) >= 1;
const text = (v: Json) => str(v) && v !== "";
const decimal = (v: Json) => str(v) && isCanonicalDecimal(v);
const RSQL = /^rsql@[1-9][0-9]*$/;

/** A list of unique values, each checked by `each`. */
function unique(v: Json, at: string, issues: Issues, each: (x: Json) => boolean, what: string) {
  if (!Array.isArray(v)) {
    issues.push(`${at}: not an array`);
    return;
  }
  v.forEach((x, i) => {
    check(each(x), `${at}[${i}]`, what, issues);
  });
  check(new Set(v).size === v.length, at, "unique", issues);
}

const strings: ShapeChecker = (v, at, issues) => unique(v, at, issues, text, "a non-empty string");

// --- §7 the compiled definition ---------------------------------------------------------------

/** Keys a field of each type may carry beyond the common ones. */
const TYPE_KEYS: Readonly<Record<string, { base: string[]; derived: string[]; needs: string[] }>> =
  {
    text: { base: [], derived: [], needs: [] },
    boolean: { base: [], derived: [], needs: [] },
    date: { base: [], derived: [], needs: [] },
    zoned_datetime: { base: [], derived: [], needs: [] },
    enum: { base: ["values"], derived: [], needs: ["values"] },
    integer: { base: ["min", "max"], derived: [], needs: [] },
    decimal: { base: ["min", "max", "precision"], derived: ["precision"], needs: ["precision"] },
    quantity: {
      base: ["min", "max", "unit", "precision"],
      derived: ["unit", "precision"],
      needs: ["unit", "precision"],
    },
    ref: { base: ["ref"], derived: [], needs: ["ref"] },
  };
const BASE_ONLY = ["required", "migrate", "backfill", "from"];

function sqlExpr(v: Json, at: string, issues: Issues): void {
  if (!keys(v, at, ["sql"], [], issues)) return;
  check(text(v["sql"]), at, "sql", issues);
}

function field(v: Json, at: string, issues: Issues, base: boolean, tables: ReadonlySet<Json>) {
  const type = isObject(v) ? v["type"] : undefined;
  if (!oneOf(FIELD_TYPES, type)) {
    issues.push(`${at}: type`);
    return;
  }
  const t = TYPE_KEYS[type as string] as { base: string[]; derived: string[]; needs: string[] };
  const extra = base ? [...t.base, ...BASE_ONLY] : t.derived;
  const needs = base || type === "decimal" || type === "quantity" ? t.needs : [];
  const optional = [...extra.filter((k) => !needs.includes(k)), "aliases"];
  if (!keys(v, at, ["id", "name", "type", "description", ...needs], optional, issues)) return;
  check(id("field", v["id"]), at, "id", issues);
  check(text(v["name"]), at, "name", issues);
  check(text(v["description"]), at, "description", issues);
  if ("aliases" in v) strings(v["aliases"], `${at}.aliases`, issues);
  if ("required" in v) check(v["required"] === true, at, "required only as true", issues);
  for (const k of ["min", "max"]) if (k in v) check(decimal(v[k]), at, k, issues);
  if ("values" in v) {
    unique(v["values"], `${at}.values`, issues, text, "a non-empty string");
    check(Array.isArray(v["values"]) && v["values"].length > 0, at, "values empty", issues);
  }
  if ("unit" in v) {
    const u = v["unit"];
    if (keys(u, `${at}.unit`, ["code", "dimension"], ["to_base"], issues)) {
      check(text(u["code"]), `${at}.unit`, "code", issues);
      check(text(u["dimension"]), `${at}.unit`, "dimension", issues);
      if ("to_base" in u) check(decimal(u["to_base"]), `${at}.unit`, "to_base", issues);
    }
  }
  if ("precision" in v) {
    const p = v["precision"];
    if (keys(p, `${at}.precision`, ["scale", "rounding"], [], issues)) {
      const s = p["scale"];
      check(
        int(s) && (s as number) >= 0 && (s as number) <= 12,
        `${at}.precision`,
        "scale",
        issues,
      );
      check(oneOf(ROUNDINGS, p["rounding"]), `${at}.precision`, "rounding", issues);
    }
  }
  if ("ref" in v) {
    const r = v["ref"];
    if (keys(r, `${at}.ref`, ["table", "target"], [], issues)) {
      check(id("table", r["table"]) && tables.has(r["table"]), `${at}.ref`, "table", issues);
      check(oneOf(REF_TARGETS, r["target"]), `${at}.ref`, "target", issues);
    }
  }
  if ("migrate" in v) sqlExpr(v["migrate"], `${at}.migrate`, issues);
  if ("backfill" in v) {
    const b = v["backfill"];
    if (isObject(b) && "const" in b) {
      if (keys(b, `${at}.backfill`, ["const"], [], issues)) {
        value(b["const"], `${at}.backfill.const`, issues);
      }
    } else sqlExpr(b, `${at}.backfill`, issues);
  }
  if ("from" in v) check(id("field", v["from"]), at, "from", issues);
}

/** A list of field ID lists, every ID a field of the table, no list empty. */
function fieldGroups(v: Json, at: string, issues: Issues, own: ReadonlySet<Json>) {
  list(v, at, issues, (g, gat, gi) => {
    unique(g, gat, gi, (x) => own.has(x), "a field of this table");
    check(Array.isArray(g) && g.length > 0, gat, "empty", gi);
  });
}

/**
 * `together`: conflict groups, so a field's conflict unit is one: a field in at most one group,
 * each group of two fields or more (09 §7).
 */
function conflictGroups(v: Json, at: string, issues: Issues, own: ReadonlySet<Json>) {
  fieldGroups(v, at, issues, own);
  if (!Array.isArray(v)) return;
  v.forEach((g, i) => {
    check(
      Array.isArray(g) && g.length >= 2,
      `${at}[${i}]`,
      "a group of two fields or more",
      issues,
    );
  });
  const all = v.flatMap((g) => (Array.isArray(g) ? g : []));
  check(new Set(all).size === all.length, at, "a field in at most one group", issues);
}

function table(
  v: Json,
  at: string,
  issues: Issues,
  sv: Json,
  fieldsOf: ReadonlyMap<Json, ReadonlySet<Json>>,
) {
  const kind = isObject(v) ? v["kind"] : undefined;
  if (kind !== "base" && kind !== "derived") {
    issues.push(`${at}: kind`);
    return;
  }
  const base = kind === "base";
  const req = ["id", "name", "kind", "description", "physical", "fields", base ? "time" : "rule"];
  const opt = base
    ? ["aliases", "entity_key", "together", "duplicate_keys", "external_key"]
    : ["aliases"];
  if (!keys(v, at, req, opt, issues)) return;
  check(id("table", v["id"]), at, "id", issues);
  check(text(v["name"]), at, "name", issues);
  check(text(v["description"]), at, "description", issues);
  if ("aliases" in v) strings(v["aliases"], `${at}.aliases`, issues);

  const ph = v["physical"];
  if (keys(ph, `${at}.physical`, ["table"], ["since"], issues)) {
    const since = "since" in ph ? ph["since"] : sv;
    check(
      !("since" in ph) || (version(since) && version(sv) && (since as number) <= (sv as number)),
      `${at}.physical`,
      "since",
      issues,
    );
    // Values are compared only once their types are known: an object here must be refused,
    // not turned into a string.
    const named = id("table", v["id"]) && version(since);
    check(
      named && ph["table"] === `${base ? "t" : "d"}_${v["id"] as string}_v${since as number}`,
      `${at}.physical`,
      "table",
      issues,
    );
  }

  const tables = new Set(fieldsOf.keys());
  list(v["fields"], `${at}.fields`, issues, (f, fat, fi) => field(f, fat, fi, base, tables), true);
  const ids = Array.isArray(v["fields"])
    ? v["fields"].map((f) => (isObject(f) ? f["id"] : undefined))
    : [];
  check(new Set(ids).size === ids.length, `${at}.fields`, "unique ids", issues);
  const own = new Set(ids);
  const fieldById = new Map<Json, Record<string, Json>>();
  if (Array.isArray(v["fields"])) {
    for (const f of v["fields"]) if (isObject(f)) fieldById.set(f["id"], f);
  }

  if (base) {
    const time = v["time"];
    const type = isObject(time) ? time["type"] : undefined;
    if (type === "none") keys(time, `${at}.time`, ["type"], [], issues);
    else if (type === "event") {
      if (keys(time, `${at}.time`, ["type", "field"], [], issues)) {
        // The event time is a date or a zoned date-time of the row (09 §7 `time`).
        const ft = fieldById.get(time["field"])?.["type"];
        check(ft === "date" || ft === "zoned_datetime", `${at}.time`, "field", issues);
      }
    } else if (type === "state") {
      if (keys(time, `${at}.time`, ["type", "granularity"], [], issues)) {
        check(oneOf(GRANULARITIES, time["granularity"]), `${at}.time`, "granularity", issues);
      }
    } else issues.push(`${at}.time: type`);
    const state = type === "state";
    if ("entity_key" in v) {
      // Not empty, and every key field required: an entity is found by its key (09 §7).
      const k = v["entity_key"];
      check(state, at, "entity_key only on a state table", issues);
      unique(
        k,
        `${at}.entity_key`,
        issues,
        (x) => fieldById.get(x)?.["required"] === true,
        "a required field",
      );
      check(Array.isArray(k) && k.length > 0, at, "entity_key empty", issues);
    }
    if ("together" in v) conflictGroups(v["together"], `${at}.together`, issues, own);
    if ("duplicate_keys" in v) {
      check(!state, at, "duplicate_keys not on a state table", issues);
      fieldGroups(v["duplicate_keys"], `${at}.duplicate_keys`, issues, own);
    }
    if ("external_key" in v) {
      const k = v["external_key"];
      check(!state, at, "external_key not on a state table", issues);
      unique(k, `${at}.external_key`, issues, (x) => own.has(x), "a field");
      check(Array.isArray(k) && k.length >= 1 && k.length <= 4, at, "external_key 1–4", issues);
      const grouped = new Set(Array.isArray(v["together"]) ? v["together"].flat() : []);
      check(
        Array.isArray(k) && k.every((x) => !grouped.has(x)),
        at,
        "external_key fields not in together",
        issues,
      );
    }
    return;
  }

  const r = v["rule"];
  const rat = `${at}.rule`;
  if (
    !keys(
      r,
      rat,
      ["id", "version", "rsql", "sql", "time_dependency", "depends_on", "scope"],
      [],
      issues,
    )
  )
    return;
  check(id("rule", r["id"]), rat, "id", issues);
  check(version(r["version"]), rat, "version", issues);
  check(str(r["rsql"]) && RSQL.test(r["rsql"]), rat, "rsql", issues);
  check(text(r["sql"]), rat, "sql", issues);
  check(oneOf(TIME_DEPENDENCIES, r["time_dependency"]), rat, "time_dependency", issues);
  list(r["depends_on"], `${rat}.depends_on`, issues, (d, dat, di) => {
    if (!keys(d, dat, ["table", "field"], [], di)) return;
    const fs = fieldsOf.get(d["table"]);
    check(fs !== undefined, dat, "table", di);
    check(fs?.has(d["field"]) === true, dat, "field", di);
  });
  const s = r["scope"];
  const sk = isObject(s) ? s["kind"] : undefined;
  if (sk === "tenant") keys(s, `${rat}.scope`, ["kind"], [], issues);
  else if (sk === "group") {
    if (keys(s, `${rat}.scope`, ["kind", "key", "key_from_free_text"], [], issues)) {
      unique(s["key"], `${rat}.scope.key`, issues, (x) => own.has(x), "a field of this table");
      check(
        typeof s["key_from_free_text"] === "boolean",
        `${rat}.scope`,
        "key_from_free_text",
        issues,
      );
    }
  } else issues.push(`${rat}.scope: kind`);
}

const compiled: ShapeChecker = (v, at, issues) => {
  if (!keys(v, at, ["compiler", "rsql", "slot", "name", "sv", "timezone", "tables"], [], issues))
    return;
  check(v["compiler"] === 1, at, "compiler", issues);
  check(str(v["rsql"]) && RSQL.test(v["rsql"]), at, "rsql", issues);
  check(id("slot", v["slot"]), at, "slot", issues);
  check(text(v["name"]), at, "name", issues);
  check(version(v["sv"]), at, "sv", issues);
  check(text(v["timezone"]), at, "timezone", issues);
  const tables = Array.isArray(v["tables"]) ? v["tables"] : [];
  // The fields of each table, for references inside the definition.
  const fieldsOf = new Map<Json, Set<Json>>();
  for (const t of tables) {
    if (!isObject(t)) continue;
    const fs = Array.isArray(t["fields"]) ? t["fields"] : [];
    fieldsOf.set(t["id"], new Set(fs.map((f) => (isObject(f) ? f["id"] : undefined))));
  }
  list(v["tables"], `${at}.tables`, issues, (t, tat, ti) => table(t, tat, ti, v["sv"], fieldsOf));
  const ids = tables.map((t) => (isObject(t) ? t["id"] : undefined));
  check(new Set(ids).size === ids.length, `${at}.tables`, "unique ids", issues);
};

// --- §5.5 changes -------------------------------------------------------------------------------

const SLOT_CHANGES = ["create_slot", "rename_slot", "change_timezone"];

function change(v: Json, at: string, issues: Issues): void {
  const req = ["target", "change", "class", "compatible_with_old_writes", "destructive", "auto"];
  if (!keys(v, at, req, ["as_never_written"], issues)) return;
  const t = v["target"];
  const tat = `${at}.target`;
  const code = v["change"];
  check(oneOf(SCHEMA_CHANGE_CODES, code), at, "change", issues);
  if (isObject(t) && "slot" in t) {
    if (keys(t, tat, ["slot"], [], issues)) check(t["slot"] === true, tat, "slot", issues);
    check(SLOT_CHANGES.includes(code as string), at, "a slot-level change", issues);
  } else if (isObject(t) && "rule" in t) {
    if (keys(t, tat, ["table", "rule"], [], issues)) {
      check(id("table", t["table"]), tat, "table", issues);
      check(t["rule"] === true, tat, "rule", issues);
    }
    check(code === "change_rule", at, "change_rule on a rule", issues);
  } else if (keys(t, tat, ["table"], ["field"], issues)) {
    check(id("table", t["table"]), tat, "table", issues);
    if ("field" in t) check(id("field", t["field"]), tat, "field", issues);
    check(
      !SLOT_CHANGES.includes(code as string) && code !== "change_rule",
      at,
      "a table or field change",
      issues,
    );
  }
  check(oneOf(CHANGE_CLASSES, v["class"]), at, "class", issues);
  for (const k of ["compatible_with_old_writes", "destructive", "auto"]) {
    check(typeof v[k] === "boolean", at, k, issues);
  }
  // Only `true`, only with `class: "metadata"`, and only on a table or a field of one.
  if ("as_never_written" in v) {
    check(v["as_never_written"] === true, at, "as_never_written true", issues);
    check(v["class"] === "metadata", at, "as_never_written with class metadata", issues);
    check(
      isObject(t) && "table" in t && !("rule" in t),
      at,
      "as_never_written on a table or field",
      issues,
    );
  }
}

// --- shapes ------------------------------------------------------------------------------------

export const SCHEMA_SHAPES: Record<string, ShapeChecker> = {
  // §5.1 ctx of the other slot head events
  SlotCtx: slotCtx("absent"),
  // §5.4
  Policy(v, at, issues) {
    const req = [
      "policy_version",
      "effective_value_rule",
      "rank",
      "auto_apply",
      "high_impact",
      "user_session_only",
    ];
    if (!keys(v, at, req, [], issues)) return;
    check(version(v["policy_version"]), at, "policy_version", issues);
    check(
      oneOf(EFFECTIVE_VALUE_RULES, v["effective_value_rule"]),
      at,
      "effective_value_rule",
      issues,
    );
    const r = v["rank"];
    if (keys(r, `${at}.rank`, ["user_stated", "agent_inferred", "miss"], [], issues)) {
      for (const k of ["user_stated", "agent_inferred", "miss"])
        check(int(r[k]), `${at}.rank`, k, issues);
    }
    unique(
      v["auto_apply"],
      `${at}.auto_apply`,
      issues,
      (x) => oneOf(AUTO_APPLY_CLASSES, x),
      "a class",
    );
    // Non-empty forms are reserved shapes, not part of v = 1 (§5.4).
    check(
      Array.isArray(v["high_impact"]) && v["high_impact"].length === 0,
      at,
      "high_impact",
      issues,
    );
    check(
      Array.isArray(v["user_session_only"]) && v["user_session_only"].length === 0,
      at,
      "user_session_only",
      issues,
    );
  },
  // §5.5
  DraftSubmittedTarget(v, at, issues) {
    const creates = isObject(v) && v["creates_slot"] === true;
    const req = creates
      ? ["draft_id", "creates_slot"]
      : ["draft_id", "creates_slot", "base_version"];
    if (!keys(v, at, req, [], issues)) return;
    check(id("draft", v["draft_id"]), at, "draft_id", issues);
    check(typeof v["creates_slot"] === "boolean", at, "creates_slot", issues);
    if ("base_version" in v) check(version(v["base_version"]), at, "base_version", issues);
  },
  Draft(v, at, issues) {
    check(isObject(v), at, "not an object", issues);
  },
  CompiledTarget(v, at, issues) {
    if (!keys(v, at, ["draft_id", "target_version", "outcome"], [], issues)) return;
    check(id("draft", v["draft_id"]), at, "draft_id", issues);
    check(version(v["target_version"]), at, "target_version", issues);
    check(oneOf(COMPILE_OUTCOMES, v["outcome"]), at, "outcome", issues);
  },
  Compiled: compiled,
  Changes(v, at, issues) {
    list(v, at, issues, change, true);
  },
  ConfirmedTarget(v, at, issues) {
    if (!keys(v, at, ["draft_id", "target_version", "by"], [], issues)) return;
    check(id("draft", v["draft_id"]), at, "draft_id", issues);
    check(version(v["target_version"]), at, "target_version", issues);
    check(oneOf(CONFIRMED_BY, v["by"]), at, "by", issues);
  },
  RejectedTarget(v, at, issues) {
    if (!keys(v, at, ["draft_id"], [], issues)) return;
    check(id("draft", v["draft_id"]), at, "draft_id", issues);
  },
  SchemaSupersededTarget(v, at, issues) {
    if (!keys(v, at, ["draft_id", "by_draft"], [], issues)) return;
    check(id("draft", v["draft_id"]), at, "draft_id", issues);
    check(id("draft", v["by_draft"]), at, "by_draft", issues);
    check(v["draft_id"] !== v["by_draft"], at, "by another draft", issues);
  },
  MigrationStartedTarget(v, at, issues) {
    if (!keys(v, at, ["migration_id", "draft_id", "from_version", "to_version"], [], issues))
      return;
    check(id("migration", v["migration_id"]), at, "migration_id", issues);
    check(id("draft", v["draft_id"]), at, "draft_id", issues);
    check(version(v["from_version"]), at, "from_version", issues);
    check(version(v["to_version"]), at, "to_version", issues);
    check(
      version(v["from_version"]) &&
        version(v["to_version"]) &&
        (v["to_version"] as number) > (v["from_version"] as number),
      at,
      "to_version after from_version",
      issues,
    );
  },
  SwitchedTarget(v, at, issues) {
    const opt = ["from_version", "migration_id"];
    if (!keys(v, at, ["draft_id", "to_version", "rebuilt_tables"], opt, issues)) return;
    check(id("draft", v["draft_id"]), at, "draft_id", issues);
    check(version(v["to_version"]), at, "to_version", issues);
    if ("from_version" in v) {
      check(version(v["from_version"]), at, "from_version", issues);
      check(
        version(v["from_version"]) &&
          version(v["to_version"]) &&
          (v["to_version"] as number) > (v["from_version"] as number),
        at,
        "to_version after from_version",
        issues,
      );
    }
    if ("migration_id" in v) {
      check(id("migration", v["migration_id"]), at, "migration_id", issues);
      // Creating a slot runs no migration.
      check("from_version" in v, at, "migration_id without from_version", issues);
    }
    unique(
      v["rebuilt_tables"],
      `${at}.rebuilt_tables`,
      issues,
      (x) => id("table", x),
      "a table ID",
    );
  },
  SwitchedTable(v, at, issues) {
    if (!keys(v, at, ["rows", "checksum"], [], issues)) return;
    check(int(v["rows"]), at, "rows", issues);
    check(str(v["checksum"]) && isHash(v["checksum"]), at, "checksum", issues);
  },
  BackfillRows(v, at, issues) {
    if (!Array.isArray(v)) {
      issues.push(`${at}: not an array`);
      return;
    }
    check(v.length >= 1 && v.length <= 10000, at, "1 to 10,000 rows", issues);
    v.forEach((x, i) => {
      check(id("row", x), `${at}[${i}]`, "a row ID", issues);
      const prev = v[i - 1];
      if (i > 0) check(str(prev) && str(x) && prev < x, `${at}[${i}]`, "ascending", issues);
    });
  },
  BackfillSegment(v, at, issues) {
    if (!keys(v, at, ["entity", "valid", "deps"], [], issues)) return;
    check(id("entity", v["entity"]), at, "entity", issues);
    interval(v["valid"], `${at}.valid`, issues);
    deps(v["deps"], `${at}.deps`, issues);
  },
  MigrationFailedTarget(v, at, issues) {
    if (!keys(v, at, ["migration_id", "reason"], [], issues)) return;
    check(id("migration", v["migration_id"]), at, "migration_id", issues);
    check(oneOf(MIGRATION_FAILURE_REASONS, v["reason"]), at, "reason", issues);
  },
};

// --- rules between the blocks of one event -------------------------------------------------------

export const SCHEMA_EVENT_RULES: Readonly<Record<string, EventRule>> = {
  // §5.1: at most one of `request_key` and `idempotency`.
  "schema.draft_submitted"(paths, _, issues) {
    check(
      !(paths.has("request_key") && paths.has("idempotency")),
      "event",
      "request_key and idempotency",
      issues,
    );
  },
  // §5.5: the definition is of the target version; the outcome is `applied` exactly when every
  // change is `auto`.
  "schema.compiled"(_, blocks, issues) {
    const t = blocks["target"];
    const c = blocks["compiled"];
    const ch = blocks["changes"];
    if (isObject(t) && isObject(c)) {
      check(t["target_version"] === c["sv"], "compiled", "sv is the target version", issues);
    }
    if (isObject(t) && Array.isArray(ch) && ch.every(isObject)) {
      const all = ch.every((x) => x["auto"] === true);
      check(t["outcome"] === (all ? "applied" : "pending"), "target", "outcome", issues);
    }
  },
  // §5.5: a `tables/<table>` block for each rebuilt table and only those; rebuilding and
  // backfilling happen in a migration.
  "schema.switched"(paths, blocks, issues) {
    const t = blocks["target"];
    const rebuilt = new Set(
      isObject(t) && Array.isArray(t["rebuilt_tables"]) ? t["rebuilt_tables"] : [],
    );
    const migrated = isObject(t) && "migration_id" in t;
    check(migrated || rebuilt.size === 0, "target", "rebuilt_tables without a migration", issues);
    for (const p of paths) {
      const m = /^tables\/([^/]+)$/.exec(p);
      if (m !== null) check(rebuilt.has(m[1]), p, "not a rebuilt table", issues);
    }
    for (const r of rebuilt) {
      if (str(r)) check(paths.has(`tables/${r}`), "event", `tables/${r} missing`, issues);
    }
  },
};
