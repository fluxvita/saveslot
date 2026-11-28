// The call context of every `ops` entry (docs/zh-CN/spec/02-architecture.md §4
// «`ops` 的调用上下文»).
//
// The context is the boundary between the kernel and the service layer (later an SDK host, possibly
// across a process boundary): it is frozen, and it is plain JSON, so it crosses a process as is.
// Fields the spec calls nullable are `null` rather than absent, so a context and its JSON text map
// one to one.

import {
  type Instant,
  isEventInteger,
  isId,
  isInstant,
  type OpNumber,
  type PrincipalId,
  type SlotId,
  type TableId,
  type TenantId,
} from "@fluxvita/saveslot-contract-core";

/** The background tasks that run as internal operations (§4 «契约操作与内部操作»). */
export const INTERNAL_OPERATIONS = [
  "openTenant",
  "flushReads",
  "expireDeletions",
  "purgeResidue",
  "pruneReads",
  "migrationStep",
  "advanceHighWater",
  "closeTenant",
  "revokeOnRefreshReplay",
] as const;
export type InternalOperation = (typeof INTERNAL_OPERATIONS)[number];

/** What the caller may see: everything, or a whitelist of slot → table → field. */
export type Visibility =
  | { readonly kind: "all" }
  | { readonly kind: "scoped"; readonly slots: readonly VisibleSlot[] };

export interface VisibleSlot {
  readonly slot: SlotId;
  /** Absent: every table of the slot. */
  readonly tables?: readonly VisibleTable[];
}

export interface VisibleTable {
  readonly table: TableId;
  /** Absent: every field. Not implemented: a context that lists fields is refused. */
  readonly fields?: readonly string[];
}

/** The confirmation a caller brings back when resolving an item. */
export interface Confirmation {
  /** The item version confirmed: the operation number of the item's content and the restore count. */
  readonly item_op: OpNumber;
  readonly restore_count: number;
  /** Filled by the surface. */
  readonly via: "call" | "elicitation";
}

export interface OpsContext {
  readonly tenant: TenantId;
  /** The authenticated principal; `system` for internal operations. */
  readonly actor: PrincipalId;
  /** Which background task: exactly on internal operations (`actor` is `system`). */
  readonly trigger: InternalOperation | null;
  /** Self-reported task identifier. */
  readonly task: string | null;
  readonly visibility: Visibility;
  /**
   * Idempotency windows in milliseconds (a service-layer policy): of the request keys the kernel
   * computes from the request, and of the explicit idempotency keys callers give.
   */
  readonly idempotency_window: number;
  readonly idempotency_key_window: number;
  /** The current time, taken at the entry; the kernel does not read a clock. */
  readonly now: Instant;
  readonly confirmation: Confirmation | null;
}

/**
 * A context the kernel refuses. Either way it is an internal error to the caller (contract
 * `internal`), not a user error: the service layer builds the context.
 */
export class OpsContextError extends Error {
  override readonly name = "OpsContextError";
  /** `invalid`: a malformed context. `not_implemented`: a valid context the kernel cannot serve yet. */
  readonly reason: "invalid" | "not_implemented";
  constructor(reason: "invalid" | "not_implemented", message: string) {
    super(message);
    this.reason = reason;
  }
}

const KEYS = [
  "tenant",
  "actor",
  "trigger",
  "task",
  "visibility",
  "idempotency_window",
  "idempotency_key_window",
  "now",
  "confirmation",
] as const;

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: Json): v is string => typeof v === "string";

function fail(message: string): never {
  throw new OpsContextError("invalid", `ops context: ${message}`);
}

function exactKeys(
  v: Json,
  at: string,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  if (!isObject(v)) fail(`${at} is not an object`);
  for (const k of Object.keys(v)) {
    if (!required.includes(k) && !optional.includes(k)) fail(`${at} has an unknown key ${k}`);
  }
  for (const k of required) if (!(k in v)) fail(`${at} misses ${k}`);
  return v;
}

function ascendingUnique(
  list: readonly string[],
  at: string,
  order: (a: string, b: string) => number,
) {
  for (let i = 1; i < list.length; i++) {
    if (order(list[i - 1] as string, list[i] as string) >= 0)
      fail(`${at} not ascending and unique`);
  }
}

const tableNumber = (t: string) => Number(t.slice(1));

function visibility(v: Json): Visibility {
  const o = exactKeys(v, "visibility", ["kind"], ["slots"]);
  if (o["kind"] === "all") {
    exactKeys(o, "visibility", ["kind"]);
    return { kind: "all" };
  }
  if (o["kind"] !== "scoped") fail("visibility.kind is unknown");
  const slots = o["slots"];
  if (!Array.isArray(slots)) fail("visibility.slots is not a list");
  const out = slots.map((s: Json, i): VisibleSlot => {
    const at = `visibility.slots[${i}]`;
    const so = exactKeys(s, at, ["slot"], ["tables"]);
    const slot = so["slot"];
    if (!str(slot) || !isId("slot", slot)) fail(`${at}.slot is not a slot ID`);
    if (!("tables" in so)) return { slot: slot as SlotId };
    const tables = so["tables"];
    if (!Array.isArray(tables)) fail(`${at}.tables is not a list`);
    const ts = tables.map((t: Json, j): VisibleTable => {
      const tat = `${at}.tables[${j}]`;
      const to = exactKeys(t, tat, ["table"], ["fields"]);
      const table = to["table"];
      if (!str(table) || !isId("table", table)) fail(`${tat}.table is not a table ID`);
      if ("fields" in to) {
        // The kernel implements visibility to the slot and table levels (§4); the field level
        // is not implemented yet and is refused rather than ignored, which would widen it.
        throw new OpsContextError(
          "not_implemented",
          `ops context: ${tat}.fields: field-level visibility is not implemented`,
        );
      }
      return { table: table as TableId };
    });
    ascendingUnique(
      ts.map((t) => t.table),
      `${at}.tables`,
      (a, b) => tableNumber(a) - tableNumber(b),
    );
    return { slot: slot as SlotId, tables: ts };
  });
  ascendingUnique(
    out.map((s) => s.slot),
    "visibility.slots",
    (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return { kind: "scoped", slots: out };
}

function confirmation(v: Json): Confirmation | null {
  if (v === null) return null;
  const o = exactKeys(v, "confirmation", ["item_op", "restore_count", "via"]);
  const { item_op, restore_count, via } = o;
  if (!isEventInteger(item_op) || item_op < 1)
    fail("confirmation.item_op is not an operation number");
  if (!isEventInteger(restore_count)) fail("confirmation.restore_count is not a count");
  if (via !== "call" && via !== "elicitation") fail("confirmation.via is unknown");
  return { item_op, restore_count, via };
}

const nullableString = (v: Json, at: string): string | null => {
  if (v !== null && !str(v)) fail(`${at} is not a string or null`);
  return v;
};

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object") {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/**
 * Checks a context and returns a frozen copy of it, built from the checked values only. Throws an
 * {@link OpsContextError}.
 */
export function createOpsContext(input: Json): OpsContext {
  const o = exactKeys(input, "context", KEYS);
  const tenant = o["tenant"];
  if (!str(tenant) || !isId("tenant", tenant)) fail("tenant is not a tenant ID");
  const actor = o["actor"];
  const isCaller = str(actor) && (isId("user", actor) || isId("connection", actor));
  if (!isCaller && actor !== "system") fail("actor is not a principal");
  const trigger = o["trigger"];
  if (actor === "system") {
    if (!(INTERNAL_OPERATIONS as readonly Json[]).includes(trigger)) {
      fail("trigger must name the internal operation when actor is system");
    }
  } else if (trigger !== null) fail("trigger only with actor system");
  const window = o["idempotency_window"];
  if (!isEventInteger(window)) fail("idempotency_window is not a non-negative integer");
  const keyWindow = o["idempotency_key_window"];
  if (!isEventInteger(keyWindow)) fail("idempotency_key_window is not a non-negative integer");
  const now = o["now"];
  if (!str(now) || !isInstant(now)) fail("now is not an instant");
  return deepFreeze({
    tenant: tenant as TenantId,
    actor: actor as PrincipalId,
    trigger: trigger as InternalOperation | null,
    task: nullableString(o["task"], "task"),
    visibility: visibility(o["visibility"]),
    idempotency_window: window,
    idempotency_key_window: keyWindow,
    now: now as Instant,
    confirmation: confirmation(o["confirmation"]),
  });
}

/** The context as JSON text, to cross a process boundary. */
export function serializeOpsContext(ctx: OpsContext): string {
  return JSON.stringify(ctx);
}

/** Reads a context from {@link serializeOpsContext}'s text; checks it like {@link createOpsContext}. */
export function deserializeOpsContext(text: string): OpsContext {
  let v: Json;
  try {
    v = JSON.parse(text);
  } catch {
    fail("not JSON");
  }
  return createOpsContext(v);
}
