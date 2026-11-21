// Apply: events → materialized state (docs/zh-CN/spec/02-architecture.md §4 `apply`;
// docs/zh-CN/spec/09-event-format.md §1.6, §5.2–§5.8, §5.12).
//
// The only implementation of how an event changes the materialized state. Each event is
//   1. parsed strictly (contract-core `parseEvent`): an invalid event stops apply, and so does one
//      whose block shapes have no checker yet;
//   2. checked for the version strings it records that the kernel must know (`ctx.ruleset_version`,
//      a compiled definition's `rsql`);
//   3. given what its plan reads from the state (`readInputs`: the compiled definition a switch
//      goes to, the item an item event updates, the row a base write settles), read in the
//      caller's transaction;
//   4. turned into changes (`planEvent`, pure) and written in the caller's transaction.
// A type, or a form of one, without an implementation stops apply with an internal error; it is
// never skipped, since skipping would leave the state silently behind the log.
//
// Applied so far: the tenant and principal events; the path that creates a slot (./schema.ts);
// `source.recorded`; the request key index of head events; the pending item events (./items.ts);
// `write.base` (./write-base.ts: the source table, "reverted" registrations, the row settled from
// all its items into the business and version tables); the block dependency index of every
// event applied; `write.derived` (./derived.ts: the partition recomputed and checked, the derived
// row, `partitions`, `derived_reads`). `write.head` changes nothing else in this phase (§5.7: its
// other blocks are read by timeline, replayed receipts, deletion replay and audit). Not yet:
// deletion.

import {
  type BizPoint,
  type CompiledBaseTable,
  type CompiledSchema,
  canonicalize,
  type EventType,
  type JsonValue,
  parseEvent,
  type Seq,
} from "@fluxvita/saveslot-contract-core";
import type { BlockState, PreparedOperation } from "../log/index.ts";
import { readEvents } from "../log/log.ts";
import { type DerivedRow, evaluateRule, evaluating, RuleEvaluationError } from "../rules/index.ts";
import { isKnownLiteralChecker, isKnownRulesetVersion } from "../rules/version.ts";
import type { ReadTx, SqlValue, Tx } from "../store/ports.ts";
import type { ValidParam } from "../time/index.ts";
import { confirmationHash, entryChecksums } from "./confirmation.ts";
import { canonicalKeyFault, type DerivedInput, planDerived } from "./derived.ts";
import { type ItemInput, planItem } from "./items.ts";
import { ApplyError, type BlockDepRow, type Change, type PrincipalRow } from "./model.ts";
import {
  type CoveredEvent,
  type OpPremise,
  planBasePremises,
  planHeadPremises,
  planPremiseChanged,
} from "./premises.ts";
import { planSchema, type RemoveInput, type SlotInput, type SwitchInput } from "./schema.ts";
import type { SettleItem } from "./settle.ts";
import { type OpenCell, planWriteBase, storedValid, type WriteBaseInput } from "./write-base.ts";

export type { ItemInput } from "./items.ts";
export * from "./model.ts";
export { baseTableDdl, type SlotInput, type SwitchInput } from "./schema.ts";
export type { OpenCell, WriteBaseInput } from "./write-base.ts";

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
  readonly remove?: RemoveInput;
  readonly item?: ItemInput;
  readonly writeBase?: WriteBaseInput;
  /** A `write.base`'s op's premise declarations (§5.7), from `premise_decls`. */
  readonly premises?: readonly OpPremise[];
  /** A `write.head`'s `premise_covers`: the events they name, as the log has them. */
  readonly covered?: ReadonlyMap<Seq, CoveredEvent>;
  readonly derived?: DerivedInput;
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
  // Without a prototype: a block at path `__proto__` is then an ordinary key that `parseEvent`
  // checks like any other, not a change of the object's prototype.
  const present: Record<string, JsonValue> = Object.create(null);
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
  // The literal checks were recorded by a checker of this version: one this kernel does not know
  // is not a recorded result it can stand by (09 §1.6).
  const checker = ctx?.["literal_checker"];
  if (typeof checker === "string" && !isKnownLiteralChecker(checker)) {
    throw new ApplyError("unknown_version", ev.seq, `unknown literal_checker ${checker}`);
  }
  return { type: r.type, present, paths: [...ev.blocks.keys()] };
}

/** The paths of an event's blocks a deletion cleared. */
const removedOf = (ev: ApplyEvent): ReadonlySet<string> =>
  new Set([...ev.blocks].filter(([, b]) => b.state !== "present").map(([path]) => path));

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
    planBase(type, ev.seq, op, present, inputs) ??
    (type === "write.derived"
      ? planDerived(ev.seq, op, present, removedOf(ev), inputs.derived)
      : undefined) ??
    planOther(type, ev.seq, op, slot, ev.header["actor"] as string, block, present, inputs);
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
 * `deps`, and the `carried` contributions of `sources/*` entries. Removed blocks depend on nothing.
 */
function blockDeps(seq: Seq, present: Obj): BlockDepRow[] {
  const out: BlockDepRow[] = [];
  for (const path of Object.keys(present).sort()) {
    const v = present[path];
    const refs: { ref: Obj; kind: "deps" | "carried" }[] = [];
    const deps =
      v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj)["deps"] : undefined;
    if (Array.isArray(deps)) for (const r of deps as Obj[]) refs.push({ ref: r, kind: "deps" });
    if (path.startsWith("sources/") && Array.isArray(v)) {
      for (const e of v as Obj[]) {
        if (e["carried"] !== undefined) refs.push({ ref: e["carried"] as Obj, kind: "carried" });
      }
    }
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
    // §5.2: every user and connection registered before the import and still active is disabled
    // (`system` aside; a revoked one stays revoked); the importing user is registered and active, also when the imported log registered
    // them (a user importing their own export); the current tenant ID is the target's. The current
    // restore count is the header's (`restoreCount` in write/reads.ts reads it from there).
    case "tenant.imported": {
      const user = block("user")["principal"] as string;
      return [
        { kind: "tenant_id", tenant_id: block("tenant")["tenant_id"] as string },
        { kind: "principals_disable" },
        {
          kind: "principal_import_user",
          row: { ...base, id: user, kind: "user", state: "active", registered_seq: seq },
        },
      ];
    }
    // §5.2: a restore changes nothing in the materialized state; the current restore count is the
    // latest restore or import event's header's (store/restore-point.ts reads it from there).
    case "tenant.restored":
      return [];
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

function planBase(
  type: EventType,
  seq: Seq,
  op: Seq,
  present: Obj,
  inputs: PlanInputs,
): Change[] | undefined {
  if (type !== "write.base") return undefined;
  if (inputs.writeBase === undefined) {
    throw new ApplyError("inconsistent", seq, "no table to write to");
  }
  return [
    ...planWriteBase(seq, op, present, inputs.writeBase),
    ...planBasePremises(seq, op, present, inputs.premises ?? []),
  ];
}

function planOther(
  type: EventType,
  seq: Seq,
  op: Seq,
  slot: string | undefined,
  actor: string,
  block: (path: string) => Obj,
  present: Obj,
  inputs: PlanInputs,
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
    // §5.7: its premise declarations and what they cover; its request key is added by the caller.
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
      return planHeadPremises(seq, actor, present, inputs.covered ?? new Map());
    }
    case "premise.changed":
      return planPremiseChanged(seq, op, present);
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
         AND c.path IN ('target', 'compiled', 'changes') ORDER BY c.seq, c.path COLLATE "C"`,
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
        switchTo = {
          seq,
          compiled: b["compiled"] as unknown as CompiledSchema,
          ...(Array.isArray(b["changes"])
            ? { changes: b["changes"] as unknown as SwitchInput["changes"] & object }
            : {}),
        };
      }
    }
    // A switch from an earlier version: that version's definition, the slot's current one.
    if (switchTo !== undefined && "from_version" in t) {
      const f = await tx.query<{ body: string | null }>(
        `SELECT c.body FROM schema_versions v JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
         WHERE v.slot_id = $1 AND v.sv = $2`,
        [ev.header["slot"] as string, t["from_version"] as number],
      );
      const body = f.rows[0]?.body;
      if (body != null) switchTo = { ...switchTo, from: JSON.parse(body) as CompiledSchema };
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
  if (p.type === "slot.removed") {
    // The slot as it is, and its current version's compiled definition.
    const r = await tx.query<{ current_sv: unknown; body: string | null }>(
      `SELECT s.current_sv, c.body FROM slots s
       LEFT JOIN schema_versions v ON v.slot_id = s.id AND v.sv = s.current_sv
       LEFT JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
       WHERE s.id = $1`,
      [ev.header["slot"] as string],
    );
    const row = r.rows[0];
    if (row === undefined) return {};
    return {
      remove: {
        currentSv: row.current_sv === null ? null : Number(row.current_sv),
        compiled: row.body === null ? undefined : (JSON.parse(row.body) as CompiledSchema),
      },
    };
  }
  if (p.type === "write.head") {
    // The events `premise_covers` names: in the log already, a later event of this operation
    // included (an operation's events are appended before any is applied).
    const seqs = new Set<number>();
    for (const [path, v] of Object.entries(p.present))
      if (/^ops\/\d+\/premise_covers$/.test(path))
        for (const r of v as readonly Obj[]) seqs.add(r["event"] as number);
    if (seqs.size === 0) return {};
    const list = [...seqs];
    const params = list.map((_, k) => `$${k + 1}`).join(", ");
    const evs = await tx.query<{
      seq: unknown;
      op: unknown;
      type: string;
      target_row: string | null;
    }>(`SELECT seq, op, type, target_row FROM events WHERE seq IN (${params})`, list);
    const blocks = await tx.query<{ seq: unknown; path: string; body: string | null }>(
      `SELECT seq, path, body FROM content WHERE seq IN (${params})`,
      list,
    );
    const covered = new Map<Seq, CoveredEvent>();
    const paths = new Map<number, Set<string>>();
    const opIndex = new Map<number, number>();
    for (const b of blocks.rows) {
      const n = Number(b.seq);
      paths.set(n, (paths.get(n) ?? new Set<string>()).add(b.path));
      if (b.path === "target" && b.body !== null) {
        const i = (JSON.parse(b.body) as { op_index?: unknown }).op_index;
        if (typeof i === "number") opIndex.set(n, i);
      }
    }
    for (const e of evs.rows) {
      const n = Number(e.seq);
      covered.set(n as Seq, {
        op: Number(e.op) as Seq,
        type: e.type,
        row: e.target_row,
        opIndex: opIndex.get(n) ?? null,
        items: paths.get(n) ?? new Set<string>(),
      });
    }
    return { covered };
  }
  if (p.type === "write.base") {
    const op = ev.header["op"] as Seq;
    const i = (p.present["target"] as Obj)["op_index"];
    const decls = await tx.query<{ decl_index: unknown; target_row: string }>(
      `SELECT decl_index, target_row FROM premise_decls WHERE op = $1 AND op_index = $2
       ORDER BY decl_index`,
      [op, i as number],
    );
    return {
      writeBase: await readRow(tx, ev, p),
      premises: decls.rows.map((r) => ({
        decl_index: Number(r.decl_index),
        target_row: r.target_row,
      })),
    };
  }
  if (p.type === "write.derived") {
    const derived = await readDerived(tx, ev, p);
    return derived === undefined ? {} : { derived };
  }
  if (UPDATES_ITEM.has(p.type)) {
    const id = (p.present["target"] as Obj)["item"] as string;
    const r = await tx.query<{ state: string; next: unknown }>(
      `SELECT state, (SELECT COALESCE(MAX(n) + 1, 0) FROM pending_entries WHERE item_id = $1) AS next
       FROM pending_items WHERE id = $1`,
      [id],
    );
    const row = r.rows[0];
    if (row === undefined) return {};
    const confirmation =
      p.type === "item.resolved" ? confirmationHash(await entryChecksums(tx, id)) : undefined;
    return {
      item: {
        state: row.state,
        nextEntry: Number(row.next),
        ...(confirmation !== undefined ? { confirmation } : {}),
      },
    };
  }
  return {};
}

/** What the plan of a `write.derived` reads: the slot's definition, the partition, recomputed. */
async function readDerived(
  tx: ReadTx,
  ev: ApplyEvent,
  p: Parsed,
): Promise<DerivedInput | undefined> {
  const slot = ev.header["slot"] as string;
  const cur = await tx.query<{ body: string | null }>(
    `SELECT c.body FROM schema_versions v JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
     WHERE v.slot_id = $1 AND v.state = 'current'`,
    [slot],
  );
  const body = cur.rows[0]?.body;
  if (body === undefined || body === null) return undefined;
  const schema = JSON.parse(body) as CompiledSchema;
  const target = p.present["target"] as Obj;
  const tableId = target["table"] as string;
  const partition = target["partition"] as string;
  const table = schema.tables.find((t) => t.id === tableId);
  if (table === undefined || table.kind !== "derived") return undefined;

  const reg = await tx.query<{ group_key: string | null }>(
    "SELECT group_key FROM partitions WHERE derived_table_id = $1 AND partition_id = $2",
    [tableId, partition],
  );
  const registered = reg.rows[0] === undefined ? undefined : { groupKey: reg.rows[0].group_key };
  const keyBlock = p.present["key"] as Obj | undefined;
  // A key block in the canonical form of the key fields' types, or nothing is looked up with it.
  const keyFault =
    keyBlock === undefined ? undefined : canonicalKeyFault(table, keyBlock["values"] as JsonValue);
  let keyTakenBy: string | undefined;
  let idTakenBy: string | undefined;
  if (keyBlock !== undefined && keyFault === undefined) {
    const taken = await tx.query<{ partition_id: string }>(
      "SELECT partition_id FROM partitions WHERE derived_table_id = $1 AND group_key = $2",
      [tableId, canonicalize(keyBlock["values"] as JsonValue)],
    );
    keyTakenBy = taken.rows[0]?.partition_id;
    // partition_id is unique in the tenant (01-objects «标识的写法»), not only in its table.
    const other = await tx.query<{ derived_table_id: string }>(
      "SELECT derived_table_id FROM partitions WHERE partition_id = $1 AND derived_table_id <> $2",
      [partition, tableId],
    );
    idTakenBy = other.rows[0]?.derived_table_id;
  }
  const physical = table.physical.table;
  const ex = await tx.query(`SELECT 1 FROM "${physical}" WHERE partition_id = $1`, [partition]);
  const exists = ex.rows.length > 0;

  // The key to recompute with: the event's, or the one registered.
  const key =
    keyBlock !== undefined
      ? (keyBlock["values"] as readonly FieldValueOf[])
      : registered?.groupKey != null
        ? (JSON.parse(registered.groupKey) as readonly FieldValueOf[])
        : undefined;
  let recomputed: DerivedInput["recomputed"];
  if (keyFault !== undefined) recomputed = { error: keyFault };
  else if (key !== undefined) {
    const e = evaluateRule(schema, table.id);
    if (key.length !== (table.rule.scope.kind === "tenant" ? 0 : table.rule.scope.key.length)) {
      recomputed = { error: `a key of ${key.length} values` };
    } else {
      // Only the evaluation (its query and decoding) failing on the data is the recomputation's
      // error; reading the derived table or its partitions above fails as it does.
      try {
        const q = e.partition(key);
        const rows = await evaluating(async () => {
          const out: DerivedRow[] = [];
          for (const r of (await tx.query<Record<string, unknown>>(q.sql, q.params)).rows) {
            const d = e.decode(r);
            if (d !== undefined) out.push(d);
          }
          return out;
        });
        recomputed = { rows };
      } catch (x) {
        if (x instanceof RuleEvaluationError) recomputed = { error: x.message };
        else throw x;
      }
    }
  }
  return {
    schema,
    registered,
    keyTakenBy,
    ...(idTakenBy !== undefined ? { idTakenBy } : {}),
    recomputed,
    exists,
  };
}

type FieldValueOf = DerivedRow["key"][number];

/** A stored instant or date column as the event format writes it. */
const asText = (col: string, instant: boolean) =>
  instant ? `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` : `${col}::text`;

/** What a `write.base` settles: its table, the row's items, open cells and row count. */
async function readRow(tx: ReadTx, ev: ApplyEvent, p: Parsed): Promise<WriteBaseInput> {
  const target = p.present["target"] as Obj;
  const tableId = target["table"] as string;
  const rowId = (target["row"] ?? target["entity"]) as string;
  // The slot's versions in effect so far, the current one with its definition: one statement.
  const v = await tx.query<{ sv: unknown; state: string; body: string | null }>(
    `SELECT s.sv, s.state, c.body FROM schema_versions s
     LEFT JOIN content c ON s.state = 'current' AND c.seq = s.compiled_seq AND c.path = 'compiled'
     WHERE s.slot_id = $1 AND s.state IN ('current', 'retired')`,
    [ev.header["slot"] as string],
  );
  const current = v.rows.find((x) => x.state === "current");
  const knownSv = new Set(v.rows.map((x) => Number(x.sv)));
  const body = current?.body;
  const sv = Number(current?.sv);
  const table =
    body === undefined || body === null
      ? undefined
      : ((JSON.parse(body) as CompiledSchema).tables.find(
          (t) => t.id === tableId && t.kind === "base",
        ) as CompiledBaseTable | undefined);
  if (table === undefined) {
    throw new ApplyError(
      "inconsistent",
      ev.seq,
      `no table ${tableId} in the slot's current version`,
    );
  }
  const stored = await tx.query<{
    event_seq: unknown;
    field_id: string;
    k: number;
    status: "applied" | "corroborated";
    valid_from: string | null;
    valid_to: string | null;
    reverted: string;
    body: string | null;
  }>(
    `SELECT b.event_seq, b.field_id, b.k, b.status, b.valid_from, b.valid_to, b.reverted, c.body
     FROM base_sources b LEFT JOIN content c ON c.seq = b.event_seq AND c.path =
       CASE WHEN b.field_id = 'existence' THEN 'existence/' || b.k ELSE 'fields/' || b.field_id || '/' || b.k END
     WHERE b.row_id = $1 AND b.n = 0 ORDER BY b.event_seq, b.field_id COLLATE "C", b.k`,
    [rowId],
  );
  const items: SettleItem[] = [];
  for (const r of stored.rows) {
    if (r.body === null) continue; // the block was removed (a deletion's tombstone)
    const b = JSON.parse(r.body) as Obj;
    const existence = r.field_id === "existence";
    items.push({
      event: Number(r.event_seq),
      target: r.field_id as SettleItem["target"],
      k: r.k,
      status: r.status,
      valid: storedValid(r.valid_from, r.valid_to),
      content: existence
        ? b["restored"] === true
          ? { kind: "restore" }
          : { kind: "revoke" }
        : "value" in b
          ? { kind: "value", value: b["value"] as never }
          : "no_value" in b
            ? { kind: "no_value" }
            : { kind: "uncovered" },
      reverted: (
        JSON.parse(r.reverted) as { op: Seq; valid: { from: string | null; to: string | null }[] }[]
      ).map((x) => ({ op: x.op, valid: x.valid as never })),
    });
  }
  const isState = table.time.type === "state";
  const instant = isState && table.time.type === "state" && table.time.granularity === "instant";
  const name = table.physical.table;
  const cells = await tx.query<{
    field_id: string;
    valid_from: string | null;
    valid_to: string | null;
    src_event: unknown;
    src_field: string | null;
    src_k: number | null;
    no_value: boolean | null;
    rec_from: unknown;
  }>(
    `SELECT field_id, ${isState ? asText("valid_from", instant) : "NULL"} AS valid_from,
       ${isState ? asText("valid_to", instant) : "NULL"} AS valid_to, src_event, src_field, src_k,
       no_value, rec_from
     FROM "${name}__ver" WHERE row_id = $1 AND rec_to IS NULL`,
    [rowId],
  );
  const openCells: OpenCell[] = cells.rows.map((c) => ({
    field: c.field_id,
    valid_from: c.valid_from,
    valid_to: c.valid_to,
    src:
      c.src_event === null
        ? null
        : { event: Number(c.src_event), target: c.src_field as never, k: c.src_k as number },
    no_value: c.no_value === true,
    rec_from: Number(c.rec_from),
  }));
  const count = await tx.query<{ n: unknown }>(
    isState
      ? `SELECT count(*) AS n FROM "${name}" WHERE entity_id = $1`
      : `SELECT count(*) AS n FROM "${name}" WHERE row_id = $1 AND NOT revoked`,
    [rowId],
  );
  const origin = await tx.query<{ table_id: string }>(
    "SELECT table_id FROM row_origins WHERE row_id = $1",
    [rowId],
  );
  const written = await writtenInterval(tx, ev, p, table);
  return {
    table,
    items,
    openCells,
    count: Number(count.rows[0]?.n ?? 0),
    sv,
    knownSv,
    rowTable: origin.rows[0]?.table_id ?? null,
    ...(written !== undefined ? { written } : {}),
  };
}

/**
 * A caller's write or revoke on a state table (05-time «佐证端点»): its interval as written (the
 * head's `ops/<i>/valid`) and "now" (its `ctx`, `today` or `now` by the table's granularity), as
 * judge reads them. Undefined for any other `write.base`: a revert's write-backs (it has
 * `revert`), a decision's write (its head is no `write.head`), or a table without time; and when
 * the block is not there to read: no explicit ends then, never "now" in their place.
 *
 * The head is read and parsed as apply reads any event: a block present, or removed by a
 * tombstone. A caller's write on a state table always has the block (09 §5.7; the write pipeline
 * checks it when encoding); it is not there when a deletion removed it, or, on import, when it is
 * a pending deletion's placeholder. A revoke without bounds has none, and is read as judge reads it.
 */
async function writtenInterval(
  tx: ReadTx,
  ev: ApplyEvent,
  p: Parsed,
  table: CompiledBaseTable,
): Promise<{ valid: ValidParam | undefined; now: BizPoint } | undefined> {
  // The conditions are judge's (judge/state.ts, the items of a record: explicit ends only for a
  // write or a revoke). In this version they decide nothing: only a caller's write gives a
  // corroboration (a revert's write-backs and a decision's items never are one), so mutating
  // them changes no row; they are kept so that both read the log the same way.
  if (table.time.type !== "state" || p.present["revert"] !== undefined) return undefined;
  const index = (p.present["target"] as Obj)["op_index"];
  if (typeof index !== "number") return undefined;
  const op = Number(ev.header["op"]);
  const stored = (await readEvents(tx, op, op))[0];
  if (stored === undefined || stored.header["type"] !== "write.head") return undefined;
  const head = parsed(stored);
  const ctx = head.present["ctx"] as { now: string; today: string };
  const path = `ops/${index}/valid`;
  const block = stored.blocks.get(path);
  if (block === undefined) {
    const t = head.present[`ops/${index}/target`] as Obj | undefined;
    return t?.["intent"] === "revoke" ? { valid: undefined, now: nowOf(table, ctx) } : undefined;
  }
  if (block.state !== "present") return undefined;
  const raw = block.value as { from: { mode: string }; to: { mode: string } };
  // `corrected_span` is written with both ends' mode so (09 §5.7).
  const valid =
    raw.from.mode === "corrected_span"
      ? ("corrected_span" as const)
      : (raw as unknown as Exclude<ValidParam, "corrected_span">);
  return { valid, now: nowOf(table, ctx) };
}

const nowOf = (table: CompiledBaseTable, ctx: { now: string; today: string }) =>
  ((table.time as { granularity?: string }).granularity === "date"
    ? ctx.today
    : ctx.now) as BizPoint;

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

async function insert(tx: Tx, table: string, columns: readonly string[], row: readonly SqlValue[]) {
  const cols = columns.map((x) => (x.startsWith("f_") ? `"${x}"` : x)).join(", ");
  await tx.query(
    `INSERT INTO ${table} (${cols}) VALUES (${row.map((_, i) => `$${i + 1}`).join(", ")})`,
    row,
  );
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
    case "principals_disable":
      await tx.query(
        "UPDATE principals SET state = 'disabled' WHERE kind <> 'system' AND state = 'active'",
      );
      return;
    case "principal_import_user": {
      const r = c.row;
      // Registered by the imported log: the same user, kept with its registration, active again.
      await one(
        tx,
        seq,
        `INSERT INTO principals (id, kind, name, scopes, slots, via, client, state, registered_seq)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET state = 'active' WHERE principals.kind = 'user'`,
        [r.id, r.kind, r.name, r.scopes, r.slots, r.via, r.client, r.state, r.registered_seq],
        `principal ${r.id} is registered, and not as a user`,
      );
      return;
    }
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
    case "slot_remove":
      for (const t of c.tables) {
        await tx.query("DELETE FROM counts WHERE table_id = $1", [t]);
      }
      await tx.query("DELETE FROM catalog WHERE slot_id = $1", [c.slot]);
      await one(tx, seq, "DELETE FROM slots WHERE id = $1", [c.slot], `no slot ${c.slot}`);
      return;
    case "counts_init":
      await tx.query("INSERT INTO counts (table_id, partition_key, row_count) VALUES ($1, '', 0)", [
        c.table_id,
      ]);
      return;
    case "version_switch":
      if (c.from !== undefined) {
        // From an earlier version: it is retired, the pending draft's version becomes current.
        await one(
          tx,
          seq,
          "UPDATE schema_versions SET state = 'retired' WHERE slot_id = $1 AND sv = $2 AND state = 'current'",
          [c.slot, c.from],
          `version ${c.from} of ${c.slot} is not current`,
        );
        await one(
          tx,
          seq,
          `UPDATE schema_versions SET state = 'current'
           WHERE slot_id = $1 AND sv = $2 AND draft_id = $3 AND state = 'pending'`,
          [c.slot, c.sv, c.draft_id],
          `version ${c.sv} of ${c.slot} is not the pending draft ${c.draft_id}`,
        );
        await one(
          tx,
          seq,
          "UPDATE slots SET current_sv = $1, name = $2, timezone = $3 WHERE id = $4",
          [c.sv, c.name, c.timezone, c.slot],
          `no slot ${c.slot}`,
        );
        return;
      }
      // The slot's first version (a slot being created): no earlier version to retire.
      await tx.query(
        `INSERT INTO schema_versions (slot_id, sv, compiled_seq, draft_id, state)
         VALUES ($1, $2, $3, $4, 'current')`,
        [c.slot, c.sv, c.compiled_seq, c.draft_id],
      );
      await one(
        tx,
        seq,
        "UPDATE slots SET current_sv = $1, name = $2, timezone = $3 WHERE id = $4",
        [c.sv, c.name, c.timezone, c.slot],
        `no slot ${c.slot}`,
      );
      return;
    case "version_pending":
      // A number taken once is not taken again: a second draft of the same number is the log at
      // odds with itself.
      await one(
        tx,
        seq,
        `INSERT INTO schema_versions (slot_id, sv, compiled_seq, draft_id, state)
         VALUES ($1, $2, $3, $4, 'pending') ON CONFLICT (slot_id, sv) DO NOTHING`,
        [c.slot, c.sv, c.compiled_seq, c.draft_id],
        `version ${c.sv} of ${c.slot} is taken already`,
      );
      return;
    case "version_given_up":
      await one(
        tx,
        seq,
        `UPDATE schema_versions SET state = $1
         WHERE slot_id = $2 AND draft_id = $3 AND state = 'pending'`,
        [c.state, c.slot, c.draft_id],
        `no pending draft ${c.draft_id} in ${c.slot}`,
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
        `INSERT INTO flags (table_id, row_id, flag, item_id, fields, spans)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [r.table_id, r.row_id, r.flag, r.item_id, r.fields, r.spans],
      );
      return;
    }
    case "flag_valid":
      await tx.query("UPDATE flags SET spans = $2 WHERE item_id = $1", [c.item, c.spans]);
      return;
    case "flags_drop":
      await tx.query("DELETE FROM flags WHERE item_id = $1", [c.item]);
      return;
    case "rows_insert":
      for (const r of c.rows) await insert(tx, c.table, c.columns, r);
      return;
    case "base_sources_reverted":
      await one(
        tx,
        seq,
        `UPDATE base_sources SET reverted = $1
         WHERE event_seq = $2 AND row_id = $3 AND field_id = $4 AND k = $5 AND n = 0`,
        [c.reverted, c.event, c.row_id, c.field, c.k],
        `no item ${c.event}/${c.field}/${c.k} of ${c.row_id} in the source table`,
      );
      await tx.query(
        `UPDATE base_sources SET reverted = $1
         WHERE event_seq = $2 AND row_id = $3 AND field_id = $4 AND k = $5 AND n > 0`,
        [c.reverted, c.event, c.row_id, c.field, c.k],
      );
      return;
    case "row_origin":
      await tx.query(
        `INSERT INTO row_origins (row_id, table_id, origin_seq) VALUES ($1, $2, $3)
         ON CONFLICT (row_id) DO UPDATE SET table_id = EXCLUDED.table_id, origin_seq = EXCLUDED.origin_seq`,
        [c.row_id, c.table_id, c.seq],
      );
      return;
    case "rows_replace":
      await tx.query(`DELETE FROM "${c.table}" WHERE ${c.key} = $1`, [c.id]);
      for (const r of c.rows) await insert(tx, `"${c.table}"`, c.columns, r);
      return;
    case "cells":
      for (const x of c.close) {
        const at = c.state ? " AND valid_from = $3" : "";
        const params = c.state
          ? [c.row_id, x.field, x.valid_from, x.rec_from]
          : [c.row_id, x.field, x.rec_from];
        const rec = c.state ? "$4" : "$3";
        // A cell this operation opened is overwritten in place: the version table keeps one
        // version per cell and operation (02-architecture §8 版本表).
        if (x.rec_from === c.op) {
          await tx.query(
            `DELETE FROM "${c.table}" WHERE row_id = $1 AND field_id = $2${at} AND rec_from = ${rec}`,
            params,
          );
        } else {
          await tx.query(
            `UPDATE "${c.table}" SET rec_to = ${c.state ? "$5" : "$4"}
             WHERE row_id = $1 AND field_id = $2${at} AND rec_from = ${rec}`,
            [...params, c.op],
          );
        }
      }
      for (const r of c.rows) await insert(tx, `"${c.table}"`, c.columns, r);
      return;
    case "counts_add":
      await one(
        tx,
        seq,
        "UPDATE counts SET row_count = row_count + $2 WHERE table_id = $1 AND partition_key = ''",
        [c.table_id, c.delta],
        `no count of ${c.table_id}`,
      );
      return;
    case "partition_insert":
      await tx.query(
        "INSERT INTO partitions (derived_table_id, partition_id, group_key) VALUES ($1, $2, $3)",
        [c.table_id, c.partition, c.group_key],
      );
      return;
    case "derived_set":
      await tx.query(`DELETE FROM "${c.table}" WHERE partition_id = $1`, [c.partition]);
      await insert(
        tx,
        `"${c.table}"`,
        ["partition_id", ...c.columns, "ver"],
        [c.partition, ...c.values, c.ver],
      );
      return;
    case "derived_delete":
      await one(
        tx,
        seq,
        `DELETE FROM "${c.table}" WHERE partition_id = $1`,
        [c.partition],
        `no derived row ${c.partition}`,
      );
      return;
    case "derived_reads":
      for (const r of c.rows) {
        await tx.query(
          `INSERT INTO derived_reads (derived_seq, base_table_id, partition_id, rule_version, read_pos)
           VALUES ($1, $2, $3, $4, $5)`,
          [r.derived_seq, r.base_table_id, r.partition_id, r.rule_version, r.read_pos],
        );
      }
      return;
    case "premise_decls":
      for (const r of c.rows) {
        await insert(tx, "premise_decls", Object.keys(r), Object.values(r) as SqlValue[]);
      }
      return;
    case "premise_edges":
      // The latest declaration covering an item for a target is the one in force: latest by its
      // op (operation, then op index), not by when its edge arrives. Edges do not arrive in that
      // order: a request's `write.base` events come after its head, whose blocks are in path order
      // ("ops/10" before "ops/2"). A clearing entry (`*`) is ordered the same way.
      for (const r of c.rows) {
        await tx.query(
          `INSERT INTO premise_edges (item_event, field_id, k, target, decl_op, decl_op_index, decl_index)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (item_event, field_id, k, target) DO UPDATE
             SET decl_op = excluded.decl_op, decl_op_index = excluded.decl_op_index,
                 decl_index = excluded.decl_index
             WHERE (excluded.decl_op, excluded.decl_op_index)
                 > (premise_edges.decl_op, premise_edges.decl_op_index)`,
          [r.item_event, r.field_id, r.k, r.target, r.decl_op, r.decl_op_index, r.decl_index],
        );
      }
      return;
    case "premise_state":
      for (const r of c.rows) {
        const u = await tx.query(
          `UPDATE premise_decls SET state = $4, reason = $5, since = $6
           WHERE op = $1 AND op_index = $2 AND decl_index = $3 RETURNING op`,
          [r.op, r.op_index, r.decl_index, r.state, r.reason, r.since],
        );
        if (u.rows.length !== 1)
          throw new ApplyError(
            "inconsistent",
            seq,
            `premise.changed names a declaration not there: ${r.op}/${r.op_index}/${r.decl_index}`,
          );
      }
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
