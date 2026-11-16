// The request key of a caller-initiated operation and its lookup (docs/zh-CN/spec/04-contract.md
// «幂等»; 09-event-format §5.1 `request_key`, `idempotency`): an explicit idempotency key, or a key
// computed from the caller, the task and the request's canonical content. A key found within its
// window names the operation that already did the request: the caller returns that operation's
// result instead of doing it again. Used by every operation that takes these keys.

import { createHash } from "node:crypto";
import { canonicalize, type JsonValue, type OpNumber } from "@fluxvita/saveslot-contract-core";
import type { ReadTx } from "../store/ports.ts";
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
