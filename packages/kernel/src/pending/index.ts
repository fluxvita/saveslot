// Pending items (docs/zh-CN/spec/02-architecture.md §4 `pending`; 03-data-model/01-objects.md
// «待处理事项»; 09-event-format.md §5.8): what the items on a row are now, whether a writer had
// read an item's current version, and the entry blocks of an item event. What the entries hold is
// computed from the row's state elsewhere (judge); the shapes here are the blocks'.

import type { ReadTx } from "../store/ports.ts";

/** A contribution reference (§3.5). */
export interface EntryRef {
  readonly event: number;
  readonly target: string;
  readonly k: number;
}

/** A stretch of an item's unit (`current/<k>`, `previous/<k>`). */
export type UnitEntryBlock =
  | {
      readonly field: string;
      readonly value: unknown;
      readonly valid?: { readonly from: string | null; readonly to: string | null };
      readonly op?: number;
      readonly deps: readonly EntryRef[];
    }
  | {
      readonly field: "existence";
      readonly revoked: true;
      readonly valid?: { readonly from: string | null; readonly to: string | null };
      readonly op: number;
      readonly deps: readonly EntryRef[];
    }
  | {
      readonly field: "existence";
      readonly revoked?: never;
      readonly valid?: { readonly from: string | null; readonly to: string | null };
      readonly deps: readonly EntryRef[];
    };

/** An entry of `impact/<k>`. */
export type ImpactBlock =
  | {
      readonly kind: "overwritten_segment";
      readonly field: string;
      readonly valid?: { readonly from: string | null; readonly to: string | null };
      readonly value: unknown;
      /** A stretch without a value (a gap filled), apart from a value cleared to null. */
      readonly gap?: true;
      readonly op?: number;
      readonly deps: readonly EntryRef[];
    }
  | { readonly kind: "reverted_write"; readonly op: number; readonly deps: readonly EntryRef[] };

/** A proposed value of an awaiting item (`proposed/<k>`). */
export interface ProposedBlock {
  readonly field: string;
  readonly value: unknown;
  readonly valid?: { readonly from: string | null; readonly to: string | null };
  readonly deps: readonly EntryRef[];
}

const refOut = (r: EntryRef) =>
  r.target === "existence"
    ? { event: r.event, existence: r.k }
    : { event: r.event, field: r.target, k: r.k };

const spanOut = (v: { from: string | null; to: string | null }) => ({
  ...(v.from !== null ? { from: v.from } : {}),
  ...(v.to !== null ? { to: v.to } : {}),
});

/** The contents of an item: whole groups, each given every time (09 §5.8, zero blocks = empty). */
export interface ItemContents {
  readonly scope?: {
    readonly valid: readonly { from: string | null; to: string | null }[];
    readonly deps: readonly EntryRef[];
  };
  readonly current?: readonly UnitEntryBlock[];
  readonly previous?: readonly UnitEntryBlock[];
  readonly proposed?: readonly ProposedBlock[];
  readonly impact?: readonly ImpactBlock[];
}

/** The entry blocks of an item event, by path. */
export function contentBlocks(c: ItemContents): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // The item's interval as its spans (canonical: by start, apart), never a hull of them; the whole
  // time (a candidate revoking the whole entity) is `[{}]`.
  if (c.scope !== undefined && c.scope.valid.length > 0) {
    out["scope_valid"] = {
      spans: c.scope.valid.map(spanOut),
      deps: c.scope.deps.map(refOut),
    };
  }
  // `current/<k>` names the operation that wrote each stretch, so a stretch no write ever gave a
  // state is not listed; `previous/<k>` gives a field's value without it (09 §5.8).
  const unit = (prefix: "current" | "previous", xs: readonly UnitEntryBlock[] | undefined) => {
    let k = 0;
    for (const e of xs ?? []) {
      // Entries on the unit "existence" carry no value.
      if (!("value" in e)) {
        out[`${prefix}/${k++}`] = {
          field: "existence",
          ...("op" in e ? { revoked: true, op: e.op } : {}),
          ...(e.valid !== undefined ? { valid: spanOut(e.valid) } : {}),
          deps: e.deps.map(refOut),
        };
        continue;
      }
      if (prefix === "current" && e.op === undefined) continue;
      out[`${prefix}/${k++}`] = {
        field: e.field,
        value: e.value ?? null,
        ...(e.valid !== undefined ? { valid: spanOut(e.valid) } : {}),
        ...(prefix === "current" ? { op: e.op } : {}),
        deps: e.deps.map(refOut),
      };
    }
  };
  unit("current", c.current);
  unit("previous", c.previous);
  c.proposed?.forEach((e, k) => {
    out[`proposed/${k}`] = {
      field: e.field,
      value: e.value ?? null,
      ...(e.valid !== undefined ? { valid: spanOut(e.valid) } : {}),
      deps: e.deps.map(refOut),
    };
  });
  c.impact?.forEach((e, k) => {
    out[`impact/${k}`] =
      e.kind === "reverted_write"
        ? { kind: e.kind, op: e.op, deps: e.deps.map(refOut) }
        : {
            kind: e.kind,
            field: e.field,
            ...(e.valid !== undefined ? { valid: spanOut(e.valid) } : {}),
            value: e.value ?? null,
            ...(e.gap === true ? { gap: true } : {}),
            ...(e.op !== undefined ? { op: e.op } : {}),
            deps: e.deps.map(refOut),
          };
  });
  return out;
}

/** An open item on a row, as `pending_items` keeps it. */
export interface OpenItemRow {
  readonly id: string;
  readonly type: string;
  readonly versionOp: number;
}

/** The open items on a row or entity. */
export async function openItemsOn(tx: ReadTx, table: string, row: string): Promise<OpenItemRow[]> {
  const r = await tx.query<{ id: string; type: string; version_op: unknown }>(
    `SELECT id, type, version_op FROM pending_items
     WHERE target_table = $1 AND target_row = $2 AND state = 'open' ORDER BY id`,
    [table, row],
  );
  return r.rows.map((x) => ({ id: x.id, type: x.type, versionOp: Number(x.version_op) }));
}

/**
 * Whether the writer's own receipt gave it the item's current version (01-objects «不过期»): the
 * current version is the one a write of this connection, under the same task, opened, whose
 * receipt gave it whole with its item version, and no restore came since (the version names the
 * restore count). Reading the item is the other way (the caller checks the reads kept).
 */
export async function writerHadRead(
  tx: ReadTx,
  item: OpenItemRow,
  actor: string,
  task: string | null,
): Promise<boolean> {
  const r = await tx.query<{ n: unknown }>(
    `SELECT count(*) AS n FROM events h
     JOIN events c ON c.op = h.seq AND c.type = 'item.created'
     JOIN content t ON t.seq = c.seq AND t.path = 'target' AND t.body IS NOT NULL
     WHERE h.seq = $1 AND h.type = 'write.head' AND h.actor = $2
       AND (t.body::jsonb ->> 'item') = $3
       AND (SELECT k.body::jsonb #>> '{}' FROM content k WHERE k.seq = h.seq AND k.path = 'task' AND k.body IS NOT NULL)
         IS NOT DISTINCT FROM $4::text
       AND NOT EXISTS (SELECT 1 FROM events r WHERE r.type = 'tenant.restored' AND r.seq > h.seq)`,
    [item.versionOp, actor, item.id, task],
  );
  return Number(r.rows[0]?.n ?? 0) > 0;
}

export * from "./actors.ts";
export * from "./closing.ts";
export * from "./detail.ts";
