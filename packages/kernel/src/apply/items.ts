// apply of the pending item events (docs/zh-CN/spec/09-event-format.md §5.8): `pending_items`, the
// positions of their entry blocks (`pending_entries`) and the data flags open items give
// (`flags`: `disputed`, `awaiting`, `flagged`; 02-architecture §8).
//
// Entry blocks are registered by position, removed ones too (a removed data block still stands
// where it was, §1.1). `item.merged` and `item.refreshed` give some groups whole: the item's
// earlier entries of those groups stop counting, and the flag's spans follow the new `scope_valid`
// (none given: an empty group, no spans; the whole time: no spans either).

import { canonicalize, type JsonValue, type Seq } from "@fluxvita/saveslot-contract-core";
import { ApplyError, type Change, type EntryRef } from "./model.ts";

type Obj = Readonly<Record<string, JsonValue>>;

/** The flag an open item of each type sets. */
const FLAG_OF: Readonly<Record<string, string>> = {
  conflict: "disputed",
  awaiting_confirmation: "awaiting",
  flagged: "flagged",
};

/** The groups `item.merged` / `item.refreshed` give whole (§5.8). */
const WHOLE_GROUPS: Readonly<Record<string, readonly string[]>> = {
  "item.merged": ["scope_valid", "previous", "impact"],
  "item.refreshed": ["scope_valid", "current", "previous", "impact", "proposed"],
};

/** The item an update is for, read by the caller. */
export interface ItemInput {
  readonly state: string;
  /** The next entry number of the item (`pending_entries.n`). */
  readonly nextEntry: number;
  /**
   * `item.resolved`: the confirmation hash of the item's entry blocks in effect (`confirmation.ts`);
   * undefined: it has none; `"removed"`: one of them was removed by a tombstone.
   */
  readonly confirmation?: string;
}

const isEntry = (path: string) => path !== "target";

/** Entry blocks of the event, in path order, numbered from `from`. */
function entries(item: string, seq: Seq, paths: readonly string[], from: number): EntryRef[] {
  return paths
    .filter(isEntry)
    .sort()
    .map((path, i) => ({ item, n: from + i, seq, path }));
}

/** The flag's spans: those of `scope_valid`, as JCS; the whole time (`[{}]`) is none. */
function spans(v: JsonValue | undefined): string | null {
  if (v === undefined || v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const s = (v as Obj)["spans"];
  const whole = Array.isArray(s) && s.length === 1 && canonicalize(s[0] ?? null) === "{}";
  return Array.isArray(s) && !whole ? canonicalize(s) : null;
}

export function planItem(
  type: string,
  seq: Seq,
  op: Seq,
  slot: string | undefined,
  present: Obj,
  paths: readonly string[],
  input: { readonly item?: ItemInput },
): Change[] | undefined {
  const t = present["target"] as Obj | undefined;
  // An update is for an open item (§5.8).
  if (type !== "item.created" && type.startsWith("item.")) {
    const id = (t as Obj)["item"] as string;
    if (input.item === undefined || input.item.state !== "open") {
      throw new ApplyError("inconsistent", seq, `no open item ${id}`);
    }
  }
  switch (type) {
    // §5.8 item.created: a new open item, its entries, the flag of its type.
    case "item.created": {
      const target = t as Obj;
      const id = target["item"] as string;
      const row = (target["row"] ?? target["entity"] ?? null) as string | null;
      const table = (target["table"] ?? null) as string | null;
      const out: Change[] = [
        {
          kind: "item_insert",
          row: {
            id,
            type: target["type"] as string,
            slot_id: slot ?? null,
            target_table: table,
            target_row: row,
            state: "open",
            version_op: op,
          },
        },
        { kind: "entries_insert", entries: entries(id, seq, paths, 0) },
      ];
      const flag = FLAG_OF[target["type"] as string];
      if (flag !== undefined && table !== null && row !== null) {
        const unit = target["unit"];
        out.push({
          kind: "flag_insert",
          row: {
            table_id: table,
            row_id: row,
            flag,
            item_id: id,
            fields: unit === undefined ? null : canonicalize(unit),
            spans: spans(present["scope_valid"]),
          },
        });
      }
      return out;
    }
    // §5.8 item.merged / item.refreshed: the item's version is this operation; whole groups
    // replace the earlier entries of the same name, candidates by index; a flagged item's matched
    // rows, when given, whole (not given, they stay).
    case "item.merged":
    case "item.refreshed": {
      const id = (t as Obj)["item"] as string;
      // An item.merged giving `current` gives it whole too; one without keeps the earlier.
      const current = type === "item.merged" && paths.some((p) => p.startsWith("current/"));
      const matched = paths.some((p) => p.startsWith("matched/"));
      const groups = [
        ...(WHOLE_GROUPS[type] as readonly string[]),
        ...(current ? ["current"] : []),
        ...(matched ? ["matched"] : []),
      ];
      const byIndex = paths.filter((p) => /^candidates\/\d+$/.test(p));
      return [
        { kind: "item_update", id, version_op: op },
        { kind: "entries_drop", item: id, groups, paths: type === "item.refreshed" ? byIndex : [] },
        { kind: "entries_insert", entries: entries(id, seq, paths, input.item?.nextEntry ?? 0) },
        { kind: "flag_valid", item: id, spans: spans(present["scope_valid"]) },
      ];
    }
    // §5.8 item.superseded: no longer to handle; its flags go.
    case "item.superseded": {
      const id = (t as Obj)["item"] as string;
      return [
        { kind: "item_update", id, state: "superseded", version_op: op },
        { kind: "flags_drop", item: id },
      ];
    }
    // §5.8 item.resolved: resolved with its decision; its flags go. The write it triggers is
    // applied by the `write.base` after it.
    case "item.resolved": {
      const target = t as Obj;
      const id = target["item"] as string;
      // The hash the decision confirmed, computed when the event was appended, is that of the item's
      // entries as applied (§5.8 «追加时算、落账时核对»). Removed with an entry it covered, it is not
      // checked.
      const given = present["confirmation"] as Obj | undefined;
      const now = input.item?.confirmation;
      const removed = given === undefined && paths.includes("confirmation");
      if (!removed && now !== "removed" && (given?.["hash"] as string | undefined) !== now) {
        throw new ApplyError(
          "inconsistent",
          seq,
          `the confirmation of ${id} does not match its entries`,
        );
      }
      return [
        { kind: "item_update", id, state: "resolved", decision: target["decision"] as string },
        { kind: "flags_drop", item: id },
      ];
    }
    default:
      return undefined;
  }
}
