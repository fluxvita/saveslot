// `schema_draft` for an existing slot (docs/zh-CN/spec/04-contract.md §10 `schema_draft`;
// 03-data-model/07-schema-evolution.md «schema 文档格式»; 08-schema-migration.md «状态机»;
// 09-event-format.md §4.5, §5.5, §5.8): the draft compiled against the slot's current version and
// either applied at once, when the slot's policy makes every change of it automatic, or left
// pending as a `schema_change` item.
//
// One operation (§4.5): `schema.draft_submitted`; when the slot has a draft still awaiting
// confirmation, `schema.superseded` with that draft's item's `item.superseded` (`draft_replaced`);
// `schema.compiled`; then, applied at once, `schema.confirmed` (`auto`) and `schema.switched` (no
// table rebuilt: the changes compiled in this version touch the catalog only), else
// `item.created` (`schema_change`). An automatic change never drops a field, so the switch here
// never brings a `premise.changed` (§5.10).
//
// The version number is the slot's next one not used by any version in the log (09 §5.5: a number
// taken by a draft is not used again, rejected and superseded ones included), so `sv` may skip.
//
// "Nobody else uses it" (`rename_unused`) is not computed in this version: every table and field
// counts as used, so a rename always waits for confirmation, and the receipt's impact gives no
// `consumers` (an empty list would say nobody uses it).

import type {
  CompiledSchema,
  DraftId,
  JsonValue,
  SchemaChangeRecord,
  SlotId,
} from "@fluxvita/saveslot-contract-core";
import { ApplyError, applyEvents, eventsOf, internalDetailOf } from "../apply/index.ts";
import { appendOperation, type NewEvent, readTail } from "../log/index.ts";
import { itemVer } from "../pending/index.ts";
import { formerVersions, ruleTextsOf, visibleSlots } from "../read/index.ts";
import { restoreCount } from "../read/select.ts";
import { RULESET_VERSION } from "../rules/index.ts";
import { compileChange, compiledWarnings, filledDocument } from "../schema/index.ts";
import type { ReadTx, TenantStore } from "../store/ports.ts";
import { todayIn } from "../write/index.ts";
import type { OpsContext } from "./context.ts";
import { randomCrockford } from "./ids.ts";
import {
  invalid,
  newDraftId,
  numbering,
  type SchemaChange,
  SchemaDraftError,
} from "./schema-common.ts";

/** The receipt of a draft changing a slot, left pending (04-contract-types §5.3 `SchemaDraftResult`). */
export interface SchemaChangeReceipt {
  readonly draft: DraftId;
  readonly slot: string;
  readonly slot_id: SlotId;
  readonly target_sv: number;
  readonly document: Readonly<Record<string, unknown>>;
  readonly changes: readonly SchemaChange[];
  /** No `consumers`: not computed in this version. */
  readonly impact: { readonly rows_affected: 0; readonly derived_changed: readonly never[] };
  readonly outcome: "applied" | "pending";
  /** `applied`: the version switched to. */
  readonly sv?: number;
  /** `pending`: the item; this receipt counts as reading it. */
  readonly item?: { readonly id: `pi_${string}`; readonly item_ver: string };
  readonly superseded_draft?: DraftId;
  readonly replayed?: true;
  /** 04-contract-types §7 `Warning`: of the tables this draft adds. */
  readonly warnings?: readonly ReturnType<typeof compiledWarnings>[number][];
}

const newItemId = (): `pi_${string}` => `pi_${randomCrockford(16)}`;

/** The changes by names: tables and fields of the version they are in. */
function byNames(
  changes: readonly SchemaChangeRecord[],
  next: CompiledSchema,
  before: CompiledSchema,
): SchemaChange[] {
  const table = (id: string) =>
    next.tables.find((t) => t.id === id) ?? before.tables.find((t) => t.id === id);
  return changes.map((c) => {
    if (!("table" in c.target)) return { ...c, target: c.target };
    const t = table(c.target.table);
    const name = t?.name ?? c.target.table;
    if ("field" in c.target) {
      const f = t?.fields.find((x) => x.id === (c.target as { field: string }).field);
      return { ...c, target: { table: name, field: f?.name ?? c.target.field } };
    }
    return { ...c, target: "rule" in c.target ? { table: name, rule: true } : { table: name } };
  });
}

async function compiledOf(tx: ReadTx, slot: string, sv: number): Promise<CompiledSchema> {
  const r = await tx.query<{ body: string | null }>(
    `SELECT c.body FROM schema_versions v JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
     WHERE v.slot_id = $1 AND v.sv = $2`,
    [slot, sv],
  );
  const body = r.rows[0]?.body;
  if (body == null) throw new SchemaDraftError("internal", `no version ${sv} of ${slot}`);
  return JSON.parse(body) as CompiledSchema;
}

/** The receipt, from the events of the operation that submitted the draft (written and replayed alike). */
async function receiptOf(tx: ReadTx, op: number, replayed: boolean): Promise<SchemaChangeReceipt> {
  const r = await tx.query<{ type: string; path: string; body: string | null }>(
    `SELECT e.type, c.path, c.body FROM events e JOIN content c ON c.seq = e.seq
     WHERE e.op = $1 AND e.type IN ('schema.draft_submitted', 'schema.compiled', 'schema.superseded', 'item.created')`,
    [op],
  );
  const block = (type: string, path: string) => {
    const x = r.rows.find((y) => y.type === type && y.path === path);
    return x?.body == null ? undefined : (JSON.parse(x.body) as JsonValue);
  };
  const submitted = block("schema.draft_submitted", "target") as
    | { draft_id: DraftId; base_version: number }
    | undefined;
  const document = block("schema.draft_submitted", "draft");
  const compiled = block("schema.compiled", "compiled") as unknown as CompiledSchema | undefined;
  const changes = block("schema.compiled", "changes") as unknown as
    | SchemaChangeRecord[]
    | undefined;
  const item = block("item.created", "target") as { item: `pi_${string}` } | undefined;
  const superseded = block("schema.superseded", "target") as { draft_id: DraftId } | undefined;
  if (
    submitted === undefined ||
    document === undefined ||
    compiled === undefined ||
    changes === undefined
  )
    throw new SchemaDraftError("internal", "the draft is not in the log as written");
  const before = await compiledOf(tx, compiled.slot, submitted.base_version);
  // From the logged definition, so a replay gives the same: the warnings of the tables it adds.
  const added = new Set(
    changes.flatMap((c) =>
      c.change === "add_table" && "table" in c.target ? [c.target.table] : [],
    ),
  );
  const warnings = compiledWarnings({
    ...compiled,
    tables: compiled.tables.filter((t) => added.has(t.id)),
  });
  return {
    draft: submitted.draft_id,
    slot: before.name,
    slot_id: compiled.slot,
    target_sv: compiled.sv,
    // On the version the slot is at, as it was submitted: changed and submitted again as it is.
    document: filledDocument(document, compiled, submitted.base_version),
    changes: byNames(changes, compiled, before),
    impact: { rows_affected: 0, derived_changed: [] },
    ...(item !== undefined
      ? {
          outcome: "pending" as const,
          item: { id: item.item, item_ver: itemVer(item.item, op, await restoreCount(tx)) },
        }
      : { outcome: "applied" as const, sv: compiled.sv }),
    ...(superseded !== undefined ? { superseded_draft: superseded.draft_id } : {}),
    ...(replayed ? { replayed: true as const } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export { receiptOf as replayChange };

/**
 * The draft changing an existing slot, in the caller's write transaction: `document` is an object
 * whose `base_version` is not null; the request key was looked up already (no hit).
 */
export async function draftChangeInTx(
  tx: Parameters<Parameters<TenantStore["write"]>[0]>[0],
  ctx: OpsContext,
  input: {
    readonly document: Readonly<Record<string, unknown>>;
    readonly task: string | null;
    readonly key: Readonly<Record<string, JsonValue>>;
  },
): Promise<SchemaChangeReceipt> {
  const { document } = input;
  const name = document["slot"];
  if (typeof name !== "string") throw invalid("malformed", "slot");
  const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const slot = (await visibleSlots(tx, ctx.visibility)).find((s) => fold(s.name) === fold(name));
  if (slot === undefined)
    throw new SchemaDraftError("not_found", `no slot ${name}`, { reason: "slot", param: "slot" });
  if (slot.tables.length !== slot.compiled.tables.length)
    throw new SchemaDraftError(
      "insufficient_scope",
      "changing a slot's schema needs every table of it in range",
      {
        required_scope: "all_slots",
      },
    );
  const current = slot.compiled;

  // In this order (04-contract «schema_draft»): the form of base_version, then a draft written on
  // another version, then a migration running; the rest is the compiler's.
  if (!Object.hasOwn(document, "base_version")) throw invalid("missing", "base_version");
  const bv = document["base_version"];
  if (typeof bv !== "number" || !Number.isSafeInteger(bv) || bv < 1)
    throw invalid("malformed", "base_version");
  if (bv !== current.sv)
    throw new SchemaDraftError("draft_outdated", "base_version is not the current version", {
      reason: "base_version",
      current_sv: current.sv,
    });
  // One change at a time (08 «状态机»): a migration still running refuses the draft.
  const migrating = await tx.query<{ target_sv: unknown }>(
    "SELECT target_sv FROM migrations WHERE slot_id = $1 AND state NOT IN ('switched', 'failed')",
    [slot.slot],
  );
  const running = migrating.rows[0];
  if (running !== undefined)
    throw new SchemaDraftError("draft_outdated", "a migration of the slot is running", {
      reason: "migrating",
      current_sv: current.sv,
      migration: { target_sv: Number(running.target_sv), state: "building" },
    });

  // The slot's policy (its `slot.policy_set`), the next version number, the names still resolvable.
  const policyRow = await tx.query<{ body: string | null; policy_version: unknown }>(
    `SELECT c.body, s.policy_version FROM slots s JOIN content c ON c.seq = s.policy_seq AND c.path = 'policy'
     WHERE s.id = $1`,
    [slot.slot],
  );
  const policy = JSON.parse(policyRow.rows[0]?.body ?? "{}") as { auto_apply?: string[] };
  const policyVersion = Number(policyRow.rows[0]?.policy_version);
  const top = await tx.query<{ sv: unknown }>(
    "SELECT max(sv) AS sv FROM schema_versions WHERE slot_id = $1",
    [slot.slot],
  );
  const targetVersion = Number(top.rows[0]?.sv) + 1;
  const former = (await formerVersions(tx, [slot.slot])).get(slot.slot) ?? [];
  const tableNames: string[] = [];
  const fieldNames = new Map<string, string[]>();
  for (const old of former) {
    for (const t of old.tables) {
      tableNames.push(t.name);
      fieldNames.set(t.id, [...(fieldNames.get(t.id) ?? []), ...t.fields.map((f) => f.name)]);
    }
  }
  const { existingSlotNames, nextTableNumber } = await numbering(tx);

  const result = compileChange({
    document,
    current,
    existingSlotNames,
    nextTableNumber,
    autoApply: policy.auto_apply ?? [],
    unused: () => false,
    targetVersion,
    formerNames: { tables: tableNames, fields: fieldNames },
    ruleTexts: await ruleTextsOf(tx, slot.slot),
  });
  if (!result.ok) {
    const e = result.error;
    switch (e.code) {
      case "validation_failed":
        throw new SchemaDraftError("validation_failed", "the document does not compile", {
          reason: "schema",
          details: e.details,
        });
      case "invalid_argument": {
        const { code: _, reason, param, ...extra } = e;
        throw invalid(reason, param, extra);
      }
      case "not_in_this_version":
        throw new SchemaDraftError("not_in_this_version", "not in this version", {
          reason: "parameter",
          param: e.param,
        });
      case "field_unmatched":
        throw new SchemaDraftError(
          "field_unmatched",
          "a field of the current version is neither in the draft nor dropped",
          { fields: e.fields },
        );
      case "draft_outdated":
        throw new SchemaDraftError("draft_outdated", "base_version is not the current version", {
          reason: "base_version",
          current_sv: e.current_sv,
        });
      default:
        throw new SchemaDraftError("internal", `${e.what} is not implemented`, {
          reason: "not_implemented",
          param: e.param,
        });
    }
  }
  // A draft that changes nothing: no version for it (04-contract «schema_draft»).
  if (result.changes.length === 0) throw invalid("no_change", "document");

  // The slot's draft still awaiting confirmation, if any: its item.
  const open = await tx.query<{ id: string; body: string | null }>(
    `SELECT i.id, c.body FROM pending_items i
     JOIN events e ON e.type = 'item.created' AND e.slot = i.slot_id
     JOIN content c ON c.seq = e.seq AND c.path = 'target'
     WHERE i.slot_id = $1 AND i.type = 'schema_change' AND i.state = 'open'`,
    [slot.slot],
  );
  const older = open.rows
    .map((x) => ({ item: x.id, target: JSON.parse(x.body ?? "{}") as Record<string, unknown> }))
    .find((x) => x.target["item"] === x.item);

  const draft = newDraftId();
  const item = newItemId();
  const next = ((await readTail(tx))?.seq ?? 0) + 1;
  const events: NewEvent[] = [
    {
      type: "schema.draft_submitted",
      slot: slot.slot,
      blocks: {
        ctx: {
          now: ctx.now,
          today: todayIn(ctx.now, current.timezone),
          ruleset_version: RULESET_VERSION,
          policy_version: policyVersion,
        },
        ...(input.task !== null ? { task: input.task } : {}),
        ...input.key,
        target: { draft_id: draft, creates_slot: false, base_version: current.sv },
        draft: document as JsonValue,
      },
    },
  ];
  if (older !== undefined) {
    events.push(
      {
        type: "schema.superseded",
        slot: slot.slot,
        blocks: { target: { draft_id: older.target["draft"] as JsonValue, by_draft: draft } },
      },
      {
        type: "item.superseded",
        slot: slot.slot,
        blocks: {
          target: { item: older.item, reason: "draft_replaced", by_event: next + 1 },
        },
      },
    );
  }
  events.push({
    type: "schema.compiled",
    slot: slot.slot,
    blocks: {
      target: {
        draft_id: draft,
        target_version: result.targetVersion,
        outcome: result.outcome,
      },
      compiled: result.compiled as unknown as JsonValue,
      changes: result.changes as unknown as JsonValue,
    },
  });
  if (result.outcome === "applied")
    events.push(
      {
        type: "schema.confirmed",
        slot: slot.slot,
        blocks: {
          target: { draft_id: draft, target_version: result.targetVersion, by: "auto" },
        },
      },
      {
        type: "schema.switched",
        slot: slot.slot,
        blocks: {
          target: {
            draft_id: draft,
            from_version: current.sv,
            to_version: result.targetVersion,
            rebuilt_tables: [],
          },
        },
      },
    );
  else
    events.push({
      type: "item.created",
      slot: slot.slot,
      blocks: {
        target: {
          item,
          type: "schema_change",
          reason: "schema_change",
          ruleset_version: RULESET_VERSION,
          policy_version: policyVersion,
          draft,
        },
      },
    });
  const op = await appendOperation(tx, {
    actor: ctx.actor as never,
    now: ctx.now as never,
    events,
  });
  try {
    await applyEvents(tx, eventsOf(op));
  } catch (e) {
    if (e instanceof ApplyError)
      throw new SchemaDraftError("internal", "the draft could not be applied", internalDetailOf(e));
    throw e;
  }
  return receiptOf(tx, next, false);
}
