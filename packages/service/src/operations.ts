// Running a kernel call on the local tenant (docs/zh-CN/spec/04-contract-types.md §4–§8): the
// operation's kernel entry, the result in the contract's shape, any failure as a ContractError.
// The connection operations take and give slots by name, as the contract does; the kernel's are
// by ID.

import {
  type ConnectionRecord,
  catalog,
  type Fit,
  history,
  listConnections,
  logVerify,
  NothingKept,
  pending,
  query,
  readsList,
  renameConnection,
  resolve,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
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

/** 04-contract-types §8.1 `Connection`. */
function connectionOut(c: ConnectionRecord, names: Map<string, string>) {
  return {
    id: c.id,
    name: c.name,
    scopes: c.scopes,
    ...(c.slots !== undefined
      ? { slots: c.slots.map((id) => ({ slot: names.get(id) ?? id, slot_id: id })) }
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
        case "pending":
          return pending(store, ctx, params, fit);
        case "write":
          return write(store, ctx, params);
        case "resolve":
          return resolve(store, ctx, params);
        case "schema_draft":
          return schemaDraft(store, ctx, params);
        case "reads.list":
          return readsList(store, ctx, params);
        case "log.verify":
          keysOnly(params, []);
          return logVerify(store, ctx);
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
            const ids = (await slotNames(o.tenant)).id;
            slots = given.map((n: string) => {
              const id = ids.get(n);
              if (id === undefined) {
                throw new ContractError("not_found", "no such slot", {
                  reason: "slot",
                  param: "slots",
                });
              }
              return id;
            });
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
    return contractResult(result, o.cursors, ctx.actor, ctx.now);
  } catch (e) {
    if (e instanceof NothingKept) {
      throw new ContractError("too_large", "the result is larger than a result may be", {
        reason: "result_budget",
        narrow_by: [],
      });
    }
    throw contractError(e, o.warn);
  }
}
