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
  type CompiledBaseTable,
  type CompiledSchema,
  canonicalize,
  type EventType,
  type JsonValue,
  parseEvent,
  type Seq,
} from "@fluxvita/saveslot-contract-core";
import type { BlockState, PreparedOperation } from "../log/index.ts";
import { type DerivedRow, evaluateRule, RuleEvaluationError } from "../rules/index.ts";
import { isKnownRulesetVersion } from "../rules/version.ts";
import { isDataError, type ReadTx, type SqlValue, type Tx } from "../store/ports.ts";
import { confirmationHash, entryChecksums } from "./confirmation.ts";
import { canonicalKeyFault, type DerivedInput, planDerived } from "./derived.ts";
import { type ItemInput, planItem } from "./items.ts";
import { ApplyError, type BlockDepRow, type Change, type PrincipalRow } from "./model.ts";
import { planSchema, type SlotInput, type SwitchInput } from "./schema.ts";
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
  readonly item?: ItemInput;
  readonly writeBase?: WriteBaseInput;
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
  return planWriteBase(seq, op, present, inputs.writeBase);
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
  if (p.type === "write.base") return { writeBase: await readRow(tx, ev, p) };
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
      try {
        const q = e.partition(key);
        const rows: DerivedRow[] = [];
        for (const r of (await tx.query<Record<string, unknown>>(q.sql, q.params)).rows) {
          const d = e.decode(r);
          if (d !== undefined) rows.push(d);
        }
        recomputed = { rows };
      } catch (x) {
        if (x instanceof RuleEvaluationError) recomputed = { error: x.message };
        else if (isDataError(x)) recomputed = { error: `database: ${(x as Error).message}` };
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
  const v = await tx.query<{ sv: unknown; body: string | null }>(
    `SELECT s.sv, c.body FROM schema_versions s JOIN content c ON c.seq = s.compiled_seq AND c.path = 'compiled'
     WHERE s.slot_id = $1 AND s.state = 'current'`,
    [ev.header["slot"] as string],
  );
  const body = v.rows[0]?.body;
  const sv = Number(v.rows[0]?.sv);
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
    rec_from: unknown;
  }>(
    `SELECT field_id, ${isState ? asText("valid_from", instant) : "NULL"} AS valid_from,
       ${isState ? asText("valid_to", instant) : "NULL"} AS valid_to, src_event, src_field, src_k, rec_from
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
  return {
    table,
    items,
    openCells,
    count: Number(count.rows[0]?.n ?? 0),
    sv,
    rowTable: origin.rows[0]?.table_id ?? null,
  };
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
