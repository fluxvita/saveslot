// `sources` (docs/zh-CN/spec/04-contract.md «sources»; 04-contract-types.md §4.6): the source data
// of the visible slots, listed, searched or read one at a time.
//
// - Visible range (03-data-model/04-write-and-read «可见范围»): every source belongs to one slot;
//   one of a slot the caller cannot see, or of a slot removed, is as one that does not exist
//   (`not_found`, reason `source`, the same bytes either way). A `slot` filter naming no visible
//   slot is `not_found` (`slot`). What a source produced is given only in the tables the caller
//   sees.
// - Order: by `seq`, newest first, and nothing else: the log's order, which a clock set back does
//   not reorder. `from` / `to` filter by the recorded time, `[from, to)`. Pages by `position`, its
//   key the last `seq` given; later pages see the sources of operations up to the first page's.
// - `search`: a substring of the text, a file reference's name and excerpt, and an `api_call`'s
//   request (its JCS text); not the slot's name nor the writer. Both sides NFC, ASCII letters
//   folded (A–Z only, as names are compared), on copies: what is stored is not changed. Scanned
//   in batches by `seq`, at most `SEARCH_SCAN` sources a call: a page may hold fewer than `limit`
//   and still give `next_position`.
// - `api_call` has no text: its request block is. `get` gives that block's JCS text as `text`, a
//   list its first 200 characters as `excerpt`.
// - `correction`: the source is a value source of a write whose intent is `correct`
//   (`isCorrection`, as `history`'s timeline marks it).
// - Deletion: a source pending deletion or removed gives none of its content. Where that state
//   comes from (the deletion's item and expiry, the removal's time and reason) is not in this
//   version of the kernel: such a source in a slot the caller sees fails the whole call
//   (`internal`, `not_implemented`), whatever the mode, the filters or the page, before anything
//   is looked at, rather than being shown as present or left out.
// - A slot the caller sees only in part (some of its tables): none of its sources, in any mode,
//   as if there were none (`get`: `not_found`, as above). A source's text may name any table.
// - Recorded in the read log as `sources`: the mode and the opaque IDs (the slot filtered by, the
//   source read); never the search text (04-write-and-read «读取记录里记什么形状»).

import type { SlotId, SourceId } from "@fluxvita/saveslot-contract-core";
import { canonicalize, SOURCE_KINDS } from "@fluxvita/saveslot-contract-core";
import type { ReadEntry } from "../audit/index.ts";
import { actorsNow } from "../pending/index.ts";
import {
  fold,
  get,
  has,
  instantText,
  isObj,
  keysOf,
  type Obj,
  parseDateTime,
} from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { isCorrection } from "./correction.ts";
import { digest, limitOf, positionOf } from "./page.ts";
import { encodePosition, type KeySpec } from "./rows.ts";
import { logPosition, restoreCount } from "./select.ts";
import { type Visibility, type VisibleSlot, visibleSlots } from "./slots.ts";
import { type Actor, invalid, notImplemented, ReadError } from "./types.ts";

/** At most this many sources are looked at by one `search` call. */
export const SEARCH_SCAN = 2000;
/** How many sources a `search` reads at a time. */
const BATCH = 200;
/** A list's excerpt: the first this many characters (code points). */
const EXCERPT = 200;

type Mode = "list" | "search" | "get";

/** The parameters each mode takes. */
const KEYS: Readonly<Record<Mode, ReadonlySet<string>>> = {
  list: new Set(["mode", "slot", "kind", "from", "to", "limit", "position"]),
  search: new Set(["mode", "slot", "kind", "from", "to", "q", "limit", "position"]),
  get: new Set(["mode", "id"]),
};
const ALL_KEYS = new Set([...KEYS.list, ...KEYS.search, ...KEYS.get]);

interface FileOut {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}

export interface SourcesListItem {
  readonly id: SourceId;
  readonly kind: string;
  readonly slot: string;
  readonly recorded_at: string;
  readonly stated_at?: string;
  readonly actor: Actor;
  readonly correction?: true;
  readonly excerpt?: string;
  readonly file?: FileOut;
}

export interface SourcesListResult {
  readonly mode: "list" | "search";
  readonly sources: readonly SourcesListItem[];
  /** The next page's position, unsigned (the service layer wraps it as `next_cursor`). */
  readonly next_position?: string;
}

export interface SourcesGetResult {
  readonly mode: "get";
  readonly id: SourceId;
  readonly kind: string;
  readonly level: string;
  readonly slot: string;
  readonly recorded_at: string;
  readonly stated_at?: string;
  readonly actor: Actor;
  readonly correction?: true;
  readonly text?: string;
  readonly file?: FileOut & {
    readonly sha256: string;
    readonly origin?: string;
    readonly excerpt?: string;
  };
  readonly produced?: readonly {
    readonly target: { readonly table: string; readonly row?: string; readonly entity?: string };
    readonly seq: number;
    readonly fields: readonly string[];
    readonly role: "value" | "operation";
  }[];
}

export type SourcesResult = SourcesListResult | SourcesGetResult;

interface SourceRow {
  readonly seq: number;
  readonly op: number;
  readonly id: string;
  readonly kind: string;
  readonly level: string | null;
  readonly slot: string;
  readonly state: string;
  readonly at: string;
  readonly actor: string;
}

/** The content blocks of these sources, by seq: `text`, `file`, `request`, `stated_at`. */
async function contentOf(
  tx: ReadTx,
  seqs: readonly number[],
): Promise<Map<number, Map<string, string>>> {
  const out = new Map<number, Map<string, string>>();
  if (seqs.length === 0) return out;
  const r = await tx.query<{ seq: unknown; path: string; body: string | null }>(
    `SELECT seq, path, body FROM content
     WHERE seq = ANY($1) AND path IN ('text', 'file', 'request', 'stated_at')`,
    [[...seqs]] as never,
  );
  for (const x of r.rows) {
    if (x.body === null) continue;
    const s = Number(x.seq);
    const m = out.get(s) ?? new Map<string, string>();
    m.set(x.path, x.body);
    out.set(s, m);
  }
  return out;
}

/** What a source holds as its text: its text block, or an `api_call`'s request as JCS. */
function textOf(kind: string, blocks: Map<string, string> | undefined): string | undefined {
  if (blocks === undefined) return undefined;
  if (kind === "api_call") return blocks.get("request");
  const t = blocks.get("text");
  if (t === undefined) return undefined;
  const v = (JSON.parse(t) as { text?: unknown }).text;
  return typeof v === "string" ? v : undefined;
}

const fileOf = (blocks: Map<string, string> | undefined): Record<string, unknown> | undefined => {
  const f = blocks?.get("file");
  return f === undefined ? undefined : (JSON.parse(f) as Record<string, unknown>);
};

const statedOf = (blocks: Map<string, string> | undefined): string | undefined => {
  const s = blocks?.get("stated_at");
  if (s === undefined) return undefined;
  const at = (JSON.parse(s) as { at?: unknown }).at;
  return typeof at === "string" ? at : undefined;
};

/** For `search`: NFC, and A–Z as a–z only. */
export const searchForm = (s: string): string =>
  s.normalize("NFC").replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The first `EXCERPT` code points. */
const excerptOf = (s: string): string => Array.from(s).slice(0, EXCERPT).join("");

/** Which of these sources a write whose intent is `correct` took a value from. */
async function corrections(tx: ReadTx, seqs: readonly number[]): Promise<Set<number>> {
  const out = new Set<number>();
  if (seqs.length === 0) return out;
  const r = await tx.query<{ source_seq: unknown; body: string | null }>(
    `SELECT DISTINCT b.source_seq, c.body FROM base_sources b
     JOIN content c ON c.seq = b.event_seq AND c.path = 'target'
     WHERE b.source_kind = 'value' AND b.source_seq = ANY($1)`,
    [[...seqs]] as never,
  );
  for (const x of r.rows) {
    if (x.body !== null && isCorrection(JSON.parse(x.body))) out.add(Number(x.source_seq));
  }
  return out;
}

/** Whether `visibility` gives the caller every table of `slot`. */
function seesWhole(visibility: Visibility, slot: string): boolean {
  if (visibility.kind === "all") return true;
  return visibility.slots.some((x) => x.slot === slot && x.tables === undefined);
}

/** `sources`: list, search or get, as `actor` with `visibility`. */
export async function sourcesInTx(
  tx: ReadTx,
  input: {
    readonly actor: string;
    readonly task: string | null;
    readonly now: string;
    readonly visibility: Visibility;
    readonly params: unknown;
    readonly read: string;
    /** Tests: how many sources a search looks at (`SEARCH_SCAN` otherwise). */
    readonly scanLimit?: number;
  },
): Promise<{ readonly result: SourcesResult; readonly entry: ReadEntry }> {
  const scanLimit = input.scanLimit ?? SEARCH_SCAN;
  const params = input.params;
  if (!isObj(params)) throw invalid("malformed", "");
  const modeIn = has(params, "mode") ? get(params, "mode") : "list";
  if (modeIn !== "list" && modeIn !== "search" && modeIn !== "get") {
    throw invalid("malformed", "mode");
  }
  const mode: Mode = modeIn;
  for (const k of keysOf(params)) {
    if (KEYS[mode].has(k)) continue;
    throw invalid(ALL_KEYS.has(k) ? "mode_mismatch" : "malformed", k);
  }
  const slots = await visibleSlots(tx, input.visibility);
  // Only the slots the caller sees whole: a source belongs to a slot, and its text (an evidence
  // text, an `api_call`'s request) may name any table of it, so in this version a slot seen only
  // in part has no sources for the caller (08-open-questions).
  const whole = slots.filter((s) => seesWhole(input.visibility, s.slot));
  const bySlot = new Map<string, VisibleSlot>(whole.map((s) => [s.slot, s]));
  // A source not present in those slots fails the whole call, before anything else is looked at:
  // whatever the mode, filters or page (this version cannot say what such a source is).
  const absent = await tx.query<{ n: unknown }>(
    `SELECT 1 AS n FROM sources WHERE slot_id = ANY($1) AND deletion_state <> 'present' LIMIT 1`,
    [whole.map((s) => s.slot)] as never,
  );
  if (absent.rows.length > 0) {
    throw notImplemented("sources", "a source pending deletion or removed");
  }
  const latest = await logPosition(tx);
  const entryOf = (o: { pos: number; slot?: SlotId; source?: SourceId }): ReadEntry => ({
    read: input.read as never,
    actor: input.actor as never,
    task: input.task,
    at: input.now as never,
    pos: o.pos as never,
    operation: "sources",
    ...(o.slot !== undefined ? { slot: o.slot } : {}),
    ...(o.source !== undefined ? { source: o.source } : {}),
    // The mode and the opaque IDs; never the search text.
    shape: canonicalize({
      mode,
      ...(o.slot !== undefined ? { slot: o.slot as string } : {}),
      ...(o.source !== undefined ? { source: o.source as string } : {}),
    }),
    rows: [],
    coarse: [],
    lastRead: [],
  });

  if (mode === "get") return getOne(tx, params, bySlot, latest, entryOf);

  // --- list and search ---
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
  const slotName = text("slot");
  const slot =
    slotName === undefined
      ? undefined
      : slots.find((s) => s.slot === slotName || fold(s.name) === fold(slotName));
  if (slotName !== undefined && slot === undefined) {
    throw new ReadError("not_found", "no such slot", { reason: "slot", param: "slot" });
  }
  const kind = text("kind");
  if (kind !== undefined && !(SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw invalid("malformed", "kind", { allowed_values: [...SOURCE_KINDS] });
  }
  const from = instant("from");
  const to = instant("to");
  let needle: string | undefined;
  if (mode === "search") {
    if (!has(params, "q")) throw invalid("missing", "q");
    const q = get(params, "q");
    if (typeof q !== "string" || q === "" || q.normalize("NFC") === "") {
      throw invalid("malformed", "q");
    }
    needle = searchForm(q);
  }
  const limit = limitOf(params);
  const restore = await restoreCount(tx);
  const specs: KeySpec[] = [{ type: "count", dir: "desc" }];
  const identity = digest({
    op: "sources",
    mode,
    slot: slot?.slot ?? null,
    kind: kind ?? null,
    from: from ?? null,
    to: to ?? null,
    // The search text stays out of the position: only that it is the same text.
    q: needle === undefined ? null : digest(needle),
  });
  const position = positionOf(params, { identity, specs, restoreCount: restore, latest });
  const upTo = position?.seq ?? latest;
  const at = position?.at ?? input.now;
  const after = position?.keys[0] as number | undefined;
  // A slot seen only in part: named, it is there, and none of its sources are.
  const slotIds =
    slot !== undefined ? (bySlot.has(slot.slot) ? [slot.slot] : []) : whole.map((s) => s.slot);

  /** The sources after `before`, newest first, `n` of them, as the filters say. */
  const batch = async (before: number | undefined, n: number): Promise<SourceRow[]> => {
    const args: unknown[] = [slotIds, upTo];
    const where = ["s.slot_id = ANY($1)", "e.op <= $2"];
    if (before !== undefined) {
      args.push(before);
      where.push(`s.seq < $${args.length}`);
    }
    if (kind !== undefined) {
      args.push(kind);
      where.push(`s.kind = $${args.length}`);
    }
    if (from !== undefined) {
      args.push(from);
      where.push(`e.at >= $${args.length}`);
    }
    if (to !== undefined) {
      args.push(to);
      where.push(`e.at < $${args.length}`);
    }
    args.push(n);
    const r = await tx.query<Record<string, unknown>>(
      `SELECT s.seq, e.op, s.source_id, s.kind, s.level, s.slot_id, s.deletion_state, e.at, e.actor
       FROM sources s JOIN events e ON e.seq = s.seq
       WHERE ${where.join(" AND ")} ORDER BY s.seq DESC LIMIT $${args.length}`,
      args as never,
    );
    return r.rows.map((x) => ({
      seq: Number(x["seq"]),
      op: Number(x["op"]),
      id: String(x["source_id"]),
      kind: String(x["kind"]),
      level: (x["level"] as string | null) ?? null,
      slot: String(x["slot_id"]),
      state: String(x["deletion_state"]),
      at: String(x["at"]),
      actor: String(x["actor"]),
    }));
  };

  // One more than the page, to know whether another follows; a search, in batches, up to its scan.
  const taken: { row: SourceRow; blocks: Map<string, string> | undefined }[] = [];
  let scannedTo: number | undefined = after;
  let more = false;
  if (needle === undefined) {
    const rows = await batch(after, limit + 1);
    const blocks = await contentOf(
      tx,
      rows.map((x) => x.seq),
    );
    for (const row of rows) taken.push({ row, blocks: blocks.get(row.seq) });
    more = taken.length > limit;
    taken.splice(limit);
  } else {
    let scanned = 0;
    for (;;) {
      const rows = await batch(scannedTo, Math.min(BATCH, scanLimit - scanned));
      if (rows.length === 0) break;
      const blocks = await contentOf(
        tx,
        rows.map((x) => x.seq),
      );
      let full = false;
      for (const row of rows) {
        const b = blocks.get(row.seq);
        const f = fileOf(b);
        const haystacks = [
          textOf(row.kind, b),
          typeof f?.["name"] === "string" ? f["name"] : undefined,
          typeof f?.["excerpt"] === "string" ? f["excerpt"] : undefined,
        ];
        if (haystacks.some((h) => h !== undefined && searchForm(h).includes(needle as string))) {
          if (taken.length === limit) {
            // One more match: the page is full, and the next one starts after the last given.
            more = true;
            full = true;
            break;
          }
          taken.push({ row, blocks: b });
        }
        scannedTo = row.seq;
        scanned += 1;
      }
      if (full) break;
      if (scanned >= scanLimit) {
        // The scan ends here: whether more match is not known, so a next page is given from it.
        more = (await batch(scannedTo, 1)).length > 0;
        break;
      }
      if (rows.length < BATCH) break;
    }
  }

  const fixes = await corrections(
    tx,
    taken.map((x) => x.row.seq),
  );
  const who = await actorsNow(
    tx,
    taken.map((x) => x.row.actor),
  );
  const sources: SourcesListItem[] = taken.map(({ row, blocks }) => {
    const t = textOf(row.kind, blocks);
    const f = fileOf(blocks);
    const stated = statedOf(blocks);
    return {
      id: row.id as SourceId,
      kind: row.kind,
      slot: bySlot.get(row.slot)?.name ?? "",
      recorded_at: row.at,
      ...(stated !== undefined ? { stated_at: stated } : {}),
      actor: who.get(row.actor) as Actor,
      ...(fixes.has(row.seq) ? { correction: true as const } : {}),
      ...(t !== undefined ? { excerpt: excerptOf(t) } : {}),
      ...(f !== undefined
        ? { file: { name: String(f["name"]), mime: String(f["mime"]), size: Number(f["size"]) } }
        : {}),
    };
  });
  // The next page starts after the last given; a search cut by its scan, after the last looked at.
  const lastKey = needle !== undefined && taken.length < limit ? scannedTo : taken.at(-1)?.row.seq;
  const next =
    more && lastKey !== undefined
      ? encodePosition(identity, { seq: upTo, at, restoreCount: restore, keys: [lastKey] })
      : undefined;
  return {
    result: { mode, sources, ...(next !== undefined ? { next_position: next } : {}) },
    entry: entryOf({ pos: upTo, ...(slot !== undefined ? { slot: slot.slot } : {}) }),
  };
}

/** `get`: one source, visible, present; what it produced in the tables the caller sees. */
async function getOne(
  tx: ReadTx,
  params: Obj,
  bySlot: ReadonlyMap<string, VisibleSlot>,
  latest: number,
  entryOf: (o: { pos: number; slot?: SlotId; source?: SourceId }) => ReadEntry,
): Promise<{ readonly result: SourcesGetResult; readonly entry: ReadEntry }> {
  if (!has(params, "id")) throw invalid("missing", "id");
  const id = get(params, "id");
  if (typeof id !== "string" || id === "") throw invalid("malformed", "id");
  // Not there, or in a slot the caller cannot see: the same error, the same bytes.
  const notFound = () =>
    new ReadError("not_found", "no such source", { reason: "source", param: "id" });
  const r = await tx.query<Record<string, unknown>>(
    `SELECT s.seq, e.op, s.source_id, s.kind, s.level, s.slot_id, s.deletion_state, e.at, e.actor
     FROM sources s JOIN events e ON e.seq = s.seq WHERE s.source_id = $1`,
    [id] as never,
  );
  const x = r.rows[0];
  if (x === undefined) throw notFound();
  const row: SourceRow = {
    seq: Number(x["seq"]),
    op: Number(x["op"]),
    id: String(x["source_id"]),
    kind: String(x["kind"]),
    level: (x["level"] as string | null) ?? null,
    slot: String(x["slot_id"]),
    state: String(x["deletion_state"]),
    at: String(x["at"]),
    actor: String(x["actor"]),
  };
  const slot = bySlot.get(row.slot);
  if (slot === undefined) throw notFound();
  const blocks = (await contentOf(tx, [row.seq])).get(row.seq);
  const t = textOf(row.kind, blocks);
  const f = fileOf(blocks);
  const stated = statedOf(blocks);
  const fixes = await corrections(tx, [row.seq]);
  const who = await actorsNow(tx, [row.actor]);

  // What it produced: by operation, target and role, its fields; in the tables the caller sees.
  const tables = new Map(slot.tables.map((tb) => [tb.id as string, tb]));
  const p = await tx.query<Record<string, unknown>>(
    `SELECT e.op, e.target_table, b.row_id, b.field_id, b.source_kind
     FROM base_sources b JOIN events e ON e.seq = b.event_seq
     WHERE b.source_seq = $1 AND b.source_kind IN ('value', 'operation')
     ORDER BY e.op, b.row_id, b.field_id`,
    [row.seq] as never,
  );
  const groups = new Map<
    string,
    {
      target: { table: string; row?: string; entity?: string };
      seq: number;
      fields: string[];
      role: "value" | "operation";
    }
  >();
  for (const y of p.rows) {
    const table = tables.get(String(y["target_table"]));
    if (table === undefined) continue;
    const target = String(y["row_id"]);
    const role = y["source_kind"] === "value" ? "value" : "operation";
    const op = Number(y["op"]);
    const key = JSON.stringify([op, table.id, target, role]);
    const g = groups.get(key) ?? {
      target: {
        table: `${slot.name}.${table.name}`,
        ...(target.startsWith("e_") ? { entity: target } : { row: target }),
      },
      seq: op,
      fields: [],
      role,
    };
    const field = table.fields.find((fd) => (fd.id as string) === y["field_id"]);
    if (field !== undefined && !g.fields.includes(field.name)) g.fields.push(field.name);
    groups.set(key, g);
  }
  const result: SourcesGetResult = {
    mode: "get",
    id: row.id as SourceId,
    kind: row.kind,
    level: row.level ?? "",
    slot: slot.name,
    recorded_at: row.at,
    ...(stated !== undefined ? { stated_at: stated } : {}),
    actor: who.get(row.actor) as Actor,
    ...(fixes.has(row.seq) ? { correction: true as const } : {}),
    ...(t !== undefined ? { text: t } : {}),
    ...(f !== undefined
      ? {
          file: {
            name: String(f["name"]),
            mime: String(f["mime"]),
            size: Number(f["size"]),
            sha256: String(f["sha256"] ?? ""),
            ...(typeof f["origin"] === "string" ? { origin: f["origin"] } : {}),
            ...(typeof f["excerpt"] === "string" ? { excerpt: f["excerpt"] } : {}),
          },
        }
      : {}),
    ...(groups.size > 0 ? { produced: [...groups.values()] } : {}),
  };
  return { result, entry: entryOf({ pos: latest, slot: slot.slot, source: row.id as SourceId }) };
}
