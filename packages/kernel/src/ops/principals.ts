// Connection instances: issue, rename, revoke (docs/zh-CN/spec/04-contract.md §12, §17;
// docs/zh-CN/spec/04-contract-types.md §8.1; docs/zh-CN/spec/09-event-format.md §5.3).
//
// Management operations are for user sessions only. Each entry opens one write transaction,
// appends the operation and applies it in that transaction. Slots are given as slot IDs: names
// are resolved by the service layer.

import {
  type ConnectionId,
  type JsonValue,
  type PrincipalVia,
  SCOPES,
  type Scope,
  type Seq,
  type SlotId,
  type UserId,
} from "@fluxvita/saveslot-contract-core";
import { applyEvents, eventsOf } from "../apply/index.ts";
import { appendOperation, type NewEvent } from "../log/index.ts";
import { RULESET_VERSION } from "../rules/version.ts";
import type { ReadTx, TenantStore, Tx } from "../store/ports.ts";
import type { OpsContext } from "./context.ts";
import { OpsError } from "./errors.ts";
import { newConnectionId } from "./ids.ts";

export interface IssueConnectionParams {
  readonly name: string;
  /** Must include saveslot.read. Default: read and write. */
  readonly scopes?: readonly Scope[];
  /** Slot IDs. Absent: all slots, including later ones. */
  readonly slots?: readonly SlotId[];
  /** Filled by the service layer: a local or static token, or an OAuth grant. */
  readonly via: PrincipalVia;
  /** The OAuth client identifier: exactly when `via` is `oauth`. */
  readonly client?: string;
}

/** A connection instance as `principals` holds it. */
export interface ConnectionRecord {
  readonly id: ConnectionId;
  readonly name: string | null;
  readonly scopes: readonly Scope[];
  /** Absent: all slots. */
  readonly slots?: readonly SlotId[];
  readonly via: PrincipalVia;
  readonly client?: string;
  readonly state: "active" | "revoked" | "disabled";
  /** The `principal.registered` event. */
  readonly registered_seq: Seq;
}

const DEFAULT_SCOPES: readonly Scope[] = ["saveslot.read", "saveslot.write"];

interface Row {
  id: string;
  kind: string;
  name: string | null;
  scopes: string | null;
  slots: string | null;
  via: string | null;
  client: string | null;
  state: "active" | "revoked" | "disabled";
  registered_seq: unknown;
}

function record(r: Row): ConnectionRecord {
  return {
    id: r.id as ConnectionId,
    name: r.name,
    scopes: JSON.parse(r.scopes ?? "[]") as Scope[],
    ...(r.slots === null ? {} : { slots: JSON.parse(r.slots) as SlotId[] }),
    via: r.via as PrincipalVia,
    ...(r.client === null ? {} : { client: r.client }),
    state: r.state,
    registered_seq: Number(r.registered_seq),
  };
}

async function principal(tx: ReadTx, id: string): Promise<Row | undefined> {
  const r = await tx.query<Row>("SELECT * FROM principals WHERE id = $1", [id]);
  return r.rows[0];
}

/** The checks every management operation starts with; returns the acting user. */
async function begin(tx: ReadTx, ctx: OpsContext): Promise<UserId> {
  const t = await tx.query<{ value: string }>("SELECT value FROM meta WHERE key = 'tenant_id'");
  if (t.rows[0]?.value !== ctx.tenant) {
    throw new OpsError("internal", "the context's tenant is not the tenant of this storage");
  }
  // Only user sessions (04-contract §17). The service layer checks this first; this is defence.
  const actor = await principal(tx, ctx.actor);
  if (actor?.kind !== "user" || actor.state !== "active") {
    throw new OpsError("insufficient_scope", "management operations are for user sessions", {
      required_scope: "user_session",
    });
  }
  return actor.id as UserId;
}

/** Whether another connection already holds `name` (revoked and disabled ones included). */
async function nameTaken(tx: ReadTx, name: string, except?: string): Promise<boolean> {
  // Code point comparison: the column's collation is "C" (UTF-8 bytes order and equality).
  const r = await tx.query(
    "SELECT 1 FROM principals WHERE kind = 'connection' AND name = $1 AND id <> $2",
    [name, except ?? ""],
  );
  return r.rows.length > 0;
}

function duplicateName(): OpsError {
  return new OpsError("invalid_argument", "another connection has this name", {
    reason: "duplicate_name",
    param: "name",
  });
}

async function commit(tx: Tx, ctx: OpsContext, actor: UserId, event: NewEvent): Promise<void> {
  const op = await appendOperation(tx, { actor, now: ctx.now, events: [event] });
  await applyEvents(tx, eventsOf(op));
}

const ctxBlock = (ctx: OpsContext): JsonValue => ({
  now: ctx.now,
  ruleset_version: RULESET_VERSION,
});

function scopesOf(given: readonly Scope[] | undefined): Scope[] {
  const scopes = given ?? DEFAULT_SCOPES;
  for (const s of scopes) {
    if (!(SCOPES as readonly string[]).includes(s)) {
      throw new OpsError("invalid_argument", `unknown scope ${s}`, {
        reason: "malformed",
        param: "scopes",
      });
    }
  }
  if (!scopes.includes("saveslot.read")) {
    throw new OpsError("invalid_argument", "a connection must have saveslot.read", {
      reason: "missing_read_scope",
      param: "scopes",
    });
  }
  // Unique, in the order SCOPES lists them (09 §5.3).
  return SCOPES.filter((s) => scopes.includes(s));
}

async function slotsOf(
  tx: ReadTx,
  ctx: OpsContext,
  given: readonly SlotId[] | undefined,
): Promise<SlotId[] | undefined> {
  if (given === undefined) return undefined;
  if (given.length === 0) {
    throw new OpsError("invalid_argument", "slots is empty", {
      reason: "empty_slots",
      param: "slots",
    });
  }
  const unique = [...new Set(given)].sort();
  for (const slot of unique) {
    const visible =
      ctx.visibility.kind === "all" || ctx.visibility.slots.some((s) => s.slot === slot);
    const exists = (await tx.query("SELECT 1 FROM slots WHERE id = $1", [slot])).rows.length > 0;
    if (!visible || !exists) {
      throw new OpsError("not_found", `no slot ${slot}`, { reason: "slot", param: "slots" });
    }
  }
  return unique;
}

/** `connections.issue`: registers a new connection instance. */
export async function issueConnection(
  store: TenantStore,
  ctx: OpsContext,
  params: IssueConnectionParams,
): Promise<ConnectionRecord> {
  if ((params.via === "oauth") !== (params.client !== undefined)) {
    throw new OpsError("internal", "client is given exactly when via is oauth");
  }
  return store.write(async (tx) => {
    const actor = await begin(tx, ctx);
    const scopes = scopesOf(params.scopes);
    const slots = await slotsOf(tx, ctx, params.slots);
    if (await nameTaken(tx, params.name)) throw duplicateName();
    const id = newConnectionId();
    await commit(tx, ctx, actor, {
      type: "principal.registered",
      blocks: {
        ctx: ctxBlock(ctx),
        principal: {
          principal: id,
          kind: "connection",
          scopes,
          ...(slots === undefined ? {} : { slots }),
          via: params.via,
          ...(params.client === undefined ? {} : { client: params.client }),
        },
        name: { name: params.name },
      },
    });
    return record((await principal(tx, id)) as Row);
  });
}

async function connection(tx: ReadTx, id: string): Promise<Row> {
  const row = await principal(tx, id);
  if (row?.kind !== "connection") {
    throw new OpsError("not_found", `no connection ${id}`, { reason: "connection", param: "id" });
  }
  return row;
}

/**
 * `connections.update`: renames a connection instance, revoked and disabled ones included. The
 * same name as now appends nothing.
 */
export async function renameConnection(
  store: TenantStore,
  ctx: OpsContext,
  params: { readonly id: ConnectionId; readonly name: string },
): Promise<ConnectionRecord> {
  return store.write(async (tx) => {
    const actor = await begin(tx, ctx);
    const row = await connection(tx, params.id);
    if (row.name === params.name) return record(row);
    if (await nameTaken(tx, params.name, params.id)) throw duplicateName();
    await commit(tx, ctx, actor, {
      type: "principal.renamed",
      blocks: {
        ctx: ctxBlock(ctx),
        principal: { principal: params.id },
        name: { name: params.name },
      },
    });
    return record((await principal(tx, params.id)) as Row);
  });
}

/**
 * `connections.revoke`. Revoking a connection that is already revoked or disabled appends nothing
 * and returns it as it is.
 */
export async function revokeConnection(
  store: TenantStore,
  ctx: OpsContext,
  params: { readonly id: ConnectionId },
): Promise<ConnectionRecord> {
  return store.write(async (tx) => {
    const actor = await begin(tx, ctx);
    const row = await connection(tx, params.id);
    if (row.state !== "active") return record(row);
    await commit(tx, ctx, actor, {
      type: "principal.revoked",
      blocks: { ctx: ctxBlock(ctx), principal: { principal: params.id } },
    });
    return record((await principal(tx, params.id)) as Row);
  });
}
