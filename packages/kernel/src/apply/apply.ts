// Apply: events → materialized state (docs/zh-CN/spec/02-architecture.md §4 `apply`;
// docs/zh-CN/spec/09-event-format.md §1.6, §5.2–§5.8, §5.12).
//
// The only implementation of how an event changes the materialized state. Each event is
//   1. parsed strictly (contract-core `parseEvent`): an invalid event stops apply, and so does one
//      whose block shapes have no checker yet;
//   2. checked for the version strings it records that the kernel must know (`ctx.ruleset_version`,
//      a compiled definition's `rsql`);
//   3. given what its plan reads from the state (`readInputs`: the compiled definition a switch
//      goes to, the item an item event updates), read in the caller's transaction;
//   4. turned into changes (`planEvent`, pure) and written in the caller's transaction.
// A type, or a form of one, without an implementation stops apply with an internal error; it is
// never skipped, since skipping would leave the state silently behind the log.
//
// Applied so far: the tenant and principal events; the path that creates a slot (./schema.ts);
// `source.recorded`; the request key index of head events; the pending item events (./items.ts);
// the block dependency index of every event applied.
// `write.head` changes nothing else in this phase (§5.7: its other blocks are read by timeline,
// replayed receipts, deletion replay and audit). Not yet: `write.base`, `write.derived`, deletion.

import {
  type CompiledSchema,
  canonicalize,
  type EventType,
  type JsonValue,
  parseEvent,
  type Seq,
} from "@fluxvita/saveslot-contract-core";
import type { BlockState, PreparedOperation } from "../log/index.ts";
import { isKnownRulesetVersion } from "../rules/version.ts";
import type { ReadTx, Tx } from "../store/ports.ts";
import { type ItemInput, planItem } from "./items.ts";
import { ApplyError, type BlockDepRow, type Change, type PrincipalRow } from "./model.ts";
import { planSchema, type SlotInput, type SwitchInput } from "./schema.ts";

export type { ItemInput } from "./items.ts";
export * from "./model.ts";
export { baseTableDdl, type SlotInput, type SwitchInput } from "./schema.ts";

/** One event as apply reads it: the header and the blocks by path, present or removed. */
export interface ApplyEvent {
  readonly seq: Seq;
  readonly header: Readonly<Record<string, JsonValue>>;
  readonly blocks: ReadonlyMap<string, BlockState>;
}

/** What a plan reads from the materialized state, read by the caller (`readInputs`). */
export interface PlanInputs {
  readonly switchTo?: SwitchInput;
  readonly slot?: SlotInput;
  readonly item?: ItemInput;
}

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

interface Parsed {
  readonly type: EventType;
  readonly present: Obj;
  readonly paths: readonly string[];
}

/** Parses an event and checks the versions it records. Pure; throws {@link ApplyError}. */
function parsed(ev: ApplyEvent): Parsed {
  const present: Record<string, JsonValue> = {};
  const removed: string[] = [];
  for (const [path, b] of ev.blocks) {
    if (b.state === "present") present[path] = b.value;
    else removed.push(path);
  }
  const r = parseEvent(ev.header, present, removed);
  if (!r.ok) {
    if (r.kind === "invalid") {
      throw new ApplyError("invalid", ev.seq, `invalid event: ${r.issues.join("; ")}`);
    }
    throw new ApplyError(
      "unsupported",
      ev.seq,
      `block shapes not supported yet: ${r.shapes.join(", ")}`,
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
  return { type: r.type, present, paths: [...ev.blocks.keys()] };
}

/** Parses, checks versions and returns the changes of one event. Pure; throws {@link ApplyError}. */
export function planEvent(ev: ApplyEvent, inputs: PlanInputs = {}): Change[] {
  const { type, present, paths } = parsed(ev);
  const block = (path: string) => present[path] as Obj;
  const op = (ev.header["op"] as Seq | undefined) ?? ev.seq;
  const slot = ev.header["slot"] as string | undefined;
  const changes =
    planPrincipals(type, ev.seq, block, present) ??
    planSchema(type, ev.seq, slot, block, inputs) ??
    planItem(type, ev.seq, op, slot, present, paths, inputs) ??
    planOther(type, ev.seq, slot, block, present);
  if (changes === undefined) {
    throw new ApplyError("not_implemented", ev.seq, `apply of ${type} is not implemented yet`);
  }
  const deps = blockDeps(ev.seq, present);
  if (deps.length > 0) changes.push({ kind: "block_deps", rows: deps });
  // §5.1: a head event's request key or explicit idempotency key now names this operation.
  const key = (present["request_key"] ?? present["idempotency"]) as Obj | undefined;
  if (key === undefined) return changes;
  return [
    ...changes,
    {
      kind: "request_key",
      key: key["key"] as string,
      op,
      at: ev.header["at"] as string,
      fingerprint: (key["fingerprint"] as string | undefined) ?? null,
    },
  ];
}

/** A contribution reference (§3.5): `{event, field, k}` or `{event, existence}`. */
function depOf(r: Obj): { dep_event: Seq; dep_field: string; dep_k: number } {
  return "existence" in r
    ? { dep_event: r["event"] as Seq, dep_field: "existence", dep_k: r["existence"] as number }
    : { dep_event: r["event"] as Seq, dep_field: r["field"] as string, dep_k: r["k"] as number };
}

/**
 * The block dependency index of an event (§5.12 块依赖索引, §3.5): each present data block's
 * `deps`. Removed blocks depend on nothing. (The `carried` contributions of `sources/*` come with
 * `write.base`.)
 */
function blockDeps(seq: Seq, present: Obj): BlockDepRow[] {
  const out: BlockDepRow[] = [];
  for (const path of Object.keys(present).sort()) {
    const v = present[path];
    const refs: { ref: Obj; kind: "deps" | "carried" }[] = [];
    const deps =
      v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj)["deps"] : undefined;
    if (Array.isArray(deps)) for (const r of deps as Obj[]) refs.push({ ref: r, kind: "deps" });
    refs.forEach(({ ref, kind }, n) => {
      out.push({ seq, path, n, ...depOf(ref), dep_kind: kind });
    });
  }
  return out;
}

function planPrincipals(
  type: EventType,
  seq: Seq,
  block: (path: string) => Obj,
  present: Obj,
): Change[] | undefined {
  const base = { name: null, scopes: null, slots: null, via: null, client: null };
  const nameOf = () => (present["name"] === undefined ? null : (block("name")["name"] as string));
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
      return undefined;
  }
}

function planOther(
  type: EventType,
  seq: Seq,
  slot: string | undefined,
  block: (path: string) => Obj,
  present: Obj,
): Change[] | undefined {
  switch (type) {
    // §5.6: the source is registered. (Its full-text index comes with the read path.)
    case "source.recorded": {
      const t = block("target");
      return [
        {
          kind: "source",
          seq,
          source_id: t["source_id"] as string,
          source_kind: t["kind"] as string,
          level: t["level"] as string,
          slot: slot as string,
        },
      ];
    }
    // §5.7: only its request key in this phase (added by the caller).
    case "write.head": {
      // §5.7: writes located by an external key, and a key given to a row, change the key index
      // and the sync baseline, which this phase does not keep yet.
      for (const [path, v] of Object.entries(present)) {
        if (!/^ops\/\d+\/target$/.test(path)) continue;
        const o = v as Obj;
        if ("key_from" in o || "by_external_key" in o) {
          throw new ApplyError(
            "not_implemented",
            seq,
            `${path}: writes by external key are not applied yet`,
          );
        }
      }
      return [];
    }
    default:
      return undefined;
  }
}

// --- what a plan reads -------------------------------------------------------------------------

const UPDATES_ITEM = new Set(["item.merged", "item.refreshed", "item.superseded", "item.resolved"]);

/** Reads, in the caller's transaction, what the plan of a parsed event needs from the state. */
async function readInputs(tx: ReadTx, ev: ApplyEvent, p: Parsed): Promise<PlanInputs> {
  if (p.type === "schema.switched") {
    // The definition switched to: the slot's `schema.compiled` of this draft and version.
    const t = p.present["target"] as Obj;
    const rows = await tx.query<{ seq: unknown; path: string; body: string | null }>(
      `SELECT c.seq, c.path, c.body FROM content c JOIN events e ON e.seq = c.seq
       WHERE e.slot = $1 AND e.type = 'schema.compiled' AND e.seq < $2
         AND c.path IN ('target', 'compiled') ORDER BY c.seq, c.path COLLATE "C"`,
      [ev.header["slot"] as string, ev.seq],
    );
    const bySeq = new Map<number, Record<string, JsonValue>>();
    for (const r of rows.rows) {
      const m = bySeq.get(Number(r.seq)) ?? {};
      bySeq.set(Number(r.seq), m);
      if (r.body !== null) m[r.path] = JSON.parse(r.body) as JsonValue;
    }
    let switchTo: SwitchInput | undefined;
    for (const [seq, b] of bySeq) {
      const target = b["target"] as Obj | undefined;
      if (
        target?.["draft_id"] === t["draft_id"] &&
        target?.["target_version"] === t["to_version"] &&
        b["compiled"] !== undefined
      ) {
        switchTo = { seq, compiled: b["compiled"] as unknown as CompiledSchema };
      }
    }
    // The slot as it is, and the table IDs the tenant already uses.
    const slotRow = await tx.query<{ current_sv: unknown; policy_seq: unknown }>(
      "SELECT current_sv, policy_seq FROM slots WHERE id = $1",
      [ev.header["slot"] as string],
    );
    const used = await tx.query<{ table_id: string }>("SELECT DISTINCT table_id FROM catalog");
    const row = slotRow.rows[0];
    const slot =
      row === undefined
        ? undefined
        : {
            currentSv: row.current_sv === null ? null : Number(row.current_sv),
            policySeq: row.policy_seq === null ? null : Number(row.policy_seq),
            tables: new Set(used.rows.map((r) => r.table_id)),
          };
    return {
      ...(switchTo !== undefined ? { switchTo } : {}),
      ...(slot !== undefined ? { slot } : {}),
    };
  }
  if (UPDATES_ITEM.has(p.type)) {
    const id = (p.present["target"] as Obj)["item"] as string;
    const r = await tx.query<{ state: string; next: unknown }>(
      `SELECT state, (SELECT COALESCE(MAX(n) + 1, 0) FROM pending_entries WHERE item_id = $1) AS next
       FROM pending_items WHERE id = $1`,
      [id],
    );
    const row = r.rows[0];
    return row === undefined ? {} : { item: { state: row.state, nextEntry: Number(row.next) } };
  }
  return {};
}

// --- writing -----------------------------------------------------------------------------------

async function one(
  tx: Tx,
  seq: Seq,
  sql: string,
  params: readonly (string | number | null)[],
  what: string,
) {
  const res = await tx.query(sql, params);
  if (res.affectedRows !== 1) throw new ApplyError("inconsistent", seq, what);
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
      await one(
        tx,
        seq,
        `INSERT INTO principals (id, kind, name, scopes, slots, via, client, state, registered_seq)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.kind, r.name, r.scopes, r.slots, r.via, r.client, r.state, r.registered_seq],
        `principal ${r.id} is already registered`,
      );
      return;
    }
    case "principal_rename":
      await one(
        tx,
        seq,
        "UPDATE principals SET name = $1 WHERE id = $2 AND kind = 'connection'",
        [c.name, c.id],
        `no connection ${c.id} to update`,
      );
      return;
    case "principal_revoke":
      await one(
        tx,
        seq,
        "UPDATE principals SET state = 'revoked' WHERE id = $1 AND kind = 'connection'",
        [c.id],
        `no connection ${c.id} to update`,
      );
      return;
    case "request_key":
      // A key may be used again once its window has passed: the latest operation holds it.
      await tx.query(
        `INSERT INTO request_keys (key, op, at, fingerprint) VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET op = EXCLUDED.op, at = EXCLUDED.at,
           fingerprint = EXCLUDED.fingerprint`,
        [c.key, c.op, c.at, c.fingerprint],
      );
      return;
    case "source":
      await one(
        tx,
        seq,
        `INSERT INTO sources (seq, source_id, kind, level, slot_id, deletion_state)
         VALUES ($1, $2, $3, $4, $5, 'present') ON CONFLICT DO NOTHING`,
        [c.seq, c.source_id, c.source_kind, c.level, c.slot],
        `source ${c.source_id} is already recorded`,
      );
      return;
    case "slot_insert":
      await one(
        tx,
        seq,
        "INSERT INTO slots (id, name, timezone) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
        [c.id, c.name, c.timezone],
        `slot ${c.id} already exists`,
      );
      return;
    case "slot_policy":
      await one(
        tx,
        seq,
        "UPDATE slots SET policy_seq = $1, policy_version = $2 WHERE id = $3",
        [c.seq, c.policy_version, c.id],
        `no slot ${c.id}`,
      );
      return;
    case "ddl":
      if (c.sql !== "") await tx.exec(c.sql);
      return;
    case "catalog_insert":
      await tx.query(
        "INSERT INTO catalog (table_id, sv, slot_id, structure) VALUES ($1, $2, $3, $4)",
        [c.table_id, c.sv, c.slot, c.structure],
      );
      return;
    case "counts_init":
      await tx.query("INSERT INTO counts (table_id, partition_key, row_count) VALUES ($1, '', 0)", [
        c.table_id,
      ]);
      return;
    case "version_switch":
      // The slot's first version (a slot being created): no earlier version to retire.
      await tx.query(
        "INSERT INTO schema_versions (slot_id, sv, compiled_seq, state) VALUES ($1, $2, $3, 'current')",
        [c.slot, c.sv, c.compiled_seq],
      );
      await one(
        tx,
        seq,
        "UPDATE slots SET current_sv = $1, name = $2, timezone = $3 WHERE id = $4",
        [c.sv, c.name, c.timezone, c.slot],
        `no slot ${c.slot}`,
      );
      return;
    case "item_insert": {
      const r = c.row;
      await one(
        tx,
        seq,
        `INSERT INTO pending_items (id, type, slot_id, target_table, target_row, state, version_op)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.type, r.slot_id, r.target_table, r.target_row, r.state, r.version_op],
        `item ${r.id} already exists`,
      );
      return;
    }
    case "item_update":
      await tx.query(
        `UPDATE pending_items SET state = COALESCE($2, state), decision = COALESCE($3, decision),
           version_op = COALESCE($4, version_op) WHERE id = $1`,
        [c.id, c.state ?? null, c.decision ?? null, c.version_op ?? null],
      );
      return;
    case "entries_insert":
      for (const e of c.entries) {
        await tx.query(
          "INSERT INTO pending_entries (item_id, n, content_seq, content_path) VALUES ($1, $2, $3, $4)",
          [e.item, e.n, e.seq, e.path],
        );
      }
      return;
    case "entries_drop":
      for (const g of c.groups) {
        await tx.query(
          `DELETE FROM pending_entries WHERE item_id = $1
             AND (content_path = $2 OR left(content_path, length($2) + 1) = $2 || '/')`,
          [c.item, g],
        );
      }
      for (const p of c.paths) {
        await tx.query("DELETE FROM pending_entries WHERE item_id = $1 AND content_path = $2", [
          c.item,
          p,
        ]);
      }
      return;
    case "flag_insert": {
      const r = c.row;
      await tx.query(
        `INSERT INTO flags (table_id, row_id, flag, item_id, fields, valid_from, valid_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [r.table_id, r.row_id, r.flag, r.item_id, r.fields, r.valid_from, r.valid_to],
      );
      return;
    }
    case "flag_valid":
      await tx.query("UPDATE flags SET valid_from = $2, valid_to = $3 WHERE item_id = $1", [
        c.item,
        c.from,
        c.to,
      ]);
      return;
    case "flags_drop":
      await tx.query("DELETE FROM flags WHERE item_id = $1", [c.item]);
      return;
    case "block_deps":
      for (const r of c.rows) {
        await tx.query(
          `INSERT INTO block_deps (seq, path, n, dep_event, dep_field, dep_k, dep_kind)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [r.seq, r.path, r.n, r.dep_event, r.dep_field, r.dep_k, r.dep_kind],
        );
      }
      return;
  }
}

/**
 * Applies events in order, in the caller's transaction. Stops at the first event it cannot apply
 * (throws {@link ApplyError}); the caller's transaction then rolls back.
 */
export async function applyEvents(tx: Tx, events: Iterable<ApplyEvent>): Promise<void> {
  for (const ev of events) {
    const inputs = await readInputs(tx, ev, parsed(ev));
    for (const c of planEvent(ev, inputs)) await write(tx, ev.seq, c);
  }
}
