// Apply: events → materialized state (docs/zh-CN/spec/02-architecture.md §4 `apply`;
// docs/zh-CN/spec/09-event-format.md §1.6, §5.2, §5.3).
//
// The only implementation of how an event changes the materialized state. Each event is
//   1. parsed strictly (contract-core `parseEvent`): an invalid event stops apply, and so does one
//      whose block shapes have no checker yet;
//   2. checked for the version strings it records that the kernel must know (`ctx.ruleset_version`);
//   3. turned into changes (`planEvent`, pure) and written in the caller's transaction.
// A type without an implementation stops apply with an internal error; it is never skipped, since
// skipping would leave the state silently behind the log.

import {
  canonicalize,
  type EventType,
  type JsonValue,
  parseEvent,
  type Seq,
} from "@fluxvita/saveslot-contract-core";
import type { BlockState, PreparedOperation } from "../log/index.ts";
import { isKnownRulesetVersion } from "../rules/version.ts";
import type { Tx } from "../store/ports.ts";

/** One event as apply reads it: the header and the blocks by path, present or removed. */
export interface ApplyEvent {
  readonly seq: Seq;
  readonly header: Readonly<Record<string, JsonValue>>;
  readonly blocks: ReadonlyMap<string, BlockState>;
}

export type ApplyErrorReason =
  /** Not a valid v1 event (§1.6). */
  | "invalid"
  /** A block shape the parser cannot check yet. */
  | "unsupported"
  /** A version string the kernel does not know (§1.6). */
  | "unknown_version"
  /** A type apply does not implement yet. */
  | "not_implemented"
  /** The event does not fit the state: an unknown principal, a principal registered twice. */
  | "inconsistent";

/** apply stopped. An internal error to the caller: the log is ahead of what this kernel can apply. */
export class ApplyError extends Error {
  override readonly name = "ApplyError";
  readonly reason: ApplyErrorReason;
  readonly seq: Seq;
  constructor(reason: ApplyErrorReason, seq: Seq, message: string) {
    super(`apply stopped at seq ${seq}: ${message}`);
    this.reason = reason;
    this.seq = seq;
  }
}

/** A row of `principals`, as apply writes it. JSON columns hold JCS text. */
export interface PrincipalRow {
  readonly id: string;
  readonly kind: "user" | "connection" | "system";
  readonly name: string | null;
  readonly scopes: string | null;
  readonly slots: string | null;
  readonly via: string | null;
  readonly client: string | null;
  readonly state: "active" | "revoked" | "disabled";
  readonly registered_seq: Seq;
}

/** One change to the materialized state. */
export type Change =
  | { readonly kind: "principal_insert"; readonly row: PrincipalRow }
  | { readonly kind: "principal_rename"; readonly id: string; readonly name: string | null }
  | { readonly kind: "principal_revoke"; readonly id: string }
  | { readonly kind: "tenant_id"; readonly tenant_id: string };

/** The events of an operation just appended, for apply in the same transaction. */
export function eventsOf(op: PreparedOperation): ApplyEvent[] {
  return op.events.map((e) => ({
    seq: e.seq,
    header: JSON.parse(e.header) as Record<string, JsonValue>,
    blocks: new Map(
      e.blocks.map((b): [string, BlockState] => [
        b.path,
        { state: "present", value: JSON.parse(b.body) as JsonValue },
      ]),
    ),
  }));
}

type Obj = Readonly<Record<string, JsonValue>>;

/** Parses, checks versions and returns the changes of one event. Pure; throws {@link ApplyError}. */
export function planEvent(ev: ApplyEvent): Change[] {
  const present: Record<string, JsonValue> = {};
  const removed: string[] = [];
  for (const [path, b] of ev.blocks) {
    if (b.state === "present") present[path] = b.value;
    else removed.push(path);
  }
  const parsed = parseEvent(ev.header, present, removed);
  if (!parsed.ok) {
    if (parsed.kind === "invalid") {
      throw new ApplyError("invalid", ev.seq, `invalid event: ${parsed.issues.join("; ")}`);
    }
    throw new ApplyError(
      "unsupported",
      ev.seq,
      `block shapes not supported yet: ${parsed.shapes.join(", ")}`,
    );
  }
  const ctx = present["ctx"] as Obj | undefined;
  if (ctx !== undefined && !isKnownRulesetVersion(ctx["ruleset_version"] as number)) {
    throw new ApplyError(
      "unknown_version",
      ev.seq,
      `unknown ruleset_version ${String(ctx["ruleset_version"])}`,
    );
  }
  const block = (path: string) => present[path] as Obj;
  const nameOf = () => (present["name"] === undefined ? null : (block("name")["name"] as string));
  return plan(parsed.type, ev.seq, block, nameOf);
}

function plan(
  type: EventType,
  seq: Seq,
  block: (path: string) => Obj,
  nameOf: () => string | null,
): Change[] {
  const base = { name: null, scopes: null, slots: null, via: null, client: null };
  switch (type) {
    // §5.2: the two principals of a new tenant, and the current tenant ID.
    case "tenant.genesis": {
      const user = block("user")["principal"] as string;
      return [
        { kind: "tenant_id", tenant_id: block("tenant")["tenant_id"] as string },
        {
          kind: "principal_insert",
          row: { ...base, id: user, kind: "user", state: "active", registered_seq: seq },
        },
        {
          kind: "principal_insert",
          row: { ...base, id: "system", kind: "system", state: "active", registered_seq: seq },
        },
      ];
    }
    // §5.3
    case "principal.registered": {
      const p = block("principal");
      const row: PrincipalRow = {
        id: p["principal"] as string,
        kind: "connection",
        name: nameOf(),
        scopes: canonicalize(p["scopes"] as JsonValue),
        slots: p["slots"] === undefined ? null : canonicalize(p["slots"] as JsonValue),
        via: p["via"] as string,
        client: (p["client"] as string | undefined) ?? null,
        state: "active",
        registered_seq: seq,
      };
      return [{ kind: "principal_insert", row }];
    }
    case "principal.renamed":
      return [
        { kind: "principal_rename", id: block("principal")["principal"] as string, name: nameOf() },
      ];
    case "principal.revoked":
      return [{ kind: "principal_revoke", id: block("principal")["principal"] as string }];
    default:
      throw new ApplyError("not_implemented", seq, `apply of ${type} is not implemented yet`);
  }
}

async function write(tx: Tx, seq: Seq, c: Change): Promise<void> {
  switch (c.kind) {
    case "tenant_id":
      // The current tenant ID follows the latest genesis or import event (§8 `meta`).
      await tx.query(
        `INSERT INTO meta (key, value) VALUES ('tenant_id', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [c.tenant_id],
      );
      return;
    case "principal_insert": {
      const r = c.row;
      const res = await tx.query(
        `INSERT INTO principals (id, kind, name, scopes, slots, via, client, state, registered_seq)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.kind, r.name, r.scopes, r.slots, r.via, r.client, r.state, r.registered_seq],
      );
      if (res.affectedRows !== 1) {
        throw new ApplyError("inconsistent", seq, `principal ${r.id} is already registered`);
      }
      return;
    }
    case "principal_rename":
    case "principal_revoke": {
      const res =
        c.kind === "principal_rename"
          ? await tx.query(
              "UPDATE principals SET name = $1 WHERE id = $2 AND kind = 'connection'",
              [c.name, c.id],
            )
          : await tx.query(
              "UPDATE principals SET state = 'revoked' WHERE id = $1 AND kind = 'connection'",
              [c.id],
            );
      if (res.affectedRows !== 1) {
        throw new ApplyError("inconsistent", seq, `no connection ${c.id} to update`);
      }
      return;
    }
  }
}

/**
 * Applies events in order, in the caller's transaction. Stops at the first event it cannot apply
 * (throws {@link ApplyError}); the caller's transaction then rolls back.
 */
export async function applyEvents(tx: Tx, events: Iterable<ApplyEvent>): Promise<void> {
  for (const ev of events) {
    for (const c of planEvent(ev)) await write(tx, ev.seq, c);
  }
}
