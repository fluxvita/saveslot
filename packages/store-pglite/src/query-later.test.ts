// `query`'s later pages pushed down (kernel read/query.ts `queryRowsLater`; 04-contract §10 `query`,
// §15; process/decisions/table-indexes-format-6.md, "第 2 页起怎么下推"): the cases query-pages.prop
// must not leave to chance. Writes fall between the pages; each page is held to the whole read
// (`full`), result and read recorded, and the path taken is shown by the statements sent: the
// business table read with LIMIT and without the rows changed since the first page, or, where a
// later page cannot be pushed down, the version table read whole.
//
// A deletion between pages cannot be made through the operations in 0.1.0 (no privacy deletion):
// its events are appended here as stand-ins, only for the checks they meet: one confirmed or
// cancelled expires the position (positions-expire.test holds that for every read with one); one
// carried out sends a later page to the whole read.

import {
  createOpsContext,
  createTenant,
  type ReadTx,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { queryInTx } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const NOW = "2026-11-15T04:00:00.000Z";

const SPEND = {
  name: "spend",
  kind: "base",
  description: "events by day",
  time: { type: "event", field: "date" },
  fields: [
    { name: "date", type: "date", required: true, description: "day" },
    { name: "note", type: "text", description: "free text" },
    { name: "pieces", type: "integer", description: "how many" },
  ],
};
const BUDGETS = {
  name: "budgets",
  kind: "base",
  description: "by the day",
  time: { type: "state", granularity: "date" },
  fields: [
    { name: "category", type: "text", required: true, description: "kind" },
    { name: "amount", type: "integer", description: "how much" },
  ],
};

let s: ReusableStore;
let minute = 0;
let key = 0;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-15T03:${String(minute++ % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type Any = any;
/** A write of the user's, each with a key of its own (two equal bodies would be one write). */
const w = (ops: unknown[], sv = 1): Promise<Any> =>
  write(s.store, ctx(), { sv, idempotency_key: `k-${++key}`, ops });

/** `spend`'s rows by ID, in the order inserted; `budgets`' entities by category. */
let rows: string[];
let entity: Record<string, string>;

beforeAll(async () => {
  s = await openReusable("saveslot-query-later-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  await createTenant(s.store, ctx());
  const d = (await schemaDraft(s.store, ctx(), {
    document: {
      slot: "ledger",
      base_version: null,
      timezone: "Asia/Shanghai",
      tables: [SPEND, BUDGETS],
    },
  })) as Any;
  expect(d.outcome).toBe("applied");
  rows = [];
  for (let day = 1; day <= 8; day++)
    rows.push(
      (
        await w([
          {
            intent: "insert",
            table: "spend",
            set: { date: `2026-11-0${day}`, note: `n${day}`, pieces: day },
          },
        ])
      ).ops[0].target.row,
    );
  entity = {};
  for (const category of ["food", "fun", "rent", "trip"])
    entity[category] = (
      await w([
        {
          intent: "insert",
          table: "budgets",
          set: { category, amount: 10 },
          valid_from: "2026-11-01",
        },
      ])
    ).ops[0].target.entity;
  // Each entity in two rows over an interval: a new value from the 5th.
  for (const category of ["food", "fun", "rent", "trip"])
    await w([
      {
        intent: "update",
        table: "budgets",
        entity: entity[category],
        set: { amount: 20 },
        valid_from: "2026-11-05",
      },
    ]);
}, T);

/** A read transaction that keeps the statements sent through it. */
function recording(tx: ReadTx, sent: string[]): ReadTx {
  return {
    query: (sql, params) => {
      sent.push(sql);
      return tx.query(sql, params);
    },
  };
}

type Out = Awaited<ReturnType<typeof queryInTx>>;

/** One page both ways: pushed down (with the statements it sent) and as the whole read. */
async function both(params: Record<string, unknown>) {
  const sent: string[] = [];
  const input = (full: boolean) => ({
    actor: USER as never,
    task: null,
    now: NOW as never,
    visibility: { kind: "all" } as const,
    params,
    read: "rd_0000000000000000" as never,
    ...(full ? { full: true as const } : {}),
  });
  const pushed = await s.store.read((tx) => queryInTx(recording(tx, sent), input(false)));
  const full = await s.store.read((tx) => queryInTx(tx, input(true)));
  return { pushed, full, sent };
}

/** How a later page was read: pushed down (the business table with LIMIT) or whole. */
function path(sent: readonly string[]): "pushed" | "whole" {
  const whole = sent.some(
    (x) => /FROM "t_[^"]*__ver"/.test(x) && x.includes("rec_from <= $1") && !x.includes("ANY("),
  );
  const pushed = sent.some(
    (x) => /FROM "t_[^"]*"/.test(x) && !x.includes("__ver") && x.includes(" LIMIT "),
  );
  if (whole === pushed) throw new Error(`no single path: ${JSON.stringify(sent)}`);
  return whole ? "whole" : "pushed";
}

/**
 * Every page of a query, `between(i)` run after page i, each page equal both ways; the later
 * pages' paths.
 */
async function pages(
  params: Record<string, unknown>,
  between: (i: number) => Promise<unknown> = async () => undefined,
  edit: (position: string) => string = (p) => p,
) {
  const out: Out[] = [];
  const paths: string[] = [];
  let position: string | undefined;
  for (let i = 0; i < 30; i++) {
    const { pushed, full, sent } = await both({
      ...params,
      ...(position !== undefined ? { position: edit(position) } : {}),
    });
    expect({ page: i, ...pushed }).toEqual({ page: i, ...full });
    if (i > 0) paths.push(path(sent));
    out.push(pushed);
    position = pushed.result.next_position;
    if (position === undefined) break;
    await between(i);
  }
  return { out, paths };
}

/** Rows without their marks: those are read at each page (04-contract §15). */
const noMarks = (rows: readonly unknown[]) =>
  rows.map((r) => ({ ...(r as object), marks: undefined }));

const ids = (o: Out) =>
  o.result.rows.map((r) => (r as { row?: string; entity?: string }).row ?? (r as Any).entity);

describe("a later page pushed down", () => {
  it(
    "is read in SQL without the rows changed since the first page, those read as of it",
    async () => {
      let whole: Out | undefined;
      const { out, paths } = await pages({ table: "spend", limit: 3 }, async (i) => {
        if (i === 0) whole = (await both({ table: "spend", limit: 200 })).full;
        // A row of a later page changed, one of the first revoked, one inserted.
        await w([{ intent: "update", table: "spend", row: rows[1], set: { note: `p${i}` } }]);
        if (i === 0) await w([{ intent: "revoke", table: "spend", row: rows[7] }]);
        await w([{ intent: "insert", table: "spend", set: { date: "2026-11-04", note: "new" } }]);
      });
      expect(paths).toEqual(["pushed", "pushed"]);
      const first = whole as Out;
      expect(out.flatMap(ids)).toEqual(ids(first));
      for (const o of out) expect(o.result.total).toBe(8);
      // The changed row as the first page's state has it.
      const changed = out.flatMap((o) => o.result.rows).find((r) => (r as Any).row === rows[1]);
      expect(changed?.values["note"]).toBe("n2");
    },
    T,
  );

  it.each(["asc", "desc"] as const)(
    "breaks ties on a key asked for by the default keys on later pages, rows changed between them (%s)",
    async (dir) => {
      // Five more rows share a note, three of them a day too: ordered by the note, the default
      // keys (the time, then the row ID) order them, and pages of two cut through the three, so
      // that the last keys and the next row are equal on every key but the row ID. One of the
      // others changes between pages (read as of the first page, from the version table), and
      // one more with that note is inserted.
      const same: string[] = [];
      for (const day of [5, 5, 5, 3, 3])
        same.push(
          (
            await w([
              { intent: "insert", table: "spend", set: { date: `2026-11-0${day}`, note: "same" } },
            ])
          ).ops[0].target.row,
        );
      const params = { table: "spend", order: [{ field: "note", dir }], limit: 2 };
      const whole = await both({ ...params, limit: 200 });
      const { out, paths } = await pages(params, async (i) => {
        if (i === 0) {
          await w([{ intent: "update", table: "spend", row: same[4], set: { pieces: 9 } }]);
          await w([
            { intent: "insert", table: "spend", set: { date: "2026-11-04", note: "same" } },
          ]);
        }
      });
      expect(paths.every((p) => p === "pushed")).toBe(true);
      expect(out.flatMap(ids)).toEqual(ids(whole.full));
      // The tied rows in the default keys' order: the later time first, then by row ID.
      const tied = out.flatMap(ids).filter((x) => same.includes(x as string));
      const byDay = (d: number) => same.filter((_, k) => [5, 5, 5, 3, 3][k] === d).sort();
      expect(tied).toEqual([...byDay(5), ...byDay(3)]);
    },
    T,
  );

  it(
    "reads after the last keys of a state table at a point by a row comparison on its primary key",
    async () => {
      const params = { table: "budgets", valid_at: "2026-11-06", limit: 1 };
      const position = (await both(params)).pushed.result.next_position as string;
      await w([{ intent: "insert", table: "spend", set: { date: "2026-11-02" } }]);
      const { sent } = await both({ ...params, position });
      const reads = sent.filter((x) => /FROM "t_[^"]*"/.test(x) && !x.includes("__ver"));
      expect(reads.some((x) => /ROW\(entity_id, valid_from\) > ROW\(/.test(x))).toBe(true);
      // An event table's keys (the time descending, the row ID ascending): the alternatives.
      const spend = { table: "spend", limit: 3 };
      const at = (await both(spend)).pushed.result.next_position as string;
      const later = await both({ ...spend, position: at });
      const onSpend = later.sent.filter((x) => /FROM "t_[^"]*"/.test(x) && x.includes(" LIMIT "));
      expect(onSpend.some((x) => x.includes("ROW("))).toBe(false);
    },
    T,
  );

  it(
    "keeps a row whose time is corrected across the last keys between pages where it was",
    async () => {
      const params = { table: "spend", limit: 3 };
      const first = await both({ ...params, limit: 200 });
      const { out, paths } = await pages(params, async (i) => {
        if (i !== 0) return;
        // rows[0] (the 1st, last in the order) to the 9th (first); rows[7] (the 8th) to the 1st.
        await w([{ intent: "correct", table: "spend", row: rows[0], set: { date: "2026-11-09" } }]);
        await w([{ intent: "correct", table: "spend", row: rows[7], set: { date: "2026-10-31" } }]);
      });
      expect(paths.every((p) => p === "pushed")).toBe(true);
      expect(out.flatMap(ids)).toEqual(ids(first.full));
    },
    T,
  );

  it(
    "gives revoked rows and revokes undone as the first page saw them",
    async () => {
      const params = { table: "spend", include_revoked: true, limit: 2 };
      const r = await w([{ intent: "revoke", table: "spend", row: rows[3] }]);
      const first = await both({ ...params, limit: 200 });
      const { out, paths } = await pages(params, async (i) => {
        if (i === 0) {
          await w([{ table: "spend", row: rows[3], revert: { undo: r.seq } }]);
          await w([{ intent: "revoke", table: "spend", row: rows[0] }]);
        }
      });
      expect(paths.every((p) => p === "pushed")).toBe(true);
      expect(out.flatMap(ids)).toEqual(ids(first.full));
      expect(out.flatMap(ids)).toContain(rows[3]);
    },
    T,
  );

  it(
    "reads a state table at a point with entities changed between pages",
    async () => {
      const params = { table: "budgets", valid_at: "2026-11-06", limit: 1 };
      const first = await both({ ...params, limit: 200 });
      const { out, paths } = await pages(params, async (i) => {
        const category = ["food", "fun", "rent", "trip"][i] as string;
        await w([
          {
            intent: "update",
            table: "budgets",
            entity: entity[category === "food" ? "trip" : "food"],
            set: { amount: 99 + i },
            valid_from: "2026-11-02",
          },
        ]);
      });
      expect(paths).toEqual(["pushed", "pushed", "pushed"]);
      expect(noMarks(out.flatMap((o) => o.result.rows))).toEqual(noMarks(first.full.result.rows));
    },
    T,
  );

  it.each([{}, { coalesce: false }, { clip: true }])(
    "merges a state table's rows over an interval, entities changed between pages read as of the first (%o)",
    async (extra) => {
      const params = {
        table: "budgets",
        valid_during: ["2026-11-03", "2026-11-09"],
        ...extra,
        limit: 1,
      };
      const first = await both({ ...params, limit: 200 });
      const { out, paths } = await pages(params, async (i) => {
        // After the first row: food's second row and a later entity's merged away into the first.
        if (i === 0)
          for (const category of ["food", "rent"])
            await w([
              {
                intent: "update",
                table: "budgets",
                entity: entity[category],
                set: { amount: 10 },
                valid_from: "2026-11-05",
              },
            ]);
      });
      expect(paths.every((p) => p === "pushed")).toBe(true);
      expect(noMarks(out.flatMap((o) => o.result.rows))).toEqual(noMarks(first.full.result.rows));
    },
    T,
  );

  it(
    "streams over an interval from the last keys' entity, not from the first",
    async () => {
      const params = { table: "budgets", valid_during: ["2026-11-01", null], limit: 1 };
      const first = await both(params);
      const position = first.pushed.result.next_position as string;
      const { sent } = await both({ ...params, position });
      // The first statement on the business table starts at the entity of the last keys.
      const reads = sent.filter((x) => /FROM "t_[^"]*"/.test(x) && !x.includes("__ver"));
      expect(reads[0]).toMatch(/entity_id COLLATE "C" >= \$\d+ COLLATE "C"/);
    },
    T,
  );

  it(
    "leaves behind the rows before the last keys of an entity changed between pages",
    async () => {
      // A row a page, not merged: each entity two rows. After the third page, the first entity
      // (both its rows before the last keys) is changed: as of the first page, B holds its two
      // rows, neither of them after the keys.
      const params = {
        table: "budgets",
        valid_during: ["2026-11-01", null],
        coalesce: false,
        limit: 1,
      };
      const whole = await both({ ...params, limit: 200 });
      const firstEntity = ids(whole.full)[0] as string;
      const { out, paths } = await pages(params, async (i) => {
        if (i === 2)
          await w([
            {
              intent: "update",
              table: "budgets",
              entity: firstEntity,
              set: { amount: 30 },
              valid_from: "2026-11-03",
            },
          ]);
      });
      expect(paths.every((p) => p === "pushed")).toBe(true);
      expect(out.flatMap(ids)).toEqual(ids(whole.full));
    },
    T,
  );

  it.each([1, 4, 7])(
    "gives a next position only when a row follows, on every later page (limit %i)",
    async (limit) => {
      const { out } = await pages({ table: "spend", limit }, async () => {
        await w([{ intent: "insert", table: "spend", set: { date: "2026-11-02" } }]);
      });
      expect(out.map((o) => o.result.rows.length)).toEqual(
        Array.from({ length: Math.ceil(8 / limit) }, (_, i) => Math.min(limit, 8 - i * limit)),
      );
      expect(out.at(-1)?.result.next_position).toBeUndefined();
    },
    T,
  );

  it.each([
    { table: "spend", limit: 3 },
    { table: "budgets", valid_during: ["2026-11-01", null], limit: 3 },
  ])(
    "counts again from a position without the total, the same total (%o)",
    async (params) => {
      const strip = (p: string) => {
        const o = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
        expect(o.n).toBe(8);
        delete o.n;
        return Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
      };
      let edits = 0;
      const changed = async () => {
        // A row inserted (not there as of the first page) and one there changed: B counts the
        // second, A no longer does.
        await w([{ intent: "insert", table: "spend", set: { date: "2026-11-02" } }]);
        await w([{ intent: "update", table: "spend", row: rows[0], set: { note: `e${++edits}` } }]);
        await w([
          {
            intent: "update",
            table: "budgets",
            entity: entity["fun"],
            set: { amount: 7 },
            valid_from: "2026-11-03",
          },
        ]);
      };
      const { out, paths } = await pages(params, changed, strip);
      expect(paths.every((p) => p === "pushed")).toBe(true);
      for (const o of out) expect(o.result.total).toBe(8);
    },
    T,
  );

  it(
    "is the whole read once more rows changed than the limit allows, and pushed at the limit",
    async () => {
      // changedLimit(3) = 1000: rows inserted after the first page, in requests of 500.
      for (const [n, expected] of [
        [999, "pushed"],
        [1000, "whole"],
      ] as const) {
        await s.reset();
        minute = 0;
        await createTenant(s.store, ctx());
        await schemaDraft(s.store, ctx(), {
          document: {
            slot: "ledger",
            base_version: null,
            timezone: "Asia/Shanghai",
            tables: [SPEND],
          },
        });
        for (let day = 1; day <= 8; day++)
          await w([{ intent: "insert", table: "spend", set: { date: `2026-11-0${day}` } }]);
        // Plus one row changed: 1000 or 1001 in all.
        const changed = async (i: number) => {
          if (i !== 0) return;
          for (let k = 0; k < n; k += 500)
            await w(
              Array.from({ length: Math.min(500, n - k) }, (_, j) => ({
                intent: "insert",
                table: "spend",
                set: { date: "2026-10-01", note: `x${k + j}` },
              })),
            );
          // The newest row, one of the eight: not among those inserted.
          const one = (await both({ table: "spend", limit: 1 })).pushed.result.rows;
          await w([
            { intent: "update", table: "spend", row: (one[0] as Any).row, set: { note: "y" } },
          ]);
        };
        const { out, paths } = await pages({ table: "spend", limit: 3 }, changed);
        expect({ n, path: paths[0] }).toEqual({ n, path: expected });
        expect(out.flatMap(ids)).toHaveLength(8);
      }
    },
    T,
  );

  /** A stand-in event of the type, the latest operation: nothing reads it but the checks. */
  const standIn = (type: string) =>
    s.store.write((tx) =>
      tx.query(
        `INSERT INTO events (seq, header, header_hash, type, actor, at, op)
         SELECT max(seq) + 1, '{}', 'h', $1, 'system', '2026-11-15T03:59:00.000Z', max(op) + 1
         FROM events`,
        [type],
      ),
    );

  it(
    "is the whole read after a deletion carried out since the first page",
    async () => {
      const { out, paths } = await pages({ table: "spend", limit: 3 }, async (i) => {
        if (i === 0) await standIn("deletion.executed");
      });
      expect(paths).toEqual(["whole", "whole"]);
      expect(out.flatMap(ids)).toHaveLength(8);
    },
    T,
  );

  it.each(["deletion.confirmed", "deletion.cancelled"])(
    "expires the position after a %s since the first page, both ways",
    async (type) => {
      const params = { table: "spend", limit: 3 };
      const position = (await both(params)).pushed.result.next_position as string;
      await standIn(type);
      for (const full of [false, true]) {
        const refused = await s.store
          .read((tx) =>
            queryInTx(tx, {
              actor: USER as never,
              task: null,
              now: NOW as never,
              visibility: { kind: "all" },
              params: { ...params, position },
              read: "rd_0000000000000000" as never,
              ...(full ? { full: true as const } : {}),
            }),
          )
          .then(
            () => undefined,
            (e: { code?: string; detail?: { reason?: string } }) => [e.code, e.detail?.reason],
          );
        expect({ full, refused }).toEqual({
          full,
          refused: ["handle_expired", "deletion_changed"],
        });
      }
    },
    T,
  );

  it(
    "is the whole read after a schema switch since the first page",
    async () => {
      const { out, paths } = await pages({ table: "spend", limit: 3 }, async (i) => {
        if (i !== 0) return;
        const d = (await schemaDraft(s.store, ctx(), {
          document: {
            slot: "ledger",
            base_version: 1,
            timezone: "Asia/Shanghai",
            tables: [
              ...(
                await s.store.read((tx) =>
                  tx.query<{ structure: string }>(
                    "SELECT structure FROM catalog ORDER BY table_id",
                  ),
                )
              ).rows.map((x) => {
                const t = JSON.parse(x.structure);
                return {
                  id: t.id,
                  name: t.name,
                  kind: "base",
                  description: t.description,
                  time:
                    t.time.type === "event"
                      ? {
                          type: "event",
                          field: t.fields.find((f: Any) => f.id === t.time.field).name,
                        }
                      : t.time,
                  fields: t.fields.map((f: Any) => ({
                    id: f.id,
                    name: f.name,
                    type: f.type,
                    description: f.description,
                    ...(f.required === true ? { required: true } : {}),
                  })),
                };
              }),
              {
                name: "notes",
                kind: "base",
                description: "free notes",
                time: { type: "none" },
                fields: [{ name: "text", type: "text", description: "the note" }],
              },
            ],
          },
        })) as Any;
        expect(d.outcome).toBe("applied");
      });
      expect(paths).toEqual(["whole", "whole"]);
      expect(out.flatMap(ids)).toHaveLength(8);
    },
    T,
  );
});
