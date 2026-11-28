// A write by a credential scoped to some slots names only what it can see (04-contract «名字只在可见
// 范围内解析», «不存在与不可见报同一个错误»): a slot, table or field out of its range is answered as
// one that does not exist. Each request is sent to a tenant with slots out of range and to one
// without them; the answers must be the same, key for key. A table in range is written as by any
// other credential (03-data-model/04-write-and-read «可见范围 · 写入»).

import {
  catalog,
  createOpsContext,
  createTenant,
  resolve,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"9".repeat(26)}`;
const USER = `u_${"2".repeat(26)}`;
const OTHER = `ci_${"6".repeat(26)}`;
const CONN = `ci_${"5".repeat(26)}`;

let s: ReusableStore;
let minute = 0;
const ctxOf = (actor: string, visibility: unknown) =>
  createOpsContext({
    tenant: TENANT,
    actor,
    trigger: null,
    task: null,
    visibility,
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T04:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  } as never);
const ALL = { kind: "all" };

const table = (name: string, fields: string[]) => ({
  name,
  kind: "base",
  description: name,
  time: { type: "event", field: "date" },
  fields: [
    { name: "date", type: "date", required: true, description: "the day" },
    ...fields.map((f) => ({ name: f, type: "text", description: f })),
  ],
});
const slot = (name: string, tables: unknown[]) =>
  schemaDraft(s.store, ctxOf(USER, ALL), {
    document: { slot: name, base_version: null, timezone: "Asia/Shanghai", tables },
  } as never);

/** A fresh tenant with `slots`; the IDs of its slots and tables by name. */
async function tenant(slots: Record<string, unknown[]>) {
  await s.reset();
  await createTenant(s.store, ctxOf(USER, ALL));
  for (const [name, tables] of Object.entries(slots)) await slot(name, tables);
  const c = (await catalog(s.store, ctxOf(USER, ALL), {})) as unknown as {
    slots: { slot: string; slot_id: string }[];
  };
  const ids = Object.fromEntries(c.slots.map((x) => [x.slot, x.slot_id]));
  const tableIds = async (name: string) => {
    const d = (await catalog(s.store, ctxOf(USER, ALL), {
      level: "schema",
      slot: name,
    })) as unknown as { document: { tables: { id: string; name: string }[] } };
    return Object.fromEntries(d.document.tables.map((t) => [t.name, t.id]));
  };
  return { ids, tableIds };
}

/**
 * What a write answers: saved, and in which table; or the error's code, message and details. (Not
 * the whole receipt: its IDs differ from tenant to tenant.)
 */
async function answer(visibility: unknown, op: Record<string, unknown>) {
  try {
    const r = await write(s.store, ctxOf(CONN, visibility), { sv: 1, ops: [op] } as never);
    return { saved: r.status, table: r.ops[0]?.target.table };
  } catch (e) {
    const x = e as { code?: string; message?: string; detail?: unknown };
    if (x.code === undefined) throw e;
    return { code: x.code, message: x.message, detail: x.detail };
  }
}

/** The names an answer gives beyond the request: nearest names and candidates. */
const added = (answers: Record<string, unknown>) =>
  Object.values(answers).map((a) => {
    const d = ((a as { detail?: Record<string, unknown> }).detail ?? {}) as Record<string, unknown>;
    return [d["nearest"], d["candidates"]];
  });

const SET = { date: "2026-11-05", what: "x" };
/** Requests out of range or naming nothing: the same answer with or without the hidden slots. */
const HIDDEN_OR_ABSENT: Record<string, Record<string, unknown>> = {
  "a slot that does not exist": { intent: "insert", table: "nothere.meals", set: SET },
  "a slot out of range, a table it does not have": {
    intent: "insert",
    table: "secretplan.nothere",
    set: SET,
  },
  "a table out of range": { intent: "insert", table: "secretplan.hidden_table", set: SET },
  "a table out of range, with a field it does not have": {
    intent: "insert",
    table: "secretplan.hidden_table",
    set: { date: "2026-11-05", hidden: "x" },
  },
  "a bare name only out of range": { intent: "insert", table: "hidden_table", set: SET },
  "a table in a slot in range that does not have it": {
    intent: "insert",
    table: "diet.nothere",
    set: SET,
  },
};

beforeAll(async () => {
  s = await openReusable("saveslot-write-scope-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);

describe("a write by a credential scoped to one slot", () => {
  it(
    "answers what is out of range as what does not exist, and writes a table in range",
    async () => {
      const ask = async (slots: Record<string, unknown[]>) => {
        const { ids } = await tenant(slots);
        const scoped = { kind: "scoped", slots: [{ slot: ids["diet"] }] };
        const out: Record<string, unknown> = {};
        for (const [k, op] of Object.entries(HIDDEN_OR_ABSENT)) out[k] = await answer(scoped, op);
        out["a bare name in range and out of it"] = await answer(scoped, {
          intent: "insert",
          table: "meals",
          set: SET,
        });
        out["a table in range"] = await answer(scoped, {
          intent: "insert",
          table: "diet.meals",
          set: SET,
        });
        out["a table in range, with a field it does not have"] = await answer(scoped, {
          intent: "insert",
          table: "diet.meals",
          set: { date: "2026-11-05", hidden: "x" },
        });
        return out;
      };
      const withHidden = await ask({
        diet: [table("meals", ["what"])],
        ledger: [table("meals", ["what"])],
        secretplan: [table("hidden_table", ["hidden_field", "what"])],
      });
      const without = await ask({ diet: [table("meals", ["what"])] });
      for (const k of Object.keys(withHidden)) expect([k, withHidden[k]]).toEqual([k, without[k]]);
      // Nothing out of range in what the answers add to the request (the name given is echoed).
      expect(JSON.stringify(added(withHidden))).not.toMatch(
        /ledger|secretplan|hidden_table|hidden_field/,
      );
      // What the answers are.
      expect(withHidden["a table out of range"]).toMatchObject({
        code: "unknown_table",
        detail: { param: "ops/0/table", name: "secretplan.hidden_table", nearest: ["diet.meals"] },
      });
      // A bare name in range and out of it: the one in range, never ambiguous_table.
      for (const k of ["a bare name in range and out of it", "a table in range"]) {
        expect([k, withHidden[k]]).toEqual([k, { saved: "saved", table: "diet.meals" }]);
      }
      expect(withHidden["a table in range, with a field it does not have"]).toMatchObject({
        code: "unknown_field",
      });
    },
    T,
  );

  it(
    "scoped to one table of a slot: the slot's other tables are as if they did not exist",
    async () => {
      const ask = async (tables: unknown[]) => {
        const { ids, tableIds } = await tenant({
          diet: tables,
          ledger: [table("meals", ["what"])],
        });
        const meals = (await tableIds("diet"))["meals"];
        const scoped = {
          kind: "scoped",
          slots: [{ slot: ids["diet"], tables: [{ table: meals }] }],
        };
        return {
          other: await answer(scoped, { intent: "insert", table: "diet.notes", set: SET }),
          bare: await answer(scoped, { intent: "insert", table: "notes", set: SET }),
          inRange: await answer(scoped, { intent: "insert", table: "diet.meals", set: SET }),
        };
      };
      const withNotes = await ask([table("meals", ["what"]), table("notes", ["secret"])]);
      const without = await ask([table("meals", ["what"])]);
      expect(withNotes).toEqual(without);
      expect(withNotes.other).toMatchObject({ code: "unknown_table" });
      expect(JSON.stringify(added(withNotes))).not.toMatch(/notes|secret|ledger/);
    },
    T,
  );

  it(
    "a decision on an item out of range is answered as on an item that does not exist",
    async () => {
      const { ids } = await tenant({
        diet: [table("meals", ["what"])],
        secretplan: [table("hidden_table", ["what"])],
      });
      // An item in secretplan: two writes from the same version, the second a candidate.
      const put = (actor: string, op: Record<string, unknown>) =>
        write(s.store, ctxOf(actor, ALL), {
          sv: 1,
          ops: [{ table: "secretplan.hidden_table", ...op }],
        } as never) as unknown as Promise<{
          ops: { ver: string; target: { row: string } }[];
          pending?: { id: string }[];
        }>;
      const a = await put(USER, { intent: "insert", set: SET });
      const row = a.ops[0]?.target.row as string;
      const ver = a.ops[0]?.ver as string;
      await put(USER, { row, intent: "update", ver, set: { what: "y" } });
      const c = await put(OTHER, { row, intent: "update", ver, set: { what: "z" } });
      const item = c.pending?.[0]?.id as string;
      expect(item).toMatch(/^pi_/);
      const scoped = { kind: "scoped", slots: [{ slot: ids["diet"] }] };
      const decide = async (id: string) => {
        try {
          return await resolve(s.store, ctxOf(CONN, scoped), { id, decision: "reject" } as never);
        } catch (e) {
          const x = e as { code?: string; message?: string; detail?: unknown };
          return { code: x.code, message: x.message, detail: x.detail };
        }
      };
      const hidden = await decide(item);
      expect(hidden).toEqual(await decide("pi_0000000000009999"));
      expect(hidden).toMatchObject({ code: "not_found" });
    },
    T,
  );

  it(
    "a source or a ref target out of range is answered as one that does not exist, the ID aside",
    async () => {
      const { ids, tableIds } = await tenant({
        diet: [
          {
            ...table("meals", ["what"]),
            fields: [
              ...table("meals", ["what"]).fields,
              {
                name: "note",
                type: "ref",
                description: "a note",
                ref: { table: "notes", target: "row" },
              },
            ],
          },
          {
            ...table("notes", ["text"]),
            time: { type: "none" },
            fields: [{ name: "text", type: "text", required: true, description: "text" }],
          },
        ],
        secretplan: [table("hidden_table", ["what"])],
      });
      const put = (
        table: string,
        set: Record<string, unknown>,
        more: Record<string, unknown> = {},
      ) =>
        write(s.store, ctxOf(USER, ALL), {
          sv: 1,
          ...more,
          ops: [{ table, intent: "insert", set }],
        } as never);
      // A source in secretplan, out of range of a credential scoped to diet.
      const said = await put("secretplan.hidden_table", SET, {
        evidence: [{ kind: "user_message", text: "it was x" }],
      });
      const source = (
        await s.store.read((tx) =>
          tx.query<{ source_id: string }>("SELECT source_id FROM sources WHERE seq = $1", [
            said.seq + 1,
          ]),
        )
      ).rows[0]?.source_id as string;
      expect(source).toMatch(/^s_/);
      // A note in diet, out of range of a credential scoped to diet's meals only.
      const note = (await put("diet.notes", { text: "n" })).ops[0]?.target.row as string;
      const meals = (await tableIds("diet"))["meals"];
      const toDiet = { kind: "scoped", slots: [{ slot: ids["diet"] }] };
      const toMeals = {
        kind: "scoped",
        slots: [{ slot: ids["diet"], tables: [{ table: meals }] }],
      };
      /** An ID of the same form that names nothing: its last character changed. */
      const other = (id: string) => `${id.slice(0, -1)}${id.endsWith("A") ? "B" : "A"}`;
      const asText = (a: unknown, id: string) => JSON.stringify(a).split(id).join("<id>");
      const bySource = (id: string) =>
        answer(toDiet, {
          intent: "insert",
          table: "diet.meals",
          set: SET,
          evidence: [{ kind: "source_ref", id }],
        });
      const byRef = (id: string) =>
        answer(toMeals, { intent: "insert", table: "diet.meals", set: { ...SET, note: id } });
      expect(asText(await bySource(source), source)).toEqual(
        asText(await bySource(other(source)), other(source)),
      );
      expect(await bySource(source)).toMatchObject({ code: "not_found" });
      expect(asText(await byRef(note), note)).toEqual(
        asText(await byRef(other(note)), other(note)),
      );
      expect(JSON.stringify(await byRef(note))).toContain("ref_not_found");
    },
    T,
  );
});
