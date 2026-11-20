// apply of slot policy and schema events: creating a slot (docs/zh-CN/spec/09-event-format.md §4.5,
// §5.4, §5.5, §7) and the physical tables of a version (02-architecture.md §8 "存储格式 v1").
//
// This phase applies the path that creates a slot: `schema.draft_submitted` (creates_slot) →
// `schema.compiled` (with `create_slot`) → `schema.confirmed` → `slot.policy_set` →
// `schema.switched` (no `from_version`, nothing rebuilt); and a draft changing a slot left pending:
// its `schema.compiled` (`pending`) takes its version number (a `schema_versions` row, pending),
// `schema.superseded` gives it up (the row and number stay); a switch from an earlier version that
// rebuilds nothing (catalog-only changes, new tables) moves the pointer. Rejected drafts, switches
// rebuilding tables and migrations stop apply as not implemented, never skipped. So does a definition
// with an external key, or with a derived rule this version does not evaluate: their indexes and
// evaluation belong to later phases, and an empty table would leave the state silently behind the
// log. Derived tables get their physical tables here (./derived.ts).
//
// Tables are only ever created here, from the compiled definition: never by hand.

import {
  type CompiledBaseField,
  type CompiledBaseTable,
  type CompiledDerivedTable,
  type CompiledSchema,
  type CompiledTable,
  canonicalize,
  type JsonValue,
  type Seq,
} from "@fluxvita/saveslot-contract-core";
import { derivedLayout, evaluationRefusal } from "../rules/index.ts";
import { isKnownRsqlVersion } from "../rules/version.ts";
import { derivedTableDdl } from "./derived.ts";
import { ApplyError, type Change } from "./model.ts";

type Obj = Readonly<Record<string, JsonValue>>;

const T = 'TEXT COLLATE "C"';

/** The SQL type of a field's column (03-data-model/11-restricted-sql.md «类型»). */
const COLUMN_TYPES: Readonly<Record<CompiledBaseField["type"], string>> = {
  text: T,
  enum: T,
  ref: T,
  integer: "BIGINT",
  decimal: "NUMERIC",
  quantity: "NUMERIC",
  boolean: "BOOLEAN",
  date: "DATE",
  zoned_datetime: "TIMESTAMPTZ",
};

/** A field's columns: `f_<field>`, and for a `zoned_datetime` its zone beside the instant. */
function fieldColumns(f: CompiledBaseField): string[] {
  const cols = [`"f_${f.id}" ${COLUMN_TYPES[f.type]}`];
  if (f.type === "zoned_datetime") cols.push(`"f_${f.id}__zone" ${T}`);
  return cols;
}

/**
 * The DDL of a base table's physical tables: the business table `t_<table>_v<n>` (current version)
 * and its version table `t_<table>_v<n>__ver` (one cell per field, business interval and record
 * interval). Names come from `physical.table`, which the event's shape check pins to
 * `t_<table>_v<since>`.
 *
 * Not yet: the internal date column of a `zoned_datetime` field (with the time zone database
 * version in `meta`), which the read path adds.
 */
export function baseTableDdl(t: CompiledBaseTable): string {
  const name = t.physical.table;
  // The names go into SQL quoted, never escaped: they must be of this form. The parse of the
  // event checks it already; this is the second line, since the definition a switch builds from
  // is read back from storage.
  if (!/^t[1-9][0-9]{0,8}$/.test(t.id) || !new RegExp(`^t_${t.id}_v[1-9][0-9]{0,8}$`).test(name)) {
    throw new Error(`not a physical table name: ${JSON.stringify(name)}`);
  }
  for (const f of t.fields) {
    if (!/^f[1-9][0-9]{0,8}$/.test(f.id))
      throw new Error(`not a field ID: ${JSON.stringify(f.id)}`);
  }
  const fields = t.fields.flatMap(fieldColumns);
  const state = t.time.type === "state";
  const g = state ? (t.time.granularity === "date" ? "DATE" : "TIMESTAMPTZ") : "";
  const business = state
    ? [
        `entity_id ${T} NOT NULL`,
        `valid_from ${g} NOT NULL`,
        `valid_to ${g}`,
        ...fields,
        "PRIMARY KEY (entity_id, valid_from)",
      ]
    : [`row_id ${T} PRIMARY KEY`, "revoked BOOLEAN NOT NULL DEFAULT FALSE", ...fields];
  const version = [
    `row_id ${T} NOT NULL`, // row or entity ID
    `field_id ${T} NOT NULL`, // field ID, or 'existence'
    ...(state ? [`valid_from ${g} NOT NULL`, `valid_to ${g}`] : []),
    "rec_from BIGINT NOT NULL",
    "rec_to BIGINT",
    `intent ${T} NOT NULL`,
    "src_event BIGINT", // the contribution that gave the value: event, field, item
    `src_field ${T}`,
    "src_k INTEGER",
    "revoked BOOLEAN", // existence cells: the row is revoked (by a revoke)
    // State tables' field cells: the entity has no value on this stretch, and this cell names the
    // operation that left it so (a no-value write-back). Not set on a field merely empty where the
    // entity has a value (a clear, a field never written): 05-time «无值区间».
    "no_value BOOLEAN",
    ...fields,
    `PRIMARY KEY (row_id, field_id, ${state ? "valid_from, " : ""}rec_from)`,
  ];
  return [
    `CREATE TABLE "${name}" (\n  ${business.join(",\n  ")}\n);`,
    `CREATE TABLE "${name}__ver" (\n  ${version.join(",\n  ")}\n);`,
    `CREATE INDEX "${name}__ver_row" ON "${name}__ver" (row_id, rec_from);`,
  ].join("\n");
}

/** What the catalog keeps of a table (02-architecture §8 `catalog`): its definition as compiled. */
const structureOf = (t: CompiledTable): string => {
  const { physical: _, ...rest } = t;
  return canonicalize(rest as unknown as JsonValue);
};

/**
 * Stops on what a compiled definition holds that this phase does not apply: external keys, derived
 * rules this version does not evaluate, and tables built in an earlier version (creating a slot
 * builds every table).
 */
function admit(
  seq: Seq,
  c: CompiledSchema,
): { base: CompiledBaseTable[]; derived: CompiledDerivedTable[] } {
  if (!isKnownRsqlVersion(c.rsql)) {
    throw new ApplyError("unknown_version", seq, `unknown rsql version ${c.rsql}`);
  }
  const base: CompiledBaseTable[] = [];
  const derived: CompiledDerivedTable[] = [];
  for (const t of c.tables) {
    // Built in an earlier version and kept: nothing to build.
    if ((t.physical.since ?? c.sv) !== c.sv) continue;
    if (t.kind === "derived") {
      let refusal: ReturnType<typeof evaluationRefusal>;
      try {
        refusal = evaluationRefusal(c, t.id);
      } catch (e) {
        // The definition's rule does not check against its own fields or tables: the event's
        // content, not a defect of the kernel.
        throw new ApplyError(
          "inconsistent",
          seq,
          `derived table ${t.id}: its rule does not check (${(e as Error).message})`,
        );
      }
      if (refusal !== undefined) {
        throw new ApplyError(
          "not_implemented",
          seq,
          `derived table ${t.id}: ${refusal.kind} is not evaluated yet`,
        );
      }
      derived.push(t);
      continue;
    }
    if ("external_key" in t && t.external_key !== undefined) {
      throw new ApplyError("not_implemented", seq, `external key of ${t.id} is not applied yet`);
    }
    base.push(t);
  }
  return { base, derived };
}

/** The compiled definition a `schema.switched` switches to, read by the caller. */
export interface SwitchInput {
  /** `seq` of the `schema.compiled` event of the draft and version switched to. */
  readonly seq: Seq;
  readonly compiled: CompiledSchema;
  /** That event's `changes` (09 §5.5): what the draft changes, by IDs. */
  readonly changes?: readonly { readonly change: string; readonly target: Obj }[];
  /** A switch from an earlier version: the slot's current version's definition, when it has one. */
  readonly from?: CompiledSchema;
}

/** The slot a `slot.removed` removes, as it is, read by the caller. */
export interface RemoveInput {
  readonly currentSv: number | null;
  /** The current version's compiled definition: its physical tables are dropped. */
  readonly compiled: CompiledSchema | undefined;
}

/**
 * Drops the physical tables of a version (09 §5.4 `slot.removed`): a base table with its version
 * table (its index goes with it), a derived table. Names are checked as when they were created.
 */
function dropDdl(c: CompiledSchema): string {
  return c.tables
    .flatMap((t) => {
      if (t.kind === "derived") return [`DROP TABLE "${derivedLayout(t).table}";`];
      const name = t.physical.table;
      if (
        !new RegExp(`^t_${t.id}_v[1-9][0-9]{0,8}$`).test(name) ||
        !/^t[1-9][0-9]{0,8}$/.test(t.id)
      )
        throw new Error(`not a physical table name: ${JSON.stringify(name)}`);
      return [`DROP TABLE "${name}__ver";`, `DROP TABLE "${name}";`];
    })
    .join("\n");
}

/** The slot a switch is in, and the table IDs already used in the tenant, read by the caller. */
export interface SlotInput {
  readonly currentSv: number | null;
  readonly policySeq: number | null;
  readonly tables: ReadonlySet<string>;
}

export function planSchema(
  type: string,
  seq: Seq,
  slot: string | undefined,
  block: (path: string) => Obj,
  input: {
    readonly switchTo?: SwitchInput;
    readonly slot?: SlotInput;
    readonly remove?: RemoveInput;
  },
): Change[] | undefined {
  const notYet = (what: string) =>
    new ApplyError("not_implemented", seq, `${what} is not applied yet`);
  switch (type) {
    // §5.5: the draft is in the log; what it becomes is the events after it.
    case "schema.draft_submitted":
      return [];
    // §5.5: the first compiled definition of a slot creates its row; the version becomes current
    // when it is switched to. A draft changing a slot takes its version number now, pending until
    // confirmed or given up.
    case "schema.compiled": {
      const changes = block("changes") as unknown as readonly { change: string }[];
      const target = block("target");
      if (!changes.some((x) => x.change === "create_slot")) {
        const c = block("compiled") as unknown as CompiledSchema;
        if (!isKnownRsqlVersion(c.rsql)) {
          throw new ApplyError("unknown_version", seq, `unknown rsql version ${c.rsql}`);
        }
        if (c.slot !== slot) {
          throw new ApplyError(
            "inconsistent",
            seq,
            `compiled for ${c.slot} in slot ${String(slot)}`,
          );
        }
        return [
          {
            kind: "version_pending",
            slot: c.slot,
            sv: c.sv,
            compiled_seq: seq,
            draft_id: target["draft_id"] as string,
          },
        ];
      }
      if (target["outcome"] !== "applied") throw notYet("a slot awaiting confirmation");
      const c = block("compiled") as unknown as CompiledSchema;
      admit(seq, c);
      // A slot being created has no earlier version: every table is built in this one.
      const kept = c.tables.find((x) => (x.physical.since ?? c.sv) !== c.sv);
      if (kept !== undefined)
        throw new ApplyError(
          "inconsistent",
          seq,
          `table ${kept.id} of a slot being created built in version ${String(kept.physical.since)}`,
        );
      if (c.slot !== slot) {
        throw new ApplyError("inconsistent", seq, `compiled for ${c.slot} in slot ${String(slot)}`);
      }
      return [{ kind: "slot_insert", id: c.slot, name: c.name, timezone: c.timezone }];
    }
    case "schema.confirmed":
      return [];
    // §5.5: a pending draft given up for a newer one; its version number stays taken.
    case "schema.superseded":
      return [
        {
          kind: "version_given_up",
          slot: slot as string,
          draft_id: block("target")["draft_id"] as string,
          state: "superseded",
        },
      ];
    // §5.4
    case "slot.policy_set":
      return [
        {
          kind: "slot_policy",
          id: slot as string,
          seq,
          policy_version: block("policy")["policy_version"] as number,
        },
      ];
    // §5.4: an empty slot removed. Whether it is empty was decided when it was written; apply
    // takes the slot away: its row, catalog and counts, and its physical tables. Its versions
    // stay (table numbers and slot IDs are not used again), and so do request keys.
    case "slot.removed": {
      const t = block("target");
      const inconsistent = (what: string) => new ApplyError("inconsistent", seq, what);
      if (t["slot_id"] !== slot) throw inconsistent(`target ${String(t["slot_id"])} in ${slot}`);
      const r = input.remove;
      if (r === undefined) throw inconsistent(`no slot ${String(slot)}`);
      if (r.currentSv !== t["sv"] || r.compiled === undefined)
        throw inconsistent(`slot ${String(slot)} is not at version ${String(t["sv"])}`);
      return [
        { kind: "ddl", sql: dropDdl(r.compiled) },
        { kind: "slot_remove", slot: slot as string, tables: r.compiled.tables.map((x) => x.id) },
      ];
    }
    // §5.5: build the version's new physical tables, point the slot at it.
    case "schema.switched": {
      const t = block("target");
      if ("from_version" in t) return planSwitchFrom(seq, slot, t, input);
      const to = input.switchTo;
      if (to === undefined) {
        throw new ApplyError("inconsistent", seq, `no compiled version ${String(t["to_version"])}`);
      }
      const c = to.compiled;
      const kept = c.tables.find((x) => (x.physical.since ?? c.sv) !== c.sv);
      if (kept !== undefined)
        throw new ApplyError(
          "inconsistent",
          seq,
          `table ${kept.id} of a slot being created built in version ${String(kept.physical.since)}`,
        );
      const { base: tables, derived } = admit(seq, c);
      const s = input.slot;
      const inconsistent = (what: string) => new ApplyError("inconsistent", seq, what);
      if (s === undefined) throw inconsistent(`no slot ${String(slot)}`);
      if (s.currentSv !== null)
        throw inconsistent(`slot ${String(slot)} already has version ${s.currentSv}`);
      // §4.5: the initial policy comes before the switch that creates the slot.
      if (s.policySeq === null) throw inconsistent(`slot ${String(slot)} has no policy`);
      const taken = [...tables, ...derived].find((x) => s.tables.has(x.id));
      if (taken !== undefined) throw inconsistent(`table ${taken.id} already exists`);
      return [
        {
          kind: "ddl",
          sql: [
            ...tables.map(baseTableDdl),
            ...derived.map((x) => derivedTableDdl(x, (type) => COLUMN_TYPES[type])),
          ].join("\n"),
        },
        ...derived.map(
          (x): Change => ({
            kind: "catalog_insert",
            table_id: x.id,
            sv: c.sv,
            slot: c.slot,
            structure: structureOf(x),
          }),
        ),
        ...tables.flatMap((x): Change[] => [
          {
            kind: "catalog_insert",
            table_id: x.id,
            sv: c.sv,
            slot: c.slot,
            structure: structureOf(x),
          },
          { kind: "counts_init", table_id: x.id },
        ]),
        {
          kind: "version_switch",
          slot: c.slot,
          sv: c.sv,
          compiled_seq: to.seq,
          draft_id: t["draft_id"] as string,
          name: c.name,
          timezone: c.timezone,
        },
      ];
    }
    default:
      return undefined;
  }
}

/**
 * What a table's physical tables are made of, by the definition: their name, and the columns its
 * fields give (ID and type; a base table's time columns by its time type). Equal for a table kept
 * from one version to the next.
 */
function physicalShape(t: CompiledTable): string {
  const fields = t.fields.map((f) => `${f.id}:${f.type}`).sort();
  return t.kind === "derived"
    ? canonicalize({ kind: "derived", table: derivedLayout(t).table, fields })
    : canonicalize({
        kind: "base",
        table: t.physical.table,
        time: t.time.type === "state" ? `state:${t.time.granularity}` : t.time.type,
        fields,
      });
}

/**
 * §5.5 `schema.switched` from an earlier version, with nothing rebuilt (a change to the catalog
 * only): the tables new in this version are built as a new slot's are (they have no writes to
 * convert); every table of the version gets its catalog row; the pointer moves, the earlier
 * version is retired. Tables the version keeps keep their physical tables; a table it drops stays
 * as a retired table.
 *
 * Only that: what else a switch could bring stops, never skipped (an empty or stale table would
 * leave the state silently behind the log). Not implemented: a new derived table (built empty,
 * while its sources have rows), a kept derived table whose rule changed (not evaluated again), a
 * time zone or slot name other than the earlier version's (nothing here recomputes what depends
 * on them). Inconsistent: a table kept from an earlier version that the earlier version does not
 * have, or has with other physical tables or field columns; a table of the earlier version gone
 * without the draft dropping it.
 */
function planSwitchFrom(
  seq: Seq,
  slot: string | undefined,
  t: Obj,
  input: { readonly switchTo?: SwitchInput; readonly slot?: SlotInput },
): Change[] {
  const inconsistent = (what: string) => new ApplyError("inconsistent", seq, what);
  const rebuilt = t["rebuilt_tables"] as readonly string[];
  if (rebuilt.length > 0)
    throw new ApplyError("not_implemented", seq, "a switch rebuilding tables is not applied yet");
  const to = input.switchTo;
  if (to === undefined) throw inconsistent(`no compiled version ${String(t["to_version"])}`);
  const c = to.compiled;
  const s = input.slot;
  if (s === undefined) throw inconsistent(`no slot ${String(slot)}`);
  if (s.currentSv !== t["from_version"])
    throw inconsistent(
      `slot ${String(slot)} is at version ${String(s.currentSv)}, not ${String(t["from_version"])}`,
    );
  const notYet = (what: string) =>
    new ApplyError("not_implemented", seq, `${what} is not applied yet`);
  const prev = to.from;
  if (prev === undefined || prev.sv !== t["from_version"])
    throw inconsistent(`no definition of version ${String(t["from_version"])}`);
  if (c.timezone !== prev.timezone) throw notYet("a switch changing the time zone");
  if (c.name !== prev.name) throw notYet("a switch renaming the slot");
  const { base: built, derived } = admit(seq, c);
  const fresh = [...built, ...derived];
  const [newDerived] = derived;
  if (newDerived !== undefined)
    throw notYet(`a switch adding derived table ${newDerived.id} (built from its sources)`);
  const taken = fresh.find((x) => s.tables.has(x.id));
  if (taken !== undefined) throw inconsistent(`table ${taken.id} already exists`);
  const isNew = new Set(fresh.map((x) => x.id));
  // The tables kept: as the earlier version has them, physically.
  for (const x of c.tables) {
    if (isNew.has(x.id)) continue;
    const was = prev.tables.find((y) => y.id === x.id);
    if (was === undefined)
      throw inconsistent(`table ${x.id} is kept, but version ${prev.sv} does not have it`);
    if (physicalShape(was) !== physicalShape(x))
      throw inconsistent(`table ${x.id} is kept with other physical tables or field columns`);
    if (
      x.kind === "derived" &&
      was.kind === "derived" &&
      canonicalize(x.rule as unknown as JsonValue) !==
        canonicalize(was.rule as unknown as JsonValue)
    )
      throw notYet(`a switch changing the rule of derived table ${x.id}`);
  }
  // The tables gone: each dropped by the draft.
  const dropped = new Set(
    (to.changes ?? []).flatMap((x) =>
      x.change === "drop_table" && typeof x.target["table"] === "string" ? [x.target["table"]] : [],
    ),
  );
  const gone = prev.tables.find((y) => !c.tables.some((x) => x.id === y.id) && !dropped.has(y.id));
  if (gone !== undefined)
    throw inconsistent(`table ${gone.id} of version ${prev.sv} is gone, not dropped`);
  return [
    {
      kind: "ddl",
      sql: [
        ...built.map(baseTableDdl),
        ...derived.map((x) => derivedTableDdl(x, (type) => COLUMN_TYPES[type])),
      ].join("\n"),
    },
    ...c.tables.flatMap((x): Change[] => [
      { kind: "catalog_insert", table_id: x.id, sv: c.sv, slot: c.slot, structure: structureOf(x) },
      ...(x.kind === "base" && isNew.has(x.id)
        ? [{ kind: "counts_init", table_id: x.id } as Change]
        : []),
    ]),
    {
      kind: "version_switch",
      slot: c.slot,
      sv: c.sv,
      from: t["from_version"] as number,
      compiled_seq: to.seq,
      draft_id: t["draft_id"] as string,
      name: c.name,
      timezone: c.timezone,
    },
  ];
}
