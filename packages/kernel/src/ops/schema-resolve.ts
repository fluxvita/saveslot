// `resolve` of a `schema_change` item (docs/zh-CN/spec/04-contract.md §10 `resolve`, §6;
// 09-event-format.md §4.5, §5.5, §5.8, §5.10): confirming or rejecting a draft that waits, in the
// caller's write transaction. The ops entry sends these items here (./resolve.ts); the other types
// go through the write path (../write/resolve.ts), whose steps 1–5 this shares:
//   1. the request checked and normalized;
//   2. the request key looked up in its window: a hit returns the original result;
//   3. the item: none, or not visible → `not_found`. A slot's schema items are seen only with every
//      table of the slot in range (04-write-and-read «可见范围»). Resolved the same way → the
//      original result (`replayed`); resolved another way or superseded → `item_closed`;
//   4. the decision is `confirm` or `reject`;
//   5. the item version brought back (or taken by fallback) is the item's current one, else
//      `confirmation_mismatch`.
// Then:
// - `confirm`: judged again in the same transaction (04-contract `resolve` 4). This version compiles
//   no change that holds only for a table never written, and no `migrate`, so neither refusal of
//   `draft_outdated` (`table_written`, `migrate_failed`) can come up yet: `outdatedOnConfirm` is
//   where they go. The draft's `base_version` is not checked again: a pending draft was written on
//   the current version, since any switch since would have come from a newer draft, which
//   supersedes it first. That the two agree is asserted (`internal` if not). A draft renaming the
//   slot is refused (`draft_outdated`, `name_taken`) when another slot took the name meanwhile.
//   Events: `item.resolved` (head; `confirmation` the hash of the draft's `compiled` block) → the
//   request's `api_call` when it has a note → `schema.confirmed` (`by: resolve`) →
//   `schema.switched` (nothing rebuilt: this version compiles catalog-only changes) → an
//   `item.superseded` (`schema_switched`) for each open item on a table the new version drops →
//   at most one `premise.changed` for the declarations on fields the new version drops (§5.10).
// - `reject`: `item.resolved` → the `api_call` with a note → `schema.rejected`. Its number is not
//   used again.
// Sources (09 §4.3), as for any decision: each evidence segment a source of its own (a
// `source_ref` the source it names), then the request itself as an `api_call` when it has a note.
// A schema decision triggers no write, so without a note and evidence it has no source.

import type { CompiledSchema, ItemId, JsonValue, OpNumber } from "@fluxvita/saveslot-contract-core";
import {
  ApplyError,
  applyEvents,
  confirmationHash,
  confirmedChecksums,
  eventsOf,
  fold,
  internalDetailOf,
} from "../apply/index.ts";
import { appendOperation, type NewEvent, readTail } from "../log/index.ts";
import { itemVer } from "../pending/index.ts";
import { type VisibleSlot, visibleSlots, wholeSlot } from "../read/index.ts";
import { restoreCount } from "../read/select.ts";
import { RULESET_VERSION } from "../rules/index.ts";
import type { ReadTx, Tx } from "../store/ports.ts";
import {
  boundItemVer,
  closed,
  evidenceSource,
  findRequest,
  type ItemRow,
  itemEvent,
  itemRow,
  normalizeResolve,
  placeEvidence,
  type ResolveReceipt,
  type ResolveWarning,
  requestFailure,
  requestKeyOf,
  todayIn,
  WriteError,
  type WriteInput,
} from "../write/index.ts";

/** The draft a `schema_change` item waits on, as the log has it. */
interface Draft {
  readonly id: string;
  readonly sv: number;
  readonly state: string;
  readonly baseVersion: number;
  readonly compiled: CompiledSchema;
  readonly changes: readonly {
    readonly change: string;
    readonly target: Record<string, unknown>;
  }[];
}

async function draftOf(tx: ReadTx, item: string): Promise<Draft> {
  const r = await tx.query<{
    draft: string;
    sv: unknown;
    state: string;
    submitted: string | null;
    compiled: string | null;
    changes: string | null;
  }>(
    `SELECT v.draft_id AS draft, v.sv, v.state, st.body AS submitted, c.body AS compiled, ch.body AS changes
     FROM pending_items p
     JOIN content t ON t.path = 'target' AND t.body IS NOT NULL AND (t.body::jsonb ->> 'item') = p.id
     JOIN events ie ON ie.seq = t.seq AND ie.type = 'item.created'
     JOIN schema_versions v ON v.slot_id = p.slot_id AND v.draft_id = (t.body::jsonb ->> 'draft')
     JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
     JOIN content ch ON ch.seq = v.compiled_seq AND ch.path = 'changes'
     JOIN events ce ON ce.seq = v.compiled_seq
     JOIN events se ON se.op = ce.op AND se.type = 'schema.draft_submitted'
     JOIN content st ON st.seq = se.seq AND st.path = 'target'
     WHERE p.id = $1`,
    [item],
  );
  const x = r.rows[0];
  if (x === undefined || x.compiled === null || x.changes === null || x.submitted === null)
    throw new WriteError("internal", `the draft of item ${item} is not in the log as written`, {
      reason: "inconsistent",
    });
  return {
    id: x.draft,
    sv: Number(x.sv),
    state: x.state,
    baseVersion: Number((JSON.parse(x.submitted) as { base_version: unknown }).base_version),
    compiled: JSON.parse(x.compiled) as CompiledSchema,
    changes: JSON.parse(x.changes) as Draft["changes"],
  };
}

/**
 * A confirmation judged again (04-contract `resolve` 5; 07 «确认时重新判断»), in the decision's
 * transaction: a slot renamed to a name another slot took while the draft waited (`name_taken`; a
 * draft waiting holds no name). Not yet: a change compiled as for a table never written, on a table
 * written since (`table_written`); a `migrate` failing on writes since its trial
 * (`migrate_failed`). This version compiles neither.
 */
async function outdatedOnConfirm(
  tx: ReadTx,
  draft: Draft,
  slot: { readonly slot: string; readonly name: string; readonly sv: number },
): Promise<WriteError | undefined> {
  const to = draft.compiled.name;
  if (fold(to) === fold(slot.name)) return undefined;
  const others = await tx.query<{ name: string }>("SELECT name FROM slots WHERE id <> $1", [
    slot.slot,
  ]);
  if (!others.rows.some((x) => fold(x.name) === fold(to))) return undefined;
  return new WriteError("draft_outdated", `another slot is named ${to} now`, {
    reason: "name_taken",
    current_sv: slot.sv,
  });
}

/**
 * The open items the switch supersedes (01-objects «schema 切换»; 09 §4.5 «后台迁移结束», §6.6
 * `schema_switched`): those whose target changed incompatibly, by the rule a write at the earlier
 * version is refused by. This version switches to no incompatible change but a dropped table: the
 * items on a table the new version drops. By item ID.
 */
async function itemsSuperseded(
  tx: ReadTx,
  before: CompiledSchema,
  after: CompiledSchema,
): Promise<string[]> {
  const dropped = before.tables
    .filter((t) => !after.tables.some((x) => x.id === t.id))
    .map((t) => t.id);
  if (dropped.length === 0) return [];
  const r = await tx.query<{ id: string }>(
    `SELECT id FROM pending_items WHERE state = 'open' AND slot_id = $1 AND target_table = ANY($2)
     ORDER BY id`,
    [before.slot, dropped] as never,
  );
  return r.rows.map((x) => x.id);
}

/**
 * The declarations the switch changes (09 §5.10 «schema 切换里的 premise.changed»): those still
 * "current" on a field the new version drops, the tables it drops included, one block per premise
 * target. A declaration of several fields changes when one of them goes; a whole-row declaration
 * changes with its table. Already "changed" ones stay as they are.
 */
async function premisesDropped(
  tx: ReadTx,
  before: CompiledSchema,
  after: CompiledSchema,
  byEvent: number,
): Promise<Record<string, JsonValue> | undefined> {
  const gone = new Map<string, "table" | Set<string>>();
  for (const t of before.tables) {
    const now = after.tables.find((x) => x.id === t.id);
    if (now === undefined) gone.set(t.id, "table");
    else {
      const fields = new Set(
        t.fields.filter((f) => !now.fields.some((g) => g.id === f.id)).map((f) => f.id),
      );
      if (fields.size > 0) gone.set(t.id, fields);
    }
  }
  if (gone.size === 0) return undefined;
  const r = await tx.query<{
    op: unknown;
    op_index: number;
    decl_index: number;
    target_table: string;
    target_row: string;
    fields: string | null;
  }>(
    `SELECT op, op_index, decl_index, target_table, target_row, fields FROM premise_decls
     WHERE state = 'current' AND target_table = ANY($1)
     ORDER BY target_table, target_row, op, op_index, decl_index`,
    [[...gone.keys()]] as never,
  );
  const byTarget = new Map<
    string,
    { table: string; row: string; changed: Record<string, JsonValue>[] }
  >();
  for (const d of r.rows) {
    const g = gone.get(d.target_table);
    const hit =
      g === "table" ||
      (g !== undefined &&
        d.fields !== null &&
        (JSON.parse(d.fields) as string[]).some((f) => g.has(f)));
    if (!hit) continue;
    const key = `${d.target_table}\u0000${d.target_row}`;
    const t = byTarget.get(key) ?? { table: d.target_table, row: d.target_row, changed: [] };
    t.changed.push({ op: Number(d.op), i: d.op_index, j: d.decl_index, reason: "schema_switched" });
    byTarget.set(key, t);
  }
  if (byTarget.size === 0) return undefined;
  const blocks: Record<string, JsonValue> = {};
  [...byTarget.values()].forEach((t, k) => {
    const table = before.tables.find((x) => x.id === t.table);
    const isState = table?.kind === "base" && table.time.type === "state";
    blocks[`targets/${k}`] = {
      table: t.table,
      ...(isState ? { entity: t.row } : { row: t.row }),
      by_event: byEvent,
      changed: t.changed,
    };
  });
  return blocks;
}

/** The result of a schema decision, read back from the log (the original one, for a repeat). */
async function readSchemaResolution(
  tx: ReadTx,
  op: OpNumber,
  restore: number,
  replayed: boolean,
): Promise<ResolveReceipt> {
  const r = await tx.query<{ type: string; body: string | null }>(
    `SELECT e.type, c.body FROM events e LEFT JOIN content c ON c.seq = e.seq AND c.path = 'target'
     WHERE e.op = $1 AND e.type IN ('item.resolved', 'schema.switched') ORDER BY e.seq`,
    [op],
  );
  const head = r.rows.find((x) => x.type === "item.resolved");
  if (head?.body == null)
    throw new WriteError("internal", "the operation is not a decision", { reason: "inconsistent" });
  const t = JSON.parse(head.body) as { item: ItemId; decision: "confirm" | "reject" };
  const switched = r.rows.find((x) => x.type === "schema.switched");
  const to =
    switched?.body == null ? undefined : (JSON.parse(switched.body) as { to_version: number });
  // A switch renaming the slot: its name in the version switched to, as compiled; never the slot's
  // name now, which a later rename changes (a repeat gives the original receipt).
  let renamed: string | undefined;
  if (to !== undefined) {
    const v = await tx.query<{ compiled: string | null; changes: string | null }>(
      `SELECT c.body AS compiled, ch.body AS changes FROM events e
       JOIN schema_versions v ON v.slot_id = e.slot AND v.sv = $2
       JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
       JOIN content ch ON ch.seq = v.compiled_seq AND ch.path = 'changes'
       WHERE e.op = $1 AND e.type = 'schema.switched'`,
      [op, to.to_version],
    );
    const x = v.rows[0];
    const changes = x?.changes == null ? [] : (JSON.parse(x.changes) as { change: string }[]);
    if (x?.compiled != null && changes.some((c) => c.change === "rename_slot"))
      renamed = (JSON.parse(x.compiled) as CompiledSchema).name;
  }
  return {
    id: t.item,
    type: "schema_change",
    decision: t.decision,
    item_ver: itemVer(t.item, op, restore),
    status: "resolved",
    schema:
      to !== undefined
        ? {
            switched: true,
            sv: to.to_version,
            ...(renamed !== undefined ? { slot: renamed } : {}),
          }
        : { switched: false },
    ...(replayed ? { replayed: true as const } : {}),
  };
}

/** The item, if the caller sees it: a slot's schema items only with every table of it in range. */
function placeOf(item: ItemRow | undefined, slots: readonly VisibleSlot[]) {
  if (item === undefined) return undefined;
  const slot = slots.find((s) => s.slot === item.slot);
  return slot !== undefined && wholeSlot(slot) ? slot : undefined;
}

/** Resolves the `schema_change` item the request names, in `tx`. */
export async function resolveSchemaChangeInTx(tx: Tx, input: WriteInput): Promise<ResolveReceipt> {
  const { actor, now } = input;
  const normalized = normalizeResolve(input.params);
  if (!normalized.ok) throw requestFailure(normalized.error);
  const req = normalized.request;
  const task = req.task ?? input.task;
  const restore = await restoreCount(tx);
  const notFound = () =>
    new WriteError("not_found", "no such item", { reason: "item", param: "id" });

  // The request key in its window.
  const rk = requestKeyOf(actor, task, req.requestKey);
  const hit = await findRequest(tx, rk, now, input.windows);
  const item = await itemRow(tx, req.id);
  const seen = await visibleSlots(tx, input.visibility as never);
  const slot = placeOf(item, seen);
  if (item === undefined || slot === undefined || item.type !== "schema_change") throw notFound();
  if (hit !== undefined) return readSchemaResolution(tx, hit, restore, true);

  // A closed item: the same decision again is a repeat, any other is refused.
  if (item.state === "resolved") {
    const done = await itemEvent(tx, item.id, "item.resolved");
    if (done === undefined)
      throw new WriteError("internal", "a resolved item without its decision", {
        reason: "inconsistent",
      });
    if ((done.target as { decision: string }).decision === req.decision)
      return readSchemaResolution(tx, done.op, restore, true);
    throw await closed(tx, item.id, "the item was resolved another way");
  }
  if (item.state !== "open") throw await closed(tx, item.id, "the item was superseded");

  if (req.decision !== "confirm" && req.decision !== "reject")
    throw new WriteError("invalid_argument", "the item does not take this decision", {
      reason: "malformed",
      param: "decision",
    });
  const warnings: ResolveWarning[] = await boundItemVer(
    tx,
    input,
    item,
    req.itemVer,
    task,
    restore,
  );

  const draft = await draftOf(tx, item.id);
  if (draft.state !== "pending")
    throw new WriteError("internal", `an open item whose draft is ${draft.state}`, {
      reason: "inconsistent",
    });
  const confirm = req.decision === "confirm";
  if (confirm) {
    // Never reached: a newer draft supersedes this one before any switch (see the header).
    if (draft.baseVersion !== slot.sv)
      throw new WriteError("internal", "a pending draft not on the current version", {
        reason: "inconsistent",
      });
    const outdated = await outdatedOnConfirm(tx, draft, slot);
    if (outdated !== undefined) throw outdated;
  }

  const hash = confirmationHash(await confirmedChecksums(tx, item.id));
  if (hash === undefined || hash === "removed")
    throw new WriteError("internal", "the draft's compiled definition is not there to confirm", {
      reason: "inconsistent",
    });

  const policy = await tx.query<{ policy_version: unknown }>(
    "SELECT policy_version FROM slots WHERE id = $1",
    [slot.slot],
  );
  const op = (((await readTail(tx))?.seq ?? 0) + 1) as OpNumber;
  const evidence = await placeEvidence(
    tx,
    req.evidence.map((segment, k) => ({ segment, param: `evidence/${k}` })),
    { slot: slot.slot, visibleSlots: new Set(seen.map((x) => x.slot)) },
  );
  const evidenceSeqs = [...new Set(evidence.seqsFrom(op + 1))];
  const apiCall = req.note !== undefined;
  const apiCallSeq = op + 1 + evidence.fresh.length;
  const sourceSeqs = [...evidenceSeqs, ...(apiCall ? [apiCallSeq] : [])];
  const freshIds = evidence.fresh.map(() => input.newId("source"));
  let freshAt = 0;
  const evidenceIds = req.evidence.map((ev) =>
    ev.kind === "source_ref" ? ev.id : (freshIds[freshAt++] as string),
  );
  const sources: NewEvent[] = [
    ...evidence.fresh.map((ev, k) => evidenceSource(ev, slot.slot, freshIds[k] as string)),
    ...(apiCall
      ? [
          {
            type: "source.recorded" as const,
            slot: slot.slot,
            blocks: {
              target: {
                source_id: input.newId("source"),
                kind: "api_call",
                level: "agent_inferred",
              },
              // The decision as asked; each evidence segment is a source of its own, named here.
              request: {
                id: req.id,
                decision: req.decision,
                note: req.note as string,
                ...(evidenceIds.length > 0 ? { evidence: evidenceIds } : {}),
              },
            } as never,
          },
        ]
      : []),
  ];
  const head: NewEvent = {
    type: "item.resolved",
    slot: slot.slot,
    blocks: {
      ctx: {
        now,
        today: todayIn(now, slot.timezone),
        ruleset_version: RULESET_VERSION,
        policy_version: Number(policy.rows[0]?.policy_version),
      },
      ...(task !== null ? { task } : {}),
      ...rk.block,
      target: {
        item: item.id,
        decision: req.decision,
        item_op: item.versionOp,
        restore_count: restore,
        via: "call",
      },
      ...(sourceSeqs.length > 0 ? { op_sources: sourceSeqs } : {}),
      confirmation: { hash },
    } as never,
  };
  const after: NewEvent[] = [];
  if (confirm) {
    const switchedSeq = op + 1 + sources.length + 1;
    after.push(
      {
        type: "schema.confirmed",
        slot: slot.slot,
        blocks: { target: { draft_id: draft.id, target_version: draft.sv, by: "resolve" } },
      },
      {
        type: "schema.switched",
        slot: slot.slot,
        blocks: {
          target: {
            draft_id: draft.id,
            from_version: slot.sv,
            to_version: draft.sv,
            rebuilt_tables: [],
          },
        },
      },
    );
    for (const id of await itemsSuperseded(tx, slot.compiled, draft.compiled))
      after.push({
        type: "item.superseded",
        slot: slot.slot,
        blocks: { target: { item: id, reason: "schema_switched", by_event: switchedSeq } },
      });
    const premises = await premisesDropped(tx, slot.compiled, draft.compiled, switchedSeq);
    if (premises !== undefined)
      after.push({ type: "premise.changed", slot: slot.slot, blocks: premises as never });
  } else {
    after.push({
      type: "schema.rejected",
      slot: slot.slot,
      blocks: { target: { draft_id: draft.id } },
    });
  }
  const appended = await appendOperation(tx, {
    actor: actor as never,
    now: now as never,
    events: [head, ...sources, ...after],
  });
  if (appended.op !== op)
    throw new WriteError("internal", "the operation's numbers are not as planned");
  try {
    await applyEvents(tx, eventsOf(appended));
  } catch (e) {
    if (e instanceof ApplyError)
      throw new WriteError("internal", "the decision could not be applied", internalDetailOf(e));
    throw e;
  }
  const out = await readSchemaResolution(tx, op, restore, false);
  return warnings.length > 0 ? { ...out, warnings } : out;
}
