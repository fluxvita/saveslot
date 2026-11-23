// Flagged items as later writes change their rows (03-data-model/01-objects «不过期», the `flagged`
// exception; 04-write-and-read «疑似重复»; 09 §5.8 `matched_changed`): superseded when the flagged
// row is revoked or no listed row matches it any more, refreshed (the rows still matching given
// whole, in the order listed) when some no longer match, refreshed with new deps when the rows
// still match on other contributions, left alone when nothing the item says changed; matching on
// any key group; `by_event` the last op that changed it. A flagged item the same request opens has
// its entries as the request ends, and is not opened when none is left by then. Each case ends with
// the log replayed into an empty storage. Fictional names.

import {
  createOpsContext,
  createTenant,
  pending,
  query,
  readTail,
  reconcileLog,
  resolve,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"3".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

/** Notes: the same text is likely written twice. */
const NOTES = {
  name: "notes",
  kind: "base",
  description: "one row per note",
  time: { type: "none" },
  fields: [
    { name: "text", type: "text", description: "the note" },
    { name: "tag", type: "text", description: "a tag" },
  ],
  duplicate_keys: [["text"]],
};

/** Meals: two key groups, (day, energy) and the note. */
const MEALS = {
  name: "meals",
  kind: "base",
  description: "one row per meal",
  time: { type: "event", field: "day" },
  fields: [
    { name: "day", type: "date", required: true, description: "the day" },
    { name: "energy", type: "quantity", unit: "kcal", description: "energy" },
    { name: "note", type: "text", description: "what it was" },
    { name: "tag", type: "text", description: "a tag" },
  ],
  duplicate_keys: [["day", "energy"], ["note"]],
};

let s: ReusableStore;
let scratch: ReusableStore;
let minute = 0;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: "w",
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T08:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type Any = any;
const rows = async (q: string, params: unknown[] = []) =>
  (await s.store.read((tx) => tx.query(q, params as never))).rows as Record<string, unknown>[];
const tail = async () => s.store.read(async (tx) => (await readTail(tx))?.seq ?? 0);
const w = (ops: unknown[], extra: Record<string, unknown> = {}): Promise<Any> =>
  write(s.store, ctx(), { sv: 1, ...extra, ops });
const note = (set: Record<string, unknown>) => ({ intent: "insert", table: "notes", set });
const update = (row: string, set: Record<string, unknown>) => ({
  intent: "update",
  table: "notes",
  row,
  set,
});
const revoke = (row: string) => ({ intent: "revoke", table: "notes", row });
/** The item events logged since `after`, as `[type, item, cause or reason, matched rows]`. */
async function itemEvents(after: number) {
  const ev = await rows(
    `SELECT e.seq, e.type, t.body AS target FROM events e JOIN content t ON t.seq = e.seq AND t.path = 'target'
     WHERE e.type IN ('item.created', 'item.refreshed', 'item.superseded') AND e.seq > $1 ORDER BY e.seq`,
    [after],
  );
  const matched = await rows(
    `SELECT e.seq, c.path, c.body FROM events e JOIN content c ON c.seq = e.seq AND c.path LIKE 'matched/%'
     WHERE e.seq > $1 ORDER BY e.seq, c.path`,
    [after],
  );
  return ev.map((x) => {
    const t = JSON.parse(x["target"] as string);
    return [
      x["type"],
      t.item,
      t.cause ?? t.reason,
      matched.filter((m) => m["seq"] === x["seq"]).map((m) => JSON.parse(m["body"] as string).row),
    ];
  });
}
/** The item events logged since `after`, as `[item, by_event]`. */
const byEvents = async (after: number) =>
  (
    await rows(
      `SELECT t.body AS target FROM events e JOIN content t ON t.seq = e.seq AND t.path = 'target'
       WHERE e.type IN ('item.refreshed', 'item.superseded') AND e.seq > $1 ORDER BY e.seq`,
      [after],
    )
  ).map((x) => {
    const t = JSON.parse(x["target"] as string);
    return [t.item, t.by_event];
  });
/** The write.base events of an operation, in order. */
const basesOf = async (op: number) =>
  (
    await rows("SELECT seq FROM events WHERE type = 'write.base' AND op = $1 ORDER BY seq", [op])
  ).map((x) => Number(x["seq"]));
/** An item's matched entries now: `{row, deps}`, in order. */
const matchedNow = async (item: string) =>
  (
    await rows(
      `SELECT c.body FROM pending_entries e JOIN content c ON c.seq = e.content_seq AND c.path = e.content_path
       WHERE e.item_id = $1 AND e.content_path LIKE 'matched/%' ORDER BY e.content_path`,
      [item],
    )
  ).map((x) => JSON.parse(x["body"] as string));
const flaggedOn = async (row: string) =>
  (
    await rows(
      "SELECT id FROM pending_items WHERE type = 'flagged' AND state = 'open' AND target_row = $1",
      [row],
    )
  )[0]?.["id"] as string | undefined;
/** The open flagged items, by row. */
const openFlagged = async () =>
  (
    await rows(
      "SELECT target_row FROM pending_items WHERE type = 'flagged' AND state = 'open' ORDER BY target_row",
    )
  ).map((x) => x["target_row"]);
const replaysTheSame = async () => {
  const r = await reconcileLog({ live: s.store, scratch: scratch.store });
  expect(r.mismatches).toEqual([]);
  expect(r.mismatches_total).toBe(0);
};
/** a and b alike; f written after them, flagged with both (b the later). */
async function flaggedWithTwo() {
  // b is flagged too, with a.
  // Two requests alike would be one (the second a replay): their tags tell them apart.
  const a = (await w([note({ text: "milk", tag: "a" })])).ops[0].target.row as string;
  const b = (await w([note({ text: "milk", tag: "b" })])).ops[0].target.row as string;
  const rb = await rows(
    "SELECT id FROM pending_items WHERE type = 'flagged' AND state = 'open' AND target_row = $1",
    [b],
  );
  const r = await w([note({ text: "milk", tag: "x" })]);
  const f = r.ops[0].target.row as string;
  const items = r.pending.filter((p: Any) => p.type === "flagged");
  return { a, b, f, item: items[0] as Any, bItem: rb[0]?.["id"] as string };
}

beforeAll(async () => {
  s = await openReusable("saveslot-duplicates-later-");
  scratch = await openReusable("saveslot-duplicates-later-scratch-");
}, T);
afterAll(async () => {
  await s?.close();
  await scratch?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  await scratch.reset();
  minute = 0;
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), {
    document: { slot: "home", base_version: null, timezone: "UTC", tables: [NOTES, MEALS] },
  });
}, T);

describe("superseded", () => {
  it(
    "the flagged row revoked: the item goes, its flag too",
    async () => {
      const { f, item } = await flaggedWithTwo();
      const before = await tail();
      expect(await w([revoke(f)])).toMatchObject({ status: "saved" });
      expect(await itemEvents(before)).toEqual([
        ["item.superseded", item.id, "matched_changed", []],
      ]);
      expect(await openFlagged()).not.toContain(f);
      await replaysTheSame();
    },
    T,
  );

  it(
    "every listed row no longer matching (one revoked, one changed): superseded",
    async () => {
      const { a, b, f, item } = await flaggedWithTwo();
      const before = await tail();
      await w([revoke(a), update(b, { text: "oat milk" })]);
      expect(await itemEvents(before)).toContainEqual([
        "item.superseded",
        item.id,
        "matched_changed",
        [],
      ]);
      expect(await openFlagged()).not.toContain(f);
      await replaysTheSame();
    },
    T,
  );

  it(
    "the flagged row's key changed so nothing matches: superseded",
    async () => {
      const { f, item } = await flaggedWithTwo();
      const before = await tail();
      await w([update(f, { text: "tea" })]);
      expect(await itemEvents(before)).toEqual([
        ["item.superseded", item.id, "matched_changed", []],
      ]);
      await replaysTheSame();
    },
    T,
  );
});

describe("refreshed", () => {
  it(
    "one listed row no longer matching: the rows still matching given whole, the detail follows",
    async () => {
      const { a, b, f, item, bItem } = await flaggedWithTwo();
      const before = await tail();
      await w([revoke(b)]);
      // f's item keeps a; b's own item (b flagged with a) goes with b.
      const ev = await itemEvents(before);
      expect(ev).toHaveLength(2);
      expect(ev).toContainEqual(["item.refreshed", item.id, "matched_changed", [a]]);
      expect(ev).toContainEqual(["item.superseded", bItem, "matched_changed", []]);
      const d = (await pending(s.store, ctx(), { id: item.id })) as Any;
      expect(d.related.map((x: Any) => x.row)).toEqual([a]);
      // The item's entries in the store: the refresh's matched row only, the earlier ones gone.
      const refreshed = (
        await rows("SELECT seq FROM events WHERE type = 'item.refreshed' AND seq > $1", [before])
      )[0]?.["seq"];
      expect(
        await rows(
          `SELECT content_seq AS seq, content_path AS path FROM pending_entries
           WHERE item_id = $1 AND content_path LIKE 'matched/%'`,
          [item.id],
        ),
      ).toEqual([{ seq: refreshed, path: "matched/0" }]);
      expect(d.item_ver).not.toBe(item.item_ver);
      expect(await openFlagged()).toContain(f);
      await replaysTheSame();
    },
    T,
  );
});

describe("left alone", () => {
  it(
    "a field outside the key group changed, on the flagged row or a listed one: no item event",
    async () => {
      const { a, f, item } = await flaggedWithTwo();
      const before = await tail();
      expect(await w([update(f, { tag: "y" }), update(a, { tag: "z" })])).toMatchObject({
        status: "saved",
      });
      expect(await itemEvents(before)).toEqual([]);
      const d = (await pending(s.store, ctx(), { id: item.id })) as Any;
      expect(d.item_ver).toBe(item.item_ver);
      await replaysTheSame();
    },
    T,
  );

  it(
    "a key field written again with the same value (a corroboration): no item event",
    async () => {
      const { a } = await flaggedWithTwo();
      const before = await tail();
      const r = await w([{ ...update(a, { text: "milk" }), evidence_by_field: { text: [0] } }], {
        evidence: [{ kind: "user_message", text: "it was milk" }],
      });
      expect(r.ops[0].fields.text.result).toBe("corroborated");
      expect(await itemEvents(before)).toEqual([]);
      await replaysTheSame();
    },
    T,
  );
});

describe("a flagged item opened by the same request: its entries as the request ends", () => {
  it(
    "a listed row changed by a later op of the request is not listed; none left, not opened",
    async () => {
      const a = (await w([note({ text: "jam", tag: "a" })])).ops[0].target.row as string;
      const b = (await w([note({ text: "jam", tag: "b" })])).ops[0].target.row as string;
      let before = await tail();
      const r1 = await w([note({ text: "jam", tag: "n1" }), update(a, { text: "honey" })]);
      const n1 = r1.ops[0].target.row as string;
      const ev1 = await itemEvents(before);
      const n1Item = ev1.find((x) => x[0] === "item.created")?.[1];
      expect(ev1.filter((x) => x[0] === "item.created")).toEqual([
        ["item.created", n1Item, "duplicate_keys", [b]],
      ]);
      // b changed later in the request too: n2 is left with nothing, so its item is not opened;
      // n1's item goes (n1 and b both changed).
      before = await tail();
      const r2 = await w([
        note({ text: "jam", tag: "n2" }),
        update(b, { text: "butter" }),
        update(n1, { text: "tea" }),
      ]);
      const n2 = r2.ops[0].target.row as string;
      const ev = await itemEvents(before);
      expect(ev).toEqual([["item.superseded", n1Item, "matched_changed", []]]);
      expect(r2.pending.filter((p: Any) => p.type === "flagged")).toEqual([]);
      expect(await flaggedOn(n2)).toBeUndefined();
      // The write's own judgement stays: it matched n1 and b when written (latest first).
      const dup = await rows("SELECT body FROM content WHERE seq = $1 AND path = 'duplicate'", [
        (await basesOf(r2.seq))[0],
      ]);
      expect(JSON.parse(dup[0]?.["body"] as string).matched).toEqual([n1, b]);
      await replaysTheSame();
    },
    T,
  );

  it(
    "a row inserted matching a, a changed in the same request: no item opened, none superseded",
    async () => {
      const a = (await w([note({ text: "milk", tag: "a" })])).ops[0].target.row as string;
      const before = await tail();
      const r = await w([note({ text: "milk", tag: "n" }), update(a, { text: "tea" })]);
      expect(await itemEvents(before)).toEqual([]);
      expect(r.pending).toEqual([]);
      expect(r.superseded ?? []).toEqual([]);
      await replaysTheSame();
    },
    T,
  );
});

/** a, b, f all "milk": b flagged with [a], f flagged with [b, a]. */
async function three() {
  const a = (await w([note({ text: "milk", tag: "a" })])).ops[0].target.row as string;
  const b = (await w([note({ text: "milk", tag: "b" })])).ops[0].target.row as string;
  const f = (await w([note({ text: "milk", tag: "f" })])).ops[0].target.row as string;
  return { a, b, f, bItem: (await flaggedOn(b)) as string, fItem: (await flaggedOn(f)) as string };
}

describe("what a later write changes, op by op and group by group", () => {
  it(
    "by_event: the op that changed what the item says, not a later op writing another field",
    async () => {
      const { a, b, bItem, fItem } = await three();
      const before = await tail();
      // Op 0: b's key changes (b no longer matches f or a); op 1: a's tag only.
      const r = await w([update(b, { text: "tea" }), update(a, { tag: "a2" })]);
      const bases = await basesOf(r.seq);
      expect((await byEvents(before)).sort()).toEqual(
        [
          [bItem, bases[0]],
          [fItem, bases[0]],
        ].sort(),
      );
      await replaysTheSame();
    },
    T,
  );

  it(
    "both rows changed to the same new key: still matching on new contributions, entries given again",
    async () => {
      const { a, b, bItem, fItem } = await three();
      const before = await tail();
      const r = await w([update(a, { text: "tea" }), update(b, { text: "tea" })]);
      const bases = await basesOf(r.seq);
      const ev = await itemEvents(before);
      expect(ev).toContainEqual(["item.superseded", fItem, "matched_changed", []]);
      // b and a alike again, on what this request wrote: the entry rests on a's new item.
      expect(ev).toContainEqual(["item.refreshed", bItem, "entries_changed", [a]]);
      expect(await matchedNow(bItem)).toEqual([
        { row: a, deps: [{ event: bases[0], field: "f1", k: 0 }] },
      ]);
      // The last op changing either item: b's.
      expect((await byEvents(before)).map((x) => x[1])).toEqual([bases[1], bases[1]]);
      await replaysTheSame();
    },
    T,
  );

  it(
    "a refresh keeps the rows in the order they were listed",
    async () => {
      const a = (await w([note({ text: "milk", tag: "a" })])).ops[0].target.row as string;
      const b = (await w([note({ text: "milk", tag: "b" })])).ops[0].target.row as string;
      const c = (await w([note({ text: "milk", tag: "c" })])).ops[0].target.row as string;
      const f = (await w([note({ text: "milk", tag: "f" })])).ops[0].target.row as string;
      const fItem = (await flaggedOn(f)) as string;
      expect((await matchedNow(fItem)).map((x) => x.row)).toEqual([c, b, a]);
      // a is now the latest written of a and b; the list keeps its order.
      await w([update(a, { tag: "a2" })]);
      const before = await tail();
      await w([update(c, { text: "tea" })]);
      expect((await itemEvents(before)).filter((x) => x[1] === fItem)).toEqual([
        ["item.refreshed", fItem, "matched_changed", [b, a]],
      ]);
      await replaysTheSame();
    },
    T,
  );

  it(
    "matching on any group: the group flagged on no longer matches, another does: left alone",
    async () => {
      const meal = (set: Record<string, unknown>) => ({ intent: "insert", table: "meals", set });
      const E = { value: 600, unit: "kcal" };
      const c = (await w([meal({ day: "2026-11-05", energy: E, note: "soup", tag: "c" })])).ops[0]
        .target.row as string;
      const r = await w([meal({ day: "2026-11-05", energy: E, note: "soup", tag: "d" })]);
      const d = r.ops[0].target.row as string;
      const dItem = (await flaggedOn(d)) as string;
      const dup = await rows("SELECT body FROM content WHERE seq = $1 AND path = 'duplicate'", [
        (await basesOf(r.seq))[0],
      ]);
      // Flagged on (day, energy), the first group.
      expect(JSON.parse(dup[0]?.["body"] as string).keys).toHaveLength(2);
      let before = await tail();
      await w([{ intent: "update", table: "meals", row: c, set: { day: "2026-11-06" } }]);
      // c and d still share the note: the item stays, and says the same rows; its entry now rests
      // on the note.
      const ev = await itemEvents(before);
      expect(ev).toEqual([["item.refreshed", dItem, "entries_changed", [c]]]);
      expect(await flaggedOn(d)).toBe(dItem);
      // Then the note too: no group matches.
      before = await tail();
      await w([{ intent: "update", table: "meals", row: c, set: { note: "stew" } }]);
      expect(await itemEvents(before)).toEqual([["item.superseded", dItem, "matched_changed", []]]);
      await replaysTheSame();
    },
    T,
  );
});

describe("a flagged row is written again, and decisions reach other items", () => {
  it(
    "a flagged item's revoke reaches another flagged item listing the row it revokes",
    async () => {
      const { a, b, f, item } = await flaggedWithTwo();
      // g flagged with f, b, a (latest first).
      const rg = await w([note({ text: "milk", tag: "g" })]);
      const gItem = rg.pending.find((p: Any) => p.type === "flagged") as Any;
      const before = await tail();
      expect(
        await resolve(s.store, ctx(), { id: item.id, decision: "revoke", item_ver: item.item_ver }),
      ).toMatchObject({ status: "resolved" });
      expect(await itemEvents(before)).toEqual([
        ["item.refreshed", gItem.id, "matched_changed", [b, a]],
      ]);
      const read = await query(s.store, ctx(), { table: "notes" });
      expect(read.rows.map((x: Any) => x.row)).not.toContain(f);
      await replaysTheSame();
    },
    T,
  );
});
