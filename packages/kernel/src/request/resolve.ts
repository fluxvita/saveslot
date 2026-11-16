// Resolve requests: checking and normalizing before anything depends on the tenant's state
// (docs/zh-CN/spec/04-contract.md `resolve`, §6; 04-contract-types `ResolveParams`). Whether the
// item exists, is open, takes the decision, and whether the item version brought back is its
// current one are the pipeline's: they read the tenant.

import { createHash } from "node:crypto";
import { type ItemId, isId, type OpNumber } from "@fluxvita/saveslot-contract-core";
import {
  EVIDENCE_SEGMENT_BYTES,
  evidence,
  intOf,
  invalid,
  notYet,
  Refused,
  refuse,
  requestContent,
  tag,
} from "./normalize.ts";
import { get, has, isObj, keysOf } from "./own.ts";
import type { EvidenceSegment, RequestError } from "./types.ts";

/** The decisions of this version: a conflict item's three, an awaiting item's two (04-contract §6). */
export type ResolveDecision =
  | "keep_effective"
  | "take_candidate"
  | "take_previous"
  | "confirm"
  | "reject";

const DECISIONS: ReadonlySet<string> = new Set([
  "keep_effective",
  "take_candidate",
  "take_previous",
  "confirm",
  "reject",
]);
/** Decisions of later phases: a flagged item's, a deletion's, a migration's. */
const DECISIONS_LATER: ReadonlySet<string> = new Set([
  "keep",
  "revoke",
  "cancel",
  "accept_all",
  "rows",
  "keep_rest_and_switch",
  "abandon",
]);
const KEYS = new Set([
  "id",
  "decision",
  "item_ver",
  "candidate",
  "note",
  "evidence",
  "evidence_by_field",
  "task",
  "idempotency_key",
  "diff_upto",
  "rows",
]);
/** `iv_<the item ID without its prefix>.<operation>.<restore count>` (04-contract §2). */
const ITEM_VER = /^iv_([0-9A-Za-z]+)\.([1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export interface NormalizedResolve {
  readonly id: ItemId;
  readonly decision: ResolveDecision;
  /** The item version brought back; none: the fallback's. */
  readonly itemVer?: { readonly op: OpNumber; readonly restoreCount: number };
  readonly candidate?: number;
  readonly note?: string;
  readonly evidence: readonly EvidenceSegment[];
  readonly task?: string;
  readonly requestKey: {
    /** RFC 8785 canonical form of the request without `task` and `idempotency_key`. */
    readonly content: string;
    readonly idempotencyKey?: string;
    /** With an explicit key: SHA-256 (hex) of `content`. */
    readonly fingerprint?: string;
  };
}

export type NormalizeResolveResult =
  | { readonly ok: true; readonly request: NormalizedResolve }
  | { readonly ok: false; readonly error: RequestError };

/** Checks and normalizes a resolve request: what does not depend on the tenant's state. */
export function normalizeResolve(params: unknown): NormalizeResolveResult {
  try {
    return { ok: true, request: normalize(params) };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.error };
    throw e;
  }
}

function normalize(params: unknown): NormalizedResolve {
  if (!isObj(params)) return invalid("malformed", "");
  for (const k of keysOf(params)) if (!KEYS.has(k)) invalid("malformed", k);
  for (const k of ["evidence_by_field", "diff_upto", "rows"]) if (has(params, k)) notYet(k);
  const task = tag(params, "task");
  const idempotencyKey = tag(params, "idempotency_key");

  if (!has(params, "id")) invalid("missing", "id");
  const id = get(params, "id");
  if (typeof id !== "string" || !isId("item", id)) return invalid("malformed", "id");

  if (!has(params, "decision")) invalid("missing", "decision");
  const decision = get(params, "decision");
  if (typeof decision !== "string") return invalid("malformed", "decision");
  if (DECISIONS_LATER.has(decision)) notYet("decision", "value");
  if (!DECISIONS.has(decision)) invalid("malformed", "decision");

  let itemVer: NormalizedResolve["itemVer"];
  if (has(params, "item_ver")) {
    const v = get(params, "item_ver");
    const m = typeof v === "string" ? ITEM_VER.exec(v) : null;
    // The version names its item: another item's is not this one's.
    if (m === null || `pi_${m[1]}` !== id) return invalid("malformed", "item_ver");
    itemVer = { op: Number(m[2]) as OpNumber, restoreCount: Number(m[3]) };
  }

  let candidate: number | undefined;
  if (has(params, "candidate")) {
    if (decision !== "take_candidate") invalid("malformed", "candidate");
    const c = intOf(get(params, "candidate"));
    if (c === undefined || c < 0) return invalid("malformed", "candidate");
    candidate = c;
  }

  let note: string | undefined;
  if (has(params, "note")) {
    const t = get(params, "note");
    if (typeof t !== "string" || t === "" || !t.isWellFormed() || t.includes("\u0000")) {
      return invalid("malformed", "note");
    }
    const n = new TextEncoder().encode(t).length;
    if (n > EVIDENCE_SEGMENT_BYTES) {
      refuse({
        code: "too_large",
        reason: "evidence_segment",
        param: "note",
        limit_bytes: EVIDENCE_SEGMENT_BYTES,
        actual_bytes: n,
      } as RequestError);
    }
    note = t;
  }
  const segments = evidence(get(params, "evidence"));

  const content = requestContent(params);
  return {
    id: id as ItemId,
    decision: decision as ResolveDecision,
    ...(itemVer !== undefined ? { itemVer } : {}),
    ...(candidate !== undefined ? { candidate } : {}),
    ...(note !== undefined ? { note } : {}),
    evidence: segments,
    ...(task !== undefined ? { task } : {}),
    requestKey: {
      content,
      ...(idempotencyKey !== undefined
        ? {
            idempotencyKey,
            fingerprint: createHash("sha256").update(content, "utf8").digest("hex"),
          }
        : {}),
    },
  };
}
