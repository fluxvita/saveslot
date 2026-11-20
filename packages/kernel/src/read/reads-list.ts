// `reads.list` (docs/zh-CN/spec/04-contract.md §17; 04-contract-types.md §8.3; 05-surfaces «HTTP»:
// user sessions only): the read audit, newest first — who read what and when, the rows and the
// versions read (at most 50 a read, with the count), tables recorded at table level, the business
// time asked. Versions, never values. The ops layer writes the buffered reads first.

import type { EntityId, RowId, SourceId } from "@fluxvita/saveslot-contract-core";
import { isId } from "@fluxvita/saveslot-contract-core";
import type { ReadEntry, ReadOperation, ReadValid } from "../audit/index.ts";
import {
  fold,
  get,
  has,
  instantText,
  isObj,
  keysOf,
  nearest,
  parseDateTime,
} from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { digest, limitOf, pageAfter, positionOf } from "./page.ts";
import type { KeySpec } from "./rows.ts";
import { restoreCount } from "./select.ts";
import { visibleSlots } from "./slots.ts";
import { actors } from "./timeline.ts";
import { type Actor, invalid, ReadError } from "./types.ts";

export interface ReadsListResult {
  readonly total: number;
  /** The next page's position, unsigned (the service layer wraps it as `next_cursor`). */
  readonly next_position?: string;
  /** The read records reach back to this moment: the tenant's creation while none are pruned. */
  readonly covered_since: string;
  readonly reads: readonly {
    readonly read: string;
    readonly at: string;
    readonly actor: Actor;
    readonly task?: string;
    readonly operation: ReadOperation;
    readonly selfcheck?: true;
    readonly slot?: string;
    readonly sv?: number;
    readonly table?: string;
    readonly rows?: readonly {
      readonly target: { readonly table: string; readonly row?: RowId; readonly entity?: EntityId };
      readonly seq: number;
    }[];
    readonly rows_total?: number;
    readonly coarse?: readonly { readonly table: string; readonly pos: number }[];
    readonly valid?: ReadValid;
    readonly source?: SourceId;
  }[];
}

const KEYS = new Set([
  "connection",
  "slot",
  "table",
  "of_task",
  "since",
  "until",
  "limit",
  "position",
]);
const ROWS_SHOWN = 50;

interface Read {
  readonly n: number;
  readonly entry: ReadEntry;
}

/** `reads.list` for a user session. */
export async function readsListInTx(
  tx: ReadTx,
  input: {
    readonly actor: string;
    readonly now: string;
    readonly params: unknown;
  },
): Promise<ReadsListResult> {
  if (!isId("user", input.actor)) {
    throw new ReadError("insufficient_scope", "reads.list is for user sessions", {
      required_scope: "user_session",
    });
  }
  const params = input.params;
  if (!isObj(params)) throw invalid("malformed", "");
  for (const k of keysOf(params)) if (!KEYS.has(k)) throw invalid("malformed", k);
  const text = (k: string) => {
    if (!has(params, k)) return undefined;
    const v = get(params, k);
    if (typeof v !== "string" || v === "") throw invalid("malformed", k);
    return v;
  };
  const instant = (k: string) => {
    const v = text(k);
    if (v === undefined) return undefined;
    const p = parseDateTime(v, "UTC", false);
    if (!p.ok || p.assumed) throw invalid("malformed", k);
    return instantText(p.epochMs);
  };
  const since = instant("since");
  const until = instant("until");
  const ofTask = text("of_task");

  // Names of slots and tables (current definitions).
  const slots = await visibleSlots(tx, { kind: "all" });
  const slotName = new Map<string, string>(slots.map((x) => [x.slot, x.name]));
  const tableName = new Map<string, string>();
  for (const x of slots) for (const t of x.tables) tableName.set(t.id, `${x.name}.${t.name}`);

  let actorFilter: string | undefined;
  const connection = text("connection");
  if (connection !== undefined) {
    const p = await tx.query<{ id: string; name: string | null }>(
      "SELECT id, name FROM principals WHERE kind = 'connection'",
    );
    const hit = p.rows.find((x) => x.id === connection || x.name === connection);
    if (hit === undefined)
      throw new ReadError("not_found", "no such connection", {
        reason: "connection",
        param: "connection",
      });
    actorFilter = hit.id;
  }
  const slotFilter = text("slot");
  const slotId =
    slotFilter === undefined
      ? undefined
      : [...slotName].find(([, n]) => fold(n) === fold(slotFilter))?.[0];
  if (slotFilter !== undefined && slotId === undefined)
    throw new ReadError("not_found", "no such slot", { reason: "slot", param: "slot" });
  const tableFilter = text("table");
  const tableIds =
    tableFilter === undefined
      ? undefined
      : new Set(
          [...tableName]
            .filter(([, n]) => {
              const short = n.slice(n.indexOf(".") + 1);
              return fold(n) === fold(tableFilter) || fold(short) === fold(tableFilter);
            })
            .map(([id]) => id),
        );
  // A table no slot has: `unknown_table`, with the nearest names, as wherever a table is named
  // (04-contract-types §9): qualified names for a qualified one, bare names for a bare one.
  if (tableFilter !== undefined && tableIds !== undefined && tableIds.size === 0) {
    const qualified = tableFilter.includes(".");
    const names = [
      ...new Set([...tableName.values()].map((n) => (qualified ? n : n.slice(n.indexOf(".") + 1)))),
    ];
    throw new ReadError("unknown_table", `unknown table ${JSON.stringify(tableFilter)}`, {
      param: "table",
      name: tableFilter,
      nearest: nearest(
        tableFilter,
        names.map((name) => ({ name })),
      ),
    });
  }

  // Every read written, by its number.
  const written = await tx.query<Record<string, unknown>>("SELECT * FROM read_log ORDER BY n");
  const rows = await tx.query<{
    read_id: string;
    k: number;
    table_id: string;
    target: string | null;
    ver_op: unknown;
  }>("SELECT read_id, k, table_id, target, ver_op FROM read_log_rows ORDER BY read_id, k");
  const rowsOf = new Map<string, typeof rows.rows>();
  for (const r of rows.rows) rowsOf.set(r.read_id, [...(rowsOf.get(r.read_id) ?? []), r]);
  const all: Read[] = written.rows.map((x) => {
    const id = String(x["read_id"]);
    const mine = rowsOf.get(id) ?? [];
    const entry: ReadEntry = {
      read: id as never,
      actor: String(x["actor"]) as never,
      task: (x["task"] as string | null) ?? null,
      at: String(x["at"]) as never,
      pos: Number(x["pos"]) as never,
      operation: String(x["operation"]) as never,
      ...(x["selfcheck"] === true ? { selfcheck: true as const } : {}),
      ...(x["slot_id"] !== null ? { slot: x["slot_id"] as never } : {}),
      ...(x["sv"] !== null ? { sv: Number(x["sv"]) } : {}),
      ...(x["table_id"] !== null ? { table: x["table_id"] as never } : {}),
      ...(x["valid"] !== null ? { valid: JSON.parse(String(x["valid"])) as ReadValid } : {}),
      ...(x["source_id"] !== null ? { source: x["source_id"] as never } : {}),
      ...(x["rule_version"] !== null ? { ruleVersion: Number(x["rule_version"]) } : {}),
      ...(x["evaluated_at"] !== null ? { evaluatedAt: String(x["evaluated_at"]) as never } : {}),
      rows: mine
        .filter((r) => r.target !== null)
        .map((r) => ({
          table: r.table_id as never,
          target: r.target as string,
          ...(r.ver_op !== null ? { ver: { op: Number(r.ver_op) as never, restoreCount: 0 } } : {}),
        })),
      coarse: mine.filter((r) => r.target === null).map((r) => r.table_id as never),
      lastRead: [],
    };
    return { n: Number(x["n"]), entry };
  });

  const kept = all
    .filter(({ entry: e }) => {
      if (actorFilter !== undefined && e.actor !== actorFilter) return false;
      if (ofTask !== undefined && e.task !== ofTask) return false;
      if (since !== undefined && e.at < since) return false;
      if (until !== undefined && e.at >= until) return false;
      if (slotId !== undefined && e.slot !== slotId) return false;
      if (
        tableIds !== undefined &&
        !(
          (e.table !== undefined && tableIds.has(e.table)) ||
          e.rows.some((r) => tableIds.has(r.table)) ||
          e.coarse.some((t) => tableIds.has(t))
        )
      )
        return false;
      return true;
    })
    .sort((a, b) => b.n - a.n);

  // A later page lists the reads recorded up to the first page's last one (04-contract §15).
  const latest = all.length === 0 ? 0 : Math.max(...all.map((x) => x.n));
  const identity = digest({
    connection: actorFilter ?? null,
    slot: slotId ?? null,
    table: tableIds === undefined ? null : [...tableIds].sort(),
    of_task: ofTask ?? null,
    since: since ?? null,
    until: until ?? null,
  });
  const specs: KeySpec[] = [{ type: "count", dir: "desc" }];
  const restore = await restoreCount(tx);
  const position = positionOf(params, { identity, specs, restoreCount: restore, latest });
  const upTo = position?.seq ?? latest;
  const listed = kept.filter((x) => x.n <= upTo);
  const { page: pageItems, next } = pageAfter(
    listed.map((item) => ({ item, keys: [item.n] })),
    {
      specs,
      identity,
      position,
      seq: upTo,
      at: position?.at ?? input.now,
      restoreCount: restore,
      limit: limitOf(params),
    },
  );
  const page = pageItems;
  const who = await actors(
    tx,
    page.map((x) => x.entry.actor),
  );
  // Reads are kept from the tenant's creation (no pruning yet).
  const created = await tx.query<{ at: string }>("SELECT at FROM events WHERE seq = 1");
  return {
    total: listed.length,
    ...(next !== undefined ? { next_position: next } : {}),
    covered_since: created.rows[0]?.at ?? input.now,
    reads: page.map(({ entry: e }) => {
      const tn = (id: string) => tableName.get(id) ?? id;
      const shown = e.rows.slice(0, ROWS_SHOWN);
      return {
        read: e.read,
        at: e.at,
        actor: who.get(e.actor) as Actor,
        ...(e.task !== null ? { task: e.task } : {}),
        operation: e.operation,
        ...(e.selfcheck === true ? { selfcheck: true as const } : {}),
        ...(e.slot !== undefined ? { slot: slotName.get(e.slot) ?? e.slot } : {}),
        ...(e.sv !== undefined ? { sv: e.sv } : {}),
        ...(e.table !== undefined ? { table: tn(e.table) } : {}),
        ...(e.rows.length > 0
          ? {
              rows: shown.map((r) => ({
                target: {
                  table: tn(r.table),
                  ...(r.target.startsWith("e_")
                    ? { entity: r.target as EntityId }
                    : { row: r.target as RowId }),
                },
                seq: Number(r.ver?.op ?? 0),
              })),
              rows_total: e.rows.length,
            }
          : {}),
        ...(e.coarse.length > 0
          ? { coarse: e.coarse.map((t) => ({ table: tn(t), pos: Number(e.pos) })) }
          : {}),
        ...(e.valid !== undefined ? { valid: e.valid } : {}),
        ...(e.source !== undefined ? { source: e.source } : {}),
      };
    }),
  };
}
