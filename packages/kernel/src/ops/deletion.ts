// The `deletion_preview` and `delete` operations, the kernel's part (docs/zh-CN/spec/04-contract-
// types.md §4.7, §5.4; 03-data-model/03-deletion.md «预览与回执要写明的内容», «删除登记»; 02-architecture
// §5 the `dc_` handle, §8 the anchor store; 09-event-format §4.4, §5.9).
//
// The preview works the deletion out (./deletion-plan.ts) and returns what the confirmation
// handle binds: the deletion's ID, allocated at the preview (04-contract «删除 ID 在预览时预分配»),
// the slot and sources, the impact summary's hash, the log's tail and the restore count. The
// service layer signs that as `dc_…` and checks its signature, principal and expiry; the kernel
// checks the rest when it is confirmed, in this order:
//
// 1. `replayed`: the deletion table has the bound ID: this handle was confirmed already. Its
//    receipt again, `replayed: true`, rebuilt from the event: each row's target, outcome and new
//    `ver`, the totals; the rows' details are not (`omitted: ["rows"]`). Answered even past the
//    handle's expiry.
// 2. `handle_expired`: `expired` (the service found the handle past its expiry), `restored` (the
//    tenant was restored since the preview).
// 3. `preview_outdated`: worked out again on the state now, the impact summary differs (a write,
//    resolution or deletion changed a row, item or source the preview lists); the new preview and
//    binding come with it. Refused now where the preview was not (a source pending deletion since,
//    a row another deletion touched since): the state changed too; the refusal comes with it
//    (`preview_refused`). A write elsewhere does not outdate it.
//
// Then, under the tenant's serial write lock (one write transaction): the registry entry in the
// anchor store as `intent` (02 §8: before the tenant transaction commits, so a restore cannot bring
// the deletion back), `deletion.confirmed`, applied. After the commit the entry becomes `pending`;
// if that fails, normal opening's reconciliation does it (./reconcile-deletions.ts: intent with the
// log pending). A transaction that rolls back leaves an `intent` entry the log does not have, which
// the same reconciliation removes.
//
// Not reachable from any surface yet: the external entry waits until every read hides what a
// pending deletion lists.

import type { JsonValue, Seq, TenantId } from "@fluxvita/saveslot-contract-core";
import { applyEvents, eventsOf } from "../apply/index.ts";
import { encodeDeletion } from "../delete/index.ts";
import type { NewEvent } from "../log/build.ts";
import { appendOperation } from "../log/log.ts";
import type { AnchorStore } from "../store/anchor.ts";
import type { ReadTx, TenantStore, Tx } from "../store/ports.ts";
import { restoreCount } from "../store/restore-point.ts";
import { WriteError } from "../write/errors.ts";
import { readSlots } from "../write/reads.ts";
import { type RequestKey, requestKeyOf } from "../write/request-key.ts";
import type { OpsContext } from "./context.ts";
import { type DeletionPlan, type PreviewRow, planDeletion, previewRows } from "./deletion-plan.ts";
import { randomCrockford } from "./ids.ts";

/** The grace period of a privacy deletion (03-deletion «撤回与宽限期»: 24 hours). */
export const GRACE_MS = 24 * 60 * 60 * 1000;

/** What a confirmation handle binds (02-architecture §5), besides the tenant and principal. */
export interface DeletionBinding {
  /** The deletion's ID, allocated at the preview: a confirmed handle is known by it. */
  readonly deletion: string;
  readonly slot: string;
  readonly sources: readonly string[];
  /** The impact summary's hash. */
  readonly hash: string;
  /** The log's tail when previewed. */
  readonly seq: Seq;
  readonly restoreCount: number;
}

/** The preview (04-contract-types §4.7 `DeletionPreviewResult`): the lists this version works out; the handle is the service's. */
export interface DeletionPreview {
  readonly slot: string;
  readonly kind: "privacy";
  readonly totals: { readonly sources: number; readonly rows: number; readonly derived: number };
  readonly rows: readonly PreviewRow[];
  readonly now_effective: readonly never[];
  readonly now_effective_total: 0;
  readonly now_awaiting: readonly never[];
  readonly now_awaiting_total: 0;
  readonly superseded: readonly never[];
  readonly superseded_total: 0;
}

export interface PreviewOutcome {
  readonly preview: DeletionPreview;
  readonly binding: DeletionBinding;
}

/** The receipt (04-contract-types §5.4 `DeleteResult`): the lists this version works out. */
export interface DeletionReceipt extends Omit<DeletionPreview, "slot" | "rows"> {
  readonly deletion: {
    readonly id: string;
    readonly item_ver: string;
    readonly expires_at: string;
    readonly cancel_with: {
      readonly op: "resolve";
      readonly id: string;
      readonly decision: "cancel";
    };
  };
  readonly seq: Seq;
  readonly rows: readonly (PreviewRow & { readonly ver?: string })[];
  readonly rows_total: number;
  readonly replayed?: true;
  /** A replayed receipt rebuilt from the event: the rows' details are not (04-contract-types §5.4). */
  readonly omitted?: readonly "rows"[];
}

function previewOf(plan: DeletionPlan): DeletionPreview {
  const rows = previewRows(plan);
  return {
    slot: plan.slot,
    kind: "privacy",
    totals: { sources: plan.sources.length, rows: rows.length, derived: 0 },
    rows,
    now_effective: [],
    now_effective_total: 0,
    now_awaiting: [],
    now_awaiting_total: 0,
    superseded: [],
    superseded_total: 0,
  };
}

async function outcomeOf(tx: ReadTx, plan: DeletionPlan): Promise<PreviewOutcome> {
  return {
    preview: previewOf(plan),
    binding: {
      deletion: `pi_${randomCrockford(16)}`,
      slot: plan.slot,
      sources: [...plan.sourceIds],
      hash: plan.hash,
      seq: plan.tail,
      restoreCount: await restoreCount(tx),
    },
  };
}

/** Previews a privacy deletion of `params.sources` (`s_…` IDs). */
export async function previewDeletion(
  store: TenantStore,
  params: { readonly sources: readonly string[] },
): Promise<PreviewOutcome> {
  return store.read(async (tx) =>
    outcomeOf(tx, await planDeletion(tx, { sourceIds: params.sources })),
  );
}

const verOf = (seq: Seq, rc: number) => `v${seq}.${rc}`;
const itemVerOf = (id: string, seq: Seq, rc: number) => `iv_${id.slice(3)}.${seq}.${rc}`;

function receiptOf(
  preview: DeletionPreview,
  d: { readonly id: string; readonly seq: Seq; readonly dueAt: string; readonly rc: number },
  stillThere: ReadonlySet<string>,
  replayed: boolean,
): DeletionReceipt {
  const { slot: _slot, rows, ...rest } = preview;
  return {
    deletion: {
      id: d.id,
      item_ver: itemVerOf(d.id, d.seq, d.rc),
      expires_at: d.dueAt,
      cancel_with: { op: "resolve", id: d.id, decision: "cancel" },
    },
    seq: d.seq,
    ...rest,
    rows: rows.map((r) => {
      const id = r.target.row ?? r.target.entity ?? "";
      return stillThere.has(id) ? { ...r, ver: verOf(d.seq, d.rc) } : r;
    }),
    rows_total: rows.length,
    ...(replayed ? { replayed: true as const } : {}),
  };
}

/**
 * The deletion confirmed with this ID, if any (the deletion table), and what its event says of the
 * receipt: its sources and, by `results/<k>/target`, each row listed, its outcome, and whether it
 * still exists.
 */
async function confirmedAs(
  tx: ReadTx,
  id: string,
): Promise<
  | {
      id: string;
      seq: Seq;
      dueAt: string;
      sources: number;
      rows: { table: string; id: string; isState: boolean; outcome: string }[];
    }
  | undefined
> {
  const r = await tx.query<{ confirmed_seq: unknown; due_at: string }>(
    "SELECT confirmed_seq, due_at FROM deletions WHERE id = $1",
    [id],
  );
  const x = r.rows[0];
  if (x === undefined) return undefined;
  const seq = Number(x.confirmed_seq) as Seq;
  const blocks = await tx.query<{ path: string; body: string }>(
    `SELECT path, body FROM content WHERE seq = $1 AND body IS NOT NULL
       AND (path = 'target' OR path LIKE 'results/%/target')`,
    [seq],
  );
  let sources = 0;
  const rows: { k: number; table: string; id: string; isState: boolean; outcome: string }[] = [];
  for (const b of blocks.rows) {
    const v = JSON.parse(b.body) as Record<string, unknown>;
    if (b.path === "target") sources = (v["sources"] as unknown[]).length;
    else {
      const k = Number(b.path.split("/")[1]);
      const isState = typeof v["entity"] === "string";
      rows.push({
        k,
        table: v["table"] as string,
        id: (isState ? v["entity"] : v["row"]) as string,
        isState,
        outcome: v["outcome"] as string,
      });
    }
  }
  rows.sort((a, b) => a.k - b.k);
  return { id, seq, dueAt: x.due_at, sources, rows };
}

/** The tables' names now, by ID, in the slot the binding names. */
async function tableNames(tx: ReadTx, slot: string): Promise<Map<string, string>> {
  const s = (await readSlots(tx)).find((x) => x.slot === slot);
  return new Map((s?.compiled.tables ?? []).map((t) => [t.id, t.name]));
}

/**
 * Confirms the deletion a verified handle binds. `handle`: the handle as the caller sent it, the
 * request's content for its request key (09 §5.1), recorded on the event.
 */
export async function confirmDeletion(
  store: TenantStore,
  anchor: AnchorStore,
  ctx: OpsContext,
  input: {
    readonly binding: DeletionBinding;
    readonly handle: string;
    /** The handle verified but past its expiry: refused after a replay is answered. */
    readonly expired?: boolean;
  },
): Promise<DeletionReceipt> {
  const key: RequestKey = requestKeyOf(ctx.actor, ctx.task, {
    content: JSON.stringify({ confirm: input.handle }),
  });
  const { receipt, registered } = await store.write(
    async (
      tx,
    ): Promise<{
      receipt: DeletionReceipt;
      registered?: {
        id: string;
        seq: Seq;
        dueAt: string;
        positions: DeletionPlan["positions"];
        sources: readonly Seq[];
      };
    }> => {
      const rc = await restoreCount(tx);
      // 1. This handle confirmed already: its receipt again, rebuilt from the event (the rows'
      // details are not: `omitted`).
      const was = await confirmedAs(tx, input.binding.deletion);
      if (was !== undefined) {
        const names = await tableNames(tx, input.binding.slot);
        const rows = was.rows.map((r) => ({
          target: r.isState
            ? { table: names.get(r.table) ?? r.table, entity: r.id }
            : { table: names.get(r.table) ?? r.table, row: r.id },
          result: r.outcome,
        }));
        const stillThere = new Set(
          was.rows.filter((r) => r.outcome !== "deleted").map((r) => r.id),
        );
        const preview: DeletionPreview = {
          ...replayedPreview(input.binding),
          totals: { sources: was.sources, rows: rows.length, derived: 0 },
          rows,
        };
        return {
          receipt: {
            ...receiptOf(preview, { ...was, rc }, stillThere, true),
            omitted: ["rows"],
          },
        };
      }
      // 2. Expired, or restored since the preview.
      if (input.expired === true) {
        throw new WriteError("handle_expired", "the confirmation has expired; preview again", {
          reason: "expired",
        });
      }
      if (input.binding.restoreCount !== rc) {
        throw new WriteError("handle_expired", "the tenant was restored since the preview", {
          reason: "restored",
        });
      }
      // 3. Worked out again on the state now. What the preview worked out it works out again on
      // the same state: refused now (a source pending deletion since, a row another deletion
      // touched since, ...), the state changed, as when the summary differs.
      const outdated = (detail: Record<string, unknown>) =>
        new WriteError("preview_outdated", "what the preview lists has changed", detail as never);
      let plan: DeletionPlan;
      try {
        plan = await planDeletion(tx, { sourceIds: input.binding.sources });
      } catch (e) {
        if (!(e instanceof WriteError)) throw e;
        throw outdated({
          preview_refused: { code: e.code, ...(e.detail as Record<string, unknown>) },
        });
      }
      if (plan.hash !== input.binding.hash || plan.slot !== input.binding.slot) {
        const fresh = await outcomeOf(tx, plan);
        throw outdated({
          preview: fresh.preview as unknown as JsonValue,
          binding: fresh.binding as unknown as JsonValue,
        });
      }
      const id = input.binding.deletion;
      const dueAt = new Date(Date.parse(ctx.now) + GRACE_MS).toISOString();
      // The registry entry first (02 §8), with the seq the event will get: under this lock it is the
      // tail's next.
      await anchor.putDeletion(ctx.tenant as TenantId, {
        deletion: id as never,
        kind: "privacy",
        state: "intent",
        dueAt: dueAt as never,
        confirmedSeq: plan.self,
        sources: [...plan.sources],
        positions: plan.positions.map((p) => ({ seq: p.seq, path: p.path })) as never,
      });
      const seq = await appendDeletion(tx, plan, {
        id,
        dueAt,
        actor: ctx.actor,
        now: ctx.now,
        head: { ...key.block, ...(ctx.task !== null ? { task: ctx.task } : {}) },
      });
      const stillThere = new Set(
        plan.rows.filter((r) => r.result.result.existsAfter).map((r) => r.id),
      );
      return {
        receipt: receiptOf(previewOf(plan), { id, seq, dueAt, rc }, stillThere, false),
        registered: { id, seq, dueAt, positions: plan.positions, sources: plan.sources },
      };
    },
  );
  if (registered !== undefined) {
    const r = registered;
    // Committed: the registry entry is pending. A failure here is left to reconciliation.
    try {
      await anchor.putDeletion(ctx.tenant as TenantId, {
        deletion: r.id as never,
        kind: "privacy",
        state: "pending",
        dueAt: r.dueAt as never,
        confirmedSeq: r.seq,
        sources: [...r.sources],
        positions: r.positions.map((p) => ({ seq: p.seq, path: p.path })) as never,
      });
    } catch {
      // Normal opening's reconciliation moves intent to pending (the log has the event).
    }
  }
  return receipt;
}

/**
 * Appends the deletion `plan` works out, as `deletion.confirmed` (09 §5.9), and applies it; its
 * seq. `head`: the request-id blocks (§5.1). The caller holds the write lock and has checked the
 * plan is still the state's: the event gets the plan's `self`, or this refuses as inconsistent.
 */
export async function appendDeletion(
  tx: Tx,
  plan: DeletionPlan,
  d: {
    readonly id: string;
    readonly dueAt: string;
    readonly actor: OpsContext["actor"];
    readonly now: OpsContext["now"];
    readonly head?: Readonly<Record<string, JsonValue>>;
  },
): Promise<Seq> {
  const listed = plan.rows.filter((r) => r.result.result.listed);
  const blocks = {
    ctx: { now: d.now, today: d.now.slice(0, 10), ruleset_version: 1, policy_version: 1 },
    ...(d.head ?? {}),
    ...encodeDeletion({
      id: d.id,
      sources: plan.sources,
      dueAt: d.dueAt,
      origin: "request",
      positions: plan.positions,
      summaryHash: plan.hash,
      results: listed.map((r) => ({
        table: r.table.id,
        id: r.id,
        outcome: r.result.outcome as string,
        stretches: r.result.result.stretches,
        ...(r.result.result.gaps !== undefined ? { gaps: r.result.result.gaps } : {}),
      })),
      restated: plan.restated,
      recreated: listed.flatMap((r) => r.result.result.recreated),
      superseded: [],
    }),
  };
  const op = await appendOperation(tx, {
    actor: d.actor,
    now: d.now,
    events: [{ type: "deletion.confirmed", slot: plan.slot, blocks } as NewEvent],
  });
  const seq = op.events[0]?.seq as Seq;
  if (seq !== plan.self) {
    throw new WriteError("internal", "the deletion event did not get the seq worked out for it", {
      reason: "inconsistent",
    });
  }
  await applyEvents(tx, eventsOf(op));
  return seq;
}

/**
 * What a replayed request's receipt lists besides the deletion: the sources are pending deletion
 * now, so the plan is not worked out again; the receipt names the deletion and its event.
 */
function replayedPreview(b: DeletionBinding): DeletionPreview {
  return {
    slot: b.slot,
    kind: "privacy",
    totals: { sources: b.sources.length, rows: 0, derived: 0 },
    rows: [],
    now_effective: [],
    now_effective_total: 0,
    now_awaiting: [],
    now_awaiting_total: 0,
    superseded: [],
    superseded_total: 0,
  };
}
