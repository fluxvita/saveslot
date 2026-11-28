// `catalog` (docs/zh-CN/spec/04-contract.md §10 `catalog`; 04-contract-types.md §4.2), its three
// levels within the visible range:
// - `list`: the slots and their tables, paged by table;
// - `table`: 1–10 tables, their definitions: time type, keys, field types, units, bounds,
//   precision, a derived table's rule;
// - `schema`: a slot's whole schema document, IDs, `base_version` and the inferences filled in
//   (./documents.ts), and the slot's policy in effect; with `draft`, the document the slot would
//   have once switched to that draft, on the version it holds on (./documents.ts). Either only
//   with every table of the slot in range.
// Not in this version: the value examples of the fields and `described_by` (P2), migration status
// (no migrations yet). A table has its profile (./profile.ts). Aliases
// (07 «schema 文档格式 · 别名») are given where a table or field has them: `list` the tables',
// `table` the tables' and the fields', `schema` in the document as submitted. They are not names.
// The read is recorded (`operation: catalog`), counting as reading the `sv` of each slot it shows
// (04-contract §2 «什么算读到 sv»).

import type {
  CompiledBaseField,
  CompiledDerivedTable,
  CompiledPrecision,
  CompiledTable,
  DraftId,
  FieldType,
  Instant,
  PolicyBlock,
  PrincipalId,
  RefTarget,
  SlotId,
  TableId,
  TimeDependency,
} from "@fluxvita/saveslot-contract-core";
import { canonicalize, SELFCHECK_TASK } from "@fluxvita/saveslot-contract-core";
import type { ReadEntry, ReadId } from "../audit/index.ts";
import { fold, get, has, isDenseArray, isObj, keysOf, type Obj } from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { draftDocument, ruleTextsOf, slotDocument } from "./documents.ts";
import { taskOf } from "./history.ts";
import { digest, pageAfter, positionOf } from "./page.ts";
import { profileOf, SCALE_BOUNDS, type ScaleBounds, type TableProfile } from "./profile.ts";
import type { KeySpec } from "./rows.ts";
import { logPosition, restoreCount } from "./select.ts";
import {
  resolveTable,
  type Visibility,
  type VisibleSlot,
  visibleSlots,
  wholeSlot,
} from "./slots.ts";
import { actors } from "./timeline.ts";
import { type Actor, invalid, ReadError } from "./types.ts";

export interface CatalogInput {
  readonly actor: PrincipalId;
  readonly task: string | null;
  readonly now: Instant;
  readonly visibility: Visibility;
  readonly params: unknown;
  readonly read: ReadId;
  /** The lines of the scale hint; the ones the kernel ships when not given (./profile.ts). */
  readonly scaleBounds?: ScaleBounds;
}

export interface CatalogListResult {
  readonly level: "list";
  readonly total: number;
  readonly next_position?: string;
  readonly slots: readonly {
    readonly slot: string;
    readonly slot_id: SlotId;
    readonly sv: number;
    readonly timezone: string;
    readonly tables: readonly {
      readonly table: string;
      readonly kind: "base" | "derived";
      readonly description: string;
      readonly aliases?: readonly string[];
    }[];
  }[];
}

export interface CatalogTable {
  readonly table: string;
  readonly slot: string;
  readonly sv: number;
  readonly timezone: string;
  readonly kind: "base" | "derived";
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly time?:
    | { readonly type: "none" }
    | { readonly type: "event"; readonly field: string }
    | { readonly type: "state"; readonly granularity: "date" | "instant" };
  readonly entity_key?: readonly string[];
  readonly external_key?: readonly string[];
  readonly duplicate_keys?: readonly (readonly string[])[];
  readonly together?: readonly (readonly string[])[];
  readonly fields: readonly CatalogField[];
  readonly rule?: {
    readonly id: string;
    readonly version: number;
    readonly sql: string;
    readonly time_dependency: TimeDependency;
    readonly depends_on: readonly string[];
  };
  readonly profile?: TableProfile;
}

/** One field of a catalog table (04-contract-types §4.2 `CatalogField`). */
export interface CatalogField {
  readonly name: string;
  readonly type: FieldType;
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly required?: true;
  readonly unit?: string;
  readonly min?: string;
  readonly max?: string;
  readonly values?: readonly string[];
  readonly ref?: { readonly table: string; readonly target: RefTarget };
  readonly precision?: CompiledPrecision;
}

/** A slot's policy in effect (04-contract-types §8.2 `SlotPolicy`), names for IDs. */
export interface SlotPolicy
  extends Pick<PolicyBlock, "policy_version" | "effective_value_rule" | "rank" | "auto_apply"> {
  readonly slot: string;
  readonly high_impact?: readonly Obj[];
  readonly user_session_only?: readonly unknown[];
  readonly set_by: Actor;
  readonly set_at: string;
  readonly seq: number;
}

export interface CatalogTablesResult {
  readonly level: "table";
  readonly tables: readonly CatalogTable[];
}

export interface CatalogSchemaResult {
  readonly level: "schema";
  readonly slot: string;
  /** With `draft`, the version the draft compiles to. */
  readonly sv: number;
  readonly draft?: DraftId;
  readonly document: Record<string, unknown>;
  readonly policy: SlotPolicy;
}

export type CatalogResult = CatalogListResult | CatalogTablesResult | CatalogSchemaResult;

const KEYS: Readonly<Record<string, readonly string[]>> = {
  list: ["level", "slot", "limit", "position", "task"],
  table: ["level", "tables", "task"],
  schema: ["level", "slot", "draft", "task"],
};
const LIST_DEFAULT = 50;
const LIST_MAX = 200;
const MAX_TABLES = 10;
const DRAFT_ID = /^d_[0-9A-HJKMNP-TV-Z]{16}$/;

/** A slot named by the caller within the visible range; `not_found` (`slot`) otherwise. */
function slotNamed(v: unknown, slots: readonly VisibleSlot[]): VisibleSlot {
  if (typeof v !== "string" || v === "") throw invalid("malformed", "slot");
  const s = slots.find((x) => fold(x.name) === fold(v));
  if (s === undefined)
    throw new ReadError("not_found", "no such slot", { reason: "slot", param: "slot" });
  return s;
}

/** Whether a table or field has aliases to give (none when absent or empty). */
const hasAliases = (x: {
  readonly aliases?: readonly string[];
}): x is { readonly aliases: readonly string[] } => x.aliases !== undefined && x.aliases.length > 0;

/** A table's definition, names for IDs (04-contract-types §4.2 `CatalogTables`). */
function tableOf(slot: VisibleSlot, t: CompiledTable, sql: string | undefined): CatalogTable {
  const all = slot.compiled.tables;
  const name = (tableId: string, fieldId: string) =>
    all.find((x) => x.id === tableId)?.fields.find((f) => f.id === fieldId)?.name ?? fieldId;
  const own = (fieldId: string) => name(t.id, fieldId);
  const field = (f: CompiledTable["fields"][number]): CatalogField => {
    const b = f as CompiledBaseField & {
      required?: true;
      min?: string;
      max?: string;
      values?: readonly string[];
    };
    return {
      name: f.name,
      type: f.type,
      description: f.description,
      ...(hasAliases(f) ? { aliases: [...f.aliases] } : {}),
      ...(b.required === true ? { required: true } : {}),
      ...("unit" in f ? { unit: f.unit.code } : {}),
      ...(b.min !== undefined ? { min: b.min } : {}),
      ...(b.max !== undefined ? { max: b.max } : {}),
      ...(b.values !== undefined ? { values: [...b.values] } : {}),
      ...("ref" in b && b.ref !== undefined
        ? {
            ref: {
              table: all.find((x) => x.id === b.ref.table)?.name ?? b.ref.table,
              target: b.ref.target,
            },
          }
        : {}),
      ...("precision" in f
        ? { precision: { scale: f.precision.scale, rounding: f.precision.rounding } }
        : {}),
    };
  };
  const base = {
    table: t.name,
    slot: slot.name,
    sv: slot.sv,
    timezone: slot.timezone,
    kind: t.kind,
    description: t.description,
    ...(hasAliases(t) ? { aliases: [...t.aliases] } : {}),
    fields: t.fields.map(field),
  };
  if (t.kind === "derived") {
    const r = (t as CompiledDerivedTable).rule;
    return {
      ...base,
      rule: {
        id: r.id,
        version: r.version,
        sql: sql ?? r.sql,
        time_dependency: r.time_dependency,
        depends_on: r.depends_on.map(
          (d) => `${all.find((x) => x.id === d.table)?.name ?? d.table}.${name(d.table, d.field)}`,
        ),
      },
    };
  }
  const time =
    t.time.type === "event"
      ? { type: "event" as const, field: own(t.time.field) }
      : t.time.type === "state"
        ? { type: "state" as const, granularity: t.time.granularity }
        : { type: "none" as const };
  return {
    ...base,
    time,
    ...(t.entity_key !== undefined ? { entity_key: t.entity_key.map(own) } : {}),
    ...(t.external_key !== undefined ? { external_key: t.external_key.map(own) } : {}),
    ...(t.duplicate_keys !== undefined
      ? { duplicate_keys: t.duplicate_keys.map((k) => k.map(own)) }
      : {}),
    ...(t.together !== undefined ? { together: t.together.map((k) => k.map(own)) } : {}),
  };
}

/** The slot's policy in effect (04-contract-types §8.2), names for IDs. */
async function policyOf(tx: ReadTx, slot: VisibleSlot): Promise<SlotPolicy> {
  const r = await tx.query<{ seq: unknown; at: string; actor: string; body: string | null }>(
    `SELECT e.seq, e.at, e.actor, c.body FROM slots s
     JOIN events e ON e.seq = s.policy_seq
     JOIN content c ON c.seq = e.seq AND c.path = 'policy'
     WHERE s.id = $1`,
    [slot.slot],
  );
  const [row] = r.rows;
  if (row === undefined || row.body === null)
    throw new ReadError("internal", "the slot's policy is missing");
  const p = JSON.parse(row.body) as PolicyBlock & Record<string, unknown>;
  const actor = (await actors(tx, [row.actor])).get(row.actor) as Actor;
  const op = await tx.query<{ op: unknown }>("SELECT op FROM events WHERE seq = $1", [
    Number(row.seq),
  ]);
  const tableName = (id: unknown) => slot.compiled.tables.find((x) => x.id === id)?.name ?? id;
  const high = Array.isArray(p["high_impact"]) ? (p["high_impact"] as Obj[]) : [];
  const only = Array.isArray(p["user_session_only"]) ? (p["user_session_only"] as unknown[]) : [];
  return {
    slot: slot.name,
    policy_version: p.policy_version,
    effective_value_rule: p.effective_value_rule,
    rank: p.rank,
    auto_apply: p.auto_apply,
    ...(high.length > 0
      ? { high_impact: high.map((h) => ({ ...h, table: tableName(get(h, "table")) })) }
      : {}),
    ...(only.length > 0 ? { user_session_only: only } : {}),
    set_by: actor,
    set_at: row.at,
    seq: Number(op.rows[0]?.op ?? row.seq),
  };
}

/**
 * `policy.get` (04-contract «policy.get», 04-contract-types §8.2): the policy in effect of one slot
 * the caller sees; `not_found` (`slot`) otherwise. Any credential with `saveslot.read` may call it.
 * No read record: what it gives is configuration, not a table's data (§8.3 lists what is recorded).
 */
export async function policyGetInTx(
  tx: ReadTx,
  input: { readonly visibility: Visibility; readonly params: unknown },
): Promise<SlotPolicy> {
  const params = input.params;
  if (!isObj(params)) throw invalid("malformed", "");
  for (const k of keysOf(params)) if (k !== "slot" && k !== "task") throw invalid("malformed", k);
  if (!has(params, "slot")) throw invalid("missing", "slot");
  const slot = slotNamed(get(params, "slot"), await visibleSlots(tx, input.visibility));
  return policyOf(tx, slot);
}

export async function catalogInTx(
  tx: ReadTx,
  input: CatalogInput,
): Promise<{ readonly result: CatalogResult; readonly entry: ReadEntry }> {
  const params = input.params;
  if (!isObj(params)) throw invalid("malformed", "");
  const level = has(params, "level") ? get(params, "level") : "list";
  if (level !== "list" && level !== "table" && level !== "schema")
    throw invalid("malformed", "level");
  const allowed = new Set(KEYS[level]);
  for (const k of keysOf(params)) if (!allowed.has(k)) throw invalid("malformed", k);
  const task = taskOf(params, input.task);
  const slots = await visibleSlots(tx, input.visibility);
  const latest = await logPosition(tx);
  const restore = await restoreCount(tx);
  let result: CatalogResult;
  let shown: VisibleSlot[];
  let tableIds: TableId[] = [];
  let draft: DraftId | undefined;

  if (level === "list") {
    const only = has(params, "slot") ? [slotNamed(get(params, "slot"), slots)] : slots;
    const ordered = [...only].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const items = ordered.flatMap((s) =>
      s.tables.map((t, i) => ({ item: { s, t }, keys: [s.name, i] as (string | number)[] })),
    );
    let limit = LIST_DEFAULT;
    if (has(params, "limit")) {
      const v = get(params, "limit");
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > LIST_MAX)
        throw invalid("malformed", "limit");
      limit = v;
    }
    const specs: KeySpec[] = [
      { type: "text", dir: "asc" },
      { type: "count", dir: "asc" },
    ];
    const identity = digest({
      level,
      slot: has(params, "slot") ? (only[0] as VisibleSlot).slot : null,
    });
    const position = await positionOf(tx, params, {
      identity,
      specs,
      restoreCount: restore,
      latest,
    });
    const { page, next } = pageAfter(items, {
      specs,
      identity,
      position,
      seq: position?.seq ?? latest,
      at: position?.at ?? input.now,
      restoreCount: restore,
      limit,
    });
    const bySlot = new Map<VisibleSlot, CompiledTable[]>();
    for (const { s, t } of page) bySlot.set(s, [...(bySlot.get(s) ?? []), t]);
    shown = [...bySlot.keys()];
    tableIds = page.map((x) => x.t.id as TableId);
    result = {
      level,
      total: items.length,
      ...(next !== undefined ? { next_position: next } : {}),
      slots: [...bySlot].map(([s, ts]) => ({
        slot: s.name,
        slot_id: s.slot,
        sv: s.sv,
        timezone: s.timezone,
        tables: ts.map((t) => ({
          table: t.name,
          kind: t.kind,
          description: t.description,
          ...(hasAliases(t) ? { aliases: [...t.aliases] } : {}),
        })),
      })),
    };
  } else if (level === "table") {
    if (!has(params, "tables")) throw invalid("missing", "tables");
    const v = get(params, "tables");
    if (!isDenseArray(v) || v.length === 0 || v.length > MAX_TABLES)
      throw invalid("malformed", "tables");
    const named = v.map((x, i) => resolveTable(x, `tables/${i}`, slots));
    const seen = new Set<string>();
    named.forEach((n, i) => {
      if (seen.has(n.table.id)) throw invalid("malformed", `tables/${i}`);
      seen.add(n.table.id);
    });
    const texts = new Map<SlotId, Map<string, string>>();
    for (const n of named) {
      if (n.table.kind === "derived" && !texts.has(n.slot.slot)) {
        texts.set(n.slot.slot, await ruleTextsOf(tx, n.slot.slot));
      }
    }
    shown = [...new Set(named.map((n) => n.slot))];
    tableIds = named.map((n) => n.table.id as TableId);
    const tables: CatalogTable[] = [];
    for (const n of named) {
      const profile = await profileOf(tx, n.table, input.scaleBounds ?? SCALE_BOUNDS);
      tables.push({
        ...tableOf(n.slot, n.table, texts.get(n.slot.slot)?.get(n.table.id)),
        ...(profile !== undefined ? { profile } : {}),
      });
    }
    result = { level, tables };
  } else {
    if (!has(params, "slot")) throw invalid("missing", "slot");
    const s = slotNamed(get(params, "slot"), slots);
    // A slot's schema document, its current one or a draft's, is the slot's schema as a whole:
    // given only with every table of it in range, else the slot is as not there (04-write-and-read
    // «可见范围»). Not the visible tables only: a derived rule's text names the tables it reads.
    if (!wholeSlot(s))
      throw new ReadError("not_found", "no such slot", { reason: "slot", param: "slot" });
    shown = [s];
    if (has(params, "draft")) {
      const id = get(params, "draft");
      if (typeof id !== "string" || !DRAFT_ID.test(id)) throw invalid("malformed", "draft");
      draft = id as DraftId;
      const d = await draftDocument(tx, s, id);
      if (d === undefined)
        throw new ReadError("not_found", "no such draft", { reason: "draft", param: "draft" });
      result = {
        level,
        slot: s.name,
        sv: d.sv,
        draft: id as DraftId,
        document: d.document,
        policy: await policyOf(tx, s),
      };
    } else {
      result = {
        level,
        slot: s.name,
        sv: s.sv,
        // From the current version's definition: drafts list only what they change.
        document: await slotDocument(tx, s),
        policy: await policyOf(tx, s),
      };
    }
  }

  const [one] = shown;
  const entry: ReadEntry = {
    read: input.read,
    actor: input.actor,
    task,
    at: input.now,
    pos: latest as never,
    operation: "catalog",
    // The self-check of a newly issued connection: by the task alone, as reported (06-cli §3.2).
    ...(task === SELFCHECK_TASK ? { selfcheck: true as const } : {}),
    ...(shown.length === 1 && one !== undefined ? { slot: one.slot, sv: one.sv } : {}),
    // The level and the opaque IDs read, no names (04-write-and-read «读取记录里记什么形状»).
    shape: canonicalize({
      level,
      slots: shown.map((x) => x.slot as string).sort(),
      tables: [...tableIds].sort(),
      ...(draft !== undefined ? { draft } : {}),
    }),
    rows: [],
    coarse: [],
    lastRead: shown.map((x) => ({
      kind: "sv" as const,
      target: x.slot,
      op: x.sv,
      restoreCount: 0,
    })),
  };
  return { result, entry };
}
