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
