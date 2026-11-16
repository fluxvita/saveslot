// A surface's call, made into a kernel call (docs/zh-CN/spec/02-architecture.md §5 «权限», «句柄»;
// 04-contract.md §12–§15; 05-surfaces.md §13): the authenticated principal, the operation, the
// request body and the surface's own fields (HTTP: `X-Task-Id`, `Idempotency-Key`).
//
// - Permission: the operation's scope, or a user session for the management operations
//   (`insufficient_scope`, with `required_scope`); checked before anything reaches the kernel.
// - `task` and `idempotency_key` come from the surface, not the body: a body holding either is
//   refused. They are put into the parameters, where the kernel's normalizing checks them. The
//   management operations take neither; only the write operations take an idempotency key.
// - Paging: the body's `cursor` is verified and given to the kernel as its `position`; a result's
//   `next_position` goes back as a signed `next_cursor`. A body naming `position` is refused.

import { createOpsContext, type OpsContext } from "@fluxvita/saveslot-kernel";
import type { Principal, Scope } from "./auth.ts";
import { ContractError } from "./contract-error.ts";
import type { CursorKeys } from "./cursor.ts";
import type { LocalTenant } from "./local-tenant.ts";

interface OperationRule {
  /** The scope it needs; `user_session`: the management operations. */
  readonly scope: Scope | "user_session";
  /** A write operation: takes an idempotency key. */
  readonly write?: true;
  /** Pages by `cursor`. */
  readonly paged?: true;
}

/** The operations the local surfaces call in this version, and what each needs. */
export const OPERATIONS = {
  catalog: { scope: "saveslot.read", paged: true },
  query: { scope: "saveslot.read", paged: true },
  history: { scope: "saveslot.read", paged: true },
  pending: { scope: "saveslot.read", paged: true },
  write: { scope: "saveslot.write", write: true },
  // This version's decisions (conflict and awaiting items) are `saveslot.write`'s. The scope of a
  // decision goes by the item's type (04-contract §6: schema changes `saveslot.schema`, deletions
  // `saveslot.delete`); it is told apart here once items of those types exist.
  resolve: { scope: "saveslot.write", write: true },
  schema_draft: { scope: "saveslot.schema", write: true },
  "connections.issue": { scope: "user_session" },
  "connections.list": { scope: "user_session", paged: true },
  "connections.update": { scope: "user_session" },
  "connections.revoke": { scope: "user_session" },
  "reads.list": { scope: "user_session", paged: true },
  "log.verify": { scope: "user_session" },
} as const satisfies Readonly<Record<string, OperationRule>>;
export type Operation = keyof typeof OPERATIONS;

/** A kernel call: its context and its parameters. */
export interface KernelCall {
  readonly ctx: OpsContext;
  readonly params: Readonly<Record<string, unknown>>;
}

const invalid = (param: string, reason = "malformed") =>
  new ContractError("invalid_argument", `${param} is not accepted here`, { reason, param });

/** Makes a surface's call into a kernel call; throws a ContractError when it may not be made. */
export function kernelCall(o: {
  readonly principal: Principal;
  readonly tenant: LocalTenant;
  readonly operation: Operation;
  /** The request body (or query parameters); absent: none. */
  readonly body: unknown;
  /** The surface's task identifier (`X-Task-Id`). */
  readonly task?: string;
  /** The surface's idempotency key (`Idempotency-Key`). */
  readonly idempotencyKey?: string;
  readonly now: string;
  /** Idempotency windows, in milliseconds (service configuration). */
  readonly windows: { readonly requestKey: number; readonly idempotencyKey: number };
  readonly cursors: CursorKeys;
}): KernelCall {
  const rule: OperationRule = OPERATIONS[o.operation];
  if (
    rule.scope === "user_session"
      ? o.principal.kind !== "user"
      : !o.principal.scopes.includes(rule.scope)
  ) {
    throw new ContractError("insufficient_scope", "the credential may not call this operation", {
      required_scope: rule.scope,
    });
  }
  const body = o.body ?? {};
  if (body === null || typeof body !== "object" || Array.isArray(body))
    throw invalid("", "malformed");
  const params: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const k of ["task", "idempotency_key", "position"]) {
    if (Object.hasOwn(params, k)) throw invalid(k);
  }
  if (o.task !== undefined) {
    if (rule.scope === "user_session") throw invalid("task");
    params["task"] = o.task;
  }
  if (o.idempotencyKey !== undefined) {
    if (rule.write === undefined) throw invalid("idempotency_key");
    params["idempotency_key"] = o.idempotencyKey;
  }
  if (Object.hasOwn(params, "cursor")) {
    if (rule.paged === undefined) throw invalid("cursor");
    params["position"] = o.cursors.verify(params["cursor"], o.principal.actor, o.now);
    delete params["cursor"];
  }
  const ctx = createOpsContext({
    tenant: o.tenant.tenant,
    actor: o.principal.actor,
    trigger: null,
    task: null,
    visibility: o.principal.visibility,
    idempotency_window: o.windows.requestKey,
    idempotency_key_window: o.windows.idempotencyKey,
    now: o.now,
    confirmation: null,
  });
  return { ctx, params };
}

/** A kernel result as the contract gives it: `next_position` signed as `next_cursor` for `principal`. */
export function contractResult<T>(
  result: T,
  cursors: CursorKeys,
  principal: string,
  now: string,
): T {
  if (result === null || typeof result !== "object" || !("next_position" in result)) return result;
  const { next_position, ...rest } = result as Record<string, unknown>;
  return (
    typeof next_position === "string"
      ? { ...rest, next_cursor: cursors.sign(next_position, principal, now) }
      : rest
  ) as T;
}
