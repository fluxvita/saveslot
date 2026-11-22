// The contract cases every surface runs (02-architecture §11 «测试矩阵»: HTTP and MCP run the same
// contract tests): written against a driver that calls an operation as a credential and gives the
// result or the error's code and detail, so that each adapter supplies only the driver. An
// operation a surface does not have (on MCP, the management operations: 05-surfaces §1 «不进
// MCP») goes through the admin driver, HTTP. What is particular to a surface (HTTP statuses and
// headers, the MCP protocol) is tested by that surface's own cases.

import type { Operation } from "@fluxvita/saveslot-service";
import { expect, it } from "vitest";

/** A call's outcome: the result, or the error as the contract gives it. */
export type Outcome =
  | { readonly result: Record<string, unknown> }
  | {
      readonly error: { readonly code: string; readonly reason?: string } & Record<string, unknown>;
    };

/** Calls `operation` with `params` as the holder of `credential`. */
export type Driver = (
  credential: string,
  operation: Operation,
  params: Record<string, unknown>,
  o?: { readonly task?: string; readonly idempotencyKey?: string },
) => Promise<Outcome>;

const result = (o: Outcome) => {
  if (!("result" in o)) throw new Error(`refused: ${JSON.stringify(o.error)}`);
  return o.result;
};

/** A small slot: expenses by date. */
export const LEDGER = {
  slot: "ledger",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: "expenses",
      kind: "base",
      description: "one row per expense",
      time: { type: "event", field: "date" },
      fields: [
        { name: "date", type: "date", required: true, description: "the day" },
        { name: "note", type: "text", description: "what for" },
      ],
    },
  ],
};

/** A slot of its own, for what another slot's credential may not see of its sources. */
const DIARY = {
  ...LEDGER,
  slot: "diary",
  tables: [{ ...LEDGER.tables[0], name: "entries", description: "one row per entry" }],
};

/** A slot to remove: another table name than the ledger's, so that table names stay unique. */
const SPARE = {
  ...LEDGER,
  slot: "spare",
  tables: [{ ...LEDGER.tables[0], name: "jottings", description: "one row per note" }],
};

/**
 * The contract cases, in order, on a fresh tenant: `session` is the user session's token; the
 * suite issues the connections it needs.
 */
export function contractSuite(
  get: () => {
    readonly driver: Driver;
    readonly session: string;
    /** The operations the surface has; every one when not given. */
    readonly surface?: ReadonlySet<Operation>;
    /** The driver for the operations the surface does not have. */
    readonly admin?: Driver;
  },
) {
  const call: Driver = (credential, operation, params, o) => {
    const { driver, surface, admin } = get();
    if (surface === undefined || surface.has(operation))
      return driver(credential, operation, params, o);
    if (admin === undefined) throw new Error(`no driver for ${operation}`);
    return admin(credential, operation, params, o);
  };
  let writer = "";
  let reader = "";
  let readerId = "";

  it("the user session creates a slot; the catalog lists it", async () => {
    const { session } = get();
    const driver = call;
    const d = result(await driver(session, "schema_draft", { document: LEDGER }));
    expect(d).toMatchObject({ outcome: "applied", slot: "ledger" });
    const c = result(await driver(session, "catalog", {}));
    expect(JSON.stringify(c)).toContain("ledger");
  });

  it("connections: issued with their token once; listed without it", async () => {
    const { session } = get();
    const driver = call;
    const w = result(await driver(session, "connections.issue", { name: "writer" }));
    const r = result(
      await driver(session, "connections.issue", { name: "reader", scopes: ["saveslot.read"] }),
    );
    writer = w["token"] as string;
    reader = r["token"] as string;
    readerId = r["id"] as string;
    const listed = result(await driver(session, "connections.list", {}));
    expect((listed["connections"] as { name: string }[]).map((c) => c.name)).toEqual([
      "writer",
      "reader",
    ]);
    expect(JSON.stringify(listed)).not.toContain(writer);
  });

  it("a write, repeated with the same idempotency key: one operation, replayed", async () => {
    const driver = call;
    const params = {
      sv: 1,
      ops: [
        { intent: "insert", table: "ledger.expenses", set: { date: "2026-11-16", note: "tea" } },
      ],
    };
    const first = result(await driver(writer, "write", params, { idempotencyKey: "tea-1" }));
    expect(first).toMatchObject({ status: "saved" });
    const again = result(await driver(writer, "write", params, { idempotencyKey: "tea-1" }));
    expect(again).toMatchObject({ seq: first["seq"], replayed: true });
    const rows = result(await driver(reader, "query", { table: "ledger.expenses" }));
    expect(JSON.stringify(rows)).toContain("tea");
  });

  it("a task identifier goes with the call", async () => {
    const driver = call;
    const w = result(
      await driver(
        writer,
        "write",
        {
          sv: 1,
          ops: [
            {
              intent: "insert",
              table: "ledger.expenses",
              set: { date: "2026-11-16", note: "bus" },
            },
          ],
        },
        { task: "weekly-review" },
      ),
    );
    expect(w).toMatchObject({ status: "saved" });
  });

  it("history changes: what changed in a period, paged; my_last_read needs a read of the table", async () => {
    const driver = call;
    const point = { mode: "changes", table: "ledger.expenses" };
    // The reader read the table (a query) before the second write: that one is all that is new.
    const mine = result(await driver(reader, "history", { ...point, since: "my_last_read" }));
    expect(mine).toMatchObject({ mode: "changes", total: 1, target: { table: "ledger.expenses" } });
    const notes = (r: Record<string, unknown>) =>
      (r["changes"] as { intent: string; fields: { note?: { after: string } } }[]).map(
        (c) => `${c.intent} ${c.fields.note?.after}`,
      );
    expect(notes(mine)).toEqual(["insert bus"]);
    // The whole table from the start, a page at a time: newest first, the window kept.
    const first = result(await driver(reader, "history", { ...point, since: 0, limit: 1 }));
    expect(first).toMatchObject({ since: 0, total: 2 });
    expect(notes(first)).toEqual(["insert bus"]);
    const cursor = first["next_cursor"] as string;
    expect(cursor).toMatch(/^cur_/);
    const second = result(
      await driver(reader, "history", { ...point, since: 0, limit: 1, cursor }),
    );
    expect(notes(second)).toEqual(["insert tea"]);
    expect(second).not.toHaveProperty("next_cursor");
    expect(second["until"]).toBe(first["until"]);
    // The writer has written the table, never read it: read_first, the table to read.
    expect(await driver(writer, "history", { ...point, since: "my_last_read" })).toEqual({
      error: expect.objectContaining({
        code: "read_first",
        reason: "no_read",
        target: "table",
        param: "since",
      }),
    });
  });

  it("a row read says who last changed it, when that is not the caller: query and history as_of", async () => {
    const driver = call;
    const { session } = get();
    const row = result(
      await driver(reader, "query", {
        table: "ledger.expenses",
        where: [{ field: "note", op: "=", value: "tea" }],
      }),
    )["rows"] as Record<string, unknown>[];
    expect(row[0]?.["changed_by"]).toMatchObject({ kind: "connection", name: "writer" });
    // The writer's own row: nothing to say.
    const own = result(
      await driver(writer, "query", {
        table: "ledger.expenses",
        where: [{ field: "note", op: "=", value: "tea" }],
      }),
    )["rows"] as Record<string, unknown>[];
    expect(own[0]?.["changed_by"]).toBeUndefined();
    // As of the write's operation: the same.
    const id = row[0]?.["row"] as string;
    const seq = Number(String(row[0]?.["ver"]).slice(1).split(".")[0]);
    const asOf = result(
      await driver(session, "history", {
        mode: "as_of",
        table: "ledger.expenses",
        row: id,
        as_of: seq,
      }),
    )["rows"] as Record<string, unknown>[];
    expect(asOf[0]?.["changed_by"]).toMatchObject({ name: "writer" });
  });

  it("sql: one SELECT over the tables by name, a value as $1; the read recorded as sql", async () => {
    const { session } = get();
    const driver = call;
    const r = result(
      await driver(reader, "sql", {
        sql: "SELECT note, count(*) AS n FROM expenses WHERE date >= $1 GROUP BY note ORDER BY note",
        params: ["2026-11-01"],
      }),
    );
    expect(r).toMatchObject({
      sv: { ledger: 1 },
      columns: [
        { name: "note", type: "text" },
        { name: "n", type: "integer" },
      ],
      rows: [
        ["bus", "1"],
        ["tea", "1"],
      ],
    });
    expect(r).not.toHaveProperty("next_cursor");
    // Refused before it runs: a statement that is not a SELECT.
    expect(await driver(reader, "sql", { sql: "DELETE FROM expenses" })).toEqual({
      error: expect.objectContaining({ code: "sql_rejected" }),
    });
    const reads = result(await driver(session, "reads.list", { limit: 1 }));
    expect((reads["reads"] as { operation: string }[])[0]).toMatchObject({ operation: "sql" });
  });

  it("what a credential may not do: insufficient_scope, with the scope needed", async () => {
    const driver = call;
    expect(await driver(reader, "write", { sv: 1, ops: [] })).toEqual({
      error: expect.objectContaining({
        code: "insufficient_scope",
        required_scope: "saveslot.write",
      }),
    });
    expect(await driver(writer, "connections.list", {})).toEqual({
      error: expect.objectContaining({
        code: "insufficient_scope",
        required_scope: "user_session",
      }),
    });
  });

  it("a revoked connection is refused as revoked from its next call on", async () => {
    const { session } = get();
    const driver = call;
    result(await driver(session, "connections.revoke", { id: readerId }));
    expect(await driver(reader, "catalog", {})).toEqual({
      error: expect.objectContaining({ code: "unauthenticated", reason: "revoked" }),
    });
  });

  it("an empty slot removed by its ID: a connection whose range was only it sees nothing, nor a slot created later under its name", async () => {
    const { session } = get();
    const driver = call;
    const spare = result(await driver(session, "schema_draft", { document: SPARE }));
    const id = spare["slot_id"] as string;
    const only = result(
      await driver(session, "connections.issue", { name: "spare-only", slots: ["spare"] }),
    );
    const token = only["token"] as string;
    const names = async (credential: string) =>
      (result(await driver(credential, "catalog", {}))["slots"] as { slot: string }[]).map(
        (x) => x.slot,
      );
    const writeSpare = () =>
      driver(token, "write", {
        sv: 1,
        ops: [{ intent: "insert", table: "spare.jottings", set: { date: "2026-11-16" } }],
      });
    expect(await names(token)).toEqual(["spare"]);
    // By name: refused (names can be reused); by a credential that is not the user's: refused; a
    // slot with records: refused.
    expect(await driver(session, "slots.remove", { slot_id: "spare" })).toEqual({
      error: expect.objectContaining({ code: "invalid_argument", param: "slot_id" }),
    });
    expect(await driver(writer, "slots.remove", { slot_id: id })).toEqual({
      error: expect.objectContaining({
        code: "insufficient_scope",
        required_scope: "user_session",
      }),
    });
    const ledger = (
      result(await driver(session, "catalog", {}))["slots"] as Record<string, unknown>[]
    ).find((x) => x["slot"] === "ledger") as Record<string, unknown>;
    expect(await driver(session, "slots.remove", { slot_id: ledger["slot_id"] })).toEqual({
      error: expect.objectContaining({ code: "invalid_argument", reason: "slot_not_empty" }),
    });

    const removed = result(await driver(session, "slots.remove", { slot_id: id }));
    expect(removed).toMatchObject({ slot_id: id, name: "spare", sv: 1 });
    expect(result(await driver(session, "slots.remove", { slot_id: id }))).toEqual(removed);
    // The connection's range lists no slot now, and it sees none: never every slot.
    const listed = result(await driver(session, "connections.list", {}))["connections"] as Record<
      string,
      unknown
    >[];
    expect(listed.find((c) => c["name"] === "spare-only")?.["slots"]).toEqual([]);
    expect(await names(token)).toEqual([]);
    expect(await writeSpare()).toEqual({
      error: expect.objectContaining({ code: "unknown_table" }),
    });
    // A slot created under the same name is another slot: the connection does not see it.
    const later = result(
      await driver(session, "schema_draft", {
        document: { ...SPARE, timezone: "UTC" },
      }),
    );
    expect(later["slot_id"]).not.toBe(id);
    expect(await names(session)).toEqual(["ledger", "spare"]);
    expect(await names(token)).toEqual([]);
    expect(await writeSpare()).toEqual({
      error: expect.objectContaining({ code: "unknown_table" }),
    });
  });

  // A credential limited to some slots (04-contract §12; 03-data-model/04-write-and-read «可见范围»):
  // it writes and decides whatever is in range as any other credential would; out of range is
  // what does not exist, to the byte. "home" is in its range; "away" is created after the
  // refusals of names it does not know were taken, so that the same requests can be compared
  // before "away" exists and after. A refusal by ID is compared with the refusal of an ID of the
  // same form that names nothing, the ID itself left out.
  const homeDoc = (slot: string) => ({
    slot,
    base_version: null,
    timezone: "Asia/Shanghai",
    tables: [
      {
        name: `trips_${slot}`,
        kind: "base",
        description: "one row per trip",
        time: { type: "none" },
        fields: [{ name: "name", type: "text", required: true, description: "the trip" }],
      },
      {
        name: `legs_${slot}`,
        kind: "base",
        description: "one row per leg of a trip",
        time: { type: "none" },
        fields: [
          { name: "note", type: "text", required: true, description: "the leg" },
          {
            name: "trip",
            type: "ref",
            description: "the trip it is part of",
            ref: { table: `trips_${slot}`, target: "row" },
          },
        ],
      },
      // The same table name in both slots: by its bare name, ambiguous only to who sees both.
      {
        name: "camps",
        kind: "base",
        description: "one row per camp",
        time: { type: "none" },
        fields: [{ name: "name", type: "text", required: true, description: "the camp" }],
      },
    ],
  });
  // biome-ignore lint/suspicious/noExplicitAny: results as the contract gives them
  type Any = any;
  let homeOnly = "";
  /** The refusals of names "home-only" does not know, taken before "away" exists. */
  const before = new Map<string, string>();
  const byId: Record<string, string> = {};
  let made = 0;
  const homeWrite = (credential: string, ops: Record<string, unknown>[]) =>
    call(credential, "write", { sv: 1, ops });
  /** The error as the contract gives it, as text, with each of `ids` written as `<id>`. */
  const refusal = async (o: Promise<Outcome>, ...ids: string[]) => {
    const r = await o;
    if (!("error" in r)) throw new Error(`not refused: ${JSON.stringify(r.result)}`);
    return ids.reduce((text, id) => text.split(id).join("<id>"), JSON.stringify(r.error));
  };
  /** An ID of the same form that names nothing: its last character changed. */
  const other = (id: string) => `${id.slice(0, -1)}${id.endsWith("A") ? "B" : "A"}`;
  /** The requests by name whose refusals must not tell "away" exists. */
  const byName: Record<string, () => Promise<Outcome>> = {
    "a table in a slot out of range": () =>
      homeWrite(homeOnly, [{ intent: "insert", table: "away.trips_away", set: { name: "x" } }]),
    "a table by its bare name, only out of range": () =>
      homeWrite(homeOnly, [{ intent: "insert", table: "trips_away", set: { name: "x" } }]),
    "a premise on a table out of range": () =>
      homeWrite(homeOnly, [
        {
          intent: "insert",
          table: "home.trips_home",
          set: { name: "x" },
          premises: [{ table: "away.trips_away", row: "r_00000000000000000000000000" }],
        },
      ]),
    "a read of a table out of range": () => call(homeOnly, "query", { table: "away.trips_away" }),
  };
  /** One conflict item in `slot`'s trips: two updates from the same seen version. Its ID. */
  const conflictIn = async (slot: string, second: string) => {
    const { session } = get();
    const n = ++made;
    const table = `${slot}.trips_${slot}`;
    const e: Any = result(
      await homeWrite(session, [{ intent: "insert", table, set: { name: `t0-${n}` } }]),
    );
    const row = e.ops[0].target.row as string;
    const ver = e.ops[0].ver as string;
    result(
      await homeWrite(session, [{ intent: "update", table, row, ver, set: { name: `t1-${n}` } }]),
    );
    const c: Any = result(
      await homeWrite(second, [{ intent: "update", table, row, ver, set: { name: `t2-${n}` } }]),
    );
    return (c.pending as Any[]).find((x) => x.type === "conflict").id as string;
  };
  /**
   * One awaiting item in `slot`: `by` undoes a correction together with the one made after it
   * (`include_later`, high impact ④: 03-data-model/05-time «高影响写入»). Its ID.
   */
  const awaitingIn = async (slot: string, by: string) => {
    const { session } = get();
    const n = ++made;
    const table = `${slot}.trips_${slot}`;
    const a: Any = result(
      await homeWrite(session, [{ intent: "insert", table, set: { name: `a-${n}` } }]),
    );
    const row = a.ops[0].target.row as string;
    const x: Any = result(
      await homeWrite(session, [
        { intent: "update", table, row, ver: a.ops[0].ver, set: { name: `b-${n}` } },
      ]),
    );
    result(
      await homeWrite(session, [
        { intent: "update", table, row, ver: x.ops[0].ver, set: { name: `c-${n}` } },
      ]),
    );
    const r: Any = result(
      await homeWrite(by, [{ table, row, revert: { undo: x.seq, include_later: true } }]),
    );
    return (r.pending as Any[]).find((p) => p.type === "awaiting_confirmation").id as string;
  };
  const detail = async (credential: string, id: string): Promise<Any> =>
    result(await call(credential, "pending", { id }));

  it("limited to some slots: what it does not know, refused before the slot out of range exists", async () => {
    const { session } = get();
    result(await call(session, "schema_draft", { document: homeDoc("home") }));
    const issued = result(
      await call(session, "connections.issue", {
        name: "home-only",
        scopes: ["saveslot.read", "saveslot.write", "saveslot.schema"],
        slots: ["home"],
      }),
    );
    homeOnly = issued["token"] as string;
    for (const [what, request] of Object.entries(byName))
      before.set(what, await refusal(request()));
  });

  it("limited to some slots: once the slot out of range exists, the same refusals to the byte", async () => {
    const { session } = get();
    result(await call(session, "schema_draft", { document: homeDoc("away") }));
    for (const [what, request] of Object.entries(byName)) {
      expect([what, await refusal(request())]).toEqual([what, before.get(what)]);
    }
    // A bare name both slots have: ambiguous to who sees both, the one in range to "home-only".
    const camp = [{ intent: "insert", table: "camps", set: { name: "c" } }];
    expect(await refusal(homeWrite(session, camp))).toContain('"ambiguous_table"');
    expect(result(await homeWrite(homeOnly, camp))).toMatchObject({
      status: "saved",
      ops: [{ target: { table: "home.camps" } }],
    });
  });

  it("limited to some slots: an ID out of range is refused as an ID that names nothing", async () => {
    const { session } = get();
    const trip: Any = result(
      await homeWrite(session, [
        { intent: "insert", table: "away.trips_away", set: { name: "far" } },
      ]),
    );
    byId["row"] = trip.ops[0].target.row as string;
    byId["seq"] = String(trip.seq);
    byId["conflict"] = await conflictIn("away", writer);
    byId["awaiting"] = await awaitingIn("away", session);
    const row = byId["row"] as string;
    // A ref value, a premise's row, an update's row: a row out of range.
    const asRow: Record<string, (id: string) => Promise<Outcome>> = {
      ref: (id) =>
        homeWrite(homeOnly, [
          { intent: "insert", table: "home.legs_home", set: { note: "n", trip: id } },
        ]),
      premise: (id) =>
        homeWrite(homeOnly, [
          {
            intent: "insert",
            table: "home.trips_home",
            set: { name: "x" },
            premises: [{ table: "home.trips_home", row: id }],
          },
        ]),
      update: (id) =>
        homeWrite(homeOnly, [
          { intent: "update", table: "home.trips_home", row: id, set: { name: "y" } },
        ]),
    };
    for (const [what, request] of Object.entries(asRow)) {
      expect([what, await refusal(request(row), row)]).toEqual([
        what,
        await refusal(request(other(row)), other(row)),
      ]);
    }
    // An item out of range: its detail, and each decision on it. No `item_ver`: one names its own
    // item, so none fits the ID that names nothing, and a malformed one is refused before the item
    // is looked up (each must reach "out of range is no such item").
    for (const kind of ["conflict", "awaiting"] as const) {
      const id = byId[kind] as string;
      const decisions: Record<string, (x: string) => Promise<Outcome>> = {
        detail: (x) => call(homeOnly, "pending", { id: x }),
        keep_effective: (x) => call(homeOnly, "resolve", { id: x, decision: "keep_effective" }),
        take_candidate: (x) =>
          call(homeOnly, "resolve", { id: x, decision: "take_candidate", candidate: 0 }),
        confirm: (x) => call(homeOnly, "resolve", { id: x, decision: "confirm" }),
      };
      for (const [what, request] of Object.entries(decisions)) {
        const refused = await refusal(request(id), id);
        expect([kind, what, JSON.parse(refused).code]).toEqual([kind, what, "not_found"]);
        expect([kind, what, refused]).toEqual([
          kind,
          what,
          await refusal(request(other(id)), other(id)),
        ]);
      }
    }
    // Undoing a write out of range, its row named by its own table's name: as one that never was.
    const undo = (seq: number, id: string) =>
      homeWrite(homeOnly, [{ table: "away.trips_away", row: id, revert: { undo: seq } }]);
    const seq = Number(byId["seq"]);
    expect(await refusal(undo(seq, row), String(seq), row)).toEqual(
      await refusal(undo(seq + 1_000_000, other(row)), String(seq + 1_000_000), other(row)),
    );
  });

  it("limited to some slots: writes, undoes, confirms and takes a candidate in range; its results name nothing out of range", async () => {
    const { session } = get();
    const tea: Any = result(
      await homeWrite(homeOnly, [
        { intent: "insert", table: "home.trips_home", set: { name: "tea" } },
      ]),
    );
    expect(tea).toMatchObject({ status: "saved" });
    const row = tea.ops[0].target.row as string;
    const corrected: Any = result(
      await homeWrite(homeOnly, [
        {
          intent: "update",
          table: "home.trips_home",
          row,
          ver: tea.ops[0].ver,
          set: { name: "green tea" },
        },
      ]),
    );
    const undone: Any = result(
      await homeWrite(homeOnly, [
        { table: "home.trips_home", row, revert: { undo: corrected.seq } },
      ]),
    );
    expect(undone).toMatchObject({ status: "saved" });
    const revoked: Any = result(
      await homeWrite(homeOnly, [
        { intent: "revoke", table: "home.trips_home", row, ver: undone.ops[0].ver },
      ]),
    );
    expect(revoked).toMatchObject({ status: "saved", ops: [{ intent: "revoke" }] });

    // An item in range: by "home-only" decided, each way.
    const kept = await conflictIn("home", homeOnly);
    const taken = await conflictIn("home", homeOnly);
    const awaiting = await awaitingIn("home", homeOnly);
    const decide = async (id: string, decision: string, more: Record<string, unknown> = {}) => {
      const d = await detail(homeOnly, id);
      return result(
        await call(homeOnly, "resolve", { id, decision, item_ver: d.item_ver, ...more }),
      );
    };
    const results = [
      await decide(kept, "keep_effective"),
      await decide(taken, "take_candidate", { candidate: 0 }),
      await decide(awaiting, "confirm"),
    ];
    // Nothing out of range in what it was given: no notice of "away", whose items are open.
    for (const r of [tea, corrected, undone, revoked, ...results]) {
      expect(JSON.stringify(r)).not.toContain("away");
    }
    expect(JSON.stringify(await detail(session, byId["conflict"] as string))).toContain("away");
  });

  it("a schema draft's refusals say what the value may be (04-contract «schema_draft»)", async () => {
    const { session } = get();
    const table = LEDGER.tables[0] as (typeof LEDGER.tables)[0];
    const long = {
      ...LEDGER,
      slot: "bounds",
      tables: [{ ...table, description: "x".repeat(501) }],
    };
    expect(await call(session, "schema_draft", { document: long })).toEqual({
      error: expect.objectContaining({
        code: "validation_failed",
        details: [{ path: "tables/0/description", code: "out_of_bounds", max: "500" }],
      }),
    });
    const rule = { sql: "SELECT count(*) AS n FROM expenses", time_dependency: "daily" };
    const derived = { name: "counts", kind: "derived", description: "c", rule, fields: [] };
    const dependency = { ...LEDGER, slot: "rules", tables: [table, derived] };
    expect(await call(session, "schema_draft", { document: dependency })).toEqual({
      error: expect.objectContaining({
        code: "invalid_argument",
        reason: "malformed",
        param: "tables/1/rule/time_dependency",
        example: {
          sql: "SELECT sum(distance) AS total_distance, count(*) AS run_count FROM runs",
          time_dependency: "none",
        },
        allowed_values: ["none", "bucketed", "now"],
      }),
    });
  });

  it("sources: newest first with an excerpt; a search by part of the text; one with what it produced", async () => {
    const { session } = get();
    const driver = call;
    // Connections of its own: the suite's writer is revoked by now.
    const ownWriter = result(
      await driver(session, "connections.issue", { name: "sources-writer" }),
    )["token"] as string;
    const ownReader = result(
      await driver(session, "connections.issue", {
        name: "sources-reader",
        scopes: ["saveslot.read"],
      }),
    )["token"] as string;
    const said = `Lunch at the Caf${String.fromCodePoint(0xe9)}, 45 yuan`;
    const w = result(
      await driver(ownWriter, "write", {
        sv: 1,
        evidence: [{ kind: "user_message", text: said }],
        ops: [
          {
            intent: "insert",
            table: "ledger.expenses",
            set: { date: "2026-11-17", note: "lunch" },
          },
        ],
      }),
    );
    const row = (w["ops"] as { target: { row: string } }[])[0]?.target.row as string;
    const listed = result(await driver(ownReader, "sources", { slot: "ledger", limit: 2 }));
    const items = listed["sources"] as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "user_message", slot: "ledger", excerpt: said });
    const seqs = items.map((x) => x["id"]);
    expect(typeof listed["next_cursor"]).toBe("string");
    const next = result(
      await driver(ownReader, "sources", {
        slot: "ledger",
        limit: 2,
        cursor: listed["next_cursor"],
      }),
    );
    for (const x of next["sources"] as { id: string }[]) expect(seqs).not.toContain(x.id);

    // NFC on both sides, A–Z folded: "LUNCH at the cafe" + U+0301 finds "Lunch at the Café"; a
    // letter beyond ASCII is not folded, so "CAFÉ" does not.
    const found = result(
      await driver(ownReader, "sources", {
        mode: "search",
        q: `LUNCH at the cafe${String.fromCodePoint(0x301)}`,
      }),
    );
    expect((found["sources"] as { excerpt: string }[]).map((x) => x.excerpt)).toEqual([said]);
    expect(
      (
        result(await driver(ownReader, "sources", { mode: "search", q: "no such words" }))[
          "sources"
        ] as unknown[]
      ).length,
    ).toBe(0);
    const upper = result(
      await driver(ownReader, "sources", {
        mode: "search",
        q: `CAF${String.fromCodePoint(0xc9)}`,
      }),
    );
    expect(upper["sources"]).toEqual([]);
    expect(await driver(ownReader, "sources", { mode: "search", q: "" })).toEqual({
      error: expect.objectContaining({ code: "invalid_argument", param: "q" }),
    });

    const id = items[0]?.["id"] as string;
    const one = result(await driver(ownReader, "sources", { mode: "get", id }));
    expect(one).toMatchObject({
      mode: "get",
      id,
      kind: "user_message",
      slot: "ledger",
      text: said,
      produced: [
        {
          target: { table: "ledger.expenses", row },
          seq: w["seq"],
          fields: ["date", "note"],
          role: "value",
        },
      ],
    });
    // A write without evidence: the request itself, an api_call, its text the request as JCS.
    const plain = result(
      await driver(ownWriter, "write", {
        sv: 1,
        ops: [{ intent: "insert", table: "ledger.expenses", set: { date: "2026-11-18" } }],
      }),
    );
    const call0 = (
      result(await driver(ownReader, "sources", { slot: "ledger", limit: 1 }))["sources"] as Record<
        string,
        unknown
      >[]
    )[0] as Record<string, unknown>;
    expect(call0["kind"]).toBe("api_call");
    const got = result(
      await driver(session, "sources", { mode: "get", id: call0["id"] as string }),
    );
    expect(JSON.parse(got["text"] as string)).toMatchObject({ table: "ledger.expenses" });
    expect(got["produced"]).toEqual([
      expect.objectContaining({ seq: plain["seq"], role: "value" }),
    ]);
  });

  it("sources out of a credential's range: as if there were none, the same error either way", async () => {
    const { session } = get();
    const driver = call;
    result(await driver(session, "schema_draft", { document: DIARY }));
    result(
      await driver(session, "write", {
        sv: 1,
        evidence: [{ kind: "user_message", text: "a diary line" }],
        ops: [{ intent: "insert", table: "diary.entries", set: { date: "2026-11-17" } }],
      }),
    );
    const theirs = (
      result(await driver(session, "sources", { slot: "diary", limit: 1 }))["sources"] as {
        id: string;
      }[]
    )[0]?.id as string;
    const ledgerOnly = result(
      await driver(session, "connections.issue", { name: "ledger-only", slots: ["ledger"] }),
    )["token"] as string;
    const hidden = await driver(ledgerOnly, "sources", { mode: "get", id: theirs });
    const none = await driver(ledgerOnly, "sources", {
      mode: "get",
      id: `s_${"0".repeat(16)}`,
    });
    expect(hidden).toEqual({
      error: expect.objectContaining({ code: "not_found", reason: "source" }),
    });
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(none));
    expect(await driver(ledgerOnly, "sources", { slot: "diary" })).toEqual({
      error: expect.objectContaining({ code: "not_found", reason: "slot" }),
    });
    const all = result(await driver(ledgerOnly, "sources", { limit: 200 }));
    expect((all["sources"] as { slot: string }[]).every((x) => x.slot === "ledger")).toBe(true);
    const words = result(await driver(ledgerOnly, "sources", { mode: "search", q: "diary line" }));
    expect(words["sources"]).toEqual([]);
  });

  it("policy.get: any credential that reads the slot, within its range (04-contract «policy.get»)", async () => {
    const { session } = get();
    const driver = call;
    const ledger = result(await driver(session, "policy.get", { slot: "ledger" }));
    expect(ledger).toMatchObject({
      slot: "ledger",
      policy_version: 1,
      effective_value_rule: "keep_current",
      set_by: { kind: "user" },
    });
    expect(ledger["auto_apply"]).toEqual(expect.arrayContaining(["add_table", "description"]));
    expect(typeof ledger["seq"]).toBe("number");
    // A connection: its own slot as the user session sees it; another slot as one that is not.
    const only = result(
      await driver(session, "connections.issue", {
        name: "ledger-reader",
        scopes: ["saveslot.read"],
        slots: ["ledger"],
      }),
    );
    const token = only["token"] as string;
    expect(result(await driver(token, "policy.get", { slot: "ledger" }))).toEqual(ledger);
    const hidden = await driver(token, "policy.get", { slot: "spare" });
    expect(hidden).toEqual({
      error: expect.objectContaining({ code: "not_found", reason: "slot", param: "slot" }),
    });
    expect(await driver(token, "policy.get", { slot: "nope" })).toEqual(hidden);
    // Every connection holds saveslot.read (connections.issue refuses one without it).
  });

  it("no credential, or one that is no token: unauthenticated", async () => {
    const driver = call;
    expect(await driver("", "catalog", {})).toEqual({
      error: expect.objectContaining({ code: "unauthenticated", reason: "missing" }),
    });
    expect(await driver("not-a-token", "catalog", {})).toEqual({
      error: expect.objectContaining({ code: "unauthenticated", reason: "invalid" }),
    });
  });
}
