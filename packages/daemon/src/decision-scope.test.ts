// A decision's scope goes by the item's type (04-contract §6 «处理方式»; 02-architecture §5: the
// service decides by scope, the kernel knows only the visible range): conflict items take
// `saveslot.write`, schema changes `saveslot.schema`. `resolve` lets any of the decision scopes in,
// then checks the one the item needs; an item the caller does not see is refused as not there,
// never by its scope. An item's detail lists only the decisions the credential may take, and so
// does the `current` of `confirmation_mismatch`. Against a real tenant, as a surface calls.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authenticate,
  ContractError,
  Credentials,
  CursorKeys,
  closeLocalTenant,
  initLocalHome,
  kernelCall,
  type LocalTenant,
  type Operation,
  openLocalTenant,
  type Principal,
  runOperation,
  sessionFile,
} from "@fluxvita/saveslot-service";
import { osFileLock } from "@fluxvita/saveslot-store-pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";

const T = 60_000;
const root = mkdtempSync(join(tmpdir(), "saveslot-decision-scope-"));
const home = join(root, "home");
const NOW = "2026-11-16T12:00:00.000Z";
const NO_ITEM = `pi_${"7".repeat(16)}`;
let t: LocalTenant;
let credentials: Credentials;
let cursors: CursorKeys;
let user: Principal;
// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type Any = any;

async function principal(token: string): Promise<Principal> {
  const p = await authenticate({ credentials, tenant: t, authorization: `Bearer ${token}` });
  if (!("kind" in p)) throw new Error(p.reason);
  return p;
}

/** Calls `operation` as `who`; the result, or the refusal as `{refused, ...detail}`. */
async function call(
  who: Principal,
  operation: Operation,
  body: unknown,
  task?: string,
): Promise<Any> {
  try {
    const c = kernelCall({
      principal: who,
      tenant: t,
      operation,
      body,
      ...(task !== undefined ? { task } : {}),
      now: NOW,
      windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
      cursors,
    });
    return await runOperation({
      tenant: t,
      credentials,
      cursors,
      operation,
      call: c,
      warn: () => {},
    });
  } catch (e) {
    if (e instanceof ContractError) return { refused: e.code, ...e.detail };
    throw e;
  }
}

/** A connection with `scopes`, over `slots` when given. */
async function connection(name: string, scopes: string[], slots?: string[]) {
  const issued = await call(user, "connections.issue", {
    name,
    scopes,
    ...(slots !== undefined ? { slots } : {}),
  });
  return principal(issued.token as string);
}

const table = (name: string) => ({
  name,
  kind: "base",
  description: `one row per ${name}`,
  time: { type: "none" },
  fields: [{ name: "note", type: "text", description: "what" }],
});

let conflictItem: string;
let schemaItem: { id: string; item_ver: string };
let readOnly: Principal;
let schemaOnly: Principal;
let writeOnly: Principal;
let elsewhere: Principal;

beforeAll(async () => {
  await initLocalHome({ home, backend: testBackend(), lock: osFileLock, now: NOW });
  const r = await openLocalTenant({ home, backend: testBackend() });
  if (!r.ok) throw new Error(r.failure);
  t = r.tenant;
  credentials = await Credentials.load(home);
  cursors = await CursorKeys.open(home);
  user = await principal(readFileSync(sessionFile(home), "utf8").trim());
  for (const slot of ["ledger", "garden"]) {
    await call(user, "schema_draft", {
      document: {
        slot,
        base_version: null,
        timezone: "Asia/Shanghai",
        tables: [table(`${slot}_notes`)],
      },
    });
  }
  // A conflict: two writes on the version both read.
  const made = await call(user, "write", {
    sv: 1,
    ops: [{ intent: "insert", table: "ledger_notes", set: { note: "a" } }],
  });
  const row = made.ops[0].target.row;
  const ver = made.ops[0].ver;
  await call(user, "write", {
    sv: 1,
    ops: [{ intent: "update", table: "ledger_notes", row, ver, set: { note: "b" } }],
  });
  const stale = await call(
    user,
    "write",
    { sv: 1, ops: [{ intent: "update", table: "ledger_notes", row, ver, set: { note: "c" } }] },
    "other",
  );
  conflictItem = stale.pending[0].id;
  // A schema change waiting: the note field renamed.
  const d = await call(user, "schema_draft", {
    document: {
      slot: "ledger",
      base_version: 1,
      timezone: "Asia/Shanghai",
      tables: [
        {
          ...table("ledger_notes"),
          id: "t1",
          fields: [{ ...table("x").fields[0], id: "f1", name: "memo" }],
        },
      ],
    },
  });
  schemaItem = d.item;
  readOnly = await connection("reader", ["saveslot.read"]);
  schemaOnly = await connection("schemer", ["saveslot.read", "saveslot.schema"]);
  writeOnly = await connection("writer", ["saveslot.read", "saveslot.write"]);
  elsewhere = await connection(
    "gardener",
    ["saveslot.read", "saveslot.schema", "saveslot.write"],
    ["garden"],
  );
}, T);
afterAll(async () => {
  await closeLocalTenant(t);
  rmSync(root, { recursive: true, force: true });
}, T);

describe("an item's detail lists the decisions the credential may take", () => {
  it("read only: none, on either type", async () => {
    expect((await call(readOnly, "pending", { id: conflictItem })).decisions).toEqual([]);
    expect((await call(readOnly, "pending", { id: schemaItem.id })).decisions).toEqual([]);
  });

  it("saveslot.schema: the schema change's, not the conflict's", async () => {
    expect((await call(schemaOnly, "pending", { id: conflictItem })).decisions).toEqual([]);
    expect((await call(schemaOnly, "pending", { id: schemaItem.id })).decisions).toEqual([
      "confirm",
      "reject",
    ]);
  });

  it("saveslot.write: the conflict's, not the schema change's", async () => {
    expect((await call(writeOnly, "pending", { id: conflictItem })).decisions).toEqual([
      "keep_effective",
      "take_candidate",
      "take_previous",
    ]);
    expect((await call(writeOnly, "pending", { id: schemaItem.id })).decisions).toEqual([]);
  });
});

describe("resolve checks the scope the item's type needs", () => {
  it("none of the decision scopes: refused at the door", async () => {
    expect(await call(readOnly, "resolve", { id: schemaItem.id, decision: "reject" })).toEqual({
      refused: "insufficient_scope",
      required_scope: "saveslot.write",
    });
  });

  it("saveslot.schema cannot take a conflict's decision; saveslot.write cannot decide a schema change", async () => {
    expect(
      await call(schemaOnly, "resolve", { id: conflictItem, decision: "keep_effective" }),
    ).toEqual({ refused: "insufficient_scope", required_scope: "saveslot.write" });
    expect(await call(writeOnly, "resolve", { id: schemaItem.id, decision: "reject" })).toEqual({
      refused: "insufficient_scope",
      required_scope: "saveslot.schema",
    });
  });

  it("an item the caller does not see: as an item not there, never by its scope", async () => {
    const seen = await call(elsewhere, "resolve", { id: schemaItem.id, decision: "reject" });
    expect(seen).toEqual(await call(elsewhere, "resolve", { id: NO_ITEM, decision: "reject" }));
    expect(seen).toMatchObject({ refused: "not_found", reason: "item" });
    // Without saveslot.schema either: still not found, not insufficient_scope.
    const writerElsewhere = await connection(
      "writer-garden",
      ["saveslot.read", "saveslot.write"],
      ["garden"],
    );
    expect(
      await call(writerElsewhere, "resolve", { id: schemaItem.id, decision: "reject" }),
    ).toEqual(await call(writerElsewhere, "resolve", { id: NO_ITEM, decision: "reject" }));
  });

  it("a version not the item's: the current detail with the decisions this credential may take", async () => {
    const stale = `${schemaItem.item_ver.split(".")[0]}.1.0`;
    const e = await call(schemaOnly, "resolve", {
      id: schemaItem.id,
      decision: "confirm",
      item_ver: stale,
    });
    expect(e).toMatchObject({
      refused: "confirmation_mismatch",
      current: { id: schemaItem.id, type: "schema_change", decisions: ["confirm", "reject"] },
    });
  });

  it("with the scope: decided (the last: it closes the item)", async () => {
    expect(
      await call(schemaOnly, "resolve", {
        id: schemaItem.id,
        decision: "reject",
        item_ver: schemaItem.item_ver,
      }),
    ).toMatchObject({ type: "schema_change", decision: "reject", schema: { switched: false } });
  });
});
