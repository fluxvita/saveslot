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
  sources,
  sql,
  write,
} from "@fluxvita/saveslot-kernel";
import type { Scope } from "./auth.ts";
import { contractResult, type KernelCall, type Operation } from "./calls.ts";
import { ContractError, contractError } from "./contract-error.ts";
import type { Credentials } from "./credentials.ts";
import type { CursorKeys } from "./cursor.ts";
import { issueLocalConnection, revokeLocalConnection } from "./local-connections.ts";
import type { LocalTenant } from "./local-tenant.ts";

type Obj = Readonly<Record<string, unknown>>;

/** The slots' names by ID, and IDs by name. */
async function slotNames(
  t: LocalTenant,
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
    case "write":
      return {
        tables: strs(arr(field(result, "ops")).map((x) => field(field(x, "target"), "table"))),
      };
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
 * A result with its `pending_items` notices (04-contract-types §7), computed now: a replayed
 * receipt's too. None when there are none; at most three (with any the result has).
 */
async function withNotices(
  t: LocalTenant,
  ctx: KernelCall["ctx"],
  operation: Operation,
  params: Obj,
  result: unknown,
): Promise<unknown> {
  const refs = noticeRefs(operation, params, result);
  if (refs === undefined || result === null || typeof result !== "object") return result;
  const found = await pendingItemsNotices(t.store, ctx.visibility, refs);
  if (found.length === 0) return result;
  const had = arr(field(result, "notices"));
  return { ...(result as Record<string, unknown>), notices: [...had, ...found].slice(0, 3) };
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
 * The scope each item type's decisions need (04-contract §6 «处理方式»): the kernel knows only the
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
  readonly store: LocalTenant["store"];
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
export async function runOperation(o: {
  readonly tenant: LocalTenant;
  readonly credentials: Credentials;
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
          return sql(store, ctx, params, fit !== undefined ? { fit } : {});
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
          const r = await issueLocalConnection({
            tenant: o.tenant,
            credentials: o.credentials,
            ctx,
            params: {
              name: params["name"] as string,
              ...(params["scopes"] !== undefined ? { scopes: params["scopes"] as never } : {}),
              ...(slots !== undefined ? { slots: slots as never } : {}),
            },
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
          const c = await revokeLocalConnection({
            tenant: o.tenant,
            ctx,
            id: params["id"] as never,
          });
          return connectionOut(c, (await slotNames(o.tenant)).name);
        }
      }
    })();
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
    const c = contractError(e, o.warn);
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
  readonly tenant: LocalTenant;
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
