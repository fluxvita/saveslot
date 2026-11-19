// `schema_draft`, the path creating a slot (docs/zh-CN/spec/04-contract.md §10 `schema_draft`;
// 04-contract-types.md §5.3; 03-data-model/01-objects.md «建 slot»; 09-event-format.md §4.5, §5.4,
// §5.5): a v1 document compiled and applied at once, in one operation of five events — submitted,
// compiled (`applied`), confirmed (`auto`), the default policy, switched.
//
// In this version only a new slot: a draft changing a slot (`base_version` not null) is
// `not_in_this_version`. Derived tables are created with the slot, except those whose rule this
// version does not evaluate (`not_in_this_version` on the table's `rule`). A document with an
// external key compiles, but apply cannot build it yet, so it stops here (internal
// `not_implemented`) before anything is logged.
//
// The slot ID, the draft ID and the next free table and rule numbers are read and used in the same
// write transaction: the store has one writer, so two slots never take the same numbers.
// Idempotency is the write's (04-contract §14): a request key over the request's canonical text,
// or an explicit `idempotency_key` with the content's fingerprint; a hit replays the receipt from
// the log. Nothing is recorded as read: a write after it falls back to the receipt's version on
// the write side.

import { createHash } from "node:crypto";
import type {
  CompiledSchema,
  DraftId,
  JsonValue,
  SchemaChangeRecord,
  SlotId,
} from "@fluxvita/saveslot-contract-core";
import { canonicalize } from "@fluxvita/saveslot-contract-core";
import { ApplyError, applyEvents, eventsOf } from "../apply/index.ts";
import { appendOperation, type NewEvent } from "../log/index.ts";
import { evaluationRefusal, loadRsql, RULESET_VERSION } from "../rules/index.ts";
import {
  compiledWarnings,
  compileNewSlot,
  DEFAULT_SLOT_POLICY,
  filledDocument,
} from "../schema/index.ts";
import type { ReadTx, TenantStore } from "../store/ports.ts";
import { todayIn } from "../write/index.ts";
import type { OpsContext, Visibility } from "./context.ts";
import { randomCrockford } from "./ids.ts";

/** An error of `schema_draft`, by contract error code (04-contract-types §9). */
export class SchemaDraftError extends Error {
  override readonly name = "SchemaDraftError";
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/** 04-contract-types §5.3 `SchemaChange`: the logged change record, its target by names. */
export interface SchemaChange extends Omit<SchemaChangeRecord, "target"> {
  readonly target:
    | { readonly slot: true }
    | { readonly table: string; readonly field?: string; readonly rule?: true };
}

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

const PARAM_KEYS = new Set(["document", "task", "idempotency_key"]);
const MAX_TAG_CHARS = 256;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

const own = (o: object, k: string) => Object.hasOwn(o, k);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const invalid = (reason: string, param: string) =>
  new SchemaDraftError("invalid_argument", `${param}: ${reason}`, { reason, param });

/** `task` / `idempotency_key`: as the write takes them (at most 256 characters, no control characters). */
function tag(params: Record<string, unknown>, key: string): string | undefined {
  if (!own(params, key)) return undefined;
  const v = params[key];
  if (
    typeof v !== "string" ||
    v.length === 0 ||
    !v.isWellFormed() ||
    [...v].length > MAX_TAG_CHARS ||
    CONTROL.test(v)
  )
    throw invalid("malformed", key);
  return v;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const newSlotId = (): `sl_${string}` => `sl_${randomCrockford(16)}`;
const newDraftId = (): DraftId => `d_${randomCrockford(16)}`;

/**
 * A slot ID never used in the tenant: not a slot's now, nor a removed slot's (its versions stay,
 * process/decisions/remove-empty-slot.md §4), so that the log's events of a slot always mean it.
 */
async function unusedSlotId(tx: ReadTx): Promise<`sl_${string}`> {
  for (;;) {
    const id = newSlotId();
    const r = await tx.query(
      `SELECT 1 FROM slots WHERE id = $1 UNION ALL SELECT 1 FROM schema_versions WHERE slot_id = $1`,
      [id],
    );
    if (r.rows.length === 0) return id;
  }
}

/** The highest number of an ID like `t12` / `r3` among `ids`. */
const highest = (ids: readonly string[], prefix: string) =>
  Math.max(
    0,
    ...ids.filter((x) => x.startsWith(prefix)).map((x) => Number(x.slice(prefix.length))),
  );

/** The slot names in use, and the next free table and rule numbers of the tenant (any version). */
async function numbering(tx: ReadTx) {
  const names = await tx.query<{ name: string }>("SELECT name FROM slots");
  const compiled = await tx.query<{ body: string | null }>(
    `SELECT c.body FROM schema_versions v
     JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'`,
  );
  const tables: string[] = [];
  const rules: string[] = [];
  for (const x of compiled.rows) {
    if (x.body === null) continue;
    const c = JSON.parse(x.body) as CompiledSchema;
    for (const t of c.tables) {
      tables.push(t.id);
      if (t.kind === "derived") rules.push(t.rule.id);
    }
  }
  return {
    existingSlotNames: names.rows.map((x) => x.name),
    nextTableNumber: highest(tables, "t") + 1,
    nextRuleNumber: highest(rules, "r") + 1,
  };
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
  const name = (id: string) => compiled.tables.find((t) => t.id === id)?.name ?? id;
  return {
    draft,
    slot: compiled.name,
    slot_id: compiled.slot,
    target_sv: 1,
    document: filledDocument(document, compiled),
    // Names for IDs (09 §5.5: the event's `changes` hold IDs).
    changes: changes.map((c) => ({
      ...c,
      target: "table" in c.target ? { ...c.target, table: name(c.target.table) } : c.target,
    })),
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
): Promise<SchemaDraftReceipt> {
  if (!isObject(params)) throw invalid("malformed", "");
  for (const k of Object.keys(params)) if (!PARAM_KEYS.has(k)) throw invalid("malformed", k);
  const task = tag(params, "task") ?? ctx.task;
  const explicit = tag(params, "idempotency_key");
  if (!own(params, "document")) throw invalid("missing", "document");
  const document = params["document"];
  // A draft changing a slot: not in this version (07-scope: schema changes are P4).
  if (isObject(document) && own(document, "base_version") && document["base_version"] !== null)
    throw new SchemaDraftError("not_in_this_version", "a draft changing a slot", {
      reason: "parameter",
      param: "base_version",
    });
  if (!mayCreateSlot(ctx.visibility))
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
      return replay(tx, Number(hit.op));
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
      if (e.code === "invalid_argument") throw invalid(e.reason, e.param);
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
    // depending on today, one calling saveslot_date, a decimal group key that may have more
    // places than its scale (evaluationRefusal, which apply checks again); an external key.
    compiled.tables.forEach((t, i) => {
      if (t.kind === "derived") {
        const refusal = evaluationRefusal(compiled, t.id);
        if (refusal !== undefined)
          throw new SchemaDraftError(
            "not_in_this_version",
            `a derived rule of this kind is not evaluated in this version: ${refusal.kind}`,
            { reason: "parameter", param: `tables/${i}/rule` },
          );
      } else if ("external_key" in t && t.external_key !== undefined)
        throw new SchemaDraftError("internal", "an external key is not applied yet", {
          reason: "not_implemented",
          param: `tables/${i}/external_key`,
        });
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
        throw new SchemaDraftError("internal", "the slot could not be applied", {
          reason: e.reason,
        });
      throw e;
    }
    return receiptOf(draft, document as JsonValue, compiled, result.changes, false);
  });
}
