// The request key of a caller-initiated operation and its lookup (docs/zh-CN/spec/04-contract.md
// «幂等»; 09-event-format §5.1 `request_key`, `idempotency`): an explicit idempotency key, or a key
// computed from the caller, the task and the request's canonical content. A key found within its
// window names the operation that already did the request: the caller returns that operation's
// result instead of doing it again. Used by every operation that takes these keys.

import { createHash } from "node:crypto";
import { canonicalize, type JsonValue, type OpNumber } from "@fluxvita/saveslot-contract-core";
import type { ReadTx } from "../store/ports.ts";
import { READABLE_CONTENT } from "../store/readable-content.ts";
import { WriteError } from "./errors.ts";
import { requestKeyHit } from "./reads.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A request's key, and the head event block that records it. */
export interface RequestKey {
  readonly key: string;
  /** Explicit idempotency key: the request content's fingerprint. */
  readonly fingerprint?: string;
  /** `request_key` or `idempotency`, for the head event. */
  readonly block: Readonly<Record<string, JsonValue>>;
}

/** The key of a request as normalizing gave its content and explicit idempotency key. */
export function requestKeyOf(
  actor: string,
  task: string | null,
  request: {
    readonly content: string;
    readonly idempotencyKey?: string;
    readonly fingerprint?: string;
  },
): RequestKey {
  if (request.idempotencyKey !== undefined) {
    const key = sha256(canonicalize(["idempotency", actor, request.idempotencyKey]));
    const fingerprint = request.fingerprint as string;
    return { key, fingerprint, block: { idempotency: { key, fingerprint } } };
  }
  const key = sha256(canonicalize([actor, task, request.content]));
  return { key, block: { request_key: { key } } };
}

/**
 * The operation that already did this request, within the key's window; none: do it now. An
 * explicit idempotency key used for another request (another fingerprint) is refused.
 */
export async function findRequest(
  tx: ReadTx,
  k: RequestKey,
  now: string,
  windows: { readonly requestKey: number; readonly idempotencyKey: number },
): Promise<OpNumber | undefined> {
  const explicit = k.fingerprint !== undefined;
  const since = new Date(
    Date.parse(now) - (explicit ? windows.idempotencyKey : windows.requestKey),
  ).toISOString();
  const hit = await requestKeyHit(tx, k.key, since);
  if (hit === undefined) return undefined;
  if (explicit && hit.fingerprint !== k.fingerprint) {
    throw new WriteError("invalid_argument", "the idempotency key was used for another request", {
      reason: "idempotency_key_reuse",
      param: "idempotency_key",
    });
  }
  return hit.op;
}

/**
 * The pending deletion listing the request key of operation `op` (its head's `request_key` or
 * `idempotency` block, 09 §5.9): the one confirmed first when several do; none when the key is
 * readable. A deletion of any source of an operation lists its key.
 */
export async function deletionOfRequest(tx: ReadTx, op: OpNumber): Promise<string | undefined> {
  const r = await tx.query<{ id: string }>(
    `SELECT d.id FROM ${READABLE_CONTENT} c JOIN deletions d ON d.confirmed_seq = c.pending_by
     WHERE c.seq = $1 AND c.path IN ('request_key', 'idempotency') AND c.pending_by IS NOT NULL
     ORDER BY c.pending_by LIMIT 1`,
    [op],
  );
  return r.rows[0]?.id;
}

/**
 * A write's lookup (03-data-model/03-deletion «宽限期内重发»): as `findRequest`, but a hit whose
 * request key a pending deletion lists gives that deletion, before the fingerprint of an explicit
 * idempotency key is compared (the pending content takes no part in the comparison).
 */
export async function findWriteRequest(
  tx: ReadTx,
  k: RequestKey,
  now: string,
  windows: { readonly requestKey: number; readonly idempotencyKey: number },
): Promise<{ readonly op: OpNumber; readonly deletion?: string } | undefined> {
  const explicit = k.fingerprint !== undefined;
  const since = new Date(
    Date.parse(now) - (explicit ? windows.idempotencyKey : windows.requestKey),
  ).toISOString();
  const hit = await requestKeyHit(tx, k.key, since);
  if (hit === undefined) return undefined;
  const deletion = await deletionOfRequest(tx, hit.op);
  if (deletion !== undefined) return { op: hit.op, deletion };
  if (explicit && hit.fingerprint !== k.fingerprint) {
    throw new WriteError("invalid_argument", "the idempotency key was used for another request", {
      reason: "idempotency_key_reuse",
      param: "idempotency_key",
    });
  }
  return { op: hit.op };
}
