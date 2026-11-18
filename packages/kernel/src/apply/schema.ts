// apply of slot policy and schema events: creating a slot (docs/zh-CN/spec/09-event-format.md §4.5,
// §5.4, §5.5, §7) and the physical tables of a version (02-architecture.md §8 "存储格式 v1").
//
// This phase applies the path that creates a slot: `schema.draft_submitted` (creates_slot) →
// `schema.compiled` (with `create_slot`) → `schema.confirmed` → `slot.policy_set` →
// `schema.switched` (no `from_version`, nothing rebuilt). Changing a slot's schema, migrations and
// rejected or superseded drafts stop apply as not implemented, never skipped. So does a definition
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
import { evaluationRefusal } from "../rules/index.ts";
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
    if ((t.physical.since ?? c.sv) !== c.sv) {
      throw new ApplyError(
        "not_implemented",
        seq,
        `table ${t.id} built in version ${t.physical.since} is not applied yet`,
      );
    }
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
  input: { readonly switchTo?: SwitchInput; readonly slot?: SlotInput },
): Change[] | undefined {
  const notYet = (what: string) =>
    new ApplyError("not_implemented", seq, `${what} is not applied yet`);
  switch (type) {
    case "schema.draft_submitted":
      if (block("target")["creates_slot"] !== true) throw notYet("a draft changing a slot");
      return [];
    // §5.5: the first compiled definition of a slot creates its row; the version becomes current
    // when it is switched to.
    case "schema.compiled": {
      const changes = block("changes") as unknown as readonly { change: string }[];
      if (!changes.some((x) => x.change === "create_slot")) throw notYet("a change to a slot");
      if (block("target")["outcome"] !== "applied") throw notYet("a slot awaiting confirmation");
      const c = block("compiled") as unknown as CompiledSchema;
      admit(seq, c);
      if (c.slot !== slot) {
        throw new ApplyError("inconsistent", seq, `compiled for ${c.slot} in slot ${String(slot)}`);
      }
      return [{ kind: "slot_insert", id: c.slot, name: c.name, timezone: c.timezone }];
    }
    case "schema.confirmed":
      return [];
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
    // §5.5: build the version's new physical tables, point the slot at it.
    case "schema.switched": {
      const t = block("target");
      if ("from_version" in t) throw notYet("a switch from an earlier version");
      const to = input.switchTo;
      if (to === undefined) {
        throw new ApplyError("inconsistent", seq, `no compiled version ${String(t["to_version"])}`);
      }
      const c = to.compiled;
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
          name: c.name,
          timezone: c.timezone,
        },
      ];
    }
    default:
      return undefined;
  }
}
