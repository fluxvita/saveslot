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

import type { CompiledBaseTable, JsonValue, Seq, TenantId } from "@fluxvita/saveslot-contract-core";
import { applyEvents, eventsOf } from "../apply/index.ts";
import { encodeDeletion } from "../delete/index.ts";
import type { NewEvent } from "../log/build.ts";
import { appendOperation, readEvents } from "../log/log.ts";
import {
  actorsNow,
  type Blocks,
  type ItemEntries,
  impactOut,
  type Naming,
} from "../pending/index.ts";
import type { AnchorStore } from "../store/anchor.ts";
import type { ReadTx, TenantStore, Tx } from "../store/ports.ts";
import { restoreCount } from "../store/restore-point.ts";
import { valueOut } from "../time/zone.ts";
import { WriteError } from "../write/errors.ts";
import { readSlots } from "../write/reads.ts";
import { intervalOut } from "../write/receipt.ts";
import { type RequestKey, requestKeyOf } from "../write/request-key.ts";
import type { OpsContext } from "./context.ts";
import type { ItemEventsOut } from "./deletion-items.ts";
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

/** A write not in effect before that takes effect with the deletion (04-contract-types §4.7). */
export interface NowEffective {
  readonly seq: Seq;
  readonly target: { readonly table: string; readonly row?: string; readonly entity?: string };
  readonly fields: Readonly<Record<string, unknown>>;
  readonly valid?: { readonly from?: string; readonly to?: string };
  readonly item: string;
  readonly item_becomes: "superseded" | "open";
}

/**
 * A write turned awaiting by the deletion: its conflict gone, still of high impact
 * (04-contract-types §4.7 `DeletionPreviewResult.now_awaiting`). `impact`: `AwaitingImpact`, as the
 * pending details give it.
 */
export interface NowAwaiting {
  readonly seq: Seq;
  readonly target: { readonly table: string; readonly row?: string; readonly entity?: string };
  readonly fields: Readonly<Record<string, unknown>>;
  readonly valid?: { readonly from?: string; readonly to?: string };
  readonly from_item: string;
  readonly impact: Readonly<Record<string, unknown>>;
}

/** The same in the receipt (§5.4 `DeleteResult.now_awaiting`): with the item opened for it. */
export interface NowAwaitingOpened {
  readonly seq: Seq;
  readonly target: { readonly table: string; readonly row?: string; readonly entity?: string };
  readonly item: { readonly id: string; readonly item_ver: string };
  readonly impact: Readonly<Record<string, unknown>>;
}

/** An item the deletion supersedes. */
export interface SupersededItem {
  readonly item: string;
  readonly type: string;
  readonly reason: "deleted";
}

/** The lists' limit (04-contract-types §4.7: at most 50 each, with the total). */
const LIST_LIMIT = 50;

/** The preview (04-contract-types §4.7 `DeletionPreviewResult`): the lists this version works out; the handle is the service's. */
export interface DeletionPreview {
  readonly slot: string;
  readonly kind: "privacy";
  readonly totals: { readonly sources: number; readonly rows: number; readonly derived: number };
  readonly rows: readonly PreviewRow[];
  readonly now_effective: readonly NowEffective[];
  readonly now_effective_total: number;
  readonly now_awaiting: readonly NowAwaiting[];
  readonly now_awaiting_total: number;
  readonly superseded: readonly SupersededItem[];
  readonly superseded_total: number;
}

export interface PreviewOutcome {
  readonly preview: DeletionPreview;
  readonly binding: DeletionBinding;
}

/** The receipt (04-contract-types §5.4 `DeleteResult`): the lists this version works out. */
export interface DeletionReceipt extends Omit<DeletionPreview, "slot" | "rows" | "now_awaiting"> {
  readonly now_awaiting: readonly NowAwaitingOpened[];
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
  readonly omitted?: readonly ("rows" | "lists")[];
}

/** The ops an opened item's impact entries name: whose writers the impact gives. */
const impactOps = (items: readonly ItemEventsOut[]): number[] => [
  ...new Set(
    items.flatMap((out) =>
      out.events
        .filter((e) => e.type === "item.created")
        .flatMap((e) =>
          Object.entries(e.blocks as Record<string, { op?: unknown }>)
            .filter(([p, b]) => p.startsWith("impact/") && typeof b?.op === "number")
            .map(([, b]) => b.op as number),
        ),
    ),
  ),
];

/** The writers of operations (by their head events), as they are now (04-contract-types §1.6). */
async function writersOf(tx: ReadTx, ops: readonly number[]): Promise<Writers> {
  if (ops.length === 0) return { byOp: new Map(), who: new Map() };
  const r = await tx.query<{ seq: unknown; actor: string }>(
    "SELECT seq, actor FROM events WHERE seq = ANY($1)",
    [ops] as never,
  );
  const byOp = new Map(r.rows.map((x) => [Number(x.seq), x.actor]));
  return { byOp, who: await actorsNow(tx, [...byOp.values()]) };
}

interface Writers {
  readonly byOp: ReadonlyMap<number, string>;
  readonly who: ReadonlyMap<string, unknown>;
}

function previewOf(plan: DeletionPlan, writers: Writers, items = plan.items): DeletionPreview {
  const rows = previewRows(plan);
  const nowEffective: NowEffective[] = [];
  const nowAwaiting: (NowAwaiting & { readonly opened: string })[] = [];
  const superseded: SupersededItem[] = [];
  plan.rows.forEach((r, n) => {
    const out = items[n];
    if (out === undefined) return;
    const nameOf = new Map(r.table.fields.map((f) => [f.id as string, f.name]));
    const target = r.isState
      ? { table: r.table.name, entity: r.id }
      : { table: r.table.name, row: r.id };
    const after = r.result.replay.state;
    // A write's values on the state after, by field name, and the interval of its items in effect.
    const valuesOf = (event: number, statuses: readonly string[]) => {
      const mine = after.items.filter(
        (x) => x.event === event && x.target !== "existence" && statuses.includes(x.status),
      );
      const fields = Object.fromEntries(
        mine.map((x) => [
          nameOf.get(x.target) ?? x.target,
          x.content.kind === "value" ? x.content.value : null,
        ]),
      );
      const ends = mine.flatMap((x) => x.valid);
      const from = ends.some((v) => v.from === null)
        ? null
        : ends.map((v) => v.from as string).sort()[0];
      const to = ends.some((v) => v.to === null)
        ? null
        : ends
            .map((v) => v.to as string)
            .sort()
            .at(-1);
      const valid =
        r.isState && ends.length > 0
          ? { ...(from != null ? { from } : {}), ...(to != null ? { to } : {}) }
          : undefined;
      return { fields, ...(valid !== undefined ? { valid } : {}) };
    };
    const gone = new Set(out.superseded);
    for (const [key, fate] of r.result.items.fates) {
      if (fate.kind !== "now_effective") continue;
      const event = Number(key.split("/")[0]) as Seq;
      if (nowEffective.some((x) => x.seq === event && x.item === fate.item)) continue;
      nowEffective.push({
        seq: event,
        target,
        ...valuesOf(event, ["applied", "corroborated"]),
        item: fate.item,
        item_becomes: gone.has(fate.item) ? "superseded" : "open",
      });
    }
    for (const o of out.opened) {
      const ev = out.events.find(
        (e) =>
          e.type === "item.created" &&
          (e.blocks as { target: { item: string } }).target.item === o.id,
      );
      const blocks = Object.entries((ev?.blocks ?? {}) as Record<string, unknown>)
        .filter(([p]) => p.startsWith("impact/"))
        .map(([, b]) => b as Blocks);
      // As the pending details give it (`AwaitingImpact`): field names, intervals, values, writers.
      const naming = namingFor(r.table, r.isState, writers);
      const entries = { actorOfOp: writers.byOp } as unknown as ItemEntries;
      nowAwaiting.push({
        seq: o.origin,
        target,
        ...valuesOf(o.origin, ["awaiting"]),
        from_item: o.succeeds,
        impact: impactOut(entries, naming, blocks),
        opened: o.id,
      });
    }
    for (const id of out.superseded) {
      superseded.push({ item: id, type: r.items.get(id)?.type ?? "conflict", reason: "deleted" });
    }
  });
  const byFirst = <T extends { seq?: Seq; item?: unknown }>(xs: T[]) => xs.slice(0, LIST_LIMIT);
  return {
    slot: plan.slot,
    kind: "privacy",
    totals: { sources: plan.sources.length, rows: rows.length, derived: 0 },
    rows,
    now_effective: byFirst(nowEffective),
    now_effective_total: nowEffective.length,
    now_awaiting: byFirst(nowAwaiting).map(({ opened: _, ...x }) => x),
    now_awaiting_total: nowAwaiting.length,
    superseded: superseded.slice(0, LIST_LIMIT),
    superseded_total: superseded.length,
  };
}

async function outcomeOf(tx: ReadTx, plan: DeletionPlan): Promise<PreviewOutcome> {
  return {
    preview: previewOf(plan, await writersOf(tx, impactOps(plan.items))),
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
  /** The items opened, in the order of `now_awaiting` (the item events'). */
  opened: readonly string[] = [],
): DeletionReceipt {
  const { slot: _slot, rows, now_awaiting, ...rest } = preview;
  return {
    deletion: {
      id: d.id,
      item_ver: itemVerOf(d.id, d.seq, d.rc),
      expires_at: d.dueAt,
      cancel_with: { op: "resolve", id: d.id, decision: "cancel" },
    },
    seq: d.seq,
    ...rest,
    now_awaiting: now_awaiting.map((x, i) => ({
      seq: x.seq,
      target: x.target,
      item: { id: opened[i] as string, item_ver: itemVerOf(opened[i] as string, d.seq, d.rc) },
      impact: x.impact,
    })),
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

/**
 * A replayed receipt's item lists, from the deletion's operation: `superseded` from its
 * `superseded_items` and the items' types, `now_awaiting` from its `item.created` events (the item
 * opened, its impact as the pending details give it). `now_effective` needs the replay's values,
 * which the log does not keep apart: not rebuilt (`omitted: ["lists"]`).
 */
async function replayedItems(
  tx: ReadTx,
  slot: string,
  seq: Seq,
  rc: number,
): Promise<{
  superseded: SupersededItem[];
  now_awaiting: NowAwaitingOpened[];
  now_effective_known: boolean;
  now_effective_total: number;
}> {
  const last = await tx.query<{ m: unknown }>(
    "SELECT max(seq) AS m FROM events WHERE seq = $1 OR op = $1",
    [seq],
  );
  // The operation's events, their blocks as readable now (a block pending deletion is not given).
  const events = (await readEvents(tx, seq, Number(last.rows[0]?.m ?? seq) as Seq)).map((e) => ({
    seq: e.seq,
    type: e.header["type"] as string,
    blocks: Object.fromEntries(
      [...e.blocks].flatMap(([p, b]) => (b.state === "present" ? [[p, b.value]] : [])),
    ) as Record<string, unknown>,
  }));
  const head = events.find((e) => e.seq === seq);
  const ids = (head?.blocks["superseded_items"] ?? []) as string[];
  const types = await tx.query<{ id: string; type: string }>(
    "SELECT id, type FROM pending_items WHERE id = ANY($1)",
    [ids] as never,
  );
  const typeOf = new Map(types.rows.map((x) => [x.id, x.type]));
  const superseded = ids.map((item) => ({
    item,
    type: typeOf.get(item) ?? "conflict",
    reason: "deleted" as const,
  }));
  const tables = new Map(
    ((await readSlots(tx)).find((x) => x.slot === slot)?.compiled.tables ?? []).map((t) => [
      t.id as string,
      t,
    ]),
  );
  const created = events.filter((e) => e.type === "item.created");
  const writers = await writersOf(
    tx,
    created.flatMap((e) =>
      Object.entries(e.blocks as Record<string, { op?: unknown }>)
        .filter(([p, b]) => p.startsWith("impact/") && typeof b?.op === "number")
        .map(([, b]) => b.op as number),
    ),
  );
  const nowAwaiting = created.map((e) => {
    const t = e.blocks["target"] as {
      item: string;
      table: string;
      row?: string;
      entity?: string;
      origin_event: number;
    };
    const table = tables.get(t.table) as CompiledBaseTable | undefined;
    const blocks = Object.entries(e.blocks)
      .filter(([p]) => p.startsWith("impact/"))
      .map(([, b]) => b as Blocks);
    const name = table?.name ?? t.table;
    return {
      seq: t.origin_event as Seq,
      target:
        t.entity !== undefined
          ? { table: name, entity: t.entity }
          : { table: name, row: t.row as string },
      item: { id: t.item, item_ver: itemVerOf(t.item, seq, rc) },
      impact: impactOut(
        { actorOfOp: writers.byOp } as unknown as ItemEntries,
        namingFor(table, t.entity !== undefined, writers),
        blocks,
      ),
    };
  });
  // Writes put in effect (§4.7 `now_effective`, one per write and item): a member of an item the
  // deletion superseded or refreshed (a candidate's write, an awaiting item's origin) that this
  // event restates in effect. Counted; the list needs the replay's values (`omitted`).
  const touched = [
    ...ids,
    ...events
      .filter((e) => e.type === "item.refreshed")
      .map((e) => (e.blocks["target"] as { item: string }).item),
  ];
  const nowIn = new Set(
    Object.entries(head?.blocks ?? {})
      .filter(([p, b]) => {
        const st = (b as { status?: string } | null)?.status;
        return p.startsWith("restated/") && (st === "applied" || st === "corroborated");
      })
      .map(([, b]) => (b as { event: number }).event),
  );
  let effective = 0;
  for (const item of new Set(touched)) {
    const given = await tx.query<{ body: string; path: string }>(
      `SELECT c.body, c.path FROM events e
       JOIN content t ON t.seq = e.seq AND t.path = 'target' AND t.body IS NOT NULL
       JOIN content c ON c.seq = e.seq AND c.body IS NOT NULL
         AND (c.path LIKE 'candidates/%' OR (e.type = 'item.created' AND c.path = 'target'))
       WHERE e.type IN ('item.created', 'item.merged') AND (t.body::jsonb ->> 'item') = $1`,
      [item],
    );
    const members = new Set(
      given.rows.flatMap((x) => {
        const b = JSON.parse(x.body) as { event?: number; type?: string; origin_event?: number };
        if (x.path === "target") return b.type === "awaiting_confirmation" ? [b.origin_event] : [];
        return [b.event];
      }),
    );
    for (const m of members) if (m !== undefined && nowIn.has(m)) effective++;
  }
  return {
    superseded,
    now_awaiting: nowAwaiting,
    now_effective_known: touched.length === 0,
    now_effective_total: effective,
  };
}

/** How a deletion's lists name an awaiting item's impact: as the pending details do. */
function namingFor(
  table: CompiledBaseTable | undefined,
  isState: boolean,
  writers: Writers,
): Naming<unknown> {
  const byDate = table?.time.type === "state" && table.time.granularity === "date";
  return {
    field: (f) => table?.fields.find((x) => x.id === f)?.name ?? f,
    interval: (v) => intervalOut(v, byDate) as unknown as Record<string, unknown>,
    actor: (p) => writers.who.get(p) ?? { kind: "user", id: p, name: p },
    value: valueOut,
    isState,
  };
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
        const lists = await replayedItems(tx, input.binding.slot, was.seq, rc);
        const preview: DeletionPreview = {
          ...replayedPreview(input.binding),
          totals: { sources: was.sources, rows: rows.length, derived: 0 },
          rows,
          superseded: lists.superseded.slice(0, LIST_LIMIT),
          superseded_total: lists.superseded.length,
        };
        return {
          receipt: {
            ...receiptOf(preview, { ...was, rc }, stillThere, true),
            now_awaiting: lists.now_awaiting.slice(0, LIST_LIMIT),
            now_awaiting_total: lists.now_awaiting.length,
            now_effective_total: lists.now_effective_total,
            omitted: lists.now_effective_known ? ["rows"] : ["rows", "lists"],
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
      const { seq, items } = await appendDeletion(tx, plan, {
        id,
        dueAt,
        actor: ctx.actor,
        now: ctx.now,
        head: { ...key.block, ...(ctx.task !== null ? { task: ctx.task } : {}) },
        newId: () => `pi_${randomCrockford(16)}`,
      });
      const stillThere = new Set(
        plan.rows.filter((r) => r.result.result.existsAfter).map((r) => r.id),
      );
      return {
        receipt: receiptOf(
          previewOf(plan, await writersOf(tx, impactOps(items)), items),
          { id, seq, dueAt, rc },
          stillThere,
          false,
          items.flatMap((out) => out.opened.map((o) => o.id)),
        ),
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
    /** The new items' IDs (`pi_…`). */
    readonly newId: () => string;
  },
): Promise<{ readonly seq: Seq; readonly items: readonly ItemEventsOut[] }> {
  const listed = plan.rows.filter((r) => r.result.result.listed);
  const items = plan.itemEvents(d.newId);
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
      superseded: items.flatMap((x) => x.superseded).sort(),
    }),
  };
  const op = await appendOperation(tx, {
    actor: d.actor,
    now: d.now,
    events: [
      { type: "deletion.confirmed", slot: plan.slot, blocks } as NewEvent,
      ...items.flatMap((x) => x.events),
    ],
  });
  const seq = op.events[0]?.seq as Seq;
  if (seq !== plan.self) {
    throw new WriteError("internal", "the deletion event did not get the seq worked out for it", {
      reason: "inconsistent",
    });
  }
  await applyEvents(tx, eventsOf(op));
  return { seq, items };
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
