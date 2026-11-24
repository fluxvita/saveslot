// apply of `deletion.confirmed` (docs/zh-CN/spec/09-event-format.md §5.9, the `apply` list; §5.12):
// the source table as the deletion leaves it, every row it touches settled from it as a write
// settles a row, and held to the event's results; the deletion's row and the blocks it lists.
//
// Every row or entity the deletion touches is rebuilt in the source table: a row with an item
// whose block the deletion lists (taken away, or a carried item dropped), with an item it
// restates, or that its `results` list. For each, from the row's `write.base` events in log order:
//
// - an item restated (`restated/<k>`) takes its restatement: in effect when `applied` or
//   `corroborated` (its interval, and its content when the restatement gives one: a carried
//   item's new value and sources, `no_value`, `uncovered`), out of the source table otherwise;
//   when the restatement gives the content, its rows name it (`given_seq`, `given_path`: where
//   the content is; a restatement of the judgement only leaves them naming the block before);
// - an item not restated whose own block the deletion lists is out of it;
// - any other item stays as the source table had it.
//
// The "reverted" registrations are worked out again over the row in log order (§5.7 `revert`: the
// items each revert takes back do not change; their ranges follow the write-backs' intervals now).
// The row is then settled from its items in effect (./settle.ts, as `write.base` does; the version
// cells' intent `deletion`), and held to the event: each stretch a result lists has the value and
// the giver the settled row has there; a state entity's gaps are the result's; a row the result says
// is deleted no longer exists. A row touched but not
// listed must settle to the cells it has. Anything else stops apply as inconsistent: the business
// table is what the results say, checked, never another state worked out silently.
//
// Refused with `not_implemented`, each a case of its own: a schema constant (`backfill` and
// `schema_const` sources are not applied in this version); a premise declaration's business time
// listed (premises with deletion); a key field listed on a table with an external key (keys with
// deletion); a restatement numbering a new item. `deletion.cancelled` goes the same way
// (`planDeletionCancelled`), each item's judgement the one the log last gives without the
// cancelled deletion's blocks. Not here: the tombstone.

import {
  type BizPoint,
  type CompiledBaseTable,
  canonicalize,
  type FieldId,
  type FieldValue,
  type JsonValue,
  type Seq,
} from "@fluxvita/saveslot-contract-core";
import type { SqlValue } from "../store/ports.ts";
import {
  canonical,
  type Interval,
  type IntervalSet,
  meet,
  type ValidParam,
  WHOLE,
} from "../time/index.ts";
import { ApplyError, type Change } from "./model.ts";
import { type Cell, registrations, type SettleContent, type SettleItem } from "./settle.ts";
import {
  BASE_SOURCE_COLUMNS,
  corroborationEnds,
  type OpenCell,
  regsJson,
  settleRowChanges,
  sourceRows,
} from "./write-base.ts";

type Obj = Readonly<Record<string, JsonValue>>;

/** An item of the source table as stored now (its first row), with what a rewrite keeps. */
export interface StoredItem {
  readonly status: "applied" | "corroborated";
  readonly valid: IntervalSet;
  readonly corroborationEnds: string | null;
  readonly schemaConst: boolean;
}

/** A row or entity the deletion touches, read by the caller. */
export interface DeletionRow {
  readonly table: CompiledBaseTable;
  readonly rowId: string;
  /** Its `write.base` events in log order: operation and blocks (pending ones too). */
  readonly events: readonly { readonly seq: Seq; readonly op: Seq; readonly blocks: Obj }[];
  /** Its items in the source table, by `"<event>/<target>/<k>"`. */
  readonly stored: ReadonlyMap<string, StoredItem>;
  readonly openCells: readonly OpenCell[];
  readonly count: number;
  /** `row_origins`: the write that first created it, if one did. */
  readonly origin: Seq | null;
  /** State tables: a write's interval as written and "now", by event (corroboration ends). */
  readonly written: ReadonlyMap<Seq, { valid: ValidParam | undefined; now: BizPoint } | undefined>;
  /**
   * Where each item's content is when a deletion's restatement last gave it one (a carried item's
   * value, `no_value`, `uncovered`), by item: read from the log, the deletion events' blocks only
   * (cancelled deletions' left out), so an item out of the source table keeps it too.
   */
  readonly contentGiven: ReadonlyMap<string, { seq: Seq; path: string; block: Obj }>;
}

export interface DeletionInput {
  readonly rows: readonly DeletionRow[];
}

const key = (event: Seq, target: string, k: number) => `${event}/${target}/${k}`;
/** Code-point order, as the log orders paths. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const inconsistent = (seq: Seq, message: string) => new ApplyError("inconsistent", seq, message);
const notYet = (seq: Seq, what: string) =>
  new ApplyError("not_implemented", seq, `a deletion ${what} is not applied yet`);
const effective = (s: string): s is "applied" | "corroborated" =>
  s === "applied" || s === "corroborated";

/** An interval as a block writes it: a missing end is open. */
const intervalIn = (v: JsonValue | undefined): IntervalSet => {
  if (v === undefined) return [WHOLE];
  const x = v as Obj;
  return [{ from: (x["from"] as never) ?? null, to: (x["to"] as never) ?? null } as Interval];
};

/** A contribution reference as an item key. */
const refKey = (r: Obj) =>
  "existence" in r
    ? key(r["event"] as Seq, "existence", r["existence"] as number)
    : key(r["event"] as Seq, r["field"] as string, r["k"] as number);

/** A restatement (`restated/<k>`), by the item it restates. */
interface Restated {
  readonly path: string;
  readonly event: Seq;
  readonly target: FieldId | "existence";
  readonly k: number;
  readonly block: Obj;
}

function restatedOf(present: Obj): Map<string, Restated> {
  const out = new Map<string, Restated>();
  for (const [path, v] of Object.entries(present)) {
    if (!/^restated\/\d+$/.test(path)) continue;
    const b = v as Obj;
    const target = ("existence" in b ? "existence" : b["field"]) as FieldId | "existence";
    const k = ("existence" in b ? b["existence"] : b["k"]) as number;
    const event = b["event"] as Seq;
    out.set(key(event, target, k), { path, event, target, k, block: b });
  }
  return out;
}

/** The content of a field item from a block giving one (its own `fields/<f>/<k>`, a restatement). */
function fieldContent(b: Obj): SettleContent {
  if ("value" in b) return { kind: "value", value: b["value"] as FieldValue };
  if ("no_value" in b) return { kind: "no_value" };
  return { kind: "uncovered" };
}
const givesContent = (b: Obj) => "value" in b || "no_value" in b || "uncovered" in b;

/** The row's items after the deletion, in effect, with their source table rows. */
function itemsAfter(
  seq: Seq,
  row: DeletionRow,
  restated: ReadonlyMap<string, Restated>,
  listed: ReadonlySet<string>,
): {
  items: SettleItem[];
  rows: (x: SettleItem, reverted: string) => SqlValue[][];
  renewed: Set<string>;
} {
  const isState = row.table.time.type === "state";
  const keyFields = new Set<string>(
    row.table.time.type !== "state" ? (row.table.external_key ?? []) : [],
  );
  const items: SettleItem[] = [];
  const rowsOf = new Map<string, (reverted: string) => SqlValue[][]>();
  const renewed = new Set<string>();
  for (const s of row.stored.values()) if (s.schemaConst) throw notYet(seq, "on a schema constant");
  for (const ev of row.events) {
    // Every item block of the event: `fields/<f>/<k>`, `existence/<k>`.
    const blocks = new Set<string>();
    for (const path of Object.keys(ev.blocks)) {
      const f = /^fields\/(f\d+)\/(\d+)$/.exec(path);
      const e = /^existence\/(\d+)$/.exec(path);
      if (f !== null) blocks.add(key(ev.seq, f[1] as string, Number(f[2])));
      else if (e !== null) blocks.add(key(ev.seq, "existence", Number(e[1])));
      if (f !== null && keyFields.has(f[1] as string) && listed.has(`${ev.seq} ${path}`))
        throw notYet(seq, "of a key field");
    }
    for (const r of restated.values()) {
      if (r.event === ev.seq && !blocks.has(key(r.event, r.target, r.k)))
        throw notYet(seq, `restating an item it numbers anew (${r.event}/${r.target}/${r.k})`);
    }
    // In the order the write path takes them: by block path (`fields/…` and `existence/…`).
    const pathOf = (k: string) => {
      const [, t, kk] = k.split("/") as [string, string, string];
      return t === "existence" ? `existence/${kk}` : `fields/${t}/${kk}`;
    };
    for (const k of [...blocks].sort((a, b) => cmp(pathOf(a), pathOf(b)))) {
      const [, target, kk] = k.split("/") as [string, FieldId | "existence", string];
      const idx = Number(kk);
      const ownPath = target === "existence" ? `existence/${idx}` : `fields/${target}/${idx}`;
      const own = ev.blocks[ownPath] as Obj;
      const r = restated.get(k);
      const stored = row.stored.get(k);
      let status: "applied" | "corroborated";
      let valid: IntervalSet;
      let content: SettleContent;
      let sources: readonly Obj[] | undefined;
      let given: { seq: Seq; path: string } | null;
      let ends: string | null;
      if (r !== undefined) {
        const st = r.block["status"] as string;
        if (!effective(st)) continue;
        if ((r.block["sources"] as Obj[] | undefined)?.some((x) => x["kind"] === "schema_const"))
          throw notYet(seq, "restating a value to a schema constant");
        status = st;
        valid = isState ? intervalIn(r.block["valid"]) : [WHOLE];
        if (target === "existence") {
          content =
            r.block["restored"] === true || own["restored"] === true
              ? { kind: "restore" }
              : { kind: "revoke" };
          if (!isState || own["scope"] !== "interval") valid = [WHOLE];
        } else if (givesContent(r.block)) {
          content = fieldContent(r.block);
          renewed.add(k);
          if ("value" in r.block) sources = r.block["sources"] as Obj[];
        } else {
          // The restatement gives the judgement only: the content as last given.
          const last = row.contentGiven.get(k)?.block ?? own;
          content = fieldContent(last);
          if (last !== own && "value" in last) sources = last["sources"] as Obj[];
        }
        // `given_seq`/`given_path` name where the item's content is: this restatement when it gives
        // one, else the block that gave it last (the judgement is in the source table's columns).
        const before = row.contentGiven.get(k);
        given = givesContent(r.block)
          ? { seq, path: r.path }
          : before === undefined
            ? null
            : { seq: before.seq, path: before.path };
        const w = row.written.get(ev.seq);
        ends =
          isState && status === "corroborated"
            ? canonicalize(
                (w === undefined ? [] : corroborationEnds(valid, w.valid, w.now)) as never,
              )
            : null;
      } else {
        if (stored === undefined) continue; // not in effect, and the deletion leaves it so
        const mine =
          target === "existence"
            ? listed.has(`${ev.seq} span/existence/${idx}`)
            : listed.has(`${ev.seq} ${ownPath}`);
        // Its own block read no more: taken away (or a carried item dropped), unless a deletion's
        // restatement still readable gave its content again (09 §5.9: then it is still a
        // contribution, its content where that restatement is).
        const again = row.contentGiven.get(k);
        if (mine && (again === undefined || listed.has(`${again.seq} ${again.path}`))) continue;
        status = stored.status;
        valid = stored.valid;
        const last = row.contentGiven.get(k)?.block ?? own;
        content =
          target === "existence"
            ? own["restored"] === true
              ? { kind: "restore" }
              : { kind: "revoke" }
            : fieldContent(last);
        if (target !== "existence" && last !== own && "value" in last)
          sources = last["sources"] as Obj[];
        const before = row.contentGiven.get(k);
        given = before === undefined ? null : { seq: before.seq, path: before.path };
        ends = stored.corroborationEnds;
      }
      const x: SettleItem = { event: ev.seq, target, k: idx, status, valid, content, reverted: [] };
      items.push(x);
      rowsOf.set(k, (reverted) =>
        sourceRows(ev.seq, row.rowId, x, ev.blocks, ends, {
          ...(sources !== undefined ? { sources } : {}),
          reverted,
          ...(given !== null ? { given } : {}),
        }),
      );
    }
  }
  return {
    items,
    renewed,
    rows: (x, reverted) =>
      (rowsOf.get(key(x.event, x.target, x.k)) as (r: string) => SqlValue[][])(reverted),
  };
}

/** The "reverted" registrations worked out again over the row's items in log order (§5.7). */
function registered(row: DeletionRow, items: readonly SettleItem[]): SettleItem[] {
  let out = items.map((x) => ({ ...x, reverted: [] as SettleItem["reverted"] }));
  for (const ev of row.events) {
    const revert = ev.blocks["revert"] as Obj | undefined;
    if (revert === undefined) continue;
    const entries = (revert["items"] as Obj[]).map((e) => ({
      event: e["event"] as Seq,
      target: (e["field"] as string | undefined) ?? "existence",
      ...(e["later"] === true ? { later: true as const } : {}),
    }));
    const before = out.filter((x) => x.event < ev.seq);
    const mine = out.filter((x) => x.event === ev.seq);
    for (const r of registrations(before, entries, mine)) {
      out = out.map((x) =>
        x.event === r.item.event && x.target === r.item.target && x.k === r.item.k
          ? { ...x, reverted: [...x.reverted, { op: ev.op, valid: r.valid }] }
          : x,
      );
    }
  }
  return out;
}

/** A result row of the event (`results/<k>/…`). */
interface ResultOf {
  readonly table: string;
  readonly id: string;
  readonly outcome: string;
  readonly stretches: readonly {
    field: string;
    value: FieldValue | null;
    carried?: string;
    valid: IntervalSet;
  }[];
  readonly gaps?: IntervalSet;
}

function resultsOf(seq: Seq, present: Obj): ResultOf[] {
  const rows = new Map<
    number,
    { target?: Obj; existence?: Obj; stretches: ResultOf["stretches"][number][] }
  >();
  const row = (k: number) => {
    const r = rows.get(k) ?? { stretches: [] };
    rows.set(k, r);
    return r;
  };
  for (const [p, v] of Object.entries(present)) {
    const t = /^results\/(\d+)\/(target|existence)$/.exec(p);
    if (t !== null) {
      if (t[2] === "target") row(Number(t[1])).target = v as Obj;
      else row(Number(t[1])).existence = v as Obj;
      continue;
    }
    const f = /^results\/(\d+)\/fields\/(f\d+)\/\d+$/.exec(p);
    if (f === null) continue;
    const b = v as Obj;
    const carried = (b["sources"] as Obj[]).find((s) => s["carried"] !== undefined)?.["carried"] as
      | Obj
      | undefined;
    if ((b["sources"] as Obj[]).some((s) => s["kind"] === "schema_const"))
      throw notYet(seq, "result on a schema constant");
    row(Number(f[1])).stretches.push({
      field: f[2] as string,
      value: b["value"] as FieldValue | null,
      ...(carried !== undefined ? { carried: refKey(carried) } : {}),
      valid: "valid" in b ? intervalIn(b["valid"]) : [WHOLE],
    });
  }
  return [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, r]) => {
      const t = r.target as Obj;
      return {
        table: t["table"] as string,
        id: (t["row"] ?? t["entity"]) as string,
        outcome: t["outcome"] as string,
        stretches: r.stretches,
        ...(r.existence !== undefined
          ? {
              gaps: canonical(
                (r.existence["gaps"] as Obj[]).map(
                  (g) =>
                    ({
                      from: (g["from"] as never) ?? null,
                      to: (g["to"] as never) ?? null,
                    }) as Interval,
                ),
              ),
            }
          : {}),
      };
    });
}

const same = (a: unknown, b: unknown) =>
  canonicalize((a ?? null) as JsonValue) === canonicalize((b ?? null) as JsonValue);
const ivKey = (v: IntervalSet) => JSON.stringify(canonical(v).map((x) => [x.from, x.to]));

/** A field's settled cells run together where the value and the giver stay the same. */
function runs(cells: readonly Cell[], field: string) {
  const out: { valid: Interval; value: FieldValue; by: string | null }[] = [];
  const mine = cells
    .filter((c) => c.field === field)
    .sort((a, b) => String(a.valid?.from ?? "").localeCompare(String(b.valid?.from ?? "")));
  for (const c of mine) {
    const by = c.by === null ? null : key(c.by.event, c.by.target, c.by.k);
    const v = c.valid ?? WHOLE;
    const last = out.at(-1);
    if (
      last !== undefined &&
      last.valid.to !== null &&
      last.valid.to === v.from &&
      last.by === by &&
      same(last.value, c.value)
    ) {
      out[out.length - 1] = { ...last, valid: { from: last.valid.from, to: v.to } as Interval };
    } else out.push({ valid: v, value: c.value, by });
  }
  return out;
}

/** The changes of a `deletion.confirmed`. Pure; throws {@link ApplyError}. */
export function planDeletionConfirmed(seq: Seq, present: Obj, input: DeletionInput): Change[] {
  const t = present["target"] as Obj;
  const positions = present["positions"] as { seq: Seq; path: string }[];
  const listed = new Set(positions.map((p) => `${p.seq} ${p.path}`));
  for (const p of positions) {
    if (/^backfill\//.test(p.path)) throw notYet(seq, "on a schema constant's backfill");
    if (/^ops\/\d+\/premise_valid\/\d+$/.test(p.path))
      throw notYet(seq, "of a premise declaration's business time");
  }
  return [
    ...planRows(seq, present, input, listed, "deletion"),
    // The deleted sources read as pending deletion: no write refers to them as evidence any more
    // (03-deletion «撤回与宽限期»: `pending_deletion_source`).
    { kind: "sources_state", seqs: [...(t["sources"] as Seq[])], state: "pending_deletion" },
    {
      kind: "deletion_insert",
      id: t["deletion"] as string,
      deletion_kind: t["kind"] as string,
      due_at: t["due_at"] as string,
      confirmed_seq: seq,
    },
    { kind: "pending_blocks", deletion_seq: seq, positions },
  ];
}

/** What a cancellation reads besides the rows it touches. */
export interface CancellationInput extends DeletionInput {
  /** The `deletion.confirmed` it cancels. */
  readonly cancelled: Seq;
  /** The sources it deleted that no other pending deletion deletes: present again. */
  readonly sources: readonly Seq[];
  /** The blocks of the rows' events still pending under the other pending deletions. */
  readonly listed: ReadonlySet<string>;
  /** The items put back undecided (`restored_items`): each one's flag, if its type gives one. */
  readonly restored: readonly {
    readonly id: string;
    readonly flag?: Extract<Change, { kind: "flag_insert" }>["row"];
  }[];
}

/**
 * The changes of a `deletion.cancelled` (§5.9): the rows it touches as for a confirmation, each
 * item's judgement the one the log last gives without the cancelled deletion's blocks (the
 * caller's `stored`), and the blocks read no more those the other pending deletions list; the
 * version cells' intent `deletion_cancelled`. The deletion cancelled; its blocks readable again
 * where no other pending deletion lists them; the items it superseded put back undecided, with
 * their flags. `kept_superseded` and `kept_effective` are metadata (their effect is in the
 * restatements and item events). Pure; throws {@link ApplyError}.
 */
export function planDeletionCancelled(seq: Seq, present: Obj, input: CancellationInput): Change[] {
  const t = present["target"] as Obj;
  const changes = planRows(seq, present, input, input.listed, "deletion_cancelled");
  changes.push(
    { kind: "deletion_cancel", id: t["deletion"] as string },
    { kind: "pending_release", deletion_seq: input.cancelled },
    // The sources it deleted read as present again, but those another pending deletion deletes.
    { kind: "sources_state", seqs: [...input.sources], state: "present" },
  );
  for (const r of input.restored) {
    changes.push({ kind: "item_update", id: r.id, state: "open", version_op: seq });
    if (r.flag !== undefined) changes.push({ kind: "flag_insert", row: r.flag });
  }
  return changes;
}

/**
 * The rows a deletion or a cancellation touches, rebuilt in the source table, settled and held to
 * its results; the first creations it gives. `listed`: the blocks of the rows' events read no more.
 */
function planRows(
  seq: Seq,
  present: Obj,
  input: DeletionInput,
  listed: ReadonlySet<string>,
  intent: string,
): Change[] {
  const restated = restatedOf(present);
  const results = resultsOf(seq, present);
  const changes: Change[] = [];
  const byRow = new Map(input.rows.map((r) => [r.rowId, r]));
  for (const r of results) {
    const row = byRow.get(r.id);
    if (row === undefined || row.table.id !== r.table)
      throw inconsistent(seq, `results name ${r.table}/${r.id}, not a row the deletion touches`);
  }
  for (const row of input.rows) {
    const after = itemsAfter(seq, row, restated, listed);
    const items = registered(row, after.items);
    changes.push({
      kind: "base_sources_row",
      row_id: row.rowId,
      columns: BASE_SOURCE_COLUMNS,
      rows: items.flatMap((x) => after.rows(x, regsJson(x.reverted))),
    });
    const { settled, changes: settledChanges } = settleRowChanges(
      row.table,
      row.rowId,
      items,
      row.openCells,
      row.count,
      seq,
      intent,
      after.renewed,
    );
    const result = results.find((x) => x.id === row.rowId);
    const isState = row.table.time.type === "state";
    if (result === undefined) {
      // Touched, not listed: the row must settle to the cells it has. The one exception is an event
      // or timeless row that did not exist before and does not after (revoked, its fields' values
      // kept): what it keeps is not what the results speak of (§5.9 «列哪些»); it is settled as the
      // source table leaves it, unchecked. A row gone without being listed is not this.
      const exists = isState ? settled.rows.length > 0 : settled.rows.some((x) => !x.revoked);
      const cells = settledChanges.find((c) => c.kind === "cells");
      const changed = cells?.kind === "cells" && (cells.close.length > 0 || cells.rows.length > 0);
      if (!isState && !exists && row.count === 0) changes.push(...settledChanges);
      else if (changed)
        throw inconsistent(seq, `${row.rowId} changes but the deletion does not list it`);
      continue;
    }
    changes.push(...settledChanges);
    // Held to the result: each stretch listed, the gaps, whether it exists.
    for (const s of result.stretches) {
      const found = runs(settled.cells, s.field).find(
        (x) =>
          ivKey([x.valid]) === ivKey(s.valid) &&
          same(x.value, s.value) &&
          (s.carried === undefined ? s.value === null : x.by === s.carried),
      );
      if (found === undefined)
        throw inconsistent(
          seq,
          `${row.rowId} ${s.field} on ${ivKey(s.valid)}: the result is not what the row settles to`,
        );
    }
    // And the other way (§5.9 «没列到的段保持原样»): outside every stretch listed of a field and
    // outside the result's gaps, each piece of the field is given by the same item (or by none,
    // with or without saying the entity has no value) before and after. By pieces, not by cells: a
    // field's cells are cut where the row's segments are, which other fields move. A value changing
    // with its giver the same is a restated item's, and so listed. An event or timeless row that
    // does not exist once settled has its fields' values kept but not spoken of: not looked at.
    const existsNow = isState ? settled.rows.length > 0 : settled.rows.some((x) => !x.revoked);
    if (isState || existsNow) {
      const fields = new Set<string>([
        ...row.openCells.map((c) => c.field),
        ...settled.cells.map((c) => c.field),
      ]);
      fields.delete("existence");
      // An empty cell no item gives says nothing a missing cell does not: whether the entity has
      // a value there is the gaps' to say, held above.
      const giverOf = (by: { event: Seq; target: string; k: number } | null, noValue: boolean) =>
        by === null && !noValue
          ? "none"
          : `${by === null ? "-" : key(by.event, by.target, by.k)}|${noValue}`;
      const giverAt = (
        cells: readonly { from: string | null; to: string | null; giver: string }[],
        piece: Interval,
      ) =>
        cells.find((c) => meet([{ from: c.from, to: c.to } as Interval], [piece]).length > 0)
          ?.giver ?? "none";
      for (const f of fields) {
        const was = row.openCells
          .filter((c) => c.field === f)
          .map((c) => ({
            from: c.valid_from,
            to: c.valid_to,
            giver: giverOf(c.src, c.no_value),
          }));
        const is = settled.cells
          .filter((c) => c.field === f)
          .map((c) => ({
            from: c.valid?.from ?? null,
            to: c.valid?.to ?? null,
            giver: giverOf(c.by, c.noValue === true),
          }));
        const skip = canonical([
          ...result.stretches.filter((x) => x.field === f).flatMap((x) => x.valid),
          ...(result.gaps ?? []),
        ]);
        const points = [
          ...new Set(
            [...was, ...is, ...skip].flatMap((c) => [c.from, c.to]).filter((x) => x !== null),
          ),
        ].sort(cmp) as string[];
        const bounds: (string | null)[] = [null, ...points, null];
        for (let i = 0; i + 1 < bounds.length; i++) {
          const piece = { from: bounds[i] ?? null, to: bounds[i + 1] ?? null } as Interval;
          if (piece.from !== null && piece.to !== null && piece.from >= piece.to) continue;
          if (meet([piece], skip).length > 0) continue;
          const before = giverAt(was, piece);
          const after = giverAt(is, piece);
          if (before !== after)
            throw inconsistent(
              seq,
              `${row.rowId}: ${f} on ${ivKey([piece])} changes (${before} → ${after}) but is not listed`,
            );
        }
      }
    }
    if (isState) {
      const has = canonical(settled.rows.flatMap((x) => (x.valid === undefined ? [] : [x.valid])));
      const gaps = complement(has);
      if (ivKey(gaps) !== ivKey(result.gaps ?? []))
        throw inconsistent(seq, `${row.rowId}: its gaps are not the result's`);
    }
    const exists = isState ? settled.rows.length > 0 : settled.rows.some((x) => !x.revoked);
    // `deleted`: it existed before and does not now (§5.9); any other outcome may be of a row not
    // existing before or after (a revoked row whose giver changed is `sources_changed`).
    if (result.outcome === "deleted" && exists)
      throw inconsistent(seq, `${row.rowId}: outcome deleted but it exists`);
  }
  // The first creations (`recreated/<k>`).
  const rowOfEvent = new Map<Seq, DeletionRow>();
  for (const row of input.rows) for (const e of row.events) rowOfEvent.set(e.seq, row);
  const created = new Set<string>();
  for (const [p, v] of Object.entries(present)) {
    if (!/^recreated\/\d+$/.test(p)) continue;
    const b = v as Obj;
    const row = rowOfEvent.get(b["event"] as Seq);
    if (row === undefined) throw inconsistent(seq, `${p}: no row the deletion touches`);
    if (b["created"] === true) {
      created.add(row.rowId);
      changes.push({
        kind: "row_origin",
        row_id: row.rowId,
        table_id: row.table.id,
        seq: b["event"] as Seq,
      });
    }
  }
  for (const [p, v] of Object.entries(present)) {
    if (!/^recreated\/\d+$/.test(p)) continue;
    const b = v as Obj;
    const row = rowOfEvent.get(b["event"] as Seq) as DeletionRow;
    if (b["created"] === false && row.origin === b["event"] && !created.has(row.rowId))
      changes.push({ kind: "row_origin_drop", row_id: row.rowId });
  }
  return changes;
}

/** The complement of sorted, disjoint intervals over the whole time. */
function complement(has: IntervalSet): IntervalSet {
  const out: Interval[] = [];
  let at: string | null = null;
  let started = false;
  for (const x of has) {
    if (!started) {
      if (x.from !== null) out.push({ from: null, to: x.from } as Interval);
    } else if (at !== x.from) out.push({ from: at, to: x.from } as Interval);
    started = true;
    at = x.to;
    if (at === null) return out;
  }
  if (!started) return [WHOLE];
  out.push({ from: at, to: null } as Interval);
  return out;
}
