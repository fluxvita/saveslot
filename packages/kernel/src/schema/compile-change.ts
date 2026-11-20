// Compiling a draft that changes an existing slot (docs/zh-CN/spec/03-data-model/07-schema-evolution.md
// «schema 文档格式» 提交粒度 / 字段匹配规则, «改动分类与迁移手段»; 04-contract «schema_draft»;
// 09-event-format.md §5.5, §7).
//
// Pure: the current version's compiled definition, the other slots' names, the next free table and
// rule numbers, the policy's automatic classes and what nobody else uses come from the caller. The
// result is the definition of the next version and its changes, or an error; nothing is logged here.
//
// What this compiles: the changes that touch the catalog only — they build no physical table, so a
// switch only moves the pointer: `rename_slot`, `rename_table`, `rename_field`, `change_description`,
// `change_aliases`, `change_duplicate_keys`, `change_together`, `loosen_constraint`, `drop_table`,
// and a new base table (`add_table`). Any other difference between the draft and the current
// version is `not_implemented` with the change's code as `what`: it is classified by what it is,
// never taken for a change that needs nothing. Not here either: a derived table in the draft, a
// `migrate` or `backfill`, a field to add or drop, a time zone change.
//
// Errors, in this order so the most telling one wins: a key v1 does not support, something not
// compiled yet that the draft's form already shows (a derived table, `migrate`, `backfill`), the
// document's form, `base_version` not the current one, a field of the current version neither
// matched nor dropped, the compilation rules (every finding, document order; the rules of a table
// the draft does not list are not checked again), then what is not compiled yet in the differences.
//
// The draft lists the tables it changes or creates, each whole; a table it does not list is
// untouched. Tables and fields are matched by `id`, else by name without ASCII case; a field not
// matched and not in `drop_fields` is an error, never a deletion. The compilation rules are checked
// on the slot as it would be after the change: the listed tables as written, the others as the
// current version has them.

import type {
  ChangeClass,
  ChangesBlock,
  ChangeTarget,
  CompiledBaseField,
  CompiledBaseTable,
  CompiledDerivedTable,
  CompiledSchema,
  CompiledTable,
  FieldId,
  SchemaChangeCode,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { SCHEMA_CHANGE_CODES } from "@fluxvita/saveslot-contract-core";
import { compiledWarnings, compileTable, type Ids } from "./compile.ts";
import { isObject, readDocument, unsupportedKey } from "./document.ts";
import { derivedTableDocument } from "./document-of.ts";
import type {
  ChangeError,
  CompileChangeInput,
  CompileChangeResult,
  CompileError,
  CompileWarning,
  DocDerivedTable,
  DocField,
  DocSlot,
  DocTable,
  SchemaDetail,
} from "./model.ts";
import { defaultScale, unitOf } from "./units.ts";
import { compareDecimal, fold, validate } from "./validate.ts";

type Obj = Record<string, unknown>;

const TABLE_ID = /^t[1-9][0-9]{0,8}$/;
const FIELD_ID = /^f[1-9][0-9]{0,8}$/;
/** Paths under this prefix are tables the draft does not list: their findings are not reported. */
const UNLISTED = "unlisted";

// --- the keys only a change has -------------------------------------------------------------------

/** What a draft says besides the tables and fields as the compiler of a new slot reads them. */
interface Extras {
  readonly baseVersion: number;
  readonly renameTo?: string;
  readonly dropTables: readonly string[];
  readonly tables: readonly {
    readonly id?: string;
    readonly dropFields: readonly string[];
    readonly fieldIds: readonly (string | undefined)[];
  }[];
}

const malformed = (param: string): CompileError => ({
  code: "invalid_argument",
  reason: "malformed",
  param,
});

function strings(v: unknown, at: string): string[] | CompileError {
  if (!Array.isArray(v)) return malformed(at);
  const out: string[] = [];
  for (const [i, x] of v.entries()) {
    if (typeof x !== "string" || !x.isWellFormed()) return malformed(`${at}/${i}`);
    out.push(x);
  }
  return out;
}

/**
 * Takes the keys only a change has out of a copy of the document, so that what is left reads as
 * the document of a new slot (./document.ts), and returns them. Looks only where the containers
 * have the right type: the form of the rest is `readDocument`'s to report.
 */
/**
 * Whether a derived table the draft lists is the one the slot has, unchanged: as the catalog's
 * document gives it (./document-of.ts), its rule's text the very text it was written with. The
 * rule is not resolved again by names (a field it reads may have been renamed since): text equal is
 * rule unchanged, and its binding by IDs stands. Keys the catalog fills in may be left out; a key
 * given must say what the catalog says.
 */
function sameDerived(
  t: Obj,
  c: CompiledDerivedTable,
  all: CompiledSchema,
  text: string | undefined,
): boolean {
  if (text === undefined) return false;
  let want: Obj;
  try {
    want = derivedTableDocument(c, all.tables, text);
  } catch {
    return false;
  }
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const aliases = (o: Obj) =>
    Array.isArray(o["aliases"])
      ? o["aliases"].map((a) => (typeof a === "string" ? a.normalize("NFC") : a))
      : [];
  for (const k of Object.keys(t))
    if (!["id", "name", "kind", "description", "aliases", "rule", "fields"].includes(k))
      return false;
  if ("id" in t && t["id"] !== want["id"]) return false;
  if (t["name"] !== want["name"] || t["description"] !== want["description"]) return false;
  if (!eq(aliases(t), aliases(want))) return false;
  const r = t["rule"];
  const wr = want["rule"] as Obj;
  if (!isObject(r) || r["sql"] !== wr["sql"] || r["time_dependency"] !== wr["time_dependency"])
    return false;
  for (const [k, v] of Object.entries(r)) if (!(k in wr) || !eq(v, wr[k])) return false;
  const fields = t["fields"];
  const wf = want["fields"] as Obj[];
  if (!Array.isArray(fields) || fields.length !== wf.length) return false;
  return fields.every((f, i) => {
    const w = wf[i] as Obj;
    if (!isObject(f) || f["name"] !== w["name"] || f["description"] !== w["description"])
      return false;
    if (!eq(aliases(f), aliases(w))) return false;
    return Object.entries(f).every(([k, v]) => k === "aliases" || (k in w && eq(v, w[k])));
  });
}

function extract(
  doc: Obj,
  current: CompiledSchema,
  ruleTexts: ReadonlyMap<string, string>,
): { rest: Obj; extras: Extras } | CompileError {
  const rest = structuredClone(doc);
  const bv = doc["base_version"];
  if (!("base_version" in doc))
    return { code: "invalid_argument", reason: "missing", param: "base_version" };
  if (typeof bv !== "number" || !Number.isSafeInteger(bv) || bv < 1)
    return malformed("base_version");
  rest["base_version"] = null;

  let renameTo: string | undefined;
  if ("rename_to" in rest) {
    const v = rest["rename_to"];
    if (typeof v !== "string" || !v.isWellFormed()) return malformed("rename_to");
    renameTo = v;
    delete rest["rename_to"];
  }
  let dropTables: string[] = [];
  if ("drop_tables" in rest) {
    const v = strings(rest["drop_tables"], "drop_tables");
    if (!Array.isArray(v)) return v;
    dropTables = v;
    delete rest["drop_tables"];
  }
  if (!("tables" in rest)) rest["tables"] = [];

  const tables: { id?: string; dropFields: string[]; fieldIds: (string | undefined)[] }[] = [];
  const list = rest["tables"];
  if (Array.isArray(list)) {
    for (const [i, t] of list.entries()) {
      const at = `tables/${i}`;
      if (!isObject(t)) {
        tables.push({ dropFields: [], fieldIds: [] });
        continue;
      }
      // A derived table in a change: its rule, fields and inferred keys are compiled by a later
      // version of this compiler. A new one is `add_derived_table`; a base table written as derived
      // is `change_table_kind`.
      if (t["kind"] === "derived") {
        // By ID, else by name among the tables no ID of the draft claims (as base tables match).
        const claimed = new Set(
          // From the document as given: the IDs are taken out of the copy as it is read.
          (Array.isArray(doc["tables"]) ? doc["tables"] : []).flatMap((x) =>
            isObject(x) && typeof x["id"] === "string" ? [x["id"]] : [],
          ),
        );
        const byName = (c: CompiledTable) =>
          typeof t["name"] === "string" && fold(c.name) === fold(t["name"]);
        const was = current.tables.find((c) =>
          typeof t["id"] === "string" ? c.id === t["id"] : byName(c) && !claimed.has(c.id),
        );
        // A new table named what another of this draft is renamed away from (by its ID).
        if (
          typeof t["id"] !== "string" &&
          current.tables.some((c) => byName(c) && claimed.has(c.id))
        )
          return {
            code: "validation_failed",
            details: [{ path: `${at}/name`, code: "name_renamed_away" }],
          };
        // Unchanged, as the catalog gives it: as if not listed. A stand-in of the document's form
        // keeps the positions of the tables after it.
        if (was?.kind === "derived" && sameDerived(t, was, current, ruleTexts.get(was.id))) {
          list[i] = {
            name: was.name,
            kind: "derived",
            description: was.description,
            rule: { sql: ruleTexts.get(was.id), time_dependency: was.rule.time_dependency },
            fields: was.fields.map((f) => ({ name: f.name, description: f.description })),
          };
          tables.push({ dropFields: [], fieldIds: [] });
          continue;
        }
        const what =
          was === undefined
            ? "add_derived_table"
            : was.kind === "base"
              ? "change_table_kind"
              : "a change to a derived table";
        return { code: "not_implemented", what, param: at };
      }
      const extra: { id?: string; dropFields: string[]; fieldIds: (string | undefined)[] } = {
        dropFields: [],
        fieldIds: [],
      };
      if ("id" in t) {
        if (typeof t["id"] !== "string" || !TABLE_ID.test(t["id"])) return malformed(`${at}/id`);
        extra.id = t["id"];
        delete t["id"];
      }
      if ("drop_fields" in t) {
        const v = strings(t["drop_fields"], `${at}/drop_fields`);
        if (!Array.isArray(v)) return v;
        extra.dropFields = v;
        delete t["drop_fields"];
      }
      if (Array.isArray(t["fields"])) {
        for (const [j, f] of t["fields"].entries()) {
          if (!isObject(f)) {
            extra.fieldIds.push(undefined);
            continue;
          }
          for (const k of ["migrate", "backfill"]) {
            if (k in f)
              return {
                code: "not_implemented",
                what: `a ${k} in a change`,
                param: `${at}/fields/${j}/${k}`,
              };
          }
          if ("id" in f) {
            if (typeof f["id"] !== "string" || !FIELD_ID.test(f["id"]))
              return malformed(`${at}/fields/${j}/id`);
            extra.fieldIds.push(f["id"]);
            delete f["id"];
          } else extra.fieldIds.push(undefined);
        }
      }
      tables.push(extra);
    }
  }
  return {
    rest,
    extras: {
      baseVersion: bv,
      ...(renameTo !== undefined ? { renameTo } : {}),
      dropTables,
      tables,
    },
  };
}

// --- the current version as a document ------------------------------------------------------------

const fieldNameOf = (t: CompiledTable, id: string): string =>
  t.fields.find((f) => f.id === id)?.name ?? id;

/** A base table of the current version as the document would write it, for the rules to check. */
function docTableOf(
  c: CompiledBaseTable,
  path: string,
  tableName: (id: string) => string,
): DocTable {
  const names = (ids: readonly string[]) => ids.map((id) => fieldNameOf(c, id));
  const out: { -readonly [K in keyof DocTable]: DocTable[K] } = {
    kind: "base",
    path,
    keys: new Set(),
    name: c.name,
    description: c.description,
    ...(c.aliases !== undefined ? { aliases: c.aliases } : {}),
    time:
      c.time.type === "event"
        ? { type: "event", field: fieldNameOf(c, c.time.field) }
        : c.time.type === "state"
          ? { type: "state", granularity: c.time.granularity }
          : { type: "none" },
    fields: c.fields.map((f, i): DocField => {
      const keys = new Set<string>(["name", "type", "description"]);
      const g = f as CompiledBaseField & {
        min?: string;
        max?: string;
        values?: readonly string[];
        unit?: { code: string };
        precision?: { scale: number; rounding: "half_up" | "half_even" };
        ref?: { table: string; target: "row" | "entity" };
      };
      for (const k of ["min", "max", "values", "unit", "ref"] as const)
        if (g[k] !== undefined) keys.add(k);
      if (g.precision !== undefined) {
        keys.add("scale");
        keys.add("rounding");
      }
      return {
        path: `${path}/fields/${i}`,
        name: f.name,
        type: f.type,
        description: f.description,
        ...(f.aliases !== undefined ? { aliases: f.aliases } : {}),
        required: f.required === true,
        keys,
        ...(g.min !== undefined ? { min: g.min } : {}),
        ...(g.max !== undefined ? { max: g.max } : {}),
        ...(g.values !== undefined ? { values: g.values } : {}),
        ...(g.unit !== undefined ? { unit: g.unit.code } : {}),
        ...(g.precision !== undefined
          ? { scale: g.precision.scale, rounding: g.precision.rounding }
          : {}),
        ...(g.ref !== undefined
          ? { ref: { table: tableName(g.ref.table), target: g.ref.target } }
          : {}),
      };
    }),
  };
  if (c.entity_key !== undefined) out.entity_key = names(c.entity_key);
  if (c.external_key !== undefined) out.external_key = names(c.external_key);
  if (c.together !== undefined) out.together = c.together.map(names);
  if (c.duplicate_keys !== undefined) out.duplicate_keys = c.duplicate_keys.map(names);
  return out;
}

function docDerivedOf(
  c: Extract<CompiledTable, { kind: "derived" }>,
  path: string,
): DocDerivedTable {
  return {
    kind: "derived",
    path,
    keys: new Set(),
    name: c.name,
    description: c.description,
    ...(c.aliases !== undefined ? { aliases: c.aliases } : {}),
    rule: { sql: c.rule.sql, time_dependency: c.rule.time_dependency },
    fields: c.fields.map((f, i) => ({
      path: `${path}/fields/${i}`,
      name: f.name,
      description: f.description,
      ...(f.aliases !== undefined ? { aliases: f.aliases } : {}),
      keys: new Set<string>(),
    })),
  };
}

// --- matching -------------------------------------------------------------------------------------

interface TableMatch {
  /** The table as the draft writes it. */
  readonly doc: DocTable;
  readonly extra: Extras["tables"][number];
  /** The current table it is, or undefined for a new one. */
  readonly current: CompiledBaseTable | undefined;
  /** By position in `doc.fields`: the current field, or undefined for a field to add. */
  readonly fields: readonly (CompiledBaseField | undefined)[];
}

/** Groups of field IDs as sets: neither the order of the groups nor of the fields in one counts. */
const groupsKey = (g: readonly (readonly string[])[] | undefined): string =>
  JSON.stringify((g ?? []).map((x) => [...x].sort()).sort());

const aliasesOf = (a: readonly string[] | undefined): readonly string[] => a ?? [];

const same = <T>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export function compileChange(input: CompileChangeInput): CompileChangeResult {
  const { document, current, existingSlotNames, nextTableNumber } = input;
  if (!Number.isSafeInteger(nextTableNumber) || nextTableNumber < 1)
    throw new Error(`not a table number: ${nextTableNumber}`);
  const fail = (error: ChangeError): CompileChangeResult => ({ ok: false, error });
  if (!isObject(document)) return fail(malformed(""));
  // A draft written on another version is told so first, whatever else is wrong with it: the
  // caller redrafts on the current version before anything else counts. Its form is checked below.
  const bv = document["base_version"];
  if (typeof bv === "number" && Number.isSafeInteger(bv) && bv >= 1 && bv !== current.sv)
    return fail({ code: "draft_outdated", reason: "base_version", current_sv: current.sv });
  const stop = unsupportedKey(document);
  if (stop !== undefined) return fail(stop);
  const taken = extract(document, current, input.ruleTexts ?? new Map());
  if ("code" in taken) return fail(taken);
  const { rest, extras } = taken;
  const read = readDocument(rest);
  if ("code" in read) return fail(read);
  const doc = read;
  // The caller picks the definition by the draft's slot: another slot's is its mistake, not the
  // draft's.
  if (fold(doc.slot) !== fold(current.name)) {
    throw new Error(`a draft of ${doc.slot} compiled against the definition of ${current.name}`);
  }

  const currentById = new Map<string, CompiledTable>(current.tables.map((t) => [t.id, t]));
  const currentByName = new Map<string, CompiledTable>(
    current.tables.map((t) => [fold(t.name), t]),
  );

  // Matching tables, then fields. Findings that are the draft's own mistake come with the rules'.
  const findings: SchemaDetail[] = [];
  const matches: TableMatch[] = [];
  const matchedTables = new Set<string>();
  // By ID first, then by name among what no ID claimed (07 «字段匹配规则»): a draft that renames A
  // to B and adds a new A keeps the two apart, and is refused below for reusing the old name.
  const claimedTables = new Set(
    doc.tables.flatMap((_, i) => {
      const id = extras.tables[i]?.id;
      return id !== undefined ? [id] : [];
    }),
  );
  for (const [i, t] of doc.tables.entries()) {
    if (t.kind !== "base") continue; // a derived table was refused while extracting
    const extra = extras.tables[i] as Extras["tables"][number];
    let c: CompiledTable | undefined;
    if (extra.id !== undefined) {
      c = currentById.get(extra.id);
      if (c === undefined) return fail(malformed(`${t.path}/id`));
    } else {
      c = currentByName.get(fold(t.name));
      if (c !== undefined && claimedTables.has(c.id)) c = undefined;
    }
    if (c !== undefined && c.kind !== "base") {
      return fail({ code: "not_in_this_version", param: `${t.path}/kind` });
    }
    if (c !== undefined) {
      if (matchedTables.has(c.id))
        findings.push({ path: `${t.path}/name`, code: "duplicate_name" });
      matchedTables.add(c.id);
    }
    const fields: (CompiledBaseField | undefined)[] = [];
    const used = new Set<string>();
    if (c !== undefined) {
      const claimed = new Set(extra.fieldIds.filter((x): x is string => x !== undefined));
      for (const [j, f] of t.fields.entries()) {
        const id = extra.fieldIds[j];
        let cf: CompiledBaseField | undefined;
        if (id !== undefined) {
          cf = c.fields.find((x) => x.id === id);
          if (cf === undefined) return fail(malformed(`${t.path}/fields/${j}/id`));
        } else {
          cf = c.fields.find((x) => fold(x.name) === fold(f.name));
          if (cf !== undefined && claimed.has(cf.id)) cf = undefined;
        }
        if (cf !== undefined) {
          if (used.has(cf.id)) findings.push({ path: `${f.path}/name`, code: "duplicate_name" });
          used.add(cf.id);
        }
        fields.push(cf);
      }
    }
    matches.push({ doc: t, extra, current: c, fields });
  }
  // A new table or field named what another of this draft is renamed away from: which one the
  // name means is not guessed.
  const renamedAway = new Set(
    matches.flatMap((m) =>
      m.current !== undefined && fold(m.current.name) !== fold(m.doc.name)
        ? [fold(m.current.name)]
        : [],
    ),
  );
  for (const m of matches) {
    if (m.current === undefined) {
      if (renamedAway.has(fold(m.doc.name)))
        findings.push({ path: `${m.doc.path}/name`, code: "name_renamed_away" });
      continue;
    }
    const away = new Set(
      m.fields.flatMap((cf, j) =>
        cf !== undefined && fold(cf.name) !== fold(m.doc.fields[j]?.name ?? "")
          ? [fold(cf.name)]
          : [],
      ),
    );
    m.doc.fields.forEach((f, j) => {
      if (m.fields[j] === undefined && away.has(fold(f.name)))
        findings.push({ path: `${f.path}/name`, code: "name_renamed_away" });
    });
  }

  // `drop_tables` and `drop_fields` name what they drop, by name or ID.
  const dropped = new Set<string>();
  // A string that is one table's name and another's ID names the table by that name.
  const tableNamed = (n: string) =>
    currentByName.get(fold(n)) ?? (TABLE_ID.test(n) ? currentById.get(n) : undefined);
  for (const [i, n] of extras.dropTables.entries()) {
    const c = tableNamed(n);
    if (c === undefined) findings.push({ path: `drop_tables/${i}`, code: "unknown_reference" });
    else if (matchedTables.has(c.id) || dropped.has(c.id))
      findings.push({ path: `drop_tables/${i}`, code: "duplicate_entry" });
    else dropped.add(c.id);
  }
  const droppedFields = new Map<string, Set<string>>();
  for (const m of matches) {
    const set = new Set<string>();
    droppedFields.set(m.doc.path, set);
    if (m.current === undefined) continue;
    const cur = m.current;
    for (const [k, n] of m.extra.dropFields.entries()) {
      const cf =
        cur.fields.find((x) => fold(x.name) === fold(n)) ??
        (FIELD_ID.test(n) ? cur.fields.find((x) => x.id === n) : undefined);
      const at = `${m.doc.path}/drop_fields/${k}`;
      if (cf === undefined) findings.push({ path: at, code: "unknown_reference" });
      else if (m.fields.includes(cf) || set.has(cf.id))
        findings.push({ path: at, code: "duplicate_entry" });
      else set.add(cf.id);
    }
  }

  const unmatched = matches.flatMap((m) =>
    m.current === undefined
      ? []
      : m.current.fields
          .filter((f) => !m.fields.includes(f) && !droppedFields.get(m.doc.path)?.has(f.id))
          .map((f) => ({ table: m.current?.name as string, id: f.id, name: f.name })),
  );
  if (unmatched.length > 0) return fail({ code: "field_unmatched", fields: unmatched });

  // The slot as it would be after the change, for the compilation rules.
  const finalName = new Map<string, string>(current.tables.map((t) => [t.id, t.name]));
  for (const m of matches) if (m.current !== undefined) finalName.set(m.current.id, m.doc.name);
  const idByFinalName = new Map<string, string>(
    [...finalName].filter(([id]) => !dropped.has(id)).map(([id, n]) => [fold(n), id]),
  );
  const bySub = new Map(
    matches.flatMap((m) => (m.current !== undefined ? [[m.current.id, m] as const] : [])),
  );
  const merged: DocSlot = {
    slot: extras.renameTo ?? doc.slot,
    timezone: doc.timezone,
    tables: [
      ...current.tables.flatMap((t, k): (DocTable | DocDerivedTable)[] => {
        if (dropped.has(t.id)) return [];
        const m = bySub.get(t.id);
        if (m !== undefined) return [m.doc];
        const path = `${UNLISTED}/${k}`;
        return [
          t.kind === "base"
            ? docTableOf(t, path, (id) => finalName.get(id) ?? id)
            : docDerivedOf(t, path),
        ];
      }),
      ...matches.filter((m) => m.current === undefined).map((m) => m.doc),
    ],
  };
  const others = existingSlotNames.filter((n) => fold(n) !== fold(current.name));

  // The table a reference written in the draft names, by the names after the change: the ID of a
  // kept table, `dropped:<ID>` for a table dropped and not renamed into, undefined for none or for
  // another slot's (another slot's are not this slot's dependents).
  const refTarget = (r: { readonly table: string }): string | undefined => {
    const dot = r.table.indexOf(".");
    if (dot >= 0 && fold(r.table.slice(0, dot)) !== fold(doc.slot)) return undefined;
    const name = fold(dot >= 0 ? r.table.slice(dot + 1) : r.table);
    const kept = idByFinalName.get(name);
    if (kept !== undefined) return kept;
    const gone = current.tables.find((t) => dropped.has(t.id) && fold(t.name) === name);
    return gone === undefined ? undefined : `dropped:${gone.id}`;
  };
  const toDropped = (r: { readonly table: string }) =>
    refTarget(r)?.startsWith("dropped:") === true;
  const refToDropped = new Set(
    matches.flatMap((m) =>
      m.doc.fields.flatMap((f) =>
        f.ref !== undefined && toDropped(f.ref) ? [`${f.path}/ref/table`] : [],
      ),
    ),
  );
  findings.push(
    ...validate(merged, others).filter(
      (d) => d.path !== UNLISTED && !d.path.startsWith(`${UNLISTED}/`) && !refToDropped.has(d.path),
    ),
  );
  const reported = () => new Set(findings.map((d) => d.path));
  // Findings between two tables are reported on the later one, which may be a table the draft does
  // not list: a listed table whose name another table has, or another table's alias, is reported
  // on the listed one.
  const unlisted = merged.tables.filter((t) => t.path.startsWith(`${UNLISTED}/`));
  for (const m of matches) {
    const p = `${m.doc.path}/name`;
    const clash = unlisted.find(
      (u) =>
        fold(u.name) === fold(m.doc.name) ||
        (u.aliases ?? []).some((a) => fold(a) === fold(m.doc.name)),
    );
    if (clash !== undefined && !reported().has(p))
      findings.push({ path: p, code: "duplicate_name" });
  }
  // A name taken twice makes what a reference by that name means undefined: the findings it brings
  // on references (`ref/target`, `ref/table`) are not reported beside the duplicate.
  const twice = new Set(
    findings
      .filter((d) => d.code === "duplicate_name" && /^tables\/\d+\/name$/.test(d.path))
      .map((d) => fold(matches.find((m) => `${m.doc.path}/name` === d.path)?.doc.name ?? "")),
  );
  if (twice.size > 0) {
    const brought = new Set(
      matches.flatMap((m) =>
        m.doc.fields.flatMap((f) =>
          f.ref !== undefined && twice.has(fold(f.ref.table.slice(f.ref.table.indexOf(".") + 1)))
            ? [`${f.path}/ref/target`, `${f.path}/ref/table`]
            : [],
        ),
      ),
    );
    for (let k = findings.length - 1; k >= 0; k--)
      if (brought.has((findings[k] as SchemaDetail).path)) findings.splice(k, 1);
  }
  // An alias may not be a name that still resolves: the current names, those this draft renames
  // away included (07 «别名»).
  // The names of earlier versions the caller gives (the last 10) join in.
  const currentTableNames = new Set(
    [...current.tables.map((t) => t.name), ...input.formerNames.tables].map(fold),
  );
  const aliasRule = (
    aliases: readonly string[] | undefined,
    at: string,
    names: ReadonlySet<string>,
  ) =>
    (aliases ?? []).forEach((a, i) => {
      const p = `${at}/aliases/${i}`;
      if (!reported().has(p) && names.has(fold(a)))
        findings.push({ path: p, code: "alias_invalid", reason: "name" });
    });
  for (const m of matches) {
    aliasRule(m.doc.aliases, m.doc.path, currentTableNames);
    const fieldNames = new Set(
      [
        ...(m.current?.fields ?? []).map((f) => f.name),
        ...(m.current === undefined ? [] : (input.formerNames.fields.get(m.current.id) ?? [])),
      ].map(fold),
    );
    for (const f of m.doc.fields) aliasRule(f.aliases, f.path, fieldNames);
  }
  // A table to drop that something the change keeps still points at: judged on the slot as it
  // would be, so a dependent dropped or changed in the same draft does not count (04-contract
  // «schema_draft» still_referenced).
  for (const [i, n] of extras.dropTables.entries()) {
    const c = tableNamed(n);
    if (c === undefined || !dropped.has(c.id)) continue;
    const by: string[] = [];
    for (const r of current.tables) {
      if (dropped.has(r.id)) continue;
      const m = bySub.get(r.id);
      if (r.kind === "derived") {
        if (r.rule.depends_on.some((d) => d.table === c.id)) by.push(r.name);
        continue;
      }
      if (m !== undefined) {
        for (const f of m.doc.fields) {
          if (f.ref !== undefined && refTarget(f.ref) === `dropped:${c.id}`) by.push(f.path);
        }
        continue;
      }
      for (const f of r.fields) {
        const ref = (f as { ref?: { table: string } }).ref;
        if (ref !== undefined && ref.table === c.id) by.push(`${r.name}.${f.name}`);
      }
    }
    if (by.length > 0)
      findings.push({ path: `drop_tables/${i}`, code: "still_referenced", referenced_by: by });
  }
  if (findings.length > 0) return fail({ code: "validation_failed", details: findings });

  // From here the draft is a draft of this slot: what differs is classified.
  const changes: ChangesBlock[number][] = [];
  const policy = new Set(input.autoApply);
  const record = (
    target: ChangeTarget,
    change: SchemaChangeCode,
    cls: ChangeClass,
    o: { compatible: boolean; destructive?: boolean; autoClass?: string; auto?: boolean },
  ): void => {
    changes.push({
      target,
      change,
      class: cls,
      compatible_with_old_writes: o.compatible,
      destructive: o.destructive ?? false,
      auto: o.auto ?? (o.autoClass !== undefined && policy.has(o.autoClass)),
    });
  };
  const notYet = (what: string, param: string): CompileChangeResult =>
    fail({ code: "not_implemented", what, param });

  if (extras.renameTo !== undefined && extras.renameTo !== current.name) {
    record({ slot: true }, "rename_slot", "metadata", { compatible: true });
  }
  if (doc.timezone !== current.timezone) return notYet("change_timezone", "timezone");

  const patched = new Map<string, CompiledBaseTable>();
  for (const m of matches) {
    if (m.current === undefined) continue;
    const c = m.current;
    const s = m.doc;
    const tid = { table: c.id as TableId };
    const set: Record<string, unknown> = {};
    const idOf = new Map<string, FieldId>();
    s.fields.forEach((f, j) => {
      const cf = m.fields[j];
      if (cf !== undefined) idOf.set(fold(f.name), cf.id);
    });
    const ids = (names: readonly string[]): (string | undefined)[] =>
      names.map((n) => idOf.get(fold(n)));

    // Table level. What shapes the physical table or the keys is not compiled yet.
    if (m.extra.dropFields.length > 0 || droppedFields.get(s.path)?.size) {
      return notYet("drop_field", `${s.path}/drop_fields`);
    }
    for (const [j, cf] of m.fields.entries()) {
      if (cf === undefined) {
        const f = s.fields[j] as DocField;
        return notYet(f.required ? "add_required_field" : "add_optional_field", f.path);
      }
    }
    if (s.time.type !== c.time.type) return notYet("change_time_type", `${s.path}/time`);
    if (s.time.type === "event" && c.time.type === "event") {
      if (idOf.get(fold(s.time.field)) !== c.time.field)
        return notYet("change_time_field", `${s.path}/time/field`);
    }
    if (
      s.time.type === "state" &&
      c.time.type === "state" &&
      s.time.granularity !== c.time.granularity
    )
      return notYet("change_granularity", `${s.path}/time/granularity`);
    const keyIds = (names: readonly string[] | undefined) =>
      names === undefined ? undefined : ids(names);
    const sameKey = (
      a: readonly (string | undefined)[] | undefined,
      b: readonly string[] | undefined,
    ) => (a === undefined || b === undefined ? a === b : same(a, b));
    if (!sameKey(keyIds(s.entity_key), c.entity_key))
      return notYet("change_entity_key", `${s.path}/entity_key`);
    if (!sameKey(keyIds(s.external_key), c.external_key)) {
      return notYet(
        c.external_key === undefined
          ? "add_external_key"
          : s.external_key === undefined
            ? "drop_external_key"
            : "change_external_key",
        `${s.path}/external_key`,
      );
    }

    if (s.name !== c.name) {
      set["name"] = s.name;
      record(tid, "rename_table", "metadata", {
        compatible: true,
        auto: policy.has("rename_unused") && input.unused(tid),
      });
    }
    if (s.description !== c.description) {
      set["description"] = s.description;
      record(tid, "change_description", "metadata", { compatible: true, autoClass: "description" });
    }
    if (!same(aliasesOf(s.aliases), aliasesOf(c.aliases))) {
      set["aliases"] = aliasesOf(s.aliases).length > 0 ? [...aliasesOf(s.aliases)] : undefined;
      record(tid, "change_aliases", "metadata", { compatible: true, autoClass: "description" });
    }
    const dup = (s.duplicate_keys ?? []).map((g) => ids(g));
    if (
      dup.some((g) => g.includes(undefined)) ||
      groupsKey(dup as string[][]) !== groupsKey(c.duplicate_keys)
    ) {
      set["duplicate_keys"] = dup;
      record(tid, "change_duplicate_keys", "metadata", {
        compatible: true,
        autoClass: "duplicate_keys",
      });
    }
    const tog = (s.together ?? []).map((g) => ids(g));
    if (
      tog.some((g) => g.includes(undefined)) ||
      groupsKey(tog as string[][]) !== groupsKey(c.together)
    ) {
      set["together"] = tog;
      record(tid, "change_together", "metadata", { compatible: true });
    }

    // Fields: renames, text, and constraints only loosened.
    const fields = c.fields.map((cf) => {
      const j = m.fields.indexOf(cf);
      const f = s.fields[j] as DocField;
      const target = { ...tid, field: cf.id };
      const patch: Record<string, unknown> = {};
      const g = cf as CompiledBaseField & {
        min?: string;
        max?: string;
        values?: readonly string[];
        unit?: { code: string; dimension: string };
        precision?: { scale: number; rounding: "half_up" | "half_even" };
        ref?: { table: string; target: "row" | "entity" };
      };
      if (f.type !== cf.type)
        return {
          notYet: [
            f.type === "ref" || cf.type === "ref" ? "change_ref" : "change_type",
            f.path,
          ] as const,
        };
      if (f.type === "quantity") {
        const u = unitOf(f.unit as string);
        if (u !== undefined && u.code !== g.unit?.code) {
          return {
            notYet: [
              u.dimension === g.unit?.dimension ? "change_unit" : "change_dimension",
              `${f.path}/unit`,
            ] as const,
          };
        }
      }
      if (f.type === "ref") {
        const to = f.ref === undefined ? undefined : refId(f.ref.table, idByFinalName, doc.slot);
        if (to !== g.ref?.table || f.ref?.target !== g.ref?.target)
          return { notYet: ["change_ref", `${f.path}/ref`] as const };
      }
      let loosened = false;
      if (f.type === "decimal" || f.type === "quantity") {
        const unit = f.type === "quantity" ? unitOf(f.unit as string) : undefined;
        const scale = f.scale ?? (unit !== undefined ? defaultScale(unit) : 6);
        const rounding = f.rounding ?? "half_up";
        const was = g.precision as { scale: number; rounding: "half_up" | "half_even" };
        if (rounding !== was.rounding || scale < was.scale)
          return { notYet: ["change_precision", f.path] as const };
        if (scale > was.scale) {
          patch["precision"] = { ...was, scale };
          loosened = true;
        }
      }
      if (f.type === "integer" || f.type === "decimal" || f.type === "quantity") {
        let tightened = false;
        for (const k of ["min", "max"] as const) {
          const now = f[k];
          const before = g[k];
          if (now === before) continue;
          // An absent bound is no bound: dropping one loosens, adding one tightens.
          const looser =
            now === undefined ||
            (before !== undefined &&
              (k === "min" ? compareDecimal(now, before) < 0 : compareDecimal(now, before) > 0));
          if (looser) {
            patch[k] = now;
            loosened = true;
          } else tightened = true;
        }
        if (tightened) return { notYet: ["tighten_constraint", f.path] as const };
      }
      if (f.type === "enum") {
        const now = f.values as readonly string[];
        const before = g.values as readonly string[];
        // Added values loosen; a reordering alone takes nothing away and changes no value's meaning,
        // so it is the same kind of change (automatic, old writes accepted, no rebuild).
        if (!same(now, before)) {
          if (!before.every((v) => now.includes(v)))
            return { notYet: ["tighten_constraint", `${f.path}/values`] as const };
          patch["values"] = [...now];
          loosened = true;
        }
      }
      if (f.required !== (cf.required === true)) {
        if (f.required) return { notYet: ["tighten_constraint", `${f.path}/required`] as const };
        patch["required"] = undefined;
        loosened = true;
      }
      return { f, cf, target, patch, loosened };
    });
    const out: CompiledBaseField[] = [];
    for (const x of fields) {
      if ("notYet" in x) return notYet(x.notYet[0], x.notYet[1]);
      const { f, cf, target, patch, loosened } = x;
      const next: Record<string, unknown> = { ...cf };
      if (f.name !== cf.name) {
        next["name"] = f.name;
        record(target, "rename_field", "metadata", {
          compatible: true,
          auto: policy.has("rename_unused") && input.unused(target),
        });
      }
      if (f.description !== cf.description) {
        next["description"] = f.description;
        record(target, "change_description", "metadata", {
          compatible: true,
          autoClass: "description",
        });
      }
      if (!same(aliasesOf(f.aliases), aliasesOf(cf.aliases))) {
        if (aliasesOf(f.aliases).length > 0) next["aliases"] = [...aliasesOf(f.aliases)];
        else delete next["aliases"];
        record(target, "change_aliases", "metadata", {
          compatible: true,
          autoClass: "description",
        });
      }
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete next[k];
        else next[k] = v;
      }
      if (loosened) {
        record(target, "loosen_constraint", "metadata", {
          compatible: true,
          autoClass: "loosen_constraint",
        });
      }
      out.push(next as unknown as CompiledBaseField);
    }
    const next: Record<string, unknown> = { ...c, ...set, fields: out };
    if (next["aliases"] === undefined) delete next["aliases"];
    if (
      "duplicate_keys" in set &&
      (set["duplicate_keys"] as unknown[]).length === 0 &&
      s.duplicate_keys === undefined
    )
      delete next["duplicate_keys"];
    if ("together" in set && s.together === undefined) delete next["together"];
    patched.set(c.id, next as unknown as CompiledBaseTable);
  }

  for (const t of current.tables) {
    if (!dropped.has(t.id)) continue;
    // A derived table has no values of its own to lose, nor writes (07 «改动分类» 派生表的删表).
    const derived = t.kind === "derived";
    record({ table: t.id }, "drop_table", "metadata", {
      compatible: derived,
      destructive: !derived,
    });
  }

  // New base tables: numbered from the tenant's next free number, built in the next version.
  const sv = input.targetVersion;
  if (!Number.isSafeInteger(sv) || sv <= current.sv) throw new Error(`not a next version: ${sv}`);
  const fresh = matches.filter((m) => m.current === undefined);
  if (nextTableNumber + fresh.length - 1 > 999_999_999) throw new Error("table IDs exhausted");
  const tableIds = new Map<DocTable | DocDerivedTable, TableId>();
  for (const m of matches) if (m.current !== undefined) tableIds.set(m.doc, m.current.id);
  for (const [i, m] of fresh.entries()) tableIds.set(m.doc, `t${nextTableNumber + i}`);
  for (const t of merged.tables) {
    if (tableIds.has(t)) continue;
    // A table the draft does not list, as a document: its ID, for a new table's `ref`.
    const c = currentByName.get(fold(t.name));
    if (c !== undefined) tableIds.set(t, c.id);
  }
  const fieldIds = new Map<DocTable, Map<string, FieldId>>(
    fresh.map((m) => [
      m.doc,
      new Map(m.doc.fields.map((f, i): [string, FieldId] => [fold(f.name), `f${i + 1}`])),
    ]),
  );
  const ids: Ids = {
    table: tableIds,
    field: (t, name) => fieldIds.get(t)?.get(fold(name)) as FieldId,
  };
  const compiledFresh = fresh.map((m) => compileTable(m.doc, merged, ids, sv));
  for (const t of compiledFresh) {
    record({ table: t.id }, "add_table", "create", { compatible: true, autoClass: "add_table" });
  }

  // Kept tables keep their physical tables: `since` says which version built them, which an omitted
  // `since` no longer would (it means this version).
  const carry = <T extends CompiledTable>(t: T): T => ({
    ...t,
    physical: { table: t.physical.table, since: t.physical.since ?? current.sv },
  });
  const compiled: CompiledSchema = {
    ...current,
    name: extras.renameTo ?? current.name,
    sv,
    tables: [
      ...current.tables.flatMap((t): CompiledTable[] =>
        dropped.has(t.id) ? [] : [carry(patched.get(t.id) ?? t)],
      ),
      ...compiledFresh,
    ],
  };

  const pathOf = new Map(fresh.map((m) => [m.doc.name, `${m.doc.path}/external_key`] as const));
  const warnings: CompileWarning[] = compiledWarnings(compiled).flatMap((w) => {
    const path = pathOf.get(w.table);
    return path === undefined ? [] : [{ ...w, path }];
  });
  return {
    ok: true,
    compiled,
    changes: ordered(changes, current, dropped) as unknown as ChangesBlock,
    outcome: changes.every((c) => c.auto) ? "applied" : "pending",
    targetVersion: sv,
    warnings,
  };
}

const num = (id: string) => Number(id.slice(1));

/**
 * The changes in an order that does not depend on how the draft is written (09 §5.5 `changes`):
 * the slot's; then each current table by table ID, its own changes before its fields' by field
 * ID; then the dropped tables by ID; then the new tables by the ID they got. One target's changes
 * in the order of the change codes.
 */
function ordered(
  changes: readonly ChangesBlock[number][],
  current: CompiledSchema,
  dropped: ReadonlySet<string>,
): ChangesBlock[number][] {
  const kept = new Set(current.tables.map((t) => t.id));
  const key = (c: ChangesBlock[number]): number[] => {
    const code = SCHEMA_CHANGE_CODES.indexOf(c.change);
    if (!("table" in c.target)) return [0, code];
    const t = num(c.target.table);
    if (dropped.has(c.target.table)) return [2, t, code];
    if (!kept.has(c.target.table)) return [3, t, code];
    if ("field" in c.target) return [1, t, 1, num(c.target.field), code];
    return [1, t, 0, 0, code];
  };
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? -1) - (b[i] ?? -1);
      if (d !== 0) return d;
    }
    return 0;
  };
  return [...changes].sort((a, b) => cmp(key(a), key(b)));
}

/** The ID of the table a `ref.table` names (by name, or `slot.table`), or undefined. */
function refId(
  name: string,
  byName: ReadonlyMap<string, string>,
  slot: string,
): string | undefined {
  const dot = name.indexOf(".");
  const table = dot >= 0 && fold(name.slice(0, dot)) === fold(slot) ? name.slice(dot + 1) : name;
  return byName.get(fold(table));
}
