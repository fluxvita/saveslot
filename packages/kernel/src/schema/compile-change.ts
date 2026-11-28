// Compiling a draft that changes an existing slot (docs/zh-CN/spec/03-data-model/07-schema-evolution.md
// «schema 文档格式 · 提交粒度», «schema 文档格式 · 字段匹配规则», «改动分类与迁移手段»; 04-contract
// «schema_draft»; 09-event-format.md §5.5, §7).
//
// Pure: the current version's compiled definition, the other slots' names, the next free table and
// rule numbers, the policy's automatic classes and what nobody else uses come from the caller. The
// result is the definition of the next version and its changes, or an error; nothing is logged here.
//
// What this compiles: the changes that touch the catalog only — they build no physical table, so a
// switch only moves the pointer: `rename_slot`, `rename_table`, `rename_field`, `change_description`,
// `change_aliases`, `change_duplicate_keys`, `change_together`, `loosen_constraint`, `drop_table`,
// and a new base table (`add_table`). And the changes that rebuild a table into a physical table of
// the next version (`t_<id>_v<sv>`, 08 «物理做法»): fields added (`add_optional_field`,
// `add_required_field` with a constant `backfill`) and dropped (`drop_field`), a constraint tightened
// (`tighten_constraint`: a constant `backfill`, or else the field handed back as a check, counted on
// the table by the caller), precision (`change_precision`) and a unit of the same dimension
// (`change_unit`, no `migrate`). Bounds are compared as the new unit and precision have them; what a
// change of unit or precision would break on a bounded field is not counted in this version
// (`not_in_this_version`, `not_implemented`). A change of type or dimension compiles on a table
// never written only (07 «从未被写入的表上改结构»: the caller says which tables are), and so does a
// field made a `ref` or no longer one, or its target changed (`change_ref`, whether the table it
// points at was written or not): as metadata,
// with no `migrate`, the field compiled anew under its ID into a new physical table that the switch
// builds empty; on a table written it is `not_in_this_version` (`table_written`). A `migrate` and
// an expression `backfill` are `not_in_this_version` on any table. Any other difference between the
// draft and the current version is `not_implemented` with the change's code as `what`: it is
// classified by what it is, never taken for a change that needs nothing. A table's time type,
// granularity and entity key change on a table never written only, as metadata, the table built
// anew and empty whatever its physical shape; on a table written, `not_in_this_version`
// (`table_written`); with a derived rule reading the table, `not_in_this_version`
// (`not_implemented`: the rule would be compiled again). A table no longer a state table, or made
// one, that a table the draft does not list references is `still_referenced`. Not here either: a
// derived table in the draft, a time zone change, the time field. The external key: added,
// dropped or changed on a table never written as the structure is; on a table written, dropped
// touches the catalog only, added on a field it has is `external_key_existing_field`, added on a
// field the draft adds is not in this version yet (it builds the table from the log), changed is
// `table_written`.
//
// Errors, in this order so the most telling one wins: a key v1 does not support, something not
// compiled that the draft's form already shows (a derived table, `migrate`, an expression
// `backfill`), the
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
  CompiledUnit,
  FieldId,
  FieldValue,
  SchemaChangeCode,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { SCHEMA_CHANGE_CODES } from "@fluxvita/saveslot-contract-core";
import { convertValue, type NumberShape } from "../values/index.ts";
import { compiledWarnings, compileField, compileTable, type Ids } from "./compile.ts";
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
  TightenedCheck,
} from "./model.ts";
import { defaultScale, unitOf } from "./units.ts";
import { compareDecimal, fold, refTable, validate } from "./validate.ts";

/**
 * The IDs `compileField` takes, for a field compiled anew on a kept table: only a `ref` field reads
 * them, for the table it points at, which may be new in the draft and is filled in once every
 * table has its ID (`retargeted`).
 */
const NO_REF_IDS: Ids = {
  table: new Map(),
  field: () => {
    throw new Error("a field compiled anew reads no field IDs");
  },
};

type Obj = Record<string, unknown>;

/**
 * An old bound (canonical decimal text) as the field's new unit and precision have it; none when it
 * passes what a value can be once converted.
 */
function asNew(
  bound: string,
  shapes: { readonly from: NumberShape; readonly to: NumberShape },
): string | undefined {
  const r = convertValue(bound, shapes.from, shapes.to);
  return r.ok ? r.value : undefined;
}

/**
 * Where a table as the draft writes it uses a field by `name` that none of its fields has (a field it
 * drops): its time field, entity key, external key, field groups and duplicate keys, as positions.
 */
function keysNaming(t: DocTable, name: string): string[] {
  const n = fold(name);
  if (t.fields.some((f) => fold(f.name) === n)) return [];
  const out: string[] = [];
  if (t.time.type === "event" && fold(t.time.field) === n) out.push(`${t.path}/time/field`);
  const lists = [
    ["entity_key", t.entity_key],
    ["external_key", t.external_key],
  ] as const;
  for (const [key, xs] of lists)
    for (const [k, x] of (xs ?? []).entries()) if (fold(x) === n) out.push(`${t.path}/${key}/${k}`);
  const groups = [
    ["together", t.together],
    ["duplicate_keys", t.duplicate_keys],
  ] as const;
  for (const [key, gs] of groups)
    for (const [i, g] of (gs ?? []).entries())
      for (const [k, x] of g.entries()) if (fold(x) === n) out.push(`${t.path}/${key}/${i}/${k}`);
  return out;
}

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
    /** By field position: a constant `backfill` as written (`{"const": …}`), when given. */
    readonly backfills: readonly ({ readonly raw: unknown } | undefined)[];
  }[];
  /** `backfill_both_forms`: a `backfill` with its constant and its expression form both given. */
  readonly bothForms: readonly string[];
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

  const tables: Extras["tables"][number][] = [];
  const bothForms: string[] = [];
  const list = rest["tables"];
  if (Array.isArray(list)) {
    for (const [i, t] of list.entries()) {
      const at = `tables/${i}`;
      if (!isObject(t)) {
        tables.push({ dropFields: [], fieldIds: [], backfills: [] });
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
          tables.push({ dropFields: [], fieldIds: [], backfills: [] });
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
      const extra: {
        id?: string;
        dropFields: string[];
        fieldIds: (string | undefined)[];
        backfills: ({ raw: unknown } | undefined)[];
      } = { dropFields: [], fieldIds: [], backfills: [] };
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
            extra.backfills.push(undefined);
            continue;
          }
          // Conversion expressions (`migrate`, an expression `backfill`) come after the first
          // version, with the rebuild of a table they need (07 «确定性转换怎么重放»).
          if ("migrate" in f)
            return {
              code: "not_in_this_version",
              what: "migrate",
              param: `${at}/fields/${j}/migrate`,
            };
          // `backfill` (07 «收紧约束»): `{"const": <value>}` or `{"sql": …}`, one of the two.
          if ("backfill" in f) {
            const b = f["backfill"];
            const p = `${at}/fields/${j}/backfill`;
            if (!isObject(b) || Object.keys(b).some((k) => k !== "const" && k !== "sql"))
              return malformed(p);
            if ("const" in b && "sql" in b) bothForms.push(p);
            else if ("sql" in b)
              return {
                code: "not_in_this_version",
                what: "a backfill expression",
                param: `${p}/sql`,
              };
            else if (!("const" in b)) return malformed(p);
            extra.backfills.push({ raw: b["const"] });
            delete f["backfill"];
          } else extra.backfills.push(undefined);
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
      bothForms,
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
  /** Where the draft names each field it drops, by table ID and field ID. */
  const droppedAt = new Map<string, string>();
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
      else {
        set.add(cf.id);
        droppedAt.set(`${cur.id}/${cf.id}`, at);
      }
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
  // A table made a state table, or no longer one, that a table the draft does not list references
  // (07 «依赖方»): its `ref.target` (`entity` on a state table, `row` otherwise) no longer matches,
  // and an unlisted table's rules are not checked again above. A listed one is checked as the
  // draft writes it.
  for (const m of matches) {
    const c = m.current;
    if (c === undefined || c.kind !== "base") continue;
    const state = m.doc.time.type === "state";
    if ((c.time.type === "state") === state) continue;
    const by: string[] = [];
    for (const r of current.tables) {
      if (dropped.has(r.id) || r.kind !== "base" || bySub.has(r.id)) continue;
      for (const f of r.fields) {
        const ref = (f as { ref?: { table: string; target: "row" | "entity" } }).ref;
        if (ref !== undefined && ref.table === c.id && (ref.target === "entity") !== state)
          by.push(`${r.name}.${f.name}`);
      }
    }
    if (by.length > 0)
      findings.push({ path: `${m.doc.path}/time`, code: "still_referenced", referenced_by: by });
  }
  // A field to drop that the change keeps still using (07 «删除有依赖的对象编译失败»; 04-contract
  // «schema_draft» still_referenced): its own table's time field and keys as the draft writes them,
  // named by their positions in it, then the derived tables still reading it, by name.
  for (const [key, at] of droppedAt) {
    const [table, field] = key.split("/") as [string, string];
    const m = matches.find((x) => x.current?.id === table);
    const name = m?.current?.fields.find((f) => f.id === field)?.name;
    const by = m === undefined || name === undefined ? [] : keysNaming(m.doc, name);
    by.push(
      ...current.tables
        .filter(
          (r) =>
            r.kind === "derived" &&
            !dropped.has(r.id) &&
            r.rule.depends_on.some((d) => d.table === table && d.field === field),
        )
        .map((r) => r.name),
    );
    if (by.length > 0) findings.push({ path: at, code: "still_referenced", referenced_by: by });
  }
  if (findings.length > 0) return fail({ code: "validation_failed", details: findings });

  // From here the draft is a draft of this slot: what differs is classified.
  const changes: ChangesBlock[number][] = [];
  const policy = new Set(input.autoApply);
  const record = (
    target: ChangeTarget,
    change: SchemaChangeCode,
    cls: ChangeClass,
    o: {
      compatible: boolean;
      destructive?: boolean;
      autoClass?: string;
      auto?: boolean;
      asNeverWritten?: boolean;
    },
  ): void => {
    changes.push({
      target,
      change,
      class: cls,
      compatible_with_old_writes: o.compatible,
      destructive: o.destructive ?? false,
      auto: o.auto ?? (o.autoClass !== undefined && policy.has(o.autoClass)),
      ...(o.asNeverWritten ? { as_never_written: true as const } : {}),
    });
  };
  /**
   * A change compiled as on a table never written (07 «从未被写入的表上改结构»): metadata, nothing
   * lost, no conversion; automatic only with `restructure_unused` and the target unused; marked
   * `as_never_written`, so confirming judges it again and old writes are refused whole after it,
   * which its record says: `compatible_with_old_writes` is always false.
   */
  const asNeverWritten = (target: ChangeTarget, change: SchemaChangeCode): void =>
    record(target, change, "metadata", {
      compatible: false,
      auto: policy.has("restructure_unused") && input.unused(target),
      asNeverWritten: true,
    });
  /** Whether a derived rule of the current version reads the field (its `depends_on`). */
  const readByRule = (table: string, field: string): boolean =>
    current.tables.some(
      (r) =>
        r.kind === "derived" &&
        r.rule.depends_on.some((d) => d.table === table && d.field === field),
    );
  /**
   * A field a derived rule reads, changed in what the rule computes from it (type, dimension,
   * unit, precision) on a table never written: the rule would have to be compiled again and its
   * table rebuilt with the switch, which comes with changes to derived tables (07 «依赖方»).
   */
  const ruleReads = (table: string, field: string, what: string, param: string) =>
    readByRule(table, field)
      ? fail({ code: "not_in_this_version", reason: "not_implemented", what, param })
      : undefined;
  /** Whether a derived rule of the current version reads any field of the table. */
  const readsTable = (table: string): boolean =>
    current.tables.some(
      (r) => r.kind === "derived" && r.rule.depends_on.some((d) => d.table === table),
    );
  const notYet = (what: string, param: string): CompileChangeResult =>
    fail({ code: "not_implemented", what, param });
  /** `ref` fields compiled anew: the table each points at, by ID once every table has one. */
  const retargeted: { readonly table: string; readonly field: string; readonly f: DocField }[] = [];
  /** Tables whose external key the draft changes: their key, as it writes it. */
  const rekeyed: { readonly id: string; readonly doc: DocTable }[] = [];
  /** Tables whose time type or entity key the draft changes: their time and keys, as it writes them. */
  const retimed: { readonly id: string; readonly doc: DocTable }[] = [];

  if (extras.renameTo !== undefined && extras.renameTo !== current.name) {
    record({ slot: true }, "rename_slot", "metadata", { compatible: true });
  }
  if (doc.timezone !== current.timezone) return notYet("change_timezone", "timezone");

  const patched = new Map<string, CompiledBaseTable>();
  /** Tables whose physical shape or values change: a new physical table (08 «物理做法»). */
  const rebuilt = new Set<string>();
  /** Fields to add, compiled once the tables have their IDs. */
  const added: { readonly m: TableMatch; readonly j: number }[] = [];
  /** Findings of the classification: constants missing or not of the field. */
  const late: SchemaDetail[] = extras.bothForms.map((path) => ({
    path,
    code: "backfill_both_forms" as const,
  }));
  const checks: TightenedCheck[] = [];
  /** A constant `backfill` for field `f`, canonical, or its finding. */
  const constOf = (f: CompiledBaseField, raw: unknown, path: string): FieldValue | undefined => {
    if (input.constValue === undefined) throw new Error("a constant backfill without constValue");
    const r = input.constValue(f, raw, path);
    if ("detail" in r) {
      late.push(r.detail);
      return undefined;
    }
    return r.value;
  };
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

    // Table level. Fields dropped or added change the physical shape: a new physical table. The
    // time type and the keys are not compiled for a change yet.
    const gone = droppedFields.get(s.path) ?? new Set<string>();
    const neverWritten = input.neverWritten(c.id as TableId);
    for (const id of gone) {
      if (neverWritten) asNeverWritten({ ...tid, field: id as FieldId }, "drop_field");
      else
        record({ ...tid, field: id as FieldId }, "drop_field", "metadata", {
          compatible: false,
          destructive: true,
        });
      rebuilt.add(c.id);
    }
    m.fields.forEach((cf, j) => {
      if (cf !== undefined) return;
      added.push({ m, j });
      rebuilt.add(c.id);
    });
    // The table's structure: its time type, granularity and entity key. Only on a table never
    // written (07 «从未被写入的表上改结构»): metadata, marked `as_never_written`, the table built anew
    // and empty with the switch whatever its physical shape (08 «物理做法»: a table-level change on a table never written); the time and keys of the new
    // definition are taken from the draft once the fields added have their IDs (below). On a table
    // written: `not_in_this_version` (`table_written`).
    const restructured: (readonly [SchemaChangeCode, string])[] = [];
    if (s.time.type !== c.time.type) restructured.push(["change_time_type", `${s.path}/time`]);
    if (s.time.type === "event" && c.time.type === "event") {
      if (idOf.get(fold(s.time.field)) !== c.time.field)
        return notYet("change_time_field", `${s.path}/time/field`);
    }
    if (
      s.time.type === "state" &&
      c.time.type === "state" &&
      s.time.granularity !== c.time.granularity
    )
      restructured.push(["change_granularity", `${s.path}/time/granularity`]);
    const keyIds = (names: readonly string[] | undefined) =>
      names === undefined ? undefined : ids(names);
    const sameKey = (
      a: readonly (string | undefined)[] | undefined,
      b: readonly string[] | undefined,
    ) => (a === undefined || b === undefined ? a === b : same(a, b));
    if (!sameKey(keyIds(s.entity_key), c.entity_key))
      restructured.push(["change_entity_key", `${s.path}/entity_key`]);
    for (const [what, param] of restructured) {
      if (!neverWritten)
        return fail({ code: "not_in_this_version", reason: "table_written", what, param });
      // A derived rule reading the table would be compiled again against its new structure, which
      // comes with changes to derived tables (07 «依赖方»): not in this version.
      if (readsTable(c.id))
        return fail({ code: "not_in_this_version", reason: "not_implemented", what, param });
      asNeverWritten(tid, what);
      rebuilt.add(c.id);
    }
    if (restructured.length > 0) retimed.push({ id: c.id, doc: s });
    // The external key (07 «来源键»). On a table never written the key index is empty: added on
    // fields it has or not, dropped, or changed to other fields, as metadata with the table built
    // anew (08 «物理做法»). On a table written: dropped touches the catalog only (the index's entries are
    // cleared with the switch, the fields keep their values), and waits for confirmation; added
    // only on fields the same draft adds, which builds the table from the log, not in this version
    // yet; on a field it has, `external_key_existing_field`; changed, `table_written`.
    if (!sameKey(keyIds(s.external_key), c.external_key)) {
      const what =
        c.external_key === undefined
          ? "add_external_key"
          : s.external_key === undefined
            ? "drop_external_key"
            : "change_external_key";
      const param = `${s.path}/external_key`;
      if (neverWritten) {
        asNeverWritten(tid, what);
        rebuilt.add(c.id);
        rekeyed.push({ id: c.id, doc: s });
      } else if (what === "drop_external_key") {
        record(tid, what, "metadata", { compatible: true });
        rekeyed.push({ id: c.id, doc: s });
      } else if (what === "add_external_key") {
        const had = (s.external_key ?? []).flatMap((n, i) =>
          idOf.has(fold(n)) ? [`${param}/${i}`] : [],
        );
        if (had.length === 0)
          return fail({ code: "not_in_this_version", reason: "not_implemented", what, param });
        for (const path of had) late.push({ path, code: "external_key_existing_field" });
      } else return fail({ code: "not_in_this_version", reason: "table_written", what, param });
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

    // Fields kept: renames, text, constraints loosened or tightened, precision, unit.
    const fields = c.fields
      .filter((cf) => !gone.has(cf.id))
      .map((cf) => {
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
        // To or from `ref`: `change_ref` (07 «改动分类与迁移手段»), compiled as a change of type is.
        if (f.type !== cf.type)
          return {
            restructure: [
              f.type === "ref" || cf.type === "ref" ? "change_ref" : "change_type",
              `${f.path}/type`,
            ] as const,
            f,
            cf,
            j,
            target,
          };
        let unitChanged = false;
        if (f.type === "quantity") {
          const u = unitOf(f.unit as string);
          if (u !== undefined && u.code !== g.unit?.code) {
            if (u.dimension !== g.unit?.dimension)
              return {
                restructure: ["change_dimension", `${f.path}/unit`] as const,
                f,
                cf,
                j,
                target,
              };
            // The same dimension: values are converted from the old unit to the new one, with no
            // migrate (07 «确定性转换怎么重放»).
            patch["unit"] = { ...u };
            unitChanged = true;
          }
        }
        if (f.type === "ref") {
          const to = f.ref === undefined ? undefined : refId(f.ref.table, idByFinalName, doc.slot);
          if (to !== g.ref?.table || f.ref?.target !== g.ref?.target)
            return { restructure: ["change_ref", `${f.path}/ref`] as const, f, cf, j, target };
        }
        let loosened = false;
        let tightened = false;
        let requiredNow = false;
        /** `change_precision`: `lost` when the scale goes down (digits dropped), else `kept`. */
        let precision: "lost" | "kept" | undefined;
        /** Where the draft changes the precision: its scale, or its rounding only. */
        let precisionAt = `${f.path}/scale`;
        /** The scale made larger (a loosened constraint, no value changes). */
        let scaleRaised = false;
        /** A decimal or quantity: its values' shape before and after (unit and precision). */
        let shapes: { readonly from: NumberShape; readonly to: NumberShape } | undefined;
        if (f.type === "decimal" || f.type === "quantity") {
          const unit = f.type === "quantity" ? unitOf(f.unit as string) : undefined;
          const scale = f.scale ?? (unit !== undefined ? defaultScale(unit) : 6);
          const rounding = f.rounding ?? "half_up";
          const was = g.precision as { scale: number; rounding: "half_up" | "half_even" };
          shapes = {
            from: { ...(g.unit !== undefined ? { unit: g.unit as CompiledUnit } : {}), ...was },
            to: { ...(unit !== undefined ? { unit } : {}), scale, rounding },
          };
          if (rounding !== was.rounding || scale < was.scale) {
            patch["precision"] = { scale, rounding };
            precision = scale < was.scale ? "lost" : "kept";
            precisionAt = scale === was.scale ? `${f.path}/rounding` : `${f.path}/scale`;
          } else if (scale > was.scale) {
            patch["precision"] = { ...was, scale };
            loosened = true;
            scaleRaised = true;
          }
        }
        if (f.type === "integer" || f.type === "decimal" || f.type === "quantity") {
          for (const k of ["min", "max"] as const) {
            const now = f[k];
            const before = g[k];
            if (now !== before) patch[k] = now;
            // A bound is in the field's unit (07 «收紧约束»): the old one compared as the new unit
            // and precision would have it, `5 m → 5 km` on `min` tightening. One past 18 integer
            // digits once converted bounds nothing a value can be.
            const was =
              before === undefined || shapes === undefined ? before : asNew(before, shapes);
            if (
              now === was ||
              (now !== undefined && was !== undefined && compareDecimal(now, was) === 0)
            )
              continue;
            // An absent bound is no bound: dropping one loosens, adding one tightens.
            const looser =
              now === undefined ||
              (was !== undefined &&
                (k === "min" ? compareDecimal(now, was) < 0 : compareDecimal(now, was) > 0));
            if (looser) loosened = true;
            else tightened = true;
          }
        }
        if (f.type === "enum") {
          const now = f.values as readonly string[];
          const before = g.values as readonly string[];
          // Added values loosen; a reordering alone takes nothing away and changes no value's meaning,
          // so it is the same kind of change (automatic, old writes accepted, no rebuild).
          if (!same(now, before)) {
            patch["values"] = [...now];
            if (!before.every((v) => now.includes(v))) tightened = true;
            if (now.some((v) => !before.includes(v)) || !tightened) loosened = true;
          }
        }
        if (f.required !== (cf.required === true)) {
          if (f.required) {
            patch["required"] = true;
            requiredNow = true;
          } else {
            patch["required"] = undefined;
            loosened = true;
          }
        }
        return {
          f,
          cf,
          j,
          target,
          patch,
          loosened,
          tightened,
          requiredNow,
          precision,
          precisionAt,
          scaleRaised,
          unitChanged,
        };
      });
    const out: CompiledBaseField[] = [];
    for (const x of fields) {
      if ("restructure" in x) {
        // A change of type or dimension: on a table written, it needs a `migrate`, not in the
        // first version; a change to or from `ref`, or of its target, is not supported there
        // (`change_ref`: no rule turns a reference into another). On a table never written
        // (07 «从未被写入的表上改结构») there is no value to convert: the field is compiled anew
        // under its ID, the change is metadata, and the table gets a new physical table, empty
        // (not rebuilt from the log: 08 «物理做法»). Whether the table it points at was written
        // does not matter.
        const [what, param] = x.restructure;
        if (!input.neverWritten(c.id as TableId))
          return fail({ code: "not_in_this_version", reason: "table_written", what, param });
        const { f, cf, j, target } = x;
        const byRule = ruleReads(c.id, cf.id, what, param);
        if (byRule !== undefined) return byRule;
        const next = compileField(f, cf.id, merged, NO_REF_IDS) as unknown as Record<
          string,
          unknown
        >;
        if (f.name !== cf.name)
          record(target, "rename_field", "metadata", {
            compatible: true,
            auto: policy.has("rename_unused") && input.unused(target),
          });
        asNeverWritten(target, what);
        // The table a reference points at may be new in this draft: its ID once tables have theirs.
        if (f.type === "ref") retargeted.push({ table: c.id, field: cf.id, f });
        // Optional made required still takes a constant (07: whatever path the change takes).
        const bf = m.extra.backfills[j];
        const madeRequired = f.required === true && cf.required !== true;
        if (bf !== undefined) {
          if (!madeRequired) return fail(malformed(`${f.path}/backfill`));
          const value = constOf(
            next as unknown as CompiledBaseField,
            bf.raw,
            `${f.path}/backfill/const`,
          );
          if (value !== undefined) next["backfill"] = { const: value };
        } else if (madeRequired) late.push({ path: f.path, code: "backfill_const_required" });
        rebuilt.add(c.id);
        out.push(next as unknown as CompiledBaseField);
        continue;
      }
      const {
        f,
        cf,
        j,
        target,
        patch,
        loosened,
        tightened,
        requiredNow,
        precision,
        precisionAt,
        scaleRaised,
        unitChanged,
      } = x;
      // A larger scale on a field a derived rule reads, on any table: the rule declares the scale it
      // computes, so it would have to be compiled again (07 «依赖方»), and this loosening is
      // automatic. Not in this version.
      if (scaleRaised) {
        const byRule = ruleReads(c.id, cf.id, "change_precision", `${f.path}/scale`);
        if (byRule !== undefined) return byRule;
      }
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
      // Deterministic changes (07 «改动分类与迁移手段»): automatic only on a table never written and unused,
      // which this version does not compute, so they wait for confirmation.
      const neverWritten = input.neverWritten(c.id as TableId);
      if (neverWritten && unitChanged) {
        const byRule = ruleReads(c.id, cf.id, "change_unit", `${f.path}/unit`);
        if (byRule !== undefined) return byRule;
      }
      if (neverWritten && precision !== undefined) {
        const byRule = ruleReads(c.id, cf.id, "change_precision", precisionAt);
        if (byRule !== undefined) return byRule;
      }
      if (unitChanged) {
        if (neverWritten) asNeverWritten(target, "change_unit");
        else record(target, "change_unit", "deterministic", { compatible: true });
      }
      if (precision !== undefined) {
        if (neverWritten) asNeverWritten(target, "change_precision");
        else
          record(target, "change_precision", "deterministic", {
            compatible: true,
            destructive: precision === "lost",
          });
      }
      if (tightened || requiredNow) {
        if (neverWritten) asNeverWritten(target, "tighten_constraint");
        else
          record(target, "tighten_constraint", "deterministic", {
            compatible: true,
            destructive: true,
          });
      }
      if (unitChanged || precision !== undefined || tightened || requiredNow) rebuilt.add(c.id);
      // The `backfill` (07 «收紧约束»): a constant for optional made required, always; for a bound
      // or enum value taken away, a constant or else no position in effect may break it.
      const bf = m.extra.backfills[j];
      const field = next as unknown as CompiledBaseField;
      if (bf !== undefined) {
        if (!tightened && !requiredNow) return fail(malformed(`${f.path}/backfill`));
        const value = constOf(field, bf.raw, `${f.path}/backfill/const`);
        if (value !== undefined) next["backfill"] = { const: value };
      } else if (requiredNow) late.push({ path: f.path, code: "backfill_const_required" });
      else if (
        !neverWritten &&
        (unitChanged || precision === "lost") &&
        (tightened || next["min"] !== undefined || next["max"] !== undefined)
      )
        // What breaks the field as it would be is known only with each value converted and rounded
        // anew, which comes with building a version: not taken in this version yet.
        return fail({ code: "not_in_this_version", reason: "not_implemented", param: f.path });
      else if (tightened) checks.push({ table: c.id as TableId, field, path: f.path });
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
    // A derived table has no values of its own to lose, nor writes (07 «改动分类与迁移手段», the
    // row dropping a derived table).
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
  for (const { table: id, field, f } of retargeted) {
    const t = patched.get(id) as CompiledBaseTable;
    const to = ids.table.get(refTable(merged, (f.ref as { table: string }).table) as DocTable);
    patched.set(id, {
      ...t,
      fields: t.fields.map((x) =>
        x.id === field
          ? ({
              ...x,
              ref: { table: to, target: (f.ref as { target: string }).target },
            } as unknown as CompiledBaseField)
          : x,
      ),
    });
  }
  // Fields added to kept tables: numbered from the table's next free number (field IDs are never
  // reused, given-up versions included), after the fields kept, in the draft's order.
  const nextField = new Map<string, number>();
  for (const { m, j } of added) {
    const c = m.current as CompiledBaseTable;
    const f = m.doc.fields[j] as DocField;
    if (input.nextFieldNumber === undefined)
      throw new Error("a field added without nextFieldNumber");
    const n = nextField.get(c.id) ?? input.nextFieldNumber(c.id);
    if (!Number.isSafeInteger(n) || n < 1 || n > 999_999_999)
      throw new Error(`not a field number: ${n}`);
    nextField.set(c.id, n + 1);
    const cf = compileField(f, `f${n}`, merged, ids) as unknown as Record<string, unknown>;
    const target = { table: c.id as TableId, field: cf["id"] as FieldId };
    const bf = m.extra.backfills[j];
    if (f.required) {
      // A required field added: a constant fills every position in effect (07 «改动分类与迁移手段»).
      if (bf === undefined) late.push({ path: f.path, code: "backfill_const_required" });
      else {
        const value = constOf(
          cf as unknown as CompiledBaseField,
          bf.raw,
          `${f.path}/backfill/const`,
        );
        if (value !== undefined) cf["backfill"] = { const: value };
      }
      if (input.neverWritten(c.id as TableId)) asNeverWritten(target, "add_required_field");
      else record(target, "add_required_field", "deterministic", { compatible: true });
    } else {
      if (bf !== undefined) return fail(malformed(`${f.path}/backfill`));
      record(target, "add_optional_field", "metadata", {
        compatible: true,
        autoClass: "add_optional_field",
      });
    }
    const t = patched.get(c.id) as CompiledBaseTable;
    patched.set(c.id, { ...t, fields: [...t.fields, cf as unknown as CompiledBaseField] });
  }
  // The time and entity key of a table restructured, as the draft writes them, by the IDs its
  // fields have now (fields it adds included). The compilation rules held them already: an event
  // table's time field exists and is required, an entity key only on a state table.
  for (const { id, doc: s } of retimed) {
    const t = patched.get(id) as CompiledBaseTable;
    const idOf = new Map(t.fields.map((f) => [fold(f.name), f.id]));
    const ref = (n: string) => idOf.get(fold(n)) as FieldId;
    const next: Record<string, unknown> = {
      ...t,
      time:
        s.time.type === "event"
          ? { type: "event", field: ref(s.time.field) }
          : s.time.type === "state"
            ? { type: "state", granularity: s.time.granularity }
            : { type: "none" },
    };
    if (s.entity_key !== undefined) next["entity_key"] = s.entity_key.map(ref);
    else delete next["entity_key"];
    patched.set(id, next as unknown as CompiledBaseTable);
  }
  for (const { id, doc: s } of rekeyed) {
    const t = patched.get(id) as CompiledBaseTable;
    const idOf = new Map(t.fields.map((f) => [fold(f.name), f.id]));
    const next: Record<string, unknown> = { ...t };
    if (s.external_key !== undefined)
      next["external_key"] = s.external_key.map((n) => idOf.get(fold(n)) as FieldId);
    else delete next["external_key"];
    patched.set(id, next as unknown as CompiledBaseTable);
  }
  if (late.length > 0)
    return fail({
      code: "validation_failed",
      details: late,
    });

  const compiledFresh = fresh.map((m) => compileTable(m.doc, merged, ids, sv));
  for (const t of compiledFresh) {
    record({ table: t.id }, "add_table", "create", { compatible: true, autoClass: "add_table" });
  }

  // Kept tables keep their physical tables: `since` says which version built them, which an omitted
  // `since` no longer would (it means this version).
  // A table rebuilt gets a physical table of this version (`since` left out: this version).
  const carry = <T extends CompiledTable>(t: T): T =>
    rebuilt.has(t.id)
      ? { ...t, physical: { table: `t_${t.id}_v${sv}` } }
      : { ...t, physical: { table: t.physical.table, since: t.physical.since ?? current.sv } };
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

  // A key of one field, on a new table or one whose key the draft changes (07 «来源键»).
  const pathOf = new Map(
    [...fresh.map((m) => m.doc), ...rekeyed.map((r) => r.doc)].map(
      (d) => [d.name, `${d.path}/external_key`] as const,
    ),
  );
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
    checks,
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
