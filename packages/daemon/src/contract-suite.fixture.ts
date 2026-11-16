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
