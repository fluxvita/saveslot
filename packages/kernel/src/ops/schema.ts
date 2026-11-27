import type {
  CompiledSchema,
  DraftId,
  JsonValue,
  SchemaChangeRecord,
  SlotId,
} from "@fluxvita/saveslot-contract-core";
import { canonicalize } from "@fluxvita/saveslot-contract-core";
import { ApplyError, applyEvents, eventsOf, internalDetailOf } from "../apply/index.ts";
import {
  appendOperation,
  type EffectSlot,
  type NewEvent,
  noteEffect,
  restoresAt,
  restoresOf,
} from "../log/index.ts";
import { evaluationRefusal, loadRsql, RULESET_VERSION } from "../rules/index.ts";
import {
  changesByName,
  compiledWarnings,
  compileNewSlot,
  DEFAULT_SLOT_POLICY,
  filledDocument,
} from "../schema/index.ts";
import type { ReadTx, TenantStore } from "../store/ports.ts";
import { todayIn } from "../write/index.ts";
import type { OpsContext, Visibility } from "./context.ts";
import { draftChangeInTx, replayChange, type SchemaChangeReceipt } from "./schema-change.ts";
import {
  invalid,
  isObject,
  newDraftId,
  numbering,
  own,
  PARAM_KEYS,
  type SchemaChange,
  SchemaDraftError,
  sha256,
  tag,
  unusedSlotId,
} from "./schema-common.ts";

export type { SchemaChangeReceipt } from "./schema-change.ts";
export { type SchemaChange, SchemaDraftError } from "./schema-common.ts";

export interface SchemaDraftReceipt {
  readonly draft: DraftId;
  readonly slot: string;
  readonly slot_id: SlotId;
  readonly target_sv: 1;
  /** The document with IDs and inferences filled in (04-contract-types §5.3 `SchemaDocument`). */
  readonly document: Readonly<Record<string, unknown>>;
  readonly changes: readonly SchemaChange[];
  readonly impact: {
    readonly rows_affected: 0;
    readonly derived_changed: readonly never[];
    readonly consumers: readonly never[];
  };
  readonly outcome: "applied";
  readonly sv: 1;
  readonly replayed?: true;
  /** 04-contract-types §7 `Warning`: the code and the table it is about. */
  readonly warnings?: readonly ReturnType<typeof compiledWarnings>[number][];
}

/**
 * Whether the caller may create a slot: only one whose slot range is all slots (04-contract §10
 * `schema_draft`, «新建 slot»). The point where the service layer's scopes plug in later.
 */
export function mayCreateSlot(visibility: Visibility): boolean {
  return visibility.kind === "all";
}

/** The receipt of a slot's creation, from what was logged (the same for a write and a replay). */
function receiptOf(
  draft: DraftId,
  document: JsonValue,
  compiled: CompiledSchema,
  changes: readonly SchemaChangeRecord[],
  replayed: boolean,
): SchemaDraftReceipt {
  const warnings = compiledWarnings(compiled);
  return {
    draft,
    slot: compiled.name,
    slot_id: compiled.slot,
    target_sv: 1,
    document: filledDocument(document, compiled),
    // Names for IDs (09 §5.5: the event's `changes` hold IDs).
    changes: changesByName(changes, compiled, compiled),
    impact: { rows_affected: 0, derived_changed: [], consumers: [] },
    outcome: "applied",
    sv: 1,
    ...(replayed ? { replayed: true as const } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** The receipt of an earlier creation, read back from its operation's events. */
async function replay(tx: ReadTx, op: number): Promise<SchemaDraftReceipt> {
  const r = await tx.query<{ type: string; path: string; body: string | null }>(
    `SELECT e.type, c.path, c.body FROM events e JOIN content c ON c.seq = e.seq
     WHERE e.op = $1 AND e.type IN ('schema.draft_submitted', 'schema.compiled')`,
    [op],
  );
  const block = (type: string, path: string) => {
    const x = r.rows.find((y) => y.type === type && y.path === path);
    return x?.body == null ? undefined : (JSON.parse(x.body) as JsonValue);
  };
  const target = block("schema.draft_submitted", "target") as { draft_id: DraftId } | undefined;
  const document = block("schema.draft_submitted", "draft");
  const compiled = block("schema.compiled", "compiled") as unknown as CompiledSchema | undefined;
  const changes = block("schema.compiled", "changes") as unknown as
    | SchemaChangeRecord[]
    | undefined;
  if (
    target === undefined ||
    document === undefined ||
    compiled === undefined ||
    changes === undefined
  )
    throw new SchemaDraftError("internal", "the slot's creation is not in the log as written");
  return receiptOf(target.draft_id, document, compiled, changes, true);
}

export async function schemaDraft(
  store: TenantStore,
  ctx: OpsContext,
  params: unknown,
): Promise<SchemaDraftReceipt | SchemaChangeReceipt> {
  if (!isObject(params)) throw invalid("malformed", "");
  for (const k of Object.keys(params)) if (!PARAM_KEYS.has(k)) throw invalid("malformed", k);
  const task = tag(params, "task") ?? ctx.task;
  const explicit = tag(params, "idempotency_key");
  if (!own(params, "document")) throw invalid("missing", "document");
  const document = params["document"];
  // A draft changing a slot: its slot must be in range, which ./schema-change.ts checks.
  const changing =
    isObject(document) && own(document, "base_version") && document["base_version"] !== null;
  if (!changing && !mayCreateSlot(ctx.visibility))
    throw new SchemaDraftError("insufficient_scope", "creating a slot needs every slot in range", {
      required_scope: "all_slots",
    });
  let content: string;
  try {
    const rest: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(params))
      if (k !== "task" && k !== "idempotency_key") rest[k] = params[k];
    content = canonicalize(rest as JsonValue);
  } catch {
    throw invalid("malformed", "document");
  }
  // Rules are compiled by the restricted SQL parser: loaded only when the document has them.
  const tables = isObject(document) && Array.isArray(document["tables"]) ? document["tables"] : [];
  if (tables.some((t) => isObject(t) && own(t, "rule"))) await loadRsql();

  return store.write(async (tx) => {
    // The request key, as the write's (04-contract §14).
    const key =
      explicit !== undefined
        ? sha256(canonicalize(["idempotency", ctx.actor, explicit]))
        : sha256(canonicalize([ctx.actor, task ?? null, content]));
    const fingerprint = explicit !== undefined ? sha256(content) : undefined;
    const window = explicit !== undefined ? ctx.idempotency_key_window : ctx.idempotency_window;
    const since = new Date(Date.parse(ctx.now) - window).toISOString();
    const hit = (
      await tx.query<{ op: unknown; fingerprint: string | null }>(
        "SELECT op, fingerprint FROM request_keys WHERE key = $1 AND at >= $2",
        [key, since],
      )
    ).rows[0];
    if (hit !== undefined) {
      if (explicit !== undefined && hit.fingerprint !== fingerprint)
        throw new SchemaDraftError(
          "invalid_argument",
          "the idempotency key was used for another request",
          {
            reason: "idempotency_key_reuse",
            param: "idempotency_key",
          },
        );
      const kind = await tx.query<{ body: string | null }>(
        `SELECT c.body FROM events e JOIN content c ON c.seq = e.seq AND c.path = 'target'
         WHERE e.op = $1 AND e.type = 'schema.draft_submitted'`,
        [Number(hit.op)],
      );
      const created = (JSON.parse(kind.rows[0]?.body ?? "{}") as { creates_slot?: boolean })
        .creates_slot;
      // Sent again: the first submission's result, a replay of its operation.
      return noteEffect(
        created === false
          ? await replayChange(tx, Number(hit.op), true)
          : await replay(tx, Number(hit.op)),
        { effect: "replayed", seq: Number(hit.op), restores: await restoresAt(tx, Number(hit.op)) },
      );
    }
    if (changing) {
      const slot: EffectSlot = {};
      const changed = await draftChangeInTx(tx, ctx, {
        effect: slot,
        document: document as Record<string, unknown>,
        task: task ?? null,
        key:
          explicit !== undefined
            ? { idempotency: { key, fingerprint: fingerprint as string } }
            : { request_key: { key } },
      });
      return slot.effect === undefined
        ? changed
        : noteEffect(changed, { ...slot.effect, restores: await restoresOf(store, tx) });
    }

    const slotId = await unusedSlotId(tx);
    const result = compileNewSlot({ document, slotId: slotId as never, ...(await numbering(tx)) });
    if (!result.ok) {
      const e = result.error;
      if (e.code === "validation_failed")
        throw new SchemaDraftError("validation_failed", "the document does not compile", {
          reason: "schema",
          details: e.details,
        });
      if (e.code === "invalid_argument") {
        const { code: _, reason, param, ...extra } = e;
        throw invalid(reason, param, extra);
      }
      if (e.code === "not_in_this_version")
        throw new SchemaDraftError("not_in_this_version", "not in this version", {
          reason: "parameter",
          param: e.param,
        });
      throw new SchemaDraftError("internal", `${e.what} is not implemented`, {
        reason: "not_implemented",
        param: e.param,
      });
    }
    const compiled = result.compiled;
    // What this version does not evaluate or build stops here, before anything is logged: a rule
    // calling saveslot_date, a decimal group key that may have more places than its scale
    // (evaluationRefusal, which apply checks again).
    compiled.tables.forEach((t, i) => {
      if (t.kind === "derived") {
        const refusal = evaluationRefusal(compiled, t.id);
        if (refusal !== undefined)
          throw new SchemaDraftError(
            "not_in_this_version",
            `a derived rule of this kind is not evaluated in this version: ${refusal.kind}`,
            { reason: "parameter", param: `tables/${i}/rule` },
          );
      }
    });

    const draft = newDraftId();
    const policy = DEFAULT_SLOT_POLICY;
    const events: NewEvent[] = [
      {
        type: "schema.draft_submitted",
        slot: slotId,
        blocks: {
          ctx: {
            now: ctx.now,
            today: todayIn(ctx.now, compiled.timezone),
            ruleset_version: RULESET_VERSION,
            policy_version: policy.policy_version,
          },
          ...(task !== null ? { task } : {}),
          ...(explicit !== undefined
            ? { idempotency: { key, fingerprint: fingerprint as string } }
            : { request_key: { key } }),
          target: { draft_id: draft, creates_slot: true },
          draft: document as JsonValue,
        },
      },
      {
        type: "schema.compiled",
        slot: slotId,
        blocks: {
          target: { draft_id: draft, target_version: 1, outcome: "applied" },
          compiled: compiled as unknown as JsonValue,
          changes: result.changes as unknown as JsonValue,
        },
      },
      {
        type: "schema.confirmed",
        slot: slotId,
        blocks: { target: { draft_id: draft, target_version: 1, by: "auto" } },
      },
      { type: "slot.policy_set", slot: slotId, blocks: { policy: policy as unknown as JsonValue } },
      {
        type: "schema.switched",
        slot: slotId,
        blocks: { target: { draft_id: draft, to_version: 1, rebuilt_tables: [] } },
      },
    ];
    const op = await appendOperation(tx, {
      actor: ctx.actor as never,
      now: ctx.now as never,
      events,
    });
    try {
      await applyEvents(tx, eventsOf(op));
    } catch (e) {
      if (e instanceof ApplyError)
        throw new SchemaDraftError(
          "internal",
          "the slot could not be applied",
          internalDetailOf(e),
        );
      throw e;
    }
    return noteEffect(receiptOf(draft, document as JsonValue, compiled, result.changes, false), {
      effect: "appended",
      seq: op.op,
      restores: await restoresOf(store, tx),
    });
  });
}
