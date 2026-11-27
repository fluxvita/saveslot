// Running a kernel call on the local tenant (docs/zh-CN/spec/04-contract-types.md §4–§8): the
// operation's kernel entry, the result in the contract's shape, any failure as a ContractError.
// The connection operations take and give slots by name, as the contract does; the kernel's are
// by ID.

import {
  type ConnectionRecord,
  catalog,
  exportLog,
  type Fit,
  history,
  listConnections,
  logEnd,
  logVerify,
  NothingKept,
  type NoticeRefs,
  pending,
  pendingItemsNotices,
  pendingItemType,
  policyGet,
  query,
  readsList,
  removeSlot,
  renameConnection,
  resolve,
  schemaDraft,
  schemaUpdatedNotices,
  sources,
  sql,
  sqlStateOf,
  write,
} from "@fluxvita/saveslot-kernel";
import type { Scope } from "./auth.ts";
import type { ServedTenant } from "./callers.ts";
import { contractResult, type KernelCall, type Operation } from "./calls.ts";
import {
  ContractError,
  contractError,
  internalError,
  lostConnectionOf,
  RetryOnLostConnection,
} from "./contract-error.ts";
import type { CursorKeys } from "./cursor.ts";

type Obj = Readonly<Record<string, unknown>>;

/** The slots' names by ID, and IDs by name. */
async function slotNames(
  t: Pick<ServedTenant, "store">,
): Promise<{ name: Map<string, string>; id: Map<string, string> }> {
  const r = await t.store.read((tx) =>
    tx.query<{ id: string; name: string }>("SELECT id, name FROM slots"),
  );
  return {
    name: new Map(r.rows.map((x) => [x.id, x.name])),
    id: new Map(r.rows.map((x) => [x.name, x.id])),
  };
}

/** ASCII case folding: names are unique without ASCII case (03-data-model/10 «名字»). */
const foldAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

const strs = (xs: unknown): string[] =>
  Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string") : [];
const field = (o: unknown, k: string): unknown =>
  o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;

/**
 * What a call involves, for its notices (04-contract §13: the slots the call is about): the
 * catalog's slots, the table read or written, the item decided on. None for `pending` (it lists
 * the items itself) and for the management operations (no notices).
 */
function noticeRefs(operation: Operation, params: Obj, result: unknown): NoticeRefs | undefined {
  switch (operation) {
    case "catalog": {
      const level = field(result, "level");
      if (level === "list")
        return { slots: strs(arr(field(result, "slots")).map((x) => field(x, "slot"))) };
      if (level === "table")
        return { slots: strs(arr(field(result, "tables")).map((x) => field(x, "slot"))) };
      return { slots: strs([field(result, "slot")]) };
    }
    case "query":
    case "history":
      return { tables: strs([params["table"]]) };
    // The slots it read, by name: the result's `sv` has each.
    case "sql": {
      const sv = field(result, "sv");
      return { slots: sv !== null && typeof sv === "object" ? Object.keys(sv) : [] };
    }
    // By the operation it logged: its slot, whatever version's names the request used. Tables by
    // name only for a write that logged none.
    case "write": {
      const seq = field(result, "seq");
      return typeof seq === "number"
        ? { operations: [seq] }
        : {
            tables: strs(arr(field(result, "ops")).map((x) => field(field(x, "target"), "table"))),
          };
    }
    case "resolve":
      return { items: strs([params["id"]]) };
    case "schema_draft":
      return { slots: strs([field(result, "slot")]) };
    // The slots of the sources given (one for `get`).
    case "sources":
      return field(result, "mode") === "get"
        ? { slots: strs([field(result, "slot")]) }
        : { slots: [...new Set(strs(arr(field(result, "sources")).map((x) => field(x, "slot"))))] };
    default:
      return undefined;
  }
}

const arr = (xs: unknown): unknown[] => (Array.isArray(xs) ? xs : []);

/**
 * The order notices come in, and are cut to three by (04-contract §13): what is overdue first, then
 * a migration under way, a schema changed since the caller read it, items waiting.
 */
const NOTICE_ORDER: readonly string[] = [
  "deletion_overdue",
  "migration_progress",
  "schema_updated",
  "pending_items",
];
const noticeRank = (n: unknown) => {
  const i = NOTICE_ORDER.indexOf(String(field(n, "code")));
  return i < 0 ? NOTICE_ORDER.length : i;
};

/** Notices in `NOTICE_ORDER`, each kind's own order kept, cut to three. */
export function orderedNotices(notices: readonly unknown[]): unknown[] {
  return notices
    .map((n, i) => ({ n, i }))
    .sort((a, b) => noticeRank(a.n) - noticeRank(b.n) || a.i - b.i)
    .map((x) => x.n)
    .slice(0, 3);
}

/**
 * A result with its `schema_updated` and `pending_items` notices (04-contract-types §7), computed
 * now: a replayed receipt's too. None when there are none; at most three with any the result has,
 * in the order of `NOTICE_ORDER` (each kind's own order kept).
 */
async function withNotices(
  t: Pick<ServedTenant, "store">,
  ctx: KernelCall["ctx"],
  operation: Operation,
  params: Obj,
  result: unknown,
): Promise<unknown> {
  const refs = noticeRefs(operation, params, result);
  if (refs === undefined || result === null || typeof result !== "object") return result;
  const found = [
    // The task as the call's `sv` fallback takes it: the surface's, in the parameters (calls.ts).
    ...(await schemaUpdatedNotices(
      t.store,
      ctx.visibility,
      { actor: ctx.actor, task: typeof params["task"] === "string" ? params["task"] : ctx.task },
      refs,
    )),
    ...(await pendingItemsNotices(t.store, ctx.visibility, refs)),
  ];
  if (found.length === 0) return result;
  return {
    ...(result as Record<string, unknown>),
    notices: orderedNotices([...arr(field(result, "notices")), ...found]),
  };
}

/** A connection as the contract gives it (04-contract-types §8.1 `Connection`). */
export function connectionOut(c: ConnectionRecord, names: Map<string, string>) {
  return {
    id: c.id,
    name: c.name,
    scopes: c.scopes,
    // The range as it is now: a removed slot is left out (process/decisions/remove-empty-slot.md
    // §5), so a range of only removed slots lists none; that is still a range, never "all".
    ...(c.slots !== undefined
      ? {
          slots: c.slots.flatMap((id) => {
            const name = names.get(id);
            return name === undefined ? [] : [{ slot: name, slot_id: id }];
          }),
        }
      : {}),
    via: c.via,
    ...(c.client !== undefined ? { client: c.client } : {}),
    created_at: c.created_at,
    ...(c.state !== "active" ? { state: c.state } : {}),
    ...(c.revoked_at !== undefined ? { revoked_at: c.revoked_at } : {}),
  };
}

const keysOnly = (p: Obj, keys: readonly string[]) => {
  for (const k of Object.keys(p)) {
    if (!keys.includes(k)) {
      throw new ContractError("invalid_argument", `unknown parameter ${k}`, {
        reason: "malformed",
        param: k,
      });
    }
  }
};

/** A required, non-empty string parameter. */
const text = (p: Obj, k: string) => {
  const v = p[k];
  if (typeof v !== "string" || v === "") {
    throw new ContractError("invalid_argument", `${k} is required`, {
      reason: typeof v === "undefined" ? "missing" : "malformed",
      param: k,
    });
  }
};

/**
 * The scope each item type's decisions need (04-contract §6 «待处理事项»): the kernel knows only the
 * visible range, the scope is the service's (02-architecture §5).
 */
const DECISION_SCOPE: ReadonlyMap<string, Scope> = new Map([
  ["conflict", "saveslot.write"],
  ["awaiting_confirmation", "saveslot.write"],
  ["flagged", "saveslot.write"],
  ["schema_change", "saveslot.schema"],
  ["deletion", "saveslot.delete"],
]);

/**
 * An item's detail with only the decisions the credential may take (04-contract §6: «只列出当前
 * 凭证可用的处理方式»): the kernel lists every decision of the item's type. Every result that gives
 * decisions goes through here, and only an item's detail (04-contract-types `ItemBase.decisions`)
 * does: `pending`'s detail, and the `current` of `confirmation_mismatch` (which is that detail). A
 * write's `pending[]` and `resolve`'s receipt give none. Anything else is returned as it is.
 * The decisions a receipt's text names (MCP's write receipt for a conflict, an awaiting write)
 * are not filtered here: a write receipt is only ever given to a credential with saveslot.write,
 * which may take those decisions.
 */
export function decisionsFor(scopes: readonly Scope[], x: unknown): unknown {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return x;
  const o = x as Record<string, unknown>;
  if (!Array.isArray(o["decisions"]) || typeof o["type"] !== "string") return x;
  const need = DECISION_SCOPE.get(o["type"]);
  return need !== undefined && scopes.includes(need) ? x : { ...o, decisions: [] };
}

/**
 * `resolve`'s scope, by the item's type (04-contract §6): checked before the kernel decides, on the
 * item as the caller sees it. An item it does not see is not checked: the kernel refuses it as not
 * there, so a scope error never tells that it exists. An item's type never changes.
 */
async function checkDecisionScope(o: {
  readonly store: ServedTenant["store"];
  readonly call: KernelCall;
}): Promise<void> {
  const id = o.call.params["id"];
  if (typeof id !== "string") return;
  const type = await pendingItemType(o.store, o.call.ctx, id);
  if (type === undefined) return;
  const need = DECISION_SCOPE.get(type);
  if (need === undefined || !o.call.scopes.includes(need))
    throw new ContractError("insufficient_scope", "the credential may not decide on this item", {
      required_scope: need ?? "saveslot.write",
    });
}

/** Runs `call` as `operation`; resolves with the contract result, rejects with a ContractError. */
/**
 * The operations that only read: run once more on the tenant opened again when they meet its
 * connection gone with nothing given yet (02-architecture §7 «连接»). No operation that appends to
 * the log may be here; operations.test.ts holds that.
 */
export const READ_ONLY_OPERATIONS: ReadonlySet<Operation> = new Set<Operation>([
  "catalog",
  "query",
  "history",
  "sql",
  "pending",
  "policy.get",
  "sources",
  "connections.list",
  "reads.list",
  "log.verify",
  "log.end",
]);

export async function runOperation(o: {
  /** The caller's tenant, lent for this call. */
  readonly tenant: ServedTenant;
  readonly cursors: CursorKeys;
  readonly operation: Operation;
  readonly call: KernelCall;
  /** Where not-implemented paths and internal errors are reported (no request content). */
  readonly warn: (event: string, fields: Readonly<Record<string, string>>) => void;
  /**
   * For a read: how much of the result, as the contract gives it, the caller keeps (the kernel's
   * `Fit`). What is recorded as read is what is kept; keeping none is `too_large`
   * (`result_budget`), with nothing recorded.
   */
  readonly fit?: (result: unknown) => number | undefined;
}): Promise<unknown> {
  const { ctx, params } = o.call;
  const store = o.tenant.store;
  const caller = o.fit;
  // The kernel's result as the contract gives it (its next page as a signed handle), for the
  // caller to measure.
  const fit: Fit | undefined =
    caller === undefined
      ? undefined
      : (r) => caller(contractResult(r, o.cursors, ctx.actor, ctx.now));
  // Whether the operation itself is done (a write committed): what follows only reads for the answer.
  let done = false;
  try {
    const result = await (async (): Promise<unknown> => {
      switch (o.operation) {
        case "catalog":
          return catalog(store, ctx, params, fit);
        case "query":
          return query(store, ctx, params, fit);
        case "history":
          return history(store, ctx, params, fit);
        case "sql":
          return sql(store, ctx, params, {
            ...(fit !== undefined ? { fit } : {}),
            // A statement the database refused: its SQLSTATE in the service's warnings, never the
            // database's text (it can quote the statement's values).
            onDatabaseError: (e) => o.warn("sql_database_error", { code: sqlStateOf(e) ?? "" }),
          });
        case "pending":
          return decisionsFor(o.call.scopes, await pending(store, ctx, params, fit));
        case "policy.get":
          return policyGet(store, ctx, params);
        case "sources":
          return sources(store, ctx, params, fit);
        case "write":
          return write(store, ctx, params);
        case "resolve":
          await checkDecisionScope({ store, call: o.call });
          return resolve(store, ctx, params);
        case "schema_draft":
          return schemaDraft(store, ctx, params);
        case "reads.list":
          return readsList(store, ctx, params);
        case "log.verify":
          keysOnly(params, []);
          return logVerify(store, ctx);
        case "log.end":
          keysOnly(params, []);
          return logEnd(store, ctx);
        case "export":
          // Streamed: the server calls `runExport`.
          throw new Error("export is not a one-answer operation");
        case "connections.list": {
          const r = await listConnections(store, ctx, params as never);
          const names = (await slotNames(o.tenant)).name;
          return { ...r, connections: r.connections.map((c) => connectionOut(c, names)) };
        }
        case "connections.issue": {
          keysOnly(params, ["name", "scopes", "slots"]);
          text(params, "name");
          const given = params["slots"];
          let slots: string[] | undefined;
          if (given !== undefined) {
            if (!Array.isArray(given) || given.some((x) => typeof x !== "string")) {
              throw new ContractError("invalid_argument", "slots are slot names", {
                reason: "malformed",
                param: "slots",
              });
            }
            // Each a slot's ID or its name (04-contract «管理类操作»), names without ASCII case as
            // they are unique; a slot given twice is listed once. Whatever names no slot, an ID or
            // a name, gets the one answer.
            const known = await slotNames(o.tenant);
            const byName = new Map([...known.id].map(([name, id]) => [foldAscii(name), id]));
            slots = [
              ...new Set(
                given.map((n: string) => {
                  const id = known.name.has(n) ? n : byName.get(foldAscii(n));
                  if (id === undefined) {
                    throw new ContractError("not_found", "no such slot", {
                      reason: "slot",
                      param: "slots",
                    });
                  }
                  return id;
                }),
              ),
            ];
          }
          const r = await o.tenant.connections.issue(ctx, {
            name: params["name"] as string,
            ...(params["scopes"] !== undefined ? { scopes: params["scopes"] as never } : {}),
            ...(slots !== undefined ? { slots: slots as never } : {}),
          });
          return {
            ...connectionOut(r.connection, (await slotNames(o.tenant)).name),
            token: r.token,
          };
        }
        case "connections.update": {
          keysOnly(params, ["id", "name"]);
          text(params, "id");
          text(params, "name");
          const c = await renameConnection(store, ctx, params as never);
          return connectionOut(c, (await slotNames(o.tenant)).name);
        }
        case "slots.remove":
          keysOnly(params, ["slot_id"]);
          return removeSlot(store, ctx, params as never);
        case "connections.revoke": {
          keysOnly(params, ["id"]);
          text(params, "id");
          const c = await o.tenant.connections.revoke(ctx, params["id"] as never);
          return connectionOut(c, (await slotNames(o.tenant)).name);
        }
      }
    })();
    done = true;
    return contractResult(
      await withNotices(o.tenant, ctx, o.operation, params, result),
      o.cursors,
      ctx.actor,
      ctx.now,
    );
  } catch (e) {
    if (e instanceof NothingKept) {
      throw new ContractError("too_large", "the result is larger than a result may be", {
        reason: "result_budget",
        narrow_by: [],
      });
    }
    // A call that may have taken effect (its operation done, not a read), its answer not made for
    // the connection gone: not `busy`, which says nothing was recorded. Internal, as a COMMIT
    // unanswered is: the caller reads the state before sending it again.
    const gone = lostConnectionOf(e);
    if (done && !READ_ONLY_OPERATIONS.has(o.operation) && gone !== undefined) {
      o.warn("tenant_connection_lost", { tenant: o.tenant.tenant, code: gone, after: "effect" });
      throw internalError(e, o.warn);
    }
    // A read meeting its tenant's connection gone, nothing given yet: once more, opened again.
    if (
      o.tenant.retryOnLost === true &&
      READ_ONLY_OPERATIONS.has(o.operation) &&
      lostConnectionOf(e) === "connection_lost"
    ) {
      // This try given up: logged here, whether or not the next one is answered.
      o.warn("tenant_connection_lost", { tenant: o.tenant.tenant, code: "connection_lost" });
      throw new RetryOnLostConnection();
    }
    const c = contractError(e, o.warn, { tenant: o.tenant.tenant });
    // The item as it is now, with the decisions this credential may take.
    if (c.code === "confirmation_mismatch" && c.detail["current"] !== undefined)
      throw new ContractError(c.code, c.message, {
        ...c.detail,
        current: decisionsFor(o.call.scopes, c.detail["current"]),
      } as never);
    throw c;
  }
}

/**
 * Runs `export` (04-contract §17): the whole log as NDJSON lines through `sink`, first the
 * manifest. Rejects with a ContractError; the lines already given are not taken back, so the
 * caller must tell a rejection before the first line (an error answer) from one after it (the
 * stream is cut off).
 */
export async function runExport(o: {
  /** The caller's tenant, lent for the export. */
  readonly tenant: Pick<ServedTenant, "store">;
  readonly call: KernelCall;
  readonly warn: (event: string, fields: Readonly<Record<string, string>>) => void;
  readonly sink: (line: string) => Promise<void>;
}): Promise<void> {
  try {
    await exportLog(o.tenant.store, o.call.ctx, o.call.params, o.sink);
  } catch (e) {
    throw contractError(e, o.warn);
  }
}

/** How long an export waits for its reader before it gives the export up (the kernel's). */
export { EXPORT_STALL_MS } from "@fluxvita/saveslot-kernel";
